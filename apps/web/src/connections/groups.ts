import type { CatalogGroup } from "@grasp-os/shared/connect";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import {
  ChartLineIcon,
  ClipboardListIcon,
  ContactRoundIcon,
  FolderOpenIcon,
  IdCardIcon,
  ImageIcon,
  LandmarkIcon,
  ListChecksIcon,
  MailIcon,
  MessageCircleQuestionMarkIcon,
  MessagesSquareIcon,
  RocketIcon,
  ShapesIcon,
  SignatureIcon,
  SparklesIcon,
  StoreIcon,
  WrenchIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

// Grasp's kinds of app (`catalogGroups`), as the prototype names and draws
// them (`lib/connections.ts`, `routes/integrations/index.tsx`). The group
// itself stays its English id; this is what a person reads.

/** Each kind of app on screen. */
export const groupLabel: Record<CatalogGroup, MessageDescriptor> = {
  "Email and calendar": msg({
    message: "Email and calendar",
    context: "kind of app",
  }),
  "Files and documents": msg({
    message: "Files and documents",
    context: "kind of app",
  }),
  Chat: msg({ message: "Chat", context: "kind of app" }),
  CRM: msg({ message: "CRM", context: "kind of app" }),
  "Finance and accounting": msg({
    message: "Finance and accounting",
    context: "kind of app",
  }),
  HR: msg({ message: "HR", context: "kind of app" }),
  Signing: msg({ message: "Signing", context: "kind of app" }),
  Marketing: msg({ message: "Marketing", context: "kind of app" }),
  Support: msg({ message: "Support", context: "kind of app" }),
  "Projects and tasks": msg({
    message: "Projects and tasks",
    context: "kind of app",
  }),
  "Forms and surveys": msg({
    message: "Forms and surveys",
    context: "kind of app",
  }),
  "Data and analytics": msg({
    message: "Data and analytics",
    context: "kind of app",
  }),
  AI: msg({ message: "AI", context: "kind of app" }),
  Commerce: msg({ message: "Commerce", context: "kind of app" }),
  "Design and media": msg({
    message: "Design and media",
    context: "kind of app",
  }),
  "Developer tools": msg({
    message: "Developer tools",
    context: "kind of app",
  }),
  Other: msg({ message: "Other", context: "kind of app" }),
};

/** Each kind of app has its icon, so the folded sidebar still says which filter is which. */
export const groupIcon: Record<CatalogGroup, LucideIcon> = {
  "Email and calendar": MailIcon,
  "Files and documents": FolderOpenIcon,
  Chat: MessagesSquareIcon,
  CRM: ContactRoundIcon,
  "Finance and accounting": LandmarkIcon,
  HR: IdCardIcon,
  Signing: SignatureIcon,
  Marketing: RocketIcon,
  Support: MessageCircleQuestionMarkIcon,
  "Projects and tasks": ListChecksIcon,
  "Forms and surveys": ClipboardListIcon,
  "Data and analytics": ChartLineIcon,
  AI: SparklesIcon,
  Commerce: StoreIcon,
  "Design and media": ImageIcon,
  "Developer tools": WrenchIcon,
  Other: ShapesIcon,
};
