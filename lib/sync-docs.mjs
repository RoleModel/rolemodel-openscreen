/*
 * Publish docs/ to the Docusaurus site in the openscreen fork.
 *
 *   node lib/sync-docs.mjs [--check]
 *
 * The fork already ships a working Docusaurus site — nine pages, a typed
 * sidebar, a build — so the choice was to hijack it or stand up a second one.
 * A second docs site is a second thing to deploy and a second place for a stale
 * page to sit unnoticed.
 *
 * The source stays here, because this is the repo you open. The site is a build
 * output, the same arrangement as the Homebrew tap: edit `docs/`, run this. It
 * adds the frontmatter Docusaurus needs and rewrites relative links between our
 * pages to the slugs it serves them at.
 *
 * `--check` reports drift without writing, and `npm run check` runs it — a docs
 * site that no longer matches the repo is the failure this exists to prevent.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

/** Our pages, in the order the sidebar shows them, with the titles it uses. */
const PAGES = [
	{ file: "KICKOFF.md", slug: "pipeline", title: "The video pipeline", position: 1 },
	{ file: "DEVELOPMENT.md", slug: "development", title: "Development", position: 2 },
	{ file: "LIBRARY.md", slug: "library", title: "The library", position: 3 },
];

const argv = process.argv.slice(2);
const check = argv.includes("--check");
const siteArg = argv.indexOf("--site");
const SITE = resolve(siteArg === -1 ? join(ROOT, "..", "openscreen", "website") : argv[siteArg + 1]);
const OUT = join(SITE, "docs", "rolemodel");

if (!existsSync(SITE)) {
	console.error(`\nsync-docs: no site at ${SITE}`);
	console.error("  npm run forks   # fetches the openscreen checkout\n");
	process.exit(1);
}

/** Rewrite links between our own pages, and drop links that leave the site. */
function forSite(body, page) {
	let out = body;
	for (const other of PAGES) {
		/*
		 * Point at the FILE, not the slug.
		 *
		 * `(./pipeline)` resolves against the page's URL — from
		 * /docs/rolemodel/development/ that is
		 * /docs/rolemodel/development/pipeline/, which does not exist, and
		 * Docusaurus fails the build over it. A `.md` target resolves against the
		 * source file instead, and survives a slug change.
		 */
		out = out.replaceAll(`(${other.file})`, `(./${other.slug}.md)`);
		out = out.replaceAll(`(docs/${other.file})`, `(./${other.slug}.md)`);
	}
	// A relative link to a repo file means nothing on a docs site; point at GitHub.
	out = out.replace(
		/\]\((?!https?:|\.\/|#)([A-Za-z0-9_./-]+)\)/g,
		"](https://github.com/RoleModel/rolemodel-openscreen/blob/main/$1)",
	);

	/*
	 * MDX is not Markdown, and the difference bites in exactly one place here.
	 *
	 * Docusaurus 3 parses pages as MDX, where `<` starts a JSX tag. An autolink —
	 * `<https://example.com>`, which is ordinary Markdown — reads as a tag called
	 * `https` and fails the build with "Unexpected character `/` before local
	 * name". Rewritten as an explicit link it means the same thing and parses.
	 *
	 * Code spans and fences are left alone: MDX does not parse inside them, which
	 * is why `<library>/<id>/<rel>` in backticks was never the problem.
	 */
	out = out
		.split(/(```[\s\S]*?```|`[^`\n]*`)/)
		.map((chunk, i) => (i % 2 === 1 ? chunk : chunk.replace(/<((?:https?|mailto):[^>\s]+)>/g, "[$1]($1)")))
		.join("");

	return `---\ntitle: ${page.title}\nsidebar_position: ${page.position}\n---\n\n${out}`;
}

await mkdir(OUT, { recursive: true });
const drift = [];

for (const page of PAGES) {
	const src = join(ROOT, "docs", page.file);
	if (!existsSync(src)) continue;
	const want = forSite(await readFile(src, "utf8"), page);
	const dest = join(OUT, `${page.slug}.md`);
	const have = existsSync(dest) ? await readFile(dest, "utf8") : null;
	if (have === want) continue;
	drift.push({ slug: page.slug, added: have === null });
	if (!check) await writeFile(dest, want, "utf8");
}

// A page removed here has to be removed there, or the site keeps serving it.
const slugs = new Set(PAGES.map((p) => p.slug));
for (const name of await readdir(OUT).catch(() => [])) {
	if (!name.endsWith(".md")) continue;
	if (slugs.has(name.replace(/\.md$/, ""))) continue;
	drift.push({ slug: name, stale: true });
}

console.log("");
if (!drift.length) {
	console.log(`  the site matches docs/ (${PAGES.length} pages)\n`);
	process.exit(0);
}
if (check) {
	console.error(`  ✗ the docs site is out of date — ${drift.length} page(s):`);
	for (const d of drift) console.error(`      ${d.slug}${d.stale ? " (no longer in docs/)" : d.added ? " (missing)" : ""}`);
	console.error("\n  run `npm run sync-docs`\n");
	process.exit(1);
}
for (const d of drift) {
	if (d.stale) console.log(`  stale, delete it: docs/rolemodel/${d.slug}`);
	else console.log(`  wrote docs/rolemodel/${d.slug}.md${d.added ? " (new)" : ""}`);
}
console.log(`\n  in ${SITE}\n  add a category to sidebars.ts once — see the README there\n`);
