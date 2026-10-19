---
name: analyze-runs
description: >
  Analyze archived /run-tickets runs to find what to tune: rework and block rates,
  token cost, and escaped defects, broken down by effort policy, implementation and
  review effort, diff size, and dependents. Read-only; recommends changes with the
  evidence and sample size behind each. Use when the user asks how run-tickets is
  doing over time, whether an effort or policy change helped, where runs spend
  tokens, or what to improve next in the pipeline.
argument-hint: "[--all-repos] [--since YYYY-MM-DD]"
---

# Analyze Runs

Turn the numbers from `run-history` into a short, honest assessment. The
script does all the counting, so never recompute its numbers by hand. Your job
is judgment: what the numbers support, what they do not, and what to change.

## Steps

1. From the repo whose runs the user means (or with `--all-repos`), run:
   ```bash
   run-history $ARGUMENTS
   ```
   If it reports no archived runs, say so, and mention that `/run-tickets`
   archives each run as it finishes (`run-tickets-status --archive <run-id>`
   adds an older one while its transcripts still exist, which is about 30
   days).

2. When a comparison needs a cross-tab the text output does not show (review
   effort within one diff-size bucket, say), get the rows with
   `run-history --json` and filter `attempts_detail` with `jq`. Quote the
   command you used alongside the result.

3. Read the numbers against the rules below, then write the report.

## Rules for reading the numbers

- **Sample size first.** Every group shows `n`, its ticket attempts. Do not
  recommend a change from a group under 10 attempts, or from a difference two
  tickets could produce. Say "not enough data yet" and name the number of
  runs that would settle it. A clear "we can't tell yet" is a good result.
- **Effort is not randomized.** The policy assigns effort by fanout and diff
  size, so the max and xhigh groups hold the bigger and more central tickets
  by construction. Before crediting or blaming an effort level, compare within
  one diff-size or dependents bucket.
- **Compare policies, not dates.** The `by policy` group separates runs by the
  thresholds they ran under. A before-and-after claim needs both sides.
- **The implementer-effort A/B (started 2026-10-18).** Runs whose policy says
  `implEffort=high, implFanout=xhigh` are the new arm. Before it, first rounds
  ran at xhigh, and max on high-fanout tickets. The earlier analysis found max
  cost 1.5-3x the implementer minutes and about 2x the tokens of xhigh for the
  same diff size, with first-round rework lower only on diffs of 50+ lines
  (n=17) and escapes no better than the pre-policy high-effort runs on the
  same kind of ticket (0.9 vs 1.3 per merged, n=10 vs 27). Read the new arm
  from two places: `by policy` for every ticket, and `high-fanout tickets by
  policy` for the ones the fan-out rule applies to. Compare like with like:
  the new arm's `impl min`, rework and escapes against the earlier policies'
  rows, within the same table. It settles when the new arm has 80+ attempts
  overall and 25+ high-fanout (about three runs). Keep the new levels if
  escapes per merged stay at or below the earlier rows (about 0.55 overall,
  about 1.3 on high-fanout) and `impl min` falls. Go back up a level if
  escapes pass about 0.8 overall or 2 on high-fanout, or if a repo's rework
  per attempt on 50-199 line diffs rises enough to eat the implementer time
  saved (a rework round costs about 6 minutes in a repo with fast reviews and
  20-40 in one with slow ones; `--json` has `seconds` per step). Known biases:
  every max attempt came from one repo, and central tickets collect escapes
  whatever their effort, so never compare high-fanout rows against the
  overall ones.
- **Fewer reworks is not better on its own.** Lighter review finds less and
  sends back less, which looks like improvement. Only recommend less effort
  when escapes per merged ticket stay flat or fall. Recommending less effort
  on rework numbers alone is the one mistake this skill exists to prevent.
- **Escapes lag.** A ticket's escapes build up as later runs review around its
  code, so recent runs look cleaner than they are. Note how recent the
  comparison groups are. Escapes are traced by blaming finding lines, which
  drift, so read them as a trend, not a verdict on one ticket.
- **Separate pipeline failures from ticket failures.** In the `blocked` list,
  an agent that misread its instructions, a broken integration branch, or a
  harness error is a pipeline bug, and worth fixing whatever the sample size.
  A ticket that used up its rework rounds on real problems is a ticket-size or
  spec problem (see the oversized-ticket split rule in `/spec`).

## Report

Keep it short and in this shape:

```
run-tickets over <N> runs (<first> to <last>), <attempts> ticket attempts

Headline: <one sentence: the most important thing the data says, or "not enough data yet to judge <X>">

Findings:
  1. <claim>. Evidence: <numbers with n, and the group or jq command>. Confidence: <high | medium | low, and why>
  ...

Recommendations:
  - <specific change: file and setting, e.g. SMALL_DIFF in workflows/run-tickets-engine.js>, because <finding #>
  - Pipeline bugs to fix now: <from the blocked list, or "none">

Open questions: <what more data would settle, and roughly how many more runs that takes>
```

Do not edit anything. If the user wants a recommendation made, that is a
separate change they ask for.
