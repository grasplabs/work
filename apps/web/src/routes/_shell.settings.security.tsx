import type { SignInOption } from "@grasp-os/shared/rpc";
import type { OwnSession, SessionDevice } from "@grasp-os/shared/sign-in";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute, useRouter } from "@tanstack/react-router";

import { changeThenRefresh } from "../change-then-refresh.ts";
import type { CoreConnection } from "../core-connection.ts";
import { deadline, unlessAborted } from "../core.ts";
import { formatDateTime } from "../format.ts";
import { Badge } from "../grasp/badge/index.ts";
import { BrandIcon, brands } from "../grasp/brand-icon/index.ts";
import type { Brand } from "../grasp/brand-icon/index.ts";
import { Button } from "../grasp/button/index.ts";
import { Desktop, Phone } from "../grasp/icons/index.ts";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { FactRow, SettingsRows } from "../grasp/setting-row/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { ChatAccountsSection } from "../settings/chat-accounts.tsx";
import type { ChatAccounts } from "../settings/chat-accounts.tsx";
import { pendingChatLink } from "../settings/chat-link.ts";
import {
  RowNote,
  SectionNotLoaded,
  SettingsError,
  SettingsLoading,
  TitleLine,
} from "../settings/section.tsx";
import { useCoreAction } from "../use-core-action.ts";

// Settings › Security, as the library's Settings pattern has it (like
// Profile): one compact card that says what the person signs in with, the
// provider's mark and their organization's name; and one with the devices
// they are signed in on, each with its kind's icon, this one marked. Each
// device but this one can be signed out here; this one signs out from the
// person menu. Core names no place a session signed in from.
//
// The chat apps where Grasp knows the person (settings/chat-accounts.tsx)
// are not listed here any more. A link a chat app sent still lands here
// (routes/chat-link.tsx), so while one waits in this tab the chat apps card
// shows, to confirm or turn it down; never for Grasp staff, who aren't the
// company's people.

const styles = stylex.create({
  // The provider's mark beside the organization's name.
  signedInWith: {
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space2,
    minWidth: 0,
  },
});

/** Whether a sign-in provider has a mark of its own: core's ids are the brands' ("microsoft", "google"). */
const isBrand = (id: string): id is Brand => Object.hasOwn(brands, id);

/** The staff's own way in (core's `providerIds.staff`): not the organization's. */
const staffProvider = "grasp-staff";

/**
 * What the person signed in with: the organization's one way in, with its
 * mark, and the organization's name; for Grasp staff, Grasp's own. With
 * more than one way in, core can't say which they used, so no mark.
 */
const SignedInWith = ({
  options,
  organization,
  staff,
}: {
  options: SignInOption[];
  organization: string | undefined;
  staff: boolean;
}) => {
  const { t } = useLingui();
  const own = options.filter(
    ({ providerId }) => (providerId === staffProvider) === staff
  );
  const [only] = own;
  const provider = own.length === 1 ? only : undefined;
  const name = staff
    ? (provider?.label ?? "Grasp")
    : (organization ?? provider?.label ?? t`Your organization’s account`);
  return (
    <span {...stylex.props(styles.signedInWith)}>
      {provider !== undefined && isBrand(provider.providerId) ? (
        <BrandIcon brand={provider.providerId} tile={false} />
      ) : null}
      {name}
    </span>
  );
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
    <Item size="xs">
      <ItemMedia
        icon={session.device.mobile ? Phone : Desktop}
        iconLook="inline"
      />
      <ItemContent>
        <ItemTitle>
          <TitleLine>
            {device}
            {session.current ? <Badge size="sm">{t`This device`}</Badge> : null}
          </TitleLine>
        </ItemTitle>
        <ItemDescription>
          <RowNote failure={failure}>{t`Signed in ${time}`}</RowNote>
        </ItemDescription>
      </ItemContent>
      {session.current ? null : (
        <ItemActions>
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
        </ItemActions>
      )}
    </Item>
  );
};

/** The devices the person is signed in on, latest active first, this one marked. */
const Devices = ({ sessions }: { sessions: Loaded<OwnSession[]> }) => {
  const { t } = useLingui();
  if (sessions.state !== "ready") {
    return (
      <SectionCard density="compact" title={t`Devices`}>
        <SectionNotLoaded page={sessions} />
      </SectionCard>
    );
  }
  const devices = sessions.data.length;
  return (
    <SectionCard
      density="compact"
      description={t`${plural(devices, {
        one: "Signed in on # device. Sign out any you do not recognise.",
        other: "Signed in on # devices. Sign out any you do not recognise.",
      })}`}
      flush
      title={t`Devices`}
    >
      <ItemGroup aria-label={t`Devices`} separated>
        {sessions.data.map((session) => (
          <DeviceRow key={session.id} session={session} />
        ))}
      </ItemGroup>
    </SectionCard>
  );
};

const Security = () => {
  const { t } = useLingui();
  const { identity } = Route.useRouteContext();
  const { options, organization, sessions, chat } = Route.useLoaderData();
  return (
    <>
      <SectionCard density="compact" flush title={t`Sign-in`}>
        <SettingsRows>
          <FactRow
            help={t`Passwords and two-step sign-in live with your organization’s account.`}
            label={t`Signed in with`}
          >
            <SignedInWith
              options={options}
              organization={organization}
              staff={identity.staff}
            />
          </FactRow>
        </SettingsRows>
      </SectionCard>
      <Devices sessions={sessions} />
      {chat === undefined ? null : <ChatAccountsSection chat={chat} />}
    </>
  );
};

/** How people sign in here; none when core doesn't say in time. */
const signInOptions = async (
  core: Pick<CoreConnection, "api">
): Promise<SignInOption[]> => {
  try {
    const signal = deadline();
    const api = await core.api(signal);
    return await unlessAborted(Promise.resolve(api.signInOptions()), signal);
  } catch {
    return [];
  }
};

/** The organization's name; none when it has none or core doesn't say in time. */
const organizationName = async (
  core: Pick<CoreConnection, "withSession">
): Promise<string | undefined> => {
  const read = await loadFromCore(
    core,
    async (session) => await session.organization.get()
  );
  const name = read.state === "ready" ? read.data.name.trim() : "";
  return name === "" ? undefined : name;
};

/** The person's linked chat accounts and the link a chat app sent them, while one waits in this tab. */
const chatAccounts = async (
  core: Pick<CoreConnection, "withSession">,
  secret: string
): Promise<Loaded<ChatAccounts>> =>
  await loadFromCore(core, async (session) => {
    const [reach, accounts, preview] = await Promise.all([
      session.channelAccounts.reach(),
      session.channelAccounts.list(),
      session.channelAccounts.preview(secret),
    ]);
    return { reach, accounts, pending: { secret, preview } };
  });

export const Route = createFileRoute("/_shell/settings/security")({
  pendingComponent: SettingsLoading,
  errorComponent: SettingsError,
  component: Security,
  loader: async ({ context: { core, identity } }) => {
    const secret = pendingChatLink();
    const [options, organization, sessions, chat] = await Promise.all([
      signInOptions(core),
      organizationName(core),
      loadFromCore(core, async (session) => await session.sessions.list()),
      identity.staff || secret === undefined
        ? undefined
        : chatAccounts(core, secret),
    ]);
    return { options, organization, sessions, chat };
  },
});
