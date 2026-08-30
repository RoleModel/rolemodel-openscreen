#!/usr/bin/env node
/*
 * Render a Studio-owned HyperFrames composition, honestly.
 *
 * Three things happen here, in order, as one background job:
 *
 *   1. Reconcile. Every derived value in index.html — root duration, the clock
 *      track, Canvas `at`/`for`, the closing title, dissolve tails — is
 *      recomputed from the clips. Tightening an edit in HyperFrames moves the
 *      clips and nothing else; without this pass the render ends in dead air
 *      or a title that never appears. See lib/reconcile.mjs.
 *   2. Check, then render. The composition's own checker has to accept it
 *      first: a review link is not useful if its title, lower thirds or media
 *      paths never rendered.
 *   3. Verify the artifact. `hyperframes render` exits 0 on a failed render, so
 *      the exit code is not evidence — the file is. A render that wrote
 *      nothing fails here, out loud, rather than as a link to a missing MP4.
 */
import { spawn } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { reconcileAssembly } from "../lib/reconcile.mjs";
import { ensureClock } from "../lib/assembly-clock.mjs";

const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1] ?? "";
const output = value("--output");

if (!output) {
  console.error("rm-render-hyperframes: --output is required");
  process.exit(2);
}

const run = (commandArgs) => new Promise((resolve, reject) => {
  const child = spawn("npx", ["--yes", "hyperframes", ...commandArgs], { stdio: "inherit" });
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (code === 0) resolve();
    else reject(new Error(`hyperframes ${commandArgs[0]} ${signal ? `was stopped by ${signal}` : `exited ${code ?? 1}`}`));
  });
});

async function reconcile() {
  const index = join(process.cwd(), "index.html");
  const html = await readFile(index, "utf8").catch(() => null);
  if (html == null) return;
  const result = reconcileAssembly(html);
  if (result.changes.length) {
    console.log(`  reconciling ${result.changes.length} derived value${result.changes.length === 1 ? "" : "s"} with the content:`);
    for (const change of result.changes) console.log(`    ${change.id}: ${change.what} (${change.from ?? "unset"} → ${change.to})`);
    await writeFile(index, result.html, "utf8");
  } else {
    console.log(`  composition agrees with its content (${result.contentEndSec}s)`);
  }
  for (const problem of result.problems) console.log(`  ! ${problem}`);
  if (result.clock?.src && await ensureClock(process.cwd(), result.clock)) console.log(`  wrote ${result.clock.src}`);
}

try {
  await reconcile();
  await run(["check"]);
  await run(["render", "--output", output, "--quality", "draft"]);
  const artifact = await stat(output).catch(() => null);
  if (!artifact?.isFile() || artifact.size === 0) {
    throw new Error(`the render finished without writing ${output} — check the output above for the frame that failed`);
  }
  console.log(`  wrote ${output} (${(artifact.size / 1024 / 1024).toFixed(1)} MB)`);
} catch (error) {
  console.error(`rm-render-hyperframes: ${error.message}`);
  process.exit(1);
}
