#!/usr/bin/env node
/**
 * Verifies the brand layer against OpenScreen's own source of truth.
 *
 * The presets are a patch onto someone else's typed document. If a field name
 * or an enum value drifts, OpenScreen will quietly normalise it back to a
 * default and the video will look stock — a silent failure, which is the worst
 * kind. So rather than trusting the values I wrote, this reads the enums and
 * the ProjectEditorState interface straight out of a checkout and asserts
 * against them.
 *
 *   node lib/verify.mjs --openscreen /path/to/openscreen
 */
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { callout, lowerThird, title, watermark, zoomRhythm } from './annotations.mjs'
import { capture } from './narration.mjs'
import { annotationList, applyTheme, buildEditorPatch, loadPreset, zoomList } from './theme.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const i = process.argv.indexOf('--openscreen')
const OS_ROOT = i !== -1 ? process.argv[i + 1] : resolve(ROOT, '../openscreen')

let pass = 0
const failures = []
function check(label, ok, detail = '') {
  if (ok) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/** The slot names inside an .icns, or null when it cannot be read. */
async function unpackIcns(path) {
  const { execFileSync } = await import('node:child_process')
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'rm-verify-icns-'))
  try {
    execFileSync('iconutil', ['-c', 'iconset', path, '-o', join(dir, 'i.iconset')], { stdio: 'pipe' })
    return await readdir(join(dir, 'i.iconset'))
  } catch {
    return null
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const src = async (p) => readFile(resolve(OS_ROOT, p), 'utf8')

// Every assertion that reads OpenScreen's TypeScript needs a checkout to read.
// A fresh clone has none, and crashing here means nobody ever sees the ~100
// assertions below that stand on their own — so skip that section loudly
// instead. CI clones OpenScreen and passes --openscreen, so the drift checks
// still gate every tag.
const HAVE_OS = existsSync(resolve(OS_ROOT, 'src/components/video-editor/projectPersistence.ts'))
let skipped = 0
/*
 * Why things were skipped, not just how many.
 *
 * These two counters used to be one, and the summary line spelled the reason out
 * as "no OpenScreen checkout" — so a run with the fork right there, skipping one
 * assertion because `npx --no-install hyperframes` found nothing cached, reported
 * a missing checkout. A summary that names the wrong cause is worse than one that
 * names none.
 */
const skips = { fork: 0, hyperframes: 0, recast: 0, iconutil: 0 }

// Skipping is for the default path only. If someone named a checkout with
// --openscreen and it isn't there, that is a broken invocation — and CI names
// one, so silently skipping would drop the drift checks from the tag gate
// while still printing a green run.
if (!HAVE_OS && i !== -1) {
  console.error(`--openscreen ${OS_ROOT} is not an OpenScreen checkout.`)
  process.exit(2)
}

// `ok` and `detail` are thunks: without a checkout the enums they read are
// null, so they must not be evaluated at all.
function osCheck(label, ok, detail = '') {
  if (!HAVE_OS) {
    skipped++
    skips.fork++
    return
  }
  check(label, ok(), typeof detail === 'function' ? detail() : detail)
}

if (HAVE_OS) {
  console.log(`\nVerifying against OpenScreen checkout: ${OS_ROOT}\n`)
} else {
  console.log(`\n! No OpenScreen checkout at ${OS_ROOT}`)
  console.log('  Skipping the schema-drift assertions; the rest still run.')
  console.log('  For the full suite: node lib/verify.mjs --openscreen /path/to/openscreen\n')
}

// ---------------------------------------------------------------- field names
const persistence = HAVE_OS ? await src('src/components/video-editor/projectPersistence.ts') : ''
const ifaceMatch = persistence.match(/export interface ProjectEditorState \{([\s\S]*?)\n\}/)
if (HAVE_OS && !ifaceMatch) {
  console.error('Could not find ProjectEditorState — has the file moved?')
  process.exit(2)
}
const knownFields = new Set([...(ifaceMatch?.[1] ?? '').matchAll(/^\s*(\w+)[?]?:/gm)].map((m) => m[1]))
if (HAVE_OS) console.log(`ProjectEditorState exposes ${knownFields.size} fields\n`)

// ---------------------------------------------------------------- enum values
const types = HAVE_OS ? await src('src/components/video-editor/types.ts') : ''
const exporterTypes = HAVE_OS ? await src('src/lib/exporter/types.ts') : ''
const union = (text, name) => {
  const m = text.match(new RegExp(`export type ${name} =([^;]*);`))
  return m ? new Set([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1])) : null
}
const maskShapes = union(types, 'WebcamMaskShape')
const quality = union(exporterTypes, 'ExportQuality')
const layoutPresets = new Set([...persistence.matchAll(/case "(picture-in-picture|no-webcam|vertical-stack|dual-frame)":/g)].map((m) => m[1]))

// ---------------------------------------------------------------- the presets
const presetIds = (await readdir(resolve(ROOT, 'presets'))).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))

