import type { PendingAction } from "@grasp-os/shared/connect";
import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { buttonVariants } from "@grasp-os/ui/components/button";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useRouter } from "@tanstack/react-router";
import { KeyRoundIcon } from "lucide-react";
import { useState } from "react";

import { PendingApprovals } from "../activity/pending.tsx";
import type { PendingRequests } from "../activity/pending.tsx";
import { HeldWrite } from "../chat/held-writes.tsx";
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

// What waits on the person, as the prototype's To do
// (`components/dashboard/action-panel.tsx`): each thing with what it is
// about and its next step, by kind. Changes an agent wants to make wait
// for them to confirm or reject; permission requests wait for an admin;
// workflows failed while acting for them, with a way to ask the agent to
// fix it; connections they can sign in to again ran out. Decisions a run
// waits on aren't here: core can't list a person's decisions yet (they
// come by mail and link).

/** What the dashboard read of what waits on the person, each part on its own. */
export interface Waiting {
  held: Loaded<PendingAction[]>;
  failed: Loaded<NotificationsPage>;
  integrations: Loaded<Integration[]>;
  /** Admins only. */
  requests: Loaded<PendingRequests> | undefined;
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

/**
 * How many things the page lists as waiting on the person, of what was
 * read: every failed workflow listed, read or not and older ones shown on
 * asking too, so the number matches the rows. (The nav counts only unread
 * ones: counting there never marks anything read, and one already seen
 * here is no longer news.)
 */
export const waitingCount = (
  { held, failed, integrations, requests }: Waiting,
  identity: Viewer,
  olderShown = 0
): number =>
  (held.state === "ready" ? held.data.length : 0) +
  (failed.state === "ready"
    ? failed.data.page.notifications.length + olderShown
    : 0) +
  (integrations.state === "ready"
    ? toReconnect(integrations.data, identity).length
    : 0) +
  (requests?.state === "ready" && decidesRequests(identity)
    ? requests.data.requests.length
    : 0);

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

const HeldGroup = ({ held }: { held: Loaded<PendingAction[]> }) => {
  const router = useRouter();
  const { t } = useLingui();
  if (held.state !== "ready") {
    return <PartNotLoaded part={held} />;
  }
  if (held.data.length === 0) {
    return null;
  }
  return (
    <DashboardGroup title={t`Changes to confirm`}>
      <div className="flex flex-col gap-3 border-t px-4 py-3">
        {held.data.map((action) => (
          <HeldWrite
            action={action}
            key={action.id}
            onDecided={() => {
              void router.invalidate();
            }}
          />
        ))}
      </div>
    </DashboardGroup>
  );
};

const RequestsGroup = ({ requests }: { requests: Loaded<PendingRequests> }) => {
  const { t } = useLingui();
  if (requests.state !== "ready") {
    return <PartNotLoaded part={requests} />;
  }
  if (requests.data.requests.length === 0) {
    return null;
  }
  return (
    <DashboardGroup title={t`Permission requests`}>
      <div className="border-t px-4 py-3">
        <PendingApprovals decides pending={requests.data} />
      </div>
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

/**
 * What waits on the person, grouped by kind, each with its next step. It
 * keeps the older failures shown on asking, for the read they followed: a
 * new read of the failures starts them again.
 */
export const ToDo = ({
  waiting,
  identity,
}: {
  waiting: Waiting;
  identity: Identity;
}) => {
  const { t } = useLingui();
  const [kept, setKept] = useState<{
    after: Waiting["failed"];
    older: OlderFailures;
  }>();
  const older: OlderFailures =
    kept?.after === waiting.failed ? kept.older : { rows: [], more: undefined };
  const count = waitingCount(waiting, identity, older.rows.length);
  const loaded =
    waiting.held.state === "ready" &&
    waiting.failed.state === "ready" &&
    waiting.integrations.state === "ready" &&
    (waiting.requests === undefined || waiting.requests.state === "ready");
  return (
    <DashboardCard id="dashboard-to-do">
      <DashboardCardHeader
        count={count}
        id="dashboard-to-do"
        title={t({ message: "To do", context: "dashboard: what waits on you" })}
      />
      <HeldGroup held={waiting.held} />
      {waiting.requests === undefined ? null : (
        <RequestsGroup requests={waiting.requests} />
      )}
      <FailedGroup
        failed={waiting.failed}
        older={older}
        onOlder={(next) => {
          setKept({ after: waiting.failed, older: next });
        }}
      />
      <ReconnectGroup identity={identity} integrations={waiting.integrations} />
      {loaded && count === 0 ? (
        <p className="text-muted-foreground border-t px-4 py-10 text-center">
          <Trans>Nothing waits on you.</Trans>
        </p>
      ) : null}
    </DashboardCard>
  );
};
