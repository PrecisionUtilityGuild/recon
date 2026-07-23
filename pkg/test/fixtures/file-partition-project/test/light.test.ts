import { expect, test } from "vitest";
import { lightTheme } from "../src/theme.ts";

test("light is white", () => {
	expect(lightTheme()).toBe("#ffffff");
});
