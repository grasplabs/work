import {
  composioClasses as shipped,
  toolkitsWithoutCopies as shippedWithoutCopies,
} from "../../src/composio-classes.ts";
import type {
  ComposioClass,
  ComposioClasses,
} from "../../src/composio-classes.ts";

// The release's table (src/composio-classes.ts), with the classes of the
// fake Composio's tools in place of its HubSpot's, in connect's tests and
// in the connect core's tests bundle (core's test/build-connect.ts), so a
// test can run a reviewed toolkit's own tools too. Every tool the tests
// call is classed, but for `HUBSPOT_UNCLASSED`, which no one classed, and
// `HUBSPOT_REFUSED`, which a review turned down. Writable, so a test can
// reclass a tool as a release would.

export const composioClasses: Record<string, Record<string, ComposioClass>> = {
  ...shipped,
  // The fake's toolkit that takes a key.
  pipedesk: {
    PIPEDESK_LIST_DEALS: "read-company",
    PIPEDESK_ADD_NOTE: "change-company",
  },
  hubspot: {
    HUBSPOT_LIST_CONTACTS: "read-company",
    HUBSPOT_GET_CONTACT: "read-company",
    HUBSPOT_SEARCH: "read-company",
    HUBSPOT_CREATE_CONTACT: "change-company",
    HUBSPOT_UPDATE_CONTACT: "change-company",
    HUBSPOT_UPDATE_CONTACTS: "change-company",
    HUBSPOT_EXPORT_EVERYTHING: "read-company",
    HUBSPOT_REFUSED: "never",
    // Classed as a review could get them wrong: Never by their names
    // (isNeverTool), whatever their class. The shareholders' list only
    // has a word of the rule inside another, and runs.
    HUBSPOT_DELETE_COMPANY: "change-company",
    HUBSPOT_SHARE_LIST: "read-company",
    HUBSPOT_UPDATE_SETTINGS: "change-company",
    HUBSPOT_CREATE_PAYMENT: "change-company",
    HUBSPOT_LIST_SHAREHOLDERS: "read-company",
    // Composio's server serves these wrong (composio-contracts.test.ts):
    // classed, so it's their shape that keeps them out.
    HUBSPOT_HUGE: "read-company",
    HUBSPOT_DEEP_32: "read-company",
    HUBSPOT_DEEP_33: "read-company",
    HUBSPOT_ABYSS: "read-company",
    "HUBSPOT.DOTTED": "read-company",
    HUBSPOT_PATTERN: "read-company",
    HUBSPOT_DEEP_PATTERN: "read-company",
    HUBSPOT_PATTERN_ANSWER: "read-company",
    HUBSPOT_TWICE: "read-company",
    HUBSPOT_SHADOWED: "read-company",
    HUBSPOT_PROTO: "read-company",
    // The CRM of core's Stephen eval, whose note plants an instruction
    // (core's test/fixtures/stephen-world.ts).
    HUBSPOT_SEARCH_NOTES: "read-company",
    HUBSPOT_UPDATE_DEAL: "change-company",
  },
  acme_erp: { ACME_ERP_LIST_ORDERS: "read-company" },
  // A toolkit as big as one generated connector makes, for core's tool
  // search (core's test/tool-search.test.ts): `BULK_TOOL_0` to
  // `BULK_TOOL_2999` and the few its tests look for, each a read.
  bulk: Object.fromEntries(
    [
      ...Array.from({ length: 3000 }, (_, index) => `BULK_TOOL_${index}`),
      "BULK_FIND_SHIPMENT",
      "BULK_LEDGER_EXPORT",
      ...Array.from({ length: 6 }, (_, index) => `BULK_LEDGER_READ_${index}`),
      ...Array.from({ length: 21 }, (_, index) => `BULK_QUOKKA_READ_${index}`),
      "BULK_WOMBAT_READ_0",
      "BULK_WOMBAT_READ_1",
    ].map((name) => [name, "read-company"] as const)
  ),
  // The tests' own mail server (connect.ts). `mail.relay` fails on
  // demand (idempotency.test.ts), so it is classed a read, which lets a
  // test take a failing tool down the read path.
  mail: {
    "mail.archive": "change-company",
    "mail.bounce": "change-company",
    "mail.draft": "change-company",
    "mail.export": "read-company",
    "mail.relay": "read-company",
    "mail.list": "read-company",
    "mail.mixed": "read-company",
    "mail.open": "read-company",
    "mail.photo": "read-company",
    "mail.read": "read-company",
    "mail.search": { class: "read-company", mail: true },
    "mail.send": "reach-others",
    "mail.unsure": "change-company",
    // By the names an App's connector resource declares (core's
    // test/mail-server.ts).
    MAIL_SEARCH: { class: "read-company", mail: true },
    MAIL_SEND: "reach-others",
    // A chat app's mail read and reply (core's chat-app-writes.test.ts).
    MAIL_READ: { class: "read-company", mail: true },
    MAIL_REPLY: "change-company",
  },
  // Core's CRM (core's resource-connectors.test.ts).
  crm: {
    CRM_LIST_CONTACTS: "read-company",
    CRM_CREATE_CONTACT: "change-company",
  },
  // A toolkit slugged as a native provider (pending.test.ts): classed, so
  // what keeps it apart from the native connector is that it's Composio's.
  microsoft: { "mail.send": "reach-others" },
  // The tests' mail server under a toolkit whose terms forbid copies
  // (`toolkitsWithoutCopies`): core's connection-capture.test.ts.
  mail_private: { "mail.search": "read-company", "mail.send": "reach-others" },
  // The tests' mail server as a toolkit reaching its person's own mail:
  // what core keeps of a person's own reads (connection-capture.test.ts).
  mail_own: {
    "mail.search": "read-own",
    "mail.read": "read-own",
    // Reads someone else's mail: never kept (GRA-1845).
    "mail.others": "read-others",
    "mail.send": "reach-others",
  },
} satisfies ComposioClasses;

/** The release's, and the tests' mail server under `mail_private`. */
export const toolkitsWithoutCopies: ReadonlySet<string> = new Set([
  ...shippedWithoutCopies,
  "mail_private",
]);
