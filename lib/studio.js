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
/** How long a button says "Saved" before it looks pressable again. */
const SAVED_MS = 1600

const DRAFT_SAVE_MS = 600 // a beat after typing stops, not once per keystroke

/*
 * The nav's shape follows the window.
 *
 * Optics ships three: `drawer` (labels beside the icons), `compact` (narrower),
 * `rail` (icons only). Which one fits is a question about width, so it is asked
 * with media queries rather than measured.
 *
 * This replaces a copy of the example from Optics' own docs, which had three
 * problems in nine lines: it looked the nav up by `id="sidebar"`, which this
 * markup does not carry — so it threw at module top level, before the first
 * render, and took the whole script down with it, leaving every panel blank; its
 * `getSidebarStyle(width)` took a width and then read `window.innerWidth`
 * instead, so the argument was decoration; and it listened to `resize`, which
 * fires on every frame of a window drag to re-apply a class that changes at two
 * points.
 *
 * `matchMedia` fires only when a threshold is actually crossed.
 */

/** Widest first: the first query that matches wins. */
const SIDEBAR_SHAPES = [
  { query: '(max-width: 48rem)', className: 'sidebar--rail' },
  { query: '(max-width: 64rem)', className: 'sidebar--compact' },
]
const SIDEBAR_DEFAULT = 'sidebar--drawer'
const SIDEBAR_SHAPE_CLASSES = [SIDEBAR_DEFAULT, ...SIDEBAR_SHAPES.map((s) => s.className)]

function applySidebarShape() {
  // The markup says `class="sidebar sidebar--drawer"`, so this is found by class.
  // Guarded because a nav that is not there must not be able to stop the app: the
  // pasted version's only symptom was a blank page.
  const sidebar = document.querySelector('.sidebar')
  if (!sidebar) return
  const shape = SIDEBAR_SHAPES.find((s) => window.matchMedia(s.query).matches)?.className ?? SIDEBAR_DEFAULT
  sidebar.classList.remove(...SIDEBAR_SHAPE_CLASSES.filter((c) => c !== shape))
  sidebar.classList.add(shape)
}

applySidebarShape()
for (const { query } of SIDEBAR_SHAPES) {
  // `change`, not `resize`: one call per threshold crossing instead of one per frame.
  window.matchMedia(query).addEventListener('change', applySidebarShape)
}

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
/*
 * The script open in the editor, or null for the list.
 *
 * Clicking a saved script used to fill the fields of a form sitting below the Claude
 * drafter and scroll to the top, so you were still looking at the drafter with your
 * script tucked underneath it. Reported as expecting the drafter to go away and the
 * page to become an editor, which is what clicking a document should do.
 */

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
  paintDocsLink()
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
  /*
   * Back where you left off.
   *
   * Checked against the nav rather than trusted: the stored name comes from a file
   * that outlives any given build, so a panel that has since been renamed or
   * removed would reach the dispatch table as `undefined` and take the whole page
   * down with it — a blank window whose cause is a word in a config file.
   *
   * Two panels are excluded on purpose. The Editor and Review both open something
   * chosen elsewhere, and that choice lives in memory only, so restoring either
   * lands on a panel with nothing in it — which is indistinguishable from the app
   * being broken.
   */
  const NEEDS_A_DOCUMENT = new Set(['editor', 'review'])
  const known = new Set([...document.querySelectorAll('nav button[data-v]')].map((b) => b.dataset.v))
  if (S.lastView && known.has(S.lastView) && !NEEDS_A_DOCUMENT.has(S.lastView)) view = S.lastView
  for (const b of document.querySelectorAll('nav button[data-v]')) b.setAttribute('aria-current', String(b.dataset.v === view))
  paintNavGroups()
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
    /*
     * The separator is ours, not Optics'.
     *
     * Optics' breadcrumbs component styles `.breadcrumbs`, `__link` and `__text`
     * and provides no separator at all — so calling this `breadcrumbs__sep` dressed
     * a local invention as part of someone else's component, which is how a future
     * Optics upgrade gets blamed for our CSS. `crumb-sep` says whose it is, and
     * aria-hidden stops a screen reader reading a slash between every step.
     */
    if (!last) {
      const sep = el('span', 'crumb-sep', '/')
      sep.setAttribute('aria-hidden', 'true')
      nav.append(sep)
    }
  })
  // The switcher first: it says which space you are in, and the trail says where
  // you are inside it. Reading order follows the scope.
  host.append(projectSwitcher())
  host.append(nav)
}

/*
 * Which panels are about a project, and which are not.
 *
 * Brand, Components, Wallpapers, Storage and Console reference `S.projects` zero
 * times — they are about the toolkit rather than about a piece of work. Everything
 * else opened by asking which project, ten selects over nine panels, all asking the
 * same question and none of them able to remember the answer.
 *
 * Listing the global ones rather than the scoped ones on purpose: a new panel is far
 * more likely to be about a project than not, so the safe default for something
 * nobody remembered to classify is "scoped".
 */
const GLOBAL_VIEWS = new Set(['brand', 'components', 'wallpapers', 'storage', 'console', 'library', 'new'])

/*
 * Are you between projects, rather than inside one?
 *
 * New project is the form that makes one. The Library is subtler: it is the
 * picker AND the project page, the same `view` either way, told apart only by
 * `openProject`. Keying this on the view alone answered "am I choosing" with
 * "yes" for a page whose whole content is one project — which hid the pipeline
 * exactly where you had just finished asking for it.
 *
 * The question this gates is "which project am I in", and on a page that is
 * about one project, that question is answered.
 */
const betweenProjects = () => view === 'new' || (view === 'library' && !openProject)

/**
 * Work in a project from here on.
 *
 * Server-side, because the app takes a new port each launch and localStorage is
 * keyed by origin. Reload before re-rendering: a panel reads footage, scripts and
 * scenes off `S`, so switching without refetching would draw the new project's
 * name over the old project's contents.
 */
async function chooseProject(id) {
  await fetch('/api/project/current', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  }).catch(() => {})
  await load()
}

/** The project you are working in, or null for the shared shelf. */
const currentProject = () => S?.currentProject ?? null

/** Its manifest, for a panel that wants the name or the catalog. */
const currentProjectRecord = () => S?.projects?.find((p) => p.id === currentProject()) ?? null

/**
 * The space you are working in, chosen once.
 *
 * Not rendered on a panel that has nothing to do with a project: showing a project
 * name above the Components gallery would say this page is scoped to it, and it is
 * not.
 */
function projectSwitcher() {
  const wrap = el('div', 'projmenu')
  /*
   * Nothing to switch between on a first run, and a picker whose only option means
   * "none" reads as a setting you got wrong.
   */
  if (!S?.projects?.length) return wrap
  // And not on the pages that are themselves about choosing one.
  if (betweenProjects()) return wrap

  const record = currentProjectRecord()
  const label = record ? (record.client ? record.client + ' · ' : '') + record.name : 'Choose a project'

  /*
   * A mark and a chevron, modelled on the editor's own menu.
   *
   * It was a native <select> pushed to the far end of the header, which is a form
   * control doing a navigation control's job: it looked like a field you fill in
   * rather than the thing that says where you are. This is the same shape the
   * editor already uses in its top bar, on the left, where the thing that scopes
   * everything else belongs — before the trail rather than opposite it.
   */
  const trigger = el('button', 'projmenu__trigger')
  trigger.type = 'button'
  trigger.setAttribute('aria-haspopup', 'menu')
  trigger.setAttribute('aria-expanded', 'false')
  trigger.append(icon(record ? 'folder-library' : 'folder-add', 'projmenu__mark'), Object.assign(el('span', 'projmenu__label'), { textContent: label }), icon('arrow-up-01', 'projmenu__caret'))

  const menu = el('div', 'projmenu__menu')
  menu.setAttribute('role', 'menu')
  menu.hidden = true

  const close = () => {
    menu.hidden = true
    trigger.setAttribute('aria-expanded', 'false')
  }

  const choose = async (id) => {
    close()
    await chooseProject(id)
  }

  const item = (iconName, text, onPick, { current = false, note = null } = {}) => {
    const b = el('button', 'projmenu__item')
    b.type = 'button'
    b.setAttribute('role', 'menuitem')
    if (current) b.setAttribute('aria-current', 'true')
    b.append(icon(iconName), Object.assign(el('span', 'projmenu__text'), { textContent: text }))
    if (note) b.append(Object.assign(el('span', 'projmenu__note'), { textContent: note }))
    b.onclick = onPick
    menu.append(b)
    return b
  }

  for (const pr of S.projects) {
    const current = pr.id === currentProject()
    item('folder-library', (pr.client ? pr.client + ' · ' : '') + pr.name, () => choose(pr.id), {
      current,
      // The count is what tells two similarly named projects apart at a glance.
      note: (() => {
        const n = (pr.catalog?.files ?? []).length
        return `${n} file${n === 1 ? '' : 's'}`
      })(),
    })
  }

  menu.append(el('div', 'projmenu__sep'))
  item('folder-library', 'All projects', () => {
    close()
    go('library')
  })
  item('folder-add', 'New project', () => {
    close()
    go('new')
  })

  trigger.onclick = () => {
    const open = menu.hidden
    menu.hidden = !open
    trigger.setAttribute('aria-expanded', String(open))
    if (open) menu.querySelector('.projmenu__item')?.focus()
  }
  // Escape closes, and a click anywhere else does too — a menu you can only leave
  // by choosing something is a trap.
  wrap.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) {
      e.stopPropagation()
      close()
      trigger.focus()
    }
  })
  document.addEventListener('pointerdown', (e) => {
    if (!menu.hidden && !wrap.contains(e.target)) close()
  })

  wrap.append(trigger, menu)
  return wrap
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
  cut: 'timeline',
  compose: 'film-01',
  scenes: 'grid-view',
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

/**
 * The pipeline group appears once you are in a project.
 *
 * Those eight panels are about a piece of work, and without a project every one of
 * them redirects to the first-run panel — so offering them is offering eight doors
 * that all lead to the same "make a project first". Library and the toolkit stay,
 * because they are what you can actually do from here.
 */
function paintNavGroups() {
  // Hidden while you are choosing a project as well as while you have none: the
  // Library is the "all projects" view, and offering the pipeline beside it says
  // you are inside one when the whole point of the page is that you are not.
  const show = Boolean(currentProject()) && !betweenProjects()
  for (const n of document.querySelectorAll('[data-group="make"]')) n.hidden = !show
}

/** Put an icon in front of each nav button's label, once. */
/*
 * Docs open outside the app.
 *
 * Wired here rather than as a view because they are a site: there is no panel to
 * render, and the router marking a "docs" view current would leave the nav
 * highlighting a page you are not on.
 *
 * `noopener` because this opens a URL from settings — a page opened without it
 * gets a handle on this window through `window.opener`.
 */
function paintDocsLink() {
  const b = $('#docs')
  if (!b || b.dataset.wired) return
  b.dataset.wired = '1'
  b.prepend(icon('file-01'))
  b.onclick = () => window.open(S?.docsUrl || 'https://rolemodel.github.io/openscreen/docs/rolemodel/using-the-studio/', '_blank', 'noopener')
}

function paintNavIcons() {
  for (const b of document.querySelectorAll('nav button[data-v]')) {
    if (b.querySelector('.hgi-stroke')) continue
    const name = VIEW_ICON[b.dataset.v]
    if (!name) continue
    /*
     * The label becomes the tooltip, because the rail hides it.
     *
     * Optics collapses a rail's labels with `font-size: 0`, which leaves the text
     * in the DOM — so a screen reader still reads it and the button keeps its
     * accessible name. A sighted person hovering a bare icon got nothing, which is
     * the one reading that was not covered.
     */
    if (!b.title) b.title = b.textContent.trim()
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
  library: 'All projects',
  editor: 'Editor',
  review: 'Review',
  new: 'New project',
  create: 'New video',
  record: 'Record a screen',
  make: 'Make from a script',
  recast: 'From a test',
  cut: 'Cut',
  compose: 'Compose',
  scenes: 'Scenes',
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
  // Siblings of #main, not children — emptying it does not empty them.
  clearPanelRegions()
  // Here as well as in load(): what the nav shows depends on the view now, and a
  // navigation does not refetch state.
  paintNavGroups()

  // One live stream at a time. Leaving the Console open in the background is how
  // you end up with a dozen dangling EventSources and a server that stops
  // answering because it ran out of sockets.
  es?.close()
  es = null
  consoleUpdate = null
  dropEditor()

  /*
   * Views that belong to another one say so.
   *
   * A single crumb reading "New project" is a page with no parent and no way
   * back — which is what it became the moment the nav item went, since the nav
   * was carrying the "where am I" job for it. Making a project is something you
   * do to the Library, so the trail is All projects / New project, and the first
   * part is a link.
   */
  const PARENT_VIEW = { new: 'library' }
  const parent = PARENT_VIEW[view]
  crumbs(parent ? [{ label: VIEW_LABEL[parent], go: () => go(parent) }, { label: VIEW_LABEL[view] ?? view }] : [{ label: VIEW_LABEL[view] ?? view }])
  /*
   * No projects means the first-run panel, whatever was asked for.
   *
   * Except the panels that can do something about it: `new` is the form that
   * creates one, and `console` is where a broken install says so. Redirecting
   * those would make the invitation a trap.
   */
  if (!S?.projects?.length && !['new', 'console'].includes(view)) {
    // Say where you actually are. The trail was still naming the panel that was
    // asked for, so it read "Scenes" above a page that is not Scenes.
    crumbs([{ label: 'Getting started' }])
    vFirstRun(m)
    return
  }

  /*
   * Projects exist, but you are not in one.
   *
   * The nav hides the pipeline group in this state, so nothing can be clicked into
   * — but `lastView` outlives a session, and a stored "scenes" would open Scenes
   * scoped to no project: an empty footage shelf, an empty scene list, and a Save
   * that writes nowhere. The Library is the picker, so that is where this goes,
   * rather than rendering a panel that cannot work.
   */
  if (!GLOBAL_VIEWS.has(view) && !currentProject()) {
    view = 'library'
    for (const b of document.querySelectorAll('nav button[data-v]')) {
      b.setAttribute('aria-current', String(b.dataset.v === view))
    }
  }
  ;({
    library: vLibrary,
    new: vNew,
    create: vCreate,
    record: vRecord,
    make: vMake,
    editor: vEditor,
    review: vReview,
    cut: vCut,
    compose: vCompose,
    scenes: vScenes,
    scripts: vScripts,
    brand: vBrand,
    wallpapers: vWallpapers,
    storage: vStorage,
    console: vConsole,
    recast: vRecast,
    components: vComponents,
    voice: vVoice,
  })[view](m)
}

function go(v) {
  /*
   * Leaving the Library leaves the project page with it.
   *
   * The list and the project page are one view told apart by `openProject`, so a
   * navigation that only set `view` left that flag standing — and "All projects",
   * from the nav or from the switcher's own menu, re-rendered the single project
   * you were already looking at. The one destination in the app named for showing
   * you everything was the one that would not.
   */
  if (v === 'library') openProject = null

  /*
   * Remembered on the server, not in localStorage.
   *
   * The app asks the OS for a free port on every launch, so the page's origin is a
   * new one each start and a browser store keyed to it is unreachable afterwards —
   * the same trap the script drafts fell into. A reload inside one session would
   * have worked, which is precisely why that bug survives being tested.
   *
   * Fire and forget: this is a convenience, and a navigation must not wait on a
   * write or fail because one did.
   */
  void fetch('/api/view', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ view: v }) }).catch(() => {})

  // Fallback for older browsers without transition support
  if (!document.startViewTransition) {
    view = v
    for (const o of document.querySelectorAll('nav button[data-v]')) {
      o.setAttribute('aria-current', String(o.dataset.v === v))
    }
    render()
    return
  }

  // Trigger the View Transition API
  document.startViewTransition(() => {
    view = v

    // Updates the navigation state synchronously inside the transition frame
    for (const o of document.querySelectorAll('nav button[data-v]')) {
      o.setAttribute('aria-current', String(o.dataset.v === v))
    }

    // Executes the view rendering function
    render()
  })
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

/*
 * Show a status line that starts hidden.
 *
 * Two templates carry `<pre data-el="status" hidden>`, and the
 * `[hidden] { display: none !important }` backstop — added so a nav group could
 * actually be hidden — beats an inline `display: block`. So panels wrote their
 * messages into an element that stayed invisible: saving a scene worked, said
 * so, and showed nothing on screen.
 *
 * `hidden` is the state, and clearing it is the job. A helper because the
 * alternative is remembering it at a dozen call sites, and the failure is silent.
 */
