import { Switch } from "@grasp-os/ui/components/switch";
import { Trans, useLingui } from "@lingui/react/macro";

import { ErrorText } from "../error-text.tsx";
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
  const { busy, failure, change } = useChange();
  const { t } = useLingui();
  const { name } = integration;
  return (
    <div className="flex flex-col gap-1">
      <div className="bg-card flex items-center justify-between gap-4 rounded-xl border px-4 py-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span>
            <Trans>Offered to your organization</Trans>
          </span>
          <span className="text-muted-foreground text-xs">
            <Trans>
              Off, nobody can connect it, admins included. Connections already
              made go on.
            </Trans>
          </span>
        </div>
        <Switch
          aria-label={t`Offer ${name}`}
          checked={integration.offered}
          disabled={busy || staff}
          onCheckedChange={(offered) => {
            void change(async (session) => {
              await session.connections.setOffered(
                integration.source,
                integration.id,
                offered
              );
            });
          }}
        />
      </div>
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};
