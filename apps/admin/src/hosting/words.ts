/**
 * What staff read of a client's hosting: each refusal and each code an
 * operation stops with, in the
 * admin's own words (it's English only). Codes stay on screen beside
 * them, as staff search the audit log and the code by them.
 */
import type { DeployErrorCode } from "../deploy/errors.ts";
import type { DiscardErrorCode } from "./discard.ts";
import type { InventoryErrorCode } from "./inventory.ts";
import type { OffboardingErrorCode } from "./offboarding.ts";
import type { ProvisionOperationErrorCode } from "./operation.ts";
import type { NotStarted, PlaceRefusal } from "./placement.ts";

/** Why an operation stopped, by the inventory's code. */
export const inventoryWords: Readonly<Record<InventoryErrorCode, string>> = {
  destination_unknown: "There's no such destination.",
  destination_other_stage:
    "That destination is in the other stage's clients' namespace: this admin places clients only in its own.",
  placement_changed:
    "The client is placed elsewhere already: moving it is a migration, not a placement.",
  not_placed: "The client isn't placed yet.",
  bucket_jurisdiction: "The release binds a bucket without naming it.",
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
  resource_unnamed:
    "The release has a resource the client naming scheme doesn't name: add it to the names module first.",
  unknown_placeholder:
    "The release names a placeholder the admin doesn't fill.",
  destination_unsupported:
    "The admin doesn't provision in that destination: it's workerd, or has no Cloudflare account or namespace recorded.",
  unowned_resource:
    "A resource exists under one of the client's names, but no run of this client asked for it: find out whose it is.",
  resource_outside_jurisdiction:
    "Cloudflare reports a resource outside the jurisdiction the inventory records.",
  runner_replaced: "Another attempt took the client over.",
};

