import { schemaFromDescriptor } from "@grasp-os/sdk/host";
import { issuesOf } from "@grasp-os/shared/errors";
import { canonicalJson } from "@grasp-os/shared/json";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import { z } from "zod";

import { resolveCatalogKeys } from "../workflow-catalog.ts";
import type { StoredEvent } from "./event-envelopes.ts";

// The event contracts a run's start pinned, as both ways events cross a
// run read them: those admitted to its inbox (run-events.ts) and those
// its `emit` tasks send (emitted-events.ts). A type is one only when the
// pinned contract, by its fingerprint, admits it, and data is what that
// type's native descriptor takes.

/**
 * `data` as the contract's descriptor `descriptor` takes it, normalized:
 * `workflow.event_invalid` with its issues (paths, never values)
 * otherwise, or past what one event's data may take.
 */
export const acceptedEventData = (
  descriptor: string,
  data: unknown
): StoredEvent["data"] => {
  const checked = schemaFromDescriptor(descriptor)["~standard"].validate(data);
  if ("then" in checked) {
    throw new Error("An event's data schema validated asynchronously");
  }
  if (checked.issues !== undefined) {
    throw workflowResourceErrors.create("workflow.event_invalid", {
      issues: issuesOf({
        issues: checked.issues.map(({ path, message }) => ({
          path: (path ?? []).map(String),
          message,
        })),
      }),
    });
  }
  const parsed = z.json().safeParse(checked.value);
  if (
    !parsed.success ||
    new TextEncoder().encode(canonicalJson(parsed.data)).byteLength >
      platformLimits.operationInputBytes
  ) {
    throw workflowResourceErrors.create("workflow.event_invalid", {
      issues: ["data: Not JSON, or too large for an event."],
    });
  }
  return parsed.data;
};

/**
 * The data descriptor of type `type` in the event contract `binding` of
 * a run's start pinned, checked against the fingerprint it pinned; none
 * when the contract doesn't admit the type.
 */
export const pinnedEventDataOf = async (
  env: Env,
  binding: { contractId: string; fingerprint: string },
  type: string
): Promise<string | undefined> => {
  const resolved = await resolveCatalogKeys(env, [binding.contractId]);
  const contract = resolved.get(binding.contractId);
  const events = contract?.contract.events;
  if (
    contract === undefined ||
    contract.fingerprint !== binding.fingerprint ||
    events === undefined ||
    !Object.hasOwn(events, type)
  ) {
    return undefined;
  }
  return events[type]?.data;
};
