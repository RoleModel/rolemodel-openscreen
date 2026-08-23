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

export const RM = {
  /** Put the whole scene at `ms`. Idempotent, and the only way time advances. */
  seek(ms) {
    root.style.setProperty('--t', `${ms}ms`)
    root.dataset.t = String(ms)
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
    await Promise.all(imgs.filter(Boolean))
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
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
    --at: 0ms;
    --dur: 520ms;
    --out-dur: 320ms;
    --hold: 999999ms;
    --ease: cubic-bezier(.16,1,.3,1);
    --rise: 14px;
  }
  .anim {
    animation-name: rm-in, rm-out;
    animation-duration: var(--dur), var(--out-dur);
    animation-delay: calc(var(--at) - var(--t)), calc(var(--at) + var(--hold) - var(--t));
    animation-timing-function: var(--ease), ease-in;
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
    --font: "DM Sans", ui-sans-serif, system-ui, -apple-system, sans-serif;
    --mono: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    --fg: var(--op-color-neutral-minus-max, #fff);
    --muted: var(--op-color-neutral-minus-five, #a3a3a3);
    --brand: var(--op-color-academy-primary-base, #00c278);
    --on-brand: var(--op-color-academy-primary-on-base, #00472c);
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
  static fields = ['wallpaper', 'pad', 'width', 'height']
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
        .stage { position:relative; width:100%; height:100%; padding:${Number(pad)}cqw;
                 background-size:cover; background-position:center; }
        ${wp ? `.stage { background-image:url("${this.esc(wp)}.jpg"); }` : ''}
        ::slotted(*) { position:absolute; }
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
  static fields = ['url', 'image', 'src', 'at', 'for', 'w', 'dark']
  render() {
    const url = this.attr('url', 'app.rolemodelsoftware.com')
    const image = this.attr('image')
    const src = this.attr('src')
    const w = this.attr('w', '72')
    this.shadowRoot.innerHTML = `
      <style>
        ${TYPE}${TIMING}
        :host { display:block; width:${Number(w)}cqw; --rise:22px; }
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
        .view.img { object-fit:cover; object-position:top center; }
        /* No screenshot yet. A plain white rectangle reads as a broken render;
           this reads as a placeholder, which is what it is. */
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
        ${src ? `<iframe class="view" src="${this.esc(src)}" loading="eager" sandbox="allow-scripts allow-same-origin"></iframe>` : image ? `<img class="view img" src="${this.esc(image)}" alt=""/>` : `<div class="view empty">screenshot</div>`}
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
        .eb { font-family:var(--mono); font-size:1.25cqw; letter-spacing:.16em; text-transform:uppercase; color:var(--brand); }
        h1 { margin:0; font-size:5.4cqw; font-weight:800; letter-spacing:-.03em; line-height:1.02; color:var(--fg); max-width:24ch; }
        .sub { font-size:1.7cqw; color:var(--muted); max-width:46ch; line-height:1.45; }
        .rule { width:6cqw; height:.26cqw; border-radius:.2cqw; background:var(--brand); margin-top:.6cqw; }
      </style>
      <div class="wrap anim">
        ${this.attr('eyebrow') ? `<div class="eb">${this.esc(this.attr('eyebrow'))}</div>` : ''}
        <h1>${this.esc(this.attr('title', 'Title'))}</h1>
        ${this.attr('sub') ? `<div class="sub">${this.esc(this.attr('sub'))}</div>` : ''}
        <div class="rule"></div>
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
                --rise:0px; --dur:460ms; }
        .card { display:flex; align-items:stretch; gap:1cqw;
                background:color-mix(in srgb, var(--surface) 88%, transparent);
                border:1px solid var(--line); border-radius:.7cqw;
                padding:.9cqw 1.4cqw .9cqw 1.1cqw; backdrop-filter:blur(8px);
                box-shadow:0 1.2cqw 3cqw rgba(0,0,0,.4); }
        .bar { width:.24cqw; border-radius:.2cqw; background:var(--brand); flex:0 0 auto; }
        .n { font-size:1.55cqw; font-weight:700; letter-spacing:-.02em; color:var(--fg); line-height:1.2; }
        .s { font-family:var(--mono); font-size:.95cqw; color:var(--muted); margin-top:.18cqw; }
        /* Slides in rather than rising — reads as a reveal, and stays legible
           over busy footage. Uses the same registered properties so it still
           composes with the exit animation. */
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
        :host { display:block; position:absolute; left:${x}%; top:${y}%; --rise:0px; --dur:420ms; }
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

/* ── rm-stat ─────────────────────────────────────────────────────────────── */

/**
 * One number, large. `count` animates it up from zero — and does so by stepping
 * a CSS integer, not a JS timer, so it lands on the same value at the same
 * frame on every render.
 */
class RMStat extends RMElement {
  static fields = ['value', 'label', 'unit', 'count', 'at', 'for']
  render() {
    const value = this.attr('value', '0')
    const n = Number(String(value).replace(/[^0-9.-]/g, ''))
    const counting = this.hasAttribute('count') && Number.isFinite(n)
    this.shadowRoot.innerHTML = `
      <style>
        ${TYPE}${TIMING}
        :host { display:block; --rise:16px; }
        @property --n { syntax:"<integer>"; initial-value:0; inherits:false; }
        .v { font-size:6cqw; font-weight:800; letter-spacing:-.04em; line-height:1; color:var(--brand); }
        ${
          counting
            ? `.v { counter-reset: n var(--n);
                 animation: rm-count 1100ms var(--ease) both paused;
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

/* ── rm-bullets ──────────────────────────────────────────────────────────── */

/** A list that builds. Each `<li>` gets `stagger` ms after the one before it. */
class RMBullets extends RMElement {
  static fields = ['stagger', 'at', 'for', 'heading']
  render() {
    const items = [...this.querySelectorAll('li')].map((li) => li.textContent.trim())
    const stagger = Number(this.attr('stagger', 420))
    this.shadowRoot.innerHTML = `
      <style>
        ${TYPE}${TIMING}
        :host { display:block; --rise:12px; }
        h3 { margin:0 0 1.4cqw; font-size:2.2cqw; font-weight:750; letter-spacing:-.02em; color:var(--fg); }
        ul { margin:0; padding:0; list-style:none; display:flex; flex-direction:column; gap:1cqw; }
        li { display:flex; gap:.9cqw; align-items:flex-start; font-size:1.6cqw; color:var(--fg); line-height:1.4;
             animation: rm-in var(--dur) var(--ease) both paused;
             opacity: var(--rm-in-o); transform: translateY(var(--rm-in-y)); }
        li::before { content:""; flex:0 0 auto; width:.72cqw; height:.72cqw; border-radius:.16cqw;
                     background:var(--brand); margin-top:.5cqw; }
      </style>
      ${this.attr('heading') ? `<h3 class="anim">${this.esc(this.attr('heading'))}</h3>` : ''}
      <ul>${items.map((t, i) => `<li style="animation-delay:calc(var(--at) + ${i * stagger}ms - var(--t))">${this.esc(t)}</li>`).join('')}</ul>`
  }
}
define('rm-bullets', RMBullets)

export { RMScene, RMBrowser, RMTitle, RMLowerThird, RMCallout, RMStat, RMBullets }
