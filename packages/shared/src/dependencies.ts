import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";
import {
  appIdSchema,
  identifierMaxLength,
  workflowResourceIdSchema,
} from "./ids.ts";
import type { DependencyIntent, GraspLock } from "./packages.ts";
import { platformLimits } from "./platform-limits.ts";

// npm packages an App or a workflow asks for, and its builder's decision
// on them. The chat's agent (or a builder) asks core to resolve what the
// source names; core resolves one exact graph from the registry and
// proposes it as a request, which allows nothing. A builder of the App or
// workflow approves or denies it, in their own session. A package's own
// words (a licence, an advisory's title) are shown as text, never followed.

/**
 * Whose packages a request is: an App's, or an independent workflow's
 * (its compute modules). An approval is its subject's alone.
 */
export type DependencySubject =
  | { type: "app"; id: string }
  | { type: "workflow"; id: string };

/** A subject as a caller names it: `{ app }` or `{ workflow }`, exactly one. */
export const dependencySubjectRefSchema = z.union([
  z.strictObject({ app: appIdSchema }),
  z.strictObject({ workflow: workflowResourceIdSchema }),
]);
export type DependencySubjectRef = z.input<typeof dependencySubjectRefSchema>;

/** The subject a caller's `{ app }` or `{ workflow }` names. */
export const subjectOfRef = (ref: {
  app?: string;
  workflow?: string;
}): DependencySubject =>
  ref.workflow === undefined
    ? { type: "app", id: ref.app ?? "" }
    : { type: "workflow", id: ref.workflow };

/** A subject as the API shows it: what it is, and its name now. */
export interface NamedDependencySubject {
  type: DependencySubject["type"];
  id: string;
  name: string;
}

/** The one registry packages come from. No git, file or tarball sources. */
export const npmRegistryOrigin = "https://registry.npmjs.org";

/** Most packages one graph names: what one OSV.dev batch reads (spec 18.1). */
export const dependencyMaxPackages = platformLimits.dependencyPackages;

/** Most findings one request keeps, gravest first. */
export const dependencyMaxFindings = 200;

/** An npm package name, scoped or not, as the registry allows them. */
export const packageNameSchema = z
  .string()
  .max(214)
  .regex(
    /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u,
    "an npm package name"
  );

/** One exact version: never a range, a tag or a URL. */
export const exactVersionSchema = z
  .string()
  .max(128)
  .regex(
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u,
    "an exact version"
  );

/**
 * The registry's SHA-512 of a tarball, as npm writes it (Subresource
 * Integrity): which bytes, not whether they are safe.
 */
export const integritySchema = z
  .string()
  .regex(/^sha512-[A-Za-z0-9+/]{86}==$/u, "a sha512 integrity hash");

/** One package, by name and exact version. */
export interface DependencyPackageRef {
  name: string;
  version: string;
}

/** A package as one key: `name@version`. */
export const packageKey = ({ name, version }: DependencyPackageRef): string =>
  `${name}@${version}`;

/**
 * Something reported about a package, for the person who decides: named
 * like a popular package (`lookalike`), or a known vulnerability
 * (`security`, an advisory by its ID). Evidence, not proof: a graph
 * without findings isn't shown to be safe.
 */
export interface DependencyFinding {
  kind: "security" | "lookalike";
  package: DependencyPackageRef;
  severity: "info" | "low" | "moderate" | "high" | "critical";
  /** What names it elsewhere: an advisory's ID; null for a lookalike. */
  id: string | null;
  summary: string;
}

/** How grave each severity is: findings are shown, and kept, gravest first. */
export const findingGravity: Readonly<
  Record<DependencyFinding["severity"], number>
> = { critical: 4, high: 3, moderate: 2, low: 1, info: 0 };

/**
 * Where a request stands. Pending: asked, allows nothing. Approved: a
 * builder approved exactly this graph for this App or workflow. Denied:
 * a builder refused it. Revoked: core found it reported as malware after
 * it was approved; nothing of it runs or is built any more. A pending
 * request another one replaces is gone: only the audit log keeps it.
 */
export type DependencyRequestStatus =
  | "pending"
  | "approved"
  | "denied"
  | "revoked";

/** A request, as the API shows it: everything its decision needs. */
export interface DependencyRequest {
  id: string;
  subject: NamedDependencySubject;
  status: DependencyRequestStatus;
  /** Why the packages are needed, in the asker's words. */
  purpose: string;
  /** The hash of `lock`, which a decision names (`graspLockHash`). */
  graphHash: string;
  lock: GraspLock;
  /** The gravest findings, at most {@link dependencyMaxFindings}. */
  findings: DependencyFinding[];
  requestedBy: { userId: string; name: string };
  /** When (ISO 8601). */
  requestedAt: string;
  /** Who decided, when and why if they said; only once approved or denied. */
  decided?: {
    by: { userId: string; name: string };
    at: string;
    reason: string | null;
  };
  /** When core revoked it, and why; only once it did. */
  revoked?: { at: string; reason: string };
}

/** How an App's or a workflow's packages stand, for its builders. */
export interface DependencyStatus {
  /** The request waiting for a decision, if any. */
  pending: DependencyRequest | null;
  /** The approval it got last, if any. */
  approved: DependencyRequest | null;
}

/** A builder's decision, and the graph they reviewed as they made it. */
export const dependencyDecisionSchema = z.strictObject({
  approved: z.boolean(),
  graphHash: z.string().regex(/^[0-9a-f]{64}$/u),
  reason: z.string().trim().min(1).max(identifierMaxLength).optional(),
});
export type DependencyDecision = z.input<typeof dependencyDecisionSchema>;

/** Why a dependency call was refused. */
export const dependencyErrors = defineErrorFamily({
  "dependency.invalid": "That isn't a valid dependency request.",
  "dependency.not_found": "There's no such dependency request.",
  "dependency.forbidden":
    "Only a builder of the App or workflow decides its packages, in their own session.",
  "dependency.stale":
    "This request was decided or replaced since you opened it. Open it again before deciding.",
  "dependency.approval_required":
    "These packages aren't approved for this App or workflow. One of its builders decides.",
  "dependency.malware":
    "A package is known malware, so Grasp refuses it: no approval can admit it. Remove it, and whatever brings it in.",
  "dependency.revoked":
    "These packages were revoked as malware and can't be used. Remove the package and ask again.",
});

/**
 * A signed-in person's packages, over `/rpc`: every call checks the
 * session, and who the person is now. Nothing here is offered to an
 * agent, a workflow or App code.
 */
export interface DependenciesApi {
  /**
   * Resolves what the source asks for into an exact graph from the npm
   * registry and proposes it, for one of the subject's builders: a request
   * that waits for a decision and allows nothing.
   */
  resolve: (intent: DependencyIntent) => Promise<DependencyRequest>;
  /** How an App's or a workflow's packages stand, for its builders. */
  status: (subject: DependencySubjectRef) => Promise<DependencyStatus>;
  /**
   * Approves or denies a pending request, once, as a builder of its App
   * or workflow, never Grasp staff or an agent. Refused with
   * `dependency.stale` when the request is no longer the one reviewed.
   */
  decide: (
    request: string,
    decision: DependencyDecision
  ) => Promise<DependencyRequest>;
}
