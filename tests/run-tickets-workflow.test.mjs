// Runs workflows/run-tickets-engine.js in plain Node with fake agents, to check its scheduling and merge handling
// without a real /run-tickets run.
//
//   node tests/run-tickets-workflow.test.mjs
//   WF_SRC=<path> node tests/run-tickets-workflow.test.mjs   # check another version of the script
//
// The script is wrapped in an async function and given the globals the workflow runtime provides (args, agent,
// log, phase). The fake agent() tells the step from the call's label (impl, ac, review, merge), waits a few
// milliseconds so tickets really overlap, and returns a canned result unless the scenario scripts one. It also
// records every prompt, and which tickets are in flight with which files.
//
// For scoped merge gates, it takes the run-tickets-gates command out of the merge prompt and runs the real
// bin/run-tickets-gates (with python3) on a list of changed files, to see which gates that merge would run.
//
// Not covered: whether real agents follow their prompts, how the git commands in the merge prompt behave, and
// anything the /run-tickets skill's lead does before or after the workflow.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(process.env.WF_SRC || new URL('../workflows/run-tickets-engine.js', import.meta.url), 'utf8')
  .replace('export const meta =', 'const meta =')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const sleep = ms => new Promise(r => setTimeout(r, ms))

let failures = 0
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  ${detail}`}`)
  if (!cond) failures += 1
}

// behave(kind, id, round, prompt) -> {ms, result} lets a scenario script any agent call.
async function run(args, behave = () => ({})) {
  const calls = []
  // Ticket id -> files, from its first implement call until it merges. A ticket that blocks keeps its entry,
  // so the shared-file scenarios below use tickets that all merge.
  const running = new Map()
  const sharedStarts = []
  const byId = Object.fromEntries(args.tickets.map(t => [t.id, t]))
  const rounds = {}
  const checkPrompts = []
  const agent = async (prompt, opts) => {
    if (opts.label === 'integration check') {
      checkPrompts.push(prompt)
      return { status: 'pass', commands: [], new_failures: [], preexisting_failures: [], summary: '' }
    }
    const [kind, id] = opts.label.split(' ')
    const key = `${kind} ${id}`
    rounds[key] = (rounds[key] || 0) + 1
    const round = rounds[key]
    calls.push({ kind, id, round, prompt, effort: opts.effort })
    if (kind === 'impl' && round === 1) {
      for (const [other, files] of running) {
        const shared = (byId[id].files || []).filter(f => files.some(g => f === g || f.startsWith(g) || g.startsWith(f)))
        if (shared.length) sharedStarts.push(`${id} started while ${other} runs with ${shared}`)
      }
      running.set(id, byId[id].files || [])
    }
    const b = behave(kind, id, round, prompt) || {}
    await sleep(b.ms ?? 5)
    const defaults = {
      impl: { status: 'done', head_sha: 'abc', summary: 'ok', src_lines_changed: 10, conditions: [] },
      ac: { verdict: 'PASS', failures: [], criteria: [{ criterion: 'c1', met: true, code: 'a:1', assertion: 'x' }] },
      review: { verdict: 'CLEAN', reviewed_sha: 'abc', prior_findings: [], findings: [], filed: [],
        implementer_flags: [], test_audit: [], risks_checked: [{}, {}] },
      merge: { result: 'merged', sha: 'm1', detail: '' },
    }
    const result = b.result === undefined ? defaults[kind] : b.result
    if (kind === 'merge' && result && result.result === 'merged') running.delete(id)
    return result
  }
  const logs = []
  const fn = new AsyncFunction('args', 'agent', 'log', 'phase', src)
  const out = await fn(args, agent, m => logs.push(m), () => {})
  return { out, calls, logs, sharedStarts, checkPrompts }
}

const base = { repoRoot: '/r', integrationBranch: 'run/x', integrationWorktree: '/r/int', findingsParent: 'f', backlogParent: 'b' }
const T = (id, deps = [], files = [], extra = {}) => ({ id, title: `T ${id}`, deps, has_ac: true, files, ...extra })
const implOrder = calls => calls.filter(c => c.kind === 'impl' && c.round === 1).map(c => c.id)
const promptOf = (calls, kind, round = 1) => (calls.find(c => c.kind === kind && c.round === round) || {}).prompt || ''
const implDone = (sha, extra = {}) => ({ result: { status: 'done', head_sha: sha, summary: 'ok', src_lines_changed: 5, conditions: [], ...extra } })

