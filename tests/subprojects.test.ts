import { describe, expect, it } from "vitest";
import { normaliseSection, normaliseTask, serialiseTask } from "../src/api/openApi";
import { blankTask, type Task } from "../src/api/types";
import { DEFAULT_PROPERTIES } from "../src/settings";
import { DEFAULT_MAPPER_OPTIONS, noteToTask, taskToNote } from "../src/sync/mapper";

const P = DEFAULT_PROPERTIES;

function task(overrides: Partial<Task> = {}): Task {
	return { ...blankTask("p1"), id: "t1", title: "Write the spec", ...overrides };
}

// A TickTick folder is an *area*, and a list is a project — so neither can say
// which sub-project a task belongs to. A section can: it is the only container
// below a list, and it travels with the task on the wire.
describe("reading a section off the wire", () => {
	it("keeps the section's id and its name", () => {
		const t = normaliseTask({
			id: "t1",
			projectId: "p1",
			title: "Probe",
			columnId: "c1",
			columnName: "Sub-project probe",
		});
		expect(t.columnId).toBe("c1");
		expect(t.columnName).toBe("Sub-project probe");
	});

	it("reads the sections a list returns alongside its tasks", () => {
		expect(normaliseSection({ id: "c1", projectId: "p1", name: "Build" })).toEqual({
			id: "c1",
			projectId: "p1",
			name: "Build",
		});
	});
});

describe("writing the sub-project onto a note", () => {
	it("writes the section's name", () => {
		const note = taskToNote(task({ columnId: "c1", columnName: "Build" }));
		expect(note.frontmatter[P.subproject]).toBe("Build");
	});

	it("writes a link when the section has a note, so backlinks gather the work", () => {
		const note = taskToNote(task({ columnId: "c1", columnName: "Build" }), undefined, {
			subprojectLink: { title: "🚀 TickTick Plugin" },
		});
		expect(note.frontmatter[P.subproject]).toBe("[[🚀 TickTick Plugin]]");
	});

	// The rule that matters. `NoteRepository.write` deletes any managed property
	// absent from the write, so a task in no section would otherwise erase a
	// sub-project set by hand — on every single sync, silently.
	it("keeps a sub-project the task itself knows nothing about", () => {
		const note = taskToNote(task(), undefined, { currentSubproject: "[[🚀 TickTick Plugin]]" });
		expect(note.frontmatter[P.subproject]).toBe("[[🚀 TickTick Plugin]]");
	});

	it("writes nothing at all when there is neither a section nor an existing value", () => {
		expect(taskToNote(task()).frontmatter).not.toHaveProperty(P.subproject);
	});

	it("lets the task's own section win over what the note used to say", () => {
		const note = taskToNote(task({ columnId: "c2", columnName: "Ship" }), undefined, {
			currentSubproject: "Build",
		});
		expect(note.frontmatter[P.subproject]).toBe("Ship");
	});
});

describe("reading the sub-project back off a note", () => {
	const parse = (value: string, resolve?: (n: string) => string | undefined) =>
		noteToTask(
			{ frontmatter: { [P.id]: "t1", [P.subproject]: value }, body: "" },
			"Write the spec",
			{ ...DEFAULT_MAPPER_OPTIONS, properties: P, resolveSection: resolve },
		);

	it("resolves a plain name to the section's id", () => {
		expect(parse("Build", (n) => (n === "Build" ? "c1" : undefined)).columnId).toBe("c1");
	});

	it("resolves a link by its target, not its raw text", () => {
		expect(parse("[[Build]]", (n) => (n === "Build" ? "c1" : undefined)).columnId).toBe("c1");
	});

	// Two lists may name a section alike, and filing a task under the wrong
	// sub-project is worse than leaving the property for a person to settle.
	it("refuses to guess when the name resolves to nothing", () => {
		expect(parse("Build", () => undefined).columnId).toBeUndefined();
	});
});

describe("sending the section back", () => {
	it("sends the section when there is one", () => {
		const body = serialiseTask(task({ columnId: "c1" })) as Record<string, unknown>;
		expect(body["columnId"]).toBe("c1");
	});

	// "We could not work out which section" is not "no section". Sending an empty
	// value would move the task out of whatever section it is filed under.
	it("sends nothing when the section is unknown", () => {
		const body = serialiseTask(task()) as Record<string, unknown>;
		expect(body).not.toHaveProperty("columnId");
	});
});
