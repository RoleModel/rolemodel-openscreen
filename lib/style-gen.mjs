/*
 * The brand collage generator, as a module.
 *
 * WHERE THIS CAME FROM
 *
 * rolemodel-style-app: a static page on Vercel with four serverless functions,
 * a shared password, a fal key kept in the browser, and an image library in its
 * own Neon. Its job — brand-collage images from fal.ai models, an AI prompt
 * enhancer, mask inpainting, reference photos of real teammates — belongs in the
 * Studio, beside the projects those images end up in. This is the model-facing
 * half of that app, brought over as it was: the same endpoints, the same
 * request shapes (checked against fal's docs when the app was written), the
 * same style template and enhancer instructions.
 *
 * WHAT IT IS NOT
 *
 * Not storage and not UI. It talks to fal and hands back image URLs; the Studio
 * server decides where the picture lives and the panel decides how it looks.
 * Pure enough to test without a key: everything that builds a request is a
 * function of its arguments.
 */

/** The style, appended to every subject. Editable in the panel; this is the default. */
export const DEFAULT_STYLE =
	"Modern editorial collage illustration for a software craftsmanship studio — warm, human-centered, and quietly confident, never sterile or corporate. " +
	"Black-and-white photographic cutouts of real people collaborating: pairing at a laptop, mentoring side by side, sketching together, hands at work — combined with flat vector graphic shapes. " +
	"Flat rounded-rectangle color blocks and simple UI panels in a strict brand palette — use ONLY these exact colors: yellow #D4B30A, amber orange #E89B30, green #3A8F5C, purple #7B5EA7, blue #3A70B3. " +
	"Set on an off-white graph-paper background with a thin, light gray grid, like a craftsman's notebook. " +
	"The mood is disciplined craft and service: precise alignment, honest simple shapes, simple solutions to complex problems, people working alongside one another. " +
	"Clean bold sans-serif typography used sparingly, generous white space, crisp cutout edges, minimal and cohesive composition, " +
	"print-quality mixed-media collage; no gradients except subtle ones, no photorealistic color photography, no glossy stock-photo cliché.";

/** What the enhancer is told it is for. The style is added separately, so this asks for the scene only. */
export const ENHANCE_SYSTEM =
	"You improve short, loose ideas into rich prompts for an image generator at RoleModel Software, " +
	"a software craftsmanship studio whose core values are Character, Collaboration, and Craftsmanship. " +
	"The image style (editorial collage, B&W photo cutouts, flat color blocks on graph paper) is added separately, " +
	"so describe ONLY the scene: the subject, what they're doing, key objects, composition, and mood. " +
	"When it fits the idea, favor human moments of collaboration, mentorship, and craft — people pairing, " +
	"coming alongside one another, building with care — over solitary or sterile corporate imagery. " +
	"Be concrete and visual. 2-3 sentences, under 80 words. " +
	"Reply with the improved description only — no preamble, no quotes, no options.";

/** The five brand colours the template names, for the cutout backgrounds. */
export const BRAND_PALETTE = [
	{ name: "Yellow", hex: "#D4B30A" },
	{ name: "Amber", hex: "#E89B30" },
	{ name: "Green", hex: "#3A8F5C" },
	{ name: "Purple", hex: "#7B5EA7" },
	{ name: "Blue", hex: "#3A70B3" },
];

/** The cutout endpoint; a picture from it has a transparent background. */
export const REMOVE_BG = "fal-ai/bria/background/remove";

/**
 * Take the background off one picture.
 *
 * Bria returns a PNG with alpha at the source size. fal fetches the picture
 * itself, so the URL has to be one fal can reach — the CDN copy is, a file on
 * this machine is not.
 */
export async function removeBackground({ key, imageUrl, fetchImpl = fetch }) {
	const data = await callFal(REMOVE_BG, { image_url: imageUrl }, key, { fetchImpl });
	const url = data.image?.url;
	if (!url) throw new Error("the model returned no image — try again");
	return { url, endpoint: REMOVE_BG };
}

