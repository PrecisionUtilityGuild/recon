const { applyTheme, darkTheme, lightTheme } = require("../src/theme");

describe("dark mode", () => {
  test("dark mode uses a black background", () => {
    expect(applyTheme("dark").background).toBe("#000000");
  });

  test("dark mode reports the dark label", () => {
    expect(darkTheme().label).toBe("dark");
  });
});

describe("light mode", () => {
  test("light mode uses a white background", () => {
    expect(applyTheme("light").background).toBe("#ffffff");
  });

  test("light mode reports the light label", () => {
    expect(lightTheme().label).toBe("light");
  });
});
