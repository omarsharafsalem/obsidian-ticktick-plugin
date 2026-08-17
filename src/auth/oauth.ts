import { Platform } from "obsidian";
import { HttpQueue } from "../api/http";

export const AUTHORIZE_URL = "https://ticktick.com/oauth/authorize";
export const TOKEN_URL = "https://ticktick.com/oauth/token";
export const OAUTH_SCOPES = "tasks:read tasks:write";

/** Port used by the loopback redirect listener on desktop. */
export const DEFAULT_LOOPBACK_PORT = 8484;

export interface OAuthTokens {
	accessToken: string;
	/** TickTick does not always issue one; absence means "re-authorise on expiry". */
	refreshToken?: string;
	/** Epoch milliseconds, or undefined when the server gave no expiry. */
	expiresAt?: number;
	scope?: string;
}

export interface OAuthConfig {
	clientId: string;
	clientSecret: string;
	redirectUri: string;
}

export function loopbackRedirectUri(port: number = DEFAULT_LOOPBACK_PORT): string {
	return `http://localhost:${port}/callback`;
}

export function buildAuthorizeUrl(config: OAuthConfig, state: string): string {
	const params = new URLSearchParams({
		client_id: config.clientId,
		scope: OAUTH_SCOPES,
		state,
		redirect_uri: config.redirectUri,
		response_type: "code",
	});
	return `${AUTHORIZE_URL}?${params.toString()}`;
}

export function randomState(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Pulls the `code` parameter out of whatever the user pasted — we accept either
 * a bare code or the whole redirected URL, because after a failed loopback
 * handoff the address bar is the only place the code survives.
 */
export function extractAuthCode(input: string): string | null {
	const trimmed = input.trim();
	if (!trimmed) return null;

	if (trimmed.includes("://") || trimmed.includes("?")) {
		try {
			const url = new URL(trimmed.includes("://") ? trimmed : `http://localhost/?${trimmed}`);
			const code = url.searchParams.get("code");
			if (code) return code;
		} catch {
			// Fall through and treat the input as a bare code.
		}
	}

	return /^[A-Za-z0-9._-]+$/.test(trimmed) ? trimmed : null;
}

function parseTokenResponse(payload: Record<string, unknown>): OAuthTokens {
	const accessToken = payload["access_token"];
	if (typeof accessToken !== "string" || !accessToken) {
		throw new Error("TickTick token response did not contain an access_token");
	}

	const expiresIn = payload["expires_in"];
	return {
		accessToken,
		refreshToken: typeof payload["refresh_token"] === "string" ? payload["refresh_token"] : undefined,
		expiresAt: typeof expiresIn === "number" ? Date.now() + expiresIn * 1000 : undefined,
		scope: typeof payload["scope"] === "string" ? payload["scope"] : undefined,
	};
}

async function postToken(
	queue: HttpQueue,
	config: OAuthConfig,
	body: Record<string, string>,
): Promise<OAuthTokens> {
	// TickTick expects client credentials via HTTP Basic auth on the token
	// endpoint; passing them in the body alone is rejected.
	const basic = btoa(`${config.clientId}:${config.clientSecret}`);

	const response = await queue.request({
		url: TOKEN_URL,
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Authorization: `Basic ${basic}`,
		},
		body: new URLSearchParams(body).toString(),
	});

	return parseTokenResponse(response.json as Record<string, unknown>);
}

export async function exchangeAuthCode(
	queue: HttpQueue,
	config: OAuthConfig,
	code: string,
): Promise<OAuthTokens> {
	return postToken(queue, config, {
		grant_type: "authorization_code",
		code,
		scope: OAUTH_SCOPES,
		redirect_uri: config.redirectUri,
	});
}

export async function refreshTokens(
	queue: HttpQueue,
	config: OAuthConfig,
	refreshToken: string,
): Promise<OAuthTokens> {
	const refreshed = await postToken(queue, config, {
		grant_type: "refresh_token",
		refresh_token: refreshToken,
		scope: OAUTH_SCOPES,
	});

	// Some providers omit the refresh token on rotation; keep the old one so we
	// do not lose the ability to refresh again.
	return { ...refreshed, refreshToken: refreshed.refreshToken ?? refreshToken };
}

export function tokensNeedRefresh(tokens: OAuthTokens | null, skewMs = 5 * 60 * 1000): boolean {
	if (!tokens) return false;
	if (tokens.expiresAt === undefined) return false;
	return Date.now() >= tokens.expiresAt - skewMs;
}

/**
 * Waits for TickTick to redirect back to `http://localhost:<port>/callback`.
 *
 * Desktop only — it needs Node's http module, which the mobile app does not
 * have. Callers must fall back to the manual code-paste flow when this returns
 * null.
 */
export async function awaitLoopbackCode(
	port: number,
	expectedState: string,
	timeoutMs = 5 * 60 * 1000,
): Promise<string | null> {
	// Electron exposes `require` on the global object; the mobile app does not.
	const nodeRequire = (globalThis as unknown as { require?: (id: string) => unknown }).require;
	if (!Platform.isDesktopApp || typeof nodeRequire !== "function") {
		return null;
	}

	type NodeHttp = {
		createServer: (handler: (req: unknown, res: unknown) => void) => {
			listen: (port: number, host: string, cb: () => void) => void;
			close: (cb?: () => void) => void;
			on: (event: string, cb: (error: Error) => void) => void;
		};
	};

	let http: NodeHttp;
	try {
		http = nodeRequire("http") as NodeHttp;
	} catch {
		return null;
	}

	return new Promise<string | null>((resolve) => {
		let settled = false;
		const finish = (value: string | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			server.close();
			resolve(value);
		};

		const server = http.createServer((req, res) => {
			const request = req as { url?: string };
			const response = res as {
				writeHead: (status: number, headers: Record<string, string>) => void;
				end: (body: string) => void;
			};

			const requestUrl = new URL(request.url ?? "/", `http://localhost:${port}`);
			if (requestUrl.pathname !== "/callback") {
				response.writeHead(404, { "Content-Type": "text/plain" });
				response.end("Not found");
				return;
			}

			const code = requestUrl.searchParams.get("code");
			const state = requestUrl.searchParams.get("state");
			const ok = Boolean(code) && state === expectedState;

			response.writeHead(ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" });
			response.end(
				ok
					? "<html><body><h2>TickTick connected.</h2><p>You can close this tab and return to Obsidian.</p></body></html>"
					: "<html><body><h2>Authorisation failed.</h2><p>Return to Obsidian and paste the code manually.</p></body></html>",
			);

			finish(ok ? code : null);
		});

		server.on("error", () => finish(null));

		const timer = setTimeout(() => finish(null), timeoutMs);

		try {
			server.listen(port, "127.0.0.1", () => {
				/* listening */
			});
		} catch {
			finish(null);
		}
	});
}
