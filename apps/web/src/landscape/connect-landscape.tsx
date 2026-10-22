import type { LandscapeSyncStatus } from "@grasp-os/shared/landscape";
import type { Identity } from "@grasp-os/shared/rpc";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@grasp-os/ui/components/alert";
import { Button } from "@grasp-os/ui/components/button";
import { Trans } from "@lingui/react/macro";
import { RadarIcon } from "lucide-react";

import { goTo } from "../connections/connect-dialog.tsx";
import { ErrorText } from "../error-text.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";

// Finding the apps people granted access in Microsoft Entra: an admin
// connects the landscape's own read-only connection (core's
// src/landscape.ts), apart from Microsoft 365's mail, calendar and files,
// and Grasp reads the grants once a day. Shown to admins while none is
// connected, and to reconnect one whose access ran out.

/**
 * What an admin is offered: to connect the landscape while there is no
 * connection, to connect it again while one needs it; nothing otherwise.
 * Grasp staff see its freshness but are offered neither: core refuses
 * them a connection.
 */
export const landscapeOffer = (
  syncs: Loaded<LandscapeSyncStatus[]> | null,
  identity: Pick<Identity, "staff">
): "connect" | "reconnect" | null => {
  if (identity.staff || syncs?.state !== "ready") {
    return null;
  }
  if (syncs.data.length === 0) {
    return "connect";
  }
  return syncs.data.some(({ connection }) => connection === "needs_reauth")
    ? "reconnect"
    : null;
};

/** The offer to connect the landscape, or to connect it again. */
export const ConnectLandscape = ({
  syncs,
  identity,
}: {
  syncs: Loaded<LandscapeSyncStatus[]> | null;
  identity: Pick<Identity, "staff">;
}) => {
  const { busy, failure, run } = useCoreAction();
  const offer = landscapeOffer(syncs, identity);
  if (offer === null) {
    return null;
  }
  const connect = async (): Promise<void> => {
    goTo(
      await run(
        async (session) =>
          await session.landscape.connect({ returnTo: "/landscape" })
      )
    );
  };
  return (
    <Alert live="polite">
      <RadarIcon />
      <AlertTitle>
        {offer === "connect" ? (
          <Trans>Find the apps your people use</Trans>
        ) : (
          <Trans>Microsoft Entra needs connecting again</Trans>
        )}
      </AlertTitle>
      <AlertDescription>
        <Trans>
          Connect Microsoft Entra to read which apps people and admins granted
          access, once a day. Grasp only reads: no mail, files or sign-ins.
        </Trans>
        <ErrorText>{failure}</ErrorText>
      </AlertDescription>
      <AlertAction>
        <Button
          disabled={busy}
          onClick={() => {
            void connect();
          }}
          size="sm"
        >
          {offer === "connect" ? (
            <Trans>Connect Microsoft Entra</Trans>
          ) : (
            <Trans>Reconnect Microsoft Entra</Trans>
          )}
        </Button>
      </AlertAction>
    </Alert>
  );
};
