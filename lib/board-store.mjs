/*
 * Where a storyboard lives, and how it reaches other people.
 *
 * WHY THIS IS SEPARATE FROM storyboard.mjs
 *
 * That file is arithmetic: what a take scores, which one wins, what the picks
 * compile to. This one is I/O: disk, network, clocks, and the merge that happens
 * when two copies of the same board have both moved. Keeping them apart is what
 * lets the arithmetic be checked without a project folder or a server, and it is
 * the reason `mergeBoards` lives over there rather than here — a file merge and a
 * hosted one must produce the same answer, so the answer cannot belong to either
 * transport.
 *
 * THE FILES
 *
 *   <project>/storyboard.json   the board, whole. Plain JSON, hand-editable,
 *                               readable in six months without this app.
 *   <project>/history.jsonl     every rating, pick and comment, appended, never
 *                               rewritten.
 *
 * Two files rather than one, because they answer different questions and fail
 * differently. `storyboard.json` is state — it is rewritten whole and the last
 * write wins. `history.jsonl` is what happened — append-only, so a bad merge, a
 * crash mid-write, or somebody's clock being wrong costs you the current state
 * and not the record of how it got there. When they disagree, the log is right;
 * that is the point of keeping it.
 *
 * SYNC IS A SEAM, WITH TWO ADAPTERS BEHIND IT
 *
 * The Studio is local-first and every project is a folder of ordinary files.
 * Ratings from other people are the first thing that genuinely cannot be.
 *
 *   local      the project folder. Complete, and the default.
 *   supabase   one shared row per project. Complete, and off until this machine
 *              has a project URL, an anon key, a team and a signed-in account.
 *
 * `ready` is therefore a QUESTION on the hosted adapter and a value on the local
 * one — whether sharing works is a fact about this machine's configuration, not
 * about whether somebody wrote the code. The selected adapter remains selected
 * when it is not ready, so Studio can name the missing setup step rather than
 * silently claiming a local save was a shared sync.
 *
 * What secures the shared board is the row-level security policy in
 * sql/storyboards.sql, enforced by Postgres. Nothing in this file can weaken it,
 * which is the reason it lives there. See docs/STORYBOARD.md.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";

import { BOARD_VERSION, emptyBoard, mergeBoards } from "./storyboard.mjs";
import { supabaseProblem, supabaseSettings, setSupabaseSettings } from "./settings.mjs";
import { exchangeAuthCode, fetchBoard, liveSession, oauthUrl, probe, putBoard, signIn as sbSignIn, signUp as sbSignUp } from "./supabase.mjs";

export const BOARD_FILE = "storyboard.json";
export const HISTORY_FILE = "history.jsonl";

/**
 * Read a project's board, or an empty one.
 *
 * A missing file is not an error: every project predates this feature, and one
 * that has never been storyboarded should open on an empty board rather than on
 * a failure. A CORRUPT file is different and is not silently replaced — see
 * below.
 */
export async function readBoard(dir, { projectId, title = "" } = {}) {
	const path = join(dir, BOARD_FILE);
	let raw;
	try {
		raw = await readFile(path, "utf8");
	} catch {
		return emptyBoard({ projectId, title });
	}
	try {
		const board = JSON.parse(raw);
		/*
		 * A board from a newer build is refused rather than read.
		 *
		 * Reading it would mean guessing at fields this version does not know, and
		 * the next write would drop them — so the person on the older build silently
		 * deletes everyone else's work by opening the panel.
		 */
		if (Number(board?.version) > BOARD_VERSION) {
			throw new Error(
				`this storyboard was written by a newer version of the Studio (board v${board.version}, this build reads v${BOARD_VERSION}) — update before opening it, or it will be saved back with the newer parts missing`,
			);
		}
		return { ...emptyBoard({ projectId, title }), ...board, projectId };
	} catch (err) {
		if (String(err.message).startsWith("this storyboard was written")) throw err;
		/*
		 * Unreadable JSON is reported, never overwritten.
		 *
		 * The tempting behaviour is to fall back to an empty board, and it is the
		 * wrong one: the next save would write that empty board over a file that
		 * still holds every rating anybody gave, and the only symptom would be a
		 * board that looks new.
		 */
		throw new Error(`${join(dir, BOARD_FILE)} is not readable as JSON (${err.message}) — it has NOT been overwritten`);
	}
}

