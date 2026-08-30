/**
 * Captions in, word-timed transcript out.
 *
 * Lived inside the Studio server, which meant anything outside it that had a
 * VTT and wanted words — the PIP builder, for one — had to grow a second parser
 * with its own idea of how a cue divides into words. One reader, so a caption
 * read in two places cannot come out two different lengths.
 */
export function transcriptFromCaptions(raw, wordTiming = null) {
  const text = String(raw ?? "").replace(/^WEBVTT[^\n]*\n?/i, "").replace(/\r/g, "");
  const blocks = text.split(/\n\s*\n/);
  const parseTime = (value) => {
    const m = String(value).trim().match(/(?:(\d+):)?(\d{2}):(\d{2})[,.](\d{1,3})/);
    if (!m) return null;
    return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, "0")) / 1000;
  };
  const parsedCues = [];
  const suppliedWords = Array.isArray(wordTiming?.words)
    ? wordTiming.words
      .map((word) => ({
        text: String(word?.text ?? "").trim(),
        startSec: Number(word?.startSec),
        endSec: Number(word?.endSec),
      }))
      .filter((word) => word.text && Number.isFinite(word.startSec) && Number.isFinite(word.endSec) && word.endSec > word.startSec)
      .sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec)
    : [];
  const words = suppliedWords.map((word, index) => ({ ...word, id: `w${index + 1}` }));
  const cues = [];
  let wordNo = 0;
  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const timing = lines.findIndex((line) => line.includes("-->"));
    if (timing === -1) continue;
    const [startRaw, endRaw] = lines[timing].split("-->");
    const startSec = parseTime(startRaw);
    // Whisper writes ` --> 00:00:01.360`: split before trimming makes the first
    // token empty, then every otherwise-valid cue gets discarded.
    const endSec = parseTime(endRaw?.trim().split(/\s+/)[0]);
    const spoken = lines.slice(timing + 1).join(" ").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    const tokens = spoken.match(/[^\s]+/g) ?? [];
    if (startSec == null || endSec == null || endSec <= startSec || !tokens.length) continue;
    parsedCues.push({ text: spoken, tokens, startSec, endSec });
  }
  if (suppliedWords.length) {
    for (const cue of parsedCues) {
      const cueWords = words.filter((word) => {
        const midpoint = (word.startSec + word.endSec) / 2;
        return midpoint >= cue.startSec && midpoint <= cue.endSec;
      });
      if (cueWords.length) cues.push({ from: cueWords[0].id, to: cueWords.at(-1).id, text: cue.text, startSec: cue.startSec, endSec: cue.endSec });
    }
  } else {
    for (const cue of parsedCues) {
      const firstId = `w${wordNo + 1}`;
      const span = (cue.endSec - cue.startSec) / cue.tokens.length;
      for (const [index, token] of cue.tokens.entries()) {
        wordNo++;
        words.push({ id: `w${wordNo}`, text: token, startSec: +(cue.startSec + index * span).toFixed(3), endSec: +(cue.startSec + (index + 1) * span).toFixed(3) });
      }
      cues.push({ from: firstId, to: `w${wordNo}`, text: cue.text, startSec: cue.startSec, endSec: cue.endSec });
    }
  }
  if (!words.length) throw new Error("that subtitle file has no timed spoken text — use an .srt or .vtt with caption cues");
  return { version: 1, importedAt: new Date().toISOString(), timing: suppliedWords.length ? "word" : "caption", words, cues };
}
