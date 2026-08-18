import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type TickTickSyncSettings } from "../src/settings";
import {
	describeSettingsChanges,
	parseSettingsDocument,
	renderSettingsDocument,
	settingsFromDocument,
} from "../src/settingsDocument";

/**
 * A configuration you can read before you apply it. The two things that must
 * hold whatever else changes: the note never carries credentials out, and an
 * import never carries credentials — or a decision to start syncing — in.
 */
function settings(overrides: Partial<TickTickSyncSettings> = {}): TickTickSyncSettings {
	return {
		...DEFAULT_SETTINGS,
		auth: {
			personalToken: "tk_live_secret",
			clientId: "client-id",
			clientSecret: "client-secret",
			tokens: { accessToken: "access", refreshToken: "refresh", expiresAt: 1 },
			loopbackPort: 8484,
		},
		...overrides,
	};
}

describe("exporting settings to a note", () => {
	it("leaves every credential out", () => {
		const note = renderSettingsDocument(settings());

		expect(note).not.toContain("tk_live_secret");
		expect(note).not.toContain("client-secret");
		expect(note).not.toContain("client-id");
		expect(note).not.toContain("refresh");
		expect(parseSettingsDocument(note).auth).toBeUndefined();
	});

	it("says whether syncing is on without making it importable", () => {
		expect(renderSettingsDocument(settings({ syncingStarted: true }))).toContain("**started**");
		expect(renderSettingsDocument(settings())).toContain("**not started**");
		expect(parseSettingsDocument(renderSettingsDocument(settings())).syncingStarted).toBeUndefined();
	});

	it("round-trips the configuration itself", () => {
		const original = settings({
			taskFolder: "Work/Tasks",
			taskMarker: { property: "note_type", value: "task" },
			projectFilter: ["list-a", "list-b"],
			labels: {
				...DEFAULT_SETTINGS.labels,
				status: { todo: ["⏳ Not Done"], completed: ["✅ Done"], abandoned: ["🚫 Not Doing"] },
			},
		});

		const applied = settingsFromDocument(renderSettingsDocument(original), settings());

		expect(applied.taskFolder).toBe("Work/Tasks");
		expect(applied.taskMarker).toEqual({ property: "note_type", value: "task" });
		expect(applied.projectFilter).toEqual(["list-a", "list-b"]);
		expect(applied.labels.status.todo).toEqual(["⏳ Not Done"]);
	});
});

describe("importing settings from a note", () => {
	function noteWith(config: Record<string, unknown>): string {
		return ["# Settings", "", "```json", JSON.stringify(config), "```", ""].join("\n");
	}

	it("cannot set credentials, whatever the note says", () => {
		const current = settings();
		const applied = settingsFromDocument(
			noteWith({
				taskFolder: "Tasks",
				auth: {
					personalToken: "tk_attacker",
					clientId: "theirs",
					clientSecret: "theirs",
					tokens: { accessToken: "theirs", refreshToken: "theirs", expiresAt: 1 },
				},
			}),
			current,
		);

		expect(applied.auth).toEqual(current.auth);
	});

	it("cannot start syncing", () => {
		const applied = settingsFromDocument(
			noteWith({ syncingStarted: true }),
			settings({ syncingStarted: false }),
		);
		expect(applied.syncingStarted).toBe(false);
	});

	it("cannot pause syncing either", () => {
		const applied = settingsFromDocument(
			noteWith({ syncingStarted: false }),
			settings({ syncingStarted: true }),
		);
		expect(applied.syncingStarted).toBe(true);
	});

	it("tolerates the older shapes mergeSettings knows about", () => {
		const applied = settingsFromDocument(
			noteWith({ labels: { status: { todo: "⏳ Not Done" } } }),
			settings(),
		);
		expect(applied.labels.status.todo).toEqual(["⏳ Not Done"]);
	});

	it("says what an import would change", () => {
		const current = settings({ taskFolder: "Tasks", syncIntervalMinutes: 5 });
		const next = settings({ taskFolder: "Work/Tasks", syncIntervalMinutes: 5 });

		expect(describeSettingsChanges(current, next)).toEqual(["taskFolder"]);
		expect(describeSettingsChanges(current, current)).toEqual([]);
	});

	// The usual cause is a hand edit, and the message is the only clue on offer.
	it("explains itself when the note cannot be read", () => {
		expect(() => parseSettingsDocument("# Nothing here")).toThrow(/no ```json settings block/i);
		expect(() => parseSettingsDocument(noteWith({}).replace("{}", "{oops"))).toThrow(
			/not valid JSON/i,
		);
		expect(() => parseSettingsDocument(["```json", "[1, 2]", "```"].join("\n"))).toThrow(
			/must be a JSON object/i,
		);
	});
});
