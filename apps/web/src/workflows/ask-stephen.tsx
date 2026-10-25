import { Label } from "@grasp-os/ui/components/label";
import { Switch } from "@grasp-os/ui/components/switch";
import { Trans } from "@lingui/react/macro";
import { useId, useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";

// Whether people may ask Stephen to start a workflow in their chat app
// (core's channels/workflow-offers.ts): for its owner only, off until
// they turn it on. He offers it on a card to anyone who could start it
// themselves, and it starts, as them, only when they press Start.

/** The owner's switch for letting people ask Stephen to start `workflow`. */
export const AskStephen = ({
  workflow,
  askable,
}: {
  workflow: string;
  askable: boolean;
}) => {
  const id = useId();
  const [on, setOn] = useState(askable);
  const { busy, failure, run } = useCoreAction();
  const change = async (next: boolean) => {
    const done = await run(async (session) => {
      await session.workflowResources.setAskable(workflow, next);
      return true;
    });
    if (done === true) {
      setOn(next);
    }
  };
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Switch
          checked={on}
          disabled={busy}
          id={id}
          onCheckedChange={(next) => {
            void change(next);
          }}
        />
        <Label htmlFor={id}>
          <Trans>Let people ask Stephen to start it</Trans>
        </Label>
      </div>
      <p className="text-muted-foreground">
        <Trans>
          Stephen can offer it in Microsoft Teams to anyone who may start it. It
          starts only when they press Start, and runs as them.
        </Trans>
      </p>
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};
