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
	"rm-demo",
	"rm-share",
	"rm-library",
	"rm-voice",
	"rm-mux",
	"playwright-recast",
	"rclone",
	"ffmpeg",
	"ffprobe",
	"claude",
	// Pi is a second coding agent, selectable in place of claude — see
	// lib/agents.mjs. Allowlisted rather than special-cased: this Set is the
	// thing standing between a prompt and an arbitrary process, so an agent that
	// is not in it cannot be started however it is configured.
	"pi",
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

/*
 * The job journal — a job survives the server that ran it.
 *
 * Jobs used to live only in this process's memory. Quit the server, or restart
 * it to pick up an edit, and every record went with it: no log, no exit code, no
 * pointer to what had been written. A render that had been going for eight
 * minutes left nothing behind but files in a directory nobody told you about,
 * and the Console came back empty as though it had never happened.
 *
 * So each job is written to disk as it finishes, and the last few are read back
 * at startup. A job that was still running when the server stopped comes back
 * marked `interrupted` rather than pretending to have succeeded — that is the
 * case that hurt, and the one worth naming precisely.
 *
 * The journal lives beside the library rather than in this repo: it describes
 * work done on that library, and a `git clean` here should not erase it.
 */
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

let JOURNAL = null;
const KEEP = 200;

export function setJournal(dir) {
	JOURNAL = dir;
}

/** Everything worth keeping about a job, including its output. */
const record = (j) => ({
	id: j.id,
	label: j.label,
	command: j.command,
	cwd: j.cwd,
	startedAt: j.startedAt,
	endedAt: j.endedAt,
	code: j.code,
	interrupted: j.interrupted ?? false,
	lines: j.lines,
});

export async function writeJournal(job) {
	if (!JOURNAL) return;
	try {
		await mkdir(JOURNAL, { recursive: true });
		await writeFile(join(JOURNAL, `${job.id}.json`), `${JSON.stringify(record(job), null, "\t")}\n`);
	} catch {
		// A journal that cannot be written must not take the job down with it.
	}
}

/**
 * Read the journal back, newest first.
 *
 * Anything still marked running was killed by whatever stopped the last server,
 * so it is reported as interrupted with the output it managed to produce.
 */
export async function readJournal() {
	if (!JOURNAL) return [];
	const names = await readdir(JOURNAL).catch(() => []);
	const out = [];
	for (const n of names) {
		if (!n.endsWith(".json")) continue;
		try {
			const j = JSON.parse(await readFile(join(JOURNAL, n), "utf8"));
			if (!j.endedAt) {
				j.interrupted = true;
				j.code = null;
			}
			out.push(j);
		} catch {
			// A half-written record is not worth failing a boot over.
		}
	}
	out.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
	return out.slice(0, KEEP);
}

const MAX_LINES = 4000;
/** How often a running job's output is checkpointed to the journal. */
const JOURNAL_EVERY_MS = 2000;
const jobs = new Map();

/**
 * Buffer a stream into whole lines, then push those.
 *
 * A chunk boundary lands wherever the pipe happens to flush, so splitting each
 * chunk on newlines turned one long line into two. That was survivable for
 * ffmpeg's chatter and is not for `claude --output-format stream-json`, where a
 * line is a JSON event and half of one parses as nothing. The trailing fragment
 * is held until its newline arrives; `flush` empties it when the process exits.
 *
 * The old 4000-character cap had the same problem for the same reason — Claude's
 * init event alone lists every tool, skill and plugin — so the cap is now high
 * enough not to bisect an event, and MAX_LINES still bounds total memory.
 */
const LINE_CAP = 64_000;

function push(job, stream, text) {
	const held = job.partial[stream] + String(text);
	const parts = held.split(/\r?\n/);
	job.partial[stream] = parts.pop() ?? "";
	for (const raw of parts) emitLine(job, stream, raw);
}

/** Emit whatever is left on a stream with no trailing newline. */
function flush(job) {
	for (const stream of ["out", "err"]) {
		const rest = job.partial[stream];
		job.partial[stream] = "";
		if (rest) emitLine(job, stream, rest);
	}
}

