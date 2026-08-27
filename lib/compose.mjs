/*
 * Compose a video out of scenes and footage.
 *
 * The pieces all existed and nothing joined them up. components/rm-video.js has
 * titles, lower thirds, callouts, stats and browser chrome, each already seekable
 * and already timed by `at`/`for`. components/render-scene.mjs turns one HTML file
 * into an mp4. The editor opens a document made of video clips. What was missing
 * was the middle: a way to say "this title, then that recording, then this stat"
 * without hand-writing scene HTML and hand-assembling a document.
 *
 * Two ideas carry the whole model:
 *
 *   A SEGMENT is one span of the finished video, in order. It is either a SCENE
 *   (built from components) or FOOTAGE (a file already in the project).
 *
 *   A SCENE has its own little timeline inside it. That is where overlays live —
 *   a lower third at 3s for 4s over browser chrome is one scene, not two tracks.
 *
 * That split is forced by the document, not chosen: `timelineSchema` in the fork
 * is a flat `clips: []` with no layers, so nothing can sit *over* a clip. Anything
 * that overlaps has to be resolved before it becomes a clip — which is exactly
 * what rendering a scene does.
 */

import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

/** 1920×1080 at 30fps is what render-scene and the editor both assume. */
export const SCENE_W = 1920;
export const SCENE_H = 1080;
export const FPS = 30;

/** The stage every other component is placed inside. */
export const STAGE_TAG = "rm-scene";

/**
 * The component catalogue, read from the components themselves.
 *
 * Parsed rather than restated. Every component already declares `static fields`
 * so it knows which attributes it renders, and a second hand-maintained copy here
 * would be wrong the first time somebody adds a field — silently, because a form
 * that omits an attribute produces a scene that renders without it rather than an
 * error. `define('rm-title', RMTitle)` gives the tag; the class body gives the
 * fields.
 */
