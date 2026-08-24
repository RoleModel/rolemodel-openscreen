/*
 * Hand a finished video to OpenFrame and get a review link back.
 *
 * The pipeline could make a video and never deliver it. Sending an mp4 by email
 * gets you feedback as prose — "around the middle, the bit with the railing" —
 * which is the most expensive possible way to receive a note. OpenFrame puts
 * comments on the timeline, so a note arrives attached to the frame it is about.
 *
 * The whole flow is six calls, discovered by reading the routes and then proved
 * against a live instance:
 *
 *   GET/POST /api/workspaces                                a project needs one
 *   GET/POST /api/projects                                   find or make it
 *   POST     /api/projects/:p/videos/r2-init                 presigned PUT
 *   PUT      <presignedPutUrl>                               the bytes
 *   POST     /api/projects/:p/videos                         register it
 *   POST     /api/projects/:p/videos/:v/share                the link
 *
 * Authentication is a token, which upstream does not have: everything there is
 * next-auth session cookies, right for a browser and unusable from a script. Our
 * fork adds `OPENFRAME_API_TOKENS`, mapping a token to a user so it acts as them
 * and gets no more access than they have. See RoleModel/OpenFrame.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";

/** Videos are large; a slow upload is normal and should not look like a hang. */
const UPLOAD_TIMEOUT_MS = 15 * 60 * 1000;
const CALL_TIMEOUT_MS = 30_000;

export class OpenFrameError extends Error {
	constructor(message, { status, url } = {}) {
		super(message);
		this.name = "OpenFrameError";
		this.status = status;
		this.url = url;
	}
}

/**
 * A client bound to one instance and one token.
 *
 * `base` and `token` are required rather than defaulted: a share link is
 * outward-facing, and guessing which instance to publish to is not a mistake
 * worth making silently.
 */
