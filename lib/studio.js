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
  SP = null
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
  if (!WP) WP = await import('/wallpaper.mjs')
  // The same parser lib/narration.mjs uses. Served, not re-implemented — a
  // preview that disagrees with the synthesiser is worse than no preview.
  if (!SP) SP = await import('/script-parse.mjs')
  S = await (await fetch('/api/state')).json()
  $('#root').textContent = S.libraryRoot
  $('#tools').innerHTML =
    Object.entries(S.tools)
      .map(([k, v]) => `<div><span class="dot ${v ? 'on' : 'off'}"></span>${k}</div>`)
      .join('') + `<div><span class="dot ${S.remotes.length ? 'on' : 'off'}"></span>${S.remotes.length} remote${S.remotes.length === 1 ? '' : 's'}</div>`
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
const VIEW_LABEL = {
  library: 'Library',
  new: 'New project',
  create: 'New video',
  scripts: 'Scripts',
  voice: 'Voice',
  brand: 'Brand',
  wallpapers: 'Wallpapers',
  components: 'Components',
  storage: 'Storage',
  console: 'Console',
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
  crumbs([{ label: VIEW_LABEL[view] ?? view }])
  ;({ library: vLibrary, new: vNew, create: vCreate, record: vRecord, make: vMake, scripts: vScripts, brand: vBrand, wallpapers: vWallpapers, storage: vStorage, console: vConsole, recast: vRecast, components: vComponents, voice: vVoice })[view](m)
}

function go(v) {
  view = v
  for (const o of document.querySelectorAll('nav button[data-v]')) o.setAttribute('aria-current', String(o.dataset.v === v))
  render()
}

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

  const open = async (path) => {
    const d = await (await fetch('/api/browse' + (path ? '?path=' + encodeURIComponent(path) : ''))).json()
    panel.innerHTML = ''
    const box = el('div', 'joblist')
    if (d.error) {
      box.append(Object.assign(el('div', 'job'), { textContent: d.error }))
      panel.append(box)
      return
    }
    box.append(Object.assign(el('div', 'crumb'), { textContent: d.path }))
    const entry = (text, tag, onClick) => {
      const r = el('div', 'job')
      const e = el('div', 'ent')
      e.append(Object.assign(el('div', 'nm2'), { textContent: text }), Object.assign(el('div', 'tag'), { textContent: tag || '' }))
      r.append(e)
      r.onclick = onClick
      box.append(r)
    }
    if (opts.allowDir)
      entry('Use this folder', 'choose', () => {
        input.value = d.path
        settle()
      })
    if (d.parent) entry('..', 'up', () => open(d.parent))
    for (const dir of d.dirs) entry(dir.name + '/', 'folder', () => open(dir.path))
    let hidden = 0
    for (const file of d.files) {
      if (opts.accept && !opts.accept(file)) {
        hidden++
        continue
      }
      const tag = file.trace ? 'trace' : file.video ? 'video' : file.subs ? 'subtitles' : 'file'
      entry(file.name, tag, () => {
        input.value = file.path
        settle()
      })
    }
    if (hidden) box.append(Object.assign(el('div', 'crumb'), { textContent: hidden + ' other file' + (hidden === 1 ? '' : 's') + ' here, not the kind this field wants' }))
    panel.append(box)
  }
  browse.onclick = () => {
    if (panel.innerHTML) panel.innerHTML = ''
    else open(input.value.trim() || undefined)
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

  m.append(el('p', 'lede', 'Every project in the library. Indexed automatically — whatever is on disk is what you see.'))

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
  m.append(el('h2', null, p.name), el('p', 'lede', `${p.client || 'No client'} · ${p.brand} · ${f.files.length} file${f.files.length === 1 ? '' : 's'}${f.bytes ? ' · ' + human(f.bytes) : ''} · updated ${ago(f.newest)}`))

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
    note.textContent = 'opening in OpenScreen...'
    const r = await (
      await fetch('/api/open-media', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: project.id, rel: f.rel }),
      })
    ).json()
    tone(note, r.error ? 'bad' : 'ok')
    note.textContent = r.error ?? r.note ?? 'opened'
  }
  c.style.cursor = 'pointer'
  return c
}

