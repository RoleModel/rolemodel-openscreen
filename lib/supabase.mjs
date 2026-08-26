/*
 * Supabase, over fetch, with no dependency.
 *
 * WHY NOT @supabase/supabase-js
 *
 * This toolkit ships through Homebrew with two runtime dependencies, and the
 * official client brings a realtime stack, a storage client, a functions client
 * and their transitive tree for what this actually needs: two table calls and a
 * sign-in. Supabase is PostgREST with GoTrue in front of it, and both are plain
 * HTTP — so the whole surface used here is four requests.
 *
 * WHAT THIS IS NOT
 *
 * Not a general client. It knows about one table shape and one auth flow,
 * deliberately, because a general one would be a package and we just said why we
 * are not adding a package.
 *
 * THE ANON KEY IS PUBLIC AND THAT IS FINE
 *
 * Supabase's anon key is designed to ship in browsers; it identifies the project,
 * not the caller. It is NOT a secret and it is NOT authorisation — row-level
 * security is. Everything that decides who may read a board is in
 * sql/storyboards.sql, enforced by Postgres, and this file cannot weaken it.
 *
 * The service_role key is the opposite: it bypasses RLS entirely. It is never
 * read, never stored and never sent by this file, and if you find yourself
 * pasting one into the Studio, the answer is no.
 */

/** A Supabase error carries a message and often a hint; both are worth showing. */
class SupabaseError extends Error {
	constructor(message, { status, code, hint } = {}) {
		super(message);
		this.name = "SupabaseError";
		this.status = status;
		this.code = code;
		this.hint = hint;
	}
}

/**
 * Turn a failed response into a sentence somebody can act on.
 *
 * PostgREST reports RLS refusals as an empty result rather than a 403 — a policy
 * that excludes you and a row that does not exist are the same answer. That is
 * the single most confusing thing about this API, so where it can be detected it
 * is named rather than passed through.
 */
async function fail(res, what) {
	let body = null;
	try {
		body = await res.json();
	} catch {
		/* an HTML error page from a proxy, or nothing at all */
	}
	const detail = body?.message || body?.error_description || body?.error || body?.msg || res.statusText;
	/*
	 * "Invalid login credentials" is returned BOTH for a wrong password and for an
	 * account that does not exist — Supabase does this on purpose, so a stranger
	 * cannot discover who has an account here. Correct, and a dead end for the
	 * first person on a new project, who reads it as "my password is wrong" and
	 * tries again forever. Say both possibilities, since we cannot tell them apart.
	 */
	if (body?.error_code === "invalid_credentials") {
		throw new SupabaseError(
			"that email and password did not match — and if you have not created an account on this project yet, use Create account instead",
			{ status: res.status, code: "invalid_credentials" },
		);
	}
	if (res.status === 401) {
		throw new SupabaseError(`${what}: not signed in, or the session expired (${detail})`, { status: 401, hint: "sign in again" });
	}
	if (res.status === 403) {
		throw new SupabaseError(`${what}: the row-level security policy refused this (${detail})`, {
			status: 403,
			hint: "sign in — the publishable key alone reaches nothing",
		});
	}
	if (res.status === 404) {
		throw new SupabaseError(`${what}: no such table or endpoint (${detail}) — has sql/storyboards.sql been applied?`, { status: 404 });
	}
	throw new SupabaseError(`${what}: ${detail}`, { status: res.status, code: body?.code, hint: body?.hint });
}

/**
 * A timeout, because a hung sync must not hang the panel.
 *
 * Ten seconds: long enough for a cold Postgres connection on a free-tier project,
 * short enough that somebody clicking Sync learns it is not working before they
 * click it again.
 */
const TIMEOUT_MS = 10_000;

async function req(url, options, what) {
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
	let res;
	try {
		res = await fetch(url, { ...options, signal: ctl.signal });
	} catch (err) {
		if (err.name === "AbortError") throw new SupabaseError(`${what}: timed out after ${TIMEOUT_MS / 1000}s`, { status: 0 });
		// A wrong project URL fails here rather than at the HTTP layer, and "fetch
		// failed" on its own sends people to look at their policy instead of a typo.
		throw new SupabaseError(`${what}: could not reach ${new URL(url).origin} (${err.message})`, { status: 0 });
	} finally {
		clearTimeout(timer);
	}
	if (!res.ok) await fail(res, what);
	return res;
}

/**
 * Sign in with an email and password.
 *
 * Password grant rather than a magic link, because the Studio is a desktop app
 * with no inbox and no callback URL to catch a redirect on — a magic link would
 * mean running a local HTTP listener on a port that changes every launch, which
 * is the same trap that keeps settings off localStorage in this app.
 *
 * Returns the session. The refresh token matters: access tokens last an hour and
 * nobody is going to sign in again in the middle of rating takes.
 */
export async function signIn({ url, key, email, password }) {
	const res = await req(
		`${String(url).replace(/\/+$/, "")}/auth/v1/token?grant_type=password`,
		{
			method: "POST",
			headers: { apikey: key, "content-type": "application/json" },
			body: JSON.stringify({ email, password }),
		},
		"sign in",
	);
	const body = await res.json();
	return {
		accessToken: body.access_token,
		refreshToken: body.refresh_token,
		// Absolute, not a duration: a duration is only meaningful at the moment it
		// was issued, and this gets written to a file and read back much later.
		expiresAt: new Date(Date.now() + Number(body.expires_in ?? 3600) * 1000).toISOString(),
		user: { id: body.user?.id ?? null, email: body.user?.email ?? null },
	};
}

