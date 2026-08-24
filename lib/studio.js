/*
 * The Studio client. Plain DOM against the JSON the server hands back — no
 * framework, no build step, no bundler.
 *
 * This used to live inside a template literal in lib/studio-ui.mjs, which meant
 * every backtick and every ${ in it needed escaping, and one missed escape
 * silently terminated the literal and served the page as unstyled tags. It is a
 * real .js file now: the escapes are gone, `node --check` covers it directly,
 * and the markup it drives is in lib/studio.html.
 */
/* ── numbers Optics has nothing to say about ──────────────────
   Everything visual is a token in studio.html. What is left is frame geometry,
   poll intervals and unit arithmetic — named here so no line below carries a
   bare literal either. */
const FRAME_AR_W = 16,
  FRAME_AR_H = 9 // the whole product renders 16:9
const frameHeight = (w) => Math.round((w * FRAME_AR_H) / FRAME_AR_W)
const THUMB_W = 460 // wallpaper grid preview canvas
const EDITOR_W = 1280 // wallpaper editor canvas
const EXPORT_W = 3840 // what Save actually writes: 4K
const EXPORT_QUALITY = 0.92 // jpeg quality for that export
const JOB_POLL_MS = 3000 // running-job badge refresh
const DEMO_CHECK_MS = 400 // debounce for checking a demo script as it is typed
const DISARM_MS = 4000 // an armed delete forgets itself rather than waiting all day
const COPIED_MS = 2000 // how long the Copied label sticks
const DRAFT_SAVE_MS = 600 // a beat after typing stops, not once per keystroke

/*
 * Put text on the clipboard, and be honest about whether it worked.
 *
 * `navigator.clipboard` cannot work inside the app. main.ts installs a permission
 * allowlist of media and capture only, so the Clipboard API is denied for every
 * page the app loads and writeText rejects with "Write permission denied". Even
 * allowed it would want document focus and an unspent user activation, and a
 * button that fetches the thing it is about to copy has spent the activation by
 * the time it holds the value.
 *
 * So the host does it when there is a host, and the browser API stays as the
 * fallback for the Studio opened in a real browser, where it does work.
 *
 * Returns null on success or a reason on failure — deliberately, because all
 * three call sites used to swallow the rejection and set the label to "Copied"
 * regardless, which made the one thing you could not find out whether it had
 * copied.
 */
async function copyText(text) {
  if (window.rmStudio?.copyText) {
    const r = await window.rmStudio.copyText(text).catch((e) => ({ ok: false, error: String(e && e.message) }))
    return r?.ok ? null : r?.error || 'the app refused the clipboard'
  }
  if (!navigator.clipboard?.writeText) return 'this browser exposes no clipboard'
  try {
    await navigator.clipboard.writeText(text)
    return null
  } catch (err) {
    return err?.message || 'the browser refused the clipboard'
  }
}

/**
 * Wire a button to copy something, flipping its label and reverting.
 *
 * `get` may be async and may return null, which is how a button that has to go
 * and find the value first says "there was nothing to copy" without the label
 * claiming otherwise.
 */
function copyButton(btn, label, get) {
  /*
   * An icon button keeps its icon.
   *
   * This used to set textContent, which on a button whose only child is a glyph
   * deletes the glyph — and then restored a label that an icon button does not have,
   * leaving it blank for ever. So the two shapes are handled separately: a labelled
   * button swaps its words, an icon button swaps its glyph and keeps the words in the
   * tooltip, which is where they already were.
   */
  const glyph = btn.querySelector('.hgi-stroke')
  const iconOnly = Boolean(glyph) && !btn.textContent.trim()
  const was = iconOnly ? glyph.className : null
  const tip = btn.title || label || ''

  btn.onclick = async () => {
    const text = typeof get === 'function' ? await get() : get
    if (text == null) return
    const err = await copyText(text)
    if (iconOnly) {
      glyph.className = 'hgi-stroke hgi-' + (err ? 'alert-01' : 'tick-02')
      btn.title = err || 'Copied'
    } else {
      btn.textContent = err ? 'Copy failed' : 'Copied'
      btn.title = err || ''
    }
    setTimeout(() => {
      if (iconOnly) {
        glyph.className = was
        btn.title = tip
      } else {
        btn.textContent = label
        btn.title = ''
      }
    }, COPIED_MS)
  }
  return btn
}
const EDITOR_OPEN_MS = 150 // let the view paint before scrolling to the editor
const DEFAULT_GAP_MS = 320 // silence between narration lines
const MIN_GRADIENT_STOPS = 2 // a gradient with one stop is a fill
const SNIPPET_CHARS = 120 // script body shown on a saved-script card
const BYTES_PER_STEP = 1024
const SEC_PER_MIN = 60,
  SEC_PER_HOUR = 3600
const ISO_TIME = [11, 19] // "2026-08-22T14:02:11.000Z" -> "14:02:11"

/* Limits for the wallpaper controls. Degrees, alpha, and px-at-1920 — the
   recipe's own domain, which Optics has no opinion about. Collected here
   because rangeRow() used to take min/max/step positionally, and three bare
   numbers at a call site tell you nothing about which is which. */
const RANGE = {
  angle: { min: 0, max: 360, step: 1 }, // gradient and tint rotation
  stop: { min: 0, max: 1, step: 0.01 }, // gradient stop position
  tint: { min: 0, max: 0.6, step: 0.01 }, // tint strength; past .6 it is a wash
  texture: { min: 0, max: 0.4, step: 0.005 }, // texture opacity
  spacing: { min: 4, max: 96, step: 1 }, // texture spacing, px at 1920
  weight: { min: 0.25, max: 6, step: 0.05 }, // texture line weight
  edge: { min: 0, max: 32, step: 1 }, // border width, px at 1920
  inset: { min: 0, max: 120, step: 1 }, // border inset, px at 1920
  radius: { min: 0, max: 120, step: 1 }, // border corner radius, px at 1920
}

/** A 0-1 fraction as a whole percent, for the readouts beside the sliders. */
const pct = (v) => Math.round(v * 100) + '%'

let S = null,
  view = 'library',
  q = '',
  kind = '',
  WP = null,
  recipes = [],
  editing = null
let allJobs = [],
  jobId = null,
  shellOn = false,
  es = null,
  SP = null,
  // The shared speech estimate, served from lib/demo-script.mjs so the builder and
  // the compiler cannot disagree about how long a line takes to say.
  DS = null
