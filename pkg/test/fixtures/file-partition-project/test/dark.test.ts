import { expect, test } from "vitest";
import { darkTheme } from "../src/theme.ts";

test("dark is black", () => {
	expect(darkTheme()).toBe("#000000");
});
