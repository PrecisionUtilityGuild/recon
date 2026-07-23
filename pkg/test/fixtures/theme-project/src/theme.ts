export interface Theme {
	background: string;
	foreground: string;
	label: string;
}

// Shared entry point: every applyTheme call runs this branch dispatch, so its
// lines are covered by BOTH the dark-mode tests and the light-mode tests.
export function applyTheme(mode: string): Theme {
	if (mode === "dark") {
		return darkTheme();
	}
	return lightTheme();
}

// The dark-mode feature. Only the dark-mode tests reach these lines, so they are
// covered exclusively by the feature set (exclusivity 1.0, [unique]).
export function darkTheme(): Theme {
	const background = "#000000";
	const foreground = "#e0e0e0";
	return { background, foreground, label: "dark" };
}

export function lightTheme(): Theme {
	const background = "#ffffff";
	const foreground = "#202020";
	return { background, foreground, label: "light" };
}
