# Vendored runtimes

Third-party code copied in rather than fetched, for the same reason as the fonts
and the marks: a render runs with no network, and a composition that reaches out
to a CDN renders as a blank frame with no error anybody sees. Studio's own page
is held to the same rule — it is a local app you can open on a plane, and a
waveform that only draws when a CDN answers is not one of its features.

| file | version | source | licence |
|---|---|---|---|
| `gsap.min.js` | 3.14.2 | npm `gsap@3.14.2` | Standard "no charge" licence — https://gsap.com/standard-license |
| `wavesurfer.min.js` | 7.12.11 | npm `wavesurfer.js@7.12.11` | BSD 3-Clause |

`gsap.min.js` sha256 (first 16): `c174bfce53a72941`

`wavesurfer.min.js` is the UMD build, so it is a plain `<script>` in Studio's
page and sets a `WaveSurfer` global. It draws the waveform for audio in the
Library player and the voice picker on Restyle — a page dependency rather than
a renderer one, which is why it is loaded by `studio.html` and never staged
into a composition.

HyperFrames compositions register a **paused** GSAP timeline on
`window.__timelines[id]` and are seeked frame by frame, exactly the way our own
components are seeked through `--t`. That is why this is here: it is a renderer
dependency, not a page dependency.

Re-vendor with `npm run vendor`.
