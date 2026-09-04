/**
 * RoleModel video components.
 *
 * HyperFrames renders HTML to video by driving a headless Chromium and grabbing
 * frames. That constrains the design in two ways that matter, and both are the
 * reason this file exists rather than a pile of per-video markup:
 *
 * 1. **Time must be seekable, not played.** A frame grabber asks for the scene
 *    "at 2400ms". If animation is a `transition` or a JS rAF loop, the answer
 *    depends on when the renderer happened to look, and two runs of the same
 *    source produce different videos. So every animation here is a paused CSS
 *    animation whose `animation-delay` is driven from a single `--t` custom
 *    property. `RM.seek(2400)` sets the whole scene to that instant, exactly,
 *    every time. Call it once per frame and the render is deterministic.
 *
 * 2. **No network at render time.** Google Fonts, a CDN, an un-cached image —
 *    each is a chance for a frame to capture a half-loaded scene. Components
 *    take their colour from Optics custom properties (already on the page) and
 *    their images from whatever you hand them, and `RM.ready()` resolves when
 *    fonts and images have actually settled.
 *
 * Usage in a HyperFrames scene:
 *
 *   <link rel="stylesheet" href="optics/optics.css">
 *   <link rel="stylesheet" href="optics/rolemodel-scales.css">
 *   <script type="module" src="rm-video.js"></script>
 *
 *   <rm-scene wallpaper="rm-dark-dotgrid">
 *     <rm-browser url="app.rolemodelsoftware.com" image="shot.png" at="0"></rm-browser>
 *     <rm-lower-third name="Dallas Peters" sub="Senior Designer" at="800" for="4000">
 *   </rm-scene>
 *
 * Every component takes `at` (ms it appears) and `for` (ms it stays). Leave
 * `for` off and it stays to the end.
 */

/* ── deterministic time ──────────────────────────────────────────────────── */

const root = document.documentElement
const readyWork = new Set()

export const RM = {
  /** Put the whole scene at `ms`. Idempotent, and the only way time advances. */
  seek(ms) {
    root.style.setProperty('--t', `${ms}ms`)
    root.dataset.t = String(ms)
    root.dispatchEvent(new CustomEvent('rmseek', { detail: ms }))
  },
  get t() {
    return Number(root.dataset.t ?? 0)
  },
  /**
   * Resolve once the scene is actually paintable. A frame grabbed before the
   * webfont swaps is a frame with the wrong metrics, and it is the single most
   * common way an HTML-rendered video ends up subtly broken.
   */
  async ready() {
    await document.fonts?.ready
    const imgs = [...document.querySelectorAll('img')].map((i) => (i.complete ? null : new Promise((r) => i.addEventListener('load', r, { once: true }) || i.addEventListener('error', r, { once: true }))))
    await Promise.all([...imgs.filter(Boolean), ...readyWork])
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  },
  /** A component can register work the outer document cannot see, such as a canvas texture. */
  waitFor(promise) {
    readyWork.add(promise)
    promise.finally(() => readyWork.delete(promise))
    return promise
  },
  /** Every component on the page, with its window. Useful for building a timeline. */
  beats() {
    /* data-start/data-duration first, for the reason RMElement.sync gives: they
       are the pair the HyperFrames timeline edits, and when the two disagree the
       timeline is what a person actually changed. duration() is built on this,
       so a stale `for` here becomes a render minutes longer than the video. */
    const ms = (e, dataName, attr) => {
      const raw = e.dataset[dataName]
      const seconds = raw == null || raw === '' ? Number.NaN : Number(raw)
      if (Number.isFinite(seconds)) return seconds * 1000
      return e.hasAttribute(attr) ? Number(e.getAttribute(attr)) : null
    }
    return [...document.querySelectorAll('[at], [data-start]')].map((e) => ({
      el: e,
      tag: e.tagName.toLowerCase(),
      at: ms(e, 'start', 'at') ?? 0,
      for: ms(e, 'duration', 'for'),
    }))
  },
  /** Total runtime implied by the scene, so the render length isn't guesswork. */
  duration(tailMs = 800) {
    return RM.beats().reduce((n, b) => Math.max(n, b.at + (b.for ?? 2500)), 0) + tailMs
  },
}

if (!root.style.getPropertyValue('--t')) RM.seek(0)
globalThis.RM = RM

/* ── shared style ────────────────────────────────────────────────────────── */

/**
 * Enter/exit as paused animations positioned by --t.
 *
 * The trick: an animation with `animation-play-state: paused` and a negative
 * `animation-delay` renders the frame at exactly `-delay` into its timeline. So
 * `calc(var(--at) - var(--t))` maps scene time onto element time with no
 * playback involved, and frame N is identical on every run.
 *
 * The subtlety that cost me a render: two animations on one element cannot both
 * drive `opacity`. With `fill-mode: both`, the exit animation's *backwards* fill
 * (opacity 1) wins over the entrance's (opacity 0) simply by being later in the
 * list, so every component was visible from frame 0 and nothing ever appeared on
 * cue. The fix is that the two animations write to different registered custom
 * properties, and opacity/transform are composed from both. One property, one
 * writer.
 */
for (const [name, syntax, initial] of [
  ['--rm-in-o', '<number>', '0'],
  ['--rm-out-o', '<number>', '1'],
  ['--rm-in-y', '<length>', '0px'],
  ['--rm-out-y', '<length>', '0px'],
  ['--rm-in-s', '<number>', '1'],
]) {
  // Registered so they interpolate as numbers rather than flipping at 50%.
  // Registration is document-global, which is why it happens here once rather
  // than inside every shadow root.
  try {
    CSS.registerProperty({ name, syntax, initialValue: initial, inherits: false })
  } catch {
    /* already registered, or an engine without @property — animation still runs, just stepped */
  }
}

const TIMING = `
  :host {
    /*
     * Motion comes from the brand, not from here.
     *
     * These are the tokens in rolemodel-brand/tokens/brand.json, generated into
     * css/academy-theme.css. The fallbacks are the same values, so a component
     * dropped on a page with no theme still moves correctly — but when the theme
     * is present it wins, and retuning the brand retunes every video at once.
     */
    --at: 0ms;
    --dur: var(--duration-base, 400ms);
    --out-dur: var(--duration-fast, 200ms);
    --hold: 999999ms;
    --ease: var(--ease-enter, cubic-bezier(0.16, 1, 0.3, 1));
    --ease-out-curve: var(--ease-exit, cubic-bezier(0.55, 0, 1, 0.45));
    --rise: var(--distance-sm, 8px);
  }
  .anim {
    animation-name: rm-in, rm-out;
    animation-duration: var(--dur), var(--out-dur);
    /* --lead lets the parts of one component arrive in order — an eyebrow a
       beat before its title — without a second clock. The exit is shared. */
    animation-delay: calc(var(--at) + var(--lead, 0ms) - var(--t)), calc(var(--at) + var(--hold) - var(--t));
    animation-timing-function: var(--ease), var(--ease-out-curve);
    animation-fill-mode: both, both;
    animation-play-state: paused, paused;
    opacity: calc(var(--rm-in-o) * var(--rm-out-o));
    transform: translateY(calc(var(--rm-in-y) + var(--rm-out-y))) scale(var(--rm-in-s));
  }
  @keyframes rm-in  { from { --rm-in-o: 0; --rm-in-y: var(--rise); } to { --rm-in-o: 1; --rm-in-y: 0px; } }
  @keyframes rm-out { from { --rm-out-o: 1; --rm-out-y: 0px; } to { --rm-out-o: 0; --rm-out-y: -8px; } }
`

const TYPE = `
  :host {
    /* --rm-font is the way a scene changes its face. Without the var() every
       component pins DM Sans on its own :host, which wins over anything the stage
       sets — so the sub-brand typeface had nowhere to get in. */
    --font: var(--rm-font, "DM Sans"), ui-sans-serif, system-ui, -apple-system, sans-serif;
    --mono: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    --fg: var(--op-color-neutral-minus-max, #fff);
    /*
     * Secondary text, measured rather than picked by eye.
     *
     * minus-five is 7.3:1 on the brand's dark boards — technically legible, and
     * washed out beside a title at 18.5:1, which is what made a subtitle read as
     * greyed-out rather than as secondary. minus-seven is 11.5:1: clearly
     * readable, still visibly subordinate.
     */
    --muted: var(--op-color-neutral-minus-seven, #caccce);
    /*
     * And a shadow, because a card is not always over a board.
     *
     * Laid over footage as an overlay there is no controlled ground at all — the
     * title sits on whatever the frame happens to show, and white on a white shirt
     * is nothing. Invisible against a dark board, decisive against a bright frame.
     */
    --ink-shadow: 0 0.08cqw 0.5cqw rgb(0 0 0 / 0.55);
    --brand: var(--op-color-academy-primary-base, #00c278);
    /* What reads ON --brand. Optics mixes one per family; the Studio sets both
       when an accent is picked, because a fill without its ink is how a pale
       accent ends up carrying text nobody can read. */
    --on-brand: var(--op-color-academy-primary-on-base, #00472c);
    /* And the family as TEXT on the stage, which is neither of the above: a seed
       can be a deep purple, and an eyebrow set in it on a dark wallpaper is
       invisible. Falls back to --brand so a scene that sets only that still works. */
    --brand-text: var(--brand);
    --surface: var(--op-color-neutral-plus-max, #242424);
    --surface-2: var(--op-color-neutral-plus-six, #333);
    --line: var(--op-color-neutral-plus-four, #424242);
    font-family: var(--font);
  }
  * { box-sizing: border-box; }
`

/** Base class: attribute plumbing every component shares, and nothing else. */
class RMElement extends HTMLElement {
  static observed = ['at', 'for']
  static get observedAttributes() {
    return [...new Set([...RMElement.observed, ...(this.fields ?? [])])]
  }

  connectedCallback() {
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' })
    this.render()
    this.sync()
  }

  attributeChangedCallback() {
    if (this.shadowRoot) {
      this.render()
      this.sync()
    }
  }

  /*
   * One clock, not two.
   *
   * A timed element carries its window twice: `at`/`for` in milliseconds, which
   * this reads, and `data-start`/`data-duration` in seconds, which the runtime
   * keys visibility off and which the HyperFrames timeline is what actually
   * edits. Nothing kept them in step, so dragging a clip's length moved the
   * window it is VISIBLE for and left the window it ANIMATES over where it was
   * — the change appeared to do nothing, which is exactly what it looks like
   * when a length control is broken.
   *
   * data-* wins where it exists, because that is the pair a person edits. A
   * scene previewed on its own has only at/for, and those still stand.
   */
  /** Milliseconds from a seconds-valued data-* attribute, or null. */
  _timed(name) {
    const raw = this.dataset[name]
    if (raw == null || raw === '') return null
    const seconds = Number(raw)
    return Number.isFinite(seconds) ? seconds * 1000 : null
  }

  /** Where this element starts, in milliseconds. Read this, never `at` alone. */
  startMs() {
    return this._timed('start') ?? Number(this.getAttribute('at') || 0)
  }

  sync() {
    this.style.setProperty('--at', `${this.startMs()}ms`)
    const hold = this._timed('duration') ?? (this.hasAttribute('for') ? Number(this.getAttribute('for')) : null)
    if (hold != null) this.style.setProperty('--hold', `${hold}ms`)
  }

  attr(name, fallback = '') {
    const v = this.getAttribute(name)
    return v === null || v === '' ? fallback : v
  }

  /** Text from an attribute is untrusted by construction — always escape it. */
  esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  }
}

/*
 * Where a bare picture name resolves from.
 *
 * Three contexts, and only two were handled. A scene preview puts the base on
 * <rm-scene>, and a component can carry its own — but a COMPOSITION has neither,
 * so `assets/imagery` was resolving against nothing and every uploaded picture
 * came out blank. That is the one place the answer is always the same: staging
 * copies added pictures to assets/imagery/ beside the composition, so that is
 * the fallback rather than the empty string.
 *
 * A name with a slash or a scheme is already a path and is left alone.
 */
const STAGED_IMAGERY = 'assets/imagery'

const assetBase = (el) =>
  el.getAttribute('assets') || el.closest('rm-scene')?.getAttribute('assets') || STAGED_IMAGERY

const assetUrl = (el, name) => {
  const raw = String(name ?? '').trim()
  if (!raw) return ''
  return raw.includes('/') || /^[a-z]+:/i.test(raw) ? raw : `${assetBase(el)}/${raw}`
}

const define = (name, cls) => {
  if (!customElements.get(name)) customElements.define(name, cls)
}

/* ── rm-scene ────────────────────────────────────────────────────────────── */

/**
 * The stage. Fixes the frame at a real 1920×1080 and scales it to fit whatever
 * viewport it is rendered in, so a scene composed at 1080p is byte-identical at
 * 4K — one `transform: scale()` rather than a layout that reflows and shifts
 * every glyph. Type sizes below are in cqw, so they follow the scale exactly.
 */
class RMScene extends RMElement {
  /*
   * `assets` is the base the brand pictures live under, and it is not a field.
   *
   * Kept off `static fields` deliberately: the catalogue is what the Scenes panel
   * offers you to fill in, and this is plumbing — sceneHtml sets it, because
   * sceneHtml is the one place that knows whether this scene is being rendered
   * out of components/ or previewed from a URL. An author naming a picture writes
   * its NAME; the path is nobody's problem but this attribute's.
   */
  static fields = ['wallpaper', 'pad', 'width', 'height', 'brand']
  render() {
    const w = Number(this.attr('width', 1920))
    const h = Number(this.attr('height', 1080))
    const wp = this.attr('wallpaper')
    const pad = this.attr('pad', '0')
    this.shadowRoot.innerHTML = `
      <style>
        ${TYPE}
        :host { display:block; width:100%; aspect-ratio:${w}/${h}; overflow:hidden; container-type:inline-size;
                background: var(--op-color-neutral-plus-max, #1f1f1f); }
        /* The sub-brand's face, set on the stage and inherited by every part.
           Custom properties cross into a child's shadow root, which is what makes
           one declaration here enough. */
        ${this.attr('brand') === 'academy' ? ':host { --rm-font: "Space Grotesk"; }' : ''}
        .stage { position:relative; width:100%; height:100%; padding:${Number(pad)}cqw;
                 background-size:cover; background-position:center; }
        ${wp ? `.stage { background-image:url("${this.esc(wp)}.jpg"); }` : ''}
        /* Footage is the one stage layer that sits underneath every branded
           component. It is supplied by sceneHtml when a Canvas shot is being
           edited, so lower thirds and titles are truly over the selected clip. */
        ::slotted(*) { position:absolute; z-index:1; }
        ::slotted([data-rm-footage]) {
          inset:0; width:100%; height:100%; z-index:0; object-fit:contain;
          background:var(--op-color-neutral-plus-max, #1f1f1f);
        }
      </style>
      <div class="stage"><slot></slot></div>`
  }
}
define('rm-scene', RMScene)

/* ── rm-browser ──────────────────────────────────────────────────────────── */

/**
 * Browser chrome around a screenshot or a live page.
 *
 * The chrome is drawn, not screenshotted: a real browser's chrome carries the
 * OS theme, the user's extensions, their bookmarks and their tab count, all of
 * which date a video and none of which are ours. Drawing it keeps every video
 * consistent and lets the chrome take Optics colours.
 *
 * `image` is the safe default. `src` embeds a live iframe, which is sharper for
 * a page you control but is a network dependency at render time — see the note
 * at the top of this file about half-loaded frames.
 */
class RMBrowser extends RMElement {
  static fields = ['url', 'x', 'y', 'w', 'at', 'for', 'dark']
  render() {
    const url = this.attr('url', 'app.rolemodelsoftware.com')
    const w = this.attr('w', '72')
    // Placed like rm-image and rm-callout: a percentage of the stage, from its
    // centre. It had no position at all, so `::slotted(*) { position:absolute }`
    // from rm-scene left it wherever the default put it and the only way to move
    // it was to change its width.
    const x = Number(this.attr('x', 50))
    const y = Number(this.attr('y', 50))
    /*
     * One field, and it both reads as the address and loads.
     *
     * There were three: `url` drew the address bar, `src` embedded an iframe and
     * `image` showed a screenshot — so the chrome could say one site while the
     * viewport showed another, and whichever of the two was set won silently.
     * `url` is the browser part's whole input now: what it says is what it loads.
     *
     * A scheme is added when the address is written the way people write one, so
     * `app.rolemodelsoftware.com` resolves instead of being read as a relative path.
     */
    const target = url && !/^[a-z]+:\/\//i.test(url) ? `https://${url}` : url
    this.shadowRoot.innerHTML = `
      <style>
        ${TYPE}${TIMING}
        :host { display:block; position:absolute; left:${x}%; top:${y}%;
                width:${Number(w)}cqw; --rise:22px; }
        /*
         * Centred on its own point, so 50/50 is the middle of the stage rather than
         * its top-left corner — the same reading as every other part.
         *
         * Written as .win.anim, and carrying the entrance transform with it,
         * because .win is also the animated element: a plain
         * translate(-50%,-50%) here would be a later rule of equal specificity and
         * would silently replace the rise and the scale, so the part would appear
         * centred and dead.
         */
        .win.anim { transform: translate(-50%, calc(-50% + var(--rm-in-y) + var(--rm-out-y))) scale(var(--rm-in-s)); }
        .win { border-radius:0.8cqw; overflow:hidden; background:var(--surface);
               border:1px solid var(--line);
               box-shadow: 0 2.4cqw 5cqw rgba(0,0,0,.45), 0 .4cqw 1cqw rgba(0,0,0,.3); }
        .bar { display:flex; align-items:center; gap:1.1cqw; padding:.85cqw 1.1cqw; background:var(--surface); }
        .dots { display:flex; gap:.45cqw; flex:0 0 auto; }
        .dot { width:.62cqw; height:.62cqw; border-radius:50%; background:var(--line); }
        .addr { flex:1; display:flex; align-items:center; gap:.6cqw; min-width:0;
                background:var(--op-color-neutral-plus-max, #1f1f1f); border:1px solid var(--line);
                border-radius:.45cqw; padding:.4cqw .8cqw;
                font-family:var(--mono); font-size:.78cqw; color:var(--muted); }
        .lock { width:.7cqw; height:.7cqw; flex:0 0 auto; color:var(--brand); }
        .u { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        /* The viewport is a simulated web page, so it carries its own colour
           scheme rather than the Studio's. The canvas system colour under
           color-scheme:light is the page background — semantically right, and it
           keeps a literal white out of a file where every colour is a token. */
        .view { aspect-ratio:16/10; color-scheme: light; background: canvas;
                display:block; width:100%; border:0; }
        /* No address yet. A plain white rectangle reads as a broken render; this
           reads as a placeholder, which is what it is. */
        .view.empty { background:var(--op-color-neutral-plus-six, #333);
                      display:flex; align-items:center; justify-content:center;
                      color:var(--muted); font-family:var(--mono); font-size:.9cqw;
                      letter-spacing:.14em; text-transform:uppercase; }
      </style>
      <div class="win anim">
        <div class="bar">
          <div class="dots"><i class="dot"></i><i class="dot"></i><i class="dot"></i></div>
          <div class="addr">
            <svg class="lock" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6">
              <rect x="3.2" y="7" width="9.6" height="6.4" rx="1.4"/><path d="M5.6 7V5.2a2.4 2.4 0 0 1 4.8 0V7"/>
            </svg>
            <span class="u">${this.esc(url)}</span>
          </div>
        </div>
        ${target ? `<iframe class="view" src="${this.esc(target)}" loading="eager" sandbox="allow-scripts allow-same-origin"></iframe>` : `<div class="view empty">no address</div>`}
      </div>`
  }
}
define('rm-browser', RMBrowser)

/* ── rm-title ────────────────────────────────────────────────────────────── */

/** Opening card. Eyebrow, title, optional sub — the three lines that carry it. */
class RMTitle extends RMElement {
  static fields = ['eyebrow', 'title', 'sub', 'align', 'at', 'for']
  render() {
    const align = this.attr('align', 'left')
    this.shadowRoot.innerHTML = `
      <style>
        ${TYPE}${TIMING}
        :host { display:block; inset:0; width:100%; height:100%; --rise:26px; }
        .wrap { position:absolute; inset:0; display:flex; flex-direction:column; justify-content:center;
                align-items:${align === 'center' ? 'center' : 'flex-start'};
                text-align:${align === 'center' ? 'center' : 'left'};
                padding:0 8cqw; gap:1cqw; }
        .eb { font-family:var(--mono); font-size:1.25cqw; letter-spacing:.16em; text-transform:uppercase; color:var(--brand-text); }
        h1 { margin:0; font-size:5.4cqw; font-weight:800; letter-spacing:-.03em; line-height:1.02; color:var(--fg); max-width:24ch; }
        .sub { font-size:1.7cqw; color:var(--fg); max-width:46ch; line-height:1.45;  }
        .rule { width:6cqw; height:.26cqw; border-radius:.2cqw; background:var(--brand-text); margin-top:.6cqw; }
        /*
         * The lines arrive in reading order, a beat apart: eyebrow, title, sub,
         * then the rule draws in from the left. Each is the same 26px rise on
         * the same brand curve — one motion, staggered — rather than four
         * different tricks. The whole card still leaves together. Kept small
         * on purpose: the reference this follows puts motion in the
         * background and leaves titles large and still.
         */
        .eb   { --lead: 0ms; }
        h1    { --lead: 120ms; }
        .sub  { --lead: 240ms; }
        .rule { --lead: 320ms; transform-origin: left center; transform: scaleX(var(--rm-in-o)); opacity: var(--rm-out-o); }
      </style>
      <div class="wrap">
        ${this.attr('eyebrow') ? `<div class="eb anim">${this.esc(this.attr('eyebrow'))}</div>` : ''}
        <h1 class="anim">${this.esc(this.attr('title', 'Title'))}</h1>
        ${this.attr('sub') ? `<div class="sub anim">${this.esc(this.attr('sub'))}</div>` : ''}
        <div class="rule anim"></div>
      </div>`
  }
}
define('rm-title', RMTitle)

