import { connectErrors } from "@grasp-os/shared/connect";
import type { Json } from "@grasp-os/shared/json";

import type { Connection, ToolRule } from "./connections.ts";
import type { McpServerTool, McpTool, McpToolResult } from "./mcp.ts";

// What connect takes a tool to be. A native connector's tool is what its
// manifest says: the manifest is ours, reviewed. A Composio server's tool
// is what the class Grasp gave it and the admin's allowlist say
// (`composioTool`, threat model CN16), whatever the server declares about
// it: one nobody classed isn't run at all (`allowedTool`), a read only if
// both its class and the admin say so, held to one resource only by the
// input property the admin named, and to the places the admin pointed it
// at, if any.

type ServerKind = Connection["serverKind"];

/** A plain identifier: no dots, brackets or other paths into the input. */
const resourceFieldPattern = /^[A-Za-z_]\w*$/u;

/**
 * A Composio server's tool as the admin's rule for it says. The server's
 * own hints aren't even read (`McpServerTool`): only the input properties
 * its schema declares are kept, to hold a call to them.
 */
export const composioTool = (
  { name, inputProperties }: McpServerTool,
  rule: ToolRule
): McpTool => ({
  name,
  inputProperties,
  readOnly: rule.read,
  resourceField: rule.resource,
  ...(rule.places === undefined ? {} : { places: rule.places }),
});

/**
 * Whether a call of `tool`, as connect takes it to be (above), is handled
 * as a side effect: anything not declared read-only may change something.
 * So is every call on a Composio server from a context that read
 * restricted data (`restricted`), reads too: its input goes to a third
 * party and may carry that data, so the person it acts for decides (R12).
 * Like any side effect of a workflow run it then needs an idempotency key:
 * without one it is refused, not held (for a call a person is there for,
 * connect makes the key as it holds it; call.ts). Its answer is then kept
 * like any side effect's, so a run's step that waited for the person's
 * decision gets it rather than being held again.
 */
export const hasSideEffect = (
  tool: McpTool,
  kind: ServerKind,
  restricted: boolean
): boolean => !tool.readOnly || (restricted && kind === "composio");

/**
 * Keeps a call for one resource on that resource. The capability names the
 * resource, but the call's target is in its free-form input, so the tool
 * must say which input property holds it, and that property must name
 * exactly the capability's resource. The input may hold only properties
 * the tool's input schema declares, so no other spelling of the resource
 * property (another case, an alias) slips past. A tool that says none of
 * this can't be called for one resource at all.
 */
export const checkResourceScope = (
  resource: string | null,
  tool: McpTool,
  input: Readonly<Record<string, Json>>
): void => {
  if (resource === null) {
    return;
  }
  const { resourceField, inputProperties } = tool;
  const declared = new Set(inputProperties);
  const inScope =
    resourceField !== undefined &&
    resourceFieldPattern.test(resourceField) &&
    declared.has(resourceField) &&
    Object.keys(input).every((key) => declared.has(key)) &&
    input[resourceField] === resource;
  if (!inScope) {
    throw connectErrors.create("connect.resource_out_of_scope");
  }
};

/**
 * Keeps a call of a tool an admin pointed at some places (`McpTool.places`)
 * on them, whatever the capability names: the person Stephen acts for may
 * ask about anything, and he reads only where the admin pointed him. Its
 * resource property must name one of the places exactly, and its input
 * may hold only properties the tool's schema declares, so no other
 * spelling of that property names somewhere else. A call that names no
 * place, such as a search across the whole app, is refused too: it would
 * reach beyond them.
 */
export const checkPlaces = (
  tool: McpTool,
  input: Readonly<Record<string, Json>>
): void => {
  const { places, resourceField, inputProperties } = tool;
  if (places === undefined) {
    return;
  }
  const declared = new Set(inputProperties);
  const named =
    resourceField !== undefined && declared.has(resourceField)
      ? input[resourceField]
      : undefined;
  const inPlace =
    resourceField !== undefined &&
    resourceFieldPattern.test(resourceField) &&
    Object.keys(input).every((key) => declared.has(key)) &&
    typeof named === "string" &&
    places.includes(named);
  if (!inPlace) {
    throw connectErrors.create("connect.place_out_of_scope");
  }
};

/**
 * Whether a tool's error result means the call did nothing at all
 * (`notPerformedMetaKey`), so its idempotency key is free again. Only a
 * native connector is taken at its word: a remote server's tool that acted
 * and then said it hadn't would have its side effect run twice.
 */
export const didNothing = (kind: ServerKind, result: McpToolResult): boolean =>
  kind === "native" && result.notPerformed;

/**
 * Whether a side effect's error result leaves open whether it acted, so it
 * is `connect.outcome_unknown` with its key spent, not a failure kept as
 * the answer to every repeat. A tool that says so (`outcomeUnknownMetaKey`)
 * is believed from any server: it can only stop a repeat. A native
 * connector's other errors are refusals its reviewed code made before
 * acting (the kit marks the rest unknown).
 *
 * Every error of a Composio tool that may act is unknown (GRA-539).
 * Composio runs the tool remotely and may answer a provider's 5xx, a
 * timeout or a dropped connection after the provider acted, in a result
 * that looks like any other error. Its documented answer (`successful`,
 * `error`, `data`) carries no provider status, and toolkits put one, if at
 * all, in their own `data` or message text, so nothing in it proves the
 * provider refused before acting. When in doubt, unknown: a stored failure
 * tells every repeat the action failed, and code that read that as
 * "nothing was sent" would send it again under a fresh key. The cost is
 * that an input the provider rejected outright is unknown too. Recorded
 * Composio answers, per toolkit, can narrow this later to a shape that
 * does prove a refusal (a 4xx it passes on, or its own validation error
 * before running the tool). A tool the admin marked read-only can't have
 * acted, so its error stays a failure, as on a read.
 */
export const uncertainFailure = (
  kind: ServerKind,
  tool: McpTool,
  result: McpToolResult
): boolean =>
  result.outcomeUnknown ||
  (kind === "composio" && result.isError && !tool.readOnly);

/**
 * The result as connect passes it on, with the resources it read. A
 * Composio server's tools name none (`provenanceMetaKey` is ours), so
 * a call there that names none is known by its toolkit and tool, such as
 * `hubspot/HUBSPOT_LIST_CONTACTS`: what its output came from, if not
 * which record.
 */
export const withProvenance = (
  connection: Pick<Connection, "serverKind" | "provider">,
  tool: string,
  result: McpToolResult
): McpToolResult =>
  connection.serverKind === "native" || result.provenance.length > 0
    ? result
    : { ...result, provenance: [`${connection.provider}/${tool}`] };
