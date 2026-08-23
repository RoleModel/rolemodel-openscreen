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
import { copyFile, mkdir, readFile } from "node:fs/promises";
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
	if (have === want) continue;
	drift.push({ from, to, added: have === null });
	if (!check) {
		await mkdir(dirname(dest), { recursive: true });
		await copyFile(src, dest);
	}
}

if (!drift.length) {
	console.log(`\n  the tap matches packaging/ (${LAYOUT.length} files)\n`);
	process.exit(0);
}

if (check) {
	console.error(`\n  ✗ the tap is out of date — ${drift.length} file(s):`);
	for (const d of drift) console.error(`      ${d.to}${d.added ? " (missing)" : ""}`);
	console.error("\n  run `npm run sync-tap`\n");
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