/**
 * Create an account.
 *
 * The Studio had sign-in and no sign-up, which meant the first person to try
 * sharing — always the person who set the project up — met "Invalid login
 * credentials" against an account that had never existed. That error is
 * indistinguishable from a typo'd password, so the one state everybody passes
 * through was the one with no way out.
 *
 * `session` is null when the project requires email confirmation. That is not a
 * failure and must not be reported as one: the account now exists and is waiting
 * on a link. The caller says so rather than showing an error, because the
 * difference between "did not work" and "check your email" is the whole message.
 */
export async function signUp({ url, key, email, password }) {
	const res = await req(
		`${String(url).replace(/\/+$/, "")}/auth/v1/signup`,
		{
			method: "POST",
			headers: { apikey: key, "content-type": "application/json" },
			body: JSON.stringify({ email, password }),
		},
		"create the account",
	);
	const body = await res.json();
	if (!body.access_token) {
		return { session: null, needsConfirmation: true, email: body.user?.email ?? email };
	}
	return {
		session: {
			accessToken: body.access_token,
			refreshToken: body.refresh_token,
			expiresAt: new Date(Date.now() + Number(body.expires_in ?? 3600) * 1000).toISOString(),
			user: { id: body.user?.id ?? null, email: body.user?.email ?? null },
		},
		needsConfirmation: false,
		email: body.user?.email ?? email,
	};
}

/** Trade a refresh token for a new session, so an hour-old sign-in keeps working. */
export async function refresh({ url, key, refreshToken }) {
	const res = await req(
		`${String(url).replace(/\/+$/, "")}/auth/v1/token?grant_type=refresh_token`,
		{
			method: "POST",
			headers: { apikey: key, "content-type": "application/json" },
			body: JSON.stringify({ refresh_token: refreshToken }),
		},
		"refresh the session",
	);
	const body = await res.json();
	return {
		accessToken: body.access_token,
		refreshToken: body.refresh_token,
		expiresAt: new Date(Date.now() + Number(body.expires_in ?? 3600) * 1000).toISOString(),
		user: { id: body.user?.id ?? null, email: body.user?.email ?? null },
	};
}

/**
 * A session that is still good, refreshing it if it is not.
 *
 * Refreshes a minute early. A token that expires between the check and the
 * request it authorises produces a 401 that looks like a policy problem, and
 * chasing an RLS policy that is actually fine is an afternoon.
 */
export async function liveSession({ url, key, session, onRefresh }) {
	if (!session?.accessToken) throw new SupabaseError("not signed in", { status: 401 });
	const soon = Date.now() + 60_000;
	if (session.expiresAt && Date.parse(session.expiresAt) > soon) return session;
	if (!session.refreshToken) throw new SupabaseError("the session expired and there is no refresh token — sign in again", { status: 401 });
	const next = await refresh({ url, key, refreshToken: session.refreshToken });
	await onRefresh?.(next);
	return next;
}

const headers = (key, token) => ({
	apikey: key,
	authorization: `Bearer ${token}`,
	"content-type": "application/json",
});

/**
 * Read one board.
 *
 * `null` for "no row", which is not an error: a project nobody has pushed yet is
 * the normal first state. It is also, unavoidably, what an RLS policy that
 * excludes you looks like — see the note on `fail` above. `probe` exists to tell
 * those two apart when it matters.
 */
export async function fetchBoard({ url, key, token, table, projectId }) {
	const base = String(url).replace(/\/+$/, "");
	const res = await req(
		`${base}/rest/v1/${encodeURIComponent(table)}?project_id=eq.${encodeURIComponent(projectId)}&select=*`,
		{ headers: headers(key, token) },
		"read the board",
	);
	const rows = await res.json();
	return rows?.[0]?.board ?? null;
}

/**
 * Write one board, as an upsert on the project id.
 *
 * `resolution=merge-duplicates` is what makes this an upsert rather than a
 * conflicting insert. The merge that matters is NOT this one — it is
 * `mergeBoards`, run client-side before we get here. Postgres is storing an
 * already-merged document; asking it to merge jsonb field by field would drop one
 * of two people rating different takes in the same second.
 */
export async function putBoard({ url, key, token, table, projectId, board }) {
	const base = String(url).replace(/\/+$/, "");
	await req(
		`${base}/rest/v1/${encodeURIComponent(table)}?on_conflict=project_id`,
		{
			method: "POST",
			headers: {
				...headers(key, token),
				Prefer: "resolution=merge-duplicates,return=minimal",
			},
			body: JSON.stringify([{ project_id: projectId, board, updated_at: new Date().toISOString() }]),
		},
		"write the board",
	);
	return board;
}

/**
 * Can this configuration actually talk to that project?
 *
 * Run before anything is trusted, because the three ways this is set up wrong —
 * a typo'd URL, an unapplied schema, a policy that excludes you — produce three
 * failures that look alike from inside the panel. This asks the questions in the
 * order that makes each answer distinguishable.
 */
export async function probe({ url, key, token, table }) {
	const base = String(url).replace(/\/+$/, "");
	// HEAD with a count: tells table-missing (404) apart from policy-excludes-you
	// (200 with a zero count), which a plain select cannot do.
	const res = await req(
		`${base}/rest/v1/${encodeURIComponent(table)}?select=project_id&limit=1`,
		{ headers: { ...headers(key, token), Prefer: "count=exact" }, method: "HEAD" },
		"check the table",
	);
	const range = res.headers.get("content-range") ?? "";
	const total = Number(range.split("/")[1]);
	return { ok: true, rows: Number.isFinite(total) ? total : null };
}

export { SupabaseError };
