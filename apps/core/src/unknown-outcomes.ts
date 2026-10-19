import { actorOf } from "@grasp-os/shared/audit";
import {
  connectErrors,
  resolutionChoiceSchema,
  unknownOutcomeCursorSchema,
  unknownOutcomeKeySchema,
} from "@grasp-os/shared/connect";
import type {
  ResolutionChoice,
  UnknownOutcome,
  UnknownOutcomeCursor,
  UnknownOutcomeKey,
  UnknownOutcomeListing,
  UnknownOutcomesApi,
} from "@grasp-os/shared/connect";
import { isExpectedError } from "@grasp-os/shared/errors";
import { errorFields, log } from "@grasp-os/shared/log";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { isMemberAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { z } from "zod";

import { appendAuditEvent } from "./audit-outbox.ts";
import { personOf } from "./connections.ts";
import { reauthorizedCapability } from "./decided-calls.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";
import { wakingHeld } from "./workflows/wakes.ts";

// Calls of unknown outcome (spec 14.3), as core shows them to the person
// each acted for and lets them say what became of it. Connect keeps them;
// core names the person from their session, read fresh on every call. A
// resolution can let a call go out once more, so core treats it as it
// treats confirming a held action: it checks the call's permission and
// context again, as for the call itself, and signs a capability that
// resolves exactly that call, that way, for that person (`decision`). A
// caller whose permission is gone can't have its call resolved; the
// refusal is recorded in connect. Nothing an App or agent holds reaches
// this: it is only on `/rpc`, behind the person's session. The
// organization's own admins list everyone's, read only and without what
// was sent, to follow up with each call's person; they resolve only their
// own, as anyone does.

/**
 * The capability resolving the call `found` names by `choice`, at the
 * claim the person was shown, signed only as the call itself would be
 * allowed now (`reauthorizedCapability`), and, for `not_happened`, only
 * while what it sent is still kept for its person to read.
 */
const resolutionCapability = async (
  env: Env,
  identity: Identity,
  found: UnknownOutcome,
  choice: ResolutionChoice
): Promise<string> => {
  const { key, resource, origin } = found;
  // What was sent is no longer kept (connect's retention, 30 days): the
  // person can't read what "it didn't happen" would let go out again, and
  // it still could, under the same key and input, from any caller of the
  // same scope that repeats it (a run's wait gave up long before, at its
  // 7-day deadline, but an App's screen or agent may repeat a call). The
  // key frees nothing worth having then either: anything still wanted is
  // asked for anew, under a key of its own. So only "it happened" is said.
  if (choice === "not_happened" && found.input === null) {
    throw connectErrors.create("connect.outcome_not_kept");
  }
  // Where it came from isn't known: its permission can't be checked, so
  // it can't be resolved.
  if (origin === null) {
    throw permissionErrors.create("permission.denied", { action: key.action });
  }
  return await reauthorizedCapability(
    env,
    identity,
    {
      ...origin,
      subject: key.subject,
      connectionId: key.connectionId,
      resource,
      action: key.action,
      idempotencyKey: key.idempotencyKey,
    },
    { kind: "resolve", choice, claimedAt: found.claim }
  );
};

/**
 * Says what became of the call of unknown outcome `key` names, for the
 * signed-in person it acted for: `happened` or `not_happened`. Refused
 * once the call's permission is gone, its App's version unknown, or the
 * person has left; `not_happened` once what it sent is no longer kept;
 * and by connect for anyone the call didn't act for, Grasp staff
 * included, which it records.
 */
export const resolveUnknownOutcome = async (
  env: Env,
  identity: Identity,
  key: unknown,
  choice: unknown,
  claim: unknown
): Promise<void> => {
  const parsedKey = unknownOutcomeKeySchema.safeParse(key);
  const parsedChoice = resolutionChoiceSchema.safeParse(choice);
  const parsedClaim = z.int().nonnegative().safeParse(claim);
  if (!parsedKey.success || !parsedChoice.success || !parsedClaim.success) {
    throw connectErrors.create("connect.invalid");
  }
  const person = await personOf(env, identity);
  const request = { person, key: parsedKey.data, choice: parsedChoice.data };
  // Connect finds none for staff, and only the person's own.
  const found = await env.CONNECT.unknownOutcome({
    person,
    key: parsedKey.data,
  });
  if (found === null) {
    // Connect refuses it, and records who tried: nothing is resolved,
    // whatever connect answers.
    await env.CONNECT.resolveOutcome({ ...request, capability: null });
    throw connectErrors.create("connect.outcome_not_found");
  }
  let capability: string;
  try {
    // Not the claim of its key the person was shown: sent again since,
    // and lost again, it is another call to decide on.
    if (found.claim !== parsedClaim.data) {
      throw connectErrors.create("connect.outcome_not_found");
    }
    capability = await resolutionCapability(
      env,
      identity,
      found,
      parsedChoice.data
    );
  } catch (error) {
    // Refused here: recorded as connect records its own refusals, and the
    // call stays of unknown outcome.
    await env.CONNECT.refuseResolution({
      ...request,
      reason: isExpectedError(error) ? error.code : "internal.unexpected",
    }).catch((auditError: unknown) => {
      log.error("audit.record_failed", errorFields(auditError));
    });
    throw error;
  }
  // The run's step that waits on it is woken once it is resolved, whatever
  // happened, once it no longer waits (workflows/wakes.ts).
  await wakingHeld(
    env,
    {
      appId: found.key.subject.type === "app" ? found.key.subject.appId : null,
      idempotencyKey: found.key.idempotencyKey,
    },
    async () => {
      await env.CONNECT.resolveOutcome({ ...request, capability });
    },
    async () =>
      (await env.CONNECT.unknownOutcome({ person, key: found.key })) !== null
  );
};

/** `before`, a list's cursor, as connect takes it; `connect.invalid` if not one. */
const cursorOf = (before: unknown): UnknownOutcomeCursor | undefined => {
  if (before === undefined) {
    return undefined;
  }
  const parsed = unknownOutcomeCursorSchema.safeParse(before);
  if (!parsed.success) {
    throw connectErrors.create("connect.invalid");
  }
  return parsed.data;
};

/** A signed-in person's calls of unknown outcome, over `/rpc`. */
export class UnknownOutcomesRpc
  extends CoreRpcTarget
  implements UnknownOutcomesApi
{
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async list(before?: UnknownOutcomeCursor): Promise<UnknownOutcome[]> {
    return await withPerson(this.#check, async (person) => {
      const page = cursorOf(before);
      if (person.staff) {
        return [];
      }
      return await this.#env.CONNECT.listUnknownOutcomes(
        await personOf(this.#env, person),
        page
      );
    });
  }

  /**
   * Every person's open calls of unknown outcome, for the organization's
   * own admins, to follow up with each call's person: read only, without
   * what was sent (`UnknownOutcomeListing`). Grasp staff are refused, as
   * is everyone who isn't an admin; connect checks the same again.
   */
  async listAll(
    before?: UnknownOutcomeCursor
  ): Promise<UnknownOutcomeListing[]> {
    return await withPerson(this.#check, async (person) => {
      if (!isMemberAdmin(person)) {
        throw roleErrors.create("role.forbidden");
      }
      const listed = await this.#env.CONNECT.listAllUnknownOutcomes(
        await personOf(this.#env, person),
        cursorOf(before)
      );
      // Recorded before the admin gets it, as reading the audit log is:
      // who looked at everyone's activity, and how much they saw.
      await appendAuditEvent(this.#env, {
        actor: actorOf(person),
        action: "connection.call.unknown_listed",
        detail: { count: listed.length },
      });
      return listed;
    });
  }

  async resolve(
    key: UnknownOutcomeKey,
    choice: ResolutionChoice,
    claim: number
  ): Promise<void> {
    await withPerson(this.#check, async (person) => {
      await resolveUnknownOutcome(this.#env, person, key, choice, claim);
    });
  }
}
