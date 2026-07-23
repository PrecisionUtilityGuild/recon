/**
 * Exclusivity counters and the feature-location ranking score.
 *
 * Per line: cf/cn = feature / non-feature tests covering it; F/N = total feature
 * / rest tests in the partition. Exclusivity (the primary and only ranking key)
 * is the Ochiai transplant with feature tests in the "failing" role:
 *
 *   exclusivity = cf / sqrt(F * (cf + cn))
 *
 * It is 1.0 exactly when every feature test and no other test covers the line
 * (cf === F, cn === 0), and degrades smoothly as coverage is shared. Lines with
 * cf === 0 never appear (the caller drops them). Lines with cn === 0 carry a
 * `[unique]` badge — Wilde & Scully's "uniquely involved" set — a display marker
 * only, never a sort key or filter.
 */

export interface Counters {
	cf: number; // feature tests covering this line
	cn: number; // non-feature (rest) tests covering this line
	F: number; // total feature tests in the partition
	N: number; // total rest tests in the partition
}

// exclusivity = cf / sqrt(F * (cf + cn)). Zero when the denominator is zero
// (no feature tests, or cf === cn === 0) — such lines are dropped upstream.
export function exclusivity(c: Counters): number {
	const denom = Math.sqrt(c.F * (c.cf + c.cn));
	if (denom === 0) return 0;
	return c.cf / denom;
}

// A line covered by NO non-feature test (cn === 0): the "uniquely involved" set.
// Display-only marker — never a sort key or filter.
export function isUnique(c: Counters): boolean {
	return c.cn === 0;
}

export interface ScoredLine {
	file: string; // relative to project root, forward slashes
	line: number;
	source: string; // trimmed original source
	counters: Counters;
	exclusivity: number;
	featureTestIds: string[]; // sorted by id order (T1, T2, ...)
}

// Total order (contract): exclusivity desc, then cf desc, then file path asc,
// then line asc. The `[unique]` badge is display-only and never participates.
export function compareLines(a: ScoredLine, b: ScoredLine): number {
	if (a.exclusivity !== b.exclusivity) return b.exclusivity - a.exclusivity;
	if (a.counters.cf !== b.counters.cf) return b.counters.cf - a.counters.cf;
	if (a.file !== b.file) return a.file < b.file ? -1 : 1;
	return a.line - b.line;
}