/**
 * Write the board, atomically.
 *
 * Rename rather than write-in-place: a board is saved on every rating, so a
 * truncated file is a matter of when rather than whether, and the failure mode of
 * a half-written storyboard.json is losing every rating at once.
 */
export async function writeBoard(dir, board) {
	await mkdir(dir, { recursive: true });
	const path = join(dir, BOARD_FILE);
	const tmp = `${path}.tmp`;
	await writeFile(tmp, `${JSON.stringify({ ...board, version: BOARD_VERSION }, null, 2)}\n`, "utf8");
	await rename(tmp, path);
	return board;
}

/**
 * Append one thing that happened.
 *
 * Never throws into the caller's path. A rating that saved but failed to log is a
 * lost line in an audit trail; a rating that refused to save because the log was
 * unwritable is lost work in front of a person who just made a decision.
 */
export async function logEvent(dir, event) {
	try {
		await mkdir(dir, { recursive: true });
		await appendFile(join(dir, HISTORY_FILE), `${JSON.stringify(event)}\n`, "utf8");
	} catch {
		/* the board is the state; this is the record of it */
	}
}

/** Read the log back, skipping any line that got mangled rather than failing the read. */
export async function readHistory(dir, { limit = 500 } = {}) {
	let raw;
	try {
		raw = await readFile(join(dir, HISTORY_FILE), "utf8");
	} catch {
		return [];
	}
	const out = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line));
		} catch {
			/* one bad line must not cost the other thousand */
		}
	}
	return out.slice(-limit);
}

/**
 * Apply a change and persist it, in one place.
 *
 * Every mutation goes through here so that three things cannot drift apart: the
 * board on disk, the log beside it, and whatever the sync adapter believes. A
 * route that wrote the board itself would eventually forget one of the other two,
 * and the one it forgets is always the log.
 */
export async function applyToBoard(dir, board, event, mutate) {
	const next = mutate(structuredClone(board));
	await writeBoard(dir, next);
	await logEvent(dir, event);
	return next;
}

/* ────────────────────────── sync ────────────────────────── */

/**
 * What a sync adapter has to do.
 *
 * Deliberately four functions and no more. Anything richer — presence, live
 * cursors, per-field patches — is a property of one backend, and putting it in
 * the interface would mean the local adapter has to fake it.
 *
 *   pull(board)        fetch the remote copy, return it merged with this one
 *   push(board)        publish this copy
 *   subscribe(cb)      call cb(board) when somebody else changes it; returns an
 *                      unsubscribe function
 *   whoami()           who this machine's ratings are attributed to
 */

/** The local adapter: no remote, so pull is identity and push is a no-op. */
export const LOCAL_SYNC = {
	id: "local",
	label: "This machine only",
	detail: "Ratings and picks stay in the project folder. Nobody else sees them.",
	ready: true,
	async pull(board) {
		return board;
	},
	async push(board) {
		return board;
	},
	subscribe() {
		return () => {};
	},
};

/**
 * Supabase: the shared board.
 *
 * HOW IT WORKS
 *
 * One row per project in `storyboards`, with the whole board as jsonb. Pull the
 * remote copy, merge it with this one using `mergeBoards`, write the result
 * locally, push it back. `mergeBoards` and not a server-side jsonb merge —
 * because the merge has to be the same arithmetic everywhere, and two people
 * rating different takes in the same second must both survive a round trip.
 *
 * WHAT SECURES IT
 *
 * The RLS policies in sql/storyboards.sql, and nothing here. The anon key is
 * public by design and grants nothing; a board is readable only by a signed-in
 * member of the team that owns it. This file cannot weaken that, which is the
 * point of putting it in Postgres.
 *
 * WHY `ready` IS COMPUTED
 *
 * It used to be a hardcoded `false` guarding an unimplemented stub. Now the
 * adapter works, so the honest question is not "has somebody written this" but
 * "is this machine configured to reach a project" — a URL, an anon key, a team
 * and a session. `supabaseProblem` answers it and says which piece is missing.
 */
