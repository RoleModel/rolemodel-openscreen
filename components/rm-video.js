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
    animation-delay: calc(var(--at) - var(--t)), calc(var(--at) + var(--hold) - var(--t));
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
                --rise:0px; --dur:var(--duration-base, 400ms); }
        .card { display:flex; align-items:stretch; gap:1cqw;
                background:color-mix(in srgb, var(--surface) 88%, transparent);
                border:1px solid var(--line); border-radius:.7cqw;
                padding:.9cqw 1.4cqw .9cqw 1.1cqw; backdrop-filter:blur(8px);
                box-shadow:0 1.2cqw 3cqw rgba(0,0,0,.4); }
        .bar { width:.24cqw; border-radius:.2cqw; background:var(--brand-text); flex:0 0 auto; }
        .n { font-size:1.55cqw; font-weight:700; letter-spacing:-.02em; color:var(--fg); line-height:1.2;  }
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
    const base = this.closest('rm-scene')?.getAttribute('assets') ?? ''
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
