/*
 * Cut a release, and prove it landed.
 *
 *   pnpm run release             bump the patch, tag it, publish, verify
 *   pnpm run release --minor     or a minor / --major
 *   pnpm run release --dry-run   say what would happen and touch nothing
 *   pnpm run release --verify    just check whether the last release actually shipped
 *   pnpm run release --finish    publish a tag push.yml cut but never released
 *   pnpm run release --bump      cut a new version even if a tag is stranded
 *
 * WHY THIS EXISTS
 *
 * Releasing is already automated, and the automation has never once worked end to
 * end on its own. `push.yml` bumps the version and pushes a tag; `release.yml`
 * watches for tags and does the publishing. The handover between them does not
 * happen: GitHub deliberately will not start a workflow from a push made with the
 * default GITHUB_TOKEN, and push.yml tags as github-actions[bot] using exactly
 * that. release.yml's own comment records sixty-two tags that produced nothing.
 *
 * It is still true. Every release this repo has ever published was started by
 * hand with `workflow_dispatch` — all of them, without exception — and at the
 * time this was written v0.1.220 was tagged with no release behind it and the tap
 * was serving v0.1.219.
 *
 * That is the failure worth designing against, and it is not "the tag step broke".
 * Nothing breaks. A tag appears, main looks released, and the tap quietly keeps
 * serving whatever it served yesterday. Nobody finds out until someone installs
 * it. So the last thing this script does is not "push the tag" — it is read the
 * tap back and check that the version it serves is the one we just cut. A release
 * that cannot be verified from outside has not happened.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not replace push.yml. Merging a PR still bumps and tags, and that is
 * fine — `--verify` and `--finish` are for picking up after it. What this adds is
 * a path where one person, deliberately, can take a version all the way out and
 * see that it arrived.
 *
 * TWO THINGS THAT WOULD BITE
 *
 * The version commit carries `[skip release]`, the same marker push.yml's bot
 * uses. Without it, pushing the bump to main starts push.yml, which finds the tag
 * already taken and bumps a second time — so one release would burn two version
 * numbers and strand the first.
 *
 * And a stranded tag is never bumped past. If a tag has no release, the fix is to
 * publish that tag, not to cut a newer one on top of it; the alternative is how
 * the tap ended up forty-three versions behind once already.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(`--${flag}`);
const arg = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};

const dryRun = has("dry-run");
const verifyOnly = has("verify");
const finishOnly = has("finish");
const noWait = has("no-wait");
const assumeYes = has("yes") || has("y");
const bump = has("major") ? "major" : has("minor") ? "minor" : "patch";
const TAP = resolve(arg("tap", join(ROOT, "..", "homebrew-tap")));
/** The formula whose url/sha256 a release rewrites. Mirrors sync-tap's LAYOUT. */
const FORMULA = "Formula/rm-video.rb";

const say = (line = "") => console.log(line);
const step = (line) => say(`\n  ${line}`);
const ok = (line) => say(`    ✓ ${line}`);
const bad = (line) => say(`    ✗ ${line}`);
const note = (line) => say(`      ${line}`);
const die = (...lines) => {
	say();
	for (const line of lines) console.error(`  ${line}`);
	say();
	process.exit(1);
};

/** In ROOT, throwing on failure — for the things that must work. */
const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
/** Anywhere, never throwing — for the things whose failure is an answer. */
const tryRun = (cmd, args, cwd = ROOT) => spawnSync(cmd, args, { cwd, encoding: "utf8" });
const loud = (cmd, args, cwd = ROOT) => {
	const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
	if (r.status !== 0) die(`${cmd} ${args.join(" ")} failed`);
};

const version = async () => JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")).version;

/*
 * `gh`, because everything past the tag push happens on GitHub: dispatching the
 * workflow the tag could not, and reading back whether a release exists. Checked
 * up front rather than at the point of use — discovering it half way through,
 * after main has already moved, leaves the repo in a state this script cannot
 * describe.
 */
