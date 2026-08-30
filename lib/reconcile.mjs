/**
 * Reconcile an assembly composition with its own content.
 *
 * Three values in a Studio-built composition are DERIVED from the clips and go
 * stale the moment somebody moves a clip in HyperFrames: the root's
 * `data-duration`, the silent clock track that gives Canvas components a
 * seekable timeline, and the `at`/`for` timing every Canvas component carries
 * beside its `data-start`/`data-duration`. Nothing contradicted them. The CCC
 * Days render had seven seconds of black after the closing title (root
 * duration), a clock 7s longer than the content (clock), and a closing title
 * whose `at` was 13.6s later than its `data-start`, so it rendered blank.
 *
 * This is the pass that recomputes all of it from the clips, run before every
 * render (`bin/rm-render-hyperframes.mjs`) and checkable on its own
 * (`bin/rm-reconcile.mjs --check`). It is a pure function of the HTML string:
 * no DOM, no disk, so `npm run check` can drive it against fixtures.
 *
 * What it treats as evidence, and what it derives from that evidence:
 *
 *   evidence  every `[data-assembly-media]` clip (a video somebody can see)
 *             every other timed element's start and duration
 *   derived   dissolve tails         ride the clip they are named for
 *             lower thirds           sit 400ms into the clip they are for
 *             Canvas `at` / `for`    equal `data-start` / `data-duration`
 *             the closing title      starts where the last clip ends, unless moved in over it
 *             root and clock         end where the content ends
 *             transition tweens      positioned on the boundaries they belong to
 *
 * Only the exporter's own markup is touched, and only through the links the
 * exporter wrote: `clip-NN-tail` belongs to `clip-NN`, a lower third carries
 * `data-assembly-for`, a Canvas part carries `data-assembly-canvas-component`.
 * A person's hand-authored element with none of those is left exactly alone.
 */

const num = (value) => {
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
};

/** Three decimals, the way the exporter writes seconds. */
const seconds = (value) => (Math.max(0, Math.round(Number(value) * 1000)) / 1000).toFixed(3);

const attr = (attrs, name) => new RegExp(`(?:^|\\s)${name}=(["'])([^"']*)\\1`, "i").exec(attrs)?.[2] ?? null;
const hasAttr = (attrs, name) => new RegExp(`(?:^|\\s)${name}(?:=|\\s|$)`, "i").test(attrs);

function setAttr(open, name, value) {
	const existing = new RegExp(`((?:^|\\s)${name}=)(["'])[^"']*\\2`, "i");
	if (existing.test(open)) return open.replace(existing, `$1$2${value}$2`);
	return open.replace(/^<([a-z][\w-]*)/i, `<$1 ${name}="${value}"`);
}

/** Every opening tag that carries both `data-start` and `data-duration`. */
export function timedElements(html) {
	const found = [];
	const tag = /<([a-z][\w-]*)(\s[^<>]*)?>/gi;
	let match;
	while ((match = tag.exec(String(html ?? "")))) {
		const attrs = match[2] ?? "";
		if (!hasAttr(attrs, "data-start") || !hasAttr(attrs, "data-duration")) continue;
		const start = num(attr(attrs, "data-start"));
		const duration = num(attr(attrs, "data-duration"));
		if (start == null || duration == null) continue;
		found.push({
			tag: match[1].toLowerCase(),
			open: match[0],
			index: match.index,
			attrs,
			id: attr(attrs, "id"),
			start,
			duration,
			mediaStart: num(attr(attrs, "data-media-start")),
			root: hasAttr(attrs, "data-composition-id"),
			clock: hasAttr(attrs, "data-assembly-clock"),
			media: hasAttr(attrs, "data-assembly-media"),
			tail: hasAttr(attrs, "data-assembly-dissolve-tail"),
			canvas: attr(attrs, "data-assembly-canvas-component"),
			forClip: attr(attrs, "data-assembly-for"),
			lowerThird: /\bassembly-lower-third\b/.test(attr(attrs, "class") ?? ""),
			edits: {},
		});
	}
	return found;
}

/* Lower thirds, as hyperframesAssemblyHtml lays them: in 400ms after the cut,
   up for at most 4.2s and at least 1.2s, never past the clip. */
export const LOWER_THIRD = { leadMs: 400, minMs: 1200, maxMs: 4200 };

/**
 * Recompute every derived value. Returns the reconciled HTML, a list of what
 * changed (empty when the file already agreed with itself), what it could not
 * settle, and the clock the composition now needs.
 */
