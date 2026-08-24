#!/usr/bin/env node
/**
 * rm-studio — the one window.
 *
 * WHY THIS AND NOT A FORK OF OPENSCREEN
 *
 * Forking OpenScreen means owning an Electron shell plus a Rust compositor plus
 * a Swift capture helper plus a C++ Win32 helper, against a repo shipping ~2.4
 * releases a day, forever — to add panels that are all just HTML. And it buys
 * nothing we can't get: OpenScreen already exposes everything through a headless
 * CLI and a JSON document. We are a *client* of it, not a fork of it.
 *
 * So this is a local web app. One command, one window, no Electron, no build
 * step, no dependencies. It shells out to openscreen, hyperframes, ffmpeg and
 * rclone — the same tools you'd run by hand — and gives them a shared surface.
 * When OpenScreen ships a new version you `brew upgrade`, and nothing here
 * needs merging.
 *
 *   rm-studio            # serves on :4600 and opens a browser
 *   rm-studio --port 5000 --no-open
 *   rm-studio --watch    # live-reloads an already-open tab; opens nothing
 *   rm-studio --watch --open
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { renderStudioHTML } from "../lib/studio-ui.mjs";
import {
	buildCatalog,
	capture,
	defaultRoot,
	newManifest,
	readManifest,
	run,
	writeManifest,
} from "../lib/library.mjs";
import { ROOT as TOOLKIT, loadPreset } from "../lib/theme.mjs";
import { describe as describeDemo, parseDemo } from "../lib/demo-script.mjs";
import { openFrame, shareVideo } from "../lib/openframe.mjs";
import { openFrameSettings, setOpenFrameSettings } from "../lib/settings.mjs";
import { loadRecipes, saveRecipes } from "../lib/make-wallpapers.mjs";
import { css as wpCSS, normalize as normalizeRecipe, slug as wpSlug } from "../lib/wallpaper.mjs";
import * as jobs from "../lib/jobs.mjs";
import { isReady as voiceReady, venvDir } from "../lib/voice-setup.mjs";

// Absolute binary paths are permitted only inside the install. See lib/jobs.mjs.
jobs.setTrustedRoot(TOOLKIT);
// bin/shims ahead of PATH for everything we spawn. openscreen is the reason:
// launched through the cask's symlink, Electron cannot find its helper apps and
// every command that forks dies with "Unable to find helper app".
jobs.addPath(join(TOOLKIT, "bin", "shims"));

const argv = process.argv.slice(2);
const flag = (n, d) => {
	const i = argv.indexOf(`--${n}`);
	if (i === -1) return d;
	const v = argv[i + 1];
	return v && !v.startsWith("--") ? v : true;
};

const PORT = Number(flag("port", 4600));
// Free-text commands are opt-in. See lib/jobs.mjs.
const SHELL = argv.includes("--shell");
// `npm run dev` sets this. See the watch block near the bottom.
const WATCH = argv.includes("--watch");
const LIB = defaultRoot();

/**
 * Re-read a project's media and write the catalog.
 *
 * Called by /api/index and, more importantly, automatically after a job that
 * wrote into a project. Building a narration and not seeing it in the Library
 * until you remember to press Re-index is the tool failing to notice its own
 * output — the catalog was hours older than the file it was missing.
 */