const requireGh = () => {
	if (tryRun("gh", ["--version"]).status !== 0) {
		die("gh is not installed — this script needs it to publish and to read back the result.", "brew install gh");
	}
	if (tryRun("gh", ["auth", "status"]).status !== 0) {
		die("gh is not signed in.", "gh auth login");
	}
};

/** Every `v*` tag, newest first, by version order rather than date. */
const tags = () => git("tag", "--sort=-v:refname", "--list", "v*").split("\n").filter(Boolean);

/**
 * Compare `vX.Y.Z` the way a person would. Negative when a is older.
 *
 * Hand-rolled rather than pulled in: these tags are always three numbers, and a
 * dependency in the release path is a dependency that can break the release.
 */
const cmp = (a, b) => {
	const parts = (t) => t.replace(/^v/, "").split(".").map(Number);
	const [x, y] = [parts(a), parts(b)];
	for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
	return 0;
};

/** Tags GitHub has a release for. One call, because `gh release view` per tag is slow. */
const releasedTags = () => {
	const r = tryRun("gh", ["release", "list", "--limit", "100", "--json", "tagName"]);
	if (r.status !== 0) return null;
	try {
		return new Set(JSON.parse(r.stdout).map((x) => x.tagName));
	} catch {
		return null;
	}
};

/**
 * The version the published tap actually serves.
 *
 * Read from `origin/main` after a fetch, not from the working copy: the local tap
 * checkout is a convenience and is usually behind — it was nine commits behind and
 * pointing at v0.1.176 while the published formula served v0.1.219. Answering from
 * the working copy would have reported a catastrophe that was not happening.
 */
const tapServes = () => {
	if (!existsSync(join(TAP, ".git"))) return { error: `no tap checkout at ${TAP}` };
	if (tryRun("git", ["fetch", "-q", "origin"], TAP).status !== 0) {
		return { error: "could not fetch the tap" };
	}
	const r = tryRun("git", ["show", `origin/HEAD:${FORMULA}`], TAP);
	const body = r.status === 0 ? r.stdout : tryRun("git", ["show", `origin/main:${FORMULA}`], TAP).stdout;
	if (!body) return { error: `could not read ${FORMULA} from the tap` };
	return {
		version: /releases\/download\/(v[\d.]+)\//.exec(body)?.[1] ?? null,
		sha: /^\s*sha256 "([0-9a-f]{64})"/m.exec(body)?.[1] ?? null,
	};
};

/*
 * ── What is true right now ────────────────────────────────────────────────────
 */
say();
say("  Release");

requireGh();

const pkgVersion = await version();
const allTags = tags();
const latestTag = allTags[0] ?? null;
const released = releasedTags();
if (released === null) die("could not list releases from GitHub — is this repo's remote reachable?");

/*
 * A tag with no release is the failure this whole script is about, so it is the
 * first thing reported and it changes what happens next.
 *
 * Only tags NEWER than the newest released one, though. 122 of this repo's tags
 * have no release, and all but one of them are history: the bot cut them over
 * months while nobody noticed, and every one was superseded by a later release
 * long ago. Offering to publish a year-old tag — which the first version of this
 * did, picking v0.0.1 — would point the tap at ancient code. The backlog is
 * reported once, as a fact about the past, and nothing is done about it.
 */
const newestReleased = allTags.filter((t) => released.has(t)).sort(cmp).at(-1) ?? null;
const stranded = allTags
	.filter((t) => !released.has(t) && (!newestReleased || cmp(t, newestReleased) > 0))
	.sort(cmp);
const historical = allTags.filter((t) => !released.has(t) && newestReleased && cmp(t, newestReleased) < 0);

step("Where things stand");
ok(`package.json says ${pkgVersion}`);
ok(`newest tag is ${latestTag ?? "none"}`);

