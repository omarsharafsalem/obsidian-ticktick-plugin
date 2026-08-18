import { describe, expect, it } from "vitest";
import type { HttpQueue } from "../src/api/http";
import { INBOX_PROJECT_ID, OpenApiClient, normaliseTask } from "../src/api/openApi";

/**
 * `GET /project/{id}/data` returns a real `modifiedTime` on every task.
 *
 * That contradicts how the Open API is usually described, and the plugin was
 * built on the belief that it did not — which cost "most recently edited wins"
 * entirely, since a conflict with no remote timestamp always falls to the
 * server. The values below were captured from the live API on 18 Aug 2026 with
 * a real personal token, so this file is the record that the field is there.
 */

const LIVE_TASK = {
	id: "6a834b048f08bb0249d3cbd5",
	projectId: "6a1f4c1e8f08a10000000001",
	title: "All day test",
	status: 0,
	priority: 0,
	tags: [],
	items: [],
	etag: "1xub5qe1",
	modifiedTime: "2026-08-17T19:01:17.084+0000",
};

describe("the modification time the Open API really does return", () => {
	it("survives normalisation into the task model", () => {
		expect(normaliseTask(LIVE_TASK).modifiedTime).toBe("2026-08-17T19:01:17.084Z");
	});

	// The offset is in basic format, which `Date` parses inconsistently, and the
	// milliseconds are the part most likely to be silently dropped — they are
	// also what separates two edits made in the same second.
	it("keeps the milliseconds rather than rounding them away", () => {
		const iso = normaliseTask(LIVE_TASK).modifiedTime;
		expect(new Date(iso!).getTime()).toBe(Date.parse("2026-08-17T19:01:17.084Z"));
	});

	it("reads a timestamp sent without milliseconds too", () => {
		const task = normaliseTask({ ...LIVE_TASK, modifiedTime: "2026-08-17T19:01:17+0000" });
		expect(task.modifiedTime).toBe("2026-08-17T19:01:17.000Z");
	});

	it("carries the etag through as well", () => {
		expect(normaliseTask(LIVE_TASK).etag).toBe("1xub5qe1");
	});

	it("leaves the time undefined when the field is absent", () => {
		expect(normaliseTask({ id: "t1" }).modifiedTime).toBeUndefined();
	});
});

interface Sent {
	url: string;
	method: string;
	body?: string;
}

function clientRecording(sent: Sent[], response: unknown) {
	const queue = {
		request: async (params: { url: string; method: string; body?: string }) => {
			sent.push({ url: params.url, method: params.method, body: params.body });
			return { text: JSON.stringify(response), json: response };
		},
	};

	return new OpenApiClient({
		getAccessToken: async () => "token",
		queue: queue as unknown as HttpQueue,
		baseUrl: "https://example.test/open/v1",
	});
}

describe("which endpoint each list is read from", () => {
	/**
	 * `POST /task/filter` answers 500 `unknown_exception` for a real project id,
	 * measured live on the same day. It is the Inbox's only route and nothing
	 * else's, so an ordinary list must not be sent through it.
	 */
	it("reads an ordinary list from the per-project data endpoint", async () => {
		const sent: Sent[] = [];
		await clientRecording(sent, { tasks: [LIVE_TASK] }).listTasksInProject("p1");

		expect(sent).toHaveLength(1);
		expect(sent[0].method).toBe("GET");
		expect(sent[0].url).toBe("https://example.test/open/v1/project/p1/data");
	});

	it("still reaches the Inbox through the filter endpoint", async () => {
		const sent: Sent[] = [];
		await clientRecording(sent, []).listTasksInProject(INBOX_PROJECT_ID);

		expect(sent[0].method).toBe("POST");
		expect(sent[0].url).toBe("https://example.test/open/v1/task/filter");
		expect(JSON.parse(sent[0].body ?? "{}").projectIds).toEqual([INBOX_PROJECT_ID]);
	});

	it("hands the modification time on from the list it read", async () => {
		const { tasks } = await clientRecording([], { tasks: [LIVE_TASK] }).listTasksInProject("p1");

		expect(tasks[0].modifiedTime).toBe("2026-08-17T19:01:17.084Z");
	});

	// The capability is what tells the engine the timestamp is worth reading.
	it("declares that it reports a modification time", () => {
		expect(clientRecording([], []).capabilities.modifiedTime).toBe(true);
	});
});
