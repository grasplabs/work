import { Button } from "@grasp-os/ui/components/button";
import { Trans } from "@lingui/react/macro";
import { useNavigate } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";

import { setActiveChat } from "../chat/active-chat.ts";
import { setDockMode } from "../chat/dock-mode.ts";
import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";

// A new independent workflow (platform specification 13), for those who
// build: the page's action, in the bar above it. As the prototype's New
// workflow, it goes straight to the new workflow's page, its Flow empty
// and Grasp's chat docked open beside it, asking how the work runs
// (draw-in-chat.ts). Core decides who may create one and which names are
// free: a name is the workflow's for good, so a new one takes a name
// nobody had, made here.

/** The name of a new workflow: one nobody had, as core's names go. */
const newName = (): string => `new-workflow-${crypto.randomUUID().slice(0, 8)}`;

/**
 * The page's one action, in the bar above it as the prototype has it: a
 * new workflow, opened on its Flow with Grasp's chat beside it.
 */
export const NewWorkflow = () => {
  const navigate = useNavigate();
  const { busy, failure, run } = useCoreAction();
  const create = async (): Promise<void> => {
    const created = await run(
      async (session) => await session.workflowResources.create(newName())
    );
    if (created === undefined) {
      return;
    }
    // A new chat, the person's like any other, docked open down the right
    // beside the Flow it draws: the next question there starts it.
    setActiveChat(undefined);
    setDockMode("drawer");
    await navigate({
      to: "/workflows/$workflow",
      params: { workflow: created.id },
    });
  };
  return (
    <span className="flex items-center gap-2">
      <ErrorText>{failure}</ErrorText>
      <Button
        disabled={busy}
        onClick={() => {
          void create();
        }}
        size="sm"
      >
        <PlusIcon data-icon="inline-start" />
        <Trans>New workflow</Trans>
      </Button>
    </span>
  );
};
