#!/usr/bin/env node
/**
 * rm-setup — get a machine from nothing to a working pipeline.
 *
 *   rm-setup            do whatever is missing
 *   rm-setup --check    say what is missing, change nothing
 *   rm-setup --yes      do not stop to confirm the big downloads
 *
 * Homebrew covers node, ffmpeg, Python and the OpenScreen cask, and the formula
 * declares all four. It cannot cover the rest, which is why this exists:
 *
 *   - Claude Code ships through npm and its own installer, not Homebrew. Every
 *     `claude-*` formula in Homebrew is an unrelated third-party project.
 *   - The HyperFrames skills live in ~/.claude/skills, which is per-user. A
 *     formula runs as whoever ran brew, so installing them there at install time
 *     lands in the wrong home or nowhere.
 *   - The voice virtualenv is per-user for the same reason.
 *   - `openscreen` is a name a different project also claims on Homebrew, and
 *     that cask ships no CLI. Installing the wrong one is the failure this
 *     checks for by name rather than by presence.
 *
 * Every step is idempotent and reports before it acts. Nothing here uses sudo,
 * and nothing installs into system Python.
 */
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const CHECK = argv.includes("--check");
const YES = argv.includes("--yes");

const has = (p) => access(p).then(() => true).catch(() => false);

/** Run something and hand back its output. stdin is /dev/null; see lib/jobs.mjs. */
function capture(cmd, args) {
	return new Promise((done) => {
		const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		child.stdout?.on("data", (d) => (out += d));
		child.stderr?.on("data", (d) => (out += d));
		child.on("error", () => done({ ok: false, out: "" }));
		child.on("close", (code) => done({ ok: code === 0, out }));
	});
}

/** Run something and let the user watch. Installers are chatty on purpose. */
function run(cmd, args) {
	return new Promise((done) => {
		const child = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
		child.on("error", (e) => {
			console.error(`    could not run ${cmd}: ${e.message}`);
			done(1);
		});
		child.on("close", done);
	});
}

const onPath = async (bin) => (await capture("sh", ["-c", `command -v ${bin}`])).ok;

/*
 * The steps.
 *
 * `check` answers "is this already done" and must be cheap and side-effect free.
 * `fix` is the command that does it. `required` marks the things the pipeline
 * cannot work without, which is what decides the exit code.
 */
