import type { OwnSession, SessionDevice } from "@grasp-os/shared/sign-in";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { Switch } from "@grasp-os/ui/components/switch";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { LaptopIcon, SmartphoneIcon } from "lucide-react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import type { CoreConnection } from "../core-connection.ts";
import { deadline, unlessAborted } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import {
  SettingsError,
  SettingsLoading,
  SettingsRow,
  SettingsSection,
} from "../settings/settings-parts.tsx";
import { useCoreAction } from "../use-core-action.ts";

// Settings → Security, as in the prototype (`routes/settings/security.tsx`):
// how the person gets into Grasp, the devices they are signed in on, and
// the link for AI apps outside it. Each device but this one can be signed
// out here; this one signs out from the person menu. Core names no place
// a session signed in from, so the prototype's places aren't here. Grasp
// has no link for AI apps yet: it stays off.

/** The way people sign in here, when there is just the one; core's own name for it. */
const SignedInWith = ({ labels }: { labels: string[] }) => {
  const { t } = useLingui();
  const [only] = labels;
  return labels.length === 1 && only !== undefined ? (
    <span>{only}</span>
  ) : (
    <span>{t`Your organization’s account`}</span>
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

/** The device this page is open on, and when it signed in. */
const ThisDevice = ({ session }: { session: OwnSession }) => {
  const { t } = useLingui();
  const time = formatDateTime(session.signedInAt);
  const device = useDeviceName(session.device);
  return (
    <SettingsRow description={t`Signed in ${time}`} label={t`This device`}>
      <span className="truncate">{device}</span>
    </SettingsRow>
  );
};

/** One device the person is signed in on, and a way to sign it out unless it is this one. */
const DeviceRow = ({ session }: { session: OwnSession }) => {
  const { t } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const time = formatDateTime(session.signedInAt);
  const device = useDeviceName(session.device);
  const Icon = session.device.mobile ? SmartphoneIcon : LaptopIcon;
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
    <div className="flex items-center gap-3 border-t px-5 py-3">
      <Icon
        aria-hidden="true"
        className="text-muted-foreground size-4 flex-none"
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2">
          <span className="truncate">{device}</span>
          {session.current ? (
            <Badge variant="secondary">
              <Trans>This device</Trans>
            </Badge>
          ) : null}
        </span>
        <span className="text-muted-foreground">
          <Trans>Signed in {time}</Trans>
        </span>
        <ErrorText>{failure}</ErrorText>
      </div>
      {session.current ? null : (
        <Button
          aria-label={t`Sign out ${device}, signed in ${time}`}
          disabled={busy}
          onClick={() => {
            void signOut();
          }}
          size="sm"
          variant="ghost"
        >
          <Trans>Sign out</Trans>
        </Button>
      )}
    </div>
  );
};

/** The devices the person is signed in on, latest active first, this one marked. */
const Devices = ({ sessions }: { sessions: OwnSession[] }) => {
  const { t } = useLingui();
  const devices = sessions.length;
  return (
    <SettingsSection
      description={
        <Plural
          one="Signed in on # device. Sign out any you do not recognise."
          other="Signed in on # devices. Sign out any you do not recognise."
          value={devices}
        />
      }
      title={t`Devices`}
    >
      {sessions.map((session) => (
        <DeviceRow key={session.id} session={session} />
      ))}
    </SettingsSection>
  );
};

const Security = () => {
  const { t } = useLingui();
  const { identity } = Route.useRouteContext();
  const { labels, sessions } = Route.useLoaderData();
  const current =
    sessions.state === "ready"
      ? sessions.data.find((session) => session.current)
      : undefined;
  return (
    <>
      <SettingsSection
        description={t`How you get into Grasp. Passwords and two-step sign-in live with your organization’s account.`}
        title={t`Sign-in`}
      >
        <SettingsRow
          description={t`Your company account. Leaving the company stops new sign-ins; an admin can end a session sooner in Members and roles.`}
          label={t`Signed in with`}
        >
          <SignedInWith labels={labels} />
        </SettingsRow>
        <SettingsRow
          description={t`The account you signed in with.`}
          label={t`Email`}
        >
          <span className="truncate">{identity.email}</span>
        </SettingsRow>
        {current === undefined ? null : <ThisDevice session={current} />}
      </SettingsSection>

      {sessions.state === "ready" ? (
        <Devices sessions={sessions.data} />
      ) : (
        <SettingsSection title={t`Devices`}>
          <NotLoadedState heading="h3" page={sessions} />
        </SettingsSection>
      )}

      <SettingsSection
        description={t`Let an AI app such as Claude or ChatGPT use Grasp. It reads what Grasp knows, and it can show you a page. For anything else it asks you here first: nothing changes unless you allow it.`}
        title={t`AI apps`}
      >
        <SettingsRow
          description={t`Off. Nothing of this workspace is kept for an AI app.`}
          label={t`Link for AI apps`}
        >
          <Switch aria-label={t`Link for AI apps`} checked={false} disabled />
        </SettingsRow>
      </SettingsSection>
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

export const Route = createFileRoute("/_shell/settings/security")({
  pendingComponent: SettingsLoading,
  errorComponent: SettingsError,
  component: Security,
  loader: async ({ context: { core } }) => {
    const [labels, sessions] = await Promise.all([
      signInLabels(core),
      loadFromCore(core, async (session) => await session.sessions.list()),
    ]);
    return { labels, sessions };
  },
});