const says = (node, text, level) => {
  if (!node) return
  node.hidden = false
  node.textContent = text
  tone(node, level)
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
      items.push({
        text: 'Use this folder',
        tag: 'choose',
        always: true,
        run: () => {
          input.value = d.path
          settle()
        },
      })
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
      items.push({
        text: file.name,
        tag,
        name: file.name,
        run: () => {
          input.value = file.path
          settle()
        },
      })
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
/*
 * The scene being edited, or null for the gallery.
 *
 * Scenes were a builder with a dropdown: everything a project held was behind a
 * `<select>` you had to open to discover, and a scene is a PICTURE — the one
 * thing a filename cannot tell you. The same shape the Library already uses for
 * projects, for the same reason.
 */
let openScene = null

let openProject = null

/*
 * What the last import said, carried across the re-render it triggered.
 *
 * A successful import reloads state and redraws the project page, which destroys
 * the element the result was just written into — so the page told you nothing and
 * the only evidence was a new card you had to notice. Same handover as
 * `pendingClip`: read and cleared by the panel on its next render.
 */
let importFlash = null
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
  const art = el('div', 'projcard__art')
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

  const grid = el('div', libView === 'grid' ? 'projgrid' : 'projgrid--list')

  for (const { p, f } of projects) {
    const card = el('div', 'projcard')
    card.append(cardArt(p, f))

    const cap = el('div', 'projcard__cap')
    cap.append(Object.assign(el('div', 'projcard__name'), { textContent: p.name }), Object.assign(el('div', 'projcard__client'), { textContent: p.client || 'No client' }))
    card.append(cap)

    const foot = el('div', 'projcard__foot')
    const summary = f.files.length ? [f.counts.video && `${f.counts.video} video`, f.counts.audio && `${f.counts.audio} audio`, f.counts.still && `${f.counts.still} still`].filter(Boolean).join(' · ') : 'empty'
    foot.append(Object.assign(el('div', 'projcard__when'), { textContent: `${summary}${f.bytes ? ' · ' + human(f.bytes) : ''}` }), Object.assign(el('div', 'projcard__when'), { textContent: 'Updated ' + ago(f.newest) }))
    card.append(foot)

    card.onclick = async () => {
      // Opening a project IS choosing it. Before, this only changed which page
      // you were looking at, so every panel behind the nav still belonged to
      // whichever project you last picked from the menu — or to none at all.
      openProject = p.id
      await chooseProject(p.id)
    }

    /*
     * The project's own actions, on the project.
     *
     * This lived in the toolbar of the project page, wedged after Re-index and
     * the media filters, where a lone kebab reads as a fifth filter rather than
     * a menu. A card in a list of things is where you look for what to do to one
     * of them — it is where an asset's menu already is, and deleting a project
     * is the same shape of decision one level up.
     *
     * `kind` is what makes it safe on the server: it refuses a project root
     * without one, so a mistyped path can never take a whole client's work.
     */
    card.append(
      actionMenu([
        {
          icon: 'delete-02',
          text: 'Delete project',
          danger: true,
          busy: 'Deleting…',
          run: async () => {
            const r = await (
              await fetch('/api/delete', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ path: S.libraryRoot + '/' + p.id, kind: 'project' }),
              })
            ).json()
            if (r.error) return r.error
            await load()
          },
        },
      ]),
    )
    card.style.cursor = 'pointer'
    grid.append(card)
  }

  /*
   * The only way to a new project, now that the nav item is gone.
   *
   * It was in both places, which put a permanent link to a form in the sidebar
   * beside the surfaces people actually work in. Starting a project belongs to
   * the page that lists them. Appended to `grid` rather than inside the grid
   * branch, so it is there in List view too.
   */
  const add = el('div', 'projcard projcard--new')
  const plus = el('div', 'projgrid__plus', '+')
  add.append(plus, Object.assign(el('div', 'projcard__name'), { textContent: 'New project' }))
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
      // The same words as the nav and the toolbar's unfiltered view. A trail that
      // calls one destination two things is a trail you stop reading.
      label: VIEW_LABEL.library,
      go: () => {
        openProject = null
        render()
      },
    },
    { label: p.name },
  ])
  /*
   * Everything the project holds, in one list.
   *
   * Scripts arrived as a second grid under a second heading, which said they
   * were a different KIND of thing — they are not, they are one of the things
   * this project has, and separating them meant the filter row above governed
   * half the page and silently ignored the rest.
   */
  const scripts = (S.scripts ?? []).filter((sc) => sc.project === p.id).map((sc) => ({ kind: 'script', script: sc, name: sc.name, mtime: sc.mtime ?? null }))
  const held = [...f.files, ...scripts]

  /*
   * A filter per kind the project actually holds, not a fixed four.
   *
   * The row listed video, audio and still whether or not any existed, and had no
   * way to say "script" at all — so a filter could hide everything and a kind
   * could be unfilterable. Derived from the contents, both stop being possible.
   */
  /*
   * The count is of everything held, because the grid below shows everything.
   *
   * It counted catalogued files only, which was right when scripts had their own
   * grid under their own heading and wrong the moment they joined this one — "2
   * files" over a grid of four is the page contradicting itself, and the reader
   * has no way to know which number is the lie.
   */
  m.append(
    el(
      'p',
      'lede',
      `${p.client || 'No client'} · ${p.brand} · ${held.length} item${held.length === 1 ? '' : 's'}${f.bytes ? ' · ' + human(f.bytes) : ''} · updated ${ago(f.newest)}`,
    ),
  )

  const KIND_ORDER = ['video', 'audio', 'still', 'script']
  const present = KIND_ORDER.filter((k) => held.some((x) => x.kind === k))
  // A filter that is no longer represented would leave the page empty with no
  // way back except a pill that is not there.
  if (kind && !present.includes(kind)) kind = ''

  const row = el('div', 'btn-group margin-y-md')
  for (const k of ['', ...present]) {
    const c = el('button', 'btn ghost btn--pill', k || 'All')
    c.type = 'button'
    c.setAttribute('aria-pressed', String(kind === k))
    c.onclick = () => {
      kind = k
      render()
    }
    row.append(c)
  }
  const re = el('button', 'btn ghost btn--pill', 'Re-index')
  re.onclick = async () => {
    re.disabled = true
    re.textContent = 'Indexing…'
    await fetch('/api/index/' + p.id, { method: 'POST' })
    await load()
  }
  row.append(re)

  /*
   * Bring in footage you already have.
   *
   * Recording and scripting both make video; there was no way to use video that
   * already existed, which is most of it — a client's screen recording, an old
   * export, something from Slack.
   *
   * This was a text box, a Browse button and a third button to confirm: three
   * controls, and the first of them asked you to TYPE the path of a file you
   * were already looking at in Finder. Nobody types a path. The Browse panel
   * existed because the text box could not be used, and the confirm button
   * existed because Browse only filled the text box in.
   *
   * One target instead. Drop files on it, or click it and pick them — and it
   * imports on drop, because choosing the file already said what to do with it.
   */
  const drop = el('button', 'dropzone')
  drop.type = 'button'
  const picker = Object.assign(el('input'), { type: 'file', multiple: true, accept: 'video/*,audio/*,image/*' })
  picker.hidden = true
  const dropHint = el('div', 'hint')
  drop.append(
    icon('upload-04'),
    Object.assign(el('span', 'dropzone__lead'), { textContent: 'Drop footage here' }),
    Object.assign(el('span', 'dropzone__sub'), { textContent: 'or click to choose — video, audio or stills' }),
  )

  /*
   * Bytes, not a path.
   *
   * A drop hands the page a file's CONTENTS; in a browser it cannot have the
   * location at all, and in the app the property that used to carry it is on its
   * way out of Electron. Sending the bytes is the one route that works in both.
   */
  const send = async (files) => {
    const list = [...files]
    if (!list.length) return
    drop.disabled = true
    let done = 0
    const failed = []
    for (const file of list) {
      tone(dropHint)
      dropHint.textContent = list.length > 1 ? `copying ${file.name} (${done + 1} of ${list.length})…` : `copying ${file.name}…`
      const r = await fetch(`/api/import/upload?project=${encodeURIComponent(p.id)}&name=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: file,
        // Streamed rather than buffered, for the same reason the server streams
        // it: a take can be gigabytes.
        duplex: 'half',
      })
        .then((x) => x.json())
        .catch((e) => ({ error: e.message }))
      if (r.error) failed.push(`${file.name}: ${r.error}`)
      else done++
    }
    drop.disabled = false
    importFlash = failed.length
      ? { level: done ? 'warn' : 'bad', text: (done ? `Added ${done}. ` : '') + failed.join(' · ') }
      : { level: 'ok', text: `Added ${done} file${done === 1 ? '' : 's'} — the originals are left where they are.` }
    // Reloading redraws this panel and takes `dropHint` with it, so the message
    // is handed over rather than written here.
    await load()
  }

  drop.onclick = () => picker.click()
  picker.onchange = () => {
    /*
     * Copied out before the input is cleared.
     *
     * `picker.files` is a LIVE FileList over the input, not a snapshot — so
     * clearing `value` to allow re-picking the same file emptied the very list
     * just taken from it, and the import silently did nothing. Clearing matters:
     * without it, choosing the same file twice fires no change event at all and
     * the second attempt looks like the page ignoring you.
     */
    const files = [...picker.files]
    picker.value = ''
    send(files)
  }

  // Both of these, on both handlers: without preventDefault the browser navigates
  // away from the app to display the file you dropped.
  for (const ev of ['dragenter', 'dragover']) {
    drop.addEventListener(ev, (e) => {
      e.preventDefault()
      drop.classList.add('dropzone--over')
    })
  }
  for (const ev of ['dragleave', 'drop']) {
    drop.addEventListener(ev, () => drop.classList.remove('dropzone--over'))
  }
  drop.addEventListener('drop', (e) => {
    e.preventDefault()
    send(e.dataTransfer?.files ?? [])
  })

  if (importFlash) {
    tone(dropHint, importFlash.level)
    dropHint.textContent = importFlash.text
    importFlash = null
  }

  const importWrap = el('div', 'full')
  importWrap.append(drop, picker, dropHint)
  m.append(importWrap)
  m.append(row)
  m.append(Object.assign(el('div', 'path'), { textContent: S.libraryRoot + '/' + p.id }))

  /*
   * The scripts belong to the project too.
   *
   * They were invisible here: `buildCatalog` only walks media extensions under
   * media/, and a script lives in <project>/scripts/*.md — so a project holding
   * a finished narration script and no footage read as empty, and the one place
   * you go to see what a project HAS showed you everything except the words.
   *
   * Listed rather than indexed, deliberately. Adding .md to the catalogue would
   * put scripts into `f.counts`, `f.bytes` and every kind filter — including
   * Cut's footage shelf, which asks the catalogue for video and would then have
   * to learn to ignore a kind it never expected.
   */
  const shown = held.filter((x) => !kind || x.kind === kind)
  if (!shown.length) {
    m.append(el('p', 'empty', held.length ? 'Nothing of that kind here.' : 'Nothing here yet. Record into it, or drop footage in ' + p.id + '/media.'))
    return
  }
  /*
   * Newest first, whatever it is.
   *
   * One order across both, rather than scripts-then-footage: the reason to lump
   * them together is that what you want is usually what you touched last, and
   * that is not a property of which kind it is. Anything with no timestamp sorts
   * after the things that have one rather than jumping to the top.
   */
  const when = (x) => x.mtime ?? ''
  const g = el('div', 'grid')
  for (const x of [...shown].sort((a, b) => String(when(b)).localeCompare(String(when(a))))) {
    g.append(x.kind === 'script' ? scriptCard(p, x.script) : fileCard(p, x))
  }
  // After the cards, because it counts what they registered.
  paintPickBar()
  m.append(g)
}

/*
 * What is picked, and the one thing to do with it.
 *
 * In the footer rather than floating over the grid, because that is where this
 * app puts a primary action — and because a bar that overlays the shelf covers
 * the cards you are still choosing from.
 *
 * Rebuilt rather than mutated: the count, the wording and whether it is there at
 * all are all functions of the same Set, and keeping one of them in sync by hand
 * is how they drift.
 */
function paintPickBar() {
  const footer = $('.op-page__main-footer')
  if (!footer) return
  footer.querySelector('.pickbar')?.remove()
  if (!chosenAssets.size) {
    if (!footer.firstElementChild) footer.classList.remove('panel-actions')
    return
  }

  const bar = el('div', 'pickbar')
  const n = chosenAssets.size
  bar.append(Object.assign(el('span', 'status'), { textContent: `${n} asset${n === 1 ? '' : 's'} picked` }))

  const clear = el('button', 'btn ghost', 'Clear')
  clear.onclick = () => {
    chosenAssets.clear()
    render()
  }

  const make = el('button', 'btn', 'Make a video from these')
  make.onclick = () => {
    // Straight to the script tab: picking the footage has already answered the
    // question the New video chooser asks.
    createTab = 'make'
    go('create')
  }

  bar.append(clear, make)
  footer.append(bar)
  footer.classList.add('panel-actions')
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
/**
 * The actions on a card, behind one button.
 *
 * A card used to carry a red Delete and nothing else — so the only thing it
 * offered was the one thing you cannot undo, sitting there at full size next to
 * things you might actually want. The rest were not missing so much as unreachable:
 * opening in the editor was a click on the card, and sending for review meant
 * finding the Review panel and naming the file again.
 *
 * `items` is [{ icon, text, run, danger }]. A danger item arms rather than fires,
 * because a menu that deletes on first click is worse than a button that does — at
 * least the button was obviously a button.
 */
function actionMenu(items) {
  const wrap = el('div', 'kebab')

  const trigger = el('button', 'kebab__trigger')
  trigger.type = 'button'
  trigger.setAttribute('aria-haspopup', 'menu')
  trigger.setAttribute('aria-expanded', 'false')
  trigger.setAttribute('aria-label', 'Actions')
  trigger.title = 'Actions'
  trigger.append(icon('more-vertical'))

  const menu = el('div', 'kebab__menu')
  menu.setAttribute('role', 'menu')
  menu.hidden = true

  const close = () => {
    menu.hidden = true
    trigger.setAttribute('aria-expanded', 'false')
    // Disarm on the way out, so a menu reopened later does not start armed.
    for (const b of menu.querySelectorAll('.kebab__item--armed')) {
      b.classList.remove('kebab__item--armed')
      b.querySelector('.kebab__text').textContent = b.dataset.text
    }
  }

  for (const it of items) {
    const b = el('button', 'kebab__item' + (it.danger ? ' kebab__item--danger' : ''))
    b.type = 'button'
    b.setAttribute('role', 'menuitem')
    b.dataset.text = it.text
    b.append(icon(it.icon), Object.assign(el('span', 'kebab__text'), { textContent: it.text }))
    b.onclick = async (e) => {
      // The card underneath opens the file; none of these are that.
      e.stopPropagation()
      if (it.danger && !b.classList.contains('kebab__item--armed')) {
        b.classList.add('kebab__item--armed')
        b.querySelector('.kebab__text').textContent = 'Click again to confirm'
        setTimeout(() => {
          if (!b.isConnected) return
          b.classList.remove('kebab__item--armed')
          b.querySelector('.kebab__text').textContent = it.text
        }, DISARM_MS)
        return
      }
      const label = b.querySelector('.kebab__text')
      label.textContent = it.busy ?? 'Working…'
      const err = await it.run()
      if (err) {
        // Reported in place: the card may be gone by the time anything else could
        // show it, and a menu that closes on failure says it worked.
        b.classList.remove('kebab__item--armed')
        label.textContent = String(err).slice(0, 48)
        return
      }
      close()
    }
    menu.append(b)
  }

  trigger.onclick = (e) => {
    e.stopPropagation()
    const open = menu.hidden
    menu.hidden = !open
    trigger.setAttribute('aria-expanded', String(open))
  }
  wrap.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) {
      e.stopPropagation()
      close()
      trigger.focus()
    }
  })
  document.addEventListener('pointerdown', (e) => {
    if (!menu.hidden && !wrap.contains(e.target)) close()
  })

  wrap.append(trigger, menu)
  return wrap
}

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

/*
 * A script, as a card in the project.
 *
 * Same shape as a footage card so the project page reads as one shelf of things
 * the project holds rather than two lists with different rules. What differs is
 * what you can do with it: a script is read, spoken, or handed to the panel that
 * turns it into a video.
 */
function scriptCard(project, sc) {
  const c = el('div', 'card')
  const tw = el('div', 'thumbwrap')
  const t = el('div', 'thumb')
  t.style.cssText = 'display:grid;place-items:center;background:var(--sunk)'
  t.append(icon('file-01', 'scriptcard__icon'))
  tw.append(t, el('span', 'kind', 'script'))
  const b = el('div', 'body')
  b.append(el('div', 'nm', sc.name))
  /*
   * The same estimator the demo builder uses, not a second one.
   *
   * A first pass here divided by a words-per-minute figure written out on the
   * spot. That is the drift `and never its own copy of it` exists to stop: the
   * rate lives in lib/demo-script.mjs, the page already imports it, and two
   * estimates of how long a script takes to say WILL disagree — at which point
   * the project page and the demo builder quote different numbers for the same
   * words and neither is obviously wrong.
   *
   * Fenced blocks are actions rather than narration, and a /directive is a
   * setting, so neither is counted as something to be read aloud.
   */
  const spoken = String(sc.body ?? '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^\s*\/\w+.*$/gm, '')
  const words = spoken.split(/\s+/).filter(Boolean).length
  const secs = Math.round(speechHold(spoken) / 1000)
  b.append(Object.assign(el('div', 'path'), { textContent: `scripts/${sc.name}.md${words ? ` · ${words} words${secs ? ` · ~${clock(secs)}` : ''}` : ''}` }))
  c.append(tw, b)

  c.append(
    actionMenu([
      {
        icon: 'text-align-left',
        text: 'Open in Scripts',
        run: () => {
          pendingScript = sc.name
          go('scripts')
        },
      },
      {
        icon: 'comment-01',
        text: 'Record the narration',
        run: () => {
          pendingScript = sc.name
          go('voice')
        },
      },
      {
        icon: 'add-01',
        text: 'Make a video from it',
        run: () => {
          pendingScript = sc.name
          // Straight to the script tab, not to the chooser: the choice of how to
          // start has already been made by picking a script.
          createTab = 'make'
          go('create')
        },
      },
    ]),
  )
  return c
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
   * A document whose video is gone opens to an empty editor, which looks exactly
   * like the editor losing it. Stop here rather than hand it over: the two need
   * different responses, and the caller can only say so while the Studio is still
   * the thing on screen.
   */
  if (r.mediaProblem) return { ...r, error: r.mediaProblem }

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

  /*
   * Pickable, because a video is usually made from several of these.
   *
   * The only way to hand project media to the AI step was two single-selects on
   * the Make form — one webcam clip, one audio file, no stills at all. So "use
   * these four clips and this voiceover" could not be said, and the panel that
   * builds a video could not see most of what the project held.
   *
   * A checkbox rather than clicking the card, because the card already opens the
   * file: one gesture cannot mean both, and making a click mean "select" would
   * take away the thing people already do with it.
   */
  const pickBox = Object.assign(el('input', 'card__pick'), { type: 'checkbox', checked: chosenAssets.has(f.rel) })
  pickBox.title = 'Use this in a video'
  pickBox.setAttribute('aria-label', `Use ${f.name} in a video`)
  pickBox.onclick = (e) => e.stopPropagation()
  pickBox.onchange = () => {
    if (pickBox.checked) chosenAssets.add(f.rel)
    else chosenAssets.delete(f.rel)
    c.classList.toggle('card--picked', pickBox.checked)
    paintPickBar()
  }
  if (pickBox.checked) c.classList.add('card--picked')
  c.append(pickBox)

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
  /*
   * Everything you can do to an asset, behind one button.
   *
   * This was a red Delete and nothing else, at full size — the one irreversible
   * action given the most weight on the card, with the useful ones either hidden
   * in a card click or in another panel entirely.
   *
   * There is no separate "Edit with AI": the editor's chat is open by default
   * (`chatOpen = useState(true)` in NewEditorShell), so it would be the same
   * destination under a second name.
   */
  b.append(
    actionMenu([
      {
        icon: 'pencil-edit-02',
        text: 'Edit',
        busy: 'Opening…',
        run: async () => {
          const r = await openDocument({ projectId: project.id, rel: f.rel })
          return r?.error
        },
      },
      {
        icon: 'share-08',
        text: 'Send for review',
        busy: 'Sending…',
        run: async () => {
          const r = await (
            await fetch('/api/review/send', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ projectId: project.id, rel: f.rel }),
            })
          ).json()
          if (r.error) return r.error
          go('review')
        },
      },
      {
        icon: 'scissor-01',
        text: 'Reuse in a cut',
        run: () => {
          // Handed over rather than navigated to and re-found: Cut reads this on
          // render, so the clip is already on the list when the panel appears.
          pendingClip = { rel: f.rel }
          go('cut')
        },
      },
      {
        icon: 'delete-02',
        text: 'Delete',
        danger: true,
        busy: 'Deleting…',
        run: async () => {
          const r = await (
            await fetch('/api/delete', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              // project + rel, not a hand-built path: media lives under `media/`
              // and this side should not have to know that. Building it here
              // produced `<library>/<id>/Footage/demo.mp4` and a "no such file"
              // for something plainly on disk.
              body: JSON.stringify({ projectId: project.id, rel: f.rel }),
            })
          ).json()
          if (r.error) return r.error
          await load()
        },
      },
    ]),
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
      note.append(el('p', null, 'OpenFrame is where a client leaves timestamped notes on a video. It runs itself — bring it up with Docker, then point this at it.'))
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
    const projName = mk('OpenFrame project', Object.assign(el('input'), { placeholder: 'Ridgeline Railing' }), 'Created if it does not exist. Re-sending into the same one adds a version rather than a duplicate.')
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
           * `.projcard__art` is the library's own card art, so a review card and a project
           * card read as the same kind of object. A video whose thumbnail file was
           * never generated just shows the sunk panel behind it.
           */
          if (v.thumbnail && v.versionId) {
            const art = el('div', 'projcard__art')
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
          const facts = [v.version ? 'v' + v.version + (v.versions > 1 ? ' of ' + v.versions : '') : null, v.comments ? v.comments + ' comment' + (v.comments === 1 ? '' : 's') : 'no comments yet', v.duration ? Math.round(v.duration) + 's' : null].filter(Boolean)
          b.append(Object.assign(el('div', 'nm'), { textContent: v.title }), Object.assign(el('div', 'path'), { textContent: p.workspace + ' · ' + p.name }), Object.assign(el('div', 'path'), { textContent: facts.join(' · ') }))

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
            if (r.unresolved != null) bits.push(r.unresolved ? r.unresolved + ' open of ' + r.total : r.total ? 'all ' + r.total + ' dealt with' : 'no notes yet')
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
  { verb: 'type', label: 'Type into a field', fields: [{ ph: 'Project name' }, { ph: 'Ridgeline Deck Rail' }], hint: 'The field first, then what to type into it.' },
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
/*
 * Which rows demoStepsToScript would drop, and why.
 *
 * The compiler skips any row with a blank field — quietly, because a half-filled
 * row mid-edit is normal and complaining on every keystroke would be worse. But
 * quiet is wrong the moment someone asks for the steps explicitly: the count they
 * see is the number of rows, the script gets nothing, and the builder looks
 * broken rather than incomplete.
 *
 * Returns [{ index, missing }] so a message can name the row and the field.
 */
function demoStepsIncomplete(rows) {
  const out = []
  rows.forEach((r, index) => {
    const action = DEMO_ACTIONS.find((a) => a.verb === r.verb)
    if (!action) {
      out.push({ index, action: 'no action chosen', missing: 'an action' })
      return
    }
    /*
     * Named by the action, not by the field's placeholder. A placeholder is
     * example text — "/quotes/new  or  https://app.example.com/quotes/new" —
     * and quoting it back reads as a demand for that literal string.
     */
    const blanks = action.fields.filter((f, i) => !String(r.args[i] ?? '').trim()).length
    if (blanks) out.push({ index, action: action.label, missing: blanks === action.fields.length && blanks > 1 ? 'its values' : 'a value' })
  })
  return out
}

function demoStepsToScript(rows) {
  const out = []
  for (const r of rows) {
    const action = DEMO_ACTIONS.find((a) => a.verb === r.verb)
    if (!action) continue
    const args = action.fields.map((f, i) => String(r.args[i] ?? '').trim())
    if (args.some((a) => !a)) continue
    const say = String(r.say ?? '').trim()
    if (say) out.push(say, '')
    /*
     * Bare, unless the value has a space in it.
     *
     * A URL and a key are written without quotes, which reads better and is what
     * the parser expects — right up to the moment somebody pastes an address
     * with a space in it. Then the builder emits `goto https://x/a b`, the
     * parser sees two arguments, and the panel reports that `goto` takes one:
     * a complaint about a rule the author was following, caused by a line they
     * never wrote.
     *
     * The parser already accepts a quoted value for these, so quoting when it
     * matters costs nothing and only shows up where it has to.
     */
    const bare = (r.verb === 'goto' || r.verb === 'press' || action.fields[0].num) && !/\s/.test(args[0])
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
 * Put the rows into a script that someone has already touched.
 *
 * The builder only ever wrote the whole box, and only while nobody had typed in
 * it — one keystroke latched `handEdited` and from then on the steps compiled
 * into nothing. Typing in that box became the normal thing to do the moment it
 * grew slash commands, so the common path was: add steps, add a `/brand` line,
 * hit go, and get "the script has no ```do block" about work that was right
 * there on screen.
 *
 * Directives are settings and the body is generated, so this keeps the leading
 * directive lines and replaces the rest. Explicit, because silently rewriting
 * something a person typed is the failure this is fixing, not a smaller version
 * of it.
 */
function mergeStepsIntoScript(current, rows) {
  const body = demoStepsToScript(rows)
  const lines = String(current ?? '').split('\n')
  const head = []
  for (const line of lines) {
    // Same shape lib/script-parse.mjs skips by, so the two agree on what a
    // directive is without either importing the other's list.
    if (/^\s*\/[a-z][a-z-]*(\s|$)/i.test(line)) head.push(line.trim())
    else if (line.trim() === '' && head.length) continue
    else break
  }
  return head.length ? head.join('\n') + '\n\n' + body : body
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
      const up = el('button', 'btn btn--small ghost')
      up.append(icon('arrow-up-01'))
      up.setAttribute('aria-label', 'Move this step earlier')
      up.title = 'Move earlier'
      const down = el('button', 'btn btn--small ghost')
      down.append(icon('arrow-down-01'))
      down.setAttribute('aria-label', 'Move this step later')
      down.title = 'Move later'
      const kill = el('button', 'btn btn--small ghost')
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
    /** A copy, so a caller compiling them into a script cannot edit them by accident. */
    rows: () => rows.map((r) => ({ ...r, args: [...(r.args ?? [])] })),
    count: () => rows.length,
  }
}

/* ── New project ─────────────────────────────────────────── */
function vNew(m) {
  const ui = mountPanel('new', m)
  const { name, client, brand, store, bucket, status, go } = ui

  for (const p of S.presets) brand.append(Object.assign(el('option', null, p.label), { value: p.id }))
  store.append(Object.assign(el('option', null, 'Local folder (no bucket)'), { value: 'local' }))
  for (const r of S.remotes) store.append(Object.assign(el('option', null, 'rclone: ' + r), { value: r }))

  go.onclick = async () => {
    go.disabled = true
    const r = await (
      await fetch('/api/project', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name.value,
          client: client.value,
          brand: brand.value,
          remote: store.value === 'local' ? 'local' : 's3',
          bucket: bucket.value,
        }),
      })
    ).json()
    go.disabled = false
    status.hidden = false
    status.textContent = r.error ? 'Error: ' + r.error : `Created  ${r.project.id}\n${S.libraryRoot}/${r.project.id}/media/\n\nFootage/ and Renders/ are ready. Drop files in, then Library → Re-index.`
    if (!r.error) await load()
  }
}

/* ── Make a video ────────────────────────────────────────── */
// A Make run moves to Console so its live output is visible. Keep the plan while
// this Studio window stays open so its manual template actions are still there
// when you come back to review or render it.
let latestMakePlan = null

function vMake(m) {
  /*
   * The script is the work; everything else is a setting.
   *
   * Sixteen fields in one column meant the box you actually write in sat
   * somewhere in the middle of them, and "Build the brief" was below all sixteen
   * — you scrolled past the whole form to reach the one button, then scrolled
   * back to see what you had written. Brand, voice, motion, the title card, the
   * webcam and the audio are dials: they have defaults, and you touch them once.
   *
   * So: the script in main, the dials in the rail, the action in the footer.
   * `f` stays the name the rest of this function uses for the main column, and
   * `rail` is the new one — the fields move by changing which container they are
   * handed, not by being rewritten.
   */
  const f = el('div', 'form')
  const rail = el('div', 'form')
  const mk = (l, n, hint) => field(rail, l, n, hint)
  /*
   * The project is the space you are in, not a field on this form.
   *
   * Kept as a shape with a `.value` getter because everything below reads it that
   * way — the fetches, the saves, the file lists. Replacing the select with the
   * ambient answer is the whole change; the rest of the panel never learns that
   * the question moved to the header.
   */
  const proj = {
    get value() {
      return currentProject() ?? ''
    },
  }
  const brand = mk('Brand', el('select'))
  for (const p of S.presets) brand.append(Object.assign(el('option', null, p.label), { value: p.id }))
  const output = mk('Output', el('select'), 'A video asks Claude to render now. A HyperFrames template gives you a reviewable source project; render it only when you are ready.')
  for (const [value, label] of [
    ['video', 'Video — render in Claude'],
    ['template', 'HyperFrames template — review first'],
  ]) {
    output.append(Object.assign(el('option', null, label), { value }))
  }
  const title = mk('Title', Object.assign(el('input'), { placeholder: 'Website launch promo' }))
  const secs = mk('Seconds', Object.assign(el('input'), { type: 'number', value: 20, min: 5, max: 180 }))
  /*
   * Which script to build from.
   *
   * Scoped to the chosen project plus the shared shelf, and keyed by index rather
   * than by name. Both matter: the list carried every project's scripts, two of
   * them were called `intro`, and the lookup matched on name — so picking the
   * second silently loaded the first one's words. A picker that hands over
   * different content than the line you clicked is worse than no picker.
   */
  const pick = mk('Script', el('select'), 'A saved script from this project, or the shared shelf. Choosing one fills the box in the main column, which you can still edit.')
  /*
   * The script box fills the screen, because the script is the panel.
   *
   * Every textarea here is `--field-tall` — about 26 lines — which is right for a
   * field among other fields and wrong for the only field in the column. A script
   * is hundreds of words, so writing one meant scrolling a small window inside a
   * page that had nothing else in it.
   *
   * Now that the settings moved to the rail, main holds the picked assets and
   * this; letting it grow costs nothing and is what the space is for.
   */
  const src = el('textarea', 'fills')
  src.placeholder = 'https://rolemodelsoftware.com\n\n— or paste a script —'
  const fillScripts = () => {
    const held = pick.value
    pick.innerHTML = ''
    pick.append(Object.assign(el('option', null, '— write it below —'), { value: '' }))
    S.scripts.forEach((sc, i) => {
      if (sc.project && sc.project !== proj.value) return
      pick.append(Object.assign(el('option', null, sc.name + (sc.project ? '' : ' · shared')), { value: String(i) }))
    })
    if ([...pick.options].some((o) => o.value === held)) pick.value = held
  }
  fillScripts()
  // No change handler: switching project reloads state and re-renders this panel.
  pick.onchange = () => {
    const sc = S.scripts[Number(pick.value)]
    if (sc) src.value = sc.body
  }

  /*
   * A script the project page sent here, chosen and loaded on arrival.
   *
   * Matched by INDEX, not by name, for the reason the picker itself is keyed
   * that way: two projects can hold a script called `intro`, and a lookup by
   * name loads the wrong one's words. Cleared as it is read.
   */
  if (pendingScript) {
    const want = pendingScript
    pendingScript = null
    const i = S.scripts.findIndex((sc) => sc.name === want && sc.project === (currentProject() ?? null))
    if (i >= 0) {
      pick.value = String(i)
      pick.onchange()
    }
  }
  /*
   * The footage this video is being made from.
   *
   * In main above the script, because it is material rather than a setting — and
   * because the alternative was two single-selects in the rail that between them
   * could name one video and one audio file and no stills at all. A project's
   * assets are what the video is OF; there was no way to say "these four".
   *
   * Shown as a list you can drop from, not a picker: they were chosen on the
   * project page against thumbnails, and re-choosing them here from filenames
   * would be the worse half of the same job.
   */
  const picked = el('div', 'full')
  const paintPicked = () => {
    picked.innerHTML = ''
    if (!chosenAssets.size) return
    const proj2 = S.projects.find((x) => x.id === proj.value)
    const byRel = new Map((proj2?.catalog?.files ?? []).map((x) => [x.rel, x]))
    const group = el('div', 'form-group')
    group.append(el('label', 'form-label', `Using ${chosenAssets.size} asset${chosenAssets.size === 1 ? '' : 's'} from this project`))
    const list = el('div', 's3list')
    for (const rel of chosenAssets) {
      const file = byRel.get(rel)
      const row = el('div', 's3row')
      row.append(
        icon(file?.kind === 'audio' ? 'comment-01' : file?.kind === 'still' ? 'image-01' : 'video-01', 's3row__icon'),
        Object.assign(el('span', 's3row__name'), { textContent: file?.name ?? rel }),
        Object.assign(el('span', 's3row__meta'), { textContent: file ? `${file.kind}${file.media?.durationSec ? ' · ' + dur(file.media.durationSec) : ''}` : 'missing' }),
      )
      const drop = Object.assign(el('button', 'btn ghost'), { textContent: 'Remove', type: 'button' })
      drop.onclick = () => {
        chosenAssets.delete(rel)
        paintPicked()
      }
      row.append(drop)
      list.append(row)
    }
    group.append(list, Object.assign(el('div', 'form-hint'), { textContent: 'Named in the brief, so the composition can use them by path rather than inventing placeholders.' }))
    picked.append(group)
  }
  paintPicked()
  f.append(picked)

  // The only field that is not a setting, so the only one that stays in main.
  field(f, 'Script or URL', src, 'Paste a script, or a URL to build one from. Type / for a setting — brand, voice, motion, title. The Script picker in the rail fills this in.')
  /*
   * Slash commands here too, and this is the field where they matter most.
   *
   * /api/make reads its settings out of this text before it reads the panel, so a
   * directive typed here decides the render. The menu was only on the script editor,
   * which meant the one place the document actually drives a video was the one place
   * that would not help you write it.
   *
   * A URL is left alone by the parser, so pasting one is unaffected.
   */
  slashField(src, () => proj.value)

  // Direction. Claude cannot see this panel, so each of these becomes a sentence
  // in the prompt — see /api/make.
  const bg = mk('Background', el('select'), 'The backdrop behind the scene. Edit these under Wallpapers.')
  bg.append(Object.assign(el('option', null, 'No wallpaper — flat brand colour'), { value: 'none' }))
  for (const w of S.wallpapers) bg.append(Object.assign(el('option', null, w.label), { value: w.file }))

  /*
   * The title card.
   *
   * Left empty there is no card at all, which is the right default for a promo cut
   * from a URL. Filled in, /api/make stages the brand into the render directory and
   * points Claude at title.html — the marks, the vendored faces and the tokens are
   * already wired together in it, which is the part that was missing when "use our
   * brand" was only a sentence in a prompt.
   */
  const titleCard = mk('Title card', Object.assign(el('input'), { placeholder: 'Estimating a curved railing' }), 'The words on the opening card. Leave empty for no title card.')
  const eyebrow = mk('Eyebrow', Object.assign(el('input'), { placeholder: 'RIDGELINE · WALKTHROUGH' }), 'Small mono label above the title. The client or the series, not a second headline.')

  /*
   * Footage and sound the render should use rather than invent.
   *
   * Both are files already in the project, because that is where a capture lands.
   * Offering a path field instead would mean typing one, and a typo becomes a
   * render that silently omits the thing you asked for.
   */
  const webcam = mk('Webcam clip', el('select'), 'Composited as a circular picture-in-picture, lower right — the same treatment as a recording.')
  const audio = mk('Audio', el('select'), 'A recorded voiceover, or a music bed. Narration set here is used instead of synthesising a voice.')
  const audioRole = mk('Use the audio as', el('select'), 'Narration is timed against; a music bed sits under and ducks.')
  for (const [v, l] of [
    ['narration', 'Narration — the spoken track'],
    ['music', 'Music bed — under everything'],
  ]) {
    audioRole.append(Object.assign(el('option', null, l), { value: v }))
  }

  /* Repopulated whenever the project changes: another project's files are not
     options here, and leaving stale ones listed is how the wrong clip gets used. */
  /*
   * A control with nothing to offer says so.
   *
   * Both of these list files from the chosen project, and a project with no video in
   * it produced a select whose only entry was "No webcam" — enabled, clickable and
   * silent about why. An empty list is not a choice, it is a missing input, so the
   * option states the reason and the control is disabled. "Unavailable" should never
   * be something you have to infer.
   */
  const fillClips = () => {
    const p = S.projects.find((x) => x.id === proj.value)
    const files = p?.catalog?.files ?? []
    for (const [sel, kind, none, what] of [
      [webcam, 'video', 'No webcam', 'video'],
      [audio, 'audio', 'No audio', 'audio'],
    ]) {
      const keep = sel.value
      const mine = files.filter((f) => f.kind === kind)
      sel.innerHTML = ''
      if (!mine.length) {
        sel.append(Object.assign(el('option', null, `No ${what} in this project yet`), { value: '' }))
        sel.disabled = true
        continue
      }
      sel.disabled = false
      sel.append(Object.assign(el('option', null, none), { value: '' }))
      for (const f of mine) sel.append(Object.assign(el('option', null, f.name), { value: f.rel }))
      if ([...sel.options].some((o) => o.value === keep)) sel.value = keep
    }
    audioRole.disabled = !audio.value
  }
  audio.onchange = () => {
    audioRole.disabled = !audio.value
  }
  // No change handler: switching project reloads state and re-renders this panel.
  fillClips()

  /*
   * Narration voice.
   *
   * The render's voiceover is `hyperframes tts`, which is Kokoro on this machine —
   * the same synthesiser the Voice page uses. But this panel never named a voice,
   * so Claude picked whatever the skill defaults to and a render came back in a
   * voice nobody chose. The list is read from Kokoro rather than hardcoded, for
   * the reason /api/voices exists: the built-in list has been wrong before.
   */
  const vo = mk('Narration voice', el('select'), 'Read from Kokoro on this machine. Nothing is sent anywhere and there is nothing to pay for.')
  const voHint = el('div', 'hint')
  fieldRow(f, voHint)
  vo.append(Object.assign(el('option', null, 'No voiceover — silent render'), { value: '' }))
  ;(async () => {
    const d = await (await fetch('/api/voices?provider=kokoro')).json().catch(() => ({ from: 'none', voices: [] }))
    for (const v of d.voices) vo.append(Object.assign(el('option', null, v.label), { value: v.id }))
    tone(voHint, d.from === 'kokoro' ? null : 'bad')
    if (d.from === 'kokoro') {
      voHint.textContent = d.voices.length + ' voices, read from Kokoro. Pick one and the render is narrated in it.'
      // A render nobody chose a voice for used to be the common case. Default to a
      // voice, not to silence — silence is still one click away above.
      const first = d.voices[0]
      if (first) vo.value = first.id
    } else {
      voHint.textContent = (d.note || 'Kokoro would not list its voices') + ' Leave this on "No voiceover", or set the voice up under Voice.'
    }
  })()

  // Motion. The panel names a preset; /api/make turns it into the sentences that
  // actually reach Claude (brand/motion.json). Without this the model chose its own
  // easing every run, so no two renders moved alike.
  const mo = mk('Motion', el('select'), 'How things move. Brand is the design system\u2019s own signature \u2014 short, eased, nothing bouncy.')
  const moPresets = S.motion?.presets?.length ? S.motion.presets : [{ id: 'brand', label: 'Brand \u2014 Optics motion' }]
  for (const m of moPresets) mo.append(Object.assign(el('option', null, m.label), { value: m.id }))
  mo.value = S.motion?.default || moPresets[0].id

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
  fieldRow(rail, opts2)
  const urlField = mk('Shown in the chrome', chromeUrl, 'The URL drawn in the fake address bar. Only used with browser chrome.')
  chromeUrl.disabled = true
  // The one thing this panel is for, so the one thing in the footer. The Run
  // button that appears after a build joins it in `runSlot`, beside it rather
  // than somewhere down the page.
  const go = el('button', 'btn', 'Build the brief')
  const actions = el('div', 'row')
  const runSlot = el('span')
  actions.append(go, runSlot)
  // The argv belongs with the buttons but not between them; a .runrow holding
  // only the command gives it the same mono treatment it has everywhere else.
  const runHere = el('div', 'full')
  const out = el('div', 'full')
  // The argv and the prompt are what the run LEAVES behind, so they stay in main
  // under the script. Only the buttons go to the footer.
  f.append(runHere, out)
  const showPlan = (r) => {
    out.innerHTML = ''
    runHere.innerHTML = ''
    runSlot.innerHTML = ''
    if (r.error) {
      out.append(Object.assign(el('pre'), { textContent: 'Error: ' + r.error }))
      return
    }
    const runBtn = el('button', 'btn', r.output === 'template' ? 'Ask Claude for the template' : 'Run it in Claude')
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
    if (r.output === 'template') {
      const next = el('div', 'note full', 'Claude writes the template first. When that job has finished, check it, then render when you are happy with the direction.')
      const templateActions = el('div', 'row')
      const checkBtn = el('button', 'btn ghost', 'Check the template')
      checkBtn.onclick = () => start(r.lintStep)
      const renderBtn = el('button', 'btn ghost', 'Render the template')
      renderBtn.onclick = () => start(r.renderStep)
      templateActions.append(checkBtn, renderBtn)
      out.append(next, templateActions, Object.assign(el('div', 'path'), { textContent: 'template  ' + r.template }))
    }
  }
  go.onclick = async () => {
    const on = (b) => b.getAttribute('aria-pressed') === 'true'
    const r = await (
      await fetch('/api/make', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId: proj.value,
          brand: brand.value,
          title: title.value,
          seconds: secs.value,
          source: src.value,
          wallpaper: bg.value,
          browser: on(cBrowser),
          browserUrl: chromeUrl.value.trim(),
          captions: on(cCaps),
          motion: mo.value,
          voice: vo.value,
          titleCard: titleCard.value.trim(),
          eyebrow: eyebrow.value.trim(),
          output: output.value,
          // Everything picked on the project page, so the brief can name real
          // files instead of the model inventing placeholders for them.
          assets: [...chosenAssets],
          webcam: webcam.value,
          audio: audio.value,
          audioRole: audioRole.value,
        }),
      })
    ).json()
    latestMakePlan = r.error ? null : r
    showPlan(r)
  }
  if (latestMakePlan) showPlan(latestMakePlan)
  m.append(f)
  intoRail(rail)
  intoFooter(actions)
}

