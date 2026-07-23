import { describe, expect, test } from "vitest";
import { formatHuman, formatJson, type Report } from "../src/format.js";
import { type Counters, compareLines, exclusivity, isUnique, type ScoredLine } from "../src/score.js";

describe("exclusivity", () => {
	test("is 1.0 when every feature test and no other test covers the line", () => {
		// cf === F, cn === 0 → 2 / sqrt(2 * 2) = 1
		expect(exclusivity({ cf: 2, cn: 0, F: 2, N: 2 })).toBe(1);
	});

	test("degrades toward 0 as coverage is shared with the rest", () => {
		// cf=1, cn=1, F=2 → 1 / sqrt(2 * 2) = 0.5
		expect(exclusivity({ cf: 1, cn: 1, F: 2, N: 2 })).toBe(0.5);
	});

	test("partial feature coverage lowers the score even when unique", () => {
		// cf=1, cn=0, F=2 → 1 / sqrt(2 * 1) = 0.70710678...
		expect(exclusivity({ cf: 1, cn: 0, F: 2, N: 2 })).toBeCloseTo(0.7071068, 6);
	});

	test("matches the derivation for a shared utility line (low score)", () => {
		// cf=1, cn=9, F=3 → 1 / sqrt(3 * 10) = 0.18257...
		expect(exclusivity({ cf: 1, cn: 9, F: 3, N: 9 })).toBeCloseTo(0.1825742, 6);
	});

	test("is 0 when the denominator is zero (no feature tests)", () => {
		expect(exclusivity({ cf: 0, cn: 3, F: 0, N: 5 })).toBe(0);
	});
});

describe("unique badge (cn === 0)", () => {
	test("true when no non-feature test covers the line", () => {
		expect(isUnique({ cf: 2, cn: 0, F: 2, N: 2 })).toBe(true);
	});

	test("false when a non-feature test also covers the line", () => {
		expect(isUnique({ cf: 2, cn: 1, F: 2, N: 2 })).toBe(false);
	});
});

describe("tie ordering (exclusivity primary)", () => {
	const make = (line: number, x: number, cf: number, cn = 0, file = "src/theme.ts"): ScoredLine => ({
		file,
		line,
		source: "",
		counters: { cf, cn, F: cf, N: 1 },
		exclusivity: x,
		featureTestIds: [],
	});

	test("higher exclusivity wins", () => {
		const a = make(20, 1.0, 2);
		const b = make(10, 0.5, 1);
		expect([b, a].sort(compareLines)[0]).toBe(a);
	});

	test("cf desc is the first tie-break when exclusivity ties", () => {
		const a = make(20, 0.7071, 3); // higher cf
		const b = make(10, 0.7071, 1); // lower cf
		expect([b, a].sort(compareLines)[0]).toBe(a);
	});

	test("file path asc breaks a cf tie", () => {
		const a = make(5, 0.7071, 2, 0, "src/a.ts");
		const b = make(5, 0.7071, 2, 0, "src/b.ts");
		expect([b, a].sort(compareLines).map((s) => s.file)).toEqual(["src/a.ts", "src/b.ts"]);
	});

	test("identical spectra in the same file break ties by line ascending", () => {
		const a = make(21, 1.0, 2);
		const b = make(19, 1.0, 2);
		expect([a, b].sort(compareLines).map((s) => s.line)).toEqual([19, 21]);
	});

	test("the [unique] badge is NOT a sort key — a unique low score sorts below a shared high score", () => {
		// unique (cn=0) but partial feature coverage → 0.7071
		const unique = make(11, 0.7071, 1, 0);
		// shared (cn>0) but full feature coverage → 0.8
		const shared = make(9, 0.8, 2, 1);
		expect([unique, shared].sort(compareLines)[0]).toBe(shared);
	});
});

