import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import { Spinner } from "@grasp-os/ui/components/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import { Trans, useLingui } from "@lingui/react/macro";
import { TriangleAlertIcon, UsersIcon } from "lucide-react";

import { useGlobalChat } from "../chat/global-chat.tsx";
import { ItemBar } from "./item-shell.tsx";
import type { Crumb } from "./site-header.tsx";

// Something new Build it made (an App, a workflow), while Grasp's agent
// builds its first version beside it in the chat: one calm state in place
// of the App's preview or the workflow's Flow, which never shows what is
// half made, broken or empty meanwhile, and a bar with its name alone.
// What is set up comes in once its first version works, as each page
// tells from real signals (the App's preview running, the workflow's
// draft passing) with Grasp's turn over. Only a turn that ended without
// one says so, with Try again, which asks the chat.

/** Where something new stands: ready, being set up, or not set up once Grasp's turn ended without a version that works. */
export type SetUp = "ready" | "setting-up" | "failed";

/** Share, off while Grasp sets it up, saying when it comes. */
const ShareOnceReady = () => (
  <Tooltip>
    {/* Focusable while off, so its tooltip says why. */}
    <TooltipTrigger
      render={
        <Button disabled focusableWhenDisabled size="sm" variant="highlight" />
      }
    >
      <UsersIcon data-icon="inline-start" />
      <Trans>Share with your team</Trans>
    </TooltipTrigger>
    <TooltipContent>
      <Trans>Share once it&apos;s ready</Trans>
    </TooltipContent>
  </Tooltip>
);

/** The bar while Grasp sets it up: the way back, its name, "Setting up", and Share off. */
export const SettingUpBar = ({ back, name }: { back: Crumb; name: string }) => (
  <ItemBar
    actions={<ShareOnceReady />}
    back={back}
    name={name}
    state={
      <Badge variant="outline">
        <Trans>Setting up</Trans>
      </Badge>
    }
  />
);

/**
 * In place of what is set up: "Setting up {name}…" while Grasp builds it,
 * or, once its turn ended without a version that works (`failed`), that
 * it isn't ready yet, with Try again, asked in the chat.
 */
export const SettingUp = ({
  name,
  failed,
}: {
  name: string;
  failed: boolean;
}) => {
  const { t } = useLingui();
  const chat = useGlobalChat();
  return (
    <div className="bg-muted flex min-h-0 flex-1 items-center justify-center p-6">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            {failed ? (
              <TriangleAlertIcon />
            ) : (
              <Spinner aria-label={t`Setting up`} />
            )}
          </EmptyMedia>
          <EmptyTitle>
            {failed ? (
              <Trans>{name} isn&apos;t ready yet</Trans>
            ) : (
              <Trans>Setting up {name}…</Trans>
            )}
          </EmptyTitle>
          <EmptyDescription>
            {failed ? (
              <Trans>Grasp couldn&apos;t finish setting it up this time.</Trans>
            ) : (
              <Trans>Grasp is building it. This takes a minute or two.</Trans>
            )}
          </EmptyDescription>
        </EmptyHeader>
        {failed ? (
          <EmptyContent>
            <Button
              onClick={() => {
                void chat.ask(t`Try again to set up ${name}.`);
              }}
              variant="outline"
            >
              <Trans>Try again</Trans>
            </Button>
          </EmptyContent>
        ) : null}
      </Empty>
    </div>
  );
};

/**
 * Over a preview that broke while Grasp's turn still runs: a write on the
 * way, never the error itself, which the next write's start tries again.
 */
export const Updating = ({ name }: { name: string }) => {
  const { t } = useLingui();
  return (
    <div className="bg-muted flex min-h-0 flex-1 items-center justify-center p-6">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Spinner aria-label={t`Updating`} />
          </EmptyMedia>
          <EmptyTitle>
            <Trans>Updating {name}…</Trans>
          </EmptyTitle>
          <EmptyDescription>
            <Trans>Grasp is still working on it.</Trans>
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  );
};