/* ── New video ────────────────────────────────────────────────
   Three ways into a video, on one page. They were three sidebar entries, which
   made them look like unrelated features rather than three inputs to the same
   pipeline: capture a screen, build from a script or URL, or cut from a test.
   The tab survives a re-render so a poll cannot bounce you back to the first. */
let createTab = null

/*
 * A clip handed from the Library to Cut.
 *
 * "Reuse in a cut" has to name a file to a panel that has not rendered yet, and
 * navigating and then hunting for it in a shelf is the thing being avoided. Read
 * and cleared by vCut on its next render, so it cannot linger and add the same
 * clip twice.
 */
let pendingClip = null

const CREATE_TABS = [
  ['record', 'Record a screen'],
  ['make', 'Make from a script'],
  ['recast', 'From a test'],
]

function vCreate(m) {
  const { chooser, host } = mountPanel('create', m)

  const paint = () => {
    host.innerHTML = ''
    /*
     * The chooser and the panel are not both on screen.
     *
     * They were: a row of chips above whichever panel was active, so the choice
     * and the work competed for the same space and the two you had not picked sat
     * there taking width. Picking one replaces the chooser, and the breadcrumb is
     * the way back — which is the trail doing its job rather than a second row of
     * navigation doing it badly.
     */
    chooser.hidden = Boolean(createTab)
    if (!createTab) {
      crumbs([{ label: 'New video' }])
      clearPanelRegions()
      return
    }
    crumbs([
      {
        label: 'New video',
        go: () => {
          createTab = null
          paint()
        },
      },
      { label: CREATE_TABS.find(([id]) => id === createTab)?.[1] ?? createTab },
    ])
    /*
     * The chosen panel renders into `host`, and clears the shared slots first.
     *
     * These three are full panels with their own config and actions, so switching
     * has to empty Optics' sidebar and footer the way render() does — without it
     * the previous one's fields and buttons stay on screen, wired to a form that is
     * no longer there.
     */
    clearPanelRegions()
    ;({ record: vRecord, make: vMake, recast: vRecast })[createTab](host)
  }

  for (const card of chooser.querySelectorAll('.choose-card')) {
    card.onclick = () => {
      createTab = card.dataset.tab
      paint()
    }

    /*
     * A picture that does not arrive leaves a hole, not a clue.
     *
     * These are decorative — the card says what it is right underneath — so the
     * alt text is empty, and an empty alt on a broken image renders as nothing
     * at all. Three cards with a blank 12rem gap above the words is exactly what
     * a stale or partial install looks like, and it looks like a bug in the
     * layout rather than a missing file.
     *
     * The icon font is already loaded and is the same one the nav uses, so the
     * fallback is the card still making sense.
     */
    const shot = card.querySelector('img')
    if (!shot) continue
    const FALLBACK = { record: 'video-01', make: 'quill-write-01', recast: 'test-tube-01' }
    shot.onerror = () => {
      const glyph = icon(FALLBACK[card.dataset.tab] ?? 'image-01', 'choose-card__glyph')
      shot.replaceWith(glyph)
    }
  }
  paint()
}

/* ── Record ───────────────────────────────────── */
function vRecord(m) {
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

  /*
   * The steps and the script are the work; the eighteen dials are settings.
   *
   * What you are doing here is describing a capture: the steps a browser walks,
   * and the script those steps become. Everything else — which display, which
   * microphone, cursor mode, viewport size, whether to attach to a browser you
   * already have open — has a default, is right most of the time, and was
   * stacked above and below the two things you came to edit.
   *
   * `f` stays main. `rail` is the settings column.
   */
  const f = el('div', 'form')
  const rail = el('div', 'form')
  const mk = (l, n, hint) => field(rail, l, n, hint)
  /*
   * The project is the space you are in, not a field on this form.
   *
   * Kept as a shape with a `.value` getter because everything below reads it that
   * way — the fetches, the saves, the file lists. Replacing the select with the
   * ambient answer is the whole change; the rest of the panel never learns that
   * the question moved to the header.
   */
  const proj = {
    get value() {
      return currentProject() ?? ''
    },
  }
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
  fieldRow(rail, refresh)
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
  const builder = demoBuilder(
    (text, count, time) => {
      if (!handEdited) script.value = text
      const secs = (ms) => (ms / 1000).toFixed(1) + 's'
      stepCount.textContent = count ? `${count} step${count === 1 ? '' : 's'} · ${secs(time.holds)} of holds · ${secs(time.words)} of narration` : ''
      recheck()
    },
    (rows) => saveDraft(proj.value, rows),
  )

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
  /*
   * The script is a field, not a disclosure.
   *
   * It used to be the only thing behind a collapsed "The script this writes"
   * summary — while every control that depends on it sat in plain view, disabled,
   * explaining "Only applies once there is a script". Six knobs you cannot touch,
   * and the switch that unlocks them out of sight. Out here it reads as what it is:
   * the thing that turns a screen recording into a driven one.
   */
  const scriptCell = el('div', 'full')
  const scriptForm = el('div', 'form')
  scriptForm.style.cssText = 'grid-template-columns:1fr'
  field(scriptForm, 'Script', script, scriptHint)
  slashField(script, () => proj.value)
  scriptCell.append(scriptForm)
  f.append(scriptCell)
  script.oninput = () => {
    handEdited = true
    tone(builderHint, 'warn')
    builderHint.textContent = 'The script has been edited by hand, so the steps no longer write into it on their own. Use "Insert steps into the script" when you want them in — your /directive lines are kept.'
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
  for (const [v, label] of [
    ['editable-overlay', 'Editable overlay — the editor can restyle it'],
    ['system', 'System cursor — burnt into the frames'],
  ]) {
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
  const pageMatch = Object.assign(el('input'), { placeholder: 'part of the tab title, e.g. Ridgeline' })
  mk('Use the browser I have open', attach, attachHint)
  mk('Debugging address', cdp, 'Where that browser exposes CDP. Blank means http://127.0.0.1:9222.')
  mk('Which tab', pageMatch, 'Matched against the tab title or its URL. Blank takes the first ordinary tab.')

  const url = Object.assign(el('input'), { placeholder: 'https://your-app.example.com' })
  const vw = Object.assign(el('input'), { type: 'number', value: 1440, min: 320, max: 7680 })
  const vh = Object.assign(el('input'), { type: 'number', value: 900, min: 240, max: 4320 })
  /*
   * Which browser the script drives.
   *
   * Playwright ships its own Chromium and that is what used to launch — a plain
   * blue-globe icon with no profile and no branding. Fine for a trace nobody
   * watches, wrong for a capture: the video shows a browser the viewer has never
   * seen, which reads as a mock-up rather than the product.
   */
  const browserPick = el('select')
  for (const [v, l] of [
    ['chrome', 'Google Chrome'],
    ['chromium', "Chromium (Playwright's own)"],
    ['edge', 'Microsoft Edge'],
  ]) {
    browserPick.append(Object.assign(el('option', null, l), { value: v }))
  }
  const headless = Object.assign(el('input'), { type: 'checkbox' })
  mk('Base URL', url, 'So a script can say `goto /quotes/new` instead of repeating the host on every line.')
  mk('Viewport width', vw)
  mk('Viewport height', vh, 'The browser window the script drives, and therefore the shape of the capture.')
  mk('Browser', browserPick, 'The one the viewer will recognise. Falls back to the bundled Chromium if it is not installed.')
  mk('Headless', headless, 'Off is right for a capture: there is no window to record when the browser is hidden, and the cursor overlay comes from a real pointer.')

  const attachOnly = [cdp, pageMatch]
  const driverOnly = [url, vw, vh, headless, browserPick]
  /*
   * Hidden, not dimmed.
   *
   * A disabled control still asks to be read, and these could not be enabled from
   * anywhere on screen — the script that unlocks them was behind a summary. A field
   * that cannot apply yet is better absent: the form gets shorter, and what is left
   * is what this capture actually uses.
   */
  const showGroup = (c, on) => {
    const g = c.closest('.form-group')
    if (g) g.style.display = on ? '' : 'none'
    c.disabled = !on
  }
  const syncKnobs = () => {
    const scripted = script.value.trim().length > 0
    const attached = scripted && attach.checked
    showGroup(attach, scripted)
    for (const c of attachOnly) showGroup(c, attached)
    // Viewport and headless belong to a browser we launch. Attaching uses the window
    // that is already there, at whatever size it already is.
    for (const c of driverOnly) showGroup(c, scripted && !attached)
    if (attached) {
      tone(attachHint, 'ok')
      // The * is quoted: zsh globs a bare one and the command fails with
      // "no matches found" before Chrome ever sees it.
      attachHint.textContent = 'Chrome has to have been started with a debugging port — it cannot be given one while running. Quit Chrome, then:  open -a "Google Chrome" --args --remote-debugging-port=9222 --remote-allow-origins=\'*\''
    } else {
      tone(attachHint)
      // No "not yet" branch: with no script the control is not on screen to explain.
      attachHint.textContent = 'Off launches a fresh Chromium, which is blank and signed into nothing — the script needs a "Go to a page" step. On drives the window you already have open.'
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
  /*
   * The other direction, and the way out of a latched `handEdited`.
   *
   * "Rebuild rows from the script" existed; nothing went the other way once the
   * box had been typed in, and the only documented escape was to delete the whole
   * script — which throws away the directives with it.
   */
  const insert = el('button', 'btn ghost')
  insert.append(icon('add-01'), Object.assign(el('span'), { textContent: 'Insert steps into the script' }))
  insert.title = 'Compile the steps above into the script, keeping any /directive lines'
  insert.onclick = () => {
    const rows = builder.rows()
    if (!rows.length) {
      tone(builderHint, 'warn')
      builderHint.textContent = 'No steps to insert yet — add one above.'
      return
    }
    /* What compiled, not what exists — see demoStepsIncomplete. */
    const gaps = demoStepsIncomplete(rows)
    if (gaps.length === rows.length) {
      tone(builderHint, 'warn')
      builderHint.textContent = `Nothing to insert — step ${gaps[0].index + 1} (${gaps[0].action}) still needs ${gaps[0].missing}.`
      return
    }
    script.value = mergeStepsIntoScript(script.value, rows)
    // The rows are now what the script says, so the builder may drive it again.
    handEdited = false
    const wrote = rows.length - gaps.length
    tone(builderHint, gaps.length ? 'warn' : 'ok')
    builderHint.textContent = gaps.length ? `${wrote} of ${rows.length} steps written — step ${gaps[0].index + 1} (${gaps[0].action}) was skipped, it needs ${gaps[0].missing}.` : `${wrote} step${wrote === 1 ? '' : 's'} written into the script.`
    recheck()
  }
  builder.bar.append(insert, rebuild)

  // No change handler: switching project reloads state and re-renders this panel.
  // Awaited, so a draft that exists is on screen before anything can overwrite it.
  loadDraft(proj.value).then((draft) => {
    if (draft.length) builder.load(draft)
  })

  const steps = el('div', 'full')
  const go = el('button', 'btn', 'Set up the capture')
  const w = el('div', 'full')
  w.append(go)
  // `steps` is what the setup LEAVES — the plan and a Run button per step — so it
  // stays in main under the script it describes. Only the button moves.
  f.append(steps)
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
          browser: browserPick.value,
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
            ? ['Drive the browser you already have open, and record it.', 'Attaching to it over CDP rather than launching one, so the page stays signed in and the window recorded is the one being driven. The capture ends when the script does. ' + (secs.value ? secs.value + 's is the backstop.' : 'No backstop set.') + ' Script saved at ' + r.script]
            : ['Open a browser, drive it through the script, and record it.', 'Not the window picked above — this opens its own browser, so that is what gets recorded, and it starts blank. The capture ends when the script does. ' + (secs.value ? secs.value + 's is the backstop.' : 'No backstop set.') + ' Script saved at ' + r.script]
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
  intoRail(rail)
  intoFooter(go)
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

  const steps = plan([
      ['Point it at a trace.', 'A trace.zip, or any folder above one — Browse walks your home directory, so you do not have to know the path.'],
      ['It cuts the demo.', 'playwright-recast (MIT, run through npx) reads the trace and renders an mp4 into this project. Needs ffmpeg and ffprobe on PATH.'],
      ['If narration exists for this name, it is added.', 'rm-mux reconciles the two clocks first: recast compresses idle time, narration takes as long as the words do, and burning one onto the other unreconciled shows cue 1 for the whole clip.'],
    ['Everything streams into Console.', 'Both steps are long and chatty. You get a Run button and the exact argv beside it, never a spinner.'],
  ])

  /*
   * The demo is the work; the thirty knobs behind it are settings.
   *
   * This panel is the densest in the app — speeds, resolution, format,
   * interpolation, four optional JSON configs and a TTS provider — and all of it
   * sat in one column above the button that runs it. The two things you actually
   * touch, the trace and the demo script, were somewhere in the middle of that.
   *
   * The four numbered steps go to the rail too. They explain what the panel will
   * do, which is reference material you read once — kept at the top of main they
   * pushed the first real field below the fold on a laptop.
   */
  const f = el('div', 'form')
  const rail = el('div', 'form')
  const mk = (l, n, hint) => field(rail, l, n, hint)
  /*
   * The project is the space you are in, not a field on this form.
   *
   * Kept as a shape with a `.value` getter because everything below reads it that
   * way — the fetches, the saves, the file lists. Replacing the select with the
   * ambient answer is the whole change; the rest of the panel never learns that
   * the question moved to the header.
   */
  const proj = {
    get value() {
      return currentProject() ?? ''
    },
  }

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
  // The demo script and the trace are the work here, not settings.
  field(f, 'Demo script', demoBody, demoHint)
  slashField(demoBody, () => proj.value)

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

  /*
   * Something to press before you have anything of your own.
   *
   * This panel asked for a Playwright trace produced somewhere else, or for a
   * demo script written against a product it has never seen — so the one panel
   * that most needed a worked example was the one where you could not start
   * without already knowing the answer. The example is a real script against a
   * real public site, it is checked by the same parser as anything you type, and
   * it runs in about twelve seconds.
   *
   * It fills the box rather than running by itself: the point is to show what a
   * demo script looks like, and a thing that just happens teaches nothing.
   */
  const example = el('button', 'btn ghost', 'Load the example')
  example.title = 'A short tour of rolemodelsoftware.com — a working script you can run as-is or edit'
  example.onclick = async () => {
    const r = await (await fetch('/api/demo/example')).json()
    if (r.error) {
      tone(demoHint, 'bad')
      demoHint.textContent = r.error
      return
    }
    demoBody.value = r.body
    // Named too, or "Set up the demo run" writes it to a folder called "demo"
    // and the narration match has nothing to match on.
    if (!title.value.trim()) title.value = r.name
    recheck()
    demoBody.focus()
  }
  const exampleWrap = el('div', 'full')
  exampleWrap.append(example)
  f.append(exampleWrap)

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
  const srt = pathField(rail, 'Narration', {
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
  const recastKeys = apiKeyBlock(rail)
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
  const qwenConfig = pathField(rail, 'Qwen config', { placeholder: 'required when the voice is Qwen — a .json', accept: () => true })
  const textCfg = pathField(rail, 'Text processing config', { placeholder: 'optional — recast’s own JSON rules', accept: () => true })

  const idle = mk('Idle speed', Object.assign(el('input'), { type: 'number', value: 3, min: 0.25, max: 20, step: 0.5 }), 'How much dead time between clicks is compressed. 3 means idle stretches run three times faster.')
  const action = mk('Action speed', Object.assign(el('input'), { type: 'number', value: 1, min: 0.25, max: 20, step: 0.25 }), 'The clicks and typing themselves. 1 is real time — above that the pointer moves faster than a person could follow.')
  const network = mk('Network-wait speed', Object.assign(el('input'), { type: 'number', value: 2, min: 0.25, max: 20, step: 0.25 }), 'Time the test spent waiting on the network. Separate from idle because a slow request is not the same as a pause for effect.')
  const rez = mk('Resolution', el('select'))
  for (const o of ['1080p', '720p']) rez.append(Object.assign(el('option', null, o), { value: o }))
  const fmt = mk('Format', el('select'))
  for (const o of ['mp4', 'webm']) fmt.append(Object.assign(el('option', null, o), { value: o }))
  const fmtHint = el('div', 'hint')
  rail.append(fmtHint)

  const cursorCfg = pathField(rail, 'Cursor overlay config', { placeholder: 'optional — recast’s own JSON', accept: () => true })
  const clickCfg = pathField(rail, 'Click effect config', { placeholder: 'optional — recast’s own JSON', accept: () => true })
  const clickSound = pathField(rail, 'Click sound', { placeholder: 'optional — an audio file played on each click', accept: (x) => x.audio })

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
  rail.append(opts)

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
  // `out` stays in main: it is what the build LEAVES — the plan, the argv and a
  // Run button per step — and it belongs under the script it describes.
  f.append(out)

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
  intoRail(steps, rail)
  intoFooter(build)
}

/* ── Voice ───────────────────────────────────────────────────
   One clip per line, cached on (voice, text), then an SRT written from the
   durations we measured. Nothing gets transcribed back — we already know the
   words, and asking Whisper to guess at them is how "Ridgeline" becomes "Phoenix". */
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

  // The spoken lines are the work; provider, voice and timing are settings.
  // Keep the result with the preview, put those dials in the shared rail, and
  // leave the one irreversible action in the page footer.
  const f = el('div', 'form')
  const rail = el('div', 'form')
  rail.classList.add('rail-form')
  const mk = (l, n, hint) => field(rail, l, n, hint)
  /*
   * The project is the space you are in, not a field on this form.
   *
   * Kept as a shape with a `.value` getter because everything below reads it that
   * way — the fetches, the saves, the file lists. Replacing the select with the
   * ambient answer is the whole change; the rest of the panel never learns that
   * the question moved to the header.
   */
  const proj = {
    get value() {
      return currentProject() ?? ''
    },
  }
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
  rail.append(fixRow)

  const keys = apiKeyBlock(rail, { onSaved: () => loadVoices() })

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

  const preview = el('pre')
  preview.style.cssText = 'max-height:var(--preview-tall);overflow:auto'
  const est = el('div', 'path')
  const fill = () => {
    pick.innerHTML = ''
    const mine = S.scripts.filter((x) => x.project === proj.value)
    if (!mine.length) {
      pick.append(Object.assign(el('option', null, '— no scripts in this project —'), { value: '' }))
    }
    for (const sc of mine) pick.append(Object.assign(el('option', null, sc.name), { value: sc.name }))
    /*
     * A script the project page sent here, selected on arrival.
     *
     * Cleared as it is read, so returning to Voice later opens on the project's
     * first script rather than on whatever was last handed over.
     */
    if (pendingScript) {
      const want = pendingScript
      pendingScript = null
      if (mine.some((x) => x.name === want)) pick.value = want
    }
    show()
  }
  const show = () => {
    const sc = S.scripts.find((x) => x.project === proj.value && x.name === pick.value)
    const lines = sc ? SP.parseScript(sc.body) : []
    preview.textContent = lines.length ? lines.map((l, i) => i + 1 + '  ' + l).join('\n') : 'Nothing speakable — headings, bullets markers and code blocks are skipped.'
    est.textContent = lines.length ? lines.length + ' lines · roughly ' + Math.round(SP.estimateSeconds(lines, Number(gap.value || DEFAULT_GAP_MS))) + 's' : ''
  }
  // No change handler: switching project reloads state and re-renders this panel.
  pick.onchange = show
  gap.oninput = show

  const out = el('div', 'full')
  const go = el('button', 'btn', 'Build the narration')
  const linesGroup = el('div', 'form-group full')
  linesGroup.append(el('label', 'form-label', 'Lines'), preview, Object.assign(est, { className: 'form-hint path' }))
  f.append(linesGroup, out)
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
  intoRail(rail)
  intoFooter(go)
  fill()
}

/* ── Scripts ─────────────────────────────────────────────── */
/**
 * One script, on its own screen.
 *
 * A document you clicked should become the thing you are looking at. The drafter, the
 * new-script form and the grid are all gone while this is up — they are what you use
 * to get here, not what you need once you have arrived.
 *
 * The editor is sized here rather than by `rows`: studio.html pins every textarea to
 * --field-tall, so a script editor would be four lines tall and scroll.
 */
/*
 * Slash commands in the script.
 *
 * The alternative was another form. The Make panel already asks thirteen questions
 * in a column, and the answers end up somewhere other than the words they apply to
 * — so you cannot read your own configuration back, and the script and its settings
 * drift apart. In the document they travel together, and a script is markdown:
 * greppable, and it diffs.
 *
 * Plain text on purpose. `/voice af_heart` stays those characters — no chips, no
 * hidden model. The menu is an input affordance, not a format, which is what keeps
 * the file readable by everything that already reads it (rm-demo, the estimator,
 * git). DS.DIRECTIVES is the same vocabulary the parser enforces, so the menu cannot
 * offer a setting the parser would reject.
 *
 * Anchored under the field rather than at the caret. Measuring a caret inside a
 * textarea means mirroring its content into a hidden div and keeping the two in
 * sync through wrapping, scrolling and resize — a lot of ways to be subtly wrong,
 * for a popup that is on screen for two keystrokes.
 */
let slashVoices = null

function slashValues(key, project) {
  const files = S.projects.find((p) => p.id === project)?.catalog?.files ?? []
  const named = (list) => list.map((x) => ({ v: x.v, hint: x.hint }))
  switch (key) {
    case 'brand':
      return named((S.presets || []).map((p) => ({ v: p.id, hint: p.label })))
    case 'motion':
      return named((S.motion?.presets || []).map((x) => ({ v: x.id, hint: x.label })))
    case 'wallpaper':
      return named([{ v: 'none', hint: 'flat brand colour' }, ...(S.wallpapers || []).map((w) => ({ v: w.file, hint: w.label }))])
    case 'webcam':
      return named(files.filter((f) => f.kind === 'video').map((f) => ({ v: f.rel, hint: dur(f.media?.durationSec) || 'video' })))
    case 'audio':
    case 'music':
      return named(files.filter((f) => f.kind === 'audio').map((f) => ({ v: f.rel, hint: dur(f.media?.durationSec) || 'audio' })))
    case 'captions':
      return named([
        { v: 'on', hint: 'burn subtitles in' },
        { v: 'off', hint: 'no subtitles' },
      ])
    case 'voice':
      // Fetched once and remembered. `none` first because silence is a real choice
      // and used to need a form field to express.
      return named([{ v: 'none', hint: 'no voiceover' }, ...(slashVoices || []).map((x) => ({ v: x.id, hint: x.label }))])
    default:
      return null // free text: title, eyebrow, seconds, chrome
  }
}

// Helper function to update both the UI state and the text content
function updateDOM(activeButton, htmlContent) {
  // Update aria-current active state visual markers
  navButtons.forEach((btn) => btn.removeAttribute('aria-current'))
  activeButton.setAttribute('aria-current', 'true')

  // Inject the new page content
  contentContainer.innerHTML = htmlContent
}

/*
 * Render the directive lines as coloured tags.
 *
 * The text is unchanged — this paints a copy of it behind a transparent textarea.
 * So `/voice af_heart` is still those exact characters on disk, and still what
 * rm-demo and git see, while on screen the value sits in a chip.
 *
 * Only the value is chipped. The key reads as syntax and the value as data, which
 * is the distinction worth drawing; chipping both would make every settings line a
 * wall of colour. A directive the parser does not know is marked wrong here rather
 * than left looking correct — the same information the live checker gives, at the
 * point you are typing.
 */
const HL_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }
const hlEscape = (t) => t.replace(/[&<>]/g, (c) => HL_ESC[c])

function highlightScript(text) {
  const known = DS?.DIRECTIVES || {}
  return text
    .split('\n')
    .map((line) => {
      const m = /^(\s*)(\/[a-z][a-z-]*)(\s*)(.*)$/i.exec(line)
      if (!m) return hlEscape(line)
      const [, lead, key, gap, value] = m
      const ok = Object.hasOwn(known, key.slice(1).toLowerCase())
      const keyHtml = `<span class="${ok ? 'hl-key' : 'hl-bad'}">${hlEscape(key)}</span>`
      const valHtml = value ? `<span class="${ok ? 'hl-val' : 'hl-bad'}">${hlEscape(value)}</span>` : ''
      return hlEscape(lead) + keyHtml + hlEscape(gap) + valHtml
    })
    .join('\n')
}

/**
 * Put a highlight layer behind a textarea and keep the two in step.
 *
 * The trailing newline matters: a <pre> collapses one at the end, a textarea does
 * not, so without the extra character the last line drifts up by a line-height the
 * moment you press Enter.
 */
/*
 * Every script field in the Studio: chips behind the text, menu on "/".
 *
 * Both halves are one decision — a field that highlights directives but will not
 * complete them teaches the vocabulary and then refuses to help with it. They are
 * paired here so adding a field is one call and cannot be half-wired.
 *
 * Call it *after* the field is in its container. attachHighlight wraps the textarea
 * in .hl-wrap, and appending the textarea afterwards lifts it straight back out —
 * leaving a field that looks wired, throws nothing, and highlights nothing.
 */
function slashField(ta, getProject) {
  attachHighlight(ta)
  attachSlashMenu(ta, getProject)
}

function attachHighlight(ta) {
  const wrap = el('div', 'hl-wrap')
  const layer = el('pre', 'hl-layer')
  layer.setAttribute('aria-hidden', 'true')
  ta.replaceWith(wrap)
  wrap.append(layer, ta)

  const paint = () => {
    layer.innerHTML = highlightScript(ta.value) + '\n'
    layer.scrollTop = ta.scrollTop
    layer.scrollLeft = ta.scrollLeft
  }
  ta.addEventListener('input', paint)
  ta.addEventListener('scroll', () => {
    layer.scrollTop = ta.scrollTop
    layer.scrollLeft = ta.scrollLeft
  })

  /*
   * Assigning `.value` repaints, because assigning `.value` fires nothing.
   *
   * The visible text is the layer; the textarea itself is transparent. So the
   * layer has to be repainted whenever the value changes — and `ta.value = x`
   * dispatches no event, by design of the DOM. Five places set it that way: the
   * step builder emitting a script, Make and Scripts loading a saved one, Scenes
   * writing its markup. All of them left a field that looked EMPTY while holding
   * text, until something else happened to repaint it.
   *
   * That is why opening dev tools made the script appear: it resizes the pane,
   * the ResizeObserver below fires, and the layer paints. A symptom that arrives
   * only when you go looking is the worst kind.
   *
   * Intercepted here rather than asking five callers to dispatch an event, which
   * is a rule the sixth one will not know about. The prototype's own setter still
   * does the work, so the element behaves exactly as before — it just tells us.
   */
  const valueProp = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
  Object.defineProperty(ta, 'value', {
    configurable: true,
    get() {
      return valueProp.get.call(this)
    },
    set(next) {
      valueProp.set.call(this, next)
      paint()
    },
  })
  // A manual resize changes the wrap points, so the layer has to be repainted at
  // the new width rather than merely re-scrolled.
  new ResizeObserver(paint).observe(ta)
  paint()
  return paint
}

/*
 * Where the caret is, in pixels, inside a textarea.
 *
 * A textarea has no API for this — there is no rect for a text offset the way
 * there is for a DOM range — so the standard answer is to mirror it: a div
 * styled identically, holding the text up to the caret, with a marker after it.
 * Whatever the browser does with wrapping, tabs and kerning it does the same way
 * twice, and the marker lands where the caret is.
 *
 * The mirror is built per call and thrown away. It is one layout for one
 * keystroke, and keeping one around means keeping its styles in step with a
 * field that can be resized, refonted or re-themed underneath it.
 */
function caretPoint(ta) {
  const cs = getComputedStyle(ta)
  const mirror = el('div')
  // Off-screen rather than hidden: `display: none` has no layout, and layout is
  // the entire point.
  mirror.style.cssText = 'position:absolute;visibility:hidden;white-space:pre-wrap;overflow-wrap:break-word;inset-block-start:0;inset-inline-start:-9999px'
  // Everything that can move a glyph. Missing one shows up as a menu that is
  // subtly wrong on long lines and right on short ones, which is worse than
  // being plainly wrong.
  for (const prop of [
    'boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing',
    'lineHeight', 'textTransform', 'textIndent', 'tabSize', 'wordSpacing',
  ]) {
    mirror.style[prop] = cs[prop]
  }
  const at = ta.selectionStart ?? ta.value.length
  mirror.textContent = ta.value.slice(0, at)
  // A zero-width space, so an empty line still has a box to measure and the
  // marker never changes how the text before it wraps.
  const mark = el('span')
  mark.textContent = '\u200b'
  mirror.append(mark)
  document.body.append(mirror)
  const x = mark.offsetLeft
  const y = mark.offsetTop
  const line = Number.parseFloat(cs.lineHeight) || Number.parseFloat(cs.fontSize) * 1.2
  mirror.remove()
  // Relative to the field's own box, and scrolled with it: the caret can be
  // above the top of a scrolled textarea, and the menu has to follow it there.
  return { x: x - ta.scrollLeft, y: y - ta.scrollTop, line }
}

function attachSlashMenu(ta, getProject) {
  const menu = el('div', 'slash-menu')
  menu.style.cssText = 'position:absolute;z-index:40;max-block-size:16rem;overflow:auto;inline-size:min(38rem,100%);' + 'background:var(--op-color-neutral-plus-eight);border:1px solid var(--op-color-border);' + 'border-radius:var(--op-radius-medium);box-shadow:var(--op-shadow-large);display:none'
  /*
   * The menu hangs off the field, not off a slot under it.
   *
   * The holder used to be a sibling AFTER the textarea, so the menu opened at
   * the bottom of the field whatever line the caret was on — on a script box
   * that is most of the screen tall, that is hundreds of pixels from the word
   * being typed, and the connection between the two is left to the reader.
   *
   * `.hl-wrap` is already the positioning context, so placing it there lets the
   * menu be measured against the same box the caret is measured in.
   */
  const holder = el('div', 'slash-holder')
  // A zero-size anchor pinned to the field's top-left, so the offsets computed
  // against the textarea can be used directly.
  holder.style.cssText = 'position:absolute;inset-block-start:0;inset-inline-start:0;inline-size:100%;block-size:0'
  const wrap = ta.closest('.hl-wrap') ?? ta.parentElement
  wrap.append(holder)
  holder.append(menu)

  let items = []
  let cursor = 0
  let token = null // { start, end, key }

  const close = () => {
    menu.style.display = 'none'
    items = []
    token = null
  }

  const paint = () => {
    menu.innerHTML = ''
    items.forEach((it, i) => {
      const row = el('div')
      row.style.cssText = 'display:flex;gap:var(--op-space-small);align-items:baseline;padding:var(--op-space-2x-small) var(--op-space-small);cursor:pointer;' + (i === cursor ? 'background:var(--op-color-academy-primary-plus-six)' : '')
      row.append(Object.assign(el('span'), { textContent: it.label, style: 'font-family:var(--font-mono);min-inline-size:9rem' }), Object.assign(el('span'), { textContent: it.hint || '', style: 'color:var(--fg-dim);font-size:var(--op-font-x-small)' }))
      row.onmousedown = (e) => {
        e.preventDefault()
        accept(it)
      }
      menu.append(row)
    })
    menu.style.display = items.length ? 'block' : 'none'
    if (items.length) place()
  }

  /*
   * Under the caret, and inside the window.
   *
   * A line below the caret rather than on it, so the menu never covers the word
   * being typed. Flipped above when there is no room under — a menu that opens
   * off the bottom of the screen is the bug this is fixing, one step along.
   */
  const place = () => {
    const { x, y, line } = caretPoint(ta)
    menu.style.insetInlineStart = `${Math.round(Math.max(0, Math.min(x, ta.clientWidth - 40)))}px`

    const below = y + line + 4
    const field = ta.getBoundingClientRect()
    const spaceBelow = window.innerHeight - (field.top + below)
    const tall = menu.offsetHeight || 200
    // Measured against the WINDOW, not the field: the field can be taller than
    // the viewport, and a menu that fits the field can still open off screen.
    menu.style.insetBlockStart = spaceBelow < tall && field.top + y - tall > 0 ? `${Math.round(y - tall - 4)}px` : `${Math.round(below)}px`
  }

  const accept = (it) => {
    if (!token) return
    const before = ta.value.slice(0, token.start)
    const after = ta.value.slice(token.end)
    // A command with values gets a trailing space so the next menu opens straight
    // away; a free-text one gets its stub so the shape is obvious.
    const insert = it.insert
    ta.value = before + insert + after
    const caret = before.length + insert.length
    ta.setSelectionRange(caret, caret)
    close()
    ta.dispatchEvent(new Event('input'))
    ta.focus()
  }

  const refresh = () => {
    const caret = ta.selectionStart
    const lineStart = ta.value.lastIndexOf('\n', caret - 1) + 1
    const head = ta.value.slice(lineStart, caret)

    const cmd = /^\/([a-z-]*)$/i.exec(head)
    if (cmd) {
      const frag = cmd[1].toLowerCase()
      token = { start: lineStart, end: caret }
      items = Object.entries(DS?.DIRECTIVES || {})
        .filter(([k]) => k.startsWith(frag))
        .map(([k, spec]) => ({
          label: '/' + k,
          hint: spec.hint,
          insert: slashValues(k, getProject()) ? `/${k} ` : spec.help,
        }))
      cursor = 0
      return paint()
    }

    const withValue = /^\/([a-z-]+)\s+(\S*)$/i.exec(head)
    if (withValue) {
      const key = withValue[1].toLowerCase()
      const frag = withValue[2].toLowerCase()
      const vals = slashValues(key, getProject())
      if (!vals) return close()
      token = { start: lineStart, end: caret }
      items = vals
        .filter((x) => String(x.v).toLowerCase().includes(frag))
        .slice(0, 40)
        .map((x) => ({ label: x.v, hint: x.hint, insert: `/${key} ${x.v}` }))
      cursor = 0
      if (key === 'voice' && !slashVoices) {
        // Lazily, and repaint when it lands rather than blocking a keystroke.
        slashVoices = []
        fetch('/api/voices?provider=kokoro')
          .then((r) => r.json())
          .then((d) => {
            slashVoices = d.voices || []
            if (token) refresh()
          })
          .catch(() => {})
      }
      return paint()
    }
    close()
  }

  ta.addEventListener('input', refresh)
  ta.addEventListener('click', close)
  ta.addEventListener('blur', () => setTimeout(close, 120))
  ta.addEventListener('keydown', (e) => {
    if (menu.style.display === 'none') return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      cursor = (cursor + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length
      return paint()
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      return accept(items[cursor])
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      return close()
    }
  })
}

/*
 * Scripts: one form, one shelf, one row of actions.
 *
 * This was three screens' worth in two. A "draft it with Claude" form stacked
 * above a "write it yourself" form — the same Project and Name asked for twice,
 * with no way to tell that filling one had anything to do with the other — and
 * clicking a saved script left the panel entirely for a separate editor.
 *
 * They are the same job. A script is drafted or typed or both, and the fields that
 * say which project and what name apply either way. So: one form in the middle,
 * the shelf in the rail beside it, and Draft and Save in the footer. Clicking a
 * saved script loads it into the form rather than replacing the page, which is
 * what makes the separate editor unnecessary rather than merely relocated.
 */
function vScripts(m) {
  const ui = mountPanel('scripts', m)
  const { shelf, name, seconds, about, body, count, draftOut, saved, status, draft, save } = ui

  /*
   * Which project is ambient; whether this script belongs to one is the choice.
   *
   * The panel used to ask both at once in a single select, with "Shared shelf (no
   * project)" as its first option — so the space you were working in and the place
   * this one script goes were the same control. They are not the same question: you
   * can be deep in a project and still be writing the script that travels.
   *
   * `project` keeps its `.value` shape because everything below reads it that way.
   */
  const project = {
    get value() {
      return shelf.value === 'shared' ? '' : (currentProject() ?? '')
    },
  }

  /*
   * Type `/` for the settings, in both text areas.
   *
   * Sourced from the same DIRECTIVES the parser enforces and from live state, so
   * the menu cannot offer a wallpaper the library does not have. Wired after the
   * fields are in the document: attachHighlight wraps the textarea, and a later
   * append would lift it back out of the wrapper.
   */
  slashField(about, () => project.value)
  slashField(body, () => project.value)

  /*
   * What Voice will actually say, counted the way it counts it.
   *
   * The same parser the synthesiser uses, so this number and the number of lines
   * spoken cannot disagree — a preview that argues with the synthesiser is worse
   * than no preview. estimateSeconds takes the PARSED lines, not the markdown;
   * handing it the raw string throws and used to take the whole screen with it.
   */
  const recount = () => {
    const parsed = SP ? SP.parseScript(body.value) : []
    const spoken = parsed.filter((l) => l.kind === 'say')
    const secs = SP && spoken.length ? SP.estimateSeconds(parsed) : null
    count.textContent = spoken.length ? `${spoken.length} spoken line${spoken.length === 1 ? '' : 's'}${secs ? ` · about ${Math.round(secs)}s` : ''}` : 'Nothing to speak yet.'
  }
  body.addEventListener('input', recount)
  recount()

  /** Put a saved script in the form. The form is the editor. */
  const load_ = (sc) => {
    // A script that belongs to no project is a shared one, whichever project you
    // happen to be standing in.
    shelf.value = sc.project ? 'project' : 'shared'
    name.value = sc.name
    body.value = sc.body
    if (sc.brief) {
      seconds.value = sc.brief.seconds
      about.value = sc.brief.about
      // Setting .value fires no input event, so the highlight layer behind the
      // text would still show the previous brief.
      about.dispatchEvent(new Event('input', { bubbles: true }))
    }
    body.dispatchEvent(new Event('input', { bubbles: true }))
    recount()
    says(status, `Editing ${sc.name}. Saving under the same name overwrites it.`)
    body.focus()
  }

  const paintSaved = () => {
    saved.innerHTML = ''
    if (!S.scripts.length) {
      saved.append(el('div', 'hint', 'Nothing saved yet. Draft one, or write it and press Save.'))
      return
    }
    for (const sc of S.scripts) {
      const card = el('div', 'card')
      const b = el('div', 'body')
      const owner = sc.project ? (S.projects.find((x) => x.id === sc.project)?.name ?? sc.project) : 'shared'
      b.append(el('div', 'nm', sc.name), el('div', 'path', owner), el('div', 'path', sc.body.slice(0, SNIPPET_CHARS) + (sc.body.length > SNIPPET_CHARS ? '…' : '')))
      /*
       * A drafted script carries its brief, so "same idea, one change" is possible.
       *
       * The brief used to be assembled and thrown away, which made a redo a matter
       * of retyping it from memory. Loading the card puts the brief back in the
       * form too, editable — a redo that could not change anything would just be a
       * re-run.
       */
      if (sc.brief) {
        b.append(
          Object.assign(el('div', 'path'), {
            textContent: `brief · ${sc.brief.seconds}s · ${new Date(sc.brief.drafted).toLocaleDateString()}`,
          }),
        )
      }
      card.append(b)
      card.style.cursor = 'pointer'
      card.onclick = () => load_(sc)
      saved.append(card)
    }
  }
  paintSaved()

  /*
   * A script the project page asked for, opened on arrival.
   *
   * Read and cleared in one go, like every other handover here: coming back to
   * Scripts later should show the shelf, not silently reopen whatever was last
   * clicked from somewhere else.
   */
  if (pendingScript) {
    const want = pendingScript
    pendingScript = null
    const sc = S.scripts.find((x) => x.name === want)
    // A script that is no longer there leaves you on the shelf rather than on a
    // form claiming to hold something that does not exist.
    if (sc) load_(sc)
  }

  draft.onclick = async () => {
    if (!about.value.trim()) {
      tone(status, 'bad')
      status.hidden = false
    status.textContent = 'Say what the video is for first — that is the brief.'
      return
    }
    draft.disabled = true
    says(status, 'asking Claude…')
    const r = await (
      await fetch('/api/script/draft', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId: project.value,
          name: name.value,
          seconds: Number(seconds.value),
          about: about.value,
        }),
      })
    ).json()
    draft.disabled = false
    draftOut.innerHTML = ''
    if (r.error) {
      tone(status, 'bad')
      status.hidden = false
    status.textContent = r.error
      return
    }
    says(status, 'Run it below. When it finishes, reload and it is on the shelf and in Voice.')
    draftOut.append(Object.assign(el('div', 'path'), { textContent: 'writes  ' + r.dest }))
    draftOut.append(runRow(r.step, 'Write the draft'))
  }

  save.onclick = async () => {
    if (!name.value.trim()) {
      tone(status, 'bad')
      status.hidden = false
    status.textContent = 'Give it a name first.'
      return
    }
    save.disabled = true
    says(status, 'saving…')
    const r = await fetch('/api/script', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: name.value, body: body.value, projectId: project.value || null }),
    })
      .then((x) => x.json())
      .catch(() => ({ error: 'could not reach the Studio' }))
    save.disabled = false
    if (r?.error) {
      tone(status, 'bad')
      status.hidden = false
    status.textContent = r.error
      return
    }
    // Reloaded rather than bounced: saving is not finishing, and the shelf beside
    // the form has to show what was just written to it.
    await load()
    paintSaved()
    tone(status, 'ok')
    status.hidden = false
    status.textContent = 'Saved' + (r?.dest ? ' to ' + r.dest : '')
  }
}