const tap = tapServes();
if (tap.error) {
	bad(tap.error);
	note("the tap is where an install comes from, so this script cannot confirm a release without it");
	note(`clone it beside this repo, or pass --tap <path>`);
} else if (tap.version) {
	const current = tap.version === `v${pkgVersion}`;
	(current ? ok : bad)(`the published tap serves ${tap.version}`);
	if (!current) note(`main is at v${pkgVersion} — an install today gets ${tap.version}`);
} else {
	bad("could not tell which version the tap serves");
}

/*
 * packaging/ is the source of the formula; the tap is a build output. Drift here
 * means someone edited the tap directly, and a release would overwrite their edit.
 * Reported, not fixed: sync-tap owns that, and it commits.
 */
const tapDrift = tryRun("node", [join(ROOT, "lib", "sync-tap.mjs"), "--check", "--tap", TAP]);
if (tapDrift.status === 0) ok("the tap matches packaging/");
else if (!tap.error) {
	bad("the tap has drifted from packaging/");
	for (const line of (tapDrift.stderr || "").split("\n").filter((l) => l.trim().startsWith("Formula") || l.trim().startsWith("Casks") || l.trim().startsWith("scripts"))) note(line.trim());
	note("run `pnpm run sync-tap` and push the tap, or a release will overwrite it");
}

if (stranded.length) {
	bad(`tagged but never released: ${stranded.join(", ")}`);
	note("push.yml cut these; GitHub will not start a workflow from a bot's GITHUB_TOKEN push,");
	note("so release.yml never ran and the tap never moved.");
} else {
	ok(`nothing newer than ${newestReleased ?? "anything"} is waiting to be released`);
}
if (historical.length) {
	// Said once, plainly, so nobody goes looking for 121 missing releases. They
	// were all superseded before anybody could have installed them.
	ok(`${historical.length} older tag(s) never released either — history, superseded by ${newestReleased}`);
}

if (verifyOnly) {
	say();
	const healthy = !stranded.length && !tap.error && tap.version === `v${pkgVersion}` && tapDrift.status === 0;
	say(healthy ? "  Everything shipped.\n" : "  Something has not shipped. Run `pnpm run release --finish` or read above.\n");
	process.exit(healthy ? 0 : 1);
}

/*
 * ── What to do about it ───────────────────────────────────────────────────────
 *
 * Publishing a stranded tag and cutting a new version are the same job from here
 * on — a tag exists, the workflow has to run against it — so the only decision is
 * which tag that is.
 */
let target;
let bumping = false;

if (stranded.length && has("bump")) {
	/*
	 * The escape hatch, and it says what it costs. There is a real case for it —
	 * a stranded tag whose commit is broken, where the fix is a newer version and
	 * not a re-run — but it is the move that buried the tap last time, so it has
	 * to be asked for by name.
	 */
	bumping = true;
	step(`Cutting a new ${bump} release, leaving ${stranded.join(", ")} stranded`);
	note("--bump was passed. Those tags will never be released; that is what it means.");
} else if (stranded.length) {
	/*
	 * The newest, not the oldest. `stranded` is sorted ascending, so this is the
	 * last of it — and it is the right one because the tap ends up wherever the
	 * final release puts it. Publishing the older ones first would only move the
	 * tap backwards on the way, and each is superseded by this one anyway.
	 */
	target = stranded.at(-1);
	step(`Finishing ${target} instead of bumping`);
	note("a stranded tag is published, never bumped past — bumping strands it for good,");
	note("which is how the tap fell 43 versions behind once already.");
	if (stranded.length > 1) note(`${stranded.slice(0, -1).join(", ")} are superseded by it and are left alone`);
} else if (finishOnly) {
	say();
	say("  Nothing to finish — every tag has a release.\n");
	process.exit(0);
} else {
	bumping = true;
	step(`Cutting a new ${bump} release`);
}

/*
 * Only the bump path touches the repository, so only the bump path demands a
 * clean one. Finishing a stranded tag reads git and talks to GitHub; it can run
 * from a dirty tree on any branch, which matters because that is the state
 * somebody is in when they discover the problem.
 */
