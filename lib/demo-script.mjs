/*
 * A demo script: what the browser does, and what the voice says, in one file.
 *
 * The two halves of a demo were authored in different places and reconciled by
 * hand. Narration lived in `scripts/<name>.md`; the browser side did not exist at
 * all — `From a test` needed a Playwright trace you had already produced by some
 * other means. So the interesting half of a demo, the part that decides what the
 * viewer sees, was the one thing the toolkit could not help with.
 *
 * This is one markdown file where prose is narration and fenced `do` blocks are
 * actions:
 *
 *     # Estimating walkthrough
 *
 *     Start in the quote builder.
 *
 *     ```do
 *     goto https://ridgeline-staging.example.com/quotes/new
 *     wait 800
 *     ```
 *
 *     Adding a railing is two clicks.
 *
 *     ```do
 *     click "Add to quote"
 *     type "#part" "FEE-3410"
 *     press Enter
 *     ```
 *
 * Nothing about the narration side changes: `parseScript` already skips fenced
 * blocks, so the same file feeds `rm-voice` unmodified and the actions are
 * invisible to it. Order is the timeline — the nth narration line is spoken over
 * the nth stretch of actions — which is the whole reason to keep them together
 * rather than in two files that drift.
 *
 * The DSL is deliberately small. It is not a Playwright wrapper and should not
 * grow into one: a demo that needs real branching is a Playwright test, and
 * `From a test` already takes the trace from one.
 */

/**
 * How long a narration line takes to say, in milliseconds.
 *
 * The reason this exists: a demo script puts a line of prose next to a block of
 * actions and nothing else connects them. A click takes 300ms and the sentence
 * describing it takes four seconds, so the picture races ahead of the voice and by
 * step five they are describing different things. `rm-mux` reconciles the two
 * clocks afterwards, but only for the clip as a whole — it pads, stretches or holds
 * the last frame. It cannot pull cue four back over the action it belongs to,
 * because by then the timing is baked into the video.
 *
 * So the pace is derived here instead, before anything is recorded: a step that
 * carries a line holds long enough for the words. That makes the alignment
 * structural rather than hopeful, and leaves rm-mux's padding cosmetic.
 *
 * 165 words a minute is measured conversational narration, not a reading pace —
 * Kokoro and ElevenLabs both land near it at their defaults. Punctuation buys a
 * beat, because a synthesiser pauses at a comma and the count of words does not
 * know that. It is an estimate and says so; being 10% out is a beat of silence,
 * while being 400% out is what the blank line gave us.
 */
export const SPEECH_WPM = 165;
/** A comma, dash or colon is a short pause; a sentence end is a longer one. */
const PAUSE_SHORT_MS = 180;
const PAUSE_LONG_MS = 420;
/** Nothing reads a bare label in under this, however few words it holds. */
const SPEECH_FLOOR_MS = 700;

export function speechMs(text) {
	const words = String(text ?? "").trim().split(/\s+/).filter(Boolean).length;
	if (!words) return 0;
	const short = (String(text).match(/[,;:—-]/g) ?? []).length;
	const long = (String(text).match(/[.!?](\s|$)/g) ?? []).length;
	const spoken = (words / SPEECH_WPM) * 60_000 + short * PAUSE_SHORT_MS + long * PAUSE_LONG_MS;
	return Math.max(SPEECH_FLOOR_MS, Math.round(spoken / 100) * 100);
}

/** One verb per line. `args` is how many quoted or bare arguments it takes. */
export const VERBS = {
	goto: { args: 1, help: "goto <url>" },
	click: { args: 1, help: 'click "<selector or text>"' },
	dblclick: { args: 1, help: 'dblclick "<selector or text>"' },
	hover: { args: 1, help: 'hover "<selector or text>"' },
	type: { args: 2, help: 'type "<selector>" "<text>"' },
	fill: { args: 2, help: 'fill "<selector>" "<text>"' },
	press: { args: 1, help: "press <key>" },
	wait: { args: 1, help: "wait <ms>" },
	scroll: { args: 1, help: "scroll <pixels>" },
	expect: { args: 1, help: 'expect "<selector or text>"' },
	agent: { args: 1, help: 'agent "<the outcome to achieve on this screen>"' },
};

/** Verbs whose single argument is a number, not a selector. */
const NUMERIC = new Set(["wait", "scroll"]);