/*
 * Fields whose values are a fixed set.
 *
 * The catalogue knows a component's field names, not what may go in them —
 * `static fields` is a list of attributes, not a schema. These are the ones the
 * components branch on, so a typo produces a silently wrong render rather than
 * an error, which is the case worth spending a select on.
 */

/**
 * What a CSS value actually paints, so two spellings of one colour collapse and
 * a swatch can be drawn for a token whose value is a chain of other tokens.
 *
 * Module scope, because three panels need it and each having its own copy is how
 * they drift.
 */
function paintedColor(cssValue) {
  const probe = el('span')
  probe.style.cssText = `color:${cssValue};position:absolute;visibility:hidden`
  document.body.append(probe)
  const c = getComputedStyle(probe).color
  probe.remove()
  return c
}

/**
 * `rgb(0, 184, 113)` as `#00b871` — what a baked recipe needs.
 *
 * An unparseable value comes back untouched rather than as a default colour. A
 * fallback here would be a colour this file chose, painted into somebody's
 * wallpaper without being asked for and with nothing to say where it came from.
 */
function toHex(painted) {
  const n = painted.match(/\d+(\.\d+)?/g)
  if (!n || n.length < 3) return painted
  return (
    '#' +
    n
      .slice(0, 3)
      .map((v) => Math.round(Number(v)).toString(16).padStart(2, '0'))
      .join('')
  )
}

/**
 * The brand's seed colours, one per family.
 *
 * Read through a function rather than captured in a const: `S` is replaced on
 * every state refresh, and a list bound at load time is the palette as it was
 * when the page opened.
 */
const brandFamilies = () => S?.colors?.originals ?? []

/**
 * A panel, from its markup.
 *
 * Panels used to be assembled here — forty lines of `el('div')` and `.append()`
 * each, where the structure was something you reconstructed by reading code. The
 * markup lives in studio.html now, as markup, and this places it and hands back
 * the nodes it named.
 *
 * `data-region` decides which of Optics' three slots a block goes to, and the two
 * that are not `main` are OUTSIDE `.op-page__main-content`: `sidebar-right` is its
 * own sticky column, `main-footer` its own grid row. So config and actions are not
 * part of the thing that scrolls, which is what a sticky footer inside the content
 * was imitating.
 *
 * Returns the `data-el` nodes by name. Nothing downstream builds DOM to find them.
 */
function mountPanel(name, m) {
  const tpl = document.querySelector(`template[data-panel="${name}"]`)
  if (!tpl) throw new Error(`no template for panel "${name}"`)
  const frag = tpl.content.cloneNode(true)

  const el_ = {}
  for (const node of frag.querySelectorAll('[data-el]')) el_[node.dataset.el] = node

  const side = $('.op-page__sidebar--right')
  const footer = $('.op-page__main-footer')
  // Regions are moved out of the fragment before it is placed, so `main` is
  // whatever is left rather than a fourth wrapper nobody asked for.
  for (const block of [...frag.querySelectorAll('[data-region]')]) {
    const region = block.dataset.region
    if (region === 'side') side?.append(block)
    else if (region === 'footer') footer?.append(block)
  }
  if (side?.firstElementChild) side.classList.add('panel-config')
  if (footer?.firstElementChild) footer.classList.add('panel-actions')
  m.append(frag)
  return el_
}

/*
 * The same two slots, for a panel that builds its DOM rather than cloning a
 * template.
 *
 * `mountPanel` distributes `data-region` blocks out of a <template>, which is
 * the right shape when the markup is static. The wallpaper editor's dials are
 * generated from a recipe, so there is no template to mark up — and without
 * these it had nowhere to put them but the middle of the page, which is how it
 * ended up with the knobs beside the artwork and Save buried under them.
 */
function intoRail(...nodes) {
	const side = $('.op-page__sidebar--right')
	if (!side) return
	side.append(...nodes)
	side.classList.add('panel-config')
}

function intoFooter(...nodes) {
	const footer = $('.op-page__main-footer')
	if (!footer) return
	footer.append(...nodes)
	footer.classList.add('panel-actions')
}

/**
 * Empty Optics' side and footer slots.
 *
 * Called from render() beside `#main`, because they are siblings of it rather than
 * children: a panel that does not fill them would otherwise show the last one's
 * config and buttons, still wired to a view that is gone.
 */
function clearPanelRegions() {
  for (const [sel, cls] of [
    ['.op-page__sidebar--right', 'panel-config'],
    ['.op-page__main-footer', 'panel-actions'],
  ]) {
    const node = $(sel)
    if (!node) continue
    node.innerHTML = ''
    node.classList.remove(cls)
  }
}

/** A brand colour's name, said the way a person would say it. */
const colorLabel = (family) => family.replace(/-/g, ' ').replace(/^academy /, 'Academy ')

/**
 * An accent, and the two colours that have to come with it.
 *
 * Setting `--brand` alone was the bug: `--on-brand` is declared once in
 * rm-video.js from Academy green and never touched again, so a part filled with a
 * pale yellow accent still inked its text in a dark green mixed for a different
 * colour — and on `airfield` cyan or `accent` yellow that is the wrong ink, not
 * merely an unfashionable one.
 *
 *   --brand       the fill, as picked
 *   --on-brand    what reads ON that fill — Optics mixes an `-on-base` per family
 *   --brand-text  the family as TEXT on the stage, which is a different question:
 *                 the seed can be a deep purple, and a title's eyebrow set in it
 *                 on a dark wallpaper is invisible. The `minus-*` steps are the
 *                 light end of a family in dark mode, which is where scenes live.
 *
 * A colour that is not one of ours (a wallpaper hex, a hand-edited scene) gets the
 * fill and nothing else, because there is no family to look the other two up in.
 */
function accentStyle(accent) {
  const family = /^var\(--op-color-(.+?)-original\)$/.exec(accent)?.[1]
  if (!family) return `--brand:${accent}`
  return [`--brand:${accent}`, `--on-brand:var(--op-color-${family}-on-base)`, `--brand-text:var(--op-color-${family}-minus-two)`].join(';')
}

/**
 * One colour, chosen from the brand.
 *
 * A dropdown rather than a row of squares, and a grid rather than a list, for the
 * same reason the imagery picker is a strip: the thing being chosen between is
 * visual, so it has to be seen — but twenty swatches laid out permanently is a
 * band of colour across a form that is mostly about something else. Closed it is
 * one chip; open it is the whole palette at a size you can tell two greens apart at.
 *
 * `-original` is the seed colour, before Optics builds a nineteen-step ramp around
 * it. The ramp is what a surface spends and the wrong thing to shop from — 361
 * squares, with repeats, most of them a shade of something you did not ask for.
 *
 * `format` decides what `onPick` receives. 'token' keeps the family's `-original` token,
 * so the colour follows the theme; 'hex' resolves it, which is what a wallpaper
 * needs because a wallpaper is baked pixels and a var() in a JPEG is nothing.
 */
