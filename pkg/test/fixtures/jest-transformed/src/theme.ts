interface Theme {
  label: string;
}

function applyTheme(mode: string): Theme {
  if (mode === "dark") {
    return darkTheme();
  }
  return lightTheme();
}

function darkTheme(): Theme {
  const label: string = "dark";
  return { label };
}

function lightTheme(): Theme {
  const label: string = "light";
  return { label };
}

module.exports = { applyTheme, darkTheme, lightTheme };
