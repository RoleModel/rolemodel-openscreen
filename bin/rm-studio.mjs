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
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { installWallpapersIntoFork } from "../lib/wallpaper-install.mjs";
import { readComponentCatalogue, sceneHtml } from "../lib/compose.mjs";
import { cutlistToDocument } from "../lib/cutlist.mjs";
import { hasAlpha, renderStill } from "../lib/render-still.mjs";
import { homedir } from "node:os";
import { clientStamp, renderStudioHTML } from "../lib/studio-ui.mjs";
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
import {
  actions as demoActions,
  describe as describeDemo,
  parseDemo,
  settings as demoSettings,
} from "../lib/demo-script.mjs";
import { openFrame, shareVideo } from "../lib/openframe.mjs";
import { lastView, openFrameSettings, setLastView, setOpenFrameSettings, STATE_DIR } from "../lib/settings.mjs";
import { loadRecipes, saveRecipes } from "../lib/make-wallpapers.mjs";
import { css as wpCSS, normalize as normalizeRecipe, slug as wpSlug } from "../lib/wallpaper.mjs";
import * as jobs from "../lib/jobs.mjs";
import { isReady as voiceReady, venvDir } from "../lib/voice-setup.mjs";
import { stageRenderAssets } from "../lib/render-assets.mjs";

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
/*
 * Reload the page when the toolkit's own files change.
 *
 * `npm run dev` passes --watch. It is also on by default whenever the toolkit is
 * a git checkout, which is the case this exists for: the app launches the Studio
 * with neither --watch nor a terminal, so editing lib/studio.js changed the file
 * the server hands out and nothing told the page — the tab kept running the JS it
 * loaded at startup. Every symptom of that reads as a broken fix rather than a
 * stale page, and it cost real time more than once.
 *
 * An installed copy (brew, or an npm global) has no .git and never changes under
 * itself, so it gets no watcher and no cost. Pass --no-watch to opt out.
 */
const WATCH =
  argv.includes("--watch") ||
  (!argv.includes("--no-watch") && existsSync(join(TOOLKIT, ".git")));
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

/*
 * Scene previews, held between the POST that stashes one and the GET that shows
 * it. Module scope, not inside the handler — declared there, every request built
 * a fresh empty Map and the GET that followed always 404'd.
 *
 * In memory rather than on disk: a preview is a keystroke old and worth nothing
 * once the next one arrives. Only the last few are kept.
 */
const previews = new Map();
let previewSeq = 0;
const PREVIEWS_KEPT = 8;
const projectDir = (id) => join(LIB, id);
const mediaDir = (id) => join(projectDir(id), "media");
const thumbDir = (id) => join(projectDir(id), ".thumbs");

