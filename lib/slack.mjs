/*
 * Posting a finished video to Slack.
 *
 * WHAT THIS IS FOR
 *
 * A render that nobody sees is not delivered. This uploads the MP4 itself
 * rather than a link, because a link is only as good as whatever is hosting it —
 * and the thing hosting it might be an OpenFrame instance this project never
 * adopts. A file in a channel plays inline, survives the tool that made it, and
 * needs nothing else to be running.
 *
 * WHY A BOT TOKEN AND NOT AN INCOMING WEBHOOK
 *
 * A webhook is one pasted URL and would have been the smaller thing to build.
 * It cannot upload files — it posts messages only — so it can deliver a link
 * and nothing else. The moment the requirement is "the video", the token is
 * forced. `xoxb-...`, with `files:write` for the upload and `chat:write` for
 * the message that carries it.
 *
 * WHY THREE CALLS
 *
 * `files.upload` was Slack's one-call endpoint and it is retired — it stopped
 * accepting new apps in 2025 and returns `method_deprecated` where it answers at
 * all. The replacement is deliberately three steps, and each one fails
 * differently, so they are not collapsed here:
 *
 *   1. files.getUploadURLExternal  — ask where to put N bytes, get a file id
 *   2. POST the bytes to that URL  — plain multipart, no Slack auth on this one
 *   3. files.completeUploadExternal — attach the id to a channel, with a comment
 *
 * Step 2 is the only one that carries the video, and it is the only one whose
 * timeout is measured in minutes rather than seconds.
 */

import { stat } from "node:fs/promises";
import { openAsBlob } from "node:fs";
import { basename } from "node:path";

/** A 33MB render over a hotel connection is normal and must not look like a hang. */
const UPLOAD_TIMEOUT_MS = 15 * 60 * 1000;
const CALL_TIMEOUT_MS = 30_000;

export class SlackError extends Error {
	constructor(message, { status, method } = {}) {
		super(message);
		this.name = "SlackError";
		this.status = status;
		this.method = method;
	}
}

/**
 * Slack's own error strings, said in words somebody can act on.
 *
 * `not_in_channel` in particular reads as a permissions problem with the token
 * and is not one: the app is installed and authorised, it has simply never been
 * invited to that room. Slack will not let a bot post somewhere it has not been
 * asked into, and no amount of re-issuing a token changes that.
 */
const EXPLAIN = {
	not_in_channel: "the app is not in that channel — invite it with `/invite @YourApp` in Slack, then try again",
	channel_not_found:
		"no conversation by that id — paste the channel name instead (#demos) and Studio will look the id up, or use Copy link on the conversation in Slack and take the id off the end (C, G or D…)",
	/*
	 * The three ways a conversation that is not a channel refuses.
	 *
	 * A group conversation or a DM is a perfectly good place to post a render and
	 * the API takes one, but each has a condition a channel does not: the app has
	 * to be in the group, a bot cannot open a DM with somebody who has not opened
	 * one with it, and both need their own scopes. Reported as themselves, these
	 * read as "upload failed" and send you looking at the file.
	 */
	method_not_supported_for_channel_type:
		"that conversation type does not accept an upload from a bot — a channel or a group conversation the app has been added to will work, a DM it was never invited into will not",
	not_in_conversation: "the app is not in that conversation — add it from the conversation's own members list, then try again",
	cannot_dm_bot: "that is a DM with another app, which cannot be posted into",
	invalid_auth: "Slack rejected the token — check it starts with `xoxb-` and has not been revoked",
	missing_scope:
		"the token is missing a scope — `files:write` to upload, `chat:write` to post, `channels:read` and `groups:read` to look a channel up by name, and `mpim:read`/`im:read` to find a group conversation or a DM by name",
	not_authed: "no token was sent",
	file_upload_size_error: "Slack refused the file size",
};