const STEPS = [
	{
		name: "Homebrew",
		required: true,
		check: () => onPath("brew"),
		manual: 'Install from https://brew.sh — everything below leans on it.',
	},
	{
		name: "Node, ffmpeg, Python 3.13",
		required: true,
		why: "Python 3.13 because Kokoro needs >=3.10,<3.14 and macOS ships 3.9.",
		check: async () => (await onPath("node")) && (await onPath("ffmpeg")) && (await onPath("python3.13")),
		fix: ["brew", ["install", "node", "ffmpeg", "python@3.13"]],
	},
	{
		name: "OpenScreen (RoleModel's fork)",
		required: true,
		why:
			"The Studio hands documents to the editor with `openscreen open`, and no other build has that verb — " +
			"upstream declares no document type, so there is no way in from outside at all. " +
			"`openscreen` is also a name a third project claims on Homebrew, and that cask ships no CLI.",
		check: async () => {
			if (!(await onPath("openscreen"))) return false;
			// Presence is not enough, and neither is being *an* OpenScreen: the verb
			// is the thing the Studio needs, so ask the binary rather than the tap.
			const help = await capture("sh", ["-c", "openscreen help 2>&1"]);
			return /openscreen\s+open\s+</.test(help.out);
		},
		fix: ["sh", [
			"-c",
			"brew untap siddharthvaddem/openscreen 2>/dev/null; " +
				"brew uninstall --cask openscreen 2>/dev/null; " +
				"brew tap rolemodel/tap && brew install --cask rolemodel/tap/rolemodel-openscreen",
		]],
		heavy: "downloads a ~900MB app",
	},
	{
		name: "Claude Code",
		required: true,
		why: "Make a video and Draft a script both shell out to it. Not available through Homebrew.",
		check: () => onPath("claude"),
		fix: ["npm", ["install", "-g", "@anthropic-ai/claude-code"]],
	},
	{
		name: "HyperFrames skills",
		required: true,
		why: "`/hyperframes` in the Make prompt only resolves if the skill is in ~/.claude/skills.",
		check: async () => {
			const r = await capture("npx", ["--no-install", "hyperframes", "skills", "check"]);
			const text = r.out.replace(/\x1b\[[0-9;]*m/g, "");
			const n = (label) => Number(text.match(new RegExp(`(\\d+)\\s+${label}`))?.[1] ?? 0);
			return r.ok && n("outdated") === 0 && n("core not installed") === 0;
		},
		fix: ["npx", ["--yes", "hyperframes", "skills", "update"]],
	},
	{
		name: "Voice (Kokoro virtualenv)",
		required: false,
		why: "Local narration. Builds its own venv under ~/.rolemodel-video; system Python is never touched.",
		check: async () => {
			const { isReady } = await import("../lib/voice-setup.mjs");
			return isReady();
		},
		fix: ["node", [join(ROOT, "bin", "rm-voice.mjs"), "--setup"]],
		heavy: "downloads about 100MB",
	},
	{
		name: "OpenFrame (optional — client review)",
		required: false,
		why:
			"Sharing a finished video for review. Optional because it is infrastructure rather than a tool: " +
			"it wants Docker, and a review link only resolves for whoever can reach the instance, " +
			"so `localhost` proves the integration and is useless to a client.",
		check: async () => {
			if (!process.env.OPENFRAME_URL || !process.env.OPENFRAME_TOKEN) return false;
			// Configured is not the same as reachable, and a token that no longer
			// resolves is the failure worth catching here.
			const probe = await capture("sh", [
				"-c",
				`curl -fsS -o /dev/null -w '%{http_code}' -H "authorization: Bearer $OPENFRAME_TOKEN" "$OPENFRAME_URL/api/workspaces" 2>/dev/null`,
			]);
			return probe.out.trim() === "200";
		},
		manual:
			"Bring it up with `docker compose up -d --build` in the OpenFrame checkout, then set\n" +
			"    OPENFRAME_URL and OPENFRAME_TOKEN in your shell profile. See docs/KICKOFF.md.",
	},
	{
		name: "rclone (optional)",
		required: false,
		why: "Only `rm-library mount` needs it, plus a FUSE provider. Skip it unless you share footage.",
		check: () => onPath("rclone"),
		fix: ["brew", ["install", "rclone"]],
	},
];

const ask = (q) =>
	new Promise((done) => {
		if (YES || !process.stdin.isTTY) return done(true);
		process.stdout.write(`    ${q} [Y/n] `);
		process.stdin.setEncoding("utf8");
		process.stdin.once("data", (d) => {
			process.stdin.pause();
			done(!/^n/i.test(d.trim()));
		});
		process.stdin.resume();
	});

if (platform() !== "darwin") {
	console.log("\n  rm-setup only knows macOS. On anything else, read the steps in the Homebrew formula.\n");
}

console.log(`\n  ${CHECK ? "Checking" : "Setting up"} the RoleModel video pipeline\n`);

const missing = [];
for (const step of STEPS) {
	const done = await step.check().catch(() => false);
	const mark = done ? "✓" : step.required ? "✗" : "◦";
	console.log(`  ${mark} ${step.name}`);
	if (done) continue;
	if (step.why) console.log(`      ${step.why}`);
	missing.push(step);
	if (step.manual) {
		console.log(`      ${step.manual}`);
		continue;
	}
	if (CHECK) {
		console.log(`      would run: ${step.fix[0]} ${step.fix[1].join(" ")}`);
		continue;
	}
	if (step.heavy && !(await ask(`${step.name} ${step.heavy}. Go ahead?`))) {
		console.log("      skipped");
		continue;
	}
	console.log(`      running: ${step.fix[0]} ${step.fix[1].join(" ")}\n`);
	const code = await run(step.fix[0], step.fix[1]);
	console.log(code === 0 ? `\n      done\n` : `\n      failed (exit ${code})\n`);
}

if (!missing.length) {
	console.log("\n  Everything is in place. `rm-studio` to start.\n");
	process.exit(0);
}

if (CHECK) {
	const need = missing.filter((s) => s.required).length;
	console.log(`\n  ${missing.length} to do${need ? `, ${need} of them required` : ""}. Run \`rm-setup\` to do it.\n`);
	process.exit(need ? 1 : 0);
}

// Re-check rather than trusting the installers' exit codes: a step can exit 0
// and still not have produced the thing (a skipped heavy download, a partial
// brew install), and the summary is what the user will act on.
console.log("\n  Re-checking\n");
const still = [];
for (const step of STEPS) {
	if (await step.check().catch(() => false)) continue;
	still.push(step);
	console.log(`  ${step.required ? "✗" : "◦"} ${step.name}`);
}
if (!still.length) {
	console.log("\n  Everything is in place. `rm-studio` to start.\n");
	process.exit(0);
}
const blocking = still.filter((s) => s.required);
console.log(
	blocking.length
		? `\n  ${blocking.length} required thing${blocking.length === 1 ? "" : "s"} still missing. The Studio will tell you which panels that breaks.\n`
		: "\n  Only optional things left. `rm-studio` to start.\n",
);
process.exit(blocking.length ? 1 : 0);
