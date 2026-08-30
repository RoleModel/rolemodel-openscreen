/*
 * Enforce BEM on the Studio's own CSS.
 *
 *   node lib/bem-check.mjs            report
 *   node lib/bem-check.mjs --check    report and exit non-zero on a new one
 *
 * WHY THIS EXISTS
 *
 * We use BEM, and nothing checked it — so the stylesheet grew a hundred and
 * forty bare names (`.nm`, `.path`, `.body`, `.thumb`, `.kind`) that read as
 * global blocks and are really elements of one. The cost is not tidiness: two
 * panels both wanting a "body" is how a rule written for one silently restyles
 * the other, and `.card .path` — styling an element through its parent — is the
 * shape that makes specificity fights inevitable.
 *
 * WHAT IT ENFORCES
 *
 * A class must be one of:
 *
 *   block                    declared in BLOCKS below
 *   block__element           an element of a declared block
 *   block--modifier          a variant of a declared block
 *   block__element--modifier
 *
 * Adding a new BLOCK is therefore deliberate: you name it here. Anything else
 * has to be namespaced to a block that already exists, which is the rule.
 *
 * WHY A LEDGER RATHER THAN A CLEAN SWEEP
 *
 * The classes in LEGACY predate this and are used across studio.css, studio.js,
 * studio.html and a large share of the assertions in verify.mjs, many of which
 * match on class names. Renaming them is a real refactor with a real chance of
 * silently unstyling something, and doing it in one pass at the end of a long
 * day is how that happens.
 *
 * So the ledger records exactly what is outstanding and the check fails on
 * anything NEW. The list only shrinks: delete a name as you convert it, and the
 * check makes sure it never comes back. `--check` also fails if a name in LEGACY
 * has already been removed from the CSS, so the ledger cannot rot into a list of
 * things that no longer exist.
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CSS = resolve(ROOT, "lib/studio.css");

/**
 * Not ours. Optics owns `op-`, and `hgi-` is the vendored icon font — both are
 * third-party naming we do not get to choose and must not rewrite.
 */
const FOREIGN = /^(op-|hgi-)/;

/**
 * The blocks this stylesheet defines. Adding one is a deliberate act; that is
 * the point of the list.
 */
const BLOCKS = new Set([
	"actionbar",
	"toast",
	"refshelf",
	/* The list of a project's voice tracks on Restyle: rows with a player,
	   not the picture tiles refshelf lays out. */
	"voiceshelf",
	/* A rendered waveform and its transport, for files with no thumbnail. */
	"wave",
	/* A card's name with its media kind beside it. */
	"cardname",
	/* The Sign in with Slack button and its mark. */
	"slackin",
	"clipcard",
	"working",
	"activity",
	"board",
	"board-scene",
	"brandmark",
	"breadcrumbs",
	"btn",
	"chip",
	"choose-grid",
	"container",
	"editor-frame",
	"editor-host",
	"multi-assembly",
	"media-name-dialog",
	"move-asset",
	"paper-edit",
	"panel-cards",
	"panel-stage",
	"proj",
	"projgrid",
	"rail-form",
	"saved-list",
	"scene-frame",
	"script-body",
	"script-form",
	"tall-frame",
	"card",
	"cardnew",
	"canvas-script",
	"choose-card",
	"colormenu",
	"dropzone",
	"firstrun",
	"form-group",
	"interview",
	"kebab",
	"navgroup",
	"panel-actions",
	"panel-card",
	"panel-config",
	"pickbar",
	"plan",
	"project-head",
	"project-capture-import",
	"projcard",
	"projmenu",
	"range-row",
	"runrow",
	"s3bar",
	"s3drop",
	"s3list",
	"s3row",
	"scriptcard",
	"shelfclip",
	"shelfstrip",
	"sidebar",
	"stop",
	"storage",
	"wpprev",
	"workflow",
	"workflow-nav",
	"hyperframes-workspace",
	"scene-footage-review",
	"usage-accounting",
	"usage-detail",
	"usage-head",
	"usage-model",
	"usage-models",
	"usage-overview",
	"usage-run",
	"usage-runs",
	"usage-stat",
	"voice",
	// A media tile's picture, which now carries a player and its close button.
	"thumbwrap",
	// The near-fullscreen dialog a project video is watched in.
	"player",
]);

/**
 * Known, outstanding, and only ever shorter.
 *
 * Each of these is an element or a state that should carry its block's name.
 * They are listed rather than fixed because they reach into three other files
 * and the assertions that guard them; converting one means moving all of its
 * uses together.
 */
const LEGACY = new Set([
	"always", "audio", "cmd", "cmd-note", "com", "con", "crumb", "crumb-sep", "css", "dot", "e", "eb", "ent", "form-row", "has-editor", "hl-bad", "html", "jl", "js", "kill", "libpick", "libpicklabel", "libselect", "log", "lt", "m", "mjs", "n", "navicon", "nm2", "off", "on", "org", "s", "still", "swatch", "t", "tag", "ti", "video", "w", "w3", "wide",
	"armed", "badge", "bad", "body", "client", "ctl", "del", "empty",
	"fills", "form", "form-control", "form-hint", "form-label", "full",
	"ghost", "grid", "hint", "hl-key", "hl-layer", "hl-val", "hl-wrap", "job", "joblist",
	"kind", "libbar", "lede", "meta", "nm", "note", "ok", "panel2", "path", "pick",
	"root", "row", "run", "runrow", "sec", "seg", "segbtn",
	"status", "thumb", "tools", "v", "warn",
	"wp", "wpgrid",
]);

const css = await readFile(CSS, "utf8");
const used = new Set(
	[...css.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)].map((m) => m[1]).filter((c) => !FOREIGN.test(c)),
);

/** `block`, `block__element`, `block--modifier`, `block__element--modifier`. */
function partsOf(cls) {
	const [beforeMod, ...restMod] = cls.split("--");
	if (restMod.length > 1) return null;
	const [block, ...restEl] = beforeMod.split("__");
	if (restEl.length > 1) return null;
	return { block, element: restEl[0] ?? null, modifier: restMod[0] ?? null };
}

const offenders = [];
for (const cls of [...used].sort()) {
	if (LEGACY.has(cls)) continue;
	const parts = partsOf(cls);
	if (!parts) {
		offenders.push({ cls, why: "more than one __ or -- part" });
		continue;
	}
	if (!BLOCKS.has(parts.block)) {
		offenders.push({
			cls,
			why: parts.element || parts.modifier ? `"${parts.block}" is not a declared block` : "not a declared block, and not namespaced to one",
		});
	}
}

/** A ledger entry for something no longer in the CSS is a ledger that has rotted. */
const stale = [...LEGACY].filter((cls) => !used.has(cls)).sort();

const check = process.argv.includes("--check");

if (!offenders.length && !stale.length) {
	console.log(`\n  BEM holds — ${used.size} classes, ${LEGACY.size} still on the ledger\n`);
	process.exit(0);
}

if (offenders.length) {
	console.error(`\n  ✗ ${offenders.length} class(es) are not BEM:`);
	for (const o of offenders) console.error(`      .${o.cls} — ${o.why}`);
	console.error(`\n  Name it for its block: .block__element, or .block--modifier.`);
	console.error(`  A genuinely new block goes in BLOCKS in ${"lib/bem-check.mjs"}.\n`);
}

if (stale.length) {
	console.error(`  ${stale.length} ledger entr(ies) are no longer in the CSS — delete them from LEGACY:`);
	for (const cls of stale) console.error(`      .${cls}`);
	console.error("");
}

process.exit(check ? 1 : 0);
