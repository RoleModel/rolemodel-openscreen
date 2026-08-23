/*
 * Record a demo by doing it.
 *
 * The first version of this asked you to write steps. That is fine if you write
 * Playwright for a living and wrong for everyone else — most people making these
 * videos are not developers, and "learn a DSL, then guess a selector" is a worse
 * job than the one they were trying to do. A form with dropdowns is the same
 * problem wearing a hat: you still have to know that the button you mean is
 * called "REQUEST QUOTE" and not "Request quote".
 *
 * So: open the app, click through it, close the window. The clicks are the
 * script. What comes out is the same markdown `parseDemo` reads, so it stays
 * greppable, diffable, and editable afterwards by anyone who wants to.
 *
 * This module is the capture half, kept separate from the CLI so it can be
 * tested against a real browser without a subprocess: `attach(context)` returns
 * a live array of steps, and a test can drive the page and assert on it.
 */

/** Text longer than this is a paragraph, not a label — do not select on it. */
const MAX_TEXT = 60;
/** Typing is coalesced into one step until this long a pause. */
export const TYPE_IDLE_MS = 600;
/** Wheel events are coalesced the same way. */
export const SCROLL_IDLE_MS = 400;
/** A pause longer than this between actions is preserved as an explicit wait. */
export const KEEP_WAIT_MS = 700;
/** Waits are rounded to this, because a demo does not need millisecond fidelity. */
const WAIT_ROUND_MS = 100;

/**
 * The page-side recorder.
 *
 * Runs as an init script in every frame, so it survives navigation without the
 * driver having to re-attach. It reports through a binding rather than posting
 * to a server, which keeps it working on a page with a strict CSP — the thing
 * most likely to be true of a real product.
 */
export const PAGE_SCRIPT = `(() => {
  if (window.__rmRecording) return;
  window.__rmRecording = true;

  const MAX_TEXT = ${MAX_TEXT};

  // How to name the thing that was clicked, in the order a person would.
  //
  // Visible text first, because that is what a demo script should say and what
  // survives a redesign that changes the markup. Then the accessible name, then
  // an id, and a CSS path only as a last resort — a path is what makes a script
  // unreadable and brittle, so it is the fallback, not the default.
  const describe = (el) => {
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      const text = (node.innerText || node.value || '').trim().replace(/\\s+/g, ' ');
      if (text && text.length <= MAX_TEXT) return { by: 'text', value: text };
      const aria = node.getAttribute && node.getAttribute('aria-label');
      if (aria && aria.trim()) return { by: 'text', value: aria.trim() };
      if (node.id) return { by: 'selector', value: '#' + node.id };
      // Only climb out of things that carry no name of their own.
      if (node.getAttribute && (node.getAttribute('role') || node.tagName === 'BUTTON' || node.tagName === 'A')) break;
    }
    return { by: 'selector', value: cssPath(el) };
  };

  const cssPath = (el) => {
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && parts.length < 4; node = node.parentElement) {
      let part = node.tagName.toLowerCase();
      if (node.id) { parts.unshift('#' + node.id); break; }
      const cls = (node.className || '').toString().trim().split(/\\s+/).filter((c) => c && !/^(is-|has-)/.test(c))[0];
      if (cls) part += '.' + cls;
      parts.unshift(part);
    }
    return parts.join(' > ');
  };

  const fieldSelector = (el) => {
    if (el.id) return '#' + el.id;
    const name = el.getAttribute('name');
    if (name) return el.tagName.toLowerCase() + '[name="' + name + '"]';
    const ph = el.getAttribute('placeholder');
    if (ph) return el.tagName.toLowerCase() + '[placeholder="' + ph + '"]';
    return cssPath(el);
  };

  const send = (step) => { try { window.__rmStep(step); } catch {} };

  document.addEventListener('click', (e) => {
    const el = e.target;
    if (!el || el.nodeType !== 1) return;
    // A click that lands in a text field is the start of typing, not a step of
    // its own — the type step will bring its own selector.
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable) return;
    const d = describe(el);
    send({ verb: 'click', by: d.by, value: d.value, at: Date.now() });
  }, true);

  document.addEventListener('input', (e) => {
    const el = e.target;
    if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && !el.isContentEditable)) return;
    send({ verb: 'type', selector: fieldSelector(el), value: el.value ?? el.innerText ?? '', at: Date.now() });
  }, true);

  document.addEventListener('keydown', (e) => {
    // Only the keys that mean something in a demo. Every other keystroke is part
    // of the typing already being captured.
    if (['Enter', 'Escape', 'Tab'].includes(e.key)) send({ verb: 'press', value: e.key, at: Date.now() });
  }, true);

  let wheel = 0;
  window.addEventListener('wheel', (e) => {
    wheel += e.deltaY;
    send({ verb: 'scroll', value: Math.round(wheel), at: Date.now(), running: true });
  }, { capture: true, passive: true });
})();`;

