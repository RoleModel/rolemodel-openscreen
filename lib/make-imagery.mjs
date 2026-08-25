/*
 * Vendor the clay renders a title or a scene can put on screen.
 *
 *   node lib/make-imagery.mjs [--check] [--brand-repo <path>] [--academy-repo <path>]
 *
 * make-logos.mjs brought in the wordmarks, which say *whose* video this is. These
 * are the other half: the clay-rendered objects — a keyboard, a plant, a browser,
 * a cursor — that the Academy brand uses as its subject imagery. A title card with
 * a wordmark and nothing else is a slide; these are what make it a picture.
 *
 * Copied rather than referenced, for the same reason as the logos: the Studio is
 * hosted by a desktop app that has to render with no network and no sibling
 * checkout, so anything reaching outside the install renders as a broken image
 * on a plane.
 *
 * Two sources, because the set is genuinely split:
 *
 *   academy-hyperframes/source-assets/academy   the renders as used in decks
 *   rolemodel-brand/imagery/site                the same family, as used on the site
 *
 * Where both carry the same object the brand repo wins, because that is the one
 * design maintains. Nothing is resized or re-encoded — a lossy pass over a lossy
 * webp to save a few KB would cost more in artefacts than it saves in bytes.
 */

import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const OUT = join(ROOT, "brand", "imagery");

const argv = process.argv.slice(2);
const CHECK = argv.includes("--check");
/** Deliberately discard local retouching and go back to the source. */
const FORCE = argv.includes("--force");
const flag = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const BRAND_REPO = resolve(flag("brand-repo", join(ROOT, "..", "..", "rolemodel-brand")));
const ACADEMY_REPO = resolve(flag("academy-repo", join(ROOT, "..", "..", "academy-hyperframes")));

/*
 * The wanted set, by the name it gets here rather than the name it has there.
 *
 * Source filenames carry two typos ("Acadmey-Cursor", "Acadmey-Keyboard") and
 * three naming conventions. Renaming on the way in means a composition asks for
 * `academy-keyboard` and does not have to know which repo it came from or how it
 * was spelled that day. `from` is listed in priority order; the first that exists
 * wins.
 */
const WANTED = [
	{ name: "academy-browser", from: ["brand:site/Academy-Browser.png", "academy:source-assets/academy/browser.webp"] },
	{ name: "academy-cursor", from: ["brand:site/Academy-Cursor-2.png", "brand:site/Acadmey-Cursor.png", "academy:source-assets/academy/cursor.webp"] },
	{ name: "academy-keyboard", from: ["brand:site/Acadmey-Keyboard.png", "academy:source-assets/academy/keyboard.webp"] },
	{ name: "academy-phone", from: ["brand:site/Academy-Phone.png"] },
	{ name: "academy-rocket", from: ["brand:site/Academy-Rocket.webp", "academy:3d-configuration-hyperframes/rocket.png"] },
	{ name: "academy-slide", from: ["brand:site/Academy-Slide.png"] },
	{ name: "academy-logo-clay", from: ["brand:site/Academy-Logo-Clay.png"] },
	{ name: "academy-plant", from: ["academy:source-assets/academy/plant.webp"] },
	{ name: "academy-ruby", from: ["academy:source-assets/academy/ruby.webp"] },
	{ name: "academy-javascript", from: ["academy:source-assets/academy/javascript.webp"] },
	{ name: "academy-questionmark", from: ["academy:source-assets/academy/questionmark.webp"] },
];

const say = (m) => {
	if (!CHECK) console.log(m);
};

const sha = async (p) => createHash("sha256").update(await readFile(p)).digest("hex").slice(0, 16);

const locate = async (spec) => {
	const [repo, rel] = spec.split(":");
	const base = repo === "brand" ? join(BRAND_REPO, "imagery") : ACADEMY_REPO;
	const p = join(base, rel);
	return (await stat(p).catch(() => null))?.isFile() ? p : null;
};