const MIME = {
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".m4v": "video/mp4",
  ".webm": "video/webm", ".mkv": "video/x-matroska",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
  // svg belongs here as much as png does: a logo served as octet-stream is a
  // logo a browser refuses to draw in an <img>, which reads as a missing asset.
  ".svg": "image/svg+xml",
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
      files.map(async (f) => {
        const name = f.replace(/\.md$/, "");
        /*
         * The brief that produced it, when there is one.
         *
         * Read here rather than fetched on demand so the Scripts panel can offer
         * a redo without a round trip per card. Hand-written scripts have no
         * brief and never will; absent is normal, not an error.
         */
        const brief = await readFile(join(dir, `${name}.brief.json`), "utf8")
          .then(JSON.parse)
          .catch(() => null);
        return {
          name,
          project,
          body: await readFile(join(dir, f), "utf8"),
          brief,
        };
      }),
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
  const [wallpapers, scripts, tokens, motion, logos, imagery] = await Promise.all([
    readFile(join(TOOLKIT, "brand/wallpapers/index.json"), "utf8").then(JSON.parse).catch(() => []),
    loadScripts(projects),
    readFile(join(TOOLKIT, "brand/tokens.json"), "utf8").then(JSON.parse).catch(() => ({})),
    // Motion direction for the Recast panel. Falls back to an empty spec rather
    // than throwing: a missing file should cost the render its motion sentences,
    // not the whole Studio.
    readFile(join(TOOLKIT, "brand/motion.json"), "utf8").then(JSON.parse).catch(() => ({ presets: {} })),
    // The marks, so the Brand page can show what a title card will actually draw.
    // Vendored and staged into renders since, but until now not visible anywhere —
    // which made "we have brand assets" a claim you had to take on trust.
    readFile(join(TOOLKIT, "brand/logos/index.json"), "utf8").then(JSON.parse).catch(() => []),
    // The clay renders. Same shape as logos: an index the page reads, so the
    // Studio never has to guess a filename or an extension.
    readFile(join(TOOLKIT, "brand/imagery/index.json"), "utf8")
      .then((t) => JSON.parse(t).imagery)
      .catch(() => []),
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
    // Label and hint only. The direction sentences stay server-side: the panel's
    // job is to name a motion preset, /api/make's job is to turn it into prompt.
    logos,
    imagery,
    motion: {
      default: motion.default || "brand",
      presets: Object.entries(motion.presets || {}).map(([id, m]) => ({ id, label: m.label, hint: m.hint })),
    },
    tools: { openscreen: os.ok, claude: claude.ok, ffmpeg: ff.ok, rclone: rclone.ok, hyperframes: hf.ok, voice },
    voiceVenv: venvDir(),
    remotes,
    // The panel that was open when the app last closed, so a restart lands where
    // the work was rather than back at the Library.
    lastView: await lastView(),
    /*
     * The brand's seed colours — one per family, and the palette anyone picks from.
     *
     * In state rather than in the compose catalogue, because it is brand data and
     * three panels want it: a picker that only exists where the catalogue happens
     * to be fetched is a picker that is missing from Wallpapers.
     *
     * `-original` is the colour as the brand defines it, before Optics builds a
     * nineteen-step ramp around it. The ramp is the right thing for a surface to
     * spend and the wrong thing to shop from: nineteen families times nineteen
     * steps is 361 squares, and the bases repeat — `tertiary` and `accent` are one
     * colour, and so are `primary` and Academy's.
     *
     * Both files, because the families are split across them: the published
     * package carries its own, and rolemodel-scales.css carries the fourteen it
     * does not ship.
     */
    colors: {
      originals: await (async () => {
        const [a, b] = await Promise.all([
          readFile(join(TOOLKIT, "brand/optics/optics.css"), "utf8").catch(() => ""),
          readFile(join(TOOLKIT, "brand/optics/rolemodel-scales.css"), "utf8").catch(() => ""),
        ]);
        return [...new Set([...`${a}\n${b}`.matchAll(/--op-color-([a-z0-9-]+)-original\s*:/g)].map((x) => x[1]))].sort();
      })(),
    },
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

    /*
     * What the client file is right now, so a stale window can notice.
     *
     * The page is stamped with the mtime it was built from; this is the current one.
     * A window that has been open across an edit reports a feature as broken when it
     * is simply running yesterday's code, and that has cost more time today than any
     * actual bug.
     */
    if (p === "/api/client-stamp") return json(res, 200, { stamp: await clientStamp() });

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
          "               a .brief.json beside a script is what was asked for, so it can be redone",
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

      let brand = body.brand || m.brand || "rolemodel";
      const src = (body.source || "").trim();
      if (!src) return json(res, 400, { error: "give it a script or a URL" });

      const isUrl = /^https?:\/\//i.test(src);

      /*
       * Settings written in the script beat the panel.
       *
       * The document is the more specific statement: it travels with the words it
       * applies to, it is what you read back later, and it is what somebody else
       * receives when you hand them the script. The panel is a convenience for the
       * things you have not written down, so it fills the gaps rather than
       * overriding them.
       *
       * Only for a pasted script. A URL has no directives in it, and running the
       * parser over one would report every line of a web address as a problem.
       */
      const fromDoc = isUrl ? {} : demoSettings(parseDemo(src));
      // Re-resolved from the document, which was parsed after `brand` was chosen.
      if (fromDoc.brand) brand = fromDoc.brand;
      const pick = (key, fallback) => {
        const v = fromDoc[key];
        return v === undefined || v === "" ? fallback : v;
      };
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
      const wallpaper = pick("wallpaper", body.wallpaper);
      if (wallpaper && wallpaper !== "none") {
        wants.push(`Use brand/wallpapers/${wallpaper} as the scene background.`);
      } else {
        wants.push("No wallpaper behind the scene — a flat background from the brand palette.");
      }
      const captions = pick("captions", body.captions ? "on" : "off");
      if (captions === "on" || captions === true) wants.push("Burn captions in, synced to the narration.");

      // Motion. Claude writes the render's GSAP timeline itself, so without these
      // sentences it picks an easing and a travel distance per run — which is why
      // two decks from the same brand never moved the same way. brand/motion.json
      // carries the sentences; an unknown id falls back to the spec's default
      // rather than sending nothing, because "no direction" is the bug this fixes.
      const motionSpec = await readFile(join(TOOLKIT, "brand/motion.json"), "utf8")
        .then(JSON.parse)
        .catch(() => ({ presets: {} }));
      const motionPick =
        motionSpec.presets?.[pick("motion", body.motion) || motionSpec.default || "brand"] ||
        motionSpec.presets?.[motionSpec.default];
      if (motionPick?.direction) wants.push(...motionPick.direction);

      // Narration voice. `hyperframes tts` is the synthesiser either way; naming
      // the voice is the only part this panel can decide, and until now it did not,
      // so the render came back in whichever voice the skill defaults to.
      /*
       * The brand, staged into the render directory.
       *
       * Vendoring the logos was not enough: a render runs in the project's Renders
       * folder, not inside the toolkit and not behind this server, so a composition
       * that referenced brand/ resolved to nothing and a title came out in system
       * type with no mark. So the marks, the faces, a theme.css built from
       * tokens.json and a working title card are copied in first, and the prompt
       * points at them by name.
       */
      await stageRenderAssets(outDir, { brand, quiet: true }).catch((e) => {
        console.error(`  could not stage brand assets: ${e.message}`);
      });
      wants.push(
        "The brand is already staged in the render directory: assets/brand/ holds the logo SVGs, " +
          "assets/brand/fonts/ holds DM Sans and Geist Mono as woff2, and theme.css defines the " +
          "palette and type scale as custom properties. Import theme.css and use those variables " +
          "and those fonts — do not link Google Fonts and do not pick your own colours.",
      );

      const titleCard = String(pick("title", body.titleCard) || "").trim();
      if (titleCard) {
        const eyebrow = String(pick("eyebrow", body.eyebrow) || "").trim();
        wants.push(
          `Open with the title card in title.html, which is already staged and already uses the ` +
            `brand mark, the vendored faces and theme.css. Change only the words: the title reads ` +
            `"${titleCard}"${eyebrow ? `, and the eyebrow above it reads "${eyebrow}"` : `, and remove the eyebrow`}.`,
        );
      } else {
        wants.push("No title card — open on the content.");
      }

      /*
       * Media is named to Claude by ABSOLUTE path.
       *
       * The catalog stores paths relative to the project ("Audio/demo.wav"), and the
       * step runs with `cwd` set to the render directory — so a relative name resolves
       * to <project>/media/Renders/<slug>/Audio/demo.wav, which does not exist. Claude
       * was told to use a file it could not open, found nothing, and carried on: the
       * visible result was "it ignored the audio track I gave it", with nothing in the
       * transcript to say why.
       *
       * Quoted, because the library path contains a space ("RoleModel Library") and a
 * bare path in prose has no visible end — a reader that stops at the space opens
 * nothing and reports nothing.
 *
 * A missing file is reported rather than named. An instruction pointing at
       * nothing is worse than none — it spends attention and yields silence.
       */
      const mediaPath = async (rel) => {
        if (!rel) return null;
        const abs = join(mediaDir(id), rel);
        return (await stat(abs).catch(() => null)) ? abs : null;
      };

      const webcamRel = String(pick("webcam", body.webcam) || "").trim();
      const webcam = (await mediaPath(webcamRel)) ?? "";
      if (webcamRel && !webcam) wants.push(`The webcam clip named for this render (${webcamRel}) is not on disk — render without it.`);
      if (webcam) {
        wants.push(
          `Composite this exact file as a circular picture-in-picture in the lower right: "${webcam}"
  About ` +
            "22% of frame height, with a soft edge — the same treatment a recording gets. " +
            "It is a real clip on disk: use it, do not draw a placeholder.",
        );
      }

      // /music is the same track in a different role, so either directive supplies it.
      const audioRel = String(fromDoc.music || pick("audio", body.audio) || "").trim();
      const audio = (await mediaPath(audioRel)) ?? "";
      if (audioRel && !audio) wants.push(`The audio named for this render (${audioRel}) is not on disk — say so rather than substituting a synthesised voice.`);
      if (audio) {
        const asMusic = fromDoc.music ? true : String(pick("audioRole", body.audioRole) || "narration") === "music";
        wants.push(
          asMusic
            ? `Use this exact file as a music bed under the whole render: "${audio}"
  Ducked well ` +
                "below any speech, and fade it out at the end."
            : `Use this exact file as the narration track: "${audio}"` +
                "\n  It is an absolute path and it exists. Mux it in as the spoken audio, cut the " +
                "visuals to its timing, and do NOT synthesise a voice. If you cannot read it, stop " +
                "and say so rather than rendering silent or substituting a synthesised voice.",
        );
      }

      const docVoice = fromDoc.voice === "none" ? "" : fromDoc.voice;
      const voiceId = String(docVoice ?? body.voice ?? "").trim();
      const audioIsNarration = audio && !(fromDoc.music || String(pick("audioRole", body.audioRole) || "narration") === "music");
      if (voiceId && !audioIsNarration) {
        wants.push(
          `Narrate with \`hyperframes tts --voice ${voiceId}\` — that exact voice id, for every spoken line.`,
        );
      } else if (audioIsNarration) {
        // Recorded narration wins. Saying both would ask for two spoken tracks.
        wants.push("Do not synthesise narration — the recorded track above is the voice.");
      } else {
        wants.push("No voiceover. Render silent; do not synthesise narration.");
      }
      const direction = `\n\nDirection:\n${wants.map((w) => `- ${w}`).join("\n")}`;

      /*
       * The script in the prompt is the words only.
       *
       * Directive lines are already sentences in `wants`, and leaving them in the
       * script as well would ask Claude to interpret `/voice af_heart` as narration
       * to speak — which is the same mistake the parsers were changed to avoid.
       */
      const spokenSrc = isUrl
        ? src
        : src
            .split("\n")
            .filter((line) => !/^\s*\/[a-z][a-z-]*(\s|$)/i.test(line))
            .join("\n")
            .trim();

      const prompt = isUrl
        ? `Using /hyperframes, make a ${body.seconds || 20}-second ${brand}-branded promo for ${src}.\nRender the MP4 into ${outDir}.${direction}`
        : `Using /hyperframes, build a ${brand}-branded video from the script below.\nRender the MP4 into ${outDir}.${direction}\n\n${spokenSrc}`;

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
        `- motion: ${motionPick ? motionPick.label : "none"}`,
        `- voice: ${audioIsNarration ? "recorded track" : voiceId || "none (silent)"}`,
        `- title card: ${titleCard || "none"}`,
        `- webcam: ${webcam || "none"}`,
        `- audio: ${audio ? `${audio} (${body.audioRole || "narration"})` : "none"}`,
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
              /*
               * What the listing already told us, kept.
               *
               * This used to map every video down to id and title, which is why the
               * Review page read as a list of names that "just sit there" — nothing
               * on it could tell you a client had been in. OpenFrame's videos
               * endpoint already returns the active version with
               * `_count: { comments }`, its number, its duration and a thumbnail, in
               * the same call. It cost nothing to ask for and was thrown away.
               */
              videos: (videos?.videos ?? videos ?? []).map((v) => {
                const version = (v.versions ?? [])[0] ?? null;
                return {
                  id: v.id,
                  title: v.title,
                  projectId: proj.id,
                  versionId: version?.id ?? null,
                  version: version?.versionNumber ?? null,
                  versions: v._count?.versions ?? null,
                  comments: version?._count?.comments ?? 0,
                  duration: version?.duration ?? null,
                  thumbnail: version?.thumbnailUrl ?? null,
                };
              }),
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
    /**
     * How a review is actually going, for one video.
     *
     * Two things the listing cannot carry. The comment count it does carry is every
     * comment ever left, so a video whose notes are all dealt with looks identical to
     * one nobody has touched — the unresolved count is the number that means anything.
     * And approvals are per version, so they need the version, not the video.
     *
     * On demand rather than in the listing: both are a call each, and the listing
     * already costs one per project.
     */
    /**
     * A review thumbnail, fetched with the token and passed through.
     *
     * The page cannot load these itself. OpenFrame serves them from
     * /api/upload/image/<file>, which resolves which video the image belongs to and
     * then checks project access — so an anonymous <img> gets 403, and the Studio
     * page has no OpenFrame session and should never be given the token.
     *
     * So the server does it. The path is taken from the listing rather than the
     * query string: accepting an arbitrary path here would turn this into an open
     * proxy for anything on that host, signed with our token.
     */
    /*
     * A half-built script, kept where a restart cannot reach it.
     *
     * The first version of this used localStorage, which was wrong in a way that only
     * showed up on the second launch: the app asks the OS for a free port every time
     * (electron/studio/server.ts), so the page's origin is http://127.0.0.1:<new port>
     * on every start — and localStorage is keyed by origin. Same session it worked.
     * Restart the app and the draft was in a store nothing would ever read again.
     *
     * So the server keeps it, next to the config it already owns. A real path, on
     * disk, that survives a restart and that you can go and look at.
     */
    if (p === "/api/record/draft" && req.method === "GET") {
      const id = url.searchParams.get("project");
      if (!id) return json(res, 400, { error: "need a project" });
      const rows = await readDraft(id);
      return json(res, 200, { rows });
    }

    if (p === "/api/record/draft" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = String(body.projectId ?? "");
      if (!id) return json(res, 400, { error: "need a project" });
      try {
        const file = await writeDraft(id, body.rows);
        return json(res, 200, { ok: true, saved: file });
      } catch (err) {
        return json(res, 500, { error: err.message });
      }
    }

    if (p === "/api/review/thumb") {
      const { url: base, token } = await openFrameSettings();
      if (!base || !token) return json(res, 400, { error: "OpenFrame is not configured" });
      const videoId = url.searchParams.get("video");
      const projectId = url.searchParams.get("project");
      if (!videoId || !projectId) return json(res, 400, { error: "need project and video" });
      try {
        const api = openFrame({ base, token });
        const listing = await api.call(`/api/projects/${projectId}/videos`);
        const video = (listing?.videos ?? []).find((v) => v.id === videoId);
        const thumb = (video?.versions ?? [])[0]?.thumbnailUrl;
        // Only a path this instance told us about, and only an image path.
        if (!thumb || !/^\/api\/upload\/image\/[A-Za-z0-9._-]+$/.test(thumb)) {
          return json(res, 404, { error: "no thumbnail" });
        }
        const upstream = await fetch(base.replace(/\/$/, "") + thumb, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (!upstream.ok) return json(res, 502, { error: `OpenFrame answered ${upstream.status}` });
        const bytes = Buffer.from(await upstream.arrayBuffer());
        res.writeHead(200, {
          "content-type": upstream.headers.get("content-type") ?? "image/jpeg",
          // Short: a new version replaces the thumbnail under the same video id.
          "cache-control": "private, max-age=60",
        });
        return res.end(bytes);
      } catch (err) {
        return json(res, 502, { error: err.message });
      }
    }

    if (p === "/api/review/status") {
      const { url: base, token } = await openFrameSettings();
      if (!base || !token) return json(res, 400, { error: "OpenFrame is not configured — set it on the Review page" });
      const versionId = url.searchParams.get("version");
      if (!versionId) return json(res, 400, { error: "need a version" });
      const api = openFrame({ base, token });
      const out = { unresolved: null, total: null, approval: null, error: null };
      try {
        // includeResolved, so resolved and open can be told apart. Without it the
        // reply is already filtered and there is nothing to count.
        const page = await api.call(`/api/versions/${versionId}/comments?includeResolved=true&limit=200&offset=0`);
        const all = page?.comments ?? [];
        const count = (list) => list.reduce((n, c) => n + 1 + (c.replies?.length ?? 0), 0);
        out.total = count(all);
        out.unresolved = count(all.filter((c) => !c.isResolved));
      } catch (err) {
        /*
         * The 403 here is not a permissions problem to fix on the OpenFrame side —
         * it is that the comments route authenticates with `auth()` alone, so it only
         * ever sees a browser session. Six of OpenFrame's sixty-six routes use the
         * token-aware `authFromRequest`, and they are all on the upload-and-share
         * path. So this toolkit can create a project, upload a video and mint a share
         * link, and cannot read one comment back.
         *
         * Said plainly, because "403: Access denied" reads as a misconfigured token
         * and no amount of fiddling with the token will change it.
         */
        out.error = /\b403\b/.test(err.message)
          ? "OpenFrame will not answer an API token here — its comments route only accepts a browser session. The notes exist; nothing can fetch them until that route accepts a token."
          : err.message;
      }
      try {
        const approvals = await api.call(`/api/versions/${versionId}/approvals`);
        const requests = approvals?.requests ?? approvals?.approvals ?? (Array.isArray(approvals) ? approvals : []);
        // The newest request is the live one; the rest are history.
        const latest = requests[0] ?? null;
        if (latest) {
          out.approval = {
            status: latest.status ?? null,
            decisions: (latest.decisions ?? []).map((d) => d.status).filter(Boolean),
          };
        }
      } catch {
        // Approvals are a feature of the fork, not a guarantee. A instance without
        // them should report comments and stay quiet about the rest.
      }
      return json(res, 200, out);
    }

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

    /*
     * Can a demuxer open this at all?
     *
     * `-show_format` reads the header and the index and stops; it does not decode,
     * so this costs milliseconds even on a 4K file on a mounted remote. A file that
     * fails here fails identically in the editor, and saying so before handing it
     * over is the difference between a sentence and a Chromium pipeline enum.
     */
    const playable = async (file) => {
      const r = await capture("ffprobe", ["-v", "error", "-show_format", "-of", "json", file]);
      return r.ok;
    };

    /*
     * Point a document back at a video that is actually there.
     *
     * A capture is written to the app's private recordings folder and then copied
     * into the project, but the document kept the private path. Clean that folder —
     * the app does, and so does anyone reclaiming disk — and the document still
     * opens, still validates, and has no picture. Three of five documents in the
     * library were in that state, one with its own video sitting beside it.
     *
     * Only ever repairs to a sibling of the document, so it cannot invent an
     * association: same directory, same basename, a video extension. A document
     * whose media is present is untouched, and one with no candidate is left alone
     * and reported rather than blanked.
     */
    const repairDocumentMedia = async (docPath) => {
      let doc;
      try {
        doc = JSON.parse(await readFile(docPath, "utf8"));
      } catch {
        return { repaired: false, reason: "the document could not be read" };
      }
      const current = doc?.media?.screenVideoPath;
      if (!current) return { repaired: false, reason: "the document names no video" };
      if (await stat(current).catch(() => null)) {
        /*
         * Present is not the same as playable.
         *
         * An interrupted encode leaves a file with ftyp and mdat and no moov atom —
         * ffmpeg writes the index last — so it exists, has size, and no demuxer can
         * open it. Handed to the editor it fails as
         * "MEDIA_ERR_SRC_NOT_SUPPORTED (4) — DEMUXER_ERROR_COULD_NOT_OPEN", which
         * says nothing about which file or why, and reads as the editor being
         * broken. One ffprobe of the header is cheap and turns that into a sentence.
         */
        if (await playable(current)) return { repaired: false, reason: null };
        return {
          repaired: false,
          reason:
            `${basename(current)} is not a readable video — the render was almost certainly ` +
            "interrupted before it finished writing. Render it again.",
        };
      }

      const stem = basename(docPath, extname(docPath));
      for (const ext of [".mp4", ".mov", ".webm", ".mkv"]) {
        const sibling = join(dirname(docPath), stem + ext);
        if ((await stat(sibling).catch(() => null)) && (await playable(sibling))) {
          doc.media.screenVideoPath = sibling;
          await writeFile(docPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
          return { repaired: true, from: current, to: sibling, reason: null };
        }
      }
      return { repaired: false, reason: `the video it names is gone: ${current}` };
    };

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
      // Before handing it over, not after: an editor that has already opened a
      // document with no media has nothing useful to do with the news.
      const repair = made ? { repaired: false, reason: null } : await repairDocumentMedia(doc);

      const opened = body.hosted ? { opened: false, via: "host" } : await openInOpenScreen(doc);
      if (body.projectId) await reindex(body.projectId, { force: true }).catch(() => {});
      return json(res, 200, {
        ...opened,
        document: doc,
        made,
        repaired: repair.repaired,
        // Reported rather than swallowed: "the editor lost my video" and "the file
        // this document names was deleted" need different responses.
        mediaProblem: repair.reason,
      });
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

      /*
       * A script turns this from "capture whatever happens" into a demo.
       *
       * Without one the recorder runs for --duration and hopes somebody is driving,
       * which is what made this panel unusable for the thing it exists for. With one,
       * `rm-demo capture` drives a browser through the steps while the recorder
       * captures that window — and because it still writes a .openscreen document,
       * the brand step and the editor below are unchanged.
       *
       * The script is written to disk beside the document rather than passed inline:
       * it is the part worth keeping and re-running, and rm-demo takes a file.
       */
      const script = String(body.script ?? "").trim();
      let scriptPath = null;
      if (script) {
        const parsed = parseDemo(script);
        if (parsed.problems.length) return json(res, 400, { error: parsed.problems.join(" · ") });
        const acts = demoActions(parsed);
        if (!acts.length) {
          return json(res, 400, { error: "the script has no ```do block, so nothing would drive the capture" });
        }
        /*
         * Only a launched capture needs a goto. Attaching starts on a page that is
         * already open, which is the entire point of it — requiring navigation there
         * would defeat it.
         */
        if (!body.attach && !acts.some((a) => a.verb === "goto")) {
          return json(res, 400, {
            error:
              "this script never navigates, so there would be nothing to act on — add a first step that goes to a page.",
          });
        }
        scriptPath = join(dest, `${slug}.demo.md`);
        await writeFile(scriptPath, script.endsWith("\n") ? script : `${script}\n`, "utf8");
      }

      // argv arrays, not command strings. The UI needs to *run* these, and a
      // string would have to be re-parsed by a shell to get back to this — which
      // is where quoting bugs and injection both live. The display string is
      // derived from the array, never the other way round.
      const recordStep = scriptPath
        ? ownStep(
            "rm-demo",
            [
              "capture", scriptPath,
              "--project", proj,
              /*
               * The picked window goes through only when attaching.
               *
               * The Capture list names windows that already exist. A *launched* capture
               * drives a browser it opens itself, so passing the picked window recorded
               * one thing while the script drove another — thirty seconds of the Feeney
               * window while a blank Chromium got the clicks. Attaching is the opposite
               * case: the picked window IS the browser being driven, so it is exactly
               * what the recorder should film.
               */
              ...(body.attach ? captureArgs(body.source) : []),
              ...attachArgs(body),
              ...recorderArgs(body),
              ...driverArgs(body),
              ...(body.seconds ? ["--duration", String(body.seconds)] : []),
            ],
            {
              label: "record",
              note: "drives the browser and records it — Screen Recording permission still applies",
            },
          )
        : {
            label: "record",
            bin: "openscreen",
            args: [
              "record",
              ...captureArgs(body.source),
              ...recorderArgs(body),
              ...(body.seconds ? ["--duration", String(body.seconds)] : []),
              "--project", proj,
              "--json",
            ],
            note: "needs Screen Recording permission for whatever hosts Electron",
          };

      const steps = [
        recordStep,
        ownStep("rm-video", ["brand", proj, "--preset", m.brand || "rolemodel"], { label: "brand" }),
        {
          label: "export",
          bin: "openscreen",
          args: ["export", proj, "-o", join(dest, `${slug}.mp4`), "--auto-zoom", "--json"],
        },
      ];

      return json(res, 200, { dest, project: proj, steps, editable: proj, script: scriptPath });
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

/**
 * What to say when the voice list could not be read.
 *
 * A version number in a cache path is a fact about npm, not something anyone can do
 * anything about. When it is the cache, say what it costs and let the button do the
 * rest; when it is something else, the real error is still the most useful sentence
 * available.
 */
function cacheMiss(why) {
	if (why?.startsWith("hyperframes") && why.includes("npx cache")) {
		return "Kokoro is ready. Reading its voice list needs a one-off download first — the built-in ids below work meanwhile.";
	}
	return `${why ?? "Kokoro would not list its voices"}. The built-in ids below work.`;
}

/**
 * Do the download the voice list needs, on request.
 *
 * `--yes` rather than `--no-install`: this is the one place a fetch is what was
 * asked for. Everything else here probes with --no-install so that loading a page
 * can never pull from the network.
 *
 * It returns the voices as well, so one click both fixes the cause and fills the
 * field — a button that succeeds and leaves the list still wrong is a button that
 * looks broken.
 */
async function fetchVoiceList() {
	const r = await capture("npx", ["--yes", "hyperframes", "tts", "--list", "--json"]);
	if (!r.ok) return { ok: false, error: npxWhy(r) };
	try {
		const raw = JSON.parse(r.out.slice(r.out.indexOf("[")));
		const voices = raw
			.filter((v) => v?.id)
			.map((v) => ({
				id: String(v.id),
				label: [v.label || v.id, v.gender, v.language].filter(Boolean).join(" · "),
			}));
		if (!voices.length) return { ok: false, error: "hyperframes answered with an empty voice list" };
		return { ok: true, voices };
	} catch (err) {
		return { ok: false, error: `hyperframes answered, but not with a voice list (${err.message})` };
	}
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
      let why = null;
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
        } catch (err) {
          // It answered, but not with the list. Keep the reason: "hyperframes ran
          // and its output was not JSON" is a different problem from "hyperframes
          // did not run", and the note used to report both as the latter.
          why = `hyperframes answered, but not with a voice list (${err.message})`;
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
      if (!why && !r.ok) why = npxWhy(r);
      return json(res, 200, {
        from: "static",
        voices: VOICES.map((v) => ({ id: v.id, label: v.label })),
        /*
         * A cache miss is the one failure with a fix, so it gets a button instead of
         * an explanation. "hyperframes 0.8.12 is not in the npx cache — a newer
         * release than the copy on this machine" is true, actionable by nobody, and
         * was the entire answer the page had.
         *
         * `fetchable` is the flag rather than the prose, so the page never has to
         * pattern-match a sentence to decide whether to offer the button.
         */
        fetchable: ready && Boolean(why?.startsWith("hyperframes") && why.includes("npx cache")),
        note: ready
          ? cacheMiss(why)
          : "This is the built-in list, because Kokoro is not installed yet. Use “Set up voice” above — it builds a private Python environment, once, and then the list comes from Kokoro itself.",
      });
    }

    if (p === "/api/voices/fetch" && req.method === "POST") {
      const got = await fetchVoiceList();
      return json(res, 200, got.ok ? { ok: true, from: "kokoro", voices: got.voices } : { ok: false, error: got.error });
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
          const video = VIDEO_EXT.has(ext);
          const audio = AUDIO_EXT.has(ext);
          const image = IMAGE_EXT.has(ext);
          files.push({
            name: e.name,
            path: join(dir, e.name),
            ext,
            // Every flag a picker's `accept` asks for. Two were missing and both
            // failed silently in opposite directions: the click-sound picker tested
            // `x.audio`, which was never sent, so it hid every file in every folder
            // and looked like an empty disk; and `Add footage` tested
            // `x.media ?? true`, so the `?? true` took over and it offered shell
            // scripts as footage.
            trace: ext === ".zip",
            video,
            audio,
            image,
            media: video || audio || image,
            subs: SUBS_EXT.has(ext),
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
        // The path, split into the pieces a breadcrumb can jump to. Walking back up
        // with `..` one level at a time is what made this feel like a dead end.
        crumbs: (dir === root ? [] : dir.slice(root.length + 1).split(sep)).reduce(
          (acc, part) => {
            const prev = acc.length ? acc[acc.length - 1].path : root;
            acc.push({ name: part, path: join(prev, part) });
            return acc;
          },
          [],
        ),
        places: await browsePlaces(root),
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
          ownStep("rm-demo", args, {
            label: "demo",
            note: "opens a real browser window and drives it — do not type while it runs",
          }),
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

      /*
       * Keep the brief, not just what it produced.
       *
       * The prompt was assembled here, handed to Claude, and thrown away — so once
       * the script existed the inputs that made it were gone, and "same idea, one
       * change" meant retyping the brief from memory and hoping it matched.
       *
       * It goes beside the script inside the project rather than into a side store:
       * scripts/ is part of a project, so the brief travels with it, syncs with it,
       * and diffs with it. `prompt` is recorded as well as the inputs because the
       * assembly rules here will change, and a redo should be able to show what was
       * actually asked the first time.
       */
      await writeFile(
        join(dir, `${nm}.brief.json`),
        `${JSON.stringify(
          {
            version: 1,
            name: nm,
            // Recorded rather than inferred from where the file sits: a script moved
            // between projects should still say which one it was drafted for.
            projectId: id,
            about,
            seconds: Number(body.seconds) || 30,
            brand: m.brand || "rolemodel",
            client: m.client ?? null,
            project: m.name,
            prompt,
            drafted: new Date().toISOString(),
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

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

    /*
     * A remote's name is spliced straight into an rclone argv, so it is checked
     * rather than trusted. Not for shell injection — there is no shell here — but
     * because a name starting with "-" is read by rclone as a flag, and rclone's
     * own config keys are this shape anyway.
     */
    const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

    /*
     * What a remote is, minus the part nobody may read back.
     *
     * `rclone config show` prints the secret — obscured, but obscuring is
     * reversible by design, so it is a credential and it does not leave this
     * process. The client gets whether one is set, not what it is.
     */
    const readRemote = async (name) => {
      const r = await capture("rclone", ["config", "show", name]);
      /*
       * Exit code is not the signal here. `rclone config show does-not-exist`
       * exits 0 and prints the section header plus a comment, so a missing
       * remote is detected by the absence of a type rather than by a failure.
       */
      if (!r.ok) return null;
      const cfg = {};
      for (const line of r.out.split("\n")) {
        const m = line.match(/^\s*([a-z_]+)\s*=\s*(.*)$/);
        if (m) cfg[m[1]] = m[2].trim();
      }
      if (!cfg.type) return null;
      return {
        name,
        type: cfg.type,
        provider: cfg.provider ?? null,
        endpoint: cfg.endpoint ?? null,
        accessKeyId: cfg.access_key_id ?? null,
        hasSecret: Boolean(cfg.secret_access_key),
      };
    };

    const storageName = p.startsWith("/api/storage/") ? decodeURIComponent(p.slice("/api/storage/".length)) : null;

    if (storageName !== null && !REMOTE_NAME.test(storageName)) {
      return json(res, 400, { error: "a remote name is letters, digits, dash and underscore" });
    }

    if (storageName && req.method === "GET") {
      const r = await readRemote(storageName);
      return r ? json(res, 200, r) : json(res, 404, { error: `no rclone remote named "${storageName}"` });
    }

    /*
     * Update, not re-create. `rclone config update` leaves untouched keys alone,
     * which is what makes "leave the secret blank to keep the current one"
     * honest — the alternative, delete-and-recreate, would silently drop any key
     * this form does not know about.
     */
    if (storageName && req.method === "PUT") {
      const b = JSON.parse(await text(req));
      const args = ["config", "update", storageName];
      if (b.endpoint) args.push("endpoint", String(b.endpoint));
      if (b.accessKeyId) args.push("access_key_id", String(b.accessKeyId));
      // Only when a new one was actually typed. An empty string here would
      // overwrite a working credential with nothing.
      if (b.secretAccessKey) args.push("secret_access_key", String(b.secretAccessKey));
      if (args.length === 3) return json(res, 400, { ok: false, err: "nothing to change" });
      const r = await capture("rclone", args);
      return json(res, r.ok ? 200 : 500, { ok: r.ok, out: r.out, err: r.err });
    }

    if (storageName && req.method === "DELETE") {
      const r = await capture("rclone", ["config", "delete", storageName]);
      return json(res, r.ok ? 200 : 500, { ok: r.ok, out: r.out, err: r.err });
    }

    /*
     * Proof, not a saved form. Credentials that parse are not credentials that
     * work, and the difference only shows up later in a failed sync — so listing
     * the buckets is the cheapest call that actually authenticates.
     */
    if (storageName && req.method === "POST") {
      const r = await capture("rclone", ["lsd", `${storageName}:`, "--max-depth", "1"]);
      const buckets = r.ok ? r.out.split("\n").map((l) => l.trim().split(/\s+/).pop()).filter(Boolean) : [];
      return json(res, 200, { ok: r.ok, buckets, err: r.err });
    }

    if (p === "/api/storage" && req.method === "POST") {
      const b = JSON.parse(await text(req));
      if (!REMOTE_NAME.test(String(b.name ?? ""))) {
        return json(res, 400, { ok: false, err: "a remote name is letters, digits, dash and underscore" });
      }
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

    /*
     * Empty the Console.
     *
     * Before the id-suffixed routes below, and with no id of its own, so "clear"
     * cannot be mistaken for a job called clear.
     */
    if (p === "/api/jobs/clear" && req.method === "POST") {
      const cleared = await jobs.clearFinished();
      return json(res, 200, { cleared, remaining: jobs.list().length });
    }

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

    /*
     * The icon set and the two faces studio.html names, served from this repo.
     *
     * Both are vendored rather than linked. The Studio is hosted by a desktop app
     * that has to start with no network, and an icon set fetched over HTTP renders
     * as empty boxes on a plane. The faces were the same bug already shipped:
     * studio.html has asked for "DM Sans" and "Geist Mono" all along and nothing
     * ever served them, so the Studio has been falling back to system-ui on any
     * machine that did not happen to have DM Sans installed.
     */
    if (p === "/hugeicons.css") {
      const css = await readFile(join(TOOLKIT, "brand/icons/hugeicons.css"), "utf8").catch(() => null);
      if (css == null) return json(res, 404, { error: "no icon set — run `npm run icons`" });
      res.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": WATCH ? "no-store" : "max-age=60" });
      return res.end(css);
    }

    if (p === "/fonts.css") {
      res.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": WATCH ? "no-store" : "max-age=60" });
      return res.end(FONT_CSS);
    }

    /*
     * One route for every vendored font file, icon set included.
     *
     * Name-checked against a fixed list rather than joined onto a directory: this
     * takes a path from the network, and `/fonts/../../.ssh/id_rsa` is the shape of
     * bug that turns a static file server into a file server.
     */
    {
      const font = /^\/(?:fonts|icons)\/([A-Za-z0-9._-]+\.woff2)$/.exec(p);
      if (font) {
        const name = font[1];
        const dir = p.startsWith("/icons/") ? "brand/icons" : "brand/fonts";
        if (!FONT_FILES.has(name)) return json(res, 404, { error: "no such font" });
        const bytes = await readFile(join(TOOLKIT, dir, name)).catch(() => null);
        if (!bytes) return json(res, 404, { error: `${name} is missing — run \`npm run icons\`` });
        res.writeHead(200, {
          "content-type": "font/woff2",
          // Immutable: the filename changes when the file does, because both are
          // regenerated together by their build script.
          "cache-control": "max-age=604800, immutable",
        });
        return res.end(bytes);
      }
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
    /*
     * The stylesheet, served the same way as the script.
     *
     * `no-store` for the same reason: it must never be older than the markup that
     * links it. A cached stylesheet against fresh markup is a page that looks
     * broken in a way nothing in the source explains.
     */
    if (p === "/studio.css") {
      const src = await readFile(join(TOOLKIT, "lib", "studio.css"), "utf8").catch(() => null);
      if (src == null) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        return res.end("lib/studio.css is missing\n");
      }
      res.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" });
      return res.end(src);
    }

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

    // The step builder needs the same speech estimate the compiler uses. Served,
    // not reimplemented in the page: two estimators would drift and the whole point
    // is that one number decides both the hold and what the UI promises.
    if (p === "/demo-script.mjs") {
      const src = await readFile(join(TOOLKIT, "lib/demo-script.mjs"), "utf8");
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
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
    /*
     * What a composition can be built from.
     *
     * Components come from the catalogue parser rather than a list here, so adding a
     * field to a component makes it appear in the form with no second edit. Footage
     * is whatever the project already has — a composition names files, it does not
     * import them.
     */

    /*
     * Preview an authored scene exactly as it will render.
     *
     * Wrapped by the same sceneHtml() the renderer uses, so what is on screen and
     * what comes out of ffmpeg cannot disagree — a preview built any other way is a
     * second implementation of the harness and will drift from it. Served under
     * /components/ so `./rm-video.js` and the brand stylesheets resolve.
     */
    /*
     * Preview an authored scene exactly as it will render.
     *
     * Two steps, because an iframe cannot POST: the body is stashed and the frame
     * GETs it back. The obvious shortcuts do not work — a `srcdoc` document and a
     * `blob:` URL both have an opaque origin with no base, so the stylesheets, the
     * fonts and rm-video.js all fail to resolve and the scene renders unstyled with
     * nothing upgraded. It has to come from this origin.
     *
     * Wrapped by the same sceneHtml() the renderer uses, so what is on screen and
     * what comes out of ffmpeg cannot disagree.
     */
    if (p === "/api/scene/preview" && req.method === "POST") {
      const b = JSON.parse(await text(req));
      const id = String(++previewSeq);
      previews.set(id, { body: String(b.body ?? ""), wallpaper: b.wallpaper || undefined, brand: b.brand || undefined, name: b.name || "Scene preview" });
      // Only the last few matter; anything older is a frame nobody is looking at.
      for (const key of previews.keys()) {
        if (previews.size <= PREVIEWS_KEPT) break;
        previews.delete(key);
      }
      return json(res, 200, { url: `/api/scene/preview/${id}` });
    }

    if (p.startsWith("/api/scene/preview/")) {
      const held = previews.get(p.slice("/api/scene/preview/".length));
      if (!held) {
        res.writeHead(404);
        return res.end("no such preview");
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(sceneHtml({ ...held, title: held.name, base: "" }));
    }

    /*
     * Ask Claude for a scene body.
     *
     * The contract is a file, not a string built here: it is long, it is the thing
     * that decides whether a scene renders correctly, and it belongs next to the
     * brand rules it enforces rather than inside a request handler.
     */
    /*
     * One completion, no tools, small model.
     *
     * This used to hand the job to an agent: read SCENE.md, read the 470 lines of
     * rm-video.js, read design.md, then write the file — with edit permissions and a
     * streaming session, to produce twenty lines of markup against a fixed
     * vocabulary. It cost more than everything else in the Studio combined and took
     * the longest to come back.
     *
     * The vocabulary IS the contract, and it is already parsed for the palette. Sent
     * inline it is under a kilobyte, so there is nothing to read, nothing to permit,
     * and no reason for a large model: the task is assembling known tags around
     * somebody's sentence.
     *
     * The markup comes back on stdout and the Studio writes the file, which also
     * means the panel can drop it straight into the cards instead of telling you to
     * go and pick it up.
     */
    if (p === "/api/scene/draft" && req.method === "POST") {
      const b = JSON.parse(await text(req));
      const id = b.projectId;
      const man = await readManifest(projectDir(id)).catch(() => null);
      if (!man) return json(res, 404, { error: "pick a project" });
      const about = String(b.about ?? "").trim();
      if (!about) return json(res, 400, { error: "what is the scene? a sentence is enough" });
      if (!String(b.name ?? "").trim()) return json(res, 400, { error: "give the scene a name" });

      const cat = await readComponentCatalogue(TOOLKIT);
      const vocabulary = cat
        .map((c) => `<${c.tag} at="ms" for="ms" ${c.fields.map((f) => `${f}="…"`).join(" ")}></${c.tag}>`)
        .join("\n");

      const prompt = [
        "Write the inside of a HyperFrames scene using only these elements.",
        "Output markup and nothing else: no prose, no code fences, no <html>, <head>,",
        "<body> or <rm-scene> wrapper — those are supplied.",
        "`at` and `for` are milliseconds. Elements may overlap. Omit a field you do not need.",
        "No decorative rules, underlines or dividers; the components carry their own.",
        "",
        vocabulary,
        "",
        man.client ? `Client: ${man.client}. Project: ${man.name}.` : `Project: ${man.name}.`,
        `Scene: ${about}`,
      ].join("\n");

      let out = "";
      try {
        const r = await capture("claude", [
          "-p", prompt,
          // Small on purpose: assembling known tags around a sentence.
          "--model", "haiku",
          // No tools at all. Nothing here needs to read or write anything.
          "--allowedTools", "",
          "--output-format", "text",
        ]);
        if (!r.ok) throw new Error(r.err || "claude exited non-zero");
        out = r.out;
      } catch (err) {
        return json(res, 502, { error: `could not draft it: ${String(err.message ?? err).slice(0, 200)}` });
      }

      /*
       * Keep only elements we know.
       *
       * A fence, an apology or an invented tag all render as nothing, and a scene
       * that silently comes back empty is worse than one that says what it got.
       */
      const tags = cat.map((c) => c.tag).join("|");
      const kept = (out.match(new RegExp(`<(?:${tags})\\b[^>]*>(?:</(?:${tags})>)?`, "g")) ?? []).join("\n");
      if (!kept) return json(res, 422, { error: "the draft came back with no usable elements — try saying it differently" });

      const nm = wpSlug(b.name);
      const dir = join(projectDir(id), "scenes");
      await mkdir(dir, { recursive: true });
      const dest = join(dir, `${nm}.html`);
      await writeFile(dest, `${kept}\n`, "utf8");
      return json(res, 200, { ok: true, name: nm, file: dest, body: kept });
    }

    /* Read and write an authored scene body. */
    if (p === "/api/scene" && req.method === "POST") {
      const b = JSON.parse(await text(req));
      const man = await readManifest(projectDir(b.projectId ?? "")).catch(() => null);
      if (!man) return json(res, 404, { error: "pick a project" });
      // wpSlug("") is "untitled", so `!nm` never fired and an unnamed scene saved
      // over any previous one. The raw value is what has to be present.
      if (!String(b.name ?? "").trim()) return json(res, 400, { error: "give the scene a name" });
      const nm = wpSlug(b.name);
      const dir = join(projectDir(b.projectId), "scenes");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${nm}.html`), String(b.body ?? ""), "utf8");
      return json(res, 200, { ok: true, name: nm, file: join(dir, `${nm}.html`) });
    }

    if (p === "/api/scenes") {
      const id = new URL(req.url, "http://x").searchParams.get("project") ?? "";
      const dir = join(projectDir(id), "scenes");
      const names = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".html"));
      const scenes = await Promise.all(
        names.map(async (f) => ({
        name: f.replace(/\.html$/, ""),
        // The path too: a composition references the FILE, so that a scene
        // edited later updates every composition using it.
        file: join(dir, f),
        body: await readFile(join(dir, f), "utf8"),
      })),
      );
      return json(res, 200, { scenes });
    }
    if (p === "/api/compose/catalogue") {
      /*
       * Every colour the brand actually has, not the eight seeds.
       *
       * brand/tokens.json carries the seed hexes, and picking from those offers a
       * dozen swatches of which several are the same colour twice — `tertiary` and
       * `accent` are both #44bb7e, and `primary` and the Academy sub-brand are both
       * #00b871. Optics generates a full ramp from each seed, and those ramps are the
       * palette: nineteen scales with a base and nine steps either side.
       *
       * Read from rolemodel-scales.css rather than restated here, so a scale added to
       * the brand appears in the picker without a second edit — and returned as custom
       * property NAMES rather than hexes, so a colour follows the theme instead of
       * being frozen at whatever it resolved to the day it was picked.
       */
      const scaleCss = await readFile(join(TOOLKIT, "brand/optics/rolemodel-scales.css"), "utf8").catch(() => "");
      const scales = [...new Set([...scaleCss.matchAll(/--op-color-([a-z-]+)-h\s*:/g)].map((x) => x[1]))].sort();


      const recipes = await loadRecipes(TOOLKIT);
      return json(res, 200, {
        components: await readComponentCatalogue(TOOLKIT),
    colors: {
      scales,
      // Optics' own ladder, darkest to lightest. `base` is the seed itself.
      steps: [
        "minus-max", "minus-eight", "minus-seven", "minus-six", "minus-five",
        "minus-four", "minus-three", "minus-two", "minus-one",
        "base",
        "plus-one", "plus-two", "plus-three", "plus-four", "plus-five",
        "plus-six", "plus-seven", "plus-eight", "plus-max",
      ],
    },
        // The path a scene's HTML uses, which is relative to components/.
        // A name, not a path: sceneHtml resolves it against whichever base it is
    // rendering for. A path here was right for a render and 404'd in preview.
    wallpapers: recipes.map((r) => ({ name: r.name, label: r.label })),
        /*
         * The brand pictures, so a scene can contain one.
         *
         * The clay renders have been sitting in brand/imagery/ visible only in the
         * Brand panel — admirable and unusable, because the component set had no way
         * to put a picture on a stage and the builder had no way to name one. Sent as
         * name and file, never a path: rm-image resolves it against the stage's
         * `assets` base, which is the only thing that knows whether this scene is
         * being rendered or previewed.
         */
        imagery: JSON.parse(await readFile(join(TOOLKIT, "brand/imagery/index.json"), "utf8").catch(() => '{"imagery":[]}')).imagery.filter((i) => i.file),
      });
    }

    /*
     * Hand a composition over as a job.
     *
     * Rendering steps a browser frame by frame — a six-second card is 180 seeks and
     * screenshots — so this writes the spec and returns a step the Console streams,
     * the same shape drafting a script uses. Doing it inline would be a request that
     * looks hung for a minute and cannot be watched.
     */
    /*
     * A cut list becomes a document the editor opens.
     *
     * Composing renders: it lays scenes and footage end to end and encodes one new
     * video, which takes minutes and throws the parts away. This does neither. It
     * writes an AxcutDocument that POINTS at the footage already on disk and says
     * which SPAN of each file plays and when — so a cut is instant, reversible, and
     * still the original media at full quality.
     *
     * The trims are the reason this exists. `clipSchema` has carried
     * sourceStartSec/sourceEndSec the whole time and nothing in the pipeline ever
     * set them, so every clip was the whole file and "edit raw footage" had no way
     * to mean anything.
     */
    /*
     * The panel you were on, remembered across a restart.
     *
     * Not localStorage: the app asks the OS for a free port on every launch, so the
     * page's origin changes each start and a browser store keyed to it is
     * unreachable — the same trap the script drafts fell into. A reload inside one
     * session would have worked, which is how that bug survives being tested.
     */
    if (p === "/api/view" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      await setLastView(String(body.view ?? ""));
      return json(res, 200, { ok: true });
    }

    if (p === "/api/cut" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = body.projectId;
      const man = await readManifest(projectDir(id)).catch(() => null);
      if (!man) return json(res, 404, { error: "pick a project" });

      const clips = Array.isArray(body.clips) ? body.clips : [];
      if (!clips.length) return json(res, 400, { error: "add at least one clip" });

      /*
       * Footage is named by its place in the project, not by a path.
       *
       * The catalogue has no absolute path in it — only `rel` — so a browser has
       * none to send, and asking for one means either inventing it there or
       * accepting whatever arrives. Resolving `rel` against the project's own media
       * directory is both the fix and the check: there is nowhere else it can land.
       */
      for (const c of clips) {
        const f = join(mediaDir(id), String(c.rel ?? ""));
        if (!(f === LIB || f.startsWith(LIB + sep))) return json(res, 403, { error: `outside ${LIB}: ${c.rel}` });
        if (!(await stat(f).catch(() => null))) return json(res, 404, { error: `no such footage: ${c.rel}` });
        c.file = f;
      }

      const name = wpSlug(body.name || "cut");
      const outDir = join(projectDir(id), "media", "Renders", name);
      await mkdir(outDir, { recursive: true });

      /*
       * Each title becomes one transparent still, laid over the cut.
       *
       * Rendered here rather than queued as a job: a still is one screenshot, and
       * a job would put a progress log and a "finished" state between somebody
       * typing a title and seeing it. The card is composed at full frame with its
       * own layout, so the overlay is the whole frame and the transparency does
       * the positioning.
       */
      const titles = Array.isArray(body.titles) ? body.titles : [];
      const overlays = [];
      for (const [i, t] of titles.entries()) {
        const text_ = String(t.text ?? "").trim();
        if (!text_) continue;
        const forSec = Number(t.forSec) > 0 ? Number(t.forSec) : 3;
        const esc = (v) => String(v).replace(/"/g, "&quot;");
        const card = [
          `<rm-title at="0" for="${Math.round(forSec * 1000)}"`,
          t.eyebrow ? ` eyebrow="${esc(t.eyebrow)}"` : "",
          ` title="${esc(text_)}"`,
          t.sub ? ` sub="${esc(t.sub)}"` : "",
          "></rm-title>",
        ].join("");
        const png = join(outDir, `title-${i + 1}.png`);
        try {
          await renderStill({ body: card, out: png, atMs: Math.round(forSec * 500) });
        } catch (err) {
          return json(res, 500, { error: `the title would not render: ${String(err.message).slice(0, 200)}` });
        }
        // An opaque card is a rectangle over the footage, not a title on it.
        if (!(await hasAlpha(png))) return json(res, 500, { error: "the title came out opaque — it would hide the video rather than sit on it" });
        overlays.push({ path: png, atSec: Number(t.atSec) || 0, forSec });
      }

      let doc;
      try {
        doc = cutlistToDocument({
          id: `${id}-${name}`,
          title: man.name ? `${man.name} — ${name}` : name,
          createdAt: new Date().toISOString(),
          clips: clips.map((c) => ({
            path: c.file,
            durationSec: Number(c.durationSec) || undefined,
            inSec: Number(c.inSec) || 0,
            outSec: c.outSec == null ? undefined : Number(c.outSec),
            label: c.label || undefined,
          })),
          overlays,
        });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }

      const docPath = join(outDir, `${name}.openscreen`);
      await writeFile(docPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
      /*
       * The cut list is kept beside the document.
       *
       * The document is the output and it is lossy as a source: it has already
       * dropped the zero-length clips and any overlay past the end. Keeping what
       * was actually asked for is the difference between a cut you can reopen and
       * a video you have to rebuild from memory.
       */
      await writeFile(join(outDir, "cutlist.json"), `${JSON.stringify({ name, clips, titles }, null, 2)}\n`, "utf8");

      return json(res, 200, {
        document: docPath,
        out: outDir,
        clips: doc.timeline.clips.length,
        overlays: doc.annotations.length,
        durationSec: doc.timeline.clips.at(-1).timelineEndSec,
      });
    }

    if (p === "/api/compose" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = body.projectId;
      const man = await readManifest(projectDir(id)).catch(() => null);
      if (!man) return json(res, 404, { error: "pick a project" });
      const segments = Array.isArray(body.segments) ? body.segments : [];
      if (!segments.length) return json(res, 400, { error: "add at least one segment" });

      /*
       * Footage is named by its place in the project, not by a path.
       *
       * A catalogue entry has `rel` and no absolute path, so the panel had nothing
       * to put in `seg.path` and sent undefined — which resolved to the working
       * directory and came back 403, making every composition with footage in it
       * fail on a check that looked like a security refusal. Resolving `rel` here is
       * the fix and the check at once.
       */
      for (const seg of segments) {
        if (seg.kind !== "footage") continue;
        const f = seg.rel ? join(mediaDir(id), String(seg.rel)) : resolve(String(seg.path ?? ""));
        if (!(f === LIB || f.startsWith(LIB + sep))) return json(res, 403, { error: `outside ${LIB}: ${seg.rel ?? seg.path}` });
        if (!(await stat(f).catch(() => null))) return json(res, 404, { error: `no such footage: ${seg.rel ?? seg.path}` });
        seg.path = f;
      }

      /*
   * Narration is a file in the library too, and gets the same check as footage.
   * A capture is usually silent, so this is the audio in most compositions.
   */
  let audio = null;
  if (body.audio) {
    audio = resolve(String(body.audio));
    if (!(audio === LIB || audio.startsWith(LIB + sep))) return json(res, 403, { error: `outside ${LIB}: ${body.audio}` });
    if (!(await stat(audio).catch(() => null))) return json(res, 404, { error: `no such audio: ${body.audio}` });
  }

  const name = wpSlug(body.name || "composition");
      const outDir = join(projectDir(id), "media", "Renders", name);
      await mkdir(outDir, { recursive: true });
      const specPath = join(outDir, "composition.json");
      // Kept, not written to a temp file: it is the source the render came from, and
      // the only thing that makes a composition editable again rather than a video.
      await writeFile(specPath, `${JSON.stringify({ name, audio, segments }, null, 2)}\n`, "utf8");

      return json(res, 200, {
        spec: specPath,
        out: outDir,
        step: {
          label: `compose ${name}`,
          project: id,
          bin: "node",
          args: [join(TOOLKIT, "bin", "rm-compose.mjs"), specPath, "--out", outDir],
          cwd: outDir,
        },
      });
    }


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
      /*
       * Install it where the editor looks, in the same request.
       *
       * Saving stopped at the toolkit, so a wallpaper you had just made and were
       * looking at did not exist as far as the editor was concerned — one recipe sat
       * rendered and unreachable that way. The editor's list is generated into the
       * fork, so writing the render alone was never going to be enough.
       */
      const fork = resolve(TOOLKIT, "..", "openscreen");
      const install = await installWallpapersIntoFork({ recipes: all, out: dir, fork }).catch((err) => ({
        installed: 0,
        reason: String(err?.message ?? err),
      }));
      return json(res, 200, {
        ok: true,
        name: recipe.name,
        file: join(dir, `${recipe.name}.jpg`),
        count: all.length,
        installed: install.installed,
        // The manifest is compiled into the app, so a running editor is still showing
        // the old list. Saying so is the difference between "it is broken" and "it is
        // one rebuild away".
        note: install.reason
          ? `saved, but not installed into the editor: ${install.reason}`
          : "installed into the editor — rebuild OpenScreen to see it in the picker",
      });
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
 * The request body as bytes.
 *
 * text() concatenates onto a string, which corrupts anything that is not UTF-8 —
 * dictated audio arrives as opus in a webm container and has to survive intact.
 * Capped, because an unbounded upload into memory is a way to take the Studio down
 * from a page it is serving.
 */
function bytes(req, limit = 64 * 1024 * 1024) {
  return new Promise((res2, rej) => {
    const chunks = [];
    let size = 0;
    req.on("data", (d) => {
      size += d.length;
      if (size > limit) {
        rej(new Error(`upload is larger than ${Math.round(limit / 1024 / 1024)}MB`));
        req.destroy();
        return;
      }
      chunks.push(d);
    });
    req.on("end", () => res2(Buffer.concat(chunks)));
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
/*
 * The recorder's audio and cursor flags, from whatever the panel sent.
 *
 * Shared by both record paths because both end up at `openscreen record` — the
 * scripted one goes through `rm-demo capture`, which forwards these verbatim. The
 * panel used to offer three of the recorder's nine options, so a capture that
 * needed a microphone or the system cursor meant abandoning the UI and typing the
 * command out.
 */
const CURSOR_MODES = ["editable-overlay", "system"];

function recorderArgs(body) {
	const out = [];
	// --mic-device implies --mic, so passing both is redundant, and passing the
	// device without the flag reads as a mistake rather than a shorthand.
	const device = String(body?.micDevice ?? "").trim();
	if (device) out.push("--mic-device", device);
	else if (body?.mic) out.push("--mic");
	if (body?.systemAudio) out.push("--system-audio");
	const cursor = String(body?.cursor ?? "").trim();
	if (cursor && CURSOR_MODES.includes(cursor)) out.push("--cursor", cursor);
	return out;
}

/*
 * Attaching to a browser already on screen, rather than launching one.
 *
 * The reason this exists: a real demo is of an app that is already open and signed
 * in. A launched Chromium is blank and signed into nothing, so a script that clicks
 * anything real fails on its first step. Attaching drives the window the person is
 * already looking at — and then `--window` is how you name that window for the
 * recorder rather than a contradiction.
 */
function attachArgs(body) {
	if (!body?.attach) return [];
	const out = ["--attach"];
	const cdp = String(body.cdp ?? "").trim();
	if (cdp) out.push("--cdp", cdp);
	const page = String(body.page ?? "").trim();
	if (page) out.push("--page", page);
	return out;
}

/** The browser half, which only means anything when a script is driving. */
function driverArgs(body) {
	const out = [];
	const url = String(body?.url ?? "").trim();
	if (url) out.push("--url", url);
	const num = (v, lo, hi) => {
		const n = Number(v);
		return Number.isFinite(n) && n >= lo && n <= hi ? String(Math.round(n)) : null;
	};
	const w = num(body?.width, 320, 7680);
	const h = num(body?.height, 240, 4320);
	if (w) out.push("--width", w);
	if (h) out.push("--height", h);
	if (body?.headless) out.push("--headless");
	return out;
}

/*
 * The vendored faces, and the @font-face that binds them to the names
 * studio.html has been asking for since it was written.
 *
 * DM Sans arrives as the two subsets Google publishes rather than one file, and the
 * unicode-range on each is Google's own — so a page of plain English never fetches
 * the second. Same set the fork self-hosts, for the same reason.
 */
const FONT_FILES = new Set([
	"DMSans-Variable-latin.woff2",
	"DMSans-Variable-latin-ext.woff2",
	"GeistMono-Variable.woff2",
	"hgi-stroke-rounded.woff2",
]);

const FONT_CSS = `/* Served by bin/rm-studio.mjs from brand/fonts/. Vendored, not linked:
 * the Studio is hosted by a desktop app that has to start with no network. */
@font-face {
	font-family: "DM Sans";
	src: url("/fonts/DMSans-Variable-latin.woff2") format("woff2");
	font-weight: 100 1000;
	font-style: normal;
	font-display: swap;
	unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC,
		U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215,
		U+FEFF, U+FFFD;
}
@font-face {
	font-family: "DM Sans";
	src: url("/fonts/DMSans-Variable-latin-ext.woff2") format("woff2");
	font-weight: 100 1000;
	font-style: normal;
	font-display: swap;
	unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304,
		U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB,
		U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF;
}
@font-face {
	font-family: "Geist Mono";
	src: url("/fonts/GeistMono-Variable.woff2") format("woff2");
	font-weight: 100 900;
	font-style: normal;
	font-display: swap;
}
`;

/**
 * Why an `npx --no-install hyperframes …` probe failed, in words that are true.
 *
 * Every probe here runs with `--no-install` so a page load can never trigger a
 * download. The failure that actually happens is not the one the notes used to
 * claim. npx resolves `hyperframes` to whatever the registry calls latest and then
 * asks the cache for that exact version — so the day upstream publishes a release,
 * every probe starts failing even though a perfectly good copy is cached. Observed:
 * 0.8.10 cached, 0.8.12 resolved, and the Voice page reporting "not cached yet".
 *
 * So this reads what npm said rather than guessing. The version-mismatch case is
 * worth naming on its own because it is the common one and it resolves itself:
 * synthesising uses `--yes`, which fetches.
 */
function npxWhy(r) {
	const err = `${r.err ?? ""}${r.out ?? ""}`;
	const missing = /missing packages and no YES option:\s*\["([^"]+)"\]/.exec(err);
	if (missing) {
		return `hyperframes ${missing[1].split("@").pop()} is not in the npx cache — a newer release than the copy on this machine`;
	}
	if (/command not found|ENOENT/i.test(err)) return "npx is not on PATH";
	const first = err.split("\n").map((l) => l.trim()).filter((l) => l && !/^\(node:\d+\)|^\(Use `node/.test(l))[0];
	return first ? `hyperframes could not be run: ${first.slice(0, 160)}` : "hyperframes could not be run";
}

/*
 * Where a draft lives: beside the config, keyed by project.
 *
 * A project id is used as a filename, so it is checked rather than trusted — the
 * ids this server mints are slugs, and anything else is a request trying to write
 * somewhere it should not.
 */
const DRAFT_DIR = join(STATE_DIR, "drafts");
const draftPath = (id) => (/^[a-z0-9][a-z0-9._-]*$/i.test(id) ? join(DRAFT_DIR, `${id}.json`) : null);

async function readDraft(id) {
	const file = draftPath(id);
	if (!file) return [];
	const raw = await readFile(file, "utf8").catch(() => null);
	if (!raw) return [];
	try {
		const rows = JSON.parse(raw);
		return Array.isArray(rows) ? rows.filter((r) => r && typeof r.verb === "string") : [];
	} catch {
		// A draft that will not parse is a draft nobody can use. Say nothing and
		// start clean rather than failing the page that asked for it.
		return [];
	}
}

async function writeDraft(id, rows) {
	const file = draftPath(id);
	if (!file) throw new Error("that is not a project id");
	await mkdir(DRAFT_DIR, { recursive: true });
	// An empty list means "there is no draft", not "write an empty one".
	if (!Array.isArray(rows) || !rows.length) {
		await rm(file, { force: true });
		return null;
	}
	await writeFile(file, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
	return file;
}

/**
 * A step that runs one of this toolkit's own binaries.
 *
 * Never by bare name. `rm-demo` is newer than some installs, so on a machine whose
 * Homebrew copy predates it the name is simply not on PATH and every scripted
 * capture died with "rm-demo: not found on PATH" — a real break, reported as one,
 * and nothing about the request was wrong.
 *
 * We are the toolkit, so we know where our scripts are: `node <toolkit>/bin/x.mjs`
 * works from a checkout and from libexec, needs nothing linked, and cannot be
 * shadowed by something else called rm-demo. The job runner allows `node` for
 * exactly this and resolves the path itself, so nothing from a request reaches argv.
 *
 * PATH is still the fallback, for a binary that is not ours to ship.
 */
function ownStep(name, args, extra = {}) {
	const script = join(TOOLKIT, "bin", `${name}.mjs`);
	return existsSync(script)
		? { bin: "node", args: [script, ...args], ...extra }
		: { bin: name, args, ...extra };
}

/*
 * What each picker means by a file it can take.
 *
 * Lists rather than a regex so adding a container is one word, and the knowledge of
 * which extension is a video lives here rather than in each picker.
 */
const VIDEO_EXT = new Set([".mp4", ".webm", ".mov", ".m4v", ".mkv", ".avi"]);
const AUDIO_EXT = new Set([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".aiff"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".tiff", ".bmp", ".svg"]);
const SUBS_EXT = new Set([".srt", ".vtt"]);

/*
 * The places footage actually lives, so nobody walks there from $HOME one click at
 * a time.
 *
 * Resolved here and filtered to what exists, because a chip for a Movies folder
 * that was never created is a chip that 404s. Anything outside $HOME is dropped —
 * /api/browse refuses to read there, so offering it would be offering a dead end.
 */
async function browsePlaces(root) {
	const candidates = [
		["Home", root],
		["Desktop", join(root, "Desktop")],
		["Downloads", join(root, "Downloads")],
		["Movies", join(root, "Movies")],
		["Pictures", join(root, "Pictures")],
		["Documents", join(root, "Documents")],
		["Library", LIB],
	];
	const out = [];
	for (const [name, path] of candidates) {
		if (!path) continue;
		if (path !== root && !path.startsWith(root + sep)) continue;
		const st = await stat(path).catch(() => null);
		if (st?.isDirectory()) out.push({ name, path });
	}
	return out;
}

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
