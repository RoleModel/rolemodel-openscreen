/**
 * Markdown script -> speakable lines.
 *
 * Its own module, with no Node built-ins, for one reason: the Studio serves this
 * file straight to the browser so the "what will be spoken" preview runs the
 * exact code the synthesiser runs. The first version duplicated these rules in
 * the UI, which meant the preview could quietly disagree with the audio — and a
 * preview that lies is worse than no preview.
 */

/**
 * Headings, code fences, images and rules are structure, not narration. A voice
 * track that reads "hash hash Opening" out loud is the classic failure here.
 * Bullets keep their text and lose their marker.
 */
export function parseScript(md) {
	const lines = [];
	let inFence = false;

	for (const raw of String(md).split(/\r?\n/)) {
		const line = raw.trim();

		if (line.slice(0, 3) === "```") {
			inFence = !inFence;
			continue;
		}
		if (inFence || !line) continue;
		if (line[0] === "#") continue;
		if (/^([-*_])\1{2,}$/.test(line)) continue; // --- *** ___
		if (line.slice(0, 2) === "![") continue;

		/*
		 * A settings line, not a line to speak.
		 *
		 * `/voice af_heart` in a script would otherwise be synthesised aloud —
		 * "slash voice af heart" — because rm-voice speaks whatever this function
		 * returns. Matched on shape rather than against a list of known settings:
		 * lib/demo-script.mjs owns that vocabulary and validates it, and a second
		 * copy here would be one more thing to keep in step. This end only has to
		 * know not to read it out, and a line of narration does not begin with a
		 * slash.
		 */
		if (/^\/[a-z][a-z-]*(\s|$)/i.test(line)) continue;

		const text = line
			.replace(/^>\s*/, "")
			.replace(/^[-*+]\s+/, "")
			.replace(/^\d+[.)]\s+/, "")
			// Inline markdown would otherwise be spoken as punctuation.
			.replace(/\*\*(.+?)\*\*/g, "$1")
			.replace(/\[(.+?)\]\(.+?\)/g, "$1")
			.replace(/[*_`]/g, "")
			.trim();
		if (!text) continue;

		// One sentence per line. A 40-word paragraph as a single subtitle cue is
		// unreadable, and it also makes the whole paragraph re-synthesise when you
		// fix one word inside it.
		for (const part of text.split(/(?<=[.!?])\s+(?=[A-Z0-9"'“])/)) {
			const t = part.trim();
			if (t) lines.push(t);
		}
	}
	return lines;
}

/**
 * Rough runtime, for setting expectations before committing to a synth pass.
 * 2.4 words a second is measured from Kokoro at default rate, not a guess.
 */
export function estimateSeconds(lines, gapMs = 320) {
	const words = lines.join(" ").split(/\s+/).filter(Boolean).length;
	return words / 2.4 + (Math.max(0, lines.length - 1) * gapMs) / 1000;
}
