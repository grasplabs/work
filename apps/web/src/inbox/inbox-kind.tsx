import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import {
  Agent,
  Alert,
  Bell,
  CalendarIcon,
  Checklist,
  Done,
  Edit,
  Lock,
  Mail,
  People,
  Play,
  Question,
  Swap,
  Upload,
  Web,
  Workflow,
} from "../grasp/icons/index.ts";
import type { IconData } from "../grasp/icons/index.ts";
import type { InboxKind } from "./items.ts";

// The marks of the inbox's items: what each kind is called, and its icon
// from Grasp UI's set.

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
  goLive: msg({ message: "Go live", context: "inbox item kind" }),
  approveChange: msg({ message: "Change", context: "inbox item kind" }),
  confirmResult: msg({ message: "Result", context: "inbox item kind" }),
  conflict: msg({
    message: "Two answers",
    context: "inbox item kind: two sources disagree",
  }),
  openQuestion: msg({ message: "Asked of you", context: "inbox item kind" }),
  brainQuestion: msg({ message: "Brain question", context: "inbox item kind" }),
  interviews: msg({ message: "Interviews", context: "inbox item kind" }),
  everyonesOutcome: msg({
    message: "Unknown outcome",
    context: "inbox item kind",
  }),
  unknownAiTool: msg({ message: "AI tool", context: "inbox item kind" }),
  signInAgain: msg({ message: "Connection", context: "inbox item kind" }),
  externalDomain: msg({ message: "Domain", context: "inbox item kind" }),
  heldWrite: msg({ message: "Change", context: "inbox item kind" }),
  heldStart: msg({ message: "Workflow start", context: "inbox item kind" }),
  unknownOutcome: msg({
    message: "Did it happen?",
    context: "inbox item kind: a change whose answer was lost",
  }),
  permissionRequest: msg({ message: "Permission", context: "inbox item kind" }),
  stoppedSchedule: msg({
    message: "Stopped schedule",
    context: "inbox item kind",
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
  decision: msg({ message: "Decision", context: "inbox item kind" }),
};

/**
 * Each kind's icon from Grasp UI's set, for rows drawn with its Item and
 * the sidebar's Inbox view. Where the set has no exact one (a rocket, a
 * key, a scale, sparkles, a shield), the nearest that says the same.
 */
export const kindMark: Record<InboxKind, IconData> = {
  checkDrawing: Workflow,
  checkProposal: Swap,
  goLive: Upload,
  approveChange: Edit,
  confirmResult: Done,
  conflict: Swap,
  openQuestion: Question,
  brainQuestion: Question,
  interviews: People,
  everyonesOutcome: Question,
  unknownAiTool: Agent,
  signInAgain: Lock,
  externalDomain: Web,
  heldWrite: Edit,
  heldStart: Play,
  unknownOutcome: Question,
  permissionRequest: Lock,
  stoppedSchedule: CalendarIcon,
  packageNotice: Alert,
  stoppedEvents: Mail,
  appMessage: Bell,
  bindingApproval: Lock,
  decision: Checklist,
};
