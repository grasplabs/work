/**
 * What staff read of a client's hosting: each requirement a destination
 * can miss, each refusal and each code an operation stops with, in the
 * admin's own words (it's English only). Codes stay on screen beside
 * them, as staff search the audit log and the code by them.
 */
import type { InventoryErrorCode } from "./inventory.ts";
import type { OffboardingErrorCode } from "./offboarding.ts";
import type { ProvisionOperationErrorCode } from "./operation.ts";
import type { DestinationProblem, PlaceRefusal } from "./placement.ts";
import type { Capability } from "./policy.ts";

/** Each capability a policy can require, as staff check it. */
const capabilityWords: Readonly<Record<Capability, string>> = {
  "d1.eu_jurisdiction": "D1 databases are created in the EU jurisdiction",
  "r2.eu_jurisdiction":
    "R2 buckets, backups and workflow streams included, are in the EU jurisdiction",
  "durable_objects.eu_jurisdiction":
    "Durable Object ids come from the EU-restricted namespace",
  "logs.payload_free": "Logs and analytics hold no payloads or secret values",
  "models.approved_transport":
    "Model calls go only through approved endpoints, without payload logging or shared caching",
  "secrets.replication_recorded":
    "How the provider replicates Worker code and secrets is recorded",
  "execution.eu_ingress":
    "Requests and the whole core and connect chain run in the EU",
  "execution.eu_background":
    "Clocks, alarms, dynamic execution and callbacks run in the EU",
};

/** What keeps a destination from taking the client, in words. */
export const problemWords = (problem: DestinationProblem): string => {
  switch (problem.kind) {
    case "policy_not_allowed": {
      return "It doesn't serve this policy.";
    }
    case "capability_unknown": {
      return `Not verified: ${capabilityWords[problem.capability]} (${problem.capability}). Unknown counts as unsupported.`;
    }
    case "capability_unsupported": {
      return `Found unsupported: ${capabilityWords[problem.capability]} (${problem.capability}).`;
    }
    case "not_provisionable": {
      return "The admin doesn't provision here: it's workerd, set up by its operator, or has no Cloudflare account or dispatch namespace recorded.";
    }
    default: {
      return "It can't take the client.";
    }
  }
};

/** Why an operation stopped, by the inventory's code. */
const inventoryWords: Readonly<Record<InventoryErrorCode, string>> = {
  destination_unknown: "There's no such destination.",
  destination_other_stage:
    "That destination is in the other stage's clients' namespace: this admin places clients only in its own.",
  placement_refused:
    "That destination misses a requirement of the policy: each is listed with it.",
  placement_changed:
    "The client is placed elsewhere or under another policy already: moving it is a migration, not a placement.",
  not_placed: "The client isn't placed yet.",
  bucket_jurisdiction:
    "The release binds a bucket outside the policy's jurisdiction.",
  unsupported_durable_object_migration:
    "The release renames or transfers a Durable Object class, which needs a decision first.",
  durable_object_jurisdiction:
    "The release sets its Durable Objects' jurisdiction in a binding: core sets it as it creates each one.",
  resource_conflict:
    "A resource is recorded differently from what the release needs of it.",
  resource_missing:
    "A binding needs a resource the client's inventory doesn't have, or hasn't observed yet.",
  foreign_resource:
    "A binding would reach a resource that isn't this client's own.",
  unsupported_binding: "The release has a binding the admin doesn't map.",
  unknown_placeholder:
    "The release names a placeholder the admin doesn't fill.",
  destination_unsupported:
    "The admin doesn't provision in that destination: it's workerd, or has no Cloudflare account or namespace recorded.",
  unowned_resource:
    "A resource exists under one of the client's names, but no run of this client asked for it: find out whose it is.",
  resource_outside_jurisdiction:
    "Cloudflare reports a resource outside the jurisdiction the inventory records.",
  runner_replaced: "Another attempt took the client over.",
  evidence_subject_unknown:
    "Evidence names a release, commit, candidate or runtime profile the admin can't check.",
};

