import {
  connectErrors,
  resolutionChoiceSchema,
  unknownOutcomeKeySchema,
} from "@grasp-os/shared/connect";
import type {
  ResolutionChoice,
  UnknownOutcome,
  UnknownOutcomeKey,
  UnknownOutcomesApi,
} from "@grasp-os/shared/connect";
import { isExpectedError } from "@grasp-os/shared/errors";
import { connectionIdSchema, permissionIdSchema } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import {
  authoritySchema,
  permissionErrors,
} from "@grasp-os/shared/permissions";
import type { Identity } from "@grasp-os/shared/rpc";
import { z } from "zod";

import { signedCall } from "./bindings.ts";
import { personOf } from "./connections.ts";
import { requireHeldBinding } from "./resource-bindings.ts";
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
// resolves exactly that call, that way, for that person (`resolves`). A
// caller whose permission is gone can't have its call resolved; the
// refusal is recorded in connect. Nothing an App or agent holds reaches
// this: it is only on `/rpc`, behind the person's session.

/**
 * The capability resolving the call `found` names by `choice`, signed only
 * once its permission and context pass again, as the call itself would
 * now (`signedCall`).
 */
const resolutionCapability = async (
  env: Env,
  identity: Identity,
  { key, resource, origin }: UnknownOutcome,
  resolves: { choice: ResolutionChoice; claimedAt: number }
): Promise<string> => {
  // Where it came from isn't known, or an App's call names no version:
  // its permission can't be checked, so it can't be resolved.
  if (
    origin === null ||
    (key.subject.type === "app" && origin.appVersion === null)
  ) {
    throw permissionErrors.create("permission.denied", { action: key.action });
  }
  // A call an App made through a resource binding is resolved only while
  // that binding would still serve it, as a held call is confirmed.
  if (key.subject.type === "app" && origin.binding !== undefined) {
    await requireHeldBinding(
      env,
      key.subject.appId,
      origin.binding,
      key.action
    );
  }
  const authority = authoritySchema.parse({
    subject: key.subject,
    onBehalfOf: identity.userId,
    mode: origin.mode,
    ...(origin.appVersion === null ? {} : { appVersion: origin.appVersion }),
  });
  const { capability } = await signedCall(
    env,
    {
      authority,
      context: origin.context,
      connection: {
        type: "connection",
        connectionId: connectionIdSchema.parse(key.connectionId),
        resource: resource ?? undefined,
      },
      permissionId: permissionIdSchema.parse(origin.permissionId),
      ...(origin.binding === undefined ? {} : { binding: origin.binding }),
    },
    { action: key.action, idempotencyKey: key.idempotencyKey },
    undefined,
    resolves
  );
  return capability;
};

/**
 * Says what became of the call of unknown outcome `key` names, for the
 * signed-in person it acted for: `happened` or `not_happened`. Refused
 * once the call's permission is gone, its App's version unknown, or the
 * person has left; and by connect for anyone the call didn't act for,
 * Grasp staff included, which it records.
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
    // Connect refuses it, and records who tried: nothing is resolved.
    await env.CONNECT.resolveOutcome({
      ...request,
      claim: parsedClaim.data,
      capability: null,
    });
    return;
  }
  let capability: string;
  try {
    capability = await resolutionCapability(
      env,
      identity,
      found,
      // The claim the person was shown, signed: connect resolves only
      // that send, never one made again since and lost again.
      { choice: parsedChoice.data, claimedAt: parsedClaim.data }
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
      await env.CONNECT.resolveOutcome({
        ...request,
        claim: parsedClaim.data,
        capability,
      });
    },
    async () =>
      (await env.CONNECT.unknownOutcome({ person, key: found.key })) !== null
  );
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

  async list(): Promise<UnknownOutcome[]> {
    return await withPerson(this.#check, async (person) => {
      if (person.staff) {
        return [];
      }
      return await this.#env.CONNECT.listUnknownOutcomes(
        await personOf(this.#env, person)
      );
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
