/**
 * The Studio page. One document, no framework, no build step — plain DOM against
 * the JSON the server hands back. Kept dependency-free on purpose: this thing has
 * to survive being ignored for six months and still start.
 *
 * The markup and CSS live in `studio.html` and the client code in `studio.js`,
 * as real files rather than as one tagged template literal. That split is not
 * cosmetic:
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
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export const PAGE = join(HERE, "studio.html");
export const CLIENT = join(HERE, "studio.js");
export const RELOAD = join(HERE, "live-reload.js");

export async function renderStudioHTML({ watch = false } = {}) {
	const html = await readFile(PAGE, "utf8");
	if (!watch) return html;
	// Before </body> so it runs after the client script is in place, and so an
	// injected <script> from a tool that anchors on </body> stays adjacent to it.
	return html.replace("</body>", '<script src="/live-reload.js"></script>\n</body>');
}
