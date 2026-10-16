import { capabilityErrors } from "@grasp-os/shared/capability";
import type {
  CapabilityClaims,
  CapabilityDecision,
  HeldBinding,
} from "@grasp-os/shared/capability";
import type { ConnectionPerson } from "@grasp-os/shared/connect";
import { canonicalJson } from "@grasp-os/shared/json";
import type { WorkContext } from "@grasp-os/shared/permissions";

// A person's decision on a call that waits for them (confirming a held
// action, resolving a call of unknown outcome) reaches connect as a
// capability core signed once it checked the call's permission and context
// again, from that person's session (`CapabilityClaims.decision`). One
// check decides whether a capability is that decision, and one refusal
// path refuses everything else. A decision is never taken for another
// kind (a confirmation never resolves, a resolution never confirms), for
// another call, for another person, or for another origin than the one
// the call recorded; and a capability carrying one is never used to make
// a call or read a held call's outcome.

/** Where a call that waits for its person came from, as connect recorded it. */
export interface DecidedOrigin {
  mode: "interactive" | "workflow";
  appVersion: number | null;
  permissionId: string;
  context: WorkContext;
  binding?: HeldBinding | undefined;
}

/** The call a decision is about, as connect recorded it. */
export interface DecidedCall {
  subjectType: "app" | "agent";
  subjectId: string;
  onBehalfOf: string;
  /** Null when what it came from can't be read: it can't be decided. */
  origin: DecidedOrigin | null;
}

/** What a capability must be to carry the decision `decision` on `call`. */
export interface ExpectedDecision {
  decision: CapabilityDecision;
  /** Who decides: only the person the call acts for. */
  person: ConnectionPerson;
  call: DecidedCall;
}

/**
 * Whether `claims` are core's decision `expected.decision`, exactly (its
 * kind and all it names), on the call `expected.call` records, by the
 * person it acts for, for the same App or agent, mode, App version,
 * permission, context and resource binding as that call came from.
 */
const decides = (
  claims: CapabilityClaims,
  { decision, person, call }: ExpectedDecision
): boolean => {
  const { authority, origin } = claims;
  const subjectId =
    authority.subject.type === "app"
      ? authority.subject.appId
      : authority.subject.agentId;
  return (
    call.origin !== null &&
    claims.decision !== undefined &&
    canonicalJson(claims.decision) === canonicalJson(decision) &&
    !person.staff &&
    authority.onBehalfOf === person.userId &&
    authority.onBehalfOf === call.onBehalfOf &&
    authority.subject.type === call.subjectType &&
    subjectId === call.subjectId &&
    authority.mode === call.origin.mode &&
    (authority.appVersion ?? null) === call.origin.appVersion &&
    origin.permissionId === call.origin.permissionId &&
    canonicalJson(origin.context) === canonicalJson(call.origin.context) &&
    canonicalJson(origin.binding ?? null) ===
      canonicalJson(call.origin.binding ?? null)
  );
};

/**
 * Refuses `claims` (`capability.invalid`, `scope`) unless they are the
 * decision `expected` describes; without `expected`, unless they carry no
 * decision at all, as every call and read of a held call's outcome must.
 */
export const requireDecision = (
  claims: CapabilityClaims,
  expected?: ExpectedDecision
): void => {
  const allowed =
    expected === undefined
      ? claims.decision === undefined
      : decides(claims, expected);
  if (!allowed) {
    throw capabilityErrors.create("capability.invalid", { reason: "scope" });
  }
};
