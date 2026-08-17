import { beforeEach, describe, expect, it, vi } from "vitest";

const requestUrl = vi.fn();

vi.mock("obsidian", () => ({ requestUrl: (params: unknown) => requestUrl(params) }));

const { ApiError, HttpQueue } = await import("../src/api/http");

/** A wrong password, exactly as TickTick reports it: HTTP 500, not a 4xx. */
const WRONG_PASSWORD = {
	status: 500,
	text: '{"errorId":"wwxkkfmw@tw9","errorCode":"incorrect_password","errorMessage":"incorrect_password","data":null}',
};

const LOCKED_OUT = {
	status: 500,
	text: '{"errorId":"wwxkkfmw@tw9","errorCode":"incorrect_password_too_many_times","errorMessage":"incorrect_password_too_many_times","data":null}',
};

function queue(maxRetries = 4): InstanceType<typeof HttpQueue> {
	return new HttpQueue({ concurrency: 3, minIntervalMs: 0, maxRetries });
}

describe("HttpQueue retries", () => {
	beforeEach(() => {
		requestUrl.mockReset();
	});

	it("retries a genuine server error", async () => {
		requestUrl
			.mockResolvedValueOnce({ status: 503, text: "upstream unavailable" })
			.mockResolvedValueOnce({ status: 200, text: "{}" });

		const response = await queue().request({ url: "https://example.test/x" });

		expect(response.status).toBe(200);
		expect(requestUrl).toHaveBeenCalledTimes(2);
	});

	// The bug this guards: TickTick reports a wrong password as a 500, so a
	// blanket 5xx retry fired five sign-in attempts per click and locked the
	// account after a couple of tries.
	it("does not retry a wrong password reported as a 500", async () => {
		requestUrl.mockResolvedValue(WRONG_PASSWORD);

		await expect(queue().request({ url: "https://example.test/signon" })).rejects.toThrow(
			ApiError,
		);
		expect(requestUrl).toHaveBeenCalledTimes(1);
	});

	it("does not retry a lockout, which would deepen it", async () => {
		requestUrl.mockResolvedValue(LOCKED_OUT);

		await expect(queue().request({ url: "https://example.test/signon" })).rejects.toThrow(
			ApiError,
		);
		expect(requestUrl).toHaveBeenCalledTimes(1);
	});

	it("honours a per-request retry budget of zero", async () => {
		requestUrl.mockResolvedValue({ status: 503, text: "upstream unavailable" });

		await expect(
			queue().request({ url: "https://example.test/signon" }, { maxRetries: 0 }),
		).rejects.toThrow(ApiError);
		expect(requestUrl).toHaveBeenCalledTimes(1);
	});

	it("still gives up after the configured number of retries", async () => {
		requestUrl.mockResolvedValue({ status: 500, text: "boom" });

		await expect(queue(2).request({ url: "https://example.test/x" })).rejects.toThrow(ApiError);
		expect(requestUrl).toHaveBeenCalledTimes(3);
	});

	it("never retries a 4xx", async () => {
		requestUrl.mockResolvedValue({ status: 404, text: "not found" });

		await expect(queue().request({ url: "https://example.test/x" })).rejects.toThrow(ApiError);
		expect(requestUrl).toHaveBeenCalledTimes(1);
	});
});

describe("ApiError classification", () => {
	it("recognises a credential failure and a lockout", () => {
		const locked = new ApiError(500, "https://example.test/signon", LOCKED_OUT.text);
		expect(locked.isCredentialFailure).toBe(true);
		expect(locked.isLockout).toBe(true);

		const wrong = new ApiError(500, "https://example.test/signon", WRONG_PASSWORD.text);
		expect(wrong.isCredentialFailure).toBe(true);
		expect(wrong.isLockout).toBe(false);
	});

	it("leaves an ordinary server error alone", () => {
		const server = new ApiError(500, "https://example.test/x", "internal error");
		expect(server.isCredentialFailure).toBe(false);
		expect(server.isLockout).toBe(false);
	});
});
