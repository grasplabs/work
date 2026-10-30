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
  erased_people: {
    kept: "whose erasure began, by ID: what keeps connect from making anything of theirs again",
  },
  audit_outbox: { kept: "audit events on their way to the log (D2)" },
  audit_outbox_rejected: { kept: "audit events the log refused (D2)" },
};
