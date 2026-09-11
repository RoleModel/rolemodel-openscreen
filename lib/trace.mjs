/*
 * A trace: what made this file.
 *
 * WHY EVERY OUTPUT CARRIES ONE
 *
 * A render is a claim — "this is the scene, on brand, at this length" — and
 * until now nothing backed it. Six weeks later the MP4 is in a deck and nobody
 * can say which scene it came from, which wallpaper, which brand preset, or
 * which version of the toolkit drew it. The file is evidence of nothing.
 *
 * So each output gets a `.trace.json` beside it naming its inputs. The test is
 * the one the Brand Context Protocol sets (craft.wild.as/bcp): if an output
 * cannot be reproduced from its trace, that is a bug.
 *
 * WHY BESIDE THE FILE AND NOT IN A LEDGER
 *
 * A ledger is a thing to keep in sync. A file next to the output is copied when
 * the output is copied, moved when it is moved, and deleted when somebody
 * decides the render was no good — which is exactly the lifetime the record
 * should have.
 */

import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

/** The path a trace takes: the output's own name, plus the suffix. */
export const tracePath = (out) => `${out}.trace.json`;

/*
 * The body is hashed rather than stored.
 *
 * A scene body is markup that may be thousands of characters, and the trace is
 * meant to be read. The hash answers the question a trace is for — "is this
 * still the thing that made it" — without the trace becoming a second copy of
 * the work.
 */
export const digest = (text) => createHash("sha256").update(String(text ?? ""), "utf8").digest("hex").slice(0, 16);

/**
 * Write the trace for one output.
 *
 * `inputs` is whatever was actually used, as it was used: the caller knows, and
 * anything guessed here would be a guess recorded as a fact.
 */
export async function writeTrace(out, { tool, version, project, inputs = {}, brand = null }) {
	const trace = {
		made: new Date().toISOString(),
		tool,
		version,
		project: project ?? null,
		output: out.split("/").pop(),
		brand,
		inputs,
	};
	await writeFile(tracePath(out), `${JSON.stringify(trace, null, 2)}\n`, "utf8");
	return trace;
}