// ---------- scheduling ----------

// H has three transitive dependents but is listed after four leaves.
{
  const tickets = [T('L1', [], ['l1']), T('L2', [], ['l2']), T('L3', [], ['l3']), T('L4', [], ['l4']),
    T('H', [], ['h']), T('H1', ['H'], ['h1']), T('H2', ['H1'], ['h2']), T('H3', ['H2'], ['h3'])]
  const { out, calls } = await run({ ...base, slots: ['s1', 's2'], tickets })
  const order = implOrder(calls)
  check('the ticket most others wait on starts first', order[0] === 'H', order.join(','))
  check('its chain continues ahead of leaves once it merges', order.indexOf('H1') < order.indexOf('L3'), order.join(','))
  check('everything merges', out.tickets.every(t => t.outcome === 'merged'), JSON.stringify(out.tickets.map(t => t.outcome)))
  check('results come back in ticket order', out.tickets.map(t => t.id).join() === tickets.map(t => t.id).join())
}

// A shared file never leaves a slot idle: tickets that share one start together when slots are free.
{
  const tickets = [T('F1', [], ['shared.ts', 'a.ts']), T('F2', [], ['shared.ts']), T('F3', [], ['shared.ts', 'c.ts'])]
  const { out, calls, sharedStarts, logs } = await run({ ...base, slots: ['s1', 's2', 's3'], tickets }, kind => ({ ms: kind === 'impl' ? 20 : 3 }))
  const firstMerge = calls.findIndex(c => c.kind === 'merge')
  check('tickets that share a file all start before any merges', calls.slice(0, firstMerge).filter(c => c.kind === 'impl').length === 3,
    calls.map(c => `${c.kind} ${c.id}`).join(', '))
  check('starting alongside a ticket with the same file is logged with both',
    ['F2', 'F3'].every(id => sharedStarts.some(s => s.startsWith(id)))
    && logs.some(l => l.includes('F2') && l.includes('starts alongside F1') && l.includes('shared.ts')), logs.join(' | '))
  check('all of them merge', out.tickets.every(t => t.outcome === 'merged'))
}

// When slots are short, a ticket that shares no file with running work goes first.
{
  const tickets = [T('A', [], ['shared.ts']), T('B', [], ['shared.ts']), T('C', [], ['c.ts'])]
  const { calls } = await run({ ...base, slots: ['s1', 's2'], tickets }, kind => ({ ms: kind === 'impl' ? 20 : 3 }))
  check('a shared file breaks the tie between equal tickets', implOrder(calls).join() === 'A,C,B', implOrder(calls).join())
}

// A directory entry overlaps every file under it.
{
  const tickets = [T('D1', [], ['src/ui/']), T('D2', [], ['src/ui/footer.ts']), T('D3', [], ['src/api/handler.ts'])]
  const { calls } = await run({ ...base, slots: ['s1', 's2'], tickets }, kind => ({ ms: kind === 'impl' ? 20 : 3 }))
  check('a directory entry counts as sharing the files under it', implOrder(calls).join() === 'D1,D3,D2', implOrder(calls).join())
}

// Dependents still come first: a ticket others wait on starts ahead of a leaf even though it shares a file.
{
  const tickets = [T('P', [], ['p.ts']), T('H', [], ['p.ts']), T('L', [], ['l.ts']),
    T('P1', ['P'], ['p1.ts']), T('P2', ['P1'], ['p2.ts']), T('H1', ['H'], ['h1.ts'])]
  const { calls } = await run({ ...base, slots: ['s1', 's2'], tickets }, kind => ({ ms: kind === 'impl' ? 20 : 3 }))
  const order = implOrder(calls)
  check('more dependents outranks sharing a file', order[0] === 'P' && order[1] === 'H', order.join())
}

