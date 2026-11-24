import type { CapabilityClaims } from "@grasp-os/shared/capability";
import { connectErrors } from "@grasp-os/shared/connect";
import type { Json } from "@grasp-os/shared/json";

import { allowedTool } from "./connections.ts";
import type { Connection } from "./connections.ts";

// Where in a company app a chat's agent reads (GRA-725): an admin points
// it at a Composio connection for some people (core's app-pointers.ts),
// within some of its resources or the whole app. Core refuses the agent's
// reads in an app it isn't pointed at; the resources a read names are in
// its free-form input, so they are checked here, against those core signed
// in. The ways it can fail, which the tests start from: a read of another
// resource than those pointed at runs; a read that names none, or names it
// by another property than the admin's rule, slips past; a change is bound
// by it rather than waiting for its person's press.

/**
 * Refuses a chat agent's read in a company app (a Composio tool connect
 * takes to read) whose resource isn't among those its company pointed it
 * at there (`CapabilityClaims.resources`, core's app-pointers.ts):
 * `connect.resource_not_pointed`. A read of a tool with no resource
 * property can't be held to any, so it is refused too. Changes aren't
 * bound by it: each waits for its person's press.
 */
export const requirePointedResource = (
  claims: Pick<CapabilityClaims, "authority" | "resources">,
  connection: Pick<Connection, "serverKind" | "provider" | "tools">,
  action: string,
  input: Readonly<Record<string, Json>>
): void => {
  if (
    claims.authority.subject.type !== "agent" ||
    claims.resources === undefined ||
    connection.serverKind !== "composio"
  ) {
    return;
  }
  const rule = allowedTool(connection, action);
  if (rule === undefined || !rule.read) {
    return;
  }
  const named = rule.resource === undefined ? undefined : input[rule.resource];
  if (typeof named !== "string" || !claims.resources.includes(named)) {
    throw connectErrors.create("connect.resource_not_pointed");
  }
};
