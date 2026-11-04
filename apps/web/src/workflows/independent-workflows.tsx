import { Button } from "@grasp-os/ui/components/button";
import { Trans } from "@lingui/react/macro";
import { PlusIcon } from "lucide-react";

import { ErrorText } from "../error-text.tsx";
import { useNewWorkflow } from "./new-workflow.ts";

// A new independent workflow (platform specification 13), for those who
// build: the page's action, in the bar above it. As the prototype's New
// workflow, it goes straight to the new workflow's page, its Flow empty
// and Grasp's chat docked open beside it (new-workflow.ts).

/**
 * The page's one action, in the bar above it as the prototype has it: a
 * new workflow, opened on its Flow with Grasp's chat beside it.
 */
export const NewWorkflow = () => {
  const { busy, failure, make } = useNewWorkflow();
  return (
    <span className="flex items-center gap-2">
      <ErrorText>{failure}</ErrorText>
      <Button
        disabled={busy}
        onClick={() => {
          void make("");
        }}
        size="sm"
      >
        <PlusIcon data-icon="inline-start" />
        <Trans>New workflow</Trans>
      </Button>
    </span>
  );
};