async function reindex(id, { force = false } = {}) {
  // Reuse what was probed last time so this is cheap enough to run on every
  // load; only new or changed files cost an ffprobe.
  const previous = await readFile(join(projectDir(id), "catalog.json"), "utf8")
    .then(JSON.parse)
    .catch(() => null);
  const catalog = await buildCatalog(mediaDir(id), { previous, force });
  await writeFile(join(projectDir(id), "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  const m = await readManifest(projectDir(id));
  m.catalog = { indexedAt: catalog.indexedAt, files: catalog.files.length, bytes: catalog.bytes };
  await writeManifest(projectDir(id), m);
  return catalog;
}
// Where job records live. Beside the library rather than in the repo: they
// describe work done on that library, and they must outlive this process.
jobs.setJournal(join(LIB, ".rm-studio", "jobs"));
const SCRIPTS = join(LIB, "_scripts");
const projectDir = (id) => join(LIB, id);
const mediaDir = (id) => join(projectDir(id), "media");
const thumbDir = (id) => join(projectDir(id), ".thumbs");

const MIME = {
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".m4v": "video/mp4",
  ".webm": "video/webm", ".mkv": "video/x-matroska",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
  ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav",
};

const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

async function listProjects() {
  let entries = [];
  try {
    entries = await readdir(LIB, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith("_") || e.name.startsWith(".")) continue;
    try {
      const m = await readManifest(join(LIB, e.name));
      try {
        m.catalog = JSON.parse(await readFile(join(LIB, e.name, "catalog.json"), "utf8"));
      } catch {
        m.catalog = { files: [] };
      }
      out.push(m);
    } catch {
      /* not a project */
    }
  }
  return out;
}

/**
 * Poster frame, cached. Seeks 1s in rather than frame 0 — the first frame of a
 * screen recording is usually a blank window before anything has painted.
 */
/**
 * The absolute path a request is talking about.
 *
 * Two shapes, because there are two kinds of caller. A media file is named by
 * its project and its catalog-relative path — `Footage/demo.mp4` — and the
 * client has no business knowing those live under `media/`. It guessed, built
 * `<library>/<id>/Footage/demo.mp4`, and got "no such file" for something
 * plainly on disk. Anything else — a script, a project root — arrives as an
 * absolute path, because it is not inside the media tree.
 *
 * `join` normalises, so a `..` in `rel` cannot climb out unnoticed: the caller's
 * containment check sees the resolved path.
 */
function requestedPath(body) {
	if (body.projectId && body.rel) return join(mediaDir(String(body.projectId)), String(body.rel));
	return resolve(String(body.path ?? body.file ?? ""));
}

/**
 * Run something and keep its stdout as bytes.
 *
 * `capture()` accumulates into a string, which is right for JSON and NDJSON and
 * wrong for pixels — every byte above 0x7f comes back as a replacement
 * character, so a raw frame read through it is noise. Nothing else here needs
 * binary output, which is why capture() is the way it is.
 */
function captureBinary(cmd, args) {
	return new Promise((done) => {
		const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"], env: jobs.childEnv() });
		const chunks = [];
		child.stdout?.on("data", (d) => chunks.push(d));
		child.on("error", () => done(Buffer.alloc(0)));
		child.on("close", () => done(Buffer.concat(chunks)));
	});
}

/** Candidate offsets, as fractions of the duration, tried in this order. */
const POSTER_CANDIDATES = [0.5, 0.75, 0.35, 0.9, 0.15];
const POSTER_MIN_SEC = 0.5;
/** The probe size for judging a candidate. Big enough to see a border, small enough to be free. */
const POSTER_PROBE_W = 32;
const POSTER_PROBE_H = 18;
/** A border row this uniform, at this kind of level, is wallpaper rather than content. */
const POSTER_BORDER_SPREAD = 26;
const POSTER_BORDER_FLOOR = 26;

/**
 * Judge a candidate frame by its top and bottom rows.
 *
 * A composed frame has wallpaper along both edges: mid-level and fairly uniform,
 * because the wallpaper is a texture rather than a picture. A frame taken inside
 * an auto-zoom has screen content running to the edges instead — brighter,
 * darker, or wildly varying. So a candidate scores by how much of its border
 * looks like wallpaper, and the best one becomes the poster.
 */
function posterScore(grey) {
	const rows = [0, POSTER_PROBE_H - 1].map((y) => grey.subarray(y * POSTER_PROBE_W, (y + 1) * POSTER_PROBE_W));
	let score = 0;
	for (const row of rows) {
		let min = 255;
		let max = 0;
		let sum = 0;
		for (const v of row) {
			if (v < min) min = v;
			if (v > max) max = v;
			sum += v;
		}
		const mean = sum / row.length;
		if (max - min <= POSTER_BORDER_SPREAD && mean >= POSTER_BORDER_FLOOR) score++;
	}
	return score;
}

/**
 * A poster frame for a file.
 *
 * Two things here were wrong in ways that only showed up once the pipeline
 * produced real video.
 *
 * The seek was a fixed `-ss 1`. Exports run with `--auto-zoom`, which puts a
 * zoom at the head of the clip, so one second in is usually *inside* that zoom:
 * the poster came out as a tight crop of the middle of the screen with the
 * wallpaper and the window frame nowhere in it, which reads as a broken
 * thumbnail rather than a zoomed one. A quarter of the way in clears the opening
 * zoom and any title card, and is a fairer picture of the video besides.
 *
 * The cache key was the filename alone, so a re-export kept the old poster
 * forever. Size and mtime are in the key now, which also means the stale ones
 * age out on their own instead of needing a sweep.
 */
/**
 * Hand a document to OpenScreen, the best way this install allows.
 *
 * Our fork adds `openscreen open <file>`, which loads the document straight into
 * the editor. Upstream 1.9.x has no such verb: its bundle declares no document
 * type, `open -a Openscreen <file>` launches the app and discards the argument,
 * and a bare path is a silent no-op. So probe once for the verb and use it if it
 * is there; otherwise bring the app up and reveal the file so it can be dragged
 * in, and say so rather than claiming it opened.
 *
 * The probe is cached because it spawns a GUI binary, and the answer cannot
 * change without the app being replaced underneath us.
 */
let openVerb = null;
async function hasOpenVerb() {
	if (openVerb !== null) return openVerb;
	const help = await capture("openscreen", ["help"]);
	openVerb = /openscreen\s+open\s+</.test(`${help.out}${help.err}`);
	return openVerb;
}

async function openInOpenScreen(file) {
	if (await hasOpenVerb()) {
		const r = await capture("openscreen", ["open", file]);
		if (r.ok) return { opened: true, via: "openscreen open", note: `Opened ${basename(file)} in OpenScreen.` };
		return { opened: false, via: "openscreen open", error: r.err.trim().slice(0, 200) || "the open verb failed" };
	}
	const app = await capture("open", ["-a", "Openscreen"]);
	const reveal = await capture("open", ["-R", file]);
	return {
		opened: false,
		via: "launch and reveal",
		launched: app.ok,
		revealed: reveal.ok,
		note:
			`OpenScreen is open and ${basename(file)} is selected in Finder. Drag it onto the window to edit it — ` +
			"this build has no `open` verb, so it cannot be handed a file. The fork adds one.",
	};
}

async function thumbnail(projectId, rel) {
  const src = join(mediaDir(projectId), rel);
  const st = await stat(src).catch(() => null);
  if (!st) return null;

  const safe = rel.replace(/[^a-z0-9]+/gi, "_");
  const stamp = `${st.size}-${Math.round(st.mtimeMs)}`;
  const dest = join(thumbDir(projectId), `${safe}-${stamp}.jpg`);
  try {
    await stat(dest);
    return dest;
  } catch {
    /* generate */
  }
  await mkdir(thumbDir(projectId), { recursive: true });

  const isStill = [".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff"].includes(extname(rel).toLowerCase());
  if (isStill) {
    const { ok } = await capture("ffmpeg", ["-y", "-i", src, "-vf", "scale=640:-2", "-q:v", "6", dest]);
    return ok ? dest : null;
  }

  // Pick the moment, rather than guessing it.
  //
  // A fixed offset does not work here: exports run with `--auto-zoom`, and the
  // zoom follows the cursor for seconds at a time, so one second in, or a quarter
  // of the way in, both landed inside it. The poster came out as a tight crop of
  // mid-screen with no wallpaper and no window frame — which looks like a broken
  // thumbnail rather than a zoomed one. So try a handful of offsets and keep the
  // frame that shows the whole composition. First candidate that scores full
  // marks wins; if none do, the best of them does.
  const probe = await capture("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", src,
  ]);
  const seconds = probe.ok ? Number.parseFloat(probe.out.trim()) : Number.NaN;
  const known = Number.isFinite(seconds) && seconds > 0;

  let at = POSTER_MIN_SEC;
  if (known) {
    let best = -1;
    for (const fraction of POSTER_CANDIDATES) {
      const when = Math.max(POSTER_MIN_SEC, seconds * fraction);
      const shot = await captureBinary("ffmpeg", [
        "-v", "error", "-ss", when.toFixed(2), "-i", src, "-frames:v", "1",
        "-vf", `scale=${POSTER_PROBE_W}:${POSTER_PROBE_H}`, "-f", "rawvideo", "-pix_fmt", "gray", "-",
      ]);
      if (shot.length < POSTER_PROBE_W * POSTER_PROBE_H) continue;
      const score = posterScore(shot);
      if (score > best) {
        best = score;
        at = when;
      }
      if (best === 2) break; // both borders are wallpaper; nothing beats that
    }
  }

  const { ok } = await capture("ffmpeg", [
    "-y", "-ss", at.toFixed(2), "-i", src, "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "6", dest,
  ]);
  return ok ? dest : null;
}

async function scriptsIn(dir, project) {
  try {
    const files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
    return await Promise.all(
      files.map(async (f) => ({
        name: f.replace(/\.md$/, ""),
        project,
        body: await readFile(join(dir, f), "utf8"),
      })),
    );
  } catch {
    return [];
  }
}

async function loadScripts(projects) {
  const shared = await scriptsIn(SCRIPTS, null);
  const owned = await Promise.all(
    projects.map((p) => scriptsIn(join(projectDir(p.id), "scripts"), p.id)),
  );
  return [...shared, ...owned.flat()];
}

async function state() {
  const projects = await listProjects();
  // Index before answering. The catalog used to be whatever was written the last
  // time someone pressed Re-index, so a narration made an hour ago simply was not
  // in the library — the tool not noticing its own output. Unchanged files are
  // reused from the previous catalog, so this is a directory walk in the normal
  // case. A project that fails to index must not take the whole page down.
  await Promise.all(
    projects.map(async (p) => {
      // The whole catalog, not a summary: listProjects hands the Library the full
      // file list and the panel iterates it. Replacing it with counts here left
      // every project looking empty.
      const catalog = await reindex(p.id).catch(() => null);
      if (catalog) p.catalog = catalog;
    }),
  );
  const [wallpapers, scripts, tokens] = await Promise.all([
    readFile(join(TOOLKIT, "brand/wallpapers/index.json"), "utf8").then(JSON.parse).catch(() => []),
    loadScripts(projects),
    readFile(join(TOOLKIT, "brand/tokens.json"), "utf8").then(JSON.parse).catch(() => ({})),
  ]);

  const presets = [];
  for (const id of ["rolemodel", "academy", "lightning"]) {
    try {
      presets.push(await loadPreset(id));
    } catch {
      /* skip */
    }
  }

  const [os, rclone, hf, ff, voice, claude] = await Promise.all([
    capture("openscreen", ["--help"]),
    capture("rclone", ["version"]),
    capture("npx", ["--no-install", "hyperframes", "--version"]),
    capture("ffmpeg", ["-version"]),
    voiceReady(),
    // Make a video and the Scripts draft both shell out to it, and it was the
    // one tool the sidebar never mentioned — so a missing `claude` showed up as
    // a failed job rather than an unlit dot.
    capture("claude", ["--version"]),
  ]);

  let remotes = [];
  if (rclone.ok) {
    const r = await capture("rclone", ["listremotes"]);
    remotes = r.out.split("\n").map((x) => x.trim().replace(/:$/, "")).filter(Boolean);
  }

  return {
    libraryRoot: LIB,
    projects,
    wallpapers,
    scripts,
    presets,
    tokens,
    tools: { openscreen: os.ok, claude: claude.ok, ffmpeg: ff.ok, rclone: rclone.ok, hyperframes: hf.ok, voice },
    voiceVenv: venvDir(),
    remotes,
  };
}

const reloadClients = new Set();

/**
 * Render the page.
 *
 * This used to re-import the UI module with a cache-busting query under --watch,
 * because the whole document lived in a template literal inside it and ESM has
 * no way to evict a cached module. The document is lib/studio.html now and the
 * loader reads it on every call, so an edit is live on the next reload with no
 * module leaked per request.
 */
async function page() {
  return renderStudioHTML({ watch: WATCH });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = decodeURIComponent(url.pathname);

  try {
    if (p === "/") {
      // no-store, not max-age: the shell and lib/studio.js are two resources now
      // and a browser holding a stale copy of either renders a page whose markup
      // and code disagree — nav with an empty main, and no error to explain it.
      // The client code used to ride inside this response, where that could not
      // happen. It is a localhost tool; there is nothing to gain by caching it.
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      return res.end(await page());
    }

    // Live reload. Nothing is sent until something changes; the client also
    // reloads when this stream *reconnects*, which is what covers `node --watch`
    // restarting the whole process out from under it.
    if (p === "/api/reload") {
      if (!WATCH) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      reloadClients.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 15000);
      req.on("close", () => {
        clearInterval(ping);
        reloadClients.delete(res);
      });
      return;
    }

    if (p === "/api/state") return json(res, 200, await state());

    if (p === "/api/project" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      if (!body.name?.trim()) return json(res, 400, { error: "name is required" });
      const m = newManifest({
        name: body.name.trim(),
        client: body.client?.trim() || null,
        brand: body.brand || "rolemodel",
        remote: body.remote || "local",
        bucket: body.bucket || "",
        prefix: body.prefix || "",
        driver: body.remote && body.remote !== "local" ? "rclone" : "local",
      });
      await writeManifest(projectDir(m.id), m);
      await mkdir(join(mediaDir(m.id), "Footage"), { recursive: true });
      await mkdir(join(mediaDir(m.id), "Renders"), { recursive: true });
      await mkdir(join(projectDir(m.id), "scripts"), { recursive: true });
      await writeFile(
        join(projectDir(m.id), "README.md"),
        [
          `# ${m.name}${m.client ? ` — ${m.client}` : ""}`,
          "",
          "```",
          "library.json   the manifest (client, brand, storage)",
          "catalog.json   generated by indexing — do not hand-edit",
          "scripts/       narration and outlines for this project",
          "media/",
          "  Footage/     captures and source clips",
          "  Renders/     one folder per video, each with its brief.md",
          "```",
          "",
          "Created by RoleModel Studio. Everything here is plain files —",
          "nothing is hidden in a database.",
          "",
        ].join("\n"),
        "utf8",
      );
      return json(res, 200, { project: m });
    }

    if (p.startsWith("/api/index/") && req.method === "POST") {
      // The button forces a full re-probe. The automatic pass on every /api/state
      // already catches anything new, so the only reason to press it is a file
      // that changed without its mtime moving.
      return json(res, 200, { catalog: await reindex(p.slice("/api/index/".length), { force: true }) });
    }

    /**
     * Delete something from the library.
     *
     * Moves to `<library>/.trash/<stamp>-<name>` rather than unlinking. Three
     * reasons, in order of how much they matter: an unlink is unrecoverable and
     * this is a button in a web page; the alternative recoverable option is
     * Finder automation, which pops a TCC prompt in the middle of the one action
     * a user least wants interrupted; and a trash we own means we decide the
     * retention rather than inheriting whatever the desktop does. `.trash` is a
     * dot directory, which `buildCatalog` already skips, so trashed files leave
     * the Library on the next index without a special case.
     *
     * A project root is only deletable when the caller says `kind: "project"`.
     * Without that, asking to delete `media/Footage` and mistyping the path
     * takes the whole client's work with it.
     */
    if (p === "/api/delete" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const target = requestedPath(body);
      const inside = target === LIB || target.startsWith(LIB + sep);
      if (!inside) return json(res, 403, { error: `outside ${LIB}` });
      if (target === LIB) return json(res, 400, { error: "that is the library itself" });

      const st = await stat(target).catch(() => null);
      if (!st) return json(res, 404, { error: "no such file or folder" });

      // Is this a project root? Compare against the project directory rather than
      // counting path segments, which breaks the moment a library lives deeper.
      const projects = await readdir(LIB, { withFileTypes: true }).catch(() => []);
      const isProjectRoot = projects.some((e) => e.isDirectory() && join(LIB, e.name) === target);
      if (isProjectRoot && body.kind !== "project") {
        return json(res, 400, { error: "that is a whole project; pass kind:\"project\" to mean it" });
      }

      const trash = join(LIB, ".trash");
      await mkdir(trash, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const dest = join(trash, `${stamp}-${basename(target)}`);
      try {
        await rename(target, dest);
      } catch (err) {
        // A rename across devices fails with EXDEV. Nothing in a library should
        // straddle a mount, but say so plainly rather than reporting a mystery.
        return json(res, 500, { error: `could not move it to the trash: ${err.code ?? err.message}` });
      }

      if (body.projectId) await reindex(body.projectId, { force: true }).catch(() => {});
      return json(res, 200, {
        ok: true,
        moved: dest,
        was: target,
        kind: isProjectRoot ? "project" : st.isDirectory() ? "folder" : "file",
        note: `Moved to ${dest}. Nothing is gone — drag it back out of .trash if that was wrong.`,
      });
    }

    if (p === "/api/script" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const safe = (body.name || "untitled").replace(/[^a-z0-9 _-]/gi, "").trim() || "untitled";
      // A script either belongs to a project or to the shared shelf. Most do
      // belong to a project, and burying them all in one global folder is how
      // you end up unable to tell which client a script was written for.
      const dir = body.projectId ? join(projectDir(body.projectId), "scripts") : SCRIPTS;
      await mkdir(dir, { recursive: true });
      const file = join(dir, `${safe}.md`);
      await writeFile(file, body.body ?? "", "utf8");
      return json(res, 200, { ok: true, name: safe, file });
    }

    /**
     * Make: writes a brief INTO the project, then hands back the prompt.
     *
     * The first cut of this only computed a path and returned a string, so the
     * project folder — the thing everything else is supposed to hang off — got
     * nothing. Now the brief is a file: it survives the browser tab closing, it
     * diffs, and you can point Claude at the path instead of pasting.
     *
     * The render itself still isn't run here. It's long, chatty, and asks for
     * permissions; a browser spinner would hide the output you need when it fails.
     */
    if (p === "/api/make" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = body.projectId;
      if (!id) return json(res, 400, { error: "pick a project" });

      const m = await readManifest(projectDir(id)).catch(() => null);
      if (!m) return json(res, 404, { error: `no project "${id}"` });

      const brand = body.brand || m.brand || "rolemodel";
      const src = (body.source || "").trim();
      if (!src) return json(res, 400, { error: "give it a script or a URL" });

      const isUrl = /^https?:\/\//i.test(src);
      const slug =
        (body.title || (isUrl ? new URL(src).hostname.replace(/^www\./, "") : src.split("\n")[0]))
          .slice(0, 60).replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "untitled";

      const stamp = new Date().toISOString().slice(0, 10);
      const outDir = join(mediaDir(id), "Renders", `${stamp}-${slug}`);
      await mkdir(outDir, { recursive: true });

      // Direction, not decoration. Claude cannot see the Studio, so anything the
      // panel offers has to arrive as a sentence in the prompt — and the two that
      // change a render most are whether the content sits in browser chrome and
      // what is behind it.
      const wants = [];
      if (body.browser) {
        wants.push(
          body.browserUrl
            ? `Put the screen content inside browser chrome (the rm-browser component) showing the URL ${body.browserUrl}.`
            : "Put the screen content inside browser chrome (the rm-browser component).",
        );
      } else {
        wants.push("No browser chrome — the content fills the frame.");
      }
      if (body.wallpaper && body.wallpaper !== "none") {
        wants.push(`Use brand/wallpapers/${body.wallpaper} as the scene background.`);
      } else {
        wants.push("No wallpaper behind the scene — a flat background from the brand palette.");
      }
      if (body.captions) wants.push("Burn captions in, synced to the narration.");
      const direction = `\n\nDirection:\n${wants.map((w) => `- ${w}`).join("\n")}`;

      const prompt = isUrl
        ? `Using /hyperframes, make a ${body.seconds || 20}-second ${brand}-branded promo for ${src}.\nRender the MP4 into ${outDir}.${direction}`
        : `Using /hyperframes, build a ${brand}-branded video from the script below.\nRender the MP4 into ${outDir}.${direction}\n\n${src}`;

      const brief = [
        `# ${body.title || slug}`,
        "",
        `- project: ${m.name}${m.client ? ` (${m.client})` : ""}`,
        `- brand: ${brand}`,
        `- source: ${isUrl ? src : "script (below)"}`,
        `- seconds: ${body.seconds || 20}`,
        `- browser chrome: ${body.browser ? body.browserUrl || "yes" : "no"}`,
        `- background: ${body.wallpaper && body.wallpaper !== "none" ? body.wallpaper : "none"}`,
        `- captions: ${body.captions ? "yes" : "no"}`,
        `- created: ${new Date().toISOString()}`,
        "",
        "## Prompt",
        "",
        "```",
        prompt,
        "```",
        "",
        "## Source",
        "",
        isUrl ? src : src,
        "",
      ].join("\n");

      await writeFile(join(outDir, "brief.md"), brief, "utf8");
      return json(res, 200, {
        prompt,
        dir: outDir,
        brief: join(outDir, "brief.md"),
        isUrl,
        // Headless Claude, run from the render directory so relative paths in the
        // prompt land where the brief says they will.
        step: {
          label: `make ${slug}`,
          project: id,
          bin: "claude",
          // stream-json, not the default text output. `claude -p` in text mode
          // prints one blob when it finishes, so a long render showed an empty
          // Console for minutes and looked hung. stream-json emits an event per
          // step; --verbose is required alongside it. The Studio renders those
          // events rather than showing raw NDJSON.
          args: ["-p", prompt, "--permission-mode", "acceptEdits", "--output-format", "stream-json", "--verbose"],
          cwd: outDir,
        },
      });
    }

    /**
     * Record: hands back the exact openscreen command, pointed at this project.
     * Recording needs Screen Recording permission granted to whatever hosts
     * Electron, so it has to run in a real terminal — but the destination is
     * decided here so the capture lands in the project rather than in the app's
     * private recordings folder where nothing can find it.
     */
    /**
     * Hand a finished document to the app for editing.
     *
     * There is no supported way to do this, and that is worth stating plainly
     * rather than hiding behind a hopeful command. OpenScreen 's bundle declares
     * no CFBundleDocumentTypes and no CFBundleURLTypes, so `open <file>` has
     * nothing to route to; its CLI has no `open` verb (a bare document path
     * exits 0 and does nothing); and `open -a Openscreen <file>` launches the
     * app and discards the argument — it comes up on "No project open". Checked
     * all four.
     *
     * So this does the two things that do work: brings the app up, and reveals
     * the document in Finder so it can be dragged onto the window the app is
     * already showing. The honest fix is upstream — a document type declaration
     * is a few lines of plist — and until then the UI says what the last step is
     * rather than pretending it happened.
     */
    /**
     * Open a piece of media in OpenScreen.
     *
     * The editor opens documents, not videos, so a bare mp4 needs one wrapped
     * around it. If the pipeline already made one — `driven-a.openscreen` beside
     * `driven-a.mp4` — that is the document to use, because it carries the brand
     * preset and whatever editing has been done since. Only when there is no
     * sibling is a fresh one written, in the same legacy v2 shape `rm-video
     * brand` reads, and branded on the way through so the wallpaper and framing
     * are already right when it lands.
     */
    /**
     * Review: what OpenFrame knows about, and how to send it something.
     *
     * Sharing was a CLI-only capability, which meant the one step that puts a
     * video in front of the person whose opinion decides whether it ships was
     * the one step the Studio could not do. Configuration is reported rather
     * than assumed: an unset token and an unreachable instance are different
     * problems with different fixes, and "sharing does not work" is neither.
     */
    /**
     * The `.openscreen` documents in each project.
     *
     * Not in the catalog, and should not be: `buildCatalog` indexes media, and a
     * document is not media — it is the edit. But the Editor panel needs to know
     * which videos already have one, and inferring it client-side from the
     * catalog said "no document yet" for every video in the library, including
     * the ones sitting next to a document.
     */
    /**
     * Bring an existing video into a project.
     *
     * Recording and scripting both produce footage; there was no way to use
     * footage you already had. The library indexes whatever is on disk, so an
     * import is a copy into the right folder and a re-index — but doing that by
     * hand means knowing the folder, and "put it in media/Footage" is exactly the
     * kind of thing a tool should know instead of a person.
     *
     * Copied, not moved. The file usually belongs to something else — a Slack
     * download, a client's Dropbox — and moving somebody's original out from
     * under them is not a thing to do without asking.
     */
    if (p === "/api/import" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = body.projectId;
      const m = await readManifest(projectDir(id)).catch(() => null);
      if (!m) return json(res, 404, { error: "pick a project" });

      const src = resolve(String(body.file ?? ""));
      const st = await stat(src).catch(() => null);
      if (!st?.isFile()) return json(res, 404, { error: `no such file: ${src}` });

      // Where it goes is decided by what it is, so the catalog and every panel
      // that reads it stay right.
      const ext = extname(src).toLowerCase();
      const AUDIO = [".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg"];
      const VIDEO = [".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v"];
      const STILL = [".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff"];
      const folder = VIDEO.includes(ext) ? "Footage" : AUDIO.includes(ext) ? "Audio" : STILL.includes(ext) ? "Stills" : null;
      if (!folder) {
        return json(res, 400, {
          error: `${ext || "that"} is not media this pipeline handles — video, audio or a still image`,
        });
      }

      const dir = join(mediaDir(id), folder);
      await mkdir(dir, { recursive: true });

      // Never silently replace something already there: two takes with the same
      // name is normal, and losing the first one to an import is not.
      const stem = basename(src, ext).replace(/[^a-z0-9 _-]/gi, "").trim() || "import";
      let dest = join(dir, `${stem}${ext}`);
      let n = 2;
      while (await stat(dest).then(() => true).catch(() => false)) {
        dest = join(dir, `${stem}-${n}${ext}`);
        n++;
      }

      await copyFile(src, dest);
      await reindex(id, { force: true }).catch(() => {});
      return json(res, 200, {
        ok: true,
        into: folder,
        file: dest,
        renamed: basename(dest) !== `${stem}${ext}` ? basename(dest) : null,
        bytes: st.size,
      });
    }

    if (p === "/api/documents") {
      const out = [];
      for (const proj of await listProjects()) {
        const dir = mediaDir(proj.id);
        const found = [];
        const walk = async (rel) => {
          const entries = await readdir(join(dir, rel), { withFileTypes: true }).catch(() => []);
          for (const e of entries) {
            if (e.name.startsWith(".")) continue;
            const next = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) await walk(next);
            else if (e.name.endsWith(".openscreen")) found.push(next);
          }
        };
        await walk("");
        out.push({ id: proj.id, name: proj.name, documents: found.sort() });
      }
      return json(res, 200, { projects: out });
    }

    if (p === "/api/review") {
      // Environment first, then the stored file — a GUI launched from Finder has
      // no shell environment, so the environment alone made this unconfigurable
      // from inside the app.
      const { url: base, token, source } = await openFrameSettings();
      if (!base || !token) {
        return json(res, 200, {
          configured: false,
          missing: [!base && "url", !token && "token"].filter(Boolean),
          source,
        });
      }
      try {
        const api = openFrame({ base, token });
        const ws = await api.call("/api/workspaces");
        const list = Array.isArray(ws) ? ws : (ws?.workspaces ?? []);
        // Videos per project, so the panel can show what has already been sent
        // rather than only offering to send more.
        const projects = [];
        for (const w of list.slice(0, 3)) {
          const page = await api.call(`/api/projects?workspaceId=${encodeURIComponent(w.id)}`);
          for (const proj of page?.projects ?? []) {
            const videos = await api.call(`/api/projects/${proj.id}/videos`).catch(() => null);
            projects.push({
              id: proj.id,
              name: proj.name,
              workspace: w.name,
              /*
               * No link composed here.
               *
               * This used to carry `watch: `${api.base}/watch/${v.id}``, which is a
               * URL with no share token in it — OpenFrame answers 403 and the page
               * says "Video not found or access denied". Only ?shareToken= gets a
               * viewer in, and the token is not in this listing.
               *
               * Reading it per video would be a GET each, on a listing that already
               * costs one call per project, to fill in a button most sessions never
               * press. So the ids go out and /api/review/link resolves one on click.
               */
              videos: (videos?.videos ?? videos ?? []).map((v) => ({
                id: v.id,
                title: v.title,
                projectId: proj.id,
              })),
            });
          }
        }
        return json(res, 200, { configured: true, base: api.base, source, workspaces: list.length, projects });
      } catch (err) {
        return json(res, 200, { configured: true, base, error: err.message });
      }
    }

    /**
     * Store where OpenFrame is, from inside the app.
     *
     * Write-only, like the narration keys: a token goes in and never comes back
     * out, because a settings panel that shows you your own credential is a
     * settings panel that shows it to whoever is looking at your screen.
     */
    if (p === "/api/review/settings" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      try {
        const file = await setOpenFrameSettings({
          ...(body.url !== undefined ? { url: String(body.url) } : {}),
          ...(body.token !== undefined ? { token: String(body.token) } : {}),
        });
        return json(res, 200, { ok: true, stored: file });
      } catch (err) {
        // settingProblem() validates; a bad url is the user's to see, not a 500.
        return json(res, 400, { error: err.message });
      }
    }

    /**
     * The share link for one video, resolved when someone asks to open it.
     *
     * A GET against OpenFrame, never a POST: POST rotates the token on an existing
     * link, so a button that said "open this" would quietly break every link
     * already sent for that video. No link yet means no link — this does not make
     * one, because creating a share link is a thing the person should choose.
     */
    if (p === "/api/review/link") {
      const { url: base, token } = await openFrameSettings();
      if (!base || !token) return json(res, 400, { error: "OpenFrame is not configured — set it on the Review page" });
      const projectId = url.searchParams.get("project");
      const videoId = url.searchParams.get("video");
      if (!projectId || !videoId) return json(res, 400, { error: "need project and video" });
      try {
        const shareUrl = await openFrame({ base, token }).shareLink(projectId, videoId);
        return json(res, 200, { shareUrl });
      } catch (err) {
        return json(res, 200, { shareUrl: null, error: err.message });
      }
    }

    if (p === "/api/review/send" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const { url: base, token } = await openFrameSettings();
      if (!base || !token) return json(res, 400, { error: "OpenFrame is not configured — set it on the Review page" });

      const file = requestedPath(body);
      if (!(file === LIB || file.startsWith(LIB + sep))) return json(res, 403, { error: `outside ${LIB}` });
      const st = await stat(file).catch(() => null);
      if (!st?.isFile()) return json(res, 404, { error: "no such file" });

      try {
        const out = await shareVideo({
          base,
          token,
          file,
          project: String(body.project || "Untitled"),
          title: body.title ? String(body.title) : undefined,
        });
        return json(res, 200, out);
      } catch (err) {
        return json(res, 500, { error: err.message });
      }
    }

    if (p === "/api/open-media" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const media = requestedPath(body);
      if (!(media === LIB || media.startsWith(LIB + sep))) return json(res, 403, { error: `outside ${LIB}` });
      const st = await stat(media).catch(() => null);
      if (!st?.isFile()) return json(res, 404, { error: "no such file" });

      const sibling = join(dirname(media), `${basename(media, extname(media))}.openscreen`);
      const already = await stat(sibling).catch(() => null);
      let doc = sibling;
      let made = false;

      if (!already) {
        // The shape `rm-video brand` expects: a v2 document naming its screen
        // recording. Everything else the preset fills in.
        await writeFile(
          sibling,
          `${JSON.stringify({ version: 2, media: { screenVideoPath: media }, editor: {} }, null, 2)}\n`,
          "utf8",
        );
        made = true;
        const m = await readManifest(projectDir(body.projectId ?? "")).catch(() => null);
        const brand = await capture("rm-video", ["brand", sibling, "--preset", m?.brand || "rolemodel"]);
        if (!brand.ok) return json(res, 500, { error: `could not brand it: ${brand.err.slice(0, 200)}` });
        doc = sibling;
      }

      // When the Studio is a window in the app, the app opens the document —
      // it is the same call the `open` verb makes, minus the process boundary,
      // and it needs no PATH lookup, no probe for whether this build has the
      // verb, and no launch-and-reveal fallback for when it does not. In a
      // browser there is nobody to ask, so the CLI path stays.
      const opened = body.hosted ? { opened: false, via: "host" } : await openInOpenScreen(doc);
      if (body.projectId) await reindex(body.projectId, { force: true }).catch(() => {});
      return json(res, 200, { ...opened, document: doc, made });
    }

    if (p === "/api/open" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const file = resolve(String(body.file ?? ""));
      if (!(file === LIB || file.startsWith(LIB + sep))) return json(res, 403, { error: `outside ${LIB}` });
      const st = await stat(file).catch(() => null);
      if (!st?.isFile()) return json(res, 404, { error: "no such document" });

      if (body.hosted) return json(res, 200, { file, opened: false, via: "host" });
      return json(res, 200, { file, ...(await openInOpenScreen(file)) });
    }

    if (p === "/api/record" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = body.projectId;
      const m = await readManifest(projectDir(id)).catch(() => null);
      if (!m) return json(res, 404, { error: "pick a project" });

      const dest = join(mediaDir(id), "Footage");
      await mkdir(dest, { recursive: true });
      const slug = (body.title || "capture").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
      const proj = join(dest, `${slug}.openscreen`);

      // argv arrays, not command strings. The UI needs to *run* these, and a
      // string would have to be re-parsed by a shell to get back to this — which
      // is where quoting bugs and injection both live. The display string is
      // derived from the array, never the other way round.
      const steps = [
        {
          label: "record",
          bin: "openscreen",
          args: [
            "record",
            ...captureArgs(body.source),
            ...(body.seconds ? ["--duration", String(body.seconds)] : []),
            "--project", proj,
            "--json",
          ],
          note: "needs Screen Recording permission for whatever hosts Electron",
        },
        {
          label: "brand",
          bin: "rm-video",
          args: ["brand", proj, "--preset", m.brand || "rolemodel"],
        },
        {
          label: "export",
          bin: "openscreen",
          args: ["export", proj, "-o", join(dest, `${slug}.mp4`), "--auto-zoom", "--json"],
        },
      ];

      return json(res, 200, { dest, project: proj, steps, editable: proj });
    }

    /**
     * Recast: a Playwright trace is already a recording.
     *
     * The third way into the library, and the only one that regenerates itself.
     * A trace captures actions, screenshots, network waits and cursor positions,
     * so playwright-recast can cut a narrated demo from a test run you already
     * have — which means the demo stops rotting the moment the UI changes. It
     * runs via npx so it is not a hard dependency of this install.
     */
    /*
     * Browsing the filesystem, so nobody has to type a path.
     *
     * A trace lives wherever its repo lives, which is why this exists at all:
     * the panel used to want `/path/to/test-results` typed by hand, and the
     * person driving it is not necessarily someone who thinks in paths. The
     * browser's own file input is no use — it hands back a File, and
     * playwright-recast needs a path on disk.
     *
     * Deliberately narrow: listings only, rooted at the user's home, never file
     * contents, dotfiles hidden. That is a far milder capability than the job
     * runner next door, but it is still a filesystem read reached over HTTP, so
     * it gets an explicit root and a symlink-resistant containment check rather
     * than trust.
     */
    /*
     * Capture sources, so nobody has to remember a window's exact title.
     *
     * `openscreen sources` is the right answer and is tried first: its ids are
     * what `openscreen record --window` was built to take. It is not always
     * reachable — the cask installs an app bundle, not a PATH entry — so on macOS
     * this falls back to the visible application names, which needs no extra
     * permission (window *titles* would need Accessibility, and asking for that
     * to fill a dropdown is not a trade worth making).
     *
     * `from` says which of those happened, because a guessed name and an id
     * straight out of OpenScreen are not equally trustworthy and the panel
     * should not present them as if they were.
     */
    /*
     * The voices Kokoro actually has, asked rather than assumed.
     *
     * The list used to be hardcoded in two places and had drifted: it offered
     * two ids Kokoro has never shipped, and hid every non-English voice. Asking
     * `hyperframes tts --list --json` cannot drift, and the static list in
     * lib/narration.mjs is only the answer for a machine where voice is not set
     * up yet.
     */
    /*
     * The HyperFrames skills, which are what `/hyperframes` in the Make prompt
     * resolves to.
     *
     * Not vendored, deliberately. Two reasons: `hyperframes skills` already
     * installs and versions them upstream, so a copy here would rot the way the
     * flattened Optics export did; and it would not even work — Claude resolves
     * skills from the user directory or the cwd's project root, and the Make step
     * runs inside the library, not inside this repo. A copy sitting here is never
     * seen. So this reports what upstream says and offers its own installer.
     */
    /*
     * Why `openscreen` is not on PATH, specifically.
     *
     * "openscreen: not found on PATH" is true and useless: the interesting cases
     * all look identical from a failed spawn. The cask that puts the CLI there is
     * ours (rolemodel/tap), and `openscreen` is a name a different project also
     * claims on Homebrew — so the usual answer is not "install it" but "you have
     * a different program of the same name".
     */
    if (p === "/api/openscreen") {
      const onPath = await capture("sh", ["-c", "command -v openscreen"]);
      const where = onPath.ok ? onPath.out.trim() : null;
      const bundles = ["/Applications/Openscreen.app", join(homedir(), "Applications/Openscreen.app")];
      let app = null;
      for (const b of bundles) {
        if (await stat(b).then(() => true).catch(() => false)) { app = b; break; }
      }
      let version = null;
      if (app) {
        const v = await capture("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", join(app, "Contents/Info.plist")]);
        if (v.ok) version = v.out.trim();
      }
      const caskInfo = await capture("sh", ["-c", "brew info --cask openscreen 2>/dev/null | head -4"]);
      const fromRoleModel = /getopenscreen/i.test(caskInfo.out);

      let why = null;
      if (where) why = null;
      else if (!app) why = "OpenScreen is not installed. `brew install rolemodel/tap/rm-video` pulls it in, or install the cask on its own.";
      else if (!fromRoleModel)
        why =
          `An app is installed at ${app}${version ? ` (v${version})` : ""}, but it is not the getopenscreen build this toolkit drives — ` +
          "`openscreen` is a name another project claims on Homebrew, and that cask ships no CLI. " +
          "Install ours: brew install --cask rolemodel/tap/openscreen";
      else why = `${app}${version ? ` (v${version})` : ""} is installed but nothing links it onto PATH. Reinstall the cask: brew reinstall --cask rolemodel/tap/openscreen`;

      return json(res, 200, { ok: Boolean(where), path: where, app, version, why });
    }

    if (p === "/api/skills") {
      const r = await capture("npx", ["--no-install", "hyperframes", "skills", "check"]);
      // Strip the ANSI the CLI paints its counts with.
      const text = `${r.out}${r.err}`.replace(/\x1b\[[0-9;]*m/g, "");
      if (!r.ok && !text.includes("skills")) {
        return json(res, 200, { ok: false, why: "hyperframes is not reachable — it is fetched with npx on first use" });
      }
      const num = (label) => {
        const m = text.match(new RegExp(`(\\d+)\\s+${label}`));
        return m ? Number(m[1]) : 0;
      };
      const loc = text.match(/Location\s+(\S+)\s+\(([^)]+)\)/);
      const outdated = num("outdated");
      const missing = num("core not installed");
      return json(res, 200, {
        ok: true,
        location: loc?.[1] ?? null,
        tool: loc?.[2] ?? null,
        current: num("current"),
        outdated,
        missing,
        installed: /↑\s*hyperframes\b/.test(text) || /✓\s*hyperframes\b/.test(text) || num("current") > 0,
        ready: outdated === 0 && missing === 0,
        step: {
          label: "install hyperframes skills",
          bin: "npx",
          args: ["--yes", "hyperframes", "skills", "update"],
          cwd: TOOLKIT,
          note: "installs into ~/.claude/skills, where Claude looks for them no matter which folder a render runs in",
        },
      });
    }

    if (p === "/api/voices") {
      const which = url.searchParams.get("provider") || "kokoro";
      if (which === "elevenlabs") {
        const { apiKeyFor, elevenLabsVoices } = await import("../lib/narration.mjs");
        const apiKey = await apiKeyFor("elevenlabs");
        if (!apiKey) {
          return json(res, 200, {
            from: "none",
            needsKey: true,
            voices: [],
            note: "No ElevenLabs API key yet. Save one below, or set ELEVENLABS_API_KEY before starting the Studio.",
          });
        }
        try {
          const voices = await elevenLabsVoices(apiKey);
          return json(res, 200, { from: "elevenlabs", voices });
        } catch (e) {
          return json(res, 200, { from: "none", voices: [], note: String(e.message ?? e) });
        }
      }

      const r = await capture("npx", ["--no-install", "hyperframes", "tts", "--list", "--json"]);
      if (r.ok) {
        try {
          const raw = JSON.parse(r.out.slice(r.out.indexOf("[")));
          const voices = raw
            .filter((v) => v?.id)
            .map((v) => ({
              id: String(v.id),
              label: [v.label || v.id, v.gender, v.language].filter(Boolean).join(" · "),
            }));
          if (voices.length) return json(res, 200, { from: "kokoro", voices });
        } catch {
          /* fall through to the static list */
        }
      }
      /*
       * The list Kokoro would have given us, from lib/narration.mjs.
       *
       * The note used to say "set voice up under Voice", which is the page this
       * text is displayed on — advice to go where you already are. There are two
       * distinct reasons the list is unavailable and they need different actions,
       * so say which one happened:
       *
       *   - the Python environment is missing, and the button above this field
       *     builds it;
       *   - the environment is fine but `npx --no-install hyperframes` found
       *     nothing cached, which is a network fetch on first use and nothing to
       *     fix by hand.
       *
       * Either way the ids below are real and synthesising works, so this is a
       * caveat and not an error.
       */
      const { VOICES } = await import("../lib/narration.mjs");
      const ready = await voiceReady();
      return json(res, 200, {
        from: "static",
        voices: VOICES.map((v) => ({ id: v.id, label: v.label })),
        note: ready
          ? "Kokoro is installed but would not list its voices — hyperframes is fetched with npx on first use and is not cached yet. These ids are the built-in list and they work; the first line you synthesise will do the fetch."
          : "This is the built-in list, because Kokoro is not installed yet. Use “Set up voice” above — it builds a private Python environment, once, and then the list comes from Kokoro itself.",
      });
    }

    /*
     * Provider credentials. Write-only on purpose: a POST stores a key, a GET
     * says only whether one exists. Nothing here ever returns a key to the
     * browser, and it is never put in an argv — the synthesiser reads it from
     * the config file itself, so it cannot show up in the Console transcript.
     */
    if (p === "/api/keys") {
      const { PROVIDERS, hasApiKey, setApiKey } = await import("../lib/narration.mjs");
      if (req.method === "POST") {
        const body = JSON.parse(await text(req));
        const which = body.provider;
        if (!PROVIDERS[which] || PROVIDERS[which].local) return json(res, 400, { error: "that provider takes no key" });
        const value = String(body.key ?? "").trim();
        try {
          const file = await setApiKey(which, value);
          return json(res, 200, { ok: true, stored: file });
        } catch (e) {
          // setApiKey validates the shape; a wrong-looking key is the user's
          // mistake to see, not a 500.
          return json(res, 400, { error: String(e.message ?? e) });
        }
      }
      const status = {};
      for (const [id, cfg] of Object.entries(PROVIDERS)) {
        if (!cfg.local) status[id] = await hasApiKey(id);
      }
      return json(res, 200, { status });
    }

    if (p === "/api/sources") {
      const parse = (text) => {
        // Documented as NDJSON, but a single JSON array is the friendlier shape
        // and costs nothing to accept. Take whichever this build emits.
        try {
          const v = JSON.parse(text);
          return Array.isArray(v) ? v : (v.sources ?? v.windows ?? []);
        } catch {
          return text
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean)
            .flatMap((l) => {
              try {
                return [JSON.parse(l)];
              } catch {
                return [];
              }
            });
        }
      };

      const os = await capture("openscreen", ["sources", "--json"]);
      if (os.ok) {
        // The CLI streams NDJSON events and finishes with
        // {event:"done", sources:{displays:[…], windows:[…]}}. Screens first —
        // "the whole screen" is the common capture and should not be buried
        // under forty windows.
        const done = parse(os.out).find((e) => e?.sources) ?? {};
        const displays = done.sources?.displays ?? [];
        const wins = done.sources?.windows ?? [];

        // Each option carries the value `record` actually consumes, which is not
        // the id `sources` reports. `openscreen record --help` is explicit:
        //
        //   --display <n>       Screen index to record (default 0)
        //   --window <title>    Record the first window whose title contains <title>
        //
        // We were sending the id for both — `--window window:6952:0` — and
        // record answered "No window title contains window:6952:0" and listed
        // every open window, one of which was the one that had been picked. The
        // list was right, the value was from the wrong field.
        //
        // A window with no title cannot be named to `--window` at all, so it is
        // dropped rather than offered as something that will fail.
        const windows = [
          ...displays.map((d, i) => ({
            kind: "display",
            value: String(d.index ?? i),
            label: `${d.name ?? "Screen"} (whole screen)`,
          })),
          ...wins
            .filter((w) => String(w.name ?? "").trim())
            .map((w) => ({ kind: "window", value: String(w.name), label: String(w.name) })),
        ];
        const untitled = wins.length - windows.filter((w) => w.kind === "window").length;
        if (windows.length) return json(res, 200, { from: "openscreen", windows, untitled });
      }

      if (process.platform === "darwin") {
        const script = 'tell application "System Events" to get name of every application process whose visible is true';
        const sys = await capture("osascript", ["-e", script]);
        if (sys.ok) {
          const skip = new Set(["app_mode_loader", "Finder", "osascript"]);
          const names = [...new Set(sys.out.split(",").map((n) => n.trim()).filter((n) => n && !skip.has(n)))].sort((a, b) =>
            a.localeCompare(b),
          );
          return json(res, 200, {
            from: "system",
            windows: names.map((n) => ({ kind: "window", value: n, label: n })),
            note: "Application names from the system, not from OpenScreen — it matches on the window title, so a name may need adjusting. Type one instead if a pick does not take.",
          });
        }
      }

      return json(res, 200, {
        from: "none",
        windows: [],
        note: "Could not list anything. Leave Window empty to capture the whole screen.",
      });
    }

    if (p === "/api/browse") {
      const root = homedir();
      const asked = url.searchParams.get("path");
      const abs = asked ? resolve(asked) : root;
      const inside = abs === root || abs.startsWith(root + sep);
      if (!inside) return json(res, 403, { error: `outside ${root}`, path: root });

      const st = await stat(abs).catch(() => null);
      if (!st) return json(res, 404, { error: "no such directory", path: root });
      const dir = st.isDirectory() ? abs : dirname(abs);

      const ents = await readdir(dir, { withFileTypes: true }).catch(() => null);
      if (!ents) return json(res, 403, { error: "cannot read that directory", path: root });

      const dirs = [];
      const files = [];
      for (const e of ents) {
        if (e.name.startsWith(".")) continue; // dotfiles are noise here, not a secret
        if (e.isDirectory()) dirs.push({ name: e.name, path: join(dir, e.name) });
        else if (e.isFile()) {
          const ext = extname(e.name).toLowerCase();
          files.push({
            name: e.name,
            path: join(dir, e.name),
            ext,
            // What the trace picker is actually looking for.
            trace: ext === ".zip",
            video: ext === ".webm" || ext === ".mp4",
            subs: ext === ".srt" || ext === ".vtt",
          });
        }
      }
      const cmp = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
      dirs.sort(cmp);
      files.sort(cmp);
      return json(res, 200, {
        path: dir,
        name: basename(dir) || dir,
        parent: dir === root ? null : dirname(dir),
        home: root,
        dirs,
        files,
      });
    }

    /*
     * What recast will actually see, answered before anything runs.
     *
     * This is the same reasoning /api/recast applies when it builds its steps —
     * asked early so the panel can say it in advance instead of the user finding
     * out from a slideshow. Trap: recast only gets smooth video when a file with
     * the trace's basename sits beside it; otherwise it assembles from sparse
     * screencast frames.
     */
    if (p === "/api/trace/probe") {
      const root = homedir();
      const asked = (url.searchParams.get("path") || "").trim();
      if (!asked) return json(res, 200, { ok: false, why: "nothing chosen yet" });
      const abs = resolve(asked);
      if (abs !== root && !abs.startsWith(root + sep)) return json(res, 403, { error: `outside ${root}` });

      const st = await stat(abs).catch(() => null);
      if (!st) return json(res, 200, { ok: false, why: "that path does not exist" });

      const zips = [];
      if (st.isDirectory()) {
        const walk = async (d, depth) => {
          if (depth > 2 || zips.length >= 25) return;
          for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
            if (e.name.startsWith(".")) continue;
            const full = join(d, e.name);
            if (e.isDirectory()) await walk(full, depth + 1);
            else if (extname(e.name).toLowerCase() === ".zip") zips.push(full);
          }
        };
        await walk(abs, 0);
      } else if (extname(abs).toLowerCase() === ".zip") {
        zips.push(abs);
      } else {
        return json(res, 200, { ok: false, why: `${basename(abs)} is not a trace — pick a trace.zip or the folder holding one` });
      }

      if (!zips.length) {
        return json(res, 200, { ok: false, why: "no trace.zip anywhere under that folder" });
      }

      // Smoothness is per-zip: a sibling video with the same basename.
      const checked = [];
      for (const z of zips.slice(0, 25)) {
        let video = null;
        for (const ext of [".webm", ".mp4"]) {
          const cand = z.replace(/\.zip$/i, ext);
          if (await stat(cand).then(() => true).catch(() => false)) { video = cand; break; }
        }
        checked.push({ zip: z, video });
      }
      const withVideo = checked.filter((c) => c.video).length;
      return json(res, 200, {
        ok: true,
        kind: st.isDirectory() ? "dir" : "zip",
        traces: checked.length,
        withVideo,
        sample: checked.slice(0, 6),
        smooth: withVideo === checked.length,
      });
    }

    /**
     * Parse a demo script and say what it will do, without running it.
     *
     * The Studio's rule is that a button says what it will do with the real
     * values before it is pressed, and a demo script is a lot of hidden
     * behaviour behind one click — it drives a browser at a live URL. So the
     * panel shows the step count, the URLs it visits and any problems while it
     * is still being typed.
     */
    if (p === "/api/demo/check" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const parsed = parseDemo(String(body.body ?? ""));
      return json(res, 200, { ...describeDemo(parsed), problems: parsed.problems });
    }

    /**
     * Save a demo script and hand back the step that runs it.
     *
     * Deliberately does NOT run anything: it returns argv the way /api/record
     * does, so the same run rows, the same Console streaming and the same
     * exit-code handling apply. A browser opening on your screen is not
     * something to trigger from a fetch nobody watched.
     *
     * The trace lands in the project's Renders folder beside where recast will
     * put the video, and the script is saved into the project's scripts/ folder
     * so it diffs with everything else.
     */
    if (p === "/api/demo" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = body.projectId;
      const m = await readManifest(projectDir(id)).catch(() => null);
      if (!m) return json(res, 404, { error: "pick a project" });

      const safe = (body.name || "demo").replace(/[^a-z0-9 _-]/gi, "").trim() || "demo";
      const slug = safe.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
      const parsed = parseDemo(String(body.body ?? ""));
      if (parsed.problems.length) return json(res, 400, { error: parsed.problems.join("; "), problems: parsed.problems });
      if (!parsed.steps.some((x) => x.kind === "do")) {
        return json(res, 400, { error: "nothing to do — the script needs a ```do block" });
      }

      const scriptsDir = join(projectDir(id), "scripts");
      await mkdir(scriptsDir, { recursive: true });
      const script = join(scriptsDir, `${slug}.demo.md`);
      await writeFile(script, String(body.body ?? ""), "utf8");

      const stamp = new Date().toISOString().slice(0, 10);
      const dir = join(mediaDir(id), "Renders", `${stamp}-${slug}`);
      await mkdir(dir, { recursive: true });

      const args = ["run", script, "--out", dir];
      if (body.url) args.push("--url", String(body.url));
      if (body.width) args.push("--width", String(body.width));
      if (body.height) args.push("--height", String(body.height));

      return json(res, 200, {
        script,
        dir,
        // Where the trace will be, so the Trace field can be filled in without
        // the user going to find it.
        trace: join(dir, `${slug}.zip`),
        plan: describeDemo(parsed),
        steps: [
          {
            label: "demo",
            bin: "rm-demo",
            args,
            note: "opens a real browser window and drives it — do not type while it runs",
          },
        ],
      });
    }

    if (p === "/api/recast" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = body.projectId;
      const m = await readManifest(projectDir(id)).catch(() => null);
      if (!m) return json(res, 404, { error: "pick a project" });
      const trace = (body.trace || "").trim();
      if (!trace) return json(res, 400, { error: "point it at a trace directory or trace.zip" });

      const slug = (body.title || "trace-demo").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
      const stamp = new Date().toISOString().slice(0, 10);
      const outDir = join(mediaDir(id), "Renders", `${stamp}-${slug}`);
      await mkdir(outDir, { recursive: true });
      // The container follows the format flag. Writing an mp4 extension onto a
      // webm stream produces a file that most things refuse and ffprobe reports
      // as mp4, which is a bad hour.
      const format = body.format === "webm" ? "webm" : "mp4";
      const out = join(outDir, `${slug}.${format}`);

      // Prefer the version we pinned. npx is the fallback for a checkout that
      // has not run `npm install` yet, but a pinned local binary is the point of
      // depending on it rather than resolving whatever npm serves today.
      const local = join(TOOLKIT, "node_modules", ".bin", "playwright-recast");
      const haveLocal = await stat(local).then(() => true).catch(() => false);

      /*
       * Every flag playwright-recast takes, and a few refusals.
       *
       * The panel used to expose five of its twenty-odd options, which meant the
       * interesting half — what the cursor looks like, how the interpolation is
       * done, which TTS model speaks, whether idle compression happens at all —
       * was reachable only by typing the command out by hand. That is the same
       * failure the run rows exist to avoid.
       *
       * A number that arrives as a string, or as nonsense, is normalised here
       * rather than passed on: recast's own error for `--speed-idle abc` is an
       * ffmpeg filter graph complaint several hundred lines down its output.
       */
      const num = (v, fallback, lo, hi) => {
        const n = Number(v);
        if (!Number.isFinite(n)) return fallback;
        return Math.min(hi, Math.max(lo, n));
      };
      const pathArg = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

      const args = ["-i", trace, "-o", out, "--format", format];

      // Speed. `--no-speed` turns the whole stage off, so sending the three
      // multipliers alongside it would be describing a stage that is not running.
      if (body.noSpeed) {
        args.push("--no-speed");
      } else {
        args.push("--speed-idle", String(num(body.speedIdle, 3, 0.25, 20)));
        args.push("--speed-action", String(num(body.speedAction, 1, 0.25, 20)));
        args.push("--speed-network", String(num(body.speedNetwork, 2, 0.25, 20)));
      }

      args.push("--resolution", body.resolution === "720p" ? "720p" : "1080p");

      // Cursor and clicks. The config files are recast's own JSON shapes; a path
      // is offered rather than a form because the shape is theirs and will change
      // with their releases, and a stale form is worse than a file picker.
      if (body.cursor !== false) {
        args.push("--cursor-overlay");
        const cfg = pathArg(body.cursorConfig);
        if (cfg) args.push("--cursor-overlay-config", cfg);
      }
      if (body.click !== false) {
        args.push("--click-effect");
        const cfg = pathArg(body.clickConfig);
        if (cfg) args.push("--click-effect-config", cfg);
        const sound = pathArg(body.clickSound);
        if (sound) args.push("--click-sound", sound);
      }

      // Interpolation, and its four dependent settings. Sending any of them
      // without --interpolate is a silent no-op, which reads as the setting not
      // working rather than as the stage being off.
      if (body.interpolate) {
        args.push("--interpolate");
        args.push("--interpolate-fps", String(num(body.interpolateFps, 60, 24, 240)));
        const mode = ["dup", "blend", "mci"].includes(body.interpolateMode) ? body.interpolateMode : "mci";
        args.push("--interpolate-mode", mode);
        const quality = ["fast", "balanced", "quality"].includes(body.interpolateQuality) ? body.interpolateQuality : "balanced";
        args.push("--interpolate-quality", quality);
        args.push("--interpolate-passes", String(num(body.interpolatePasses, 1, 1, 4)));
      }

      // Text sanitisation for TTS. recast's own, and only meaningful when
      // something is being spoken.
      if (body.textProcessing) {
        args.push("--text-processing");
        const cfg = pathArg(body.textProcessingConfig);
        if (cfg) args.push("--text-processing-config", cfg);
      }

      // Narration for this name, if rm-voice has already produced some.
      const audioDir = join(mediaDir(id), "Audio");
      const wav = join(audioDir, `${slug}.wav`);
      const srtGuess = body.srt || join(audioDir, `${slug}.srt`);
      const haveWav = await stat(wav).then(() => true).catch(() => false);
      const haveSrt = await stat(srtGuess).then(() => true).catch(() => false);

      // Deliberately do NOT burn subtitles here when we are going to mux.
      //
      // recast compresses idle time, so its output runs on a different clock
      // from the narration — burning a 22-second subtitle track into a 3.8-second
      // render shows cue 1 for the whole clip and drops the rest. It looks like
      // it worked. rm-mux reconciles the two clocks and burns the subtitles onto
      // the final timeline instead.
      // Only for mp4: rm-mux writes an mp4 and its whole job is reconciling the
      // render's clock with the narration's. A webm render skips the mux and gets
      // the subtitles burned by recast instead, which is the lesser of the two —
      // the clocks are still unreconciled — so the response says so.
      const willMux = haveWav && haveSrt && format === "mp4";
      if (!willMux && haveSrt) args.push("--srt", srtGuess, "--burn-subs");
      if (body.provider && body.provider !== "none") {
        // Qwen is configured entirely by file and recast exits without one, so
        // refuse here where the message can say what to do about it.
        if (body.provider === "qwen" && !pathArg(body.qwenConfig)) {
          return json(res, 400, { error: "the Qwen provider needs a --qwen-config JSON file; point the Qwen config field at one" });
        }
        args.push("--provider", body.provider);
        if (body.voice) args.push("--voice", body.voice);
        if (pathArg(body.model)) args.push("--model", body.model.trim());
        if (body.ttsSpeed !== undefined && body.ttsSpeed !== null && body.ttsSpeed !== "") {
          args.push("--tts-speed", String(num(body.ttsSpeed, 1, 0.25, 4)));
        }
        if (body.provider === "qwen") args.push("--qwen-config", pathArg(body.qwenConfig));
      }

      // recast assembles from the trace's screencast frames unless a video file
      // sits beside the trace with the same basename. Frames are sparse — a
      // three-second interaction came out as 15 of them in testing, which reads
      // as a slideshow. Say so rather than silently shipping the choppy version.
      const sibling = trace.replace(/\.zip$/i, ".webm");
      const smooth = /\.zip$/i.test(trace)
        ? await stat(sibling).then(() => true).catch(() => false)
        : true;

      const steps = [{
        label: `recast ${slug}`,
        project: id,
        bin: haveLocal ? local : "npx",
        args: haveLocal ? args : ["--yes", "playwright-recast", ...args],
        cwd: outDir,
        note: smooth
          ? "needs ffmpeg and ffprobe on PATH"
          : "no video beside the trace — recast will assemble from sparse screencast frames, which reads as a slideshow. Record with recordVideo and save the .webm next to the .zip under the same name.",
      }];

      if (willMux) {
        steps.push({
          label: `narrate ${slug}`,
          project: id,
          bin: "node",
          args: [
            join(TOOLKIT, "bin", "rm-mux.mjs"),
            "--video", out,
            "--audio", wav,
            "--srt", srtGuess,
            "-o", join(outDir, `${slug}-narrated.mp4`),
          ],
          cwd: outDir,
          note: "reconciles the render's clock with the narration's, then burns the subtitles",
        });
      }

      return json(res, 200, {
        dir: outDir,
        out,
        format,
        narrated: willMux ? join(outDir, `${slug}-narrated.mp4`) : null,
        srt: haveSrt ? srtGuess : null,
        wav: haveWav ? wav : null,
        // The one combination that quietly does less than you asked for.
        muxSkipped: haveWav && haveSrt && format !== "mp4" ? format : null,
        smooth,
        steps,
      });
    }

    /**
     * Voice. One clip per line, cached on (voice, text), then an SRT written
     * from measured durations rather than transcribed back out of our own
     * audio. See lib/narration.mjs for why that round trip is a bad idea.
     */
    if (p === "/api/voice" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = body.projectId;
      const m = await readManifest(projectDir(id)).catch(() => null);
      if (!m) return json(res, 404, { error: "pick a project" });
      if (!body.script) return json(res, 400, { error: "pick a script" });

      // `rm-voice` exists on PATH only after a Homebrew install. In a checkout it
      // does not, so resolve the script ourselves rather than handing the user a
      // command that works on one machine and not the other.
      const onPath = await capture("sh", ["-c", "command -v rm-voice"]);
      const script = join(TOOLKIT, "bin", "rm-voice.mjs");
      const provider = body.provider || "kokoro";
      const rest = [
        id,
        "--script", body.script,
        "--provider", provider,
        "--voice", body.voice || (provider === "kokoro" ? "af_heart" : ""),
        "--gap", String(body.gap || 320),
      ];

      return json(res, 200, {
        out: join(mediaDir(id), "Audio", `${body.script}.wav`),
        srt: join(mediaDir(id), "Audio", `${body.script}.srt`),
        step: {
          label: `voice ${body.script}`,
          project: id,
          bin: onPath.ok ? "rm-voice" : "node",
          args: onPath.ok ? rest : [script, ...rest],
          cwd: projectDir(id),
          note: "first run downloads ~27MB of Kokoro voice data; after that it is local and offline",
        },
      });
    }

    /**
     * Build the voice environment. Same code path as `rm-voice --setup`, run as a
     * job so the pip output streams into Console rather than disappearing.
     */
    if (p === "/api/voice/setup" && req.method === "POST") {
      const onPath = await capture("sh", ["-c", "command -v rm-voice"]);
      const script = join(TOOLKIT, "bin", "rm-voice.mjs");
      const rest = ["--setup"];
      return json(res, 200, {
        venv: venvDir(),
        step: {
          label: "set up voice",
          bin: onPath.ok ? "rm-voice" : "node",
          args: onPath.ok ? rest : [script, ...rest],
          cwd: TOOLKIT,
          note: "creates a private Python virtualenv — nothing is installed into your system Python",
        },
      });
    }

    /** Draft a script with Claude, straight into the project's scripts/ folder. */
    if (p === "/api/script/draft" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = body.projectId;
      const m = await readManifest(projectDir(id)).catch(() => null);
      if (!m) return json(res, 404, { error: "pick a project" });
      const about = (body.about || "").trim();
      if (!about) return json(res, 400, { error: "what is it about? a URL or a couple of sentences" });

      const nm = wpSlug(body.name || "draft");
      const dir = join(projectDir(id), "scripts");
      await mkdir(dir, { recursive: true });
      const dest = join(dir, `${nm}.md`);

      const prompt = [
        `Write a ${body.seconds || 30}-second narration script for a ${m.brand || "rolemodel"}-branded video.`,
        m.client ? `Client: ${m.client}. Project: ${m.name}.` : `Project: ${m.name}.`,
        "",
        `Subject: ${about}`,
        "",
        "Rules:",
        "- Write it to be SPOKEN, not read. Short sentences. No bullet-point voice.",
        "- One idea per line, one sentence per line — each line becomes a subtitle cue.",
        "- No headings beyond a single H1, no bullets, no code blocks: everything else is spoken aloud.",
        `- About ${Math.round((body.seconds || 30) * 2.4)} words total. Narration runs ~2.4 words a second.`,
        "- Say what the product does for the person watching. No hype, no superlatives.",
        "",
        `Write it to ${dest} and print nothing else.`,
      ].join("\n");

      return json(res, 200, {
        dest,
        prompt,
        step: {
          label: `draft ${nm}`,
          project: id,
          bin: "claude",
          // stream-json, not the default text output. `claude -p` in text mode
          // prints one blob when it finishes, so a long render showed an empty
          // Console for minutes and looked hung. stream-json emits an event per
          // step; --verbose is required alongside it. The Studio renders those
          // events rather than showing raw NDJSON.
          args: ["-p", prompt, "--permission-mode", "acceptEdits", "--output-format", "stream-json", "--verbose"],
          cwd: dir,
        },
      });
    }

    if (p === "/api/storage" && req.method === "POST") {
      const b = JSON.parse(await text(req));
      const args = [
        "config", "create", b.name, "s3",
        "provider", "Cloudflare",
        "access_key_id", b.accessKeyId,
        "secret_access_key", b.secretAccessKey,
        "endpoint", b.endpoint,
        "acl", "private",
      ];
      const r = await capture("rclone", args);
      return json(res, r.ok ? 200 : 500, { ok: r.ok, out: r.out, err: r.err });
    }

    /* ── jobs ──────────────────────────────────────────────────────────────
       Running the pipeline instead of describing it. See lib/jobs.mjs for the
       two rules that keep this from being a footgun: allowlisted binaries, and
       free-text only behind --shell. */

    if (p === "/api/jobs") return json(res, 200, { jobs: jobs.list(), shell: SHELL });

    if (p === "/api/run" && req.method === "POST") {
      const b = JSON.parse(await text(req));
      try {
        if (b.shell) {
          if (!SHELL) {
            return json(res, 403, {
              error: "free-text commands are off. Restart with `rm-studio --shell` to enable them.",
            });
          }
          const j = jobs.run({ bin: String(b.shell), shell: true, label: String(b.shell), cwd: b.cwd || LIB });
          return json(res, 200, { job: jobs.summary(j) });
        }
        // `project` is advisory and validated below — it only ever selects which
        // project gets re-read, never what runs.
        const project = typeof b.project === "string" ? b.project : null;
        const j = jobs.run({
          bin: String(b.bin),
          args: Array.isArray(b.args) ? b.args.map(String) : [],
          label: b.label,
          cwd: b.cwd,
          onDone: project
            ? async () => {
                if (await readManifest(projectDir(project)).catch(() => null)) await reindex(project);
              }
            : undefined,
        });
        return json(res, 200, { job: jobs.summary(j) });
      } catch (e) {
        return json(res, 400, { error: String(e.message ?? e) });
      }
    }

    /*
     * What a job produced.
     *
     * "It said done and I cannot find anything" was the complaint this answers:
     * a job knows the directory it ran in, so list what is there and let the
     * Console point at it. Newest first, because the thing just written is the
     * thing being looked for.
     */
    if (p.startsWith("/api/jobs/") && p.endsWith("/artifacts")) {
      const j = jobs.get(p.split("/")[3]);
      if (!j) return json(res, 404, { error: "no such job" });
      const walk = async (dir, depth = 0) => {
        if (depth > 2) return [];
        const out = [];
        for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
          if (e.name.startsWith(".")) continue;
          const full = join(dir, e.name);
          if (e.isDirectory()) out.push(...(await walk(full, depth + 1)));
          else {
            const st = await stat(full).catch(() => null);
            if (st) out.push({ path: full, name: e.name, bytes: st.size, at: st.mtime.toISOString() });
          }
        }
        return out;
      };
      const files = (await walk(j.cwd)).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 40);
      return json(res, 200, { dir: j.cwd, files });
    }

    if (p.startsWith("/api/jobs/") && p.endsWith("/stop") && req.method === "POST") {
      const id = p.split("/")[3];
      return json(res, 200, { stopped: jobs.stop(id) });
    }

    // Server-sent events: the log arrives as it happens. Polling a growing log
    // over JSON means either a lagging UI or a request every 200ms, and neither
    // is acceptable for something you sit and watch.
    if (p.startsWith("/api/jobs/") && p.endsWith("/events")) {
      const id = p.split("/")[3];
      const job = jobs.get(id);
      if (!job) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.write(`event: meta\ndata: ${JSON.stringify(jobs.summary(job))}\n\n`);
      const off = jobs.subscribe(id, (ev) => {
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
      });
      // Proxies and laptops sleeping mid-render both like to drop idle sockets.
      const ping = setInterval(() => res.write(": ping\n\n"), 15000);
      req.on("close", () => {
        clearInterval(ping);
        off?.();
      });
      return;
    }

    if (p.startsWith("/thumb/")) {
      const [, , id, ...rest] = p.split("/");
      const file = await thumbnail(id, rest.join("/"));
      if (!file) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "no-cache" });
      return createReadStream(file).pipe(res);
    }

    if (p.startsWith("/media/")) {
      const [, , id, ...rest] = p.split("/");
      const file = join(mediaDir(id), rest.join("/"));
      const s = await stat(file).catch(() => null);
      if (!s) {
        res.writeHead(404);
        return res.end();
      }
      const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
      // Range support, or <video> seeking is broken.
      const range = req.headers.range;
      if (range) {
        const [a, b] = range.replace("bytes=", "").split("-");
        const start = Number(a);
        const end = b ? Number(b) : s.size - 1;
        res.writeHead(206, {
          "content-type": type,
          "content-range": `bytes ${start}-${end}/${s.size}`,
          "accept-ranges": "bytes",
          "content-length": end - start + 1,
        });
        return createReadStream(file, { start, end }).pipe(res);
      }
      res.writeHead(200, { "content-type": type, "content-length": s.size, "accept-ranges": "bytes" });
      return createReadStream(file).pipe(res);
    }

    // The component library and its gallery, served from the repo. Static and
    // read-only — the path is resolved against TOOLKIT and checked, so a scene
    // asking for ../../ gets a 404 rather than the filesystem.
    if (p.startsWith("/components/") || p.startsWith("/brand/")) {
      const file = resolve(TOOLKIT, `.${p}`);
      if (!file.startsWith(TOOLKIT)) {
        res.writeHead(403);
        return res.end();
      }
      const s2 = await stat(file).catch(() => null);
      if (!s2?.isFile()) {
        res.writeHead(404);
        return res.end();
      }
      const type =
        { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
          ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
          ".json": "application/json" }[extname(file).toLowerCase()] ??
        MIME[extname(file).toLowerCase()] ??
        "application/octet-stream";
      res.writeHead(200, { "content-type": type, "content-length": s2.size });
      return createReadStream(file).pipe(res);
    }

    // Optics. `brand/optics/optics.css` is @rolemodel/optics VERBATIM, vendored by
    // lib/optics-css.mjs and pinned by hash in brand/optics/manifest.json;
    // rolemodel-scales.css carries only the sub-brand scales the published
    // package does not define. Both are needed: the Studio spends
    // --op-color-academy-primary-*, which lives in the supplement. Served rather
    // than inlined so the browser caches it across reloads.
    /*
     * The brand mark, from the one file that defines it.
     *
     * It used to be a percent-encoded data: URI written twice into studio.html —
     * once for the favicon, once for the sidebar — which meant the drawing could
     * not be edited without hand-encoding it, and `lib/make-icon.mjs` scraped it
     * back out with a regex to build the app icon. Served as a file instead, so
     * there is one copy and it is legible.
     */
    if (p === "/brand-mark.svg") {
      const svg = await readFile(join(TOOLKIT, "brand", "icon", "mark.svg"), "utf8").catch(() => null);
      if (svg == null) return json(res, 404, { error: "brand/icon/mark.svg is missing" });
      res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": WATCH ? "no-store" : "max-age=60" });
      return res.end(svg);
    }

    if (p === "/optics.css") {
      const parts = [];
      for (const f of ["brand/optics/optics.css", "brand/optics/rolemodel-scales.css"]) {
        const css = await readFile(join(TOOLKIT, f), "utf8").catch(() => null);
        if (css != null) parts.push(css);
        else parts.push(`/* ${f} missing — run \`npm run optics\` */\n`);
      }
      res.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": WATCH ? "no-store" : "max-age=60" });
      return res.end(parts.join("\n"));
    }

    // The wallpaper editor's drawing code, served straight to the browser as an
    // ES module. Same file lib/render-wallpaper.mjs inlines for the batch build,
    // so the live preview and the exported JPEG cannot drift.
    // The Studio client, and the live-reload shim that only exists under --watch.
    // Both are real files on disk (lib/studio.js, lib/live-reload.js) rather than
    // strings inside the page generator, so `node --check` covers them and a
    // stray backtick can no longer serve the whole app as unstyled tags.
    if (p === "/studio.js" || p === "/live-reload.js") {
      const src = await readFile(join(TOOLKIT, "lib", p.slice(1)), "utf8").catch(() => null);
      if (src == null) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        return res.end(`lib${p} is missing\n`);
      }
      // Always no-store — see the note on "/" above. This file must never be
      // older than the markup that loads it.
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
      });
      return res.end(src);
    }

    if (p === "/script-parse.mjs") {
      const src = await readFile(join(TOOLKIT, "lib/script-parse.mjs"), "utf8");
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      return res.end(src);
    }

    if (p === "/wallpaper.mjs") {
      const src = await readFile(join(TOOLKIT, "lib/wallpaper.mjs"), "utf8");
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      return res.end(src);
    }

    if (p === "/api/wallpapers") return json(res, 200, { wallpapers: await loadRecipes(TOOLKIT) });

    // Save an edited wallpaper. The browser has already drawn the 4K frame on a
    // canvas — it sends the JPEG bytes with the recipe. That is deliberate: it
    // keeps Playwright a build-time dependency instead of something every
    // designer has to install, and it guarantees the saved file is pixel-for-pixel
    // the thing they were looking at when they hit Save.
    if (p === "/api/wallpaper" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const recipe = normalizeRecipe(body.recipe ?? {});
      recipe.name = wpSlug(body.recipe?.name || body.recipe?.label || "");
      if (!recipe.name || recipe.name === "untitled") return json(res, 400, { error: "give it a name" });
      recipe.label = (body.recipe?.label || recipe.name).trim();

      const dir = join(TOOLKIT, "brand/wallpapers");
      await mkdir(dir, { recursive: true });

      if (typeof body.jpeg === "string" && body.jpeg.length > 1000) {
        const b64 = body.jpeg.slice(body.jpeg.indexOf(",") + 1);
        await writeFile(join(dir, `${recipe.name}.jpg`), Buffer.from(b64, "base64"));
      }

      const all = await loadRecipes(TOOLKIT);
      const i = all.findIndex((r) => r.name === recipe.name);
      if (i === -1) all.push(recipe);
      else all[i] = recipe;
      await saveRecipes(all, TOOLKIT);
      await writeFile(
        join(dir, "index.json"),
        `${JSON.stringify(all.map((r) => ({ name: r.name, label: r.label, file: `${r.name}.jpg`, css: wpCSS(r) })), null, 2)}\n`,
        "utf8",
      );
      return json(res, 200, { ok: true, name: recipe.name, file: join(dir, `${recipe.name}.jpg`), count: all.length });
    }

    if (p.startsWith("/wallpaper/")) {
      const file = join(TOOLKIT, "brand/wallpapers", p.slice("/wallpaper/".length));
      const s = await stat(file).catch(() => null);
      if (!s) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { "content-type": "image/jpeg", "content-length": s.size });
      return createReadStream(file).pipe(res);
    }

    res.writeHead(404);
    res.end("not found");
  } catch (err) {
    json(res, 500, { error: String(err?.message ?? err) });
  }
});

