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
    return [...document.querySelectorAll('[at]')].map((e) => ({
      el: e,
      tag: e.tagName.toLowerCase(),
      at: Number(e.getAttribute('at') || 0),
      for: e.hasAttribute('for') ? Number(e.getAttribute('for')) : null,
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

  sync() {
    this.style.setProperty('--at', `${Number(this.getAttribute('at') || 0)}ms`)
    if (this.hasAttribute('for')) this.style.setProperty('--hold', `${Number(this.getAttribute('for'))}ms`)
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
                background:color-mix(in srgb, var(--surface) 88%, transparent);
                border:1px solid var(--line); border-radius:.7cqw;
                padding:.9cqw 1.4cqw .9cqw 1.1cqw; backdrop-filter:blur(8px);
                box-shadow:0 1.2cqw 3cqw rgba(0,0,0,.4); }
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
    const base = this.getAttribute('assets') || this.closest('rm-scene')?.getAttribute('assets') || ''
    const src = !raw || raw.includes('/') || /^[a-z]+:/i.test(raw) ? raw : `${base}/${raw}`
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
const SHADER_ICON = new URL('../brand/logos/standard-icon.svg', import.meta.url).href
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
    const showMark = showOverlay && this.attr('mark', 'off') === 'on'
    const rawImage = this.attr('image')
    const base = this.getAttribute('assets') || this.closest('rm-scene')?.getAttribute('assets') || ''
    const imageSource = rawImage ? (rawImage.includes('/') || /^[a-z]+:/i.test(rawImage) ? rawImage : `${base}/${rawImage}`) : ''
    const hasImage = Boolean(imageSource)
    const lockup = showOverlay
      ? `<div class="lockup">${showMark ? '<i class="mark" aria-hidden="true"></i>' : ''}${title ? `<h2>${title}</h2>` : ''}${subtitle ? `<p>${this.esc(subtitle)}</p>` : ''}</div>`
      : ''
    this.shadowRoot.innerHTML = `<style>${TYPE}${TIMING}:host{display:block;inset:0;width:100%;height:100%;}.asset{position:absolute;inset:0;overflow:hidden;background:${background};}.asset canvas{position:absolute;inset:0;width:100%;height:100%;display:block;}.lockup{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1.35cqw;padding:8cqw;color:${text};text-align:center;}.mark{inline-size:8cqw;block-size:8cqw;background:${shaderInk};mask:url(${SHADER_ICON}) center/contain no-repeat;-webkit-mask:url(${SHADER_ICON}) center/contain no-repeat;}.lockup h2{margin:0;font-size:6.4cqw;font-weight:800;letter-spacing:-.045em;line-height:.9;}.lockup p{margin:0;max-inline-size:34ch;font-size:1.45cqw;font-weight:650;line-height:1.35;color:${dots};}.empty{position:absolute;inset:0;display:grid;place-items:center;padding:3cqw;color:${dots};font-size:1.15cqw;font-weight:650;text-align:center;}.empty span{padding:.7em 1em;border:1px dashed currentColor;border-radius:999px;}</style><div class="asset anim">${
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
 * It deliberately has no mark or copy. Pair it with rm-title or rm-lower-third
 * when a scene needs words; a background treatment should not make a lockup a
 * requirement.
 */
const PIXEL_REVEAL_FRAGMENT = [
  'precision highp float;uniform vec2 r;uniform float t;uniform float imageAspect;uniform sampler2D imageTex;uniform float pixelDensity;uniform float pixelGap;uniform float pixelRoundness;uniform float halftoneFrequency;uniform float colorFringing;uniform float flowIntensity;uniform float showDuotone;uniform vec3 paper;uniform vec3 cyanInk;uniform vec3 magentaInk;uniform vec3 yellowInk;uniform vec3 blackInk;uniform vec3 colorA;uniform vec3 colorB;varying vec2 v;',
  'vec2 coverUV(vec2 uv){float canvasAspect=r.x/r.y;vec2 s=canvasAspect>imageAspect?vec2(1.,imageAspect/canvasAspect):vec2(canvasAspect/imageAspect,1.);return(uv-.5)*s+.5;}',
  'float roundedCell(vec2 p,float gap,float roundness){vec2 halfSize=vec2(.5-gap*.5);vec2 q=abs(p-.5)-halfSize;float radius=min(min(halfSize.x,halfSize.y),roundness*.5);float distance=length(max(q,0.))-radius;return 1.-smoothstep(0.,.035,distance);}',
  'vec3 printColour(vec3 photo,float luma){vec3 printed=paper;printed=mix(printed,cyanInk,(1.-photo.r)*.72);printed=mix(printed,magentaInk,(1.-photo.g)*.62);printed=mix(printed,yellowInk,(1.-photo.b)*.46);printed=mix(printed,blackInk,(1.-luma)*.54);return printed;}',
  'void main(){float size=max(3.,pixelDensity);vec2 pixel=gl_FragCoord.xy;vec2 cell=floor(pixel/size);vec2 local=fract(pixel/size);vec2 centre=(cell+.5)*size/r;float motion=t*.001;vec2 flow=vec2(sin(motion+centre.y*8.),cos(motion*.8+centre.x*7.))*flowIntensity*.009;float fringe=colorFringing/max(r.x,r.y);vec2 offset=vec2(fringe,fringe*.45);float red=texture2D(imageTex,coverUV(centre+flow+offset)).r;float green=texture2D(imageTex,coverUV(centre+flow)).g;float blue=texture2D(imageTex,coverUV(centre+flow-offset)).b;vec3 photo=vec3(red,green,blue);float luma=dot(photo,vec3(.299,.587,.114));vec3 colour=printColour(photo,luma);vec3 duo=mix(colorB,colorA,luma);colour=mix(colour,duo,showDuotone);float screen=(sin((cell.x+cell.y)*halftoneFrequency*.35)*.5+.5)*(1.-luma)*.2;colour=mix(colour,blackInk,screen);float shape=roundedCell(local,pixelGap,pixelRoundness);gl_FragColor=vec4(mix(paper,colour,shape),1.);}',
].join('')

class RMPixelReveal extends RMElement {
  static fields = [
    'image',
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
    const base = this.getAttribute('assets') || this.closest('rm-scene')?.getAttribute('assets') || ''
    const imageSource = rawImage ? (rawImage.includes('/') || /^[a-z]+:/i.test(rawImage) ? rawImage : `${base}/${rawImage}`) : ''
    const hasImage = Boolean(imageSource)
    const stroke = `${borderRadius ? '.12cqw solid ' : '0 solid '}${border}`
    this.shadowRoot.innerHTML = `<style>${TYPE}${TIMING}:host{display:block;inset:0;width:100%;height:100%;}.asset{position:absolute;inset:0;overflow:hidden;background:${paper};border:${stroke};border-radius:${borderRadius}cqw;}.asset canvas{position:absolute;inset:0;width:100%;height:100%;display:block;}.empty{position:absolute;inset:0;display:grid;place-items:center;padding:3cqw;color:var(--op-color-neutral-minus-seven, #caccce);font-size:1.15cqw;font-weight:650;text-align:center;}.empty span{padding:.7em 1em;border:1px dashed currentColor;border-radius:999px;}</style><div class="asset anim">${
      hasImage ? '<canvas aria-hidden="true"></canvas>' : '<div class="empty"><span>Choose or upload an image to make a pixel reveal</span></div>'
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
  'precision highp float;uniform vec2 r;uniform float t;uniform vec3 shadowColour;uniform vec3 highlightColour;uniform vec3 ditherColour;uniform float flowSpeed;uniform float swirlDetail;uniform float colourBalance;uniform float ditherAmount;uniform float ditherPixel;uniform float distortStrength;uniform float distortDetail;uniform float sharpness;uniform float grain;varying vec2 v;',
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
  'void main(){vec2 uv=distort(v);float n=swirlField(uv);if(sharpness>.001){float e=1./max(r.x,r.y);float around=(swirlField(uv+vec2(e,0.))+swirlField(uv-vec2(e,0.))+swirlField(uv+vec2(0.,e))+swirlField(uv-vec2(0.,e)))*.25;n=clamp(n+(n-around)*sharpness*2.,0.,1.);}float x=clamp((n-.5)*1.6+colourBalance,0.,1.);vec3 col=mixHSL(shadowColour,highlightColour,x);if(ditherAmount>.001){vec2 px=floor(uv*r/max(1.,ditherPixel));float thr=(b4(mod(px,4.))+.5)/16.;float lum=dot(col,vec3(.299,.587,.114));vec3 pattern=mix(vec3(0.),ditherColour,step(thr,lum));col=mix(col,overlay(col,pattern),ditherAmount);}col+=(h21(gl_FragCoord.xy+fract(t)*vec2(37.7,17.3))-.5)*grain;gl_FragColor=vec4(clamp(col,0.,1.),1.);}',
].join('')

class RMHaze extends RMElement {
  static fields = [
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
    'motion',
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
    const still = this.attr('motion', 'flow') === 'still'

    const shadowColour = shaderColour(this.attr('gradient-shadow'), 'var(--op-color-neutral-plus-max, #242424)')
    const highlightColour = shaderColour(this.attr('gradient-highlight'), 'var(--brand, var(--op-color-academy-primary-base, #00b871))')
    const ditherColour = shaderColour(this.attr('dither-color'), 'var(--op-color-neutral-minus-max, #ffffff)')

    /*
     * The same three lines, in the same places, as every other full-frame
     * treatment. LOCKUP is shared with the field rather than restated, so two
     * backgrounds cut together cannot carry two typographic scales.
     */
    const copy = this.attr('eyebrow') || this.attr('title') || this.attr('body')
      ? `<div class="lockup">${this.attr('eyebrow') ? `<div class="eyebrow">${this.esc(this.attr('eyebrow'))}</div>` : ''}${this.attr('title') ? `<div class="title">${this.esc(this.attr('title'))}</div>` : ''}${this.attr('body') ? `<div class="body">${this.esc(this.attr('body'))}</div>` : ''}</div>`
      : ''
    this.shadowRoot.innerHTML = `<style>${TYPE}${TIMING}:host{--paper-ink: var(--op-color-neutral-minus-max, #fff8e9);display:block;inset:0;width:100%;height:100%;}.asset{position:absolute;inset:0;overflow:hidden;background:${shadowColour};}.asset canvas{position:absolute;inset:0;width:100%;height:100%;display:block;}${LOCKUP}</style><div class="asset anim" style="${fieldStyle(this)}"><canvas aria-hidden="true"></canvas>${copy}</div>`

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
    const observer = new ResizeObserver(draw)
    const onSeek = () => draw()
    observer.observe(canvas)
    root.addEventListener('rmseek', onSeek)

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
    display: block; inset: 0; width: 100%; height: 100%;
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
          ${this.attr('eyebrow') ? `<div class="eyebrow">${this.esc(this.attr('eyebrow'))}</div>` : ''}
          ${this.attr('title') ? `<div class="title">${this.esc(this.attr('title'))}</div>` : ''}
          ${this.attr('body') ? `<div class="body">${this.esc(this.attr('body'))}</div>` : ''}
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
      const time = Math.max(0, RM.t - (Number(this.attr('at', 0)) || 0)) / 1000
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


export { RMScene, RMBrowser, RMTitle, RMLowerThird, RMCallout, RMShader, RMStat, RMBullets }
