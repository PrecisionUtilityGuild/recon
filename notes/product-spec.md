# recon — internal product spec (v1, pre-build)

**"Where is dark mode implemented?" — these 12 lines, ranked, with the tests that prove it.**

Feature location by coverage diff for JS/TS. Software Reconnaissance (Wilde & Scully 1995,
J. Software Maintenance) located features by running the program with and without the feature
exercised and diffing coverage; the 30-year blocker was instrumentation cost. V8 coverage is now
free, and culprits already ships the per-test collection substrate. `recon` answers "where does X
live" with execution evidence — grounded output an agent cannot hallucinate, unlike grep-and-guess.

```
npx @precisionutilityguild/recon "dark mode"
```

No config, no daemon, no index, no API key, no LLM calls — v1 is fully deterministic.

---

## The problem

A dev or coding agent lands in an unfamiliar repo and must find where feature X is implemented.
Grep matches names, not behavior; agents burn context reading candidate files. The evidence
already exists — which tests exercise the feature and which lines those tests execute — and
nobody in JS/TS-land computes it. Sweep receipts (`../main.md`): deep-sweep Tier-1 OPEN,
2026-07-15 — every "coverage diff" product on npm runs the job in reverse (CI regression
gating); Wilde's own RECON2/3 are dead C/C++ academia. Owed re-verification: re-run the occupant
sweep immediately before build (sweep doctrine), plus GitHub code search and MCP directories,
which were never swept for this candidate.

## Target user (ICP)

Same two consumers as culprits, one output:

- **Human dev**: new to a codebase (or back after six months), wants the feature's footprint
  before editing. Reads the human format.
- **Coding agent**: "add an option to feature X" in a repo it hasn't indexed. Pipes
  `recon --json` and starts at the top-ranked files instead of exploring. Ships with a thin
  Claude Code skill wrapper (skeleton: `awesome:0`).

Buy trigger: any "where is / how does X work" task in a repo with a test suite.

## v1 collection mode: test-partition (decided)

Two candidate modes were weighed:

- **(a) Test-partition** — run the suite once with per-test coverage (culprits substrate),
  partition tests into feature-matching vs rest by a name/file pattern, rank lines by how
  exclusively the feature tests cover them.
- **(b) Two-run** — `recon --on "<cmd>" --off "<cmd>"` with `NODE_V8_COVERAGE` around two
  arbitrary commands, diff aggregate coverage.

**v1 core is (a).** Reasons, in order of weight: (1) the mechanism is already spike-validated
and productized — culprits' collector (`culprits/pkg/src/collect.ts`, `TestRecord`/
`CollectResult`) delivers per-test V8 coverage with source-map translation, and the family
doctrine is explicitly "ship culprits, reuse the substrate down the family"; (2) per-test
spectra give a *graded* exclusivity ranking (shared utility code scores low, feature-exclusive
code scores high) — an aggregate two-run diff is binary in/out and drowns in incidentally-
differing coverage between two nondeterministic runs; (3) zero scenario-construction burden:
the user supplies a pattern, not two hand-built runs — for the agent ICP that is the difference
between a one-liner and a planning subtask. Known cost, accepted: (a) only works where the
feature has tests. That is the honest v1 boundary, not a defect — the output says so (exit 3).

**(b) is v1.x-or-never.** Only if v1 adoption shows demand from repos where features lack tests
(issues asking for it), and only as an additive flag pair — never a rewrite of the ranking core.
Dropped without ceremony otherwise.

## MVP scope (v1)

One command, TypeScript, published as `@precisionutilityguild/recon` with bin `recon`:

