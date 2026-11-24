import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import type { Group } from "./items.ts";

// The inbox's groups on their own, for its filter and its address
// (`?group=`), which the route reads before the page loads.

/** The groups, short enough that the filter fits over the list. */
export const groupLabel: Record<Group, MessageDescriptor> = {
  all: msg({ message: "All", context: "inbox filter, short" }),
  asked: msg({ message: "Asked of you", context: "inbox filter" }),
  brain: msg({ message: "Brain", context: "inbox filter, short" }),
  approvals: msg({ message: "Approvals", context: "inbox filter" }),
};

/** The groups in the filter's order; the address (`?group=`) takes these. */
export const groupOrder = ["asked", "brain", "approvals"] as const;
