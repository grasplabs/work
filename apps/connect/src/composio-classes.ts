import type { ToolClass } from "@grasp-os/shared/connect";

// The class of each Composio tool Grasp reviewed, by toolkit slug and tool
// name, as this release ships it: given once, for every company. Composio
// changes a toolkit without a release of ours, and its own hints
// (`readOnlyHint` and the like) are best-effort, so they may suggest a
// class in a review but never set one. A tool nobody classed is never
// offered and never run, whatever an admin allowed (connections.ts), and
// one classed `never` is a tool reviewed and turned down.
//
// A toolkit's table is the input to its review page, kept outside the
// repo; a toolkit comes in here once its review is done. Connect reads it
// as `#composio-classes` (package.json), so its tests and core's can class
// the tools of their fake Composio instead (test/fixtures/composio-classes.ts).

/** Each reviewed tool's class, by toolkit, then by the tool's name. */
export type ComposioClasses = Readonly<
  Record<string, Readonly<Record<string, ToolClass>>>
>;

// Reviewed toolkits: the CRMs a pilot may run on, any of which an admin
// connects (which one is the client's choice, not a release's). Each
// reads the company's records (`read-company`), and changes only the
// status of a record, its notes and its tasks (`change-company`), held
// for a card in chat. Left out on purpose, so never offered: creating or
// merging records, anything about mail, workflows, marketing, imports,
// schemas, owners' accounts or the app's own setup, queries in the app's
// own language (SOQL), and tools that act on a sentence (`*_FROM_NL`).
export const composioClasses: ComposioClasses = {
  hubspot: {
    HUBSPOT_GET_COMPANY: "read-company",
    HUBSPOT_GET_CONTACTS: "read-company",
    HUBSPOT_GET_DEAL: "read-company",
    HUBSPOT_GET_DEALS: "read-company",
    HUBSPOT_GET_ENGAGEMENT: "read-company",
    HUBSPOT_GET_PIPELINE_BY_ID: "read-company",
    HUBSPOT_GET_PRODUCT: "read-company",
    HUBSPOT_GET_PRODUCTS: "read-company",
    HUBSPOT_GET_QUOTE: "read-company",
    HUBSPOT_GET_TICKET: "read-company",
    HUBSPOT_GET_TICKETS: "read-company",
    HUBSPOT_LIST_ASSOCIATED_ENGAGEMENTS: "read-company",
    HUBSPOT_LIST_COMPANIES: "read-company",
    HUBSPOT_LIST_COMPANY_ACTIVITIES: "read-company",
    HUBSPOT_LIST_CONTACTS: "read-company",
    HUBSPOT_LIST_CONTACT_NOTES: "read-company",
    HUBSPOT_LIST_CONTACT_TASKS: "read-company",
    HUBSPOT_LIST_DEALS: "read-company",
    HUBSPOT_LIST_DEAL_ACTIVITIES: "read-company",
    HUBSPOT_LIST_OBJECT_ASSOCIATIONS: "read-company",
    HUBSPOT_LIST_PRODUCTS: "read-company",
    HUBSPOT_LIST_QUOTES: "read-company",
    HUBSPOT_LIST_TICKETS: "read-company",
    HUBSPOT_READ_CONTACT: "read-company",
    HUBSPOT_READ_CRM_OBJECT_BY_ID: "read-company",
    HUBSPOT_RETRIEVE_ALL_PIPELINES_FOR_SPECIFIED_OBJECT_TYPE: "read-company",
    HUBSPOT_RETRIEVE_OWNERS: "read-company",
    HUBSPOT_RETRIEVE_PIPELINE_STAGES: "read-company",
    HUBSPOT_SEARCH_COMPANIES: "read-company",
    HUBSPOT_SEARCH_CONTACTS: "read-company",
    HUBSPOT_SEARCH_DEALS: "read-company",
    HUBSPOT_SEARCH_PRODUCTS: "read-company",
    HUBSPOT_SEARCH_TICKETS: "read-company",
    HUBSPOT_CREATE_NOTE: "change-company",
    HUBSPOT_CREATE_TASK: "change-company",
    HUBSPOT_UPDATE_COMPANY: "change-company",
    HUBSPOT_UPDATE_DEAL: "change-company",
    HUBSPOT_UPDATE_TICKET: "change-company",
  },
  salesforce: {
    SALESFORCE_GET_ACCOUNT: "read-company",
    SALESFORCE_GET_CONTACT: "read-company",
    SALESFORCE_GET_CONTACT_BY_ID: "read-company",
    SALESFORCE_GET_LEAD: "read-company",
    SALESFORCE_GET_NOTE: "read-company",
    SALESFORCE_GET_OPPORTUNITY: "read-company",
    SALESFORCE_LIST_ACCOUNTS: "read-company",
    SALESFORCE_LIST_CONTACTS: "read-company",
    SALESFORCE_LIST_LEADS: "read-company",
    SALESFORCE_LIST_NOTES: "read-company",
    SALESFORCE_LIST_OPPORTUNITIES: "read-company",
    SALESFORCE_SEARCH_ACCOUNTS: "read-company",
    SALESFORCE_SEARCH_CONTACTS: "read-company",
    SALESFORCE_SEARCH_LEADS: "read-company",
    SALESFORCE_SEARCH_NOTES: "read-company",
    SALESFORCE_SEARCH_OPPORTUNITIES: "read-company",
    SALESFORCE_SEARCH_TASKS: "read-company",
    SALESFORCE_COMPLETE_TASK: "change-company",
    SALESFORCE_CREATE_NOTE: "change-company",
    SALESFORCE_CREATE_TASK: "change-company",
    SALESFORCE_UPDATE_ACCOUNT: "change-company",
    SALESFORCE_UPDATE_LEAD: "change-company",
    SALESFORCE_UPDATE_NOTE: "change-company",
    SALESFORCE_UPDATE_OPPORTUNITY: "change-company",
    SALESFORCE_UPDATE_TASK: "change-company",
  },
  pipedrive: {
    PIPEDRIVE_GET_ACTIVITY: "read-company",
    PIPEDRIVE_GET_DEAL: "read-company",
    PIPEDRIVE_GET_DEALS_IN_A_PIPELINE: "read-company",
    PIPEDRIVE_GET_DEALS_IN_A_STAGE: "read-company",
    PIPEDRIVE_GET_DEAL_ACTIVITIES: "read-company",
    PIPEDRIVE_GET_DEAL_FILES: "read-company",
    PIPEDRIVE_GET_NOTE: "read-company",
    PIPEDRIVE_GET_ORGANIZATION: "read-company",
    PIPEDRIVE_GET_ORGANIZATION_DEALS: "read-company",
    PIPEDRIVE_GET_ORGANIZATION_PERSONS: "read-company",
    PIPEDRIVE_GET_PERSON: "read-company",
    PIPEDRIVE_GET_PERSON_DEALS: "read-company",
    PIPEDRIVE_GET_PIPELINE: "read-company",
    PIPEDRIVE_GET_STAGE: "read-company",
    PIPEDRIVE_LIST_ACTIVITIES: "read-company",
    PIPEDRIVE_LIST_DEALS: "read-company",
    PIPEDRIVE_LIST_DEAL_ACTIVITIES: "read-company",
    PIPEDRIVE_LIST_DEAL_FILES: "read-company",
    PIPEDRIVE_LIST_DEAL_PERSONS: "read-company",
    PIPEDRIVE_LIST_ORGANIZATION_DEALS: "read-company",
    PIPEDRIVE_LIST_ORGANIZATION_PERSONS: "read-company",
    PIPEDRIVE_LIST_PERSONS: "read-company",
    PIPEDRIVE_LIST_PERSON_DEALS: "read-company",
    PIPEDRIVE_SEARCH_DEALS: "read-company",
    PIPEDRIVE_SEARCH_LEADS: "read-company",
    PIPEDRIVE_SEARCH_ORGANIZATIONS: "read-company",
    PIPEDRIVE_SEARCH_PERSONS: "read-company",
    PIPEDRIVE_ADD_AN_ACTIVITY: "change-company",
    PIPEDRIVE_ADD_NOTE: "change-company",
    PIPEDRIVE_UPDATE_ACTIVITY: "change-company",
    PIPEDRIVE_UPDATE_DEAL: "change-company",
    PIPEDRIVE_UPDATE_NOTE: "change-company",
  },
};
