import type { ToolClass } from "@grasp-os/shared/connect";

import type { ComposioClasses } from "../../src/composio-classes.ts";

// The classes of the fake Composio's tools, in place of the release's
// table (src/composio-classes.ts), in connect's tests and in the connect
// core's tests bundle (core's test/build-connect.ts). Every tool the tests
// call is classed, but for `HUBSPOT_UNCLASSED`, which no one classed, and
// `HUBSPOT_REFUSED`, which a review turned down. Writable, so a test can
// reclass a tool as a release would.

export const composioClasses: Record<string, Record<string, ToolClass>> = {
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
    // (src/never.ts), whatever their class. The shareholders' list only
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
  },
  acme_erp: { ACME_ERP_LIST_ORDERS: "read-company" },
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
    "mail.search": "read-company",
    "mail.send": "reach-others",
    "mail.unsure": "change-company",
    // By the names an App's connector resource declares (core's
    // test/mail-server.ts).
    MAIL_SEARCH: "read-company",
    MAIL_SEND: "reach-others",
    // A chat app's mail read and reply (core's chat-app-writes.test.ts).
    MAIL_READ: "read-company",
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
} satisfies ComposioClasses;
