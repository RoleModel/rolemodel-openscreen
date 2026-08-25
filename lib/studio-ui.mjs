/**
 * The Studio page. One document, no framework, no build step — plain DOM against
 * the JSON the server hands back. Kept dependency-free on purpose: this thing has
 * to survive being ignored for six months and still start.
 *
 * The markup is `studio.html`, the styles are `studio.css`, the client code is
 * `studio.js` — three real files rather than one tagged template literal. That
 * split is not cosmetic:
 *
 *   - A backtick in a CSS comment used to terminate the literal silently, and the
 *     page rendered as unstyled tags. It cost real time twice. There is no
 *     literal left to terminate.
 *   - `node --check` now covers the client code directly instead of checking the
 *     generator that happened to contain it as a string.
 *   - Editors, formatters, and `/impeccable live` can all see a real .html file.
 *
 * This module's whole job is to read that file and, under --watch, add the
 * live-reload script. It reads on every call rather than caching, so editing
 * studio.html shows up on the next reload.
 */
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export const PAGE = join(HERE, "studio.html");
export const CLIENT = join(HERE, "studio.js");
export const STYLES = join(HERE, "studio.css");
export const RELOAD = join(HERE, "live-reload.js");

/**
 * A stamp for the client code the page is about to load.
 *
 * The Studio is edited while it is being used, and a window holding yesterday's
 * studio.js looks exactly like a feature that does not work: the swatches are
 * missing, the button is gone, the panel is empty. Every one of those has been
 * reported as a bug in the feature.
 *
 * The page carries the mtime of the file it was built from, and the client asks
 * the server what that file's mtime is now. Different means the window is behind,
 * which it can then say out loud instead of leaving somebody to wonder.
 */
export async function clientStamp() {
	/*
	 * The newest of the two, because either one being stale looks the same.
	 *
	 * This watched studio.js alone, which was the whole client while the CSS was
	 * inside studio.html and therefore reloaded with the page. The styles are a
	 * separate file now, so a window can hold yesterday's stylesheet against
	 * today's markup — which reads as a broken layout, not as a stale window.
	 */
	const times = await Promise.all([stat(CLIENT), stat(STYLES).catch(() => ({ mtimeMs: 0 }))]);
	return String(Math.round(Math.max(...times.map((t) => t.mtimeMs))));
}

export async function renderStudioHTML({ watch = false } = {}) {
	const html = await readFile(PAGE, "utf8");
	const stamped = html.replace("</head>", `<meta name="rm-studio-client" content="${await clientStamp()}"/>\n</head>`);
	if (!watch) return stamped;
	const html2 = stamped;
	// Before </body> so it runs after the client script is in place, and so an
	// injected <script> from a tool that anchors on </body> stays adjacent to it.
	return html2.replace("</body>", '<script src="/live-reload.js"></script>\n</body>');
}
