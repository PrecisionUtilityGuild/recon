#!/usr/bin/env node
/**
 * recon — feature location by coverage diff for Vitest.
 *
 * Runs the project's suite once with per-test coverage, partitions tests into a
 * feature set (name/file match of the filter) versus the rest, and ranks the
 * lines the feature tests cover most exclusively (`cf / sqrt(F·(cf+cn))`).
 *
 * Exit codes: 0 ranking produced · 1 runtime/internal failure · 2 usage error /
 * missing vitest / coverage conflict · 3 degenerate partition (0 or all tests
 * matched — no baseline).
 */
import { readFileSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RunnerAdapterError, detectRunner, isMultiProject, prepareRunner, type RunnerName } from "./adapters.js";
import { projectRootFrom, type TestRecord } from "./collect.js";
import {
	type FeatureTest,
	type FileRollup,
	type Report,
	type TestTotals,
	formatHuman,
	formatJson,
} from "./format.js";
import { CoverageMapper } from "./map.js";
import { type Counters, type ScoredLine, compareLines, exclusivity } from "./score.js";

interface Options {
	pattern: string;
	json: boolean;
	top: number;
	all: boolean;
	regex: boolean;
	file: boolean; // pattern matches test FILE paths instead of test names
	runner?: RunnerName; // explicit override; otherwise auto-detected
	passthrough: string[];
}

const USAGE = `recon — feature location by coverage diff for Vitest and Jest

Usage: recon [options] "<filter>" [-- <runner args>]

The filter selects the FEATURE tests (case-insensitive substring of each test's
full "suite > name" by default). recon ranks the lines those tests cover most
exclusively versus the rest of the suite.

Options:
  --json            Machine-readable output.
  -n, --top <N>     Number of lines to show (default 15).
  --all             Show every line covered by a feature test.
  --regex           Treat <filter> as a regular expression, not a substring.
  --file <glob>     Match the filter against test FILE paths instead of names.
  --runner <name>   Force runner detection: vitest or jest.
  -h, --help        Show this help.

Everything after \`--\` is passed through to the selected runner (e.g. a file filter).`;

const COVERAGE_REFUSAL =
	"recon: the project's own coverage is enabled (coverage.enabled). Running recon alongside\n" +
	"the v8 coverage provider silently zeroes the official report. Disable coverage and re-run.\n";

const JEST_COVERAGE_REFUSAL =
	"recon: the project's own Jest coverage is enabled (collectCoverage / --coverage). Running\n" +
	"recon alongside it conflicts with per-test coverage collection. Disable coverage and re-run.\n";

// True when a vitest passthrough arg turns coverage on. `--coverage`,
// `--coverage=true`, and any `--coverage.<key>` (e.g. `--coverage.enabled`,
// `--coverage.provider=v8`) all enable it; only an explicit disable
// (`--coverage=false` / `--coverage.enabled=false`) does not.
export function passthroughEnablesCoverage(args: string[]): boolean {
	for (const arg of args) {
		if (arg === "--coverage" || arg === "--coverage=true") return true;
		if (arg.startsWith("--coverage.")) {
			const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : "true";
			if (value !== "false") return true;
		}
	}
	return false;
}