if (bumping) {
	const branch = git("rev-parse", "--abbrev-ref", "HEAD");
	if (branch !== "main") {
		die(
			`on ${branch}, not main.`,
			"A release is cut from main: the tag has to name a commit that passed the gate on main,",
			"and package.json on main is what sync-tap and the Studio's version line read.",
		);
	}
	if (git("status", "--porcelain").length > 0) {
		die("the tree is dirty.", "Commit or set the changes aside — a release commit should contain the bump and nothing else.");
	}
	if (tryRun("git", ["fetch", "-q", "origin", "main"]).status !== 0) die("could not fetch origin/main");
	const behind = git("rev-list", "--count", "HEAD..origin/main");
	if (Number(behind) > 0) {
		die(`main is ${behind} commit(s) behind origin.`, "git pull --ff-only   # then release, so the tag names what everyone else has");
	}
	const ahead = git("rev-list", "--count", "origin/main..HEAD");
	if (Number(ahead) > 0) {
		die(
			`main is ${ahead} commit(s) ahead of origin.`,
			"Push them first. A release tag on an unpushed commit points at something nobody else has,",
			"and the release workflow builds its tarball from the tag on the server.",
		);
	}
	ok("on main, clean, in step with origin");
}

const confirm = async (question) => {
	if (assumeYes || dryRun) return true;
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const answer = (await rl.question(`\n  ${question} [y/N] `)).trim().toLowerCase();
	rl.close();
	return answer === "y" || answer === "yes";
};

/*
 * ── Bump ──────────────────────────────────────────────────────────────────────
 */
if (bumping) {
	// Ask before the version moves, because everything after this point is visible
	// to everybody else.
	if (!(await confirm(`Bump the ${bump} from ${pkgVersion}, tag it, and publish?`))) {
		say("\n  Nothing done.\n");
		process.exit(0);
	}

	if (dryRun) {
		note(`would run: pnpm version ${bump} --no-git-tag-version`);
		note("would commit 'v<next> [skip release]', push main, tag and push the tag");
	} else {
		// --no-git-tag-version: the commit and the tag are made here, so their message
		// and shape match what push.yml's bot produces. pnpm's own tag would not carry
		// [skip release] in the commit, which is the whole trap described at the top.
		loud("pnpm", ["version", bump, "--no-git-tag-version"]);
	}

	const nextVersion = dryRun ? `${pkgVersion} (+${bump})` : await version();
	target = `v${nextVersion}`;

	if (!dryRun) {
		if (allTags.includes(target)) {
			// Put it back rather than leaving the working copy bumped to a taken version.
			loud("git", ["checkout", "--", "package.json", "pnpm-lock.yaml"]);
			die(`${target} is already tagged.`, "Someone released it. Pull, then decide whether you still need a new version.");
		}
		step(`Committing ${target}`);
		note("the pre-commit hook runs the full gate here — this is the slow part");
		// The generated brand artifacts the hook regenerates travel with the bump, the
		// same way they do on any other commit; -a rather than a path list so the hook's
		// own staging is not fought with.
		loud("git", ["commit", "-a", "-m", `${target} [skip release]`]);
		ok(`committed ${target} with [skip release], so push.yml will not bump again`);

		step("Pushing main and the tag");
		loud("git", ["push", "origin", "HEAD:main"]);
		// Annotated, like push.yml's: `git describe` and the release notes read it.
		loud("git", ["tag", "-a", target, "-m", target]);
		loud("git", ["push", "origin", target]);
		ok(`pushed ${target}`);
	}
}

if (dryRun) {
	step("Dry run — nothing was changed");
	note(`would publish ${target} and then read the tap back to confirm it serves it`);
	say();
	process.exit(0);
}

/*
 * ── Publish ───────────────────────────────────────────────────────────────────
 *
 * A tag pushed from a person's credentials does start release.yml, unlike the
 * bot's — so the common case is that a run already exists and dispatching would
 * make a second one. Look first, and only dispatch when nothing came.
 */
