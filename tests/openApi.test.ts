import { describe, expect, it } from "vitest";
import { normaliseTask, serialiseTask } from "../src/api/openApi";

/**
 * TickTick returns both `content` and `desc` on every task, and the task's
 * `kind` decides which one holds the body a user actually sees. Writing only
 * `content` back — which the plugin used to do — erased the other field.
 */
describe("content and desc", () => {
	it("reads the body from content for a text task", () => {
		const task = normaliseTask({
			id: "t1",
			kind: "TEXT",
			content: "the body",
			desc: "something else",
		});

		expect(task.content).toBe("the body");
		expect(task.inactiveBody).toBe("something else");
	});

	it("reads the body from desc for a checklist task", () => {
		const task = normaliseTask({
			id: "t1",
			kind: "CHECKLIST",
			content: "something else",
			desc: "the body",
		});

		expect(task.content).toBe("the body");
		expect(task.inactiveBody).toBe("something else");
	});

	it("writes a text task's body back to content, preserving desc", () => {
		const body = serialiseTask(normaliseTask({ id: "t1", kind: "TEXT", content: "a", desc: "b" }));

		expect(body["content"]).toBe("a");
		expect(body["desc"]).toBe("b");
	});

	it("writes a checklist task's body back to desc, preserving content", () => {
		const body = serialiseTask(
			normaliseTask({ id: "t1", kind: "CHECKLIST", content: "a", desc: "b" }),
		);

		expect(body["desc"]).toBe("b");
		expect(body["content"]).toBe("a");
	});

	it("round-trips both fields unchanged for either kind", () => {
		for (const kind of ["TEXT", "CHECKLIST"] as const) {
			const original = { id: "t1", kind, content: "one", desc: "two" };
			const body = serialiseTask(normaliseTask(original));

			expect({ content: body["content"], desc: body["desc"] }).toEqual({
				content: "one",
				desc: "two",
			});
		}
	});

	it("falls back to content when the kind is absent", () => {
		const task = normaliseTask({ id: "t1", content: "the body" });
		expect(task.content).toBe("the body");
	});
});

describe("checklist items", () => {
	it("keeps item ids so an update edits rather than recreates them", () => {
		const task = normaliseTask({
			id: "t1",
			items: [
				{ id: "i1", title: "one", status: 1 },
				{ id: "i2", title: "two", status: 0 },
			],
		});

		expect(task.items).toEqual([
			{ id: "i1", title: "one", completed: true },
			{ id: "i2", title: "two", completed: false },
		]);

		const body = serialiseTask(task);
		expect(body["items"]).toEqual([
			{ id: "i1", title: "one", status: 1, sortOrder: 0 },
			{ id: "i2", title: "two", status: 0, sortOrder: 1 },
		]);
	});
});

describe("dates", () => {
	it("parses TickTick's basic-format offset and writes it back", () => {
		const task = normaliseTask({ id: "t1", dueDate: "2026-08-20T09:30:00.000+0000" });

		expect(task.dueDate).toBe("2026-08-20T09:30:00.000Z");
		expect(serialiseTask(task)["dueDate"]).toBe("2026-08-20T09:30:00.000+0000");
	});

	it("treats the epoch sentinel as no date", () => {
		expect(normaliseTask({ id: "t1", dueDate: "1970-01-01T00:00:00.000+0000" }).dueDate).toBeUndefined();
	});
});
