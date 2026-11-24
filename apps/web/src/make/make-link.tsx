import type { ChatPlanKind } from "@grasp-os/shared/chat";
import { Button } from "@grasp-os/ui/components/button";
import { Icon, PlusIcon } from "@grasp-os/ui/lib/icons";
import { Trans } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";

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
  variant = "default",
}: {
  kind: ChatPlanKind;
  project?: string;
  size?: "default" | "sm";
  /** Outline beside the page's other actions, where it isn't the page's one main action. */
  variant?: "default" | "outline";
}) => (
  <Button asChild size={size} variant={variant}>
    <Link
      search={project === undefined ? { make: kind } : { make: kind, project }}
      to="/"
    >
      <Icon icon={PlusIcon} />
      <Trans>Make something</Trans>
    </Link>
  </Button>
);
