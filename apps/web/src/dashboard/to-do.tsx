import type { Identity } from "@grasp-os/shared/rpc";
import type { SignInAgainItem } from "@grasp-os/shared/waiting";
import { buttonVariants } from "@grasp-os/ui/components/button";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useMatch } from "@tanstack/react-router";
import { KeyRoundIcon } from "lucide-react";
import { useState } from "react";

import { integrationKey } from "../connections/integrations.ts";
import { NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import {
  DashboardCard,
  DashboardCardHeader,
  DashboardGroup,
  ItemMark,
} from "./dashboard-card.tsx";
import { InboxGroup, inInbox } from "./in-inbox.tsx";
import { TodoPile } from "./todo-pile.tsx";
import type { PileItem } from "./todo-pile.tsx";
import { decidesRequests } from "./waiting.ts";
import type { Viewer, Waiting } from "./waiting.ts";

// What waits on the person, on top of the dashboard. What can be settled
// on its card is a pile of cards, gone through one at a time
// (`todo-pile.tsx`): changes an agent wants to make, which wait for them to
// approve or reject; changes sent for them whose answer was lost, which
// wait for them to say whether each happened (`outcome-card.tsx`); permission requests, which wait for an admin;
// packages proposed for an engine, which wait for someone given the
// permission to approve them. The rest is settled on its own page, and is
// listed under the pile with the way there, not counted on it:
// connections they can sign in to again, and what the inbox settles
// (`in-inbox.tsx`), each a way to its item there.

/** An account to sign in to again: its next step opens its account on its integration's page. */
const ReconnectRow = ({ ranOut }: { ranOut: SignInAgainItem }) => {
  const { t } = useLingui();
  const { integration, connection } = ranOut;
  // Named as its card on the integration's page is: the account too.
  const app =
    connection.accountName === null
      ? integration.name
      : `${integration.name} (${connection.accountName})`;
  return (
    <li className="flex min-h-14 items-center gap-3 border-t px-4 py-2">
      <ItemMark icon={KeyRoundIcon} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-muted-foreground text-xs">
          <Trans context="kind of thing that waits">Connection</Trans>
        </span>
        <span className="truncate">
          <Trans>{app} needs someone to sign in again</Trans>
        </span>
      </div>
      <Link
        aria-label={t`Sign in to ${app} again`}
        className={buttonVariants({ size: "xs" })}
        params={{
          integration: integrationKey(integration.source, integration.id),
        }}
        search={{ tab: "account" }}
        to="/integrations/$integration"
      >
        <Trans>Sign in again</Trans>
      </Link>
    </li>
  );
};

/** Why a part of what waits couldn't be read, in its group's place. */
const PartNotLoaded = ({ part }: { part: Loaded<unknown> }) =>
  part.state === "ready" ? null : (
    <div className="border-t px-4 py-3">
      <NotLoaded page={part} />
    </div>
  );

const ReconnectGroup = ({
  reconnect,
}: {
  reconnect: Loaded<SignInAgainItem[]>;
}) => {
  const { t } = useLingui();
  if (reconnect.state !== "ready") {
    return <PartNotLoaded part={reconnect} />;
  }
  const ranOut = reconnect.data;
  if (ranOut.length === 0) {
    return null;
  }
  return (
    <DashboardGroup title={t`Connections to sign in to again`}>
      <ul aria-label={t`Connections to sign in to again`}>
        {ranOut.map((account) => (
          <ReconnectRow key={account.connection.id} ranOut={account} />
        ))}
      </ul>
    </DashboardGroup>
  );
};

/** The cards of the pile, of what was read: core's order, kind by kind. */
const pileOf = (
  { held, outcomes, requests, dependencies }: Waiting,
  identity: Viewer
): PileItem[] => [
  ...(held.state === "ready"
    ? held.data.map((action): PileItem => ({
        kind: "held",
        id: `held:${action.id}`,
        action,
      }))
    : []),
  ...(outcomes.state === "ready"
    ? outcomes.data.map((outcome): PileItem => ({
        kind: "outcome",
        // Its key and its claim: the same call sent again and lost again
        // is another card.
        id: `outcome:${JSON.stringify([outcome.key, outcome.claim])}`,
        outcome,
      }))
    : []),
  ...(requests?.state === "ready" && decidesRequests(identity)
    ? requests.data.requests.map((request): PileItem => ({
        kind: "request",
        id: `request:${request.id}`,
        request,
        pending: requests.data,
      }))
    : []),
  ...(dependencies.state === "ready"
    ? dependencies.data.requests.map((request): PileItem => ({
        kind: "packages",
        id: `packages:${request.id}`,
        request,
        policyGeneration: dependencies.data.policyGeneration,
      }))
    : []),
];

/**
 * What waits on the person: the pile, and under it what is settled on its
 * own page.
 */
export const ToDo = ({
  waiting,
  identity,
}: {
  waiting: Waiting;
  identity: Identity;
}) => {
  const { t } = useLingui();
  const [said, setSaid] = useState("");
  // When the dashboard read what waits: it dates only what core lists
  // undated, which the dashboard doesn't show.
  const readAt = new Date(
    useMatch({ from: "/_shell/dashboard", select: (match) => match.updatedAt })
  ).toISOString();
  const inbox = inInbox(waiting, identity, readAt);
  const { reconnect } = waiting;
  // A part of the pile that couldn't be read says so below it.
  const notLoaded = (
    [
      ["held", waiting.held],
      ["outcomes", waiting.outcomes],
      ["requests", waiting.requests],
      ["dependencies", waiting.dependencies],
      ["notifications", waiting.notifications],
    ] as const
  ).flatMap(([key, part]) =>
    part === undefined || part.state === "ready" ? [] : [{ key, part }]
  );
  const elsewhere =
    notLoaded.length > 0 ||
    inbox.length > 0 ||
    reconnect.state !== "ready" ||
    reconnect.data.length > 0;
  return (
    <>
      <TodoPile items={pileOf(waiting, identity)} onSaid={setSaid} />
      {/* Outside the pile, so what was done with its last card is still said once it is gone. */}
      <output className="sr-only">{said}</output>
      {elsewhere ? (
        <DashboardCard id="dashboard-elsewhere">
          <DashboardCardHeader
            id="dashboard-elsewhere"
            title={t({
              message: "Waiting elsewhere",
              context: "dashboard: what waits on you, settled on its own page",
            })}
            actions={
              <Link
                className={buttonVariants({ size: "xs", variant: "ghost" })}
                to="/inbox"
              >
                <Trans>Open the inbox</Trans>
              </Link>
            }
          />
          {notLoaded.map(({ key, part }) => (
            <PartNotLoaded key={key} part={part} />
          ))}
          <InboxGroup items={inbox} />
          <ReconnectGroup reconnect={reconnect} />
        </DashboardCard>
      ) : null}
    </>
  );
};
