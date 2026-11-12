import type { ChatPlanKind } from "@grasp-os/shared/chat";
import { buttonVariants } from "@grasp-os/ui/components/button";
import { Trans } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";

// The one door to something new: "Make something" on the Apps page, the
// Workflows page, a project and Chat's own page opens the normal chat page
// (`/?make=`), with ideas to start from for what is made there (`kind`)
// and the project it goes in. Grasp's agent works out what to make, in
// that chat, and makes nothing until the person says Build it.

/** Make something: an App or a workflow to start from, in `project` when given. */
export const MakeSomethingLink = ({
  kind,
  project,
  size = "default",
}: {
  kind: ChatPlanKind;
  project?: string;
  size?: "default" | "sm";
}) => (
  <Link
    className={buttonVariants({ size })}
    search={project === undefined ? { make: kind } : { make: kind, project }}
    to="/"
  >
    <PlusIcon data-icon="inline-start" />
    <Trans>Make something</Trans>
  </Link>
);
