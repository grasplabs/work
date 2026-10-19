import type { IntegrationBuild } from "../../../src/admin/admin-integrations.ts";

/**
 * The apps the sample organizations' workflows ask for that Composio does not have, made up like
 * the organizations themselves, at every step a build can be in: one only asked for, one the agent
 * is researching, one whose plan waits for approval, one waiting for credentials, one in review,
 * one rolling out, and one Grasp does not build. Lender portals and Transporeon are the ones the
 * samples' Integrations already show as asked of Grasp.
 */
export const SAMPLE_BUILDS: IntegrationBuild[] = [
  {
    id: "syntess",
    app: "Syntess Atrium",
    about:
      "The installation trade’s business software: work orders, hours and materials, and the invoices made from them.",
    docs: "https://www.syntess.nl",
    auth: "apiKey",
    actions: [
      { name: "Read a work order", access: "read" },
      { name: "Read the hours and materials on a work order", access: "read" },
      { name: "Mark a work order ready to invoice", access: "write" },
    ],
    requests: [
      {
        org: "veldkamp",
        workflows: ["Invoicing work orders", "Doing a maintenance visit"],
        on: "2026-10-06",
        by: "Marjan Vos",
      },
    ],
    stage: "requested",
    reached: { requested: "2026-10-06" },
  },
  {
    id: "twinfield",
    app: "Twinfield",
    about: "Bookkeeping software accountants keep their clients’ books in.",
    docs: "https://accounting.twinfield.com/webservices/documentation/",
    auth: "oauth2",
    actions: [
      { name: "Read a client’s general ledger", access: "read" },
      { name: "Read the VAT figures of a period", access: "read" },
      { name: "Post a journal entry", access: "write" },
    ],
    requests: [
      {
        org: "vanrijn",
        workflows: ["Filing the VAT return", "Preparing the annual accounts"],
        on: "2026-10-03",
        by: "Ingrid Maas",
      },
    ],
    stage: "researching",
    reached: { requested: "2026-10-03", researching: "2026-10-15" },
    work: {
      session: "sesn_011CTwinfield4q9X",
      branch: "feat/connector-twinfield",
      minutes: 9,
      cost: 1.4,
    },
  },
  {
    id: "lender-portals",
    app: "Lender portals",
    about:
      "Where a mortgage application goes to the lender. Most Dutch lenders take applications through HDN, so one connection reaches them all.",
    docs: "https://www.hdn.nl",
    auth: "apiKey",
    actions: [
      { name: "Send a mortgage application", access: "write" },
      { name: "Read where an application stands", access: "read" },
      { name: "Read the lender’s offer", access: "read" },
      { name: "Send a document the lender asks for", access: "write" },
    ],
    requests: [
      {
        org: "noordkade",
        workflows: ["The mortgage application"],
        on: "2026-09-12",
        by: "Mark Jansen",
      },
    ],
    stage: "plan",
    reached: {
      requested: "2026-09-12",
      researching: "2026-10-13",
      plan: "2026-10-14",
    },
    plan: {
      summary:
        "One connection to HDN rather than one per lender: four actions, two of which send something, each limited to the HDN addresses it needs. Grasp signs in with a key per adviser firm.",
      questions: [
        "Does the firm have an HDN membership of its own, or does it go through a service provider?",
        "Is there a test environment Grasp may send made-up applications to?",
      ],
    },
    work: {
      session: "sesn_011CLender7hR2",
      branch: "feat/connector-hdn",
      minutes: 36,
      cost: 6.2,
    },
  },
  {
    id: "loket",
    app: "Loket.nl",
    about:
      "Payroll software: employees, their contracts and every month’s payslips.",
    docs: "https://developer.loket.nl",
    auth: "oauth2",
    actions: [
      { name: "Read the employees of an employer", access: "read" },
      { name: "Read a month’s payroll results", access: "read" },
      { name: "Enter hours and allowances for a month", access: "write" },
    ],
    requests: [
      {
        org: "vanrijn",
        workflows: ["Running the payroll"],
        on: "2026-10-02",
        by: "Bart Koster",
      },
    ],
    stage: "credentials",
    reached: {
      requested: "2026-10-02",
      researching: "2026-10-08",
      plan: "2026-10-09",
      credentials: "2026-10-10",
    },
    plan: {
      summary:
        "Three actions, one of which enters something, each limited to the Loket addresses it needs. Grasp signs in once per accountant’s office and reaches the employers it serves.",
      questions: [],
    },
    work: {
      session: "sesn_011CLoket2mK8",
      branch: "feat/connector-loket-nl",
      minutes: 42,
      cost: 7.1,
    },
  },
  {
    id: "transporeon",
    app: "Transporeon",
    about: "The platform carriers book their delivery times at a warehouse in.",
    docs: "https://www.transporeon.com",
    auth: "apiKey",
    actions: [
      { name: "Read the bookings for a day", access: "read" },
      { name: "Book a delivery time", access: "write" },
      { name: "Read where a shipment is", access: "read" },
    ],
    requests: [
      {
        org: "hartog",
        workflows: ["Booking in a delivery"],
        on: "2026-09-30",
        by: "Marco Blom",
      },
    ],
    stage: "review",
    reached: {
      requested: "2026-09-30",
      researching: "2026-10-06",
      plan: "2026-10-07",
      credentials: "2026-10-07",
      writing: "2026-10-09",
      testing: "2026-10-10",
      selfReview: "2026-10-10",
      review: "2026-10-11",
    },
    plan: {
      summary:
        "Three actions, one of which books something, each limited to the Transporeon addresses it needs. A booking that may have gone through is looked up before it is made again.",
      questions: [],
    },
    work: {
      session: "sesn_011CTransp9vB3",
      branch: "feat/connector-transporeon",
      minutes: 188,
      cost: 27.4,
      tests: { passed: 31, total: 31 },
      pr: {
        number: 1931,
        url: "https://github.com/grasplabs/work/pull/1931",
        reviewer: "Jakob",
        checks: [
          { name: "vp check", state: "passed" },
          { name: "vp test", state: "passed" },
          { name: "typegen", state: "passed" },
          { name: "Security review", state: "waiting" },
        ],
      },
    },
  },
  {
    id: "exact-online",
    app: "Exact Online",
    logo: "exact-online.svg",
    about:
      "Bookkeeping and invoicing software: purchase and sales invoices, the ledger and payments.",
    docs: "https://start.exactonline.nl/docs/HlpRestAPIResources.aspx",
    auth: "oauth2",
    actions: [
      { name: "Read purchase invoices", access: "read" },
      { name: "Read purchase orders", access: "read" },
      { name: "Enter a purchase invoice as a draft", access: "write" },
      { name: "Read outstanding sales invoices", access: "read" },
    ],
    requests: [
      {
        org: "noordkade",
        workflows: ["Matching invoices", "Closing the month"],
        on: "2026-09-02",
        by: "Eva de Groot",
      },
      {
        org: "hartog",
        workflows: ["Matching purchase invoices", "Chasing unpaid invoices"],
        on: "2026-09-09",
        by: "Hanneke Prins",
      },
      {
        org: "veldkamp",
        workflows: ["Invoicing work orders"],
        on: "2026-09-24",
        by: "Marjan Vos",
      },
    ],
    stage: "rollout",
    reached: {
      requested: "2026-09-02",
      researching: "2026-09-18",
      plan: "2026-09-19",
      credentials: "2026-09-22",
      writing: "2026-09-23",
      testing: "2026-09-25",
      selfReview: "2026-09-25",
      review: "2026-09-26",
      merged: "2026-10-09",
      rollout: "2026-10-13",
    },
    plan: {
      summary:
        "Four actions, one of which enters a draft a person books, each limited to the Exact Online addresses it needs. Grasp signs in per company and works in the division it chooses.",
      questions: [],
    },
    work: {
      session: "sesn_011CExact3pL7",
      branch: "feat/connector-exact-online",
      minutes: 312,
      cost: 41.8,
      tests: { passed: 46, total: 46 },
      pr: {
        number: 1873,
        url: "https://github.com/grasplabs/work/pull/1873",
        reviewer: "Nick",
        checks: [
          { name: "vp check", state: "passed" },
          { name: "vp test", state: "passed" },
          { name: "typegen", state: "passed" },
          { name: "Security review", state: "passed" },
        ],
      },
      release: "r418-3f9c2ab",
      rollout: [
        { org: "hartog", ring: 0, status: "done", live: "2026-10-14" },
        { org: "noordkade", ring: 1, status: "done", live: "2026-10-14" },
        { org: "veldkamp", ring: 2, status: "pending", live: null },
      ],
    },
  },
  {
    id: "housing-portals",
    app: "Housing association portals",
    about:
      "The portals the housing associations take maintenance reports in, one of their own each.",
    docs: "",
    auth: "none",
    actions: [{ name: "Send a maintenance report", access: "write" }],
    requests: [
      {
        org: "veldkamp",
        workflows: ["Reporting to housing associations"],
        on: "2026-09-29",
        by: "Karin Postma",
      },
    ],
    stage: "declined",
    reached: { requested: "2026-09-29", declined: "2026-10-01" },
    declined:
      "Every association has a portal of its own, and none can be reached from outside. The report comes in as a file the planner uploads.",
  },
];
