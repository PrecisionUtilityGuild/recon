/**
 * Run the project's own Jest with the injected per-test coverage environment.
 * Ported from culprits' jest-collect (the family substrate); recon partitions
 * the resulting per-test records instead of classifying by pass/fail.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ReconSetupError, type CollectResult, readErroredFiles, readOut } from "./collect.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export interface ResolvedJest {
	bin: string;
	environmentBase: string;
}

export class NoJestError extends Error {
	constructor() {
		super("no jest found in this project");
		this.name = "NoJestError";
	}
}

export const MIN_JEST_MAJOR = 30;

export class UnsupportedJestVersionError extends Error {
	constructor(readonly found: string) {
		super(
			`this project's Jest is ${found}, but recon requires Jest ${MIN_JEST_MAJOR}+ ` +
				"(peerDependencies range >=30). Upgrade Jest, or run recon against Vitest.",
		);
		this.name = "UnsupportedJestVersionError";
	}
}

// Parse the leading integer of a semver string. Returns null when the version
// is absent or unparseable, so the caller can decide the fallback behavior.
function majorVersion(version: unknown): number | null {
	if (typeof version !== "string") return null;
	const match = version.trim().match(/^\d+/);
	if (!match) return null;
	const major = Number(match[0]);
	return Number.isInteger(major) ? major : null;
}

export function resolveJest(projectRoot: string): ResolvedJest {
	const projectRequire = createRequire(join(projectRoot, "package.json"));
	let pkgJsonPath: string;
	try {
		pkgJsonPath = projectRequire.resolve("jest/package.json");
	} catch {
		throw new NoJestError();
	}
	const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
		bin?: string | Record<string, string>;
		version?: unknown;
	};
	// peerDependencies (>=30) is advisory only — pnpm/yarn/bun routinely install
	// out-of-range peers, so verify the resolved installation at runtime.
	const major = majorVersion(pkg.version);
	if (major != null && major < MIN_JEST_MAJOR) {
		throw new UnsupportedJestVersionError(typeof pkg.version === "string" ? pkg.version : String(pkg.version));
	}
	const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.jest;
	if (!binRel) throw new NoJestError();

	let environmentBase: string | undefined;
	const probes = [projectRequire, createRequire(pkgJsonPath)];
	try {
		const corePkg = createRequire(pkgJsonPath).resolve("@jest/core/package.json");
		probes.push(createRequire(corePkg));
	} catch {
		// Older/newer Jest layouts can still resolve from the other probes.
	}
	for (const requireFrom of probes) {
		try {
			environmentBase = requireFrom.resolve("jest-environment-node");
			break;
		} catch {
			// Try the next package boundary.
		}
	}
	if (!environmentBase) {
		throw new ReconSetupError("found jest, but could not resolve its jest-environment-node package");
	}

	return { bin: join(dirname(pkgJsonPath), binRel), environmentBase };
}

export interface JestConfigSnapshot {
	configs?: { collectCoverage?: boolean; testEnvironment?: string; testRunner?: string }[];
	globalConfig?: { bail?: number; collectCoverage?: boolean; projects?: unknown[] };
}

export async function inspectJestConfig(
	resolved: ResolvedJest,
	projectRoot: string,
	passthroughArgs: string[],
): Promise<JestConfigSnapshot> {
	const result = await spawnCaptured(
		resolved.bin,
		["--showConfig", "--json", ...passthroughArgs],
		projectRoot,
		process.env,
	);
	if (result.exit !== 0) {
		if (result.stderr) process.stderr.write(result.stderr);
		throw new ReconSetupError(`jest exited ${result.exit} while resolving the project config`);
	}
	try {
		return JSON.parse(result.stdout) as JestConfigSnapshot;
	} catch {
		throw new ReconSetupError("jest --showConfig did not return valid JSON");
	}
}

export async function collectJest(
	projectRoot: string,
	passthroughArgs: string[],
	resolved: ResolvedJest,
): Promise<CollectResult> {
	const environmentPath = join(HERE, "jest-environment.js");
	const outDir = mkdtempSync(join(tmpdir(), "recon-jest-"));
	const reportPath = join(outDir, "jest-report.json");
	try {
		const args = [
			...passthroughArgs,
			"--runInBand",
			"--maxConcurrency=1",
			"--bail=0",
			`--testEnvironment=${environmentPath}`,
			"--json",
			`--outputFile=${reportPath}`,
		];
		const exit = await runJest(
			resolved.bin,
			args,
			projectRoot,
			{
				...process.env,
				RECON_OUT_DIR: outDir,
				RECON_JEST_ENVIRONMENT_BASE: resolved.environmentBase,
			},
			reportPath,
		);
		const { records, executedSources } = readOut(outDir);
		const reportedTests = readJestTestCount(reportPath);
		const incompleteMessage =
			reportedTests != null && reportedTests !== records.length
				? `recon: Jest reported ${reportedTests} test result(s), but the injected environment recorded ` +
						`${records.length}. A per-file environment override or test retry bypassed one-to-one coverage ` +
						"attribution, so the run is incomplete and any ranking would be unreliable.\n"
				: undefined;
		return {
			records,
			executedSources,
			runnerExit: exit,
			internalUrls: new Set([pathToFileURL(environmentPath).href]),
			erroredFiles: readErroredFiles(reportPath),
			incompleteMessage,
		};
	} finally {
		rmSync(outDir, { recursive: true, force: true });
	}
}

function readJestTestCount(reportPath: string): number | null {
	try {
		const report = JSON.parse(readFileSync(reportPath, "utf8")) as { numTotalTests?: unknown };
		return typeof report.numTotalTests === "number" ? report.numTotalTests : null;
	} catch {
		return null;
	}
}

// The `Test results written to: <path>` line Jest prints for `--outputFile`
// (@jest/core, unconditional under `--json`). It names recon's own throwaway
// report inside a `recon-jest-XXXX` temp dir, so to a stranger it reads as
// recon litter. Jest offers no flag to silence it, so we filter exactly that
// line out of the passthrough — nothing else. The line's tail is `path.relative`
// of the report path from cwd; realpath differences (e.g. /var vs /private/var)
// can make it absolute or `../`-prefixed, so we match on the fixed prefix plus
// the report's own basename rather than an exact string.
function isOutputFileNotice(line: string, reportPath: string): boolean {
	const marker = "Test results written to:";
	if (!line.startsWith(marker)) return false;
	return line.slice(marker.length).trimEnd().endsWith(basename(reportPath));
}

function runJest(
	bin: string,
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
	reportPath: string,
): Promise<number> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, [bin, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		child.stdout?.on("data", (chunk) => process.stderr.write(chunk));
		// Buffer stderr into complete lines so the notice can be dropped whole
		// regardless of chunk boundaries; every other line streams through intact.
		let pending = "";
		child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
			pending += chunk;
			let newline = pending.indexOf("\n");
			while (newline !== -1) {
				const line = pending.slice(0, newline + 1);
				if (!isOutputFileNotice(line, reportPath)) process.stderr.write(line);
				pending = pending.slice(newline + 1);
				newline = pending.indexOf("\n");
			}
		});
		child.stderr?.on("end", () => {
			if (pending && !isOutputFileNotice(pending, reportPath)) process.stderr.write(pending);
			pending = "";
		});
		child.on("error", reject);
		child.on("exit", (code) => resolvePromise(code ?? 1));
	});
}

function spawnCaptured(
	bin: string,
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
): Promise<{ exit: number; stdout: string; stderr: string }> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, [bin, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout?.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
		child.stderr?.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
		child.on("error", reject);
		child.on("exit", (code) => resolvePromise({ exit: code ?? 1, stdout, stderr }));
	});
}
