/*
 * Training a look from a wall of references.
 *
 * A mood board is a dozen pictures somebody chose because they share something
 * — a palette, a material, a way of lighting a thing. A LoRA is the smallest
 * way to hand that shared something to a model: a few megabytes of weights that
 * ride on a base model and pull it toward the wall. This turns one into the
 * other, and then uses it.
 *
 * WHY THE QUEUE AND NOT A PLAIN CALL
 *
 * Training is ten to thirty minutes. `callFal` waits on one request with a
 * timeout, which is right for a picture and hopeless here — and a server that
 * restarts when its code changes must not lose a run that is half an hour in.
 * So a run is submitted to fal's queue and the ticket is written onto the board:
 * the request id is the whole state, and anything that can read the board can
 * ask how the training is going, including a process that did not start it.
 */

import { callFal } from "./style-gen.mjs";

const QUEUE = "https://queue.fal.run";

/** The trainers, and the field each one wants its pictures in. */
export const LORA_TRAINERS = [
	{ id: "fal-ai/flux-lora-fast-training", label: "FLUX · fast (a style from a wall)", field: "images_data_url", style: true },
	{ id: "fal-ai/flux-lora-portrait-trainer", label: "FLUX · portrait (faces and people)", field: "images_data_url", style: false },
	{ id: "fal-ai/flux-kontext-trainer", label: "Flux Kontext (edits in this style)", field: "image_data_url", style: true },
	{ id: "fal-ai/qwen-image-trainer", label: "Qwen image", field: "image_data_url", style: true },
];

/** What a trained look is used by, once there is one. */
export const LORA_BASE = "fal-ai/flux-lora";

const trainer = (id) => LORA_TRAINERS.find((t) => t.id === id) ?? LORA_TRAINERS[0];

/** A word the model learns to attach the look to. Its own, so it collides with nothing. */
export const triggerFor = (name) =>
	`${String(name)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "")
		.slice(0, 14) || "board"}style`;

/**
 * Start a run. Answers the ticket to write onto the board — never the result,
 * which is half an hour away.
 */
export async function startTraining({ key, model, zipUrl, trigger, steps = 1000, fetchImpl = fetch }) {
	const t = trainer(model);
	const body = { [t.field]: zipUrl, trigger_word: trigger, steps: Math.min(4000, Math.max(100, Number(steps) || 1000)) };
	/* `is_style` tells the trainer this is a look rather than a subject, which is
	   what a mood board almost always is. The trainers that have no such field
	   ignore it rather than failing. */
	if (t.style) body.is_style = true;
	const res = await fetchImpl(`${QUEUE}/${t.id}`, {
		method: "POST",
		headers: { Authorization: `Key ${key}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const json = await res.json().catch(() => ({}));
	if (!res.ok || !json.request_id) throw new Error(`fal would not start the training (${res.status})${json.detail ? ` — ${JSON.stringify(json.detail).slice(0, 200)}` : ""}`);
	return { model: t.id, requestId: json.request_id, statusUrl: json.status_url, responseUrl: json.response_url, trigger, steps: body.steps, at: new Date().toISOString() };
}

/**
 * How a run is going, and its result when there is one.
 *
 * `{ done: false }` while it is queued or running, `{ done: true, lora }` when
 * the weights exist, and an error when fal says so. The caller writes the
 * result onto the board; this reads and reports, nothing more.
 */
export async function trainingStatus({ key, ticket, fetchImpl = fetch }) {
	if (!ticket?.statusUrl) return { done: false, state: "unknown" };
	const headers = { Authorization: `Key ${key}` };
	const st = await fetchImpl(ticket.statusUrl, { headers }).then((r) => r.json().catch(() => ({}))).catch(() => null);
	if (!st) return { done: false, state: "unreachable" };
	const state = String(st.status ?? "").toUpperCase();
	if (state === "IN_QUEUE" || state === "IN_PROGRESS") return { done: false, state: state.toLowerCase(), position: st.queue_position ?? null };
	const res = await fetchImpl(ticket.responseUrl, { headers });
	const json = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(`the training failed (${res.status})${json.detail ? ` — ${JSON.stringify(json.detail).slice(0, 200)}` : ""}`);
	/* Every trainer names the weights something slightly different, and one of
	   them hands back a config beside them; the file is what matters. */
	const url = json.diffusers_lora_file?.url ?? json.lora_file?.url ?? json.safetensors_file?.url ?? json.lora?.url ?? null;
	if (!url) throw new Error("the training finished but returned no weights");
	return { done: true, state: "done", lora: { url, trigger: ticket.trigger, model: ticket.model, steps: ticket.steps, at: new Date().toISOString() } };
}

/**
 * Make a picture with a trained look.
 *
 * The trigger word goes in front of the prompt because that is the only thing
 * tying the weights to the words — a prompt without it quietly returns the base
 * model, which reads as the training not having worked.
 */
export async function generateWith({ key, lora, prompt, scale = 1, count = 1, fetchImpl = fetch }) {
	const text = String(prompt ?? "").trim() || "a new piece in this style";
	const withTrigger = lora.trigger && !text.toLowerCase().includes(lora.trigger) ? `${lora.trigger}, ${text}` : text;
	/* Through `callFal` so a busy gateway is waited out here too, rather than
	   read as the trained look being broken. */
	const json = await callFal(
		LORA_BASE,
		{
			prompt: withTrigger,
			loras: [{ path: lora.url, scale: Math.min(2, Math.max(0, Number(scale) || 1)) }],
			num_images: Math.min(4, Math.max(1, Number(count) || 1)),
			output_format: "png",
		},
		key,
		{ fetchImpl },
	);
	const urls = (json.images ?? []).map((i) => i.url).filter(Boolean);
	if (!urls.length) throw new Error("the model returned no picture — try again");
	return { urls, prompt: withTrigger };
}
