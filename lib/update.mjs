/*
 * Is there a newer Studio than the one you are running?
 *
 * WHY THIS EXISTS AT ALL
 *
 * The toolkit ships through a Homebrew tap, which means an update is a command
 * somebody has to remember to type. Nobody does. The copy on this machine was
 * eleven months and ninety-three versions behind its own tap when this was
 * written, and every bug fixed in between was fixed for nobody.
 *
 * So the Studio asks GitHub what the newest release is, compares it to the
 * version it was built as, and — only if there is one — offers a button.
 *
 * WHAT IT WILL NOT DO
 *
 * It will not update by itself. Upgrading swaps the code out from under a
 * running server and every job that server started, so the moment is the user's
 * to choose. The button is the whole of the automation.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const REPO = "RoleModel/rolemodel-openscreen";
export const FORMULA = "rm-video";
export const TAP = "rolemodel/tap";

/** How long an answer from GitHub is trusted before asking again. */
export const MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Newer, older, or the same.
 *
 * Only the numbers are compared. A tag with anything else in it — a release
 * candidate, a build suffix — sorts by its numbers and then by nothing, which
 * is enough to answer the one question asked here.
 */
export function compareVersions(a, b) {
	const parts = (v) =>
		String(v ?? "")
			.replace(/^v/i, "")
			.split(/[.\-+]/)
			.map((n) => Number.parseInt(n, 10))
			.map((n) => (Number.isFinite(n) ? n : 0));
	const x = parts(a);
	const y = parts(b);
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		const d = (x[i] ?? 0) - (y[i] ?? 0);
		if (d) return d < 0 ? -1 : 1;
	}
	return 0;
}

/**
 * How this copy got here, which decides what "update" means.
 *
 * A checkout updates with git and a tap updates with brew, and telling somebody
 * to run the wrong one is worse than saying nothing: `brew upgrade` on a
 * checkout quietly updates a different copy of the app and leaves the one they
 * are looking at exactly as it was.
 */
export function installKind(root) {
	if (existsSync(join(root, ".git"))) return "git";
	if (/\/Cellar\/|\/homebrew\//.test(String(root))) return "brew";
	return "other";
}

/** The version this copy was built as. */
export async function currentVersion(root) {
	const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
	return String(pkg.version ?? "0.0.0");
}

/** What GitHub says the newest release is. */
export async function latestVersion({ fetchImpl = fetch } = {}) {
	/* The repo is public, so this needs no key — and must not be given one:
	   a token here would travel to GitHub on every idle Studio. */
	const res = await fetchImpl(`https://api.github.com/repos/${REPO}/releases/latest`, {
		headers: { Accept: "application/vnd.github+json", "User-Agent": "rolemodel-studio" },
		signal: AbortSignal.timeout(8000),
	});
	if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
	const json = await res.json();
	const tag = String(json.tag_name ?? "").replace(/^v/i, "");
	if (!tag) throw new Error("the newest release has no tag");
	return { version: tag, url: String(json.html_url ?? ""), notes: String(json.body ?? "").slice(0, 4000), at: String(json.published_at ?? "") };
}

/**
 * The whole answer, in the shape the button needs.
 *
 * Never throws: an update check is a courtesy, and a machine with no network
 * should show a Studio that works rather than an error about a version.
 */
export async function checkForUpdate({ root, fetchImpl = fetch } = {}) {
	const kind = installKind(root);
	const current = await currentVersion(root).catch(() => "0.0.0");
	try {
		const latest = await latestVersion({ fetchImpl });
		const behind = compareVersions(current, latest.version) < 0;
		return { current, latest: latest.version, behind, kind, url: latest.url, notes: latest.notes, at: latest.at, how: howToUpdate(kind), checkedAt: new Date().toISOString() };
	} catch (err) {
		return { current, latest: null, behind: false, kind, error: err.message, how: howToUpdate(kind), checkedAt: new Date().toISOString() };
	}
}

/** The command that would actually do it, for this kind of install. */
export function howToUpdate(kind) {
	if (kind === "brew") return { can: true, bin: "brew", args: ["upgrade", FORMULA], say: `brew upgrade ${FORMULA}` };
	if (kind === "git") return { can: false, say: "git pull", why: "This copy is a checkout, so it updates with git rather than brew." };
	return { can: false, say: `brew upgrade ${FORMULA}`, why: "This copy was not installed by brew or git, so it has to be updated by hand." };
}
