import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import type { Group } from "./items.ts";

// The inbox's groups on their own, for the sidebar's Inbox view and the
// Inbox's address, which come with the app: inbox-page.tsx is the page's.

/**
 * The groups, short enough that the filter fits beside the list. The
 * sidebar's Inbox view names its rows by these too.
 */
export const groupLabel: Record<Group, MessageDescriptor> = {
  all: msg({ message: "All", context: "inbox filter, short" }),
  asked: msg({ message: "Asked of you", context: "inbox filter" }),
  brain: msg({ message: "Brain", context: "inbox filter, short" }),
  approvals: msg({ message: "Approvals", context: "inbox filter" }),
  outcomes: msg({
    message: "Changes we couldn’t confirm",
    context: "inbox filter",
  }),
};

/** The groups in the filter's order; the address (`?group=`) takes these. */
// Workflows' and Apps' asks are one group, Approvals (Ruben, 17 November).
export const groupOrder = ["asked", "brain", "approvals", "outcomes"] as const;