async function main() {
	await mkdir(OUT, { recursive: true });

	// What the last run wrote, which is how a local edit is told from a stale copy.
	const prior = await readFile(join(OUT, "index.json"), "utf8")
		.then((t) => JSON.parse(t).imagery ?? [])
		.catch(() => []);
	const priorByName = new Map(prior.map((e) => [e.name, e]));

	const entries = [];
	let copied = 0;
	const missing = [];
	const kept = [];

	for (const want of WANTED) {
		let src = null;
		for (const spec of want.from) {
			src = await locate(spec);
			if (src) break;
		}
		if (!src) {
			/*
			 * Recorded as absent, not skipped silently and not substituted. A
			 * composition asking for a plant should get a clear failure rather than a
			 * rocket, and the index is what tells it which it can have.
			 */
			missing.push(want.name);
			entries.push({ name: want.name, file: null });
			continue;
		}
		const file = want.name + extname(src).toLowerCase();
		const to = join(OUT, file);
		const before = await readFile(to).catch(() => null);
		const after = await readFile(src);

		/*
		 * A file that differs from the source is not necessarily out of date.
		 *
		 * These get retouched here — backgrounds cut out, mostly, which the source
		 * renders do not have — and the first version of this script treated any
		 * difference as drift and copied over the top. It destroyed an afternoon of
		 * that work twice in one session, silently, because "3 changed" reads as
		 * housekeeping rather than as a warning.
		 *
		 * So the index records the hash of what was last written here. A local file
		 * matching it is ours and may be replaced; one that does not is somebody's
		 * edit and is left alone. `--force` is the way to deliberately go back to
		 * the source, and it is the only path that overwrites.
		 */
		const srcSha = await sha(src);
		const localSha = before ? createHash("sha256").update(before).digest("hex").slice(0, 16) : null;
		/*
		 * A copy is byte-identical to its source. Anything else on disk is either a
		 * retouch or a stale copy of an older source — and both are somebody's, not
		 * this script's, so neither is overwritten without --force.
		 *
		 * The first attempt at this recorded the hash of what was written and
		 * compared against that, which was worse than useless: seeding it from the
		 * files already on disk marked the edits as ours and replaced them. The
		 * source hash is the only value that cannot be poisoned that way.
		 */
		const edited = Boolean(before && localSha !== srcSha);

		if (edited && !FORCE) {
			kept.push(want.name);
			entries.push({ name: want.name, file, bytes: before.length, sha: srcSha, local: localSha });
			continue;
		}

		if (!before || !before.equals(after)) {
			if (!CHECK) await copyFile(src, to);
			copied += 1;
		}
		// local === sha for an untouched copy; that equality is the whole test.
		entries.push({ name: want.name, file, bytes: after.length, sha: srcSha, local: srcSha });
	}

	/*
	 * Only ever remove a file this script wrote.
	 *
	 * The first version removed anything it did not currently want, which meant a
	 * retouched export saved under its own name — "academy-cursor Background
	 * Removed.png" — was deleted as an orphan on the next run. Nothing here has
	 * any business deleting a file it did not create, so the previous index is the
	 * list of what may go.
	 */
	const keep = new Set([...entries.filter((e) => e.file).map((e) => e.file), "index.json"]);
	const ours = new Set(prior.filter((e) => e.file).map((e) => e.file));
	const present = await readdir(OUT).catch(() => []);
	const orphans = present.filter((f) => ours.has(f) && !keep.has(f));
	const strangers = present.filter((f) => !ours.has(f) && !keep.has(f) && f !== "index.json");
	if (!CHECK) for (const f of orphans) await rm(join(OUT, f), { force: true });

	const index = `${JSON.stringify({ imagery: entries }, null, "\t")}\n`;
	const indexBefore = await readFile(join(OUT, "index.json"), "utf8").catch(() => null);
	const indexChanged = indexBefore !== index;
	if (!CHECK && indexChanged) await writeFile(join(OUT, "index.json"), index);

	/*
	 * An edit is not staleness. Failing the check on one would send anybody
	 * straight to `npm run imagery`, which is the command that destroys it.
	 */
	if (CHECK && (copied || orphans.length || indexChanged)) {
		console.error(
			`\n  brand/imagery is out of date (${copied} changed, ${orphans.length} orphaned).` +
				"\n  Run: npm run imagery\n",
		);
		process.exit(1);
	}

	for (const e of entries) {
		if (e.file) say(`    ${e.name.padEnd(22)} ${e.file}  ${(e.bytes / 1024).toFixed(0)}KB`);
	}
	if (missing.length) say(`\n  not found, recorded as null: ${missing.join(", ")}`);
	if (kept.length) say(`\n  kept your edits, not re-copied: ${kept.join(", ")}  (--force to discard them)`);
	if (strangers.length) say(`  left alone, not written by this script: ${strangers.join(", ")}`);
	say(`\n  ${copied} file(s) copied into brand/imagery\n`);
}

await main();