/**
 * Attach the recorder to a Playwright context and collect what happens.
 *
 * Returns the live array plus a `finish()` that flushes anything still being
 * coalesced. Navigation is captured from the context rather than the page, so a
 * link that opens a new tab is still part of the recording.
 */
export async function attach(context, { now = () => Date.now() } = {}) {
	const raw = [];
	await context.exposeBinding("__rmStep", (source, step) => {
		raw.push({ ...step, url: source.page.url() });
	});
	await context.addInitScript(PAGE_SCRIPT);

	const seen = new Set();
	const onPage = (page) => {
		const record = () => {
			const url = page.url();
			if (!url || url === "about:blank" || seen.has(url)) return;
			seen.add(url);
			raw.push({ verb: "goto", value: url, at: now() });
		};
		page.on("framenavigated", (frame) => {
			if (frame === page.mainFrame()) record();
		});
		record();
	};
	context.on("page", onPage);
	for (const page of context.pages()) onPage(page);

	return { raw, finish: () => condense(raw) };
}

/**
 * Turn raw events into steps worth replaying.
 *
 * Three jobs, all of them about not writing down noise. Keystrokes arrive one
 * `input` event per character, so consecutive typing into the same field
 * collapses to the last value. A scroll arrives per wheel tick and collapses to
 * the total. And a real pause — someone reading the screen, or a page taking a
 * moment — becomes an explicit `wait`, because the pauses are part of what makes
 * a demo watchable and are the first thing lost when you re-author it by hand.
 */
export function condense(raw) {
	const steps = [];
	let last = null;

	for (const ev of raw) {
		const previous = steps[steps.length - 1];

		if (ev.verb === "type" && previous?.verb === "type" && previous.selector === ev.selector && ev.at - last <= TYPE_IDLE_MS) {
			previous.args[1] = ev.value;
			last = ev.at;
			continue;
		}
		if (ev.verb === "scroll" && previous?.verb === "scroll" && ev.at - last <= SCROLL_IDLE_MS) {
			previous.args[0] = ev.value;
			last = ev.at;
			continue;
		}
		// A goto for a url we are already on adds nothing.
		if (ev.verb === "goto" && previous?.verb === "goto" && previous.args[0] === ev.value) continue;

		if (last !== null && ev.at - last >= KEEP_WAIT_MS && ev.verb !== "goto") {
			const held = Math.round((ev.at - last) / WAIT_ROUND_MS) * WAIT_ROUND_MS;
			if (held > 0) steps.push({ verb: "wait", args: [held] });
		}

		if (ev.verb === "type") steps.push({ verb: "type", selector: ev.selector, args: [ev.selector, ev.value] });
		else if (ev.verb === "scroll") steps.push({ verb: "scroll", args: [ev.value] });
		else steps.push({ verb: ev.verb, args: [ev.value] });
		last = ev.at;
	}

	// A trailing scroll of zero is somebody scrolling back to where they started.
	return steps.filter((s) => !(s.verb === "scroll" && s.args[0] === 0));
}

/** Quote an argument the way the DSL reads it back. */
const quote = (v) =>
	typeof v === "number" ? String(v) : `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * Write steps as a demo script.
 *
 * Bare for a url or a key, quoted for anything that might contain a space —
 * which is most selectors here, since they are usually visible text.
 */
export function serialize(steps, { title = "Recorded demo", narrate = true } = {}) {
	const body = steps.map((s) => {
		if (s.verb === "goto" || s.verb === "press") return `${s.verb} ${s.args[0]}`;
		return `${s.verb} ${s.args.map(quote).join(" ")}`;
	});
	const lines = [`# ${title}`, ""];
	if (narrate) {
		lines.push("<!-- Write what you want said here. Prose is narration; the block below is what the browser does. -->", "");
	}
	lines.push("```do", ...body, "```", "");
	return lines.join("\n");
}
