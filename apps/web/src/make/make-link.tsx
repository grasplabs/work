import type { ChatPlanKind } from "@grasp-os/shared/chat";
import { useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";

import { Button } from "../grasp/button/index.ts";
import { Plus } from "../grasp/icons/index.ts";

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
}) => {
  const { t } = useLingui();
  return (
    <Button
      icon={Plus}
      render={
        <Link
          search={
            project === undefined ? { make: kind } : { make: kind, project }
          }
          to="/"
        />
      }
      size={size === "sm" ? "sm" : "md"}
    >
      {t`Make something`}
    </Button>
  );
};
