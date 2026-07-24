/** Runner selection and the runner-owned collection/mapping lifecycle. */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";
import {
	NoVitestError,
	ReconSetupError,
	collect,
	loadVitestNodeApi,
	resolveVitest,
	type CollectResult,
} from "./collect.js";
import { collectJest, inspectJestConfig, NoJestError, resolveJest, UnsupportedJestVersionError } from "./jest-collect.js";
import { CoverageMapper, type TransformBridge } from "./map.js";

export type RunnerName = "vitest" | "jest";

export interface RunnerSession {
	runner: RunnerName;
	collected: CollectResult;
	mapper: CoverageMapper;
	close(): Promise<void>;
}

export interface RunnerAdapter {
	readonly name: RunnerName;
	prepare(projectRoot: string, passthroughArgs: string[]): Promise<RunnerSession>;
}

export class RunnerAdapterError extends Error {
	constructor(
		message: string,
		readonly exitCode: 1 | 2,
		readonly kind: "coverage" | "setup" | "missing" | "projects" = "setup",
	) {
		super(message);
		this.name = "RunnerAdapterError";
	}
}

const JEST_CONFIG_FILES = [
	"jest.config.js",
	"jest.config.cjs",
	"jest.config.mjs",
	"jest.config.ts",
	"jest.config.cts",
	"jest.config.mts",
	"jest.config.json",
];

// Choose the runner exactly as culprits does: a Jest config (a `jest` key in
// package.json or a jest.config.* file) selects Jest; a declared `jest` without
// a declared `vitest` selects Jest; everything else falls back to Vitest, which
// then emits the established missing-Vitest usage error when absent.
export function detectRunner(projectRoot: string): RunnerName {
	let pkg: {
		jest?: unknown;
		dependencies?: Record<string, string>;
		devDependencies?: Record<string, string>;
		peerDependencies?: Record<string, string>;
	} = {};
	try {
		pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
	} catch {
		// Absent/unreadable metadata falls back to Vitest.
	}
	const declared = { ...pkg.peerDependencies, ...pkg.devDependencies, ...pkg.dependencies };
	const hasJestConfig = pkg.jest != null || JEST_CONFIG_FILES.some((file) => existsSync(join(projectRoot, file)));
	if (hasJestConfig) return "jest";
	if (declared.jest && !declared.vitest) return "jest";
	return "vitest";
}

export async function prepareRunner(
	runner: RunnerName,
	projectRoot: string,
	passthroughArgs: string[],
): Promise<RunnerSession> {
	return RUNNER_ADAPTERS[runner].prepare(projectRoot, passthroughArgs);
}

const RUNNER_ADAPTERS: Record<RunnerName, RunnerAdapter> = {
	vitest: { name: "vitest", prepare: prepareVitest },
	jest: { name: "jest", prepare: prepareJest },
};

async function prepareVitest(projectRoot: string, passthroughArgs: string[]): Promise<RunnerSession> {
	try {
		resolveVitest(projectRoot);
	} catch (error) {
		if (error instanceof NoVitestError) {
			throw new RunnerAdapterError(
				"recon: no vitest found in this project (looked for the 'vitest' package).\n",
				2,
				"missing",
			);
		}
		throw error;
	}

	const { createVitest, parseAstAsync } = await loadVitestNodeApi(projectRoot);
	const vitest = await createVitest("test", { watch: false, run: true });
	try {
		const rootProject = vitest.getRootProject();
		if (rootProject.config?.coverage?.enabled) {
			throw new RunnerAdapterError("", 2, "coverage");
		}
		if (isMultiProject(vitest)) {
			throw new RunnerAdapterError(
				"recon: this project uses a vitest workspace / test.projects config, which v1 does not\n" +
					"support — the per-test coverage runner cannot be injected into sub-projects. Run recon\n" +
					"inside an individual project directory instead.\n",
				1,
				"projects",
			);
		}
		const projectConfigFile: string | undefined = rootProject.vite?.config?.configFile;
		const collected = await collect(projectRoot, passthroughArgs, projectConfigFile);
		const bridge: TransformBridge = {
			transform: async (url) => rootProject.vite.environments.ssr.transformRequest(url),
			parseAst: (code) => parseAstAsync(code),
		};
		return {
			runner: "vitest",
			collected,
			mapper: new CoverageMapper(bridge, collected.executedSources),
			close: () => vitest.close(),
		};
	} catch (error) {
		await vitest.close();
		if (error instanceof ReconSetupError) {
			throw new RunnerAdapterError(`recon: ${error.message}\n`, 1);
		}
		throw error;
	}
}

