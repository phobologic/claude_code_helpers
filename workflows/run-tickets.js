export const meta = {
  name: 'run-tickets',
  description: 'Implement a tk ticket DAG in parallel worktrees with AC verification, quality review, and serialized merges',
  whenToUse: 'Launched by the /run-tickets skill after it has planned the ticket graph and created worktrees. Not meant to be run directly.',
  phases: [
    { title: 'Implement', detail: 'one implementer per ticket, in a pooled worktree slot' },
    { title: 'Verify', detail: 'AC verifier, only for tickets with acceptance criteria' },
    { title: 'Review', detail: 'adversarial quality review of the ticket diff' },
    { title: 'Merge', detail: 'one merge at a time into the integration branch' },
    { title: 'Integration check', detail: 'full lint and test run on the integration branch' },
  ],
}

// args (built by the /run-tickets skill):
//   repoRoot             absolute path of the main checkout (agents must not touch it)
//   integrationBranch    e.g. epic/<id> or run/<stamp>
//   integrationWorktree  worktree with integrationBranch checked out; merges happen here
//   slots                absolute worktree paths, one per concurrent implementer
//   findingsParent       epic for findings that block this work: regressions, and serious pre-existing bugs
//   backlogParent        optional: the repo's standing backlog epic (`tk backlog ensure`) for other
//                        pre-existing findings; without it, everything goes to findingsParent
//   baseBranch           optional, default "main": commit or branch the integration check compares failures
//                        against; the skill passes the integration branch's starting commit
//   tickets              [{id, title, deps, has_ac}] in topological order
//   caps                 optional {acFails, qrReworks, conflicts}

const A = args
const CAPS = Object.assign({ acFails: 3, qrReworks: 3, conflicts: 2 }, A.caps || {})

// ---------- schemas ----------

const IMPL_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['done', 'failed'] },
    head_sha: { type: 'string' },
    summary: { type: 'string', description: 'files changed, approach, anything the reviewer should know' },
    tests: { type: 'string', description: 'lint and test commands run and their result' },
    out_of_scope: {
      type: 'array',
      description: 'rework findings pushed back as out of scope, each already filed as a tk ticket',
      items: {
        type: 'object',
        properties: { finding: { type: 'integer' }, reason: { type: 'string' }, ticket_id: { type: 'string' } },
        required: ['finding', 'reason', 'ticket_id'],
      },
    },
    failure_reason: { type: 'string' },
    conditions: {
      type: 'array',
      description: 'each condition this round added or changed in src, broken once to see whether a test catches it',
      items: {
        type: 'object',
        properties: {
          condition: { type: 'string' },
          location: { type: 'string', description: 'path:line' },
          break: { type: 'string', description: 'the mutation tried: guard deleted, condition inverted, boundary shifted' },
          caught: { type: 'boolean' },
          test: { type: 'string', description: 'the test that failed, or why none can' },
        },
        required: ['condition', 'location', 'break', 'caught', 'test'],
      },
    },
  },
  required: ['status', 'summary', 'conditions'],
}

const AC_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'FAIL', 'ERROR'] },
    failures: { type: 'array', items: { type: 'string' }, description: 'one entry per unmet criterion, with what is missing' },
    error: { type: 'string', description: 'with ERROR: what in the environment prevented verification' },
    criteria: {
      type: 'array',
      description: 'one entry per acceptance criterion, with quoted evidence',
      items: {
        type: 'object',
        properties: {
          criterion: { type: 'string' },
          met: { type: 'boolean' },
          code: { type: 'string', description: 'file:line implementing it' },
          assertion: { type: 'string', description: 'file:line and the quoted assertion testing it, or why none qualifies' },
        },
        required: ['criterion', 'met', 'code', 'assertion'],
      },
    },
  },
  required: ['verdict', 'failures', 'criteria'],
}