/* ── New project ─────────────────────────────────────────── */
function vNew(m) {
  m.append(el('h2', null, 'New project'), el('p', 'lede', 'A project is a folder with a manifest. Client is separate from project name — Feeney and Hershey are two clients, not one project.'))
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
  m.append(el('h2', null, 'Make a video'), el('p', 'lede', 'Paste a script or a URL. This writes a brief.md into the project, then runs it through Claude — which is where HyperFrames lives.'))
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

    const c = el('button', 'btn ghost', 'Copy the prompt')
    c.onclick = () =>
      navigator.clipboard
        ?.writeText(r.prompt)
        .then(() => {
          c.textContent = 'Copied'
          setTimeout(() => (c.textContent = 'Copy the prompt'), COPIED_MS)
        })
        .catch(() => {})
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

  m.append(Object.assign(el('div', 'note'), { innerHTML: "Recording is the one step that can fail for a reason the log won't explain: macOS grants Screen Recording permission to whatever hosts Electron. If <code>record</code> exits immediately, grant the permission to the process running this server and try again." }))

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

  const secs = mk('Seconds', Object.assign(el('input'), { type: 'number', value: 30, min: 5, max: 600 }), 'How long the capture runs before it stops on its own.')

  const steps = el('div', 'full')
  const go = el('button', 'btn', 'Set up the capture')
  const w = el('div', 'full')
  w.append(go)
  f.append(w, steps)
  go.onclick = async () => {
    // A typed value is always a title; a picked one carries its own kind, because
    // record takes a screen by index and a window by title and neither by id.
    const source = pick.value === TYPE_IT ? { kind: 'window', value: typed.value.trim() } : pick.value === '' ? { kind: '', value: '' } : (sources[Number(pick.value)] ?? { kind: '', value: '' })
    const r = await (await fetch('/api/record', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: proj.value, title: title.value, source, seconds: secs.value }) })).json()
    steps.innerHTML = ''
    if (r.error) {
      steps.append(Object.assign(el('div', 'hint bad'), { textContent: r.error }))
      return
    }
    steps.append(
      plan([
        [source.kind === 'window' ? 'Capture the first window whose title contains "' + source.value + '".' : source.kind === 'display' ? 'Capture screen ' + source.value + ' whole.' : 'Capture the whole screen.', 'Stops on its own after ' + (secs.value || 30) + ' seconds.'],
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
  demoBody.placeholder = [
    'We start on the estimating screen.',
    '',
    '```do',
    'goto https://your-app.example.com/quotes/new',
    'expect "REQUEST QUOTE"',
    'click "3D VIEW"',
    'wait 800',
    '```',
    '',
    'Adding a railing is two clicks.',
  ].join('\n')
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
    const r = await (await fetch('/api/demo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: proj.value, name: title.value || 'demo', body: demoBody.value }),
    })).json()
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
  prov.onchange = syncVoice
  syncVoice()
  const idle = mk('Idle speed', Object.assign(el('input'), { type: 'number', value: 3, min: 1, max: 10, step: 0.5 }), 'How much dead time between clicks is compressed. 3 means idle stretches run three times faster; action is left alone.')
  const rez = mk('Resolution', el('select'))
  for (const o of ['1080p', '720p']) rez.append(Object.assign(el('option', null, o), { value: o }))

  const opts = el('div', 'row')
  opts.className = 'row'
  const chk = (label, on) => {
    const b = el('button', 'chip', label)
    b.setAttribute('aria-pressed', String(on))
    b.onclick = () => b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'))
    opts.append(b)
    return b
  }
  const cCursor = chk('Cursor overlay', true),
    cClick = chk('Click effects', true),
    cInterp = chk('Interpolate to 60fps', false)
  f.append(opts)

  const out = el('div', 'full')
  const build = el('button', 'btn', 'Work out the steps')
  const w = el('div', 'full')
  w.append(build)
  f.append(w, out)

  build.onclick = async () => {
    const on = (b) => b.getAttribute('aria-pressed') === 'true'
    if (!trace.value.trim()) {
      out.innerHTML = ''
      out.append(Object.assign(el('div', 'hint bad'), { textContent: 'Pick a trace first — Browse… opens your home directory.' }))
      return
    }
    build.disabled = true
    build.textContent = 'Working it out…'
    const r = await (
      await fetch('/api/recast', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: proj.value, title: title.value, trace: trace.value.trim(), srt: srt.value.trim() || null, provider: prov.value, voice: voice.value || null, speedIdle: idle.value, resolution: rez.value, cursor: on(cCursor), click: on(cClick), interpolate: on(cInterp) }) })
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
    if (r.wav) items.push(['Add the narration you already made.', 'Uses ' + r.wav + ', reconciles the clocks, burns the subtitles, and writes ' + r.narrated])
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
    'flow-board',
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
  m.append(el('h2', null, 'Console'), el('p', 'lede', "Everything the Studio runs, as it runs. Output is live — you don't have to go find a terminal to see whether the export worked."))

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
  m.append(el('h2', null, 'Components'), el('p', 'lede', 'Custom elements for HyperFrames scenes: title cards, browser chrome, lower thirds, callouts, stats, build-on lists. Drag the scrubber in the frame — the page is seeked to that instant, which is exactly what the renderer does frame by frame.'))
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
  m.append(el('h2', null, 'Storage'), el('p', 'lede', 'Cloudflare R2 is S3-compatible, so rclone already speaks it — and it has no egress fees, which is the line item that hurts with video.'))
  m.append(Object.assign(el('div', 'note'), { innerHTML: 'Local projects work fine without it.' }))
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
