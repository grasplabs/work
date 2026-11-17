import type { OwnSession, SessionDevice } from "@grasp-os/shared/sign-in";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute, useRouter } from "@tanstack/react-router";

import { changeThenRefresh } from "../change-then-refresh.ts";
import type { CoreConnection } from "../core-connection.ts";
import { deadline, unlessAborted } from "../core.ts";
import { formatDateTime } from "../format.ts";
import { Badge } from "../grasp/badge/index.ts";
import { Button } from "../grasp/button/index.ts";
import { Item, ItemGroup } from "../grasp/item/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { ChatAccountsSection } from "../settings/chat-accounts.tsx";
import type { ChatAccounts } from "../settings/chat-accounts.tsx";
import { pendingChatLink } from "../settings/chat-link.ts";
import {
  FactRow,
  RowNote,
  SectionNotLoaded,
  SettingsError,
  SettingsLoading,
  SettingsRows,
  TitleLine,
} from "../settings/section.tsx";
import { useCoreAction } from "../use-core-action.ts";

// Settings → Security: how the person gets into Grasp, and the devices
// they are signed in on. Each device but this one can be signed out here;
// this one signs out from the person menu. Core names no place a session
// signed in from. Then the chat apps where Grasp knows them
// (settings/chat-accounts.tsx), since Grasp answers a linked account as
// them; never for Grasp staff, who aren't the company's people.

/** The way people sign in here, when there is just the one; core's own name for it. */
const useSignedInWith = (labels: string[]): string => {
  const { t } = useLingui();
  const [only] = labels;
  return labels.length === 1 && only !== undefined
    ? only
    : t`Your organization’s account`;
};

/** What a session signed in on, in the page's language: "Chrome on macOS". */
const useDeviceName = ({ browser, system }: SessionDevice): string => {
  const { t } = useLingui();
  if (browser !== null && system !== null) {
    return t`${browser} on ${system}`;
  }
  return browser ?? system ?? t`Unknown device`;
};

/** One device the person is signed in on, and a way to sign it out unless it is this one. */
const DeviceRow = ({ session }: { session: OwnSession }) => {
  const { t } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const time = formatDateTime(session.signedInAt);
  const device = useDeviceName(session.device);
  const signOut = async (): Promise<void> => {
    // Gone either way once core answers: ended now, or ended already.
    await run(async ({ sessions }) => {
      // `sync` waits for the loader, so the row goes with its session.
      await changeThenRefresh(
        async () => await sessions.end(session.id),
        async () => {
          await router.invalidate({ sync: true });
        }
      );
    });
  };
  return (
    <Item
      {...(session.current
        ? {}
        : {
            actions: (
              // Plain words: a Button with a result reserves the width of its longest words, which leaves a phone's row no room.
              <Button
                aria-label={t`Sign out ${device}, signed in ${time}`}
                disabled={busy}
                onClick={() => {
                  void signOut();
                }}
                size="sm"
                variant="ghost"
              >
                {t`Sign out`}
              </Button>
            ),
          })}
      size="sm"
      title={
        <TitleLine
          detail={<RowNote failure={failure}>{t`Signed in ${time}`}</RowNote>}
        >
          {device}
          {session.current ? <Badge size="sm">{t`This device`}</Badge> : null}
        </TitleLine>
      }
    />
  );
};

/** The devices the person is signed in on, latest active first, this one marked. */
const Devices = ({ sessions }: { sessions: OwnSession[] }) => {
  const { t } = useLingui();
  const devices = sessions.length;
  return (
    <SectionCard
      description={t`${plural(devices, {
        one: "Signed in on # device. Sign out any you do not recognise.",
        other: "Signed in on # devices. Sign out any you do not recognise.",
      })}`}
      flush
      title={t`Devices`}
    >
      <ItemGroup aria-label={t`Devices`} separated>
        {sessions.map((session) => (
          <DeviceRow key={session.id} session={session} />
        ))}
      </ItemGroup>
    </SectionCard>
  );
};

const Security = () => {
  const { t } = useLingui();
  const { identity } = Route.useRouteContext();
  const { labels, sessions, chat } = Route.useLoaderData();
  const signedInWith = useSignedInWith(labels);
  return (
    <>
      <SectionCard
        description={t`Passwords and two-step sign-in live with your organization’s account.`}
        flush
        title={t`Sign-in`}
      >
        <SettingsRows>
          <FactRow
            help={t`Leaving the company stops new sign-ins.`}
            label={t`Signed in with`}
          >
            {signedInWith}
          </FactRow>
          <FactRow label={t`Email`}>{identity.email}</FactRow>
        </SettingsRows>
      </SectionCard>

      {sessions.state === "ready" ? (
        <Devices sessions={sessions.data} />
      ) : (
        <SectionCard title={t`Devices`}>
          <SectionNotLoaded page={sessions} />
        </SectionCard>
      )}

      {chat === undefined ? null : <ChatAccountsSection chat={chat} />}
    </>
  );
};

/** How people sign in here; none when core doesn't say in time. */
const signInLabels = async (
  core: Pick<CoreConnection, "api">
): Promise<string[]> => {
  try {
    const signal = deadline();
    const api = await core.api(signal);
    const options = await unlessAborted(
      Promise.resolve(api.signInOptions()),
      signal
    );
    return options.map(({ label }) => label);
  } catch {
    return [];
  }
};

/** The person's linked chat accounts, and the link they opened in this tab, if any. */
const chatAccounts = async (
  core: Pick<CoreConnection, "withSession">
): Promise<Loaded<ChatAccounts>> => {
  const secret = pendingChatLink();
  return await loadFromCore(core, async (session) => {
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
};

export const Route = createFileRoute("/_shell/settings/security")({
  pendingComponent: SettingsLoading,
  errorComponent: SettingsError,
  component: Security,
  loader: async ({ context: { core, identity } }) => {
    const [labels, sessions, chat] = await Promise.all([
      signInLabels(core),
      loadFromCore(core, async (session) => await session.sessions.list()),
      identity.staff ? undefined : chatAccounts(core),
    ]);
    return { labels, sessions, chat };
  },
});