const QR_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['CLEAN', 'REWORK', 'FINDINGS', 'ERROR'] },
    error: { type: 'string', description: 'with ERROR: what in the environment prevented the review' },
    findings: {
      type: 'array',
      description: 'Bucket A (inline-fixable) findings; empty unless verdict is REWORK',
      items: {
        type: 'object',
        properties: {
          priority: { type: 'string', enum: ['critical', 'high', 'medium'] },
          location: { type: 'string', description: 'path:line' },
          description: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['priority', 'location', 'description', 'fix'],
      },
    },
    filed: {
      type: 'array',
      description: 'Bucket B tickets created or noted this round',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          action: { type: 'string', enum: ['created', 'noted'], description: 'noted = an existing ticket got a note instead of a duplicate' },
          origin: { type: 'string', enum: ['regression', 'worsened', 'preexisting'] },
          parent: { type: 'string', enum: ['findings', 'backlog'] },
        },
        required: ['id', 'action', 'origin', 'parent'],
      },
    },
    implementer_flags: {
      type: 'array',
      description: 'every risk, caveat, or open question the implementer raised, and how it was resolved',
      items: {
        type: 'object',
        properties: {
          flag: { type: 'string' },
          disposition: { type: 'string', enum: ['finding', 'refuted'] },
          evidence: { type: 'string' },
        },
        required: ['flag', 'disposition', 'evidence'],
      },
    },
    test_audit: {
      type: 'array',
      description: 'tests backing the criteria or new behavior, and whether each can actually fail',
      items: {
        type: 'object',
        properties: {
          test: { type: 'string', description: 'file:line or test name' },
          assertion: { type: 'string' },
          can_fail: { type: 'boolean' },
        },
        required: ['test', 'assertion', 'can_fail'],
      },
    },
    risks_checked: {
      type: 'array',
      minItems: 2,
      description: 'the riskiest paths or inputs attacked, how, and the result',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          how: { type: 'string' },
          result: { type: 'string' },
        },
        required: ['path', 'how', 'result'],
      },
    },
  },
  required: ['verdict', 'findings', 'filed', 'implementer_flags', 'test_audit', 'risks_checked'],
}

const MERGE_SCHEMA = {
  type: 'object',
  properties: {
    result: { type: 'string', enum: ['merged', 'conflict', 'error'] },
    sha: { type: 'string' },
    conflicted_files: { type: 'array', items: { type: 'string' } },
    detail: { type: 'string' },
  },
  required: ['result', 'detail'],
}

const CHECK_SCHEMA = {
  type: 'object',
  properties: {
    status: {
      type: 'string',
      enum: ['pass', 'fail', 'preexisting_only', 'no_checks'],
      description: 'fail = at least one failure the base commit does not have; preexisting_only = every failure also happens at the base commit',
    },
    commands: { type: 'array', items: { type: 'string' } },
    new_failures: { type: 'array', items: { type: 'string' }, description: 'failures introduced by this run' },
    preexisting_failures: { type: 'array', items: { type: 'string' }, description: 'failures that also happen at the base commit' },
    summary: { type: 'string', description: 'one short paragraph' },
  },
  required: ['status', 'commands', 'new_failures', 'preexisting_failures', 'summary'],
}

// ---------- prompt pieces ----------

function header(worktree) {
  return `WORKTREE: ${worktree}

Your first Bash call must be:
  cd ${worktree} && pwd && [ -f .git ] && echo 'WORKTREE OK'
If it does not print WORKTREE OK, stop immediately and report the output as a failure.

The shell's working directory is not guaranteed to persist between Bash calls, so start EVERY Bash
command with \`cd ${worktree} && \`. Stay inside ${worktree}: absolute paths under it for Read/Edit/Write,
\`rg\`/\`grep\`/\`find\` in Bash for searching (there are no Grep or Glob tools), plain \`git\` (no -C) for git. Never cd or -C into ${A.repoRoot} itself or any other worktree.
Never run git stash, git stash pop/apply, or git checkout -m.
One exception: run \`tk create\` as \`(cd ${A.repoRoot} && tk create ...)\`. tk derives the ticket ID prefix from the
current directory name, and from inside a worktree it would produce a meaningless prefix. Nothing else runs there.
`
}

const branchOf = t => `ticket/${t.id}`

