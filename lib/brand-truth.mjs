/*
 * Brand Truth: everything known about a brand, with a source and a reason.
 *
 * WHY A FOLDER OF MARKDOWN AND NOT A RECORD IN A DATABASE
 *
 * A brand is not a settings object. "The green is #00b871" is a value; "we use
 * the green only on the thing you are meant to press, because a page of green
 * has nothing to press" is a claim, and a claim has a source and a date and
 * eventually something that replaces it. Kept as markdown in the project folder
 * it can be read without this program, diffed, reviewed, and carried into a git
 * history that outlives any tool — which is the whole point of the Brand
 * Context Protocol this follows (craft.wild.as/bcp).
 *
 * WHY APPEND-ONLY
 *
 * The value of a brand source is that you can ask why. An entry that is edited
 * in place answers "what" and loses "why it changed" — and a brand's arguments
 * are mostly about changes. So nothing is ever edited: a correction is a new
 * entry that names the one it supersedes, and the old entry is marked and kept.
 * The folder is the argument, not just the answer.
 *
 * WHY REFUSALS ARE FIRST-CLASS
 *
 * "We never set the wordmark in anything but DM Sans" is worth more to anything
 * generating work than a page of things we like. A refusal is a claim with
 * teeth, so it is a kind rather than a convention, and it can be listed on its
 * own.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The sections, in the order the protocol names them.
 *
 * The numbers are part of the folder name so the order survives `ls`, a file
 * browser and a git diff — none of which would otherwise agree on it.
 */
export const TRUTH_SECTIONS = [
	{ dir: "00-source", label: "Source", blurb: "Where the brand came from: the founding story, who it is for, what it is against." },
	{ dir: "01-imprint", label: "Imprint", blurb: "The legal and factual record — names, entities, marks, what may be claimed." },
	{ dir: "02-voice", label: "Voice", blurb: "How it speaks. Words it uses, words it will not, the shape of a sentence." },
	{ dir: "03-design", label: "Design", blurb: "Colour, type, space, motion — the rules, not the tokens." },
	{ dir: "04-lenses", label: "Lenses", blurb: "How the brand changes for an audience, a market or a sub-brand." },
	{ dir: "05-architecture", label: "Architecture", blurb: "What is a product, what is a feature, what is named and what is not." },
	{ dir: "06-assets", label: "Assets", blurb: "The files that are the brand, and which one is right where." },
	{ dir: "07-runtime", label: "Runtime", blurb: "How the brand is applied by a machine: the presets, the models, the settings." },
	{ dir: "08-decisions", label: "Decisions", blurb: "Arguments that were settled, and by whom." },
	{ dir: "09-loops", label: "Loops", blurb: "What the work taught the brand — evidence going back into the source." },
];

export const TRUTH_KINDS = ["claim", "refusal"];

const truthDir = (projectDir) => join(projectDir, "brand");

const isSection = (dir) => TRUTH_SECTIONS.some((s) => s.dir === dir);

/** A filename that sorts by when it was written and says what it is about. */
export function entryName(claim, at = new Date()) {
	const slug =
		String(claim)
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 48) || "entry";
	return `${at.toISOString().slice(0, 10)}-${slug}-${at.getTime().toString(36).slice(-4)}.md`;
}

/*
 * Frontmatter by hand, and deliberately.
 *
 * A YAML library would let an entry carry structure, and structure is exactly
 * what this must not have: six flat fields a person can type, so the file is
 * writable in any editor by somebody who has never heard of this program.
 */
const esc = (v) => String(v ?? "").replace(/\r?\n/g, " ").trim();

export function renderEntry({ claim, kind = "claim", source = "", added, supersedes = "", supersededBy = "", body = "" }) {
	return [
		"---",
		`claim: ${esc(claim)}`,
		`kind: ${TRUTH_KINDS.includes(kind) ? kind : "claim"}`,
		`source: ${esc(source)}`,
		`added: ${added ?? new Date().toISOString()}`,
		`supersedes: ${esc(supersedes)}`,
		`superseded_by: ${esc(supersededBy)}`,
		"---",
		"",
		String(body ?? "").trim(),
		"",
	].join("\n");
}

