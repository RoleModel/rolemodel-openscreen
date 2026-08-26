/*
 * The storyboard as a graph: nodes you drag, wires that are the running order.
 *
 * WHY WIRES RATHER THAN COLUMN ORDER
 *
 * The first storyboard laid shots out in columns and took their order from an
 * `order` integer. That is fine while the video is a list and wrong the moment
 * it is not: reordering meant renumbering, an alternative ending had nowhere to
 * live, and the one thing you actually want to see — what follows what — was
 * implied by horizontal position rather than drawn.
 *
 * Wiring the shots makes the running order the thing on screen. Dragging a wire
 * IS re-editing, an unwired node is visibly a shot nobody has placed yet, and a
 * second wire out of one node is an alternative cut you can look at instead of a
 * decision you had to make in advance.
 *
 * CANVAS UNITS, NOT PIXELS
 *
 * Borrowed from the moodboard canvas in addison-photos, and for the same reason:
 * positions are stored against a fixed coordinate space and the viewport scales
 * to fit whatever is looking at it. A board arranged on a laptop is the same
 * arrangement on a projector rather than a different picture, and — since this
 * syncs — the same arrangement on a teammate's machine.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 * No DOM, no fetch, no disk, no clock. The canvas imports this to decide whether
 * a wire being dragged may be dropped; the compile step imports it to turn the
 * graph into a cut list; a future save would import it to refuse a wire the
 * canvas should never have sent. Three callers, one answer, no chance of them
 * disagreeing — which is the property that made the reference implementation
 * worth copying.
 */

/** Bumped when a stored graph can no longer be read by this file. */
export const GRAPH_VERSION = 1;

/*
 * Roomy, because a graph grows sideways in a way a column layout never did.
 *
 * A shot node is 360 units wide, so 12,000 holds about thirty across and as many
 * rows. The reference canvas learned this the expensive way: too small a space
 * and the save silently clamps incoming geometry, which shows up as nodes
 * quietly moving on the next load rather than as any error at all.
 */
export const CANVAS_WIDTH = 12_000;
export const CANVAS_HEIGHT = 9_000;

/** What a new board opens on — a screenful in the middle, not the whole space. */
export const START_VIEW_WIDTH = 4_000;
export const START_VIEW_HEIGHT = 3_000;

export const NODE_WIDTH = 360;
export const NODE_HEIGHT = 260;
/** Enough that two nodes side by side have a visible gap for a wire to cross. */
export const NODE_GAP_X = 200;
export const NODE_GAP_Y = 120;

/**
 * What a node can be.
 *
 * `shot` is the one that existed before this file: a beat the plan asks for,
 * holding takes. The others are here because a video is not only footage, and
 * because a node graph is the first structure that can hold them in the running
 * order rather than beside it.
 *
 * `runnable` marks the kinds that put something on the timeline. A note is a
 * note — it belongs on the board, and it must never become a clip.
 */
export const NODE_KINDS = {
	shot: { id: "shot", label: "Shot", runnable: true, hint: "A beat the video needs. Takes go under it." },
	title: { id: "title", label: "Title", runnable: true, hint: "A title card over the cut." },
	scene: { id: "scene", label: "Scene", runnable: true, hint: "A composed scene, rendered from components." },
	note: { id: "note", label: "Note", runnable: false, hint: "For the people reading the board. Never rendered." },
};

export const isRunnable = (node) => Boolean(NODE_KINDS[node?.kind]?.runnable);

/** Ids derive from content, exactly as in cutlist.mjs and storyboard.mjs. */
export const idFor = (prefix, seed) => `${prefix}_${Buffer.from(String(seed)).toString("base64url").slice(-16)}`;

/** Clamp a position into the canvas, so a drag cannot park a node where nothing can reach it. */
export const clampPoint = (x, y) => ({
	x: Math.min(CANVAS_WIDTH - NODE_WIDTH, Math.max(0, Math.round(Number(x) || 0))),
	y: Math.min(CANVAS_HEIGHT - NODE_HEIGHT, Math.max(0, Math.round(Number(y) || 0))),
});

/**
 * Lay a fresh plan out left to right.
 *
 * A straight row rather than anything cleverer: the plan states an order, and
 * the first thing somebody should see is that order, drawn. Rearranging it is
 * the point of the canvas — but the arrangement it opens on should be the one
 * they already described.
 */
