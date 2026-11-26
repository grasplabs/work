import {
  composioConsentText,
  composioKeyConsentText,
  oauthProviderSchema,
} from "@grasp-os/shared/connect";
import type { ListedConnection } from "@grasp-os/shared/connect";
import type { Permission } from "@grasp-os/shared/permissions";
import { isAdmin, isMemberAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { Alert, AlertTitle } from "@grasp-os/ui/components/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@grasp-os/ui/components/alert-dialog";
import { Button } from "@grasp-os/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemSeparator,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { SectionHeader } from "@grasp-os/ui/components/section-header";
import { Text } from "@grasp-os/ui/components/text";
import { colors, size as sizes, space } from "@grasp-os/ui/lib/tokens.stylex";
import { i18n } from "@lingui/core";
import { msg, ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Fragment, useState } from "react";

import { holderName } from "../activity/pending.tsx";
import { formatList } from "../format.ts";
import type { Loaded } from "../load-from-core.tsx";
import { FactRow, RowAlert, SettingsRows } from "./app/rows.tsx";
import { ChatReads } from "./chat-reads.tsx";
import { canReconnect, ConnectDialog } from "./connect-dialog.tsx";
import {
  AudienceChoice,
  useConnectionAudiences,
} from "./connection-audience.tsx";
import { connectionLabel } from "./integrations.ts";
import type { Integration } from "./integrations.ts";
import { SectionCard } from "./section-card.tsx";
import { useChange } from "./use-change.ts";

// What an app's page says of each connection beyond its row (its app page,
// app/page.tsx, lists the accounts): signing in again and disconnecting from the
// row, and under the page's sections what each connection holds besides:
// why one whose access ran out can't be signed in to again, the consent a
// Composio one was made with, who may use a shared one (its audience), and which Apps and agents hold a permission for it.
// Connect and core check every reconnect, disconnect and revoke; the page
// leaves out only what the role can't do.

const styles = stylex.create({
  // A group's name in the card's flush rows, on their inset.
  head: {
    marginInline: space["4"],
    marginBlockStart: space["3"],
    marginBlockEnd: space["1"],
  },
  // The consent, quoted as it was given.
  quote: {
    margin: 0,
    paddingInlineStart: space["3"],
    borderInlineStartWidth: sizes.hairline,
    borderInlineStartStyle: "solid",
    borderInlineStartColor: colors.border,
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
      <SectionHeader style={styles.head} size="sm" title={title} />
      <ItemGroup aria-label={title}>
        {holding.map((permission, index) => (
          <Fragment key={permission.id}>
            {index > 0 && <ItemSeparator />}
            <HolderItem
              holder={holderOf(permission, appNames)}
              mayRevoke={mayRevoke}
              permission={permission}
            />
          </Fragment>
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
      <Collapsible>
        <CollapsibleTrigger>
          {t`${who} consented to this before connecting it`}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <blockquote {...stylex.props(styles.quote)}>
            <Text color="muted" size="sm">
              {consent}
            </Text>
          </blockquote>
          <Text size="sm">{tools}</Text>
        </CollapsibleContent>
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
        variant="outline"
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
  onDone,
}: {
  connection: ListedConnection;
  label: string;
  last: boolean;
  /** Closes the question once it is disconnected. */
  onDone: () => void;
}) => {
  const { failure, change } = useChange({ leave: last });
  const { t } = useLingui();
  return (
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{t`Disconnect ${label}?`}</AlertDialogTitle>
        <AlertDialogDescription>
          {t`Its tokens are deleted, every App and agent loses it, and actions waiting on it are dropped. Connect it again to use it again.`}
          {connection.keepsReads === true
            ? ` ${t`Everything the Brain kept from it is erased for good.`}`
            : null}
        </AlertDialogDescription>
      </AlertDialogHeader>
      {failure === undefined ? null : (
        <Alert variant="destructive">
          <AlertTitle>{failure}</AlertTitle>
        </Alert>
      )}
      <AlertDialogFooter>
        <AlertDialogCancel>{t`Close`}</AlertDialogCancel>
        {/* Work that runs before it closes: the question stays open, with core's reason, when it fails. */}
        <Button
          errorText={t`Couldn't disconnect`}
          onClick={async () => {
            let gone = false;
            await change(async (session) => {
              await session.connections.disconnect(connection.id);
              gone = true;
            });
            if (!gone) {
              throw new Error("Not disconnected");
            }
            onDone();
          }}
          variant="destructive"
        >
          {t`Disconnect`}
        </Button>
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
const Disconnect = ({ connection, label, last }: DisconnectProps) => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  return (
    <AlertDialog onOpenChange={setOpen} open={open}>
      <AlertDialogTrigger asChild>
        <Button aria-label={t`Disconnect ${label}`} size="sm" variant="outline">
          {t`Disconnect`}
        </Button>
      </AlertDialogTrigger>
      <DisconnectContent
        connection={connection}
        label={label}
        last={last}
        onDone={() => {
          setOpen(false);
        }}
      />
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
    <DisconnectContent
      {...rest}
      onDone={() => {
        onOpenChange(false);
      }}
    />
  </AlertDialog>
);

/**
 * Whether `identity` chooses who may use `connection`
 * (connection-audience.tsx): one of the company's own
 * admins, never Grasp staff, on a shared connection still connected.
 * Core checks it again.
 */
const choosesAudience = (
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
 * Whether `other` is the same account as `connection`, as far as the page
 * can tell: the same name where both name one. A Composio connection names
 * none (Grasp never learns its account there), so one of a toolkit stands
 * for another; a suite's (Microsoft's, Google's) always names its account.
 */
const sameAccount = (
  other: ListedConnection,
  connection: ListedConnection
): boolean =>
  other.accountName === null ||
  connection.accountName === null ||
  other.accountName === connection.accountName;

/**
 * Whether `working`, a shared connection of an app that works, has taken
 * the place of `stopped`, a shared one of the same app that stopped
 * working: the same account (`sameAccount`). A working connection of
 * another account doesn't replace it. The one rule for a stopped row's
 * notice (`stoppedBesideWorking`) and for the success dialog's "connected
 * again" (`returnedOf`, connected-dialog.tsx).
 */
export const takesPlaceOf = (
  working: ListedConnection,
  stopped: ListedConnection
): boolean =>
  working.id !== stopped.id &&
  working.status === "active" &&
  working.scope === "shared" &&
  stopped.status === "needs_reauth" &&
  stopped.scope === "shared" &&
  sameAccount(working, stopped);

/**
 * Whether `connection` stopped working, can't be signed in to again, and a
 * shared connection of its app that works has taken its place
 * (`takesPlaceOf`), and `identity` may disconnect it: its row then says it
 * can go now (`StoppedNotice`). One that can be signed in to again offers
 * that instead (its row's Sign in again). Read from what the page lists,
 * on every load: never from the address, never from anything kept in the
 * browser.
 */
export const stoppedBesideWorking = (
  connection: ListedConnection,
  integration: Integration,
  identity: Pick<Identity, "role" | "staff">
): boolean =>
  mayDisconnect(connection, identity) &&
  !canReconnect(connection, integration.offered, identity) &&
  integration.connections.some((other) => takesPlaceOf(other, connection));

/**
 * A stopped connection's line on its row, beside one that works: that it
 * can be disconnected now, and the Disconnect question, which says what
 * goes with it. Nothing goes until it is confirmed there.
 */
export const StoppedNotice = ({
  connection,
  integration,
}: {
  connection: ListedConnection;
  integration: Integration;
}) => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  return (
    <>
      {t`A connection that works has taken its place, so this one can be disconnected now.`}{" "}
      <Button
        onClick={() => {
          setOpen(true);
        }}
        size="xs"
        variant="link"
      >
        {t`Disconnect it`}
      </Button>
      <DisconnectDialog
        connection={connection}
        label={connectionLabel(connection, integration)}
        last={!integration.listed && integration.connections.length === 1}
        onOpenChange={setOpen}
        open={open}
      />
    </>
  );
};

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
  const label = connectionLabel(connection, integration);
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
 * admins on a shared one, who may use it (its audience); and, for admins and builders, the Apps and agents holding a
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
  const { read: audiences, onChanged } = useConnectionAudiences(
    integration.connections.some((connection) =>
      choosesAudience(connection, identity)
    )
  );
  const holders = held?.state === "ready" ? held.data : undefined;
  const several = integration.connections.length > 1;
  return integration.connections.map((connection) => {
    const label = connectionLabel(connection, integration);
    const stuck =
      connection.status === "needs_reauth" &&
      !canReconnect(connection, integration.offered, identity);
    const consented = connection.source === "composio";
    const chooses = choosesAudience(connection, identity);
    // A connector's shared connection: an admin chooses for whom chats read in it.
    const points = chooses && connection.source === "connector";
    const holding =
      holders === undefined ? [] : holdingOf(holders, connection.id);
    if (!stuck && !consented && !chooses && holding.length === 0) {
      return null;
    }
    return (
      <SectionCard
        flush
        key={connection.id}
        title={several ? label : t`Access`}
      >
        {stuck || consented ? (
          <SettingsRows>
            {stuck ? (
              <RowAlert variant="warning">
                {ranOutText(
                  connection.source === "connector" ||
                    (connection.source === "native" &&
                      oauthProviderSchema.safeParse(connection.provider)
                        .success),
                  integration.offered,
                  identity.staff
                )}
              </RowAlert>
            ) : null}
            {consented ? <ConsentRecord connection={connection} /> : null}
          </SettingsRows>
        ) : null}
        {chooses ? (
          <AudienceChoice
            audiences={audiences}
            connection={connection}
            label={label}
            onChanged={onChanged}
          />
        ) : null}
        {points ? <ChatReads connection={connection} label={label} /> : null}
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