export async function readComponentCatalogue(root) {
	const src = await readFile(join(root, "components", "rm-video.js"), "utf8");

	/*
	 * Each `static fields` belongs to the nearest class declared before it.
	 *
	 * Matching `class X ... static fields` as one lazy span looked equivalent and
	 * is not: the base class declares no fields, so its span ran on and swallowed
	 * the next class's declaration along with its fields. Everything after
	 * happened to re-align, so the result looked right while one component was
	 * silently missing from the catalogue — the failure mode a parser like this
	 * has to be built against.
	 */
	const classAt = [...src.matchAll(/class\s+(\w+)\s+extends\s+\w+\s*\{/g)].map((m) => ({
		name: m[1],
		at: m.index,
	}));
	const fieldsByClass = new Map();
	for (const m of src.matchAll(/static fields = \[([^\]]*)\]/g)) {
		let owner = null;
		for (const c of classAt) {
			if (c.at < m.index) owner = c.name;
			else break;
		}
		if (!owner) continue;
		fieldsByClass.set(owner, [...m[1].matchAll(/'([^']+)'/g)].map((f) => f[1]));
	}

	const out = [];
	for (const m of src.matchAll(/define\('([\w-]+)',\s*(\w+)\)/g)) {
		const [, tag, cls] = m;
		const fields = fieldsByClass.get(cls);
		if (!fields) continue;
		// The stage, not something to place on it: its wallpaper and size are
		// properties of the scene and are set by sceneHtml, not picked per element.
		if (tag === STAGE_TAG) continue;
		out.push({
			tag,
			// `at` and `for` are timing, not content: every component that can be
			// scheduled has them, and they belong in a timing control rather than
			// mixed in with the text fields.
			timed: fields.includes("at") && fields.includes("for"),
			fields: fields.filter((f) => f !== "at" && f !== "for"),
		});
	}
	return out;
}

/** Attribute values are interpolated into HTML, so they are escaped. */
const esc = (v) =>
	String(v ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");

/**
 * How long a scene runs.
 *
 * The furthest point any element reaches, not the sum: elements overlap by
 * design, and a lower third starting at 3s for 4s inside a 6s scene should not
 * make it 13s long. An untimed element (browser chrome with no `for`) is on
 * screen until the end, so it cannot extend the scene by itself — something with
 * an ending has to.
 */
export function sceneDurationMs(elements, { min = 2000 } = {}) {
	let end = 0;
	for (const el of elements) {
		const at = Number(el.at) || 0;
		const dur = Number(el.for) || 0;
		if (dur) end = Math.max(end, at + dur);
		else end = Math.max(end, at + min);
	}
	return Math.max(end, min);
}

/**
 * A scene as a standalone HTML file render-scene.mjs can open.
 *
 * Paths are relative to components/, which is where the file is written, because
 * that is the only directory whose relationship to brand/ is fixed. Writing it
 * anywhere else would need the stylesheet links rewritten per destination.
 */
export function sceneHtml({ wallpaper, elements, body: authored, title = "Composed scene", base = "..", brand, previewAt = 0 }) {
	/*
	 * An authored scene, when one is given.
	 *
	 * The form can only offer the six components and the fields they declare,
	 * which is a ceiling: no custom layout, no bespoke animation, nothing the
	 * component set does not already do. Letting the markup be written directly
	 * removes that ceiling, and the renderer never cared where the HTML came
	 * from.
	 *
	 * What is authored is the scene BODY — what goes inside <rm-scene> — not the
	 * whole document. The wrapper keeps the parts that must be right for a render
	 * to be a render: the brand faces, the stage at a real 1920×1080, a page that
	 * cannot scroll, and RM.ready() before the first frame. Those are the harness,
	 * not content, and an author who has to reproduce them every time will get one
	 * of them wrong eventually — silently, because a missing @font-face renders
	 * fine in the wrong typeface.
	 *
	 * A <style> block inside the body is expected and supported, so authoring is
	 * not limited to the components.
	 */
	const scriptBase = base === ".." ? "." : `${base}/components`;
	/*
	 * The wallpaper is resolved here, not by the caller.
	 *
	 * rm-scene appends `.jpg` and resolves what it is given against the page URL —
	 * so a caller-supplied `../brand/wallpapers/x` is correct for a render out of
	 * components/ and wrong for a preview served from /api/scene/preview/N, where
	 * it became /api/scene/brand/wallpapers/x.jpg and 404'd. A bare name lets the
	 * one place that knows the base build the path. A value with a slash is still
	 * honoured, so an author can point at something of their own.
	 */
	const wallpaperPath = !wallpaper
		? null
		: wallpaper.includes("/")
			? wallpaper
			: `${base}/brand/wallpapers/${wallpaper}`;
	const wallpaperAttr = wallpaperPath ? ` wallpaper="${esc(wallpaperPath)}"` : "";
	/*
	 * Where the brand pictures are, from wherever this scene is about to run.
	 *
	 * Set on the stage rather than folded into each element's `src`, because a
	 * scene body can be authored HTML — and rewriting attributes inside a string
	 * somebody wrote by hand is a parser nobody asked for. One attribute on the
	 * stage means `rm-image` resolves a bare name itself, and an authored scene
	 * gets the same treatment as a built one for free.
	 */
	const assetsAttr = ` assets="${esc(`${base}/brand/imagery`)}"`;
	/*
	 * The sub-brand, which for now means the typeface.
	 *
	 * Set on the stage rather than on each part: custom properties cross into a
	 * child's shadow root, so one declaration reaches every component — and a face
	 * chosen per part is not a thing anybody wants.
	 */
	const brandAttr = brand ? ` brand="${esc(brand)}"` : "";
	const body = typeof authored === "string" ? authored : (elements ?? [])
		.map((el) => {
			const attrs = Object.entries(el.attrs ?? {})
				.filter(([, v]) => String(v ?? "").trim() !== "")
				.map(([k, v]) => `${k}="${esc(v)}"`);
			if (el.at != null) attrs.unshift(`at="${Number(el.at) || 0}"`);
			if (el.for) attrs.push(`for="${Number(el.for)}"`);
			// Position only when given: the components default to filling the stage,
			// and an empty `style` attribute would override that with nothing.
			const style = el.left != null && el.top != null ? ` style="left:${Number(el.left)}%; top:${Number(el.top)}%"` : "";
			return `      <${el.tag} ${attrs.join(" ")}${style}></${el.tag}>`;
		})
		.join("\n");

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>${esc(title)}</title>
<!-- GENERATED by lib/compose.mjs. Edit the composition, not this file. -->
<link rel="stylesheet" href="${base}/brand/fonts/fonts.css"/>
<link rel="stylesheet" href="${base}/brand/optics/optics.css"/>
<link rel="stylesheet" href="${base}/brand/optics/rolemodel-scales.css"/>
<style>
  :root { color-scheme: dark; }
  /*
   * A render target must not scroll.
   *
   * render-scene screenshots the whole viewport, not the stage element, so a
   * scrollbar is composited into every frame — a blue strip along the bottom of
   * the finished video, from Chromium's default scrollbar rather than from
   * anything in the design system. One sub-pixel of overflow is enough to
   * summon it, and the stage is sized in vw against a viewport that may round.
   */
  html, body { margin: 0; overflow: hidden; background: var(--op-color-neutral-plus-max); }
  body { display: grid; place-items: center; min-height: 100vh; }
  #stage { width: 100vw; max-width: calc(100vh * ${SCENE_W} / ${SCENE_H}); }
</style>
<script type="module" src="${scriptBase}/rm-video.js"></script>
</head>
<body>

<div id="stage">
  <rm-scene${wallpaperAttr}${assetsAttr}${brandAttr}>
${body}
  </rm-scene>
</div>

<script type="module">
  import { RM } from "${scriptBase}/rm-video.js";
  await RM.ready();
  RM.seek(${Number.isFinite(previewAt) && previewAt > 0 ? Math.round(previewAt) : 0});
</script>

</body>
</html>
`;
}

/**
 * The document for a finished composition.
 *
 * Legacy v2 rather than an AxcutDocument on purpose: v2 is the shape the editor
 * already migrates on load, `rm-video brand` already understands it, and it is
 * the same shape /api/open-media writes — so a composed document and a captured
 * one travel the same path and there is one migration to be wrong, not two.
 *
 * It names ONE video, because that is all v2 can name.
 *
 * The first attempt put the first segment in `screenVideoPath` and the rest in a
 * `composition.appendClips` list alongside it. The document validated, opened,
 * and showed a two-second silent title card — every other segment, and all the
 * audio with them, sat in a key nothing reads. `timelineSchema` is a flat clip
 * list with no layers and v2 names a single file: a multi-segment composition
 * simply cannot be expressed as a document. So the segments are concatenated
 * into one video before this is called, and this names that.
 *
 * `segments` is kept for provenance — what was cut together, in order — so a
 * finished composition still says how it was made.
 */
export function composeDocument({ video, segments, cursorCaptureMode = "editable-overlay" }) {
	if (!video) throw new Error("nothing to compose");
	return {
		version: 2,
		media: { screenVideoPath: video, cursorCaptureMode },
		editor: {},
		composition: {
			version: 2,
			segments: segments.map((p) => ({ file: basename(p.path), ms: p.ms })),
			totalMs: segments.reduce((n, p) => n + p.ms, 0),
		},
	};
}
