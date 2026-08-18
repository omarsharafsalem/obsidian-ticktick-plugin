/**
 * Hides chosen properties from Obsidian's Properties panel.
 *
 * The task id must stay in the note — it is what re-links a note to its task
 * after a reset, and the one thing that survives a title change — but it is
 * machine bookkeeping and nobody wants to look at it. That makes this a display
 * problem, and the fix is a style rule rather than moving the data somewhere
 * less durable.
 *
 * Only affects the rendered Properties panel. The raw YAML is still there in
 * Source mode, which is the honest behaviour: the data has not gone anywhere.
 */
const STYLE_ID = "ticktick-hidden-properties";

/** Escapes a property name for use inside a CSS attribute selector. */
function quote(name: string): string {
	return name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function applyHiddenProperties(names: string[]): void {
	const existing = document.getElementById(STYLE_ID);
	const wanted = names.map((name) => name.trim()).filter((name) => name.length > 0);

	if (wanted.length === 0) {
		existing?.remove();
		return;
	}

	const style = existing ?? document.createElement("style");
	style.id = STYLE_ID;

	style.textContent = wanted
		.map(
			(name) =>
				`.metadata-property[data-property-key="${quote(name)}"] { display: none !important; }`,
		)
		.join("\n");

	if (!existing) document.head.appendChild(style);
}

export function removeHiddenProperties(): void {
	document.getElementById(STYLE_ID)?.remove();
}
