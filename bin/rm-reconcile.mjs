#!/usr/bin/env node
/**
 * Reconcile a Studio assembly composition with its own content.
 *
 *   rm-reconcile <composition dir> [--check]
 *
 * Recomputes every derived value in index.html from the clips — root
 * duration, the clock track, Canvas `at`/`for`, the closing title, dissolve
 * tails and transitions — and writes the file back. With `--check` nothing is
 * written: the disagreements are listed and the exit code is 1 when there are
 * any, so a build can fail on a stale composition instead of rendering it.
 *
 * The pass itself lives in lib/reconcile.mjs; the render job runs the same
 * thing before every render, so this is for looking, and for CI.
 */
import { readFile, writeFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { auditAssembly, reconcileAssembly } from "../lib/reconcile.mjs";
import { ensureClock } from "../lib/assembly-clock.mjs";

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const dir = resolve(args.find((arg) => !arg.startsWith("--")) ?? ".");
const index = join(dir, "index.html");

if (!(await stat(index).catch(() => null))?.isFile()) {
	console.error(`rm-reconcile: no index.html in ${dir}`);
	process.exit(2);
}

const html = await readFile(index, "utf8");

if (checkOnly) {
	const findings = auditAssembly(html);
	if (!findings.length) {
		console.log("  the composition agrees with its content");
		process.exit(0);
	}
	console.log(`  ${findings.length} derived value${findings.length === 1 ? "" : "s"} disagree with the content:`);
	for (const finding of findings) console.log(`    - ${finding}`);
	process.exit(1);
}

const result = reconcileAssembly(html);
for (const change of result.changes) console.log(`  ${change.id}: ${change.what} (${change.from ?? "unset"} → ${change.to})`);
for (const problem of result.problems) console.log(`  ! ${problem}`);
if (result.html !== html) await writeFile(index, result.html, "utf8");
if (result.clock?.src) {
	const made = await ensureClock(dir, result.clock).catch((error) => {
		console.error(`rm-reconcile: ${error.message}`);
		process.exit(1);
	});
	if (made) console.log(`  wrote ${result.clock.src}`);
}
console.log(result.changes.length ? `  reconciled — content ends at ${result.contentEndSec}s` : `  already consistent — content ends at ${result.contentEndSec}s`);
