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
 * only `files`, and its next checkpoint, naming the chat, as core's
 * drafts.ts keeps them. With `definition` (its text, as
 * `definitionText` writes it), the draft's own App definition too, as the
 * agent's definition tools leave it; without, the base's.
 */
export const writeDraft = async (
  userId: string,
  chatId: string,
  app: string,
  base: number,
  files: Record<string, string>,
  definition: string | null = null
): Promise<void> => {
  const hashes = Object.fromEntries(
    Object.entries(files).map(([path, content]) => [path, sha256(content)])
  );
  const now = Date.now();
  const id = quoted(app);
  const defined = definition === null ? "NULL" : quoted(definition);
  const ofApp = `subject_kind = 'app' AND subject_id = ${id}`;
  const checkpoint = `(SELECT MAX(number) FROM draft_checkpoints WHERE ${ofApp})`;
  await execute(
    [
      `INSERT INTO drafts (subject_kind, subject_id, base, revision, definition, updated_at, updated_by) VALUES ('app', ${id}, ${base}, 1, ${defined}, ${now}, ${quoted(userId)}) ON CONFLICT(subject_kind, subject_id) DO UPDATE SET base = excluded.base, revision = drafts.revision + 1, definition = excluded.definition, updated_at = excluded.updated_at, updated_by = excluded.updated_by;`,
      `DELETE FROM draft_files WHERE ${ofApp};`,
      ...Object.entries(files).map(
        ([path, content]) =>
          `INSERT INTO draft_files (subject_kind, subject_id, path, content) VALUES ('app', ${id}, ${quoted(path)}, ${quoted(content)});`
      ),
      `INSERT INTO draft_checkpoints (subject_kind, subject_id, number, revision, base, definition, content_hash, person_id, chat_id, created_at) SELECT 'app', ${id}, COALESCE(MAX(number), 0) + 1, (SELECT revision FROM drafts WHERE ${ofApp}), ${base}, ${defined}, ${quoted(sha256(canonicalJson({ base, files: hashes, definition: definition === null ? null : sha256(definition) })))}, ${quoted(userId)}, ${quoted(chatId)}, ${now} FROM draft_checkpoints WHERE ${ofApp};`,
      ...Object.entries(files).map(
        ([path, content]) =>
          `INSERT OR IGNORE INTO draft_blobs (subject_kind, subject_id, sha256, content) VALUES ('app', ${id}, ${quoted(hashes[path] ?? "")}, ${quoted(content)});`
      ),
      ...Object.entries(hashes).map(
        ([path, hash]) =>
          `INSERT INTO draft_checkpoint_files (subject_kind, subject_id, number, path, sha256) VALUES ('app', ${id}, ${checkpoint}, ${quoted(path)}, ${quoted(hash)});`
      ),
    ].join("\n"),
    "core"
  );
};