/* The half-finished provider sign-in, if there is one. */
let pendingOAuth = null;

export const SUPABASE_SYNC = {
	id: "supabase",
	label: "Everyone on the team",
	/*
	 * Live in the sense that matters and not in the sense it might sound.
	 *
	 * `subscribe` polls rather than holding a websocket. Supabase Realtime would
	 * be genuinely live, and it is a phoenix-channels client — a dependency, a
	 * reconnect policy and a socket to keep alive in a desktop app that sleeps
	 * with the lid. Polling converges in seconds, survives sleep by construction,
	 * and is honest about what it is. The panel says "within a few seconds"
	 * rather than "live" for the same reason.
	 */
	pollMs: 8_000,

	async ready() {
		const cfg = await supabaseSettings();
		return supabaseProblem(cfg) === null;
	},

	/** Why it is not usable, or null. Shown verbatim; it names one thing to fix. */
	async problem() {
		return supabaseProblem(await supabaseSettings());
	},

	/*
	 * Sign in with a provider, in two halves.
	 *
	 * The first half hands back a URL and keeps the secret that will redeem it;
	 * the second half is called when the browser comes back with a code. The
	 * secret is held in memory rather than written down — it is worthless a
	 * minute later, and a sign-in that survives a restart of the Studio is not
	 * worth a file that outlives the exchange.
	 */
	async beginOAuth({ provider, redirectTo }) {
		const cfg = await supabaseSettings();
		const early = supabaseProblem({ ...cfg, session: { refreshToken: "x" } });
		if (early) throw new Error(early);
		const { randomBytes, createHash } = await import("node:crypto");
		const verifier = randomBytes(32).toString("base64url");
		const codeChallenge = createHash("sha256").update(verifier).digest("base64url");
		pendingOAuth = { verifier, at: Date.now() };
		return { url: oauthUrl({ url: cfg.url, provider, redirectTo, codeChallenge }) };
	},

	async completeOAuth({ code }) {
		const cfg = await supabaseSettings();
		if (!pendingOAuth) throw new Error("that sign-in was not started here — try again from the Studio");
		/* Ten minutes, and the attempt is spent either way: a code that arrives
		   after a long detour is more likely a stale tab than a slow person. */
		const { verifier, at } = pendingOAuth;
		pendingOAuth = null;
		if (Date.now() - at > 10 * 60 * 1000) throw new Error("that sign-in took too long — start it again");
		const session = await exchangeAuthCode({ url: cfg.url, key: cfg.key, code, verifier });
		await setSupabaseSettings({ session });
		return session;
	},

	/** Sign in and remember the session, so this is a once-per-machine step. */
	async signIn({ email, password }) {
		const cfg = await supabaseSettings();
		// Deployment first: "sign in failed" is the wrong sentence when the real
		// answer is that this build has nowhere to sign in TO.
		const early = supabaseProblem({ ...cfg, session: { refreshToken: "x" } });
		if (early) throw new Error(early);
		const session = await sbSignIn({ url: cfg.url, key: cfg.key, email, password });
		await setSupabaseSettings({ session });
		return session;
	},

	/** Create an account on this project, and sign in with it when confirmation is off. */
	async signUp({ email, password }) {
		const cfg = await supabaseSettings();
		const early = supabaseProblem({ ...cfg, session: { refreshToken: "x" } });
		if (early) throw new Error(early);
		const r = await sbSignUp({ url: cfg.url, key: cfg.key, email, password });
		if (r.session) await setSupabaseSettings({ session: r.session });
		return r;
	},

	/** Signing out clears the session and leaves the project settings alone. */
	async signOut() {
		await setSupabaseSettings({ session: null });
	},

	/** Who this machine's ratings are attributed to, according to the server. */
	async whoami() {
		const cfg = await supabaseSettings();
		return cfg.session?.user?.email ?? null;
	},

	/**
	 * A valid access token, refreshed and re-saved if it had expired.
	 *
	 * Access tokens last an hour; nobody is signing in again in the middle of
	 * rating takes, and a 401 halfway through a sync reads as a policy problem.
	 */
	async token() {
		const cfg = await supabaseSettings();
		const problem = supabaseProblem(cfg);
		if (problem) throw new Error(problem);
		const session = await liveSession({
			url: cfg.url,
			key: cfg.key,
			session: cfg.session,
			onRefresh: (next) => setSupabaseSettings({ session: next }),
		});
		return { cfg, token: session.accessToken };
	},

	/**
	 * Check the setup by using it.
	 *
	 * The three ways this is configured wrong — a typo'd URL, an unapplied
	 * schema, a policy that excludes you — look identical from inside the panel,
	 * because PostgREST reports an RLS refusal as an empty result rather than a
	 * 403. `probe` asks in the order that keeps the answers distinguishable.
	 */
	async test() {
		const { cfg, token } = await this.token();
		const r = await probe({ url: cfg.url, key: cfg.key, token, table: cfg.table });
		return { ok: true, rows: r.rows, as: cfg.session?.user?.email ?? null };
	},

	async pull(board) {
		const { cfg, token } = await this.token();
		return fetchBoard({ url: cfg.url, key: cfg.key, token, table: cfg.table, projectId: board.projectId });
	},

	async push(board) {
		const { cfg, token } = await this.token();
		return putBoard({
			url: cfg.url,
			key: cfg.key,
			token,
			table: cfg.table,
			projectId: board.projectId,
			board,
		});
	},

	/**
	 * Poll for somebody else's changes.
	 *
	 * Compares `updatedAt` rather than deep-equalling two boards: a board is
	 * kilobytes of jsonb and this runs every eight seconds forever.
	 */
	subscribe(board, cb) {
		let stopped = false;
		let last = null;
		const tick = async () => {
			if (stopped) return;
			try {
				const remote = await this.pull(board);
				const stamp = JSON.stringify([remote?.ratings?.length, remote?.takes?.length, remote?.picks]);
				if (last !== null && stamp !== last) cb(remote);
				last = stamp;
			} catch {
				/* a failed poll is not an error worth interrupting anybody for */
			}
			if (!stopped) setTimeout(tick, this.pollMs);
		};
		setTimeout(tick, this.pollMs);
		return () => {
			stopped = true;
		};
	},
};

