import type { Identity } from "@grasp-os/shared/rpc";
import type { SignInAgainItem } from "@grasp-os/shared/waiting";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link, useMatch } from "@tanstack/react-router";
import { useState } from "react";

import { integrationKey } from "../connections/integrations.ts";
import { Button } from "../grasp/button/index.ts";
import { Lock } from "../grasp/icons/index.ts";
import { Item } from "../grasp/item/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { DashboardGroup } from "./dashboard-card.tsx";
import { InboxGroup, inInbox } from "./in-inbox.tsx";
import { TodoPile } from "./todo-pile.tsx";
import type { PileItem } from "./todo-pile.tsx";
import { decidesRequests } from "./waiting.ts";
import type { Viewer, Waiting } from "./waiting.ts";

// What waits on the person, on top of the dashboard. What can be settled
// on its card is a pile of cards, gone through one at a time
// (`todo-pile.tsx`): changes an agent wants to make, which wait for them to
// approve or reject; changes sent for them whose answer was lost, which
// wait for them to say whether each happened (`outcome-card.tsx`); permission requests, which wait for an admin.
// The rest is settled on its own page, and is
// listed under the pile with the way there, not counted on it:
// connections they can sign in to again, and what the inbox settles
// (`in-inbox.tsx`), each a way to its item there.

const styles = stylex.create({
  // Said once to a screen reader: what was done with the pile's last card.
  unseen: {
    position: "absolute",
    width: grasp.hairline,
    height: grasp.hairline,
    overflow: "hidden",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
  },
  notLoaded: {
    paddingInline: grasp.space5,
    paddingBlock: grasp.space3,
  },
});

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
    <Item
      actions={
        <Button
          render={
            <Link
              aria-label={t`Sign in to ${app} again`}
              params={{
                integration: integrationKey(integration.source, integration.id),
              }}
              search={{ tab: "account" }}
              to="/integrations/$integration"
            />
          }
          size="xs"
        >
          {t`Sign in again`}
        </Button>
      }
      description={t({
        message: "Connection",
        context: "kind of thing that waits",
      })}
      icon={Lock}
      title={t`${app} needs someone to sign in again`}
    />
  );
};

/** Why a part of what waits couldn't be read, in its group's place. */
const PartNotLoaded = ({ part }: { part: Loaded<unknown> }) =>
  part.state === "ready" ? null : (
    <div {...stylex.props(styles.notLoaded)}>
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
      {ranOut.map((account) => (
        <ReconnectRow key={account.connection.id} ranOut={account} />
      ))}
    </DashboardGroup>
  );
};

/** The cards of the pile, of what was read: core's order, kind by kind. */
const pileOf = (
  { held, outcomes, requests }: Waiting,
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
      <output {...stylex.props(styles.unseen)}>{said}</output>
      {elsewhere ? (
        <SectionCard
          actions={
            <Button render={<Link to="/inbox" />} size="xs" variant="ghost">
              {t`Open the inbox`}
            </Button>
          }
          flush
          title={t({
            message: "Waiting elsewhere",
            context: "dashboard: what waits on you, settled on its own page",
          })}
        >
          {notLoaded.map(({ key, part }) => (
            <PartNotLoaded key={key} part={part} />
          ))}
          <InboxGroup items={inbox} />
          <ReconnectGroup reconnect={reconnect} />
        </SectionCard>
      ) : null}
    </>
  );
};