/**
 * Directives — the render's settings, written in the document.
 *
 * These were only ever reachable through a form: thirteen controls in a column,
 * with no way to read your own configuration back and no way to keep it beside the
 * words it applies to. In the document they sit with the script they belong to, and
 * they travel with it — a script is markdown, greppable, and it diffs.
 *
 * A directive line has to be unmistakably not speech, because everything this
 * parser does not recognise gets spoken. `/key value` at the start of a line is the
 * whole rule; a line of narration that happens to begin with a slash is not a
 * sentence anyone writes.
 *
 * `args` is what the value is checked against — a hint for the editor's menu rather
 * than a closed list, because the real options live in the library and the brand
 * and change without this file.
 */
export const DIRECTIVES = {
	brand: { help: "/brand academy", hint: "which preset's colours and marks" },
	motion: { help: "/motion energetic", hint: "a preset from brand/motion.json" },
	"voice-provider": { help: "/voice-provider elevenlabs", hint: "where the selected voice comes from" },
	voice: { help: "/voice af_heart", hint: "a voice id, or `none` for silence" },
	wallpaper: { help: "/wallpaper rm-framed", hint: "the scene background" },
	title: { help: '/title "Estimating a curved railing"', hint: "the opening card" },
	eyebrow: { help: '/eyebrow "RIDGELINE · WALKTHROUGH"', hint: "small label above the title" },
	webcam: { help: "/webcam Footage/demo.mp4", hint: "a clip from this project, as circular PiP" },
	audio: { help: "/audio Audio/take-1.wav", hint: "a track from this project" },
	music: { help: "/music Audio/bed.wav", hint: "same, but under everything and ducked" },
	captions: { help: "/captions on", hint: "burn subtitles in" },
	seconds: { help: "/seconds 20", hint: "target length", numeric: true },
	chrome: { help: "/chrome app.example.com", hint: "draw browser chrome at this URL" },
};

/**
 * Split a step's arguments.
 *
 * Quoted arguments keep their spaces, which matters because most selectors here
 * are human-readable text — `click "Add to quote"` is the common case and
 * splitting on whitespace would break it. Bare words are allowed for the things
 * that never contain a space: a url, a key name, a number.
 */
