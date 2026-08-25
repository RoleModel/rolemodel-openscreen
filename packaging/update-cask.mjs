#!/usr/bin/env node
/*
 * Point a cask at a release, with checksums computed from the real assets.
 *
 * This file has two paths, because it is one source copied to one build output:
 * `packaging/update-cask.mjs` here, and `scripts/update-cask.mjs` in the tap, where
 * `lib/sync-tap.mjs` puts it. Run it from whichever checkout you are standing in —
 * it rewrites the cask beside it, so the tap is the usual one.
 *
 *   node packaging/update-cask.mjs rolemodel-openscreen v0.0.1   # here, then sync-tap
 *   node scripts/update-cask.mjs   rolemodel-openscreen v0.0.1   # in the tap
 *   node scripts/update-cask.mjs   rolemodel-openscreen --latest
 *   node scripts/update-cask.mjs   rolemodel-openscreen v1.9.6-rm.1 --check
 *
 * A cask is three facts — a version, a URL pattern and a checksum per arch — and
 * two of them change on every release. Hand-editing them is how a tap ends up
 * installing last month's build: upstream ships an `update-homebrew-cask.yml`
 * that has never been configured (their issue #335), and the job it guards has
 * been skipping green on every release since. The failure is silent, which is the
 * problem.
 *
 * So this reads the release's asset list, downloads each DMG, hashes it, and
 * rewrites the `version` and `sha256` lines in place. Everything else in the cask
 * — the URL pattern, the caveats, the conflicts — is hand-written and left alone.
 *
 * `--check` verifies without writing, which is what CI should run: a cask whose
 * checksums no longer match its release means someone re-cut a tag, and that is
 * worth failing a build over rather than discovering at `brew install`.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

/** Which repo each cask tracks. A cask that named the wrong repo would hash the wrong DMGs. */
const REPOS = {
	// One entry, and there used to be two. The second was upstream's own build,
	// carried "for comparison" — nothing installed it, nothing depended on it, and
	// pointing this script at it would now rewrite a cask the tap no longer has.
	"rolemodel-openscreen": "RoleModel/openscreen",
};

/** The arch labels build.yml renames its DMGs to, and the cask's `arch` keys. */
const ARCHES = [
	{ key: "arm", label: "Apple-Silicon" },
	{ key: "intel", label: "Intel" },
];

const argv = process.argv.slice(2);
const name = argv[0];
const wanted = argv.find((a) => a.startsWith("v")) ?? null;
const latest = argv.includes("--latest");
const check = argv.includes("--check");

function die(msg) {
	console.error(`update-cask: ${msg}`);
	process.exit(1);
}

if (!name || !REPOS[name]) {
	die(`name a cask: ${Object.keys(REPOS).join(" | ")}`);
}
if (!wanted && !latest) die("give a tag (v1.2.3) or --latest");

const repo = REPOS[name];
/*
 * The cask, wherever this copy of the script is standing.
 *
 * Two layouts, because this file is one source copied to one build output: the tap
 * keeps casks in `Casks/`, and this toolkit keeps the source of truth in
 * `packaging/`. Only `Casks/` was ever looked for, so the usage this file documents
 * — running it from the toolkit — died with "no cask at .../Casks/…" and the only
 * working path was the tap copy.
 *
 * Which mattered more than a bad error message: `lib/sync-tap.mjs` publishes
 * packaging/ over the tap, so a version written straight into the tap's cask is
 * overwritten by the next sync and `sync-tap:check` reports the drift. The source of
 * truth has to be the thing that gets updated.
 */
const caskPath = [join(ROOT, "Casks", `${name}.rb`), join(ROOT, "packaging", `${name}.rb`)].find(
	(candidate) => existsSync(candidate),
);
if (!caskPath) {
	die(`no cask for "${name}" — looked in ${join(ROOT, "Casks")} and ${join(ROOT, "packaging")}`);
}

const api = async (path) => {
	const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
		headers: {
			accept: "application/vnd.github+json",
			// A token lifts the rate limit and is required for a private fork. Not
			// required for a public one, which is why this is optional.
			...(process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN}` } : {}),
		},
	});
	if (!res.ok) die(`github said ${res.status} for ${path}`);
	return res.json();
};

const release = latest ? await api("/releases/latest") : await api(`/releases/tags/${wanted}`);
const tag = release.tag_name;
const version = tag.replace(/^v/, "");
console.log(`\n  ${repo} ${tag}`);

const sums = {};
for (const { key, label } of ARCHES) {
	const wantName = `Openscreen-macOS-${label}-${version}.dmg`;
	const asset = (release.assets ?? []).find((a) => a.name === wantName);
	if (!asset) {
		const had = (release.assets ?? []).map((a) => a.name).join(", ") || "none";
		die(`${tag} has no ${wantName}\n  assets: ${had}`);
	}
	process.stdout.write(`  hashing ${asset.name} (${(asset.size / 1e6).toFixed(0)}MB) … `);
	const dmg = await fetch(asset.browser_download_url, {
		headers: process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN}` } : {},
	});
	if (!dmg.ok) die(`download said ${dmg.status}`);
	const hash = createHash("sha256").update(Buffer.from(await dmg.arrayBuffer())).digest("hex");
	sums[key] = hash;
	console.log(hash.slice(0, 16));
}

const before = await readFile(caskPath, "utf8");
// Replace only the generated lines. Anchored on the whole statement rather than
// on a bare hex string, so a checksum quoted in a comment is not rewritten.
let after = before.replace(/^(\s*)version ".*"$/m, `$1version "${version}"`);
/*
 * The whitespace after each key is captured and put back, not assumed.
 *
 * `brew style` aligns the values of a multi-line hash — `sha256 arm:` gains
 * padding so the two hex strings line up — and this pattern used to require
 * exactly one space. The styled cask therefore matched nothing, and the run died
 * on "has the cask been reformatted?" with the release already built. Capturing
 * the run of spaces means either style round-trips, and a bump leaves the file as
 * `brew style` wants it rather than un-aligning it again.
 */
after = after.replace(
	/^(\s*)sha256(\s+)arm:(\s+)"[0-9a-f]*",\n(\s*)intel:(\s+)"[0-9a-f]*"$/m,
	`$1sha256$2arm:$3"${sums.arm}",\n$4intel:$5"${sums.intel}"`,
);

if (after === before) {
	console.log("\n  already current\n");
	process.exit(0);
}
if (!after.includes(`version "${version}"`) || !after.includes(sums.arm)) {
	die("could not find the version/sha256 lines to rewrite — has the cask been reformatted?");
}

if (check) {
	console.error(`\n  ✗ ${name}.rb does not match ${tag}\n`);
	process.exit(1);
}

await writeFile(caskPath, after, "utf8");
console.log(`\n  wrote ${caskPath.replace(`${ROOT}/`, "")} at ${version}`);
if (caskPath.includes("/packaging/")) {
	// packaging/ is the source; the tap is a build output. Saying so here is cheaper
	// than finding out from sync-tap:check on the next run.
	console.log("  now run `npm run sync-tap` to publish it\n");
}
console.log(`  check it: brew audit --cask --online ${name}\n`);
