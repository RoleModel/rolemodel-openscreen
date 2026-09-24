/*
 * Pull the OpenScreen fork up to upstream's latest, in one command.
 *
 *   pnpm run forks:upgrade            do it
 *   pnpm run forks:upgrade --dry-run  just say how far behind we are and what would happen
 *
 * `forks.mjs` deliberately refuses to merge — it does not know what you are in
 * the middle of. This is the command that says yes, and it is separate for that
 * reason: you run it on purpose, on a clean tree, and it makes a branch.
 *
 * WHY THIS EXISTS
 *
 * The comment at the top of forks.mjs claimed our OpenScreen diff was 661 lines,
 * which made `git pull upstream main` "a non-event". By the time anybody checked
 * it was 7,696 lines across 82 files and five minor releases behind, and the
 * upgrade was a day's work with 39 conflicts. Nothing had gone wrong; the number
 * had just stopped being true and no command ever said so.
 *
 * So two things here. The gap is now printed every time, by forks.mjs --check,
 * which `pnpm run check` already runs — drift you can see is drift you act on.
 * And the mechanical half of the merge is automated, because it is the same
 * mechanical half every time:
 *
 *   - Upstream keeps editing the eighteen stock wallpapers this fork deleted
 *     ("The brand boards, and only the brand boards"). That is 36 delete/modify
 *     conflicts whose answer is always "stay deleted". They are resolved here,
 *     and not from a hand-kept list: any file present in the merge base and in
 *     upstream but absent here was deleted on purpose, and git can say which.
 *   - Everything else stops for a human. Conflicts in code are where the two
 *     projects disagree about behaviour, and a script that guesses at those is
 *     worse than no script — it produces a merge that compiles and is wrong.
 *
 * What it does NOT do is commit. The merge is left staged so you read it.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const arg = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};

const FORK = resolve(arg("openscreen", join(ROOT, "..", "openscreen")));

/** Run in the fork and return trimmed stdout; throws on a non-zero exit. */
const git = (...args) => execFileSync("git", args, { cwd: FORK, encoding: "utf8" }).trim();
/** Run in the fork and hand back the result, so a failure is data rather than a throw. */
const quiet = (...args) => spawnSync("git", args, { cwd: FORK, encoding: "utf8" });

const say = (line = "") => console.log(line);
const die = (...lines) => {
	say();
	for (const line of lines) console.error(`  ${line}`);
	say();
	process.exit(1);
};

if (!existsSync(join(FORK, ".git"))) {
	die(`no OpenScreen checkout at ${FORK}`, "pnpm run forks   # clones it beside this repo");
}

say();

/*
 * A dirty tree is the one thing that makes this unsafe: `git merge` would either
 * refuse halfway or carry somebody's work-in-progress into the merge commit.
 * Checked before the fetch so the answer arrives fast.
 */
if (!dryRun && git("status", "--porcelain").length > 0) {
	die(
		`${FORK} has uncommitted changes.`,
		"Commit or set them aside first — an upgrade rewrites a lot of files and",
		"a merge is a bad place to discover what was already in flight.",
	);
}

say("  fetching…");
quiet("fetch", "origin", "--tags");
if (quiet("fetch", "upstream", "--tags").status !== 0) {
	die(
		"no `upstream` remote, or the fetch failed.",
		"git remote add upstream https://github.com/getopenscreen/openscreen.git",
	);
}

/*
 * Ask which branch upstream calls default rather than assuming `main` — the same
 * reason forks.mjs asks. A fork whose upstream uses `master` otherwise gets a git
 * error on stderr and a confident wrong answer.
 */
const head = quiet("symbolic-ref", "refs/remotes/upstream/HEAD");
const upstreamRef =
	head.status === 0 && head.stdout.trim()
		? head.stdout.trim().replace("refs/remotes/", "")
		: "upstream/main";

const localDefault = (() => {
	const r = quiet("symbolic-ref", "refs/remotes/origin/HEAD");
	return r.status === 0 && r.stdout.trim()
		? r.stdout.trim().replace("refs/remotes/origin/", "")
		: "main";
})();

const version = (ref) => {
	const r = quiet("show", `${ref}:package.json`);
	if (r.status !== 0) return "?";
	try {
		return JSON.parse(r.stdout).version ?? "?";
	} catch {
		return "?";
	}
};

