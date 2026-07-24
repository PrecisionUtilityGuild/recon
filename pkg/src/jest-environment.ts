/**
 * Jest-circus environment that records incremental V8 coverage per test.
 * Selected by the Jest adapter through --testEnvironment; projects do not need
 * to edit their Jest configuration. Ported from culprits' jest-environment (the
 * family substrate); recon partitions the resulting per-test records instead of
 * classifying by pass/fail.
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const basePath = process.env.RECON_JEST_ENVIRONMENT_BASE;
if (!basePath) throw new Error("RECON_JEST_ENVIRONMENT_BASE is not set");

// Jest is an optional peer. The adapter resolves this absolute path from the
// project's own Jest installation and passes it to the child process.
// biome-ignore lint/suspicious/noExplicitAny: Jest loads environment classes dynamically.
const baseModule: any = await import(pathToFileURL(basePath).href);
const NodeEnvironment = baseModule.TestEnvironment ?? baseModule.default;
if (typeof NodeEnvironment !== "function") {
	throw new Error(`recon: ${basePath} does not export a Jest NodeEnvironment class`);
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

function normalizeUrl(url: string): string | null {
	if (url.startsWith("file://")) return url;
	if (isAbsolute(url)) return pathToFileURL(url).href;
	return null;
}

function isRelevantUrl(url: string): boolean {
	return !url.includes("/node_modules/");
}

// Full "describe > describe > test" name — the string recon's partition pattern
// matches against.
// biome-ignore lint/suspicious/noExplicitAny: jest-circus TestEntry is not a public stable type.
function fullName(test: any): string {
	const parts: string[] = [];
	let block = test.parent;
	while (block) {
		if (block.name && block.name !== "ROOT_DESCRIBE_BLOCK") parts.unshift(block.name);
		block = block.parent;
	}
	parts.push(test.name ?? "<unknown>");
	return parts.join(" > ");
}

export default class ReconJestEnvironment extends NodeEnvironment {
	private session: Session | null = null;
	private active = new Map<object, string>();
	private scriptIds = new Map<string, string>();
	private capturedSources = new Set<string>();
	private nextIndex = 0;
	private readonly testPath: string;
	private readonly outFile: string;
	private readonly sourcesDir: string;

	// biome-ignore lint/suspicious/noExplicitAny: Jest owns these constructor shapes.
	constructor(config: any, context: any) {
		super(config, context);
		const outDir = process.env.RECON_OUT_DIR;
		if (!outDir) throw new Error("RECON_OUT_DIR is not set — recon environment used outside recon");
		this.testPath = context.testPath;
		this.sourcesDir = join(outDir, "sources");
		mkdirSync(this.sourcesDir, { recursive: true });
		const pathHash = createHash("sha1").update(this.testPath).digest("hex").slice(0, 10);
		this.outFile = join(outDir, `cov-jest-${process.pid}-${pathHash}.jsonl`);
	}

	private async ensureSession(): Promise<Session> {
		if (!this.session) {
			const session = new Session();
			session.connect();
			session.on("Debugger.scriptParsed", (msg) => {
				const url = normalizeUrl(msg.params.url);
				if (url && isRelevantUrl(url)) this.scriptIds.set(msg.params.scriptId, url);
			});
			await session.post("Debugger.enable");
			await session.post("Profiler.enable");
			await session.post("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
			this.session = session;
		}
		return this.session;
	}

	private async snapshot(): Promise<Snapshot> {
		const session = await this.ensureSession();
		const { result } = await session.post("Profiler.takePreciseCoverage");
		const snapshot: Snapshot = new Map();
		for (const script of result) {
			const url = normalizeUrl(script.url);
			if (!url || !isRelevantUrl(url)) continue;
			snapshot.set(url, {
				url,
				functions: script.functions.map((fn) => ({
					functionName: fn.functionName,
					isBlockCoverage: fn.isBlockCoverage,
					ranges: fn.ranges.map((range) => ({
						startOffset: range.startOffset,
						endOffset: range.endOffset,
						count: range.count,
					})),
				})),
			});
		}
		return snapshot;
	}

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
				// The script may already have been collected; the mapper will flag a
				// missing executed source as untrusted rather than guessing offsets.
			}
		}
	}

	// biome-ignore lint/suspicious/noExplicitAny: jest-circus events are intentionally structural.
	async handleTestEvent(event: any): Promise<void> {
		if (event.name === "test_start") {
			await this.snapshot(); // incremental flush of import/between-test activity
			const id = `${this.testPath}_${this.nextIndex++}`;
			this.active.set(event.test, id);
			return;
		}

		if (event.name === "test_done") {
			const after = await this.snapshot();
			const id = this.active.get(event.test) ?? `${this.testPath}_${this.nextIndex++}`;
			const outstanding = Math.max(0, this.active.size - 1);
			this.active.delete(event.test);
			const coverage = [...after.values()];
			await this.captureSources(coverage.map((entry) => entry.url));
			this.writeRecord(event.test, id, event.test.errors?.length > 0 ? "fail" : "pass", coverage, outstanding);
			return;
		}

		// Skipped/todo entries emit no test_done. Preserve them in suite totals but
		// attach no coverage; their test_start snapshot already flushed activity.
		if (event.name === "test_skip" || event.name === "test_todo") {
			const id = this.active.get(event.test) ?? `${this.testPath}_${this.nextIndex++}`;
			const outstanding = Math.max(0, this.active.size - 1);
			this.active.delete(event.test);
			this.writeRecord(event.test, id, event.name === "test_skip" ? "skip" : "todo", [], outstanding);
		}
	}

	private writeRecord(
		// biome-ignore lint/suspicious/noExplicitAny: jest-circus TestEntry is structural.
		test: any,
		id: string,
		state: string,
		coverage: V8ScriptCoverage[],
		outstanding: number,
	): void {
		const record = {
			id,
			file: this.testPath,
			fileName: relative(process.cwd(), this.testPath).split("\\").join("/"),
			name: fullName(test),
			state,
			concurrent: Boolean(test.concurrent),
			outstanding,
			coverage,
		};
		appendFileSync(this.outFile, `${JSON.stringify(record)}\n`);
	}

	async teardown(): Promise<void> {
		if (this.session) {
			try {
				await this.session.post("Profiler.stopPreciseCoverage");
				await this.session.post("Profiler.disable");
				await this.session.post("Debugger.disable");
			} finally {
				this.session.disconnect();
				this.session = null;
			}
		}
		await super.teardown();
	}
}
