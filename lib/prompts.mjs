/*
 * The prompts a project keeps.
 *
 * WHY A PROJECT AND NOT A MACHINE
 *
 * A prompt is not a preference. "a sticker, bold outline, flat colour, on the
 * RoleModel blue" belongs to the sticker project and to nothing else, and the
 * next project wants its own. Kept beside the work, a prompt travels with the
 * project when it is copied, shared or opened on another machine — which is
 * exactly what a preference would not do.
 *
 * WHY ONE LIST AND NOT ONE PER FIELD
 *
 * A prompt written for a sticker is often the right start for a mood board
 * image, and splitting the list by the box it was typed into would hide it.
 * Each entry remembers `where` it came from so a picker can put the likely ones
 * first, but every prompt is offered everywhere.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const promptsFile = (projectDir) => join(projectDir, "prompts.json");

/** Everything this project has saved, newest first. Never throws. */
export async function listPrompts(projectDir) {
	try {
		const raw = JSON.parse(await readFile(promptsFile(projectDir), "utf8"));
		const all = Array.isArray(raw?.prompts) ? raw.prompts : [];
		return all.filter((p) => p?.id && p?.text).sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")));
	} catch {
		/* No file yet is the ordinary case, not a fault. */
		return [];
	}
}

const write = async (projectDir, prompts) => {
	await writeFile(promptsFile(projectDir), `${JSON.stringify({ prompts }, null, "\t")}\n`, "utf8");
	return prompts;
};

/** A name for a prompt that has none: enough of it to recognise. */
export function labelFor(text) {
	const one = String(text ?? "").replace(/\s+/g, " ").trim();
	return one.length > 48 ? `${one.slice(0, 47)}…` : one;
}

/**
 * Keep one.
 *
 * The same text saved twice is the same prompt: it moves to the top and takes
 * any new name rather than becoming a second copy. A list somebody has to weed
 * is a list they stop using.
 */
export async function savePrompt(projectDir, { text, label = "", where = "" }) {
	const body = String(text ?? "").trim();
	if (!body) throw new Error("there is nothing to save yet");
	const prompts = await listPrompts(projectDir);
	const same = prompts.find((p) => p.text.trim() === body);
	const at = new Date().toISOString();
	if (same) {
		same.at = at;
		if (label.trim()) same.label = label.trim();
		if (where) same.where = where;
		await write(projectDir, prompts);
		return same;
	}
	const made = { id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, text: body, label: label.trim() || labelFor(body), where, at };
	await write(projectDir, [made, ...prompts]);
	return made;
}

/** Drop one. Answers whether there was one to drop. */
export async function removePrompt(projectDir, id) {
	const prompts = await listPrompts(projectDir);
	const left = prompts.filter((p) => p.id !== id);
	if (left.length === prompts.length) return false;
	await write(projectDir, left);
	return true;
}

/**
 * The list a particular box should show.
 *
 * Its own first, then everything else, because the prompt you want is usually
 * one you wrote in this box before — but the one from next door is two lines
 * down rather than gone.
 */
export function forField(prompts, where) {
	if (!where) return prompts;
	return [...prompts.filter((p) => p.where === where), ...prompts.filter((p) => p.where !== where)];
}
