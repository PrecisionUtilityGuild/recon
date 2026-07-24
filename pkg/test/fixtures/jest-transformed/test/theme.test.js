const { applyTheme, darkTheme, lightTheme } = require("../src/theme.ts");

describe("dark mode", () => {
  test("dark mode reports the dark label", () => {
    expect(applyTheme("dark").label).toBe("dark");
  });

  test("dark mode calls darkTheme directly", () => {
    expect(darkTheme().label).toBe("dark");
  });
});

describe("light mode", () => {
  test("light mode reports the light label", () => {
    expect(applyTheme("light").label).toBe("light");
  });

  test("light mode calls lightTheme directly", () => {
    expect(lightTheme().label).toBe("light");
  });
});
