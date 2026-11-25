import type { CatalogTool } from "@grasp-os/shared/connect";

// Calendly's tools as Composio lists them (docs.composio.dev/toolkits/calendly,
// version 20261120_00, read 2026-11-25), for the permission concepts in
// development only: where core can't list a toolkit's tools here, the
// concepts still show what an admin would see. A tool that gets or lists
// carries Composio's read-only hint, as it does there.

const raw: readonly (readonly [string, string])[] = [
  [
    "CANCEL_SCHEDULED_EVENT",
    "Tool to cancel a scheduled Calendly event by creating a cancellation record. Use when you need to permanently cancel an existing, active event. The cancellation will trigger notifications to all invitees.",
  ],
  [
    "CREATE_EVENT_INVITEE",
    "DEPRECATED: Use CALENDLY_POST_INVITEE instead. Tool to programmatically schedule Calendly meetings without UI redirects. Use when you need to book a meeting on behalf of an invitee via API. Requires a paid Calendly plan.",
  ],
  [
    "CREATE_EVENT_TYPE",
    "Tool to create a new one-on-one event type (kind: solo) in Calendly. Use when you need to programmatically create a new event type for scheduling meetings.",
  ],
  [
    "CREATE_ONE_OFF_EVENT_TYPE",
    "Creates a temporary Calendly one-off event type for a host, with a duration and date setting for the meeting availability.",
  ],
  [
    "CREATE_SCHEDULING_LINK",
    "Create a single-use scheduling link. Creates a scheduling link that can be used to book an event. The link allows invitees to schedule up to the specified maximum number of events. Once the limit is reached, the link becomes inactive.",
  ],
  [
    "CREATE_SHARE",
    "Creates a customizable, one-time share link for a Calendly event type, allowing specific overrides to its settings (e.g., duration, availability, location) without altering the original event type.",
  ],
  [
    "CREATE_SINGLE_USE_SCHEDULING_LINK",
    "Creates a one-time, single-use scheduling link for an active Calendly event type, expiring after one booking.",
  ],
  [
    "CREATE_WEBHOOKS",
    "Tool to create a webhook subscription for receiving Calendly event notifications. Use when you need to set up automated notifications for events like meeting bookings or cancellations.",
  ],
  [
    "DELETE_INVITEE_DATA",
    "Permanently removes all invitee data associated with the provided emails from past organization events, for data privacy compliance (requires Enterprise subscription; deletion may take up to one week).",
  ],
  [
    "DELETE_INVITEE_NO_SHOW",
    "Deletes an Invitee No-Show record by its `uuid` to reverse an invitee's 'no-show' status; the `uuid` must refer to an existing record.",
  ],
  [
    "DELETE_ORGANIZATION_MEMBERSHIP",
    "Tool to remove a user from a Calendly organization by membership UUID. Use when you need to revoke a user's access to an organization. Requires admin rights; organization owners cannot be removed.",
  ],
  [
    "DELETE_SCHEDULED_EVENT_DATA",
    "For Enterprise users, initiates deletion of an organization's scheduled event data between a `start_time` and `end_time`; actual data deletion may take up to 7 days to complete.",
  ],
  [
    "DELETE_WEBHOOK_SUBSCRIPTION",
    "Deletes an existing webhook subscription to stop Calendly sending event notifications to its registered callback URL; this operation is idempotent.",
  ],
  [
    "GET_CURRENT_USER",
    "DEPRECATED: Use CALENDLY_GET_USER instead. Retrieves detailed information about the currently authenticated Calendly user.",
  ],
  [
    "GET_EVENT",
    "Use to retrieve a specific Calendly scheduled event by its UUID, provided the event exists in the user's Calendly account.",
  ],
  [
    "GET_EVENT_INVITEE",
    "Retrieves detailed information about a specific invitee of a scheduled event, using their unique UUIDs.",
  ],
  [
    "GET_EVENT_TYPE",
    "Retrieves details for a specific Calendly event type, identified by its UUID, which must be valid and correspond to an existing event type.",
  ],
  [
    "GET_EVENT_TYPE_AVAILABILITY",
    "Tool to retrieve availability schedules configured for a specific Calendly event type. Use when you need to get the availability rules including day-of-week schedules and date-specific overrides.",
  ],
  [
    "GET_GROUP",
    "Retrieves all attributes of a specific Calendly group by its UUID; the group must exist.",
  ],
  [
    "GET_GROUP_RELATIONSHIP",
    "Retrieves a specific Calendly group relationship by its valid and existing UUID, providing details on user-group associations and membership.",
  ],
  [
    "GET_INVITEE_NO_SHOW",
    "Retrieves details for a specific Invitee No Show record by its UUID; an Invitee No Show is marked when an invitee does not attend a scheduled event.",
  ],
  [
    "GET_ORGANIZATION",
    "Tool to retrieve information about a specific Calendly organization. Use when you need to get organization details such as name, slug, or timestamps.",
  ],
  [
    "GET_ORGANIZATION_INVITATION",
    "Retrieves a specific Calendly organization invitation using its UUID and the parent organization's UUID.",
  ],
  [
    "GET_ORGANIZATION_MEMBERSHIP",
    "Retrieves a specific Calendly organization membership by its UUID, returning all its attributes.",
  ],
  [
    "GET_ROUTING_FORM",
    "Retrieves a specific routing form by its UUID, including its questions and other configuration details.",
  ],
  [
    "GET_ROUTING_FORM_SUBMISSION",
    "Tool to retrieve details about a specific routing form submission by its UUID. Use when you need submission details including questions, answers, and routing results.",
  ],
  [
    "GET_SAMPLE_WEBHOOK_DATA",
    "Tool to retrieve sample webhook payload data for testing webhook subscriptions.",
  ],
  [
    "GET_USER",
    "Retrieves comprehensive details for an existing Calendly user.",
  ],
  [
    "GET_USER_AVAILABILITY_SCHEDULE",
    "Retrieves a user availability schedule by its UUID, including its availability rules and whether it is the user's default schedule.",
  ],
  [
    "GET_WEBHOOK_SUBSCRIPTION",
    "Retrieves the details of an existing webhook subscription, identified by its UUID, including its callback URL, subscribed events, scope, and state.",
  ],
  [
    "INVITEE_NO_SHOW",
    "Tool to mark an invitee as a no-show for a scheduled event. Use when an invitee fails to attend their scheduled meeting and you need to record their absence in Calendly.",
  ],
  [
    "LIST_ACTIVITY_LOG_ENTRIES",
    "Retrieves a list of activity log entries for a specified Calendly organization (requires an active Enterprise subscription), supporting filtering, sorting, and pagination.",
  ],
  [
    "LIST_EVENT_INVITEES",
    "Retrieves a list of invitees for a specified Calendly event UUID, with options to filter by status or email, and sort by creation time.",
  ],
  [
    "LIST_EVENTS",
    "DEPRECATED: Use CALENDLY_LIST_SCHEDULED_EVENTS instead. Retrieves a list of scheduled Calendly events.",
  ],
  [
    "LIST_EVENT_TYPE_AVAILABLE_TIMES",
    "Fetches available time slots for a Calendly event type within a future time range of at most seven days; results are not paginated.",
  ],
  [
    "LIST_EVENT_TYPE_MEMBERSHIPS",
    "Tool to retrieve a list of event type hosts (memberships) for a specific event type.",
  ],
  [
    "LIST_EVENT_TYPES",
    "Lists event types associated with a specified user or organization, with filtering and pagination.",
  ],
  [
    "LIST_GROUP_RELATIONSHIPS",
    "Lists Calendly group relationships, with optional organization, owner, and group filters and pagination.",
  ],
  [
    "LIST_GROUPS",
    "Returns a list of groups for a specified Calendly organization URI, supporting pagination.",
  ],
  [
    "LIST_ORGANIZATION_INVITATIONS",
    "Retrieves a list of invitations for a specific organization, identified by its UUID.",
  ],
  [
    "LIST_ORGANIZATION_MEMBERSHIPS",
    "Retrieves a list of organization memberships.",
  ],
  [
    "LIST_OUTGOING_COMMUNICATIONS",
    "Retrieves a list of outgoing SMS communications for a specified organization; requires an Enterprise subscription.",
  ],
  [
    "LIST_ROUTING_FORMS",
    "Retrieves routing forms for a specified organization; routing forms are questionnaires used to direct invitees to appropriate booking pages or external URLs.",
  ],
  [
    "LIST_ROUTING_FORM_SUBMISSIONS",
    "Lists a page of submissions for a specific routing form, including questions and answers and, when available, routing results and tracking data.",
  ],
  [
    "LIST_SCHEDULED_EVENTS",
    "Tool to retrieve a list of scheduled Calendly events. Use when you need to view events for a specific user, organization, or group.",
  ],
  [
    "LIST_USER_AVAILABILITY_SCHEDULES",
    "Retrieves all availability schedules for the specified Calendly user.",
  ],
  [
    "LIST_USER_BUSY_TIMES",
    "Fetches a user's busy time intervals (internal and external calendar events) in ascending order for a period up to 7 days.",
  ],
  [
    "LIST_USER_LOCATIONS",
    "Tool to retrieve configured meeting location information for a given Calendly user.",
  ],
  [
    "LIST_USER_S_EVENT_TYPES",
    "DEPRECATED: Use CALENDLY_LIST_EVENT_TYPES instead. Retrieves event types for a user or organization.",
  ],
  [
    "LIST_WEBHOOK_SUBSCRIPTIONS",
    "Retrieves webhook subscriptions for a Calendly organization; `scope` determines if `user` or `group` URI is also required for filtering.",
  ],
  [
    "ORGANIZATION_INVITATION",
    "Tool to invite a user to a Calendly organization via email. Use when you need to send an organization invitation to a new user. Requires organization owner or admin privileges.",
  ],
  [
    "POST_INVITEE",
    "Tool to create a new Event Invitee with standard notifications, calendar invites, reschedules, and workflows. Use when programmatically scheduling meetings via API. Requires paid Calendly plan (Standard+).",
  ],
  [
    "REMOVE_USER_FROM_ORGANIZATION",
    "Removes a user (who is not an owner) from an organization by their membership UUID, requiring administrative privileges.",
  ],
  [
    "REVOKE_USER_S_ORGANIZATION_INVITATION",
    "Revokes a pending and revokable (not yet accepted or expired) organization invitation using its UUID and the organization's UUID, rendering the invitation link invalid.",
  ],
  [
    "UPDATE_EVENT_TYPE",
    "Tool to update an existing one-on-one event type (kind: solo) in Calendly. Use when you need to modify event type settings such as name, duration, location, or description.",
  ],
  [
    "UPDATE_EVENT_TYPE_AVAILABILITY",
    "Tool to update an event type availability schedule in Calendly. WARNING: Updating rules will overwrite all existing rules.",
  ],
  [
    "WHO_AM_I",
    "Return the identity (name, email) of the connected Calendly account.",
  ],
];

const reads = /^(?:GET|LIST|WHO)_/u;

/** Calendly's 57 tools, as core would list them. */
export const calendlyTools: CatalogTool[] = raw.map(
  ([action, description]) => ({
    name: `CALENDLY_${action}`,
    description,
    inputs: [],
    readOnly: reads.test(action),
  })
);
