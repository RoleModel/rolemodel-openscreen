#!/usr/bin/env node
/*
 * Run a demo script and leave behind everything `playwright-recast` wants.
 *
 *   rm-demo run <script.md> --out <dir> [--url <base>] [--width 1440] [--height 900]
 *   rm-demo check <script.md>
 *
 * The missing half of the pipeline. `From a test` could already turn a Playwright
 * trace into a branded video, but producing the trace was left to you — so the
 * part of a demo that decides what the viewer actually sees was the one thing the
 * toolkit could not help with. This drives a browser from a script instead.
 *
 * Two artefacts land in the output directory, and both matter:
 *
 *   <name>.zip  the trace, which recast reads
 *   <name>.webm the screencast, sharing the trace's basename
 *
 * That naming is not decoration. recast assembles from the trace's screenshot
 * frames unless a video file sits next to the trace with the same basename;
 * frames are sparse — a three-second interaction came out as fifteen of them —
 * and the result reads as a slideshow. Writing both means the smooth path is the
 * default rather than something you have to know about.
 *
 * Traces are recorded with screenshots and snapshots on, because recast needs
 * the screenshots and the snapshots are what make the trace worth keeping when a
 * step fails and you want to know why.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { attachRecorder, CURSOR_MODES, recordArgs, sentinelTitle } from "../lib/demo-capture.mjs";
import { attach as watchClicks, serialize as serializeDemo } from "../lib/demo-record.mjs";
import { actions, describe as describeDemo, narration, parseDemo } from "../lib/demo-script.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0];
const has = (n) => argv.includes(`--${n}`);
const flag = (n, d) => {
	const i = argv.indexOf(`--${n}`);
	if (i === -1) return d;
	const v = argv[i + 1];
	return v && !v.startsWith("--") ? v : true;
};

function die(msg) {
	console.error(`rm-demo: ${msg}`);
	process.exit(1);
}

/*
 * Which browser drives the demo.
 *
 * Playwright ships its own Chromium build, and that is what launched: a plain
 * blue-globe icon, no profile, no branding. Fine for a trace nobody watches, and
 * wrong for a capture — the video shows a browser the viewer has never seen,
 * which reads as a mock-up of the product rather than the product.
 *
 * `chrome` is the installed Google Chrome, driven through Playwright's channel
 * support. It is the default because captures are the reason this exists, and it
 * falls back to the bundled build rather than failing when Chrome is not there.
 */
/*
 * Where a signed-in browser keeps its profile.
 *
 * "Use my signed-in browser" used to mean attaching over CDP, and Chrome cannot
 * be given a debugging port while it is running — so the instruction was: quit
 * Chrome completely, relaunch it from a terminal with two flags, then come back.
 * Nobody making a video is going to do that, and the ones who try will do it
 * once and not again.
 *
 * A persistent profile is the same outcome without any of that. It is real
 * Chrome with a real profile directory, so a sign-in survives to the next
 * capture — and because the directory is ours rather than Chrome's own, the
 * browser you already have open keeps running untouched. Chrome locks a profile
 * while it is using it, which is the reason pointing this at your normal one
 * would put us straight back where we started.
 *
 * The cost is honest and worth saying out loud: the first capture on a site that
 * needs a login has to sign in once, in the window that opens.
 */
const PROFILE_DIR = join(homedir(), ".config", "rolemodel-openscreen", "browser");

const BROWSER_CHANNELS = { chrome: "chrome", edge: "msedge", msedge: "msedge", chromium: undefined };

/**
 * Launch options for a demo browser.
 *
 * The automation banner is suppressed for the same reason the channel matters:
 * it is a yellow bar across the top of every frame saying the browser is being
 * controlled by test software, and it is the first thing a viewer reads.
 */
function launchOptions(which, headless) {
	const channel = BROWSER_CHANNELS[which];
	return {
		headless,
		...(channel ? { channel } : {}),
		args: ["--disable-blink-features=AutomationControlled"],
		ignoreDefaultArgs: ["--enable-automation"],
	};
}

/** Open it, and say so plainly if the named browser is not installed. */
async function openBrowser(chromium, which, headless) {
	try {
		return { browser: await chromium.launch(launchOptions(which, headless)), used: which };
	} catch (err) {
		if (which === "chromium") throw err;
		console.error(`  [browser] ${which} would not start (${err.message.split("\n")[0]}) — using the bundled Chromium`);
		return { browser: await chromium.launch(launchOptions("chromium", headless)), used: "chromium" };
	}
}

const DEFAULT_W = 1440;
const DEFAULT_H = 900;
/** How long a step may take before we call it stuck. */
const STEP_TIMEOUT_MS = 15_000;
/** Breathing room after a click, so the trace has frames showing the result. */
const SETTLE_MS = 350;
/** How long the sentinel title needs to reach the window manager. */
const TITLE_SETTLE_MS = 400;
/**
 * How long to wait for the recorder to say it is recording.
 *
 * Not a settle window any more — it is a ceiling on waiting for a real signal.
 * 2500ms was a guess and it was wrong: this machine takes 5022ms to resolve the
 * window and 5662ms to start, so the old wait expired while the recorder was
 * still looking. Tunable because it is a property of the machine, not of this
 * script — the app has to start, ask the OS for its window list and match a
 * title, and a laptop that has just woken takes longer than a warm one.
 */
const RECORDER_SETTLE_MS = Number(process.env.RM_RECORDER_SETTLE_MS) || 20_000;
/** Held frames after the last step, so the cut is not on the click. */
const TAIL_HOLD_MS = 900;
/** Claude makes one observed decision at a time, so a changed screen never follows a stale plan. */
const AGENT_STEP_LIMIT = Number(process.env.RM_DEMO_AGENT_STEP_LIMIT) || 16;