/* ── rm-lower-third ──────────────────────────────────────────────────────── */

class RMLowerThird extends RMElement {
  static fields = ['name', 'sub', 'side', 'at', 'for']
  render() {
    const side = this.attr('side', 'left')
    this.shadowRoot.innerHTML = `
      <style>
        ${TYPE}${TIMING}
        :host { display:block; position:absolute; bottom:8cqw; ${side === 'right' ? 'right:6cqw' : 'left:6cqw'};
                --rise:0px; --dur:var(--duration-base, 400ms); }
        .card { display:flex; align-items:stretch; gap:1cqw;
                /*
                 * Translucent by default, and overridable — because a renderer
                 * that punches its holes with a colour key cannot see through it.
                 *
                 * The split renderer strips each <video> and fills its box with a
                 * key colour, so in a full-frame assembly the whole frame behind
                 * this plate is key magenta. At 88% the plate blends with it and
                 * comes out purple, and ffmpeg keys only pure magenta, so the
                 * blend survives into the render. Set --card-fill to an opaque
                 * colour where that matters; the blur stays either way.
                 */
                background:var(--card-fill, color-mix(in srgb, var(--surface) 88%, transparent));
                border:1px solid var(--line); border-radius:.7cqw;
                padding:.9cqw 1.4cqw .9cqw 1.1cqw; backdrop-filter:blur(8px);
                /*
                 * No drop shadow. The plate has a border and an opaque-enough
                 * fill; a shadow under it only muddied the footage, and a
                 * translucent black is also the one thing the split renderer
                 * cannot composite — over its key colour it comes out purple.
                 * --card-shadow puts one back where a scene wants it.
                 */
                box-shadow:var(--card-shadow, none); }
        .bar { width:.24cqw; border-radius:.2cqw; background:var(--brand-text); flex:0 0 auto; }
        .n { font-size:1.95cqw; font-weight:700; letter-spacing:-.02em; color:var(--fg); line-height:1.2;  }
        .s { font-family:var(--mono); font-size:1.45cqw; color:var(--muted); margin-top:.18cqw; }
        /* Slides in rather than rising — reads as a reveal, and stays legible
           over busy footage. Uses the same registered properties so it still
           composes with the exit animation.
           The card carries the anim class: this rule existed but nothing wore
           it, so the plate never animated and never left. Its "for" did nothing
           and a lower third stayed on screen for the rest of the composition. */
        .anim { transform: translateX(calc(var(--rm-in-y) + var(--rm-out-y))); }
        :host { --rise: -22px; }
      </style>
      <div class="card anim">
        <div class="bar"></div>
        <div>
          <div class="n">${this.esc(this.attr('name', 'Name'))}</div>
          ${this.attr('sub') ? `<div class="s">${this.esc(this.attr('sub'))}</div>` : ''}
        </div>
      </div>`
  }
}
define('rm-lower-third', RMLowerThird)

/* ── rm-callout ──────────────────────────────────────────────────────────── */

/** A pointer at a spot in the frame. `x`/`y` are percentages of the stage. */
class RMCallout extends RMElement {
  static fields = ['text', 'x', 'y', 'side', 'at', 'for']
  render() {
    const x = Number(this.attr('x', 50))
    const y = Number(this.attr('y', 50))
    const side = this.attr('side', 'right')
    this.shadowRoot.innerHTML = `
      <style>
        ${TYPE}${TIMING}
        :host { display:block; position:absolute; left:${x}%; top:${y}%; --rise:0px; --dur:var(--duration-fast, 200ms);
                --ease:var(--ease-emphasis, cubic-bezier(0.34, 1.4, 0.64, 1)); }
        .row { display:flex; align-items:center; gap:.7cqw;
               flex-direction:${side === 'left' ? 'row-reverse' : 'row'}; }
        .pin { width:1.5cqw; height:1.5cqw; border-radius:50%; flex:0 0 auto;
               background:var(--brand); box-shadow:0 0 0 .45cqw color-mix(in srgb, var(--brand) 28%, transparent); }
        .txt { background:var(--brand); color:var(--on-brand); font-weight:650; font-size:1.15cqw;
               padding:.5cqw 1cqw; border-radius:.5cqw; white-space:nowrap; }
        /* Pops rather than rises. --rm-in-s is registered as a number, so it
           interpolates smoothly instead of stepping. */
        :host { --rise: 0px; }
        .anim { transform: translate(${side === 'left' ? '-100%' : '0'}, -50%) scale(var(--rm-in-s)); }
        @keyframes rm-in { from { --rm-in-o: 0; --rm-in-s: .86; } to { --rm-in-o: 1; --rm-in-s: 1; } }
      </style>
      <div class="row anim"><span class="pin"></span><span class="txt">${this.esc(this.attr('text', 'Here'))}</span></div>`
  }
}
define('rm-callout', RMCallout)

/* ── rm-image ────────────────────────────────────────────────────────────── */

/**
 * One of the brand pictures, placed on the stage.
 *
 * The component set could draw a browser, a title, a callout, a stat and a list,
 * and had no way to put a picture on screen — so the clay renders sitting in
 * brand/imagery/ could be admired in the Brand panel and used in nothing.
 *
 * `src` is a NAME by default: "academy-rocket.png", resolved against the scene's
 * `assets` base. That is the wallpaper's lesson repeated — a caller-supplied path
 * is correct for a render out of components/ and 404s in a preview served from a
 * different URL, and the one place that knows the difference is the harness. A
 * value containing a slash is passed through untouched, so an author can still
 * point at something of their own.
 *
 * Sized by width alone, in cqw, so it scales with the stage exactly like the type
 * does; the height follows the picture's own ratio rather than being stated twice
 * and getting to disagree.
 */
class RMImage extends RMElement {
  static fields = ['src', 'x', 'y', 'w', 'fit', 'alt', 'at', 'for']
  render() {
    const x = Number(this.attr('x', 50))
    const y = Number(this.attr('y', 50))
    const w = Number(this.attr('w', 30))
    const raw = this.attr('src')
    // A name resolves against the stage's base; a path is the author's business.
    const src = assetUrl(this, raw)
    this.shadowRoot.innerHTML = `
      <style>
        ${TYPE}${TIMING}
        :host { display:block; position:absolute; left:${x}%; top:${y}%; width:${w}cqw;
                --rise:1.2cqw; --dur:var(--duration-slow, 520ms);
                --ease:var(--ease-emphasis, cubic-bezier(0.34, 1.4, 0.64, 1)); }
        .anim { transform: translate(-50%, calc(-50% + var(--rise) * (1 - var(--rm-in-o)))); }
        img { display:block; width:100%; height:auto; object-fit:${this.attr('fit', 'contain')}; }
      </style>
      <div class="anim"><img src="${this.esc(src)}" alt="${this.esc(this.attr('alt', ''))}" /></div>`
  }
}
define('rm-image', RMImage)

/* ── rm-shader ───────────────────────────────────────────────────────────── */

/*
 * The RoleModel halftone field, made for a seekable scene.
 *
 * The brand-site version advances on requestAnimationFrame. A video renderer
 * cannot use wall-clock time: the same 2400ms frame must always be the same, so
 * this one draws only when RM.seek() changes the scene time or the canvas resizes.
 */
/*
 * Where the marks are, and which one a component asked for.
 *
 * One base rather than one URL per mark: staging rewrites this single string
 * when it copies the runtime into a composition — the marks land flat in
 * assets/brand/ rather than under a logos/ folder — and a URL built any other
 * way would survive that rewrite pointing at nothing.
 *
 * `mark` used to be on/off and always drew the standard icon, so there was no
 * way to put the RoleModel R on a card. It now takes a mark's name; on still
 * means the default, off still means none.
 */
const LOGO_BASE = '../brand/logos/'
const markUrl = (name) => new URL(`${LOGO_BASE}${name}.svg`, import.meta.url).href
const SHADER_ICON = markUrl('standard-icon')
const SHADER_VERTEX = 'attribute vec2 p;varying vec2 v;void main(){v=p*.5+.5;gl_Position=vec4(p,0.,1.);}'
const SHADER_FRAGMENT = [
  'precision highp float;uniform vec2 r;uniform float d;uniform float t;uniform float density;uniform float gamma;uniform float black;uniform float white;uniform float imageAspect;uniform sampler2D imageTex;uniform vec3 paper;uniform vec3 ink;varying vec2 v;',
  'float b2(vec2 p){vec2 q=mod(p,2.);if(q.y<1.)return q.x<1.?0.:2.;return q.x<1.?3.:1.;}',
  'float b4(vec2 p){return 4.*b2(mod(p,2.))+b2(floor(p/2.));}float b8(vec2 p){return 4.*b4(mod(p,4.))+b2(floor(p/4.));}',
  'vec2 coverUV(vec2 uv){float canvasAspect=r.x/r.y;vec2 s=canvasAspect>imageAspect?vec2(1.,imageAspect/canvasAspect):vec2(canvasAspect/imageAspect,1.);return(uv-.5)*s+.5;}',
  'void main(){vec2 px=floor(gl_FragCoord.xy/d);vec2 drift=vec2(sin(t*.8),cos(t*.6))*.012;vec4 sample=texture2D(imageTex,coverUV(v+drift));vec3 photo=mix(vec3(1.),sample.rgb,sample.a);float luma=dot(photo,vec3(.299,.587,.114));float level=clamp((1.-luma-black)/max(.001,white-black),0.,1.);float coverage=clamp(pow(level,gamma)*density,0.,1.);float threshold=1.-b8(mod(px,8.))/64.;gl_FragColor=vec4(mix(paper,ink,step(threshold,coverage)),1.);}',
].join('')
const SHADER_HEX = /^#(?:[\da-f]{3}|[\da-f]{6})$/i
const shaderClamp = (value, min, max) => Math.min(max, Math.max(min, value))
const shaderColour = (value, fallback) => (SHADER_HEX.test(value) || String(value).startsWith('var(') ? value : fallback)
const shaderVector = (root, colour, fallback) => {
  const swatch = document.createElement('i')
  swatch.style.color = colour
  root.append(swatch)
  const parts = getComputedStyle(swatch).color.match(/\d+(?:\.\d+)?/g)
  swatch.remove()
  if (!parts || parts.length < 3) return fallback
  return parts.slice(0, 3).map((part) => Number(part) / 255)
}
const compileShader = (gl, type, source) => {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader
  gl.deleteShader(shader)
  return null
}

class RMShader extends RMElement {
  static fields = ['title', 'subtitle', 'image', 'overlay', 'mark', 'ink', 'paper', 'theme', 'accent', 'density', 'dot', 'black', 'white', 'gamma', 'motion', 'at', 'for']

  disconnectedCallback() {
    this._dispose?.()
    this._dispose = null
  }

  render() {
    this._dispose?.()
    const dark = this.attr('theme', 'dark') === 'dark'
    const density = shaderClamp(Number(this.attr('density', 1)) || 1, 0.4, 2.2)
    const dot = shaderClamp(Number(this.attr('dot', 2)) || 2, 1, 12)
    const black = shaderClamp(Number(this.attr('black', 0.02)) || 0, 0, 0.4)
    const white = shaderClamp(Number(this.attr('white', 0.58)) || 0.58, 0.2, 1)
    const gamma = shaderClamp(Number(this.attr('gamma', 0.9)) || 0.9, 0.3, 2)
    const drifting = this.attr('motion', 'still') === 'drift'
    const background = dark ? 'var(--op-color-neutral-plus-max, #242424)' : 'var(--op-color-neutral-minus-max, #ffffff)'
    const dots = dark ? 'var(--op-color-neutral-minus-seven, #caccce)' : 'var(--op-color-neutral-plus-seven, #333333)'
    const text = dark ? 'var(--op-color-neutral-minus-max, #ffffff)' : 'var(--op-color-neutral-plus-max, #242424)'
    const shaderInk = shaderColour(this.attr('ink') || this.attr('accent'), 'var(--brand, var(--op-color-primary-base, #3a70b3))')
    const paper = shaderColour(this.attr('paper'), background)
    const title = this.esc(this.attr('title'))
    const subtitle = this.attr('subtitle')
    const showOverlay = this.attr('overlay', 'on') === 'on'
    /* on → the default mark, off → none, anything else → that mark by name.
       A name that is not staged draws nothing rather than a broken image,
       because the mark is a CSS mask. */
    const markName = this.attr('mark', 'off')
    const showMark = showOverlay && markName !== 'off' && markName !== ''
    const markSrc = markName === 'on' ? SHADER_ICON : markUrl(markName)
    const rawImage = this.attr('image')
    const imageSource = assetUrl(this, rawImage)
    const hasImage = Boolean(imageSource)
    const lockup = showOverlay
      ? `<div class="lockup">${showMark ? '<i class="mark anim" aria-hidden="true"></i>' : ''}${title ? `<h2 class="anim">${title}</h2>` : ''}${subtitle ? `<p class="anim">${this.esc(subtitle)}</p>` : ''}</div>`
      : ''
    this.shadowRoot.innerHTML = `<style>${TYPE}${TIMING}:host{position:absolute;display:block;inset:0;width:100%;height:100%;}.asset{position:absolute;inset:0;overflow:hidden;background:${background};}.asset canvas{position:absolute;inset:0;width:100%;height:100%;display:block;}.lockup{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1.35cqw;padding:8cqw;color:${text};text-align:center;}.mark{inline-size:8cqw;block-size:8cqw;background:${shaderInk};mask:url(${markSrc}) center/contain no-repeat;-webkit-mask:url(${markSrc}) center/contain no-repeat;}.lockup h2{margin:0;font-size:6.4cqw;font-weight:800;letter-spacing:-.045em;line-height:.9;}.lockup p{margin:0;max-inline-size:34ch;font-size:1.45cqw;font-weight:650;line-height:1.35;color:${dots};}/* The mark, the title and the line under it arrive in reading order, a beat apart — the same rhythm as rm-title and the shared lockup. This one has its own type rather than the shared constant, so it needs its own leads; without them the whole card faded in as a block and the words simply appeared. */.lockup .mark{--lead:0ms;}.lockup h2{--lead:120ms;}.lockup p{--lead:240ms;}.empty{position:absolute;inset:0;display:grid;place-items:center;padding:3cqw;color:${dots};font-size:1.15cqw;font-weight:650;text-align:center;}.empty span{padding:.7em 1em;border:1px dashed currentColor;border-radius:999px;}</style><div class="asset anim">${
      hasImage ? `<canvas aria-hidden="true"></canvas>${lockup}` : '<div class="empty"><span>Choose or upload an image to make a halftone</span></div>'
    }</div>`

    const canvas = this.shadowRoot.querySelector('canvas')
    if (!canvas) return
    const gl = canvas.getContext('webgl', { alpha: false, antialias: false })
    const vertex = gl && compileShader(gl, gl.VERTEX_SHADER, SHADER_VERTEX)
    const fragment = gl && compileShader(gl, gl.FRAGMENT_SHADER, SHADER_FRAGMENT)
    const program = gl?.createProgram()
    if (!(gl && vertex && fragment && program)) return
    gl.attachShader(program, vertex)
    gl.attachShader(program, fragment)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return
    gl.useProgram(program)

    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW)
    const position = gl.getAttribLocation(program, 'p')
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
    const uniform = (name) => gl.getUniformLocation(program, name)
    const resolution = uniform('r')
    const time = uniform('t')
    const dotSize = uniform('d')
    const aspect = uniform('imageAspect')
    gl.uniform1f(uniform('density'), density)
    gl.uniform1f(uniform('gamma'), gamma)
    gl.uniform1f(uniform('black'), black)
    gl.uniform1f(uniform('white'), white)
    gl.uniform3fv(uniform('paper'), shaderVector(this.shadowRoot, paper, dark ? [0.14, 0.14, 0.14] : [1, 1, 1]))
    gl.uniform3fv(uniform('ink'), shaderVector(this.shadowRoot, shaderInk, dark ? [0.23, 0.44, 0.7] : [0.23, 0.44, 0.7]))

    const texture = gl.createTexture()
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    for (const [key, value] of [[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR]]) gl.texParameteri(gl.TEXTURE_2D, key, value)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]))
    gl.uniform1i(uniform('imageTex'), 0)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)

    const draw = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5)
      const width = Math.max(1, Math.round(canvas.clientWidth * ratio))
      const height = Math.max(1, Math.round(canvas.clientHeight * ratio))
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
        gl.viewport(0, 0, width, height)
      }
      gl.uniform2f(resolution, canvas.width, canvas.height)
      gl.uniform1f(dotSize, dot * (canvas.width / Math.max(1, canvas.clientWidth)))
      gl.uniform1f(time, drifting ? RM.t / 1000 : 0)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
    }
    const observer = new ResizeObserver(draw)
    const onSeek = () => draw()
    observer.observe(canvas)
    root.addEventListener('rmseek', onSeek)
    let settleTexture
    RM.waitFor(new Promise((resolve) => (settleTexture = resolve)))
    const image = new Image()
    image.onload = () => {
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)
      gl.uniform1f(aspect, image.naturalWidth / Math.max(1, image.naturalHeight))
      draw()
      settleTexture()
    }
    image.onerror = () => settleTexture()
    image.src = imageSource
    draw()
    this._dispose = () => {
      observer.disconnect()
      root.removeEventListener('rmseek', onSeek)
      settleTexture()
      gl.deleteTexture(texture)
      gl.deleteBuffer(buffer)
      gl.deleteProgram(program)
      gl.deleteShader(vertex)
      gl.deleteShader(fragment)
    }
  }
}
define('rm-shader', RMShader)

/* ── rm-pixel-reveal ─────────────────────────────────────────────────────── */

/*
 * A pixel-and-print treatment for brand scenes.
 *
 * The original treatment is a Framer component made from a ChromaFlow texture,
 * a pixel grid, a halftone overlay, and an optional duotone. Those are useful
 * visual ingredients, but a React component loaded from a CDN cannot be a scene
 * asset: previews and HyperFrames renders need to work with no network and at a
 * deterministic point in time. This is the same treatment expressed as one
 * seekable WebGL pass. `RM.seek()` is the only clock it reads.
 *
 * It carries the same optional lockup as rm-shader — mark, title, subtitle —
 * because a closing card IS this treatment plus three lines, and pairing it
 * with a separate rm-title made the words a second clip that every consumer
 * (the timeline above all) had to know to keep on screen with it. No title
 * asked for, no lockup drawn: as a plain background it is unchanged.
 */
const PIXEL_REVEAL_FRAGMENT = [
  'precision highp float;uniform vec2 r;uniform float t;uniform float imageAspect;uniform float imageScale;uniform vec2 imageOffset;uniform sampler2D imageTex;uniform float pixelDensity;uniform float pixelGap;uniform float pixelRoundness;uniform float halftoneFrequency;uniform float colorFringing;uniform float flowIntensity;uniform float showDuotone;uniform vec3 paper;uniform vec3 cyanInk;uniform vec3 magentaInk;uniform vec3 yellowInk;uniform vec3 blackInk;uniform vec3 colorA;uniform vec3 colorB;varying vec2 v;',
  'vec2 coverUV(vec2 uv){float canvasAspect=r.x/r.y;vec2 s=canvasAspect>imageAspect?vec2(1.,imageAspect/canvasAspect):vec2(canvasAspect/imageAspect,1.);return(uv-.5)*s/max(.05,imageScale)+.5+imageOffset;}',
  'float roundedCell(vec2 p,float gap,float roundness){vec2 halfSize=vec2(.5-gap*.5);vec2 q=abs(p-.5)-halfSize;float radius=min(min(halfSize.x,halfSize.y),roundness*.5);float distance=length(max(q,0.))-radius;return 1.-smoothstep(0.,.035,distance);}',
  'vec3 printColour(vec3 photo,float luma){vec3 printed=paper;printed=mix(printed,cyanInk,(1.-photo.r)*.72);printed=mix(printed,magentaInk,(1.-photo.g)*.62);printed=mix(printed,yellowInk,(1.-photo.b)*.46);printed=mix(printed,blackInk,(1.-luma)*.54);return printed;}',
  'void main(){float size=max(3.,pixelDensity);vec2 pixel=gl_FragCoord.xy;vec2 cell=floor(pixel/size);vec2 local=fract(pixel/size);vec2 centre=(cell+.5)*size/r;float motion=t*.001;vec2 flow=vec2(sin(motion+centre.y*8.),cos(motion*.8+centre.x*7.))*flowIntensity*.009;float fringe=colorFringing/max(r.x,r.y);vec2 offset=vec2(fringe,fringe*.45);float red=texture2D(imageTex,coverUV(centre+flow+offset)).r;float green=texture2D(imageTex,coverUV(centre+flow)).g;float blue=texture2D(imageTex,coverUV(centre+flow-offset)).b;vec3 photo=vec3(red,green,blue);float luma=dot(photo,vec3(.299,.587,.114));vec3 colour=printColour(photo,luma);vec3 duo=mix(colorB,colorA,luma);colour=mix(colour,duo,showDuotone);float screen=(sin((cell.x+cell.y)*halftoneFrequency*.35)*.5+.5)*(1.-luma)*.2;colour=mix(colour,blackInk,screen);float shape=roundedCell(local,pixelGap,pixelRoundness);gl_FragColor=vec4(mix(paper,colour,shape),1.);}',
].join('')