/** Why an operation stopped, by its own code. */
const operationWords: Readonly<Record<ProvisionOperationErrorCode, string>> = {
  client_unknown: "There's no such client.",
  destination_other_stage:
    "That destination is in the other stage's clients' namespace: this admin places clients only in its own.",
  release_not_imported: "That release isn't imported.",
  release_undeclared:
    "The release declares nothing of what its code works with.",
  release_incompatible:
    "The release doesn't work with what the client runs, or with itself.",
  schema_incompatible:
    "The release's code doesn't run on the client's databases as its migrations left them.",
  release_without_limits:
    "The release was built before platform limits were recorded, so it isn't made live.",
  limit_evidence_missing:
    "The release raises a platform limit without capacity and security evidence for this client's profile.",
  release_history_incomplete:
    "A release between where the client starts and this one isn't imported, so its evidence can't be read: import it first.",
  operation_release_changed:
    "Its provisioning is with another release: that release stays for the operation.",
  unknown_worker: "The release has a Worker other than core and connect.",
  model_spend_undecided:
    "A Worker binds Workers AI, and placed clients get no model spend until a ceiling and the shared gateway are configured.",
  wfp_binding_unqualified:
    "A Worker has a binding Workers for Platforms doesn't document for user Workers.",
  wfp_schedule_unqualified:
    "A Worker has cron triggers, which Workers for Platforms doesn't document for user Workers.",
  upload_unobserved:
    "A script isn't at the release's Durable Object migration after its upload.",
  secrets_unobserved: "A script lacks a secret after it was delivered.",
  secret_unrevoked:
    "A script still has a secret it's no longer given after it was removed.",
  probe_unqualified:
    "There's no qualified way to probe core in a Workers for Platforms namespace yet, so its hostname stays unpublished.",
  probe_unanswered:
    "Core didn't answer the admin's signed probe, as a core from a release before the probe doesn't.",
  probe_identity_mismatch:
    "Core answered the probe as another client or another version than the one live.",
  probe_binding_unanswered:
    "A private binding the release gives core didn't answer the probe.",
  probe_clock_unarmed:
    "Core's clock or connect's isn't armed with tasks after the probe.",
  runner_replaced: "Another attempt took the client over.",
  operation_gone: "The operation's record was gone before it was done.",
  client_not_active:
    "The client isn't live: provision it first, then release it.",
  operation_running:
    "Its operation is still running: wait for it to end, or resume it if it stopped.",
  nothing_to_roll_back:
    "There's no release before the one it runs to go back to.",
  rollback_past_migration:
    "The release since added Durable Object migrations, which a script never goes back past: release a fix instead.",
  release_rolled_back:
    "It failed its probe once live, so it was rolled back to the release before on its own: look at the release before releasing it again.",
  release_behind_migration:
    "That release lacks a Durable Object migration the client's scripts ran, which they never go back past: pick a later release.",
};

const knownWords: Readonly<Record<string, string>> = {
  ...inventoryWords,
  ...operationWords,
};

/**
 * Why an operation stopped, by the code it recorded: its own, the
 * inventory's, or a deploy's (a Cloudflare answer, a deploy's refusal).
 */
export const operationErrorWords = (code: string): string => {
  const known = knownWords[code];
  if (known !== undefined) {
    return known;
  }
  return code.startsWith("cloudflare_")
    ? "Cloudflare refused a call: its status and error codes are in the code."
    : "The deploy steps stopped it: the code says why.";
};

/** What staff read when placing and provisioning is refused, by its code. */
export const placeRefusals: Readonly<Record<PlaceRefusal, string>> = {
  ...inventoryWords,
  ...operationWords,
  no_automatic_destination:
    "There's no one shared destination to pick by itself: choose one.",
  other_run_held:
    "Another kind of run last worked on the client: let it end first.",
  already_running:
    "Something is working on the client already: wait for it to end.",
  not_provisioning:
    "The client isn't being provisioned: it's live or offboarded.",
};

/** What staff read when offboarding or deleting is refused, by its code. */
export const offboardRefusals: Readonly<Record<OffboardingErrorCode, string>> =
  {
    client_unknown: "There's no such client.",
    not_placed:
      "It isn't placed in a hosting destination, which this offboarding is for.",
    client_busy:
      "Something is working on it right now: wait for that to end, then try again.",
    not_offboarded: "It isn't offboarded: offboard it first.",
    retention_running:
      "Its resources are kept for 30 days after it was offboarded: try again once that's over.",
    export_unconfirmed:
      "Confirm that no export of it was made before deleting its resources.",
    resource_not_owned:
      "A resource recorded for it, or what its destination has under that name, isn't its own, so it was left: look at its inventory.",
    destination_unsupported: "Its destination isn't one the admin deletes in.",
    routing_unconfigured:
      "The admin has no client domain set, so it can't take the client's hostname out of the router: set CLIENT_DOMAIN first.",
    hostname_not_ours:
      "Its hostname routes to another client in the router's map, so it was left: find out why before offboarding it.",
  };
