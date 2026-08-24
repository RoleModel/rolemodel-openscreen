---
name: RoleModel Studio
description: A dark operator's console for turning screen captures, scripts and Playwright traces into branded video.
colors:
  # Values are Optics custom properties, not hexes, and that is deliberate.
  # Optics computes every ramp in CSS from --op-color-primary-h/s/l with
  # light-dark(); a flattened copy here would be a photograph of the system that
  # stops re-tinting the moment anyone changes the hue. An earlier version of
  # this repo flattened the Figma export into 1160 static hexes and drifted a
  # little further with every Optics release. Resolved dark-mode values are in
  # comments for reference only—never paste them into code.
  page: "var(--op-color-neutral-plus-max)"        # hsl(214 4% 8%)
  panel: "var(--op-color-neutral-plus-eight)"     # hsl(214 4% 10%)
  panel-raised: "var(--op-color-neutral-plus-six)" # hsl(214 4% 16%)
  hairline: "var(--op-color-neutral-plus-four)"   # hsl(214 4% 20%)
  ink: "var(--op-color-neutral-minus-max)"        # hsl(214 4% 100%)
  ink-muted: "var(--op-color-neutral-minus-four)" # hsl(214 4% 52%)
  accent: "var(--op-color-academy-primary-base)"  # #00c278
  on-accent: "var(--op-color-academy-primary-on-base)" # #00472c
  link: "var(--op-color-primary-base)"            # hsl(214 91% 38%)
  danger: "var(--op-color-alerts-danger-minus-two)"
  info-surface: "var(--op-color-alerts-info-base)" # hsl(189 88% 32%)—teal, not Optics' blue
  info-ink: "var(--op-color-alerts-info-on-base)"
typography:
  display:
    fontFamily: "DM Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "var(--op-font-x-large)"
    fontWeight: 800
    lineHeight: 1.5
    letterSpacing: "-0.04rem"
  title:
    fontFamily: "DM Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "var(--op-font-medium)"
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: "DM Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "var(--op-font-small)"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "DM Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "var(--op-font-x-small)"
    fontWeight: 400
    letterSpacing: "0.04rem"
  machine:
    fontFamily: "Geist Mono, ui-monospace, SFMono-Regular, monospace"
    fontSize: "var(--op-font-2x-small)"
    lineHeight: 1.6
rounded:
  sm: "var(--op-radius-small)"    # 2px
  md: "var(--op-radius-medium)"   # 4px
  lg: "var(--op-radius-large)"    # 8px
  xl: "var(--op-radius-x-large)"  # 12px
  pill: "var(--op-radius-pill)"
spacing:
  xs: "var(--op-space-x-small)"   # 8px
  sm: "var(--op-space-small)"     # 12px
  md: "var(--op-space-medium)"    # 16px
  lg: "var(--op-space-large)"     # 20px
  xl: "var(--op-space-x-large)"   # 24px
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.lg}"
    padding: "8px 16px"
    typography: "{typography.body}"
  button-ghost:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "8px 16px"
  chip:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.pill}"
    padding: "4px 12px"
  chip-pressed:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.pill}"
  form-control:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    height: "40px"
  card:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.xl}"
  log:
    backgroundColor: "{colors.page}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    typography: "{typography.machine}"
---

# Design system: RoleModel Studio

## Overview

**Creative North Star: "The Edit Bay"**

The Studio is a dark instrument that sits beside the footage all day. It is pinned to `color-scheme: dark` not as a style preference but because of where it lives: on a second monitor next to a video that is the bright thing in the room. Every surface recedes so the media does not have to compete with the interface around it. When a poster frame or a wallpaper appears on screen, it should be the most saturated thing in view.

The operator is not a designer. `PRODUCT.md` records that plainly: any RoleModel engineer or PM on a client project, who needs a branded video out of work they already did without knowing Optics, ffmpeg, or the OpenScreen document format. So the interface teaches the pipeline and makes off-brand output hard to reach. Nothing here is decorative; the personality comes from precision—hairline borders, a tight type scale, monospace for anything a machine produced, and one green that means *this does something*.

It is also honest about being a console. Buttons run real commands and the exact argv sits beside them; long jobs stream their output rather than hiding behind a spinner. The design should never imply more abstraction than exists.

**Key Characteristics:**

- Dark by construction, because it shares a screen with video
- Tonal layering and hairlines—no shadows anywhere
- One accent color, used only for action and state
- Monospace as a semantic signal: this text came from a machine
- Precise and unfussy; tight radii, small type, no ornament

## Colors

A near-neutral dark ramp with a single green accent. The neutrals are not grey—Optics tints them toward the brand hue (214 at 4% saturation), which is why the page reads as very slightly cool rather than flat black. That 214 is not Optics' own default of 216: `brand/optics/rolemodel-scales.css` seeds `--op-color-primary-h/s/l` from RoleModel's Figma export, and Optics defines `--op-color-neutral-h` as `var(--op-color-primary-h)`, so the greys follow the brand hue rather than a package default. The supplement deliberately does *not* set `--op-color-neutral-s`: the export resolves the greys flat, and writing 0% over Optics' 4% would remove the tint this paragraph is about.

Every color resolves through an Optics custom property. Optics computes its ramps in CSS from three numbers with `light-dark()`, so setting one hue re-tints all 486 tokens; writing a hex here would break that and quietly drift from the system with every Optics release. The eight RoleModel sub-brand scales (academy, lcad, docks, decks, railing, building, airfield, flow) live in `brand/optics/rolemodel-scales.css`, generated from the Figma export because the open-source package does not publish them.

