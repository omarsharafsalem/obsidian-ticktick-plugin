import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
	resolve: {
		alias: {
			// `obsidian` ships types only — there is no runtime entry point. Tests
			// cover the pure modules, and this stub keeps an incidental import from
			// failing the whole suite.
			obsidian: fileURLToPath(new URL("./tests/stubs/obsidian.ts", import.meta.url)),
		},
	},
	test: {
		include: ["tests/**/*.test.ts"],
		environment: "node",
	},
});
