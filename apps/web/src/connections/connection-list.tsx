import {
  composioConsentText,
  oauthProviderSchema,
} from "@grasp-os/shared/connect";
import type { ListedConnection } from "@grasp-os/shared/connect";
import type { Permission } from "@grasp-os/shared/permissions";
import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@grasp-os/ui/components/dialog";
import { i18n } from "@lingui/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg, ph } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";
import type { ReactNode } from "react";

import { ErrorText } from "../error-text.tsx";
import { formatDate, formatList } from "../format.ts";
import type { Loaded } from "../load-from-core.tsx";
import { canReconnect, ConnectDialog } from "./connect-dialog.tsx";
import type { Integration } from "./integrations.ts";
import { useChange } from "./use-change.ts";

// The person's connections and the shared ones, as core lists them: what
// each reaches, who connected it, and, for admins and builders, which Apps
// and agents hold a permission for it. Connect and core check every
// reconnect, disconnect and revoke; the page leaves out only what the role
// can't do.

/** Every permission the person may list, and the Apps' names. */
export interface HeldPermissions {
  permissions: Permission[];
  /** App names by ID; an ID stands in for an App not listed here. */
  appNames: ReadonlyMap<string, string>;
}

/** Where a connection stands, in words, by its status and whose it is. */
const statusTextOf = ({
  status,
  scope,
}: ListedConnection): MessageDescriptor => {
  if (status === "needs_reauth") {
    return msg`Needs someone to sign in again`;
  }
  if (status === "disconnected") {
    return msg`Disconnected`;
  }
  return scope === "shared"
    ? msg`Active, for the whole company`
    : msg`Active, only for you`;
};

/** An ISO 8601 time as a date for people. */
const dateOf = (iso: string): string => formatDate(iso);

/** Who holds a permission, for people: the App's name, or the agent. */
const holderOf = (
  { subject }: Permission,
  appNames: ReadonlyMap<string, string>
): string =>
  subject.type === "app"
    ? i18n._(
        msg`Engine ${ph({ app: appNames.get(subject.appId) ?? subject.appId })}`
      )
    : i18n._(msg`Agent ${ph({ agent: subject.agentId })}`);

const HolderItem = ({
  permission,
  holder,
  mayRevoke,
}: {
  permission: Permission;
  holder: string;
  mayRevoke: boolean;
}) => {
  const { busy, failure, change } = useChange();
  const { t } = useLingui();
  const { object } = permission;
  const resource =
    object.type === "connection" && object.resource !== undefined
      ? object.resource
      : t`the whole connection`;
  const actions = formatList(permission.actions);
  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <span>{t`${holder}: ${actions} on ${resource}`}</span>
        {mayRevoke ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            aria-label={t`Revoke ${holder}'s permission`}
            onClick={() => {
              void change(
                async (session) =>
                  await session.permissions.revoke(permission.id)
              );
            }}
          >
            <Trans>Revoke</Trans>
          </Button>
        ) : null}
      </div>
      <ErrorText>{failure}</ErrorText>
    </li>
  );
};

/**
 * The Apps and agents that can use the connection `id` now: those with an
 * active permission for it. One only asked for allows nothing yet.
 */
const Holders = ({
  id,
  held,
  mayRevoke,
}: {
  id: string;
  held: HeldPermissions;
  mayRevoke: boolean;
}) => {
  const holding = held.permissions.filter(
    ({ object, status }) =>
      object.type === "connection" &&
      object.connectionId === id &&
      status === "active"
  );
  return (
    <div className="flex flex-col gap-1 text-sm">
      <h4 className="font-medium">
        <Trans>Engines and agents with a permission</Trans>
      </h4>
      {holding.length === 0 ? (
        <p className="text-muted-foreground">
          <Trans>None.</Trans>
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {holding.map((permission) => (
            <HolderItem
              key={permission.id}
              permission={permission}
              holder={holderOf(permission, held.appNames)}
              mayRevoke={mayRevoke}
            />
          ))}
        </ul>
      )}
    </div>
  );
};

