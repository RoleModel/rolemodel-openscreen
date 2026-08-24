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
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

const DEFAULT_W = 1440;
const DEFAULT_H = 900;
/** How long a step may take before we call it stuck. */
const STEP_TIMEOUT_MS = 15_000;
/** Breathing room after a click, so the trace has frames showing the result. */
const SETTLE_MS = 350;
/** How long the sentinel title needs to reach the window manager. */
const TITLE_SETTLE_MS = 400;
/** How long to let the recorder fail before trusting it. */
const RECORDER_SETTLE_MS = 2500;
/** Held frames after the last step, so the cut is not on the click. */
const TAIL_HOLD_MS = 900;

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

async function runStep(page, step, log) {
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
		die("playwright is not installed here — npm install");
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
		die("playwright is not installed here — npm install");
	}

	/*
	 * --window and a script are contradictory, and silently doing both is worse.
	 *
	 * The script drives a browser this command launches. Naming another window means
	 * recording that one while the script drives the browser — two things, neither
	 * connected, which is what happened: the Feeney window was filmed while a blank
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
	let recArgs;
	try {
		recArgs = recordArgs({
			project: resolve(project),
			window: title,
			...(flag("display") !== undefined ? { display: flag("display") } : {}),
			...(flag("mic") === true ? { mic: true } : {}),
			...(typeof flag("mic-device") === "string" ? { micDevice: flag("mic-device") } : {}),
			...(flag("system-audio") === true ? { systemAudio: true } : {}),
			...(typeof flag("cursor") === "string" ? { cursor: flag("cursor") } : {}),
			...(flag("duration") !== undefined ? { duration: flag("duration") } : {}),
		});
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
					"  Chrome cannot be given a debugging port while it is running, so it has to be",
					"  started with one. Quit Chrome completely, then:",
					"",
					// Quoted, because zsh globs a bare * and the command it printed failed
					// with "no matches found" — a copy-pasteable line that does not paste.
					`    open -a "Google Chrome" --args --remote-debugging-port=9222 --remote-allow-origins='*'`,
					"",
					"  That keeps your normal profile, so you stay signed in. Then run this again",
					"  with --attach.",
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
		browser = await chromium.launch({ headless: flag("headless") === true });
		context = await browser.newContext({
			viewport: { width, height },
			baseURL: typeof flag("url") === "string" ? String(flag("url")) : undefined,
		});
		page = await context.newPage();

		// The sentinel has to be on a page the OS can see before the recorder looks.
		await page.goto("about:blank");
		await page.evaluate((t) => {
			document.title = t;
		}, title);
		await page.waitForTimeout(TITLE_SETTLE_MS);
	}

	const bin = typeof flag("openscreen") === "string" ? String(flag("openscreen")) : "openscreen";
	console.log("");
	console.log(`  recorder  ${bin} ${recArgs.join(" ")}`);
	const child = spawn(bin, recArgs, { stdio: ["pipe", "pipe", "pipe"] });
	const rec = attachRecorder(child, {
		onLog: (line) => console.error(`  [record] ${line}`),
	});

	/*
	 * A settle window rather than a "recording started" event, because the CLI does
	 * not emit one — its `started` fires when the runner window is created, before
	 * the capture exists. What it does do is fail loudly and early when no window
	 * matches, listing the ones that are open, so waiting a beat and then checking
	 * for a problem catches the failure that actually happens.
	 */
	await new Promise((r) => setTimeout(r, RECORDER_SETTLE_MS));
	const early = rec.problem();
	if (early) {
		await browser.close();
		die(early);
	}

	let failed = null;
	const started = Date.now();
	for (const step of steps) {
		try {
			await runStep(page, step, (msg) => console.log(`  ${msg}`));
		} catch (err) {
			failed = { step, message: err instanceof Error ? err.message : String(err) };
			break;
		}
	}
	// A held tail, so the capture does not cut on the same frame as the last click.
	await page.waitForTimeout(TAIL_HOLD_MS);

	rec.stop();
	let result = null;
	try {
		result = await rec.finished();
	} catch (err) {
		await browser.close();
		die(err.message);
	}
	/*
	 * Never close a browser we did not open.
	 *
	 * In attach mode this is the person's own Chrome with their tabs in it. Closing the
	 * context would take their session with it; disconnecting just lets go.
	 */
	if (attach) await browser.close();
	else {
		await context.close();
		await browser.close();
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
		die("playwright is not installed here — npm install");
	}

	const name = basename(String(file)).replace(/\.demo\.md$|\.md$/i, "");
	const dir = resolve(outDir);
	await mkdir(dir, { recursive: true });

	const width = Number(flag("width", DEFAULT_W));
	const height = Number(flag("height", DEFAULT_H));

	// Headed on purpose. A headless run records a browser nobody is looking at,
	// and the cursor telemetry recast draws its overlay from comes out of a real
	// pointer moving over a real window.
	const browser = await chromium.launch({ headless: flag("headless") === true });
	const context = await browser.newContext({
		viewport: { width, height },
		recordVideo: { dir, size: { width, height } },
		baseURL: typeof flag("url") === "string" ? String(flag("url")) : undefined,
	});
	await context.tracing.start({ screenshots: true, snapshots: true, sources: false });

	const page = await context.newPage();
	let failed = null;
	const started = Date.now();
	const log = (msg) => console.log(`  ${msg}`);

	for (const step of steps) {
		try {
			await runStep(page, step, log);
		} catch (err) {
			failed = { step, message: err instanceof Error ? err.message : String(err) };
			break;
		}
	}

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
	await browser.close();

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
				"  --height <px>     viewport height (default 900)",
				"  --headless        run without a visible window (worse cursor overlay)",
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
				"The same file feeds rm-voice unchanged — it ignores fenced blocks.",
				"",
			].join("\n"),
		);
		break;
}
