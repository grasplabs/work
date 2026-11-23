import type { OwnSession, SessionDevice } from "@grasp-os/shared/sign-in";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Icon, MonitorIcon } from "@grasp-os/ui/lib/icons";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import type { CoreConnection } from "../core-connection.ts";
import { formatDateTime } from "../format.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { ChatAppsSection } from "../settings/chat-accounts.tsx";
import type { ChatAccounts } from "../settings/chat-accounts.tsx";
import { pendingChatLink } from "../settings/chat-link.ts";
import { ConfirmAction } from "../settings/confirm-action.tsx";
import {
  SettingsError,
  SettingsGroup,
  SettingsPending,
  SettingsStack,
  TitleLine,
} from "../settings/section.tsx";
import { useCore } from "../use-core.ts";

// Settings › Security, as Damsko's settings pattern has it: the Chat apps
// card, and the devices the person is signed in on, this one marked. Each
// device but this one can be signed out here, after a yes; this one signs
// out from the person menu. Core names no place a session signed in from.
// How they sign in isn't shown here: the organization sets that up
// (Settings › Workspace).
//
// The Chat apps card (settings/chat-accounts.tsx) holds deleting the
// person's conversations with Stephen in chat apps, where they reach him,
// and the chat accounts linked to them. A link a chat app sent, which
// lands here (routes/chat-link.tsx), stands above it while one waits in
// this tab. Never for Grasp staff, who aren't the company's people.
// Devices show the newest ten, and all on a press.

/** What a session signed in on, in the page's language: "Chrome on macOS". */
const useDeviceName = ({ browser, system }: SessionDevice): string => {
  const { t } = useLingui();
  if (browser !== null && system !== null) {
    return t`${browser} on ${system}`;
  }
  return browser ?? system ?? t`Unknown device`;
};

/** One device the person is signed in on, and a way to sign it out, after a yes, unless it is this one. */
const DeviceRow = ({ session }: { session: OwnSession }) => {
  const { t } = useLingui();
  const core = useCore();
  const router = useRouter();
  const time = formatDateTime(session.signedInAt);
  const device = useDeviceName(session.device);
  const signOut = async (): Promise<void> => {
    // Gone either way once core answers: ended now, or ended already.
    // `sync` waits for the loader, so the row goes with its session.
    await changeThenRefresh(
      async () => {
        await core.withSession(
          async ({ sessions }) => await sessions.end(session.id)
        );
      },
      async () => {
        await router.invalidate({ sync: true });
      }
    );
  };
  return (
    <Item size="xs">
      <ItemMedia variant="icon">
        <Icon icon={MonitorIcon} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>
          <TitleLine>
            {device}
            {session.current ? (
              <Badge size="sm" variant="secondary">
                {t`This device`}
              </Badge>
            ) : null}
          </TitleLine>
        </ItemTitle>
        <ItemDescription>{t`Signed in ${time}`}</ItemDescription>
      </ItemContent>
      {session.current ? null : (
        <ItemActions>
          <ConfirmAction
            action={signOut}
            errorLabel={t`Not signed out`}
            label={t`Sign out`}
            title={t`Sign out this device?`}
            trigger={
              <Button
                aria-label={t`Sign out ${device}, signed in ${time}`}
                size="sm"
                variant="ghost"
              >
                {t`Sign out`}
              </Button>
            }
          />
        </ItemActions>
      )}
    </Item>
  );
};

/** How many devices show before "Show all": the newest. */
const shownAtFirst = 10;

/** The devices the person is signed in on, this one first, then latest active first. */
const Devices = ({ sessions }: { sessions: Loaded<OwnSession[]> }) => {
  const { t } = useLingui();
  const [showAll, setShowAll] = useState(false);
  if (sessions.state !== "ready") {
    return (
      <SettingsGroup flush={false} title={t`Devices`}>
        <NotLoadedState heading="h3" page={sessions} />
      </SettingsGroup>
    );
  }
  const devices = sessions.data.length;
  const newest = sessions.data.slice(0, shownAtFirst);
  const here = sessions.data.find(({ current }) => current);
  // This device stands in the list whenever it is signed in, however old.
  const shown =
    showAll || devices <= shownAtFirst
      ? sessions.data
      : [
          ...newest,
          ...(here === undefined || newest.includes(here) ? [] : [here]),
        ];
  // This device first: it is the one a person looks for, and can't sign out.
  const ordered =
    here === undefined
      ? shown
      : [here, ...shown.filter((session) => session !== here)];
  return (
    <SettingsGroup
      footer={
        shown.length < devices ? (
          <Button
            onClick={() => {
              setShowAll(true);
            }}
            size="sm"
            variant="ghost"
          >
            {t`Show all ${devices}`}
          </Button>
        ) : undefined
      }
      title={t`Devices`}
    >
      <ItemGroup aria-label={t`Devices`}>
        {ordered.map((session) => (
          <DeviceRow key={session.id} session={session} />
        ))}
      </ItemGroup>
    </SettingsGroup>
  );
};

const Security = () => {
  const { sessions, chat, waiting } = Route.useLoaderData();
  return (
    <SettingsStack>
      {chat === undefined ? null : (
        <ChatAppsSection chat={chat} waiting={waiting} />
      )}
      <Devices sessions={sessions} />
    </SettingsStack>
  );
};

/** Where Stephen is reached, the person's linked chat accounts, and the link a chat app sent them while one waits in this tab. */
const chatAccounts = async (
  core: Pick<CoreConnection, "withSession">,
  secret: string | undefined
): Promise<Loaded<ChatAccounts>> =>
  await loadFromCore(core, async (session) => {
    const [reach, accounts, preview] = await Promise.all([
      session.channelAccounts.reach(),
      session.channelAccounts.list(),
      secret === undefined
        ? undefined
        : session.channelAccounts.preview(secret),
    ]);
    return {
      reach,
      accounts,
      ...(secret === undefined || preview === undefined
        ? {}
        : { pending: { secret, preview } }),
    };
  });

/** The Chat apps card, then the devices, as many as fill the first screen. */
const SecurityPending = () => <SettingsPending groups={[1, 6]} />;

export const Route = createFileRoute("/_shell/settings/security")({
  pendingComponent: SecurityPending,
  errorComponent: SettingsError,
  component: Security,
  loader: async ({ context: { core, identity } }) => {
    const secret = pendingChatLink();
    const [sessions, chat] = await Promise.all([
      loadFromCore(core, async (session) => await session.sessions.list()),
      identity.staff ? undefined : chatAccounts(core, secret),
    ]);
    return {
      sessions,
      chat,
      waiting: secret !== undefined,
    };
  },
});
