/*
 * Stage the brand into a render directory.
 *
 * `rm-video assets <dir> [--brand <id>]`
 *
 * The logos, fonts and tokens were vendored into brand/ and then nothing could
 * reach them. A HyperFrames render runs in a project directory somewhere under the
 * library, not inside this toolkit and not behind the Studio's HTTP server, so a
 * composition that referenced brand/ resolved to nothing and a title card came out
 * with system type and no mark.
 *
 * So the assets are copied next to the composition that uses them. Copied, not
 * symlinked: the render loads them through a headless browser, which follows a
 * relative URL and not a link out of the tree, and the render directory is also
 * what gets archived with the project.
 *
 * What lands in <dir>:
 *
 *   assets/brand/*.svg        the marks for the chosen brand, plus rolemodel
 *   assets/brand/fonts/*      DM Sans, Geist Mono and Space Grotesk, variable, woff2
 *   theme.css                 tokens as CSS custom properties
 *
 * theme.css is generated from brand/tokens.json every time rather than kept as a
 * file, because tokens.json is itself generated from the Figma export — a checked-in
 * copy of it would be the third generation of the same values and the one that goes
 * stale.
 */

import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { defaultRoot, IGNORE_MARKER } from "./library.mjs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

/** The faces a composition may set type in. Both variable, both vendored. */
// Space Grotesk is the Academy face, and it travels with the others: a render
// that has to fetch a font from the network captures the fallback rather than
// waiting, and reports nothing.
const FONTS = ["DMSans-Variable-latin.woff2", "GeistMono-Variable.woff2", "SpaceGrotesk-Variable-latin.woff2"];

/* A composition needs a real local ground even if its caller did not expose a
 * wallpaper picker. These files are the same published backgrounds Studio
 * offers, never a CSS approximation of the brand. */
const DEFAULT_WALLPAPER = {
  academy: "academy-ruby.jpg",
  lightning: "lcad-board.jpg",
  rolemodel: "rm-brand.jpg",
};

/**
 * Fill theme.css from the tokens.
 *
 * A placeholder that has no token is left as-is rather than emptied: a CSS custom
 * property set to nothing silently falls back to the initial value, which is how a
 * title ends up with a transparent background nobody can explain.
 */
function fillTheme(template, tokens) {
  const p = tokens.palette ?? {};
  const s = tokens.surfaces ?? {};
  const a = tokens.annotationScale ?? {};
  const map = {
    PRIMARY: p.primary,
    SECONDARY: p.secondary,
    ACCENT: p.accent,
    DARK: p.dark,
    LIGHT: p.light,
    NEUTRAL: p.neutral,
    TITLE: a.title,
    HEADING: a.sectionHeading,
    EYEBROW: a.eyebrow,
    LOWERTHIRD: a.lowerThirdTitle,
    GRIDSIZE: s.gridSize,
    // A percentage, because color-mix wants one and the token is a fraction.
    DOTPCT: s.dotOpacity == null ? null : Math.round(s.dotOpacity * 100),
  };
  let out = template;
  const missing = [];
  for (const [key, value] of Object.entries(map)) {
    if (value == null) {
      missing.push(key);
      continue;
    }
    out = out.replaceAll(`__${key}__`, String(value));
  }
  return { css: out, missing };
}

/**
 * Which marks to stage.
 *
 * The chosen brand, and rolemodel alongside it unless that is the choice — a
 * sub-brand video still tends to want "a RoleModel product" somewhere, and having
 * it already staged is the difference between using it and not.
 */
/*
 * Every mark in the library, not just this composition's brand.
 *
 * This staged the render's own brand and, for a sub-brand, RoleModel underneath
 * it — four files for a RoleModel render out of twenty-six that exist. Which
 * meant a title card could carry the house mark and nothing else could carry
 * anything: an Almanac logo in a shader, a Compass icon over a demo, two marks
 * side by side on a partnership card were all impossible from inside a
 * composition, and the reason was invisible — the file simply was not there.
 *
 * All of them is 250KB of SVG, once, into a folder that already holds four
 * typefaces. That is not a size worth trading a capability for. The brand order
 * still matters and is preserved: this composition's brand first, RoleModel
 * next, so anything picking "the first mark" picks the right one.
 */
function marksFor(brand, index) {
  const first = brand === "rolemodel" ? ["rolemodel"] : [brand, "rolemodel"];
  const order = [...first, ...index.map((b) => b.id).filter((id) => !first.includes(id))];
  const files = [];
  for (const id of order) {
    const entry = index.find((b) => b.id === id);
    if (!entry) continue;
    for (const variant of Object.values(entry.variants)) {
      if (variant?.file) files.push(variant.file);
    }
  }
  return [...new Set(files)];
}

