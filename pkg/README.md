# Feature location for Vitest and Jest

**Where is feature X implemented?** This tool answers by running the test suite and ranking the
source lines exercised most exclusively by feature-matching tests. It is execution evidence for
feature location, not a grep result.

Run it from the root of a project with Vitest 4+ or Jest 30+:

`npx @precisionutilityguild/recon "dark mode"`

The quoted filter is a case-insensitive substring of each test's full `suite > test` name. The
matching tests form the feature set; every other test forms the baseline. Lines are ranked by
Ochiai exclusivity, and the output names the feature tests that covered each line.

## Runners

recon detects the runner the same way for every command: a Jest config (a `jest` key in
`package.json` or a `jest.config.*` file) or a declared `jest` without a declared `vitest` selects
Jest; everything else uses Vitest. Force the choice with `--runner vitest` or `--runner jest`.

- **Vitest 4+** — the per-test coverage runner is injected through a synthetic config that inherits
  the project's own config.
- **Jest 30+** — recon runs the project's own Jest with an injected `--testEnvironment` that records
  per-test V8 coverage through jest-circus events; the project's Jest configuration is not edited.
  The Jest floor is enforced at runtime, not just advised by `peerDependencies`: a resolved Jest
  below major 30 is refused with exit 2, naming the version found
  ([`resolveJest`](./src/jest-collect.ts), covered by `test/jest-version-gate.test.ts`).

## Real run