1. **Run** the project's existing vitest suite once with per-test line coverage — culprits'
   collector, extracted by copy (a shared substrate package only when a third family member
   ships; two consumers don't justify the coordination tax).
2. **Partition** tests: a test is a *feature test* iff the pattern (case-insensitive substring;
   `--regex` for regex) matches its full name (suite > name); `--file <glob>` matches test file
   paths instead. F = feature tests, N = the rest.
3. **Compute** per line: cf/cn = feature/non-feature tests covering the line. **Exclusivity
   (primary ranking key) is the Ochiai transplant with feature tests in the "failing" role:
   `cf / √(F · (cf + cn))`** — 1.0 exactly when all feature tests and no others cover the line,
   degrading smoothly as coverage is shared. Lines with cf = 0 never appear. Lines with cn = 0
   carry a `[unique]` badge (Wilde & Scully's "uniquely involved" set) — display marker only,
   never a sort key or filter (culprits measured that hard badge-filters eject truth).
4. **Print** top-N lines (default 15), grouped by file, each with score, cf/F, cn/N, source
   snippet, and short IDs of the covering feature tests — plus a per-file rollup header
   (files ranked by their best line) since "which files" is half the question.

Flags (v1 complete list): `--json`, `-n <N>`/`--top <N>`, `--all`, `--regex`,
`--file <glob>`, `-- <args>` (passed through to vitest).

**Spectrum rules inherited from culprits, verbatim**: line-level after source-map translation;
executable statements only; module-scope lines excluded (attributed to no test by the measured
flush mechanism — a real loss for feature *registration* code, documented, revisit in v2);
continuation-line blindness (V8 first-line attribution) documented. Failing tests: **warn and
proceed** — unlike SBFL, pass/fail is not the signal here; failing feature tests are listed in
the header as an evidence caveat.

## Output contract

Goldens are the contract, culprits-style: `spec/output-samples/fixture-basic.txt` + `.json`,
hand-derived counters shown in a `DERIVATION.md`. Human format: deterministic, no timestamps,
no colors when piped; feature tests named once in a header, referenced by ID (`T1`…). `--json`:
`version` (1), `tool` (`"recon"`), `runner`, `pattern`, `tests` {total, feature, rest, failed},
`featureTests` (id/file/name), `files` (rank, path, bestScore, lineCount), `lines` (rank, file,
line, source, `exclusivity` rounded to 4 decimals as a JSON number, raw `counters` {cf, cn, F, N},
`featureTests` ID refs, `unique` boolean), `totalNonzero`, `truncated`. Raw counters always
included so consumers can re-rank. Ties: exclusivity desc, cf desc, file path asc, line asc.
Same input → byte-identical output.

**Exit codes** (culprits conventions):

| Code | Meaning |
|------|---------|
| 0 | Ranking produced |
| 1 | Runtime/internal failure (vitest crashed, coverage collection failed, multi-project config, failed-to-collect test files — incomplete universe, refuse to rank) |
| 2 | Usage error (bad flags, no vitest, project `coverage.enabled` — the silent-zeroing hazard, refuse) |
| 3 | Degenerate partition — pattern matched 0 tests, or all tests (no baseline). Names the counts so agents can branch and re-pattern |

## Non-goals (v1)

- **No two-run mode** (v1.x-or-never, above). No jest, mocha, node:test — vitest only; jest
  follows culprits' jest support, only if the substrate carries it for free.
- **No LLM calls, no summaries of "what the feature does".** Location only; the consumer reasons.
- **No call-graph expansion, slicing, or static augmentation.** Executed lines are the evidence.
- **No watch mode, history, editor integration.** CLI + JSON is the whole surface.
- **No monorepo/`test.projects` support** (inherited culprits limitation, refuse with exit 1).

## Package identity

npm **`@precisionutilityguild/recon`**, repo **PrecisionUtilityGuild/recon** — both verified
free 2026-07-22 (PUG publishing doctrine: everything under the org). Unscoped `recon` is a dead
2011 squatter; do not contest. Search collision is real — "recon" means security tooling —
so README title and npm keywords lead with **"feature location"** and **"coverage"**
("feature location javascript", "where is this feature implemented", "software reconnaissance",
"coverage diff"), never bare "recon". Free OSS (MIT): same distribution-generic rationale as
culprits — zero purchase history for standalone feature location in any ecosystem; the return
is the agent-tooling channel.

## Build plan (queued behind culprits jest v1.1 per the pass-3 audit; clock starts 2026-09-01)

1. **Phase 1 — engine (2–3 d):** re-verify occupants (sweep + GitHub + MCP dirs, kill here if
   occupied); extract collector from culprits by copy; partition + exclusivity scoring; fixture
   repo with a seeded "feature" and hand-derived golden counters.
2. **Phase 2 — CLI + contract (2 d):** flags, refusal guards, human + `--json` goldens
   byte-exact, exit codes.
3. **Phase 3 — validation + ship (2 d):** locate 3 ground-truth features in 2 real OSS vitest
   repos, measure whether the known implementing files rank top-3 (record ranks in notes — this
   is the mechanism gate evidence); README, publish, skill wrapper, launch write-up ("feature
   location is 30 years old and JS never got it").

## Kill criteria (set 2026-07-22, before any code)

1. **Mechanism gate (kill by 2026-09-12):** golden reproduced from real per-test coverage AND
   ground-truth files rank top-3 in at least 2 of 3 real-repo trials. A feature locator that
   points at the wrong files is worse than grep; no fallback mechanism is on the shelf — miss
   the gate, kill before publishing.
2. **Public** (a stranger can run it on their own vitest repo) **by 2026-09-15.**
3. **Adoption gate (kill by 2026-09-29):** two weeks after public, near-zero traction — no
   meaningful downloads/skill installs and zero external signal via the weekly distribution
   loop — kills it. No rescue via two-run mode, editor plugins, or LLM layers; the thesis was
   one-liner-or-nothing.
