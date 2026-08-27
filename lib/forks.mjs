/*
 * Put the two forks where they belong, in one command.
 *
 *   pnpm run forks          clone or update them
 *   pnpm run forks:check    say where they are and how far from upstream
 *
 * Four repositories is too many to hold in your head, and this is as close to a
 * monorepo as the situation actually allows. Folding the forks in as directories
 * was the obvious move and it is the wrong one: our diff on OpenScreen is 661
 * lines on top of 2260 upstream commits, and it is small on purpose — that is
 * what makes `git pull upstream main` a non-event. In a monorepo every upstream
 * release becomes a manual merge of somebody else's project instead, which is a
 * bill you pay forever to save a clone you do once.
 *
 * So: one repository you open, and one command that fetches the other two when
 * you need them. Most people never do — they install the app from the cask and
 * never see either fork.
 *
 * They land as siblings rather than children, because they have their own
 * node_modules, their own build systems and their own .gitignore, and nesting a
 * 2000-file Next.js app inside this tree makes every glob here slower and every
 * `git status` noisier.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
/** Siblings of this repo. */
const BESIDE = resolve(ROOT, "..");

const FORKS = [
	{
		dir: "openscreen",
		origin: "https://github.com/RoleModel/openscreen.git",
		upstream: "https://github.com/getopenscreen/openscreen.git",
		what: "records, edits and exports — the app itself",
		needed: "only to build the app; the cask is the normal way in",
	},
	{
		dir: "openframe",
		origin: "https://github.com/RoleModel/OpenFrame.git",
		upstream: "https://github.com/yusufipk/OpenFrame.git",
		what: "client review — timestamped comments, versions, approval",
		needed: "only to run or change the review instance",
	},
];

const argv = process.argv.slice(2);
const check = argv.includes("--check");

const git = (dir, ...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
const quiet = (dir, ...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });

let missing = 0;
console.log("");

for (const fork of FORKS) {
	const path = join(BESIDE, fork.dir);
	const there = existsSync(join(path, ".git"));

	if (!there) {
		missing++;
		if (check) {
			console.log(`  ${fork.dir.padEnd(11)} not cloned`);
			console.log(`  ${"".padEnd(11)} ${fork.needed}`);
			continue;
		}
		console.log(`  ${fork.dir.padEnd(11)} cloning…`);
		execFileSync("git", ["clone", fork.origin, path], { stdio: "inherit" });
		// The upstream remote is the whole point of not vendoring these. Added at
		// clone time so nobody has to remember, and so `git pull upstream main`
		// works the first time somebody tries it.
		quiet(path, "remote", "add", "upstream", fork.upstream);
		quiet(path, "fetch", "upstream", "--tags");
		console.log(`  ${"".padEnd(11)} upstream remote added`);
		continue;
	}

	// Already there: report where it stands rather than moving it. Fetching is
	// safe; checking out or merging is not, and this script does not know what
	// somebody is in the middle of.
	quiet(path, "fetch", "origin", "--tags");
	quiet(path, "fetch", "upstream", "--tags");
	const branch = git(path, "rev-parse", "--abbrev-ref", "HEAD");
	// Ask which branch upstream calls default rather than assuming `main`.
	// OpenFrame's is `master`, which turned "0 behind" into a git error on stderr
	// and a pair of question marks — the wrong answer delivered confidently.
	const head = quiet(path, "symbolic-ref", "refs/remotes/upstream/HEAD");
	const base =
		head.status === 0 && head.stdout.trim()
			? head.stdout.trim().replace("refs/remotes/", "")
			: null;

	let ahead = "?";
	let behind = "?";
	if (base) {
		// `quiet` so a missing ref reports as unknown instead of printing git's
		// advice about separating paths from revisions.
		const a = quiet(path, "rev-list", "--count", `${base}..HEAD`);
		const b = quiet(path, "rev-list", "--count", `HEAD..${base}`);
		if (a.status === 0) ahead = a.stdout.trim();
		if (b.status === 0) behind = b.stdout.trim();
	}
	const dirty = git(path, "status", "--porcelain").length > 0;
	console.log(`  ${fork.dir.padEnd(11)} ${branch}${dirty ? " (uncommitted changes)" : ""}`);
	console.log(`  ${"".padEnd(11)} ${ahead} ahead of upstream, ${behind} behind`);
	if (Number(behind) > 0) {
		const upstreamBranch = base?.replace("upstream/", "") ?? "main";
		console.log(`  ${"".padEnd(11)} to catch up:  cd ../${fork.dir} && git pull upstream ${upstreamBranch}`);
	}
}

console.log("");
if (check && missing) {
	console.log(`  ${missing} not cloned. Run \`pnpm run forks\` to get them.\n`);
	process.exit(1);
}
if (!check) {
	console.log("  Both are siblings of this repo. You rarely need either:");
	for (const f of FORKS) console.log(`    ../${f.dir.padEnd(11)} ${f.what}`);
	console.log("");
}
