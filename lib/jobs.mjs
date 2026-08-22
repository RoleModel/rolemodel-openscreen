/**
 * Jobs — run the pipeline instead of describing it.
 *
 * The Studio used to hand you a command to paste into a terminal. For a tool
 * whose whole point is "dead simple", that is a cop-out: the interesting part
 * (did the export finish? what did ffmpeg say?) happened somewhere else, and
 * you had to go find it.
 *
 * So the server spawns the process and streams it back. Two rules keep that from
 * being a footgun:
 *
 *  1. **Allowlisted binaries only.** A POST cannot name an arbitrary executable.
 *     `run()` refuses anything not in BINARIES, and arguments arrive as an array
 *     so nothing goes through a shell — no quoting, no `;`, no `$(...)`.
 *  2. **Free-text is opt-in.** `rm-studio --shell` enables a real prompt. It is
 *     off by default and the UI says why, because a web page that will run any
 *     string you send it is a different security posture than one that won't,
 *     even bound to localhost.
 *
 * Jobs are children of the server. Quit the server and running jobs die with it;
 * that is the right default for a tool you leave open while you work, and long
 * renders should be started from a terminal anyway.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename, resolve, sep } from "node:path";

/** Binaries the UI is allowed to start. Everything the pipeline actually uses. */
export const BINARIES = new Set([
	"openscreen",
	"rm-video",
	"rm-library",
	"rm-voice",
	"rm-mux",
	"playwright-recast",
	"rclone",
	"ffmpeg",
	"ffprobe",
	"claude",
	"npx",
	// Only ever invoked as `node <a script inside this toolkit>` — the server
	// resolves that path itself; it never comes from the request.
	"node",
	"open",
]);

/**
 * Absolute paths are allowed only under this root.
 *
 * The Studio prefers its own pinned binaries (node_modules/.bin/playwright-recast,
 * bin/rm-mux.mjs) over whatever is on PATH, which means it has to pass absolute
 * paths — and a bare-name allowlist rightly refuses those. Rather than weaken the
 * check, we widen it by exactly one rule: a path is acceptable if it lives inside
 * the toolkit AND its basename is still on the list. Nothing outside the install
 * can be named, whatever a request asks for.
 */
let TRUSTED_ROOT = null;
export function setTrustedRoot(dir) {
	TRUSTED_ROOT = resolve(dir);
}

function permitted(bin) {
	if (BINARIES.has(bin)) return true;
	if (!bin.includes("/") && !bin.includes("\\")) return false;
	if (!TRUSTED_ROOT) return false;
	const full = resolve(bin);
	if (full !== TRUSTED_ROOT && !full.startsWith(TRUSTED_ROOT + sep)) return false;
	return BINARIES.has(basename(full).replace(/\.mjs$/, ""));
}

const MAX_LINES = 4000;
const jobs = new Map();

function push(job, stream, text) {
	for (const raw of String(text).split(/\r?\n/)) {
		if (raw === "" ) continue;
		const line = { n: job.seq++, stream, text: raw.slice(0, 4000) };
		job.lines.push(line);
		if (job.lines.length > MAX_LINES) job.lines.splice(0, job.lines.length - MAX_LINES);
		for (const fn of job.subs) fn(line);
	}
}

function emit(job, event) {
	for (const fn of job.subs) fn(event);
}

/**
 * Start a job.
 * @param {object} o
 * @param {string} o.bin        binary name, must be in BINARIES (or shell must be true)
 * @param {string[]} o.args     argv, passed without a shell
 * @param {string} [o.label]    what to call it in the UI
 * @param {string} [o.cwd]      working directory
 * @param {boolean} [o.shell]   run `bin` as a shell command line (requires --shell)
 */
export function run({ bin, args = [], label, cwd, shell = false, env }) {
	if (!shell && !permitted(bin)) {
		throw new Error(`"${bin}" is not one of the commands this UI can start`);
	}

	const id = randomUUID().slice(0, 8);
	const job = {
		id,
		label: label ?? [bin, ...args].join(" "),
		command: shell ? bin : [bin, ...args].join(" "),
		cwd: cwd ?? process.cwd(),
		startedAt: new Date().toISOString(),
		endedAt: null,
		code: null,
		lines: [],
		seq: 0,
		subs: new Set(),
		child: null,
	};
	jobs.set(id, job);

	const child = shell
		? spawn("/bin/sh", ["-c", bin], { cwd: job.cwd, env: { ...process.env, ...env } })
		: spawn(bin, args, { cwd: job.cwd, env: { ...process.env, ...env } });
	job.child = child;

	child.stdout?.on("data", (d) => push(job, "out", d));
	child.stderr?.on("data", (d) => push(job, "err", d));
	child.on("error", (e) => {
		push(job, "err", e.code === "ENOENT" ? `${bin}: not found on PATH` : String(e.message ?? e));
	});
	child.on("close", (code, signal) => {
		job.code = code ?? (signal ? `signal ${signal}` : null);
		job.endedAt = new Date().toISOString();
		job.child = null;
		emit(job, { done: true, code: job.code });
	});

	return job;
}

export const get = (id) => jobs.get(id);

export const list = () =>
	[...jobs.values()]
		.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
		.slice(0, 40)
		.map(summary);

export const summary = (j) => ({
	id: j.id,
	label: j.label,
	command: j.command,
	cwd: j.cwd,
	startedAt: j.startedAt,
	endedAt: j.endedAt,
	code: j.code,
	running: Boolean(j.child),
	lines: j.lines.length,
});

export function stop(id) {
	const j = jobs.get(id);
	if (!j?.child) return false;
	j.child.kill("SIGTERM");
	// A render that ignores SIGTERM should not hold the UI hostage.
	setTimeout(() => j.child?.kill("SIGKILL"), 4000).unref?.();
	return true;
}

/** Subscribe to a job. Replays the buffer, then streams. Returns an unsubscribe. */
export function subscribe(id, fn) {
	const j = jobs.get(id);
	if (!j) return null;
	for (const line of j.lines) fn(line);
	if (!j.child) fn({ done: true, code: j.code });
	j.subs.add(fn);
	return () => j.subs.delete(fn);
}

/** Kill everything on the way out, so Ctrl-C doesn't orphan an ffmpeg. */
export function stopAll() {
	for (const j of jobs.values()) j.child?.kill("SIGTERM");
}
