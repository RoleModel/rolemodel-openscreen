# RoleModel Studio — seven steps from an idea to a link
#
#   rm-demo run presets/demos/studio-seven-steps.md --out <dir> --url http://127.0.0.1:<port>
#   npx playwright-recast -i <dir>/studio-seven-steps.zip -o <dir>/studio-seven-steps.mp4 \
#       --no-speed --cursor-overlay
#
# Two things this script learned the hard way, both worth keeping.
#
# `--no-speed` on the recast. Left alone recast compresses idle time — this demo
# went 29s to 14.6s — and 75 seconds of narration then has nowhere to sit.
# rm-mux will stretch a short video to meet a long track, but past about 25%
# that turns a demo into a slideshow. The honest fix is a script whose words and
# whose picture are the same length, so the holds below are sized for sentences.
#
# The rail is clicked by `data-v`, not by its label. Every media card carries a
# VIDEO badge, so `click "Video"` matched a card and the demo sat on the wrong
# page for the rest of the take without ever failing.

/title "Seven steps to a video"
/eyebrow "ROLEMODEL STUDIO"
/sub "An idea to a link somebody can comment on"
/wallpaper rm-dark-dotgrid
/captions on

Every video the team has made lives in one library — each one a project, not a folder of exports.

```do
goto /
click "[data-v=library]"
expect "All projects"
wait 4200
```

CCC Days is the one in review. A gigabyte of footage from a morning of interviews.

```do
click "CCC Days"
expect "Add recording"
wait 4000
```

Every clip carries its own length, resolution and frame rate, so nothing has to be opened to know what it is.

```do
wait 2500
scroll 400
wait 3500
```

The work is seven steps, and the app knows which one you are on.

```do
click "[data-v=workflow]"
expect "Assembly"
wait 3200
```

Plan, Script, Canvas, Record, Assembly, Edit, Review — the finished ones ticked, the next one waiting.

```do
expect "Review"
wait 5200
```

Compose is the running order. Scenes on the shelf, footage between them, one video out.

```do
click "[data-v=compose]"
expect "Scenes"
wait 4800
```

The brand is not applied at the end. Every project draws its wallpapers, components and motion from one place.

```do
click "[data-v=components]"
wait 5000
```

And the last step is a link. A note comes back on the frame it belongs to, and the fix ships as a new version on that same link.

```do
click "[data-v=library]"
expect "All projects"
wait 4600
```
