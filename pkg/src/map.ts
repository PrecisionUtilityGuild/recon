/**
 * Maps per-test V8 coverage (byte offsets into the executed module) back to
 * original source lines, using the same pipeline vitest's own coverage-v8
 * provider uses: vite SSR transform + `ast-v8-to-istanbul`. Copied verbatim
 * from culprits' collector (the family substrate) — the mapping is independent
 * of what recon does with the resulting lines.
 *
 * The V8 offsets index into the vite SSR module-runner's *wrapped* source
 * (`'use strict';async (...) => {{ ...module... }}`). `ast-v8-to-istanbul`
 * wants the *unwrapped* transform output as `code`/`ast` plus a `wrapperLength`
 * it adds to AST node offsets. We recover `wrapperLength` by locating the
 * transform output inside the exact executed source the runner captured.
 */
import astV8ToIstanbul from "ast-v8-to-istanbul";
import { fileURLToPath } from "node:url";

// Structural subset of istanbul's CoverageMapData that we read — avoids a
// runtime/type dependency on istanbul-lib-coverage.
interface StatementLoc {
	start: { line: number | null; column: number | null };
	end: { line: number | null; column: number | null };
}
interface FileCoverageData {
	statementMap: Record<string, StatementLoc>;
	s: Record<string, number>;
}
type CoverageMapData = Record<string, FileCoverageData>;

interface V8Function {
	functionName: string;
	ranges: { startOffset: number; endOffset: number; count: number }[];
	isBlockCoverage: boolean;
}

// Minimal shape of the vitest node API we depend on.
interface TransformResult {
	code: string;
	// biome-ignore lint/suspicious/noExplicitAny: vite's encoded source map shape
	map?: any;
}

export interface TransformBridge {
	transform(url: string): Promise<TransformResult | null>;
	// biome-ignore lint/suspicious/noExplicitAny: estree Program from vitest's parseAst
	parseAst(code: string): Promise<any>;
}

// Per source file: everything needed to convert any test's coverage for it.
interface PreparedFile {
	url: string;
	absPath: string;
	code: string;
	// biome-ignore lint/suspicious/noExplicitAny: estree Program
	ast: any;
	// biome-ignore lint/suspicious/noExplicitAny: encoded source map
	sourceMap: any;
	wrapperLength: number;
}

const WRAPPER_PROBE_LEN = 64;

// Recover the module-runner wrapper length by finding where the CLI-side
// transform output begins inside the exact source the isolate executed (the
// source the V8 offsets index into).
//
// Returns null = UNTRUSTED: the executed source could not be verified against
// the transform output, so V8 offsets cannot be safely shifted and the file's
// lines must not be ranked. This happens when no source was captured, or when
// the executed source diverges from our transform (vite plugins, define/env
// replacement) so the probe is not found. A verified wrapperLength (including a
// genuine 0 when the executed source starts with the transform output) is the
// only trusted result.
function deriveWrapperLength(executedSource: string | undefined, transformCode: string): number | null {
	if (!executedSource) return null;
	if (transformCode.length === 0) {
		// Empty module: trust only if the executed source is also empty-ish.
		return executedSource.length === 0 ? 0 : null;
	}
	const probe = transformCode.slice(0, Math.min(WRAPPER_PROBE_LEN, transformCode.length));
	let idx = executedSource.indexOf(probe);
	while (idx >= 0) {
		if (executedSource.slice(idx, idx + transformCode.length) === transformCode) {
			// More than one full match is ambiguous: offsets could refer to either.
			if (executedSource.indexOf(transformCode, idx + 1) >= 0) return null;
			return idx; // idx === 0 is a genuinely unwrapped module (verified)
		}
		idx = executedSource.indexOf(probe, idx + 1);
	}
	return null; // divergent transform — untrusted
}

// Result of mapping one test's coverage for one file.
// - untrusted: the file's offset->line mapping could not be verified, so its
//   lines must NOT be ranked (caller warns once and excludes the file).
export interface CoveredLinesResult {
	lines: Set<number>;
	sources: Map<string, Set<number>>;
	untrusted: boolean;
}

// A file that was transformed but whose wrapper length could not be verified.
const UNTRUSTED = Symbol("untrusted");
type PrepareOutcome = PreparedFile | null | typeof UNTRUSTED;

export class CoverageMapper {
	private prepared = new Map<string, PrepareOutcome>();

	constructor(
		private bridge: TransformBridge,
		private executedSources: Map<string, string>,
	) {}

	// Idempotently transform + parse a source URL. Returns null when the file
	// cannot be transformed at all, UNTRUSTED when it transforms but the executed
	// source cannot be verified against it (offsets would be unsafe to shift).
	private async prepare(url: string): Promise<PrepareOutcome> {
		const cached = this.prepared.get(url);
		if (cached !== undefined) return cached;

		let prepared: PrepareOutcome = null;
		try {
			const transform = await this.bridge.transform(url);
			if (transform?.code != null) {
				const wrapperLength = deriveWrapperLength(this.executedSources.get(url), transform.code);
				if (wrapperLength === null) {
					prepared = UNTRUSTED;
				} else {
					const map = transform.map;
					if (map) {
						// Resolve source map sources to absolute URLs (vitest does the same).
						map.sources = (map.sources ?? [])
							.filter((s: unknown) => s != null)
							.map((s: string) => new URL(s, url).href);
						if (map.sources.length === 0) map.sources.push(url);
					}
					const ast = await this.bridge.parseAst(transform.code);
					prepared = {
						url,
						absPath: fileURLToPath(url),
						code: transform.code,
						ast,
						sourceMap: map,
						wrapperLength,
					};
				}
			}
		} catch {
			prepared = UNTRUSTED;
		}
		this.prepared.set(url, prepared);
		return prepared;
	}

	// Convert one test's coverage for one script into the set of original source
	// lines it executed (any statement on the line with a nonzero hit count).
	// Flags the file as untrusted when its mapping could not be verified.
	async coveredLines(url: string, functions: V8Function[]): Promise<CoveredLinesResult> {
		const file = await this.prepare(url);
		const lines = new Set<number>();
		const sources = new Map<string, Set<number>>();
		if (file === null) return { lines, sources, untrusted: false };
		if (file === UNTRUSTED) return { lines, sources, untrusted: true };

		let coverage: CoverageMapData;
		try {
			coverage = (await astV8ToIstanbul({
				code: file.code,
				sourceMap: file.sourceMap,
				ast: file.ast,
				coverage: { functions, url: file.url },
				wrapperLength: file.wrapperLength,
			})) as unknown as CoverageMapData;
		} catch {
			return { lines, sources, untrusted: true };
		}

		for (const [source, data] of Object.entries(coverage)) {
			const sourceLines = new Set<number>();
			for (const [id, loc] of Object.entries(data.statementMap)) {
				if ((data.s[id] ?? 0) > 0 && loc.start.line != null) {
					lines.add(loc.start.line);
					sourceLines.add(loc.start.line);
				}
			}
			if (sourceLines.size > 0) sources.set(source, sourceLines);
		}
		return { lines, sources, untrusted: false };
	}
}
