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

import { deployment, deploymentProblem } from "./deployment.mjs";
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
 * The Slack workspace a finished video is posted to.
 *
 * Same shape as the OpenFrame pair above, and stored beside it: environment
 * first so a scripted run can override, then the file, and `source` says which
 * answered — "not configured" and "configured in a shell you are not in" look
 * identical from inside the app and need different fixes.
 *
 * `channel` is an ID, not a name. Slack's own examples use `#general` and then
 * reject it on upload, so the value is named for what it must contain.
 */
export async function slackSettings() {
	const stored = await read();
	const token = process.env.SLACK_TOKEN?.trim() || stored.slackToken?.trim() || null;
	const channel = process.env.SLACK_CHANNEL?.trim() || stored.slackChannel?.trim() || null;
	return {
		token,
		channel,
		source: {
			token: process.env.SLACK_TOKEN?.trim() ? "environment" : stored.slackToken ? "stored" : null,
			channel: process.env.SLACK_CHANNEL?.trim() ? "environment" : stored.slackChannel ? "stored" : null,
		},
	};
}

/**
 * The fal.ai key, from the environment or from what was stored.
 *
 * Same shape as the Slack token and for the same reason: a key belongs in one
 * place, and the environment wins so a machine can be configured without the UI.
 */
export async function falSettings() {
	const stored = await read();
	const key = process.env.FAL_KEY?.trim() || stored.falKey?.trim() || null;
	return { key, source: process.env.FAL_KEY?.trim() ? "environment" : stored.falKey ? "stored" : null };
}

/** What is wrong with a fal key, or null. */
export function falSettingProblem({ key }) {
	if (!key) return "the fal.ai key is required";
	/* fal keys are `<id>:<secret>`. A bare id is a plausible thing to paste and
	   fails later with an opaque 401, so the shape is checked before it is
	   stored rather than discovered on the first render. */
	if (!key.includes(":")) return "that does not look like a fal key — they are two parts joined by a colon (fal.ai → Keys)";
	if (key.length < 40) return `that key is ${key.length} characters; fal's are longer`;
	return null;
}

/** Store it for later runs. Write-only from the UI, like the Slack token. */
export async function setFalSettings({ key }) {
	const problem = falSettingProblem({ key });
	if (problem) throw new Error(problem);
	await mkdir(dirname(CONFIG_FILE), { recursive: true });
	const next = { ...(await read()) };
	next.falKey = String(key).trim();
	await writeFile(CONFIG_FILE, `${JSON.stringify(next, null, "\t")}\n`, { mode: 0o600 });
	return CONFIG_FILE;
}

/** What is wrong with a Slack setting, or null. Reported before anything is stored. */
export function slackSettingProblem({ token, channel }) {
	if (token !== undefined) {
		if (!token) return "the Slack token is required";
		/* A bot token, specifically. `xoxp` (user) and `xapp` (app-level) are both
		   plausible things to paste and neither can upload a file on the app's
		   behalf, so the shape is checked rather than discovered at post time. */
		if (!/^xoxb-/.test(token)) return "that is not a bot token — it needs to start with `xoxb-` (Slack app → OAuth & Permissions → Bot User OAuth Token)";
		if (token.length < MIN_TOKEN) return `that token is ${token.length} characters; Slack's are longer`;
	}
	if (channel !== undefined && channel) {
		if (channel.startsWith("#")) return "use the channel ID, not its name — in Slack, right-click the channel → View channel details, and copy the ID at the bottom";
		if (!/^[CGD][A-Z0-9]{6,}$/i.test(channel)) return "that does not look like a channel ID — they start with C (public), G (private) or D (direct)";
	}
	return null;
}

