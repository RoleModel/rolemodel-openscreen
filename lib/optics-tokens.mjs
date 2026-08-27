/*
 * Extract Optics' token layer for the app, and nothing else.
 *
 *   node lib/optics-tokens.mjs [--check] [--openscreen <path>]
 *
 * The Studio links `optics.css` whole and gets the framework with it — `.btn`,
 * `.card`, `.form-group`, the page grid. That is the right trade for a plain-DOM
 * page written against Optics. It is the wrong one for the app, which is Tailwind
 * and shadcn: `.card`, `.badge`, `.alert`, `.avatar` and `.btn` are all names its
 * own components already use, so importing 178KB of framework there would be a
 * cascade fight rather than a brand.
 *
 * What the app needs is the part that carries no opinion about markup: the custom
 * properties. So this keeps every rule whose selector is `:root`-based and drops
 * all 182 class rules, which leaves the ramps, the seeds, the type scale, the
 * spacing grid and the radii — the values `src/styles/design-tokens.css` maps onto.
 *
 * Two reasons it is generated into the fork rather than imported from here:
 *
 *   - the fork has to build in CI with no toolkit checkout beside it, so the file
 *     has to be committed there;
 *   - `--check` then makes drift a failure instead of a surprise, the same way
 *     sync-tap and sync-docs do for the other two one-way copies.
 *
 * Do not hand-edit the output. Change the Optics export, run `pnpm run optics`,
 * then run this.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

/** The vendored sources, in cascade order: the package, then our scales. */
const SOURCES = ["brand/optics/optics.css", "brand/optics/rolemodel-scales.css"];

/** Where the fork wants it. */
const DEST = "src/styles/optics-tokens.css";

const argv = process.argv.slice(2);
const check = argv.includes("--check");
const osArg = argv.indexOf("--openscreen");
const OS_ROOT = resolve(osArg === -1 ? join(ROOT, "..", "openscreen") : argv[osArg + 1]);

/**
 * Split a stylesheet into top-level chunks.
 *
 * A brace counter rather than a CSS parser, and it can be one because of what it
 * is fed: two generated files with no nested rules outside `@media`, and comments
 * that are the only place a stray brace could hide. Comments and strings are
 * skipped explicitly for exactly that reason — `--op-encoded-images-dropdown-arrow`
 * is a base64 `url()` and a comment in the `:root` block contains the text
 * "@media or @container queries", which is enough to fool anything simpler.
 */
function chunks(css) {
	const out = [];
	let i = 0;
	let start = 0;
	let depth = 0;
	while (i < css.length) {
		const two = css.slice(i, i + 2);
		if (two === "/*") {
			const end = css.indexOf("*/", i + 2);
			i = end === -1 ? css.length : end + 2;
			continue;
		}
		const ch = css[i];
		if (ch === '"' || ch === "'") {
			i++;
			while (i < css.length && css[i] !== ch) i += css[i] === "\\" ? 2 : 1;
			i++;
			continue;
		}
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) {
				out.push(css.slice(start, i + 1));
				start = i + 1;
			}
		}
		i++;
	}
	if (css.slice(start).trim()) out.push(css.slice(start));
	return out;
}

/**
 * The selector or at-rule prelude of a chunk.
 *
 * Comments come off BEFORE the first brace is looked for, not after. The other way
 * round silently dropped the most important rule in the file: the comment above
 * Optics' `:root` block contains a brace, so `indexOf("{")` landed inside it, the
 * prelude was a truncated unterminated comment, the comment-stripping regex found
 * nothing to match, and the rule holding `--op-color-primary-h` and
 * `--op-color-neutral-h` did not look like `:root` and was thrown away. The extract
 * still had 1232 tokens and every ramp referenced seeds that were no longer there.
 */
