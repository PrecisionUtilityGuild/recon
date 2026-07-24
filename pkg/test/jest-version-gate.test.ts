import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MIN_JEST_MAJOR, NoJestError, UnsupportedJestVersionError, resolveJest } from "../src/jest-collect.js";

// Simulate a project whose resolved `jest` install is a specific version,
// without depending on the real installed Jest. A minimal node_modules/jest
// with just package.json + bin is enough for resolveJest's version check.
function makeProject(jestVersion: string): string {
	const root = mkdtempSync(join(tmpdir(), "recon-jest-version-"));
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", private: true }));
	const jestDir = join(root, "node_modules", "jest");
	const binDir = join(jestDir, "bin");
	mkdirSync(binDir, { recursive: true });
	writeFileSync(join(jestDir, "package.json"), JSON.stringify({ name: "jest", version: jestVersion, bin: "./bin/jest.js" }));
	writeFileSync(join(binDir, "jest.js"), "#!/usr/bin/env node\n");
	// jest-environment-node must resolve for resolveJest to succeed past the version gate.
	const envDir = join(root, "node_modules", "jest-environment-node");
	mkdirSync(envDir, { recursive: true });
	writeFileSync(join(envDir, "package.json"), JSON.stringify({ name: "jest-environment-node", version: jestVersion, main: "index.js" }));
	writeFileSync(join(envDir, "index.js"), "module.exports = {};\n");
	return root;
}

const created: string[] = [];
function project(version: string): string {
	const root = makeProject(version);
	created.push(root);
	return root;
}

afterEach(() => {
	while (created.length) rmSync(created.pop() as string, { recursive: true, force: true });
});

describe("Jest runtime version gate", () => {
	test("refuses a resolved Jest below the required major, naming found and floor", () => {
		let thrown: unknown;
		try {
			resolveJest(project("29.7.0"));
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(UnsupportedJestVersionError);
		expect((thrown as UnsupportedJestVersionError).found).toBe("29.7.0");
		expect((thrown as Error).message).toContain("29.7.0");
		expect((thrown as Error).message).toContain(String(MIN_JEST_MAJOR));
	});

	test("accepts a resolved Jest at the required major", () => {
		expect(() => resolveJest(project("30.4.2"))).not.toThrow();
	});

	test("accepts a resolved Jest above the required major", () => {
		expect(() => resolveJest(project("31.0.0"))).not.toThrow();
	});

	test("still reports a missing Jest as NoJestError, not a version error", () => {
		const root = mkdtempSync(join(tmpdir(), "recon-jest-none-"));
		created.push(root);
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", private: true }));
		expect(() => resolveJest(root)).toThrow(NoJestError);
	});
});