function parseArgs(argv: string[]): Options | { help: true } | { error: string } {
	const opts: Options = { pattern: "", json: false, top: 15, all: false, regex: false, file: false, passthrough: [] };
	let patternSet = false;
	let i = 0;
	while (i < argv.length) {
		const arg = argv[i];
		if (arg === "--") {
			opts.passthrough = argv.slice(i + 1);
			break;
		}
		if (arg === "--json") {
			opts.json = true;
		} else if (arg === "--all") {
			opts.all = true;
		} else if (arg === "--regex") {
			opts.regex = true;
		} else if (arg === "--file") {
			opts.file = true;
		} else if (arg === "--runner") {
			const value = argv[i + 1];
			if (value !== "vitest" && value !== "jest") return { error: `invalid value for --runner: ${value ?? ""}` };
			opts.runner = value;
			i += 1;
		} else if (arg?.startsWith("--runner=")) {
			const value = arg.slice("--runner=".length);
			if (value !== "vitest" && value !== "jest") return { error: `invalid value for --runner: ${value}` };
			opts.runner = value;
		} else if (arg === "-h" || arg === "--help") {
			return { help: true };
		} else if (arg === "-n" || arg === "--top") {
			const value = argv[i + 1];
			if (value == null) return { error: `${arg} requires a number` };
			const n = Number(value);
			if (!Number.isInteger(n) || n <= 0) return { error: `invalid value for ${arg}: ${value}` };
			opts.top = n;
			i += 1;
		} else if (arg?.startsWith("--top=")) {
			const n = Number(arg.slice("--top=".length));
			if (!Number.isInteger(n) || n <= 0) return { error: `invalid value for --top` };
			opts.top = n;
		} else if (arg?.startsWith("-") && arg !== "-") {
			return { error: `unknown option: ${arg}` };
		} else {
			// First bare positional is the filter; a second one is an error.
			if (patternSet) return { error: `unexpected extra argument: ${arg}` };
			opts.pattern = arg ?? "";
			patternSet = true;
		}
		i += 1;
	}
	if (!patternSet) return { error: "missing <filter> — recon needs a feature filter (e.g. recon \"dark mode\")" };
	// Validate a --regex filter up front so a bad pattern is a usage error (exit
	// 2), not a stack trace from deep inside the run. makeMatcher compiles the
	// same RegExp later; catch the SyntaxError here before any suite is started.
	if (opts.regex) {
		try {
			new RegExp(opts.pattern);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			return { error: `invalid --regex ${JSON.stringify(opts.pattern)}: ${detail}` };
		}
	}
	return opts;
}

function rel(root: string, absPath: string): string {
	return relative(root, absPath).split("\\").join("/");
}

// Minimal glob → RegExp: `**` matches across path separators, `*` within a
// segment, `?` a single char. Anchored; matched against forward-slash paths.
export function globToRegExp(glob: string): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i];
		if (ch === "*") {
			if (glob[i + 1] === "*") {
				re += ".*";
				i += 1;
			} else {
				re += "[^/]*";
			}
		} else if (ch === "?") {
			re += "[^/]";
		} else if (ch && "\\^$.|+()[]{}".includes(ch)) {
			re += `\\${ch}`;
		} else {
			re += ch;
		}
	}
	return new RegExp(`^${re}$`);
}

// Does a test record fall in the FEATURE set for these options? By default the
// filter is a case-insensitive substring of the full test name; `--regex` makes
// it a regex over the name; `--file` matches the test file path against the
// filter as a glob (relative path, then a permissive suffix match so a bare
// filename or partial path also works).
function makeMatcher(opts: Options, root: string): (r: TestRecord) => boolean {
	if (opts.file) {
		const re = globToRegExp(opts.pattern);
		return (r) => {
			const path = fileOf(r, root);
			if (re.test(path)) return true;
			// Also accept a match against any trailing path segment sequence, so
			// `--file cli.test.ts` matches `test/cli.test.ts`.
			return path.split("/").some((_, idx) => re.test(path.split("/").slice(idx).join("/")));
		};
	}
	if (opts.regex) {
		const re = new RegExp(opts.pattern);
		return (r) => re.test(r.name);
	}
	const needle = opts.pattern.toLowerCase();
	return (r) => r.name.toLowerCase().includes(needle);
}

function fileOf(r: TestRecord, root: string): string {
	return (r.fileName ?? (r.file ? rel(root, r.file) : r.id)).split("\\").join("/");
}

// Assign T-ids to feature tests, ordered by (test file asc, declaration index).
function orderFeature(records: TestRecord[], root: string): { record: TestRecord; id: string; file: string }[] {
	const taskIndex = (r: TestRecord): number => {
		const m = r.id.match(/_(\d+)$/);
		return m ? Number(m[1]) : 0;
	};
	const sorted = [...records].sort((a, b) => {
		const fa = fileOf(a, root);
		const fb = fileOf(b, root);
		if (fa !== fb) return fa < fb ? -1 : 1;
		return taskIndex(a) - taskIndex(b);
	});
	return sorted.map((record, i) => ({ record, id: `T${i + 1}`, file: fileOf(record, root) }));
}

