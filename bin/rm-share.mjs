#!/usr/bin/env node
/*
 * Send a finished video for review.
 *
 *   rm-share <video.mp4> --project "Feeney Railing" [--title "..."]
 *   rm-share --check
 *
 * The last mile. Everything else in the toolkit gets a video made; this gets it
 * in front of the person whose opinion decides whether it ships, with their notes
 * landing on the frame they are about rather than in a paragraph of email.
 *
 * Configuration is two variables, because a share link is outward-facing and
 * guessing where to publish is not a mistake worth making quietly:
 *
 *   OPENFRAME_URL    http://localhost:3100
 *   OPENFRAME_TOKEN  a token from OPENFRAME_API_TOKENS on that instance
 */
import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { openFrame, shareVideo } from "../lib/openframe.mjs";

const argv = process.argv.slice(2);
const flag = (n, d) => {
	const i = argv.indexOf(`--${n}`);
	if (i === -1) return d;
	const v = argv[i + 1];
	return v && !v.startsWith("--") ? v : true;
};
const die = (m) => {
	console.error(`rm-share: ${m}`);
	process.exit(1);
};

const base = process.env.OPENFRAME_URL;
const token = process.env.OPENFRAME_TOKEN;

if (argv.includes("--check") || argv.includes("--help") || !argv.length) {
	if (!argv.includes("--check")) {
		console.log(
			[
				"",
				"rm-share — send a finished video to OpenFrame for review",
				"",
				"  rm-share <video.mp4> --project <name> [--title <text>]",
				"  rm-share --check                      is it configured and reachable?",
				"",
				"Options",
				"  --project <name>   OpenFrame project; created if it does not exist",
				"  --title <text>     video title (default: the file name)",
				"  --workspace <name> workspace to put the project in",
				"  --no-guests        require an account to view, rather than a name",
				"",
				"Environment",
				"  OPENFRAME_URL      e.g. http://localhost:3100",
				"  OPENFRAME_TOKEN    from OPENFRAME_API_TOKENS on that instance",
				"",
			].join("\n"),
		);
		process.exit(0);
	}
	console.log("");
	console.log(`  url    ${base ?? "(OPENFRAME_URL unset)"}`);
	console.log(`  token  ${token ? `${token.slice(0, 8)}… (${token.length} chars)` : "(OPENFRAME_TOKEN unset)"}`);
	if (!base || !token) die("not configured");
	try {
		const api = openFrame({ base, token });
		const ws = await api.call("/api/workspaces");
		const list = Array.isArray(ws) ? ws : (ws?.workspaces ?? []);
		console.log(`  auth   ok — ${list.length} workspace${list.length === 1 ? "" : "s"}`);
		console.log("");
	} catch (err) {
		console.log("");
		die(err.message);
	}
	process.exit(0);
}

const file = resolve(argv[0]);
const projectName = flag("project");
if (typeof projectName !== "string") die("--project <name> is required");
if (!(await stat(file).catch(() => null))) die(`no such file: ${file}`);
if (!base || !token) die("set OPENFRAME_URL and OPENFRAME_TOKEN (rm-share --check)");

console.log(`\n  ${basename(file)} -> ${base}`);
try {
	const out = await shareVideo({
		base,
		token,
		file,
		project: projectName,
		title: typeof flag("title") === "string" ? flag("title") : undefined,
		workspace: typeof flag("workspace") === "string" ? flag("workspace") : undefined,
		onStep: (what) => console.log(`  ${what}…`),
	});
	console.log("");
	console.log(`  workspace  ${out.workspace}`);
	console.log(`  project    ${out.project}`);
	console.log(`  video      ${out.video.title}`);
	console.log("");
	console.log(`  share this: ${out.shareUrl}`);
	console.log("");
} catch (err) {
	console.log("");
	die(err.message);
}
