#!/usr/bin/env node
/*
 * Launch the app from here.
 *
 *   npm run app
 *
 * The launcher lives in the fork, because that is where Electron and the built
 * renderer are. This exists because half the work happens in this repo and
 * "cd ../openscreen && npm run app" is one more thing to know — asked twice, which
 * is the definition of a thing that should not need asking.
 *
 * A thin delegate on purpose: everything load-bearing about starting the app (the
 * stripped ELECTRON_RUN_AS_NODE, NODE_ENV, RM_STUDIO_BIN, and the three different
 * refusals for an unbuilt renderer, a missing Electron and a second instance) stays
 * in one place over there rather than being reimplemented here to drift.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const fork = process.env.RM_OPENSCREEN_FORK
	? resolve(process.env.RM_OPENSCREEN_FORK)
	: resolve(ROOT, "..", "openscreen");
const launcher = join(fork, "scripts", "launch.mjs");

if (!existsSync(launcher)) {
	console.error(`\n  no OpenScreen checkout at ${fork}\n`);
	console.error("  npm run forks              # clone it beside this repo");
	console.error("  RM_OPENSCREEN_FORK=<path> npm run app    # or say where it is\n");
	process.exit(1);
}

// Its own cwd, because it resolves the renderer, Electron and the Studio relative
// to itself and every one of those is wrong from here.
const child = spawn(process.execPath, [launcher, ...process.argv.slice(2)], {
	cwd: fork,
	stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (err) => {
	console.error(`\n  could not start the launcher: ${err.message}\n`);
	process.exit(1);
});