/** aspect ("1:1") → the FLUX/GPT-style image_size preset. */
export const SIZE_PRESET = {
	"1:1": "square_hd",
	"4:3": "landscape_4_3",
	"16:9": "landscape_16_9",
	"3:4": "portrait_4_3",
	"9:16": "portrait_16_9",
};

/**
 * The models, each with its own request shape.
 *
 * `edit` is the image-to-image variant that takes reference photos; a model
 * without one cannot put a real person in the picture and says so.
 */
export const MODELS = {
	"fal-ai/nano-banana-pro": {
		label: "Nano Banana Pro",
		maker: "Google",
		short: "Banana Pro",
		tone: "green",
		edit: "fal-ai/nano-banana-pro/edit",
		build: (prompt, aspect, count) => [{ prompt, aspect_ratio: aspect, num_images: count, output_format: "png", resolution: "1K" }],
	},
	"fal-ai/nano-banana": {
		label: "Nano Banana",
		maker: "Google · fast",
		short: "Banana",
		tone: "yellow",
		edit: "fal-ai/nano-banana/edit",
		build: (prompt, aspect, count) => [{ prompt, aspect_ratio: aspect, num_images: count, output_format: "png" }],
	},
	"fal-ai/flux-2-flex": {
		label: "FLUX 2 Flex",
		maker: "Black Forest Labs",
		short: "FLUX 2",
		tone: "purple",
		// No num_images parameter: the request is repeated instead.
		build: (prompt, aspect, count) => Array.from({ length: count }, () => ({ prompt, image_size: SIZE_PRESET[aspect] || "square_hd", output_format: "png" })),
	},
	"openai/gpt-image-2": {
		label: "GPT Image 2",
		maker: "OpenAI · pricier",
		short: "GPT Image 2",
		tone: "blue",
		build: (prompt, aspect, count) => [{ prompt, image_size: SIZE_PRESET[aspect] || "square_hd", num_images: count, output_format: "png" }],
	},
};

/** The badge for a model id, including the two refine endpoints. */
export function modelInfo(model) {
	if (MODELS[model]) return { label: MODELS[model].short, tone: MODELS[model].tone };
	if (model === "fal-ai/nano-banana-pro/edit") return { label: "Refined", tone: "orange" };
	if (model === "fal-ai/flux-pro/v1/fill") return { label: "Inpainted", tone: "orange" };
	if (model === REMOVE_BG) return { label: "Cutout", tone: "neutral" };
	if (model === "composite") return { label: "On colour", tone: "neutral" };
	return { label: String(model ?? "").split("/").pop() || "image", tone: "neutral" };
}

/** The panel's list: id, label, maker, and whether it can take reference photos. */
export function modelList() {
	return Object.entries(MODELS).map(([id, m]) => ({ id, label: m.label, maker: m.maker, short: m.short, tone: m.tone, people: Boolean(m.edit) }));
}

const TIMEOUT_MS = 180_000;

/**
 * One call to fal, with the failure turned into a sentence.
 *
 * fal answers a bad key with 401 or 403 and everything else with a `detail`
 * that is sometimes a string and sometimes an object; both are flattened.
 */
