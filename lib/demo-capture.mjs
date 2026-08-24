/*
 * Record the screen while a script drives the app.
 *
 * The two halves of this already existed and had never been introduced.
 *
 * `rm-demo run` drives a headed browser from a markdown script and leaves a
 * Playwright trace, which `playwright-recast` turns into an mp4. That path is
 * scripted but it bypasses OpenScreen entirely: no wallpaper, no padding, no
 * auto-zoom, no camera bubble, and nothing the editor can open. `openscreen
 * record` produces exactly that — a `.openscreen` document the brand preset
 * patches and the editor opens — but it records whatever happens to be on screen,
 * so the Record page could only offer "capture this window for 30 seconds" and
 * hope somebody was driving.
 *
 * This is the joint. The script drives the browser, the recorder captures that
 * window, and what lands is a real screen capture of a deterministic run — a
 * document, not an mp4, so `rm-video brand` and the editor still apply.
 *
 * The hard part is telling the recorder which window to record before the script
 * has navigated anywhere. `--window` matches on title, and a browser's title is
 * whatever page it is showing, which is not known until the first `goto`. So the
 * driver stamps a sentinel title on the blank page first, the recorder latches
 * onto that window, and the first `goto` replaces the title a moment later. The
 * recorder resolves its source once at start, so the title changing afterwards
 * does not matter.
 */

/** Every record flag `openscreen record` accepts, and nothing invented. */
export const RECORD_FLAGS = {
	display: { arg: "number", help: "--display <n>  screen index" },
	window: { arg: "string", help: "--window <title>  first window whose title contains this" },
	mic: { arg: "boolean", help: "--mic  capture the default microphone" },
	micDevice: { flag: "mic-device", arg: "string", help: "--mic-device <name>  implies --mic" },
	systemAudio: { flag: "system-audio", arg: "boolean", help: "--system-audio  capture system audio" },
	cursor: { arg: "enum", values: ["editable-overlay", "system"], help: "--cursor <mode>" },
	duration: { arg: "number", help: "--duration <seconds>  stop on its own" },
	project: { arg: "string", help: "--project <out.openscreen>  write a document" },
};

/** Cursor modes the CLI documents. Anything else is the caller's typo, not a mode. */
export const CURSOR_MODES = RECORD_FLAGS.cursor.values;

/**
 * A window title no real page will carry.
 *
 * Deliberately not random: `index` comes from the caller so a test can ask for a
 * known one, and Math.random is unavailable in some of the places this runs.
 */
export const sentinelTitle = (index = 0) => `RM-CAPTURE-${index}`;

/**
 * Build the argv for `openscreen record`.
 *
 * Every flag in RECORD_FLAGS is reachable from here, which is the whole point:
 * the Studio's Record page can offer the recorder's real surface instead of the
 * three options someone happened to wire up. Unknown keys throw rather than being
 * dropped — a knob that silently does nothing is worse than one that is missing.
 */
export function recordArgs(opts = {}) {
	const out = ["record"];
	for (const [key, value] of Object.entries(opts)) {
		if (value === undefined || value === null || value === "") continue;
		const spec = RECORD_FLAGS[key];
		if (!spec) throw new Error(`unknown record option "${key}"`);
		const flag = `--${spec.flag ?? key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
		if (spec.arg === "boolean") {
			if (value === true) out.push(flag);
			continue;
		}
		if (spec.arg === "number") {
			const n = Number(value);
			if (!Number.isFinite(n) || n < 0) throw new Error(`${key} must be a non-negative number`);
			out.push(flag, String(n));
			continue;
		}
		if (spec.arg === "enum" && !spec.values.includes(String(value))) {
			throw new Error(`${key} must be one of ${spec.values.join(", ")}`);
		}
		out.push(flag, String(value));
	}
	// --json last and always. The orchestration reads NDJSON to know when the
	// recorder failed to find the window and when the document has landed; without
	// it the only signal is an exit code that arrives far too late to act on.
	out.push("--json");
	return out;
}

/**
 * Read NDJSON events off a stream, calling back per event.
 *
 * Line-buffered because a spawned process writes when it feels like it: an event
 * can arrive split across two chunks, and two events can arrive in one.
 */
export function ndjson(onEvent) {
	let buffer = "";
	return (chunk) => {
		buffer += String(chunk);
		let cut = buffer.indexOf("\n");
		while (cut !== -1) {
			const line = buffer.slice(0, cut).trim();
			buffer = buffer.slice(cut + 1);
			if (line) {
				try {
					onEvent(JSON.parse(line));
				} catch {
					// The CLI writes human lines to stdout too. Not every line is an event.
				}
			}
			cut = buffer.indexOf("\n");
		}
	};
}

/**
 * What a recorder process looks like to the caller.
 *
 * `stop()` writes "stop" on stdin rather than sending a signal. Both work, and
 * stdin is the one the CLI documents as graceful on every platform — SIGTERM
 * never fires on Windows, and this toolkit is not going to be macOS-only for ever.
 */
export function attachRecorder(child, { onEvent = () => {}, onLog = () => {} } = {}) {
	let done = null;
	let failure = null;
	const waiters = [];

	const settle = () => {
		for (const w of waiters.splice(0)) w();
	};

	child.stdout?.on(
		"data",
		ndjson((ev) => {
			onEvent(ev);
			if (ev.type === "error" || ev.error) failure = ev.error ?? ev.message ?? "recorder failed";
			if (ev.type === "done" || ev.event === "done") {
				done = ev;
				if (ev.success === false) failure = ev.error ?? "recording failed";
				settle();
			}
		}),
	);
	child.stderr?.on("data", (chunk) => {
		const text = String(chunk).trim();
		if (text) onLog(text);
	});
	child.on("exit", (code) => {
		if (code !== 0 && !failure) failure = `recorder exited ${code}`;
		settle();
	});

	return {
		/** Ask it to stop, gracefully, the way docs/cli.md says to. */
		stop() {
			try {
				child.stdin?.write("stop\n");
			} catch {
				// Already gone. The exit handler has the truth.
			}
		},
		/** Resolve when the recorder has finished, or reject with why it did not. */
		finished() {
			return new Promise((resolve, reject) => {
				const check = () => {
					if (failure) return reject(new Error(failure));
					if (done) return resolve(done);
					waiters.push(check);
				};
				check();
			});
		},
		/** Whatever has gone wrong so far, or null. Checked during the settle window. */
		problem: () => failure,
		result: () => done,
	};
}