export function openFrame({ base, token, fetchImpl = fetch } = {}) {
	if (!base) throw new OpenFrameError("no OpenFrame url — set OPENFRAME_URL");
	if (!token) throw new OpenFrameError("no OpenFrame token — set OPENFRAME_TOKEN");
	const root = String(base).replace(/\/+$/, "");

	async function call(path, { method = "GET", body, timeout = CALL_TIMEOUT_MS } = {}) {
		const url = `${root}${path}`;
		const res = await fetchImpl(url, {
			method,
			headers: {
				authorization: `Bearer ${token}`,
				...(body ? { "content-type": "application/json" } : {}),
			},
			body: body ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(timeout),
		}).catch((err) => {
			throw new OpenFrameError(`${method} ${path} failed: ${err.message}`, { url });
		});

		const text = await res.text();
		let json = null;
		try {
			json = text ? JSON.parse(text) : null;
		} catch {
			// An HTML body from a 401 or a proxy is the usual cause, and quoting the
			// first line of it is more use than "unexpected token <".
			const first = text.split("\n").find((l) => l.trim()) ?? "";
			throw new OpenFrameError(`${method} ${path} returned ${res.status}, not JSON: ${first.slice(0, 120)}`, {
				status: res.status,
				url,
			});
		}
		if (!res.ok) {
			throw new OpenFrameError(`${method} ${path} -> ${res.status}: ${json?.error ?? "no reason given"}`, {
				status: res.status,
				url,
			});
		}
		// Every route wraps its payload in `data`; unwrap once here so callers do
		// not each have to remember.
		return json?.data ?? json;
	}

	/** The named workspace, or the first one, or a new one. */
	async function workspace(name) {
		const existing = await call("/api/workspaces");
		const list = Array.isArray(existing) ? existing : (existing?.workspaces ?? []);
		if (name) {
			const match = list.find((w) => w.name === name);
			if (match) return match;
		} else if (list.length) {
			return list[0];
		}
		return call("/api/workspaces", { method: "POST", body: { name: name ?? "RoleModel" } });
	}

	/** The named project in that workspace, or a new one. */
	async function project(name, workspaceId) {
		const page = await call(`/api/projects?workspaceId=${encodeURIComponent(workspaceId)}`);
		const match = (page?.projects ?? []).find((p) => p.name === name);
		if (match) return match;
		return call("/api/projects", { method: "POST", body: { name, workspaceId } });
	}

	/**
	 * Upload a file and register it as a video.
	 *
	 * The PUT goes to a presigned URL, so the bytes never pass through the app —
	 * which is why this can stream from disk rather than buffering a render into
	 * memory. `duplex: "half"` is required for a stream body in undici and is the
	 * kind of omission that fails only on large files.
	 */
	async function upload(projectId, file, title) {
		const info = await stat(file);
		const name = basename(file);
		const init = await call(`/api/projects/${projectId}/videos/r2-init`, {
			method: "POST",
			body: { fileName: name, contentType: "video/mp4", sizeBytes: info.size },
		});
		if (!init?.presignedPutUrl) throw new OpenFrameError("r2-init returned no presignedPutUrl");
		if (init.multipart) {
			// The instance wants a multipart upload for something this big, and doing
			// it wrong silently produces a truncated video. Say so instead.
			throw new OpenFrameError(
				`${name} is large enough that this instance wants a multipart upload, which rm-share does not do yet`,
			);
		}

		const put = await fetchImpl(init.presignedPutUrl, {
			method: "PUT",
			headers: { "content-type": init.contentType ?? "video/mp4", "content-length": String(info.size) },
			body: createReadStream(file),
			duplex: "half",
			signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
		});
		if (!put.ok) throw new OpenFrameError(`upload -> ${put.status}`, { status: put.status });

		return call(`/api/projects/${projectId}/videos`, {
			method: "POST",
			body: {
				title: title ?? name.replace(/\.[^.]+$/, ""),
				videoUrl: init.proxyUrl,
				objectKey: init.objectKey,
				uploadToken: init.uploadToken,
				providerId: "r2",
			},
		});
	}

	/** A link a client can open without an account. */
	async function share(projectId, videoId, { guests = true, comments = true } = {}) {
		const made = await call(`/api/projects/${projectId}/videos/${videoId}/share`, {
			method: "POST",
			body: { allowGuestComments: guests, permission: comments ? "COMMENT" : "VIEW" },
		});
		if (!made?.shareUrl) throw new OpenFrameError("share returned no shareUrl");
		return made;
	}

	/**
	 * The share link a video already has, or null when it has none.
	 *
	 * A GET, and that is the entire reason this exists next to `share`. OpenFrame's
	 * POST rotates the token on an existing link, so asking "what is the link for
	 * this video" with a POST silently invalidates whatever was already sent to a
	 * client. Nothing that only wants to read a link should use POST.
	 */
	async function shareLink(projectId, videoId) {
		const got = await call(`/api/projects/${projectId}/videos/${videoId}/share`).catch(() => null);
		return got?.shareUrl ?? null;
	}

	return { call, workspace, project, upload, share, shareLink, base: root };
}

/**
 * Everything, in order: file in, review link out.
 *
 * `onStep` is called before each call so a caller can narrate it. Uploads take
 * minutes and silence reads as a hang.
 */
export async function shareVideo({ base, token, file, project: projectName, title, workspace: workspaceName, onStep = () => {} }) {
	const api = openFrame({ base, token });

	onStep("workspace");
	const ws = await api.workspace(workspaceName);

	onStep(`project ${projectName}`);
	const proj = await api.project(projectName, ws.id);

	onStep(`uploading ${basename(file)}`);
	const video = await api.upload(proj.id, file, title);

	onStep("share link");
	const link = await api.share(proj.id, video.id);

	/*
	 * `shareUrl` and nothing else.
	 *
	 * There used to be a `watchUrl` here, composed as `${base}/watch/${id}`, and it
	 * did not work: /watch/<id> carries no token, so OpenFrame's watch API finds no
	 * share-session cookie and answers 403, which the page renders as "Video not
	 * found or access denied". It looked fine in testing because a signed-in project
	 * member passes checkProjectAccess and never needs the token — so the link works
	 * for whoever made it and for nobody else.
	 *
	 * The token only reaches the browser through ?shareToken=, which /watch strips
	 * into an httpOnly cookie on arrival. That makes the address bar actively
	 * misleading: the URL shown after the redirect is not the URL to send anyone.
	 * `shareUrl` is the one with the token, so it is the only one handed out.
	 */
	return {
		workspace: ws.name,
		project: proj.name,
		video: { id: video.id, title: video.title },
		shareUrl: link.shareUrl,
	};
}
