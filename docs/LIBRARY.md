# Mounted project libraries

The screenshot you sent is a **mount-based** media library — files live remote,
appear as a local volume, and an editor opens a 3.8GB `.mov` without downloading
it first. That's LucidLink-shaped (Strada and Suite are the same idea). It's the
right shape for video work, and it's genuinely better than Frame.io's
upload-and-proxy model for the "open the raw footage" case.

**You can have that. You should not build it.**

## What the mount actually is

To make that volume appear you need: a per-OS filesystem driver, lazy block
fetch, a local cache with eviction, write-back with conflict handling, byte-range
prefetch tuned for sequential video reads, file locking so two editors don't
corrupt a project, and sane offline behaviour. LucidLink has spent a decade and
tens of millions of dollars on exactly that list. It is not a CCC Days project,
and a half-built network filesystem is the specific kind of thing that eats
footage.

The good news: the mount is a commodity. Three ways to get one without writing it.

| Option | Cost | Catch |
| --- | --- | --- |
| **rclone + macFUSE** | free (MIT) | macFUSE needs a kernel extension — on Apple Silicon that means reduced security and a reboot. On a managed Mac it may be blocked outright |
| **Mountain Duck** | ~$39/seat one-time | Uses macOS FileProvider on 11+, so **no kernel extension**. This is the answer if the kext is a problem |
| **LucidLink / Strada** | per-seat subscription | Buy the whole thing. Right call if the team grows past a handful of editors |

`rm-library` drives rclone today and treats the mount as swappable — the manifest
records a `driver`, so moving to Mountain Duck or a File Provider extension later
is a config change, not a migration.

## What we build

Everything above the mount, because that's where our problem actually lives:

- **A project manifest** (`library.json`) so a project is an object, not a folder
  somebody named
- **Tuned mount config** so video streams instead of stalling
- **A catalog** so footage is findable — which is the thing the marketing sync
  actually complained about

## The tuning is not optional

rclone's defaults are wrong for this workload in three ways, and each one shows
up as "the mount is unusably slow" rather than as an error:

- **`--vfs-cache-mode full`** is mandatory. Anything less and an NLE that seeks
  backwards, or writes a render in place, stalls or fails.
- **Big read chunks** (`32M`, ceiling `512M`, `--vfs-read-ahead 512M`). Video is
  a long sequential read; small chunks turn one playback into thousands of range
  requests.
- **`--dir-cache-time 24h`** with polling. Listing a bucket is a network round
  trip and editors stat constantly.

`rcloneMountArgs()` sets these. Change them knowingly.

## Use

```bash
rm-library init "Feeney Hershey" --remote s3 --bucket rm-video --prefix feeney
rclone config create feeney-hershey s3     # once, name must match the project id

rm-library mount feeney-hershey
rm-library index feeney-hershey
rm-library find "runway"          --kind video
rm-library view                   # browsable HTML page, opens in your browser
rm-library status
rm-library unmount feeney-hershey
```

`index` runs `ffprobe` over every media file — **header only**, not the whole
file. On a mounted remote a naive walk would pull gigabytes per asset and defeat
the point of mounting; ffprobe reads a few hundred KB even from a 4GB `.mov`.

Folder names are indexed as tags, because in a real media library they *are*
metadata — `Stills`, `B-Roll`, a client name.

## What this does not do yet

Search today is substring matching over filename, path, folder tags, and codec.
That answers "where's the Feeney footage." It does not answer **"find the clip
where someone demos the dashboard"** — the question that actually gets asked.

That needs enrichment, and the research already found the cheap path: shot
boundaries with PySceneDetect → one Gemini Flash call per shot producing a
structured description → write it into `entry.text`. `search()` already reads
that field, so the enrichment lands without touching the search path. Cost is
roughly **$0.27–0.81 per hour of source** — about $80–250 one-time for 300 hours,
versus ~$780 to index the same footage in a purpose-built service.

`rm-library view` is the browsable surface — one self-contained HTML file with
the catalog inlined, so it opens from disk, works offline, and can be dropped in
Slack. Cards link at the file on disk; it is a catalog, not a player. Building a
scrub-and-comment surface is the Frame.io conversation, not this one.

Also missing, in rough priority order: thumbnails (needs proxy generation),
transcript indexing, and write-back conflict warnings when two people mount the
same project.

## Why this composes

The OpenScreen skill writes recordings somewhere. If that somewhere is a mounted
project, every demo a craftsman records self-registers into the catalog on the
next `index` — and the thing the team complained about ("nobody can build on
each other's footage") stops being true without anyone changing their habits.
That's the argument for doing the library at all, and it's why the manifest
matters more than the mount.
