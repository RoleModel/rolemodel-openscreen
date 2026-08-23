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
 *     goto https://feeney-staging.example.com/quotes/new
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
};

/** Verbs whose single argument is a number, not a selector. */
const NUMERIC = new Set(["wait", "scroll"]);

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
			const args = splitArgs(line.slice(verb.length).trim());
			if (args.length !== spec.args) {
				problems.push(`line ${lineNo}: \`${verb}\` takes ${spec.args} — write \`${spec.help}\``);
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
	return {
		actions: acts.length,
		narration: narration(parsed).length,
		urls,
		holdMs: waitMs,
	};
}
