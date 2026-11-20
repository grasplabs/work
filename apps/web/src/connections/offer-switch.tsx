import { useLingui } from "@lingui/react/macro";

import { SectionCard } from "../grasp/section-card/index.ts";
import { SettingRow, SettingsRows } from "../grasp/setting-row/index.ts";
import { Switch } from "../grasp/switch/index.ts";
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
        {/* The library's setting row: its name and what off means, the switch on the rows' edge. */}
        <SettingRow
          help={t`Off, nobody can connect it, admins included. Connections already made go on.`}
          label={t`Offered to your organization`}
        >
          <Switch
            checked={integration.offered}
            disabled={staff}
            failedLabel={t`Couldn't save`}
            aria-label={t`Offered to your organization`}
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
        </SettingRow>
      </SettingsRows>
    </SectionCard>
  );
};
