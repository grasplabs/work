import { agentErrors } from "@grasp-os/shared/agent";
import type { FileChanges } from "@grasp-os/shared/apps";
import { draftErrors } from "@grasp-os/shared/drafts";
import type {
  Draft,
  DraftCheck,
  DraftCheckpoint,
  DraftsApi,
  LiveVersion,
} from "@grasp-os/shared/drafts";
import { isExpectedError } from "@grasp-os/shared/errors";
import { errorFields, log } from "@grasp-os/shared/log";
import { pageErrors } from "@grasp-os/shared/pages";
import { roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import type { Subject, SubjectKind } from "@grasp-os/shared/subject";
import { z } from "zod";

import { writeAppDraft } from "./app-review.ts";
import { draftToldSchema } from "./draft-watch.ts";
import {
  draftCheckpointsOf,
  draftOf,
  draftSummary,
  emptyDraft,
  filesOf,
  restoreCheckpoint,
} from "./drafts.ts";
import { draftWatch } from "./durable-objects.ts";
import { callbackFor, isStub, stillOpenWhile } from "./page-callbacks.ts";
import type { StillOpen } from "./page-callbacks.ts";
import { check as checkDraft, kinds, publish, subjectOf } from "./publish.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";
import { watchEnds } from "./socket-watchers.ts";
import { Subscription } from "./subscription.ts";
import { followObject } from "./upstream.ts";
import { writeWorkflowDraft } from "./workflow-editor.ts";

// A signed-in person's `drafts` (GRA-1665): each App's and workflow's one
// draft (drafts.ts), which every builder of it and their chats' agents
// share. Only a builder of the subject reads, follows or changes it,
// checked at every call; each write lands only over the revision the
// person read (`draft.conflict` once another write landed), and is
// audited as theirs. Every write tells the draft's object
// (draft-watch.ts), which tells every page that follows it (`watch`).
// Publishing it is publish.ts's.

/**
 * Most drafts one connection follows at once, as a connection follows at
 * most so many chats (chats-rpc.ts).
 */
const maxWatches = 10;

/**
 * The most tellings a slow page's follow holds for it, as JSON: a few
 * hundred, each a few dozen characters. Past it the follow catches up.
 */
const maxQueuedTellings = 16 * 1024;

/** How a push to a page that follows a draft is refused. */
const refusals = {
  invalid: () => agentErrors.create("agent.invalid_request"),
  closed: () => roleErrors.create("role.forbidden"),
};

/** A draft revision as the page sends it: a count of writes. */
const revisionSchema = z.int().min(0);

/** A checkpoint's number as the page sends it, to list those before it. */
const checkpointSchema = z.int().min(1);

/**
 * How each kind writes a person's file changes into its draft, over the
 * revision they read: the subject's ID. An App's definition changes only
 * through `apps.define`.
 */
const writers: Readonly<
  Record<
    SubjectKind,
    (
      env: Env,
      by: Identity,
      subject: unknown,
      revision: number,
      changes: unknown
    ) => Promise<string>
  >
> = { app: writeAppDraft, workflow: writeWorkflowDraft };

export class DraftsRpc extends CoreRpcTarget implements DraftsApi {
  readonly #env: Env;
  readonly #check: SessionCheck;
  /** This connection's follows of drafts, each until it's released. */
  readonly #watches = new Set<Disposable>();
  /**
   * Whether this connection may still follow drafts, before each push:
   * its session holds, as the connection's own check last read it.
   */
  readonly #stillOpen: StillOpen;

  /** `closed`: aborted once the connection closes, which lets go of every follow of it. */
  constructor(env: Env, check: SessionCheck, closed: AbortSignal) {
    super();
    this.#env = env;
    this.#check = check;
    this.#stillOpen = stillOpenWhile(check);
    closed.addEventListener("abort", () => {
      for (const watch of this.#watches) {
        watch[Symbol.dispose]();
      }
    });
  }

  /** Whether `by` builds `subject` now. */
  async #buildsNow(by: Identity, { kind, id }: Subject): Promise<boolean> {
    try {
      await kinds[kind].readable(this.#env, by, id);
      return true;
    } catch (error) {
      if (isExpectedError(error)) {
        return false;
      }
      throw error;
    }
  }

  async get(subject: Subject): Promise<Draft> {
    return await withPerson(this.#check, async (by) => {
      const { kind, id } = subjectOf(subject);
      const draft = kinds[kind];
      return await draftSummary(
        this.#env,
        draft,
        await draft.readable(this.#env, by, id)
      );
    });
  }

  /**
   * Every file of the draft, read as its writers read them (`draftOf`),
   * so a code view shows what a preview or a publish takes.
   */
  async files(subject: Subject): Promise<Record<string, string>> {
    return await withPerson(this.#check, async (by) => {
      const { kind, id } = subjectOf(subject);
      const draftKind = kinds[kind];
      const found = await draftKind.readable(this.#env, by, id);
      const draft = await draftOf(this.#env, draftKind, found);
      return Object.fromEntries(
        await filesOf(this.#env, draftKind, found, draft)
      );
    });
  }

  async checkpoints(
    subject: Subject,
    before?: number
  ): Promise<DraftCheckpoint[]> {
    return await withPerson(this.#check, async (by) => {
      const { kind, id } = subjectOf(subject);
      const found = await kinds[kind].readable(this.#env, by, id);
      return await draftCheckpointsOf(
        this.#env,
        { kind, id: found },
        before === undefined
          ? undefined
          : draftErrors.parse("draft.invalid", checkpointSchema, before)
      );
    });
  }

  /**
   * Writes `changes` into the draft over `revision`, the one the person
   * read, as their own checkpoint (`writers`): only while they may write
   * it. Every page that follows the draft takes it.
   */
  async write(
    subject: Subject,
    revision: number,
    changes: FileChanges
  ): Promise<Draft> {
    return await withPerson(this.#check, async (by) => {
      const { kind, id } = subjectOf(subject);
      const written = await writers[kind](
        this.#env,
        by,
        id,
        draftErrors.parse("draft.invalid", revisionSchema, revision),
        changes
      );
      return await draftSummary(this.#env, kinds[kind], written);
    });
  }

  /**
   * Makes checkpoint `checkpoint` the draft again, as a new checkpoint,
   * over the `revision` the person read: only while they may write it.
   * Every page that follows the draft takes it.
   */
  async restore(
    subject: Subject,
    checkpoint: number,
    revision: number
  ): Promise<DraftCheckpoint> {
    return await withPerson(this.#check, async (by) => {
      const { kind, id } = subjectOf(subject);
      const draft = kinds[kind];
      const found = await draft.editable(this.#env, by, id);
      return await restoreCheckpoint(
        this.#env,
        draft,
        found,
        by,
        checkpoint,
        draftErrors.parse("draft.invalid", revisionSchema, revision)
      );
    });
  }

  /**
   * Discards the draft's changes, over the `revision` the person read:
   * the draft is over the live version again, and its checkpoints stay,
   * to restore one. Only while they may write it.
   */
  async discard(subject: Subject, revision: number): Promise<void> {
    await withPerson(this.#check, async (by) => {
      const { kind, id } = subjectOf(subject);
      const draft = kinds[kind];
      const found = await draft.editable(this.#env, by, id);
      await emptyDraft(this.#env, draft, found, {
        revision: draftErrors.parse("draft.invalid", revisionSchema, revision),
        base: await draft.liveBase(this.#env, found),
        by,
      });
    });
  }

  /**
   * Follows the draft for one page: `onRevision` hears its revision
   * after each write, whoever made it (draft-watch.ts), over a socket to
   * the draft's object that hibernates with it (upstream.ts). Only while
   * the person builds the subject, checked before each push reaches the
   * page; counts as one of the connection's watches.
   */
  async watch(
    subject: Subject,
    onRevision: (revision: number) => void
  ): Promise<Subscription> {
    return await withPerson(this.#check, async (by) => {
      const { kind, id } = subjectOf(subject);
      const found = {
        kind,
        id: await kinds[kind].readable(this.#env, by, id),
      };
      if (!isStub(onRevision)) {
        throw pageErrors.create("page.invalid");
      }
      if (this.#watches.size >= maxWatches) {
        throw agentErrors.create("agent.too_many_watches");
      }
      const stillBuilds = async (): Promise<boolean> =>
        (await this.#stillOpen()) && (await this.#buildsNow(by, found));
      let following: Disposable | undefined;
      const page = callbackFor(onRevision, stillBuilds, refusals, () => {
        this.#watches.delete(page);
        following?.[Symbol.dispose]();
      });
      this.#watches.add(page);
      /** Why core let go of it by itself, once it did. */
      const ended: { by: "displaced" | null } = { by: null };
      try {
        following = await this.#follow(by, found, page, ended);
      } catch (error) {
        page[Symbol.dispose]();
        throw error;
      }
      // Let go of while it opened: what it opened goes with it.
      if (!this.#watches.has(page)) {
        following[Symbol.dispose]();
      }
      return new Subscription(
        async () => {
          page[Symbol.dispose]();
          await Promise.resolve();
        },
        () => ended.by
      );
    });
  }

  /**
   * Has `page` hear `found`'s draft for `by`: over a socket to the draft's
   * object (draft-watch.ts), or, while that object still runs the code of
   * the release before (no socket), the old way, its callback kept there.
   * Answers what stops it.
   */
  async #follow(
    by: Identity,
    found: Subject,
    page: ((revision: unknown) => Promise<void>) & Disposable,
    /** Told why core let go of the follow by itself (`Subscription.endedBy`). */
    ended: { by: "displaced" | null }
  ): Promise<Disposable> {
    const object = draftWatch(this.#env, found);
    /** The last telling the page took (draft-watch.ts): where a socket opened again starts. */
    let after = 0;
    try {
      return await followObject({
        open: async () =>
          await object.fetch(
            `https://draft-watch/?${new URLSearchParams({ person: by.userId, after: String(after) }).toString()}`,
            { headers: { Upgrade: "websocket" } }
          ),
        parse: (frame) => draftToldSchema.parse(frame),
        deliver: async (told) => {
          await page(told.revision);
          after = told.seq;
        },
        maxQueued: maxQueuedTellings,
        ended: (code) => {
          // The page's callback ends with it, which the page hears, and
          // follows again (follow-chat.ts `follow`): only on its next look
          // when it was displaced.
          ended.by = code === watchEnds.displaced ? "displaced" : null;
          page[Symbol.dispose]();
        },
        logged: { ...found },
      });
    } catch (error) {
      log.warn("draft.socket_unopened", { ...found, ...errorFields(error) });
    }
    // The object's code is the release's before: the old way, until the
    // release after removes it.
    const watchId = await object.watch(by.userId, page);
    return {
      [Symbol.dispose]: () => {
        void (async () => {
          try {
            await object.unwatch(watchId);
          } catch (error) {
            log.warn("draft.unwatch_failed", {
              ...found,
              ...errorFields(error),
            });
          }
        })();
      },
    };
  }

  /** The draft checked as publishing checks it (publish.ts, `check`). */
  async check(subject: Subject): Promise<DraftCheck> {
    return await withPerson(this.#check, async (by) => {
      const { kind, id } = subjectOf(subject);
      return await checkDraft(this.#env, kinds[kind], by, id);
    });
  }

  /**
   * Publishes the draft at `revision` (publish.ts), by the person
   * themselves: only while they may write it.
   */
  async publish(subject: Subject, revision: number): Promise<LiveVersion> {
    return await withPerson(this.#check, async (by) => {
      const { kind, id } = subjectOf(subject);
      return await publish(
        this.#env,
        kinds[kind],
        by,
        id,
        draftErrors.parse("draft.invalid", revisionSchema, revision)
      );
    });
  }
}