// Set by vConsole while it is on screen, so a poll can update it in place.
let consoleUpdate = null
const $ = (s, r = document) => r.querySelector(s)
const el = (t, c, x) => {
  const n = document.createElement(t)
  if (c) n.className = c
  if (x != null) n.textContent = x
  return n
}
const human = (b) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0,
    n = b
  while (n >= BYTES_PER_STEP && i < u.length - 1) {
    n /= BYTES_PER_STEP
    i++
  }
  return n.toFixed(n < 10 && i > 0 ? 2 : 0) + ' ' + u[i]
}
const dur = (s) => {
  if (s == null) return null
  const h = Math.floor(s / SEC_PER_HOUR),
    m = Math.floor((s % SEC_PER_HOUR) / SEC_PER_MIN),
    x = Math.floor(s % SEC_PER_MIN)
  return h ? h + ':' + String(m).padStart(2, '0') + ':' + String(x).padStart(2, '0') : m + ':' + String(x).padStart(2, '0')
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

async function load() {
  // The wallpaper drawing code, imported from the same file the batch renderer
  // uses. Loaded once; every preview and every export goes through it.
  paintNavIcons()
  if (!WP) WP = await import('/wallpaper.mjs')
  // The same parser lib/narration.mjs uses. Served, not re-implemented — a
  // preview that disagrees with the synthesiser is worse than no preview.
  if (!SP) SP = await import('/script-parse.mjs')
  if (!DS) DS = await import('/demo-script.mjs')
  S = await (await fetch('/api/state')).json()
  $('#root').textContent = S.libraryRoot
  /*
   * The footer's tool list. A bare grey dot next to a name reads as "broken",
   * which is wrong for two of these: rclone is only needed if you sync to a
   * remote, and hyperframes is never installed at all — it is fetched with npx
   * the first time something asks for it, so "off" means "not in the npx cache",
   * which is the normal state of a machine that has not made a video yet. The
   * question this answers is the one that gets asked out loud: where does
   * HyperFrames sit?
   */
  const WHY = {
    openscreen: ['the recorder and the editor — the app itself', 'not on PATH. Install the cask, or `rm-setup`.'],
    claude: ['writes scripts and drives a Make render', 'the claude CLI is not on PATH.'],
    ffmpeg: ['probes media and cuts the renders', 'not on PATH. `brew install ffmpeg`.'],
    rclone: ['optional — only for syncing a project to a remote', 'not configured, which is fine unless you want Storage.'],
    hyperframes: ['the /hyperframes skills a Make render uses, and Kokoro for Voice. Not installed anywhere — npx fetches it on first use.', 'not in the npx cache yet. Nothing to fix: the first render or voice line fetches it.'],
    voice: ['the private Python environment Kokoro speaks from', 'not built yet. The Voice page has a button for it.'],
    remotes: ['rclone remotes a project can be pushed to — see Storage', 'no rclone remotes configured, which only matters if you want Storage.'],
  }
  const dot = (k, v, label = k) => {
    const [what, why] = WHY[k] ?? [null, null]
    const title = v ? what : why || what
    return `<div${title ? ` title="${esc(title)}"` : ''}><span class="dot ${v ? 'on' : 'off'}"></span>${esc(label)}</div>`
  }
  $('#tools').innerHTML =
    Object.entries(S.tools)
      .map(([k, v]) => dot(k, v))
      .join('') + dot('remotes', S.remotes.length > 0, `${S.remotes.length} remote${S.remotes.length === 1 ? '' : 's'}`)
  refreshJobs()
  render()
}

for (const b of document.querySelectorAll('nav button[data-v]')) b.onclick = () => go(b.dataset.v)

// Keep the running-job badge honest even when you are looking at another panel.
setInterval(() => {
  if (allJobs.some((j) => j.running) || view === 'console') refreshJobs()
}, JOB_POLL_MS)

/**
 * The trail in the page header.
 *
 * Every view says where it is; a view you can descend into passes a link back.
 * This replaces the "← All projects" ghost button, which was a control doing a
 * breadcrumb's job — it said where you could go, never where you were.
 *
 * `parts` is [{ label, go? }]; the last entry is the current page and is never
 * a link, per the Optics component.
 */
function crumbs(parts) {
  const host = $('#crumbs')
  if (!host) return
  host.innerHTML = ''
  const nav = el('nav', 'breadcrumbs')
  nav.setAttribute('aria-label', 'Breadcrumb')
  parts.forEach((part, i) => {
    const last = i === parts.length - 1
    if (last || !part.go) {
      const t = el('span', 'breadcrumbs__text', part.label)
      if (last) t.setAttribute('aria-current', 'page')
      nav.append(t)
    } else {
      const a = el('a', 'breadcrumbs__link', part.label)
      a.href = '#'
      a.onclick = (e) => {
        e.preventDefault()
        part.go()
      }
      nav.append(a)
    }
    if (!last) nav.append(el('span', 'breadcrumbs__sep', '/'))
  })
  host.append(nav)
}

/** What each view calls itself in the trail. */
/*
 * One icon per page, and the helper that draws one.
 *
 * HugeIcons, vendored into brand/icons/ and served by rm-studio — not linked, since
 * the Studio is hosted by an app that has to start with no network. It is a ligature
 * font: `.hgi-stroke` binds the family and `.hgi-<name>` picks the glyph through a
 * ::before codepoint, so an icon is a span with two classes and no markup of its own.
 *
 * The nav is static markup in studio.html, so the icons are added here at load
 * instead — which also keeps the choice of glyph beside the choice of label, where
 * changing one makes you look at the other. verify asserts every name exists in the
 * set, because a typo in a ligature font is a blank box and nothing else.
 */
const VIEW_ICON = {
  library: 'folder-library',
  new: 'folder-add',
  create: 'video-01',
  record: 'record',
  make: 'command-line',
  recast: 'test-tube',
  editor: 'scissor-01',
  review: 'comment-01',
  scripts: 'file-01',
  voice: 'mic-01',
  brand: 'paint-board',
  wallpapers: 'image-01',
  components: 'layout-grid',
  storage: 'database-01',
  console: 'console',
}

/** An icon. `aria-hidden`, because every one of these sits beside its own words. */
function icon(name, cls) {
  const i = el('span', 'hgi-stroke hgi-' + name + (cls ? ' ' + cls : ''))
  i.setAttribute('aria-hidden', 'true')
  return i
}

/** Put an icon in front of each nav button's label, once. */
function paintNavIcons() {
  for (const b of document.querySelectorAll('nav button[data-v]')) {
    if (b.querySelector('.hgi-stroke')) continue
    const name = VIEW_ICON[b.dataset.v]
    if (!name) continue
    b.prepend(icon(name, 'navicon'))
  }
}

/*
 * What the breadcrumb calls each page.
 *
 * The only thing that names a page now: every view used to render an h2 as well,
 * so each one said its name twice and the two could disagree — the Make page's
 * heading read "Make a video" while the breadcrumb above it said "make".
 *
 * record, make and recast are the New video tabs. vCreate sets its own crumbs when
 * you arrive through the tabs, but they are dispatched as views too — `go('recast')`
 * is a real call — and without an entry here that landed on the lowercase view id.
 * The labels match CREATE_TABS; verify asserts they still do rather than deriving
 * them, because CREATE_TABS is declared further down the file than this is.
 */
const VIEW_LABEL = {
  library: 'Library',
  editor: 'Editor',
  review: 'Review',
  new: 'New project',
  create: 'New video',
  record: 'Record a screen',
  make: 'Make from a script',
  recast: 'From a test',
  scripts: 'Scripts',
  voice: 'Voice',
  brand: 'Brand',
  wallpapers: 'Wallpapers',
  components: 'Components',
  storage: 'Storage',
  console: 'Console',
}

/**
 * The document last chosen from the Library, waiting to be handed over.
 *
 * Not "what the editor has open" — once the editor is up it opens and closes
 * documents by itself and this side is not told. It is only the handoff: clicking
 * a video in the Library records it here, and the editor is given it after the
 * view is mounted, which is the order that matters (see openDocument).
 */
let editorDoc = null

/** Cancels the size watch on the editor frame. */
let editorWatch = null

/**
 * The last document actually handed over.
 *
 * Compared against `editorDoc` so re-entering the Editor view does not re-open
 * what is already open. The host keeps the view alive across a navigation, and
 * re-opening would throw away the state that was worth keeping — including work
 * done in the editor since, which is the part that would be a bug rather than a
 * waste.
 */
let editorHanded = null

/*
 * Take the editor out of the window.
 *
 * Called from render() for the same reason the EventSource is closed there: it is
 * a live thing attached to a view, and leaving it attached while the page shows
 * something else means a native view floating over the wrong panel. The host
 * keeps the web contents; only the placement goes.
 */
function dropEditor() {
  editorWatch?.()
  editorWatch = null
  document.body.classList.remove('has-editor')
  const host = $('#editor-host')
  if (host) host.innerHTML = ''
  void window.rmStudio?.unmountEditor?.()
}

function render() {
  const m = $('#main')
  m.innerHTML = ''
  // One live stream at a time. Leaving the Console open in the background is how
  // you end up with a dozen dangling EventSources and a server that stops
  // answering because it ran out of sockets.
  es?.close()
  es = null
  consoleUpdate = null
  dropEditor()
  crumbs([{ label: VIEW_LABEL[view] ?? view }])
  ;({ library: vLibrary, new: vNew, create: vCreate, record: vRecord, make: vMake, editor: vEditor, review: vReview, scripts: vScripts, brand: vBrand, wallpapers: vWallpapers, storage: vStorage, console: vConsole, recast: vRecast, components: vComponents, voice: vVoice })[view](m)
}

function go(v) {
  view = v
  for (const o of document.querySelectorAll('nav button[data-v]')) o.setAttribute('aria-current', String(o.dataset.v === v))
  render()
}

/*
 * The host asking for the Editor view.
 *
 * The recorder's toolbar used to open an editor window of its own, so finishing a
 * capture handed you a second window with no navigation in it — the one moment you
 * most want to be back in the Studio. The app routes that to this page now, and
 * this is the only side that can turn "show the editor" into a view change.
 *
 * Registered at load rather than inside a view, because the message arrives
 * whenever a recording ends, whatever page happens to be up.
 */
window.rmStudio?.onShowEditor?.(() => go('editor'))

/* ── running things ──────────────────────────────────────────
   The Studio used to hand you a command to paste. It runs them now: POST the
   binary and an argv array, then watch the output in Console. The server only
   accepts binaries from its allowlist, so this is not a shell over HTTP. */
async function start(step) {
  const r = await (await fetch('/api/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(step) })).json()
  if (r.error) {
    alert(r.error)
    return null
  }
  jobId = r.job.id
  go('console')
  refreshJobs()
  return r.job
}

/** Display form of an argv array. For reading, never for re-parsing. */
function show(step) {
  const q = (s) => (/[\s"']/.test(s) ? JSON.stringify(s) : s)
  return step.shell ? step.shell : [step.bin, ...(step.args || [])].map(q).join(' ')
}

/** A command with a Run button and the exact argv beside it. */
function runRow(step, label) {
  const row = el('div', 'runrow')
  const b = el('button', 'btn', label || 'Run ' + (step.label || step.bin))
  row.append(b, Object.assign(el('code'), { textContent: show(step) }))
  b.onclick = () => start(step)
  if (step.note) row.append(Object.assign(el('div', 'path'), { textContent: step.note, style: 'flex-basis:100%' }))
  return row
}

async function refreshJobs() {
  const d = await (await fetch('/api/jobs')).json()
  allJobs = d.jobs
  shellOn = d.shell
  const n = allJobs.filter((j) => j.running).length
  $('#jobn').textContent = n ? String(n) : ''
  // Update the Console in place rather than re-rendering it. render() empties
  // main, closes the EventSource and opens a new one that replays the whole log
  // — three times a minute, which is the flicker and the repeated connecting.
  consoleUpdate?.()
}

/**
 * One Optics form group: label, control, and an optional hint.
 *
 * Optics' .form-group is itself a grid that owns the label/control pairing, so
 * the container only has to stack groups. This used to be six near-identical
 * `mk` closures appending a bare <label> and a bare control into one flat
 * two-column grid — which is why a display:none child could shift every field
 * after it out of alignment.
 *
 * `hint` takes a string for fixed copy, or an element when the panel updates it
 * later. Either way it lands inside the group as .form-hint, where Optics places
 * it under the control rather than in the label column.
 */
function field(form, label, control, hint) {
  const group = el('div', 'form-group')
  group.append(el('label', 'form-label', label))
  // Tag the real controls, not the wrapper: some fields hand over a div holding
  // a select plus a fallback input, and .form-control on the div styles nothing.
  const controls = control.matches?.('input, select, textarea') ? [control] : [...control.querySelectorAll('input, select, textarea')]
  for (const c of controls) c.classList.add('form-control')
  group.append(control)
  if (hint) {
    const h = typeof hint === 'string' ? Object.assign(el('div', 'form-hint'), { textContent: hint }) : hint
    h.classList.add('form-hint')
    group.append(h)
  }
  form.append(group)
  return control
}

/**
 * Set a hint's tone without losing its Optics class.
 *
 * Assigning className wholesale is how `form-hint` kept getting wiped: the tone
 * changes on nearly every fetch, and each assignment rebuilt the class list from
 * scratch. The Console's status line deliberately does not use this — it is not
 * in a form, and Optics italicises .form-hint.
 */
const tone = (node, t) => {
  node.className = 'form-hint hint' + (t ? ' ' + t : '')
}

/** A group holding something that is not a labelled control — a button, a note. */
function fieldRow(form, node) {
  const group = el('div', 'form-group')
  group.append(node)
  form.append(group)
  return node
}

/**
 * A path field with a Browse button.
 *
 * The browser's own file input is no use here: it hands back a File object, and
 * every binary downstream takes a path on disk. So this walks the server's
 * /api/browse, which lists directories under $HOME and returns no file contents
 * at all. Typing a path still works — this is for the much more common case of
 * not knowing what to type.
 *
 * `accept` filters which files are offered; the rest are counted, not hidden in
 * silence, because "my file isn't in the list" needs an explanation.
 */
function pathField(form, label, opts = {}) {
  const row = el('div', 'pick')
  const input = Object.assign(el('input'), { value: opts.value || '', placeholder: opts.placeholder || '' })
  const browse = el('button', 'btn ghost', 'Browse…')
  browse.type = 'button'
  row.append(input, browse)
  // One Optics group: label, the input+Browse row as the control, then the hint
  // and the file list, which Optics stacks under it.
  const panel = el('div')
  const hint = el('div', 'form-hint hint')
  input.classList.add('form-control')
  const group = el('div', 'form-group')
  group.append(el('label', 'form-label', label), row, hint, panel)
  form.append(group)

  const settle = () => {
    panel.innerHTML = ''
    opts.onPick?.(input.value.trim(), hint)
  }
  input.onchange = settle

  /*
   * Where it was last time, per field.
   *
   * Reopening at $HOME every time is most of why this felt like a dead end: the
   * footage is eight levels down and you walked there again on every visit. Kept in
   * memory rather than storage because it is a convenience for this sitting, not a
   * preference worth persisting.
   */
  let lastDir = null

  const open = async (path) => {
    const d = await (await fetch('/api/browse' + (path ? '?path=' + encodeURIComponent(path) : ''))).json()
    panel.innerHTML = ''
    const box = el('div', 'joblist')
    if (d.error) {
      box.append(Object.assign(el('div', 'job'), { textContent: d.error }))
      panel.append(box)
      return
    }
    lastDir = d.path

    /*
     * The places footage actually lives, as one click each.
     *
     * The server decides which of these exist, so a chip is never a dead end.
     */
    if (d.places?.length) {
      const chips = el('div')
      chips.style.cssText = 'display:flex;flex-wrap:wrap;gap:var(--op-space-2x-small);padding:var(--op-space-x-small)'
      for (const place of d.places) {
        const c = el('button', 'btn ghost', place.name)
        c.type = 'button'
        c.style.cssText = 'padding:var(--op-space-2x-small) var(--op-space-x-small);font-size:var(--op-font-x-small)'
        if (place.path === d.path) c.disabled = true
        c.onclick = () => open(place.path)
        chips.append(c)
      }
      box.append(chips)
    }

    /*
     * A breadcrumb you can click, rather than a line of text and a `..`.
     *
     * Coming back up from `media/Footage` to the library root was four clicks on
     * `..`, and nothing told you how far down you were.
     */
    const trail = el('div', 'crumb')
    trail.style.cssText = 'display:flex;flex-wrap:wrap;gap:var(--op-space-2x-small);align-items:baseline'
    const hop = (label, target, current) => {
      if (current) {
        trail.append(Object.assign(el('span'), { textContent: label }))
        return
      }
      const a = el('button', 'btn ghost', label)
      a.type = 'button'
      a.style.cssText = 'padding:0 var(--op-space-2x-small);font-size:var(--op-font-x-small);background:none;border:0;text-decoration:underline'
      a.onclick = () => open(target)
      trail.append(a)
    }
    hop('~', d.home, d.path === d.home)
    for (const [i, c] of (d.crumbs ?? []).entries()) {
      trail.append(Object.assign(el('span'), { textContent: '/' }))
      hop(c.name, c.path, i === d.crumbs.length - 1)
    }
    box.append(trail)

    const rows = el('div')
    box.append(rows)

    const entry = (text, tag, onClick) => {
      const r = el('div', 'job')
      const e = el('div', 'ent')
      e.append(Object.assign(el('div', 'nm2'), { textContent: text }), Object.assign(el('div', 'tag'), { textContent: tag || '' }))
      r.append(e)
      r.onclick = onClick
      rows.append(r)
    }

    // Everything the folder holds, computed once so the filter can re-render
    // without another request.
    const items = []
    if (opts.allowDir) {
      items.push({ text: 'Use this folder', tag: 'choose', always: true, run: () => { input.value = d.path; settle() } })
    }
    if (d.parent) items.push({ text: '..', tag: 'up', always: true, run: () => open(d.parent) })
    for (const dir of d.dirs) items.push({ text: dir.name + '/', tag: 'folder', name: dir.name, run: () => open(dir.path) })
    let hidden = 0
    for (const file of d.files) {
      if (opts.accept && !opts.accept(file)) {
        hidden++
        continue
      }
      const tag = file.trace ? 'trace' : file.video ? 'video' : file.audio ? 'audio' : file.image ? 'image' : file.subs ? 'subtitles' : 'file'
      items.push({ text: file.name, tag, name: file.name, run: () => { input.value = file.path; settle() } })
    }

    const note = el('div', 'crumb')
    const paint = () => {
      rows.innerHTML = ''
      const q = filter.value.trim().toLowerCase()
      let shown = 0
      for (const it of items) {
        if (q && !it.always && !(it.name ?? '').toLowerCase().includes(q)) continue
        if (!it.always) shown++
        entry(it.text, it.tag, it.run)
      }
      const parts = []
      if (q) parts.push(`${shown} of ${items.filter((i) => !i.always).length} matching "${filter.value.trim()}"`)
      if (hidden) parts.push(`${hidden} other file${hidden === 1 ? '' : 's'} here, not the kind this field wants`)
      note.textContent = parts.join(' · ')
      note.style.display = parts.length ? '' : 'none'
    }

    /*
     * Type to narrow, because a folder with three hundred entries is a scroll.
     * Enter takes the only match, which is what makes it feel like a path bar.
     */
    const filter = Object.assign(el('input', 'form-control'), { placeholder: 'Filter this folder…', type: 'search' })
    filter.style.cssText = 'margin:var(--op-space-x-small);inline-size:calc(100% - var(--op-space-medium))'
    filter.oninput = paint
    filter.onkeydown = (ev) => {
      if (ev.key !== 'Enter') return
      ev.preventDefault()
      const q = filter.value.trim().toLowerCase()
      const hits = items.filter((i) => !i.always && (i.name ?? '').toLowerCase().includes(q))
      if (hits.length === 1) hits[0].run()
    }
    box.insertBefore(filter, rows)
    box.append(note)
    paint()
    panel.append(box)
    filter.focus()
  }
  browse.onclick = () => {
    if (panel.innerHTML) panel.innerHTML = ''
    else open(input.value.trim() || lastDir || undefined)
  }
  return input
}

/**
 * The API key field for a cloud voice provider.
 *
 * Shown whenever that provider is selected — never conditional on whether a key
 * is already stored. The first version only appeared when the server said
 * `needsKey`, which hid it in exactly the situation you most need it: a key that
 * is stored but wrong. And the test panel offered ElevenLabs with no key field
 * anywhere at all, so there was no way to enter one from that side of the app.
 *
 * One implementation, used by both panels, so they cannot drift apart again.
 */
function apiKeyBlock(form, { onSaved } = {}) {
  const block = el('div', 'form-group')
  const row = el('div', 'pick')
  const input = Object.assign(el('input'), { type: 'password', placeholder: 'ElevenLabs API key — starts with sk_', className: 'form-control' })
  const save = el('button', 'btn ghost', 'Save the key')
  save.type = 'button'
  row.append(input, save)
  const note = el('div', 'form-hint hint')
  block.append(el('label', 'form-label', 'ElevenLabs key'), row, note)
  form.append(block)

  const status = async () => {
    const d = await (await fetch('/api/keys')).json().catch(() => ({ status: {} }))
    const have = Boolean(d.status?.elevenlabs)
    save.textContent = have ? 'Replace the key' : 'Save the key'
    tone(note)
    note.textContent = have ? 'A key is stored — saving again replaces it. Kept in ~/.rolemodel-video/config.json, readable only by you; it is never sent back to the browser and never appears in a command.' : 'ElevenLabs keys start with sk_ and are shown only when the key is created or rotated. The long value listed beside a key in the dashboard is its id, not the key.'
    return have
  }

  save.onclick = async () => {
    const key = input.value.trim()
    if (!key) {
      tone(note, 'bad')
      note.textContent = 'Nothing to save.'
      return
    }
    save.disabled = true
    const r = await (await fetch('/api/keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'elevenlabs', key }) })).json()
    save.disabled = false
    if (r.error) {
      tone(note, 'bad')
      note.textContent = r.error
      return
    }
    input.value = ''
    await status()
    tone(note, 'ok')
    note.textContent = 'Saved. ' + note.textContent
    onSaved?.()
  }

  status()
  return {
    show: (on) => {
      block.style.display = on ? '' : 'none'
    },
    refresh: status,
  }
}

/** A numbered account of what is about to happen. Each item is [what, why]. */
function plan(items) {
  const ul = el('ul', 'plan')
  for (const [what, why] of items) {
    const li = el('li')
    const d = el('div')
    d.append(Object.assign(el('span'), { textContent: what }))
    if (why) d.append(el('br'), Object.assign(el('span', 'w'), { textContent: why }))
    li.append(d)
    ul.append(li)
  }
  return ul
}

/* ── Library ─────────────────────────────────────────────── */

/** Which project is open. null means the index. */
let openProject = null
/** Grid or list. */
let libView = 'grid'
/** all | media | empty */
let libFilter = 'all'
/** name | updated | size */
let libSort = 'name'

const FILTERS = [
  ['all', 'All projects'],
  ['media', 'With media'],
  ['empty', 'Empty'],
]
const SORTS = [
  ['name', 'Name'],
  ['updated', 'Updated'],
  ['size', 'Size'],
]

/** "2y ago", "3h ago". Coarse on purpose — nobody needs seconds here. */
function ago(iso) {
  if (!iso) return 'never'
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  const steps = [
    [31536000, 'y'],
    [2592000, 'mo'],
    [604800, 'w'],
    [86400, 'd'],
    [3600, 'h'],
    [60, 'm'],
  ]
  for (const [secs, unit] of steps) if (s >= secs) return `${Math.floor(s / secs)}${unit} ago`
  return 'just now'
}

/** Everything the index needs to know about a project, computed once. */
function projectFacts(p) {
  const files = p.catalog?.files ?? []
  const counts = {}
  let bytes = 0
  let newest = p.createdAt ?? null
  for (const f of files) {
    counts[f.kind] = (counts[f.kind] ?? 0) + 1
    bytes += f.bytes
    if (!newest || f.mtime > newest) newest = f.mtime
  }
  const poster = files.find((f) => f.kind === 'video') ?? files.find((f) => f.kind === 'still')
  return { files, counts, bytes, newest, poster }
}

/**
 * The two swoops from the brand illustration. Static geometry, so they sit out
 * here rather than being rebuilt for every card.
 */
const ART_SWOOP_TOP =
  'M-1,-1L599,-1L599,190.309C597.866,192.147 599.211,195.14 598.171,197.049C597.972,187.035 598.168,177.64 598.109,167.75L598.057,55.543L597.986,21.084C598.01,16.095 598.361,5.194 597.834,0.363C597.348,-0.042 596.835,-0.139 596.205,-0.127C582.21,0.141 568.197,-0.276 554.202,0.005C552.318,0.043 547.229,-0.617 545.885,0.245C543.764,5.202 542.091,11.616 540.192,16.759C538.789,20.566 536.876,24.13 535.59,27.97C535.312,28.8 533.316,31.311 532.941,32.253C530.958,37.244 528.441,41.966 526.045,46.77C525.538,47.784 525.192,49.006 524.642,49.944C523.051,52.658 520.854,55.378 519.564,58.254C519.43,58.554 519.778,60.373 519.857,60.805L519.409,61.642L518.732,61.706C518.615,61.16 518.53,60.568 518.437,60.014C517.786,60.421 517.385,61.406 516.969,62.157L517.411,62.646C515.038,64.858 510.324,71.263 509.797,74.278L509.527,74.185L509.366,73.566C507.992,75.405 504.213,80.022 503.398,82.135C502.927,83.355 503.683,89.278 502.528,89.82C502.443,88.529 502.713,83.241 502.408,82.75C499.279,86.911 495.963,90.878 492.479,94.748C491.296,96.063 490.142,98.082 488.938,99.277C482.325,105.841 476.064,112.689 469.224,119.025C468.184,119.986 466.505,120.887 465.345,121.82L447.087,136.792C442.637,140.401 437.132,143.084 432.315,146.19C424.979,150.918 417.184,154.901 409.549,159.108L338.021,197.904L254.267,243.494C233.262,254.891 213.822,266.864 191.025,274.444C166.891,282.366 141.338,285.018 116.091,282.221C81.344,278.176 48.457,264.36 21.247,242.375C12.216,235.026 7.102,229.389 -1,221.541L-1,-1Z'
const ART_SWOOP_BOTTOM =
  'M599.171,198.049C600.211,196.14 598.866,193.147 600,191.309L600,600L0,600L0,455.892C2.65,457.453 6.034,460.107 8.788,461.842C15.032,465.776 21.31,469.954 27.731,473.596C64.278,494.411 105.086,506.631 147.059,509.329C185.47,511.752 223.951,505.849 259.87,492.026C269.407,488.353 278.753,484.198 287.871,479.581C301.989,472.295 317.03,462.639 330.732,454.266L389.78,418.011L500.496,350.265C515.561,341.045 530.701,331.942 545.672,322.553C551.253,319.055 556.509,314.924 561.967,311.566C570.732,306.176 579.765,301.096 588.313,295.315C601.509,287.584 598.919,291.979 598.995,276.258L599.109,219.14C599.136,212.072 598.904,205.162 599.171,198.049Z'

/** One linear gradient. No radial ones anywhere — the brand is direction, not blobs. */
const artGradient = (id, transform, from, to) => `<linearGradient id='${id}' x1='0' y1='0' x2='1' y2='0' gradientUnits='userSpaceOnUse' gradientTransform='${transform}'>` + `<stop offset='0' stop-color='${from}'/><stop offset='1' stop-color='${to}'/></linearGradient>`

/**
 * An Optics token as a colour a data: URI can actually use.
 *
 * A data URL is its own document, and custom properties do not cascade across
 * that boundary: fill='var(--op-color-academy-primary-base)' inside the SVG
 * resolves against nothing and paints black. getPropertyValue is no help either
 * — it hands back the unresolved light-dark(hsl(...), hsl(...)) text, which is
 * not a colour. So the token goes onto a throwaway element and comes back as
 * what the browser actually computed, in the mode currently in force.
 */
function paint(token) {
  const probe = el('span')
  probe.style.display = 'none'
  probe.style.color = `var(${token})`
  document.body.append(probe)
  const colour = getComputedStyle(probe).color
  probe.remove()
  return colour
}

/**
 * The card art.
 *
 * A poster frame when the project has footage, because that is the most useful
 * thing a thumbnail can be. Otherwise the brand's own colour as a gradient —
 * projects are told apart by client and brand long before they have media, and a
 * row of identical grey rectangles tells you nothing.
 *
 * The SVG is written out plainly and encoded once, at the end. It arrived here
 * pre-encoded, which broke it three ways at once: the interpolations had been
 * percent-encoded along with everything else, so the gradient stops read the
 * literal text dollar-7Bc1-7D; the colours were var() references, which cannot
 * resolve inside a data URI; and the value ended in a stray semicolon, which
 * makes it invalid, so the assignment was rejected outright and no card ever
 * had any art at all. Encoding last keeps the source readable and puts the
 * interpolation before the escaping instead of after it.
 */
function cardArt(p, facts) {
  const art = el('div', 'projart')
  if (facts.poster) {
    art.style.backgroundImage = `url('/thumb/${p.id}/${encodeURI(facts.poster.rel)}')`
    art.style.backgroundSize = 'cover'
    art.style.backgroundPosition = 'center'
    return art
  }

  // The project's own hue when it has one, the house green when it does not.
  const sub = (S.tokens?.subBrands ?? {})[p.brand]
  const c1 = sub ? `hsl(${sub.h} ${sub.s}% ${sub.l}%)` : paint('--op-color-academy-primary-minus-one')
  const c2 = sub ? `hsl(${sub.h} ${sub.s}% ${Math.max(8, sub.l - 20)}%)` : paint('--op-color-academy-primary-minus-five')
  const bg = sub ? `hsl(${sub.h} ${sub.s}% ${Math.max(5, sub.l - 40)}%)` : paint('--op-color-neutral-plus-max')

  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 600 600' width='100%' height='100%' preserveAspectRatio='xMidYMid slice'>` +
    `<rect width='600' height='600' fill='url(#artA)'/>` +
    `<path d='${ART_SWOOP_TOP}' fill='url(#artB)'/>` +
    `<path d='${ART_SWOOP_BOTTOM}' fill='url(#artC)'/>` +
    `<defs>` +
    artGradient('artA', 'matrix(-70,-195,195,-70,422,398)', c1, c2) +
    artGradient('artB', 'matrix(126.509766,288.494727,-288.494727,126.509766,182,-48)', c1, c1) +
    artGradient('artC', 'matrix(-110,-291,291,-110,510,582)', c1, c2) +
    `</defs></svg>`

  // The tone behind the artwork, so the corners the swoops do not reach are the
  // project's own colour rather than the page showing through.
  art.style.backgroundColor = bg
  art.style.backgroundImage = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
  return art
}

function vLibrary(m) {
  if (openProject) return vProject(m, openProject)

  // Toolbar: how it is shown, what is shown, in what order.
  const bar = el('div', 'libbar')
  const seg = el('div', 'seg')
  for (const [id, label] of [
    ['grid', 'Grid'],
    ['list', 'List'],
  ]) {
    const b = el('button', 'segbtn', label)
    b.type = 'button'
    b.setAttribute('aria-pressed', String(libView === id))
    b.onclick = () => {
      libView = id
      render()
    }
    seg.append(b)
  }
  const pick = (label, value, options, onPick) => {
    const wrap = el('div', 'libpick')
    wrap.append(Object.assign(el('span', 'libpicklabel'), { textContent: label }))
    const sel = el('select', 'libselect')
    for (const [v, t] of options) sel.append(Object.assign(el('option', null, t), { value: v, selected: v === value }))
    sel.onchange = () => {
      onPick(sel.value)
      render()
    }
    wrap.append(sel)
    return wrap
  }
  bar.append(
    seg,
    pick('Filtered by', libFilter, FILTERS, (v) => {
      libFilter = v
    }),
    pick('Sorted by', libSort, SORTS, (v) => {
      libSort = v
    }),
  )
  const s = el('input')
  s.type = 'search'
  s.className = 'form-control'
  s.setAttribute('aria-label', 'Search projects')
  s.placeholder = 'Search projects…'
  s.value = q
  s.oninput = () => {
    q = s.value
    drawItems()
  }
  bar.append(s)
  m.append(bar)

  const host = el('div')
  host.id = 'items'
  m.append(host)
  drawItems()
}

function drawItems() {
  const host = $('#items')
  if (!host) return
  host.innerHTML = ''
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean)

  let projects = S.projects.map((p) => ({ p, f: projectFacts(p) }))
  if (libFilter === 'media') projects = projects.filter((x) => x.f.files.length > 0)
  if (libFilter === 'empty') projects = projects.filter((x) => x.f.files.length === 0)
  if (terms.length) {
    projects = projects.filter(({ p, f }) => {
      const hay = [p.name, p.client, p.brand, ...f.files.map((x) => x.rel)].filter(Boolean).join(' ').toLowerCase()
      return terms.every((t) => hay.includes(t))
    })
  }
  const by = {
    name: (a, b) => a.p.name.localeCompare(b.p.name),
    updated: (a, b) => String(b.f.newest ?? '').localeCompare(String(a.f.newest ?? '')),
    size: (a, b) => b.f.bytes - a.f.bytes,
  }
  projects.sort(by[libSort])

  const grid = el('div', libView === 'grid' ? 'projgrid' : 'projlist')

  for (const { p, f } of projects) {
    const card = el('div', 'projcard')
    card.append(cardArt(p, f))

    const cap = el('div', 'projcap')
    cap.append(Object.assign(el('div', 'projname'), { textContent: p.name }), Object.assign(el('div', 'projclient'), { textContent: p.client || 'No client' }))
    card.append(cap)

    const foot = el('div', 'projfoot')
    const summary = f.files.length ? [f.counts.video && `${f.counts.video} video`, f.counts.audio && `${f.counts.audio} audio`, f.counts.still && `${f.counts.still} still`].filter(Boolean).join(' · ') : 'empty'
    foot.append(Object.assign(el('div', 'projwhen'), { textContent: `${summary}${f.bytes ? ' · ' + human(f.bytes) : ''}` }), Object.assign(el('div', 'projwhen'), { textContent: 'Updated ' + ago(f.newest) }))
    card.append(foot)

    card.onclick = () => {
      openProject = p.id
      render()
    }
    card.style.cursor = 'pointer'
    grid.append(card)
  }

  // The tile that makes the index actionable rather than a list you read.
  const add = el('div', 'projcard projnew')
  const plus = el('div', 'projplus', '+')
  add.append(plus, Object.assign(el('div', 'projname'), { textContent: 'New project' }))
  add.onclick = () => go('new')
  add.style.cursor = 'pointer'
  grid.append(add)

  host.append(grid)
  if (!projects.length && terms.length) host.append(el('p', 'empty', 'No project matches that.'))
  if (!S.projects.length) host.append(el('p', 'empty', 'No projects yet — the tile above starts one.'))
}

/** One project, opened. */
function vProject(m, id) {
  const p = S.projects.find((x) => x.id === id)
  if (!p) {
    openProject = null
    return vLibrary(m)
  }
  const f = projectFacts(p)

  crumbs([
    {
      label: 'Library',
      go: () => {
        openProject = null
        render()
      },
    },
    { label: p.name },
  ])
  m.append(el('p', 'lede', `${p.client || 'No client'} · ${p.brand} · ${f.files.length} file${f.files.length === 1 ? '' : 's'}${f.bytes ? ' · ' + human(f.bytes) : ''} · updated ${ago(f.newest)}`))

  const row = el('div', 'row')
  for (const k of ['', 'video', 'audio', 'still']) {
    const c = el('button', 'chip', k || 'All')
    c.type = 'button'
    c.setAttribute('aria-pressed', String(kind === k))
    c.onclick = () => {
      kind = k
      render()
    }
    row.append(c)
  }
  const re = el('button', 'btn ghost', 'Re-index')
  re.onclick = async () => {
    re.disabled = true
    re.textContent = 'Indexing…'
    await fetch('/api/index/' + p.id, { method: 'POST' })
    await load()
  }
  // Deleting the project needs `kind` — the server refuses a project root without
  // it, so a mistyped path can never take a whole client's work.
  const delProject = deleteButton({
    path: S.libraryRoot + '/' + p.id,
    kind: 'project',
    text: 'Delete project',
    label: `all of ${p.name}`,
    after: async () => {
      openProject = null
      await load()
    },
  })

  row.append(re, delProject)

  /*
   * Bring in footage you already have.
   *
   * Recording and scripting both make video; there was no way to use video that
   * already existed, which is most of it — a client's screen recording, an old
   * export, something from Slack. The library indexes whatever is on disk, so an
   * import is a copy into the right folder; the point of doing it here is that
   * this side knows which folder, and a person should not have to.
   */
  const importWrap = el('div', 'full')
  const importHint = el('div', 'hint')
  const importPath = pathField(importWrap, 'Add footage', {
    placeholder: 'a video, audio file or still image',
    accept: (x) => x.media ?? true,
    onPick: (path, hint) => {
      tone(hint)
      hint.textContent = path ? '' : 'Copied into the project — the original is left where it is.'
    },
  })
  const doImport = el('button', 'btn ghost', 'Add to this project')
  doImport.onclick = async () => {
    if (!importPath.value.trim()) {
      tone(importHint, 'warn')
      importHint.textContent = 'Pick a file first.'
      return
    }
    doImport.disabled = true
    tone(importHint)
    importHint.textContent = 'copying…'
    const r = await (
      await fetch('/api/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: p.id, file: importPath.value.trim() }),
      })
    ).json()
    doImport.disabled = false
    if (r.error) {
      tone(importHint, 'bad')
      importHint.textContent = r.error
      return
    }
    tone(importHint, 'ok')
    importHint.textContent = `Added to ${r.into}` + (r.renamed ? ` as ${r.renamed} — something was already called that` : '') + '.'
    importPath.value = ''
    await load()
  }
  importWrap.append(doImport, importHint)
  m.append(importWrap)
  m.append(row)
  m.append(Object.assign(el('div', 'path'), { textContent: S.libraryRoot + '/' + p.id }))

  const files = f.files.filter((x) => !kind || x.kind === kind)
  if (!files.length) {
    m.append(el('p', 'empty', f.files.length ? 'Nothing of that kind here.' : 'Nothing here yet. Record into it, or drop footage in ' + p.id + '/media.'))
    return
  }
  const g = el('div', 'grid')
  for (const x of files) g.append(fileCard(p, x))
  m.append(g)
}

/** One file, as a card. */
/**
 * A delete that has to be meant twice.
 *
 * One click arms it and names what will go; the second does it. No modal — a
 * modal for this is the lazy answer, and it moves the decision away from the
 * thing being decided about. The armed state also says where it goes, because
 * "Delete" and "moved to .trash, drag it back" are different promises and the
 * button should make the right one.
 *
 * `after` runs on success. Anything that changes what is on screen belongs
 * there, not here, because this does not know what it was attached to.
 */
function deleteButton({ path, projectId, rel, label, kind, after, text = 'Delete' }) {
  const b = el('button', 'btn ghost del')
  b.type = 'button'
  b.textContent = text
  b.title = path ?? rel ?? ''
  let armed = false
  const disarm = () => {
    armed = false
    b.className = 'btn ghost del'
    b.textContent = text
  }
  b.onclick = async (e) => {
    e.stopPropagation() // the card underneath opens the file; this is not that
    if (!armed) {
      armed = true
      b.className = 'btn ghost del armed'
      b.textContent = `Delete ${label}? Click again`
      setTimeout(() => armed && disarm(), DISARM_MS)
      return
    }
    b.disabled = true
    b.textContent = 'Deleting...'
    const r = await (
      await fetch('/api/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path, projectId, rel, kind }),
      })
    ).json()
    b.disabled = false
    if (r.error) {
      b.className = 'btn ghost del'
      b.textContent = r.error.slice(0, 60)
      return
    }
    await after?.(r)
  }
  return b
}

/**
 * Hand a document to the editor.
 *
 * Two ways in, and the good one only exists when the Studio is a window in the
 * app: `window.rmStudio.openProject` is an IPC call to the process that owns the
 * editor. In a browser there is no such process, so the server shells out to
 * `openscreen open` — which needs the binary on PATH, needs that build to have
 * the verb, and falls back to revealing the file in Finder when it does not.
 * That whole path exists only for the browser case now.
 */
async function openDocument(payload) {
  const hosted = Boolean(window.rmStudio?.hosted)
  const r = await (
    await fetch('/api/open-media', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, hosted }),
    })
  ).json()
  if (r.error || !hosted) return r

  /*
   * Show it, then hand it over. In that order.
   *
   * The host routes a document to the embedded editor only when one is actually
   * mounted, and falls back to opening a window when it is not — so handing the
   * document over first, the way this used to, got both: a window opened, and then
   * the Studio mounted a second copy as a view. The visible symptom was the editor
   * appearing twice; the CDP transcript showed the window's URL had no `embedded`
   * flag on it.
   *
   * So navigating to the Editor view is the whole of it here. mountEditorInto()
   * hands `editorDoc` over once the view is in place, which is also what makes
   * coming back from another panel free: the document is only handed over when it
   * has changed, so a mounted editor keeps its timeline and its undo stack.
   */
  if (window.rmStudio.mountEditor) {
    editorDoc = r.document
    go('editor')
    return { ...r, opened: true, note: 'Opened in the editor.' }
  }

  const handed = await window.rmStudio.openProject(r.document)
  return handed.ok ? { ...r, opened: true, note: 'Opened in the editor.' } : { ...r, error: handed.error || 'the editor would not take it' }
}

function fileCard(project, f) {
  const c = el('div', 'card')
  const tw = el('div', 'thumbwrap')
  const t = el('div', 'thumb')
  if (f.kind === 'audio') t.textContent = 'AUDIO'
  else t.style.backgroundImage = `url('/thumb/${project.id}/${encodeURI(f.rel)}')`
  tw.append(t, el('span', 'kind ' + f.kind, f.kind))
  const b = el('div', 'body')
  b.append(el('div', 'nm', f.name), el('div', 'path', f.rel))
  const meta = el('div', 'meta')
  for (const x of [dur(f.media?.durationSec), f.media?.video ? f.media.video.width + '×' + f.media.video.height : null, f.media?.video?.fps ? f.media.video.fps + 'fps' : null, human(f.bytes), f.media?.video?.codec || f.media?.audio?.codec].filter(Boolean)) meta.append(el('span', null, x))
  b.append(meta)
  b.append(
    deleteButton({
      // project + rel, not a hand-built path: media lives under `media/` and this
      // side should not have to know that. Building it here produced
      // `<library>/<id>/Footage/demo.mp4` and a "no such file" for something
      // plainly on disk.
      projectId: project.id,
      rel: f.rel,
      label: f.name,
      after: () => load(),
    }),
  )
  // Clicking a video hands it to OpenScreen, not to a browser tab. A tab can
  // play it, which is the least useful thing to do with footage you are making a
  // video out of — the editor is where it needs to go. Audio and stills have no
  // editor to open, so those still just play.
  const note = el('div', 'path')
  note.style.cssText = 'flex-basis:100%'
  b.append(note)
  c.append(tw, b)
  c.onclick = async () => {
    if (f.kind !== 'video') {
      open('/media/' + project.id + '/' + encodeURI(f.rel))
      return
    }
    tone(note)
    note.textContent = 'opening in the editor...'
    const r = await openDocument({ projectId: project.id, rel: f.rel })
    // Opened means this card is gone — the Editor view replaced the page it was on.
    if (r.opened) return
    tone(note, r.error ? 'bad' : 'ok')
    note.textContent = r.error ?? r.note ?? 'opened'
  }
  c.style.cursor = 'pointer'
  return c
}

/* ── Editor ──────────────────────────────────────────────── */

/**
 * The editor, which lives in the same app.
 *
 * It was reachable but invisible: clicking a video opened an editor window and
 * nothing in the Studio said the editor existed. A capability you can only find
 * by guessing is not a capability.
 *
 * This lists the documents in the library — the branded `.openscreen` files the
 * pipeline writes — because that is what the editor opens. A video without a
 * document beside it gets one made on the way in, which is what
 * `/api/open-media` already does.
 */
function vEditor(m) {
  const hosted = Boolean(window.rmStudio?.hosted)

  /*
   * Hosted, this view IS the editor. No chooser, no document row above it.
   *
   * Both were here and both were redundant: the editor has File → Open, a recent
   * list and a New Project of its own, so a second picker in the panel around it
   * was a worse copy of a control four pixels away. The one thing it did that the
   * editor cannot — create a document for a video that has none — happens from the
   * Library, which is where you are when you have a video and no document.
   */
  if (hosted && window.rmStudio.mountEditor) {
    /*
     * Into #editor-host, not into `m`.
     *
     * `m` is #main, which sits inside Optics' .op-page__main-content and .container
     * — a reading measure and a page gutter, both of which are right for a form and
     * wrong for an application. #editor-host is their sibling, so the editor gets
     * the whole area without either wrapper having to be argued with. See the
     * `has-editor` rules in studio.html.
     */
    const host = $('#editor-host')
    host.innerHTML = ''
    const frame = el('div', 'editor-frame')
    host.append(frame)
    mountEditorInto(frame)
    return
  }

  m.append(el('p', 'lede', 'Zooms, annotations, trims and captions. The editor opens here, in this window, with the navigation still beside it — nothing is exported until you say so.'))

  if (!hosted) {
    const note = el('div', 'note')
    note.append(
      el('p', null, 'The Studio is running in a browser, so there is no editor to hand a document to.'),
      Object.assign(el('div', 'path'), {
        textContent: 'Open the app instead — the Studio appears as a window inside it, and this page can then open documents directly.',
      }),
    )
    m.append(note)
  }

  const host = el('div')
  m.append(host)
  void drawEditables(host)
}

/**
 * Put the editor in `frame` and keep it there while the frame moves.
 *
 * The rect is measured here rather than computed by the host, because this side is
 * the only one that knows where its own navigation ends — the alternative is the
 * main process carrying a copy of this stylesheet. `getBoundingClientRect()` is
 * already in the coordinate space `setBounds` wants: CSS pixels from the top-left
 * of the window's content area.
 *
 * A native view does not scroll with the document, so `has-editor` stops the page
 * scrolling for the duration (see studio.html). What is left that can move the
 * frame is a window resize and the sidebar's own scrollbar appearing, and a
 * ResizeObserver on the frame catches both.
 */
function mountEditorInto(frame) {
  document.body.classList.add('has-editor')

  const rect = () => {
    const r = frame.getBoundingClientRect()
    return { x: r.left, y: r.top, width: r.width, height: r.height }
  }

  let mounted = false
  const place = async () => {
    const r = rect()
    if (r.width < 2 || r.height < 2) return
    const fn = mounted ? window.rmStudio.layoutEditor : window.rmStudio.mountEditor
    const res = await fn(r)
    if (!res?.ok) {
      if (res?.error) {
        frame.textContent = res.error
        frame.style.padding = 'var(--op-space-large)'
      }
      return
    }
    if (mounted) return
    mounted = true
    // Only now: the host sends a document to the view when one is mounted and to a
    // new window when none is. Handing it over before this line opened both.
    if (editorDoc && editorHanded !== editorDoc) {
      const handed = await window.rmStudio.openProject(editorDoc)
      if (handed?.ok) editorHanded = editorDoc
    }
  }
  /*
   * Measured and mounted synchronously, NOT on the next animation frame.
   *
   * requestAnimationFrame was the first version of this line and it did not run:
   * Chromium suspends frames for a page that is not visible, and the Studio window
   * is frequently behind something when a document is opened from a script or a
   * shortcut. The editor then never appeared, with no error anywhere — mountEditor
   * was simply never called.
   *
   * Nothing was gained by waiting, either. `getBoundingClientRect()` forces layout,
   * so reading it here already sees the `has-editor` flex rules applied; the reason
   * to defer would have been to avoid that flush, and this happens once per open.
   */
  void place()

  const ro = new ResizeObserver(() => void place())
  ro.observe(frame)
  const onResize = () => void place()
  window.addEventListener('resize', onResize)
  editorWatch = () => {
    ro.disconnect()
    window.removeEventListener('resize', onResize)
  }
}

/**
 * The editable things, once the server has said which documents exist.
 *
 * Documents are not in the catalog and should not be — `buildCatalog` indexes
 * media, and a document is the edit rather than media. Inferring it client-side
 * from the catalog reported "no document yet" for every video in the library,
 * including the ones sitting right next to one.
 */
async function drawEditables(host) {
  host.innerHTML = ''
  const known = await (await fetch('/api/documents')).json().catch(() => ({ projects: [] }))
  const byProject = new Map((known.projects ?? []).map((p) => [p.id, new Set(p.documents ?? [])]))

  const docs = []
  for (const p of S.projects) {
    const documents = byProject.get(p.id) ?? new Set()
    for (const rel of documents) docs.push({ project: p, file: { name: rel.split('/').pop(), rel }, needsDoc: false })
    for (const f of p.catalog?.files ?? []) {
      if (f.kind !== 'video') continue
      const sibling = f.rel.replace(/\.[^.]+$/, '.openscreen')
      if (!documents.has(sibling)) docs.push({ project: p, file: f, needsDoc: true })
    }
  }

  if (!docs.length) {
    host.append(el('p', 'empty', 'Nothing to edit yet. Record something, or drop footage into a project.'))
    return
  }

  const list = el('div', 'grid')
  for (const { project, file, needsDoc } of docs) {
    const card = el('div', 'card')
    const body = el('div', 'body')
    body.append(Object.assign(el('div', 'nm'), { textContent: file.name }), Object.assign(el('div', 'path'), { textContent: project.name + ' · ' + file.rel }))
    const meta = el('div', 'meta')
    meta.append(el('span', null, needsDoc ? 'no document yet' : 'document'))
    if (file.media?.durationSec) meta.append(el('span', null, dur(file.media.durationSec)))
    body.append(meta)

    const note = el('div', 'path')
    note.style.cssText = 'flex-basis:100%'
    const openIt = el('button', 'btn ghost', needsDoc ? 'Make a document and open' : 'Open in the editor')
    openIt.onclick = async () => {
      openIt.disabled = true
      tone(note)
      note.textContent = 'opening…'
      const r = await openDocument({ projectId: project.id, rel: file.rel })
      // `opened` means the view has already been replaced by the editor, so there
      // is nothing here left to write to or re-draw.
      if (r.opened) return
      openIt.disabled = false
      tone(note, r.error ? 'bad' : 'ok')
      note.textContent = r.error ?? r.note ?? 'opened'
      if (!r.error) await drawEditables(host)
    }
    body.append(openIt, note)
    card.append(body)
    list.append(card)
  }
  host.append(list)
}

/* ── Review ──────────────────────────────────────────────── */

/**
 * Review: send a finished video out, and see what has already gone.
 *
 * Sharing existed only as a CLI, which put the step that decides whether a video
 * ships outside the tool that makes it. Configuration is reported rather than
 * assumed — an unset token and an unreachable instance need different fixes, and
 * "sharing is broken" is neither of them.
 */
function vReview(m) {
  m.append(el('p', 'lede', 'Send a finished video for review and get a link a client opens without an account. Their notes land on the frame they are about, rather than in a paragraph of email.'))

  const status = el('div', 'hint')
  m.append(status)
  const body = el('div')
  m.append(body)

  const draw = async () => {
    body.innerHTML = ''
    tone(status)
    status.textContent = 'asking OpenFrame…'
    const d = await (await fetch('/api/review')).json()

    if (!d.configured) {
      tone(status, 'warn')
      status.textContent = 'Not connected yet — the ' + d.missing.join(' and ') + (d.missing.length === 1 ? ' is' : ' are') + ' missing.'
      const note = el('div', 'note')
      note.append(
        el('p', null, 'OpenFrame is where a client leaves timestamped notes on a video. It runs itself — bring it up with Docker, then point this at it.'),
        Object.assign(el('div', 'path'), {
          textContent: 'A link only resolves for whoever can reach the instance, so localhost proves it works and is useless to a client.',
        }),
      )
      body.append(note)

      /*
       * Settings live here, not only in the environment.
       *
       * They used to be two exports, which works from a terminal and is
       * unreachable from the app: a GUI launched from Finder inherits no shell
       * environment, so this page could report the problem and never fix it.
       */
      const f = el('div', 'form')
      const mk = (label, node, hint) => field(f, label, node, hint)
      const urlIn = mk('OpenFrame url', Object.assign(el('input'), { placeholder: 'http://localhost:3100' }), 'Where the instance answers. Include the scheme.')
      const tokIn = mk('API token', Object.assign(el('input'), { type: 'password', placeholder: 'tok_…' }), 'From OPENFRAME_API_TOKENS on that instance. Stored on this machine, never shown again, and never sent anywhere but OpenFrame.')
      const out = el('div', 'full')
      const save = el('button', 'btn', 'Connect')
      const wrap = el('div', 'full')
      wrap.append(save)
      f.append(wrap, out)
      body.append(f)

      save.onclick = async () => {
        out.innerHTML = ''
        const hint = el('div', 'hint')
        out.append(hint)
        const payload = {}
        if (urlIn.value.trim()) payload.url = urlIn.value.trim()
        if (tokIn.value) payload.token = tokIn.value
        if (!Object.keys(payload).length) {
          tone(hint, 'warn')
          hint.textContent = 'Fill in whichever one is missing.'
          return
        }
        save.disabled = true
        const r = await (await fetch('/api/review/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })).json()
        save.disabled = false
        if (r.error) {
          tone(hint, 'bad')
          hint.textContent = r.error
          return
        }
        tone(hint, 'ok')
        hint.textContent = 'Stored in ' + r.stored
        await draw()
      }
      return
    }

    if (d.error) {
      tone(status, 'bad')
      status.textContent = d.base + ' answered: ' + d.error
      return
    }

    tone(status, 'ok')
    const shared = d.projects.reduce((n, p) => n + p.videos.length, 0)
    status.textContent = `${d.base} · ${d.workspaces} workspace${d.workspaces === 1 ? '' : 's'} · ${shared} video${shared === 1 ? '' : 's'} out for review`

    // Send something.
    const f = el('div', 'form')
    const pick = el('select')
    const videos = []
    for (const p of S.projects) {
      for (const file of p.catalog?.files ?? []) {
        if (file.kind !== 'video') continue
        videos.push({ p, file })
        pick.append(Object.assign(el('option', null, `${p.name} · ${file.name}`), { value: `${p.id}::${file.rel}` }))
      }
    }
    const mk = (label, node, hint) => field(f, label, node, hint)
    mk('Video', pick, 'Only finished renders are worth sending — a client reviewing an unbranded capture will comment on the branding.')
    const projName = mk('OpenFrame project', Object.assign(el('input'), { placeholder: 'Feeney Railing' }), 'Created if it does not exist. Re-sending into the same one adds a version rather than a duplicate.')
    const titleIn = mk('Title', Object.assign(el('input'), { placeholder: 'Estimating walkthrough (v1)' }))
    const out = el('div', 'full')
    const go = el('button', 'btn', 'Send for review')
    const wrap = el('div', 'full')
    wrap.append(go)
    f.append(wrap, out)

    go.onclick = async () => {
      if (!videos.length) return
      const [projectId, rel] = pick.value.split('::')
      go.disabled = true
      out.innerHTML = ''
      const hint = el('div', 'hint')
      hint.textContent = 'uploading… a render takes as long as it takes'
      out.append(hint)
      const r = await (
        await fetch('/api/review/send', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ projectId, rel, project: projName.value || 'Untitled', title: titleIn.value || undefined }),
        })
      ).json()
      go.disabled = false
      if (r.error) {
        tone(hint, 'bad')
        hint.textContent = r.error
        return
      }
      tone(hint, 'ok')
      hint.textContent = `${r.project} · ${r.video.title}`
      const link = el('div', 'runrow')
      link.append(Object.assign(el('code'), { textContent: r.shareUrl }))
      const copy = copyButton(el('button', 'btn ghost', 'Copy link'), 'Copy link', r.shareUrl)
      const openIt = el('button', 'btn ghost', 'Open')
      openIt.onclick = () => open(r.shareUrl)
      link.append(copy, openIt)
      out.append(link)
      await draw()
    }
    body.append(f)

    // What is already out.
    if (shared) {
      body.append(el('div', 'client', 'Out for review'))
      const g = el('div', 'grid')
      for (const p of d.projects) {
        for (const v of p.videos) {
          const c = el('div', 'card')
          /*
           * The thumbnail, which the listing has carried all along.
           *
           * Proxied through the Studio rather than linked: OpenFrame serves these from
           * /api/upload/image/<file> behind a project-access check, so an anonymous
           * <img> gets 403 — and the page has no session and must never be handed the
           * token to get one.
           *
           * `.projart` is the library's own card art, so a review card and a project
           * card read as the same kind of object. A video whose thumbnail file was
           * never generated just shows the sunk panel behind it.
           */
          if (v.thumbnail && v.versionId) {
            const art = el('div', 'projart')
            const src = '/api/review/thumb?project=' + encodeURIComponent(v.projectId) + '&video=' + encodeURIComponent(v.id)
            art.style.backgroundImage = `url("${src}")`
            c.append(art)
          }

          const b = el('div', 'body')
          /*
           * What the listing already knows, shown.
           *
           * The card used to be a title and a path, which is why this page read as
           * "they just sit there" — nothing on it could tell you whether a client had
           * been in. The version and the comment count arrive in the same call that
           * lists the videos.
           */
          const facts = [
            v.version ? 'v' + v.version + (v.versions > 1 ? ' of ' + v.versions : '') : null,
            v.comments ? v.comments + ' comment' + (v.comments === 1 ? '' : 's') : 'no comments yet',
            v.duration ? Math.round(v.duration) + 's' : null,
          ].filter(Boolean)
          b.append(
            Object.assign(el('div', 'nm'), { textContent: v.title }),
            Object.assign(el('div', 'path'), { textContent: p.workspace + ' · ' + p.name }),
            Object.assign(el('div', 'path'), { textContent: facts.join(' · ') }),
          )

          /*
           * How it is going, on demand.
           *
           * The count above is every comment ever left, so a video whose notes are
           * all dealt with looks identical to one nobody has touched. Unresolved is
           * the number that means anything, and it is a call per video — so it is a
           * button, not part of the listing.
           */
          const state = el('div', 'hint')
          const checkIt = el('button', 'btn ghost')
          checkIt.append(icon('comment-01'))
          checkIt.title = 'Check for feedback'
          checkIt.setAttribute('aria-label', 'Check for feedback')
          checkIt.disabled = !v.versionId
          checkIt.onclick = async () => {
            checkIt.disabled = true
            tone(state)
            state.textContent = 'asking OpenFrame…'
            const r = await fetch('/api/review/status?version=' + encodeURIComponent(v.versionId))
              .then((x) => x.json())
              .catch(() => ({ error: 'could not reach the Studio' }))
            checkIt.disabled = false
            if (r.error) {
              tone(state, 'bad')
              state.textContent = r.error
              return
            }
            const bits = []
            if (r.unresolved != null) bits.push(r.unresolved ? r.unresolved + ' open of ' + r.total : (r.total ? 'all ' + r.total + ' dealt with' : 'no notes yet'))
            if (r.approval?.status) bits.push('approval ' + String(r.approval.status).toLowerCase())
            tone(state, r.unresolved ? 'warn' : 'ok')
            state.textContent = bits.join(' · ') || 'nothing to report'
          }
          /*
           * The link is resolved on click, not composed here.
           *
           * This used to open `${base}/watch/${id}`, which carries no share token —
           * OpenFrame finds no share-session cookie, answers 403, and the page reads
           * "Video not found or access denied". It worked for whoever uploaded the
           * video, because a signed-in project member passes the access check and
           * never needs a token, which is exactly why it survived being wrong.
           *
           * One resolver behind both buttons, so re-sending a link to a client does
           * not mean opening the video to copy the URL out of the address bar — which
           * would not work anyway: /watch strips the token into a cookie on arrival,
           * so the URL you can see is never the URL to send.
           */
          const why = el('div', 'hint')
          const resolve = async (btn) => {
            const was = btn.textContent
            btn.disabled = true
            btn.textContent = 'Finding the link…'
            const r = await fetch(`/api/review/link?project=${encodeURIComponent(v.projectId)}&video=${encodeURIComponent(v.id)}`)
              .then((x) => x.json())
              .catch(() => ({ error: 'could not reach the Studio' }))
            btn.disabled = false
            btn.textContent = was
            if (!r.shareUrl) {
              tone(why, 'bad')
              why.textContent = r.error || 'No share link yet — send it for review to make one.'
              return null
            }
            why.textContent = ''
            return r.shareUrl
          }
          const openIt = el('button', 'btn ghost')
          openIt.append(icon('arrow-up-right-01'))
          openIt.title = 'Open in OpenFrame'
          openIt.setAttribute('aria-label', 'Open in OpenFrame')
          openIt.onclick = async () => {
            const link = await resolve(openIt)
            if (link) open(link)
          }
          const copyIt = el('button', 'btn ghost')
          copyIt.append(icon('link-01'))
          copyIt.title = 'Copy link'
          copyIt.setAttribute('aria-label', 'Copy the share link')
          copyButton(copyIt, null, () => resolve(copyIt))
          // One row of icons rather than three stacked full-width buttons: the card is
          // a thing you glance at, and the words live in the tooltip and aria-label.
          const acts = el('div')
          acts.style.cssText = 'display:flex;gap:var(--op-space-2x-small);flex-wrap:wrap'
          acts.append(checkIt, openIt, copyIt)
          b.append(acts, state, why)
          c.append(b)
          g.append(c)
        }
      }
      body.append(g)
    }
  }
  draw()
}

