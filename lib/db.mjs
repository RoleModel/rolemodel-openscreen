/*
 * The shared tables, through Drizzle, over Neon's HTTP driver.
 *
 * WHY THESE TWO
 *
 * `drizzle-orm` is the query builder — typed against lib/schema.mjs, so a column
 * renamed in one place fails to compile in the other. `@neondatabase/serverless`
 * is the wire: one HTTPS request per statement, no socket to keep alive in a
 * desktop app that sleeps with the lid, and nothing to clean up when the Studio
 * exits. Neither carries a dependency of its own.
 *
 * WHAT SECURES IT
 *
 * The role in the connection string — `studio_app`, from sql/studio.sql — and
 * nothing here. It can read and write three tables and cannot delete or alter
 * anything, so the worst a bug in this file can do is write a wrong row.
 *
 * WHAT THIS IS NOT
 *
 * Not a general data layer. It knows three table shapes and the handful of
 * statements the Studio makes against them, deliberately.
 */
import { neon } from "@neondatabase/serverless";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-http";
import { looks, storyboards, studioSettings, studioSkills, styleImages, stylePeople, stickerComments } from "./schema.mjs";

/** A database error, with what was being attempted in front of it. */
class DbError extends Error {
	constructor(message, { code, what } = {}) {
		super(message);
		this.name = "DbError";
		this.code = code;
		this.what = what;
	}
}

/**
 * Turn a driver error into a sentence somebody can act on.
 *
 * The three ways this is set up wrong — a wrong password, an unapplied schema,
 * a role without the grant — arrive as Postgres codes, and each has one fix.
 */
function explain(err, what) {
	// Drizzle wraps the driver's error as the cause of a "Failed query" error, and
	// the driver wraps fetch's the same way; the code and the message that mean
	// anything are at the bottom of that chain.
	let root = err;
	while (root?.cause) root = root.cause;
	const code = err?.code ?? root?.code ?? root?.sourceError?.code ?? null;
	const msg = String(root?.message ?? err?.message ?? err);
	if (code === "42P01" || /relation .* does not exist/.test(msg)) {
		return new DbError(`${what}: no such table — has sql/studio.sql been applied to this database?`, { code, what });
	}
	if (code === "42501" || /permission denied/.test(msg)) {
		return new DbError(`${what}: the studio_app role is not allowed to — re-run sql/studio.sql as the owner to restore its grants`, { code, what });
	}
	if (code === "28P01" || /password authentication failed/i.test(msg)) {
		return new DbError(`${what}: the database refused the password — this build's credential has been rotated; install a newer release`, { code, what });
	}
	if (/fetch failed|ENOTFOUND|ECONNREFUSED|getaddrinfo/.test(msg)) {
		return new DbError(`${what}: could not reach the database (${msg})`, { code, what });
	}
	if (err?.name === "AbortError" || /timed out/i.test(msg)) {
		return new DbError(`${what}: timed out`, { code, what });
	}
	return new DbError(`${what}: ${msg}`, { code, what });
}

/**
 * A timeout, because a hung sync must not hang the panel.
 *
 * Ten seconds: long enough for a cold Postgres on a scale-to-zero branch, short
 * enough that somebody clicking Sync learns it is not working before they click
 * it again.
 */
const TIMEOUT_MS = 10_000;

/* One client per connection string, made on first use and kept. */
const clients = new Map();
export function db(databaseUrl) {
	if (!databaseUrl) throw new DbError("no database configured", { what: "connect" });
	let d = clients.get(databaseUrl);
	if (!d) {
		const client = neon(databaseUrl, {
			// A fresh deadline per request. One shared AbortSignal would expire once
			// and then abort every request after it.
			fetchFunction: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) }),
		});
		d = drizzle({ client });
		clients.set(databaseUrl, d);
	}
	return d;
}

async function attempt(what, run) {
	try {
		return await run();
	} catch (err) {
		throw explain(err, what);
	}
}