/**
 * A Composio connection's consent: who gave it, and the tools they allowed.
 * The text is the consent as this release words it, and says so; the audit
 * log keeps the SHA-256 of the exact text they were shown
 * (`connection.consent`).
 */
const ConsentRecord = ({ connection }: { connection: ListedConnection }) => {
  const { t } = useLingui();
  const who = connection.connectedByName ?? t`An admin`;
  return (
    <div className="flex flex-col gap-1 text-sm">
      <h4 className="font-medium">
        <Trans>Consent</Trans>
      </h4>
      <p>
        <Trans>{who} consented to this before connecting it:</Trans>
      </p>
      <blockquote className="text-muted-foreground border-l-2 pl-3">
        {composioConsentText}
      </blockquote>
      <p className="text-muted-foreground">
        <Trans>
          This is the consent as Grasp words it now. The audit log keeps a hash
          of the exact text they were shown.
        </Trans>
      </p>
      <p>
        {connection.tools === undefined || connection.tools.length === 0
          ? t`Tools allowed: none recorded`
          : t`Tools allowed: ${ph({ tools: formatList(connection.tools) })}`}
      </p>
    </div>
  );
};

/**
 * What a connection whose access ran out says to someone who can't
 * reconnect it: why not, and who can, if anyone. `known` is whether its
 * provider is one this release starts a flow for, and `offered` whether
 * the organization offers it: core refuses to start a flow for one it
 * doesn't, whoever asks.
 */
const ranOutText = (
  known: boolean,
  offered: boolean,
  staff: boolean
): string => {
  if (!known) {
    return i18n._(msg`Its access ran out, and it can't be reconnected here.`);
  }
  if (!offered) {
    return i18n._(
      msg`Its access ran out. An admin must offer this connector again before it can be reconnected.`
    );
  }
  return staff
    ? i18n._(
        msg`Its access ran out. Grasp staff can't reconnect it: an admin of the organization can.`
      )
    : i18n._(
        msg`Its access ran out. An admin of your organization can reconnect it.`
      );
};

const Detail = ({ term, children }: { term: string; children: ReactNode }) => (
  <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-8">
    <dt className="text-muted-foreground flex-none sm:w-32">{term}</dt>
    <dd className="flex min-w-0 items-center gap-2">{children}</dd>
  </div>
);

/** Signing in again to a connection whose access ran out, in the connect dialog. */
const SignInAgain = ({
  connection,
  integration,
  identity,
  label,
}: {
  connection: ListedConnection;
  integration: Integration;
  identity: Identity;
  label: string;
}) => {
  const [open, setOpen] = useState(false);
  const { t } = useLingui();
  return (
    <>
      <Button
        aria-label={t`Sign in to ${label} again`}
        onClick={() => {
          setOpen(true);
        }}
        size="sm"
      >
        <Trans>Sign in again</Trans>
      </Button>
      <ConnectDialog
        again={connection}
        identity={identity}
        integration={integration}
        onOpenChange={setOpen}
        open={open}
      />
    </>
  );
};

/** Disconnecting, once confirmed: its tokens go, and everything that used it loses it. */
const Disconnect = ({
  connection,
  label,
  last,
}: {
  connection: ListedConnection;
  label: string;
  /**
   * The integration's last connection, where the catalog doesn't list it:
   * its page goes with it, so the list shows next.
   */
  last: boolean;
}) => {
  const { busy, failure, change } = useChange({ leave: last });
  const [confirming, setConfirming] = useState(false);
  const { t } = useLingui();
  return (
    <div className="flex flex-col items-end gap-1">
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogTrigger
          render={
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              aria-label={t`Disconnect ${label}`}
            />
          }
        >
          <Trans>Disconnect</Trans>
        </DialogTrigger>
        <DialogContent closeLabel={t`Close`}>
          <DialogHeader>
            <DialogTitle>
              <Trans>Disconnect {label}?</Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>
                Its tokens are deleted, every engine and agent loses it, and
                actions waiting on it are dropped. Connect it again to use it
                again.
              </Trans>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter closeLabel={t`Close`} showCloseButton>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                void change(
                  async (session) =>
                    await session.connections.disconnect(connection.id)
                );
              }}
            >
              <Trans>Disconnect</Trans>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};