/** The windows OpenScreen itself can currently resolve by title. */
function sourceWindows(bin) {
	return new Promise((done) => {
		const child = spawn(bin, ["sources", "--json"], { stdio: ["ignore", "pipe", "ignore"] });
		let out = "";
		child.stdout?.on("data", (chunk) => (out += String(chunk)));
		child.on("error", () => done([]));
		child.on("close", () => {
			for (const line of out.split(/\r?\n/).reverse()) {
				try {
					const event = JSON.parse(line);
					if (Array.isArray(event?.sources?.windows)) return done(event.sources.windows.map((window) => String(window.name ?? "")));
				} catch {
					// `sources --json` is NDJSON; the initial event has no source list.
				}
			}
			done([]);
		});
	});
}

/** Do not ask record to match a window until its own source listing can see it. */
async function waitForWindowSource(bin, title) {
	const deadline = Date.now() + RECORDER_SETTLE_MS;
	let windows = [];
	do {
		windows = await sourceWindows(bin);
		if (windows.some((name) => name.includes(title))) return { found: true, windows };
		if (Date.now() < deadline) await new Promise((done) => setTimeout(done, 250));
	} while (Date.now() < deadline);
	return { found: false, windows };
}

/**
 * Resolve a target to a Playwright locator.
 *
 * A demo script says `click "Add to quote"`, not `click "button:has-text(...)"`.
 * Anything that looks like a selector is used as one; everything else is treated
 * as visible text, which is what a person writing a demo means and what keeps
 * the script readable a year later.
 */
