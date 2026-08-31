/*
 * The interview: a conversation that ends in a shot list.
 *
 * WHY AN INTERVIEW AND NOT A FORM
 *
 * The Studio already has a brief: a box that says "what is this video for" and a
 * number of seconds. What comes back is a sentence, and a sentence is not a
 * plan — so the model drafting from it invents the structure, and the structure
 * is the part the person actually knows and was never asked for.
 *
 * The questions that produce a good shot list are the ones a director asks, and
 * they are not a fixed list: the second question depends on the first answer.
 * "Who is it for" is worth asking; "how technical are they" only matters once
 * you know it is for a client rather than the team. A form has to ask everything
 * or nothing. An interview asks four questions and gets further.
 *
 * WHAT COMES OUT
 *
 * A shot list in exactly the shape `slotsFromBrief` reads, so the storyboard
 * fills it, the Record panel shoots it, and `paper-edit.mjs` cuts against it.
 * That is the whole point of the loop: one plan, four surfaces, no restating.
 *
 * THE SHAPE OF EACH TURN
 *
 * The model does exactly one of two things per turn — ask ONE question, or hand
 * over the shot list. Not both, and never a question with a draft attached. A
 * model given the option to do both does both, every time, and the person ends
 * up answering questions about a plan that already exists.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 * No network and no disk, as in paper-edit.mjs. This builds prompts, validates
 * turns, and produces the brief; running the agent is lib/agents.mjs's job.
 */

/** Bumped when a stored interview can no longer be replayed by this file. */
export const INTERVIEW_VERSION = 1;

/**
 * How many questions before it must commit.
 *
 * Six, and the number is doing real work. An unbounded interview is a model
 * that keeps finding one more useful thing to ask, and the person abandons it
 * at question nine having given more thought to the questionnaire than to the
 * video. Four to six is where a director stops, so the prompt says so and this
 * enforces it.
 */
export const MAX_QUESTIONS = 6;

/**
 * And how many before it MAY commit.
 *
 * The prompt used to invite an early hand-over ("if you already know enough"),
 * and a model with two thin answers — "internal team", "that they can make
 * videos" — took the exit every time. Two answers do not contain a story. A
 * director has not stopped asking by question three either.
 */
export const MIN_QUESTIONS = 3;

/** The opening question, asked without a model, because the first one never varies. */
export const FIRST_QUESTION = "What is this video for, and who watches it?";

/**
 * The conversation so far, as the model reads it.
 *
 * Plain Q/A rather than a chat-message array: this goes to a coding agent
 * through `lib/agents.mjs`, which takes one prompt string. Numbered, so the
 * model can see how many it has spent against the budget it is given.
 */
export const renderExchange = (turns) =>
	(turns ?? [])
		.map((t, i) => `Q${i + 1}. ${t.question}\nA${i + 1}. ${String(t.answer ?? "").trim() || "(no answer)"}`)
		.join("\n\n");

/** What one turn may be. Prose, because it reaches a coding agent, not a schema endpoint. */
export const TURN_SHAPE = `Either ask one more question:

{ "ask": "<one question, in plain language>" }

or hand over the plan:

{
  "shots": [
    { "name": "<short name>", "intent": "<what this shot has to show>", "seconds": <number> }
  ],
  "why": "<one sentence on why this order tells the story>"
}`;

/**
 * The prompt for one turn of the interview.
 *
 * The budget is stated as a remaining count rather than a total, because a model
 * told "you have six" spends six. Told "you have two left" it starts closing.
 */
export function buildTurnPrompt({ turns = [], seconds = null, project = null } = {}) {
	const asked = turns.length;
	const left = Math.max(0, MAX_QUESTIONS - asked);
	const must = left === 0;
	const tooEarly = asked < MIN_QUESTIONS;

	return [
		"You are a video director planning a short video with the person who wants it made.",
		"Your job this turn is to move them towards a SHOT LIST — the ordered beats the video",
		"needs — by asking about the video, not about video-making.",
		"",
		project ? `The project is "${project}".` : "",
		seconds ? `They are aiming for about ${seconds} seconds.` : "",
		"",
		asked ? "THE CONVERSATION SO FAR:\n\n" + renderExchange(turns) : "Nothing has been asked yet.",
		"",
		must
			? "You have used all your questions. Hand over the shot list now."
			: tooEarly
				? `You may ask ${left} more question${left === 1 ? "" : "s"}. Do NOT hand over the plan yet — ` +
					"fewer than three answers never contain the story. Ask the question that would most change the plan."
				: `You may ask ${left} more question${left === 1 ? "" : "s"} before you must hand over the shot list. ` +
					"Ask only what changes the plan. Hand the plan over early only when the answers actually contain the " +
					"story — the subject, the audience, and what must appear on screen. Thin answers earn another question, " +
					"not a thin plan.",
		"",
		"RULES",
		"",
		"1. One question at a time. Never a question and a plan in the same reply.",
		"2. Ask about the video and the audience. They know their subject; you do not.",
		"3. Do not ask what they have already told you.",
		"4. A shot is a beat the video needs — 'open on the problem', 'the price appears',",
		"   'the close'. Three to seven of them. Each gets a name, what it must show, and a",
		"   rough length; the lengths should roughly add to the target.",
		"5. Name shots the way somebody would say them out loud, not 'Shot 1'.",
		"",
		"Reply with ONLY one of these JSON objects, and nothing before or after it:",
		"",
		TURN_SHAPE,
	]
		.filter((l) => l !== "")
		.join("\n");
}

