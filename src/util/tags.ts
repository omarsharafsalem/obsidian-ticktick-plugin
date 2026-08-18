/**
 * Unicode-aware tag parsing.
 *
 * The common failure in existing TickTick plugins is a tag pattern built from
 * `\p{L}` and `\p{N}` alone:
 *
 *     /(^|\s)#[\p{L}\p{N}_/-]+/gu
 *
 * Neither property matches emoji, so `#work🔥` silently truncates to `work` and
 * `#🔥` does not match at all. Emoji live in `\p{Extended_Pictographic}`, and a
 * single visible emoji is frequently a *sequence*: a base character plus skin
 * tone modifiers, variation selectors, zero-width joiners, keycap combining
 * marks, regional indicator pairs, or tag characters for subdivision flags.
 * All of those have to be inside the character class or the tag is cut short at
 * the first one.
 */

/** One character that may appear inside a tag body. */
const TAG_CHAR = [
	// Letters, combining marks, digits and the separators Obsidian allows.
	String.raw`[\p{L}\p{M}\p{N}_\-/]`,
	// Emoji base characters.
	String.raw`\p{Extended_Pictographic}`,
	// Skin tone modifiers (U+1F3FB–U+1F3FF).
	String.raw`\p{Emoji_Modifier}`,
	// ZWJ (200D), variation selectors (FE0E/FE0F) and the keycap mark (20E3).
	String.raw`[\u200D\uFE0E\uFE0F\u20E3]`,
	// Regional indicators, which pair up to form flags.
	String.raw`[\u{1F1E6}-\u{1F1FF}]`,
	// Tag characters used by subdivision flags (England, Scotland, Wales).
	String.raw`[\u{E0020}-\u{E007F}]`,
].join("|");

/**
 * Matches a hashtag at a word boundary.
 *
 * The lookbehind keeps us from matching the fragment in `https://x.dev/#top`,
 * and requiring at least one tag character after `#` means markdown headings
 * (`# Heading`, `## Subtasks`) never match — a space is not a tag character.
 */
export const TAG_PATTERN = new RegExp(String.raw`(?<=^|\s)#((?:${TAG_CHAR})+)`, "gu");

/** Same body, anchored, for validating a bare tag name that has no `#`. */
export const TAG_NAME_PATTERN = new RegExp(String.raw`^(?:${TAG_CHAR})+$`, "u");

/** Obsidian rejects tags made only of digits, since they read as numbers. */
const ALL_DIGITS = /^[\p{N}_\-/]+$/u;

const FENCED_CODE = /^(?:```|~~~)/;

/**
 * Blanks out inline code spans, preserving offsets so that indices stay valid
 * for callers that need them.
 */
function maskInlineCode(line: string): string {
	return line.replace(/`[^`]*`/g, (match) => " ".repeat(match.length));
}

/** Strips fenced code blocks, which must never contribute tags. */
function contentLines(text: string): string[] {
	const lines = text.split("\n");
	const result: string[] = [];
	let inFence = false;

	for (const line of lines) {
		if (FENCED_CODE.test(line.trim())) {
			inFence = !inFence;
			continue;
		}
		result.push(inFence ? "" : maskInlineCode(line));
	}

	return result;
}

export function isValidTagName(tag: string): boolean {
	const bare = tag.startsWith("#") ? tag.slice(1) : tag;
	if (!bare) return false;
	if (ALL_DIGITS.test(bare)) return false;
	return TAG_NAME_PATTERN.test(bare);
}

/** Normalises a tag for storage: no leading `#`, no surrounding whitespace. */
export function normaliseTag(tag: string): string {
	return tag.trim().replace(/^#+/, "").trim();
}

/**
 * Extracts every hashtag from markdown text, in order, without duplicates.
 * Returned tags carry no leading `#`.
 */
export function extractTags(text: string): string[] {
	const seen = new Set<string>();
	const tags: string[] = [];

	for (const line of contentLines(text)) {
		for (const match of line.matchAll(TAG_PATTERN)) {
			const tag = match[1];
			if (!isValidTagName(tag)) continue;
			// TickTick treats tags case-insensitively; keep first-seen casing.
			const key = tag.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			tags.push(tag);
		}
	}

	return tags;
}

/** Removes hashtags from text, collapsing the whitespace they leave behind. */
export function stripTags(text: string): string {
	let inFence = false;

	return text
		.split("\n")
		.map((line) => {
			if (FENCED_CODE.test(line.trim())) {
				inFence = !inFence;
				return line;
			}
			if (inFence) return line;

			// Inline code is masked for matching only; the original text is kept.
			return line
				.replace(TAG_PATTERN, (match, _tag, offset: number) =>
					isInsideInlineCode(line, offset) ? match : "",
				)
				.replace(/[ \t]{2,}/g, " ")
				.trimEnd();
		})
		.join("\n");
}

/** True when `offset` falls inside a backtick-delimited span on `line`. */
function isInsideInlineCode(line: string, offset: number): boolean {
	let ticks = 0;
	for (let i = 0; i < offset; i++) {
		if (line[i] === "`") ticks++;
	}
	return ticks % 2 === 1;
}

export function formatTag(tag: string): string {
	return `#${normaliseTag(tag)}`;
}

/** Splits a comma- or space-separated frontmatter tag string into tag names. */
export function parseTagList(value: string): string[] {
	return value
		.split(/[,\n]/)
		.flatMap((part) => (part.includes("#") ? part.split(/\s+/) : [part]))
		.map(normaliseTag)
		.filter((tag) => tag.length > 0 && isValidTagName(tag));
}
