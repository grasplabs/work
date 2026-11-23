import { Button } from "@grasp-os/app-kit/components/button";
import { Trans } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { KeyRoundIcon } from "lucide-react";

import { useMemberAdmin } from "../use-member-admin.ts";

// What an AI feature shows while the organization has no AI provider to
// call: every model call fails as `model.no_provider` until one of its
// admins connects a provider and chooses a model (Settings › AI
// providers). Never an error: a state with the way out. An admin who can
// connect one gets the link; anyone else, Grasp staff included (who may
// read but never change whose key pays), is told who can.

/**
 * Over a box to ask in, while there is no AI provider: what is missing, in
 * a line, with the way to Settings › AI providers for whoever can connect
 * one, and who to ask for anyone else.
 */
export const ConnectAiProviderCover = () => {
  const canConnect = useMemberAdmin();
  return (
    <>
      <p className="flex items-center gap-2 font-medium">
        <KeyRoundIcon aria-hidden="true" className="size-4" />
        <Trans>Connect an AI provider to start asking</Trans>
      </p>
      {canConnect ? (
        <Button
          nativeButton={false}
          render={<Link to="/settings/ai-providers" />}
          size="sm"
        >
          <Trans>Go to AI providers</Trans>
        </Button>
      ) : (
        <p className="text-muted-foreground">
          <Trans>Ask your admin to connect one.</Trans>
        </p>
      )}
    </>
  );
};
