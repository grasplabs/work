import { appIdSchema } from "@grasp-os/shared/ids";
import type { ChatId } from "@grasp-os/shared/ids";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { z } from "zod";

import { chatBuildJobs } from "./db/workspace/schema.ts";

// What a chat's Workspace object keeps of its build jobs (build-jobs.ts):
// a row each, in the object's own SQLite, so a job's lease outlives a
// restart of the object, unlike a code run's. Only the Workspace object
// calls these, inside its own methods: none awaits, so each runs as one
// step of the object, and a check and the write after it can't be
// interleaved with another call.

/** Most build jobs a chat may have running at once. */
export const maxRunningJobs = 3;

/**
 * Most build job records a chat keeps, newest first: what its agent may
 * still read with `env.build.job`. Each holds at most one bounded check or
 * proposal, so this bounds what jobs keep in the chat's object.
 */
export const jobRecordsKept = 100;

/** A build job's row. */
export type BuildJobRow = typeof chatBuildJobs.$inferSelect;

/** How a build job ended, as its last step records it. */
export type BuildJobEnd =
  | { status: "completed"; result: string }
  | { status: "failed"; error: string }
  | { status: "cancelled" | "revoked" };

/**
 * Whether a build job may have a step or a write admitted now: `open`,
 * with when the authority it acts on was granted (a revocation since ends
 * it), or why not.
 */
export type BuildJobAdmission =
  | { call: "open"; grantedAt: number }
  | { call: "cancelled" | "revoked" };

/** What a new build job is bound to, as the object opens it. */
export interface BuildJobOpening {
  id: string;
  chatId: ChatId;
  turnId: string;
  runId: string;
  appId: string;
  kind: BuildJobRow["kind"];
  message: string | null;
  revision: number;
  grantedAt: number;
}

/** A chat's build jobs, in its Workspace object's storage. */
export class BuildJobRecords {
  readonly #db: DrizzleSqliteDODatabase;

  constructor(db: DrizzleSqliteDODatabase) {
    this.#db = db;
  }

  /** Whether the chat has as many jobs running as it may. */
  full(chatId: ChatId): boolean {
    return this.running(chatId).length >= maxRunningJobs;
  }

  /** The chat's running jobs, with when each was submitted. */
  running(chatId: ChatId): { id: string; createdAt: Date }[] {
    return this.#db
      .select({ id: chatBuildJobs.id, createdAt: chatBuildJobs.createdAt })
      .from(chatBuildJobs)
      .where(
        and(
          eq(chatBuildJobs.chatId, chatId),
          eq(chatBuildJobs.status, "running")
        )
      )
      .all();
  }

  /**
   * Records a new job as running, and forgets the chat's oldest ended jobs
   * past {@link jobRecordsKept}, newest by when they were submitted, then
   * by the order they were recorded in: a running job is never forgotten.
   */
  open(opening: BuildJobOpening): void {
    this.#db
      .insert(chatBuildJobs)
      .values({
        ...opening,
        grantedAt: new Date(opening.grantedAt),
        status: "running",
        createdAt: new Date(),
      })
      .run();
    this.#db
      .delete(chatBuildJobs)
      .where(
        and(
          eq(chatBuildJobs.chatId, opening.chatId),
          ne(chatBuildJobs.status, "running"),
          sql`${chatBuildJobs.id} NOT IN (SELECT ${chatBuildJobs.id} FROM ${chatBuildJobs} WHERE ${chatBuildJobs.chatId} = ${opening.chatId} ORDER BY ${chatBuildJobs.createdAt} DESC, rowid DESC LIMIT ${jobRecordsKept})`
        )
      )
      .run();
  }

  /** The chat's job `id`; none for another chat's. */
  byId(chatId: ChatId, id: string): BuildJobRow | undefined {
    return this.#db
      .select()
      .from(chatBuildJobs)
      .where(and(eq(chatBuildJobs.id, id), eq(chatBuildJobs.chatId, chatId)))
      .get();
  }

