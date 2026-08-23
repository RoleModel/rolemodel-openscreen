#!/usr/bin/env node
/*
 * Point a cask at a release, with checksums computed from the real assets.
 *
 *   node scripts/update-cask.mjs rolemodel-openscreen v1.9.6-rm.1
 *   node scripts/update-cask.mjs rolemodel-openscreen --latest
 *   node scripts/update-cask.mjs rolemodel-openscreen v1.9.6-rm.1 --check
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
	"rolemodel-openscreen": "RoleModel/openscreen",
	openscreen: "getopenscreen/openscreen",
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
const caskPath = join(ROOT, "Casks", `${name}.rb`);
if (!existsSync(caskPath)) die(`no cask at ${caskPath}`);

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
after = after.replace(
	/^(\s*)sha256 arm: "[0-9a-f]*",\n(\s*)intel: "[0-9a-f]*"$/m,
	`$1sha256 arm: "${sums.arm}",\n$2intel: "${sums.intel}"`,
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
console.log(`\n  wrote Casks/${name}.rb at ${version}`);
console.log(`  check it: brew audit --cask --online ${name}\n`);