/** Why an operation stopped, by its own code. */
const operationWords: Readonly<Record<ProvisionOperationErrorCode, string>> = {
  client_unknown: "There's no such client.",
  destination_other_stage:
    "That destination is in the other stage's clients' namespace: this admin places clients only in its own.",
  stage_unset:
    "This admin's STAGE is neither staging nor production, so it runs no operation: set it in its deploy, then start again.",
  release_not_imported: "That release isn't imported.",
  release_without_limits:
    "The release was built before platform limits were recorded, so it isn't made live.",
  limit_evidence_missing:
    "The release raises a platform limit without capacity and security evidence for this client's profile.",
  release_history_incomplete:
    "A release between where the client starts and this one isn't imported, so its evidence can't be read: import it first.",
  operation_release_changed:
    "Its provisioning is on a newer release already, or it's live: pick that release or a later one.",
  unknown_worker: "The release has a Worker other than core and connect.",
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

/**
 * Why it stopped, where nothing in the operation said: what it works
 * with couldn't be read, or its attempt ended without recording why.
 */
const startWords: Readonly<Record<string, string>> = {
  client_domain_unset:
    "This admin has no CLIENT_DOMAIN set, so it deploys no client: set it in its deploy, then resume.",
  run_errored:
    "Its attempt failed without recording why (it may have crashed or run out of retries): resume it, and look at the attempt's run if it fails again.",
  run_terminated: "Its attempt was stopped before it finished: resume it.",
  run_gone:
    "Its attempt is gone, or never started: resume it to start a new one.",
};

const knownWords: Readonly<Record<string, string>> = {
  ...inventoryWords,
  ...operationWords,
  ...startWords,
};

/** What a secret missing from Secrets Store is recorded as, before its name. */
const storeSecretMissing = /^store_secret_missing: (?<name>\w+)$/u;

/**
 * Why an operation stopped, by the code it recorded: its own, the
 * inventory's, or a deploy's (a Cloudflare answer, a deploy's refusal).
 */
export const operationErrorWords = (code: string): string => {
  const known = knownWords[code];
  if (known !== undefined) {
    return known;
  }
  const secret = storeSecretMissing.exec(code)?.groups?.name;
  if (secret !== undefined) {
    return `Secrets Store has no ${secret}, so nothing was started: add it (Deploy platform copies the store's secrets from 1Password), then resume.`;
  }
  return code.startsWith("cloudflare_")
    ? "Cloudflare refused a call: its status and error codes are in the code."
    : "The deploy steps stopped it: the code says why.";
};

/**
 * What a provisioning that stopped needs, by the code it stopped with
 * (src/hosting/reconcile.ts):
 * - `retry`: something passing (Cloudflare's lag or a 5xx, a run gone, a
 *   core still starting): the admin resumes it by itself, backing off;
 * - `release`: the release itself can't go there: the admin resumes it
 *   once a newer release fits, and until then tells staff;
 * - `staff`: a person must look first (a policy or hosting check that
 *   didn't hold, the admin's own setup, a resource someone else has): the
 *   admin tells staff and resumes nothing.
 */
export type FailureCause = "retry" | "release" | "staff";

/** Every fixed code an operation can stop with, and what it needs. */
const failureCauses = {
  // The operation's own.
  client_unknown: "staff",
  release_not_imported: "release",
  limit_evidence_missing: "release",
  release_without_limits: "release",
  release_history_incomplete: "release",
  operation_release_changed: "release",
  unknown_worker: "release",
  wfp_binding_unqualified: "release",
  destination_other_stage: "staff",
  stage_unset: "staff",
  wfp_schedule_unqualified: "release",
  upload_unobserved: "retry",
  secrets_unobserved: "retry",
  secret_unrevoked: "retry",
  probe_unqualified: "staff",
  probe_unanswered: "retry",
  probe_identity_mismatch: "retry",
  probe_binding_unanswered: "retry",
  probe_clock_unarmed: "retry",
  runner_replaced: "retry",
  operation_gone: "retry",
  client_not_active: "staff",
  operation_running: "retry",
  nothing_to_roll_back: "staff",
  rollback_past_migration: "staff",
  release_behind_migration: "release",
  release_rolled_back: "release",
  // The inventory's.
  destination_unknown: "staff",
  placement_changed: "staff",
  not_placed: "retry",
  bucket_jurisdiction: "release",
  unsupported_durable_object_migration: "release",
  resource_conflict: "staff",
  resource_missing: "retry",
  foreign_resource: "staff",
  unsupported_binding: "release",
  resource_unnamed: "release",
  durable_object_jurisdiction: "release",
  unknown_placeholder: "release",
  destination_unsupported: "staff",
  unowned_resource: "staff",
  resource_outside_jurisdiction: "staff",
  // A deploy's.
  release_blob_mismatch: "release",
  migration_lists_differ: "release",
  database_outside_eu: "staff",
  bucket_outside_eu: "staff",
  d1_migration_failed: "release",
  unknown_migration_tag: "staff",
  unknown_setting: "staff",
  setting_invalid: "staff",
  mail_sender_locked: "staff",
  sign_in_incomplete: "staff",
  binding_name_taken: "staff",
  reserved_secret_name: "staff",
  missing_secret: "staff",
  sealed_secret_unreadable: "staff",
  service_binding_cycle: "release",
  subdomain_unavailable: "retry",
  invalid_core_origin: "staff",
  smoke_check_failed: "retry",
  hostname_taken: "staff",
  generation_behind: "retry",
  router_entry_invalid: "staff",
} as const satisfies Record<
  ProvisionOperationErrorCode | InventoryErrorCode | DeployErrorCode,
  FailureCause
>;

const causesByCode: ReadonlyMap<string, FailureCause> = new Map(
  Object.entries(failureCauses)
);

/** A Cloudflare answer's code: `cloudflare_<status>`, then its error codes. */
const cloudflareStatus = /^cloudflare_(?<status>\d{3})/u;

/**
 * What a provisioning that stopped with `code` needs (`FailureCause`).
 * Beyond the fixed codes: a run that ended or is gone (`run_<status>`)
 * and anything unexpected are retried; Cloudflare's 429 and 5xx answers
 * are retried, its other refusals need a person, as do a secret missing
 * from Secrets Store and an admin with no client domain.
 */
export const failureCause = (code: string): FailureCause => {
  const known = causesByCode.get(code);
  if (known !== undefined) {
    return known;
  }
  if (code.startsWith("run_") || code === "unexpected") {
    return "retry";
  }
  const status = cloudflareStatus.exec(code)?.groups?.status;
  if (status !== undefined) {
    return status === "429" || status.startsWith("5") ? "retry" : "staff";
  }
  return "staff";
};

/** What staff read when placing and provisioning is refused, by its code. */
export const placeRefusals: Readonly<Record<PlaceRefusal, string>> = {
  ...inventoryWords,
  ...operationWords,
  no_automatic_destination:
    "There's no one shared destination to pick by itself: choose one.",
  other_run_held:
    "Another kind of run last worked on the client: let it end first.",
  hosted_on_prem:
    "It runs on its own premises: Grasp's cloud sets nothing up for it.",
  no_fitting_release:
    "No imported release can provision it yet: CI publishes one per merge, and the admin imports it within 5 minutes. Look at Releases if none comes.",
  already_running:
    "Something is working on the client already: wait for it to end.",
  not_provisioning:
    "The client isn't being provisioned: it's live or offboarded.",
};

/** What staff read when discarding a client is refused, by its code. */
export const discardRefusals: Readonly<Record<DiscardErrorCode, string>> = {
  client_unknown: "There's no such client.",
  not_provisioning:
    "It's live or offboarded: offboard it instead, which keeps its data for 30 days.",
  placed:
    "It's placed in a hosting destination: offboard it instead, then delete its resources.",
  has_resources:
    "Something of it is recorded (its provisioning, a resource or a Worker), so it may exist somewhere: offboard it instead.",
  client_busy:
    "Something is working on it right now: wait for that to end, then try again.",
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

/** Why setting it up hasn't started, and the next step, in a sentence. */
export const notStartedWords = (why: NotStarted | null): string => {
  if (why === "on_prem") {
    return "On-premises: Grasp's cloud sets nothing up for it. On-prem setup arrives with GRA-1291.";
  }
  if (why === "no_destination") {
    return "Not started: no shared hosting destination yet. The admin records its own as soon as it is read.";
  }
  if (why === "no_release") {
    return "Not started: no release imported yet. CI publishes one per merge, and the admin imports it within 5 minutes.";
  }
  return "Not started: provision it from Hosting.";
};
