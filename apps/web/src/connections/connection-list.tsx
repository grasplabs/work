import {
  composioConsentText,
  oauthProviderSchema,
} from "@grasp-os/shared/connect";
import type { ListedConnection } from "@grasp-os/shared/connect";
import type { Permission } from "@grasp-os/shared/permissions";
import { isAdmin, isMemberAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { i18n } from "@lingui/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg, ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { holderName } from "../activity/pending.tsx";
import { formatDate, formatList } from "../format.ts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../grasp/alert-dialog/index.ts";
import { Alert } from "../grasp/alert/index.ts";
import { Badge } from "../grasp/badge/index.ts";
import { Button } from "../grasp/button/index.ts";
import { Collapsible } from "../grasp/collapsible/index.ts";
import { Empty } from "../grasp/empty/index.ts";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "../grasp/item/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { SectionHeader } from "../grasp/section-header/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import type { Loaded } from "../load-from-core.tsx";
import { FactRow, RowAlert, SettingsRows } from "../settings/section.tsx";
import { canReconnect, ConnectDialog } from "./connect-dialog.tsx";
import type { Integration } from "./integrations.ts";
import { useChange } from "./use-change.ts";

// The person's connections and the shared ones, as core lists them: what
// each reaches, who connected it, and, for admins and builders, which Apps
// and agents hold a permission for it. Connect and core check every
// reconnect, disconnect and revoke; the page leaves out only what the role
// can't do.

const styles = stylex.create({
  // A group's name in the card's flush rows, on their inset.
  head: {
    marginInline: grasp.space4,
    marginBlockStart: grasp.space3,
    marginBlockEnd: grasp.space1,
  },
});

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
        msg`App ${ph({ app: appNames.get(subject.appId) ?? subject.appId })}`
      )
    : holderName(subject);

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
    <Item size="xs">
      <ItemContent>
        <ItemTitle>{holder}</ItemTitle>
        <ItemDescription>
          {failure ?? t`${actions} on ${resource}`}
        </ItemDescription>
      </ItemContent>
      {mayRevoke ? (
        <ItemActions>
          <Button
            aria-label={t`Revoke ${holder}'s permission`}
            disabled={busy}
            onClick={() => {
              void change(
                async (session) =>
                  await session.permissions.revoke(permission.id)
              );
            }}
            size="sm"
            variant="ghost"
          >
            {t`Revoke`}
          </Button>
        </ItemActions>
      ) : null}
    </Item>
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
  const { t } = useLingui();
  const title = t`Apps and agents with a permission`;
  return (
    <section>
      <SectionHeader layout={styles.head} size="sm" title={title} />
      {holding.length === 0 ? (
        <Empty size="inline">{t`None.`}</Empty>
      ) : (
        <ItemGroup aria-label={title} separated>
          {holding.map((permission) => (
            <HolderItem
              holder={holderOf(permission, held.appNames)}
              key={permission.id}
              mayRevoke={mayRevoke}
              permission={permission}
            />
          ))}
        </ItemGroup>
      )}
    </section>
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
  const tools =
    connection.tools === undefined || connection.tools.length === 0
      ? t`Tools allowed: none recorded`
      : t`Tools allowed: ${ph({ tools: formatList(connection.tools) })}`;
  return (
    <FactRow
      help={t`This is the consent as Grasp words it now. The audit log keeps a hash of the exact text they were shown.`}
      label={t`Consent`}
    >
      <Collapsible title={t`${who} consented to this before connecting it`}>
        <Text size="sm" tone="muted">
          {composioConsentText}
        </Text>
        <Text size="sm">{tools}</Text>
      </Collapsible>
    </FactRow>
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
        variant="ink"
      >
        {t`Sign in again`}
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
  const { failure, change } = useChange({ leave: last });
  const { t } = useLingui();
  return (
    <AlertDialog>
      <AlertDialogTrigger aria-label={t`Disconnect ${label}`} size="sm">
        {t`Disconnect`}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogTitle>{t`Disconnect ${label}?`}</AlertDialogTitle>
        <AlertDialogDescription>
          {t`Its tokens are deleted, every App and agent loses it, and actions waiting on it are dropped. Connect it again to use it again.`}
        </AlertDialogDescription>
        {failure === undefined ? null : (
          <Alert title={failure} variant="danger" />
        )}
        <AlertDialogFooter>
          <AlertDialogAction>{t`Close`}</AlertDialogAction>
          <AlertDialogAction
            action={async () => {
              let gone = false;
              await change(async (session) => {
                await session.connections.disconnect(connection.id);
                gone = true;
              });
              if (!gone) {
                throw new Error("Not disconnected");
              }
            }}
            failedLabel={t`Couldn't disconnect`}
            variant="danger"
          >
            {t`Disconnect`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
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
    <SectionCard
      actions={
        <>
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
        </>
      }
      aside={
        <Badge tone={ranOut ? "attention" : "success"}>
          {i18n._(statusTextOf(connection))}
        </Badge>
      }
      density="compact"
      flush
      title={label}
    >
      <SettingsRows>
        {ranOut ? (
          <RowAlert variant="attention">
            {reconnectable
              ? t`Its access ran out. Sign in again with the same account: Apps and agents keep their permissions for it.`
              : ranOutText(
                  connection.source === "native" &&
                    oauthProviderSchema.safeParse(connection.provider).success,
                  integration.offered,
                  identity.staff
                )}
          </RowAlert>
        ) : null}
        <FactRow label={t`Account`}>
          {accountName ?? t`Not named by the provider`}
        </FactRow>
        <FactRow label={t`Connected by`}>{connectedBy}</FactRow>
        <FactRow label={t`Connected on`}>
          {dateOf(connection.createdAt)}
        </FactRow>
        {connection.source === "composio" ? (
          <ConsentRecord connection={connection} />
        ) : null}
      </SettingsRows>
      {held === undefined ? null : (
        <Holders
          held={held}
          id={connection.id}
          mayRevoke={isMemberAdmin(identity)}
        />
      )}
    </SectionCard>
  );
};

/** The integration's connections this person can see, each on its own compact card. */
export const ConnectionList = ({
  integration,
  held,
  identity,
}: {
  integration: Integration;
  /** Undefined for someone who can't list permissions. */
  held: Loaded<HeldPermissions> | undefined;
  identity: Identity;
}) =>
  integration.connections.map((connection) => (
    <ConnectionItem
      connection={connection}
      held={held?.state === "ready" ? held.data : undefined}
      identity={identity}
      integration={integration}
      key={connection.id}
    />
  ));