export function graphFromPlan(plan, { boardId = "b", startX = 400, startY = 400, perRow = 6 } = {}) {
	const shots = Array.isArray(plan?.shots) ? plan.shots : [];
	const nodes = shots.map((s, i) => {
		const name = String(s?.name ?? `Shot ${i + 1}`).trim() || `Shot ${i + 1}`;
		const { x, y } = clampPoint(
			startX + (i % perRow) * (NODE_WIDTH + NODE_GAP_X),
			startY + Math.floor(i / perRow) * (NODE_HEIGHT + NODE_GAP_Y),
		);
		return {
			id: idFor("node", `${boardId}:${i}:${name}`),
			kind: "shot",
			name,
			intent: String(s?.intent ?? "").trim(),
			seconds: Number(s?.seconds) > 0 ? Number(s.seconds) : null,
			x,
			y,
		};
	});
	// Wired in the order the plan gave, because that IS the plan.
	const wires = nodes.slice(1).map((n, i) => ({
		id: idFor("wire", `${nodes[i].id}->${n.id}`),
		from: nodes[i].id,
		to: n.id,
	}));
	return { version: GRAPH_VERSION, nodes, wires };
}

/**
 * May this wire be made?
 *
 * Answered here rather than in the canvas so the drag preview, the drop and any
 * later save all get the same answer. Returns a REASON rather than a boolean:
 * the canvas shows it while the wire is mid-drag, which is the only moment the
 * explanation is worth anything.
 */
export function canConnect(graph, from, to) {
	if (!from || !to) return { ok: false, why: "a wire needs both ends" };
	if (from === to) return { ok: false, why: "a shot cannot follow itself" };
	const nodes = new Map((graph?.nodes ?? []).map((n) => [n.id, n]));
	if (!nodes.has(from) || !nodes.has(to)) return { ok: false, why: "that node is not on this board" };
	// A note is a note. Wiring one would put it in the running order, and the one
	// thing a note must never do is become a clip.
	if (!isRunnable(nodes.get(from)) || !isRunnable(nodes.get(to))) {
		return { ok: false, why: "a note is for the people reading the board — it cannot be part of the cut" };
	}
	if ((graph?.wires ?? []).some((w) => w.from === from && w.to === to)) {
		return { ok: false, why: "these are already connected" };
	}
	/*
	 * A cycle is the one structurally impossible edit.
	 *
	 * Everything else here is a rule we chose; this one is arithmetic — a running
	 * order that loops has no end, and the compile step would either hang or pick
	 * an arbitrary place to stop. Checked before the wire exists rather than
	 * after, so the canvas can refuse the drop.
	 */
	if (reaches(graph, to, from)) return { ok: false, why: "that would loop — the cut has to end somewhere" };
	return { ok: true, why: null };
}

/** Can `from` get to `target` by following wires? Depth-first, cycle-safe. */
export function reaches(graph, from, target) {
	const out = outgoing(graph);
	const seen = new Set();
	const stack = [from];
	while (stack.length) {
		const at = stack.pop();
		if (at === target) return true;
		if (seen.has(at)) continue;
		seen.add(at);
		for (const w of out.get(at) ?? []) stack.push(w.to);
	}
	return false;
}

const outgoing = (graph) => {
	const map = new Map();
	for (const w of graph?.wires ?? []) {
		const list = map.get(w.from) ?? [];
		list.push(w);
		map.set(w.from, list);
	}
	return map;
};

const incoming = (graph) => {
	const map = new Map();
	for (const w of graph?.wires ?? []) {
		const list = map.get(w.to) ?? [];
		list.push(w);
		map.set(w.to, list);
	}
	return map;
};

/**
 * Where the cut starts: a runnable node nothing wires into.
 *
 * More than one is legitimate — two unconnected chains on a board is somebody
 * working on the middle before the beginning — so this returns all of them, in
 * canvas order, and `runningOrder` walks each in turn. Left-to-right then
 * top-to-bottom, because that is the order a person reads a board they have
 * arranged.
 */
export function startNodes(graph) {
	const into = incoming(graph);
	return (graph?.nodes ?? [])
		.filter((n) => isRunnable(n) && !(into.get(n.id) ?? []).length)
		.sort((a, b) => a.y - b.y || a.x - b.x);
}

/**
 * The running order the wires describe.
 *
 * Follows the FIRST outgoing wire of each node, taking a branch's other wires as
 * alternatives rather than as parallel tracks — a cut is one thing after
 * another, and a node with two outgoing wires is a choice somebody has not made
 * yet. Which one is "first" is the topmost on the canvas, so the answer is
 * visible rather than hidden in insertion order.
 *
 * Returns what it could not place as well as what it could. A node stranded off
 * the chain is the most common thing to get wrong on a board, and silently
 * dropping it from the cut is how you ship a video missing a shot.
 */
