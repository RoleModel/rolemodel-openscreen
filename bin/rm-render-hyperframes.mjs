#!/usr/bin/env node
/*
 * Render a Studio-owned HyperFrames composition only after its own checker has
 * accepted it. This deliberately runs as one background job: a review link is
 * not useful if its title, lower thirds, or media paths never rendered.
 */
import { spawn } from "node:child_process";

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

try {
  await run(["check"]);
  await run(["render", "--output", output, "--quality", "draft"]);
} catch (error) {
  console.error(`rm-render-hyperframes: ${error.message}`);
  process.exit(1);
}
