# recon

Feature location by behavior: `npx recon` runs a suite with and without a feature exercised,
diffs V8 coverage, and prints a ranked "where does X live" — evidence an agent can't hallucinate.

## Status

Candidate — sweep-verified open as of 2026-07-15 (deep-sweep tier: **Tier-1 OPEN**, no occupant
found under any phrasing). Queued behind the culprits jest v1.1 release per the pass-3 kill audit
(2026-07-21): the reopened watches and this family queue *behind* the execution-forensics family,
not ahead of it.

## Mechanism & lineage

Software Reconnaissance — Wilde & Scully 1995 ([Journal of Software Maintenance](https://onlinelibrary.wiley.com/doi/abs/10.1002/smr.4360070105)):
locate a feature by running the program in scenarios that do and don't exercise it, then diff the
coverage. The 30-year-old blocker was instrumentation — expensive, per-project, hand-rolled.

Why now: V8 ships coverage for free (`NODE_V8_COVERAGE` / c8), so the diff is a one-command run.
It answers "where is X implemented" by *behavior* rather than by grep — exactly the kind of
grounded evidence an agent cannot fabricate.

## Occupancy receipts (near-verbatim from the sweep)

- Deep sweep, Tier 1 — verified OPEN: "**recon** — 30-year lineage, zero living tools (Wilde's own
  RECON2/3 dead C/C++); every 'coverage diff' product runs the job in reverse (CI regression)."
- Pass 1: "OPEN. All 'coverage-diff' packages are CI coverage-regression tools, different job."

No caveat was flagged for recon in either the sweep or the deep verification pass — the cleanest
of the three, and (with suspect) among the most durable lanes precisely because it sits *farthest*
from the agent-tooling hype center: unfashionable SE research nobody is racing to re-supply.

## Family / substrate

Part of the **execution-forensics family** — diffbisect (#1), recon (#2), suspect/culprits (#6),
apd (#9) all share one substrate: lightweight per-test/per-run Node instrumentation + V8 coverage.
Ship culprits first (cleanest verified gap), then **reuse the substrate** down the family; recon
is a coverage-diff layer over it.

## Before building

- **Re-verify occupants are still absent.** Sweep doctrine: agent-lane candidates move at swarm
  speed — re-check immediately before building, not before deciding. (recon is far from the hype
  center, so lower risk, but the rule still applies.)
- **Name check owed.** npm / GitHub availability for the name `recon` has NOT been checked — likely
  contested; do this first.
- GitHub code search and the MCP directories were never swept for this candidate — only npm.