async function main(): Promise<number> {
	const parsed = parseArgs(process.argv.slice(2));
	if ("error" in parsed) {
		process.stderr.write(`recon: ${parsed.error}\n\n${USAGE}\n`);
		return 2;
	}
	if ("help" in parsed) {
		process.stdout.write(`${USAGE}\n`);
		return 0;
	}
	const opts = parsed;
	const root = projectRootFrom(process.cwd());
	const runner = opts.runner ?? detectRunner(root);

	// Passthrough can turn coverage on even when the project config leaves it off
	// (`recon x -- --coverage`), and collect() forwards passthrough to the runner.
	// The project-config guard below cannot see those flags, so refuse up front.
	if (passthroughEnablesCoverage(opts.passthrough)) {
		process.stderr.write(runner === "jest" ? JEST_COVERAGE_REFUSAL : COVERAGE_REFUSAL);
		return 2;
	}

	let session;
	try {
		session = await prepareRunner(runner, root, opts.passthrough);
	} catch (error) {
		if (error instanceof RunnerAdapterError) {
			process.stderr.write(
				error.kind === "coverage" ? (runner === "jest" ? JEST_COVERAGE_REFUSAL : COVERAGE_REFUSAL) : error.message,
			);
			return error.exitCode;
		}
		throw error;
	}
	try {
		const { records, runnerExit, internalUrls, erroredFiles, incompleteMessage } = session.collected;

		// Runner-positive evidence that the reported universe and the recorded
		// coverage disagree (a Jest per-file environment override or a retry): the
		// universe is incomplete, so any partition would be unreliable — refuse.
		if (incompleteMessage) {
			process.stderr.write(incompleteMessage);
			return 1;
		}

		// Fail loud on incomplete collection — but only on POSITIVE evidence of a
		// collection error, not merely "zero records + nonzero exit". A file that
		// failed to import/compile makes the universe incomplete, so any partition
		// would be unreliable; refuse.
		if (erroredFiles.length > 0) {
			process.stderr.write(
				`recon: ${erroredFiles.length} test file(s) failed to collect (import/config/syntax error), ` +
					"so the run is incomplete and any ranking would be unreliable:\n" +
					erroredFiles.map((f) => `  ${rel(root, f)}\n`).join("") +
					`Run ${runner} directly to see the errors, then re-run recon once they resolve.\n`,
			);
			return 1;
		}

		if (records.length === 0) {
			if (runnerExit === 0) {
				process.stderr.write(
					`recon: ${runner} ran but no tests were collected — nothing to locate.\n` +
						`(Check your test file filter, or run ${runner} directly to confirm tests exist.)\n`,
				);
			} else {
				process.stderr.write(
					`recon: ${runner} exited ${runnerExit} before any per-test coverage was recorded.\n` +
						`The suite likely failed to start (config/import error); run ${runner} directly to see why.\n`,
				);
			}
			return 1;
		}

		// Only tests that actually ran (pass/fail) and were attributable count
		// toward the partition; skipped/todo and overlapping-window records do not.
		const attributable = records.filter(
			(r) => (r.state === "pass" || r.state === "fail") && r.outstanding === 0,
		);
		const unattributable = records.filter(
			(r) => r.outstanding > 0 && (r.state === "pass" || r.state === "fail"),
		).length;
		if (unattributable > 0) {
			process.stderr.write(
				`recon: ${unattributable} test(s) ran with overlapping coverage windows (test.concurrent) and\n` +
					"could not be attributed; their coverage is excluded from the ranking.\n",
			);
		}

		const matcher = makeMatcher(opts, root);
		const featureRecords = attributable.filter(matcher);
		const restRecords = attributable.filter((r) => !matcher(r));
		const F = featureRecords.length;
		const N = restRecords.length;

		// Degenerate partition: the filter matched no tests, or every test. Either
		// way there is no baseline to diff against — name the counts (exit 3) so an
		// agent can branch and re-pattern.
		if (F === 0 || N === 0) {
			const how = opts.file ? "--file glob" : opts.regex ? "regex" : "substring";
			if (F === 0) {
				process.stderr.write(
					`recon: the ${how} ${JSON.stringify(opts.pattern)} matched 0 of ${attributable.length} tests — ` +
						"no feature set to locate.\n(Widen the filter, or run vitest to see the test names.)\n",
				);
			} else {
				process.stderr.write(
					`recon: the ${how} ${JSON.stringify(opts.pattern)} matched all ${attributable.length} tests — ` +
						"no baseline (rest) set to diff against.\n(Narrow the filter so some tests fall outside the feature.)\n",
				);
			}
			return 3;
		}

		const featureOrdered = orderFeature(featureRecords, root);
		const idByTaskId = new Map(featureOrdered.map((f) => [f.record.id, f.id]));
		const featureIds = new Set(featureRecords.map((r) => r.id));

		// Files never ranked: the test files themselves and recon's own runner
		// (both execute during the run but are not the code under test).
		const excludedUrls = new Set(
			records.map((r) => (r.file ? pathToFileURL(r.file).href : undefined)).filter((u): u is string => Boolean(u)),
		);
		for (const url of internalUrls) excludedUrls.add(url);

		const failed = featureRecords.filter((r) => r.state === "fail").length;
		const totals: TestTotals = { total: attributable.length, feature: F, rest: N, failed };

		const ranked = await buildRanking(
			attributable,
			session.mapper,
			excludedUrls,
			featureIds,
			idByTaskId,
			F,
			N,
			root,
			opts,
		);

		if (ranked.untrustedFiles.length > 0) {
			process.stderr.write(
				`recon: could not verify source-map alignment for ${ranked.untrustedFiles.length} file(s); ` +
					"excluded from the ranking to avoid mis-attributing lines:\n" +
					ranked.untrustedFiles.map((f) => `  ${f}\n`).join(""),
			);
		}
		if (ranked.trustedFileCount === 0 && ranked.untrustedFiles.length > 0) {
			process.stderr.write(
				"recon: no source file could be mapped reliably (transform diverged from executed code).\n" +
					"Nothing safe to locate.\n",
			);
			return 1;
		}

		const report: Report = {
			runner: session.runner,
			pattern: opts.pattern,
			totals,
			featureTests: buildFeatureTests(featureOrdered),
			files: ranked.files,
			ranked: ranked.shown,
			totalNonzero: ranked.totalNonzero,
			truncated: ranked.truncated,
		};

		process.stdout.write(opts.json ? formatJson(report) : formatHuman(report));
		return 0;
	} finally {
		await session.close();
	}
}