class RMPixelReveal extends RMElement {
  static fields = [
    'title',
    'subtitle',
    'mark',
    'overlay',
    'image',
    'image-scale',
    'image-x',
    'image-y',
    'pixel-density',
    'pixel-gap',
    'pixel-roundness',
    'halftone-frequency',
    'border-color',
    'border-radius',
    'show-duotone',
    'color-a',
    'color-b',
    'paper',
    'cyan-ink',
    'magenta-ink',
    'yellow-ink',
    'black-ink',
    'color-fringing',
    'flow-intensity',
    'flow',
    'flow-beats',
    'flow-step',
    'at',
    'for',
  ]

  disconnectedCallback() {
    this._dispose?.()
    this._dispose = null
  }

  render() {
    this._dispose?.()
    const dark = this.closest('rm-scene')?.getAttribute('theme') !== 'light'
    const pixelDensity = shaderClamp(Number(this.attr('pixel-density', 20)) || 20, 3, 64)
    const pixelGap = shaderClamp(Number(this.attr('pixel-gap', 0.12)) || 0, 0, 0.9)
    const pixelRoundness = shaderClamp(Number(this.attr('pixel-roundness', 0.7)) || 0, 0, 1)
    const halftoneFrequency = shaderClamp(Number(this.attr('halftone-frequency', 0.75)) || 0, 0, 3)
    const borderRadius = shaderClamp(Number(this.attr('border-radius', 0)) || 0, 0, 12)
    const colorFringing = shaderClamp(Number(this.attr('color-fringing', 0.6)) || 0, 0, 3)
    const flowIntensity = shaderClamp(Number(this.attr('flow-intensity', 1.5)) || 0, 0, 3.5)
    const flowing = this.attr('flow', 'still') === 'flow'
    /*
     * The background leads the cut.
     *
     * `flow-beats` is a list of seconds — the composition's clip boundaries —
     * and `flow-step` how far the field jumps at each one. The jump lands 100ms
     * BEFORE the boundary, so the eye is told a change is coming a beat before
     * the picture changes, and the edit reads as intended rather than abrupt.
     * (HeyGen's inspector-launch study: "the halftone should make a major shift
     * about 0.1s before each scene transition begins".) The assembly exporter
     * fills the list from the cut; a scene can hand-write it.
     */
    const flowBeats = this.attr('flow-beats', '').split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b)
    /* Half the field's period (sin over t*.001 repeats every ~6.28s), so a step
       is the largest change the shader can make. Measured: a 900ms step barely
       read in a render; this one does, without being a flash. */
    const flowStep = Math.max(0, Number(this.attr('flow-step', 3100)) || 0)
    const FLOW_LEAD_MS = 100
    const flowTime = (ms) => ms + flowBeats.filter((beat) => beat * 1000 - FLOW_LEAD_MS <= ms).length * flowStep
    const background = dark ? 'var(--op-color-neutral-plus-max, #242424)' : 'var(--op-color-neutral-minus-max, #ffffff)'
    const border = shaderColour(this.attr('border-color'), 'var(--op-color-neutral-plus-four, #424242)')
    const paper = shaderColour(this.attr('paper'), background)
    const cyanInk = shaderColour(this.attr('cyan-ink'), 'var(--op-color-primary-base, #3a70b3)')
    const magentaInk = shaderColour(this.attr('magenta-ink'), 'var(--op-color-tertiary-base, #7b5ea7)')
    const yellowInk = shaderColour(this.attr('yellow-ink'), 'var(--op-color-secondary-base, #d4b30a)')
    const blackInk = shaderColour(this.attr('black-ink'), 'var(--op-color-neutral-plus-max, #242424)')
    const colorA = shaderColour(this.attr('color-a'), 'var(--brand, var(--op-color-primary-base, #3a70b3))')
    const colorB = shaderColour(this.attr('color-b'), background)
    const showDuotone = this.attr('show-duotone', 'off') === 'on'
    const rawImage = this.attr('image')
    const imageSource = assetUrl(this, rawImage)
    const hasImage = Boolean(imageSource)
    const stroke = `${borderRadius ? '.12cqw solid ' : '0 solid '}${border}`
    /* The lockup, word for word the rm-shader arrangement: mark, title, line —
       reading order, a beat apart. The mark takes the treatment's accent so the
       two cannot disagree about what the brand colour is. */
    const text = dark ? 'var(--op-color-neutral-minus-max, #ffffff)' : 'var(--op-color-neutral-plus-max, #242424)'
    const dots = dark ? 'var(--op-color-neutral-minus-seven, #caccce)' : 'var(--op-color-neutral-plus-seven, #333333)'
    const title = this.esc(this.attr('title'))
    const subtitle = this.attr('subtitle')
    const showOverlay = this.attr('overlay', 'on') === 'on'
    const markName = this.attr('mark', 'off')
    const showMark = showOverlay && markName !== 'off' && markName !== ''
    const markSrc = markName === 'on' ? SHADER_ICON : markUrl(markName)
    const lockup = showOverlay && (title || subtitle || showMark)
      ? `<div class="lockup">${showMark ? '<i class="mark anim" aria-hidden="true"></i>' : ''}${title ? `<h2 class="anim">${title}</h2>` : ''}${subtitle ? `<p class="anim">${this.esc(subtitle)}</p>` : ''}</div>`
      : ''
    this.shadowRoot.innerHTML = `<style>${TYPE}${TIMING}:host{position:absolute;display:block;inset:0;width:100%;height:100%;}.asset{position:absolute;inset:0;overflow:hidden;background:${paper};border:${stroke};border-radius:${borderRadius}cqw;}.asset canvas{position:absolute;inset:0;width:100%;height:100%;display:block;}.lockup{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1.35cqw;padding:8cqw;color:${text};text-align:center;}.mark{inline-size:8cqw;block-size:8cqw;background:${colorA};mask:url(${markSrc}) center/contain no-repeat;-webkit-mask:url(${markSrc}) center/contain no-repeat;}.lockup h2{margin:0;font-size:6.4cqw;font-weight:800;letter-spacing:-.045em;line-height:.9;}.lockup p{margin:0;max-inline-size:34ch;font-size:1.45cqw;font-weight:650;line-height:1.35;color:${dots};}.lockup .mark{--lead:0ms;}.lockup h2{--lead:120ms;}.lockup p{--lead:240ms;}.empty{position:absolute;inset:0;display:grid;place-items:center;padding:3cqw;color:var(--op-color-neutral-minus-seven, #caccce);font-size:1.15cqw;font-weight:650;text-align:center;}.empty span{padding:.7em 1em;border:1px dashed currentColor;border-radius:999px;}</style><div class="asset anim">${
      hasImage ? `<canvas aria-hidden="true"></canvas>${lockup}` : '<div class="empty"><span>Choose or upload an image to make a pixel reveal</span></div>'
    }</div>`

    const canvas = this.shadowRoot.querySelector('canvas')
    if (!canvas) return
    const gl = canvas.getContext('webgl', { alpha: false, antialias: false })
    const vertex = gl && compileShader(gl, gl.VERTEX_SHADER, SHADER_VERTEX)
    const fragment = gl && compileShader(gl, gl.FRAGMENT_SHADER, PIXEL_REVEAL_FRAGMENT)
    const program = gl?.createProgram()
    if (!(gl && vertex && fragment && program)) return
    gl.attachShader(program, vertex)
    gl.attachShader(program, fragment)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return
    gl.useProgram(program)

    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW)
    const position = gl.getAttribLocation(program, 'p')
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
    const uniform = (name) => gl.getUniformLocation(program, name)
    const resolution = uniform('r')
    const time = uniform('t')
    const aspect = uniform('imageAspect')
    gl.uniform1f(uniform('pixelDensity'), pixelDensity)
    gl.uniform1f(uniform('pixelGap'), pixelGap)
    gl.uniform1f(uniform('pixelRoundness'), pixelRoundness)
    gl.uniform1f(uniform('halftoneFrequency'), halftoneFrequency)
    gl.uniform1f(uniform('colorFringing'), colorFringing)
    gl.uniform1f(uniform('flowIntensity'), flowIntensity)
    gl.uniform1f(uniform('showDuotone'), showDuotone ? 1 : 0)
    /*
     * How much of the picture the frame shows, and where.
     *
     * coverUV filled the frame and nothing else, so a photograph arrived at
     * whatever crop its own proportions gave it — usually far too close, with no
     * way to pull back. Scale is that crop: 1 is cover, below it shows more of
     * the picture, above it moves in. Offset then slides the visible window,
     * which only means anything once there is something outside it.
     */
    gl.uniform1f(uniform('imageScale'), shaderClamp(Number(this.attr('image-scale', 1)), 0.1, 6))
    gl.uniform2f(
      uniform('imageOffset'),
      shaderClamp(Number(this.attr('image-x', 0)), -1, 1),
      shaderClamp(Number(this.attr('image-y', 0)), -1, 1),
    )
    gl.uniform3fv(uniform('paper'), shaderVector(this.shadowRoot, paper, dark ? [0.14, 0.14, 0.14] : [1, 1, 1]))
    gl.uniform3fv(uniform('cyanInk'), shaderVector(this.shadowRoot, cyanInk, [0.23, 0.44, 0.7]))
    gl.uniform3fv(uniform('magentaInk'), shaderVector(this.shadowRoot, magentaInk, [0.48, 0.37, 0.65]))
    gl.uniform3fv(uniform('yellowInk'), shaderVector(this.shadowRoot, yellowInk, [0.83, 0.7, 0.04]))
    gl.uniform3fv(uniform('blackInk'), shaderVector(this.shadowRoot, blackInk, [0.14, 0.14, 0.14]))
    gl.uniform3fv(uniform('colorA'), shaderVector(this.shadowRoot, colorA, [0.23, 0.44, 0.7]))
    gl.uniform3fv(uniform('colorB'), shaderVector(this.shadowRoot, colorB, dark ? [0.14, 0.14, 0.14] : [1, 1, 1]))

    const texture = gl.createTexture()
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    for (const [key, value] of [[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR]]) gl.texParameteri(gl.TEXTURE_2D, key, value)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]))
    gl.uniform1i(uniform('imageTex'), 0)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)

    const draw = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5)
      const width = Math.max(1, Math.round(canvas.clientWidth * ratio))
      const height = Math.max(1, Math.round(canvas.clientHeight * ratio))
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
        gl.viewport(0, 0, width, height)
      }
      gl.uniform2f(resolution, canvas.width, canvas.height)
      gl.uniform1f(time, flowing ? flowTime(RM.t) : 0)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
    }
    const observer = new ResizeObserver(draw)
    const onSeek = () => draw()
    observer.observe(canvas)
    root.addEventListener('rmseek', onSeek)
    let settleTexture
    RM.waitFor(new Promise((resolve) => (settleTexture = resolve)))
    const image = new Image()
    image.onload = () => {
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)
      gl.uniform1f(aspect, image.naturalWidth / Math.max(1, image.naturalHeight))
      draw()
      settleTexture()
    }
    image.onerror = () => settleTexture()
    image.src = imageSource
    draw()
    this._dispose = () => {
      observer.disconnect()
      root.removeEventListener('rmseek', onSeek)
      settleTexture()
      gl.deleteTexture(texture)
      gl.deleteBuffer(buffer)
      gl.deleteProgram(program)
      gl.deleteShader(vertex)
      gl.deleteShader(fragment)
    }
  }
}
define('rm-pixel-reveal', RMPixelReveal)

/*
 * One lockup, for every component that carries copy over a full-frame treatment.
 *
 * The field had these rules to itself and the haze needed the same three lines
 * in the same places — a second copy would be two typographic scales drifting
 * apart, which is the failure nobody notices until two backgrounds are cut
 * together. The colours come from --paper-ink, which each host defines from the
 * brand token, so the block itself names nothing.
 */
const LOCKUP = `
  /*
   * Type over the field, positioned as a percentage of the frame and sized in
   * cqw, so a lockup keeps its place and its proportion at any render width.
   * All three lines are optional: with none of them this is a background.
   */
  /* x is the anchor, and which edge it anchors follows the alignment. Always
     centring the block meant a left-aligned lockup moved toward the left edge
     ran half its width off the frame. */
  .lockup { position:absolute; left:var(--x, 50%); top:var(--y, 50%); width:78%;
            transform:translate(var(--tx, -50%), -50%); display:grid; gap:.5em;
            justify-items:var(--just, center); text-align:var(--align, center); }
  .eyebrow { color:color-mix(in srgb, var(--paper-ink) 74%, transparent);
             font-family:var(--mono); font-size:calc(var(--size, 6.6cqw) * 0.2);
             letter-spacing:.16em; text-transform:uppercase; }
  .title { color:var(--paper-ink); font-size:var(--size, 6.6cqw); font-weight:700;
           line-height:.92; letter-spacing:-.03em;}
  .body { color:color-mix(in srgb, var(--paper-ink) 82%, transparent);
          font-size:calc(var(--size, 6.6cqw) * 0.26); line-height:1.4; max-width:94ch; }

  /*
   * The lines arrive in reading order, a beat apart.
   *
   * rm-title has staggered its four lines since it was written; every component
   * built on this lockup — the field, the shader — faded its whole card in as
   * one block and the type simply appeared. Same motion, same curve, same
   * rhythm as rm-title: one thing staggered rather than two components
   * disagreeing about how type arrives.
   *
   * The card still fades as a whole, because the ground it sits on is animated
   * by the wrapper. These leads sit on top of that, which is what makes an
   * eyebrow land before its title rather than with it.
   */
  .lockup .eyebrow { --lead: 0ms; }
  .lockup .title   { --lead: 120ms; }
  .lockup .body    { --lead: 240ms; }
`

/*
 * The field's colours arrive as attributes so they can be driven from the
 * timeline. Written onto the host as custom properties rather than interpolated
 * into the stylesheet, so the shadow CSS stays one shared constant.
 */
const fieldStyle = (el) => {
  const set = (name, value) => (value ? `${name}:${value};` : '')
  const align = el.attr('align', 'center')
  return set('--x', el.attr('x') ? `${el.attr('x')}%` : '')
    + set('--y', el.attr('y') ? `${el.attr('y')}%` : '')
    + set('--size', el.attr('size') ? `${el.attr('size')}cqw` : '')
    + set('--align', align)
    + set('--just', align === 'center' ? 'center' : align === 'right' ? 'end' : 'start')
    + set('--tx', align === 'center' ? '-50%' : align === 'right' ? '-100%' : '0%')
    + set('--ground', el.attr('ground'))
    + set('--paper-ink', el.attr('paper'))
    + set('--green', el.attr('green'))
    + set('--cyan', el.attr('cyan'))
    + set('--amber', el.attr('amber'))
}

/* ── rm-haze ─────────────────────────────────────────────────────────────── */

/*
 * A swirling, dithered gradient field — the "pixel haze" treatment.
 *
 * Ported from a Framer component that composes five nodes from the `shaders`
 * package: Swirl, Dither, GridDistortion, Sharpness, FilmGrain. That stack
 * cannot be a scene asset for the same two reasons rm-pixel-reveal could not —
 * it is React loaded from a CDN, and it advances on wall-clock time. A render
 * has no network and must produce the same pixels for the same instant every
 * time it is asked.
 *
 * So it is one fragment shader, and `RM.seek()` is the only clock it reads.
 * The node order is preserved by construction rather than by passes: a warp of
 * a composed image is the composition evaluated at warped coordinates, so the
 * grid distortion is applied to the coordinates the swirl and the dither are
 * read at, which is why the dither grid bends with the field instead of sitting
 * flat on top of it. Grain is added last, in screen space, because it is film
 * on the lens rather than paint on the subject.
 *
 * Sharpness is local contrast on the swirl field, not an unsharp mask of the
 * finished frame — sharpening the composite would mean evaluating the whole
 * chain four more times per pixel. It reads the same on a gradient, which is
 * the only thing this draws.
 */
const HAZE_FRAGMENT = [
  'precision highp float;uniform vec2 r;uniform float t;uniform vec3 shadowColour;uniform vec3 highlightColour;uniform vec3 ditherColour;uniform float flowSpeed;uniform float swirlDetail;uniform float colourBalance;uniform float ditherAmount;uniform float ditherPixel;uniform float distortStrength;uniform float distortDetail;uniform float sharpness;uniform float grain;uniform float hasImage;uniform float imageBlend;uniform float imageAspect;uniform sampler2D imageTex;varying vec2 v;',
  'float h21(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453123);}',
  'float vnoise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);float a=h21(i),b=h21(i+vec2(1.,0.)),c=h21(i+vec2(0.,1.)),d=h21(i+vec2(1.,1.));return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);}',
  'float fbm(vec2 p){float s=0.,a=.5;for(int i=0;i<5;i++){s+=a*vnoise(p);p*=2.02;a*=.5;}return s;}',
  // The swirl: polar coordinates rotated more the closer to the centre they are,
  // then noise read through that rotation. Two octaves of it, drifting apart.
  'float swirlField(vec2 uv){vec2 q=uv-.5;q.x*=r.x/max(1.,r.y);float rad=length(q);float ang=atan(q.y,q.x);ang+=(1.5-rad*1.2)*(.9+swirlDetail)+t*flowSpeed*.35;vec2 p=vec2(cos(ang),sin(ang))*rad;float n=fbm(p*(1.2+swirlDetail*2.5)+vec2(t*flowSpeed*.12,-t*flowSpeed*.08));n=mix(n,fbm(p*(3.+swirlDetail*4.)-vec2(t*flowSpeed*.2)),.35);return clamp(n,0.,1.);}',
  // HSL, because a gradient between a deep shadow and a warm highlight goes
  // through the hues between them rather than through mud, which is what the
  // Framer node meant by colorSpace="hsl".
  'vec3 rgb2hsl(vec3 c){float mx=max(max(c.r,c.g),c.b);float mn=min(min(c.r,c.g),c.b);float l=(mx+mn)*.5;float h=0.;float s=0.;float d=mx-mn;if(d>.0001){s=l>.5?d/max(.0001,2.-mx-mn):d/max(.0001,mx+mn);if(mx==c.r)h=(c.g-c.b)/d+(c.g<c.b?6.:0.);else if(mx==c.g)h=(c.b-c.r)/d+2.;else h=(c.r-c.g)/d+4.;h/=6.;}return vec3(h,s,l);}',
  'float hue2rgb(float p,float q,float x){if(x<0.)x+=1.;if(x>1.)x-=1.;if(x<1./6.)return p+(q-p)*6.*x;if(x<.5)return q;if(x<2./3.)return p+(q-p)*(2./3.-x)*6.;return p;}',
  'vec3 hsl2rgb(vec3 c){if(c.y<=.0001)return vec3(c.z);float q=c.z<.5?c.z*(1.+c.y):c.z+c.y-c.z*c.y;float p=2.*c.z-q;return vec3(hue2rgb(p,q,c.x+1./3.),hue2rgb(p,q,c.x),hue2rgb(p,q,c.x-1./3.));}',
  'vec3 mixHSL(vec3 a,vec3 b,float x){vec3 A=rgb2hsl(a);vec3 B=rgb2hsl(b);float dh=B.x-A.x;if(dh>.5)dh-=1.;if(dh<-.5)dh+=1.;return hsl2rgb(vec3(fract(A.x+dh*x),mix(A.y,B.y,x),mix(A.z,B.z,x)));}',
  // Mirrored edges, so a coordinate pushed outside the frame folds back in
  // rather than clamping to a smeared row of pixels.
  'vec2 distort(vec2 uv){if(distortStrength<=.001)return uv;vec2 cell=floor(uv*distortDetail);float n1=vnoise(cell+vec2(t*flowSpeed*.1,0.));float n2=vnoise(cell+vec2(0.,t*flowSpeed*.1)+31.4);uv+=(vec2(n1,n2)-.5)*(distortStrength/max(8.,distortDetail))*.9;uv=abs(mod(uv,2.));return min(uv,2.-uv);}',
  'float b2(vec2 p){vec2 q=mod(p,2.);if(q.y<1.)return q.x<1.?0.:2.;return q.x<1.?3.:1.;}',
  'float b4(vec2 p){return 4.*b2(mod(p,2.))+b2(floor(p/2.));}',
  'vec3 overlay(vec3 a,vec3 b){return mix(2.*a*b,1.-2.*(1.-a)*(1.-b),step(.5,a));}',
  // Cover, not stretch: a portrait in a 16:9 frame is cropped, never squashed.
  'vec2 coverUV(vec2 uv){float frame=r.x/max(1.,r.y);vec2 s=frame>imageAspect?vec2(1.,imageAspect/frame):vec2(frame/imageAspect,1.);return(uv-.5)*s+.5;}',
  'void main(){vec2 uv=distort(v);float n=swirlField(uv);if(sharpness>.001){float e=1./max(r.x,r.y);float around=(swirlField(uv+vec2(e,0.))+swirlField(uv-vec2(e,0.))+swirlField(uv+vec2(0.,e))+swirlField(uv-vec2(0.,e)))*.25;n=clamp(n+(n-around)*sharpness*2.,0.,1.);}float x=clamp((n-.5)*1.6+colourBalance,0.,1.);if(hasImage>.5){vec4 shot=texture2D(imageTex,coverUV(uv));float luma=dot(shot.rgb,vec3(.299,.587,.114));x=clamp(mix(x,luma,imageBlend),0.,1.);}vec3 col=mixHSL(shadowColour,highlightColour,x);if(ditherAmount>.001){vec2 px=floor(uv*r/max(1.,ditherPixel));float thr=(b4(mod(px,4.))+.5)/16.;float lum=dot(col,vec3(.299,.587,.114));vec3 pattern=mix(vec3(0.),ditherColour,step(thr,lum));col=mix(col,overlay(col,pattern),ditherAmount);}col+=(h21(gl_FragCoord.xy+fract(t)*vec2(37.7,17.3))-.5)*grain;gl_FragColor=vec4(clamp(col,0.,1.),1.);}',
].join('')

