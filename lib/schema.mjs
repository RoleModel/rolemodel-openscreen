/*
 * The three shared tables, as Drizzle sees them.
 *
 * This is the read side of sql/studio.sql — the same columns, so a query that
 * compiles here is one the database will take. The SQL file stays the thing
 * that is applied: it also creates the role and the grants, which a schema
 * definition has no place for.
 */
import { integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const storyboards = pgTable("storyboards", {
	projectId: text("project_id").primaryKey(),
	board: jsonb("board").notNull(),
	updatedBy: text("updated_by"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

export const studioSettings = pgTable("studio_settings", {
	key: text("key").primaryKey(),
	value: jsonb("value").notNull(),
	updatedBy: text("updated_by"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

export const studioSkills = pgTable("studio_skills", {
	id: uuid("id").primaryKey().defaultRandom(),
	slug: text("slug").notNull().unique(),
	name: text("name").notNull(),
	description: text("description"),
	skillMd: text("skill_md").notNull(),
	bundleBase64: text("bundle_base64").notNull(),
	entryPath: text("entry_path").notNull().default("SKILL.md"),
	version: integer("version").notNull().default(1),
	createdBy: text("created_by"),
	updatedBy: text("updated_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

/*
 * The brand collage generator's library: every picture made, and the teammates
 * whose photos can be placed in one. Brought over from the style app, where
 * these were `brand_images` and `people` in a Neon of their own.
 */
export const styleImages = pgTable("style_images", {
	id: uuid("id").primaryKey().defaultRandom(),
	subject: text("subject").notNull(),
	prompt: text("prompt"),
	model: text("model"),
	aspect: text("aspect"),
	/** Where the picture was fetched from — fal's CDN, or the old app's copy. */
	url: text("url").notNull(),
	/** The Studio's own copy, a file name in the library's Style folder. */
	file: text("file"),
	createdBy: text("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

export const stylePeople = pgTable("style_people", {
	id: uuid("id").primaryKey().defaultRandom(),
	name: text("name").notNull(),
	/** A small JPEG as a data URI, resized in the browser before it is sent. */
	photo: text("photo").notNull(),
	createdBy: text("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});