const base = git("merge-base", localDefault, upstreamRef);
const behind = git("rev-list", "--count", `${localDefault}..${upstreamRef}`);
const ahead = git("rev-list", "--count", `${upstreamRef}..${localDefault}`);
const baseDate = git("log", "-1", "--format=%cs", base);
const upstreamVersion = version(upstreamRef);

/*
 * The size of what we carry, which is the number that actually predicts how much
 * an upgrade will hurt. Counted over source only: the brand wallpapers and icons
 * are large, generated, and never conflict, so including them would hide the
 * trend this number exists to show.
 */
const SOURCE = ["src", "electron", "scripts", "website", "*.ts", "*.json5", "*.cjs"];
const forkDiff = git("diff", "--shortstat", base, localDefault, "--", ...SOURCE);

say(`  fork        ${localDefault} at ${version(localDefault)}`);
say(`  upstream    ${upstreamRef} at ${upstreamVersion}`);
say(`  gap         ${behind} commits behind, ${ahead} ahead (forked ${baseDate})`);
say(`  our diff    ${forkDiff || "none"}`);
say();

if (Number(behind) === 0) {
	say("  already up to date.\n");
	process.exit(0);
}

/*
 * Files upstream still has that this fork removed on purpose. Derived, not listed:
 * present in the merge base and upstream, absent here. Upstream editing any of
 * them is a delete/modify conflict whose answer is always the deletion.
 */
const tree = (ref) => new Set(git("ls-tree", "-r", "--name-only", ref).split("\n").filter(Boolean));
const here = tree(localDefault);
const atBase = tree(base);
const deletedOnPurpose = new Set(
	[...tree(upstreamRef)].filter((p) => !here.has(p) && atBase.has(p)),
);

const branch = arg("branch", `rolemodel/upgrade-${upstreamVersion}`);

if (dryRun) {
	say(`  would branch ${branch} off ${localDefault} and merge ${upstreamRef}.`);
	say(`  ${deletedOnPurpose.size} deliberately-deleted file(s) would be kept deleted.`);
	say("\n  run without --dry-run to do it.\n");
	process.exit(0);
}

if (quiet("rev-parse", "--verify", branch).status === 0) {
	die(`${branch} already exists.`, "Delete it, or pass --branch <name>.");
}

say(`  branching ${branch} off ${localDefault}…`);
execFileSync("git", ["checkout", "-b", branch, localDefault], { cwd: FORK, stdio: "inherit" });

say(`  merging ${upstreamRef}…`);
// --no-commit: the merge is left staged on purpose. Someone reads it.
const merge = quiet("merge", upstreamRef, "--no-commit");
const conflicted = () =>
	git("diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);

let resolved = 0;
for (const path of conflicted()) {
	if (!deletedOnPurpose.has(path)) continue;
	if (quiet("rm", "-q", "-f", "--", path).status === 0) resolved++;
}
if (resolved) say(`  kept ${resolved} deliberately-deleted file(s) deleted.`);

const left = conflicted();
if (left.length === 0) {
	say();
	if (merge.status !== 0) {
		say("  every conflict was mechanical. The merge is staged.");
	} else {
		say("  merged clean. The merge is staged.");
	}
	say();
	say("  next, in the fork:");
	say("    npm ci && npx tsc --noEmit && npm test");
	say("    (cd website && node scripts/gen-recreation.mjs --check)");
	say("    git commit");
	say();
	process.exit(0);
}

/*
 * What is left is the part worth a person's attention. Grouped and sized, because
 * "20 conflicts" and "20 conflicts, 31 hunks, 7 of them in ipc/handlers.ts" are
 * very different afternoons.
 */
say();
say(`  ${left.length} conflict(s) left for you — code, where the two projects disagree:`);
say();
let hunks = 0;
for (const path of left) {
	// Marker count rather than `git diff`: it is the number that says how much
	// reading a file needs. Zero means no markers were written — a binary file, or
	// a delete/modify git could not express inline.
	const count = spawnSync("grep", ["-c", "^<<<<<<<", join(FORK, path)], { encoding: "utf8" });
	const n = Number(count.stdout?.trim() || 0);
	hunks += n;
	say(`    ${n ? `${String(n).padStart(2)} hunk(s)` : "no markers"}  ${path}`);
}
say();
say(`  ${hunks} hunk(s) total.`);
say();
say("  Before resolving, read docs/MERGING-UPSTREAM.md in this repo — it records");
say("  the decisions this fork has already made, so you do not re-derive them.");
say();
say("  When the tree is clean:");
say("    npx tsc --noEmit && npm test    # in the fork");
say("    git commit");
say();
process.exit(1);