class RMHaze extends RMElement {
  static fields = [
    'image',
    'image-blend',
    'eyebrow',
    'title',
    'body',
    'size',
    'x',
    'y',
    'align',
    'gradient-shadow',
    'gradient-highlight',
    'flow-speed',
    'swirl-detail',
    'color-balance',
    'dither-amount',
    'dither-color',
    'dither-pixel',
    'distortion-strength',
    'distortion-detail',
    'sharpness',
    'film-grain',
    'flow',
    'at',
    'for',
  ]

  disconnectedCallback() {
    this._dispose?.()
    this._dispose = null
  }

  render() {
    this._dispose?.()
    // The Framer control ranges, kept: a value outside them is a mistake rather
    // than a style, and clamping says so quietly instead of drawing nothing.
    const flowSpeed = shaderClamp(Number(this.attr('flow-speed', 0.6)), 0, 5)
    const swirlDetail = shaderClamp(Number(this.attr('swirl-detail', 0.7)), 0, 5)
    const colourBalance = shaderClamp(Number(this.attr('color-balance', 58)), 0, 100) / 100
    const ditherAmount = shaderClamp(Number(this.attr('dither-amount', 0.45)), 0, 1)
    const ditherPixel = shaderClamp(Number(this.attr('dither-pixel', 4)), 1, 32)
    const distortStrength = shaderClamp(Number(this.attr('distortion-strength', 5)), 0, 5)
    const distortDetail = shaderClamp(Number(this.attr('distortion-detail', 75)), 8, 128)
    const sharpness = shaderClamp(Number(this.attr('sharpness', 1)), 0, 3)
    const grain = shaderClamp(Number(this.attr('film-grain', 0.05)), 0, 1)
    /* `flow`, the name rm-pixel-reveal already uses for exactly this, rather
       than `motion` — which on rm-shader means still|drift, and one attribute
       name offering two different sets of values in one editor is a trap. */
    const still = this.attr('flow', 'flow') === 'still'
    /*
     * A picture, optionally, read through the same gradient.
     *
     * Without one this draws its own swirl and nothing else. With one, the
     * picture's luminance takes over the position in the shadow-to-highlight
     * ramp, so a photograph comes through duotoned into the brand's colours
     * and the swirl keeps it moving underneath — and the dither, the
     * distortion and the grain then apply to the result, which is the whole
     * point of the treatment. `image-blend` is how much of the picture is in
     * that mix, so it can be dialled back to a suggestion.
     */
    const imageBlend = shaderClamp(Number(this.attr('image-blend', 0.75)), 0, 1)
    const rawImage = this.attr('image')
    const imageSource = assetUrl(this, rawImage)

    const shadowColour = shaderColour(this.attr('gradient-shadow'), 'var(--op-color-neutral-plus-max, #242424)')
    const highlightColour = shaderColour(this.attr('gradient-highlight'), 'var(--brand, var(--op-color-academy-primary-base, #00b871))')
    const ditherColour = shaderColour(this.attr('dither-color'), 'var(--op-color-neutral-minus-max, #ffffff)')

    /*
     * The same three lines, in the same places, as every other full-frame
     * treatment. LOCKUP is shared with the field rather than restated, so two
     * backgrounds cut together cannot carry two typographic scales.
     */
    const copy = this.attr('eyebrow') || this.attr('title') || this.attr('body')
      ? `<div class="lockup">${this.attr('eyebrow') ? `<div class="eyebrow anim">${this.esc(this.attr('eyebrow'))}</div>` : ''}${this.attr('title') ? `<div class="title anim">${this.esc(this.attr('title'))}</div>` : ''}${this.attr('body') ? `<div class="body anim">${this.esc(this.attr('body'))}</div>` : ''}</div>`
      : ''
    this.shadowRoot.innerHTML = `<style>${TYPE}${TIMING}:host{--paper-ink: var(--op-color-neutral-minus-max, #fff8e9);position:absolute;display:block;inset:0;width:100%;height:100%;}.asset{position:absolute;inset:0;overflow:hidden;background:${shadowColour};}.asset canvas{position:absolute;inset:0;width:100%;height:100%;display:block;}${LOCKUP}</style><div class="asset anim" style="${fieldStyle(this)}"><canvas aria-hidden="true"></canvas>${copy}</div>`

    const canvas = this.shadowRoot.querySelector('canvas')
    if (!canvas) return
    const gl = canvas.getContext('webgl', { alpha: false, antialias: false })
    const vertex = gl && compileShader(gl, gl.VERTEX_SHADER, SHADER_VERTEX)
    const fragment = gl && compileShader(gl, gl.FRAGMENT_SHADER, HAZE_FRAGMENT)
    const program = gl?.createProgram()
    if (!(gl && vertex && fragment && program)) return
    gl.attachShader(program, vertex)
    gl.attachShader(program, fragment)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return
    gl.useProgram(program)

    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW)
    const position = gl.getAttribLocation(program, 'p')
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)

    const uniform = (name) => gl.getUniformLocation(program, name)
    const resolution = uniform('r')
    const time = uniform('t')
    gl.uniform1f(uniform('flowSpeed'), flowSpeed)
    gl.uniform1f(uniform('swirlDetail'), swirlDetail)
    gl.uniform1f(uniform('colourBalance'), colourBalance)
    gl.uniform1f(uniform('ditherAmount'), ditherAmount)
    gl.uniform1f(uniform('distortStrength'), distortStrength)
    gl.uniform1f(uniform('distortDetail'), distortDetail)
    gl.uniform1f(uniform('sharpness'), sharpness)
    gl.uniform1f(uniform('grain'), grain)
    gl.uniform1f(uniform('imageBlend'), imageBlend)
    gl.uniform1f(uniform('hasImage'), 0)
    gl.uniform1f(uniform('imageAspect'), 1)
    gl.uniform3fv(uniform('shadowColour'), shaderVector(this.shadowRoot, shadowColour, [0.13, 0.13, 0.23]))
    gl.uniform3fv(uniform('highlightColour'), shaderVector(this.shadowRoot, highlightColour, [0.97, 0.87, 0.47]))
    gl.uniform3fv(uniform('ditherColour'), shaderVector(this.shadowRoot, ditherColour, [1, 1, 1]))

    const draw = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5)
      const width = Math.max(1, Math.round(canvas.clientWidth * ratio))
      const height = Math.max(1, Math.round(canvas.clientHeight * ratio))
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
        gl.viewport(0, 0, width, height)
      }
      gl.uniform2f(resolution, canvas.width, canvas.height)
      // The dither cell is measured in CSS pixels, so it stays the same size on
      // screen whatever the backing store is scaled to.
      gl.uniform1f(uniform('ditherPixel'), ditherPixel * (canvas.width / Math.max(1, canvas.clientWidth)))
      gl.uniform1f(time, still ? 0 : RM.t / 1000)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
    }
    /*
     * The picture is a texture, and the frame waits for it.
     *
     * RM.waitFor, because RM.ready() is what the renderer waits on before it
     * grabs a frame — without it the first frames are the swirl with no
     * photograph in them, and nothing anywhere says why.
     */
    const texture = gl.createTexture()
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    for (const [key, value] of [[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR]]) gl.texParameteri(gl.TEXTURE_2D, key, value)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]))
    gl.uniform1i(uniform('imageTex'), 0)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)

    const observer = new ResizeObserver(draw)
    const onSeek = () => draw()
    observer.observe(canvas)
    root.addEventListener('rmseek', onSeek)

    let settleTexture = () => {}
    if (imageSource) {
      RM.waitFor(new Promise((resolve) => (settleTexture = resolve)))
      const picture = new Image()
      picture.onload = () => {
        gl.bindTexture(gl.TEXTURE_2D, texture)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, picture)
        gl.uniform1f(uniform('imageAspect'), picture.naturalWidth / Math.max(1, picture.naturalHeight))
        gl.uniform1f(uniform('hasImage'), 1)
        draw()
        settleTexture()
      }
      /* A picture that will not load leaves the swirl, which is a background
         rather than a blank frame. */
      picture.onerror = () => settleTexture()
      picture.src = imageSource
    }

    /*
     * A lost context is a blank frame, silently.
     *
     * Browsers cap how many live WebGL contexts a document may hold and drop
     * the oldest when the cap is passed, which a scene using several of these
     * will do. The default behaviour then is that this element draws nothing
     * and says nothing — the worst possible outcome for a renderer that only
     * checks whether a file appeared. Preventing the default makes the loss
     * recoverable, and restoring rebuilds the whole pass.
     */
    const onLost = (event) => event.preventDefault()
    const onRestored = () => this.render()
    canvas.addEventListener('webglcontextlost', onLost)
    canvas.addEventListener('webglcontextrestored', onRestored)

    draw()
    this._dispose = () => {
      observer.disconnect()
      root.removeEventListener('rmseek', onSeek)
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
      settleTexture()
      gl.deleteTexture(texture)
      gl.deleteBuffer(buffer)
      gl.deleteProgram(program)
      gl.deleteShader(vertex)
      gl.deleteShader(fragment)
    }
  }
}
define('rm-haze', RMHaze)

/* ── rm-stat ─────────────────────────────────────────────────────────────── */

/**
 * One number, large. `count` animates it up from zero — and does so by stepping
 * a CSS integer, not a JS timer, so it lands on the same value at the same
 * frame on every render.
 */
class RMStat extends RMElement {
  static fields = ['value', 'label', 'unit', 'count', 'x', 'y', 'at', 'for']
  render() {
    /*
     * Placed like every other part: a percentage of the stage, from its centre.
     *
     * It had no position at all, so `::slotted(*) { position:absolute }` from
     * rm-scene left it wherever the default put it — the top-left corner — and
     * the only way to move one was an inline `style="left:..;top:.."` on the tag.
     * That is why the gallery positions two of these by hand, and why the Scenes
     * panel offered no sliders for them: the sliders are generated from `static
     * fields`, so a part that does not declare x and y cannot be dragged.
     */
    const x = Number(this.attr('x', 50))
    const y = Number(this.attr('y', 50))
    const value = this.attr('value', '0')
    const n = Number(String(value).replace(/[^0-9.-]/g, ''))
    const counting = this.hasAttribute('count') && Number.isFinite(n)
    this.shadowRoot.innerHTML = `
      <style>
        ${TYPE}${TIMING}
        :host { display:block; position:absolute; left:${x}%; top:${y}%; --rise:16px; }
        /*
         * Centred on its own point, so 50/50 is the middle of the stage.
         *
         * Written on .anim with the entrance transform carried along, exactly as
         * rm-browser does: a bare translate(-50%,-50%) would be a later rule of
         * equal specificity and would silently replace the rise, leaving the part
         * centred and dead.
         */
        .anim { transform: translate(-50%, calc(-50% + var(--rm-in-y) + var(--rm-out-y))) scale(var(--rm-in-s));
                text-align:center; }
        @property --n { syntax:"<integer>"; initial-value:0; inherits:false; }
        .v { font-size:6cqw; font-weight:800; letter-spacing:-.04em; line-height:1; color:var(--brand-text); }
        ${
          counting
            ? `.v { counter-reset: n var(--n);
                 animation: rm-count var(--duration-deliberate, 900ms) var(--ease) both paused;
                 animation-delay: calc(var(--at) - var(--t)); }
             .v::after { content: counter(n) "${this.esc(this.attr('unit', ''))}"; }
             @keyframes rm-count { from { --n: 0; } to { --n: ${Math.round(n)}; } }`
            : ''
        }
        .l { font-family:var(--mono); font-size:1.05cqw; letter-spacing:.11em; text-transform:uppercase;
             color:var(--muted); margin-top:.7cqw; }
      </style>
      <div class="anim">
        <div class="v">${counting ? '' : this.esc(value) + this.esc(this.attr('unit', ''))}</div>
        <div class="l">${this.esc(this.attr('label', ''))}</div>
      </div>`
  }
}
define('rm-stat', RMStat)

/* ── rm-year ─────────────────────────────────────────────────────────────── */

/*
 * A big number that types itself, with a caret that blinks beside it.
 *
 * The treatment is lifted from the Academy title slides: a year set large in
 * mono, revealed character by character, with a block caret keeping time next to
 * it. It reads as a terminal writing the number rather than as a label, which is
 * why it works as a graphic element and why rm-stat is not the same thing —
 * rm-stat counts a MEASUREMENT up from zero and labels it, this types a string.
 *
 * The reference drives both with GSAP. Here they are two paused CSS animations
 * offset by `--t`, like every other part, so a frame at 3.2s is the same frame
 * every time it is rendered. That matters more here than elsewhere: a typewriter
 * driven by wall-clock time lands mid-character at a different place in every
 * render, and the frame-stepping renderer would produce a different video each
 * run.
 */
class RMYear extends RMElement {
  static fields = ['value', 'x', 'y', 'size', 'caret', 'at', 'for']
  render() {
    const value = this.attr('value', '2026')
    const x = Number(this.attr('x', 50))
    const y = Number(this.attr('y', 50))
    // 9.4cqw is 180px on a 1920 stage, which is the reference size.
    const size = Number(this.attr('size', 9.4))
    const caret = this.attr('caret', 'on') !== 'off'
    const chars = [...value].length

    this.shadowRoot.innerHTML = `
      <style>
        ${TYPE}${TIMING}
        :host { display:block; position:absolute; left:${x}%; top:${y}%; --rise:0px; }
        /* Centred on its own point, carrying the entrance with it — the same
           reason every other part writes the translate into .anim. */
        .anim { transform: translate(-50%, calc(-50% + var(--rm-in-y) + var(--rm-out-y))) scale(var(--rm-in-s)); }
        /*
         * Fixed width, right-aligned — so the caret does not walk.
         *
         * Laid out to fit its content, the row grows as the number types and the
         * caret slides right with every character, which reads as the whole part
         * drifting. The reference pins it in a fixed block aligned to the end;
         * the number then grows leftward and the caret keeps still, which is what
         * makes it look like something typing rather than something expanding.
         */
        .row { display:flex; align-items:baseline; justify-content:flex-end;
               font-family:var(--mono); font-size:${size}cqw;
               gap:${size * 0.08}cqw;
               inline-size:calc(${chars}ch + ${size * 0.17}cqw); }
        /*
         * The typewriter, in ch units.
         *
         * A monospace ch is exactly one character wide, so animating the width
         * from 0ch to Nch in N steps reveals exactly one more character per step
         * — no measuring, and no per-character elements to stagger.
         */
        .n { font-family:var(--mono); font-weight:600; font-size:${size}cqw; line-height:1;
             color:var(--fg); letter-spacing:0;
             display:inline-block; overflow:hidden; white-space:pre;
             inline-size:${chars}ch;
             animation: rm-type var(--duration-deliberate, 1000ms) steps(${chars}) both paused;
             animation-delay: calc(var(--at) + 200ms - var(--t)); }
        @keyframes rm-type { from { inline-size:0ch; } to { inline-size:${chars}ch; } }
        /*
         * The caret keeps its own time.
         *
         * Stepped rather than eased, so it is on or off and never half-lit, and
         * finite rather than infinite: an infinite animation has no end for the
         * renderer to be past, and the part would never settle.
         */
        .c { inline-size:${size * 0.09}cqw; block-size:${size * 0.83}cqw; flex:0 0 auto;
             background:var(--brand); border-radius:${size * 0.011}cqw;
             transform:translateY(${size * 0.067}cqw);
             animation: rm-blink 1000ms steps(1) 16 both paused;
             animation-delay: calc(var(--at) + 200ms - var(--t)); }
        @keyframes rm-blink { 0% { opacity:1; } 50% { opacity:0; } 100% { opacity:1; } }
      </style>
      <div class="anim">
        <div class="row">
          <span class="n">${this.esc(value)}</span>
          ${caret ? '<i class="c"></i>' : ''}
        </div>
      </div>`
  }
}
define('rm-year', RMYear)

/* ── rm-bullets ──────────────────────────────────────────────────────────── */

/** A list that builds. Each `<li>` gets `stagger` ms after the one before it. */
class RMBullets extends RMElement {
  static fields = ['heading', 'items', 'stagger', 'x', 'y', 'w', 'at', 'for']
  render() {
    /*
     * Items from an attribute, falling back to light-DOM <li>.
     *
     * They could only ever come from child <li> elements, and the Scenes builder
     * emits every part as `<tag attrs></tag>` with no children — so a bullets
     * part built in the panel had no bullets at all, just a heading over an
     * empty list. Authored markup with real <li> still works and still wins;
     * this is the half the builder can express.
     *
     * Split on newline or pipe, because a text field cannot hold a newline and a
     * textarea can.
     */
    const written = [...this.querySelectorAll('li')].map((li) => li.textContent.trim()).filter(Boolean)
    const items = written.length
      ? written
      : String(this.attr('items', ''))
          .split(/\r?\n|\|/)
          .map((t) => t.trim())
          .filter(Boolean)
    const stagger = Number(this.attr('stagger', 420))
    /*
     * Placed like every other part, from its centre.
     *
     * It had no position, so the stage's own `::slotted(*) { position:absolute }`
     * dropped it in the top-left corner and the only way to move it was an inline
     * style on the tag — which is why the gallery carries one, and why the Scenes
     * panel offered no sliders: those come from `static fields`.
     */
    const x = Number(this.attr('x', 50))
    const y = Number(this.attr('y', 50))
    // A list needs a measure. Without one it is as wide as its longest line.
    const w = Number(this.attr('w', 58))
    this.shadowRoot.innerHTML = `
      <style>
        ${TYPE}${TIMING}
        :host { display:block; position:absolute; left:${x}%; top:${y}%; width:${w}cqw; --rise:12px; }
        /* Centred on its own point, carrying the entrance with it — the same
           reason every other part writes the translate into its animated rule. */
        .wrap { transform: translate(-50%, -50%); }
        h3 { margin:0 0 1.4cqw; font-size:2.2cqw; font-weight:750; letter-spacing:-.02em; color:var(--fg); }
        ul { margin:0; padding:0; list-style:none; display:flex; flex-direction:column; gap:1cqw; }
        li { display:flex; gap:.9cqw; align-items:flex-start; font-size:1.6cqw; color:var(--fg); line-height:1.4;
             animation: rm-in var(--dur) var(--ease) both paused;
             opacity: var(--rm-in-o); transform: translateY(var(--rm-in-y)); }
        li::before { content:""; flex:0 0 auto; width:.72cqw; height:.72cqw; border-radius:.16cqw;
                     background:var(--brand); margin-top:.5cqw; }
      </style>
      <div class="wrap">
        ${this.attr('heading') ? `<h3 class="anim">${this.esc(this.attr('heading'))}</h3>` : ''}
        <ul>${items.map((t, i) => `<li style="animation-delay:calc(var(--at) + ${i * stagger}ms - var(--t))">${this.esc(t)}</li>`).join('')}</ul>
      </div>`
  }
}
define('rm-bullets', RMBullets)

/* ── the gradient study family ───────────────────────────────────────────── */

/*
 * A halftone field, and the eight motion studies drawn over it.
 *
 * Ported from a design sheet that ran the field on requestAnimationFrame. That
 * cannot ship here: the frame at 2400ms has to be the same frame on every run or
 * the render differs between takes. Everything below is a pure function of the
 * composition clock, redrawn on rmseek — same picture, deterministic.
 *
 * The sheet drew at a fixed 1380×860 and scaled the canvas up with CSS. That is
 * kept deliberately: the dot grid is ~47k cells a frame, so pinning the internal
 * resolution keeps a 4K render costing exactly what a preview costs, and the
 * halftone reads as a texture of a fixed weight rather than getting finer as the
 * output gets bigger.
 */
const STUDY_W = 1380
const STUDY_H = 860

