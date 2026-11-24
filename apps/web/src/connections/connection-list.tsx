import {
  composioConsentText,
  composioKeyConsentText,
  oauthProviderSchema,
} from "@grasp-os/shared/connect";
import type { ListedConnection } from "@grasp-os/shared/connect";
import type { Permission } from "@grasp-os/shared/permissions";
import { isAdmin, isMemberAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { Alert, AlertDescription } from "@grasp-os/ui/components/alert";
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
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldTitle,
} from "@grasp-os/ui/components/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemSeparator,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { KeyValueList } from "@grasp-os/ui/components/key-value";
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
import { BrainAudience, useBrainAudiences } from "./brain-audience.tsx";
import { canReconnect, ConnectDialog } from "./connect-dialog.tsx";
import type { Integration } from "./integrations.ts";
import { useChange } from "./use-change.ts";

// What an app's page says of each connection beyond its row (the app's
// page lists the accounts, app/page.tsx): signing in again and disconnecting from the
// row, and under the page's sections what each connection holds besides:
// why one whose access ran out can't be signed in to again, the consent a
// Composio one was made with, who may read in the Brain what agents read
// through a shared one, and which Apps and agents hold a permission for it.
// Connect and core check every reconnect, disconnect and revoke; the page
// leaves out only what the role can't do.

const styles = stylex.create({
  // A group's name in the card's flush rows, on their inset.
  head: {
    marginInline: space.tableCellInline,
    marginBlockStart: space["3"],
    marginBlockEnd: space["1"],
  },
  // A part of the card at its rows' inset, a hairline over every part but the first.
  part: {
    display: "grid",
    gap: space["2"],
    paddingBlock: space["3"],
    paddingInline: space.tableCellInline,
    borderBlockStartWidth: { default: sizes.hairline, ":first-child": 0 },
    borderBlockStartStyle: "solid",
    borderBlockStartColor: colors.border,
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
      <SectionHeader size="sm" style={styles.head} title={title} />
      <ItemGroup aria-label={title}>
        {holding.map((permission, index) => (
          <Fragment key={permission.id}>
            {index > 0 ? <ItemSeparator /> : null}
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
      <div {...stylex.props(styles.part)}>
        <KeyValueList
          items={[{ id: "consent", label: t`Consent`, value: tools }]}
          orientation="horizontal"
        />
      </div>
    );
  }
  return (
    <FieldGroup>
      <Field orientation="responsive">
        <FieldContent>
          <FieldTitle>{t`Consent`}</FieldTitle>
          <FieldDescription>
            {t`This is the consent as Grasp words it now. The audit log keeps a hash of the exact text they were shown.`}
          </FieldDescription>
        </FieldContent>
        <Collapsible fitContent>
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
      </Field>
    </FieldGroup>
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
  /** Closes the question once it is gone. */
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
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      )}
      <AlertDialogFooter>
        <AlertDialogCancel>{t`Close`}</AlertDialogCancel>
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
          size="sm"
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
 * Whether `connection` stopped working beside a shared connection of its
 * app that works, and `identity` may disconnect it: its row then says it
 * can go now (`StoppedNotice`). Read from what the page lists, on every
 * load: never from the address, never from anything kept in the browser.
 */
export const stoppedBesideWorking = (
  connection: ListedConnection,
  integration: Integration,
  identity: Pick<Identity, "role" | "staff">
): boolean =>
  connection.status === "needs_reauth" &&
  connection.scope === "shared" &&
  mayDisconnect(connection, identity) &&
  integration.connections.some(
    ({ id, status, scope }) =>
      id !== connection.id && status === "active" && scope === "shared"
  );

/**
 * A stopped connection's row, beside one that works: that it can be
 * disconnected now, and the Disconnect dialog, which says what goes with
 * it. Nothing goes until it is confirmed there.
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
        label={labelOf(connection, integration)}
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
      <Card asChild key={connection.id} size="sm">
        <section>
          <CardHeader>
            <CardTitle level={2}>{several ? label : t`Access`}</CardTitle>
          </CardHeader>
          <CardContent flush>
            {stuck ? (
              <div {...stylex.props(styles.part)}>
                <Alert variant="warning">
                  <AlertDescription>
                    {ranOutText(
                      connection.source === "native" &&
                        oauthProviderSchema.safeParse(connection.provider)
                          .success,
                      integration.offered,
                      identity.staff
                    )}
                  </AlertDescription>
                </Alert>
              </div>
            ) : null}
            {consented ? <ConsentRecord connection={connection} /> : null}
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
          </CardContent>
        </section>
      </Card>
    );
  });
};
