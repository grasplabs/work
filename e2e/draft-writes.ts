import { createHash } from "node:crypto";

import { canonicalJson } from "@grasp-os/shared/json";

import { execute, quoted } from "./connections-seed.ts";

// An App's draft written straight into core's database, as a chat's
// agent's `env.build.write` leaves it, through wrangler on the stack's
// local state (as connections-seed.ts writes into connect's): the local
// stack reaches no model.

/** The SHA-256 of `text`'s UTF-8 bytes, as hex, as core hashes them. */
const sha256 = (text: string): string =>
  createHash("sha256").update(text, "utf-8").digest("hex");

/**
 * Writes the draft of `app` over `base`, with `files`, as `userId`'s agent
 * in chat `chatId` writes it: the draft at its next revision (a publish
 * leaves a draft behind, empty over the version it made live) holding
 * only `files`, and its next undo point, naming the chat, as core's
 * app-drafts.ts keeps them.
 */
export const writeDraft = async (
  userId: string,
  chatId: string,
  app: string,
  base: number,
  files: Record<string, string>
): Promise<void> => {
  const hashes = Object.fromEntries(
    Object.entries(files).map(([path, content]) => [path, sha256(content)])
  );
  const now = Date.now();
  const id = quoted(app);
  const point = `(SELECT MAX(number) FROM app_draft_points WHERE app_id = ${id})`;
  await execute(
    [
      `INSERT INTO app_drafts (app_id, base, revision, updated_at, updated_by) VALUES (${id}, ${base}, 1, ${now}, ${quoted(userId)}) ON CONFLICT(app_id) DO UPDATE SET base = excluded.base, revision = app_drafts.revision + 1, updated_at = excluded.updated_at, updated_by = excluded.updated_by;`,
      `DELETE FROM app_draft_files WHERE app_id = ${id};`,
      ...Object.entries(files).map(
        ([path, content]) =>
          `INSERT INTO app_draft_files (app_id, path, content) VALUES (${id}, ${quoted(path)}, ${quoted(content)});`
      ),
      `INSERT INTO app_draft_points (app_id, number, revision, base, content_hash, person_id, chat_id, created_at) SELECT ${id}, COALESCE(MAX(number), 0) + 1, (SELECT revision FROM app_drafts WHERE app_id = ${id}), ${base}, ${quoted(sha256(canonicalJson({ base, files: hashes, definition: null })))}, ${quoted(userId)}, ${quoted(chatId)}, ${now} FROM app_draft_points WHERE app_id = ${id};`,
      ...Object.entries(files).map(
        ([path, content]) =>
          `INSERT OR IGNORE INTO app_draft_contents (app_id, sha256, content) VALUES (${id}, ${quoted(hashes[path] ?? "")}, ${quoted(content)});`
      ),
      ...Object.entries(hashes).map(
        ([path, hash]) =>
          `INSERT INTO app_draft_point_files (app_id, number, path, sha256) VALUES (${id}, ${point}, ${quoted(path)}, ${quoted(hash)});`
      ),
    ].join("\n"),
    "core"
  );
};