// A ticket whose dependency blocks never starts.
{
  const tickets = [T('B', [], ['b']), T('C', ['B'], ['c'])]
  const { out, calls } = await run({ ...base, slots: ['s1'], tickets }, kind =>
    kind === 'impl' ? { result: { status: 'failed', summary: 'x', src_lines_changed: 0, conditions: [], failure_reason: 'tests red' } } : {})
  check('a failed implementer blocks its ticket', out.tickets[0].outcome === 'blocked')
  check('its dependent stalls without starting', out.tickets[1].outcome === 'stalled' && !implOrder(calls).includes('C'))
}

// ---------- merge gates ----------

// A failed gate sends the ticket back with the output; the fix gets a resolution review, not a fresh one, then merges.
{
  const { out, calls } = await run({ ...base, slots: ['s1'], gates: ['npm test', 'npx tsc --noEmit'], tickets: [T('G', [], ['g'])] },
    (kind, id, round) => {
      if (kind === 'impl') return implDone(`fix${round}`)
      return kind === 'merge' && round === 1 ? { result: { result: 'gate_fail', failed_gate: 'npm test', detail: 'FAIL foo.test.ts' } } : {}
    })
  const fix = promptOf(calls, 'impl', 2)
  const review = calls.find(c => c.kind === 'review' && c.round === 2) || {}
  check('the fix round names the gate and carries its output', fix.includes('npm test') && fix.includes('FAIL foo.test.ts'))
  check('the gate fix skips AC verification', calls.map(c => c.kind).join() === 'impl,ac,review,merge,impl,review,merge', calls.map(c => c.kind).join())
  check('the gate fix gets a resolution review from the passed sha, at high effort',
    (review.prompt || '').includes('RESOLUTION REVIEW') && review.prompt.includes('fix1..ticket/G') && review.prompt.includes('failed `npm test`')
    && review.effort === 'high', `${review.effort} ${review.prompt}`)
  check('a first review is not a resolution review', !promptOf(calls, 'review').includes('RESOLUTION REVIEW'))
  check('the ticket merges after the fix', out.tickets[0].outcome === 'merged' && out.tickets[0].gateFails === 1, JSON.stringify(out.tickets[0]))
}

// A conflict round gets a resolution review that names the conflicted files and shows only the resolver's changes.
{
  const { out, calls } = await run({ ...base, slots: ['s1'], tickets: [T('C', [], ['c.ts'])] }, (kind, id, round) => {
    if (kind === 'impl') return implDone(`h${round}`, { src_lines_changed: 400 })
    return kind === 'merge' && round === 1 ? { result: { result: 'conflict', conflicted_files: ['c.ts', 'd.ts'], detail: '' } } : {}
  })
  const review = calls.find(c => c.kind === 'review' && c.round === 2) || {}
  const p = review.prompt || ''
  check('the conflict round skips AC verification', calls.map(c => c.kind).join() === 'impl,ac,review,merge,impl,review,merge', calls.map(c => c.kind).join())
  check('the resolution review names the files and the range since the passed review',
    p.includes('c.ts, d.ts') && p.includes('h1..ticket/C') && p.includes('--remerge-diff') && p.includes('--first-parent'), p)
  check('a large ticket\'s resolution review still runs at high', review.effort === 'high' && calls.find(c => c.kind === 'review').effort === undefined,
    calls.filter(c => c.kind === 'review').map(c => c.effort).join())
  check('it merges', out.tickets[0].outcome === 'merged' && out.tickets[0].conflicts === 1)
}

// A resolution review that sends work back does not make the next round a resolution round.
{
  const { calls } = await run({ ...base, slots: ['s1'], tickets: [T('RR', [], ['r.ts'])] }, (kind, id, round) => {
    if (kind === 'impl') return implDone(`h${round}`)
    if (kind === 'merge' && round === 1) return { result: { result: 'conflict', conflicted_files: ['r.ts'], detail: '' } }
    if (kind === 'review' && round === 2) {
      return { result: { verdict: 'REWORK', reviewed_sha: 'h2', prior_findings: [], filed: [], implementer_flags: [], test_audit: [], risks_checked: [{}, {}],
        findings: [{ priority: 'high', location: 'r.ts:3', description: 'the resolution dropped the guard', fix: 'restore it' }] } }
    }
    return {}
  })
  const third = promptOf(calls, 'review', 3)
  check('the fix after a resolution review is verified and re-reviewed as usual',
    calls.map(c => c.kind).join() === 'impl,ac,review,merge,impl,review,impl,ac,review,merge', calls.map(c => c.kind).join())
  check('that re-review aims at the fix, not the resolution', third.includes('RE-REVIEW') && !third.includes('RESOLUTION REVIEW'), third)
}

