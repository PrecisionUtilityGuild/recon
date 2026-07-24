# Feature location for Vitest

**Where is feature X implemented?** Feature location by per-test coverage diff for Vitest —
ranked source lines with the tests that prove them. It is execution evidence, not a grep result:
the tool runs your suite and ranks the lines exercised most exclusively by feature-matching tests.

## Install / quickstart

Run from the root of a project using Vitest 4 or newer:

```
npx @precisionutilityguild/recon "dark mode"
```

The quoted filter is a case-insensitive substring of each test's full `suite > test` name. The
matching tests form the feature set; every other test forms the baseline. Lines are ranked by
Ochiai exclusivity, and the output names the feature tests that covered each line.

## A real run (trimmed)

Captured from the [`@precisionutilityguild/culprits`](https://github.com/PrecisionUtilityGuild/culprits)
working copy, two test files for a short transcript. Omit `2>/dev/null` in normal use so collection
warnings stay visible. Trimmed to the top 4 lines; the full run is in [`pkg/README.md`](./pkg/README.md).

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
exit_code=0
```

## What it is / what it is NOT

Feature location starts with a behavior *named by tests* and ranks the source lines associated with
it. That is a different query from these neighbors:

- **Not Wallaby-style "which tests cover this line?"** That starts from a known source line and
  returns its tests; feature location runs the other direction. See Wallaby's
  [Show Line Tests](https://wallabyjs.com/docs/v1/intro/get-started-vscode.html).
- **Not CI coverage-diff regression gating.** Codecov patch coverage and
  [`diff-test-coverage`](https://www.npmjs.com/package/@connectis/diff-test-coverage) evaluate lines
  changed between commits; feature location compares two partitions of one test run.

## Flags

| Flag | Meaning |
|---|---|
| `--json` | Emit the machine-readable contract. |
| `-n <N>`, `--top <N>`, `--top=<N>` | Return the top N lines; default 15. |
| `--all` | Return every nonzero line covered by a feature test. |
| `--regex` | Treat the filter as a JavaScript regular expression instead of a substring. |
| `--file <glob>` | Match the filter as a glob against test file paths instead of test names. |
| `-h`, `--help` | Print CLI help. |
| `-- <args>` | Pass every following argument through to Vitest. |

## Exit codes

Branch on the exit code, not output text:

| Code | Meaning |
|---|---|
| `0` | Ranking produced. |
| `1` | Runtime/internal failure: Vitest crashed, coverage collection failed, a multi-project config was found, or test files failed to collect. |
| `2` | Usage error: bad flags, no Vitest, or project `coverage.enabled`; the run is refused. |
| `3` | Degenerate partition: the filter matched zero tests or all tests. Re-pattern and retry. |

## Limitations

- Vitest 4+ only.
- The feature must have tests whose names or files define a non-degenerate partition.
- Module-scope / import-time code cannot be attributed to a test, so it is invisible.
- V8 attributes a statement to its first line, so continuation lines are not independently visible.
- Files whose source-map alignment cannot be verified are conservatively excluded from ranking.
- Multi-project and workspace configurations are refused.

## More

- Full contract — `--json` field-by-field, JSON output shape, `--file` glob syntax, lineage:
  [`pkg/README.md`](./pkg/README.md).
- Release: [v0.1.0](https://github.com/PrecisionUtilityGuild/recon/releases/tag/v0.1.0).

Lineage: [*Software Reconnaissance: Mapping Program Features to Code*, Wilde & Scully,
1995](https://doi.org/10.1002/smr.4360070105).

MIT © Precision Utility Guild