export function splitArgs(rest) {
	const out = [];
	// Escapes are understood inside quotes, because real interface text contains
	// quotes — `click "Add \"railing\""` is a button somebody will actually have.
	// Without this the regex stopped at the first inner quote and the step came
	// back with the wrong number of arguments, which the recorder found the moment
	// it serialised a value containing one.
	const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+)/g;
	let m;
	while ((m = re.exec(rest)) !== null) {
		const quoted = m[1] ?? m[2];
		out.push(quoted === undefined ? m[3] : quoted.replace(/\\(["'\\])/g, "$1"));
	}
	return out;
}

/**
 * Parse a demo script into an ordered list of `say` and `do` entries.
 *
 * Unknown verbs and wrong argument counts are reported rather than skipped: a
 * typo in a demo script should fail before a browser opens, not produce a video
 * with a step quietly missing from the middle of it.
 */
export function parseDemo(md) {
	const steps = [];
	const problems = [];
	let fence = null;
	let lineNo = 0;

	for (const raw of String(md).split(/\r?\n/)) {
		lineNo++;
		const line = raw.trim();

		if (line.slice(0, 3) === "```") {
			// ```do opens an action block; anything else is a code sample the
			// narration parser also ignores, and we ignore it for the same reason.
			if (fence === null) fence = line.slice(3).trim().toLowerCase();
			else fence = null;
			continue;
		}

		if (fence === "do") {
			if (!line || line.startsWith("#")) continue;
			const [verb, ...restParts] = line.split(/\s+/);
			const spec = VERBS[verb];
			if (!spec) {
				problems.push(`line ${lineNo}: no such step \`${verb}\` (have: ${Object.keys(VERBS).join(", ")})`);
				continue;
			}
			const rest = line.slice(verb.length).trim();
			const args = splitArgs(rest);
			if (args.length !== spec.args) {
				/*
				 * Say what went wrong, not just what the shape should be.
				 *
				 * "`goto` takes 1" is true of three different mistakes — nothing
				 * after the verb, a space inside the value, and something written
				 * after it — and it names none of them. The middle one is the trap:
				 * a URL is one thing to a person and two arguments to a parser, so
				 * the message described a rule the author believed they were
				 * following.
				 */
				const why =
					args.length === 0
						? `nothing after \`${verb}\``
						: args.length > spec.args
							? `${args.length} arguments — a space splits a value in two, so quote it: \`${verb} "${rest}"\``
							: `${args.length} of ${spec.args}`;
				problems.push(`line ${lineNo}: \`${verb}\` takes ${spec.args}, got ${why} — write \`${spec.help}\``);
				continue;
			}
			if (NUMERIC.has(verb)) {
				const n = Number(args[0]);
				if (!Number.isFinite(n)) {
					problems.push(`line ${lineNo}: \`${verb}\` wants a number, got \`${args[0]}\``);
					continue;
				}
				steps.push({ kind: "do", verb, args: [n], line: lineNo });
				continue;
			}
			steps.push({ kind: "do", verb, args, line: lineNo });
			continue;
		}

		if (fence !== null) continue; // inside some other fence
		if (!line || line[0] === "#") continue;

		/*
		 * A directive, not a line to read aloud.
		 *
		 * Checked before the narration branch for the obvious reason: unrecognised
		 * text is spoken, so a mistyped directive would be read out as "slash
		 * voyce af heart" in the finished video. An unknown key is a problem rather
		 * than speech, which is what makes the live checker able to catch it while
		 * you type.
		 */
		if (line[0] === "/") {
			const m = /^\/([a-z][a-z-]*)\s*(.*)$/i.exec(line);
			if (!m) {
				problems.push(`line ${lineNo}: \`${line}\` starts with a slash but is not a directive`);
				continue;
			}
			const key = m[1].toLowerCase();
			const value = m[2].trim().replace(/^"(.*)"$/, "$1");
			const spec = DIRECTIVES[key];
			if (!spec) {
				problems.push(
					`line ${lineNo}: no such setting \`/${key}\` (have: ${Object.keys(DIRECTIVES).join(", ")})`,
				);
				continue;
			}
			if (!value) problems.push(`line ${lineNo}: \`/${key}\` needs a value — write \`${spec.help}\``);
			else if (spec.numeric && !/^\d+$/.test(value))
				problems.push(`line ${lineNo}: \`/${key}\` wants a number, got \`${value}\``);
			else steps.push({ kind: "set", key, value, line: lineNo });
			continue;
		}
		if (/^([-*_])\1{2,}$/.test(line)) continue;
		if (line.slice(0, 2) === "![") continue;

		// Narration, cleaned the same way the voice path cleans it so the two
		// agree on what a line is. Kept here only to establish order.
		const text = line
			.replace(/^>\s*/, "")
			.replace(/^[-*+]\s+/, "")
			.replace(/^\d+[.)]\s+/, "")
			.replace(/\*\*(.+?)\*\*/g, "$1")
			.replace(/\[(.+?)\]\(.+?\)/g, "$1")
			.replace(/[*_`]/g, "")
			.trim();
		if (text) steps.push({ kind: "say", text, line: lineNo });
	}

	return { steps, problems };
}

/** Just the actions, in order. */
export const actions = (parsed) => parsed.steps.filter((s) => s.kind === "do");
/** Just the narration, in order — the same lines `parseScript` would speak. */
export const narration = (parsed) => parsed.steps.filter((s) => s.kind === "say").map((s) => s.text);

/**
 * The settings the document asks for, last one winning.
 *
 * Last-wins so editing means adding a line rather than hunting for the old one,
 * which is how people actually use a text file.
 */
export const settings = (parsed) =>
	Object.fromEntries(parsed.steps.filter((s) => s.kind === "set").map((s) => [s.key, s.value]));

/**
 * A one-line summary of what a script will do, for showing before it runs.
 *
 * The Studio's rule is that a button says what it will do with the real values
 * before it is pressed, and a demo script is a lot of hidden behaviour to run
 * off one click.
 */
export function describe(parsed) {
	const acts = actions(parsed);
	const urls = acts.filter((a) => a.verb === "goto").map((a) => a.args[0]);
	const waitMs = acts.filter((a) => a.verb === "wait").reduce((n, a) => n + a.args[0], 0);
	const lines = narration(parsed);
	return {
		actions: acts.length,
		narration: lines.length,
		urls,
		holdMs: waitMs,
		// What the words alone will take, so a script can be compared against the
		// waits it asks for rather than only against itself.
		speechMs: lines.reduce((n, line) => n + speechMs(line), 0),
	};
}