/**
 * Read one board.
 *
 * `null` for "no row", which is not an error: a project nobody has pushed yet is
 * the normal first state.
 */
export async function fetchBoard({ databaseUrl, projectId }) {
	return attempt("read the board", async () => {
		const rows = await db(databaseUrl).select({ board: storyboards.board }).from(storyboards).where(eq(storyboards.projectId, projectId)).limit(1);
		return rows[0]?.board ?? null;
	});
}

/**
 * Write one board, as an upsert on the project id.
 *
 * The merge that matters is NOT this one — it is `mergeBoards`, run client-side
 * before we get here. Postgres is storing an already-merged document; asking it
 * to merge jsonb field by field would drop one of two people rating different
 * takes in the same second.
 */
export async function putBoard({ databaseUrl, projectId, board, by = null }) {
	return attempt("write the board", async () => {
		const updatedAt = new Date().toISOString();
		await db(databaseUrl)
			.insert(storyboards)
			.values({ projectId, board, updatedBy: by, updatedAt })
			.onConflictDoUpdate({ target: storyboards.projectId, set: { board, updatedBy: by, updatedAt } });
		return board;
	});
}

/**
 * Can this build actually reach the table?
 *
 * Asked before anything is trusted. A count rather than a select: it proves the
 * role may read the table at all, and comes back with a number the panel can
 * show as evidence.
 */
export async function probe({ databaseUrl }) {
	return attempt("check the table", async () => {
		const rows = await db(databaseUrl).select({ n: sql`count(*)::int` }).from(storyboards);
		return { ok: true, rows: rows[0]?.n ?? null };
	});
}

/*
 * Shared Studio skills.
 *
 * A skill is kept as its original zip plus the editable SKILL.md text. Keeping
 * the zip means references, scripts, and assets travel with the instruction;
 * keeping the text separately lets the Studio edit the instruction without
 * having to rebuild an archive in the browser.
 *
 * Rows go out in the column names the Studio has always used (skill_md,
 * bundle_base64, …), so the server code that reads them did not have to change
 * when the transport did.
 */
const skillRow = (r) =>
	r && {
		id: r.id,
		slug: r.slug,
		name: r.name,
		description: r.description,
		skill_md: r.skillMd,
		bundle_base64: r.bundleBase64,
		entry_path: r.entryPath,
		version: r.version,
		created_by: r.createdBy,
		updated_by: r.updatedBy,
		created_at: r.createdAt,
		updated_at: r.updatedAt,
	};

export async function fetchStudioSkills({ databaseUrl }) {
	return attempt("read shared skills", async () => {
		const rows = await db(databaseUrl)
			.select({
				slug: studioSkills.slug,
				name: studioSkills.name,
				description: studioSkills.description,
				entry_path: studioSkills.entryPath,
				version: studioSkills.version,
				updated_at: studioSkills.updatedAt,
			})
			.from(studioSkills)
			.orderBy(asc(studioSkills.name));
		return rows;
	});
}

export async function fetchStudioSkill({ databaseUrl, slug }) {
	return attempt("read shared skill", async () => {
		const rows = await db(databaseUrl).select().from(studioSkills).where(eq(studioSkills.slug, slug)).limit(1);
		return skillRow(rows[0]) ?? null;
	});
}

export async function createStudioSkill({ databaseUrl, by, skill }) {
	return attempt("create shared skill", async () => {
		const rows = await db(databaseUrl)
			.insert(studioSkills)
			.values({
				slug: skill.slug,
				name: skill.name,
				description: skill.description ?? null,
				skillMd: skill.skill_md,
				bundleBase64: skill.bundle_base64,
				entryPath: skill.entry_path ?? "SKILL.md",
				version: skill.version ?? 1,
				createdBy: by,
				updatedBy: by,
			})
			.returning();
		return skillRow(rows[0]) ?? null;
	});
}

