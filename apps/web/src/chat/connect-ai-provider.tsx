import { Button } from "@grasp-os/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import { KeyIcon } from "@grasp-os/ui/lib/icons";
import { Trans } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";

import { useMemberAdmin } from "../use-member-admin.ts";

// What an answer shows while the organization has no AI provider to call:
// every model call fails as `model.no_provider` until one of its admins
// connects a provider and chooses a model (Settings › AI providers).
// Never an error: a state with the way out. An admin who can connect one
// gets the link; anyone else, Grasp staff included (who may read but
// never change whose key pays), is told who can.

/** Connect an AI provider, under an answer that could not be given without one. */
export const ConnectAiProvider = () => {
  const canConnect = useMemberAdmin();
  return (
    <Empty align="start" size="sm">
      <EmptyHeader>
        <EmptyMedia icon={KeyIcon} variant="icon" />
        <EmptyTitle>
          <Trans>Connect an AI provider</Trans>
        </EmptyTitle>
        <EmptyDescription>
          {canConnect ? (
            <Trans>
              Grasp&apos;s AI works with your organization&apos;s own AI
              provider key. Connect one and choose a model to start.
            </Trans>
          ) : (
            <Trans>Ask your admin to connect an AI provider.</Trans>
          )}
        </EmptyDescription>
      </EmptyHeader>
      {canConnect ? (
        <EmptyContent>
          <Button asChild size="sm">
            <Link to="/settings/ai-providers">
              <Trans>Go to AI providers</Trans>
            </Link>
          </Button>
        </EmptyContent>
      ) : null}
    </Empty>
  );
};