export function parseEntry(text, file, section) {
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(text ?? ""));
	const head = {};
	if (m) {
		for (const line of m[1].split(/\r?\n/)) {
			const at = line.indexOf(":");
			if (at < 1) continue;
			head[line.slice(0, at).trim()] = line.slice(at + 1).trim();
		}
	}
	return {
		file,
		section,
		claim: head.claim ?? file,
		kind: TRUTH_KINDS.includes(head.kind) ? head.kind : "claim",
		source: head.source ?? "",
		added: head.added ?? "",
		supersedes: head.supersedes ?? "",
		supersededBy: head.superseded_by ?? "",
		body: (m ? m[2] : String(text ?? "")).trim(),
	};
}

/** Every entry in the project, newest first within each section. */
export async function readTruth(projectDir) {
	const root = truthDir(projectDir);
	const sections = [];
	for (const s of TRUTH_SECTIONS) {
		const dir = join(root, s.dir);
		const names = await readdir(dir).catch(() => []);
		const entries = [];
		for (const name of names.filter((n) => n.endsWith(".md")).sort().reverse()) {
			const text = await readFile(join(dir, name), "utf8").catch(() => null);
			if (text != null) entries.push(parseEntry(text, name, s.dir));
		}
		sections.push({ ...s, entries });
	}
	const all = sections.flatMap((s) => s.entries);
	return {
		sections,
		counts: {
			entries: all.length,
			current: all.filter((e) => !e.supersededBy).length,
			refusals: all.filter((e) => e.kind === "refusal" && !e.supersededBy).length,
		},
	};
}

/**
 * Add an entry. Optionally the one that replaces another.
 *
 * The supersede is two writes — the new file, then a mark on the old one — and
 * the mark is the only thing in this module that touches a file that already
 * exists. It adds a pointer forward; it never changes what the entry said.
 */
export async function addEntry(projectDir, { section, claim, kind = "claim", source = "", body = "", supersedes = "" }) {
	if (!isSection(section)) throw new Error(`no such section: ${section}`);
	if (!String(claim ?? "").trim()) throw new Error("an entry needs a claim — one line saying what is true");
	const dir = join(truthDir(projectDir), section);
	await mkdir(dir, { recursive: true });
	const at = new Date();
	const file = entryName(claim, at);
	await writeFile(join(dir, file), renderEntry({ claim, kind, source, added: at.toISOString(), supersedes, body }), "utf8");
	if (supersedes) {
		const old = join(dir, supersedes);
		const was = await readFile(old, "utf8").catch(() => null);
		if (was != null) {
			const parsed = parseEntry(was, supersedes, section);
			await writeFile(old, renderEntry({ ...parsed, supersededBy: file }), "utf8");
		}
	}
	return { file, section, added: at.toISOString() };
}

/**
 * The brand as one document, for anything that has to read it in one go.
 *
 * A skill asking "what is true about this brand" wants the current claims and
 * the refusals, in order, as prose — not ten directory listings. Superseded
 * entries are left out: they are history, and history is for the folder.
 */
export async function truthDigest(projectDir) {
	const { sections } = await readTruth(projectDir);
	const out = [];
	for (const s of sections) {
		const live = s.entries.filter((e) => !e.supersededBy);
		if (!live.length) continue;
		out.push(`## ${s.label}`, "");
		for (const e of live) {
			out.push(`- ${e.kind === "refusal" ? "**Never.** " : ""}${e.claim}${e.source ? ` _(${e.source})_` : ""}`);
			if (e.body) out.push(...e.body.split(/\r?\n/).map((l) => `  ${l}`));
		}
		out.push("");
	}
	return out.join("\n").trim();
}