// Conflicts up to the cap (3) block the ticket.
{
  const { out, calls } = await run({ ...base, slots: ['s1'], tickets: [T('CC', [], ['c'])] }, (kind, id, round) => {
    if (kind === 'impl') return implDone(`h${round}`)
    return kind === 'merge' ? { result: { result: 'conflict', conflicted_files: ['c'], detail: '' } } : {}
  })
  check('the third conflict blocks the ticket', out.tickets[0].outcome === 'blocked' && out.tickets[0].conflicts === 3
    && calls.filter(c => c.kind === 'merge').length === 3, JSON.stringify(out.tickets[0]))
}

// A fix round that commits nothing goes straight back to merge.
{
  const { out, calls } = await run({ ...base, slots: ['s1'], gates: ['npm test'], tickets: [T('U', [], ['u'])] }, (kind, id, round) => {
    if (kind === 'impl') return implDone('same')
    return kind === 'merge' && round === 1 ? { result: { result: 'gate_fail', failed_gate: 'npm test', detail: 'flaky' } } : {}
  })
  check('an unchanged branch skips re-verification and re-review',
    calls.filter(c => c.kind === 'ac').length === 1 && calls.filter(c => c.kind === 'review').length === 1 && out.tickets[0].outcome === 'merged')
}

// Gate failures up to the cap block the ticket, and its dependents stall.
{
  const tickets = [T('G', [], ['g']), T('D', ['G'], ['d'])]
  const { out } = await run({ ...base, slots: ['s1'], gates: ['npm test'], tickets }, (kind, id, round) => {
    if (kind === 'impl') return implDone(`h${round}`)
    return kind === 'merge' ? { result: { result: 'gate_fail', failed_gate: 'npm test', detail: 'boom' } } : {}
  })
  check('the gate cap blocks the ticket', out.tickets[0].outcome === 'blocked' && out.tickets[0].gateFails === 2, JSON.stringify(out.tickets[0]))
  check('its dependent stalls', out.tickets[1].outcome === 'stalled')
}

