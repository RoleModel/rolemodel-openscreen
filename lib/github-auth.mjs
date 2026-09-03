/*
 * Sign in with GitHub, the way a desktop tool does: the device flow.
 *
 * WHY THIS FLOW
 *
 * The Studio is a local page on a port that changes every launch. The redirect
 * flow needs a callback URL GitHub has been told about, and a client secret to
 * finish the exchange — a secret that would have to ship in a public repo. The
 * device flow needs neither: the Studio shows a short code, the person types it
 * at github.com, and GitHub hands the token to whoever is polling with the
 * matching device code. No redirect, no secret, no port.
 *
 * WHAT A SIGN-IN IS FOR
 *
 * Attribution, not access. Access to the shared tables is the database
 * credential every release carries (see lib/deployment.mjs). Signing in says
 * whose rating this is — "someone on a Mac said Hero" is not attribution — and
 * asks for the narrowest scopes that answer that: who you are and your email.
 *
 * No dependency: it is four requests.
 */

class GitHubAuthError extends Error {
	constructor(message, { code } = {}) {
		super(message);
		this.name = "GitHubAuthError";
		this.code = code;
	}
}

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const API = "https://api.github.com";
const SCOPE = "read:user user:email";
const TIMEOUT_MS = 10_000;

async function post(url, params, what) {
	let res;
	try {
		res = await fetch(url, {
			method: "POST",
			headers: { accept: "application/json", "content-type": "application/json" },
			body: JSON.stringify(params),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (err) {
		throw new GitHubAuthError(`${what}: could not reach GitHub (${err.message})`);
	}
	const body = await res.json().catch(() => ({}));
	return { res, body };
}

/**
 * Ask GitHub for a code the person can type.
 *
 * Returns what the panel shows — the code and where to enter it — and what the
 * server keeps to finish: the device code and how often it may ask.
 */
export async function beginDeviceFlow({ clientId }) {
	const { res, body } = await post(DEVICE_CODE_URL, { client_id: clientId, scope: SCOPE }, "start signing in");
	if (!res.ok || !body.device_code) {
		// A 404 here is what a client id GitHub does not know looks like, and
		// what an OAuth app without "Device flow" ticked looks like too.
		const why = res.status === 404 ? "GitHub does not know that app, or its Device Flow is not enabled" : body.error_description || body.error || `HTTP ${res.status}`;
		throw new GitHubAuthError(`start signing in: ${why}`, { code: body.error });
	}
	return {
		deviceCode: body.device_code,
		userCode: body.user_code,
		verificationUri: body.verification_uri,
		expiresAt: new Date(Date.now() + Number(body.expires_in ?? 900) * 1000).toISOString(),
		intervalMs: Number(body.interval ?? 5) * 1000,
	};
}

/**
 * One poll. GitHub says "not yet" in three ways and "no" in two; each is named.
 *
 *   pending   keep asking, at the interval
 *   slow      keep asking, less often — the interval grew by five seconds
 *   ok        here is the token
 *   denied    the person clicked Cancel
 *   expired   the code aged out; start again
 */
export async function pollDeviceFlow({ clientId, deviceCode }) {
	const { body } = await post(
		TOKEN_URL,
		{ client_id: clientId, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" },
		"finish signing in",
	);
	if (body.access_token) return { status: "ok", token: body.access_token };
	switch (body.error) {
		case "authorization_pending":
			return { status: "pending" };
		case "slow_down":
			return { status: "slow" };
		case "access_denied":
			return { status: "denied" };
		case "expired_token":
			return { status: "expired" };
		default:
			throw new GitHubAuthError(`finish signing in: ${body.error_description || body.error || "GitHub answered without a token"}`, { code: body.error });
	}
}

/**
 * Who a token belongs to.
 *
 * The primary email is on a second endpoint and may be private on the profile,
 * which is why `user:email` is asked for. Falls back to the login alone: a
 * rating signed "dallasbpeters" is still attributed.
 */
export async function whoami({ token }) {
	const get = async (path) => {
		const res = await fetch(`${API}${path}`, {
			headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "rolemodel-studio" },
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		if (res.status === 401) throw new GitHubAuthError("GitHub no longer accepts this sign-in — sign in again", { code: "revoked" });
		if (!res.ok) throw new GitHubAuthError(`GitHub answered ${res.status} for ${path}`);
		return res.json();
	};
	const user = await get("/user");
	let email = user.email ?? null;
	try {
		const emails = await get("/user/emails");
		email = emails.find((e) => e.primary && e.verified)?.email ?? emails.find((e) => e.verified)?.email ?? email;
	} catch {
		/* the profile email, or none — the login still names the person */
	}
	return { id: String(user.id), login: user.login, name: user.name ?? null, email };
}

export { GitHubAuthError };
