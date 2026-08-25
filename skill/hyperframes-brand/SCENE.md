# Authoring a scene

You are writing the **body of one scene** — the markup that goes inside
`<rm-scene>`. Everything around it is supplied: the brand faces, Optics, the
stage at a real 1920×1080, a page that cannot scroll, and `RM.ready()` before the
first frame. Do not write `<!doctype>`, `<html>`, `<head>`, `<body>`, or
`<rm-scene>` — the wrapper writes them, and a second copy breaks the render.

Write the body and nothing else. No prose around it, no fences.

## Time is seeked, not played

The renderer sets one custom property, `--t`, and screenshots. It never lets an
animation run. So:

- **Never use `animation`, `transition`, `@keyframes` with `animation-play-state`,
  `setTimeout`, `requestAnimationFrame`, or anything that advances on its own.**
  A frame produced that way is different on every run, and the render comes out
  juddering for reasons that cannot be reproduced.
- The supplied components already do this correctly. If you write your own
  motion, drive it from `var(--t)` — a `calc()` off `--t` is the whole technique.
- Frame N must be identical on every render. That is the test.

## What is available

Components, each timed by `at` (ms it appears) and `for` (ms it stays):

| tag | fields |
|---|---|
| `rm-title` | `eyebrow`, `title`, `sub`, `align` |
| `rm-lower-third` | `name`, `sub`, `side` |
| `rm-browser` | `url`, `image`, `src`, `w`, `dark` |
| `rm-callout` | `text`, `x`, `y`, `side` |
| `rm-stat` | `value`, `label`, `unit`, `count` |
| `rm-bullets` | `heading`, `stagger` |

Position with `style="left:8%; top:14%"`. Sizes in `cqw` follow the stage scale,
so a scene composed at 1080p is identical at 4K — use `cqw`, not `px`.

A `<style>` block in the body is expected and supported. Use it. You are not
limited to the components; they are the shortcut, not the ceiling.

## Values come from the tokens

Never invent a colour, a font, a duration, or an easing curve. Use the CSS
custom properties Optics and the brand theme already define — `var(--fg)`,
`var(--muted)`, `var(--brand)`, `var(--surface)`, `var(--line)`, and the
`--duration-*` / `--ease-*` motion tokens. A literal hex in a scene is a bug.

The type scale is in `design.md`. Read it before setting anything.

## The constraints that get broken most

These are binding. They are in `design.md` in full; these three are the ones
that get reached for anyway:

- **No decorative rules, underlines, or dividers.** No underline under a
  heading, no keyline between sections, no border around a card, stat, quote, or
  lower third. Separation comes from space, weight, and ground. The one
  sanctioned rule is the short brand bar under a title, and `rm-title` draws it.
- **No frame wipes**, and nothing that draws a box around the frame.
- **No radial gradients.** The brand is linear.

## Length

The scene runs as long as its furthest `at + for`. Give every timed element a
`for` unless you mean it to stay to the end. Around 2.5–6s is a card; longer than
that and it is a sequence, which is several scenes.

## Before you finish

Read what you wrote and check each of these, because they are the ones that pass
review and fail the render:

1. No `<html>`, `<head>`, `<body>`, or `<rm-scene>` wrapper.
2. Nothing that animates on its own — everything is `--t` or a component.
3. No literal colours, fonts, durations, or easing curves.
4. No underline, keyline, divider, or border added for looks.
5. Sizes in `cqw`, not `px`.
