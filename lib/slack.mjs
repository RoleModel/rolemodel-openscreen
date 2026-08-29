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
	channel_not_found: "no channel by that id — paste the channel name instead (#demos) and Studio will look the id up, or copy the channel link and use the C… on the end",
	invalid_auth: "Slack rejected the token — check it starts with `xoxb-` and has not been revoked",
	missing_scope: "the token is missing a scope — it needs `files:write` to upload, `chat:write` to post, and `channels:read` to look a channel up by name",
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
	async function findChannel(name) {
		const wanted = String(name ?? "").trim().replace(/^#/, "").toLowerCase();
		if (!wanted) throw new SlackError("no channel name to look up");
		let cursor = "";
		for (let page = 0; page < 20; page += 1) {
			const params = new URLSearchParams({
				limit: "1000",
				exclude_archived: "true",
				types: "public_channel,private_channel",
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
			const hit = (json.channels ?? []).find((c) => String(c.name ?? "").toLowerCase() === wanted);
			if (hit) return { id: hit.id, name: hit.name };
			cursor = json.response_metadata?.next_cursor ?? "";
			if (!cursor) break;
		}
		throw new SlackError(`no channel called #${wanted} that this app can see — check the spelling, and that the app has been invited to it`);
	}

	/** Who this token is, so a settings form can say which workspace it reached. */
	async function whoami() {
		const who = await call("auth.test");
		return { team: who.team ?? null, user: who.user ?? null, url: who.url ?? null };
	}

	return { call, postVideo, findChannel, whoami };
}
