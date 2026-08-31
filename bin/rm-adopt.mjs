#!/usr/bin/env node
/*
 * The round trip between OpenScreen and a HyperFrames composition, from a script.
 *
 *   rm-adopt <projectId> <folder> --emit            send the cut to OpenScreen
 *   rm-adopt <projectId> <folder> [--from <doc>]    bring an edited one back
 *   rm-adopt <projectId> <folder> --watch           …and keep doing that on save
 *   rm-adopt <projectId> <folder> --dry             say what it would do
 *
 * Studio's HyperFrames panel does all of this from buttons, and that is where
 * this belongs for anybody editing video. This exists for the other case: a
 * script, a batch over several compositions, a machine with no window open.
 * Both call lib/adopt.mjs, so there is one set of rules about who wins on what.
 */
import { watch } from "node:fs";
import { adoptCut, emitCut, findDocument, planAdopt } from "../lib/adopt.mjs";

const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);
const flag = (name, fallback = null) => {
	const i = argv.indexOf(`--${name}`);
	return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const die = (message) => {
	console.error(`rm-adopt: ${message}`);
	process.exit(1);
};

const from = flag("from");
const positional = argv.filter((arg, i) => !arg.startsWith("--") && argv[i - 1] !== "--from");
const [projectId, folder = "canvas-pip-transcript"] = positional;
if (!projectId) die("usage: rm-adopt <projectId> <folder> [--emit | --from <doc>] [--watch] [--dry]");

const guard = async (work) => {
	try {
		return await work();
	} catch (error) {
		die(error.message);
	}
};

if (has("emit")) {
	const out = await guard(() => emitCut({ projectId, folder }));
	console.log(`  wrote ${out.document}`);
	console.log(`  ${out.clips} clips · ${out.seconds.toFixed(3)}s${out.lead ? ` · ${out.lead.toFixed(3)}s lead-in held back` : ""}`);
	console.log("  open it in OpenScreen, edit, save — then bring it back.");
} else if (has("dry")) {
	const plan = await guard(() => planAdopt({ projectId, folder, from }));
	console.log(`  ${plan.docPath}`);
	for (const clip of plan.clips) {
		console.log(
			`  ${clip.src.padEnd(26)} ${clip.start.toFixed(3).padStart(8)} → ${(clip.start + clip.dur).toFixed(3).padStart(8)}  from ${clip.ms.toFixed(2)}s  ${clip.speaker ?? "—"}`,
		);
	}
	console.log(`  ${plan.was} clips → ${plan.clips.length}`);
} else {
	const report = (out) => {
		console.log(`  ${out.was} clips → ${out.clips.length} · ${out.words} words · ${out.seconds.toFixed(3)}s`);
		for (const note of out.notes) console.log(`  clamped — ${note}`);
	};
	report(await guard(() => adoptCut({ projectId, folder, from })));

	if (has("watch")) {
		const docPath = await guard(() => findDocument({ projectId, folder, from }));
		console.log(`\n  watching ${docPath}`);
		let timer = null;
		let running = false;
		// Debounced: an editor writing a document produces several events, and
		// rebuilding mid-write reads half a file.
		watch(docPath, () => {
			clearTimeout(timer);
			timer = setTimeout(async () => {
				if (running) return;
				running = true;
				try {
					console.log(`\n  ${new Date().toLocaleTimeString()} — adopting`);
					report(await adoptCut({ projectId, folder, from }));
				} catch (error) {
					console.error(`  ${error.message}`);
				}
				running = false;
			}, 250);
		});
	}
}
