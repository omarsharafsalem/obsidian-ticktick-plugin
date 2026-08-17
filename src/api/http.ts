import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from "obsidian";

export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly url: string,
		readonly body: string,
	) {
		super(`TickTick API ${status} for ${url}: ${body.slice(0, 300)}`);
		this.name = "ApiError";
	}

	get isNotFound(): boolean {
		return this.status === 404;
	}

	get isAuthFailure(): boolean {
		return this.status === 401 || this.status === 403;
	}
}

export interface HttpQueueOptions {
	/** Maximum requests in flight at once. TickTick throttles aggressively. */
	concurrency: number;
	/** Minimum spacing between request starts, in milliseconds. */
	minIntervalMs: number;
	/** How many times to retry a 429/5xx before giving up. */
	maxRetries: number;
}

export const DEFAULT_QUEUE_OPTIONS: HttpQueueOptions = {
	concurrency: 3,
	minIntervalMs: 120,
	maxRetries: 4,
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Serialises and paces outbound requests.
 *
 * TickTick has no published rate limit, but returns 429 well before you would
 * expect when syncing a large vault. A full sync of a few hundred tasks issues
 * one request per task, so pacing here is what keeps a first-run sync from
 * being throttled into failure.
 */
export class HttpQueue {
	private active = 0;
	private lastStart = 0;
	private readonly pending: Array<() => void> = [];

	constructor(private readonly options: HttpQueueOptions = DEFAULT_QUEUE_OPTIONS) {}

	async request(params: RequestUrlParam): Promise<RequestUrlResponse> {
		await this.acquire();
		try {
			return await this.executeWithRetry(params);
		} finally {
			this.release();
		}
	}

	private async executeWithRetry(params: RequestUrlParam): Promise<RequestUrlResponse> {
		let lastError: unknown;

		for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
			if (attempt > 0) {
				// Exponential backoff with a conservative ceiling.
				await sleep(Math.min(1000 * 2 ** (attempt - 1), 16_000));
			}

			let response: RequestUrlResponse;
			try {
				// `throw: false` keeps non-2xx responses out of the exception path so
				// that we can inspect the status and decide whether to retry.
				response = await requestUrl({ ...params, throw: false });
			} catch (error) {
				// Genuine transport failure (offline, DNS, TLS). Worth retrying.
				lastError = error;
				continue;
			}

			if (response.status < 400) {
				return response;
			}

			if (response.status === 429 || response.status >= 500) {
				lastError = new ApiError(response.status, params.url, response.text ?? "");
				continue;
			}

			throw new ApiError(response.status, params.url, response.text ?? "");
		}

		throw lastError instanceof Error
			? lastError
			: new Error(`Request to ${params.url} failed after retries`);
	}

	private async acquire(): Promise<void> {
		if (this.active >= this.options.concurrency) {
			await new Promise<void>((resolve) => this.pending.push(resolve));
		}
		this.active++;

		const wait = this.lastStart + this.options.minIntervalMs - Date.now();
		if (wait > 0) {
			await sleep(wait);
		}
		this.lastStart = Date.now();
	}

	private release(): void {
		this.active--;
		this.pending.shift()?.();
	}
}
