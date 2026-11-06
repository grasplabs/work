import { createHash } from "node:crypto";

import { appErrors } from "@grasp-os/shared/apps";
import type { ChatDraftVersion } from "@grasp-os/shared/chat";
import type { ChatId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import { and, desc, eq } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import {
  chatDraftContents,
  chatDraftVersionFiles,
  chatDraftVersions,
} from "./db/workspace/schema.ts";
import type { Draft } from "./workspace.ts";

// A chat's draft of an App, kept as a version per agent turn that wrote
// it (`chat_draft_versions`), where the draft itself holds only the
// latest: the person's undo point per message. They see how the draft
// got where it is, preview an earlier version and restore it, which makes
// a new version rather than rewriting any. The preview follows every
// write (sealed-previews.ts); a version, the draft as its turn left it.
//
// Each write of a turn keeps its version again, in the write's own
// transaction, from the draft as that write left it: no write lands
// without its turn's version holding it, and none is kept for a write
// that didn't land. A turn cut short keeps what it wrote, then, as one
// version: the draft keeps those writes, and its every state the person
// saw stays one they can restore. Nothing has to notice a turn's end,
// which a restart may skip. A turn's writes amend its version only while
// it is the newest: after a restore, the turn's next write is a version
// of its own, numbered after it. Numbered in the order they landed.
// Hashed synchronously (node:crypto, which workerd has), as the Workspace
// object's transactions are. Only the Workspace object calls these.
// Versions are the chat's, as its draft is: deleted with the chat.

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

/**
 * Who wrote a version: the agent's turn (none when its run kept no
 * record), in its code step `callId`, or the person restoring one.
 */
export type VersionAuthor =
  | { turnId: string | null; callId: string | null }
  | { restoredFrom: number };

/** A chat's draft versions, in its Workspace object's SQLite. */
export class DraftVersions {
  readonly #db: DrizzleSqliteDODatabase;

  constructor(db: DrizzleSqliteDODatabase) {
    this.#db = db;
  }

  /**
   * Keeps `draft`, the chat's draft of `appId` as a write just left it:
   * as the version of the turn that wrote it, while that is the newest,
   * else as the next version. Called inside the transaction of the write.
   */
  keep(
    chatId: ChatId,
    appId: string,
    draft: Draft,
    by: VersionAuthor,
    createdAt: Date
  ): ChatDraftVersion {
    const latest = this.#latest(chatId, appId);
    const turnId = "turnId" in by ? by.turnId : null;
    const amends =
      latest !== undefined && turnId !== null && latest.turnId === turnId;
    const number = amends ? latest.number : (latest?.number ?? 0) + 1;
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
      turnId,
      callId: "callId" in by ? by.callId : null,
      restoredFrom: "restoredFrom" in by ? by.restoredFrom : null,
      createdAt,
    };
    const replaced = amends ? this.#replace(row) : [];
    if (!amends) {
      this.#db.insert(chatDraftVersions).values(row).run();
    }
    for (const [path, hash] of Object.entries(hashes)) {
      this.#db
        .insert(chatDraftVersionFiles)
        .values({ chatId, appId, number, path, sha256: hash })
        .run();
    }
    this.#dropUnheld(chatId, appId, replaced);
    return toVersion(row);
  }

  /**
   * Rewrites version `row.number` as `row`, its files gone for the caller
   * to write again: the content hashes they held, to drop those no
   * version holds any more (`#dropUnheld`).
   */
  #replace(row: typeof chatDraftVersions.$inferSelect): string[] {
    const { chatId, appId, number } = row;
    const ofVersion = and(
      eq(chatDraftVersionFiles.chatId, chatId),
      eq(chatDraftVersionFiles.appId, appId),
      eq(chatDraftVersionFiles.number, number)
    );
    const held = this.#db
      .delete(chatDraftVersionFiles)
      .where(ofVersion)
      .returning({ sha256: chatDraftVersionFiles.sha256 })
      .all()
      .flatMap(({ sha256: hash }) => (hash === null ? [] : [hash]));
    this.#db
      .update(chatDraftVersions)
      .set(row)
      .where(
        and(
          eq(chatDraftVersions.chatId, chatId),
          eq(chatDraftVersions.appId, appId),
          eq(chatDraftVersions.number, number)
        )
      )
      .run();
    return held;
  }

  /**
   * Drops the contents of `hashes` no version of the chat's draft of
   * `appId` holds: what a turn wrote and then wrote over is no undo point.
   */
  #dropUnheld(chatId: ChatId, appId: string, hashes: readonly string[]): void {
    for (const hash of new Set(hashes)) {
      const held = this.#db
        .select({ number: chatDraftVersionFiles.number })
        .from(chatDraftVersionFiles)
        .where(
          and(
            eq(chatDraftVersionFiles.chatId, chatId),
            eq(chatDraftVersionFiles.appId, appId),
            eq(chatDraftVersionFiles.sha256, hash)
          )
        )
        .limit(1)
        .get();
      if (held === undefined) {
        this.#db
          .delete(chatDraftContents)
          .where(
            and(
              eq(chatDraftContents.chatId, chatId),
              eq(chatDraftContents.appId, appId),
              eq(chatDraftContents.sha256, hash)
            )
          )
          .run();
      }
    }
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

  /** The chat's latest version of `appId`'s draft: its number and turn. */
  #latest(
    chatId: ChatId,
    appId: string
  ): { number: number; turnId: string | null } | undefined {
    return this.#db
      .select({
        number: chatDraftVersions.number,
        turnId: chatDraftVersions.turnId,
      })
      .from(chatDraftVersions)
      .where(
        and(
          eq(chatDraftVersions.chatId, chatId),
          eq(chatDraftVersions.appId, appId)
        )
      )
      .orderBy(desc(chatDraftVersions.number))
      .limit(1)
      .get();
  }
}