function implementPrompt(t, slot, work) {
  const setup = work.kind === 'new'
    ? `Prepare the worktree for this ticket (after the WORKTREE OK check):
  worktree-reset ${slot} ${A.integrationBranch}
  git show-ref --verify --quiet refs/heads/${branchOf(t)} && git checkout ${branchOf(t)} || git checkout -b ${branchOf(t)} ${A.integrationBranch}
The first form resumes a branch left by an earlier interrupted run; keep any commits on it.`
    : `Your worktree is already on ${branchOf(t)} with your earlier commits. Run \`git checkout ${branchOf(t)}\` to be sure, then continue there.`

  let task
  if (work.kind === 'new') {
    task = `Implement ticket ${t.id}: ${t.title}
Run \`tk show ${t.id}\` for the full ticket. The base branch for \`git rev-list\` in your pre-DONE checklist is ${A.integrationBranch}.`
  } else if (work.kind === 'ac_fail') {
    task = `Rework round ${work.round} for ${t.id}: AC verification failed.
Unmet criteria:
${work.failures.map((f, i) => `  ${i + 1}. ${f}`).join('\n')}
The verifier's full note is on the ticket (\`tk show ${t.id}\`). Fix these, keep every other criterion passing, and commit.`
  } else if (work.kind === 'qr_rework') {
    task = `Rework round ${work.round} for ${t.id}: quality review returned REWORK. Fix these in ${branchOf(t)}:
${work.findings.map((f, i) => `  ${i + 1}. [${f.priority.toUpperCase()}] ${f.location}: ${f.description} Suggested fix: ${f.fix}`).join('\n')}

If a finding is genuinely out of scope (it would require touching files this ticket never named), do not fix it.
First check it is not already filed: \`(cd ${A.repoRoot} && tk backlog find <path> <symbol>)\`. If an open ticket covers it,
add a note there (\`tk add-note <id> "..."\`) and use that id. Otherwise file it:
\`tk create "<title>" -p <0-2 by priority> --parent ${A.findingsParent} --tags code-review,quality -d "<file:line, description, suggested fix, source ticket ${t.id}>"\`
Either way, list it in out_of_scope with the finding number and ticket id. Fix every finding you do not push back on.`
  } else {
    task = `Merge conflict: ${branchOf(t)} no longer merges cleanly into ${A.integrationBranch}${work.files.length ? ` (conflicts in: ${work.files.join(', ')})` : ''}.
Bring the integration branch into your ticket branch and resolve:
  git merge ${A.integrationBranch}
Resolve every conflict preserving both this ticket's intent and what landed on ${A.integrationBranch}, then run lint and the full test suite, and commit the merge.`
  }

  return `${header(slot)}
${setup}

${task}

Follow your agent instructions for everything else (probes before editing, tests, lint, commit with -F, rework notes on the ticket).
When finished, return status "done" with the HEAD sha, or status "failed" with failure_reason if you could not get to a committed, green state.`
}

function acPrompt(t, slot) {
  return `${header(slot)}
Verify ticket ${t.id} (${t.title}) against its acceptance criteria.
The implementation is on branch ${branchOf(t)}. Diff it against the integration branch, not main:
  git diff ${A.integrationBranch}...${branchOf(t)}
Read-only: do not edit files or commit. Record the result as a note on the ticket per your instructions, then return the verdict.`
}

function conditionLines(conditions) {
  if (!conditions || !conditions.length) return '(none reported)'
  return conditions.map(c => `  - ${c.location} ${c.condition}: broke it by ${c.break}; ${c.caught ? `caught by ${c.test}` : `NOT caught: ${c.test}`}`).join('\n')
}

function qrPrompt(t, slot, round, implSummary, conditions) {
  return `${header(slot)}
Review ticket ${t.id} (${t.title}) on branch ${branchOf(t)} (round ${round}).
Diff the ticket's own changes only:
  git diff ${A.integrationBranch}...${branchOf(t)}
Repo root (run tk create and tk backlog from here): ${A.repoRoot}
Findings parent: ${A.findingsParent}
Backlog parent: ${A.backlogParent || A.findingsParent}
Route each Bucket B finding by origin and priority as your instructions say, and search before filing.

The implementer's summary of this round, verbatim. Resolve every risk, caveat, or open question in it
(step 2 of your instructions):
---
${implSummary || '(no summary)'}
---

Conditions the implementer says it broke one at a time, and what caught each (step 3 of your instructions:
re-check at least one of these, and test every condition in the diff that is missing from this list):
${conditionLines(conditions)}

Read-only apart from tk: do not edit files or commit. Mutate code only in a \`review-scratch ${slot}\` copy;
commands for it may \`cd\` to the path it prints (use the literal path: shell variables do not persist between calls). Write the round
verdict note on the ticket, then return the verdict with every field your instructions require.`
}

