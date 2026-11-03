// Where a person's data lives in connect's database, and what erasing them
// does to each place (GRA-903, GRA-1189): every table, classified as core's
// own inventory classifies core's (core's person-erasure-inventory.ts),
// whether a column's name suggests a person (@grasp-os/shared/person-
// columns) or not. A test fails when a table is added that isn't listed.

/** What erasing a person does to a table of connect's. */
export type ErasureClass =
  | {
      readonly erased: "connect";
      /** What the table keeps of them, as the company's, when anything. */
      readonly keeps?: string;
    }
  | { readonly company: string }
  | { readonly kept: string }
  | { readonly none: string };

/** A table that holds no person at all. */
export const noPerson = { none: "holds no person" } as const;

/** Every table of connect's database. */
export const erasureInventory: Readonly<Record<string, ErasureClass>> = {
  // Their personal connections are emptied, and everything read through
  // them or still to be done with them goes.
  connections: {
    erased: "connect",
    keeps: "a shared connection they made keeps them as `connected_by`",
  },
  connection_tokens: { erased: "connect" },
  connector_events: { erased: "connect" },
  event_sources: { erased: "connect" },
  idempotent_calls: { erased: "connect" },
  pending_actions: { erased: "connect" },
  oauth_flows: { erased: "connect" },
  composio_flows: { erased: "connect" },
  call_changes: { erased: "connect" },
  composio_cleanups: { kept: "what Composio still has to delete, by its IDs" },
  composio_tool_sends: {
    kept: "tool lists sent to Composio, by connection ID, gone once answered",
  },
  token_revocations: {
    kept: "revokes still owed at a provider, by connection ID: the erasure waits for them",
  },
  given_up_revocations: {
    kept: "revokes given up on, by connection ID, for admins to do by hand",
  },
  ai_provider_keys: { none: "the organization's own AI provider keys" },
  http_connections: {
    none: "the organization's approved outside APIs and their sealed credentials",
  },
  erased_people: {
    kept: "whose erasure began, by ID: what keeps connect from making anything of theirs again",
  },
  audit_outbox: { kept: "audit events on their way to the log (D2)" },
  audit_outbox_rejected: { kept: "audit events the log refused (D2)" },
};

/**
 * The columns of each table that name or hold a person
 * (@grasp-os/shared/person-columns), as they were reviewed when the table
 * was classified above; a table with none isn't listed. A column added to
 * a table already classified fails the test until it is listed here, and
 * whether the table's classification still holds for it is decided then.
 */
export const reviewedPersonColumns: Readonly<
  Record<string, readonly string[]>
> = {
  call_changes: ["on_behalf_of"],
  composio_flows: ["user_id"],
  connections: [
    "account_email",
    "account_senders",
    "connected_by",
    "owner_user_id",
  ],
  erased_people: ["user_id"],
  idempotent_calls: ["on_behalf_of", "subject_id", "subject_type"],
  oauth_flows: ["user_id"],
  pending_actions: ["on_behalf_of", "subject_id", "subject_type"],
};
