# Vendored runtimes

Third-party code copied in rather than fetched, for the same reason as the fonts
and the marks: a render runs with no network, and a composition that reaches out
to a CDN renders as a blank frame with no error anybody sees.

| file | version | source | licence |
|---|---|---|---|
| `gsap.min.js` | 3.14.2 | npm `gsap@3.14.2` | Standard "no charge" licence — https://gsap.com/standard-license |

`gsap.min.js` sha256 (first 16): `c174bfce53a72941`

HyperFrames compositions register a **paused** GSAP timeline on
`window.__timelines[id]` and are seeked frame by frame, exactly the way our own
components are seeked through `--t`. That is why this is here: it is a renderer
dependency, not a page dependency.

Re-vendor with `npm run vendor`.
