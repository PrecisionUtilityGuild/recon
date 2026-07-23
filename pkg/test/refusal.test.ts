import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "dist", "cli.js");
const THEME = join(HERE, "fixtures", "theme-project");
const COVERAGE_ON = join(HERE, "fixtures", "coverage-on-project");

const ready = existsSync(CLI) && existsSync(join(HERE, "..", "node_modules", "vitest", "vitest.mjs"));

function run(cwd: string, args: string[]) {
	return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
}

// These do not spawn vitest, so they run even without a built fixture universe.
describe("usage errors (exit 2, no run)", () => {
	test.skipIf(!ready)("missing filter → exit 2 with usage", () => {
		const res = run(THEME, []);
		expect(res.status).toBe(2);
		expect(res.stderr).toContain("missing <filter>");
	});

	test.skipIf(!ready)("`-- --coverage` refuses before running (exit 2)", () => {
		const res = run(THEME, ["dark mode", "--", "--coverage"]);
		expect(res.status).toBe(2);
		expect(res.stderr).toContain("coverage.enabled");
	});

	test.skipIf(!ready)("unknown option → exit 2", () => {
		const res = run(THEME, ["dark mode", "--bogus"]);
		expect(res.status).toBe(2);
		expect(res.stderr).toContain("unknown option");
	});
});

describe.skipIf(!ready)("degenerate partition (exit 3)", () => {
	test("no test matches the filter → exit 3, names the counts", () => {
		const res = run(THEME, ["nonexistent feature xyz"]);
		expect(res.status).toBe(3);
		expect(res.stderr).toContain("matched 0 of 4 tests");
		// stdout carries no ranking.
		expect(res.stdout).toBe("");
	});

	test("every test matches the filter → exit 3 (no baseline)", () => {
		// "mode" is a substring of all four test names.
		const res = run(THEME, ["mode"]);
		expect(res.status).toBe(3);
		expect(res.stderr).toContain("matched all 4 tests");
		expect(res.stdout).toBe("");
	});
});

describe.skipIf(!ready)("project coverage.enabled (exit 2)", () => {
	test("refuses with the silent-zeroing message and no ranking", () => {
		const res = run(COVERAGE_ON, ["triple"]);
		expect(res.status).toBe(2);
		expect(res.stderr).toContain("coverage.enabled");
		expect(res.stdout).toBe("");
	});
});