export { isMultiProject };

function buildFeatureTests(ordered: { record: TestRecord; id: string; file: string }[]): FeatureTest[] {
	return ordered.map((f) => ({ id: f.id, file: f.file, name: f.record.name }));
}

interface RankingResult {
	shown: ScoredLine[];
	files: FileRollup[];
	totalNonzero: number;
	truncated: boolean;
	untrustedFiles: string[]; // relative paths excluded because mapping is unverifiable
	trustedFileCount: number; // distinct source files that mapped cleanly
}

// Per source line: how many feature / rest tests covered it, plus the feature
// test IDs (for the evidence list).
interface LineAccum {
	file: string; // relative path
	line: number;
	cf: number;
	cn: number;
	featureIds: string[];
}

async function buildRanking(
	records: TestRecord[],
	mapper: CoverageMapper,
	excludedUrls: Set<string>,
	featureIds: Set<string>,
	idByTaskId: Map<string, string>,
	F: number,
	N: number,
	root: string,
	opts: Options,
): Promise<RankingResult> {
	const accum = new Map<string, LineAccum>();
	const sourceCache = new Map<string, string[]>();
	const untrustedUrls = new Set<string>();
	const trustedUrls = new Set<string>();

	for (const record of records) {
		const isFeature = featureIds.has(record.id);
		const tid = idByTaskId.get(record.id);
		for (const script of record.coverage) {
			if (excludedUrls.has(script.url)) continue; // never rank test files or the runner
			const result = await mapper.coveredLines(script.url, script.functions);
			if (result.untrusted) {
				untrustedUrls.add(script.url);
				continue;
			}
			if (result.lines.size === 0) continue;
			const mappedSources =
				result.sources.size > 0 ? result.sources : new Map<string, Set<number>>([[script.url, result.lines]]);
			for (const [source, lines] of mappedSources) {
				trustedUrls.add(source);
				const relPath = rel(root, urlToLocalPath(source));
				for (const line of lines) {
					const key = `${relPath}:${line}`;
					let entry = accum.get(key);
					if (!entry) {
						entry = { file: relPath, line, cf: 0, cn: 0, featureIds: [] };
						accum.set(key, entry);
					}
					if (isFeature) {
						entry.cf += 1;
						if (tid) entry.featureIds.push(tid);
					} else {
						entry.cn += 1;
					}
				}
			}
		}
	}

	const scored: ScoredLine[] = [];
	for (const entry of accum.values()) {
		if (entry.cf === 0) continue; // lines no feature test covers never appear
		const counters: Counters = { cf: entry.cf, cn: entry.cn, F, N };
		scored.push({
			file: entry.file,
			line: entry.line,
			source: readSourceLine(sourceCache, root, entry.file, entry.line),
			counters,
			exclusivity: exclusivity(counters),
			featureTestIds: sortFeatureIds(entry.featureIds),
		});
	}

	scored.sort(compareLines);
	const totalNonzero = scored.length;
	const limit = opts.all ? scored.length : opts.top;
	const shown = scored.slice(0, limit);

	const untrustedFiles = [...untrustedUrls]
		.map((u) => rel(root, urlToLocalPath(u)))
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

	return {
		shown,
		files: rollupFiles(shown),
		totalNonzero,
		truncated: shown.length < totalNonzero,
		untrustedFiles,
		trustedFileCount: trustedUrls.size,
	};
}