/**
 * One connection to the integration, as the prototype's Account section
 * shows it: its account, where it stands, who connected it and when, and
 * what can be done with it.
 */
const ConnectionItem = ({
  connection,
  integration,
  held,
  identity,
}: {
  connection: ListedConnection;
  integration: Integration;
  held: HeldPermissions | undefined;
  identity: Identity;
}) => {
  const { t } = useLingui();
  const admin = isAdmin(identity.role);
  // Only the owner sees a personal connection here, and admins disconnect
  // shared ones: connect checks both.
  const mayDisconnect = connection.scope === "personal" || admin;
  const reconnectable = canReconnect(connection, integration.offered, identity);
  const { accountName } = connection;
  const { name } = integration;
  const label = accountName === null ? name : `${name} (${accountName})`;
  const connectedBy =
    connection.connectedBy === identity.userId
      ? t`You`
      : (connection.connectedByName ?? t`Someone no longer here`);
  const ranOut = connection.status === "needs_reauth";
  return (
    <li className="bg-card flex flex-col gap-4 rounded-xl border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-medium">{label}</h3>
        <div className="flex items-start gap-2">
          {ranOut && reconnectable ? (
            <SignInAgain
              connection={connection}
              identity={identity}
              integration={integration}
              label={label}
            />
          ) : null}
          {mayDisconnect ? (
            <Disconnect
              connection={connection}
              label={label}
              last={!integration.listed && integration.connections.length === 1}
            />
          ) : null}
        </div>
      </div>
      <dl className="flex flex-col gap-3">
        <Detail term={t`Status`}>
          <span
            aria-hidden="true"
            className={
              ranOut
                ? "bg-status-attention size-1.75 rounded-full"
                : "bg-status-agreed size-1.75 rounded-full"
            }
          />
          {i18n._(statusTextOf(connection))}
        </Detail>
        <Detail term={t`Account`}>
          {accountName ?? t`Not named by the provider`}
        </Detail>
        <Detail term={t`Connected by`}>{connectedBy}</Detail>
        <Detail term={t`Connected on`}>{dateOf(connection.createdAt)}</Detail>
      </dl>
      {ranOut && !reconnectable ? (
        <p className="text-muted-foreground">
          {ranOutText(
            connection.source === "native" &&
              oauthProviderSchema.safeParse(connection.provider).success,
            integration.offered,
            identity.staff
          )}
        </p>
      ) : null}
      {ranOut && reconnectable ? (
        <p className="text-muted-foreground">
          <Trans>
            Its access ran out. Sign in again with the same account: engines and
            agents keep their permissions for it.
          </Trans>
        </p>
      ) : null}
      {connection.source === "composio" ? (
        <ConsentRecord connection={connection} />
      ) : null}
      {held === undefined ? null : (
        <Holders
          id={connection.id}
          held={held}
          mayRevoke={admin && !identity.staff}
        />
      )}
    </li>
  );
};

/** The integration's connections this person can see, each on its card. */
export const ConnectionList = ({
  integration,
  held,
  identity,
}: {
  integration: Integration;
  /** Undefined for someone who can't list permissions. */
  held: Loaded<HeldPermissions> | undefined;
  identity: Identity;
}) => (
  <ul className="flex flex-col gap-3">
    {integration.connections.map((connection) => (
      <ConnectionItem
        connection={connection}
        held={held?.state === "ready" ? held.data : undefined}
        identity={identity}
        integration={integration}
        key={connection.id}
      />
    ))}
  </ul>
);