/* ── Building a demo, a step at a time ────────────────────────
   The Record page used to want a markdown script with a ```do block in it, which
   is a fine thing to read and an unreasonable thing to be asked to author. The
   people making these videos are not developers: `expect "REQUEST QUOTE"` assumes
   you know what expect means, that the button is spelled in caps, and that a
   fenced code block is how you say it.

   So the steps are rows. Pick what happens from a list written in English, fill
   in the one or two things it needs, drag it up or down, say what you want said
   while it happens. The markdown is still what runs — the builder writes it, the
   checker checks it, and anyone who does want to hand-edit it still can. */

/** The verbs, in the words someone would use, with the fields each one needs. */
const DEMO_ACTIONS = [
  { verb: 'goto', label: 'Go to a page', fields: [{ ph: '/quotes/new  or  https://app.example.com/quotes/new', hint: 'A path if you set a base URL above, or a whole address.' }] },
  { verb: 'click', label: 'Click something', fields: [{ ph: 'REQUEST QUOTE', hint: 'The words on it. Use the exact capitalisation you see on screen.' }] },
  { verb: 'dblclick', label: 'Double-click something', fields: [{ ph: 'row 3' }] },
  { verb: 'hover', label: 'Hover over something', fields: [{ ph: 'Pricing' }] },
  { verb: 'type', label: 'Type into a field', fields: [{ ph: 'Project name' }, { ph: 'Feeney Deck Rail' }], hint: 'The field first, then what to type into it.' },
  { verb: 'fill', label: 'Replace what a field says', fields: [{ ph: 'Quantity' }, { ph: '12' }], hint: 'Like typing, but it clears the field first.' },
  { verb: 'press', label: 'Press a key', fields: [{ key: true }] },
  { verb: 'expect', label: 'Wait until something appears', fields: [{ ph: 'Quote saved' }], hint: 'The demo pauses here until it shows up, then carries on. Use it after anything that loads.' },
  { verb: 'wait', label: 'Pause', fields: [{ num: true, ph: '800', hint: 'Milliseconds. 800 reads as a beat; 2000 is a long look.' }] },
  { verb: 'scroll', label: 'Scroll down the page', fields: [{ num: true, ph: '600', hint: 'Pixels. Negative scrolls back up.' }] },
]

