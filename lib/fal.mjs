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
	/*
	 * The Kling family: one contract across O1 and O3, different ceilings.
	 * O3 takes 15 seconds and 3840px, O1 takes 10.05 and 2160, and only O3
	 * has shot_type. Read from each model's own API page rather than assumed
	 * from its sibling — the O3 pair matched exactly and the O1 pair does not
	 * match O3, which is the reason each is listed separately.
	 */
	{
		id: "fal-ai/kling-video/o3/pro/video-to-video/edit",
		label: "Kling O3 Edit [Pro]",
		hint: "Rewrites the scene from an instruction. Refer to the clip as @Video1 and images as @Image1.",
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
		id: "fal-ai/kling-video/o3/standard/video-to-video/edit",
		label: "Kling O3 Edit [Standard]",
		hint: "The O3 edit at standard tier. Same inputs and the same 15s ceiling.",
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
		id: "fal-ai/kling-video/o1/video-to-video/edit",
		label: "Kling O1 Edit [Pro]",
		hint: "The earlier generation. Ten seconds rather than fifteen, and no shot type.",
		controls: ["prompt", "keepAudio", "images"],
		limits: { minSeconds: 3, maxSeconds: 10.05, maxBytes: 200 * MB, maxImages: 4 },
		input: ({ videoUrl, prompt, keepAudio = true, imageUrls = [] }) => ({
			prompt,
			video_url: videoUrl,
			keep_audio: keepAudio,
			...(imageUrls.length ? { image_urls: imageUrls } : {}),
		}),
	},
	{
		id: "fal-ai/kling-video/o1/standard/video-to-video/edit",
		label: "Kling O1 Edit [Standard]",
		hint: "The earlier generation at standard tier.",
		controls: ["prompt", "keepAudio", "images"],
		limits: { minSeconds: 3, maxSeconds: 10.05, maxBytes: 200 * MB, maxImages: 4 },
		input: ({ videoUrl, prompt, keepAudio = true, imageUrls = [] }) => ({
			prompt,
			video_url: videoUrl,
			keep_audio: keepAudio,
			...(imageUrls.length ? { image_urls: imageUrls } : {}),
		}),
	},
	{
		id: "google/gemini-omni-flash/v1.1/edit",
		label: "Gemini Omni Flash 1.1 Edit",
		hint: "A plain instruction describing the change, keeping the rest of the scene.",
		controls: ["prompt", "resolution"],
		// fal documents no duration or size limit for this one, so none is claimed.
		limits: { resolutions: ["360p", "720p", "1080p", "4k"], defaultResolution: "720p" },
		input: ({ videoUrl, prompt, resolution = "720p" }) => ({ prompt, video_url: videoUrl, resolution }),
	},
	{
		id: "fal-ai/wan/v2.7/edit-video",
		label: "Wan 2.7 Edit",
		hint: "Takes one reference image, not several, and a tighter 10s / 100MB ceiling.",
		controls: ["prompt", "keepAudio", "images", "resolution"],
		limits: { minSeconds: 2, maxSeconds: 10, maxBytes: 100 * MB, maxImages: 1, resolutions: ["720p", "1080p"], defaultResolution: "1080p" },
		/* `audio_setting` rather than a boolean: origin keeps the take's own
		   sound, auto lets the model decide. Keeping audio is the same intent. */
		input: ({ videoUrl, prompt, keepAudio = true, imageUrls = [], resolution = "1080p" }) => ({
			prompt,
			video_url: videoUrl,
			resolution,
			audio_setting: keepAudio ? "origin" : "auto",
			...(imageUrls[0] ? { reference_image_url: imageUrls[0] } : {}),
		}),
	},
	{
		id: "fal-ai/wan-vace-apps/video-edit",
		label: "Wan VACE Edit",
		hint: "Downsamples to fit rather than refusing, so it takes longer clips than the others.",
		controls: ["prompt", "images", "resolution"],
		limits: { maxImages: 4, resolutions: ["auto", "240p", "360p", "480p", "580p", "720p"], defaultResolution: "auto" },
		input: ({ videoUrl, prompt, imageUrls = [], resolution = "auto" }) => ({
			prompt,
			video_url: videoUrl,
			resolution,
			...(imageUrls.length ? { image_urls: imageUrls } : {}),
		}),
	},
	{
		id: "fal-ai/bernini-r/edit-video",
		label: "Bernini-R Edit",
		hint: "Diffusion edit. Slower and more literal than the Kling models.",
		controls: ["prompt"],
		limits: {},
		input: ({ videoUrl, prompt }) => ({ prompt, video_url: videoUrl }),
	},
	{
		id: "fal-ai/bernini-r/reference-edit-video",
		label: "Bernini-R Reference Edit",
		hint: "Needs at least one reference image — the look it edits towards.",
		controls: ["prompt", "images"],
		// reference_image_urls is required on this one, so the UI has to insist.
		requiresImages: true,
		limits: { maxImages: 5 },
		input: ({ videoUrl, prompt, imageUrls = [] }) => ({
			prompt,
			video_url: videoUrl,
			reference_image_urls: imageUrls,
		}),
	},
	{
		id: "alibaba/happy-horse/video-edit",
		label: "Happy Horse Edit",
		hint: "Takes up to a minute of footage, but returns at most 15 seconds of it.",
		controls: ["prompt", "keepAudio", "images", "resolution"],
		limits: { minSeconds: 3, maxSeconds: 60, maxBytes: 100 * MB, maxImages: 5, resolutions: ["720p", "1080p"], defaultResolution: "1080p" },
		input: ({ videoUrl, prompt, keepAudio = true, imageUrls = [], resolution = "1080p" }) => ({
			video_url: videoUrl,
			prompt,
			resolution,
			audio_setting: keepAudio ? "origin" : "auto",
			...(imageUrls.length ? { reference_image_urls: imageUrls } : {}),
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
export async function clipProblem(file, { seconds = null, model = DEFAULT_MODEL, ignoreSize = false } = {}) {
	const spec = modelById(model);
	if (!spec) return `${model} is not a model this app knows`;
	const extension = extname(file).toLowerCase();
	if (!VIDEO.has(extension)) return `${basename(file)} is ${extension || "extensionless"}; these models take .mp4 or .mov`;
	const info = await stat(file).catch(() => null);
	if (!info?.isFile()) return `${basename(file)} is not a file`;

	const { minSeconds, maxSeconds, maxBytes } = spec.limits;
	// A clip about to be trimmed is measured after the cut, not before: a 40s
	// original may be 300MB and its chosen 10 seconds comfortably under the cap.
	if (maxBytes && !ignoreSize && info.size > maxBytes) {
		return `${basename(file)} is ${(info.size / MB).toFixed(0)}MB; ${spec.label} takes at most ${Math.round(maxBytes / MB)}MB`;
	}
	/*
	 * An unmeasurable duration is a refusal, not a pass.
	 *
	 * `seconds` arrives as null when ffprobe could not read the file, and the
	 * checks below simply skipped — so a clip well over a model's ceiling went
	 * up, was uploaded in full, and was rejected by fal minutes later. A model
	 * that states a limit needs the number.
	 */
	if (seconds === null && (minSeconds || maxSeconds)) {
		return `${basename(file)} — could not read how long that clip is, and ${spec.label} only takes ${minSeconds ?? 0}-${maxSeconds}s`;
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
			/* reference_image_urls is required on some models, so an empty list is
			   a rejected request rather than an edit with no reference. */
			if (spec.requiresImages && !imageUrls.length) {
				throw new FalError(`${spec.label} needs at least one reference image`);
			}
			try {
				const result = await client.subscribe(spec.id, {
					input: spec.input({ videoUrl, prompt: prompt?.trim(), keepAudio, imageUrls, resolution: resolution || spec.limits.defaultResolution }),
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
