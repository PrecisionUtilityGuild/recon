/**
 * Vitest custom test runner that records per-test V8 precise coverage.
 * Copied from culprits (the family substrate); the mechanism is identical —
 * recon partitions the resulting per-test records instead of classifying by
 * pass/fail.
 *
 * Injected via a synthetic `--config` that extends the project's own config and
 * sets `test.runner` to the compiled version of this file. Runs inside each
 * vitest worker (thread or fork). For every task it snapshots
 * `Profiler.takePreciseCoverage` before and after the task body.
 *
 * `takePreciseCoverage` is incremental — each call resets the isolate's
 * counters — so the before-hook take flushes between-test activity (imports,
 * the previous test's teardown) and the after-hook take alone is exactly this
 * test's coverage. No diffing of cumulative snapshots.
 *
 * Records are appended as JSONL to `RECON_OUT_DIR` (one file per worker). The
 * exact source text each V8 offset indexes into (the vite SSR module-runner
 * wrapper included) is captured once per script via `Debugger.getScriptSource`
 * and written to `RECON_OUT_DIR/sources`. The main CLI process reads both back,
 * transforms each source file through vitest's own pipeline, derives the
 * wrapper length, and maps the V8 byte offsets to original source lines.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { threadId } from "node:worker_threads";

// Resolve the vitest base runner class across vitest versions:
//   - 4.1+: `TestRunner` from the package root (non-deprecated).
//   - 4.0.x: only `VitestTestRunner` from 'vitest/runners' exists; the root
//     `TestRunner` export is undefined there. That path prints a deprecation
//     warning, which is acceptable on old versions we still support (peer
//     dependency is `vitest >=4`).
// Both are the same class; we extend whichever exists. Dynamic import + top-level
// await is fine — this module is ESM and loaded by vitest itself.
// biome-ignore lint/suspicious/noExplicitAny: the base runner class type varies by vitest version
export async function resolveTestRunnerBase(load: (specifier: string) => Promise<any>): Promise<any> {
	const root = await load("vitest").catch(() => null);
	if (root && typeof root.TestRunner === "function") return root.TestRunner;
	const runners = await load("vitest/runners");
	if (runners && typeof runners.VitestTestRunner === "function") return runners.VitestTestRunner;
	throw new Error(
		"recon: could not resolve vitest's TestRunner base class (expected 'TestRunner' from 'vitest' or " +
			"'VitestTestRunner' from 'vitest/runners'). Is a supported vitest (>=4) installed?",
	);
}

const TestRunnerBase = await resolveTestRunnerBase((specifier) => import(specifier));

// Structural types for what we consume off a vitest Task — kept local so the
// runner does not hard-depend on @vitest/runner's evolving type surface.
interface RunnerSuite {
	name?: string;
	suite?: RunnerSuite;
	type?: string;
}

interface RunnerTask {
	id: string;
	name: string;
	mode?: string;
	concurrent?: boolean;
	file?: { name?: string; filepath?: string };
	result?: { state?: string };
	suite?: RunnerSuite;
}

interface V8Range {
	startOffset: number;
	endOffset: number;
	count: number;
}

interface V8Function {
	functionName: string;
	ranges: V8Range[];
	isBlockCoverage: boolean;
}

interface V8ScriptCoverage {
	url: string;
	functions: V8Function[];
}

type Snapshot = Map<string, V8ScriptCoverage>;

function isRelevantUrl(url: string): boolean {
	if (!url.startsWith("file://")) return false;
	if (url.includes("/node_modules/")) return false;
	return true;
}

// Full "describe > describe > test" name, matching vitest's report labels. This
// is the string recon's partition pattern matches against.
function fullName(test: RunnerTask): string {
	const parts: string[] = [];
	let suite: RunnerSuite | undefined = test.suite;
	while (suite && suite.name) {
		parts.unshift(suite.name);
		suite = suite.suite;
	}
	parts.push(test.name);
	return parts.join(" > ");
}

export default class ReconCoverageRunner extends TestRunnerBase {
	private session: Session | null = null;
	private baselines = new Map<string, Snapshot>();
	private scriptIds = new Map<string, string>(); // scriptId -> url
	private capturedSources = new Set<string>(); // urls already dumped
	private outFile: string;
	private sourcesDir: string;

	// biome-ignore lint/suspicious/noExplicitAny: vitest passes its own config shape
	constructor(config: any) {
		super(config);
		const outDir = process.env.RECON_OUT_DIR;
		if (!outDir) {
			throw new Error("RECON_OUT_DIR is not set — recon runner used outside recon");
		}
		this.sourcesDir = join(outDir, "sources");
		mkdirSync(this.sourcesDir, { recursive: true });
		this.outFile = join(outDir, `cov-${process.pid}-${threadId}.jsonl`);
	}

	private async ensureSession(): Promise<Session> {
		if (!this.session) {
			const session = new Session();
			session.connect();
			session.on("Debugger.scriptParsed", (msg) => {
				const url = msg.params.url;
				if (url && isRelevantUrl(url)) {
					this.scriptIds.set(msg.params.scriptId, url);
				}
			});
			await session.post("Debugger.enable");
			await session.post("Profiler.enable");
			await session.post("Profiler.startPreciseCoverage", {
				callCount: true,
				detailed: true,
			});
			this.session = session;
		}
		return this.session;
	}

	private async snapshot(): Promise<Snapshot> {
		const session = await this.ensureSession();
		const { result } = await session.post("Profiler.takePreciseCoverage");
		const snap: Snapshot = new Map();
		for (const script of result) {
			if (!isRelevantUrl(script.url)) continue;
			snap.set(script.url, {
				url: script.url,
				functions: script.functions.map((fn) => ({
					functionName: fn.functionName,
					isBlockCoverage: fn.isBlockCoverage,
					ranges: fn.ranges.map((r) => ({
						startOffset: r.startOffset,
						endOffset: r.endOffset,
						count: r.count,
					})),
				})),
			});
		}
		return snap;
	}

	// Dump the exact executed source (with the module-runner wrapper) that the
	// V8 offsets index into, once per URL. Written as a sidecar JSON keyed by a
	// hash of the URL so the main process can pair it with the transform output.
	private async captureSources(urls: Iterable<string>): Promise<void> {
		const session = await this.ensureSession();
		const wanted = new Set(urls);
		for (const [scriptId, url] of this.scriptIds) {
			if (!wanted.has(url) || this.capturedSources.has(url)) continue;
			try {
				const { scriptSource } = await session.post("Debugger.getScriptSource", { scriptId });
				const hash = createHash("sha1").update(url).digest("hex").slice(0, 16);
				writeFileSync(join(this.sourcesDir, `${hash}.json`), JSON.stringify({ url, source: scriptSource }));
				this.capturedSources.add(url);
			} catch {
				// script may have been collected; skip — main process falls back.
			}
		}
	}

	// `override` is omitted because the base class is resolved dynamically (its
	// TS type is `any`); these still override the vitest hooks at runtime.
	async onBeforeRunTask(test: RunnerTask): Promise<void> {
		const snap = await this.snapshot();
		this.baselines.set(test.id, snap);
		// biome-ignore lint/suspicious/noExplicitAny: super signature is vitest's Task
		await super.onBeforeRunTask(test as any);
	}

	async onAfterRunTask(test: RunnerTask): Promise<void> {
		// biome-ignore lint/suspicious/noExplicitAny: super signature is vitest's Task
		super.onAfterRunTask(test as any);
		const after = await this.snapshot();
		// Outstanding baselines > 0 means another task's before/after window
		// overlapped this one (test.concurrent) and attribution is unreliable.
		const outstanding = this.baselines.size - 1;
		this.baselines.delete(test.id);
		const coverage = [...after.values()];
		await this.captureSources(coverage.map((c) => c.url));
		const record = {
			id: test.id,
			file: test.file?.filepath ?? (test.file?.name ? fileURLToPath(`file://${test.file.name}`) : undefined),
			fileName: test.file?.name,
			name: fullName(test),
			state: test.result?.state ?? "unknown",
			concurrent: Boolean(test.concurrent) || test.mode === "concurrent",
			outstanding,
			coverage,
		};
		appendFileSync(this.outFile, `${JSON.stringify(record)}\n`);
	}
}
