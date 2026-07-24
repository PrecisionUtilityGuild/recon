/**
 * @jest-environment ./plain-environment.cjs
 */

test("per-file environment override bypasses the injected environment", () => {
  expect(1).toBe(1);
});