function locate(page, target) {
	const looksLikeSelector = /^[.#[]|^[a-z]+[.#[:]|^(div|span|button|input|a|section|main|nav|ul|li|table)\b/i.test(target);
	return looksLikeSelector ? page.locator(target) : page.getByText(target, { exact: false }).first();
}

/** Collect the controls Claude can actually use, and give each one a temporary id. */
async function agentScreen(page, screenshot) {
	await page.screenshot({ path: screenshot }).catch(() => {});
	return page.evaluate(() => {
		const visible = (node) => {
			const style = getComputedStyle(node);
			const box = node.getBoundingClientRect();
			return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
		};
		// Cards in Studio are deliberate click targets too. They are divs because a
		// card can contain its own action menu, so include JavaScript click targets
		// rather than pretending Claude can only see native controls.
		const nodes = [...document.querySelectorAll("*")].filter(
			(node) => visible(node) && (node.matches("a, button, [role=button], input, textarea, select") || typeof node.onclick === "function"),
		);
		return nodes.slice(0, 120).map((node, index) => {
			const id = `rm-agent-${index + 1}`;
			node.setAttribute("data-rm-agent-target", id);
			const label = [
				node.getAttribute("aria-label"),
				node.labels?.[0]?.innerText,
				node.innerText,
				node.value,
				node.getAttribute("placeholder"),
			]
				.find((value) => String(value ?? "").trim())
				?.trim();
			return { id, kind: node.tagName.toLowerCase(), type: node.getAttribute("type") ?? null, label: label?.slice(0, 160) ?? "unnamed control" };
		});
	});
}

function runClaude(args, cwd) {
	return new Promise((resolveRun) => {
		const child = spawn("claude", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let err = "";
		child.stdout.on("data", (chunk) => (out += String(chunk)));
		child.stderr.on("data", (chunk) => (err += String(chunk)));
		child.on("error", (error) => resolveRun({ ok: false, out, err: error.message }));
		child.on("close", (code) => resolveRun({ ok: code === 0, out, err }));
	});
}

const AGENT_SCHEMA = JSON.stringify({
	type: "object",
	properties: {
		action: { enum: ["click", "fill", "wait", "done"] },
		target: { type: "string" },
		text: { type: "string" },
		ms: { type: "number" },
	},
	required: ["action"],
	additionalProperties: false,
});

/**
 * Let Claude make the next move from the screen it can see now.
 *
 * Recast edits the trace after the run; it does not choose browser actions. This
 * bridge does: Claude gets a current screenshot plus an exact, bounded list of
 * live controls, chooses one action, and then sees the resulting screen before
 * it chooses again. It never gets a free-form browser or a stale list of labels.
 */
function liveAgent(page, { workDir, log }) {
	let turn = 0;
	let scratch = null;
	const history = [];
	// A visible button can remain on screen after a failed request. Without this
	// guard, an otherwise careful one-step agent can keep choosing the same
	// button, turning one useful error into sixteen identical clicks.
	const attemptedClicks = new Set();

	const choose = async (goal) => {
		if (!scratch) scratch = await mkdtemp(join(tmpdir(), "rm-demo-agent-"));
		for (; turn < AGENT_STEP_LIMIT; turn++) {
			const screenshot = join(scratch, `screen-${turn + 1}.png`);
			const controls = await agentScreen(page, screenshot);
			const prompt = [
				"Drive one safe next step of a local product demo.",
				`Goal: ${goal}`,
				`The current screen is saved at: ${screenshot}`,
				"Read the screenshot if it helps. Pick exactly one action from the live controls below.",
				"Use only a listed target id. Do not navigate outside the current app. Do not open Console, change settings, sign in, upload, delete, or start an external render unless the goal explicitly asks for it.",
				"Return done when the goal is visibly complete. A fill action needs text. A wait action is only for a screen that is visibly loading. Never repeat a click: if a button remains after you used it, inspect the visible result or finish instead.",
				history.length ? `Actions already taken in this run: ${history.join(" → ")}. Choose the next unfinished part of the goal; do not redo any of these.` : "No actions have been taken yet.",
				"",
				JSON.stringify(controls),
			].join("\n");
			const answer = await runClaude([
				"-p",
				prompt,
				"--add-dir",
				scratch,
				"--allowedTools",
				"Read",
				"--output-format",
				"json",
				"--json-schema",
				AGENT_SCHEMA,
				"--no-session-persistence",
			], workDir);
			if (!answer.ok) throw new Error(`Claude could not inspect this screen: ${(answer.err || answer.out).trim().slice(-400)}`);
			let response;
			try {
				const envelope = JSON.parse(answer.out);
				response = envelope.structured_output ?? JSON.parse(envelope.result);
			} catch {
				throw new Error("Claude did not return a usable next action.");
			}
			if (response.action === "done") return;
			if (response.action === "wait") {
				const ms = Math.max(100, Math.min(5000, Number(response.ms) || 700));
				log(`Claude waits ${ms}ms`);
				history.push(`wait ${ms}ms`);
				await page.waitForTimeout(ms);
				continue;
			}
			if (!controls.some((control) => control.id === response.target)) throw new Error("Claude chose a control that is no longer on screen.");
			const target = page.locator(`[data-rm-agent-target="${response.target}"]`);
			const control = controls.find((item) => item.id === response.target);
			// Claude's answer takes longer than a Studio paint. If that paint replaced
			// the node it inspected, its temporary id is gone. That is a normal race,
			// not a failed click: take a fresh screenshot and let Claude decide again.
			if ((await target.count()) !== 1) {
				log("Studio changed while Claude was looking; checking the current screen again.");
				continue;
			}
			if (response.action === "fill") {
				if (!["input", "textarea"].includes(control.kind) || typeof response.text !== "string") throw new Error("Claude proposed an invalid fill action.");
				log(`Claude fills ${JSON.stringify(control.label)}`);
				try {
					await target.fill(response.text, { timeout: 2_000 });
				} catch {
					log("Studio changed while Claude was looking; checking the current screen again.");
					continue;
				}
				history.push(`filled ${JSON.stringify(control.label)}`);
			} else if (response.action === "click") {
				const clickKey = `${control.kind}:${control.label}`;
				if (attemptedClicks.has(clickKey)) {
					throw new Error(`Claude already clicked ${JSON.stringify(control.label)} and the screen did not advance. Stopping instead of repeating the action.`);
				}
				log(`Claude clicks ${JSON.stringify(control.label)}`);
				try {
					await target.click({ timeout: 2_000 });
				} catch {
					log("Studio changed while Claude was looking; checking the current screen again.");
					continue;
				}
				attemptedClicks.add(clickKey);
				history.push(`clicked ${JSON.stringify(control.label)}`);
			} else {
				throw new Error("Claude proposed an unknown action.");
			}
			await page.waitForTimeout(SETTLE_MS);
		}
		throw new Error(`Claude reached the ${AGENT_STEP_LIMIT}-step safety limit before the goal was complete.`);
	};

	choose.cleanup = async () => {
		if (scratch) await rm(scratch, { recursive: true, force: true });
	};
	return choose;
}

/** Verbs whose first argument has to exist on the page before we can act on it. */
const NEEDS_TARGET = new Set(["click", "dblclick", "hover", "type", "fill", "expect"]);
/** How many candidates to offer when a target is not found. */
const SUGGEST = 8;

/**
 * Say why a target was not found, instead of timing out.
 *
 * A missed selector is the mistake a demo script makes most often — a button was
 * relabelled, or the text has an ellipsis you did not copy — and Playwright's
 * answer is `locator.click: Timeout 15000ms exceeded`, which says how long it
 * waited and nothing about what went wrong. This says what was looked for and
 * what was actually clickable, which is usually enough to fix the line without
 * opening the page.
 *
 * The first version of this test script said `click "More information"` against
 * example.com, whose link now reads "Learn more". The timeout was correct and
 * told me nothing.
 */
async function explainMissing(page, target) {
	const labels = await page
		.evaluate((limit) => {
			const seen = [];
			for (const el of document.querySelectorAll("a, button, [role=button], input[type=submit], summary")) {
				const rect = el.getBoundingClientRect();
				if (rect.width === 0 || rect.height === 0) continue;
				const text = (el.innerText || el.value || el.getAttribute("aria-label") || "").trim();
				if (text && !seen.includes(text)) seen.push(text);
				if (seen.length >= limit) break;
			}
			return seen;
		}, SUGGEST)
		.catch(() => []);
	const near = labels.length ? `\n  clickable here: ${labels.map((l) => JSON.stringify(l)).join(", ")}` : "";
	return `nothing matched ${JSON.stringify(target)} on ${page.url()}${near}`;
}

async function runStep(page, step, log, agent) {
	const [a, b] = step.args;
	log(`${step.verb} ${step.args.map((x) => JSON.stringify(x)).join(" ")}`);

	// Resolve the target first, so a missing one is reported as missing rather
	// than as however long we were prepared to wait for it.
	if (NEEDS_TARGET.has(step.verb)) {
		const found = await locate(page, String(a))
			.first()
			.waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS })
			.then(() => true)
			.catch(() => false);
		if (!found) throw new Error(await explainMissing(page, String(a)));
	}
	switch (step.verb) {
		case "goto":
			await page.goto(String(a), { waitUntil: "domcontentloaded", timeout: STEP_TIMEOUT_MS });
			break;
		case "click":
			await locate(page, String(a)).click({ timeout: STEP_TIMEOUT_MS });
			await page.waitForTimeout(SETTLE_MS);
			break;
		case "dblclick":
			await locate(page, String(a)).dblclick({ timeout: STEP_TIMEOUT_MS });
			await page.waitForTimeout(SETTLE_MS);
			break;
		case "hover":
			await locate(page, String(a)).hover({ timeout: STEP_TIMEOUT_MS });
			break;
		case "type":
			// Typed, not filled: a demo wants to show the characters arriving.
			await locate(page, String(a)).click({ timeout: STEP_TIMEOUT_MS });
			await page.keyboard.type(String(b), { delay: 55 });
			break;
		case "fill":
			await locate(page, String(a)).fill(String(b), { timeout: STEP_TIMEOUT_MS });
			break;
		case "press":
			await page.keyboard.press(String(a));
			await page.waitForTimeout(SETTLE_MS);
			break;
		case "wait":
			await page.waitForTimeout(Number(a));
			break;
		case "scroll":
			await page.mouse.wheel(0, Number(a));
			await page.waitForTimeout(SETTLE_MS);
			break;
		case "expect":
			// The guard above already waited for it and threw if it never appeared —
			// which is the whole job. A demo that silently records the wrong screen
			// is worse than one that stops, so `expect` never saw it means stop.
			break;
		case "agent":
			if (!agent) throw new Error("this run has no Claude screen agent");
			await agent(String(a));
			break;
		default:
			throw new Error(`unhandled step ${step.verb}`);
	}
}