for (const id of presetIds) {
  console.log(`preset: ${id}`)
  const preset = await loadPreset(id)
  const variants = Object.keys(preset.variants ?? {}).filter((k) => !k.startsWith('$'))

  for (const variant of variants) {
    const patch = buildEditorPatch(preset, { variant })
    const unknown = Object.keys(patch).filter((k) => !knownFields.has(k))
    osCheck(
      `${variant}: every field exists on ProjectEditorState`,
      () => unknown.length === 0,
      () => unknown.join(', '),
    )
    osCheck(`${variant}: webcamMaskShape is legal`, () => !patch.webcamMaskShape || maskShapes.has(patch.webcamMaskShape), patch.webcamMaskShape)
    osCheck(`${variant}: exportQuality is legal`, () => !patch.exportQuality || quality.has(patch.exportQuality), patch.exportQuality)
    osCheck(`${variant}: webcamLayoutPreset is legal`, () => !patch.webcamLayoutPreset || layoutPresets.has(patch.webcamLayoutPreset), patch.webcamLayoutPreset)
    check(
      `${variant}: layout survives its aspect ratio`,
      !(patch.webcamLayoutPreset === 'vertical-stack' && !/^(\d+):(\d+)$/.test(patch.aspectRatio ?? '')) ||
        (() => {
          const [w, h] = patch.aspectRatio.split(':').map(Number)
          return h > w
        })(),
      `${patch.webcamLayoutPreset} @ ${patch.aspectRatio}`,
    )
    // A path, not a URL. The compositor opens this value with the filesystem,
    // so a file:// prefix makes it look for a file literally named
    // "file:///Users/..." — which it reports once per frame while still
    // exiting 0 and writing an MP4 with no wallpaper on it. This assertion
    // used to require the URL form and so locked the bug in place.
    check(`${variant}: wallpaper resolves to a path`, /^\//.test(patch.wallpaper ?? ''), patch.wallpaper)
    check(`${variant}: and the file is really there`, existsSync(patch.wallpaper ?? ''), patch.wallpaper)
  }

  for (const unit of Object.keys(preset.units ?? {}).filter((k) => !k.startsWith('$'))) {
    const p = buildEditorPatch(preset, { unit })
    const declared = preset.units[unit].wallpaperFile
    check(`unit ${unit}: ${declared ? 'uses its own wallpaper' : 'falls back cleanly (no wallpaper set)'}`, declared ? p.wallpaper.includes(declared) : Boolean(p.wallpaper))
  }
  console.log('')
}

// ------------------------------------------------------- annotation + zoom shape
console.log('annotation & zoom shape')
// Empty without a checkout — every `required` list below is asserted through
// osCheck, so an empty list is skipped rather than passing vacuously.
const requiredFields = (name) => {
  const m = types.match(new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`))
  return m ? [...m[1].matchAll(/^\s*(\w+):/gm)].map((x) => x[1]) : []
}
const annRequired = requiredFields('AnnotationRegion')
const styleRequired = requiredFields('AnnotationTextStyle')
const zoomRequired = requiredFields('ZoomRegion')

const samples = [...title({ text: 'Dock Designer', eyebrow: 'Product tour' }), ...lowerThird({ name: 'Dallas Peters', sub: 'Senior Designer', startMs: 1000, endMs: 5000 }), ...callout({ text: 'One-click setup', at: { x: 60, y: 40 }, startMs: 6000, endMs: 9000 }), ...watermark({ endMs: 30000 })]
osCheck(
  'annotations carry every required AnnotationRegion field',
  () => samples.every((a) => annRequired.every((f) => f in a)),
  () => annRequired.filter((f) => !(f in samples[0])).join(', '),
)
osCheck(
  'annotation styles carry every required AnnotationTextStyle field',
  () => samples.every((a) => styleRequired.every((f) => f in a.style)),
  () => styleRequired.filter((f) => !(f in samples[0].style)).join(', '),
)
check(
  'annotation type is a legal AnnotationType',
  samples.every((a) => a.type === 'text'),
)
check(
  'annotation positions stay inside the frame',
  samples.every((a) => a.position.x >= 0 && a.position.x <= 100 && a.position.y >= 0 && a.position.y <= 100),
)

const zooms = zoomRhythm([
  { atMs: 2000, at: { x: 0.3, y: 0.4 } },
  { atMs: 9000, at: { x: 0.7, y: 0.6 }, holdMs: 400 },
])
osCheck('zooms carry every required ZoomRegion field', () => zooms.every((z) => zoomRequired.every((f) => f in z)))
check(
  'zoom focus is normalised 0–1',
  zooms.every((z) => z.focus.cx <= 1 && z.focus.cy <= 1),
)
check(
  'zoom depth is within 1–6',
  zooms.every((z) => z.depth >= 1 && z.depth <= 6),
)
check('short zoom beats are floored to 1200ms', zooms[1].endMs - zooms[1].startMs >= 1200)

// ------------------------------------------------------- round-trip both shapes
console.log('\ndocument round-trip')
const preset = await loadPreset('rolemodel')
const patch = buildEditorPatch(preset, { variant: 'master' })

const v7 = {
  schemaVersion: 7,
  project: { id: 'p1', title: 't', createdAt: '2026-08-22T00:00:00.000Z', updatedAt: '2026-08-22T00:00:00.000Z' },
  assets: [],
  timeline: { clips: [], gaps: [], trimRanges: [], muteRanges: [], speedRanges: [], captionRanges: [] },
  annotations: [],
  zoomRanges: [],
  legacyEditor: { padding: 50 },
}
applyTheme(v7, patch)
annotationList(v7).push(...title({ text: 'x' }))
zoomList(v7).push(...zooms)
check('v7: patch lands on legacyEditor', v7.legacyEditor.padding === patch.padding)
check('v7: annotations land on document.annotations', v7.annotations.length > 0)
check('v7: zooms land on document.zoomRanges', v7.zoomRanges.length === zooms.length)
check('v7: schemaVersion untouched', v7.schemaVersion === 7)

const v2 = { version: 2, editor: { padding: 50, zoomRegions: [], annotationRegions: [] } }
applyTheme(v2, patch)
annotationList(v2).push(...title({ text: 'x' }))
zoomList(v2).push(...zooms)
check('v2: patch lands on editor', v2.editor.padding === patch.padding)
check('v2: annotations land on editor.annotationRegions', v2.editor.annotationRegions.length > 0)
check('v2: zooms land on editor.zoomRegions', v2.editor.zoomRegions.length === zooms.length)

// ------------------------------------------------------------- render assets
// `rm-video assets` stages the brand next to a composition. Every reference it
// writes has to resolve from the render root, because the failure mode is silent:
// a missing woff2 falls back to system-ui and a missing mark draws nothing, so the
// render succeeds and looks merely unbranded rather than broken.
console.log('\nrender assets')
{
  const { mkdtemp, readFile, rm, access } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { stageRenderAssets } = await import('./render-assets.mjs')

  const dir = await mkdtemp(resolve(tmpdir(), 'rm-assets-'))
  let staged = null
  try {
    staged = await stageRenderAssets(dir, { brand: 'academy', quiet: true })
  } catch (e) {
    check('staging succeeds', false, e.message)
  }

  if (staged) {
    const theme = await readFile(resolve(dir, 'theme.css'), 'utf8')
    const title = await readFile(resolve(dir, 'title.html'), 'utf8')
    const resolves = async (rel) =>
      await access(resolve(dir, rel)).then(
        () => true,
        () => false,
      )

    check('no unfilled token placeholders', !/__[A-Z]+__/.test(theme), (theme.match(/__[A-Z]+__/g) ?? []).join(', '))
    const urls = [...theme.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1])
    check('theme.css references at least one font', urls.length > 0)
    for (const u of urls) check(`theme.css url resolves: ${u}`, await resolves(u))

    const srcs = [...title.matchAll(/src="([^"]+)"/g)].map((m) => m[1])
    check('the title card references a mark', srcs.length > 0)
    for (const u of srcs) check(`title.html src resolves: ${u}`, await resolves(u))

    // The card draws a dark ground, so it must not be handed the light-ground mark.
    check(
      'the staged card uses a dark-ground mark',
      srcs.every((u) => /color-on-dark|white/.test(u)),
      srcs.join(', '),
    )
    // OFL asks for the licence to travel with the face.
    check('the font licences travel with the fonts', await resolves('assets/brand/fonts/OFL-DMSans.txt'))
    // A sub-brand video still tends to want the parent mark available.
    check(
      'rolemodel is staged alongside a sub-brand',
      staged.marks.some((f) => f.startsWith('rolemodel-')),
    )
  }
  await rm(dir, { recursive: true, force: true })
}

// ------------------------------------------------------------- logos
// brand/logos is vendored from rolemodel-brand, which is a separate checkout. The
// check that matters is that the manifest and the files agree: a title that asks
// for a variant the manifest advertises and the directory does not have renders a
// broken image, and it renders it in the client's video.
console.log('\nlogos')
{
  const dir = resolve(ROOT, 'brand/logos')
  const index = JSON.parse(await readFile(resolve(dir, 'index.json'), 'utf8').catch(() => '[]'))
  const files = await readdir(dir).catch(() => [])
  const studioSrc = await readFile(resolve(ROOT, 'bin/rm-studio.mjs'), 'utf8')

  check('the manifest lists brands', index.length > 0, `${index.length} brands`)
  /*
   * What a brand id actually has to satisfy.
   *
   * This asserted that every id was one of five names, written out by hand — and
   * went stale the moment almanac, compass and standard were vendored, which is
   * precisely the failure its own comment warned about. Worse, it asserted a
   * coupling the tool does not have: `marksFor` resolves an id by looking it up
   * in this manifest, and colours come from tokens.json whichever brand is
   * chosen, so `rm-video assets --brand almanac` stages and renders a title card
   * with no colour scale of its own anywhere. A brand with marks and no ramp is a
   * legitimate thing to vendor.
   *
   * These two are what would actually break a render.
   */
  // `marksFor` picks with `.find()`, so a repeated id silently stages one entry's
  // variants and never the other's.
  check('brand ids are unique', new Set(index.map((b) => b.id)).size === index.length, index.map((b) => b.id).join(', '))
  // Every sub-brand render stages rolemodel alongside the choice, so its absence
  // from the manifest would quietly drop the parent mark from every one of them.
  check(
    'rolemodel is in the manifest, since every sub-brand render stages it too',
    index.some((b) => b.id === 'rolemodel'),
  )
  check(
    'every advertised variant has its file on disk',
    index.every((b) =>
      Object.values(b.variants)
        .filter(Boolean)
        .every((v) => files.includes(v.file)),
    ),
    index
      .flatMap((b) =>
        Object.values(b.variants)
          .filter(Boolean)
          .filter((v) => !files.includes(v.file))
          .map((v) => v.file),
      )
      .join(', '),
  )
  check(
    'every svg on disk is advertised',
    files.filter((f) => f.endsWith('.svg')).every((f) => index.some((b) => Object.values(b.variants).some((v) => v?.file === f))),
  )
  check(
    'every brand has something usable on a dark ground',
    index.every((b) => b.variants['logo-color-on-dark'] || b.variants['logo-white']),
    index
      .filter((b) => !b.variants['logo-color-on-dark'] && !b.variants['logo-white'])
      .map((b) => b.id)
      .join(', '),
  )
  check(
    'every brand has a bare mark for watermarks',
    index.every((b) => b.variants.icon),
  )
  // Served as octet-stream, an svg is a logo the browser will not draw.
  check('the Studio serves svg as image/svg+xml', /"\.svg":\s*"image\/svg\+xml"/.test(studioSrc))
}

// ------------------------------------------------------------- directives
// Settings written in the script itself, so a script carries its own render
// configuration instead of it living in a form somewhere else.
//
// The safety property is the whole point: anything these parsers do not recognise
// is SPOKEN. rm-voice synthesises whatever parseScript returns, so a directive that
// is not skipped becomes "slash voice af heart" in a client's video, and a mistyped
// one becomes it too. Both parsers are checked, because they are separate.
console.log('\ndirectives')
{
  const demo = await import('./demo-script.mjs')
  const { parseScript } = await import('./script-parse.mjs')
  const src = await readFile(resolve(ROOT, 'lib/studio.js'), 'utf8')

  const md = ['/brand academy', '/voice af_heart', '/title "Estimating a curved railing"', '/seconds 20', '', 'Start with your site measurements.', '', '```do', 'goto /quotes/new', 'click "3D VIEW"', '```', '', 'Adding a railing is two clicks.'].join('\n')
  const parsed = demo.parseDemo(md)
  const set = demo.settings(parsed)

  check('a directive vocabulary exists', Object.keys(demo.DIRECTIVES ?? {}).length > 0, Object.keys(demo.DIRECTIVES ?? {}).join(', '))
  check('settings are read out of the document', set.brand === 'academy' && set.voice === 'af_heart' && set.seconds === '20')
  check('a quoted value keeps its spaces', set.title === 'Estimating a curved railing')
  check(
    'directives are not spoken',
    demo.narration(parsed).every((t) => !t.startsWith('/')),
    demo.narration(parsed).join(' | '),
  )
  check(
    'and the narration parser skips them too',
    parseScript(md).every((l) => !String(l).startsWith('/')),
  )
  // parseScript returns the lines themselves, not objects — same comparison the
  // older assertion above makes.
  check('the two parsers still agree on narration', JSON.stringify(demo.narration(parsed)) === JSON.stringify(parseScript(md)))
  check(
    'actions still parse alongside them',
    demo
      .actions(parsed)
      .map((a) => a.verb)
      .join(',') === 'goto,click',
  )
  check('a clean document reports no problems', parsed.problems.length === 0, parsed.problems.join(' | '))

  // A typo has to be a problem, never speech — that is the difference between a
  // caught mistake and a video that reads a setting out loud.
  const bad = demo.parseDemo('/voyce af_heart\n/seconds twenty\n/motion\nReal narration.')
  check('an unknown setting is refused, not spoken', bad.problems.some((x) => /no such setting/.test(x)) && demo.narration(bad).length === 1)
  check(
    'a non-numeric number is refused',
    bad.problems.some((x) => /wants a number/.test(x)),
  )
  check(
    'a missing value is refused',
    bad.problems.some((x) => /needs a value/.test(x)),
  )
  check('last one wins', demo.settings(demo.parseDemo('/brand rolemodel\n/brand academy')).brand === 'academy')

  // The editor offers the same vocabulary it enforces.
  check('the editor menu reads DIRECTIVES rather than its own list', /DS\?\.DIRECTIVES/.test(src))
  // The document is the input, not decoration. /api/make consults it before the
  // panel for every setting, because the document is the more specific statement:
  // it travels with the words it applies to and it is what someone else receives.
  const srv = await readFile(resolve(ROOT, 'bin/rm-studio.mjs'), 'utf8')
  check("/api/make reads the document's settings", /const fromDoc = isUrl \? \{\} : demoSettings\(parseDemo\(src\)\)/.test(srv))
  check('and the document wins over the panel', /const pick = \(key, fallback\)/.test(srv))
  for (const key of ['motion', 'wallpaper', 'title', 'eyebrow', 'webcam', 'audio']) {
    check(`${key} consults the document`, new RegExp(`pick\\("${key}"`).test(srv), key)
  }
  // A URL has no directives; parsing one would report every line of an address.
  check('a URL is not parsed for directives', /isUrl \? \{\} :/.test(srv))
  // The words go to Claude; the directives already became sentences.
  check('directive lines are stripped from the script in the prompt', /const spokenSrc = isUrl/.test(srv) && /\$\{spokenSrc\}/.test(srv))
  // /music is /audio in a different role rather than a second track.
  check('music is audio in a bed role', /fromDoc\.music \? true :/.test(srv))
  // Six fields take script: Make, the recorder's generated script, the demo body,
  // the editor, the draft brief, and the save-script form. A field that chips a
  // directive but will not complete it is worse than one that does neither, so the
  // two layers are wired by one helper and counted here rather than spot-checked.
  // Named, not only inline-styled: an unclassed div cannot be asserted on, themed,
  // or found in a bug report.
  // Ordering, not just presence: wired before the append, the wrapper is discarded
  // and the field silently highlights nothing.
  check(
    'each field is wired after it is placed',
    (() => {
      const at = (re) => src.split('\n').findIndex((l) => re.test(l))
      return at(/field\(scriptForm, 'Script', script, scriptHint\)/) < at(/slashField\(script,/) && at(/mk\('Demo script', demoBody, demoHint\)/) < at(/slashField\(demoBody,/)
    })(),
  )
  check('the menu is a named element', /el\('div', 'slash-menu'\)/.test(src))
  check('both layers go on together', /function slashField\(ta, getProject\) \{\n\s*attachHighlight\(ta\)\n\s*attachSlashMenu\(ta, getProject\)/.test(src))
  check('every script field gets them', (src.match(/^\s*slashField\(/gm) || []).length === 5)
  check('nothing wires half of it by hand', !/^\s*attach(Highlight|SlashMenu)\((?!ta\b)/m.test(src))
  // The chips are a rendering of the text, not a format — so the file stays plain.
  check('the script field gets a highlight layer', /slashField\(body, \(\) => project\.value\)/.test(src))
  check('only the value is chipped', /class="\$\{ok \? 'hl-val' : 'hl-bad'\}"/.test(src))
  check('an unknown directive is marked wrong', /'hl-bad'/.test(src))
  check('the layer escapes what it renders', /hlEscape/.test(src) && /&lt;/.test(src))
  // A <pre> collapses a trailing newline and a textarea does not; without the extra
  // character the last line drifts by a line-height the moment you press Enter.
  check('the layer keeps a trailing newline', /highlightScript\(ta\.value\) \+ '\\n'/.test(src))
  {
    const css = await readFile(resolve(ROOT, 'lib/studio.css'), 'utf8')
    // Optics styles the field at (0,2,0) via .form-control:not(...), so anything
    // below that loses and the two layers stop agreeing on where a glyph lands.
    // A textarea with no width is its `cols` default, not its container's width.
    // .form-group is a two-column grid that spans .form-control; the wrapper is not one.
    check('the wrapper spans the group', /\.hl-wrap \{[\s\S]{0,600}?grid-column: 1 \/ -1/.test(css))
    check('a wrapped field fills its group', /\.hl-wrap\s*>\s*textarea\.form-control,\s*\n[\s\S]{0,600}?inline-size: 100%/.test(css))
    check("the highlight rules outrank Optics' form-control", /\.hl-wrap\s*>\s*textarea\.form-control/.test(css))
    check("the field's own text is transparent", /caret-color: var\(--fg\)/.test(css) && /color: transparent/.test(css))
    // Optics' "primary" is blue; the brand green is the academy-primary scale.
    check('the chip uses the brand green', /hl-val \{[\s\S]*?academy-primary/.test(css))
  }
  check('values come from live state, not literals', /case 'wallpaper':/.test(src) && /S\.wallpapers/.test(src))
}

// ------------------------------------------------------------- motion
// brand/motion.json is generated from rolemodel-brand/tokens/brand.json, and the
// prose in it reaches Claude verbatim. So these checks are about agreement: the
// file must match the tokens it claims to come from, and must not describe motion
// the brand does not define.
//
// This group replaces one that asserted the opposite. The file was hand-written
// from Optics' eight --op-transition-* values and told Claude "never use bounce,
// elastic or back easing — the design system contains no such motion". The brand
// defines `emphasis` as "the only curve allowed to overshoot", so that instruction
// forbade the one thing the brand reserves for a deliberate look-at-me, and the
// assertion here enforced the mistake.
console.log('\nmotion')
{
  const motion = JSON.parse(await readFile(resolve(ROOT, 'brand/motion.json'), 'utf8'))
  const ids = Object.keys(motion.presets ?? {})
  const studioSrc = await readFile(resolve(ROOT, 'bin/rm-studio.mjs'), 'utf8')
  const tok = motion.tokens ?? {}
  const every = (fn) => ids.every((id) => (motion.presets[id].direction ?? []).some(fn))

  check('it says it is generated', /GENERATED by lib\/make-motion\.mjs/.test((motion.$comment ?? []).join(' ')))
  check('and names its source', motion.$source === 'rolemodel-brand/tokens/brand.json')
  check('presets exist', ids.length > 0, `${ids.length} presets`)
  check('the default names a real preset', ids.includes(motion.default), motion.default)
  check(
    'every preset has a label, a hint and direction',
    ids.every((id) => motion.presets[id].label && motion.presets[id].hint && motion.presets[id].direction?.length),
  )

  // The tokens are the brand's, so the shape it publishes has to survive the copy.
  check(
    "the brand's duration scale came through",
    ['instant', 'fast', 'base', 'slow', 'deliberate'].every((k) => tok.duration?.[k]),
    JSON.stringify(tok.duration),
  )
  check(
    'its four named curves came through',
    ['enter', 'exit', 'move', 'emphasis'].every((k) => tok.easing?.[k]),
    Object.keys(tok.easing ?? {}).join(', '),
  )
  check(
    'its travel distances came through',
    ['sm', 'md', 'lg'].every((k) => tok.distance?.[k]),
  )
  check('stagger and scale-from came through', Boolean(tok.stagger && tok.scaleFrom), `${tok.stagger} / ${tok.scaleFrom}`)

  // The point of generating it: the prose cannot ask for a timing the brand has not
  // defined, because the prose is built out of those values.
  const known = new Set(Object.values(tok.duration ?? {}))
  const quoted = ids.flatMap((id) => (motion.presets[id].direction ?? []).flatMap((line) => [...line.matchAll(/\b(\d{2,4})ms\b/g)].map((mm) => `${mm[1]}ms`)))
  const strays = [...new Set(quoted)].filter((ms) => !known.has(ms) && ms !== tok.stagger)
  check('every duration in the prose is one the brand defines', strays.length === 0, strays.join(', '))

  /*
   * The overshoot rule, stated the way the brand states it rather than banned.
   *
   * Checked on the presets that actually move something. `minimal` is cuts and
   * fades, so it has nothing to say about a curve it never uses, and demanding the
   * sentence there would only teach the generator to pad.
   */
  const moving = ids.filter((id) => id !== 'minimal')
  check(
    'every preset that moves names emphasis as the only overshoot',
    moving.every((id) => (motion.presets[id].direction ?? []).some((d) => /only.*overshoot/i.test(d))),
    moving.join(', '),
  )
  check('and the one that moves nothing does not mention it', !(motion.presets.minimal?.direction ?? []).some((d) => /overshoot/i.test(d)))
  check('no preset forbids overshoot outright', !ids.some((id) => (motion.presets[id].direction ?? []).some((d) => /never use bounce|no such motion/i.test(d))))
  // Motion is meant to be defensible against the brand's own words.
  check('the character words travelled with it', (motion.character ?? []).includes('restraint'), (motion.character ?? []).join(', '))
  check(
    'every preset states what it answers to',
    every((d) => /answers to/i.test(d)),
  )

  check('/api/make reads the spec', studioSrc.includes('brand/motion.json'))
  check('an unknown motion id falls back rather than sending nothing', studioSrc.includes('motionSpec.presets?.[motionSpec.default]'))
  check('a chosen voice reaches the prompt', /hyperframes tts --voice \$\{voiceId\}/.test(studioSrc))
  check('no voice means an explicit silent instruction', /Render silent/.test(studioSrc))
}

// ------------------------------------------------------------- wallpapers
// The brand rule this enforces: RoleModel is linear. A radial gradient sneaking
// back into a recipe is how the bottom-border artefact happened the first time,
// and it is invisible in review because it only shows at 16:9.
console.log('\nwallpapers')
{
  const recipes = JSON.parse(await readFile(resolve(ROOT, 'brand/wallpapers.json'), 'utf8'))
  const wpSrc = await readFile(resolve(ROOT, 'lib/wallpaper.mjs'), 'utf8')
  const files = await readdir(resolve(ROOT, 'brand/wallpapers'))

  check('recipes exist', Array.isArray(recipes) && recipes.length > 0, `${recipes.length} recipes`)
  check('no radial gradients in the drawing code', !/createRadialGradient|radial-gradient/.test(wpSrc))
  check(
    'every recipe has a rendered JPEG',
    recipes.every((r) => files.includes(`${r.name}.jpg`)),
    recipes
      .filter((r) => !files.includes(`${r.name}.jpg`))
      .map((r) => r.name)
      .join(', '),
  )
  check('recipe names are unique', new Set(recipes.map((r) => r.name)).size === recipes.length)
  check(
    'every gradient has at least two stops',
    recipes.every((r) => (r.gradient?.stops?.length ?? 0) >= 2),
  )
  check(
    'no recipe still carries the old gradient edge',
    recipes.every((r) => r.edge === undefined),
    recipes
      .filter((r) => r.edge)
      .map((r) => r.name)
      .join(', '),
  )
  check(
    'every recipe has a border block',
    recipes.every((r) => r.border && typeof r.border.width === 'number'),
  )
  // The border is a bottom rule by default and a full frame only on request.
  // radius exists for the frame; a rule has no corners, so a recipe asking for
  // both is a recipe that will not render what its author expected.
  // Checked on the normalized form, which is what the renderer actually sees: a
  // recipe is allowed to omit `sides` and take the default, so asserting on the
  // raw JSON would fail every file that is simply written the short way.
  const wp = await import('./wallpaper.mjs')
  const drawn = recipes.map((r) => wp.normalize(r))
  check(
    'sides is always one the renderer knows',
    drawn.every((r) => wp.BORDER_SIDES.includes(r.border.sides)),
    drawn
      .filter((r) => !wp.BORDER_SIDES.includes(r.border.sides))
      .map((r) => r.name)
      .join(', '),
  )
  check('the default is a rule, not a box', wp.DEFAULT_RECIPE.border.sides === 'bottom')
  const radiusNoFrame = drawn.filter((r) => r.border.width && r.border.radius && r.border.sides !== 'all')
  check('no recipe sets a radius it cannot use', radiusNoFrame.length === 0, radiusNoFrame.map((r) => `${r.name}: radius ${r.border.radius} on a ${r.border.sides} border`).join(', '))

  const { normalize } = await import('./wallpaper.mjs')
  check(
    'normalize is idempotent',
    recipes.every((r) => JSON.stringify(normalize(r)) === JSON.stringify(normalize(normalize(r)))),
  )
  // The Studio's styles are in studio.css, its markup in studio.html and its
  // client code in studio.js; the generator is 30 lines of readFile and has no
  // colour in it at all. Checking studio-ui.mjs alone would pass vacuously
  // forever, which is worse than not checking. %23 is an escaped # inside the
  // favicon data URI, not a colour.
  for (const f of ['lib/studio.css', 'lib/studio.html', 'lib/studio.js']) {
    /*
     * Comments are stripped first.
     *
     * The rule is "no invented colours in the code". A comment naming the two
     * hexes that used to appear twice in the swatch row is the explanation for
     * why the picker was rebuilt — exactly the thing worth keeping — and failing
     * on it teaches people to delete the reasoning rather than the colour.
     */
    const body = (await readFile(resolve(ROOT, f), 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
      .replace(/%23[0-9a-fA-F]{6}/g, '')
    const hexes = [...body.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0])
    check(`${f} invents no colours`, hexes.length === 0, hexes.join(', '))
  }
}

// ------------------------------------------------------------------- optics
// Optics is imported, not copied: brand/optics/optics.css is @rolemodel/optics
// verbatim, and brand/optics/rolemodel-scales.css carries only what the public
// package does not publish. The assertions that matter are that the vendored
// file is still the *live* system rather than a flattened snapshot of it, and
// that every token the UI spends is actually defined somewhere.
console.log('\noptics')
{
  const vendored = await readFile(resolve(ROOT, 'brand/optics/optics.css'), 'utf8').catch(() => '')
  const scales = await readFile(resolve(ROOT, 'brand/optics/rolemodel-scales.css'), 'utf8').catch(() => '')
  const manifest = JSON.parse(await readFile(resolve(ROOT, 'brand/optics/manifest.json'), 'utf8').catch(() => 'null'))

  check('vendored Optics exists', vendored.length > 100000, `${vendored.length} bytes`)
  check('it is the real package, not a flattened copy', /hsl\(\s*var\(--op-color-primary-h\)/.test(vendored))
  check('it drives both modes off color-scheme', /color-scheme:\s*light dark/.test(vendored) && vendored.includes('light-dark('))
  check('the ramps are still re-tintable', /--op-color-primary-h:/.test(vendored))
  check('a manifest pins the version', Boolean(manifest?.version), manifest?.version)

  const defined = (css) => new Set([...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)].map((m) => m[1]))
  const published = defined(vendored)
  const ours = defined(scales)

  check('the supplement exists', ours.size > 0, `${ours.size} tokens`)
  // A step is Optics' output and a seed is its input, so only one of them can
  // be shadowed. A second copy of `--op-color-primary-base` sits on top of the
  // computed one and freezes it; redefining `--op-color-primary-h` is how the
  // whole ramp is meant to move. The supplement carries seeds for every family
  // deliberately — that is what makes the published ramps RoleModel's colours
  // rather than Optics' defaults.
  const isSeed = (n) => /-(h|s|l)$/.test(n)
  const shadowedSteps = [...ours].filter((n) => published.has(n) && !isSeed(n))
  check('the supplement shadows no computed Optics token', shadowedSteps.length === 0, shadowedSteps.slice(0, 4).join(', '))
  check(
    'it does carry the seeds that tint the published ramps',
    [...ours].some((n) => isSeed(n) && published.has(n)),
  )
  check(
    'a seeded family gets all three',
    ['h', 's', 'l'].every((k) => ours.has(`--op-color-primary-${k}`)),
  )
  // Neutral is the deliberate exception, and for two different reasons. Optics
  // defines `neutral-h` as `var(--op-color-primary-h)` so the greys follow the
  // brand hue; a number there would sever that, not shadow it. And `neutral-s`
  // is 4% on purpose — "the neutrals are not grey" is a stated design decision —
  // while the Figma export resolves them to flat grey, so seeding from it would
  // write 0% over the tint and flatten every surface in the interface.
  check("neutral's hue is still Optics' relationship", /--op-color-neutral-h:\s*var\(--op-color-primary-h\)/.test(vendored))
  check("the supplement does not pin neutral's hue", !ours.has('--op-color-neutral-h'))
  check('nor flatten its tint', !ours.has('--op-color-neutral-s'))

  // The ramps it does define must be computed from their own seed, not frozen
  // hexes — that was the 1160-hex failure this whole split exists to undo.
  const computed = (scales.match(/hsl\(var\(--op-color-[a-z-]+-h\)/g) || []).length
  check('its own ramps are computed, not flattened', computed > 1000, `${computed} computed values`)

  // The one that earns its keep. Every --op- token the Studio and the video
  // components reference has to resolve, or it renders as an empty value and
  // the element quietly loses its colour — which reads as a component bug.
  // This is exactly how the four academy-primary tokens were found: they are
  // RoleModel's, and the public package has never carried them.
  const consumers = ['lib/studio.css', 'lib/studio.html', 'lib/studio.js', 'bin/rm-studio.mjs', 'components/rm-video.js']
  const used = new Set()
  for (const f of consumers) {
    const body = await readFile(resolve(ROOT, f), 'utf8')
    /*
     * A name being BUILT is not a token being spent.
     *
     * `var(--op-color-${scale}-base)` matches this pattern up to the interpolation
     * and yields the prefix `--op-color-`, which resolves nowhere and fails the
     * check for a token nobody wrote. The scales it interpolates come from
     * rolemodel-scales.css at runtime, so they are guaranteed to exist by
     * construction — the source of truth is the file, not a list here.
     */
    for (const m of body.matchAll(/var\(\s*(--op-[a-z0-9-]+)/g)) {
      if (body.slice(m.index + m[0].length).startsWith('${')) continue
      used.add(m[1])
    }
  }
  const missing = [...used].filter((n) => !published.has(n) && !ours.has(n))
  check(`every --op- token the UI spends is defined (${used.size} used)`, missing.length === 0, missing.join(', '))
}

// ------------------------------------------------------------- components
// The video components have one hard requirement: time is seeked, not played.
// A `transition`, or a rAF loop driving a value, makes the frame at 2400ms
// depend on when the renderer happened to look — the video then differs between
// runs, which is the kind of bug you only notice in review.
console.log('\ncomponents')
{
  const src = await readFile(resolve(ROOT, 'components/rm-video.js'), 'utf8')
  const gallery = await readFile(resolve(ROOT, 'components/gallery.html'), 'utf8')
  const tags = ['rm-scene', 'rm-browser', 'rm-title', 'rm-lower-third', 'rm-callout', 'rm-stat', 'rm-bullets']

  // Quote-agnostic on purpose. This asserted `define("rm-scene"` and broke the
  // moment a formatter normalised the file to single quotes — a green suite
  // should not depend on which quote character the repo settled on.
  const defines = (t) => new RegExp(`define\\(\\s*['"\`]${t}['"\`]`).test(src)
  check('every component is defined', tags.every(defines), tags.filter((t) => !defines(t)).join(', '))
  check(
    'the gallery shows every component',
    tags.filter((t) => t !== 'rm-scene').every((t) => gallery.includes(`<${t}`)),
  )
  check('animation is paused, never played', /animation-play-state:\s*paused/.test(src))
  check('no CSS transitions', !/\btransition\s*:/.test(src))
  check('every animation is positioned by --t', !/animation-delay:(?![^;]*var\(--t\))/.test(src))
  check(
    'colour literals only appear as var() fallbacks',
    [...src.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].every((mm) => {
      const before = src.slice(Math.max(0, mm.index - 90), mm.index)
      return /var\(\s*--op-[a-z0-9-]+\s*,\s*$/.test(before)
    }),
  )
  check('the scene template exists', (await readFile(resolve(ROOT, 'components/scene.html'), 'utf8')).includes('rm-scene'))

  // components/rm-video.js still builds CSS inside template literals, and a
  // backtick in a CSS comment silently ends the literal — the module then fails
  // to parse and the page renders as unstyled tags. It has bitten twice, which
  // is why the Studio's own CSS and client code were moved out to studio.html
  // and studio.js. lib/studio.js is checked here because it is the file that
  // used to be that string.
  for (const f of ['components/rm-video.js', 'lib/studio.js', 'lib/studio-ui.mjs', 'bin/rm-studio.mjs']) {
    const { ok } = await import('node:child_process').then((cp) => new Promise((r) => cp.execFile(process.execPath, ['--check', resolve(ROOT, f)], (e) => r({ ok: !e }))))
    check(`${f} parses`, ok)
  }
}

// ------------------------------------------------------------- narration
// The contract that matters: subtitle timings come from measured durations, so
// they cannot drift from the audio. Assert it against synthetic clips rather
// than running a real synth pass, which would need voice data in CI.
console.log('\nnarration')
{
  const { parseScript, estimateSeconds } = await import('./script-parse.mjs')
  const { srt, vtt } = await import('./narration.mjs')

  const md = ['# Heading is not spoken', '', 'First line. Second sentence on the same line.', '- A bullet keeps its words', '```', 'code is not spoken', '```', '---', '**Bold** and `code` lose their marks.'].join('\n')
  const lines = parseScript(md)

  check('headings are not spoken', !lines.some((l) => l.includes('Heading')))
  check('fenced code is not spoken', !lines.some((l) => l.includes('code is not spoken')))
  check('horizontal rules are dropped', !lines.some((l) => /^-{3,}$/.test(l)))
  check('bullets keep their words, lose the marker', lines.includes('A bullet keeps its words'))
  check('one sentence per line', lines.includes('First line.') && lines.includes('Second sentence on the same line.'))
  check('inline marks are stripped', lines.includes('Bold and code lose their marks.'))
  check('estimate scales with words', estimateSeconds(lines, 0) > 0)

  const clips = [
    { text: 'one', seconds: 2 },
    { text: 'two', seconds: 3 },
    { text: 'three', seconds: 1.5 },
  ]
  const out = srt(clips, { gapMs: 500 })
  check('srt is 1-indexed', out.startsWith('1\n'))
  check('srt starts at zero', out.includes('00:00:00,000 --> 00:00:02,000'))
  // 2 + 0.5 = 2.5 -> 5.5, then + 0.5 = 6.0 -> 7.5
  check('srt accumulates duration plus gap', out.includes('00:00:02,500 --> 00:00:05,500'))
  check('the last cue lands where the audio ends', out.includes('00:00:06,000 --> 00:00:07,500'))
  check('a cue exists for every line', out.trim().split(/\n\n/).length === clips.length)
  check('vtt is the same timeline with dots', vtt(clips, { gapMs: 500 }).includes('00:00:02.500 --> 00:00:05.500'))
}

// ------------------------------------------------------------- job allowlist
console.log('\njob allowlist')
{
  const jobs = await import('./jobs.mjs')
  jobs.setTrustedRoot(ROOT)
  const refuses = (bin) => {
    try {
      jobs.run({ bin, args: [] })
      return false
    } catch {
      return true
    }
  }
  check('refuses a shell', refuses('/bin/sh'))
  check('refuses a path outside the install', refuses('/tmp/evil'))
  check('refuses an unlisted bare name', refuses('curl'))
  check(
    'allowlist covers the pipeline',
    ['openscreen', 'rm-voice', 'rm-mux', 'playwright-recast', 'ffmpeg'].every((b) => jobs.BINARIES.has(b)),
  )

  // The wallpaper editor's slider bounds. These were positional min/max/step
  // arguments until they became a named RANGE table, and the refactor left a
  // stray `min` behind at all nine call sites: `range` then received a number,
  // spreading it produced no bounds at all, and `fmt` received the RANGE object
  // and was called as a function — so buildEditor threw and the editor rendered
  // nothing. Nothing here caught it, because none of these assertions had ever
  // looked at that panel. Two cheap static checks for the same shape of bug.
  {
    const ui = await readFile(resolve(ROOT, 'lib/studio.js'), 'utf8')
    const table = ui.match(/const RANGE = \{([\s\S]*?)\n\}/)
    const keys = table ? [...table[1].matchAll(/^\s*([a-z]+):\s*\{ min: (-?[\d.]+), max: (-?[\d.]+), step: (-?[\d.]+) \}/gm)] : []
    check('the RANGE table parses', keys.length > 0, `${keys.length} entries`)
    check(
      'every range has min < max and a positive step',
      keys.every((k) => Number(k[2]) < Number(k[3]) && Number(k[4]) > 0),
      keys
        .filter((k) => !(Number(k[2]) < Number(k[3]) && Number(k[4]) > 0))
        .map((k) => k[1])
        .join(', '),
    )
    const defined = new Set(keys.map((k) => k[1]))
    const referenced = [...new Set([...ui.matchAll(/RANGE\.([a-z]+)/g)].map((m) => m[1]))]
    const undef = referenced.filter((k) => !defined.has(k))
    check('every RANGE.* the editor references is defined', undef.length === 0, undef.join(', '))
    // The regression itself: a bare number sitting in the `range` argument slot.
    const orphans = [...ui.matchAll(/(-?[\d.]+),\s*\n\s*RANGE\./g)].map((m) => m[1])
    check('no leftover positional bound before a RANGE argument', orphans.length === 0, orphans.length ? `${orphans.length} call sites still pass ${orphans.join(', ')}` : '')
  }

  // Every job gets /dev/null on stdin. Node's default hands the child a pipe
  // nobody ever writes to or closes, so anything that reads stdin blocks on it:
  // `claude -p` waited three seconds, printed "no stdin data received in 3s"
  // into the Console, and finished — a job that worked but looked like it had
  // failed. Nothing here is interactive; the Console is a read-only stream.
  const jobsSrc = await readFile(resolve(ROOT, 'lib/jobs.mjs'), 'utf8')
  const spawns = [...jobsSrc.matchAll(/spawn\(([\s\S]*?)\);/g)].map((m) => m[1])
  check('jobs spawn with a stdio option at all', spawns.length > 0 && spawns.every((a) => a.includes('stdio')))
  check('no job inherits an open stdin', /const stdio = \["ignore",/.test(jobsSrc), 'stdin must be ignored, or a child that reads it hangs and reports success')
}

console.log('\nwallpaper handoff')
{
  // Every preset's wallpaper has to exist and has to be shaped the way the
  // compositor reads it. Both halves matter: the file was on disk the whole
  // time and the export still could not open it.
  const theme = await import('./theme.mjs')
  for (const id of ['rolemodel', 'academy', 'lightning']) {
    const preset = await theme.loadPreset(id)
    const patch = theme.buildEditorPatch(preset, {})
    check(`${id}: wallpaper is an absolute path`, /^\//.test(patch.wallpaper ?? ''), patch.wallpaper)
    check(`${id}: no scheme was prepended`, !/^[a-z]+:/i.test(patch.wallpaper ?? ''))
    check(`${id}: the image exists`, existsSync(patch.wallpaper ?? ''), patch.wallpaper)
  }

  // The shapes resolveWallpaper has to tell apart. A colour is not a filename,
  // and a URL left over in an existing document has to be repaired rather than
  // passed along, or re-branding cannot fix a document the old code wrote.
  check('a bare colour passes through', theme.resolveWallpaper('#0b0b0c') === '#0b0b0c')
  check('a remote url passes through', theme.resolveWallpaper('https://e.com/a.jpg') === 'https://e.com/a.jpg')
  check('a stale file url is converted back to a path', theme.resolveWallpaper('file:///tmp/a.jpg') === '/tmp/a.jpg')
  check('an absolute path is left alone', theme.resolveWallpaper('/tmp/b.jpg') === '/tmp/b.jpg')
  check('nothing stays nothing', theme.resolveWallpaper('') === null && theme.resolveWallpaper(null) === null)
}

console.log('\nedit before export')
{
  // The chain used to run record -> brand -> export and hand back an MP4. That
  // is the wrong shape: the point of writing a branded .openscreen document is
  // that it opens in the editor, where the zooms and annotations get placed.
  // Exporting straight past that produces a file nobody chose anything about,
  // so the chain stops after brand and export becomes the step after editing.
  const srv = await readFile(resolve(ROOT, 'bin/rm-studio.mjs'), 'utf8')
  const ui = await readFile(resolve(ROOT, 'lib/studio.js'), 'utf8')

  check('the chain stops before export', /filter\(\(x\) => x\.label !== 'export'\)/.test(ui))
  check('and offers the document for editing', /'Open in OpenScreen'/.test(ui) && /r\.editable/.test(ui))
  check('the record response names the document', /editable: proj/.test(srv))
  // Stopping the chain before export must not remove export: every step still
  // gets its own row, the chain just does not press the last one for you.
  check('export still gets its own run row', /for \(const s of r\.steps\) steps\.append\(runRow\(s\)\)/.test(ui))

  // The open endpoint is contained to the library and refuses a directory: it
  // spawns `open`, and `open` will launch whatever it is handed.
  const open = srv.slice(srv.indexOf('p === "/api/open"'), srv.indexOf('p === "/api/record"'))
  check('the open endpoint was found', open.length > 200, `${open.length} chars`)
  check('it refuses a path outside the library', /file\.startsWith\(LIB \+ sep\)/.test(open))
  check('it refuses anything that is not a file', /isFile\(\)/.test(open))
  // The wording lives in `openInOpenScreen` now, which both /api/open and
  // /api/open-media go through, so that is where to look for it.
  check('it says what the user still has to do', /Drag it onto/.test(srv), 'a build without the verb must not claim it opened')
  check('and /api/open goes through the shared path', /await openInOpenScreen\(file\)/.test(open))
}

console.log('\nrecord capture')
{
  // `openscreen record --help` is the contract, and it names two different
  // shapes for two different things:
  //
  //   --display <n>       Screen index to record (default 0)
  //   --window <title>    Record the first window whose title contains <title>
  //
  // `openscreen sources --json` reports neither: its displays carry an `index`
  // beside an `id` like "screen:1:0", and its windows carry a `name` beside an
  // `id` like "window:6952:0". Sending the id built
  // `--window window:6952:0`, and record replied "No window title contains
  // window:6952:0" and listed every open window — one of which was the one that
  // had just been picked from that very list.
  const srv = await readFile(resolve(ROOT, 'bin/rm-studio.mjs'), 'utf8')
  const ui = await readFile(resolve(ROOT, 'lib/studio.js'), 'utf8')

  check('a display is targeted by index', /kind: "display",\s*\n?\s*value: String\(d\.index/.test(srv))
  check('a window is targeted by its title', /kind: "window", value: String\(w\.name\)/.test(srv))
  check('no source option carries a raw id', !/value: String\((?:d|w)\.id\)/.test(srv))
  check('the flag follows the kind', /kind === "display"/.test(srv) && /kind === "window"/.test(srv) && /"--display"/.test(srv))
  check('whole screen passes no flag at all', /if \(!value\) return \[\];/.test(srv))
  // A window with no title cannot be named to --window, so offering it is
  // offering a failure.
  check('untitled windows are not offered', /filter\(\(w\) => String\(w\.name \?\? ""\)\.trim\(\)\)/.test(srv))
  // And the client has to send the kind, or the server cannot tell them apart.
  check('the picker sends a kind', /kind: 'window', value: typed\.value/.test(ui) && /body: JSON\.stringify\(\{[^}]*source/.test(ui))
  check('options are addressed by position, not value', /value: String\(i\)/.test(ui), 'a window title may contain any separator you would have used')
}

console.log('\nconsole output')
{
  // A job that exits nonzero says "The output below is why". It has to be true.
  // A failed `openscreen record` printed three NDJSON events carrying the exact
  // reason; all three parsed, none matched the Claude renderer, and the branch
  // returned anyway — so the log was empty under a status line promising it was
  // not. An unrendered line must fall through and be shown raw.
  const ui = await readFile(resolve(ROOT, 'lib/studio.js'), 'utf8')
  const emit = ui.slice(ui.indexOf('const emit = (cls, line) =>'), ui.indexOf('es = new EventSource'))
  check('the emit branch was found', emit.length > 100 && emit.length < 2000, `${emit.length} chars`)
  check('a parsed line only short-circuits when it rendered', /if \(rendered\) \{[\s\S]*?return\s*\n?\s*\}/.test(emit))
  check('an unrendered JSON line falls through to raw', emit.trimEnd().endsWith('write(cls, line)\n    }') || /write\(cls, line\)\s*\n\s*\}/.test(emit))
  check('openscreen events have a renderer of their own', /function openscreenLine/.test(ui) && /openscreenLine\(event\)/.test(emit))
  // Its messages carry real newlines — the window list is one — so a raw dump
  // would show them as a literal escape on one enormous line.
  check('multi-line messages are split into lines', /\.split\('\\n'\)/.test(ui.slice(ui.indexOf('function openscreenLine'), ui.indexOf('function claudeLine'))))
}

console.log('\nposter frames')
{
  // A fixed seek does not survive `--auto-zoom`. The zoom follows the cursor for
  // seconds at a time, so `-ss 1` and a quarter-of-the-way-in both landed inside
  // it and the poster came out as a tight crop of mid-screen with no wallpaper
  // and no window frame — which reads as a broken thumbnail rather than a zoomed
  // one. Candidates are measured instead, and the frame showing the whole
  // composition wins.
  const srv = await readFile(resolve(ROOT, 'bin/rm-studio.mjs'), 'utf8')
  const fn = srv.slice(srv.indexOf('async function thumbnail('), srv.indexOf('async function scriptsIn('))
  check('the poster function was found', fn.length > 500, `${fn.length} chars`)
  check('it tries more than one moment', /POSTER_CANDIDATES/.test(fn) && /for \(const fraction of POSTER_CANDIDATES\)/.test(fn))
  check('no fixed one-second seek survives', !/"-ss", "1"/.test(fn))
  check('candidates are judged on their borders', /posterScore\(shot\)/.test(srv))
  check('it stops early on a perfect score', /if \(best === 2\) break/.test(fn))
  // The cache key was the filename alone, so a re-export kept the old poster for
  // ever. Size and mtime mean stale ones age out without a sweep.
  check('the cache key includes size and mtime', /\$\{st\.size\}-\$\{Math\.round\(st\.mtimeMs\)\}/.test(fn))
  // Raw frames must not come back through the string-accumulating capture().
  check('frames are read as bytes', /function captureBinary/.test(srv) && /Buffer\.concat/.test(srv))
  check('the poster probe uses it', /captureBinary\("ffmpeg"/.test(fn))
}

console.log('\ndemo scripts')
{
  // The pipeline could turn a Playwright trace into a branded video but not
  // produce the trace, so the half of a demo that decides what the viewer sees
  // was the one thing the toolkit could not help with.
  const demo = await import('./demo-script.mjs')
  const { parseScript } = await import('./script-parse.mjs')

  const md = ['# Walkthrough', '', 'Start in the quote builder.', '', '```do', 'goto https://example.com/', 'click "Add to quote"', 'type "#part" "FEE-3410"', 'wait 800', '```', '', 'Adding a railing is **two** clicks.', '', '```js', 'const notAnAction = 1;', '```'].join('\n')

  const parsed = demo.parseDemo(md)
  check('a demo script parses', parsed.problems.length === 0, parsed.problems.join(' | '))
  check(
    'actions come out in order',
    demo
      .actions(parsed)
      .map((a) => a.verb)
      .join(',') === 'goto,click,type,wait',
  )
  check('a quoted argument keeps its spaces', demo.actions(parsed)[1].args[0] === 'Add to quote')
  check('a numeric argument becomes a number', demo.actions(parsed)[3].args[0] === 800)
  check('a code fence is not an action block', !JSON.stringify(parsed.steps).includes('notAnAction'))

  // The whole point of one file: the voice path must see exactly what it saw
  // before. If these ever diverge, a demo's narration and its actions drift.
  check('narration matches what the voice path speaks', JSON.stringify(demo.narration(parsed)) === JSON.stringify(parseScript(md)), JSON.stringify(demo.narration(parsed)))

  // A typo should fail before a browser opens, not leave a step missing from the
  // middle of a finished video.
  const bad = demo.parseDemo(['```do', 'cick "x"', 'type "#a"', 'wait soon', '```'].join('\n'))
  check(
    'a misspelled step is refused',
    bad.problems.some((p) => p.includes('no such step')),
  )
  check(
    'a wrong argument count is refused',
    bad.problems.some((p) => p.includes('takes 2')),
  )
  check(
    'a non-number is refused',
    bad.problems.some((p) => p.includes('wants a number')),
  )
  check(
    'problems name their line',
    bad.problems.every((p) => /^line \d+:/.test(p)),
  )
  check('nothing survives a broken block', bad.steps.length === 0)

  // The runner has to name the trace and the screencast the same, or recast
  // assembles from sparse screenshot frames and the video looks like a slideshow.
  const runner = await readFile(resolve(ROOT, 'bin/rm-demo.mjs'), 'utf8')
  check('the trace is named after the script', /join\(dir, `\$\{name\}\.zip`\)/.test(runner))
  check('the screencast shares that basename', /join\(dir, `\$\{name\}\.webm`\)/.test(runner))
  check('the trace carries screenshots for recast', /screenshots: true/.test(runner))
  check('narration is written out for rm-voice', /narration\.md/.test(runner))
  // recast's cursor overlay comes from a real pointer over a real window.
  check('it runs headed unless told otherwise', /headless: flag\("headless"\) === true/.test(runner))
  // A demo recording the wrong screen is worse than one that stops, and a missed
  // selector is the mistake these scripts make most often. Playwright's own
  // answer is "Timeout 15000ms exceeded", which says how long it waited and
  // nothing about what went wrong.
  check('a target is resolved before acting', /NEEDS_TARGET\.has\(step\.verb\)/.test(runner))
  check('a missing target says what was looked for', /nothing matched \$\{JSON\.stringify\(target\)\}/.test(runner))
  check('and offers what was actually clickable', /clickable here/.test(runner))

  const pkg = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8'))
  check('rm-demo ships as a binary', pkg.bin?.['rm-demo'] === './bin/rm-demo.mjs', JSON.stringify(pkg.bin?.['rm-demo']))

  /*
   * Three lists have to agree: the files in bin/, package.json's bin map, and
   * the formula's ENTRIES. Nothing made them, and they drifted twice.
   *
   * `rm-setup` was in neither list, and `install.sh`'s last step hands off to it
   * — so the one-command install died at the finish line on a clean machine,
   * having done everything except say so. `rm-share` was in the bin map but not
   * in ENTRIES, so brew shipped six of eight commands while the docs promised
   * seven. Both are invisible from inside this repo, where everything runs by
   * path and nothing needs to be linked.
   */
  const onDisk = (await readdir(resolve(ROOT, 'bin')))
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => f.replace(/\.mjs$/, ''))
    .sort()
  const inMap = Object.keys(pkg.bin ?? {}).sort()
  const formula = await readFile(resolve(ROOT, 'packaging/rm-video.rb'), 'utf8')
  const entriesMatch = /ENTRIES = %w\[([^\]]*)\]/.exec(formula)
  const entries = (entriesMatch?.[1] ?? '').split(/\s+/).filter(Boolean).sort()

  const missingFromMap = onDisk.filter((n) => !inMap.includes(n))
  const missingFromFormula = inMap.filter((n) => !entries.includes(n))
  const strayInFormula = entries.filter((n) => !onDisk.includes(n))

  check('every bin/ command is in package.json', missingFromMap.length === 0, missingFromMap.join(', '))
  check('every command the package declares is in the formula', missingFromFormula.length === 0, missingFromFormula.join(', '))
  check('the formula names nothing that does not exist', strayInFormula.length === 0, strayInFormula.join(', '))
  // The number the docs promise has to be the number that ships.
  const kickoff = await readFile(resolve(ROOT, 'docs/KICKOFF.md'), 'utf8')
  const promised = /installs Node and (\w+) commands/.exec(kickoff)?.[1]
  const words = { six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 }
  check('the docs promise the number that ships', words[promised] === entries.length, `docs say ${promised} (${words[promised]}), formula ships ${entries.length}`)
  const jobsSrc = await readFile(resolve(ROOT, 'lib/jobs.mjs'), 'utf8')
  check('and the job runner will run it', /"rm-demo"/.test(jobsSrc))
}

console.log('\ndemo panel')
{
  // The panel used to require a trace produced somewhere else, so the half of a
  // demo that decides what the viewer sees was the one part the Studio could not
  // help with. Writing the script is now in the same place as recasting it.
  const srv = await readFile(resolve(ROOT, 'bin/rm-studio.mjs'), 'utf8')
  const ui = await readFile(resolve(ROOT, 'lib/studio.js'), 'utf8')

  check('the check endpoint exists', /p === "\/api\/demo\/check"/.test(srv))
  check('the setup endpoint exists', /p === "\/api\/demo" && req\.method === "POST"/.test(srv))
  // It must hand back argv rather than run anything: a browser opening on your
  // screen is not something to trigger from a fetch nobody watched.
  const setup = srv.slice(srv.indexOf('p === "/api/demo" && req.method'), srv.indexOf('p === "/api/recast"'))
  check('setting up does not run the browser', /steps: \[/.test(setup) && !/jobs\.run\(/.test(setup))
  check('it refuses a script with problems', /parsed\.problems\.length\) return json\(res, 400/.test(setup))
  /*
   * Steps can be written into a script someone has already typed in.
   *
   * The builder wrote the whole box and only while `handEdited` was false, so one
   * keystroke — a /directive, now the normal thing to put there — silently stopped
   * the steps from compiling. The symptom was "the script has no ```do block"
   * about steps visible on the same screen.
   */
  {
    const ui = await readFile(resolve(ROOT, 'lib/studio.js'), 'utf8')
    /*
     * The clay renders are vendored, not referenced.
     *
     * The marks said whose video it was and nothing said what it was about. These
     * live in two sibling checkouts that the shipped app does not have, so the same
     * rule as the logos applies: copy them in, or render a broken plane.
     */
    {
      const mk = await readFile(resolve(ROOT, 'lib/make-imagery.mjs'), 'utf8')
      const idx = JSON.parse(await readFile(resolve(ROOT, 'brand/imagery/index.json'), 'utf8'))
      /*
       * Saving a wallpaper installs it where the editor looks.
       *
       * The editor's list is generated into the fork, and the Studio's save wrote only
       * the toolkit — so a wallpaper you had just made and were looking at did not
       * exist as far as the editor was concerned. One recipe sat rendered and
       * unreachable that way.
       */
      {
        const srv = await readFile(resolve(ROOT, 'bin/rm-studio.mjs'), 'utf8')
        const mk = await readFile(resolve(ROOT, 'lib/make-wallpapers.mjs'), 'utf8')
        const inst = await readFile(resolve(ROOT, 'lib/wallpaper-install.mjs'), 'utf8')
        // Both callers run the same install, or they drift and only one is right.
        /*
         * A document that names a deleted video says so, instead of opening blank.
         *
         * Captures are written to the app's private recordings folder and copied into
         * the project, but the document kept the private path — three of five documents
         * in the library pointed at files that no longer existed, one with its own video
         * beside it. The editor opened them, validated them, and showed nothing, which
         * reads as the editor dropping the video.
         */
        {
          const srv = await readFile(resolve(ROOT, 'bin/rm-studio.mjs'), 'utf8')
          const ui = await readFile(resolve(ROOT, 'lib/studio.js'), 'utf8')
          /*
           * A drafted script keeps the brief that produced it.
           *
           * The prompt was assembled at request time, handed to Claude and thrown away, so
           * once the script existed the inputs were gone and "same idea, one change" meant
           * retyping the brief from memory.
           */
          {
            const srv = await readFile(resolve(ROOT, 'bin/rm-studio.mjs'), 'utf8')
            const ui = await readFile(resolve(ROOT, 'lib/studio.js'), 'utf8')
            // Inside the project, so it travels, syncs and diffs with everything else.
            /*
             * Scenes and footage cut together into one document.
             *
             * Every piece existed — components, a scene renderer, an editor that opens a
             * document of clips — and the only way through was to hand-write scene HTML,
             * which meant nobody did.
             */
            {
              const comp = await readFile(resolve(ROOT, 'lib/compose.mjs'), 'utf8')
              const cli = await readFile(resolve(ROOT, 'bin/rm-compose.mjs'), 'utf8')
              const ui = await readFile(resolve(ROOT, 'lib/studio.js'), 'utf8')
              const { readComponentCatalogue, sceneDurationMs, sceneHtml } = await import(resolve(ROOT, 'lib/compose.mjs'))

              // Parsed from the components, so a new field needs no second edit here.
              const cat = await readComponentCatalogue(ROOT)
              /*
               * The content area fills the window.
               *
               * Optics caps .op-page__main-content at --op-breakpoint-medium because its page
               * shell is built for documents. This is a tool — the Library is a grid, Compose
               * is a segment list — and those want the window.
               *
               * Three separate rules capped it: `main`, .op-page__main-content and .container.
               * Lifting any one alone changed nothing, which reads as the override not
               * applying rather than as two more caps behind it. All three are asserted so a
               * single one coming back cannot quietly re-narrow the page.
               */
              {
                const css = await readFile(resolve(ROOT, 'lib/studio.css'), 'utf8')
                const uncapped = (sel, body) => new RegExp(`${sel}\\s*\\{[^}]*?max-(inline-size|width): none`, 's').test(body)
                check('main is not capped', uncapped('main', css))
                check('the content area is not capped', /\.op-page__main-content \{[^}]*?max-inline-size: none/s.test(css))
                check('the container is not capped', /\.container \{[^}]*?max-inline-size: none/s.test(css))
                // The measure has to live somewhere, or a lede runs the full window.
                check('prose keeps its own measure', /\.lede \{[^}]*?max-inline-size: 72ch/s.test(css) && /\.hint \{[^}]*?max-inline-size: 80ch/s.test(css))
              }

              check('the catalogue comes from the components', cat.length >= 6 && cat.every((c) => c.fields.length > 0))
              // The base class declares no fields; a lazy span from it swallowed the next
              // class and dropped a component while everything after re-aligned.
              check('every defined component is catalogued', cat.some((c) => c.tag === 'rm-title') && cat.some((c) => c.tag === 'rm-bullets'))
              // The stage is not something you place on the stage.
              check('the stage is not offered as an element', !cat.some((c) => c.tag === 'rm-scene'))

              // Elements overlap by design: a lower third inside a title card must not
              // make the scene the length of both.
              check(
                'a scene is as long as its furthest element, not the sum',
                sceneDurationMs([
                  { at: 0, for: 2500 },
                  { at: 900, for: 1600 },
                ]) === 2500,
              )
              // Attribute values are interpolated into HTML.
              check('scene attributes are escaped', !sceneHtml({ elements: [{ tag: 'rm-title', at: 0, attrs: { title: '"><script>x</script>' } }] }).includes('<script>x'))
              // render-scene screenshots the viewport, not the stage, so a scrollbar would
              // be composited into every frame.
              check('a rendered scene cannot scroll', /overflow: hidden/.test(comp))

              // The form's six components with fixed fields are a ceiling; the renderer
              // never cared where the HTML came from.
              /*
               * A title can go into a recording that already exists.
               *
               * The fork declares `insert_asset_clip` — assetId, beforeClipId, afterClipId,
               * a source range — and implements it nowhere: no applier, no caller, no UI. The
               * edit can be described and nothing performs it. So the document is written
               * with the clip already on its timeline, which needs only the one thing the
               * editor definitely does.
               */
              const ins = await readFile(resolve(ROOT, 'lib/insert-clip.mjs'), 'utf8')
              const still = await readFile(resolve(ROOT, 'lib/render-still.mjs'), 'utf8')
              const insertCli = await readFile(resolve(ROOT, 'bin/rm-insert.mjs'), 'utf8')
              /*
               * A title can sit OVER footage, despite the timeline having no layers.
               *
               * `timelineSchema` is a flat clip list and `assetSchema.kind` is
               * `z.literal("video")`, so nothing that is not video can be placed above a
               * clip. `document.annotations` already is a layer — time range, position and
               * size in percent, a zIndex the compositor draws in ascending order, and a
               * `type: "image"` whose content is a path. It crosses the bridge in
               * sceneDescription.ts, so an overlay survives export rather than being a
               * preview-only trick.
               */
              check('an overlay is an image annotation', /export function imageOverlay/.test(ins) && /type: "image"/.test(ins))
              // sceneDescription reads `content || imageContent`; the inspector round-trips
              // the typed slot. One without the other renders in preview and vanishes on export.
              check('both image slots are written', /content: path,\n\t\timageContent: path,/.test(ins))
              // Without omitBackground the shot is composited onto white: it looks right in a
              // viewer and covers the video in the render.
              check('the card is rendered transparent', /omitBackground: true/.test(still) && /background: transparent !important/.test(still))
              // And checked, because an opaque card is a rectangle over the footage.
              check('an opaque card is refused', /export async function hasAlpha/.test(still) && /would hide the video rather than sit on it/.test(insertCli))
              const insCli = await readFile(resolve(ROOT, 'bin/rm-insert.mjs'), 'utf8')
              // v2 names one screenVideoPath and has no clip list, so it cannot say "these
              // two, in this order" — which is the entire point of an insert.
              check('an insert writes an AxcutDocument', /AXCUT_SCHEMA_VERSION = 7/.test(ins) && /schemaVersion: AXCUT_SCHEMA_VERSION/.test(ins))
              // A random id per run makes every re-run diff against itself everywhere.
              check('ids are stable across runs', /const idFor = \(prefix, seed\)/.test(ins) && !/Math\.random/.test(ins))
              // A card belongs before the thing it titles, not after the video ends.
              check('no position means the front', /if \(atSec == null\) return \[piece, \.\.\.pieces\]/.test(ins))
              // Splitting a recording to fit a card in is a different edit with different
              // consequences; doing it silently is how a video ends up with a hole in it.
              check('a position inside a clip moves to a boundary, and says so', /landedAtSec/.test(ins) && /is inside a clip, so the card went to the nearest boundary/.test(insCli))
              // The editor shows the origin; "agent" would make a person's cut look unprompted.
              check("an inserted clip is marked as the user's", /origin: "user"/.test(ins))

              /*
               * Editing raw footage means saying which PART of a file you want.
               *
               * `clipSchema` has carried sourceStartSec/sourceEndSec since the fork began
               * and nothing in the pipeline ever set them: every clip was the whole file,
               * so "trim this" had nowhere to land. The cut list is the model that sets
               * them, and these are the properties that make it a cut rather than a
               * playlist.
               */
              const cut = await readFile(resolve(ROOT, 'lib/cutlist.mjs'), 'utf8')
              const { cutlistToDocument } = await import(resolve(ROOT, 'lib/cutlist.mjs'))
              check('a clip carries its trim', /sourceStartSec: inSec/.test(cut) && /sourceEndSec: outSec/.test(cut))
              const cutDoc = cutlistToDocument({
                id: 'verify',
                title: 'verify',
                createdAt: '2026-01-01T00:00:00.000Z',
                clips: [
                  { path: '/a/one.mp4', durationSec: 60, inSec: 4, outSec: 12 },
                  { path: '/a/one.mp4', durationSec: 60, inSec: 40, outSec: 46 },
                  { path: '/a/one.mp4', durationSec: 60, inSec: 9, outSec: 9 },
                ],
                overlays: [
                  { path: '/a/t.png', atSec: 2, forSec: 4 },
                  { path: '/a/t.png', atSec: 900, forSec: 3 },
                ],
              })
              // Two spans from one recording are two clips over ONE asset. An asset each
              // would decode the same file twice and let its per-asset state disagree.
              check('one asset per file, not per clip', cutDoc.assets.length === 1 && cutDoc.timeline.clips.length === 2)
              // Timeline time is derived, never stated: the second clip starts when the
              // first stops, whatever was trimmed off it.
              const [c1, c2] = cutDoc.timeline.clips
              check('the spans lay end to end, trimmed', c1.sourceStartSec === 4 && c1.sourceEndSec === 12 && c1.timelineStartSec === 0 && c1.timelineEndSec === 8 && c2.timelineStartSec === 8 && c2.timelineEndSec === 14, `${c1.timelineEndSec}s then ${c2.timelineStartSec}–${c2.timelineEndSec}s`)
              // A clip dragged down to nothing is a clip somebody removed, not a zero-length
              // entry for the editor to render nothing at.
              check(
                'an empty span is dropped',
                cutDoc.timeline.clips.every((c) => c.timelineEndSec > c.timelineStartSec),
              )
              // An overlay past the end cannot be seen, and a document carrying invisible
              // annotations is one nobody can reason about.
              check('an overlay past the end is dropped', cutDoc.annotations.length === 1 && cutDoc.annotations[0].startMs === 2000)
              // Same cut list, same document — or an editor holding the old one cannot tell
              // that nothing changed.
              check('the same cut list gives the same ids', !/Math\.random/.test(cut) && /const idFor = \(prefix, seed\)/.test(cut))

              /*
               * And a trim is made by looking, not by typing.
               *
               * A number field cannot show you the frame you are cutting on, so the handles
               * seek the preview as they move — that is the difference between trimming
               * footage and describing a trim.
               */
              const ui4 = await readFile(resolve(ROOT, 'lib/studio.js'), 'utf8')
              check('the handles scrub the preview', /video\.currentTime = dragging === 'in' \? c\.inSec : c\.outSec/.test(ui4))
              // Crossing the handles is not an edit anybody means, and it makes a clip the
              // document drops silently.
              check('the handles cannot cross', /Math\.min\(t, \(c\.outSec \?\? c\.durationSec\) - 0\.1\)/.test(ui4) && /Math\.max\(t, \(c\.inSec \?\? 0\) \+ 0\.1\)/.test(ui4))
              // A drag handle that only takes a mouse is a control half the people using it
              // cannot reach.
              check('a trim can be made from the keyboard', /ArrowLeft' \? -step/.test(ui4) && /h\.tabIndex = 0/.test(ui4))
              // Previewing past the out point shows footage the cut does not contain.
              check('the preview stops at the out point', /if \(playing && video\.currentTime >= \(c\.outSec \?\? video\.duration\)\)/.test(ui4))
              /*
               * Silent footage is named as such where it is picked.
               *
               * A capture made with the mic and system audio off — which is the default, and
               * a preference the fork deliberately keeps in memory rather than on disk —
               * carries no audio stream at all. The editor plays it without a word, so it
               * reads as the editor losing the sound rather than as there never having been
               * any. The catalogue already probed for the track.
               */
              /*
               * A form nobody attached is a blank page.
               *
               * Every panel here builds `const f = el('div', 'form')`, fills it, and appends
               * it to the view's own node — and a view that skips that last step renders its
               * lede and nothing else, with no error anywhere: the form exists, it is
               * populated, it is fully wired, and it is not in the document. Cheap to check
               * and invisible to read past.
               */
              const attachesF = (bodyText) =>
                // Any receiver, not just `m`: a panel may append its form to a card that is
                // itself on the page (vReview does). What matters is that `f` is somebody's
                // child — `f.append(...)` is the form filling itself and does not count.
                [...bodyText.matchAll(/(\w+)\.append(?:Child)?\(([^()]*)\)/g)].some(([, receiver, argText]) => receiver !== 'f' && argText.split(',').some((arg) => arg.trim() === 'f'))
              const formViews = [...ui4.matchAll(/^function (v[A-Z]\w*)\(m[^)]*\) \{([\s\S]*?)\n\}/gm)].filter(([, , bodyText]) => /const f = el\('div', 'form'\)/.test(bodyText)).filter(([, , bodyText]) => !attachesF(bodyText))
              check('every panel attaches the form it built', formViews.length === 0, formViews.map(([, fn]) => fn).join(', '))

              /*
               * The panel you were on outlives the app, and it is not kept in the browser.
               *
               * The Studio asks the OS for a free port on every launch, so the page's origin
               * is a new one each start and ANY browser-side store keyed to it is unreachable
               * afterwards — the trap the script drafts already fell into once. The failure
               * is invisible in testing, because a reload inside one session keeps the port
               * and works perfectly.
               */
              const settingsSrc = await readFile(resolve(ROOT, 'lib/settings.mjs'), 'utf8')
              // Actual use, not the word: the comment in studio.js explaining why localStorage
              // was wrong here is the most valuable line on the subject and must survive.
              check('the last panel is kept on disk, not in the browser', /export async function setLastView/.test(settingsSrc) && !/localStorage\.(get|set)Item/.test(ui4))
              // That file also holds the OpenFrame token, and writeFile applies a mode only
              // when it CREATES the file — a looser write that happened to go first would
              // leave the token world-readable with no later chance to tighten it.
              check('and written no looser than the token beside it', /setLastView[\s\S]{0,600}?mode: 0o600/.test(settingsSrc))
              /*
               * A stored name is checked against the nav before it is used.
               *
               * It comes from a file that outlives any given build, so a panel since renamed
               * or removed would reach the dispatch table as `undefined` and take the whole
               * page down — a blank window whose cause is one word in a config file.
               */
              check('a stale panel name cannot blank the page', /known\.has\(S\.lastView\)/.test(ui4))
              // The Editor and Review open something chosen elsewhere, and that choice lives
              // in memory only: restoring either lands on an empty panel, which is
              // indistinguishable from the app being broken.
              check('panels that need a handoff are not restored', /NEEDS_A_DOCUMENT = new Set\(\['editor', 'review'\]\)/.test(ui4))

              /*
               * A scene can contain a picture, and the picture is picked.
               *
               * The component set could draw a browser, a title, a callout, a stat and a
               * list, and had no way to put an image on a stage — so the clay renders in
               * brand/imagery/ were visible in the Brand panel and usable in nothing.
               */
              const comp2 = await readFile(resolve(ROOT, 'components/rm-video.js'), 'utf8')
              const composeSrc = await readFile(resolve(ROOT, 'lib/compose.mjs'), 'utf8')
              check('a picture can be a part of a scene', /class RMImage extends RMElement/.test(comp2) && /define\('rm-image', RMImage\)/.test(comp2))
              /*
               * And named, not pathed — the wallpaper's lesson, repeated.
               *
               * A caller-supplied path is right for a render out of components/ and 404s in
               * a preview served from another URL. The stage carries the base, because
               * sceneHtml is the only thing that knows which of the two this is; resolving
               * in the component means an AUTHORED body gets it too, without anybody having
               * to parse HTML somebody wrote by hand.
               */
              check('the stage carries the picture base', /assetsAttr = ` assets="\$\{esc\(`\$\{base\}\/brand\/imagery`\)\}"`/.test(composeSrc))
              check('and a name is resolved against it', /this\.closest\('rm-scene'\)\?\.getAttribute\('assets'\)/.test(comp2))
              // A path or a URL is the author's business and passes through untouched.
              check('a path is left alone', /raw\.includes\('\/'\) \|\| \/\^\[a-z\]\+:\/i\.test\(raw\)/.test(comp2))
              // A filename is not what anybody is choosing between.
              check('pictures are offered as pictures', /const IMAGE_FIELDS = \{/.test(ui4) && /\/brand\/imagery\/\$\{item\.file\}/.test(ui4))
              /*
               * And only where a picture is what the field means.
               *
               * `src` is two different things: a brand picture on `rm-image`, and a
               * LIVE URL on `rm-browser`, whose own comment says `image` is the
               * screenshot and `src` embeds an iframe. Keyed on the field name alone,
               * the picker offered the clay renders as something to put in a browser's
               * address bar — and left no way to type the URL that belongs there.
               */
              check('and only where the component means a picture', /const isImageField = \(tag, field\)/.test(ui4) && !/'rm-browser':/.test(ui4))
              /*
               * A position is dragged, not typed.
               *
               * `x` and `y` are a percentage of the stage, which nobody arrives at by
               * typing a number and re-rendering. `repaint: false` on input matters:
               * rebuilding the cards mid-drag replaces the slider under the pointer
               * and the drag stops dead.
               */
              check('a position is a slider', /const RANGE_FIELDS = \{/.test(ui4) && /type: 'range'/.test(ui4) && /sync\(\{ repaint: false \}\)/.test(ui4))
              /*
               * A project is the space you are working in, not a field on nine forms.
               *
               * Ten selects over nine panels asked the same question and none could
               * remember the answer. Chosen once in the header instead — and stored on
               * disk, not in localStorage, because the app takes a new port each launch
               * so a browser store keyed to the origin is unreachable next time.
               */
              const settingsNow = await readFile(resolve(ROOT, 'lib/settings.mjs'), 'utf8')
              check('the project is chosen once, in the header', /function projectSwitcher\(/.test(ui4) && /export async function setCurrentProject/.test(settingsNow))
              // Brand, Components, Wallpapers, Storage and Console reference S.projects
              // zero times: they are about the toolkit, not about a piece of work. A
              // project name over the Components gallery would claim otherwise.
              check('and not shown on the panels it does not scope', /const GLOBAL_VIEWS = new Set\(/.test(ui4))
              /*
               * A stored id whose folder is gone falls back rather than scoping every
               * panel to a project that is not there — empty lists, failing saves, and
               * nothing on screen saying why.
               */
              const srvNow2 = await readFile(resolve(ROOT, 'bin/rm-studio.mjs'), 'utf8')
              check('a deleted project does not haunt the app', /projects\.some\(\(p\) => p\.id === id\) \? id : null/.test(srvNow2))
              /*
               * And a first run says what to do instead of rendering furniture.
               *
               * Every scoped panel is about a project, so with none they come up as an
               * empty shelf and a dead Save — which teaches a first-time user that the
               * tool is broken, the most expensive wrong idea they can form. `new` and
               * `console` are exempt: they are the two panels that can do something
               * about it, and redirecting them would make the invitation a trap.
               */
              check('a first run is an invitation, not an empty form', /function vFirstRun\(m\)/.test(ui4) && /!\['new', 'console'\]\.includes\(view\)/.test(ui4))
              /*
               * The rail keeps its icons.
               *
               * Optics collapses a rail's labels with `font-size: 0` on
               * `.sidebar__content > *`, which is right for text and fatal for ours:
               * these icons ARE text, a ligature font rendered through ::before, so
               * they inherited the zero and the whole nav came up as an empty column
               * with the tool dots below it. Optics' own comment on that rule reads
               * "Need to get icon behavior".
               */
              const cssNow = await readFile(resolve(ROOT, 'lib/studio.css'), 'utf8')
              check('the rail keeps its icons', /\.sidebar--rail \.sidebar__content > \* \.hgi-stroke \{[^}]*font-size:/s.test(cssNow))
              // A column of status dots whose names have been collapsed says something
              // is true about something. A readout you cannot read is worse than none.
              check('and drops the readout it cannot label', /\.sidebar--rail #tools \{[^}]*display: none/s.test(cssNow))
              // The label survives as the accessible name at font-size 0, so only the
              // sighted-hover reading was missing.
              check('a collapsed label is still a tooltip', /if \(!b\.title\) b\.title = b\.textContent\.trim\(\)/.test(ui4))
              /*
               * The nav reads as the work, in two groups.
               *
               * Thirteen siblings named after subsystems, with nothing to say which
               * came first — and it could not have been ordered anyway, because every
               * one of them opened by asking which project, so all thirteen were
               * equally step one. Moving the project to the header is what freed this.
               */
              const navSrc = await readFile(resolve(ROOT, 'lib/studio.html'), 'utf8')
              const navMarkup = /<div class="sidebar__content[^"]*">([\s\S]*?)<\/nav>/.exec(navSrc)?.[1] ?? ''
              const navOrder = [...navMarkup.matchAll(/data-v="([a-z]+)"/g)].map((x) => x[1])
              check(
                'the nav is in pipeline order',
                navOrder.join(' ') === 'library create scripts voice scenes compose cut editor review brand components storage console',
                navOrder.join(' '),
              )
              /*
               * The headings are SIBLINGS of the buttons, not wrappers.
               *
               * Optics styles this component through `.sidebar__content > *` in four
               * places — the base alignment and all three widths — and `display:
               * contents` does not fool a child combinator: it removes the box, not the
               * parentage. Wrapping the groups cost the buttons their left alignment and,
               * in the rail, the `font-size: 0` that collapses their labels.
               */
              check('and its groups do not come between the content and its children', /<h2 class="navgroup">/.test(navMarkup) && !/navgroup__items/.test(navMarkup))
              /*
               * The pipeline group appears once you are in a project.
               *
               * Those eight panels are about a piece of work, and without a project each
               * one redirects to the first-run panel — so offering them is offering eight
               * doors to the same "make a project first".
               */
              check('the pipeline group waits for a project', /function paintNavGroups\(\)/.test(ui4) && /data-group="make"/.test(navMarkup))
              /*
               * And `hidden` has to actually hide.
               *
               * The attribute's `display: none` comes from the UA stylesheet, which any
               * author `display` rule outranks — and `.btn` sets one. Setting the property
               * took away the group's <h2>, which has no author display rule, and left all
               * eight buttons on screen. A property check passed the whole time, because
               * the property WAS set: only what rendered disagreed.
               */
              check('and hiding it hides the buttons too', /^\[hidden\] \{\n\s*display: none;/m.test(cssNow))
              /*
               * And the empty state's artwork actually ships.
               *
               * `assets/` was tracked but absent from package.json `files`, so it was in
               * the repo and not in the tarball — the icon rendered on the machine that
               * made it and 404'd for everyone who installed. The npm/brew path is the
               * one nobody tests locally, which is exactly why it is worth a check.
               */
              const pkgFiles = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8')).files
              check('the empty state ships with the package', pkgFiles.includes('assets') && existsSync(resolve(ROOT, 'assets/empty-state.svg')))
              /*
               * And a stale lastView cannot land you in one anyway.
               *
               * Nothing can be CLICKED into that state once the group is hidden, but
               * `lastView` outlives a session: a stored "scenes" would open Scenes scoped
               * to no project — empty shelves and a Save that writes nowhere. The Library
               * is the picker, so that is where it goes.
               */
              check('and a scoped view without one goes to the picker', /if \(!GLOBAL_VIEWS\.has\(view\) && !currentProject\(\)\) \{/.test(ui4))
              /*
               * "Shared" is a property of a script, not a place to stand.
               *
               * It was an option in the project switcher for one release, which made a
               * half-state where Scripts worked and the other eight panels did not — and
               * once the group hides without a project it would have hidden the only panel
               * that state was good for. It is a control in Scripts' rail now.
               */
              const scriptsTplNow = /<template data-panel="scripts">([\s\S]*?)<\/template>/.exec(navSrc)?.[1] ?? ''
              check('the shared shelf is a script setting, not a workspace', /data-el="shelf"/.test(scriptsTplNow) && /'Choose a project…'/.test(ui4))
              // Main is where you write; the name, the length and where it saves are knobs
              // about the thing being written rather than the thing itself.
              check('and the knobs are in the rail, not the writing surface', /data-region="side"[\s\S]*data-el="shelf"/.test(scriptsTplNow))
              /*
               * And the browser part can be placed at all.
               *
               * It had no position, so rm-scene's `::slotted(*) { position:absolute }`
               * left it wherever the default put it and the only way to move it was to
               * change its width. Centred on its own point like every other part —
               * written as `.win.anim` and carrying the entrance transform, because
               * .win IS the animated element and a bare translate would silently
               * replace the rise and the scale.
               */
              {
                const browserSrc = await readFile(resolve(ROOT, 'components/rm-video.js'), 'utf8')
                check(
                  'the browser part takes a position',
                  /static fields = \['url', 'x', 'y', 'w'/.test(browserSrc) && /\.win\.anim \{ transform: translate\(-50%/.test(browserSrc),
                )
                // One field for the viewport, not three. `url` is what it says and
                // what it loads; `src` and `image` are gone, so the chrome can no
                // longer name one site while the viewport shows another.
                check('and loads the address it shows', /const target = url &&/.test(browserSrc) && !/const image = this\.attr\('image'\)/.test(browserSrc))
              }
              /*
               * At a size you can read them at.
               *
               * Dropped into the field grid they wrapped two abreast at favicon size with no
               * captions, and a rocket was indistinguishable from a keyboard — a picker that
               * shows you nothing to pick between.
               */
              check('and given the width to be seen', /group\.style\.gridColumn = '1 \/ -1'/.test(ui4) && /overflow-x:auto/.test(ui4))

              /*
               * Space Grotesk travels with the render.
               *
               * The Academy face, vendored for the reason GSAP is: a composition that reaches
               * fonts.gstatic.com has a network dependency at RENDER time, and a renderer
               * that seeks and screenshots does not wait for a font — it captures the
               * fallback and reports nothing. The failure is a video in the wrong typeface.
               */
              const fontCss = await readFile(resolve(ROOT, 'brand/fonts/fonts.css'), 'utf8')
              const staging = await readFile(resolve(ROOT, 'lib/render-assets.mjs'), 'utf8')
              // The declaration, not the word: the comment explaining WHY the face is vendored
              // names the host it is vendored to avoid, and that comment is the point.
              check('the Academy face is vendored, not fetched', /font-family: "Space Grotesk"/.test(fontCss) && !/src:\s*url\(["']?https?:/.test(fontCss))
              check('and staged into every render', /SpaceGrotesk-Variable-latin\.woff2/.test(staging))
              /*
               * Switchable at all, which it was not.
               *
               * Every component pinned DM Sans on its own :host, and a value set on the
               * stage loses to that — so the sub-brand typeface had nowhere to get in.
               */
              check('a scene can change its face', /--font: var\(--rm-font, "DM Sans"\)/.test(comp2) && /--rm-font: "Space Grotesk"/.test(comp2))

              /*
               * The Console can be emptied, and only of what has finished.
               *
               * Forgetting a running job orphans its child process, its subscribers and its
               * journal checkpoint — something still writing output to a record that no
               * longer exists.
               */
              const jobsSrc = await readFile(resolve(ROOT, 'lib/jobs.mjs'), 'utf8')
              check('finished jobs can be cleared', /export async function clearFinished/.test(jobsSrc) && /jobs\.values\(\)\]\.filter\(\(j\) => !j\.child\)/.test(jobsSrc))
              // The store is rebuilt from the journal on boot, so a file left behind is a job
              // that returns at the next restart — a Clear that un-clears itself overnight.
              check('and their journals go with them', /if \(jobs\.has\(n\.slice\(0, -5\)\)\) continue;/.test(jobsSrc))

              /*
               * Secondary text is chosen by measurement, not by eye.
               *
               * minus-five is 7.3:1 on the brand's dark boards — legible, and washed out
               * beside a title at 18.5:1, which is what made a subtitle read as greyed-out
               * rather than as secondary.
               */
              const rmv2 = await readFile(resolve(ROOT, 'components/rm-video.js'), 'utf8')
              check('secondary text carries real contrast', /--muted: var\(--op-color-neutral-minus-seven/.test(rmv2))
              /*
               * The subtitle is ink, not a hint.
               *
               * It was neutral-minus-five: 7.3:1 on the brand's dark boards, legible and
               * washed out beside a title at 18.5:1, which is how a subtitle comes to read
               * as greyed-out. It carries --fg now, which is the strongest answer there is.
               *
               * A text-shadow was here too, so a card laid over FOOTAGE kept its contrast
               * against whatever the frame showed. It was removed deliberately after being
               * seen on a board, so this no longer asserts it — but the gap is real, and an
               * overlay over a bright frame is where it will come back.
               *
               * (The check this replaces read `.test(rmv2).length >= 4` — a boolean's
               * length, so it could never pass. A reformatting pass turned a working
               * expression into one that was always false, which is the kind of thing a
               * check exists to catch and cannot catch about itself.)
               */
              check('the subtitle is ink, not a muted grey', /\.sub \{[^}]*color:var\(--fg\)/.test(rmv2))
              /*
               * Academy-Slide stays gone.
               *
               * Deleting the file was never enough: WANTED is what gets fetched, so every run
               * copied it straight back and every imagery:check called its absence drift.
               */
              const imagerySrc = await readFile(resolve(ROOT, 'lib/make-imagery.mjs'), 'utf8')
              // The entry, not the word: the comment saying why it is gone is the part that
              // stops it being re-added by somebody who does not know it keeps coming back.
              check('a removed picture stays removed', !/name: "academy-slide"/.test(imagerySrc) && /deliberately absent/.test(imagerySrc))
              /*
               * Nothing above the Console until there is something to read.
               *
               * The lede explains a running job's output and the Clear button acts on jobs;
               * with neither present they were furniture around an empty box, describing
               * something not on screen. And Clear sits after the list it empties — a
               * destructive control at the top is one you reach before reading what it takes.
               */
              check('the Console hides its furniture when empty', /lede\.hidden = !any/.test(ui4) && /tools\.hidden = !any/.test(ui4))
              /*
		 * Clear acts on the whole list, so it sits in the page footer.
		 *
		 * It used to build a `<footer class="shell__footer">` of its own. Optics'
		 * `main-footer` is a row of `.op-page__main` outside the scrolling content,
		 * which puts it after the list by grid placement rather than by append order —
		 * and a destructive control above a list is one you reach before reading what
		 * it would remove.
		 */
		check('and Clear comes after the list it empties', /const tools = \$\('\.op-page__main-footer'\)/.test(ui4) && !/shell__footer'\)/.test(ui4))

              check('silent footage says so', /file\.media\.audio === null/.test(ui4) && /no audio track, so the cut will be silent/.test(ui4))
              // The cut list is the source; the document has already dropped what it could
              // not use, so keeping only the document means rebuilding a cut from memory.
              const studioSrv = await readFile(resolve(ROOT, 'bin/rm-studio.mjs'), 'utf8')
              check('the cut list is kept beside the document', /"cutlist\.json"/.test(studioSrv))

              /*
               * Nobody types an element to get started.
               *
               * The first version was an empty box and a placeholder showing the syntax — a
               * text field pretending to be an editor, which asks you to remember six tag
               * names and their attributes before anything appears on screen.
               */
              const ui3 = await readFile(resolve(ROOT, 'lib/studio.js'), 'utf8')
              check('parts are added from the catalogue', /const buildPalette = \(components\)/.test(ui3) && /Add a \$\{c\.tag/.test(ui3))
              /*
               * The palette is the brand's seeds, in a dropdown.
               *
               * It was two rows of squares — nineteen scales, then nineteen steps of
               * whichever you clicked — which is accurate and is a colour laboratory: the
               * bases repeat (`tertiary` and `accent` are one colour, so are `primary` and
               * Academy's) and the steps are shades of a decision already made. 361 squares
               * is not a palette. One colour per family, as the brand defines it, is.
               */
              check("colour offers the brand's seeds, by name", /var\(--op-color-\$\{family\}-original\)/.test(ui3) && /function colorMenu\(/.test(ui3))
              // Kept as a token, not resolved, so the colour follows the theme instead of
              // freezing at whatever it painted the day it was picked. A wallpaper is the
              // exception and says so: it bakes to a JPEG, where a var() is nothing.
              check('a scene keeps the token, a wallpaper takes the hex', /format = 'token'/.test(ui3) && /format: 'hex'/.test(ui3))
              // Two spellings of one colour are one choice; offering both is what made the row
              // look broken.
              /*
               * And an accent brings its two contrast colours with it.
               *
               * Setting `--brand` alone was the bug: `--on-brand` is declared once from
               * Academy green and never touched, so a part filled with a pale yellow inked
               * its text in a dark green mixed for a different colour. `--brand-text` is the
               * third question — the family as TEXT on a dark stage, where a deep purple
               * seed is invisible.
               */
              check('an accent carries its ink and its text colour', /function accentStyle\(accent\)/.test(ui3) && /--on-brand:var\(--op-color-\$\{family\}-on-base\)/.test(ui3) && /--brand-text:var\(--op-color-\$\{family\}-minus-two\)/.test(ui3))
              // color-contrast() is not implemented in Chromium, so the declaration was
              // invalid and the callout's text fell back to the inherited white — which on a
              // pale accent is the fill's own colour, near enough.
              const rmv = await readFile(resolve(ROOT, 'components/rm-video.js'), 'utf8')
              check('nothing inks with a function Chromium does not have', !/color-contrast\(/.test(rmv) && /color:var\(--on-brand\)/.test(rmv))
              /*
               * And the dedupe fails safe. An unresolvable var() falls back to the inherited
               * colour, every scale paints the same, and the palette collapses to one swatch —
               * a picker that has silently disappeared, with the cause nowhere near the symptom.
               */
              /*
               * A part is one row until you open it.
               *
               * A card with every field expanded is about 300px tall, so three parts pushed
               * the scene off the bottom — and the scene is the thing being edited.
               */
              // Optics' small variant: a part is a dense row of short values, and a
              // full-size control per field is most of a card's height.
              /*
               * A panel's status line is not a field's hint.
               *
               * `.form .form-hint` hid every hint in the form until its form-group had focus.
               * A status line sits directly in the form, so its parent is never
               * `.form-group:focus-within` and it could never appear: Save wrote the file,
               * Draft returned its error, and neither said anything — which reads as two
               * dead buttons.
               */
              const css2 = await readFile(resolve(ROOT, 'lib/studio.css'), 'utf8')
              const shellMarkup = await readFile(resolve(ROOT, 'lib/studio.html'), 'utf8')
              const srvNow = await readFile(resolve(ROOT, 'bin/rm-studio.mjs'), 'utf8')
              check("only a field's own hint is focus-gated", /:is\(\.form, \.panel-card\) \.form-group\s*>\s*\.form-hint\s*\{/.test(css2) && !/^\s*\.form \.form-hint\s*\{/m.test(css2))
              // wpSlug("") is "untitled", so an unnamed scene saved over the last one.
              check('a scene must be named, not defaulted', /Give the scene a name first/.test(ui3) && /!String\(b\.name \?\? ""\)\.trim\(\)/.test(srvNow))
              // The brief was declared last, so it rendered below the button that needs it.
              /*
               * The brief sits above the button that acts on it, and the stage above
               * the parts — both now facts about the markup rather than about the
               * order of `.append()` calls, because the panel is a <template>.
               */
              const tpl = /<template data-panel="scenes">([\s\S]*?)<\/template>/.exec(shellMarkup)?.[1] ?? ''
              check('the brief comes before the button that uses it', tpl.indexOf('data-el="brief"') < tpl.indexOf('data-el="draft"'))

              check('part controls use the small variant', /'form-control', 'form-control--small'/.test(ui3))
              // Reordering and removing are things you do to a part you have already read.
              check("the part's buttons come after its fields", /bodyEl\.append\(grid, head\)/.test(ui3))

              check('parts collapse to a row', /const card = el\('details', 'card'\)/.test(ui3) && /card\.open = i === elements\.length - 1/.test(ui3))
              // The preview sits above them, so its position does not depend on the count.
              check('the scene is above the parts', tpl.indexOf('data-el="frame"') < tpl.indexOf('data-el="cards"'))
              /*
               * And config and actions are not in the scrolling content.
               *
               * `sidebar-right` is its own grid column and `main-footer` its own row
               * of `.op-page__main`, both siblings of `.op-page__main-content`. A
               * sticky bar built inside `#main` was imitating this.
               */
              check('config and actions leave the content area', /data-region="side"/.test(tpl) && /data-region="footer"/.test(tpl))
              check('and the panel is mounted from that markup, not assembled', /function mountPanel\(/.test(ui3) && /mountPanel\('scenes', m\)/.test(ui3))
              /*
               * And it opens on a frame that shows something. Every part animates in from
               * opacity 0, so t=0 is the one instant a correct scene looks empty.
               */
              check('the playhead lands mid-scene', /if \(!playheadMoved && dur\) scrub\.value = Math\.round\(dur \/ 2\)/.test(ui3))
              // `load` fires before the wrapper's own `await RM.ready(); RM.seek(0)` settles,
              // so a seek here was overwritten and --t stayed at 0 while the scrubber moved.
              check('and waits for the scene before seeking', /await frame\.contentWindow\?\.RM\?\.ready\?\.\(\)/.test(ui3))

              /*
               * A window running older code says so.
               *
               * The Studio is edited while it is being used, and a page holding an older
               * studio.js is indistinguishable from a feature that does not work — a missing
               * swatch row, a button that is not there, an empty panel. Each of those has
               * been reported as a bug in the feature rather than as a stale page.
               */
              const uiSrc = await readFile(resolve(ROOT, 'lib/studio-ui.mjs'), 'utf8')
              const srvSrc3 = await readFile(resolve(ROOT, 'bin/rm-studio.mjs'), 'utf8')
              check('the page is stamped with its client version', /name="rm-studio-client"/.test(uiSrc) && /export async function clientStamp/.test(uiSrc))
              check('and the server reports the current one', /\/api\/client-stamp/.test(srvSrc3))
              // Re-checked on focus, because returning to the window is when the confusion
              // happens.
              check('a behind window offers a reload', /older Studio code/.test(ui3) && /addEventListener\('focus', check\)/.test(ui3))

              /*
               * A token that does not resolve is shown as broken, not hidden.
               *
               * A missing token paints the inherited colour, so every swatch comes out
               * identical and the palette looks like one colour repeated — a picker that has
               * silently disappeared, with the cause (a stylesheet that did not load)
               * nowhere near the symptom.
               */
              check('an unresolved colour is kept and marked', /colormenu__swatch--dead/.test(ui3) && /not resolving/.test(ui3))
              check('and an empty palette says so', /No brand colours came back/.test(ui3) && /Quit and reopen the app/.test(ui3))
              // Built from the catalogue the renderer reads, so a new field needs no edit here.
              {
                const sh = await readFile(resolve(ROOT, 'install.sh'), 'utf8')
                /*
                 * The bundle is ad-hoc signed, so macOS will not open it while quarantined —
                 * "Apple could not verify…", whose only other button really does delete the app.
                 * Homebrew 6 removed --no-quarantine, so the attribute is stripped afterwards.
                 */
                check('install.sh strips the quarantine flag', /xattr -dr com\.apple\.quarantine/.test(sh))
                // The flag returns on every upgrade, and re-running the installer is what
                // somebody does after hitting the wall — stripping only on first install means
                // the one action that fixes it is the one skipped.
                check('and does it when the app is already installed', (sh.match(/^\t*unquarantine$/gm) || []).length >= 2)
              }

              const uiC = await readFile(resolve(ROOT, 'lib/studio.js'), 'utf8')
              const srvC = await readFile(resolve(ROOT, 'bin/rm-studio.mjs'), 'utf8')
              /*
               * Drafting a scene is one completion, not an agent.
               *
               * It used to read SCENE.md, the 470 lines of rm-video.js and design.md, then
               * write the file — with edit permissions and a streaming session — to produce
               * twenty lines of markup against a fixed vocabulary. The vocabulary IS the
               * contract and is already parsed for the palette; inline it is under a kilobyte.
               */
              check('a draft uses no tools', /"--allowedTools", ""/.test(srvC) && /"--output-format", "text"/.test(srvC))
              check('and a small model', /"--model", "haiku"/.test(srvC))
              // A fence, an apology or an invented tag all render as nothing.
              check('only known elements survive a draft', /no usable elements/.test(srvC))
              /*
               * Compose takes scenes off a shelf instead of opening a second element editor
               * inside a panel about running order.
               */
              check('compose has a shelf of saved scenes', /const fillShelf = async \(\)/.test(uiC) && /to the running order/.test(uiC))
              // A segment references the file, so editing a scene updates every composition
              // using it and rm-compose reads it fresh at render time.
              check('a scene segment references its file', /bodyFile: sc\.file/.test(uiC) && /file: join\(dir, f\)/.test(srvC))
              check('and the running order takes a drop', /text\/rm-scene/.test(uiC))

              check('a scene can be authored as markup', /body: authored/.test(comp) && /seg\.bodyFile/.test(cli))
              // The wrapper owns the harness — faces, stage, no-scroll, RM.ready — because
              // an author reproducing it will get one wrong silently.
              check('the wrapper still supplies the harness', /brand\/fonts\/fonts\.css/.test(comp) && /RM\.ready\(\)/.test(comp))
              // rm-scene appends .jpg and resolves against the page URL, so a caller-built
              // path was right for a render and 404'd in preview.
              check('the wallpaper resolves against the right base', /wallpaper\.includes\("\/"\)/.test(comp))
              const ui2 = await readFile(resolve(ROOT, 'lib/studio.js'), 'utf8')
              const srvSrc = await readFile(resolve(ROOT, 'bin/rm-studio.mjs'), 'utf8')
              // srcdoc and blob: both give an opaque origin with no base, so nothing loads.
              check('the preview is served from this origin', /api\/scene\/preview/.test(srvSrc) && !/URL\.createObjectURL/.test(ui2))
              // Declared inside the handler, every request built a fresh empty Map.
              check('previews outlive the request that made them', /^const previews = new Map\(\);$/m.test(srvSrc))
              // The contract is what decides whether an authored scene renders correctly.
              const contract = await readFile(resolve(ROOT, 'skill/hyperframes-brand/SCENE.md'), 'utf8')
              check('the contract forbids self-advancing motion', /requestAnimationFrame/.test(contract) && /seeked, not played/i.test(contract))
              check('and says what not to wrap', /Do not write `<!doctype>`/.test(contract))

              // A stale duration puts every later segment at the wrong time.
              check('footage is measured, not trusted', /ffprobe/.test(cli) && /could not read a duration/.test(cli))
              // A capture is usually silent, so a composition made from one is valid and
              // inaudible — which reads as the render losing the audio.
              check('narration can be laid over a composition', /amix=inputs=2:duration=first/.test(cli) && /spec\.audio/.test(cli))
              // Ducked, not muted: a click a narrator is talking about should survive.
              check('footage sound is ducked, not dropped', /FOOTAGE_UNDER_VOICE = 0\.35/.test(cli))
              // amix divides by input count unless told otherwise, halving the voice.
              check('the mix does not halve the voice', /normalize=0/.test(cli))
              // The picture is not stretched to fit a voice track of a different length.
              check("the video's length stays authoritative", /duration=first/.test(cli))
              // v2 names one file; the first version put the rest in a key nothing reads,
              // so a composition opened as a silent title card.
              check('the segments become one video', /concat=n=\$\{pieces\.length\}:v=1:a=1/.test(cli))
              // Not `!/appendClips/`: the comment explaining why that key was removed is
              // worth keeping, so this looks for the property rather than the word.
              check('the document names that one video', /screenVideoPath: video/.test(comp) && !/appendClips:/.test(comp))
              // Every rendered title came out in the platform fallback face.
              check('a scene loads the brand faces', /brand\/fonts\/fonts\.css/.test(comp))
              // The spec is the only thing that makes a composition editable again.
              const srv = await readFile(resolve(ROOT, 'bin/rm-studio.mjs'), 'utf8')
              check('the composition is kept beside its render', /composition\.json/.test(srv))
              /*
               * Footage is named by its place in the project, never by a path.
               *
               * A catalogue entry carries `rel` and no absolute path, so the panel had
               * nothing to put in `seg.path` and sent undefined — which resolved to the
               * working directory and came back 403, so every composition containing
               * footage failed on what looked like a security refusal. Resolving `rel`
               * against the project's own media directory is the fix and the check at once:
               * there is nowhere else it can land.
               */
              check('named footage stays inside the library', /join\(mediaDir\(id\), String\(seg\.rel\)\)/.test(srv) && /outside \$\{LIB\}: \$\{seg\.rel \?\? seg\.path\}/.test(srv))
              // And the cut resolves it the same way, rather than inventing a second rule.
              check('a cut names its footage the same way', /join\(mediaDir\(id\), String\(c\.rel \?\? ""\)\)/.test(srv))
              check('the panel is routed, labelled and iconed', /compose: vCompose/.test(ui) && /compose: 'Compose'/.test(ui) && /compose: 'film-01'/.test(ui))
            }

            check('the brief is written beside the script', /join\(dir, `\$\{nm\}\.brief\.json`\)/.test(srv))
            // The assembly rules will change; a redo should show what was actually asked.
            check('it records the prompt as well as the inputs', /prompt,\n\s*drafted: new Date\(\)\.toISOString\(\)/.test(srv))
            check('and which project it was drafted for', /projectId: id,/.test(srv))
            // Hand-written scripts have no brief and never will.
            check('a missing brief is normal, not an error', /\.catch\(\(\) => null\)/.test(srv) && /brief,/.test(srv))
            /*
             * A redo is loading the card, now that there is one form.
             *
             * There used to be a "Redo this brief" button on each card, which put the
             * inputs back into a SECOND form higher up the page — and a card click
             * that opened a separate editor screen, so the two had to be told apart
             * with stopPropagation. One form removes the distinction: clicking a saved
             * script loads its body and its brief into the form you are already
             * looking at.
             */
            check('a drafted script can be redone', /const load_ = \(sc\) =>/.test(ui) && /seconds\.value = sc\.brief\.seconds/.test(ui))
            // Setting .value fires no input event, so the chips would show the old brief.
            check('redo repaints the highlight layer', /about\.dispatchEvent\(new Event\('input'/.test(ui))
          }

          /*
           * A drafted script keeps the brief that produced it.
           *
           * The prompt was assembled at request time, handed to Claude and thrown away, so
           * once the script existed the inputs were gone — "same idea, one change" meant
           * retyping the brief from memory and hoping it matched.
           */
          {
            const srv = await readFile(resolve(ROOT, 'bin/rm-studio.mjs'), 'utf8')
            const ui = await readFile(resolve(ROOT, 'lib/studio.js'), 'utf8')
            // Inside the project, so it travels, syncs and diffs with everything else.
            check('the brief is written beside the script', /join\(dir, `\$\{nm\}\.brief\.json`\)/.test(srv))
            check('and the project README says what it is', /can be redone/.test(srv))
            // The assembly rules will change; a redo should show what was actually asked.
            check('it records the prompt as well as the inputs', /prompt,\n\s*drafted: new Date\(\)\.toISOString\(\)/.test(srv))
            check('and which project it was drafted for', /projectId: id,/.test(srv))
            // Hand-written scripts have no brief and never will.
            check('a missing brief is normal, not an error', /\.brief\.json`\), "utf8"\)\n\s*\.then\(JSON\.parse\)\n\s*\.catch\(\(\) => null\)/.test(srv))
            /*
             * A redo is loading the card, now that there is one form.
             *
             * There used to be a "Redo this brief" button on each card, which put the
             * inputs back into a SECOND form higher up the page — and a card click
             * that opened a separate editor screen, so the two had to be told apart
             * with stopPropagation. One form removes the distinction: clicking a saved
             * script loads its body and its brief into the form you are already
             * looking at.
             */
            check('a drafted script can be redone', /const load_ = \(sc\) =>/.test(ui) && /seconds\.value = sc\.brief\.seconds/.test(ui))
            // Setting .value fires no input event, so the chips would show the old brief.
            check('redo repaints the highlight layer', /about\.dispatchEvent\(new Event\('input'/.test(ui))
          }

          check('a dangling document is repaired on open', /const repairDocumentMedia = async \(docPath\)/.test(srv))
          // A sibling of the document only — same directory, same basename. Anything
          // looser would invent an association between a document and someone's video.
          check('it only ever repairs to a sibling', /join\(dirname\(docPath\), stem \+ ext\)/.test(srv))
          // Present media is left alone; a repair must not rewrite a working document.
          // Readable media is left alone; a repair must not rewrite a working document.
          check('a working document is untouched', /if \(await playable\(current\)\) return \{ repaired: false, reason: null \};/.test(srv))
          check('an unrepairable one is reported, not blanked', /the video it names is gone/.test(srv))
          /*
           * Present is not playable. An interrupted encode leaves ftyp and mdat with no
           * moov atom — ffmpeg writes the index last — so the file exists, has size, and
           * no demuxer can open it. The editor's report is
           * "MEDIA_ERR_SRC_NOT_SUPPORTED (4) — DEMUXER_ERROR_COULD_NOT_OPEN", which names
           * neither the file nor the cause and reads as the editor being broken.
           */
          check('a present but unreadable video is caught', /const playable = async \(file\)/.test(srv) && /if \(await playable\(current\)\)/.test(srv))
          check('and says the render was interrupted', /interrupted before it finished writing/.test(srv))
          // Repairing to an equally broken sibling would just move the failure.
          check('the sibling it repairs to is checked too', /await playable\(sibling\)/.test(srv))
          // Caught at the encode, not days later in the editor.
          const composeCli = await readFile(resolve(ROOT, 'bin/rm-compose.mjs'), 'utf8')
          check('our own encodes are verified', /async function assertPlayable/.test(composeCli) && /did not finish writing/.test(composeCli))
          // Checked before the hand-over: once the editor has the document, the Studio
          // is no longer the thing on screen and cannot say anything about it.
          check('and the Studio stops before swapping the view', /if \(r\.mediaProblem\) return \{ \.\.\.r, error: r\.mediaProblem \}/.test(ui))
        }

        check('the install is shared, not duplicated', /installWallpapersIntoFork/.test(srv) && /installWallpapersIntoFork/.test(mk) && /export async function installWallpapersIntoFork/.test(inst))
        check('saving a wallpaper installs it', /installWallpapersIntoFork\(\{ recipes: all/.test(srv))
        // The manifest is compiled in, so the running editor is a rebuild behind.
        check('and says a rebuild is needed', /rebuild OpenScreen to see it in the picker/.test(srv))
        // A missing fork is not an error — the toolkit works without it beside us.
        check('a missing checkout is reported, not thrown', /reason: `no OpenScreen checkout at \$\{fork\}`/.test(inst))
        // sips is macOS-only; a thumb that fails leaves the picker slow, not broken.
        check('a thumb failure is survivable', /} catch \{\n\t\t\t\/\* no sips/.test(inst))
      }

      /*
       * Staged render assets are not the project's media.
       *
       * A render stages its own copy of the brand so it can work offline, and that
       * copy sat in `Renders/<name>/assets/` where the catalog walked it like anything
       * else — so every render added its staged pictures to the project's own still
       * count. Staging the clay imagery turned one stray picture per render into
       * twelve, which is how it got noticed.
       */
      {
        const lib = await readFile(resolve(ROOT, 'lib/library.mjs'), 'utf8')
        const stage = await readFile(resolve(ROOT, 'lib/render-assets.mjs'), 'utf8')
        // A marker, not a path rule: `assets/` is a name somebody may use for their
        // own material, and a directory that says it is generated cannot be mistaken.
        /*
         * The brand's constraints reach the composer, not just this repo.
         *
         * The composition skill reads design.md, which the brand repo generates — so a
         * rule added only to SKILL.md binds nobody at the moment a video is made. These
         * check the two say the same thing, and that the pair a model actually breaks
         * are both present.
         */
        {
          const skill = await readFile(resolve(ROOT, 'skill/hyperframes-brand/SKILL.md'), 'utf8')
          const RULES = ['No radial gradients', 'No frame wipes', 'No decorative rules', 'An edge is a solid border', 'No ornament']
          check(
            'the skill carries every constraint',
            RULES.every((r) => skill.includes(r)),
            RULES.filter((r) => !skill.includes(r)).join(', '),
          )
          // "An edge is a solid border" reads as permission on its own; the qualifier is
          // what stops it being quoted back as a reason to add one.
          check('the edge rule is not read as licence', /it is not licence to add one/.test(skill))
        }

        check('a marked directory is not indexed', /IGNORE_MARKER = "\.rmignore"/.test(lib) && /entries\.some\(\(e\) => e\.isFile\(\) && e\.name === IGNORE_MARKER\)\) return;/.test(lib))
        check('staging writes the marker', /join\(assetsDir, IGNORE_MARKER\)/.test(stage))
        // The two must agree on the name, or staging marks what walking ignores.
        check('both sides share one marker name', /import \{ IGNORE_MARKER \} from "\.\/library\.mjs"/.test(stage))

        // The real check: stage a render and confirm the walker sees no picture.
        const { stageRenderAssets } = await import(resolve(ROOT, 'lib/render-assets.mjs'))
        const { walk } = await import(resolve(ROOT, 'lib/library.mjs'))
        const { mkdtemp, rm: rmDir } = await import('node:fs/promises')
        const { tmpdir } = await import('node:os')
        const { join: joinPath } = await import('node:path')
        const dir = await mkdtemp(joinPath(tmpdir(), 'rm-stage-'))
        try {
          await stageRenderAssets(dir, { brand: 'rolemodel', quiet: true })
          const seen = []
          for await (const f of walk(dir)) seen.push(f.rel)
          const pictures = seen.filter((f) => /\.(jpg|jpeg|png|webp|svg)$/i.test(f))
          check('a staged render contributes no stills', pictures.length === 0, pictures.join(', '))
        } finally {
          await rmDir(dir, { recursive: true, force: true })
        }
      }

      check('the clay renders are vendored', idx.imagery.filter((i) => i.file).length >= 10)
      /*
       * Vendoring must never overwrite a retouched file.
       *
       * These get edited here — backgrounds cut out, which the source renders do not
       * have — and the first version treated any difference from the source as
       * staleness and copied over the top, destroying that work twice in one session.
       * The second attempt recorded the hash of what it wrote and compared against
       * that, which is poisonable: seeding it from the files already on disk marked
       * the edits as ours and replaced them a third time.
       *
       * The source hash is the only value that cannot be poisoned — a copy is
       * byte-identical to its source, so anything else on disk is somebody's work.
       */
      const mkImg = await readFile(resolve(ROOT, 'lib/make-imagery.mjs'), 'utf8')
      check('an edit is detected against the source hash', /const edited = Boolean\(before && localSha !== srcSha\);/.test(mkImg))
      check('and is kept rather than overwritten', /if \(edited && !FORCE\) \{/.test(mkImg) && /kept\.push\(want\.name\)/.test(mkImg))
      check('only --force discards it', /const FORCE = argv\.includes\("--force"\)/.test(mkImg))
      // A retouched export saved under its own name was deleted as an "orphan".
      check('it only removes files it wrote', /ours\.has\(f\) && !keep\.has\(f\)/.test(mkImg))
      // Two source filenames are misspelled ("Acadmey"); asking for that spelling
      // forever is worse than renaming once on the way in.
      check(
        'names are normalised on the way in',
        idx.imagery.every((i) => /^[a-z0-9-]+$/.test(i.name)),
      )
      // A missing render is recorded, never substituted — a plant is not a rocket.
      check('a missing image is null, not a stand-in', /missing\.push\(want\.name\)/.test(mk) && /file: null/.test(mk))
      const stage = await readFile(resolve(ROOT, 'lib/render-assets.mjs'), 'utf8')
      check('they are staged into a render', /assets", "imagery"/.test(stage))
      const ui = await readFile(resolve(ROOT, 'lib/studio.js'), 'utf8')
      check('and the Brand page shows them', /brand\/imagery\/\$\{item\.file\}/.test(ui))
    }

    check('steps can be written into the script', /Insert steps into the script/.test(ui) && /function mergeStepsIntoScript/.test(ui))
    // Directives are settings; the body is generated. Losing them was the reason
    // "clear the script" was never an acceptable escape.
    check('merging keeps the directive lines', /head\.join\('\\n'\) \+ '\\n\\n' \+ body/.test(ui))
    // Same shape lib/script-parse.mjs skips by, so the two cannot disagree.
    check('a directive is recognised by shape', /\^\\s\*\\\/\[a-z\]\[a-z-\]\*\(\\s\|\$\)/.test(ui))
    // Inserting hands control back, or the next step edit would be ignored again.
    check('inserting clears the hand-edited latch', /script\.value = mergeStepsIntoScript[\s\S]{0,200}?handEdited = false/.test(ui))
    // The builder held its rows privately; compiling them needed a way to read them.
    check('the builder exposes its rows', /rows: \(\) => rows\.map/.test(ui))
    check('the hint names the button instead of saying to delete the script', /Insert steps into the script" when you want them in/.test(ui) && !/Clear the script to hand control back/.test(ui))
  }

  check('it refuses a script with no actions', /needs a \`\`\`do block/.test(setup))
  check('the script is saved into the project', /\$\{slug\}\.demo\.md/.test(setup))
  check('and it says where the trace will be', /trace: join\(dir, `\$\{slug\}\.zip`\)/.test(setup))

  check('the panel checks as you type', /demoBody\.oninput = recheck/.test(ui) && /DEMO_CHECK_MS/.test(ui))
  check('problems are shown per line', /d\.problems\.join\(' · '\)/.test(ui))
  // A demo that failed must not leave a trace path behind as though it worked.
  check('a failed demo does not fill the trace field', /the Trace field was left alone/.test(ui))
  check('a successful one does', /trace\.value = r\.trace/.test(ui))
}

console.log('\nmedia paths')
{
  // The client built `<library>/<id>/<rel>` for a media file and got "no such
  // file" for something plainly on disk: catalog paths are relative to the
  // project's `media/` directory, and the thumbnail route had always resolved
  // them that way. So the server resolves, and the client sends what it actually
  // knows — the project and the relative path.
  const srv = await readFile(resolve(ROOT, 'bin/rm-studio.mjs'), 'utf8')
  const ui = await readFile(resolve(ROOT, 'lib/studio.js'), 'utf8')

  check('the server resolves media paths', /function requestedPath/.test(srv) && /join\(mediaDir\(String\(body\.projectId\)\), String\(body\.rel\)\)/.test(srv))
  check('delete uses it', /const target = requestedPath\(body\)/.test(srv))
  check('open-media uses it', /const media = requestedPath\(body\)/.test(srv))
  // The client must not be building media paths any more, in either caller.
  const built = [...ui.matchAll(/libraryRoot \+ '\/' \+ project\.id \+ '\/' \+ f\.rel/g)].length
  check('the client no longer guesses the layout', built === 0, built ? `${built} hand-built media paths remain` : '')
  check('it sends project and rel instead', /projectId: project\.id,\s*\n\s*rel: f\.rel/.test(ui) || /\{ projectId: project\.id, rel: f\.rel \}/.test(ui))
  // `join` normalises, so a `..` cannot climb out unseen — but only because the
  // containment check runs on the resolved path. Assert both halves.
  check('containment runs after resolution', /const target = requestedPath\(body\);\s*\n\s*const inside/.test(srv))
}

console.log('\none way in')
{
  // Setting this up was twenty commands across four repositories in an order you
  // had to know, which is not a setup, it is a quiz.
  const sh = await readFile(resolve(ROOT, 'install.sh'), 'utf8')
  const readme = await readFile(resolve(ROOT, 'README.md'), 'utf8')

  check('the README leads with one command', /curl -fsSL .*install\.sh \| sh/.test(readme.slice(0, 900)))
  check('that file exists and is executable', existsSync(resolve(ROOT, 'install.sh')))
  // Piping a script to sh that silently takes a password is a script nobody
  // should pipe to sh.
  check('it never installs Homebrew behind your back', /Homebrew is not installed, and it needs your password/.test(sh))
  // Every step checks first, so a second run only does what the first could not.
  check('it is safe to run twice', (sh.match(/if (have|brew (tap|list))/g) || []).length >= 5)
  // The cask cannot be a formula dependency until the fork has cut a release, or
  // neither installs.
  check('a missing cask does not fail the whole install', /the cask is not installable yet/.test(sh))
  check('it hands the rest to rm-setup', /rm-setup/.test(sh) && !/kokoro|virtualenv --/i.test(sh))
  check('and it refuses a platform it cannot serve', /ScreenCaptureKit/.test(sh))

  // One source of truth for packaging. The tap exists only because Homebrew
  // resolves `rolemodel/tap` to a repo named homebrew-tap; it is a build output.
  const sync = await readFile(resolve(ROOT, 'lib/sync-tap.mjs'), 'utf8')
  check('packaging lives in this repo', existsSync(resolve(ROOT, 'packaging/rm-video.rb')))
  check('nothing else carries a second copy', !existsSync(resolve(ROOT, 'Formula/rm-video.rb')))
  check('the tap is a publish target', /LAYOUT/.test(sync) && /Formula\/rm-video\.rb/.test(sync))
  check('drift is a build failure, not a surprise', /--check/.test(sync) && /the tap is out of date/.test(sync))

  // rm-setup has to install the fork, because no other build has the verb.
  const setup = await readFile(resolve(ROOT, 'bin/rm-setup.mjs'), 'utf8')
  check("setup installs the fork's cask", /rolemodel\/tap\/rolemodel-openscreen/.test(setup))
  check('and checks for the verb, not the tap', /openscreen\\s\+open\\s\+</.test(setup))
  check('OpenFrame is optional, not required', /OpenFrame \(optional/.test(setup))

  // One command fetches the forks, and it does not assume their default branch.
  // OpenFrame's is `master`, which turned "0 behind" into a git error on stderr
  // and a pair of question marks — a wrong answer delivered confidently.
  const forks = await readFile(resolve(ROOT, 'lib/forks.mjs'), 'utf8')
  check('one command fetches the forks', /npm run forks/.test(forks) && /git", \["clone"/.test(forks))
  check('it adds the upstream remote for you', /"remote", "add", "upstream"/.test(forks))
  check('and asks which branch upstream calls default', /symbolic-ref", "refs\/remotes\/upstream\/HEAD"/.test(forks))
  check('a missing ref reports unknown, not a git error', !/try \{\s*ahead = git\(/.test(forks))
  // Reporting is safe; merging somebody's checkout for them is not.
  check('it never moves a checkout it did not create', !/"checkout"|"merge"|"reset"/.test(forks))

  // Xcode reads like a much bigger requirement than it is, and conflating it with
  // Command Line Tools is how it gets that reputation. Nothing an installed
  // pipeline runs needs either; only building the capture helper needs Xcode.
  check('nothing in the install path mentions Xcode', !/xcode/i.test(sh))
  check('setup asks for Command Line Tools, not Xcode', /Command Line Tools/.test(setup) && /NOT full Xcode/.test(setup))
  check('and that step is optional', /Command Line Tools[\s\S]{0,200}required: false/.test(setup))
  const kickoff = await readFile(resolve(ROOT, 'docs/KICKOFF.md'), 'utf8')
  check('the docs separate the three cases', /Do I need Xcode\?/.test(kickoff) && /built in CI/.test(kickoff))
}

console.log('\nsharing for review')
{
  // The pipeline could make a video and never deliver it. Sending an mp4 by email
  // gets feedback as prose — "around the middle, the bit with the railing" — which
  // is the most expensive way to receive a note.
  const of = await import('./openframe.mjs')
  const src = await readFile(resolve(ROOT, 'lib/openframe.mjs'), 'utf8')

  // A share link is outward-facing; guessing the instance is not a mistake worth
  // making quietly.
  let threw = null
  try {
    of.openFrame({ token: 'x'.repeat(30) })
  } catch (err) {
    threw = err
  }
  check('it refuses to guess the instance', threw?.name === 'OpenFrameError', String(threw?.message).slice(0, 60))
  threw = null
  try {
    of.openFrame({ base: 'http://x' })
  } catch (err) {
    threw = err
  }
  check('and refuses to run without a token', threw?.name === 'OpenFrameError')

  // An HTML body from a 401 or a proxy is the usual failure, and "unexpected
  // token <" is a worse message than the first line of the page.
  const fake = async () => new Response('<!DOCTYPE html>\n<title>Nope</title>', { status: 401 })
  const api = of.openFrame({ base: 'http://x', token: 't'.repeat(30), fetchImpl: fake })
  const caught = await api.call('/api/workspaces').then(
    () => null,
    (e) => e,
  )
  check('a non-JSON reply is explained', /returned 401, not JSON/.test(String(caught?.message)), String(caught?.message).slice(0, 70))

  // Uploads stream from disk rather than buffering a render into memory, and
  // undici needs duplex for that — an omission that only fails on large files.
  check('the upload streams from disk', /createReadStream\(file\)/.test(src) && /duplex: "half"/.test(src))
  // A multipart requirement handled wrong produces a truncated video silently.
  check('it refuses a multipart upload rather than truncating', /init\.multipart/.test(src) && /does not do yet/.test(src))
  check('every route unwraps `data` once', /json\?\.data \?\? json/.test(src))
  // Re-sharing into the same project must not make a second one.
  check('an existing project is reused', /\.find\(\(p\) => p\.name === name\)/.test(src))

  /*
   * A watch URL composed by hand is a dead link.
   *
   * /watch/<id> carries no share token, so OpenFrame's watch API finds no
   * share-session cookie and answers 403 — the page reads "Video not found or
   * access denied". The token only arrives as ?shareToken=, which /watch then
   * strips into an httpOnly cookie, so the URL visible after the redirect is
   * never the URL to send. Only `shareUrl` off the share endpoint is a link.
   *
   * It stayed broken because it works for the person who uploaded the video: a
   * signed-in project member passes checkProjectAccess and never needs a token.
   */
  const srvSrc = await readFile(resolve(ROOT, 'bin/rm-studio.mjs'), 'utf8')
  const uiSrc = await readFile(resolve(ROOT, 'lib/studio.js'), 'utf8')
  // Comments off first — all three files explain the trap, and the explanation
  // necessarily spells out the shape it is warning about.
  const code = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const composed = (t) => /\/watch\/\$\{/.test(code(t))
  check('no watch url is composed by hand', !composed(src) && !composed(srvSrc) && !composed(uiSrc))
  check("only the share endpoint's url is handed out", /shareUrl: link\.shareUrl/.test(src) && !/watchUrl/.test(code(src)))
  // POST rotates the token on an existing link, so reading one with POST breaks
  // every link already sent for that video.
  check('an existing link is read, not rotated', /async function shareLink/.test(src) && /POST rotates the token/.test(src))
  check('the studio resolves a link before opening', /p === "\/api\/review\/link"/.test(srvSrc) && /\.shareLink\(projectId, videoId\)/.test(srvSrc))
  check('and the listing carries ids, not links', /projectId: proj\.id/.test(srvSrc))
  check('the button asks for it on click', /api\/review\/link\?project=/.test(uiSrc))
  // "No link yet" is a real state — the video was uploaded but never shared.
  check('and says so when there is none', /No share link yet/.test(uiSrc))

  const pkg = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8'))
  check('rm-share ships as a binary', pkg.bin?.['rm-share'] === './bin/rm-share.mjs')
  check('and the job runner will run it', /"rm-share"/.test(await readFile(resolve(ROOT, 'lib/jobs.mjs'), 'utf8')))
}

console.log('\nconfigurable and importable')
{
  const srv = await readFile(resolve(ROOT, 'bin/rm-studio.mjs'), 'utf8')
  const ui = await readFile(resolve(ROOT, 'lib/studio.js'), 'utf8')

  // Configuration only a shell can supply is configuration nobody can set: a GUI
  // launched from Finder inherits no shell environment, and the Studio it hosts
  // inherits that, so Review could report "not configured" for ever.
  const settings = await import('./settings.mjs')
  check('settings prefer the environment', /process\.env\.OPENFRAME_URL/.test(await readFile(resolve(ROOT, 'lib/settings.mjs'), 'utf8')))
  check('and fall back to a file', /openframeUrl/.test(await readFile(resolve(ROOT, 'lib/settings.mjs'), 'utf8')))
  check('a credential is written 0600', /mode: 0o600/.test(await readFile(resolve(ROOT, 'lib/settings.mjs'), 'utf8')))
  check('a url without a scheme is refused', Boolean(settings.settingProblem({ url: 'localhost:3100' })))
  check('and the reason says what is wrong', /http or https/.test(settings.settingProblem({ url: 'localhost:3100' })))
  check('a short token is refused with its length', /is 5 characters/.test(settings.settingProblem({ token: 'short' }) ?? ''))
  check('a real pair is accepted', settings.settingProblem({ url: 'http://localhost:3100', token: 't'.repeat(30) }) === null)
  // Write-only: a panel that shows you your own credential shows it to the room.
  const setRoute = srv.slice(srv.indexOf('p === "/api/review/settings"'), srv.indexOf('p === "/api/review/send"'))
  check('the settings route never returns the token', !/token:/.test(setRoute) || /ok: true, stored: file/.test(setRoute))
  check('the panel can connect itself', /api\/review\/settings/.test(ui) && /'Connect'/.test(ui))

  // Recording and scripting both make video; there was no way to use video that
  // already existed, which is most of it.
  const imp = srv.slice(srv.indexOf('p === "/api/import"'), srv.indexOf('p === "/api/documents"'))
  check('importing exists', imp.length > 400, `${imp.length} chars`)
  check('it copies rather than moves', /copyFile\(src, dest\)/.test(imp) && !/rename\(src/.test(imp))
  check('the destination follows the file type', /Footage/.test(imp) && /Audio/.test(imp) && /Stills/.test(imp))
  check('an unhandled type is refused by name', /is not media this pipeline handles/.test(imp))
  // Two takes with the same name is normal; losing the first one is not.
  check('it never overwrites what is already there', /while \(await stat\(dest\)/.test(imp))
  check('and says when it renamed something', /renamed:/.test(imp) && /something was already called that/.test(ui))
  check('the project page offers it', /api\/import/.test(ui) && /Add to this project/.test(ui))
}

console.log('\nhow you start it')
{
  /*
   * Five places told a new user to run `rm-studio` and open :4600.
   *
   * Both halves are wrong now. The Studio is a window in the app — main.ts opens
   * it right after the first window — and the port is whatever was free, because
   * electron/studio/server.ts calls freePort(). Worse, following that instruction
   * is the one way to break recording: macOS grants Screen Recording to whatever
   * binary hosts Electron, so launching from a shell grants it to the terminal and
   * the recorder then fails looking like a bug.
   *
   * `rm-studio` and :4600 are still real and still the way to work ON the Studio,
   * so the rule is not "never mention them" — it is that every mention has to be
   * marked as the developer path. Which is exactly the distinction the docs lost.
   */
  const files = ['README.md', 'docs/KICKOFF.md', 'install.sh', 'packaging/rm-video.rb']
  const texts = Object.fromEntries(await Promise.all(files.map(async (f) => [f, await readFile(resolve(ROOT, f), 'utf8')])))

  const unmarked = []
  for (const [f, text] of Object.entries(texts)) {
    for (const m of text.matchAll(/4600/g)) {
      const near = text.slice(Math.max(0, m.index - 400), m.index + 400)
      if (!/developer|DEVELOPMENT\.md/.test(near)) unmarked.push(`${f}@${m.index}`)
    }
  }
  check('every mention of :4600 is marked as the developer path', unmarked.length === 0, unmarked.join(', '))

  // The instruction a first-time reader follows has to name the app, in the two
  // places they actually read: the README's install block and the script's last line.
  check('the README says to open the app', /open \*\*RoleModel Studio\*\*/.test(texts['README.md']))
  check('and install.sh finishes by naming it', /RoleModel Studio/.test(texts['install.sh']))

  // The permission trap, said where someone is about to fall into it. This is not
  // a nicety: a wrong grant is invisible until a capture produces a black frame.
  for (const f of ['README.md', 'docs/KICKOFF.md', 'install.sh', 'packaging/rm-video.rb']) {
    check(`${f} warns about launching from a terminal`, /terminal/i.test(texts[f]) && /Screen Recording/i.test(texts[f]))
  }
}

console.log('\ndocs')
{
  // Docs that describe a system nobody can hold in their head have to be
  // mechanically checked, or they become a confident description of last month.
  const dev = await readFile(resolve(ROOT, 'docs/DEVELOPMENT.md'), 'utf8')
  const kickoff = await readFile(resolve(ROOT, 'docs/KICKOFF.md'), 'utf8')
  const pkg = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8'))

  // The assertion count is quoted in the dev guide, and a stale number there is
  // the most quietly misleading thing a doc about testing can contain.
  const quoted = /single file of ([0-9]+)\s*\n?assertions/.exec(dev)?.[1] ?? /([0-9]+) assertions/.exec(dev)?.[1]
  check('the dev guide quotes a plausible assertion count', Number(quoted) > 300, `says ${quoted}`)
  // `npm run build` exists and builds assets, so "no build step" was wrong.
  check('it does not claim there is no build script', !/There is no build step/.test(dev))
  check('and says what npm run build actually does', /builds \*assets\*, not code/.test(dev))
  check(
    'every script it names exists',
    ['dev', 'check', 'verify', 'forks', 'sync-docs'].every((k) => pkg.scripts[k]),
  )
  // The seam table is the answer to "can I take just one piece".
  const seams = ['wallpaper', 'demo-script', 'demo-record', 'openframe', 'narration', 'theme', 'script-parse']
  check(
    'every module in the seam table exists',
    seams.every((m) => existsSync(resolve(ROOT, `lib/${m}.mjs`))),
    seams.filter((m) => !existsSync(resolve(ROOT, `lib/${m}.mjs`))).join(', '),
  )
  check(
    'the seam table lists them all',
    seams.every((m) => dev.includes(`lib/${m}.mjs`)),
  )

  // The Docusaurus site is a build output of docs/, like the tap is of packaging/.
  const sync = await readFile(resolve(ROOT, 'lib/sync-docs.mjs'), 'utf8')
  check('docs sync to the site', /docs\/rolemodel/.test(sync) && Boolean(pkg.scripts['sync-docs']))
  // MDX is not Markdown: an autolink parses as a JSX tag and fails the build.
  check('autolinks are rewritten for MDX', /mailto\)\:\[\^>\\s\]\+\)>/.test(sync) || /https\?\|mailto/.test(sync))
  check('code spans are left alone', /i % 2 === 1 \? chunk/.test(sync))
  // A relative link resolved against the URL, not the file, broke the build.
  check('cross-links point at files', /\$\{other\.slug\}\.md/.test(sync))
  check('drift fails the build', /--check/.test(sync) && /the docs site is out of date/.test(sync))
  // KICKOFF is the entry point and has to say so somewhere findable.
  check('the README points at the runbook', /docs\/KICKOFF\.md/.test(await readFile(resolve(ROOT, 'README.md'), 'utf8')))
  check('the runbook points at the dev guide', /DEVELOPMENT\.md/.test(kickoff))
}

console.log('\nediting and reviewing')
{
  // Both capabilities existed and neither had a surface. The editor was reachable
  // only by clicking a video — nothing in the Studio said it existed — and
  // sharing was CLI-only, which put the step that decides whether a video ships
  // outside the tool that makes it.
  const srv = await readFile(resolve(ROOT, 'bin/rm-studio.mjs'), 'utf8')
  const ui = await readFile(resolve(ROOT, 'lib/studio.js'), 'utf8')
  const html = await readFile(resolve(ROOT, 'lib/studio.html'), 'utf8')

  // New project is reached from the page that lists projects, not from the nav.
  // Removing the nav item without that tile would strand the form entirely.
  // Without the nav item, the trail is the only thing saying where this page sits.
  check('and it says it belongs to the Library', /const PARENT_VIEW = \{ new: 'library' \}/.test(ui) && /go: \(\) => go\(parent\)/.test(ui))
  check('a project is started from the Library', /add\.onclick = \(\) => go\('new'\)/.test(ui) && !/data-v="new"/.test(html))

  check('both surfaces are in the nav', /data-v="editor"/.test(html) && /data-v="review"/.test(html))
  check('and both are routed', /editor: vEditor/.test(ui) && /review: vReview/.test(ui))
  check('with breadcrumb labels', /editor: 'Editor'/.test(ui) && /review: 'Review'/.test(ui))

  // Documents are not in the catalog and should not be — buildCatalog indexes
  // media, and a document is the edit. Inferring it client-side reported "no
  // document yet" for every video in the library, including ones sitting next to
  // a document.
  check('documents come from the server', /p === "\/api\/documents"/.test(srv) && /fetch\('\/api\/documents'\)/.test(ui))
  check('the catalog is not asked for them', !/catalog[^\n]*\.openscreen/.test(ui))

  // Configuration is reported, not assumed: an unset token and an unreachable
  // instance need different fixes, and "sharing is broken" is neither.
  const review = srv.slice(srv.indexOf('p === "/api/review"'), srv.indexOf('p === "/api/review/send"'))
  // It reports which piece is missing, and where the ones it has came from —
  // "not configured" and "configured in a shell you are not in" look identical
  // from the app and need different fixes.
  check('review reports what is missing', /configured: false/.test(review) && /missing: \[/.test(review))
  check('and where a present setting came from', /source/.test(review))
  check('and reports an unreachable instance separately', /configured: true, base, error: err\.message/.test(review))
  check('sending stays inside the library', /startsWith\(LIB \+ sep\)/.test(srv.slice(srv.indexOf('p === "/api/review/send"'))))
  /*
   * Copying goes through the host, not the Clipboard API.
   *
   * main.ts installs a permission allowlist of media and capture only, so
   * `navigator.clipboard.writeText` is denied for every page the app loads and
   * rejects with "Write permission denied" — all three copy buttons were dead.
   * Worse, each swallowed the rejection and set its label to "Copied" anyway, so
   * the failure was invisible. Confirmed by real-clicking the button in a running
   * build: label "Copied", clipboard call "THREW NotAllowedError".
   */
  check('the panel offers a copyable link', /copyButton\(el\('button', 'btn ghost', 'Copy link'\), 'Copy link', r\.shareUrl\)/.test(ui))
  check('copying goes through the host', /window\.rmStudio\?\.copyText/.test(ui))
  check('and the browser API is only the fallback', (ui.match(/navigator\.clipboard/g) || []).length === 3)
  // A label that says Copied when nothing was copied is worse than no button.
  check('a failed copy says so', /btn\.textContent = err \? 'Copy failed' : 'Copied'/.test(ui))
  // Anything that has to fetch the value first has already spent its activation.
  check('nothing copies without a value', /if \(text == null\) return/.test(ui))
  if (HAVE_OS) {
    const mainSrc = await src('electron/main.ts')
    const preSrc = await src('electron/studio-preload.ts')
    check('the host puts it on the clipboard', /ipcMain\.handle\("studio:copy-text"/.test(mainSrc) && /clipboard\.writeText\(value\)/.test(mainSrc))
    // Same rule as every other studio channel: only that window may use it.
    check('and only for the Studio window', /if \(!fromStudio\(event\)\) return \{ ok: false, error: "only the Studio window can copy" \}/.test(mainSrc))
    check('with a bound on what crosses the bridge', /CLIPBOARD_LIMIT/.test(mainSrc))
    // The allowlist stays as it is on purpose — widening it would hand clipboard
    // writes to any page the local HTTP server ever serves.
    const mainCode = mainSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    check('the permission allowlist is not widened', !/clipboard-sanitized-write/.test(mainCode))
    check('the preload exposes it', /copyText:/.test(preSrc))
  }
  // A browser has no editor to hand anything to; say so rather than failing.
  check('the editor panel handles not being hosted', /no editor to hand a document to/.test(ui))
}

console.log('\nhosted in the app')
{
  // The Studio runs as a window in OpenScreen now, which removes the reason most
  // of the bridge existed: opening a document is an IPC call to the process that
  // owns the editor, not a PATH lookup plus a probe plus a Finder fallback.
  const srv = await readFile(resolve(ROOT, 'bin/rm-studio.mjs'), 'utf8')
  const ui = await readFile(resolve(ROOT, 'lib/studio.js'), 'utf8')

  check('the client knows whether it is hosted', /window\.rmStudio\?\.hosted/.test(ui))
  check('and asks the host to open the document', /window\.rmStudio\.openProject\(r\.document\)/.test(ui))
  check('the server does not also shell out when hosted', /body\.hosted \? \{ opened: false, via: "host" \}/.test(srv))
  // The browser path has to keep working: the Studio is still servable on its own
  // and `npm run dev` is how it is worked on.
  check('the CLI path survives for a browser', /await openInOpenScreen\(doc\)/.test(srv) && /async function openInOpenScreen/.test(srv))
  check('one place decides which way in', (ui.match(/function openDocument/g) || []).length === 1)
  // A host that refuses must say so rather than reporting success.
  check('a refusal is surfaced', /the editor would not take it/.test(ui))

  /*
   * And it opens in this window, not another one.
   *
   * A second BrowserWindow is the same process and the same Dock icon, and it
   * still reads as a separate app: another titlebar, another entry in the Window
   * menu, and the Studio's navigation gone. The editor is a WebContentsView
   * placed inside the Studio window instead.
   */
  check('the page asks for the editor to be placed in it', /rmStudio\.mountEditor/.test(ui))
  /*
   * And it bypasses Optics' content wrappers rather than cancelling them.
   *
   * .op-page__main-content and .container are a reading measure and a page gutter,
   * which is right for every other panel here and wrong for an application. The
   * first version of this put the frame inside both and then undid their padding
   * and width from underneath — which worked, and left the editor sitting in two
   * wrappers whose only job was to inset it. #editor-host is their sibling.
   */
  // Markup and styles are separate files now, and this block asserts against both.
  const shell = await readFile(resolve(ROOT, 'lib/studio.html'), 'utf8')
  const shellCss = await readFile(resolve(ROOT, 'lib/studio.css'), 'utf8')
  check('the editor has a slot of its own', /id="editor-host"/.test(shell) && /\$\('#editor-host'\)/.test(ui))
  check('and it is not inside the content wrapper', /body\.has-editor \.op-page__main-content \{\s*display: none/.test(shellCss))
  // Cover the breadcrumb row and the window stops being movable: it is the drag
  // region the host injects.
  check('the drag region is left uncovered', /breadcrumb row above it, which is the window's/.test(shellCss))
  // The editor has File → Open, a recent list and a New Project. A second picker in
  // the panel around it was a worse copy of a control four pixels away.
  check('the panel does not add a second document picker', !/Choose another document/.test(ui))
  // The page measures, the host places. The alternative is the main process
  // carrying a copy of this stylesheet to work out where the nav ends.
  check('the page measures its own frame', /getBoundingClientRect\(\)/.test(ui) && /mountEditorInto/.test(ui))
  check('and keeps it placed while it moves', /new ResizeObserver/.test(ui) && /layoutEditor/.test(ui))
  // Same reason render() closes the EventSource: a live thing left attached to a
  // view the page has replaced is a native frame floating over the wrong panel.
  check('leaving the view takes the editor out', /dropEditor\(\)/.test(ui) && /unmountEditor/.test(ui))
  // A page served over HTTP by another process must not be able to place a view
  // in a window that is not its own.
  if (HAVE_OS) {
    const main = await src('electron/main.ts')
    const embed = await src('electron/studio/embedded-editor.ts')
    check('only the Studio window may mount it', /BrowserWindow\.fromWebContents\(event\.sender\) === studioWindow/.test(main))
    check('a document goes to the embedded editor when it is showing', /embeddedEditorAttached\(\)/.test(main))
    /*
     * And so does the recorder's toolbar, which was the loudest way in and the
     * one route that ignored all of this.
     *
     * `switch-to-editor` called createEditorWindowWrapper straight, so finishing
     * a capture — the ordinary way into the editor — opened a window of its own
     * with no Studio navigation in it, whatever openProjectPath did for documents
     * arriving any other way.
     */
    check("the recorder's toolbar goes there too", /function openEditorSurface/.test(main) && /registerIpcHandlers\(\s*openEditorSurface,/.test(main))
    // The HUD is always-on-top and nothing else closes it, so it would sit over
    // the Studio it just handed the editor to.
    check('and takes the HUD down with it', /studioWindow\.webContents\.send\("studio:show-editor-view"\)/.test(main) && /isForceClosing = true;[\s\S]{0,200}studioWindow\.show\(\)/.test(main))
    // No Studio means nothing to embed into, and a standalone window is right.
    check('with no Studio it still opens a window', /if \(!studioWindow \|\| studioWindow\.isDestroyed\(\)\) \{\s*createEditorWindowWrapper\(\);/.test(main))
    const pre = await src('electron/studio-preload.ts')
    check('the page is told, not driven', /onShowEditor:/.test(pre) && /studio:show-editor-view/.test(pre))
    check('and it decides what that means', /window\.rmStudio\?\.onShowEditor\?\.\(\(\) => go\('editor'\)\)/.test(ui))
    // Bounds Electron accepts and draws nothing for: a fractional height from a
    // mid-transition measure, or a zero one from a page still laying out.
    check('the rect is made whole before it is used', /Math\.max\(1, Math\.round/.test(embed))
    // The view outlives a navigation on purpose; it must not outlive the window.
    check('the view is kept across navigation', /export function unmountEmbeddedEditor/.test(embed) && !/webContents\.close\(\)[\s\S]{0,80}attached = false/.test(embed))
    check('and destroyed with the window', /destroyEmbeddedEditor\(\)/.test(main))
    // Two marks and two names a few pixels apart is what makes an embedded view
    // look like a mistake.
    const topbar = await src('src/components/ai-edition/v4/EditorTopBar.tsx')
    check('the embedded editor drops the duplicate wordmark', /\{embedded \? null : <span className=\{styles\.name\}>/.test(topbar))
    // Taking the wordmark off took the only text out of the app-menu button, and
    // with it that control's accessible name.
    check('and keeps the app menu addressable', /aria-label=\{embedded \? PRODUCT_NAME : undefined\}/.test(topbar))
  }
}

console.log('\none drawing, one file')
{
  /*
   * The mark existed three times: percent-encoded twice into studio.html (favicon
   * and sidebar) and hand-copied a third time into the fork. make-icon.mjs scraped
   * one of the encoded copies back out with a regex, so the drawing could not be
   * edited without hand-encoding it — and the fork's copy had already drifted,
   * missing part of the export.
   *
   * brand/icon/mark.svg is the source. Everything else is served from it or
   * generated from it.
   */
  const shell = await readFile(resolve(ROOT, 'lib/studio.html'), 'utf8')
  const srv = await readFile(resolve(ROOT, 'bin/rm-studio.mjs'), 'utf8')
  const icon = await readFile(resolve(ROOT, 'lib/make-icon.mjs'), 'utf8')
  const mark = await readFile(resolve(ROOT, 'brand/icon/mark.svg'), 'utf8').catch(() => null)

  check('the mark is a file', Boolean(mark) && /<svg/.test(mark ?? ''))
  // The favicon and the sidebar both point at it rather than carrying a copy.
  check('nothing inlines it any more', (shell.match(/href="\/brand-mark\.svg"/g) || []).length === 1 && (shell.match(/src="\/brand-mark\.svg"/g) || []).length === 1)
  check('and no encoded copy is left in the shell', !/data:image\/svg\+xml,%3Csvg width='180'/.test(shell))
  check('the server serves it', /p === "\/brand-mark\.svg"/.test(srv))
  // A regex over another file's markup is not a source of truth.
  check('make-icon reads the file, not the markup', /readFile\(join\(iconDir, "mark\.svg"\)/.test(icon) && !/no brand mark in lib\/studio\.html/.test(icon))
  // Icon Composer and friends export a raster, and re-drawing that from a vector
  // would be second-guessing whoever exported it.
  // Three inputs, because a Mac app icon, a cross-platform icon set and an in-UI
  // mark are not one asset: the first carries Apple's grid and corner curvature,
  // the last is drawn at 22px in one place and 180 in another.
  check('a Mac-only icon can override the rest', /macos\.png/.test(icon) && /async function macIconSource/.test(icon))
  check('and an app icon can override just the mark', /app\.png/.test(icon))
  check('a raster is used as given, not re-derived', /image-rendering:auto/.test(icon))
  /*
   * Sources and outputs in separate directories, which cost an icon to learn: an
   * Icon Composer export dropped into brand/icon/ landed exactly on `icon.icns`
   * and `png/`, the two things this script writes.
   */
  check('sources cannot be clobbered by their own build', /const srcDir = join\(iconDir, "source"\)/.test(icon) && /join\(srcDir, name\)/.test(icon))
  // Icon Composer emits per-size artwork — small sizes redrawn, not downsampled.
  // Rebuilding the .icns from its own contents can only lose that, so every slot
  // the export has is copied and the export is passed through untouched when it
  // has them all.
  check('a finished .icns is copied, not rebuilt', /await copyFile\(built\.path, icns\)/.test(icon) && /if \(!filled\.length\) return \{ path: exported/.test(icon))
  /*
   * The .icon document is where the icon is drawn, so it is the source of record.
   * It cannot be the whole build on its own: actool's .icns stops at 256px because
   * on macOS 26 the real artwork lives in the Assets.car beside it. So it fills the
   * two non-Retina slots Icon Composer's exporter omits, and nothing else.
   */
  check('the Icon Composer document is a source', /async function iconDocument/.test(icon) && /n\.endsWith\("\.icon"\)/.test(icon))
  check('the export wins over the compile', /from\.byName\.get\(name\) \?\? from\.byPx\.get\(px\) \?\? also\?\.byName/.test(icon))
  check('no Xcode is not a build failure', /const actool = doc \? findActool\(\) : null/.test(icon) && /existsSync\(inXcode\) \? inXcode : null/.test(icon))
  // And the thing that actually matters: what shipped has every slot filled. A real
  // unpack rather than a regex, because the point is the artwork, not the code that
  // assembled it. Skipped rather than failed off a Mac, where iconutil does not exist.
  const built = resolve(ROOT, 'brand/icon/icon.icns')
  const unpacked = existsSync(built) ? await unpackIcns(built) : null
  if (unpacked === null) {
    skipped++
    skips.iconutil = 1
    console.log('  · the shipped .icns has all ten sizes')
  } else {
    check('the shipped .icns has all ten sizes', unpacked.length === 10, `${unpacked.length} of 10`)
  }
  // The Mac set needs 16-1024 by .iconset name; the flat set also needs 24 and 48.
  // Sharing one cache between them silently skipped those two and then tried to
  // render after the browser was closed.
  check('both sets get every size they need', /shared \? \[\.\.\.macSizes, \.\.\.PNGS\] : macSizes/.test(icon))
  // The old last line of make-icon claimed packaging/ copied its output into the
  // fork. Nothing did, which is how the drift started.
  check('it installs into the fork itself', /icons", "icons", "mac"/.test(icon) && /rolemodel-mark\.svg/.test(icon))

  if (HAVE_OS && mark) {
    const forked = await src('src/assets/rolemodel-mark.svg').catch(() => null)
    check("the app's copy is the same bytes", forked === mark, forked === null ? 'missing — run `npm run icon`' : 'differs — run `npm run icon`')
  }
}

console.log('\nthe words and the picture on one clock')
{
  /*
   * A blank line between prose and a ```do block says nothing about timing.
   *
   * It is document order and that is all. A click takes 300ms and the sentence
   * describing it takes four seconds, so the picture raced the voice and by step
   * five they were describing different things — and the only way to find out was
   * to render the whole thing and watch it drift.
   *
   * rm-mux reconciles the two clocks, but only for the clip as a whole: it pads,
   * stretches, or holds the last frame. It cannot pull cue four back over the action
   * it belongs to, because by then the timing is in the video. So the pace is
   * derived before anything is recorded: a step that carries a line holds for it.
   */
  const ds = await import('./demo-script.mjs')
  const ui7 = await readFile(resolve(ROOT, 'lib/studio.js'), 'utf8')
  const srv7 = await readFile(resolve(ROOT, 'bin/rm-studio.mjs'), 'utf8')

  check('a line has a measurable length', typeof ds.speechMs === 'function' && ds.speechMs('Adding a railing is two clicks.') > 0)
  // Longer sentence, longer hold. The direction is the whole contract.
  check('and a longer line is a longer hold', ds.speechMs('Pick the rail height, then the post spacing, and the quote updates as you go.') > ds.speechMs('Done.'))
  check('nothing reads a label instantly', ds.speechMs('Go.') >= 700)
  check('an empty line costs nothing', ds.speechMs('') === 0 && ds.speechMs('   ') === 0)
  // Punctuation buys a beat, because a synthesiser pauses at a comma and a word
  // count does not know that.
  check('punctuation is a pause', ds.speechMs('one, two, three, four') > ds.speechMs('one two three four'))

  /*
   * One estimator. Two would drift, and the entire point is that the number the
   * builder promises is the number the demo holds for.
   */
  check('the page uses the same estimate', /p === "\/demo-script\.mjs"/.test(srv7) && /await import\('\/demo-script\.mjs'\)/.test(ui7))
  check('and never its own copy of it', !/SPEECH_WPM|words \/ 165/.test(ui7))

  check('a step with a line holds for it', /out\.push\('```do', line, `wait \$\{hold\}`/.test(ui7))
  // Asking for 800ms and then adding 2.6s of hold is not what anyone meant.
  check('a pause takes the longer of the two, not both', /Math\.max\(Number\(args\[0\]\) \|\| 0, hold\)/.test(ui7))
  check('the builder shows what a line costs', /holds \$\{\(ms \/ 1000\)\.toFixed\(1\)\}s to say that/.test(ui7))
  check('and the two totals side by side', /of holds · \$\{secs\(time\.words\)\} of narration/.test(ui7))
  // describe() is what the check-as-you-type hint reads, so it carries it too.
  {
    const parsed = ds.parseDemo(['Adding a railing is two clicks.', '', '```do', 'click "3D VIEW"', 'wait 2600', '```'].join('\n'))
    const d = ds.describe(parsed)
    check('a parsed script reports both clocks', d.speechMs > 0 && d.holdMs === 2600, `speech ${d.speechMs}ms, holds ${d.holdMs}ms`)
    // The invariant the whole thing exists for: the hold the builder writes is the
    // length of the line it wrote it for.
    check('and they agree when the builder wrote it', Math.abs(d.speechMs - d.holdMs) < 200, `${d.speechMs} vs ${d.holdMs}`)
  }
}

console.log('\na review you can see the state of')
{
  /*
   * "They just sit there" was exactly right.
   *
   * The Review page mapped every video down to an id and a title, so nothing on it
   * could tell you whether a client had been in — while the call it already made
   * returned the active version with its comment count, number, duration and
   * thumbnail. Discarded, for nothing.
   */
  const srv6 = await readFile(resolve(ROOT, 'bin/rm-studio.mjs'), 'utf8')
  const ui6 = await readFile(resolve(ROOT, 'lib/studio.js'), 'utf8')

  for (const field of ['versionId', 'version', 'comments', 'duration', 'thumbnail']) {
    check(`  the listing keeps ${field}`, new RegExp(`${field}:`).test(srv6.slice(srv6.indexOf('videos: (videos?.videos'), srv6.indexOf('videos: (videos?.videos') + 900)))
  }
  check('and the card shows it', /no comments yet/.test(ui6) && /facts\.join\(' · '\)/.test(ui6))

  /*
   * The count in the listing is every comment ever left, so a video whose notes are
   * all dealt with looks identical to one nobody has touched. Unresolved is the
   * number that means anything, and it costs a call, so it is a button.
   */
  check('open notes can be counted', /p === "\/api\/review\/status"/.test(srv6) && /includeResolved=true/.test(srv6))
  check('replies count as notes', /n \+ 1 \+ \(c\.replies\?\.length \?\? 0\)/.test(srv6))
  check('and approvals are read per version', /\/api\/versions\/\$\{versionId\}\/approvals/.test(srv6))
  // An instance without the approval routes should still report comments.
  check('an instance without approvals still reports notes', /\/\/ Approvals are a feature of the fork, not a guarantee/.test(srv6))
  check('the page asks for it on click', /api\/review\/status\?version=/.test(ui6))

  /*
   * And the wall it hits, named. OpenFrame's comments route authenticates with
   * `auth()` alone, so it only ever sees a browser session — six of its sixty-six
   * routes use the token-aware helper and all six are on the upload-and-share path.
   * "403: Access denied" reads as a bad token, and no amount of fiddling with the
   * token will change it.
   */
  check('a 403 is explained, not echoed', /its comments route only accepts a browser session/.test(srv6))
}

console.log('\ndriving the browser already on screen')
{
  /*
   * A launched Chromium is blank and signed into nothing.
   *
   * Which makes it useless for demoing a real app: the page is already open, already
   * logged in, already has data in it. The first version launched its own browser and
   * recorded a window nothing was driving — "this needs to run with the user's window,
   * not launch a new chrome", which is the whole requirement.
   */
  const demoD = await readFile(resolve(ROOT, 'bin/rm-demo.mjs'), 'utf8')
  const srvD = await readFile(resolve(ROOT, 'bin/rm-studio.mjs'), 'utf8')
  const uiD = await readFile(resolve(ROOT, 'lib/studio.js'), 'utf8')

  check('it can attach instead of launching', /chromium\.connectOverCDP\(cdpUrl\)/.test(demoD))
  // A dozen tabs are open and the demo is one of them.
  check('and pick the tab by title or url', /--page/.test(demoD) && /c\.title\.toLowerCase\(\)\.includes\(wanted\) \|\| c\.url\.toLowerCase\(\)\.includes\(wanted\)/.test(demoD))
  check('skipping blank and internal tabs', /url\.startsWith\("chrome:\/\/"\)/.test(demoD))
  // Listing what IS open beats "no match".
  check('and listing what is open when nothing matches', /no open page matches --page/.test(demoD))

  /*
   * Chrome cannot be given a debugging port while running, so the refusal has to say
   * how to start one — and mention --remote-allow-origins, without which the failure
   * happens at the WebSocket and looks like a different fault.
   */
  check('a refusal says how to open a port', /remote-debugging-port=9222/.test(demoD) && /remote-allow-origins/.test(demoD))
  /*
   * And the line it prints survives being pasted. zsh globs a bare `*`, so the first
   * version failed with "no matches found: --remote-allow-origins=*" before Chrome
   * ever saw it — a copy-pasteable command that could not be pasted.
   */
  for (const [where, src] of [
    ['the refusal', demoD],
    ['the panel', uiD],
  ]) {
    // A backslash counts: inside a single-quoted JS string the quote is escaped, and
    // what reaches the terminal is still a quoted glob.
    const printed = [...src.matchAll(/remote-allow-origins=(\\?.)/g)].map((m) => m[1])
    check(`  ${where} quotes the glob`, printed.length > 0 && printed.every((c) => c === "'" || c === "\\'"), printed.join(' '))
  }
  check('and that the profile survives it', /keeps your normal profile/.test(demoD))

  // Closing the context would take the person's session with it.
  check('it never closes a browser it did not open', /if \(attach\) await browser\.close\(\);/.test(demoD))

  /*
   * Attaching inverts both earlier rules, and both inversions are the point: the page
   * already exists, so no goto is needed, and the picked window IS the browser being
   * driven, so it is exactly what the recorder should film.
   */
  check('attaching needs no goto', /if \(!attach && !steps\.some/.test(demoD) && /if \(!body\.attach && !acts\.some/.test(srvD))
  check('and --window becomes the point of it', /const ownWindow = attach && typeof flag\("window"\) === "string"/.test(demoD))
  check('so the server sends it only then', /\.\.\.\(body\.attach \? captureArgs\(body\.source\) : \[\]\)/.test(srvD))

  // And it is reachable without the CLI.
  check('the panel offers it', /Use the browser I have open/.test(uiD) && /attach: attach\.checked/.test(uiD))
  check('with the address and the tab', /cdp: cdp\.value/.test(uiD) && /page: pageMatch\.value/.test(uiD))
  // Viewport and headless belong to a browser we launch, not one already sized —
  // so attaching takes them off screen rather than dimming them.
  check('launch-only knobs go away when attaching', /showGroup\(c, scripted && !attached\)/.test(uiD))
  check('and the plan says which of the two it did', /Drive the browser you already have open, and record it\./.test(uiD))
}

console.log('\na capture that cannot work is refused, not run')
{
  /*
   * Two faults, one take. `capture` drives a browser it launches, which starts blank —
   * so a script that never navigates fails on its first selector, sixteen seconds in,
   * while the recorder films nothing. And the Record page was still sending the window
   * picked from the Capture list, so the recorder filmed *that* while the script drove
   * the blank browser: two things, neither connected to the other.
   *
   * Observed once, exactly: `stopped at line 4 (click): nothing matched "Level
   * Selection" on about:blank`, over a thirty-second recording of the wrong window.
   */
  const demoC = await readFile(resolve(ROOT, 'bin/rm-demo.mjs'), 'utf8')
  const srvC = await readFile(resolve(ROOT, 'bin/rm-studio.mjs'), 'utf8')
  const uiC = await readFile(resolve(ROOT, 'lib/studio.js'), 'utf8')

  // Only a launched capture. Attaching starts on a page that already exists.
  check('a launched script that never navigates is refused', /if \(!attach && !steps\.some\(\(st\) => st\.verb === "goto"\)\)/.test(demoC))
  // Before playwright is even imported, so it costs nothing.
  const capture = demoC.slice(demoC.indexOf('async function captureCommand'))
  const iGoto = capture.indexOf('st.verb === "goto"')
  const iLaunch = capture.indexOf('await import("playwright")')
  check('before a browser is launched', iGoto !== -1 && iGoto < iLaunch, `${iGoto} vs ${iLaunch}`)
  check('and the reason says how to fix it', /Add a first step that|goes somewhere/.test(demoC))

  // Naming another window records something nothing is driving.
  check('--window without attach is refused', /cannot be recorded by a launched capture/.test(demoC))
  // Sent only when attaching, when the picked window IS the browser being driven.
  check('and the server sends it only when attaching', /The picked window goes through only when attaching/.test(srvC))
  // `run` stays permissive: it can act on a page that is already open, which is why
  // parseDemo does not treat a missing goto as an error on its own.
  check('`run` is left permissive', !/never navigates/.test(demoC.slice(demoC.indexOf('async function runCommand'), demoC.indexOf('async function recordCommand'))))

  // Said while typing, which is the difference between a sentence and a lost take.
  check('the panel says it before the run', /never goes to a page/.test(uiC))
  check('and the server refuses it too', /never navigates, so there would be nothing to act on/.test(srvC))
  // The plan used to promise the picked window would be recorded.
  check('the plan no longer promises the picked window', /Not the window picked above/.test(uiC))
}

console.log('\nclicking a script opens a script')
{
  /*
   * The form IS the editor.
   *
   * This went through two wrong shapes. First, clicking a saved script filled the
   * fields of a form sitting below the Claude drafter and scrolled to the top — so
   * you were still looking at the drafter, with the thing you clicked tucked
   * underneath it. Then it opened a separate editor screen, which fixed that and
   * left the panel with two forms and a third screen for one job.
   *
   * One form. The fields that say which project and what name apply whether the
   * script is drafted or typed, so asking twice was the mistake; and clicking a
   * saved script loads it into the form you are already looking at, which is what
   * makes a separate editor unnecessary rather than merely relocated.
   */
  const uiE = await readFile(resolve(ROOT, 'lib/studio.js'), 'utf8')
  const scriptsTpl = /<template data-panel="scripts">([\s\S]*?)<\/template>/.exec(
    await readFile(resolve(ROOT, 'lib/studio.html'), 'utf8'),
  )?.[1] ?? ''
  check('the panel is one form', Boolean(scriptsTpl) && !/vScriptEditor/.test(uiE) && !/editingScript/.test(uiE))
  check('and clicking a saved script loads it into that form', /card\.onclick = \(\) => load_\(sc\)/.test(uiE))
  // The shelf is the rail and the buttons are the page footer, so neither is part
  // of what scrolls while you write.
  check('the shelf is beside it and the actions below it', /data-region="side"/.test(scriptsTpl) && /data-el="draft"/.test(scriptsTpl))
  // studio.css pins every textarea to --field-tall, so the script box would be four
  // lines tall and scroll — the same trap the demo-script box hit.
  check('the script box is tall enough to write in', /\.script-body \{[^}]*min-block-size: 26rem/s.test(await readFile(resolve(ROOT, 'lib/studio.css'), 'utf8')))
  /*
   * The line count comes from the parser the synthesiser uses, and estimateSeconds
   * takes those parsed lines rather than the markdown — handing it the raw string threw
   * and took the whole screen with it, so the editor came up blank the first time.
   */
  check('the count comes from the real parser', /SP\.parseScript\(body\.value\)/.test(uiE))
  check('and the estimate is given lines, not markdown', /SP\.estimateSeconds\(parsed\)/.test(uiE))
  // Saving is not finishing.
  // Saving is not finishing: the form keeps what you wrote, and the shelf beside it
  // is repainted so it shows what was just written to it.
  check('saving keeps you in the form', /Reloaded rather than bounced: saving is not finishing/.test(uiE))
}

console.log('\na half-built script is not lost')
{
  /*
   * Ten minutes of work, gone, and it was two faults at once.
   *
   * render() empties #main on every navigation, and the builder's rows lived in a
   * closure and nowhere else — so looking at another page destroyed the script. And
   * the builder only ever compiled rows into markdown, never the other way, so a
   * script that HAD reached disk could not be edited in the UI at all.
   */
  const uiB = await readFile(resolve(ROOT, 'lib/studio.js'), 'utf8')
  const srvB = await readFile(resolve(ROOT, 'bin/rm-studio.mjs'), 'utf8')
  check('rows are kept per project', /p === "\/api\/record\/draft"/.test(srvB) && /function writeDraft/.test(srvB))
  check('saved on every edit', /onSave\?\.\(rows\)/.test(uiB))
  check('and put back on the way in', /loadDraft\(proj\.value\)\.then\(/.test(uiB))
  /*
   * On the server, not in localStorage. That was the first attempt and it was wrong
   * in a way that only appears on the second launch: the app asks the OS for a free
   * port each time, so the page's origin changes and a store keyed to the old one is
   * unreachable. A reload in the same session kept the port, which is why it looked
   * fine. Proven by loading the page on a different port and getting the rows back.
   */
  check('in a place a restart cannot lose', /const DRAFT_DIR = join\(STATE_DIR, "drafts"\)/.test(srvB))
  /*
   * Remotes are editable, not just addable.
   *
   * The Storage panel could create a remote and then only ever list it, so a typo
   * in an endpoint meant hand-editing rclone.conf. These cover the four things
   * that made editing safe rather than merely possible.
   */
  {
    const srv = await readFile(resolve(ROOT, 'bin/rm-studio.mjs'), 'utf8')
    const ui = await readFile(resolve(ROOT, 'lib/studio.js'), 'utf8')
    check('a remote can be read, changed, and removed', /req\.method === "PUT"/.test(srv) && /req\.method === "DELETE"/.test(srv) && /config", "update"/.test(srv) && /config", "delete"/.test(srv))
    // Obscured is not secret — rclone's obscuring is reversible by design.
    check('the secret never leaves the server', /hasSecret: Boolean\(cfg\.secret_access_key\)/.test(srv) && !/secretAccessKey: cfg\./.test(srv))
    // An empty field means "leave it alone", not "set it to nothing".
    check('a blank secret keeps the stored one', /if \(b\.secretAccessKey\) args\.push\("secret_access_key"/.test(srv))
    // `rclone config show` exits 0 for a name that does not exist.
    check('a missing remote is missing, not empty', /if \(!cfg\.type\) return null;/.test(srv))
    // A name goes straight into an argv, where a leading dash reads as a flag.
    check('a remote name is checked before it is an argument', /REMOTE_NAME = \/\^\[A-Za-z0-9\]/.test(srv))
    // Saving is not proof; listing buckets is the cheapest call that authenticates.
    check('a remote can be tested', /"lsd", `\$\{storageName\}:`/.test(srv) && /Test'\)/.test(ui))
    check('rclone cannot rename, and the form says so', /cannot rename/.test(ui) && /name\.readOnly = true/.test(ui))
  }

  check('and the page no longer uses browser storage', !/localStorage\.(get|set|remove)Item/.test(uiB))
  // One definition of where our state lives, shared with the config.
  const settings = await readFile(resolve(ROOT, 'lib/settings.mjs'), 'utf8')
  check('beside the config it already owns', /export const STATE_DIR/.test(settings) && /const CONFIG_FILE = join\(STATE_DIR/.test(settings))
  // A project id becomes a filename, so it is checked rather than trusted.
  check('a project id cannot name a path', /\^\[a-z0-9\]\[a-z0-9\._-\]\*\$/i.test(srvB) && /that is not a project id/.test(srvB))
  // An empty list means "no draft", not "write an empty one".
  check('clearing the rows removes the file', /await rm\(file, \{ force: true \}\)/.test(srvB))
  // The builder emits per keystroke; a request per character is not a design.
  check('saving is debounced', /DRAFT_SAVE_MS/.test(uiB) && /clearTimeout\(draftTimer\)/.test(uiB))
  /*
   * Switching project must not show another project's draft.
   *
   * This used to be a `change` listener on the panel's own project select. There is
   * no select any more — the project is ambient, and switching it reloads state and
   * re-renders the panel — so the guarantee now comes from the draft being loaded
   * against `proj.value`, which reads the current project, on every render.
   */
  check('a draft belongs to its project', /const proj = \{ get value\(\) \{ return currentProject\(\) \?\? '' \} \}/.test(uiB) && /loadDraft\(proj\.value\)/.test(uiB))

  // The other direction, which is what makes a script on disk editable again.
  check('a script can be read back into rows', /function scriptToDemoSteps/.test(uiB) && /Rebuild rows from the script/.test(uiB))
  /*
   * A step with a line compiles to [action, wait <speechMs>], so a naive parse would
   * read that hold as its own Pause row and the count would grow every round trip.
   */
  check('and the generated hold is not read as a step', /Math\.abs\(Number\(st\.args\[0\]\) - want\) <= 100/.test(uiB))

  /*
   * Both restores run emit(), which reads the page. Declared after it, that threw
   * "Cannot access 'handEdited' before initialization" and rendered nothing —
   * twice, for two different variables, before the restore was moved to the end.
   */
  const rec = uiB.slice(uiB.indexOf('function vRecord'))
  const body = rec.slice(0, rec.indexOf('\nfunction '))
  const iHand = body.indexOf('let handEdited')
  const iBuild = body.indexOf('const builder = demoBuilder')
  const iScript = body.indexOf("const script = el('textarea')")
  const iLoad = body.indexOf('if (draft.length) builder.load(draft)')
  check('handEdited is declared before the builder', iHand !== -1 && iHand < iBuild, `${iHand} vs ${iBuild}`)
  check('and the draft is restored after the page exists', iLoad > iScript, `restore ${iLoad}, textarea ${iScript}`)
}

console.log('\nour own binaries, without PATH')
{
  /*
   * "rm-demo: not found on PATH" was a real break with nothing wrong in the request.
   *
   * rm-demo is newer than some installs, so on a machine whose Homebrew copy predates
   * it the name simply is not linked and every scripted capture died. We are the
   * toolkit, so we know where our scripts are: `node <toolkit>/bin/x.mjs` works from a
   * checkout and from libexec, needs nothing linked, and cannot be shadowed by
   * something else with the same name.
   */
  const srv9 = await readFile(resolve(ROOT, 'bin/rm-studio.mjs'), 'utf8')
  check('a step runs our script, not a name', /function ownStep/.test(srv9) && /join\(TOOLKIT, "bin", `\$\{name\}\.mjs`\)/.test(srv9))
  // PATH is still the fallback, for a binary that is not ours to ship.
  check('and falls back to PATH for anything else', /: \{ bin: name, args, \.\.\.extra \}/.test(srv9))
  const bare = [...srv9.matchAll(/bin: "(rm-[a-z-]+)"/g)].map((m) => m[1])
  check('no toolkit binary is named bare any more', bare.length === 0, bare.join(', '))
  // `node` is allowlisted for exactly this, and the server resolves the path itself.
  const jobs = await readFile(resolve(ROOT, 'lib/jobs.mjs'), 'utf8')
  check('the runner allows it for exactly this', /"node",/.test(jobs) && /resolves that path itself/.test(jobs))
  // The formula links them too, so an install does not depend on this either.
  const formula = await readFile(resolve(ROOT, 'packaging/rm-video.rb'), 'utf8')
  check('and the formula links rm-demo', /ENTRIES = %w\[[^\]]*rm-demo/.test(formula))
}

console.log('\na review card you can read at a glance')
{
  /*
   * The card was a title, a path, and three stacked full-width buttons. The listing
   * had carried a thumbnail all along and nothing showed it.
   */
  const srvA = await readFile(resolve(ROOT, 'bin/rm-studio.mjs'), 'utf8')
  const uiA = await readFile(resolve(ROOT, 'lib/studio.js'), 'utf8')
  check('the card shows its thumbnail', /el\('div', 'projart'\)/.test(uiA) && /api\/review\/thumb\?project=/.test(uiA))
  /*
   * Proxied, because the page cannot load it: OpenFrame serves thumbnails behind a
   * project-access check, so an anonymous img gets 403 — and the page has no session
   * and must never be handed the token to get one.
   */
  check('through the server, which holds the token', /p === "\/api\/review\/thumb"/.test(srvA) && /authorization: `Bearer \$\{token\}`/.test(srvA))
  // Accepting a path from the query string would make this an open proxy for that
  // host, signed with our token.
  check('and only a path the instance told us about', /\/\^\\\/api\\\/upload\\\/image/.test(srvA))

  // Icons with the words in the tooltip, not three stacked labels.
  for (const [what, re] of [
    ['check for feedback', /checkIt\.title = 'Check for feedback'/],
    ['open in OpenFrame', /openIt\.title = 'Open in OpenFrame'/],
    ['copy link', /copyIt\.title = 'Copy link'/],
  ]) {
    check(`  ${what} is an icon with a label`, re.test(uiA))
  }
  check('and they sit in one row', /acts\.append\(checkIt, openIt, copyIt\)/.test(uiA))
  /*
   * Found before shipping it: copyButton set textContent, which on a button whose
   * only child is a glyph deletes the glyph — and then restored a label an icon
   * button does not have, leaving it blank for ever.
   */
  check('an icon button keeps its icon after copying', /const iconOnly = Boolean\(glyph\) && !btn\.textContent\.trim\(\)/.test(uiA) && /glyph\.className = was/.test(uiA))
}

console.log('\nicons, vendored')
{
  /*
   * HugeIcons, served from this repo.
   *
   * Optics has an icon layer, but it is Material Symbols — the `.icon--*` modifiers
   * set variable-font axes only that family has — and this is a different set. What
   * Optics does provide is `.custom-icons` and nothing that stops a font-based set
   * living beside it, so HugeIcons goes in as itself.
   *
   * Vendored rather than linked, for the reason every asset here is: the Studio is
   * hosted by a desktop app that has to start with no network, and an icon set
   * fetched over HTTP renders as empty boxes on a plane.
   */
  const iconCss = await readFile(resolve(ROOT, 'brand/icons/hugeicons.css'), 'utf8').catch(() => null)
  check('the set is on disk', Boolean(iconCss), iconCss ? `${Math.round(iconCss.length / 1024)}KB` : 'run `npm run icons`')
  if (iconCss) {
    const ui5 = await readFile(resolve(ROOT, 'lib/studio.js'), 'utf8')
    const srv5 = await readFile(resolve(ROOT, 'bin/rm-studio.mjs'), 'utf8')
    const html5 = await readFile(resolve(ROOT, 'lib/studio.html'), 'utf8')
    const have = new Set([...iconCss.matchAll(/\.hgi-([a-z0-9-]+)::before/g)].map((m) => m[1]))

    /*
     * A ligature font renders a name it does not have as a blank box and says
     * nothing, so a typo is invisible until someone looks at that page. Every name
     * the UI asks for is checked against the set.
     */
    const used = [...new Set([...ui5.matchAll(/'hgi-stroke hgi-' \+ name/g)].length ? [...[...ui5.matchAll(/icon\('([a-z0-9-]+)'/g)].map((m) => m[1]), ...[...(/const VIEW_ICON = \{([\s\S]*?)\n\}/.exec(ui5)?.[1] ?? '').matchAll(/: '([a-z0-9-]+)'/g)].map((m) => m[1])] : [])]
    const unknown = used.filter((n) => !have.has(n))
    check('every icon the UI names exists in the set', used.length > 0 && unknown.length === 0, `${used.length} used of ${have.size}${unknown.length ? ` — no such icon: ${unknown.join(', ')}` : ''}`)

    // Every page has a label; it should have a glyph for the same reason.
    // Whitespace-tolerant, same reason as the dispatch read above.
    const dispatch2 = /\(\{\s*(library: vLibrary[\s\S]*?)\s*\}\)\[view\]\(m\)/.exec(ui5)?.[1] ?? ''
    const views2 = [...dispatch2.matchAll(/(\w+): v/g)].map((m) => m[1])
    const iconed = new Set([...(/const VIEW_ICON = \{([\s\S]*?)\n\}/.exec(ui5)?.[1] ?? '').matchAll(/^\s*(\w+):/gm)].map((m) => m[1]))
    const noIcon = views2.filter((v) => !iconed.has(v))
    check('and every view has one', views2.length > 0 && noIcon.length === 0, noIcon.join(', '))

    // The page must never reach for the network to draw its own chrome.
    const live = iconCss.replace(/\/\*[\s\S]*?\*\//g, '')
    check('nothing in it points at a cdn', !/hugeicons\.com|https?:\/\//.test(live))
    check('and the font it names is one we serve', /url\("\/icons\/hgi-stroke-rounded\.woff2"\)/.test(iconCss))
    check('the server serves both', /p === "\/hugeicons\.css"/.test(srv5) && /FONT_FILES\.has\(name\)/.test(srv5))
    // A path off the network joined onto a directory is how a static file server
    // becomes a file server. Names are checked against a fixed list instead.
    check('a font path cannot escape the folder', /const font = \/\^\\\/\(\?:fonts\|icons\)/.test(srv5))
    check('the page links them', /href="\/hugeicons\.css"/.test(html5) && /href="\/fonts\.css"/.test(html5))

    /*
     * And the faces studio.html has always named. It asked for "DM Sans" and
     * "Geist Mono" from the day it was written and nothing ever served them, so the
     * Studio fell back to system-ui on any machine without DM Sans installed —
     * which is every machine but the one it was built on.
     */
    check('the named faces are served too', /font-family: "DM Sans"/.test(srv5) && /font-family: "Geist Mono"/.test(srv5))
    for (const f of ['DMSans-Variable-latin.woff2', 'GeistMono-Variable.woff2', 'hgi-stroke-rounded.woff2']) {
      const dir = f.startsWith('hgi-') ? 'brand/icons' : 'brand/fonts'
      check(`  ${f} is on disk`, existsSync(resolve(ROOT, dir, f)))
    }
    // Licences ship beside the files, as both sets require.
    check('the font licences ship with them', existsSync(resolve(ROOT, 'brand/fonts/OFL-DMSans.txt')) && existsSync(resolve(ROOT, 'brand/fonts/OFL-Geist.txt')))
    // Regenerating is a script, and drift is a failure, like every other copy here.
    const pkg2 = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8'))
    check('regenerating it is one command', pkg2.scripts?.icons === 'node lib/make-icons.mjs')
    check('and drift fails the check', (pkg2.scripts?.check ?? '').includes('icons:check'))
    // Asked twice how to start the app, so it starts from here as well now.
    check('the app launches from this repo too', pkg2.scripts?.app === 'node lib/launch-app.mjs')
  }
}

console.log('\none page, one name')
{
  /*
   * Every view rendered an h2 and the breadcrumb above it said the same thing, so
   * every page named itself twice — and the two could disagree: the Make page's
   * heading read "Make a video" while the crumb said "make". The breadcrumb is the
   * page's name now, and it is the only one.
   */
  const ui4 = await readFile(resolve(ROOT, 'lib/studio.js'), 'utf8')
  const headings = [...ui4.matchAll(/el\('h([1-3])',/g)].map((m) => m[1])
  check('no view renders its own heading', headings.length === 0, headings.length ? `${headings.length} left` : '')

  // Which makes a missing label a page with no name at all, rather than a
  // duplicate one — `go('recast')` used to land on the lowercase view id.
  // Whitespace-tolerant: an editor reflowing this table from one line to fifteen
  // is a formatting choice, not a routing change, and used to fail this check
  // with "views.length is 0" — which reads as every view losing its label.
  const dispatch = /\(\{\s*(library: vLibrary[\s\S]*?)\s*\}\)\[view\]\(m\)/.exec(ui4)?.[1] ?? ''
  const views = [...dispatch.matchAll(/(\w+): v/g)].map((m) => m[1])
  const labelBlock = ui4.slice(ui4.indexOf('const VIEW_LABEL'))
  const labels = [...labelBlock.slice(0, labelBlock.indexOf('}')).matchAll(/^\s*(\w+): '([^']+)'/gm)].map((m) => [m[1], m[2]])
  const named = new Map(labels)
  const unnamed = views.filter((v) => !named.has(v))
  check('every view the router dispatches has one', views.length > 0 && unnamed.length === 0, unnamed.join(', '))

  // record, make and recast are New video tabs as well as views. Two places name
  // them, so they are asserted to agree rather than left to drift.
  // Up to the closing bracket on its own line, not the first `]` in the file —
  // which is the one that ends the array's own first entry.
  const tabs = [...(/const CREATE_TABS = \[([\s\S]*?)\n\]/.exec(ui4)?.[1] ?? '').matchAll(/\['(\w+)', '([^']+)'\]/g)].map((m) => [m[1], m[2]])
  const disagree = tabs.filter(([id, label]) => named.get(id) !== label)
  check("and a tab's two names agree", tabs.length > 0 && disagree.length === 0, disagree.map(([id, label]) => `${id}: tab "${label}" vs crumb "${named.get(id) ?? '(none)'}"`).join(', '))
}

console.log('\npicking a file without walking there')
{
  /*
   * Two silent failures, in opposite directions.
   *
   * Every picker declares what it takes as `accept: (x) => x.something`, and the
   * browse endpoint decides what `something` is. Two of the four names were never
   * sent. `x.audio` — the click-sound picker — was always undefined, so it hid every
   * file in every folder and read as an empty disk. `x.media ?? true` fell through
   * to the `true` and offered shell scripts as footage.
   *
   * So the flags are asserted against the callbacks that ask for them. A picker
   * asking for a flag nobody sends is the bug, and it cannot be seen from either
   * side alone.
   */
  const srv3 = await readFile(resolve(ROOT, 'bin/rm-studio.mjs'), 'utf8')
  const ui3 = await readFile(resolve(ROOT, 'lib/studio.js'), 'utf8')

  const asked = [...new Set([...ui3.matchAll(/accept: \(x\) => x\.([a-z]+)/g)].map((m) => m[1]))]
  const payload = srv3.slice(srv3.indexOf('files.push({'), srv3.indexOf('subs: SUBS_EXT') + 40)
  const missing = asked.filter((flag) => !new RegExp(`\\b${flag}[,:]`).test(payload))
  check('every flag a picker asks for is one the server sends', asked.length > 0 && missing.length === 0, `${asked.join(', ')}${missing.length ? ` — missing ${missing.join(', ')}` : ''}`)
  // The two that were wrong, named so a regression says which.
  check('audio files are findable at all', /audio,\n/.test(payload) || /\baudio,/.test(payload))
  check('and footage means media, not any file', /media: video \|\| audio \|\| image/.test(srv3))
  // Extension lists, so adding a container is one word rather than a regex edit.
  check('the extensions live in one place', /const VIDEO_EXT = new Set/.test(srv3) && /const AUDIO_EXT = new Set/.test(srv3))
  // .mov is what a Mac screen recording is, and it was not a video.
  check('a QuickTime recording counts as video', /"\.mov"/.test(srv3))

  /*
   * And the walk itself, which was the complaint.
   *
   * It opened at $HOME every time, showed the path as plain text, and the only way
   * back up was `..` one level per click — so reaching footage eight levels down was
   * eight clicks, every visit, with nothing saying how far down you were.
   */
  check('the path is a row of jump targets', /crumbs: \(dir === root \? \[\] : /.test(srv3) && /hop\(c\.name, c\.path/.test(ui3))
  check('the places footage lives are one click', /async function browsePlaces/.test(srv3) && /d\.places\?\.length/.test(ui3))
  // A chip for a folder that was never created is a chip that 404s.
  check('and only the ones that exist are offered', /if \(st\?\.isDirectory\(\)\) out\.push/.test(srv3))
  check('a folder can be narrowed by typing', /Filter this folder…/.test(ui3) && /filter\.oninput = paint/.test(ui3))
  check('and one match takes Enter', /if \(hits\.length === 1\) hits\[0\]\.run\(\)/.test(ui3))
  // Reopening at $HOME after you had just been somewhere is the whole annoyance.
  check('it reopens where it was', /lastDir \|\| undefined/.test(ui3) && /lastDir = d\.path/.test(ui3))
  // Filtering must never hide the way out of the folder.
  check('filtering cannot hide the way out', /always: true/.test(ui3) && /if \(q && !it\.always/.test(ui3))
  // It still refuses to read outside $HOME.
  check('and it still will not read outside home', /if \(!inside\) return json\(res, 403/.test(srv3))
}

console.log('\nscripting the recording, not just the video')
{
  /*
   * The two halves of this had never been introduced.
   *
   * `rm-demo run` drives a browser from a script and leaves a Playwright trace for
   * recast, which is scripted but bypasses OpenScreen: no wallpaper, no padding, no
   * auto-zoom, no camera bubble, nothing the editor can open. `openscreen record`
   * produces exactly that document, but records whatever happens to be on screen —
   * so the Record page could only offer "capture this window for 30 seconds" and
   * hope somebody was driving it. Neither half alone is a demo you can re-cut.
   *
   * `rm-demo capture` is the joint: the script drives the browser, the recorder
   * captures that window, and a document lands that the brand preset patches.
   */
  const cap = await readFile(resolve(ROOT, 'lib/demo-capture.mjs'), 'utf8')
  const demoBin = await readFile(resolve(ROOT, 'bin/rm-demo.mjs'), 'utf8')
  const capture = await import('./demo-capture.mjs')

  check('there is a capture command', /case "capture":/.test(demoBin) && /async function captureCommand/.test(demoBin))
  check('and it writes a document, not a trace', /--project <out\.openscreen>  where the document lands/.test(demoBin))

  /*
   * A browser's window title is whatever page it shows, so there is nothing for
   * --window to match before the first goto. The sentinel is stamped on a blank
   * page, the recorder latches its source once, and the real title replaces it.
   */
  check('the window is identifiable before the first goto', /sentinelTitle/.test(demoBin) && /RM-CAPTURE-/.test(cap))
  /*
   * This used to assert that --window let you record an already-open app during a
   * scripted capture. That was the bug, not the feature: the script drives a browser
   * this command launches, so naming another window films something nothing is
   * driving. It is refused now, and the message names the command that does do it.
   */
  check('recording an already-open window is a different command', /openscreen record --window \.\.\./.test(demoBin))

  // stdin, not a signal: docs/cli.md calls SIGTERM unreliable on Windows, and this
  // toolkit is not going to be macOS-only for ever.
  check('stopping is graceful on every platform', /child\.stdin\?\.write\("stop\\n"\)/.test(cap))
  // A recorder that cannot find the window fails within a beat, listing what is
  // open. Waiting and then asking is what catches the failure that really happens.
  check('a recorder that never started is caught', /rec\.problem\(\)/.test(demoBin) && /RECORDER_SETTLE_MS/.test(demoBin))
  // An event can arrive split across chunks, and two can arrive in one.
  check('ndjson survives chunk boundaries', /export function ndjson/.test(cap))
  {
    const seen = []
    const feed = capture.ndjson((e) => seen.push(e.type))
    feed('{"type":"a"}\nnot json at all\n{"type":')
    feed('"b"}\n')
    check('proven, not asserted', seen.join(',') === 'a,b', seen.join(','))
  }

  // A typo in --cursor should cost nothing. Validating after launching a browser
  // and starting a capture is how you find out fifteen seconds in.
  check('bad options are refused before anything launches', /let recArgs;[\s\S]{0,200}try \{[\s\S]{0,400}recordArgs\(/.test(demoBin))
  for (const bad of [{ nope: 1 }, { duration: -1 }, { cursor: 'sparkly' }]) {
    let threw = null
    try {
      capture.recordArgs(bad)
    } catch (err) {
      threw = err
    }
    check(`  ${JSON.stringify(bad)} is refused`, Boolean(threw), threw?.message)
  }

  const srv2 = await readFile(resolve(ROOT, 'bin/rm-studio.mjs'), 'utf8')
  const ui2 = await readFile(resolve(ROOT, 'lib/studio.js'), 'utf8')

  /*
   * Steps are rows, not a DSL.
   *
   * A markdown script with a ```do block is a fine thing to read and an
   * unreasonable thing to be asked to author. `expect "REQUEST QUOTE"` assumes you
   * know what expect means, that the button is spelled in caps, and that a fenced
   * code block is how you say it — and the people making these videos are not
   * developers. So the UI is a list of rows with the action picked from a list
   * written in English, and the markdown is what it writes.
   */
  const script2 = await import('./demo-script.mjs')
  const verbs = Object.keys(script2.VERBS)
  const rowVerbs = [...ui2.matchAll(/\{ verb: '([a-z]+)', label: '([^']+)'/g)].map((m) => [m[1], m[2]])
  const covered = new Set(rowVerbs.map(([v]) => v))
  const uncovered = verbs.filter((v) => !covered.has(v))
  check('every verb the script has is a row you can pick', verbs.length > 0 && uncovered.length === 0, `${verbs.length - uncovered.length}/${verbs.length}${uncovered.length ? ` — no row for ${uncovered.join(', ')}` : ''}`)
  /*
   * The jargon verbs must not appear in their own label.
   *
   * Not all of them: "Click something" contains "click" and that is the English
   * word for it, so banning the overlap outright fails the labels that are already
   * right. These four are the ones nobody outside Playwright would read — `goto` is
   * not a word, `expect` says nothing about waiting, `dblclick` is an abbreviation
   * of one, and `fill` is indistinguishable from `type` unless you know it clears
   * the field first.
   */
  const JARGON = ['goto', 'expect', 'dblclick', 'fill']
  const leaks = rowVerbs.filter(([v, label]) => JARGON.includes(v) && label.toLowerCase().includes(v))
  check('and the jargon ones are not named after the verb', leaks.length === 0, leaks.map(([v, l]) => `${v}: "${l}"`).join(', '))
  // The one the ask named: `expect` is the step nobody guesses the meaning of.
  check('`expect` reads as what it does', /verb: 'expect', label: 'Wait until something appears'/.test(ui2))
  // A key is a select, because nobody should have to guess whether it is "Esc",
  // "Escape" or "escape".
  check('keys are offered by name', /const DEMO_KEYS = \['Enter'/.test(ui2) && /f\.key/.test(ui2))

  // The builder writes markdown, which is what keeps the whole pipeline unchanged.
  check('the rows compile to a script', /function demoStepsToScript/.test(ui2) && /'```do'/.test(ui2))
  check('and a spoken line lands against its own step', /if \(say\) out\.push\(say, ''\)/.test(ui2))
  // goto and press take a bare argument; a quoted url is not a url.
  check('only the arguments that need quoting are quoted', /const bare = r\.verb === 'goto' \|\| r\.verb === 'press' \|\| action\.fields\[0\]\.num/.test(ui2))
  // Rows are data, so moving one is a splice rather than re-parenting DOM.
  check('steps can be reordered', /rows\.splice\(i - 1, 0, rows\.splice\(i, 1\)\[0\]\)/.test(ui2))
  check('and removed', /kill\.onclick = \(\) => \{\s*rows\.splice\(i, 1\)/.test(ui2))
  // An incomplete row must not compile to a half-written step.
  check('a row with an empty field is skipped', /if \(args\.some\(\(a\) => !a\)\) continue/.test(ui2))
  // Silently overwriting someone's hand edit on the next dropdown change is worse
  // than either keeping or discarding it, so the builder stands down.
  check('a hand-edited script is not overwritten', /if \(!handEdited\) script\.value = text/.test(ui2))
  check('and the generated script stays visible', /The script this writes/.test(ui2))
  // Found by a click that Playwright refused: the hint was drawn over the button.
  check('the step list does not overlap its own button', /const wrap = el\('div'\)\n\s*wrap\.style\.cssText = 'display:grid/.test(ui2))

  /*
   * And there is a way to get rows without typing at all.
   *
   * lib/demo-record.mjs was written for exactly this and wired to nothing: open the
   * app, click through it, close the window, and the clicks are the script.
   */
  check('clicking through the app writes the steps', /case "record":/.test(demoBin) && /async function recordCommand/.test(demoBin))
  check('and the browser closing is the stop signal', /context\.on\("close", finish\)/.test(demoBin))
  check('nothing recorded is an error, not an empty script', /nothing was recorded/.test(demoBin))

  /*
   * And the Record page can reach all of it.
   *
   * The CLI having a capture command is half a feature. The panel offered three of
   * the recorder's nine options and no way to script anything at all, so a demo that
   * needed a microphone, the system cursor or a driven browser meant abandoning the
   * UI and typing the command out — which is the state this whole toolkit exists to
   * get out of.
   */
  // The script is what runs, so the panel still has to send one — built from rows
  // rather than typed.
  //
  // No longer behind a summary. It was the only thing in that disclosure while
  // every control depending on it sat visible and disabled, explaining "Only
  // applies once there is a script" — six knobs nobody could enable, because the
  // switch was collapsed out of sight.
  check('the panel takes a script', /field\(scriptForm, 'Script', script, scriptHint\)/.test(ui2) && /script: script\.value/.test(ui2))
  check('and the script is not hidden behind a disclosure', !/field\(advForm, 'Script'/.test(ui2) && !/sum\.textContent = 'The script this writes'/.test(ui2))
  // Same checker the Recast page uses: a script naming a button that moved should
  // fail while you type, not fifteen seconds into a browser session.
  check('and checks it as you type', /api\/demo\/check/.test(ui2) && /DEMO_CHECK_MS/.test(ui2))
  // Through ownStep now, so it does not depend on rm-demo being on PATH.
  check('the server routes a script to rm-demo capture', /ownStep\(\s*"rm-demo",/.test(srv2) && /"capture", scriptPath/.test(srv2))
  check('and keeps openscreen record for an undriven capture', /bin: "openscreen",\s*args: \[\s*"record",/.test(srv2))
  // A script that cannot run must not reach the argv at all.
  check('a broken script is refused before anything is written', /if \(parsed\.problems\.length\) return json\(res, 400/.test(srv2))
  check('and prose with no actions is refused too', /nothing would drive the capture/.test(srv2))
  // The script is the part worth keeping; it goes on disk beside the document.
  check('the script is saved beside the document', /\$\{slug\}\.demo\.md/.test(srv2))

  // Every knob the panel offers has to reach the argv, or it is decoration.
  for (const [label, ui, srv] of [
    ['microphone', /mic: mic\.checked/, /out\.push\("--mic"\)/],
    ['a named microphone', /micDevice: micDevice\.value/, /out\.push\("--mic-device", device\)/],
    ['system audio', /systemAudio: sysAudio\.checked/, /out\.push\("--system-audio"\)/],
    ['cursor mode', /cursor: cursor\.value/, /out\.push\("--cursor", cursor\)/],
    ['base url', /url: url\.value/, /out\.push\("--url", url\)/],
    ['viewport', /width: vw\.value/, /out\.push\("--width", w\)/],
    ['headless', /headless: headless\.checked/, /out\.push\("--headless"\)/],
  ]) {
    check(`  ${label} reaches the argv`, ui.test(ui2) && srv.test(srv2))
  }
  // --mic-device implies --mic, so sending both is redundant and sending the device
  // without the flag reads as a mistake rather than a shorthand.
  /*
   * Media is named to Claude by a path it can actually open.
   *
   * The catalog stores paths relative to the project ("Audio/demo.wav") and the
   * step runs with cwd set to the render directory, so the instruction pointed at
   * <project>/media/Renders/<slug>/Audio/demo.wav — which does not exist. Claude
   * was told to use a file it could not open, found nothing, and carried on. The
   * visible result was "it ignored the audio track I gave it".
   */
  {
    const srvSrc2 = await readFile(resolve(ROOT, 'bin/rm-studio.mjs'), 'utf8')
    check('media is resolved to an absolute path', /const mediaPath = async \(rel\)/.test(srvSrc2) && /join\(mediaDir\(id\), rel\)/.test(srvSrc2))
    // The library path contains a space, so a bare path in prose has no visible end.
    check('and quoted, because the path has spaces in it', /narration track: "\$\{audio\}"/.test(srvSrc2) && /right: "\$\{webcam\}"/.test(srvSrc2))
    // Silently synthesising instead is the failure this whole path is about.
    check('substituting a synthesised voice is forbidden', /do NOT synthesise a voice/.test(srvSrc2))
    // An instruction pointing at nothing spends attention and yields silence.
    check('a missing file is reported, not named', /is not on disk — say so rather than substituting/.test(srvSrc2))
  }

  check('a named microphone is passed alone', /if \(device\) out\.push\("--mic-device", device\);\s*else if \(body\?\.mic\)/.test(srv2))
  // A mode the CLI does not have is dropped, not forwarded for it to reject.
  check('an invented cursor mode never reaches the CLI', /CURSOR_MODES\.includes\(cursor\)/.test(srv2))
  // A viewport is a window size, not an arbitrary number.
  check('the viewport is bounded', /num\(body\?\.width, 320, 7680\)/.test(srv2))
  // The browser knobs mean nothing without a script driving, and a control that
  // looks configurable but is not is worse than one that is absent.
  // Hidden rather than dimmed. A disabled control still asks to be read, and these
  // could not be enabled from anywhere on screen; absent is the honest state.
  check('the driver knobs are hidden without a script', /const driverOnly = \[url, vw, vh, headless\]/.test(ui2) && /showGroup\(c, scripted && !attached\)/.test(ui2) && /g\.style\.display = on \? '' : 'none'/.test(ui2))
  // And the group still refuses input while hidden, so a stale value cannot ride
  // along in the payload.
  check('a hidden group is also disabled', /c\.disabled = !on/.test(ui2))
  // studio.html pins every textarea to --field-tall, so `rows` renders as three.
  check('the script box is big enough to write in', /script\.style\.minBlockSize/.test(ui2))
  // The old plan said "stops on its own after 30 seconds" whether or not anything
  // was driving it, which is exactly the sentence that made the page look usable.
  // And it says which window, because the answer is not the one picked above.
  // Three states now: nothing driving, a launched browser, or the one already open.
  check('the plan says whether anything is driving', /Open a browser, drive it through the script, and record it\./.test(ui2) && /Nothing drives it/.test(ui2))

  /*
   * Every record flag the CLI documents is reachable from here.
   *
   * Read out of the fork's own help text rather than a list kept in this file: the
   * recorder will grow flags, and a hand-kept list agrees with itself for ever. Same
   * reasoning as the recast check below.
   */
  if (HAVE_OS) {
    const args = await src('electron/cli/args.ts')
    const section = args.slice(args.indexOf('Record options'), args.indexOf('Stopping a recording'))
    const documented = [...section.matchAll(/^\s{2}--([a-z-]+)/gm)].map((m) => m[1])
    // --json is always appended, never a caller's choice.
    const wanted = documented.filter((f) => f !== 'json')
    const reachable = new Set(Object.entries(capture.RECORD_FLAGS).map(([key, spec]) => spec.flag ?? key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)))
    const missing = wanted.filter((f) => !reachable.has(f))
    check('every record flag the CLI documents is reachable', wanted.length > 0 && missing.length === 0, `${wanted.length - missing.length}/${wanted.length}${missing.length ? ` — missing ${missing.join(', ')}` : ''}`)
    check('and --json is not one of them to forget', /out\.push\("--json"\)/.test(cap))
    // The cursor modes are the CLI's, not ours to invent.
    const modes = /--cursor <([a-z|-]+)>/.exec(args)?.[1]?.split('|') ?? []
    check("the cursor modes match the CLI's", modes.length > 0 && modes.every((mode) => capture.CURSOR_MODES.includes(mode)), modes.join(', '))
  }
}

console.log('\nevery recast option has a control')
{
  /*
   * The panel exposed five of playwright-recast's twenty-odd flags, which put the
   * interesting half of it — the cursor, the interpolation, the TTS model, whether
   * idle compression happens at all — behind typing the command out by hand.
   *
   * Asserted against `--help` rather than against a list written here: recast is a
   * dependency that will grow flags, and a hand-kept list would agree with itself
   * forever. Two flags are deliberately not surfaced and are named as exceptions
   * so adding one to the panel is a choice rather than an accident.
   */
  const srv = await readFile(resolve(ROOT, 'bin/rm-studio.mjs'), 'utf8')
  const ui = await readFile(resolve(ROOT, 'lib/studio.js'), 'utf8')
  const recast = srv.slice(srv.indexOf('p === "/api/recast"'), srv.indexOf('p === "/api/voice"'))

  const help = await capture(resolve(ROOT, 'node_modules/.bin/playwright-recast'), ['--help'])
  if (help.ok) {
    const flags = new Set([...help.out.matchAll(/^\s+(?:-\w,\s+)?(--[a-z-]+)/gm)].map((m) => m[1]))
    // `--input`/`--output` are the two the panel supplies itself, and `--help`
    // is not an option a panel can offer.
    for (const skip of ['--input', '--output', '--help']) flags.delete(skip)
    const missing = [...flags].filter((f) => !recast.includes(`"${f}"`))
    check('the server passes every flag recast documents', missing.length === 0, `missing ${missing.join(', ')} — recast grew a flag, or one was left out`)
    check('and there are enough of them to be worth asserting', flags.size >= 20, `${flags.size} flags`)
  } else {
    skipped++
    skips.recast = 1
    console.log('  ! playwright-recast is not installed — skipping the flag cross-check')
  }

  // A number arriving as a string or as nonsense reaches ffmpeg otherwise, and
  // recast's error for it is a filter-graph complaint several hundred lines down.
  check('out-of-range numbers are clamped rather than passed on', /Math\.min\(hi, Math\.max\(lo, n\)\)/.test(recast))
  // --no-speed turns the stage off, so sending multipliers with it describes a
  // stage that is not running.
  check('the speed multipliers are withheld when timing is kept', /if \(body\.noSpeed\) \{[\s\S]{0,120}--no-speed/.test(recast))
  // Qwen is configured entirely by file; recast exits without one.
  check('Qwen without its config is refused here', /the Qwen provider needs a --qwen-config/.test(recast))
  // An mp4 extension on a webm stream is a file most things refuse.
  check('the extension follows the format', /body\.format === "webm" \? "webm" : "mp4"/.test(recast) && /\$\{slug\}\.\$\{format\}/.test(recast))
  // rm-mux writes mp4 and is the step that reconciles the two clocks.
  check('a webm render says the mux was skipped', /muxSkipped/.test(recast) && /muxSkipped/.test(ui))

  // The dependent controls. A setting that silently does nothing reads as a
  // setting that does not work.
  check('the panel disables what the switches make meaningless', /const syncOpts = \(\) => \{/.test(ui) && /el2\.disabled = !interp/.test(ui))
  check('and disables the speed fields when timing is kept', /el2\.disabled = !speeding/.test(ui))
}

console.log('\nwhere hyperframes sits')
{
  /*
   * "I still cannot find HyperFrames" is a reasonable thing to say about a
   * dependency that has no page, no install step and a grey dot in the footer.
   * It is never installed: npx fetches it when a Make render or a voice line
   * asks, so an uncached machine is the normal state and the UI has to say that
   * rather than showing what looks like a broken tool.
   */
  const ui = await readFile(resolve(ROOT, 'lib/studio.js'), 'utf8')
  const srv = await readFile(resolve(ROOT, 'bin/rm-studio.mjs'), 'utf8')

  // Every tool the server reports needs a line explaining it, or adding one puts a
  // bare unexplained dot in the footer — which is the state this section is about.
  const reported = /tools: \{([^}]*)\}/.exec(srv)?.[1] ?? ''
  // `voice` is shorthand — `{ ..., voice }` — so a /(\w+):/ sweep misses it, and the
  // first version of this assertion passed while the one tool it should have caught
  // went unchecked. Split on commas and take the name before the colon, if any.
  const keys = reported
    .split(',')
    .map((part) => part.split(':')[0].trim())
    .filter(Boolean)
  const explained = keys.filter((k) => new RegExp(`^\\s*${k}: \\[`, 'm').test(ui))
  check('every tool in the footer says what it is for', keys.length > 0 && explained.length === keys.length, `${explained.length}/${keys.length}: missing ${keys.filter((k) => !explained.includes(k)).join(', ')}`)
  check('and what hyperframes actually is', /npx fetches it on first use/.test(ui))
  check('an uncached hyperframes is not reported as broken', /Nothing to fix/.test(ui))
  // The same distinction on the Voice page, where the old note sent you to the
  // page you were already on.
  /*
   * The two states still get different notes, but the second one is read rather
   * than assumed. It used to assert "hyperframes is not cached yet" whatever had
   * gone wrong, and that sentence was false on the machine it was written on:
   * every probe runs `npx --no-install hyperframes`, npx resolves that to whatever
   * the registry calls latest, and the day upstream publishes a release the probe
   * fails with 0.8.10 sitting perfectly well in the cache.
   */
  check('the voice fallback says which of the two things is missing', /Kokoro is not installed yet/.test(srv) && /function npxWhy/.test(srv))
  check('and it reads the reason instead of guessing', /missing packages and no YES option/.test(srv) && /npxWhy\(r\)/.test(srv))
  // A version mismatch resolves itself, so the note has to say so — synthesising
  // runs with --yes, which fetches.
  check('a newer release is named as such', /a newer release than the copy on this machine/.test(srv))
  // "It ran and gave us something that was not a list" is a different fault from
  // "it did not run", and both were reported as the latter.
  check('and a bad payload is not reported as a missing package', /hyperframes answered, but not with a voice list/.test(srv))

  /*
   * And the one failure with a fix has a button rather than an explanation.
   *
   * "hyperframes 0.8.12 is not in the npx cache — a newer release than the copy on
   * this machine" was true, actionable by nobody, and the entire answer the page
   * had. The download is one command, so the page runs it.
   */
  const ui8 = await readFile(resolve(ROOT, 'lib/studio.js'), 'utf8')
  check('a cache miss is offered a download', /fetchable: ready && Boolean\(/.test(srv) && /d\.fetchable/.test(ui8))
  // A flag, so the page never has to pattern-match a sentence to decide.
  check('and the page reads a flag, not the prose', !/note.*npx cache|indexOf\('npx cache'\)/.test(ui8))
  check('the download route asks for it', /p === "\/api\/voices\/fetch"/.test(srv) && /"--yes", "hyperframes", "tts", "--list"/.test(srv))
  // A button that succeeds and leaves the field still wrong looks broken.
  check('one click fixes it and fills the list', /return \{ ok: true, voices \}/.test(srv) && /await loadVoices\(\)/.test(ui8))
  // The probe must stay --no-install: loading a page can never pull from the network.
  check('but a page load still never fetches', /capture\("npx", \["--no-install", "hyperframes", "tts", "--list", "--json"\]\)/.test(srv))
  // The sentence a person reads has no version number in it.
  check('the message says what it costs, not what version', /needs a one-off download first/.test(srv))
  check('and no longer sends you to the page you are on', !/Set voice up under Voice/.test(srv))
}

console.log('\nthe app carries our name')
{
  /*
   * The rename is spread over three repositories, which is the reason for these.
   *
   * Two of the three files that state the display name live in the fork, and its own
   * vitest suite pins them against each other. What no test over there can see is the
   * cask: Electron derives `app.getPath("userData")` and the log directory from the
   * display name, so renaming the app moved both, and a `zap` listing only the old
   * paths quietly stops uninstalling the app's data. That is a cross-repository
   * contract, and this is the only place that reads both sides.
   *
   * The bundle name is asserted too, in the other direction: it must NOT change.
   * `app "Openscreen.app"`, the shim that execs the bundle path, and the DMG name
   * build.yml writes all depend on it, and renaming `productName` to match the brand
   * is the obvious change that breaks three things at once.
   */
  const cask = await readFile(resolve(ROOT, 'packaging/rolemodel-openscreen.rb'), 'utf8')

  if (HAVE_OS) {
    const builder = await src('electron-builder.json5')
    const about = await src('electron/about.ts')
    const display = /"CFBundleDisplayName":\s*"([^"]+)"/.exec(builder)?.[1]
    check('the app declares a display name', Boolean(display), 'CFBundleDisplayName is missing')
    check('and renders itself under the same one', about.includes(`export const PRODUCT_NAME = "${display}"`))
    // The path Electron actually writes to, spelled the way the cask has to list it.
    check('the cask zaps the directory that name creates', cask.includes(`~/Library/Application Support/${display}`) && cask.includes(`~/Library/Logs/${display}`), `zap is missing "${display}"`)
    check('and still zaps the one the old name created', cask.includes('~/Library/Application Support/Openscreen'))
    check('the bundle keeps the name the cask installs', /"productName":\s*"Openscreen"/.test(builder), 'renaming productName breaks the app stanza, the shim and the DMG name')
    // A permission prompt quotes its usage string, so an un-renamed one asks about
    // software the person has never heard of.
    check(
      'every permission prompt names this app',
      ['NSAudioCapture', 'NSMicrophone', 'NSCamera', 'NSScreenCapture'].every((k) => new RegExp(`"${k}UsageDescription":\\s*"${display} `).test(builder)),
    )
    // MIT keeps the notice; a fork that renames the app and shows only its own URL
    // leaves nobody a way to find out what they are running.
    check('the About box still credits upstream', /A RoleModel Software build of \$\{UPSTREAM_NAME\}/.test(about))
  }

  // True with or without a checkout: the caveats tell a person which app to grant
  // Screen Recording to, and macOS shows them the display name.
  check('the caveats name the app macOS will show', /grant it to RoleModel Studio/.test(cask))
}

console.log('\nopening media')
{
  // Clicking a video used to open a browser tab, which can play it — the least
  // useful thing to do with footage you are making a video out of. It goes to the
  // editor now. The editor opens documents, not videos, so a bare mp4 needs one
  // wrapped around it, and an existing sibling is preferred because it carries
  // the preset and any editing since.
  const srv = await readFile(resolve(ROOT, 'bin/rm-studio.mjs'), 'utf8')
  const ui = await readFile(resolve(ROOT, 'lib/studio.js'), 'utf8')
  const om = srv.slice(srv.indexOf('p === "/api/open-media"'), srv.indexOf('p === "/api/open"'))

  check('the endpoint exists', om.length > 400, `${om.length} chars`)
  check('it stays inside the library', /startsWith\(LIB \+ sep\)/.test(om))
  check('an existing document is reused', /\.openscreen`\)/.test(om) && /if \(!already\)/.test(om))
  check('a new one is branded before opening', /"brand", sibling/.test(om))
  check('a video card no longer opens a tab', /if \(f\.kind !== 'video'\)/.test(ui) && /api\/open-media/.test(ui))

  // One path for handing a file to the app, and it prefers the fork's verb when
  // the install has it rather than assuming either way.
  check('the open path is shared', /async function openInOpenScreen/.test(srv))
  check('it probes for the verb', /async function hasOpenVerb/.test(srv) && /openscreen\\s\+open\\s\+</.test(srv))
  check('the probe is cached', /if \(openVerb !== null\) return openVerb/.test(srv))
  check('and it does not claim to have opened when it did not', /opened: false/.test(srv) && /Drag it onto/.test(srv))
}

console.log('\ndeleting things')
{
  // A delete button in a web page has to be recoverable and hard to hit by
  // accident. Both halves are asserted, because either one alone is not enough:
  // a confirm on an unlink still loses the file to a determined mis-click.
  const srv = await readFile(resolve(ROOT, 'bin/rm-studio.mjs'), 'utf8')
  const ui = await readFile(resolve(ROOT, 'lib/studio.js'), 'utf8')
  const del = srv.slice(srv.indexOf('p === "/api/delete"'), srv.indexOf('p === "/api/script"'))

  check('the delete endpoint exists', del.length > 400, `${del.length} chars`)
  check('nothing outside the library can be touched', /startsWith\(LIB \+ sep\)/.test(del))
  check('the library itself is refused', /that is the library itself/.test(del))
  // A project root is a client's whole body of work. Deleting one has to be
  // stated, not inferred from a path that might be a typo.
  check('a project root needs an explicit kind', /isProjectRoot && body\.kind !== "project"/.test(del))
  // Recoverable: a rename into .trash, never an unlink. `.trash` is a dot
  // directory, which buildCatalog already skips, so it leaves the Library on its
  // own without a special case.
  check('it moves rather than unlinks', /await rename\(target, dest\)/.test(del) && !/\bunlink\(/.test(del))
  check('the trash lives inside the library', /join\(LIB, "\.trash"\)/.test(del))
  check('the catalog already ignores dot directories', /startsWith\("\."\)/.test(await readFile(resolve(ROOT, 'lib/library.mjs'), 'utf8')))
  check('it says where the thing went', /note:/.test(del) && /drag it back/.test(del))

  // Two clicks, and the armed state names what goes. It also forgets itself, so
  // an armed button is not left lying around for the next person at the desk.
  check('a delete has to be meant twice', /function deleteButton/.test(ui) && /if \(!armed\)/.test(ui))
  check('the armed state names the target', /Delete \$\{label\}\? Click again/.test(ui))
  check('an armed delete disarms itself', /setTimeout\(\(\) => armed && disarm\(\), DISARM_MS\)/.test(ui))
  check('the click does not also open the file underneath', /e\.stopPropagation\(\)/.test(ui.slice(ui.indexOf('function deleteButton'), ui.indexOf('function fileCard'))))
  check('a whole project passes the kind through', /kind: 'project'/.test(ui))
}

console.log('\ncard art')
{
  // The card art arrived pre-encoded and was broken three separate ways, each of
  // which is silent on its own. All three are cheap to assert and none of them
  // would have shown up as an error anywhere.
  const ui = await readFile(resolve(ROOT, 'lib/studio.js'), 'utf8')

  // 1. Interpolations that had been percent-encoded along with the markup, so
  //    the gradient stops read the literal text `$%7Bc1%7D`.
  check('no percent-encoded interpolation', !/\$%7[Bb]/.test(ui), (ui.match(/\$%7[Bb]\w+%7[Dd]/g) || []).slice(0, 2).join(', '))

  // 2. A trailing `;` inside the value. `style.backgroundImage = "url(…);"` is
  //    invalid, so the assignment is rejected and nothing is drawn at all.
  const trailing = ui.split('\n').filter((l) => /\.style\.[a-zA-Z]+ = `[^`]*;`/.test(l))
  check('no style value ends in a semicolon', trailing.length === 0, trailing.map((l) => l.trim().slice(0, 60)).join(' | '))

  // 3. A data: URL is its own document, so custom properties do not cascade
  //    into it and a `var()` inside the SVG paints black. Colours have to be
  //    resolved on this side of the boundary.
  const svgBlocks = [...ui.matchAll(/data:image\/svg\+xml[^`]*/g)].map((m) => m[0])
  check(
    'no var() survives into a data: URI',
    svgBlocks.every((b) => !b.includes('var(')),
    String(svgBlocks.length) + ' blocks',
  )
  check('tokens reach the SVG through a resolver', /function paint\(token\)/.test(ui) && /getComputedStyle\(probe\)\.color/.test(ui))

  // And the discipline that prevents all three: write the SVG plainly, encode
  // once at the end. Hand-encoded markup in the source is what hid the bugs.
  check('the SVG is encoded, not hand-escaped', !/%3Csvg/i.test(ui) && /encodeURIComponent\(svg\)/.test(ui))
  check('its gradients are linear', /<linearGradient/.test(ui) && !/radialGradient/.test(ui))
}

console.log('\ndocument errors')
{
  // A `brand` step whose `record` produced nothing used to answer with a
  // fourteen-line ENOENT stack ending in node:internal/fs/promises. Both of
  // these fail on ordinary user input, so neither may reach a stack trace.
  const themeSrc = await readFile(resolve(ROOT, 'lib/theme.mjs'), 'utf8')
  const vidSrc = await readFile(resolve(ROOT, 'bin/rm-video.mjs'), 'utf8')
  check('readProject handles a missing document', /err\.code !== "ENOENT"/.test(themeSrc))
  check('it says what the directory holds instead', /\.openscreen"\)\)/.test(themeSrc) && /readdir/.test(themeSrc))
  check('a directory handed in as a document is named as one', /EISDIR/.test(themeSrc))
  check('invalid JSON is reported as invalid JSON', /is not valid JSON/.test(themeSrc))
  check("the reader's failures exit through die()", /readProject\(projectPath\)\.catch\(\(err\) => die\(/.test(vidSrc))
  check('an unrecognised shape exits through die() too', /shape = detectShape\(doc\);[\s\S]{0,80}die\(/.test(vidSrc))

  // The chain that produced that stack. waitFor() resolves with the exit code
  // and both "run in order" loops discarded it, so `export` ran on a document
  // `brand` had just refused to open: two failures for one cause, the second
  // burying the first.
  const ui = await readFile(resolve(ROOT, 'lib/studio.js'), 'utf8')
  const waits = [...ui.matchAll(/^\s*(?:const \w+ = )?await waitFor\(/gm)].map((m) => m[0].trim())
  check('every chained wait keeps the exit code', waits.length > 0 && waits.every((w) => w.startsWith('const')), waits.join(' | '))
  check('a chain stops on a failing step', (ui.match(/if \(code !== 0\) \{/g) || []).length === waits.length, `${(ui.match(/if \(code !== 0\) \{/g) || []).length} guards for ${waits.length} waits`)
  // Every failure path has to surface something, but not in identical words: the
  // two chain buttons say "Stopped after <step>", while the demo runner says the
  // demo exited and that the Trace field was left alone. Counting one phrase made
  // the third call site a failure for being worded for its own situation.
  const guards = [...ui.matchAll(/if \(code !== 0\) \{([\s\S]*?)\n    \}/g)].map((m) => m[1])
  check('every failing wait is guarded', guards.length === waits.length, `${guards.length} guards for ${waits.length} waits`)
  check(
    'and each one tells the user what happened',
    guards.every((g) => /Stopped after|exited/.test(g)),
    guards
      .filter((g) => !/Stopped after|exited/.test(g))
      .map((g) => g.trim().slice(0, 50))
      .join(' | '),
  )
}

console.log('\ndev server')
{
  // `npm run dev` restarts the whole process on every save, and the startup path
  // runs again each time — including the browser open. An afternoon of editing
  // left a wall of Chrome windows, one per keystroke that hit disk. Under
  // --watch there is nothing to open: the tab that is already there reloads
  // itself over /live-reload.js, which is the entire point of watch mode.
  const src = await readFile(resolve(ROOT, 'bin/rm-studio.mjs'), 'utf8')
  const gate = src.split('\n').find((l) => /flag\("no-open"\)/.test(l)) ?? ''
  check('the browser open is gated', gate.length > 0, gate.trim())
  check('--watch opens no browser of its own', /!WATCH/.test(gate), gate.trim())
  check('--no-open is still honoured', /!flag\("no-open"\)/.test(gate))
  check('--open remains an escape hatch', /flag\("open"\)/.test(gate))

  // The gate above is only reached on a restart because the dev script passes
  // --watch through to the child. If that ever drops, every restart opens a
  // window again and this whole section is decoration.
  const pkg = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8'))
  check('the dev script hands --watch to the server', / --watch$/.test(pkg.scripts?.dev ?? ''), pkg.scripts?.dev)
  check('the dev script lets node restart it', /node --watch/.test(pkg.scripts?.dev ?? ''))

  // And the reload shim has to exist, or suppressing the open leaves you with
  // no way to see a change at all.
  check('the live-reload shim is a real file', (await readFile(resolve(ROOT, 'lib/live-reload.js'), 'utf8')).includes('EventSource'))
  check('watch mode injects it', (await readFile(resolve(ROOT, 'lib/studio-ui.mjs'), 'utf8')).includes('/live-reload.js'))
}

// ------------------------------------------------------------- voice setup
// The contract: nothing is installed into system Python, and the synthesiser is
// pointed at our venv on the child process rather than via a shell profile.
console.log('\nvoice setup')
{
  const vs = await import('./voice-setup.mjs')
  const nar = await readFile(resolve(ROOT, 'lib/narration.mjs'), 'utf8')

  check('the venv lives outside the repo', !vs.venvDir().startsWith(ROOT))
  check(
    'RM_VOICE_VENV can relocate it',
    (() => {
      const old = process.env.RM_VOICE_VENV
      process.env.RM_VOICE_VENV = '/tmp/__probe'
      const got = vs.venvDir()
      if (old === undefined) delete process.env.RM_VOICE_VENV
      else process.env.RM_VOICE_VENV = old
      return got === '/tmp/__probe'
    })(),
  )
  check('it installs exactly what Kokoro needs', vs.PACKAGES.join(',') === 'kokoro-onnx,soundfile')

  // Both ends of the interpreter range, because both have failed. Picking the
  // first `python3` on PATH got 3.9 and pip answered with ResolutionImpossible
  // across two dozen kokoro-onnx versions; picking the newest gets 3.14, which
  // has no wheels at all. A floor-only check would have passed for both.
  check('3.9 is rejected — pip cannot resolve Kokoro on it', !vs.pySupported(3, 9))
  check('3.14 is rejected — Kokoro has no wheels for it', !vs.pySupported(3, 14))
  check(
    'the range Kokoro actually supports is accepted',
    [10, 11, 12, 13].every((m) => vs.pySupported(3, m)),
  )
  check('python 2 is never a candidate', !vs.pySupported(2, 7))
  check('the range matches what the package declares', vs.pyRange() === '>=3.10,<3.14', vs.pyRange())
  check('the synthesiser is pointed at the venv per-process', nar.includes('ttsEnv') && /capture\("npx",[\s\S]{0,200}\{ env \}\)/.test(nar))
  // Check the pip invocation, not the prose — the file legitimately *names*
  // --break-system-packages while explaining why we don't reach for it.
  const setupSrc = await readFile(resolve(ROOT, 'lib/voice-setup.mjs'), 'utf8')
  const pipCalls = [...setupSrc.matchAll(/run\(py, \[([^\]]*)\]/g)].map((m) => m[1])
  check(
    'there is a pip install call',
    pipCalls.some((a) => a.includes('pip')),
  )
  check(
    'nothing is forced into a managed environment',
    pipCalls.every((a) => !a.includes('break-system-packages') && !a.includes('--user')),
    pipCalls.filter((a) => a.includes('break-system') || a.includes('--user')).join(' | '),
  )
  check('packages install into the venv python, never a bare pip', !/run\("pip"|capture\("pip"/.test(setupSrc))
  check('setup is idempotent when already ready', typeof vs.isReady === 'function' && typeof vs.setup === 'function')

  // A failed synth must say why. The raw output is npm warnings, a telemetry
  // notice and spinner frames; the first version surfaced a network outage as
  // three lines about a deprecated package.
  const { explainTtsFailure } = await import('./narration.mjs')
  const esc = String.fromCharCode(27)
  const netNoise = 'npm warn deprecated boolean@3.2.0\n' + `${esc}[?25l\u2502\n\u25d2  Downloading voice data (~27 MB)${esc}[1G${esc}[J\u25c7  Speech synthesis failed: getaddrinfo EAI_AGAIN github.com`
  const net = explainTtsFailure({ out: netNoise, err: '' })
  check('a network failure reads as a network failure', /network connection/.test(net), net)
  check('npm noise never reaches the user', !/npm warn|deprecated/.test(net), net)
  check('a missing venv points at the fix', /--setup --force/.test(explainTtsFailure({ err: 'The kokoro-onnx package is not installed' })))
  check('an unknown voice points at the list', /--voices/.test(explainTtsFailure({ err: 'Error: voice not found: xx_bogus' })))
  check('empty output still says something', explainTtsFailure({}).length > 10)

  // The voice list is the one thing here that can rot without failing loudly:
  // a wrong id does not error at build time, it errors for whoever picks it.
  // The offered list once contained af_bella and af_sarah, which Kokoro has
  // never shipped. Cross-check against the synthesiser when it is reachable,
  // and say so plainly when it is not rather than passing quietly.
  const listed = await capture('npx', ['--no-install', 'hyperframes', 'tts', '--list', '--json'])
  if (listed.ok && listed.out.includes('[')) {
    let real = []
    try {
      real = JSON.parse(listed.out.slice(listed.out.indexOf('['))).map((v) => v.id)
    } catch {
      /* handled by the length check below */
    }
    check("Kokoro's voice list could be read", real.length > 0, `${real.length} ids`)
    const { VOICES } = await import('./narration.mjs')
    const bogus = VOICES.map((v) => v.id).filter((id) => !real.includes(id))
    check('every voice we offer exists in Kokoro', bogus.length === 0, bogus.join(', '))
  } else {
    skipped++
    skips.hyperframes++
    console.log('  ! hyperframes is not cached yet — skipping the voice-id cross-check')
  }

  // Providers. Local stays the default, and the credential must not be able to
  // reach a place a human could read it back out of.
  {
    const nar = await import('./narration.mjs')
    check('kokoro is still the default provider', nar.DEFAULT_PROVIDER === 'kokoro', nar.DEFAULT_PROVIDER)
    check('the default provider is a local one', nar.PROVIDERS[nar.DEFAULT_PROVIDER]?.local === true)
    check('a cloud provider is unusable without a key', (await nar.hasApiKey('elevenlabs')) === Boolean(await nar.apiKeyFor('elevenlabs')))
    check(
      'every provider declares a clip extension',
      Object.values(nar.PROVIDERS).every((c) => typeof c.ext === 'string' && c.ext.length),
    )

    // The cache is keyed on the provider too. Without it, switching provider
    // with the same voice id would reuse the other provider's audio — and the
    // SRT would be measured from clips nobody asked for.
    const narSrc = await readFile(resolve(ROOT, 'lib/narration.mjs'), 'utf8')
    check('the clip cache is keyed on the provider', /update\(`\$\{provider\}::/.test(narSrc))

    // The key is read from disk by the synthesiser, never handed to a child as
    // an argument, or it would show up verbatim in the Console transcript.
    const argvSrc = (await readFile(resolve(ROOT, 'bin/rm-studio.mjs'), 'utf8')) + (await readFile(resolve(ROOT, 'bin/rm-voice.mjs'), 'utf8'))
    check('no API key is ever passed as an argument', !/--(api-?key|key)"?,\s*(apiKey|key)/i.test(argvSrc) && !/args.*apiKey/i.test(argvSrc))
    // Line-scoped, not proximity-based: the first version of this check looked
    // for apiKeyFor() within 80 characters of a json(res, ...) and fired on the
    // handler that returns {needsKey:true} and no key at all. A response that
    // serialises the key would have to name it on the line that builds the
    // response, so that is what to look for.
    const leaks = argvSrc.split('\n').filter((l) => /\bjson\(res/.test(l) && /\bapiKey\b/.test(l))
    check('no response line mentions the key', leaks.length === 0, leaks.join(' | ').slice(0, 200))
    // And status is reported by the boolean helper, not by fetching the secret.
    check('key presence is reported via hasApiKey', /hasApiKey/.test(argvSrc))

    // The shape check that turns a 400 into an answer. ElevenLabs shows a key
    // *id* beside the key and only the key starts with sk_; pasting the id was
    // the actual failure this guard exists for.
    check('a key id is refused before it is stored', Boolean(nar.keyProblem('elevenlabs', '10c4f2ab9e7d')))
    check('a real-shaped key is accepted', nar.keyProblem('elevenlabs', 'sk_abc123') === null)
    check('an empty key is refused', Boolean(nar.keyProblem('elevenlabs', '')))
    // Their auth failures arrive as 400, not 401 — mapping on status alone
    // reported a bad key as a generic bad request.
    check('auth errors are detected by type, not just status', /authentication_error/.test(narSrc))
    check('both ElevenLabs calls share one explainer', (narSrc.match(/explainElevenLabs\(/g) || []).length >= 3)

    // Every panel that offers a cloud provider must also offer somewhere to put
    // its key. The test panel offered ElevenLabs with no field anywhere, which
    // is a dead end rather than an option.
    const ui = await readFile(resolve(ROOT, 'lib/studio.js'), 'utf8')
    const offers = (ui.match(/'elevenlabs'/g) || []).length
    const fields = (ui.match(/apiKeyBlock\(/g) || []).length
    check('the key field is one shared component', fields >= 3, `${fields} references`)
    check('every panel offering ElevenLabs can take a key', fields >= 3 && offers > 0)
    check('the key field is not hidden behind needsKey', !/needsKey \?/.test(ui))

    // The Console updates in place. It used to call render() on every poll,
    // which emptied main, closed the EventSource and opened a new one that
    // replayed the whole log — three times a minute. That was the flicker, the
    // repeated connecting, and the lost scroll position, all from one line.
    // Scoped to the function body, not a fixed character window: the first
    // version read 700 characters and ran past the closing brace into code
    // that legitimately calls render(), so it failed on correct source.
    const refreshStart = ui.indexOf('async function refreshJobs')
    // Comments stripped before the check. Two earlier versions of this
    // assertion failed on correct source: one read a fixed character window and
    // ran past the closing brace, and one matched the word render() inside the
    // comment explaining why render() is not called. An assertion that fires on
    // prose is worse than no assertion.
    const refresh = ui
      .slice(refreshStart, ui.indexOf('\n}', refreshStart))
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n')
    check('polling does not re-render the console', !/\brender\(\)/.test(refresh), 'refreshJobs must not call render()')
    check('polling updates the console in place', /consoleUpdate\?\.\(\)/.test(refresh))
    check('leaving the console unregisters its updater', /consoleUpdate = null/.test(ui))
    // The stream is keyed on the selected job, so a repaint cannot reopen it.
    check('the log stream is only reattached when the selection changes', /if \(streaming === jobId\) return/.test(ui))

    // No assertion on how .runrow lays out. It was pinned to display:flex after a
    // grid version stacked the Run button above its argv, but "flex" was the fix
    // I happened to use, not the thing that matters — an auto-fill grid solves it
    // too, and pinning the implementation only fights whoever tunes the rule next.
    // What matters is visual and belongs in a browser check, not a regex.
    const page = await readFile(resolve(ROOT, 'lib/studio.html'), 'utf8')

    // Forms are Optics form groups. Every control is built through field(), so
    // there is one place that pairs a .form-label with a .form-control instead of
    // six near-identical closures appending bare elements into a flat grid.
    check('there is one form-group builder', /function field\(form, label, control, hint\)/.test(ui))
    check('no panel appends a bare label any more', !/append\(el\('label', null,/.test(ui), 'found a label with no .form-label')
    check('the group builder tags the real controls', /querySelectorAll\('input, select, textarea'\)/.test(ui))
    // No assertion on how .form .full lays out. It was pinned to "no display" after
    // a display:grid version stacked the option chips, but that rule is being tuned
    // by hand and equal-specificity cascade order decides the outcome — a regex here
    // just fails on someone's deliberate edit. The chip layout is a visual property
    // and belongs in a browser check.

    // `claude -p` in text mode prints one blob when it finishes, so a render that
    // takes minutes showed an empty Console and looked hung.
    const claudeSteps = [...argvSrc.matchAll(/bin: "claude",\s*[\s\S]{0,400}?args: \[([^\]]*)\]/g)].map((m) => m[1])
    check('there are claude steps to check', claudeSteps.length > 0, `${claudeSteps.length} found`)
    check(
      'every claude step streams its output',
      claudeSteps.every((a) => a.includes('stream-json') && a.includes('--verbose')),
      'stream-json needs --verbose beside it',
    )
    // The Console renders those events; raw NDJSON would be worse than silence.
    check('the console renders claude events', /function claudeLine\(/.test(ui))
    // A chunk boundary lands wherever the pipe flushes, so splitting each chunk
    // on newlines turned one JSON event into two unparseable halves.
    const jobsSrc2 = await readFile(resolve(ROOT, 'lib/jobs.mjs'), 'utf8')
    check('output is assembled into whole lines', /job\.partial\[stream\]/.test(jobsSrc2))
    check('a trailing fragment is flushed at exit', /flush\(job\);/.test(jobsSrc2))
    check('the line cap cannot bisect a claude event', /LINE_CAP = 64_000/.test(jobsSrc2))
  }
}

const skipWhy = [skips.fork ? `${skips.fork} for no OpenScreen checkout` : null, skips.hyperframes ? `${skips.hyperframes} because hyperframes is not cached` : null, skips.recast ? `${skips.recast} because playwright-recast is not installed` : null, skips.iconutil ? `${skips.iconutil} because iconutil could not read the .icns` : null].filter(Boolean)
const skipNote = skipped ? `, ${skipped} skipped (${skipWhy.join(', ')})` : ''
console.log(`\n${pass} passed, ${failures.length} failed${skipNote}\n`)
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exit(1)
}
