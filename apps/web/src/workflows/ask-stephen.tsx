import {
  Field,
  FieldContent,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldStatus,
} from "@grasp-os/ui/components/field";
import { Switch } from "@grasp-os/ui/components/switch";
import { useLingui } from "@lingui/react/macro";
import { useState } from "react";

import { WithInfo } from "../frame/info-tip.tsx";
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
  return (
    <FieldGroup>
      <Field
        orientation="responsive"
        {...(failure === undefined ? {} : { "data-invalid": true })}
      >
        <FieldContent>
          <WithInfo
            info={t`Stephen can offer it in Microsoft Teams to anyone who may start it. It starts only when they press Start, and runs as them.`}
            label={t`More about this setting`}
          >
            <FieldLabel>{t`Let people ask Stephen to start it`}</FieldLabel>
          </WithInfo>
          {failure === undefined ? null : <FieldError>{failure}</FieldError>}
        </FieldContent>
        <Switch
          checked={on}
          disabled={busy}
          onCheckedChange={(next) => {
            void change(next);
          }}
        />
        <FieldStatus status={busy ? "loading" : "idle"} />
      </Field>
    </FieldGroup>
  );
};
