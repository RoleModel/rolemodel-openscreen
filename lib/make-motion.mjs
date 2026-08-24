/*
 * Generate brand/motion.json from the brand's own motion tokens.
 *
 *   node lib/make-motion.mjs [--check] [--brand-repo <path>]
 *
 * brand/motion.json used to be hand-written, and it was wrong in the way
 * hand-written copies of a real system always are.
 *
 * I derived it by reading the eight `--op-transition-*` values in optics.css and
 * describing what they had in common: 120-400ms, ease-in or ease-in-out, and
 * "no bounce, elastic or back easing anywhere in the system". That last claim was
 * false. Optics' transitions are UI chrome — an accordion rotating, a sidebar
 * sliding — and the brand has a separate, fuller motion system for exactly this
 * job, in rolemodel-brand/tokens/brand.json. Its scale is 100-900ms, it names its
 * curves by role, and one of them, `emphasis`, exists specifically to overshoot:
 * "the only curve allowed to overshoot". So the file told Claude never to do the
 * one thing the brand reserves for a deliberate look-at-me.
 *
 * Generated now, for the same reason brand/tokens.json is generated from the
 * Figma export rather than transcribed: a second copy of a value is a value that
 * will disagree. The prose that reaches the prompt is built from the tokens, so it
 * cannot describe timings the brand does not have.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const OUT = join(ROOT, "brand", "motion.json");

const argv = process.argv.slice(2);
const CHECK = argv.includes("--check");
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  const v = i === -1 ? null : argv[i + 1];
  return v && !v.startsWith("--") ? v : fallback;
};
const BRAND_REPO = resolve(flag("brand-repo", join(ROOT, "..", "..", "rolemodel-brand")));

/** Unwrap `{ value, name, usage }` to the value, and pass a bare value through. */
const val = (t) => (t && typeof t === "object" ? t.value : t);

/**
 * Turn the tokens into the sentences that reach Claude.
 *
 * Written from the tokens rather than beside them: every number and curve here is
 * read out of the brand, so the prompt cannot ask for a timing the brand does not
 * define. The three presets differ only in which of the brand's own values they
 * select — none of them invents one.
 */
function presets(m) {
  const d = m.duration ?? {};
  const e = m.easing ?? {};
  const dist = m.distance ?? {};
  const stagger = val(m.stagger);
  const scaleFrom = val(m.scaleFrom);
  const words = (m.character?.words ?? []).join(", ");

  const shared = [
    `Motion answers to four words: ${words}. Every choice below should be defensible against them.`,
    `Durations come from the brand's scale and nothing between: ${Object.entries(d)
      .filter(([k]) => !k.startsWith("$"))
      .map(([k, v]) => `${val(v)} (${k})`)
      .join(", ")}.`,
    `Easing is by role, not by taste. Arriving: ${val(e.enter)}. Leaving: ${val(e.exit)}. Already on screen and changing place or size: ${val(e.move)}.`,
  ];

  return {
    brand: {
      label: "Brand — the house motion",
      hint: "The brand's own scale and curves. Restrained, and allowed one overshoot where it is earned.",
      direction: [
        ...shared,
        `Most things enter at ${val(d.base)} on the enter curve, travelling ${val(dist.md)}. A nudge travels ${val(dist.sm)}; a large surface crossing real distance travels ${val(dist.lg)}.`,
        `Something popping in scales from ${scaleFrom}, not from zero.`,
        `Reveal a group as a group: ${stagger} between siblings.`,
        `${val(e.emphasis)} is the ONLY curve allowed to overshoot, and only for a deliberate look-at-me. Do not reach for it because a moment feels flat.`,
        "Once a slide has arrived it holds still. No looping, drifting or pulsing under narration.",
      ],
    },
    minimal: {
      label: "Minimal — cuts and fades",
      hint: "Nothing travels. For dense content or fast narration.",
      direction: [
        ...shared,
        `Cross-fades only, at ${val(d.fast)} on the enter curve. Nothing translates, scales, rotates or staggers.`,
        "Slides cut between each other on the beat of the narration.",
      ],
    },
    energetic: {
      label: "Energetic — quicker, more travel",
      hint: "The same curves, shorter and larger. For promos rather than walkthroughs.",
      direction: [
        ...shared,
        `Enters run at ${val(d.fast)} and may travel ${val(dist.lg)}. Exits stay on the exit curve — nobody needs to watch something leave.`,
        `Stagger tightens to about half the brand's ${stagger}.`,
        `${val(e.emphasis)} is still the only overshoot, and still only where it is earned.`,
        "Movement stops once a slide is in place. The energy is in the arrival, not in ambient drift.",
      ],
    },
  };
}

async function main() {
  let motion;
  try {
    const brand = JSON.parse(await readFile(join(BRAND_REPO, "tokens", "brand.json"), "utf8"));
    motion = brand.motion;
  } catch {
    motion = null;
  }
  if (!motion) {
    console.log(`\n  no motion tokens at ${BRAND_REPO}/tokens/brand.json`);
    console.log("  pass --brand-repo <path>, or clone rolemodel-brand beside this checkout.\n");
    process.exitCode = 1;
    return;
  }

  const strip = (o) =>
    Object.fromEntries(
      Object.entries(o ?? {})
        .filter(([k]) => !k.startsWith("$"))
        .map(([k, v]) => [k, val(v)]),
    );

  const out = {
    $comment: [
      "GENERATED by lib/make-motion.mjs from rolemodel-brand/tokens/brand.json.",
      "Do not hand-edit: retune the brand and re-run, or the two will disagree.",
      "",
      "`tokens` is the brand's motion system as-is. `presets` is the prose that",
      "reaches Claude in the Recast prompt, built from those tokens so it cannot",
      "ask for a timing the brand does not define.",
    ],
    $source: "rolemodel-brand/tokens/brand.json",
    character: motion.character?.words ?? [],
    tokens: {
      duration: strip(motion.duration),
      easing: strip(motion.easing),
      distance: strip(motion.distance),
      stagger: val(motion.stagger),
      scaleFrom: val(motion.scaleFrom),
    },
    default: "brand",
    presets: presets(motion),
  };

  const json = JSON.stringify(out, null, 2) + "\n";
  const before = await readFile(OUT, "utf8").catch(() => null);
  const same = before === json;

  console.log(`\n  ${CHECK ? "Checking" : "Generating"} brand/motion.json`);
  console.log(`  from ${BRAND_REPO}/tokens/brand.json\n`);
  console.log(`    durations  ${Object.entries(out.tokens.duration).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  console.log(`    easings    ${Object.keys(out.tokens.easing).join(", ")}`);
  console.log(`    distances  ${Object.entries(out.tokens.distance).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  console.log(`    stagger    ${out.tokens.stagger}   scale from ${out.tokens.scaleFrom}`);
  console.log(`    presets    ${Object.keys(out.presets).join(", ")}`);

  if (CHECK) {
    if (same) console.log("\n  up to date\n");
    else {
      console.log("\n  out of date. Run: npm run motion\n");
      process.exitCode = 1;
    }
    return;
  }
  if (!same) await writeFile(OUT, json);
  console.log(`\n  ${same ? "unchanged" : "written"}\n`);
}

await main();