async function checkCommand() {
	const file = argv[1];
	if (!file) die("give me a script: rm-demo check <script.md>");
	const md = await readFile(resolve(file), "utf8").catch(() => die(`cannot read ${file}`));
	const parsed = parseDemo(md);
	const d = describeDemo(parsed);
	console.log(`\n  ${resolve(file)}`);
	console.log(`  ${d.actions} action${d.actions === 1 ? "" : "s"} · ${d.narration} narration line${d.narration === 1 ? "" : "s"}`);
	if (d.urls.length) for (const u of d.urls) console.log(`  visits    ${u}`);
	if (d.holdMs) console.log(`  holds     ${d.holdMs}ms in explicit waits`);
	if (parsed.problems.length) {
		console.log("");
		for (const p of parsed.problems) console.error(`  ✗ ${p}`);
		process.exit(1);
	}
	if (!d.actions) die("nothing to do — the script has no ```do block");
	console.log("\n  looks runnable\n");
}

/**
 * Record the screen while the script drives the browser.
 *
 * The order matters and is the whole trick. A browser's window title is whatever
 * page it shows, so there is nothing for `--window` to match before the first
 * `goto`. The driver therefore opens a blank page, stamps a sentinel title on it,
 * and only then starts the recorder — which resolves its source once and keeps it,
 * so the title reverting to the real page a moment later is fine.
 *
 * `--window` is still accepted, for capturing an app that is already open rather
 * than the browser this drives. Then no sentinel is involved.
 */
/**
 * Write the script by doing the demo.
 *
 * The other two commands need a script, and writing one means knowing a DSL and
 * guessing what a button is called — `expect "REQUEST QUOTE"` is a reasonable line
 * to read and an unreasonable one to be asked to author. Most people making these
 * videos are not developers, and a form with dropdowns is the same problem wearing
 * a hat: you would still have to know the button is "REQUEST QUOTE" and not
 * "Request quote".
 *
 * So this watches instead of driving. Open the app, click through it, close the
 * window, and lib/demo-record.mjs turns what happened into the same markdown the
 * other commands read — coalescing keystrokes into one `type`, wheel ticks into
 * one `scroll`, and real pauses into explicit `wait`s, because the pauses are part
 * of what makes a demo watchable and the first thing lost when re-authoring by hand.
 *
 * Nothing is recorded to video here. This produces the script; `capture` is what
 * records, and it can now be handed something nobody had to write.
 */
async function recordCommand() {
	const out = flag("out");
	if (typeof out !== "string") die("--out <script.md> is required");

	let chromium;
	try {
		({ chromium } = await import("playwright"));
	} catch {
		die("playwright is not installed here — pnpm install");
	}

	const width = Number(flag("width", DEFAULT_W));
	const height = Number(flag("height", DEFAULT_H));
	// Headed is not a choice here: the whole command is a person using the app.
	const browser = await chromium.launch({ headless: false });
	const context = await browser.newContext({ viewport: { width, height } });
	const watcher = await watchClicks(context);

	const page = await context.newPage();
	const start = typeof flag("url") === "string" ? String(flag("url")) : null;
	if (start) await page.goto(start).catch((err) => console.error(`  could not open ${start}: ${err.message}`));

	console.log("");
	console.log("  Click through the demo in the window that just opened.");
	console.log("  Close it when you are done, and the script is written.");
	console.log("");

	// The browser closing is the stop signal, because "close the window" is the
	// instruction a person is already following. Waiting on `close` rather than
	// polling: a context that is gone cannot be asked anything.
	await new Promise((resolve) => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			resolve();
		};
		context.on("close", finish);
		browser.on("disconnected", finish);
	});

	const steps = watcher.finish();
	if (!steps.length) {
		die("nothing was recorded — no clicks, no typing, no navigation");
	}

	const title = typeof flag("title") === "string" ? String(flag("title")) : "Recorded demo";
	const file = resolve(out);
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, serializeDemo(steps, { title }), "utf8");

	console.log(`  script    ${file}`);
	console.log(`  steps     ${steps.length}`);
	console.log("");
	console.log(`  next      rm-demo capture ${JSON.stringify(file)} --project <out.openscreen>`);
	console.log("");
}

