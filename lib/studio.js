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

/*
 * A pinned rail beats the width rule.
 *
 * The shape is normally chosen by how much room there is, which is right until
 * somebody wants the room for the work instead.
 *
 * Kept on disk, not in the browser — the same reason the last panel is. Studio
 * asks the OS for a free port on every launch, so the page's origin changes each
 * start and anything stored against it is unreachable afterwards. A preference
 * that silently forgets itself on restart is worse than no preference.
 *
 * Held here as well so the shape can be applied before state arrives; the server
 * is the copy that survives.
 */
/* Seeded from the markup the server sent, which already carries the saved
   preference — so the first paint and this agree and nothing animates. The
   fetched state still confirms it a moment later. */
let railPin = document.documentElement.dataset.rail === 'on'
const railPinned = () => railPin

function applySidebarShape() {
  // The markup says `class="sidebar sidebar--drawer"`, so this is found by class.
  // Guarded because a nav that is not there must not be able to stop the app: the
  // pasted version's only symptom was a blank page.
  const sidebar = document.querySelector('.sidebar')
  if (!sidebar) return
  const shape = railPinned()
    ? 'sidebar--rail'
    : (SIDEBAR_SHAPES.find((s) => window.matchMedia(s.query).matches)?.className ?? SIDEBAR_DEFAULT)
  sidebar.classList.remove(...SIDEBAR_SHAPE_CLASSES.filter((c) => c !== shape))
  sidebar.classList.add(shape)
}

applySidebarShape()

/*
 * Wired from load(), not here: this runs at module scope, above el() and icon(),
 * and calling it now throws on a const that has not been initialised yet.
 */
function mountRailPin() {
  const pin = document.querySelector('[data-el="railPin"]')
  if (!pin) return
  const paint = () => {
    const on = railPinned()
    pin.setAttribute('aria-pressed', String(on))
    pin.title = on ? 'Expand the sidebar' : 'Minimise the sidebar'
    pin.innerHTML = ''
    pin.append(icon(on ? 'sidebar-right-01' : 'sidebar-left-01'))
  }
  pin.onclick = () => {
    railPin = !railPin
    applySidebarShape()
    paint()
    // Fire and forget: the shape has already changed, and a failed write costs
    // the preference at next launch rather than this click.
    void fetch('/api/sidebar', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rail: railPin }),
    }).catch(() => {})
  }
  paint()
}

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
let storageSettingsOpen = false
/* Same idea for the Slack panel: once it is connected the form is a filled-in
   thing nobody needs to look at, so it collapses to a line of status. */
let slackSettingsOpen = false
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
// Assembly defaults to the multi-source workflow; the earlier paper edit stays
// available when one recording is genuinely all the material there is.
let assemblyMode = 'multi'
const $ = (s, r = document) => r.querySelector(s)
const el = (t, c, x) => {
  const n = document.createElement(t)
  if (c) n.className = c
  if (x != null) n.textContent = x
  return n
}

/*
 * Transcript selection changes a small amount of state, but the early Studio
 * views repainted the whole transcript to show it. Replacing a scrolling list
 * resets its scroll position; seeking the player at the same time makes the
 * active-cue handler scroll it again. The result is a person clicking word two
 * hundred and landing somewhere else before they can click word two hundred
 * and one.
 *
 * Keep the same word at the same screen position across the repaint. This is
 * deliberately shared by the Paper Edit, Canvas scene review, and Scene
 * builder review so choosing a precise range feels the same wherever it starts.
 */
function repaintTranscriptKeepingPosition(root, wordIndex, repaint) {
  const lines = root?.querySelector('.paper-edit__lines')
  const token = root?.querySelector(`[data-rm-word="${wordIndex}"]`)
  const scrollTop = lines?.scrollTop
  const screenTop = token?.getBoundingClientRect().top
  repaint()
  window.requestAnimationFrame(() => {
    const nextLines = root?.querySelector('.paper-edit__lines')
    if (nextLines && Number.isFinite(scrollTop)) nextLines.scrollTop = scrollTop
    const nextToken = root?.querySelector(`[data-rm-word="${wordIndex}"]`)
    if (!nextToken || !Number.isFinite(screenTop)) return
    const delta = nextToken.getBoundingClientRect().top - screenTop
    if (Math.abs(delta) > 1) window.scrollBy(0, delta)
  })
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

/*
 * Routes normally answer JSON, but a Studio that has not been restarted after an
 * update can still answer a newly added route with its plain-text "not found".
 * Do not let that turn into an unrelated SyntaxError in the interface: preserve
 * the useful response so the panel can say what actually happened.
 */
/**
 * One sentence about the silence a build removed, or nothing.
 *
 * A clip that spanned its whole file has been trimmed to its speech; say so,
 * with the total, so the change is visible rather than discovered in the cut.
 */
function trimNote(trimmed) {
  const trims = Array.isArray(trimmed) ? trimmed : []
  if (!trims.length) return ''
  const seconds = trims.reduce((total, item) => total + (Number(item.headMs) || 0) + (Number(item.tailMs) || 0), 0) / 1000
  return ` ${trims.length} clip${trims.length === 1 ? ' was' : 's were'} trimmed to speech (${seconds.toFixed(1)}s of silence removed).`
}

async function responseJson(response) {
  const raw = await response.text()
  try {
    return raw ? JSON.parse(raw) : {}
  } catch {
    if (response.status === 404 && raw.trim() === 'not found') {
      return { error: 'This Studio window is still running an older server. Restart Studio, then try again.' }
    }
    return { error: raw || `Studio returned ${response.status}.` }
  }
}

/*
 * Studio owns the selected library project; the recording HUD is another
 * renderer owned by OpenScreen. Keep that destination in sync whenever Studio
 * loads state, so a capture started from the HUD lands in this project's
 * Footage folder rather than the application's generic recordings folder.
 *
 * This bridge only exists in the hosted app. A browser-running Studio keeps the
 * same ordinary capture behaviour and never receives a filesystem capability.
 */
async function syncHudCaptureTarget() {
  if (!window.rmStudio?.setCaptureTarget) return
  try {
    const r = await fetch('/api/capture-target').then(responseJson)
    await window.rmStudio.setCaptureTarget(r.target ?? null)
  } catch {
    // A failed handoff must clear the old project: recording into yesterday's
    // project would be worse than using OpenScreen's normal recordings folder.
    await window.rmStudio.setCaptureTarget(null).catch(() => {})
  }
}

async function load({ restoreLastView = true } = {}) {
  // The wallpaper drawing code, imported from the same file the batch renderer
  // uses. Loaded once; every preview and every export goes through it.
  paintNavIcons()
  paintDocsLink()
  // Beside them, not inside paintDocsLink: that one returns early once wired,
  // so anything it called ran exactly once — and whether you are signed in
  // changes, which is the whole reason this button appears and disappears.
  void paintSignOut()
  if (!WP) WP = await import('/wallpaper.mjs')
  // The same parser lib/narration.mjs uses. Served, not re-implemented — a
  // preview that disagrees with the synthesiser is worse than no preview.
  if (!SP) SP = await import('/script-parse.mjs')
  if (!DS) DS = await import('/demo-script.mjs')
  S = await responseJson(await fetch('/api/state'))
  await syncHudCaptureTarget()
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
   * Checked rather than trusted: the stored name comes from a file that outlives
   * any given build, so a panel that has since been renamed or removed would
   * reach the dispatch table as `undefined` and take the whole page down with it
   * — a blank window whose cause is a word in a config file.
   *
   * Checked against VIEWS, not against the nav. The nav carries ten destinations;
   * the app has twenty-five, and the seven pipeline stages — the ones somebody is
   * most likely to be in the middle of — are none of them. Validating against the
   * sidebar meant quitting during Assembly and reopening never returned there,
   * which is the one case this whole mechanism exists for. VIEWS is the set of
   * names that cannot throw, which is what the guard was actually protecting.
   *
   * Two panels are excluded on purpose. The Editor and Review both open something
   * chosen elsewhere, and that choice lives in memory only, so restoring either
   * lands on a panel with nothing in it — which is indistinguishable from the app
   * being broken.
   */
  const NEEDS_A_DOCUMENT = new Set(['editor', 'review'])
  if (restoreLastView && S.lastView && Object.hasOwn(VIEWS, S.lastView) && !NEEDS_A_DOCUMENT.has(S.lastView)) view = S.lastView
  // The nav's shape arrives with the rest of the state, so a pinned rail is
  // pinned from the first paint rather than snapping narrow a moment later.
  railPin = Boolean(S.sidebarRail)
  applySidebarShape()
  mountRailPin()
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
  const nav = mountRow('breadcrumbs-nav').root
  /*
   * The last crumb is the stage control, when the page is a stage.
   *
   * It already says where you are; this makes that word the way to somewhere
   * else, instead of a row of eight pills repeating it underneath.
   */
  const stages = stageMenu()
  parts.forEach((part, i) => {
    const last = i === parts.length - 1
    if (last && stages) {
      nav.append(stages)
    } else if (last || !part.go) {
      const t = mountRow('crumb-label').root
      t.textContent = part.label
      if (last) t.setAttribute('aria-current', 'page')
      nav.append(t)
    } else {
      const a = mountRow('crumb-anchor').root
      a.textContent = part.label
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
      nav.append(mountRow('crumb-slash').root)
    }
  })
  // The switcher first: it says which space you are in, and the trail says where
  // you are inside it. Reading order follows the scope.
  host.append(projectSwitcher())
  host.append(nav)
  // HyperFrames is the content of this view, not a second application wrapped
  // in Studio furniture. Its small set of navigation actions belongs beside the
  // other page-level controls in the real Studio header.
  if (view === 'hyperframes' && hyperframesWorkspace?.url) {
    const { root: actions, el: hf } = mountRow('hyperframes-header-actions')
    const projectMedia = hf.projectMedia
    projectMedia.onclick = () => openProjectLibrary(currentProject())
    const latestExport = hyperframesWorkspace.exports?.[0]
    if (latestExport) projectMedia.textContent = 'View exported video'
    hf.all.onclick = () => {
      hyperframesWorkspace = null
      render()
    }
    if (hyperframesWorkspace.folder === 'multi-clip-assembly') {
      hf.revise.hidden = false
      hf.revise.onclick = () => {
        pendingAssemblyRevision = true
        hyperframesWorkspace = null
        assemblyMode = 'multi'
        go('paperedit')
      }
    }
    /*
     * The composition's own controls, here rather than in a second bar above
     * the editor. Two places to look for the buttons that act on one video is
     * one place too many, and the panel row was the newer of the two.
     *
     * They are wired by the workspace, which owns the frame and the reload — so
     * the handles are handed over and vHyperframes attaches the behaviour once
     * the frame it acts on exists.
     */
    hyperframesActions = hf
    host.append(actions)
  }
  // Storage is usually a browser. Its credentials belong in the app header's
  // overflow, where they are available without stealing the page from the files.
  if (view === 'storage') {
    host.append(actionMenu([{ icon: 'settings-02', text: 'Storage settings', run: () => {
      storageSettingsOpen = true
      render()
    } }], 'Storage settings'))
  }
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
const GLOBAL_VIEWS = new Set(['skills', 'brand', 'components', 'field', 'haze', 'wallpapers', 'storage', 'usage', 'console', 'library', 'new'])

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
async function chooseProject(id, { resume = null } = {}) {
  /*
   * The view follows the choice, here, so that both ways of choosing agree.
   *
   * `vLibrary` picks the project page over the project list by reading
   * `openProject`, and only the card click was setting it. So the header switcher
   * posted the new project, refetched, and then re-rendered the OLD one — the name
   * in the header changed and nothing under it did, which reads as a switcher that
   * does not switch.
   *
   * Opening a project IS choosing it, and the reverse is just as true: choosing one
   * from the header is opening it. One assignment, in the one function both paths
   * already go through.
  */
  openProject = id
  /*
   * Picking a project is opening its contents. It must not restore the last
   * global view (often Make Video) halfway through the reload and make a card
   * click look like it went somewhere random.
   *
   * `resume` is the exception, and it is not a restored view — it is the stage
   * the caller could already name because the project itself records it. The
   * Library card passes it so the destination matches the caption it just read.
   */
  view = resume ?? 'library'
  await fetch('/api/project/current', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  }).catch(() => {})
  await load({ restoreLastView: false })
  // The stage is where this project now is, so record the arrival like any other
  // navigation — otherwise resuming twice in a row would report the older stage.
  if (resume) saveWorkflowStage(resume)
}

/** The project you are working in, or null for the shared shelf. */
/* Which composition the Timeline view should open. Set by the card that sent
   you there; null means "whichever this project has", which is what the rail
   entry means when it is clicked directly. */
let timelineFolder = null
const currentProject = () => S?.currentProject ?? null

/** Its manifest, for a panel that wants the name or the catalog. */
const currentProjectRecord = () => S?.projects?.find((p) => p.id === currentProject()) ?? null

/* A video stage is durable project state; utility panels and the workflow home are not. */
const WORKFLOW_STAGE_BY_VIEW = {
  interview: 'plan',
  scripts: 'script',
  storyboard: 'canvas',
  record: 'record',
  paperedit: 'assembly',
  editor: 'edit',
  review: 'review',
}

/* The same table read the other way. The stage names are what the server
   persists; the views are what this app navigates to, and writing the pairing
   out twice is how the two drifted into an inline literal on the project card. */
const WORKFLOW_VIEW_BY_STAGE = Object.fromEntries(Object.entries(WORKFLOW_STAGE_BY_VIEW).map(([viewName, stage]) => [stage, viewName]))

/**
 * Where a project says it was left, if it was ever started.
 *
 * `stages.plan.startedAt` is the same test the Library card uses to decide
 * whether to say "Video in progress", so the label and this destination cannot
 * disagree — a card that advertises Assembly and then opens the media shelf is
 * the app knowing the answer and not using it.
 */
function resumeViewFor(project) {
  if (!project?.workflow?.stages?.plan?.startedAt) return null
  return WORKFLOW_VIEW_BY_STAGE[project.workflow.currentStage] ?? null
}

function saveWorkflowStage(viewName) {
  const projectId = currentProject()
  const stage = WORKFLOW_STAGE_BY_VIEW[viewName]
  if (!projectId || !stage) return
  void fetch('/api/workflow/stage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId, stage }),
  }).catch(() => {})
}

/**
 * The stable part of every trail inside a project.
 *
 * The project switcher answers “which project?”, but it is not a way back.
 * Keep the project itself in the trail, between the library and the tool being
 * used, so every project view has both a one-level-up destination and a route
 * all the way back to the library.
 */
function scopedCrumbs(parts = []) {
  const project = currentProjectRecord()
  if (!project || betweenProjects()) return parts

  const trail = [{ label: VIEW_LABEL.library, go: () => go('library') }]
  if (!parts.length) return [...trail, { label: project.name }]

  /*
   * `openProject` is UI state, intentionally not persisted. The selected project
   * survives a Studio restart, though — which meant this link could ask to
   * "preserve" a null value and land on All projects instead of this project's
   * media page. A breadcrumb is a concrete destination, not an instruction to
   * preserve whatever happened to be on screen before it.
   */
  trail.push({ label: project.name, go: () => openProjectLibrary(project.id) })
  return [...trail, ...parts]
}

/** Open the selected project's media page, including after a Studio restart. */
function openProjectLibrary(id) {
  openProject = id
  go('library', { preserveProject: true })
}

/**
 * The space you are working in, chosen once.
 *
 * Not rendered on a panel that has nothing to do with a project: showing a project
 * name above the Components gallery would say this page is scoped to it, and it is
 * not.
 */
function projectSwitcher() {
  const wrap = mountRow('projmenu').root
  wrap.replaceChildren()
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
  const { el: shell } = mountRow('projmenu')
  const { trigger, menu } = shell
  trigger.append(icon(record ? 'folder-library' : 'folder-add', 'projmenu__mark'), control('span', { className: 'projmenu__label', textContent: label }), icon('arrow-up-01', 'projmenu__caret'))
  wrap.append(trigger, menu)

  let opening = false
  // projectSwitcher is built before render() attaches it to the main header.
  // Resolve that ancestor when the menu opens, not when this function runs, so
  // the hosted editor can move out of the menu's way instead of clipping it.
  const header = () => wrap.closest('.op-page__main-header')

  /*
   * Browser content cannot paint above the hosted editor: it is a native view,
   * not another DOM layer. Make room in the header before showing its project
   * menu, then move that native view down to the resized editor frame.
   */
  const reserveMenuSpace = () => {
    const hostHeader = header()
    if (!hostHeader || !document.body.classList.contains('has-editor')) return
    const menuRect = menu.getBoundingClientRect()
    const headerRect = hostHeader.getBoundingClientRect()
    const clearance = Math.max(0, Math.ceil(menuRect.bottom - headerRect.bottom))
    hostHeader.style.setProperty('--projmenu-editor-clearance', `${clearance}px`)
  }

  const close = () => {
    opening = false
    menu.hidden = true
    menu.style.removeProperty('visibility')
    header()?.style.removeProperty('--projmenu-editor-clearance')
    trigger.setAttribute('aria-expanded', 'false')
    void relayoutHostedEditor()
  }

  const open = async () => {
    opening = true
    // Measure while it occupies layout but do not reveal it until the native
    // editor has moved below it. That avoids a single-frame partial menu.
    menu.style.visibility = 'hidden'
    menu.hidden = false
    trigger.setAttribute('aria-expanded', 'true')
    reserveMenuSpace()
    await relayoutHostedEditor()
    if (!opening || menu.hidden) return
    menu.style.removeProperty('visibility')
    menu.querySelector('.projmenu__item')?.focus()
  }

  const choose = async (id) => {
    close()
    await chooseProject(id)
  }

  const item = (iconName, text, onPick, { current = false, note = null } = {}) => {
    const { root: b, el: entry } = mountRow('projmenu-item')
    if (current) b.setAttribute('aria-current', 'true')
    b.prepend(icon(iconName))
    entry.text.textContent = text
    if (note) {
      entry.note.hidden = false
      entry.note.textContent = note
    }
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

  menu.append(mountRow('projmenu-sep').root)
  item('folder-library', 'All projects', () => {
    close()
    go('library')
  })
  item('folder-add', 'New project', () => {
    close()
    go('new')
  })

  trigger.onclick = () => {
    if (menu.hidden) void open()
    else close()
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
  workflow: 'video-01',
  record: 'record',
  make: 'command',
  recast: 'test-tube',
  editor: 'scissor-01',
  hyperframes: 'timeline',
  review: 'comment-01',
  storyboard: 'artboard',
  interview: 'comment-01',
  paperedit: 'ai-editing',
  cut: 'timeline',
  compose: 'film-01',
  timeline: 'timeline',
  scenes: 'grid-view',
  scripts: 'file-01',
  voice: 'mic-01',
  skills: 'ai-editing',
  brand: 'paint-board',
  wallpapers: 'image-01',
  components: 'layout-grid',
  field: 'blur',
  haze: 'colors',
  restyle: 'magic-wand-01',
  storage: 'database-01',
  usage: 'analytics-01',
  console: 'console',
}

/*
 * An icon, by name, declarable in markup.
 *
 * `<rm-icon name="file-01">` in a template, rather than `icon('file-01')`
 * prepended from JS after the row is cloned. The structure of a button belongs
 * in the button's own template — an icon is structure — and writing
 * `hgi-stroke hgi-file-01` by hand at every call site is three tokens, two of
 * them the same every time, where a typo in either draws nothing rather than
 * failing.
 *
 * aria-hidden, because every one of these sits beside its own words.
 */
class RMIcon extends HTMLElement {
  static observedAttributes = ['name']

  connectedCallback() {
    this.paint()
  }

  attributeChangedCallback() {
    this.paint()
  }

  paint() {
    const name = (this.getAttribute('name') ?? '').trim()
    this.setAttribute('aria-hidden', 'true')
    this.className = name ? `hgi-stroke hgi-${name}` : 'hgi-stroke'
  }
}
if (!customElements.get('rm-icon')) customElements.define('rm-icon', RMIcon)

/*
 * A mark, by name, from a file.
 *
 * `<rm-svg name="claude">` instead of two kilobytes of path data pasted into the
 * markup. Path data in a template is unreadable, undiffable, and duplicated
 * wherever the mark appears — and the one thing you cannot do with it is tell at
 * a glance which mark it is.
 *
 * Inlined rather than an <img>, so the document can reach inside it: a mark
 * drawn with `currentColor` follows the text it sits beside, which an image
 * cannot do. Marks that carry their own brand colour simply ignore that.
 *
 * One fetch per name however many times it appears — the promise is cached, not
 * the element, so ten of the same mark on a page is one request and not ten.
 */
const MARKS = new Map()

class RMSvg extends HTMLElement {
  static observedAttributes = ['name']

  connectedCallback() {
    this.paint()
  }

  attributeChangedCallback() {
    this.paint()
  }

  async paint() {
    const name = (this.getAttribute('name') ?? '').trim()
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' })
    if (!name) {
      this.shadowRoot.replaceChildren()
      return
    }
    if (!MARKS.has(name)) {
      MARKS.set(
        name,
        fetch(`/brand/marks/${encodeURIComponent(name)}.svg`)
          .then((r) => (r.ok ? r.text() : ''))
          .catch(() => ''),
      )
    }
    const markup = await MARKS.get(name)
    /* The name can change while a fetch is in flight; only the current one wins. */
    if ((this.getAttribute('name') ?? '').trim() !== name) return
    /*
     * A missing mark draws nothing rather than a broken image, and says so where
     * somebody will see it: this is a filename, and a typo in one is the whole
     * failure mode.
     */
    if (!markup) {
      this.shadowRoot.replaceChildren()
      this.title = this.title || `No mark named "${name}"`
      return
    }
    this.shadowRoot.innerHTML = `<style>:host{display:inline-flex;align-items:center;inline-size:1em;block-size:1em}svg{inline-size:100%;block-size:100%;display:block}</style>${markup}`
  }
}
if (!customElements.get('rm-svg')) customElements.define('rm-svg', RMSvg)

/** Set a button's words without taking its template icon with them. */
function setLabel(button, text) {
  const mark = button.querySelector(':scope > rm-icon, :scope > .hgi-stroke')
  button.textContent = ''
  if (mark) button.append(mark)
  button.append(text)
}

/** The same icon, for the call sites that still build their row in JS. */
function icon(name, cls) {
  const i = mountRow('icon-glyph').root
  i.className = 'hgi-stroke hgi-' + name + (cls ? ' ' + cls : '')
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

/*
 * Sign out, at the floor of the sidebar.
 *
 * Painted from the sharing state rather than from a panel, because who you are
 * is app-wide: the Storyboard is simply where you happen to sign IN. Hidden
 * whenever there is no session, so it never sits there as a control that cannot
 * do anything.
 *
 * Asked for once per render rather than polled — the answer only changes when
 * somebody signs in or out, and both of those repaint.
 */
async function paintSignOut() {
  const b = $('#signout')
  if (!b) return
  if (!b.dataset.wired) {
    b.dataset.wired = '1'
    b.prepend(icon('logout-01'))
    b.onclick = async () => {
      await fetch('/api/board/signout', { method: 'POST' }).catch(() => {})
      await paintSignOut()
      // A panel showing "signed in as" has to hear about this, and the Storyboard
      // is the only one that does — re-rendering the current view is cheaper than
      // a subscription for a thing that happens twice a day.
      render()
    }
  }
  const sh = await fetch('/api/board/sharing')
    .then((x) => x.json())
    .catch(() => null)
  b.hidden = !sh?.signedInAs
  b.title = sh?.signedInAs ? `Signed in as ${sh.signedInAs}` : ''
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
  field: 'Animated field',
  haze: 'Pixel haze',
  restyle: 'Restyle',
  library: 'All projects',
  editor: 'Editor',
  hyperframes: 'Motion editor',
  review: 'Review',
  new: 'New project',
  create: 'New video',
  workflow: 'Video',
  record: 'Record a screen',
  make: 'Make from a script',
  recast: 'From a test',
  storyboard: 'Storyboard',
  interview: 'Interview',
  paperedit: 'Paper edit',
  cut: 'Cut',
  compose: 'Compose',
  timeline: 'Timeline',
  scenes: 'Scenes',
  scripts: 'Scripts',
  voice: 'Voice',
  skills: 'Skills',
  brand: 'Brand',
  wallpapers: 'Wallpapers',
  components: 'Components',
  storage: 'Storage',
  usage: 'Usage & spend',
  console: 'Console',
}

/*
 * The seven stages are navigation, not a checklist that disappears after a
 * result exists. Keeping the same strip in the header on every project stage
 * means there is always a way to revisit the plan, script, or canvas without
 * backing through a stack of unrelated panels.
 */
/*
 * Review comments that have come in since you last looked.
 *
 * The server watches for them and keeps the list; this is only the page's copy,
 * refreshed on a timer and whenever you navigate. Held here rather than fetched
 * where it is drawn, because two places show it — the stage trigger carries a
 * dot, and the Review entry inside carries the count — and they must agree.
 */
let reviewNotices = { unseen: 0, notices: [] }

/** The only thing the poll is allowed to touch. */
function paintNoticeDot() {
  const n = reviewNotices.unseen
  for (const trigger of document.querySelectorAll('.projmenu--stage .projmenu__trigger')) {
    trigger.classList.toggle('projmenu__trigger--new', n > 0)
    trigger.title = n ? `${n} new review comment${n === 1 ? '' : 's'}` : ''
  }
}

async function refreshReviewNotices() {
  const r = await fetch('/api/notifications').then(responseJson).catch(() => null)
  if (!r || r.error) return
  const changed = r.unseen !== reviewNotices.unseen
  reviewNotices = { unseen: r.unseen ?? 0, notices: r.notices ?? [] }
  /* A dot, not a redraw. render() tears the whole view down — videos, iframes,
     any form mid-edit — and doing that on a timer would pull the page out from
     under whoever is using it. The count inside the menu needs no repaint at
     all: fill() runs on every open. */
  if (changed) paintNoticeDot()
}

/* Marked seen when you actually arrive at Review — not when the badge is drawn,
   which would clear it before it had been read. */
async function markReviewNoticesSeen() {
  if (!reviewNotices.unseen) return
  await fetch('/api/notifications/seen', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => {})
  reviewNotices = { unseen: 0, notices: [] }
  paintNoticeDot()
}

const WORKFLOW_STAGES = [
  /*
   * Files is a stage in the strip and not a video stage.
   *
   * It is where a project opens and where footage is looked at, so leaving it
   * out meant the strip could take you six places and never back to the one you
   * started on. It has no entry in WORKFLOW_STAGE_BY_VIEW on purpose: opening
   * the file list is not progress through a video, and recording it as the
   * project's stage would overwrite the real answer.
   */
  { view: 'library', label: 'Files', icon: 'folder-library' },
  { view: 'interview', label: 'Plan', icon: 'bulb' },
  { view: 'scripts', label: 'Script', icon: 'text-align-left' },
  { view: 'storyboard', label: 'Canvas', icon: 'dashboard-square-01' },
  { view: 'record', label: 'Record', icon: 'record' },
  { view: 'paperedit', label: 'Assembly', icon: 'scissor-01' },
  { view: 'editor', label: 'Edit', icon: 'pencil-edit-02' },
  { view: 'review', label: 'Review', icon: 'comment-01' },
]

/**
 * What is finished, from the project's own files.
 *
 * One reading of the evidence, shared by the two things that show it: the hub,
 * which turns it into a sentence, and the stage strip in the header, which turns
 * it into seven states. They disagreed before — the hub knew a script existed
 * and the strip beside it drew seven identical buttons — because the hub
 * computed this inline and nothing else could reach it.
 *
 * `null` where there is no local evidence to read, which is not the same as
 * `false`: Review is only recorded in OpenFrame, and the strip should not claim
 * a step is unstarted when it simply cannot tell.
 */
function workflowCompletion({ interview, board, assembly, alignment } = {}, project) {
  const scripts = (S.scripts ?? []).filter((script) => script.project === project?.id)
  const videos = (project?.catalog?.files ?? []).filter((file) => file.kind === 'video')
  const renders = videos.filter((file) => /^Renders\//.test(String(file.rel ?? '')))
  const assemblyPicks = assembly?.state?.picks ?? []
  const assemblyTimeline = Boolean(assembly?.state?.hyperframesProject)
  const alignmentSegments = alignment?.state?.segments ?? []
  return {
    plan: { done: Boolean(interview?.state?.plan?.shots?.length), started: (interview?.state?.turns?.length ?? 0) > 0 },
    script: { done: scripts.length > 0, started: false },
    canvas: { done: Boolean(board?.board?.slots?.length), started: false },
    record: { done: videos.length > 0, started: false },
    assembly: { done: assemblyTimeline, started: assemblyPicks.length > 0 || alignmentSegments.length > 0 },
    edit: { done: renders.length > 0, started: assemblyTimeline },
    review: { done: null, started: renders.length > 0 },
  }
}

/*
 * The evidence behind the header strip, cached per project.
 *
 * The strip is drawn synchronously with the breadcrumbs and the evidence is five
 * fetches away, so it paints from the last reading and is corrected in place when
 * a fresh one lands. Keyed by project so switching cannot show the previous one's
 * progress against the new one's name.
 */
let stageEvidence = { projectId: null, completion: null }

async function refreshStageEvidence() {
  const id = currentProject()
  if (!id) return
  const read = async (url) => {
    const response = await fetch(url).catch(() => null)
    if (!response?.ok) return null
    return response.json().catch(() => null)
  }
  const encoded = encodeURIComponent(id)
  const [interview, board, assembly, alignment] = await Promise.all([
    read(`/api/interview?project=${encoded}`),
    read(`/api/board?project=${encoded}`),
    read(`/api/multi-assembly?project=${encoded}`),
    read(`/api/multi-assembly/audio-align?project=${encoded}`),
  ])
  // The project may have been switched while these were in flight.
  if (currentProject() !== id) return
  stageEvidence = { projectId: id, completion: workflowCompletion({ interview, board, assembly, alignment }, currentProjectRecord()) }
}

/** Apply the cached completion to whichever strip is currently on screen. */

/**
 * The stage you are on, as the last breadcrumb, opening onto the others.
 *
 * This replaced a strip of eight pills under the header. The strip showed every
 * stage at once, which sounds like more information and mostly was not: eight
 * targets competing with the page, redrawn on every navigation, to answer a
 * question — "where am I" — that the breadcrumb was already answering one line
 * above. The trail says Assembly; making that word the control is the smallest
 * thing that can also take you somewhere else.
 *
 * Progress moves inside the menu rather than being lost: each item carries done
 * or in-progress from the same reading of the evidence the strip used.
 */
function stageMenu() {
  const onFiles = view === 'library' && Boolean(openProject)
  if (!currentProject() || (GLOBAL_VIEWS.has(view) && !onFiles)) return null
  const currentView = onFiles ? 'library' : view
  const here = WORKFLOW_STAGES.find((stage) => stage.view === currentView)
  if (!here) return null

  const { root: wrap, el: shell } = mountRow('projmenu')
  wrap.classList.add('projmenu--stage')
  const { trigger, menu } = shell
  trigger.append(icon(here.icon, 'projmenu__mark'), control('span', { className: 'projmenu__label', textContent: here.label }), icon('arrow-up-01', 'projmenu__caret'))

  const close = () => {
    menu.hidden = true
    trigger.setAttribute('aria-expanded', 'false')
    void relayoutHostedEditor()
  }
  const open = async () => {
    fill()
    menu.hidden = false
    trigger.setAttribute('aria-expanded', 'true')
    /* The hosted editor is a native view and cannot be painted over, so it moves
       out of the way — the same reason the project switcher does this. */
    await relayoutHostedEditor()
    menu.querySelector('.projmenu__item')?.focus()
  }
  trigger.onclick = () => (menu.hidden ? void open() : close())
  wrap.onkeydown = (e) => {
    if (e.key === 'Escape' && !menu.hidden) {
      close()
      trigger.focus()
    }
  }
  /* Clicking anywhere else closes it. Registered per open menu and removed with
     it, so a header full of these does not accumulate listeners. */
  const away = (e) => {
    if (!wrap.contains(e.target)) close()
  }
  document.addEventListener('click', away, true)

  /*
   * Filled on open, not on render.
   *
   * The evidence behind the ticks arrives from five fetches, usually after the
   * header has already been drawn. Building the items here means the menu shows
   * what is true when somebody looks at it, and removes the need for a painter
   * that reaches back into already-rendered DOM.
   */
  const fill = () => {
  menu.replaceChildren()
  const completion = stageEvidence.projectId === currentProject() ? stageEvidence.completion : null
  for (const stage of WORKFLOW_STAGES) {
    const key = WORKFLOW_STAGE_BY_VIEW[stage.view]
    const state = key ? completion?.[key] : null
    const { root: b, el: entry } = mountRow('projmenu-item')
    const isHere = stage.view === currentView
    if (isHere) b.setAttribute('aria-current', 'true')
    b.prepend(icon(stage.icon))
    entry.text.textContent = stage.label
    /* Said in words as well as a mark: a tick and a dot are indistinguishable to
       a screen reader, and to anyone reading the two greens as one colour. */
    const said = state?.done === true ? 'done' : state?.started === true ? 'in progress' : null
    if (said) {
      entry.note.hidden = false
      entry.note.textContent = said === 'done' ? '✓' : '•'
      b.setAttribute('aria-label', `${stage.label} — ${said}`)
    }
    /* A count beats a tick here: "3" is the reason to go, where "done" is a
       state you already knew. Said in words too, for the same reason the tick
       is — a number alone does not say what it counts. */
    if (stage.view === 'review' && reviewNotices.unseen) {
      entry.note.hidden = false
      entry.note.textContent = String(reviewNotices.unseen)
      entry.note.classList.add('projmenu__note--new')
      b.setAttribute('aria-label', `${stage.label} — ${reviewNotices.unseen} new comment${reviewNotices.unseen === 1 ? '' : 's'}`)
    }
    b.onclick = () => {
      close()
      /* Files keeps the project open; go('library') alone clears it and lands on
         the project list, which is a different page. */
      if (stage.view === 'library') openProjectLibrary(currentProject())
      else go(stage.view)
    }
    menu.append(b)
  }
  }

  wrap.append(trigger, menu)
  return wrap
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

/** Stops the lightweight project-media watcher when its library page goes away. */
let stopProjectMediaWatch = null

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

/* The active HyperFrames composition stays inside Studio's workspace. Keeping
   this here mirrors editorDoc: it is a handoff, not another source of truth for
   the composition itself, which HyperFrames saves in the project folder. */
let hyperframesWorkspace = null

/* Whether the embedded editor reloads when the composition changes on disk. See
   the checkbox in vHyperframes for why this is off until somebody asks for it. */
let hyperframesWatchSource = false

/* Whether the workspace is showing the framing tool instead of the editor. A
   view of the same composition, not a separate destination. */
let hyperframesFraming = false

/* The composition controls live in the page header, and the workspace wires
   them: crumbs() paints first, so the handles are parked here for it. */
let hyperframesActions = null

/*
 * A revision begins from the assembly editor even when the person asked for it
 * while reviewing in HyperFrames. The editing surface owns the saved sources,
 * script contract and comments, so keep this as a short-lived navigation
 * handoff rather than trying to duplicate that state in the embedded editor.
 */
let pendingAssemblyRevision = false

/**
 * The canvas shot currently open in the focused scene editor, if any.
 *
 * This is context, not a second scene-editor implementation. Canvas used to
 * open a small "describe and attach footage" form, while the actual scene
 * builder — preview, component palette, and part controls — lived elsewhere.
 * Keeping the slot here lets the real builder start from the shot's brief and
 * return to the same canvas node after saving.
 */
let openBoardScene = null
/** A just-imported video, held long enough for the reloaded scene editor to select it. */
let pendingBoardVideo = null
/** The selected canvas card survives a board repaint and a responsive rail change. */
let selectedBoardNode = null

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

/** Reposition the native editor after a DOM surface above it changes size. */
async function relayoutHostedEditor() {
  if (!document.body.classList.contains('has-editor') || !window.rmStudio?.layoutEditor) return
  const frame = $('.editor-frame')
  if (!frame) return
  const rect = frame.getBoundingClientRect()
  if (rect.width < 2 || rect.height < 2) return
  try {
    await window.rmStudio.layoutEditor({
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    })
  } catch {
    // The menu remains usable even if the host is in the middle of unmounting.
  }
}

/*
 * Every view this app can draw, in one place.
 *
 * It was an object literal inside render(), which meant the only list of real
 * views was unreachable to anything else — so `load()` validated a remembered
 * view against the NAV instead, and the nav does not carry the seven pipeline
 * stages. Quitting mid-Assembly and reopening therefore always landed somewhere
 * else. The dispatch table is the right thing to check a view name against,
 * because it is exactly the set of names that will not throw.
 */
const VIEWS = {
  library: vLibrary,
  new: vNew,
  create: vCreate,
  workflow: vWorkflow,
  record: vRecord,
  make: vMake,
  editor: vEditor,
  hyperframes: vHyperframes,
  review: vReview,
  storyboard: vStoryboard,
  interview: vInterview,
  paperedit: vPaperEdit,
  cut: vCut,
  compose: vCompose,
  timeline: vTimeline,
  scenes: vScenes,
  scripts: vScripts,
  skills: vSkills,
  brand: vBrand,
  wallpapers: vWallpapers,
  storage: vStorage,
  usage: vUsage,
  console: vConsole,
  recast: vRecast,
  components: vComponents,
  field: vField,
  haze: vHaze,
  restyle: vRestyle,
  voice: vVoice,
}

function render() {
  stopProjectMediaWatch?.()
  stopProjectMediaWatch = null
  const m = $('#main')
  /*
   * Media lets go of its socket before the view goes.
   *
   * Removing a <video> from the page does not stop what it was downloading, and
   * an iframe holding a composition is six clips doing it at once. Chrome allows
   * six connections per origin, so a couple of abandoned previews is the whole
   * budget — and then the next request simply waits, which looks like a button
   * that does nothing several panels away. The same reason the EventSource below
   * is closed here rather than left to be collected.
   */
  for (const media of m.querySelectorAll('video, audio')) {
    media.pause?.()
    media.removeAttribute('src')
    media.load?.()
  }
  for (const frame of m.querySelectorAll('iframe')) frame.src = 'about:blank'
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

  // Resolve redirects before drawing the header. Otherwise a page could render
  // the Library while its breadcrumb still named the inaccessible prior stage.
  const PARENT_VIEW = { new: 'library' }
  const parent = PARENT_VIEW[view]
  const page = VIEW_LABEL[view] ?? view
  if (currentProject() && !GLOBAL_VIEWS.has(view)) {
    const video = view === 'workflow' ? [{ label: 'Video' }] : [{ label: 'Video', go: () => go('workflow') }, { label: page }]
    crumbs(scopedCrumbs(video))
  } else {
    crumbs(parent ? [{ label: VIEW_LABEL[parent], go: () => go(parent) }, { label: page }] : [{ label: page }])
  }
  VIEWS[view](m)
}

function go(v, { preserveProject = false } = {}) {
  // A view owns any draft it is currently editing. Give it one synchronous chance
  // to persist before render replaces its DOM; a 700ms debounce is good while
  // typing, but not when somebody clicks the next stage straight away.
  window.dispatchEvent(new Event('rm:before-navigate'))
  /*
   * Leaving the Library leaves the project page with it.
   *
   * The list and the project page are one view told apart by `openProject`, so a
   * navigation that only set `view` left that flag standing — and "All projects",
   * from the nav or from the switcher's own menu, re-rendered the single project
   * you were already looking at. The one destination in the app named for showing
   * you everything was the one that would not.
   */
  if (v === 'library' && !preserveProject) openProject = null
  // A canvas scene is edited by the shared Scenes builder. Only that builder
  // retains the handoff context. The Canvas stage itself must always be the
  // board — otherwise its stage button can reopen an old scene editor instead
  // of the canvas a person explicitly asked for.
  if (v !== 'scenes') openBoardScene = null
  saveWorkflowStage(v)

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

// A HUD capture writes directly into the selected project's Footage folder.
// Re-index quietly when it stops so the next Library render already knows about
// it, without kicking someone out of the panel they were working in.
window.rmStudio?.onCaptureSaved?.((capture) => {
  if (!capture?.projectId) return
  void fetch('/api/index/' + encodeURIComponent(capture.projectId), { method: 'POST' }).catch(() => {})
})

/* ── running things ──────────────────────────────────────────
   The Studio used to hand you a command to paste. It runs them now: POST the
   binary and an argv array, then keep the work where it was started. Console is
   available for detail, but changing pages to watch a process is a broken flow. */
let activeJobId = null,
  activeJobProblem = null

function jobDetailLink(status, id) {
  const details = control('button', { className: 'btn btn--hint btn--small', textContent: 'View details' })
  details.onclick = () => {
    jobId = id
    go('console')
  }
  status.append(' ', details)
}

function writeStatusText(status, text) {
  status.textContent = ''
  if (!status.classList.contains('activity__status')) {
    status.textContent = text
    return
  }
  const label = control('span', { className: 'activity__label', textContent: text })
  label.title = text
  status.append(label)
}

function showJobStatus(status, job, state = job.running ? 'running' : 'done') {
  if (!status) return
  const isActivity = status.classList.contains('activity__status')
  const label = job.label || 'This task'
  if (state === 'running') {
    /* Live work belongs in the persistent header strip. A local paragraph moves
       with its form and is easy to mistake for a second task as the page changes. */
    if (!isActivity) {
      if (activeJobId !== job.id) {
        activeJobId = job.id
        activeJobProblem = null
        void refreshJobs()
      }
      status.hidden = true
      return
    }
    status.hidden = false
    tone(status, 'ok')
    writeStatusText(status, `Working · ${label}`)
    return
  }
  status.hidden = false
  if (state === 'done') {
    tone(status, 'ok')
    writeStatusText(status, `${label} finished. Its result is ready in this project.`)
  } else {
    tone(status, 'bad')
    writeStatusText(status, `${label} stopped before it finished.`)
  }
  jobDetailLink(status, job.id)
}

function paintActivity() {
  const activity = $('#activity')
  if (!activity) return
  const running = allJobs.filter((item) => item.running)
  const active = activeJobId ? allJobs.find((item) => item.id === activeJobId) : null
  const job = active?.running ? active : running.at(-1) ?? active
  activity.hidden = !job && !activeJobProblem
  if (!job && !activeJobProblem) return
  activity.innerHTML = ''
  const status = control('hint', { className: 'activity__status' })
  if (activeJobProblem) {
    tone(status, 'bad')
    writeStatusText(status, activeJobProblem)
  } else if (running.length > 1) {
    tone(status, 'ok')
    writeStatusText(status, `${running.length} tasks are working in the background.`)
    jobDetailLink(status, job.id)
  } else {
    showJobStatus(status, job, job.running ? 'running' : job.code === 0 ? 'done' : 'failed')
  }
  activity.append(status)
}

async function watchJobInPlace(job, status, done) {
  const check = async () => {
    const data = await fetch('/api/jobs')
      .then(responseJson)
      .catch(() => null)
    const current = data?.jobs?.find((item) => item.id === job.id)
    if (!current) {
      activeJobProblem = 'Studio lost track of this task before it finished.'
      paintActivity()
      if (status) {
        tone(status, 'bad')
        status.hidden = false
        status.textContent = activeJobProblem
      }
      done?.(null)
      return
    }
    if (current.running) {
      showJobStatus(status, current, 'running')
      return setTimeout(check, JOB_POLL_MS)
    }
    showJobStatus(status, current, current.code === 0 ? 'done' : 'failed')
    done?.(current)
  }
  activeJobId = job.id
  activeJobProblem = null
  void refreshJobs()
  void check()
}

async function start(step, { status = null } = {}) {
  const r = await fetch('/api/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(step) }).then(responseJson)
  if (r.error) {
    if (status) {
      tone(status, 'bad')
      status.hidden = false
      status.textContent = r.error
    } else {
      alert(r.error)
    }
    return null
  }
  jobId = r.job.id
  // Every background task reports from one persistent point in the header.
  // Its initiating form stays focused on the work; it only receives a local
  // result or error once the job has actually finished.
  activeJobId = r.job.id
  activeJobProblem = null
  refreshJobs()
  return r.job
}

async function runWithStatus(step, button, status, done) {
  button.disabled = true
  if (status) status.hidden = true
  const job = await start(step, { status })
  if (!job) {
    button.disabled = false
    return null
  }
  watchJobInPlace(job, status, (current) => {
    button.disabled = false
    done?.(current)
    refreshJobs()
  })
  return job
}

/** Display form of an argv array. For reading, never for re-parsing. */
function show(step) {
  const q = (s) => (/[\s"']/.test(s) ? JSON.stringify(s) : s)
  return step.shell ? step.shell : [step.bin, ...(step.args || [])].map(q).join(' ')
}

/** A command with a Run button and the exact argv beside it. */
function runRow(step, label) {
  const { root: row, el: parts } = mountRow('runrow')
  parts.run.textContent = label || 'Run ' + (step.label || step.bin)
  parts.argv.textContent = show(step)
  parts.run.onclick = () => runWithStatus(step, parts.run, parts.status)
  parts.note.hidden = !step.note
  if (step.note) parts.note.textContent = step.note
  return row
}

async function refreshJobs() {
  const d = await responseJson(await fetch('/api/jobs'))
  allJobs = d.jobs
  shellOn = d.shell
  const n = allJobs.filter((j) => j.running).length
  $('#jobn').textContent = n ? String(n) : ''
  paintActivity()
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
  const { root: group, el: parts } = mountRow('form-group')
  const labelNode = parts.label
  labelNode.textContent = label
  // Tag the real controls, not the wrapper: some fields hand over a div holding
  // a select plus a fallback input, and .form-control on the div styles nothing.
  const controls = control.matches?.('input, select, textarea') ? [control] : [...control.querySelectorAll('input, select, textarea')]
  const isSwitch = control.classList?.contains('switch')
  // A switch owns its input's dimensions. Giving its hidden native checkbox
  // .form-control turns it back into a full-size checkbox before Optics can draw
  // the small track, so it is the one wrapped control that stays unadorned.
  if (!isSwitch) for (const c of controls) c.classList.add('form-control')
  const booleanControl = controls.length === 1 && /^(checkbox|radio)$/.test(controls[0].type)
  // Optics' inline pattern is the input followed by its label. Putting a checkbox
  // under a normal stacked group is why the right rail's booleans looked unlike
  // controls everywhere else — this keeps the markup and the layout together.
  if (booleanControl && (controls[0] === control || isSwitch)) {
    group.classList.add('form-group--inline')
    group.append(control, labelNode)
  } else {
    group.append(labelNode, control)
  }
  /*
   * A written-out hint under every field is noise, not help.
   *
   * There were seventeen of them, one under nearly every control, explaining
   * things the label already said or that nobody reads twice. Stacked down a
   * rail they turn six controls into a wall of grey prose you learn to skip —
   * and once you are skipping the static text, you skip the line that actually
   * mattered along with it.
   *
   * A STRING hint is dropped. An ELEMENT is not: those are live — the script
   * box's parse errors, the demo script's step count — rewritten as you type,
   * and they are feedback rather than instruction. Distinguishing on type
   * rather than on a flag means no call site had to change, which also keeps
   * this out of the way of another session editing the same file.
   *
   * Anything genuinely needed to operate a control belongs in its label, its
   * placeholder, or its `title` — attached to the thing it is about rather than
   * sitting under it forever.
   */
  if (hint && typeof hint !== 'string') {
    hint.classList.add('form-hint')
    group.append(hint)
  }
  form.append(group)
  return control
}

let switchNumber = 0

/** A compact Optics switch paired with a right-rail form label. */
function smallSwitch(form, label, checked = false, hint) {
  const id = `studio-switch-${++switchNumber}`
  const { root: control, el: switchParts } = mountRow('small-switch')
  const input = Object.assign(switchParts.input, { id, checked })
  // The track's label is visually hidden by Optics. The form label remains
  // visible beside it; this one gives the input its accessible name.
  Object.assign(switchParts.label, { textContent: label, htmlFor: id })
  field(form, label, control, hint)
  return input
}

/**
 * Set a hint's tone without losing its Optics class.
 *
 * Assigning className wholesale is how `form-hint` kept getting wiped: the tone
 * changes on nearly every fetch, and each assignment rebuilt the class list from
 * scratch. The Console's status line deliberately does not use this — it is not
 * in a form, and Optics italicises .form-hint.
 */
/*
 * Send a panel's status line to the one place statuses are shown.
 *
 * Panels report by setting `.textContent` on a node they were handed, usually
 * after `tone()` and `hidden = false` — three lines, in four different orders,
 * at sixty sites. Rewriting each was the obvious move and the wrong one: the
 * shapes vary enough that a mechanical pass would have quietly changed
 * behaviour somewhere.
 *
 * So the node changes rather than the writes. Its own `textContent`, `hidden`
 * and `className` are redefined on the instance, which shadows the prototype's
 * accessors: every existing line still runs, the words arrive top right, and
 * the element itself stays hidden and empty in the page. It is still a real
 * Node, because most of these are appended somewhere.
 *
 * `tone()` sets `className`, so that is where the level is read from.
 */
function statusSink(node) {
  if (!node) return node
  let level = 'ok'
  node.setAttribute('hidden', '')
  Object.defineProperty(node, 'textContent', {
    configurable: true,
    get: () => '',
    set(text) {
      const said = String(text ?? '').trim()
      // Clearing a status is not an announcement; only new words are.
      if (said) toast(said, level)
    },
  })
  Object.defineProperty(node, 'hidden', { configurable: true, get: () => true, set() {} })
  Object.defineProperty(node, 'className', {
    configurable: true,
    get: () => '',
    set(names) {
      level = / bad\b/.test(` ${names}`) ? 'bad' : 'ok'
    },
  })
  return node
}

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
/*
 * Everything that reports goes to the one place that reports.
 *
 * This used to write into whatever node it was handed, so a result appeared
 * wherever the control that caused it happened to sit — in a footer under the
 * cursor, in a panel you had already scrolled past, or as a green bar between
 * two lists. Forty-odd call sites each chose their own corner of the page.
 *
 * The node argument is kept, and kept ignored: converting every caller in one
 * change is how a message goes missing, and the calls read the same either way.
 * Anything that genuinely belongs beside a control — a hint, a label — sets its
 * own text and never came through here.
 */
const says = (_node, text, level) => toast(text, level === 'bad' ? 'bad' : 'ok')

/*
 * Say that something finished, in the one place that says so.
 *
 * Inline notes are right for a message about a control — a validation error
 * belongs beside the field it is about. They are wrong for "that worked": the
 * note appears after the click, in the footer, and pushes the buttons apart
 * under the cursor. This is fixed, takes no layout space, and clears itself.
 *
 * Errors may pass through here too, but they do not disappear as quickly: a
 * confirmation you miss costs nothing, a failure you miss costs the work.
 */
let toastTimer = null
function toast(text, level = 'ok') {
  const node = $('#toast')
  if (!node || !text) return
  node.textContent = text
  node.hidden = false
  node.className = 'toast' + (level === 'bad' ? ' toast--bad' : '')
  // Next frame, so a re-shown toast transitions from hidden rather than jumping.
  requestAnimationFrame(() => node.classList.add('toast--shown'))
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    node.classList.remove('toast--shown')
    // Hidden only after the fade, or it vanishes instead of fading.
    toastTimer = setTimeout(() => { node.hidden = true }, 200)
  }, level === 'bad' ? 6000 : 3200)
}

/** A group holding something that is not a labelled control — a button, a note. */
function fieldRow(form, node, { inline = false } = {}) {
  const group = mountRow('form-group-bare').root
  if (inline) group.classList.add('form-group--inline')
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
  const { root: group, el: bits } = mountRow('path-field')
  bits.label.textContent = label
  const input = Object.assign(bits.input, { value: opts.value || '', placeholder: opts.placeholder || '' })
  const { browse, panel, hint } = bits
  form.append(group)

  const settle = () => {
    panel.replaceChildren()
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
    const d = await responseJson(await fetch('/api/browse' + (path ? '?path=' + encodeURIComponent(path) : '')))
    panel.replaceChildren()
    const { root: box, el: pane } = mountRow('browser')
    if (d.error) {
      pane.filter.hidden = true
      const bad = mountRow('browser-error').root
      bad.textContent = d.error
      pane.rows.append(bad)
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
      pane.chips.hidden = false
      for (const place of d.places) {
        const c = mountRow('browser-chip').root
        c.textContent = place.name
        if (place.path === d.path) c.disabled = true
        c.onclick = () => open(place.path)
        pane.chips.append(c)
      }
    }

    /*
     * A breadcrumb you can click, rather than a line of text and a `..`.
     *
     * Coming back up from `media/Footage` to the library root was four clicks on
     * `..`, and nothing told you how far down you were.
     */
    const hop = (label, target, current) => {
      if (current) {
        const here = mountRow('crumb-text').root
        here.textContent = label
        pane.trail.append(here)
        return
      }
      const a = mountRow('crumb-link').root
      a.textContent = label
      a.onclick = () => open(target)
      pane.trail.append(a)
    }
    hop('~', d.home, d.path === d.home)
    for (const [i, c] of (d.crumbs ?? []).entries()) {
      const slash = mountRow('crumb-text').root
      slash.textContent = '/'
      pane.trail.append(slash)
      hop(c.name, c.path, i === d.crumbs.length - 1)
    }

    const entry = (text, tag, onClick) => {
      const { root: r, el: ent } = mountRow('browser-entry')
      ent.name.textContent = text
      ent.tag.textContent = tag || ''
      r.onclick = onClick
      pane.rows.append(r)
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

    const note = pane.note
    const paint = () => {
      pane.rows.replaceChildren()
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
    const filter = pane.filter
    filter.oninput = paint
    filter.onkeydown = (ev) => {
      if (ev.key !== 'Enter') return
      ev.preventDefault()
      const q = filter.value.trim().toLowerCase()
      const hits = items.filter((i) => !i.always && (i.name ?? '').toLowerCase().includes(q))
      if (hits.length === 1) hits[0].run()
    }
    paint()
    panel.append(box)
    filter.focus()
  }
  browse.onclick = () => {
    if (panel.innerHTML) panel.replaceChildren()
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
  const { root: block, el: kb } = mountRow('api-key-block')
  const { input, save, note } = kb
  form.append(block)

  const status = async () => {
    const d = await responseJson(await fetch('/api/keys')).catch(() => ({ status: {} }))
    const have = Boolean(d.status?.elevenlabs)
    save.textContent = have ? 'Replace the key' : 'Save the key'
    tone(note)
    note.textContent = have ? 'A key is stored — saving again replaces it. Kept in ~/.rolemodel-video/config.json, readable only by you; it is never sent back to the browser and never appears in a command.' : 'ElevenLabs keys start with sk_ and are shown only when the key is created or rotated. The long value listed beside a key in the dashboard is its id, not the key.'
    return have
  }

  /* Adding sound is a server errand, not a client one: the peaks the timeline
     draws have to exist before the clip does, and making peaks is ffmpeg. */
  add.onclick = async () => {
    if (!pick.value) return
    add.disabled = true
    const was = add.textContent
    add.textContent = 'Listening to it…'
    const r = await fetch('/api/edit/audio', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project, folder, rel: pick.value, at: state.playhead }),
    }).then(responseJson).catch((e) => ({ error: e.message }))
    add.disabled = false
    add.textContent = was
    if (r.error) return void toast(r.error, 'bad')
    toast('Added. Reopening the cut.')
    timelineFolder = folder
    go('timeline')
  }

  save.onclick = async () => {
    const key = input.value.trim()
    if (!key) {
      tone(note, 'bad')
      note.textContent = 'Nothing to save.'
      return
    }
    save.disabled = true
    const r = await responseJson(await fetch('/api/keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'elevenlabs', key }) }))
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
  const ul = mountRow('plan').root
  for (const [what, why] of items) {
    const { root: li, el: item } = mountRow('plan-item')
    item.what.textContent = what
    item.break.hidden = !why
    item.why.hidden = !why
    if (why) item.why.textContent = why
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
  const probe = control('span')
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
  const art = mountRow('projcard-art').root
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

  // The toolbar lives in the panel template; this wires its controls.
  const ui = mountPanel('library', m)
  for (const [id, button] of [['grid', ui.gridBtn], ['list', ui.listBtn]]) {
    button.setAttribute('aria-pressed', String(libView === id))
    button.onclick = () => {
      libView = id
      render()
    }
  }
  const wire = (select, value, options, onPick) => {
    for (const [v, t] of options) select.append(new Option(t, v, false, v === value))
    select.onchange = () => {
      onPick(select.value)
      render()
    }
  }
  wire(ui.filter, libFilter, FILTERS, (v) => {
    libFilter = v
  })
  wire(ui.sort, libSort, SORTS, (v) => {
    libSort = v
  })
  ui.search.value = q
  ui.search.oninput = () => {
    q = ui.search.value
    drawItems()
  }
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

  const grid = mountRow('projgrid').root
  grid.className = libView === 'grid' ? 'projgrid' : 'projgrid--list'

  for (const { p, f } of projects) {
    const { root: card, el: row } = mountRow('project-card')
    card.prepend(cardArt(p, f))
    row.name.textContent = p.name
    row.client.textContent = p.client || 'No client'
    const resume = resumeViewFor(p)
    if (p.workflow?.stages?.plan?.startedAt) {
      const stage = WORKFLOW_STAGES.find((item) => item.view === resume)
      row.stage.hidden = false
      row.stage.textContent = `Video in progress · ${stage?.label ?? 'Plan'}`
    }
    const summary = f.files.length ? [f.counts.video && `${f.counts.video} video`, f.counts.audio && `${f.counts.audio} audio`, f.counts.still && `${f.counts.still} still`].filter(Boolean).join(' · ') : 'empty'
    row.summary.textContent = `${summary}${f.bytes ? ' · ' + human(f.bytes) : ''}`
    row.updated.textContent = 'Updated ' + ago(f.newest)

    card.onclick = async () => {
      // Opening a project IS choosing it. Before, this only changed which page
      // you were looking at, so every panel behind the nav still belonged to
      // whichever project you last picked from the menu — or to none at all.
      // `chooseProject` now owns that assignment, so the header switcher gets it too.
      //
      // Opening a project shows the project — its files — not the stage it was
      // last left on. Resuming the stage was tried and is wrong in practice: the
      // reason to open a project is usually to look at what is in it, and being
      // dropped into Assembly means backing out before you can do anything else.
      // The stage stays on the card as information, and the Video button in the
      // toolbar is how you go back to it.
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
            const r = await responseJson(await fetch('/api/delete', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ path: S.libraryRoot + '/' + p.id, kind: 'project' }),
              }))
            if (r.error) return r.error
            await load()
          },
        },
      ]),
    )
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
  const add = mountRow('project-card-new').root
  add.onclick = () => go('new')
  grid.append(add)

  host.append(grid)
  const noMatch = $('#library-no-match')
  if (noMatch) noMatch.hidden = !(!projects.length && terms.length)
  const none = $('#library-none')
  if (none) none.hidden = S.projects.length > 0
}

/*
 * Give every imported clip a useful identity while its original filename is
 * still visible. The saved name is what appears on the project shelf and in the
 * brief Claude receives, so “Dallas — opener” is evidence rather than a memory.
 */
function nameMediaUploads(files) {
  const incoming = [...files]
  if (!incoming.length) return Promise.resolve([])

  return new Promise((done) => {
    const { root: dialog, el: modal } = mountRow('media-name-dialog')
    modal.title.textContent = incoming.length === 1 ? 'Name this file' : `Name ${incoming.length} files`
    const fields = incoming.map((file) => {
      const match = /\.[^.]+$/.exec(file.name)
      const extension = match?.[0] ?? ''
      const originalBase = extension ? file.name.slice(0, -extension.length) : file.name
      const { root: group, el: named } = mountRow('media-name-field')
      const input = Object.assign(named.input, { value: originalBase })
      input.setAttribute('aria-label', `Save ${file.name} as`)
      named.extension.textContent = extension
      named.original.textContent = `Original: ${file.name}`
      modal.fields.append(group)
      return { file, input, extension, originalBase }
    })
    const status = modal.status
    statusSink(status)
    const cancel = modal.cancel
    cancel.onclick = () => dialog.close()
    const add = modal.add
    setLabel(add, incoming.length === 1 ? 'Add file' : 'Add files')
    add.onclick = () => {
      const named = fields.map(({ file, input, extension, originalBase }) => ({
        file,
        name: `${input.value.trim() || originalBase}${extension}`,
      }))
      if (named.some(({ name }) => !name.trim())) {
        tone(status, 'bad')
        status.textContent = 'Each file needs a name.'
        status.hidden = false
        return
      }
      dialog.returnValue = 'add'
      dialog.close()
      done(named)
    }
    dialog.addEventListener('close', () => {
      dialog.remove()
      if (dialog.returnValue !== 'add') done(null)
    }, { once: true })
    document.body.append(dialog)
    dialog.showModal()
  })
}

function downloadProjectAssets(project) {
  // A regular navigation lets the browser stream a multi-gigabyte archive to
  // disk. Fetching it into a Blob would hold that same archive in page memory.
  const a = Object.assign(control('link'), {
    href: `/api/project/assets?project=${encodeURIComponent(project.id)}`,
    download: `${project.name}-assets.zip`,
  })
  document.body.append(a)
  a.click()
  a.remove()
}

/** One project, opened. */
function vProject(m, id) {
  const p = S.projects.find((x) => x.id === id)
  if (!p) {
    openProject = null
    return vLibrary(m)
  }
  const f = projectFacts(p)

  /* Claude can finish a render outside Studio's own job runner. Watch the open
     project for new media so that output appears without a reload or Re-index. */
  let mediaTimer = null
  let mediaStopped = false
  const stopMediaWatch = () => {
    mediaStopped = true
    clearTimeout(mediaTimer)
  }
  stopProjectMediaWatch = stopMediaWatch
  const watchProjectMedia = async () => {
    if (mediaStopped || view !== 'library' || openProject !== p.id) return
    const response = await fetch(`/api/project/media?project=${encodeURIComponent(p.id)}`).catch((error) => ({ error: error.message }))
    const result = response.error ? response : await responseJson(response)
    if (mediaStopped || result.error) return
    const nextFiles = result.catalog?.files ?? []
    const before = JSON.stringify(f.files.map((file) => [file.rel, file.bytes, file.mtime]))
    const after = JSON.stringify(nextFiles.map((file) => [file.rel, file.bytes, file.mtime]))
    if (before !== after) {
      S.projects = S.projects.map((project) => (project.id === p.id ? { ...project, catalog: result.catalog } : project))
      render()
      return
    }
    mediaTimer = setTimeout(watchProjectMedia, 4000)
  }
  mediaTimer = setTimeout(watchProjectMedia, 4000)

  crumbs(scopedCrumbs())
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
  /*
   * Sending moves the whole project, but it is an occasional project action,
   * not the work on this page. Keep it in the header overflow menu instead of
   * holding a permanent row above the library.
   */
  const ui = mountPanel('project', m)
  const storageStatus = ui.storageStatus
  let storagePoll = null
  const paintStorage = (transfer) => {
    if (transfer?.state === 'idle') return false
    storageStatus.hidden = false
    if (transfer?.state === 'sending') {
      storageStatus.textContent = `Sending the complete project to ${transfer.destination}…`
      return true
    }
    if (transfer?.state === 'sent') storageStatus.textContent = `Project sent to ${transfer.destination}.`
    else if (transfer?.state === 'failed') storageStatus.textContent = transfer.error || 'Storage could not finish the transfer.'
    return false
  }
  const watchStorage = () => {
    clearTimeout(storagePoll)
    const check = async () => {
      const response = await fetch(`/api/project/storage?project=${encodeURIComponent(p.id)}`).catch((err) => ({ error: err.message }))
      const transfer = response.error ? response : await responseJson(response)
      if (transfer.error) {
        storageStatus.hidden = false
        storageStatus.textContent = transfer.error
        return
      }
      if (paintStorage(transfer)) storagePoll = setTimeout(check, 1500)
    }
    void check()
  }
  const sendProject = async (remote) => {
    storageStatus.hidden = false
    storageStatus.textContent = 'Starting the background transfer…'
    const response = await fetch('/api/project/storage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: p.id, remote }),
    }).catch((err) => ({ error: err.message }))
    const result = response.error ? response : await responseJson(response)
    if (result.error) {
      storageStatus.textContent = result.error
      return result.error
    }
    paintStorage(result)
    watchStorage()
    return null
  }
  const actions = [
    { icon: 'download-01', text: 'Download project assets', run: () => downloadProjectAssets(p) },
    ...(S.remotes.length ? S.remotes.map((remote) => ({ icon: 'database', text: `Send project to ${remote}`, run: () => sendProject(remote) })) : [{ icon: 'database', text: 'Set up shared storage', run: () => go('storage') }]),
  ]
  // Project-level decisions belong in the page header's overflow, alongside the
  // breadcrumb and switcher. The project body only describes its contents.
  $('#crumbs')?.append(actionMenu(actions, 'Project actions'))
  ui.lede.textContent = `${p.client || 'No client'} · ${p.brand} · ${held.length} item${held.length === 1 ? '' : 's'}${f.bytes ? ' · ' + human(f.bytes) : ''} · updated ${ago(f.newest)}`

  watchStorage()

  const KIND_ORDER = ['video', 'audio', 'still', 'script']
  const present = KIND_ORDER.filter((k) => held.some((x) => x.kind === k))
  // A filter that is no longer represented would leave the page empty with no
  // way back except a pill that is not there.
  if (kind && !present.includes(kind)) kind = ''

  // Project actions and media filters answer different questions. Keep each as
  // its own button group, sharing one compact toolbar rather than pretending
  // “Assembly” is another way to filter the grid.
  const filters = ui.filters
  for (const k of ['', ...present]) {
    const c = control('button', { className: 'btn ghost btn--pill', textContent: k || 'All' })
    c.setAttribute('aria-pressed', String(kind === k))
    c.onclick = () => {
      kind = k
      render()
    }
    filters.append(c)
  }
  const re = ui.reindex
  re.onclick = async () => {
    re.disabled = true
    re.textContent = 'Indexing…'
    await fetch('/api/index/' + p.id, { method: 'POST' })
    await load()
  }

  /*
   * Adopt a capture that was made before the HUD had a project target.
   *
   * A generic file picker technically works, but it makes a very ordinary
   * thing — "put the screen recording I just made into this project" — depend
   * on remembering where OpenScreen stores recordings. Keep it separate from
   * the broader media drop target so the next action is obvious, while copying
   * rather than moving so the original capture remains intact.
   */
  const { recentCaptures, captureSelect, refreshCaptures, addCapture, captureHint } = ui
  captureSelect.append(new Option('Add a recent OpenScreen recording…', ''))

  const loadRecentCaptures = async () => {
    refreshCaptures.disabled = true
    const result = await fetch('/api/openscreen-recordings')
      .then(responseJson)
      .catch((error) => ({ error: error.message }))
    refreshCaptures.disabled = false
    captureSelect.replaceChildren()
    if (result.error) {
      captureSelect.disabled = true
      captureSelect.append(new Option('Recent recordings are unavailable', ''))
      addCapture.disabled = true
      tone(captureHint, 'bad')
      captureHint.textContent = result.error
      captureHint.hidden = false
      return
    }
    const recordings = result.recordings ?? []
    captureSelect.append(new Option(recordings.length ? 'Choose a screen recording…' : 'No recent OpenScreen recordings found', ''))
    for (const recording of recordings) {
      const when = new Date(recording.modifiedAt).toLocaleString()
      captureSelect.append(new Option(`${recording.name} · ${human(recording.bytes)} · ${when}`, recording.file))
    }
    captureSelect.disabled = !recordings.length
    addCapture.disabled = !recordings.length
    tone(captureHint)
    captureHint.hidden = true
  }
  refreshCaptures.onclick = () => void loadRecentCaptures()
  addCapture.onclick = async () => {
    if (!captureSelect.value) {
      tone(captureHint, 'warn')
      captureHint.textContent = 'Choose a screen recording first.'
      captureHint.hidden = false
      return
    }
    addCapture.disabled = true
    refreshCaptures.disabled = true
    tone(captureHint)
    captureHint.textContent = 'Copying the screen recording into this project…'
    captureHint.hidden = false
    const result = await fetch('/api/openscreen-recordings/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: p.id, file: captureSelect.value }),
    })
      .then(responseJson)
      .catch((error) => ({ error: error.message }))
    if (result.error) {
      addCapture.disabled = false
      refreshCaptures.disabled = false
      tone(captureHint, 'bad')
      captureHint.textContent = result.error
      captureHint.hidden = false
      return
    }
    const importedName = String(result.file ?? 'the recording')
      .split(/[\\/]/)
      .pop()
    importFlash = { level: 'ok', text: `Added ${importedName} to Footage — the original capture is still in OpenScreen.` }
    await load()
  }
  const addRecentCapture = ui.addRecentCapture
  addRecentCapture.onclick = () => {
    recentCaptures.open = true
    recentCaptures.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    void loadRecentCaptures()
  }
  /*
   * No stage buttons here.
   *
   * Assembly used to sit in this group as the one stage reachable from a project,
   * and Video was added beside it — then the stage strip grew a Files entry and
   * started drawing on this page, which put all eight stages in the header. Two
   * pills naming two of them is the same navigation twice, and the pair that
   * loses is the one that cannot show the other six.
   *
   * What stays is what the strip does not do: bring footage in, and re-read what
   * is on disk.
   */

  /* The two assembly fetches that fed the old badge are gone with it. The strip
     already says whether Assembly is done or in progress, from one reading of
     the evidence in refreshStageEvidence — asking the same two endpoints again
     to put a number on a button that no longer exists was work for nobody. */

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
  const { drop, picker, dropHint } = ui
  drop.prepend(icon('upload-04'))

  /*
   * Bytes, not a path.
   *
   * A drop hands the page a file's CONTENTS; in a browser it cannot have the
   * location at all, and in the app the property that used to carry it is on its
   * way out of Electron. Sending the bytes is the one route that works in both.
   */
  const send = async (files) => {
    const list = await nameMediaUploads(files)
    if (!list?.length) return
    drop.disabled = true
    let done = 0
    const failed = []
    for (const { file, name } of list) {
      tone(dropHint)
      dropHint.textContent = list.length > 1 ? `copying ${name} (${done + 1} of ${list.length})…` : `copying ${name}…`
      const r = await fetch(`/api/import/upload?project=${encodeURIComponent(p.id)}&name=${encodeURIComponent(name)}`, {
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
    importFlash = failed.length ? { level: done ? 'warn' : 'bad', text: (done ? `Added ${done}. ` : '') + failed.join(' · ') } : { level: 'ok', text: `Added ${done} file${done === 1 ? '' : 's'} — the originals are left where they are.` }
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

  ui.rootPath.textContent = S.libraryRoot + '/' + p.id

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
    ui.emptyNote.hidden = false
    ui.emptyNote.textContent = held.length ? 'Nothing of that kind here.' : 'Nothing here yet. Record into it, or drop footage in ' + p.id + '/media.'
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
  /*
   * Select all, meaning all of what you are looking at.
   *
   * Scoped to `shown`, not to everything held: the filter above is how you say
   * which files you mean, so "still" then Select all is the whole job of
   * clearing out a project full of thumbnails. A Select all that ignored the
   * filter would be a trap with a batch delete next to it.
   *
   * Scripts are excluded. They are in this grid because what you want is
   * usually what you touched last regardless of kind, but they are not assets
   * a video is made from and they are not what fills a project up.
   *
   * It flips to Select none once everything visible is chosen, rather than
   * sitting there having apparently done nothing on a second click.
   */
  const selectable = shown.filter((x) => x.kind !== 'script' && x.rel)
  if (selectable.length) {
    const allOn = selectable.every((x) => chosenAssets.has(x.rel))
    const pick = control('button', {
      className: 'btn ghost btn--pill',
      textContent: allOn ? `Select none` : `Select all ${selectable.length}`,
    })
    pick.onclick = () => {
      for (const x of selectable) {
        if (allOn) chosenAssets.delete(x.rel)
        else chosenAssets.add(x.rel)
      }
      render()
    }
    filters.append(pick)
  }

  const when = (x) => x.mtime ?? ''
  const g = ui.grid
  for (const x of [...shown].sort((a, b) => String(when(b)).localeCompare(String(when(a))))) {
    g.append(x.kind === 'script' ? scriptCard(p, x.script) : fileCard(p, x))
  }
  // After the cards, because it counts what they registered.
  paintPickBar()
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

  const { root: bar, el: pickbar } = mountRow('pickbar')
  const n = chosenAssets.size
  pickbar.count.textContent = `${n} asset${n === 1 ? '' : 's'} picked`
  pickbar.clear.onclick = () => {
    chosenAssets.clear()
    render()
  }
  pickbar.make.onclick = () => {
    // Straight to the script tab: picking the footage has already answered the
    // question the New video chooser asks.
    createTab = 'make'
    go('create')
  }
  /*
   * The same arm-then-confirm a single card uses, counting.
   *
   * No modal, for the reason the per-card delete has none — and here the count
   * is the whole safeguard, because the one thing you can do wrong with a batch
   * is not notice how big it is. The armed label says the number rather than
   * "these", so a stray click that selected the whole grid is visible before
   * the second click rather than after it.
   */
  let armed = false
  const disarm = () => {
    armed = false
    pickbar.del.className = 'btn ghost del'
    pickbar.del.textContent = 'Delete'
  }
  pickbar.del.onclick = async () => {
    if (!armed) {
      armed = true
      pickbar.del.className = 'btn ghost del armed'
      pickbar.del.textContent = `Delete ${n} file${n === 1 ? '' : 's'}? Click again`
      setTimeout(() => armed && disarm(), DISARM_MS)
      return
    }
    pickbar.del.disabled = true
    pickbar.del.textContent = `Deleting ${n}…`
    const r = await responseJson(await fetch('/api/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: currentProject(), rels: [...chosenAssets] }),
    })).catch((error) => ({ error: error.message }))
    if (r.error) {
      pickbar.del.disabled = false
      disarm()
      pickbar.count.textContent = r.error.slice(0, 80)
      return
    }
    /* Only what actually moved leaves the selection, so a partial failure stays
       selected and visible instead of quietly dropping off the screen. */
    for (const rel of r.moved ?? []) chosenAssets.delete(rel)
    render()
    if (r.failed?.length) toast(`${r.count} deleted. ${r.failed.length} could not be: ${r.failed.map((f) => f.rel).join(', ').slice(0, 120)}`, 'bad')
  }
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
  const label = arguments[1] || 'Actions'
  const { root: wrap, el: kebab } = mountRow('kebab')
  const trigger = kebab.trigger
  trigger.setAttribute('aria-label', label)
  trigger.title = label
  trigger.append(icon('more-vertical'))
  const menu = kebab.menu

  /* The popover's own state is the only state, for the same reason the colour
     menu gives: a `hidden` attribute beside it is a second answer to "is this
     open" and the two drift. */
  const isOpen = () => menu.matches(':popover-open')

  /*
   * Placed by hand, because the top layer has no idea where the trigger is.
   *
   * Right-aligned under the trigger, flipped above it when there is no room
   * below, and clamped to the window — a menu opened on the last card of a
   * scrolled grid otherwise runs off the bottom.
   */
  const place = () => {
    const t = trigger.getBoundingClientRect()
    const m = 8
    const w = menu.offsetWidth
    const h = menu.offsetHeight
    const left = Math.max(m, Math.min(t.right - w, window.innerWidth - w - m))
    const below = window.innerHeight - t.bottom - m
    const top = h <= below || t.top < h + m ? t.bottom + 4 : t.top - h - 4
    menu.style.left = `${Math.round(left)}px`
    menu.style.top = `${Math.round(Math.max(m, Math.min(top, window.innerHeight - h - m)))}px`
    menu.style.maxBlockSize = `${Math.round(window.innerHeight - m * 2)}px`
  }

  const close = () => {
    if (isOpen()) menu.hidePopover()
    trigger.setAttribute('aria-expanded', 'false')
    // Disarm on the way out, so a menu reopened later does not start armed.
    for (const b of menu.querySelectorAll('.kebab__item--armed')) {
      b.classList.remove('kebab__item--armed')
      b.querySelector('.kebab__text').textContent = b.dataset.text
    }
  }

  for (const it of items) {
    const { root: b, el: item } = mountRow('kebab-item')
    if (it.danger) b.classList.add('kebab__item--danger')
    b.dataset.text = it.text
    item.text.textContent = it.text
    b.prepend(icon(it.icon))
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
        /*
         * The whole message, not the first 48 characters of it.
         *
         * These messages exist to say what to do next — "the token is missing a
         * scope, it needs …" — and the actionable half is always the second half.
         * Truncated, a Slack failure read `files.completeUploadExternal: no
         * channel by that`, which points at the channel when the problem was the
         * token, and cost an hour looking in the wrong place. The item wraps for
         * this; a menu row taller than the others is a small price for the row
         * being readable.
         */
        b.classList.add('kebab__item--failed')
        label.textContent = String(err)
        return
      }
      close()
    }
    menu.append(b)
  }

  trigger.onclick = (e) => {
    e.stopPropagation()
    const open = !isOpen()
    if (open) menu.showPopover()
    else close()
    trigger.setAttribute('aria-expanded', String(open))
    // Placed after it is shown: a popover that is not open has no size, and
    // place() measures before deciding which way to flip.
    if (open) place()
  }
  // Re-placed rather than left behind: the grid scrolls under it, and a menu
  // pointing at where its trigger used to be is worse than a clipped one.
  for (const ev of ['resize', 'scroll']) {
    window.addEventListener(ev, () => { if (isOpen()) place() }, true)
  }
  wrap.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) {
      e.stopPropagation()
      close()
      trigger.focus()
    }
  })
  /* The menu is in the top layer, so a hit test on `wrap` no longer contains it
     — it has to be asked about itself. */
  document.addEventListener('pointerdown', (e) => {
    if (isOpen() && !wrap.contains(e.target) && !menu.contains(e.target)) close()
  })

  wrap.append(trigger, menu)
  return wrap
}

function deleteButton({ path, projectId, rel, label, kind, after, text = 'Delete' }) {
  const b = control('button', { className: 'btn ghost del', textContent: text })
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
    const r = await responseJson(await fetch('/api/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path, projectId, rel, kind }),
      }))
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
 * A card's name, with what the thing is beside it.
 *
 * The badge used to sit in the corner of the thumbnail, where it competed with
 * the picture — and on the cards with no picture worth looking at it said the
 * same word twice: an audio file's tile is the word AUDIO, with "audio" in the
 * corner under it. Beside the name it is read with the name, which is where the
 * question "what is this" is actually being asked.
 */
function nameWithKind(name, kind) {
  const { root: row, el: parts } = mountRow('name-with-kind')
  parts.text.textContent = name
  if (kind) {
    parts.kind.hidden = false
    parts.kind.className = `kind ${kind}`
    parts.kind.textContent = kind
  }
  return row
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
  const { root: c, el: card } = mountRow('script-shelf-card')
  card.thumb.append(icon('file-01', 'scriptcard__icon'))
  card.name.replaceWith(nameWithKind(sc.name, 'script'))
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
  card.meta.textContent = `scripts/${sc.name}.md${words ? ` · ${words} words${secs ? ` · ~${clock(secs)}` : ''}` : ''}`

  c.append(
    actionMenu(
      [
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
        {
          icon: 'delete-02',
          text: 'Delete script',
          danger: true,
          busy: 'Deleting…',
          run: async () => {
            const r = await responseJson(await fetch('/api/script/delete', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ projectId: project.id, name: sc.name }),
              }))
            if (r.error) return r.error
            await load()
          },
        },
      ],
      `Actions for ${sc.name}`,
    ),
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
  const r = await responseJson(await fetch('/api/open-media', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, hosted }),
    }))
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

/*
 * A project-to-project move belongs beside the asset, not in a storage panel
 * and not behind a filesystem path prompt.  The dialog is deliberately small:
 * its only decision is where this one file should live next.
 */
function moveAssetToProject(project, f) {
  const destinations = S.projects.filter((candidate) => candidate.id !== project.id)
  if (!destinations.length) return Promise.resolve('Create another project first.')

  return new Promise((done) => {
    const { root: dialog, el: modal } = mountRow('asset-dialog')
    modal.title.textContent = `Move ${f.name}`
    modal.lede.textContent = 'The file moves out of this project and into the destination project’s media library.'
    const destination = control('select', { className: 'form-control' })
    destination.setAttribute('aria-label', 'Destination project')
    for (const candidate of destinations) destination.append(new Option(candidate.name, candidate.id))
    modal.label.textContent = 'Move to project'
    modal.slot.append(destination)
    const status = modal.status
    statusSink(status)
    const cancel = modal.cancel
    cancel.onclick = () => dialog.close()
    const move = modal.confirm
    move.textContent = 'Move media'
    move.onclick = async () => {
      move.disabled = true
      cancel.disabled = true
      status.hidden = false
      tone(status)
      status.textContent = `Moving to ${destination.options[destination.selectedIndex].textContent}…`
      const result = await fetch('/api/media/move', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fromProjectId: project.id, toProjectId: destination.value, rel: f.rel }),
      })
        .then(responseJson)
        .catch((error) => ({ error: error.message }))
      if (result.error) {
        tone(status, 'bad')
        status.textContent = result.error
        move.disabled = false
        cancel.disabled = false
        return
      }
      importFlash = { level: 'ok', text: `Moved ${f.name} to ${destination.options[destination.selectedIndex].textContent}.` }
      dialog.close()
      await load()
    }
    dialog.addEventListener('close', () => {
      dialog.remove()
      done(null)
    }, { once: true })
    document.body.append(dialog)
    dialog.showModal()
  })
}

/**
 * Watch a clip at a size you can actually judge it at.
 *
 * The first version played inside the card's own thumbnail, which is the right
 * gesture and the wrong size: a 200px player tells you a video exists, not
 * whether it is any good. A <dialog> gets it to nearly the full window without
 * leaving the project — same pattern as move and rename, so Escape, the
 * backdrop and focus trapping all come from the platform rather than from us.
 */
/*
 * A waveform, for the files that have nothing to look at.
 *
 * An audio file in the player was a <video> element: a black rectangle with a
 * scrubber under it, which tells you nothing about the recording. A waveform
 * tells you where the speech is, where the gaps are, and whether the take is
 * clipped — and it makes a click land on a word rather than on a position.
 *
 * Colours are read off the page rather than written here. WaveSurfer paints to
 * a canvas and needs real colour strings, not var() references, so the tokens
 * are resolved once per instance; that keeps the waveform on the same palette
 * as everything around it instead of introducing three colours of its own.
 *
 * It draws into a child element with its own shadow root, so nothing outside
 * can style the canvas and nothing here should try.
 */
function waveform(host, url, { height = 64 } = {}) {
  if (!window.WaveSurfer) return null
  /*
   * Resolved through the page, never written down.
   *
   * WaveSurfer paints to a canvas and needs a real colour string. Reading the
   * custom property gives its declared value, which for an Optics token is a
   * `light-dark()` pair a canvas cannot use — so the value is put on a probe
   * element and read back computed, the same trick the shader components use.
   * This file still states no colour of its own.
   *
   * Green, because a waveform is one of ours. The unplayed part is the accent
   * mixed back toward the ground and the played part is the accent itself, so
   * the two read as one colour at two strengths rather than as grey with a
   * green bar creeping across it.
   */
  const paint = {}
  /* On the document, not on `host` — a waveform is built before its dialog is
     appended, and getComputedStyle on a detached element resolves nothing, so
     every colour was silently dropped and WaveSurfer drew its own grey. */
  const probe = document.createElement('i')
  document.body.append(probe)
  for (const [option, value] of [
    ['waveColor', 'color-mix(in srgb, var(--accent) 40%, var(--bg))'],
    ['progressColor', 'var(--accent)'],
    ['cursorColor', 'var(--fg)'],
  ]) {
    probe.style.color = ''
    probe.style.color = value
    const resolved = getComputedStyle(probe).color
    if (resolved) paint[option] = resolved
  }
  probe.remove()
  const wave = window.WaveSurfer.create({
    container: host,
    url,
    height,
    ...paint,
    cursorWidth: 1,
    barWidth: 2,
    barGap: 1,
    barRadius: 2,
    normalize: true,
  })
  return wave
}

function openPlayer(project, f) {
  const listening = f.kind === 'audio'
  const { root: dialog, el: player } = mountRow('player-dialog')
  if (listening) dialog.classList.add('player--listen')
  const src = `/media/${encodeURIComponent(project.id)}/${encodeURI(f.rel)}`
  const video = player.video
  if (!listening) {
    video.hidden = false
    video.src = src
    video.controls = true
    video.autoplay = true
    video.playsInline = true
  }
  player.name.textContent = f.name
  const close = player.close
  close.append(icon('cancel-01'))
  close.onclick = () => dialog.close()

  /* Clicking the backdrop closes it. The dialog fills the window, so "outside"
     means the padding around the frame rather than a region of the page. */
  dialog.onclick = (e) => {
    if (e.target === dialog) dialog.close()
  }
  /*
   * A recording you can see.
   *
   * Audio opened into a <video> element, which is a black rectangle with a
   * scrubber: nothing about the file is visible, and finding the third
   * sentence means dragging and guessing. The waveform is the picture that
   * file actually has.
   */
  let wave = null
  const listen = player.listen
  if (listening) {
    listen.hidden = false
    const canvas = player.canvas
    const play = player.play
    play.setAttribute('aria-label', `Play ${f.name}`)
    play.append(icon('play'))
    const clock = player.clock
    wave = waveform(canvas, src, { height: 96 })
    if (wave) {
      const clockAt = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
      const mark = () => { clock.textContent = `${clockAt(wave.getCurrentTime())} / ${clockAt(wave.getDuration() || 0)}` }
      wave.on('ready', mark)
      wave.on('audioprocess', mark)
      wave.on('seeking', mark)
      wave.on('play', () => { play.innerHTML = ''; play.append(icon('pause')) })
      wave.on('pause', () => { play.innerHTML = ''; play.append(icon('play')) })
      play.onclick = () => wave.playPause()
      wave.once('ready', () => void wave.play())
    } else {
      // No WaveSurfer means no waveform, but the file must still be playable.
      const fallback = control('audio')
      fallback.controls = true
      fallback.src = src
      listen.append(fallback)
    }
  }

  dialog.addEventListener('close', () => {
    // Stop the download as well as the sound: a paused <video> with a src keeps
    // buffering, and these are 30MB files. A WaveSurfer holds its own media
    // element and an AudioContext, so it is destroyed rather than paused.
    wave?.destroy()
    video.pause()
    video.removeAttribute('src')
    video.load()
    dialog.remove()
  }, { once: true })

  document.body.append(dialog)
  dialog.showModal()
}

function renameAsset(project, f) {
  return new Promise((done) => {
    const { root: dialog, el: modal } = mountRow('asset-dialog')
    modal.title.textContent = `Rename ${f.name}`
    modal.lede.textContent = 'This updates the project’s transcripts and saved editing work to use the new name.'
    const name = control('input', { className: 'form-control', type: 'text', value: f.name, required: true })
    name.setAttribute('aria-label', 'Media name')
    modal.label.textContent = 'Name'
    modal.slot.append(name)
    const status = modal.status
    statusSink(status)
    const cancel = modal.cancel
    cancel.onclick = () => dialog.close()
    const rename = modal.confirm
    rename.textContent = 'Rename media'
    rename.onclick = async () => {
      const next = name.value.trim()
      if (!next) {
        name.focus()
        return
      }
      rename.disabled = true
      cancel.disabled = true
      status.hidden = false
      tone(status)
      status.textContent = 'Renaming…'
      const result = await fetch('/api/media/rename', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: project.id, rel: f.rel, name: next }),
      })
        .then(responseJson)
        .catch((error) => ({ error: error.message }))
      if (result.error) {
        tone(status, 'bad')
        status.textContent = result.error
        rename.disabled = false
        cancel.disabled = false
        return
      }
      importFlash = { level: 'ok', text: `Renamed ${f.name} to ${result.name}.` }
      dialog.close()
      await load()
    }
    dialog.addEventListener('close', () => {
      dialog.remove()
      done(null)
    }, { once: true })
    document.body.append(dialog)
    dialog.showModal()
    name.focus()
    name.select()
  })
}

function fileCard(project, f) {
  const { root: c, el: card } = mountRow('file-card')

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
  const pickBox = Object.assign(card.pick, { checked: chosenAssets.has(f.rel) })
  pickBox.setAttribute('aria-label', `Use ${f.name} in a video`)
  pickBox.onclick = (e) => e.stopPropagation()
  pickBox.onchange = () => {
    if (pickBox.checked) chosenAssets.add(f.rel)
    else chosenAssets.delete(f.rel)
    c.classList.toggle('card--picked', pickBox.checked)
    paintPickBar()
  }
  if (pickBox.checked) c.classList.add('card--picked')

  const t = card.thumb
  if (f.kind === 'audio') t.textContent = 'AUDIO'
  else t.style.backgroundImage = `url('/thumb/${project.id}/${encodeURI(f.rel)}')`
  /*
   * Watch it here, rather than deciding where to send it.
   *
   * Clicking the card hands a video to the editor, which is right when you are
   * working on it and wrong when you only want to see what a clip is — and the
   * editor is a slow way to answer "is this the take with the dog barking".
   * The thumbnail becomes the player in place: same tile, same page, nothing to
   * navigate back from.
   *
   * `stopPropagation`, because the card's own click still owns everything else
   * on the tile.
   */
  if (f.kind === 'video' || f.kind === 'audio') {
    const play = card.play
    play.hidden = false
    play.title = `Play ${f.name} here`
    play.setAttribute('aria-label', `Play ${f.name} here`)
    play.append(icon('play'))
    play.onclick = (event) => {
      event.stopPropagation()
      openPlayer(project, f)
    }
  }
  const b = c.querySelector('.body')
  card.name.replaceWith(nameWithKind(f.name, f.kind))
  card.path.textContent = f.rel
  const meta = card.meta
  for (const x of [dur(f.media?.durationSec), f.media?.video ? f.media.video.width + '×' + f.media.video.height : null, f.media?.video?.fps ? f.media.video.fps + 'fps' : null, human(f.bytes), f.media?.video?.codec || f.media?.audio?.codec].filter(Boolean)) meta.append(control('span', { textContent: x }))
  const note = card.note
  const transcribe = async () => {
    tone(note, 'ok')
    note.textContent = 'Starting transcription…'
    const result = await fetch('/api/paper-edit/transcribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, rel: f.rel, language: 'en' }),
    })
      .then(responseJson)
      .catch((error) => ({ error: error.message }))
    if (result.error) {
      tone(note, 'bad')
      note.textContent = result.error
      return result.error
    }
    const job = result.alreadyRunning ? result.job : await start(result.step, { status: note })
    if (!job) return 'Could not start transcription.'
    showJobStatus(note, job)
    watchJobInPlace(job, note, (finished) => {
      if (finished?.code === 0) {
        tone(note, 'ok')
        note.textContent = 'Transcript ready. Open Assembly to review it.'
      }
    })
    return null
  }
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
   *
   * On the card, not in the body. `.kebab` pins itself to the top-right of its
   * positioned ancestor, and the body is one — so in the body it landed beside
   * the name in the middle of the card rather than in the card's own corner,
   * where every other card in the app keeps it.
   */
  c.append(
    actionMenu([
      ...(f.kind === 'video' ? [{
        icon: 'text-align-left',
        text: 'Transcribe',
        busy: 'Starting…',
        run: transcribe,
      }] : []),
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
          const r = await responseJson(await fetch('/api/review/send', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ projectId: project.id, rel: f.rel }),
            }))
          if (r.error) return r.error
          go('review')
        },
      },
      /*
       * Posted, not linked.
       *
       * "Send for review" needs an OpenFrame instance to be standing and a
       * reviewer to have an account there. This uploads the file itself, so the
       * video is delivered by a tool that is already in everyone's dock — and it
       * keeps working if OpenFrame is never adopted.
       *
       * Videos only: Slack renders an MP4 inline and a .openscreen document as a
       * download nobody in the channel can open.
       */
      ...(f.kind === 'video' ? [{
        icon: 'slack',
        text: 'Post to Slack',
        busy: 'Uploading…',
        run: async () => {
          const r = await fetch('/api/slack/post', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ projectId: project.id, rel: f.rel, title: f.name, comment: `${project.name}${project.client ? ` · ${project.client}` : ''}` }),
          })
            .then(responseJson)
            .catch(() => ({ error: 'the Studio did not answer — is it still running on this port?' }))
          if (r.error) return r.error
          return null
        },
      }] : []),
      /*
       * Save the file, rather than play it in a tab.
       *
       * `?download` makes the media route send content-disposition: attachment —
       * without it a video URL just plays, and Save-as from a <video> names the
       * file after the page instead of the render.
       */
      {
        icon: 'download-04',
        text: 'Download',
        run: () => {
          open(`/media/${encodeURIComponent(project.id)}/${encodeURI(f.rel)}?download`)
          return null
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
        icon: 'arrow-right-01',
        text: 'Move to another project',
        busy: 'Moving…',
        run: () => moveAssetToProject(project, f),
      },
      {
        icon: 'pencil-edit-02',
        text: 'Rename',
        busy: 'Renaming…',
        run: () => renameAsset(project, f),
      },
      {
        icon: 'delete-02',
        text: 'Delete',
        danger: true,
        busy: 'Deleting…',
        run: async () => {
          const r = await responseJson(await fetch('/api/delete', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              // project + rel, not a hand-built path: media lives under `media/`
              // and this side should not have to know that. Building it here
              // produced `<library>/<id>/Footage/demo.mp4` and a "no such file"
              // for something plainly on disk.
              body: JSON.stringify({ projectId: project.id, rel: f.rel }),
            }))
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
  return c
}

/* ── Editor ──────────────────────────────────────────────── */

/*
 * HyperFrames owns motion and composition edits; OpenScreen owns the recorded
 * demo and screenshot edit.  They are deliberately two destinations because
 * sending an HTML composition through OpenScreen turns it into a flattened MP4,
 * and trying to reproduce HyperFrames Studio here loses its timeline, source
 * mutation, and autosave contracts.
 */
/**
 * Render a composition, without opening anything.
 *
 * The editor's own renderer was the only route to an MP4, which made a visual
 * timeline a required step in every video — and it recompiles the project on
 * every look, so checking a composition disturbs a render that is already
 * running. This runs the split renderer instead: it serves the folder itself,
 * asks the page once for its layout, and lets ffmpeg build the footage layer.
 *
 * No frame rate is passed. The composition declares one, and an export that
 * contradicts its own source is a bug rather than an option.
 */
async function renderHyperframesProject(folder, button, status) {
  button.disabled = true
  status.hidden = false
  tone(status, 'ok')
  status.textContent = 'Preparing the render…'
  const result = await fetch('/api/hyperframes/render', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: currentProject(), folder }),
  })
    .then(responseJson)
    .catch((error) => ({ error: error.message }))
  if (result.error) {
    button.disabled = false
    tone(status, 'bad')
    status.textContent = result.error
    return
  }
  /* The card list is drawn inside its own view; refreshing it from here would
     reach into that closure. The finished MP4 shows up on the next visit, and
     the Console has the render itself. */
  await runWithStatus(result.renderStep, button, status)
}

async function openHyperframesProject(folder, button, status) {
  button.disabled = true
  status.hidden = false
  tone(status, 'ok')
  status.textContent = 'Starting the motion editor…'
  /* A first start can spend real time resolving HyperFrames itself. One
     unchanging line for 45 seconds reads as hung, and quitting Studio is what
     people reach for next — so say that a slow start is still a start. */
  const patience = [
    window.setTimeout(() => { status.textContent = 'Starting the motion editor… first run takes a moment.' }, 6000),
    window.setTimeout(() => { status.textContent = 'Still starting. HyperFrames is being fetched — this only happens once.' }, 15000),
  ]
  const result = await fetch('/api/hyperframes/open', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: currentProject(), folder }),
  })
    .then(responseJson)
    .catch((error) => ({ error: error.message }))
  patience.forEach(window.clearTimeout)
  button.disabled = false
  if (result.error) {
    tone(status, 'bad')
    status.textContent = result.error
    return null
  }

  // HyperFrames is an editing surface in this app, not a new browser
  // destination. The Studio rail and tokenized shell remain present around it.
  hyperframesWorkspace = { folder: result.folder, url: result.url, exports: result.exports ?? [] }
  go('hyperframes')
  return result
}

function showHyperframesExport(exported) {
  if (!exported) return
  const projectMedia = $('#hyperframes-project-media')
  if (projectMedia) projectMedia.textContent = 'View exported video'
}

async function deleteHyperframesProject(project, button, status) {
  const title = String(project?.title || project?.folder || 'this motion project')
  if (!window.confirm(`Delete ${title}? This removes its editable HyperFrames composition and any renders inside it. The source clips in this video stay untouched.`)) return false
  if (button) button.disabled = true
  if (status) {
    status.hidden = false
    tone(status, 'warn')
    status.textContent = 'Deleting motion project…'
  }
  const result = await fetch('/api/hyperframes/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: currentProject(), folder: project?.folder }),
  })
    .then(responseJson)
    .catch((error) => ({ error: error.message }))
  if (button) button.disabled = false
  if (result.error) {
    if (status) {
      tone(status, 'bad')
      status.textContent = result.error
    }
    return false
  }
  if (hyperframesWorkspace?.folder === project?.folder) hyperframesWorkspace = null
  return true
}

/*
 * Where each speaker's circle sits inside their own recording.
 *
 * Three numbers per clip, and until now they were only settable by editing a
 * style attribute in the composition — which means knowing that `focus` is an
 * object-position, and that a vertical one does nothing until zoom has made
 * some vertical slack. Nobody should have to know that to centre a face.
 *
 * The preview is a real <video> under the composition's own pip rules rather
 * than a diagram of them. Whether a face is centred, and whether one speaker
 * matches another, are things you can only tell by looking at the shape they
 * will actually appear in.
 */
function vFraming(m, workspace) {
  const id = currentProject()
  const { root, el: ui } = mountRow('hyperframes-framing')
  m.append(root)
  const leave = () => {
    hyperframesFraming = false
    go('hyperframes')
  }
  ui.cancel.onclick = leave

  const shots = []
  /* Placement is one set of numbers for the whole composition, so it lives here
     rather than per shot. Seeded from the composition on load. */
  const place = { size: 46, aspect: 1, right: -8, bottom: -4, radius: 50 }
  const draw = async () => {
    ui.status.textContent = 'Reading the framing…'
    const result = await fetch(`/api/hyperframes/framing?project=${encodeURIComponent(id)}&folder=${encodeURIComponent(workspace.folder)}`)
      .then(responseJson)
      .catch((error) => ({ error: error.message }))
    if (result.error) {
      tone(ui.status, 'bad')
      ui.status.textContent = result.error
      return
    }
    tone(ui.status)
    ui.status.textContent = ''
    /* An edit made in HyperFrames that the recipe had not heard of. Saying so
       matters: those values are about to be written back as if they were
       always there, and silently absorbing somebody's edit is how trust in a
       rebuild goes. */
    if (result.adopted?.length) {
      ui.adopted.hidden = false
      ui.adopted.textContent = `Taken from the composition: ${result.adopted.join('; ')}.`
    }
    /*
     * Where the pip sits.
     *
     * The stage is the frame's own shape with container-type: inline-size, so
     * the cqw values written into the composition mean the same thing here as
     * they do there — this is the placement, not a diagram of it.
     */
    Object.assign(place, result.pip ?? {})
    const paintPlace = () => {
      ui.stage.style.setProperty('--pip-size', `${place.size}cqw`)
      ui.stage.style.setProperty('--pip-aspect', place.aspect)
      ui.stage.style.setProperty('--pip-right', `${place.right}cqw`)
      ui.stage.style.setProperty('--pip-bottom', `${place.bottom}cqw`)
      ui.stage.style.setProperty('--pip-radius', `${place.radius}%`)
      ui.sizeText.textContent = `${Number(place.size).toFixed(1)}`
      ui.radiusText.textContent = place.radius >= 50 ? 'circle' : `${place.radius}%`
      ui.size.value = String(place.size)
      ui.radius.value = String(place.radius)
    }
    ui.size.addEventListener('input', () => {
      place.size = Number(ui.size.value)
      paintPlace()
    })
    ui.radius.addEventListener('input', () => {
      place.radius = Number(ui.radius.value)
      paintPlace()
    })
    /*
     * Dragging moves the pip, and the offsets are from the BOTTOM RIGHT — so
     * dragging right decreases `right` and dragging down decreases `bottom`.
     * Negative is allowed and is how the pip hangs off the edge, which is what
     * this composition already does.
     */
    let moving = null
    ui.puck.addEventListener('pointerdown', (event) => {
      moving = { x: event.clientX, y: event.clientY, right: place.right, bottom: place.bottom, w: ui.stage.clientWidth || 1 }
      ui.puck.setPointerCapture(event.pointerId)
      event.preventDefault()
    })
    ui.puck.addEventListener('pointermove', (event) => {
      if (!moving) return
      const per = 100 / moving.w
      place.right = Math.round((moving.right - (event.clientX - moving.x) * per) * 10) / 10
      place.bottom = Math.round((moving.bottom - (event.clientY - moving.y) * per) * 10) / 10
      paintPlace()
    })
    const dropPuck = () => { moving = null }
    ui.puck.addEventListener('pointerup', dropPuck)
    ui.puck.addEventListener('pointercancel', dropPuck)
    paintPlace()

    for (const clip of result.clips) {
      const { root: shotRoot, el: shot } = mountRow('framing-shot')
      const pip = shot.pip
      shot.who.textContent = clip.speaker ?? clip.src.split('/').pop()
      const state = { focus: clip.focus, zoom: clip.zoom, focusY: clip.focusY }
      const paint = () => {
        pip.style.setProperty('--pip-focus', `${state.focus.toFixed(1)}%`)
        pip.style.setProperty('--pip-zoom', state.zoom.toFixed(2))
        pip.style.setProperty('--pip-y', state.focusY.toFixed(1))
        shot.zoomText.textContent = `${state.zoom.toFixed(2)}×`
        // Vertical is meaningless at zoom 1, so it does not pretend to be live.
        pip.style.cursor = state.zoom > 1 ? 'grab' : 'ew-resize'
      }
      /* A frame from inside the clip's own window, not frame zero: the first
         frame of a take is often the person settling, which is not the shot
         being framed. */
      const at = clip.ms + Math.min(2, clip.dur / 2)
      pip.src = `/api/hyperframes/framing/frame?project=${encodeURIComponent(id)}&src=${encodeURIComponent(clip.src)}&at=${at.toFixed(2)}`
      pip.alt = clip.speaker ?? clip.src
      shot.zoom.value = String(state.zoom)
      shot.zoom.addEventListener('input', () => {
        state.zoom = Number(shot.zoom.value)
        if (state.zoom === 1) state.focusY = 50
        paint()
      })
      shot.reset.onclick = () => {
        state.focus = 50
        state.zoom = 1
        state.focusY = 50
        shot.zoom.value = '1'
        paint()
      }

      /*
       * Drag moves the crop, and it moves the way a photograph does: dragging
       * right brings what is on the left into view, so the pointer stays on the
       * part of the face it grabbed. That is the opposite sign to the property,
       * which is why this reads inverted.
       */
      let dragging = null
      pip.addEventListener('pointerdown', (event) => {
        dragging = { x: event.clientX, y: event.clientY, focus: state.focus, focusY: state.focusY, w: pip.clientWidth || 1 }
        pip.setPointerCapture(event.pointerId)
        event.preventDefault()
      })
      pip.addEventListener('pointermove', (event) => {
        if (!dragging) return
        const across = ((event.clientX - dragging.x) / dragging.w) * 100
        state.focus = Math.min(100, Math.max(0, dragging.focus - across))
        if (state.zoom > 1) {
          const down = ((event.clientY - dragging.y) / dragging.w) * 100
          state.focusY = Math.min(100, Math.max(0, dragging.focusY - down / state.zoom))
        }
        paint()
      })
      const drop = () => { dragging = null }
      pip.addEventListener('pointerup', drop)
      pip.addEventListener('pointercancel', drop)

      paint()
      shots.push(state)
      ui.grid.append(shotRoot)
    }
  }
  void draw()

  ui.save.onclick = async () => {
    ui.save.disabled = true
    tone(ui.status)
    ui.status.textContent = 'Rebuilding the composition…'
    const result = await fetch('/api/hyperframes/framing', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: id, folder: workspace.folder, framing: shots, pip: place }),
    })
      .then(responseJson)
      .catch((error) => ({ error: error.message }))
    ui.save.disabled = false
    if (result.error) {
      tone(ui.status, 'bad')
      ui.status.textContent = result.error
      says(result.error, 'bad')
      return
    }
    says(result.changed ? `Framing saved — ${result.clips} pips` : 'Framing unchanged', 'ok')
    // The composition changed underneath the editor, so go back to a fresh one.
    workspace.source = result.source ?? workspace.source
    leave()
  }
}

function vHyperframes(m) {
  const id = currentProject()
  if (hyperframesWorkspace?.url && hyperframesFraming) return vFraming(m, hyperframesWorkspace)
  if (hyperframesWorkspace?.url) {
    const workspace = hyperframesWorkspace
    const { root: shell, el: ws } = mountRow('hyperframes-workspace')
    const frame = ws.frame
    frame.title = `HyperFrames · ${workspace.folder}`
    const loadWorkspace = ({ force = false } = {}) => {
      if (force) {
        frame.src = 'about:blank'
        window.setTimeout(() => { frame.src = workspace.url }, 0)
      } else frame.src = workspace.url
    }
    // crumbs() paints before this view. The header action deliberately calls
    // this stable callback after the frame exists instead of owning a duplicate
    // second header above the editor.
    workspace.reload = async () => {
      const result = await fetch('/api/hyperframes/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: currentProject(), folder: workspace.folder }),
      })
        .then(responseJson)
        .catch((error) => ({ error: error.message }))
      if (result.error) return result
      workspace.url = result.url
      loadWorkspace({ force: true })
      return result
    }
    loadWorkspace()
    // Above the frame, not inside it: the confirmation is about the handover that
    // just happened, and the frame is HyperFrames' own surface.
    const handed = handoffNote()
    if (handed) shell.prepend(handed)

    /*
     * Reload when the composition changes on disk.
     *
     * HyperFrames has no file watcher, so a composition edited in an external
     * editor changes underneath a preview that never finds out. Studio already
     * polls this folder; watching the source signature on that same poll is all
     * this needs.
     *
     * Off by default, and a deliberate choice rather than a default worth
     * arguing about: the embedded editor writes this same file when it saves, so
     * an always-on watch would reload the editor out from under someone in the
     * middle of using it. Turn it on when the composition is being edited
     * somewhere else, which is the case this exists for.
     */
    const watchBox = ws.watch
    watchBox.checked = hyperframesWatchSource
    watchBox.addEventListener('change', () => {
      hyperframesWatchSource = watchBox.checked
      // Adopt whatever is on disk now, so switching this on cannot fire once for
      // an edit that was already on screen.
      knownSource = workspace.source ?? knownSource
    })

    /*
     * The round trip to OpenScreen.
     *
     * OpenScreen is the better place to trim, reorder and drop clips; this
     * composition holds everything it has never heard of — the framing, the
     * speaker names, the words on screen. Sending the cut over starts a watch on
     * the server, so a save there rebuilds this composition without anybody
     * having to come back and press anything. The button below is for the times
     * that watch is not running: a restarted server, or a document edited before
     * the cut was ever sent.
     */
    /* The header's handles, parked by crumbs() before this view is drawn. Read
       once, above every use: this was declared after the first handler and the
       whole view threw on the temporal dead zone. */
    const acts = hyperframesActions

    const setCutState = (text, bad = false) => {
      ws.cutState.textContent = text ?? ''
      ws.cutState.classList.toggle('bad', Boolean(bad))
    }
    if (acts) acts.toEditor.onclick = async () => {
      acts.toEditor.disabled = true
      setCutState('Sending the cut to OpenScreen…')
      const result = await fetch('/api/hyperframes/to-openscreen', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: currentProject(), folder: workspace.folder }),
      })
        .then(responseJson)
        .catch((error) => ({ error: error.message }))
      acts.toEditor.disabled = false
      if (result.error) {
        setCutState(result.error, true)
        says(result.error, 'bad')
        return
      }
      setCutState(`${result.clips} clips in OpenScreen. Save there and this rebuilds itself.`)
      says(`Editing ${result.clips} clips in OpenScreen`, 'ok')
    }
    if (acts) acts.framing.onclick = () => {
      hyperframesFraming = true
      go('hyperframes')
    }
    if (acts) acts.fromEditor.onclick = async () => {
      acts.fromEditor.disabled = true
      setCutState('Bringing the edit back…')
      const result = await fetch('/api/hyperframes/from-openscreen', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: currentProject(), folder: workspace.folder }),
      })
        .then(responseJson)
        .catch((error) => ({ error: error.message }))
      acts.fromEditor.disabled = false
      if (result.error) {
        setCutState(result.error, true)
        says(result.error, 'bad')
        return
      }
      acts.fromEditor.hidden = true
      setCutState(`${result.was} clips → ${result.clips.length}, ${result.seconds.toFixed(1)}s.`)
      says(`Adopted the edit — ${result.clips.length} clips`, 'ok')
      knownSource = result.source ?? knownSource
      loadWorkspace({ force: true })
    }
    m.append(shell)

    /*
     * HyperFrames' own Export button talks to its local preview server, not our
     * job runner. Poll the tiny project bridge while this embedded editor is
     * open so a stable MP4 is promoted and acknowledged here without asking the
     * person to leave the timeline or re-index the project themselves.
     */
    let knownExport = workspace.exports?.[0]?.rel ?? null
    let knownSource = workspace.source ?? null
    /* The last adopt this panel has already reported, so a standing result is
       not announced again on every poll. */
    let knownAdopt = null
    const refreshExports = async () => {
      const result = await fetch(`/api/hyperframes/exports?project=${encodeURIComponent(id)}&folder=${encodeURIComponent(workspace.folder)}`)
        .then(responseJson)
        .catch(() => null)
      if (!result || result.error || hyperframesWorkspace !== workspace) return
      workspace.exports = result.exports ?? []
      if (result.source) {
        workspace.source = result.source
        if (knownSource && result.source !== knownSource && hyperframesWatchSource) {
          knownSource = result.source
          loadWorkspace({ force: true })
          return
        }
        knownSource = result.source
      }
      /*
       * A live cut watch means the composition is being edited somewhere else,
       * which is exactly the case the reload checkbox exists for. Turn it on
       * rather than leaving somebody to discover it: an edit that rebuilt this
       * file and did not appear reads as the feature not working.
       */
      if (result.cut?.watching && !hyperframesWatchSource) {
        hyperframesWatchSource = true
        watchBox.checked = true
      }
      const done = result.cut?.last
      if (done && done.at !== knownAdopt) {
        knownAdopt = done.at
        if (done.error) setCutState(done.error, true)
        else {
          setCutState(`Adopted ${done.clips} clips${done.was !== done.clips ? ` (was ${done.was})` : ''} · ${done.seconds.toFixed(1)}s`)
          says(`Adopted the edit — ${done.clips} clips`, 'ok')
        }
      }
      const latest = workspace.exports[0]
      if (latest?.rel && latest.rel !== knownExport) {
        knownExport = latest.rel
        showHyperframesExport(latest)
      }
    }

    /*
     * An edit sitting on disk that this composition has not taken.
     *
     * Only reachable when nothing is watching — a restarted server, or a
     * document edited before the cut was ever sent. Checked on the way in rather
     * than polled: it is a standing condition, not an event.
     */
    const offerPending = async () => {
      const result = await fetch(`/api/hyperframes/pending?project=${encodeURIComponent(id)}&folder=${encodeURIComponent(workspace.folder)}`)
        .then(responseJson)
        .catch(() => null)
      if (!result?.pending || hyperframesWorkspace !== workspace) return
      if (acts) acts.fromEditor.hidden = false
      setCutState(`${result.document} has an edit this composition has not taken — ${result.was} clips → ${result.now}.`)
    }
    void offerPending()
    void refreshExports()
    const exportTimer = window.setInterval(() => {
      if (view !== 'hyperframes' || hyperframesWorkspace !== workspace) {
        window.clearInterval(exportTimer)
        return
      }
      void refreshExports()
    }, 1500)
    return
  }
  const ui = mountPanel('hyperframes', m)
  const { status, empty, grid } = ui
  ui.makeOne.onclick = () => go('make')

  const draw = async () => {
    empty.hidden = true
    grid.hidden = true
    grid.replaceChildren()
    tone(status)
    status.textContent = 'Loading editable projects…'
    const result = await fetch('/api/hyperframes?project=' + encodeURIComponent(id))
      .then(responseJson)
      .catch((error) => ({ error: error.message }))
    if (result.error) {
      tone(status, 'bad')
      status.textContent = result.error
      return
    }
    const projects = result.projects ?? []
    tone(status)
    status.textContent = projects.length
      ? `${projects.length} editable motion project${projects.length === 1 ? '' : 's'} in this video.`
      : 'No generated motion projects yet.'

    if (!projects.length) {
      empty.hidden = false
      return
    }

    grid.hidden = false
    for (const project of projects) {
      const { root, el: card } = mountRow('hyperframes-card')
      const latest = project.renders?.[0]
      if (latest) card.art.style.backgroundImage = `url('/thumb/${id}/${encodeURI(latest.rel)}')`
      else card.art.append(icon('play-circle', 'scriptcard__icon'))
      card.name.replaceWith(nameWithKind(project.title, latest ? 'video' : 'source'))
      card.path.textContent = `media/Renders/${project.folder}/index.html`
      card.meta.textContent = latest ? `${latest.name} · ${human(latest.bytes)}` : 'Editable source · not rendered yet'
      card.open.onclick = () => void openHyperframesProject(project.folder, card.open, card.status)
      /* Rendering is not an editing task. Opening the timeline editor to get an
         MP4 out of a finished composition made a visual editor a required step
         in every video — and its renderer recompiles the project, so even
         looking at one disturbs a render in progress. */
      /* Edit when there is a cut, and make one when there is not. Two verbs on one
         button rather than a disabled control: "Edit timeline" greyed out tells
         you nothing about how to un-grey it. */
      card.edit.hidden = false
      card.edit.textContent = project.hasCut ? 'Edit timeline' : 'Make editable'
      card.edit.prepend(icon(project.hasCut ? 'scissor-01' : 'magic-wand-01'))
      card.edit.onclick = async () => {
        if (project.hasCut) {
          timelineFolder = project.folder
          return go('timeline')
        }
        card.edit.disabled = true
        card.edit.textContent = 'Reading the composition…'
        const r = await fetch('/api/edit/seed', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ project: currentProject(), folder: project.folder }),
        }).then(responseJson).catch((e) => ({ error: e.message }))
        card.edit.disabled = false
        if (r.error) {
          tone(card.status, 'bad')
          card.status.hidden = false
          card.status.textContent = r.error
          card.edit.textContent = 'Make editable'
          return
        }
        if (r.skipped?.length) toast(`${r.clips} clips. ${r.skipped.length} had no footage on disk and were left out.`, 'bad')
        timelineFolder = project.folder
        go('timeline')
      }
      card.render.onclick = () => void renderHyperframesProject(project.folder, card.render, card.status)
      card.remove.onclick = async () => {
        if (await deleteHyperframesProject(project, card.remove, card.status)) await draw()
      }
      grid.append(root)
    }
  }
  void draw()
}

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
    const frame = mountRow('editor-frame').root
    host.append(frame)
    mountEditorInto(frame)
    return
  }

  const ui = mountPanel('editor', m)
  ui.note.hidden = hosted
  void drawEditables(ui.host)
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
  const known = await responseJson(await fetch('/api/documents')).catch(() => ({ projects: [] }))
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
    host.textContent = 'Nothing to edit yet. Record something, or drop footage into a project.'
    host.className = 'empty'
    return
  }
  host.className = ''

  const list = document.createDocumentFragment()
  for (const { project, file, needsDoc } of docs) {
    const { root: card, el: row } = mountRow('editable-doc')
    row.name.textContent = file.name
    row.path.textContent = project.name + ' · ' + file.rel
    row.kind.textContent = needsDoc ? 'no document yet' : 'document'
    row.duration.hidden = !file.media?.durationSec
    if (file.media?.durationSec) row.duration.textContent = dur(file.media.durationSec)
    const note = row.note
    const openIt = row.open
    row.openLabel.textContent = needsDoc ? 'Make a document and open' : 'Open in the editor'
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
    list.append(card)
  }
  const grid = mountRow('grid').root
  grid.append(list)
  host.append(grid)
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
  const { status, body, wait } = mountPanel('review', m)
  statusSink(status)

  const draw = async () => {
    body.replaceChildren()
    tone(status)
    status.textContent = 'asking OpenFrame…'
    wait.hidden = false
    const d = await responseJson(await fetch('/api/review')).catch((error) => ({ configured: true, base: 'OpenFrame', error: error.message }))
    wait.hidden = true

    if (!d.configured) {
      tone(status, 'warn')
      status.textContent = 'Not connected yet — the ' + d.missing.join(' and ') + (d.missing.length === 1 ? ' is' : ' are') + ' missing.'
      body.append(mountRow('review-note').root)

      /*
       * Settings live here, not only in the environment.
       *
       * They used to be two exports, which works from a terminal and is
       * unreachable from the app: a GUI launched from Finder inherits no shell
       * environment, so this page could report the problem and never fix it.
       */
      const f = mountRow('control-form').root
      const mk = (label, node, hint) => field(f, label, node, hint)
      const urlIn = mk('OpenFrame url', control('input', { placeholder: 'http://localhost:3100' }), 'Where the instance answers. Include the scheme.')
      const tokIn = mk('API token', control('input', { type: 'password', placeholder: 'tok_…' }), 'From OPENFRAME_API_TOKENS on that instance. Stored on this machine, never shown again, and never sent anywhere but OpenFrame.')
      const out = control('full')
      const save = control('button', { textContent: 'Connect' })
      save.prepend(icon('plug-01'))
      const wrap = control('full')
      wrap.append(save)
      f.append(wrap, out)
      body.append(f)

      save.onclick = async () => {
        out.replaceChildren()
        const hint = control('hint')
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
        const r = await responseJson(await fetch('/api/review/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }))
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
      /* The toast fades; the page should still say what happened and offer the
         way forward, or this view is a wall of wallpaper. */
      body.append(control('hint', { className: 'hint bad', textContent: `${d.base} did not answer: ${d.error}` }))
      const again = control('button', { className: 'btn ghost', textContent: 'Try again' })
      again.prepend(icon('refresh'))
      again.onclick = () => void draw()
      body.append(again)
      return
    }

    tone(status, 'ok')
    const shared = d.projects.reduce((n, p) => n + p.videos.length, 0)
    status.textContent = `${d.base} · ${d.workspaces} workspace${d.workspaces === 1 ? '' : 's'} · ${shared} video${shared === 1 ? '' : 's'} out for review`

    // Send something.
    const f = mountRow('control-form').root
    const pick = control('select')
    const videos = []
    for (const p of S.projects) {
      for (const file of p.catalog?.files ?? []) {
        if (file.kind !== 'video') continue
        videos.push({ p, file })
        pick.append(new Option(`${p.name} · ${file.name}`, `${p.id}::${file.rel}`))
      }
    }
    const mk = (label, node, hint) => field(f, label, node, hint)
    mk('Video', pick, 'Only finished renders are worth sending — a client reviewing an unbranded capture will comment on the branding.')
    const projName = mk('OpenFrame project', control('input', { placeholder: 'Ridgeline Railing' }), 'Created if it does not exist. Re-sending into the same one adds a version rather than a duplicate.')
    const titleIn = mk('Title', control('input', { placeholder: 'Estimating walkthrough (v1)' }))
    const out = control('full')
    const go = control('button', { textContent: 'Send for review' })
    go.prepend(icon('share-08'))
    const wrap = control('full')
    wrap.append(go)
    f.append(wrap, out)

    go.onclick = async () => {
      if (!videos.length) return
      const [projectId, rel] = pick.value.split('::')
      go.disabled = true
      out.replaceChildren()
      const hint = control('hint', { textContent: 'uploading… a render takes as long as it takes' })
      out.append(hint)
      const r = await responseJson(await fetch('/api/review/send', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ projectId, rel, project: projName.value || 'Untitled', title: titleIn.value || undefined }),
        }))
      go.disabled = false
      if (r.error) {
        tone(hint, 'bad')
        hint.textContent = r.error
        return
      }
      tone(hint, 'ok')
      hint.textContent = `${r.project} · ${r.video.title}`
      const { root: link, el: share } = mountRow('review-link')
      share.url.textContent = r.shareUrl
      copyButton(share.copy, 'Copy link', r.shareUrl)
      share.open.onclick = () => open(r.shareUrl)
      out.append(link)
      await draw()
    }
    body.append(f)

    // What is already out.
    if (shared) {
      body.append(control('client', { textContent: 'Out for review' }))
      const g = mountRow('grid').root
      for (const p of d.projects) {
        for (const v of p.videos) {
          const { root: c, el: card } = mountRow('review-card')
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
            card.art.hidden = false
            const src = '/api/review/thumb?project=' + encodeURIComponent(v.projectId) + '&video=' + encodeURIComponent(v.id)
            card.art.style.backgroundImage = `url("${src}")`
          }
          /*
           * What the listing already knows, shown.
           *
           * The card used to be a title and a path, which is why this page read as
           * "they just sit there" — nothing on it could tell you whether a client had
           * been in. The version and the comment count arrive in the same call that
           * lists the videos.
           */
          const facts = [v.version ? 'v' + v.version + (v.versions > 1 ? ' of ' + v.versions : '') : null, v.comments ? v.comments + ' comment' + (v.comments === 1 ? '' : 's') : 'no comments yet', v.duration ? Math.round(v.duration) + 's' : null].filter(Boolean)
          card.title.textContent = v.title
          card.where.textContent = p.workspace + ' · ' + p.name
          card.facts.textContent = facts.join(' · ')

          /*
           * How it is going, on demand.
           *
           * The count above is every comment ever left, so a video whose notes are
           * all dealt with looks identical to one nobody has touched. Unresolved is
           * the number that means anything, and it is a call per video — so it is a
           * button, not part of the listing.
           */
          const state = card.state
          const checkIt = card.checkIt
          checkIt.append(icon('comment-01'))
          checkIt.disabled = !v.versionId
          checkIt.onclick = async () => {
            checkIt.disabled = true
            tone(state)
            state.textContent = 'asking OpenFrame…'
            const r = await fetch('/api/review/status?version=' + encodeURIComponent(v.versionId))
              .then(responseJson)
              .catch(() => ({ error: 'the Studio did not answer — is it still running on this port?' }))
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
          const why = card.why
          const resolve = async (btn) => {
            const was = btn.textContent
            btn.disabled = true
            btn.textContent = 'Finding the link…'
            const r = await fetch(`/api/review/link?project=${encodeURIComponent(v.projectId)}&video=${encodeURIComponent(v.id)}`)
              .then(responseJson)
              .catch(() => ({ error: 'the Studio did not answer — is it still running on this port?' }))
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
          const openIt = card.openIt
          openIt.append(icon('arrow-up-right-01'))
          openIt.onclick = async () => {
            const link = await resolve(openIt)
            if (link) open(link)
          }
          const copyIt = card.copyIt
          copyIt.append(icon('link-01'))
          copyButton(copyIt, null, () => resolve(copyIt))

          /*
           * Review is a delivery copy, not this project's source video.
           *
           * Removing this card deletes the OpenFrame video and its share link;
           * the original render remains in Studio so it can be sent again. Keep
           * it behind the same armed menu used on media cards: deleting a live
           * review link on the first click would be a nasty surprise.
           */
          const remove = actionMenu([{
            icon: 'delete-02',
            text: 'Remove from review',
            busy: 'Removing…',
            danger: true,
            run: async () => {
              /*
               * responseJson, not `.json()`.
               *
               * A raw `.json()` throws on any answer that is not JSON, and the
               * catch beside it then blamed the connection — so a 404 from an
               * older `rm-studio` still running on this port, and a refusal from
               * OpenFrame, both read as "could not reach the Studio" about a
               * Studio that had answered immediately. responseJson reads the body
               * first and reports what actually came back.
               */
              const r = await fetch('/api/review/video', {
                method: 'DELETE',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ projectId: v.projectId, videoId: v.id }),
              })
                .then(responseJson)
                .catch(() => ({ error: 'the Studio did not answer — is it still running on this port?' }))
              if (r.error) return r.error
              await draw()
              return null
            },
          }], 'Review actions')
          // One row of icons rather than three stacked full-width buttons: the card is
          // a thing you glance at, and the words live in the tooltip and aria-label.
          card.acts.append(remove)
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
  { verb: 'agent', label: 'Let Claude decide the next step', fields: [{ ph: 'Open the project and make a video from this script' }], hint: 'Claude sees the live screen and its controls, takes one action, checks the result, then repeats. Use this for flows that should survive UI changes.' },
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
let pendingRecordDraft = null

function persistRecordDraft(snapshot, { keepalive = false } = {}) {
  if (!snapshot?.projectId) return
  fetch('/api/record/draft', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(snapshot),
    keepalive,
  }).catch(() => {
    // The server is this page's own host. If it is unreachable the page is too,
    // and there is nothing useful to say about it here.
  })
}

function saveDraft(projectId, { rows = [], script = '', handEdited = false } = {}) {
  if (!projectId) return
  pendingRecordDraft = { projectId, rows, script, handEdited }
  clearTimeout(draftTimer)
  draftTimer = setTimeout(() => {
    persistRecordDraft(pendingRecordDraft)
    pendingRecordDraft = null
  }, DRAFT_SAVE_MS)
}

function flushDraft() {
  clearTimeout(draftTimer)
  if (!pendingRecordDraft) return
  persistRecordDraft(pendingRecordDraft, { keepalive: true })
  pendingRecordDraft = null
}

async function loadDraft(projectId) {
  if (!projectId) return { rows: [], script: '', handEdited: false }
  const d = await fetch('/api/record/draft?project=' + encodeURIComponent(projectId))
    .then((r) => r.json())
    .catch(() => ({ rows: [], script: '', handEdited: false }))
  return {
    rows: Array.isArray(d.rows) ? d.rows : [],
    script: typeof d.script === 'string' ? d.script : '',
    handEdited: Boolean(d.handEdited),
  }
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
  const { root: wrap, el: shell } = mountRow('demo-builder')
  const list = shell.list

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
    list.replaceChildren()
    rows.forEach((r, i) => {
      const action = DEMO_ACTIONS.find((a) => a.verb === r.verb) ?? DEMO_ACTIONS[0]
      const { root: card, el: step } = mountRow('demo-step')
      const { head, args, up, down, kill, what } = step
      step.number.textContent = String(i + 1)

      for (const a of DEMO_ACTIONS) what.append(new Option(a.label, a.verb, false, a.verb === r.verb))
      what.onchange = () => {
        r.verb = what.value
        r.args = []
        draw()
        emit()
      }

      // Icons, with the words kept in aria-label: a bare glyph is unreadable to a
      // screen reader, and "↑" was not much better for anyone else.
      up.append(icon('arrow-up-01'))
      down.append(icon('arrow-down-01'))
      kill.append(icon('delete-02'))
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

      args.style.gridTemplateColumns = 'repeat(' + action.fields.length + ',1fr)'
      action.fields.forEach((f, fi) => {
        let input
        if (f.key) {
          input = control('select', { className: 'form-control' })
          for (const k of DEMO_KEYS) input.append(new Option(k, k, false, r.args[fi] === k))
          if (!r.args[fi]) r.args[fi] = DEMO_KEYS[0]
          input.onchange = () => {
            r.args[fi] = input.value
            emit()
          }
        } else {
          input = control('input', { className: 'form-control', placeholder: f.ph ?? '', value: r.args[fi] ?? '' })
          if (f.num) input.type = 'number'
          input.oninput = () => {
            r.args[fi] = input.value
            emit()
          }
        }
        args.append(input)
      })

      const say = Object.assign(step.say, { value: r.say ?? '' })
      /*
       * What the line costs, said out loud.
       *
       * The number is the point: a blank line between prose and an action promised
       * nothing about timing, so the only way to find out that a sentence outran its
       * click by four seconds was to render the whole thing and watch it drift. The
       * step holds for this long, and you can see it while you type.
       */
      const cost = step.cost
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

      const tip = action.hint ?? action.fields.find((f) => f.hint)?.hint
      step.tip.hidden = !tip
      if (tip) step.tip.textContent = tip
      list.append(card)
    })
    if (!rows.length) list.append(control('hint', { textContent: 'No steps yet. Add one, or click through the app and let it write them.' }))
  }

  const add = shell.add
  add.append(icon('add-01'), control('span', { textContent: 'Add a step' }))
  add.onclick = () => {
    // Whatever the last step was is the likeliest next one — a demo is mostly
    // clicks, and defaulting to "Go to a page" every time means re-picking.
    rows.push({ verb: rows.length ? rows[rows.length - 1].verb : 'goto', args: [], say: '' })
    draw()
    emit()
  }

  const bar = shell.bar
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
  const { name, client, brand, store, bucket, bucketGroup, status, go } = ui
  store.onchange = () => { bucketGroup.hidden = store.value === 'local' }
  statusSink(status)

  for (const p of S.presets) brand.append(new Option(p.label, p.id))
  store.append(new Option('Local folder (no bucket)', 'local'))
  for (const r of S.remotes) store.append(new Option('rclone: ' + r, r))

  go.onclick = async () => {
    go.disabled = true
    const r = await responseJson(await fetch('/api/project', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name.value,
          client: client.value,
          brand: brand.value,
          remote: store.value === 'local' ? 'local' : 's3',
          bucket: bucket.value,
        }),
      }))
    go.disabled = false
    if (r.error) {
      status.hidden = false
      status.textContent = 'Error: ' + r.error
      return
    }
    /*
     * Creating a project is step one of five, not the end of a form.
     *
     * This used to print the new folder's path and stop, so the first run ended
     * on the page that made the thing rather than in the work — somebody who had
     * just read five numbered steps was left to find step two in a sidebar that
     * had only just grown the group containing it. The project's own stage is
     * already "plan" the moment it exists, so opening it lands on the hub that
     * says so and offers the first action.
     */
    pendingHandoffNote = {
      text: `Created ${r.project.id} in ${S.libraryRoot}/${r.project.id}/. Footage/ and Renders/ are ready.`,
      tone: 'ok',
    }
    await chooseProject(r.project.id, { resume: 'workflow' })
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
  const ui = mountPanel('make', m)
  const f = ui.form
  const rail = ui.rail
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
  const brand = mk('Brand', control('select'))
  for (const p of S.presets) brand.append(new Option(p.label, p.id))
  /*
   * Claude's deliverable is always a HyperFrames project now.  An MP4 alone is
   * a dead end: it cannot carry the source, timing or editable elements needed
   * for the second workflow.  Rendering remains a deliberate later action in
   * the motion editor, after the person has reviewed the actual composition.
   */
  const output = { value: 'template' }
  mk('Destination', control('hint', { className: 'form-hint', textContent: 'HyperFrames motion project — editable first, then render when it is ready.' }))
  const title = mk('Title', control('input', { placeholder: 'Website launch promo' }))
  const secs = mk('Seconds', control('number', { value: 20, min: 5, max: 180 }))
  /*
   * Which script to build from.
   *
   * Scoped to the chosen project plus the shared shelf, and keyed by index rather
   * than by name. Both matter: the list carried every project's scripts, two of
   * them were called `intro`, and the lookup matched on name — so picking the
   * second silently loaded the first one's words. A picker that hands over
   * different content than the line you clicked is worse than no picker.
   */
  const pick = mk('Script', control('select'), 'A saved script from this project, or the shared shelf. Choosing one fills the box in the main column, which you can still edit.')
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
  const src = control('textarea', { className: 'fills' })
  src.placeholder = 'https://rolemodelsoftware.com\n\n— or paste a script —'
  let incomingScriptName = null
  const fillScripts = () => {
    const held = pick.value
    pick.replaceChildren(new Option('— write it below —', ''))
    S.scripts.forEach((sc, i) => {
      if (sc.project && sc.project !== proj.value) return
      pick.append(new Option(sc.name + (sc.project ? '' : ' · shared'), String(i)))
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
      incomingScriptName = want
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
  const picked = control('full')
  const paintPicked = () => {
    picked.replaceChildren()
    if (!chosenAssets.size) return
    const proj2 = S.projects.find((x) => x.id === proj.value)
    const byRel = new Map((proj2?.catalog?.files ?? []).map((x) => [x.rel, x]))
    const { root: group, el: assets } = mountRow('make-assets')
    assets.label.textContent = `Using ${chosenAssets.size} asset${chosenAssets.size === 1 ? '' : 's'} from this project`
    for (const rel of chosenAssets) {
      const file = byRel.get(rel)
      const { root: row, el: asset } = mountRow('make-asset')
      row.prepend(icon(file?.kind === 'audio' ? 'comment-01' : file?.kind === 'still' ? 'image-01' : 'video-01', 's3row__icon'))
      asset.name.textContent = file?.name ?? rel
      asset.meta.textContent = file ? `${file.kind}${file.media?.durationSec ? ' · ' + dur(file.media.durationSec) : ''}` : 'missing'
      asset.drop.onclick = () => {
        chosenAssets.delete(rel)
        paintPicked()
      }
      assets.list.append(row)
    }
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
  const bg = mk('Background', control('select'), 'The backdrop behind the scene. Edit these under Wallpapers.')
  bg.append(new Option('No wallpaper — flat brand colour', 'none'))
  for (const w of S.wallpapers) bg.append(new Option(w.label, w.file))
  // A new video should begin on our background, not on a generic flat field.
  // "No wallpaper" remains an explicit option for the times the work needs it.
  bg.value = S.wallpapers.find((w) => w.name === 'rm-brand')?.file ?? S.wallpapers.find((w) => /^RoleModel\b/.test(w.label))?.file ?? 'none'

  /*
   * The title card.
   *
   * Left empty there is no card at all, which is the right default for a promo cut
   * from a URL. Filled in, /api/make stages the brand into the render directory and
   * points Claude at title.html — the marks, the vendored faces and the tokens are
   * already wired together in it, which is the part that was missing when "use our
   * brand" was only a sentence in a prompt.
   */
  const titleCard = mk('Title card', control('input', { placeholder: 'Estimating a curved railing' }), 'The words on the opening card. Leave empty for no title card.')
  const eyebrow = mk('Eyebrow', control('input', { placeholder: 'RIDGELINE · WALKTHROUGH' }), 'Small mono label above the title. The client or the series, not a second headline.')

  /*
   * Footage and sound the render should use rather than invent.
   *
   * Both are files already in the project, because that is where a capture lands.
   * Offering a path field instead would mean typing one, and a typo becomes a
   * render that silently omits the thing you asked for.
   */
  const webcam = mk('Webcam clip', control('select'), 'Composited as a circular picture-in-picture, lower right — the same treatment as a recording.')
  const audio = mk('Audio', control('select'), 'A recorded voiceover, or a music bed. Narration set here is used instead of synthesising a voice.')
  const audioRole = mk('Use the audio as', control('select'), 'Narration is timed against; a music bed sits under and ducks.')
  for (const [v, l] of [
    ['narration', 'Narration — the spoken track'],
    ['music', 'Music bed — under everything'],
  ]) {
    audioRole.append(new Option(l, v))
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
      sel.replaceChildren()
      if (!mine.length) {
        sel.append(new Option(`No ${what} in this project yet`, ''))
        sel.disabled = true
        continue
      }
      sel.disabled = false
      sel.append(new Option(none, ''))
      for (const f of mine) sel.append(new Option(f.name, f.rel))
      if ([...sel.options].some((o) => o.value === keep)) sel.value = keep
    }
    audioRole.disabled = !audio.value
  }
  audio.onchange = () => {
    audioRole.disabled = !audio.value
  }
  // No change handler: switching project reloads state and re-renders this panel.
  fillClips()
  // A narration created from a script belongs to that script. Starting a video
  // from the script should carry that recorded voiceover forward rather than
  // asking Claude to guess or defaulting to silence.
  if (incomingScriptName) {
    const files = S.projects.find((x) => x.id === proj.value)?.catalog?.files ?? []
    const normal = (value) =>
      String(value)
        .replace(/\.[^.]+$/, '')
        .trim()
        .toLowerCase()
    const narration = files.find((file) => file.kind === 'audio' && normal(file.name) === normal(incomingScriptName))
    if (narration) {
      audio.value = narration.rel
      audioRole.value = 'narration'
      audioRole.disabled = false
    }
  }

  /*
   * Narration.
   *
   * Make is where the video is actually made, so this cannot be a Kokoro-only
   * selector while Voice can use ElevenLabs. That split made someone choose their
   * own voice in one place and lose it the moment they built the video. Both
   * providers use the same list endpoint and the same key field as Voice.
   */
  const voiceProvider = mk('Narration source', control('select'), 'Pick the service that should speak this render.')
  for (const [value, label] of [
    ['kokoro', 'Kokoro — local, on this machine'],
    ['elevenlabs', 'ElevenLabs — your saved voices'],
  ])
    voiceProvider.append(new Option(label, value))
  const vo = mk('Narration voice', control('select'), 'Choose the exact voice for this render. “No voiceover” keeps it silent.')
  const voHint = control('hint')
  fieldRow(rail, voHint)
  const voiceKeys = apiKeyBlock(rail, { onSaved: () => loadNarrationVoices() })
  const loadNarrationVoices = async () => {
    const chosen = vo.value
    const provider = voiceProvider.value
    vo.replaceChildren(new Option('No voiceover — silent render', ''))
    tone(voHint)
    voHint.textContent = 'reading the voice list...'
    const d = await responseJson(await fetch('/api/voices?provider=' + encodeURIComponent(provider))).catch(() => ({ from: 'none', voices: [] }))
    for (const v of d.voices ?? []) vo.append(new Option(v.label, v.id))
    voiceKeys.show(provider === 'elevenlabs')
    if (d.from === 'kokoro') {
      voHint.textContent = d.voices.length + ' local voices. Nothing leaves this machine.'
    } else if (d.from === 'elevenlabs') {
      tone(voHint, 'warn')
      voHint.textContent = d.voices.length + ' voices from your ElevenLabs account. The selected script is sent to ElevenLabs to make the narration.'
    } else {
      tone(voHint, 'bad')
      voHint.textContent = d.note || 'No voices available.'
    }
    if ([...vo.options].some((option) => option.value === chosen)) vo.value = chosen
    else if (d.voices?.[0]) vo.value = d.voices[0].id
  }
  voiceProvider.onchange = loadNarrationVoices
  loadNarrationVoices()

  // Motion. The panel names a preset; /api/make turns it into the sentences that
  // actually reach Claude (brand/motion.json). Without this the model chose its own
  // easing every run, so no two renders moved alike.
  const mo = mk('Motion', control('select'), 'How things move. Brand is the design system\u2019s own signature \u2014 short, eased, nothing bouncy.')
  const moPresets = S.motion?.presets?.length ? S.motion.presets : [{ id: 'brand', label: 'Brand \u2014 Optics motion' }]
  for (const m of moPresets) mo.append(new Option(m.label, m.id))
  mo.value = S.motion?.default || moPresets[0].id

  const chromeUrl = control('input', { placeholder: 'app.rolemodelsoftware.com' })
  const cBrowser = smallSwitch(rail, 'Browser chrome')
  const cCaps = smallSwitch(rail, 'Burn in captions')
  const urlField = mk('Shown in the chrome', chromeUrl, 'The URL drawn in the fake address bar. Only used with browser chrome.')
  chromeUrl.disabled = true
  cBrowser.onchange = () => {
    chromeUrl.disabled = !cBrowser.checked
  }
  // The one thing this panel is for, so the one thing in the footer. The Run
  // button that appears after a build joins it in `runSlot`, beside it rather
  // than somewhere down the page.
  const go = ui.go
  const runSlot = ui.runSlot
  // The argv belongs with the buttons but not between them; a .runrow holding
  // only the command gives it the same mono treatment it has everywhere else.
  const runHere = control('full')
  const out = control('full')
  // The argv and the prompt are what the run LEAVES behind, so they stay in main
  // under the script. Only the buttons go to the footer.
  f.append(runHere, out)
  const showPlan = (r) => {
    out.replaceChildren()
    runHere.replaceChildren()
    runSlot.replaceChildren()
    if (r.error) {
      out.append(control('preformatted', { textContent: 'Error: ' + r.error }))
      return
    }
    const runBtn = control('button', { textContent: 'Ask Claude to build the motion project' })
    const runStatus = control('status-line')
    runBtn.onclick = () => runWithStatus(r.step, runBtn, runStatus)
    runSlot.append(runBtn, runStatus)
    const { root: argv, el: argvBits } = mountRow('make-argv')
    argvBits.code.textContent = show(r.step)
    runHere.append(argv)
    // Below the actions: the prompt, a Copy button beside it, and where the
    // brief landed. Reference material, not the next thing you press.
    out.append(control('preformatted', { textContent: r.prompt }))

    const c = copyButton(control('button', { className: 'btn ghost', textContent: 'Copy the prompt' }), 'Copy the prompt', r.prompt)
    const copyRow = control('div')
    copyRow.append(c)
    out.append(copyRow)

    out.append(control('path', { textContent: 'brief  ' + r.brief }))
    if (r.output === 'template') {
      const { nodes, el: tpl } = mountRow('make-template-actions')
      tpl.open.onclick = () => void openHyperframesProject(r.hyperframesProject, tpl.open, tpl.status)
      tpl.check.onclick = () => runWithStatus(r.lintStep, tpl.check, tpl.status)
      tpl.render.onclick = () => runWithStatus(r.renderStep, tpl.render, tpl.status)
      out.append(...nodes, control('path', { textContent: 'template  ' + r.template }))
    }
  }
  go.onclick = async () => {
    const r = await responseJson(await fetch('/api/make', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId: proj.value,
          brand: brand.value,
          title: title.value,
          seconds: secs.value,
          source: src.value,
          wallpaper: bg.value,
          browser: cBrowser.checked,
          browserUrl: chromeUrl.value.trim(),
          captions: cCaps.checked,
          motion: mo.value,
          voice: vo.value,
          voiceProvider: voiceProvider.value,
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
      }))
    latestMakePlan = r.error ? null : r
    showPlan(r)
  }
  if (latestMakePlan) showPlan(latestMakePlan)
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

/*
 * A result handed forward to the view a navigation is about to open.
 *
 * Some work finishes by going somewhere else — building a cut ends in the motion
 * editor. Saying "it worked" on the page being left is writing to a node that
 * render() is about to detach, so the confirmation is handed to the destination
 * and painted once it arrives. `{ text, tone }`; read and cleared by the view
 * that shows it, so a second visit is not congratulated again.
 */
let pendingHandoffNote = null

/** Paint a handed-over confirmation at the top of the view it was aimed at. */
function handoffNote() {
  if (!pendingHandoffNote) return null
  const { text, tone: kind } = pendingHandoffNote
  pendingHandoffNote = null
  const { root: note } = mountRow('handoff-note')
  note.textContent = text
  tone(note, kind)
  return note
}

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
      crumbs(scopedCrumbs([{ label: 'New video' }]))
      clearPanelRegions()
      return
    }
    crumbs(
      scopedCrumbs([
        {
          label: 'New video',
          go: () => {
            createTab = null
            paint()
          },
        },
        { label: CREATE_TABS.find(([id]) => id === createTab)?.[1] ?? createTab },
      ]),
    )
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
  const ui = mountPanel('record', m)
  const { osWarn } = ui
  ;(async () => {
    const d = await responseJson(await fetch('/api/openscreen')).catch(() => null)
    if (!d || d.ok) return
    osWarn.hidden = false
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
  const f = ui.form
  const rail = ui.rail
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
  const title = mk('Name', control('input', { placeholder: 'estimating-screen' }))

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
  const { root: cell, el: capture } = mountRow('record-capture')
  const { pick, typed } = capture
  const srcHint = control('hint')
  mk('Capture', cell, srcHint)

  // Options are addressed by their position in this list, not by their value: a
  // window title can contain anything, including the separator you were going to
  // encode the kind with.
  let sources = []

  const fill = async () => {
    pick.replaceChildren(new Option('Whole screen', ''))
    tone(srcHint)
    srcHint.textContent = 'reading what is open...'
    const d = await responseJson(await fetch('/api/sources')).catch(() => ({ from: 'none', windows: [] }))
    sources = d.windows ?? []
    sources.forEach((src, i) => pick.append(new Option(src.label, String(i))))
    pick.append(new Option('Type a window title instead...', TYPE_IT))
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
  const refresh = control('button', { className: 'btn ghost', textContent: 'Refresh the list' })
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
  let script = null
  let builder = null

  const queueRecordDraft = () => {
    saveDraft(proj.value, {
      rows: builder ? builder.rows() : [],
      script: script?.value ?? '',
      handEdited,
    })
  }

  /*
   * The steps, as rows.
   *
   * The builder writes the markdown; the markdown is still what runs. That split
   * is deliberate — the checker, the server and rm-demo are all unchanged, and the
   * script stays a file you can read, diff and hand-edit. What changes is that
   * nobody has to author it to get started.
   */
  builder = demoBuilder(
    (text, count, time) => {
      if (!handEdited && script) script.value = text
      const secs = (ms) => (ms / 1000).toFixed(1) + 's'
      stepCount.textContent = count ? `${count} step${count === 1 ? '' : 's'} · ${secs(time.holds)} of holds · ${secs(time.words)} of narration` : ''
      recheck()
    },
    () => queueRecordDraft(),
  )

  const stepCount = control('path')
  const builderHint = control('hint')
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
  const stepCell = mountRow('record-steps-cell').root
  stepCell.append(builder.node, builderHint, stepCount)
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
  script = control('textarea', { className: 'form-control', rows: 9 })
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
  const scriptHint = control('hint')
  /*
   * The script is a field, not a disclosure.
   *
   * It used to be the only thing behind a collapsed "The script this writes"
   * summary — while every control that depends on it sat in plain view, disabled,
   * explaining "Only applies once there is a script". Six knobs you cannot touch,
   * and the switch that unlocks them out of sight. Out here it reads as what it is:
   * the thing that turns a screen recording into a driven one.
   */
  const scriptCell = control('full')
  const scriptForm = mountRow('record-script-form').root
  field(scriptForm, 'Script', script, scriptHint)
  slashField(script, () => proj.value)

  /*
   * A saved project script is a useful starting point for a recording, not a
   * hidden slash-command trick. The Record view can stay alive while Scripts
   * saves or Claude finishes a draft, so re-read the state here before offering
   * the list; otherwise the person who just made a script gets an empty picker.
   */
  const { root: savedScriptGroup, el: saved } = mountRow('record-saved-script')
  const savedScript = saved.pick
  const insertSavedScript = saved.insert
  const refreshSavedScripts = saved.refresh
  const savedScriptHint = saved.hint
  const fillSavedScripts = () => {
    const scripts = (S?.scripts ?? []).filter((item) => item.project === proj.value).sort((a, b) => String(b.mtime ?? '').localeCompare(String(a.mtime ?? '')))
    const prior = savedScript.value
    savedScript.replaceChildren()
    savedScript.append(new Option(scripts.length ? 'Choose a saved script…' : 'No saved scripts in this project yet', ''))
    for (const item of scripts) savedScript.append(new Option(item.name, item.name))
    if (scripts.some((item) => item.name === prior)) savedScript.value = prior
    savedScript.disabled = !scripts.length
    insertSavedScript.disabled = !scripts.length
    savedScriptHint.textContent = scripts.length ? 'Insert one at the cursor. It stays editable here.' : 'Save or finish a script in this project, then refresh this list.'
  }
  const refreshSavedScriptState = async () => {
    refreshSavedScripts.disabled = true
    const fresh = await fetch('/api/state')
      .then(responseJson)
      .catch(() => null)
    if (fresh && !fresh.error) S = fresh
    refreshSavedScripts.disabled = false
    fillSavedScripts()
  }
  insertSavedScript.onclick = () => {
    const chosen = (S?.scripts ?? []).find((item) => item.project === proj.value && item.name === savedScript.value)
    if (!chosen) {
      savedScriptHint.textContent = 'Choose a saved script first.'
      return
    }
    const start = script.selectionStart ?? script.value.length
    const end = script.selectionEnd ?? start
    const before = script.value.slice(0, start)
    const after = script.value.slice(end)
    const join = before && !before.endsWith('\n') ? '\n\n' : ''
    const tail = after && !chosen.body.endsWith('\n') ? '\n\n' : ''
    script.value = before + join + chosen.body + tail + after
    const caret = before.length + join.length + chosen.body.length
    script.focus()
    script.setSelectionRange(caret, caret)
    handEdited = true
    queueRecordDraft()
    recheck()
    savedScriptHint.textContent = `Inserted ${chosen.name}.`
  }
  refreshSavedScripts.onclick = () => void refreshSavedScriptState()
  fillSavedScripts()
  scriptForm.append(savedScriptGroup)
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
    queueRecordDraft()
    recheck()
  }

  // After the script, because what it means depends on whether one exists.
  const secs = mk('Stop after', control('number', { value: 30, min: 5, max: 600 }), 'Seconds. With a script above, the capture ends when the script does and this is only the backstop for a run that hangs.')

  // Audio. Three of the recorder's flags that this panel never offered, so a
  // capture that needed a microphone meant abandoning the UI and typing it out.
  const mic = smallSwitch(rail, 'Microphone')
  const micDevice = control('input', { placeholder: 'MacBook Pro Microphone' })
  mk('Microphone device', micDevice, 'A named input instead of the default. Filling this turns the microphone on by itself.')
  // The device implies the switch; show that instead of asking people to know it.
  micDevice.addEventListener('input', () => { if (micDevice.value.trim()) mic.checked = true })
  const sysAudio = smallSwitch(rail, 'System audio')

  /*
   * A voiceover someone already made belongs on the recording, not hidden in a
   * later render form. The source capture stays untouched; this choice is used
   * when Studio exports the project video at the end of the capture chain.
   */
  const projectAudio = (currentProjectRecord()?.catalog?.files ?? []).filter((f) => f.kind === 'audio')
  const audio = control('select')
  audio.append(new Option('Use the recorded sound', ''))
  for (const f of projectAudio) audio.append(new Option(f.name, f.rel))
  const audioMode = control('select')
  for (const [v, label] of [
    ['replace', 'Replace the recorded sound'],
    ['mix', 'Mix with the recorded sound'],
  ])
    audioMode.append(new Option(label, v))
  const audioOffset = control('number', { value: 0, min: 0, step: 0.1 })
  mk('Add project audio', audio, projectAudio.length ? 'Adds a saved narration or music track to the final project video. The raw recording stays unchanged.' : 'No audio in this project yet. Add or generate it in the Library, then it will appear here.')
  mk('Audio handling', audioMode)
  mk('Audio starts at', audioOffset, 'Seconds from the start of the recording.')

  const cursor = control('select')
  for (const [v, label] of [
    ['editable-overlay', 'Editable overlay — the editor can restyle it'],
    ['system', 'System cursor — burnt into the frames'],
  ]) {
    cursor.append(new Option(label, v))
  }
  mk('Cursor and clicks', cursor, 'Editable overlay keeps cursor movement and clicks available to OpenScreen: the editor shows the click bounce, and the final export can automatically zoom at active moments. The system cursor is baked in and cannot be changed after the fact.')

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
  /*
   * One dial with three answers, rather than a checkbox called "use the browser I
   * have open".
   *
   * The checkbox read as the obvious yes — of course you want your own browser,
   * signed in, with your data in it — and it led to the worst instruction in this
   * app: quit Chrome completely, relaunch it from a terminal with two flags, come
   * back. Nobody making a video is going to do that.
   *
   * The middle answer is what almost everyone actually wanted, and it costs one
   * sign-in rather than a relaunch. Attaching stays, because a session that cannot
   * be reproduced — a VPN, an SSO device trust, a flow already part-way through —
   * is a real case; it is just not the default, and it now says what it costs.
   */
  const session = control('select')
  for (const [v, l] of [
    ['fresh', 'A fresh browser each time'],
    ['profile', 'A browser I stay signed in to'],
    ['attach', 'The browser I have open (advanced)'],
  ]) {
    session.append(new Option(l, v))
  }
  // A video of a real product normally needs a real signed-in session. Fresh
  // Chromium is still there for public sites, but a retained Chrome profile makes
  // the first capture useful instead of asking someone to recreate their world.
  session.value = 'profile'
  const attach = {
    get checked() {
      return session.value === 'attach'
    },
  }
  const attachHint = control('hint')
  const cdp = control('input', { placeholder: 'http://127.0.0.1:9222' })
  const pageMatch = control('input', { placeholder: 'part of the tab title, e.g. Ridgeline' })
  mk('Signed in as', session, attachHint)
  mk('Debugging address', cdp, 'Where that browser exposes CDP. Blank means http://127.0.0.1:9222.')
  mk('Which tab', pageMatch, 'Matched against the tab title or its URL. Blank takes the first ordinary tab.')

  const url = control('input', { placeholder: 'https://your-app.example.com' })
  const vw = control('number', { value: 1440, min: 320, max: 7680 })
  const vh = control('number', { value: 900, min: 240, max: 4320 })
  /*
   * Which browser the script drives.
   *
   * Playwright ships its own Chromium and that is what used to launch — a plain
   * blue-globe icon with no profile and no branding. Fine for a trace nobody
   * watches, wrong for a capture: the video shows a browser the viewer has never
   * seen, which reads as a mock-up rather than the product.
   */
  const browserPick = control('select')
  for (const [v, l] of [
    ['chrome', 'Google Chrome'],
    ['chromium', "Chromium (Playwright's own)"],
    ['edge', 'Microsoft Edge'],
  ]) {
    browserPick.append(new Option(l, v))
  }
  mk('Base URL', url, 'So a script can say `goto /quotes/new` instead of repeating the host on every line.')
  mk('Viewport width', vw)
  mk('Viewport height', vh, 'The browser window the script drives, and therefore the shape of the capture.')
  mk('Browser', browserPick, 'The one the viewer will recognise. Falls back to the bundled Chromium if it is not installed.')
  const headless = smallSwitch(rail, 'Headless')

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
    showGroup(session, scripted)
    for (const c of attachOnly) showGroup(c, attached)
    // Viewport and headless belong to a browser we launch. Attaching uses the window
    // that is already there, at whatever size it already is.
    for (const c of driverOnly) showGroup(c, scripted && !attached)
    if (attached) {
      tone(attachHint, 'warn')
      // The * is quoted: zsh globs a bare one and the command fails with
      // "no matches found" before Chrome ever sees it.
      attachHint.textContent = 'Only if you need a session that cannot be signed into again. Chrome cannot be given a debugging port while it is running, so this means quitting it completely and starting it again:  open -a "Google Chrome" --args --remote-debugging-port=9222 --remote-allow-origins=\'*\''
    } else if (session.value === 'profile') {
      tone(attachHint, 'ok')
      attachHint.textContent = 'Real Chrome with its own profile, kept between captures. Sign in once in the window that opens and it remembers. The Chrome you have open now keeps running, untouched.'
    } else {
      tone(attachHint)
      // No "not yet" branch: with no script the control is not on screen to explain.
      attachHint.textContent = 'Blank and signed into nothing, which is right for a public site. The script needs a "Go to a page" step.'
    }
    micDevice.disabled = false
    mic.disabled = micDevice.value.trim().length > 0
    mic.closest('.form-group')?.style.setProperty('opacity', mic.disabled ? '0.45' : '1')
  }
  micDevice.oninput = syncKnobs
  session.onchange = syncKnobs

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
      const d = await responseJson(await fetch('/api/demo/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body }) }))
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
        scriptHint.textContent = `${d.actions} action${d.actions === 1 ? '' : 's'}, but the script never goes to a page — a launched capture opens a blank browser. Add "Go to a page" as the first step, or set "Signed in as" to a browser that is already on a page.`
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
  const rebuild = control('button', { className: 'btn ghost' })
  rebuild.append(icon('refresh'), control('span', { textContent: 'Rebuild rows from the script' }))
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
  const insert = control('button', { className: 'btn ghost' })
  insert.append(icon('add-01'), control('span', { textContent: 'Insert steps into the script' }))
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
    queueRecordDraft()
    recheck()
  }
  builder.bar.append(insert, rebuild)

  // No change handler: switching project reloads state and re-renders this panel.
  // Awaited, so a draft that exists is on screen before anything can overwrite it.
  loadDraft(proj.value).then((draft) => {
    handEdited = draft.handEdited
    if (draft.rows.length) builder.load(draft.rows)
    if (draft.script && (draft.handEdited || !script.value.trim())) script.value = draft.script
    recheck()
  })
  window.addEventListener('rm:before-navigate', flushDraft, { once: true })
  window.addEventListener('pagehide', flushDraft, { once: true })

  const steps = control('full')
  const go = ui.go
  // `steps` is what the setup LEAVES — the plan and a Run button per step — so it
  // stays in main under the script it describes. Only the button moves.
  f.append(steps)
  go.onclick = async () => {
    // A typed value is always a title; a picked one carries its own kind, because
    // record takes a screen by index and a window by title and neither by id.
    const source = pick.value === TYPE_IT ? { kind: 'window', value: typed.value.trim() } : pick.value === '' ? { kind: '', value: '' } : (sources[Number(pick.value)] ?? { kind: '', value: '' })
    const r = await responseJson(await fetch('/api/record', {
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
          audioRel: audio.value,
          audioMode: audioMode.value,
          audioOffset: audioOffset.value,
          cursor: cursor.value,
          url: url.value,
          width: vw.value,
          height: vh.value,
          headless: headless.checked,
          browser: browserPick.value,
          profile: session.value === 'profile',
        }),
      }))
    steps.replaceChildren()
    if (r.error) {
      steps.append(control('hint', { className: 'hint bad', textContent: r.error }))
      return
    }
    steps.append(
      plan([
        r.script
          ? session.value === 'profile'
            ? ['Open your signed-in browser, drive it through the script, and record it.', 'Real Chrome with a profile the Studio keeps, so a sign-in survives to the next capture and the Chrome you have open is left alone. The capture ends when the script does. ' + (secs.value ? secs.value + 's is the backstop.' : 'No backstop set.') + ' Script saved at ' + r.script]
            : attach.checked
              ? ['Drive the browser you already have open, and record it.', 'Attaching to it over CDP rather than launching one, so the page stays signed in and the window recorded is the one being driven. The capture ends when the script does. ' + (secs.value ? secs.value + 's is the backstop.' : 'No backstop set.') + ' Script saved at ' + r.script]
              : ['Open a browser, drive it through the script, and record it.', 'Not the window picked above — this opens its own browser, so that is what gets recorded, and it starts blank. The capture ends when the script does. ' + (secs.value ? secs.value + 's is the backstop.' : 'No backstop set.') + ' Script saved at ' + r.script]
          : [source.kind === 'window' ? 'Capture the first window whose title contains "' + source.value + '".' : source.kind === 'display' ? 'Capture screen ' + source.value + ' whole.' : 'Capture the whole screen.', 'Nothing drives it — it records for ' + (secs.value || 30) + ' seconds and stops. Add a script above to make it a demo.'],
        ['Apply the RoleModel preset.', 'Wallpaper, padding, radius and shadow, written into the .openscreen document.'],
        ['Build the final mp4.', r.audio ? `${r.audio.rel} is attached from ${r.audio.offset}s, ${r.audio.mode === 'mix' ? 'mixed with' : 'replacing'} the capture sound. The raw recording stays untouched.` : 'It is branded, exported, and added back to this project automatically.'],
      ]),
    )
    for (const s of r.steps) steps.append(runRow(s))

    const { root: openRow, el: opener } = mountRow('record-open')
    const openBtn = opener.open
    const openNote = opener.note
    openBtn.onclick = async () => {
      openBtn.disabled = true
      openNote.textContent = 'opening...'
      const o = await responseJson(await fetch('/api/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: r.editable }) }))
      openBtn.disabled = false
      openNote.textContent = o.error ? o.error : o.note
    }
    opener.path.textContent = r.editable
    steps.append(openRow)

    // This is the primary path: no command hand-off or hidden final export.
    const all = control('button', { textContent: 'Record, brand, and add the video to this project' })
    const chainNote = control('hint')
    all.onclick = async () => {
      all.disabled = true
      chainNote.textContent = ''
      chainNote.className = 'hint'
      let ok = true
      for (const s of r.steps) {
        tone(chainNote, 'ok')
        chainNote.textContent = `${s.label} is working in the background.`
        const j = await start(s, { status: chainNote })
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
          chainNote.textContent = `Stopped after ${s.label} — it exited ${code === null ? 'without a status' : code}. The steps after it did not run.`
          jobDetailLink(chainNote, j.id)
          break
        }
      }
      if (ok) {
        // The task wrote directly into Footage. Re-index before we call it ready,
        // so the result is already in the project when the person goes looking.
        await fetch('/api/index/' + encodeURIComponent(proj.value), { method: 'POST' }).catch(() => {})
        tone(chainNote, 'ok')
        chainNote.textContent = 'Video is ready in this project: ' + (r.video || r.dest)
      }
      all.disabled = false
      refreshJobs()
    }
    steps.append(all, chainNote)
  }
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
  const ui = mountPanel('recast', m)

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
  const f = ui.form
  const rail = ui.rail
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

  const title = mk('Name', control('input', { placeholder: 'estimating-walkthrough' }), 'Names the output folder, and is how narration is matched: a Voice run saved under the same name is picked up automatically.')

  // The two fields that used to want a hand-typed path.
  const traceHint = async (path, hint) => {
    tone(hint)
    hint.textContent = path ? 'checking…' : ''
    if (!path) return
    const d = await responseJson(await fetch('/api/trace/probe?path=' + encodeURIComponent(path)))
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
  const demoBody = control('textarea', { rows: 10, spellcheck: false })
  demoBody.placeholder = ['We start on the estimating screen.', '', '```do', 'goto https://your-app.example.com/quotes/new', 'expect "REQUEST QUOTE"', 'click "3D VIEW"', 'wait 800', '```', '', 'Adding a railing is two clicks.'].join('\n')
  const demoHint = control('hint')
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
      const d = await responseJson(await fetch('/api/demo/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body }) }))
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
  const example = control('button', { textContent: 'Load the example', className: 'btn ghost' })
  example.title = 'A short tour of rolemodelsoftware.com — a working script you can run as-is or edit'
  example.onclick = async () => {
    const r = await responseJson(await fetch('/api/demo/example'))
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
  const exampleWrap = control('full')
  exampleWrap.append(example)
  f.append(exampleWrap)

  const demoSteps = control('full')
  const demoGo = control('button', { textContent: 'Set up the demo run', className: 'btn ghost' })
  const demoWrap = control('full')
  demoWrap.append(demoGo)
  f.append(demoWrap, demoSteps)
  demoGo.onclick = async () => {
    demoSteps.replaceChildren()
    const r = await responseJson(await fetch('/api/demo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: proj.value, name: title.value || 'demo', body: demoBody.value }),
      }))
    if (r.error) {
      demoSteps.append(control('hint', { className: 'hint bad', textContent: r.error }))
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
    const watch = control('button', { textContent: 'Run it and use the trace', className: 'btn ghost' })
    const watchNote = control('hint')
    watch.onclick = async () => {
      watch.disabled = true
      tone(watchNote, 'ok')
      watchNote.textContent = 'The demo is working in the background. Its trace will return here when it is ready.'
      const j = await start(r.steps[0], { status: watchNote })
      if (!j) {
        watch.disabled = false
        tone(watchNote, 'bad')
        watchNote.textContent = 'Could not start the demo.'
        return
      }
      const code = await waitFor(j.id)
      watch.disabled = false
      if (code !== 0) {
        tone(watchNote, 'bad')
        watchNote.textContent = `The demo exited ${code === null ? 'without a status' : code}. The Trace field was left alone.`
        jobDetailLink(watchNote, j.id)
        return
      }
      tone(watchNote, 'ok')
      watchNote.textContent = 'The trace is ready and has been attached to this demo.'
      trace.value = r.trace
      trace.dispatchEvent(new Event('change'))
      go('recast')
    }
    demoSteps.append(watch, watchNote)
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
  const prov = mk('Voice', control('select'))
  for (const [id, cfg] of Object.entries(PROVIDERS)) prov.append(new Option(cfg.label, id))
  const voiceHint = control('hint')
  const voice = mk('Voice ID', control('input'), voiceHint)
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
  const ttsModel = mk('TTS model', control('input'), 'Optional. OpenAI: tts-1 or tts-1-hd. ElevenLabs: a model id such as eleven_multilingual_v2. Left empty, the provider picks.')
  const ttsSpeed = mk('TTS speed', control('number', { value: '', min: 0.25, max: 4, step: 0.05, placeholder: 'provider default' }), 'Speech-rate multiplier. OpenAI honours this; the others ignore it.')
  const qwenConfig = pathField(rail, 'Qwen config', { placeholder: 'required when the voice is Qwen — a .json', accept: () => true })
  const textCfg = pathField(rail, 'Text processing config', { placeholder: 'optional — recast’s own JSON rules', accept: () => true })

  const idle = mk('Idle speed', control('number', { value: 3, min: 0.25, max: 20, step: 0.5 }), 'How much dead time between clicks is compressed. 3 means idle stretches run three times faster.')
  const action = mk('Action speed', control('number', { value: 1, min: 0.25, max: 20, step: 0.25 }), 'The clicks and typing themselves. 1 is real time — above that the pointer moves faster than a person could follow.')
  const network = mk('Network-wait speed', control('number', { value: 2, min: 0.25, max: 20, step: 0.25 }), 'Time the test spent waiting on the network. Separate from idle because a slow request is not the same as a pause for effect.')
  const rez = mk('Resolution', control('select'))
  for (const o of ['1080p', '720p']) rez.append(new Option(o, o))
  const fmt = mk('Format', control('select'))
  for (const o of ['mp4', 'webm']) fmt.append(new Option(o, o))
  const fmtHint = control('hint')
  rail.append(fmtHint)

  const cursorCfg = pathField(rail, 'Cursor overlay config', { placeholder: 'optional — recast’s own JSON', accept: () => true })
  const clickCfg = pathField(rail, 'Click effect config', { placeholder: 'optional — recast’s own JSON', accept: () => true })
  const clickSound = pathField(rail, 'Click sound', { placeholder: 'optional — an audio file played on each click', accept: (x) => x.audio })

  const iFps = mk('Interpolated fps', control('number', { value: 60, min: 24, max: 240, step: 1 }))
  const iMode = mk('Interpolation mode', control('select'), 'mci reconstructs motion and is the slowest; blend cross-fades; dup just repeats frames and is there to compare against.')
  for (const o of ['mci', 'blend', 'dup']) iMode.append(new Option(o, o))
  const iQual = mk('Interpolation quality', control('select'))
  for (const o of ['balanced', 'fast', 'quality']) iQual.append(new Option(o, o))
  const iPasses = mk('Interpolation passes', control('number', { value: 1, min: 1, max: 4, step: 1 }), 'More than one is rarely worth the minutes it costs.')

  const cCursor = smallSwitch(rail, 'Cursor overlay', true)
  const cClick = smallSwitch(rail, 'Click effects', true)
  const cInterp = smallSwitch(rail, 'Interpolate')
  const cNoSpeed = smallSwitch(rail, 'Keep real timing')
  const cTextProc = smallSwitch(rail, 'Sanitise text for TTS')

  /** Disable what the current switches make meaningless, and say why. */
  const syncOpts = () => {
    const speeding = !cNoSpeed.checked
    for (const el2 of [idle, action, network]) el2.disabled = !speeding
    const interp = cInterp.checked
    for (const el2 of [iFps, iMode, iQual, iPasses]) el2.disabled = !interp
    for (const el2 of [cursorCfg]) el2.disabled = !cCursor.checked
    for (const el2 of [clickCfg, clickSound]) el2.disabled = !cClick.checked
    textCfg.disabled = !cTextProc.checked
    tone(fmtHint)
    fmtHint.textContent = fmt.value === 'webm' ? 'webm skips the narration mux: rm-mux writes mp4, and it is the step that reconciles the render’s clock with the narration’s. Subtitles get burned by recast instead, against the wrong clock.' : ''
  }
  fmt.onchange = syncOpts
  for (const control of [cCursor, cClick, cInterp, cNoSpeed, cTextProc]) control.onchange = syncOpts

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

  const out = control('full')
  const build = ui.build
  // `out` stays in main: it is what the build LEAVES — the plan, the argv and a
  // Run button per step — and it belongs under the script it describes.
  f.append(out)

  build.onclick = async () => {
    if (!trace.value.trim()) {
      out.replaceChildren(control('hint', { className: 'hint bad', textContent: 'Pick a trace first — Browse… opens your home directory.' }))
      return
    }
    build.disabled = true
    setLabel(build, 'Working it out…')
    const r = await responseJson(await fetch('/api/recast', {
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
          textProcessing: cTextProc.checked,
          textProcessingConfig: textCfg.value.trim() || null,
          noSpeed: cNoSpeed.checked,
          speedIdle: idle.value,
          speedAction: action.value,
          speedNetwork: network.value,
          resolution: rez.value,
          format: fmt.value,
          cursor: cCursor.checked,
          cursorConfig: cursorCfg.value.trim() || null,
          click: cClick.checked,
          clickConfig: clickCfg.value.trim() || null,
          clickSound: clickSound.value.trim() || null,
          interpolate: cInterp.checked,
          interpolateFps: iFps.value,
          interpolateMode: iMode.value,
          interpolateQuality: iQual.value,
          interpolatePasses: iPasses.value,
        }),
      }))
    build.disabled = false
    setLabel(build, 'Work out the steps')
    out.replaceChildren()
    if (r.error) {
      out.append(control('hint', { className: 'hint bad', textContent: r.error }))
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
      const all = control('button', { textContent: 'Run both, in order' })
      const chainNote = control('hint')
      all.onclick = async () => {
        all.disabled = true
        chainNote.textContent = ''
        chainNote.className = 'hint'
        for (const st of r.steps) {
          tone(chainNote, 'ok')
          chainNote.textContent = `${st.label} is working in the background.`
          const j = await start(st, { status: chainNote })
          if (!j) break
          const code = await waitFor(j.id)
          if (code !== 0) {
            chainNote.className = 'hint bad'
            chainNote.textContent = `Stopped after ${st.label} — it exited ${code === null ? 'without a status' : code}. The step after it did not run.`
            jobDetailLink(chainNote, j.id)
            break
          }
        }
        all.disabled = false
        refreshJobs()
      }
      out.append(all, chainNote)
    }
  }
  // The four numbered steps read once; they sit above the rail's settings.
  rail.before(steps)
}

/* ── Voice ───────────────────────────────────────────────────
   One clip per line, cached on (voice, text), then an SRT written from the
   durations we measured. Nothing gets transcribed back — we already know the
   words, and asking Whisper to guess at them is how "Ridgeline" becomes "Phoenix". */
function vVoice(m) {
  const ui = mountPanel('voice', m)

  // Voice needs two Python packages, and a bare pip install fails on a current Mac
  // with PEP 668. Rather than document that, offer a button that builds a
  // private virtualenv. Nothing touches system Python.
  if (!S.tools.voice) {
    ui.setupBox.hidden = false
    const b = ui.setup
    const out = ui.setupOut
    b.onclick = async () => {
      const r = await fetch('/api/voice/setup', { method: 'POST' }).then(responseJson)
      out.replaceChildren()
      if (r.error) {
        out.append(control('preformatted', { textContent: 'Error: ' + r.error }))
        return
      }
      const status = control('hint', { className: 'voice__status' })
      statusSink(status)
      out.append(control('path', { textContent: 'Setting up voice on this machine…' }), status)
      runWithStatus(r.step, b, status, (job) => {
        if (job?.code === 0) status.textContent = 'Voice is ready. Reload this page to choose a voice.'
      })
    }
  }

  // The spoken lines are the work; provider, voice and timing are settings.
  // Keep the result with the preview, put those dials in the shared rail, and
  // leave the one irreversible action in the page footer.
  const rail = ui.rail
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
  const pick = mk('Script', control('select'), 'Choose a saved script for this project. In a script field, type /script to insert one.')
  /*
   * Where the voice comes from. Kokoro is first and default because it is local:
   * no key, no per-character cost, and the script never leaves the machine.
   * ElevenLabs is here for when a client has asked for a specific commercial
   * voice, and the panel says what that costs you in privacy at the moment of
   * choosing rather than in a doc nobody reads.
   */
  const prov = mk('Voice from', control('select'))
  for (const [id, label] of [
    ['kokoro', 'Kokoro — local, on this machine'],
    ['elevenlabs', 'ElevenLabs — cloud, sends your script'],
  ])
    prov.append(new Option(label, id))

  const voiceHint = control('hint')
  const voice = mk('Voice', control('select'), voiceHint)
  // Where the "Download it now" button goes when the list could not be read. Its own
  // row, so it is not inside the hint text it is answering.
  const { root: fixRow, el: fix } = mountRow('voice-fix-row')
  fix.go.hidden = true
  rail.append(fixRow)

  const keys = apiKeyBlock(rail, { onSaved: () => loadVoices() })

  const loadVoices = async () => {
    const which = prov.value
    voice.replaceChildren()
    tone(voiceHint)
    voiceHint.textContent = 'reading the voice list...'
    const d = await responseJson(await fetch('/api/voices?provider=' + encodeURIComponent(which))).catch(() => ({ from: 'none', voices: [] }))
    for (const v of d.voices) voice.append(new Option(v.label, v.id))
    // An empty select reads as a broken control; say the state where the eye is.
    if (!d.voices.length) voice.append(new Option('no voices yet — see below', ''))
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
    fix.go.hidden = true
    fix.said.textContent = ''
    if (d.fetchable) {
      const go = fix.go
      go.hidden = false
      if (!go.childElementCount) go.append(icon('download-01'), control('span', { textContent: 'Download it now' }))
      const said = fix.said
      go.onclick = async () => {
        go.disabled = true
        tone(said)
        said.textContent = 'downloading — this happens once, and takes about as long as an npm install'
        const r = await fetch('/api/voices/fetch', { method: 'POST' })
          .then(responseJson)
          .catch(() => ({ ok: false, error: 'the Studio did not answer — is it still running on this port?' }))
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
    }
  }
  prov.onchange = loadVoices
  loadVoices()
  const gap = mk('Gap between lines', control('number', { value: DEFAULT_GAP_MS, min: 0, max: 1500, step: 20 }))

  const { preview, est, saved } = ui
  /*
   * The script is the source; the editor is what gets spoken.
   *
   * Both exist at once, and until now a saved edit hid the script permanently —
   * rewrite the script and Voice kept reading the old narration back, with
   * nothing on the page saying the two had diverged or any way to take the new
   * one. The edit still wins, because it is the more deliberate of the two, but
   * the divergence is stated and reversible.
   */
  const fromScript = ui.fromScript
  let saveTimer = null
  let loadRequest = 0
  let draftRequest = 0
  /* Which script's lines are in the editor right now. An edit belongs to the
     script it was typed against, not to whichever one is selected by the time
     the save runs. */
  let showing = ''
  /* The current script's own lines, kept so the editor can be put back to them. */
  let scriptLines = []
  const linesFromEditor = () => preview.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const updateEstimate = () => {
    const lines = linesFromEditor()
    est.textContent = lines.length ? lines.length + ' lines · roughly ' + Math.round(SP.estimateSeconds(lines, Number(gap.value || DEFAULT_GAP_MS))) + 's' : ''
  }
  const saveNarrationDraft = async ({ script = pick.value, lines = linesFromEditor() } = {}) => {
    if (!proj.value || !script || !lines.length) return false
    const request = ++draftRequest
    saved.textContent = 'Saving narration edits…'
    const result = await fetch('/api/voice/draft', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: proj.value, script, lines }),
    }).then(responseJson).catch((error) => ({ error: error.message }))
    if (request !== draftRequest) return false
    if (result.error) {
      tone(saved, 'bad')
      saved.textContent = result.error
      return false
    }
    tone(saved)
    saved.textContent = 'Narration edits saved.'
    return true
  }
  /*
   * Write out a pending edit before anything replaces the editor.
   *
   * Edits autosave 550ms after the last keystroke, and choosing another script
   * used to cancel that timer and reload — so the last thing typed lost to the
   * script that came in over it. The save is flushed against the script it was
   * typed against, and only then does the new one load.
   */
  const flushNarrationDraft = async () => {
    if (!saveTimer) return
    clearTimeout(saveTimer)
    saveTimer = null
    if (showing) await saveNarrationDraft({ script: showing, lines: linesFromEditor() })
  }

  const fill = () => {
    pick.replaceChildren()
    const mine = S.scripts.filter((x) => x.project === proj.value)
    if (!mine.length) {
      pick.append(new Option('— no scripts in this project —', ''))
    }
    for (const sc of mine) pick.append(new Option(sc.name, sc.name))
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
    void show()
  }
  const show = async () => {
    const sc = S.scripts.find((x) => x.project === proj.value && x.name === pick.value)
    const original = sc ? SP.parseScript(sc.body) : []
    const current = ++loadRequest
    preview.disabled = !sc
    preview.value = sc ? 'Loading narration…' : ''
    saved.textContent = ''
    showing = ''
    if (!sc) {
      updateEstimate()
      return
    }
    const draft = await fetch(`/api/voice/draft?project=${encodeURIComponent(proj.value)}&script=${encodeURIComponent(sc.name)}`)
      .then(responseJson)
      .catch(() => ({ lines: null }))
    if (current !== loadRequest) return
    const edited = Array.isArray(draft.lines) && draft.lines.length ? draft.lines : null
    const lines = edited ?? original
    preview.value = lines.join('\n')
    preview.disabled = false
    showing = sc.name
    scriptLines = original
    const diverged = Boolean(edited) && edited.join('\n') !== original.join('\n')
    fromScript.hidden = !diverged
    saved.textContent = !edited
      ? 'Edit these lines before building the narration.'
      : diverged
        ? `Your edit is what gets spoken — ${edited.length} ${edited.length === 1 ? 'line' : 'lines'}, where the script has ${original.length}.`
        : 'Editing saved narration copy.'
    updateEstimate()
  }
  // No change handler: switching project reloads state and re-renders this panel.
  pick.onchange = async () => {
    await flushNarrationDraft()
    void show()
  }
  gap.oninput = updateEstimate
  preview.oninput = () => {
    updateEstimate()
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      void saveNarrationDraft({ script: showing || pick.value })
    }, 550)
  }
  /* Leaving the page is the other way an unsaved edit was lost. */
  window.addEventListener('rm:before-navigate', () => void flushNarrationDraft(), { once: true })

  const out = ui.out
  const go = ui.go
  fromScript.onclick = async () => {
    if (!scriptLines.length) return
    preview.value = scriptLines.join('\n')
    updateEstimate()
    clearTimeout(saveTimer)
    saveTimer = null
    await saveNarrationDraft({ script: showing || pick.value, lines: scriptLines })
    fromScript.hidden = true
  }
  go.onclick = async () => {
    clearTimeout(saveTimer)
    saveTimer = null
    out.replaceChildren()
    // Capture the form once. The job must build exactly what was visible when
    // Build was pressed, even if a later autosave or script reload happens.
    const draft = {
      script: pick.value,
      lines: linesFromEditor(),
      provider: prov.value,
      voice: voice.value,
      gap: Number(gap.value),
    }
    if (!draft.script || !draft.lines.length) {
      out.append(control('hint', { className: 'voice__status bad', textContent: 'Add narration lines before building.' }))
      return
    }
    if (!(await saveNarrationDraft(draft))) return
    const r = await fetch('/api/voice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: proj.value, ...draft }),
    }).then(responseJson)
    if (r.error) {
      out.append(control('hint', { className: 'voice__status bad', textContent: r.error }))
      return
    }
    const status = control('hint', { className: 'voice__status' })
    out.append(status)
    runWithStatus(r.step, go, status, (job) => {
      if (job?.code !== 0) return
      out.append(control('hint', { className: 'voice__output', textContent: 'Narration audio: ' + r.out }))
      out.append(control('hint', { className: 'voice__output', textContent: 'Captions: ' + r.srt }))
    })
  }
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
  const named = (list) => list.map((x) => ({ v: x.v, hint: x.hint, insert: x.insert }))
  switch (key) {
    case 'script': {
      const scripts = (S.scripts || []).filter((script) => script.project === project || !script.project)
      return named(
        scripts.map((script) => ({
          v: script.name,
          hint: script.project === project ? 'insert this project script' : 'insert shared script',
          // `/script` is a picker, not another directive stored in the document.
          // The resulting script remains plain text that every existing tool can read.
          insert: script.body,
        })),
      )
    }
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
    case 'voice-provider':
      return named([
        { v: 'kokoro', hint: 'local voices on this machine' },
        { v: 'elevenlabs', hint: 'your connected ElevenLabs voices' },
      ])
    case 'voice':
      // `none` remains an explicit choice. Every actual voice brings its provider
      // with it, so choosing a personal ElevenLabs voice also writes the setting
      // that makes the render use ElevenLabs rather than the local default.
      return named([
        { v: 'none', hint: 'no voiceover' },
        ...(slashVoices || []).map((voice) => ({
          // Pick by the name a person recognises, not the opaque provider id.
          // The id still goes into the document through `insert`.
          v: voice.label,
          hint: voice.provider === 'elevenlabs' ? 'ElevenLabs voice' : 'Kokoro voice — local',
          insert: `/voice-provider ${voice.provider}\n/voice ${voice.id}`,
        })),
      ])
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
  const wrap = control('div', { className: 'hl-wrap' })
  const layer = control('pre', { className: 'hl-layer' })
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
  const mirror = control('div')
  // Off-screen rather than hidden: `display: none` has no layout, and layout is
  // the entire point.
  mirror.style.cssText = 'position:absolute;visibility:hidden;white-space:pre-wrap;overflow-wrap:break-word;inset-block-start:0;inset-inline-start:-9999px'
  // Everything that can move a glyph. Missing one shows up as a menu that is
  // subtly wrong on long lines and right on short ones, which is worse than
  // being plainly wrong.
  for (const prop of ['boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'textTransform', 'textIndent', 'tabSize', 'wordSpacing']) {
    mirror.style[prop] = cs[prop]
  }
  const at = ta.selectionStart ?? ta.value.length
  mirror.textContent = ta.value.slice(0, at)
  // A zero-width space, so an empty line still has a box to measure and the
  // marker never changes how the text before it wraps.
  const mark = control('span')
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
  const menu = control('div', { className: 'slash-menu' })
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
  const holder = control('div', { className: 'slash-holder' })
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
    menu.replaceChildren()
    items.forEach((it, i) => {
      const { root: row, el: slashEl } = mountRow('slash-item')
      row.style.cssText = 'display:flex;gap:var(--op-space-small);align-items:baseline;padding:var(--op-space-2x-small) var(--op-space-small);cursor:pointer;' + (i === cursor ? 'background:var(--op-color-academy-primary-plus-six)' : '')
      slashEl.label.textContent = it.label
      slashEl.hint.textContent = it.hint || ''
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
      const savedScripts = slashValues('script', getProject()) || []
      if ('script'.startsWith(frag) && savedScripts.length) {
        items.push({ label: '/script', hint: 'insert a saved script', insert: '/script ' })
      }
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
        .map((x) => ({ label: x.v, hint: x.hint, insert: x.insert ?? `/${key} ${x.v}` }))
      cursor = 0
      if (key === 'voice' && !slashVoices) {
        // Lazily load both providers. The old picker asked Kokoro alone, which
        // made a connected ElevenLabs account invisible precisely where someone
        // writes the script's voice setting.
        slashVoices = []
        Promise.all(
          ['elevenlabs', 'kokoro'].map(async (provider) => {
            const result = await fetch('/api/voices?provider=' + provider)
              .then(responseJson)
              .catch(() => ({ voices: [] }))
            return (result.voices || []).map((voice) => ({ ...voice, provider }))
          }),
        )
          .then((lists) => {
            slashVoices = lists.flat()
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
  const { shelf, name, seconds, about, body, count, draftOut, saved, status, draft, save, build } = ui
  statusSink(status)
  let scriptDraftTimer = null
  let changedSinceOpen = false
  let restoringDraft = false

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

  const scriptDraftPayload = () => ({
    projectId: currentProject(),
    name: name.value,
    about: about.value,
    body: body.value,
    seconds: Number(seconds.value),
    shelf: shelf.value,
  })

  /*
   * Saving the work-in-progress is intentionally separate from “Save script”.
   * The latter creates the named markdown deliverable; this one makes typing
   * safe before there is a name. One request after a quiet moment, never one
   * per keystroke, and it lands outside the changing browser origin.
   */
  const persistScriptDraft = async (snapshot = scriptDraftPayload(), { quiet = false, keepalive = false } = {}) => {
    if (!snapshot.projectId) return false
    if (!quiet) says(status, 'Saving draft…')
    const response = await fetch('/api/script/draft-state', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(snapshot),
      keepalive,
    }).catch((err) => ({ error: err.message }))
    const result = response.error ? response : await responseJson(response)
    if (result.error) {
      if (!quiet) {
        tone(status, 'bad')
        status.hidden = false
        status.textContent = `Draft could not be saved: ${result.error}`
      }
      return false
    }
    if (!quiet) {
      tone(status, 'ok')
      status.hidden = false
      status.textContent = 'Draft saved locally.'
    }
    return true
  }

  const queueScriptDraft = () => {
    if (restoringDraft || !currentProject()) return
    changedSinceOpen = true
    clearTimeout(scriptDraftTimer)
    const snapshot = scriptDraftPayload()
    scriptDraftTimer = setTimeout(() => {
      void persistScriptDraft(snapshot)
    }, 700)
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
    const visible = (S.scripts || []).filter((script) => (project.value ? script.project === project.value : !script.project))
    if (!visible.length) {
      saved.append(control('hint', { textContent: project.value ? 'No scripts in this project yet. Draft one, or write it and press Save.' : 'Nothing on the shared shelf yet.' }))
      return
    }
    for (const sc of visible) {
      const { root: card, el: row } = mountRow('script-saved')
      row.name.textContent = sc.name
      row.snippet.textContent = sc.body.slice(0, SNIPPET_CHARS) + (sc.body.length > SNIPPET_CHARS ? '…' : '')
      /*
       * A drafted script carries its brief, so "same idea, one change" is possible.
       *
       * The brief used to be assembled and thrown away, which made a redo a matter
       * of retyping it from memory. Loading the card puts the brief back in the
       * form too, editable — a redo that could not change anything would just be a
       * re-run.
       */
      if (sc.brief) {
        row.brief.hidden = false
        row.brief.textContent = `brief · ${sc.brief.seconds}s · ${new Date(sc.brief.drafted).toLocaleDateString()}`
      }
      card.onclick = () => load_(sc)
      saved.append(card)
    }
  }
  shelf.onchange = () => {
    paintSaved()
    queueScriptDraft()
  }
  paintSaved()

  /*
   * A script the project page asked for, opened on arrival.
   *
   * Read and cleared in one go, like every other handover here: coming back to
   * Scripts later should show the shelf, not silently reopen whatever was last
   * clicked from somewhere else.
   */
  let restoredSavedScript = false
  if (pendingScript) {
    const want = pendingScript
    pendingScript = null
    const sc = S.scripts.find((x) => x.name === want && x.project === (currentProject() ?? null))
    // A script that is no longer there leaves you on the shelf rather than on a
    // form claiming to hold something that does not exist.
    if (sc) {
      load_(sc)
      restoredSavedScript = true
    }
  }
  if (!restoredSavedScript && currentProject()) {
    /*
     * Do not overwrite a person who gets a keystroke in before this request
     * returns. Fast typing on a slow disk is exactly when restoration needs to
     * be least surprising.
     */
    void fetch('/api/script/draft-state?project=' + encodeURIComponent(currentProject()))
      .then(responseJson)
      .then((result) => {
        if (changedSinceOpen || !result.draft) return
        const savedDraft = result.draft
        restoringDraft = true
        shelf.value = savedDraft.shelf === 'shared' ? 'shared' : 'project'
        name.value = savedDraft.name
        about.value = savedDraft.about
        body.value = savedDraft.body
        seconds.value = savedDraft.seconds
        about.dispatchEvent(new Event('input', { bubbles: true }))
        body.dispatchEvent(new Event('input', { bubbles: true }))
        restoringDraft = false
        recount()
        paintSaved()
        tone(status, 'ok')
        status.hidden = false
        status.textContent = 'Restored your in-progress script.'
      })
      .catch(() => {})
  }

  for (const control of [name, seconds, about, body]) control.addEventListener('input', queueScriptDraft)

  const flushScriptDraft = () => {
    if (restoringDraft || !changedSinceOpen || !currentProject()) return
    clearTimeout(scriptDraftTimer)
    // This runs while the form is still alive. `keepalive` lets a real page close
    // finish the tiny JSON request instead of dropping the last sentence typed.
    void persistScriptDraft(scriptDraftPayload(), { quiet: true, keepalive: true })
  }
  const leaveScripts = () => {
    flushScriptDraft()
    window.removeEventListener('rm:before-navigate', leaveScripts)
    window.removeEventListener('pagehide', flushScriptDraft)
  }
  window.addEventListener('rm:before-navigate', leaveScripts)
  window.addEventListener('pagehide', flushScriptDraft, { once: true })

  draft.onclick = async () => {
    if (!about.value.trim()) {
      tone(status, 'bad')
      status.hidden = false
      status.textContent = 'Say what the video is for first — that is the brief.'
      return
    }
    draft.disabled = true
    says(status, 'asking Claude…')
    const response = await fetch('/api/script/draft', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: project.value,
        name: name.value,
        seconds: Number(seconds.value),
        about: about.value,
      }),
    }).catch((err) => ({ error: err.message }))
    const r = response.error ? response : await responseJson(response)
    draft.disabled = false
    draftOut.innerHTML = ''
    if (r.error) {
      tone(status, 'bad')
      status.hidden = false
      status.textContent = r.error
      return
    }
    says(status, 'Run it below. When it finishes, reload and it is on the shelf and in Voice.')
    draftOut.append(control('path', { textContent: 'writes  ' + r.dest }))
    draftOut.append(runRow(r.step, 'Write the draft'))
  }

  const saveScript = async () => {
    if (!name.value.trim()) {
      tone(status, 'bad')
      status.hidden = false
      status.textContent = 'Give it a name first.'
      return false
    }
    save.disabled = true
    says(status, 'saving…')
    const response = await fetch('/api/script', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: name.value, body: body.value, projectId: project.value || null }),
    }).catch(() => ({ error: 'could not reach the Studio' }))
    const r = response.error ? response : await responseJson(response)
    save.disabled = false
    if (r?.error) {
      tone(status, 'bad')
      status.hidden = false
      status.textContent = r.error
      return false
    }
    // Saving is not a navigation. Reloading the app here rebuilt this form blank,
    // so the script had been written to disk but vanished from the textarea.
    // Make the just-saved document the recovery state, then only refresh the
    // in-memory catalogue that feeds the shelf beside it.
    changedSinceOpen = true
    clearTimeout(scriptDraftTimer)
    await persistScriptDraft(scriptDraftPayload(), { quiet: true })
    const fresh = await fetch('/api/state')
      .then(responseJson)
      .catch(() => null)
    if (fresh && !fresh.error) S = fresh
    paintSaved()
    tone(status, 'ok')
    status.hidden = false
    status.textContent = 'Saved' + (r?.dest ? ' to ' + r.dest : '')
    return true
  }

  save.onclick = () => {
    void saveScript()
  }

  build.onclick = async () => {
    if (!project.value) {
      tone(status, 'bad')
      status.hidden = false
      status.textContent = 'Open a project before building a video from this script.'
      return
    }
    if (!body.value.trim()) {
      tone(status, 'bad')
      status.hidden = false
      status.textContent = 'Write or draft the script before building the video.'
      return
    }
    build.disabled = true
    const didSave = await saveScript()
    build.disabled = false
    if (!didSave) return

    // Make reads a named project script so that reloading the page never loses
    // the exact words that were just approved here.
    pendingScript = name.value.trim()
    createTab = 'make'
    go('create')
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
  const probe = control('span')
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

/**
 * One row of a repeating list, cloned from `<template data-row="…">`.
 *
 * A panel template is static HTML, and a list of cards cannot be — so this is
 * the other half of the same idea: the row's structure lives in the markup and
 * JS clones it and fills text. Returns the row's root and its `data-el` handles,
 * the way mountPanel does for a panel.
 */
function mountRow(name) {
  const tpl = document.querySelector(`template[data-row="${name}"]`)
  if (!tpl) throw new Error(`no row template "${name}"`)
  const frag = tpl.content.cloneNode(true)
  const root = frag.firstElementChild
  // A row can be siblings rather than one element — a label beside its input
  // inside a .ctl grid — so every top-level node is handed back too.
  const nodes = [...frag.children]
  const el_ = {}
  for (const node of frag.querySelectorAll('[data-el]')) el_[node.dataset.el] = node
  return { root, nodes, el: el_ }
}

/** A bare control, cloned from its template so no element is born in JS. */
function control(kind, props = {}) {
  return Object.assign(mountRow(`control-${kind}`).root, props)
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
  const { root: wrap, el: parts } = mountRow('colormenu')

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
  const STEPS = ['minus-max', 'minus-eight', 'minus-seven', 'minus-six', 'minus-five', 'minus-four', 'minus-three', 'minus-two', 'minus-one', 'original', 'plus-one', 'plus-two', 'plus-three', 'plus-four', 'plus-five', 'plus-six', 'plus-seven', 'plus-eight', 'plus-max']

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

  const { trigger, chip, label, panel } = parts

  let current = value ?? ''

  const drawTrigger = () => {
    const hit = familyOf(current)
    chip.style.background = current || 'transparent'
    chip.classList.toggle('colormenu__chip--none', !current)
    // The step is named only when it is not the seed: "Academy dark" reads better
    // than "Academy dark original" for the colour people mean by default.
    label.textContent = hit ? colorLabel(hit.family) + (hit.step === 'original' ? '' : ' ' + hit.step.replace(/-/g, ' ')) : current ? current : noneLabel || 'Choose a colour'
  }

  const close = () => {
    if (panel.matches(':popover-open')) panel.hidePopover()
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
      const b = mountRow('colormenu-swatch-none').root
      b.title = noneLabel
      b.setAttribute('aria-selected', String(!current))
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
      const { root: row, el: rowBits } = mountRow('colormenu-row')
      rowBits.family.textContent = colorLabel(family)
      const ramp = rowBits.ramp
      if (!live.length) {
        const b = mountRow('colormenu-swatch-dead').root
        b.title = `${colorLabel(family)} — not resolving`
        ramp.append(b)
      }
      for (const step of live) {
        const b = mountRow('colormenu-swatch').root
        b.setAttribute('aria-selected', String(hit?.family === family && hit?.step === step))
        b.style.background = tokenFor(family, step)
        b.title = `${colorLabel(family)} ${step.replace(/-/g, ' ')}`
        b.onclick = () => choose(valueFor(family, step))
        ramp.append(b)
      }
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

  /* The popover's own state is the only state. A `hidden` attribute alongside it
     is a second answer to "is this open", and the two drift. */
  const isOpen = () => panel.matches(':popover-open')

  trigger.onclick = () => {
    const open = !isOpen()
    if (open) panel.showPopover()
    else panel.hidePopover()
    trigger.setAttribute('aria-expanded', String(open))
    // Placed after it is shown: a panel that is display:none has no size, and
    // place() measures before it decides which way to flip.
    if (open) place()
  }

  // Re-placed rather than left behind: the rail scrolls under it, and a popover
  // still pointing at where its trigger used to be is worse than a clipped one.
  for (const [target, ev] of [
    [window, 'resize'],
    [window, 'scroll'],
  ]) {
    target.addEventListener(
      ev,
      () => {
        if (isOpen()) place()
      },
      true,
    )
  }
  // Escape closes, and a click anywhere else does too — a popover that can only be
  // dismissed by picking something is a trap.
  wrap.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) {
      e.stopPropagation()
      close()
      trigger.focus()
    }
  })
  document.addEventListener('pointerdown', (e) => {
    /* The panel is in the top layer, so it is NOT inside `wrap` as far as a
       click is concerned — testing only the wrapper closed the menu on the way
       to picking a colour. */
    if (isOpen() && !wrap.contains(e.target) && !panel.contains(e.target)) close()
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
  /* The eight motion studies the gradient family came from. */
  mode: ['current', 'bloom', 'softCut', 'cutCurveA', 'cutCurveB', 'wipe', 'claude', 'proof'],
  side: ['left', 'right'],
  dark: ['', 'true'],
  overlay: ['on', 'off'],
  mark: ['off', 'on'],
  'show-duotone': ['off', 'on'],
  theme: ['dark', 'light'],
  motion: ['still', 'drift'],
  flow: ['still', 'flow'],
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
  'rm-pixel-reveal': new Set(['image']),
  'rm-haze': new Set(['image']),
}

/* Brand scene assets take colours from the project palette, unless overridden. */
const STUDY_COLORS = new Set(['ground', 'paper', 'green', 'cyan', 'amber'])
const COLOR_FIELDS = {
  'rm-shader': new Set(['ink', 'paper']),
  'rm-pixel-reveal': new Set(['border-color', 'color-a', 'color-b', 'paper', 'cyan-ink', 'magenta-ink', 'yellow-ink', 'black-ink']),
  'rm-study-field': STUDY_COLORS,
  'rm-haze': new Set(['gradient-shadow', 'gradient-highlight', 'dither-color']),
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
  'pixel-density': { min: 3, max: 64, step: 1, suffix: ' px', fallback: 20 },
  'pixel-gap': { min: 0, max: 0.9, step: 0.05, suffix: '', fallback: 0.12 },
  'pixel-roundness': { min: 0, max: 1, step: 0.05, suffix: '', fallback: 0.7 },
  'halftone-frequency': { min: 0, max: 3, step: 0.05, suffix: '', fallback: 0.75 },
  'border-radius': { min: 0, max: 12, step: 0.25, suffix: ' cqw', fallback: 0 },
  'color-fringing': { min: 0, max: 3, step: 0.1, suffix: ' px', fallback: 0.6 },
  'flow-intensity': { min: 0, max: 3.5, step: 0.1, suffix: '', fallback: 1.5 },
  bloom: { min: 0, max: 1, step: 0.02, suffix: '', fallback: 0.36 },
  phase: { min: 0, max: 6, step: 0.05, suffix: '', fallback: 1.4 },
  grain: { min: 0.5, max: 3, step: 0.1, suffix: '\u00d7', fallback: 1 },
  size: { min: 2, max: 14, step: 0.2, suffix: ' cqw', fallback: 6.6 },
  /* The haze, at the ranges its shader clamps to. */
  'flow-speed': { min: 0, max: 5, step: 0.1, suffix: '', fallback: 0.6 },
  'swirl-detail': { min: 0, max: 5, step: 0.1, suffix: '', fallback: 0.7 },
  'color-balance': { min: 0, max: 100, step: 1, suffix: '%', fallback: 58 },
  'dither-amount': { min: 0, max: 1, step: 0.01, suffix: '', fallback: 0.45 },
  'dither-pixel': { min: 1, max: 32, step: 1, suffix: ' px', fallback: 4 },
  'distortion-strength': { min: 0, max: 5, step: 0.1, suffix: '', fallback: 5 },
  'distortion-detail': { min: 8, max: 128, step: 1, suffix: '', fallback: 75 },
  sharpness: { min: 0, max: 3, step: 0.1, suffix: '', fallback: 1 },
  'film-grain': { min: 0, max: 1, step: 0.025, suffix: '', fallback: 0.05 },
  'image-blend': { min: 0, max: 1, step: 0.05, suffix: '', fallback: 0.75 },
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
  'rm-study-field': {
    mode: 'current',
    phase: '1.4',
    bloom: '0.36',
    eyebrow: 'CCC Days',
    title: 'AI Video Presentation Builder.',
    size: '6.6',
    x: '50',
    y: '50',
    align: 'center',
  },
  'rm-haze': {
    image: 'academy-browser.png',
    'image-blend': '0.75',
    eyebrow: 'CCC Days',
    title: 'AI Video Presentation Builder.',
    size: '6.6',
    x: '50',
    y: '50',
    align: 'center',
    'flow-speed': '0.6',
    'swirl-detail': '0.7',
    'color-balance': '58',
    'dither-amount': '0.45',
    'distortion-strength': '2',
    'distortion-detail': '40',
    sharpness: '0',
    'film-grain': '0.05',
    flow: 'flow',
  },
  'rm-pixel-reveal': {
    image: 'academy-browser.png',
    'pixel-density': '20',
    'pixel-gap': '0.12',
    'pixel-roundness': '0.7',
    'halftone-frequency': '0.75',
    'border-radius': '0',
    'show-duotone': 'off',
    'color-fringing': '0.6',
    'flow-intensity': '1.5',
    flow: 'still',
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
  const ui = mountPanel('scene-gallery', m)
  const { grid } = ui
  ui.lede.textContent = `The scenes in ${project?.name ?? 'this project'} — title cards, lower thirds, stats, browser frames. A scene is a picture, so this shows you the pictures.`
  ui.add.prepend(icon('add-01'))
  ui.add.onclick = () => {
    openScene = ''
    render()
  }

  const proj = currentProject() ?? ''
  ;(async () => {
    const r = await fetch('/api/scenes?project=' + encodeURIComponent(proj))
      .then((x) => x.json())
      .catch(() => ({ scenes: [] }))
    const scenes = r.scenes ?? []
    ui.empty.hidden = scenes.length > 0
    if (!scenes.length) return
    for (const sc of scenes) {
      const { root: c, el: card } = mountRow('scene-card')
      const { shot, frame } = card
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
        body: JSON.stringify({
          body: sc.body,
          name: sc.name,
          /* The ground it was designed on, not the default — a card that draws
             the scene on a wallpaper it was never composed against is showing
             something nobody made. */
          ...(sc.ground?.wallpaper ? { wallpaper: sc.ground.wallpaper } : {}),
          ...(sc.ground?.brand ? { brand: sc.ground.brand } : {}),
          ...(sc.footage?.rel
            ? {
                footage: {
                  src: `/media/${encodeURIComponent(proj)}/${encodeURI(sc.footage.rel)}`,
                  /* A frame from inside the passage, so a card shows the shot
                     immediately rather than waiting on a take the browser has
                     decided not to load yet. */
                  poster: `/api/hyperframes/framing/frame?project=${encodeURIComponent(proj)}&src=${encodeURIComponent(sc.footage.rel)}&at=${(Number(sc.footage.inSec) || 0).toFixed(2)}`,
                  inSec: sc.footage.inSec,
                  outSec: sc.footage.outSec,
                },
              }
            : {}),
        }),
      })
        .then((x) => x.json())
        .catch(() => null)
      if (preview?.url) {
        frame.hidden = false
        frame.title = sc.name
        frame.src = preview.url
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
        /*
         * Scaled on every resize, not once on load.
         *
         * `onload` fires while the gallery grid is still settling, so the width
         * measured there was the card's first guess and not its last — the frame
         * was scaled to something narrower than the card and left a strip of
         * dead ground down the right of every scene. One measurement cannot be
         * right for a element whose width is decided by a grid that reflows.
         */
        const fit = () => {
          const w = shot.clientWidth
          if (w > 0) frame.style.transform = `scale(${w / 1920})`
        }
        const watch = new ResizeObserver(fit)
        watch.observe(shot)
        frame.onload = async () => {
          fit()
          try {
            const rm = frame.contentWindow?.RM
            await rm?.ready?.()
            rm?.seek?.(Math.round((rm?.duration?.() || 4000) / 2))
          } catch {
            /* torn down while loading; the card just stays as it is */
          }
        }
      }
      card.name.replaceWith(nameWithKind(sc.name, 'scene'))
      card.path.textContent = `scenes/${sc.name}.html`
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
              const d = await responseJson(await fetch('/api/delete', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ path: sc.file }),
                }))
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

  const boardScene = openBoardScene && typeof openBoardScene === 'object' ? openBoardScene : null
  const backToCanvas = () => {
    const selected = boardScene?.id ?? null
    openBoardScene = null
    openScene = null
    selectedBoardNode = selected
    go('storyboard')
  }

  crumbs(
    scopedCrumbs(
      boardScene
        ? [{ label: 'Video', go: () => go('workflow') }, { label: 'Canvas', go: backToCanvas }, { label: boardScene.name || 'Scene' }]
        : [
            {
              label: 'Scenes',
              go: () => {
                openScene = null
                render()
              },
            },
            { label: openScene || 'New scene' },
          ],
    ),
  )

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
  const { frame, scrub, palette, cards, rawText, pick, save, draft, restore, footageGroup, footage, attachFootage, transcribeFootage, suggestFootage, addFootage, footagePicker, footageHint, footageReview, footagePlayer, footageReviewStatus, footageTranscript } = ui
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

  /* Canvas is the brief; the scene is the visual answer to it. The fields stay
     editable, but a person should never have to restate the node they clicked. */
  if (boardScene) {
    name.value = boardScene.name || ''
    about.value = boardScene.intent || ''
  }

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

  /* A Canvas scene needs both its visual treatment and the recording that
     fulfils it. Keep that choice beside the treatment, not on a separate page. */
  let footageBoard = null
  let previewFootage = null
  // Board state is the first choice while a scene is opened from Canvas, but the
  // saved scene also owns its chosen range. That makes a gallery-opened scene
  // show the same clip instead of a bare title treatment.
  let savedSceneFootage = null
  // Loading the Canvas choice and loading the saved scene are independent
  // requests. Keep the former promise so the first stage preview cannot win
  // the race with an earlier, empty preview request.
  let boardFootageReady = Promise.resolve()
  const videoFiles = () => (currentProjectRecord()?.catalog?.files ?? []).filter((file) => file.kind === 'video')
  const footageSource = (rel) => `/media/${encodeURIComponent(proj.value)}/${encodeURI(rel)}`
  const asPreviewFootage = (take) =>
    take?.rel
      ? {
          rel: take.rel,
          inSec: Math.max(0, Number(take.inSec) || 0),
          outSec: Math.max(0, Number(take.outSec) || 0),
          ...(take.takeId || take.id ? { takeId: take.takeId || take.id } : {}),
        }
      : null
  const sceneFootage = () =>
    previewFootage?.rel && Number(previewFootage.outSec) > Number(previewFootage.inSec)
      ? {
          rel: previewFootage.rel,
          inSec: Number(previewFootage.inSec),
          outSec: Number(previewFootage.outSec),
          ...(previewFootage.takeId || boardScene?.takeId ? { takeId: previewFootage.takeId || boardScene?.takeId } : {}),
        }
      : null
  const setFootageHint = (message, level = '') => {
    footageHint.textContent = message
    footageHint.className = `form-hint${level ? ` ${level}` : ''}`
  }
  const fillFootage = (selected = '') => {
    footage.replaceChildren(new Option('Choose project footage…', ''))
    for (const file of videoFiles()) footage.append(new Option(`${file.name} · ${clock(file.media?.durationSec ?? 0)}`, file.rel))
    footage.value = selected || footage.value
    attachFootage.disabled = !footage.value
    transcribeFootage.disabled = !footage.value
    suggestFootage.disabled = !footage.value
  }
  const refreshFootage = async (selected = '') => {
    if (!boardScene) return
    const response = await fetch(`/api/board?project=${encodeURIComponent(proj.value)}`).catch((error) => ({ error: error.message }))
    const result = response.error ? response : await responseJson(response)
    if (result.error) return setFootageHint(result.error, 'bad')
    footageBoard = result.board
    const takes = (footageBoard?.takes ?? []).filter((take) => take.slotId === boardScene.id)
    // The board pick is authoritative. `takeId` is carried from the Canvas click
    // as a stable fallback while the board is refreshing; an unchosen newest take
    // must never replace an edited source range in the visual editor.
    const chosenId = footageBoard?.picks?.[boardScene.id] ?? boardScene.takeId ?? null
    const chosen = chosenId
      ? takes.find((take) => take.id === chosenId) ?? null
      : takes.at(-1) ?? null
    const count = takes.length
    // Reopening a Canvas scene should reopen the source it already carries.
    // Asking somebody to choose it again is how review got detached from the
    // scene in the first place.
    const selectedRel = selected || chosen?.rel || savedSceneFootage?.rel || ''
    fillFootage(selectedRel)
    previewFootage = chosen?.rel === selectedRel
      ? asPreviewFootage(chosen)
      : savedSceneFootage?.rel === selectedRel
        ? savedSceneFootage
        : null
    boardScene.takeId = chosen?.id ?? savedSceneFootage?.takeId ?? null
    const currentPassage = previewFootage && previewFootage.outSec > previewFootage.inSec
      ? ` Current passage: ${clock(previewFootage.inSec)}–${clock(previewFootage.outSec)}.`
      : ''
    setFootageHint(count ? `${count} video${count === 1 ? '' : 's'} attached to this shot.${currentPassage}` : 'Choose an existing recording or add one to this project.')
    // The scene's initial preview waits for this load below. Calling preview
    // here creates a race with the scene body's own initial preview, which can
    // leave the stage on a default frame after the Canvas pick has arrived.
  }

  if (footageGroup) {
    footageGroup.hidden = !boardScene
    let footageState = null
    let suggestedPassages = []
    let selectedWordIndexes = new Set()
    let selectionAnchorWord = null
    let reviewedFootageRangeKey = ''
    const footageTime = (seconds) => {
      const total = Math.max(0, Math.floor(Number(seconds) || 0))
      return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
    }
    const footageRequest = async (path, body = {}) => {
      const response = await fetch(`/api/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: proj.value, slotId: boardScene?.id, rel: footage.value, ...body }),
      }).catch((error) => ({ error: error.message }))
      return response.error ? response : responseJson(response)
    }
    const transcriptWords = () => footageState?.transcript?.words ?? []
    const selectPreviewWords = () => {
      const selectedRange = previewFootage?.rel === footage.value
        && Number(previewFootage.outSec) > Number(previewFootage.inSec)
        ? previewFootage
        : null
      if (!selectedRange) return false
      const selected = transcriptWords()
        .map((word, index) => ({ word, index }))
        .filter(({ word }) => Number(word.endSec ?? word.startSec) >= Number(selectedRange.inSec)
          && Number(word.startSec) <= Number(selectedRange.outSec))
        .map(({ index }) => index)
      selectedWordIndexes = new Set(selected)
      selectionAnchorWord = selected.at(-1) ?? null
      return selected.length > 0
    }
    const wordIndexesForCue = (cue) => {
      const words = transcriptWords()
      const byId = new Map(words.map((word, index) => [word.id, index]))
      const first = byId.get(cue.from)
      const last = byId.get(cue.to)
      if (first != null && last != null) return Array.from({ length: last - first + 1 }, (_, index) => first + index)
      // Older caption imports may not carry word ids on their cues. Their word
      // timings still make a precise cut possible, so use the timed overlap.
      return words
        .map((word, index) => ({ word, index }))
        .filter(({ word }) => Number(word.endSec ?? word.startSec) >= Number(cue.startSec ?? 0) && Number(word.startSec ?? 0) <= Number(cue.endSec ?? cue.startSec ?? 0))
        .map(({ index }) => index)
    }
    const selectedPassages = () => {
      const words = transcriptWords()
      const selected = [...selectedWordIndexes].sort((a, b) => a - b)
      const passages = []
      for (const index of selected) {
        const previous = passages.at(-1)
        if (previous && index === previous.last + 1) previous.last = index
        else passages.push({ first: index, last: index })
      }
      return passages
        .filter(({ first, last }) => words[first] && words[last])
        .map(({ first, last }) => ({
          first,
          last,
          inSec: Number(words[first].startSec) || 0,
          outSec: Number(words[last].endSec ?? words[last].startSec) || 0,
          text: words.slice(first, last + 1).map((word) => word.text).join(' '),
        }))
    }
    const usePassage = async (passage) => {
      if (!boardScene?.id || !footage.value || !passage) return
      setFootageHint('Saving this passage to the Canvas scene…')
      const file = videoFiles().find((item) => item.rel === footage.value)
      const saved = await footageRequest('board/take', { inSec: passage.inSec, outSec: passage.outSec, durationSec: file?.media?.durationSec ?? null })
      if (saved.error) return setFootageHint(saved.error, 'bad')
      const chosen = await footageRequest('board/pick', { takeId: saved.takeId })
      if (chosen.error) return setFootageHint(`Passage saved, but Studio could not choose it: ${chosen.error}`, 'warn')
      footageBoard = chosen.board
      previewFootage = asPreviewFootage({ id: saved.takeId, rel: footage.value, inSec: passage.inSec, outSec: passage.outSec })
      savedSceneFootage = previewFootage
      boardScene.takeId = saved.takeId
      selectPreviewWords()
      setFootageHint(`Saved ${footageTime(passage.inSec)}–${footageTime(passage.outSec)} as this scene’s current take.`, 'ok')
      renderFootageReview()
      void preview()
    }
    const renderFootageReview = () => {
      if (!footageReview) return
      footageReview.hidden = !footage.value
      footageTranscript.replaceChildren()
      if (!footage.value) return
      const source = footageSource(footage.value)
      const selectedRange = previewFootage?.rel === footage.value
        && Number(previewFootage.outSec) > Number(previewFootage.inSec)
        ? previewFootage
        : null
      const rangeKey = selectedRange
        ? `${selectedRange.rel}:${selectedRange.inSec}:${selectedRange.outSec}`
        : ''
      const seekToSelectedStart = () => {
        if (!selectedRange || footagePlayer.readyState < HTMLMediaElement.HAVE_METADATA) return
        footagePlayer.currentTime = Math.max(0, Number(selectedRange.inSec) || 0)
      }
      if (footagePlayer.src !== new URL(source, window.location.href).href) {
        footagePlayer.src = source
        footagePlayer.load()
      }
      // Once a passage has been made the Canvas take, this is a review of that
      // passage — not a player that starts at the beginning of a 20-minute source
      // and silently runs through material the scene does not contain.
      if (rangeKey !== reviewedFootageRangeKey) {
        reviewedFootageRangeKey = rangeKey
        if (footagePlayer.readyState >= HTMLMediaElement.HAVE_METADATA) seekToSelectedStart()
        else footagePlayer.onloadedmetadata = seekToSelectedStart
      } else if (!selectedRange) footagePlayer.onloadedmetadata = null
      footagePlayer.ontimeupdate = () => {
        if (!selectedRange || footagePlayer.currentTime < Number(selectedRange.outSec)) return
        footagePlayer.pause()
        footagePlayer.currentTime = Number(selectedRange.outSec)
      }
      const cues = footageState?.transcript?.cues ?? []
      if (!footageState?.transcript) {
        footageReviewStatus.textContent = 'Transcribe this source before asking Claude to find the words for this scene.'
        return
      }
      const timing = footageState.transcript.timing === 'word' ? 'Word-level timing is ready.' : 'Caption-level timing is the fallback; re-transcribe for precise word cuts.'
      footageReviewStatus.textContent = `${footageState.transcript.words?.length ?? 0} words across ${cues.length} timed lines. ${timing}${selectedRange ? ` Reviewing the Canvas passage ${footageTime(selectedRange.inSec)}–${footageTime(selectedRange.outSec)}.` : ''} Claude’s suggestions and your own passage choices both save back to this Canvas scene.`
      const selected = selectedPassages()
      const selectedWords = selected.reduce((total, passage) => total + passage.last - passage.first + 1, 0)
      if (suggestedPassages.length) {
        const suggestions = mountRow('scene-suggestions').root
        for (const range of suggestedPassages) {
          const proposed = { inSec: Number(range.from?.startSec) || 0, outSec: Number(range.to?.endSec ?? range.to?.startSec) || 0, text: range.text ?? '' }
          const { root: line, el: suggestion } = mountRow('scene-suggestion')
          suggestion.use.textContent = `Use ${footageTime(proposed.inSec)}–${footageTime(proposed.outSec)}`
          suggestion.use.title = proposed.text
          suggestion.use.onclick = () => void usePassage(proposed)
          suggestion.text.textContent = proposed.text
          suggestions.append(line)
        }
        footageTranscript.append(suggestions)
      }
      const { root: manual, el: manualBits } = mountRow('scene-manual')
      const useManual = manualBits.use
      useManual.textContent = selected.length ? `Use ${selected.length} selected passage${selected.length === 1 ? '' : 's'}` : 'Select transcript words'
      useManual.disabled = !selected.length
      useManual.onclick = async () => {
        for (const passage of selected) await usePassage(passage)
      }
      const clear = manualBits.clear
      clear.disabled = !selected.length
      clear.onclick = () => {
        selectedWordIndexes = new Set()
        selectionAnchorWord = null
        renderFootageReview()
      }
      manualBits.hint.textContent = selected.length ? `${selectedWords} selected word${selectedWords === 1 ? '' : 's'} make ${selected.length} passage${selected.length === 1 ? '' : 's'} for this scene. Shift-click extends a continuous range; ordinary clicks add or remove individual words.` : 'Click the exact words you want. Shift-click a second word to select the range between them.'
      const lines = mountRow('paper-edit-lines').root
      lines.classList.add('scene-footage-review__lines')
      for (const cue of cues) {
        const { root: line, el: cells } = mountRow('paper-edit-line')
        const text = cells.text
        const wordIndexes = wordIndexesForCue(cue)
        line.classList.toggle('paper-edit__line--active', wordIndexes.some((index) => selectedWordIndexes.has(index)))
        cells.time.textContent = footageTime(cue.startSec)
        for (const index of wordIndexes) {
          const word = transcriptWords()[index]
          if (!word) continue
          const token = mountRow('paper-edit-word-button').root
          token.textContent = word.text
          token.dataset.rmWord = String(index)
          token.title = `${footageTime(word.startSec)}–${footageTime(word.endSec ?? word.startSec)}`
          token.classList.toggle('paper-edit__word--selected', selectedWordIndexes.has(index))
          token.setAttribute('aria-pressed', String(selectedWordIndexes.has(index)))
          token.onclick = (event) => {
            if (event.shiftKey && selectionAnchorWord != null) {
              const from = Math.min(selectionAnchorWord, index)
              const to = Math.max(selectionAnchorWord, index)
              for (let wordIndex = from; wordIndex <= to; wordIndex++) selectedWordIndexes.add(wordIndex)
            } else if (selectedWordIndexes.has(index)) selectedWordIndexes.delete(index)
            else selectedWordIndexes.add(index)
            selectionAnchorWord = index
            // A selection is not a request to scrub the video. Seeking here
            // invokes the player's active-cue scroll and throws the transcript
            // away from the range the person is building.
            window.setTimeout(() => repaintTranscriptKeepingPosition(footageTranscript, index, renderFootageReview), 50)
          }
          text.append(token, document.createTextNode(' '))
        }
        lines.append(line)
      }
      footageTranscript.append(manual, lines)
    }
    const loadFootageReview = async () => {
      footageState = null
      suggestedPassages = []
      selectedWordIndexes = new Set()
      selectionAnchorWord = null
      if (!footage.value) return renderFootageReview()
      const response = await fetch(`/api/paper-edit?project=${encodeURIComponent(proj.value)}&rel=${encodeURIComponent(footage.value)}`).catch((error) => ({ error: error.message }))
      const result = response.error ? response : await responseJson(response)
      if (result.error) return setFootageHint(result.error, 'bad')
      footageState = result.state
      // A saved Canvas take is the authoritative transcript selection when the
      // editor reopens. Without this, the player knows the in/out range but the
      // words look unselected, which makes the scene appear detached from its
      // own footage.
      selectPreviewWords()
      renderFootageReview()
    }
    footage.onchange = () => {
      attachFootage.disabled = !footage.value
      transcribeFootage.disabled = !footage.value
      suggestFootage.disabled = !footage.value
      void loadFootageReview()
    }
    attachFootage.onclick = async () => {
      if (!boardScene?.id || !footage.value) return setFootageHint('Choose a video first.', 'bad')
      const file = videoFiles().find((item) => item.rel === footage.value)
      attachFootage.disabled = true
      setFootageHint('Attaching video…')
      const response = await fetch('/api/board/take', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: proj.value, slotId: boardScene.id, rel: footage.value, inSec: 0, outSec: file?.media?.durationSec ?? 0, durationSec: file?.media?.durationSec ?? null }),
      }).catch((error) => ({ error: error.message }))
      const result = response.error ? response : await responseJson(response)
      attachFootage.disabled = !footage.value
      if (result.error) return setFootageHint(result.error, 'bad')
      const chosen = await footageRequest('board/pick', { takeId: result.takeId })
      if (chosen.error) return setFootageHint(`Attached, but Studio could not choose it: ${chosen.error}`, 'warn')
      footageBoard = chosen.board
      const take = (footageBoard?.takes ?? []).find((item) => item.id === result.takeId)
      previewFootage = asPreviewFootage(take)
      savedSceneFootage = previewFootage
      boardScene.takeId = result.takeId
      const count = (footageBoard?.takes ?? []).filter((item) => item.slotId === boardScene.id).length
      setFootageHint(`Attached and selected. This shot now has ${count} video${count === 1 ? '' : 's'}.`, 'ok')
      void loadFootageReview()
      void preview()
    }
    transcribeFootage.onclick = async () => {
      if (!footage.value) return setFootageHint('Choose a video first.', 'bad')
      transcribeFootage.disabled = true
      setFootageHint('Transcribing in the background…')
      const result = await footageRequest('paper-edit/transcribe', { language: 'en' })
      if (result.error) {
        transcribeFootage.disabled = false
        return setFootageHint(result.error, 'bad')
      }
      const job = result.alreadyRunning ? result.job : await start(result.step, { status: footageHint })
      if (!job) {
        transcribeFootage.disabled = false
        return
      }
      const rel = footage.value
      watchJobInPlace(job, footageHint, async (finished) => {
        transcribeFootage.disabled = false
        if (!finished || finished.code !== 0 || footage.value !== rel) return
        const attached = await footageRequest('paper-edit/transcript', { fromFile: true })
        if (attached.error) return setFootageHint(attached.error, 'bad')
        await loadFootageReview()
        setFootageHint('Transcript ready. Ask Claude to find the words for this scene, or select them yourself.', 'ok')
      })
    }
    suggestFootage.onclick = async () => {
      if (!footageState?.transcript) return setFootageHint('Transcribe this video first.', 'bad')
      suggestFootage.disabled = true
      setFootageHint('Claude is matching this scene’s brief to this video in the background…')
      const result = await footageRequest('board/suggest', { intent: about.value })
      if (result.error) {
        suggestFootage.disabled = false
        return setFootageHint(result.error, 'bad')
      }
      const job = await start(result.step, { status: footageHint })
      if (!job) {
        suggestFootage.disabled = false
        return
      }
      const rel = footage.value
      watchJobInPlace(job, footageHint, async (finished) => {
        suggestFootage.disabled = false
        if (!finished || finished.code !== 0 || footage.value !== rel) return
        const loaded = await footageRequest('board/suggest/load')
        if (loaded.error) return setFootageHint(loaded.error, 'bad')
        suggestedPassages = loaded.checked?.ranges ?? []
        renderFootageReview()
        setFootageHint(`Claude found ${suggestedPassages.length} passage${suggestedPassages.length === 1 ? '' : 's'} for this scene. Review the words and choose one.`, 'ok')
      })
    }
    addFootage.onclick = () => footagePicker.click()
    footagePicker.onchange = async () => {
      const file = footagePicker.files?.[0]
      footagePicker.value = ''
      if (!file) return
      addFootage.disabled = true
      setFootageHint(`Adding ${file.name}…`)
      const response = await fetch(`/api/import/upload?project=${encodeURIComponent(proj.value)}&name=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: file,
        duplex: 'half',
      }).catch((error) => ({ error: error.message }))
      const result = response.error ? response : await responseJson(response)
      addFootage.disabled = false
      if (result.error) return setFootageHint(result.error, 'bad')
      // Refresh the catalogue without remounting the editor and losing its unsaved stage.
      const next = await fetch('/api/state').then(responseJson).catch(() => null)
      if (next?.projects) S = next
      const filename = String(result.file ?? file.name).split('/').pop() || file.name
      const added = videoFiles().find((item) => item.name === filename)
      await refreshFootage(added?.rel ?? '')
      if (added) {
        await loadFootageReview()
        setFootageHint(`${added.name} is ready. Transcribe it to review the words for this scene.`, 'ok')
      }
    }
    if (boardScene) boardFootageReady = refreshFootage().then(() => loadFootageReview())
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
   * The same way out as the designers have.
   *
   * A scene could only be saved and then referenced by Canvas, which means a
   * rebuilt cut — and rebuilding discards whatever has been tuned in the
   * composition since. This is the other route: drop what is on screen into a
   * composition that already exists and leave the rest of the file alone. The
   * scene keeps its own sequencing, because each element carries its `at` and
   * the insert places them relative to where the scene lands.
   *
   * Save and the name field are the panel's own, so only the insert and the
   * copy come from here.
   */
  intoFooter(...sceneOutlets({ tag: toMarkup, startMs: () => Number(scrub?.value) || 0, withSave: false }))

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
  let previewRequest = 0
  const sync = ({ repaint = true } = {}) => {
    rawText.value = toMarkup()
    if (repaint) paintCards()
    clearTimeout(previewTimer)
    previewTimer = setTimeout(preview, 350)
  }

  async function preview() {
    const request = ++previewRequest
    const r = await responseJson(await fetch('/api/scene/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          body: toMarkup(),
          wallpaper: wp.value,
          brand: brand.value || null,
          name: name.value,
          footage: previewFootage
            ? { src: footageSource(previewFootage.rel), inSec: previewFootage.inSec, outSec: previewFootage.outSec }
            : null,
        }),
      }))
    // A change to title text, palette, or Canvas footage can each request a new
    // preview. Only the newest response is allowed to replace the iframe; a
    // slower first request otherwise strips the chosen trimmed clip back out.
    if (request !== previewRequest) return
    if (r.url) frame.src = r.url
  }

  /* One card per part. The fields come from the catalogue, so a component that
     gains one gains it here with no second edit. */
  function paintCards() {
    cards.replaceChildren()
    if (!elements.length) {
      cards.append(control('hint', { textContent: 'Nothing on the stage yet. Add a part above — a title is the usual opener.' }))
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
      const { root: card, el: part } = mountRow('scene-part')
      card.open = i === elements.length - 1

      const first = spec?.fields.map((fl) => e.attrs[fl]).find((v) => String(v ?? '').trim()) ?? ''
      part.tag.textContent = e.tag.replace(/^rm-/, '')
      part.when.textContent = `${(e.at / 1000).toFixed(1)}s → ${((e.at + e.for) / 1000).toFixed(1)}s`
      part.first.textContent = String(first).slice(0, 48)

      /*
       * Change what this part is, keeping what still applies.
       *
       * A part was whichever component the palette made it, for good — picking
       * the wrong one meant deleting it and starting again, which threw away its
       * timing and every field the two components share. Most of them share
       * most of it: a title, a body, an x and a y mean the same thing to a field
       * as to a shader.
       *
       * Kept by NAME against the new component's own field list, so a field the
       * new one does not have is dropped rather than carried as an attribute
       * nothing reads, and one it has but the old one did not is seeded from the
       * same sample the palette uses.
       */
      const swap = part.swap
      swap.replaceChildren()
      for (const c of cat.components ?? []) {
        swap.append(new Option(c.tag.replace(/^rm-/, ''), c.tag, false, c.tag === e.tag))
      }
      swap.onchange = () => {
        const next = (cat.components ?? []).find((c) => c.tag === swap.value)
        if (!next) return
        const kept = {}
        for (const fld of next.fields) {
          if (String(e.attrs[fld] ?? '').trim()) kept[fld] = e.attrs[fld]
          else {
            const sample = COMPONENT_SAMPLE[next.tag]?.[fld] ?? SCENE_SAMPLE[fld]
            if (sample != null) kept[fld] = sample
          }
        }
        e.tag = next.tag
        e.attrs = kept
        sync()
      }

      const up = part.up
      up.disabled = i === 0
      up.onclick = () => {
        elements.splice(i - 1, 0, elements.splice(i, 1)[0])
        sync()
      }
      const down = part.down
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
      const kill = part.kill
      kill.append(icon('delete-02'))
      kill.onclick = () => {
        elements.splice(i, 1)
        sync()
      }

      const grid = part.grid

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
        const { root: g, el: fg } = mountRow('form-group')
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
        fg.label.textContent = text
        g.append(control)
        const real = control.matches?.('input, select, textarea') ? [control] : [...control.querySelectorAll('input, select, textarea')]
        for (const c of real) c.classList.add('form-control', 'form-control--small')
        return g
      }

      const at = control('number', { step: 100, value: e.at })
      at.oninput = () => {
        e.at = Number(at.value) || 0
        sync({ repaint: false })
      }
      const dur = control('number', { step: 100, value: e.for })
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
          const { root: group, el: imageField } = mountRow('scene-image-field')
          imageField.label.textContent = fld
          const strip = imageField.strip

          const tile = (label, file, node) => {
            const { root: b, el: tileBits } = mountRow('scene-image-tile')
            const on = (e.attrs[fld] ?? '') === file
            b.setAttribute('aria-pressed', String(on))
            b.title = label
            if (on) {
              b.style.border = '1px solid var(--op-color-primary-base)'
              b.style.outline = '2px solid var(--op-color-primary-base)'
              b.style.outlineOffset = '1px'
            }
            tileBits.frame.append(node)
            tileBits.cap.textContent = label
            b.onclick = () => {
              e.attrs[fld] = file
              paintCards()
              sync()
            }
            strip.append(b)
          }

          // "None" first, because clearing a picture is a thing you need to be able
          // to do and a second click on the chosen tile is not discoverable.
          const none = control('span', { textContent: '—' })
          none.style.cssText = 'font-size:1.5rem;opacity:0.5'
          tile('none', '', none)
          for (const item of cat.imagery ?? []) {
            // Added Brand assets live in the library, while the vendored scene
            // imagery lives with the app. Both render as bare filenames after
            // staging, but their picker thumbnails need the source that owns
            // them now.
            const thumb = control('img', { src: item.source === 'added' ? `/added/${encodeURIComponent(item.file)}` : `/brand/imagery/${item.file}` })
            thumb.style.cssText = 'max-inline-size:100%;max-block-size:3.5rem;object-fit:contain;display:block'
            tile(item.name.replace(/^academy-/, ''), item.file, thumb)
          }
          /*
           * Every component that takes an image can be given one.
           *
           * This was a list of two tags while rm-haze also declared an `image`
           * field, so the haze offered the vendored pictures and no way to
           * supply your own — the one component most likely to want a photograph
           * was the one that could not be handed one. Asking IMAGE_FIELDS keeps
           * the offer and the capability in step: a component that declares an
           * image field gets the upload, and a new one gets it for free.
           */
          if (isImageField(e.tag, fld)) {
            /*
             * Embed the picked image in the scene rather than pointing at the
             * browser's temporary file URL. The same body is previewed from the
             * Studio and rendered later from a different directory; a data URL
             * is the one reference both contexts can resolve without losing the
             * person's original upload or a server-side path.
             */
            const upload = imageField.upload
            upload.hidden = false
            const picker = imageField.picker
            upload.onclick = () => picker.click()
            picker.onchange = async () => {
              const file = picker.files?.[0]
              picker.value = ''
              if (!file) return
              /*
               * Uploaded to the shelf, referenced by name.
               *
               * This read the file into a data URL and put it in the attribute,
               * which does resolve everywhere — and buries two megabytes of
               * base64 in a composition somebody has to read, diff and edit. Four
               * of them made one file 8.8MB of which 8.79MB was the pictures.
               *
               * The shelf is where the vendored tiles beside this field already
               * come from, and the same staging copies an added picture into
               * every composition that uses it. So a bare filename resolves in
               * the Studio, in a saved scene, and in a render — which is all the
               * data URL was ever for.
               */
              says('Uploading the picture…')
              const saved = await fetch(`/api/brand/asset?name=${encodeURIComponent(file.name)}`, {
                method: 'POST',
                headers: { 'content-type': file.type || 'application/octet-stream' },
                body: file,
              })
                .then(responseJson)
                .catch((error) => ({ error: error.message }))
              if (saved.error || !saved.file) {
                says(saved.error ?? 'that upload did not finish', 'bad')
                return
              }
              e.attrs[fld] = saved.file
              says(`Added ${saved.file}`, 'ok')
              paintCards()
              sync()
            }
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
          const { root: group, el: rangeField } = mountRow('scene-range-field')
          rangeField.label.textContent = fld
          const slider = Object.assign(rangeField.slider, {
            min: range.min,
            max: range.max,
            step: range.step,
            value: Number(e.attrs[fld] ?? range.fallback),
          })
          const readout = rangeField.readout
          readout.textContent = `${slider.value}${range.suffix}`
          slider.oninput = () => {
            e.attrs[fld] = slider.value
            readout.textContent = `${slider.value}${range.suffix}`
            // repaint:false — rebuilding the cards mid-drag would replace the
            // slider under the pointer and the drag would stop dead.
            sync({ repaint: false })
          }
          grid.append(group)
          continue
        }

        const choices = ENUM_FIELDS[fld]
        if (choices) {
          const sel = control('select')
          for (const c of choices) sel.append(new Option(c || '—', c, false, e.attrs[fld] === c))
          sel.onchange = () => {
            e.attrs[fld] = sel.value
            sync({ repaint: false })
          }
          grid.append(labelled(fld, sel))
          continue
        }
        const inp = control('input', { value: e.attrs[fld] ?? '', placeholder: fld })
        inp.oninput = () => {
          e.attrs[fld] = inp.value
          sync({ repaint: false })
        }
        grid.append(labelled(fld, inp))
      }
      cards.append(card)
    })
  }

  const buildPalette = (components) => {
    for (const c of components ?? []) {
      const b = control('button', { className: 'btn ghost', textContent: c.tag.replace(/^rm-/, '') })
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
    swatches.replaceChildren()
    /*
     * An empty catalogue is reported, not rendered as an empty dropdown.
     *
     * `cat.colors` is absent if the fetch failed or the server predates it, and a
     * menu with nothing in it looks exactly like a picker with a bug. Saying so
     * turns "the colours are gone" into a cause.
     */
    if (!families.length) {
      swatches.append(control('span', { className: 'hint', textContent: 'No brand colours came back — the Studio server is older than this page. Quit and reopen the app; a page reload alone will not pick it up.' }))
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
    let sceneDuration = 0
    try {
      sceneDuration = frame.contentWindow?.RM?.duration?.() ?? 0
    } catch {
      /* leave the default range */
    }
    /* A scene can have a 2.6s lower third over a 19s selected take. The old
       scrubber stopped at the component's 2.6s lifetime, making most of the
       actual Canvas passage unreachable in its own scene editor. Keep the
       whole selected in/out span as the review duration; components can still
       end naturally while the chosen footage continues beneath them. */
    const footageDuration = previewFootage
      ? Math.max(0, (Number(previewFootage.outSec) - Number(previewFootage.inSec)) * 1000)
      : 0
    const dur = Math.max(sceneDuration, footageDuration)
    if (dur) scrub.max = Math.max(2000, Math.round(dur))
    if (!playheadMoved && dur) scrub.value = Math.round(Math.min(dur, Math.max(0, sceneDuration / 2 || dur / 2)))
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
  let sceneRevisions = []
  const refreshSceneRevisions = async () => {
    if (!pick.value) {
      sceneRevisions = []
      restore.hidden = true
      return
    }
    const response = await fetch(`/api/scene/revisions?project=${encodeURIComponent(proj.value)}&scene=${encodeURIComponent(pick.value)}`).catch(() => null)
    const result = response ? await responseJson(response) : { revisions: [] }
    sceneRevisions = result.revisions ?? []
    restore.hidden = !sceneRevisions.length
    if (sceneRevisions.length) restore.title = `${sceneRevisions.length} earlier saved version${sceneRevisions.length === 1 ? '' : 's'} available`
  }
  const linkToCanvas = async (scene) => {
    if (!boardScene?.id || !scene) return true
    const response = await fetch('/api/board/node/update', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: proj.value, nodeId: boardScene.id, scene, takeId: sceneFootage()?.takeId || boardScene.takeId || undefined }),
    }).catch(() => null)
    const result = response ? await responseJson(response) : { error: 'could not reconnect this scene to the canvas' }
    if (result.error) {
      say(`Scene saved, but it could not be linked back to this canvas node: ${result.error}`, 'warn')
      return false
    }
    boardScene.scene = scene
    return true
  }
  const loadScenes = async () => {
    const r = await responseJson(await fetch('/api/scenes?project=' + encodeURIComponent(proj.value))).catch(() => ({ scenes: [] }))
    savedScenes.length = 0
    savedScenes.push(...(r.scenes ?? []))
    pick.replaceChildren(new Option(savedScenes.length ? 'new scene' : 'no scenes yet', ''))
    for (const sc of savedScenes) pick.append(new Option(sc.name, sc.name))
  }
  let sceneLoadReady = Promise.resolve()
  const loadSelectedScene = async () => {
    const sc = savedScenes.find((x) => x.name === pick.value)
    if (!sc) return
    name.value = sc.name
    elements = fromMarkup(sc.body)
    /* The ground it was designed on. Saving it was only half the fix — a scene
       that reopened on the default wallpaper is still a scene composed against
       something you cannot see. */
    if (sc.ground?.wallpaper && [...wp.options].some((o) => o.value === sc.ground.wallpaper)) wp.value = sc.ground.wallpaper
    if (sc.ground?.brand && [...brand.options].some((o) => o.value === sc.ground.brand)) brand.value = sc.ground.brand
    savedSceneFootage = asPreviewFootage(sc.footage)
    // Canvas owns the live edit when a node has an explicit pick. A saved scene
    // fills the gap only when that node has no pick (and always when opening
    // from the gallery), so a newer board choice cannot be overwritten simply
    // because it happens to use a different source file.
    const boardHasPick = Boolean(boardScene?.id && (footageBoard?.picks?.[boardScene.id] || boardScene.takeId))
    if (!boardHasPick) previewFootage = savedSceneFootage
    const activeFootage = boardHasPick ? previewFootage : savedSceneFootage
    if (activeFootage?.rel) {
      fillFootage(activeFootage.rel)
      if (footageGroup) await loadFootageReview()
    }
    await refreshSceneRevisions()
    sync()
  }
  pick.onchange = () => {
    sceneLoadReady = loadSelectedScene()
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

  restore.onclick = async () => {
    const revision = sceneRevisions[0]
    if (!revision || !pick.value) return
    restore.disabled = true
    const response = await fetch('/api/scene/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: proj.value, name: pick.value, revision }),
    }).catch((error) => ({ error: error.message }))
    const result = response.error ? response : await responseJson(response)
    restore.disabled = false
    if (result.error) return say(result.error, 'bad')
    elements = fromMarkup(result.body)
    await loadScenes()
    pick.value = result.name
    await refreshSceneRevisions()
    sync()
    say('Restored the previous saved scene. The version you just had is saved too.', 'ok')
  }

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
    const r = await responseJson(await fetch('/api/scene', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        /* The ground travels with the scene. The preview has always sent these
           and the save never did, so a scene composed on a dark wallpaper
           reopened on the default one. */
        body: JSON.stringify({ projectId: proj.value, name: name.value, body: toMarkup(), wallpaper: wp.value, brand: brand.value || '', ...(sceneFootage() ? { footage: sceneFootage() } : {}) }),
      }))
    if (r.error) return say(r.error, 'bad')
    savedSceneFootage = asPreviewFootage(r.footage) || savedSceneFootage
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
    await refreshSceneRevisions()
    const linked = await linkToCanvas(r.name)
    if (linked && boardScene) backToCanvas()
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
    const r = await responseJson(await fetch('/api/scene/draft', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: proj.value, name: name.value, about: about.value, ...(sceneFootage() ? { footage: sceneFootage() } : {}) }),
      }))
    draft.disabled = false
    if (r.error) return say(r.error, 'bad')
    savedSceneFootage = asPreviewFootage(r.footage) || savedSceneFootage
    elements = fromMarkup(r.body)
    sync()
    say(`${elements.length} part${elements.length === 1 ? '' : 's'} drafted and saved to ${r.file}`, 'ok')
    await loadScenes()
    pick.value = r.name
    await refreshSceneRevisions()
    const linked = await linkToCanvas(r.name)
    if (linked && boardScene) backToCanvas()
  }

  fetch('/api/compose/catalogue')
    .then((r) => r.json())
    .then((c) => {
      cat = c
      wp.append(new Option('no wallpaper', ''))
      for (const w of c.wallpapers ?? []) wp.append(new Option(w.label, w.name))
      wp.selectedIndex = Math.min(1, wp.options.length - 1)
      buildPalette(c.components)
      buildSwatches()
      paintCards()
      return loadScenes()
    })
    .then(async () => {
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
      } else if (boardScene?.scene) {
        pick.value = boardScene.scene
        pick.onchange()
      }
      // The stage must be built from the selected Canvas take, not whichever
      // preview happened to answer first while the scene body was loading.
      await boardFootageReady
      await sceneLoadReady
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
  const ui = mountPanel('compose', m)
  let shelfScenes = []

  const f = ui.form
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
  const name = mk('Save as', control('input', { placeholder: 'opener' }))
  /*
   * Narration, because a capture is almost never the audio.
   *
   * A screen recording with no mic carries a silent track, so a composition made
   * from one comes out valid and inaudible — which reads as the render losing the
   * audio rather than as there never having been any. rm-voice writes the voice
   * beside the footage; this is where it gets picked up.
   */
  const narr = mk('Narration', control('select'), 'Mixed over the whole cut. Footage that carries its own sound is ducked under it, not muted.')
  const fillNarration = () => {
    narr.replaceChildren(new Option('none', ''))
    const audio = (S.projects.find((x) => x.id === proj.value)?.catalog?.files ?? []).filter((x) => x.kind === 'audio')
    for (const a of audio) narr.append(new Option(a.rel, a.path))
    if (!audio.length) narr.options[0].textContent = 'no audio in this project yet — record one in Voice'
  }

  const { root: shelf, el: shelfBits } = mountRow('compose-shelf')
  const list = mountRow('compose-list').root
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
  const bar = mountRow('control-row').root
  const out = control('pre')
  out.style.display = 'none'
  f.append(shelf, list, bar, out)

  /* The catalogue is fetched, not hardcoded: it is parsed from the components
     themselves, so a new field appears here without a second edit. */
  let cat = { components: [], wallpapers: [], imagery: [] }
  const segments = []

  const paint = () => {
    list.replaceChildren()
    if (!segments.length) {
      list.append(control('hint', { textContent: 'Nothing in the running order yet. A title scene, then the recording it introduces, is the usual shape — take a scene off the shelf above, or Add footage below.' }))
    }
    /* Rendering an empty order can only fail; the button says why it waits. */
    go.disabled = !segments.length
    go.title = segments.length ? '' : 'Add a scene or footage first.'
    segments.forEach((seg, i) => {
      const { root: row, el: card } = mountRow('compose-segment')
      const body = card.body
      card.title.textContent = `${i + 1}. ${seg.kind === 'scene' ? 'Scene' : 'Footage'}`
      card.up.disabled = i === 0
      card.up.onclick = () => {
        segments.splice(i - 1, 0, segments.splice(i, 1)[0])
        paint()
      }
      card.down.disabled = i === segments.length - 1
      card.down.onclick = () => {
        segments.splice(i + 1, 0, segments.splice(i, 1)[0])
        paint()
      }
      card.kill.onclick = () => {
        segments.splice(i, 1)
        paint()
      }

      /*
       * The sub-brand, per segment.
       *
       * A saved scene is only a body — the stage around it is built at render time
       * — so this cannot live in the scene file. It lives where the wallpaper
       * already does, on the segment, which is also what lets one scene appear in
       * an Academy cut and a RoleModel one without being copied.
       */
      const brandPick = control('select', { className: 'form-control form-control--small' })
      for (const [value, label] of [
        ['', 'RoleModel — DM Sans'],
        ['academy', 'Academy — Space Grotesk'],
      ]) {
        brandPick.append(new Option(label, value, false, (seg.brand ?? '') === value))
      }
      brandPick.onchange = () => {
        seg.brand = brandPick.value || undefined
      }

      if (seg.kind === 'scene' && seg.bodyFile) {
        /* A reference, not a copy: edit it in Scenes and every composition using
           it follows, because rm-compose reads the file at render time. */
        card.scenePath.hidden = false
        card.scenePath.textContent = seg.bodyFile.replace(/^.*\/scenes\//, 'scenes/')
        card.sceneHint.hidden = false
        body.append(brandPick)
        list.append(row)
        return
      }

      if (seg.kind === 'footage') {
        const pickF = control('select', { className: 'form-control' })
        // The catalog hangs off the project, not off state — every other panel
        // that lists footage reads it the same way.
        const files = (S.projects.find((x) => x.id === proj.value)?.catalog?.files ?? []).filter((x) => x.kind === 'video')
        // `rel`, not `path`: a catalogue entry has no absolute path, so this was
        // sending undefined and every composition with footage in it 403'd.
        for (const c of files) {
          pickF.append(new Option(c.rel, c.rel))
        }
        if (!pickF.options.length) {
          pickF.append(new Option('no footage indexed in this project'))
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
        const els = mountRow('compose-elements').root
        seg.elements.forEach((e, j) => {
          const spec = cat.components.find((c) => c.tag === e.tag)
          const { root: line, el: cell } = mountRow('compose-element')
          cell.tag.textContent = e.tag
          const at = Object.assign(cell.at, { value: e.at ?? 0 })
          at.oninput = () => {
            e.at = Number(at.value) || 0
          }
          const dur = Object.assign(cell.for, { value: e.for ?? 2500 })
          dur.oninput = () => {
            e.for = Number(dur.value) || 0
          }
          for (const fieldName of spec?.fields ?? []) {
            /* A few fields are a choice, not a sentence. Typing "centre" into a
               free text box produces a scene that renders left-aligned and says
               nothing about why. */
            const choices = ENUM_FIELDS[fieldName]
            if (choices) {
              const sel = control('select', { className: 'form-control' })
              for (const c of choices) sel.append(new Option(c, c, false, e.attrs[fieldName] === c))
              sel.onchange = () => {
                e.attrs[fieldName] = sel.value
              }
              e.attrs[fieldName] = e.attrs[fieldName] ?? choices[0]
              cell.remove.before(sel)
              continue
            }
            const inp = control('input', { className: 'form-control', placeholder: fieldName, value: e.attrs[fieldName] ?? '' })
            inp.oninput = () => {
              e.attrs[fieldName] = inp.value
            }
            cell.remove.before(inp)
          }
          cell.remove.onclick = () => {
            seg.elements.splice(j, 1)
            paint()
          }
          els.append(line)
        })
        const addEl = control('select', { className: 'form-control' })
        addEl.append(new Option('Add an element…', ''))
        for (const c of cat.components) addEl.append(new Option(c.tag, c.tag))
        addEl.onchange = () => {
          if (!addEl.value) return
          seg.elements.push({ tag: addEl.value, at: 0, for: 2500, attrs: {} })
          paint()
        }
        const wp = control('select', { className: 'form-control' })
        wp.append(new Option('no wallpaper', ''))
        for (const w of cat.wallpapers) wp.append(new Option(w.label, w.name))
        wp.value = seg.wallpaper || ''
        wp.onchange = () => {
          seg.wallpaper = wp.value
        }
        body.append(wp, brandPick, els, addEl)
      }
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
    const r = await responseJson(await fetch('/api/scenes?project=' + encodeURIComponent(proj.value))).catch(() => ({ scenes: [] }))
    for (const old of shelf.querySelectorAll('button')) old.remove()
    const scenes = r.scenes ?? []
    shelfBits.empty.hidden = scenes.length > 0
    if (!scenes.length) return
    for (const sc of scenes) {
      const chip = control('button', { className: 'btn ghost', textContent: sc.name })
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
  let go
  const addFootage = control('button', { className: 'btn ghost', textContent: 'Add footage' })
  addFootage.prepend(icon('add-01'))
  addFootage.onclick = () => {
    segments.push({ kind: 'footage', path: '' })
    paint()
  }
  go = control('button', { textContent: 'Render and open' })
  go.prepend(icon('film-01'))
  go.onclick = async () => {
    const r = await responseJson(await fetch('/api/compose', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: proj.value, name: name.value, audio: narr.value || null, segments }),
      }))
    out.style.display = 'block'
    out.replaceChildren()
    if (r.error) {
      out.textContent = 'Error: ' + r.error
      return
    }
    out.append(control('path', { textContent: 'writes  ' + r.out }))
    out.append(runRow(r.step, 'Render the composition'))
    out.append(control('path', { textContent: 'When it finishes, the document is in that folder — open it from the Library.' }))
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
  statusSink(status)
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
/* ── Storyboard ──────────────────────────────────────────── */

/**
 * The board: what the video needs, what we shot, which take won.
 *
 * WHY THIS IS A CANVAS AND NOT A LIST
 *
 * Cut is a list because a cut IS a list — one thing after another. Deciding is
 * not: you have four takes of one shot and you need to see them beside each
 * other, at the same size, at the same moment. A list makes you scroll between
 * the things you are comparing, which is the one thing a comparison cannot
 * survive.
 *
 * So shots are columns and takes stack inside them. Reading across tells you
 * what the video is; reading down one column tells you what you have for that
 * shot. Both questions get answered by looking rather than by remembering.
 *
 * THE PICKS ARE THE CUT
 *
 * There is no "add to cut" step, deliberately. Choosing a take per shot IS the
 * edit decision, so the footer's action compiles the board rather than exporting
 * it — see lib/storyboard.mjs, where `toCutlist` is a projection of the picks.
 * The consequence worth stating: a board with every shot settled is already a
 * finished assembly, and the button only writes it down.
 */
/* ── Guided video workflow ────────────────────────────────── */

function vWorkflow(m) {
  const project = currentProjectRecord()
  const handed = handoffNote()
  if (handed) m.append(handed)
  const { panel, lede, rail } = mountPanel('workflow', m)
  lede.textContent = 'Create a video for ' + (project?.name ?? 'this project')

  const read = async (url) => {
    const response = await fetch(url).catch(() => null)
    if (!response?.ok) return null
    return response.json().catch(() => null)
  }

  const draw = ({ interview, board, workflow, assembly, alignment }) => {
    const scripts = (S.scripts ?? []).filter((script) => script.project === project?.id)
    const script = [...scripts].sort((a, b) => String(b.mtime ?? '').localeCompare(String(a.mtime ?? '')))[0] ?? null
    const videos = (project?.catalog?.files ?? []).filter((file) => file.kind === 'video')
    const hasPlan = Boolean(interview?.state?.plan?.shots?.length)
    const interviewTurns = interview?.state?.turns?.length ?? 0
    const interviewStarted = interviewTurns > 0
    const interviewPending = Boolean(interview?.state?.pendingReply)
    const hasCanvas = Boolean(board?.board?.slots?.length)
    const assemblyPicks = assembly?.state?.picks ?? []
    const assemblySources = assembly?.state?.sources ?? []
    const assemblyTimeline = Boolean(assembly?.state?.hyperframesProject)
    const alignmentSegments = alignment?.state?.segments ?? []
    const assemblyReady = assemblyPicks.length > 0 || assemblyTimeline || alignmentSegments.length > 0
    const visualAlignmentReady = !assemblyPicks.length && !assemblyTimeline && alignmentSegments.length > 0
    const assemblyCount = visualAlignmentReady ? alignmentSegments.length : assemblySources.length || assemblyPicks.length
    const assemblyDetail = visualAlignmentReady
      ? `${assemblyCount} screen cut${assemblyCount === 1 ? '' : 's'} ready to review`
      : `${assemblyCount} recording${assemblyCount === 1 ? '' : 's'} prepared${assemblyPicks.length ? ` · ${assemblyPicks.length} select${assemblyPicks.length === 1 ? '' : 's'}` : ''}`
    /*
     * A render on disk is the evidence that the edit happened.
     *
     * Renders land in media/Renders/<name>/, so the catalog already carries the
     * proof — the last three steps were hard-coded `done: false`, which made
     * `activeAt` (the first step that is not done) unable to move past Assembly.
     * The hub therefore said "Step 5 of 7" on a finished video, forever.
     */
    const renders = videos.filter((file) => /^Renders\//.test(String(file.rel ?? '')))
    const hasRender = renders.length > 0
    const steps = [
      {
        id: 'interview',
        view: 'interview',
        label: 'Plan',
        detail: hasPlan ? `${interview.state.plan.shots.length} beats planned` : interviewPending ? 'Claude is shaping the next question' : interviewStarted ? `Interview started · question ${interviewTurns}` : 'Answer a few questions',
        done: hasPlan,
        inProgress: interviewStarted && !hasPlan,
        title: hasPlan ? 'Your plan is ready' : interviewStarted ? 'Keep shaping the video' : 'Start with the outcome',
        body: hasPlan ? 'Review the beats Claude assembled before turning them into a script.' : interviewStarted ? 'Your interview is saved. Continue from the current question whenever you are ready.' : 'Answer a few practical questions. Claude turns what you know into the working plan for this video.',
        icon: assemblyReady ? 'hgi-flow-connection' : interviewStarted ?  'hgi-flow-connection' : 'hgi-stroke hgi-rounded hgi-mic-01',
        action: hasPlan ? 'Review the plan' : interviewStarted ? 'Continue plan' : 'Begin Plan',
      },
      {
        id: 'script',
        view: 'scripts',
        label: 'Script',
        detail: scripts.length ? `${scripts.length} script${scripts.length === 1 ? '' : 's'} saved` : 'Write the words',
        done: scripts.length > 0,
        title: 'Turn the plan into a script',
        body: 'Claude drafts the words and recording direction from the interview. Review the script before using it to build the canvas.',
        action: scripts.length ? 'Open the script' : 'Draft the script',
      },
      { id: 'canvas', view: 'storyboard', label: 'Canvas', detail: hasCanvas ? `${board.board.slots.length} scenes on the canvas` : 'Turn script into scenes', done: hasCanvas, title: 'Build the canvas from the script', body: 'Turn each script beat into a scene with a clear visual and a recording or generation request.', action: hasCanvas ? 'Open the canvas' : 'Build canvas from the script' },
      { id: 'record', view: 'record', label: 'Record', detail: videos.length ? `${videos.length} recording${videos.length === 1 ? '' : 's'} ready` : 'Capture or add footage', done: videos.length > 0, title: 'Record the work', body: 'Use the script as your guide, then record the screen or add the footage you already have.', action: videos.length ? 'View recordings' : 'Record or add footage' },
      {
        id: 'assembly',
        view: 'paperedit',
        label: 'Assembly',
        detail: assemblyReady ? assemblyDetail : videos.length ? 'Choose the lines and make a first cut' : 'Waiting for footage',
        // Done when the assembly has become an editable timeline — that handoff
        // into HyperFrames is exactly what finishing Assembly means.
        done: assemblyTimeline,
        inProgress: assemblyReady && !assemblyTimeline,
        title: assemblyReady ? visualAlignmentReady ? 'Your visual alignment is ready to review' : 'Your assembly is ready to review' : 'Make the first assembly',
        body: assemblyReady ? visualAlignmentReady ? 'The screen cuts and matching narration are saved with this project. Review the alignment before you render it.' : 'Claude’s timestamped selects are saved with this project. Review the clips and comments before you open the visual timeline.' : 'Transcribe a recording, choose the lines to keep, and create an editable first cut without touching a timeline first.',
        icon: assemblyReady ? 'hgi-flow-connection' :  'hgi-flow-connection',
        action: assemblyReady ? 'Review assembly' : 'Make the first assembly',
      },
      {
        id: 'edit',
        view: 'editor',
        label: 'Edit',
        detail: hasRender ? `${renders.length} render${renders.length === 1 ? '' : 's'} in this project` : 'Refine the visual timeline',
        done: hasRender,
        inProgress: assemblyTimeline && !hasRender,
        title: 'Shape the visual edit',
        body: 'The first cut opens in the visual editor, where you can review timing, make trims, add captions and decide when it is ready to render.',
        action: 'Open the visual editor',
      },
      {
        id: 'review',
        view: 'review',
        label: 'Review',
        detail: hasRender ? 'Send the render for review' : 'Share the finished render',
        /* No local evidence for this one: whether a version was sent lives in
           OpenFrame, and the hub does not hold a token or a version id. Left not
           done rather than guessed — by this point it is the last step anyway. */
        done: false,
        inProgress: hasRender,
        title: 'Review and share',
        body: 'When the render is ready, send it for review and keep the feedback connected to the actual video.',
        action: 'Open review',
      },
    ]
    const activeAt = steps.findIndex((step) => !step.done)
    const active = steps[Math.max(0, activeAt)]

    /*
     * The whole run, above the one step the card is about.
     *
     * Done is what the project's own files say is finished, not a cursor
     * somebody advanced — the same source the card reads — so the rail cannot
     * disagree with the card about where you are.
     */
    rail.replaceChildren()
    for (const [at, item] of steps.entries()) {
      const { root: tick, el: bits } = mountRow('stepper-tick')
      const state = item.done ? 'done' : at === Math.max(0, activeAt) ? 'now' : 'todo'
      tick.dataset.state = state
      tick.title = item.title
      bits.icon.setAttribute('name', state === 'done' ? 'checkmark-circle-02' : state === 'now' ? 'record' : 'circle')
      bits.label.textContent = item.label
      rail.append(tick)
    }

    const step = mountRow('workflow-step')
    step.el.eyebrow.textContent = `Step ${activeAt + 1} of ${steps.length}`
    step.el.title.textContent = active.title
    step.el.body.textContent = active.body
    step.el.state.textContent = active.done ? 'Complete' : active.inProgress ? 'In progress' : 'Up next'
    step.el.detail.textContent = ` · ${active.detail}`
    const { progress, proceed } = step.el
    /* The stage's own icon, from the one list that already names one per view —
       a second list would be a second answer to what Record looks like. */
    const stageIcon = WORKFLOW_STAGES.find((stage) => stage.view === active.view)?.icon
    if (stageIcon) step.el.icon.setAttribute('name', stageIcon)
    /* The label, not the button: the button's text is rewritten on every draw
       and setting textContent on it would take the icon with it. */
    step.el.proceedLabel.textContent = active.action
    const openCanvas = async () => {
      const plan = interview?.state?.plan
      const scriptBrief = script ? { name: script.name, body: script.body ?? '', drafted: script.mtime ?? null } : null
      const response = await fetch('/api/board/slots', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: currentProject(), brief: { ...plan, script: scriptBrief } }),
      }).catch((err) => ({ error: err.message }))
      if (response.error) return (progress.textContent = response.error)
      const result = await responseJson(response)
      if (!response.ok || result.error) return (progress.textContent = result.error || `Studio returned ${response.status}.`)
      go('storyboard')
    }
    const draftScript = async () => {
      const brief = interview?.state?.plan
      const about = [brief?.about, ...(brief?.shots ?? []).map((shot) => `${shot.name}: ${shot.intent}`)].filter(Boolean).join('\n')
      const seconds = Number(brief?.seconds) || (brief?.shots ?? []).reduce((total, shot) => total + (Number(shot.seconds) || 0), 0) || 30
      proceed.disabled = true
      progress.textContent = 'Claude is drafting the script in the background.'
      const response = await fetch('/api/script/draft', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: currentProject(), name: 'video-draft', seconds, about }),
      }).catch((err) => ({ error: err.message }))
      if (response.error) {
        proceed.disabled = false
        progress.textContent = response.error
        return
      }
      const result = await responseJson(response)
      if (!response.ok || result.error) {
        proceed.disabled = false
        progress.textContent = result.error || `Studio returned ${response.status}.`
        return
      }
      const job = await start(result.step, { openConsole: false })
      if (!job) return
      const check = async () => {
        const jobs = await fetch('/api/jobs')
          .then((response) => response.json())
          .catch(() => null)
        const current = jobs?.jobs?.find((item) => item.id === job.id)
        if (!current || current.running) return setTimeout(check, 1200)
        if (current.code !== 0) {
          proceed.disabled = false
          progress.textContent = 'The script draft stopped. Console has the details.'
          return
        }
        await load()
        go('scripts')
      }
      void check()
    }
    if (active.id === 'script' && hasPlan && !scripts.length) {
      step.el.proceedLabel.textContent = 'Draft a script from this plan'
      proceed.onclick = draftScript
    } else if (active.id === 'canvas' && script && !hasCanvas) {
      step.el.proceedLabel.textContent = 'Build the canvas from this script'
      proceed.onclick = openCanvas
    } else {
      proceed.onclick = () => go(active.view)
    }
    step.el.editor.hidden = !videos.length
    step.el.editor.onclick = () => go('editor')
    /* Where you actually left off, when that is not the card being recommended.
       "progress saved at edit" said this as a cryptic suffix; a button says it
       as a way back. */
    const resumeView = workflow?.currentStage ? WORKFLOW_VIEW_BY_STAGE[workflow.currentStage] : null
    const resumeStep = steps.find((item) => item.view === resumeView)
    if (resumeStep && resumeStep.view !== active.view) {
      step.el.resume.hidden = false
      step.el.resume.textContent = `Resume at ${resumeStep.label}`
      step.el.resume.onclick = () => go(resumeStep.view)
    }
    const { restart } = step.el
    restart.onclick = async () => {
      const copy = 'Start this video over? Its interview, scripts, canvas, scenes and paper edits will be archived inside this project. Your uploaded footage and renders will stay exactly where they are.'
      if (!confirm(copy)) return
      restart.disabled = true
      tone(progress, 'ok')
      progress.textContent = 'Archiving this video’s working files…'
      const response = await fetch('/api/workflow/restart', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: currentProject() }),
      }).catch((err) => ({ error: err.message }))
      const result = response.error ? response : await responseJson(response)
      if (result.error) {
        restart.disabled = false
        tone(progress, 'bad')
        progress.textContent = result.error
        return
      }
      tone(progress, 'ok')
      progress.textContent = result.archive ? `Started over. Previous work is archived in ${result.archive}.` : 'Started over. This project had no working files to archive.'
      await load()
      go('interview')
    }
    panel.replaceChildren(step.root)
  }

  const loadWorkflow = async () => {
    const id = encodeURIComponent(currentProject() ?? '')
    const [interview, board, workflow, assembly, alignment] = await Promise.all([read(`/api/interview?project=${id}`), read(`/api/board?project=${id}`), read(`/api/workflow?project=${id}`), read(`/api/multi-assembly?project=${id}`), read(`/api/multi-assembly/audio-align?project=${id}`)])
    draw({ interview, board, workflow: workflow?.workflow ?? null, assembly, alignment })
  }
  void loadWorkflow()
}

/* ── Interview ───────────────────────────────────────────── */

function vInterview(m) {
  const ui = mountPanel('interview', m)
  const { skillHint, answer, answerGroup, status } = ui

  let state = null
  /* Kept beside the state so the question bar can say how many more this will
     ever ask without restating the server's budget as a second constant. */
  let phase = null
  let skills = null
  const say = (message, level = '') => says(status, message, level)
  const request = async (path, body = {}) => {
    const projectId = currentProject()
    const url = path ? `/api/interview${path}` : `/api/interview?project=${encodeURIComponent(projectId ?? '')}`
    const response = await fetch(url, {
      method: path ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json' },
      body: path ? JSON.stringify({ projectId, ...body }) : undefined,
    }).catch((err) => ({ error: err.message }))
    if (response.error) return response
    const raw = await response.text()
    try {
      return JSON.parse(raw)
    } catch {
      return { error: response.status === 404 ? 'Studio needs a restart to load Interview.' : raw || `Studio returned ${response.status}.` }
    }
  }

  const startFresh = async () => {
    const r = await request('/start')
    if (r.error) return say(r.error, 'bad')
    state = r.state
    phase = r.phase ?? phase
    answer.value = ''
    render()
  }

  const loadReply = async ({ quiet = false } = {}) => {
    const r = await request('/next')
    if (r.error) {
      if (!quiet) say(r.error, 'bad')
      return false
    }
    state = r.state
    phase = r.phase ?? phase
    answer.value = ''
    render()
    if (state.plan) say(`${r.board?.slots?.length ?? state.plan.shots?.length ?? 0} canvas scenes are ready from this plan. Continue to the script, or open any scene on the canvas to refine it.`, 'ok')
    return true
  }

  const watchReply = (job, misses = 0) => {
    const check = async () => {
      // The reply file is the handoff, not the running job record. A Studio
      // reload restarts the server and loses the in-memory record, but the agent
      // can still finish and leave a valid next question in the project.
      if (await loadReply({ quiet: true })) return
      const data = await fetch('/api/jobs')
        .then((response) => response.json())
        .catch(() => null)
      const current = data?.jobs?.find((item) => item.id === job.id)
      if (!current || current.running) return setTimeout(check, 1200)
      if (current.code !== 0) return say('Claude stopped before it could finish this question. Console has the details.', 'bad')
      const fresh = await request('')
      if (!fresh.error && !fresh.state?.pendingReply) {
        state = fresh.state
        answer.value = ''
        render()
        return
      }
      // Claude has stopped, but files can flush just after the last job event.
      // Keep looking at the durable reply rather than leaving the page stranded.
      // A completed job without the durable handoff cannot become a question by
      // waiting forever. Give the final file flush a short grace period, then
      // make the failure actionable instead of trapping the interview in "Load".
      if (misses >= 12) return say('Claude finished without saving the next question. Check the job details, then submit the answer again.', 'bad')
      return setTimeout(() => watchReply(job, misses + 1), 350)
    }
    void check()
  }

  const sendAnswer = async () => {
    if (!state?.turns?.length) {
      const started = await request('/start')
      if (started.error) return say(started.error, 'bad')
      state = started.state
    phase = started.phase ?? phase
    }
    const r = await request('/answer', { answer: answer.value })
    if (r.error) return say(r.error, 'bad')
    state = r.state
    phase = r.phase ?? phase
    render()
    say('Claude is shaping the next question in the background.', 'ok')
    const job = await start(r.step, { openConsole: false })
    if (job) watchReply(job)
  }

  const render = () => {
    const parts = [ui.progress, ui.questionCount, ui.questionTitle, ui.questionHint, ui.shots, ui.problems]
    /* The plan's bordered box only exists when the plan does — empty, it read
       as an unlabeled field under the Submit button. */
    ui.planBox.hidden = !state?.plan
    const buttons = [ui.submit, ui.loadReply, ui.continueScript, ui.openCanvas, ui.startOver]
    for (const node of [...parts, ...buttons]) node.hidden = true
    ui.shots.replaceChildren()
    /*
     * The bar fills toward the ceiling, not toward a target.
     *
     * interviewState reports what is LEFT rather than a fraction, and its own
     * comment says why: an interview ends when the plan is ready, which can be
     * before the budget runs out. So reaching the end of this bar is not the
     * goal — it is how much more this will ever ask.
     */
    /* Derived, not declared: `asked + left` IS the ceiling, and the server
       already sends both. Restating 6 here meant two numbers that had to agree
       forever, and the budget is the kind of thing that gets tuned. */
    const ceiling = () => Math.max(1, (phase?.asked ?? state?.turns?.length ?? 1) + (phase?.left ?? 0))
    const ask = (count, title, at = null) => {
      ui.progress.hidden = at == null
      if (at != null) {
        const rungs = Math.max(at, ceiling())
        ui.progress.replaceChildren()
        ui.progress.title = `Question ${at} of at most ${rungs}`
        for (let n = 1; n <= rungs; n += 1) {
          const { root: tick, el: bits } = mountRow('stepper-tick')
          const state = n < at ? 'done' : n === at ? 'now' : 'todo'
          tick.dataset.state = state
          bits.icon.setAttribute('name', state === 'done' ? 'checkmark-circle-02' : state === 'now' ? 'record' : 'circle')
          /* Numbered, not named: a question has no label until it is asked, and
             the workflow's stages do. Same stepper, different rung. */
          bits.label.textContent = String(n)
          ui.progress.append(tick)
        }
      }
      ui.questionCount.hidden = !count
      if (count) ui.questionCount.textContent = count
      ui.questionTitle.hidden = false
      ui.questionTitle.textContent = title
      /* The interview is open-ended — Claude stops when it has enough — so the
         honest denominator is a shape, not a number. */
      if (count) {
        ui.questionHint.hidden = false
        ui.questionHint.textContent = 'A handful of questions, usually five or six. Claude drafts the plan as soon as it has enough.'
      }
    }
    if (!state?.turns?.length) {
      ask('Question 1', 'What is this video for, and who watches it?', 1)
      answerGroup.hidden = false
      answer.disabled = false
      ui.submit.hidden = false
      ui.submit.onclick = sendAnswer
      return
    }

    if (state.plan) {
      answerGroup.hidden = true
      ask(null, 'Shot list ready')
      ui.questionHint.hidden = false
      ui.questionHint.textContent = state.plan.about || 'Claude has turned the conversation into a first plan.'
      ui.shots.hidden = false
      for (const shot of state.plan.shots ?? []) {
        const line = mountRow('interview-shot')
        line.el.name.textContent = shot.name
        line.el.intent.textContent = shot.intent ? ` — ${shot.intent}` : ''
        line.el.seconds.hidden = !shot.seconds
        if (shot.seconds) line.el.seconds.textContent = `${shot.seconds}s`
        ui.shots.append(line.root)
      }
      if (state.problems?.length) {
        ui.problems.hidden = false
        ui.problems.textContent = state.problems.join(' ')
      }
      // "Continue to script" names a destination. Sending it through the
      // workflow's "next unfinished" calculation made an older canvas or
      // recording skip Script entirely and show a later numbered step instead.
      ui.continueScript.hidden = false
      ui.continueScript.onclick = () => go('scripts')
      ui.openCanvas.hidden = false
      ui.openCanvas.onclick = () => go('storyboard')
      ui.startOver.hidden = false
      ui.startOver.onclick = startFresh
      return
    }

    const turn = state.turns.at(-1)
    ask(`Question ${state.turns.length}`, turn.question, state.turns.length)
    answerGroup.hidden = false
    answer.value = turn.answer ?? ''
    if (state.pendingReply) {
      answer.disabled = true
      ui.loadReply.hidden = false
      ui.loadReply.onclick = () => void loadReply()
      return
    }
    answer.disabled = false
    ui.submit.hidden = false
    ui.submit.onclick = sendAnswer
  }

  const load = async () => {
    const r = await request('')
    if (r.error) return say(r.error, 'bad')
    state = r.state
    phase = r.phase ?? phase
    skills = Array.isArray(r.skills) ? r.skills : null
    skillHint.textContent = skills == null ? 'Shared skills are available, but this Studio server needs a restart before Interview can list and use them.' : skills.length ? `This interview is using shared skills: ${skills.map((skill) => skill.name).join(' · ')}.` : 'No shared skills are installed yet. Add one from Toolkit → Skills.'
    render()
  }
  void load()
}

/* Several project recordings become one reviewable, editable assembly. */
function vMultiAssembly(m) {
  const requestedAssemblyRevision = pendingAssemblyRevision
  pendingAssemblyRevision = false
  const ui = mountPanel('multi-assembly', m)
  const project = currentProjectRecord()
  const videos = (project?.catalog?.files ?? []).filter((file) => file.kind === 'video')
  const audios = (project?.catalog?.files ?? []).filter((file) => file.kind === 'audio')
  ui.switchMode.onclick = () => {
    assemblyMode = 'single'
    render()
  }
  const review = mountRow('multi-assembly-review').root
  if (!videos.length) {
    ui.noVideos.hidden = false
    return
  }

  const status = control('hint', { hidden: true })
  const updateSources = ui.updateSources
  const sourceList = ui.sourceList
  ui.sourceHeader.hidden = false
  ui.prepareHint.hidden = false
  sourceList.hidden = false
  ui.setup.hidden = false
  const checks = new Map()
  const sourceCards = new Map()
  for (const file of videos) {
    const { root: label, el: source } = mountRow('assembly-source')
    const input = Object.assign(source.input, { value: file.rel })
    source.thumb.style.backgroundImage = `url('/thumb/${encodeURIComponent(project.id)}/${encodeURI(file.rel)}')`
    source.meta.textContent = dur(file.durationSec) || 'video'
    const readiness = source.readiness
    source.name.textContent = file.name
    input.onchange = () => {
      if ([...checks.values()].filter((item) => item.checked).length > 8) {
        input.checked = false
        says(status, 'An assembly can use up to eight recordings at a time.', 'bad')
      }
      syncSourceSetControl()
    }
    sourceList.append(label)
    checks.set(file.rel, input)
    sourceCards.set(file.rel, readiness)
  }

  const notes = control('textarea', { rows: 2, placeholder: 'Optional direction for Claude: lead with the customer problem, keep the side camera only for the close…' })
  const projectScripts = (S.scripts ?? []).filter((item) => item.project === currentProject())
  const scriptSelect = ui.scriptSelect
  scriptSelect.append(new Option('Best-parts assembly — do not match a script', ''))
  for (const item of projectScripts) scriptSelect.append(new Option(item.name, item.name))
  if (projectScripts.length === 1) scriptSelect.value = projectScripts[0].name
  ui.scriptGroup.hidden = !projectScripts.length
  const setup = ui.setup
  const transcriptCut = smallSwitch(setup, 'Trim selected recordings from their transcripts')
  transcriptCut.title = 'Claude uses each recording’s own timed transcript to make clean, reviewable spoken trims. It can be combined with a script match.'
  const assemble = control('button', { className: 'btn btn--primary', textContent: 'Match the script with Claude' })
  const stackSources = control('button', { className: 'btn ghost', textContent: 'Stack selected recordings' })
  const buildTimeline = control('button', { className: 'btn btn--primary', textContent: 'Build the first cut', hidden: true })
  const openTimeline = control('button', { className: 'btn btn--primary', textContent: 'Open first cut in HyperFrames', hidden: true })
  const renderAndShare = control('button', { className: 'btn btn--primary', textContent: 'Render & send for review', hidden: true })
  const actions = mountRow('control-row').root
  actions.append(assemble, stackSources)
  setup.append(notes, control('hint', { textContent: 'Studio saves the selected clips immediately, runs only the missing transcript and screen-analysis jobs, then asks Claude for the strongest supporting moments. Turn on transcript trims when you want clean spoken cuts from each source’s own timed words. Review those selections below; building the first cut adds the opening title and closing screen automatically.' }), actions, status)

  const setAssemblyAction = () => {
    const matchingScript = Boolean(scriptSelect.value)
    assemble.textContent = matchingScript
      ? transcriptCut.checked ? 'Find & trim script takes with Claude' : 'Match the script with Claude'
      : transcriptCut.checked ? 'Cut from transcripts with Claude' : 'Make a best-parts assembly with Claude'
  }
  scriptSelect.onchange = setAssemblyAction
  transcriptCut.onchange = setAssemblyAction
  setAssemblyAction()

  const { root: align, el: aligner } = mountRow('assembly-align')
  const { screen, audio, script } = aligner
  for (const file of videos) screen.append(new Option(file.name, file.rel))
  audio.append(new Option(audios.length ? 'Choose project audio…' : 'No project audio yet', ''))
  for (const file of audios) audio.append(new Option(file.name, file.rel))
  script.append(new Option('Use the audio transcript', ''))
  for (const item of (S.scripts ?? []).filter((entry) => entry.project === currentProject())) script.append(new Option(`Use script: ${item.name}`, item.name))
  const alignButton = aligner.build
  alignButton.disabled = !audios.length
  const openAlignedTimeline = control('button', { className: 'btn ghost btn--small', textContent: 'Open in HyperFrames', hidden: true })
  const reviewAlignedVideo = control('button', { className: 'btn ghost btn--small', textContent: 'Review rendered video', hidden: true })
  const renderAligned = control('button', { className: 'btn btn--primary btn--small', textContent: 'Render audio review video', hidden: true })
  const alignRow = aligner.row
  // A collapsed empty section still paints its two divider lines. Only show this
  // second workflow when this project actually has audio to line up.
  if (audios.length) m.append(align)

  const alignmentReview = mountRow('multi-assembly-alignment-review').root
  let state = null
  let alignment = null
  let transcriptCues = {}
  let activePickId = null
  let commentTimer = null
  const selected = () => [...checks.entries()].filter(([, input]) => input.checked).map(([rel]) => rel)
  const sameSourceSet = (a, b) => a.length === b.length && a.every((rel) => b.includes(rel))
  const syncSourceSetControl = () => {
    const hasStarted = Boolean(state?.sources?.length)
    const changed = hasStarted && !sameSourceSet(selected(), state.sources)
    updateSources.hidden = !hasStarted
    updateSources.disabled = !changed
  }
  const say = (text, level = '') => says(status, text, level)
  const request = async (path, body = {}) => {
    const response = await fetch(`/api/multi-assembly${path}`, { method: path ? 'POST' : 'GET', headers: path ? { 'content-type': 'application/json' } : undefined, body: path ? JSON.stringify({ projectId: currentProject(), ...body }) : undefined }).catch((error) => ({ error: error.message }))
    return response.error ? response : responseJson(response)
  }
  const paint = () => {
    if (!review.isConnected) m.insertBefore(review, ui.sourceHeader)
    review.replaceChildren()
    if (!state?.picks?.length) {
      const hasSources = Boolean(state?.sources?.length)
      const hasTimeline = Boolean(state?.hyperframesProject)
      if (!hasSources) return
      const { root: recovery, el: recover } = mountRow('assembly-recovery')
      const gaps = state?.gaps ?? []
      const copy = hasTimeline
        ? 'The selected recordings are stacked in HyperFrames. Open the assembly to trim and reorder the source clips, or make a new Claude pass if you want a different first cut.'
        : gaps.length
        ? `No script lines were located in these recordings. ${gaps.length} missing line${gaps.length === 1 ? '' : 's'} remain visible below; make another pass after adding the right take.`
        : hasSources
        ? 'The last pass saved these source recordings, but it did not leave any timestamped selects to review. Start a new pass, or stack the recordings into a HyperFrames assembly and make the first cut yourself.'
        : 'Choose project recordings above, then either ask Claude for a first cut or stack them into a HyperFrames assembly yourself.'
      recover.title.textContent = hasTimeline ? 'HyperFrames assembly ready' : gaps.length ? 'No matching recorded lines yet' : 'Assembly needs another pass'
      recover.copy.textContent = copy
      if (gaps.length) {
        recover.gaps.hidden = false
        for (const gap of gaps) recover.gaps.append(control('span', { textContent: `${gap.beatId} · ${gap.beat}${gap.reason ? ` — ${gap.reason}` : ''}` }))
      }
      if (hasTimeline) recover.actions.prepend(openTimeline)
      recover.retry.onclick = () => void runAssembly()
      review.append(recovery)
      return
    }
    const { root: head, el: headBits } = mountRow('assembly-head')
    const reviewApproved = Boolean(state.reviewApprovedAt && state.hyperframesProject)
    const nextStep = reviewApproved
      ? 'The first cut includes an opening title, the selected clips, and a closing screen. Open it in HyperFrames to adjust it before rendering.'
      : 'Review each passage below. Remove or comment on anything that is not right, then build the first cut — Studio adds an opening title and closing screen automatically.'
    headBits.title.textContent = state.title || 'Claude’s assembly'
    headBits.next.textContent = `${state.picks.length} selected clips · ${nextStep}`
    if (state.scriptBeats?.length) {
      const scriptStatus = headBits.beats
      scriptStatus.hidden = false
      const pickedIds = new Set(state.picks.map((pick) => pick.beatId).filter(Boolean))
      const gapsById = new Map((state.gaps ?? []).map((gap) => [gap.beatId, gap]))
      for (const beat of state.scriptBeats) {
        const item = mountRow('assembly-beat').root
        item.textContent = `${beat.id} · ${beat.text}`
        const gap = gapsById.get(beat.id)
        item.classList.toggle('multi-assembly__script-beat--matched', pickedIds.has(beat.id))
        item.classList.toggle('multi-assembly__script-beat--missing', Boolean(gap))
        item.title = gap?.reason || (pickedIds.has(beat.id) ? 'Matched to recorded speech' : 'Not yet matched')
        scriptStatus.append(item)
      }
    }
    headBits.revise.onclick = () => void runAssembly(true)
    headBits.newPass.onclick = () => void runAssembly()
    const reviewActions = headBits.actions
    if (!buildTimeline.hidden) reviewActions.append(buildTimeline)
    if (!openTimeline.hidden) reviewActions.append(openTimeline)
    if (!renderAndShare.hidden) reviewActions.append(renderAndShare)
    review.append(head)
    /*
     * One audible player, one sequence, and the transcript alongside it.
     *
     * The old grid made every source a little muted video. You had to guess
     * which one was first in the edit, unmute that one, then remember its words
     * while trying another card. The assembly now behaves like a review edit:
     * the sequence is visible, one selected passage owns playback, and the
     * matching caption lines are marked beside the actual frame.
     */
    const { root: picks, el: surface } = mountRow('assembly-review')
    const selectedPick = state.picks.find((pick) => pick.id === activePickId) ?? state.picks[0]
    activePickId = selectedPick.id
    const timeline = surface.timeline
    const player = surface.player
    // These previews begin from a user-selected clip, not autoplay. Do not mute
    // them: a talking-head or narrated screen recording without sound is not a
    // reviewable edit.
    player.muted = false
    player.defaultMuted = false
    player.volume = 1
    const { selectedLabel, selectedText, selectedReason, playSelection, removeSelection, comment } = surface
    comment.oninput = () => {
      window.clearTimeout(commentTimer)
      commentTimer = window.setTimeout(async () => {
        const saved = await request('/comments', { pickId: current.id, comment: comment.value })
        if (!saved.error) state = saved.state
      }, DRAFT_SAVE_MS)
    }
    const transcriptName = surface.transcriptName
    const transcriptLines = surface.transcriptLines

    const pickButtons = new Map()
    let cueRows = []
    let visibleCue = null
    let current = selectedPick
    let stopAtSelection = false

    const seek = (at, { play = false, selectionOnly = false } = {}) => {
      const move = () => {
        try {
          stopAtSelection = selectionOnly
          player.currentTime = Math.max(0, at)
          if (play) player.play().catch(() => {})
        } catch {}
      }
      if (player.readyState >= 1) move()
      else player.addEventListener('loadedmetadata', move, { once: true })
    }

    playSelection.onclick = () => seek(current.inSec, { play: true, selectionOnly: true })
    removeSelection.onclick = async () => {
      removeSelection.disabled = true
      const removed = await request('/remove', { pickId: current.id })
      removeSelection.disabled = false
      if (removed.error) return say(removed.error, 'bad')
      state = removed.state
      activePickId = state.picks?.[0]?.id ?? null
      await refresh()
      say('Removed from this assembly. The source recording is still in the project.', 'ok')
    }

    const centerCue = (row) => {
      const offset = row.offsetTop - transcriptLines.offsetTop
      transcriptLines.scrollTop = Math.max(0, offset - (transcriptLines.clientHeight - row.offsetHeight) / 2)
    }

    const paintTranscript = () => {
      transcriptLines.replaceChildren()
      cueRows = []
      let selectedRow = null
      transcriptName.textContent = current.source.split('/').pop()
      const cues = transcriptCues[current.source] ?? []
      if (!cues.length) {
        transcriptLines.append(control('hint', { textContent: 'The source transcript is not available yet. Prepare this clip again to attach it.' }))
        return
      }
      for (const cue of cues) {
        const { root: line, el: cueBits } = mountRow('assembly-cue')
        const selected = Number(cue.endSec) > current.inSec && Number(cue.startSec) < current.outSec
        line.classList.toggle('multi-assembly__transcript-line--selected', selected)
        line.dataset.start = String(cue.startSec)
        line.dataset.end = String(cue.endSec)
        const copy = cueBits.copy
        copy.textContent = cue.text
        if (selected && !selectedRow) copy.append(mountRow('assembly-badge').root)
        cueBits.time.textContent = dur(cue.startSec)
        line.onclick = () => seek(Number(cue.startSec), { play: true })
        transcriptLines.append(line)
        cueRows.push(line)
        if (selected) selectedRow = line
      }
      if (selectedRow) centerCue(selectedRow)
    }

    const paintCurrent = ({ play = false } = {}) => {
      selectedLabel.textContent = `${current.beatId ? `${current.beatId} · ` : ''}Claude selected ${state.picks.findIndex((pick) => pick.id === current.id) + 1}. ${current.source.split('/').pop()} · ${dur(current.inSec)}–${dur(current.outSec)}`
      selectedText.textContent = current.spokenText || current.text ? `“${current.spokenText || current.text}”` : 'Selected passage'
      selectedReason.textContent = current.reason || 'Selected passage'
      comment.value = state.comments?.[current.id] ?? ''
      player.src = `/media/${encodeURIComponent(currentProject() ?? '')}/${encodeURI(current.source)}`
      player.load()
      for (const [id, button] of pickButtons) button.classList.toggle('multi-assembly__timeline-pick--active', id === current.id)
      paintTranscript()
      seek(current.inSec, { play, selectionOnly: play })
    }

    player.addEventListener('timeupdate', () => {
      if (stopAtSelection && player.currentTime >= current.outSec) {
        player.pause()
        player.currentTime = current.inSec
        stopAtSelection = false
      }
      let playingRow = null
      for (const row of cueRows) {
        const at = Number(row.dataset.start)
        const end = Number(row.dataset.end)
        const playing = player.currentTime >= at && player.currentTime < end
        row.classList.toggle('multi-assembly__transcript-line--playing', playing)
        if (playing) playingRow = row
      }
      if (playingRow && playingRow !== visibleCue) {
        visibleCue = playingRow
        centerCue(playingRow)
      }
    })
    for (const [index, pick] of state.picks.entries()) {
      const duration = Math.max(0.25, Number(pick.outSec) - Number(pick.inSec))
      const { root: segment, el: pickBits } = mountRow('assembly-pick')
      segment.style.setProperty('--assembly-pick-duration', String(duration))
      pickBits.number.textContent = String(index + 1)
      pickBits.label.textContent = pick.source.split('/').pop()
      pickBits.time.textContent = `${dur(pick.inSec)}–${dur(pick.outSec)}`
      segment.onclick = () => {
        activePickId = pick.id
        current = pick
        paintCurrent({ play: true })
      }
      pickButtons.set(pick.id, segment)
      timeline.append(segment)
    }
    /*
     * Fillers the cut opens on, offered beside the clips they belong to.
     *
     * Found server-side from the word timings when the cut was built. Cutting
     * "Okay," off the front of a take is an editorial call, so it is one click
     * here rather than a silent trim — but finding it is not, so nobody has to
     * scrub for it.
     */
    const fillers = Array.isArray(state.fillers) ? state.fillers.filter((item) => state.picks.some((pick) => pick.id === item.pickId)) : []
    if (fillers.length) {
      const offer = surface.fillers
      offer.hidden = false
      surface.fillersHint.textContent = `${fillers.length} clip${fillers.length === 1 ? ' opens' : 's open'} on a filler word. Trim it, or keep it.`
      for (const item of fillers) {
        const number = state.picks.findIndex((pick) => pick.id === item.pickId) + 1
        const { root: row, el: fillerBits } = mountRow('assembly-filler')
        fillerBits.text.textContent = `${number}. ${item.speaker ? `${item.speaker} — ` : ''}“${item.text}” before “${item.followedBy}” · ${(item.trimToSec - item.startSec).toFixed(2)}s`
        const trim = fillerBits.trim
        setLabel(trim, `Trim “${item.text}”`)
        trim.onclick = async () => {
          trim.disabled = true
          const r = await request('/trim', { pickId: item.pickId, inSec: item.trimToSec })
          if (r.error) {
            trim.disabled = false
            return say(r.error, 'bad')
          }
          await refresh()
          say(`Trimmed “${item.text}” off the front of clip ${number}. Build the first cut again to carry it into HyperFrames.`, 'ok')
        }
        offer.append(row)
      }
    }
    review.append(picks)
    paintCurrent()
  }
  const paintAlignment = () => {
    alignmentReview.replaceChildren()
    if (!alignment?.hyperframesProject || !alignment?.segments?.length) {
      alignmentReview.remove()
      return
    }

    // Do not reserve an empty, bordered review region before an alignment exists.
    if (!alignmentReview.isConnected) m.insertBefore(alignmentReview, review)

    // The agent's work is an edit to review, not an invisible file in Renders.
    // Keep the original screen recording visible here and let each mapped row
    // seek it, so the reason, spoken interval, and actual evidence stay together.
    align.open = true
    openAlignedTimeline.hidden = false
    renderAligned.hidden = false
    reviewAlignedVideo.hidden = !alignment.rendered
    const { nodes, el: aligned } = mountRow('assembly-alignment')
    aligned.title.textContent = `Visual alignment · ${alignment.segments.length} screen cuts`
    aligned.actions.append(openAlignedTimeline, reviewAlignedVideo, renderAligned)
    const player = aligned.player
    player.muted = false
    player.defaultMuted = false
    player.volume = 1
    player.src = `/media/${encodeURIComponent(currentProject() ?? '')}/${encodeURI(alignment.videoRel)}`
    const cuts = aligned.cuts
    for (const [index, segment] of alignment.segments.entries()) {
      const { root: cut, el: cutBits } = mountRow('assembly-alignment-cut')
      cutBits.range.textContent = `${dur(segment.audioInSec)}–${dur(segment.audioOutSec)}`
      cutBits.screen.textContent = `Screen ${dur(segment.screenInSec)}–${dur(segment.screenOutSec)}`
      cutBits.reason.textContent = segment.reason || 'Mapped screen moment'
      cutBits.number.textContent = String(index + 1)
      cut.onclick = () => {
        for (const item of cuts.querySelectorAll('.multi-assembly__alignment-cut')) item.classList.remove('multi-assembly__alignment-cut--active')
        cut.classList.add('multi-assembly__alignment-cut--active')
        try {
          player.currentTime = segment.screenInSec
          player.play().catch(() => {})
        } catch {}
      }
      cuts.append(cut)
    }
    alignmentReview.append(...nodes)
  }
  const refresh = async () => {
    const result = await fetch(`/api/multi-assembly?project=${encodeURIComponent(currentProject() ?? '')}`)
      .then(responseJson)
      .catch((error) => ({ error: error.message }))
    if (result.error) return say(result.error, 'bad')
    state = result.state
    transcriptCues = result.transcripts ?? {}
    for (const rel of state?.sources ?? []) if (checks.has(rel)) checks.get(rel).checked = true
    for (const [rel, readiness] of sourceCards) {
      const prepared = (result.preparation ?? []).find((item) => item.rel === rel)
      const ready = Boolean(prepared?.transcript && prepared?.visual)
      readiness.textContent = ready ? 'Transcript + screen ready' : prepared?.transcript ? 'Transcript ready' : prepared?.visual ? 'Screen ready' : 'Not prepared'
      readiness.classList.toggle('multi-assembly__source-ready--done', ready)
      readiness.title = ready ? '' : 'Tick this recording and press “Update selected recordings” to transcribe it and sample its screen.'
    }
    notes.value = state?.notes ?? ''
    if (state?.scriptName && [...scriptSelect.options].some((option) => option.value === state.scriptName)) scriptSelect.value = state.scriptName
    transcriptCut.checked = Boolean(state?.transcriptCut)
    setAssemblyAction()
    const reviewApproved = Boolean(state?.reviewApprovedAt && state?.hyperframesProject)
    // A Claude pass is a candidate cut, not permission to create or render the
    // review composition. Keep HyperFrames and sharing behind this one explicit
    // approval so the person can examine every selected passage first.
    buildTimeline.hidden = !state?.picks?.length || reviewApproved
    openTimeline.hidden = !reviewApproved
    // Opening the editable cut is the review step. Do not make rendering look
    // like the next move until someone has actually reached that surface.
    renderAndShare.hidden = !(reviewApproved && state?.reviewOpenedAt)
    syncSourceSetControl()
    paint()
    const aligned = await fetch(`/api/multi-assembly/audio-align?project=${encodeURIComponent(currentProject() ?? '')}`)
      .then(responseJson)
      .catch((error) => ({ error: error.message }))
    if (!aligned.error && aligned.state?.hyperframesProject) {
      alignment = { ...aligned.state, renderStep: aligned.renderStep, rendered: aligned.rendered }
      paintAlignment()
    }
  }
  const build = async () => {
    const label = buildTimeline.textContent
    buildTimeline.disabled = true
    buildTimeline.textContent = 'Building the first cut…'
    say('Building the first cut with an opening title, selected clips, and closing screen…', 'ok')
    const made = await request('/build')
    if (made.error) {
      buildTimeline.disabled = false
      buildTimeline.textContent = label
      return say(`Could not build the first cut: ${made.error}`, 'bad')
    }
    await refresh()
    say(`${made.selections ?? state?.picks?.length ?? 0} selected clips plus an opening title and closing screen are ready.${trimNote(made.trimmed)}${made.fillers?.length ? ` ${made.fillers.length} clip${made.fillers.length === 1 ? ' opens' : 's open'} on a filler word — see below.` : ''} Open the first cut in HyperFrames; rendering stays locked until you have reviewed it.`, 'ok')
  }
  const stackSelected = async () => {
    const rels = selected()
    if (!rels.length) return say('Choose at least one project recording.', 'bad')
    stackSources.disabled = true
    const made = await request('/stack', { rels })
    stackSources.disabled = false
    if (made.error) return say(made.error, 'bad')
    await refresh()
    say(`${made.clips} recordings are stacked in an editable HyperFrames assembly.`, 'ok')
  }
  const saveSourceSet = async () => {
    const rels = selected()
    if (!rels.length) return say('Keep at least one recording in the assembly.', 'bad')
    updateSources.disabled = true
    say('Saving the recording set and preparing any new clips in the background…', 'ok')
    const prepared = await request('/prepare', { rels, notes: notes.value, scriptName: scriptSelect.value, transcriptCut: transcriptCut.checked })
    if (prepared.error) {
      updateSources.disabled = false
      return say(prepared.error, 'bad')
    }
    const jobs = (await Promise.all((prepared.steps ?? []).map(({ step }) => start(step, { status })))).filter(Boolean)
    if (!jobs.length) {
      await refresh()
      return say('Recording set updated. Run a new Claude pass when you are ready.', 'ok')
    }
    let left = jobs.length
    let failed = false
    for (const job of jobs) {
      watchJobInPlace(job, status, async (finished) => {
        if (finished?.code !== 0) failed = true
        if (--left !== 0) return
        updateSources.disabled = false
        await refresh()
        say(failed ? 'The recording set was saved, but one or more new clips could not be prepared.' : 'Recording set updated. Run a new Claude pass when you are ready.', failed ? 'bad' : 'ok')
      })
    }
  }
  const runAssembly = async (revision = false) => {
    const rels = revision ? (state?.sources ?? selected()) : selected()
    if (!rels.length) return say('Choose at least one project recording.', 'bad')
    assemble.disabled = true
    const askClaude = async () => {
      const matchingScript = Boolean(scriptSelect.value || state?.scriptName)
      const cuttingFromTranscript = transcriptCut.checked
      say(revision ? 'Claude is revising the selected clips from your comments…' : matchingScript ? cuttingFromTranscript ? 'Claude is finding each script line and trimming the source takes…' : 'Claude is locating each script line in the recordings…' : cuttingFromTranscript ? 'Claude is trimming each selected recording from its own transcript…' : 'Claude is choosing the strongest moments across these recordings…', 'ok')
      const drafted = await request('/draft', { rels, notes: notes.value, scriptName: scriptSelect.value, transcriptCut: cuttingFromTranscript })
      if (drafted.error) {
        assemble.disabled = false
        return say(drafted.error, 'bad')
      }
      const job = await start(drafted.step, { status })
      if (!job) {
        assemble.disabled = false
        return
      }
      watchJobInPlace(job, status, async (finished) => {
        assemble.disabled = false
        if (finished?.code !== 0) return
        const picked = await request('/selection', { rels, fromFile: true })
        if (picked.error) return say(picked.error, 'bad')
        state = picked.state
        await refresh()
        say('Claude’s proposed cuts are ready to review below. Nothing has been sent to HyperFrames or rendered yet.', 'ok')
      })
    }
    if (revision) return askClaude()

    say(`Preparing ${rels.length} recording${rels.length === 1 ? '' : 's'} in the background…`, 'ok')
    const prepared = await request('/prepare', { rels, notes: notes.value, scriptName: scriptSelect.value, transcriptCut: transcriptCut.checked })
    if (prepared.error) {
      assemble.disabled = false
      return say(prepared.error, 'bad')
    }
    const jobs = (await Promise.all((prepared.steps ?? []).map(({ step }) => start(step, { status })))).filter(Boolean)
    if (!jobs.length) return askClaude()
    let left = jobs.length
    let failed = false
    for (const job of jobs) {
      watchJobInPlace(job, status, async (finished) => {
        if (finished?.code !== 0) failed = true
        if (--left !== 0) return
        await refresh()
        if (failed) {
          assemble.disabled = false
          return say('One or more clips could not be prepared. Check its job details, then try again.', 'bad')
        }
        void askClaude()
      })
    }
  }
  buildTimeline.onclick = () => void build()
  assemble.onclick = () => void runAssembly()
  stackSources.onclick = () => void stackSelected()
  updateSources.onclick = () => void saveSourceSet()
  alignButton.onclick = async () => {
    if (!audio.value) return say('Choose the narration audio from this project.', 'bad')
    alignButton.disabled = true
    openAlignedTimeline.hidden = true
    reviewAlignedVideo.hidden = true
    renderAligned.hidden = true
    const prepared = await request('/audio-align/prepare', { videoRel: screen.value, audioRel: audio.value })
    if (prepared.error) {
      alignButton.disabled = false
      return say(prepared.error, 'bad')
    }
    say('Preparing visual evidence and timed narration in the background…', 'ok')
    const jobs = (await Promise.all(prepared.steps.map(({ step }) => start(step, { status })))).filter(Boolean)
    let left = jobs.length
    let failed = false
    if (!left) {
      alignButton.disabled = false
      return
    }
    for (const job of jobs)
      watchJobInPlace(job, status, async (finished) => {
        if (finished?.code !== 0) failed = true
        if (--left !== 0) return
        if (failed) {
          alignButton.disabled = false
          return say('The screen analysis or narration transcription did not finish. Check the job details, then try again.', 'bad')
        }
        say('Claude is mapping the narration to the screen, moment by moment…', 'ok')
        const drafted = await request('/audio-align/draft', { videoRel: screen.value, audioRel: audio.value, scriptName: script.value, notes: notes.value })
        if (drafted.error) {
          alignButton.disabled = false
          return say(drafted.error, 'bad')
        }
        const agentJob = await start(drafted.step, { status })
        if (!agentJob) {
          alignButton.disabled = false
          return
        }
        watchJobInPlace(agentJob, status, async (agentFinished) => {
          alignButton.disabled = false
          if (agentFinished?.code !== 0) return
          const picked = await request('/audio-align/selection', { videoRel: screen.value, audioRel: audio.value, fromFile: true })
          if (picked.error) return say(picked.error, 'bad')
          alignment = picked.state
          const built = await request('/audio-align/build')
          if (built.error) return say(built.error, 'bad')
          alignment = { ...alignment, hyperframesProject: built.hyperframesProject, renderStep: built.renderStep, rendered: false }
          paintAlignment()
          say(`${alignment.segments.length} narration moments are mapped to screen cuts. Review them here, then render the project video when it looks right.`, 'ok')
        })
      })
  }
  openAlignedTimeline.onclick = () => {
    if (alignment?.hyperframesProject) void openHyperframesProject(alignment.hyperframesProject, openAlignedTimeline, status)
  }
  reviewAlignedVideo.onclick = async () => {
    const opened = await openDocument({ projectId: currentProject(), path: alignment?.renderedVideo })
    if (opened?.error) say(opened.error, 'bad')
  }
  renderAligned.onclick = async () => {
    if (!alignment?.renderStep) return say('Build the visual alignment first.', 'bad')
    say('Rendering the reviewed screen cuts with their matching narration…', 'ok')
    await runWithStatus(alignment.renderStep, renderAligned, status, async (finished) => {
      if (finished?.code !== 0) return
      alignment = { ...alignment, rendered: true }
      reviewAlignedVideo.hidden = false
      say('The audio review video is in this project’s renders. Open it here or from the project media.', 'ok')
    })
  }
  openTimeline.onclick = async () => {
    if (!state?.hyperframesProject) return
    const opened = await openHyperframesProject(state.hyperframesProject, openTimeline, status)
    if (!opened) return
    // This survives leaving the editor and returning to Assembly. It is not an
    // approval of the render — only an honest record that the review surface
    // was reached before Studio offers its render-and-share action.
    await request('/opened')
  }
  renderAndShare.onclick = async () => {
    const planned = await request('/render')
    if (planned.error) return say(planned.error, 'bad')
    say('Rendering the branded review cut in the background…', 'ok')
    await runWithStatus(planned.step, renderAndShare, status, async (finished) => {
      if (finished?.code !== 0) return
      const shared = await fetch('/api/review/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: currentProject(), rel: planned.renderedRel, title: planned.title }),
      })
        .then(responseJson)
        .catch((error) => ({ error: error.message }))
      if (shared.error) return say(`Rendered and saved to this project, but could not send for review: ${shared.error}`, 'warn')
      renderAndShare.textContent = 'Open review'
      renderAndShare.onclick = () => go('review')
      await refresh()
      say('Review cut rendered, saved to this project, and sent for review.', 'ok')
    })
  }
  void refresh().then(() => {
    if (requestedAssemblyRevision) void runAssembly(true)
  })
}

/*
 * A paper edit is the shortest useful path from a recording to an editable first
 * cut. It remains available for a single talking-head recording.
 */
function vPaperEdit(m) {
  if (assemblyMode === 'multi') return vMultiAssembly(m)
  const ui = mountPanel('paper-edit', m)
  ui.useMulti.onclick = () => {
    assemblyMode = 'multi'
    render()
  }

  const project = () => S.projects.find((p) => p.id === (currentProject() ?? ''))
  const videos = () => (project()?.catalog?.files ?? []).filter((file) => file.kind === 'video')
  const { form, status } = ui
  const clip = control('select')
  clip.append(new Option('Choose a recording…', ''))
  for (const file of videos()) clip.append(new Option(file.name, file.rel))
  field(form, 'Recording', clip, 'Drop a video on its project page first. The original stays untouched; this creates an editable cut document that points back to it.')

  const transcribe = control('button', { className: 'btn btn--primary', textContent: 'Transcribe recording' })
  transcribe.prepend(icon('text-align-left'))
  const transcriptHint = control('hint')
  const language = control('select')
  language.append(new Option('English', 'en'))
  field(form, '1. Transcript', language, 'Studio extracts the audio, transcribes it locally, and keeps a timed VTT beside the project. The first run downloads one speech model; later recordings reuse it.')
  const transcriptRow = mountRow('control-row').root
  transcriptRow.append(transcribe)
  form.append(transcriptRow)
  form.append(transcriptHint)

  const beats = control('textarea', {
    className: 'board__brief',
    rows: 3,
    placeholder: 'Opening — what this is about — 6s\nThe work — the main point — 16s\nClose — why it matters — 6s',
  })
  const saveBeats = control('button', { textContent: 'Save beats' })
  field(form, '2. What the first cut needs', beats, 'One beat per line: “Name — what it should say — 8s”. These are the jobs Claude fills from what was actually said.')
  fieldRow(form, saveBeats)

  const notes = control('textarea', { rows: 3, placeholder: 'Optional: keep it direct, avoid the implementation details, lead with the customer problem…' })
  const askClaude = control('button', { className: 'btn btn--primary', textContent: 'Ask Claude for picks' })
  const loadClaude = control('button', { className: 'btn ghost', textContent: 'Load Claude’s picks' })
  field(form, 'Notes for Claude', notes, 'Claude can choose only timed transcript passages. It cannot rewrite, paraphrase or invent a timecode. You review those picks before anything is assembled.')
  const aiRow = mountRow('control-row').root
  aiRow.append(askClaude, loadClaude)
  form.append(aiRow)

  const { review, controls, transcript, previewName, player, workspace, splitter } = ui

  /*
   * The transcript has a useful minimum, but there is no one right width for
   * it. A short screen recording wants more room for the picture; a dense
   * interview wants wider readable lines. The splitter changes only this
   * workspace, rather than a global page column, so it cannot disturb the rest
   * of Studio.
   */
  const resizeTranscript = (next) => {
    const available = workspace.getBoundingClientRect().width
    const minimum = 18 * 16
    const maximum = Math.max(minimum, Math.min(42 * 16, available * 0.58))
    const width = Math.round(Math.max(minimum, Math.min(maximum, next)))
    workspace.style.setProperty('--paper-edit-transcript-width', `${width}px`)
    splitter.setAttribute('aria-valuemin', String(minimum))
    splitter.setAttribute('aria-valuemax', String(Math.round(maximum)))
    splitter.setAttribute('aria-valuenow', String(width))
  }
  splitter.onpointerdown = (event) => {
    if (window.matchMedia('(max-width: 980px)').matches) return
    event.preventDefault()
    const startX = event.clientX
    const startWidth = transcript.getBoundingClientRect().width
    splitter.setPointerCapture?.(event.pointerId)
    workspace.classList.add('paper-edit--resizing')
    const move = (pointer) => resizeTranscript(startWidth + pointer.clientX - startX)
    const end = () => {
      workspace.classList.remove('paper-edit--resizing')
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end, { once: true })
  }
  splitter.onkeydown = (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const current = transcript.getBoundingClientRect().width
    const available = workspace.getBoundingClientRect().width
    const minimum = 18 * 16
    const maximum = Math.max(minimum, Math.min(42 * 16, available * 0.58))
    if (event.key === 'Home') return resizeTranscript(minimum)
    if (event.key === 'End') return resizeTranscript(maximum)
    resizeTranscript(current + (event.key === 'ArrowLeft' ? -24 : 24))
  }
  requestAnimationFrame(() => resizeTranscript(transcript.getBoundingClientRect().width))

  let state = null
  const planFromLines = () =>
    String(beats.value)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(/\s+[—–-]\s+/)
        const name = (parts.shift() ?? '').trim()
        let seconds = null
        const tail = parts.at(-1) ?? ''
        const match = /^(\d+(?:\.\d+)?)\s*s(?:ec(?:onds)?)?$/i.exec(tail.trim())
        if (match) {
          seconds = Number(match[1])
          parts.pop()
        }
        return { name, intent: parts.join(' — ').trim(), seconds }
      })
      .filter((shot) => shot.name)
  const firstCutBeat = () => [{ name: 'First cut', intent: 'The clearest, most useful parts of this recording', seconds: null }]

  const request = async (path, body = {}) => {
    if (!clip.value) return { error: 'Choose a recording first.' }
    const response = await fetch(`/api/paper-edit/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: currentProject(), rel: clip.value, ...body }) }).catch((err) => ({ error: err.message }))
    if (response.error) return response
    const raw = await response.text()
    try {
      return JSON.parse(raw)
    } catch {
      return { error: response.status === 404 ? 'Studio needs a restart to load the Paper edit actions.' : raw || `Studio returned ${response.status}.` }
    }
  }
  const say = (message, level = '') => says(status, message, level)

  // Review starts with Claude's selection, but every saved range is word-based.
  // Caption lines stay as readable context — they are never the cut boundary.
  let reviewAssignments = new Map()
  let activeBeat = ''
  let draftPlan = []
  let draftPlanDirty = false
  let reviewSaveTimer = null
  let reviewSaveRevision = 0
  let playingCue = -1
  let visualPickKey = ''
  let selectionAnchorWord = null
  const reviewPlan = () => (draftPlanDirty || !state?.plan?.shots?.length ? draftPlan : state.plan.shots)
  const cueAssignments = () => {
    const words = state?.transcript?.words ?? []
    const assignments = new Map()
    for (const range of state?.selection?.checked?.ranges ?? []) {
      for (let wordIndex = Number(range.fromIndex); wordIndex <= Number(range.toIndex); wordIndex++) {
        if (words[wordIndex]) assignments.set(wordIndex, range.shot)
      }
    }
    return assignments
  }

  const selectionFromReview = () => {
    const byShot = new Map(reviewPlan().map((shot) => [shot.name, []]))
    for (const [wordIndex, shot] of [...reviewAssignments.entries()].sort(([a], [b]) => a - b)) {
      const word = state.transcript.words[wordIndex]
      const ranges = byShot.get(shot)
      if (!word || !ranges) continue
      const previous = ranges.at(-1)
      // A visual pick is a passage, not one cut for every word. Keep adjacent
      // word selections together, even when the caption display wraps between
      // them.
      if (previous && previous.lastWord === wordIndex - 1) {
        previous.to = word.id
        previous.lastWord = wordIndex
      } else {
        ranges.push({ from: word.id, to: word.id, why: 'Selected in review', lastWord: wordIndex })
      }
    }
    return {
      shots: [...byShot.entries()].map(([shot, ranges]) => ({
        shot,
        ranges: ranges.map(({ lastWord, ...range }) => range),
      })),
    }
  }

  const persistReview = async () => {
    if (draftPlanDirty) {
      const plan = planFromLines()
      if (!plan.length) return { error: 'Add a beat before saving this edit.' }
      const planned = await request('plan', { plan: { shots: plan } })
      if (planned.error) return planned
      state = planned.state
      draftPlan = plan
      draftPlanDirty = false
    }
    const selected = await request('selection', { selection: selectionFromReview() })
    if (!selected.error) state = selected.state
    return selected
  }

  const saveReviewSoon = () => {
    const revision = ++reviewSaveRevision
    window.clearTimeout(reviewSaveTimer)
    reviewSaveTimer = window.setTimeout(async () => {
      const saved = await persistReview()
      if (revision !== reviewSaveRevision || !saved.error) return
      say(saved.error, 'bad')
    }, 450)
  }

  /*
   * The transcript and the recording are one review surface.
   *
   * The old page showed the words in one column and left the person to remember
   * where they were in the recording. A click now seeks to the line, and the
   * playhead lights the current line as the recording plays. Selection stays on
   * the line itself; playback is additional context, not a second mode.
   */
  const cueAt = (seconds) => {
    const cues = state?.transcript?.cues ?? []
    return cues.findIndex((cue, index) => Number(seconds) >= Number(cue.startSec ?? 0) && Number(seconds) < Number(cues[index + 1]?.startSec ?? Infinity))
  }
  const timecode = (seconds) => {
    const total = Math.max(0, Math.floor(Number(seconds) || 0))
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
  }
  const wordIndexesForCue = (cue) => {
    const words = state?.transcript?.words ?? []
    const ids = new Map(words.map((word, index) => [word.id, index]))
    const first = ids.get(cue.from)
    const last = ids.get(cue.to)
    if (first != null && last != null) return Array.from({ length: last - first + 1 }, (_, index) => first + index)
    return words
      .map((word, index) => ({ word, index }))
      .filter(({ word }) => Number(word.endSec ?? word.startSec) >= Number(cue.startSec ?? 0) && Number(word.startSec ?? 0) <= Number(cue.endSec ?? cue.startSec ?? 0))
      .map(({ index }) => index)
  }
  const paintPlayback = ({ scroll = false } = {}) => {
    const next = cueAt(player.currentTime)
    if (next === playingCue) return
    review.querySelector(`[data-cue="${playingCue}"]`)?.classList.remove('paper-edit__line--playing')
    playingCue = next
    const line = review.querySelector(`[data-cue="${playingCue}"]`)
    line?.classList.add('paper-edit__line--playing')
    if (scroll) line?.scrollIntoView({ block: 'nearest' })
  }
  const seekToCue = (cue) => {
    const at = Number(cue?.startSec)
    if (!Number.isFinite(at)) return
    player.currentTime = at
    paintPlayback({ scroll: true })
  }
  const showPreview = () => {
    playingCue = -1
    if (!clip.value) {
      player.removeAttribute('src')
      player.load()
      previewName.textContent = 'Choose a recording to preview it here.'
      return
    }
    player.src = `/media/${encodeURIComponent(currentProject() ?? '')}/${encodeURI(clip.value)}`
    player.load()
    previewName.textContent = clip.options[clip.selectedIndex]?.textContent || 'Selected recording'
  }
  const paintTranscriptAction = () => {
    const ready = Boolean(state?.transcript)
    setLabel(transcribe, ready ? 'Transcribe again' : 'Transcribe recording')
    transcribe.title = ready ? 'Replace this recording’s saved transcript' : ''
  }
  player.addEventListener('timeupdate', () => paintPlayback({ scroll: true }))
  player.addEventListener('seeked', () => paintPlayback({ scroll: true }))

  const paintReview = () => {
    review.replaceChildren()
    if (!state?.transcript) return
    const shots = reviewPlan()
    if (!activeBeat || !shots.some((shot) => shot.name === activeBeat)) activeBeat = shots[0]?.name ?? ''
    const { root: head, el: headBits } = mountRow('paper-edit-head')
    const canEdit = Boolean(shots.length)
    const allIncluded = canEdit && state.transcript.words.length > 0 && state.transcript.words.every((_, wordIndex) => reviewAssignments.get(wordIndex) === activeBeat)
    headBits.title.textContent = state.selection?.checked?.ranges?.length ? 'Review picks' : 'Transcript'
    headBits.hint.textContent = canEdit ? (allIncluded ? 'Everything is in the first cut. Click words to take them out; Shift-click extends a range.' : 'Choose a beat, then click the exact words to include. Shift-click extends a range.') : 'Add at least one beat in Assembly settings. The transcript becomes editable as soon as it has a name.'
    review.append(head)
    if (!canEdit) {
      review.append(control('hint', { textContent: `Transcript attached: ${state.transcript.words.length} words across ${state.transcript.cues.length} timed passages.` }))
    }

    const beatBar = mountRow('paper-edit-beats').root
    for (const shot of shots) {
      const beat = mountRow('paper-edit-beat').root
      beat.textContent = shot.name
      beat.classList.toggle('paper-edit__beat-chip--active', shot.name === activeBeat)
      beat.setAttribute('aria-pressed', String(shot.name === activeBeat))
      beat.onclick = () => {
        activeBeat = shot.name
        selectionAnchorWord = null
        paintReview()
      }
      beatBar.append(beat)
    }
    if (shots.length) review.append(beatBar)

    const setAssignment = (wordIndex, shot) => {
      if (!shot) reviewAssignments.delete(wordIndex)
      else reviewAssignments.set(wordIndex, shot)
      saveReviewSoon()
    }

    /*
     * Claude's ranges are the reviewable picks. Show them as actual moments from
     * the recording before we turn anything into a cut document: one card per
     * chosen passage, its first frame, duration, transcript and reason. The video
     * source is intentionally the original recording; a pick is a non-destructive
     * in/out decision, not a duplicate media file.
     */
    const suggested = state.selection?.checked?.ranges ?? []
    if (suggested.length) {
      const wordIndex = new Map((state.transcript.words ?? []).map((word, index) => [word.id, index]))
      const wordIndexesFor = (range) =>
        state.transcript.words
          .map((_, wordIndex) => wordIndex)
          .filter((wordIndex) => wordIndex >= range.fromIndex && wordIndex <= range.toIndex)
      const { root: picks, el: picksBits } = mountRow('paper-edit-picks')
      const grid = picksBits.grid
      for (const [pickIndex, range] of suggested.entries()) {
        const key = `${range.shot}:${range.from.id}:${range.to.id}`
        const wordIndexes = wordIndexesFor(range)
        const included = wordIndexes.length > 0 && wordIndexes.every((wordIndex) => reviewAssignments.get(wordIndex) === range.shot)
        const { root: card, el: pick } = mountRow('paper-edit-pick')
        card.classList.toggle('paper-edit__pick--active', key === visualPickKey)
        card.classList.toggle('paper-edit__pick--removed', !included)
        const inspect = pick.inspect
        inspect.setAttribute('aria-label', `Preview ${range.shot}: ${range.text}`)
        const thumb = pick.thumb
        thumb.src = `/media/${encodeURIComponent(currentProject() ?? '')}/${encodeURI(clip.value)}`
        thumb.addEventListener(
          'loadedmetadata',
          () => {
            const at = Math.max(0, Number(range.from.startSec) + 0.08)
            try {
              thumb.currentTime = Math.min(at, Math.max(0, thumb.duration - 0.05))
            } catch {}
          },
          { once: true },
        )
        pick.time.textContent = `${timecode(range.from.startSec)}–${timecode(range.to.endSec)}`
        inspect.onclick = () => {
          visualPickKey = key
          player.currentTime = Number(range.from.startSec)
          paintPlayback({ scroll: true })
          paintReview()
        }
        pick.shot.textContent = `${pickIndex + 1}. ${range.shot}`
        pick.text.textContent = range.text
        pick.why.hidden = !range.why
        if (range.why) pick.why.textContent = range.why
        const toggle = pick.toggle
        toggle.className = included ? 'btn ghost' : 'btn'
        setLabel(toggle, included ? 'Remove pick' : 'Use this pick')
        toggle.onclick = () => {
          for (const wordIndex of wordIndexes) setAssignment(wordIndex, included ? '' : range.shot)
          visualPickKey = key
          paintReview()
        }
        grid.append(card)
      }
      picks.append(grid)
      review.append(picks)
    }

    const lines = mountRow('paper-edit-lines').root
    for (const [cueIndex, cue] of state.transcript.cues.entries()) {
      const { root: line, el: cells } = mountRow('paper-edit-line')
      line.dataset.cue = String(cueIndex)
      const wordIndexes = wordIndexesForCue(cue)
      const text = cells.text
      const assigned = wordIndexes.some((wordIndex) => Boolean(reviewAssignments.get(wordIndex)))
      const active = wordIndexes.length > 0 && wordIndexes.every((wordIndex) => reviewAssignments.get(wordIndex) === activeBeat)
      cells.time.textContent = timecode(cue.startSec)
      line.classList.toggle('paper-edit__line--assigned', assigned)
      line.classList.toggle('paper-edit__line--active', active)
      line.classList.toggle('paper-edit__line--playing', cueIndex === playingCue)
      for (const wordIndex of wordIndexes) {
        const word = state.transcript.words[wordIndex]
        if (!word) continue
        const token = mountRow(canEdit ? 'paper-edit-word-button' : 'paper-edit-word').root
        token.textContent = word.text
        token.dataset.rmWord = String(wordIndex)
        const wordAssignment = reviewAssignments.get(wordIndex) ?? ''
        token.classList.toggle('paper-edit__word--selected', Boolean(wordAssignment))
        token.classList.toggle('paper-edit__word--active', wordAssignment === activeBeat)
        if (canEdit) {
          token.setAttribute('aria-pressed', String(Boolean(wordAssignment)))
          token.title = `${timecode(word.startSec)}–${timecode(word.endSec ?? word.startSec)}`
          token.onclick = (event) => {
            const start = event.shiftKey && selectionAnchorWord != null ? Math.min(selectionAnchorWord, wordIndex) : wordIndex
            const end = event.shiftKey && selectionAnchorWord != null ? Math.max(selectionAnchorWord, wordIndex) : wordIndex
            const removing = [...Array(end - start + 1).keys()].every((offset) => reviewAssignments.get(start + offset) === activeBeat)
            for (let selectedWord = start; selectedWord <= end; selectedWord++) setAssignment(selectedWord, removing ? '' : activeBeat)
            selectionAnchorWord = wordIndex
            // Keep the clicked word around through the gesture, then repaint
            // without moving the transcript or its video playhead.
            window.setTimeout(() => repaintTranscriptKeepingPosition(review, wordIndex, paintReview), 50)
          }
        }
        text.append(token, document.createTextNode(' '))
      }
      lines.append(line)
    }
    review.append(lines)
    if (!canEdit) return
    const save = control('button', { className: 'btn btn--primary', textContent: 'Build editable assembly' })
    save.onclick = async () => {
      window.clearTimeout(reviewSaveTimer)
      reviewSaveRevision += 1
      const selected = await persistReview()
      if (selected.error) return say(selected.error, 'bad')
      const cut = await request('cut', { name: 'paper-edit' })
      if (cut.error) return say(cut.error, 'bad')
      const opened = await openDocument({ projectId: currentProject(), path: cut.document })
      if (opened?.error) return say(`${cut.clips} clips are ready in the editable document, but the editor did not open: ${opened.error}`, 'bad')
      say(`${cut.clips} approved clips are ready in the visual editor. Rendering stays manual.`, 'ok')
    }
    review.append(save)
  }

  const loadState = async () => {
    review.replaceChildren()
    transcriptHint.textContent = ''
    state = null
    selectionAnchorWord = null
    paintTranscriptAction()
    if (!clip.value) return
    const response = await fetch(`/api/paper-edit?project=${encodeURIComponent(currentProject())}&rel=${encodeURIComponent(clip.value)}`).catch((err) => ({ error: err.message }))
    if (response.error) return say(response.error, 'bad')
    const raw = await response.text()
    let r
    try {
      r = JSON.parse(raw)
    } catch {
      return say(response.status === 404 ? 'Studio needs a restart to load the Paper edit actions.' : raw || `Studio returned ${response.status}.`, 'bad')
    }
    if (r.error) return say(r.error, 'bad')
    state = r.state
    if (!state) {
      transcriptHint.textContent = 'No transcript for this recording yet.'
      return
    }
    // The setup is useful until a recording is chosen. Once there is a timed
    // transcript, it must get out of the way so the review words occupy the
    // panel rather than being pushed below the visible workspace.
    controls.open = false
    paintTranscriptAction()
    const savedPlan = state.plan?.shots ?? []
    if (savedPlan.length) {
      beats.value = savedPlan.map((shot) => [shot.name, shot.intent, shot.seconds ? `${shot.seconds}s` : null].filter(Boolean).join(' — ')).join('\n')
      draftPlan = savedPlan
      draftPlanDirty = false
      reviewAssignments = cueAssignments()
    } else {
      draftPlan = firstCutBeat()
      beats.value = draftPlan.map((shot) => [shot.name, shot.intent].filter(Boolean).join(' — ')).join('\n')
      draftPlanDirty = true
      activeBeat = draftPlan[0].name
      reviewAssignments = new Map(state.transcript.words.map((_, wordIndex) => [wordIndex, activeBeat]))
    }
    const timing = state.transcript.timing === 'word' ? 'Word-level timing is ready for precise cuts.' : 'Caption-level timing is the fallback; re-transcribe for precise word cuts.'
    transcriptHint.textContent = `${state.transcript.words.length} words across ${state.transcript.cues.length} caption lines. ${timing}`
    paintReview()
  }

  /*
   * A completed VTT is immediately part of the selected recording.
   *
   * Polling the job is deliberately local to this panel: Console is a log, not
   * the place a person has to visit to move their edit forward.  If the panel is
   * left or the clip changes, the result is still saved server-side and is picked
   * up the next time this recording is selected.
   */
  const watchTranscription = (job, rel) => {
    const check = async () => {
      const data = await fetch('/api/jobs')
        .then((response) => response.json())
        .catch(() => null)
      const current = data?.jobs?.find((item) => item.id === job.id)
      if (!current || current.running) return setTimeout(check, 1200)
      transcribe.disabled = false
      if (current.code !== 0) return say('Transcription stopped before it finished. Console has the details.', 'bad')
      if (clip.value !== rel) return
      const done = await request('transcript', { fromFile: true })
      if (done.error) return say(done.error, 'bad')
      state = done.state
      await loadState()
      say('Transcript is attached to this recording and ready for the first assembly.', 'ok')
    }
    void check()
  }

  const loadClaudePicks = async () => {
    const selected = await request('selection', { fromFile: true })
    if (selected.error) return selected
    state = selected.state
    reviewAssignments = cueAssignments()
    paintReview()
    return selected
  }

  /*
   * Claude writes a constrained selection, not a video. Once that file exists,
   * Studio stops at visual review. Building the OpenScreen document is the next,
   * explicit decision — otherwise the first time somebody sees the clips is after
   * they have already been committed to a timeline.
   */
  const watchFirstAssembly = (job, rel) => {
    const check = async () => {
      const data = await fetch('/api/jobs')
        .then((response) => response.json())
        .catch(() => null)
      const current = data?.jobs?.find((item) => item.id === job.id)
      if (!current || current.running) return setTimeout(check, 1200)
      if (current.code !== 0) return say('Claude stopped before it finished the first cut. Console has the details.', 'bad')
      if (clip.value !== rel) return
      const picks = await loadClaudePicks()
      if (picks.error) return say(`Claude finished, but Studio could not load its picks: ${picks.error}`, 'bad')
      say(`Claude’s ${picks.coverage?.ranges ?? 0} suggested clips are ready to review. Nothing has been assembled yet.`, 'ok')
    }
    void check()
  }

  clip.onchange = () => {
    showPreview()
    loadState()
  }
  beats.oninput = () => {
    draftPlan = planFromLines()
    draftPlanDirty = true
    if (state?.transcript) paintReview()
  }
  transcribe.onclick = async () => {
    if (state?.transcript && !confirm('Replace the saved transcript for this recording? Its existing transcript and any unreviewed selection will be replaced.')) return
    const r = await request('transcribe', { language: language.value })
    if (r.error) return say(r.error, 'bad')
    const job = r.alreadyRunning ? r.job : await start(r.step, { openConsole: false })
    if (!job) return
    transcribe.disabled = true
    say(r.alreadyRunning ? 'This recording is already transcribing in the background.' : 'Transcribing in the background. The first run downloads the speech model; you can keep working here.', 'ok')
    watchTranscription(job, clip.value)
  }
  saveBeats.onclick = async () => {
    const plan = planFromLines()
    if (!plan.length) return say('Add at least one beat first.', 'bad')
    const r = await request('plan', { plan: { shots: plan } })
    if (r.error) return say(r.error, 'bad')
    state = r.state
    draftPlan = plan
    draftPlanDirty = false
    paintReview()
    say('Choose a beat, then click the lines that belong in it.', 'ok')
  }
  askClaude.onclick = async () => {
    if (draftPlanDirty || !state?.plan?.shots?.length) {
      const plan = planFromLines()
      if (!plan.length) return say('Add at least one beat before asking Claude.', 'bad')
      const planned = await request('plan', { plan: { shots: plan } })
      if (planned.error) return say(planned.error, 'bad')
      state = planned.state
      draftPlan = plan
      draftPlanDirty = false
    }
    const r = await request('draft', { notes: notes.value })
    if (r.error) return say(r.error, 'bad')
    say('Claude is finding the strongest clips in the background. Its visual picks will return here when they are ready.', 'ok')
    const job = await start(r.step, { openConsole: false })
    if (job) watchFirstAssembly(job, clip.value)
  }
  loadClaude.onclick = async () => {
    const picks = await loadClaudePicks()
    if (picks.error) return say(picks.error, 'bad')
    const missing = picks.coverage?.empty?.length ? ` Still missing: ${picks.coverage.empty.join(', ')}.` : ''
    say(`Loaded Claude’s ${picks.coverage?.ranges ?? 0} suggested clips for review.${missing}`, picks.coverage?.empty?.length ? 'warn' : 'ok')
  }

  /*
   * Reopen the most recent transcripted recording, not a blank chooser. The
   * result comes from the project files, so it also recovers a transcription
   * that finished while this page was closed.
   */
  const restorePaperEdit = async () => {
    const result = await fetch(`/api/paper-edit/recordings?project=${encodeURIComponent(currentProject() ?? '')}`)
      .then(responseJson)
      .catch((error) => ({ error: error.message }))
    const ready = result.recordings ?? []
    for (const recording of ready) {
      const option = [...clip.options].find((item) => item.value === recording.rel)
      if (!option) continue
      option.textContent = `${option.textContent} · transcript ready`
      option.dataset.transcriptReady = 'true'
    }
    const recent = ready.find((recording) => [...clip.options].some((item) => item.value === recording.rel))
    if (recent) clip.value = recent.rel
    else if (videos().length === 1) clip.value = videos()[0].rel
    if (clip.value) {
      showPreview()
      void loadState()
    }
  }
  void restorePaperEdit()
}

/**
 * One canvas card, opened as a scene rather than edited through a hidden rail.
 *
 * A slot is the promise a video makes: what must appear, how long it needs, and
 * the footage that can fulfil it. Keeping those three things together lets a
 * person answer the natural question — “what belongs here?” — before they are
 * asked to judge takes or wire the board.
 */
function vBoardSceneEditor(m, slotId) {
  const project = currentProjectRecord()
  const back = () => {
    openBoardScene = null
    render()
  }

  crumbs(scopedCrumbs([{ label: 'Video', go: () => go('workflow') }, { label: 'Canvas', go: back }, { label: 'Footage review' }]))

  const ui = mountPanel('board-scene', m)
  const { form, heading, status, media, mediaActions, review, addTake, transcribe, upload, picker, backButton, visualEditor, save } = ui
  statusSink(status)
  const name = control('input', { placeholder: 'Name this scene' })
  const intent = control('textarea', { rows: 6, placeholder: 'Describe exactly what needs to be on screen, what changes, and what the viewer should notice.' })
  const seconds = control('number', { min: 0, step: 0.5, placeholder: 'seconds' })
  const footage = control('select')

  field(form, 'Scene name', name, 'A short label for this card on the canvas.')
  field(form, 'What needs to be there', intent, 'Be specific about the subject, action, framing, screen state, or text this scene needs.')
  field(form, 'Target length', seconds, 'Optional. This is a guide for the finished video, not a limit on the source clip.')
  fieldRow(form, save)

  field(media, 'Choose a project video', footage, 'Transcribe it once, then choose the exact spoken passage that belongs in this scene. The transcript stays with this video, not with a temporary assembly.')
  media.append(mediaActions)
  media.append(review)

  const say = (message, level = '') => {
    status.textContent = message
    status.className = `form-hint${level ? ` ${level}` : ''}`
  }

  let board = null
  let slot = null
  let paperState = null
  let selectedWordIndexes = new Set()
  let selectionAnchorWord = null
  let selectedTake = null
  const videoFiles = () => (project?.catalog?.files ?? []).filter((file) => file.kind === 'video')

  const selectedTakeRange = () => selectedTake?.rel === footage.value
    && Number(selectedTake.outSec) > Number(selectedTake.inSec)
    ? selectedTake
    : null

  const selectSavedTakeWords = () => {
    const range = selectedTakeRange()
    const words = paperState?.transcript?.words ?? []
    if (!range || !words.length) return false
    const indexes = words
      .map((word, index) => ({ word, index }))
      .filter(({ word }) => Number(word.endSec ?? word.startSec) >= Number(range.inSec)
        && Number(word.startSec) <= Number(range.outSec))
      .map(({ index }) => index)
    selectedWordIndexes = new Set(indexes)
    selectionAnchorWord = indexes.at(-1) ?? null
    return indexes.length > 0
  }

  const timecode = (seconds) => {
    const total = Math.max(0, Math.floor(Number(seconds) || 0))
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
  }

  const wordIndexesForCue = (cue) => {
    const words = paperState?.transcript?.words ?? []
    const ids = new Map(words.map((word, index) => [word.id, index]))
    const first = ids.get(cue.from)
    const last = ids.get(cue.to)
    if (first != null && last != null) return Array.from({ length: last - first + 1 }, (_, index) => first + index)
    return words
      .map((word, index) => ({ word, index }))
      .filter(({ word }) => Number(word.endSec ?? word.startSec) >= Number(cue.startSec ?? 0) && Number(word.startSec ?? 0) <= Number(cue.endSec ?? cue.startSec ?? 0))
      .map(({ index }) => index)
  }
  const selectedPassages = () => {
    const words = paperState?.transcript?.words ?? []
    const selected = [...selectedWordIndexes].sort((a, b) => a - b)
    const spans = []
    for (const wordIndex of selected) {
      const previous = spans.at(-1)
      if (previous && wordIndex === previous.last + 1) previous.last = wordIndex
      else spans.push({ first: wordIndex, last: wordIndex })
    }
    return spans
      .filter(({ first, last }) => words[first] && words[last])
      .map(({ first, last }) => ({
        inSec: Number(words[first].startSec) || 0,
        outSec: Number(words[last].endSec ?? words[last].startSec) || 0,
        text: words.slice(first, last + 1).map((word) => word.text).join(' '),
      }))
  }

  const requestPaperEdit = async (path, body = {}) => {
    const response = await fetch(`/api/paper-edit/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: currentProject(), rel: footage.value, ...body }),
    }).catch((err) => ({ error: err.message }))
    return response.error ? response : responseJson(response)
  }

  const renderReview = () => {
    review.replaceChildren()
    const cues = paperState?.transcript?.cues ?? []
    if (!footage.value) {
      review.hidden = true
      return
    }
    review.hidden = false
    if (!paperState?.transcript) {
      review.append(control('hint', { textContent: 'This video has no transcript yet. Transcribe it here before choosing a passage.' }))
      return
    }
    const r = mountRow('board-scene-review')
    const player = r.el.player
    player.src = `/media/${encodeURIComponent(currentProject() ?? '')}/${encodeURI(footage.value)}`
    const selectedRange = selectedTakeRange()
    const seekToSelectedStart = () => {
      if (!selectedRange || player.readyState < HTMLMediaElement.HAVE_METADATA) return
      player.currentTime = Math.max(0, Number(selectedRange.inSec) || 0)
    }
    player.onloadedmetadata = seekToSelectedStart
    player.ontimeupdate = () => {
      if (!selectedRange || player.currentTime < Number(selectedRange.outSec)) return
      player.pause()
      player.currentTime = Number(selectedRange.outSec)
    }
    const head = r.el.head
    const passages = selectedPassages()
    const use = r.el.use
    setLabel(use, passages.length ? `Use ${passages.length} selected passage${passages.length === 1 ? '' : 's'} in this scene` : 'Choose transcript words')
    use.disabled = !passages.length
    use.onclick = async () => {
      const picked = selectedPassages()
      if (!slot || !picked.length) return
      use.disabled = true
      say('Saving selected words to the scene…')
      let chosen = null
      for (const passage of picked) {
        const result = await fetch('/api/board/take', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ projectId: currentProject(), slotId: slot.id, rel: footage.value, inSec: passage.inSec, outSec: passage.outSec, durationSec: videoFiles().find((file) => file.rel === footage.value)?.media?.durationSec ?? null }),
        }).catch((err) => ({ error: err.message }))
        const saved = result.error ? result : await responseJson(result)
        if (saved.error) {
          use.disabled = false
          return say(saved.error, 'bad')
        }
        board = saved.board
        chosen = await fetch('/api/board/pick', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ projectId: currentProject(), slotId: slot.id, takeId: saved.takeId }),
        }).then(responseJson).catch((err) => ({ error: err.message }))
        if (chosen.error) return say(`Passage saved, but Studio could not make it the current take: ${chosen.error}`, 'warn')
      }
      board = chosen.board
      const selectedId = board?.picks?.[slot.id] ?? null
      selectedTake = selectedId
        ? (board?.takes ?? []).find((take) => take.id === selectedId) ?? null
        : null
      selectSavedTakeWords()
      renderReview()
      const last = picked.at(-1)
      say(`Saved ${picked.length} passage${picked.length === 1 ? '' : 's'}; ${timecode(last.inSec)}–${timecode(last.outSec)} is this scene’s current take. You can compare or change it on the canvas.`, 'ok')
    }
    const timing = paperState.transcript.timing === 'word' ? 'word-level timing' : 'caption timing fallback'
    r.el.stats.textContent = `${paperState.transcript.words?.length ?? 0} words · ${cues.length} timed lines · ${timing}${selectedRange ? ` · reviewing ${timecode(selectedRange.inSec)}–${timecode(selectedRange.outSec)}` : ''}`
    const lines = r.el.lines
    for (const [index, cue] of cues.entries()) {
      const { root: line, el: lineEl } = mountRow('board-scene-line')
      line.dataset.cue = String(index)
      const words = wordIndexesForCue(cue)
      const text = lineEl.text
      line.classList.toggle('paper-edit__line--active', words.some((wordIndex) => selectedWordIndexes.has(wordIndex)))
      lineEl.time.textContent = timecode(cue.startSec)
      for (const wordIndex of words) {
        const word = paperState.transcript.words[wordIndex]
        if (!word) continue
        const token = mountRow('board-scene-word').root
        token.textContent = word.text
        token.dataset.rmWord = String(wordIndex)
        token.classList.toggle('paper-edit__word--selected', selectedWordIndexes.has(wordIndex))
        token.setAttribute('aria-pressed', String(selectedWordIndexes.has(wordIndex)))
        token.title = `${timecode(word.startSec)}–${timecode(word.endSec ?? word.startSec)}`
        token.onclick = (event) => {
          if (event.shiftKey && selectionAnchorWord != null) {
            const first = Math.min(selectionAnchorWord, wordIndex)
            const last = Math.max(selectionAnchorWord, wordIndex)
            for (let selectedWord = first; selectedWord <= last; selectedWord++) selectedWordIndexes.add(selectedWord)
          } else if (selectedWordIndexes.has(wordIndex)) selectedWordIndexes.delete(wordIndex)
          else selectedWordIndexes.add(wordIndex)
          selectionAnchorWord = wordIndex
          // Keep this word button alive through the click, then preserve the
          // transcript position while the selected state is repainted.
          window.setTimeout(() => repaintTranscriptKeepingPosition(review, wordIndex, renderReview), 50)
        }
        text.append(token, document.createTextNode(' '))
      }
      lines.append(line)
    }
    const clear = r.el.clear
    clear.disabled = !passages.length
    clear.onclick = () => {
      selectedWordIndexes = new Set()
      selectionAnchorWord = null
      renderReview()
    }
    r.el.hint.textContent = passages.length ? `${passages.length} exact passage${passages.length === 1 ? '' : 's'} selected. Shift-click extends a continuous word range.` : 'Click the exact words for this scene. Shift-click another word to select everything between them.'
    review.append(...r.nodes)
  }

  const loadTranscript = async () => {
    paperState = null
    selectedWordIndexes = new Set()
    selectionAnchorWord = null
    if (!footage.value) return renderReview()
    const response = await fetch(`/api/paper-edit?project=${encodeURIComponent(currentProject() ?? '')}&rel=${encodeURIComponent(footage.value)}`).catch((err) => ({ error: err.message }))
    const result = response.error ? response : await responseJson(response)
    if (result.error) return say(result.error, 'bad')
    paperState = result.state
    selectSavedTakeWords()
    renderReview()
  }

  const fillFootage = () => {
    footage.replaceChildren(new Option('Choose a video…', ''))
    for (const file of videoFiles()) footage.append(new Option(`${file.name} · ${clock(file.media?.durationSec ?? 0)}`, file.rel))
    addTake.disabled = !videoFiles().length
    transcribe.disabled = !videoFiles().length
  }

  const loadScene = async () => {
    const response = await fetch(`/api/board?project=${encodeURIComponent(currentProject() ?? '')}`).catch((err) => ({ error: err.message }))
    const result = response.error ? response : await responseJson(response)
    if (result.error) {
      say(result.error, 'bad')
      return
    }
    board = result.board
    slot = (board?.slots ?? []).find((item) => item.id === slotId)
    if (!slot) {
      say('That scene is no longer on the canvas.', 'bad')
      save.disabled = true
      addTake.disabled = true
      return
    }
    heading.textContent = slot.name || 'Scene'
    name.value = slot.name ?? ''
    intent.value = slot.intent ?? ''
    seconds.value = slot.seconds ?? ''
    fillFootage()
    const justAdded = pendingBoardVideo
    if (justAdded) {
      footage.value = videoFiles().find((file) => file.name === justAdded)?.rel ?? ''
      pendingBoardVideo = null
      selectedTake = null
    } else {
      const selectedId = board?.picks?.[slot.id] ?? null
      selectedTake = selectedId
        ? (board?.takes ?? []).find((take) => take.id === selectedId) ?? null
        : null
      if (selectedTake?.rel) footage.value = selectedTake.rel
    }
    const count = (board.takes ?? []).filter((take) => take.slotId === slot.id).length
    say(justAdded ? `${justAdded} is selected. Use this video to attach it to the scene.` : count ? `${count} video${count === 1 ? '' : 's'} attached to this scene.` : 'No video attached yet. Describe the scene first, then choose or add footage.', justAdded ? 'ok' : '')
    await loadTranscript()
  }

  save.onclick = async () => {
    if (!slot) return
    save.disabled = true
    say('Saving scene…')
    const response = await fetch('/api/board/node/update', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: currentProject(), nodeId: slot.id, name: name.value, intent: intent.value, seconds: seconds.value === '' ? null : seconds.value }),
    }).catch((err) => ({ error: err.message }))
    const result = response.error ? response : await responseJson(response)
    save.disabled = false
    if (result.error) return say(result.error, 'bad')
    slot = (result.board?.slots ?? []).find((item) => item.id === slotId) ?? slot
    heading.textContent = slot.name
    say('Scene saved.', 'ok')
  }

  addTake.onclick = async () => {
    if (!slot || !footage.value) return say('Choose a video first.', 'bad')
    const file = videoFiles().find((item) => item.rel === footage.value)
    addTake.disabled = true
    say('Attaching video…')
    const response = await fetch('/api/board/take', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: currentProject(), slotId: slot.id, rel: footage.value, inSec: 0, outSec: file?.media?.durationSec ?? 0, durationSec: file?.media?.durationSec ?? null }),
    }).catch((err) => ({ error: err.message }))
    const result = response.error ? response : await responseJson(response)
    if (result.error) {
      addTake.disabled = !footage.value
      return say(result.error, 'bad')
    }
    // A take without a pick is invisible to the Canvas card: the video was
    // technically saved, but this scene still looked empty. Adding a whole
    // recording is the same approval as choosing a transcript passage, so
    // make it the current take immediately.
    const responsePick = await fetch('/api/board/pick', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: currentProject(), slotId: slot.id, takeId: result.takeId }),
    }).catch((err) => ({ error: err.message }))
    const picked = responsePick.error ? responsePick : await responseJson(responsePick)
    addTake.disabled = !footage.value
    if (picked.error) return say(`Video was attached, but Studio could not make it this scene’s current take: ${picked.error}`, 'warn')
    board = picked.board
    const selectedId = board?.picks?.[slot.id] ?? null
    selectedTake = selectedId
      ? (board?.takes ?? []).find((take) => take.id === selectedId) ?? null
      : null
    selectSavedTakeWords()
    renderReview()
    const count = (board?.takes ?? []).filter((take) => take.slotId === slot.id).length
    say(`Video attached and selected for this scene. It is now visible on the canvas${count > 1 ? ` with ${count - 1} alternate take${count === 2 ? '' : 's'}` : ''}.`, 'ok')
  }

  visualEditor.onclick = () => {
    if (!slot) return
    openBoardScene = {
      id: slot.id,
      name: slot.name ?? '',
      intent: slot.intent ?? '',
      scene: slot.scene ?? '',
      takeId: board?.picks?.[slot.id] ?? null,
    }
    openScene = openBoardScene.scene || ''
    go('scenes')
  }

  footage.onchange = () => {
    const selectedId = board?.picks?.[slot?.id] ?? null
    selectedTake = selectedId && footage.value
      ? (board?.takes ?? []).find((take) => take.id === selectedId && take.rel === footage.value) ?? null
      : null
    void loadTranscript()
  }

  transcribe.onclick = async () => {
    if (!footage.value) return say('Choose a video first.', 'bad')
    transcribe.disabled = true
    say('Transcribing this video in the background…')
    const result = await requestPaperEdit('transcribe', { language: 'en' })
    if (result.error) {
      transcribe.disabled = false
      return say(result.error, 'bad')
    }
    const job = result.alreadyRunning ? result.job : await start(result.step, { status })
    if (!job) {
      transcribe.disabled = false
      return
    }
    const rel = footage.value
    watchJobInPlace(job, status, async (finished) => {
      transcribe.disabled = false
      if (!finished || finished.code !== 0) return
      if (footage.value !== rel) return
      const attached = await requestPaperEdit('transcript', { fromFile: true })
      if (attached.error) return say(attached.error, 'bad')
      paperState = attached.state
      selectedWordIndexes = new Set()
      selectionAnchorWord = null
      renderReview()
      say('Transcript is ready. Choose the exact passage for this scene.', 'ok')
    })
  }

  upload.onclick = () => picker.click()
  picker.onchange = async () => {
    const file = picker.files?.[0]
    picker.value = ''
    if (!file) return
    upload.disabled = true
    say(`Adding ${file.name}…`)
    const response = await fetch(`/api/import/upload?project=${encodeURIComponent(currentProject() ?? '')}&name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: file,
      duplex: 'half',
    }).catch((err) => ({ error: err.message }))
    const result = response.error ? response : await responseJson(response)
    upload.disabled = false
    if (result.error) return say(result.error, 'bad')
    // The catalogue supplies the video picker, so refresh it before offering the
    // freshly imported file rather than asking the user to leave and come back.
    pendingBoardVideo =
      String(result.file ?? file.name)
        .split('/')
        .pop() || file.name
    await loadScene()
  }

  backButton.onclick = back
  void loadScene()
}

function vStoryboard(m) {
  if (openBoardScene) return vBoardSceneEditor(m, openBoardScene.id ?? openBoardScene)
  const ui = mountPanel('storyboard', m)
  const scriptGuide = ui.scriptGuide

  const proj = {
    get value() {
      return currentProject() ?? ''
    },
  }

  /*
   * Canvas units, matching lib/board-graph.mjs.
   *
   * Restated here rather than fetched because studio.js is served as-is with no
   * bundler, so it cannot import from lib/. The server is the authority; these
   * four numbers only have to agree, and the assertions check that they do.
   */
  const CANVAS_W = 12000
  const CANVAS_H = 9000
  const NODE_W = 360
  const NODE_H = 260

  const scroller = ui.scroller
  /*
   * One transformed surface holding two layers: wires in SVG underneath, nodes
   * as ordinary DOM on top.
   *
   * Two layers rather than drawing nodes into the SVG, because a node is a card
   * with buttons, a thumbnail and a select in it — everything HTML is good at
   * and SVG is not. Both live inside the SAME transform, so a node and the wire
   * leaving it can never disagree about where its port is.
   */
  const surface = ui.surface
  const wireLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  wireLayer.setAttribute('class', 'board__wires')
  wireLayer.setAttribute('width', String(CANVAS_W))
  wireLayer.setAttribute('height', String(CANVAS_H))
  wireLayer.setAttribute('viewBox', `0 0 ${CANVAS_W} ${CANVAS_H}`)
  const nodeLayer = ui.nodeLayer
  surface.prepend(wireLayer)
  const spacer = ui.spacer
  const status = ui.status

  /** Everything the panel knows, refetched whole rather than patched. */
  let board = null
  let graph = null
  let selected = selectedBoardNode
  let progress = null
  let scale = ['hero', 'good', 'maybe', 'reject']
  let me = ''
  let syncInfo = { chosen: 'local', adapters: [] }
  let chosenScriptName = null

  /*
   * Zoom lives here rather than in CSS.
   *
   * A Figma-like surface is a transform on one layer, not a font-size cascade:
   * scaling text would reflow every card and the comparison you were making would
   * move under you. One `scale()` on the surface keeps every card's geometry
   * identical and only changes how much of the board fits on screen.
   */
  let zoom = 1
  const ZOOM_MIN = 0.4
  const ZOOM_MAX = 1.6
  const applyZoom = () => {
    surface.style.transform = `scale(${zoom})`
    /*
     * The scroller is told how big the scaled canvas is.
     *
     * A CSS transform does not change layout, so the scroller would still scroll
     * as if the surface were its full 12,000 units however far you zoomed out.
     * The old `width: 100%` was for the flex row this replaced and fought the
     * fixed canvas size; a spacer sized to the scaled result is what actually
     * gives the right scroll extent.
     */
    spacer.style.width = `${CANVAS_W * zoom}px`
    spacer.style.height = `${CANVAS_H * zoom}px`
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`
  }
  const setZoom = (z, anchor = null) => {
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z))
    if (next === zoom) return

    /*
     * Keep the canvas point under the pointer fixed while its scale changes.
     * Leaving scrollLeft/scrollTop alone makes the surface grow from its top-left
     * corner; at any pan position that feels like it is zooming diagonally away
     * from the thing you are looking at. The two coordinate conversions are the
     * inverse of one another, so this works at every existing zoom level.
     */
    let point = null
    if (anchor) {
      const box = scroller.getBoundingClientRect()
      const x = anchor.clientX - box.left - scroller.clientLeft
      const y = anchor.clientY - box.top - scroller.clientTop
      point = { x, y, canvasX: (scroller.scrollLeft + x) / zoom, canvasY: (scroller.scrollTop + y) / zoom }
    }

    zoom = next
    applyZoom()
    if (point) {
      scroller.scrollLeft = point.canvasX * zoom - point.x
      scroller.scrollTop = point.canvasY * zoom - point.y
    }
  }

  /*
   * Pan by dragging the background.
   *
   * Middle-drag and space-drag are the conventions, and both are here — but the
   * primary one is dragging the empty space between columns, because that is what
   * somebody tries first and it costs nothing to support.
   */
  let panning = null
  scroller.addEventListener('pointerdown', (e) => {
    // A wire handles its own pointerdown and stops it, so this never sees one —
    // but naming it here keeps the two from drifting if that ever changes.
    if (e.target.closest('.board__wire')) return
    const onCard = e.target.closest('.board__node, button, input, textarea, select')
    if (!onCard) select(null)
    if (onCard && e.button !== 1) return
    panning = { x: e.clientX, y: e.clientY, left: scroller.scrollLeft, top: scroller.scrollTop }
    scroller.setPointerCapture(e.pointerId)
    scroller.classList.add('board__scroller--panning')
  })
  scroller.addEventListener('pointermove', (e) => {
    if (wiring) {
      // Drawn from the port to the pointer, in canvas units, so the line tracks
      // the cursor exactly at any zoom.
      const from = graph?.nodes.find((n) => n.id === wiring.from)
      if (!from) return
      const to = toCanvas(e.clientX, e.clientY)
      draftPath.setAttribute('d', wirePathOf(outPointOf(from), to))
      // Valid-or-not while the wire is still in the air: the only moment the
      // reason is worth anything is before you let go.
      const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-in]')
      const target = over?.dataset.in
      wiring.over = target ?? null
      wiring.ok = !target || target !== wiring.from
      draftPath.classList.toggle('board__wire-draft--bad', Boolean(target) && !wiring.ok)
      return
    }
    if (dragging) {
      const nx = dragging.x0 + (e.clientX - dragging.dx) / zoom
      const ny = dragging.y0 + (e.clientY - dragging.dy) / zoom
      dragging.moved = true
      dragging.x = nx
      dragging.y = ny
      const node = graph?.nodes.find((n) => n.id === dragging.id)
      if (node) {
        node.x = Math.max(0, Math.min(CANVAS_W - NODE_W, nx))
        node.y = Math.max(0, Math.min(CANVAS_H - NODE_H, ny))
        // Moved directly rather than repainted: a full redraw per pointermove
        // rebuilds every card and every thumbnail, and the drag stutters.
        const card = nodeLayer.querySelector(`[data-node="${CSS.escape(node.id)}"]`)
        if (card) {
          card.style.left = `${node.x}px`
          card.style.top = `${node.y}px`
        }
        redrawWires()
      }
      return
    }
    if (!panning) return
    scroller.scrollLeft = panning.left - (e.clientX - panning.x)
    scroller.scrollTop = panning.top - (e.clientY - panning.y)
  })

  /** Only the wires, so a drag repaints two paths rather than the whole board. */
  function redrawWires() {
    if (!graph) return
    for (const [i, w] of graph.wires.entries()) {
      const from = graph.nodes.find((n) => n.id === w.from)
      const to = graph.nodes.find((n) => n.id === w.to)
      const g = wireLayer.children[i]
      if (!from || !to || !g) continue
      const d = wirePathOf(outPointOf(from), inPointOf(to))
      for (const path of g.children ?? []) path.setAttribute?.('d', d)
    }
  }
  const endPan = async () => {
    if (wiring) {
      const { from, over } = wiring
      wiring = null
      draftPath.setAttribute('d', '')
      if (over && over !== from) {
        const r = await api('wire', { from, to: over })
        if (r.graph) graph = r.graph
        if (r.board) board = r.board
        if (r.progress) progress = r.progress
        drawGraph()
        // The server owns the rules, so the server's reason is what gets shown.
        if (r.ok === false) says(status, r.why, 'bad')
        else says(status, 'Wired.', 'ok')
      }
    }
    if (dragging) {
      const { id, moved, x, y } = dragging
      dragging = null
      // A click that never moved is a selection, not a move — saving it would
      // write the board on every click and log a "move" that moved nothing.
      if (moved)
        void api('node/move', { nodeId: id, x, y }).then((r) => {
          if (r.graph) graph = r.graph
        })
    }
    panning = null
    scroller.classList.remove('board__scroller--panning')
  }
  scroller.addEventListener('pointerup', endPan)
  scroller.addEventListener('pointercancel', endPan)

  // Cmd/ctrl-scroll zooms, matching every canvas tool. Plain scroll still scrolls,
  // which is what a trackpad user expects and what a long board needs.
  scroller.addEventListener(
    'wheel',
    (e) => {
      if (!e.metaKey && !e.ctrlKey) return
      e.preventDefault()
      // A trackpad sends small deltas while a mouse wheel sends larger ones. Cap
      // one event's influence, then use its magnitude for a smooth, steady zoom.
      const delta = Math.max(-100, Math.min(100, e.deltaY))
      setZoom(zoom * Math.exp(-delta * 0.0012), e)
    },
    { passive: false },
  )

  /** Selecting a node is what fills the rail with its takes. */
  function select(id) {
    selected = id
    selectedBoardNode = id
    for (const c of nodeLayer.children) {
      const isSelected = c.dataset.node === id
      c.classList.toggle('board__node--selected', isSelected)
      const button = c.querySelector('.board__node-select')
      if (button) {
        button.textContent = isSelected ? 'Selected' : 'Select'
        button.setAttribute('aria-pressed', String(isSelected))
      }
    }
    paintRail()
    // Selection is visible on the card and in the inspector. Do not reveal a
    // status line below the tall canvas: that makes the browser scroll away from
    // the card the person just selected.
    status.hidden = true
  }

  const api = async (path, body) => {
    const r = await fetch(`/api/board/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: proj.value, ...body }),
    })
    return responseJson(r)
  }

  /** Apply a server response that carries a board, or show why it did not. */
  const took = (r) => {
    if (r?.error) {
      says(status, r.error, 'bad')
      return false
    }
    if (r?.board) {
      board = r.board
      progress = r.progress
      paint()
    }
    return true
  }

  /*
   * A script is the plan for the canvas, not just something the workflow home
   * happened to know about. Turn each speakable line into a scene request here
   * so the Canvas can be started, rebuilt, or revised without a detour.
   */
  const scriptShots = (script) => {
    const source = String(script?.body ?? '')
    const spoken = SP.parseScript(source)
    const title = /^\s*#\s+(.+?)\s*$/m.exec(source)?.[1]?.trim()
    const shots = title ? [{ name: 'Title', intent: title, seconds: 3 }] : []
    for (const [index, line] of spoken.entries()) {
      const label = line.length > 56 ? `${line.slice(0, 53).trimEnd()}…` : line
      shots.push({ name: label || `Scene ${index + 1}`, intent: line, seconds: Math.max(2, Math.round(SP.estimateSeconds([line], 0))) })
    }
    return shots
  }

  const paintScriptGuide = () => {
    const scripts = [...(S.scripts ?? [])]
      .filter((script) => script.project === proj.value)
      .sort((a, b) => String(b.mtime ?? '').localeCompare(String(a.mtime ?? '')))
    scriptGuide.replaceChildren()
    scriptGuide.hidden = !scripts.length
    if (!scripts.length) return

    if (!scripts.some((script) => script.name === chosenScriptName)) {
      chosenScriptName = board?.brief?.script?.name && scripts.some((script) => script.name === board.brief.script.name) ? board.brief.script.name : scripts[0].name
    }
    const { nodes: guideNodes, el: guide } = mountRow('canvas-script-guide')
    const pick = guide.pick
    for (const script of scripts) pick.append(new Option(script.name, script.name))
    pick.value = chosenScriptName
    pick.onchange = () => {
      chosenScriptName = pick.value
      paintScriptGuide()
    }

    const source = scripts.find((script) => script.name === chosenScriptName) ?? scripts[0]
    const shots = scriptShots(source)
    const status = guide.status
    const build = guide.build
    setLabel(build, shots.length ? `Create ${shots.length} slots` : 'No speakable lines')
    build.disabled = !shots.length
    let armed = false
    let armTimer = null
    build.onclick = async () => {
      const takes = (board?.takes ?? []).length
      if (takes && !armed) {
        armed = true
        setLabel(build, `Click again to replace ${board.slots.length} slots`)
        status.textContent = `${takes} take${takes === 1 ? '' : 's'} stays attached to its current slot; renamed lines will need those takes re-added.`
        tone(status, 'warn')
        armTimer = setTimeout(() => {
          armed = false
          setLabel(build, `Create ${shots.length} slots`)
          status.textContent = ''
        }, DISARM_MS)
        return
      }
      clearTimeout(armTimer)
      build.disabled = true
      setLabel(build, 'Creating slots…')
      const brief = {
        ...(board?.brief ?? {}),
        drafted: new Date().toISOString(),
        script: { name: source.name, body: source.body ?? '', drafted: source.mtime ?? null },
        shots,
      }
      const r = await api('slots', { brief })
      if (took(r)) says(status, `${shots.length} slots created from ${source.name}.`, 'ok')
      else {
        build.disabled = false
        setLabel(build, `Create ${shots.length} slots`)
      }
    }

    guide.body.textContent = `${shots.length} scene${shots.length === 1 ? '' : 's'} will be created from its title and spoken lines.`
    scriptGuide.append(...guideNodes)
  }

  const load = async () => {
    if (!proj.value) {
      surface.replaceChildren(control('hint', { textContent: 'Choose a project first — a storyboard belongs to one.' }))
      return
    }
    const response = await fetch(`/api/board?project=${encodeURIComponent(proj.value)}`).catch((err) => ({ error: err.message }))
    const r = response.error ? response : await responseJson(response)
    if (r.error) {
      // A corrupt or too-new board says so instead of showing an empty one, which
      // is what somebody would otherwise start filling in over real work.
      surface.replaceChildren(control('hint', { className: 'hint bad', textContent: r.error }))
      return
    }
    board = r.board
    graph = r.graph
    if (selected && !graph?.nodes?.some((node) => node.id === selected)) {
      selected = null
      selectedBoardNode = null
    }
    progress = r.progress
    scale = (r.ratings ?? []).map((x) => x.id)
    ratingMeta = r.ratings ?? []
    me = r.me ?? ''
    syncInfo = r.sync ?? syncInfo
    paint()
    paintRail()
  }

  let ratingMeta = []

  /** Footage this project holds, which is what a take can be cut from. */
  const footage = () => {
    const p = S.projects.find((x) => x.id === proj.value)
    return (p?.catalog?.files ?? []).filter((f) => f.kind === 'video')
  }

  /* ── the canvas ── */

  function paint() {
    /*
     * The layers are cleared, not the surface.
     *
     * `surface.replaceChildren()` deleted the wire and node layers themselves,
     * so `drawGraph` then filled two elements that were no longer in the
     * document — a board that rendered nothing, with no error anywhere.
     */
    nodeLayer.replaceChildren()
    wireLayer.replaceChildren()
    if (!board) return
    paintScriptGuide()

    const slots = [...(board.slots ?? [])].sort((a, b) => a.order - b.order)
    if (!slots.length) {
      /*
       * The empty state teaches the panel rather than announcing emptiness.
       *
       * A storyboard with no shots is the normal first state, not a failure, and
       * the only useful thing to say is what a shot is and where they come from.
       */
      const { root: empty, el: emptyBits } = mountRow('board-empty')
      emptyBits.add.onclick = () => scriptGuide.querySelector('button')?.click()
      nodeLayer.append(empty)
      return
    }

    drawGraph()
    applyZoom()
  }

  /* ── the canvas ────────────────────────────────────────────────────────
     Nodes are positioned in CANVAS UNITS and the whole surface is scaled, so a
     board arranged on a laptop is the same arrangement everywhere — including
     on a teammate's machine, since this syncs. */

  function drawGraph() {
    nodeLayer.replaceChildren()
    wireLayer.replaceChildren()
    if (!graph) return

    const bySlot = new Map((board.slots ?? []).map((sl) => [sl.id, sl]))
    for (const node of graph.nodes) {
      nodeLayer.append(nodeCard(node, bySlot.get(node.id)))
    }
    for (const w of graph.wires) {
      const from = graph.nodes.find((n) => n.id === w.from)
      const to = graph.nodes.find((n) => n.id === w.to)
      if (from && to) wireLayer.append(wireEl(w, from, to))
    }
    // The draft wire lives in the same layer so it is drawn in the same space as
    // the real ones; without that it lands a whole zoom factor away from the port.
    wireLayer.append(draftPath)
    sayChains()
  }

  /** A wire, plus a fat invisible line over it so it can actually be clicked. */
  function wireEl(w, from, to) {
    const a = outPointOf(from)
    const b = inPointOf(to)
    const d = wirePathOf(a, b)
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    g.setAttribute('class', 'board__wire')
    const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    hit.setAttribute('d', d)
    hit.setAttribute('class', 'board__wire-hit')
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    line.setAttribute('d', d)
    line.setAttribute('class', 'board__wire-line')
    g.append(hit, line)
    /*
     * pointerdown, not click.
     *
     * The scroller starts a pan on any pointerdown that is not on a node, and
     * panning takes pointer capture — which RETARGETS the click that follows to
     * the scroller. So the wire's own click handler never ran, and clicking a
     * wire did nothing at all with nothing in the console to say why.
     */
    g.addEventListener('pointerdown', async (e) => {
      e.stopPropagation()
      e.preventDefault()
      const r = await api('wire/delete', { wireId: w.id })
      if (r.graph) {
        graph = r.graph
        if (r.board) board = r.board
        if (r.progress) progress = r.progress
        drawGraph()
        says(status, 'Unwired. The shot after it now starts its own run.', 'warn')
      }
    })
    g.setAttribute('title', 'Click to unwire')
    return g
  }

  /**
   * One node: what the shot must show, its takes, and its two ports.
   *
   * Positioned in canvas units. Everything inside is ordinary DOM, which is why
   * the wires are a separate SVG layer rather than this being drawn into one.
   */
  function nodeCard(node, slot) {
    const { root: card, el: nodeBits } = mountRow('board-node')
    if (selected === node.id) card.classList.add('board__node--selected')
    card.style.left = `${node.x}px`
    card.style.top = `${node.y}px`
    card.dataset.node = node.id

    const takes = (board.takes ?? []).filter((t) => t.slotId === node.id)
    const chosen = slot ? chosenFor(slot) : null

    nodeBits.name.textContent = node.name || 'Untitled'
    if (node.intent) {
      nodeBits.intent.hidden = false
      nodeBits.intent.textContent = node.intent
    }
    const flag = nodeBits.flag
    if (!takes.length) {
      flag.classList.add('board__flag--empty')
      flag.textContent = 'nothing shot yet'
    } else if (!chosen) {
      flag.classList.add('board__flag--open')
      flag.textContent = `${takes.length} take${takes.length === 1 ? '' : 's'}, undecided`
    } else {
      flag.classList.add('board__flag--set')
      flag.textContent = board.picks?.[node.id] ? 'chosen' : 'leading on ratings'
    }
    if (node.seconds) {
      nodeBits.target.hidden = false
      nodeBits.target.textContent = `${node.seconds}s`
    }

    const choose = nodeBits.choose
    setLabel(choose, selected === node.id ? 'Selected' : 'Select')
    choose.setAttribute('aria-pressed', String(selected === node.id))
    choose.onclick = (event) => {
      event.stopPropagation()
      select(node.id)
    }

    const edit = nodeBits.edit
    edit.title = `Build the visual scene for “${node.name || 'this scene'}”`
    edit.onclick = (event) => {
      event.stopPropagation()
      openBoardScene = { id: node.id, name: slot?.name ?? node.name ?? '', intent: slot?.intent ?? node.intent ?? '', scene: slot?.scene ?? '', takeId: chosen?.id ?? null }
      openScene = openBoardScene.scene || ''
      go('scenes')
    }
    const reviewFootage = nodeBits.reviewFootage
    reviewFootage.title = `Choose the exact recorded passage for “${node.name || 'this scene'}”`
    reviewFootage.onclick = (event) => {
      event.stopPropagation()
      openBoardScene = { id: node.id, name: slot?.name ?? node.name ?? '', intent: slot?.intent ?? node.intent ?? '', scene: slot?.scene ?? '', takeId: chosen?.id ?? null }
      openScene = openBoardScene.scene || ''
      go('scenes')
    }
    const remove = nodeBits.remove
    remove.title = `Delete “${node.name || 'this scene'}” from the canvas`
    let deleteArmed = false
    let deleteTimer = null
    const disarmDelete = () => {
      deleteArmed = false
      clearTimeout(deleteTimer)
      setLabel(remove, 'Delete')
      remove.title = `Delete “${node.name || 'this scene'}” from the canvas`
    }
    remove.onclick = async (event) => {
      event.stopPropagation()
      if (!deleteArmed) {
        deleteArmed = true
        setLabel(remove, 'Click again to delete')
        remove.title = `Delete “${node.name || 'this scene'}” and its attached takes`
        deleteTimer = setTimeout(disarmDelete, DISARM_MS)
        return
      }
      const takesCount = takes.length
      remove.disabled = true
      setLabel(remove, takesCount ? `Deleting ${takesCount} take${takesCount === 1 ? '' : 's'}…` : 'Deleting…')
      const result = await api('node/delete', { nodeId: node.id })
      if (result.error) {
        remove.disabled = false
        disarmDelete()
        says(status, result.error, 'bad')
        return
      }
      if (selected === node.id) selectedBoardNode = selected = null
      took(result)
    }

    /*
     * The winning take's frame, and nothing else.
     *
     * A node is 360 units wide; stacking every take inside one would make the
     * board a wall of thumbnails and the running order impossible to read across.
     * The node shows what it currently IS, and the rail shows the alternatives
     * once you select it — which is the split the reference canvas uses too.
     */
    if (slot?.scene) {
      /* The component scene is part of this shot, not an invisible file behind
         the card. Show the live title/shader/image treatment; a video poster is
         the fallback when there is no authored scene yet. */
      const shot = nodeBits.scenePreview
      shot.hidden = false
      const sceneFrame = Object.assign(nodeBits.sceneFrame, {
        src: `/api/scene/frame?project=${encodeURIComponent(proj.value)}&scene=${encodeURIComponent(slot.scene)}`,
        title: `${node.name || 'Scene'} preview`,
      })
      /*
       * A saved scene has deterministic time, but older Studio servers still
       * serve their frame document at t=0 — exactly when every animated title
       * is intentionally invisible. Seek from the canvas as well as the server
       * document so a hot-reloaded client shows a real title treatment even
       * before the desktop app has restarted its local server.
       */
      let previewTries = 0
      const showSceneFrame = () => {
        const seek = sceneFrame.contentWindow?.RM?.seek
        if (typeof seek === 'function') return seek(1100)
        if (previewTries++ < 20) setTimeout(showSceneFrame, 50)
      }
      sceneFrame.addEventListener('load', showSceneFrame)
      nodeBits.sceneLabel.textContent = chosen ? 'scene + video' : 'scene preview'
    } else if (chosen) {
      const shot = nodeBits.shot
      shot.hidden = false
      shot.style.backgroundImage = `url('/thumb/${proj.value}/${encodeURI(chosen.rel)}')`
      const len = Math.max(0, (chosen.outSec ?? 0) - (chosen.inSec ?? 0))
      nodeBits.len.textContent = clock(len)
    } else {
      nodeBits.emptyNote.hidden = false
      nodeBits.emptyNote.textContent = takes.length ? `${takes.length} take${takes.length === 1 ? '' : 's'} — none chosen` : 'no footage yet'
    }

    // Ports: out of the right edge, into the left. Both at the vertical middle,
    // which is what lets the wire leave horizontally and read as a cable.
    const inPort = nodeBits.inPort
    const outPort = nodeBits.outPort
    inPort.dataset.in = node.id
    outPort.dataset.out = node.id

    outPort.addEventListener('pointerdown', (e) => {
      e.stopPropagation()
      e.preventDefault()
      startWire(node, e)
    })

    card.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.board__port, button, input, select, textarea')) return
      select(node.id)
      startDrag(node, e)
    })
    // A click is a second, drag-free selection path. Pointerdown starts a drag so
    // that canvas movement stays responsive; this makes a normal click explicit
    // even in layouts where the inspector rail is below the fold.
    card.addEventListener('click', (e) => {
      if (!e.target.closest('.board__port, button, input, select, textarea')) select(node.id)
    })
    return card
  }

  /* ── dragging a node ── */

  let dragging = null
  function startDrag(node, e) {
    // The pointer is captured on the SCROLLER rather than the card, because the
    // card is re-created on every repaint — capture on an element that is about
    // to be replaced is capture that silently stops working mid-drag.
    dragging = { id: node.id, dx: e.clientX, dy: e.clientY, x0: node.x, y0: node.y, moved: false }
    scroller.setPointerCapture(e.pointerId)
  }

  /* ── dragging a wire ── */

  const SVG_NS = 'http://www.w3.org/2000/svg'
  const draftPath = document.createElementNS(SVG_NS, 'path')
  draftPath.setAttribute('class', 'board__wire-draft')
  draftPath.setAttribute('d', '')

  let wiring = null
  function startWire(node, e) {
    wiring = { from: node.id, ok: true }
    scroller.setPointerCapture(e.pointerId)
    draftPath.classList.remove('board__wire-draft--bad')
  }

  /** Screen coordinates to canvas units — the one conversion everything else avoids. */
  function toCanvas(clientX, clientY) {
    const box = surface.getBoundingClientRect()
    return { x: (clientX - box.left) / zoom, y: (clientY - box.top) / zoom }
  }

  const outPointOf = (n) => ({ x: n.x + NODE_W, y: n.y + NODE_H / 2 })
  const inPointOf = (n) => ({ x: n.x, y: n.y + NODE_H / 2 })

  /*
   * A cubic Bézier with horizontal control points, and a floor on the reach.
   *
   * Horizontal because every port leaves sideways, so the curve reads as a cable
   * rather than a diagonal. The floor stops a wire between two touching nodes
   * collapsing into a straight line drawn through both of them.
   */
  const wirePathOf = (a, b) => {
    const reach = Math.max(48, Math.abs(b.x - a.x) * 0.5)
    return `M ${a.x} ${a.y} C ${a.x + reach} ${a.y}, ${b.x - reach} ${b.y}, ${b.x} ${b.y}`
  }

  /** What the running order looks like right now, said only when it is surprising. */
  function sayChains() {
    if (!graph?.wires) return
    const starts = graph.nodes.filter((n) => !graph.wires.some((w) => w.to === n.id))
    // One start is a video. Two is nearly always a wire somebody meant to
    // reconnect, and the board looks identical either way — so it is said.
    if (starts.length > 1 && graph.nodes.length > 1) {
      says(status, `${starts.length} separate runs on this board — wire them together to make one video.`, 'warn')
    }
  }

  /**
   * Which take wins, computed here the same way the server computes it.
   *
   * Duplicated deliberately and kept tiny: the panel has to draw the answer
   * before a round trip, and the alternative is a card that flashes the old state
   * on every rating. The server stays the authority — this is what gets painted,
   * and the next response overwrites it.
   */
  function chosenFor(slot) {
    const picked = board.picks?.[slot.id]
    if (picked) {
      const t = (board.takes ?? []).find((x) => x.id === picked)
      if (t) return t
    }
    const ranked = (board.takes ?? [])
      .filter((t) => t.slotId === slot.id)
      .map((t) => ({ t, ...scoreFor(t.id) }))
      .filter((r) => r.count > 0 && r.mean > 0)
    if (!ranked.length) return null
    ranked.sort((a, b) => b.mean - a.mean || String(a.t.addedAt ?? '').localeCompare(String(b.t.addedAt ?? '')))
    return ranked[0].t
  }

  /** The mean of the latest rating from each person — see scoreOf in storyboard.mjs. */
  function scoreFor(takeId) {
    const latest = new Map()
    for (const r of board.ratings ?? []) {
      if (r.takeId !== takeId) continue
      const prev = latest.get(r.by)
      if (!prev || String(r.at ?? '') >= String(prev.at ?? '')) latest.set(r.by, r)
    }
    const votes = [...latest.values()]
    if (!votes.length) return { mean: null, count: 0, votes }
    const score = (id) => ratingMeta.find((x) => x.id === id)?.score ?? 0
    return { mean: votes.reduce((n, v) => n + score(v.rating), 0) / votes.length, count: votes.length, votes }
  }

  /** One candidate: what it looks like, how long it runs, what people think. */
  function takeCard(slot, take, isChosen) {
    const { root: card, el: takeBits } = mountRow('board-take')
    if (isChosen) card.classList.add('board__take--chosen')
    const len = Math.max(0, (take.outSec ?? 0) - (take.inSec ?? 0))

    const shot = takeBits.shot
    /*
     * A frame from the take, not an icon.
     *
     * The whole panel exists so takes can be compared by looking at them, and two
     * grey rectangles labelled capture-1787 and capture-1791 cannot be compared at
     * all. The thumb route already renders a poster for any catalogued file.
     */
    shot.style.backgroundImage = `url('/thumb/${proj.value}/${encodeURI(take.rel)}')`
    takeBits.len.textContent = clock(len)
    if (isChosen) {
      takeBits.badge.hidden = false
      takeBits.badge.textContent = board.picks?.[slot.id] ? 'chosen' : 'leading'
    }
    takeBits.name.textContent = take.rel.split('/').pop()
    takeBits.span.textContent = `${clock(take.inSec ?? 0)} → ${clock(take.outSec ?? 0)}`

    const { mean, count, votes } = scoreFor(take.id)
    const rate = takeBits.rate
    const mine = votes.find((v) => v.by === me)?.rating ?? null
    for (const r of ratingMeta) {
      const b = mountRow('board-vote').root
      if (mine === r.id) b.classList.add('board__vote--mine')
      b.textContent = r.label
      b.title = `${r.label} — ${r.hint}`
      b.onclick = async () => {
        // Optimistic, then corrected. A rating is the most-repeated action here
        // and a round trip between click and colour makes the panel feel broken.
        b.classList.add('board__vote--mine')
        took(await api('rate', { takeId: take.id, rating: r.id }))
      }
      rate.append(b)
    }

    if (count) {
      takeBits.tally.hidden = false
      takeBits.score.textContent = mean.toFixed(1)
      // "one opinion" rather than "1 vote": a single rating is not a consensus
      // and the wording should not let it look like one.
      takeBits.votes.textContent = count === 1 ? `one opinion · ${votes[0].by}` : `${count} people`
      takeBits.tally.title = votes.map((v) => `${v.by}: ${v.rating}`).join('\n')
    }

    const pick = takeBits.pick
    const isPicked = board.picks?.[slot.id] === take.id
    setLabel(pick, isPicked ? 'Unpick' : 'Use this one')
    pick.onclick = async () => took(await api('pick', { slotId: slot.id, takeId: isPicked ? null : take.id }))
    return card
  }

  /** Offer a clip for this shot. */
  function addTakeCard(slot) {
    const { root: card, el: adder } = mountRow('board-add-take')
    const files = footage()
    if (!files.length) {
      adder.note.hidden = false
      return card
    }
    for (const part of [adder.head, adder.pickFile, adder.row]) part.hidden = false
    const pickFile = adder.pickFile
    pickFile.append(new Option('Choose a clip…', ''))
    for (const f of files) {
      pickFile.append(new Option(`${f.name} · ${clock(f.media?.durationSec ?? 0)}`, f.rel))
    }
    const from = adder.from
    const to = adder.to
    const add = adder.add
    /*
     * This card says what happened, on the card.
     *
     * It reported into the panel's shared `status`, which lives at the top of the
     * rail — so "Choose a clip first" or "no such footage" was written somewhere
     * off screen while the button under the pointer did nothing visible. A
     * control that refuses has to say so where it was pressed.
     */
    const said = adder.said
    const tell = (message, kind) => {
      said.hidden = false
      tone(said, kind)
      said.textContent = message
      says(status, message, kind)
    }
    add.onclick = async () => {
      if (!pickFile.value) {
        tell('Choose a clip first.', 'bad')
        return
      }
      const f = files.find((x) => x.rel === pickFile.value)
      add.disabled = true
      const was = add.textContent
      setLabel(add, 'Adding…')
      const r = await api('take', {
        slotId: slot.id,
        rel: pickFile.value,
        inSec: Number(from.value) || 0,
        // Blank "to" means the rest of the file, which is the common case for a
        // capture made for exactly this shot.
        outSec: Number(to.value) || f?.media?.durationSec || 0,
        durationSec: f?.media?.durationSec ?? null,
      }).catch((error) => ({ error: error.message }))
      add.disabled = false
      setLabel(add, was)
      if (r?.error) tell(r.error, 'bad')
      else if (took(r)) tell('Take added.', 'ok')
    }
    adder.head.textContent = `Add a take for "${slot.name}"`
    return card
  }

  /* ── the rail: the brief, and who you are ── */

  const briefBox = control('textarea', {
    className: 'board__brief',
    rows: 10,
    placeholder: 'One shot per line:\n\nOpen on the problem — the manual way, slowly — 6s\nThe guide appears — it writes itself — 8s\nClose — logo — 3s',
  })

  /**
   * The shot list, as lines rather than as a form.
   *
   * A repeating three-field form for something people want to write in one go is
   * the wrong shape — you type a shot list the way you'd type it in a notebook.
   * The separator is an em or en dash, which is what somebody writing this
   * naturally reaches for, and a trailing "6s" is read as the target length.
   */
  function parseShots(text) {
    return String(text)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(/\s+[—–-]\s+/)
        const name = (parts.shift() ?? '').trim()
        let seconds = null
        const last = parts[parts.length - 1]
        const m2 = last && /^(\d+(?:\.\d+)?)\s*s(?:ec(?:onds)?)?$/i.exec(last.trim())
        if (m2) {
          seconds = Number(m2[1])
          parts.pop()
        }
        return { name, intent: parts.join(' — ').trim(), seconds }
      })
      .filter((s) => s.name)
  }

  function paintRail() {
    const side = $('.op-page__sidebar--right')
    if (side) side.replaceChildren()
    const rail = mountRow('rail-form').root
    const f = mountRow('control-form').root

    /*
     * The selected node's takes, first.
     *
     * They used to stack inside the node itself, which at 360 units wide made
     * the board a wall of thumbnails with the running order unreadable across
     * it. The node shows what the shot currently IS; the rail is where you
     * compare the alternatives — the same split the reference canvas uses.
     */
    const node = graph?.nodes.find((n) => n.id === selected)
    if (node) {
      const slot = (board.slots ?? []).find((x) => x.id === node.id)
      /*
       * The node's own fields, edited here rather than on the card.
       *
       * On the card they would be three inputs inside 360 units that you cannot
       * click without starting a drag — the card is a thing you MOVE, so it
       * cannot also be a thing you type into. The rail is where the selected
       * thing is edited, which is the same split the reference canvas uses.
       */
      const nf = mountRow('control-form').root
      const nName = control('input', { value: node.name ?? '' })
      const nIntent = control('input', { value: node.intent ?? '', placeholder: 'what this shot has to show' })
      const nSecs = control('number', { min: 0, step: 0.5, value: node.seconds ?? '', placeholder: 'seconds' })
      field(nf, 'Shot', nName, null)
      field(nf, 'Has to show', nIntent, null)
      field(nf, 'Target length', nSecs, 'Advisory — a take is not rejected for missing it.')

      const saveNode = async () => {
        const r = await api('node/update', {
          nodeId: node.id,
          name: nName.value,
          intent: nIntent.value,
          seconds: nSecs.value === '' ? null : nSecs.value,
        })
        if (r.error) {
          says(status, r.error, 'bad')
          return
        }
        board = r.board
        graph = r.graph
        progress = r.progress
        // Repaint the board, not the rail: re-rendering the rail mid-edit would
        // replace the input under the cursor and lose the caret.
        drawGraph()
        says(status, 'Saved.', 'ok')
      }
      // On blur rather than on every keystroke — one write per edit, not one per
      // letter, on a file that syncs.
      for (const f2 of [nName, nIntent, nSecs]) f2.onchange = saveNode

      const del = control('button', { className: 'btn btn--small', textContent: 'Delete this shot' })
      del.onclick = async () => {
        const takes = (board.takes ?? []).filter((t) => t.slotId === node.id).length
        const ok = confirm(takes ? `Delete "${node.name}" and its ${takes} take${takes === 1 ? '' : 's'}? The shot before it will lead to the shot after. Every rating stays in history.jsonl.` : `Delete "${node.name}"? The shot before it will lead to the shot after.`)
        if (!ok) return
        const r = await api('node/delete', { nodeId: node.id })
        if (r.error) {
          says(status, r.error, 'bad')
          return
        }
        board = r.board
        graph = r.graph
        progress = r.progress
        select(null)
        paint()
        says(status, 'Deleted, and the chain healed around it.', 'warn')
      }
      const editScene = control('button', { className: 'btn ghost btn--small', textContent: 'Open scene editor' })
      editScene.onclick = () => {
        openBoardScene = { id: node.id, name: slot?.name ?? node.name ?? '', intent: slot?.intent ?? node.intent ?? '', scene: slot?.scene ?? '', takeId: chosenFor(slot)?.id ?? null }
        openScene = openBoardScene.scene || ''
        go('scenes')
      }
      const reviewFootage = control('button', { className: 'btn ghost btn--small', textContent: 'Review footage' })
      reviewFootage.onclick = () => {
        openBoardScene = { id: node.id, name: slot?.name ?? node.name ?? '', intent: slot?.intent ?? node.intent ?? '', scene: slot?.scene ?? '', takeId: chosenFor(slot)?.id ?? null }
        openScene = openBoardScene.scene || ''
        go('scenes')
      }
      fieldRow(nf, editScene, reviewFootage, del)
      rail.append(nf, mountRow('board-rail-sep').root)
      if (slot) {
        const stack = mountRow('board-stack').root
        const takes = (board.takes ?? []).filter((t) => t.slotId === slot.id).sort((a, b) => String(b.addedAt ?? '').localeCompare(String(a.addedAt ?? '')))
        const chosen = chosenFor(slot)
        for (const t of takes) stack.append(takeCard(slot, t, chosen?.id === t.id))
        stack.append(addTakeCard(slot))
        rail.append(stack)
      }
      rail.append(mountRow('board-rail-sep').root)
    }

    field(f, 'The shots', briefBox, 'One per line. "Name — what it has to show — 6s". This is the brief, and it is what the board is columns of.')
    if (board?.brief?.shots?.length && !briefBox.value) {
      briefBox.value = board.brief.shots.map((s) => [s.name, s.intent, s.seconds ? `${s.seconds}s` : null].filter(Boolean).join(' — ')).join('\n')
    }
    const applyBrief = control('button', { textContent: 'Set the shot list' })
    applyBrief.onclick = async () => {
      const shots = parseShots(briefBox.value)
      if (!shots.length) {
        says(status, 'Write at least one shot — a name is enough.', 'bad')
        return
      }
      /*
       * Renaming a shot orphans its takes, and that is said before it happens.
       *
       * Slot ids derive from order and name, so an edited name is a new column —
       * which is the safe direction (a take never silently moves under a shot
       * nobody offered it for) and is surprising if nobody warned you.
       */
      const known = new Set((board?.slots ?? []).map((s) => s.name))
      const renamed = board?.slots?.length && shots.some((s) => !known.has(s.name))
      if (renamed && (board.takes ?? []).length) {
        const ok = confirm('Some shot names changed. Takes stay attached to the old shot rather than moving to a renamed one, so they will need re-adding. Continue?')
        if (!ok) return
      }
      const r = await api('slots', { brief: { ...(board?.brief ?? {}), drafted: new Date().toISOString(), shots } })
      if (took(r)) says(status, `${shots.length} shot${shots.length === 1 ? '' : 's'} on the board.`, 'ok')
    }
    fieldRow(f, applyBrief)

    const who = control('input', { value: me, placeholder: 'your name' })
    field(f, 'Your ratings are signed', who, 'Ratings are opinions with a name on them. This is the name.')
    who.onchange = async () => {
      const r = await fetch('/api/board/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reviewer: who.value }),
      }).then((x) => x.json())
      me = r.me
      paint()
    }

    const syncPick = control('select')
    for (const a of syncInfo.adapters ?? []) {
      syncPick.append(new Option(a.label, a.id))
    }
    syncPick.value = syncInfo.chosen
    const syncHint = control('hint')
    /*
     * The setup, revealed only when you are asking for it.
     *
     * Four fields, a sign-in and a test is a lot to have permanently in a rail
     * beside a board — and every one of them is meaningless while sharing is off.
     */
    const setup = mountRow('board-setup').root
    const saySync = () => {
      const a = (syncInfo.adapters ?? []).find((x) => x.id === syncPick.value)
      if (!a) return
      const sharing = syncPick.value !== 'local'
      setup.hidden = !sharing
      /*
       * Names the ONE thing to fix, not a list.
       *
       * Told "URL, key, team and sign-in are all missing", somebody fixes four
       * things and finds out at the end whether the first was right. The server
       * checks them in order and returns the first failure, so each answer gets
       * checked as it arrives.
       */
      /*
       * Two different "not yet"s, and only one of them is a fault.
       *
       * A build with nowhere to sync to is broken until somebody edits a file.
       * A build nobody has signed into is working exactly as intended and is one
       * form away from done. Saying "Not yet:" to both made an ordinary sign-in
       * look like a misconfiguration — and printed the same sentence the field
       * below was already showing.
       */
      const needsSetup = a.problem && !/signed in/.test(a.problem)
      tone(syncHint, a.ready ? 'ok' : needsSetup ? 'warn' : '')
      syncHint.textContent = needsSetup ? `${a.detail}\n\nNot yet: ${a.problem}` : a.detail
    }
    syncPick.onchange = async () => {
      await fetch('/api/board/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sync: syncPick.value }),
      })
      await refreshSharing()
    }
    field(f, 'Shared with', syncPick, null)
    f.append(syncHint, setup)

    /* ── the sharing setup ── */

    /*
     * An email, and nothing else.
     *
     * This asked for a project URL, an anon key and a team id first — three
     * pieces of DEPLOYMENT configuration, identical for everyone on the team,
     * impossible to verify from inside the app, and asked once per machine
     * forever. Somebody's first experience of working with their colleagues
     * should not be pasting a JWT.
     *
     * Those now live in lib/supabase-config.mjs, set once by whoever runs the
     * Supabase project. What is left here is the only part that is actually
     * about the person at the keyboard.
     */
    const sbWho = control('hint')
    const sf = control('div')
    /* Said beside the button, for the same reason the take card says its own
       piece: the shared status is at the top of the rail, and a refusal written
       there reads as a button that does nothing. */
    const sbSaid = control('hint', { hidden: true })
    const sbTell = (message, kind) => {
      sbSaid.hidden = false
      tone(sbSaid, kind)
      sbSaid.textContent = message
      says(status, message, kind)
    }

    /*
     * One way in, and it is the account people already have.
     *
     * Email and a password meant a second credential to invent and remember for
     * a tool that already knows which team you are on, and the first person on a
     * project met "Invalid login credentials" against an account that had never
     * been created. Slack is the answer to both.
     *
     * A full-page navigation rather than a popup: the browser has to leave and
     * come back with a code, and a popup is the thing a browser blocks. Studio
     * is a local page with nothing unsaved on it, so leaving costs nothing.
     */
    const slackIn = mountRow('board-slack-sign-in').root
    slackIn.onclick = async () => {
      slackIn.disabled = true
      const r = await fetch('/api/board/oauth/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'slack_oidc', origin: location.origin }),
      })
        .then(responseJson)
        .catch(() => ({ error: 'the Studio did not answer — is it still running on this port?' }))
      slackIn.disabled = false
      if (r.error) return sbTell(r.error, 'bad')
      location.assign(r.url)
    }

    const btnRow = mountRow('board-setup-acts').root
    btnRow.append(slackIn)
    fieldRow(sf, btnRow)
    sf.append(sbSaid, sbWho)
    setup.append(sf)

    /**
     * Re-read what the server thinks, rather than guessing from what we sent.
     *
     * The two states worth telling apart: this build has nowhere to sync to
     * (somebody edits one file, once), versus nobody has signed in here yet
     * (you type your email). Different people fix them, so they never share a
     * sentence.
     */
    const refreshSharing = async () => {
      const [sh, bd] = await Promise.all([fetch('/api/board/sharing').then((x) => x.json()), fetch(`/api/board?project=${encodeURIComponent(proj.value)}`).then((x) => x.json())])
      const configured = Boolean(sh.url)
      /*
       * The credentials disappear once they have been used.
       *
       * A form still sitting there after you signed in reads as a form that did
       * not work — you look at it, wonder whether to press it again, and the one
       * thing on screen is the thing you have already done. Signed in is a
       * finished state; what belongs there is who you are and a way back out.
       */
      const askingForCredentials = configured && !sh.signedInAs
      slackIn.hidden = !askingForCredentials
      // The sidebar carries signing out now, and has to hear about a sign-in here.
      void paintSignOut()
      // The row itself goes when it holds nothing, or its padding leaves a gap
      // where the form used to be.
      btnRow.closest('.form-group')?.style.setProperty('display', configured ? '' : 'none')
      tone(sbWho, sh.signedInAs ? 'ok' : configured ? '' : 'warn')
      sbWho.textContent = sh.signedInAs ? `` : configured ? 'Sign in and this board is shared with everyone on the team.' : ''
      sbWho.hidden = !sbWho.textContent
      if (bd.sync) syncInfo = bd.sync
      saySync()
    }
    void refreshSharing()

    /*
     * Pull whatever other people did, and push what you did.
     *
     * Manual as well as polled: somebody who has just been told a teammate rated
     * something wants it now, and waiting out a poll interval while looking at a
     * stale board is the moment a sync feature stops being trusted.
     */
    const syncNow = control('button', { className: 'btn btn--small', textContent: 'Sync now' })
    syncNow.onclick = async () => {
      says(status, 'Syncing…')
      const r = await api('sync', {})
      if (r.error) {
        says(status, r.error, 'bad')
        return
      }
      if (!r.synced) {
        says(status, r.reason ?? 'Sharing is off — this board is on this machine only.', 'warn')
        return
      }
      board = r.board
      progress = r.progress
      paint()
      says(status, 'Up to date with the team.', 'ok')
    }
    fieldRow(f, syncNow)

    const { root: zoomRow, el: zoomBits } = mountRow('board-zoom')
    zoomBits.label.replaceWith(zoomLabel)
    zoomBits.out.onclick = () => setZoom(zoom * 0.9)
    zoomBits.inn.onclick = () => setZoom(zoom * 1.1)
    zoomBits.fit.onclick = () => setZoom(1)
    field(f, 'Zoom', zoomRow, 'Cmd-scroll on the board does this too. Drag the background to pan.')

    rail.append(f)
    intoRail(rail)
  }

  const zoomLabel = control('span', { className: 'board__zoom-label', textContent: '100%' })

  /* ── the footer: the one action ── */

  /*
   * Add a shot, from the canvas.
   *
   * The shot list in the rail REPLACES every shot, because it is the brief — so
   * it cannot be how you add a fourth one to three you have already shot takes
   * against. This adds one without touching the others.
   */
  const addNode = control('button', { textContent: 'Add a shot' })
  addNode.onclick = async () => {
    const r = await api('node/add', { name: 'New shot' })
    if (r.error) {
      says(status, r.error, 'bad')
      return
    }
    board = r.board
    graph = r.graph
    progress = r.progress
    paint()
    // Selected on arrival, so the rail is already showing the fields to name it
    // in — a node called "New shot" is not finished, and this is where you finish it.
    select(r.nodeId)
    says(status, 'Added. Name it in the panel, then wire it where it belongs.', 'ok')
  }

  const cutName = control('input', { placeholder: 'rough-cut', value: 'rough-cut' })
  /*
   * The finished video, without opening an editor.
   *
   * Building the cut used to hand you a HyperFrames project and nothing else, so
   * every video — including one nobody wanted to hand-edit — went through a
   * visual timeline. The cut route returns a ready render step now; this runs it
   * as an ordinary Console job and stays on the page. The editor is still one
   * button away for the times an edit is genuinely wanted.
   */
  const renderCut = control('button', { className: 'btn btn--primary', textContent: 'Build and render MP4' })
  renderCut.onclick = async () => {
    renderCut.disabled = true
    build.disabled = true
    renderCut.textContent = 'Building the cut…'
    const r = await api('cut', { name: cutName.value }).catch((error) => ({ error: error.message }))
    const done = (message, kind) => {
      renderCut.disabled = false
      build.disabled = false
      renderCut.textContent = 'Build and render MP4'
      if (message) says(status, message, kind)
    }
    if (r.error) return done(r.error, 'bad')
    if (!r.renderStep) {
      // An older server on this port answers the cut without a step. Say which,
      // rather than letting the button look broken.
      return done('This Studio is running an older server that cannot render from here — restart it, or open the cut in HyperFrames.', 'bad')
    }
    renderCut.textContent = 'Rendering…'
    const skipped = r.missingScenes?.length ? ` ${r.missingScenes.length} scene${r.missingScenes.length === 1 ? '' : 's'} could not be read and were left out.` : ''
    says(status, `Cut built — ${r.clips} shot${r.clips === 1 ? '' : 's'}.${trimNote(r.trimmed)} Rendering the MP4; progress is in Console.${skipped}`, skipped ? 'warn' : 'ok')
    const job = await start(r.renderStep, { status })
    done(job ? null : 'The render did not start.', job ? null : 'bad')
  }

  const build = control('button', { className: 'btn ghost', textContent: 'Build the cut in HyperFrames' })
  build.onclick = async () => {
    build.disabled = true
    setLabel(build, 'Building…')
    const r = await api('cut', { name: cutName.value }).catch((error) => ({ error: error.message }))
    if (r.error) {
      build.disabled = false
      setLabel(build, 'Build the cut in HyperFrames')
      says(status, r.error, 'bad')
      return
    }
    /*
     * Said BEFORE the handover, because the handover navigates.
     *
     * openHyperframesProject ends in go('hyperframes'), and render() empties
     * #main — so `build` and `status` are detached by the time it resolves, and
     * every line written to them afterwards landed on an orphan nobody could
     * see. The message is handed to the destination instead, the same way
     * pendingClip and pendingWallpaper hand work to Cut and Wallpapers.
     */
    const canvasScenes = r.scenes ? ` with ${r.scenes} Canvas scene${r.scenes === 1 ? '' : 's'}` : ''
    const shots = `${r.clips} picked shot${r.clips === 1 ? '' : 's'}`
    /* Singular subject, singular verb. "1 picked shot are open" read as a bug in
       the one case a single-slot board is the whole point. */
    const verb = r.clips === 1 && !r.scenes ? 'is' : 'are'
    /*
     * A skipped scene is said, not swallowed. The server keeps building when a
     * pick's scene HTML has gone (renamed or deleted) and returns the labels it
     * dropped; without this the toast reported a clean build and the overlay was
     * simply missing in HyperFrames with nothing to explain it.
     */
    const missing = r.missingScenes?.length ? ` ${r.missingScenes.length} scene${r.missingScenes.length === 1 ? '' : 's'} could not be read and ${r.missingScenes.length === 1 ? 'was' : 'were'} left out: ${r.missingScenes.join(', ')}.` : ''
    pendingHandoffNote = { text: `${shots}${canvasScenes} ${verb} open in HyperFrames.${missing}`, tone: missing ? 'warn' : 'ok' }

    const opened = await openHyperframesProject(r.hyperframesProject, build, status)
    if (!opened) {
      // The navigation never happened, so the note has no destination to reach.
      pendingHandoffNote = null
      build.disabled = false
      setLabel(build, 'Build the cut in HyperFrames')
    }
  }
  intoFooter(addNode, cutName, renderCut, build)

  void load()
}

function vCut(m) {
  const ui = mountPanel('cut', m)
  const f = ui.form
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
  const name = field(f, 'Save as', control('input', { placeholder: 'rough-cut' }), 'The document lands in Renders under this name.')

  const { root: shelf, el: shelfBits } = mountRow('cut-shelf')
  const list = mountRow('compose-list').root
  const titleList = mountRow('cut-title-list').root
  const bar = mountRow('control-row').root
  const out = control('pre')
  out.style.display = 'none'
  const status = control('status')
  const titleHead = mountRow('cut-title-head').root
  f.append(shelf, list, titleHead, titleList, bar, status, out)

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
    const { root: row, el: card } = mountRow('cut-clip')
    const body = card.body
    card.title.textContent = `${i + 1}. ${c.rel}`
    card.up.disabled = i === 0
    card.up.onclick = () => {
      clips.splice(i - 1, 0, clips.splice(i, 1)[0])
      paint()
    }
    card.down.disabled = i === clips.length - 1
    card.down.onclick = () => {
      clips.splice(i + 1, 0, clips.splice(i, 1)[0])
      paint()
    }
    card.dup.onclick = () => {
      clips.splice(i + 1, 0, { ...c, inSec: c.outSec ?? 0, outSec: c.durationSec })
      paint()
    }
    card.kill.onclick = () => {
      clips.splice(i, 1)
      paint()
    }

    /*
     * The trim is folded away.
     *
     * It works, and it is not what this panel is for any more: the editor has a
     * real timeline — drag-to-reorder, trim handles that snap at every zoom,
     * waveforms per clip — and a second, worse one competing with it on the way in
     * is how you end up trimming in the wrong place. Open it for a rough in and out
     * when that saves a trip; leave it shut and the panel is a running order.
     */
    const { trim, strip, kept, playhead, hIn, hOut, label, at } = card
    const video = Object.assign(card.video, { src: `/media/${proj.value}/${encodeURI(c.rel)}` })

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
        setLabel(play, 'Play the trim')
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
    const play = card.play
    play.onclick = () => {
      if (playing) {
        video.pause()
        playing = false
        setLabel(play, 'Play the trim')
        return
      }
      video.currentTime = c.inSec ?? 0
      playing = true
      setLabel(play, 'Pause')
      void video.play()
    }
    card.setIn.onclick = () => {
      c.inSec = Math.min(video.currentTime, (c.outSec ?? c.durationSec) - 0.1)
      draw()
    }
    card.setOut.onclick = () => {
      c.outSec = Math.max(video.currentTime, (c.inSec ?? 0) + 0.1)
      draw()
    }
    card.whole.onclick = () => {
      c.inSec = 0
      c.outSec = c.durationSec
      video.currentTime = 0
      draw()
    }
    draw()
    return row
  }

  const paint = () => {
    list.replaceChildren()
    if (!clips.length) list.append(control('hint', { textContent: 'Nothing yet. Take a recording off the shelf above — the whole file goes in, and you trim it down from there.' }))
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
    titleList.replaceChildren()
    if (!titles.length) {
      titleList.append(control('hint', { textContent: 'None. A title sits over the footage at a moment in the finished cut — it does not push anything later.' }))
      return
    }
    titles.forEach((t, i) => {
      const { root: line, el: cell } = mountRow('cut-title')
      const put = (key) => {
        cell[key].value = t[key] ?? ''
        cell[key].oninput = () => {
          t[key] = cell[key].value
        }
      }
      put('eyebrow')
      put('text')
      put('sub')
      const num = (key, val) => {
        cell[key].value = t[key] ?? val
        cell[key].oninput = () => {
          t[key] = Number(cell[key].value) || 0
        }
      }
      num('atSec', 0)
      num('forSec', 3)
      cell.remove.onclick = () => {
        titles.splice(i, 1)
        paintTitles()
        say()
      }
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
    for (const old of shelf.querySelectorAll('.shelfclip')) old.remove()
    const files = footage()
    shelfBits.empty.hidden = files.length > 0
    if (!files.length) return
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
      const { root: chip, el: clip } = mountRow('shelf-clip')
      const img = clip.img
      img.src = `/thumb/${proj.value}/${encodeURI(file.rel)}`
      // A recording the thumbnailer cannot read leaves a broken-image glyph, which
      // reads as a corrupt file. The frame just stays empty.
      img.onerror = () => img.remove()
      clip.len.hidden = !file.media?.durationSec
      if (file.media?.durationSec) clip.len.textContent = clock(file.media.durationSec)
      clip.mute.hidden = !silent
      clip.name.textContent = file.name
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

  const addTitle = control('button', { className: 'btn ghost', textContent: 'Add a title' })
  addTitle.onclick = () => {
    titles.push({ text: '', atSec: 0, forSec: 3 })
    paintTitles()
    say()
  }
  const build = control('button', { textContent: 'Open in the editor' })
  build.onclick = async () => {
    out.style.display = 'block'
    out.textContent = 'Cutting…'
    const r = await responseJson(await fetch('/api/cut', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId: proj.value,
          name: name.value,
          clips: clips.map((c) => ({ rel: c.rel, label: c.label, inSec: c.inSec ?? 0, outSec: c.outSec, durationSec: c.durationSec })),
          titles: titles.filter((t) => String(t.text ?? '').trim()),
        }),
      }))
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

/* ── Skills ──────────────────────────────────────────────── */
function vSkills(m) {
  // The structure is in studio.html; this function fills it in.
  const { install, picker, refresh, status, list, editor, editorName, editorNote, editorField, save, close, standard, support } = mountPanel('skills', m)
  statusSink(status)

  let selected = null

  const closeEditor = () => {
    selected = null
    editor.hidden = true
  }

  const openEditor = async (skill) => {
    editor.hidden = false
    editorName.textContent = skill.name
    editorNote.textContent = 'Loading the instruction…'
    editorField.value = ''
    editorField.readOnly = true
    save.disabled = true
    const response = await fetch(`/api/skills/${encodeURIComponent(skill.slug)}`).catch((err) => ({ error: err.message }))
    const result = response.error ? response : await responseJson(response)
    if (result.error) {
      editorNote.textContent = result.error
      return
    }
    selected = result.skill
    editorField.value = selected.content || ''
    const shared = selected.source === 'shared'
    editorField.readOnly = !shared
    save.disabled = !shared
    editorNote.textContent = shared
      ? `Editing the team copy · version ${selected.version || 1}`
      : 'This bundled skill is read-only. Install its zip to make a shared, editable copy.'
  }

  const publish = async (skill, replace = false) => {
    status.textContent = `${replace ? 'Replacing' : 'Publishing'} ${skill.name} for the team…`
    const response = await fetch(`/api/skills/${encodeURIComponent(skill.slug)}/publish${replace ? '?replace=1' : ''}`, { method: 'POST' }).catch((err) => ({ error: err.message }))
    const result = response.error ? response : await responseJson(response)
    if (result.error) {
      if (result.skills?.length && confirm(`${result.error}\n\nReplace the shared copy?`)) return publish(skill, true)
      status.textContent = result.error
      return
    }
    status.textContent = `Published ${result.installed.join(' · ')} for the team.`
    await loadSkills()
  }

  const paint = (result) => {
    list.replaceChildren()
    const skills = result.studio || []
    if (!skills.length) {
      list.textContent = 'No SKILL.md files were found in the Studio skill directory.'
    } else {
      for (const skill of skills) {
        const { root, el: card } = mountRow('skill-card')
        card.name.textContent = skill.name
        card.description.textContent = skill.description || 'Shared Studio instructions.'
        card.source.textContent = skill.source === 'shared' ? 'Shared through Supabase' : 'Bundled with this Studio install'
        card.kind.textContent = skill.source === 'shared' ? 'Used automatically' : 'Fallback'
        card.edit.textContent = skill.source === 'shared' ? 'Edit' : 'View'
        card.edit.onclick = () => void openEditor(skill)
        card.publish.hidden = skill.source !== 'local'
        card.publish.onclick = () => void publish(skill)
        list.append(root)
      }
    }

    if (!result.ok) {
      support.textContent = result.why || 'HyperFrames support could not be checked.'
    } else {
      support.textContent = result.ready ? `HyperFrames skills are ready (${result.current || 0} current).` : `HyperFrames skills need attention: ${result.outdated || 0} out of date, ${result.missing || 0} missing.`
    }

    if (result.standard?.available) {
      standard.textContent = `Available from ${result.standard.root}. Claude can use ${result.standard.hyperframesSkill} for a HyperFrames composition. No symlink is needed.`
    } else {
      standard.textContent = `Not installed. Studio will keep using its bundled skills. To add Standard on this machine, place it at ${result.standard?.root || '/Users/dallas/Development/standard'} or set RM_STANDARD before launching Studio.`
    }
  }

  const loadSkills = async () => {
    refresh.disabled = true
    status.textContent = 'Checking shared skills…'
    const response = await fetch('/api/skills').catch((err) => ({ error: err.message }))
    const result = response.error ? response : await responseJson(response)
    refresh.disabled = false
    if (result.error) {
      status.textContent = result.error
      return
    }
    status.textContent = result.shared?.available
      ? `${result.shared.count || 0} shared skill${result.shared.count === 1 ? '' : 's'} synced from Supabase.`
      : `${result.studio?.length || 0} local skill${result.studio?.length === 1 ? '' : 's'} available. Sign in to share and edit skills for the team.`
    paint(result)
  }

  const upload = async (file, replace = false) => {
    install.disabled = true
    refresh.disabled = true
    status.textContent = `${replace ? 'Replacing' : 'Installing'} ${file.name}…`
    const response = await fetch(`/api/skills/upload${replace ? '?replace=1' : ''}`, {
      method: 'POST',
      headers: { 'content-type': 'application/zip' },
      body: file,
    }).catch((err) => ({ error: err.message }))
    const result = response.error ? response : await responseJson(response)
    install.disabled = false
    refresh.disabled = false
    if (result.error) {
      if (result.skills?.length && confirm(`${result.error}\n\nReplace the existing shared skill${result.skills.length === 1 ? '' : 's'}?`)) {
        return upload(file, true)
      }
      status.textContent = result.error
      return
    }
    await loadSkills()
    status.textContent = `Shared ${result.installed.join(' · ')} with every Studio project.`
  }

  install.onclick = () => picker.click()
  picker.onchange = () => {
    const file = picker.files?.[0]
    picker.value = ''
    if (file) void upload(file)
  }
  refresh.onclick = loadSkills
  close.onclick = closeEditor
  save.onclick = async () => {
    if (!selected?.slug || selected.source !== 'shared') return
    save.disabled = true
    editorNote.textContent = 'Saving for the team…'
    const response = await fetch(`/api/skills/${encodeURIComponent(selected.slug)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: editorField.value }),
    }).catch((err) => ({ error: err.message }))
    const result = response.error ? response : await responseJson(response)
    if (result.error) {
      editorNote.textContent = result.error
      save.disabled = false
      return
    }
    selected = result.skill
    editorNote.textContent = `Saved for the team · version ${selected.version}`
    save.disabled = false
    await loadSkills()
  }
  void loadSkills()
}

/* ── Brand ───────────────────────────────────────────────── */
function vBrand(m) {
  const ui = mountPanel('brand', m)

  const t = S.tokens || {}
  const pal = t.palette || {}
  for (const [id, b] of Object.entries(t.subBrands || {})) {
    const { root: c, el: swatch } = mountRow('brand-swatch')
    swatch.swatch.style.background = b.hex
    swatch.name.textContent = b.label
    swatch.meta.textContent = `${b.hex} · H${b.h} S${b.s}% L${b.l}%`
    ui.subBrands.append(c)
  }

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
  const marks = ui.marks
  const DARK_GROUND = /-(white|color-on-dark)$/
  for (const b of S.logos || []) {
    for (const [variant, v] of Object.entries(b.variants || {})) {
      if (!v) continue
      const { root: c, el: mark } = mountRow('brand-mark')
      Object.assign(mark.img, { src: `/brand/logos/${v.file}`, alt: `${b.label} — ${variant}` })
      // Grounds come from the palette in state, not from literals here: studio.js
      // is not allowed to invent a colour, and the brand's own dark and light are
      // exactly the two grounds these marks are drawn for.
      mark.ground.style.background = DARK_GROUND.test(variant) ? pal.dark || 'var(--op-color-neutral-plus-eight)' : pal.light || 'var(--op-color-neutral-plus-max)'
      mark.kind.textContent = DARK_GROUND.test(variant) ? 'on dark' : 'on light'
      mark.name.textContent = b.label
      mark.variant.textContent = variant
      mark.file.textContent = v.file
      marks.append(c)
    }
  }
  if (!marks.children.length) {
    ui.noMarks.hidden = false
  } else {
    marks.hidden = false

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
      ui.imageryHead.hidden = false
      ui.imageryHint.hidden = false
      ui.imagery.hidden = false
      for (const item of S.imagery) {
        if (!item.file) continue
        const { root: c, el: shot } = mountRow('brand-imagery')
        Object.assign(shot.img, { src: `/brand/imagery/${item.file}`, alt: item.name })
        shot.kind.textContent = `${Math.round((item.bytes || 0) / 1024)}KB`
        shot.name.textContent = item.name
        shot.file.textContent = item.file
        ui.imagery.append(c)
      }
    }
    ui.marksCount.hidden = false
    ui.marksCount.textContent = `${marks.children.length} marks · staged into every render as assets/brand/`
  }

  const { wpSel, tIn, eIn, nIn, sIn, prev } = ui
  for (const w of S.wallpapers) wpSel.append(new Option(w.label, w.file))
  const line = (className, text, style) => {
    const node = control('div', { className, textContent: text })
    node.style.cssText = style
    return node
  }
  const draw = () => {
    prev.replaceChildren()
    for (const mode of ['title', 'lower']) {
      const { root: c, el: preview } = mountRow('brand-preview')
      const box = preview.box
      box.style.backgroundImage = `url('/wallpaper/${wpSel.value}')`
      if (mode === 'title') {
        box.append(
          line('eb', eIn.value.toUpperCase(), `color:${pal.primary};font-size:var(--lt-eyebrow-size)`),
          line('ti', tIn.value, `color:${pal.light};font-size:var(--lt-title-size)`),
        )
      } else {
        box.append(
          line('t', nIn.value, `color:${pal.light};font-size:var(--lt-name-size)`),
          line('s', sIn.value, `color:${pal.tertiary};font-size:var(--lt-sub-size)`),
        )
      }
      preview.caption.textContent = mode === 'title' ? 'title()' : 'lowerThird()'
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
  const { addedGrid, addedHint } = ui

  const paintAdded = () => {
    addedGrid.replaceChildren()
    for (const item of S.added || []) {
      // A neutral ground rather than the brand's dark: an added asset is as
      // likely to be a black wordmark as a cut-out render, and previewing one on
      // its own colour shows an empty box.
      const { root: c, el: shot } = mountRow('brand-imagery')
      Object.assign(shot.img, { src: `/added/${encodeURIComponent(item.file)}`, alt: item.name })
      shot.kind.textContent = `${Math.round((item.bytes || 0) / 1024)}KB`
      shot.name.textContent = item.name
      shot.file.textContent = item.file
      c.append(
        actionMenu([
          {
            icon: 'delete-02',
            text: 'Remove',
            danger: true,
            busy: 'Removing…',
            run: async () => {
              const r = await responseJson(await fetch('/api/brand/asset/delete', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ file: item.file }),
                }))
              if (r.error) return r.error
              S = await responseJson(await fetch('/api/state'))
              paintAdded()
            },
          },
        ]),
      )
      addedGrid.append(c)
    }
    if (!(S.added || []).length) addedGrid.append(control('empty', { textContent: 'Nothing added yet.' }))
  }

  const { addDrop, addPicker } = ui
  addDrop.prepend(icon('upload-04'))

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
    S = await responseJson(await fetch('/api/state'))
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
  ui.addAction.onclick = () => addPicker.click()

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

  const wg = ui.wallGrid
  const wnew = mountRow('brand-wallpaper-new').root
  wnew.prepend(icon('add-01'))
  wnew.onclick = () => toWallpapers('')
  wg.append(wnew)

  for (const w of S.wallpapers) {
    const { root: c, el: wall } = mountRow('brand-wallpaper')
    wall.art.style.backgroundImage = `url('/wallpaper/${w.file}')`
    wall.name.textContent = w.label
    wall.file.textContent = w.file
    c.onclick = () => toWallpapers(w.name)
    wg.append(c)
  }
}

/* ── Wallpapers ──────────────────────────────────────────────
   A wallpaper is a recipe, not a hand-written CSS block. The canvas below runs
   the same lib/wallpaper.mjs the batch renderer runs, so what you see is what
   gets written — Save just re-draws it at 3840×2160 and posts the bytes. */
function vWallpapers(m) {
  const { grid, editor } = mountPanel('wallpapers', m)

  const paint = () => {
    grid.replaceChildren()
    const add = mountRow('wallpaper-new-card').root
    add.prepend(icon('add-01'))
    add.onclick = () => fresh()
    grid.append(add)
    for (const r of recipes) {
      const { root: c, el: cardEl } = mountRow('wallpaper-card')
      c.setAttribute('aria-selected', String(editing?.name === r.name))
      const cv = cardEl.cv
      cv.width = THUMB_W
      cv.height = frameHeight(THUMB_W)
      WP.draw(cv.getContext('2d'), r, cv.width, cv.height)
      cardEl.nm.textContent = r.label
      cardEl.path.textContent = r.name + '.jpg'
      c.onclick = () => openEditor(r)
      grid.append(c)
    }
  }

  openEditor = (r) => {
    editing = JSON.parse(JSON.stringify(WP.normalize(r)))
    if (!r.name) editing.name = ''
    paint()
    editor.replaceChildren()
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
    grid.append(control('empty', { textContent: 'Loading recipes…' }))
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
  const { left, cv, status, panel, save } = mountRow('wp-editor').el
  cv.width = EDITOR_W
  cv.height = frameHeight(EDITOR_W)
  statusSink(status)

  const repaint = () => WP.draw(cv.getContext('2d'), r, cv.width, cv.height)

  const sec = (t) => panel.append(control('div', { className: 'sec', textContent: t }))
  const g = () => {
    const d = control('div', { className: 'ctl' })
    panel.append(d)
    return d
  }
  const lab = (t) => Object.assign(mountRow('form-label').root, { textContent: t })

  const textRow = (box, label, get, set, ph) => {
    const i = control('input', { className: 'wide form-control', value: get() ?? '', placeholder: ph || '' })
    i.oninput = () => {
      set(i.value)
      repaint()
    }
    box.append(lab(label), i)
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
    box.append(lab(label), menu, control('span', { className: 'v' }))
    return menu
  }
  const rangeRow = (box, label, get, set, range, fmt) => {
    const i = control('input', { type: 'range', ...range, value: get(), className: 'form-control' })
    const v = control('span', { className: 'v', textContent: (fmt || String)(get()) })
    i.oninput = () => {
      set(Number(i.value))
      v.textContent = (fmt || String)(Number(i.value))
      repaint()
    }
    box.append(lab(label), i, v)
    return i
  }
  const selectRow = (box, label, opts, get, set) => {
    const s = control('select', { className: 'wide form-control' })
    for (const o of opts) s.append(new Option(o, o, false, o === get()))
    s.onchange = () => {
      set(s.value)
      repaint()
    }
    box.append(lab(label), s)
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
  const stops = control('div', { className: 'wide' })
  gb.append(lab('Stops'), stops)
  const drawStops = () => {
    stops.replaceChildren()
    r.gradient.stops.forEach((s, i) => {
      const row = control('div', { className: 'stop' })
      const c = colorMenu({
        families: brandFamilies(),
        value: s.color,
        format: 'hex',
        onPick: (v) => {
          s.color = v
          repaint()
        },
      })
      const p = control('input', { type: 'range', ...RANGE.stop, value: s.at, className: 'form-control' })
      const pv = control('span', { className: 'v', textContent: pct(s.at) })
      p.oninput = () => {
        s.at = Number(p.value)
        pv.textContent = pct(s.at)
        repaint()
      }
      const x = control('button', { className: '', textContent: '×' })
      x.onclick = () => {
        if (r.gradient.stops.length < MIN_GRADIENT_STOPS) return
        r.gradient.stops.splice(i, 1)
        drawStops()
        repaint()
      }
      row.append(c, p, pv, x)
      stops.append(row)
    })
    const add = control('button', { className: 'chip', textContent: '+ stop' })
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
  bb.append(control('div', { className: 'note wide', textContent: 'A solid line, not a fade. Bottom is one rule along the bottom edge; all draws the full frame, and only that uses Radius. Width is in px at 1920 and scales with the export, so 6px looks like 6px at 4K. Width 0 turns it off — Inset and Radius do nothing on their own.' }))
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

  save.onclick = async () => {
    if (!nameIn.value.trim()) {
      status.textContent = 'Name it first.'
      return
    }
    save.disabled = true
    setLabel(save, 'Rendering 4K…')
    // Draw the real export off-screen with the identical code path, then hand the
    // server finished bytes. No Playwright on a designer's machine.
    const big = document.createElement('canvas')
    big.width = EXPORT_W
    big.height = frameHeight(EXPORT_W)
    WP.draw(big.getContext('2d'), r, big.width, big.height)
    const jpeg = big.toDataURL('image/jpeg', EXPORT_QUALITY)
    const res = await responseJson(await fetch('/api/wallpaper', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ recipe: r, jpeg }) }))
    save.disabled = false
    setLabel(save, 'Save wallpaper')
    if (res.error) {
      status.textContent = 'Error: ' + res.error
      return
    }
    status.textContent = 'Saved ' + res.file
    const d = await responseJson(await fetch('/api/wallpapers'))
    recipes = d.wallpapers.map(WP.normalize)
    // Refresh state without re-rendering — render() would tear down this editor
    // mid-edit, which is a rotten thing to do to someone who just hit Save.
    S = await responseJson(await fetch('/api/state'))
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

/* ── Usage ──────────────────────────────────────────────────
   The Console is the transcript of one run. This is the ledger across runs:
   it reads the same persisted Claude result events, so a restart does not make
   a week of experiments look free. */
const usageNumber = (value) => new Intl.NumberFormat('en-US').format(Math.round(Number(value) || 0))
const usageMoney = (value) => '$' + (Number(value) || 0).toFixed(2)
const usageElapsed = (milliseconds) => {
  const seconds = Math.max(0, Math.round((Number(milliseconds) || 0) / 1000))
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  if (hours) return `${hours}h ${minutes % 60}m`
  if (minutes) return `${minutes}m ${seconds % 60}s`
  return `${seconds}s`
}

function vUsage(m) {
  const ui = mountPanel('usage', m)
  const { status, refresh, overview } = ui

  const stat = (label, value, note) => {
    const { root, el: card } = mountRow('usage-stat')
    card.label.textContent = label
    card.value.textContent = value
    card.note.hidden = !note
    if (note) card.note.textContent = note
    return root
  }

  const loadUsage = async () => {
    refresh.disabled = true
    status.textContent = 'Refreshing usage…'
    const report = await fetch('/api/usage').then((response) => response.ok ? response.json() : Promise.reject(new Error('Usage history could not load.'))).catch((error) => ({ error: error.message }))
    refresh.disabled = false
    overview.replaceChildren()
    for (const section of [ui.empty, ui.accounting, ui.models, ui.runs]) section.hidden = true
    for (const old of ui.models.querySelectorAll('.usage-model')) old.remove()
    ui.runList.replaceChildren()
    if (report.error) {
      tone(status, 'bad')
      status.textContent = report.error
      return
    }

    const s = report.summary
    tone(status, '')
    status.textContent = s.jobs ? `${s.jobs} retained job${s.jobs === 1 ? '' : 's'} · refreshed just now` : 'No retained jobs yet.'
    overview.append(
      stat('Reported spend', usageMoney(s.costUsd), s.reportedJobs ? `from ${s.reportedJobs} Claude run${s.reportedJobs === 1 ? '' : 's'}` : 'no Claude result has reported spend'),
      stat('Known tokens', usageNumber(s.totalTokens), s.reportedJobs ? `${usageNumber(s.outputTokens)} generated · cache included` : 'no token result recorded yet'),
      stat('Studio time', usageElapsed(s.elapsedMs), `${s.jobs} job${s.jobs === 1 ? '' : 's'} across local and Claude work`),
      stat('Agent coverage', `${s.reportedJobs} / ${s.agentJobs}`, s.unknownAgentJobs ? `${s.unknownAgentJobs} agent run${s.unknownAgentJobs === 1 ? '' : 's'} did not report usage` : 'every recorded agent run reported usage'),
    )

    if (!s.jobs) {
      ui.empty.hidden = false
      return
    }

    ui.accounting.hidden = false
    const cacheTokens = s.cacheCreationTokens + s.cacheReadTokens
    ui.accountingCopy.textContent = s.reportedJobs
      ? `${usageNumber(s.inputTokens)} direct input · ${usageNumber(cacheTokens)} cached context · ${usageNumber(s.outputTokens)} output. Spend is the amount Claude reported at completion, not a rate-card estimate.`
      : 'No completed Claude stream has included a usage result yet, so this page is intentionally showing no spend estimate.'
    ui.localNote.hidden = !s.localJobs
    if (s.localJobs) ui.localNote.textContent = `${s.localJobs} local job${s.localJobs === 1 ? '' : 's'} ran without a model bill and are excluded from spend and tokens.`
    ui.unknownNote.hidden = !s.unknownAgentJobs
    if (s.unknownAgentJobs) ui.unknownNote.textContent = `${s.unknownAgentJobs} agent run${s.unknownAgentJobs === 1 ? '' : 's'} has no final usage result. Its cost is unknown and is not included.`

    if (report.models?.length) {
      ui.models.hidden = false
      for (const model of report.models) {
        const { root, el: row } = mountRow('usage-model')
        row.model.textContent = model.model
        row.meta.textContent = `${model.jobs} run${model.jobs === 1 ? '' : 's'} · ${usageNumber(model.totalTokens)} tokens · ${usageMoney(model.costUsd)}`
        ui.models.append(root)
      }
    }

    ui.runs.hidden = false
    for (const run of report.runs) {
      const { root, el: row } = mountRow('usage-run')
      const runStatus = run.interrupted ? 'interrupted' : run.code === 0 ? 'done' : run.code == null ? 'running' : `exit ${run.code}`
      row.label.textContent = run.label || 'Unnamed job'
      row.when.textContent = `${runStatus} · ${run.startedAt?.slice(...ISO_TIME) || 'unknown time'} · ${usageElapsed(run.elapsedMs)}`
      row.meta.textContent = run.usage
        ? `${usageNumber(run.usage.totalTokens)} tokens · ${usageMoney(run.usage.costUsd)}`
        : run.agent
          ? 'usage not reported'
          : 'local job · no model spend'
      root.onclick = () => {
        jobId = run.id
        go('console')
      }
      ui.runList.append(root)
    }
  }

  refresh.onclick = loadUsage
  void loadUsage()
}

function vConsole(m) {
  // The structure — list, status, head, log, artifacts, the opt-in shell bar
  // and the footer Clear — lives in the panel template; this fills it in.
  const ui = mountPanel('console', m)
  const { lede, list, status, log } = ui

  const tools = $('.op-page__main-footer')
  /*
   * A way to empty it.
   *
   * The Console is a permanent record on purpose — a render that failed an hour
   * ago is still readable here — and the price of that is a page that only grows.
   * Anything still running is kept, and not out of politeness: forgetting a live
   * job orphans its process and its output stream, which is a worse problem than
   * a long list.
   */
  ui.clear.onclick = async () => {
    ui.clear.disabled = true
    const r = await responseJson(await fetch('/api/jobs/clear', { method: 'POST' })).catch(() => ({}))
    ui.clear.disabled = false
    // Said out loud: a Clear that reports nothing, on a page that is now empty
    // either way, leaves you unsure whether it did anything.
    tone(status, r.cleared ? 'ok' : null)
    status.textContent = r.error ? 'Error: ' + r.error : r.cleared ? `Cleared ${r.cleared} finished job${r.cleared === 1 ? '' : 's'}.${r.remaining ? ` ${r.remaining} still running.` : ''}` : 'Nothing finished to clear.'
    await refreshJobs()
    // And empty the pane beside the list: a log left on screen for a job the
    // list no longer contains reads as Clear having half worked.
    if (!allJobs.some((j) => j.id === jobId)) {
      jobId = null
      log.textContent = ''
      ui.stop.hidden = true
      ui.rerun.hidden = true
      clearArtifacts()
      es?.close()
      es = null
    }
    paintList()
  }

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
    ui.cmd.hidden = false
    const fire = async () => {
      if (!ui.cmdInput.value.trim()) return
      await start({ shell: ui.cmdInput.value.trim() })
      ui.cmdInput.value = ''
    }
    ui.cmdRun.onclick = fire
    ui.cmdInput.onkeydown = (e) => {
      if (e.key === 'Enter') fire()
    }
  }

  // The job whose output `es` is currently attached to. Not the same thing as
  // `jobId`: the stream is reattached only when the selection actually changes.
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
    list.replaceChildren()
    if (!allJobs.length) {
      list.append(mountRow('console-empty').root)
      return
    }
    for (const j of allJobs) {
      const { root: row, el: jobRow } = mountRow('console-job')
      row.setAttribute('aria-selected', String(j.id === jobId))
      const st = j.running ? 'running' : j.interrupted ? 'interrupted' : j.code === 0 ? 'done' : 'exit ' + j.code
      jobRow.label.textContent = j.label
      jobRow.state.className = 'js ' + (j.running ? 'run' : j.interrupted || j.code !== 0 ? 'bad' : '')
      jobRow.state.textContent = st + ' · ' + j.startedAt.slice(...ISO_TIME)
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
    ui.stop.hidden = !cur?.running
    /*
     * Offered when a job stopped without finishing.
     *
     * Interrupted is the case this exists for — the server restarted under a
     * render and the work simply stopped, which is not a failure and not a
     * success. A non-zero exit gets it too: the usual reason a job failed is
     * something you have since fixed. A job that succeeded does not, because
     * running it again is a new decision rather than a repair, and it belongs
     * in the panel that knows what it would mean.
     *
     * `bin` is what makes it possible: a job recorded before reruns existed
     * kept only the joined command, which cannot be run again safely.
     */
    ui.rerun.hidden = !cur || cur.running || (cur.code === 0 && !cur.interrupted)
    if (!cur) return
    ui.stop.onclick = async () => {
      await fetch('/api/jobs/' + cur.id + '/stop', { method: 'POST' })
      refreshJobs()
    }
    ui.rerun.onclick = async () => {
      ui.rerun.disabled = true
      const r = await fetch('/api/jobs/' + cur.id + '/rerun', { method: 'POST' })
        .then(responseJson)
        .catch((error) => ({ error: error.message }))
      ui.rerun.disabled = false
      if (r.error) return toast(r.error, 'bad')
      // Follow the new job, not the record of the old one: what somebody wants
      // after pressing this is to watch it run.
      jobId = r.job.id
      toast(`Running ${r.job.label} again.`, 'ok')
      await refreshJobs()
      attach()
    }
  }

  const line = (cls, text) => {
    const node = mountRow('console-line').root
    if (cls) node.className = cls
    node.textContent = text
    return node
  }

  const write = (cls, t) => {
    // Only stick to the bottom when already there, so reading back through a long
    // log is not yanked away by the next line.
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40
    log.append(line(cls, t))
    if (atBottom) log.scrollTop = log.scrollHeight
  }

  const attach = () => {
    if (streaming === jobId) return // already watching this one; leave it alone
    streaming = jobId
    es?.close()
    es = null
    log.replaceChildren()
    if (!jobId) {
      log.append(line('m', 'Pick a job on the left.'))
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

  const clearArtifacts = () => {
    ui.ranIn.hidden = true
    ui.nothing.hidden = true
    ui.fileBox.hidden = true
    for (const old of ui.fileBox.querySelectorAll('.job')) old.remove()
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
    clearArtifacts()
    if (!jobId) return
    const d = await responseJson(await fetch('/api/jobs/' + jobId + '/artifacts')).catch(() => null)
    if (!d) return
    ui.ranIn.hidden = false
    ui.ranIn.textContent = 'ran in  ' + d.dir
    if (!d.files.length) {
      ui.nothing.hidden = false
      return
    }
    ui.fileBox.hidden = false
    ui.fileCount.textContent = d.files.length + ' file' + (d.files.length === 1 ? '' : 's') + ', newest first'
    for (const f of d.files.slice(0, 12)) {
      const { root, el: file } = mountRow('console-file')
      file.name.textContent = f.name
      file.tag.textContent = human(f.bytes) + ' · ' + f.at.slice(...ISO_TIME)
      ui.fileBox.append(root)
    }
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
  ui.openField.onclick = () => go('field')
  ui.openHaze.onclick = () => go('haze')
}


/* ── Animated field ──────────────────────────────────────────
   A route, not a popup. Same shape as the wallpaper editor: the preview is the
   work and lives in main, the dials are settings and live in the rail, the
   action lives in the footer. */
let fieldRuntime = null

/*
 * The components are loaded when this view opens, not with Studio.
 *
 * studio.js is a classic script, so this is a dynamic import: rm-video.js is a
 * module, it registers custom elements globally, and nothing else in Studio
 * needs them. Loading it up front would cost every page a parse for one panel.
 */
async function loadFieldRuntime() {
  fieldRuntime ??= await import('/components/rm-video.js')
  return fieldRuntime
}

const FIELD_MODES = ['current', 'bloom', 'softCut', 'cutCurveA', 'cutCurveB', 'wipe', 'claude', 'proof']
const FIELD_DEFAULTS = {
  /*
   * `current` and not `bloom`.
   *
   * bloom's peak inflates the dot radius and spacing until the dots merge into
   * flat colour — the field reads as a wash with no halftone in it, which is the
   * worst frame this component can draw. Opening the panel on it made the whole
   * thing look muddy before anyone touched a control.
   */
  mode: 'current',
  phase: 1.4,
  bloom: 0,
  haze: 1,
  grain: 1,
  eyebrow: 'CCC Days',
  title: 'AI Video Presentation Builder.',
  body: 'Produce a tool/library to produce polished video presentations leveraging existing assets and AI to build the initial presentation in minutes!',
  size: 6.6,
  x: 10,
  y: 70,
  align: 'left',
  /* Empty, not a palette. The component's own defaults come from brand tokens,
     so an untouched field is on brand; a colour is carried here only once
     somebody picks one, and hard-coding hexes in this file would invent a
     palette that the brand does not have. */
  ground: '',
  green: '',
  cyan: '',
  amber: '',
  paper: '',
}

/*
 * The three ways a designed component leaves this page.
 *
 * Copy the tag, insert it into a composition that already exists, or save it as
 * a scene. Shared by every designer rather than written per view: the insert
 * call is the only part of Studio that knows how a composition is edited in
 * place instead of rebuilt, and a second copy of it is a second thing to keep
 * in step with that endpoint.
 */
function sceneOutlets({ tag, startMs, name, durationMs = 4000, withSave = true }) {
  const { el: outlet } = mountRow('scene-outlets')
  const { target, where, insert: insertBtn, copy: copyBtn, name: nameIn, save: saveBtn, wallpaper: wpPick } = outlet

  /*
   * The ground a designed component is saved against.
   *
   * A designer draws one full-frame component and nothing behind it, so it had
   * no wallpaper to state — and a scene saved from one arrived in the gallery on
   * whatever the default happened to be, which is not what it was designed
   * against. Filled from the same list the scene editor offers, and the preview
   * follows the choice, because picking a ground you cannot see is not picking
   * anything.
   */
  void fetch('/api/wallpapers')
    .then(responseJson)
    .then((d) => {
      for (const w of d.wallpapers ?? []) wpPick.append(new Option(w.label ?? w.name, `${w.name}.jpg`))
      const stage = document.querySelector('rm-scene')
      const current = stage?.getAttribute('wallpaper')
      if (current && [...wpPick.options].some((o) => o.value === current)) wpPick.value = current
      else if (stage && wpPick.value) stage.setAttribute('wallpaper', wpPick.value)
    })
    .catch(() => {})
  wpPick.onchange = () => document.querySelector('rm-scene')?.setAttribute('wallpaper', wpPick.value)
  /* copyButton() because it goes through the host's clipboard and reports a
     failure instead of claiming "Copied" when nothing was. */
  copyButton(copyBtn, 'Copy tag', () => tag())

  /*
   * Insert into a composition, without rebuilding it.
   *
   * The other route out is Save as scene, which needs a Canvas node to
   * reference it and a rebuilt cut to mount it — and rebuilding discards
   * whatever has been tuned in the composition since. This appends the element
   * to a composition that already exists and leaves the rest of the file alone.
   */
  /* "Where in the composition" is a real choice; the two options live in the
     template. The end is resolved by the server, because only the file knows
     where its last clip finishes. */
  const loadCompositions = async () => {
    const id = currentProject()
    if (!id) return
    const result = await fetch(`/api/hyperframes?project=${encodeURIComponent(id)}`)
      .then(responseJson)
      .catch(() => ({ error: 'could not list the motion projects' }))
    const found = result.projects ?? []
    target.replaceChildren()
    for (const c of found) {
      const folder = typeof c === 'string' ? c : c.folder ?? c.name
      if (folder) target.append(new Option(folder, folder, false, folder === hyperframesWorkspace?.folder))
    }
    insertBtn.disabled = found.length === 0
    if (!found.length) insertBtn.title = 'This project has no composition to insert into yet.'
  }
  insertBtn.onclick = async () => {
    const result = await fetch('/api/hyperframes/insert', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: currentProject(),
        folder: target.value,
        body: tag(),
        at: where.value,
        startMs: startMs(),
        durationMs,
      }),
    })
      .then(responseJson)
      .catch((error) => ({ error: error.message }))
    toast(
      /* A part trimmed to the last frame is a change to what was asked for, so
         it is said rather than left to be discovered on the timeline. */
      result.error ??
        `Inserted into ${result.folder} at ${(result.startMs / 1000).toFixed(1)}s.${
          result.clamped?.length
            ? ` ${result.clamped.map((c) => `${c.tag} trimmed ${(c.asked / 1000).toFixed(1)}s → ${(c.to / 1000).toFixed(1)}s to fit the video`).join('; ')}.`
            : ''
        }`,
      result.error ? 'bad' : 'ok',
    )
  }
  void loadCompositions()

  /* Scenes has its own name field and its own Save, so it takes the insert and
     the copy and leaves those out rather than showing two of each. */
  nameIn.value = name ?? ''
  saveBtn.onclick = async () => {
    const result = await fetch('/api/scene', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: currentProject(), name: nameIn.value, body: tag() }),
    })
      .then(responseJson)
      .catch((error) => ({ error: error.message }))
    toast(result.error ?? `Saved as ${result.name}.`, result.error ? 'bad' : 'ok')
  }
  /* A scene belongs to a project. Said on the button rather than as a note in
     the footer, which would push the buttons apart to explain itself. */
  if (!currentProject()) {
    saveBtn.disabled = true
    saveBtn.title = 'Open a project to save this as a scene.'
  }
  return withSave ? [target, where, insertBtn, copyBtn, nameIn, saveBtn] : [target, where, insertBtn, copyBtn]
}

function vField(m) {
  crumbs([{ label: 'Components', go: () => go('components') }, { label: 'Animated field' }])
  const ui = mountPanel('field', m)
  const { field, scrub, clock, markup, play: playBtn } = ui

  const f = { ...FIELD_DEFAULTS }

  const tag = () => {
    const attrs = [`mode="${f.mode}"`, `phase="${f.phase}"`]
    if (Number(f.bloom) > 0) attrs.push(`bloom="${f.bloom}"`)
    if (Number(f.haze) !== 1) attrs.push(`haze="${f.haze}"`)
    if (Number(f.grain) !== 1) attrs.push(`grain="${f.grain}"`)
    for (const t of ['eyebrow', 'title', 'body']) if (String(f[t]).trim()) attrs.push(`${t}="${esc(String(f[t]).trim())}"`)
    for (const n of ['size', 'x', 'y']) attrs.push(`${n}="${f[n]}"`)
    attrs.push(`align="${f.align}"`)
    for (const c of ['ground', 'green', 'cyan', 'amber', 'paper']) if (f[c]) attrs.push(`${c}="${f[c]}"`)
    return `<rm-study-field at="0" for="4000"\n  ${attrs.join('\n  ')}></rm-study-field>`
  }

  /*
   * Every control writes an attribute onto the component and it re-renders
   * itself. One drawing path, so what this panel shows is what the same tag does
   * in a composition — a second preview routine here could only ever disagree.
   */
  const repaint = () => {
    field.setAttribute('mode', f.mode)
    field.setAttribute('phase', String(f.phase))
    field.setAttribute('align', f.align)
    for (const n of ['size', 'x', 'y']) field.setAttribute(n, String(f[n]))
    for (const c of ['ground', 'green', 'cyan', 'amber', 'paper']) {
      if (f[c]) field.setAttribute(c, f[c])
      else field.removeAttribute(c)
    }
    // An empty line is an absent attribute, not an empty one: that is what makes
    // this a background rather than a card with blank rows in it.
    for (const t of ['eyebrow', 'title', 'body']) {
      if (String(f[t]).trim()) field.setAttribute(t, String(f[t]).trim())
      else field.removeAttribute(t)
    }
    if (Number(f.bloom) > 0) field.setAttribute('bloom', String(f.bloom))
    else field.removeAttribute('bloom')
    field.setAttribute('haze', String(f.haze))
    field.setAttribute('grain', String(f.grain))
    markup.textContent = tag()
    fieldRuntime?.RM?.seek(Number(scrub.value))
  }

  const panel = mountRow('designer-panel').root
  const sec = (t) => {
    const heading = mountRow('designer-sec').root
    heading.textContent = t
    panel.append(heading)
  }
  const g = () => {
    const d = mountRow('designer-group').root
    panel.append(d)
    return d
  }
  const textRow = (box, label, key, ph) => {
    const { nodes, el: row } = mountRow('designer-text')
    row.label.textContent = label
    const i = Object.assign(row.input, { value: f[key] ?? '', placeholder: ph || '' })
    i.oninput = () => {
      f[key] = i.value
      repaint()
    }
    box.append(...nodes)
  }
  const rangeRow = (box, label, key, range) => {
    const { nodes, el: row } = mountRow('designer-range')
    row.label.textContent = label
    const i = Object.assign(row.input, { ...range, value: f[key] })
    row.readout.textContent = String(f[key])
    i.oninput = () => {
      f[key] = Number(i.value)
      row.readout.textContent = i.value
      repaint()
    }
    box.append(...nodes)
  }
  const selectRow = (box, label, key, opts) => {
    const { nodes, el: row } = mountRow('designer-select')
    row.label.textContent = label
    for (const o of opts) row.input.append(new Option(o, o, false, o === f[key]))
    row.input.onchange = () => {
      f[key] = row.input.value
      repaint()
    }
    box.append(...nodes)
  }
  /* From the brand, like the wallpaper editor's colours and for the same reason:
     an <input type="color"> opens the system panel, where every colour in the
     spectrum is one click away and none of them are ours. */
  const colorRow = (box, label, key) => {
    const { el: row } = mountRow('designer-color')
    row.label.textContent = label
    box.append(
      row.label,
      colorMenu({
        families: brandFamilies(),
        value: f[key],
        format: 'hex',
        onPick: (value) => {
          f[key] = value
          repaint()
        },
      }),
      row.readout,
    )
  }

  sec('Motion')
  const motion = g()
  selectRow(motion, 'Motion', 'mode', FIELD_MODES)
  rangeRow(motion, 'Phase', 'phase', { min: 0, max: 6, step: 0.05 })
  rangeRow(motion, 'Bloom floor', 'bloom', { min: 0, max: 1, step: 0.02 })
  rangeRow(motion, 'Haze', 'haze', { min: 0, max: 1, step: 0.05 })
  /* Dot size against its cell. At 1 the sheet's dots leave most of each cell as
     exposed ground, and those gaps read as dark specks across a whole frame. */
  rangeRow(motion, 'Dot size', 'grain', { min: 0.5, max: 3, step: 0.1 })

  sec('Type')
  const type = g()
  textRow(type, 'Eyebrow', 'eyebrow')
  textRow(type, 'Title', 'title')
  textRow(type, 'Body', 'body', 'optional')
  rangeRow(type, 'Size', 'size', { min: 2, max: 14, step: 0.2 })
  rangeRow(type, 'X', 'x', { min: 0, max: 100, step: 1 })
  rangeRow(type, 'Y', 'y', { min: 0, max: 100, step: 1 })
  selectRow(type, 'Align', 'align', ['center', 'left', 'right'])

  sec('Palette')
  const palette = g()
  colorRow(palette, 'Ground', 'ground')
  colorRow(palette, 'Green', 'green')
  colorRow(palette, 'Cyan', 'cyan')
  colorRow(palette, 'Amber', 'amber')
  colorRow(palette, 'Paper', 'paper')
  intoRail(panel)

  intoFooter(...sceneOutlets({ tag, startMs: () => Number(scrub.value), name: 'animated-field' }))

  /*
   * Playback is a throttled seek, never a frame loop.
   *
   * The field is a full-frame canvas of tens of thousands of dots; redrawing it
   * every animation frame pins a core for no visible gain, and a page of them
   * doing it at once is unusable. 24 steps a second reads as motion.
   */
  let timer = null
  const setTime = (ms) => {
    scrub.value = String(ms)
    clock.textContent = `${Math.round(ms)} ms`
    fieldRuntime?.RM?.seek(ms)
  }
  scrub.oninput = () => setTime(Number(scrub.value))
  playBtn.onclick = () => {
    if (timer) {
      clearInterval(timer)
      timer = null
      playBtn.textContent = 'Play'
      return
    }
    playBtn.textContent = 'Pause'
    let last = performance.now()
    timer = setInterval(() => {
      const now = performance.now()
      setTime((Number(scrub.value) + (now - last)) % Number(scrub.max))
      last = now
    }, 1000 / 24)
  }
  // Leaving the view must stop the timer, or it keeps seeking a component that
  // is no longer on the page for the rest of the session.
  window.addEventListener('rm:before-navigate', () => {
    if (timer) clearInterval(timer)
    timer = null
  }, { once: true })

  void loadFieldRuntime().then(async (rt) => {
    await rt.RM.ready()
    repaint()
    setTime(600)
  })
}



/* ── Pixel haze ──────────────────────────────────────────────
   The same shape as the field designer: the preview is the work and lives in
   main, the dials are settings and live in the rail, the ways out live in the
   footer. The component is the preview — there is no second drawing path here
   that could disagree with what a composition renders. */
const HAZE_DEFAULTS = {
  /* No picture by default: this is a treatment first and a photo frame second,
     and opening on somebody's screenshot would say otherwise. */
  image: '',
  'image-blend': 0.75,
  /* The copy, which is optional: with all three empty this is a background.
     Seeded with something to read, so the panel opens on a lockup rather than
     on three empty rows that look like a broken form. */
  eyebrow: 'CCC Days',
  title: 'AI Video Presentation Builder.',
  body: '',
  size: 6.6,
  x: 50,
  y: 50,
  align: 'center',
  /* Empty, not a palette, for the same reason the field's colours are: the
     component's own defaults come from brand tokens, so an untouched haze is on
     brand, and writing hexes here would invent a palette the brand does not
     have. A colour is carried only once somebody picks one. */
  'gradient-shadow': '',
  'gradient-highlight': '',
  'dither-color': '',
  'flow-speed': 0.6,
  'swirl-detail': 0.7,
  'color-balance': 58,
  'dither-amount': 0.45,
  'dither-pixel': 4,
  'distortion-strength': 5,
  'distortion-detail': 75,
  sharpness: 1,
  'film-grain': 0.05,
  flow: 'flow',
}

/* Every dial, with the range the shader actually clamps to. One list, so the
   rail and the tag cannot describe different components. */
const HAZE_DIALS = [
  ['image-blend', 'Picture strength', 0, 1, 0.05],
  ['flow-speed', 'Flow speed', 0, 5, 0.1],
  ['swirl-detail', 'Swirl detail', 0, 5, 0.1],
  ['color-balance', 'Colour balance', 0, 100, 1],
  ['dither-amount', 'Dither amount', 0, 1, 0.01],
  ['dither-pixel', 'Dither pixel', 1, 32, 1],
  ['distortion-strength', 'Distortion strength', 0, 5, 0.1],
  ['distortion-detail', 'Distortion detail', 8, 128, 1],
  ['sharpness', 'Sharpness', 0, 3, 0.1],
  ['film-grain', 'Film grain', 0, 1, 0.025],
]
const HAZE_COPY = [
  ['eyebrow', 'Eyebrow', 'CCC Days'],
  ['title', 'Title', 'AI Video Presentation Builder.'],
  ['body', 'Body', 'One or two sentences.'],
]
const HAZE_PLACE = [
  ['size', 'Size', 2, 14, 0.1],
  ['x', 'Position x', 0, 100, 1],
  ['y', 'Position y', 0, 100, 1],
]
const HAZE_SWATCHES = [
  ['gradient-shadow', 'Gradient shadow'],
  ['gradient-highlight', 'Gradient highlight'],
  ['dither-color', 'Dither colour'],
]

function vHaze(m) {
  crumbs([{ label: 'Components', go: () => go('components') }, { label: 'Pixel haze' }])
  const ui = mountPanel('haze', m)
  const { haze, scrub, clock, markup, play: playBtn } = ui

  const f = { ...HAZE_DEFAULTS }
  let hazeImagery = []

  /* Only what differs from the component's own defaults. A tag carrying twelve
     attributes that all say "as built" is noise in a composition. */
  const tag = () => {
    const attrs = []
    if (f.image) attrs.push(`image="${esc(f.image)}"`)
    for (const [key] of HAZE_COPY) if (String(f[key]).trim()) attrs.push(`${key}="${esc(String(f[key]).trim())}"`)
    /* Placement only matters once there is something placed. */
    if (HAZE_COPY.some(([key]) => String(f[key]).trim())) {
      for (const [key] of HAZE_PLACE) attrs.push(`${key}="${f[key]}"`)
      attrs.push(`align="${f.align}"`)
    }
    for (const [key] of HAZE_SWATCHES) if (f[key]) attrs.push(`${key}="${esc(String(f[key]))}"`)
    for (const [key] of HAZE_DIALS) {
      if (String(f[key]) !== String(HAZE_DEFAULTS[key])) attrs.push(`${key}="${esc(String(f[key]))}"`)
    }
    if (f.flow !== HAZE_DEFAULTS.flow) attrs.push(`flow="${f.flow}"`)
    return `<rm-haze at="0" for="4000"${attrs.length ? `\n  ${attrs.join('\n  ')}` : ''}></rm-haze>`
  }

  /* Each control writes an attribute and the component re-renders itself, which
     is the same path a composition takes. */
  const repaint = () => {
    if (f.image) haze.setAttribute('image', f.image)
    else haze.removeAttribute('image')
    /* An empty line is an absent attribute, not an empty one: that is what
       makes this a background rather than a card with blank rows in it. */
    for (const [key] of HAZE_COPY) {
      if (String(f[key]).trim()) haze.setAttribute(key, String(f[key]).trim())
      else haze.removeAttribute(key)
    }
    for (const [key] of HAZE_PLACE) haze.setAttribute(key, String(f[key]))
    haze.setAttribute('align', f.align)
    for (const [key] of HAZE_DIALS) haze.setAttribute(key, String(f[key]))
    for (const [key] of HAZE_SWATCHES) {
      if (f[key]) haze.setAttribute(key, f[key])
      else haze.removeAttribute(key)
    }
    haze.setAttribute('motion', f.motion)
    markup.textContent = tag()
    fieldRuntime?.RM?.seek(Number(scrub.value))
  }

  const panel = mountRow('designer-panel').root
  const sec = (t) => {
    const heading = mountRow('designer-sec').root
    heading.textContent = t
    panel.append(heading)
  }
  const g = () => {
    const d = mountRow('designer-group').root
    panel.append(d)
    return d
  }

  /*
   * The brand shelf, as pictures.
   *
   * The same imagery the scene editor offers, chosen the same way: by looking
   * at it. "None" is first and is the default, because the treatment stands on
   * its own and a picture is the addition.
   */
  sec('Picture')
  /* .refshelf, not the --faces variant: that one has fixed square tracks for
     the main column, and in a 320px rail it gives one picture per row. */
  const shelf = mountRow('refshelf').root
  panel.append(shelf)
  const paintShelf = () => {
    shelf.replaceChildren()
    const none = mountRow('refshelf-tile').root
    none.title = 'No picture'
    if (!f.image) none.classList.add('on')
    none.onclick = () => {
      f.image = ''
      repaint()
      paintShelf()
    }
    shelf.append(none)
    for (const item of hazeImagery) {
      const { root: tile, el: parts } = mountRow('refshelf-tile')
      tile.title = item.label ?? item.file
      parts.art.style.backgroundImage = `url('/brand/imagery/${encodeURI(item.file)}')`
      if (f.image === item.file) tile.classList.add('on')
      tile.onclick = () => {
        f.image = item.file
        repaint()
        paintShelf()
      }
      shelf.append(tile)
    }
  }
  paintShelf()

  sec('Copy')
  for (const [key, label, placeholder] of HAZE_COPY) {
    const box = g()
    const { nodes, el: row } = mountRow(key === 'body' ? 'designer-textarea' : 'designer-text')
    row.label.textContent = label
    const input = Object.assign(row.input, { value: f[key] ?? '', placeholder })
    input.oninput = () => {
      f[key] = input.value
      repaint()
    }
    box.append(...nodes)
  }

  sec('Placement')
  for (const [key, label, min, max, step] of HAZE_PLACE) {
    const box = g()
    const { nodes, el: row } = mountRow('designer-range')
    row.label.textContent = label
    const slider = Object.assign(row.input, { min, max, step, value: f[key] })
    row.readout.textContent = String(f[key])
    slider.oninput = () => {
      f[key] = Number(slider.value)
      row.readout.textContent = String(f[key])
      repaint()
    }
    box.append(...nodes)
  }
  const alignBox = g()
  {
    const { nodes, el: row } = mountRow('designer-select')
    row.label.textContent = 'Align'
    for (const value of ['left', 'center', 'right']) row.input.append(new Option(value, value, false, value === f.align))
    row.input.onchange = () => {
      f.align = row.input.value
      repaint()
    }
    alignBox.append(...nodes)
  }

  /* From the brand, like the field's colours and the wallpaper editor's: an
     <input type="color"> opens the system panel, where every colour in the
     spectrum is one click away and none of them are ours. */
  sec('Colour')
  for (const [key, label] of HAZE_SWATCHES) {
    const box = g()
    const { el: row } = mountRow('designer-color')
    row.label.textContent = label
    box.append(
      row.label,
      colorMenu({
        families: brandFamilies(),
        value: f[key],
        format: 'hex',
        onPick: (value) => {
          f[key] = value
          repaint()
        },
      }),
      row.readout,
    )
  }

  sec('Field')
  for (const [key, label, min, max, step] of HAZE_DIALS) {
    const box = g()
    const { nodes, el: row } = mountRow('designer-range')
    row.label.textContent = label
    const slider = Object.assign(row.input, { min, max, step, value: f[key] })
    row.readout.textContent = String(f[key])
    slider.oninput = () => {
      f[key] = Number(slider.value)
      row.readout.textContent = String(f[key])
      repaint()
    }
    box.append(...nodes)
  }

  sec('Motion')
  const motionBox = g()
  {
    const { nodes, el: row } = mountRow('designer-select')
    row.label.textContent = 'Motion'
    for (const [value, label] of [['flow', 'Flow — advances with the scene clock'], ['still', 'Still — one frozen frame']]) {
      row.input.append(new Option(label, value, false, value === f.flow))
    }
    row.input.onchange = () => {
      f.flow = row.input.value
      repaint()
    }
    motionBox.append(...nodes)
  }

  intoRail(panel)
  intoFooter(...sceneOutlets({ tag, startMs: () => Number(scrub.value), name: 'pixel-haze' }))

  /* Playback is a throttled seek, never a frame loop — the same reason as the
     field: this is a full-frame shader and 24 steps a second reads as motion. */
  let timer = null
  const setTime = (ms) => {
    scrub.value = String(ms)
    clock.textContent = `${Math.round(ms)} ms`
    fieldRuntime?.RM?.seek(ms)
  }
  scrub.oninput = () => setTime(Number(scrub.value))
  playBtn.onclick = () => {
    if (timer) {
      clearInterval(timer)
      timer = null
      playBtn.textContent = 'Play'
      return
    }
    playBtn.textContent = 'Pause'
    let last = performance.now()
    timer = setInterval(() => {
      const now = performance.now()
      setTime((Number(scrub.value) + (now - last)) % Number(scrub.max))
      last = now
    }, 1000 / 24)
  }
  window.addEventListener('rm:before-navigate', () => {
    if (timer) clearInterval(timer)
    timer = null
  }, { once: true })

  void loadFieldRuntime().then(async (rt) => {
    await rt.RM.ready()
    repaint()
    setTime(600)
  })
  /* The shelf is drawn empty and filled when the catalogue answers, so a slow
     brand read never holds up the preview. */
  void fetch('/api/compose/catalogue')
    .then(responseJson)
    .then((cat) => {
      hazeImagery = (cat.imagery ?? []).filter((item) => item.file)
      paintShelf()
    })
    .catch(() => {})
}

/* ── Restyle ─────────────────────────────────────────────────
   Send one clip to a fal.ai model and bring the result back into the project.
   Same shape as the other editors here: the work in main, the settings in the
   rail, the action in the footer. */
/*
 * The cut editor.
 *
 * A picture and a timeline. The timeline is drawn by lib/timeline-canvas.js and
 * edited by lib/timeline-input.js — neither knows this panel exists, which is
 * what let both be built and measured against a fixture before there was a panel
 * to put them in.
 *
 * Everything it draws from was made once at import: a 720p proxy, a filmstrip,
 * an array of peaks. Nothing here opens a camera original, and that is the whole
 * reason a drag keeps up with the hand.
 */
function vTimeline(m) {
  /* Read once and cleared, so a folder chosen from a card applies to this visit
     only. Left set, the rail entry would keep reopening that composition and
     look like it had no chooser at all. */
  let folder = timelineFolder
  timelineFolder = null
  crumbs(scopedCrumbs([{ label: 'Video', go: () => go('workflow') }, { label: 'Timeline' }]))
  const ui = mountPanel('timeline', m)
  const { lede, empty, stage, video, scene, bed, gap, play, clock, under, stat, save, canvas, pick, add } = ui
  const project = currentProject()
  if (!project) {
    stage.hidden = true
    empty.hidden = false
    empty.textContent = 'Pick a project first.'
    return
  }

  const state = { playhead: 0, selection: null, hover: null, snapped: null }
  const view = { pxPerSecond: 22, scrollSeconds: 0 }
  const images = new Map()
  const peaks = new Map()
  let cut = null
  let dirty = false
  let mod = null
  let palette = null
  let playing = false

  const time = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}.${String(Math.floor((s % 1) * 100)).padStart(2, '0')}`

  /* How long the cut is: the furthest any clip reaches. Not stored, because a
     stored length is a length that can disagree with the clips. */
  const cutSeconds = () => Math.max(0, ...(cut?.tracks ?? []).flatMap((t) => (t.clips ?? []).map((c) => c.at + (c.out - c.in))))

  /*
   * What is under the playhead, per kind of lane.
   *
   * This used to be one function that took anything but audio, which meant a
   * scene came back as "the clip to show" and the picture was pointed at a proxy
   * for a source that does not exist — a graphic has no footage. The three lanes
   * answer three different questions, so they are three lookups: footage decides
   * the picture, graphics decide the overlay, sound decides the bed.
   *
   * Two footage clips can be under the playhead at once — that is a dissolve —
   * and the later one is what a render shows on top, so it wins here too.
   */
  const under_ = (t, kind) => {
    let found = null
    for (const track of cut?.tracks ?? []) {
      if ((track.kind ?? 'video') !== kind) continue
      for (const clip of track.clips ?? []) {
        if (t >= clip.at && t < clip.at + (clip.out - clip.in)) found = clip
      }
    }
    return found
  }
  const clipUnder = (t) => under_(t, 'video')

  /*
   * The scene layer: the composition itself, seeked.
   *
   * Mounted once and left mounted. It carries the graphics only — its own
   * footage is hidden, because the proxy underneath is already showing that and
   * showing it at the speed this editor exists for. Seeking speaks all three
   * dialects the compositions use, since which one a piece answers to depends on
   * how it was built and getting it wrong just leaves the overlay frozen.
   */
  let mounted = false
  const sceneBase = () => `/api/edit/scene/${encodeURIComponent(project)}/${encodeURIComponent(folder)}/`

  /*
   * Fill the composition's seams.
   *
   * `data-composition-src` is a hole the HyperFrames renderer fills; open the
   * file on its own and the beats are empty divs, which is why the first version
   * of this showed a blank overlay while insisting eight scenes were there. So
   * the editor does the filling itself — the same job, done by whoever is
   * mounting the piece.
   *
   * Scripts have to be recreated rather than inserted: HTML parsed into a
   * document does not run, and each beat's animation lives in a script that
   * registers a timeline. Without this every beat is present and frozen.
   */
  const fillSeams = async (doc) => {
    const base = sceneBase()
    for (const host of doc.querySelectorAll('[data-composition-src]')) {
      const html = await fetch(base + host.dataset.compositionSrc).then((r) => (r.ok ? r.text() : '')).catch(() => '')
      if (!html) continue
      const parsed = new DOMParser().parseFromString(html, 'text/html')
      for (const sheet of parsed.querySelectorAll('style, link[rel=stylesheet]')) doc.head?.append(doc.importNode(sheet, true))
      const scripts = [...parsed.querySelectorAll('script')]
      for (const tag of scripts) tag.remove()
      host.append(...[...parsed.body.childNodes].map((node) => doc.importNode(node, true)))
      for (const tag of scripts) {
        const fresh = doc.createElement('script')
        for (const attr of tag.attributes) fresh.setAttribute(attr.name, attr.value)
        fresh.textContent = tag.textContent
        host.append(fresh)
      }
    }
  }

  /*
   * Put the composition at an instant.
   *
   * Which beat is visible is decided here rather than left to the composition's
   * own timeline, because the cut is the truth: a scene dragged to a new place
   * on the timeline has to appear at its new place, and the markup still says
   * where it used to be. The composition is asked only for the animation inside
   * a beat, seeked to the time local to that beat.
   *
   * The explicit tick is because GSAP renders on its ticker, and a seek only
   * queues the render. During a scrub the ticker is behind the hand, and a
   * preview that lags the playhead is the thing this editor exists not to be.
   */
  const scenesAt = (t) => {
    const win = scene.contentWindow
    const doc = scene.contentDocument
    if (!mounted || !win || !doc) return
    const ms = t * 1000
    try {
      doc.documentElement?.style?.setProperty('--t', `${ms}ms`)
      win.RM?.seek?.(ms)
      for (const line of Object.values(win.__timelines ?? {})) line?.seek?.(t)

      const clip = under_(t, 'graphic')
      /*
       * Only the seams, never the root.
       *
       * The composition's own root element carries `data-composition-id` too, so
       * switching everything with that attribute hid the whole piece — and
       * `visibility` inherits, so every caption and shader inside it went with
       * it. The overlay was mounted, seeked, correct, and completely invisible.
       */
      const shows = (host) => Boolean(clip) && (clip.name === host.dataset.compositionId || clip.id === host.id)
      for (const host of doc.querySelectorAll('[data-composition-src]')) {
        host.style.visibility = shows(host) ? 'visible' : 'hidden'
      }
      if (clip) win.__timelines?.[clip.name]?.seek?.(Math.max(0, t - clip.at))
      win.gsap?.ticker?.tick?.()
    } catch {
      /* A frame still loading has no document yet. The next paint will catch it. */
    }
  }

  /*
   * The composition is 1920x1080 and the frame is whatever the window allows.
   *
   * An iframe does not scale its document to fit, so at any real window size the
   * overlay was showing the top-left corner of the piece at 1:1 while the proxy
   * underneath showed all of it. Rendering at native size and scaling the whole
   * frame keeps the two in register at every size, and keeps text crisp.
   */
  const fit = () => {
    const box = scene.parentElement?.getBoundingClientRect()
    if (!box?.width || !cut?.width) return
    scene.style.inlineSize = `${cut.width}px`
    scene.style.blockSize = `${cut.height}px`
    scene.style.setProperty('--tl-scale', String(box.width / cut.width))
  }

  scene.onload = async () => {
    const doc = scene.contentDocument
    if (!doc) return
    fit()
    /* Injected rather than asked of the composition: the composition is a
       finished render target and must not have to know it is being edited. */
    const style = doc.createElement('style')
    style.textContent = 'html,body{background:transparent !important}[data-assembly-media],[data-assembly-clock]{display:none !important}'
    doc.head?.append(style)
    await fillSeams(doc)
    mounted = true
    scenesAt(state.playhead)
  }

  /*
   * Point the picture at the right frame.
   *
   * The proxy is swapped only when the clip changes: setting `src` tears down the
   * decoder, and a scrub across a join would do that on every frame. Within a
   * clip it is a seek, which is the cheap operation the proxy's one-second
   * keyframes exist for.
   */
  let showing = null
  const frame = () => {
    const clip = clipUnder(state.playhead)
    const graphic = under_(state.playhead, 'graphic')
    scene.hidden = !graphic
    scenesAt(state.playhead)
    sound()
    /* A gap is only a gap if nothing at all is there. A title over black is a
       held frame somebody composed, not a hole in the cut. */
    gap.hidden = Boolean(clip || graphic)
    under.textContent = [clip?.id, graphic && (graphic.name ?? graphic.id)].filter(Boolean).join(' + ')
    if (!clip) {
      showing = null
      video.pause()
      return
    }
    if (showing !== clip.source) {
      showing = clip.source
      video.src = `/api/edit/cache/${project}/proxy/${clip.source}.mp4`
    }
    const into = clip.in + (state.playhead - clip.at)
    /*
     * A frame of tolerance, not a millisecond.
     *
     * Assigning currentTime on every paint restarts the decoder's seek and, with
     * sound on, chops the audio into clicks — the element never gets far enough
     * to play a continuous buffer. While it is playing it is already the clock,
     * so it is left alone unless it has genuinely drifted.
     */
    const slack = playing ? 0.25 : 1 / (cut?.fps || 60)
    if (Math.abs(video.currentTime - into) > slack) video.currentTime = into
    /*
     * Play was pressed once; the picture has to be told more than once.
     *
     * Setting `src` resets the element to paused, and a cut that starts on a
     * title has no picture at all when Play is clicked — so the one play() in
     * the click handler was spent on an empty element, and every clip the
     * playhead reached afterwards arrived already stopped. The clock kept
     * running, which is what made it look like the video simply never played.
     */
    if (playing && video.paused) video.play().catch(() => {})
  }

  /*
   * Music and voice, which belong to the cut rather than to any clip.
   *
   * Kept on the same playhead as everything else and only corrected when it has
   * drifted: a bed nudged every paint stutters, and a stuttering bed is worse
   * than none because it makes a cut sound wrong that is not.
   */
  let bedding = null
  const sound = () => {
    const clip = under_(state.playhead, 'audio')
    if (!clip) {
      bedding = null
      if (!bed.paused) bed.pause()
      return
    }
    if (bedding !== clip.source) {
      bedding = clip.source
      bed.src = `/api/edit/cache/${project}/proxy/${clip.source}.mp4`
    }
    const into = clip.in + (state.playhead - clip.at)
    if (Math.abs(bed.currentTime - into) > (playing ? 0.25 : 1 / (cut?.fps || 60))) bed.currentTime = into
    if (playing && bed.paused) bed.play().catch(() => {})
    if (!playing && !bed.paused) bed.pause()
  }

  let pending = false
  const draw = () => {
    if (pending || !cut || !mod) return
    pending = true
    requestAnimationFrame(() => {
      pending = false
      const t0 = performance.now()
      mod.canvas.paintTimeline(canvas, { cut, palette, view, images, peaks, playhead: state.playhead, selection: state.selection })
      clock.textContent = time(state.playhead)
      stat.textContent = `${(performance.now() - t0).toFixed(1)}ms`
      save.disabled = !dirty
      frame()
    })
  }

  /* Only the frames this view can see, and never during a paint — a drag must
     not be able to wait on the network. */
  let filling = false
  const fill = () => {
    if (filling || !cut || !mod) return
    filling = true
    for (const { source, index } of mod.canvas.framesInView(cut, view, canvas.clientWidth)) {
      const key = `${source}:${index}`
      if (images.has(key)) continue
      const img = new Image()
      img.onload = draw
      img.src = `/api/edit/cache/${project}/strip/${source}/${String(index + 1).padStart(5, '0')}.jpg`
      images.set(key, img)
    }
    filling = false
  }

  /*
   * Choosing what to edit, without going through the motion editor.
   *
   * This was reachable only from a HyperFrames card, which put the door into the
   * editor inside the thing the editor exists to replace. The rail entry is the
   * front door now: it lists what the project holds and offers the right verb per
   * composition, so nothing here needs HyperFrames to have been opened first.
   */
  const chooseFrom = (compositions) => {
    stage.hidden = true
    empty.hidden = false
    empty.replaceChildren()
    if (!compositions.length) {
      empty.textContent = 'Nothing to edit in this project yet. Compose a running order first, or drop footage into it.'
      return
    }
    empty.append(control('hint', { textContent: compositions.length === 1 ? 'One composition in this project.' : 'Which one?' }))
    for (const comp of compositions) {
      const { root: row, el: cells } = mountRow('timeline-choice')
      cells.name.textContent = comp.title || comp.folder
      cells.note.textContent = comp.hasCut ? '' : 'not editable yet'
      const go_ = cells.go
      go_.className = comp.hasCut ? 'btn' : 'btn ghost'
      go_.textContent = comp.hasCut ? 'Edit' : 'Make editable'
      go_.onclick = async () => {
        if (!comp.hasCut) {
          go_.disabled = true
          go_.textContent = 'Reading the composition…'
          const made = await fetch('/api/edit/seed', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ project, folder: comp.folder }),
          }).then(responseJson).catch((e) => ({ error: e.message }))
          if (made.error) {
            go_.disabled = false
            go_.textContent = 'Make editable'
            toast(made.error, 'bad')
            return
          }
        }
        timelineFolder = comp.folder
        go('timeline')
      }
      empty.append(row)
    }
  }

  ;(async () => {
    /* No folder chosen means the rail entry was clicked. Ask what there is
       rather than guessing — a project can hold several compositions, and
       picking the first silently is how you end up editing the wrong one. */
    if (!folder) {
      const listed = await fetch(`/api/hyperframes?project=${encodeURIComponent(project)}`).then(responseJson).catch(() => ({ projects: [] }))
      const compositions = listed.projects ?? []
      const editable = compositions.filter((c) => c.hasCut)
      if (editable.length === 1) folder = editable[0].folder
      else return chooseFrom(compositions)
    }

    const where = folder ? `&folder=${encodeURIComponent(folder)}` : ''
    const got = await fetch(`/api/edit/cut?project=${encodeURIComponent(project)}${where}`).then(responseJson).catch((e) => ({ error: e.message }))
    if (got.error || !got.cut) {
      stage.hidden = true
      empty.hidden = false
      empty.textContent = got.error ?? 'No cut in this project yet.'
      return
    }
    cut = got.cut
    stage.hidden = false
    empty.hidden = true


    /* The composition, mounted once. Cheap to leave there and expensive to keep
       tearing down: a fresh iframe per scene would reload GSAP on every join. */
    if (folder) {
      scene.src = sceneBase()
      new ResizeObserver(fit).observe(scene.parentElement)
    }

    /* What sound this project has to offer. Read from the catalogue rather than
       the cut, because the point is to add something the cut does not have. */
    const media = await fetch(`/api/project/media?project=${encodeURIComponent(project)}`).then(responseJson).catch(() => null)
    const tracks = (media?.catalog?.files ?? []).filter((f) => f.kind === 'audio')
    for (const track of tracks) {
      const option = new Option(track.rel.split('/').pop(), track.rel)
      pick.append(option)
    }
    add.disabled = !tracks.length
    if (!tracks.length) pick.append(new Option('no audio in this project', ''))

    mod = { canvas: await import('/lib/timeline-canvas.js'), input: await import('/lib/timeline-input.js') }
    palette = mod.canvas.paletteFrom(canvas.parentElement)
    for (const key of Object.keys(cut.sources)) {
      peaks.set(key, await fetch(`/api/edit/cache/${project}/peaks/${key}.json`).then(responseJson).catch(() => null))
    }
    mod.input.attachTimeline(canvas, {
      cut, view, state,
      onChange: () => { dirty = true; draw(); fill() },
      onView: draw,
    })
    fill()
    draw()
  })()

  /* Play walks the playhead off the video's own clock rather than a timer, so
     the picture and the position cannot drift apart. */
  play.onclick = () => {
    playing = !playing
    play.textContent = playing ? 'Pause' : 'Play'
    if (!playing) {
      bed.pause()
      return void video.pause()
    }
    video.play().catch(() => {})
    /* Started here rather than left to the next paint: a bed that first plays
       from inside requestAnimationFrame has lost the click that authorised it,
       and Chrome refuses it as autoplay. */
    sound()
    /*
     * Whatever is actually decoding is the clock.
     *
     * Footage first, then the bed, and a wall clock only when neither is there.
     * A motion piece has no footage at all, and counting frames through rAF drifts
     * against the music within a few seconds — which sounds like the cut is wrong
     * when it is only the preview that is.
     */
    let wall = performance.now()
    const step = () => {
      if (!playing) return
      const clip = clipUnder(state.playhead)
      const sung = under_(state.playhead, 'audio')
      const now = performance.now()
      if (clip) state.playhead = clip.at + (video.currentTime - clip.in)
      else if (sung && !bed.paused) state.playhead = sung.at + (bed.currentTime - sung.in)
      else state.playhead += (now - wall) / 1000
      wall = now
      /* Stop at the end rather than running off into empty time. */
      if (state.playhead >= cutSeconds()) {
        state.playhead = cutSeconds()
        playing = false
        play.textContent = 'Play'
        video.pause()
        bed.pause()
      }
      draw()
      requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }

  save.onclick = async () => {
    save.disabled = true
    const r = await fetch('/api/edit/cut', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project, folder, cut }),
    }).then(responseJson).catch((e) => ({ error: e.message }))
    if (r.error) {
      toast(r.error, 'bad')
      save.disabled = false
      return
    }
    dirty = false
    toast('Cut saved.')
  }
}

function vRestyle(m) {
  crumbs(scopedCrumbs([{ label: 'Video', go: () => go('workflow') }, { label: 'Restyle' }]))
  const ui = mountPanel('restyle', m)
  const { lede, list, promptHead, promptIn, clipNote, dropHint, clipHead, faceHead, faces, voiceHead, voices, panel, runBtn } = ui

  const state = { model: null, file: null, prompt: '', keepAudio: true, resolution: null, images: [], inSec: null, outSec: null, image: null, audio: null, syncMode: null, aspect: null, duration: null, generateAudio: true }
  let models = []
  let configured = false
  let projectImages = []
  let projectVoices = []
  /* The avatar models build a video from a photograph and a voice track rather
     than editing a clip, so this page shows them a different question. */
  const takesOf = () => models.find((x) => x.id === state.model)?.takes ?? 'video'
  const avatarMode = () => takesOf() !== 'video'
  /* Three shapes, one page. A model wants a clip, or a photograph and a voice,
     or a real clip and a voice — so each picker is shown when the chosen model
     actually asks for that thing, rather than by naming a mode. */
  const generating = () => takesOf() === 'text' || takesOf() === 'image+text' || takesOf() === 'video+text'
  const wantsClip = () => takesOf() === 'video' || takesOf() === 'video+audio' || takesOf() === 'video+text'
  const wantsFace = () => takesOf() === 'image+audio' || takesOf() === 'image+text'
  const wantsVoice = () => takesOf() === 'image+audio' || takesOf() === 'video+audio'

  promptIn.oninput = () => { state.prompt = promptIn.value }

  /* Seconds carried once, not split into a whole part and a rounded tenth —
     rounding 14.98 gave a tenth of 10 and printed 0:14.10. */
  const fmt = (s) => {
    const minutes = Math.floor(s / 60)
    const rest = s - minutes * 60
    return `${minutes}:${rest < 10 ? '0' : ''}${rest.toFixed(1)}`
  }

  /** Say what will actually be sent: the clip, and the range inside it. */
  const paintChoice = () => {
    for (const card of list.querySelectorAll('.card')) card.classList.toggle('on', card.dataset.rel === state.file)
    /* No line saying what is chosen: the card carries the focus ring, which is
       the same answer without a second thing to read. */
  }


  /*
   * A picture and a voice, for the models that take those.
   *
   * The voice is nearly always one this project already built under Voice —
   * media/Audio/<script>.wav — so the script and the generated speech that this
   * app made are what drives the performance, and the picture is whoever should
   * be saying it. Its length is the finished video's length, which is why it is
   * on the tile.
   */

  /*
   * Drawn once, marked many times.
   *
   * Selecting a voice used to rebuild both lists, which with a waveform per
   * card means re-fetching and re-decoding every file on every click. The
   * tiles and cards are built when the data changes; choosing one only moves
   * a class.
   */
  let waves = []
  const dropWaves = () => {
    for (const wave of waves) wave.destroy()
    waves = []
  }

  const markAvatar = () => {
    for (const tile of faces.querySelectorAll('.refshelf__tile')) tile.classList.toggle('on', tile.dataset.rel === state.image)
    for (const card of voices.querySelectorAll('.card')) card.classList.toggle('on', card.dataset.rel === state.audio)

  }

  const paintAvatar = () => {
    dropWaves()
    faces.replaceChildren()
    voices.replaceChildren()
    if (!projectImages.length) {
      faces.append(control('hint', { className: 'form-hint hint', textContent: 'No pictures in this project yet — paste or drop one.' }))
    }
    for (const rel of projectImages) {
      const { root: tile, el: tileEl } = mountRow('restyle-ref-tile')
      tile.title = rel
      tile.dataset.rel = rel
      const art = tileEl.art
      art.style.backgroundImage = `url('/media/${currentProject()}/${encodeURI(rel)}')`
      tile.onclick = () => {
        state.image = state.image === rel ? null : rel
        markAvatar()
      }
      faces.append(tile)
    }
    if (!projectVoices.length) {
      voices.append(control('hint', { className: 'form-hint hint', textContent: 'No audio in this project yet. Build one under Voice, and it lands in Audio.' }))
    }
    for (const voice of projectVoices) {
      const { root: card, el: cardEl } = mountRow('restyle-voice-card')
      card.dataset.rel = voice.rel
      cardEl.nm.textContent = voice.rel.split('/').pop()
      cardEl.path.textContent = voice.seconds ? `${voice.seconds.toFixed(1)}s of speech` : voice.rel
      /*
       * The waveform is the reason to look at this card.
       *
       * A voice track has no thumbnail, so the row was a filename and a grey
       * scrubber — three of them look identical. The shape of the speech is
       * what tells one take from another.
       */
      const src = `/media/${encodeURIComponent(currentProject())}/${encodeURI(voice.rel)}`
      const { listen, canvas, play } = cardEl
      play.setAttribute('aria-label', `Play ${voice.rel.split('/').pop()}`)
      play.append(icon('play'))
      const wave = waveform(canvas, src, { height: 40 })
      if (wave) {
        waves.push(wave)
        wave.on('play', () => { play.replaceChildren(icon('pause')) })
        wave.on('pause', () => { play.replaceChildren(icon('play')) })
        play.onclick = (event) => {
          event.stopPropagation()
          // One at a time: two voices playing over each other tells you nothing.
          for (const other of waves) if (other !== wave) other.pause()
          wave.playPause()
        }
      } else {
        const fallback = cardEl.fallback
        fallback.hidden = false
        fallback.src = src
      }
      card.onclick = (event) => {
        // Not when the click was meant for the waveform: that seeks.
        if (event.target.closest('.wave')) return
        state.audio = state.audio === voice.rel ? null : voice.rel
        markAvatar()
      }
      voices.append(card)
    }
    /* Last, after the list: it is the way out when nothing here is the one. */
    const addRow = mountRow('restyle-add-voice')
    const addVoice = addRow.el.add
    const voicePicker = addRow.el.picker
    voicePicker.onchange = async () => {
      const files = [...(voicePicker.files ?? [])]
      voicePicker.value = ''
      if (files.length) await takeVoices(files)
    }
    addVoice.onclick = () => voicePicker.click()
    voices.append(addVoice, voicePicker)
    markAvatar()
  }

  /** Show the question this model actually asks, and hide the other one. */
  const paintMode = () => {
    const avatar = avatarMode()
    const lipsync = takesOf() === 'video+audio'
    for (const node of [clipHead, list]) node.hidden = !wantsClip()
    for (const node of [faceHead, faces]) node.hidden = !wantsFace()
    for (const node of [voiceHead, voices]) node.hidden = !wantsVoice()
    clipHead.textContent = takesOf() === 'video+text' ? 'The shot so far' : lipsync ? 'The take' : 'The clip'
    /* The picture is a starting point when generating, not somebody's face. */
    faceHead.textContent = takesOf() === 'image+text' ? 'The starting picture' : 'The face'
    /* A model with no prompt parameter must not be asked for one — the lipsync
       pair take a clip and a voice and nothing else. */
    const asks = models.find((x) => x.id === state.model)?.controls?.includes('prompt') ?? true
    for (const node of [promptHead, promptIn]) node.hidden = !asks
    lede.textContent = takesOf() === 'video+text'
      ? 'Continue a shot Veo generated. Eight seconds is all one call makes, so a longer shot is a short one extended — about thirty seconds is the ceiling.'
      : generating()
      ? 'Describe a shot and it is generated, up to eight seconds, landing in Footage like anything you filmed. Starting from a still this project already has keeps it looking like the rest of the material.'
      : lipsync
      ? 'A real take keeps its face and its framing; only the mouth is re-timed to a new voice. Nothing is invented, which is why this beats an avatar when you already have the person on camera.'
      : avatar
        ? 'A photograph and a voice track become a video of that person speaking it. The voice is whatever this project already built under Voice.'
        : 'Hand one clip to a model with an instruction, and the result comes back as project footage. The original is never replaced.'
    /* The other question's complaint is not this question's. "No clip fits
       Kling O3" sat over the form while the page was asking for a face. */
    /* Set directly, not through says(): this is a standing instruction about
       the page, and says() is for things that have just happened. */
    dropHint.hidden = false
    dropHint.textContent = lipsync
      ? 'Drop an audio file here to lipsync to a voice this project does not have yet.'
      : wantsFace()
        ? 'Paste a picture, or drop one here, to use it as the face. Drop audio to add a voice.'
        : 'Paste a picture, or drop one here, to use it as a reference.'
    promptIn.placeholder = generating()
      ? 'What happens in the shot? Say it the way you would describe it to a camera operator.'
      : avatar
        ? 'Optional. How should they deliver it? Left blank, the model decides.'
        : 'What should change? The rest of the scene is kept.'
    setLabel(runBtn, takesOf() === 'video+text' ? 'Extend the shot' : generating() ? 'Generate the shot' : avatar ? 'Make the video' : 'Restyle the clip')
    if (wantsFace() || wantsVoice()) paintAvatar()
    if (wantsClip()) paintChoice()
  }


  /*
   * Only clips this model will take are selectable.
   *
   * Each model states its own limits — Kling wants 3-15s, Gemini documents
   * none — so eligibility is asked of the server per model rather than assumed,
   * and a clip that cannot be sent says why instead of failing a paid call.
   */
  const loadClips = async () => {
    list.replaceChildren()
    const result = await fetch(`/api/fal/clips?project=${encodeURIComponent(currentProject())}&model=${encodeURIComponent(state.model)}`)
      .then(responseJson)
      .catch(() => ({ error: 'could not read this project’s clips' }))
    if (result.error) return says(clipNote, result.error, 'bad')
    const usable = (result.clips ?? []).filter((c) => !c.problem)
    if (!usable.length) {
      /* Every card already carries its own reason — this is the quiet summary by
         the grid, not a toast shouting the same sentence over the header. */
      clipNote.hidden = false
      tone(clipNote, 'bad')
      clipNote.textContent = `No clip in this project fits ${models.find((x) => x.id === state.model)?.label ?? 'this model'}. ${(result.clips ?? [])[0]?.problem ?? ''}`
    } else clipNote.hidden = true
    const spec = models.find((x) => x.id === state.model)
    for (const clip of result.clips ?? []) {
      const { root: card, el: clipEl } = mountRow('restyle-clip-card')
      // The path, so paintChoice can find which card is the chosen one.
      card.dataset.rel = clip.rel
      const frame = clipEl.frame
      // The same poster the Library draws, so a clip looks the same everywhere.
      frame.style.backgroundImage = `url('/thumb/${currentProject()}/${encodeURI(clip.rel)}')`
      clipEl.nm.textContent = clip.rel.split('/').pop()
      clipEl.path.textContent = clip.problem ?? `${clip.seconds ?? '?'}s`

      /*
       * A clip too long for the model is trimmable, not unusable.
       *
       * Kling takes fifteen seconds and these takes are twenty to forty, so
       * refusing them outright would leave most of a project unreachable. The
       * trimmer picks a range inside the clip and only that range is sent.
       */
      /* The card itself selects. A button that stays put after it is pressed
         tells you nothing about what is currently chosen. */
      const usable = !clip.problem || clip.trimmable
      if (usable) {
        card.classList.add('clipcard')
        card.onclick = (event) => {
          // Not when the click was meant for Trim or Replace.
          if (event.target.closest('button')) return
          state.file = clip.rel
          state.inSec = null
          state.outSec = null
          paintChoice()
          if (wantsVoice()) paintAvatar()
        }
      }
      const trim = clipEl.trim
      trim.onclick = () => openTrimmer(clip, spec)

      /*
       * Swap the file under this path, keeping the path.
       *
       * A restyled take is a new file, and everything that already points at
       * the original — a composition, a board slot, a transcript — keeps
       * pointing at the original. Replacing in place is the only version of
       * "use this one instead" that those references follow.
       */
      const replace = clipEl.replace
      const picker = clipEl.picker
      picker.onchange = async () => {
        const file = picker.files?.[0]
        picker.value = ''
        if (!file) return
        replace.disabled = true
        setLabel(replace, 'Replacing…')
        const r = await fetch(
          `/api/media/replace?project=${encodeURIComponent(currentProject())}&rel=${encodeURIComponent(clip.rel)}&name=${encodeURIComponent(file.name)}`,
          { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file, duplex: 'half' },
        )
          .then(responseJson)
          .catch((error) => ({ error: error.message }))
        replace.disabled = false
        setLabel(replace, 'Replace…')
        if (r.error) return toast(r.error, 'bad')
        toast(`Replaced ${clip.rel.split('/').pop()}. The original is kept as ${r.kept}.`, 'ok')
        await loadClips()
      }
      replace.onclick = () => picker.click()
      list.append(card)
    }
    paintChoice()
    if (!usable.some((c) => c.rel === state.file)) state.file = null
  }

  /*
   * Pick a range inside a clip, the way a player does.
   *
   * Two handles over one video, scrubbing as you drag, because a duration
   * expressed as two numbers you type is a duration you get wrong — and the
   * models care about the exact length. The readout says whether the selection
   * fits the chosen model, so the answer is visible before the call rather than
   * after it.
   */
  function openTrimmer(clip, spec) {
    const trimUi = mountRow('restyle-trim-dialog')
    const dialog = trimUi.root
    const video = trimUi.el.video
    video.src = `/media/${encodeURIComponent(currentProject())}/${encodeURI(clip.rel)}`
    trimUi.el.name.textContent = clip.rel.split('/').pop()
    const close = trimUi.el.close
    close.append(icon('cancel-01'))
    close.onclick = () => dialog.close()

    const { inRange, outRange, readout, use } = trimUi.el

    const seconds = () => video.duration || clip.seconds || 0
    const at = (input) => (Number(input.value) / 1000) * seconds()
    const update = (scrubTo) => {
      // The handles cannot cross: an out before an in is a negative duration,
      // and every model would reject it with something less clear than this.
      if (Number(inRange.value) > Number(outRange.value) - 1) {
        if (scrubTo === 'in') outRange.value = String(Math.min(1000, Number(inRange.value) + 1))
        else inRange.value = String(Math.max(0, Number(outRange.value) - 1))
      }
      const from = at(inRange)
      const to = at(outRange)
      const span = to - from
      if (scrubTo) video.currentTime = scrubTo === 'in' ? from : to
      const min = spec?.limits?.minSeconds
      const max = spec?.limits?.maxSeconds
      const short = min && span < min
      const long = max && span > max
      use.disabled = short || long || span <= 0
      says(
        readout,
        `${fmt(from)} – ${fmt(to)}  ·  ${span.toFixed(1)}s` +
          (long ? ` — ${spec.label} takes at most ${max}s` : short ? ` — ${spec.label} needs at least ${min}s` : ' — fits'),
        long || short ? 'bad' : 'ok',
      )
    }
    inRange.oninput = () => update('in')
    outRange.oninput = () => update('out')
    video.addEventListener('loadedmetadata', () => {
      // Open on a range that already fits, so the common case is one click.
      const max = spec?.limits?.maxSeconds
      // Floor, not round: rounding up lands a hair over the ceiling, so the
      // default selection opened saying it was too long by 0.04 of a second.
      if (max && seconds() > max) outRange.value = String(Math.floor((max / seconds()) * 1000))
      update('in')
    })

    use.onclick = () => {
      state.file = clip.rel
      state.inSec = Number(at(inRange).toFixed(2))
      state.outSec = Number(at(outRange).toFixed(2))
      dialog.close()
      paintChoice()
    }

    const play = trimUi.el.play
    play.onclick = () => {
      video.currentTime = at(inRange)
      void video.play()
      const stop = () => {
        if (video.currentTime >= at(outRange)) {
          video.pause()
          video.removeEventListener('timeupdate', stop)
        }
      }
      video.addEventListener('timeupdate', stop)
    }
    dialog.onclick = (e) => { if (e.target === dialog) dialog.close() }
    dialog.addEventListener('close', () => {
      video.pause()
      video.removeAttribute('src')
      video.load()
      dialog.remove()
    })
    document.body.append(dialog)
    dialog.showModal()
  }

  const paintPanel = () => {
    panel.replaceChildren()
    const sec = (t) => panel.append(control('div', { className: 'sec', textContent: t }))
    const g = () => { const d = mountRow('form-group-bare').root; panel.append(d); return d }
    const lab = (t) => Object.assign(mountRow('form-label').root, { textContent: t })

    sec('Model')
    const chooser = g()
    const select = control('select', { className: 'wide form-control' })
    for (const model of models) {
      select.append(new Option(model.label, model.id, false, model.id === state.model))
    }
    select.onchange = () => {
      state.model = select.value
      const next = models.find((x) => x.id === state.model)
      // A model's own default, and only as many references as it accepts.
      state.resolution = next?.limits?.defaultResolution ?? null
      state.syncMode = next?.limits?.defaultSyncMode ?? null
      state.aspect = next?.limits?.defaultAspect ?? null
      state.duration = next?.limits?.defaultDuration ?? null
      if (next?.limits?.maxImages) state.images = state.images.slice(0, next.limits.maxImages)
      else state.images = []
      paintPanel()
      paintMode()
      if (wantsClip()) void loadClips()
    }
    chooser.append(lab('Model'), select)
    const spec = models.find((x) => x.id === state.model)
    if (spec?.hint) panel.append(control('hint', { className: 'form-hint hint', textContent: spec.hint }))

    // Only the controls this model actually has. A resolution dial on a model
    // with no resolution parameter is a promise the request cannot keep.
    if (spec?.controls.includes('keepAudio')) {
      const box = g()
      const check = control('input', { type: 'checkbox', className: 'form-control form-control--medium', checked: state.keepAudio })
      check.onchange = () => { state.keepAudio = check.checked }
      // Control first: the label is styled as the checkbox's partner, and a
      // sibling selector cannot reach backwards.
      box.append(check, lab('Keep audio'))
    }
    /*
     * The shot's shape, length and weight.
     *
     * Offered from the model's own lists rather than one shared set: Veo takes
     * auto only when it is starting from a picture, because "auto" means the
     * still's own aspect and there is no still in the other case.
     */
    for (const [field, label, key, options] of [
      ['aspect', 'Aspect', 'aspects', spec?.limits?.aspects],
      ['duration', 'Length', 'durations', spec?.limits?.durations],
    ]) {
      if (!spec?.controls.includes(field) || !options?.length) continue
      const box = g()
      const pick = control('select', { className: 'wide form-control' })
      for (const option of options) {
        pick.append(new Option(option, option, false, option === state[field]))
      }
      pick.onchange = () => { state[field] = pick.value }
      box.append(lab(label), pick)
    }

    /*
     * Audio off by default is not the model's default, and that is deliberate:
     * a generated soundtrack under a project that already has a voice track is
     * two things talking at once. Left on, because surprising somebody by
     * silently dropping audio they paid to generate is worse.
     */
    if (spec?.controls.includes('generateAudio')) {
      const box = g()
      const check = control('input', { type: 'checkbox', className: 'form-control form-control--medium', checked: state.generateAudio })
      check.onchange = () => { state.generateAudio = check.checked }
      // Control first: the label is styled as the checkbox's partner, and a
      // sibling selector cannot reach backwards.
      box.append(check, lab('Generate audio'))
    }

    /*
     * What happens when the take and the voice are different lengths.
     *
     * The one choice that decides whether a lipsync is usable: a 19-second take
     * against a 90-second narration defaults to cut_off, which throws the rest
     * of the voice away. Named in plain words because "bounce" and "remap" say
     * nothing about what you will get.
     */
    if (spec?.controls.includes('syncMode')) {
      const box = g()
      const how = control('select', { className: 'wide form-control' })
      const says = {
        cut_off: 'Cut off — stop when the shorter one ends',
        loop: 'Loop — repeat the take to cover the voice',
        bounce: 'Bounce — play the take forwards and back',
        silence: 'Silence — hold the last frame, no more speech',
        remap: 'Remap — stretch the take to the voice',
      }
      for (const option of spec.limits.syncModes ?? []) {
        how.append(new Option(says[option] ?? option, option, false, option === (state.syncMode ?? spec.limits.defaultSyncMode)))
      }
      how.onchange = () => { state.syncMode = how.value }
      box.append(lab('If the lengths differ'), how)
    }
    if (spec?.controls.includes('resolution')) {
      const box = g()
      const res = control('select', { className: 'wide form-control' })
      // Each model publishes its own set; Wan VACE offers auto and 240p, Gemini
      // offers 4k. One shared list would offer values half of them reject.
      for (const option of spec.limits.resolutions ?? []) {
        res.append(new Option(option, option, false, option === state.resolution))
      }
      res.onchange = () => { state.resolution = res.value }
      box.append(lab('Resolution'), res)
    }

    /*
     * Reference images, when the model takes them.
     *
     * The parameter differs by model — image_urls, reference_image_urls, or a
     * single reference_image_url — and the registry maps this one list onto
     * whichever it is. Bernini-R Reference requires at least one, so it says so
     * rather than failing the call.
     */
    if (spec?.controls.includes('images')) {
      const max = spec.limits.maxImages ?? 0
      panel.append(control('div', { className: 'sec', textContent: max === 1 ? 'Reference image' : 'Reference images' }))
      if (spec.requiresImages) {
        panel.append(control('hint', { className: 'form-hint hint', textContent: `${spec.label} needs at least one.` }))
      }
      if (!projectImages.length) {
        panel.append(control('hint', { className: 'form-hint hint', textContent: 'Paste or drop a picture to use one.' }))
      }
      /*
       * Pictures as pictures.
       *
       * This was a filename and a checkbox per row, which in a 320px rail wraps
       * the label onto its own line and strands the box under it — and a
       * reference image is chosen by looking at it, not by reading
       * "academy-questionmark.webp".
       */
      const shelf = control('div', { className: 'grid refshelf' })
      for (const rel of projectImages) {
        const { root: tile, el: tileEl } = mountRow('restyle-ref-tile')
        tile.title = rel
        const art = tileEl.art
        art.style.backgroundImage = `url('/media/${currentProject()}/${encodeURI(rel)}')`
        if (state.images.includes(rel)) tile.classList.add('on')
        tile.onclick = () => {
          if (state.images.includes(rel)) state.images = state.images.filter((x) => x !== rel)
          else state.images.push(rel)
          // Keep the newest choices when the model takes fewer than were ticked.
          if (max && state.images.length > max) state.images = state.images.slice(-max)
          paintPanel()
        }
        shelf.append(tile)
      }
      panel.append(shelf)
    }

    sec('fal.ai')
    const keyBox = g()
    const keyIn = control('input', { type: 'password', className: 'wide form-control', placeholder: configured ? 'replace the key' : 'paste your fal key' })
    const saveKey = control('button', { className: 'btn ghost', textContent: 'Save key' })
    saveKey.prepend(icon('key-01'))
    saveKey.onclick = async () => {
      const result = await fetch('/api/fal/settings', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: keyIn.value }),
      }).then(responseJson).catch((error) => ({ error: error.message }))
      if (result.error) return toast(result.error, 'bad')
      configured = true
      keyIn.value = ''
      runBtn.disabled = false
      toast('fal key saved.', 'ok')
      paintPanel()
    }
    keyBox.append(lab('Key'), keyIn)
    panel.append(saveKey)
  }

  /*
   * The mark, animating itself, over the clip being worked on.
   *
   * assets/mark-animated.svg is an SVGator export whose motion is a CSS
   * @keyframes block inside the file — no <script>, no SMIL. CSS animations do
   * run in an SVG referenced by <img>, so <img> is enough, and it is what this
   * wants: an <object> is a nested browsing context, and a browser paints an
   * opaque white base behind one. That white square sat behind the mark on
   * every restyle. An <img> has no document of its own and no base to paint.
   */
  const spinnerFor = (card) => {
    const { root: veil, el: workingEl } = mountRow('restyle-working')
    card.append(veil)
    return { veil, line: workingEl.line }
  }

  runBtn.onclick = async () => {
    const avatar = avatarMode()
    const subject = wantsFace() ? state.image : state.file
    if (generating()) {
      if (!state.prompt.trim()) return toast('Describe the shot first.', 'bad')
      if (takesOf() === 'image+text' && !state.image) return toast('Pick a picture to start from.', 'bad')
      if (takesOf() === 'video+text' && !state.file) return toast('Pick the shot to continue.', 'bad')
    } else if (avatar && !(subject && state.audio)) {
      return toast(`Pick a ${wantsFace() ? 'picture' : 'clip'} and a voice track first.`, 'bad')
    } else if (!avatar && !state.file) return toast('Pick a clip first.', 'bad')
    const built = await fetch('/api/fal/edit', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: currentProject(), model: state.model, file: state.file, prompt: state.prompt, keepAudio: state.keepAudio, resolution: state.resolution, images: state.images, inSec: state.inSec, outSec: state.outSec, image: state.image, audio: state.audio, syncMode: state.syncMode, aspect: state.aspect, duration: state.duration, generateAudio: state.generateAudio }),
    }).then(responseJson).catch((error) => ({ error: error.message }))
    if (built.error) return toast(built.error, 'bad')

    // The spinner sits on whatever was chosen — the face for an avatar, the
    // clip for an edit — because that is where the eye already is.
    /* Nothing to put a spinner on when the shot does not exist yet. */
    const held = subject
    const card = held ? (wantsFace() ? faces : list).querySelector(`.card[data-rel="${CSS.escape(held)}"]`) : null
    const spinner = card ? spinnerFor(card) : null
    runBtn.disabled = true
    const job = await start(built.step)
    if (!job) {
      spinner?.veil.remove()
      runBtn.disabled = false
      return
    }

    /*
     * The job's own output stream, straight onto the card.
     *
     * watchJobInPlace hides a local status while a job runs, on purpose — that
     * is the behaviour being replaced here. And /api/jobs only carries a line
     * COUNT, not the lines, so polling it can say that something is happening
     * and never what. The events stream is what the Console reads, and it
     * carries fal's own queue messages.
     */
    const finish = (message, level) => {
      spinner?.veil.remove()
      runBtn.disabled = false
      if (message) toast(message, level)
    }
    const stream = new EventSource(`/api/jobs/${job.id}/events`)
    let lastError = null
    stream.onmessage = async (event) => {
      const data = JSON.parse(event.data)
      if (data.done) {
        stream.close()
        void refreshJobs()
        if (data.code === 0) {
          finish(takesOf() === 'video+text' ? 'Extended. The longer shot is in Footage.' : generating() ? 'Generated. The shot is in Footage.' : avatar ? 'Made. The video is in Footage.' : 'Restyled. The result is in Footage beside the original.', 'ok')
          if (!avatar) await loadClips()
        } else {
          finish(lastError ?? `That ${avatar ? 'avatar' : 'restyle'} did not finish — the Console has the output.`, 'bad')
        }
        return
      }
      const text = String(data.text ?? '').trim()
      if (!text) return
      // rm-fal reports its own refusals with a prefix; keep the last one so the
      // toast can say why rather than "it failed".
      if (/^rm-fal:/.test(text) || data.stream === 'err') lastError = text.replace(/^rm-fal:\s*/, '')
      if (spinner) spinner.line.textContent = text.slice(0, 80)
    }
    stream.onerror = () => {
      stream.close()
      finish('Studio lost the connection to that restyle — the Console has it.', 'bad')
    }
  }

  /*
   * Paste a picture straight in.
   *
   * A reference is usually a screenshot or something copied from a browser, and
   * the alternative is save-to-Downloads, find it, import it, come back. It is
   * uploaded into the project rather than held in the page: the models take a
   * URL, the file has to exist somewhere, and the project is where its other
   * media already lives.
   */
  const onPaste = async (event) => {
    const pictures = [...(event.clipboardData?.items ?? [])]
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter(Boolean)
    if (!pictures.length) return
    event.preventDefault()
    await takePictures(pictures)
  }

  /*
   * A voice that is not in the project yet.
   *
   * The picker could only offer what Voice had already built, which is right
   * until the take you want to lipsync to is a file somebody sent you. Audio
   * lands in Audio/ by the same import the rest of the app uses, so it is a
   * project asset afterwards rather than something this panel alone knows
   * about — and the freshly added one is selected, because adding it was the
   * act of choosing it.
   */
  const takeVoices = async (files) => {
    let added = null
    for (const file of files) {
      const r = await fetch(`/api/import/upload?project=${encodeURIComponent(currentProject())}&name=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: file,
        duplex: 'half',
      })
        .then(responseJson)
        .catch((error) => ({ error: error.message }))
      if (r.error) {
        toast(r.error, 'bad')
        continue
      }
      added = `${r.into}/${r.renamed ?? file.name}`
    }
    if (!added) return
    projectVoices = await fetch(`/api/fal/voices?project=${encodeURIComponent(currentProject())}`)
      .then(responseJson)
      .then((r) => r.voices ?? [])
      .catch(() => projectVoices)
    state.audio = added
    paintAvatar()
    toast(`Added ${added.split('/').pop()}.`, 'ok')
  }

  /** Put pictures into the project and offer them as references. */
  const takePictures = async (pictures) => {
    const spec = models.find((x) => x.id === state.model)
    let added = 0
    for (const picture of pictures) {
      // Clipboard files are usually called "image.png" or nothing at all, so
      // the name is made here rather than trusted — two pastes must not collide.
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const extension = (picture.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg')
      const name = `pasted-${stamp}-${added + 1}.${extension}`
      const r = await fetch(`/api/import/upload?project=${encodeURIComponent(currentProject())}&name=${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: picture,
        duplex: 'half',
      })
        .then(responseJson)
        .catch((error) => ({ error: error.message }))
      if (r.error) {
        toast(r.error, 'bad')
        continue
      }
      added += 1
      const rel = `${r.into}/${r.renamed ?? name}`
      if (!projectImages.includes(rel)) projectImages.unshift(rel)
      // Tick what was just pasted, up to what this model accepts.
      if (spec?.controls.includes('images')) {
        state.images.push(rel)
        const max = spec.limits.maxImages ?? 0
        if (max && state.images.length > max) state.images = state.images.slice(-max)
      }
    }
    if (!added) return
    paintPanel()
    if (avatarMode()) paintAvatar()
    toast(added === 1 ? 'Pasted one picture into the project.' : `Pasted ${added} pictures into the project.`, 'ok')
  }
  document.addEventListener('paste', onPaste)
  window.addEventListener('rm:before-navigate', () => {
    document.removeEventListener('paste', onPaste)
    // Each waveform holds a media element and an AudioContext; leaving the page
    // with them alive keeps the audio decoded and, if one is playing, audible.
    dropWaves()
  }, { once: true })

  /*
   * Dragged in from Finder, or from another app.
   *
   * The same destination as a paste, and here because the macOS share sheet is
   * not something this can offer: receiving a share needs an app extension
   * inside the packaged .app, which lives in the desktop shell rather than in
   * Studio's page. Dropping a file reaches the same place with what a browser
   * already gives us.
   */
  for (const name of ['dragenter', 'dragover']) {
    m.addEventListener(name, (event) => {
      if (!event.dataTransfer?.types.includes('Files')) return
      event.preventDefault()
      m.classList.add('dropzone--over')
    })
  }
  for (const name of ['dragleave', 'drop']) m.addEventListener(name, () => m.classList.remove('dropzone--over'))
  m.addEventListener('drop', async (event) => {
    const dropped = [...(event.dataTransfer?.files ?? [])]
    const pictures = dropped.filter((file) => file.type.startsWith('image/'))
    const heard = dropped.filter((file) => file.type.startsWith('audio/'))
    if (!pictures.length && !heard.length) return
    event.preventDefault()
    if (pictures.length) await takePictures(pictures)
    if (heard.length) await takeVoices(heard)
  })

  void (async () => {
    const settings = await fetch('/api/fal/settings').then(responseJson).catch(() => ({ error: 'could not reach Studio' }))
    if (settings.error) return says(clipNote, settings.error, 'bad')
    models = settings.models ?? []
    configured = settings.configured
    state.model = settings.defaultModel
    state.resolution = models.find((x) => x.id === state.model)?.limits?.defaultResolution ?? null
    const project = encodeURIComponent(currentProject())
    ;[projectImages, projectVoices] = await Promise.all([
      fetch(`/api/fal/images?project=${project}`).then(responseJson).then((r) => r.images ?? []).catch(() => []),
      fetch(`/api/fal/voices?project=${project}`).then(responseJson).then((r) => r.voices ?? []).catch(() => []),
    ])
    runBtn.disabled = !configured
    if (!configured) runBtn.title = 'Add a fal key to run a model.'
    paintPanel()
    paintMode()
    if (wantsClip()) await loadClips()
  })()
}

/* ── Storage ─────────────────────────────────────────────── */
/*
 * Where a finished video goes, and what it takes to send it there.
 *
 * On Storage rather than beside the OpenFrame settings on Review, because this
 * page is already the answer to "where do things end up" — and because Slack is
 * a destination whether or not OpenFrame is ever adopted.
 *
 * The token is write-only, like the OpenFrame one: it goes in, it is stored 0600,
 * and it never comes back out. `auth.test` is asked instead, so the panel can
 * say which workspace answered without ever showing the credential.
 */
function slackPanel(host) {
  const { root: box, el: panel } = mountRow('slack-panel')
  const { lede, who, form: f } = panel
  const mk = (label, node, hint) => field(f, label, node, hint)
  const tokIn = mk(
    'Bot token',
    control('input', { type: 'password', placeholder: 'xoxb-…' }),
    'Slack app → OAuth & Permissions → Bot User OAuth Token. Needs files:write, chat:write, and channels:read to find a channel by name. Stored 0600 on this machine and shared with the team once you are signed in — never shown again.',
  )
  const chanIn = mk(
    'Channel ID',
    control('input', { placeholder: '#demos' }),
    'A name like #demos is fine — Studio looks the id up. Invite the app to the channel first with /invite, or Slack will refuse the post.',
  )
  const out = control('full')
  const save = control('button', { textContent: 'Connect' })
  save.prepend(icon('plug-01'))
  const wrap = control('full')
  wrap.append(save)
  f.append(wrap, out)
  host.append(box)

  /*
   * Connected is the resting state, and it is not a form.
   *
   * Two password-shaped fields sitting open under a working connection invite
   * somebody to retype a credential that was already right — and the lede
   * explaining what Slack posting is for stops being news the moment it is set
   * up. Once it works this collapses to one line and a Change button, the same
   * way the storage form gets out of the way once a remote exists.
   */
  const change = control('button', { className: 'btn btn--hint btn--small', textContent: 'Change', hidden: true })
  change.onclick = () => {
    slackSettingsOpen = true
    f.hidden = false
    lede.hidden = false
    change.hidden = true
    tokIn.focus()
  }
  who.append(' ')
  // .add is a DOMTokenList method; `who` is a div, so this threw every time the
  // Slack panel drew and took the rest of the panel with it.
  who.append(change)

  /** Ask the server who the stored token turned out to be. */
  const draw = async () => {
    const d = await fetch('/api/slack').then(responseJson).catch(() => ({ error: 'the Studio did not answer' }))
    // Rebuilt each time, so the Change button is re-attached rather than lost.
    who.textContent = ''
    const settled = (text, kind, { connected }) => {
      tone(who, kind)
      who.textContent = text
      who.append(' ')
      who.append(change)
      // Hidden only when it is genuinely working AND nobody asked to edit it.
      const tidy = connected && !slackSettingsOpen
      f.hidden = tidy
      lede.hidden = tidy
      change.hidden = !tidy
    }
    if (d.error) return settled(d.error, 'bad', { connected: false })
    if (!d.configured) return settled('Not connected yet.', 'warn', { connected: false })
    if (d.team) {
      return settled(
        `Posting to ${d.team}${d.user ? ` as ${d.user}` : ''}${d.channel ? ` · channel ${d.channel}` : ' · no default channel yet'}${d.shared ? ' · from the team settings' : ''}.`,
        'ok',
        // A token with no channel is not finished: the post has nowhere to go,
        // so the form stays up rather than looking done.
        { connected: Boolean(d.channel) },
      )
    }
    // Configured, but Slack refused it. Say so rather than showing a tick.
    return settled(d.error ?? 'A token is stored, but Slack did not accept it.', 'bad', { connected: false })
  }

  save.onclick = async () => {
    out.replaceChildren()
    const hint = control('hint')
    out.append(hint)
    const payload = {}
    if (tokIn.value) payload.token = tokIn.value
    if (chanIn.value.trim()) payload.channel = chanIn.value.trim()
    if (!Object.keys(payload).length) {
      tone(hint, 'warn')
      hint.textContent = 'Fill in whichever one is missing.'
      return
    }
    save.disabled = true
    const r = await fetch('/api/slack/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
      .then(responseJson)
      .catch(() => ({ error: 'the Studio did not answer — is it still running on this port?' }))
    save.disabled = false
    if (r.error) {
      tone(hint, 'bad')
      hint.textContent = r.error
      return
    }
    // Not kept a moment longer than the request that used it.
    tokIn.value = ''
    tone(hint, r.scopeProblem || r.shareProblem ? 'warn' : 'ok')
    // Say which of the two places it reached. "Saved" without saying where is
    // the thing that makes somebody set this up twice.
    const where = r.shareProblem
      ? `Saved in ${r.stored} — ${r.shareProblem}`
      : `Saved in ${r.stored}, and shared with the team${r.sharedWith && r.sharedWith !== 'the team' ? ` as ${r.sharedWith}` : ''}.`
    /*
     * The scope problem first, because it is the one that will bite.
     *
     * A token missing a read scope saves fine and then fails the upload with
     * `channel_not_found`, which reads as a wrong channel id. Saying it here is
     * the difference between fixing the Slack app and re-checking the id.
     */
    hint.textContent = r.scopeProblem ? `${r.scopeProblem}. ${where}` : where
    // Left open when there is something to read: closing the panel on a warning
    // is how the warning goes unread.
    slackSettingsOpen = Boolean(r.scopeProblem)
    await draw()
  }
  void draw()
}

function vStorage(m) {
  const ui = mountPanel('storage', m)
  slackPanel(ui.slackHost)

  /*
   * One form, two jobs: add a remote, or edit one that exists.
   *
   * A separate edit screen would have to repeat every field and every validation
   * rule, and the two would drift. `editing` holds the name being edited, or null
   * for a new remote, and the form reads its own labels off that.
   */
  let editing = null

  const f = ui.form
  f.hidden = S.remotes.length > 0 && !storageSettingsOpen
  const mk = (l, n, hint) => field(f, l, n, hint)
  const name = mk('Remote name', control('input', { placeholder: 'rm-video' }))

  /*
   * Which S3 this is, because it was always Cloudflare's.
   *
   * rclone uses `provider` to decide which dialect of S3 it is speaking, and it
   * was pinned — so pointing the old form at an AWS endpoint produced a remote
   * that authenticated and then failed on operations, which reads as bad
   * credentials. R2 stays the default: it is what this pipeline recommends, and
   * it has no egress fee.
   */
  const provider = mk('Provider', control('select'), 'What kind of S3 this is. rclone speaks a slightly different dialect to each.')
  for (const [v, label] of [
    ['Cloudflare', 'Cloudflare R2'],
    ['AWS', 'Amazon S3'],
    ['DigitalOcean', 'DigitalOcean Spaces'],
    ['Wasabi', 'Wasabi'],
    ['Minio', 'MinIO'],
    ['Other', 'Other S3-compatible'],
  ]) {
    provider.append(new Option(label, v))
  }

  const ep = mk('Endpoint', control('input', { placeholder: 'https://<account>.r2.cloudflarestorage.com' }))
  const region = mk('Region', control('input', { placeholder: 'us-east-1' }), 'Amazon wants a region and works out the endpoint itself. The others want an endpoint.')
  const ak = mk('Access key', control('input'))
  const sk = mk('Secret key', control('input', { type: 'password' }))

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
  const out = control('pre')
  out.style.display = 'none'
  const go = control('button', { textContent: 'Save remote' })
  go.prepend(icon('floppy-disk'))
  const cancel = control('button', { textContent: 'Cancel', className: 'btn ghost' })
  cancel.style.display = 'none'
  const w = control('full', { className: 'full row' })
  w.append(go, cancel)
  f.append(w, out)

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
    setLabel(go, 'Save remote')
    cancel.style.display = 'none'
    out.style.display = 'none'
    /* The label is the sentence that tells you which mode you are in. */
    name.closest('.form-group').querySelector('.form-label').textContent = 'Remote name'
  }

  const openSettings = ({ remote = null } = {}) => {
    f.hidden = false
    if (remote) {
      void edit(remote)
      return
    }
    if (!editing) newRemote()
    f.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const edit = async (n) => {
    const r = await responseJson(await fetch('/api/storage/' + encodeURIComponent(n)))
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
    setLabel(go, 'Save changes')
    cancel.style.display = ''
    out.style.display = 'none'
    f.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }

  cancel.onclick = () => {
    newRemote()
    storageSettingsOpen = false
    if (S.remotes.length) f.hidden = true
  }

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
    const r = await responseJson(await fetch(editing ? '/api/storage/' + encodeURIComponent(editing) : '/api/storage', {
        method: editing ? 'PUT' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }))
    go.disabled = false
    if (!r.ok) return say('Failed:\n' + (r.err || r.out || r.error))
    say(editing ? 'Saved. "' + editing + '" updated.' : 'Saved. rclone remote "' + name.value + '" is ready — pick it when creating a project.')
    newRemote()
    storageSettingsOpen = false
    if (S.remotes.length) f.hidden = true
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
  for (const section of [ui.browseHead, ui.crumbRow, ui.listing, ui.dropZone, ui.remotesHead, ui.remotes]) section.hidden = false

  let atRemote = S.remotes[0]
  let atPath = ''
  let entries = []
  let busy = false

  const { crumbRow, listing, dropZone, s3Hint, remotePick } = ui
  for (const r of S.remotes) remotePick.append(new Option(r, r))
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
    for (const old of crumbRow.querySelectorAll('button')) old.remove()
    const parts = atPath ? atPath.split('/') : []
    const root = control('button', { className: 'btn ghost btn--pill', textContent: atRemote + ':' })
    root.onclick = () => {
      atPath = ''
      void refresh()
    }
    crumbRow.append(root)
    parts.forEach((part, i) => {
      const b = control('button', { className: 'btn ghost btn--pill', textContent: part })
      b.onclick = () => {
        atPath = parts.slice(0, i + 1).join('/')
        void refresh()
      }
      crumbRow.append(b)
    })

    const mk2 = control('button', { className: 'btn ghost btn--pill', textContent: 'New folder' })
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
    listing.replaceChildren()
    if (!entries.length) {
      listing.append(control('empty', { textContent: atPath ? 'Nothing in this folder.' : 'Nothing in this remote yet. Drop a file below, or upload a render from a project.' }))
      return
    }
    // Folders first, then names: a bucket of renders is mostly files, and a
    // folder you cannot find is a folder you make a second copy of.
    const sorted = [...entries].sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
    for (const e of sorted) {
      const { root: row, el: cells } = mountRow('s3-entry')
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

      row.prepend(icon(e.dir ? 'folder-01' : 'file-01', 's3row__icon'))
      const label = cells.name
      label.textContent = e.name
      label.onclick = () => {
        if (!e.dir) return
        atPath = atPath ? `${atPath}/${e.name}` : e.name
        void refresh()
      }
      const meta = cells.meta
      meta.textContent = e.dir ? '' : `${human(e.size)}${e.modified ? ' · ' + ago(e.modified) : ''}`

      const full = atPath ? `${atPath}/${e.name}` : e.name
      const items = []
      if (!e.dir) {
        /*
         * A link to hand somebody, without downloading and re-uploading it.
         *
         * rclone makes it, because only rclone knows how this remote is
         * configured — for S3 it is a presigned URL rather than a public path.
         * The expiry it comes back with is said out loud: a link that quietly
         * stops working next week is worse than one whose lifetime you were told.
         */
        items.push({
          icon: 'link-01',
          text: 'Copy link',
          busy: 'Making a link…',
          run: async () => {
            const r = await fetch(`/api/storage/${encodeURIComponent(atRemote)}/link?path=${encodeURIComponent(full)}`)
              .then(responseJson)
              .catch(() => ({ error: 'the Studio did not answer' }))
            if (r.error) return r.error
            const failed = await copyText(r.url)
            if (failed) return failed
            toast(r.expiry ? `Link copied — it expires in ${r.expiry}.` : 'Link copied.', 'ok')
          },
        })
        items.push({
          icon: 'download-01',
          text: 'Download',
          run: () => {
            // A plain link rather than fetch-then-blob: the file can be
            // gigabytes, and the browser already knows how to stream one to disk.
            const a = control('link', { href: `/api/storage/${encodeURIComponent(atRemote)}/get?path=${encodeURIComponent(full)}`, download: e.name })
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
      row.append(menu)
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

  dropZone.prepend(icon('upload-04'))
  const s3Picker = ui.picker
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
    listing.replaceChildren(control('empty', { textContent: 'Reading…' }))
    const r = await fetch(`/api/storage/${encodeURIComponent(atRemote)}/ls?path=${encodeURIComponent(atPath)}`)
      .then((x) => x.json())
      .catch((e) => ({ ok: false, err: e.message }))
    if (mine !== listingSeq) return
    if (!r.ok) {
      entries = []
      listing.replaceChildren()
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
      listing.append(control('empty', { textContent: why || 'That listing did not come back. The Studio may have been restarting.' }))
      const { root: retryRow, el: retry } = mountRow('s3-retry')
      retry.again.onclick = () => void refresh()
      listing.append(retryRow)
      return
    }
    entries = r.entries
    paintList()
  }

  void refresh()

  const g = ui.remotes
  for (const r of S.remotes) {
    const { root: c, el: card } = mountRow('storage-remote')
    const status = card.status
    card.name.textContent = r
    card.edit.onclick = () => openSettings({ remote: r })

    /*
     * Credentials that saved are not credentials that work, and the gap only
     * shows up much later in a failed sync. Listing the buckets is the cheapest
     * call that actually authenticates.
     */
    const test = card.test
    test.onclick = async () => {
      test.disabled = true
      status.textContent = 'testing…'
      const t = await responseJson(await fetch('/api/storage/' + encodeURIComponent(r), { method: 'POST' }))
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
          const d = await responseJson(await fetch('/api/storage/' + encodeURIComponent(r), { method: 'DELETE' }))
          if (!d.ok) return (d.err || '').split('\n')[0].slice(0, 90) || 'could not delete that remote'
          if (editing === r) newRemote()
          await load()
        },
      },
    ])
    remoteMenu.classList.add('s3row__menu')

    card.row.append(remoteMenu)
    g.append(c)
  }
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
    banner = mountRow('stale-banner').root
    banner.onclick = () => location.reload()
    document.body.append(banner)
  }
  check()
  window.addEventListener('focus', check)
})()
