import {
  BellIcon,
  CalendarIcon,
  CircleCheckIcon,
  GitCompareIcon,
  GlobeIcon,
  ListChecksIcon,
  LockIcon,
  MailIcon,
  MessageCircleIcon,
  PencilIcon,
  PlayIcon,
  TriangleAlertIcon,
  UserSparklesIcon,
  WorkflowIcon,
  ZapIcon,
} from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import type { InboxKind } from "./items.ts";

// The marks of the inbox's items: what each kind is called, and its icon
// from Damsko's set.

/** What each kind of item that waits on a person is called, in the inbox. */
export const kindLabel: Record<InboxKind, MessageDescriptor> = {
  checkDrawing: msg({
    message: "Check a workflow",
    context: "inbox item kind",
  }),
  checkProposal: msg({
    message: "Check a proposal",
    context: "inbox item kind",
  }),
  approveChange: msg({ message: "Change", context: "inbox item kind" }),
  confirmResult: msg({ message: "Result", context: "inbox item kind" }),
  conflict: msg({
    message: "Two answers",
    context: "inbox item kind: two sources disagree",
  }),
  openQuestion: msg({ message: "Asked of you", context: "inbox item kind" }),
  unknownAiTool: msg({ message: "AI tool", context: "inbox item kind" }),
  signInAgain: msg({ message: "Connection", context: "inbox item kind" }),
  externalDomain: msg({ message: "Domain", context: "inbox item kind" }),
  heldWrite: msg({ message: "Change", context: "inbox item kind" }),
  heldStart: msg({ message: "Workflow start", context: "inbox item kind" }),
  unknownOutcome: msg({
    message: "Unconfirmed change",
    context: "inbox item kind",
  }),
  permissionRequest: msg({ message: "Permission", context: "inbox item kind" }),
  stoppedSchedule: msg({
    message: "Stopped schedule",
    context: "inbox item kind",
  }),
  workflowChanged: msg({
    message: "Workflow changed",
    context:
      "inbox item kind: another version of a workflow the person's triggers start went live",
  }),
  packageNotice: msg({
    message: "Packages",
    context: "inbox item kind: what a scan found of approved packages",
  }),
  stoppedEvents: msg({
    message: "Not hearing",
    context: "inbox item kind: a mailbox or drive connect stopped hearing",
  }),
  appMessage: msg({
    message: "From an App",
    context: "inbox item kind: something an App told the person",
  }),
  bindingApproval: msg({
    message: "Bindings",
    context:
      "inbox item kind: what a workflow reaches, for an admin to approve",
  }),
  skillShare: msg({
    message: "Skill",
    context: "inbox item kind: a skill someone asked to share with the company",
  }),
  decision: msg({ message: "Decision", context: "inbox item kind" }),
};

/**
 * Each kind's icon from Damsko's set, for the list's rows. Where the set
 * has no exact one (a question mark, a key, a scale, a shield), the
 * nearest that says the same.
 */
export const kindMark: Record<InboxKind, IconData> = {
  checkDrawing: WorkflowIcon,
  checkProposal: GitCompareIcon,
  approveChange: PencilIcon,
  confirmResult: CircleCheckIcon,
  conflict: GitCompareIcon,
  openQuestion: MessageCircleIcon,
  unknownAiTool: UserSparklesIcon,
  signInAgain: LockIcon,
  externalDomain: GlobeIcon,
  heldWrite: PencilIcon,
  heldStart: PlayIcon,
  unknownOutcome: MessageCircleIcon,
  permissionRequest: LockIcon,
  stoppedSchedule: CalendarIcon,
  workflowChanged: GitCompareIcon,
  packageNotice: TriangleAlertIcon,
  stoppedEvents: MailIcon,
  appMessage: BellIcon,
  bindingApproval: LockIcon,
  skillShare: ZapIcon,
  decision: ListChecksIcon,
};
