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
