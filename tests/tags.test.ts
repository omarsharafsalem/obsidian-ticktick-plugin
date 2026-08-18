import { describe, expect, it } from "vitest";
import { extractTags, isValidTagName, parseTagList, stripTags } from "../src/util/tags";

/**
 * The regression these tests exist for: the tag pattern used by existing
 * TickTick plugins is `/(^|\s)#[\p{L}\p{N}_/-]+/gu`, which matches no emoji at
 * all. Each emoji case below fails against that pattern.
 */
describe("extractTags — emoji", () => {
	it("keeps an emoji suffixed to a word", () => {
		expect(extractTags("call the vet #pets🐕 today")).toEqual(["pets🐕"]);
	});

	it("matches a tag made only of an emoji", () => {
		expect(extractTags("groceries #🛒")).toEqual(["🛒"]);
	});

	it("keeps an emoji prefixed to a word", () => {
		expect(extractTags("#🔥urgent ship it")).toEqual(["🔥urgent"]);
	});

	it("keeps a presentation variation selector attached", () => {
		// U+2764 U+FE0F — heart with emoji presentation.
		expect(extractTags("#love❤️")).toEqual(["love❤️"]);
	});

	it("keeps a skin tone modifier attached", () => {
		// U+1F44D U+1F3FD — thumbs up, medium skin tone.
		expect(extractTags("#ok\u{1F44D}\u{1F3FD}")).toEqual(["ok\u{1F44D}\u{1F3FD}"]);
	});

	it("keeps a ZWJ sequence intact", () => {
		// Family: man + ZWJ + woman + ZWJ + girl.
		const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
		expect(extractTags(`#home${family}`)).toEqual([`home${family}`]);
	});

	it("keeps a regional indicator flag intact", () => {
		// Regional indicators D + E.
		const flag = "\u{1F1E9}\u{1F1EA}";
		expect(extractTags(`#trip${flag}`)).toEqual([`trip${flag}`]);
	});

	it("keeps a keycap sequence intact", () => {
		expect(extractTags("#priority1️⃣")).toEqual(["priority1️⃣"]);
	});

	it("handles several emoji tags on one line", () => {
		expect(extractTags("#work💼 and #home🏠 and #🎯")).toEqual(["work💼", "home🏠", "🎯"]);
	});
});

describe("extractTags — general behaviour", () => {
	it("finds plain tags", () => {
		expect(extractTags("a #one and #two/nested here")).toEqual(["one", "two/nested"]);
	});

	it("matches a tag at the very start of the text", () => {
		expect(extractTags("#first thing")).toEqual(["first"]);
	});

	it("ignores markdown headings", () => {
		expect(extractTags("# Heading\n## Subtasks\n### Deep")).toEqual([]);
	});

	it("ignores URL fragments", () => {
		expect(extractTags("see https://example.com/docs#anchor")).toEqual([]);
	});

	it("ignores tags inside inline code", () => {
		expect(extractTags("use `#notatag` please #real")).toEqual(["real"]);
	});

	it("ignores tags inside fenced code blocks", () => {
		const text = ["before #keep", "```", "#ignored", "```", "after #alsokeep"].join("\n");
		expect(extractTags(text)).toEqual(["keep", "alsokeep"]);
	});

	it("rejects purely numeric tags", () => {
		expect(extractTags("#2026 and #q1")).toEqual(["q1"]);
	});

	it("deduplicates case-insensitively, keeping first casing", () => {
		expect(extractTags("#Work then #work")).toEqual(["Work"]);
	});

	it("supports non-latin scripts", () => {
		expect(extractTags("#مهمة and #タスク and #задача")).toEqual(["مهمة", "タスク", "задача"]);
	});
});

describe("isValidTagName", () => {
	it("accepts emoji tags with or without a leading hash", () => {
		expect(isValidTagName("#🛒")).toBe(true);
		expect(isValidTagName("pets🐕")).toBe(true);
	});

	it("rejects empty, numeric and space-containing names", () => {
		expect(isValidTagName("")).toBe(false);
		expect(isValidTagName("2026")).toBe(false);
		expect(isValidTagName("two words")).toBe(false);
	});
});

describe("stripTags", () => {
	it("removes tags and tidies the whitespace", () => {
		expect(stripTags("buy milk #errands🛒 today")).toBe("buy milk today");
	});

	it("leaves fenced code untouched", () => {
		const text = ["```", "#ignored", "```"].join("\n");
		expect(stripTags(text)).toBe(text);
	});
});

describe("parseTagList", () => {
	it("parses comma separated values", () => {
		expect(parseTagList("work, home🏠 , urgent")).toEqual(["work", "home🏠", "urgent"]);
	});

	it("parses hash-prefixed space separated values", () => {
		expect(parseTagList("#work #home🏠")).toEqual(["work", "home🏠"]);
	});
});
