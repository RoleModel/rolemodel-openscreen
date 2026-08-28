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
import { copyFile, cp, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { installWallpapersIntoFork } from "../lib/wallpaper-install.mjs";
import { readComponentCatalogue, sceneHtml } from "../lib/compose.mjs";
import { AGENTS, agentStep } from "../lib/agents.mjs";
import { cutlistToDocument } from "../lib/cutlist.mjs";
import { FIRST_QUESTION, buildTurnPrompt, interviewState, parseTurn, planToBrief, readTurn } from "../lib/interview.mjs";
import { buildPrompt as buildPaperEditPrompt, coverage as paperEditCoverage, parseSelection, selectionToCutlist, validateSelection } from "../lib/paper-edit.mjs";
import { SUPABASE_SYNC, SYNCS, applyToBoard, readBoard, readHistory, syncBoard, syncFor, writeBoard } from "../lib/board-store.mjs";
import { createStudioSkill, fetchStudioSkill, fetchStudioSkills, updateStudioSkill } from "../lib/supabase.mjs";
import { NODE_GAP_X, NODE_WIDTH, connect as graphConnect, disconnect as graphDisconnect, idFor as graphIdFor, moveNode, removeNode } from "../lib/board-graph.mjs";
import {
	RATINGS,
	boardProgress,
	graphFor,
	boardToDocument,
	chosenTake,
	slotsFromBrief,
	takeId as takeIdFor,
	toCutlist,
} from "../lib/storyboard.mjs";
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
import { ROOT as TOOLKIT, loadPreset, stablePath } from "../lib/theme.mjs";
import {
  actions as demoActions,
  describe as describeDemo,
  parseDemo,
  settings as demoSettings,
  speakerSections,
} from "../lib/demo-script.mjs";
import { openFrame, shareVideo } from "../lib/openframe.mjs";
import {
	STATE_DIR,
	agentChoice,
	currentProject,
	reviewerName,
	setReviewerName,
	setSupabaseSettings,
	supabaseProblem,
	supabaseSettings,
	setSyncChoice,
	syncChoice,
	docsUrl,
	lastView,
	openFrameSettings,
	setAgentChoice,
	setCurrentProject,
	setLastView,
	setOpenFrameSettings,
} from "../lib/settings.mjs";
import { loadRecipes, saveRecipes } from "../lib/make-wallpapers.mjs";
import { css as wpCSS, normalize as normalizeRecipe, slug as wpSlug } from "../lib/wallpaper.mjs";
import * as jobs from "../lib/jobs.mjs";
import { isReady as voiceReady, venvDir } from "../lib/voice-setup.mjs";
import { stageRenderAssets } from "../lib/render-assets.mjs";

// Absolute binary paths are permitted only inside the install. See lib/jobs.mjs.
jobs.setTrustedRoot(TOOLKIT);
jobs.setNodeExecutable(process.execPath);
// bin/shims ahead of PATH for everything we spawn. openscreen is the reason:
// launched through the cask's symlink, Electron cannot find its helper apps and
// every command that forks dies with "Unable to find helper app".
jobs.addPath(join(TOOLKIT, "bin", "shims"));
// Finder-launched apps do not inherit the interactive shell's Homebrew PATH.
// Keep these conventional install locations available to helper scripts such as
// rm-transcribe, which in turn starts ffmpeg and whisper-cli.
jobs.addPath("/usr/local/bin");
jobs.addPath("/opt/homebrew/bin");
// The Studio process is already running under Node, but Finder/Electron can
// launch it with a PATH that omits that same executable. Own toolkit jobs are
// deliberately `node <toolkit>/bin/*.mjs`; make the Node that started Studio
// available to those background jobs instead of requiring a separately linked
// `node` command in the user's shell.
jobs.addPath(dirname(process.execPath));

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
 * `pnpm run dev` passes --watch. It is also on by default whenever the toolkit is
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

/*
 * Brand assets somebody added, kept in the library rather than in the toolkit.
 *
 * Not brand/imagery/: `pnpm run imagery` rewrites that index from its own WANTED
 * list, so an uploaded entry would be erased on the next run and would fail
 * `imagery:check` in the meantime. And TOOLKIT is the installed package — on a
 * `brew upgrade` it is replaced, which would take a client's logo with it.
 *
 * The library is where the person's own material already lives, it survives an
 * upgrade, and it is the thing they would think to back up.
 */
const ADDED_DIR = join(LIB, "Brand");
const ADDED_INDEX = join(ADDED_DIR, "index.json");

const readAdded = async () =>
	JSON.parse(await readFile(ADDED_INDEX, "utf8").catch(() => '{"added":[]}')).added ?? [];

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
/* Project-to-storage copies are quiet background work, not Console jobs. */
const projectTransfers = new Map();
const projectDir = (id) => join(LIB, id);
const mediaDir = (id) => join(projectDir(id), "media");

/*
 * HyperFrames Studio is a second editor, not an export target.
 *
 * Each Make run gets its own folder under media/Renders/.  That folder is the
 * editable source project Claude writes and HyperFrames owns; the MP4 beside it
 * is only one render of that source.  Keep one preview server per project's
 * Renders folder so moving between two generated videos reuses the same Studio
 * instance and preserves its normal filesystem autosave/version history.
 */
const hyperframesStudios = new Map();
const HYPERFRAMES_VIDEO_EXT = new Set([".mp4", ".mov", ".m4v", ".webm"]);

async function freeLocalPort() {
  const probe = createServer();
  return new Promise((done, fail) => {
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close((error) => (error ? fail(error) : done(port)));
    });
  });
}

async function hyperframesProjects(id) {
  const renders = join(mediaDir(id), "Renders");
  const entries = await readdir(renders, { withFileTypes: true }).catch(() => []);
  const projects = await Promise.all(
    entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      const dir = join(renders, entry.name);
      const index = join(dir, "index.html");
      const info = await stat(index).catch(() => null);
      if (!info?.isFile()) return null;
      const brief = await readFile(join(dir, "brief.md"), "utf8").catch(() => "");
      const title = brief.match(/^#\s+(.+)$/m)?.[1]?.trim() || entry.name;
      const files = await readdir(dir, { withFileTypes: true }).catch(() => []);
      const videoRenders = await Promise.all(
        files
          .filter((file) => file.isFile() && HYPERFRAMES_VIDEO_EXT.has(extname(file.name).toLowerCase()))
          .map(async (file) => {
            const fileInfo = await stat(join(dir, file.name)).catch(() => null);
            return fileInfo?.isFile()
              ? { name: file.name, rel: `Renders/${entry.name}/${file.name}`, bytes: fileInfo.size, mtime: fileInfo.mtime.toISOString() }
              : null;
          }),
      );
      return {
        folder: entry.name,
        title,
        updatedAt: info.mtime.toISOString(),
        renders: videoRenders.filter(Boolean).sort((a, b) => b.mtime.localeCompare(a.mtime)),
      };
    }),
  );
  return projects.filter(Boolean).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function openHyperframesStudio(id, folder) {
  const renders = resolve(mediaDir(id), "Renders");
  const candidate = resolve(renders, basename(String(folder ?? "")));
  if (!candidate.startsWith(renders + sep) || !(await stat(join(candidate, "index.html")).catch(() => null))?.isFile()) {
    throw new Error("that editable HyperFrames project is not in this project")
  }

  const root = dirname(candidate);
  let studio = hyperframesStudios.get(root);
  if (!studio?.child) {
    const port = await freeLocalPort();
    const child = spawn("npx", ["--yes", "hyperframes", "preview", "--port", String(port)], {
      cwd: root,
      env: jobs.childEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    studio = { child, port, state: "starting", error: null, output: [] };
    hyperframesStudios.set(root, studio);
    const note = (data) => {
      const line = String(data).trim();
      if (!line) return;
      studio.output.push(line);
      if (studio.output.length > 12) studio.output.shift();
      if (/listening|localhost|studio/i.test(line)) studio.state = "ready";
    };
    child.stdout?.on("data", note);
    child.stderr?.on("data", note);
    child.on("error", (error) => {
      studio.state = "failed";
      studio.error = error.code === "ENOENT" ? "npx is not available to start HyperFrames Studio" : error.message;
      studio.child = null;
    });
    child.on("close", (code) => {
      if (studio.state !== "failed") {
        studio.state = "stopped";
        studio.error = code === 0 ? "HyperFrames Studio stopped." : `HyperFrames Studio stopped (${code ?? "unknown"}).`;
      }
      studio.child = null;
    });
  }

  return {
    folder: basename(candidate),
    state: studio.state,
    error: studio.error,
    url: `http://localhost:${studio.port}/#project/${encodeURIComponent(basename(candidate))}`,
  };
}
/*
 * Captures made by OpenScreen before Studio knew which project was active.
 *
 * These are deliberately explicit directories rather than a search across a
 * person's home folder. The picker should make our own recent captures easy to
 * adopt, not become a surprising file browser. New HUD captures go directly to
 * the active project; this is the bridge for captures that already exist here.
 */
const OPENSCREEN_RECORDING_DIRS = [...new Set([
  join(homedir(), "Library", "Application Support", "openscreen", "recordings"),
  join(homedir(), "Library", "Application Support", "Openscreen", "recordings"),
])];
const OPENSCREEN_VIDEO_EXT = new Set([".mp4", ".webm", ".mov", ".m4v", ".mkv", ".avi"]);
const isOpenScreenRecording = (file) => {
  const absolute = resolve(file);
  return OPENSCREEN_RECORDING_DIRS.some((dir) => dirname(absolute) === resolve(dir));
};
const recentOpenScreenRecordings = async () => {
  const groups = await Promise.all(OPENSCREEN_RECORDING_DIRS.map(async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    return Promise.all(entries
      .filter((entry) => entry.isFile() && OPENSCREEN_VIDEO_EXT.has(extname(entry.name).toLowerCase()))
      .map(async (entry) => {
        const file = join(dir, entry.name);
        const info = await stat(file).catch(() => null);
        return info?.isFile() ? {
          file,
          name: entry.name,
          bytes: info.size,
          modifiedAt: info.mtime.toISOString(),
        } : null;
      }));
  }));
  // macOS volumes are usually case-insensitive, so the legacy `openscreen`
  // and title-cased `Openscreen` locations can be the same folder. Collapse
  // those aliases before showing the picker.
  const unique = new Map();
  for (const recording of groups.flat().filter(Boolean)) {
    unique.set(`${recording.name}\u0000${recording.bytes}\u0000${recording.modifiedAt}`, recording);
  }
  return [...unique.values()].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, 30);
};
const paperEditDir = (id) => join(projectDir(id), "paper-edits");
const interviewDir = (id) => join(projectDir(id), "interview");
const interviewPath = (id) => join(interviewDir(id), "interview.json");
const interviewReplyPath = (id) => join(interviewDir(id), "next-turn.json");
const WORKFLOW_FILE = "video-workflow.json";
const WORKFLOW_STAGES = ["plan", "script", "canvas", "record", "assembly", "edit", "review"];
const workflowPath = (id) => join(projectDir(id), WORKFLOW_FILE);

const freshWorkflow = () => ({
  version: 1,
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  currentStage: "plan",
  stages: {},
  events: [],
});

/** The project-level thread joining its otherwise separate working files together. */
async function readWorkflow(id) {
  const raw = await readFile(workflowPath(id), "utf8").catch(() => null);
  if (!raw) return null;
  try {
    const saved = JSON.parse(raw);
    return {
      ...freshWorkflow(),
      ...saved,
      currentStage: WORKFLOW_STAGES.includes(saved?.currentStage) ? saved.currentStage : "plan",
      stages: saved?.stages && typeof saved.stages === "object" ? saved.stages : {},
      events: Array.isArray(saved?.events) ? saved.events.slice(-100) : [],
    };
  } catch {
    throw new Error("the saved video progress is not readable");
  }
}

/** Atomic, because this is the one file a restart uses to know where work belongs. */
async function writeWorkflow(id, state) {
  const path = workflowPath(id);
  const next = { ...state, version: 1, updatedAt: new Date().toISOString() };
  const tmp = `${path}.${randomUUID()}.tmp`;
  await mkdir(projectDir(id), { recursive: true });
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await rename(tmp, path);
  return next;
}

async function markWorkflowStage(id, stage) {
  if (!WORKFLOW_STAGES.includes(stage)) throw new Error("that is not a video stage");
  const now = new Date().toISOString();
  const workflow = (await readWorkflow(id)) ?? freshWorkflow();
  const prior = workflow.stages[stage] ?? {};
  workflow.currentStage = stage;
  workflow.stages[stage] = { ...prior, startedAt: prior.startedAt ?? now, openedAt: now };
  workflow.events = [...workflow.events, { stage, action: "opened", at: now }].slice(-100);
  return writeWorkflow(id, workflow);
}

/* Start over is recoverable: creative working files move aside, raw media stays put. */
async function restartWorkflow(id) {
  const dir = projectDir(id);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archive = join(dir, "archive", "restarts", stamp);
  const work = ["interview", "scripts", "scenes", "paper-edits", "storyboard.json", "history.jsonl", WORKFLOW_FILE];
  const moved = [];
  for (const name of work) {
    const source = join(dir, name);
    if (!(await lstat(source).catch(() => null))) continue;
    await mkdir(archive, { recursive: true });
    await rename(source, join(archive, name));
    moved.push(name);
  }
  const workflow = await writeWorkflow(id, freshWorkflow());
  return { workflow, moved, archive: moved.length ? relative(dir, archive) : null };
}

/*
 * Studio skills belong to the toolkit, not to an individual video project.
 * Claude may be working from a library child folder, so pass this directory as
 * an allowed location and explicitly ask it to read the relevant instructions.
 */
const GLOBAL_SKILL_DIR = join(TOOLKIT, "skill");
// Skills installed through Studio belong in the signed-in team's database. This
// cache is only how Claude gets a real directory of scripts/references to read;
// it intentionally lives outside the Git checkout.
const SHARED_SKILL_DIR = join(STATE_DIR, "shared-skills");
const SHARED_SKILL_LIMIT = 8 * 1024 * 1024;
/*
 * Standard is an optional neighboring checkout. Studio must keep working in a
 * standalone install, so this is deliberately an allowed source, never a
 * required dependency or a symlink written into somebody's home folder.
 */
const STANDARD_ROOT = process.env.RM_STANDARD || join(dirname(dirname(TOOLKIT)), "standard");
const STANDARD_HYPERFRAMES_SKILL = join(STANDARD_ROOT, "marketing", "skills", "hyperframes-helper", "SKILL.md");
const standardAvailable = () => existsSync(STANDARD_HYPERFRAMES_SKILL);
const globalSkillMeta = (source, key) => String(source).match(new RegExp(`^${key}:\\s*['\"]?(.+?)['\"]?\\s*$`, "mi"))?.[1]?.trim() ?? null;
const globalSkillId = (value) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(value) ? value : null;

function safeZipEntry(entry) {
  const path = String(entry ?? "").replace(/\/$/, "");
  if (!path || path.startsWith("/") || path.includes("\\")) return null;
  return path.split("/").some((part) => !part || part === "." || part === "..") ? null : path;
}

