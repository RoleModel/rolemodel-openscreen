/**
 * The silent clock track an assembly composition seeks by.
 *
 * Canvas parts are seekable DOM, not media: during a HyperFrames preview their
 * clock comes from whichever source video is playing, and an authored closing
 * title after the last video has nothing left to tick — it sits at t=0,
 * invisible. One tiny silent audio track spanning the composition gives every
 * Canvas beat the same clock in preview and export.
 *
 * Named for its length (`canvas-clock-172s.m4a`) so the reconcile pass can
 * tell from the filename whether the clock still matches the content, and so
 * a longer cut gets a new file rather than a truncated one.
 */
import { spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { childEnv } from "./jobs.mjs";

export const clockFile = (seconds) => `assets/canvas-clock-${Math.max(1, Math.ceil(Number(seconds) || 0))}s.m4a`;

/**
 * Make sure `clock.src` exists under `dir`, for `clock.seconds` of silence.
 * Resolves true when a file was written, false when it was already there.
 */
export async function ensureClock(dir, clock) {
	const src = String(clock?.src ?? "");
	const seconds = Math.max(1, Math.ceil(Number(clock?.seconds) || 0));
	if (!src) return false;
	const target = join(dir, src);
	if (await stat(target).catch(() => null)) return false;
	await mkdir(dirname(target), { recursive: true });
	await new Promise((resolveClock, rejectClock) => {
		/*
		 * jobs.childEnv(), not the bare process.env.
		 *
		 * Launched from Finder, Studio's PATH is /usr/bin:/bin and Homebrew's
		 * ffmpeg is invisible; the assembly then died with `spawn ffmpeg ENOENT`
		 * naming a binary the person could plainly see installed.
		 */
		const child = spawn("ffmpeg", [
			"-y",
			"-f", "lavfi",
			"-i", "anullsrc=r=8000:cl=mono",
			"-t", String(seconds),
			"-c:a", "aac",
			"-b:a", "8k",
			"-movflags", "+faststart",
			target,
		], { stdio: "ignore", env: childEnv() });
		child.once("error", rejectClock);
		child.once("close", (code) => code === 0
			? resolveClock()
			: rejectClock(new Error("could not create the Canvas timeline clock (is ffmpeg installed?)")));
	});
	return true;
}
