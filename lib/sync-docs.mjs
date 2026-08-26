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
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

/*
 * Our pages, in the order the sidebar shows them, with the titles it uses.
 *
 * NOT every page in docs/. This list is a publishing decision, and the site it
 * writes to is a fork of a public repo — GitHub does not allow a fork of a
 * public repo to be made private, so anything named here is public the moment it
 * is committed, whether or not Pages is ever switched on.
 *
 * KICKOFF.md and LIBRARY.md are deliberately absent. They are internal notes
 * about how the pipeline is run, written for whoever changes it, and they name
 * client work in their examples. They stay in this repo, which is private.
 */
const PAGES = [
	{ file: "USING-THE-STUDIO.md", slug: "using-the-studio", title: "Making a video", position: 1 },
	{ file: "DEVELOPMENT.md", slug: "development", title: "Development", position: 2 },
	{ file: "AI-AGENTS.md", slug: "agents", title: "AI agents", position: 3 },
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
	/*
	 * A relative link to a repo file means nothing on a docs site; point at GitHub.
	 *
	 * `../` is resolved rather than pasted. These pages live in docs/, so a link
	 * to a sibling directory is written `../lib/agents.mjs` — and pasting that
	 * after `/blob/main/` produced `/blob/main/../lib/agents.mjs`, which GitHub
	 * does not resolve. The link looked right in the repo and 404'd on the site,
	 * which is the failure mode this whole script exists to prevent.
	 */
	out = out.replace(/\]\((?!https?:|\.\/|#)([A-Za-z0-9_./-]+)\)/g, (_match, target) => {
		// Relative to docs/, then normalised, so ../lib/x becomes lib/x.
		const fromRepoRoot = join("docs", target).split(sep).join("/");
		return `](https://github.com/RoleModel/rolemodel-openscreen/blob/main/${fromRepoRoot})`;
	});

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

/*
 * A synced page that no sidebar lists is a page nobody can reach.
 *
 * `sidebars.ts` enumerates slugs by hand, so adding a page here builds fine,
 * publishes fine, and is invisible on the site — the worst kind of drift,
 * because every signal says it worked. Checked rather than written: the sidebar
 * is the fork's file, and rewriting another repo's source from a sync script is
 * how you get a merge conflict nobody expects.
 */
const sidebarFile = join(SITE, "sidebars.ts");
const sidebar = await readFile(sidebarFile, "utf8").catch(() => "");
const unlisted = sidebar ? PAGES.filter((page) => !sidebar.includes(`rolemodel/${page.slug}`)) : [];

if (check && unlisted.length) {
	console.error(`  ✗ ${unlisted.length} page(s) are not in the sidebar and cannot be reached:`);
	for (const page of unlisted) console.error(`      rolemodel/${page.slug}`);
	console.error(`\n  add them to the RoleModel category in ${sidebarFile}\n`);
	process.exit(1);
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
	if (d.stale) {
		/*
		 * Removed here, removed there.
		 *
		 * This used to print "stale, delete it" and leave the file in place, so
		 * un-publishing a page did not un-publish it — the site kept serving a
		 * page this repo had decided to stop publishing, which is the exact
		 * failure the script exists to prevent, pointing the other way.
		 *
		 * Safe because of what it deletes: a `.md` directly under the rolemodel
		 * directory, which is a directory this script owns and writes nothing
		 * else into. Anything the site has of its own lives outside it.
		 */
		await rm(join(OUT, d.slug), { force: true });
		console.log(`  removed docs/rolemodel/${d.slug} (no longer published)`);
	} else {
		console.log(`  wrote docs/rolemodel/${d.slug}.md${d.added ? " (new)" : ""}`);
	}
}
if (unlisted.length) {
	console.log(`\n  NOT IN THE SIDEBAR, so not reachable on the site:`);
	for (const page of unlisted) console.log(`      rolemodel/${page.slug}`);
	console.log(`  add them to the RoleModel category in ${sidebarFile}`);
}
console.log(`\n  in ${SITE}\n`);
