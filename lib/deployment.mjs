/*
 * What a release knows that the repo does not: where the team's database is.
 *
 * WHY A GENERATED FILE
 *
 * This repo is public and the database credential is not, so the credential
 * cannot be committed. It also cannot be asked of each person — the panel used
 * to ask for a URL and a key, and somebody's first experience of working with
 * colleagues should not be pasting a connection string. So the release workflow
 * writes lib/deployment.json into the tarball Homebrew installs, from the repo's
 * secrets, and every install of a release carries it.
 *
 * WHAT THAT MEANS
 *
 * Whoever can install a release can reach the tables. That is the deliberate
 * trade for a small team: one shared credential, no per-machine setup. The
 * credential is a role that may read and write three tables and nothing else —
 * see sql/studio.sql — and is rotated by re-running that file and re-cutting a
 * release.
 *
 * A checkout has no deployment.json (it is ignored), so a developer sets the
 * environment instead, or writes the file by hand. Sharing says so when neither
 * is done rather than failing somewhere deeper.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEPLOYMENT_FILE = join(HERE, "deployment.json");

let cached = null;
function fromFile() {
	if (cached) return cached;
	try {
		cached = existsSync(DEPLOYMENT_FILE) ? JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8")) : {};
	} catch {
		cached = { broken: true };
	}
	return cached;
}

/** The environment overrides the file, for one afternoon against another database. */
export function deployment() {
	const file = fromFile();
	return {
		databaseUrl: process.env.RM_DATABASE_URL || file.databaseUrl || null,
		/** The GitHub OAuth app people sign in through. Public by design — a client id names the app, and authorises nothing. */
		githubClientId: process.env.RM_GITHUB_CLIENT_ID || file.githubClientId || null,
		table: process.env.RM_STORYBOARDS_TABLE || file.table || "storyboards",
		broken: Boolean(file.broken),
	};
}

/**
 * What is wrong with the deployment, or null.
 *
 * Deployment problems are fixed by a release or an environment variable, so
 * they are worded for that. A missing sign-in is somebody else's fix and is
 * reported elsewhere; they never share a sentence.
 */
export function deploymentProblem(cfg = deployment()) {
	if (cfg.broken) return "lib/deployment.json is not valid JSON — this build is damaged; reinstall it";
	if (!cfg.databaseUrl) {
		return "this build carries no database — install a release, or set RM_DATABASE_URL to develop against one";
	}
	if (!/^postgres(ql)?:\/\//.test(cfg.databaseUrl)) return "RM_DATABASE_URL has to be a postgresql:// connection string";
	if (/neondb_owner|postgres:\/\/postgres[:@]/.test(cfg.databaseUrl)) {
		return "that is the OWNER's connection string — the Studio connects as the studio_app role from sql/studio.sql, which can reach three tables and nothing else";
	}
	if (!cfg.githubClientId) {
		return "this build names no GitHub app to sign in through — set RM_GITHUB_CLIENT_ID, or install a release that carries it";
	}
	return null;
}
