import type { LandscapeSyncStatus } from "@grasp-os/shared/landscape";
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
// connected.

/** The offer to connect the landscape, for an admin who hasn't yet. */
export const ConnectLandscape = ({
  syncs,
}: {
  syncs: Loaded<LandscapeSyncStatus[]> | null;
}) => {
  const { busy, failure, run } = useCoreAction();
  if (syncs?.state !== "ready" || syncs.data.length > 0) {
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
    <Alert>
      <RadarIcon />
      <AlertTitle>
        <Trans>Find the apps your people use</Trans>
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
          <Trans>Connect Microsoft Entra</Trans>
        </Button>
      </AlertAction>
    </Alert>
  );
};
