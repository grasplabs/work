import type { PendingAction } from "@grasp-os/shared/connect";
import type { DependenciesWaiting } from "@grasp-os/shared/dependencies";
import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import type { ScreensWaiting } from "@grasp-os/shared/screen-trust";
import { buttonVariants } from "@grasp-os/ui/components/button";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { KeyRoundIcon, ShieldCheckIcon } from "lucide-react";
import { useState } from "react";

import type { PendingRequests } from "../activity/pending.tsx";
import { canReconnect } from "../connections/connect-dialog.tsx";
import type { Integration } from "../connections/integrations.ts";
import { NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import {
  DashboardCard,
  DashboardCardHeader,
  DashboardGroup,
  ItemMark,
} from "./dashboard-card.tsx";
import { FailedWorkflows } from "./failed-workflows.tsx";
import type { NotificationsPage, OlderFailures } from "./failed-workflows.tsx";
import { TodoPile } from "./todo-pile.tsx";
import type { PileItem } from "./todo-pile.tsx";

// What waits on the person, on top of the dashboard. What can be settled
// on its card is a pile of cards, gone through one at a time
// (`todo-pile.tsx`): changes an agent wants to make, which wait for them to
// approve or reject; permission requests, which wait for an admin;
// packages proposed for an engine, which wait for someone given the
// permission to approve them. The rest is settled on its own page, and is
// listed under the pile with the way there, not counted on it: the current
// apps of engines whose code nobody approved (read on the engine's page),
// workflows failed while acting for the person, with a way to ask the
// agent to fix it, and connections they can sign in to again. Decisions a
// run waits on aren't here: core can't list a person's decisions yet (they
// come by mail and link).

/** What the dashboard read of what waits on the person, each part on its own. */
export interface Waiting {
  held: Loaded<PendingAction[]>;
  failed: Loaded<NotificationsPage>;
  integrations: Loaded<Integration[]>;
  /** Admins only. */
  requests: Loaded<PendingRequests> | undefined;
  /** Packages to approve: none for anyone without that permission. */
  dependencies: Loaded<DependenciesWaiting>;
  /** Engines with apps whose code waits for approval. Admins only. */
  screens: Loaded<ScreensWaiting[]> | undefined;
}

/** Who counts what waits: what they may act on follows from their role. */
export type Viewer = Pick<Identity, "role" | "staff">;

/** An account whose access ran out, at its integration. */
interface RanOut {
  integration: Integration;
  connection: Integration["connections"][number];
}

/** The accounts whose access ran out, among those this person can sign in to again: each one waits. */
export const toReconnect = (
  integrations: readonly Integration[],
  identity: Viewer
): RanOut[] =>
  integrations.flatMap((integration) =>
    integration.connections
      .filter(
        (connection) =>
          connection.status === "needs_reauth" &&
          canReconnect(connection, integration.offered, identity)
      )
      .map((connection) => ({ integration, connection }))
  );

/** Whether permission requests wait on this person: admins decide them; staff can't, and don't get them. */
export const decidesRequests = ({ role, staff }: Viewer): boolean =>
  isAdmin(role) && !staff;

/** An account to sign in to again: its next step opens its account on its integration's page. */
const ReconnectRow = ({ ranOut }: { ranOut: RanOut }) => {
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
        params={{ integration: integration.key }}
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

/** An engine with apps to approve: its next step is the engine's page, where their code is approved. */
const ScreensRow = ({ waiting }: { waiting: ScreensWaiting }) => {
  const { t } = useLingui();
  const { app, name, screens } = waiting;
  const count = screens.length;
  return (
    <li className="flex min-h-14 items-center gap-3 border-t px-4 py-2">
      <ItemMark icon={ShieldCheckIcon} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-muted-foreground text-xs">
          <Trans context="kind of thing that waits">App approval</Trans>
        </span>
        <span className="truncate">
          <Plural
            one={`${name} has # app whose code nobody approved`}
            other={`${name} has # apps whose code nobody approved`}
            value={count}
          />
        </span>
      </div>
      <Link
        aria-label={t`Review the apps of ${name}`}
        className={buttonVariants({ size: "xs" })}
        params={{ engine: app }}
        to="/domains/$engine"
      >
        <Trans>Review</Trans>
      </Link>
    </li>
  );
};

const ScreensGroup = ({ screens }: { screens: Loaded<ScreensWaiting[]> }) => {
  const { t } = useLingui();
  if (screens.state !== "ready") {
    return <PartNotLoaded part={screens} />;
  }
  if (screens.data.length === 0) {
    return null;
  }
  return (
    <DashboardGroup title={t`Apps to approve`}>
      <ul aria-label={t`Apps to approve`}>
        {screens.data.map((waiting) => (
          <ScreensRow key={waiting.app} waiting={waiting} />
        ))}
      </ul>
    </DashboardGroup>
  );
};

const FailedGroup = ({
  failed,
  older,
  onOlder,
}: {
  failed: Loaded<NotificationsPage>;
  older: OlderFailures;
  onOlder: (older: OlderFailures) => void;
}) => {
  const { t } = useLingui();
  if (failed.state !== "ready") {
    return <PartNotLoaded part={failed} />;
  }
  if (failed.data.page.notifications.length === 0) {
    return null;
  }
  return (
    <DashboardGroup title={t`Workflows that failed`}>
      <FailedWorkflows older={older} onOlder={onOlder} page={failed.data} />
    </DashboardGroup>
  );
};

const ReconnectGroup = ({
  integrations,
  identity,
}: {
  integrations: Loaded<Integration[]>;
  identity: Identity;
}) => {
  const { t } = useLingui();
  if (integrations.state !== "ready") {
    return <PartNotLoaded part={integrations} />;
  }
  const ranOut = toReconnect(integrations.data, identity);
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
  { held, requests, dependencies }: Waiting,
  identity: Viewer
): PileItem[] => [
  ...(held.state === "ready"
    ? held.data.map((action): PileItem => ({
        kind: "held",
        id: `held:${action.id}`,
        action,
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
 * own page. It keeps the older failures shown on asking, for the read they
 * followed: a new read of the failures starts them again.
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
  const [kept, setKept] = useState<{
    after: Waiting["failed"];
    older: OlderFailures;
  }>();
  const older: OlderFailures =
    kept?.after === waiting.failed ? kept.older : { rows: [], more: undefined };
  const { failed, integrations, screens } = waiting;
  // A part of the pile that couldn't be read says so below it.
  const notLoaded = (
    [
      ["held", waiting.held],
      ["requests", waiting.requests],
      ["dependencies", waiting.dependencies],
    ] as const
  ).flatMap(([key, part]) =>
    part === undefined || part.state === "ready" ? [] : [{ key, part }]
  );
  const elsewhere =
    notLoaded.length > 0 ||
    failed.state !== "ready" ||
    failed.data.page.notifications.length > 0 ||
    integrations.state !== "ready" ||
    toReconnect(integrations.data, identity).length > 0 ||
    (screens !== undefined &&
      (screens.state !== "ready" || screens.data.length > 0));
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
          />
          {notLoaded.map(({ key, part }) => (
            <PartNotLoaded key={key} part={part} />
          ))}
          {screens === undefined ? null : <ScreensGroup screens={screens} />}
          <FailedGroup
            failed={failed}
            older={older}
            onOlder={(next) => {
              setKept({ after: failed, older: next });
            }}
          />
          <ReconnectGroup identity={identity} integrations={integrations} />
        </DashboardCard>
      ) : null}
    </>
  );
};