const runFor = () => {
	const r = tryRun("gh", [
		"run", "list", "--workflow", "release.yml", "--limit", "20",
		"--json", "databaseId,headBranch,status,conclusion,event",
	]);
	if (r.status !== 0) return null;
	try {
		return JSON.parse(r.stdout).find((x) => x.headBranch === target) ?? null;
	} catch {
		return null;
	}
};

step(`Publishing ${target}`);

let run = runFor();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!run) {
	// Give the push trigger a moment before deciding it did not fire.
	for (let i = 0; i < 6 && !run; i++) {
		await sleep(5000);
		run = runFor();
	}
}

if (run) {
	ok(`release.yml is already running for ${target} (${run.event})`);
} else {
	note("no run started for the tag — the documented failure. Dispatching it.");
	const d = tryRun("gh", [
		"workflow", "run", "release.yml", "--ref", target,
		"-f", "why=cut by lib/release.mjs; the tag push did not start the workflow",
	]);
	if (d.status !== 0) {
		die(
			`could not dispatch release.yml for ${target}:`,
			(d.stderr || d.stdout || "").trim().split("\n")[0] || "unknown error",
			"",
			`Do it by hand:  gh workflow run release.yml --ref ${target}`,
		);
	}
	for (let i = 0; i < 12 && !run; i++) {
		await sleep(5000);
		run = runFor();
	}
	if (!run) {
		die(
			`dispatched release.yml for ${target}, but no run appeared.`,
			`Watch it yourself:  gh run list --workflow release.yml`,
		);
	}
	ok(`dispatched release.yml for ${target}`);
}

if (noWait) {
	step("Not waiting");
	note(`gh run watch ${run.databaseId}`);
	note(`then: pnpm run release --verify`);
	say();
	process.exit(0);
}

step("Waiting for it");
// `gh run watch` streams its own progress, so let it own the terminal. Its exit
// code follows the run's conclusion, but a failed run is not a failed script —
// the verification below says what actually shipped, which is more useful than
// a non-zero exit with no explanation.
spawnSync("gh", ["run", "watch", String(run.databaseId), "--exit-status"], { cwd: ROOT, stdio: "inherit" });

/*
 * ── Verify, which is the point ────────────────────────────────────────────────
 *
 * Three independent facts, because the ways this fails are independent: the
 * workflow can pass and create no release, create a release with no asset, or
 * publish everything and fail to push the tap for want of a token — which it
 * does with a `::warning::`, so the run is green and the install is stale.
 */
step("Did it actually ship?");

let failures = 0;
const expectedAsset = `rolemodel-openscreen-${target}.tar.gz`;

const rel = tryRun("gh", ["release", "view", target, "--json", "tagName,assets"]);
if (rel.status !== 0) {
	failures++;
	bad(`no release for ${target}`);
	note(`gh run view ${run.databaseId} --log-failed`);
} else {
	const assets = (() => {
		try {
			return JSON.parse(rel.stdout).assets.map((a) => a.name);
		} catch {
			return [];
		}
	})();
	ok(`the release for ${target} exists`);
	if (assets.includes(expectedAsset)) {
		ok(`it carries ${expectedAsset}`);
	} else {
		failures++;
		bad(`it has no ${expectedAsset} — Homebrew has nothing to download`);
		note(`assets: ${assets.join(", ") || "none"}`);
	}
}

const after = tapServes();
if (after.error) {
	failures++;
	bad(after.error);
} else if (after.version === target) {
	ok(`the published tap now serves ${target}`);
} else {
	failures++;
	bad(`the tap still serves ${after.version ?? "something unreadable"}, not ${target}`);
	note("release.yml only pushes the tap when TAP_TOKEN is set; without it the run is");
	note("green and prints a ::warning:: nobody reads. Check the run, then either add the");
	note("secret or bump Formula/rm-video.rb in the tap by hand.");
}

say();
if (failures) {
	say(`  ${target} is tagged but ${failures === 1 ? "one thing" : `${failures} things`} did not land. An install still gets the old version.`);
	say();
	process.exit(1);
}
say(`  ${target} is released, and the tap serves it.`);
say();
