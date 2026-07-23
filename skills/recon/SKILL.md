---
name: recon
description: >-
  Use for any “where is X implemented?” or “how does X work?” task in a JavaScript or TypeScript repository with a Vitest suite. Runs `npx @precisionutilityguild/recon --json` to partition tests by a feature pattern and rank the source lines exercised most exclusively by those tests. Thin wrapper around the deterministic CLI; feature location from execution evidence, not grep.
---

# Feature location

Run from the repository root with a test-name substring that identifies the feature:

```text
npx @precisionutilityguild/recon "feature pattern" --json
```

Use the full suite first: non-feature tests are the baseline that makes shared utilities rank
below feature-specific code. Use `--regex` for a regular expression, `--file <glob>` to partition
by test file, or pass Vitest arguments after `--` only when the full suite is impractical.

On exit 0, read `featureTests`, then inspect the first few `lines` and their source files. Treat
equal-score lines as one evidence group. The ranking locates code; reason about its behavior
before editing.

Branch on the exit code:

| Exit | Action |
|---|---|
| `0` | Inspect the ranked files and lines. |
| `3` | Re-pattern: broaden a filter that matched zero tests; narrow one that matched all tests. |
| `2` | Treat the project or invocation as unusable: surface the usage, missing-Vitest, or enabled-coverage refusal. |
| `1` | Treat the run as incomplete: surface stderr, run Vitest directly, and fall back to normal code exploration. |

Respect the evidence boundary: the feature needs tests, module-scope registration code is
unattributable, unverifiable source maps are excluded, and multi-project Vitest configs are
refused.