Ramps run `plus` toward the background and `minus` toward the foreground **in both modes**, so the mapping above is written once and stays correct if the pinned scheme is ever lifted.

- **Accent** is `academy-primary`, RoleModel's green. Optics' own "primary" is blue and is used only for informational surfaces and links.
- **Danger** appears as text on the page surface, never as a filled alarm block.
- **Orange is an accent only**—never a background. That is a brand commitment from `brand/tokens.json`, not a preference.

## Typography

Two families, doing two jobs. **DM Sans** carries everything a person wrote. **Geist Mono** carries everything a machine produced—file paths, argv, log output, timestamps, byte counts, IDs. That split is load-bearing: monospace is how you tell at a glance whether you are reading prose or a value.

The scale is Optics' (`10 / 12 / 14 / 16 / 18 / 20 / 24…`), used sparingly—most of the interface is 12px and 14px. Headings earn their weight from `800` and negative tracking rather than size. Display tracking is a negative multiple of Optics' one letter-spacing token; small-caps labels are positive multiples of the same token, so retuning it moves every heading and label together.

Line height loosens as measure widens: `1.3` on card titles, `1.5` on body, `1.6` on log output and long notes. Reading copy is capped at `70ch`.

## Layout

A fixed sidebar and a single content column. The sidebar is `208px`; the content column is capped at Optics' `x-large` breakpoint so text never runs the width of an ultrawide display.

Spacing is Optics' 4px-grid scale, and structural dimensions that Optics does not carry (sidebar width, form measure, panel heights) are named multiples of `--op-size-unit` so they sit on the same grid rather than being hand-picked pixels.

Forms are Optics `.form-group` stacks: label above control, hint beneath, one field per row. Card grids are `repeat(auto-fill, minmax(232px, 1fr))`—breakpoint-free, so the Library reflows without media queries.

## Elevation and depth

**Flat. There are no shadows in this interface, and that is a decision, not an omission.**

Depth is expressed tonally: the page is the darkest surface, panels sit one step lighter, raised panels one step lighter again, and a hairline `1px` border separates anything that needs a hard edge. On a dark UI a soft shadow reads as haze rather than height, and next to a video frame it looks like a smudge on the monitor.

The one place elevation is implied is selection: a selected card takes an accent border and a `0 0 0 1px` accent ring—a crisp edge, not a glow.

## Shapes

Tight, consistent radii from Optics: `2px` for the smallest inline tags, `4px` for controls and code blocks, `8px` for buttons and panels, `12px` for cards, and full pills for chips and badges. Nothing is a perfect circle except status dots and the New-project affordance.

Borders are always `1px` and always the hairline color, except a pressed or selected state, which promotes the border to the accent. Focus is a `2px` accent outline with a `-1px` offset so it sits inside the control rather than shifting layout.

The recurring form is a rectangle with a hairline and a modest radius. There are no organic shapes, no blobs, and **no radial gradients anywhere**—RoleModel's brand is linear, direction rather than blobs, and `npm run check` fails if a radial one reappears.

## Components

Precise and unfussy. Controls are `40px` tall, type inside them is `14px`, and padding is tight enough that a dense form fits on one screen.

- **Primary button**—accent fill, `on-accent` text, semibold. Reserved for the action that runs something. There is at most one per panel.
- **Ghost button**—panel fill, hairline border, normal weight. Everything secondary.
- **Chip**—a pill toggle carrying `aria-pressed`. Accent-filled when on. Used for filters and boolean options, never for navigation.
- **Card**—panel fill, hairline, `12px` radius, accent border on hover. Project cards lead with art (a poster frame, or a gradient built from the project's brand hue) and carry name, client and a mono footer.
- **Form group**—Optics `.form-group`: `.form-label` above `.form-control`, `.form-hint` beneath in italics. Every control is a `.form-control`; every labelled field is a group.
- **Log**—page-colored, mono, `70vh`, streams live. Errors in danger, meta lines in muted. Auto-scrolls only when already at the bottom, so reading back is not yanked away.
- **Run row**—a Run button beside the exact argv it will execute. The command is always visible; the button never hides what it does.
- **Note**—an info-surface block with a `2px` accent left edge for standing explanation. Not for errors. The edge reads teal rather than blue: `alerts-info` is seeded from RoleModel's export (189 at 88%), not from Optics' default, which reuses its primary blue.
- **Hint**—italic, `form-hint`, directly under the control it explains. Tone modifiers: ok, warn, bad.
- **Plan**—a numbered list of what is about to happen, with the real paths, shown before the buttons that do it.

## Dos and don'ts

**Do**

- Resolve every color, radius, space and weight through an Optics token
- Use monospace for anything a machine produced: paths, argv, logs, IDs, sizes
- Say what a button will do, with the real path, before it is pressed
- Keep the accent rare—action and state only
- Let long output stream; show progress rather than a spinner
- Name a structural dimension Optics lacks as a multiple of `--op-size-unit`

**Don't**

- Write a hex, a raw pixel, or a hand-picked color into the UI. `npm run check` fails on a hand-written hex in `lib/studio.html` or `lib/studio.js`
- Add a shadow. Depth is tonal here
- Use a radial gradient. The brand is linear, and the build rejects them
- Use orange as a background—accent only
- Edit `brand/optics/optics.css`. It is `@rolemodel/optics` verbatim, pinned by sha256; a formatter touching it fails the build
- Put a color on a `.note` that competes with an error
- Hide an argv behind a friendly label
