import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		// Fixture projects under test/fixtures are their own vitest projects,
		// driven via the CLI by the integration tests — never run them directly.
		exclude: ["**/node_modules/**", "test/fixtures/**"],
		// The golden integration test spawns the built CLI, which runs a full
		// vitest suite in a child process; the default 5s timeout is too tight.
		testTimeout: 60000,
	},
});