/** Keys worth offering by name, because nobody should have to guess the spelling. */
const DEMO_KEYS = ['Enter', 'Tab', 'Escape', 'Backspace', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'PageDown', 'PageUp', 'Home', 'End']

/**
 * How long a line takes to say, from the shared estimate.
 *
 * Zero when the module has not loaded yet, which means no hold rather than a throw
 * halfway through compiling a script. load() imports it before any view renders, so
 * in practice it is always there.
 */
const speechHold = (text) => (DS ? DS.speechMs(text) : 0)

/** Quote an argument the way lib/demo-script.mjs splits it back apart. */
const demoQuote = (v) => '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'

/**
 * Turn builder rows into the markdown the rest of the pipeline reads.
 *
 * Narration goes before the block it belongs to, one `do` block per step, because
 * parseDemo walks the document in order and that is what puts a spoken line
 * against the action it describes rather than all of them at the top.
 */
function demoStepsToScript(rows) {
  const out = []
  for (const r of rows) {
    const action = DEMO_ACTIONS.find((a) => a.verb === r.verb)
    if (!action) continue
    const args = action.fields.map((f, i) => String(r.args[i] ?? '').trim())
    if (args.some((a) => !a)) continue
    const say = String(r.say ?? '').trim()
    if (say) out.push(say, '')
    const bare = r.verb === 'goto' || r.verb === 'press' || action.fields[0].num
    const line = `${r.verb} ${bare ? args[0] : args.map(demoQuote).join(' ')}`

    /*
     * A step that carries a line holds long enough to say it.
     *
     * This is the whole reason narration and actions ever line up. A click takes
     * 300ms and the sentence about it takes four seconds, so without a hold the
     * picture races the voice and by step five they are describing different things.
     * A blank line between prose and a ```do block says nothing about timing — it is
     * only document order.
     *
     * rm-mux reconciles the two clocks afterwards, but only for the clip as a whole:
     * it pads, stretches, or holds the last frame. It cannot pull cue four back over
     * the action it belongs to, because by then the timing is baked into the video.
     * So the pace is derived here, before anything is recorded.
     *
     * A Pause that also carries a line takes whichever is longer rather than both —
     * asking for 800ms and then adding 2.6s of hold is not what anyone meant.
     */
    const hold = say ? speechHold(say) : 0
    if (hold && r.verb === 'wait') {
      out.push('```do', `wait ${Math.max(Number(args[0]) || 0, hold)}`, '```', '')
    } else if (hold) {
      out.push('```do', line, `wait ${hold}`, '```', '')
    } else {
      out.push('```do', line, '```', '')
    }
  }
  return out.join('\n').trim() + '\n'
}

/*
 * Where a half-built script lives between visits.
 *
 * render() empties #main on every navigation, so the builder's rows — held in a
 * closure and nowhere else — died the moment you looked at another page. Ten minutes
 * of work, gone, with no sign it had been kept anywhere.
 *
 * The server keeps it, not localStorage. That was the first attempt and it was wrong
 * in a way that only shows up on the second launch: the app asks the OS for a free
 * port every time, so the page's origin is a new one on every start and a store keyed
 * to the old origin is unreachable. It looked fine because a reload in the same
 * session keeps the port.
 *
 * So: ~/.config/rolemodel-openscreen/drafts/<project>.json. A real path, on disk,
 * that survives a restart. Debounced, because the builder emits on every keystroke
 * and a request per character is not a design.
 */
let draftTimer = null

function saveDraft(projectId, rows) {
  if (!projectId) return
  clearTimeout(draftTimer)
  draftTimer = setTimeout(() => {
    fetch('/api/record/draft', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, rows }),
    }).catch(() => {
      // The server is this page's own host. If it is unreachable the page is too,
      // and there is nothing useful to say about it here.
    })
  }, DRAFT_SAVE_MS)
}

async function loadDraft(projectId) {
  if (!projectId) return []
  const d = await fetch('/api/record/draft?project=' + encodeURIComponent(projectId))
    .then((r) => r.json())
    .catch(() => ({ rows: [] }))
  return Array.isArray(d.rows) ? d.rows : []
}

/**
 * Read a script back into rows.
 *
 * The missing half. The builder could turn rows into markdown and never the other
 * way, so navigating off the Record page — or a run that failed — left the script on
 * disk and no way to keep editing it in the UI. Reported after losing ten minutes of
 * work, which is exactly what it cost.
 *
 * The hold this compiler emits is undone on the way back in. A step with a line
 * compiles to `[action, wait <speechMs>]`, so a naive parse would read that wait as a
 * separate Pause row and the row count would grow every round trip. A trailing wait
 * inside the same block is dropped when it is the hold the line would have produced.
 */
function scriptToDemoSteps(text) {
  if (!DS) return []
  const parsed = DS.parseDemo(String(text ?? ''))
  const rows = []
  let pending = []
  for (const st of parsed.steps) {
    if (st.kind === 'say') {
      pending.push(st.text)
      continue
    }
    const action = DEMO_ACTIONS.find((a) => a.verb === st.verb)
    if (!action) continue
    const say = pending.join(' ')
    // A `wait` that is the hold for the line just before it belongs to that row, not
    // to a row of its own.
    const prev = rows[rows.length - 1]
    if (st.verb === 'wait' && prev && !pending.length && prev.say) {
      const want = speechHold(prev.say)
      if (Math.abs(Number(st.args[0]) - want) <= 100) continue
    }
    rows.push({ verb: st.verb, args: st.args.map(String), say })
    pending = []
  }
  return rows
}

/**
 * The step list.
 *
 * `onChange` is called after every edit with the compiled script, so the caller
 * can drop it straight into the field the server already reads. Rows are plain
 * objects rather than DOM state, which is what makes reordering a splice instead
 * of a re-parenting problem.
 */
function demoBuilder(onChange, onSave) {
  const rows = []
  /*
   * A plain div, not `.full`.
   *
   * `.full` carries `display:grid; place-content:start` plus a bottom margin, and
   * nesting one inside another put the hint on top of the "Add a step" button —
   * visibly overlapping, and Playwright refused to click through it, which is how
   * it was caught. `.full` says how wide something is; this is inside something
   * already that wide, so it only needs to stack its own two children.
   */
  const wrap = el('div')
  wrap.style.cssText = 'display:grid;gap:var(--op-space-small)'
  const list = el('div')
  list.style.cssText = 'display:grid;gap:var(--op-space-small)'

  /*
   * The total, which is the other half of "will this line up".
   *
   * A script whose words take 40 seconds over a demo with four clicks in it is a
   * slideshow, and rm-mux will tell you so only after the render. Both numbers here,
   * before anything runs: how long the actions ask to be held, and how long the
   * words take. When they are close, the two clocks were never far apart.
   */
  const runTime = () => {
    let holds = 0
    let words = 0
    for (const r of rows) {
      const action = DEMO_ACTIONS.find((a) => a.verb === r.verb)
      if (!action) continue
      const spoken = speechHold(String(r.say ?? '').trim())
      words += spoken
      if (r.verb === 'wait') holds += Math.max(Number(r.args[0]) || 0, spoken)
      else holds += spoken
    }
    return { holds, words }
  }

  const emit = () => {
    onSave?.(rows)
    onChange(demoStepsToScript(rows), rows.length, runTime())
  }

  const draw = () => {
    list.innerHTML = ''
    rows.forEach((r, i) => {
      const action = DEMO_ACTIONS.find((a) => a.verb === r.verb) ?? DEMO_ACTIONS[0]
      const card = el('div', 'card')
      const b = el('div', 'body')
      b.style.cssText = 'display:grid;gap:var(--op-space-x-small)'

      const head = el('div')
      head.style.cssText = 'display:flex;gap:var(--op-space-x-small);align-items:center'
      const n = Object.assign(el('div', 'path'), { textContent: String(i + 1) })
      n.style.cssText = 'min-inline-size:1.5em'

      const what = el('select', 'form-control')
      what.style.minInlineSize = '14rem'
      for (const a of DEMO_ACTIONS) what.append(Object.assign(el('option', null, a.label), { value: a.verb, selected: a.verb === r.verb }))
      what.onchange = () => {
        r.verb = what.value
        r.args = []
        draw()
        emit()
      }

      // Icons, with the words kept in aria-label: a bare glyph is unreadable to a
      // screen reader, and "↑" was not much better for anyone else.
      const up = el('button', 'btn ghost')
      up.append(icon('arrow-up-01'))
      up.setAttribute('aria-label', 'Move this step earlier')
      up.title = 'Move earlier'
      const down = el('button', 'btn ghost')
      down.append(icon('arrow-down-01'))
      down.setAttribute('aria-label', 'Move this step later')
      down.title = 'Move later'
      const kill = el('button', 'btn ghost')
      kill.append(icon('delete-02'))
      kill.setAttribute('aria-label', 'Remove this step')
      kill.title = 'Remove'
      up.disabled = i === 0
      down.disabled = i === rows.length - 1
      up.onclick = () => {
        rows.splice(i - 1, 0, rows.splice(i, 1)[0])
        draw()
        emit()
      }
      down.onclick = () => {
        rows.splice(i + 1, 0, rows.splice(i, 1)[0])
        draw()
        emit()
      }
      kill.onclick = () => {
        rows.splice(i, 1)
        draw()
        emit()
      }
      head.style.flexWrap = 'wrap'

      const args = el('div')
      args.style.cssText = 'display:grid;gap:var(--op-space-x-small);flex:1 1 18rem;grid-template-columns:repeat(' + action.fields.length + ',1fr)'
      action.fields.forEach((f, fi) => {
        let input
        if (f.key) {
          input = el('select', 'form-control')
          for (const k of DEMO_KEYS) input.append(Object.assign(el('option', null, k), { value: k, selected: r.args[fi] === k }))
          if (!r.args[fi]) r.args[fi] = DEMO_KEYS[0]
          input.onchange = () => {
            r.args[fi] = input.value
            emit()
          }
        } else {
          input = Object.assign(el('input', 'form-control'), { placeholder: f.ph ?? '', value: r.args[fi] ?? '' })
          if (f.num) input.type = 'number'
          input.oninput = () => {
            r.args[fi] = input.value
            emit()
          }
        }
        args.append(input)
      })

      const say = Object.assign(el('input', 'form-control'), { placeholder: 'Say this while it happens (optional)', value: r.say ?? '' })
      /*
       * What the line costs, said out loud.
       *
       * The number is the point: a blank line between prose and an action promised
       * nothing about timing, so the only way to find out that a sentence outran its
       * click by four seconds was to render the whole thing and watch it drift. The
       * step holds for this long, and you can see it while you type.
       */
      const cost = el('div', 'path')
      const showCost = () => {
        const ms = speechHold(say.value.trim())
        cost.textContent = ms ? `holds ${(ms / 1000).toFixed(1)}s to say that` : ''
      }
      say.oninput = () => {
        r.say = say.value
        showCost()
        emit()
      }
      showCost()

      head.append(n, what, args, up, down, kill)
      b.append(head)
      const tip = action.hint ?? action.fields.find((f) => f.hint)?.hint
      if (tip) b.append(Object.assign(el('div', 'path'), { textContent: tip }))
      b.append(say, cost)
      card.append(b)
      list.append(card)
    })
    if (!rows.length) list.append(Object.assign(el('div', 'hint'), { textContent: 'No steps yet. Add one, or click through the app and let it write them.' }))
  }

  const add = el('button', 'btn ghost')
  add.append(icon('add-01'), Object.assign(el('span'), { textContent: 'Add a step' }))
  add.onclick = () => {
    // Whatever the last step was is the likeliest next one — a demo is mostly
    // clicks, and defaulting to "Go to a page" every time means re-picking.
    rows.push({ verb: rows.length ? rows[rows.length - 1].verb : 'goto', args: [], say: '' })
    draw()
    emit()
  }

  const bar = el('div')
  bar.style.cssText = 'display:flex;gap:var(--op-space-x-small);flex-wrap:wrap'
  bar.append(add)
  wrap.append(list, bar)
  draw()

  return {
    node: wrap,
    bar,
    /** Replace everything, for when the clicks were recorded rather than typed. */
    load(next) {
      rows.length = 0
      for (const r of next) rows.push(r)
      draw()
      emit()
    },
    count: () => rows.length,
  }
}

/* ── New project ─────────────────────────────────────────── */
function vNew(m) {
  m.append(el('p', 'lede', 'A project is a folder with a manifest. Client is separate from project name — Feeney and Hershey are two clients, not one project.'))
  const f = el('div', 'form')
  const mk = (lbl, node, hint) => field(f, lbl, node, hint)
  const name = mk('Project', Object.assign(el('input'), { placeholder: 'Railing Case Study' }))
  const client = mk('Client', Object.assign(el('input'), { placeholder: 'Feeney' }))
  const brand = mk('Brand', el('select'))
  for (const p of S.presets) {
    const o = el('option', null, p.label)
    o.value = p.id
    brand.append(o)
  }
  const store = mk('Storage', el('select'))
  store.append(Object.assign(el('option', null, 'Local folder (no bucket)'), { value: 'local' }))
  for (const r of S.remotes) store.append(Object.assign(el('option', null, 'rclone: ' + r), { value: r }))
  const bucket = mk('Bucket', Object.assign(el('input'), { placeholder: 'rm-video (remote only)' }))
  const out = el('pre', 'full')
  out.style.display = 'none'
  const go = el('button', 'btn', 'Create project')
  const wrap = el('div', 'full')
  wrap.append(go)
  f.append(wrap, out)
  go.onclick = async () => {
    go.disabled = true
    const r = await (await fetch('/api/project', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name.value, client: client.value, brand: brand.value, remote: store.value === 'local' ? 'local' : 's3', bucket: bucket.value }) })).json()
    go.disabled = false
    out.style.display = 'block'
    out.textContent = r.error ? 'Error: ' + r.error : `Created  ${r.project.id}\n${S.libraryRoot}/${r.project.id}/media/\n\nFootage/ and Renders/ are ready. Drop files in, then Library → Re-index.`
    if (!r.error) await load()
  }
  m.append(f)
}

