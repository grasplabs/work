import { Badge } from "@grasp-os/ui/components/badge";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import {
  CircleCheckIcon,
  CircleHelpIcon,
  EyeIcon,
  FileTextIcon,
  GitCompareArrowsIcon,
  GlobeIcon,
  KeyRoundIcon,
  LockKeyholeIcon,
  PackageIcon,
  PencilLineIcon,
  RocketIcon,
  ShieldCheckIcon,
  SparklesIcon,
  SplitIcon,
  TimerIcon,
  TriangleAlertIcon,
  WorkflowIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { AppLogo } from "../connections/app-logo.tsx";
import { ItemMark as DashboardMark } from "../dashboard/dashboard-card.tsx";
import type { InboxItem, InboxKind } from "./items.ts";

// The marks of the inbox's items, as the prototype draws them
// (`components/inbox-kind.tsx`): what each kind is called, its icon, a
// square for what an item is about, and its kind as a small label.

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
  openQuestion: msg({ message: "Open question", context: "inbox item kind" }),
  reviewPolicy: msg({ message: "Policy", context: "inbox item kind" }),
  watchingRule: msg({ message: "Rule", context: "inbox item kind" }),
  exceptionEnding: msg({ message: "Exception", context: "inbox item kind" }),
  unknownAiTool: msg({ message: "AI tool", context: "inbox item kind" }),
  signInAgain: msg({ message: "Connection", context: "inbox item kind" }),
  externalDomain: msg({ message: "Domain", context: "inbox item kind" }),
  heldWrite: msg({ message: "Change", context: "inbox item kind" }),
  permissionRequest: msg({ message: "Permission", context: "inbox item kind" }),
  packages: msg({ message: "Packages", context: "inbox item kind" }),
  appApproval: msg({ message: "App approval", context: "inbox item kind" }),
  failedRun: msg({ message: "Failed run", context: "inbox item kind" }),
};

export const kindIcon: Record<InboxKind, LucideIcon> = {
  checkDrawing: WorkflowIcon,
  checkProposal: GitCompareArrowsIcon,
  goLive: RocketIcon,
  approveChange: PencilLineIcon,
  confirmResult: CircleCheckIcon,
  conflict: SplitIcon,
  openQuestion: CircleHelpIcon,
  reviewPolicy: FileTextIcon,
  watchingRule: EyeIcon,
  exceptionEnding: TimerIcon,
  unknownAiTool: SparklesIcon,
  signInAgain: KeyRoundIcon,
  externalDomain: GlobeIcon,
  heldWrite: PencilLineIcon,
  permissionRequest: LockKeyholeIcon,
  packages: PackageIcon,
  appApproval: ShieldCheckIcon,
  failedRun: TriangleAlertIcon,
};

/** What an item is about, as a square: the app's tile, or the icon of its kind (the dashboard's mark). */
export const ItemMark = ({ item }: { item: InboxItem }) =>
  item.logo === undefined ? (
    <DashboardMark icon={kindIcon[item.kind]} />
  ) : (
    <AppLogo name={item.logo.name} size="sm" />
  );

/** The kind of an item, as a small label with its icon. */
export const KindPill = ({ kind }: { kind: InboxKind }) => {
  const { i18n } = useLingui();
  const Icon = kindIcon[kind];
  return (
    <Badge className="flex-none" variant="outline">
      <Icon data-icon="inline-start" />
      {i18n._(kindLabel[kind])}
    </Badge>
  );
};
