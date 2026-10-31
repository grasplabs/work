import { isAdmin } from "@grasp-os/shared/roles";
import { Button } from "@grasp-os/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import { Trans } from "@lingui/react/macro";
import { Link, useMatch } from "@tanstack/react-router";
import { KeyRoundIcon } from "lucide-react";

// What an AI feature shows while the organization has no AI provider to
// call: every model call fails as `model.no_provider` until one of its
// admins connects a provider and chooses a model (Settings › AI
// providers). Never an error: a state with the way out. An admin who can
// connect one gets the link; anyone else, Grasp staff included (who may
// read but never change whose key pays), is told who can.

/** Whether the signed-in person can connect a provider: the organization's own admins. */
const useCanConnect = (): boolean => {
  const shell = useMatch({ from: "/_shell", shouldThrow: false });
  const identity = shell?.context.identity;
  return identity !== undefined && isAdmin(identity.role) && !identity.staff;
};

/**
 * Connect an AI provider: a link to Settings › AI providers for whoever can,
 * and who to ask for anyone else. `size` as `Empty`'s: `xs` in a thread or
 * under a box to ask in.
 */
export const ConnectAiProvider = ({
  size = "sm",
}: {
  size?: "default" | "sm" | "xs";
}) => {
  const canConnect = useCanConnect();
  return (
    <Empty size={size}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <KeyRoundIcon aria-hidden="true" />
        </EmptyMedia>
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
          <Button
            nativeButton={false}
            render={<Link to="/settings/ai-providers" />}
            size="sm"
          >
            <Trans>Go to AI providers</Trans>
          </Button>
        </EmptyContent>
      ) : null}
    </Empty>
  );
};