/* ── Make a video ────────────────────────────────────────── */
function vMake(m) {
  m.append(el('p', 'lede', 'Paste a script or a URL. This writes a brief.md into the project, then runs it through Claude — which is where HyperFrames lives.'))
  m.append(Object.assign(el('div', 'note'), { innerHTML: 'The brief lands in <code>media/Renders/&lt;date&gt;-&lt;slug&gt;/brief.md</code> so it outlives this tab. The render is long and chatty, so it streams into Console rather than hiding behind a spinner.' }))
  const f = el('div', 'form')
  const mk = (l, n, hint) => field(f, l, n, hint)
  const proj = mk('Project', el('select'))
  for (const p of S.projects) proj.append(Object.assign(el('option', null, (p.client ? p.client + ' · ' : '') + p.name), { value: p.id }))
  const brand = mk('Brand', el('select'))
  for (const p of S.presets) brand.append(Object.assign(el('option', null, p.label), { value: p.id }))
  const title = mk('Title', Object.assign(el('input'), { placeholder: 'Website launch promo' }))
  const secs = mk('Seconds', Object.assign(el('input'), { type: 'number', value: 20, min: 5, max: 180 }))
  const pick = mk('From script', el('select'))
  pick.append(Object.assign(el('option', null, '— write it below —'), { value: '' }))
  for (const s of S.scripts) pick.append(Object.assign(el('option', null, s.name), { value: s.name }))
  const src = el('textarea')
  src.placeholder = 'https://rolemodelsoftware.com\n\n— or paste a script —'
  pick.onchange = () => {
    const s = S.scripts.find((x) => x.name === pick.value)
    if (s) src.value = s.body
  }
  field(f, 'Script or URL', src, 'Paste a script, or a URL to build one from. Choosing a saved script above fills this in.')

  // Direction. Claude cannot see this panel, so each of these becomes a sentence
  // in the prompt — see /api/make.
  const bg = mk('Background', el('select'), 'The backdrop behind the scene. Edit these under Wallpapers.')
  bg.append(Object.assign(el('option', null, 'No wallpaper — flat brand colour'), { value: 'none' }))
  for (const w of S.wallpapers) bg.append(Object.assign(el('option', null, w.label), { value: w.file }))

  const chromeUrl = Object.assign(el('input'), { placeholder: 'app.rolemodelsoftware.com' })
  const opts2 = el('div', 'row')
  const chk2 = (label, on) => {
    const btn = el('button', 'chip', label)
    btn.type = 'button'
    btn.setAttribute('aria-pressed', String(on))
    btn.onclick = () => {
      btn.setAttribute('aria-pressed', String(btn.getAttribute('aria-pressed') !== 'true'))
      chromeUrl.disabled = cBrowser.getAttribute('aria-pressed') !== 'true'
    }
    opts2.append(btn)
    return btn
  }
  const cBrowser = chk2('Browser chrome', false)
  const cCaps = chk2('Burn in captions', false)
  fieldRow(f, opts2)
  const urlField = mk('Shown in the chrome', chromeUrl, 'The URL drawn in the fake address bar. Only used with browser chrome.')
  chromeUrl.disabled = true
  // Both actions on one line, directly under the textarea. .btn is display:flex,
  // so two of them in a plain block stack into a narrow column — .row is the
  // existing thing that lays a set of controls out side by side.
  const go = el('button', 'btn', 'Build the brief')
  // `row`, not `full row`: .form is a single-column grid so this is already full
  // width, and opting into .form .full would make it a grid and stack the buttons.
  const actions = el('div', 'row')
  const runSlot = el('span')
  actions.append(go, runSlot)
  // The argv belongs with the buttons but not between them; a .runrow holding
  // only the command gives it the same mono treatment it has everywhere else.
  const runHere = el('div', 'full')
  const out = el('div', 'full')
  f.append(actions, runHere, out)
  go.onclick = async () => {
    const on = (b) => b.getAttribute('aria-pressed') === 'true'
    const r = await (await fetch('/api/make', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: proj.value, brand: brand.value, title: title.value, seconds: secs.value, source: src.value, wallpaper: bg.value, browser: on(cBrowser), browserUrl: chromeUrl.value.trim(), captions: on(cCaps) }) })).json()
    out.innerHTML = ''
    runHere.innerHTML = ''
    runSlot.innerHTML = ''
    if (r.error) {
      out.append(Object.assign(el('pre'), { textContent: 'Error: ' + r.error }))
      return
    }
    runSlot.innerHTML = ''
    const runBtn = el('button', 'btn', 'Run it in Claude')
    runBtn.onclick = () => start(r.step)
    runSlot.append(runBtn)
    const argv = el('div', 'runrow')
    argv.append(Object.assign(el('code'), { textContent: show(r.step) }))
    runHere.append(argv)
    // Below the actions: the prompt, a Copy button beside it, and where the
    // brief landed. Reference material, not the next thing you press.
    out.append(Object.assign(el('pre'), { textContent: r.prompt }))

    const c = copyButton(el('button', 'btn ghost', 'Copy the prompt'), 'Copy the prompt', r.prompt)
    const copyRow = el('div')
    copyRow.append(c)
    out.append(copyRow)

    out.append(Object.assign(el('div', 'path'), { textContent: 'brief  ' + r.brief }))
  }
  m.append(f)
}

/* ── New video ────────────────────────────────────────────────
   Three ways into a video, on one page. They were three sidebar entries, which
   made them look like unrelated features rather than three inputs to the same
   pipeline: capture a screen, build from a script or URL, or cut from a test.
   The tab survives a re-render so a poll cannot bounce you back to the first. */
let createTab = 'record'

const CREATE_TABS = [
  ['record', 'Record a screen'],
  ['make', 'Make from a script'],
  ['recast', 'From a test'],
]

function vCreate(m) {
  const tabs = el('div', 'row')
  const host = el('div')
  const paint = () => {
    tabs.innerHTML = ''
    for (const [id, label] of CREATE_TABS) {
      const b = el('button', 'chip', label)
      b.setAttribute('aria-pressed', String(createTab === id))
      b.onclick = () => {
        createTab = id
        paint()
      }
      tabs.append(b)
    }
    host.innerHTML = ''
    crumbs([{ label: 'New video' }, { label: CREATE_TABS.find(([id]) => id === createTab)?.[1] ?? createTab }])
    // Each tab renders its own heading and lede, so there is no outer title to
    // duplicate it.
    ;({ record: vRecord, make: vMake, recast: vRecast })[createTab](host)
  }
  m.append(tabs, host)
  paint()
}

