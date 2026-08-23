/**
 * Voice setup — make local TTS work without anyone learning Python.
 *
 * WHY THIS EXISTS
 *
 * Kokoro runs through `hyperframes tts`, which needs two Python packages. The
 * documented fix is `pip install kokoro-onnx soundfile`, and on a current Mac
 * that fails:
 *
 *   error: externally-managed-environment
 *   × This environment is externally managed
 *
 * That is PEP 668. Homebrew and the system Python both mark themselves managed,
 * so a bare `pip install` is refused — and the suggested escape hatches
 * (`--break-system-packages`, `pipx`, a hand-rolled venv, exporting an env var)
 * are all things a designer should never have to know about to record a demo.
 *
 * So we own it. This creates a private virtualenv, installs into that, and hands
 * `hyperframes` its path through HYPERFRAMES_PYTHON on the child process — which
 * means **nobody sets an environment variable and nobody touches system Python.**
 * Delete the directory and it rebuilds itself.
 *
 *   rm-voice --setup     explicitly
 *   rm-voice <project>   runs it on first use if it is missing
 */
import { spawn } from "node:child_process";
import { access, mkdir, rm } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";

const WIN = platform() === "win32";

/** Kept outside the repo so a fresh clone, or `git clean`, doesn't destroy it. */
export function venvDir() {
	return process.env.RM_VOICE_VENV ?? join(homedir(), ".rolemodel-video", "python");
}

export function venvPython(dir = venvDir()) {
	return WIN ? join(dir, "Scripts", "python.exe") : join(dir, "bin", "python");
}

export const PACKAGES = ["kokoro-onnx", "soundfile"];

/**
 * The interpreter range Kokoro's wheels actually support.
 *
 * `kokoro-onnx` declares `requires_python: >=3.10,<3.14`, and this mirrors it.
 * Both ends matter, and both have bitten:
 *
 *   - Below 3.10 pip does not say "wrong Python". It walks back through every
 *     kokoro-onnx release looking for one that fits, finds none, and reports
 *     `ResolutionImpossible` with a wall of two dozen pinned versions — which
 *     reads as a broken package rather than a wrong interpreter. That is the
 *     failure this range exists to prevent.
 *   - At 3.14 and above there are no wheels at all, and `brew install python`
 *     installs exactly 3.14 today. So "just use the newest Python" is wrong
 *     here; the upper bound is not pedantry.
 *
 * If Kokoro widens support, widen this — the source of truth is the
 * `requires_python` field on https://pypi.org/pypi/kokoro-onnx/json.
 */
export const PY_MIN = [3, 10];
export const PY_MAX_EXCLUSIVE = [3, 14];

/** Human form of the range, for messages. */
export const pyRange = () => `>=${PY_MIN.join(".")},<${PY_MAX_EXCLUSIVE.join(".")}`;

/** Newest version we can actually recommend installing. */
const newestSupported = () => `${PY_MAX_EXCLUSIVE[0]}.${PY_MAX_EXCLUSIVE[1] - 1}`;

const cmpVer = (a, b) => a[0] - b[0] || a[1] - b[1];

/** Exported so the suite can pin both ends of the range, not just the floor. */
export const pySupported = (major, minor) =>
	cmpVer([major, minor], PY_MIN) >= 0 && cmpVer([major, minor], PY_MAX_EXCLUSIVE) < 0;

const supported = (v) => pySupported(v[0], v[1]);

function run(cmd, args, { onLog } = {}) {
	return new Promise((resolve) => {
		const child = spawn(cmd, args);
		let out = "";
		let err = "";
		child.stdout?.on("data", (d) => {
			out += d;
			onLog?.(String(d).trimEnd());
		});
		child.stderr?.on("data", (d) => {
			err += d;
			onLog?.(String(d).trimEnd());
		});
		child.on("error", (e) => resolve({ ok: false, out, err: String(e.message ?? e) }));
		child.on("close", (code) => resolve({ ok: code === 0, code, out, err }));
	});
}

const exists = (p) => access(p).then(() => true).catch(() => false);

/** Does the venv exist and can it import what Kokoro needs? */
export async function isReady() {
	const py = venvPython();
	if (!(await exists(py))) return false;
	const { ok } = await run(py, ["-c", "import kokoro_onnx, soundfile"]);
	return ok;
}

/**
 * Find a Python that can build a venv and can actually install Kokoro.
 *
 * Every candidate is probed and the newest *supported* one wins. It deliberately
 * does not stop at the first hit: plain `python3` is 3.9 on a Mac with only the
 * Xcode command line tools, and picking it is how this failed — and on a machine
 * where Homebrew owns `python3` it is 3.14, which fails at the other end. The
 * name tells you nothing; only `--version` does.
 *
 * Rejections are returned rather than dropped so the caller can say what it
 * found instead of "no usable Python", which is a lie when there are three.
 *
 * @returns {Promise<{found: {cmd: string, version: string}|null, rejected: Array}>}
 */
