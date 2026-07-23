import { describe, expect, test } from "vitest";
import { globToRegExp, isMultiProject, passthroughEnablesCoverage } from "../src/cli.js";

describe("passthroughEnablesCoverage", () => {
	test("bare --coverage enables", () => {
		expect(passthroughEnablesCoverage(["--coverage"])).toBe(true);
	});
	test("--coverage=true enables", () => {
		expect(passthroughEnablesCoverage(["--coverage=true"])).toBe(true);
	});
	test("--coverage.enabled enables", () => {
		expect(passthroughEnablesCoverage(["--coverage.enabled"])).toBe(true);
	});
	test("--coverage.provider=v8 enables", () => {
		expect(passthroughEnablesCoverage(["--coverage.provider=v8"])).toBe(true);
	});
	test("--coverage=false does not enable", () => {
		expect(passthroughEnablesCoverage(["--coverage=false"])).toBe(false);
	});
	test("--coverage.enabled=false does not enable", () => {
		expect(passthroughEnablesCoverage(["--coverage.enabled=false"])).toBe(false);
	});
	test("no coverage flags", () => {
		expect(passthroughEnablesCoverage(["test/foo.js", "--reporter=dot"])).toBe(false);
	});
});

describe("globToRegExp", () => {
	test("* matches within a path segment but not across separators", () => {
		const re = globToRegExp("test/*.test.ts");
		expect(re.test("test/theme.test.ts")).toBe(true);
		expect(re.test("test/nested/theme.test.ts")).toBe(false);
	});
	test("** matches across separators", () => {
		const re = globToRegExp("**/theme.test.ts");
		expect(re.test("test/theme.test.ts")).toBe(true);
		expect(re.test("test/nested/theme.test.ts")).toBe(true);
	});
	test("? matches a single non-separator char", () => {
		const re = globToRegExp("theme.test.t?");
		expect(re.test("theme.test.ts")).toBe(true);
		expect(re.test("theme.test.tsx")).toBe(false);
	});
	test("regex metacharacters in the glob are literal", () => {
		const re = globToRegExp("a.b.test.ts");
		expect(re.test("a.b.test.ts")).toBe(true);
		expect(re.test("axbxtestxts")).toBe(false);
	});
	test("the pattern is anchored (no partial match)", () => {
		const re = globToRegExp("theme");
		expect(re.test("theme")).toBe(true);
		expect(re.test("theme.test.ts")).toBe(false);
	});
});

describe("isMultiProject", () => {
	test("plain single project is not multi-project", () => {
		expect(isMultiProject({ projects: [{ name: "" }] })).toBe(false);
	});
	test("a single NAMED project is not multi-project", () => {
		expect(isMultiProject({ projects: [{ name: "mypkg" }] })).toBe(false);
	});
	test("more than one project IS multi-project", () => {
		expect(isMultiProject({ projects: [{ name: "a" }, { name: "b" }] })).toBe(true);
	});
	test("missing or non-array projects is not multi-project", () => {
		expect(isMultiProject({})).toBe(false);
		expect(isMultiProject({ projects: null })).toBe(false);
	});
});