export function runningOrder(graph) {
	const out = outgoing(graph);
	const byId = new Map((graph?.nodes ?? []).map((n) => [n.id, n]));
	const order = [];
	const placed = new Set();
	const branches = [];
	/*
	 * Each start begins a CHAIN, and more than one chain is worth saying out loud.
	 *
	 * Cutting a wire does not strand the node after it — that node simply has no
	 * incoming wire any more, which makes it the start of a second run. Keeping it
	 * in the cut is the safe direction (silently dropping a shot is how a video
	 * ships missing a beat), but it is invisible: the board looks the same and the
	 * running order quietly gained a seam. Two chains is nearly always a wire
	 * somebody meant to reconnect, so the count is reported and the canvas says so.
	 */
	const chains = [];

	for (const start of startNodes(graph)) {
		let at = start.id;
		const chain = [];
		while (at && !placed.has(at)) {
			const node = byId.get(at);
			if (!node) break;
			placed.add(at);
			order.push(node);
			const next = [...(out.get(at) ?? [])].sort((a, b) => {
				const na = byId.get(a.to);
				const nb = byId.get(b.to);
				return (na?.y ?? 0) - (nb?.y ?? 0) || (na?.x ?? 0) - (nb?.x ?? 0);
			});
			if (next.length > 1) branches.push({ at: node, taken: next[0].to, alternatives: next.slice(1).map((w) => w.to) });
			chain.push(node);
			at = next[0]?.to ?? null;
		}
		if (chain.length) chains.push(chain);
	}

	// Only a node inside a cycle can be unreachable from every start, and
	// `canConnect` refuses cycles — so this stays empty unless a graph was
	// hand-edited. Reported anyway: a shot missing from the cut with no
	// explanation is the failure this whole function exists to prevent.
	const stranded = (graph?.nodes ?? []).filter((n) => isRunnable(n) && !placed.has(n.id));
	return { order, stranded, branches, chains };
}

/**
 * Add a wire, refusing the ones that cannot be made.
 *
 * Returns the graph unchanged plus a reason rather than throwing: this runs on a
 * pointer-up, and a refused drop is an ordinary outcome that should say why,
 * not an exception.
 */
export function connect(graph, from, to) {
	const verdict = canConnect(graph, from, to);
	if (!verdict.ok) return { graph, ...verdict };
	return {
		graph: { ...graph, wires: [...(graph.wires ?? []), { id: idFor("wire", `${from}->${to}`), from, to }] },
		ok: true,
		why: null,
	};
}

export const disconnect = (graph, wireId) => ({
	...graph,
	wires: (graph?.wires ?? []).filter((w) => w.id !== wireId),
});

/** Move a node, clamped into the canvas. */
export function moveNode(graph, nodeId, x, y) {
	const at = clampPoint(x, y);
	return { ...graph, nodes: (graph?.nodes ?? []).map((n) => (n.id === nodeId ? { ...n, ...at } : n)) };
}

/**
 * Remove a node and every wire touching it, healing the chain.
 *
 * Healing rather than leaving a gap: deleting a shot from the middle of a cut
 * means the shot before it now leads to the shot after it. Leaving both ends
 * dangling would silently truncate the video at the deletion point, which is
 * the same class of bug as dropping a stranded node.
 */
export function removeNode(graph, nodeId) {
	const before = (graph?.wires ?? []).filter((w) => w.to === nodeId).map((w) => w.from);
	const after = (graph?.wires ?? []).filter((w) => w.from === nodeId).map((w) => w.to);
	let wires = (graph?.wires ?? []).filter((w) => w.from !== nodeId && w.to !== nodeId);
	for (const from of before) {
		for (const to of after) {
			if (from === to) continue;
			if (wires.some((w) => w.from === from && w.to === to)) continue;
			wires = [...wires, { id: idFor("wire", `${from}->${to}`), from, to }];
		}
	}
	return { ...graph, nodes: (graph?.nodes ?? []).filter((n) => n.id !== nodeId), wires };
}

/**
 * Where a wire attaches, in canvas units.
 *
 * Out of the right edge, into the left, both at the vertical middle. Every port
 * leaves sideways, which is what lets `wirePath` draw a cable rather than a
 * diagonal.
 */
export const outPoint = (node) => ({ x: node.x + NODE_WIDTH, y: node.y + NODE_HEIGHT / 2 });
export const inPoint = (node) => ({ x: node.x, y: node.y + NODE_HEIGHT / 2 });

/**
 * A cubic Bézier with horizontal control points.
 *
 * Lifted from the reference canvas, including the floor on the control distance:
 * without it a wire between two touching nodes collapses into a straight line
 * drawn through both of them.
 */
export const wirePath = (from, to) => {
	const reach = Math.max(48, Math.abs(to.x - from.x) * 0.5);
	return `M ${from.x} ${from.y} C ${from.x + reach} ${from.y}, ${to.x - reach} ${to.y}, ${to.x} ${to.y}`;
};

/** The box every node fits inside, for a fit-to-content zoom. */
export function boundsOf(graph) {
	const nodes = graph?.nodes ?? [];
	if (!nodes.length) return { x: 0, y: 0, width: START_VIEW_WIDTH, height: START_VIEW_HEIGHT };
	const minX = Math.min(...nodes.map((n) => n.x));
	const minY = Math.min(...nodes.map((n) => n.y));
	const maxX = Math.max(...nodes.map((n) => n.x + NODE_WIDTH));
	const maxY = Math.max(...nodes.map((n) => n.y + NODE_HEIGHT));
	return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}
