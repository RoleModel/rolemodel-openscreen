/*
 * Which coding agent runs the AI steps.
 *
 * WHAT THIS IS FOR
 *
 * Two steps here hand a prompt to an agent and let it write files: drafting a
 * script, and generating the scene HTML for a composition. Both shelled out to
 * `claude` with the argv written inline at the call site, twice, identically.
 *
 * That hardcodes two things that are really one decision — WHICH agent, and
 * therefore whose account and whose bill. `claude` runs on a Claude Code
 * subscription, which is the right default and is not free.
 *
 * Pi (https://pi.dev) is the same shape of tool: a local agent harness driving a
 * model, with a non-interactive mode, a JSON event stream and an approve flag.
 * It is NOT an inference provider — it routes to 15+ of them — so it does not
 * reduce cost by itself. It reduces cost by letting the same work run against a
 * cheaper model than Claude.
 *
 * STATUS: THE PI PATH IS A STUB AND HAS NOT BEEN RUN.
 *
 * The flags below come from Pi's CLI reference, not from a run against a real
 * install, and nothing here has produced a script or a scene. It is wired up so
 * that trying it is a config change rather than a patch, and left switched off
 * so nobody discovers it by having a render fail. Before turning it on, see
 * docs/AGENTS.md — the open questions are listed there and they are not
 * cosmetic.
 *
 * WHY A MODULE RATHER THAN AN IF AT EACH CALL SITE
 *
 * The two call sites drifted once already in the direction that matters: the
 * comment explaining `--output-format stream-json` is copied verbatim in both,
 * which is what a shared decision looks like just before it stops being shared.
 */

/**
 * The agents this app knows how to start.
 *
 * `bin` must also be in lib/jobs.mjs BINARIES, or the job runner refuses it —
 * deliberately, because that allowlist is the thing standing between a prompt
 * and an arbitrary process.
 */
export const AGENTS = {
	claude: {
		id: "claude",
		label: "Claude Code · Fable 5",
		bin: "claude",
		/*
		 * Studio's work is deliberately long-horizon: inspect several recordings,
		 * compare their evidence against a script, and leave a reviewable edit.
		 * Do not quietly inherit whichever Claude Code model happened to be selected
		 * in a terminal. Every Studio agent run should make the same explicit choice.
		 */
		model: "claude-fable-5",
		/** Whose bill this lands on, said plainly because it is the reason to change it. */
		billing: "your Claude Code subscription",
		ready: true,
		/**
		 * stream-json, not the default text output.
		 *
		 * `claude -p` in text mode prints one blob when it finishes, so a long
		 * render showed an empty Console for minutes and looked hung. stream-json
		 * emits an event per step; --verbose is required alongside it. The Studio
		 * renders those events rather than showing raw NDJSON.
		 */
		args: (prompt, { additionalDirectories = [] } = {}) => [
			"-p",
			prompt,
			"--model",
			"claude-fable-5",
			...(additionalDirectories.length ? ["--add-dir", ...additionalDirectories] : []),
			"--permission-mode",
			"acceptEdits",
			"--output-format",
			"stream-json",
			"--verbose",
		],
		/** How the Console should read this agent's stdout. */
		stream: "claude-stream-json",
	},

	pi: {
		id: "pi",
		label: "Pi (unverified)",
		bin: "pi",
		billing: "whichever provider Pi is configured for",
		/*
		 * Not ready, and that is a claim about testing rather than about Pi.
		 *
		 * `ready: false` keeps it out of the default and makes the UI say so. It
		 * flips to true when someone has run both steps end to end and a scene
		 * generated this way has actually rendered.
		 */
		ready: false,
		/*
		 * Mapped from Pi's CLI reference:
		 *
		 *   claude -p <prompt>                      →  pi -p <prompt>
		 *   claude --permission-mode acceptEdits    →  pi --approve
		 *   claude --output-format stream-json      →  pi --mode json
		 *           --verbose
		 *
		 * Provider and model are never frozen into this file. By default Pi
		 * resolves its own configured default, so the choice of model — which is
		 * the entire cost question — stays with whoever set Pi up. The Agents page
		 * can point it at the local oMLX server or at Groq instead, and only then
		 * are --provider and --model passed.
		 */
		args: (prompt, { piProvider = "default", piModel = "" } = {}) => [
			"-p",
			prompt,
			"--approve",
			"--mode",
			"json",
			...(piProvider === "default" ? [] : ["--provider", piProvider]),
			...(piModel ? ["--model", piModel] : []),
		],
		stream: "pi-json",
	},

	codex: {
		id: "codex",
		label: "Codex CLI",
		bin: "codex",
		billing: "your Codex or OpenAI account",
		ready: false,
		args: (prompt, { model = "", provider = "openai", baseUrl, contextWindow = "", sandbox = "workspace-write", additionalDirectories = [] } = {}) => [
			"exec",
			// Studio jobs run in a project's own folders, which are not git repos,
			// and `codex exec` refuses those outright without this.
			"--skip-git-repo-check",
			"--json",
			"--sandbox",
			sandbox,
			...(additionalDirectories.flatMap((directory) => ["--add-dir", directory])),
			...(provider === "omlx" ? [
				"-c", 'model_provider="omlx"',
				"-c", 'model_providers.omlx.name="oMLX"',
				"-c", `model_providers.omlx.base_url=${JSON.stringify(baseUrl)}`,
				"-c", 'model_providers.omlx.env_key="OMLX_API_KEY"',
			] : []),
			...(contextWindow ? ["-c", `model_context_window=${Number(contextWindow)}`] : []),
			...(model ? ["--model", model] : []),
			prompt,
		],
		stream: "codex-json",
	},
};

/** The agent used when nothing has chosen one. */
export const DEFAULT_AGENT = "claude";

/**
 * Resolve a stored setting to an agent, refusing to guess.
 *
 * An unknown id falls back to the default rather than throwing: a settings file
 * naming an agent this build does not have should degrade to a working render,
 * not to a broken app. An agent that is present but not `ready` is only used
 * when it was asked for explicitly, which is the point of the flag.
 */
export function agentFor(id) {
	const want = AGENTS[String(id ?? "")];
	return want ?? AGENTS[DEFAULT_AGENT];
}

/**
 * The step this agent runs, in the shape lib/jobs.mjs expects.
 *
 * One builder, so the two call sites cannot drift again.
 */
export function agentStep(id, { prompt, cwd, label, additionalDirectories, ...settings }) {
	const agent = agentFor(id);
	return {
		label: label ?? `${agent.id} · ${cwd}`,
		bin: agent.bin,
		args: agent.args(prompt, { additionalDirectories, ...settings }),
		cwd,
		// Codex and Pi can need a key the Studio holds; the job runner adds it to
		// the environment at spawn time so it never appears in the argv.
		...(agent.id === "codex" || agent.id === "pi" ? { agentId: agent.id, managedAgent: true } : {}),
		/** Read by the Console to decide how to render this job's output. */
		stream: agent.stream,
	};
}