const prelude = (chunk) => {
	const bare = chunk.replace(/\/\*[\s\S]*?\*\//g, "");
	const brace = bare.indexOf("{");
	return (brace === -1 ? bare : bare.slice(0, brace)).trim();
};

/** True for a rule that sets custom properties on the document root. */
const isRoot = (sel) => /^:root\b/.test(sel) || /^:root:not\(/.test(sel);

/** Does this rule declare any Optics custom property at all? */
const declaresTokens = (chunk) => /--op-[\w-]+\s*:/.test(chunk);

/**
 * Keep the token-bearing rules, and only the declarations inside them.
 *
 * Selector shape is not enough on its own. `rolemodel-scales.css` carries a
 * `:root:has(.op-page)` rule that sets `overflow` and nests a `body` rule — real
 * layout, in a `:root` selector, and the sort of thing that has no business in a
 * file the app imports for its palette. So a rule has to declare a token to be
 * kept, and any rule nested inside it is dropped.
 *
 * `@media` is kept only when everything inside it is a token-bearing `:root` rule,
 * which in practice is the one dark-mode block. `@keyframes` goes with the
 * component CSS: the only token referencing one is `--op-animation-flash`, nothing
 * in the app spends it, and an animation without the rules that play it is worse
 * than no animation.
 */
function tokenLayer(css) {
	const kept = [];
	for (const chunk of chunks(css)) {
		const sel = prelude(chunk);
		if (!sel) continue;
		if (isRoot(sel)) {
			const rule = withoutNested(chunk);
			if (declaresTokens(rule)) kept.push(rule.trim());
			continue;
		}
		if (/^@media\b/.test(sel)) {
			const body = chunk.slice(chunk.indexOf("{") + 1, chunk.lastIndexOf("}"));
			const inner = chunks(body).filter((r) => isRoot(prelude(r)) && declaresTokens(r));
			if (!inner.length) continue;
			kept.push(`${sel} {\n${inner.map((r) => withoutNested(r).trim()).join("\n")}\n}`);
		}
	}
	return kept;
}

/**
 * Strip rules nested inside a rule.
 *
 * Native CSS nesting, which Optics uses: `:root:has(.op-page) { overflow: unset;
 * body { overflow: unset } }`. Declarations survive, nested blocks do not.
 */
function withoutNested(chunk) {
	const open = chunk.indexOf("{");
	if (open === -1) return chunk;
	const head = chunk.slice(0, open + 1);
	const body = chunk.slice(open + 1, chunk.lastIndexOf("}"));
	let out = "";
	let i = 0;
	let keepFrom = 0;
	let depth = 0;
	while (i < body.length) {
		if (body.slice(i, i + 2) === "/*") {
			const end = body.indexOf("*/", i + 2);
			i = end === -1 ? body.length : end + 2;
			continue;
		}
		const ch = body[i];
		if (ch === '"' || ch === "'") {
			i++;
			while (i < body.length && body[i] !== ch) i += body[i] === "\\" ? 2 : 1;
			i++;
			continue;
		}
		if (ch === "{") {
			if (depth === 0) {
				// Back up over the nested rule's own selector, which is everything since
				// the last semicolon or closing brace.
				const cut = Math.max(body.lastIndexOf(";", i), body.lastIndexOf("}", i)) + 1;
				out += body.slice(keepFrom, cut);
			}
			depth++;
		} else if (ch === "}") {
			depth--;
			if (depth === 0) keepFrom = i + 1;
		}
		i++;
	}
	if (depth === 0) out += body.slice(keepFrom);
	return `${head}${out}}`;
}

const HEADER = `/* GENERATED by lib/optics-tokens.mjs in the rolemodel-openscreen toolkit.
 * DO NOT EDIT. Run \`pnpm run optics-tokens\` there; \`pnpm run check\` fails on drift.
 *
 * Optics' custom properties, and none of its framework. Every \`:root\` rule from
 * @rolemodel/optics plus the RoleModel sub-brand scales; all 182 class rules
 * dropped, because .btn / .card / .badge / .alert / .avatar are names this app's
 * own components use and importing them would be a cascade fight.
 *
 * Optics computes its ramps in CSS with light-dark(), so which half resolves is
 * decided by \`color-scheme\` on the element — see design-tokens.css, which pins it
 * and maps these onto the twenty-odd names this app's components actually read.
 */
`;

const build = async () => {
	const parts = [];
	for (const f of SOURCES) {
		const path = join(ROOT, f);
		if (!existsSync(path)) {
			console.error(`optics-tokens: ${f} is missing — run \`pnpm run optics\``);
			process.exit(1);
		}
		const css = await readFile(path, "utf8");
		const kept = tokenLayer(css);
		parts.push(`/* ── ${f} ─────────────────────────────────────── */\n${kept.join("\n\n")}`);
	}
	return `${HEADER}\n${parts.join("\n\n")}\n`;
};

const css = await build();
const dest = join(OS_ROOT, DEST);
const have = existsSync(dest) ? await readFile(dest, "utf8") : null;
const short = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);

if (have === css) {
	const decls = (css.match(/--op-[\w-]+\s*:/g) ?? []).length;
	console.log(`\n  ${DEST} matches brand/optics/ — ${decls} tokens, ${Math.round(css.length / 1024)}KB\n`);
	process.exit(0);
}

if (check) {
	console.error(`\n  ✗ ${DEST} is out of date`);
	console.error(`      have ${have === null ? "(missing)" : short(have)}   want ${short(css)}`);
	console.error("\n  run `pnpm run optics-tokens`\n");
	process.exit(1);
}

if (!existsSync(OS_ROOT)) {
	console.error(`optics-tokens: no OpenScreen checkout at ${OS_ROOT}`);
	console.error("  clone it beside this repo, or pass --openscreen <path>");
	process.exit(1);
}

await mkdir(dirname(dest), { recursive: true });
await writeFile(dest, css);
const decls = (css.match(/--op-[\w-]+\s*:/g) ?? []).length;
console.log(`\n  wrote ${DEST}  (${decls} tokens, ${Math.round(css.length / 1024)}KB)`);
console.log(`  in ${OS_ROOT}\n`);