/**
 * Read one turn back.
 *
 * Shares `parseSelection`'s tolerance for fences and chatter, and for the same
 * reason — a five-minute run should not fail because the model said "Sure!".
 * Kept separate rather than imported so neither file has to know the other's
 * output shape.
 */
export function parseTurn(raw) {
	const text = String(raw ?? "");
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
	for (const c of [fenced?.[1], text].filter(Boolean)) {
		const start = c.indexOf("{");
		if (start === -1) continue;
		let depth = 0;
		for (let i = start; i < c.length; i++) {
			if (c[i] === "{") depth++;
			else if (c[i] === "}") depth--;
			if (depth === 0) {
				try {
					const parsed = JSON.parse(c.slice(start, i + 1));
					if (parsed && (typeof parsed.ask === "string" || Array.isArray(parsed.shots))) return parsed;
				} catch {
					/* try the next candidate */
				}
				break;
			}
		}
	}
	throw new Error("the agent did not ask a question or hand over a plan — no JSON with `ask` or `shots`");
}

/**
 * Decide what a parsed turn actually is, and refuse the ambiguous case.
 *
 * A reply carrying BOTH is the failure this design is shaped to prevent, so it
 * is named rather than resolved by precedence. Silently preferring one would
 * mean the person answers a question about a plan that already exists, or never
 * sees a plan the model had already written.
 */
export function readTurn(parsed) {
	const hasAsk = typeof parsed?.ask === "string" && parsed.ask.trim().length > 0;
	const hasShots = Array.isArray(parsed?.shots) && parsed.shots.length > 0;
	if (hasAsk && hasShots) {
		return { kind: "ambiguous", problem: "the reply both asked a question and handed over a plan — it must do one" };
	}
	if (hasAsk) return { kind: "ask", question: parsed.ask.trim() };
	if (hasShots) return { kind: "plan", ...normalisePlan(parsed) };
	return { kind: "ambiguous", problem: "the reply neither asked anything nor handed over a plan" };
}

/**
 * Clean a handed-over plan into the shape the rest of the pipeline reads.
 *
 * Every field is coerced rather than trusted: this crosses a boundary from a
 * model, and `slotsFromBrief` downstream derives slot IDS from the name — so a
 * name arriving as a number would produce a slot nobody can re-link takes to.
 *
 * Problems are collected rather than thrown. A plan with one nameless shot is
 * worth showing with that shot flagged; refusing it whole spends the run.
 */
export function normalisePlan(parsed) {
	const problems = [];
	const shots = [];
	for (const [i, raw] of (parsed?.shots ?? []).entries()) {
		const name = String(raw?.name ?? "").trim();
		if (!name) {
			problems.push(`shot ${i + 1} has no name`);
			continue;
		}
		if (shots.some((s) => s.name === name)) {
			// Slot ids derive from order AND name, so duplicates are survivable —
			// but two shots called the same thing are unreadable on a board.
			problems.push(`two shots are both called "${name}"`);
		}
		const seconds = Number(raw?.seconds);
		shots.push({
			name,
			intent: String(raw?.intent ?? "").trim(),
			seconds: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 10) / 10 : null,
		});
	}
	if (!shots.length) problems.push("the plan has no usable shots");
	return { shots, why: String(parsed?.why ?? "").trim(), problems };
}

/**
 * The plan as a brief, in the shape the storyboard already stores.
 *
 * `drafted` is passed in rather than stamped here, for the reason nothing in
 * this file reads a clock: a pure function that returns a different value every
 * call cannot be checked. The route stamps it.
 */
export function planToBrief({ shots, why }, { projectId, seconds = null, drafted, turns = [] } = {}) {
	return {
		version: INTERVIEW_VERSION,
		projectId,
		about: why,
		seconds: seconds ?? (shots.reduce((n, s) => n + (s.seconds ?? 0), 0) || null),
		shots,
		drafted,
		/*
		 * The conversation, kept with the plan it produced.
		 *
		 * Six months later the question is never "what are the shots" — the board
		 * shows that — it is "why is there no shot for the thing the client asked
		 * about". The answer is in what was asked and what was said back, and that
		 * exists exactly once.
		 */
		interview: turns.map((t) => ({ question: t.question, answer: t.answer })),
	};
}

/**
 * Where the interview is, in a sentence somebody can act on.
 *
 * Used to decide whether to show a question box or a plan, and to say how much
 * of the budget is left without making a progress bar out of a conversation.
 */
export function interviewState({ turns = [], plan = null } = {}) {
	if (plan) return { phase: "planned", asked: turns.length, left: 0 };
	const asked = turns.length;
	const answered = turns.filter((t) => String(t.answer ?? "").trim()).length;
	return {
		phase: asked === 0 ? "not started" : answered < asked ? "waiting on you" : "thinking",
		asked,
		left: Math.max(0, MAX_QUESTIONS - asked),
		mustCommit: asked >= MAX_QUESTIONS,
	};
}
