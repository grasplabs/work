import type {
  CapabilityDecision,
  HeldBinding,
} from "@grasp-os/shared/capability";
import { connectionIdSchema, permissionIdSchema } from "@grasp-os/shared/ids";
import {
  authoritySchema,
  permissionErrors,
} from "@grasp-os/shared/permissions";
import type { CodeSubject, WorkContext } from "@grasp-os/shared/permissions";
import type { Identity } from "@grasp-os/shared/rpc";

import { signedCall } from "./bindings.ts";
import { requireHeldBinding } from "./resource-bindings.ts";

// A person deciding a call that waits for them, from their own session:
// confirming a held action (pending-actions.ts) or resolving a call of
// unknown outcome (unknown-outcomes.ts). Either can send the call, so
// each is signed only as the call itself would be allowed now: the same
// App or agent, its approved App version, the resource binding it came
// through still serving it, and its permission and context checked again
// (`signedCall`). One path for both, so neither checks less.

/** A call waiting for its person, as connect recorded where it came from. */
export interface DecidedCall {
  subject: CodeSubject;
  mode: "interactive" | "workflow";
  /** The App version whose code made it; null for an agent's. */
  appVersion: number | null;
  context: WorkContext;
  permissionId: string;
  /** The App's approved resource binding it came through, if any. */
  binding?: HeldBinding | undefined;
  connectionId: string;
  resource: string | null;
  action: string;
  idempotencyKey: string;
}

/** Errors thrown because a call's resource binding no longer serves it. */
const bindingRefusals = new WeakSet<object>();

/**
 * Whether `error` refused a decision because the call's resource binding
 * no longer serves it (revoked, replaced, drifted), or couldn't be read
 * to say.
 */
export const refusedForBinding = (error: unknown): boolean =>
  typeof error === "object" && error !== null && bindingRefusals.has(error);

/**
 * The capability carrying `decision` on `call`, for `identity`, the person
 * it acts for: refused (`permission.denied`) for an App's call that names
 * no approved version, or once its permission, context or resource
 * binding no longer allows it, as `signedCall` and `requireHeldBinding`
 * would refuse the call itself now.
 */
export const reauthorizedCapability = async (
  env: Env,
  identity: Identity,
  call: DecidedCall,
  decision: CapabilityDecision
): Promise<string> => {
  const { subject, binding } = call;
  // An App's call names the version whose code made it, or no version was
  // approved for it: refused, as `authorize` would.
  if (subject.type === "app" && call.appVersion === null) {
    throw permissionErrors.create("permission.denied", {
      action: call.action,
    });
  }
  // A call an App made through a resource binding is decided only while
  // that binding would still serve it now, as a live request would.
  if (subject.type === "app" && binding !== undefined) {
    try {
      await requireHeldBinding(env, subject.appId, binding, call.action);
    } catch (error) {
      if (typeof error === "object" && error !== null) {
        bindingRefusals.add(error);
      }
      throw error;
    }
  }
  const authority = authoritySchema.parse({
    subject,
    onBehalfOf: identity.userId,
    mode: call.mode,
    ...(call.appVersion === null ? {} : { appVersion: call.appVersion }),
  });
  const { capability } = await signedCall(
    env,
    {
      authority,
      context: call.context,
      connection: {
        type: "connection",
        connectionId: connectionIdSchema.parse(call.connectionId),
        resource: call.resource ?? undefined,
      },
      permissionId: permissionIdSchema.parse(call.permissionId),
      ...(binding === undefined ? {} : { binding }),
    },
    { action: call.action, idempotencyKey: call.idempotencyKey },
    decision
  );
  return capability;
};