describe("json encoding", () => {
	const report = (line: number, x: number, c: Counters): Report => ({
		runner: "vitest",
		pattern: "dark mode",
		totals: { total: 4, feature: 2, rest: 2, failed: 0 },
		featureTests: [{ id: "T1", file: "test/theme.test.ts", name: "dark mode" }],
		files: [{ file: "src/theme.ts", bestScore: x, lineCount: 1 }],
		ranked: [
			{ file: "src/theme.ts", line, source: "return dark();", counters: c, exclusivity: x, featureTestIds: ["T1"] },
		],
		totalNonzero: 1,
		truncated: false,
	});

	test("exclusivity of 1 serializes bare (trailing zeros drop)", () => {
		const json = formatJson(report(19, 1, { cf: 2, cn: 0, F: 2, N: 2 }));
		expect(json).toContain('"exclusivity": 1,');
	});

	test("exclusivity rounds to 4 decimals", () => {
		const json = formatJson(report(11, 0.70710678, { cf: 1, cn: 0, F: 2, N: 2 }));
		expect(json).toContain('"exclusivity": 0.7071,');
	});

	test("counters render inline with cf/cn/F/N", () => {
		const json = formatJson(report(10, 0.5, { cf: 1, cn: 1, F: 2, N: 2 }));
		expect(json).toContain('"counters": { "cf": 1, "cn": 1, "F": 2, "N": 2 },');
	});

	test("unique boolean follows the featureTests refs", () => {
		const json = formatJson(report(19, 1, { cf: 2, cn: 0, F: 2, N: 2 }));
		expect(json).toContain('"featureTests": ["T1"],\n      "unique": true');
	});

	test("unique is false when cn > 0", () => {
		const json = formatJson(report(10, 0.5, { cf: 1, cn: 1, F: 2, N: 2 }));
		expect(json).toContain('"unique": false');
	});

	test("top-level identity fields are recon/version 1", () => {
		const json = formatJson(report(19, 1, { cf: 2, cn: 0, F: 2, N: 2 }));
		expect(json).toContain('"version": 1,');
		expect(json).toContain('"tool": "recon",');
		expect(json).toContain('"pattern": "dark mode",');
	});
});

describe("human encoding", () => {
	function oneLineReport(c: Counters, x: number): Report {
		return {
			runner: "vitest",
			pattern: "dark mode",
			totals: { total: 4, feature: 2, rest: 2, failed: 0 },
			featureTests: [{ id: "T1", file: "test/theme.test.ts", name: "dark mode" }],
			files: [{ file: "src/theme.ts", bestScore: x, lineCount: 1 }],
			ranked: [
				{ file: "src/theme.ts", line: 19, source: "return dark();", counters: c, exclusivity: x, featureTestIds: ["T1"] },
			],
			totalNonzero: 1,
			truncated: false,
		};
	}

	test("header brands as recon with the feature filter and partition counts", () => {
		const out = formatHuman(oneLineReport({ cf: 2, cn: 0, F: 2, N: 2 }, 1));
		expect(out.startsWith('recon · feature: "dark mode" · tests: 4 (2 feature, 2 rest)')).toBe(true);
	});

	test("scores render with 4 decimals", () => {
		const out = formatHuman(oneLineReport({ cf: 1, cn: 0, F: 2, N: 2 }, 0.70710678));
		expect(out).toContain("exclusivity 0.7071");
	});

	test("line appends '  [unique]' after the cn field when cn === 0", () => {
		const out = formatHuman(oneLineReport({ cf: 2, cn: 0, F: 2, N: 2 }, 1));
		// cf 2/2 (T1)  cn 0/2  [unique]
		expect(out).toContain("cn 0/2  [unique]");
	});

	test("line has no badge when cn > 0", () => {
		const out = formatHuman(oneLineReport({ cf: 1, cn: 1, F: 2, N: 2 }, 0.5));
		expect(out).not.toContain("[unique]");
	});

	test("a failed feature test surfaces the evidence caveat", () => {
		const r = oneLineReport({ cf: 2, cn: 0, F: 2, N: 2 }, 1);
		r.totals.failed = 1;
		expect(formatHuman(r)).toContain("caveat: 1 feature test(s) failed");
	});
});
