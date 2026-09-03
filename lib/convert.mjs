/*
 * Convert one media file into another container, with ffmpeg.
 *
 * WHY THIS EXISTS
 *
 * A project fills with whatever the tools produced: ProRes from the recorder,
 * H.264 from a render, WebM from a browser. Each consumer wants something else —
 * Slack an MP4, a web page a WebM, a slide a GIF, a transcriber a WAV — and
 * "open a terminal and remember the flags" is where the afternoon goes. So the
 * flags live here once, chosen for the job rather than for tunability.
 *
 * WHAT IT IS NOT
 *
 * Not an encoder settings panel. One good recipe per target, and a size choice,
 * because the person converting wants the file, not a bitrate.
 *
 * Pure: it decides the arguments and the output name and touches nothing. The
 * Studio runs the result as a Console job, so it can be watched and stopped
 * like every other long process.
 */
import { basename, dirname, extname, join } from "node:path";

/**
 * The targets, by extension.
 *
 *   webm   VP9 + Opus. `-b:v 0` with a CRF is VP9's quality mode; without it the
 *          encoder targets a bitrate and ignores the CRF. `row-mt` and a modest
 *          `cpu-used` because VP9 is slow and this runs on a laptop.
 *   mp4    H.264 + AAC, `yuv420p` so QuickTime and Slack play it, `faststart` so
 *          it streams before it has finished downloading.
 *   mov    ProRes 422 HQ, the edit-friendly intermediate. Big on purpose.
 *   gif    Two-pass palette, or the result is 256 colours picked badly. Capped
 *          to 720 wide and 12fps, because a GIF is a note, not a delivery.
 *   mp3    The voice track, for sharing.
 *   wav    The voice track, for tools that want PCM.
 */
export const FORMATS = {
	webm: { label: "WebM (VP9)", kinds: ["video"], video: ["-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0", "-row-mt", "1", "-deadline", "good", "-cpu-used", "2", "-pix_fmt", "yuv420p"], audio: ["-c:a", "libopus", "-b:a", "128k"] },
	mp4: { label: "MP4 (H.264)", kinds: ["video"], video: ["-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart"], audio: ["-c:a", "aac", "-b:a", "192k"] },
	mov: { label: "MOV (ProRes 422 HQ)", kinds: ["video"], video: ["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le"], audio: ["-c:a", "pcm_s16le"] },
	gif: { label: "GIF (720px, 12fps)", kinds: ["video"], gif: true },
	mp3: { label: "MP3 (audio only)", kinds: ["video", "audio"], audioOnly: true, audio: ["-c:a", "libmp3lame", "-q:a", "2"] },
	wav: { label: "WAV (audio only)", kinds: ["video", "audio"], audioOnly: true, audio: ["-c:a", "pcm_s16le"] },
};

/** The sizes offered for a video target. `null` keeps the source size. */
export const SIZES = {
	source: { label: "Same size", height: null },
	1080: { label: "1080p", height: 1080 },
	720: { label: "720p", height: 720 },
};

/** Which targets make sense for a file of this kind, in menu order. */
export function formatsFor(kind) {
	return Object.entries(FORMATS)
		.filter(([, f]) => f.kinds.includes(kind))
		.map(([id, f]) => ({ id, label: f.label, audioOnly: Boolean(f.audioOnly), gif: Boolean(f.gif) }));
}

/**
 * Where the converted file goes: beside its source, same stem, new extension.
 *
 * Never over anything. A second conversion gets `-2`, `-3`, … rather than
 * replacing the first — the first may be the one somebody already sent out.
 * `exists` is asked rather than the disk touched, so this stays pure.
 */
export function outputFor(source, format, exists) {
	const dir = dirname(source);
	const ext = extname(source);
	const stem = basename(source, ext);
	let candidate = join(dir, `${stem}.${format}`);
	for (let n = 2; exists(candidate); n++) candidate = join(dir, `${stem}-${n}.${format}`);
	return candidate;
}

/**
 * The ffmpeg command, as arguments.
 *
 * `-y` is safe because `outputFor` has already chosen a name nothing has.
 * `-v error` plus `-stats` keeps the Console to one moving line and the errors
 * that matter. Scaling keeps the width even (`-2`) because yuv420p needs it.
 */
export function ffmpegArgs({ source, output, format, size = "source", kind = "video" }) {
	const f = FORMATS[format];
	if (!f) throw new Error(`no such format: ${format}`);
	if (!f.kinds.includes(kind)) throw new Error(`${f.label} cannot be made from ${kind}`);
	const s = SIZES[size];
	if (!s) throw new Error(`no such size: ${size}`);
	const args = ["-hide_banner", "-v", "error", "-stats", "-y", "-i", source];
	if (f.gif) {
		// Palette in one pass via split; the scale and fps happen before the
		// palette is picked so the palette describes the frames that ship.
		const width = s.height ? Math.min(720, Math.round((s.height * 16) / 9)) : 720;
		args.push("-filter_complex", `[0:v]fps=12,scale=${width}:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5`, "-loop", "0", output);
		return args;
	}
	if (f.audioOnly) {
		args.push("-vn", ...f.audio, output);
		return args;
	}
	if (s.height) args.push("-vf", `scale=-2:${s.height}`);
	args.push(...f.video, ...f.audio, output);
	return args;
}