  /** Whether the chat's job `id` may act now; a job it lacks is cancelled. */
  admission(chatId: ChatId, id: string): BuildJobAdmission {
    const job = this.byId(chatId, id);
    if (job?.status === "running") {
      return { call: "open", grantedAt: job.grantedAt.getTime() };
    }
    return { call: job?.status === "revoked" ? "revoked" : "cancelled" };
  }

  /**
   * Ends the chat's running job `id` as `end` says: `false` when it had
   * ended already, so a job ends once, however often its last step runs.
   */
  end(chatId: ChatId, id: string, end: BuildJobEnd): boolean {
    const ended = this.#db
      .update(chatBuildJobs)
      .set({
        status: end.status,
        result: end.status === "completed" ? end.result : null,
        error: end.status === "failed" ? end.error : null,
        endedAt: new Date(),
      })
      .where(
        and(
          eq(chatBuildJobs.id, id),
          eq(chatBuildJobs.chatId, chatId),
          eq(chatBuildJobs.status, "running")
        )
      )
      .returning({ id: chatBuildJobs.id })
      .all();
    return ended.length > 0;
  }

  /**
   * Cancels the chat's running jobs, or only those of the turn `turnId`:
   * the IDs of those it cancelled.
   */
  cancelRunning(chatId: ChatId, turnId?: string): string[] {
    return this.#db
      .update(chatBuildJobs)
      .set({ status: "cancelled", endedAt: new Date() })
      .where(
        and(
          eq(chatBuildJobs.chatId, chatId),
          eq(chatBuildJobs.status, "running"),
          turnId === undefined ? undefined : eq(chatBuildJobs.turnId, turnId)
        )
      )
      .returning({ id: chatBuildJobs.id })
      .all()
      .map(({ id }) => id);
  }

  /**
   * Records the tree the running job `id` is about to commit over
   * `parent`, before it commits: what a commit run again reconciles with.
   * `false` when the job has ended.
   */
  intend(chatId: ChatId, id: string, parent: number | null, tree: string) {
    const intended = this.#db
      .update(chatBuildJobs)
      .set({ intendedParent: parent, intendedTree: tree })
      .where(
        and(
          eq(chatBuildJobs.id, id),
          eq(chatBuildJobs.chatId, chatId),
          eq(chatBuildJobs.status, "running")
        )
      )
      .returning({ id: chatBuildJobs.id })
      .all();
    return intended.length > 0;
  }

  /**
   * Records the version the job `id` committed, its receipt: once, and
   * whether or not it is still running, as what it committed stays.
   */
  receipt(chatId: ChatId, id: string, version: number): void {
    this.#db
      .update(chatBuildJobs)
      .set({ version })
      .where(
        and(
          eq(chatBuildJobs.id, id),
          eq(chatBuildJobs.chatId, chatId),
          isNull(chatBuildJobs.version)
        )
      )
      .run();
  }

  /** Deletes the chat's jobs, with the chat. */
  deleteChat(chatId: ChatId): void {
    this.#db
      .delete(chatBuildJobs)
      .where(eq(chatBuildJobs.chatId, chatId))
      .run();
  }
}

/** A build job as the chat's code reads it (`env.build.job`). */
export interface BuildJobView {
  id: string;
  kind: "check" | "propose";
  app: string;
  /** The draft's revision it was submitted for. */
  revision: number;
  status: "running" | "completed" | "failed" | "cancelled" | "revoked";
  /** What it came to, once completed: a check, or a proposal. */
  result: unknown;
  /** The version it proposed, its receipt, whatever happened after. */
  version: number | null;
  /** Why it failed. */
  error: { code: string; message: string } | null;
}

const storedErrorSchema = z.object({ code: z.string(), message: z.string() });

/** A job's record as its chat's code reads it. */
export const jobView = (job: BuildJobRow): BuildJobView => {
  // Core wrote both as JSON (`end`): the result is a check or a proposal.
  const result: unknown = job.result === null ? null : JSON.parse(job.result);
  const error: unknown = job.error === null ? null : JSON.parse(job.error);
  return {
    id: job.id,
    kind: job.kind,
    app: appIdSchema.parse(job.appId),
    revision: job.revision,
    status: job.status,
    result,
    version: job.version,
    error: error === null ? null : storedErrorSchema.parse(error),
  };
};
