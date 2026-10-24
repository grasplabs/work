import type { CapabilityClaims } from "@grasp-os/shared/capability";
import { connectErrors } from "@grasp-os/shared/connect";
import type { Json } from "@grasp-os/shared/json";

import type { Connection } from "./connections.ts";
import type { McpTool } from "./mcp.ts";

// Which mailboxes a chat's agent reaches in Microsoft 365 (GRA-724): its
// person's own, through their own connection, and the shared mailboxes
// their company pointed it at for them (core's shared-mailboxes.ts, in the
// capability core signs). A Microsoft 365 mail tool takes any mailbox the
// account may open, so it is checked here, where the call's mailbox is
// known, not only in core. The ways it can fail, which the tests start
// from: a shared mailbox read without a pointer, or by someone it doesn't
// name; another case or spelling of an address passing for one pointed
// at; a shared connection's own mailbox taken as the person's own; a held
// sort run, once confirmed, on a mailbox its pointer no longer names.
//
// Apps and workflows aren't bound by it: their permissions name the
// mailbox they may use as the call's resource.

/** The addresses a connection's own account receives mail at. */
const ownAddresses = (
  connection: Pick<
    Connection,
    "accountEmail" | "accountName" | "accountAddresses"
  >
): Set<string> =>
  new Set(
    [
      connection.accountEmail,
      connection.accountName,
      ...(connection.accountAddresses ?? []),
    ]
      .filter((address) => address !== null)
      .map((address) => address.toLowerCase())
  );

/**
 * Refuses a chat agent's Microsoft 365 mail call on a mailbox that is
 * neither its person's own, through their own personal connection, nor
 * one its company pointed it at for them (`connect.mailbox_not_pointed`).
 */
export const requirePointedMailbox = (
  claims: Pick<CapabilityClaims, "authority" | "mailboxes">,
  connection: Pick<
    Connection,
    | "serverKind"
    | "provider"
    | "scope"
    | "accountEmail"
    | "accountName"
    | "accountAddresses"
  >,
  action: string,
  tool: Pick<McpTool, "resourceField">,
  input: Readonly<Record<string, Json>>
): void => {
  const mailTool =
    connection.serverKind === "native" &&
    connection.provider === "microsoft" &&
    action.startsWith("mail.") &&
    tool.resourceField === "mailbox";
  // Core signs the mailboxes into every capability of a chat's agent; one
  // without them (a core from before them) isn't held to them.
  if (
    claims.authority.subject.type !== "agent" ||
    claims.mailboxes === undefined ||
    !mailTool
  ) {
    return;
  }
  const { mailbox } = input;
  if (typeof mailbox !== "string") {
    throw connectErrors.create("connect.mailbox_not_pointed");
  }
  const wanted = mailbox.toLowerCase();
  // A shared connection's own mailbox is the company's, never the
  // person's: it needs a pointer like any other.
  const own =
    connection.scope === "personal" && ownAddresses(connection).has(wanted);
  if (own || claims.mailboxes.includes(wanted)) {
    return;
  }
  throw connectErrors.create("connect.mailbox_not_pointed");
};