function mergePrompt(t) {
  return `${header(A.integrationWorktree)}
You are the merge step for ticket ${t.id}. Run exactly these steps and nothing else. Do not edit any file.

1. \`git status --porcelain --untracked-files=no\` must print nothing (untracked files cannot affect a merge and are ignored).
   If it prints anything, return result "error" with the output and stop.
2. \`git checkout ${A.integrationBranch}\` (it should already be checked out here).
3. \`git merge --no-ff ${branchOf(t)} -m "Merge ${t.id}: ${t.title.replace(/"/g, "'")}"\`
4. If the merge reports conflicts: run \`git diff --name-only --diff-filter=U\` to list them, then \`git merge --abort\`,
   confirm \`git status --porcelain --untracked-files=no\` is empty, and return result "conflict" with the conflicted files.
5. If the merge succeeded: capture \`git rev-parse --short HEAD\`, then run
     tk add-note ${t.id} "Merged into ${A.integrationBranch} by /run-tickets at <sha>."
     tk close ${t.id}
   and return result "merged" with the sha.
Any other failure: return result "error" with the command output.`
}

function checkPrompt() {
  const base = A.baseBranch || 'main'
  return `${header(A.integrationWorktree)}
Run the project's full lint, type check, and test suite on ${A.integrationBranch} (checked out here). Find the
commands from CLAUDE.md, the Makefile/justfile, package.json, pyproject.toml, or CI config. Do not edit files or commit.

If anything fails, find out whether the base commit (${base}, where ${A.integrationBranch} stood before this run)
has the same failure, so the report separates what this run
broke from what was already broken:
  git checkout --detach ${base}
  <re-run only the failing commands>
  git checkout ${A.integrationBranch}
Always end with ${A.integrationBranch} checked out again and \`git status --porcelain --untracked-files=no\` empty.

Return status "pass", "fail" (at least one new failure), "preexisting_only" (every failure also happens on
${base}), or "no_checks", with each failure listed as new or pre-existing.`
}

// ---------- concurrency helpers ----------

const freeSlots = [...A.slots]
const slotWaiters = []
function acquireSlot() {
  if (freeSlots.length) return Promise.resolve(freeSlots.shift())
  return new Promise(resolve => slotWaiters.push(resolve))
}
function releaseSlot(slot) {
  const next = slotWaiters.shift()
  if (next) next(slot)
  else freeSlots.push(slot)
}

// One merge at a time: each merge chains onto the previous one.
let mergeTail = Promise.resolve()
function withMergeLock(fn) {
  const run = mergeTail.then(fn)
  mergeTail = run.catch(() => {})
  return run
}

// ---------- per-ticket pipeline ----------

