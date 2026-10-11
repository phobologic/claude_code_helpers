export const meta = {
  // Not 'run-tickets': saved workflows are listed alongside skills, and that name is the skill's.
  name: 'run-tickets-engine',
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
//   gates                optional: commands that must pass on every merged result before the merge commits
//                        (lint, type check, tests), already known to pass on the integration branch
//   tickets              [{id, title, deps, has_ac, files, decision?, reviewed?}] in topological order. files
//                        are the ticket's **Files** paths (they break ties when choosing what starts next); decision
//                        is the owner's answer to the ticket's open question, when it had one; reviewed is
//                        {sha, human_checks} when an earlier run's review passed the branch at exactly its
//                        current tip (run-tickets-plan checks), and the ticket goes straight to merge
//   caps                 optional {acFails, qrReworks, conflicts, gateFails}

const A = args
// Tickets that share files run together, so a ticket can conflict once or twice on a
// moving integration branch through no fault of its own; the conflict cap allows for that.
const CAPS = Object.assign({ acFails: 3, qrReworks: 3, conflicts: 3, gateFails: 2 }, A.caps || {})
const GATES = A.gates || []

// Dispatch below relies on these: a dependency missing from the run or listed after
// its dependent, or no slots, would leave tickets waiting forever, and a malformed
// files list would throw inside the scheduler.
if (!A.slots || !A.slots.length) throw new Error('no worktree slots given')
A.tickets.forEach((t, i) => {
  const late = t.deps.filter(d => !A.tickets.slice(0, i).some(o => o.id === d))
  if (late.length) throw new Error(`${t.id} depends on ${late.join(', ')}, which is not earlier in the run's ticket list`)
  if (t.files !== undefined && !(Array.isArray(t.files) && t.files.every(f => typeof f === 'string'))) {
    throw new Error(`${t.id}: files must be an array of paths, got ${JSON.stringify(t.files)}`)
  }
})

// ---------- effort ----------
// Effort follows objective signals, never a guess at how hard a ticket looks.
// A ticket that many others wait on (transitively, as run-tickets-plan counts
// them) stalls the most work if it blocks, so it gets the most thinking. Review
// effort follows the size of the whole ticket diff, so a small fix to a big
// ticket is still reviewed at full effort.
const HIGH_FANOUT = 3        // transitive dependents at or above which a ticket is high-fanout
const SMALL_DIFF = 50        // src lines changed below which review drops to high

const ancestors = {}
for (const t of A.tickets) {
  ancestors[t.id] = new Set(t.deps.flatMap(d => [d, ...(ancestors[d] || [])]))
}
const dependents = {}
for (const t of A.tickets) dependents[t.id] = A.tickets.filter(o => ancestors[o.id].has(t.id)).length
const highFanout = t => dependents[t.id] >= HIGH_FANOUT
const fanned = A.tickets.filter(highFanout)
if (fanned.length) log(`high-fanout (max effort): ${fanned.map(t => `${t.id} (${dependents[t.id]} dependents)`).join(', ')}`)

// First round is where the design judgment happens; rework and conflict rounds
// follow a precise finding, so they keep the agent file's default (high).
function implEffort(t, work) {
  if (work.kind !== 'new') return {}
  return { effort: highFanout(t) ? 'max' : 'xhigh' }
}

// The reviewer's agent file defaults to xhigh; only small, low-fanout diffs drop.
// A resolution review covers only a conflict or gate fix, so it always runs at high.
function reviewEffort(t, impl, resolution) {
  if (resolution) return { effort: 'high' }
  const small = Number.isInteger(impl.src_lines_changed) && impl.src_lines_changed < SMALL_DIFF
  return small && !highFanout(t) ? { effort: 'high' } : {}
}

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
    src_lines_changed: {
      type: 'integer',
      description: 'lines added plus deleted against the integration branch, excluding test and doc files; sizes the review',
    },
    verification: {
      type: 'string',
      description: 'checks outside the test suite: harness or app commands the verifier can re-run and what each showed, and what a person still needs to check by hand',
    },
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
  required: ['status', 'summary', 'src_lines_changed', 'conditions'],
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
          human_check: {
            type: 'string',
            description: 'only when a person must confirm it (the project verifies this layer by running the product, or the evidence shows the criterion itself is wrong): what they should check',
          },
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
    reviewed_sha: { type: 'string', description: 'short sha of the ticket branch tip you reviewed' },
    prior_findings: {
      type: 'array',
      description: 'each finding from the previous review round listed in your prompt, and whether the fix holds; empty when none were listed',
      items: {
        type: 'object',
        properties: {
          finding: { type: 'integer' },
          fixed: { type: 'boolean' },
          evidence: { type: 'string' },
        },
        required: ['finding', 'fixed', 'evidence'],
      },
    },
    findings: {
      type: 'array',
      description: 'Bucket A (inline-fixable) findings; empty unless verdict is REWORK',
      items: {
        type: 'object',
        properties: {
          // low only for regressions in the ticket's own files (see Bucket A in the reviewer's instructions)
          priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
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
  required: ['verdict', 'reviewed_sha', 'prior_findings', 'findings', 'filed', 'implementer_flags', 'test_audit', 'risks_checked'],
}

const MERGE_SCHEMA = {
  type: 'object',
  properties: {
    result: { type: 'string', enum: ['merged', 'conflict', 'gate_fail', 'error'] },
    sha: { type: 'string' },
    conflicted_files: { type: 'array', items: { type: 'string' } },
    failed_gate: { type: 'string', description: 'with gate_fail: the command that failed' },
    tree_clean: {
      type: 'boolean',
      description: 'with error: true only when, after the failure, `git status --porcelain --untracked-files=no` and `git rev-parse -q --verify MERGE_HEAD` both printed nothing',
    },
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
  // The ticket's first implementer prepares the slot. That is usually the 'new' round, but a ticket
  // that went straight to merge meets its first implementer at a conflict or a failed gate.
  const setup = work.round === 1
    ? `Prepare the worktree for this ticket (after the WORKTREE OK check):
  worktree-reset ${slot} ${A.integrationBranch}
  git show-ref --verify --quiet refs/heads/${branchOf(t)} && git checkout ${branchOf(t)} || git checkout -b ${branchOf(t)} ${A.integrationBranch}
The first form resumes a branch left by an earlier run; keep any commits on it.`
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
  } else if (work.kind === 'gate_fail') {
    task = `Merge gate failure: ${branchOf(t)} merges cleanly into ${A.integrationBranch}, but the merged result fails \`${work.gate}\`:
${work.detail}

Bring the integration branch into your ticket branch and reproduce the failure:
  git merge ${A.integrationBranch}
Fix it in keeping with this ticket's intent and what already landed on ${A.integrationBranch}, run lint and the full test
suite, and commit. If it does not reproduce on the merged branch in two clean runs of that command, say so in summary
and return done: the next merge attempt runs the gate again.`
  } else {
    task = `Merge conflict: ${branchOf(t)} no longer merges cleanly into ${A.integrationBranch}${work.files.length ? ` (conflicts in: ${work.files.join(', ')})` : ''}.
Bring the integration branch into your ticket branch and resolve:
  git merge ${A.integrationBranch}
Resolve every conflict preserving both this ticket's intent and what landed on ${A.integrationBranch}, then run lint and the full test suite, and commit the merge.`
  }

  return `${header(slot)}
${setup}

${task}${decisionNote(t)}

Follow your agent instructions for everything else (probes before editing, tests, lint, commit with -F, rework notes on the ticket).
When finished, return status "done" with the HEAD sha, or status "failed" with failure_reason if you could not get to a committed, green state.`
}

function decisionNote(t) {
  if (!t.decision) return ''
  return `

The owner has decided this ticket's open question: ${t.decision}
Implement that decision. Do not reopen it or choose a different option; if it cannot work, return failed and say why.`
}

function acPrompt(t, slot, verification) {
  const decided = t.decision ? `
The owner decided this ticket's open question: ${t.decision}
Where a criterion assumes a different answer, judge it against the decision, and say so in that criterion's entry.
` : ''
  const checks = verification ? `
The implementer lists these checks outside the test suite. They are claims, not evidence: re-run any command
yourself before counting it, and treat anything it says it checked by hand as a human_check at most.
---
${verification}
---
` : ''
  return `${header(slot)}
Verify ticket ${t.id} (${t.title}) against its acceptance criteria.
The implementation is on branch ${branchOf(t)}. Diff it against the integration branch, not main:
  git diff ${A.integrationBranch}...${branchOf(t)}
${decided}${checks}Read-only: do not edit files or commit. Record the result as a note on the ticket per your instructions, then return the verdict.`
}

function conditionLines(conditions) {
  if (!conditions || !conditions.length) return '(none reported)'
  return conditions.map(c => `  - ${c.location} ${c.condition}: broke it by ${c.break}; ${c.caught ? `caught by ${c.test}` : `NOT caught: ${c.test}`}`).join('\n')
}

function priorReviewNote(t, prior) {
  if (!prior) return ''
  return `
RE-REVIEW after rework. The previous round (at ${prior.sha}) sent back these findings:
${prior.findings.map((f, i) => `  ${i + 1}. [${f.priority.toUpperCase()}] ${f.location}: ${f.description}`).join('\n')}
First check each one is actually fixed and record it in \`prior_findings\`; one that is not fixed goes back in
\`findings\`. The fix since that round is where regressions come from, so aim steps 3 and 4 at it:
  git log --oneline ${prior.sha}..${branchOf(t)}
  git diff ${prior.sha}..${branchOf(t)}
Still read the full ticket diff for context, but code the previous round passed only gets re-raised under the
round 2 rules in your instructions.
`
}

// After a conflict or a failed merge gate, the code the last review passed is unchanged;
// what is new is how the implementer brought it together with what landed since.
function resolutionNote(t, res) {
  if (!res) return ''
  const why = res.kind === 'conflict'
    ? `hit merge conflicts${res.files.length ? ` in ${res.files.join(', ')}` : ''}`
    : `merged cleanly but failed \`${res.gate}\` on the merged result`
  return `
RESOLUTION REVIEW. A review passed this ticket at ${res.sha}. Since then it ${why}, and its implementer
merged ${A.integrationBranch} into ${branchOf(t)} and fixed that. The code at ${res.sha} is not under review again:
review only what the implementer did since, as "Resolution review" in your instructions describes. The full
ticket diff above is context.
  git log --first-parent --oneline ${res.sha}..${branchOf(t)}
  git show --remerge-diff <sha>        # for each merge commit listed: what the resolver changed beyond git's own merge
  git log --first-parent --no-merges -p ${res.sha}..${branchOf(t)}   # commits made on top of the merge
`
}

function qrPrompt(t, slot, round, implSummary, conditions, final, prior, resolution) {
  const finalNote = final ? `
FINAL ROUND: this ticket has had ${CAPS.qrReworks - 1} rework round(s). Another REWORK blocks it, and every ticket
that depends on it stalls. Return REWORK only for critical or high findings. File each medium or low finding you
would have sent back as a ticket under the findings parent instead (tag it deferred-rework; the epic cannot be wrapped until it is fixed), list it
in \`filed\`, and return FINDINGS so this ticket merges. See "Final round" in your instructions.
` : ''
  const decided = t.decision ? `
The owner decided this ticket's open question: ${t.decision}
That choice is binding. Do not raise it as a finding; do check that the change implements it.
` : ''
  return `${header(slot)}
Review ticket ${t.id} (${t.title}) on branch ${branchOf(t)} (round ${round}).${finalNote}${decided}
Diff the ticket's own changes only:
  git diff ${A.integrationBranch}...${branchOf(t)}
${priorReviewNote(t, prior)}${resolutionNote(t, resolution)}Repo root (run tk create and tk backlog from here): ${A.repoRoot}
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
verdict note on the ticket, then return the verdict with every field your instructions require, including
\`reviewed_sha\` from \`git rev-parse --short ${branchOf(t)}\`.`
}

// previousError: the detail of this ticket's last merge attempt, which stopped with the tree clean.
function mergePrompt(t, previousError) {
  // The title goes inside a double-quoted shell argument, where these would be expanded or end it.
  const message = `Merge ${t.id}: ${t.title.replace(/["`$\\]/g, "'")}`
  const retry = previousError ? `
An earlier merge attempt for this ticket stopped with an error and left the tree clean:
  ${previousError}
Start again from step 1. If the ticket turns out to be merged already, step 3 says so.
` : ''
  const opening = `${header(A.integrationWorktree)}
You are the merge step for ticket ${t.id}. Run exactly these steps and nothing else. Do not edit any file.
Give every git and tk command below its own Bash call after the \`cd\` prefix; never join two of them with && or ;.
${retry}
1. \`git status --porcelain --untracked-files=no\` must print nothing (untracked files cannot affect a merge and are ignored).
   If it prints anything, return result "error" with the output and tree_clean false, and stop without touching anything.
2. \`git checkout ${A.integrationBranch}\` (it should already be checked out here).`
  const already = `If it says "Already up to date", the ticket was merged before (an earlier attempt committed but did not record it)`
  const conflict = `If the merge reports conflicts: run \`git diff --name-only --diff-filter=U\` to list them, then \`git merge --abort\`,
   confirm \`git status --porcelain --untracked-files=no\` is empty, and return result "conflict" with the conflicted files.`
  // After an "Already up to date", HEAD is whatever merged last, not this ticket's merge.
  const close = `Find the sha to record. After a merge you committed, it is \`git rev-parse --short HEAD\`. When step 3 said
   "Already up to date", it is the ticket's own merge commit:
     git log --merges -1 --format=%h --grep='^Merge ${t.id}:'
   and if that prints nothing, \`git rev-parse --short ${branchOf(t)}\`. Then run \`tk show ${t.id}\`; unless it already
   has a "Merged into ${A.integrationBranch}" note, run
     tk add-note ${t.id} "Merged into ${A.integrationBranch} by /run-tickets at <sha>."
   Then \`tk close ${t.id}\`, and return result "merged" with the sha.`
  const failure = `Any failure these steps do not cover, including a command that is refused or denied: do not try another way to
do the same thing. If \`git rev-parse -q --verify MERGE_HEAD\` prints a sha, run \`git merge --abort\`. Then run
\`git status --porcelain --untracked-files=no\` and \`git rev-parse -q --verify MERGE_HEAD\`, and return result "error"
with the failing command and its output in detail, and tree_clean true only if both of those printed nothing.`

  if (!GATES.length) {
    return `${opening}
3. \`git merge --no-ff ${branchOf(t)} -m "${message}"\`. ${already}: skip to step 5.
4. ${conflict}
5. ${close}

${failure}`
  }
  return `${opening}
3. \`git merge --no-ff --no-commit ${branchOf(t)}\`. ${already}: skip to step 8.
4. ${conflict}
5. Run each gate on the merged tree, in this order, and stop at the first one that fails. Give every gate's Bash call
   a timeout of 600000 ms:
${GATES.map(g => `     ${g}`).join('\n')}
   - A gate fails: do not try to fix anything. Keep the failing test names or error lines and the last 40 lines of its
     output, put the tree back (step 7), and return result "gate_fail" with failed_gate set to the command and that
     output in detail.
   - A gate times out or cannot run at all (command not found, missing dependencies): put the tree back (step 7) and
     return result "error" as the end of these steps describes. That is a problem with the gate, not with this ticket.
6. Every gate passed. \`git diff --name-only\` must print nothing. If it lists files, a gate rewrote them (a formatter,
   a lockfile, snapshots), so the merged result needs changes the ticket did not make: put the tree back (step 7) and
   return "gate_fail" with failed_gate set to the gate that wrote them and the file list in detail.
   Otherwise commit the merge the same way merges are always committed here, by repeating it in two Bash calls:
     git merge --abort
     git merge --no-ff ${branchOf(t)} -m "${message}"
   That is the identical merge, now committed. If it reports a clean merge, go to step 8; anything else is a failure
   (see the end of these steps).
7. Putting the tree back: \`git merge --abort\`. If that fails, \`git reset --hard HEAD\` (safe here: step 1 proved the
   tree clean, and this worktree only does merges). Then \`git status --porcelain --untracked-files=no\` must print
   nothing; if it prints anything, return "error" with that output and tree_clean false instead of the result you were
   about to return.
8. ${close}

${failure}`
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

// One merge at a time: each merge chains onto the previous one.
let mergeTail = Promise.resolve()
function withMergeLock(fn) {
  const run = mergeTail.then(fn)
  mergeTail = run.catch(() => {})
  return run
}

// ---------- per-ticket pipeline ----------

// Short and full shas of the same commit match.
const sameCommit = (a, b) => Boolean(a && b) && (a.startsWith(b) || b.startsWith(a))

async function runTicket(t, slot) {
  const rec = { id: t.id, title: t.title, outcome: null, reason: '', sha: '', acFails: 0, qrRounds: 0, qrReworks: 0,
    conflicts: 0, gateFails: 0, mergeErrors: 0, findings: [], backlog: [], noted: [], outOfScope: [], humanChecks: [], summary: '' }
  const block = reason => { rec.outcome = 'blocked'; rec.reason = reason; log(`${t.id}: BLOCKED (${reason})`); return rec }

  // What the implementer does next. Null means the branch is ready to merge as it
  // stands: a resumed run's ticket whose tip is exactly what an earlier review passed.
  let work = t.reviewed ? null : { kind: 'new' }
  let implRound = 0
  let priorReview = null
  let passedSha = null   // branch tip the last passing review saw
  let mergeError = null  // detail of the last merge attempt that stopped with the tree clean
  if (t.reviewed) {
    passedSha = t.reviewed.sha
    rec.humanChecks = t.reviewed.human_checks || []
    rec.summary = `verified and reviewed in an earlier run at ${t.reviewed.sha}`
    log(`${t.id}: passed review in an earlier run at ${t.reviewed.sha}; going straight to merge`)
  }
  while (true) {
    if (work) {
      implRound += 1
      const impl = await agent(implementPrompt(t, slot, { ...work, round: implRound }), {
        label: `impl ${t.id}${implRound > 1 ? ` r${implRound}` : ''}`, phase: 'Implement', agentType: 'ticket-implementer', schema: IMPL_SCHEMA,
        ...implEffort(t, work),
      })
      if (!impl) return block('implementer died or was stopped')
      if (impl.status !== 'done') return block(`implementer failed: ${impl.failure_reason || impl.summary}`)
      rec.summary = impl.summary
      rec.outOfScope.push(...(impl.out_of_scope || []).map(o => o.ticket_id))
      log(`${t.id}: implemented (round ${implRound})`)

      // A gate-failure round that could not reproduce the failure commits nothing.
      // Code that already passed verification and review goes straight back to merge.
      const unchanged = sameCommit(passedSha, impl.head_sha)
      if (unchanged) log(`${t.id}: no new commits since review passed; merging again`)

      // A conflict or gate-failure round only fits passed code to what landed since. The merge
      // gates re-run the suite on the merged result, so AC verification is not repeated, and
      // the review covers just the commits since the last passing one.
      const resolution = (work.kind === 'conflict' || work.kind === 'gate_fail') && passedSha
        ? { ...work, sha: passedSha } : null

      if (!unchanged && t.has_ac && !resolution) {
        const ac = await agent(acPrompt(t, slot, impl.verification), { label: `ac ${t.id}`, phase: 'Verify', agentType: 'ticket-verifier', schema: AC_SCHEMA })
        if (!ac) return block('AC verifier died or was stopped')
        if (ac.verdict === 'ERROR') return block(`AC verifier could not run: ${ac.error || ac.failures.join('; ')}`)
        if (ac.verdict === 'FAIL') {
          rec.acFails += 1
          log(`${t.id}: AC FAIL (${rec.acFails}/${CAPS.acFails})`)
          if (rec.acFails >= CAPS.acFails) return block(`failed AC verification ${rec.acFails} times: ${ac.failures.join('; ')}`)
          work = { kind: 'ac_fail', failures: ac.failures }
          continue
        }
        // The latest passing round is the one that describes the code being merged.
        rec.humanChecks = (ac.criteria || []).filter(c => c.human_check).map(c => `${c.criterion}: ${c.human_check}`)
        log(`${t.id}: AC PASS${rec.humanChecks.length ? `, ${rec.humanChecks.length} criterion(s) need a person to check` : ''}`)
      }

      if (!unchanged) {
        rec.qrRounds += 1
        // One more REWORK would reach the cap, so this review may only send back critical or high findings.
        const finalRound = rec.qrReworks + 1 >= CAPS.qrReworks
        const qr = await agent(qrPrompt(t, slot, rec.qrRounds, impl.summary, impl.conditions, finalRound, priorReview, resolution), {
          label: `review ${t.id}${rec.qrRounds > 1 ? ` r${rec.qrRounds}` : ''}`, phase: 'Review', agentType: 'ticket-reviewer', schema: QR_SCHEMA,
          ...reviewEffort(t, impl, resolution),
        })
        if (!qr) return block('quality reviewer died or was stopped')
        if (qr.verdict === 'ERROR') return block(`reviewer could not run: ${qr.error || 'no detail'}`)
        // Only a REWORK carries into the next review; after a passing one, a conflict or gate
        // round gets a resolution review instead.
        priorReview = qr.verdict === 'REWORK' && qr.findings.length && qr.reviewed_sha
          ? { sha: qr.reviewed_sha, findings: qr.findings } : null
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
        passedSha = impl.head_sha || null
        const filed = (qr.filed || []).map(f => `${f.id} (${f.action === 'noted' ? 'noted' : f.parent})`)
        log(`${t.id}: review ${qr.verdict}${filed.length ? `, filed ${filed.join(', ')}` : ''}`)
      }
    }

    const merge = await withMergeLock(() => mergeHalted ? null : agent(mergePrompt(t, mergeError), {
      label: `merge ${t.id}`, phase: 'Merge', schema: MERGE_SCHEMA, model: 'sonnet', effort: 'medium',
    }))
    if (mergeHalted && !merge) return block(`not merged: run halted after merge error: ${mergeHalted}`)
    if (!merge) {
      // It may have stopped between merging and committing or aborting, so the
      // integration worktree's state is unknown, as after a merge "error".
      mergeHalted = `merge agent for ${t.id} died or was stopped; check the integration worktree for a half-done merge`
      return block('merge agent died or was stopped')
    }
    if (merge.result === 'merged') {
      rec.outcome = 'merged'
      rec.sha = merge.sha || ''
      log(`${t.id}: merged into ${A.integrationBranch} ${rec.sha}`)
      return rec
    }
    if (merge.result === 'error') {
      rec.mergeErrors += 1
      // A refused command or a gate that could not run, with the tree put back, gets one
      // more attempt from a fresh agent. Twice, or with the tree in doubt, halts merging.
      if (merge.tree_clean === true && rec.mergeErrors === 1) {
        mergeError = merge.detail || '(no detail given)'
        log(`${t.id}: merge step errored with the tree clean; trying once more: ${mergeError}`)
        work = null
        continue
      }
      mergeHalted = merge.detail
      return block(`merge step errored: ${merge.detail}`)
    }
    mergeError = null
    if (merge.result === 'gate_fail') {
      rec.gateFails += 1
      const gate = merge.failed_gate || 'a gate'
      log(`${t.id}: merged result fails ${gate} (${rec.gateFails}/${CAPS.gateFails})`)
      if (rec.gateFails >= CAPS.gateFails) return block(`merged result failed ${gate} ${rec.gateFails} times: ${merge.detail}`)
      work = { kind: 'gate_fail', gate, detail: merge.detail || '(no output captured)' }
      continue
    }
    rec.conflicts += 1
    log(`${t.id}: merge conflict (${rec.conflicts}/${CAPS.conflicts}) in ${(merge.conflicted_files || []).join(', ')}`)
    if (rec.conflicts >= CAPS.conflicts) return block(`merge conflicts ${rec.conflicts} times: ${(merge.conflicted_files || []).join(', ')}`)
    work = { kind: 'conflict', files: merge.conflicted_files || [] }
  }
}

// A merge "error" that left the tree in doubt, a second one for the same ticket,
// or a merge agent that died halts merging: the integration worktree may be in an
// unknown state, or something every merge needs is broken, so no ticket that has
// not merged yet should try. Tickets already mid-flight finish their current
// agent and then stop at the merge step.
let mergeHalted = null

// ---------- scheduling ----------
// A ticket is ready once every dependency has finished, and starts as soon as a
// worktree slot is free. Among ready tickets, the one the most other tickets wait
// on starts first, so a long chain is never queued behind leaves. Files only break
// ties: a ticket that names no file a running ticket names goes ahead of one that
// does. A slot never sits idle over a shared file. Two tickets that name the same
// file rarely change the same lines, and when they do, the merge step reports the
// conflict and the ticket gets a resolution round.
//
// All of this is in-run state. A shared file never becomes a tk dependency, so it
// does not fix an order, outlive the run, or count toward a ticket's dependents
// (and with them its effort).
//
// Everything below runs synchronously between agent calls: a ticket that finishes
// marks its dependents ready before its slot is handed out again, so they compete
// for it on priority instead of losing it to whatever was already queued.

const position = Object.fromEntries(A.tickets.map((t, i) => [t.id, i]))
const byId = Object.fromEntries(A.tickets.map(t => [t.id, t]))
const children = Object.fromEntries(A.tickets.map(t => [t.id, []]))
for (const t of A.tickets) for (const d of t.deps) children[d].push(t.id)
const pendingDeps = Object.fromEntries(A.tickets.map(t => [t.id, t.deps.length]))
const filesOf = t => t.files || []

const freeSlots = [...A.slots]
const ready = []        // dependencies all finished, not started yet
const running = {}      // id -> files, for tickets started and not finished
const outcomes = {}
let finishedCount = 0
let allFinished
const everythingFinished = new Promise(resolve => { allFinished = resolve })

function finish(t, rec) {
  outcomes[t.id] = rec
  finishedCount += 1
  for (const c of children[t.id]) {
    pendingDeps[c] -= 1
    if (pendingDeps[c] === 0) becomeReady(byId[c])
  }
  if (finishedCount === A.tickets.length) allFinished()
}

function becomeReady(t) {
  const failedDeps = t.deps.filter(d => outcomes[d].outcome !== 'merged')
  if (failedDeps.length) {
    log(`${t.id}: stalled, waits on ${failedDeps.join(', ')}`)
    finish(t, { id: t.id, title: t.title, outcome: 'stalled', reason: `depends on unmerged ${failedDeps.join(', ')}` })
    return
  }
  ready.push(t)
}

// A path ending in "/" names a directory and covers everything under it.
const covers = (a, b) => a === b || (a.endsWith('/') && b.startsWith(a)) || (b.endsWith('/') && a.startsWith(b))
// The first running ticket that names a file t names, and that file, if any.
function overlap(t) {
  for (const [id, files] of Object.entries(running)) {
    const file = filesOf(t).find(f => files.some(g => covers(f, g)))
    if (file) return { id, file }
  }
  return null
}

function dispatch() {
  if (mergeHalted) {
    while (ready.length) {
      const t = ready.shift()
      finish(t, { id: t.id, title: t.title, outcome: 'stalled', reason: `run halted after merge error: ${mergeHalted}` })
    }
    return
  }
  while (freeSlots.length && ready.length) {
    // Re-sorted for every slot: the ticket just started may now share a file with the rest.
    const shares = Object.fromEntries(ready.map(t => [t.id, overlap(t)]))
    ready.sort((a, b) => dependents[b.id] - dependents[a.id] || Number(Boolean(shares[a.id])) - Number(Boolean(shares[b.id]))
      || position[a.id] - position[b.id])
    const t = ready.shift()
    const o = shares[t.id]
    if (o) log(`${t.id}: starts alongside ${o.id} (both name ${o.file}); a conflict is resolved at merge`)
    start(t, freeSlots.shift())
  }
}

async function start(t, slot) {
  running[t.id] = filesOf(t)
  let rec
  try {
    rec = await runTicket(t, slot)
  } catch (e) {
    rec = { id: t.id, title: t.title, outcome: 'blocked', reason: `workflow error: ${(e && e.message) || e}` }
    log(`${t.id}: BLOCKED (${rec.reason})`)
  }
  delete running[t.id]
  freeSlots.push(slot)
  finish(t, rec)
  dispatch()
}

phase('Implement')
for (const t of A.tickets) if (!t.deps.length) ready.push(t)
if (!A.tickets.length) allFinished()
dispatch()
await everythingFinished

const results = A.tickets.map(t => outcomes[t.id])

let integration = null
if (results.some(r => r.outcome === 'merged') && !mergeHalted) {
  phase('Integration check')
  integration = await agent(checkPrompt(), { label: 'integration check', phase: 'Integration check', schema: CHECK_SCHEMA, model: 'sonnet', effort: 'medium' })
  if (integration) log(`integration check: ${integration.status}`)
}

return {
  // The lead reads this in the completion notification, which can arrive long after the skill was loaded.
  next: 'Finish this run: read ~/.claude/skills/run-tickets/finish.md and follow it in full.',
  integrationBranch: A.integrationBranch,
  mergeHalted,
  integration,
  // Recorded so run-tickets-status archives which thresholds and rules each run used.
  policy: { highFanout: HIGH_FANOUT, smallDiff: SMALL_DIFF, fileLocks: 'soft', mergeGates: GATES.length > 0 },
  tickets: results,
}
