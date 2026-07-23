/**
 * Output formatting — human (default) and `--json`.
 *
 * Both are deterministic and free of timestamps, durations, and colour. Scores
 * print rounded: human via `toFixed(4)`, JSON via `Math.round(x * 1e4) / 1e4`
 * serialized as a bare number (trailing zeros drop, integers stay bare).
 */
import type { Counters, ScoredLine } from "./score.js";
import { isUnique } from "./score.js";

export interface FeatureTest {
	id: string;
	file: string; // relative test path, forward slashes
	name: string;
}

export interface TestTotals {
	total: number;
	feature: number;
	rest: number;
	failed: number; // feature tests that failed (evidence caveat)
}

// Per-file rollup: files ranked by their best line's exclusivity.
export interface FileRollup {
	file: string; // relative, forward slashes
	bestScore: number;
	lineCount: number; // ranked (nonzero) lines in this file
}

export interface Report {
	runner: "vitest";
	pattern: string; // the raw filter, as the user typed it
	totals: TestTotals;
	featureTests: FeatureTest[];
	files: FileRollup[]; // already ranked, covers the shown lines only
	ranked: ScoredLine[]; // already sorted, already sliced to top-N
	totalNonzero: number;
	truncated: boolean;
}

// JSON number rounding: 4 decimals, natural serialization.
function roundScore(x: number): number {
	return Math.round(x * 1e4) / 1e4;
}

// Human score: fixed 4 decimals.
function humanScore(x: number): string {
	return x.toFixed(4);
}

export function formatHuman(report: Report): string {
	const { totals, featureTests, files, ranked, totalNonzero } = report;
	const lines: string[] = [];
	lines.push(
		`recon · feature: ${JSON.stringify(report.pattern)} · tests: ${totals.total} ` +
			`(${totals.feature} feature, ${totals.rest} rest)`,
	);
	if (totals.failed > 0) {
		lines.push(
			`  caveat: ${totals.failed} feature test(s) failed — the ranking still reflects what they executed.`,
		);
	}
	lines.push("");
	lines.push("feature tests");
	for (const ft of featureTests) {
		lines.push(`  ${ft.id}  ${ft.file} > ${ft.name}`);
	}
	lines.push("");

	// Per-file rollup: "which files" is half the question.
	lines.push("files (ranked by best line)");
	files.forEach((f, i) => {
		lines.push(`  #${i + 1}  ${f.file}  best ${humanScore(f.bestScore)}  (${f.lineCount} line${f.lineCount === 1 ? "" : "s"})`);
	});
	lines.push("");

	// No rankable lines survived: the feature tests matched and ran, but every
	// line they cover was unattributable (commonly module-scope code, which the
	// collector cannot assign to a test — a documented v1 limitation). Say so
	// instead of printing an empty "top 0 lines" table.
	if (totalNonzero === 0) {
		lines.push(
			"no attributable line coverage — the matched feature tests ran but produced no rankable lines.",
		);
		lines.push(
			"  This usually means the feature's footprint is module-scope code (registration, top-level",
		);
		lines.push(
			"  constants), which the collector cannot attribute to a test — a documented v1 limitation.",
		);
		return `${lines.join("\n")}\n`;
	}

	const shown = ranked.length;
	const suffix = report.truncated
		? `top ${shown} lines (of ${totalNonzero} covered by feature tests; ranked by exclusivity)`
		: `top ${shown} lines (all covered by feature tests; ranked by exclusivity)`;
	lines.push(suffix);

	let currentFile: string | null = null;
	let rank = 0;
	for (const s of ranked) {
		rank += 1;
		if (s.file !== currentFile) {
			lines.push("");
			lines.push(s.file);
			currentFile = s.file;
		}
		const evidence = s.featureTestIds.join(" ");
		// cn=0 badge: two spaces + literal "[unique]" appended after the cn field.
		const badge = isUnique(s.counters) ? "  [unique]" : "";
		lines.push(
			`  #${rank}  L${s.line}  exclusivity ${humanScore(s.exclusivity)}  cf ${s.counters.cf}/${s.counters.F} (${evidence})  cn ${s.counters.cn}/${s.counters.N}${badge}`,
		);
		lines.push(`        ${s.source}`);
	}

	return `${lines.join("\n")}\n`;
}

// JSON is emitted by hand to match the golden's mixed layout exactly:
// top-level and per-record objects are pretty-printed at 2-space indent, but
// each line's `counters` object and `featureTests` array stay inline. A stock
// `JSON.stringify(_, null, 2)` cannot express that mix.
function j(value: string | number | boolean): string {
	return JSON.stringify(value);
}

export function formatJson(report: Report): string {
	const { totals, featureTests, files, ranked, totalNonzero, truncated } = report;
	const out: string[] = [];
	out.push("{");
	out.push(`  "version": 1,`);
	out.push(`  "tool": "recon",`);
	out.push(`  "runner": ${j(report.runner)},`);
	out.push(`  "pattern": ${j(report.pattern)},`);
	out.push(`  "tests": {`);
	out.push(`    "total": ${totals.total},`);
	out.push(`    "feature": ${totals.feature},`);
	out.push(`    "rest": ${totals.rest},`);
	out.push(`    "failed": ${totals.failed}`);
	out.push(`  },`);

	if (featureTests.length === 0) {
		out.push(`  "featureTests": [],`);
	} else {
		out.push(`  "featureTests": [`);
		featureTests.forEach((ft, i) => {
			const comma = i === featureTests.length - 1 ? "" : ",";
			out.push(`    {`);
			out.push(`      "id": ${j(ft.id)},`);
			out.push(`      "file": ${j(ft.file)},`);
			out.push(`      "name": ${j(ft.name)}`);
			out.push(`    }${comma}`);
		});
		out.push(`  ],`);
	}

	if (files.length === 0) {
		out.push(`  "files": [],`);
	} else {
		out.push(`  "files": [`);
		files.forEach((f, i) => {
			const comma = i === files.length - 1 ? "" : ",";
			out.push(`    {`);
			out.push(`      "rank": ${i + 1},`);
			out.push(`      "path": ${j(f.file)},`);
			out.push(`      "bestScore": ${j(roundScore(f.bestScore))},`);
			out.push(`      "lineCount": ${f.lineCount}`);
			out.push(`    }${comma}`);
		});
		out.push(`  ],`);
	}

	if (ranked.length === 0) {
		out.push(`  "lines": [],`);
	} else {
		out.push(`  "lines": [`);
		ranked.forEach((s, i) => {
			const comma = i === ranked.length - 1 ? "" : ",";
			const inlineTests = `[${s.featureTestIds.map((id) => j(id)).join(", ")}]`;
			const c = s.counters;
			const inlineCounters = `{ "cf": ${c.cf}, "cn": ${c.cn}, "F": ${c.F}, "N": ${c.N} }`;
			out.push(`    {`);
			out.push(`      "rank": ${i + 1},`);
			out.push(`      "file": ${j(s.file)},`);
			out.push(`      "line": ${s.line},`);
			out.push(`      "source": ${j(s.source)},`);
			out.push(`      "exclusivity": ${j(roundScore(s.exclusivity))},`);
			out.push(`      "counters": ${inlineCounters},`);
			out.push(`      "featureTests": ${inlineTests},`);
			out.push(`      "unique": ${isUnique(c)}`);
			out.push(`    }${comma}`);
		});
		out.push(`  ],`);
	}

	out.push(`  "totalNonzero": ${totalNonzero},`);
	out.push(`  "truncated": ${truncated}`);
	out.push("}");
	return `${out.join("\n")}\n`;
}
