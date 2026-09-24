/*
 * A scene render, as a job.
 *
 *   node lib/render-scene-job.mjs <spec.json>
 *
 * WHY THIS EXISTS AND IS NOT A ROUTE
 *
 * `/api/scenes/render` used to `await renderScene(...)` inside the request
 * handler. An 85-second Showcase scene is about 2,500 frames and the better
 * part of an hour, so that shape had three problems, and all three were the
 * same problem wearing different hats: the server had no idea a render was
 * happening.
 *
 *   - Nothing could be shown. One fetch, no progress, no cancel, for an hour.
 *     So it looked broken, and people stopped it, which is how the black video
 *     was made in the first place.
 *   - Nothing could stop it on purpose, because there was nothing to stop.
 *   - The Studio restarts itself when its own code changes, and did so without
 *     knowing. `process.exit(0)` took ffmpeg with it.
 *
 * As a job it is a child process the server can watch, stream, stop and — the
 * point — leave alone. `jobs.stopAll` spares it on a restart (see rm-studio's
 * `restart`), and because it is a separate process it simply carries on with a
 * reparented pid and finishes the file.
 *
 * WHICH MEANS IT WRITES ITS OWN TRACE
 *
 * The trace used to be written by the route after the await returned. A render
 * that outlives the server has no route to return to, so the record of what
 * made the file belongs to the thing that made it. Written here, after the
 * render is whole, so the trace can never describe a file that does not exist.
 *
 * THE SPEC IS A FILE, NOT ARGV
 *
 * A scene body is markup — ten kilobytes of it for a real one, full of quotes
 * and newlines. Through argv that is a quoting bug waiting for the first
 * apostrophe in a caption. A path is also what makes `rerun` work: the job
 * stores its args, and the spec is still on disk.
 */
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { renderScene } from "./render-scene.mjs";

const specPath = process.argv[2];
if (!specPath) {
	console.error("usage: render-scene-job.mjs <spec.json>");
	process.exit(1);
}

const spec = JSON.parse(await readFile(specPath, "utf8"));
const { body, out, mediaRoot, trace = null, ...options } = spec;

/*
 * Progress, in whole percent.
 *
 * The Console keeps every line a job writes, and a line per frame is 2,500 of
 * them for one render — a log nobody can read, holding a scene's worth of
 * strings in memory for the life of the server. A percent is what a person
 * wants anyway, and the remaining time is the thing they are really asking.
 */
const started = Date.now();
let lastPercent = -1;
const onProgress = ({ frame, frames, total }) => {
	const percent = Math.floor((frame / frames) * 100);
	if (percent === lastPercent && frame !== frames) return;
	lastPercent = percent;
	const elapsed = (Date.now() - started) / 1000;
	// Only once there is enough of a rate to be honest about: the first frames
	// include the browser starting and the page settling, and an estimate drawn
	// from those says twenty minutes for a job that takes two.
	const left = frame > frames * 0.02 ? Math.round((elapsed / frame) * (frames - frame)) : null;
	const mins = left == null ? "" : left > 90 ? ` · about ${Math.round(left / 60)} min left` : ` · about ${left}s left`;
	console.log(`  ${percent}% · frame ${frame}/${frames} · ${(total / 1000).toFixed(1)}s scene${mins}`);
};

/*
 * A scene names the project's own media as `/media/<project>/…`, which is a
 * Studio route and not a path. The server resolved those itself; out here the
 * spec says which project directory they mean, and the containment check is the
 * same one — a scene cannot name its way out of the project it belongs to.
 */
const resolveFile = mediaRoot
	? (pathname) => {
			const rel = decodeURIComponent(pathname).replace(/^\/media\/[^/]+\//, "");
			const guess = join(mediaRoot, rel);
			return guess.startsWith(mediaRoot) && existsSync(guess) ? guess : null;
		}
	: null;

try {
	const made = await renderScene({ ...options, body, out, resolveFile, onProgress });
	/*
	 * The record of what made it, beside the file, and only now that the file is
	 * whole. `writeTrace` lives in the server's module graph; the shape is small
	 * and stable, so it is written directly rather than importing the Studio.
	 */
	if (trace) {
		await writeFile(
			`${out}.trace.json`,
			`${JSON.stringify({ ...trace, at: new Date().toISOString(), inputs: { ...trace.inputs, fps: made.fps, width: made.width, height: made.height, durationMs: made.durationMs, shotScale: made.shotScale } }, null, 2)}\n`,
		).catch(() => {});
	}
	console.log(`  wrote ${basename(made.file)} · ${(made.durationMs / 1000).toFixed(1)}s · ${made.height}p · ${made.frames} frames`);
	console.log(`  in ${dirname(made.file)}`);
	process.exit(0);
} catch (err) {
	console.error(`  render failed: ${err.message}`);
	process.exit(1);
}