function colorMenu({ families, value, onPick, format = 'token', noneLabel = null }) {
  const wrap = el('div', 'colormenu')

  /*
   * Every step of every ramp, not one colour per family.
   *
   * This offered the `-original` seed and nothing else — twenty swatches for a
   * palette that holds twenty ramps of eighteen. So "the dark two steps up from
   * the base" was not pickable: you took the seed and then hand-typed a hex,
   * which is how a wallpaper ends up carrying a colour that is nearly but not
   * quite one of ours and nobody can say which.
   *
   * Optics' ladder, lightest to darkest: `minus-max` is near-white and `plus-max`
   * near-black, which is the opposite of what the names suggest — measured, not
   * assumed, because the comment this was copied from had it backwards.
   * `-original` is the seed and sits where
   * `base` would be — there is no `-base` token, which is why probing for the
   * nineteen names finds eighteen live steps.
   */
  const STEPS = [
    'minus-max', 'minus-eight', 'minus-seven', 'minus-six', 'minus-five',
    'minus-four', 'minus-three', 'minus-two', 'minus-one',
    'original',
    'plus-one', 'plus-two', 'plus-three', 'plus-four', 'plus-five',
    'plus-six', 'plus-seven', 'plus-eight', 'plus-max',
  ]

  const tokenFor = (family, step = 'original') => `var(--op-color-${family}-${step})`
  const valueFor = (family, step) => (format === 'hex' ? toHex(paintedColor(tokenFor(family, step))) : tokenFor(family, step))

  /* Which family the current value came from, so re-opening the menu shows what
     is set rather than nothing. A hex is matched by what it paints, because the
     recipe stores the resolved colour and not the name it was picked by. */
  const familyOf = (v) => {
    if (!v) return null
    for (const family of families) {
      for (const step of STEPS) if (tokenFor(family, step) === v) return { family, step }
    }
    // Matched by what it PAINTS, because the recipe stores the resolved colour
    // and not the name it was picked by — and it has to match a step as well as
    // a family now, or every colour in a ramp reports as the seed.
    const painted = paintedColor(v)
    for (const family of families) {
      for (const step of STEPS) if (paintedColor(tokenFor(family, step)) === painted) return { family, step }
    }
    return null
  }

  const trigger = el('button', 'colormenu__trigger')
  trigger.type = 'button'
  trigger.setAttribute('aria-haspopup', 'true')
  trigger.setAttribute('aria-expanded', 'false')
  const chip = el('span', 'colormenu__chip')
  const label = el('span', 'colormenu__label')
  trigger.append(chip, label, el('span', 'colormenu__caret', '▾'))

  const panel = el('div', 'colormenu__panel')
  panel.hidden = true
  panel.setAttribute('role', 'listbox')

  let current = value ?? ''

  const drawTrigger = () => {
    const hit = familyOf(current)
    chip.style.background = current || 'transparent'
    chip.classList.toggle('colormenu__chip--none', !current)
    // The step is named only when it is not the seed: "Academy dark" reads better
    // than "Academy dark original" for the colour people mean by default.
    label.textContent = hit
      ? colorLabel(hit.family) + (hit.step === 'original' ? '' : ' ' + hit.step.replace(/-/g, ' '))
      : current
        ? current
        : noneLabel || 'Choose a colour'
  }

  const close = () => {
    panel.hidden = true
    trigger.setAttribute('aria-expanded', 'false')
  }

  const choose = (v) => {
    current = v
    drawTrigger()
    drawPanel()
    close()
    trigger.focus()
    onPick(v)
  }

  const drawPanel = () => {
    panel.innerHTML = ''
    if (noneLabel) {
      const b = el('button', 'colormenu__swatch colormenu__swatch--none')
      b.type = 'button'
      b.title = noneLabel
      b.setAttribute('role', 'option')
      b.setAttribute('aria-selected', String(!current))
      b.textContent = '—'
      b.onclick = () => choose('')
      panel.append(b)
    }
    /*
     * A family that does not resolve is shown, not hidden.
     *
     * A missing token paints the inherited colour, so every swatch comes out the
     * same and the palette looks like one colour repeated — a picker that has
     * silently broken, with the cause (a stylesheet that did not load) nowhere
     * near the symptom. Marking it says which token is missing.
     */
    const dead = paintedColor(`var(--op-color-${'__none'}-original)`)
    const hit = familyOf(current)
    for (const family of families) {
      // A step that does not resolve is left out rather than drawn: it paints the
      // inherited colour, so it comes out the same as its neighbour and the ramp
      // reads as one colour repeated.
      const live = STEPS.filter((st) => paintedColor(tokenFor(family, st)) !== dead)
      const row = el('div', 'colormenu__row')
      row.append(Object.assign(el('span', 'colormenu__family'), { textContent: colorLabel(family) }))
      const ramp = el('div', 'colormenu__ramp')
      if (!live.length) {
        const b = el('button', 'colormenu__swatch colormenu__swatch--dead')
        b.type = 'button'
        b.disabled = true
        b.title = `${colorLabel(family)} — not resolving`
        ramp.append(b)
      }
      for (const step of live) {
        const b = el('button', 'colormenu__swatch')
        b.type = 'button'
        b.setAttribute('role', 'option')
        b.setAttribute('aria-selected', String(hit?.family === family && hit?.step === step))
        b.style.background = tokenFor(family, step)
        b.title = `${colorLabel(family)} ${step.replace(/-/g, ' ')}`
        b.onclick = () => choose(valueFor(family, step))
        ramp.append(b)
      }
      row.append(ramp)
      panel.append(row)
    }
  }

  /*
   * Placed against the window, not against the trigger's box.
   *
   * The panel was absolutely positioned inside `.colormenu`, which works right up
   * until an ancestor scrolls — and the rail is `overflow-y: auto`. A scroll
   * container CLIPS its absolutely positioned descendants no matter what z-index
   * they carry, so the ramps were cut off at the rail's edge and the family
   * labels, which sit on the left, were the first thing to go.
   *
   * `position: fixed` takes it out of that box entirely, at the cost of having to
   * do the arithmetic here. Flipped above the trigger when there is no room
   * below, and clamped to the viewport on both axes, because a popover that
   * opens off screen is the bug this is fixing.
   */
  const place = () => {
    const t = trigger.getBoundingClientRect()
    panel.style.position = 'fixed'
    panel.style.insetInlineStart = 'auto'
    panel.style.insetInlineEnd = 'auto'
    // Measured after it is visible: a hidden element has no size to place.
    const w = panel.offsetWidth
    const h = panel.offsetHeight
    const margin = 8
    // Right-aligned to the trigger, which keeps a wide panel over the page
    // rather than off the edge beside a rail pinned to the window.
    let left = Math.min(t.right - w, window.innerWidth - w - margin)
    left = Math.max(margin, left)
    const below = window.innerHeight - t.bottom - margin
    const top = h <= below || t.top < h + margin ? t.bottom + 4 : t.top - h - 4
    panel.style.left = `${Math.round(left)}px`
    panel.style.top = `${Math.round(Math.max(margin, Math.min(top, window.innerHeight - h - margin)))}px`
    panel.style.maxBlockSize = `${Math.round(window.innerHeight - margin * 2)}px`
  }

  trigger.onclick = () => {
    const open = panel.hidden
    panel.hidden = !open
    trigger.setAttribute('aria-expanded', String(open))
    if (open) place()
  }

  // Re-placed rather than left behind: the rail scrolls under it, and a popover
  // still pointing at where its trigger used to be is worse than a clipped one.
  for (const [target, ev] of [
    [window, 'resize'],
    [window, 'scroll'],
  ]) {
    target.addEventListener(ev, () => {
      if (!panel.hidden) place()
    }, true)
  }
  // Escape closes, and a click anywhere else does too — a popover that can only be
  // dismissed by picking something is a trap.
  wrap.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) {
      e.stopPropagation()
      close()
      trigger.focus()
    }
  })
  document.addEventListener('pointerdown', (e) => {
    if (!panel.hidden && !wrap.contains(e.target)) close()
  })

  wrap.append(trigger, panel)
  drawTrigger()
  drawPanel()
  wrap.setValue = (v) => {
    current = v ?? ''
    drawTrigger()
    drawPanel()
  }
  return wrap
}

const ENUM_FIELDS = {
  align: ['left', 'center'],
  side: ['left', 'right'],
  dark: ['', 'true'],
  overlay: ['on', 'off'],
  mark: ['off', 'on'],
  theme: ['dark', 'light'],
  motion: ['still', 'drift'],
}

/*
 * Which fields hold one of the brand pictures — by component, not by name.
 *
 * Same idea as ENUM_FIELDS: a field with a known set of valid values should offer
 * them rather than take dictation, and a picture is offered as the picture because
 * a filename is not what anybody is choosing between.
 *
 * Keyed on the tag rather than the field name, because `src` used to mean two
 * things: a brand picture on `rm-image`, and a live URL on `rm-browser`. A picker
 * keyed on the name alone offered the clay renders as something to put in a
 * browser's address bar. `rm-browser` has no picture field at all now — its
 * viewport loads the address it displays — so this map has one entry, and it is a
 * map because the next component to take a picture should not have to be called
 * `src` to get the picker.
 */
const IMAGE_FIELDS = {
  'rm-image': new Set(['src']),
  'rm-shader': new Set(['image']),
}

/* A shader normally follows the scene; either of its two colours can opt out. */
const COLOR_FIELDS = {
  'rm-shader': new Set(['ink', 'paper']),
}

const isColorField = (tag, field) => COLOR_FIELDS[tag]?.has(field) ?? false
const isHiddenField = (tag, field) => tag === 'rm-shader' && field === 'accent'

/*
 * Fields that are a position or a size, and so want a slider.
 *
 * Same idea as ENUM_FIELDS and IMAGE_FIELDS: a field with a known range should
 * offer it rather than take dictation. `x` and `y` are a percentage of the stage
 * from its centre, and `w` is a percentage of its width — none of which anybody
 * arrives at by typing a number and re-rendering. A slider is the only control
 * here where the value and the result move together.
 *
 * By name rather than by tag, because these mean the same thing on every part that
 * has them, unlike `src`.
 */
const RANGE_FIELDS = {
  x: { min: 0, max: 100, step: 1, suffix: '%', fallback: 50 },
  y: { min: 0, max: 100, step: 1, suffix: '%', fallback: 50 },
  density: { min: 0.4, max: 2.2, step: 0.1, suffix: '×', fallback: 1 },
  dot: { min: 1, max: 12, step: 0.5, suffix: ' px', fallback: 2 },
  black: { min: 0, max: 0.4, step: 0.01, suffix: '', fallback: 0.02 },
  white: { min: 0.2, max: 1, step: 0.01, suffix: '', fallback: 0.58 },
  gamma: { min: 0.3, max: 2, step: 0.05, suffix: '', fallback: 0.9 },
}

/** Does this component's field hold a brand picture? */
const isImageField = (tag, field) => IMAGE_FIELDS[tag]?.has(field) ?? false

/*
 * Plausible starting copy for a new part.
 *
 * A part added with every field blank renders as nothing, and an editor whose
 * "add" button appears to do nothing teaches less than no button at all. These
 * are placeholders to type over, not defaults worth keeping.
 */
const SCENE_SAMPLE = {
  eyebrow: 'Product tour',
  title: 'Estimating, in one pass',
  sub: 'From takeoff to a signed proposal.',
  name: 'Dallas Peters',
  text: 'Live pricing',
  heading: 'What changes',
  value: '38',
  label: 'minutes saved',
  url: 'app.rolemodelsoftware.com/estimates',
  x: '62',
  y: '38',
  w: '68',
}

const COMPONENT_SAMPLE = {
  'rm-shader': {
    title: 'Standard',
    subtitle: 'One horizon. We navigate together.',
    image: 'academy-browser.png',
    overlay: 'on',
    mark: 'off',
    theme: 'dark',
    density: '1',
    dot: '2',
    black: '0.02',
    white: '0.58',
    gamma: '0.9',
    motion: 'still',
  },
}

/* ── Scenes ──────────────────────────────────────────────── */

/**
 * Author a scene, see it, render it.
 *
 * The Compose form can only offer the six components and the fields they
 * declare, which is a ceiling: no custom layout, no bespoke motion, nothing the
 * component set does not already do. This is the other way in — the markup is
 * written directly, by hand or by Claude, and the renderer never cared where the
 * HTML came from.
 *
 * What is authored is the scene BODY. The wrapper supplies the brand faces, the
 * stage, a page that cannot scroll and RM.ready(), and the preview is built by
 * the same sceneHtml() the renderer uses — so what is on screen and what comes
 * out of ffmpeg cannot disagree. A preview assembled any other way would be a
 * second copy of the harness, and it would drift.
 */
/**
 * Build a scene from parts, not from typing.
 *
 * The first version was a textarea and a placeholder showing the syntax, which is
 * a text field pretending to be an editor: it asks you to remember six tag names
 * and their attributes before anything appears on screen. Adding a palette that
 * wrote markup into that box helped and did not fix it — you were still editing
 * code to change a word.
 *
 * So the elements are the interface. One card each, its fields typed from the
 * same catalogue the renderer reads, and the markup is generated. The markup is
 * still what gets saved and rendered, and it is still visible and editable behind
 * a summary — an editor that cannot show you what it produced is one you cannot
 * debug.
 */

/*
 * The scenes this project holds, as pictures.
 *
 * A gallery before a builder, like the Library before a project. Each card is a
 * live preview rather than a thumbnail because the machinery already exists —
 * the builder previews the scene being edited exactly this way — and a still of
 * a scene whose point is that it moves would be the wrong picture.
 */
function vSceneGallery(m) {
  const project = currentProjectRecord()
  m.append(el('p', 'lede', `The scenes in ${project?.name ?? 'this project'} — title cards, lower thirds, stats, browser frames. A scene is a picture, so this shows you the pictures.`))

  const grid = el('div', 'grid')
  const add = el('button', 'card cardnew')
  add.type = 'button'
  add.append(icon('add-01'), Object.assign(el('div', 'nm'), { textContent: 'New scene' }), Object.assign(el('div', 'path'), { textContent: 'start from the components' }))
  add.onclick = () => {
    openScene = ''
    render()
  }
  grid.append(add)
  m.append(grid)

  const proj = currentProject() ?? ''
  ;(async () => {
    const r = await fetch('/api/scenes?project=' + encodeURIComponent(proj))
      .then((x) => x.json())
      .catch(() => ({ scenes: [] }))
    const scenes = r.scenes ?? []
    if (!scenes.length) {
      m.append(el('p', 'empty', 'No scenes yet. Build one and it lands here, and in Compose.'))
      return
    }
    for (const sc of scenes) {
      const c = el('div', 'card')
      const tw = el('div', 'thumbwrap')
      const shot = el('div', 'thumb')
      shot.style.cssText = 'display:block;position:relative;overflow:hidden;background:var(--sunk)'
      /*
       * The preview is the same route the builder uses, scaled down.
       *
       * A scene renders at 1920 wide and the card is a few hundred, so the frame
       * is drawn full size and transformed — scaling the IFRAME rather than its
       * contents, which would reflow the scene into a shape it was never
       * designed for and show a layout nobody will ever export.
       */
      const preview = await fetch('/api/scene/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: sc.body, name: sc.name }),
      })
        .then((x) => x.json())
        .catch(() => null)
      if (preview?.url) {
        const frame = Object.assign(el('iframe'), { src: preview.url, loading: 'lazy', title: sc.name })
        frame.setAttribute('scrolling', 'no')
        frame.style.cssText = 'inline-size:1920px;block-size:1080px;border:0;transform-origin:top left;pointer-events:none;position:absolute;inset-block-start:0;inset-inline-start:0'
        shot.append(frame)
        /*
         * Scaled once the card has a width, and SEEKED once it is ready.
         *
         * Every part starts its entrance at opacity 0 and the timeline is paused,
         * so an unseeked scene renders as an empty stage — which is what these
         * cards showed: a gallery of blank rectangles for scenes that are fine.
         * The builder already does this for the scene being edited; a card is the
         * same problem at a smaller size.
         *
         * Half the duration rather than the end, because that is where a scene is
         * doing whatever it does — the last frame is often something leaving.
         */
        frame.onload = async () => {
          const w = shot.clientWidth || 320
          frame.style.transform = `scale(${w / 1920})`
          try {
            const rm = frame.contentWindow?.RM
            await rm?.ready?.()
            rm?.seek?.(Math.round((rm?.duration?.() || 4000) / 2))
          } catch {
            /* torn down while loading; the card just stays as it is */
          }
        }
      }
      tw.append(shot, el('span', 'kind', 'scene'))
      const b = el('div', 'body')
      b.append(el('div', 'nm', sc.name), el('div', 'path', `scenes/${sc.name}.html`))
      c.append(tw, b)

      c.style.cursor = 'pointer'
      c.onclick = () => {
        openScene = sc.name
        render()
      }

      c.append(
        actionMenu([
          {
            icon: 'text-align-left',
            text: 'Edit',
            run: () => {
              openScene = sc.name
              render()
            },
          },
          {
            icon: 'delete-02',
            text: 'Delete',
            danger: true,
            busy: 'Deleting…',
            run: async () => {
              const d = await (
                await fetch('/api/delete', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ path: sc.file }),
                })
              ).json()
              if (d.error) return d.error
              render()
            },
          },
        ]),
      )
      grid.append(c)
    }
  })()
}

function vScenes(m) {
  /*
   * The gallery is the root of this view; the builder is what you open from it.
   *
   * `null` means the gallery, `''` means a new scene, a name means that one —
   * the same three states `pendingWallpaper` uses, for the same reason: "nothing
   * asked for" and "asked for a blank one" are different answers.
   */
  if (openScene === null) return vSceneGallery(m)

  crumbs([
    {
      label: 'Scenes',
      go: () => {
        openScene = null
        render()
      },
    },
    { label: openScene || 'New scene' },
  ])

  let cat = { components: [], wallpapers: [], imagery: [] }
  let elements = []
  let accent = ''

  /*
   * The panel comes from its markup.
   *
   * This was ninety lines of `el('div')`, `.style.cssText` and `.append()` — six
   * form fields, a stage, a scrub row, a palette, a cards list and a details
   * block, all assembled here, with the layout something you had to reconstruct by
   * reading. It is `<template data-panel="scenes">` in studio.html now, and this
   * is the wiring.
   *
   * The regions land in Optics' own slots: the fields in `sidebar-right`, the
   * buttons in `main-footer`, both OUTSIDE `.op-page__main-content`. So the stage
   * is the top of the scrolling area rather than something six fields push below
   * the fold, and the actions do not move.
   */
  const ui = mountPanel('scenes', m)
  const { frame, scrub, palette, cards, rawText, pick, save, draft } = ui
  /*
   * The project comes from the header, not from a field here.
   *
   * `proj` is kept as a shape with a `.value` because everything below reads it
   * that way — the preview URL, the scene list, the save. Replacing the select with
   * the ambient answer is the whole change; the rest of the panel does not need to
   * know the question moved.
   */
  const proj = {
    get value() {
      return currentProject() ?? ''
    },
  }
  const name = ui.name
  const wp = ui.wallpaper
  const brand = ui.brand
  const swatches = ui.accent
  const about = ui.brief
  const tv = ui.time
  const out = ui.status

  /*
   * Revealed by clearing `hidden`, not by setting a display.
   *
   * The element is `<pre data-el="status" hidden>` in the template, and the
   * `[hidden] { display: none !important }` backstop — added so a nav group
   * could actually be hidden — beats an inline `display: block`. So every
   * message this panel wrote went into an element that stayed invisible: saving
   * a scene worked, said so, and showed nothing.
   *
   * `hidden` is the state; `display` was never the right lever for it.
   */
  const say = (t, tone_) => {
    out.hidden = false
    out.textContent = t
    tone(out, tone_)
  }

  const esc = (v) =>
    String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/"/g, '&quot;')

  /** The elements as the markup the renderer reads. */
  const toMarkup = () =>
    elements
      .map((e) => {
        const attrs = [`at="${Number(e.at) || 0}"`, `for="${Number(e.for) || 2600}"`]
        for (const [k, v] of Object.entries(e.attrs)) if (String(v ?? '').trim()) attrs.push(`${k}="${esc(v)}"`)
        const style = accent ? ` style="${accentStyle(accent)}"` : ''
        return `<${e.tag} ${attrs.join(' ')}${style}></${e.tag}>`
      })
      .join('\n')

  /*
   * Markup back into cards, for a scene loaded off disk or hand-edited.
   *
   * DOMParser rather than a regex: these are real elements and an attribute can
   * contain anything a person can type, including the angle brackets a regex
   * would trip over.
   */
  const fromMarkup = (html) => {
    const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html')
    const found = []
    for (const node of doc.querySelectorAll('*')) {
      const spec = cat.components.find((c) => c.tag === node.tagName.toLowerCase())
      if (!spec) continue
      const attrs = {}
      for (const fld of spec.fields) {
        const v = node.getAttribute(fld)
        if (v != null) attrs[fld] = v
      }
      found.push({ tag: spec.tag, at: Number(node.getAttribute('at')) || 0, for: Number(node.getAttribute('for')) || 2600, attrs })
    }
    return found
  }

  let previewTimer = null
  const sync = ({ repaint = true } = {}) => {
    rawText.value = toMarkup()
    if (repaint) paintCards()
    clearTimeout(previewTimer)
    previewTimer = setTimeout(preview, 350)
  }

  const preview = async () => {
    const r = await (
      await fetch('/api/scene/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: toMarkup(), wallpaper: wp.value, brand: brand.value || null, name: name.value }),
      })
    ).json()
    if (r.url) frame.src = r.url
  }

  /* One card per part. The fields come from the catalogue, so a component that
     gains one gains it here with no second edit. */
  function paintCards() {
    cards.innerHTML = ''
    if (!elements.length) {
      cards.append(el('div', 'hint', 'Nothing on the stage yet. Add a part above — a title is the usual opener.'))
      return
    }
    elements.forEach((e, i) => {
      const spec = cat.components.find((c) => c.tag === e.tag)
      /*
       * One row per part until you open it.
       *
       * A card with every field expanded is about 300px tall, so three parts push
       * the scene off the bottom of the screen — and the scene is the thing you are
       * editing. The summary carries what you need to find a part (what it is, when
       * it runs, its first words); the fields appear when you are working on it.
       *
       * The newest is open, because it is the one just added.
       */
      const card = el('details', 'card')
      card.open = i === elements.length - 1
      const bodyEl = el('div', 'body')

      const first = spec?.fields.map((fl) => e.attrs[fl]).find((v) => String(v ?? '').trim()) ?? ''
      const sum = el('summary')
      sum.style.cssText = 'cursor:pointer;display:flex;gap:var(--op-space-x-small);align-items:baseline;padding:var(--op-space-small);'
      sum.append(Object.assign(el('span', 'nm'), { textContent: e.tag.replace(/^rm-/, '') }), Object.assign(el('span', 'path'), { textContent: `${(e.at / 1000).toFixed(1)}s → ${((e.at + e.for) / 1000).toFixed(1)}s` }), Object.assign(el('span', 'path'), { textContent: String(first).slice(0, 48), style: 'color:var(--fg)' }))
      card.append(sum)

      const head = el('div', 'row')
      const up = el('button', 'btn ghost', '↑')
      up.title = 'Earlier in the stack'
      up.disabled = i === 0
      up.onclick = () => {
        elements.splice(i - 1, 0, elements.splice(i, 1)[0])
        sync()
      }
      const down = el('button', 'btn ghost', '↓')
      down.title = 'Later in the stack'
      down.disabled = i === elements.length - 1
      down.onclick = () => {
        elements.splice(i + 1, 0, elements.splice(i, 1)[0])
        sync()
      }
      /*
       * A bin, at a size you can hit.
       *
       * It was a `×` glyph in a small ghost button — the same shape as the reorder
       * arrows beside it, so the destructive control looked like the other two and
       * was the smallest thing on the card. An icon says what it does without
       * reading, and `del` keeps it the one red control in the row.
       */
      const kill = el('button', 'btn btn--icon ghost del kill')
      kill.append(icon('delete-02'))
      kill.setAttribute('aria-label', 'Remove this part')
      kill.title = 'Remove this part'
      kill.onclick = () => {
        elements.splice(i, 1)
        sync()
      }
      head.append(up, down, kill)

      const grid = el('div')
      grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,11rem),1fr));gap:var(--op-space-2x-small)'

      /* Optics' small variant. A part is a dense row of short values — a full-size
         control per field is most of a card's height and all of its wasted space. */
      /*
       * Tag the real control, not the wrapper — the same rule field() follows.
       *
       * This stamped `form-control` on whatever it was handed, so the slider row —
       * a div holding a range and its readout — got Optics' input box drawn around
       * an input box that already had one. Double-bordered, with the readout pushed
       * onto its own line by the wrapper's padding.
       */
      const labelled = (text, control) => {
        const g = el('div', 'form-group')
        /*
         * A colour takes two cells, because its value is a NAME.
         *
         * The part grid is 11rem cells, right for "2600" or "dark". A colour menu
         * carries a swatch, a name, and a chevron gutter — squeezed into one cell
         * the name truncates to "Si…", which is the only part of the control that
         * says which colour is set. A number that does not fit is still readable;
         * a name that does not fit is not.
         */
        if (control.classList?.contains('colormenu')) g.classList.add('form-group--wide')
        g.append(el('label', 'form-label', text), control)
        const real = control.matches?.('input, select, textarea') ? [control] : [...control.querySelectorAll('input, select, textarea')]
        for (const c of real) c.classList.add('form-control', 'form-control--small')
        return g
      }

      const at = Object.assign(el('input'), { type: 'number', step: 100, value: e.at })
      at.oninput = () => {
        e.at = Number(at.value) || 0
        sync({ repaint: false })
      }
      const dur = Object.assign(el('input'), { type: 'number', step: 100, value: e.for })
      dur.oninput = () => {
        e.for = Number(dur.value) || 0
        sync({ repaint: false })
      }
      grid.append(labelled('Starts at (ms)', at), labelled('Lasts (ms)', dur))

      for (const fld of spec?.fields ?? []) {
        // Retained in markup for earlier scenes; Ink is the public control now.
        if (isHiddenField(e.tag, fld)) continue
        /*
         * A picture is picked, not spelled.
         *
         * `src` on an image is the one field whose valid values are a known, short,
         * VISUAL list — and a text box for it asks somebody to remember both that
         * brand/imagery exists and how each file is spelled, to get a silent 404 for
         * their trouble. The name is what is stored; rm-image resolves it against the
         * stage's base, so the same scene is right in the preview and in the render.
         */
        /*
         * A picture is picked, not spelled — and shown at a size you can read.
         *
         * The first version dropped the thumbnails into the field grid, which is
         * 11rem columns of short values: they wrapped two abreast at the size of a
         * favicon, captionless, and you could not tell a rocket from a keyboard.
         * Choosing between pictures means seeing the pictures.
         *
         * So this field takes the whole card width and scrolls sideways, which is
         * also what keeps a part from growing taller than the scene it is part of —
         * the reason the cards collapse in the first place.
         */
        if (isImageField(e.tag, fld)) {
          const group = el('div', 'form-group')
          group.style.gridColumn = '1 / -1'
          group.append(el('label', 'form-label', fld))

          const strip = el('div')
          strip.style.cssText = 'display:flex;gap:var(--op-space-x-small);overflow-x:auto;padding-block-end:var(--op-space-2x-small);scrollbar-width:thin'

          const tile = (label, file, node) => {
            const b = el('button')
            b.type = 'button'
            const on = (e.attrs[fld] ?? '') === file
            b.setAttribute('aria-pressed', String(on))
            b.title = label
            b.style.cssText = [
              'flex:0 0 auto;inline-size:6.5rem;display:flex;flex-direction:column;gap:0.35rem;align-items:center',
              'padding:0.4rem;cursor:pointer;border-radius:var(--op-radius-medium)',
              'background:var(--op-color-neutral-plus-six);color:var(--op-color-neutral-minus-two)',
              `border:1px solid ${on ? 'var(--op-color-primary-base)' : 'var(--op-color-neutral-plus-four)'}`,
              on ? 'outline:2px solid var(--op-color-primary-base);outline-offset:1px' : '',
            ].join(';')
            const frame = el('div')
            // A fixed frame, so a wide picture and a tall one line up as a row
            // rather than making the strip ripple.
            frame.style.cssText = 'inline-size:100%;block-size:3.5rem;display:grid;place-items:center;overflow:hidden'
            frame.append(node)
            const cap = el('span')
            cap.textContent = label
            cap.style.cssText = 'font-size:var(--op-font-2x-small);line-height:1.2;text-align:center;overflow-wrap:anywhere'
            b.append(frame, cap)
            b.onclick = () => {
              e.attrs[fld] = file
              paintCards()
              sync()
            }
            strip.append(b)
          }

          // "None" first, because clearing a picture is a thing you need to be able
          // to do and a second click on the chosen tile is not discoverable.
          const none = el('span', null, '—')
          none.style.cssText = 'font-size:1.5rem;opacity:0.5'
          tile('none', '', none)
          for (const item of cat.imagery ?? []) {
            const thumb = Object.assign(el('img'), { src: `/brand/imagery/${item.file}`, alt: '', loading: 'lazy' })
            thumb.style.cssText = 'max-inline-size:100%;max-block-size:3.5rem;object-fit:contain;display:block'
            tile(item.name.replace(/^academy-/, ''), item.file, thumb)
          }

          group.append(strip)
          if (e.tag === 'rm-shader') {
            /*
             * Embed the picked image in the scene rather than pointing at the
             * browser's temporary file URL. The same body is previewed from the
             * Studio and rendered later from a different directory; a data URL
             * is the one reference both contexts can resolve without losing the
             * person's original upload or a server-side path.
             */
            const upload = el('button', 'btn ghost', 'Upload an image')
            upload.type = 'button'
            const picker = Object.assign(el('input'), { type: 'file', accept: 'image/*' })
            picker.hidden = true
            upload.onclick = () => picker.click()
            picker.onchange = () => {
              const file = picker.files?.[0]
              picker.value = ''
              if (!file) return
              const reader = new FileReader()
              reader.onload = () => {
                if (typeof reader.result !== 'string') return
                e.attrs[fld] = reader.result
                paintCards()
                sync()
              }
              reader.readAsDataURL(file)
            }
            group.append(upload, picker)
          }
          grid.append(group)
          continue
        }
        if (isColorField(e.tag, fld)) {
          const inherited = fld === 'ink' ? 'Sidebar accent' : 'Theme background'
          const menu = colorMenu({
            families: brandFamilies(),
            value: e.attrs[fld] ?? '',
            noneLabel: inherited,
            onPick: (value) => {
              e.attrs[fld] = value
              sync({ repaint: false })
            },
          })
          grid.append(labelled(fld === 'ink' ? 'Ink' : 'Paper', menu))
          continue
        }
        /*
         * A position is dragged, not typed.
         *
         * The readout is beside it because a bare slider hides the one thing you
         * sometimes need exactly — 50 for centred — and `sync` runs on input so the
         * stage above moves as the handle does.
         */
        const range = RANGE_FIELDS[fld]
        if (range) {
          const group = el('div', 'form-group')
          // Two columns wide: the field grid is 11rem cells meant for short values,
          // and a slider sharing one with its readout leaves about 7rem to aim
          // along, which is not enough to land on a number you meant.
          group.style.gridColumn = 'span 2'
          const row = el('div', 'range-row')
          const slider = Object.assign(el('input', 'form-control'), {
            type: 'range',
            min: range.min,
            max: range.max,
            step: range.step,
            value: Number(e.attrs[fld] ?? range.fallback),
          })
          const readout = el('span', 'path', `${slider.value}${range.suffix}`)
          slider.oninput = () => {
            e.attrs[fld] = slider.value
            readout.textContent = `${slider.value}${range.suffix}`
            // repaint:false — rebuilding the cards mid-drag would replace the
            // slider under the pointer and the drag would stop dead.
            sync({ repaint: false })
          }
          row.append(slider, readout)
          group.append(el('label', 'form-label', fld), row)
          slider.classList.add('form-control', 'form-control--small')
          grid.append(group)
          continue
        }

        const choices = ENUM_FIELDS[fld]
        if (choices) {
          const sel = el('select')
          for (const c of choices) sel.append(Object.assign(el('option', null, c || '—'), { value: c, selected: e.attrs[fld] === c }))
          sel.onchange = () => {
            e.attrs[fld] = sel.value
            sync({ repaint: false })
          }
          grid.append(labelled(fld, sel))
          continue
        }
        const inp = Object.assign(el('input'), { value: e.attrs[fld] ?? '', placeholder: fld })
        inp.oninput = () => {
          e.attrs[fld] = inp.value
          sync({ repaint: false })
        }
        grid.append(labelled(fld, inp))
      }
      /* After the fields, not before them. Reordering and removing are things you
         do to a part you have already read; putting them first spends the top of
         every card on controls nobody came for. */
      head.style.cssText = 'margin-top:var(--op-space-x-small)'
      bodyEl.append(grid, head)
      card.append(bodyEl)
      cards.append(card)
    })
  }

  const buildPalette = (components) => {
    for (const c of components ?? []) {
      const b = el('button', 'btn ghost', c.tag.replace(/^rm-/, ''))
      b.title = `Add a ${c.tag.replace(/^rm-/, '')}`
      b.onclick = () => {
        const attrs = {}
        for (const fld of c.fields) {
          const sample = COMPONENT_SAMPLE[c.tag]?.[fld] ?? SCENE_SAMPLE[fld]
          if (sample != null) attrs[fld] = sample
        }
        elements.push({ tag: c.tag, at: 0, for: 2600, attrs })
        sync()
      }
      palette.append(b)
    }
  }

  /*
   * The whole palette, in two steps, with the repeats gone.
   *
   * The first version offered brand/tokens.json's eight seeds plus four
   * sub-brands, which is neither all of the palette nor a set of distinct
   * colours: `tertiary` and `accent` are both #44bb7e, `primary` and Academy are
   * both #00b871, and five of the twelve swatches were green. Optics generates a
   * full ramp from each seed, and those ramps ARE the palette — nineteen scales
   * with a base and nine steps either side.
   *
   * Nineteen times nineteen is not a picker, so it is a scale and then a step:
   * pick the hue, then how light. Values are custom property NAMES rather than
   * hexes, so a colour follows the theme instead of freezing at whatever it
   * resolved to on the day it was picked.
   *
   * Duplicates go by what they RESOLVE to, not by name. Two scales that paint the
   * same pixels are one choice however differently they are spelled, and offering
   * both is what made the row look broken.
   */
  /*
   * The accent, chosen from a dropdown rather than a wall of squares.
   *
   * This was two rows: nineteen scales, then nineteen steps of whichever scale you
   * clicked. It was accurate and it was a colour laboratory — the bases repeat
   * (`tertiary` and `accent` are one colour, so are `primary` and Academy's), the
   * steps are shades of a decision already made, and 361 squares is not a palette.
   *
   * The seeds are what a person picks from: one colour per family, as the brand
   * defines it. Kept as the family's `-original` token rather than resolved, so the
   * colour follows the theme instead of freezing at whatever it painted the day it
   * was chosen.
   */
  let accentMenu = null
  const buildSwatches = () => {
    const families = brandFamilies()
    swatches.innerHTML = ''
    /*
     * An empty catalogue is reported, not rendered as an empty dropdown.
     *
     * `cat.colors` is absent if the fetch failed or the server predates it, and a
     * menu with nothing in it looks exactly like a picker with a bug. Saying so
     * turns "the colours are gone" into a cause.
     */
    if (!families.length) {
      swatches.append(
        Object.assign(el('span', 'hint'), {
          textContent: 'No brand colours came back — the Studio server is older than this page. Quit and reopen the app; a page reload alone will not pick it up.',
        }),
      )
      return
    }
    accentMenu = colorMenu({
      families,
      value: accent,
      noneLabel: 'Preset default',
      onPick: (v) => {
        accent = v
        sync({ repaint: false })
        // An accent with nothing to colour is a control that appears to do
        // nothing. Say where it will land rather than leaving it silent.
        if (!elements.length) say('Accent set — add a part and it will pick this up.')
      },
    })
    swatches.append(accentMenu)
  }

  const seek = (ms) => {
    tv.textContent = ms + ' ms'
    try {
      frame.contentWindow?.RM?.seek(ms)
    } catch {
      /* not loaded yet */
    }
  }
  scrub.oninput = () => seek(Number(scrub.value))
  /*
   * Land where the scene is actually showing something.
   *
   * Every part animates in from opacity 0, so t=0 is the one instant at which a
   * correctly built scene looks empty — you add a title, the preview stays blank,
   * and the obvious conclusion is that it did not work. Seeking to the middle
   * shows the parts settled, which is what somebody wants to see.
   *
   * Only while the playhead has not been moved: once it has been dragged, that is
   * a deliberate position and re-rendering must not yank it away.
   */
  let playheadMoved = false
  scrub.addEventListener('input', () => {
    playheadMoved = true
  })
  frame.onload = async () => {
    /*
     * Wait for the scene to finish starting before seeking it.
     *
     * The wrapper's own script does `await RM.ready(); RM.seek(0)`, and `load`
     * fires before that promise settles — so a seek here was overwritten by the
     * scene's own reset a moment later. `--t` stayed at 0ms while the scrubber
     * read 1696, and every part sat at the first frame of its entrance, which is
     * exactly the opacity-0 instant that looks like nothing rendered.
     */
    try {
      await frame.contentWindow?.RM?.ready?.()
    } catch {
      /* cross-origin or torn down mid-load; the seek below is still worth trying */
    }
    let dur = 0
    try {
      dur = frame.contentWindow?.RM?.duration?.() ?? 0
      if (dur) scrub.max = Math.max(2000, Math.round(dur))
    } catch {
      /* leave the default range */
    }
    if (!playheadMoved && dur) scrub.value = Math.round(dur / 2)
    seek(Number(scrub.value))
  }

  /* Hand-edited markup wins, and comes back as cards. */
  rawText.oninput = () => {
    elements = fromMarkup(rawText.value)
    paintCards()
    clearTimeout(previewTimer)
    previewTimer = setTimeout(preview, 350)
  }

  const savedScenes = []
  const loadScenes = async () => {
    const r = await (await fetch('/api/scenes?project=' + encodeURIComponent(proj.value))).json().catch(() => ({ scenes: [] }))
    savedScenes.length = 0
    savedScenes.push(...(r.scenes ?? []))
    pick.innerHTML = ''
    pick.append(Object.assign(el('option', null, savedScenes.length ? 'new scene' : 'no scenes yet'), { value: '' }))
    for (const sc of savedScenes) pick.append(Object.assign(el('option', null, sc.name), { value: sc.name }))
  }
  pick.onchange = () => {
    const sc = savedScenes.find((x) => x.name === pick.value)
    if (!sc) return
    name.value = sc.name
    elements = fromMarkup(sc.body)
    sync()
  }
  // No onchange: switching project reloads state and re-renders this panel.
  wp.onchange = () => sync({ repaint: false })
  /*
   * The typeface follows the sub-brand, once something asks it to.
   *
   * `preview()` has always sent `brand.value`, and the stage has always turned
   * that into `--rm-font` — but nothing listened to the select, so the value was
   * only picked up the next time some OTHER field changed. Choosing Academy and
   * looking at the stage did nothing at all, which reads as the face not being
   * wired up rather than as a missing listener; editing any text afterwards made
   * it appear, which is worse, because then it looks intermittent.
   *
   * `repaint: false` for the same reason the wallpaper uses it: the parts have
   * not changed, only the sheet they are drawn on.
   */
  brand.onchange = () => sync({ repaint: false })

  save.onclick = async () => {
    /*
     * A name, not a default.
     *
     * wpSlug("") returns "untitled", so an empty field saved silently to
     * untitled.html — and the second scene saved that way overwrote the first.
     * Asked for here rather than refused by the server, so the cursor lands in
     * the field that needs filling.
     */
    if (!name.value.trim()) {
      say('Give the scene a name first — it becomes the filename.', 'bad')
      name.focus()
      return
    }
    const r = await (
      await fetch('/api/scene', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: proj.value, name: name.value, body: toMarkup() }),
      })
    ).json()
    if (r.error) return say(r.error, 'bad')
    /*
     * The button says so, where the click happened.
     *
     * A line of text in the footer is easy to miss beside the control you just
     * pressed — and it was invisible entirely until the `hidden` fix above, so
     * saving a scene gave no sign at all that it had worked. The button is the
     * thing being watched, so it is the thing that reports.
     *
     * Restored after a beat rather than left as "Saved", because the next save
     * has to look pressable.
     */
    save.textContent = 'Saved'
    save.disabled = true
    setTimeout(() => {
      save.textContent = 'Save scene'
      save.disabled = false
    }, SAVED_MS)
    say('Saved to ' + r.file + ' — pick it as a segment in Compose.', 'ok')
    await loadScenes()
    pick.value = r.name
  }

  draft.onclick = async () => {
    // The server rejects an empty brief; saying so here puts the cursor in the
    // field rather than printing an error under a button.
    if (!about.value.trim()) {
      say('Say what the scene is first — a sentence is enough.', 'bad')
      about.focus()
      return
    }
    if (!name.value.trim()) {
      say('Give the scene a name first — Claude writes to that file.', 'bad')
      name.focus()
      return
    }
    /*
     * One call, and the parts come back here.
     *
     * This used to hand over a Console job that wrote a file somewhere and told you
     * to go and load it. It is now a single completion that returns the markup, so
     * the parts appear in the cards — which is where you were going to edit them.
     */
    draft.disabled = true
    say('Drafting…')
    const r = await (
      await fetch('/api/scene/draft', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: proj.value, name: name.value, about: about.value }),
      })
    ).json()
    draft.disabled = false
    if (r.error) return say(r.error, 'bad')
    elements = fromMarkup(r.body)
    sync()
    say(`${elements.length} part${elements.length === 1 ? '' : 's'} drafted and saved to ${r.file}`, 'ok')
    await loadScenes()
    pick.value = r.name
  }

  fetch('/api/compose/catalogue')
    .then((r) => r.json())
    .then((c) => {
      cat = c
      wp.append(Object.assign(el('option', null, 'no wallpaper'), { value: '' }))
      for (const w of c.wallpapers ?? []) wp.append(Object.assign(el('option', null, w.label), { value: w.name }))
      wp.selectedIndex = Math.min(1, wp.options.length - 1)
      buildPalette(c.components)
      buildSwatches()
      paintCards()
      return loadScenes()
    })
    .then(() => {
      /*
       * The scene the gallery opened, loaded on arrival.
       *
       * The card set `openScene` and rendered the builder, and the builder went
       * on doing what it always did — start empty and wait for the dropdown. So
       * clicking a scene showed you a blank template with its name in the
       * breadcrumb, which is a worse lie than not opening it at all.
       *
       * Done here rather than in the click, because `savedScenes` is only
       * populated once `loadScenes` has answered — the body has to come from the
       * same list `pick` reads, or the two disagree about what is loaded.
       */
      if (openScene) {
        pick.value = openScene
        // The same path the dropdown takes, so there is one way a scene loads.
        pick.onchange()
      }
    })
    .then(preview)
    .catch(() => paintCards())
}