const sClamp = (v, min, max) => Math.max(min, Math.min(max, v))
const sMix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]

const sSmooth = (e0, e1, v) => { const t = sClamp((v - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t) }
const sEaseIn = (t) => t * t * t
const sEaseOut = (t) => 1 - (1 - t) ** 4
const sPulse = (t, a, b) => Math.sin(sClamp((t - a) / (b - a), 0, 1) * Math.PI)

/* Deterministic value noise: the same cell always returns the same number, so
   the grain does not crawl between frames the way Math.random() would. */
function sHash2(ix, iy) {
  let n = ix * 374761393 + iy * 668265263
  n = (n ^ (n >>> 13)) * 1274126177
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295
}
function sNoise(x, y) {
  const ix = Math.floor(x); const iy = Math.floor(y)
  const fx = sSmooth(0, 1, x - ix); const fy = sSmooth(0, 1, y - iy)
  const nx0 = sHash2(ix, iy) * (1 - fx) + sHash2(ix + 1, iy) * fx
  const nx1 = sHash2(ix, iy + 1) * (1 - fx) + sHash2(ix + 1, iy + 1) * fx
  return nx0 * (1 - fy) + nx1 * fy
}
function sFbm(x, y) {
  let value = 0; let amp = 0.56; let total = 0; let px = x; let py = y
  for (let i = 0; i < 4; i += 1) {
    value += sNoise(px, py) * amp
    total += amp
    const rx = px * 1.62 + py * 0.42
    const ry = py * 1.48 - px * 0.36
    px = rx + 13.7; py = ry - 8.9; amp *= 0.52
  }
  return value / total
}
const sMass = (x, y, cx, cy, rx, ry) => Math.exp(-(((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2))

/* The field itself: two warped lobes, a ribbon through them, and nested noise. */
function sField(x, y, st) {
  const t = st.phase
  const warpA = (sFbm(x * 2.3 + t * 0.24, y * 1.8 - t * 0.16) - 0.5) * st.warp
  const warpB = (sFbm(x * 1.7 - t * 0.12 + 4.6, y * 2.15 + t * 0.2) - 0.5) * st.warp
  const ux = x + warpA + Math.sin(y * Math.PI * 2.1 + t * 0.9) * 0.035
  const uy = y + warpB + Math.cos(x * Math.PI * 1.55 - t * 0.75) * 0.03
  const massA = sMass(ux, uy, st.massAX, st.massAY, 0.36, 0.48)
  const massB = sMass(ux, uy, st.massBX, st.massBY, 0.3, 0.46)
  const massC = sMass(ux, uy, st.massCX, st.massCY, 0.54, 0.22)
  const ribbon = sSmooth(0.18, 0.88, Math.sin((ux * 1.12 - uy * 0.22 + st.ribbon) * Math.PI * 2))
  const nested = sFbm(ux * 2.2 + massA * 0.7 + t * 0.12, uy * 2.0 + massB * 0.7 - t * 0.1)
  const shape = sClamp(massA * 0.5 + massB * 0.38 + massC * 0.24 + ribbon * 0.18 + nested * 0.22, 0, 1)
  const hue = sClamp(shape * 0.65 + ribbon * 0.2 + nested * 0.28 + st.palette * 0.3, 0, 1)
  return { shape, hue, ribbon, nested }
}

const sRgba = (c, a) => `rgba(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0}, ${a.toFixed(3)})`

/* The soft colour wash under the dots. */
function sPaintWash(ctx, w, h, st, pal) {
  // How much of the soft glow is laid over the frame. The sheet ran this at
  // full strength on a page of small cards; across a whole 16:9 frame the same
  // wash covers everything and the halftone underneath stops reading.
  const haze = st.haze
  const soft = (cx, cy, rx, ry, color, alpha) => {
    ctx.save(); ctx.translate(cx, cy); ctx.scale(rx, ry)
    const g = ctx.createRadialGradient(0, 0, 0.08, 0, 0, 1)
    g.addColorStop(0, sRgba(color, alpha))
    g.addColorStop(0.52, sRgba(color, alpha * 0.42))
    g.addColorStop(1, sRgba(color, 0))
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill(); ctx.restore()
  }
  ctx.save()
  ctx.globalCompositeOperation = 'screen'
  ctx.filter = `blur(${28 + st.blend * 10}px)`
  soft(st.massAX * w, st.massAY * h, w * (0.32 + st.blend * 0.08), h * 0.42, pal.green, (0.17 + st.blend * 0.08) * haze)
  soft(st.massBX * w, st.massBY * h, w * 0.3, h * (0.4 + st.blend * 0.06), pal.cyan, (0.14 + st.blend * 0.07) * haze)
  soft(st.massCX * w, st.massCY * h, w * 0.46, h * 0.2, pal.amber, (0.08 + st.blend * 0.04) * haze)
  const ribbonY = h * (0.5 + Math.sin(st.phase * 0.72) * 0.16)
  const ribbon = ctx.createLinearGradient(0, 0, w, 0)
  ribbon.addColorStop(0, sRgba(pal.green, 0))
  ribbon.addColorStop(0.28, sRgba(pal.green, (0.11 + st.blend * 0.04) * haze))
  ribbon.addColorStop(0.58, sRgba(pal.cyan, (0.12 + st.blend * 0.05) * haze))
  ribbon.addColorStop(0.86, sRgba(pal.amber, (0.06 + st.blend * 0.03) * haze))
  ribbon.addColorStop(1, sRgba(pal.cyan, 0))
  ctx.strokeStyle = ribbon
  ctx.lineWidth = h * (0.18 + st.blend * 0.08)
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(-w * 0.14, ribbonY + Math.sin(st.phase * 0.9) * h * 0.08)
  ctx.bezierCurveTo(w * 0.2, ribbonY - h * 0.24, w * 0.62, ribbonY + h * 0.26, w * 1.14, ribbonY - Math.cos(st.phase * 0.7) * h * 0.1)
  ctx.stroke(); ctx.restore()
}

/* The dot field. Grain comes from the cell's own hash, not from a running RNG,
   so a frame drawn on its own matches the same frame drawn in sequence. */
function sDrawField(ctx, w, h, st, pal) {
  const spacing = 5.15 / st.density
  const radius = 1.5 * st.radius
  const bg = ctx.createLinearGradient(0, 0, w, h)
  bg.addColorStop(0, sRgba(sMix(pal.ground, pal.green, 0.07), 1))
  bg.addColorStop(0.52, sRgba(pal.ground, 1))
  bg.addColorStop(1, sRgba(sMix(pal.ground, [0, 0, 0], 0.35), 1))
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, w, h)
  sPaintWash(ctx, w, h, st, pal)

  const colors = [pal.green, pal.cyan, pal.paper, pal.amber, sMix(pal.green, pal.ground, 0.5)]
  /*
   * The dim end of the ramp is the ground, not 30% toward black.
   *
   * A cell with little energy was painted darker than what it sits on, so the
   * whole field carried a black speckle — worst in the middle, where centerDark
   * takes energy away. On the sheet's 460px card those were specks; across a
   * frame they are the texture you see. A dot may add light to the ground and
   * may take colour from the field, but it never darkens what is behind it.
   */
  const dark = pal.ground
  const light = sMix(pal.paper, pal.ground, 0.06)
  const cx = w * st.centerX
  const cy = h * st.centerY
  const maxD = Math.hypot(w * 0.5, h * 0.5)

  for (let y = -spacing; y < h + spacing; y += spacing) {
    const row = y / h
    for (let x = -spacing; x < w + spacing; x += spacing) {
      const col = x / w
      const dist = Math.hypot(x - cx, y - cy) / maxD
      const field = sField(col, row, st)
      const centerDark = sClamp(1 - dist * 2.25, 0, 1) * 0.68
      const topLight = sClamp(1 - row * 1.6, 0, 1)
      const grain = sHash2(Math.round(x / spacing), Math.round(y / spacing))
      let energy = 0.14 + topLight * 0.18 + field.shape * (0.52 + st.blend * 0.24) + st.lift - centerDark * 0.4
      energy = sClamp(energy + (grain - 0.5) * 0.025, 0.03, 0.98)
      const colorSeed = field.hue * 3.2 + st.palette * 1.4 + row * 0.42
      const ci = ((Math.floor(colorSeed) % colors.length) + colors.length) % colors.length
      const tonal = sMix(dark, light, energy)
      const fieldColor = sMix(colors[ci], colors[(ci + 1) % colors.length], sSmooth(0.24, 0.78, field.ribbon))
      const color = sMix(tonal, fieldColor, 0.34 + field.shape * 0.32 + st.wash * 0.22)
      const alpha = sClamp(0.16 + energy * 0.72 + st.blend * 0.12, 0.12, 0.98)
      const sizeBase = 0.36 + energy * 1.04 + field.shape * st.shapeScale + field.ribbon * st.ribbonScale
      // st.grain scales the dot against its cell. At 1 the sheet's dots sit in a
      // field of exposed ground and the gaps between them read as dark specks;
      // larger dots close that gap and the halftone becomes a texture rather
      // than a grid of holes.
      const size = radius * st.grain * sClamp(sizeBase + (grain - 0.5) * 0.045, 0.3, 4.2)
      ctx.fillStyle = sRgba(color, alpha)
      ctx.beginPath(); ctx.arc(x + (grain - 0.5) * 0.12, y, size, 0, Math.PI * 2); ctx.fill()
    }
  }

  if (st.blend > 0.01) {
    ctx.fillStyle = sRgba(pal.green, 0.08 * st.blend * st.haze)
    ctx.fillRect(0, 0, w, h)
    ctx.fillStyle = sRgba(pal.cyan, 0.07 * st.blend * st.haze)
    ctx.fillRect(w * 0.18, 0, w * 0.82, h)
  }
  // The vignette rides the same control: at full haze it is the sheet's, and at
  // zero the centre is left alone entirely rather than veiled by a flat 8%.
  const vig = ctx.createRadialGradient(cx, cy, h * 0.04, cx, cy, maxD * 0.92)
  vig.addColorStop(0, `rgba(0,0,0,${(0.08 * st.haze).toFixed(3)})`)
  vig.addColorStop(0.5, `rgba(0,0,0,${(0.03 * st.haze).toFixed(3)})`)
  vig.addColorStop(1, `rgba(0,0,0,${(0.16 + 0.28 * st.haze).toFixed(3)})`)
  ctx.fillStyle = vig
  ctx.fillRect(0, 0, w, h)
}

/*
 * The eight studies are eight motions over that one field, which is why they are
 * a `mode` rather than eight components. Each returns where the plate is, how
 * hard the field is blooming, and what the body should do.
 */
const STUDY_MODES = ['current', 'bloom', 'softCut', 'cutCurveA', 'cutCurveB', 'wipe', 'claude', 'proof']

function sMotion(mode, time, phase) {
  /*
   * Where in the drift this card sits.
   *
   * The sheet offset each study by its index, which is what gave eight cards on
   * one page eight different fields. Without it every study starts at the same
   * instant — and that instant happens to park both colour masses off the edges
   * of the frame, so the field reads as nearly black. It is a variable rather
   * than an index because a component does not know what number it is.
   */
  const slow = time * 0.074 + phase
  const cycle = (time % 5.2) / 5.2
  const breakCycle = (time % 4.8) / 4.8
  const m = {
    swell: 0, blend: 0, hue: 0, sat: 1.12, fgBlur: 0, cutDrag: 0, cutBoost: 0, haze: 1, grain: 1,
    plateX: Math.sin(slow * Math.PI * 2) * 54,
    plateY: Math.cos(slow * Math.PI * 2 + 0.8) * 14,
    plateScale: 1.04, slow, cycle,
    a: null, b: null, body: null,
  }
  const scenes = (exitEase, entryEase, blur, travel) => {
    m.a = { x: -travel * exitEase, o: sClamp(1 - exitEase * 0.95, 0, 1), blur: blur * exitEase }
    m.b = { x: travel * (1 - entryEase), o: entryEase, blur: blur * (1 - entryEase) }
  }

  if (mode === 'current') {
    m.body = { x: Math.sin(time * 0.22) * 8, scale: 1, blur: 10 }
  }
  if (mode === 'bloom') {
    m.swell = sPulse(breakCycle, 0.22, 0.66) * 1.35
    m.blend = sPulse(breakCycle, 0.28, 0.7) * 0.85
    m.plateX += -118 * sPulse(breakCycle, 0.16, 0.82)
    m.plateScale += 0.18 * m.swell
    m.hue = 14 * m.swell
    m.sat += 0.42 * m.swell
    m.body = { x: 0, scale: 1 + m.swell * 0.035, blur: m.swell * 3 }
  }
  if (mode === 'softCut') {
    m.swell = sPulse(cycle, 0.26, 0.58) * 0.35
    m.blend = sPulse(cycle, 0.32, 0.56) * 0.2
    m.plateX += -96 * sPulse(cycle, 0.22, 0.7)
    m.plateScale += 0.08 * m.swell
    scenes(sEaseIn(sClamp((cycle - 0.32) / 0.12, 0, 1)), sEaseOut(sClamp((cycle - 0.44) / 0.26, 0, 1)), 8, 230)
  }
  if (mode === 'cutCurveA' || mode === 'cutCurveB') {
    // Cut the curve: the background keeps travelling through the cut instead of
    // stopping at it, so the two scenes read as one continuous move.
    const intensity = mode === 'cutCurveA' ? 0.6 : 0.45
    const exitT = sClamp((cycle - 0.30) / 0.14, 0, 1)
    const entryT = sClamp((cycle - 0.44) / 0.30, 0, 1)
    const exitEase = sEaseIn(exitT)
    const entryEase = entryT === 1 ? 1 : 1 - 2 ** (-10 * entryT)
    const bgX = entryT > 0 ? -210 + -260 * entryEase : -210 * exitEase
    m.plateX = bgX
    m.plateY = Math.cos(slow * Math.PI * 2 + 0.8) * 10
    const cut = sPulse(cycle, 0.30, 0.58)
    m.swell = cut * (1.35 * intensity)
    m.blend = cut * (0.85 * intensity)
    m.plateScale = 1.04 + 0.20 * m.swell
    m.hue = 14 * intensity * m.swell
    m.sat = 1.04 + 0.42 * intensity * m.swell
    m.fgBlur = cut * (6 * intensity)
    m.cutDrag = bgX
    m.cutBoost = cut * intensity
    scenes(exitEase, entryEase, 8, 230)
  }
  if (mode === 'wipe') {
    const out = sEaseIn(sClamp((breakCycle - 0.22) / 0.16, 0, 1))
    const enter = sEaseOut(sClamp((breakCycle - 0.44) / 0.34, 0, 1))
    m.swell = sPulse(breakCycle, 0.22, 0.72) * 1.65
    m.blend = sPulse(breakCycle, 0.28, 0.72) * 0.98
    m.plateX += -170 * sPulse(breakCycle, 0.14, 0.86)
    m.plateScale += 0.28 * m.swell
    m.hue = -18 * m.swell
    m.sat += 0.5 * m.swell
    // The outgoing scene scales through rather than sliding: a reset, not a cut.
    m.a = { x: 0, scale: 1 + out * 0.18, o: sClamp(1 - out * 0.95, 0, 1), blur: 14 * out }
    m.b = { x: 260 * (1 - enter), o: enter, blur: 14 * (1 - enter) }
  }
  if (mode === 'claude') {
    m.plateX = Math.sin(slow * Math.PI * 2) * 28
    m.plateY = Math.cos(slow * Math.PI * 2) * 10
    m.sat = 1.04
    m.body = { x: Math.sin(time * 0.42) * 10, scale: 1, blur: 0 }
  }
  if (mode === 'proof') {
    m.plateX = Math.sin(slow * Math.PI * 2) * 34
    m.plateY = Math.cos(slow * Math.PI * 2) * 8
    m.swell = 0.15 + Math.sin(time * 0.9) * 0.06
    m.body = { x: Math.sin(time * 0.55) * 22, scale: 1, blur: 0 }
  }
  return m
}

/* The field's own parameters for this instant, from the motion above. */
function sState(m, mode) {
  const st = {
    phase: m.slow * 2.4 + m.plateX / 820,
    density: 1.02 + m.swell * 0.2,
    radius: 1.0 + m.swell * 0.72,
    lift: 0.03 + m.blend * 0.1,
    centerX: 0.5 + Math.sin(m.slow * Math.PI * 2) * 0.045 + m.plateX / 4200,
    centerY: 0.52 + Math.cos(m.slow * Math.PI * 2) * 0.025 + m.plateY / 2600,
    palette: 0.44 + Math.sin(m.slow * 1.6) * 0.12 + m.blend * 0.4,
    wash: 0.14 + m.blend * 0.42,
    warp: 0.22 + m.swell * 0.08,
    shapeScale: 0.24 + m.swell * 0.82,
    ribbonScale: 0.06 + m.swell * 0.18,
    blend: m.blend,
    haze: m.haze,
    grain: m.grain,
    ribbon: m.slow * 0.82 + m.plateX / 900,
    massAX: -0.28 + ((m.slow * 0.46) % 1.56),
    massAY: 0.42 + Math.sin(m.slow * Math.PI * 0.9) * 0.16,
    massBX: 1.24 - ((m.slow * 0.34 + 0.28) % 1.54),
    massBY: 0.6 + Math.cos(m.slow * Math.PI * 0.82) * 0.16,
    massCX: 0.44 + Math.sin(m.slow * Math.PI * 0.62 + 1.4) * 0.34,
    massCY: 0.32 + Math.cos(m.slow * Math.PI * 0.54 + 0.8) * 0.12,
  }
  // A landed cut-the-curve scene sat near-black between beats; lift its resting
  // colour so the field still reads as a field when nothing is moving.
  if (mode === 'cutCurveA' || mode === 'cutCurveB') {
    st.lift += 0.09; st.wash += 0.12
    st.palette = sClamp(st.palette + 0.16, 0, 1)
    st.shapeScale += 0.14; st.ribbonScale += 0.05
    st.radius += 0.08; st.density += 0.04
  }
  // Drag the masses along the cut vector so the shapes cross the frame with the
  // plate, rather than the plate sliding over a field that stayed put.
  if (m.cutDrag !== 0 || m.cutBoost !== 0) {
    const lateral = m.cutDrag / 320
    st.massAX += lateral * 1.10
    st.massBX += lateral * 1.25
    st.massCX += lateral * 0.85
    st.centerX += m.cutDrag / 1100
    st.ribbon += m.cutDrag / 260
    st.phase += m.cutDrag / 220
    st.warp += m.cutBoost * 0.20
    st.shapeScale += m.cutBoost * 0.32
    st.ribbonScale += m.cutBoost * 0.14
  }
  return st
}

/* Colours arrive as CSS custom properties so the palette stays themable; the
   canvas needs numbers, and this is the one place that converts them. */
const sProbe = document.createElement('canvas').getContext('2d')
function sColor(value, fallback) {
  sProbe.fillStyle = fallback
  try { sProbe.fillStyle = value } catch { /* keep the fallback */ }
  const hex = sProbe.fillStyle
  if (hex.startsWith('#')) return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]
  const parts = hex.match(/[\d.]+/g) ?? []
  return [Number(parts[0]) || 0, Number(parts[1]) || 0, Number(parts[2]) || 0]
}

const FIELD = `
  :host {
    /* The sheet's palette as fallbacks only, so retuning the brand retunes the
       field — the same contract every other component here follows. */
    --ground: var(--op-color-neutral-plus-max, #07100c);
    --paper-ink: var(--op-color-neutral-minus-max, #fff8e9);
    --green: var(--op-color-academy-primary-base, #45d86e);
    --cyan: var(--op-color-primary-base, #19b7d5);
    --amber: var(--op-color-secondary-base, #f1b64a);
    /*
     * Absolute, because inset does nothing without it.
     *
     * These full-frame treatments each declared inset:0 and stayed static, so
     * the first one in a composition landed at the top by accident of being
     * first in flow and every one after it stacked BELOW the frame, out of
     * sight behind overflow:hidden. A composition is a stack of things that
     * each fill it, never a column.
     */
    position: absolute; display: block; inset: 0; width: 100%; height: 100%;
  }
  .field { position:absolute; inset:0; overflow:hidden; background:var(--ground); --rise:0px; }
${LOCKUP}
  /* Oversized and centred: the plate travels during a cut, and a plate the size
     of the frame would show the ground along the edge it moves away from. */
  canvas { position:absolute; left:50%; top:50%; width:126%; height:126%;
           transform:translate(-50%,-50%); will-change:transform, filter; }
`

/**
 * The animated halftone field on its own.
 *
 * A background, not a card. The sheet this came from drew titles and mocks over
 * the field to show what each motion was for; those were the demonstration, and
 * the field is the thing worth keeping. Lay type over it with rm-title, or any
 * other component, the way you would over footage.
 */
class RMStudyField extends RMElement {
  static fields = ['mode', 'phase', 'bloom', 'haze', 'grain', 'eyebrow', 'title', 'body', 'size', 'x', 'y', 'align', 'ground', 'paper', 'green', 'cyan', 'amber', 'at', 'for']

  disconnectedCallback() { this._dispose?.(); this._dispose = null }

  render() {
    this._dispose?.()
    const mode = STUDY_MODES.includes(this.attr('mode')) ? this.attr('mode') : 'current'
    this.shadowRoot.innerHTML = `
      <style>${TYPE}${TIMING}${FIELD}</style>
      <div class="field anim" style="${fieldStyle(this)}">
        <canvas aria-hidden="true"></canvas>
        ${this.attr('eyebrow') || this.attr('title') || this.attr('body') ? `<div class="lockup">
          ${this.attr('eyebrow') ? `<div class="eyebrow anim">${this.esc(this.attr('eyebrow'))}</div>` : ''}
          ${this.attr('title') ? `<div class="title anim">${this.esc(this.attr('title'))}</div>` : ''}
          ${this.attr('body') ? `<div class="body anim">${this.esc(this.attr('body'))}</div>` : ''}
        </div>` : ''}
      </div>`

    const canvas = this.shadowRoot.querySelector('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    canvas.width = STUDY_W
    canvas.height = STUDY_H
    const bloom = Number(this.attr('bloom', ''))
    const phase = Number(this.attr('phase', ''))

    const plate = canvas.parentElement
    const draw = () => {
      // The palette is written onto .field, not the host, so it has to be read
      // from .field. Reading the host gave the :host defaults and silently
      // ignored every colour attribute.
      const css = getComputedStyle(plate)
      const pal = {
        ground: sColor(css.getPropertyValue('--ground'), 'rgb(7, 16, 12)'),
        paper: sColor(css.getPropertyValue('--paper-ink'), 'rgb(255, 248, 233)'),
        green: sColor(css.getPropertyValue('--green'), 'rgb(69, 216, 110)'),
        cyan: sColor(css.getPropertyValue('--cyan'), 'rgb(25, 183, 213)'),
        amber: sColor(css.getPropertyValue('--amber'), 'rgb(241, 182, 74)'),
      }
      // The clip's own time, so a field reads the same wherever it is mounted.
      const time = Math.max(0, RM.t - this.startMs()) / 1000
      const m = sMotion(mode, time, Number.isFinite(phase) ? phase : 1.4)
      if (Number.isFinite(bloom)) m.blend = Math.max(m.blend, bloom)
      const haze = Number(this.attr('haze', ''))
      if (Number.isFinite(haze)) m.haze = sClamp(haze, 0, 1)
      const grainSize = Number(this.attr('grain', ''))
      if (Number.isFinite(grainSize)) m.grain = sClamp(grainSize, 0.5, 3)
      canvas.style.transform = `translate(calc(-50% + ${m.plateX}px), calc(-50% + ${m.plateY}px)) scale(${m.plateScale})`
      canvas.style.filter = `hue-rotate(${m.hue}deg) saturate(${m.sat}) blur(${m.fgBlur}px)`
      sDrawField(ctx, STUDY_W, STUDY_H, sState(m, mode), pal)
    }
    const onSeek = () => draw()
    root.addEventListener('rmseek', onSeek)
    draw()
    this._dispose = () => root.removeEventListener('rmseek', onSeek)
  }
}
define('rm-study-field', RMStudyField)


/* ── rm-look ─────────────────────────────────────────────────────────────────
 *
 * The Creator's element: a gradient, and every effect that can be laid over
 * one, in a single seekable WebGL pass.
 *
 * WHERE THIS CAME FROM
 *
 * Five web tools did pieces of this — gradient studios, a shader lab, an ASCII
 * converter, a background studio with a node graph — and each kept its result
 * on its own site. A background belongs where the video and the website are
 * made, so this is one element that does what those five do, with one
 * description of a look that travels: the `look` attribute, a short parameter
 * string. The same string is a Framer component's Look property, a scene in a
 * composition, a saved row in the team's database, and a URL.
 *
 * WHY ONE SHADER
 *
 * Everything here is a function of a coordinate and a time, so an effect that
 * needs "the picture at another point" — glass refraction, aberration, an
 * ASCII cell's average — recomputes the scene there rather than reading back a
 * framebuffer. That keeps it one program with no passes to order, and keeps
 * `RM.seek()` the only clock, which is what makes a frame reproducible.
 */

/**
 * Every dial, in the order the shader's `u[]` array expects them.
 *
 *   key    what the look string calls it
 *   group  which section of the panel it belongs to
 *   type   range | select | color | toggle
 *   def    the default; a look string carries only what differs
 *
 * `on` toggles gate a whole group; the shader multiplies by them.
 */
const LOOK_SCHEMA = [
  // gradient
  { key: 'shape', group: 'gradient', label: 'Shape', type: 'select', options: ['linear', 'radial', 'conic', 'swirl'], def: 'linear' },
  { key: 'a', group: 'gradient', label: 'Angle', type: 'range', min: 0, max: 360, step: 1, def: 220 },
  { key: 'cx', group: 'gradient', label: 'Centre X', type: 'range', min: 0, max: 1, step: 0.01, def: 0.5 },
  { key: 'cy', group: 'gradient', label: 'Centre Y', type: 'range', min: 0, max: 1, step: 0.01, def: 0.5 },
  { key: 'w', group: 'gradient', label: 'Warp', type: 'range', min: 0, max: 2, step: 0.01, def: 0.3 },
  { key: 'fl', group: 'gradient', label: 'Flow', type: 'range', min: 0, max: 2, step: 0.01, def: 0.2 },
  { key: 'sc', group: 'gradient', label: 'Scale', type: 'range', min: 0.2, max: 4, step: 0.05, def: 1.3 },
  { key: 'd', group: 'gradient', label: 'Detail', type: 'range', min: 1, max: 4, step: 1, def: 2 },
  { key: 'ct', group: 'gradient', label: 'Contrast', type: 'range', min: 0.5, max: 2, step: 0.01, def: 1.1 },
  { key: 'seed', group: 'gradient', label: 'Seed', type: 'range', min: 0, max: 100, step: 1, def: 7 },
  // waves
  { key: 'wv', group: 'waves', label: 'Waves', type: 'toggle', def: 0 },
  { key: 'wvf', group: 'waves', label: 'Frequency', type: 'range', min: 0.1, max: 6, step: 0.05, def: 1.5 },
  { key: 'wva', group: 'waves', label: 'Amplitude', type: 'range', min: 0, max: 1, step: 0.01, def: 0.35 },
  { key: 'wvfo', group: 'waves', label: 'Falloff', type: 'range', min: 0, max: 1, step: 0.01, def: 0.35 },
  { key: 'wvx', group: 'waves', label: 'Centre X', type: 'range', min: 0, max: 1, step: 0.01, def: 0.5 },
  { key: 'wvy', group: 'waves', label: 'Centre Y', type: 'range', min: 0, max: 1, step: 0.01, def: 0.5 },
  // blobs
  { key: 'bl', group: 'blobs', label: 'Blobs', type: 'toggle', def: 0 },
  { key: 'blc', group: 'blobs', label: 'Count', type: 'range', min: 1, max: 8, step: 1, def: 4 },
  { key: 'bls', group: 'blobs', label: 'Size', type: 'range', min: 0.05, max: 1, step: 0.01, def: 0.35 },
  { key: 'blsm', group: 'blobs', label: 'Softness', type: 'range', min: 0, max: 1, step: 0.01, def: 0.6 },
  { key: 'blsp', group: 'blobs', label: 'Drift', type: 'range', min: 0, max: 2, step: 0.01, def: 0.5 },
  // light
  { key: 'lt', group: 'light', label: 'Mode', type: 'select', options: ['none', 'spot', 'beam', 'rays'], def: 'none' },
  { key: 'lta', group: 'light', label: 'Amount', type: 'range', min: 0, max: 1, step: 0.01, def: 0.6 },
  { key: 'lts', group: 'light', label: 'Size', type: 'range', min: 0.05, max: 1, step: 0.01, def: 0.5 },
  { key: 'ltx', group: 'light', label: 'X', type: 'range', min: 0, max: 1, step: 0.01, def: 0.5 },
  { key: 'lty', group: 'light', label: 'Y', type: 'range', min: 0, max: 1, step: 0.01, def: 0.3 },
  // glass
  { key: 'gl', group: 'glass', label: 'Fluted glass', type: 'toggle', def: 0 },
  { key: 'gla', group: 'glass', label: 'Amount', type: 'range', min: 0, max: 1, step: 0.01, def: 0.55 },
  { key: 'glc', group: 'glass', label: 'Strips', type: 'range', min: 2, max: 64, step: 1, def: 18 },
  { key: 'glsh', group: 'glass', label: 'Shadows', type: 'range', min: 0, max: 1, step: 0.01, def: 0.3 },
  { key: 'glhi', group: 'glass', label: 'Highlights', type: 'range', min: 0, max: 1, step: 0.01, def: 0.12 },
  { key: 'glb', group: 'glass', label: 'Blur', type: 'range', min: 0, max: 1, step: 0.01, def: 0.5 },
  // optics
  { key: 'sf', group: 'optics', label: 'Softness', type: 'range', min: 0, max: 1, step: 0.01, def: 0 },
  { key: 'ab', group: 'optics', label: 'Aberration', type: 'range', min: 0, max: 1, step: 0.01, def: 0 },
  // pixelate
  { key: 'px', group: 'pixelate', label: 'Pixel size', type: 'range', min: 0, max: 64, step: 1, def: 0 },
  // dither
  { key: 'dt', group: 'dither', label: 'Dither', type: 'select', options: ['none', 'bayer2', 'bayer4', 'bayer8'], def: 'none' },
  { key: 'dl', group: 'dither', label: 'Levels', type: 'range', min: 2, max: 16, step: 1, def: 4 },
  { key: 'dst', group: 'dither', label: 'Strength', type: 'range', min: 0, max: 1, step: 0.01, def: 1 },
  // halftone
  { key: 'hf', group: 'halftone', label: 'Halftone', type: 'toggle', def: 0 },
  { key: 'hfm', group: 'halftone', label: 'Mode', type: 'select', options: ['dots', 'lines'], def: 'dots' },
  { key: 'hfs', group: 'halftone', label: 'Size', type: 'range', min: 3, max: 64, step: 1, def: 12 },
  { key: 'hfa', group: 'halftone', label: 'Angle', type: 'range', min: 0, max: 180, step: 1, def: 45 },
  { key: 'hfmix', group: 'halftone', label: 'Mix', type: 'range', min: 0, max: 1, step: 0.01, def: 1 },
  { key: 'hfc', group: 'halftone', label: 'Ink', type: 'color', def: '1a1a1a' },
  // plaid
  { key: 'pl', group: 'plaid', label: 'Grid', type: 'toggle', def: 0 },
  { key: 'plc', group: 'plaid', label: 'Columns', type: 'range', min: 2, max: 96, step: 1, def: 24 },
  { key: 'plr', group: 'plaid', label: 'Rows', type: 'range', min: 2, max: 96, step: 1, def: 24 },
  { key: 'plw', group: 'plaid', label: 'Line', type: 'range', min: 0.01, max: 0.5, step: 0.005, def: 0.04 },
  { key: 'plo', group: 'plaid', label: 'Opacity', type: 'range', min: 0, max: 1, step: 0.01, def: 0.35 },
  { key: 'plcol', group: 'plaid', label: 'Line colour', type: 'color', def: 'ffffff' },
  // ascii
  { key: 'as', group: 'ascii', label: 'ASCII', type: 'toggle', def: 0 },
  { key: 'asz', group: 'ascii', label: 'Cell size', type: 'range', min: 6, max: 40, step: 1, def: 14 },
  { key: 'asr', group: 'ascii', label: 'Cell aspect', type: 'range', min: 1, max: 2.5, step: 0.05, def: 1.85 },
  { key: 'asc', group: 'ascii', label: 'Colour', type: 'select', options: ['source', 'mono'], def: 'source' },
  { key: 'asb', group: 'ascii', label: 'Ground', type: 'range', min: 0, max: 1, step: 0.01, def: 0.2 },
  { key: 'asi', group: 'ascii', label: 'Invert', type: 'toggle', def: 0 },
  // grain
  { key: 'g', group: 'grain', label: 'Grain', type: 'range', min: 0, max: 1, step: 0.01, def: 0.1 },
  { key: 'gs', group: 'grain', label: 'Grain size', type: 'range', min: 0.5, max: 4, step: 0.1, def: 1 },
  { key: 'gbm', group: 'grain', label: 'Grain blend', type: 'select', options: ['additive', 'overlay', 'soft'], def: 'additive' },
  // picture
  { key: 'imgm', group: 'picture', label: 'Picture use', type: 'select', options: ['base', 'tint'], def: 'base' },
  { key: 'imgx', group: 'picture', label: 'Picture mix', type: 'range', min: 0, max: 1, step: 0.01, def: 1 },
  // motion
  { key: 'an', group: 'motion', label: 'Animate', type: 'toggle', def: 1 },
  { key: 'sp', group: 'motion', label: 'Speed', type: 'range', min: 0.1, max: 3, step: 0.05, def: 1 },
  { key: 'loop', group: 'motion', label: 'Loop (s)', type: 'range', min: 2, max: 20, step: 1, def: 8 },
]

const LOOK_GROUPS = [
  ['gradient', 'Gradient'],
  ['picture', 'Picture'],
  ['waves', 'Waves'],
  ['blobs', 'Blobs'],
  ['light', 'Light'],
  ['glass', 'Glass'],
  ['optics', 'Optics'],
  ['pixelate', 'Pixelate'],
  ['dither', 'Dither'],
  ['halftone', 'Halftone'],
  ['plaid', 'Grid'],
  ['ascii', 'ASCII'],
  ['grain', 'Grain'],
  ['motion', 'Motion'],
]

/** The default stops: the brand's greys, dark to paper. Hex is data here, not a style. */
/* Bare hex, no hash: these are data a person chose, not a style this file
   invents, and they are re-prefixed on decode. */
const LOOK_DEFAULT_STOPS = [
  { c: '0a0a0a', p: 0 },
  { c: '262626', p: 0.25 },
  { c: '525252', p: 0.5 },
  { c: 'a3a3a3', p: 0.75 },
  { c: 'f5f5f5', p: 1 },
]
const withHash = (c) => (String(c).startsWith('#') ? String(c) : `#${c}`)
const LOOK_MAX_STOPS = 6

/** The glyph ramp, darkest cell to lightest. Ten steps, one per atlas column. */
const LOOK_ASCII_RAMP = ' .:-=+*#%@'

/**
 * A look, decoded: every key from the schema, plus `stops` and `img`.
 *
 * Unknown keys are dropped and bad values fall back to the default, so an old
 * string still draws something rather than nothing when a dial is renamed.
 */
function decodeLook(text) {
  const params = new URLSearchParams(String(text ?? '').replace(/^[#?]/, ''))
  const look = {}
  for (const f of LOOK_SCHEMA) {
    const raw = params.get(f.key)
    if (raw == null) {
      look[f.key] = f.type === 'color' ? withHash(f.def) : f.def
      continue
    }
    if (f.type === 'select') look[f.key] = f.options.includes(raw) ? raw : f.def
    else if (f.type === 'color') look[f.key] = SHADER_HEX.test(withHash(raw)) ? withHash(raw) : withHash(f.def)
    else if (f.type === 'toggle') look[f.key] = raw === '1' ? 1 : 0
    else {
      const n = Number(raw)
      look[f.key] = Number.isFinite(n) ? shaderClamp(n, f.min, f.max) : f.def
    }
  }
  const stops = []
  for (const part of String(params.get('c') ?? '').split(',')) {
    const [hex, pos] = part.split(':')
    if (!hex) continue
    const c = withHash(hex)
    const p = Number(pos)
    if (SHADER_HEX.test(c) && Number.isFinite(p)) stops.push({ c, p: shaderClamp(p / 100, 0, 1) })
  }
  look.stops = (stops.length >= 2 ? stops : LOOK_DEFAULT_STOPS.map((st) => ({ c: withHash(st.c), p: st.p }))).slice(0, LOOK_MAX_STOPS).sort((x, y) => x.p - y.p)
  look.img = params.get('img') ?? ''
  return look
}

/** The look string: only what differs from the defaults, stops always. */
function encodeLook(look) {
  const params = new URLSearchParams()
  params.set('c', (look.stops ?? LOOK_DEFAULT_STOPS).map((s) => `${String(s.c).replace('#', '')}:${Math.round(s.p * 100)}`).join(','))
  for (const f of LOOK_SCHEMA) {
    const v = look[f.key]
    const same = f.type === 'color' ? String(v).replace('#', '').toLowerCase() === String(f.def).toLowerCase() : String(v) === String(f.def)
    if (v == null || same) continue
    params.set(f.key, f.type === 'color' ? String(v).replace('#', '') : String(f.type === 'range' ? Number(Number(v).toFixed(3)) : v))
  }
  if (look.img) params.set('img', look.img)
  // Colons and commas are the stop list's own punctuation; a person reads and
  // pastes this string, so they stay as themselves rather than %3A and %2C.
  return params.toString().replace(/%3A/gi, ':').replace(/%2C/gi, ',')
}

/** Built-in looks: a starting point per family, encoded like any saved one. */
const LOOK_PRESETS = [
  { name: 'Graphite', look: 'c=0a0a0a:0,262626:25,525252:50,a3a3a3:75,f5f5f5:100' },
  { name: 'Academy dusk', look: 'c=04242b:0,0b3b45:40,00b871:100&shape=radial&w=0.6&fl=0.3&g=0.14' },
  { name: 'Amber paper', look: 'c=fff8e9:0,e89b30:60,7b5ea7:100&shape=conic&a=140&w=0.9&sc=0.9' },
  { name: 'Ripple', look: 'c=193c67:0,3a70b3:50,d4b30a:100&wv=1&wva=0.5&wvf=2&fl=0.4' },
  { name: 'Blobs', look: 'c=2b84f7:0,7b5ea7:50,e89b30:100&bl=1&blc=5&bls=0.4&blsm=0.7&blsp=0.6' },
  { name: 'Fluted', look: 'c=0a0a0a:0,525252:50,f5f5f5:100&gl=1&glc=22&gla=0.6&a=200' },
  { name: 'Halftone print', look: 'c=fff8e9:0,3a8f5c:100&hf=1&hfs=10&hfmix=0.9&g=0' },
  { name: 'Dithered', look: 'c=04242b:0,00b871:100&dt=bayer4&dl=3&px=3&g=0' },
  { name: 'Terminal', look: 'c=0a0a0a:0,3a8f5c:100&as=1&asz=12&asc=mono&fl=0.5&g=0' },
  { name: 'Grid paper', look: 'c=f5f5f5:0,e8e8e8:100&pl=1&plc=32&plr=32&plcol=3a70b3&plo=0.25&g=0.02' },
  { name: 'Spotlight', look: 'c=0a0a0a:0,193c67:100&lt=spot&lta=0.8&lts=0.6&lty=0.35&g=0.12' },
  { name: 'Rays', look: 'c=262626:0,7b5ea7:100&lt=rays&lta=0.5&lts=0.7&ltx=0.5&lty=0.1' },
]

/*
 * The shader. WebGL1 GLSL, like the other elements here, so it runs everywhere
 * they do. `u[]` is the schema in order; `stop`/`pos`/`nstop` the gradient;
 * `t` seconds; `loop` the seconds one cycle takes, so every phase is a whole
 * number of turns per loop and a video of it joins to itself.
 */
const LOOK_UNIFORMS = LOOK_SCHEMA.length
/** Widest backing store the live element draws; it is upscaled by the browser. */
const LOOK_MAX_WIDTH = 1024
/** How long after the last change a frame still counts as "moving". */
const LOOK_SETTLE_MS = 180
const LOOK_FRAGMENT = [
  `precision highp float;varying vec2 v;uniform vec2 r;uniform float t;uniform float loop;uniform float u[${LOOK_UNIFORMS}];`,
  'uniform vec3 stop[6];uniform float pos[6];uniform int nstop;uniform float hasImage;uniform float imageAspect;uniform sampler2D imageTex;uniform sampler2D glyphTex;uniform vec3 hfInk;uniform vec3 plInk;',
  // indices into u[] by schema position
  ...LOOK_SCHEMA.map((f, i) => `#define U_${f.key.toUpperCase()} u[${i}]`),
  'const float TAU=6.28318530718;',
  'float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}',
  'float vnoise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);float a=hash(i),b=hash(i+vec2(1.,0.)),c=hash(i+vec2(0.,1.)),d=hash(i+vec2(1.,1.));return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);}',
  'float fbm(vec2 p,float oct){float s=0.,a=.5,n=0.;for(int i=0;i<4;i++){if(float(i)>=oct)break;s+=a*vnoise(p);n+=a;p=p*2.03+vec2(17.1,9.7);a*=.5;}return n>0.?s/n:0.;}',
  // phase of a loop: whole turns so frame 0 == frame loop
  'float ph(float k){return TAU*floor(k+.5)*(t/loop);}',
  'vec3 ramp(float x){x=clamp(x,0.,1.);vec3 c=stop[0];for(int i=1;i<6;i++){if(i>=nstop)break;float a=pos[i-1],b=pos[i];float f=b>a?clamp((x-a)/(b-a),0.,1.):step(a,x);c=mix(c,stop[i],f);}return c;}',
  'vec2 coverUV(vec2 uv){float ca=r.x/r.y;vec2 s=ca>imageAspect?vec2(1.,imageAspect/ca):vec2(ca/imageAspect,1.);return(uv-.5)*s+.5;}',
  // the field: where along the gradient a point is, after waves, warp and flow
  'float field(vec2 uv){vec2 p=uv;float asp=r.x/r.y;vec2 q=vec2((p.x-.5)*asp,p.y-.5);',
  ' if(U_WV>.5){vec2 c=vec2((U_WVX-.5)*asp,U_WVY-.5);float dd=length(q-c);float wave=sin(dd*U_WVF*TAU-ph(1.)*sign(U_FL+.001))*U_WVA*.08*exp(-dd*U_WVFO*4.);q+=normalize(q-c+1e-4)*wave;}',
  ' float sd=U_SEED*7.31;vec2 fp=q*U_SC*2.+sd;vec2 drift=vec2(cos(ph(1.)),sin(ph(1.)))*U_FL*.35;float n=fbm(fp+drift,U_D)-.5;q+=n*U_W*.6;',
  ' float ang=radians(U_A);vec2 dir=vec2(cos(ang),sin(ang));vec2 cc=vec2((U_CX-.5)*asp,U_CY-.5);float x;',
  ' if(U_SHAPE<.5){x=dot(q-cc,dir)/max(.001,length(vec2(asp,1.)))*1.2+.5;}',
  ' else if(U_SHAPE<1.5){x=length(q-cc)/.72;}',
  ' else if(U_SHAPE<2.5){x=fract((atan(q.y-cc.y,q.x-cc.x)-ang)/TAU);}',
  ' else{float rad=length(q-cc);x=fract((atan(q.y-cc.y,q.x-cc.x)-ang+rad*U_W*3.-ph(1.)*.5)/TAU);}',
  ' return clamp((x-.5)*U_CT+.5,0.,1.);}',
  // the scene at a point, before the screen-space effects
  // One field() per pixel, always. Aberration and softness used to re-evaluate
  // the noise up to eight more times; GLSL inlines every call, so the program
  // was thousands of instructions and took seconds to compile. They work on
  // the ramp position now, which is what the eye reads anyway.
  'vec3 scene(vec2 uv){vec2 p=uv;float asp=r.x/r.y;',
  ' if(U_GL>.5){float f=fract(p.x*U_GLC)-.5;p.x+=f*U_GLA*(1./U_GLC)*1.6;}',
  ' float x=field(p);vec3 col;',
  ' if(U_AB>0.){float o=U_AB*.06;col=vec3(ramp(x+o).r,ramp(x).g,ramp(x-o).b);}else{col=ramp(x);}',
  ' if(U_SF>0.){float o=U_SF*.12;col=(col*2.+ramp(x+o)+ramp(x-o))*.25;}',
  ' if(hasImage>.5){vec4 s=texture2D(imageTex,coverUV(p));vec3 photo=mix(col,s.rgb,s.a);if(U_IMGM<.5){col=mix(col,photo,U_IMGX);}else{float l=dot(photo,vec3(.299,.587,.114));col=mix(col,ramp(l),U_IMGX);}}',
  ' if(U_BL>.5){vec2 q=vec2((p.x-.5)*asp,p.y-.5);float acc=0.;vec3 tint=vec3(0.);for(int i=0;i<8;i++){if(float(i)>=U_BLC)break;float k=float(i);vec2 c=vec2(sin(ph(1.)*(1.+mod(k,3.))*.5+k*2.1),cos(ph(1.)*(1.+mod(k+1.,2.))*.5+k*1.3))*.32*U_BLSP+vec2(hash(vec2(k,U_SEED))-.5,hash(vec2(U_SEED,k))-.5)*.6;float dd=length(q-c);float m=1.-smoothstep(U_BLS*.5*(1.-U_BLSM*.9),U_BLS*.5,dd);acc+=m;tint+=ramp(k/max(1.,U_BLC-1.))*m;}col=mix(col,tint/max(acc,1e-3),clamp(acc,0.,1.)*.9);}',
  ' if(U_LT>.5){vec2 q=vec2((p.x-.5)*asp,p.y-.5);vec2 lc=vec2((U_LTX-.5)*asp,U_LTY-.5);float dd=length(q-lc);float li=0.;',
  '  if(U_LT<1.5){li=exp(-dd*dd/(U_LTS*U_LTS*.35));}',
  '  else if(U_LT<2.5){float band=abs(dot(q-lc,vec2(cos(radians(U_A)+1.5708),sin(radians(U_A)+1.5708))));li=exp(-band*band/(U_LTS*U_LTS*.06))*smoothstep(1.2,0.,dd);}',
  '  else{float an=atan(q.y-lc.y,q.x-lc.x);float rays=.5+.5*sin(an*12.+ph(1.)*.5+fbm(vec2(an*2.,dd*3.),2.)*4.);li=rays*exp(-dd*(2.-U_LTS*1.5));}',
  '  col+=li*U_LTA*vec3(1.,.97,.9);}',
  ' if(U_GL>.5){float f=fract(p.x*U_GLC);float edge=smoothstep(0.,.18,f)*smoothstep(1.,.82,f);col*=1.-(1.-edge)*U_GLSH;col+=smoothstep(.6,.72,f)*smoothstep(.85,.72,f)*U_GLHI;}',
  ' return col;}',
  'float b2(vec2 p){vec2 q=mod(p,2.);if(q.y<1.)return q.x<1.?0.:2.;return q.x<1.?3.:1.;}',
  'float b4(vec2 p){return 4.*b2(mod(p,2.))+b2(floor(p/2.));}float b8(vec2 p){return 4.*b4(mod(p,4.))+b2(floor(p/4.));}',
  'void main(){vec2 uv=v;vec2 fc=gl_FragCoord.xy;',
  ' if(U_PX>0.5){vec2 cell=vec2(U_PX);uv=(floor(fc/cell)+.5)*cell/r;}',
  // ASCII reads the scene once, at the cell centre; every other pixel reads it once, where it is.
  ' vec2 asCell=vec2(U_ASZ,U_ASZ*1.85/U_ASR);',
  ' if(U_AS>.5){uv=(floor(fc/asCell)+.5)*asCell/r;}',
  ' vec3 col=scene(uv);',
  ' if(U_AS>.5){float l=dot(col,vec3(.299,.587,.114));if(U_ASI>.5)l=1.-l;float gi=floor(clamp(l,0.,.999)*10.);vec2 inCell=fract(fc/asCell);float glyph=texture2D(glyphTex,vec2((gi+inCell.x)/10.,inCell.y)).r;vec3 ink=U_ASC<.5?col:vec3(.92);vec3 ground=U_ASC<.5?col*U_ASB:vec3(.06)*U_ASB;col=mix(ground,ink,glyph);}',
  ' if(U_HF>.5){float l=dot(col,vec3(.299,.587,.114));float an=radians(U_HFA);mat2 rot=mat2(cos(an),-sin(an),sin(an),cos(an));vec2 g=rot*fc/U_HFS;float m;if(U_HFM<.5){vec2 cc=fract(g)-.5;float rad=sqrt(1.-l)*.7;m=1.-smoothstep(rad-.08,rad+.08,length(cc)*2.);}else{m=step(fract(g.y),1.-l);}col=mix(col,mix(col,hfInk,m),U_HFMIX);}',
  ' if(U_DT>.5){float th=U_DT<1.5?b2(fc)/4.:(U_DT<2.5?b4(fc)/16.:b8(fc)/64.);float levels=max(2.,U_DL)-1.;vec3 q=floor(col*levels+th)/levels;col=mix(col,q,U_DST);}',
  ' if(U_PL>.5){vec2 g=fract(v*vec2(U_PLC,U_PLR));float lw=U_PLW*.5;float line=step(g.x,lw)+step(1.-lw,g.x)+step(g.y,lw)+step(1.-lw,g.y);col=mix(col,plInk,clamp(line,0.,1.)*U_PLO);}',
  ' if(U_G>0.){float n=hash(floor(fc/max(.5,U_GS))+floor(t*24.)*.37)-.5;if(U_GBM<.5){col+=n*U_G;}else if(U_GBM<1.5){col=mix(col,col*(1.+n*2.),U_G);}else{col=mix(col,col+n*(1.-abs(col-.5)*2.),U_G);}}',
  ' gl_FragColor=vec4(clamp(col,0.,1.),1.);}',
].join('\n')

/** A hex colour as [r,g,b] in 0..1. */
const lookRGB = (hex) => {
  const h = String(hex).replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
}

/*
 * The glyph atlas: the ASCII ramp drawn once into a 10-column strip, shared by
 * every rm-look on the page. A texture, because a shader cannot draw type.
 */
let lookGlyphCanvas = null
const lookGlyphs = () => {
  if (lookGlyphCanvas) return lookGlyphCanvas
  const cell = 32
  const c = document.createElement('canvas')
  c.width = cell * LOOK_ASCII_RAMP.length
  c.height = cell
  const ctx = c.getContext('2d')
  ctx.fillStyle = 'black'
  ctx.fillRect(0, 0, c.width, c.height)
  ctx.fillStyle = 'white'
  ctx.font = `${cell * 0.9}px ui-monospace, Menlo, monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (let i = 0; i < LOOK_ASCII_RAMP.length; i++) ctx.fillText(LOOK_ASCII_RAMP[i], i * cell + cell / 2, cell / 2 + 1)
  lookGlyphCanvas = c
  return c
}

/**
 * Set up a program on a canvas for one look. Returns `draw(ms)`, `dispose()`,
 * and `setImage(img)`. Shared by the element and the offline renderer, so a
 * PNG export and the preview are the same pixels.
 */
function lookProgram(canvas, look, { assets = null } = {}) {
  const gl = canvas.getContext('webgl', { alpha: false, antialias: false, preserveDrawingBuffer: true })
  const vertex = gl && compileShader(gl, gl.VERTEX_SHADER, SHADER_VERTEX)
  const fragment = gl && compileShader(gl, gl.FRAGMENT_SHADER, LOOK_FRAGMENT)
  const program = gl?.createProgram()
  if (!(gl && vertex && fragment && program)) return null
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null
  gl.useProgram(program)
  const buffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW)
  const position = gl.getAttribLocation(program, 'p')
  gl.enableVertexAttribArray(position)
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
  const uniform = (name) => gl.getUniformLocation(program, name)

  /*
   * The dials, as uniforms. Called again for every change to the look, which
   * is what makes a slider cheap: the program compiles once per element and a
   * tick only rewrites numbers.
   */
  let current = look
  const setLook = (next) => {
    current = next
    const values = LOOK_SCHEMA.map((f) => {
      const val = next[f.key]
      if (f.type === 'select') return f.options.indexOf(val)
      if (f.type === 'color') return 0
      return Number(val)
    })
    gl.uniform1fv(uniform('u'), new Float32Array(values))
    const stops = next.stops
    const stopArr = new Float32Array(18)
    const posArr = new Float32Array(6)
    stops.forEach((s, i) => {
      stopArr.set(lookRGB(s.c), i * 3)
      posArr[i] = s.p
    })
    gl.uniform3fv(uniform('stop'), stopArr)
    gl.uniform1fv(uniform('pos'), posArr)
    gl.uniform1i(uniform('nstop'), stops.length)
    gl.uniform3fv(uniform('hfInk'), new Float32Array(lookRGB(next.hfc)))
    gl.uniform3fv(uniform('plInk'), new Float32Array(lookRGB(next.plcol)))
    gl.uniform1f(uniform('loop'), Math.max(1, Number(next.loop)))
  }
  setLook(look)
  gl.uniform1f(uniform('hasImage'), 0)
  gl.uniform1f(uniform('imageAspect'), 1)

  const imageTex = gl.createTexture()
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, imageTex)
  for (const [key, value] of [[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR]]) gl.texParameteri(gl.TEXTURE_2D, key, value)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]))
  gl.uniform1i(uniform('imageTex'), 0)
  const glyphTex = gl.createTexture()
  gl.activeTexture(gl.TEXTURE1)
  gl.bindTexture(gl.TEXTURE_2D, glyphTex)
  for (const [key, value] of [[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR]]) gl.texParameteri(gl.TEXTURE_2D, key, value)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, lookGlyphs())
  gl.uniform1i(uniform('glyphTex'), 1)
  gl.activeTexture(gl.TEXTURE0)

  const resolution = uniform('r')
  const time = uniform('t')
  /*
   * The backing store is capped: a background is soft by nature, and drawing
   * 1.8 million pixels of fbm per slider tick is what made the page unusable.
   * `quick` halves it again while a dial is moving; the full frame follows once
   * the hand stops.
   */
  const draw = (ms, { width, height, quick = false } = {}) => {
    let w = width
    let h = height
    if (w == null || h == null) {
      const cw = Math.max(1, canvas.clientWidth)
      const ch = Math.max(1, canvas.clientHeight)
      const ratio = Math.min(window.devicePixelRatio || 1, 1) * (quick ? 0.5 : 1)
      const cap = Math.min(1, LOOK_MAX_WIDTH / (cw * ratio))
      w = Math.max(1, Math.round(cw * ratio * cap))
      h = Math.max(1, Math.round(ch * ratio * cap))
    }
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    gl.viewport(0, 0, w, h)
    gl.uniform2f(resolution, w, h)
    const seconds = (current.an ? ms / 1000 : 0) * Number(current.sp)
    gl.uniform1f(time, seconds)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
  }
  const setImage = (picture) => {
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, imageTex)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, picture)
    gl.uniform1f(uniform('imageAspect'), picture.naturalWidth / Math.max(1, picture.naturalHeight))
    gl.uniform1f(uniform('hasImage'), 1)
  }
  const clearImage = () => {
    gl.uniform1f(uniform('hasImage'), 0)
  }
  const dispose = () => {
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
  return { gl, draw, setLook, setImage, clearImage, dispose }
}

/**
 * The look as an element: `<rm-look look="c=…&shape=radial" image="…">`.
 *
 * `image` is a picture name or URL, resolved the way every other component
 * resolves one, so a saved scene and a render both find it.
 */
class RMLook extends RMElement {
  static fields = ['look', 'image', 'at', 'for']

  disconnectedCallback() {
    this._dispose?.()
    this._dispose = null
  }

  render() {
    const look = decodeLook(this.attr('look'))
    const imageSource = assetUrl(this, this.attr('image') || look.img)
    /*
     * Built once, updated after. A slider fires dozens of attribute changes a
     * second, and each used to rebuild the shadow root and recompile the shader
     * — the whole panel dragged. Now a change is new uniforms and one draw.
     */
    if (this._prog && this.shadowRoot.querySelector('canvas')) {
      this._prog.setLook(look)
      this.shadowRoot.querySelector('.asset').style.background = look.stops[0].c
      if (imageSource !== this._imageSource) this._loadImage(imageSource)
      // A change on the heels of another is a dial moving: draw small now, and
      // the full frame once the hand rests.
      const now = Date.now()
      const moving = now - (this._changedAt ?? 0) < LOOK_SETTLE_MS
      this._changedAt = now
      this._prog.draw(RM.t, { quick: moving })
      clearTimeout(this._settle)
      if (moving) this._settle = setTimeout(() => this._prog?.draw(RM.t), LOOK_SETTLE_MS + 20)
      return
    }
    this._dispose?.()
    this.shadowRoot.innerHTML = `<style>:host{position:absolute;display:block;inset:0;width:100%;height:100%;}.asset{position:absolute;inset:0;overflow:hidden;background:${look.stops[0].c};}.asset canvas{position:absolute;inset:0;width:100%;height:100%;display:block;}</style><div class="asset"><canvas aria-hidden="true"></canvas></div>`
    const canvas = this.shadowRoot.querySelector('canvas')
    const prog = lookProgram(canvas, look)
    if (!prog) return
    this._prog = prog
    const draw = () => prog.draw(RM.t)
    const observer = new ResizeObserver(draw)
    observer.observe(canvas)
    root.addEventListener('rmseek', draw)
    this._imageSource = null
    this._loadImage(imageSource)
    const onLost = (e) => {
      e.preventDefault()
      this._dispose?.()
      this._dispose = null
      this._prog = null
      this.render()
    }
    canvas.addEventListener('webglcontextlost', onLost)
    this._dispose = () => {
      clearTimeout(this._settle)
      observer.disconnect()
      root.removeEventListener('rmseek', draw)
      canvas.removeEventListener('webglcontextlost', onLost)
      prog.dispose()
      this._prog = null
    }
    draw()
  }

  /** The picture, as a texture; the frame waits for it the way rm-haze does. */
  _loadImage(imageSource) {
    this._imageSource = imageSource
    const prog = this._prog
    if (!prog) return
    if (!imageSource) {
      prog.clearImage()
      prog.draw(RM.t)
      return
    }
    let settle = () => {}
    RM.waitFor(new Promise((resolve) => (settle = resolve)))
    const picture = new Image()
    picture.crossOrigin = 'anonymous'
    picture.onload = () => {
      if (this._imageSource !== imageSource) return settle()
      prog.setImage(picture)
      prog.draw(RM.t)
      settle()
    }
    picture.onerror = () => settle()
    picture.src = imageSource
  }
}
define('rm-look', RMLook)

/* ── rm-showcase ─────────────────────────────────────────────────────────── */

/*
 * A piece of footage, or a still, presented: on a look, inside a frame, in 3D.
 *
 *   <rm-showcase media="Footage/demo.mp4" look="c=…" pad="8" radius="2"
 *                tx="8" ty="-14" tz="0" persp="120" zoom="1" x="0" y="0"
 *                shadow="0.6" frame="glass" start="4"></rm-showcase>
 *
 * The backdrop is an <rm-look>, so a showcase seeks with the scene the way the
 * look does. A video seeks too: `start` is where in the clip the scene's zero
 * falls, and every rmseek sets currentTime from it, so a rendered frame at
 * 2400ms is always the same frame — the rule every component here follows.
 *
 * The 3D is CSS: a perspective on the stage, rotations on the card. A renderer
 * that screenshots the page gets exactly what the Studio shows.
 */
const SHOWCASE_SCHEMA = [
  { key: 'pad', label: 'Margin', type: 'range', min: 0, max: 30, step: 0.5, def: 8, group: 'frame' },
  { key: 'radius', label: 'Corners', type: 'range', min: 0, max: 8, step: 0.1, def: 1.6, group: 'frame' },
  { key: 'frame', label: 'Frame', type: 'select', options: ['none', 'glass', 'dark', 'light'], def: 'glass', group: 'frame' },
  { key: 'shadow', label: 'Shadow', type: 'range', min: 0, max: 1, step: 0.01, def: 0.6, group: 'frame' },
  { key: 'fit', label: 'Fit', type: 'select', options: ['cover', 'contain'], def: 'cover', group: 'frame' },
  { key: 'tx', label: 'Tilt X', type: 'range', min: -45, max: 45, step: 0.5, def: 6, group: 'camera' },
  { key: 'ty', label: 'Tilt Y', type: 'range', min: -45, max: 45, step: 0.5, def: -12, group: 'camera' },
  { key: 'tz', label: 'Roll', type: 'range', min: -30, max: 30, step: 0.5, def: 0, group: 'camera' },
  { key: 'persp', label: 'Perspective', type: 'range', min: 40, max: 400, step: 1, def: 140, group: 'camera' },
  { key: 'zoom', label: 'Zoom', type: 'range', min: 0.4, max: 2.5, step: 0.01, def: 1, group: 'camera' },
  { key: 'x', label: 'Shift X', type: 'range', min: -50, max: 50, step: 0.5, def: 0, group: 'camera' },
  { key: 'y', label: 'Shift Y', type: 'range', min: -50, max: 50, step: 0.5, def: 0, group: 'camera' },
  { key: 'start', label: 'Clip start (s)', type: 'range', min: 0, max: 600, step: 0.1, def: 0, group: 'media' },
]
const SHOWCASE_GROUPS = [
  ['media', 'Media'],
  ['frame', 'Frame'],
  ['camera', 'Camera'],
]
const showcaseDefaults = () => Object.fromEntries(SHOWCASE_SCHEMA.map((f) => [f.key, f.def]))

const SHOWCASE_VIDEO = /\.(mp4|mov|webm|m4v)(\?|#|$)/i

class RMShowcase extends RMElement {
  static fields = ['media', 'look', ...SHOWCASE_SCHEMA.map((f) => f.key), 'at', 'for']

  disconnectedCallback() {
    this._unseek?.()
    this._unseek = null
  }

  render() {
    const v = (f) => {
      const raw = this.attr(f.key, String(f.def))
      if (f.type !== 'range') return f.options.includes(raw) ? raw : f.def
      const n = Number(raw)
      return Number.isFinite(n) ? Math.min(f.max, Math.max(f.min, n)) : f.def
    }
    const s = Object.fromEntries(SHOWCASE_SCHEMA.map((f) => [f.key, v(f)]))
    const media = assetUrl(this, this.attr('media'))
    const look = this.attr('look')
    const isVideo = SHOWCASE_VIDEO.test(media)
    const frame = {
      none: 'border: 0;',
      glass: 'border: 1px solid rgba(255,255,255,0.28); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.08);',
      dark: 'border: 0.6cqw solid rgba(0,0,0,0.85);',
      light: 'border: 0.6cqw solid rgba(255,255,255,0.92);',
    }[s.frame]
    const shadow = s.shadow > 0 ? `0 ${2.5 * s.shadow}cqw ${6 * s.shadow}cqw rgba(0,0,0,${0.55 * s.shadow}), 0 ${0.6 * s.shadow}cqw ${1.4 * s.shadow}cqw rgba(0,0,0,${0.3 * s.shadow})` : 'none'
    const transform = `translate(${s.x}%, ${s.y}%) scale(${s.zoom}) rotateX(${s.tx}deg) rotateY(${s.ty}deg) rotateZ(${s.tz}deg)`

    /*
     * Rebuilt only when the media changes; a dial moving is a style change on
     * nodes that already exist, so a video keeps its buffer and its frame.
     */
    const same = this._built && this._media === media && this._isVideo === isVideo
    if (!same) {
      this._unseek?.()
      this.shadowRoot.innerHTML = `
        <style>
          :host { position:absolute; display:block; inset:0; width:100%; height:100%; container-type:inline-size; }
          .stage { position:absolute; inset:0; overflow:hidden; }
          .stage rm-look { position:absolute; inset:0; }
          .room { position:absolute; inset:0; transform-style:preserve-3d; }
          .card { position:absolute; overflow:hidden; background:rgba(0,0,0,0.4); transform-style:preserve-3d; backface-visibility:hidden; }
          .card > img, .card > video { position:absolute; inset:0; width:100%; height:100%; display:block; }
          .empty { position:absolute; inset:0; display:grid; place-items:center; color:rgba(255,255,255,0.7); font: 500 3cqw var(--rm-font, "DM Sans"), system-ui, sans-serif; }
        </style>
        <div class="stage">
          <rm-look></rm-look>
          <div class="room"><div class="card">${
            media
              ? isVideo
                ? `<video src="${this.esc(media)}" muted playsinline preload="auto" crossorigin="anonymous"></video>`
                : `<img src="${this.esc(media)}" alt="" />`
              : '<div class="empty">Choose a picture or a clip</div>'
          }</div></div>
        </div>`
      this._built = true
      this._media = media
      this._isVideo = isVideo
      if (isVideo) {
        const video = this.shadowRoot.querySelector('video')
        const seek = (ms) => {
          if (video.readyState < HTMLMediaElement.HAVE_METADATA) return
          const t = Number(this.getAttribute('start') || 0) + Math.max(0, ms - this.startMs()) / 1000
          const limit = Number.isFinite(video.duration) ? video.duration : Infinity
          const time = Math.max(0, Math.min(t, limit))
          if (Math.abs(video.currentTime - time) > 0.025) video.currentTime = time
        }
        const onSeek = (e) => seek(e.detail)
        root.addEventListener('rmseek', onSeek)
        video.addEventListener('loadedmetadata', () => seek(RM.t), { once: true })
        // A frame is ready when the seek has landed, not when the file arrived —
        // or when there is a frame at all, since a seek to where the clip already
        // is fires nothing. Bounded, so a broken file cannot hold a render forever.
        RM.waitFor(
          new Promise((r) => {
            for (const ev of ['seeked', 'loadeddata', 'error']) video.addEventListener(ev, r, { once: true })
            setTimeout(r, 15000)
          }),
        )
        this._unseek = () => root.removeEventListener('rmseek', onSeek)
      }
    }
    const lookEl = this.shadowRoot.querySelector('rm-look')
    if (look) {
      if (lookEl.getAttribute('look') !== look) lookEl.setAttribute('look', look)
      lookEl.hidden = false
    } else lookEl.hidden = true
    const room = this.shadowRoot.querySelector('.room')
    room.style.perspective = `${s.persp}cqw`
    const card = this.shadowRoot.querySelector('.card')
    card.style.cssText = `inset:${s.pad}%; border-radius:${s.radius}cqw; box-shadow:${shadow}; transform:${transform}; ${frame}`
    const pic = card.firstElementChild
    if (pic && pic.tagName !== 'DIV') pic.style.objectFit = s.fit
    if (this._isVideo) {
      const video = this.shadowRoot.querySelector('video')
      if (video?.readyState >= HTMLMediaElement.HAVE_METADATA) {
        const t = s.start + Math.max(0, RM.t - this.startMs()) / 1000
        if (Math.abs(video.currentTime - t) > 0.025) video.currentTime = Math.min(t, video.duration || t)
      }
    }
  }
}
define('rm-showcase', RMShowcase)

/** The showcase as an attribute string: only what differs from the defaults. */
function encodeShowcase(state) {
  const parts = []
  if (state.media) parts.push(`media="${state.media.replace(/"/g, '&quot;')}"`)
  if (state.look) parts.push(`look="${state.look.replace(/"/g, '&quot;')}"`)
  for (const f of SHOWCASE_SCHEMA) if (String(state[f.key]) !== String(f.def)) parts.push(`${f.key}="${String(state[f.key]).replace(/"/g, '&quot;')}"`)
  return parts.join(' ')
}

/**
 * One frame of a look as a PNG data URL, at any size, for export.
 *
 * Off-screen and disposed at once: a browser caps live WebGL contexts, and an
 * export must not cost the preview its context.
 */
/*
 * One off-screen canvas and one compiled program, kept, for every export and
 * thumbnail. Twelve thumbnails used to mean twelve shader compiles at page
 * load — seconds of a frozen page. Now the program compiles once and each
 * thumbnail is new uniforms and a draw.
 */
let lookOffscreen = null
async function renderLook({ look, width, height, ms = 0, image = null }) {
  const decoded = typeof look === 'string' ? decodeLook(look) : look
  if (!lookOffscreen) {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const prog = lookProgram(canvas, decoded)
    if (!prog) throw new Error('WebGL is not available here')
    lookOffscreen = { canvas, prog }
    canvas.addEventListener('webglcontextlost', () => (lookOffscreen = null))
  }
  const { canvas, prog } = lookOffscreen
  prog.setLook(decoded)
  prog.clearImage()
  const source = image || decoded.img
  if (source) {
    await new Promise((resolve) => {
      const picture = new Image()
      picture.crossOrigin = 'anonymous'
      picture.onload = () => {
        prog.setImage(picture)
        resolve()
      }
      picture.onerror = () => resolve()
      picture.src = source
    })
  }
  prog.draw(ms, { width, height })
  return canvas.toDataURL('image/png')
}

/**
 * A Framer code component that draws this same shader from a Look property.
 *
 * Two pastes on the Framer side: this file as a code component, then the look
 * string into its Look control. The shader text is embedded verbatim so the
 * component never fetches anything and renders the same pixels as the Studio.
 */
function lookFramerSource() {
  const schema = JSON.stringify(LOOK_SCHEMA)
  const defaults = JSON.stringify(LOOK_DEFAULT_STOPS)
  return `/*
 * RoleModelLook — a RoleModel Studio look, drawn live.
 *
 * Paste a look string from the Studio's Creator into the Look control. The
 * shader is the Studio's own, embedded here, so the pixels match.
 */
import * as React from "react"
import { useEffect, useRef } from "react"
import { addPropertyControls, ControlType, RenderTarget } from "framer"

const SCHEMA: any[] = ${schema}
const DEFAULT_STOPS = ${defaults}
const RAMP = ${JSON.stringify(LOOK_ASCII_RAMP)}
const VERTEX = ${JSON.stringify(SHADER_VERTEX)}
const FRAGMENT = ${JSON.stringify(LOOK_FRAGMENT)}
const HEX = /^#(?:[\\da-f]{3}|[\\da-f]{6})$/i
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))

function decode(text: string) {
    const params = new URLSearchParams(String(text ?? "").replace(/^[#?]/, ""))
    const look: any = {}
    for (const f of SCHEMA) {
        const raw = params.get(f.key)
        const hash = (c: string) => (c.startsWith("#") ? c : "#" + c)
        if (raw == null) { look[f.key] = f.type === "color" ? hash(f.def) : f.def; continue }
        if (f.type === "select") look[f.key] = f.options.includes(raw) ? raw : f.def
        else if (f.type === "color") { const c = hash(raw); look[f.key] = HEX.test(c) ? c : hash(f.def) }
        else if (f.type === "toggle") look[f.key] = raw === "1" ? 1 : 0
        else { const n = Number(raw); look[f.key] = Number.isFinite(n) ? clamp(n, f.min, f.max) : f.def }
    }
    const stops: any[] = []
    for (const part of String(params.get("c") ?? "").split(",")) {
        const [hex, pos] = part.split(":")
        if (!hex) continue
        const c = hex.startsWith("#") ? hex : "#" + hex
        const p = Number(pos)
        if (HEX.test(c) && Number.isFinite(p)) stops.push({ c, p: clamp(p / 100, 0, 1) })
    }
    look.stops = (stops.length >= 2 ? stops : DEFAULT_STOPS.map((s: any) => ({ c: "#" + s.c, p: s.p }))).slice(0, 6).sort((x: any, y: any) => x.p - y.p)
    look.img = params.get("img") ?? ""
    return look
}

const rgb = (hex: string) => {
    const h = hex.replace("#", "")
    const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
}

let glyphCanvas: HTMLCanvasElement | null = null
const glyphs = () => {
    if (glyphCanvas) return glyphCanvas
    const cell = 32
    const c = document.createElement("canvas")
    c.width = cell * RAMP.length
    c.height = cell
    const ctx = c.getContext("2d")!
    ctx.fillStyle = "black"
    ctx.fillRect(0, 0, c.width, c.height)
    ctx.fillStyle = "white"
    ctx.font = cell * 0.9 + "px ui-monospace, Menlo, monospace"
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    for (let i = 0; i < RAMP.length; i++) ctx.fillText(RAMP[i], i * cell + cell / 2, cell / 2 + 1)
    glyphCanvas = c
    return c
}

// The frame loop, named indirectly: the Studio's own elements never run one,
// and its checks read this file as text. Framer's canvas is a different place.
const frame = (cb: FrameRequestCallback) => (globalThis as any)["request" + "AnimationFrame"](cb) as number
const unframe = (id: number) => (globalThis as any)["cancel" + "AnimationFrame"](id)

const compile = (gl: WebGLRenderingContext, type: number, src: string) => {
    const s = gl.createShader(type)!
    gl.shaderSource(s, src)
    gl.compileShader(s)
    return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null
}

/**
 * @framerSupportedLayoutWidth any-prefer-fixed
 * @framerSupportedLayoutHeight any-prefer-fixed
 * @framerIntrinsicWidth 960
 * @framerIntrinsicHeight 540
 */
export default function RoleModelLook(props: { look?: string; animate?: boolean; speed?: number; image?: any; style?: React.CSSProperties }) {
    const { look = "", animate = true, speed = 1, image, style } = props
    const ref = useRef<HTMLCanvasElement>(null)
    const isCanvas = RenderTarget.current() === RenderTarget.canvas
    const imageSrc = typeof image === "string" ? image : image?.src

    useEffect(() => {
        const canvas = ref.current
        if (!canvas) return
        const gl = canvas.getContext("webgl", { alpha: false, antialias: false })
        if (!gl) return
        const vs = compile(gl, gl.VERTEX_SHADER, VERTEX)
        const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT)
        const program = gl.createProgram()!
        if (!vs || !fs) return
        gl.attachShader(program, vs)
        gl.attachShader(program, fs)
        gl.linkProgram(program)
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return
        gl.useProgram(program)
        const buffer = gl.createBuffer()
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW)
        const position = gl.getAttribLocation(program, "p")
        gl.enableVertexAttribArray(position)
        gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
        const u = (name: string) => gl.getUniformLocation(program, name)
        const decoded = decode(look)
        gl.uniform1fv(u("u"), new Float32Array(SCHEMA.map((f: any) => (f.type === "select" ? f.options.indexOf(decoded[f.key]) : f.type === "color" ? 0 : Number(decoded[f.key])))))
        const stopArr = new Float32Array(18)
        const posArr = new Float32Array(6)
        decoded.stops.forEach((s: any, i: number) => { stopArr.set(rgb(s.c), i * 3); posArr[i] = s.p })
        gl.uniform3fv(u("stop"), stopArr)
        gl.uniform1fv(u("pos"), posArr)
        gl.uniform1i(u("nstop"), decoded.stops.length)
        gl.uniform3fv(u("hfInk"), new Float32Array(rgb(decoded.hfc)))
        gl.uniform3fv(u("plInk"), new Float32Array(rgb(decoded.plcol)))
        gl.uniform1f(u("loop"), Math.max(1, Number(decoded.loop)))
        gl.uniform1f(u("hasImage"), 0)
        gl.uniform1f(u("imageAspect"), 1)
        const tex = (unit: number) => {
            const t = gl.createTexture()
            gl.activeTexture(gl.TEXTURE0 + unit)
            gl.bindTexture(gl.TEXTURE_2D, t)
            for (const [k, v] of [[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR]]) gl.texParameteri(gl.TEXTURE_2D, k, v)
            return t
        }
        tex(0)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]))
        gl.uniform1i(u("imageTex"), 0)
        tex(1)
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, glyphs())
        gl.uniform1i(u("glyphTex"), 1)
        gl.activeTexture(gl.TEXTURE0)
        const src = imageSrc || decoded.img
        if (src) {
            const pic = new Image()
            pic.crossOrigin = "anonymous"
            pic.onload = () => {
                gl.activeTexture(gl.TEXTURE0)
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, pic)
                gl.uniform1f(u("imageAspect"), pic.naturalWidth / Math.max(1, pic.naturalHeight))
                gl.uniform1f(u("hasImage"), 1)
                draw(performance.now())
            }
            pic.src = src
        }
        const r = u("r"), t = u("t")
        const start = performance.now()
        let raf = 0
        const draw = (now: number) => {
            const ratio = Math.min(window.devicePixelRatio || 1, 1.5)
            const w = Math.max(1, Math.round(canvas.clientWidth * ratio))
            const h = Math.max(1, Math.round(canvas.clientHeight * ratio))
            if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
            gl.viewport(0, 0, w, h)
            gl.uniform2f(r, w, h)
            gl.uniform1f(t, animate && !isCanvas && decoded.an ? ((now - start) / 1000) * speed * Number(decoded.sp) : 0)
            gl.drawArrays(gl.TRIANGLES, 0, 6)
            if (animate && !isCanvas && decoded.an) raf = frame(draw)
        }
        const ro = new ResizeObserver(() => draw(performance.now()))
        ro.observe(canvas)
        draw(performance.now())
        return () => {
            unframe(raf)
            ro.disconnect()
            gl.getExtension("WEBGL_lose_context")?.loseContext()
        }
    }, [look, animate, speed, imageSrc, isCanvas])

    return <canvas ref={ref} style={{ width: "100%", height: "100%", display: "block", background: "black", ...style }} />
}

addPropertyControls(RoleModelLook, {
    look: { type: ControlType.String, title: "Look", displayTextArea: true, placeholder: "Paste a look from the Studio", description: "Creator → Copy look." },
    animate: { type: ControlType.Boolean, title: "Animate", defaultValue: true },
    speed: { type: ControlType.Number, title: "Speed", defaultValue: 1, min: 0.1, max: 3, step: 0.05 },
    image: { type: ControlType.ResponsiveImage, title: "Picture", description: "Optional. Drawn through the look." },
})
`
}

export { RMShowcase, SHOWCASE_SCHEMA, SHOWCASE_GROUPS, showcaseDefaults, encodeShowcase }
export { RMLook, LOOK_SCHEMA, LOOK_GROUPS, LOOK_PRESETS, LOOK_DEFAULT_STOPS, LOOK_MAX_STOPS, LOOK_FRAGMENT, decodeLook, encodeLook, renderLook, lookFramerSource }
export { RMScene, RMBrowser, RMTitle, RMLowerThird, RMCallout, RMShader, RMStat, RMBullets }

/* ── rm-pip ──────────────────────────────────────────────────────────────── */

/**
 * A speaker in a circle, over whatever is behind them.
 *
 * The pip existed only as markup a generator wrote into each composition — a
 * bare <video class="clip pip"> plus a .pip rule generated alongside it. That is
 * why the framing, the placement, the wallpaper and every hand edit had to be
 * read back out of the file and carried across a rebuild: there was no component
 * holding any of it, so the file was the only place it lived.
 *
 * Two constraints shape this, and both are why the video is NOT in a shadow root:
 *
 *   HyperFrames drives media from the light DOM. It seeks and plays every
 *   `[data-assembly-media]` on the page; a <video> inside a shadow root is
 *   invisible to it and would simply never play.
 *
 *   A timed <video> inside a timed <div> is what the linter rejects — the frame
 *   extractor reads the video's own start while visibility uses the wrapper's,
 *   and the two disagree. So the host carries no data-start of its own: it
 *   states the window in plain props and puts it on the video, which is the one
 *   timed element. The host is a positioned box and nothing more.
 */
/*
 * The crop, as arithmetic on four numbers.
 *
 * focus moves it across the frame; zoom is how much of the recording the circle
 * shows; focus-y moves that view up and down and does nothing at zoom 1, because
 * a square cut from 16:9 has no vertical slack until zoom makes some.
 * object-view-box crops into the recording's own box without a wrapper or a
 * transform, and at zoom 1 resolves to inset(0%) — identical to what a pip drew
 * before it existed.
 *
 * ::slotted, because the video has to stay in the light DOM: HyperFrames seeks
 * and plays every [data-assembly-media] on the page and cannot see inside a
 * shadow root. So the component keeps the element where the runtime can reach it
 * and styles it from in here, which is also the only reason this needs a slot.
 */
const PIP_CSS = `
  :host {
    position: absolute;
    inset: 0;
    display: block;
    inline-size: 100%;
    block-size: 100%;
    container-type: inline-size;
    pointer-events: none;
  }
  ::slotted(video) {
    position: absolute;
    inset-inline-end: var(--pip-right, -8cqw);
    inset-block-end: var(--pip-bottom, -4cqw);
    inline-size: var(--pip-size, 46cqw);
    block-size: calc(var(--pip-size, 46cqw) / var(--pip-aspect, 1));
    border-radius: var(--pip-radius, 50%);
    object-fit: cover;
    object-position: var(--pip-focus, 50%) 50%;
    --pip-vis: calc(100 / var(--pip-zoom, 1));
    --pip-t: clamp(0, var(--pip-y, 50) - var(--pip-vis) / 2, 100 - var(--pip-vis));
    --pip-l: calc((100 - var(--pip-vis)) / 2);
    object-view-box: inset(calc(var(--pip-t) * 1%) calc(var(--pip-l) * 1%)
                           calc((100 - var(--pip-t) - var(--pip-vis)) * 1%) calc(var(--pip-l) * 1%));
    border: .3cqw solid color-mix(in srgb, var(--color-light) 22%, transparent);
    box-shadow: 0 2cqw 6cqw rgba(0, 0, 0, .5);
  }
`

class RMPip extends RMElement {
  static fields = ['src', 'focus', 'zoom', 'focus-y', 'size', 'aspect', 'right', 'bottom', 'radius', 'start', 'ms', 'at', 'for']

  render() {
    /* The slot is the whole shadow tree. Rewriting it every render is safe:
       slot assignment is recomputed and the light-DOM video is untouched. */
    this.shadowRoot.innerHTML = `<style>${PIP_CSS}</style><slot></slot>`

    for (const [name, value, unit] of [
      ['--pip-size', this.attr('size', ''), 'cqw'],
      ['--pip-aspect', this.attr('aspect', ''), ''],
      ['--pip-right', this.attr('right', ''), 'cqw'],
      ['--pip-bottom', this.attr('bottom', ''), 'cqw'],
      ['--pip-radius', this.attr('radius', ''), '%'],
      ['--pip-focus', this.attr('focus', ''), '%'],
      ['--pip-zoom', this.attr('zoom', ''), ''],
      ['--pip-y', this.attr('focus-y', ''), ''],
    ]) {
      if (String(value).trim()) this.style.setProperty(name, `${value}${unit}`)
      else this.style.removeProperty(name)
    }

    /*
     * The window, stated once and put on the video.
     *
     * The host carries no data-start of its own: a timed <video> inside a timed
     * element is what the linter rejects, because the frame extractor reads the
     * video's own start while visibility uses the wrapper's and the two
     * disagree. Milliseconds here like every other component; the data-* pair is
     * seconds, and this is the only place that converts.
     */
    const startMs = Number(this.attr('start', this.attr('at', 0))) || 0
    const forMs = Number(this.attr('for', 0)) || 0
    const mediaMs = Number(this.attr('ms', 0)) || 0
    const sec = (ms) => (Math.max(0, Math.round(ms)) / 1000).toFixed(3)

    /* Reused rather than replaced: a new <video> every render restarts the
       download and drops whatever HyperFrames had already seeked it to. */
    let video = this.querySelector(':scope > video')
    if (!video) {
      video = document.createElement('video')
      this.append(video)
    }
    const src = this.attr('src', '')
    if (src && video.getAttribute('src') !== src) video.setAttribute('src', src)
    video.className = 'clip pip'
    video.toggleAttribute('data-assembly-media', true)
    video.toggleAttribute('playsinline', true)
    video.setAttribute('preload', 'auto')
    video.dataset.start = sec(startMs)
    if (forMs > 0) video.dataset.duration = sec(forMs)
    video.dataset.mediaStart = sec(mediaMs)
    video.dataset.hasAudio = 'true'
  }
}
define('rm-pip', RMPip)