export async function stageRenderAssets(dir, { brand = "rolemodel", wallpaper = null, quiet = false } = {}) {
  const say = (s) => {
    if (!quiet) console.log(s);
  };
  const out = resolve(dir);
  const assetsDir = join(out, "assets");
  const brandDir = join(assetsDir, "brand");
  const fontDir = join(brandDir, "fonts");
  await mkdir(fontDir, { recursive: true });
  /*
   * Say what this directory is, so the catalog leaves it alone.
   *
   * Everything under here is a copy the renderer needs and the user did not put
   * there; indexed as project media it showed up as the project's own stills —
   * one per render at first, and eleven more once the clay imagery was staged.
   */
  await writeFile(
    join(assetsDir, IGNORE_MARKER),
    "Staged by lib/render-assets.mjs for the renderer. Not project media; not indexed.\n",
    "utf8",
  );

  const index = JSON.parse(
    await readFile(join(ROOT, "brand", "logos", "index.json"), "utf8").catch(() => "[]"),
  );
  const known = index.map((b) => b.id);
  if (!known.includes(brand)) {
    throw new Error(`unknown brand "${brand}" — have: ${known.join(", ")}`);
  }

  const marks = marksFor(brand, index);
  for (const file of marks) {
    await copyFile(join(ROOT, "brand", "logos", file), join(brandDir, file));
  }
  /* The index beside the marks, so a component can ask what it has rather than
     guessing a filename. A composition is opened from its own folder with no
     server, so this is the only way it can know. */
  await writeFile(join(brandDir, "logos.json"), `${JSON.stringify(index, null, 2)}\n`, "utf8");

  /*
   * A generated composition is opened from its own folder, not through
   * Studio's HTTP server. Stage the actual image beside it so the iframe, local
   * renderer, and a copied project all use the same wallpaper offline. Only an
   * entry from the published index is accepted, so persisted settings cannot
   * turn into an arbitrary filesystem path.
   */
  const wallpapers = JSON.parse(
    await readFile(join(ROOT, "brand", "wallpapers", "index.json"), "utf8").catch(() => "[]"),
  );
  const wantedWallpaper = String(wallpaper ?? "").trim();
  const fallbackWallpaper = DEFAULT_WALLPAPER[brand] ?? DEFAULT_WALLPAPER.rolemodel;
  const selectedWallpaper = wallpapers.find((item) => item?.file === wantedWallpaper || item?.name === wantedWallpaper)
    ?? wallpapers.find((item) => item?.file === fallbackWallpaper)
    ?? null;
  if (selectedWallpaper?.file) {
    const wallpaperDir = join(assetsDir, "wallpapers");
    await mkdir(wallpaperDir, { recursive: true });
    await copyFile(join(ROOT, "brand", "wallpapers", selectedWallpaper.file), join(wallpaperDir, selectedWallpaper.file));
  }

  /*
   * The clay renders, alongside the marks.
   *
   * Staged for every brand rather than only academy: a title is free to put an
   * Academy keyboard on a RoleModel card, and the renderer cannot fetch one later
   * — it draws from this directory with no network. Eleven files under 2MB is
   * cheaper than the class of bug where a composition references an image nobody
   * copied and renders a broken plane.
   */
  const imageryDir = join(out, "assets", "imagery");
  const imagery = JSON.parse(
    await readFile(join(ROOT, "brand", "imagery", "index.json"), "utf8").catch(() => '{"imagery":[]}'),
  ).imagery;
  if (imagery.some((i) => i.file)) {
    await mkdir(imageryDir, { recursive: true });
    for (const item of imagery) {
      if (!item.file) continue;
      await copyFile(join(ROOT, "brand", "imagery", item.file), join(imageryDir, item.file));
    }
  }

  /*
   * And anything added through the Brand page, which lives in the library.
   *
   * Staged into the same directory as the vendored imagery, so a composition
   * names an added client logo exactly the way it names a clay render and does
   * not have to know which of the two it got. They cannot collide: the upload
   * route renames rather than replacing, and these are the only files in there
   * it wrote.
   *
   * A missing library, or a listed file that is not on disk, costs the render
   * that one picture — never the whole render. Somebody deleting a logo in
   * Finder should not turn every future render into a stack trace.
   */
  const addedDir = join(defaultRoot(), "Brand");
  const added = JSON.parse(
    await readFile(join(addedDir, "index.json"), "utf8").catch(() => '{"added":[]}'),
  ).added;
  if (added?.length) {
    await mkdir(imageryDir, { recursive: true });
    for (const item of added) {
      if (!item.file) continue;
      await copyFile(join(addedDir, item.file), join(imageryDir, item.file)).catch(() => {});
    }
  }

  for (const font of FONTS) {
    await copyFile(join(ROOT, "brand", "fonts", font), join(fontDir, font));
  }
  // The licences travel with the faces. They are OFL: redistributing the woff2
  // without them is the one thing the licence actually asks of us.
  for (const f of await readdir(join(ROOT, "brand", "fonts"))) {
    if (f.startsWith("OFL")) await copyFile(join(ROOT, "brand", "fonts", f), join(fontDir, f));
  }

  /*
   * GSAP travels with the composition rather than being pulled from a CDN.
   * Transitions are GSAP tweens, so a render on a machine without a network — or
   * behind a proxy that blocks jsdelivr — would otherwise silently lose every
   * dissolve and still exit zero.
   */
  const vendorDir = join(out, "assets", "vendor");
  await mkdir(vendorDir, { recursive: true });
  await copyFile(join(ROOT, "brand", "vendor", "gsap.min.js"), join(vendorDir, "gsap.min.js"));

  /*
   * Optics' tokens, beside the theme that imports them.
   *
   * The TOKENS, not the stylesheet. brand/optics/*.css is the whole Optics
   * component library — a CSS reset over `*`, rules on html and body, and some
   * three hundred component classes. A composition is not an Optics document and
   * has never been laid out against that reset; dropping it in would restyle
   * every render to fix a colour. Only the :root blocks come across, which is
   * exactly the custom properties and nothing that draws.
   *
   * Both files, because Studio's own /optics.css route serves both concatenated
   * and a component cannot tell which half a token came from: optics.css holds
   * the neutral and structural palette, rolemodel-scales.css every brand ramp.
   * Staging only the first left --op-color-academy-primary-base unset, which is
   * the token the study field asks for as its brand colour.
   */
  const opticsRoots = [];
  for (const file of ["optics.css", "rolemodel-scales.css"]) {
    const css = await readFile(join(ROOT, "brand", "optics", file), "utf8").catch(() => "");
    for (const block of css.matchAll(/^:root\s*\{[^}]*\}/gms)) opticsRoots.push(block[0]);
  }
  await writeFile(
    join(assetsDir, "optics.css"),
    `/*\n * Optics' custom properties, staged for this composition.\n *\n * GENERATED by lib/render-assets.mjs — the :root blocks of brand/optics/*.css\n * and nothing else. The component classes and the reset are deliberately left\n * behind: a composition is not an Optics document.\n */\n${opticsRoots.join("\n\n")}\n`,
  );

  const tokens = JSON.parse(await readFile(join(ROOT, "brand", "tokens.json"), "utf8"));
  const template = await readFile(join(ROOT, "templates", "theme.css"), "utf8");
  const { css, missing } = fillTheme(template, tokens);
  await writeFile(join(out, "theme.css"), css);

  /*
   * No title-card starter is staged.
   *
   * It was a copy-me example: a card already wired to the brand mark, the
   * vendored faces and theme.css, for a person or an agent to duplicate. No
   * composition ever referenced one — the palette has rm-title and the
   * designers build a card interactively — and it cost more than it gave. It
   * carried a data-composition-id, so HyperFrames discovered it as a second
   * composition in every project; two functions existed only to delete or move
   * it afterwards; and it produced two lint errors of its own.
   *
   * templates/title.html stays in the repo as the reference it always was. It
   * is just not copied into every render.
   */

  say(`\n  staged the ${brand} brand into ${out}\n`);
  say(`    assets/brand/          ${marks.length} marks from ${index.length} brands`);
  say(`    assets/brand/fonts/    ${FONTS.length} faces (+ licences)`);
  if (selectedWallpaper?.file) say(`    assets/wallpapers/     ${selectedWallpaper.file}`);
  say(`    assets/optics.css      the full Optics palette`);
  say(`    theme.css              tokens as custom properties`);
  if (missing.length) say(`\n    ! no token for: ${missing.join(", ")} — left as placeholders`);
  say("");
  return { marks, missing, wallpaper: selectedWallpaper?.file ?? null };
}


/*
 * The runtime, as a composition needs it.
 *
 * A composition's copy sits two directories deeper than the repo's, so the
 * marks it masks are reached by a different path. One base string carries every
 * mark rather than one rewrite per file name.
 *
 * Here rather than in the server or in rm-resync, because both stage the same
 * runtime and both had their own copy of this substitution — so a change to how
 * marks resolve reached one of them and not the other, and the composition
 * staged by the wrong one pointed at nothing.
 */
export function stagedRuntime(source) {
	return source.replace("const LOGO_BASE = '../brand/logos/'", "const LOGO_BASE = '../brand/'");
}
