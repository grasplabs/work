/**
 * Hosting policies and what a destination verifiably does (spec 38).
 * Geography and compliance are modelled apart from where a client runs: a
 * policy lists the capabilities it requires, a destination lists the ones
 * staff verified for it, each with the evidence they observed. A client is
 * placed only where every requirement is verified; a capability the
 * destination doesn't list is unknown, and unknown is unsupported.
 *
 * Policies are code, not rows: a new one, or a changed requirement, is a
 * reviewed change. There is no FedRAMP policy: `jurisdiction: "fedramp"`
 * confers no authorization, and the option stays out until its scope is
 * qualified.
 */
import { z } from "zod";

/** What a destination can be verified to do, one surface each (spec 38). */
export const capabilities = [
  /** D1 databases are created in the EU jurisdiction, and verified after. */
  "d1.eu_jurisdiction",
  /** R2 buckets, backups and workflow streams included, are in the EU jurisdiction. */
  "r2.eu_jurisdiction",
  /** Durable Object ids come from the EU-restricted namespace, on creation and lookup. */
  "durable_objects.eu_jurisdiction",
  /** Operational logs and analytics hold no payloads or secret values. */
  "logs.payload_free",
  /** Model calls go through approved endpoints, with payload logging and shared caching off. */
  "models.approved_transport",
  /** How the provider replicates Worker code and secrets is recorded. */
  "secrets.replication_recorded",
  /** HTTP ingress and the whole core, connect and Loader chain run in the EU. */
  "execution.eu_ingress",
  /** Clocks, alarms, dynamic execution and callbacks run in the EU. */
  "execution.eu_background",
] as const;

export type Capability = (typeof capabilities)[number];

/**
 * What provisioning checks by itself in a Workers for Platforms
 * destination (always this admin's own namespace, src/hosting/inventory.ts):
 * it creates each client's D1 databases and R2 buckets there and reads
 * back from Cloudflare the jurisdiction each one is in, stopping on any
 * outside the policy's (src/hosting/provision.ts). Nothing else is
 * observable from the admin: Durable Objects' jurisdiction isn't
 * reported by Cloudflare's API, and logs, model transport and secret
 * replication are about code and the provider, so a person vouches for
 * those.
 */
export const selfCheckedCapabilities: readonly Capability[] = [
  "d1.eu_jurisdiction",
  "r2.eu_jurisdiction",
];

/** Where a client's data is kept. Set when a resource is created; never relabelled. */
export type Jurisdiction = "eu";

export interface HostingPolicy {
  id: string;
  /** Exactly what is verified, and nothing more. */
  description: string;
  storageJurisdiction: Jurisdiction;
  requires: readonly Capability[];
}

/** Every policy's id. */
export const hostingPolicyIds = ["eu-storage"] as const;

export type HostingPolicyId = (typeof hostingPolicyIds)[number];

export const hostingPolicyIdSchema = z.enum(hostingPolicyIds);

/**
 * The policies a client may be placed under. The first restricts where
 * application data is stored, not where requests run: it doesn't claim
 * that everything stays in the EU.
 */
export const hostingPolicies = {
  "eu-storage": {
    id: "eu-storage",
    description:
      "Application data (D1, R2, Durable Objects) is stored in the EU jurisdiction; logs hold no payloads; models are reached only through approved transport; secret replication is recorded. Requests may run outside the EU.",
    storageJurisdiction: "eu",
    requires: [
      "d1.eu_jurisdiction",
      "r2.eu_jurisdiction",
      "durable_objects.eu_jurisdiction",
      "logs.payload_free",
      "models.approved_transport",
      "secrets.replication_recorded",
    ],
  },
} as const satisfies Record<HostingPolicyId, HostingPolicy>;

/**
 * What a verification was observed against: the source commit, a candidate
 * or release built from it, or the hosting profile. A report that names
 * none of these proves nothing about what runs.
 */
const subjectSchema = z.strictObject({
  kind: z.enum(["source", "candidate", "release", "profile"]),
  id: z.string().min(1).max(200),
});

/**
 * What staff observed: the procedure they ran, against what, when, and
 * where the record of it is kept. A bare "it works" doesn't parse.
 */
export const evidenceSchema = z.strictObject({
  procedure: z.string().min(1).max(500),
  subject: subjectSchema,
  observedAt: z.iso.datetime(),
  /** Who observed it: a staff member, or `system` for provisioning's own check. */
  recordedBy: z.union([z.email(), z.literal("system")]),
  /** Where the full record is: a qualification issue, a test run. */
  record: z.url(),
});

export type Evidence = z.infer<typeof evidenceSchema>;

/**
 * A destination's capabilities: each verified with evidence, or found
 * unsupported (also with evidence, so it isn't asked again blindly).
 */
export const destinationCapabilitiesSchema = z.partialRecord(
  z.enum(capabilities),
  z.strictObject({
    status: z.enum(["verified", "unsupported"]),
    evidence: evidenceSchema,
  })
);

export type DestinationCapabilities = z.infer<
  typeof destinationCapabilitiesSchema
>;

/** Why a destination can't take a client under a policy. */
export type PlacementProblem =
  | { kind: "policy_not_allowed" }
  | { kind: "capability_unsupported"; capability: Capability }
  | { kind: "capability_unknown"; capability: Capability };

/**
 * Everything that keeps a destination, allowed `allowed` policies and
 * verified `verified` capabilities, from taking a client under `policy`:
 * empty when it can. In a destination that `checksItself`, a
 * self-checked capability with no record yet keeps nothing out: its
 * first provisioning observes it, and stops if it isn't so.
 */
export const placementProblems = (
  policy: HostingPolicy,
  allowed: readonly string[],
  verified: DestinationCapabilities,
  checksItself = false
): PlacementProblem[] => {
  const problems: PlacementProblem[] = [];
  if (!allowed.includes(policy.id)) {
    problems.push({ kind: "policy_not_allowed" });
  }
  for (const capability of policy.requires) {
    const status = verified[capability]?.status;
    if (
      status === undefined &&
      checksItself &&
      selfCheckedCapabilities.includes(capability)
    ) {
      continue;
    }
    if (status === undefined) {
      problems.push({ kind: "capability_unknown", capability });
    } else if (status !== "verified") {
      problems.push({ kind: "capability_unsupported", capability });
    }
  }
  return problems;
};
