/**
 * Minimal stand-in for the `obsidian` module, which ships type declarations
 * only and has no runtime entry point.
 *
 * Just enough surface for the pure modules under test to import cleanly. The
 * YAML helpers are real, so frontmatter round-trips are genuinely exercised;
 * everything else is inert.
 */
import { parse, stringify } from "yaml";

export function parseYaml(input: string): unknown {
	return parse(input);
}

export function stringifyYaml(value: unknown): string {
	return stringify(value);
}

export function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}

export function debounce<T extends (...args: never[]) => unknown>(fn: T): T {
	return fn;
}

export class TFile {
	path = "";
	/** Filename without the extension. */
	basename = "";
	/** Filename with it — a separate field in Obsidian, and read as one. */
	name = "";
	extension = "md";
	stat = { mtime: 0, ctime: 0, size: 0 };
}

export class TFolder {
	path = "";
	children: unknown[] = [];
}

export class Notice {
	constructor(public message: string) {}
}

export class Plugin {}
export class PluginSettingTab {}
export class Modal {}
export class Setting {}

export const Platform = { isDesktopApp: false, isMobile: true };

export async function requestUrl(): Promise<never> {
	throw new Error("requestUrl is not available in tests");
}

export type App = unknown;
export type RequestUrlParam = unknown;
export type RequestUrlResponse = unknown;
