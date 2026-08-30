/**
 * fal.ai, for editing footage that already exists.
 *
 * Only models that take a video in and give a video back. fal's catalogue is
 * mostly generative — text or an image to new footage — and that is a different
 * job from the one this app does, which is to cut and finish material somebody
 * recorded.
 *
 * Every model here has had its input schema read from fal's own API page. The
 * parameter names are theirs, verbatim, and a model is not offered until its
 * contract is known: a guessed field name fails as an opaque 422 minutes into a
 * paid call.
 */
import { stat } from "node:fs/promises";
import { basename, extname } from "node:path";

const MB = 1024 * 1024;
const VIDEO = new Set([".mp4", ".mov"]);

/**
 * What each model takes.
 *
 * `limits` is what that model documents, not a house rule — Kling states 3-15s
 * and 200MB, Gemini states neither, and pretending otherwise would reject clips
 * fal would have accepted. Where a limit is unknown it is absent, and only the
 * format is enforced.
 */
export const MODELS = [
	{
		id: "fal-ai/kling-video/o3/pro/video-to-video/edit",
		label: "Kling O3 Edit [Pro]",
		hint: "Rewrites the scene from an instruction. Refer to the clip as @Video1 and to reference images as @Image1.",
		controls: ["prompt", "keepAudio", "images"],
		limits: { minSeconds: 3, maxSeconds: 15, maxBytes: 200 * MB, maxImages: 4 },
		input: ({ videoUrl, prompt, keepAudio = true, imageUrls = [] }) => ({
			prompt,
			video_url: videoUrl,
			keep_audio: keepAudio,
			shot_type: "customize",
			...(imageUrls.length ? { image_urls: imageUrls } : {}),
		}),
	},
	{
		id: "google/gemini-omni-flash/v1.1/edit",
		label: "Gemini Omni Flash 1.1 Edit",
		hint: "A plain instruction describing the change, keeping the rest of the scene.",
		controls: ["prompt", "resolution"],
		// fal documents no duration or size limit for this one, so none is claimed.
		limits: { resolutions: ["360p", "720p", "1080p", "4k"] },
		input: ({ videoUrl, prompt, resolution = "720p" }) => ({
			prompt,
			video_url: videoUrl,
			resolution,
		}),
	},
];

export const modelById = (id) => MODELS.find((m) => m.id === id) ?? null;
export const DEFAULT_MODEL = MODELS[0].id;

export class FalError extends Error {}

/*
 * fal's errors are a status and a body. These are the ones worth a sentence of
 * their own, because each has a different fix and the raw message names none.
 */
const EXPLAIN = new Map([
	[401, "fal rejected the key. Check it in Studio's Restyle panel, or set FAL_KEY."],
	[403, "that key cannot use this model — check the account has access to it."],
	[413, "fal refused the upload as too large."],
	[422, "fal rejected the inputs — usually the clip is outside what this model takes."],
	[429, "fal is rate limiting this key. Wait and run it again."],
]);

/** Say what is wrong with a clip for a given model, or null. */
export async function clipProblem(file, { seconds = null, model = DEFAULT_MODEL } = {}) {
	const spec = modelById(model);
	if (!spec) return `${model} is not a model this app knows`;
	const extension = extname(file).toLowerCase();
	if (!VIDEO.has(extension)) return `${basename(file)} is ${extension || "extensionless"}; these models take .mp4 or .mov`;
	const info = await stat(file).catch(() => null);
	if (!info?.isFile()) return `${basename(file)} is not a file`;

	const { minSeconds, maxSeconds, maxBytes } = spec.limits;
	if (maxBytes && info.size > maxBytes) {
		return `${basename(file)} is ${(info.size / MB).toFixed(0)}MB; ${spec.label} takes at most ${Math.round(maxBytes / MB)}MB`;
	}
	if (seconds !== null && minSeconds && seconds < minSeconds) {
		return `that clip is ${seconds.toFixed(1)}s; ${spec.label} needs at least ${minSeconds}s`;
	}
	if (seconds !== null && maxSeconds && seconds > maxSeconds) {
		return `that clip is ${seconds.toFixed(1)}s; ${spec.label} takes at most ${maxSeconds}s — trim it first`;
	}
	return null;
}

/**
 * A configured client.
 *
 * The import is dynamic so a Studio with no fal key still starts, and so a
 * missing package is one sentence rather than a stack at boot.
 */
export async function fal({ key }) {
	if (!key) throw new FalError("no fal key is configured");
	let client;
	try {
		({ fal: client } = await import("@fal-ai/client"));
	} catch (error) {
		throw new FalError(`the fal client is not installed (${error.message})`);
	}
	client.config({ credentials: key });

	const explain = (error) => {
		const status = error?.status ?? error?.response?.status;
		return new FalError(EXPLAIN.get(status) ?? `fal: ${error?.message ?? "the request failed"}`);
	};

	return {
		/** Put a local file where fal can read it, and hand back the URL. */
		async upload(path, bytes) {
			try {
				return await client.storage.upload(new File([bytes], basename(path), { type: "video/mp4" }));
			} catch (error) {
				throw explain(error);
			}
		},

		/**
		 * Run one model and wait for it.
		 *
		 * `onLog` receives fal's own progress, so a Console job shows what the
		 * model is doing rather than sitting silent for several minutes.
		 */
		async edit({ model = DEFAULT_MODEL, videoUrl, prompt, keepAudio = true, imageUrls = [], resolution }, { onLog } = {}) {
			const spec = modelById(model);
			if (!spec) throw new FalError(`${model} is not a model this app knows`);
			if (spec.controls.includes("prompt") && !prompt?.trim()) {
				throw new FalError("this model needs a prompt saying what to change");
			}
			if (spec.limits.maxImages && imageUrls.length > spec.limits.maxImages) {
				throw new FalError(`${spec.label} takes at most ${spec.limits.maxImages} reference images`);
			}
			try {
				const result = await client.subscribe(spec.id, {
					input: spec.input({ videoUrl, prompt: prompt?.trim(), keepAudio, imageUrls, resolution }),
					logs: Boolean(onLog),
					onQueueUpdate: (update) => {
						if (update.status === "IN_PROGRESS") for (const line of update.logs ?? []) onLog?.(line.message);
						else if (update.status) onLog?.(update.status.toLowerCase().replace(/_/g, " "));
					},
				});
				const url = result?.data?.video?.url ?? result?.video?.url;
				if (!url) throw new FalError("fal finished without returning a video");
				return { url, raw: result?.data ?? result };
			} catch (error) {
				throw error instanceof FalError ? error : explain(error);
			}
		},
	};
}