/* ── Record ───────────────────────────────────── */
function vRecord(m) {
  m.append(el('p', 'lede', 'Capture your screen straight into a project. Left alone, OpenScreen writes to its own private recordings folder where nothing else can find it — this points it at the project instead, so the capture is already where the rest of the pipeline looks.'))

  // Say why openscreen is missing before a Run button fails with "not found on
  // PATH", which is true of every cause and useful for none of them.
  const osWarn = el('div', 'hint bad')
  m.append(osWarn)
  ;(async () => {
    const d = await (await fetch('/api/openscreen')).json().catch(() => null)
    if (!d || d.ok) {
      osWarn.remove()
      return
    }
    osWarn.textContent = d.why
  })()

  const f = el('div', 'form')
  const mk = (l, n, hint) => field(f, l, n, hint)
  const proj = mk('Project', el('select'))
  for (const p of S.projects) proj.append(Object.assign(el('option', null, (p.client ? p.client + ' · ' : '') + p.name), { value: p.id }))
  const title = mk('Name', Object.assign(el('input'), { placeholder: 'estimating-screen' }))

  /*
   * Capture target. This used to be a text field you typed a window title into
   * from memory, which is a question the machine can answer and a person cannot.
   * The list comes from /api/sources; typing is still available, because a
   * system-derived app name is a good guess and not a guarantee.
   */
  const TYPE_IT = '__type__'
  // The select and its type-it-yourself fallback share one grid cell on purpose.
  // A display:none child is removed from grid placement entirely, so hiding the
  // input directly shifted every following cell by one and put the hints in the
  // label column.
  const cell = el('div')
  cell.style.cssText = 'display:grid;gap:var(--op-space-x-small)'
  const pick = el('select')
  const typed = Object.assign(el('input'), { placeholder: 'exact window title' })
  typed.style.display = 'none'
  cell.append(pick, typed)
  const srcHint = el('div', 'hint')
  mk('Capture', cell, srcHint)

  // Options are addressed by their position in this list, not by their value: a
  // window title can contain anything, including the separator you were going to
  // encode the kind with.
  let sources = []

  const fill = async () => {
    pick.innerHTML = ''
    pick.append(Object.assign(el('option', null, 'Whole screen'), { value: '' }))
    tone(srcHint)
    srcHint.textContent = 'reading what is open...'
    const d = await (await fetch('/api/sources')).json().catch(() => ({ from: 'none', windows: [] }))
    sources = d.windows ?? []
    sources.forEach((src, i) => pick.append(Object.assign(el('option', null, src.label), { value: String(i) })))
    pick.append(Object.assign(el('option', null, 'Type a window title instead...'), { value: TYPE_IT }))
    const n = sources.length
    if (d.from === 'openscreen') {
      tone(srcHint, 'ok')
      const dropped = d.untitled ? ` ${d.untitled} untitled window${d.untitled === 1 ? '' : 's'} left out — record matches on the title, so there is nothing to match.` : ''
      srcHint.textContent = n + ' source' + (n === 1 ? '' : 's') + ' from OpenScreen itself.' + dropped
    } else if (d.from === 'system') {
      srcHint.textContent = n + ' open application' + (n === 1 ? '' : 's') + '. ' + (d.note || '')
    } else {
      tone(srcHint, 'warn')
      srcHint.textContent = d.note || 'Nothing could be listed. Whole screen still works.'
    }
  }
  pick.onchange = () => {
    const manual = pick.value === TYPE_IT
    typed.style.display = manual ? '' : 'none'
    if (manual) typed.focus()
  }
  const refresh = el('button', 'btn ghost', 'Refresh the list')
  refresh.type = 'button'
  refresh.onclick = fill
  // Wrapped: a bare button is a grid item and stretches to the whole column.
  fieldRow(f, refresh)
  fill()

  /*
   * The script that drives the capture.
   *
   * Without it this panel could only offer "record this window for thirty seconds
   * and hope somebody is driving", which is not a demo — it is a screen with
   * nothing happening on it. With it, `rm-demo capture` walks a browser through
   * the steps while the recorder captures that window, and because a .openscreen
   * document still lands, the brand step and the editor below are unchanged.
   *
   * Same markdown the Recast page takes and the same checker, deliberately: prose
   * is narration, ```do blocks are actions, and a script written here feeds Voice
   * unchanged.
   */
  /*
   * Declared before the builder, not after it.
   *
   * The builder emits on creation when a draft is restored, and that emit reads this
   * — so with the declaration below it, coming back to a page with a saved draft threw
   * "Cannot access 'handEdited' before initialization" and the page rendered nothing.
   */
  let handEdited = false

  /*
   * The steps, as rows.
   *
   * The builder writes the markdown; the markdown is still what runs. That split
   * is deliberate — the checker, the server and rm-demo are all unchanged, and the
   * script stays a file you can read, diff and hand-edit. What changes is that
   * nobody has to author it to get started.
   */
  const builder = demoBuilder((text, count, time) => {
    if (!handEdited) script.value = text
    const secs = (ms) => (ms / 1000).toFixed(1) + 's'
    stepCount.textContent = count
      ? `${count} step${count === 1 ? '' : 's'} · ${secs(time.holds)} of holds · ${secs(time.words)} of narration`
      : ''
    recheck()
  }, (rows) => saveDraft(proj.value, rows))


  const stepCount = el('div', 'path')
  const builderHint = el('div', 'hint')
  builderHint.textContent = 'Each row is one thing that happens, in order. "Wait until something appears" is the one to reach for after anything that loads — it holds the demo until it is there instead of clicking into a page that has not arrived.'
  /*
   * Not a .form-group.
   *
   * Optics' .form-group is its own `auto 1fr` grid for a label/control pair, and a
   * row of five controls put inside one gets boxed into the label's track — the
   * action names truncated to "Wait u" and the value was clipped off the edge.
   * Adding .full to the group did not help: the span applied and the box stayed one
   * column wide. So this uses the pattern that already works everywhere else in
   * this file, a .full child of .form, with its own single column so `place-content:
   * start` cannot shrink-wrap it.
   */
  const stepCell = el('div', 'full')
  // Flex, not grid. `.form .full` sets `display:grid` with `place-content: start`,
  // and an inline `grid-template-columns` did not stop the label and the hint from
  // being auto-placed into a column beside the rows instead of above and below them.
  // A column flexbox has one reading of "stack these", which is all this needs.
  stepCell.style.cssText = 'display:flex;flex-direction:column;gap:var(--op-space-small);align-items:stretch'
  stepCell.append(Object.assign(el('label', 'form-label'), { textContent: 'Steps' }), builder.node, builderHint, stepCount)
  f.append(stepCell)

  /*
   * The script the builder writes, kept visible and editable.
   *
   * Hidden behind a summary rather than removed: it is what actually runs, and a
   * generated artefact you cannot see is one you cannot debug. Editing it directly
   * takes over — the builder stops overwriting from then on, because silently
   * discarding someone's hand edit on the next dropdown change is worse than
   * either option.
   */
  const script = el('textarea')
  script.className = 'form-control'
  script.rows = 9
  /*
   * Sized here, not by `rows`.
   *
   * studio.html pins every textarea to --field-tall, which overrides the row count
   * — nine rows rendered as three and the script you were writing scrolled out of
   * sight. The rule is shared by every textarea in the Studio and this is the only
   * one that is a code editor, so the override is local rather than a change to a
   * stylesheet the rest of the app depends on.
   */
  script.style.blockSize = '19rem'
  script.style.minBlockSize = '19rem'
  script.spellcheck = false
  script.placeholder = ['We start on the estimating screen.', '', '```do', 'goto https://your-app.example.com/quotes/new', 'expect "REQUEST QUOTE"', 'click "3D VIEW"', 'wait 800', '```', '', 'Adding a railing is two clicks.'].join('\n')
  const scriptHint = el('div', 'hint')
  const adv = el('details')
  const sum = el('summary')
  sum.textContent = 'The script this writes'
  sum.style.cssText = 'cursor:pointer;font-size:var(--op-font-small);color:var(--fg-dim);padding:var(--op-space-x-small) 0'
  const advForm = el('div', 'form')
  advForm.style.cssText = 'grid-template-columns:1fr'
  field(advForm, 'Script', script, scriptHint)
  adv.append(sum, advForm)
  const advCell = el('div', 'full')
  advCell.append(adv)
  f.append(advCell)
  script.oninput = () => {
    handEdited = true
    tone(builderHint, 'warn')
    builderHint.textContent = 'The script has been edited by hand, so the rows below no longer overwrite it. Clear the script to hand control back.'
    if (!script.value.trim()) {
      handEdited = false
      tone(builderHint)
      builderHint.textContent = 'Each row is one thing that happens, in order.'
    }
    recheck()
  }

  // After the script, because what it means depends on whether one exists.
  const secs = mk('Stop after', Object.assign(el('input'), { type: 'number', value: 30, min: 5, max: 600 }), 'Seconds. With a script above, the capture ends when the script does and this is only the backstop for a run that hangs.')

  // Audio. Three of the recorder's flags that this panel never offered, so a
  // capture that needed a microphone meant abandoning the UI and typing it out.
  const mic = Object.assign(el('input'), { type: 'checkbox' })
  const micDevice = Object.assign(el('input'), { placeholder: 'MacBook Pro Microphone' })
  const sysAudio = Object.assign(el('input'), { type: 'checkbox' })
  mk('Microphone', mic, 'Capture the default input. Narration recorded live rather than synthesised later.')
  mk('Microphone device', micDevice, 'A named input instead of the default. Implies the box above, so it is passed alone.')
  mk('System audio', sysAudio, 'What the machine is playing — useful when the demo has sound of its own.')

  const cursor = el('select')
  for (const [v, label] of [['editable-overlay', 'Editable overlay — the editor can restyle it'], ['system', 'System cursor — burnt into the frames']]) {
    cursor.append(Object.assign(el('option', null, label), { value: v }))
  }
  mk('Cursor', cursor, 'The overlay is what auto-zoom reads and what the cursor theme restyles. The system cursor cannot be changed after the fact.')

  // The browser half. Only means anything when a script is driving, so it says so
  // and disables itself rather than sitting there looking configurable.
  /*
   * Drive the browser already on screen, rather than a fresh one.
   *
   * The default was to launch Chromium, which is blank and signed into nothing — so a
   * script that clicks anything real died on its first step while the recorder filmed
   * a window nothing was driving. Attaching is what a demo of a working app needs: the
   * page is already open, already logged in, already has data in it.
   */
  const attach = Object.assign(el('input'), { type: 'checkbox' })
  const attachHint = el('div', 'hint')
  const cdp = Object.assign(el('input'), { placeholder: 'http://127.0.0.1:9222' })
  const pageMatch = Object.assign(el('input'), { placeholder: 'part of the tab title, e.g. Feeney' })
  mk('Use the browser I have open', attach, attachHint)
  mk('Debugging address', cdp, 'Where that browser exposes CDP. Blank means http://127.0.0.1:9222.')
  mk('Which tab', pageMatch, 'Matched against the tab title or its URL. Blank takes the first ordinary tab.')

  const url = Object.assign(el('input'), { placeholder: 'https://your-app.example.com' })
  const vw = Object.assign(el('input'), { type: 'number', value: 1440, min: 320, max: 7680 })
  const vh = Object.assign(el('input'), { type: 'number', value: 900, min: 240, max: 4320 })
  const headless = Object.assign(el('input'), { type: 'checkbox' })
  mk('Base URL', url, 'So a script can say `goto /quotes/new` instead of repeating the host on every line.')
  mk('Viewport width', vw)
  mk('Viewport height', vh, 'The browser window the script drives, and therefore the shape of the capture.')
  mk('Headless', headless, 'Off is right for a capture: there is no window to record when the browser is hidden, and the cursor overlay comes from a real pointer.')

  const attachOnly = [cdp, pageMatch]
  const driverOnly = [url, vw, vh, headless]
  const syncKnobs = () => {
    const scripted = script.value.trim().length > 0
    const attached = scripted && attach.checked
    attach.disabled = !scripted
    attach.closest('.form-group')?.style.setProperty('opacity', scripted ? '1' : '0.45')
    for (const c of attachOnly) {
      c.disabled = !attached
      c.closest('.form-group')?.style.setProperty('opacity', attached ? '1' : '0.45')
    }
    // Viewport and headless belong to a browser we launch. Attaching uses the window
    // that is already there, at whatever size it already is.
    for (const c of driverOnly) {
      c.disabled = !scripted || attached
      c.closest('.form-group')?.style.setProperty('opacity', !scripted || attached ? '0.45' : '1')
    }
    if (attached) {
      tone(attachHint, 'ok')
      attachHint.textContent = 'Chrome has to have been started with a debugging port — it cannot be given one while running. Quit Chrome, then: open -a "Google Chrome" --args --remote-debugging-port=9222 --remote-allow-origins=*'
    } else {
      tone(attachHint)
      attachHint.textContent = scripted
        ? 'Off launches a fresh Chromium, which is blank and signed into nothing — the script needs a "Go to a page" step. On drives the window you already have open.'
        : 'Only applies once there is a script.'
    }
    micDevice.disabled = false
    mic.disabled = micDevice.value.trim().length > 0
    mic.closest('.form-group')?.style.setProperty('opacity', mic.disabled ? '0.45' : '1')
  }
  micDevice.oninput = syncKnobs
  attach.onchange = syncKnobs

  // Checked as it is typed: a script naming a button that moved fails fifteen
  // seconds into a browser session otherwise, and by then the take is spent.
  let checking = null
  const recheck = () => {
    syncKnobs()
    const body = script.value.trim()
    if (!body) {
      tone(scriptHint)
      scriptHint.textContent = 'Leave this empty to capture whatever happens on screen. Fill it in and the capture is driven, repeatable, and re-runnable when the UI changes.'
      return
    }
    clearTimeout(checking)
    checking = setTimeout(async () => {
      const d = await (await fetch('/api/demo/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body }) })).json()
      if (d.problems?.length) {
        tone(scriptHint, 'bad')
        scriptHint.textContent = d.problems.join(' · ')
        return
      }
      if (!d.actions) {
        tone(scriptHint, 'warn')
        scriptHint.textContent = 'No actions yet — put the browser steps in a ```do block.'
        return
      }
      /*
       * A script with no `goto` cannot work as a capture, and saying so here is the
       * difference between reading a sentence and losing a take: the driven browser
       * starts blank, so the first click fails sixteen seconds in while the recorder
       * films nothing.
       */
      // Only a launched capture needs to navigate. Attaching starts on a page that is
      // already open, which is the whole reason to attach.
      if (!d.urls.length && !attach.checked) {
        tone(scriptHint, 'warn')
        scriptHint.textContent = `${d.actions} action${d.actions === 1 ? '' : 's'}, but the script never goes to a page — a launched capture opens a blank browser. Add "Go to a page" as the first step, or turn on "Use the browser I have open".`
        return
      }
      tone(scriptHint, 'ok')
      scriptHint.textContent = `${d.actions} action${d.actions === 1 ? '' : 's'} · ${d.narration} narration line${d.narration === 1 ? '' : 's'} · visits ${d.urls.join(', ')}`
    }, DEMO_CHECK_MS)
  }
  recheck()

  /*
   * Put the draft back, and offer a way in from a script that already exists.
   *
   * Two ways to lose work before this: navigating away (the rows were in a closure),
   * and having a script on disk with no way to edit it in the UI — the builder only
   * ever compiled one direction. Both are covered: the draft returns on its own, and
   * anything in the box can be turned back into rows.
   */
  const rebuild = el('button', 'btn ghost')
  rebuild.append(icon('refresh'), Object.assign(el('span'), { textContent: 'Rebuild rows from the script' }))
  rebuild.title = 'Read the script below and turn it back into editable steps'
  rebuild.onclick = () => {
    const rows = scriptToDemoSteps(script.value)
    if (!rows.length) {
      tone(builderHint, 'warn')
      builderHint.textContent = 'Nothing in the script to turn into steps yet.'
      return
    }
    handEdited = false
    builder.load(rows)
    tone(builderHint, 'ok')
    builderHint.textContent = `${rows.length} step${rows.length === 1 ? '' : 's'} read back from the script.`
  }
  builder.bar.append(rebuild)

  proj.addEventListener('change', async () => builder.load(await loadDraft(proj.value)))
  // Awaited, so a draft that exists is on screen before anything can overwrite it.
  loadDraft(proj.value).then((draft) => {
    if (draft.length) builder.load(draft)
  })

  const steps = el('div', 'full')
  const go = el('button', 'btn', 'Set up the capture')
  const w = el('div', 'full')
  w.append(go)
  f.append(w, steps)
  go.onclick = async () => {
    // A typed value is always a title; a picked one carries its own kind, because
    // record takes a screen by index and a window by title and neither by id.
    const source = pick.value === TYPE_IT ? { kind: 'window', value: typed.value.trim() } : pick.value === '' ? { kind: '', value: '' } : (sources[Number(pick.value)] ?? { kind: '', value: '' })
    const r = await (
      await fetch('/api/record', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId: proj.value,
          title: title.value,
          source,
          seconds: secs.value,
          script: script.value,
          attach: attach.checked,
          cdp: cdp.value,
          page: pageMatch.value,
          mic: mic.checked,
          micDevice: micDevice.value,
          systemAudio: sysAudio.checked,
          cursor: cursor.value,
          url: url.value,
          width: vw.value,
          height: vh.value,
          headless: headless.checked,
        }),
      })
    ).json()
    steps.innerHTML = ''
    if (r.error) {
      steps.append(Object.assign(el('div', 'hint bad'), { textContent: r.error }))
      return
    }
    steps.append(
      plan([
        r.script
          ? attach.checked
            ? [
                'Drive the browser you already have open, and record it.',
                'Attaching to it over CDP rather than launching one, so the page stays signed in and the window recorded is the one being driven. The capture ends when the script does. ' +
                  (secs.value ? secs.value + 's is the backstop.' : 'No backstop set.') +
                  ' Script saved at ' + r.script,
              ]
            : [
                'Open a browser, drive it through the script, and record it.',
                'Not the window picked above — this opens its own browser, so that is what gets recorded, and it starts blank. The capture ends when the script does. ' +
                  (secs.value ? secs.value + 's is the backstop.' : 'No backstop set.') +
                  ' Script saved at ' + r.script,
              ]
          : [source.kind === 'window' ? 'Capture the first window whose title contains "' + source.value + '".' : source.kind === 'display' ? 'Capture screen ' + source.value + ' whole.' : 'Capture the whole screen.', 'Nothing drives it — it records for ' + (secs.value || 30) + ' seconds and stops. Add a script above to make it a demo.'],
        ['Apply the RoleModel preset.', 'Wallpaper, padding, radius and shadow, written into the .openscreen document.'],
        ['Open it in OpenScreen.', 'Where the zooms and annotations get placed. Export is the step after that, not before it.'],
        ['Export the mp4, when the edit is done.', 'Lands in ' + r.dest],
      ]),
    )
    for (const s of r.steps) steps.append(runRow(s))

    /*
     * Editing comes between branding and exporting, so the chain stops at two.
     *
     * It used to run all three and hand back an MP4, which is the wrong shape for
     * anything but a throwaway: the whole point of writing a branded .openscreen
     * document is that it opens in the editor, where the zooms and annotations
     * get placed. Exporting straight past that step produces a file nobody chose
     * anything about. Export stays one click away, for when the edit is done.
     */
    const openRow = el('div', 'runrow')
    const openBtn = el('button', 'btn ghost', 'Open in OpenScreen')
    const openNote = el('div', 'path')
    openNote.style.cssText = 'flex-basis:100%'
    openBtn.onclick = async () => {
      openBtn.disabled = true
      openNote.textContent = 'opening...'
      const o = await (await fetch('/api/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: r.editable }) })).json()
      openBtn.disabled = false
      openNote.textContent = o.error ? o.error : o.note
    }
    openRow.append(openBtn, Object.assign(el('code'), { textContent: r.editable }), openNote)
    steps.append(openRow)

    // Record -> brand, then stop so the document can be edited.
    const all = el('button', 'btn', 'Record and brand, then open for editing')
    const chainNote = el('div', 'hint')
    all.onclick = async () => {
      all.disabled = true
      chainNote.textContent = ''
      chainNote.className = 'hint'
      let ok = true
      for (const s of r.steps.filter((x) => x.label !== 'export')) {
        const j = await start(s)
        if (!j) {
          ok = false
          break
        }
        // waitFor resolves with the exit code, and this loop used to throw it
        // away: a record that captured nothing left brand with no document to
        // open, and export then ran on the same missing file. Two failures
        // reported for one cause, and the second one buried the first.
        const code = await waitFor(j.id)
        if (code !== 0) {
          ok = false
          chainNote.className = 'hint bad'
          chainNote.textContent = `Stopped after ${s.label} — it exited ${code === null ? 'without a status' : code}. Console has the output; the steps after it did not run.`
          break
        }
      }
      if (ok) openBtn.click()
      all.disabled = false
      refreshJobs()
    }
    steps.append(all, chainNote)
  }
  m.append(f)
}

/** Resolve when a job exits. Used to chain steps that must not overlap. */
function waitFor(id) {
  return new Promise((done) => {
    const s = new EventSource('/api/jobs/' + id + '/events')
    s.onmessage = (e) => {
      const d = JSON.parse(e.data)
      if (d.done) {
        s.close()
        done(d.code)
      }
    }
    s.onerror = () => {
      s.close()
      done(null)
    }
  })
}

/* ── Recast ──────────────────────────────────────────────────
   A Playwright trace is already a recording of your product working. This is
   the only input here that regenerates itself: the test runs in CI, the demo
   is cut from the trace, and it can never drift from the UI it documents. */
function vRecast(m) {
  m.append(el('p', 'lede', 'Turn a Playwright test run into a narrated demo. The test already clicked through the product, and the trace it left behind holds the actions, the screenshots, the network waits and the cursor positions. Nothing here re-records anything.'))

  m.append(
    plan([
      ['Point it at a trace.', 'A trace.zip, or any folder above one — Browse walks your home directory, so you do not have to know the path.'],
      ['It cuts the demo.', 'playwright-recast (MIT, run through npx) reads the trace and renders an mp4 into this project. Needs ffmpeg and ffprobe on PATH.'],
      ['If narration exists for this name, it is added.', 'rm-mux reconciles the two clocks first: recast compresses idle time, narration takes as long as the words do, and burning one onto the other unreconciled shows cue 1 for the whole clip.'],
      ['Everything streams into Console.', 'Both steps are long and chatty. You get a Run button and the exact argv beside it, never a spinner.'],
    ]),
  )

  const f = el('div', 'form')
  const mk = (l, n, hint) => field(f, l, n, hint)
  const proj = mk('Project', el('select'))
  for (const p of S.projects) proj.append(Object.assign(el('option', null, (p.client ? p.client + ' · ' : '') + p.name), { value: p.id }))

  const title = mk('Name', Object.assign(el('input'), { placeholder: 'estimating-walkthrough' }), 'Names the output folder, and is how narration is matched: a Voice run saved under the same name is picked up automatically.')

  // The two fields that used to want a hand-typed path.
  const traceHint = async (path, hint) => {
    tone(hint)
    hint.textContent = path ? 'checking…' : ''
    if (!path) return
    const d = await (await fetch('/api/trace/probe?path=' + encodeURIComponent(path))).json()
    if (d.error || !d.ok) {
      tone(hint, 'bad')
      hint.textContent = d.error || d.why
      return
    }
    const n = d.traces + ' trace' + (d.traces === 1 ? '' : 's')
    if (d.smooth) {
      tone(hint, 'ok')
      hint.textContent = n + ', each with a video beside it. The demo will play as real motion.'
    } else {
      tone(hint, 'warn')
      hint.textContent = n + ', ' + d.withVideo + ' with a video beside it. Without one, recast rebuilds motion from the screencast frames in the trace — those are sparse enough to read as a slideshow. Record with recordVideo and save the .webm next to the .zip under the same basename.'
    }
  }
  const trace = pathField(f, 'Trace', {
    placeholder: 'a trace.zip, or the folder holding one',
    accept: (x) => x.trace,
    allowDir: true,
    onPick: traceHint,
  })

  /*
   * Or write the demo instead of hunting for a trace.
   *
   * This panel used to require a Playwright trace you had produced somewhere
   * else, which meant the half of a demo that decides what the viewer sees was
   * the one part the Studio could not help with. A demo script is markdown:
   * prose is narration, ```do blocks are actions. The same file feeds Voice
   * unchanged, because the narration parser ignores fenced blocks.
   */
  const demoBody = el('textarea')
  demoBody.className = 'form-control'
  demoBody.rows = 10
  demoBody.spellcheck = false
  demoBody.placeholder = ['We start on the estimating screen.', '', '```do', 'goto https://your-app.example.com/quotes/new', 'expect "REQUEST QUOTE"', 'click "3D VIEW"', 'wait 800', '```', '', 'Adding a railing is two clicks.'].join('\n')
  const demoHint = el('div', 'hint')
  mk('Demo script', demoBody, demoHint)

  // Checked as it is typed, because a script that names a button that moved
  // fails fifteen seconds into a browser session otherwise.
  let checking = null
  const recheck = async () => {
    const body = demoBody.value.trim()
    if (!body) {
      tone(demoHint)
      demoHint.textContent = 'Leave this empty if you already have a trace. Otherwise write the demo and run it here — it produces the trace.'
      return
    }
    clearTimeout(checking)
    checking = setTimeout(async () => {
      const d = await (await fetch('/api/demo/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body }) })).json()
      if (d.problems?.length) {
        tone(demoHint, 'bad')
        demoHint.textContent = d.problems.join(' · ')
        return
      }
      if (!d.actions) {
        tone(demoHint, 'warn')
        demoHint.textContent = 'No actions yet — put the browser steps in a ```do block.'
        return
      }
      tone(demoHint, 'ok')
      demoHint.textContent = `${d.actions} action${d.actions === 1 ? '' : 's'} · ${d.narration} narration line${d.narration === 1 ? '' : 's'}${d.urls.length ? ' · visits ' + d.urls.join(', ') : ''}`
    }, DEMO_CHECK_MS)
  }
  demoBody.oninput = recheck
  recheck()

  const demoSteps = el('div', 'full')
  const demoGo = el('button', 'btn ghost', 'Set up the demo run')
  const demoWrap = el('div', 'full')
  demoWrap.append(demoGo)
  f.append(demoWrap, demoSteps)
  demoGo.onclick = async () => {
    demoSteps.innerHTML = ''
    const r = await (
      await fetch('/api/demo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: proj.value, name: title.value || 'demo', body: demoBody.value }),
      })
    ).json()
    if (r.error) {
      demoSteps.append(Object.assign(el('div', 'hint bad'), { textContent: r.error }))
      return
    }
    demoSteps.append(
      plan([
        [`Drive a browser through ${r.plan.actions} step${r.plan.actions === 1 ? '' : 's'}.`, r.plan.urls.join(', ') || 'no navigation — it will act on whatever is already open'],
        ['Leave a trace and a screencast.', r.dir],
        ['Fill in the Trace field above.', 'Then the recast steps below turn it into the video.'],
      ]),
    )
    for (const st of r.steps) demoSteps.append(runRow(st, 'Run the demo'))
    // Waiting on the job rather than assuming: a demo that failed should not
    // leave a trace path sitting in the field as though it had worked.
    const watch = el('button', 'btn ghost', 'Run it and use the trace')
    watch.onclick = async () => {
      watch.disabled = true
      const j = await start(r.steps[0])
      if (!j) {
        watch.disabled = false
        return
      }
      const code = await waitFor(j.id)
      watch.disabled = false
      if (code !== 0) {
        demoSteps.append(Object.assign(el('div', 'hint bad'), { textContent: `The demo exited ${code === null ? 'without a status' : code}. Console has the output; the Trace field was left alone.` }))
        return
      }
      trace.value = r.trace
      trace.dispatchEvent(new Event('change'))
      go('recast')
    }
    demoSteps.append(watch)
  }
  const srt = pathField(f, 'Narration', {
    placeholder: 'optional — a .srt beside your own audio',
    accept: (x) => x.subs,
    onPick: (path, hint) => {
      tone(hint)
      hint.textContent = path ? '' : 'Leave this empty unless you have subtitles of your own. A Voice run for this name is found without it.'
    },
  })
  srt.dispatchEvent(new Event('change'))

  // Each provider names its voices differently, and the field used to say "nova"
  // for all of them — an OpenAI name, offered while you had ElevenLabs selected.
  // An ElevenLabs voice_id is a 20-character string, not a name, so the old
  // placeholder was actively misleading rather than merely unhelpful.
  const PROVIDERS = {
    none: { label: 'No voiceover' },
    openai: { label: 'OpenAI', ph: 'nova', help: 'An OpenAI voice name: alloy, echo, fable, onyx, nova or shimmer.' },
    elevenlabs: { label: 'ElevenLabs', ph: '21m00Tcm4TlvDq8ikWAM', help: 'An ElevenLabs voice_id — a 20-character string, not a name. Copy it from the voice in your ElevenLabs library; the name shown there will not work.' },
    polly: { label: 'Amazon Polly', ph: 'Joanna', help: 'A Polly voice name, capitalised: Joanna, Matthew, Amy or Brian.' },
    qwen: { label: 'Qwen (local)', ph: '', help: 'Qwen is configured entirely by file — fill in the Qwen config field below. It takes no voice id, and the server refuses the run without the file rather than letting recast fail several hundred lines into its output.', needsConfig: true },
  }
  const prov = mk('Voice', el('select'))
  for (const [id, cfg] of Object.entries(PROVIDERS)) prov.append(Object.assign(el('option', null, cfg.label), { value: id }))
  const voiceHint = el('div', 'hint')
  const voice = mk('Voice ID', el('input'), voiceHint)
  // Same key field as the Voice panel. This panel offered ElevenLabs with
  // nowhere to put a key at all, which is a dead end rather than an option.
  const recastKeys = apiKeyBlock(f)
  const syncVoice = () => {
    const cfg = PROVIDERS[prov.value] || PROVIDERS.none
    const off = !cfg.ph
    voice.disabled = off
    if (off) voice.value = ''
    voice.placeholder = off ? 'not needed' : cfg.ph
    tone(voiceHint)
    voiceHint.textContent = off ? 'Nothing to fill in. Narration made under Voice is local Kokoro and is picked up by name — these three providers send your script to a third party instead.' : cfg.help
    // Only ElevenLabs is ours to authenticate. OpenAI and Polly are handled by
    // playwright-recast from its own environment, so offering a field here would
    // imply this app stores a credential it never sees.
    recastKeys.show(prov.value === 'elevenlabs')
    if (prov.value === 'openai' || prov.value === 'polly') {
      voiceHint.textContent += ' Credentials for this one come from playwright-recast’s own environment, not from here.'
    }
  }
  prov.onchange = () => {
    syncVoice()
    syncQwen()
  }
  /*
   * Everything playwright-recast takes.
   *
   * Five of its twenty-odd options were exposed, which put the interesting half —
   * what the cursor looks like, how frames are interpolated, which model speaks,
   * whether idle compression happens at all — behind typing the command out by
   * hand. The rest are here, grouped, with the dependent ones disabled until the
   * stage they belong to is on: a setting that silently does nothing reads as a
   * setting that does not work.
   *
   * The `*-config` options take recast's own JSON files. They are path fields
   * rather than forms on purpose — the shape is theirs and moves with their
   * releases, and a form that has drifted from the shape it edits is worse than
   * a file picker.
   */
  const ttsModel = mk('TTS model', el('input'), 'Optional. OpenAI: tts-1 or tts-1-hd. ElevenLabs: a model id such as eleven_multilingual_v2. Left empty, the provider picks.')
  const ttsSpeed = mk('TTS speed', Object.assign(el('input'), { type: 'number', value: '', min: 0.25, max: 4, step: 0.05, placeholder: 'provider default' }), 'Speech-rate multiplier. OpenAI honours this; the others ignore it.')
  const qwenConfig = pathField(f, 'Qwen config', { placeholder: 'required when the voice is Qwen — a .json', accept: () => true })
  const textCfg = pathField(f, 'Text processing config', { placeholder: 'optional — recast’s own JSON rules', accept: () => true })

  const idle = mk('Idle speed', Object.assign(el('input'), { type: 'number', value: 3, min: 0.25, max: 20, step: 0.5 }), 'How much dead time between clicks is compressed. 3 means idle stretches run three times faster.')
  const action = mk('Action speed', Object.assign(el('input'), { type: 'number', value: 1, min: 0.25, max: 20, step: 0.25 }), 'The clicks and typing themselves. 1 is real time — above that the pointer moves faster than a person could follow.')
  const network = mk('Network-wait speed', Object.assign(el('input'), { type: 'number', value: 2, min: 0.25, max: 20, step: 0.25 }), 'Time the test spent waiting on the network. Separate from idle because a slow request is not the same as a pause for effect.')
  const rez = mk('Resolution', el('select'))
  for (const o of ['1080p', '720p']) rez.append(Object.assign(el('option', null, o), { value: o }))
  const fmt = mk('Format', el('select'))
  for (const o of ['mp4', 'webm']) fmt.append(Object.assign(el('option', null, o), { value: o }))
  const fmtHint = el('div', 'hint')
  f.append(fmtHint)

  const cursorCfg = pathField(f, 'Cursor overlay config', { placeholder: 'optional — recast’s own JSON', accept: () => true })
  const clickCfg = pathField(f, 'Click effect config', { placeholder: 'optional — recast’s own JSON', accept: () => true })
  const clickSound = pathField(f, 'Click sound', { placeholder: 'optional — an audio file played on each click', accept: (x) => x.audio })

  const iFps = mk('Interpolated fps', Object.assign(el('input'), { type: 'number', value: 60, min: 24, max: 240, step: 1 }))
  const iMode = mk('Interpolation mode', el('select'), 'mci reconstructs motion and is the slowest; blend cross-fades; dup just repeats frames and is there to compare against.')
  for (const o of ['mci', 'blend', 'dup']) iMode.append(Object.assign(el('option', null, o), { value: o }))
  const iQual = mk('Interpolation quality', el('select'))
  for (const o of ['balanced', 'fast', 'quality']) iQual.append(Object.assign(el('option', null, o), { value: o }))
  const iPasses = mk('Interpolation passes', Object.assign(el('input'), { type: 'number', value: 1, min: 1, max: 4, step: 1 }), 'More than one is rarely worth the minutes it costs.')

  const opts = el('div', 'row')
  opts.className = 'row'
  const chk = (label, on) => {
    const b = el('button', 'chip', label)
    b.setAttribute('aria-pressed', String(on))
    b.onclick = () => {
      b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'))
      syncOpts()
    }
    opts.append(b)
    return b
  }
  const on = (b) => b.getAttribute('aria-pressed') === 'true'
  const cCursor = chk('Cursor overlay', true),
    cClick = chk('Click effects', true),
    cInterp = chk('Interpolate', false),
    cNoSpeed = chk('Keep real timing', false),
    cTextProc = chk('Sanitise text for TTS', false)
  f.append(opts)

  /** Disable what the current switches make meaningless, and say why. */
  const syncOpts = () => {
    const speeding = !on(cNoSpeed)
    for (const el2 of [idle, action, network]) el2.disabled = !speeding
    const interp = on(cInterp)
    for (const el2 of [iFps, iMode, iQual, iPasses]) el2.disabled = !interp
    for (const el2 of [cursorCfg]) el2.disabled = !on(cCursor)
    for (const el2 of [clickCfg, clickSound]) el2.disabled = !on(cClick)
    textCfg.disabled = !on(cTextProc)
    tone(fmtHint)
    fmtHint.textContent = fmt.value === 'webm' ? 'webm skips the narration mux: rm-mux writes mp4, and it is the step that reconciles the render’s clock with the narration’s. Subtitles get burned by recast instead, against the wrong clock.' : ''
  }
  fmt.onchange = syncOpts

  /** The Qwen config is required for one provider and meaningless for the rest. */
  const syncQwen = () => {
    const needs = PROVIDERS[prov.value]?.needsConfig === true
    const speaking = prov.value !== 'none'
    qwenConfig.disabled = !needs
    ttsModel.disabled = !speaking || needs
    ttsSpeed.disabled = !speaking || needs
  }

  // Once, after everything above exists. syncVoice and syncQwen are also called
  // from prov.onchange; syncOpts from every chip and from the format select.
  syncVoice()
  syncQwen()
  syncOpts()

  const out = el('div', 'full')
  const build = el('button', 'btn', 'Work out the steps')
  const w = el('div', 'full')
  w.append(build)
  f.append(w, out)

  build.onclick = async () => {
    if (!trace.value.trim()) {
      out.innerHTML = ''
      out.append(Object.assign(el('div', 'hint bad'), { textContent: 'Pick a trace first — Browse… opens your home directory.' }))
      return
    }
    build.disabled = true
    build.textContent = 'Working it out…'
    const r = await (
      await fetch('/api/recast', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId: proj.value,
          title: title.value,
          trace: trace.value.trim(),
          srt: srt.value.trim() || null,
          provider: prov.value,
          voice: voice.value || null,
          model: ttsModel.value.trim() || null,
          ttsSpeed: ttsSpeed.value.trim() || null,
          qwenConfig: qwenConfig.value.trim() || null,
          textProcessing: on(cTextProc),
          textProcessingConfig: textCfg.value.trim() || null,
          noSpeed: on(cNoSpeed),
          speedIdle: idle.value,
          speedAction: action.value,
          speedNetwork: network.value,
          resolution: rez.value,
          format: fmt.value,
          cursor: on(cCursor),
          cursorConfig: cursorCfg.value.trim() || null,
          click: on(cClick),
          clickConfig: clickCfg.value.trim() || null,
          clickSound: clickSound.value.trim() || null,
          interpolate: on(cInterp),
          interpolateFps: iFps.value,
          interpolateMode: iMode.value,
          interpolateQuality: iQual.value,
          interpolatePasses: iPasses.value,
        }),
      })
    ).json()
    build.disabled = false
    build.textContent = 'Work out the steps'
    out.innerHTML = ''
    if (r.error) {
      out.append(Object.assign(el('div', 'hint bad'), { textContent: r.error }))
      return
    }

    // Say what these buttons will do, with the real paths, before they are pressed.
    const items = [['Cut the demo from the trace.', 'Writes ' + r.out]]
    if (!r.smooth) items.push(['Motion comes from screencast frames.', 'No video sits beside the trace, so expect a slideshow rather than real motion.'])
    if (r.muxSkipped) items.push(['Narration exists, but the mux is skipped.', 'rm-mux writes mp4 and the format is ' + r.muxSkipped + '. recast burns the subtitles itself, against its own compressed clock rather than the narration’s.'])
    else if (r.wav) items.push(['Add the narration you already made.', 'Uses ' + r.wav + ', reconciles the clocks, burns the subtitles, and writes ' + r.narrated])
    else items.push(['No narration for this name yet.', 'Make one under Voice using the name "' + (title.value || 'trace-demo') + '" and it will be picked up here.'])
    items.push(['Output folder', r.dir])
    out.append(plan(items))

    for (const st of r.steps) out.append(runRow(st, st.label.startsWith('narrate') ? 'Add the narration' : 'Cut the demo'))
    if (r.steps.length > 1) {
      const all = el('button', 'btn', 'Run both, in order')
      const chainNote = el('div', 'hint')
      all.onclick = async () => {
        all.disabled = true
        chainNote.textContent = ''
        chainNote.className = 'hint'
        for (const st of r.steps) {
          const j = await start(st)
          if (!j) break
          const code = await waitFor(j.id)
          if (code !== 0) {
            chainNote.className = 'hint bad'
            chainNote.textContent = `Stopped after ${st.label} — it exited ${code === null ? 'without a status' : code}. Console has the output; the step after it did not run.`
            break
          }
        }
        all.disabled = false
        refreshJobs()
      }
      out.append(all, chainNote)
    }
  }
  m.append(f)
}

