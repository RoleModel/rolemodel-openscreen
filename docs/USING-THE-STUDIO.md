# Making a video

This is the one to read first. It assumes nothing except that the app is
installed and open.

The other pages are for people changing the pipeline; this one is for people
using it.

## The shape of it

You work inside a **project**. A project is a folder in your library that holds
everything belonging to one piece of work: the footage, the scripts, the
narration, the renders. Choosing a project once at the top of the window is why
no panel asks you which project you mean.

Everything else follows one order:

**Library → New video → Cut → Editor → Review**

You will not always use every step. A screen recording that needs no titles goes
straight from recording to the editor.

## Start a project

The Library is the first thing you see. **New project** asks for a name, a
client and a brand, and makes the folder.

Once you are in a project, the sidebar grows a **Make a video** group. Those
panels are about the work; the Toolkit group below is about the brand and the
tools.

## Get some footage

Three ways, and the **New video** page is the chooser:

- **Record a screen** — drive a browser through a script and capture it, or
  capture a window while you work. The steps you list are what it does; the
  settings for microphone, cursor and viewport are in the right-hand column.
- **Make from a script** — write what the video says, and the browser performs
  it. Good when the "footage" is really a set of designed cards.
- **From a test** — you already have a Playwright trace, and the video is cut
  from it. Press **Load the example** to see a real one run against a public
  site before you point it at your own.

Footage you already have goes in by dropping it on the project page. The
original stays where it is; a copy lands in the project.

## Write what it says

The **Scripts** panel writes narration and outlines as markdown. Prose is what
gets spoken; a fenced block is a browser instruction and is never read aloud.

A script saved to a project appears on the project page beside the footage, with
its word count and roughly how long it takes to say. Its menu takes it onward —
into Voice to be spoken, or into Make a video to become one.

## Give it a voice

**Voice** turns a script into narration and a perfectly synced subtitle file.
The voices run on your own machine, so nothing about an unreleased client
product leaves it and there is nothing to pay for per word.

The timings are exact by construction: every line is synthesised and then
measured, so the subtitles cannot drift out of step with the audio. Edit one line
and only that line is re-made.

## Put it in order

**Cut** is where footage becomes a video. The shelf at the top is what the
project holds, shown as frames rather than filenames — a recording with no sound
says so there, where you are choosing it, rather than in the editor when you
wonder where the audio went.

Take clips off the shelf, put them in order, add titles over the top, and hand
the result to the editor. A rough in and out here is optional, and nothing is
re-encoded either way.

## Shape it

**Editor** opens the real timeline: trim handles, waveforms, zooms, cursor
treatment, captions. This is where the video is actually shaped. Cut hands it a
first assembly; the editor is where you finish.

## Send it out

**Review** publishes a cut for comment and collects what comes back. **Storage**
is where the finished thing goes — an S3 or Cloudflare R2 bucket you can browse
from inside the app, upload to by dropping files, and organise by dragging.

## The Toolkit

You need these less often, and mostly once.

- **Brand** — the marks, the colours, the clay renders, and the wallpapers that
  sit behind a recording. Drop a client's logo here and it becomes available to
  every composition.
- **Components** — the parts a scene is built from — titles, lower thirds,
  callouts, statistics, browser chrome — each shown working, with the markup
  under it.
- **Storage** — the remotes, and what is in them.
- **Console** — everything the pipeline runs, as it runs. Nothing here shows you
  a spinner: you get the command and its output.

## When something does not work

**Look at Console first.** Every long step streams there, including the exact
command. The most common causes are ordinary:

- **A tool is missing.** The dots at the bottom of the sidebar are lit for what
  is installed. A dark dot is the answer.
- **The recording has no sound.** A capture made with the microphone and system
  audio off carries no audio track at all. The Cut shelf says "silent" on the
  clips this is true of.
- **A remote will not list.** Storage's **Test** authenticates for real, which is
  the cheapest way to tell a wrong key from a wrong endpoint.

## Where things are on disk

Your library is a folder of ordinary files and you can open it in Finder at any
time. Nothing here is stored in a database, and nothing is hidden from you:

```
<your library>/
  <project-id>/
    project.json          what the project is
    media/
      Footage/            video
      Audio/              narration and music
      Stills/             images
    scripts/              what it says
    renders/              what came out
  Brand/                  logos and imagery you added
```