export function reconcileAssembly(html, { lowerThird = LOWER_THIRD } = {}) {
	const source = String(html ?? "");
	const elements = timedElements(source);
	const changes = [];
	const problems = [];
	const byId = new Map(elements.filter((element) => element.id).map((element) => [element.id, element]));
	const label = (element) => element.id ?? element.tag;
	const close = (a, b) => Math.abs(a - b) < 0.0015;

	const set = (element, name, value, what) => {
		const current = attr(element.attrs, name);
		if (current === String(value)) return;
		element.edits[name] = String(value);
		changes.push({ id: label(element), what, from: current, to: String(value) });
	};
	const setStart = (element, value, what) => {
		if (close(element.start, value)) return;
		set(element, "data-start", seconds(value), what);
		element.start = Number(seconds(value));
	};
	const setDuration = (element, value, what) => {
		if (close(element.duration, value)) return;
		set(element, "data-duration", seconds(value), what);
		element.duration = Number(seconds(value));
	};

	const root = elements.find((element) => element.root);
	if (!root) return { html: source, changes, problems: ["no root composition with data-composition-id"], clock: null, contentEndSec: 0 };

	const clips = elements.filter((element) => element.media && !element.tail);
	const lastClip = clips.reduce((last, clip) => (!last || clip.start > last.start ? clip : last), null);
	const lastMediaEnd = clips.reduce((end, clip) => Math.max(end, clip.start + clip.duration), 0);

	/* A dissolve tail is a muted clone that picks the picture up at the cut. */
	for (const element of elements) {
		if (!element.tail || !element.id?.endsWith("-tail")) continue;
		const owner = byId.get(element.id.slice(0, -"-tail".length));
		if (!owner?.media) {
			problems.push(`${element.id} has no clip to follow`);
			continue;
		}
		setStart(element, owner.start + owner.duration, "dissolve tail follows its clip's out point");
		if (owner.mediaStart != null) {
			const mediaStart = owner.mediaStart + owner.duration;
			if (element.mediaStart == null || !close(element.mediaStart, mediaStart)) {
				set(element, "data-media-start", seconds(mediaStart), "dissolve tail plays the frames after the cut");
				element.mediaStart = mediaStart;
			}
		}
	}

	/* A lower third names the person in the clip it is for. */
	for (const element of elements) {
		if (!element.lowerThird || !element.forClip) continue;
		const owner = byId.get(element.forClip);
		if (!owner?.media) {
			problems.push(`lower third for ${element.forClip} has no clip`);
			continue;
		}
		const durationMs = Math.min(lowerThird.maxMs, Math.max(lowerThird.minMs, owner.duration * 1000 - lowerThird.leadMs));
		setStart(element, owner.start + lowerThird.leadMs / 1000, "lower third sits on its clip");
		setDuration(element, durationMs / 1000, "lower third fits its clip");
	}

	/*
	 * The closing title starts where the footage stops — unless it was moved in.
	 *
	 * A title left standing after the clips were tightened is stale: black
	 * between the last frame and the card. A title dragged back over the last
	 * clip so it fades in over the footage is a decision. A gap is the one
	 * direction nobody chooses, so only a gap is closed.
	 */
	const closing = elements
		.filter((element) => element.canvas === "rm-title" && lastClip && element.start > lastClip.start)
		.sort((a, b) => a.start - b.start)[0];
	if (closing && closing.start > lastMediaEnd + 0.001) setStart(closing, lastMediaEnd, "closing title starts at the last clip's out point");

	/* A Canvas part carries its own clock; it must agree with the timeline. */
	for (const element of elements) {
		if (!element.canvas) continue;
		const at = String(Math.round(element.start * 1000));
		const forMs = String(Math.round(element.duration * 1000));
		if (attr(element.attrs, "at") !== at) set(element, "at", at, "Canvas `at` follows data-start");
		if (attr(element.attrs, "for") !== forMs) set(element, "for", forMs, "Canvas `for` follows data-duration");
	}

	/* Content ends where the last visible thing ends. */
	const contentEndSec = elements
		.filter((element) => !element.root && !element.clock)
		.reduce((end, element) => Math.max(end, element.start + element.duration), 0);
	setDuration(root, contentEndSec, "root duration equals the content");

	let clock = null;
	const clockTrack = elements.find((element) => element.clock);
	if (clockTrack) {
		setDuration(clockTrack, contentEndSec, "clock duration equals the content");
		if (attr(clockTrack.attrs, "data-assembly-clock-derived") !== seconds(contentEndSec)) {
			set(clockTrack, "data-assembly-clock-derived", seconds(contentEndSec), "clock is marked as derived from this content");
		}
		const wholeSeconds = Math.max(1, Math.ceil(contentEndSec - 0.0005));
		const src = attr(clockTrack.attrs, "src") ?? "";
		const named = /^(.*canvas-clock-)(\d+)(s\.m4a)$/.exec(src);
		if (named) {
			const file = `${named[1]}${wholeSeconds}${named[3]}`;
			if (file !== src) set(clockTrack, "src", file, "clock file matches the content length");
			clock = { src: file, seconds: wholeSeconds };
		} else {
			clock = { src, seconds: wholeSeconds };
			if (src) problems.push(`clock track ${src} is not a Studio clock; its length was not checked`);
		}
	}

	/* Splice the edited opening tags back in place. */
	let out = "";
	let cursor = 0;
	for (const element of elements) {
		const names = Object.keys(element.edits);
		if (!names.length) continue;
		let open = element.open;
		for (const name of names) open = setAttr(open, name, element.edits[name]);
		out += source.slice(cursor, element.index) + open;
		cursor = element.index + element.open.length;
	}
	out += source.slice(cursor);

	/* Transitions the exporter wrote, re-positioned on the boundaries they belong to. */
	out = out.replace(
		/tl\.fromTo\('#(clip-\d+)', \{ opacity: 0 \}, \{ opacity: 1, duration: ([\d.]+), ease: 'none' \}, ([\d.]+)\);/g,
		(whole, id, duration, at) => {
			const incoming = byId.get(id);
			if (!incoming?.media) return whole;
			const position = seconds(incoming.start);
			if (position === seconds(Number(at))) return whole;
			changes.push({ id, what: "dissolve begins where the incoming clip starts", from: at, to: position });
			return `tl.fromTo('#${id}', { opacity: 0 }, { opacity: 1, duration: ${duration}, ease: 'none' }, ${position});`;
		},
	);
	out = out.replace(
		/tl\.to\('#(clip-\d+)', \{ opacity: 0, duration: ([\d.]+), ease: 'none' \}, ([\d.]+)\);/g,
		(whole, id, duration, at) => {
			const outgoing = byId.get(id);
			if (!outgoing?.media) return whole;
			const position = seconds(outgoing.start + outgoing.duration - Number(duration));
			if (position === seconds(Number(at))) return whole;
			changes.push({ id, what: "fade-out ends on the clip's out point", from: at, to: position });
			return `tl.to('#${id}', { opacity: 0, duration: ${duration}, ease: 'none' }, ${position});`;
		},
	);

	/* A lower third's entrance and exit, on the plate the exporter tied to its clip. */
	out = out.replace(
		/tl\.fromTo\('#(clip-\d+-plate)', \{ opacity: 0, x: -24 \}, \{ opacity: 1, x: 0, duration: ([\d.]+), ease: 'power3\.out' \}, ([\d.]+)\);/g,
		(whole, id, duration, at) => {
			const plate = byId.get(id);
			if (!plate?.lowerThird) return whole;
			const position = seconds(plate.start);
			if (position === seconds(Number(at))) return whole;
			changes.push({ id, what: "lower third enters with its plate", from: at, to: position });
			return `tl.fromTo('#${id}', { opacity: 0, x: -24 }, { opacity: 1, x: 0, duration: ${duration}, ease: 'power3.out' }, ${position});`;
		},
	);
	out = out.replace(
		/tl\.to\('#(clip-\d+-plate)', \{ opacity: 0, duration: ([\d.]+), ease: 'none' \}, ([\d.]+)\);/g,
		(whole, id, duration, at) => {
			const plate = byId.get(id);
			if (!plate?.lowerThird) return whole;
			const position = seconds(plate.start + plate.duration - Number(duration));
			if (position === seconds(Number(at))) return whole;
			changes.push({ id, what: "lower third leaves with its plate", from: at, to: position });
			return `tl.to('#${id}', { opacity: 0, duration: ${duration}, ease: 'none' }, ${position});`;
		},
	);

	return { html: out, changes, problems, clock, contentEndSec: Number(seconds(contentEndSec)) };
}

/** The disagreements in a composition, as sentences. Empty means it is consistent. */
export function auditAssembly(html) {
	const { changes, problems } = reconcileAssembly(html);
	return [
		...changes.map((change) => `${change.id}: ${change.what} (${change.from ?? "unset"} → ${change.to})`),
		...problems,
	];
}