function text(req) {
  return new Promise((res2, rej) => {
    let b = "";
    req.on("data", (d) => {
      b += d;
    });
    req.on("end", () => res2(b));
    req.on("error", rej);
  });
}

/**
 * The capture flags for whatever the user picked.
 *
 * `record` takes a screen by *index* and a window by *title substring*, and
 * nothing by id, so the choice has to say which kind it is. Empty means the
 * whole screen, which is `record`'s own default and needs no flag at all.
 */
function captureArgs(source) {
	const kind = source?.kind;
	const value = String(source?.value ?? "").trim();
	if (!value) return [];
	if (kind === "display") return Number.isFinite(Number(value)) ? ["--display", value] : [];
	if (kind === "window") return ["--window", value];
	return [];
}

await mkdir(LIB, { recursive: true });
// Put previous jobs back in the list before serving, so a restart does not look
// like nothing ever happened.
const restored = await jobs.restore();

server.listen(PORT, () => {
  const at = `http://localhost:${PORT}`;
  console.log(`\n  RoleModel Studio  ${at}`);
  console.log(`  library           ${LIB}`);
  if (SHELL) console.log("  shell             free-text commands ENABLED (--shell)");
  if (WATCH) console.log("  watch             reloading on changes to lib, presets, and brand\n");
  else console.log("");
  // A `node --watch` restart is not a new session.
  //
  // `npm run dev` restarts this whole process on every save, and every restart
  // used to run the line below — so an afternoon of editing stacked up a wall of
  // Chrome windows. Under --watch the browser is already where you left it and
  // the open tab reloads itself over /live-reload.js, so there is nothing to
  // open here. `--open` forces it for the first tab of a session.
  if (!flag("no-open") && (!WATCH || flag("open"))) {
    run(process.platform === "darwin" ? "open" : "xdg-open", [at]).catch(() => {});
  }
});

/**
 * Watch mode.
 *
 * `node --watch` (see `npm run dev`) already restarts this process when anything
 * under bin/ or lib/ changes — but it knows nothing about the browser, so you
 * still had to reach over and hit reload. This closes that loop, and also covers
 * the files node isn't watching: presets and brand.
 *
 * It is also why --watch opens no browser of its own: reloading the tab you are
 * looking at is the whole point, and a fresh window on every save defeats it.
 *
 * Debounced, because an editor writing a file produces several events and a
 * generator writing 15 JPEGs produces dozens.
 */
if (WATCH) {
  const { watch } = await import("node:fs");
  let timer = null;
  const bump = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      for (const res of reloadClients) res.write("data: reload\n\n");
    }, 120);
  };
  for (const dir of ["lib", "presets", "brand", "bin"]) {
    try {
      watch(join(TOOLKIT, dir), { recursive: true }, bump);
    } catch {
      /* a missing directory is not worth failing the server over */
    }
  }
}

// Don't orphan an ffmpeg or a half-finished export when the server goes away.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    jobs.stopAll();
    process.exit(0);
  });
}