export async function findPython() {
	const byVersion = new Map();
	const rejected = [];
	// `python` (no 3) is included last and only accepted if it reports 3.x — on an
	// old machine it can still be Python 2.
	for (const cmd of ["python3.13", "python3.12", "python3.11", "python3.10", "python3", "python"]) {
		const v = await run(cmd, ["--version"]);
		if (!v.ok) continue; // not installed
		const m = `${v.out}${v.err}`.match(/Python (\d+)\.(\d+)/);
		if (!m) continue;
		const ver = [Number(m[1]), Number(m[2])];
		const version = ver.join(".");
		if (!supported(ver)) {
			rejected.push({ cmd, version, why: cmpVer(ver, PY_MIN) < 0 ? "too old" : "too new" });
			continue;
		}
		// venv is stdlib but Debian-likes split it into a separate package.
		if (!(await run(cmd, ["-c", "import venv"])).ok) {
			rejected.push({ cmd, version, why: "no venv module" });
			continue;
		}
		if (!byVersion.has(version)) byVersion.set(version, { cmd, version, ver });
	}
	const usable = [...byVersion.values()].sort((a, b) => cmpVer(b.ver, a.ver));
	return { found: usable[0] ?? null, rejected };
}

/**
 * Build the venv and install into it. Idempotent — safe to call every run.
 *
 * @returns {Promise<{ok: boolean, python?: string, reason?: string, hint?: string}>}
 */
export async function setup({ onLog = () => {}, force = false } = {}) {
	if (!force && (await isReady())) {
		return { ok: true, python: venvPython(), already: true };
	}

	const { found, rejected } = await findPython();
	if (!found) {
		// Name what was actually on the machine. "No usable Python" is a lie when
		// there are three of them, and it sends people installing another wrong one.
		const saw = rejected.length
			? rejected.map((r) => `${r.cmd} is ${r.version} (${r.why})`).join(", ")
			: "no python3 on PATH at all";
		const want = newestSupported();
		return {
			ok: false,
			reason: `no Python in ${pyRange()} was found — Kokoro needs one`,
			hint: WIN
				? `Saw ${saw}. Install Python ${want} from python.org, then run this again.`
				: `Saw ${saw}. Run: brew install python@${want}\n  (plain \`brew install python\` gives you ${PY_MAX_EXCLUSIVE.join(".")}, which Kokoro has no wheels for.)`,
		};
	}
	onLog(`  python      ${found.cmd} (${found.version})`);

	const dir = venvDir();
	if (force) await rm(dir, { recursive: true, force: true });
	await mkdir(dir, { recursive: true });

	onLog(`  venv        ${dir}`);
	const made = await run(found.cmd, ["-m", "venv", dir]);
	if (!made.ok) {
		return {
			ok: false,
			reason: "could not create the virtualenv",
			hint: made.err.trim().slice(-400) || "check that the venv module is available",
		};
	}

	const py = venvPython(dir);
	onLog(`  installing  ${PACKAGES.join(", ")}   (about 100MB, once)`);

	// --upgrade pip first: the venv ships whatever pip came with the interpreter,
	// and older pips resolve onnxruntime wheels badly on Apple silicon.
	await run(py, ["-m", "pip", "install", "--quiet", "--upgrade", "pip"]);

	const inst = await run(py, ["-m", "pip", "install", "--quiet", ...PACKAGES], {
		onLog: (line) => {
			if (line.trim()) onLog(`  ${line}`);
		},
	});
	if (!inst.ok) {
		return {
			ok: false,
			reason: "pip could not install the voice packages",
			hint: inst.err.trim().slice(-600) || inst.out.trim().slice(-600),
		};
	}

	const check = await run(py, ["-c", "import kokoro_onnx, soundfile; print('ok')"]);
	if (!check.ok) {
		return { ok: false, reason: "installed, but the packages will not import", hint: check.err.trim().slice(-400) };
	}

	return { ok: true, python: py };
}

/**
 * Environment for a `hyperframes tts` child.
 *
 * This is the whole point: HYPERFRAMES_PYTHON is set on the child process, so
 * the private venv is used without anyone editing a shell profile, and the
 * user's own Python is never touched.
 */
export async function ttsEnv() {
	const py = venvPython();
	return (await exists(py)) ? { HYPERFRAMES_PYTHON: py } : {};
}
