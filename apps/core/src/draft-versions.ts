import { createHash } from "node:crypto";

import { appErrors } from "@grasp-os/shared/apps";
import type { ChatDraftVersion } from "@grasp-os/shared/chat";
import type { ChatId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import { and, desc, eq, max } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import {
  chatDraftContents,
  chatDraftVersionFiles,
  chatDraftVersions,
} from "./db/workspace/schema.ts";
import type { Draft } from "./workspace.ts";

// Every write of a chat's draft of an App, kept as a version that never
// changes (`chat_draft_versions`), where the draft itself holds only the
// latest: so the person can see how the draft got where it is, preview an
// earlier version and restore it, which makes a new version rather than
// rewriting any. A version is written in the transaction of the write it
// records, from the draft as that write left it, so no write lands
// without one and none is kept for a write that didn't land; numbered in
// the order the writes landed. Hashed synchronously (node:crypto, which
// workerd has), as the Workspace object's transactions are. Only the
// Workspace object calls these. Versions are the chat's, as its draft
// is: deleted with the chat.

/** The SHA-256 of `text`'s UTF-8 bytes, as hex. */
const sha256 = (text: string): string =>
  createHash("sha256").update(text, "utf-8").digest("hex");

/** A version's row, as the API answers it. */
const toVersion = (
  row: typeof chatDraftVersions.$inferSelect
): ChatDraftVersion => ({
  number: row.number,
  revision: row.revision,
  base: row.base,
  contentHash: row.contentHash,
  callId: row.callId,
  restoredFrom: row.restoredFrom,
  createdAt: row.createdAt.toISOString(),
});

/** Who wrote a version: the agent's code step, or the person restoring one. */
export type VersionAuthor =
  | { callId: string | null }
  | { restoredFrom: number };

/** A chat's draft versions, in its Workspace object's SQLite. */
export class DraftVersions {
  readonly #db: DrizzleSqliteDODatabase;

  constructor(db: DrizzleSqliteDODatabase) {
    this.#db = db;
  }

  /**
   * Keeps `draft`, the chat's draft of `appId` as a write just left it, as
   * its next version. Called inside the transaction of the write.
   */
  keep(
    chatId: ChatId,
    appId: string,
    draft: Draft,
    by: VersionAuthor,
    createdAt: Date
  ): ChatDraftVersion {
    const number = this.#latest(chatId, appId) + 1;
    const hashes: Record<string, string | null> = {};
    for (const [path, content] of Object.entries(draft.changes)) {
      if (content === null) {
        hashes[path] = null;
        continue;
      }
      const hash = sha256(content);
      hashes[path] = hash;
      this.#db
        .insert(chatDraftContents)
        .values({ chatId, appId, sha256: hash, content })
        .onConflictDoNothing()
        .run();
    }
    const row = {
      chatId,
      appId,
      number,
      revision: draft.revision,
      base: draft.base,
      contentHash: sha256(canonicalJson({ base: draft.base, files: hashes })),
      callId: "callId" in by ? by.callId : null,
      restoredFrom: "restoredFrom" in by ? by.restoredFrom : null,
      createdAt,
    };
    this.#db.insert(chatDraftVersions).values(row).run();
    for (const [path, hash] of Object.entries(hashes)) {
      this.#db
        .insert(chatDraftVersionFiles)
        .values({ chatId, appId, number, path, sha256: hash })
        .run();
    }
    return toVersion(row);
  }

  /** The versions of the chat's draft of `appId`, newest first. */
  list(chatId: ChatId, appId: string): ChatDraftVersion[] {
    return this.#db
      .select()
      .from(chatDraftVersions)
      .where(
        and(
          eq(chatDraftVersions.chatId, chatId),
          eq(chatDraftVersions.appId, appId)
        )
      )
      .orderBy(desc(chatDraftVersions.number))
      .all()
      .map(toVersion);
  }

  /**
   * Version `number` of the chat's draft of `appId`, with what it holds:
   * `app.version_not_found` when there is none.
   */
  read(
    chatId: ChatId,
    appId: string,
    number: unknown
  ): { version: ChatDraftVersion; draft: Draft } {
    const row =
      typeof number === "number" && Number.isSafeInteger(number)
        ? this.#db
            .select()
            .from(chatDraftVersions)
            .where(
              and(
                eq(chatDraftVersions.chatId, chatId),
                eq(chatDraftVersions.appId, appId),
                eq(chatDraftVersions.number, number)
              )
            )
            .get()
        : undefined;
    if (row === undefined) {
      throw appErrors.create("app.version_not_found");
    }
    const files = this.#db
      .select({
        path: chatDraftVersionFiles.path,
        content: chatDraftContents.content,
      })
      .from(chatDraftVersionFiles)
      .leftJoin(
        chatDraftContents,
        and(
          eq(chatDraftContents.chatId, chatDraftVersionFiles.chatId),
          eq(chatDraftContents.appId, chatDraftVersionFiles.appId),
          eq(chatDraftContents.sha256, chatDraftVersionFiles.sha256)
        )
      )
      .where(
        and(
          eq(chatDraftVersionFiles.chatId, chatId),
          eq(chatDraftVersionFiles.appId, appId),
          eq(chatDraftVersionFiles.number, row.number)
        )
      )
      .all();
    return {
      version: toVersion(row),
      draft: {
        base: row.base,
        changes: Object.fromEntries(
          files.map(({ path, content }) => [path, content])
        ),
        revision: row.revision,
      },
    };
  }

  /** Deletes every draft version of the chat, and what they hold. */
  deleteChat(chatId: ChatId): void {
    this.#db
      .delete(chatDraftVersionFiles)
      .where(eq(chatDraftVersionFiles.chatId, chatId))
      .run();
    this.#db
      .delete(chatDraftContents)
      .where(eq(chatDraftContents.chatId, chatId))
      .run();
    this.#db
      .delete(chatDraftVersions)
      .where(eq(chatDraftVersions.chatId, chatId))
      .run();
  }

  /** The number of the chat's latest version of `appId`'s draft; 0 for none. */
  #latest(chatId: ChatId, appId: string): number {
    return (
      this.#db
        .select({ latest: max(chatDraftVersions.number) })
        .from(chatDraftVersions)
        .where(
          and(
            eq(chatDraftVersions.chatId, chatId),
            eq(chatDraftVersions.appId, appId)
          )
        )
        .get()?.latest ?? 0
    );
  }
}
