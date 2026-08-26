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
 *   RM_SUPABASE_URL, RM_SUPABASE_ANON_KEY, RM_SUPABASE_TABLE
 */

/**
 * Filled in once, by whoever applied sql/storyboards.sql.
 *
 * Empty means sharing is off, and the panel says which file to edit rather than
 * offering four fields nobody can fill in from inside the app.
 */
export const DEPLOYMENT = {
	/** https://<ref>.supabase.co — Project Settings → API. */
	url: "https://gzjjmupafkhquhmjriax.supabase.co",
	/**
	 * The PUBLISHABLE key. Safe here, and safe to commit.
	 *
	 * Supabase designs this one to ship in browsers: it names the project and
	 * authorises nothing by itself. What decides who may read a board is the
	 * row-level security policy in sql/storyboards.sql, enforced by Postgres,
	 * which no key in this file can weaken.
	 *
	 * Its counterpart — `sb_secret_…`, formerly `service_role` — bypasses every
	 * one of those policies. `deploymentProblem` refuses both spellings of it.
	 */
	anonKey: "sb_publishable_pXeawNJPvhHb42ztqYmO8g_ycd2kPV0",
	table: "storyboards",
};

/** The deployment, with the environment allowed to override any part of it. */
export function deployment() {
	return {
		url: process.env.RM_SUPABASE_URL || DEPLOYMENT.url,
		key: process.env.RM_SUPABASE_ANON_KEY || DEPLOYMENT.anonKey,
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
	if (!cfg.url || !cfg.key) {
		return "sharing is not set up for this build yet — whoever runs the Supabase project fills in lib/supabase-config.mjs once, and then everyone else just signs in";
	}
	if (!/^https:\/\//.test(cfg.url)) return "the project URL in lib/supabase-config.mjs has to start with https://";
	/*
	 * The one mistake with real consequences, in BOTH key formats.
	 *
	 * Legacy keys are JWTs whose payload names the role, so `service_role` appears
	 * in the string. The current format does not: keys are `sb_publishable_…` and
	 * `sb_secret_…`, and a check for "service_role" waves the dangerous one
	 * straight through. Caught the only way it could be — by somebody pasting a
	 * secret key and the guard saying nothing.
	 */
	if (/service_role/.test(cfg.key) || /^sb_secret_/.test(cfg.key)) {
		return "that is a SECRET key — it bypasses every access policy in sql/storyboards.sql. Use the publishable key (sb_publishable_… or the legacy anon key), and rotate the secret one.";
	}
	return null;
}
