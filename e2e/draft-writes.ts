import { createHash } from "node:crypto";

import { canonicalJson } from "@grasp-os/shared/json";

import { origin } from "./stack.ts";

// A chat's draft written straight into its Workspace object, as the
// agent's `env.build.write` leaves it, through the local dev server's own
// tools (as connections-seed.ts writes into connect's database): the local
// stack reaches no model.

/** Where the local dev server runs SQL in a Durable Object's storage. */
const explorer = new URL("/cdn-cgi/local/explorer/api/", origin);

const namespacesSchema = {
  parse: (value: unknown): { id: string; class: string }[] => {
    if (
      typeof value !== "object" ||
      value === null ||
      !("result" in value) ||
      !Array.isArray(value.result)
    ) {
      throw new TypeError("The dev server listed no Durable Objects");
    }
    return value.result.flatMap((entry: unknown) =>
      typeof entry === "object" &&
      entry !== null &&
      "id" in entry &&
      typeof entry.id === "string" &&
      "class" in entry &&
      typeof entry.class === "string"
        ? [{ id: entry.id, class: entry.class }]
        : []
    );
  },
};

/** The SHA-256 of `text`'s UTF-8 bytes, as hex, as core hashes them. */
const sha256 = (text: string): string =>
  createHash("sha256").update(text, "utf-8").digest("hex");

/**
 * Writes a draft of `app` over `base`, with `files`, into `chatId` in
 * `userId`'s Workspace object (core's chats-rpc.ts names it), as its
 * agent's first write does: the draft, and its version 1 as core's
 * draft-versions.ts keeps it.
 */
export const writeDraft = async (
  userId: string,
  chatId: string,
  app: string,
  base: number,
  files: Record<string, string>
): Promise<void> => {
  const listed = await fetch(
    new URL("workers/durable_objects/namespaces", explorer)
  );
  const workspaces = namespacesSchema
    .parse(await listed.json())
    .find((namespace) => namespace.class === "Workspace");
  if (workspaces === undefined) {
    throw new Error("The dev server has no Workspace objects");
  }
  const hashes = Object.fromEntries(
    Object.entries(files).map(([path, content]) => [path, sha256(content)])
  );
  const now = Date.now();
  const written = await fetch(
    new URL(
      `workers/durable_objects/namespaces/${encodeURIComponent(workspaces.id)}/query`,
      explorer
    ),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        durable_object_name: `person:${userId}`,
        queries: [
          {
            sql: "INSERT INTO chat_drafts (chat_id, app_id, base, revision, updated_at) VALUES (?, ?, ?, 1, ?)",
            params: [chatId, app, base, now],
          },
          ...Object.entries(files).map(([path, content]) => ({
            sql: "INSERT INTO chat_draft_files (chat_id, app_id, path, content) VALUES (?, ?, ?, ?)",
            params: [chatId, app, path, content],
          })),
          {
            sql: "INSERT INTO chat_draft_versions (chat_id, app_id, number, revision, base, content_hash, created_at) VALUES (?, ?, 1, 1, ?, ?, ?)",
            params: [
              chatId,
              app,
              base,
              sha256(canonicalJson({ base, files: hashes, definition: null })),
              now,
            ],
          },
          ...Object.entries(files).map(([path, content]) => ({
            sql: "INSERT INTO chat_draft_contents (chat_id, app_id, sha256, content) VALUES (?, ?, ?, ?)",
            params: [chatId, app, hashes[path], content],
          })),
          ...Object.entries(hashes).map(([path, hash]) => ({
            sql: "INSERT INTO chat_draft_version_files (chat_id, app_id, number, path, sha256) VALUES (?, ?, 1, ?, ?)",
            params: [chatId, app, path, hash],
          })),
        ],
      }),
    }
  );
  if (!written.ok) {
    throw new Error(`The draft wasn't written: ${await written.text()}`);
  }
};
