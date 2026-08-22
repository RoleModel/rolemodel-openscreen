/**
 * rm-library — mounted project libraries for RoleModel video work.
 *
 * The premise, stated plainly so nobody re-litigates it later: **we do not write
 * the filesystem.** Lazy block fetch, local cache eviction, write-back conflict
 * handling, file locking, and a per-OS driver are what LucidLink has spent a
 * decade and tens of millions of dollars on. That is not a two-day project and
 * it is not our business.
 *
 * What we build is everything *above* the mount:
 *   - a project manifest, so a "project" is a real object and not a folder someone named
 *   - tuned mount configuration, so video actually streams instead of stalling
 *   - a catalog, so footage is findable — which is the problem we actually have
 *
 * The mount itself comes from rclone (free, MIT, FUSE) or Mountain Duck
 * (commercial, no kernel extension). Both are swappable behind `driver`.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";

export const MANIFEST = "library.json";

/** Extensions we treat as library media. Everything else is a sidecar. */
const MEDIA = new Set([
	".mov", ".mp4", ".m4v", ".mkv", ".webm", ".avi", ".mxf", ".r3d", ".braw",
	".wav", ".aif", ".aiff", ".mp3", ".m4a", ".flac",
	".png", ".jpg", ".jpeg", ".tif", ".tiff", ".webp", ".exr", ".dpx",
]);

const KIND = (ext) => {
	if ([".wav", ".aif", ".aiff", ".mp3", ".m4a", ".flac"].includes(ext)) return "audio";
	if ([".png", ".jpg", ".jpeg", ".tif", ".tiff", ".webp", ".exr", ".dpx"].includes(ext)) return "still";
	return "video";
};

export function defaultRoot() {
	return process.env.RM_LIBRARY_ROOT ?? join(homedir(), "RoleModel Library");
}

/**
 * A project manifest. Deliberately small — it names the remote and nothing
 * about how the bytes get there, so swapping rclone for Mountain Duck or a
 * File Provider extension later is a `driver` change, not a migration.
 */
export function newManifest({ name, client = null, brand = "rolemodel", remote, bucket, prefix = "", driver = "rclone" }) {
	return {
		schema: 2,
		id: [client, name].filter(Boolean).join("-").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
		name,
		// Projects belong to a client. "Feeney" and "Hershey" are two clients, not
		// one project — v1 conflated them because the id was derived from the name
		// alone, which made a two-word client name indistinguishable from a project.
		client,
		brand,
		driver,
		remote: { type: remote, bucket, prefix },
		createdAt: new Date().toISOString(),
		catalog: { indexedAt: null, files: 0, bytes: 0 },
	};
}

export async function readManifest(dir) {
	return JSON.parse(await readFile(join(dir, MANIFEST), "utf8"));
}

export async function writeManifest(dir, manifest) {
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

/**
 * rclone mount arguments tuned for editing video off object storage.
 *
 * The defaults are wrong for this workload in three specific ways, and each one
 * shows up as "the mount is unusably slow" rather than as an error:
 *
 *  - `--vfs-cache-mode full` is mandatory. Anything less and an NLE that seeks
 *    backwards, or writes a render in place, either stalls or fails outright.
 *  - Large read chunks with a high ceiling. Video is a long sequential read;
 *    the default small chunks turn one playback into thousands of range requests.
 *  - A long `--dir-cache-time`. Listing a bucket is a network round trip, and
 *    an editor stats files constantly. 24h plus explicit polling is the trade.
 */
export function rcloneMountArgs({ manifest, mountPoint, cacheGb = 64, readOnly = false }) {
	const { bucket, prefix } = manifest.remote;
	const src = `${manifest.id}:${bucket}${prefix ? `/${prefix}` : ""}`;
	const args = [
		"mount", src, mountPoint,
		"--vfs-cache-mode", "full",
		"--vfs-cache-max-size", `${cacheGb}G`,
		"--vfs-cache-max-age", "72h",
		"--vfs-read-chunk-size", "32M",
		"--vfs-read-chunk-size-limit", "512M",
		"--vfs-read-ahead", "512M",
		"--buffer-size", "64M",
		"--dir-cache-time", "24h",
		"--poll-interval", "1m",
		"--transfers", "8",
		"--multi-thread-streams", "8",
		"--volname", manifest.name,
		"--daemon",
	];
	if (readOnly) args.push("--read-only");
	return { src, args };
}

export function run(cmd, args, opts = {}) {
	return new Promise((resolvePromise) => {
		const child = spawn(cmd, args, { stdio: "inherit", ...opts });
		child.on("error", (err) => resolvePromise({ ok: false, code: -1, error: err }));
		child.on("close", (code) => resolvePromise({ ok: code === 0, code }));
	});
}

export function capture(cmd, args) {
	return new Promise((resolvePromise) => {
		const child = spawn(cmd, args);
		let out = "";
		let err = "";
		child.stdout?.on("data", (d) => {
			out += d;
		});
		child.stderr?.on("data", (d) => {
			err += d;
		});
		child.on("error", (e) => resolvePromise({ ok: false, out: "", err: String(e) }));
		child.on("close", (code) => resolvePromise({ ok: code === 0, out, err }));
	});
}

/** Recursive walk that skips the noise object storage and macOS leave behind. */
export async function* walk(dir, base = dir) {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		if (e.name.startsWith(".") || e.name === "node_modules") continue;
		const full = join(dir, e.name);
		if (e.isDirectory()) {
			yield* walk(full, base);
		} else if (e.isFile()) {
			yield { full, rel: full.slice(base.length + 1) };
		}
	}
}

