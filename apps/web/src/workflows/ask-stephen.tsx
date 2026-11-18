import { useLingui } from "@lingui/react/macro";
import { useState } from "react";

import { SettingRow, SettingsRows } from "../grasp/setting-row/index.ts";
import { Switch } from "../grasp/switch/index.ts";
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
  const { t } = useLingui();
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
  const label = t`Let people ask Stephen to start it`;
  return (
    <SettingsRows>
      <SettingRow
        info={t`Stephen can offer it in Microsoft Teams to anyone who may start it. It starts only when they press Start, and runs as them.`}
        label={label}
        status={busy ? "saving" : "idle"}
        {...(failure === undefined ? {} : { error: failure })}
      >
        {(field) => (
          <Switch
            checked={on}
            disabled={busy}
            id={field.id}
            label={label}
            labelHidden
            onCheckedChange={(next) => {
              void change(next);
            }}
          />
        )}
      </SettingRow>
    </SettingsRows>
  );
};