This transcript was captured from the
[`@precisionutilityguild/culprits`](https://github.com/PrecisionUtilityGuild/culprits) working
copy. It uses two test files to keep the transcript short while preserving both a feature set and
a baseline. Stderr was suppressed only for the transcript; omit `2>/dev/null` in normal use so
collection warnings remain visible.

```text
$ node ../../recon/pkg/dist/cli.js "version gate" -n 8 -- test/jest-version-gate.test.ts test/score.test.ts 2>/dev/null; printf 'exit_code=%s\n' "$?"
recon · feature: "version gate" · tests: 22 (4 feature, 18 rest)

feature tests
  T1  test/jest-version-gate.test.ts > Jest runtime version gate > refuses a resolved Jest below the required major, naming found and floor
  T2  test/jest-version-gate.test.ts > Jest runtime version gate > accepts a resolved Jest at the required major
  T3  test/jest-version-gate.test.ts > Jest runtime version gate > accepts a resolved Jest above the required major
  T4  test/jest-version-gate.test.ts > Jest runtime version gate > still reports a missing Jest as NoJestError, not a version error

files (ranked by best line)
  #1  src/jest-collect.ts  best 1.0000  (8 lines)

top 8 lines (of 30 covered by feature tests; ranked by exclusivity)

src/jest-collect.ts
  #1  L52  exclusivity 1.0000  cf 4/4 (T1 T2 T3 T4)  cn 0/18  [unique]
        const projectRequire = createRequire(join(projectRoot, "package.json"));
  #2  L54  exclusivity 1.0000  cf 4/4 (T1 T2 T3 T4)  cn 0/18  [unique]
        try {
  #3  L55  exclusivity 1.0000  cf 4/4 (T1 T2 T3 T4)  cn 0/18  [unique]
        pkgJsonPath = projectRequire.resolve("jest/package.json");
  #4  L70  exclusivity 1.0000  cf 4/4 (T1 T2 T3 T4)  cn 0/18  [unique]
        if (!binRel) throw new NoJestError();
  #5  L44  exclusivity 0.8660  cf 3/4 (T1 T2 T3)  cn 0/18  [unique]
        if (typeof version !== "string") return null;
  #6  L45  exclusivity 0.8660  cf 3/4 (T1 T2 T3)  cn 0/18  [unique]
        const match = version.trim().match(/^\d+/);
  #7  L46  exclusivity 0.8660  cf 3/4 (T1 T2 T3)  cn 0/18  [unique]
        if (!match) return null;
  #8  L47  exclusivity 0.8660  cf 3/4 (T1 T2 T3)  cn 0/18  [unique]
        const major = Number(match[0]);
exit_code=0
```

## What this is not

- It is not Wallaby-style “which tests cover this line?” lookup. That query starts with a known
  source line and returns its tests; feature location starts with a behavior named by tests and
  ranks the source lines associated with it. See Wallaby's
  [Show Line Tests](https://wallabyjs.com/docs/v1/intro/get-started-vscode.html).
- It is not CI coverage-diff regression gating. Codecov patch coverage and
  `diff-test-coverage` evaluate lines changed between commits or in a source-control diff; feature
  location compares two partitions of one test run. See
  [Codecov patch coverage](https://docs.codecov.com/do/docs/commit-status) and
  [`diff-test-coverage`](https://www.npmjs.com/package/@connectis/diff-test-coverage).

## Flags

| Flag | Meaning |
|---|---|
| `--json` | Emit the machine-readable contract described below. |
| `-n <N>`, `--top <N>`, `--top=<N>` | Return the top N lines; the default is 15. |
| `--all` | Return every nonzero line covered by a feature test. |
| `--regex` | Treat the filter as a JavaScript regular expression instead of a case-insensitive substring. |
| `--file <glob>` | Match the filter as a glob against test file paths instead of test names. |
| `--runner <name>` | Force the runner: `vitest` or `jest`. Otherwise it is auto-detected. |
| `-h`, `--help` | Print CLI help. |
| `-- <args>` | Pass every following argument through to the selected runner. |

`--file` accepts `*` within one path segment, `**` across path separators, and `?` for one
character. For example, `npx @precisionutilityguild/recon --file "test/dark*.test.ts"` partitions
by test file.

## JSON output

Use `--json` when another program or coding agent will consume the result. The output object has
this shape:

| Field | Shape |
|---|---|
| `version` | `1` |
| `tool` | `"recon"` |
| `runner` | `"vitest"` or `"jest"` |
| `pattern` | The filter string exactly as supplied. |
| `tests` | `{ total, feature, rest, failed }`; `failed` counts failed feature tests. |
| `featureTests` | Array of `{ id, file, name }`. |
| `files` | Ranked array of `{ rank, path, bestScore, lineCount }`. |
| `lines` | Ranked array of `{ rank, file, line, source, exclusivity, counters, featureTests, unique }`. |
| `lines[].counters` | Raw `{ cf, cn, F, N }` counts. |
| `lines[].exclusivity` | JSON number rounded to four decimal places. |
| `lines[].featureTests` | IDs referring to `featureTests`. |
| `totalNonzero` | Number of rankable lines before the top-N limit. |
| `truncated` | Whether the top-N limit omitted rankable lines. |

The raw counters let consumers re-rank without recovering coverage data. `cf` and `cn` are the
numbers of feature and baseline tests covering a line; `F` and `N` are the sizes of those two test
partitions.

## Exit codes

Branch on the exit code, not output text:

| Code | Meaning |
|---|---|
| `0` | Ranking produced. |
| `1` | Runtime/internal failure: the runner crashed, coverage collection failed, a multi-project config was found, or test files failed to collect; the test universe is incomplete, so no ranking is produced. Under Jest this also fires when a per-file environment override or a test retry breaks one-to-one coverage attribution. |
| `2` | Usage error: bad flags, no runner installed, project coverage enabled (`coverage.enabled` / Jest `collectCoverage`), a resolved Jest below major 30, or a custom/non-Node Jest environment or non-circus Jest runner; the run is refused. |
| `3` | Degenerate partition: the filter matched zero tests or all tests, leaving no usable feature-versus-baseline comparison. Re-pattern and retry. |

## Limitations

- Vitest 4+ or Jest 30+.
- The feature must have tests whose names or files can define a non-degenerate partition.
- Module-scope code cannot be attributed to a test. Registration and other import-time code is
  therefore invisible.
- V8 attributes a statement to its first line, so continuation lines are not independently
  visible.
- Files whose source-map alignment cannot be verified are conservatively excluded from ranking
  instead of being assigned guessed source lines.
- Multi-project and workspace configurations are refused.

### Known limitations (Jest)

The Jest path is narrower than the Vitest path by design — coverage is attributed per test only
when recon's injected environment sees every test. recon refuses, rather than silently ranking a
partial universe, in these cases:

- **Jest below major 30 is refused** (exit 2). The floor is checked against the resolved install at
  runtime, not merely declared, because package managers routinely install out-of-range peers.
- **A custom or non-Node `testEnvironment` is refused** (exit 2). recon can only wrap the default
  `jest-environment-node`; a jsdom or other custom environment would bypass the per-test collector.
  The check compares package identity, so a hoisted-vs-nested copy of `jest-environment-node` is
  still accepted.
- **A per-file `@jest-environment` docblock, or a test retry** (`jest.retryTimes`), makes the
  reported test count and the recorded coverage disagree; recon detects the mismatch and refuses the
  incomplete run (exit 1) rather than ranking against a partial universe.
- **A non-jest-circus `testRunner` is refused** (exit 2): only jest-circus emits the per-test
  environment events recon needs.
- **Jest `projects` / multi-project configs are refused** (exit 1), matching the Vitest
  multi-project limitation.

Each of these is enforced in [`src/adapters.ts`](./src/adapters.ts) /
[`src/jest-collect.ts`](./src/jest-collect.ts) and asserted in `test/jest-integration.test.ts`,
`test/jest-version-gate.test.ts`, and `test/jest-environment-gate.test.ts`.

Lineage: [*Software Reconnaissance: Mapping Program Features to Code*, Wilde & Scully,
1995](https://doi.org/10.1002/smr.4360070105).

MIT © Precision Utility Guild
