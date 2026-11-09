import { functionRequestMaxBytes } from "@grasp-os/shared/function-limits";
import { canonicalJson } from "@grasp-os/shared/json";

import type { AccessFence } from "./access-fence.ts";
import { clientError } from "./client-error.ts";
import { inputOf, readOptions, submitOptionKeys } from "./client-request.ts";
import type { ReadReference } from "./client-request.ts";
import { waitAfter, waitFor } from "./client-retry.ts";
import { freshKey, sleep } from "./client-shared.ts";
import { settlesSubmission } from "./refusals.ts";
import {
  showsStale,
  submissionVerdict,
  uncertainScope,
} from "./submission-verdict.ts";

/** A submission in flight, by its scoped key. */
interface Submission {
  readonly input: string;
  readonly done: Promise<unknown>;
}

/**
 * The client's mutations and actions: one logical submission per explicit
 * call, sent again under its key until the host settles it.
 */
export class Submissions {
  readonly #fence: AccessFence;
  /** Marks every query old after a change the host may have made. */
  readonly #changed: () => void;
  readonly #submissions = new Map<string, Submission>();
  /**
   * The keys of submissions whose outcome was left unknown, scoped by App
   * and operation as the host scopes them (`uncertainScope`), by the
   * generation they were sent under: one is sent again only within it,
   * never for someone who signed in since, as the host scopes keys by
   * person. Another operation under the same key never clears it.
   */
  readonly #uncertainKeys = new Map<string, number>();

  constructor(fence: AccessFence, changed: () => void) {
    this.#fence = fence;
    this.#changed = changed;
  }

  /** Forgets every submission in flight: none is joined after a fence. */
  clear(): void {
    this.#submissions.clear();
  }

  /** Sends one submission (see the header), and waits as its caller asked. */
  async submit(
    reference: ReadReference,
    args: unknown,
    options: unknown
  ): Promise<unknown> {
    const { signal, idempotencyKey } = readOptions(options, submitOptionKeys);
    const input = inputOf(args);
    // A key an unknown outcome was left under is the person's it was sent
    // for: sent again for someone who signed in since, the host would take
    // it as theirs, and commit the first person's change as them.
    const sentUnder =
      idempotencyKey === undefined
        ? undefined
        : this.#uncertainKeys.get(uncertainScope(reference, idempotencyKey));
    if (sentUnder !== undefined && sentUnder !== this.#fence.generation) {
      throw clientError("auth.principal_changed");
    }
    const key = idempotencyKey ?? freshKey();
    const request = JSON.stringify({
      reference,
      input,
      idempotencyKey: key,
    });
    if (
      new TextEncoder().encode(request).byteLength > functionRequestMaxBytes
    ) {
      throw clientError("contract.input_too_large", {
        maxBytes: functionRequestMaxBytes,
      });
    }
    if (signal?.aborted === true) {
      throw clientError("submission.cancelled", { sent: false });
    }
    // Joined only by a call for the same person, as the host scopes keys:
    // within one generation, which a fence ends (it also drops the joins).
    const scoped = canonicalJson([
      this.#fence.generation,
      reference.name,
      reference.kind,
      key,
    ]);
    const inputText = canonicalJson(input);
    const joined = this.#submissions.get(scoped);
    // The same key and input while the first is in flight: the same
    // submission. Other input under the key is the host's to refuse.
    const done =
      joined?.input === inputText
        ? joined.done
        : this.#send(reference, request, key, {
            scoped,
            input: inputText,
          });
    return await waitFor(done, signal, () =>
      clientError("submission.cancelled", { sent: true })
    );
  }

  /**
   * Sends `request` until the host settles it: a lost response under the
   * same key until the host answers from its receipt, a refusal that ran
   * nothing a few times. Kept among the submissions in flight until it
   * settles.
   */
  async #send(
    reference: ReadReference,
    request: string,
    key: string,
    held: {
      readonly scoped: string;
      readonly input: string;
    }
  ): Promise<unknown> {
    const isAction = reference.kind === "action";
    // Bound to the fence it was called under: never sent again for whoever
    // has access after it.
    const { generation } = this.#fence;
    const run = async (): Promise<unknown> => {
      const started = Date.now();
      let lostSince: number | undefined;
      for (let tries = 1; ; tries += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one attempt after another
        const settled = await this.#fence.call(request, generation);
        if (showsStale(settled, isAction)) {
          this.#changed();
        }
        const now = Date.now();
        const verdict = submissionVerdict(settled, {
          isAction,
          key,
          started,
          lostSince,
          now,
        });
        if (verdict.next === "settle") {
          this.#uncertainKeys.delete(uncertainScope(reference, key));
          return verdict.value;
        }
        if (verdict.next === "fail") {
          if (verdict.error.category === "uncertain") {
            this.#uncertainKeys.set(uncertainScope(reference, key), generation);
          } else if (settlesSubmission(verdict.error)) {
            this.#uncertainKeys.delete(uncertainScope(reference, key));
          }
          throw verdict.error;
        }
        if (verdict.unknown) {
          lostSince ??= now;
        }
        // oxlint-disable-next-line no-await-in-loop -- one attempt after another
        await sleep(waitAfter(settled, tries));
      }
    };
    const done = run();
    this.#submissions.set(held.scoped, { input: held.input, done });
    try {
      return await done;
    } finally {
      if (this.#submissions.get(held.scoped)?.done === done) {
        this.#submissions.delete(held.scoped);
      }
    }
  }
}
