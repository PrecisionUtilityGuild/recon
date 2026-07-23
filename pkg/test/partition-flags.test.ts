import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "dist", "cli.js");
const THEME = join(HERE, "fixtures", "theme-project");
const FILE_PART = join(HERE, "fixtures", "file-partition-project");

const ready = existsSync(CLI) && existsSync(join(HERE, "..", "node_modules", "vitest", "vitest.mjs"));

function run(cwd: string, args: string[]) {
	return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
}

describe.skipIf(!ready)("--regex partitions by test name as a regular expression", () => {
	test("regex selects the dark-mode tests and ranks the dark body top", () => {
		const res = run(THEME, ["--regex", "^dark mode", "--json"]);
		expect(res.status).toBe(0);
		const report = JSON.parse(res.stdout);
		expect(report.tests.feature).toBe(2);
		expect(report.tests.rest).toBe(2);
		expect(report.lines[0].line).toBe(19);
		expect(report.lines[0].unique).toBe(true);
	});
});

describe.skipIf(!ready)("--file partitions by test FILE path", () => {
	test("a file glob selects the dark test file and locates darkTheme()", () => {
		const res = run(FILE_PART, ["--file", "dark.test.ts", "--json"]);
		expect(res.status).toBe(0);
		const report = JSON.parse(res.stdout);
		expect(report.tests.feature).toBe(1);
		expect(report.tests.rest).toBe(1);
		expect(report.featureTests[0].file).toBe("test/dark.test.ts");
		// The dark background line is exclusive to the dark test file.
		expect(report.lines[0].source).toContain("#000000");
		expect(report.lines[0].unique).toBe(true);
		// The light-mode source must not surface.
		for (const l of report.lines) expect(l.source).not.toContain("#ffffff");
	});
});