export async function callFal(endpoint, body, key, { fetchImpl = fetch } = {}) {
	const res = await fetchImpl(`https://fal.run/${endpoint}`, {
		method: "POST",
		headers: { Authorization: `Key ${key}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (!res.ok) {
		let detail = "";
		try {
			const j = await res.json();
			detail = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail ?? "");
		} catch {
			/* not JSON */
		}
		throw new Error(`fal answered ${res.status}${res.status === 401 || res.status === 403 ? " — the key was rejected" : detail ? ` — ${detail.slice(0, 300)}` : ""}`);
	}
	return res.json();
}

/**
 * The prompt with the reference people named, so the model keeps their faces.
 */
export function promptWithPeople(prompt, people) {
	if (!people?.length) return prompt;
	const names = people.map((p) => p.name).join(", ");
	return (
		`Feature the exact ${people.length === 1 ? "person" : `${people.length} people`} from the reference photo${people.length === 1 ? "" : "s"} (${names}) — ` +
		`preserve their faces and likenesses faithfully, rendered as black-and-white photographic cutouts within the collage. ${prompt}`
	);
}

/**
 * Generate with several models at once.
 *
 * Returns one entry per model: its image URLs, or the sentence that explains why
 * there are none. One model failing never costs the others their pictures.
 */
export async function generate({ key, prompt, models, aspect = "1:1", count = 1, people = [], fetchImpl = fetch }) {
	const requested = (Array.isArray(models) ? models : [models]).filter((m) => MODELS[m]);
	if (!requested.length) throw new Error("pick at least one model");
	const n = Math.min(Math.max(Number.parseInt(count, 10) || 1, 1), 4);
	const safeAspect = SIZE_PRESET[aspect] ? aspect : "1:1";
	const finalPrompt = promptWithPeople(prompt, people);
	const refs = people.map((p) => p.photo);
	const results = await Promise.all(
		requested.map(async (model) => {
			try {
				const def = MODELS[model];
				if (refs.length && !def.edit) throw new Error("this model cannot use reference photos of people");
				const endpoint = refs.length ? def.edit : model;
				const bodies = def.build(finalPrompt, safeAspect, n).map((b) => (refs.length ? { ...b, image_urls: refs } : b));
				const batches = await Promise.all(bodies.map((b) => callFal(endpoint, b, key, { fetchImpl })));
				const urls = batches.flatMap((d) => (d.images ?? []).map((i) => i.url)).filter(Boolean);
				if (!urls.length) throw new Error("the model returned no images");
				return { model, urls, error: null };
			} catch (err) {
				return { model, urls: [], error: err.message };
			}
		}),
	);
	return { results, prompt: finalPrompt, aspect: safeAspect };
}

/** A loose idea, made into a scene. */
export async function enhance({ key, subject, fetchImpl = fetch }) {
	const data = await callFal("openrouter/router", { model: "anthropic/claude-haiku-4.5", system_prompt: ENHANCE_SYSTEM, prompt: subject, temperature: 0.8, max_tokens: 300 }, key, { fetchImpl });
	if (data.error) throw new Error(`enhance failed — ${data.error}`);
	const improved = String(data.output ?? "").trim();
	if (!improved) throw new Error("the model returned nothing — try again");
	return improved;
}

/**
 * Change one picture.
 *
 * With a mask it is inpainting: FLUX Fill repaints the white area and nothing
 * else. Without one it is a whole-image edit through Nano Banana Pro, told to
 * keep everything but the instruction the same.
 */
export async function refine({ key, imageUrl, instruction, mask = null, fetchImpl = fetch }) {
	const text = String(instruction ?? "").trim();
	if (!imageUrl || !text) throw new Error("an image and an instruction are required");
	if (mask && !String(mask).startsWith("data:image/")) throw new Error("the mask has to be an image data URI");
	const endpoint = mask ? "fal-ai/flux-pro/v1/fill" : "fal-ai/nano-banana-pro/edit";
	const body = mask
		? { prompt: `${text}, matching the surrounding editorial collage style and brand palette`, image_url: imageUrl, mask_url: mask, num_images: 1, output_format: "png" }
		: { prompt: `${text} Keep everything else in the image exactly the same, preserving the editorial collage style.`, image_urls: [imageUrl], num_images: 1, output_format: "png", resolution: "1K" };
	const data = await callFal(endpoint, body, key, { fetchImpl });
	const url = data.images?.[0]?.url;
	if (!url) throw new Error("the model returned no image — try again");
	return { url, endpoint };
}
