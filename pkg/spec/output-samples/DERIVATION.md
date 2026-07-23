# Golden derivation — `fixture-basic`

Hand-derived counters for the `theme-project` fixture, the byte-exact contract
behind `fixture-basic.txt` / `.json`. Regenerate the samples with:

```
cd pkg/test/fixtures/theme-project
node ../../../dist/cli.js "dark mode"        > ../../../spec/output-samples/fixture-basic.txt
node ../../../dist/cli.js "dark mode" --json > ../../../spec/output-samples/fixture-basic.json
```

## Fixture

`src/theme.ts` — `applyTheme(mode)` dispatches to `darkTheme()` / `lightTheme()`:

| line | source |
|------|--------|
| L10  | `if (mode === "dark") {` |
| L11  | `return darkTheme();` |
| L19  | `const background = "#000000";` (darkTheme body) |
| L20  | `const foreground = "#e0e0e0";` (darkTheme body) |
| L21  | `return { background, foreground, label: "dark" };` (darkTheme body) |

`test/theme.test.ts` — four tests, partitioned by the substring `"dark mode"`:

- **Feature (F = 2):**
  - T1 `dark mode > dark mode uses a black background` — calls `applyTheme("dark")`
  - T2 `dark mode > dark mode reports the dark label` — calls `darkTheme()` directly
- **Rest (N = 2):**
  - `light mode > light mode uses a white background` — calls `applyTheme("light")`
  - `light mode > light mode reports the light label` — calls `lightTheme()` directly

## Per-line counters and exclusivity

`exclusivity = cf / sqrt(F · (cf + cn))`, with F = 2. A line is dropped when cf = 0.
`[unique]` (JSON `unique: true`) marks cn = 0 — display only, never a sort key.

| line | cf | cn | exclusivity | calc | unique |
|------|----|----|-------------|------|--------|
| L19  | 2  | 0  | 1.0000 | 2 / √(2·2) = 2/2 | yes |
| L20  | 2  | 0  | 1.0000 | 2 / √(2·2) = 2/2 | yes |
| L21  | 2  | 0  | 1.0000 | 2 / √(2·2) = 2/2 | yes |
| L11  | 1  | 0  | 0.7071 | 1 / √(2·1) = 1/√2 | yes |
| L10  | 1  | 1  | 0.5000 | 1 / √(2·2) = 1/2  | no  |

L19/L20/L21 are covered by both T1 (via `applyTheme("dark")`) and T2 (direct
`darkTheme()`), no rest test — perfect exclusivity. L11 is reached only through
`applyTheme("dark")` (T1), so cf = 1; still unique (no rest test dispatches to
dark). L10 is the shared branch: T1 and one light test both execute the `if`.

## Ranking

Ties break by exclusivity desc, cf desc, file asc, line asc. L19/L20/L21 tie at
1.0000 (cf 2) and order by line: 19, 20, 21. Then L11 (0.7071), then L10 (0.5000).

`totalNonzero = 5`, `truncated = false` at the default `-n 15`.
