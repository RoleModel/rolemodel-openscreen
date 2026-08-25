/*
 * Vendor the sub-brand logos a title screen needs.
 *
 *   node lib/make-logos.mjs [--check] [--brand-repo <path>]
 *
 * Titles had no marks. A title card could set type in the brand face on a brand
 * wallpaper and still not say whose video it was, which is the one thing a title
 * card exists to do.
 *
 * The logos live in rolemodel-brand, which is a separate checkout and not a
 * dependency — so they are copied in rather than referenced. Same reason as every
 * other asset here: the Studio is hosted by a desktop app that has to render with
 * no network and no sibling checkout, and a title that reaches outside the install
 * is a title that renders as a broken image on a plane.
 *
 * Only the five brands this toolkit actually has presets or scales for are taken.
 * rolemodel-brand carries eight more (optics, compass, almanac, standard, dpq, and
 * the other Designers apps); copying those would be 600KB of SVG nothing can
 * select, and the selection is the point — `rm-video --preset` is the list.
 *
 * Each brand contributes up to five files, and which one a composition wants
 * depends only on the ground it sits on:
 *
 *   logo                the wordmark, full colour   — light grounds
 *   logo-color-on-dark  the wordmark, colour kept   — dark grounds, preferred
 *   logo-white          the wordmark, knocked out   — dark grounds, fallback
 *   logo-black          the wordmark, solid black   — high contrast
 *   icon                the mark alone, no words    — watermarks and corners
 *
 * A missing variant is recorded as null rather than substituted: a title that
 * silently swaps a colour wordmark onto a dark ground is worse than one that has
 * to ask for the mark it wants.
 */

import { createHash } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const OUT = join(ROOT, 'brand', 'logos')

const argv = process.argv.slice(2)
const CHECK = argv.includes('--check')
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  const v = i === -1 ? null : argv[i + 1]
  return v && !v.startsWith('--') ? v : fallback
}

/**
 * Where the brand repo is, and the one thing this script cannot guess.
 *
 * Defaulted as a sibling of this checkout because that is where it is on every
 * machine that has it, and overridable because "next to my other checkout" is not
 * a contract.
 */
const BRAND_REPO = resolve(flag('brand-repo', join(ROOT, '..', '..', 'rolemodel-brand')))

/**
 * The brands this toolkit can select, and where each one's files live.
 *
 * Keyed by the id used everywhere else — `rm-video --preset`, SUB_BRANDS in
 * sync-brand.mjs, the Studio's brand picker — so a logo can be looked up from a
 * preset id without a second mapping to get wrong. `stem` is the filename prefix
 * inside `dir`, which is not always the id: the Designers apps are all in one
 * directory and LightningCAD spells itself out.
 */
const BRANDS = {
  academy: { dir: 'logos/academy', stem: 'academy', label: 'Craftsmanship Academy' },
  almanac: { dir: 'logos/almanac', stem: 'almanac', label: 'Almanac' },
  compass: { dir: 'logos/compass', stem: 'compass', label: 'Compass' },
  docks: { dir: 'logos/designers', stem: 'dock-designer', label: 'Dock Designer' },
  lcad: { dir: 'logos/lightningcad', stem: 'lightningcad', label: 'LightningCAD' },
  railing: { dir: 'logos/designers', stem: 'railing-designer', label: 'Railing Designer' },
  rolemodel: { dir: 'logos/rolemodel', stem: 'rolemodel', label: 'RoleModel Software' },
  standard: { dir: 'logos/standard', stem: 'standard', label: 'Standard' },
}

/**
 * The variants looked for, in the order a composition should prefer them.
 *
 * `logo-color-on-dark` before `logo-white` for a dark ground: it keeps the brand
 * colour and only lifts the type, where the knocked-out version throws the colour
 * away. Few brands draw one, which is why white stays in the list.
 */
const VARIANTS = ['logo', 'logo-white', 'logo-black', 'icon']

const say = (s = '') => console.log(s)
const sha = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16)

/** The filename a variant has inside the brand repo. */
function sourceName(stem, variant) {
  return `${stem}-${variant}.svg`
}

async function main() {
  let repoOk = true
  try {
    await readdir(join(BRAND_REPO, 'logos'))
  } catch {
    repoOk = false
  }
  if (!repoOk) {
    say(`\n  no brand repo at ${BRAND_REPO}`)
    say('  pass --brand-repo <path>, or clone rolemodel-brand beside this checkout.\n')
    process.exitCode = 1
    return
  }

  await mkdir(OUT, { recursive: true })
  const manifest = []
  const written = new Set()
  let copied = 0
  let stale = 0

  for (const [id, { dir, stem, label }] of Object.entries(BRANDS)) {
    const entry = { id, label, variants: {} }
    for (const variant of VARIANTS) {
      const from = join(BRAND_REPO, dir, sourceName(stem, variant))
      let svg
      try {
        svg = await readFile(from)
      } catch {
        // Recorded as absent, deliberately. See the header.
        entry.variants[variant] = null
        continue
      }
      const name = `${id}-${variant}.svg`
      const to = join(OUT, name)
      written.add(name)
      entry.variants[variant] = { file: name, bytes: svg.length, sha256: sha(svg) }

      const existing = await readFile(to).catch(() => null)
      if (existing && sha(existing) === sha(svg)) continue
      stale++
      if (!CHECK) {
        await copyFile(from, to)
        copied++
      }
    }
    manifest.push(entry)
  }

  // Prune, for the reason make-wallpapers prunes: a file nobody generates any more
  // still gets served, and a mark that has been retired is exactly the kind of
  // thing that should stop appearing rather than linger.
  written.add('index.json')
  const present = await readdir(OUT).catch(() => [])
  const orphans = present.filter((f) => !written.has(f))
  if (!CHECK) for (const f of orphans) await rm(join(OUT, f), { force: true })

  const index = JSON.stringify(manifest, null, 2) + '\n'
  const before = await readFile(join(OUT, 'index.json'), 'utf8').catch(() => null)
  if (before !== index) {
    stale++
    if (!CHECK) await writeFile(join(OUT, 'index.json'), index)
  }

  say(`\n  ${CHECK ? 'Checking' : 'Vendoring'} sub-brand logos`)
  say(`  from ${BRAND_REPO}\n`)
  for (const e of manifest) {
    const have = VARIANTS.filter((v) => e.variants[v])
    const missing = VARIANTS.filter((v) => !e.variants[v])
    say(`    ${e.id.padEnd(10)} ${have.length}/${VARIANTS.length}  ${have.join(', ')}${missing.length ? `   ${'missing: ' + missing.join(', ')}` : ''}`)
  }
  if (orphans.length) say(`\n    ${CHECK ? 'orphaned' : 'pruned'}: ${orphans.join(', ')}`)

  if (CHECK) {
    if (stale) {
      say(`\n  ${stale} file(s) out of date. Run: npm run logos\n`)
      process.exitCode = 1
    } else {
      say('\n  up to date\n')
    }
    return
  }
  say(`\n  ${copied} file(s) copied into brand/logos\n`)
}

await main()
