import { subjectSchema } from "@grasp-os/shared/subject";
import type { Subject } from "@grasp-os/shared/subject";
import { DurableObject } from "cloudflare:workers";

import { readDraft } from "./drafts.ts";

// Who follows one App's or workflow's draft (drafts.ts, drafts-rpc.ts):
// one object per subject, named `kind:id`, holding the pages that follow
// it in memory. Every write tells it (`revised`), which tells each, so
// every open page of the subject takes the write at once, whoever made
// it. Core checks the caller builds the subject before it follows, and
// again before each push (drafts-rpc.ts). A restart loses the followers,
// whose pages read the draft afresh at their next call and follow again.

/**
 * Most pages of one person's that follow one draft at once: a page past
 * it takes the place of their oldest, so nobody fills it for the others.
 */
const watchersPerPerson = 20;

/** Where a page that follows a draft hears of its writes: its revision. */
export type DraftListener = Rpc.Stub<(revision: number) => Promise<void>>;

/** The name of `subject`'s object. */
export const draftWatchName = ({ kind, id }: Subject): string =>
  `${kind}:${id}`;

export class DraftWatch extends DurableObject<Env> {
  /** The pages that follow the draft (`watch`), by ID, oldest first. */
  readonly #watchers = new Map<
    string,
    { personId: string; listener: DraftListener }
  >();

  /** The subject this object follows: the name it was made by. */
  get #subject(): Subject {
    const name = this.ctx.id.name ?? "";
    const at = name.indexOf(":");
    return subjectSchema.parse({
      kind: name.slice(0, at),
      id: name.slice(at + 1),
    });
  }

  /**
   * The draft was written (a chat's agent, a person's edit, a restore, a
   * discard, a publish or a roll back): every page that follows it hears
   * of its revision. A page that can't be reached is dropped.
   */
  async revised(): Promise<void> {
    const { revision } = await readDraft(this.env, this.#subject);
    await Promise.all(
      [...this.#watchers].map(async ([id, { listener }]) => {
        try {
          await listener(revision);
        } catch {
          this.#drop(id);
        }
      })
    );
  }

  /**
   * Follows the draft's writes for one page of `personId`'s (`revised`):
   * `listener` hears each revision. Past {@link watchersPerPerson} of
   * theirs, their oldest page stops following. Returns the ID `unwatch`
   * drops it by.
   */
  watch(personId: string, listener: DraftListener): string {
    const theirs = [...this.#watchers].filter(
      ([, watcher]) => watcher.personId === personId
    );
    const displaced = Math.max(0, theirs.length - watchersPerPerson + 1);
    for (const [id] of theirs.slice(0, displaced)) {
      this.#drop(id);
    }
    const id = crypto.randomUUID();
    this.#watchers.set(id, { personId, listener: listener.dup() });
    return id;
  }

  /** Stops telling the page `watch` answered `id` for. */
  unwatch(id: string): void {
    this.#drop(id);
  }

  #drop(id: string): void {
    this.#watchers.get(id)?.listener[Symbol.dispose]();
    this.#watchers.delete(id);
  }
}
