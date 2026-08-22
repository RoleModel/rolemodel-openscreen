#!/usr/bin/env node
/**
 * rm-library — mounted project libraries.
 *
 *   rm-library init "Feeney Hershey" --remote s3 --bucket rm-video --prefix feeney
 *   rm-library mount feeney-hershey
 *   rm-library index feeney-hershey
 *   rm-library find "runway 4k"
 *   rm-library status
 *   rm-library unmount feeney-hershey
 *
 * The mount is rclone's job. This owns the manifest, the tuning, and the catalog.
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	buildCatalog,
	capture,
	defaultRoot,
	duration,
	human,
	newManifest,
	rcloneMountArgs,
	readManifest,
	run,
	search,
	writeManifest,
} from "../lib/library.mjs";

process.stdout.on("error", (e) => {
	if (e.code === "EPIPE") process.exit(0);
	throw e;
});

const argv = process.argv.slice(2);
const cmd = argv[0];
const ROOT = defaultRoot();

const flag = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	if (i === -1) return fallback;
	const next = argv[i + 1];
	return next && !next.startsWith("--") ? next : true;
};
const die = (m) => {
	console.error(`rm-library: ${m}`);
	process.exit(1);
};

const projectDir = (id) => join(ROOT, id);
const mountPoint = (id) => join(projectDir(id), "media");
const catalogPath = (id) => join(projectDir(id), "catalog.json");

async function requireRclone() {
	const { ok } = await capture("rclone", ["version"]);
	if (!ok) {
		die(
			"rclone is not installed.\n" +
				"  brew install rclone\n" +
				"  brew install --cask macfuse     # macOS needs a FUSE provider; approve it in System Settings → Privacy & Security\n" +
				"\nOn a managed Mac where kernel extensions are blocked, use Mountain Duck instead\n" +
				"and point --mount-point at the volume it creates.",
		);
	}
}

async function listProjects() {
	let entries = [];
	try {
		entries = await readdir(ROOT, { withFileTypes: true });
	} catch {
		return [];
	}
	const out = [];
	for (const e of entries.filter((x) => x.isDirectory())) {
		try {
			out.push(await readManifest(join(ROOT, e.name)));
		} catch {
			/* not a project dir */
		}
	}
	return out;
}

async function isMounted(id) {
	const mp = mountPoint(id);
	const { ok, out } = await capture("sh", ["-c", `mount | grep -F "${mp}" || true`]);
	return ok && out.trim().length > 0;
}