async function prepareJest(projectRoot: string, passthroughArgs: string[]): Promise<RunnerSession> {
	let resolved: ReturnType<typeof resolveJest>;
	try {
		resolved = resolveJest(projectRoot);
	} catch (error) {
		if (error instanceof NoJestError) {
			throw new RunnerAdapterError(
				"recon: no jest found in this project (looked for the 'jest' package).\n",
				2,
				"missing",
			);
		}
		if (error instanceof UnsupportedJestVersionError) {
			throw new RunnerAdapterError(`recon: ${error.message}\n`, 2, "setup");
		}
		if (error instanceof ReconSetupError) {
			throw new RunnerAdapterError(`recon: ${error.message}\n`, 1);
		}
		throw error;
	}

	let config;
	try {
		config = await inspectJestConfig(resolved, projectRoot, passthroughArgs);
	} catch (error) {
		if (error instanceof ReconSetupError) {
			throw new RunnerAdapterError(`recon: ${error.message}\n`, 1);
		}
		throw error;
	}
	if (config.globalConfig?.collectCoverage || config.configs?.some((entry) => entry.collectCoverage)) {
		throw new RunnerAdapterError("", 2, "coverage");
	}
	const unsupportedEnvironment = config.configs?.find(
		(entry) => entry.testEnvironment && !isDefaultNodeEnvironment(entry.testEnvironment, resolved.environmentBase),
	);
	if (unsupportedEnvironment?.testEnvironment) {
		throw new RunnerAdapterError(
			"recon: this Jest project uses a custom/non-Node test environment, which cannot be wrapped\n" +
				"safely by the per-test collector. Use the default node environment or choose Vitest.\n",
			2,
			"setup",
		);
	}
	const unsupportedRunner = config.configs?.find(
		(entry) => entry.testRunner && !entry.testRunner.split("\\").join("/").includes("/jest-circus/"),
	);
	if (unsupportedRunner?.testRunner) {
		throw new RunnerAdapterError(
			"recon: this Jest project does not use jest-circus; its runner cannot emit the per-test\n" +
				"environment events required for coverage attribution.\n",
			2,
			"setup",
		);
	}
	if ((config.globalConfig?.projects?.length ?? 0) > 0 || (config.configs?.length ?? 0) > 1) {
		throw new RunnerAdapterError(
			"recon: this project uses a Jest projects config, which recon does not support — per-test\n" +
				"coverage cannot be safely attributed across projects. Run recon inside an individual\n" +
				"project directory instead.\n",
			1,
			"projects",
		);
	}

	let collected: CollectResult;
	try {
		collected = await collectJest(projectRoot, passthroughArgs, resolved);
	} catch (error) {
		if (error instanceof ReconSetupError) {
			throw new RunnerAdapterError(`recon: ${error.message}\n`, 1);
		}
		throw error;
	}
	const bridge: TransformBridge = {
		transform: async (url) => {
			const code = collected.executedSources.get(url);
			if (code == null) return null;
			let original: string;
			try {
				original = readFileSync(fileURLToPath(url), "utf8");
			} catch {
				throw new Error(`cannot read Jest script source ${url}`);
			}
			if (code === original) return { code };
			const map = readJestSourceMap(code, url);
			if (!map) {
				throw new Error(`Jest transformed ${url} without a usable source map`);
			}
			return { code, map };
		},
		parseAst: async (code) =>
			parse(code, {
				sourceType: "unambiguous",
				allowAwaitOutsideFunction: true,
				allowReturnOutsideFunction: true,
				plugins: ["estree"],
			}).program,
	};
	return {
		runner: "jest",
		collected,
		mapper: new CoverageMapper(bridge, collected.executedSources),
		close: async () => {},
	};
}