function emitLine(job, stream, raw) {
	if (raw === "") return;
	const line = { n: job.seq++, stream, text: raw.slice(0, LINE_CAP) };
	job.lines.push(line);
	if (job.lines.length > MAX_LINES) job.lines.splice(0, job.lines.length - MAX_LINES);
	for (const fn of job.subs) fn(line);

	// Checkpoint the output while it is still being produced. Writing only at
	// exit meant a job killed mid-flight was recorded with zero lines — which is
	// the one case where "how far did it get" is the whole question. Throttled,
	// because a chatty render emits thousands of lines and this is a whole-file
	// rewrite each time.
	const now = Date.now();
	if (now - (job.journaledAt ?? 0) > JOURNAL_EVERY_MS) {
		job.journaledAt = now;
		writeJournal(job);
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
/**
 * The environment a job inherits, minus Electron's internal switches.
 *
 * `ELECTRON_RUN_AS_NODE=1` tells an Electron binary to behave as plain Node, and
 * it is set inside the terminal of every Electron-hosted editor — VS Code among
 * them. Inherited by a child, it turns `openscreen record ...` into
 * `node record ...`, which fails with "Cannot find module <cwd>/record": a
 * missing-file error naming a file nobody wrote, for a binary that works fine
 * from a normal shell. OpenScreen is an Electron app, so this is squarely on the
 * path this tool exists to drive.
 *
 * Anything the caller passes explicitly still wins — this only drops what leaked
 * in from the parent.
 */
export function childEnv(extra = {}) {
	const env = { ...process.env, ...extra };
	for (const k of ["ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE"]) {
		if (!(k in extra)) delete env[k];
	}
	// Prepended, so a shim we ship beats whatever the same name resolves to on
	// the user's PATH. That is the point for `openscreen`: the cask symlinks the
	// binary out of Openscreen.app, and Electron cannot find its helper apps when
	// launched through a symlink.
	if (EXTRA_PATH.length) env.PATH = [...EXTRA_PATH, env.PATH].filter(Boolean).join(":");
	return env;
}

const EXTRA_PATH = [];

/** Put a directory ahead of PATH for every child this module starts. */
export function addPath(dir) {
	if (dir && !EXTRA_PATH.includes(dir)) EXTRA_PATH.unshift(dir);
}

export function run({ bin, args = [], label, cwd, shell = false, env, onDone }) {
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
		interrupted: false,
		journaledAt: 0,
		// Per-stream leftovers, waiting for the newline that ends their line.
		partial: { out: "", err: "" },
	};
	jobs.set(id, job);
	// Written immediately, not just at exit: a job killed mid-flight is exactly
	// the one worth having a record of, and it cannot write its own obituary.
	writeJournal(job);

	// stdin is /dev/null, deliberately.
	//
	// Node's default stdio gives the child a pipe on stdin that this server never
	// writes to and never closes, so anything that reads stdin waits on a pipe
	// that will never produce a byte. `claude -p` sits for three seconds, prints
	// "no stdin data received in 3s, proceeding without it", and carries on with
	// nothing — exit code 0 and no work done, which is the worst shape of failure.
	// ffmpeg is the same family: it consumes stdin unless told not to.
	//
	// Every job here is non-interactive by construction. There is no way to type
	// at one: the Console is a read-only stream, and the argv comes from an
	// allowlist. So "ignore" is the honest stdio, and it is what the CLI's own
	// hint (`< /dev/null`) asks for.
	const stdio = ["ignore", "pipe", "pipe"];
	const child = shell
		? spawn("/bin/sh", ["-c", bin], { cwd: job.cwd, env: childEnv(env), stdio })
		: spawn(bin, args, { cwd: job.cwd, env: childEnv(env), stdio });
	job.child = child;

	child.stdout?.on("data", (d) => push(job, "out", d));
	child.stderr?.on("data", (d) => push(job, "err", d));
	child.on("error", (e) => {
		push(job, "err", e.code === "ENOENT" ? `${bin}: not found on PATH` : String(e.message ?? e));
	});
	child.on("close", (code, signal) => {
		flush(job);
		job.code = code ?? (signal ? `signal ${signal}` : null);
		job.endedAt = new Date().toISOString();
		job.child = null;
		writeJournal(job);
		emit(job, { done: true, code: job.code });
		// The caller may need to react to a job that wrote files — re-indexing a
		// project, for instance. Failures here must not touch the job's own state.
		Promise.resolve(onDone?.(job)).catch(() => {});
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
	interrupted: Boolean(j.interrupted),
	lines: j.lines.length,
});

/**
 * Put the journal back in the job list at startup.
 *
 * Restored jobs have no child and cannot be resumed — they are a record, not a
 * handle. They keep their output so the Console can show what happened.
 */
export async function restore() {
	for (const r of await readJournal()) {
		if (jobs.has(r.id)) continue;
		jobs.set(r.id, { ...r, seq: r.lines?.length ?? 0, subs: new Set(), child: null, partial: { out: "", err: "" } });
	}
	return jobs.size;
}

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

/**
 * Forget the jobs that have finished, and their journals with them.
 *
 * The Console is a permanent record by design — it is where a render that failed
 * an hour ago is still readable — and the cost of that is a page which only ever
 * grows. Thirty-odd renders is several megabytes of captured output and a panel
 * nobody can find anything in.
 *
 * Running jobs are kept, and not as a nicety: dropping one would orphan its child
 * process, its subscribers and its journal checkpoint, leaving something writing
 * output to a record that no longer exists. What is finished is finished, and is
 * the only thing safe to forget.
 *
 * Returns how many went, because "Clear" that says nothing leaves you wondering
 * whether it did anything on a page that is now empty either way.
 */
export async function clearFinished() {
	const done = [...jobs.values()].filter((j) => !j.child);
	for (const j of done) {
		jobs.delete(j.id);
		if (JOURNAL) await rm(join(JOURNAL, `${j.id}.json`), { force: true }).catch(() => {});
	}
	/*
	 * And the journals with no job behind them.
	 *
	 * The store is rebuilt from the journal on boot, so a file left on disk is a
	 * job that reappears at the next restart — a Clear that un-clears itself
	 * overnight, which is worse than no Clear at all.
	 */
	if (JOURNAL) {
		for (const n of await readdir(JOURNAL).catch(() => [])) {
			if (!n.endsWith(".json")) continue;
			if (jobs.has(n.slice(0, -5))) continue;
			await rm(join(JOURNAL, n), { force: true }).catch(() => {});
		}
	}
	return done.length;
}

/** Kill everything on the way out, so Ctrl-C doesn't orphan an ffmpeg. */
export function stopAll() {
	for (const j of jobs.values()) j.child?.kill("SIGTERM");
}
