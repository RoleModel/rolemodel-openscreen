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
 *   title.html                a title card that already uses all of the above
 *
 * theme.css is generated from brand/tokens.json every time rather than kept as a
 * file, because tokens.json is itself generated from the Figma export — a checked-in
 * copy of it would be the third generation of the same values and the one that goes
 * stale.
 */

import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { IGNORE_MARKER } from "./library.mjs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

/** The faces a composition may set type in. Both variable, both vendored. */
// Space Grotesk is the Academy face, and it travels with the others: a render
// that has to fetch a font from the network captures the fallback rather than
// waiting, and reports nothing.
const FONTS = ["DMSans-Variable-latin.woff2", "GeistMono-Variable.woff2", "SpaceGrotesk-Variable-latin.woff2"];

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
function marksFor(brand, index) {
  const wanted = brand === "rolemodel" ? ["rolemodel"] : [brand, "rolemodel"];
  const files = [];
  for (const id of wanted) {
    const entry = index.find((b) => b.id === id);
    if (!entry) continue;
    for (const variant of Object.values(entry.variants)) {
      if (variant?.file) files.push(variant.file);
    }
  }
  return [...new Set(files)];
}

export async function stageRenderAssets(dir, { brand = "rolemodel", quiet = false } = {}) {
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

  for (const font of FONTS) {
    await copyFile(join(ROOT, "brand", "fonts", font), join(fontDir, font));
  }
  // The licences travel with the faces. They are OFL: redistributing the woff2
  // without them is the one thing the licence actually asks of us.
  for (const f of await readdir(join(ROOT, "brand", "fonts"))) {
    if (f.startsWith("OFL")) await copyFile(join(ROOT, "brand", "fonts", f), join(fontDir, f));
  }

  const tokens = JSON.parse(await readFile(join(ROOT, "brand", "tokens.json"), "utf8"));
  const template = await readFile(join(ROOT, "templates", "theme.css"), "utf8");
  const { css, missing } = fillTheme(template, tokens);
  await writeFile(join(out, "theme.css"), css);

  const title = await readFile(join(ROOT, "templates", "title.html"), "utf8");
  // Point the staged card at a mark this brand actually has, preferring one that
  // works on the dark ground the card draws.
  const entry = index.find((b) => b.id === brand);
  const preferred =
    entry?.variants["logo-color-on-dark"] ?? entry?.variants["logo-white"] ?? entry?.variants.logo;
  const titleOut = preferred
    ? title.replace("assets/brand/rolemodel-logo-color-on-dark.svg", `assets/brand/${preferred.file}`)
    : title;
  await writeFile(join(out, "title.html"), titleOut);

  say(`\n  staged the ${brand} brand into ${out}\n`);
  say(`    assets/brand/          ${marks.length} marks`);
  say(`    assets/brand/fonts/    ${FONTS.length} faces (+ licences)`);
  say(`    theme.css              tokens as custom properties`);
  say(`    title.html             a title card using both`);
  if (preferred) say(`\n    the card uses ${preferred.file}`);
  if (missing.length) say(`\n    ! no token for: ${missing.join(", ")} — left as placeholders`);
  say("");
  return { marks, missing };
}
