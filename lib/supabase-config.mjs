/*
 * Where the team's shared storyboards live.
 *
 * WHY THIS IS A FILE AND NOT A FORM
 *
 * The panel used to ask each person for a project URL, an anon key and a team
 * id before they could share anything. That is three pieces of deployment
 * configuration — identical for everyone on the team, wrong in a way nobody can
 * debug if mistyped, and asked once per machine forever. Somebody's first
 * experience of collaboration should not be pasting a JWT.
 *
 * These belong to the DEPLOYMENT, so they are set once, here, by whoever set up
 * the Supabase project. After that the panel asks for an email and nothing else.
 *
 * IS IT SAFE TO COMMIT THE KEY?
 *
 * Yes, and this is the one place it is worth being explicit about. Supabase's
 * anon key is designed to ship inside browsers; it identifies the project, not
 * the caller, and it grants nothing on its own. Every decision about who may
 * read a board is a row-level security policy in sql/storyboards.sql, enforced
 * by Postgres, which no key in this file can weaken.
 *
 * The service_role key is the exact opposite — it bypasses every policy. It must
 * never appear here, and `supabaseProblem` refuses one that does.
 *
 * OVERRIDES
 *
 * The environment wins, so a second Supabase project (a staging one, or a
 * client's own) is a shell variable rather than a patch:
 *
 *   RM_SUPABASE_URL, RM_SUPABASE_ANON_KEY, RM_SUPABASE_TEAM, RM_SUPABASE_TABLE
 */

/**
 * Filled in once, by whoever applied sql/storyboards.sql.
 *
 * Empty means sharing is off, and the panel says which file to edit rather than
 * offering four fields nobody can fill in from inside the app.
 */
export const DEPLOYMENT = {
	/** https://<ref>.supabase.co — Project Settings → API. */
	url: "",
	/** The anon PUBLIC key from the same page. Not service_role. */
	anonKey: "",
	/** The team that owns these boards — see the setup notes in sql/storyboards.sql. */
	teamId: "",
	table: "storyboards",
};

/** The deployment, with the environment allowed to override any part of it. */
export function deployment() {
	return {
		url: process.env.RM_SUPABASE_URL || DEPLOYMENT.url,
		key: process.env.RM_SUPABASE_ANON_KEY || DEPLOYMENT.anonKey,
		teamId: process.env.RM_SUPABASE_TEAM || DEPLOYMENT.teamId,
		table: process.env.RM_SUPABASE_TABLE || DEPLOYMENT.table || "storyboards",
	};
}

/**
 * Whether this build knows where to sync to at all.
 *
 * Separate from "is anybody signed in", because the two have different answers
 * and different fixes: one is a repo edit by whoever runs the Supabase project,
 * the other is an email from the person at the keyboard.
 */
export function deploymentProblem(cfg = deployment()) {
	if (!cfg.url || !cfg.key || !cfg.teamId) {
		return "sharing is not set up for this build yet — whoever runs the Supabase project fills in lib/supabase-config.mjs once, and then everyone else just signs in";
	}
	if (!/^https:\/\//.test(cfg.url)) return "the project URL in lib/supabase-config.mjs has to start with https://";
	// The one mistake with real consequences, named rather than allowed.
	if (/service_role/.test(cfg.key)) {
		return "lib/supabase-config.mjs holds a service_role key — it bypasses every access policy. Use the anon public key.";
	}
	return null;
}