/* ── Voice ───────────────────────────────────────────────────
   One clip per line, cached on (voice, text), then an SRT written from the
   durations we measured. Nothing gets transcribed back — we already know the
   words, and asking Whisper to guess at them is how "Feeney" becomes "Phoenix". */
function vVoice(m) {
  m.append(el('p', 'lede', 'Turn a script into narration and a perfectly synced SRT. Voices are Kokoro, running locally — no API key, no per-character billing, and nothing about an unreleased client product leaves the machine.'))
  m.append(Object.assign(el('div', 'note'), { innerHTML: 'Timings are exact by construction: each line is synthesised and measured, so the SRT cannot drift from the audio. Edit one line and only that line re-synthesises — the rest come from cache.' }))

  // Voice needs two Python packages, and a bare pip install fails on a current Mac
  // with PEP 668. Rather than document that, offer a button that builds a
  // private virtualenv. Nothing touches system Python.
  if (!S.tools.voice) {
    const w = el('div', 'form')
    w.style.marginBottom = 'var(--op-space-large)'
    w.append(Object.assign(el('div', 'note full'), { innerHTML: "Voice isn't set up on this machine yet. This builds a private Python environment just for it — about 100MB, once. Nothing is installed into your system Python and there's no environment variable to set." }))
    const b = el('button', 'btn', 'Set up voice')
    const out = el('div', 'full')
    b.onclick = async () => {
      const r = await (await fetch('/api/voice/setup', { method: 'POST' })).json()
      out.innerHTML = ''
      if (r.error) {
        out.append(Object.assign(el('pre'), { textContent: 'Error: ' + r.error }))
        return
      }
      out.append(Object.assign(el('div', 'path'), { textContent: 'installs into  ' + r.venv }))
      out.append(runRow(r.step, 'Run setup'))
      out.append(Object.assign(el('div', 'path'), { textContent: 'When it finishes, reload this page.' }))
    }
    const bw = el('div', 'full')
    bw.append(b)
    w.append(bw, out)
    m.append(w)
  }

  const f = el('div', 'form')
  const mk = (l, n, hint) => field(f, l, n, hint)
  const proj = mk('Project', el('select'))
  for (const p of S.projects) proj.append(Object.assign(el('option', null, (p.client ? p.client + ' · ' : '') + p.name), { value: p.id }))
  const pick = mk('Script', el('select'))
  /*
   * Where the voice comes from. Kokoro is first and default because it is local:
   * no key, no per-character cost, and the script never leaves the machine.
   * ElevenLabs is here for when a client has asked for a specific commercial
   * voice, and the panel says what that costs you in privacy at the moment of
   * choosing rather than in a doc nobody reads.
   */
  const prov = mk('Voice from', el('select'))
  for (const [id, label] of [
    ['kokoro', 'Kokoro — local, on this machine'],
    ['elevenlabs', 'ElevenLabs — cloud, sends your script'],
  ])
    prov.append(Object.assign(el('option', null, label), { value: id }))

  const voiceHint = el('div', 'hint')
  const voice = mk('Voice', el('select'), voiceHint)
  // Where the "Download it now" button goes when the list could not be read. Its own
  // row, so it is not inside the hint text it is answering.
  const fixRow = el('div', 'full')
  fixRow.style.cssText = 'display:flex;flex-direction:column;gap:var(--op-space-x-small);align-items:flex-start'
  f.append(fixRow)

  const keys = apiKeyBlock(f, { onSaved: () => loadVoices() })

  const loadVoices = async () => {
    const which = prov.value
    voice.innerHTML = ''
    tone(voiceHint)
    voiceHint.textContent = 'reading the voice list...'
    const d = await (await fetch('/api/voices?provider=' + encodeURIComponent(which))).json().catch(() => ({ from: 'none', voices: [] }))
    for (const v of d.voices) voice.append(Object.assign(el('option', null, v.label), { value: v.id }))
    // Show the field whenever ElevenLabs is not actually usable — missing key,
    // rejected key, or unreachable. Keying off needsKey alone hid the input in
    // exactly the case you most need it: a stored key that turns out to be wrong.
    // Always visible for a cloud provider, working or not.
    keys.show(which === 'elevenlabs')

    if (d.from === 'kokoro') {
      voiceHint.textContent = d.voices.length + ' voices, read from Kokoro on this machine. Nothing leaves the machine and there is nothing to pay for.'
    } else if (d.from === 'elevenlabs') {
      tone(voiceHint, 'warn')
      voiceHint.textContent = d.voices.length + ' voices from your ElevenLabs account. Each line of the script is sent to ElevenLabs to be spoken — do not use this for an unreleased client product.'
    } else {
      tone(voiceHint, 'bad')
      voiceHint.textContent = d.note || 'No voices available.'
    }

    /*
     * The one failure with a fix gets a button.
     *
     * The page used to print "hyperframes 0.8.12 is not in the npx cache — a newer
     * release than the copy on this machine", which is true and actionable by
     * nobody. The download is a single command that this can run, so it runs it —
     * and comes back with the voices, because a button that succeeds and leaves the
     * field still wrong is a button that looks broken.
     */
    fixRow.innerHTML = ''
    if (d.fetchable) {
      const go = el('button', 'btn ghost')
      go.append(icon('download-01'), Object.assign(el('span'), { textContent: 'Download it now' }))
      const said = el('div', 'hint')
      go.onclick = async () => {
        go.disabled = true
        tone(said)
        said.textContent = 'downloading — this happens once, and takes about as long as an npm install'
        const r = await fetch('/api/voices/fetch', { method: 'POST' })
          .then((x) => x.json())
          .catch(() => ({ ok: false, error: 'could not reach the Studio' }))
        go.disabled = false
        if (!r.ok) {
          tone(said, 'bad')
          said.textContent = r.error
          return
        }
        // Reload rather than splicing the list in: loadVoices is what decides the
        // hint, the key field and the provider wiring, and there is one of it.
        await loadVoices()
      }
      fixRow.append(go, said)
    }
  }
  prov.onchange = loadVoices
  loadVoices()
  const gap = mk('Gap between lines', Object.assign(el('input'), { type: 'number', value: DEFAULT_GAP_MS, min: 0, max: 1500, step: 20 }))

  const preview = el('pre', 'full')
  preview.style.cssText = 'max-height:var(--preview-tall);overflow:auto'
  const est = el('div', 'path')
  const fill = () => {
    pick.innerHTML = ''
    const mine = S.scripts.filter((x) => x.project === proj.value)
    if (!mine.length) {
      pick.append(Object.assign(el('option', null, '— no scripts in this project —'), { value: '' }))
    }
    for (const sc of mine) pick.append(Object.assign(el('option', null, sc.name), { value: sc.name }))
    show()
  }
  const show = () => {
    const sc = S.scripts.find((x) => x.project === proj.value && x.name === pick.value)
    const lines = sc ? SP.parseScript(sc.body) : []
    preview.textContent = lines.length ? lines.map((l, i) => i + 1 + '  ' + l).join('\n') : 'Nothing speakable — headings, bullets markers and code blocks are skipped.'
    est.textContent = lines.length ? lines.length + ' lines · roughly ' + Math.round(SP.estimateSeconds(lines, Number(gap.value || DEFAULT_GAP_MS))) + 's' : ''
  }
  proj.onchange = fill
  pick.onchange = show
  gap.oninput = show

  const out = el('div', 'full')
  const go = el('button', 'btn', 'Build the narration')
  const w = el('div', 'full')
  w.append(go)
  const linesGroup = el('div', 'form-group')
  linesGroup.append(el('label', 'form-label', 'Lines'), preview, Object.assign(est, { className: 'form-hint path' }))
  f.append(linesGroup, w, out)
  go.onclick = async () => {
    const r = await (await fetch('/api/voice', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: proj.value, script: pick.value, provider: prov.value, voice: voice.value, gap: Number(gap.value) }) })).json()
    out.innerHTML = ''
    if (r.error) {
      out.append(Object.assign(el('pre'), { textContent: 'Error: ' + r.error }))
      return
    }
    out.append(Object.assign(el('div', 'path'), { textContent: 'audio  ' + r.out }))
    out.append(Object.assign(el('div', 'path'), { textContent: 'subs   ' + r.srt }))
    out.append(runRow(r.step, 'Speak it'))
  }
  m.append(f)
  fill()
}

/* ── Scripts ─────────────────────────────────────────────── */
function vScripts(m) {
  m.append(el('p', 'lede', "Narration and outlines as markdown — greppable, and they diff. A script saved to a project lands in that project's scripts/ folder; the shared shelf is for the ones that travel. Voice reads from here."))

  // Drafting. Claude writes straight into the project's scripts/ folder, in the
  // shape the synthesiser wants — one spoken sentence per line — so a draft is
  // ready for Voice without reformatting.
  const draft = el('div', 'form')
  draft.style.marginBottom = 'var(--op-space-large)'
  const dk = (l, n, hint) => field(draft, l, n, hint)
  const dproj = dk('Project', el('select'))
  for (const p of S.projects) dproj.append(Object.assign(el('option', null, (p.client ? p.client + ' · ' : '') + p.name), { value: p.id }))
  const dname = dk('Save as', Object.assign(el('input'), { placeholder: 'opener' }))
  const dsecs = dk('Seconds', Object.assign(el('input'), { type: 'number', value: 30, min: 10, max: 180, step: 5 }))
  const dabout = el('textarea')
  dabout.className = 'full'
  dabout.placeholder = 'A URL, or a couple of sentences about what the video is for and who is watching.'
  dk('About', dabout)
  const dout = el('div', 'full')
  const dgo = el('button', 'btn ghost', 'Draft it with Claude')
  const dw = el('div', 'full')
  dw.append(dgo)
  draft.append(dw, dout)
  dgo.onclick = async () => {
    const r = await (await fetch('/api/script/draft', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: dproj.value, name: dname.value, seconds: Number(dsecs.value), about: dabout.value }) })).json()
    dout.innerHTML = ''
    if (r.error) {
      dout.append(Object.assign(el('pre'), { textContent: 'Error: ' + r.error }))
      return
    }
    dout.append(Object.assign(el('div', 'path'), { textContent: 'writes  ' + r.dest }))
    dout.append(runRow(r.step, 'Write the draft'))
    dout.append(Object.assign(el('div', 'path'), { textContent: 'When it finishes, reload and it appears below and in Voice.' }))
  }
  m.append(draft)

  const f = el('div', 'form')
  const proj = el('select')
  proj.append(Object.assign(el('option', null, 'Shared shelf (no project)'), { value: '' }))
  for (const p of S.projects) proj.append(Object.assign(el('option', null, (p.client ? p.client + ' · ' : '') + p.name), { value: p.id }))
  field(f, 'Project', proj)
  const name = field(f, 'Name', Object.assign(el('input'), { placeholder: 'case-study-opener' }))
  const body = el('textarea')
  body.placeholder = 'Write the script…'
  field(f, 'Script', body)
  const save = el('button', 'btn', 'Save script')
  const w = el('div', 'full')
  w.append(save)
  f.append(w)
  save.onclick = async () => {
    await fetch('/api/script', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name.value, body: body.value, projectId: proj.value || null }) })
    await load()
  }
  m.append(f)
  if (S.scripts.length) {
    m.append(el('div', 'client', 'Saved'))
    const g = el('div', 'grid')
    for (const s of S.scripts) {
      const c = el('div', 'card')
      const b = el('div', 'body')
      const owner = s.project ? (S.projects.find((x) => x.id === s.project)?.name ?? s.project) : 'shared'
      b.append(el('div', 'nm', s.name), el('div', 'path', owner), el('div', 'path', s.body.slice(0, SNIPPET_CHARS) + (s.body.length > SNIPPET_CHARS ? '…' : '')))
      c.append(b)
      c.style.cursor = 'pointer'
      c.onclick = () => {
        name.value = s.name
        body.value = s.body
        proj.value = s.project || ''
        window.scrollTo(0, 0)
      }
      g.append(c)
    }
    m.append(g)
  }
}

/* ── Brand ───────────────────────────────────────────────── */
function vBrand(m) {
  m.append(el('p', 'lede', 'Wallpapers and title treatments, generated from the Optics palette. Change the export, re-run sync-brand, and everything here follows.'))

  const t = S.tokens || {}
  const pal = t.palette || {}
  m.append(el('div', 'client', 'Sub-brands'))
  const pg = el('div', 'grid')
  for (const [id, b] of Object.entries(t.subBrands || {})) {
    const c = el('div', 'card')
    const sw = el('div', 'thumb')
    sw.style.background = b.hex
    sw.style.aspectRatio = 'var(--swatch-ar)'
    const bd = el('div', 'body')
    bd.append(el('div', 'nm', b.label), el('div', 'path', `${b.hex} · H${b.h} S${b.s}% L${b.l}%`))
    c.append(sw, bd)
    pg.append(c)
  }
  m.append(pg)

  m.append(el('div', 'client', 'Title & lower third'))
  const sel = el('div', 'row')
  const wpSel = Object.assign(el('select'), { className: 'form-control' })
  wpSel.setAttribute('aria-label', 'Wallpaper behind the preview')
  for (const w of S.wallpapers) wpSel.append(Object.assign(el('option', null, w.label), { value: w.file }))
  const tIn = Object.assign(el('input'), { value: 'Dock Designer', placeholder: 'Title', className: 'form-control' })
  tIn.setAttribute('aria-label', 'Title')
  const eIn = Object.assign(el('input'), { value: 'Product tour', placeholder: 'Eyebrow', className: 'form-control' })
  eIn.setAttribute('aria-label', 'Eyebrow')
  const nIn = Object.assign(el('input'), { value: 'Dallas Peters', placeholder: 'Name', className: 'form-control' })
  nIn.setAttribute('aria-label', 'Name')
  const sIn = Object.assign(el('input'), { value: 'Senior Designer', placeholder: 'Subtitle', className: 'form-control' })
  sIn.setAttribute('aria-label', 'Subtitle')
  sel.append(wpSel, tIn, eIn, nIn, sIn)
  m.append(sel)

  const prev = el('div', 'grid')
  prev.style.gridTemplateColumns = 'repeat(auto-fill,minmax(var(--preview-min),1fr))'
  m.append(prev)
  const draw = () => {
    prev.innerHTML = ''
    for (const mode of ['title', 'lower']) {
      const box = el('div', 'lt')
      box.style.backgroundImage = `url('/wallpaper/${wpSel.value}')`
      if (mode === 'title') {
        const eb = el('div', 'eb', eIn.value.toUpperCase())
        eb.style.cssText = `color:${pal.primary};font-size:var(--lt-eyebrow-size)`
        const ti = el('div', 'ti', tIn.value)
        ti.style.cssText = `color:${pal.light};font-size:var(--lt-title-size)`
        box.append(eb, ti)
      } else {
        const n = el('div', 't', nIn.value)
        n.style.cssText = `color:${pal.light};font-size:var(--lt-name-size)`
        const s2 = el('div', 's', sIn.value)
        s2.style.cssText = `color:${pal.tertiary};font-size:var(--lt-sub-size)`
        box.append(n, s2)
      }
      box.style.containerType = 'inline-size'
      const c = el('div', 'card')
      c.style.padding = '0'
      c.append(box)
      const cap = el('div', 'body')
      cap.append(el('div', 'path', mode === 'title' ? 'title()' : 'lowerThird()'))
      c.append(cap)
      prev.append(c)
    }
  }
  for (const i of [wpSel, tIn, eIn, nIn, sIn]) ((i.oninput = draw), (i.onchange = draw))
  draw()

  m.append(el('div', 'client', 'Wallpapers'))
  const wg = el('div', 'grid')
  for (const w of S.wallpapers) {
    const c = el('div', 'card')
    const im = el('div', 'wp')
    im.style.backgroundImage = `url('/wallpaper/${w.file}')`
    const b = el('div', 'body')
    b.append(el('div', 'nm', w.label), el('div', 'path', w.file))
    c.onclick = () => {
      editing = null
      view = 'wallpapers'
      for (const o of document.querySelectorAll('nav button[data-v]')) o.setAttribute('aria-current', String(o.dataset.v === 'wallpapers'))
      render()
      setTimeout(() => {
        const r = recipes.find((x) => x.name === w.name)
        if (r) openEditor(r)
      }, EDITOR_OPEN_MS)
    }
    c.append(im, b)
    wg.append(c)
  }
  m.append(wg)
}

/* ── Wallpapers ──────────────────────────────────────────────
   A wallpaper is a recipe, not a hand-written CSS block. The canvas below runs
   the same lib/wallpaper.mjs the batch renderer runs, so what you see is what
   gets written — Save just re-draws it at 3840×2160 and posts the bytes. */
function vWallpapers(m) {
  m.append(el('p', 'lede', 'The backdrop behind the recording — the biggest branded surface in the video. Everything here is linear: no radial gradients, no vignette.'))

  const grid = el('div', 'grid wpgrid')
  const editor = el('div')
  editor.style.marginTop = 'var(--op-space-large)'
  const bar = el('div', 'row')
  const nw = el('button', 'btn ghost', 'New wallpaper')
  nw.onclick = () => openEditor({ ...WP.DEFAULT_RECIPE, name: '', label: '' })
  bar.append(nw)
  m.append(bar, grid, editor)

  const paint = () => {
    grid.innerHTML = ''
    for (const r of recipes) {
      const c = el('div', 'card')
      c.setAttribute('aria-selected', String(editing?.name === r.name))
      const cv = el('canvas')
      cv.width = THUMB_W
      cv.height = frameHeight(THUMB_W)
      cv.style.cssText = 'width:100%;height:auto;display:block'
      WP.draw(cv.getContext('2d'), r, cv.width, cv.height)
      const b = el('div', 'body')
      b.append(el('div', 'nm', r.label), el('div', 'path', r.name + '.jpg'))
      c.append(cv, b)
      c.onclick = () => openEditor(r)
      grid.append(c)
    }
  }

  openEditor = (r) => {
    editing = JSON.parse(JSON.stringify(WP.normalize(r)))
    if (!r.name) editing.name = ''
    paint()
    editor.innerHTML = ''
    editor.append(buildEditor(editing, paint))
    editor.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }

  if (!recipes.length) {
    grid.append(Object.assign(el('div', 'empty', 'Loading recipes…'), {}))
    fetch('/api/wallpapers')
      .then((r) => r.json())
      .then((d) => {
        recipes = d.wallpapers.map(WP.normalize)
        paint()
      })
  } else paint()
}

let openEditor = () => {}

