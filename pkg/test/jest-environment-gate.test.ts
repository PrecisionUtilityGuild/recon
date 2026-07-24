import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { isDefaultNodeEnvironment } from "../src/adapters.js";

// Simulate two distinct on-disk copies of the same package (hoisted vs nested
// node_modules) plus a genuinely custom environment, then assert the gate keys
// on package identity rather than file equality.
const created: string[] = [];

function writePackage(dir: string, name: string): string {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name, main: "index.js" }));
	const file = join(dir, "index.js");
	writeFileSync(file, "module.exports = {};\n");
	return file;
}

function scratch(): string {
	const root = mkdtempSync(join(tmpdir(), "recon-env-gate-"));
	created.push(root);
	return root;
}

afterEach(() => {
	while (created.length) rmSync(created.pop() as string, { recursive: true, force: true });
});

describe("default-environment gate", () => {
	test("accepts a jest-environment-node copy that is a different file from our own", () => {
		const root = scratch();
		// Our resolved copy (hoisted) and the project's resolved copy (nested) are
		// two separate files, both belonging to jest-environment-node.
		const ownCopy = writePackage(join(root, "node_modules", "jest-environment-node"), "jest-environment-node");
		const projectCopy = writePackage(
			join(root, "node_modules", "jest", "node_modules", "jest-environment-node"),
			"jest-environment-node",
		);
		expect(projectCopy).not.toBe(ownCopy);
		expect(isDefaultNodeEnvironment(projectCopy, ownCopy)).toBe(true);
	});

	test("still accepts the exact same file (fast path)", () => {
		const root = scratch();
		const copy = writePackage(join(root, "node_modules", "jest-environment-node"), "jest-environment-node");
		expect(isDefaultNodeEnvironment(copy, copy)).toBe(true);
	});

	test("refuses a genuinely custom environment", () => {
		const root = scratch();
		const ownCopy = writePackage(join(root, "node_modules", "jest-environment-node"), "jest-environment-node");
		const custom = writePackage(join(root, "node_modules", "jest-environment-jsdom"), "jest-environment-jsdom");
		expect(isDefaultNodeEnvironment(custom, ownCopy)).toBe(false);
	});
});
