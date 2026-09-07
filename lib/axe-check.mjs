#!/usr/bin/env node
/*
 * Every view of the Studio, read by axe-core.
 *
 *   node lib/axe-check.mjs                 # against a Studio it starts itself
 *   node lib/axe-check.mjs --port 4600     # against one already running
 *   node lib/axe-check.mjs --view stickers # one view
 *   node lib/axe-check.mjs --json out.json # the whole finding list, for a diff
 *
 * WHY A REAL BROWSER AND NOT THE MARKUP
 *
 * Almost none of this page exists in studio.html: a view is built from
 * templates by lib/studio.js when you navigate to it, and half the problems
 * worth finding — a control with no name, a contrast pair, a heading that skips
 * a level — are only decidable once the styles have been applied and the DOM is
 * the shape a person meets. So this drives the Studio, one view at a time, and
 * runs axe against the page as rendered.
 *
 * WHAT IT REPORTS
 *
 * Violations only, and only WCAG 2 A/AA plus the best-practice set, grouped by
 * rule with the views each one appears in. A rule that fires on every view is
 * one thing to fix in the chrome, not thirty things.
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (n, d) => {
	const i = argv.indexOf(`--${n}`);
	if (i === -1) return d;
	const v = argv[i + 1];
	return v && !v.startsWith("--") ? v : true;
};

/** The views, read from the router so this list cannot drift from the app. */
async function views() {
	const src = await readFile(resolve(ROOT, "lib/studio.js"), "utf8");
	const block = src.slice(src.indexOf("const VIEWS = {"), src.indexOf("\n}", src.indexOf("const VIEWS = {")));
	return [...block.matchAll(/^\s{2}([a-z]+):/gm)].map((m) => m[1]);
}

const only = flag("view", null);
const wanted = only && only !== true ? [String(only)] : null;

let child = null;
let port = Number(flag("port", 0));
if (!port) {
	/* Its own Studio, on a port nothing else is on, so a run never disturbs the
	   one somebody is working in. */
	port = 47000 + Math.floor(Math.random() * 900);
	child = spawn(process.execPath, [resolve(ROOT, "bin/rm-studio.mjs"), "--port", String(port), "--no-open", "--no-watch"], { stdio: "ignore" });
	for (let i = 0; i < 100; i++) {
		const up = await fetch(`http://localhost:${port}/api/state`).then((r) => r.ok).catch(() => false);
		if (up) break;
		await new Promise((r) => setTimeout(r, 200));
	}
}
const stop = () => child?.kill();
process.on("exit", stop);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => (stop(), process.exit(1)));

const { chromium } = await import("playwright");
const axePath = require.resolve("axe-core/axe.min.js");
const axeSource = await readFile(axePath, "utf8");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
/* A run must not be a render: the checker navigates and reads, nothing else. */
page.on("dialog", (d) => d.dismiss().catch(() => {}));
await page.goto(`http://localhost:${port}/`, { waitUntil: "domcontentloaded" });
/*
 * Nothing may be mid-fade when the colours are read.
 *
 * A button caught halfway through its entrance is drawn at part opacity, and
 * the blended colour it happens to have at that instant is not a colour anybody
 * ever reads — it was reported as a contrast fault on a button that passes.
 */
await page.addStyleTag({ content: "*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition: none !important; }" });
await page.waitForTimeout(1500);

const list = wanted ?? (await views());
const findings = new Map();
const perView = [];

for (const view of list) {
	const went = await page.evaluate((v) => {
		try {
			// eslint-disable-next-line no-undef
			go(v);
			return true;
		} catch {
			return false;
		}
	}, view);
	if (!went) {
		perView.push({ view, error: "the router would not go there" });
		continue;
	}
	await page.waitForTimeout(1200);
	await page.addStyleTag({ content: "*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition: none !important; }" });
	await page.addScriptTag({ content: axeSource });
	const result = await page.evaluate(async () => {
		/* The whole page, chrome included: the nav and the header are on every
		   view and a fault there is a fault everywhere. */
		// eslint-disable-next-line no-undef
		return await axe.run(document, {
			runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"] },
			resultTypes: ["violations"],
		});
	});
	perView.push({ view, violations: result.violations.length, nodes: result.violations.reduce((n, v) => n + v.nodes.length, 0) });
	for (const v of result.violations) {
		const seen = findings.get(v.id) ?? { id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl, views: [], nodes: 0, example: null };
		seen.views.push(view);
		seen.nodes += v.nodes.length;
		seen.example ??= v.nodes[0]?.html?.slice(0, 160) ?? null;
		findings.set(v.id, seen);
	}
}
await browser.close();
stop();

const RANK = { critical: 0, serious: 1, moderate: 2, minor: 3 };
const all = [...findings.values()].sort((a, b) => (RANK[a.impact] ?? 9) - (RANK[b.impact] ?? 9) || b.nodes - a.nodes);

const out = flag("json", null);
if (out && out !== true) {
	const { writeFile } = await import("node:fs/promises");
	await writeFile(String(out), `${JSON.stringify({ views: perView, findings: all }, null, "\t")}\n`, "utf8");
}

console.log(`\naxe-core ${require("axe-core/package.json").version} · ${list.length} views\n`);
if (!all.length) console.log("  no violations\n");
for (const f of all) {
	console.log(`  ${String(f.impact ?? "?").padEnd(8)} ${f.id} — ${f.help}`);
	console.log(`           ${f.nodes} element${f.nodes === 1 ? "" : "s"} across ${f.views.length} view${f.views.length === 1 ? "" : "s"}: ${f.views.slice(0, 8).join(", ")}${f.views.length > 8 ? "…" : ""}`);
	if (f.example) console.log(`           e.g. ${f.example.replace(/\s+/g, " ")}`);
}
const worst = all.filter((f) => f.impact === "critical" || f.impact === "serious");
console.log(`\n  ${all.length} rule${all.length === 1 ? "" : "s"} broken · ${worst.length} serious or worse\n`);
process.exit(flag("strict") && worst.length ? 1 : 0);
