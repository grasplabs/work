import {
  composioConsentText,
  composioKeyConsentText,
  oauthProviderSchema,
} from "@grasp-os/shared/connect";
import type { ListedConnection } from "@grasp-os/shared/connect";
import type { Permission } from "@grasp-os/shared/permissions";
import { isAdmin, isMemberAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { i18n } from "@lingui/core";
import { msg, ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { holderName } from "../activity/pending.tsx";
import { formatList } from "../format.ts";
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
import { Button } from "../grasp/button/index.ts";
import { Collapsible } from "../grasp/collapsible/index.ts";
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
import { FactRow, RowAlert, SettingsRows } from "../grasp/setting-row/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import type { Loaded } from "../load-from-core.tsx";
import { BrainAudience, useBrainAudiences } from "./brain-audience.tsx";
import { canReconnect, ConnectDialog } from "./connect-dialog.tsx";
import type { Integration } from "./integrations.ts";
import { useChange } from "./use-change.ts";

// What an app's page says of each connection beyond its row (the library's
// app page lists the accounts): signing in again and disconnecting from the
// row, and under the page's sections what each connection holds besides:
// why one whose access ran out can't be signed in to again, the consent a
// Composio one was made with, who may read in the Brain what agents read
// through a shared one, and which Apps and agents hold a permission for it.
// Connect and core check every reconnect, disconnect and revoke; the page
// leaves out only what the role can't do.

const styles = stylex.create({
  // A group's name in the card's flush rows, on their inset.
  head: {
    marginInline: grasp.space4,
    marginBlockStart: grasp.space3,
    marginBlockEnd: grasp.space1,
  },
  // The consent, quoted as it was given.
  quote: {
    margin: 0,
    paddingInlineStart: grasp.space3,
    borderInlineStartWidth: grasp.hairline,
    borderInlineStartStyle: "solid",
    borderInlineStartColor: grasp.line,
  },
});

/** Every permission the person may list, and the Apps' names. */
export interface HeldPermissions {
  permissions: Permission[];
  /** App names by ID; an ID stands in for an App not listed here. */
  appNames: ReadonlyMap<string, string>;
}

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
 * The permissions that let Apps and agents use the connection `id` now:
 * the active ones. One only asked for allows nothing yet.
 */
const holdingOf = (held: HeldPermissions, id: string): Permission[] =>
  held.permissions.filter(
    ({ object, status }) =>
      object.type === "connection" &&
      object.connectionId === id &&
      status === "active"
  );

/** The Apps and agents that can use a connection now, each with what it may do. */
const Holders = ({
  holding,
  appNames,
  mayRevoke,
}: {
  holding: Permission[];
  appNames: ReadonlyMap<string, string>;
  mayRevoke: boolean;
}) => {
  const { t } = useLingui();
  const title = t`Apps and agents with a permission`;
  return (
    <section>
      <SectionHeader layout={styles.head} size="sm" title={title} />
      <ItemGroup aria-label={title} separated>
        {holding.map((permission) => (
          <HolderItem
            holder={holderOf(permission, appNames)}
            key={permission.id}
            mayRevoke={mayRevoke}
            permission={permission}
          />
        ))}
      </ItemGroup>
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
  // The consent for how it was made, as connect recorded it; none where it
  // wasn't recorded.
  const consent =
    connection.composioAuth === undefined
      ? undefined
      : {
          managed: composioConsentText,
          key: composioKeyConsentText,
        }[connection.composioAuth];
  if (consent === undefined) {
    return (
      <FactRow label={t`Consent`}>
        <Text size="sm">{tools}</Text>
      </FactRow>
    );
  }
  return (
    <FactRow
      help={t`This is the consent as Grasp words it now. The audit log keeps a hash of the exact text they were shown.`}
      label={t`Consent`}
    >
      <Collapsible title={t`${who} consented to this before connecting it`}>
        <blockquote {...stylex.props(styles.quote)}>
          <Text size="sm" tone="muted">
            {consent}
          </Text>
        </blockquote>
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
        variant="quiet"
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

/** What Disconnect asks before it goes: its tokens go, and everything that used it loses it. */
const DisconnectContent = ({
  connection,
  label,
  last,
}: {
  connection: ListedConnection;
  label: string;
  last: boolean;
}) => {
  const { failure, change } = useChange({ leave: last });
  const { t } = useLingui();
  return (
    <AlertDialogContent>
      <AlertDialogTitle>{t`Disconnect ${label}?`}</AlertDialogTitle>
      <AlertDialogDescription>
        {t`Its tokens are deleted, every App and agent loses it, and actions waiting on it are dropped. Connect it again to use it again.`}
        {connection.keepsReads === true
          ? ` ${t`Everything the Brain kept from it is erased for good.`}`
          : null}
      </AlertDialogDescription>
      {failure === undefined ? null : <Alert title={failure} tone="danger" />}
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
  );
};

/** What Disconnect is given: the connection, its name, and whether it is the page's last. */
interface DisconnectProps {
  connection: ListedConnection;
  label: string;
  /**
   * The integration's last connection, where the catalog doesn't list it:
   * its page goes with it, so the list shows next.
   */
  last: boolean;
}

/** Disconnecting, from its own button, once confirmed. */
export const Disconnect = ({ connection, label, last }: DisconnectProps) => {
  const { t } = useLingui();
  return (
    <AlertDialog>
      <AlertDialogTrigger aria-label={t`Disconnect ${label}`} size="sm">
        {t`Disconnect`}
      </AlertDialogTrigger>
      <DisconnectContent connection={connection} label={label} last={last} />
    </AlertDialog>
  );
};

/** Disconnecting, opened by another control (an app's Manage menu), once confirmed. */
export const DisconnectDialog = ({
  open,
  onOpenChange,
  ...rest
}: DisconnectProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => (
  <AlertDialog onOpenChange={onOpenChange} open={open}>
    <DisconnectContent {...rest} />
  </AlertDialog>
);

/** A connection's name: its app's, with its account's where the provider names one. */
const labelOf = (
  connection: ListedConnection,
  integration: Integration
): string =>
  connection.accountName === null
    ? integration.name
    : `${integration.name} (${connection.accountName})`;

/**
 * Whether `identity` chooses who may read in the Brain what agents read
 * through `connection` (brain-audience.tsx): one of the company's own
 * admins, never Grasp staff, on a shared connection still connected.
 * Core checks it again.
 */
const choosesBrainAudience = (
  connection: ListedConnection,
  identity: Identity
): boolean =>
  isAdmin(identity.role) &&
  !identity.staff &&
  connection.scope === "shared" &&
  connection.status !== "disconnected";

/**
 * Whether this person disconnects `connection` from the app's page: only its
 * owner sees a personal one, admins disconnect shared ones, and Grasp staff
 * none. Connect checks it again.
 */
export const mayDisconnect = (
  connection: ListedConnection,
  identity: Pick<Identity, "role" | "staff">
): boolean =>
  (connection.scope === "personal" || isAdmin(identity.role)) &&
  !identity.staff;

/**
 * What can be done to one account from its row on the app's page: sign in
 * again where its access ran out and this person may, and disconnect where
 * they may. Each dialog grows from its own button.
 */
export const AccountActions = ({
  connection,
  integration,
  identity,
}: {
  connection: ListedConnection;
  integration: Integration;
  identity: Identity;
}) => {
  const label = labelOf(connection, integration);
  return (
    <>
      {connection.status === "needs_reauth" &&
      canReconnect(connection, integration.offered, identity) ? (
        <SignInAgain
          connection={connection}
          identity={identity}
          integration={integration}
          label={label}
        />
      ) : null}
      {mayDisconnect(connection, identity) ? (
        <Disconnect
          connection={connection}
          label={label}
          last={!integration.listed && integration.connections.length === 1}
        />
      ) : null}
    </>
  );
};

/**
 * What each of an app's connections holds beyond its row on the app's
 * page: why one whose access ran out can't be signed in to again by this
 * person; the consent a Composio one was made with; for the company's
 * admins on a shared one, who may read in the Brain what agents read
 * through it; and, for admins and builders, the Apps and agents holding a
 * permission for it. A card for each connection with any of these, named
 * by its account where there are several; nothing for the rest.
 */
export const ConnectionsAccess = ({
  integration,
  held,
  identity,
}: {
  integration: Integration;
  /** Undefined for someone who can't list permissions. */
  held: Loaded<HeldPermissions> | undefined;
  identity: Identity;
}) => {
  const { t } = useLingui();
  // Read once for every card that chooses one, never a read a card.
  const { read: audiences, onChanged } = useBrainAudiences(
    integration.connections.some((connection) =>
      choosesBrainAudience(connection, identity)
    )
  );
  const holders = held?.state === "ready" ? held.data : undefined;
  const several = integration.connections.length > 1;
  return integration.connections.map((connection) => {
    const label = labelOf(connection, integration);
    const stuck =
      connection.status === "needs_reauth" &&
      !canReconnect(connection, integration.offered, identity);
    const consented = connection.source === "composio";
    const chooses = choosesBrainAudience(connection, identity);
    const holding =
      holders === undefined ? [] : holdingOf(holders, connection.id);
    if (!stuck && !consented && !chooses && holding.length === 0) {
      return null;
    }
    return (
      <SectionCard
        density="compact"
        flush
        key={connection.id}
        title={several ? label : t`Access`}
      >
        {stuck || consented ? (
          <SettingsRows>
            {stuck ? (
              <RowAlert variant="attention">
                {ranOutText(
                  connection.source === "native" &&
                    oauthProviderSchema.safeParse(connection.provider).success,
                  integration.offered,
                  identity.staff
                )}
              </RowAlert>
            ) : null}
            {consented ? <ConsentRecord connection={connection} /> : null}
          </SettingsRows>
        ) : null}
        {chooses ? (
          <BrainAudience
            audiences={audiences}
            connection={connection}
            label={label}
            onChanged={onChanged}
          />
        ) : null}
        {holders === undefined || holding.length === 0 ? null : (
          <Holders
            appNames={holders.appNames}
            holding={holding}
            mayRevoke={isMemberAdmin(identity)}
          />
        )}
      </SectionCard>
    );
  });
};