// Per-file rollup over the SHOWN lines: files ranked by their best line's
// exclusivity (then path asc), each with how many shown lines it contributes.
function rollupFiles(shown: ScoredLine[]): FileRollup[] {
	const byFile = new Map<string, { best: number; count: number }>();
	for (const s of shown) {
		const cur = byFile.get(s.file);
		if (!cur) byFile.set(s.file, { best: s.exclusivity, count: 1 });
		else {
			cur.count += 1;
			if (s.exclusivity > cur.best) cur.best = s.exclusivity;
		}
	}
	return [...byFile.entries()]
		.map(([file, v]) => ({ file, bestScore: v.best, lineCount: v.count }))
		.sort((a, b) => {
			if (a.bestScore !== b.bestScore) return b.bestScore - a.bestScore;
			return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
		});
}

function sortFeatureIds(ids: string[]): string[] {
	return [...new Set(ids)].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

function urlToLocalPath(url: string): string {
	return url.startsWith("file://") ? fileURLToPath(url) : url;
}

function readSourceLine(cache: Map<string, string[]>, root: string, relPath: string, line: number): string {
	let lines = cache.get(relPath);
	if (!lines) {
		try {
			lines = readFileSync(join(root, relPath), "utf8").split("\n");
		} catch {
			lines = [];
		}
		cache.set(relPath, lines);
	}
	return (lines[line - 1] ?? "").trim();
}

// Only run when invoked as the CLI entry point, so the module's pure helpers
// (passthroughEnablesCoverage, globToRegExp) can be imported by tests without a
// real run. argv[1] is realpath'd because npm installs the bin as a
// node_modules/.bin symlink, while import.meta.url carries the resolved path.
function argv1Href(): string | null {
	const argv1 = process.argv[1];
	if (argv1 == null) return null;
	try {
		return pathToFileURL(realpathSync(argv1)).href;
	} catch {
		return pathToFileURL(argv1).href;
	}
}
const invokedDirectly = import.meta.url === argv1Href();
if (invokedDirectly) {
	main()
		.then((code) => {
			process.exitCode = code;
		})
		.catch((err) => {
			process.stderr.write(`recon: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
			process.exitCode = 1;
		});
}
