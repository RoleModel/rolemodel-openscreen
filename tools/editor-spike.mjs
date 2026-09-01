#!/usr/bin/env node
/*
 * A server for the timeline spike, and nothing else.
 *
 *   node tools/editor-spike.mjs <projectId> <folder> [--page <file>] [--port 0]
 *
 * In tools/ rather than bin/ on purpose. Everything in bin/ is a command the
 * package declares, the formula ships and the docs count — and a scratch server
 * that exists to answer one question is none of those. It leaves when the
 * question is answered.
 *
 * The timeline draws from three places — the cut, the filmstrip frames and the
 * peaks — and they live in two different directories. This puts them on one
 * origin so a page can fetch them, and serves the renderer straight out of lib/
 * so there is no build step between changing it and seeing it.
 *
 * Deliberately not part of Studio yet. The question this spike has to answer is
 * whether the paint is fast with real material, and the fastest way to be wrong
 * about that is to spend a day on panel plumbing first. It gets folded in once
 * the answer is yes.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { defaultRoot } from "../lib/library.mjs";

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
	const i = argv.indexOf(`--${name}`);
	return i === -1 ? fallback : argv[i + 1];
};
const die = (m) => {
	console.error(`editor-spike: ${m}`);
	process.exit(1);
};

const [projectId, folder] = argv.filter((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1]?.startsWith("--") !== true);
if (!projectId || !folder) die("usage: node tools/editor-spike.mjs <projectId> <folder> [--page <file>] [--port N]");

const HERE = resolve(new URL("..", import.meta.url).pathname);
const cutDir = join(defaultRoot(), projectId, "media", "Renders", folder);
const cacheDir = join(defaultRoot(), projectId, "media", ".edit-cache");
const page = resolve(flag("page") ?? join(HERE, "tools", "timeline-spike.html"));

if (!(await stat(join(cutDir, "cut.json")).catch(() => null))) die(`no cut.json in ${cutDir} — run rm-cut seed first`);

const MIME = {
	".html": "text/html",
	".js": "text/javascript",
	".mjs": "text/javascript",
	".json": "application/json",
	".jpg": "image/jpeg",
	".png": "image/png",
	".mp4": "video/mp4",
};

const send = async (res, file) => {
	const info = await stat(file).catch(() => null);
	if (!info?.isFile()) {
		res.writeHead(404);
		return res.end("no");
	}
	res.writeHead(200, { "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream", "content-length": info.size });
	createReadStream(file).pipe(res);
};

const server = createServer(async (req, res) => {
	const path = decodeURIComponent(req.url.split("?")[0]);
	if (path === "/" || path === "/index.html") return send(res, page);
	if (path === "/cut.json") return send(res, join(cutDir, "cut.json"));
	/* Only these three prefixes, and each resolved back inside its own root —
	   a spike server is still a server, and `..` in a URL is still `..`. */
	for (const [prefix, root] of [["/cache/", cacheDir], ["/lib/", join(HERE, "lib")]]) {
		if (!path.startsWith(prefix)) continue;
		const file = resolve(root, path.slice(prefix.length));
		if (!file.startsWith(root)) {
			res.writeHead(403);
			return res.end("no");
		}
		return send(res, file);
	}
	res.writeHead(404);
	res.end("no");
});

await new Promise((done) => server.listen(Number(flag("port", 0)), "127.0.0.1", done));
console.log(`\n  timeline spike  http://127.0.0.1:${server.address().port}/`);
console.log(`  cut             ${join(cutDir, "cut.json")}`);
console.log(`  cache           ${cacheDir}\n`);