// A project runs the default Node environment when Jest's resolved
// `testEnvironment` file belongs to the `jest-environment-node` package —
// regardless of *which copy*. Under hoisted-vs-nested node_modules layouts
// this package's own resolved copy and the project's copy can be two distinct
// files of the same package, so realpath-equality alone would falsely refuse
// an ordinary project. Compare package identity (enclosing package.json name),
// keeping realpath-equality as a fast path.
const DEFAULT_JEST_ENVIRONMENT = "jest-environment-node";

export function isDefaultNodeEnvironment(resolvedEnvironment: string, ownEnvironmentBase: string): boolean {
	if (sameFile(resolvedEnvironment, ownEnvironmentBase)) return true;
	return enclosingPackageName(resolvedEnvironment) === DEFAULT_JEST_ENVIRONMENT;
}

function sameFile(a: string, b: string): boolean {
	try {
		return realpathSync(a) === realpathSync(b);
	} catch {
		return resolve(a) === resolve(b);
	}
}

// Walk up from a file to its nearest enclosing package.json and return its
// `name`, or null if none is reachable/parseable. Stops at the filesystem root.
function enclosingPackageName(filePath: string): string | null {
	let dir = dirname(resolve(filePath));
	while (true) {
		const manifest = join(dir, "package.json");
		if (existsSync(manifest)) {
			try {
				const name = (JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown }).name;
				if (typeof name === "string") return name;
			} catch {
				// Unreadable/invalid manifest: keep walking up.
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

// Jest transformers may return maps separately or embed them in generated
// code; Jest's script transformer exposes the executable form through a final
// sourceMappingURL comment. Never identity-map transformed code without one.
function readJestSourceMap(code: string, scriptUrl: string): unknown | null {
	const matches = [...code.matchAll(/^\s*\/\/[#@]\s*sourceMappingURL=([^\s]+)\s*$/gm)];
	const sourceMapUrl = matches.at(-1)?.[1];
	if (!sourceMapUrl) return null;
	try {
		let raw: string;
		if (sourceMapUrl.startsWith("data:")) {
			const comma = sourceMapUrl.indexOf(",");
			if (comma < 0) return null;
			const metadata = sourceMapUrl.slice(0, comma);
			const payload = sourceMapUrl.slice(comma + 1);
			raw = metadata.includes(";base64") ? Buffer.from(payload, "base64").toString("utf8") : decodeURIComponent(payload);
		} else {
			const scriptPath = fileURLToPath(scriptUrl);
			const mapPath = sourceMapUrl.startsWith("file://")
				? fileURLToPath(sourceMapUrl)
				: resolve(dirname(scriptPath), sourceMapUrl);
			raw = readFileSync(mapPath, "utf8");
		}
		const map = JSON.parse(raw) as { version?: unknown; sources?: unknown; mappings?: unknown };
		return typeof map.version === "number" && Array.isArray(map.sources) && typeof map.mappings === "string"
			? map
			: null;
	} catch {
		return null;
	}
}

// True only for more than one resolved Vitest sub-project. Exported for the
// compatibility tests. v1 refuses these (exit 1) because the runner override
// does not propagate to sub-projects. A plain single config is one project even
// when it sets test.name; detection is purely on the resolved project count.
// biome-ignore lint/suspicious/noExplicitAny: Vitest node instance shapes vary by version.
export function isMultiProject(vitest: any): boolean {
	return Array.isArray(vitest?.projects) && vitest.projects.length > 1;
}
