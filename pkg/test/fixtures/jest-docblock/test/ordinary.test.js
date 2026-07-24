const { value } = require("../src/value");

test("ordinary test is instrumented", () => {
  expect(value()).toBe(2);
});
