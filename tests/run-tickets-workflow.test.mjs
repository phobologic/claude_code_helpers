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
// Not covered: whether real agents follow their prompts, how the git commands in the merge prompt behave, and
// anything the /run-tickets skill's lead does before or after the workflow.
import { readFileSync } from 'node:fs'

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
  // so the lock scenarios below use tickets that all merge.
  const running = new Map()
  const lockViolations = []
  const byId = Object.fromEntries(args.tickets.map(t => [t.id, t]))
  const rounds = {}
  const agent = async (prompt, opts) => {
    if (opts.label === 'integration check') {
      return { status: 'pass', commands: [], new_failures: [], preexisting_failures: [], summary: '' }
    }
    const [kind, id] = opts.label.split(' ')
    const key = `${kind} ${id}`
    rounds[key] = (rounds[key] || 0) + 1
    const round = rounds[key]
    calls.push({ kind, id, round, prompt })
    if (kind === 'impl' && round === 1) {
      for (const [other, files] of running) {
        const shared = (byId[id].files || []).filter(f => files.some(g => f === g || f.startsWith(g) || g.startsWith(f)))
        if (shared.length) lockViolations.push(`${id} started while ${other} holds ${shared}`)
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
  return { out, calls, logs, lockViolations }
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

// Tickets that share a file take turns; the others fill free slots meanwhile.
{
  const tickets = [T('F1', [], ['shared.ts', 'a.ts']), T('F2', [], ['shared.ts']), T('F3', [], ['b.ts']), T('F4', [], ['shared.ts', 'c.ts'])]
  const { out, lockViolations, logs } = await run({ ...base, slots: ['s1', 's2', 's3'], tickets }, kind => ({ ms: kind === 'impl' ? 20 : 3 }))
  check('no two tickets hold the same file at once', lockViolations.length === 0, lockViolations.join('; '))
  check('a lock wait is logged with the file and its holder', logs.some(l => l.includes('F2') && l.includes('shared.ts') && l.includes('F1')), logs.join(' | '))
  check('all of them merge', out.tickets.every(t => t.outcome === 'merged'))
}

// A directory entry holds every file under it.
{
  const tickets = [T('D1', [], ['src/ui/']), T('D2', [], ['src/ui/footer.ts']), T('D3', [], ['src/api/handler.ts'])]
  const { lockViolations, logs } = await run({ ...base, slots: ['s1', 's2', 's3'], tickets }, kind => ({ ms: kind === 'impl' ? 20 : 3 }))
  check('a directory lock covers the files under it', lockViolations.length === 0 && logs.some(l => l.includes('D2') && l.includes('src/ui/')),
    `${lockViolations.join('; ')} | ${logs.join(' | ')}`)
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

// A failed gate sends the ticket back with the output; the fix is re-verified and re-reviewed, then merges.
{
  const { out, calls } = await run({ ...base, slots: ['s1'], gates: ['npm test', 'npx tsc --noEmit'], tickets: [T('G', [], ['g'])] },
    (kind, id, round) => {
      if (kind === 'impl') return implDone(`fix${round}`)
      return kind === 'merge' && round === 1 ? { result: { result: 'gate_fail', failed_gate: 'npm test', detail: 'FAIL foo.test.ts' } } : {}
    })
  const fix = promptOf(calls, 'impl', 2)
  check('the fix round names the gate and carries its output', fix.includes('npm test') && fix.includes('FAIL foo.test.ts'))
  check('the fix is re-verified and re-reviewed', calls.filter(c => c.kind === 'ac').length === 2 && calls.filter(c => c.kind === 'review').length === 2)
  check('the ticket merges after the fix', out.tickets[0].outcome === 'merged' && out.tickets[0].gateFails === 1, JSON.stringify(out.tickets[0]))
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
  check('the result records the policy the run used', out.policy.fileLocks === true && out.policy.mergeGates === true)
  check('the result points the lead at the finish steps', /skills\/run-tickets\/finish\.md/.test(out.next || ''))
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