switch (cmd) {
	case "init": {
		const name = argv[1];
		if (!name || name.startsWith("--")) die('give the project a name, e.g. rm-library init "Feeney Hershey"');
		const remote = flag("remote", "s3");
		const bucket = flag("bucket");
		if (typeof bucket !== "string") die("--bucket is required");
		const m = newManifest({ name, remote, bucket, prefix: flag("prefix", "") || "" });
		await writeManifest(projectDir(m.id), m);
		console.log(`\n  created  ${projectDir(m.id)}/library.json`);
		console.log(`  id       ${m.id}`);
		console.log(`  remote   ${remote}://${bucket}${m.remote.prefix ? `/${m.remote.prefix}` : ""}`);
		console.log(
			`\n  configure the rclone remote once (it must be named "${m.id}"):\n    rclone config create ${m.id} ${remote}\n\n  then:  rm-library mount ${m.id}\n`,
		);
		break;
	}

	case "mount": {
		const id = argv[1];
		if (!id) die("which project? try `rm-library status`");
		await requireRclone();
		const m = await readManifest(projectDir(id));
		if (await isMounted(id)) {
			console.log(`already mounted: ${mountPoint(id)}`);
			break;
		}
		const mp = flag("mount-point", mountPoint(id));
		await run("mkdir", ["-p", mp]);
		const { src, args } = rcloneMountArgs({
			manifest: m,
			mountPoint: mp,
			cacheGb: Number(flag("cache-gb", 64)),
			readOnly: Boolean(flag("read-only", false)),
		});
		console.log(`\n  mounting ${src}\n        -> ${mp}\n`);
		const r = await run("rclone", args);
		if (!r.ok) die("rclone mount failed — see the output above");
		console.log(`  mounted. eject with:  rm-library unmount ${id}\n`);
		break;
	}

	case "unmount": {
		const id = argv[1];
		if (!id) die("which project?");
		const mp = mountPoint(id);
		// umount on macOS, fusermount -u on Linux; try both rather than sniffing.
		const a = await capture("umount", [mp]);
		if (!a.ok) await capture("fusermount", ["-u", mp]);
		console.log(`unmounted ${mp}`);
		break;
	}

	case "index": {
		const id = argv[1];
		if (!id) die("which project?");
		const dir = flag("dir", mountPoint(id));
		let n = 0;
		process.stdout.write("  indexing");
		const catalog = await buildCatalog(dir, {
			onFile: () => {
				if (++n % 10 === 0) process.stdout.write(".");
			},
		});
		process.stdout.write("\n");
		await writeFile(catalogPath(id), `${JSON.stringify(catalog, null, 2)}\n`, "utf8");

		const m = await readManifest(projectDir(id));
		m.catalog = { indexedAt: catalog.indexedAt, files: catalog.files.length, bytes: catalog.bytes };
		await writeManifest(projectDir(id), m);

		const byKind = catalog.files.reduce((acc, f) => ({ ...acc, [f.kind]: (acc[f.kind] ?? 0) + 1 }), {});
		console.log(`\n  ${catalog.files.length} files · ${human(catalog.bytes)}`);
		console.log(`  ${Object.entries(byKind).map(([k, v]) => `${v} ${k}`).join(" · ")}`);
		console.log(`  -> ${catalogPath(id)}\n`);
		break;
	}

	case "find": {
		// Take everything up to the first flag. Filtering out `--kind` alone would
		// leave its value ("video") in the query and quietly match nothing.
		const firstFlag = argv.findIndex((a, i) => i > 0 && a.startsWith("--"));
		const query = argv.slice(1, firstFlag === -1 ? undefined : firstFlag).join(" ");
		if (!query) die('what are you looking for? e.g. rm-library find "runway 4k"');
		const kind = flag("kind");
		const projects = await listProjects();
		let hits = 0;
		for (const m of projects) {
			let catalog;
			try {
				catalog = JSON.parse(await readFile(catalogPath(m.id), "utf8"));
			} catch {
				continue;
			}
			const found = search(catalog, query, { kind: typeof kind === "string" ? kind : undefined });
			if (!found.length) continue;
			console.log(`\n${m.name}`);
			for (const f of found.slice(0, 25)) {
				const v = f.media?.video;
				const meta = [
					duration(f.media?.durationSec),
					v ? `${v.width}×${v.height}` : null,
					v?.fps ? `${v.fps}fps` : null,
					human(f.bytes),
				]
					.filter(Boolean)
					.join("  ");
				console.log(`  ${f.rel}`);
				console.log(`    ${meta}`);
			}
			if (found.length > 25) console.log(`  … and ${found.length - 25} more`);
			hits += found.length;
		}
		console.log(hits ? `\n${hits} match${hits === 1 ? "" : "es"}\n` : "\nnothing found\n");
		break;
	}

	case "status": {
		const projects = await listProjects();
		if (!projects.length) {
			console.log(`\n  no projects in ${ROOT}\n  create one:  rm-library init "Name" --bucket <bucket>\n`);
			break;
		}
		console.log(`\n  ${ROOT}\n`);
		for (const m of projects) {
			const mounted = await isMounted(m.id);
			const c = m.catalog ?? {};
			console.log(`  ${mounted ? "●" : "○"} ${m.name}`);
			console.log(`    ${m.remote.type}://${m.remote.bucket}${m.remote.prefix ? `/${m.remote.prefix}` : ""}`);
			console.log(
				`    ${mounted ? "connected" : "not mounted"}` +
					(c.files ? ` · ${c.files} files · ${human(c.bytes)} · indexed ${c.indexedAt?.slice(0, 10)}` : " · not indexed"),
			);
			console.log("");
		}
		break;
	}

	default:
		console.log(
			[
				"",
				"rm-library — mounted project libraries",
				"",
				"  init <name> --bucket <b>     create a project manifest",
				"  mount <id>                   mount it (rclone + FUSE)",
				"  unmount <id>                 eject",
				"  index <id>                   ffprobe everything into a catalog",
				"  find <query>                 search every catalog",
				"  status                       what exists and what's connected",
				"",
				"Options",
				"  --remote <s3|r2|drive|...>   rclone backend type      (init)",
				"  --prefix <path>              subpath inside the bucket (init)",
				"  --cache-gb <n>               local VFS cache ceiling   (mount, default 64)",
				"  --read-only                  mount read-only           (mount)",
				"  --dir <path>                 index a folder directly   (index)",
				"  --kind <video|audio|still>   filter results            (find)",
				"",
				`Library root: ${ROOT}   (override with RM_LIBRARY_ROOT)`,
				"",
			].join("\n"),
		);
		if (cmd) process.exitCode = 1;
}
