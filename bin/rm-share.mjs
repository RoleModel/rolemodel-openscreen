#!/usr/bin/env node
/*
 * Share a finished video as a page.
 *
 *   rm-share <project-id> <video.mp4> [--title "..."] [--remote assets]
 *   rm-share <project-id> --list
 *   rm-share <project-id> --down <slug>
 *
 * The last mile. Everything else in the toolkit gets a video made; this puts it
 * in front of the person whose opinion decides whether it ships, on a page of
 * our own, with their notes landing on the frame they are about.
 *
 * The page goes to the public bucket set on a storage remote in the Studio
 * (Storage → public bucket and base URL); notes go through the team database's
 * Data API. No instance to run, no token to hold.
 */
import { resolve, sep } from "node:path";
import { defaultRoot, readManifest } from "../lib/library.mjs";
import { dataApiFor, listShares, publishShare, removeShare } from "../lib/share.mjs";
import { sharingSettings, stickerSettings, storagePublicBases } from "../lib/settings.mjs";

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
/* Words that are not flags and not a flag's value. */
const TAKES_VALUE = new Set(["--title", "--remote", "--down"]);
const positional = argv.filter((a, i) => !a.startsWith("--") && !TAKES_VALUE.has(argv[i - 1] ?? ""));

const projectId = positional[0];
if (!projectId || flag("help")) {
	console.log("usage: rm-share <project-id> <video> [--title ...] [--remote name]\n       rm-share <project-id> --list\n       rm-share <project-id> --down <slug>");
	process.exit(projectId ? 0 : 1);
}
const LIB = defaultRoot();
const projectDir = resolve(LIB, projectId);
if (!(await readManifest(projectDir).catch(() => null))) die(`no project "${projectId}" in ${LIB}`);

if (flag("list")) {
	const shares = await listShares(projectDir);
	if (!shares.length) console.log("nothing shared from this project yet");
	for (const sh of shares) console.log(`${sh.slug}\t${sh.at.slice(0, 10)}\t${sh.url}`);
	process.exit(0);
}
if (flag("down")) {
	const slug = String(flag("down"));
	const record = (await listShares(projectDir)).find((x) => x.slug === slug);
	if (!record) die(`no page "${slug}" — try --list`);
	await removeShare({ projectDir, projectId, record });
	console.log(`took down ${record.url}`);
	process.exit(0);
}

const video = positional[1];
if (!video) die("give a video file");
const file = resolve(video);
const mediaDir = resolve(projectDir, "media");
if (!file.startsWith(mediaDir + sep)) die(`the video has to live in the project's media folder: ${mediaDir}`);

const bases = await storagePublicBases();
const usable = Object.entries(bases).filter(([, v]) => v?.base && v?.bucket);
if (!usable.length) die("no storage remote has a public bucket and base URL — set one under Storage in the Studio");
const remote = flag("remote", usable[0][0]);
const pub = bases[remote];
if (!pub?.base || !pub?.bucket) die(`${remote} has no public bucket and base URL`);
const dataApi = (await stickerSettings()).dataApi || dataApiFor((await sharingSettings()).databaseUrl);
if (!dataApi) console.error("rm-share: no team database — the page will have no notes");

const record = await publishShare({
	projectDir,
	projectId,
	file,
	title: flag("title", undefined) === true ? undefined : flag("title", undefined),
	remote,
	publicBase: pub.base,
	publicBucket: pub.bucket,
	dataApi,
	onStep: (step) => console.error(`  ${step}…`),
});
console.log(record.url);
