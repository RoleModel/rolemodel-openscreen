/*
 * Settings that outlive a shell.
 *
 * OpenFrame was configured by two environment variables, which works from a
 * terminal and is unreachable from the app: a GUI launched from Finder inherits
 * no shell environment, the Studio it hosts inherits that, and Review reported
 * "not configured" with no way to configure it. Configuration only a shell can
 * supply is configuration nobody can set.
 *
 * So the same arrangement narration already uses for a provider key: the
 * environment wins if it is set, otherwise a file, written 0600 because one of
 * these is a credential. That order matters — CI and a scripted `rm-share` keep
 * working from the environment, and the app gets somewhere to put it.
 *
 * The file is shared with `lib/narration.mjs`, and both read-modify-write rather
 * than overwrite, so storing a token does not drop a stored API key. Two
 * simultaneous writes could still lose one; nothing here writes concurrently, and
 * a settings file is not worth a lock.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The same file narration keeps its provider keys in. */
/**
 * Where this toolkit keeps state that has to outlive a run.
 *
 * Exported because it is not only the config any more: the Studio keeps unfinished
 * script drafts here too. That started as localStorage and was wrong on the second
 * launch — the app asks the OS for a free port each time, so the page's origin
 * changes and a browser store keyed to it is unreachable afterwards.
 */
export const STATE_DIR = join(homedir(), ".config", "rolemodel-openscreen");
const CONFIG_FILE = join(STATE_DIR, "config.json");

/** A token has to be long enough that a typo is not silently accepted. */
const MIN_TOKEN = 24;

const read = async () => {
	try {
		return JSON.parse(await readFile(CONFIG_FILE, "utf8"));
	} catch {
		return {};
	}
};

/**
 * Where OpenFrame is and what to authenticate with.
 *
 * `source` says which of the two answered, because "not configured" and
 * "configured in a shell you are not in" look identical from the app and need
 * different fixes.
 */
export async function openFrameSettings() {
	const stored = await read();
	const url = process.env.OPENFRAME_URL?.trim() || stored.openframeUrl?.trim() || null;
	const token = process.env.OPENFRAME_TOKEN?.trim() || stored.openframeToken?.trim() || null;
	return {
		url,
		token,
		source: {
			url: process.env.OPENFRAME_URL?.trim() ? "environment" : stored.openframeUrl ? "stored" : null,
			token: process.env.OPENFRAME_TOKEN?.trim() ? "environment" : stored.openframeToken ? "stored" : null,
		},
	};
}

/** What is wrong with a setting, or null. Reported before anything is stored. */
export function settingProblem({ url, token }) {
	if (url !== undefined) {
		if (!url) return "the OpenFrame url is required";
		let parsed;
		try {
			parsed = new URL(url);
		} catch {
			return `${url} is not a url — it needs a scheme, like http://localhost:3100`;
		}
		if (!/^https?:$/.test(parsed.protocol)) return "the url has to be http or https";
	}
	if (token !== undefined) {
		if (!token) return "the token is required";
		if (token.length < MIN_TOKEN) return `that token is ${token.length} characters; OpenFrame refuses anything under ${MIN_TOKEN}`;
	}
	return null;
}

/**
 * Store them for later runs.
 *
 * Returns the file so the UI can say where the credential went, which is the one
 * thing a person should be told before they hand over a token.
 */
export async function setOpenFrameSettings({ url, token }) {
	const problem = settingProblem({ url, token });
	if (problem) throw new Error(problem);
	await mkdir(dirname(CONFIG_FILE), { recursive: true });
	const next = { ...(await read()) };
	if (url !== undefined) next.openframeUrl = String(url).trim().replace(/\/+$/, "");
	if (token !== undefined) next.openframeToken = String(token).trim();
	await writeFile(CONFIG_FILE, `${JSON.stringify(next, null, "\t")}\n`, { mode: 0o600 });
	return CONFIG_FILE;
}

/**
 * The panel that was open when you left.
 *
 * Deliberately NOT localStorage, for the same reason the script drafts are not:
 * the app asks the OS for a free port on every launch, so the page's origin is a
 * new one each start and a browser store keyed to it is unreachable afterwards. A
 * reload inside one session would have looked fine, which is exactly how that bug
 * survives being tested.
 */
export async function lastView() {
	const stored = await read();
	return typeof stored.lastView === "string" ? stored.lastView : null;
}

export async function setLastView(view) {
	const stored = await read();
	await mkdir(dirname(CONFIG_FILE), { recursive: true });
	// 0600 and tabs, matching setOpenFrameSettings: this file also holds the
	// OpenFrame token, and `writeFile` applies a mode only when it CREATES the file.
	// A looser write here that happens to go first would leave the token in a
	// world-readable file, and the later write could not tighten it.
	await writeFile(CONFIG_FILE, `${JSON.stringify({ ...stored, lastView: view }, null, "\t")}\n`, { mode: 0o600 });
}

/**
 * Which coding agent runs the AI steps.
 *
 * Kept beside the other settings for the reason they are all here: the app takes
 * a new port each launch, so a browser store keyed to its origin is unreachable
 * next time. See lib/agents.mjs for what the choice means — and note that the Pi
 * path there has not been run, so changing this is a deliberate act by somebody
 * willing to check the result.
 */
export async function agentChoice() {
	const stored = await read();
	return typeof stored.agent === "string" ? stored.agent : null;
}

export async function setAgentChoice(id) {
	const stored = await read();
	await mkdir(dirname(CONFIG_FILE), { recursive: true });
	// 0600 and tabs, matching the writers beside it: this file also holds the
	// OpenFrame token, and writeFile applies a mode only when it CREATES the file.
	await writeFile(CONFIG_FILE, `${JSON.stringify({ ...stored, agent: id }, null, "\t")}\n`, { mode: 0o600 });
}

/**
 * The project you are working in.
 *
 * A project is the space, not a field on nine forms. Every panel that touches
 * footage, scripts, voice or scenes used to open with "which project?" — ten
 * selects over nine panels, all asking the same question, none of them able to
 * remember the answer. Choosing once at the top means a panel can be about the
 * work instead of about locating it.
 *
 * Kept here rather than in localStorage for the reason lastView is: the app asks
 * the OS for a free port on every launch, so the page's origin changes each start
 * and a browser store keyed to it is unreachable afterwards.
 *
 * `null` is a real answer, not a missing one — the shared shelf, for a script that
 * travels between projects rather than belonging to one.
 */
export async function currentProject() {
	const stored = await read();
	return typeof stored.currentProject === "string" ? stored.currentProject : null;
}

export async function setCurrentProject(id) {
	const stored = await read();
	await mkdir(dirname(CONFIG_FILE), { recursive: true });
	// 0600 and tabs, matching the writers beside it: this file also holds the
	// OpenFrame token, and writeFile applies a mode only when it CREATES the file.
	await writeFile(
		CONFIG_FILE,
		`${JSON.stringify({ ...stored, currentProject: id || null }, null, "\t")}\n`,
		{ mode: 0o600 },
	);
}

export { CONFIG_FILE };