/** Check an uploaded zip before it becomes a shared skill bundle. */
async function inspectGlobalSkillZip(archive) {
  const scratch = join(TOOLKIT, `.skill-upload-${randomUUID()}`);
  const zip = join(scratch, "upload.zip");
  const extracted = join(scratch, "unpacked");
  try {
    await mkdir(scratch, { recursive: true });
    await writeFile(zip, archive);
    const listing = await capture("unzip", ["-Z1", zip]);
    if (!listing.ok) throw new Error("that file is not a readable skill zip");
    const entries = listing.out.split(/\r?\n/).filter(Boolean);
    if (!entries.length || entries.some((entry) => !safeZipEntry(entry))) throw new Error("the skill zip contains an unsafe file path");
    const skillFiles = entries.filter((entry) => entry === "SKILL.md" || entry.endsWith("/SKILL.md"));
    if (!skillFiles.length) throw new Error("the zip needs at least one SKILL.md file");

    const unpack = await capture("unzip", ["-qq", zip, "-d", extracted]);
    if (!unpack.ok) throw new Error("the skill zip could not be unpacked");
    const root = resolve(extracted);
    for (const entry of entries) {
      const safe = safeZipEntry(entry);
      if (!safe) continue;
      const unpacked = resolve(extracted, safe);
      if (!unpacked.startsWith(`${root}${sep}`) && unpacked !== root) throw new Error("the skill zip points outside its folder");
      if ((await lstat(unpacked)).isSymbolicLink()) throw new Error("skill zips cannot contain symbolic links");
    }
    const found = [];
    for (const entry of skillFiles) {
      const safe = safeZipEntry(entry);
      if (!safe) continue;
      const sourceFile = resolve(extracted, safe);
      if (!sourceFile.startsWith(`${root}${sep}`) && sourceFile !== join(root, "SKILL.md")) throw new Error("the skill zip points outside its folder");
      const source = await readFile(sourceFile, "utf8").catch(() => null);
      const declaredName = source ? globalSkillMeta(source, "name") : null;
      const name = globalSkillId(wpSlug(declaredName ?? "").slice(0, 64));
      if (!name) throw new Error(`${safe} needs a simple name in its front matter`);
      const sourceDir = dirname(sourceFile);
      const sourceStat = await lstat(sourceDir);
      if (sourceStat.isSymbolicLink()) throw new Error("skill folders cannot be symbolic links");
      found.push({
        slug: name,
        name: declaredName ?? name,
        description: globalSkillMeta(source, "description"),
        entryPath: safe,
        skillMd: source,
      });
    }
    const duplicates = found.filter((skill, index) => found.findIndex((other) => other.slug === skill.slug) !== index).map(({ slug }) => slug);
    if (duplicates.length) throw new Error(`the zip declares ${[...new Set(duplicates)].join(", ")} more than once`);
    return found;
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

async function materializeSharedSkill(skill) {
  const slug = globalSkillId(skill?.slug);
  const entry = safeZipEntry(skill?.entry_path);
  if (!slug || !entry || basename(entry) !== "SKILL.md") throw new Error("that shared skill has an invalid bundle entry");
  const bundle = Buffer.from(String(skill.bundle_base64 ?? ""), "base64");
  if (!bundle.length || bundle.length > SHARED_SKILL_LIMIT) throw new Error(`${slug} has no readable shared skill bundle`);
  const scratch = join(STATE_DIR, `.shared-skill-${randomUUID()}`);
  const zip = join(scratch, "skill.zip");
  const extracted = join(scratch, "unpacked");
  const target = join(SHARED_SKILL_DIR, slug);
  try {
    await mkdir(scratch, { recursive: true });
    await writeFile(zip, bundle);
    const listing = await capture("unzip", ["-Z1", zip]);
    const entries = listing.out.split(/\r?\n/).filter(Boolean);
    if (!listing.ok || !entries.length || entries.some((path) => !safeZipEntry(path))) throw new Error(`${slug} has an unsafe shared skill bundle`);
    const unpack = await capture("unzip", ["-qq", zip, "-d", extracted]);
    if (!unpack.ok) throw new Error(`${slug} could not be unpacked`);
    const root = resolve(extracted);
    const source = resolve(extracted, dirname(entry));
    if (!source.startsWith(`${root}${sep}`) && source !== root) throw new Error(`${slug} points outside its skill bundle`);
    await rm(target, { recursive: true, force: true });
    await mkdir(SHARED_SKILL_DIR, { recursive: true });
    await cp(source, target, { recursive: true });
    await writeFile(join(target, "SKILL.md"), String(skill.skill_md ?? ""), "utf8");
    await writeFile(join(target, ".studio-skill.json"), `${JSON.stringify({ slug, version: skill.version ?? 1 })}\n`, "utf8");
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

async function sharedSkillClient() {
  const { cfg, token } = await SUPABASE_SYNC.token();
  const userId = cfg.session?.user?.id;
  if (!userId) throw new Error("sign in to share and edit skills");
  return { url: cfg.url, key: cfg.key, token, userId };
}

async function syncSharedSkills() {
  const client = await sharedSkillClient();
  const listed = await fetchStudioSkills(client);
  for (const item of listed) {
    const full = await fetchStudioSkill({ ...client, slug: item.slug });
    if (full) await materializeSharedSkill(full);
  }
  return listed;
}

async function studioSkillsIn(dir, source) {
  const files = [];
  const visit = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const file = join(dir, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && entry.name === "SKILL.md") files.push(file);
    }
  };
  await visit(dir);
  return (await Promise.all(files.map(async (file) => {
    const body = await readFile(file, "utf8");
    const slug = globalSkillId(basename(dirname(file))) ?? wpSlug(globalSkillMeta(body, "name") ?? "");
    return {
      name: globalSkillMeta(body, "name") || basename(dirname(file)),
      description: globalSkillMeta(body, "description"),
      slug,
      file,
      path: relative(TOOLKIT, file),
      source,
    };
  }))).sort((a, b) => a.path.localeCompare(b.path));
}

async function globalStudioSkills() {
  const local = await studioSkillsIn(GLOBAL_SKILL_DIR, "local");
  const shared = await studioSkillsIn(SHARED_SKILL_DIR, "shared");
  const bySlug = new Map(local.map((skill) => [skill.slug, skill]));
  for (const skill of shared) bySlug.set(skill.slug, skill);
  return [...bySlug.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function installSharedSkillZip(archive, { replace = false } = {}) {
  if (archive.length > SHARED_SKILL_LIMIT) throw new Error("shared skill zips must be 8 MB or smaller");
  const client = await sharedSkillClient();
  const found = await inspectGlobalSkillZip(archive);
  const bundle = archive.toString("base64");
  const installed = [];
  for (const item of found) {
    const existing = await fetchStudioSkill({ ...client, slug: item.slug });
    if (existing && !replace) {
      const error = new Error(`A shared skill already exists: ${item.slug}. Replace it?`);
      error.code = "SKILL_EXISTS";
      error.skills = [item.slug];
      throw error;
    }
    const next = {
      slug: item.slug,
      name: item.name,
      description: item.description,
      skill_md: item.skillMd,
      bundle_base64: bundle,
      entry_path: item.entryPath,
      version: Number(existing?.version ?? 0) + 1,
    };
    const saved = existing
      ? await updateStudioSkill({ ...client, slug: item.slug, skill: next })
      : await createStudioSkill({ ...client, skill: next });
    if (!saved) throw new Error(`Studio could not save ${item.slug}`);
    await materializeSharedSkill(saved);
    installed.push(item.slug);
  }
  return installed;
}

async function updateSharedSkillText(slug, skillMd) {
  const client = await sharedSkillClient();
  const current = await fetchStudioSkill({ ...client, slug });
  if (!current) throw new Error("that skill is not in the shared library yet");
  const saved = await updateStudioSkill({
    ...client,
    slug,
    skill: { skill_md: String(skillMd), version: Number(current.version ?? 0) + 1 },
  });
  if (!saved) throw new Error("Studio could not save that shared skill");
  await materializeSharedSkill(saved);
  return saved;
}

async function archiveLocalSkill(file) {
  const scratch = join(STATE_DIR, `.publish-skill-${randomUUID()}`);
  const archive = join(scratch, "skill.zip");
  const dir = dirname(file);
  const rootInstruction = dir === GLOBAL_SKILL_DIR;
  try {
    await mkdir(scratch, { recursive: true });
    const result = await new Promise((done) => {
      const args = rootInstruction ? ["-q", "-j", archive, file] : ["-q", "-r", archive, basename(dir)];
      const child = spawn("zip", args, { cwd: rootInstruction ? undefined : dirname(dir), stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      child.stderr.on("data", (chunk) => {
        err += String(chunk);
      });
      child.on("error", (error) => done({ ok: false, error: error.message }));
      child.on("close", (code) => done({ ok: code === 0, error: err.trim() }));
    });
    if (!result.ok) throw new Error(result.error || "Studio could not package that bundled skill");
    return readFile(archive);
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

async function publishLocalStudioSkill(slug, { replace = false } = {}) {
  const local = (await studioSkillsIn(GLOBAL_SKILL_DIR, "local")).find((skill) => skill.slug === slug);
  if (!local) throw new Error("that bundled skill was not found");
  const archive = await archiveLocalSkill(local.file);
  return installSharedSkillZip(archive, { replace });
}

async function globalSkillDirection() {
  // A successful sign-in is enough to refresh the cache on the next Claude job.
  // Offline work keeps using the last materialized copy and bundled skills.
  await syncSharedSkills().catch(() => {});
  const skills = await globalStudioSkills();
  return [
    "",
    "RoleModel Studio's global skills apply to this work. Before starting, read and follow the relevant SKILL.md file(s):",
    ...skills.map((skill) => `- ${skill.name}: ${skill.file}`),
    ...(standardAvailable()
      ? [
          "",
          "The optional Standard checkout is available. For a HyperFrames composition, also read:",
          `- ${STANDARD_HYPERFRAMES_SKILL}`,
        ]
      : []),
  ].join("\n");
}

const studioAgentStep = async ({ prompt, cwd, label }) => agentStep(await agentChoice(), {
  prompt,
  cwd,
  label,
  additionalDirectories: [GLOBAL_SKILL_DIR, SHARED_SKILL_DIR, ...(standardAvailable() ? [STANDARD_ROOT] : [])],
});

/*
 * A paper edit belongs to one source recording.  The filename is derived from
 * its project-relative path instead of the display name, so two folders can
 * each hold a `take.mp4` without sharing a transcript by accident.
 */
const paperEditPath = (id, rel) => join(paperEditDir(id), `${Buffer.from(String(rel)).toString("base64url")}.json`);
const paperEditSelectionPath = (id, rel) => join(paperEditDir(id), `${Buffer.from(String(rel)).toString("base64url")}.selection.json`);
const paperEditTranscriptPath = (id, rel) => join(paperEditDir(id), `${Buffer.from(String(rel)).toString("base64url")}.vtt`);

async function renameMediaReferences(id, oldRel, nextRel, oldPath, nextPath) {
  const oldKey = Buffer.from(oldRel).toString("base64url");
  const nextKey = Buffer.from(nextRel).toString("base64url");
  const edits = paperEditDir(id);
  for (const suffix of [".json", ".selection.json", ".vtt", ".prompt.txt"]) {
    const from = join(edits, `${oldKey}${suffix}`);
    const to = join(edits, `${nextKey}${suffix}`);
    if (await stat(from).catch(() => null)) await rename(from, to).catch(() => {});
  }
  const oldFrames = join(multiAssemblyDir(id), "visual-beats", oldKey);
  const nextFrames = join(multiAssemblyDir(id), "visual-beats", nextKey);
  if (await stat(oldFrames).catch(() => null)) await rename(oldFrames, nextFrames).catch(() => {});

  const textExtensions = new Set([".json", ".md", ".txt", ".edl", ".vtt"]);
  const project = projectDir(id);
  const replace = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === "media" || entry.name === "archive") continue;
      const file = join(dir, entry.name);
      if (entry.isDirectory()) {
        await replace(file);
        continue;
      }
      if (!entry.isFile() || !textExtensions.has(extname(entry.name).toLowerCase())) continue;
      const raw = await readFile(file, "utf8").catch(() => null);
      if (raw == null || (!raw.includes(oldRel) && !raw.includes(oldPath))) continue;
      await writeFile(file, raw.replaceAll(oldRel, nextRel).replaceAll(oldPath, nextPath), "utf8");
    }
  };
  await replace(project);
}

const paperEditMedia = async (id, rel) => {
  const safeRel = String(rel ?? "");
  const root = resolve(mediaDir(id));
  const file = resolve(root, safeRel);
  if (!safeRel || !(file === root || file.startsWith(root + sep))) throw new Error("that recording is outside this project");
  if (!(await stat(file).catch(() => null))) throw new Error("that recording is not in this project");
  return file;
};

/** Turn an SRT or VTT into the word-timed shape paper-edit.mjs validates. */
function transcriptFromCaptions(raw) {
  const text = String(raw ?? "").replace(/^WEBVTT[^\n]*\n?/i, "").replace(/\r/g, "");
  const blocks = text.split(/\n\s*\n/);
  const parseTime = (value) => {
    const m = String(value).trim().match(/(?:(\d+):)?(\d{2}):(\d{2})[,.](\d{1,3})/);
    if (!m) return null;
    return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, "0")) / 1000;
  };
  const cues = [];
  const words = [];
  let wordNo = 0;
  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const timing = lines.findIndex((line) => line.includes("-->"));
    if (timing === -1) continue;
    const [startRaw, endRaw] = lines[timing].split("-->");
    const startSec = parseTime(startRaw);
    // Whisper writes ` --> 00:00:01.360`: split before trimming makes the first
    // token empty, then every otherwise-valid cue gets discarded.
    const endSec = parseTime(endRaw?.trim().split(/\s+/)[0]);
    const spoken = lines.slice(timing + 1).join(" ").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    const tokens = spoken.match(/[^\s]+/g) ?? [];
    if (startSec == null || endSec == null || endSec <= startSec || !tokens.length) continue;
    const firstId = `w${wordNo + 1}`;
    const span = (endSec - startSec) / tokens.length;
    for (const [index, token] of tokens.entries()) {
      wordNo++;
      words.push({ id: `w${wordNo}`, text: token, startSec: +(startSec + index * span).toFixed(3), endSec: +(startSec + (index + 1) * span).toFixed(3) });
    }
    cues.push({ from: firstId, to: `w${wordNo}`, text: spoken, startSec, endSec });
  }
  if (!words.length) throw new Error("that subtitle file has no timed spoken text — use an .srt or .vtt with caption cues");
  return { version: 1, importedAt: new Date().toISOString(), timing: "caption", words, cues };
}

async function readPaperEdit(id, rel) {
  const raw = await readFile(paperEditPath(id, rel), "utf8").catch(() => null);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { throw new Error("the saved paper edit is not readable"); }
}

async function writePaperEdit(id, rel, state) {
  await mkdir(paperEditDir(id), { recursive: true });
  await writeFile(paperEditPath(id, rel), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function readInterview(id) {
  const raw = await readFile(interviewPath(id), "utf8").catch(() => null);
  if (!raw) return { version: 1, turns: [], plan: null };
  try {
    const saved = JSON.parse(raw);
    return {
      version: 1,
      turns: Array.isArray(saved?.turns)
        ? saved.turns.map((turn) => ({ question: String(turn?.question ?? "").trim(), answer: String(turn?.answer ?? "") })).filter((turn) => turn.question)
        : [],
      plan: saved?.plan ?? null,
      problems: Array.isArray(saved?.problems) ? saved.problems.map(String) : [],
      pendingReply: Boolean(saved?.pendingReply),
      updatedAt: saved?.updatedAt ?? null,
    };
  } catch {
    throw new Error("the saved interview is not readable");
  }
}

async function writeInterview(id, state) {
  await mkdir(interviewDir(id), { recursive: true });
  await writeFile(interviewPath(id), `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
}

/** A completed VTT is already an attachment of this recording, not a loose file. */
async function paperEditForRecording(id, rel) {
  const saved = await readPaperEdit(id, rel);
  if (saved) return saved;
  const captions = await readFile(paperEditTranscriptPath(id, rel), "utf8").catch(() => null);
  if (!captions) return null;
  const state = { version: 1, rel, transcript: transcriptFromCaptions(captions), plan: { shots: [] }, selection: null, updatedAt: new Date().toISOString() };
  await writePaperEdit(id, rel, state);
  return state;
}

/*
 * Completed transcription is a property of a recording, so Assembly needs a
 * way to find it again when the page opens. A job can finish after its page has
 * been left; in that case only the VTT exists. Recover that VTT into the same
 * paper-edit state here so a finished job never looks like work that vanished.
 */
async function paperEditRecordings(id) {
  const entries = await readdir(paperEditDir(id), { withFileTypes: true }).catch(() => []);
  const recordings = new Map();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.endsWith(".selection.json")) continue;
    const state = await readFile(join(paperEditDir(id), entry.name), "utf8").then(JSON.parse).catch(() => null);
    if (!state?.transcript || !state?.rel) continue;
    if (!(await paperEditMedia(id, state.rel).catch(() => null))) continue;
    const info = await stat(join(paperEditDir(id), entry.name)).catch(() => null);
    recordings.set(state.rel, { rel: state.rel, updatedAt: state.updatedAt ?? info?.mtime?.toISOString() ?? null });
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".vtt")) continue;
    const rel = Buffer.from(entry.name.slice(0, -4), "base64url").toString("utf8");
    if (!rel || recordings.has(rel) || !(await paperEditMedia(id, rel).catch(() => null))) continue;
    const state = await paperEditForRecording(id, rel).catch(() => null);
    if (!state?.transcript) continue;
    const info = await stat(join(paperEditDir(id), entry.name)).catch(() => null);
    recordings.set(rel, { rel, updatedAt: state.updatedAt ?? info?.mtime?.toISOString() ?? null });
  }
  return [...recordings.values()].sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
}

/* ── Multi-clip assembly ──────────────────────────────────────────────── */

const multiAssemblyDir = (id) => join(projectDir(id), "assemblies");
const multiAssemblyPath = (id) => join(multiAssemblyDir(id), "multi-clip.json");
const multiAssemblySelectionPath = (id) => join(multiAssemblyDir(id), "multi-clip.selection.json");
const visualBeatDir = (id, rel) => join(multiAssemblyDir(id), "visual-beats", Buffer.from(String(rel)).toString("base64url"));
const visualBeatPath = (id, rel) => join(visualBeatDir(id, rel), "visual-beats.json");
const audioAlignmentPath = (id) => join(multiAssemblyDir(id), "audio-alignment.json");
const audioAlignmentSelectionPath = (id) => join(multiAssemblyDir(id), "audio-alignment.selection.json");
const readMultiAssembly = async (id) => JSON.parse(await readFile(multiAssemblyPath(id), "utf8").catch(() => "null"));
const readVisualBeats = async (id, rel) => JSON.parse(await readFile(visualBeatPath(id, rel), "utf8").catch(() => "null"));
const readAudioAlignment = async (id) => JSON.parse(await readFile(audioAlignmentPath(id), "utf8").catch(() => "null"));
const writeMultiAssembly = async (id, state) => {
  await mkdir(multiAssemblyDir(id), { recursive: true });
  await writeFile(multiAssemblyPath(id), `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
};

/**
 * Recover an assembly that finished after its page went away.
 *
 * Claude writes its constrained choice to the project before its background job
 * exits. Previously, only the page that launched that job read the choice and
 * copied it into the durable assembly state. Navigating away at the wrong moment
 * therefore made a successful assembly look as though it had produced nothing.
 *
 * A fresh draft removes the old reply first, so the presence of this file means
 * it belongs to the currently saved source set rather than a previous run.
 */
async function recoverMultiAssemblySelection(id, state = null) {
  state ??= await readMultiAssembly(id);
  if (!state?.sources?.length || state.picks?.length) return state;
  const raw = await readFile(multiAssemblySelectionPath(id), "utf8").catch(() => null);
  if (!raw) return state;
  const sources = await multiAssemblySources(id, state.sources);
  const checked = validateMultiAssemblySelection(parseMultiAssemblySelection(raw), sources);
  const recovered = {
    ...state,
    version: 1,
    sources: sources.map((source) => source.rel),
    picks: checked.picks,
    comments: state.comments ?? {},
    recoveredAt: new Date().toISOString(),
  };
  await writeMultiAssembly(id, recovered);
  return recovered;
}
const writeAudioAlignment = async (id, state) => {
  await mkdir(multiAssemblyDir(id), { recursive: true });
  await writeFile(audioAlignmentPath(id), `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
};
const multiPickKey = (pick) => Buffer.from(`${pick.source}:${pick.inSec}:${pick.outSec}`).toString("base64url").slice(-18);

async function multiAssemblySources(id, rawRels) {
  const rels = [...new Set((Array.isArray(rawRels) ? rawRels : []).map(String).filter(Boolean))];
  if (!rels.length) throw new Error("choose at least one project recording");
  if (rels.length > 8) throw new Error("choose up to eight recordings for one assembly");
  const sources = [];
  const missing = [];
  for (const rel of rels) {
    const file = await paperEditMedia(id, rel);
    if (!/\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(file)) throw new Error(`${basename(rel)} is not a video recording`);
    const paper = await paperEditForRecording(id, rel);
    const visual = await readVisualBeats(id, rel);
    if (!paper?.transcript) missing.push(basename(rel));
    else if (!visual?.frames?.length) missing.push(`${basename(rel)} (analyze screen)`);
    else sources.push({ projectId: id, rel, file, transcript: paper.transcript, visual });
  }
  if (missing.length) throw new Error(`prepare these recordings first (transcript and screen analysis): ${missing.join(", ")}`);
  return sources;
}

/*
 * Assembly starts from a small, deliberate batch. This is separate from
 * `multiAssemblySources`: that helper needs all inputs ready so it can build
 * Claude's prompt, while this one tells the UI which work is still needed.
 */
async function multiAssemblyPreparation(id, rawRels) {
  const rels = [...new Set((Array.isArray(rawRels) ? rawRels : []).map(String).filter(Boolean))];
  if (rels.length > 8) throw new Error("choose up to eight recordings for one assembly");
  return Promise.all(rels.map(async (rel) => {
    const file = await paperEditMedia(id, rel).catch(() => null);
    if (!file || !/\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(file)) return { rel, transcript: false, visual: false, missing: true };
    const paper = await paperEditForRecording(id, rel);
    const visual = await readVisualBeats(id, rel);
    return { rel, transcript: Boolean(paper?.transcript?.cues?.length), visual: Boolean(visual?.frames?.length), missing: false };
  }));
}

function multiAssemblyPrompt({ sources, notes = "", script = null }) {
  const catalog = sources.map((source) => {
    const lines = source.transcript.cues.map((cue) => `${Number(cue.startSec).toFixed(2)}-${Number(cue.endSec).toFixed(2)} | ${cue.text}`).join("\n");
    const frames = source.visual.frames.map((frame) => `${Number(frame.atSec).toFixed(2)}s | ${join(visualBeatDir(source.projectId, source.rel), frame.file)}`).join("\n");
    return `SOURCE: ${source.rel}\nTIMED SPOKEN PASSAGES:\n${lines}\n\nVISUAL BEATS — inspect these actual timestamped screen frames before choosing:\n${frames}`;
  }).join("\n\n---\n\n");
  return [
    "You are building the first rough assembly from several real recordings.",
    "Choose the strongest passages across the sources. You may use a source more than once, but only name a source and times that appear below.",
    "You MUST inspect the visual-beat image files. Select a passage only when its screen state supports what the chosen words say; a transcript match alone is not enough.",
    "Return JSON only, with this exact shape:",
    '{"version":1,"picks":[{"source":"Footage/example.mp4","inSec":12.4,"outSec":19.8,"reason":"what this adds"}]}',
    "Keep the order that tells the clearest story. Do not invent footage, narration, titles, or timecodes.",
    script?.body
      ? [
          "WORKFLOW: apply the project skill video-from-script to this selection pass.",
          "The script below is the beat spine: preserve its order, choose the strongest complete take for each beat, and make every missing beat visible instead of silently skipping it. Park strong unused material rather than inventing a place for it.",
          "For every pick, include an optional `beat` field naming the script line it supports. Return an optional `gaps` array for script lines with no usable recording and an optional `parked` array for unused passages worth keeping.",
          `PROJECT SCRIPT (${script.name}):\n${script.body}`,
          speakerSections(script.body).length
            ? `SCRIPT SECTIONS BY PERSON:\n${speakerSections(script.body).map(({ speaker, text }) => `${speaker}:\n${text}`).join("\n\n")}`
            : "",
        ].join("\n\n")
      : "WORKFLOW: this is a best-parts assembly, not a script match. Choose only the passages that genuinely support the story notes.",
    notes ? `EDITOR NOTES:\n${notes}` : "",
    "SOURCE CATALOG:",
    catalog,
  ].filter(Boolean).join("\n\n");
}

function parseMultiAssemblySelection(raw) {
  const text = String(raw ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const parsed = JSON.parse(text);
  return { version: 1, picks: Array.isArray(parsed?.picks) ? parsed.picks : [] };
}

function validateMultiAssemblySelection(selection, sources) {
  const byRel = new Map(sources.map((source) => [source.rel, source]));
  const picks = [];
  const problems = [];
  for (const item of selection.picks ?? []) {
    const source = byRel.get(String(item?.source ?? ""));
    const inSec = Number(item?.inSec);
    const outSec = Number(item?.outSec);
    const last = source?.transcript?.words?.at(-1)?.endSec ?? 0;
    if (!source) problems.push(`unknown source: ${String(item?.source ?? "")}`);
    else if (!Number.isFinite(inSec) || !Number.isFinite(outSec) || outSec <= inSec || inSec < 0 || outSec > last + 0.15) problems.push(`invalid range for ${basename(source.rel)}`);
    else {
      const text = source.transcript.cues
        .filter((cue) => Number(cue.endSec) > inSec && Number(cue.startSec) < outSec)
        .map((cue) => String(cue.text ?? "").trim())
        .filter(Boolean)
        .join(" ");
      picks.push({ source: source.rel, inSec: +inSec.toFixed(3), outSec: +outSec.toFixed(3), reason: String(item?.reason ?? "").trim(), text, id: multiPickKey({ source: source.rel, inSec, outSec }) });
    }
  }
  if (!picks.length) throw new Error(problems[0] ?? "Claude did not choose any usable passages");
  return { version: 1, picks, problems };
}

async function audioAlignmentSources(id, videoRel, audioRel) {
  const video = await paperEditMedia(id, videoRel);
  const audio = await paperEditMedia(id, audioRel);
  if (!/\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(video)) throw new Error("choose a screen recording");
  if (!/\.(wav|mp3|m4a|aac|flac|ogg|opus|aiff)$/i.test(audio)) throw new Error("choose a project audio recording");
  const visual = await readVisualBeats(id, videoRel);
  if (!visual?.frames?.length) throw new Error("analyze the screen recording before mapping the narration");
  const paper = await paperEditForRecording(id, audioRel);
  if (!paper?.transcript?.cues?.length) throw new Error("transcribe the narration before mapping it to the screen");
  return { id, videoRel, audioRel, video, audio, visual, transcript: paper.transcript };
}

/**
 * A completed alignment is durable project work, so reopening Assembly must
 * restore the two actions that turn it into a video.  The first version only
 * returned these steps from POST /build; after a refresh the timeline was
 * visible but the way to render it had silently disappeared.
 */
async function audioAlignmentRenderSteps(id, state) {
  if (!state?.document || !state?.alignedAudio || !state?.renderedVideo) return {};
  const sources = await audioAlignmentSources(id, state.videoRel, state.audioRel);
  const outDir = dirname(state.document);
  const alignmentFile = join(outDir, "alignment.json");
  return {
    renderStep: ownStep("rm-render-alignment", ["--alignment", alignmentFile, "--narration", sources.audio, "--audio-output", state.alignedAudio, "--output", state.renderedVideo], {
      label: "render aligned review video",
      cwd: outDir,
      project: id,
      note: "Renders the chosen screen cuts and their matching narration into one reviewable MP4 with audio.",
    }),
    rendered: existsSync(state.renderedVideo),
  };
}

function audioAlignmentPrompt({ sources, script = "", notes = "" }) {
  const frames = sources.visual.frames
    .map((frame) => `${Number(frame.atSec).toFixed(2)}s | ${join(visualBeatDir(sources.id, sources.videoRel), frame.file)}`)
    .join("\n");
  const narration = sources.transcript.cues
    .map((cue) => `${Number(cue.startSec).toFixed(2)}-${Number(cue.endSec).toFixed(2)} | ${cue.text}`)
    .join("\n");
  return [
    "You are aligning a narration recording to a screen demo. This is an EDIT, not an audio overlay.",
    "WORKFLOW: apply the project skill video-b-roll in Mode A (locked voiceover plus a longer screen recording).",
    `Before mapping, use ${join(TOOLKIT, "skill", "video-b-roll", "scripts", "vo-phrase-boundaries.py")} on the locked narration at ${sources.audio}. Use the measured phrase boundaries as the timing source; the transcript is for words and intent only, never the final cut boundary.`,
    "Treat the screen frames as evidence. Cut or retime the screen to land the on-screen action on the phrase it proves. Keep each screen segment between roughly 0.8x and 2.2x in effective speed; if the recording order conflicts with narration order, preserve the best visual compromise and call out the conflict rather than pretending it is solved.",
    "Inspect the visual-beat images before deciding which screen range proves each narration range.",
    "Return JSON only with this exact shape:",
    '{"version":1,"segments":[{"audioInSec":0,"audioOutSec":3.2,"screenInSec":12.4,"screenOutSec":15.6,"reason":"the screen visibly performs the narrated action"}]}',
    "Segments must be in narration order, cover every spoken cue from the first cue to the last, and use only screen times within the source video.",
    "Each screen range must be within 0.35 seconds of its narration range. Cut dead time; do not stretch the whole recording or hold the final frame.",
    "If a narration line has no supporting screen moment, still return a segment but set reason to 'MISSING VISUAL: ...'. Never pretend unrelated footage demonstrates it.",
    script ? `ORIGINAL SCRIPT — use this to correct wording when the automatic transcript is imperfect:\n${script}` : "",
    notes ? `EDITOR NOTES:\n${notes}` : "",
    `SCREEN RECORDING: ${sources.videoRel} (${Number(sources.visual.durationSec).toFixed(2)}s)`,
    `VISUAL BEATS — inspect these local image files:\n${frames}`,
    `NARRATION: ${sources.audioRel}\nTIMED SPOKEN CUES:\n${narration}`,
  ].filter(Boolean).join("\n\n");
}

function parseAudioAlignment(raw) {
  const text = String(raw ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const parsed = JSON.parse(text);
  return { version: 1, segments: Array.isArray(parsed?.segments) ? parsed.segments : [] };
}

function validateAudioAlignment(selection, sources) {
  const lastAudioSec = sources.transcript.words?.at(-1)?.endSec ?? sources.transcript.cues?.at(-1)?.endSec ?? 0;
  const videoDurationSec = Number(sources.visual.durationSec ?? 0);
  const segments = [];
  const problems = [];
  let previousAudioEnd = 0;
  for (const item of selection.segments ?? []) {
    const audioInSec = Number(item?.audioInSec);
    const audioOutSec = Number(item?.audioOutSec);
    const screenInSec = Number(item?.screenInSec);
    const screenOutSec = Number(item?.screenOutSec);
    const audioDuration = audioOutSec - audioInSec;
    const screenDuration = screenOutSec - screenInSec;
    if (![audioInSec, audioOutSec, screenInSec, screenOutSec].every(Number.isFinite) || audioOutSec <= audioInSec || screenOutSec <= screenInSec) {
      problems.push("an alignment segment has invalid times");
      continue;
    }
    if (audioInSec < previousAudioEnd - 0.12 || audioInSec > previousAudioEnd + 0.5 || audioInSec < -0.05 || audioOutSec > lastAudioSec + 0.2) {
      problems.push("narration segments must stay in order and cover the recorded narration");
      continue;
    }
    if (screenInSec < 0 || screenOutSec > videoDurationSec + 0.1) {
      problems.push("an alignment segment points outside the screen recording");
      continue;
    }
    if (Math.abs(audioDuration - screenDuration) > 0.1) {
      problems.push("a screen segment does not match its narration duration");
      continue;
    }
    previousAudioEnd = audioOutSec;
    segments.push({
      id: multiPickKey({ source: sources.videoRel, inSec: screenInSec, outSec: screenOutSec }),
      audioInSec: +audioInSec.toFixed(3), audioOutSec: +audioOutSec.toFixed(3),
      screenInSec: +screenInSec.toFixed(3), screenOutSec: +screenOutSec.toFixed(3),
      reason: String(item?.reason ?? "").trim(),
    });
  }
  if (!segments.length) throw new Error(problems[0] ?? "Claude did not map any narration to the screen recording");
  if (segments[0].audioInSec > 0.5 || lastAudioSec - segments.at(-1).audioOutSec > 0.5) {
    throw new Error("Claude did not cover the full narration");
  }
  return { version: 1, segments, problems };
}

/**
 * A name safe to write to disk, keeping everything a disk can actually take.
 *
 * The rule used to be `[a-z0-9 _-]` and drop the rest, written in three places.
 * That is a rule about ASCII rather than about filenames: "Rôle Mödel.mp4"
 * imported as "Rle Mdel.mp4", a client logo called "Café.png" became "Caf.png",
 * and a Japanese or Arabic name was erased to the fallback entirely. APFS, ext4
 * and NTFS all take UTF-8; what they cannot take is a path separator, a control
 * character, or the punctuation Windows reserves.
 *
 * The leading dot goes for a different reason — not safety, but that a hidden
 * file in a media folder indexes and then cannot be found by anyone who goes
 * looking for it in Finder.
 *
 * NOT for anything that becomes an id or a URL segment. Slugs stay ASCII, and
 * the two callers that build one still fold this down themselves.
 */
const safeName = (name, fallback) =>
	String(name ?? "")
		.replace(/[/\\:*?"<>|\x00-\x1f]/g, "")
		.replace(/^\.+/, "")
		.trim() || fallback;
// Narration copy is editable independently of the source script. Keeping the
// draft beside the project means returning to Voice never loses a line, while
// the script can still be used unchanged for a later render or rewrite.
const voiceDraftPath = (id, script) => join(projectDir(id), "voice", `${safeName(script, "narration")}.md`);
// A narration build reads a sealed copy of the editor, not the editable draft.
// Autosave can keep changing the latter while a queued job is about to start.
const voiceBuildPath = (id, script, buildId) => join(projectDir(id), "voice", "builds", `${safeName(script, "narration")}-${buildId}.md`);
const thumbDir = (id) => join(projectDir(id), ".thumbs");

const MIME = {
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".m4v": "video/mp4",
  ".webm": "video/webm", ".mkv": "video/x-matroska",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
  // svg belongs here as much as png does: a logo served as octet-stream is a
  // logo a browser refuses to draw in an <img>, which reads as a missing asset.
  ".svg": "image/svg+xml", ".gif": "image/gif", ".avif": "image/avif",
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
        /*
         * When it was last written, so the project page can order it against
         * footage. Without this a script has no timestamp and sorts to the end of
         * a list whose whole point is "newest first", so a script written a
         * minute ago sits below footage from last week.
         */
        const st = await stat(join(dir, f)).catch(() => null);
        return {
          name,
          project,
          body: await readFile(join(dir, f), "utf8"),
          mtime: st ? st.mtime.toISOString() : null,
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
      // The Library needs to distinguish a bare media folder from a video a
      // person has already started. Keep the small workflow thread beside the
      // catalog so returning to the project has an honest continuation signal.
      p.workflow = await readWorkflow(p.id).catch(() => null);
    }),
  );
  const [wallpapers, scripts, tokens, motion, logos, imagery, added] = await Promise.all([
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
    // And whatever was added here, which lives in the library beside the projects.
    readAdded(),
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
    // Where the Docs button goes. Sent with state rather than fetched on demand:
    // it is one string and the button is drawn on every render.
    docsUrl: await docsUrl(),
    projects,
    wallpapers,
    scripts,
    presets,
    tokens,
    // Label and hint only. The direction sentences stay server-side: the panel's
    // job is to name a motion preset, /api/make's job is to turn it into prompt.
    logos,
    imagery,
    added,
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
     * The project you are working in, verified against the library.
     *
     * A stored id whose folder has since been deleted or renamed would put every
     * panel inside a project that is not there — footage lists empty, saves
     * failing, and nothing on screen saying why. Falling back to null lands you on
     * the picker instead, which is a state the UI already knows how to render.
     */
    currentProject: await (async () => {
      const id = await currentProject();
      return id && projects.some((p) => p.id === id) ? id : null;
    })(),
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

    /*
     * The capture HUD lives in OpenScreen, outside this web page, so it cannot
     * infer the current library project from the file currently open in the
     * editor. This is the one narrow handoff it needs: the selected project's
     * Footage directory, resolved by the server rather than guessed by the page.
     */
    if (p === "/api/capture-target") {
      const id = await currentProject();
      const m = id ? await readManifest(projectDir(id)).catch(() => null) : null;
      if (!id || !m) return json(res, 200, { target: null });
      return json(res, 200, {
        target: {
          directory: join(mediaDir(id), "Footage"),
          projectId: id,
          projectName: m.name || id,
        },
      });
    }

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

    /* A direct Claude render can finish outside Studio's job runner. Re-index
     * this open project on demand so that new output appears without a reload. */
    if (p === "/api/project/media" && req.method === "GET") {
      const id = String(url.searchParams.get("project") ?? "");
      const manifest = await readManifest(projectDir(id)).catch(() => null);
      if (!manifest) return json(res, 404, { error: "pick a project" });
      return json(res, 200, { catalog: await reindex(id) });
    }

    /*
     * One download for the project's actual assets. Streaming zip keeps even a
     * large set of footage out of server memory and leaves working/interview
     * files behind; this is the portable media handoff people expect from the
     * project header.
     */
    if (p === "/api/project/assets" && req.method === "GET") {
      const id = String(url.searchParams.get("project") ?? "");
      const manifest = await readManifest(projectDir(id)).catch(() => null);
      const assets = mediaDir(id);
      if (!manifest) return json(res, 404, { error: "pick a project" });
      if (!(await stat(assets).catch(() => null))?.isDirectory()) return json(res, 404, { error: "this project has no media to download" });
      const filename = `${safeName(manifest.name || id, "project")}-assets.zip`.replace(/\s+/g, "-");
      const archive = spawn("zip", ["-q", "-r", "-y", "-", join(id, "media")], { cwd: LIB, stdio: ["ignore", "pipe", "pipe"] });
      const errors = [];
      archive.stderr.on("data", (chunk) => errors.push(String(chunk)));
      archive.on("error", (error) => {
        if (!res.headersSent) json(res, 500, { error: `could not package the project: ${error.message}` });
        else res.destroy(error);
      });
      archive.on("close", (code) => {
        if (code !== 0 && !res.writableEnded) res.destroy(new Error(errors.join("").trim() || "could not package the project"));
      });
      res.writeHead(200, {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
      });
      archive.stdout.pipe(res);
      return;
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
      const safe = safeName(body.name, "untitled");
      // A script either belongs to a project or to the shared shelf. Most do
      // belong to a project, and burying them all in one global folder is how
      // you end up unable to tell which client a script was written for.
      const dir = body.projectId ? join(projectDir(body.projectId), "scripts") : SCRIPTS;
      await mkdir(dir, { recursive: true });
      const file = join(dir, `${safe}.md`);
      await writeFile(file, body.body ?? "", "utf8");
      return json(res, 200, { ok: true, name: safe, file });
    }

    /* A script is a project deliverable, so delete it from the same scoped menu. */
    if (p === "/api/script/delete" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = String(body.projectId ?? "");
      const safe = safeName(body.name, "");
      const manifest = await readManifest(projectDir(id)).catch(() => null);
      if (!manifest) return json(res, 404, { error: "pick a project" });
      if (!safe) return json(res, 400, { error: "pick a script" });

      const dir = join(projectDir(id), "scripts");
      const script = join(dir, `${safe}.md`);
      if (!(await stat(script).catch(() => null))) return json(res, 404, { error: "that script is no longer in this project" });

      // Keep the brief with its script and make this recoverable like media
      // deletion. A generated brief without its script is just stale intent.
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const trash = join(LIB, ".trash", `${stamp}-${id}-${safe}-script`);
      await mkdir(trash, { recursive: true });
      await rename(script, join(trash, `${safe}.md`));
      const brief = join(dir, `${safe}.brief.json`);
      if (await stat(brief).catch(() => null)) await rename(brief, join(trash, `${safe}.brief.json`));
      return json(res, 200, { ok: true, note: `Moved ${safe} to the Studio trash.` });
    }

    /*
     * A named script is a deliberate deliverable. The work before it has a name
     * still needs to survive a reload, so keep an editor draft beside Studio's
     * other local state rather than asking a browser-origin store to remember it.
     */
    if (p === "/api/script/draft-state" && req.method === "GET") {
      const id = String(url.searchParams.get("project") ?? "");
      if (!id) return json(res, 400, { error: "need a project" });
      try {
        return json(res, 200, { draft: await readScriptDraft(id) });
      } catch (err) {
        return json(res, 500, { error: err.message });
      }
    }

    if (p === "/api/script/draft-state" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = String(body.projectId ?? "");
      if (!id) return json(res, 400, { error: "need a project" });
      try {
        const draft = await writeScriptDraft(id, body);
        return json(res, 200, { ok: true, draft });
      } catch (err) {
        return json(res, 500, { error: err.message });
      }
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
      // Claude's handoff is an editable composition, never a one-off MP4.
      // Older tabs can still post output:"video"; treating that as a template
      // keeps their result in the reviewable HyperFrames workflow rather than
      // silently recreating the dead-end path we removed from the form.
      const output = "template";

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
      const scriptSpeakers = isUrl ? [] : speakerSections(src);
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
        // A renderer works in this project's Renders folder, not in the toolkit.
        // Telling Claude about `brand/wallpapers/...` without staging that image
        // left it to invent a substitute. The selected background is a required
        // local asset, just like the selected audio.
        const wallpaperName = basename(String(wallpaper));
        const wallpaperSource = join(TOOLKIT, "brand", "wallpapers", wallpaperName);
        if (!(await stat(wallpaperSource).catch(() => null))) {
          return json(res, 400, { error: `the selected background is not installed: ${wallpaperName}` });
        }
        const wallpaperDest = join(outDir, "assets", "wallpapers", wallpaperName);
        await mkdir(dirname(wallpaperDest), { recursive: true });
        await copyFile(wallpaperSource, wallpaperDest);
        wants.push(
          `Use this exact RoleModel background in every scene: "${wallpaperDest}". ` +
            "Do not substitute a gradient, a generated background, or a different image.",
        );
      } else {
        wants.push("No wallpaper behind the scene — a flat background from the brand palette.");
      }
      const captions = pick("captions", body.captions ? "on" : "off");
      if (captions === "on" || captions === true) wants.push("Burn captions in, synced to the narration.");
      wants.push(
        "Keep continuous visual coverage: there must be no blank or background-only frame between scenes. " +
          "The next scene is visible at its start time, even while it is entering; overlap or crossfade transitions instead of leaving a gap.",
      );

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

      /*
       * A script heading is content, not disposable prompt decoration.
       *
       * The earlier prompt handed Claude one loose paragraph and separately
       * said there was no title card. That let it turn a named script into a
       * generic product explainer. Keep the first H1 as the default title and
       * give every remaining non-directive line an ordered, literal render slot.
       */
      const scriptLines = isUrl
        ? []
        : src
            .split(/\r?\n/)
            .map((raw) => raw.trim())
            .filter((line) => line && !/^\/[a-z][a-z-]*(\s|$)/i.test(line));
      let scriptTitle = "";
      const scriptBeats = [];
      for (const line of scriptLines) {
        const heading = line.match(/^#{1,6}\s+(.+)$/);
        if (heading && !scriptTitle) {
          scriptTitle = heading[1].trim();
          continue;
        }
        scriptBeats.push(heading ? heading[1].trim() : line);
      }

      const titleCard = String(pick("title", body.titleCard) || scriptTitle || "").trim();
      if (titleCard) {
        const eyebrow = String(pick("eyebrow", body.eyebrow) || "").trim();
        wants.push(
          `Open with the title card in title.html, which is already staged and already uses the ` +
            `brand mark, the vendored faces and theme.css. Change only the words: the title reads ` +
            `"${titleCard}"${eyebrow ? `, and the eyebrow above it reads "${eyebrow}"` : `, and remove the eyebrow`}.`,
        );
      } else {
        wants.push("No title card — open on the content and do not invent a title, heading, or standalone text scene.");
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
      /*
       * The assets picked on the project page, named in the brief.
       *
       * Without these the model had two files to work with — one webcam clip and
       * one audio track, chosen from single-selects — and no way to be told about
       * the rest of the project. A composition that needs four clips and two
       * stills either invented placeholder paths or did without.
       *
       * Resolved to real paths here and dropped if missing, because a brief that
       * names a file which is not on disk is worse than one that does not mention
       * it: the model writes markup around it and the render fails at the last
       * step, having already spent the minutes.
       */
      const assetRels = Array.isArray(body.assets) ? body.assets.map(String) : [];
      const assets = [];
      for (const rel of assetRels) {
        const full = await mediaPath(rel);
        if (full) assets.push({ rel, full });
        else wants.push(`An asset picked for this render (${rel}) is not on disk — leave it out.`);
      }
      if (assets.length) {
        wants.push(
          `Use these files from the project, by path, rather than inventing placeholders:\n${assets
            .map((a) => `  ${a.full}`)
            .join("\n")}`,
        );
      }

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
      // A script can carry its own voice choice. This matters for shared scripts:
      // a saved ElevenLabs voice must not turn back into Kokoro just because the
      // next person opens the panel with its local default selected.
      const docVoiceProvider = fromDoc["voice-provider"];
      const voiceProvider = docVoiceProvider === "elevenlabs" || (!docVoiceProvider && body.voiceProvider === "elevenlabs") ? "elevenlabs" : "kokoro";
      const audioIsNarration = audio && !(fromDoc.music || String(pick("audioRole", body.audioRole) || "narration") === "music");

      /*
       * A HyperFrames template is a small project, not just a loose HTML file.
       *
       * Claude needs a relative source it can put in an <audio> element and the
       * manual renderer needs that source to still be beside index.html later.
       * Copying the chosen media into a hidden folder gives both that contract
       * without moving the original or cluttering the project's Library shelf.
       */
      const stageTemplateMedia = async (file, name) => {
        if (!file) return "";
        const dir = join(outDir, ".template-media");
        await mkdir(dir, { recursive: true });
        const dest = join(dir, `${name}${extname(file).toLowerCase()}`);
        await copyFile(file, dest);
        return `.template-media/${basename(dest)}`;
      };
      const templateAudio = output === "template" ? await stageTemplateMedia(audio, audioIsNarration ? "narration" : "music") : "";
      const templateWebcam = output === "template" ? await stageTemplateMedia(webcam, "webcam") : "";
      const templateAssets = [];
      if (output === "template") {
        for (const [i, asset] of assets.entries()) {
          templateAssets.push(await stageTemplateMedia(asset.full, `asset-${String(i + 1).padStart(2, "0")}`));
        }
      }
      if (voiceId && !audioIsNarration) {
        wants.push(
          voiceProvider === "elevenlabs"
            ? `Narrate with the selected ElevenLabs voice, id "${voiceId}", for every spoken line. Use ElevenLabs for the spoken track; do not substitute a local voice.`
            : `Narrate with \`hyperframes tts --voice ${voiceId}\` — that exact voice id, for every spoken line.`,
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
        : [
            "SCRIPT SOURCE OF TRUTH",
            titleCard ? `Opening title (render these exact words): ${titleCard}` : "Opening title: none",
            "Required script lines, in this exact order:",
            ...scriptBeats.map((line, index) => `${index + 1}. ${line}`),
          ].join("\n");

      const scriptFidelity = isUrl
        ? ""
        : [
            "\n\nSCRIPT FIDELITY — NON-NEGOTIABLE:",
            "- Treat the supplied script as the source of truth, not a creative brief to summarize.",
            "- Render the opening title and every numbered script line exactly as written and in the listed order. Do not paraphrase, combine, reorder, omit, replace, or add lines.",
            "- Claude may choose visual treatment, timing, scene layout, and transitions; it may not invent the message, a new story, product claims, example users, fake UI copy, or a generic Plan / Brand / Render explainer.",
            "- If a line needs a visual and no real asset was provided, make that exact line the visual using the staged brand treatment. Do not fabricate a screenshot or substitute different copy.",
            "- Do not shorten the script to fit the requested duration. Give every silent line enough reading time; with narration, cut scenes to the recorded or generated words.",
            "- Before rendering, check source coverage: the title and every numbered line must have one clear, reviewable moment in the composition.",
          ].join("\n");

      const speakerDirection = scriptSpeakers.length
        ? [
            "SCRIPT SECTIONS BY PERSON — NON-NEGOTIABLE:",
            "- Each person owns the exact section listed below. Keep their sections intact and in script order.",
            "- Prefer a selected project clip whose filename identifies that person. If there is no matching footage, preserve the gap for review rather than assigning their section to someone else.",
            ...scriptSpeakers.map(({ speaker, text }) => `${speaker}:\n${text}`),
          ].join("\n")
        : "";

      const subject = isUrl ? `a ${body.seconds || 20}-second ${brand}-branded promo for ${src}` : `a ${brand}-branded video that faithfully renders the script below`;
      const templateDirection = output === "template"
        ? [
            `Create a reviewable HyperFrames template for ${subject}.`,
            `Write the project entry point to ${join(outDir, "index.html")} and do not render an MP4.`,
            "Use a standalone root composition with data-composition-id, data-start, data-duration, data-width and data-height.",
            "Keep every GSAP timeline paused and registered on window.__timelines. Do not use remote media or fonts.",
            templateAudio
              ? `Use the selected ${audioIsNarration ? "narration" : "music"} as a separate <audio> track with src=\"${templateAudio}\". It is the real selected file: do not replace or synthesise it.${audioIsNarration ? " Build the visual pacing around it." : " Keep it under any speech."}`
              : voiceId
                ? voiceProvider === "elevenlabs"
                  ? `Create .template-media/narration.wav with the selected ElevenLabs voice, id "${voiceId}", then use it as a separate <audio> track. Do not render the video yet.`
                  : `Create .template-media/narration.wav with hyperframes tts using voice ${voiceId}, then use it as a separate <audio> track. Do not render the video yet.`
                : "There is no audio track. Keep the template silent.",
            templateWebcam ? `Use this exact webcam clip when a picture-in-picture is called for: \"${templateWebcam}\".` : "",
            templateAssets.length ? `Use these staged project assets where they help, rather than placeholders:\n${templateAssets.map((file) => `  ${file}`).join("\n")}` : "",
            "The next human step is HyperFrames lint and review, then a manual render from this folder.",
          ].filter(Boolean).join("\n")
        : `Using /hyperframes, make ${subject}.\nRender the MP4 into ${outDir}.`;
      const prompt = `${templateDirection}${direction}${await globalSkillDirection()}${scriptFidelity}${speakerDirection ? `\n\n${speakerDirection}` : ""}${isUrl ? "" : `\n\n${spokenSrc}`}`;

      const brief = [
        `# ${body.title || slug}`,
        "",
        `- project: ${m.name}${m.client ? ` (${m.client})` : ""}`,
        `- brand: ${brand}`,
        `- output: ${output}`,
        `- source: ${isUrl ? src : "script (below)"}`,
        `- seconds: ${body.seconds || 20}`,
        `- browser chrome: ${body.browser ? body.browserUrl || "yes" : "no"}`,
        `- background: ${body.wallpaper && body.wallpaper !== "none" ? body.wallpaper : "none"}`,
        `- captions: ${body.captions ? "yes" : "no"}`,
        `- motion: ${motionPick ? motionPick.label : "none"}`,
        `- voice: ${audioIsNarration ? "recorded track" : voiceId ? `${voiceProvider}/${voiceId}` : "none (silent)"}`,
        `- title card: ${titleCard || "none"}`,
        `- assets: ${assets.length ? assets.map((a) => a.rel).join(", ") : "none"}`,
        `- webcam: ${webcam || "none"}`,
        `- audio: ${audio ? `${audio} (${body.audioRole || "narration"})` : "none"}`,
        `- template audio: ${templateAudio || "none"}`,
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
      const renderStep = output === "template"
        ? {
            label: `render template ${slug}`,
            project: id,
            bin: "npx",
            args: ["--yes", "hyperframes", "render", "--output", join(outDir, `${slug}.mp4`), "--quality", "draft"],
            cwd: outDir,
            note: "run this after Claude has written index.html; the result is a draft MP4 with the selected audio",
          }
        : null;
      return json(res, 200, {
        prompt,
        dir: outDir,
        brief: join(outDir, "brief.md"),
        isUrl,
        output,
        template: output === "template" ? join(outDir, "index.html") : null,
        // This is the thing that gets edited.  The eventual MP4 is intentionally
        // not the handoff: it is a render of this source project, and can always
        // be made again after someone adjusts the timeline in HyperFrames.
        hyperframesProject: output === "template" ? basename(outDir) : null,
        lintStep: output === "template"
          ? { label: `lint template ${slug}`, project: id, bin: "npx", args: ["--yes", "hyperframes", "lint"], cwd: outDir }
          : null,
        renderStep,
        // Headless agent, run from the render directory so relative paths in the
        // prompt land where the brief says they will. Which agent, and the argv
        // that goes with it, is lib/agents.mjs — one decision, not two copies.
        step: { ...await studioAgentStep({ prompt, cwd: outDir, label: `make ${slug}` }), project: id },
      });
    }

    /*
     * The real HyperFrames editing surface.
     *
     * Studio's React components are not a drop-in panel, and imitating the
     * timeline here would create a second editor that cannot write the actual
     * composition.  Start HyperFrames' own Studio against the project's Renders
     * folder instead; the browser URL selects the one composition folder to edit.
     */
    if (p === "/api/hyperframes" && req.method === "GET") {
      const id = String(url.searchParams.get("project") ?? "");
      const manifest = await readManifest(projectDir(id)).catch(() => null);
      if (!manifest) return json(res, 404, { error: "pick a project" });
      return json(res, 200, { projects: await hyperframesProjects(id) });
    }

    if (p === "/api/hyperframes/open" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = String(body.projectId ?? "");
      const manifest = await readManifest(projectDir(id)).catch(() => null);
      if (!manifest) return json(res, 404, { error: "pick a project" });
      try {
        return json(res, 200, await openHyperframesStudio(id, body.folder));
      } catch (error) {
        return json(res, 400, { error: String(error.message ?? error) });
      }
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
    /*
     * Where a piece of media goes, and under what name.
     *
     * Shared by both ways in — copying a file already on this disk, and receiving
     * one dropped onto the page — so a dropped file lands exactly where a browsed
     * one does. Two copies of this drifting apart would put the same recording in
     * two folders depending on how it arrived, and the catalog reads folders.
     */
    const mediaSpot = async (id, filename) => {
      /*
       * Both cases of the extension, because they do different jobs.
       *
       * `ext` decides which folder this lands in and is compared against
       * lowercase lists. `raw` is what has to be stripped off the name — and
       * `basename(file, ext)` is case-SENSITIVE, so stripping ".mp4" off
       * "Clip.MP4" removed nothing and the scrub below then ate the dot:
       * "Clip.MP4" imported as "ClipMP4.mp4".
       */
      const rawExt = extname(filename);
      const ext = rawExt.toLowerCase();
      const AUDIO = [".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg"];
      const VIDEO = [".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v"];
      const STILL = [".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff"];
      // What it is decides where it goes, so the catalog and every panel that
      // reads it stay right.
      const folder = VIDEO.includes(ext) ? "Footage" : AUDIO.includes(ext) ? "Audio" : STILL.includes(ext) ? "Stills" : null;
      if (!folder) {
        return { error: `${ext || "that"} is not media this pipeline handles — video, audio or a still image` };
      }

      const dir = join(mediaDir(id), folder);
      await mkdir(dir, { recursive: true });

      // Never silently replace something already there: two takes with the same
      // name is normal, and losing the first one to an import is not.
      // Keeps everything a disk can take — see safeName.
      const stem = safeName(basename(filename, rawExt), "import");
      let dest = join(dir, `${stem}${ext}`);
      let n = 2;
      while (await stat(dest).then(() => true).catch(() => false)) {
        dest = join(dir, `${stem}-${n}${ext}`);
        n++;
      }
      return { folder, dest, renamed: basename(dest) !== `${stem}${ext}` ? basename(dest) : null };
    };

    /*
     * Move one catalogued media file between projects.
     *
     * The caller can name only a catalog-relative path from its source project;
     * it can never provide arbitrary source or destination filesystem paths.
     * The destination folder still follows the file type, exactly as imports do.
     */
    if (p === "/api/media/move" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const from = String(body.fromProjectId ?? "");
      const to = String(body.toProjectId ?? "");
      const rel = String(body.rel ?? "");
      if (!from || !to || !rel) return json(res, 400, { error: "pick the media and destination project" });
      if (from === to) return json(res, 400, { error: "that media is already in this project" });

      const [sourceManifest, destinationManifest] = await Promise.all([
        readManifest(projectDir(from)).catch(() => null),
        readManifest(projectDir(to)).catch(() => null),
      ]);
      if (!sourceManifest || !destinationManifest) return json(res, 404, { error: "one of those projects no longer exists" });

      const sourceRoot = mediaDir(from);
      const source = requestedPath({ projectId: from, rel });
      if (!source.startsWith(sourceRoot + sep)) return json(res, 403, { error: "that file is outside the source project" });
      const info = await stat(source).catch(() => null);
      if (!info?.isFile()) return json(res, 404, { error: "that media file is no longer in this project" });

      const spot = await mediaSpot(to, basename(source));
      if (spot.error) return json(res, 400, { error: spot.error });
      try {
        await rename(source, spot.dest);
      } catch (err) {
        // Rare for two projects in one library, but preserve the user's intent
        // if a library spans volumes instead of leaving a half-finished move.
        if (err?.code !== "EXDEV") return json(res, 500, { error: `could not move the media: ${err.message}` });
        await copyFile(source, spot.dest);
        await rm(source, { force: true });
      }
      await Promise.all([reindex(from, { force: true }), reindex(to, { force: true })]).catch(() => {});
      return json(res, 200, { ok: true, from, to, into: spot.folder, file: spot.dest, renamed: spot.renamed, bytes: info.size });
    }

    /*
     * Rename an asset without losing the work already attached to it.
     *
     * A media name is part of the prompt Claude sees, but it is also a key in
     * transcripts and paper edits. Keep the original extension, move the three
     * derived paper-edit files to their new key, and rewrite only ordinary text
     * project files — never a binary recording.
     */
    if (p === "/api/media/rename" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = String(body.projectId ?? "");
      const rel = String(body.rel ?? "");
      const requested = String(body.name ?? "").trim();
      if (!id || !rel || !requested) return json(res, 400, { error: "pick media and give it a name" });
      if (basename(requested) !== requested) return json(res, 400, { error: "a media name cannot contain a folder" });

      const root = mediaDir(id);
      const source = requestedPath({ projectId: id, rel });
      if (!source.startsWith(root + sep)) return json(res, 403, { error: "that file is outside this project's media" });
      const info = await stat(source).catch(() => null);
      if (!info?.isFile()) return json(res, 404, { error: "that media file is no longer in this project" });

      const sourceExt = extname(source);
      const requestedExt = extname(requested);
      if (requestedExt && requestedExt.toLowerCase() !== sourceExt.toLowerCase()) {
        return json(res, 400, { error: `keep the ${sourceExt} extension when renaming this media` });
      }
      const stem = safeName(basename(requested, requestedExt), "untitled");
      const target = join(dirname(source), `${stem}${sourceExt}`);
      if (target === source) return json(res, 200, { ok: true, rel, name: basename(source) });
      if (await stat(target).catch(() => null)) return json(res, 409, { error: "a file with that name already exists in this folder" });

      await rename(source, target);
      const nextRel = relative(root, target);
      await renameMediaReferences(id, rel, nextRel, source, target);
      await reindex(id, { force: true }).catch(() => {});
      return json(res, 200, { ok: true, rel: nextRel, name: basename(target) });
    }

    /*
     * Existing HUD captures are easy to lose because they land in OpenScreen's
     * recording shelf, not a Studio project. Give the project page a precise
     * list of those captures and a safe, one-click copy into media/Footage.
     *
     * This intentionally accepts only a file returned from OpenScreen's known
     * recording directories. The older generic import endpoint remains useful
     * for a deliberate local-path import, but this endpoint must not turn a
     * small "recent recordings" UI into arbitrary filesystem access.
     */
    if (p === "/api/openscreen-recordings" && req.method === "GET") {
      return json(res, 200, { recordings: await recentOpenScreenRecordings() });
    }

    if (p === "/api/openscreen-recordings/import" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = body.projectId;
      const m = await readManifest(projectDir(id)).catch(() => null);
      if (!m) return json(res, 404, { error: "pick a project" });

      const src = resolve(String(body.file ?? ""));
      if (!isOpenScreenRecording(src)) return json(res, 403, { error: "that is not a recent OpenScreen recording" });
      const st = await stat(src).catch(() => null);
      if (!st?.isFile() || !OPENSCREEN_VIDEO_EXT.has(extname(src).toLowerCase())) {
        return json(res, 404, { error: "that OpenScreen recording is no longer available" });
      }

      const spot = await mediaSpot(id, src);
      if (spot.error) return json(res, 400, { error: spot.error });
      await copyFile(src, spot.dest);
      await reindex(id, { force: true }).catch(() => {});
      return json(res, 200, { ok: true, into: spot.folder, file: spot.dest, renamed: spot.renamed, bytes: st.size });
    }

    if (p === "/api/import" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = body.projectId;
      const m = await readManifest(projectDir(id)).catch(() => null);
      if (!m) return json(res, 404, { error: "pick a project" });

      const src = resolve(String(body.file ?? ""));
      const st = await stat(src).catch(() => null);
      if (!st?.isFile()) return json(res, 404, { error: `no such file: ${src}` });

      const spot = await mediaSpot(id, src);
      if (spot.error) return json(res, 400, { error: spot.error });

      await copyFile(src, spot.dest);
      await reindex(id, { force: true }).catch(() => {});
      return json(res, 200, { ok: true, into: spot.folder, file: spot.dest, renamed: spot.renamed, bytes: st.size });
    }

    /*
     * The worked example, so "From a test" is something you can press.
     *
     * This panel asked for a Playwright trace you had produced somewhere else,
     * or for a demo script written against a product the Studio has never seen —
     * so the one panel that needed a worked example was the one where you could
     * not get started without already knowing the answer. This is a real script
     * against a real public site, and it runs.
     */
    if (p === "/api/demo/example") {
      const file = join(TOOLKIT, "presets/demos/rolemodel-tour.md");
      const body = await readFile(file, "utf8").catch(() => null);
      if (body === null) return json(res, 404, { error: "the example script is not installed" });
      return json(res, 200, { ok: true, name: "rolemodel-tour", body });
    }

    /*
     * A brand asset somebody added — a client logo, a product shot, a texture.
     *
     * The Brand page could show the vendored marks and clay renders and nothing
     * else, so "use our client's logo in this title card" had no answer inside
     * the app at all: you put the file somewhere by hand and hoped a composition
     * could name it.
     *
     * Written into the library, not the toolkit — see ADDED_DIR for why.
     */
    if (p === "/api/brand/asset" && req.method === "POST") {
      const q = new URL(req.url, "http://studio.local").searchParams;
      // basename, then a scrub: this becomes a filename in a shared folder, and
      // the name arrives from a browser.
      const raw = basename(String(q.get("name") ?? "")).trim();
      const ext = extname(raw).toLowerCase();
      const IMAGE = [".png", ".jpg", ".jpeg", ".webp", ".svg", ".gif", ".avif"];
      if (!IMAGE.includes(ext)) {
        return json(res, 400, {
          error: `${ext || "that"} is not an image — png, jpg, webp, svg, gif or avif`,
        });
      }
      const stem = safeName(basename(raw, ext), "asset");

      await mkdir(ADDED_DIR, { recursive: true });
      // Never silently replace: two versions of a client's mark under one name is
      // how the wrong one ends up in a render nobody re-checks.
      let file = `${stem}${ext}`;
      let n = 2;
      while (await stat(join(ADDED_DIR, file)).then(() => true).catch(() => false)) {
        file = `${stem}-${n}${ext}`;
        n++;
      }
      const dest = join(ADDED_DIR, file);

      try {
        await pipeline(req, createWriteStream(dest));
      } catch (e) {
        await rm(dest, { force: true }).catch(() => {});
        return json(res, 500, { error: `that upload did not finish: ${e.message}` });
      }

      const st = await stat(dest).catch(() => null);
      const entry = { name: stem, file, bytes: st?.size ?? 0 };
      const list = (await readAdded()).filter((e) => e.file !== file);
      list.push(entry);
      list.sort((a, b) => a.name.localeCompare(b.name));
      await writeFile(ADDED_INDEX, `${JSON.stringify({ added: list }, null, "\t")}\n`);
      return json(res, 200, { ok: true, ...entry });
    }

    if (p === "/api/brand/asset/delete" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const file = basename(String(body.file ?? ""));
      const list = await readAdded();
      if (!list.some((e) => e.file === file)) return json(res, 404, { error: "no such asset" });
      // The index is the only list of what this app put there, so it is the only
      // thing allowed to name what it removes.
      await rm(join(ADDED_DIR, file), { force: true });
      await writeFile(ADDED_INDEX, `${JSON.stringify({ added: list.filter((e) => e.file !== file) }, null, "\t")}\n`);
      return json(res, 200, { ok: true });
    }

    /*
     * The same import, from bytes rather than a path.
     *
     * Dropping a file on a page hands the page its CONTENTS, not its location —
     * and in a browser it cannot have the location at all. So the path route
     * cannot serve a drop, and asking somebody to type the path of a file they
     * are looking at is the interaction this replaces.
     *
     * Streamed to disk rather than buffered: this is footage, and a 4GB take
     * read into memory to be written straight back out is a crash where a copy
     * would have done.
     */
    if (p === "/api/import/upload" && req.method === "POST") {
      const q = new URL(req.url, "http://studio.local").searchParams;
      const id = q.get("project") ?? "";
      const m = await readManifest(projectDir(id)).catch(() => null);
      if (!m) return json(res, 404, { error: "pick a project" });

      // basename on purpose: the name comes from the page, and a browser will
      // happily hand over "../../x" if something upstream of it wants it to.
      const name = basename(String(q.get("name") ?? "")).trim();
      if (!name) return json(res, 400, { error: "that upload had no filename" });

      const spot = await mediaSpot(id, name);
      if (spot.error) return json(res, 400, { error: spot.error });

      try {
        await pipeline(req, createWriteStream(spot.dest));
      } catch (e) {
        // A half-written file in a media folder is worse than a failed import:
        // it indexes, it plays for four seconds, and nothing says why.
        await rm(spot.dest, { force: true }).catch(() => {});
        return json(res, 500, { error: `that upload did not finish: ${e.message}` });
      }

      const st = await stat(spot.dest).catch(() => null);
      await reindex(id, { force: true }).catch(() => {});
      return json(res, 200, { ok: true, into: spot.folder, file: spot.dest, renamed: spot.renamed, bytes: st?.size ?? 0 });
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
      return json(res, 200, await readDraft(id));
    }

    if (p === "/api/record/draft" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = String(body.projectId ?? "");
      if (!id) return json(res, 400, { error: "need a project" });
      try {
        const file = await writeDraft(id, body);
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

      /*
       * A wallpaper pinned to a Homebrew keg that no longer exists.
       *
       * Documents branded before `stablePath` recorded the versioned Cellar path —
       * `.../Cellar/rm-video/0.0.1/libexec/...` — so upgrading to 0.1.0 deleted the
       * directory every one of them pointed at. The compositor then complains once
       * PER FRAME and still exits 0, writing an MP4 with no wallpaper: a failure
       * loud in the log and invisible in the result.
       *
       * Rewritten rather than reported, because unlike a missing video there is no
       * ambiguity about what was meant — the same file is still installed, at the
       * version-stable path Homebrew maintains for exactly this. Saved separately
       * from the media repair below so a document with a healthy video still gets
       * its wallpaper fixed.
       */
      const wall = doc?.editor?.wallpaper;
      if (typeof wall === "string") {
        const stable = stablePath(wall);
        if (stable !== wall && (await stat(stable).catch(() => null))) {
          doc.editor.wallpaper = stable;
          await writeFile(docPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
        }
      }

      /*
       * Newer multi-clip documents name their footage through `assets` and the
       * timeline, while the editor handoff still asks the legacy `media` block
       * which file it should mount first.  Those are the same source in a cut
       * list; teaching the handoff that bridge makes an editable multi-clip
       * document open instead of claiming it has no video.
       */
      let current = doc?.media?.screenVideoPath;
      if (!current) {
        const primary = doc?.assets?.find((asset) => asset?.id === doc?.project?.primaryAssetId)
          ?? doc?.assets?.find((asset) => asset?.kind === "video");
        if (primary?.originalPath) {
          doc.media = { ...(doc.media ?? {}), screenVideoPath: primary.originalPath };
          current = doc.media.screenVideoPath;
          await writeFile(docPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
        }
      }
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
       * A narrated recording is an export choice, not a destructive edit to the
       * capture. The source video stays intact; the final project video receives
       * the selected track, either mixed with or replacing the capture audio.
       */
      let attachedAudio = null;
      if (body.audioRel) {
        const rel = String(body.audioRel);
        const candidate = resolve(mediaDir(id), rel);
        const audioRoot = resolve(mediaDir(id));
        if (!candidate.startsWith(audioRoot + sep)) return json(res, 403, { error: "that audio is outside this project" });
        if (!/\.(wav|mp3|m4a|aac|flac|ogg)$/i.test(candidate)) return json(res, 400, { error: "pick an audio file from this project" });
        if (!(await stat(candidate).catch(() => null))?.isFile()) return json(res, 404, { error: "that audio file is no longer in this project" });
        attachedAudio = candidate;
      }
      const audioMode = body.audioMode === "mix" ? "mix" : "replace";
      const requestedAudioOffset = Number(body.audioOffset ?? 0);
      const audioOffset = Number.isFinite(requestedAudioOffset) ? Math.max(0, requestedAudioOffset) : 0;

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
               * one thing while the script drove another — thirty seconds of the Ridgeline
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
          args: [
            "export", proj,
            "-o", join(dest, `${slug}.mp4`),
            "--auto-zoom",
            ...(attachedAudio ? ["--audio", attachedAudio, "--audio-mode", audioMode, "--audio-offset", String(audioOffset)] : []),
            "--json",
          ],
        },
      ];

      return json(res, 200, {
        dest,
        project: proj,
        video: join(dest, `${slug}.mp4`),
        steps,
        editable: proj,
        script: scriptPath,
        audio: attachedAudio ? { rel: String(body.audioRel), mode: audioMode, offset: audioOffset } : null,
      });
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

    if (p === "/api/skills/upload" && req.method === "POST") {
      try {
        const replace = new URL(req.url, "http://studio.local").searchParams.get("replace") === "1";
        const archive = await bytes(req, SHARED_SKILL_LIMIT);
        const installed = await installSharedSkillZip(archive, { replace });
        return json(res, 200, { installed, studio: await globalStudioSkills() });
      } catch (err) {
        return json(res, err.code === "SKILL_EXISTS" ? 409 : 400, { error: String(err.message), skills: err.skills ?? [] });
      }
    }

    const publishSkillMatch = /^\/api\/skills\/([a-z0-9][a-z0-9-]{0,63})\/publish$/.exec(p);
    if (publishSkillMatch && req.method === "POST") {
      try {
        const replace = new URL(req.url, "http://studio.local").searchParams.get("replace") === "1";
        const installed = await publishLocalStudioSkill(publishSkillMatch[1], { replace });
        return json(res, 200, { installed, studio: await globalStudioSkills() });
      } catch (err) {
        return json(res, err.code === "SKILL_EXISTS" ? 409 : 400, { error: String(err.message), skills: err.skills ?? [] });
      }
    }

    const skillMatch = /^\/api\/skills\/([a-z0-9][a-z0-9-]{0,63})$/.exec(p);
    if (skillMatch) {
      const slug = skillMatch[1];
      if (req.method === "GET") {
        try {
          const client = await sharedSkillClient();
          const skill = await fetchStudioSkill({ ...client, slug });
          if (!skill) throw new Error("that shared skill was not found");
          return json(res, 200, { skill: { slug: skill.slug, name: skill.name, description: skill.description, content: skill.skill_md, version: skill.version, source: "shared" } });
        } catch (err) {
          const local = (await globalStudioSkills()).find((skill) => skill.slug === slug && skill.source === "local");
          if (!local) return json(res, 404, { error: String(err.message) });
          return json(res, 200, { skill: { slug: local.slug, name: local.name, description: local.description, content: await readFile(local.file, "utf8"), source: "local" } });
        }
      }
      if (req.method === "POST") {
        try {
          const body = JSON.parse(await text(req));
          const content = String(body.content ?? "");
          if (!content.trim()) return json(res, 400, { error: "a skill needs a SKILL.md instruction" });
          const saved = await updateSharedSkillText(slug, content);
          return json(res, 200, { skill: { slug: saved.slug, name: saved.name, description: saved.description, content: saved.skill_md, version: saved.version, source: "shared" }, studio: await globalStudioSkills() });
        } catch (err) {
          return json(res, 400, { error: String(err.message) });
        }
      }
      return json(res, 405, { error: "method not allowed" });
    }

    if (p === "/api/skills" && req.method === "GET") {
      let shared = { available: false, error: null, count: 0 };
      try {
        const remote = await syncSharedSkills();
        shared = { available: true, error: null, count: remote.length };
      } catch (err) {
        shared.error = String(err.message);
      }
      const studio = await globalStudioSkills();
      const standard = {
        available: standardAvailable(),
        root: STANDARD_ROOT,
        hyperframesSkill: standardAvailable() ? relative(STANDARD_ROOT, STANDARD_HYPERFRAMES_SKILL) : null,
      };
      const r = await capture("npx", ["--no-install", "hyperframes", "skills", "check"]);
      // Strip the ANSI the CLI paints its counts with.
      const text = `${r.out}${r.err}`.replace(/\x1b\[[0-9;]*m/g, "");
      if (!r.ok && !text.includes("skills")) {
        return json(res, 200, { studio, standard, shared, ok: false, why: "hyperframes is not reachable — it is fetched with npx on first use" });
      }
      const num = (label) => {
        const m = text.match(new RegExp(`(\\d+)\\s+${label}`));
        return m ? Number(m[1]) : 0;
      };
      const loc = text.match(/Location\s+(\S+)\s+\(([^)]+)\)/);
      const outdated = num("outdated");
      const missing = num("core not installed");
      return json(res, 200, {
        studio,
        standard,
        shared,
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

      // Slugged on the next line, so this one only has to be writable.
      const safe = safeName(body.name, "demo");
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
      // has not run `pnpm install` yet, but a pinned local binary is the point of
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
    if (p === "/api/voice/draft" && req.method === "GET") {
      const id = url.searchParams.get("project");
      const scriptName = url.searchParams.get("script");
      const m = id ? await readManifest(projectDir(id)).catch(() => null) : null;
      if (!m) return json(res, 404, { error: "pick a project" });
      if (!scriptName) return json(res, 400, { error: "pick a script" });
      const source = await readFile(voiceDraftPath(id, scriptName), "utf8").catch(() => null);
      return json(res, 200, { lines: source === null ? null : source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) });
    }

    if (p === "/api/voice/draft" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = body.projectId;
      const m = await readManifest(projectDir(id)).catch(() => null);
      if (!m) return json(res, 404, { error: "pick a project" });
      if (!body.script) return json(res, 400, { error: "pick a script" });
      if (!Array.isArray(body.lines)) return json(res, 400, { error: "send narration lines" });
      const lines = body.lines.map((line) => String(line).trim()).filter(Boolean);
      if (!lines.length) return json(res, 400, { error: "add at least one narration line" });
      if (lines.length > 500 || lines.join("\n").length > 100_000) return json(res, 400, { error: "that narration draft is too large" });
      const target = voiceDraftPath(id, body.script);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, `${lines.join("\n")}\n`, "utf8");
      return json(res, 200, { ok: true, lines: lines.length });
    }

    if (p === "/api/voice" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = body.projectId;
      const m = await readManifest(projectDir(id)).catch(() => null);
      if (!m) return json(res, 404, { error: "pick a project" });
      if (!body.script) return json(res, 400, { error: "pick a script" });

      const editedLines = Array.isArray(body.lines) ? body.lines.map((line) => String(line).trim()).filter(Boolean) : null;
      if (editedLines && !editedLines.length) return json(res, 400, { error: "add at least one narration line" });
      if (editedLines && (editedLines.length > 500 || editedLines.join("\n").length > 100_000)) return json(res, 400, { error: "that narration draft is too large" });
      let buildSource = null;
      if (editedLines) {
        const target = voiceDraftPath(id, body.script);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, `${editedLines.join("\n")}\n`, "utf8");
        // Give this job its own immutable input. Reusing the draft here meant a
        // delayed autosave could cause the renderer to speak an older script.
        const buildId = randomUUID();
        const targetSnapshot = voiceBuildPath(id, body.script, buildId);
        await mkdir(dirname(targetSnapshot), { recursive: true });
        await writeFile(targetSnapshot, `${editedLines.join("\n")}\n`, "utf8");
        buildSource = join("voice", "builds", `${safeName(body.script, "narration")}-${buildId}.md`);
      }

      // `rm-voice` exists on PATH only after a Homebrew install. In a checkout it
      // does not, so resolve the script ourselves rather than handing the user a
      // command that works on one machine and not the other.
      const onPath = await capture("sh", ["-c", "command -v rm-voice"]);
      const script = join(TOOLKIT, "bin", "rm-voice.mjs");
      const provider = body.provider || "kokoro";
      const rest = [
        id,
        "--script", body.script,
        ...(buildSource ? ["--source", buildSource] : []),
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
        await globalSkillDirection(),
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
        step: { ...await studioAgentStep({ prompt, cwd: dir, label: `draft ${nm}` }), project: id },
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
        region: cfg.region ?? null,
        accessKeyId: cfg.access_key_id ?? null,
        hasSecret: Boolean(cfg.secret_access_key),
      };
    };

    /*
     * `/api/storage/<name>` — the remote ITSELF, one segment and no more.
     *
     * Scoped that way because the browse routes below are
     * `/api/storage/<name>/<verb>`, and this used to take everything after the
     * prefix: "openframe/ls" is not a remote name, so the guard under it
     * answered 400 and no browse route was ever reached.
     */
    const storageName = /^\/api\/storage\/[^/]+$/.test(p) ? decodeURIComponent(p.slice("/api/storage/".length)) : null;

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
      if (b.provider) args.push("provider", String(b.provider));
      if (b.region) args.push("region", String(b.region));
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

    /*
     * Looking inside a remote, and moving things around in it.
     *
     * The Storage panel could create a remote and list its buckets, and that was
     * the end of it: everything a bucket then held was invisible from here. A
     * render is uploaded and then never seen again — you go to the Cloudflare
     * dashboard, or you run rclone by hand, to answer "did that land" and "what
     * is in there".
     *
     * Every one of these is an rclone subcommand, because rclone is already the
     * thing that speaks S3 here and a second S3 client would be a second set of
     * credentials to keep in step.
     *
     * `remotePath` is the whole safety story. A remote name and a path are both
     * spliced into an argv, so both are checked: the name against REMOTE_NAME as
     * before, and the path for the two things that turn a path into something
     * else — a leading dash, which rclone reads as a flag, and `..`, which walks
     * out of the prefix the caller thinks it is confined to.
     */
    const remotePath = (name, path) => {
      if (!REMOTE_NAME.test(String(name ?? ""))) return null;
      const clean = String(path ?? "")
        .replace(/^\/+/, "")
        .replace(/\/+$/, "");
      if (!clean) return `${name}:`;
      // A leading "-" on any segment is a flag to rclone, and ".." escapes the
      // prefix. Neither can appear in a name we are willing to build an argv from.
      if (clean.split("/").some((seg) => seg === ".." || seg === "." || seg.startsWith("-"))) return null;
      return `${name}:${clean}`;
    };

    /*
     * Copy a complete project to its shared-storage home.
     *
     * A project is more than the media files shown in the Library: its manifest,
     * scripts, scenes, board and interview all make the work usable by somebody
     * else. `rclone copy` sends that whole directory in the background and leaves
     * the local project in place, because removing the working copy would turn a
     * successful upload into an editor full of missing files.
     */
    if (p === "/api/project/storage" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = String(body.projectId ?? "");
      const remote = String(body.remote ?? "");
      if (!id || !REMOTE_NAME.test(remote)) return json(res, 400, { error: "choose a project and a storage destination" });
      const dir = projectDir(id);
      const manifest = await readManifest(dir).catch(() => null);
      if (!manifest) return json(res, 404, { error: "that project is no longer in this library" });
      const destination = remotePath(remote, `openscreen/projects/${id}`);
      if (!destination) return json(res, 400, { error: "that storage destination is not valid" });
      const active = projectTransfers.get(id);
      if (active?.state === "sending") return json(res, 202, active);

      const transfer = {
        state: "sending",
        destination,
        project: manifest.name,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        error: null,
      };
      projectTransfers.set(id, transfer);
      const copy = spawn("rclone", ["copy", dir, destination, "--create-empty-src-dirs", "--stats-one-line", "--stats", "2s"], {
        cwd: dir,
        stdio: "ignore",
      });
      copy.on("error", (err) => {
        projectTransfers.set(id, { ...transfer, state: "failed", finishedAt: new Date().toISOString(), error: String(err.message) });
      });
      copy.on("close", (code) => {
        projectTransfers.set(id, {
          ...transfer,
          state: code === 0 ? "sent" : "failed",
          finishedAt: new Date().toISOString(),
          error: code === 0 ? null : "Storage could not finish the transfer.",
        });
      });
      return json(res, 200, {
        destination,
        ...transfer,
      });
    }

    if (p === "/api/project/storage" && req.method === "GET") {
      const id = String(new URL(req.url, "http://studio.local").searchParams.get("project") ?? "");
      const manifest = await readManifest(projectDir(id)).catch(() => null);
      if (!manifest) return json(res, 404, { error: "pick a project" });
      return json(res, 200, projectTransfers.get(id) ?? { state: "idle", destination: null, project: manifest.name, startedAt: null, finishedAt: null, error: null });
    }

    const storageOp = p.startsWith("/api/storage/") ? p.slice("/api/storage/".length).split("/") : [];
    const opRemote = storageOp.length > 1 ? decodeURIComponent(storageOp[0]) : null;
    const opName = storageOp.length > 1 ? storageOp[1] : null;

    /*
     * One level of a remote, as JSON.
     *
     * `lsjson` rather than `ls` because parsing rclone's human output is how you
     * get a file called "2024 final.mp4" split into three columns. --max-depth 1
     * keeps this a directory listing: recursing a bucket of renders to draw one
     * folder is minutes of API calls for rows nobody asked to see.
     */
    if (opName === "ls" && req.method === "GET") {
      const target = remotePath(opRemote, new URL(req.url, "http://studio.local").searchParams.get("path"));
      if (!target) return json(res, 400, { error: "that is not a path this can list" });
      const r = await capture("rclone", ["lsjson", target, "--max-depth", "1"]);
      if (!r.ok) return json(res, 200, { ok: false, entries: [], err: r.err.trim() });
      let entries = [];
      try {
        entries = JSON.parse(r.out);
      } catch {
        return json(res, 200, { ok: false, entries: [], err: "rclone did not return a listing" });
      }
      return json(res, 200, {
        ok: true,
        entries: entries.map((e) => ({
          name: e.Name,
          size: e.Size,
          modified: e.ModTime,
          dir: Boolean(e.IsDir),
          mime: e.MimeType ?? null,
        })),
      });
    }

    /*
     * Put a file in, streamed.
     *
     * `rcat` reads the object from stdin, so a browser upload goes straight
     * through without ever being a file on this machine. A render is gigabytes;
     * buffering one to disk to send it somewhere else is a copy nobody needs and
     * a temp file somebody has to clean up.
     */
    if (opName === "put" && req.method === "POST") {
      const q = new URL(req.url, "http://studio.local").searchParams;
      const dir = q.get("path") ?? "";
      const file = basename(String(q.get("name") ?? "")).trim();
      if (!file) return json(res, 400, { error: "that upload had no filename" });
      const target = remotePath(opRemote, dir ? `${dir}/${file}` : file);
      if (!target) return json(res, 400, { error: "that is not a path this can write to" });

      const child = spawn("rclone", ["rcat", target], { stdio: ["pipe", "pipe", "pipe"] });
      let err = "";
      child.stderr.on("data", (d) => {
        err += d;
      });
      const code = await new Promise((done) => {
        req.pipe(child.stdin);
        req.on("error", () => child.kill());
        child.on("error", (e) => {
          err += String(e);
          done(1);
        });
        child.on("close", done);
      });
      return code === 0
        ? json(res, 200, { ok: true, file })
        : json(res, 500, { error: err.trim() || `rclone exited ${code}` });
    }

    /*
     * Take one out, streamed the same way.
     *
     * `cat` rather than a signed URL: the credential lives in rclone's config on
     * this machine and has no business being minted into a link the browser then
     * holds. The cost is that the bytes come through here, which for one file
     * somebody clicked is not a cost worth a second auth path.
     */
    if (opName === "get" && req.method === "GET") {
      const q = new URL(req.url, "http://studio.local").searchParams;
      const target = remotePath(opRemote, q.get("path"));
      if (!target || target.endsWith(":")) {
        res.writeHead(400);
        return res.end();
      }
      const file = basename(String(q.get("path") ?? "")) || "download";
      const child = spawn("rclone", ["cat", target], { stdio: ["ignore", "pipe", "pipe"] });
      res.writeHead(200, {
        "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
        "content-disposition": `inline; filename="${file.replace(/"/g, "")}"`,
      });
      return child.stdout.pipe(res);
    }

    if (opName === "mkdir" && req.method === "POST") {
      const b = JSON.parse(await text(req));
      const target = remotePath(opRemote, b.path);
      if (!target || target.endsWith(":")) return json(res, 400, { error: "name the folder" });
      const r = await capture("rclone", ["mkdir", target]);
      return r.ok ? json(res, 200, { ok: true }) : json(res, 500, { error: r.err.trim() });
    }

    /*
     * Move, which is also rename and also what a drag onto a folder does.
     *
     * One verb for all three because in object storage they are one operation —
     * there are no directories to move BETWEEN, only keys with slashes in them.
     * `moveto` rather than `move`: `move` treats its destination as a directory
     * and would put the file inside a folder named after the new name.
     */
    if (opName === "mv" && req.method === "POST") {
      const b = JSON.parse(await text(req));
      const from = remotePath(opRemote, b.from);
      const to = remotePath(opRemote, b.to);
      if (!from || !to || from.endsWith(":") || to.endsWith(":")) {
        return json(res, 400, { error: "a move needs a source and a destination" });
      }
      if (from === to) return json(res, 200, { ok: true, unchanged: true });
      const r = await capture("rclone", [b.dir ? "move" : "moveto", from, to]);
      return r.ok ? json(res, 200, { ok: true }) : json(res, 500, { error: r.err.trim() });
    }

    /*
     * And take something away.
     *
     * A folder is `purge`, which removes what is under it — there is no such
     * thing as an empty directory to remove instead, and refusing to delete a
     * non-empty one would mean the panel could create folders it could never get
     * rid of. The confirmation for that lives in the UI, where the person is.
     */
    if (opName === "rm" && req.method === "POST") {
      const b = JSON.parse(await text(req));
      const target = remotePath(opRemote, b.path);
      if (!target || target.endsWith(":")) return json(res, 400, { error: "that is not a path this can remove" });
      const r = await capture("rclone", [b.dir ? "purge" : "deletefile", target]);
      return r.ok ? json(res, 200, { ok: true }) : json(res, 500, { error: r.err.trim() });
    }

    if (p === "/api/storage" && req.method === "POST") {
      const b = JSON.parse(await text(req));
      if (!REMOTE_NAME.test(String(b.name ?? ""))) {
        return json(res, 400, { ok: false, err: "a remote name is letters, digits, dash and underscore" });
      }
      /*
       * Which S3, not just Cloudflare's.
       *
       * `provider` was pinned to "Cloudflare", so the panel could only ever make
       * an R2 remote — and rclone uses that value to decide which dialect of S3
       * it is speaking, so pointing the old form at an AWS endpoint produced a
       * remote that authenticated and then failed on operations. R2 stays the
       * default because it is what this pipeline recommends and it has no egress
       * fee, which is the line item that hurts with video.
       *
       * AWS wants a region and no endpoint; R2 and the rest want an endpoint and
       * no region. Sending the empty one anyway writes a blank key into the
       * config that rclone then honours as "" rather than as absent.
       */
      const PROVIDERS = new Set(["Cloudflare", "AWS", "Minio", "Wasabi", "DigitalOcean", "Other"]);
      const provider = PROVIDERS.has(String(b.provider)) ? String(b.provider) : "Cloudflare";
      const args = [
        "config", "create", b.name, "s3",
        "provider", provider,
        "access_key_id", b.accessKeyId,
        "secret_access_key", b.secretAccessKey,
        "acl", "private",
      ];
      if (b.endpoint) args.push("endpoint", b.endpoint);
      if (b.region) args.push("region", b.region);
      const r = await capture("rclone", args);
      return json(res, r.ok ? 200 : 500, { ok: r.ok, out: r.out, err: r.err });
    }

    /* ── jobs ──────────────────────────────────────────────────────────────
       Running the pipeline instead of describing it. See lib/jobs.mjs for the
       two rules that keep this from being a footgun: allowlisted binaries, and
       free-text only behind --shell. */

    if (p === "/api/jobs") return json(res, 200, { jobs: jobs.list(), shell: SHELL });

    // The Console answers "what happened?" one run at a time. Usage answers
    // the other question people need after a stretch of experimentation: how
    // much work did the Studio run, and what did the agent actually report as
    // tokens and spend? `usageReport` reads the same durable journal as the
    // Console, so a restart does not reset the accounting.
    if (p === "/api/usage") return json(res, 200, jobs.usageReport());

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
        let step = {
          bin: String(b.bin),
          args: Array.isArray(b.args) ? b.args.map(String) : [],
          label: b.label,
          cwd: b.cwd,
        };

        /*
         * A Studio tab can survive a server update. Older tabs held an export
         * command for the visual-only .openscreen cut list, which OpenScreen's
         * CLI cannot read and which could never carry the aligned narration.
         *
         * Translate that exact retired job at the server boundary. A reload is
         * still useful for the clearer labels, but an already-open tab can no
         * longer send someone into the invalid-document failure loop.
         */
        if (project && step.label === "render visual narration alignment") {
          const alignment = await readAudioAlignment(project).catch(() => null);
          const replacement = await audioAlignmentRenderSteps(project, alignment).catch(() => ({}));
          if (replacement.renderStep) step = replacement.renderStep;
        }
        const j = jobs.run({
          bin: step.bin,
          args: step.args,
          label: step.label,
          cwd: step.cwd,
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
    /*
     * An added asset, served from the library.
     *
     * A separate prefix from /brand/, which resolves against TOOLKIT — these are
     * deliberately not there, so they cannot be reached through it.
     */
    if (p.startsWith("/added/")) {
      const file = join(ADDED_DIR, basename(decodeURIComponent(p.slice("/added/".length))));
      const st = await stat(file).catch(() => null);
      if (!st?.isFile()) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, {
        "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
        "content-length": st.size,
      });
      return createReadStream(file).pipe(res);
    }

    if (p.startsWith("/components/") || p.startsWith("/brand/") || p.startsWith("/assets/")) {
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
      if (css == null) return json(res, 404, { error: "no icon set — run `pnpm run icons`" });
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
        if (!bytes) return json(res, 404, { error: `${name} is missing — run \`pnpm run icons\`` });
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
        else parts.push(`/* ${f} missing — run \`pnpm run optics\` */\n`);
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

    /* Canvas cards need a durable preview of their saved scene rather than the
       temporary editor frame. Resolve only a slug beneath this project's scenes
       folder, so the thumbnail survives reloads without becoming a file reader. */
    if (p === "/api/scene/frame" && req.method === "GET") {
      const q = new URL(req.url, "http://studio.local").searchParams;
      const id = String(q.get("project") ?? "");
      const name = wpSlug(String(q.get("scene") ?? ""));
      const man = await readManifest(projectDir(id)).catch(() => null);
      if (!man || !name) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        return res.end("no such scene\n");
      }
      const body = await readFile(join(projectDir(id), "scenes", `${name}.html`), "utf8").catch(() => null);
      if (body == null) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        return res.end("no such scene\n");
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": WATCH ? "no-store" : "max-age=60" });
      // Title and other entering components are invisible at frame zero. This
      // is a Canvas thumbnail, not a playback start position, so seek a moment
      // into the saved scene where its authored treatment can actually be seen.
      return res.end(sceneHtml({ body, title: name, base: "", previewAt: 750 }));
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

    /*
     * ───────────────────── durable video progress ────────────────────────
     *
     * The files a stage creates already live in the project. This compact record
     * answers the complementary question: which stage a person was in when they
     * left, so a reopened project can continue instead of looking like a blank
     * collection of unrelated tools.
     */
    if (p === "/api/workflow" && req.method === "GET") {
      const id = String(new URL(req.url, "http://studio.local").searchParams.get("project") ?? "");
      const manifest = await readManifest(projectDir(id)).catch(() => null);
      if (!manifest) return json(res, 404, { error: "pick a project" });
      try {
        return json(res, 200, { workflow: await readWorkflow(id) });
      } catch (err) {
        return json(res, 400, { error: String(err.message) });
      }
    }

    if (p === "/api/workflow/stage" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = String(body.projectId ?? "");
      const manifest = await readManifest(projectDir(id)).catch(() => null);
      if (!manifest) return json(res, 404, { error: "pick a project" });
      try {
        return json(res, 200, { workflow: await markWorkflowStage(id, String(body.stage ?? "")) });
      } catch (err) {
        return json(res, 400, { error: String(err.message) });
      }
    }

    if (p === "/api/workflow/restart" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = String(body.projectId ?? "");
      const manifest = await readManifest(projectDir(id)).catch(() => null);
      if (!manifest) return json(res, 404, { error: "pick a project" });
      try {
        return json(res, 200, await restartWorkflow(id));
      } catch (err) {
        return json(res, 500, { error: String(err.message) });
      }
    }

    /*
     * ──────────────────────────── the interview ──────────────────────────
     *
     * The interview is durable project work, not an in-browser chat.  A person
     * can leave while Claude thinks, another teammate can pick it back up, and
     * the shot list carries the answers that produced it into Storyboard.
     */
    if (p === "/api/interview" && req.method === "GET") {
      const id = String(new URL(req.url, "http://studio.local").searchParams.get("project") ?? "");
      const manifest = await readManifest(projectDir(id)).catch(() => null);
      if (!manifest) return json(res, 404, { error: "pick a project" });
      try {
        // Interview is the first Studio screen for a new project. Refresh the
        // shared cache here instead of requiring someone to visit Skills first:
        // otherwise a perfectly healthy Supabase library looks empty until a
        // completely unrelated screen happens to hydrate it.
        await syncSharedSkills().catch(() => {});
        const state = await readInterview(id);
        return json(res, 200, { state, phase: interviewState(state), skills: await globalStudioSkills() });
      } catch (err) {
        return json(res, 400, { error: String(err.message) });
      }
    }

    if (p === "/api/interview/start" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = String(body.projectId ?? "");
      const manifest = await readManifest(projectDir(id)).catch(() => null);
      if (!manifest) return json(res, 404, { error: "pick a project" });
      const state = { version: 1, turns: [{ question: FIRST_QUESTION, answer: "" }], plan: null, pendingReply: false };
      await writeInterview(id, state);
      // An interview is the beginning of a video, even before the first answer.
      // Persist that fact here rather than waiting for a later navigation event:
      // leaving and returning should continue the work, not invite a restart.
      const workflow = await markWorkflowStage(id, "plan");
      return json(res, 200, { state, workflow, phase: interviewState(state) });
    }

    if (p === "/api/interview/answer" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = String(body.projectId ?? "");
      const answer = String(body.answer ?? "").trim();
      const manifest = await readManifest(projectDir(id)).catch(() => null);
      if (!manifest) return json(res, 404, { error: "pick a project" });
      if (!answer) return json(res, 400, { error: "write an answer first" });
      try {
        const state = await readInterview(id);
        const turn = state.turns.at(-1);
        if (!turn) throw new Error("start the interview first");
        if (String(turn.answer ?? "").trim()) throw new Error("Claude is already working on that answer");
        turn.answer = answer;
        state.pendingReply = true;
        await writeInterview(id, state);
        const seconds = Number(body.seconds) || null;
        const prompt = `${buildTurnPrompt({ turns: state.turns, seconds, project: manifest.name })}${await globalSkillDirection()}\n\nUse the relevant shared skills to shape the interview's next question and the resulting video plan. Do not mention the skills to the person answering.\n\nWrite only that JSON to ${interviewReplyPath(id)}.`;
        await writeFile(join(interviewDir(id), "prompt.txt"), `${prompt}\n`, "utf8");
        return json(res, 200, {
          state,
          step: { ...await studioAgentStep({ prompt, cwd: interviewDir(id), label: `interview ${manifest.name}` }), project: id },
        });
      } catch (err) {
        return json(res, 400, { error: String(err.message) });
      }
    }

    if (p === "/api/interview/next" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = String(body.projectId ?? "");
      const manifest = await readManifest(projectDir(id)).catch(() => null);
      if (!manifest) return json(res, 404, { error: "pick a project" });
      try {
        const state = await readInterview(id);
        if (!state.pendingReply) throw new Error("answer the current question before loading Claude's reply");
        const raw = await readFile(interviewReplyPath(id), "utf8").catch((err) => {
          if (err?.code === "ENOENT") {
            throw new Error("Claude has not saved the next question yet. Keep this page open while it finishes, then try Load Claude’s reply again.");
          }
          throw err;
        });
        const next = readTurn(parseTurn(raw));
        if (next.kind === "ambiguous") throw new Error(next.problem);
        if (next.kind === "ask") {
          state.turns.push({ question: next.question, answer: "" });
          state.plan = null;
        } else {
          state.plan = planToBrief(next, {
            projectId: id,
            seconds: Number(body.seconds) || null,
            drafted: new Date().toISOString(),
            turns: state.turns,
          });
          state.problems = next.problems;
        }
        state.pendingReply = false;
        await writeInterview(id, state);
        /* The completed interview already names the video scenes. Materialize
         * those canvas nodes here, through the normal board writer, so the
         * interview immediately leaves something editable rather than asking a
         * person to repeat "build canvas" on the next page. */
        let board = null;
        if (state.plan?.shots?.length) {
          const dir = projectDir(id);
          const prior = await readBoard(dir, { projectId: id, title: manifest.name });
          board = await applyToBoard(
            dir,
            prior,
            { type: "slots", at: new Date().toISOString(), by: await reviewerName(), count: state.plan.shots.length, source: "interview" },
            (nextBoard) => {
              nextBoard.brief = state.plan;
              nextBoard.slots = slotsFromBrief(id, state.plan);
              return nextBoard;
            },
          );
        }
        return json(res, 200, { state, board, phase: interviewState(state) });
      } catch (err) {
        return json(res, 400, { error: String(err.message) });
      }
    }

    /*
     * ─────────────────────────── the paper edit ──────────────────────────
     *
     * A transcript is deliberately kept next to the project, not inside the
     * browser.  That lets a teammate open the same review, and means the source
     * words, Claude's selection and the resulting cut remain one inspectable
     * record rather than three ephemeral UI states.
     */
    if (p === "/api/multi-assembly" && req.method === "GET") {
      const id = String(new URL(req.url, "http://studio.local").searchParams.get("project") ?? "");
      const manifest = await readManifest(projectDir(id)).catch(() => null);
      if (!manifest) return json(res, 404, { error: "pick a project" });
      const state = await recoverMultiAssemblySelection(id).catch(() => readMultiAssembly(id));
      return json(res, 200, { state, preparation: await multiAssemblyPreparation(id, state?.sources ?? []) });
    }

    if (p === "/api/multi-assembly/audio-align" && req.method === "GET") {
      const id = String(new URL(req.url, "http://studio.local").searchParams.get("project") ?? "");
      const manifest = await readManifest(projectDir(id)).catch(() => null);
      if (!manifest) return json(res, 404, { error: "pick a project" });
      try {
        const state = await readAudioAlignment(id).catch(() => null);
        return json(res, 200, { state, ...(await audioAlignmentRenderSteps(id, state)) });
      } catch (err) {
        return json(res, 400, { error: String(err.message) });
      }
    }

    if (p === "/api/multi-assembly/analyze" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = String(body.projectId ?? "");
      try {
        const rels = [...new Set((Array.isArray(body.rels) ? body.rels : []).map(String).filter(Boolean))];
        if (!rels.length) throw new Error("choose at least one screen recording");
        const steps = [];
        for (const rel of rels) {
          const file = await paperEditMedia(id, rel);
          if (!/\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(file)) throw new Error(`${basename(rel)} is not a video recording`);
          const output = visualBeatDir(id, rel);
          steps.push({ rel, step: ownStep("rm-visual-beats", ["--input", file, "--output", output, "--source", rel], { label: `analyze screen ${rel}`, cwd: multiAssemblyDir(id), project: id, note: "Samples timestamped screen frames for Claude to inspect before it chooses a cut." }) });
        }
        return json(res, 200, { steps });
      } catch (err) {
        return json(res, 400, { error: String(err.message) });
      }
    }

    if (p === "/api/multi-assembly/transcribe" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = String(body.projectId ?? "");
      try {
        const rels = [...new Set((Array.isArray(body.rels) ? body.rels : []).map(String).filter(Boolean))];
        if (!rels.length) throw new Error("choose at least one recording");
        const prior = await readMultiAssembly(id);
        // Source choice is work too. Persist it before the jobs start so a
        // refresh while Whisper is running does not make a person reselect a
        // handful of camera angles just to see their progress.
        const sameSources = JSON.stringify(prior?.sources ?? []) === JSON.stringify(rels);
        await writeMultiAssembly(id, { version: 1, sources: rels, notes: prior?.notes ?? "", picks: sameSources ? prior?.picks ?? [] : [], comments: sameSources ? prior?.comments ?? {} : {} });
        const steps = [];
        for (const rel of rels) {
          const file = await paperEditMedia(id, rel);
          if (!/\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(file)) throw new Error(`${basename(rel)} is not a video recording`);
          await mkdir(paperEditDir(id), { recursive: true });
          steps.push({ rel, step: ownStep("rm-transcribe", ["--input", file, "--output", paperEditTranscriptPath(id, rel), "--language", String(body.language ?? "en")], { label: `transcribe ${rel}`, cwd: paperEditDir(id), project: id, note: "Creates a timed transcript for this Assembly source in the background." }) });
        }
        return json(res, 200, { steps });
      } catch (err) {
        return json(res, 400, { error: String(err.message) });
      }
    }

    /*
     * The actual batch entry point. A person chooses the clips once; Studio
     * persists that choice, starts only missing transcript/frame jobs, and the
     * client asks Claude for the assembly once those jobs finish.
     */
    if (p === "/api/multi-assembly/prepare" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = String(body.projectId ?? "");
      try {
        const rels = [...new Set((Array.isArray(body.rels) ? body.rels : []).map(String).filter(Boolean))];
        if (!rels.length) throw new Error("choose at least one project recording");
        if (rels.length > 8) throw new Error("choose up to eight recordings for one assembly");
        const prior = await readMultiAssembly(id);
        const sameSources = JSON.stringify(prior?.sources ?? []) === JSON.stringify(rels);
        await writeMultiAssembly(id, {
          version: 1,
          sources: rels,
          notes: String(body.notes ?? prior?.notes ?? ""),
          scriptName: safeName(body.scriptName ?? prior?.scriptName, "") || null,
          picks: sameSources ? prior?.picks ?? [] : [],
          comments: sameSources ? prior?.comments ?? {} : {},
        });
        const prepared = await multiAssemblyPreparation(id, rels);
        const steps = [];
        for (const item of prepared) {
          if (item.missing) throw new Error(`${basename(item.rel)} is no longer a project video`);
          const file = await paperEditMedia(id, item.rel);
          if (!item.transcript) {
            await mkdir(paperEditDir(id), { recursive: true });
            steps.push({ rel: item.rel, kind: "transcript", step: ownStep("rm-transcribe", ["--input", file, "--output", paperEditTranscriptPath(id, item.rel), "--language", String(body.language ?? "en")], { label: `transcribe ${basename(item.rel)}`, cwd: paperEditDir(id), project: id, note: "Creates a timed transcript for this Assembly source in the background." }) });
          }
          if (!item.visual) {
            steps.push({ rel: item.rel, kind: "screen", step: ownStep("rm-visual-beats", ["--input", file, "--output", visualBeatDir(id, item.rel), "--source", item.rel], { label: `analyze screen ${basename(item.rel)}`, cwd: multiAssemblyDir(id), project: id, note: "Samples timestamped screen frames so Claude can verify what the clip shows." }) });
          }
        }
        return json(res, 200, { steps, preparation: prepared });
      } catch (err) {
        return json(res, 400, { error: String(err.message) });
      }
    }

    if (p === "/api/multi-assembly/draft" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = String(body.projectId ?? "");
      try {
        const sources = await multiAssemblySources(id, body.rels);
        const prior = await readMultiAssembly(id);
        const feedback = Object.entries(prior?.comments ?? {}).map(([pickId, comment]) => {
          const pick = prior?.picks?.find((item) => item.id === pickId);
          return pick ? `${pick.source} ${pick.inSec}-${pick.outSec}: ${comment}` : null;
        }).filter(Boolean).join("\n");
        const notes = [String(body.notes ?? "").trim(), feedback ? `REVIEW COMMENTS TO APPLY:\n${feedback}` : ""].filter(Boolean).join("\n\n");
        const scriptName = safeName(body.scriptName ?? prior?.scriptName, "");
        const scriptBody = scriptName ? await readFile(join(projectDir(id), "scripts", `${scriptName}.md`), "utf8").catch(() => "") : "";
        const script = scriptBody ? { name: scriptName, body: scriptBody } : null;
        const prompt = `${multiAssemblyPrompt({ sources, notes, script })}${await globalSkillDirection()}\n\nWrite the JSON to ${multiAssemblySelectionPath(id)}. Also write a concise EDL to ${join(multiAssemblyDir(id), "multi-clip.edl.md")} with one row per selected passage: order, source, spoken text, and editorial reason.${script ? ` Write a skeleton-manifest.json beside it that records the script beats, gaps, and parked material for the later video-b-roll pass.` : ""} Do not alter source recordings or transcripts.`;
        await mkdir(multiAssemblyDir(id), { recursive: true });
        await rm(multiAssemblySelectionPath(id), { force: true });
        await writeFile(join(multiAssemblyDir(id), "multi-clip.prompt.txt"), `${prompt}\n`, "utf8");
        await writeMultiAssembly(id, { version: 1, sources: sources.map((source) => source.rel), notes: String(body.notes ?? ""), scriptName: script?.name ?? null, picks: prior?.picks ?? [], comments: prior?.comments ?? {} });
        return json(res, 200, { step: { ...await studioAgentStep({ prompt, cwd: multiAssemblyDir(id), label: "multi-clip assembly" }), project: id } });
      } catch (err) {
        return json(res, 400, { error: String(err.message) });
      }
    }

    if (p === "/api/multi-assembly/selection" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = String(body.projectId ?? "");
      try {
        const prior = await readMultiAssembly(id);
        const sources = await multiAssemblySources(id, body.rels ?? prior?.sources);
        const raw = body.fromFile ? await readFile(multiAssemblySelectionPath(id), "utf8") : JSON.stringify(body.selection ?? {});
        const checked = validateMultiAssemblySelection(parseMultiAssemblySelection(raw), sources);
        const comments = prior?.comments ?? {};
        await writeMultiAssembly(id, { version: 1, sources: sources.map((source) => source.rel), notes: prior?.notes ?? "", picks: checked.picks, comments });
        return json(res, 200, { state: await readMultiAssembly(id), problems: checked.problems });
      } catch (err) {
        return json(res, 400, { error: String(err.message) });
      }
    }

    if (p === "/api/multi-assembly/comments" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = String(body.projectId ?? "");
      try {
        const state = await readMultiAssembly(id);
        if (!state?.picks?.some((pick) => pick.id === body.pickId)) throw new Error("that assembly pick is no longer available");
        const comments = { ...(state.comments ?? {}) };
        const value = String(body.comment ?? "").trim();
        if (value) comments[String(body.pickId)] = value;
        else delete comments[String(body.pickId)];
        await writeMultiAssembly(id, { ...state, comments });
        return json(res, 200, { state: await readMultiAssembly(id) });
      } catch (err) {
        return json(res, 400, { error: String(err.message) });
      }
    }

    if (p === "/api/multi-assembly/build" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = String(body.projectId ?? "");
      try {
        const state = await readMultiAssembly(id);
        if (!state?.picks?.length) throw new Error("ask Claude to choose clips first");
        const files = new Map();
        for (const rel of state.sources ?? []) files.set(rel, await paperEditMedia(id, rel));
        const clips = state.picks.map((pick) => ({ path: files.get(pick.source), inSec: pick.inSec, outSec: pick.outSec, reason: pick.reason, label: basename(pick.source) }));
        if (clips.some((clip) => !clip.path)) throw new Error("one of the selected recordings is no longer in this project");
        const outDir = join(mediaDir(id), "Renders", "multi-clip-assembly");
        await mkdir(outDir, { recursive: true });
        const document = join(outDir, "multi-clip-assembly.openscreen");
        const doc = cutlistToDocument({ id: `${id}-multi-clip-assembly`, title: "Multi-clip assembly", clips, createdAt: new Date().toISOString() });
        await writeFile(document, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
        await writeFile(join(outDir, "assembly.json"), `${JSON.stringify({ ...state, document, clips }, null, 2)}\n`, "utf8");
        await writeMultiAssembly(id, { ...state, document, builtAt: new Date().toISOString() });
        return json(res, 200, { document, clips: doc.timeline.clips.length, durationSec: doc.timeline.clips.at(-1)?.timelineEndSec ?? 0 });
      } catch (err) {
        return json(res, 400, { error: String(err.message) });
      }
    }

    /*
     * A useful fallback when an AI pass is not good enough: put the chosen
     * recordings in order as whole clips. This is deliberately separate from
     * the AI build above — it preserves all source material and gives the
     * editor a concrete starting point without pretending Claude made picks.
     */
    if (p === "/api/multi-assembly/stack" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = String(body.projectId ?? "");
      try {
        const prior = await readMultiAssembly(id);
        const sources = await multiAssemblySources(id, body.rels ?? prior?.sources);
        const clips = sources.map((source) => ({
          path: source.file,
          inSec: 0,
          outSec: Number(source.visual.durationSec),
          reason: "Full source recording",
          label: basename(source.rel),
        }));
        if (clips.some((clip) => !Number.isFinite(clip.outSec) || clip.outSec <= 0)) throw new Error("screen analysis needs a duration before Studio can stack these recordings");
        const outDir = join(mediaDir(id), "Renders", "multi-clip-assembly");
        await mkdir(outDir, { recursive: true });
        const document = join(outDir, "source-recordings-stack.openscreen");
        const doc = cutlistToDocument({ id: `${id}-source-recordings-stack`, title: "Source recordings stack", clips, createdAt: new Date().toISOString() });
        await writeFile(document, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
        await writeFile(join(outDir, "source-recordings-stack.json"), `${JSON.stringify({ sources: sources.map((source) => source.rel), document, clips }, null, 2)}\n`, "utf8");
        await writeMultiAssembly(id, { ...prior, version: 1, sources: sources.map((source) => source.rel), document, stackedAt: new Date().toISOString() });
        return json(res, 200, { document, clips: doc.timeline.clips.length, durationSec: doc.timeline.clips.at(-1)?.timelineEndSec ?? 0 });
      } catch (err) {
        return json(res, 400, { error: String(err.message) });
      }
    }

    if (p === "/api/multi-assembly/audio-align/prepare" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = String(body.projectId ?? "");
      try {
        const videoRel = String(body.videoRel ?? "");
        const audioRel = String(body.audioRel ?? "");
        const video = await paperEditMedia(id, videoRel);
        const audio = await paperEditMedia(id, audioRel);
        if (!/\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(video)) throw new Error("choose a screen recording");
        if (!/\.(wav|mp3|m4a|aac|flac|ogg|opus|aiff)$/i.test(audio)) throw new Error("choose a project audio recording");
        await mkdir(multiAssemblyDir(id), { recursive: true });
        return json(res, 200, { steps: [
          { step: ownStep("rm-visual-beats", ["--input", video, "--output", visualBeatDir(id, videoRel), "--source", videoRel], { label: `analyze screen ${basename(videoRel)}`, cwd: multiAssemblyDir(id), project: id, note: "Creates visual evidence for the narration alignment." }) },
          { step: ownStep("rm-transcribe", ["--input", audio, "--output", paperEditTranscriptPath(id, audioRel), "--language", String(body.language ?? "en")], { label: `transcribe narration ${basename(audioRel)}`, cwd: paperEditDir(id), project: id, note: "Creates timed spoken cues for the narration recording." }) },
        ] });
      } catch (err) {
        return json(res, 400, { error: String(err.message) });
      }
    }

    if (p === "/api/multi-assembly/audio-align/draft" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = String(body.projectId ?? "");
      try {
        const sources = await audioAlignmentSources(id, String(body.videoRel ?? ""), String(body.audioRel ?? ""));
        const scriptName = safeName(body.scriptName, "");
        const script = scriptName ? await readFile(join(projectDir(id), "scripts", `${scriptName}.md`), "utf8").catch(() => "") : "";
        const prompt = `${audioAlignmentPrompt({ sources, script, notes: String(body.notes ?? "").trim() })}${await globalSkillDirection()}\n\nWrite the JSON to ${audioAlignmentSelectionPath(id)}. Do not alter source media, transcripts, or visual beat frames.`;
        await mkdir(multiAssemblyDir(id), { recursive: true });
        await writeFile(join(multiAssemblyDir(id), "audio-alignment.prompt.txt"), `${prompt}\n`, "utf8");
        await writeAudioAlignment(id, { version: 1, videoRel: sources.videoRel, audioRel: sources.audioRel, scriptName: scriptName || null, notes: String(body.notes ?? ""), segments: [] });
        return json(res, 200, { step: { ...await studioAgentStep({ prompt, cwd: multiAssemblyDir(id), label: "visual narration alignment" }), project: id } });
      } catch (err) {
        return json(res, 400, { error: String(err.message) });
      }
    }

    if (p === "/api/multi-assembly/audio-align/selection" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = String(body.projectId ?? "");
      try {
        const prior = await readAudioAlignment(id);
        const sources = await audioAlignmentSources(id, String(body.videoRel ?? prior?.videoRel ?? ""), String(body.audioRel ?? prior?.audioRel ?? ""));
        const raw = body.fromFile ? await readFile(audioAlignmentSelectionPath(id), "utf8") : JSON.stringify(body.selection ?? {});
        const checked = validateAudioAlignment(parseAudioAlignment(raw), sources);
        const state = { ...(prior ?? {}), version: 1, videoRel: sources.videoRel, audioRel: sources.audioRel, segments: checked.segments };
        await writeAudioAlignment(id, state);
        return json(res, 200, { state: await readAudioAlignment(id), problems: checked.problems });
      } catch (err) {
        return json(res, 400, { error: String(err.message) });
      }
    }

    if (p === "/api/multi-assembly/audio-align/build" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = String(body.projectId ?? "");
      try {
        const state = await readAudioAlignment(id);
        if (!state?.segments?.length) throw new Error("map the narration to screen moments first");
        const sources = await audioAlignmentSources(id, state.videoRel, state.audioRel);
        const clips = state.segments.map((segment) => ({ path: sources.video, inSec: segment.screenInSec, outSec: segment.screenOutSec, reason: segment.reason, label: basename(sources.videoRel) }));
        const outDir = join(mediaDir(id), "Renders", "audio-alignment");
        await mkdir(outDir, { recursive: true });
        const stem = `${wpSlug(basename(sources.videoRel, extname(sources.videoRel)))}-aligned-to-${wpSlug(basename(sources.audioRel, extname(sources.audioRel)))}`;
        const document = join(outDir, `${stem}.openscreen`);
        const renderedVideo = join(outDir, `${stem}.mp4`);
        const alignedAudio = join(outDir, `${stem}.wav`);
        const doc = cutlistToDocument({ id: `${id}-audio-alignment`, title: "Visual narration alignment", clips, createdAt: new Date().toISOString() });
        await writeFile(document, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
        const alignmentFile = join(outDir, "alignment.json");
        await writeFile(alignmentFile, `${JSON.stringify({ ...state, document, renderedVideo, alignedAudio, clips }, null, 2)}\n`, "utf8");
        const builtState = { ...state, document, renderedVideo, alignedAudio, builtAt: new Date().toISOString() };
        await writeAudioAlignment(id, builtState);
        return json(res, 200, {
          document,
          clips: clips.length,
          ...(await audioAlignmentRenderSteps(id, builtState)),
        });
      } catch (err) {
        return json(res, 400, { error: String(err.message) });
      }
    }

    if (p === "/api/paper-edit/recordings" && req.method === "GET") {
      const id = String(new URL(req.url, "http://studio.local").searchParams.get("project") ?? "");
      const manifest = await readManifest(projectDir(id)).catch(() => null);
      if (!manifest) return json(res, 404, { error: "pick a project" });
      try {
        return json(res, 200, { recordings: await paperEditRecordings(id) });
      } catch (err) {
        return json(res, 400, { error: String(err.message) });
      }
    }

    if (p === "/api/paper-edit" && req.method === "GET") {
      const q = new URL(req.url, "http://studio.local").searchParams;
      const id = String(q.get("project") ?? "");
      const rel = String(q.get("rel") ?? "");
      if (!id || !rel) return json(res, 400, { error: "choose a recording" });
      try {
        await paperEditMedia(id, rel);
        const state = await paperEditForRecording(id, rel);
        return json(res, 200, { state });
      } catch (err) {
        return json(res, 400, { error: String(err.message) });
      }
    }

    if (p === "/api/paper-edit/transcript" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = String(body.projectId ?? "");
      const rel = String(body.rel ?? "");
      try {
        await paperEditMedia(id, rel);
        const prior = await readPaperEdit(id, rel);
        const captions = body.fromFile ? await readFile(paperEditTranscriptPath(id, rel), "utf8") : body.captions;
        const transcript = transcriptFromCaptions(captions);
        const state = { version: 1, rel, transcript, plan: prior?.plan ?? { shots: [] }, selection: null, updatedAt: new Date().toISOString() };
        await writePaperEdit(id, rel, state);
        return json(res, 200, { state });
      } catch (err) {
        return json(res, 400, { error: String(err.message) });
      }
    }

    if (p === "/api/paper-edit/transcribe" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = String(body.projectId ?? "");
      const rel = String(body.rel ?? "");
      try {
        const file = await paperEditMedia(id, rel);
        await mkdir(paperEditDir(id), { recursive: true });
        const out = paperEditTranscriptPath(id, rel);
        // `rel`, not basename: `talk.mp4` in two folders is two recordings and
        // must not make one another look like an already-running job.
        const label = `transcribe ${rel}`;
        const existing = jobs.list().find((job) => job.running && job.label === label);
        if (existing) return json(res, 200, { job: existing, alreadyRunning: true });
        const step = ownStep("rm-transcribe", ["--input", file, "--output", out, "--language", String(body.language ?? "en")], { label, cwd: paperEditDir(id), project: id, note: "First transcription downloads a local speech model (about 142 MB). Later recordings reuse it." });
        return json(res, 200, { out, step });
      } catch (err) {
        return json(res, 400, { error: String(err.message) });
      }
    }

    if (p === "/api/paper-edit/plan" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = String(body.projectId ?? "");
      const rel = String(body.rel ?? "");
      try {
        await paperEditMedia(id, rel);
        const state = await readPaperEdit(id, rel);
        if (!state?.transcript) throw new Error("add a transcript first");
        const shots = Array.isArray(body.plan?.shots) ? body.plan.shots.map((shot) => ({ name: String(shot.name ?? "").trim(), intent: String(shot.intent ?? "").trim(), seconds: Number(shot.seconds) || null })).filter((shot) => shot.name) : [];
        if (!shots.length) throw new Error("add at least one beat for the first assembly");
        state.plan = { shots, drafted: new Date().toISOString() };
        state.selection = null;
        state.updatedAt = new Date().toISOString();
        await writePaperEdit(id, rel, state);
        return json(res, 200, { state });
      } catch (err) {
        return json(res, 400, { error: String(err.message) });
      }
    }

    if (p === "/api/paper-edit/draft" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = String(body.projectId ?? "");
      const rel = String(body.rel ?? "");
      try {
        await paperEditMedia(id, rel);
        const state = await readPaperEdit(id, rel);
        if (!state?.transcript || !state?.plan?.shots?.length) throw new Error("add the transcript and the beats before asking Claude");
        const dest = paperEditSelectionPath(id, rel);
        const prompt = `${buildPaperEditPrompt({ plan: state.plan, transcript: state.transcript, notes: String(body.notes ?? "") })}${await globalSkillDirection()}\n\nWrite that JSON to ${dest}. Do not alter the recording or the transcript.`;
        await mkdir(paperEditDir(id), { recursive: true });
        await writeFile(join(paperEditDir(id), `${Buffer.from(rel).toString("base64url")}.prompt.txt`), `${prompt}\n`, "utf8");
        return json(res, 200, { prompt, step: { ...await studioAgentStep({ prompt, cwd: paperEditDir(id), label: `paper edit ${basename(rel)}` }), project: id } });
      } catch (err) {
        return json(res, 400, { error: String(err.message) });
      }
    }

    if (p === "/api/paper-edit/selection" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = String(body.projectId ?? "");
      const rel = String(body.rel ?? "");
      try {
        await paperEditMedia(id, rel);
        const state = await readPaperEdit(id, rel);
        if (!state?.transcript || !state?.plan?.shots?.length) throw new Error("add the transcript and beats first");
        const raw = body.fromFile ? await readFile(paperEditSelectionPath(id, rel), "utf8") : body.selection;
        const selected = typeof raw === "string" ? parseSelection(raw) : raw;
        const checked = validateSelection(selected, { transcript: state.transcript, plan: state.plan });
        if (!checked.ranges.length) throw new Error(checked.problems[0] ?? "the selection has no usable passages");
        state.selection = { ...selected, checked, savedAt: new Date().toISOString() };
        state.updatedAt = new Date().toISOString();
        await writePaperEdit(id, rel, state);
        return json(res, 200, { state, coverage: paperEditCoverage(checked, { plan: state.plan }) });
      } catch (err) {
        return json(res, 400, { error: String(err.message) });
      }
    }

    if (p === "/api/paper-edit/cut" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = String(body.projectId ?? "");
      const rel = String(body.rel ?? "");
      try {
        const file = await paperEditMedia(id, rel);
        const state = await readPaperEdit(id, rel);
        const checked = state?.selection?.checked;
        if (!state?.transcript || !state?.plan || !checked?.ranges?.length) throw new Error("load or edit Claude's selection before making the cut");
        // The transcript's final word is a safe upper bound when the catalog has
        // not probed this file yet; `selectionToCutlist` already clamps to it.
        const durationSec = state.transcript.words.at(-1)?.endSec;
        const clips = selectionToCutlist(checked, { transcript: state.transcript, plan: state.plan, rel, durationSec });
        const name = wpSlug(String(body.name ?? "paper-edit"));
        const outDir = join(projectDir(id), "media", "Renders", name);
        await mkdir(outDir, { recursive: true });
        const doc = cutlistToDocument({ id: `${id}-${name}`, title: `${basename(rel)} — paper edit`, createdAt: new Date().toISOString(), clips: clips.map((clip) => ({ ...clip, path: file })) });
        const document = join(outDir, `${name}.openscreen`);
        await writeFile(document, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
        await writeFile(join(outDir, "paper-edit.json"), `${JSON.stringify({ rel, plan: state.plan, selection: state.selection, clips }, null, 2)}\n`, "utf8");
        return json(res, 200, { document, clips: doc.timeline.clips.length, durationSec: doc.timeline.clips.at(-1)?.timelineEndSec ?? 0 });
      } catch (err) {
        return json(res, 400, { error: String(err.message) });
      }
    }

    /*
     * ────────────────────────── the storyboard ──────────────────────────
     *
     * One board per project, read whole and written whole. Every mutating route
     * goes through `applyToBoard` so the board, the history log and the sync
     * adapter cannot drift — a route that wrote the file itself would eventually
     * forget the log, and the log is the part that survives a bad merge.
     *
     * Ratings are attributed on the SERVER, from the stored reviewer name, rather
     * than taken from the request. A client that names its own rater can rate as
     * anybody, and the entire value of a rating is whose it is.
     */
    if (p === "/api/board" && req.method === "GET") {
      const id = new URL(req.url, "http://x").searchParams.get("project") ?? "";
      if (!id) return json(res, 400, { error: "which project?" });
      const m = await readManifest(projectDir(id)).catch(() => null);
      try {
        const board = await readBoard(projectDir(id), { projectId: id, title: m?.name ?? "" });
        return json(res, 200, {
          board,
          // Derived rather than stored-only: a board saved before the canvas
          // existed has no graph, and should open showing the plan it already had.
          graph: graphFor(board),
          progress: boardProgress(board),
          ratings: RATINGS,
          me: await reviewerName(),
          sync: await syncState(),
        });
      } catch (err) {
        // A corrupt or too-new board is reported as itself. The panel shows the
        // sentence rather than an empty board, because an empty board is what a
        // person would then start filling in over the top of real work.
        return json(res, 409, { error: String(err.message) });
      }
    }

    /*
     * The shots, from the brief.
     *
     * Re-reading a brief is idempotent and does not touch takes: slot ids derive
     * from order and name, so an unchanged brief produces the identical slots and
     * everything stays attached. An EDITED shot name is a new slot by design —
     * see slotsFromBrief for why that is the safe direction to be wrong in.
     */
    if (p === "/api/board/slots" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = String(body.projectId ?? "");
      if (!id) return json(res, 400, { error: "which project?" });
      const dir = projectDir(id);
      const board = await readBoard(dir, { projectId: id });
      const brief = body.brief ?? board.brief;
      if (!Array.isArray(brief?.shots) || !brief.shots.length) {
        return json(res, 400, { error: "a storyboard needs a brief that lists the shots — add at least one" });
      }
      const next = await applyToBoard(
        dir,
        board,
        { type: "slots", at: new Date().toISOString(), by: await reviewerName(), count: brief.shots.length },
        (b) => {
          b.brief = brief;
          b.slots = slotsFromBrief(id, brief);
          return b;
        },
      );
      return json(res, 200, { board: next, progress: boardProgress(next) });
    }

    /** Offer a span of a file as a candidate for one slot. */
    if (p === "/api/board/take" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = String(body.projectId ?? "");
      const slot = String(body.slotId ?? "");
      const rel = String(body.rel ?? "");
      if (!id || !slot || !rel) return json(res, 400, { error: "a take needs a project, a shot and a file" });
      const dir = projectDir(id);
      const board = await readBoard(dir, { projectId: id });
      if (!board.slots.some((x) => x.id === slot)) return json(res, 400, { error: "that shot is not on this board" });
      /*
       * `rel`, resolved here, exactly as the Cut route does it.
       *
       * The catalogue carries no absolute path, so the browser has none to send —
       * and accepting one would mean trusting a client to name a file anywhere on
       * the disk. Resolving against the project's own media directory is both the
       * lookup and the boundary check.
       *
       * It is also what makes a board portable: an absolute path identifies
       * nothing on a teammate's machine, so `rel` is what gets stored.
       */
      const file = join(mediaDir(id), rel);
      if (!(file === LIB || file.startsWith(LIB + sep))) return json(res, 403, { error: `outside ${LIB}: ${rel}` });
      const st = await stat(file).catch(() => null);
      if (!st) return json(res, 404, { error: `no such footage: ${rel}` });
      const inSec = Math.max(0, Number(body.inSec) || 0);
      const durationSec = Number(body.durationSec) || null;
      const outSec = Number(body.outSec) > inSec ? Number(body.outSec) : durationSec || inSec;
      const tid = takeIdFor(slot, rel, inSec, outSec);
      const at = new Date().toISOString();
      const by = await reviewerName();
      const next = await applyToBoard(dir, board, { type: "take", at, by, slotId: slot, takeId: tid, rel }, (b) => {
        // The id IS the span, so re-offering the same span is a no-op rather than
        // a duplicate card. Two people adding the same clip meant it once.
        if (!b.takes.some((t) => t.id === tid)) {
          b.takes.push({ id: tid, slotId: slot, rel, inSec, outSec, durationSec, addedBy: by, addedAt: at });
        }
        return b;
      });
      return json(res, 200, { board: next, progress: boardProgress(next), takeId: tid });
    }

    /** Say what you think of a take. Signed by the server, not by the caller. */
    if (p === "/api/board/rate" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = String(body.projectId ?? "");
      const take = String(body.takeId ?? "");
      const rating = String(body.rating ?? "");
      if (!id || !take) return json(res, 400, { error: "a rating needs a project and a take" });
      if (!RATINGS.some((r) => r.id === rating)) {
        return json(res, 400, { error: `rating must be one of ${RATINGS.map((r) => r.id).join(", ")}` });
      }
      const dir = projectDir(id);
      const board = await readBoard(dir, { projectId: id });
      const at = new Date().toISOString();
      const by = await reviewerName();
      const next = await applyToBoard(dir, board, { type: "rate", at, by, takeId: take, rating }, (b) => {
        // Appended, never replaced in place. `scoreOf` takes the latest per person,
        // so changing your mind is a new line and the log keeps both — which is how
        // "we all agreed" can be checked later rather than asserted.
        b.ratings.push({ takeId: take, by, rating, at });
        return b;
      });
      return json(res, 200, { board: next, progress: boardProgress(next) });
    }

    /** Choose the take for a slot, or clear the choice and fall back to the ratings. */
    if (p === "/api/board/pick" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = String(body.projectId ?? "");
      const slot = String(body.slotId ?? "");
      if (!id || !slot) return json(res, 400, { error: "a pick needs a project and a shot" });
      const dir = projectDir(id);
      const board = await readBoard(dir, { projectId: id });
      const take = body.takeId ? String(body.takeId) : null;
      if (take && !board.takes.some((t) => t.id === take)) return json(res, 400, { error: "that take is not on this board" });
      const at = new Date().toISOString();
      const by = await reviewerName();
      const next = await applyToBoard(dir, board, { type: "pick", at, by, slotId: slot, takeId: take }, (b) => {
        b.pickedAt = b.pickedAt ?? {};
        if (take) {
          b.picks[slot] = take;
          b.pickedAt[slot] = at;
        } else {
          delete b.picks[slot];
          delete b.pickedAt[slot];
        }
        return b;
      });
      return json(res, 200, { board: next, progress: boardProgress(next) });
    }

    /** Say something about a take or a shot, so a decision carries its argument. */
    if (p === "/api/board/comment" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = String(body.projectId ?? "");
      const text = String(body.text ?? "").trim();
      if (!id || !text) return json(res, 400, { error: "a comment needs a project and something to say" });
      const dir = projectDir(id);
      const board = await readBoard(dir, { projectId: id });
      const at = new Date().toISOString();
      const by = await reviewerName();
      const cid = `cmt_${Buffer.from(`${by}:${at}:${text}`).toString("base64url").slice(-16)}`;
      const next = await applyToBoard(dir, board, { type: "comment", at, by, id: cid, text }, (b) => {
        b.comments.push({ id: cid, by, at, text, takeId: body.takeId ?? null, slotId: body.slotId ?? null });
        return b;
      });
      return json(res, 200, { board: next, progress: boardProgress(next) });
    }

    /*
     * Sharing: what is configured, what is missing, and who you are signed in as.
     *
     * The anon key comes back as-is because Supabase publishes it on purpose — it
     * identifies the project and authorises nothing. The session does NOT come
     * back: it holds a refresh token, and the panel has no use for one.
     */
    if (p === "/api/board/sharing" && req.method === "GET") {
      return json(res, 200, await sharingState());
    }

    if (p === "/api/board/signin" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      try {
        await SUPABASE_SYNC.signIn({ email: String(body.email ?? ""), password: String(body.password ?? "") });
      } catch (err) {
        return json(res, 400, { error: String(err.message) });
      }
      return json(res, 200, await sharingState());
    }

    if (p === "/api/board/signup" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      try {
        const r = await SUPABASE_SYNC.signUp({ email: String(body.email ?? ""), password: String(body.password ?? "") });
        // An account awaiting confirmation is not a failure, and saying so is the
        // whole message — "check your email" and "that did not work" are
        // different instructions.
        return json(res, 200, { ...(await sharingState()), needsConfirmation: r.needsConfirmation, email: r.email });
      } catch (err) {
        return json(res, 400, { error: String(err.message) });
      }
    }

    if (p === "/api/board/signout" && req.method === "POST") {
      await SUPABASE_SYNC.signOut();
      return json(res, 200, await sharingState());
    }

    /*
     * The canvas: where a node sits, and what follows what.
     *
     * Three routes rather than one "save the graph", because each is a different
     * edit with a different failure. Moving cannot fail; connecting can, and the
     * reason is the useful part; disconnecting is always allowed. A single
     * whole-graph PUT would have let a stale canvas overwrite somebody else's
     * rewiring with its own idea of the layout.
     */
    if (p === "/api/board/node/move" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = String(body.projectId ?? "");
      const dir = projectDir(id);
      const board = await readBoard(dir, { projectId: id });
      const at = new Date().toISOString();
      const by = await reviewerName();
      const next = await applyToBoard(dir, board, { type: "move", at, by, nodeId: body.nodeId }, (b) => {
        b.graph = moveNode(graphFor(b), String(body.nodeId ?? ""), body.x, body.y);
        return b;
      });
      return json(res, 200, { graph: graphFor(next), progress: boardProgress(next) });
    }

    if (p === "/api/board/wire" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = String(body.projectId ?? "");
      const dir = projectDir(id);
      const board = await readBoard(dir, { projectId: id });
      const attempt = graphConnect(graphFor(board), String(body.from ?? ""), String(body.to ?? ""));
      // The refusal is an ordinary outcome with a reason, not a 500. The canvas
      // shows `why` where the wire was dropped.
      if (!attempt.ok) return json(res, 200, { ok: false, why: attempt.why, graph: graphFor(board) });
      const at = new Date().toISOString();
      const by = await reviewerName();
      const next = await applyToBoard(dir, board, { type: "wire", at, by, from: body.from, to: body.to }, (b) => {
        b.graph = attempt.graph;
        return b;
      });
      return json(res, 200, { ok: true, graph: graphFor(next), board: next, progress: boardProgress(next) });
    }

    if (p === "/api/board/wire/delete" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = String(body.projectId ?? "");
      const dir = projectDir(id);
      const board = await readBoard(dir, { projectId: id });
      const at = new Date().toISOString();
      const by = await reviewerName();
      const next = await applyToBoard(dir, board, { type: "unwire", at, by, wireId: body.wireId }, (b) => {
        b.graph = graphDisconnect(graphFor(b), String(body.wireId ?? ""));
        return b;
      });
      return json(res, 200, { ok: true, graph: graphFor(next), board: next, progress: boardProgress(next) });
    }

    /*
     * Adding, renaming and removing a shot — from the canvas rather than the brief.
     *
     * A NOTE ON IDS. `slotsFromBrief` derives a slot id from its order and name,
     * which is right for re-reading a brief idempotently and wrong the moment a
     * node exists on a canvas: renaming would mint a new id and orphan every take
     * under it. So a node created HERE gets an id once, from a stamp, and its name
     * is thereafter ordinary mutable data. The two kinds of slot coexist — what an
     * id means is "this shot", however it was made.
     */
    if (p === "/api/board/node/add" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = String(body.projectId ?? "");
      const dir = projectDir(id);
      const board = await readBoard(dir, { projectId: id });
      const at = new Date().toISOString();
      const by = await reviewerName();
      const name = String(body.name ?? "").trim() || "New shot";
      const nodeId = graphIdFor("slot", `${id}:${at}:${name}`);
      const next = await applyToBoard(dir, board, { type: "node", at, by, nodeId, name }, (b) => {
        const graph = graphFor(b);
        // Placed to the right of everything, on the same row: a new shot appears
        // where you would look for it rather than under one already there.
        const rightmost = graph.nodes.reduce((m, n) => Math.max(m, n.x), 0);
        const row = graph.nodes.length ? Math.min(...graph.nodes.map((n) => n.y)) : 400;
        b.slots = [...(b.slots ?? []), { id: nodeId, order: (b.slots ?? []).length, name, intent: "", seconds: null, notes: "" }];
        b.graph = {
          ...graph,
          nodes: [...graph.nodes, { id: nodeId, kind: "shot", name, intent: "", seconds: null, x: graph.nodes.length ? rightmost + NODE_WIDTH + NODE_GAP_X : 400, y: row }],
        };
        return b;
      });
      return json(res, 200, { board: next, graph: graphFor(next), progress: boardProgress(next), nodeId });
    }

    if (p === "/api/board/node/update" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = String(body.projectId ?? "");
      const nodeId = String(body.nodeId ?? "");
      const dir = projectDir(id);
      const board = await readBoard(dir, { projectId: id });
      if (!(board.slots ?? []).some((x) => x.id === nodeId)) return json(res, 404, { error: "no such shot on this board" });
      const at = new Date().toISOString();
      const by = await reviewerName();
      const next = await applyToBoard(dir, board, { type: "rename", at, by, nodeId }, (b) => {
        b.slots = b.slots.map((sl) =>
          sl.id !== nodeId
            ? sl
            : {
                ...sl,
                // The id is NOT recomputed. That is the whole point: renaming a
                // shot must not orphan the takes sitting under it.
                name: typeof body.name === "string" ? body.name.trim() || sl.name : sl.name,
                intent: typeof body.intent === "string" ? body.intent.trim() : sl.intent,
                seconds: body.seconds === null || body.seconds === "" ? null : Number(body.seconds) > 0 ? Number(body.seconds) : sl.seconds,
                // A canvas shot can point at the component scene that fulfils it.
                // Keep the filename on the slot, rather than inferring it from a
                // mutable shot name every time someone opens the canvas.
                scene: typeof body.scene === "string" && body.scene.trim() ? body.scene.trim() : sl.scene,
              },
        );
        b.graph = graphFor(b);
        return b;
      });
      return json(res, 200, { board: next, graph: graphFor(next), progress: boardProgress(next) });
    }

    if (p === "/api/board/node/delete" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = String(body.projectId ?? "");
      const nodeId = String(body.nodeId ?? "");
      const dir = projectDir(id);
      const board = await readBoard(dir, { projectId: id });
      const at = new Date().toISOString();
      const by = await reviewerName();
      const next = await applyToBoard(dir, board, { type: "remove", at, by, nodeId }, (b) => {
        // `removeNode` heals the chain: the shot before now leads to the shot
        // after, rather than the cut silently ending where the deletion was.
        b.graph = removeNode(graphFor(b), nodeId);
        b.slots = (b.slots ?? []).filter((sl) => sl.id !== nodeId);
        /*
         * The takes go too, and the ratings with them.
         *
         * Leaving them would be worse than losing them: a take whose shot no
         * longer exists cannot be seen, cannot be rated, and cannot be removed —
         * it would just make every future merge carry rows nothing can reach.
         * `history.jsonl` still holds every rating that was ever given.
         */
        const gone = new Set((b.takes ?? []).filter((t) => t.slotId === nodeId).map((t) => t.id));
        b.takes = (b.takes ?? []).filter((t) => t.slotId !== nodeId);
        b.ratings = (b.ratings ?? []).filter((r) => !gone.has(r.takeId));
        delete b.picks?.[nodeId];
        delete b.pickedAt?.[nodeId];
        return b;
      });
      return json(res, 200, { board: next, graph: graphFor(next), progress: boardProgress(next) });
    }

    /** What happened, in order. The board is state; this is the record. */
    if (p === "/api/board/history" && req.method === "GET") {
      const id = new URL(req.url, "http://x").searchParams.get("project") ?? "";
      if (!id) return json(res, 400, { error: "which project?" });
      return json(res, 200, { history: await readHistory(projectDir(id)) });
    }

    /** Who your ratings are signed by, and which backend they reach. */
    if (p === "/api/board/settings" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      if (typeof body.reviewer === "string") await setReviewerName(body.reviewer);
      if (typeof body.sync === "string") await setSyncChoice(body.sync);
      return json(res, 200, { me: await reviewerName(), sync: (await syncChoice()) ?? "local" });
    }

    /**
     * Pull, merge, push.
     *
     * Reports rather than throws when the chosen adapter is not ready: the board
     * still works, and "Supabase is not available" is a true and actionable thing
     * to show, whereas a 500 makes a working local board look broken.
     */
    if (p === "/api/board/sync" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = String(body.projectId ?? "");
      if (!id) return json(res, 400, { error: "which project?" });
      const dir = projectDir(id);
      const board = await readBoard(dir, { projectId: id });
      const r = await syncBoard(dir, board, await syncFor(await syncChoice()));
      return json(res, 200, { board: r.board, progress: boardProgress(r.board), synced: r.synced, reason: r.reason });
    }

    /*
     * The picks, as a document the editor opens.
     *
     * `toCutlist` is a projection of the picks rather than an export of them, so
     * this route copies nothing and cannot fall behind the board. A slot with no
     * pick is a hole in the assembly and is left as one — see toCutlist.
     */
    if (p === "/api/board/cut" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = String(body.projectId ?? "");
      if (!id) return json(res, 400, { error: "which project?" });
      const dir = projectDir(id);
      const board = await readBoard(dir, { projectId: id });
      const m = await readManifest(dir).catch(() => null);
      const name = String(body.name ?? "").trim() || "storyboard-cut";
      /*
       * The same resolver, and the same refusal.
       *
       * A board is data and can be hand-edited, so a `rel` reaching here is no more
       * trusted than one arriving over HTTP — the check belongs at the point the
       * name becomes a file, which is here.
       */
      const resolveRel = (r) => {
        const f = join(mediaDir(id), String(r ?? ""));
        if (!(f === LIB || f.startsWith(LIB + sep))) throw new Error(`outside ${LIB}: ${r}`);
        return f;
      };
      let doc;
      try {
        doc = boardToDocument(board, {
          title: m?.name ? `${m.name} · ${name}` : name,
          createdAt: new Date().toISOString(),
          resolve: resolveRel,
        });
      } catch (err) {
        return json(res, 400, { error: String(err.message) });
      }
      // Every picked take must still be on disk. A cut that references a deleted
      // file opens in the editor as a timeline of missing media, which reads as a
      // broken app rather than as footage somebody moved.
      for (const c of toCutlist(board)) {
        if (!(await stat(resolveRel(c.rel)).catch(() => null))) {
          return json(res, 404, { error: `the take chosen for "${c.label}" is gone: ${c.rel}` });
        }
      }
      const outDir = join(dir, "media", "Renders");
      await mkdir(outDir, { recursive: true });
      const dest = join(outDir, `${name}.openscreen`);
      await writeFile(dest, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
      return json(res, 200, { document: dest, clips: toCutlist(board).length, seconds: boardProgress(board).seconds });
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
      // Optics' own ladder, lightest to darkest — `minus-max` is near-white and
      // `plus-max` near-black, which is the opposite of what the names suggest.
      // `base` is the seed itself.
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
    /*
     * Switch the project you are working in.
     *
     * An empty string means the shared shelf — a script that travels between
     * projects rather than belonging to one — which is a real choice and not the
     * absence of one.
     */
    if (p === "/api/project/current" && req.method === "POST") {
      const body = JSON.parse(await text(req));
      const id = body.id ? String(body.id) : null;
      if (id) {
        const man = await readManifest(projectDir(id)).catch(() => null);
        if (!man) return json(res, 404, { error: `no such project: ${id}` });
      }
      await setCurrentProject(id);
      return json(res, 200, { ok: true, id });
    }

    /*
     * Which agent runs the AI steps.
     *
     * A route rather than an env var for the reason lib/settings.mjs exists: a
     * GUI launched from Finder inherits no shell environment, so configuration
     * only a shell can supply is configuration nobody can set.
     *
     * `ready` is reported so the UI can say which of these has actually been run
     * — see lib/agents.mjs. Pi is wired and untested, and a picker that presents
     * it as an equal choice would be lying.
     */
    if (p === "/api/agent") {
      if (req.method === "POST") {
        const body = JSON.parse(await text(req));
        const want = String(body.agent ?? "");
        if (!AGENTS[want]) return json(res, 400, { error: `no agent called "${want}"` });
        await setAgentChoice(want);
        return json(res, 200, { ok: true, agent: want });
      }
      return json(res, 200, {
        chosen: (await agentChoice()) ?? "claude",
        agents: Object.values(AGENTS).map((a) => ({ id: a.id, label: a.label, billing: a.billing, ready: a.ready })),
      });
    }

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
	/*
	 * A browser the person stays signed in to.
	 *
	 * This is the answer to "use my own browser" that does not require quitting
	 * Chrome and relaunching it with a debugging port. rm-demo keeps the profile;
	 * the browser already on screen is never touched.
	 */
	if (body?.profile) out.push("--profile");
	// Which browser the viewer will see. Only sent when it is not the default, so
	// an older rm-demo that does not know the flag keeps working.
	const browser = String(body?.browser ?? "").trim();
	if (browser && browser !== "chrome") out.push("--browser", browser);
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
const SCRIPT_DRAFT_DIR = join(STATE_DIR, "script-drafts");
const scriptDraftPath = (id) => (/^[a-z0-9][a-z0-9._-]*$/i.test(id) ? join(SCRIPT_DRAFT_DIR, `${id}.json`) : null);

async function readDraft(id) {
	const file = draftPath(id);
	if (!file) return { rows: [], script: "", handEdited: false };
	const raw = await readFile(file, "utf8").catch(() => null);
	if (!raw) return { rows: [], script: "", handEdited: false };
	try {
		const saved = JSON.parse(raw);
		// Drafts written before the editable Script field existed were just an
		// array of rows. Keep them readable while new drafts hold both forms.
		const rows = Array.isArray(saved) ? saved : saved?.rows;
		return {
			rows: Array.isArray(rows) ? rows.filter((r) => r && typeof r.verb === "string") : [],
			script: typeof saved?.script === "string" ? saved.script : "",
			handEdited: Boolean(saved?.handEdited),
		};
	} catch {
		// A draft that will not parse is a draft nobody can use. Say nothing and
		// start clean rather than failing the page that asked for it.
		return { rows: [], script: "", handEdited: false };
	}
}

async function writeDraft(id, body) {
	const file = draftPath(id);
	if (!file) throw new Error("that is not a project id");
	await mkdir(DRAFT_DIR, { recursive: true });
	const rows = Array.isArray(body?.rows) ? body.rows.filter((r) => r && typeof r.verb === "string") : [];
	const script = typeof body?.script === "string" ? body.script : "";
	const next = { rows, script, handEdited: Boolean(body?.handEdited), updatedAt: new Date().toISOString() };
	// Empty rows and an empty script mean there is no draft. A hand-written script
	// without rows is still real work and must survive a return to this page.
	if (!rows.length && !script.trim()) {
		await rm(file, { force: true });
		return null;
	}
	const tmp = `${file}.${randomUUID()}.tmp`;
	await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	await rename(tmp, file);
	return file;
}

/** The Script page's incomplete document, one per project and safe across restarts. */
async function readScriptDraft(id) {
	const file = scriptDraftPath(id);
	if (!file) throw new Error("that is not a project id");
	const raw = await readFile(file, "utf8").catch(() => null);
	if (!raw) return null;
	try {
		const saved = JSON.parse(raw);
		if (!saved || typeof saved !== "object") return null;
		return {
			name: typeof saved.name === "string" ? saved.name : "",
			about: typeof saved.about === "string" ? saved.about : "",
			body: typeof saved.body === "string" ? saved.body : "",
			seconds: Number.isFinite(Number(saved.seconds)) ? Number(saved.seconds) : 30,
			shelf: saved.shelf === "shared" ? "shared" : "project",
			updatedAt: typeof saved.updatedAt === "string" ? saved.updatedAt : null,
		};
	} catch {
		return null;
	}
}

/** Atomic so an app restart cannot leave the only copy of a half-written script invalid. */
async function writeScriptDraft(id, body) {
	const file = scriptDraftPath(id);
	if (!file) throw new Error("that is not a project id");
	const next = {
		name: String(body.name ?? ""),
		about: String(body.about ?? ""),
		body: String(body.body ?? ""),
		seconds: Number.isFinite(Number(body.seconds)) ? Number(body.seconds) : 30,
		shelf: body.shelf === "shared" ? "shared" : "project",
		updatedAt: new Date().toISOString(),
	};
	await mkdir(SCRIPT_DRAFT_DIR, { recursive: true });
	const tmp = `${file}.${randomUUID()}.tmp`;
	await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	await rename(tmp, file);
	return next;
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
		? { bin: process.execPath, args: [script, ...args], ...extra }
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

/**
 * Which sync adapters exist and whether each one can actually run here.
 *
 * `ready` is a value on the local adapter and a question on the hosted one, so
 * this asks rather than reads — and carries the reason when the answer is no,
 * because "not available" without a cause is a dead end.
 */
async function syncState() {
	const adapters = [];
	for (const a of Object.values(SYNCS)) {
		const ready = typeof a.ready === "function" ? await a.ready() : a.ready;
		adapters.push({
			id: a.id,
			label: a.label,
			detail: a.detail,
			ready,
			problem: !ready && typeof a.problem === "function" ? await a.problem() : null,
		});
	}
	return { chosen: (await syncChoice()) ?? "local", adapters };
}

/**
 * Whether sharing can work here, and who is signed in.
 *
 * `url` goes back only so the panel can tell its two states apart — this build
 * has nowhere to sync to, versus nobody has signed in yet — because different
 * people fix those and they must never share a sentence. The key, the team and
 * the session do not: the first two are deployment config the panel no longer
 * asks for, and the session holds a refresh token, which is a credential.
 */
async function sharingState() {
	const cfg = await supabaseSettings();
	return {
		url: cfg.url,
		signedInAs: cfg.session?.user?.email ?? null,
		problem: supabaseProblem(cfg),
	};
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
