import type { AuditActor } from "@grasp-os/shared/audit";
import { permissionErrors } from "@grasp-os/shared/permissions";
import type { Authority } from "@grasp-os/shared/permissions";

import type { ModelShare } from "./model-admission.ts";
import { isRestricted } from "./restricted.ts";
import type { RestrictedEnv, WorkContext } from "./restricted.ts";

// What the gateway checks every model call against before anything is
// sent (models.ts), beyond the allowlist, which always applies: that the
// call works in a context its authority can work in. A call without one,
// or with another's, is refused, so no call is made in a context that
// isn't its own, or none.
//
// Each request a call sends is then admitted by the model ledger, which
// counts what it costs and holds a run lineage to its limit of requests
// (model-spend.ts, model-ledger.ts). Nothing limits spend: clients pay
// their providers on their own keys.

/** What the gateway checks a call by. */
export interface RulesInput {
  /** `<provider>/<model>`, one the deployment allows. */
  model: string;
  /** Who or what asked. */
  trigger: AuditActor;
  /** IDs of the resources that fed the prompt. */
  provenance: readonly string[];
  /** Connections whose data may have fed the prompt. */
  connections: readonly string[];
  /**
   * Where the call works, whose restricted mode it has. The type lets it
   * be missing only for a caller that isn't type-checked: the gateway
   * refuses such a call.
   */
  work?:
    | { authority: Authority; context: WorkContext }
    /** Core's own onboarding. */
    | { onboarding: true }
    /** Core's own platform features, such as its upkeep of the Brain. */
    | {
        platform:
          | "brain_upkeep"
          | "dashboard_widgets"
          | "brain_recall"
          | "stephen_requests"
          | "provider_test"
          | "document_conversion";
      };
}

/** Why the gateway refused a call: the code, and what said so. */
export interface Refusal {
  code:
    | "model.no_provider"
    | "model.not_allowed"
    | "model.run_limit"
    | "model.queued"
    | "model.rate_limited"
    | "model.unpriced"
    | "model.answer_too_long"
    | "model.ledger_unavailable"
    | "model.quota_policy_unavailable"
    | "model.quota_policy_behind"
    | "permission.context_invalid";
  because?: string;
  /**
   * When asking again may be admitted, in seconds, as core computes it:
   * for `model.queued`, until its call asks for a share again; for
   * `model.rate_limited`, until the provider's rate may let it through.
   */
  retryAfterSeconds?: number;
  /** For `model.queued`: the share of the requests in flight it waits for. */
  waitingFor?: ModelShare;
  /**
   * For `model.queued`: whether its call holds a place in the queue. One
   * given none is told so at once, not kept asking (models.ts). Never told
   * to the caller.
   */
  placed?: boolean;
}

/**
 * Checks that a call works in a context its authority can work in: refused
 * as `permission.context_invalid` without a `work` context, or with one
 * its authority can't work in (another App's, say), or that doesn't exist.
 * Core's own onboarding and platform features always have theirs.
 */
export const judgeCall = async (
  env: RestrictedEnv,
  { work }: RulesInput
): Promise<{ ok: true } | ({ ok: false } & Refusal)> => {
  if (work === undefined) {
    return { ok: false, code: "permission.context_invalid" };
  }
  if ("onboarding" in work || "platform" in work) {
    return { ok: true };
  }
  try {
    // Reading its restricted mode checks the context is one the authority
    // can work in.
    await isRestricted(env, work.authority, work.context);
  } catch (error) {
    if (permissionErrors.codeOf(error) === "permission.context_invalid") {
      return { ok: false, code: "permission.context_invalid" };
    }
    throw error;
  }
  return { ok: true };
};
