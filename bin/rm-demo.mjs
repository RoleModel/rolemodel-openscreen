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
import { basename, join, resolve } from "node:path";
import { actions, describe as describeDemo, narration, parseDemo } from "../lib/demo-script.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0];
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
	default:
		console.log(
			[
				"",
				"rm-demo — drive a browser from a demo script, for recast to turn into video",
				"",
				"  check <script.md>                  parse it and say what it will do",
				"  run <script.md> --out <dir>        run it, leaving trace.zip and a screencast",
				"",
				"Options for run",
				"  --url <base>      base URL for relative gotos",
				"  --width <px>      viewport width (default 1440)",
				"  --height <px>     viewport height (default 900)",
				"  --headless        run without a visible window (worse cursor overlay)",
				"",
				"A script is markdown: prose is narration, ```do blocks are actions.",
				"The same file feeds rm-voice unchanged — it ignores fenced blocks.",
				"",
			].join("\n"),
		);
		break;
}
