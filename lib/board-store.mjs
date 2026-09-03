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
 *   neon       one shared row per project. Complete, and off until this machine
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
import { sharingProblem, sharingSettings, setSharingSettings } from "./settings.mjs";
import { fetchBoard, probe, putBoard } from "./db.mjs";
import { beginDeviceFlow, pollDeviceFlow, whoami } from "./github-auth.mjs";

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
 * The team's database: the shared board.
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
 * The database credential the release carries (lib/deployment.mjs), and the
 * role it names, which can reach three tables and nothing else (sql/studio.sql).
 * Signing in is not access: it is attribution, so a rating says whose it is.
 *
 * WHY `ready` IS COMPUTED
 *
 * It used to be a hardcoded `false` guarding an unimplemented stub. Now the
 * adapter works, so the honest question is not "has somebody written this" but
 * "is this machine configured to reach a project" — a deployment and a sign-in.
 * `sharingProblem` answers it and says which piece is missing.
 */
/* The half-finished GitHub sign-in, if there is one. */
let pendingDevice = null;

export const TEAM_SYNC = {
	id: "neon",
	label: "Everyone on the team",
	/*
	 * Live in the sense that matters and not in the sense it might sound.
	 *
	 * `subscribe` polls rather than holding a socket. A live channel would be a
	 * dependency, a reconnect policy and a socket to keep alive in a desktop app
	 * that sleeps with the lid. Polling converges in seconds, survives sleep by
	 * construction, and is honest about what it is. The panel says "within a few
	 * seconds" rather than "live" for the same reason.
	 */
	pollMs: 8_000,

	async ready() {
		const cfg = await sharingSettings();
		return sharingProblem(cfg) === null;
	},

	/** Why it is not usable, or null. Shown verbatim; it names one thing to fix. */
	async problem() {
		return sharingProblem(await sharingSettings());
	},

	/*
	 * Sign in with GitHub, in two halves — the device flow.
	 *
	 * The first half asks GitHub for a code and hands the panel what to show: the
	 * code, and where to type it. The second half is asked every few seconds
	 * until GitHub says the person typed it. The device code that ties the two
	 * halves together is held in memory rather than written down — it is
	 * worthless in fifteen minutes, and a sign-in that survives a restart of the
	 * Studio is not worth a file that outlives the exchange.
	 */
	async beginSignIn() {
		const cfg = await sharingSettings();
		const early = sharingProblem({ ...cfg, session: { user: { login: "x" } } });
		if (early) throw new Error(early);
		const started = await beginDeviceFlow({ clientId: cfg.githubClientId });
		pendingDevice = { deviceCode: started.deviceCode, intervalMs: started.intervalMs, at: 0, expiresAt: started.expiresAt };
		return { userCode: started.userCode, verificationUri: started.verificationUri, expiresAt: started.expiresAt, intervalMs: started.intervalMs };
	},

	/**
	 * One poll, paced.
	 *
	 * GitHub asks not to be polled faster than the interval it named, and
	 * answers `slow_down` — and lengthens the interval — when it is. Calls that
	 * arrive early are answered "pending" from here without asking GitHub, so a
	 * panel that polls eagerly is still a polite client.
	 */
	async pollSignIn() {
		if (!pendingDevice) return { status: "none" };
		if (Date.parse(pendingDevice.expiresAt) < Date.now()) {
			pendingDevice = null;
			return { status: "expired" };
		}
		if (Date.now() - pendingDevice.at < pendingDevice.intervalMs) return { status: "pending" };
		pendingDevice.at = Date.now();
		const cfg = await sharingSettings();
		const r = await pollDeviceFlow({ clientId: cfg.githubClientId, deviceCode: pendingDevice.deviceCode });
		if (r.status === "slow") {
			pendingDevice.intervalMs += 5_000;
			return { status: "pending" };
		}
		if (r.status === "pending") return r;
		pendingDevice = null;
		if (r.status !== "ok") return r;
		const user = await whoami({ token: r.token });
		const session = { token: r.token, user, signedInAt: new Date().toISOString() };
		await setSharingSettings({ session });
		return { status: "ok", user };
	},

	/** Signing out clears the sign-in and leaves the deployment alone. */
	async signOut() {
		pendingDevice = null;
		await setSharingSettings({ session: null });
	},

	/** Who this machine's ratings are attributed to. */
	async whoami() {
		const cfg = await sharingSettings();
		return cfg.session?.user?.email ?? cfg.session?.user?.login ?? null;
	},

	/** The configuration, checked, plus who is writing. */
	async client() {
		const cfg = await sharingSettings();
		const problem = sharingProblem(cfg);
		if (problem) throw new Error(problem);
		return { cfg, databaseUrl: cfg.databaseUrl, by: cfg.session.user.login };
	},

	/**
	 * Check the setup by using it.
	 *
	 * The ways this is configured wrong — a rotated password, an unapplied
	 * schema, a role without its grant — look identical from inside the panel
	 * until the database is asked. `probe` asks, and db.mjs names each answer.
	 */
	async test() {
		const { cfg, databaseUrl } = await this.client();
		const r = await probe({ databaseUrl });
		return { ok: true, rows: r.rows, as: cfg.session?.user?.email ?? cfg.session?.user?.login ?? null };
	},

	async pull(board) {
		const { databaseUrl } = await this.client();
		return fetchBoard({ databaseUrl, projectId: board.projectId });
	},

	async push(board) {
		const { databaseUrl, by } = await this.client();
		return putBoard({ databaseUrl, projectId: board.projectId, board, by });
	},

	/**
	 * Poll for somebody else's changes.
	 *
	 * Compares a small stamp rather than deep-equalling two boards: a board is
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

export const SYNCS = { local: LOCAL_SYNC, neon: TEAM_SYNC };

/** A machine that chose "supabase" before the move chose the team. Same intent. */
const LEGACY_IDS = { supabase: "neon" };

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
	const name = String(id ?? "");
	const want = SYNCS[LEGACY_IDS[name] ?? name];
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
