/**
 * Runs the project's vitest suite once under the recon coverage runner and reads
 * back the per-test coverage records and captured module sources. Copied from
 * culprits' collector (the family substrate).
 *
 * Injection: a synthetic config that imports the project's own resolved config
 * file and `mergeConfig()`s the recon overrides (the coverage runner and
 * `maxConcurrency: 1`) on top, so the project's resolve.alias / plugins /
 * test.include are inherited while our overrides win. It is written under
 * `node_modules/.recon/` inside the project so that `vitest/config` and the
 * project config (incl. TS configs) resolve, then passed via `--config` (a
 * `--config` file replaces vitest's own config discovery, which is why we must
 * re-inherit it explicitly). When the project has no config file, the synthetic
 * config falls back to the bare overrides. The directory is cleaned up after.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export interface TestRecord {
	id: string;
	file?: string; // absolute path to the test file
	fileName?: string;
	name: string; // full "suite > name" — what the partition pattern matches
	state: string;
	concurrent: boolean;
	outstanding: number;
	coverage: {
		url: string;
		functions: { functionName: string; ranges: { startOffset: number; endOffset: number; count: number }[]; isBlockCoverage: boolean }[];
	}[];
}

export interface CollectResult {
	records: TestRecord[];
	executedSources: Map<string, string>; // url -> exact executed source
	runnerExit: number;
	internalUrls: Set<string>; // injected runner/environment scripts excluded from ranking
	// Absolute paths of test files vitest reported as FAILED TO COLLECT (an
	// import/config/syntax error: the file's suite failed with zero assertions
	// run). Distinct from files with ordinary failing tests, and from skipped
	// files. Empty when the JSON report was unavailable. Used by the CLI's
	// incomplete-collection guard (never refuse merely on "zero records").
	erroredFiles: string[];
}

// Resolve the project's own vitest install. Throws if vitest is not present.
export function resolveVitest(projectRoot: string): { bin: string; nodeApi: string; pkgDir: string } {
	const require = createRequire(join(projectRoot, "package.json"));
	let pkgJson: string;
	try {
		pkgJson = require.resolve("vitest/package.json");
	} catch {
		throw new NoVitestError();
	}
	const pkgDir = dirname(pkgJson);
	return {
		bin: join(pkgDir, "vitest.mjs"),
		nodeApi: join(pkgDir, "dist", "node.js"),
		pkgDir,
	};
}

export class NoVitestError extends Error {
	constructor() {
		super("no vitest found in this project");
		this.name = "NoVitestError";
	}
}

// A recoverable environment error (e.g. cannot write the synthetic config) that
// the CLI reports as a clean one-line message with exit 1.
export class ReconSetupError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ReconSetupError";
	}
}

// The recon overrides layered onto the project config. `runner` points at the
// coverage runner; `maxConcurrency: 1` serializes `test.concurrent` tests (their
// overlapping before/after coverage windows would otherwise collapse onto
// whichever test snapshots first — measured). `server.fs.allow` is extended with
// the runner's own dist directory: under vite 7 the dev server's fs allow-list
// refuses to serve `/@fs/<runner>` when the target repo is outside our package's
// workspace root. mergeConfig concatenates arrays, so the project's own fs.allow
// entries survive. These overrides must win over the project's values, so they
// go on the right-hand side of mergeConfig.
function overrideSnippet(runnerPath: string): string {
	const runnerDir = dirname(runnerPath);
	return `{ test: { runner: ${JSON.stringify(runnerPath)}, maxConcurrency: 1 }, server: { fs: { allow: [${JSON.stringify(runnerDir)}] } } }`;
}

function writeSyntheticConfig(configDir: string, runnerPath: string, projectConfigFile: string | undefined): string {
	// Randomized filename so two concurrent `recon` runs in one repo cannot race
	// on the same config path (the finally block deletes only its own file).
	const configPath = join(configDir, `recon.${randomBytes(6).toString("hex")}.config.mjs`);

	// The synthetic config MUST inherit the project's own vite/vitest config —
	// resolve.alias, plugins, test.include, etc. — or files that rely on them
	// fail to collect. When the project has a config file, import it (vitest's
	// own loader handles TS/ESM since it loads this synthetic config) and
	// mergeConfig() the recon overrides on top so they win. `defineConfig` may
	// yield an object, a function, or a promise; normalize all three. When the
	// project has NO config file, fall back to the bare override object.
	let content: string;
	if (projectConfigFile) {
		content = `import { mergeConfig } from "vitest/config";
import projectExport from ${JSON.stringify(projectConfigFile)};

async function resolveProjectConfig() {
	let cfg = projectExport;
	if (cfg && typeof cfg === "object" && "default" in cfg && cfg.default !== undefined) cfg = cfg.default;
	if (typeof cfg === "function") cfg = await cfg({ command: "serve", mode: "test" });
	cfg = await cfg;
	return cfg ?? {};
}

export default (async () => mergeConfig(await resolveProjectConfig(), ${overrideSnippet(runnerPath)}))();
`;
	} else {
		content = `export default ${overrideSnippet(runnerPath)};\n`;
	}
	writeFileSync(configPath, content);
	return configPath;
}

export async function collect(
	projectRoot: string,
	passthroughArgs: string[],
	projectConfigFile: string | undefined,
): Promise<CollectResult> {
	const { bin } = resolveVitest(projectRoot);
	const runnerPath = join(HERE, "runner.js");

	// Config lives inside the project so vitest can resolve the user's config
	// and vitest/config; a temp OUT dir holds the JSONL + captured sources.
	const configDir = join(projectRoot, "node_modules", ".recon");
	let configPath: string;
	try {
		mkdirSync(configDir, { recursive: true });
		configPath = writeSyntheticConfig(configDir, runnerPath, projectConfigFile);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		throw new ReconSetupError(
			`cannot write recon's temp config under ${configDir} (${reason}). Is the project writable?`,
		);
	}
	const outDir = mkdtempSync(join(tmpdir(), "recon-"));
	const reportPath = join(outDir, "vitest-report.json");

	try {
		const exit = await runVitest(bin, projectRoot, configPath, outDir, reportPath, passthroughArgs);
		const { records, executedSources } = readOut(outDir);
		const erroredFiles = readErroredFiles(reportPath);
		return {
			records,
			executedSources,
			runnerExit: exit,
			internalUrls: new Set([pathToFileURL(runnerPath).href]),
			erroredFiles,
		};
	} finally {
		rmSync(outDir, { recursive: true, force: true });
		rmSync(configPath, { force: true });
		// Remove our config dir if we left it empty.
		try {
			if (readdirSync(configDir).length === 0) rmSync(configDir, { recursive: true, force: true });
		} catch {
			// non-fatal
		}
	}
}

function runVitest(
	bin: string,
	projectRoot: string,
	configPath: string,
	outDir: string,
	reportPath: string,
	passthroughArgs: string[],
): Promise<number> {
	return new Promise((resolvePromise, reject) => {
		// Keep the default reporter (its live output is routed to stderr for the
		// user) AND add the json reporter to a file, so we can classify each test
		// file's outcome (skipped vs failed-to-collect) without parsing stderr.
		const args = [
			bin,
			"run",
			"--config",
			configPath,
			"--reporter=default",
			"--reporter=json",
			`--outputFile.json=${reportPath}`,
			...passthroughArgs,
		];
		const child = spawn(process.execPath, args, {
			cwd: projectRoot,
			env: { ...process.env, RECON_OUT_DIR: outDir },
			// vitest's own reporter is routed to *our* stderr so that stdout carries
			// only the recon report (agent-pipeable, byte-stable). We only consume
			// the sidecar files vitest's runner produces.
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.stdout?.on("data", (chunk) => process.stderr.write(chunk));
		child.stderr?.on("data", (chunk) => process.stderr.write(chunk));
		child.on("error", reject);
		child.on("exit", (code) => resolvePromise(code ?? 1));
	});
}

export function readOut(outDir: string): {
	records: TestRecord[];
	executedSources: Map<string, string>;
} {
	const records: TestRecord[] = [];
	for (const file of readdirSync(outDir)) {
		if (!file.endsWith(".jsonl")) continue;
		const content = readFileSync(join(outDir, file), "utf8");
		for (const line of content.split("\n")) {
			if (line.trim()) records.push(JSON.parse(line) as TestRecord);
		}
	}

	const executedSources = new Map<string, string>();
	const sourcesDir = join(outDir, "sources");
	if (existsSync(sourcesDir)) {
		for (const file of readdirSync(sourcesDir)) {
			if (!file.endsWith(".json")) continue;
			const { url, source } = JSON.parse(readFileSync(join(sourcesDir, file), "utf8")) as {
				url: string;
				source: string;
			};
			executedSources.set(url, source);
		}
	}
	return { records, executedSources };
}

// Shape of the subset of vitest's JSON reporter output we read.
interface JsonAssertion {
	status?: string;
}
interface JsonTestFile {
	name?: string; // absolute path to the test file
	status?: string; // "passed" | "failed" (skipped files report "passed")
	assertionResults?: JsonAssertion[];
}
interface JsonReport {
	testResults?: JsonTestFile[];
}

// Classify from vitest's JSON report which test files FAILED TO COLLECT. A
// collection/import/syntax error surfaces as a file whose suite `status` is
// "failed" with ZERO assertions run — no test executed. This positively
// distinguishes it from:
//   - files with ordinary failing tests (status "failed", assertions present), and
//   - fully-skipped files (status "passed", assertions all "skipped").
// Returns [] if the report is missing/unparseable (guard then does not fire).
export function classifyErroredFiles(report: JsonReport): string[] {
	const errored: string[] = [];
	for (const file of report.testResults ?? []) {
		if (typeof file.name !== "string") continue;
		const assertions = file.assertionResults ?? [];
		if (file.status === "failed" && assertions.length === 0) {
			errored.push(file.name);
		}
	}
	return errored;
}

export function readErroredFiles(reportPath: string): string[] {
	if (!existsSync(reportPath)) return [];
	try {
		const report = JSON.parse(readFileSync(reportPath, "utf8")) as JsonReport;
		return classifyErroredFiles(report);
	} catch {
		return [];
	}
}

// Load the project's vitest node API to build the transform bridge.
export async function loadVitestNodeApi(projectRoot: string): Promise<{
	// biome-ignore lint/suspicious/noExplicitAny: vitest's createVitest signature
	createVitest: any;
	// biome-ignore lint/suspicious/noExplicitAny: vitest's parseAstAsync signature
	parseAstAsync: any;
}> {
	const { nodeApi } = resolveVitest(projectRoot);
	const mod = await import(pathToFileURL(nodeApi).href);
	return { createVitest: mod.createVitest, parseAstAsync: mod.parseAstAsync };
}

export function projectRootFrom(cwd: string): string {
	return resolve(cwd);
}
