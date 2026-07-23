import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "dist", "cli.js");
const THEME = join(HERE, "fixtures", "theme-project");

// The theme fixture nests under pkg/, so `vitest` resolves via node's walk-up to
// pkg/node_modules — no per-fixture install needed. Skipped (not failed) if the
// CLI is not built yet, so the pure unit suite still runs in isolation.
const ready = existsSync(CLI) && existsSync(join(HERE, "..", "node_modules", "vitest", "vitest.mjs"));

function runRecon(args: string[]) {
	return spawnSync(process.execPath, [CLI, ...args], { cwd: THEME, encoding: "utf8" });
}

// Golden: applyTheme dispatches to darkTheme()/lightTheme(). The two "dark mode"
// tests exercise the dark branch exclusively, so darkTheme()'s body lines are
// covered by ALL feature tests and NO rest test — exclusivity 1.0, [unique].
// The shared `if (mode === "dark")` dispatch is covered by both partitions, so
// it scores lowest. Hand-derived counters (F=2, N=2):
//   L19/20/21 darkTheme() body : cf=2 cn=0 → 2/sqrt(2·2) = 1.0     [unique]
//   L11 return darkTheme()      : cf=1 cn=0 → 1/sqrt(2·1) = 0.7071 [unique]
//   L10 if (mode === "dark")    : cf=1 cn=1 → 1/sqrt(2·2) = 0.5
describe.skipIf(!ready)("golden: dark-mode feature location", () => {
	test("human output ranks the dark-mode body lines top with exit 0", () => {
		const res = runRecon(["dark mode"]);
		expect(res.status).toBe(0);

		expect(res.stdout).toContain('recon · feature: "dark mode" · tests: 4 (2 feature, 2 rest)');
		expect(res.stdout).toContain("T1  test/theme.test.ts > dark mode > dark mode uses a black background");
		expect(res.stdout).toContain("T2  test/theme.test.ts > dark mode > dark mode reports the dark label");

		// Per-file rollup: the feature lives in src/theme.ts, best score 1.0.
		expect(res.stdout).toContain("#1  src/theme.ts  best 1.0000");

		// The three darkTheme() body lines are the top ranks with the unique badge.
		expect(res.stdout).toContain('#1  L19  exclusivity 1.0000  cf 2/2 (T1 T2)  cn 0/2  [unique]');
		expect(res.stdout).toContain('const background = "#000000";');
		expect(res.stdout).toContain('#4  L11  exclusivity 0.7071  cf 1/2 (T1)  cn 0/2  [unique]');
		// The shared dispatch line scores lowest and carries NO unique badge.
		expect(res.stdout).toContain('#5  L10  exclusivity 0.5000  cf 1/2 (T1)  cn 1/2');
		expect(res.stdout).not.toContain("#5  L10  exclusivity 0.5000  cf 1/2 (T1)  cn 1/2  [unique]");

		// A light-mode source line must never appear — no feature test covers it.
		expect(res.stdout).not.toContain('#ffffff');
	});

	test("--json emits the same ranking in the machine contract", () => {
		const res = runRecon(["dark mode", "--json"]);
		expect(res.status).toBe(0);
		const report = JSON.parse(res.stdout);

		expect(report.version).toBe(1);
		expect(report.tool).toBe("recon");
		expect(report.runner).toBe("vitest");
		expect(report.pattern).toBe("dark mode");
		expect(report.tests).toEqual({ total: 4, feature: 2, rest: 2, failed: 0 });

		expect(report.files[0]).toEqual({ rank: 1, path: "src/theme.ts", bestScore: 1, lineCount: 5 });

		const top = report.lines[0];
		expect(top.line).toBe(19);
		expect(top.exclusivity).toBe(1);
		expect(top.counters).toEqual({ cf: 2, cn: 0, F: 2, N: 2 });
		expect(top.featureTests).toEqual(["T1", "T2"]);
		expect(top.unique).toBe(true);

		// The dispatch line ranks last, is shared, and is not unique.
		const dispatch = report.lines.find((l: { line: number }) => l.line === 10);
		expect(dispatch.exclusivity).toBe(0.5);
		expect(dispatch.counters).toEqual({ cf: 1, cn: 1, F: 2, N: 2 });
		expect(dispatch.unique).toBe(false);

		expect(report.totalNonzero).toBe(5);
		expect(report.truncated).toBe(false);
	});

	test("output is byte-identical across runs (deterministic)", () => {
		const a = runRecon(["dark mode", "--json"]);
		const b = runRecon(["dark mode", "--json"]);
		expect(a.stdout).toBe(b.stdout);
	});

	test("-n limits the ranking and marks it truncated", () => {
		const res = runRecon(["dark mode", "-n", "2", "--json"]);
		expect(res.status).toBe(0);
		const report = JSON.parse(res.stdout);
		expect(report.lines).toHaveLength(2);
		expect(report.truncated).toBe(true);
		expect(report.totalNonzero).toBe(5);
	});
});
