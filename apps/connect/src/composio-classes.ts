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

// Reviewed toolkits. First the CRMs a pilot may run on, any of which an
// admin connects (which one is the client's choice, not a release's). Each
// reads the company's records (`read-company`), and changes only the
// status of a record, its notes and its tasks (`change-company`), held
// for a card in chat. Left out on purpose, so never offered: creating or
// merging records, anything about mail, workflows, marketing, imports,
// schemas, owners' accounts or the app's own setup, queries in the app's
// own language (SOQL), and tools that act on a sentence (`*_FROM_NL`).
// Then the other company apps people spend time in, each as its comment
// says, left out as the CRMs' are.
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
  // A ticket queue: its issues, comments and work logs; changes file,
  // move, assign and comment on issues. Not JQL, not projects' setup.
  jira: {
    JIRA_ADD_COMMENT: "change-company",
    JIRA_ADD_WORKLOG: "change-company",
    JIRA_ASSIGN_ISSUE: "change-company",
    JIRA_CREATE_ISSUE: "change-company",
    JIRA_EDIT_ISSUE: "change-company",
    JIRA_GET_ALL_PROJECTS: "read-company",
    JIRA_GET_ALL_STATUSES: "read-company",
    JIRA_GET_ATTACHMENT_META: "read-company",
    JIRA_GET_COMMENT: "read-company",
    JIRA_GET_COMPONENTS: "read-company",
    JIRA_GET_ISSUE: "read-company",
    JIRA_GET_ISSUE_TYPES: "read-company",
    JIRA_GET_ISSUE_WORKLOGS: "read-company",
    JIRA_GET_PROJECT: "read-company",
    JIRA_GET_PROJECT_VERSIONS: "read-company",
    JIRA_GET_SPRINT: "read-company",
    JIRA_GET_TRANSITIONS: "read-company",
    JIRA_LIST_ALL_PROJECTS: "read-company",
    JIRA_LIST_BOARDS: "read-company",
    JIRA_LIST_ISSUE_COMMENTS: "read-company",
    JIRA_LIST_SPRINTS: "read-company",
    JIRA_SEARCH_ISSUES: "read-company",
    JIRA_TRANSITION_ISSUE: "change-company",
    JIRA_UPDATE_COMMENT: "change-company",
  },
  // A ticket queue. Reaches others: a reply, and an update, whose input
  // can carry a public comment Zendesk emails the requester.
  zendesk: {
    ZENDESK_GET_RECENT_TICKETS: "read-company",
    ZENDESK_GET_TICKET_COMMENTS: "read-company",
    ZENDESK_GET_VIEWS: "read-company",
    ZENDESK_GET_VIEWS_TICKETS: "read-company",
    ZENDESK_GET_ZENDESK_TICKETS_TAGS: "read-company",
    ZENDESK_GET_ZENDESK_TICKET_BY_ID: "read-company",
    ZENDESK_LIST_ZENDESK_TICKETS: "read-company",
    ZENDESK_REPLY_ZENDESK_TICKET: "reach-others",
    ZENDESK_SEARCH_HELP_CENTER_ARTICLES: "read-company",
    ZENDESK_SEARCH_ZENDESK: "read-company",
    ZENDESK_UPDATE_TICKETS_TAGS: "change-company",
    ZENDESK_UPDATE_ZENDESK_TICKET: "reach-others",
  },
  // A ticket queue. Reaches others: a reply, and a note, whose input can
  // name people Freshdesk emails.
  freshdesk: {
    FRESHDESK_ADD_NOTE_TO_TICKET: "reach-others",
    FRESHDESK_GET_SEARCH: "read-company",
    FRESHDESK_GET_TICKETS: "read-company",
    FRESHDESK_LIST_ALL_TICKET_CONVERSATIONS: "read-company",
    FRESHDESK_REPLY_TO_TICKET: "reach-others",
    FRESHDESK_SEARCH_COMPANIES: "read-company",
    FRESHDESK_SEARCH_CONTACTS: "read-company",
    FRESHDESK_SEARCH_SOLUTION_ARTICLES: "read-company",
    FRESHDESK_UPDATE_TICKET: "change-company",
    FRESHDESK_VIEW_TICKET: "read-company",
  },
  // Signing: reads an envelope's status and history; sending one, or
  // making one from a template (which can send it), reaches its signers.
  docusign: {
    DOCUSIGN_CREATE_ENVELOPE_FROM_TEMPLATE: "reach-others",
    DOCUSIGN_GET_ENVELOPE: "read-company",
    DOCUSIGN_GET_TEMPLATE: "read-company",
    DOCUSIGN_LIST_ALL_TEMPLATES: "read-company",
    DOCUSIGN_RETRIEVE_ENVELOPE_AUDIT_EVENTS: "read-company",
    DOCUSIGN_SEND_ENVELOPE: "reach-others",
  },
  // Phones: calls, their contacts and who is free; comments, tags and
  // contacts change. Never starting a call: it rings someone.
  aircall: {
    AIRCALL_COMMENT_CALL: "change-company",
    AIRCALL_GET_CALL: "read-company",
    AIRCALL_GET_CONTACT: "read-company",
    AIRCALL_GET_USER_AVAILABILITY: "read-company",
    AIRCALL_LIST_CALLS: "read-company",
    AIRCALL_LIST_CONTACTS: "read-company",
    AIRCALL_LIST_TEAMS: "read-company",
    AIRCALL_LIST_USERS_AVAILABILITY: "read-company",
    AIRCALL_SEARCH_CALLS: "read-company",
    AIRCALL_SEARCH_CONTACTS: "read-company",
    AIRCALL_TAG_CALL: "change-company",
    AIRCALL_UPDATE_CONTACT: "change-company",
  },
  // HR: the company's lookup tables only. No person's record, files,
  // pay, benefits or time off: their data is too sensitive for a review
  // by name alone.
  bamboohr: {
    BAMBOOHR_GET_JOB_SUMMARIES: "read-company",
    BAMBOOHR_GET_META_DEPARTMENTS: "read-company",
    BAMBOOHR_GET_META_DIVISIONS: "read-company",
    BAMBOOHR_GET_META_JOB_TITLES: "read-company",
    BAMBOOHR_GET_META_LOCATIONS: "read-company",
    BAMBOOHR_GET_META_TIME_OFF_TYPES: "read-company",
    BAMBOOHR_GET_TIME_OFF_POLICIES: "read-company",
  },
  // HR, as BambooHR: lookup tables only.
  personio: {
    PERSONIO_LIST_ABSENCE_TYPES: "read-company",
    PERSONIO_LIST_DOCUMENT_CATEGORIES: "read-company",
    PERSONIO_LIST_PROJECTS: "read-company",
  },
};