// The gated merge prompt.
{
  const tickets = [{ ...T('Q', [], ['q']), title: 'Fix `foo` and $(bar) "baz"' }]
  const { calls } = await run({ ...base, slots: ['s1'], gates: ['npm test', 'npx tsc --noEmit'], tickets })
  const p = promptOf(calls, 'merge')
  const mergeLine = p.split('\n').find(l => l.includes('git merge --no-ff ticket/Q -m ')) || ''
  const message = mergeLine.slice(mergeLine.indexOf('-m "') + 4, mergeLine.lastIndexOf('"'))
  check('it merges without committing, then runs every gate', p.includes('--no-commit') && p.includes('npm test') && p.includes('npx tsc --noEmit'))
  check('it falls back to reset --hard when an abort fails', p.includes('reset --hard'))
  check('it treats files rewritten by a gate as a failure', p.includes('git diff --name-only'))
  check('it gives gates a long timeout', p.includes('600000'))
  check('the merge message has no shell-expandable or quote characters', message.length > 0 && !/[`$"\\]/.test(message), mergeLine)
}

// Without gates the merge commits in one step.
{
  const { calls } = await run({ ...base, slots: ['s1'], tickets: [T('N', [], ['n'])] })
  const p = promptOf(calls, 'merge')
  check('a run without gates merges and commits directly', /git merge --no-ff ticket\/N -m /.test(p) && !p.includes('--no-commit'))
}

// ---------- scoped merge gates ----------
// The merge prompt cannot know what a merge changes, so it hands the gates to bin/run-tickets-gates. These
// checks take that command out of the prompt and run the real script on a list of changed files.

const GATES_SCRIPT = fileURLToPath(new URL('../bin/run-tickets-gates', import.meta.url))
const gateCall = prompt => (prompt.split('\n').find(l => l.trim().startsWith('run-tickets-gates ')) || '').trim()
// What the merge step would run, for these changed files.
function gatesFor(prompt, files) {
  const call = gateCall(prompt)
  if (!call) return null
  const cmd = `python3 '${GATES_SCRIPT}'${call.slice('run-tickets-gates'.length)} --files ${files.map(f => `'${f}'`).join(' ')}`
  return execFileSync('sh', ['-c', cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean)
}
const scopedGates = [
  'npm run lint',
  { command: 'claude plugin validate mods/sample-mod', paths: ['mods/**'] },
  { command: 'python3 mods/blast-radius/bin/judge.test.py', paths: ['mods/blast-radius/**'] },
  { command: 'python3 tests/run-tickets-scripts.test.py', paths: ['bin/**', 'workflows/**', 'tests/**'] },
]

// A mods-only ticket's merge runs the mods gate and the unscoped one, nothing else.
{
  const { out, calls } = await run({ ...base, slots: ['s1'], gates: scopedGates, tickets: [T('MO', [], ['mods/sample-mod/'])] })
  const p = promptOf(calls, 'merge')
  const listed = p.split('\n').map(l => l.trim())
  check('a scoped run\'s merge prompt asks run-tickets-gates which gates apply', gateCall(p) !== '', p)
  check('it does not list the scoped commands to run unconditionally',
    !scopedGates.slice(1).some(g => listed.includes(g.command)) && p.includes('no other command as a gate'), p)
  const ran = gatesFor(p, ['mods/sample-mod/hooks/panel.ts'])
  check('a mods-only merge runs only the unscoped gate and the mods gate',
    JSON.stringify(ran) === JSON.stringify(['npm run lint', 'claude plugin validate mods/sample-mod']), JSON.stringify(ran))
  check('a merge under bin/ runs the unscoped gate and the bin gate',
    JSON.stringify(gatesFor(p, ['bin/tool'])) === JSON.stringify(['npm run lint', 'python3 tests/run-tickets-scripts.test.py']))
  check('a scoped run records that in its policy', out.policy.mergeGates === 'scoped', JSON.stringify(out.policy))
}

// Commands with quotes and dollar signs reach the script intact.
{
  const gates = [{ command: `echo 'it''s' "$HOME" \`x\``, paths: ['a/**'] }, 'echo $(date)']
  const { calls } = await run({ ...base, slots: ['s1'], gates, tickets: [T('QU', [], ['a'])] })
  const ran = gatesFor(promptOf(calls, 'merge'), ['a/b'])
  check('gate commands survive the shell quoting in the prompt', JSON.stringify(ran) === JSON.stringify([gates[0].command, gates[1]]), JSON.stringify(ran))
}

// Every attempt re-chooses from its own merged result, and the integration check runs every gate.
{
  const { calls, checkPrompts } = await run({ ...base, slots: ['s1'], gates: scopedGates, tickets: [T('RC', [], ['mods/x'])] },
    (kind, id, round) => {
      if (kind === 'impl') return implDone(`h${round}`)
      return kind === 'merge' && round === 1 ? { result: { result: 'conflict', conflicted_files: ['mods/x'], detail: '' } } : {}
    })
  const merges = calls.filter(c => c.kind === 'merge')
  check('a re-merge after a conflict chooses its gates again', merges.length === 2 && merges.every(m => gateCall(m.prompt) !== ''),
    merges.map(m => m.prompt).join('\n---\n'))
  const checkPrompt = checkPrompts[0] || ''
  check('the integration check runs every gate, scoped or not',
    scopedGates.every(g => checkPrompt.includes(typeof g === 'string' ? g : g.command)), checkPrompt)
}

// A run of plain-string gates keeps listing them, and every merge runs them all.
{
  const { out, calls } = await run({ ...base, slots: ['s1'], gates: ['npm test', 'npx tsc --noEmit'], tickets: [T('PS', [], ['p'])] })
  const p = promptOf(calls, 'merge')
  check('plain-string gates are listed and run without run-tickets-gates', !p.includes('run-tickets-gates') && /^ +npm test$/m.test(p) && /^ +npx tsc --noEmit$/m.test(p), p)
  check('an unscoped run keeps the policy value earlier runs recorded', out.policy.mergeGates === true)
}

