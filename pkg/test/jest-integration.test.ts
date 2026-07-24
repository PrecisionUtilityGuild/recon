import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "dist", "cli.js");
const FIXTURES = join(HERE, "fixtures");
const SAMPLES = join(HERE, "..", "spec", "output-samples");
const ready = existsSync(CLI) && existsSync(join(HERE, "..", "node_modules", "jest"));

function run(fixture: string, args: string[] = []) {
	return spawnSync(process.execPath, [CLI, ...args], {
		cwd: join(FIXTURES, fixture),
		encoding: "utf8",
	});
}

describe.skipIf(!ready)("Jest runner adapter", () => {
	test("auto-detects Jest and ranks the dark-mode body lines top with exit 0", () => {
		const result = run("jest-basic", ["dark mode", "--json"]);
		expect(result.status).toBe(0);
		const report = JSON.parse(result.stdout);
		expect(report.runner).toBe("jest");
		expect(report.tests).toEqual({ total: 4, feature: 2, rest: 2, failed: 0 });
		expect(report.files[0]).toEqual({ rank: 1, path: "src/theme.js", bestScore: 1, lineCount: 5 });
		// The darkTheme() body is covered by both feature tests and no rest test.
		const top = report.lines[0];
		expect(top).toMatchObject({ file: "src/theme.js", line: 13, exclusivity: 1, unique: true });
		expect(top.counters).toEqual({ cf: 2, cn: 0, F: 2, N: 2 });
		// The shared dispatch line ranks last, is shared, and is not unique.
		const dispatch = report.lines.find((l: { line: number }) => l.line === 4);
		expect(dispatch.exclusivity).toBe(0.5);
		expect(dispatch.unique).toBe(false);
		expect(result.stderr).not.toContain("overlapping coverage windows");
	});

	test("human and --json output are byte-identical to the committed goldens", () => {
		const human = run("jest-basic", ["dark mode"]);
		expect(human.status).toBe(0);
		expect(human.stdout).toBe(readFileSync(join(SAMPLES, "fixture-jest-basic.txt"), "utf8"));

		const json = run("jest-basic", ["dark mode", "--json"]);
		expect(json.status).toBe(0);
		expect(json.stdout).toBe(readFileSync(join(SAMPLES, "fixture-jest-basic.json"), "utf8"));
	});

	test("output is byte-identical across runs (deterministic)", () => {
		const a = run("jest-basic", ["dark mode", "--json"]);
		const b = run("jest-basic", ["dark mode", "--json"]);
		expect(a.stdout).toBe(b.stdout);
	});

	test("maps Babel-transformed TypeScript coverage to the original .ts line", () => {
		const result = run("jest-transformed", ["dark mode", "--runner", "jest", "--json"]);
		expect(result.status).toBe(0);
		const report = JSON.parse(result.stdout);
		expect(report.runner).toBe("jest");
		expect(report.files[0].path).toBe("src/theme.ts");
		// darkTheme()'s body line in the ORIGINAL TypeScript, not the transformed JS.
		expect(report.lines[0]).toMatchObject({ file: "src/theme.ts", line: 13, exclusivity: 1 });
	});

	test("refuses Jest projects configs with exit 1", () => {
		const result = run("jest-projects", ["dark mode"]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Jest projects config");
		expect(result.stdout).toBe("");
	});

	test("refuses a project-owned Jest coverage configuration with exit 2", () => {
		const result = run("jest-coverage", ["dark mode"]);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("coverage");
		expect(result.stdout).toBe("");
	});

	test("refuses a configured custom Jest environment before running (exit 2)", () => {
		const result = run("jest-docblock", ["dark mode", "--runner", "jest", "--", "--config", "custom.config.cjs"]);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("custom/non-Node test environment");
		expect(result.stdout).toBe("");
	});

	test("refuses an incomplete run when a docblock environment bypasses instrumentation (exit 1)", () => {
		const result = run("jest-docblock", ["dark mode", "--runner", "jest"]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("per-file environment override or test retry");
		expect(result.stdout).toBe("");
	});

	test("refuses a non-circus Jest runner before running (exit 2)", () => {
		const result = run("jest-docblock", ["dark mode", "--runner", "jest", "--", "--config", "runner.config.cjs"]);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("does not use jest-circus");
		expect(result.stdout).toBe("");
	});

	test("refuses retry attempts that cannot be represented one-to-one (exit 1)", () => {
		const result = run("jest-retry", ["passes", "--runner", "jest"]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("test retry");
		expect(result.stdout).toBe("");
	});
});