/**
 * ffprobe one file into catalog fields.
 *
 * Deliberately does NOT read the whole file — on a mounted remote that would
 * pull gigabytes per asset and defeat the point of mounting. ffprobe reads the
 * header and the index, which is a few hundred KB even for a 4GB .mov.
 */
export async function probe(path) {
	const { ok, out } = await capture("ffprobe", [
		"-v", "quiet",
		"-print_format", "json",
		"-show_format",
		"-show_streams",
		path,
	]);
	if (!ok) return null;
	let data;
	try {
		data = JSON.parse(out);
	} catch {
		return null;
	}
	const v = data.streams?.find((s) => s.codec_type === "video");
	const a = data.streams?.find((s) => s.codec_type === "audio");
	const fpsParts = (v?.r_frame_rate ?? "").split("/").map(Number);
	const fps = fpsParts.length === 2 && fpsParts[1] ? +(fpsParts[0] / fpsParts[1]).toFixed(3) : null;
	return {
		durationSec: data.format?.duration ? +Number(data.format.duration).toFixed(2) : null,
		container: data.format?.format_name ?? null,
		video: v ? { codec: v.codec_name, width: v.width, height: v.height, fps } : null,
		audio: a ? { codec: a.codec_name, channels: a.channels, sampleRate: Number(a.sample_rate) || null } : null,
	};
}

/** Build (or refresh) the catalog for a mounted project directory. */
export async function buildCatalog(root, { onFile } = {}) {
	const files = [];
	let bytes = 0;
	for await (const { full, rel } of walk(root)) {
		const ext = extname(full).toLowerCase();
		if (!MEDIA.has(ext)) continue;
		const s = await stat(full);
		const kind = KIND(ext);
		const entry = {
			rel,
			name: basename(full),
			ext,
			kind,
			bytes: s.size,
			mtime: s.mtime.toISOString(),
			// Folder names are real metadata in a media library — "Stills",
			// "B-Roll", a client name. Index them as searchable terms.
			tags: rel.split("/").slice(0, -1).filter(Boolean),
			media: kind === "still" ? null : await probe(full),
		};
		bytes += s.size;
		files.push(entry);
		onFile?.(entry);
	}
	files.sort((x, y) => x.rel.localeCompare(y.rel));
	return { schema: 1, indexedAt: new Date().toISOString(), files, bytes };
}

/**
 * Search the catalog. Plain substring matching over name, path, tags, and
 * codec — enough to answer "where's the Feeney footage" today.
 *
 * The layer this is missing is transcript and per-shot description, which is
 * what turns it into "find the clip where someone demos the dashboard." That
 * enrichment writes into `entry.text`, and this already searches it.
 */
export function search(catalog, query, { kind } = {}) {
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
	return catalog.files.filter((f) => {
		if (kind && f.kind !== kind) return false;
		const hay = [
			f.rel,
			f.name,
			...(f.tags ?? []),
			f.media?.video?.codec,
			f.media?.audio?.codec,
			f.text ?? "",
		]
			.filter(Boolean)
			.join(" ")
			.toLowerCase();
		return terms.every((t) => hay.includes(t));
	});
}

export function human(bytes) {
	const u = ["B", "KB", "MB", "GB", "TB"];
	let i = 0;
	let n = bytes;
	while (n >= 1024 && i < u.length - 1) {
		n /= 1024;
		i++;
	}
	return `${n.toFixed(n < 10 && i > 0 ? 2 : 0)} ${u[i]}`;
}

export function duration(sec) {
	if (sec == null) return "—";
	const h = Math.floor(sec / 3600);
	const m = Math.floor((sec % 3600) / 60);
	const s = Math.floor(sec % 60);
	return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export { MEDIA, resolve };