// A malformed gate is refused before anything runs.
for (const bad of [{ command: 'x', paths: [] }, { command: 'x' }, { command: 'x', paths: ['a/**'], extra: 1 }, { command: '', paths: ['a'] },
  { command: 'x', paths: [''] }, { command: 'x', paths: 'a/**' }, { command: 'x', paths: ['/a/**'] }, { command: 'x', paths: ['./a/**'] },
  'two\nlines', '', null, 3]) {
  // The message names the gate and the shape, rather than a TypeError from deeper in.
  let message = ''
  try { await run({ ...base, slots: ['s1'], gates: [bad], tickets: [T('BG')] }) } catch (e) { message = e.message }
  check(`a malformed gate is rejected: ${JSON.stringify(bad)}`, /^gate .* must be a command string or \{command, paths/.test(message), message)
}

// A ticket found already merged records its own merge commit, not whatever HEAD is now.
for (const gates of [[], ['npm test']]) {
  const { calls } = await run({ ...base, slots: ['s1'], gates, tickets: [T('K', [], ['k'])] })
  const p = promptOf(calls, 'merge')
  const label = gates.length ? 'gated' : 'ungated'
  check(`${label}: an already-merged ticket records its own merge commit`,
    p.includes('Already up to date') && p.includes("--grep='^Merge K:'") && p.includes('rev-parse --short ticket/K'))
  check(`${label}: an already-merged ticket does not get a second merge note`, p.includes('unless it already'))
  check(`${label}: every git command gets its own Bash call`, p.includes('its own Bash call'))
  check(`${label}: an error reports whether the tree is clean`, p.includes('tree_clean true only if'))
}

// ---------- halts ----------

// A merge error halts the run: queued tickets stall instead of starting.
{
  const tickets = [T('E', [], ['e']), T('Q1', [], ['q1']), T('Q2', [], ['q2'])]
  const { out, calls } = await run({ ...base, slots: ['s1'], tickets }, (kind, id) =>
    kind === 'merge' && id === 'E' ? { result: { result: 'error', detail: 'dirty tree' } } : {})
  check('the erroring ticket blocks', out.tickets[0].outcome === 'blocked')
  check('queued tickets stall without starting', out.tickets.slice(1).every(t => t.outcome === 'stalled') && implOrder(calls).length === 1,
    JSON.stringify(out.tickets.map(t => [t.id, t.outcome])))
  check('no integration check runs after a halt', out.integration === null)
}

// A merge agent that dies may leave a half-done merge, so later merges halt too.
{
  const tickets = [T('M1', [], ['m1']), T('M2', [], ['m2'])]
  const { out } = await run({ ...base, slots: ['s1'], tickets }, (kind, id) => kind === 'merge' && id === 'M1' ? { result: null } : {})
  check('a dead merge agent halts the run', out.tickets[0].outcome === 'blocked' && out.tickets[1].outcome === 'stalled' && Boolean(out.mergeHalted),
    `${JSON.stringify(out.tickets.map(t => [t.id, t.outcome]))} ${out.mergeHalted}`)
}

// An error that left the tree clean (a refused command) gets one fresh attempt, and the run carries on.
{
  const tickets = [T('R', [], ['r']), T('O', [], ['o'])]
  const { out, calls } = await run({ ...base, slots: ['s1'], tickets }, (kind, id, round) =>
    kind === 'merge' && id === 'R' && round === 1 ? { result: { result: 'error', tree_clean: true, detail: 'git merge was refused' } } : {})
  const merges = calls.filter(c => c.kind === 'merge' && c.id === 'R')
  check('a clean-tree merge error is retried once', merges.length === 2 && out.tickets[0].outcome === 'merged', JSON.stringify(out.tickets[0]))
  check('the retry is told what stopped the first attempt', merges[1].prompt.includes('git merge was refused') && !merges[0].prompt.includes('earlier merge attempt'))
  check('a retried merge does not re-implement, re-verify, or re-review',
    calls.filter(c => c.id === 'R' && c.kind !== 'merge').length === 3, calls.filter(c => c.id === 'R').map(c => c.kind).join())
  check('the run is not halted by an error the retry got past', !out.mergeHalted && out.tickets[1].outcome === 'merged')
}
{
  const { calls } = await run({ ...base, slots: ['s1'], tickets: [T('R3', [], ['r'])] }, (kind, id, round) => {
    if (kind === 'impl') return implDone(`h${round}`)
    if (kind !== 'merge') return {}
    return round === 1 ? { result: { result: 'error', tree_clean: true, detail: 'refused' } }
      : round === 2 ? { result: { result: 'conflict', conflicted_files: ['r'], detail: '' } } : {}
  })
  const last = calls.filter(c => c.kind === 'merge').pop()
  check('only the attempt right after an error is told about it', last.round === 3 && !last.prompt.includes('earlier merge attempt'))
}

// A second clean-tree error halts merging; so does a first error with the tree in doubt.
{
  const { out, calls } = await run({ ...base, slots: ['s1'], tickets: [T('R2', [], ['r']), T('Q', [], ['q'])] }, (kind, id) =>
    kind === 'merge' && id === 'R2' ? { result: { result: 'error', tree_clean: true, detail: 'refused again' } } : {})
  check('a second clean-tree error halts the run', calls.filter(c => c.kind === 'merge').length === 2 && out.tickets[0].outcome === 'blocked'
    && out.tickets[1].outcome === 'stalled' && out.mergeHalted === 'refused again', JSON.stringify(out.tickets))
}
{
  const { out, calls } = await run({ ...base, slots: ['s1'], tickets: [T('D', [], ['d'])] }, kind =>
    kind === 'merge' ? { result: { result: 'error', tree_clean: false, detail: 'abort failed' } } : {})
  check('an error that left the tree in doubt halts at once', calls.filter(c => c.kind === 'merge').length === 1 && Boolean(out.mergeHalted))
}

// ---------- resuming ----------

// A ticket whose branch already passed review in an earlier run goes straight to merge.
{
  const reviewed = { sha: 'abc1234', human_checks: ['menu opens: look at it on a phone'] }
  const { out, calls, logs } = await run({ ...base, slots: ['s1'], tickets: [T('W', [], ['w'], { reviewed }), T('X', ['W'], ['x'])] })
  check('a reviewed ticket runs only its merge', calls.filter(c => c.id === 'W').map(c => c.kind).join() === 'merge',
    calls.filter(c => c.id === 'W').map(c => c.kind).join())
  check('it merges and its dependent runs', out.tickets.every(t => t.outcome === 'merged'))
  check('its earlier human checks are carried into the result', out.tickets[0].humanChecks.join() === reviewed.human_checks.join())
  check('the log says it skipped to merge', logs.some(l => l.includes('W') && l.includes('earlier run')), logs.join(' | '))
}

// If it then conflicts, its first implementer prepares the slot, and the resolution is reviewed from the earlier run's sha.
{
  const { out, calls } = await run({ ...base, slots: ['s1'], tickets: [T('Y', [], ['y'], { reviewed: { sha: 'abc1234', human_checks: [] } })] },
    (kind, id, round) => {
      if (kind === 'impl') return implDone('def5678')
      return kind === 'merge' && round === 1 ? { result: { result: 'conflict', conflicted_files: ['y'], detail: '' } } : {}
    })
  const impl = promptOf(calls, 'impl')
  check('the conflict round prepares the slot', impl.includes('worktree-reset') && impl.includes('Merge conflict'))
  check('the resolution is reviewed before merging again',
    calls.map(c => c.kind).join() === 'merge,impl,review,merge' && out.tickets[0].outcome === 'merged', calls.map(c => c.kind).join())
  check('the resolution review starts from the sha the earlier run reviewed', promptOf(calls, 'review').includes('abc1234..ticket/Y'))
}

// A gate fix that commits nothing on a reviewed ticket merges again without review, even when shas differ in length.
{
  const { calls } = await run({ ...base, slots: ['s1'], gates: ['npm test'], tickets: [T('Z', [], ['z'], { reviewed: { sha: 'abc1234', human_checks: [] } })] },
    (kind, id, round) => {
      if (kind === 'impl') return implDone('abc1234def567')
      return kind === 'merge' && round === 1 ? { result: { result: 'gate_fail', failed_gate: 'npm test', detail: 'flaky' } } : {}
    })
  check('a short and a full sha of one commit count as unchanged', calls.map(c => c.kind).join() === 'merge,impl,merge', calls.map(c => c.kind).join())
}

// ---------- what each agent is told ----------

// The owner's decision reaches every agent that works on the ticket, including rework rounds.
{
  const decision = 'Use 8 retries.'
  const { calls } = await run({ ...base, slots: ['s1'], tickets: [T('X', [], ['x'], { decision })] }, (kind, id, round) => {
    if (kind === 'impl') return implDone(`h${round}`, { verification: 'npm run e2e -- settings shows the footer' })
    return kind === 'ac' && round === 1 ? { result: { verdict: 'FAIL', failures: ['c1 missing'], criteria: [] } } : {}
  })
  check('the implementer gets the decision', promptOf(calls, 'impl').includes(decision))
  check('the verifier gets the decision', promptOf(calls, 'ac').includes(decision))
  check('the reviewer gets the decision as binding', promptOf(calls, 'review').includes(decision) && promptOf(calls, 'review').includes('binding'))
  check('a rework round still carries the decision', promptOf(calls, 'impl', 2).includes(decision))
  check('the verifier gets the implementer\'s verification notes', promptOf(calls, 'ac').includes('npm run e2e -- settings'))
}

// Criteria a person must check are carried into the ticket's result.
{
  const { out } = await run({ ...base, slots: ['s1'], tickets: [T('V', [], ['v'])] }, kind =>
    kind === 'ac' ? { result: { verdict: 'PASS', failures: [], criteria: [
      { criterion: 'footer stays visible', met: true, code: 'a:1', assertion: 'none', human_check: 'open the settings page at 1280x800' }] } } : {})
  const checks = out.tickets[0].humanChecks
  check('a human check is recorded', checks.length === 1 && checks[0].includes('settings page'), JSON.stringify(checks))
}

// ---------- bad input and edge cases ----------

{
  let threw = false
  try { await run({ ...base, slots: ['s1'], tickets: [T('A', ['B']), T('B')] }) } catch (e) { threw = true }
  check('a dependency listed after its dependent is rejected instead of hanging', threw)
}
{
  let threw = false
  try { await run({ ...base, slots: ['s1'], tickets: [T('F', [], 'a.ts, b.ts')] }) } catch (e) { threw = true }
  check('a files value that is not an array is rejected', threw)
}
{
  let threw = false
  try { await run({ ...base, slots: [], tickets: [T('S')] }) } catch (e) { threw = true }
  check('a run with no slots is rejected', threw)
}
{
  const { out } = await run({ ...base, slots: ['s1'], tickets: [] })
  check('an empty run finishes', Array.isArray(out.tickets) && out.tickets.length === 0)
}
{
  const { out } = await run({ ...base, slots: ['s1'], gates: ['npm test'], tickets: [T('P', [], ['p'])] })
  check('the result records the policy the run used', out.policy.fileLocks === 'soft' && out.policy.mergeGates === true)
  check('the policy records the implementer effort arm', out.policy.implEffort === 'high' && out.policy.implFanout === 'xhigh')
  check('the result points the lead at the finish steps', /skills\/run-tickets\/finish\.md/.test(out.next || ''))
}
{
  // R has three transitive dependents (A, B via A, C via A), so it is high-fanout; L has none.
  const { calls } = await run({ ...base, slots: ['s1', 's2'],
    tickets: [T('R'), T('A', ['R']), T('B', ['A']), T('C', ['A']), T('L')] })
  const impl = id => calls.find(c => c.kind === 'impl' && c.id === id)
  check('a high-fanout ticket\'s first round runs at the fan-out effort', impl('R').effort === 'xhigh', impl('R').effort)
  check('an ordinary ticket\'s first round runs at the default effort', impl('L').effort === 'high', impl('L').effort)
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