async function captureCommand() {
	const file = argv[1];
	if (!file) die("give me a script: rm-demo capture <script.md> --project <out.openscreen>");
	const project = flag("project");
	if (typeof project !== "string") die("--project <out.openscreen> is required");

	const md = await readFile(resolve(file), "utf8").catch(() => die(`cannot read ${file}`));
	const parsed = parseDemo(md);
	if (parsed.problems.length) {
		for (const p of parsed.problems) console.error(`rm-demo: ${p}`);
		die(`${parsed.problems.length} problem(s) — nothing ran`);
	}
	const steps = actions(parsed);
	if (!steps.length) die("nothing to do — the script has no ```do block");

	/*
	 * Attach to the browser already on screen, or launch one.
	 *
	 * `--attach` is the one that matters for a real demo: the app under demonstration is
	 * usually already open, signed in, with data in it. Launching a fresh Chromium gets
	 * you a blank window that is signed into nothing — "run with the user's window, not
	 * a new chrome", which is exactly right.
	 *
	 * Attaching changes three rules, and all three follow from the page already existing:
	 * a `goto` is no longer required, `--window` is how you name that browser's window
	 * for the recorder rather than a contradiction, and no sentinel title is needed.
	 */
	const attach = has("attach") || typeof flag("cdp") === "string";
	const cdpUrl = typeof flag("cdp") === "string" ? String(flag("cdp")) : "http://127.0.0.1:9222";

	if (!attach && !steps.some((st) => st.verb === "goto")) {
		die(
			[
				"this script never navigates, so there would be nothing to act on.",
				"",
				"  `capture` drives its own browser, which starts blank. Add a first step that",
				"  goes somewhere — `goto https://your-app.example.com/...`, or `goto /path` with",
				"  --url set — and the rest of the script has a page to work on.",
			].join("\n"),
		);
	}

	let chromium;
	try {
		({ chromium } = await import("playwright"));
	} catch {
		die("playwright is not installed here — pnpm install");
	}

	/*
	 * --window and a script are contradictory, and silently doing both is worse.
	 *
	 * The script drives a browser this command launches. Naming another window means
	 * recording that one while the script drives the browser — two things, neither
	 * connected, which is what happened: the Ridgeline window was filmed while a blank
	 * Chromium got the clicks.
	 */
	if (!attach && typeof flag("window") === "string") {
		die(
			[
				`--window "${flag("window")}" cannot be recorded by a launched capture.`,
				"",
				"  Without --attach the script drives a browser this command opens, so that is",
				"  the window worth recording — naming another one films something nothing is",
				"  driving. That is what --attach is for:",
				"",
				`  rm-demo capture <script> --project <doc> --attach --window ${JSON.stringify(String(flag("window")))}`,
				"",
				"  Or record a window something else is driving: `openscreen record --window ...`",
				"  on its own, with no script.",
			].join("\n"),
		);
	}
	// When attaching, --window names the browser already on screen and is the point.
	const ownWindow = attach && typeof flag("window") === "string";
	const title = ownWindow ? String(flag("window")) : sentinelTitle(process.pid);
	const recorderArgsFor = (window) =>
		recordArgs({
			project: resolve(project),
			window,
			...(flag("display") !== undefined ? { display: flag("display") } : {}),
			...(flag("mic") === true ? { mic: true } : {}),
			...(typeof flag("mic-device") === "string" ? { micDevice: flag("mic-device") } : {}),
			...(flag("system-audio") === true ? { systemAudio: true } : {}),
			...(typeof flag("cursor") === "string" ? { cursor: flag("cursor") } : {}),
			...(flag("duration") !== undefined ? { duration: flag("duration") } : {}),
		});
	let recArgs;
	try {
		recArgs = recorderArgsFor(title);
	} catch (err) {
		die(err.message);
	}

	const width = Number(flag("width", DEFAULT_W));
	const height = Number(flag("height", DEFAULT_H));

	let browser;
	let context;
	let page;

	if (attach) {
		/*
		 * The browser already on screen, over CDP.
		 *
		 * Chrome cannot be given a debugging port while it is running, so a refusal here
		 * says how to start one — "could not connect" on its own sends people to the wrong
		 * problem. Chrome 111 and later also want --remote-allow-origins for a non-browser
		 * client, and omitting it fails at the WebSocket rather than the HTTP probe, which
		 * looks like a different fault again.
		 */
		try {
			browser = await chromium.connectOverCDP(cdpUrl);
		} catch (err) {
			die(
				[
					`could not attach to a browser at ${cdpUrl} (${String(err.message).split("\n")[0]})`,
					"",
					// The answer first, because it is the one almost everybody wants and it
					// costs nothing. Attaching exists for driving a session this cannot
					// reproduce — a VPN, an SSO device trust, a tab already deep in a flow.
					"  If you wanted a browser you stay signed in to, you do not need this:",
					"",
					"    --profile        real Chrome, its own profile, kept between captures.",
					"                     Sign in once in the window that opens; it remembers.",
					"                     Your everyday Chrome keeps running, untouched.",
					"",
					"  Attaching is for driving a session that cannot be reproduced — a VPN, an",
					"  SSO device trust, a tab already part-way through something. Chrome cannot",
					"  be given a debugging port while it is running, so that route means quitting",
					"  it completely and starting it again:",
					"",
					// Quoted, because zsh globs a bare * and the command it printed failed
					// with "no matches found" — a copy-pasteable line that does not paste.
					`    open -a "Google Chrome" --args --remote-debugging-port=9222 --remote-allow-origins='*'`,
				].join("\n"),
			);
		}
		context = browser.contexts()[0];
		if (!context) die(`attached to ${cdpUrl} but it has no browser context open`);

		/*
		 * Which page. `--page` matches a substring of the title or the URL, because a real
		 * browser has a dozen tabs open and the demo is one of them. Without it, the first
		 * page that is not blank or internal.
		 */
		const wanted = typeof flag("page") === "string" ? String(flag("page")).toLowerCase() : null;
		const usable = [];
		for (const candidate of context.pages()) {
			const url = candidate.url();
			if (!url || url === "about:blank" || url.startsWith("chrome://") || url.startsWith("devtools://")) continue;
			usable.push({ page: candidate, url, title: await candidate.title().catch(() => "") });
		}
		if (!usable.length) die(`attached to ${cdpUrl} but found no ordinary page open — only blank or internal tabs`);
		const hit = wanted
			? usable.find((c) => c.title.toLowerCase().includes(wanted) || c.url.toLowerCase().includes(wanted))
			: usable[0];
		if (!hit) {
			die(
				[
					`no open page matches --page ${JSON.stringify(String(flag("page")))}. Open tabs:`,
					"",
					...usable.map((c) => `    ${c.title.slice(0, 60)}  —  ${c.url.slice(0, 70)}`),
				].join("\n"),
			);
		}
		page = hit.page;
		await page.bringToFront().catch(() => {
			/* not fatal — the recorder captures the window, not the focused tab */
		});
		console.log("");
		console.log(`  attached  ${cdpUrl}`);
		console.log(`  page      ${(hit.title || hit.url).slice(0, 70)}`);
	} else {
		const want = typeof flag("browser") === "string" ? String(flag("browser")) : "chrome";
		if (!(want in BROWSER_CHANNELS)) die(`--browser must be one of ${Object.keys(BROWSER_CHANNELS).join(", ")}`);
		const headless = flag("headless") === true;
		const baseURL = typeof flag("url") === "string" ? String(flag("url")) : undefined;
		const profile = flag("profile");
		const wantsProfile = profile === true || typeof profile === "string";

		if (wantsProfile) {
			/*
			 * A persistent context IS the browser: there is no separate `browser`
			 * to close, and closing the context is what ends the session. `browser`
			 * stays null and every teardown below already tolerates that.
			 */
			const dir = typeof profile === "string" ? resolve(profile) : PROFILE_DIR;
			await mkdir(dir, { recursive: true });
			context = await chromium.launchPersistentContext(dir, {
				...launchOptions(want, headless),
				viewport: { width, height },
				baseURL,
			});
			page = context.pages()[0] ?? (await context.newPage());
			console.log(`  browser   ${want} · signed-in profile at ${dir}`);
		} else {
			const opened = await openBrowser(chromium, want, headless);
			browser = opened.browser;
			console.log(`  browser   ${opened.used}`);
			context = await browser.newContext({ viewport: { width, height }, baseURL });
			page = await context.newPage();
		}

		// Commit a real document with the sentinel title. Mutating about:blank's
		// title can satisfy Playwright while never reaching the window server.
		await page.goto(`data:text/html,${encodeURIComponent(`<!doctype html><title>${title}</title>`)}`);
		await page.waitForTimeout(TITLE_SETTLE_MS);
	}

	/*
	 * The sentinel has to survive navigation, because the recorder looks when it
	 * is ready rather than when we are.
	 *
	 * It was set once, on about:blank. The first `goto` in the script replaces
	 * `document.title` with the page's own — and the window title goes with it,
	 * because on every desktop the window IS the page title. If the recorder
	 * enumerated after that, it found no RM-CAPTURE-… and listed a screen full of
	 * windows named after the page it had just navigated to, which is exactly the
	 * failure: three windows called "RoleModel Studio" and no sentinel.
	 *
	 * Re-asserted on `load`, which runs after the document's own <title> is
	 * parsed, so it wins rather than racing it. The page's real title is kept and
	 * put back the moment the recorder is trusted, so the capture shows the title
	 * bar a viewer expects rather than a marker meant for the window manager.
	 */
	let holdSentinel = !ownWindow;
	let realTitle = "";
	const keepSentinel = async () => {
		if (!holdSentinel) return;
		try {
			realTitle = await page.title();
			if (realTitle === title) return;
			await page.evaluate((t) => {
				document.title = t;
			}, title);
		} catch {
			// Navigating, or torn down. The next load re-asserts it.
		}
	};
	page.on("load", keepSentinel);

	const releaseSentinel = async () => {
		if (!holdSentinel) return;
		holdSentinel = false;
		page.off("load", keepSentinel);
		if (!realTitle || realTitle === title) return;
		try {
			await page.evaluate((t) => {
				document.title = t;
			}, realTitle);
		} catch {
			// The page moved on and set its own title, which is the same outcome.
		}
	};

	const bin = typeof flag("openscreen") === "string" ? String(flag("openscreen")) : "openscreen";
	console.log("");
	/*
	 * Quoted for a shell, because this line exists to be pasted.
	 *
	 * `recArgs.join(" ")` printed the library path bare, and the default library
	 * lives at "~/RoleModel Library" — so the one command anybody would copy when a
	 * capture misbehaved was split at the space and failed on a directory that does
	 * not exist. The spawn was always right; only what it printed was not.
	 */
	const shq = (a) => (/^[A-Za-z0-9_@%+=:,.\/-]+$/.test(a) ? a : `'${String(a).replaceAll("'", `'\\''`)}'`);
	let captureTitle = title;
	let source = await waitForWindowSource(bin, captureTitle);
	/*
	 * Chromium sometimes reports a freshly launched window as "New page" to
	 * ScreenCaptureKit even after its document title has changed. That is not a
	 * user window we should guess at: use it only when it is the one and only
	 * default-title window currently visible. It lets the recorder acquire the
	 * launched browser without ever widening a match to an unrelated window.
	 */
	if (!source.found && !ownWindow) {
		const newPages = source.windows.filter((name) => name === "New page");
		if (newPages.length === 1) {
			captureTitle = newPages[0];
			recArgs = recorderArgsFor(captureTitle);
			source = { ...source, found: true };
			console.log('  capture   Chromium reported the launched window as "New page"; using it.');
		}
	}
	if (!source.found) {
		await (browser ?? context)?.close();
		die(
			[
				`OpenScreen could not see the capture window "${captureTitle}" before recording began.`,
				"The driven browser did not become a recordable window, so no capture was started.",
				source.windows.length ? `Windows OpenScreen can see: ${source.windows.join(" · ")}` : "OpenScreen returned no recordable windows.",
			].join("\n\n  "),
		);
	}
	console.log(`  recorder  ${bin} ${recArgs.map(shq).join(" ")}`);
	/*
	 * "Recording started", not a guess.
	 *
	 * The CLI emits `{"event":"started"}` when its runner window exists — which is
	 * 300ms in and means nothing yet — and then, seconds later, a log line saying
	 * which window it resolved and that recording began. Measured on this machine:
	 * started at 338ms, `Recording source:` at 5022ms, `Recording started` at
	 * 5662ms.
	 *
	 * That gap is the whole bug. The old code waited a flat 2.5s for a failure and
	 * then ran the script, so the recorder was still looking for its window while
	 * the first steps navigated the page out from under the sentinel — and the
	 * opening seconds of every successful capture were never filmed either.
	 */
	let capturing = null;
	const recording = new Promise((r) => {
		capturing = r;
	});
	const child = spawn(bin, recArgs, { stdio: ["pipe", "pipe", "pipe"] });
	const rec = attachRecorder(child, {
		onLog: (line) => console.error(`  [record] ${line}`),
		onEvent: (ev) => {
			if (typeof ev?.message === "string" && /Recording started/i.test(ev.message)) capturing(true);
		},
	});

	/*
	 * A settle window rather than a "recording started" event, because the CLI does
	 * not emit one — its `started` fires when the runner window is created, before
	 * the capture exists. What it does do is fail loudly and early when no window
	 * matches, listing the ones that are open, so waiting a beat and then checking
	 * for a problem catches the failure that actually happens.
	 */
	/*
	 * Wait for the capture, or for the failure, or for the ceiling — whichever
	 * comes first. Polled rather than raced on a single timer so a recorder that
	 * fails at four seconds is reported at four seconds, not at the ceiling.
	 */
	const deadline = Date.now() + RECORDER_SETTLE_MS;
	let live = false;
	while (Date.now() < deadline) {
		if (rec.problem()) break;
		const got = await Promise.race([recording, new Promise((r) => setTimeout(() => r(false), 200))]);
		if (got) {
			live = true;
			break;
		}
	}
	if (!live && !rec.problem()) {
		console.error(`  [record] no "Recording started" after ${RECORDER_SETTLE_MS}ms — going ahead anyway`);
	}
	const early = rec.problem();
	if (early) {
		await (browser ?? context)?.close();
		die(
			/No window title contains/.test(early)
				? `${early}\n\n  OpenScreen saw "${title}" before the recorder started, but it disappeared before\n  the recorder latched onto it. The browser window closed or changed outside the capture.`
				: early,
		);
	}
	// The recorder had its window and did not complain, so the page can have its
	// own title back before a single step runs.
	await releaseSentinel();

	let failed = null;
	const started = Date.now();
	const agent = liveAgent(page, { workDir: dirname(resolve(project)), log: (msg) => console.log(`  ${msg}`) });
	for (const step of steps) {
		try {
			await runStep(page, step, (msg) => console.log(`  ${msg}`), agent);
		} catch (err) {
			failed = { step, message: err instanceof Error ? err.message : String(err) };
			break;
		}
	}
	await agent.cleanup();
	// A held tail, so the capture does not cut on the same frame as the last click.
	await page.waitForTimeout(TAIL_HOLD_MS);

	rec.stop();
	let result = null;
	try {
		result = await rec.finished();
	} catch (err) {
		await (browser ?? context)?.close();
		die(err.message);
	}
	/*
	 * Never close a browser we did not open.
	 *
	 * In attach mode this is the person's own Chrome with their tabs in it. Closing the
	 * context would take their session with it; disconnecting just lets go.
	 */
	if (attach) await (browser ?? context)?.close();
	else {
		await context.close();
		await (browser ?? context)?.close();
	}

	// The narration goes beside the document under the same basename, which is how
	// rm-voice and rm-mux find it without being told.
	const lines = narration(parsed);
	const docPath = result?.projectPath ?? resolve(project);
	let scriptOut = null;
	if (lines.length) {
		scriptOut = docPath.replace(/\.openscreen$/i, "") + ".narration.md";
		await writeFile(scriptOut, `${lines.join("\n\n")}\n`, "utf8");
	}

	const secs = ((Date.now() - started) / 1000).toFixed(1);
	console.log("");
	console.log(`  document  ${docPath}`);
	if (result?.screenVideoPath) console.log(`  video     ${result.screenVideoPath}`);
	if (scriptOut) console.log(`  narration ${scriptOut}  (${lines.length} lines)`);
	console.log(`  ran       ${steps.length} steps in ${secs}s`);
	console.log("");
	console.log("  next      rm-video brand <document> --preset rolemodel, then open it");
	if (failed) {
		console.error(`\nrm-demo: stopped at line ${failed.step.line} (${failed.step.verb}): ${failed.message}`);
		console.error("  the capture above covers everything up to that point.");
		process.exit(1);
	}
}

async function runCommand() {
	const file = argv[1];
	if (!file) die("give me a script: rm-demo run <script.md> --out <dir>");
	const outDir = flag("out");
	if (typeof outDir !== "string") die("--out <dir> is required");

	const md = await readFile(resolve(file), "utf8").catch(() => die(`cannot read ${file}`));
	const parsed = parseDemo(md);
	if (parsed.problems.length) {
		for (const p of parsed.problems) console.error(`rm-demo: ${p}`);
		die(`${parsed.problems.length} problem(s) — nothing ran`);
	}
	const steps = actions(parsed);
	if (!steps.length) die("nothing to do — the script has no ```do block");

	let chromium;
	try {
		({ chromium } = await import("playwright"));
	} catch {
		die("playwright is not installed here — pnpm install");
	}

	const name = basename(String(file)).replace(/\.demo\.md$|\.md$/i, "");
	const dir = resolve(outDir);
	await mkdir(dir, { recursive: true });

	const width = Number(flag("width", DEFAULT_W));
	const height = Number(flag("height", DEFAULT_H));

	// Headed on purpose. A headless run records a browser nobody is looking at,
	// and the cursor telemetry recast draws its overlay from comes out of a real
	// pointer moving over a real window.
	const headless = flag("headless") === true;
	const want = typeof flag("browser") === "string" ? String(flag("browser")) : "chrome";
	if (!(want in BROWSER_CHANNELS)) die(`--browser must be one of ${Object.keys(BROWSER_CHANNELS).join(", ")}`);
	/*
	 * Captured at the pixel density the render will be shown at.
	 *
	 * Everything here used to record at 1×: a 1440-wide viewport produced a
	 * 1440-wide screencast, and a 1080p timeline then scaled it up by a third.
	 * Upscaling video is the one thing that cannot be recovered later — type goes
	 * soft, hairlines go grey, and it reads as a screenshot of a demo rather than
	 * a demo. A retina display was showing the operator something sharper than
	 * the file ever contained.
	 *
	 * So the page is rendered at `--scale` times the viewport and the screencast
	 * is recorded at those real pixels. The viewport stays the number the layout
	 * is designed around — the app still lays out as 1440 wide — while the frames
	 * come out at 2880, which downsamples into 1080p with detail to spare.
	 *
	 * 2 by default, because that is what the machines this runs on have and the
	 * cost is disk. `--scale 1` is there for a slow box or a long capture.
	 */
	const scale = Number(flag("scale", 2)) || 2;
	if (!(scale >= 1 && scale <= 3)) die("--scale must be between 1 and 3");
	const contextOptions = {
		viewport: { width, height },
		deviceScaleFactor: scale,
		recordVideo: { dir, size: { width: Math.round(width * scale), height: Math.round(height * scale) } },
		baseURL: typeof flag("url") === "string" ? String(flag("url")) : undefined,
	};

	/*
	 * `run` takes the same two browser flags as `capture`, and for the same reason.
	 *
	 * It used to call `chromium.launch()` bare — Playwright's own Chromium, blank,
	 * signed into nothing — so a script that clicked anything behind a login could
	 * be *captured* but not *rehearsed*. Since `run` is how you check a script
	 * before recording it, a rehearsal that cannot reach the page is not a
	 * rehearsal.
	 */
	const profile = flag("profile");
	let browser = null;
	let context;
	if (profile === true || typeof profile === "string") {
		const profileDir = typeof profile === "string" ? resolve(profile) : PROFILE_DIR;
		await mkdir(profileDir, { recursive: true });
		// A persistent context IS the browser; there is no separate handle to close.
		context = await chromium.launchPersistentContext(profileDir, { ...launchOptions(want, headless), ...contextOptions });
		console.log(`  browser   ${want} · signed-in profile at ${profileDir}`);
	} else {
		const opened = await openBrowser(chromium, want, headless);
		browser = opened.browser;
		context = await browser.newContext(contextOptions);
	}
	await context.tracing.start({ screenshots: true, snapshots: true, sources: false });

	const page = await context.newPage();
	let failed = null;
	const started = Date.now();
	const log = (msg) => console.log(`  ${msg}`);
	const agent = liveAgent(page, { workDir: dir, log });

	for (const step of steps) {
		try {
			await runStep(page, step, log, agent);
		} catch (err) {
			failed = { step, message: err instanceof Error ? err.message : String(err) };
			break;
		}
	}
	await agent.cleanup();

	// Named after the script, not "trace.zip", so the screencast can share the
	// basename. recast pairs them by basename — and so does our own /api/recast,
	// which does `trace.replace(/\.zip$/i, ".webm")`. A trace called `trace.zip`
	// beside a video called `demo.webm` never pairs, and the only symptom is a
	// choppy video assembled from sparse screenshot frames.
	const tracePath = join(dir, `${name}.zip`);
	await context.tracing.stop({ path: tracePath });
	// The video only exists once its page is closed, and its path only afterwards.
	const video = page.video();
	await page.close();
	const rawVideo = video ? await video.path().catch(() => null) : null;
	await context.close();
	await browser?.close();

	// Name the screencast after the trace so recast finds it and uses the smooth
	// path instead of assembling sparse screenshot frames.
	let webm = null;
	if (rawVideo) {
		webm = join(dir, `${name}.webm`); // same basename as the trace, deliberately
		await rename(rawVideo, webm).catch(() => {
			webm = rawVideo;
		});
	}

	// The narration, written beside the trace in the shape `rm-voice` reads, so the
	// next step in the chain needs no arguments teasing it out of the demo file.
	const lines = narration(parsed);
	const scriptOut = join(dir, `${name}.narration.md`);
	if (lines.length) await writeFile(scriptOut, `${lines.map((l) => l).join("\n\n")}\n`, "utf8");

	const secs = ((Date.now() - started) / 1000).toFixed(1);
	console.log("");
	console.log(`  trace     ${tracePath}`);
	if (webm) console.log(`  video     ${webm}`);
	if (lines.length) console.log(`  narration ${scriptOut}  (${lines.length} lines)`);
	console.log(`  ran       ${steps.length} steps in ${secs}s`);
	if (failed) {
		console.error(`\nrm-demo: stopped at line ${failed.step.line} (${failed.step.verb}): ${failed.message}`);
		console.error("  the trace above covers everything up to that point.");
		process.exit(1);
	}
	console.log(`\n  next:  playwright-recast -i ${tracePath} -o ${join(dir, `${name}.mp4`)}\n`);
}

switch (cmd) {
	case "check":
		await checkCommand();
		break;
	case "run":
		await runCommand();
		break;
	case "capture":
		await captureCommand();
		break;
	case "record":
		await recordCommand();
		break;
	default:
		console.log(
			[
				"",
				"rm-demo — drive a browser from a demo script, for recast to turn into video",
				"",
				"  check <script.md>                  parse it and say what it will do",
				"  run <script.md> --out <dir>        run it, leaving trace.zip and a screencast",
				"  capture <script.md> --project <p>  record the screen while it runs",
				"  record --out <script.md>           click through the app; the clicks are the script",
				"",
				"Options for run and capture",
				"  --url <base>      base URL for relative gotos",
				"  --width <px>      viewport width (default 1440)",
				"  --scale <n>       device pixel ratio, 1-3 (default 2 — record retina)",
				"  --height <px>     viewport height (default 900)",
				"  --headless        run without a visible window (worse cursor overlay)",
				"  --browser <name>  chrome (default) | chromium | edge",
				"  --profile [dir]   a browser you stay signed in to: real Chrome, its own",
				"                    profile, kept between runs. Sign in once in the window",
				"                    that opens. Your everyday browser is left alone.",
				"",
				"Options for capture — every one is an `openscreen record` flag",
				"  --project <out.openscreen>  where the document lands (required)",
				"  --display <n>               screen index, when recording a display",
				"  --window <title>            record this window instead of the browser",
				"  --mic                       capture the default microphone",
				"  --mic-device <name>         a named microphone (implies --mic)",
				"  --system-audio              capture system audio",
				`  --cursor <mode>             ${CURSOR_MODES.join(" | ")} (default editable-overlay)`,
				"  --duration <seconds>        a hard stop, on top of the script ending",
				"  --openscreen <path>         the CLI to drive (default: openscreen on PATH)",
				"",
				"Options for record",
				"  --out <script.md>  where to write it (required)",
				"  --url <page>       open here first, so you start where the demo starts",
				"  --title <text>     the heading on the script it writes",
				"",
				"`record` is for anyone who does not want to learn a DSL: open the app, click",
				"through it, close the window. What comes out is the same markdown `run` and",
				"`capture` read, so it stays editable by whoever does want to.",
				"",
				"`run` gives recast a trace. `capture` gives the editor a document — the",
				"brand preset, auto-zoom and the camera bubble only apply to the latter.",
				"",
				"A script is markdown: prose is narration, ```do blocks are actions.",
				"`agent \"goal\"` lets Claude inspect the current screenshot and live controls, then decide one action at a time. It uses your Claude account and stops after 16 actions unless RM_DEMO_AGENT_STEP_LIMIT says otherwise.",
				"The same file feeds rm-voice unchanged — it ignores fenced blocks.",
				"",
			].join("\n"),
		);
		break;
}