/** A client bound to one workspace token. */
export function slack({ token, fetchImpl = fetch } = {}) {
	if (!token) throw new SlackError("no Slack token — set one on the Storage page");
	const root = "https://slack.com/api";

	/*
	 * Slack answers 200 with `{ok: false}` far more often than it answers a real
	 * HTTP error, so the status code is close to meaningless on its own and the
	 * body is what has to be read.
	 */
	async function call(method, body, { timeout = CALL_TIMEOUT_MS } = {}) {
		const res = await fetchImpl(`${root}/${method}`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json; charset=utf-8",
			},
			body: JSON.stringify(body ?? {}),
			signal: AbortSignal.timeout(timeout),
		}).catch((err) => {
			throw new SlackError(`${method} failed: ${err.message}`, { method });
		});
		const json = await res.json().catch(() => null);
		if (!json) throw new SlackError(`${method} returned ${res.status}, not JSON`, { status: res.status, method });
		if (!json.ok) {
			const why = EXPLAIN[json.error] ?? json.error ?? "no reason given";
			throw new SlackError(`${method}: ${why}`, { status: res.status, method });
		}
		return json;
	}

	/**
	 * Upload one video and post it into a channel.
	 *
	 * `channel` is an ID (`C0123ABCD`), not a name. Slack's own docs use names in
	 * examples and then reject them here, which is a twenty-minute detour the
	 * error message above is written to prevent.
	 */
	async function postVideo({ file, channel, title, comment, onStep = () => {} }) {
		if (!channel) throw new SlackError("no channel — set a default on the Storage page, or pass one");
		const info = await stat(file).catch(() => null);
		if (!info?.isFile()) throw new SlackError(`no such file: ${file}`);
		const name = basename(file);

		onStep("asking Slack where to put it");
		/*
		 * Query params, not JSON. This is the one method in the flow that refuses a
		 * JSON body — it answers `invalid_arguments` and names no argument — so it
		 * is written out here rather than bending `call` into taking both shapes.
		 */
		const params = new URLSearchParams({ filename: name, length: String(info.size) });
		const ticketRes = await fetchImpl(`${root}/files.getUploadURLExternal?${params}`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
		}).catch((err) => {
			throw new SlackError(`files.getUploadURLExternal failed: ${err.message}`, { method: "files.getUploadURLExternal" });
		});
		const got = await ticketRes.json().catch(() => null);
		if (!got?.ok) {
			const why = EXPLAIN[got?.error] ?? got?.error ?? "no reason given";
			throw new SlackError(`files.getUploadURLExternal: ${why}`, { method: "files.getUploadURLExternal" });
		}

		onStep(`uploading ${name}`);
		/*
		 * openAsBlob streams the file rather than reading it into memory. A 33MB
		 * render is survivable as a Buffer; a 4K master is not, and this path
		 * should not have a size beyond which it starts failing mysteriously.
		 */
		const form = new FormData();
		form.append("file", await openAsBlob(file), name);
		const put = await fetchImpl(got.upload_url, {
			method: "POST",
			body: form,
			signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
		}).catch((err) => {
			throw new SlackError(`upload failed: ${err.message}`, { method: "upload" });
		});
		if (!put.ok) throw new SlackError(`upload returned ${put.status}`, { status: put.status, method: "upload" });

		onStep("posting it to the channel");
		const done = await call("files.completeUploadExternal", {
			files: [{ id: got.file_id, title: title || name }],
			channel_id: channel,
			...(comment ? { initial_comment: comment } : {}),
		});
		const posted = done.files?.[0] ?? null;
		return { id: got.file_id, name, bytes: info.size, permalink: posted?.permalink ?? null };
	}

	/**
	 * Turn "#demos" into the id the upload actually needs.
	 *
	 * Slack requires a channel_id on `files.completeUploadExternal`, and then
	 * hides that id: it is not in the channel header, it moves around in the
	 * details pane between versions, and the reliable way to find it by hand is
	 * to copy the channel link and read the last path segment. Asking somebody to
	 * do that is a bad trade when the API can answer it.
	 *
	 * Paginated deliberately. A workspace with a few hundred channels returns
	 * them in pages, and stopping at the first page would report "no channel by
	 * that name" for a channel that plainly exists.
	 *
	 * Needs `channels:read` (public) and `groups:read` (private) on the token.
	 * Without them Slack answers `missing_scope`, which `call` already explains.
	 */
	/*
	 * What Slack calls a channel is not what Slack shows you.
	 *
	 * The sidebar reads "CCC Days - AI Video Editing"; the API's `name` is
	 * `ccc-days-ai-video-editing`. Somebody typing what is in front of them was
	 * matched character-for-character against the slug and never hit, which is a
	 * lookup that only works if you already know the answer. Comparing both sides
	 * with the punctuation removed makes the displayed name, the slug, and the
	 * hyphen-or-underscore question all the same string.
	 */
	const loose = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

	async function findChannel(name) {
		const wanted = String(name ?? "").trim().replace(/^#/, "").toLowerCase();
		if (!wanted) throw new SlackError("no channel name to look up");
		const wantedLoose = loose(wanted);
		let cursor = "";
		/* Kept so the failure can say how much it looked at — see below. */
		const everything = [];
		for (let page = 0; page < 20; page += 1) {
			const params = new URLSearchParams({
				limit: "1000",
				exclude_archived: "true",
				/*
				 * Group DMs and DMs count too.
				 *
				 * A conversation that is not "a full-on channel" — a group DM, a
				 * DM — is still somewhere a file can be posted, and asking only
				 * for channels meant the lookup reported "no channel by that
				 * name" for a conversation the token could plainly see. `im` and
				 * `mpim` need `im:read` and `mpim:read`; without them Slack says
				 * `missing_scope`, which `call` already explains.
				 */
				types: "public_channel,private_channel,mpim,im",
				...(cursor ? { cursor } : {}),
			});
			const res = await fetchImpl(`${root}/conversations.list?${params}`, {
				method: "GET",
				headers: { authorization: `Bearer ${token}` },
				signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
			}).catch((err) => {
				throw new SlackError(`conversations.list failed: ${err.message}`, { method: "conversations.list" });
			});
			const json = await res.json().catch(() => null);
			if (!json?.ok) {
				const why = EXPLAIN[json?.error] ?? json?.error ?? "no reason given";
				throw new SlackError(`conversations.list: ${why}`, { method: "conversations.list" });
			}
			everything.push(...(json.channels ?? []));
			const channels = json.channels ?? [];
			/* Exact first, so an unambiguous name is never decided by the loose
			   compare; then the loose one, which is what a typed display name and
			   a slug have in common. */
			const hit = channels.find((c) => String(c.name ?? "").toLowerCase() === wanted)
				?? channels.find((c) => loose(c.name) === wantedLoose || loose(c.name_normalized) === wantedLoose);
			/* `member` travels with it: conversations.list returns every public
			   channel whether the bot is in it or not, so a name resolves happily
			   and the upload then fails with `channel_not_found`. The caller can
			   say so at the moment the channel is chosen instead. */
			if (hit) return { id: hit.id, name: hit.name, member: Boolean(hit.is_member) };
			cursor = json.response_metadata?.next_cursor ?? "";
			if (!cursor) break;
		}
		/*
		 * Not found is usually not a spelling mistake.
		 *
		 * conversations.list returns every PUBLIC channel whether the bot is in it
		 * or not, but a private channel only appears once the bot is a member — so
		 * a private channel is invisible until it is invited, and both its name and
		 * its id come back as "not found". Saying "check the spelling" sent
		 * somebody to re-read a name that was correct all along.
		 *
		 * So the counts go in the message. Seeing hundreds of channels and none of
		 * them private, while being in none, is the shape of exactly this problem.
		 * A DM has no name to match either; there the id is the only way in, and it
		 * is the tail of the conversation's Copy link.
		 */
		const seen = { total: 0, priv: 0, member: 0 };
		for (const c of everything) {
			seen.total += 1;
			if (c.is_private) seen.priv += 1;
			if (c.is_member) seen.member += 1;
		}
		throw new SlackError(
			`no conversation called #${wanted} among the ${seen.total} this app can see`
				+ (seen.priv === 0 && seen.member === 0
					? ". It is in none of them, and no private channel is visible at all — a private channel stays"
						+ " invisible until the app is invited, so if this one is private, invite the app in Slack and try again"
					: ". Check the spelling, and that the app has been invited to it")
				+ ". If it is a DM or a group conversation it has no name to look up: use Copy link on it in Slack"
				+ " and paste the id off the end (C, G or D…).",
		);
	}

	/**
	 * What this token is allowed to do, which is not the same as whether it works.
	 *
	 * Slack returns the granted scopes in a response header rather than a body, so
	 * nothing that only reads `json.ok` ever sees them. That matters because a
	 * token with `files:write` and `chat:write` and no read scope authenticates
	 * perfectly and then fails the upload with `channel_not_found` — a
	 * conversation the token cannot read is reported as one that does not exist.
	 * The message points at the channel; the problem is the token. Asking up
	 * front is the difference between "add channels:read" and an hour spent
	 * checking the channel id.
	 */
	const NEEDED = [
		{ scope: "files:write", why: "to upload a render" },
		{ scope: "chat:write", why: "to post the message it is attached to" },
	];
	/* One of these, depending on where you are posting. Slack has no single scope
	   that covers every conversation type, so this asks for the one that matches
	   rather than demanding all four. */
	const READ_SCOPES = [
		{ scope: "channels:read", why: "a public channel" },
		{ scope: "groups:read", why: "a private channel" },
		{ scope: "mpim:read", why: "a group conversation" },
		{ scope: "im:read", why: "a direct message" },
	];

	async function scopes() {
		const res = await fetchImpl(`${root}/auth.test`, {
			method: "GET",
			headers: { authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
		}).catch((err) => {
			throw new SlackError(`auth.test failed: ${err.message}`, { method: "auth.test" });
		});
		const json = await res.json().catch(() => null);
		if (!json?.ok) {
			const why = EXPLAIN[json?.error] ?? json?.error ?? "no reason given";
			throw new SlackError(`auth.test: ${why}`, { method: "auth.test" });
		}
		const granted = (res.headers.get("x-oauth-scopes") ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		const missing = NEEDED.filter((n) => !granted.includes(n.scope)).map((n) => n.scope);

		/*
		 * Asked, not inferred from the header.
		 *
		 * `x-oauth-scopes` under-reports: a token listing `channels:history,
		 * chat:write, commands, files:write` and no read scope at all still
		 * returned 331 conversations from conversations.list. Reading the header
		 * and concluding "this cannot read anything" produced a confident warning
		 * that was simply false. So the question is put to Slack: can it list, and
		 * is it in anything.
		 */
		let reach = null;
		try {
			const params = new URLSearchParams({ limit: "200", exclude_archived: "true", types: "public_channel,private_channel,mpim,im" });
			const list = await (await fetchImpl(`${root}/conversations.list?${params}`, {
				method: "GET",
				headers: { authorization: `Bearer ${token}` },
				signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
			})).json();
			if (list?.ok) reach = { sees: (list.channels ?? []).length, member: (list.channels ?? []).filter((c) => c.is_member).length };
			else reach = { error: EXPLAIN[list?.error] ?? list?.error ?? "no reason given" };
		} catch (err) {
			reach = { error: err.message };
		}

		/*
		 * Membership is the one that bites, and it is invisible.
		 *
		 * conversations.list returns every public channel whether the bot is in it
		 * or not, so a channel resolves by name, stores a valid id, and then fails
		 * the upload — because completeUploadExternal needs the bot to be IN the
		 * conversation. Slack reports that as `channel_not_found`, which reads as a
		 * wrong id and sends you back to check the one thing that was right.
		 */
		const problem = missing.length
			? `this token cannot ${NEEDED.filter((n) => missing.includes(n.scope)).map((n) => n.why).join(" or ")} — it is missing ${missing.join(" and ")}`
			: reach?.error
				? `this token cannot list conversations (${reach.error}), so a channel name cannot be looked up — set the id instead`
				: reach && reach.member === 0
					? `this bot is not in any conversation, so an upload will fail with \`channel_not_found\` however correct the id is`
						+ " — invite it in Slack (`/invite @" + (json.user ?? "your-bot") + "`) in the conversation you are posting to"
					: null;

		return { team: json.team ?? null, user: json.user ?? null, granted, missing, reach, problem };
	}

	/** Who this token is, so a settings form can say which workspace it reached. */
	async function whoami() {
		const who = await call("auth.test");
		return { team: who.team ?? null, user: who.user ?? null, url: who.url ?? null };
	}

	/**
	 * Whether an id is a conversation here at all.
	 *
	 * A well-formed id is not a real one, and nothing checked: a mis-copied id
	 * stored happily and surfaced hours later as `channel_not_found` on the
	 * upload, which reads as a problem with the file. Asking at the moment it is
	 * saved turns that into "that is not a conversation in this workspace".
	 *
	 * `null` means the question could not be put — no read scope, Slack down —
	 * which is not the same as "no", and must not block a save.
	 */
	async function conversation(id) {
		const res = await fetchImpl(`${root}/conversations.info?channel=${encodeURIComponent(id)}`, {
			method: "GET",
			headers: { authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
		}).catch(() => null);
		const json = await res?.json().catch(() => null);
		if (json?.ok) return { found: true, name: json.channel?.name ?? null, member: Boolean(json.channel?.is_member) };
		/* Not proof of absence: Slack answers `channel_not_found` for a private
		   conversation the token cannot see, so this means "not visible to us",
		   which a mistyped id and an uninvited app share. */
		if (json?.error === "channel_not_found") return { found: false };
		return null;
	}

	return { call, postVideo, findChannel, whoami, scopes, conversation };
}