export const SYNCS = { local: LOCAL_SYNC, supabase: SUPABASE_SYNC };

/** The adapter used when nothing has chosen one. */
export const DEFAULT_SYNC = "local";

/**
 * Resolve a stored setting to an adapter, refusing to guess.
 *
 * An unknown id falls back to local. A known adapter stays selected even when it
 * is not ready: `syncBoard` then returns its concrete problem to the UI. Falling
 * back here makes a team think a shared board was saved when it only reached the
 * local project folder.
 */
export async function syncFor(id) {
	const want = SYNCS[String(id ?? "")];
	return want ?? SYNCS[DEFAULT_SYNC];
}

/**
 * Pull, merge, push — the whole of collaboration, in the order that keeps ratings.
 *
 * Pull first and merge before pushing, always. Pushing first would overwrite
 * whatever arrived since the last pull with a board that never saw it, which is
 * exactly how somebody's ratings disappear between two people looking at the same
 * screen.
 */
export async function syncBoard(dir, board, adapter = LOCAL_SYNC) {
	const ok = typeof adapter?.ready === "function" ? await adapter.ready() : adapter?.ready;
	if (!ok) {
		const why = typeof adapter?.problem === "function" ? await adapter.problem() : null;
		return { board, synced: false, reason: why ?? `${adapter?.label ?? "sync"} is not available` };
	}
	const remote = await adapter.pull(board).catch((err) => ({ __error: err }));
	if (remote?.__error) return { board, synced: false, reason: String(remote.__error.message) };
	const merged = mergeBoards(board, remote);
	await writeBoard(dir, merged);
	const pushed = await adapter.push(merged).catch((err) => ({ __error: err }));
	if (pushed?.__error) return { board: merged, synced: false, reason: String(pushed.__error.message) };
	return { board: merged, synced: true, reason: null };
}
