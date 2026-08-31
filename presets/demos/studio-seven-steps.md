# RoleModel Studio — seven steps from an idea to a link
#
# Before you run:
# - Studio is running. Pass its port with --url, e.g.
#     rm-demo run presets/demos/studio-seven-steps.md --out /tmp/demo --url http://127.0.0.1:61813
# - The CCC Days project exists and has been carried past Record, so the
#   step rail shows real progress rather than an empty pipeline. A demo of a
#   workflow has to be a workflow somebody actually finished.

/title "Seven steps to a video"
/eyebrow "ROLEMODEL STUDIO"
/sub "Idea to review link, without opening an editor"
/wallpaper rm-dark-dotgrid
/captions on

Every video the team has made lives in one library. Not a folder of exports — a project, with its footage, its script, and everything it has been rendered into so far.

```do
goto /
click "Library"
expect "All projects"
wait 2200
```

CCC Days is the one in review. Twelve videos, two stills, a gigabyte of footage from a morning of interviews.

```do
click "CCC Days"
expect "Add recording"
wait 2600
```

The raw material sits where it landed. Every clip carries its own length, resolution and frame rate, so nothing has to be opened to know what it is.

```do
wait 1800
scroll 400
wait 2000
```

The work itself is seven steps, and the app knows which one you are on. Plan, Script, Canvas, Record, Assembly, Edit, Review — with the finished ones ticked.

```do
click "Video"
expect "Create a video for CCC Days"
wait 3400
```

Planning is an interview, not a form. It asks what the video is for and who it is for, and the answers become the script.

```do
expect "Keep shaping the video"
wait 2600
```

Compose is the running order. Scenes on the shelf, footage between them, and the whole thing renders to one video rather than a timeline you have to keep in your head.

```do
click "Compose"
expect "The running order"
wait 3200
```

The brand is not applied at the end. Wallpapers, components and motion are the same ones every project draws from, so a cut looks like the company before anyone reviews it.

```do
click "Components"
wait 2600
```

And the last step is a link. A reviewer comments on the frame they mean, the note comes back into Studio, and the fix goes out as a new version on the same link — so the comments stay where they were left.

```do
click "Library"
expect "All projects"
wait 3000
```
