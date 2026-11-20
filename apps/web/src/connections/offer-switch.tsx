import { useLingui } from "@lingui/react/macro";

import {
  Field,
  FieldLabel,
  FieldDescription,
  FieldContent,
} from "../grasp/field/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { Switch } from "../grasp/switch/index.ts";
import { SettingsRows, SwitchRow } from "../settings/section.tsx";
import type { Integration } from "./integrations.ts";
import { useChange } from "./use-change.ts";

/**
 * An admin's switch for whether people are offered `integration`: nobody
 * starts connecting one that isn't, admins included, while connections
 * already made go on. Grasp staff see it, but core leaves the choice to the
 * client's own admins.
 */
export const OfferSwitch = ({
  integration,
  staff,
}: {
  integration: Integration;
  staff: boolean;
}) => {
  const { change } = useChange();
  const { t } = useLingui();
  return (
    // No title: the switch's label says it, and a title would repeat it.
    <SectionCard aria-label={t`Offered`} density="compact" flush>
      <SettingsRows>
        <SwitchRow>
          <Field orientation="horizontal" disabled={staff}>
            <FieldContent>
              <FieldLabel>{t`Offered to your organization`}</FieldLabel>
              <FieldDescription>{t`Off, nobody can connect it, admins included. Connections already made go on.`}</FieldDescription>
            </FieldContent>
            <Switch
              checked={integration.offered}
              failedLabel={t`Couldn't save`}
              onSave={async (offered) => {
                let saved = false;
                await change(async (session) => {
                  await session.connections.setOffered(
                    integration.source,
                    integration.id,
                    offered
                  );
                  saved = true;
                });
                if (!saved) {
                  throw new Error("Not saved");
                }
              }}
            />
          </Field>
        </SwitchRow>
      </SettingsRows>
    </SectionCard>
  );
};
