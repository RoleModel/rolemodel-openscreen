/*
 * Put a Studio look on the Framer canvas, without a paste.
 *
 * WHY THIS EXISTS
 *
 * "Copy the component, paste it into Framer, then paste the look into its Look
 * control" is three steps and a second code component every time. Framer's
 * CLI can do the whole thing against the open project: make sure the
 * RoleModelLook code file exists once, then add an instance of it to the
 * canvas with the look already in its control.
 *
 * HOW
 *
 * `npx @framer/agent` keeps a session per project; `exec -s <id>` runs a
 * script against it with `framer` as the plugin API. The session id is kept in
 * the same 0600 config as the other tokens and remade when it has gone stale.
 * The component's source travels from the browser, where the shader lives, so
 * this module never has to import the component library.
 */
import { spawn } from "node:child_process";
import { childEnv } from "./jobs.mjs";

/** The RM Website, unless a setting says otherwise. */
export const DEFAULT_FRAMER_PROJECT = "https://framer.com/projects/RM-Website--QEEd1Km5tkCqzLT98aBC-5tXiG";
export const FRAMER_COMPONENT_FILE = "RoleModelLook.tsx";

const TIMEOUT_MS = 120_000;

function run(args, { input = null } = {}) {
	return new Promise((done) => {
		const child = spawn("npx", ["-y", "@framer/agent@latest", ...args], { env: childEnv(), stdio: ["pipe", "pipe", "pipe"] });
		let out = "";
		let err = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (err += d));
		child.on("error", (e) => {
			clearTimeout(timer);
			done({ code: 1, out, err: String(e.message) });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			done({ code: code ?? 1, out, err });
		});
		if (input != null) child.stdin.end(input);
		else child.stdin.end();
	});
}

/** A new session against the project; its id is the last line of the output. */
export async function openSession(projectUrl) {
	const r = await run(["session", "new", projectUrl]);
	const id = r.out.trim().split("\n").pop()?.trim();
	if (r.code !== 0 || !/^\w+$/.test(id ?? "")) throw new Error(`Framer would not open a session: ${(r.err || r.out).trim().split("\n").pop() || "no answer"} — sign in with \`npx @framer/agent@latest session new <project url>\` once`);
	return id;
}

/**
 * The script that does the work, run inside Framer's session.
 *
 * Idempotent on the code file: made once from the source the browser sent,
 * refreshed when the source changed, left alone otherwise. Then one instance,
 * sized like a hero, with the look in its control.
 */
function placeScript({ look, source }) {
	return `
const want = ${JSON.stringify(source ?? "")};
const files = await framer.getCodeFiles();
let file = files.find((f) => f.name === ${JSON.stringify(FRAMER_COMPONENT_FILE)});
if (!file) file = await framer.createCodeFile(${JSON.stringify(FRAMER_COMPONENT_FILE)}, want);
else if (want && file.content && file.content !== want) await file.setFileContent(want);
const exp = (file.exports ?? []).find((e) => e.isDefaultExport) ?? (file.exports ?? [])[0];
if (!exp?.insertURL) throw new Error("the code file has no insertable component yet — open it once in Framer");
const node = await framer.addComponentInstance({ url: exp.insertURL, attributes: { width: 960, height: 540, controls: { look: ${JSON.stringify(look)}, animate: true } } });
console.log(JSON.stringify({ ok: true, id: node.id, insertURL: exp.insertURL }));
`;
}

/**
 * Place a look. Returns { ok, id, sessionId }. A stale session is remade once.
 */
export async function placeLook({ look, source, projectUrl = DEFAULT_FRAMER_PROJECT, sessionId = null }) {
	let id = sessionId;
	for (let attempt = 0; attempt < 2; attempt++) {
		if (!id) id = await openSession(projectUrl);
		const r = await run(["exec", "-s", id], { input: placeScript({ look, source }) });
		const line = r.out.trim().split("\n").reverse().find((l) => l.trim().startsWith("{"));
		if (r.code === 0 && line) {
			try {
				return { ...JSON.parse(line), sessionId: id };
			} catch {
				/* fall through to the retry */
			}
		}
		const why = (r.err || r.out).trim().split("\n").pop() || "no answer";
		if (attempt === 0 && /session|not found|closed|expired|ECONN/i.test(why)) {
			id = null;
			continue;
		}
		throw new Error(`Framer did not place the component: ${why}`);
	}
	throw new Error("Framer did not place the component");
}