/** Store them for later runs. Write-only from the UI, like the OpenFrame token. */
export async function setSlackSettings({ token, channel }) {
	const problem = slackSettingProblem({ token, channel });
	if (problem) throw new Error(problem);
	await mkdir(dirname(CONFIG_FILE), { recursive: true });
	const next = { ...(await read()) };
	if (token !== undefined) next.slackToken = String(token).trim();
	if (channel !== undefined) next.slackChannel = String(channel).trim();
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

/** Whether the nav is pinned narrow. On disk, for the reason lastView is. */
export async function sidebarRail() {
	return Boolean((await read()).sidebarRail);
}

export async function setSidebarRail(on) {
	const stored = await read();
	await mkdir(dirname(CONFIG_FILE), { recursive: true });
	// 0600, same reason as setLastView below: the OpenFrame token lives in this
	// file and writeFile only applies a mode when it creates it.
	await writeFile(CONFIG_FILE, `${JSON.stringify({ ...stored, sidebarRail: Boolean(on) }, null, "\t")}\n`, { mode: 0o600 });
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
 * Where the docs are published.
 *
 * The Docusaurus site the fork builds and deploys to GitHub Pages, landing on
 * the page written for somebody using the pipeline rather than changing it.
 *
 * The path is the build's own: baseUrl is /openscreen/ because a project Pages
 * site is served from <org>.github.io/<repo>/, the docs plugin serves under
 * /docs/, and `trailingSlash: true` means the served form ends in a slash — so
 * anything shorter costs a redirect.
 *
 * This goes live when Pages is switched on for the fork and main is pushed;
 * until then it 404s, which is why it is a setting. `docsUrl` in
 * ~/.config/rolemodel-openscreen/config.json overrides it — point it back at
 * https://github.com/RoleModel/openscreen/tree/main/website/docs/rolemodel to
 * read the same pages as rendered markdown with no site at all.
 */
export const DEFAULT_DOCS_URL = "https://rolemodel.github.io/openscreen/docs/rolemodel/using-the-studio/";

export async function docsUrl() {
	const stored = await read();
	return typeof stored.docsUrl === "string" && stored.docsUrl ? stored.docsUrl : DEFAULT_DOCS_URL;
}

export async function setDocsUrl(url) {
	const stored = await read();
	await mkdir(dirname(CONFIG_FILE), { recursive: true });
	// 0600 and tabs, matching the writers beside it: this file also holds the
	// OpenFrame token, and writeFile applies a mode only when it CREATES the file.
	await writeFile(CONFIG_FILE, `${JSON.stringify({ ...stored, docsUrl: url }, null, "\t")}\n`, { mode: 0o600 });
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

/*
 * Public bases for storage remotes: { [remote]: { bucket, base } }.
 *
 * A presigned link is the best rclone can mint, and R2 caps one at a week — a
 * bucket somebody has made public has a stable URL rclone knows nothing about.
 * This is where the Studio remembers it, per remote, beside the rest of its
 * own notes rather than inside rclone's config, which belongs to rclone.
 */
export async function storagePublicBases() {
	const stored = await read();
	return stored.storagePublicBases && typeof stored.storagePublicBases === "object" ? stored.storagePublicBases : {};
}

export async function setStoragePublicBase(remote, { bucket, base } = {}) {
	const stored = await read();
	const all = { ...(stored.storagePublicBases && typeof stored.storagePublicBases === "object" ? stored.storagePublicBases : {}) };
	/* Both halves or neither: a base with no bucket cannot say which objects it
	   serves, and keeping half an answer would mint links that point nowhere. */
	if (remote && bucket && base) all[remote] = { bucket, base };
	else delete all[remote];
	await mkdir(dirname(CONFIG_FILE), { recursive: true });
	await writeFile(
		CONFIG_FILE,
		`${JSON.stringify({ ...stored, storagePublicBases: all }, null, "\t")}\n`,
		{ mode: 0o600 },
	);
}

/**
 * Who your ratings are signed by.
 *
 * A storyboard rating is an opinion with a name on it — "Hero" from the person
 * who briefed the video means something different from "Hero" from whoever
 * happened to open the panel, and a board that cannot tell them apart cannot be
 * used to settle anything.
 *
 * Falls back to the OS account name rather than to "anonymous". An unset name is
 * overwhelmingly a single-machine board where the account name is exactly right,
 * and a board full of "anonymous" is one nobody can read back. It is a fallback
 * and not an answer, though — see `whoAmI` on why sync must not ship until this
 * resolves to a person rather than a login.
 */
export async function reviewerName() {
	const stored = await read();
	const set = typeof stored.reviewer === "string" ? stored.reviewer.trim() : "";
	if (set) return set;
	try {
		const { userInfo } = await import("node:os");
		return userInfo().username || "someone";
	} catch {
		return "someone";
	}
}

/*
 * What each review version's comment count was the last time we looked, and the
 * notices raised when it changed.
 *
 * Kept on disk rather than in the page, for the reason the panel choice is: the
 * app asks the OS for a free port on every launch, so anything stored against
 * the page's origin is unreachable next start — and a notice that forgets itself
 * when you close the window is not a notice, it is a tooltip.
 *
 * `seen` is the baseline, not a log: one number per version, replaced each poll.
 * The notices are the log, and they are capped, because an unread pile from three
 * weeks ago is not information.
 */
const NOTICE_LIMIT = 50;

export async function reviewNotices() {
	const stored = await read();
	return {
		seen: stored.reviewSeen && typeof stored.reviewSeen === "object" ? stored.reviewSeen : {},
		notices: Array.isArray(stored.reviewNotices) ? stored.reviewNotices : [],
	};
}

export async function setReviewNotices({ seen, notices }) {
	const stored = await read();
	await mkdir(dirname(CONFIG_FILE), { recursive: true });
	await writeFile(
		CONFIG_FILE,
		`${JSON.stringify(
			{
				...stored,
				...(seen === undefined ? {} : { reviewSeen: seen }),
				...(notices === undefined ? {} : { reviewNotices: notices.slice(-NOTICE_LIMIT) }),
			},
			null,
			"\t",
		)}\n`,
		{ mode: 0o600 },
	);
}

export async function setReviewerName(name) {
	const stored = await read();
	await mkdir(dirname(CONFIG_FILE), { recursive: true });
	// 0600 and tabs, matching the writers beside it: this file also holds the
	// OpenFrame token, and writeFile applies a mode only when it CREATES the file.
	await writeFile(
		CONFIG_FILE,
		`${JSON.stringify({ ...stored, reviewer: String(name ?? "").trim() || null }, null, "\t")}\n`,
		{ mode: 0o600 },
	);
}

/**
 * Which sync adapter a storyboard uses. See lib/board-store.mjs.
 *
 * `syncFor` refuses an adapter that cannot run here, so storing "neon"
 * records an intent — it takes effect once this build has a deployment and
 * somebody has signed in.
 */
export async function syncChoice() {
	const stored = await read();
	return typeof stored.sync === "string" ? stored.sync : null;
}

export async function setSyncChoice(id) {
	const stored = await read();
	await mkdir(dirname(CONFIG_FILE), { recursive: true });
	await writeFile(CONFIG_FILE, `${JSON.stringify({ ...stored, sync: id || null }, null, "\t")}\n`, { mode: 0o600 });
}

/**
 * The sign-in that signs this machine's ratings.
 *
 * ONLY the sign-in. Where the data is — the database — is deployment
 * configuration and comes with the release (lib/deployment.mjs); nobody types
 * it. What is left to keep per machine is who is at the keyboard.
 *
 * Kept in the same 0600 file as the OpenFrame token because it holds a GitHub
 * token, which is a credential — a narrow one, good for reading the person's
 * own profile and email, but a credential.
 */
export async function sharingSettings() {
	const stored = await read();
	return { ...deployment(), session: stored.github?.session ?? null };
}

export async function setSharingSettings(patch) {
	const stored = await read();
	const now = stored.github ?? {};
	await mkdir(dirname(CONFIG_FILE), { recursive: true });
	await writeFile(
		CONFIG_FILE,
		`${JSON.stringify({ ...stored, github: { ...now, ...patch } }, null, "\t")}\n`,
		{ mode: 0o600 },
	);
}

/**
 * What is missing, in the order it has to be fixed — and by whom.
 *
 * Two audiences, so two kinds of answer. A missing deployment is a release or
 * an environment variable; a missing sign-in is the person at the keyboard. One
 * at a time, so each answer is checked as it arrives.
 */
export function sharingProblem(cfg) {
	const dep = deploymentProblem(cfg);
	if (dep) return dep;
	if (!cfg?.session?.user?.login) return "nobody is signed in on this machine yet";
	return null;
}

/**
 * The style template the collage generator appends to every subject.
 *
 * Per machine, in the same file as the other settings, because it is a working
 * preference: somebody trying a variation for an afternoon should not change it
 * for everyone. Null means "the default in lib/style-gen.mjs".
 */
export async function styleTemplate() {
	const stored = await read();
	return typeof stored.styleTemplate === "string" && stored.styleTemplate.trim() ? stored.styleTemplate : null;
}

export async function setStyleTemplate(template) {
	const stored = await read();
	await mkdir(dirname(CONFIG_FILE), { recursive: true });
	await writeFile(
		CONFIG_FILE,
		`${JSON.stringify({ ...stored, styleTemplate: String(template ?? "").trim() || null }, null, "\t")}\n`,
		{ mode: 0o600 },
	);
}

/**
 * The Framer project the Creator places looks into, and the CLI session that
 * reaches it. The session id is a credential-shaped thing: it stands in for
 * the person's Framer sign-in, so it lives in the 0600 file.
 */
export async function framerSettings() {
	const stored = await read();
	return { projectUrl: stored.framer?.projectUrl ?? null, sessionId: stored.framer?.sessionId ?? null };
}

export async function setFramerSettings(patch) {
	const stored = await read();
	await mkdir(dirname(CONFIG_FILE), { recursive: true });
	await writeFile(CONFIG_FILE, `${JSON.stringify({ ...stored, framer: { ...(stored.framer ?? {}), ...patch } }, null, "\t")}\n`, { mode: 0o600 });
}

export { CONFIG_FILE };