/* ── Compose ─────────────────────────────────────────────── */

/**
 * Build a video out of scenes and footage.
 *
 * The pieces existed and nothing joined them: components/rm-video.js has titles,
 * lower thirds, callouts and stats, render-scene turns a scene into an mp4, and
 * the editor opens a document of clips. Writing scene HTML by hand was the only
 * way through, which meant nobody did it.
 *
 * A composition is an ordered list of SEGMENTS. A scene is components with their
 * own little timeline — that is where overlays live, because the document's
 * timeline is a flat clip list with no layers and nothing can sit over a clip.
 * Footage is a file the project already has.
 */
function vCompose(m) {
  m.append(el('p', 'lede', 'The running order. Take a scene off the shelf, drop your footage between them, and the whole thing renders to one video the editor opens.'))
  let shelfScenes = []

  const f = el('div', 'form')
  const mk = (l, n, hint) => field(f, l, n, hint)
  /*
   * The project is the space you are in, not a field on this form.
   *
   * Kept as a shape with a `.value` getter because everything below reads it that
   * way — the fetches, the saves, the file lists. Replacing the select with the
   * ambient answer is the whole change; the rest of the panel never learns that
   * the question moved to the header.
   */
  const proj = {
    get value() {
      return currentProject() ?? ''
    },
  }
  const name = mk('Save as', Object.assign(el('input'), { placeholder: 'opener' }))
  /*
   * Narration, because a capture is almost never the audio.
   *
   * A screen recording with no mic carries a silent track, so a composition made
   * from one comes out valid and inaudible — which reads as the render losing the
   * audio rather than as there never having been any. rm-voice writes the voice
   * beside the footage; this is where it gets picked up.
   */
  const narr = mk('Narration', el('select'), 'Mixed over the whole cut. Footage that carries its own sound is ducked under it, not muted.')
  const fillNarration = () => {
    narr.innerHTML = ''
    narr.append(Object.assign(el('option', null, 'none'), { value: '' }))
    const audio = (S.projects.find((x) => x.id === proj.value)?.catalog?.files ?? []).filter((x) => x.kind === 'audio')
    for (const a of audio) narr.append(Object.assign(el('option', null, a.rel), { value: a.path }))
    if (!audio.length) narr.options[0].textContent = 'no audio in this project yet — record one in Voice'
  }
  m.append(f)

  const shelf = el('div', 'full shelfstrip')
  const shelfLabel = Object.assign(el('span', 'path'), { textContent: 'Scenes' })
  const list = el('div', 'full')
  list.style.cssText = 'display:flex;flex-direction:column;gap:var(--op-space-small)'
  /*
   * The running order takes a drop.
   *
   * Dropped between two segments it lands there; dropped on the empty space below
   * it goes last. `copy` because the shelf keeps the scene — a composition
   * references the file, it does not consume it.
   */
  list.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('text/rm-scene')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    list.style.outline = '2px dashed var(--accent)'
  })
  list.addEventListener('dragleave', () => {
    list.style.outline = ''
  })
  list.addEventListener('drop', (e) => {
    list.style.outline = ''
    const name = e.dataTransfer.getData('text/rm-scene')
    const sc = shelfScenes.find((x) => x.name === name)
    if (!sc) return
    e.preventDefault()
    // Which gap it was dropped into, by comparing against each card's midpoint.
    const cards = [...list.querySelectorAll('.card')]
    let at = cards.length
    for (const [i, c] of cards.entries()) {
      const r = c.getBoundingClientRect()
      if (e.clientY < r.top + r.height / 2) {
        at = i
        break
      }
    }
    addSceneSegment(sc, at)
  })
  const bar = el('div', 'row')
  const out = el('pre', 'full')
  out.style.display = 'none'
  f.append(shelf, list, bar, out)

  /* The catalogue is fetched, not hardcoded: it is parsed from the components
     themselves, so a new field appears here without a second edit. */
  let cat = { components: [], wallpapers: [], imagery: [] }
  const segments = []

  const paint = () => {
    list.innerHTML = ''
    if (!segments.length) {
      const empty = el('div', 'hint', 'Nothing yet. A title scene, then the recording it introduces, is the usual shape.')
      list.append(empty)
    }
    segments.forEach((seg, i) => {
      const row = el('div', 'card')
      const body = el('div', 'body')
      const head = el('div', 'row')
      head.append(el('div', 'nm', `${i + 1}. ${seg.kind === 'scene' ? 'Scene' : 'Footage'}`))

      const up = el('button', 'btn ghost', '↑')
      up.title = 'Move earlier'
      up.disabled = i === 0
      up.onclick = () => {
        segments.splice(i - 1, 0, segments.splice(i, 1)[0])
        paint()
      }
      const down = el('button', 'btn ghost', '↓')
      down.title = 'Move later'
      down.disabled = i === segments.length - 1
      down.onclick = () => {
        segments.splice(i + 1, 0, segments.splice(i, 1)[0])
        paint()
      }
      const kill = el('button', 'btn ghost del', 'Remove')
      kill.onclick = () => {
        segments.splice(i, 1)
        paint()
      }
      head.append(up, down, kill)
      body.append(head)

      /*
       * The sub-brand, per segment.
       *
       * A saved scene is only a body — the stage around it is built at render time
       * — so this cannot live in the scene file. It lives where the wallpaper
       * already does, on the segment, which is also what lets one scene appear in
       * an Academy cut and a RoleModel one without being copied.
       */
      const brandPick = el('select')
      brandPick.className = 'form-control form-control--small'
      for (const [value, label] of [
        ['', 'RoleModel — DM Sans'],
        ['academy', 'Academy — Space Grotesk'],
      ]) {
        brandPick.append(Object.assign(el('option', null, label), { value, selected: (seg.brand ?? '') === value }))
      }
      brandPick.onchange = () => {
        seg.brand = brandPick.value || undefined
      }

      if (seg.kind === 'scene' && seg.bodyFile) {
        /* A reference, not a copy: edit it in Scenes and every composition using
           it follows, because rm-compose reads the file at render time. */
        body.append(Object.assign(el('div', 'path'), { textContent: seg.bodyFile.replace(/^.*\/scenes\//, 'scenes/') }), Object.assign(el('span', 'hint'), { textContent: 'Edit it in Scenes — this is a reference to that file.' }))
        body.append(brandPick)
        row.append(body)
        list.append(row)
        return
      }

      if (seg.kind === 'footage') {
        const pickF = el('select')
        pickF.className = 'form-control'
        // The catalog hangs off the project, not off state — every other panel
        // that lists footage reads it the same way.
        const files = (S.projects.find((x) => x.id === proj.value)?.catalog?.files ?? []).filter((x) => x.kind === 'video')
        // `rel`, not `path`: a catalogue entry has no absolute path, so this was
        // sending undefined and every composition with footage in it 403'd.
        for (const c of files) {
          pickF.append(Object.assign(el('option', null, c.rel), { value: c.rel }))
        }
        if (!pickF.options.length) {
          pickF.append(el('option', null, 'no footage indexed in this project'))
          pickF.disabled = true
        }
        pickF.value = seg.rel || pickF.value
        pickF.onchange = () => {
          seg.rel = pickF.value
        }
        seg.rel = seg.rel || pickF.value
        body.append(pickF)
      } else {
        /* Elements, each with its own at/for. The fields come from the
           catalogue, so this form never has to know what a title is. */
        const els = el('div')
        els.style.cssText = 'display:flex;flex-direction:column;gap:var(--op-space-x-small);margin-top:var(--op-space-small)'
        seg.elements.forEach((e, j) => {
          const spec = cat.components.find((c) => c.tag === e.tag)
          const line = el('div', 'row')
          line.append(Object.assign(el('span', 'path'), { textContent: e.tag, style: 'min-inline-size:9rem' }))
          const at = Object.assign(el('input', 'form-control'), { type: 'number', value: e.at ?? 0, step: 100, title: 'starts at (ms)' })
          at.style.maxInlineSize = '7rem'
          at.oninput = () => {
            e.at = Number(at.value) || 0
          }
          const dur = Object.assign(el('input', 'form-control'), { type: 'number', value: e.for ?? 2500, step: 100, title: 'lasts (ms)' })
          dur.style.maxInlineSize = '7rem'
          dur.oninput = () => {
            e.for = Number(dur.value) || 0
          }
          line.append(at, dur)
          for (const fieldName of spec?.fields ?? []) {
            /* A few fields are a choice, not a sentence. Typing "centre" into a
               free text box produces a scene that renders left-aligned and says
               nothing about why. */
            const choices = ENUM_FIELDS[fieldName]
            if (choices) {
              const sel = el('select', 'form-control')
              for (const c of choices) sel.append(Object.assign(el('option', null, c), { value: c, selected: e.attrs[fieldName] === c }))
              sel.onchange = () => {
                e.attrs[fieldName] = sel.value
              }
              e.attrs[fieldName] = e.attrs[fieldName] ?? choices[0]
              line.append(sel)
              continue
            }
            const inp = Object.assign(el('input', 'form-control'), { placeholder: fieldName, value: e.attrs[fieldName] ?? '' })
            inp.oninput = () => {
              e.attrs[fieldName] = inp.value
            }
            line.append(inp)
          }
          const rmEl = el('button', 'btn ghost del', '×')
          rmEl.title = 'Remove this element'
          rmEl.onclick = () => {
            seg.elements.splice(j, 1)
            paint()
          }
          line.append(rmEl)
          els.append(line)
        })
        const addEl = el('select')
        addEl.className = 'form-control'
        addEl.append(Object.assign(el('option', null, 'Add an element…'), { value: '' }))
        for (const c of cat.components) addEl.append(Object.assign(el('option', null, c.tag), { value: c.tag }))
        addEl.onchange = () => {
          if (!addEl.value) return
          seg.elements.push({ tag: addEl.value, at: 0, for: 2500, attrs: {} })
          paint()
        }
        const wp = el('select')
        wp.className = 'form-control'
        wp.append(Object.assign(el('option', null, 'no wallpaper'), { value: '' }))
        for (const w of cat.wallpapers) wp.append(Object.assign(el('option', null, w.label), { value: w.name }))
        wp.value = seg.wallpaper || ''
        wp.onchange = () => {
          seg.wallpaper = wp.value
        }
        body.append(wp, brandPick, els, addEl)
      }
      row.append(body)
      list.append(row)
    })
  }

  /*
   * The scenes you have already built, ready to drop in.
   *
   * "Add a scene" used to create an empty one and open a second element editor
   * here — a worse copy of the Scenes panel, in a panel about running order. The
   * scenes are already saved in the project; this is the shelf you take them from.
   *
   * A segment references the FILE rather than copying its markup, so editing a
   * scene updates every composition using it and rm-compose reads it fresh at
   * render time (`seg.bodyFile`).
   */

  const addSceneSegment = (sc, at) => {
    const seg = { kind: 'scene', name: sc.name, bodyFile: sc.file }
    if (at == null || at < 0 || at > segments.length) segments.push(seg)
    else segments.splice(at, 0, seg)
    paint()
  }

  const fillShelf = async () => {
    const r = await (await fetch('/api/scenes?project=' + encodeURIComponent(proj.value))).json().catch(() => ({ scenes: [] }))
    shelf.innerHTML = ''
    shelf.append(shelfLabel)
    const scenes = r.scenes ?? []
    if (!scenes.length) {
      shelf.append(Object.assign(el('span', 'hint'), { textContent: 'None yet — build one in Scenes and it appears here.' }))
      return
    }
    for (const sc of scenes) {
      const chip = el('button', 'btn ghost', sc.name)
      chip.title = `Add ${sc.name} to the running order`
      chip.draggable = true
      chip.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/rm-scene', sc.name)
        e.dataTransfer.effectAllowed = 'copy'
      })
      chip.onclick = () => addSceneSegment(sc)
      shelf.append(chip)
    }
    shelfScenes = scenes
  }
  const addFootage = el('button', 'btn ghost', 'Add footage')
  addFootage.onclick = () => {
    segments.push({ kind: 'footage', path: '' })
    paint()
  }
  const go = el('button', 'btn', 'Render and open')
  go.onclick = async () => {
    const r = await (
      await fetch('/api/compose', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: proj.value, name: name.value, audio: narr.value || null, segments }),
      })
    ).json()
    out.style.display = 'block'
    out.innerHTML = ''
    if (r.error) {
      out.textContent = 'Error: ' + r.error
      return
    }
    out.append(Object.assign(el('div', 'path'), { textContent: 'writes  ' + r.out }))
    out.append(runRow(r.step, 'Render the composition'))
    out.append(Object.assign(el('div', 'path'), { textContent: 'When it finishes, the document is in that folder — open it from the Library.' }))
  }
  bar.append(addFootage, go)

  // No change handler: switching project reloads state and re-renders this panel.

  fillNarration()

  void fillShelf()

  fetch('/api/compose/catalogue')
    .then((r) => r.json())
    .then((c) => {
      cat = c
      paint()
    })
    .catch(() => paint())
}

/*
 * Nothing here yet.
 *
 * Shown INSTEAD of whatever panel was asked for, whenever there are no projects.
 * Every scoped panel is about a project, so without one they render as furniture:
 * an empty footage shelf, a dead Save, a scene list with nothing in it. That
 * teaches a first-time user that the tool is broken, which is the most expensive
 * wrong idea they can form.
 *
 * It is not reachable from the nav and does not need to be — it appears when it is
 * true and stops the moment a project exists.
 */
function vFirstRun(m) {
  const { start, status } = mountPanel('firstrun', m)
  start.onclick = () => {
    // Straight to the form that fixes it, rather than describing where it is.
    go('new')
  }
  // Said only if something is actually wrong, so the panel stays an invitation.
  if (!S?.tools?.openscreen) {
    tone(status, 'bad')
    status.textContent = 'The editor is not on PATH yet — Console → rm-setup will tell you what is missing.'
  }
}

/* ── Cut ─────────────────────────────────────────────────── */

/** mm:ss.s — long enough to be precise about a trim, short enough to sit in a label. */
function clock(sec) {
  if (!Number.isFinite(sec)) return '—'
  const m = Math.floor(sec / 60)
  return `${m}:${(sec - m * 60).toFixed(1).padStart(4, '0')}`
}

/*
 * Raw footage, trimmed and stacked.
 *
 * Compose renders: it lays scenes end to end and encodes one new video, which
 * takes minutes and throws the parts away. This is the other kind of edit and the
 * one the tool never had — deciding which PART of a recording you want, twice from
 * the same recording if you like, with titles over the top. Nothing is re-encoded:
 * the document points at the footage on disk and says which span plays and when,
 * so a cut is instant, reversible, and still the original media.
 *
 * The trim is why it exists. `sourceStartSec`/`sourceEndSec` have been in the
 * document schema all along and nothing ever set them, so every clip was the whole
 * file — which is the reason "edit the footage" had nowhere to happen.
 */
