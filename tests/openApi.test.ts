import { describe, expect, it } from "vitest";
import { normaliseProject, normaliseTask, serialiseTask } from "../src/api/openApi";

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

/**
 * Both fields come straight off a real account: three of the user's lists are
 * notes lists, and any list can be archived. Neither was being read, so a notes
 * list synced as if it were full of tasks and an archived one looked like a
 * list whose every task had just been deleted.
 */
describe("lists", () => {
	it("reads the kind so a notes list can be told from a task list", () => {
		expect(normaliseProject({ id: "p1", name: "Career Notes", kind: "NOTE" }).kind).toBe("NOTE");
		expect(normaliseProject({ id: "p2", name: "Errands", kind: "TASK" }).kind).toBe("TASK");
	});

	it("leaves an unrecognised kind unset rather than guessing", () => {
		expect(normaliseProject({ id: "p1", name: "Odd", kind: "SOMETHING_NEW" }).kind).toBeUndefined();
		expect(normaliseProject({ id: "p1", name: "Odd" }).kind).toBeUndefined();
	});

	it("reads whether a list is archived", () => {
		expect(normaliseProject({ id: "p1", name: "Old project", closed: true }).closed).toBe(true);
		expect(normaliseProject({ id: "p2", name: "Live project", closed: false }).closed).toBe(false);
	});

	// TickTick omits `closed` on an ordinary list, and an absent flag must not
	// read as archived — that would skip every list the account has.
	it("treats a missing archived flag as not archived", () => {
		expect(normaliseProject({ id: "p1", name: "Errands" }).closed).toBe(false);
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

	/**
	 * The bug this guards: an all-day date was read off the UTC form, so a task
	 * due the 20th at London midnight (23:00Z on the 19th) rendered as the 19th.
	 */
	it("keeps an all-day date on the right day east of Greenwich", () => {
		const task = normaliseTask({
			id: "t1",
			isAllDay: true,
			timeZone: "Europe/London",
			dueDate: "2026-08-19T23:00:00.000+0000",
		});

		expect(task.dueDate?.slice(0, 10)).toBe("2026-08-20");
	});

	it("keeps an all-day date on the right day west of Greenwich", () => {
		const task = normaliseTask({
			id: "t1",
			isAllDay: true,
			timeZone: "America/Los_Angeles",
			dueDate: "2026-08-20T07:00:00.000+0000",
		});

		expect(task.dueDate?.slice(0, 10)).toBe("2026-08-20");
	});

	it("round-trips an all-day date back to the same calendar day", () => {
		for (const timeZone of ["Europe/London", "America/Los_Angeles", "Asia/Tokyo", "UTC"]) {
			const original = normaliseTask({
				id: "t1",
				isAllDay: true,
				timeZone,
				dueDate: "2026-08-19T23:00:00.000+0000",
			});

			const sent = serialiseTask(original) as { dueDate?: string };
			const returned = normaliseTask({ ...sent, id: "t1", isAllDay: true, timeZone });

			expect({ timeZone, day: returned.dueDate?.slice(0, 10) }).toEqual({
				timeZone,
				day: original.dueDate?.slice(0, 10),
			});
		}
	});

	it("leaves a timed date as a true instant", () => {
		const task = normaliseTask({
			id: "t1",
			isAllDay: false,
			timeZone: "Europe/London",
			dueDate: "2026-08-20T09:30:00.000+0000",
		});

		expect(task.dueDate).toBe("2026-08-20T09:30:00.000Z");
	});

	it("treats the epoch sentinel as no date", () => {
		expect(normaliseTask({ id: "t1", dueDate: "1970-01-01T00:00:00.000+0000" }).dueDate).toBeUndefined();
	});
});