export async function updateStudioSkill({ databaseUrl, by, slug, skill }) {
	return attempt("update shared skill", async () => {
		const set = { updatedBy: by, updatedAt: new Date().toISOString() };
		if (skill.name !== undefined) set.name = skill.name;
		if (skill.description !== undefined) set.description = skill.description;
		if (skill.skill_md !== undefined) set.skillMd = skill.skill_md;
		if (skill.bundle_base64 !== undefined) set.bundleBase64 = skill.bundle_base64;
		if (skill.entry_path !== undefined) set.entryPath = skill.entry_path;
		if (skill.version !== undefined) set.version = skill.version;
		const rows = await db(databaseUrl).update(studioSkills).set(set).where(eq(studioSkills.slug, slug)).returning();
		return skillRow(rows[0]) ?? null;
	});
}

/*
 * Team settings.
 *
 * Connection details that belong to the team rather than to one laptop — the
 * Slack bot token first. One table, keyed by a short string, holding a jsonb
 * value, because these are a handful of small objects and a column per setting
 * would mean a migration every time one is added.
 */
export async function fetchSetting({ databaseUrl, name }) {
	return attempt("read the shared setting", async () => {
		const rows = await db(databaseUrl).select({ value: studioSettings.value }).from(studioSettings).where(eq(studioSettings.key, name)).limit(1);
		return rows[0]?.value ?? null;
	});
}

/** Upsert on the key, the same shape as putBoard. */
export async function putSetting({ databaseUrl, name, value, by = null }) {
	return attempt("write the shared setting", async () => {
		const updatedAt = new Date().toISOString();
		await db(databaseUrl)
			.insert(studioSettings)
			.values({ key: name, value, updatedBy: by, updatedAt })
			.onConflictDoUpdate({ target: studioSettings.key, set: { value, updatedBy: by, updatedAt } });
		return value;
	});
}

/*
 * The brand collage library.
 *
 * Rows go out with snake_case names, the shape the panel and the old app share.
 * Delete is real here — a bad generation is noise in a shared library — and it
 * is the only place the role may delete: see the grants in sql/studio.sql.
 */
const imageRow = (r) => r && { id: r.id, subject: r.subject, prompt: r.prompt, model: r.model, aspect: r.aspect, url: r.url, file: r.file, project_id: r.projectId, project_rel: r.projectRel, created_by: r.createdBy, created_at: r.createdAt };
const personRow = (r) => r && { id: r.id, name: r.name, photo: r.photo, created_by: r.createdBy, created_at: r.createdAt };

export async function listStyleImages({ databaseUrl }) {
	return attempt("read the style library", async () => (await db(databaseUrl).select().from(styleImages).orderBy(desc(styleImages.createdAt))).map(imageRow));
}

export async function insertStyleImage({ databaseUrl, image, by = null }) {
	return attempt("save the image", async () => {
		const rows = await db(databaseUrl)
			.insert(styleImages)
			.values({ subject: image.subject, prompt: image.prompt ?? null, model: image.model ?? null, aspect: image.aspect ?? null, url: image.url, file: image.file ?? null, projectId: image.project_id ?? null, projectRel: image.project_rel ?? null, createdBy: by, ...(image.created_at ? { createdAt: image.created_at } : {}) })
			.returning();
		return imageRow(rows[0]);
	});
}

export async function updateStyleImage({ databaseUrl, id, patch }) {
	return attempt("rename the image", async () => {
		const set = {};
		if (patch.subject !== undefined) set.subject = patch.subject;
		if (patch.file !== undefined) set.file = patch.file;
		if (patch.project_id !== undefined) set.projectId = patch.project_id;
		if (patch.project_rel !== undefined) set.projectRel = patch.project_rel;
		if (patch.url !== undefined) set.url = patch.url;
		const rows = await db(databaseUrl).update(styleImages).set(set).where(eq(styleImages.id, id)).returning();
		return imageRow(rows[0]) ?? null;
	});
}

export async function deleteStyleImage({ databaseUrl, id }) {
	return attempt("delete the image", async () => {
		const rows = await db(databaseUrl).delete(styleImages).where(eq(styleImages.id, id)).returning();
		return imageRow(rows[0]) ?? null;
	});
}

