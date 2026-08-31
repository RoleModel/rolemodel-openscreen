/*
 * Publish packaging/ to the Homebrew tap.
 *
 * The tap exists only because Homebrew resolves `brew tap rolemodel/tap` to a
 * repository named `homebrew-tap` and nothing else. That naming rule is not
 * something a monorepo can absorb, so instead of pretending the tap is a place
 * to work, this makes it a build output: edit `packaging/`, run this, done.
 *
 * It exists because the alternative already failed. The toolkit carried its own
 * copy of `rm-video.rb` next to the tap's, with a comment saying the copy was
 * there "so the formula and the code it describes move together". They drifted
 * anyway — the tap's copy grew six CLIs and a shim that the toolkit's copy never
 * heard about. One source of truth, mechanically copied, is the only version of
 * this that holds.
 *
 *   node lib/sync-tap.mjs [--check] [--tap <path>]
 *
 * `--check` reports drift without writing, which is what CI should run: a tap
 * that no longer matches packaging/ means someone edited the wrong copy.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

/** Where each packaging file has to land. Homebrew resolves by directory. */
const LAYOUT = [
	{ from: "packaging/rm-video.rb", to: "Formula/rm-video.rb" },
	{ from: "packaging/rolemodel-openscreen.rb", to: "Casks/rolemodel-openscreen.rb" },
	{ from: "packaging/update-cask.mjs", to: "scripts/update-cask.mjs" },
];

const argv = process.argv.slice(2);
const check = argv.includes("--check");
const tapArg = argv.indexOf("--tap");
// A sibling checkout by default, because that is where it is: this repo and the
// tap sit next to each other.
const TAP = resolve(tapArg === -1 ? join(ROOT, "..", "homebrew-tap") : argv[tapArg + 1]);

if (!existsSync(TAP)) {
	console.error(`sync-tap: no tap at ${TAP}`);
	console.error("  clone it beside this repo, or pass --tap <path>:");
	console.error("    git clone https://github.com/RoleModel/homebrew-tap.git");
	process.exit(1);
}

/**
 * Keep the destination's release-filled lines.
 *
 * `url`, `version` and `sha256` are written into the tap by release.yml from a
 * real tag and a real checksum. packaging/ carries whatever the last release
 * left, which is by definition older, so copying them over is how a tap gets
 * pointed back at a previous version.
 */
function carryGenerated(want, have) {
	/*
	 * The arch label is part of the key, and one of them has no key at all.
	 *
	 * A cask writes its checksums as
	 *
	 *   sha256 arm:   "…",
	 *          intel: "…"
	 *
	 * so a pattern going from the key straight to the quote matched neither line.
	 * An unmatched line is copied from packaging/ verbatim — the placeholder — so
	 * this carried `version` faithfully and silently replaced both checksums with
	 * stale ones: a cask that installs nothing, failing with a mismatch that
	 * reads like a security warning. Precisely the un-release this function
	 * exists to prevent.
	 *
	 * The identity of a carried line is its indent plus everything before the
	 * opening quote, which handles the keyed line and the continuation alike.
	 * `arm|intel` rather than any word, so a hand-written `verified:` in the url
	 * block stays packaging/'s to change.
	 */
	const GENERATED = /^([ \t]*)((?:url|version|sha256)(?:[ \t]+(?:arm|intel):)?[ \t]*|(?:arm|intel):[ \t]*)"[^"\n]*"/gm;
	return want.replace(GENERATED, (whole, indent, label) => {
		const literal = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[ \t]+/g, "[ \\t]+");
		const found = new RegExp(`^${indent}${literal}"([^"\n]*)"`, "m").exec(have);
		return found ? `${indent}${label}"${found[1]}"` : whole;
	});
}

const drift = [];
for (const { from, to } of LAYOUT) {
	const src = join(ROOT, from);
	const dest = join(TAP, to);
	if (!existsSync(src)) {
		console.error(`sync-tap: ${from} is missing`);
		process.exit(1);
	}
	const want = await readFile(src, "utf8");
	const have = existsSync(dest) ? await readFile(dest, "utf8") : null;
	/*
	 * A release fills in `url`, `version` and `sha256` in the TAP. Those lines
	 * are the one part of these files packaging/ is not the source of, so they
	 * are carried over rather than compared or copied.
	 *
	 * Without this the check failed the moment a release happened — packaging/
	 * still holds the placeholder the last release replaced — and the advice it
	 * printed, `pnpm run sync-tap`, would then overwrite the released formula
	 * with that placeholder and quietly un-release it. The failing check told you
	 * to break the thing it was complaining about.
	 */
	const merged = have ? carryGenerated(want, have) : want;
	if (have === merged) continue;
	drift.push({ from, to, added: have === null });
	if (!check) {
		await mkdir(dirname(dest), { recursive: true });
		await writeFile(dest, merged, "utf8");
	}
}

if (!drift.length) {
	console.log(`\n  the tap matches packaging/ (${LAYOUT.length} files)\n`);
	process.exit(0);
}

if (check) {
	console.error(`\n  ✗ the tap is out of date — ${drift.length} file(s):`);
	for (const d of drift) console.error(`      ${d.to}${d.added ? " (missing)" : ""}`);
	console.error("\n  run `pnpm run sync-tap`\n");
	process.exit(1);
}

console.log("");
for (const d of drift) console.log(`  wrote ${d.to}${d.added ? " (new)" : ""}`);

// Committed here rather than left dirty: a synced-but-uncommitted tap is
// indistinguishable from a stale one the next time somebody looks.
const git = (...args) => execFileSync("git", args, { cwd: TAP, encoding: "utf8" });
const version = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")).version;
try {
	git("add", ...LAYOUT.map((l) => l.to));
	const staged = git("diff", "--cached", "--name-only").trim();
	if (staged) {
		git("-c", "user.name=RoleModel", "-c", "user.email=dev@rolemodelsoftware.com", "commit", "-m", `Sync packaging from rolemodel-openscreen ${version}`);
		console.log(`\n  committed in ${basename(TAP)} — push it when you are ready\n`);
	}
} catch (err) {
	console.log(`\n  copied, but could not commit: ${err.message.split("\n")[0]}\n`);
}
