/*
 * Play a composition, whichever kind it is.
 *
 * There are two in use here and they are the same idea with different plumbing:
 *
 *   HyperFrames  a <template> holding [data-composition-id] with data-duration in
 *                SECONDS, whose inline script registers a PAUSED GSAP timeline on
 *                window.__timelines[id]. Seek with tl.seek(seconds).
 *
 *   rm-video     an <rm-scene> whose children carry `at`/`for` in MILLISECONDS,
 *                driven by one `--t` custom property. Seek with RM.seek(ms).
 *
 * Both are seeked and neither plays, which is what makes a render deterministic:
 * frame N is identical every time. The only thing that differs is the call, so
 * this normalises them to one — `seek(ms)` and `durationMs()` — and everything
 * upstream stops caring which it is holding.
 *
 * Milliseconds throughout, because our components, the renderer and the editor's
 * timeline all speak ms; seconds appear only at the GSAP boundary and are
 * converted there rather than leaking.
 */

/** `data-duration` is seconds; everything on this side is milliseconds. */
const SECONDS = 1000;

/**
 * Scripts do not run when a template's content is cloned.
 *
 * Cloning a <template> copies its <script> elements as inert nodes — they are
 * "already started" from the parser's point of view and never execute. A
 * composition whose timeline is registered by an inline script therefore mounts
 * with no timeline at all, and seeking does nothing, silently. Replacing each
 * one with a freshly created element is the standard way round it.
 */
function runScripts(root) {
	for (const old of [...root.querySelectorAll("script")]) {
		const fresh = document.createElement("script");
		for (const { name, value } of old.attributes) fresh.setAttribute(name, value);
		fresh.textContent = old.textContent;
		old.replaceWith(fresh);
	}
}

/** Load a script once, by URL, and resolve when it has run. */
function loadOnce(src) {
	const existing = [...document.scripts].find((s) => s.src.endsWith(src));
	if (existing) return existing.dataset.loaded ? Promise.resolve() : new Promise((r) => existing.addEventListener("load", r, { once: true }));
	return new Promise((resolve, reject) => {
		const el = document.createElement("script");
		el.src = src;
		el.addEventListener("load", () => {
			el.dataset.loaded = "1";
			resolve();
		});
		el.addEventListener("error", () => reject(new Error(`could not load ${src}`)));
		document.head.append(el);
	});
}

/**
 * Mount `html` into `container` and return a uniform handle.
 *
 * `gsapSrc` points at the vendored copy. It is loaded before the composition's
 * own script runs, because that script calls `gsap.timeline()` at parse time and
 * would throw otherwise — the composition files reference a CDN, which is not
 * available to a renderer and is the reason the copy exists.
 */
export async function mountComposition(container, html, { gsapSrc = "/brand/vendor/gsap.min.js" } = {}) {
	const doc = new DOMParser().parseFromString(html, "text/html");

	const template = doc.querySelector("template");
	const source = template ? template.content : doc.body;
	const root = source.querySelector("[data-composition-id]");

	if (root) {
		// HyperFrames. GSAP first, or the inline script throws on gsap.timeline().
		await loadOnce(gsapSrc);
		/*
		 * Turn off lazy rendering before any timeline is built.
		 *
		 * GSAP defers a tween's first DOM write to the next ticker tick, which is a
		 * real optimisation when something is playing and a silent disaster when it
		 * is being seeked and screenshotted: `seek()` returns with the timeline's
		 * time updated and the DOM still showing the previous frame. Nothing throws.
		 * Every frame of a render comes out as frame 0, and the timeline reports the
		 * right progress the whole way.
		 *
		 * Set here rather than after the composition's script runs, because `lazy`
		 * is read when each tween is created.
		 */
		window.gsap?.defaults?.({ lazy: false });
		const id = root.getAttribute("data-composition-id");
		container.replaceChildren(document.importNode(source, true));
		runScripts(container);

		const declared = Number(root.getAttribute("data-duration")) * SECONDS;
		const timeline = () => window.__timelines?.[id] ?? null;
		return {
			kind: "hyperframes",
			id,
			width: Number(root.getAttribute("data-width")) || 1920,
			height: Number(root.getAttribute("data-height")) || 1080,
			/*
			 * The declared duration wins over the timeline's own.
			 *
			 * A slide's timeline is padded to span the clip — the compositions say so
			 * themselves, keeping a background drift running for the full eight
			 * seconds so the sub-composition is not unmounted early. Trusting
			 * tl.duration() instead would cut a slide short wherever an author did
			 * not pad it, which is a rendering bug that only shows on some slides.
			 */
			durationMs: () => declared || (timeline()?.duration() ?? 0) * SECONDS,
			seek(ms) {
				const tl = timeline();
				if (!tl) return;
				tl.seek(ms / SECONDS);
				/*
				 * And flush. `lazy: false` covers tweens this player built the timeline
				 * for, but a composition can create its own with `lazy` back on, and a
				 * tick costs nothing here — nothing is playing.
				 */
				window.gsap?.ticker?.tick?.();
			},
			ready: () => Boolean(timeline()),
		};
	}

	// Ours. rm-video.js defines the elements and owns `--t`.
	container.replaceChildren(document.importNode(source, true));
	runScripts(container);
	await window.RM?.ready?.();
	return {
		kind: "rm-scene",
		id: null,
		width: 1920,
		height: 1080,
		durationMs: () => window.RM?.duration?.() ?? 0,
		seek(ms) {
			window.RM?.seek?.(ms);
		},
		ready: () => Boolean(window.RM),
	};
}