export async function listStylePeople({ databaseUrl }) {
	return attempt("read the people", async () => (await db(databaseUrl).select().from(stylePeople).orderBy(asc(stylePeople.name))).map(personRow));
}

export async function stylePeopleById({ databaseUrl, ids }) {
	return attempt("read the people", async () => {
		const rows = await db(databaseUrl).select().from(stylePeople);
		const want = new Set(ids);
		return rows.filter((r) => want.has(r.id)).map(personRow);
	});
}

export async function insertStylePerson({ databaseUrl, person, by = null }) {
	return attempt("add the person", async () => {
		const rows = await db(databaseUrl).insert(stylePeople).values({ name: person.name, photo: person.photo, createdBy: by }).returning();
		return personRow(rows[0]);
	});
}

export async function renameStylePerson({ databaseUrl, id, name }) {
	return attempt("rename the person", async () => {
		const rows = await db(databaseUrl).update(stylePeople).set({ name }).where(eq(stylePeople.id, id)).returning();
		return personRow(rows[0]) ?? null;
	});
}

export async function deleteStylePerson({ databaseUrl, id }) {
	return attempt("remove the person", async () => {
		const rows = await db(databaseUrl).delete(stylePeople).where(eq(stylePeople.id, id)).returning();
		return personRow(rows[0]) ?? null;
	});
}

/* The Creator's saved looks. */
const lookRow = (r) => r && { id: r.id, name: r.name, look: r.look, preview_file: r.previewFile, project_id: r.projectId, created_by: r.createdBy, created_at: r.createdAt };

export async function listLooks({ databaseUrl }) {
	return attempt("read the saved looks", async () => (await db(databaseUrl).select().from(looks).orderBy(desc(looks.createdAt))).map(lookRow));
}

export async function insertLook({ databaseUrl, look, by = null }) {
	return attempt("save the look", async () => {
		const rows = await db(databaseUrl).insert(looks).values({ name: look.name, look: look.look, previewFile: look.preview_file ?? null, projectId: look.project_id ?? null, createdBy: by }).returning();
		return lookRow(rows[0]);
	});
}

export async function updateLook({ databaseUrl, id, patch }) {
	return attempt("rename the look", async () => {
		const set = {};
		if (patch.name !== undefined) set.name = patch.name;
		if (patch.look !== undefined) set.look = patch.look;
		if (patch.preview_file !== undefined) set.previewFile = patch.preview_file;
		const rows = await db(databaseUrl).update(looks).set(set).where(eq(looks.id, id)).returning();
		return lookRow(rows[0]) ?? null;
	});
}

export async function deleteLook({ databaseUrl, id }) {
	return attempt("delete the look", async () => {
		const rows = await db(databaseUrl).delete(looks).where(eq(looks.id, id)).returning();
		return lookRow(rows[0]) ?? null;
	});
}

export { DbError };

/* ── sticker comments ─────────────────────────────────────────────────────── */

const commentRow = (r) => ({ id: r.id, project: r.project, sticker: r.sticker, author: r.author, body: r.body, created_at: r.createdAt });

export async function listStickerComments({ databaseUrl, project, sticker = null }) {
	return attempt("read the comments", async () => {
		const where = sticker ? and(eq(stickerComments.project, project), eq(stickerComments.sticker, sticker)) : eq(stickerComments.project, project);
		return (await db(databaseUrl).select().from(stickerComments).where(where).orderBy(stickerComments.createdAt)).map(commentRow);
	});
}

export async function insertStickerComment({ databaseUrl, project, sticker, body, by = null }) {
	return attempt("add the comment", async () => {
		const rows = await db(databaseUrl).insert(stickerComments).values({ project, sticker, body, author: by }).returning();
		return commentRow(rows[0]);
	});
}

export async function deleteStickerComment({ databaseUrl, id }) {
	return attempt("remove the comment", async () => {
		await db(databaseUrl).delete(stickerComments).where(eq(stickerComments.id, id));
		return { ok: true };
	});
}
