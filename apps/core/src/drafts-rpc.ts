import { agentErrors } from "@grasp-os/shared/agent";
import { draftErrors } from "@grasp-os/shared/drafts";
import type {
  Draft,
  DraftCheckpoint,
  DraftsApi,
  LiveVersion,
} from "@grasp-os/shared/drafts";
import { isExpectedError } from "@grasp-os/shared/errors";
import { errorFields, log } from "@grasp-os/shared/log";
import { pageErrors } from "@grasp-os/shared/pages";
import { roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import type { Subject } from "@grasp-os/shared/subject";
import { z } from "zod";

import {
  draftCheckpointsOf,
  draftOf,
  draftSummary,
  emptyDraft,
  filesOf,
  restoreCheckpoint,
} from "./drafts.ts";
import { draftWatch } from "./durable-objects.ts";
import { callbackFor, isStub } from "./page-callbacks.ts";
import type { StillOpen } from "./page-callbacks.ts";
import { kinds, publish, subjectOf } from "./publish.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";
import { Subscription } from "./subscription.ts";

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

/** How a push to a page that follows a draft is refused. */
const refusals = {
  invalid: () => agentErrors.create("agent.invalid_request"),
  closed: () => roleErrors.create("role.forbidden"),
};

/** A draft revision as the page sends it: a count of writes. */
const revisionSchema = z.int().min(0);

/** A checkpoint's number as the page sends it, to list those before it. */
const checkpointSchema = z.int().min(1);

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

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
    this.#stillOpen = async () => {
      try {
        await check();
        return true;
      } catch {
        return false;
      }
    };
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
   * after each write, whoever made it (`DraftWatch.revised`). Only while
   * the person builds the subject, checked before each push; counts as
   * one of the connection's watches.
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
      const listener = callbackFor(onRevision, stillBuilds, refusals, () => {
        this.#watches.delete(listener);
      });
      this.#watches.add(listener);
      const watched = draftWatch(this.#env, found);
      let watchId: string;
      try {
        watchId = await watched.watch(listener);
      } catch (error) {
        listener[Symbol.dispose]();
        throw error;
      }
      return new Subscription(async () => {
        listener[Symbol.dispose]();
        try {
          await watched.unwatch(watchId);
        } catch (error) {
          log.warn("draft.unwatch_failed", { ...found, ...errorFields(error) });
        }
      });
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