function vCut(m) {
  m.append(el('p', 'lede', 'Pick the footage and put it in order. This hands the editor a first assembly — stitching, trimming to the frame and titles happen there, on its timeline. A rough in and out here is optional, and nothing is re-encoded either way.'))

  const f = el('div', 'form')
  /*
   * The project is the space you are in, not a field on this form.
   *
   * Kept as a shape with a `.value` getter because everything below reads it that
   * way — the fetches, the saves, the file lists. Replacing the select with the
   * ambient answer is the whole change; the rest of the panel never learns that
   * the question moved to the header.
   */
  const proj = {
    get value() {
      return currentProject() ?? ''
    },
  }
  const name = field(f, 'Save as', Object.assign(el('input'), { placeholder: 'rough-cut' }), 'The document lands in Renders under this name.')

  const shelf = el('div', 'full')
  shelf.style.cssText = 'display:flex;flex-wrap:wrap;gap:var(--op-space-x-small);align-items:center'
  const list = el('div', 'full')
  list.style.cssText = 'display:flex;flex-direction:column;gap:var(--op-space-small)'
  const titleList = el('div', 'full')
  titleList.style.cssText = 'display:flex;flex-direction:column;gap:var(--op-space-x-small)'
  const bar = el('div', 'row')
  const out = el('pre', 'full')
  out.style.display = 'none'
  const status = el('div', 'form-hint full')
  const titleHead = el('div', 'full')
  titleHead.append(el('span', 'path', 'Titles'))
  f.append(shelf, list, titleHead, titleList, bar, status, out)
  m.append(f)

  const clips = []
  const titles = []

  const project = () => S.projects.find((x) => x.id === proj.value)
  const footage = () => (project()?.catalog?.files ?? []).filter((x) => x.kind === 'video')

  /** What the finished cut runs to, which is the sum of the kept spans. */
  const totalSec = () => clips.reduce((n, c) => n + Math.max(0, (c.outSec ?? c.durationSec ?? 0) - (c.inSec ?? 0)), 0)

  const say = () => {
    status.textContent = clips.length ? `${clips.length} clip${clips.length === 1 ? '' : 's'}, ${clock(totalSec())} — ${titles.length ? `${titles.length} title${titles.length === 1 ? '' : 's'} over the top` : 'no titles yet'}` : ''
  }

  /*
   * One clip, with a preview you can actually trim against.
   *
   * The handles seek the video as they move. That is the whole difference between
   * trimming and typing numbers into a box: you find the cut by looking at the
   * frame you are cutting on, and a number field cannot show you that. The strip
   * is built once per card and mutated in place — repainting it mid-drag would
   * reload the <video> and lose the seek.
   */
  const clipCard = (c, i) => {
    const row = el('div', 'card')
    const body = el('div', 'body')

    const head = el('div', 'row')
    head.append(el('div', 'nm', `${i + 1}. ${c.rel}`))
    const up = Object.assign(el('button', 'btn ghost', '↑'), { title: 'Move earlier', disabled: i === 0 })
    up.onclick = () => {
      clips.splice(i - 1, 0, clips.splice(i, 1)[0])
      paint()
    }
    const down = Object.assign(el('button', 'btn ghost', '↓'), { title: 'Move later', disabled: i === clips.length - 1 })
    down.onclick = () => {
      clips.splice(i + 1, 0, clips.splice(i, 1)[0])
      paint()
    }
    const dup = Object.assign(el('button', 'btn ghost', 'Again'), { title: 'Another span from the same recording' })
    dup.onclick = () => {
      clips.splice(i + 1, 0, { ...c, inSec: c.outSec ?? 0, outSec: c.durationSec })
      paint()
    }
    const kill = el('button', 'btn ghost del', 'Remove')
    kill.onclick = () => {
      clips.splice(i, 1)
      paint()
    }
    head.append(up, down, dup, kill)
    body.append(head)

    /*
     * The trim is folded away.
     *
     * It works, and it is not what this panel is for any more: the editor has a
     * real timeline — drag-to-reorder, trim handles that snap at every zoom,
     * waveforms per clip — and a second, worse one competing with it on the way in
     * is how you end up trimming in the wrong place. Open it for a rough in and out
     * when that saves a trip; leave it shut and the panel is a running order.
     */
    const trim = el('details')
    const trimSummary = el('summary', null, 'Rough in and out (optional)')
    trimSummary.style.cssText = 'cursor:pointer;color:var(--op-color-neutral-minus-four);font-size:var(--op-font-x-small)'
    trim.append(trimSummary)

    const video = Object.assign(el('video'), { src: `/media/${proj.value}/${encodeURI(c.rel)}`, preload: 'metadata', muted: true, playsInline: true })
    // Sized by the picture, not by the panel: `inline-size:100%` forced the box to
    // the full width while the frame kept its own ratio, so most of the clip card
    // was black bars either side of it.
    video.style.cssText = 'inline-size:auto;max-inline-size:100%;display:block;margin-inline:auto;border-radius:var(--op-radius-medium)'
    trim.append(video)

    // The strip: the whole recording, with the kept span lit and a handle at each end.
    const strip = el('div')
    strip.style.cssText = 'position:relative;block-size:2.25rem;margin-block:calc(var(--op-space-x-small) + 0.25rem) var(--op-space-x-small);background:var(--op-color-neutral-plus-six);border-radius:var(--op-radius-small);cursor:pointer;touch-action:none;user-select:none'
    const kept = el('div')
    kept.style.cssText = 'position:absolute;inset-block:0;background:var(--op-color-primary-base);opacity:0.55;border-radius:var(--op-radius-small)'
    const playhead = el('div')
    playhead.style.cssText = 'position:absolute;inset-block:0;inline-size:2px;background:var(--op-color-neutral-base);pointer-events:none'
    const handle = (side) => {
      const h = el('div')
      /*
       * The handles stand proud of the bar, in the opposite colour.
       *
       * Painted in `primary` like the kept region they were invisible against it —
       * a trim control you cannot find is a panel where the footage cannot be
       * trimmed. Taller than the strip, and light on a coloured fill, so they read
       * as the two things on it you are meant to grab.
       */
      h.style.cssText = `position:absolute;inset-block:-0.25rem;inline-size:0.6rem;background:var(--op-color-neutral-plus-max);border:1px solid var(--op-color-primary-base);border-radius:var(--op-radius-small);cursor:ew-resize;touch-action:none;box-shadow:0 1px 3px rgb(0 0 0 / 0.45)`
      h.dataset.side = side
      h.setAttribute('role', 'slider')
      h.setAttribute('aria-label', side === 'in' ? 'Trim from the start' : 'Trim from the end')
      h.tabIndex = 0
      return h
    }
    const hIn = handle('in')
    const hOut = handle('out')
    strip.append(kept, playhead, hIn, hOut)
    trim.append(strip)

    const read = el('div', 'row')
    const label = el('span', 'path')
    const at = el('span', 'hint')
    read.append(label, at)
    trim.append(read)

    const draw = () => {
      const d = c.durationSec
      if (!d) {
        label.textContent = 'reading the recording…'
        return
      }
      const a = ((c.inSec ?? 0) / d) * 100
      const b = ((c.outSec ?? d) / d) * 100
      kept.style.insetInlineStart = `${a}%`
      kept.style.inlineSize = `${Math.max(0, b - a)}%`
      hIn.style.insetInlineStart = `calc(${a}% - 0.375rem)`
      hOut.style.insetInlineStart = `calc(${b}% - 0.375rem)`
      playhead.style.insetInlineStart = `${(video.currentTime / d) * 100}%`
      label.textContent = `in ${clock(c.inSec ?? 0)}   out ${clock(c.outSec ?? d)}`
      at.textContent = `keeps ${clock((c.outSec ?? d) - (c.inSec ?? 0))} of ${clock(d)}`
      say()
    }

    video.addEventListener('loadedmetadata', () => {
      c.durationSec = video.duration
      // A clip added before its metadata arrived has no end yet; the whole file is
      // the honest default, and it is what the handles then trim down from.
      if (c.outSec == null || !Number.isFinite(c.outSec)) c.outSec = video.duration
      video.currentTime = c.inSec ?? 0
      draw()
    })
    video.addEventListener('timeupdate', () => {
      // Stop at the out point while previewing, or "play the trim" plays past it
      // and shows you footage the cut does not contain.
      if (playing && video.currentTime >= (c.outSec ?? video.duration)) {
        video.pause()
        playing = false
        play.textContent = 'Play the trim'
      }
      draw()
    })

    const secAt = (e) => {
      const r = strip.getBoundingClientRect()
      return Math.max(0, Math.min(c.durationSec ?? 0, ((e.clientX - r.left) / r.width) * (c.durationSec ?? 0)))
    }
    let dragging = null
    const move = (e) => {
      if (!dragging || !c.durationSec) return
      const t = secAt(e)
      // A handle stops at the other one. Crossing them is not an edit anybody
      // means, and it produces a clip the document drops silently.
      if (dragging === 'in') c.inSec = Math.min(t, (c.outSec ?? c.durationSec) - 0.1)
      else c.outSec = Math.max(t, (c.inSec ?? 0) + 0.1)
      // Seek to the handle being dragged: the frame you are cutting on is the
      // only thing that tells you whether the cut is right.
      video.currentTime = dragging === 'in' ? c.inSec : c.outSec
      draw()
    }
    const stop = () => {
      dragging = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
    }
    for (const h of [hIn, hOut]) {
      h.addEventListener('pointerdown', (e) => {
        e.preventDefault()
        e.stopPropagation()
        dragging = h.dataset.side
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', stop)
      })
      // Keyboard, because a drag handle that only takes a mouse is a control half
      // the people using it cannot reach. A frame at 30fps is about 33ms.
      h.addEventListener('keydown', (e) => {
        const step = e.shiftKey ? 1 : 1 / 30
        const d = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
        if (!d || !c.durationSec) return
        e.preventDefault()
        if (h.dataset.side === 'in') c.inSec = Math.max(0, Math.min((c.inSec ?? 0) + d, (c.outSec ?? c.durationSec) - 0.1))
        else c.outSec = Math.min(c.durationSec, Math.max((c.outSec ?? c.durationSec) + d, (c.inSec ?? 0) + 0.1))
        video.currentTime = h.dataset.side === 'in' ? c.inSec : c.outSec
        draw()
      })
    }
    // Clicking the strip scrubs — the strip is the recording, so pointing at a
    // moment in it should show you that moment.
    strip.addEventListener('pointerdown', (e) => {
      if (!c.durationSec) return
      video.currentTime = secAt(e)
      draw()
    })

    let playing = false
    const play = el('button', 'btn ghost', 'Play the trim')
    play.onclick = () => {
      if (playing) {
        video.pause()
        playing = false
        play.textContent = 'Play the trim'
        return
      }
      video.currentTime = c.inSec ?? 0
      playing = true
      play.textContent = 'Pause'
      void video.play()
    }
    const setIn = el('button', 'btn ghost', 'In here')
    setIn.title = 'Trim the start to the frame on screen'
    setIn.onclick = () => {
      c.inSec = Math.min(video.currentTime, (c.outSec ?? c.durationSec) - 0.1)
      draw()
    }
    const setOut = el('button', 'btn ghost', 'Out here')
    setOut.title = 'Trim the end to the frame on screen'
    setOut.onclick = () => {
      c.outSec = Math.max(video.currentTime, (c.inSec ?? 0) + 0.1)
      draw()
    }
    const whole = el('button', 'btn ghost', 'Whole file')
    whole.onclick = () => {
      c.inSec = 0
      c.outSec = c.durationSec
      video.currentTime = 0
      draw()
    }
    const controls = el('div', 'row')
    controls.append(play, setIn, setOut, whole)
    trim.append(controls)
    body.append(trim)

    row.append(body)
    draw()
    return row
  }

  const paint = () => {
    list.innerHTML = ''
    if (!clips.length) list.append(el('div', 'hint', 'Nothing yet. Take a recording off the shelf above — the whole file goes in, and you trim it down from there.'))
    clips.forEach((c, i) => list.append(clipCard(c, i)))
    paintTitles()
    say()
  }

  /*
   * A title is a moment, not a clip.
   *
   * It is timed against the FINISHED cut rather than pinned to the clip under it,
   * because the clip under it is the thing you are still trimming — anchoring
   * there would move every title each time a handle moved.
   */
  const paintTitles = () => {
    titleList.innerHTML = ''
    if (!titles.length) {
      titleList.append(el('div', 'hint', 'None. A title sits over the footage at a moment in the finished cut — it does not push anything later.'))
      return
    }
    titles.forEach((t, i) => {
      const line = el('div', 'row')
      const put = (key, ph, w) => {
        const inp = Object.assign(el('input', 'form-control form-control--small'), { placeholder: ph, value: t[key] ?? '' })
        if (w) inp.style.maxInlineSize = w
        inp.oninput = () => {
          t[key] = inp.value
        }
        line.append(inp)
        return inp
      }
      put('eyebrow', 'eyebrow', '9rem')
      put('text', 'the title', '')
      put('sub', 'subtitle', '9rem')
      const num = (key, title, val) => {
        const inp = Object.assign(el('input', 'form-control form-control--small'), { type: 'number', step: 0.5, min: 0, value: t[key] ?? val, title })
        inp.style.maxInlineSize = '5.5rem'
        inp.oninput = () => {
          t[key] = Number(inp.value) || 0
        }
        line.append(inp)
      }
      num('atSec', 'appears at (seconds into the cut)', 0)
      num('forSec', 'stays for (seconds)', 3)
      const rm = Object.assign(el('button', 'btn ghost del', '×'), { title: 'Remove this title' })
      rm.onclick = () => {
        titles.splice(i, 1)
        paintTitles()
        say()
      }
      line.append(rm)
      titleList.append(line)
    })
  }

  /*
   * The shelf is what you have recorded, not a file picker.
   *
   * Adding a clip adds the WHOLE file and lets the handles take it down. Starting
   * from an empty span would mean every clip arrives showing nothing, and the
   * first thing anybody does is drag it back out to see what they have got.
   */
  const fillShelf = () => {
    shelf.innerHTML = ''
    shelf.append(Object.assign(el('span', 'path'), { textContent: 'Footage' }))
    const files = footage()
    if (!files.length) {
      shelf.append(el('span', 'hint', 'Nothing indexed in this project yet — record a screen, then index it from the project page.'))
      return
    }
    for (const file of files) {
      /*
       * Silent footage says so here, where it is chosen.
       *
       * A capture made with the mic and system audio off carries no audio stream at
       * all, and the editor plays it without a word — which reads as the editor
       * having lost the sound rather than there never having been any. The
       * catalogue already probed for a track; this is only the part that mentions it.
       */
      const silent = file.media && file.media.audio === null

      /*
       * A frame from the recording, not its filename.
       *
       * The shelf was a row of text buttons, so choosing footage meant recognising
       * "Academy Intro New.m4v" — and two takes of the same thing differ by a
       * suffix, which is exactly the case where the name tells you least. The
       * thumbnail route already exists and already caches; the picture is the one
       * thing that says which take this is.
       */
      const chip = el('button', 'shelfclip')
      chip.type = 'button'
      const shot = el('div', 'shelfclip__shot')
      const img = Object.assign(el('img'), {
        src: `/thumb/${proj.value}/${encodeURI(file.rel)}`,
        alt: '',
        loading: 'lazy',
      })
      // A recording the thumbnailer cannot read leaves a broken-image glyph, which
      // reads as a corrupt file. The frame just stays empty.
      img.onerror = () => img.remove()
      shot.append(img)
      if (file.media?.durationSec) shot.append(Object.assign(el('span', 'shelfclip__len'), { textContent: clock(file.media.durationSec) }))
      if (silent) shot.append(Object.assign(el('span', 'shelfclip__mute'), { textContent: 'silent' }))
      chip.append(shot, Object.assign(el('span', 'shelfclip__name'), { textContent: file.name }))
      chip.title = silent ? `${file.rel} — no audio track, so the cut will be silent unless another clip carries one` : `Add ${file.rel}`
      chip.onclick = () => {
        // Seeded from the catalogue so the strip has extent before the <video>
        // reports one; loadedmetadata corrects it against the actual file.
        const d = file.media?.durationSec ?? null
        clips.push({ rel: file.rel, label: file.name, inSec: 0, outSec: d, durationSec: d })
        paint()
      }
      shelf.append(chip)
    }
  }

  /*
   * A clip handed over from the Library's "Reuse in a cut".
   *
   * Taken and cleared, so coming back to Cut later does not add it a second time.
   * Matched against the catalogue rather than trusted: the handover carries a
   * `rel`, and the duration and label come from the same place the shelf gets them
   * so a reused clip is indistinguishable from one picked here.
   */
  if (pendingClip) {
    const want = pendingClip.rel
    pendingClip = null
    const file = footage().find((x) => x.rel === want)
    if (file) {
      const d = file.media?.durationSec ?? null
      clips.push({ rel: file.rel, label: file.name, inSec: 0, outSec: d, durationSec: d })
    }
  }

  const addTitle = el('button', 'btn ghost', 'Add a title')
  addTitle.onclick = () => {
    titles.push({ text: '', atSec: 0, forSec: 3 })
    paintTitles()
    say()
  }
  const build = el('button', 'btn', 'Open in the editor')
  build.onclick = async () => {
    out.style.display = 'block'
    out.textContent = 'Cutting…'
    const r = await (
      await fetch('/api/cut', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId: proj.value,
          name: name.value,
          clips: clips.map((c) => ({ rel: c.rel, label: c.label, inSec: c.inSec ?? 0, outSec: c.outSec, durationSec: c.durationSec })),
          titles: titles.filter((t) => String(t.text ?? '').trim()),
        }),
      })
    ).json()
    if (r.error) {
      out.textContent = 'Error: ' + r.error
      return
    }
    out.textContent = `${r.clips} clip${r.clips === 1 ? '' : 's'}, ${clock(r.durationSec)}${r.overlays ? `, ${r.overlays} over the top` : ''}\n${r.document}`
    const opened = await openDocument({ path: r.document })
    if (opened.error) out.textContent += `\n\nWritten, but the editor would not take it: ${opened.error}`
  }
  bar.append(addTitle, build)

  // No change handler: switching project reloads state and re-renders this panel.
  fillShelf()
  paint()
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

  /*
   * The marks.
   *
   * Shown because they were invisible: vendored into brand/logos and staged into
   * every render, with nothing anywhere that let you look at them. "We have the
   * brand assets" was a claim you had to take on trust.
   *
   * Each one is previewed on the ground it is drawn for — a knocked-out wordmark on
   * white is an empty box, and an empty box reads as a missing file rather than as
   * the wrong preview.
   */
  m.append(el('div', 'client', 'Marks'))
  const marks = el('div', 'grid')
  const DARK_GROUND = /-(white|color-on-dark)$/
  for (const b of S.logos || []) {
    for (const [variant, v] of Object.entries(b.variants || {})) {
      if (!v) continue
      const c = el('div', 'card')
      const tw = el('div', 'thumbwrap')
      const t2 = el('div', 'thumb')
      // The mark itself, not a background-image: an <img> keeps the aspect ratio
      // and lets the SVG scale to the box without being cropped.
      const img = Object.assign(el('img', 'brandmark'), { src: `/brand/logos/${v.file}`, alt: `${b.label} — ${variant}` })
      // Grounds come from the palette in state, not from literals here: studio.js
      // is not allowed to invent a colour, and the brand's own dark and light are
      // exactly the two grounds these marks are drawn for.
      t2.style.cssText = 'display:grid;place-items:center;background:' + (DARK_GROUND.test(variant) ? pal.dark || 'var(--op-color-neutral-plus-eight)' : pal.light || 'var(--op-color-neutral-plus-max)')
      t2.append(img)
      tw.append(t2, el('span', 'kind', DARK_GROUND.test(variant) ? 'on dark' : 'on light'))
      const bd = el('div', 'body')
      bd.append(el('div', 'nm', b.label), el('div', 'path', variant), el('div', 'path', v.file))
      c.append(tw, bd)
      marks.append(c)
    }
  }
  if (!marks.children.length) {
    const none = el('p', 'hint', 'No marks vendored yet. Run `npm run logos` with the rolemodel-brand checkout beside this one.')
    m.append(none)
  } else {
    m.append(marks)

    /*
     * The clay renders.
     *
     * Vendored beside the marks because a title needs both: the wordmark says whose
     * video it is, and these are what stop the card being a slide with a logo on it.
     *
     * Previewed on a neutral, not on the brand's dark ground. Only some of these
     * are cut out — browser, cursor, keyboard, rocket and the clay logo carry a
     * light background baked into the file, and previewing those on dark shows a
     * white rectangle and teaches the wrong thing about what dropping one in does.
     */
    if ((S.imagery || []).some((i) => i.file)) {
      m.append(el('div', 'client', 'Imagery'))
      m.append(Object.assign(el('div', 'hint'), { textContent: 'Staged into every render at assets/imagery/, so a composition can use one with no network. Not all are cut out — several carry a light background in the file itself.' }))
      const shots = el('div', 'grid')
      for (const item of S.imagery) {
        if (!item.file) continue
        const c = el('div', 'card')
        const tw = el('div', 'thumbwrap')
        const t2 = el('div', 'thumb')
        const img = Object.assign(el('img', 'brandmark brandmark--photo'), { src: `/brand/imagery/${item.file}`, alt: item.name, loading: 'lazy' })
        t2.style.cssText = 'display:grid;place-items:center;background:var(--op-color-neutral-plus-six)'
        t2.append(img)
        tw.append(t2, el('span', 'kind', `${Math.round((item.bytes || 0) / 1024)}KB`))
        const bd = el('div', 'body')
        bd.append(el('div', 'nm', item.name), el('div', 'path', item.file))
        c.append(tw, bd)
        shots.append(c)
      }
      m.append(shots)
    }
    m.append(Object.assign(el('div', 'path'), { textContent: `${marks.children.length} marks · staged into every render as assets/brand/` }))
  }

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

  /*
   * Assets somebody added, and the way to add one.
   *
   * The marks and the clay renders above are vendored — they arrive by running
   * `npm run logos` beside a brand checkout, which is not a thing you do in the
   * middle of making a video. So "use this client's logo on the title card" had
   * no answer inside the app at all: you put the file somewhere by hand and
   * hoped a composition could name it.
   *
   * These live in the library, not the toolkit, and the server comment on
   * ADDED_DIR says why: `npm run imagery` rewrites brand/imagery/index.json from
   * its own list, and the toolkit directory is replaced on upgrade.
   */
  m.append(el('div', 'client', 'Added assets'))
  m.append(Object.assign(el('div', 'hint'), { textContent: 'Kept in your library beside the projects, so an upgrade cannot take them, and staged into renders the same way the vendored imagery is.' }))

  const addedGrid = el('div', 'grid')
  const addedHint = el('div', 'hint')

  const paintAdded = () => {
    addedGrid.innerHTML = ''
    for (const item of S.added || []) {
      const c = el('div', 'card')
      const tw = el('div', 'thumbwrap')
      const t2 = el('div', 'thumb')
      const img = Object.assign(el('img', 'brandmark brandmark--photo'), { src: `/added/${encodeURIComponent(item.file)}`, alt: item.name, loading: 'lazy' })
      // A neutral ground rather than the brand's dark: an added asset is as
      // likely to be a black wordmark as a cut-out render, and previewing one on
      // its own colour shows an empty box.
      t2.style.cssText = 'display:grid;place-items:center;background:var(--op-color-neutral-plus-six)'
      t2.append(img)
      tw.append(t2, el('span', 'kind', `${Math.round((item.bytes || 0) / 1024)}KB`))
      const bd = el('div', 'body')
      bd.append(el('div', 'nm', item.name), el('div', 'path', item.file))
      c.append(tw, bd)
      c.append(
        actionMenu([
          {
            icon: 'delete-02',
            text: 'Remove',
            danger: true,
            busy: 'Removing…',
            run: async () => {
              const r = await (
                await fetch('/api/brand/asset/delete', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ file: item.file }),
                })
              ).json()
              if (r.error) return r.error
              S = await (await fetch('/api/state')).json()
              paintAdded()
            },
          },
        ]),
      )
      addedGrid.append(c)
    }
    if (!(S.added || []).length) addedGrid.append(el('p', 'empty', 'Nothing added yet.'))
  }

  const addDrop = el('button', 'dropzone')
  addDrop.type = 'button'
  const addPicker = Object.assign(el('input'), { type: 'file', multiple: true, accept: 'image/*' })
  addPicker.hidden = true
  addDrop.append(
    icon('upload-04'),
    Object.assign(el('span', 'dropzone__lead'), { textContent: 'Drop a logo, product shot or texture' }),
    Object.assign(el('span', 'dropzone__sub'), { textContent: 'or click to choose — png, jpg, webp, svg, gif or avif' }),
  )

  const sendAssets = async (files) => {
    const list = [...files]
    if (!list.length) return
    addDrop.disabled = true
    let done = 0
    const failed = []
    for (const file of list) {
      tone(addedHint)
      addedHint.textContent = `copying ${file.name}…`
      const r = await fetch(`/api/brand/asset?name=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: file,
        duplex: 'half',
      })
        .then((x) => x.json())
        .catch((e) => ({ error: e.message }))
      if (r.error) failed.push(`${file.name}: ${r.error}`)
      else done++
    }
    addDrop.disabled = false
    // Refetched rather than re-rendered: render() would rebuild the whole Brand
    // page and scroll you back to the sub-brand swatches.
    S = await (await fetch('/api/state')).json()
    paintAdded()
    if (failed.length) {
      tone(addedHint, done ? 'warn' : 'bad')
      addedHint.textContent = (done ? `Added ${done}. ` : '') + failed.join(' · ')
    } else {
      tone(addedHint, 'ok')
      addedHint.textContent = `Added ${done} asset${done === 1 ? '' : 's'}.`
    }
  }

  addDrop.onclick = () => addPicker.click()
  addPicker.onchange = () => {
    // Copied out before clearing: `files` is live over the input.
    const files = [...addPicker.files]
    addPicker.value = ''
    sendAssets(files)
  }
  for (const ev of ['dragenter', 'dragover']) {
    addDrop.addEventListener(ev, (e) => {
      e.preventDefault()
      addDrop.classList.add('dropzone--over')
    })
  }
  for (const ev of ['dragleave', 'drop']) addDrop.addEventListener(ev, () => addDrop.classList.remove('dropzone--over'))
  addDrop.addEventListener('drop', (e) => {
    e.preventDefault()
    sendAssets(e.dataTransfer?.files ?? [])
  })

  m.append(addDrop, addPicker, addedHint, addedGrid)
  paintAdded()

  /*
   * And an action, not only a target.
   *
   * The drop zone was the whole story: it is the fourth section down a long
   * page, so "how do I add our client's logo" was answered by scrolling until
   * you found a dashed rectangle. Every other panel puts its primary action in
   * the footer, and this panel had an empty one.
   *
   * The same picker either way — the button is a second door to one thing, not a
   * second way of doing it.
   */
  const addAction = el('button', 'btn', 'Add brand assets')
  addAction.onclick = () => addPicker.click()
  intoFooter(addAction)

  m.append(el('div', 'client', 'Wallpapers'))

  /*
   * Into the wallpaper editor, from here.
   *
   * Wallpapers has no nav item any more, so this grid is the only door to it —
   * and the only thing behind that door was "edit one that already exists".
   * Making a new one meant opening someone else's and renaming it, which is how
   * you end up with two wallpapers that share a recipe by accident.
   *
   * The view is set directly rather than through `go()` because the nav has no
   * button to mark current; `paintNavGroups` still runs on the next render.
   */
  const toWallpapers = (name) => {
    editing = null
    /*
     * Hand the wallpaper over rather than waiting for the view to catch up.
     *
     * This used to render the Wallpapers view and then open the editor on a
     * 150ms timer, because `openEditor` is rebound by that render and the
     * recipes may still be fetching. A timer is a guess: too short and the click
     * does nothing, too long and you watch the grid for a beat before the editor
     * appears — which is what made editing a wallpaper feel two levels deep when
     * it was only ever one click.
     *
     * `pendingWallpaper` is read by vWallpapers the moment its recipes are in
     * hand, so the editor is already open when the view paints. Same handover as
     * `pendingClip` into Cut.
     */
    pendingWallpaper = name
    view = 'wallpapers'
    for (const o of document.querySelectorAll('nav button[data-v]')) o.setAttribute('aria-current', String(o.dataset.v === 'wallpapers'))
    render()
  }

  const wg = el('div', 'grid')
  const wnew = el('button', 'card cardnew')
  wnew.type = 'button'
  wnew.append(icon('add-01'), Object.assign(el('div', 'nm'), { textContent: 'New wallpaper' }), Object.assign(el('div', 'path'), { textContent: 'from the brand defaults' }))
  wnew.onclick = () => toWallpapers('')
  wg.append(wnew)

  for (const w of S.wallpapers) {
    const c = el('div', 'card')
    const im = el('div', 'wp')
    im.style.backgroundImage = `url('/wallpaper/${w.file}')`
    const b = el('div', 'body')
    b.append(el('div', 'nm', w.label), el('div', 'path', w.file))
    c.onclick = () => toWallpapers(w.name)
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
  m.append(grid, editor)

  const paint = () => {
    grid.innerHTML = ''
    const add = el('button', 'card cardnew')
    add.type = 'button'
    add.append(icon('add-01'), Object.assign(el('div', 'nm'), { textContent: 'New wallpaper' }), Object.assign(el('div', 'path'), { textContent: 'from the brand defaults' }))
    add.onclick = () => fresh()
    grid.append(add)
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
    /*
     * Both slots are emptied first.
     *
     * Opening a second wallpaper without this leaves the first one's dials in the
     * rail underneath the new ones, still wired to a recipe that is no longer on
     * screen — every drag would edit the wallpaper you just navigated away from.
     */
    clearPanelRegions()
    const { preview, dials, save } = buildEditor(editing, paint)
    editor.append(preview)
    intoRail(dials)
    intoFooter(save)
    editor.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }

  /*
   * Starting a new one is a card, not a button above the grid.
   *
   * It sits first, at the size of the thing it makes, in the grid you are already
   * reading — rather than in a toolbar row that had exactly one control in it.
   */
  const fresh = () => openEditor({ ...WP.DEFAULT_RECIPE, name: '', label: '' })

  /*
   * Whatever the Brand grid asked for, opened as soon as we can open it.
   *
   * Read and cleared in one go: coming back to this view later should show the
   * grid, not silently reopen the last thing somebody clicked from somewhere
   * else. null means nothing was asked for.
   */
  const openPending = () => {
    if (pendingWallpaper === null) return
    const want = pendingWallpaper
    pendingWallpaper = null
    if (want === null || want === '') return fresh()
    const r = recipes.find((x) => x.name === want)
    // A recipe that is no longer there leaves you on the grid rather than on an
    // empty editor claiming to be a wallpaper that does not exist.
    if (r) openEditor(r)
  }

  if (!recipes.length) {
    grid.append(Object.assign(el('div', 'empty', 'Loading recipes…'), {}))
    fetch('/api/wallpapers')
      .then((r) => r.json())
      .then((d) => {
        recipes = d.wallpapers.map(WP.normalize)
        paint()
        openPending()
      })
  } else {
    paint()
    openPending()
  }
}

/*
 * A wallpaper the Brand grid asked for, read and cleared by vWallpapers.
 *
 * `''` means "a new one from the brand defaults"; a name means that recipe. null
 * means nothing was asked for, so the view opens on its grid as before.
 */
/*
 * A script a project card asked another panel to open.
 *
 * Read and cleared by whichever panel it lands in, the same handover Cut and the
 * wallpaper editor use — the alternative is a query string the panels would each
 * have to learn to parse.
 */
/*
 * Assets picked on the project page, waiting to be handed to Make.
 *
 * A Set of `rel` paths rather than of cards, because the cards are rebuilt on
 * every render and a selection that cannot survive one is a selection you lose
 * by filtering the shelf.
 */
const chosenAssets = new Set()

let pendingScript = null

let pendingWallpaper = null

let openEditor = () => {}

/*
 * The editor, in three pieces rather than one block.
 *
 * The artwork is the work, the dials are settings, and Save is the one thing you
 * came here to do — so they belong in main, in the right sidebar, and in the
 * footer. Returned separately because those three slots are siblings in Optics'
 * page grid, not nested: handing back one wrapper is what forced all of it into
 * the middle column, with Save at the bottom of a column of knobs.
 *
 * Every input still mutates the recipe in place and repaints.
 */
function buildEditor(r, onSaved) {
  const left = el('div', 'wpprev')
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
  /*
   * A wallpaper colour, from the brand.
   *
   * Hex, not a token, and that is not an oversight: a wallpaper is baked to a JPEG
   * and a var() in a JPEG is nothing. The dropdown resolves the seed at the moment
   * of picking, so the recipe stores the colour and the picker still only offers
   * ones the brand actually has.
   *
   * It replaces `<input type="color">`, which on macOS opens the system colour
   * panel — a floating window with an eyedropper and a crayon tray, from which
   * every colour in the spectrum is one click away and none of them are ours.
   */
  const colorRow = (box, label, get, set) => {
    const menu = colorMenu({
      families: brandFamilies(),
      value: get(),
      format: 'hex',
      onPick: (v) => {
        set(v)
        repaint()
      },
    })
    box.append(el('label', 'form-label', label), menu, el('span', 'v', ''))
    return menu
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
      const c = colorMenu({
        families: brandFamilies(),
        value: s.color,
        format: 'hex',
        onPick: (v) => {
          s.color = v
          repaint()
        },
      })
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
  requestAnimationFrame(repaint)
  return { preview: left, dials: panel, save }
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
  /*
   * Nothing above the list until there is a list.
   *
   * The lede explains a running job's output, and the Clear button acts on jobs.
   * With none of either they were two pieces of furniture around an empty box,
   * both of them describing something that was not on screen — and the empty state
   * says the useful thing by itself.
   */
  const lede = el('p', 'lede', "Everything the Studio runs, as it runs. Output is live — you don't have to go find a terminal to see whether the export worked.")
  m.append(lede)

  const wrap = el('div', 'con')
  const list = el('div', 'joblist')
  const right = el('div')
  const status = el('div', 'hint')
  const head = el('div', 'runrow')
  const log = el('div', 'log')
  const artifacts = el('div')
  right.append(status, head, log, artifacts)
  wrap.append(list, right)

  /*
   * A way to empty it.
   *
   * The Console is a permanent record on purpose — a render that failed an hour
   * ago is still readable here — and the price of that is a page that only grows.
   * Anything still running is kept, and not out of politeness: forgetting a live
   * job orphans its process and its output stream, which is a worse problem than
   * a long list.
   */
  /*
   * The page's own footer, not one of this panel's making.
   *
   * It built a `<footer class="shell__footer">` of its own, against a class that
   * no longer exists. Optics' `main-footer` is a row of `.op-page__main` outside
   * the scrolling content, which is where a control acting on the whole list
   * belongs — and after the list rather than above it, because a destructive
   * control at the top is one you reach before reading what it would remove.
   */
  const tools = $('.op-page__main-footer')
  tools.classList.add('panel-actions')
  const clear = el('button', 'btn ghost', 'Clear finished')
  clear.title = 'Forget every job that has finished, and its saved output. Running jobs stay.'
  clear.onclick = async () => {
    clear.disabled = true
    const r = await (await fetch('/api/jobs/clear', { method: 'POST' })).json().catch(() => ({}))
    clear.disabled = false
    // Said out loud: a Clear that reports nothing, on a page that is now empty
    // either way, leaves you unsure whether it did anything.
    tone(status, r.cleared ? 'ok' : null)
    status.textContent = r.error ? 'Error: ' + r.error : r.cleared ? `Cleared ${r.cleared} finished job${r.cleared === 1 ? '' : 's'}.${r.remaining ? ` ${r.remaining} still running.` : ''}` : 'Nothing finished to clear.'
    await refreshJobs()
    /*
     * And empty the pane beside the list.
     *
     * The right-hand side is showing the output of whichever job was selected, and
     * that job may be one of the ones just forgotten — leaving a log on screen for
     * something the list no longer contains, which reads as Clear having half
     * worked.
     */
    if (!allJobs.some((j) => j.id === jobId)) {
      jobId = null
      log.textContent = ''
      head.innerHTML = ''
      artifacts.innerHTML = ''
      es?.close()
      es = null
    }
    paintList()
  }
  tools.append(clear)
  m.append(wrap)

  /*
   * Shown only when there is something to act on.
   *
   * Called from paintList, which already runs on every job change and is the one
   * place that knows whether the list has anything in it.
   */
  const showFurniture = () => {
    const any = allJobs.length > 0
    lede.hidden = !any
    tools.hidden = !any
  }

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
    showFurniture()
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
      status.textContent = ''
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
  const ui = mountPanel('components', m)
  ui.openTab.onclick = () => window.open('/components/gallery.html', '_blank')
  ui.openScene.onclick = () => window.open('/components/scene.html', '_blank')
}

/* ── Storage ─────────────────────────────────────────────── */
function vStorage(m) {
  m.append(el('p', 'lede', 'Cloudflare R2 is S3-compatible, so rclone already speaks it — and it has no egress fees, which is the line item that hurts with video.'))

  /*
   * One form, two jobs: add a remote, or edit one that exists.
   *
   * A separate edit screen would have to repeat every field and every validation
   * rule, and the two would drift. `editing` holds the name being edited, or null
   * for a new remote, and the form reads its own labels off that.
   */
  let editing = null

  const f = el('div', 'form')
  const mk = (l, n, hint) => field(f, l, n, hint)
  const name = mk('Remote name', Object.assign(el('input'), { placeholder: 'rm-video' }))

  /*
   * Which S3 this is, because it was always Cloudflare's.
   *
   * rclone uses `provider` to decide which dialect of S3 it is speaking, and it
   * was pinned — so pointing the old form at an AWS endpoint produced a remote
   * that authenticated and then failed on operations, which reads as bad
   * credentials. R2 stays the default: it is what this pipeline recommends, and
   * it has no egress fee.
   */
  const provider = mk('Provider', el('select'), 'What kind of S3 this is. rclone speaks a slightly different dialect to each.')
  for (const [v, label] of [
    ['Cloudflare', 'Cloudflare R2'],
    ['AWS', 'Amazon S3'],
    ['DigitalOcean', 'DigitalOcean Spaces'],
    ['Wasabi', 'Wasabi'],
    ['Minio', 'MinIO'],
    ['Other', 'Other S3-compatible'],
  ]) {
    provider.append(Object.assign(el('option', null, label), { value: v }))
  }

  const ep = mk('Endpoint', Object.assign(el('input'), { placeholder: 'https://<account>.r2.cloudflarestorage.com' }))
  const region = mk('Region', Object.assign(el('input'), { placeholder: 'us-east-1' }), 'Amazon wants a region and works out the endpoint itself. The others want an endpoint.')
  const ak = mk('Access key', el('input'))
  const sk = mk('Secret key', Object.assign(el('input'), { type: 'password' }))

  /*
   * Show the one that provider actually uses.
   *
   * Both fields visible means filling both in, and rclone honours an empty
   * endpoint as "" rather than as absent — so an AWS remote with a blank
   * endpoint left over from the placeholder fails in a way that points at the
   * credentials.
   */
  const syncProvider = () => {
    const aws = provider.value === 'AWS'
    ep.closest('.form-group').hidden = aws
    region.closest('.form-group').hidden = !aws
  }
  provider.onchange = syncProvider
  syncProvider()
  const out = el('pre', 'full')
  out.style.display = 'none'
  const go = el('button', 'btn', 'Save remote')
  const cancel = el('button', 'btn ghost', 'Cancel')
  cancel.style.display = 'none'
  const w = el('div', 'full row')
  w.append(go, cancel)
  f.append(w, out)
  m.append(f)

  const say = (t) => {
    out.style.display = 'block'
    out.textContent = t
  }

  const newRemote = () => {
    editing = null
    name.readOnly = false
    name.value = ''
    ep.value = ''
    ak.value = ''
    sk.value = ''
    sk.placeholder = ''
    go.textContent = 'Save remote'
    cancel.style.display = 'none'
    out.style.display = 'none'
    /* The label is the sentence that tells you which mode you are in. */
    name.closest('.form-group').querySelector('.form-label').textContent = 'Remote name'
  }

  const edit = async (n) => {
    const r = await (await fetch('/api/storage/' + encodeURIComponent(n))).json()
    if (r.error) return say(r.error)
    editing = n
    /* rclone has no rename — changing this would mean delete-and-recreate, which
       loses any key this form does not know about. So the name is fixed while
       editing, and says so rather than silently ignoring an edit. */
    name.readOnly = true
    name.value = r.name
    name.closest('.form-group').querySelector('.form-label').textContent = 'Remote name (rclone cannot rename)'
    provider.value = r.provider || 'Cloudflare'
    syncProvider()
    ep.value = r.endpoint ?? ''
    region.value = r.region ?? ''
    ak.value = r.accessKeyId ?? ''
    sk.value = ''
    /* The secret is never sent back — obscured is not secret. Blank means keep. */
    sk.placeholder = r.hasSecret ? 'unchanged — type to replace' : 'not set'
    go.textContent = 'Save changes'
    cancel.style.display = ''
    out.style.display = 'none'
    f.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }

  cancel.onclick = newRemote

  go.onclick = async () => {
    go.disabled = true
    // Only the one the provider uses: rclone honours a blank endpoint as "" and
    // not as absent, so sending both writes the unused one in as empty.
    const aws = provider.value === 'AWS'
    const body = {
      name: name.value,
      provider: provider.value,
      endpoint: aws ? '' : ep.value,
      region: aws ? region.value : '',
      accessKeyId: ak.value,
      secretAccessKey: sk.value,
    }
    const r = await (
      await fetch(editing ? '/api/storage/' + encodeURIComponent(editing) : '/api/storage', {
        method: editing ? 'PUT' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    ).json()
    go.disabled = false
    if (!r.ok) return say('Failed:\n' + (r.err || r.out || r.error))
    say(editing ? 'Saved. "' + editing + '" updated.' : 'Saved. rclone remote "' + name.value + '" is ready — pick it when creating a project.')
    newRemote()
    await load()
  }

  if (!S.remotes.length) return

  /*
   * What is actually IN the remote.
   *
   * The panel could make a remote and list its buckets, and that was the end of
   * it — everything a bucket then held was invisible from here. A render gets
   * uploaded and never seen again: to answer "did that land" or "what is in
   * there" you opened the Cloudflare dashboard or ran rclone by hand, which is
   * the same shape of gap the footage shelf had before it showed frames.
   *
   * Every operation is an rclone subcommand. rclone already speaks S3 here and
   * holds the credentials; a second S3 client would be a second set of keys to
   * keep in step, and the first time they disagreed it would look like an outage.
   */
  m.append(el('div', 'client', 'Browse'))

  let atRemote = S.remotes[0]
  let atPath = ''
  let entries = []
  let busy = false

  const crumbRow = el('div', 'row s3bar')
  const listing = el('div', 's3list')
  const dropZone = el('div', 's3drop')
  const s3Hint = el('div', 'hint')

  const remotePick = Object.assign(el('select'), { className: 'form-control' })
  remotePick.style.maxInlineSize = '18rem'
  for (const r of S.remotes) remotePick.append(Object.assign(el('option', null, r), { value: r }))
  remotePick.onchange = () => {
    atRemote = remotePick.value
    atPath = ''
    void refresh()
  }

  const s3say = (text, level) => {
    tone(s3Hint, level)
    s3Hint.textContent = text
  }

  /** Everything above the current folder, as one click each. */
  const paintCrumbs = () => {
    crumbRow.innerHTML = ''
    crumbRow.append(remotePick)
    const parts = atPath ? atPath.split('/') : []
    const root = el('button', 'btn ghost btn--pill', atRemote + ':')
    root.onclick = () => {
      atPath = ''
      void refresh()
    }
    crumbRow.append(root)
    parts.forEach((part, i) => {
      const b = el('button', 'btn ghost btn--pill', part)
      b.onclick = () => {
        atPath = parts.slice(0, i + 1).join('/')
        void refresh()
      }
      crumbRow.append(b)
    })

    const mk2 = el('button', 'btn ghost btn--pill', 'New folder')
    mk2.onclick = async () => {
      const folder = prompt('Name the folder')
      if (!folder) return
      const r = await post(`/api/storage/${encodeURIComponent(atRemote)}/mkdir`, { path: atPath ? `${atPath}/${folder}` : folder })
      if (r.error) return s3say(r.error, 'bad')
      await refresh()
    }
    crumbRow.append(mk2)
  }

  const post = (url, body) =>
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then((x) => x.json())
      .catch((e) => ({ error: e.message }))

  /*
   * Move, which is also rename and also what a drop onto a folder does.
   *
   * One call for all three because in object storage they are one operation:
   * there are no directories to move BETWEEN, only keys with slashes in them.
   */
  const moveTo = async (entry, destDir) => {
    const from = atPath ? `${atPath}/${entry.name}` : entry.name
    const to = destDir ? `${destDir}/${entry.name}` : entry.name
    if (from === to) return
    s3say(`moving ${entry.name}…`)
    const r = await post(`/api/storage/${encodeURIComponent(atRemote)}/mv`, { from, to, dir: entry.dir })
    if (r.error) return s3say(r.error, 'bad')
    s3say(`Moved ${entry.name}.`, 'ok')
    await refresh()
  }

  const paintList = () => {
    listing.innerHTML = ''
    if (!entries.length) {
      listing.append(el('p', 'empty', atPath ? 'Nothing in this folder.' : 'Nothing in this remote yet. Drop a file below, or upload a render from a project.'))
      return
    }
    // Folders first, then names: a bucket of renders is mostly files, and a
    // folder you cannot find is a folder you make a second copy of.
    const sorted = [...entries].sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
    for (const e of sorted) {
      const row = el('div', 's3row')
      row.draggable = true
      row.dataset.name = e.name

      row.addEventListener('dragstart', (ev) => {
        ev.dataTransfer.setData('application/x-rm-entry', JSON.stringify(e))
        ev.dataTransfer.effectAllowed = 'move'
        row.classList.add('s3row--dragging')
      })
      row.addEventListener('dragend', () => row.classList.remove('s3row--dragging'))

      /*
       * A folder is a drop target; a file is not.
       *
       * Dropping a file onto a file has no meaning here — there is nothing to
       * put it inside — and a row that lights up and then does nothing is worse
       * than one that never lit up.
       */
      if (e.dir) {
        for (const ev of ['dragenter', 'dragover']) {
          row.addEventListener(ev, (event) => {
            if (!event.dataTransfer.types.includes('application/x-rm-entry') && !event.dataTransfer.types.includes('Files')) return
            event.preventDefault()
            event.stopPropagation()
            row.classList.add('s3row--over')
          })
        }
        row.addEventListener('dragleave', () => row.classList.remove('s3row--over'))
        row.addEventListener('drop', async (event) => {
          event.preventDefault()
          event.stopPropagation()
          row.classList.remove('s3row--over')
          const raw = event.dataTransfer.getData('application/x-rm-entry')
          const dest = atPath ? `${atPath}/${e.name}` : e.name
          if (raw) {
            const dragged = JSON.parse(raw)
            if (dragged.name === e.name) return
            return moveTo(dragged, dest)
          }
          // A file dragged in from the desktop, straight into this folder.
          await upload(event.dataTransfer.files, dest)
        })
      }

      const icon2 = icon(e.dir ? 'folder-01' : 'file-01', 's3row__icon')
      const label = el('button', 's3row__name')
      label.type = 'button'
      label.textContent = e.name
      label.onclick = () => {
        if (!e.dir) return
        atPath = atPath ? `${atPath}/${e.name}` : e.name
        void refresh()
      }
      const meta = el('span', 's3row__meta')
      meta.textContent = e.dir ? '' : `${human(e.size)}${e.modified ? ' · ' + ago(e.modified) : ''}`

      const full = atPath ? `${atPath}/${e.name}` : e.name
      const items = []
      if (!e.dir) {
        items.push({
          icon: 'download-01',
          text: 'Download',
          run: () => {
            // A plain link rather than fetch-then-blob: the file can be
            // gigabytes, and the browser already knows how to stream one to disk.
            const a = Object.assign(el('a'), { href: `/api/storage/${encodeURIComponent(atRemote)}/get?path=${encodeURIComponent(full)}`, download: e.name })
            document.body.append(a)
            a.click()
            a.remove()
          },
        })
      }
      items.push({
        icon: 'text-align-left',
        text: 'Rename',
        run: async () => {
          const next = prompt('Rename to', e.name)
          if (!next || next === e.name) return
          const r = await post(`/api/storage/${encodeURIComponent(atRemote)}/mv`, { from: full, to: atPath ? `${atPath}/${next}` : next, dir: e.dir })
          if (r.error) return r.error
          await refresh()
        },
      })
      items.push({
        icon: 'delete-02',
        text: e.dir ? 'Delete folder and contents' : 'Delete',
        danger: true,
        busy: 'Deleting…',
        run: async () => {
          const r = await post(`/api/storage/${encodeURIComponent(atRemote)}/rm`, { path: full, dir: e.dir })
          if (r.error) return r.error
          await refresh()
        },
      })

      const menu = actionMenu(items)
      menu.classList.add('s3row__menu')
      row.append(icon2, label, meta, menu)
      listing.append(row)
    }
  }

  /*
   * Uploading, one file at a time and streamed.
   *
   * Sequential rather than all at once: these are renders, and eight parallel
   * multi-gigabyte uploads saturate the link so that all eight crawl and none
   * finishes. One at a time means the first one is done and usable while the
   * rest are still going.
   */
  const upload = async (files, intoDir) => {
    const list = [...files]
    if (!list.length || busy) return
    busy = true
    const where = intoDir ?? atPath
    let done = 0
    const failed = []
    for (const file of list) {
      s3say(`uploading ${file.name}${list.length > 1 ? ` (${done + 1} of ${list.length})` : ''}…`)
      const r = await fetch(`/api/storage/${encodeURIComponent(atRemote)}/put?path=${encodeURIComponent(where)}&name=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: file,
        duplex: 'half',
      })
        .then((x) => x.json())
        .catch((e) => ({ error: e.message }))
      if (r.error) failed.push(`${file.name}: ${r.error.split('\n')[0]}`)
      else done++
    }
    busy = false
    if (failed.length) s3say((done ? `Uploaded ${done}. ` : '') + failed.join(' · '), done ? 'warn' : 'bad')
    else s3say(`Uploaded ${done} file${done === 1 ? '' : 's'}.`, 'ok')
    await refresh()
  }

  dropZone.append(
    icon('upload-04'),
    Object.assign(el('span', 'dropzone__lead'), { textContent: 'Drop files to upload here' }),
    Object.assign(el('span', 'dropzone__sub'), { textContent: 'or drop them straight onto a folder above' }),
  )
  const s3Picker = Object.assign(el('input'), { type: 'file', multiple: true })
  s3Picker.hidden = true
  dropZone.onclick = () => s3Picker.click()
  s3Picker.onchange = () => {
    const files = [...s3Picker.files]
    s3Picker.value = ''
    void upload(files)
  }
  for (const ev of ['dragenter', 'dragover']) {
    dropZone.addEventListener(ev, (e) => {
      e.preventDefault()
      dropZone.classList.add('dropzone--over')
    })
  }
  for (const ev of ['dragleave', 'drop']) dropZone.addEventListener(ev, () => dropZone.classList.remove('dropzone--over'))
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault()
    void upload(e.dataTransfer?.files ?? [])
  })

  /*
   * Only the newest listing is allowed to paint.
   *
   * A listing is a network round trip to S3, and clicking through folders — or
   * switching remote — starts a second one before the first has answered. Without
   * this the slower, older request paints last: choosing a different remote and
   * watching the previous remote's contents appear, which reads as the select
   * being broken rather than as a race.
   */
  let listingSeq = 0

  const refresh = async () => {
    const mine = ++listingSeq
    paintCrumbs()
    listing.innerHTML = ''
    listing.append(el('p', 'empty', 'Reading…'))
    const r = await fetch(`/api/storage/${encodeURIComponent(atRemote)}/ls?path=${encodeURIComponent(atPath)}`)
      .then((x) => x.json())
      .catch((e) => ({ ok: false, err: e.message }))
    if (mine !== listingSeq) return
    if (!r.ok) {
      entries = []
      listing.innerHTML = ''
      /*
       * Say what went wrong, and offer the one thing worth doing about it.
       *
       * This read "could not read that remote" and stopped, which is the least
       * useful thing it could say: the remote might be misconfigured, or
       * offline, or — the case that actually happened — the Studio might have
       * been restarting under --watch when the request went out. Those want very
       * different responses and the panel named none of them.
       *
       * rclone stamps every line with a date and an ERROR prefix that says
       * nothing; what follows it is the part that names the cause.
       */
      const why = String(r.err || '')
        .split('\n')[0]
        .replace(/^\d{4}\/\d{2}\/\d{2} [\d:]+ ERROR : /, '')
        .trim()
      listing.append(Object.assign(el('p', 'empty'), { textContent: why || 'That listing did not come back. The Studio may have been restarting.' }))
      const again = el('button', 'btn ghost', 'Try again')
      again.onclick = () => void refresh()
      const retryRow = el('div', 'row')
      retryRow.style.padding = 'var(--op-space-small)'
      retryRow.append(again)
      listing.append(retryRow)
      return
    }
    entries = r.entries
    paintList()
  }

  m.append(crumbRow, listing, dropZone, s3Picker, s3Hint)
  void refresh()

  m.append(el('div', 'client', 'Configured remotes'))
  const g = el('div', 'grid')
  for (const r of S.remotes) {
    const c = el('div', 'card')
    const b = el('div', 'body')
    b.append(el('div', 'nm', r))
    const status = el('div', 'meta', '')
    const row = el('div', 'row')

    const editIt = el('button', 'btn ghost', 'Edit')
    editIt.onclick = () => edit(r)

    /*
     * Credentials that saved are not credentials that work, and the gap only
     * shows up much later in a failed sync. Listing the buckets is the cheapest
     * call that actually authenticates.
     */
    const test = el('button', 'btn ghost', 'Test')
    test.onclick = async () => {
      test.disabled = true
      status.textContent = 'testing…'
      const t = await (await fetch('/api/storage/' + encodeURIComponent(r), { method: 'POST' })).json()
      test.disabled = false
      status.textContent = t.ok ? (t.buckets.length ? 'reachable — ' + t.buckets.length + ' bucket' + (t.buckets.length === 1 ? '' : 's') + ': ' + t.buckets.join(', ') : 'reachable — no buckets yet') : 'failed — ' + (t.err || '').split('\n')[0].slice(0, 90)
    }

    /*
     * Deleting a remote goes in a menu, like everything else destructive.
     *
     * It was a red slab beside Edit and Test — the same mistake the asset cards
     * had: the one action you cannot undo, at full size, next to two you might
     * press on the way past. Worse here than on a file, because there is no
     * .trash to drag a credential back out of.
     */
    const remoteMenu = actionMenu([
      {
        icon: 'delete-02',
        text: 'Delete this remote',
        danger: true,
        busy: 'Deleting…',
        run: async () => {
          const d = await (await fetch('/api/storage/' + encodeURIComponent(r), { method: 'DELETE' })).json()
          if (!d.ok) return (d.err || '').split('\n')[0].slice(0, 90) || 'could not delete that remote'
          if (editing === r) newRemote()
          await load()
        },
      },
    ])
    remoteMenu.classList.add('s3row__menu')

    row.append(editIt, test, remoteMenu)
    b.append(status, row)
    c.append(b)
    g.append(c)
  }
  m.append(g)
}

load()

/*
 * Say so when this window is behind the files on disk.
 *
 * The Studio is edited while it is being used, and a window holding an older
 * studio.js is indistinguishable from a feature that does not work — a missing
 * swatch row, a button that is not there, an empty panel. Each has been reported
 * as a bug in the feature rather than as a stale page, repeatedly.
 *
 * Checked on load and whenever the window is focused, because coming back to it
 * is exactly when somebody is about to be confused by it.
 */
;(() => {
  const mine = document.querySelector('meta[name="rm-studio-client"]')?.content
  if (!mine) return
  let banner = null
  const check = async () => {
    const r = await fetch('/api/client-stamp')
      .then((x) => x.json())
      .catch(() => null)
    if (!r || r.stamp === mine || banner) return
    banner = el('button', 'btn')
    banner.textContent = 'This window is running older Studio code — click to reload'
    banner.style.cssText = 'position:fixed;inset-block-end:var(--op-space-large);inset-inline-start:50%;transform:translateX(-50%);z-index:60'
    banner.onclick = () => location.reload()
    document.body.append(banner)
  }
  check()
  window.addEventListener('focus', check)
})()