async function runTicket(t, slot) {
  const rec = { id: t.id, title: t.title, outcome: null, reason: '', sha: '', acFails: 0, qrRounds: 0, qrReworks: 0,
    conflicts: 0, findings: [], backlog: [], noted: [], outOfScope: [], summary: '' }
  const block = reason => { rec.outcome = 'blocked'; rec.reason = reason; log(`${t.id}: BLOCKED (${reason})`); return rec }

  let work = { kind: 'new' }
  let implRound = 0
  while (true) {
    implRound += 1
    const impl = await agent(implementPrompt(t, slot, { ...work, round: implRound }), {
      label: `impl ${t.id}${implRound > 1 ? ` r${implRound}` : ''}`, phase: 'Implement', agentType: 'ticket-implementer', schema: IMPL_SCHEMA,
    })
    if (!impl) return block('implementer died or was stopped')
    if (impl.status !== 'done') return block(`implementer failed: ${impl.failure_reason || impl.summary}`)
    rec.summary = impl.summary
    rec.outOfScope.push(...(impl.out_of_scope || []).map(o => o.ticket_id))
    log(`${t.id}: implemented (round ${implRound})`)

    if (t.has_ac) {
      const ac = await agent(acPrompt(t, slot), { label: `ac ${t.id}`, phase: 'Verify', agentType: 'ticket-verifier', schema: AC_SCHEMA })
      if (!ac) return block('AC verifier died or was stopped')
      if (ac.verdict === 'ERROR') return block(`AC verifier could not run: ${ac.error || ac.failures.join('; ')}`)
      if (ac.verdict === 'FAIL') {
        rec.acFails += 1
        log(`${t.id}: AC FAIL (${rec.acFails}/${CAPS.acFails})`)
        if (rec.acFails >= CAPS.acFails) return block(`failed AC verification ${rec.acFails} times: ${ac.failures.join('; ')}`)
        work = { kind: 'ac_fail', failures: ac.failures }
        continue
      }
      log(`${t.id}: AC PASS`)
    }

    rec.qrRounds += 1
    const qr = await agent(qrPrompt(t, slot, rec.qrRounds, impl.summary, impl.conditions), {
      label: `review ${t.id}${rec.qrRounds > 1 ? ` r${rec.qrRounds}` : ''}`, phase: 'Review', agentType: 'ticket-reviewer', schema: QR_SCHEMA,
    })
    if (!qr) return block('quality reviewer died or was stopped')
    if (qr.verdict === 'ERROR') return block(`reviewer could not run: ${qr.error || 'no detail'}`)
    for (const f of qr.filed || []) {
      if (f.action === 'noted') rec.noted.push(f.id)
      else if (f.parent === 'backlog' && A.backlogParent) rec.backlog.push(f.id)
      else rec.findings.push(f.id)
    }
    if (qr.verdict === 'REWORK' && qr.findings.length) {
      rec.qrReworks += 1
      log(`${t.id}: REWORK, ${qr.findings.length} finding(s) (${rec.qrReworks}/${CAPS.qrReworks})`)
      if (rec.qrReworks >= CAPS.qrReworks) {
        return block(`quality review asked for rework ${rec.qrReworks} times; last: ${qr.findings.map(f => `${f.location} ${f.description}`).join('; ')}`)
      }
      work = { kind: 'qr_rework', findings: qr.findings }
      continue
    }
    const filed = (qr.filed || []).map(f => `${f.id} (${f.action === 'noted' ? 'noted' : f.parent})`)
    log(`${t.id}: review ${qr.verdict}${filed.length ? `, filed ${filed.join(', ')}` : ''}`)

    const merge = await withMergeLock(() => mergeHalted ? null : agent(mergePrompt(t), {
      label: `merge ${t.id}`, phase: 'Merge', schema: MERGE_SCHEMA, model: 'haiku', effort: 'low',
    }))
    if (mergeHalted && !merge) return block(`not merged: run halted after merge error: ${mergeHalted}`)
    if (!merge) return block('merge agent died or was stopped')
    if (merge.result === 'merged') {
      rec.outcome = 'merged'
      rec.sha = merge.sha || ''
      log(`${t.id}: merged into ${A.integrationBranch} ${rec.sha}`)
      return rec
    }
    if (merge.result === 'error') {
      mergeHalted = merge.detail
      return block(`merge step errored: ${merge.detail}`)
    }
    rec.conflicts += 1
    log(`${t.id}: merge conflict (${rec.conflicts}/${CAPS.conflicts}) in ${(merge.conflicted_files || []).join(', ')}`)
    if (rec.conflicts >= CAPS.conflicts) return block(`merge conflicts ${rec.conflicts} times: ${(merge.conflicted_files || []).join(', ')}`)
    work = { kind: 'conflict', files: merge.conflicted_files || [] }
  }
}

// A merge "error" means the integration worktree is in an unknown state, so no
// ticket that has not merged yet should try. Tickets already mid-flight finish
// their current agent and then stop at the merge step.
let mergeHalted = null

phase('Implement')
const outcomes = {}
for (const t of A.tickets) {
  outcomes[t.id] = (async () => {
    const depResults = await Promise.all(t.deps.map(d => outcomes[d]))
    const failedDeps = depResults.filter(r => r.outcome !== 'merged').map(r => r.id)
    if (failedDeps.length) {
      log(`${t.id}: stalled, waits on ${failedDeps.join(', ')}`)
      return { id: t.id, title: t.title, outcome: 'stalled', reason: `depends on unmerged ${failedDeps.join(', ')}` }
    }
    if (mergeHalted) return { id: t.id, title: t.title, outcome: 'stalled', reason: `run halted after merge error: ${mergeHalted}` }
    const slot = await acquireSlot()
    try {
      return await runTicket(t, slot)
    } finally {
      releaseSlot(slot)
    }
  })()
}

const results = await Promise.all(A.tickets.map(t => outcomes[t.id]))

let integration = null
if (results.some(r => r.outcome === 'merged') && !mergeHalted) {
  phase('Integration check')
  integration = await agent(checkPrompt(), { label: 'integration check', phase: 'Integration check', schema: CHECK_SCHEMA, model: 'sonnet', effort: 'medium' })
  if (integration) log(`integration check: ${integration.status}`)
}

return {
  integrationBranch: A.integrationBranch,
  mergeHalted,
  integration,
  tickets: results,
}