/** The control panel. Every input mutates the recipe in place and repaints. */
function buildEditor(r, onSaved) {
  const wrap = el('div', 'wpe')
  const left = el('div')
  const cv = el('canvas')
  cv.width = EDITOR_W
  cv.height = frameHeight(EDITOR_W)
  left.append(cv)
  const status = el('div', 'path')
  status.style.marginTop = 'var(--op-space-x-small)'
  left.append(status)
  const panel = el('div', 'panel2')

  const repaint = () => WP.draw(cv.getContext('2d'), r, cv.width, cv.height)

  const sec = (t) => panel.append(el('div', 'sec', t))
  const g = () => {
    const d = el('div', 'ctl')
    panel.append(d)
    return d
  }

  const textRow = (box, label, get, set, ph) => {
    const i = Object.assign(el('input'), { value: get() ?? '', placeholder: ph || '' })
    i.className = 'wide form-control'
    i.oninput = () => {
      set(i.value)
      repaint()
    }
    box.append(el('label', 'form-label', label), i)
    return i
  }
  const colorRow = (box, label, get, set) => {
    const i = Object.assign(el('input'), { type: 'color', value: get(), className: 'form-control' })
    i.oninput = () => {
      set(i.value)
      repaint()
    }
    box.append(el('label', 'form-label', label), i, el('span', 'v', ''))
    return i
  }
  const rangeRow = (box, label, get, set, range, fmt) => {
    const i = Object.assign(el('input'), { type: 'range', ...range, value: get(), className: 'form-control' })
    const v = el('span', 'v', (fmt || String)(get()))
    i.oninput = () => {
      set(Number(i.value))
      v.textContent = (fmt || String)(Number(i.value))
      repaint()
    }
    box.append(el('label', 'form-label', label), i, v)
    return i
  }
  const selectRow = (box, label, opts, get, set) => {
    const s = el('select')
    s.className = 'wide form-control'
    for (const o of opts) s.append(Object.assign(el('option', null, o), { value: o, selected: o === get() }))
    s.onchange = () => {
      set(s.value)
      repaint()
    }
    box.append(el('label', 'form-label', label), s)
    return s
  }

  sec('Identity')
  const idb = g()
  const nameIn = textRow(
    idb,
    'Name',
    () => r.name,
    (v) => {
      r.name = v
    },
    'lcad-board',
  )
  textRow(
    idb,
    'Label',
    () => r.label,
    (v) => {
      r.label = v
    },
    'Flow · tinted board',
  )

  sec('Base + gradient')
  const gb = g()
  colorRow(
    gb,
    'Base',
    () => r.base,
    (v) => {
      r.base = v
    },
  )
  rangeRow(
    gb,
    'Angle',
    () => r.gradient.angle,
    (v) => {
      r.gradient.angle = v
    },
    RANGE.angle,
    (v) => v + '°',
  )
  const stops = el('div')
  stops.className = 'wide'
  gb.append(el('label', 'form-label', 'Stops'), stops)
  const drawStops = () => {
    stops.innerHTML = ''
    r.gradient.stops.forEach((s, i) => {
      const row = el('div', 'stop')
      const c = Object.assign(el('input'), { type: 'color', value: s.color, className: 'form-control' })
      c.oninput = () => {
        s.color = c.value
        repaint()
      }
      const p = Object.assign(el('input'), { type: 'range', ...RANGE.stop, value: s.at, className: 'form-control' })
      const pv = el('span', 'v', pct(s.at))
      p.oninput = () => {
        s.at = Number(p.value)
        pv.textContent = pct(s.at)
        repaint()
      }
      const x = el('button', null, '×')
      x.onclick = () => {
        if (r.gradient.stops.length < MIN_GRADIENT_STOPS) return
        r.gradient.stops.splice(i, 1)
        drawStops()
        repaint()
      }
      row.append(c, p, pv, x)
      stops.append(row)
    })
    const add = el('button', 'chip', '+ stop')
    add.onclick = () => {
      r.gradient.stops.push({ color: r.base, at: 1 })
      drawStops()
      repaint()
    }
    stops.append(add)
  }
  drawStops()

  sec('Tint')
  const tb = g()
  colorRow(
    tb,
    'Colour',
    () => r.tint.color,
    (v) => {
      r.tint.color = v
    },
  )
  rangeRow(
    tb,
    'Strength',
    () => r.tint.alpha,
    (v) => {
      r.tint.alpha = v
    },
    RANGE.tint,
    (v) => v.toFixed(2),
  )
  rangeRow(
    tb,
    'Angle',
    () => r.tint.angle,
    (v) => {
      r.tint.angle = v
    },
    RANGE.angle,
    (v) => v + '°',
  )

  sec('Texture')
  const xb = g()
  selectRow(
    xb,
    'Type',
    WP.TEXTURES,
    () => r.texture.type,
    (v) => {
      r.texture.type = v
    },
  )
  colorRow(
    xb,
    'Colour',
    () => r.texture.color,
    (v) => {
      r.texture.color = v
    },
  )
  rangeRow(
    xb,
    'Opacity',
    () => r.texture.opacity,
    (v) => {
      r.texture.opacity = v
    },
    RANGE.texture,
    (v) => v.toFixed(3),
  )
  rangeRow(
    xb,
    'Spacing',
    () => r.texture.size,
    (v) => {
      r.texture.size = v
    },
    RANGE.spacing,
    (v) => v + 'px',
  )
  rangeRow(
    xb,
    'Weight',
    () => r.texture.weight,
    (v) => {
      r.texture.weight = v
    },
    RANGE.weight,
    (v) => v.toFixed(2),
  )

  sec('Border')
  const bb = g()
  bb.append(Object.assign(el('div', 'note wide'), { textContent: 'A solid line, not a fade. Bottom is one rule along the bottom edge; all draws the full frame, and only that uses Radius. Width is in px at 1920 and scales with the export, so 6px looks like 6px at 4K. Width 0 turns it off — Inset and Radius do nothing on their own.' }))
  selectRow(
    bb,
    'Sides',
    WP.BORDER_SIDES,
    () => r.border.sides,
    (v) => {
      r.border.sides = v
    },
  )
  rangeRow(
    bb,
    'Width',
    () => r.border.width,
    (v) => {
      r.border.width = v
    },
    RANGE.edge,
    (v) => v + 'px',
  )
  colorRow(
    bb,
    'Colour',
    () => r.border.color,
    (v) => {
      r.border.color = v
    },
  )
  rangeRow(
    bb,
    'Inset',
    () => r.border.inset,
    (v) => {
      r.border.inset = v
    },
    RANGE.inset,
    (v) => v + 'px',
  )
  rangeRow(
    bb,
    'Radius',
    () => r.border.radius,
    (v) => {
      r.border.radius = v
    },
    RANGE.radius,
    (v) => v + 'px',
  )

  const save = el('button', 'btn', 'Save wallpaper')
  save.style.marginTop = 'var(--op-space-medium)'
  save.onclick = async () => {
    if (!nameIn.value.trim()) {
      status.textContent = 'Name it first.'
      return
    }
    save.disabled = true
    save.textContent = 'Rendering 4K…'
    // Draw the real export off-screen with the identical code path, then hand the
    // server finished bytes. No Playwright on a designer's machine.
    const big = document.createElement('canvas')
    big.width = EXPORT_W
    big.height = frameHeight(EXPORT_W)
    WP.draw(big.getContext('2d'), r, big.width, big.height)
    const jpeg = big.toDataURL('image/jpeg', EXPORT_QUALITY)
    const res = await (await fetch('/api/wallpaper', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ recipe: r, jpeg }) })).json()
    save.disabled = false
    save.textContent = 'Save wallpaper'
    if (res.error) {
      status.textContent = 'Error: ' + res.error
      return
    }
    status.textContent = 'Saved ' + res.file
    const d = await (await fetch('/api/wallpapers')).json()
    recipes = d.wallpapers.map(WP.normalize)
    // Refresh state without re-rendering — render() would tear down this editor
    // mid-edit, which is a rotten thing to do to someone who just hit Save.
    S = await (await fetch('/api/state')).json()
    onSaved?.()
  }
  panel.append(save)

  wrap.append(left, panel)
  requestAnimationFrame(repaint)
  return wrap
}

/* ── Console ─────────────────────────────────────────────────
   Every job the Studio has started, with live output. One EventSource at a
   time, closed on switch — a page that quietly holds twenty open streams is a
   page that stops updating after a while and nobody knows why. */
/**
 * Render one Claude stream-json event as a line of Console output.
 *
 * `claude -p` in its default text mode prints a single blob when it finishes, so
 * a render that takes minutes showed an empty Console and looked hung. With
 * --output-format stream-json it emits an event per step, but those events are
 * NDJSON with session ids and token counts in them — dumping them raw would be
 * worse than silence. This keeps the parts a person watching a render wants:
 * what Claude said, which tool it reached for, and how it ended.
 *
 * Returns null for events worth hiding (hook chatter, rate-limit notices, the
 * per-tool results that only repeat what the tool call already said).
 */
/**
 * One `openscreen --json` NDJSON event as console lines.
 *
 * Its shape is `{event: "started"|"error"|"done", ...}`. The messages carry real
 * newlines — the window list in a failed `record` is one — and a raw dump shows
 * those as literal \n, so they are split back out into lines here.
 *
 * Returns null for anything unrecognised, and the caller prints it raw.
 */
function openscreenLine(d) {
  if (typeof d?.event !== 'string') return null
  const lines = (text, cls) =>
    String(text)
      .split('\n')
      .map((l) => l.trimEnd())
      .filter(Boolean)
      .map((text) => ({ cls, text }))

  if (d.event === 'started') return { cls: 'm', text: `— openscreen ${d.command || ''} started —`.replace(/\s+/g, ' ') }
  if (d.event === 'log') return lines(d.message ?? '', '')
  if (d.event === 'error') return lines(d.message ?? d.error ?? 'unspecified error', 'e')
  if (d.event === 'done') {
    // The failure is already on screen: `done` repeats verbatim what the `error`
    // event carried, and for a bad --window that is a nineteen-line list of every
    // open window. One summary line here, and the reason still survives if a run
    // ever reports `done` without an `error` before it.
    if (d.success === false) {
      const why = String(d.error ?? d.message ?? 'failed')
        .split('\n')[0]
        .trim()
      return { cls: 'e', text: `— openscreen failed: ${why} —` }
    }
    // A successful record reports where it put things, and those paths are the
    // whole point of having run it.
    const paths = [d.output, d.project, d.path, d.screenVideoPath, d.cursorDataPath].filter(Boolean)
    return [{ cls: 'm', text: '— openscreen finished —' }, ...paths.map((text) => ({ cls: 'm', text }))]
  }
  if (d.event === 'progress' && typeof d.percent === 'number') return { cls: 'm', text: `${Math.round(d.percent)}%` }
  return null
}

function claudeLine(d) {
  if (d.type === 'system') {
    // Only the init event says anything useful; the rest is hook plumbing.
    if (d.subtype !== 'init') return null
    const tools = Array.isArray(d.tools) ? d.tools.length : 0
    return { cls: 'm', text: `— claude ${d.claude_code_version || ''} · ${d.model || 'model'} · ${tools} tools · ${d.permissionMode || ''} —`.replace(/\s+/g, ' ') }
  }

  if (d.type === 'assistant') {
    const parts = []
    for (const c of d.message?.content ?? []) {
      if (c.type === 'text' && c.text?.trim()) parts.push({ cls: '', text: c.text.trim() })
      if (c.type === 'tool_use') {
        // The first meaningful-looking input value, so a Write says which file.
        const i = c.input ?? {}
        const target = i.file_path ?? i.path ?? i.command ?? i.pattern ?? i.url ?? i.description ?? ''
        parts.push({ cls: 'm', text: `→ ${c.name}${target ? ' ' + String(target).slice(0, 120) : ''}` })
      }
    }
    return parts.length ? parts : null
  }

  if (d.type === 'result') {
    const secs = d.duration_ms ? (d.duration_ms / 1000).toFixed(1) + 's' : null
    const bits = [d.num_turns ? `${d.num_turns} turns` : null, secs, typeof d.total_cost_usd === 'number' ? `$${d.total_cost_usd.toFixed(4)}` : null].filter(Boolean)
    if (d.is_error || d.subtype !== 'success') {
      return { cls: 'e', text: `— claude failed: ${d.subtype || 'error'}${d.api_error_status ? ' (' + d.api_error_status + ')' : ''} —` }
    }
    return { cls: 'm', text: `— claude finished · ${bits.join(' · ')} —` }
  }

  // user (tool results), rate_limit_event, and anything new: not worth a line.
  return null
}

function vConsole(m) {
  m.append(el('p', 'lede', "Everything the Studio runs, as it runs. Output is live — you don't have to go find a terminal to see whether the export worked."))

  const wrap = el('div', 'con')
  const list = el('div', 'joblist')
  const right = el('div')
  const status = el('div', 'hint')
  const head = el('div', 'runrow')
  const log = el('div', 'log')
  const artifacts = el('div')
  right.append(status, head, log, artifacts)
  wrap.append(list, right)
  m.append(wrap)

  if (shellOn) {
    const bar = el('div', 'cmd')
    const inp = Object.assign(el('input'), { placeholder: 'openscreen info --json' })
    const b = el('button', 'btn', 'Run')
    const fire = async () => {
      if (!inp.value.trim()) return
      await start({ shell: inp.value.trim() })
      inp.value = ''
    }
    b.onclick = fire
    inp.onkeydown = (e) => {
      if (e.key === 'Enter') fire()
    }
    bar.append(inp, b)
    right.append(bar)
  } else {
    right.append(Object.assign(el('div', 'note'), { innerHTML: 'Run buttons build their own commands from a fixed list of binaries, so this page will not run arbitrary text. Want a prompt to type into? Restart with <code>rm-studio --shell</code>.' }))
  }

  // The job whose output `es` is currently attached to. Not the same thing as
  // `jobId`: the stream is reattached only when the selection actually changes,
  // which is the whole point of the rewrite below.
  // Deliberately undefined, not null: `jobId` is null before anything is picked,
  // and initialising this to null made the first attach() short-circuit on
  // `streaming === jobId` — so the "Pick a job" placeholder never rendered.
  let streaming
  let listSig = null

  const secondsBetween = (a, b) => Math.max(0, Math.round((new Date(b) - new Date(a)) / 1000))

  const paintList = () => {
    // Rebuilt only when something about the jobs actually changed. Repainting on
    // every poll is what made the panel flicker three times a minute.
    const sig = allJobs.map((j) => `${j.id}:${j.running}:${j.code}`).join('|') + `#${jobId}`
    if (sig === listSig) return
    listSig = sig
    list.innerHTML = ''
    if (!allJobs.length) {
      list.append(Object.assign(el('div', 'empty', 'Nothing has run yet.'), { style: 'padding:var(--op-space-large)' }))
      return
    }
    for (const j of allJobs) {
      const row = el('div', 'job')
      row.setAttribute('aria-selected', String(j.id === jobId))
      const st = j.running ? 'running' : j.interrupted ? 'interrupted' : j.code === 0 ? 'done' : 'exit ' + j.code
      row.append(el('div', 'jl', j.label), Object.assign(el('div', 'js ' + (j.running ? 'run' : j.interrupted || j.code !== 0 ? 'bad' : '')), { textContent: st + ' · ' + j.startedAt.slice(...ISO_TIME) }))
      row.onclick = () => {
        jobId = j.id
        // In place. Calling render() here tore the panel down and reopened the
        // stream, which is what it used to do on every poll as well.
        update()
      }
      list.append(row)
    }
  }

  /** The line that says what is actually going on. There wasn't one before. */
  const paintStatus = () => {
    const running = allJobs.filter((j) => j.running).length
    const cur = allJobs.find((j) => j.id === jobId)
    const counts = `${allJobs.length} job${allJobs.length === 1 ? '' : 's'}${running ? `, ${running} running` : ''}`

    if (!allJobs.length) {
      status.className = 'hint'
      status.textContent = 'Nothing has run yet. The Run buttons on the other panels start jobs here.'
      return
    }
    if (!cur) {
      status.className = 'hint'
      status.textContent = `${counts}. Pick one on the left to watch its output.`
      return
    }
    if (cur.running) {
      status.className = 'hint ok'
      status.textContent = `${counts} · ${cur.label} is running, started ${cur.startedAt.slice(...ISO_TIME)} — output below is live.`
      return
    }
    if (cur.interrupted) {
      // The case that used to leave no trace at all: the server stopped while
      // this was working, so it neither finished nor failed.
      status.className = 'hint warn'
      status.textContent = `${counts} · ${cur.label} was interrupted — the Studio stopped while it was running, started ${cur.startedAt.slice(...ISO_TIME)}. The output below is how far it got.`
      return
    }
    const ran = cur.endedAt ? ` in ${secondsBetween(cur.startedAt, cur.endedAt)}s` : ''
    status.className = cur.code === 0 ? 'hint' : 'hint bad'
    status.textContent = cur.code === 0 ? `${counts} · ${cur.label} finished${ran}. This is the full output, kept until the server stops.` : `${counts} · ${cur.label} exited ${cur.code}${ran}. The output below is why.`
  }

  const paintHead = () => {
    const cur = allJobs.find((j) => j.id === jobId)
    head.innerHTML = ''
    if (!cur) return
    head.append(Object.assign(el('code'), { textContent: cur.command }))
    if (cur.running) {
      const s = el('button', 'btn ghost', 'Stop')
      s.onclick = async () => {
        await fetch('/api/jobs/' + cur.id + '/stop', { method: 'POST' })
        refreshJobs()
      }
      head.append(s)
    }
  }

  const write = (cls, t) => {
    // Only stick to the bottom when already there, so reading back through a long
    // log is not yanked away by the next line.
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40
    log.append(el('div', cls, t))
    if (atBottom) log.scrollTop = log.scrollHeight
  }

  const attach = () => {
    if (streaming === jobId) return // already watching this one; leave it alone
    streaming = jobId
    es?.close()
    es = null
    log.innerHTML = ''
    if (!jobId) {
      log.append(Object.assign(el('div', 'm'), { textContent: 'Pick a job on the left.' }))
      return
    }
    // One SSE event is one whole line — lib/jobs.mjs assembles them from the raw
    // chunks, so there is nothing to buffer here. A line that is a Claude event
    // gets rendered; a line of ffmpeg chatter is shown as it came.
    const emit = (cls, line) => {
      if (!line.trim()) return
      if (line.startsWith('{')) {
        try {
          const event = JSON.parse(line)
          // Two producers speak JSON here: `claude --output-format stream-json`
          // and `openscreen --json`. Try both.
          const rendered = claudeLine(event) ?? openscreenLine(event)
          if (rendered) {
            for (const part of [].concat(rendered)) write(part.cls, part.text)
            return
          }
          // Recognised as JSON but by nobody. This used to `return` here, which
          // dropped the line: a failed `openscreen record` printed three NDJSON
          // events explaining exactly what was wrong, all three were parsed,
          // none were rendered, and the Console showed an empty log under a
          // status line promising the output said why. An unrendered line is
          // shown raw — a renderer that has not been written yet must never be
          // the reason output disappears.
        } catch {
          // not an event after all; show it as it came
        }
      }
      write(cls, line)
    }

    es = new EventSource('/api/jobs/' + jobId + '/events')
    es.onmessage = (e) => {
      const d = JSON.parse(e.data)
      if (d.done) {
        write('m', '— exited ' + d.code + ' —')
        es.close()
        refreshJobs()
        return
      }
      emit(d.stream === 'err' ? 'e' : '', d.text)
    }
    es.onerror = () => es?.close()
  }

  /*
   * What the job produced.
   *
   * "It said done and I cannot find anything" is a fair complaint about a tool
   * that writes files somewhere and then only shows you a log. The directory is
   * always shown, even when empty, because "nothing was written" is itself the
   * answer sometimes.
   */
  const paintArtifacts = async () => {
    artifacts.innerHTML = ''
    if (!jobId) return
    const d = await (await fetch('/api/jobs/' + jobId + '/artifacts')).json().catch(() => null)
    if (!d) return
    artifacts.append(Object.assign(el('div', 'path'), { textContent: 'ran in  ' + d.dir }))
    if (!d.files.length) {
      artifacts.append(Object.assign(el('div', 'hint'), { textContent: 'Nothing was written there.' }))
      return
    }
    const box = el('div', 'joblist')
    box.append(Object.assign(el('div', 'crumb'), { textContent: d.files.length + ' file' + (d.files.length === 1 ? '' : 's') + ', newest first' }))
    for (const f of d.files.slice(0, 12)) {
      const row = el('div', 'job')
      const e = el('div', 'ent')
      e.append(Object.assign(el('div', 'nm2'), { textContent: f.name }), Object.assign(el('div', 'tag'), { textContent: human(f.bytes) + ' · ' + f.at.slice(...ISO_TIME) }))
      row.append(e)
      box.append(row)
    }
    artifacts.append(box)
  }

  const update = () => {
    paintList()
    paintStatus()
    paintHead()
    attach()
    paintArtifacts()
  }

  // Registered so refreshJobs() can update this panel without rebuilding it.
  // render() clears it on the way out.
  consoleUpdate = update
  update()
}

/* ── Components ──────────────────────────────────────────────
   The gallery is a real HyperFrames scene, not a screenshot of one — same
   custom elements, same Optics tokens, same seek contract. If it looks right
   here it renders right, because it is the same code path. */
function vComponents(m) {
  m.append(el('p', 'lede', 'Custom elements for HyperFrames scenes: title cards, browser chrome, lower thirds, callouts, stats, build-on lists. Drag the scrubber in the frame — the page is seeked to that instant, which is exactly what the renderer does frame by frame.'))
  m.append(Object.assign(el('div', 'note'), { innerHTML: 'Animation is <em>seeked, not played</em>: every component is a paused CSS animation positioned by one <code>--t</code> property, so frame N is identical on every render. Copy <code>components/scene.html</code> to start a new one.' }))
  const bar = el('div', 'row')
  const open = el('button', 'btn', 'Open in a tab')
  open.onclick = () => window.open('/components/gallery.html', '_blank')
  const scene = el('button', 'btn ghost', 'Open the scene template')
  scene.onclick = () => window.open('/components/scene.html', '_blank')
  bar.append(open, scene)
  m.append(bar)
  const f = el('iframe')
  f.src = '/components/gallery.html'
  f.style.cssText = 'width:100%;height:var(--frame-h);border:var(--op-border-width) solid var(--line);border-radius:var(--op-radius-large);background:var(--bg)'
  m.append(f)
  m.append(Object.assign(el('pre'), { style: 'margin-top:var(--op-space-medium)', textContent: 'node components/render-scene.mjs components/scene.html -o demo.mp4 --fps 30' }))
}

/* ── Storage ─────────────────────────────────────────────── */
function vStorage(m) {
  m.append(el('p', 'lede', 'Cloudflare R2 is S3-compatible, so rclone already speaks it — and it has no egress fees, which is the line item that hurts with video.'))
  const f = el('div', 'form')
  const mk = (l, n, hint) => field(f, l, n, hint)
  const name = mk('Remote name', Object.assign(el('input'), { placeholder: 'rm-video' }))
  const ep = mk('Endpoint', Object.assign(el('input'), { placeholder: 'https://<account>.r2.cloudflarestorage.com' }))
  const ak = mk('Access key', el('input'))
  const sk = mk('Secret key', Object.assign(el('input'), { type: 'password' }))
  const out = el('pre', 'full')
  out.style.display = 'none'
  const go = el('button', 'btn', 'Save remote')
  const w = el('div', 'full')
  w.append(go)
  f.append(w, out)
  go.onclick = async () => {
    const r = await (await fetch('/api/storage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name.value, endpoint: ep.value, accessKeyId: ak.value, secretAccessKey: sk.value }) })).json()
    out.style.display = 'block'
    out.textContent = r.ok ? 'Saved. rclone remote "' + name.value + '" is ready — pick it when creating a project.' : 'Failed:\n' + (r.err || r.out)
    if (r.ok) await load()
  }
  m.append(f)
  if (S.remotes.length) {
    m.append(el('div', 'client', 'Configured remotes'))
    const g = el('div', 'grid')
    for (const r of S.remotes) {
      const c = el('div', 'card')
      const b = el('div', 'body')
      b.append(el('div', 'nm', r))
      c.append(b)
      g.append(c)
    }
    m.append(g)
  }
}

load()
