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
 * Connect an AI provider: a link to Settings › AI providers for whoever can,
 * and who to ask for anyone else. `size` as `Empty`'s: `xs` in a thread or
 * under a box to ask in.
 */
export const ConnectAiProvider = ({
  size = "sm",
}: {
  size?: "default" | "sm" | "xs";
}) => {
  const canConnect = useMemberAdmin();
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
