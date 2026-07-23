import { defineConfig } from "vitest/config";

// Project has its own v8 coverage enabled — recon must refuse (exit 2) rather
// than silently zero the official report.
export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		coverage: { enabled: true, provider: "v8" },
	},
});
