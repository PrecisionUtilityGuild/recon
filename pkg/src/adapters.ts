/** Vitest runner setup: the collection/mapping lifecycle and its refusal guards. */
import {
	NoVitestError,
	ReconSetupError,
	collect,
	loadVitestNodeApi,
	resolveVitest,
	type CollectResult,
} from "./collect.js";
import { CoverageMapper, type TransformBridge } from "./map.js";

export type RunnerName = "vitest";

export interface RunnerSession {
	runner: RunnerName;
	collected: CollectResult;
	mapper: CoverageMapper;
	close(): Promise<void>;
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

export async function prepareRunner(projectRoot: string, passthroughArgs: string[]): Promise<RunnerSession> {
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

// True only for more than one resolved Vitest sub-project. Exported for the
// compatibility tests. v1 refuses these (exit 1) because the runner override
// does not propagate to sub-projects. A plain single config is one project even
// when it sets test.name; detection is purely on the resolved project count.
// biome-ignore lint/suspicious/noExplicitAny: Vitest node instance shapes vary by version.
export function isMultiProject(vitest: any): boolean {
	return Array.isArray(vitest?.projects) && vitest.projects.length > 1;
}
