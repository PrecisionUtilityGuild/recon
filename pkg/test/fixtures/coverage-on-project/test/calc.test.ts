import { expect, test } from "vitest";
import { triple } from "../src/calc.ts";

test("triple works", () => {
	expect(triple(2)).toBe(6);
});
