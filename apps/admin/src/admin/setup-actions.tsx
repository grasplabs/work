/**
 * What someone at Grasp does to a company's own Grasp, in its Setup
 * (src/admin/setup.tsx), as the admin's own client page did before the
 * admin took it in: pin it to a release, move it to another channel,
 * change how its people sign in, apply its settings now, rotate its
 * secrets. Each is the same server
 * function, audited as the staff member Access vouches for, and each
 * reads the Setup again after, whether it worked or not.
 *
 * Also what is read live of its account once the Setup shows (reach,
 * drift, shared secrets), as the admin's grid read it.
 */

import { fromBase64Url } from "@grasp-os/shared/encoding";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@grasp-os/ui/components/alert-dialog";
import { Button } from "@grasp-os/ui/components/button";
import { DatePicker } from "@grasp-os/ui/components/date-picker";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import { Input, SecretInput } from "@grasp-os/ui/components/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import { Text } from "@grasp-os/ui/components/text";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import {
  applySettingsFn,
  closeStaffWindowFn,
  fetchClientLive,
  fetchTeamsPackageFn,
  openStaffWindowFn,
  rotateSecretsFn,
  setSealedSecretFn,
  setSignInFn,
  setTeamsBotFn,
} from "../clients/functions.ts";
import type { LiveStatus, Reach } from "../clients/grid.ts";
import type { StaffWindowSetup } from "../clients/setup.ts";
import { SignInFields, signInOf, textOf } from "../clients/sign-in-fields.tsx";
import type { ClientSignInRecord } from "../clients/sign-in-schema.ts";
import type { TeamsBot } from "../clients/teams-bot.ts";
import { useSettingsAction } from "../clients/use-action.ts";
import type { StaffWindow } from "../deploy/core-config.ts";
import type { SealedSecretName } from "../deploy/sealed-secrets.ts";
import { formatTime } from "../releases/format.ts";
import { releaseName } from "../releases/version.ts";
import { channelIds } from "../rollout/channel-ids.ts";
import type { Channel } from "../rollout/channel-ids.ts";
import { channelWords } from "../rollout/channel-words.ts";
import type { ClientDriftState } from "../rollout/drift.ts";
import { pinClientFn, setChannelFn } from "../rollout/functions.ts";
import { useRolloutAction } from "../rollout/use-action.ts";
import { thenRefresh } from "../use-action.ts";
import { Actions, Facts, Failure, FormStack, Group } from "./setup-parts.tsx";
import type { Fact } from "./setup-parts.tsx";

const styles = stylex.create({
  // As wide as its longest choice, beside its buttons.
  days: { width: "8rem" },
});

/** Reads the page again after a change: whatever it shows, read anew. */
export type Refresh = () => Promise<void>;

/**
 * Reads the Setup again: its own route alone, so the frame's
 * organizations (every company's core asked) aren't read again with it.
 */
export const useRefreshSetup = (): Refresh => {
  const router = useRouter();
  return async () => {
    await router.invalidate({
      filter: (match) => match.routeId === "/organizations/$clientId/setup",
      sync: true,
    });
  };
};

// Its releases.

/** Pinning it to a release, and letting it follow its channel again. */
export const PinRelease = ({
  clientId,
  pinned,
  releases,
  refresh,
}: {
  clientId: string;
  pinned: string | null;
  /** The imported releases, newest first. */
  releases: readonly {
    id: string;
    notes: string;
  }[];
  refresh: Refresh;
}) => {
  const { busy, failure, run } = useRolloutAction();
  const pin = (releaseId: string | null) => {
    void run(
      async () =>
        await thenRefresh(
          async () => await pinClientFn({ data: { clientId, releaseId } }),
          refresh
        )
    );
  };
  return (
    <FormStack
      onSubmit={(event) => {
        event.preventDefault();
        pin(textOf(new FormData(event.currentTarget), "releaseId"));
      }}
    >
      <Field>
        <FieldLabel>Pin it to</FieldLabel>
        <NativeSelect
          defaultValue={pinned ?? releases[0]?.id ?? ""}
          // Keyed by the pin: it starts again from the one read after each change.
          key={pinned ?? ""}
          name="releaseId"
        >
          {releases.map((release) => (
            <NativeSelectOption key={release.id} value={release.id}>
              {releaseName(release)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <FieldDescription>
          {pinned === null
            ? "Not pinned: it gets each release promoted to its channel."
            : `Pinned to ${pinned}: promotions skip it. Unpinned, it goes to its channel's release.`}
        </FieldDescription>
      </Field>
      <Actions>
        <Button
          disabled={busy || releases.length === 0}
          size="sm"
          type="submit"
        >
          Pin
        </Button>
        {pinned === null ? null : (
          <Button
            disabled={busy}
            onClick={() => {
              pin(null);
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            Unpin
          </Button>
        )}
        <Failure failure={failure} />
      </Actions>
    </FormStack>
  );
};

/** Moving it to another release channel, which deploys it to that channel's release. */
export const ChannelChange = ({
  clientId,
  channel,
  refresh,
}: {
  clientId: string;
  channel: Channel;
  refresh: Refresh;
}) => {
  const { busy, failure, run } = useRolloutAction();
  return (
    <FormStack
      onSubmit={(event) => {
        event.preventDefault();
        const next = channelIds.find(
          (each) =>
            each === textOf(new FormData(event.currentTarget), "channel")
        );
        if (next === undefined) {
          return;
        }
        void run(
          async () =>
            await thenRefresh(
              async () =>
                await setChannelFn({ data: { clientId, channel: next } }),
              refresh
            )
        );
      }}
    >
      <Field>
        <FieldLabel>Channel</FieldLabel>
        <NativeSelect
          defaultValue={channel}
          // Keyed by the channel: it starts again from the one read after each change.
          key={channel}
          name="channel"
        >
          {channelIds.map((choice) => (
            <NativeSelectOption key={choice} value={choice}>
              {channelWords[choice]}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <FieldDescription>
          Edge gets every release as it lands, Beta and Stable the release
          someone at Grasp promotes. Moving it deploys that channel&apos;s
          release, unless it&apos;s pinned.
        </FieldDescription>
      </Field>
      <Actions>
        <Button disabled={busy} size="sm" type="submit" variant="outline">
          Save channel
        </Button>
        <Failure failure={failure} />
      </Actions>
    </FormStack>
  );
};

// Its settings.

/** Changing how its people sign in. */
export const SignInChange = ({
  clientId,
  signIn,
  refresh,
}: {
  clientId: string;
  signIn: ClientSignInRecord | null;
  refresh: Refresh;
}) => {
  const { busy, failure, run } = useSettingsAction();
  return (
    <FormStack
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        void run(
          async () =>
            await thenRefresh(
              async () =>
                await setSignInFn({
                  data: { clientId, signIn: signInOf(form) },
                }),
              refresh
            )
        );
      }}
    >
      {/* Keyed by what was read: the fields start again from it after a save. */}
      <FieldGroup key={JSON.stringify(signIn)}>
        <SignInFields current={signIn} />
      </FieldGroup>
      <Actions>
        <Button disabled={busy} size="sm" type="submit" variant="outline">
          Save sign-in
        </Button>
        <Failure failure={failure} />
      </Actions>
    </FormStack>
  );
};

/** What a staff window reaches, in words. */
const scopeWords = (window: StaffWindow): string =>
  window.scope === "onboarding"
    ? "The onboarding only"
    : "Everything an admin can";

/** Whether the staff window is open, in words. */
const openWords = (setup: StaffWindowSetup): string => {
  if (setup.window === null) {
    return "No";
  }
  return setup.open
    ? `Until ${formatTime(new Date(setup.window.until))}`
    : "No, it ended";
};

/**
 * Grasp's staff window on the company: opened from here for 1 to 7 days,
 * in the onboarding's scope, so staff can bring in its kickoff and steer
 * its onboarding; closed from here too. Either reaches its core once its
 * settings are applied.
 */
export const StaffWindowChange = ({
  clientId,
  setup,
  canChange,
  configPending,
  refresh,
}: {
  clientId: string;
  setup: StaffWindowSetup;
  canChange: boolean;
  configPending: boolean;
  refresh: Refresh;
}) => {
  const { busy, failure, run } = useSettingsAction();
  const [days, setDays] = useState("7");
  const { window } = setup;
  return (
    <>
      <Facts
        rows={[
          { label: "Open", value: openWords(setup) },
          ...(window === null
            ? []
            : [{ label: "Reaches", value: scopeWords(window) }]),
          ...(window !== null && configPending
            ? [
                {
                  label: "Live",
                  value: "Once its settings are applied",
                  attention: true,
                },
              ]
            : []),
        ]}
      />
      {canChange ? (
        <Actions>
          <NativeSelect
            aria-label="How long"
            disabled={busy}
            onChange={(event) => {
              setDays(event.currentTarget.value);
            }}
            size="sm"
            style={styles.days}
            value={days}
          >
            {["1", "2", "3", "7"].map((each) => (
              <NativeSelectOption key={each} value={each}>
                {each === "1" ? "1 day" : `${each} days`}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Button
            disabled={busy}
            onClick={() => {
              void run(
                async () =>
                  await thenRefresh(
                    async () =>
                      await openStaffWindowFn({
                        data: { clientId, days: Number(days) },
                      }),
                    refresh
                  )
              );
            }}
            size="sm"
            variant="outline"
          >
            {setup.open ? "Open it again from now" : "Open a staff window"}
          </Button>
          {window === null ? null : (
            <Button
              disabled={busy}
              onClick={() => {
                void run(
                  async () =>
                    await thenRefresh(
                      async () =>
                        await closeStaffWindowFn({ data: { clientId } }),
                      refresh
                    )
                );
              }}
              size="sm"
              variant="outline"
            >
              Close it
            </Button>
          )}
          <Failure failure={failure} />
        </Actions>
      ) : null}
    </>
  );
};

/** What waits for its next deploy, in words. */
const pendingWords = (
  configPending: boolean,
  pinned: string | null
): string => {
  if (!configPending) {
    return "Its core runs its sign-in as it is. A change reaches it with its next deploy: apply it now, or its next release carries it.";
  }
  if (pinned !== null) {
    return `Sign-in changed since its last deploy. It's pinned to ${pinned}, so no new release carries it: apply it now.`;
  }
  return "Sign-in changed since its last deploy: apply it now, or its next release carries it.";
};

/**
 * What waits for its next deploy, and applying its settings now: the
 * tab's one primary action while a change waits.
 */
export const ApplySettings = ({
  clientId,
  active,
  configPending,
  pinned,
  refresh,
}: {
  clientId: string;
  active: boolean;
  configPending: boolean;
  pinned: string | null;
  refresh: Refresh;
}) => {
  const { busy, failure, run } = useSettingsAction();
  return (
    <>
      <Text>{pendingWords(configPending, pinned)}</Text>
      {active ? (
        <Actions>
          <Button
            disabled={busy}
            onClick={() => {
              void run(
                async () =>
                  await thenRefresh(
                    async () => await applySettingsFn({ data: { clientId } }),
                    refresh
                  )
              );
            }}
            size="sm"
            variant={configPending ? "default" : "outline"}
          >
            Apply settings now
          </Button>
          <Text as="span" color="muted" size="sm">
            Deploys the release it runs, live at once.
          </Text>
          <Failure failure={failure} />
        </Actions>
      ) : null}
    </>
  );
};

/**
 * Setting its Teams bot: the app id and tenant of the bot's registration
 * in the company's own Entra, and the day its secret expires. Its connect
 * and core get it with the next deploy.
 */
export const TeamsBotChange = ({
  clientId,
  bot,
  refresh,
}: {
  clientId: string;
  bot: TeamsBot | null;
  refresh: Refresh;
}) => {
  const { busy, failure, run } = useSettingsAction();
  return (
    <FormStack
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        void run(
          async () =>
            await thenRefresh(
              async () =>
                await setTeamsBotFn({
                  data: {
                    clientId,
                    bot: {
                      appId: textOf(form, "appId"),
                      tenantId: textOf(form, "tenantId"),
                      secretExpiresOn: textOf(form, "secretExpiresOn"),
                    },
                  },
                }),
              refresh
            )
        );
      }}
    >
      {/* Keyed by what was read: the fields start again from it after a save. */}
      <FieldGroup key={JSON.stringify(bot)}>
        <Field>
          <FieldLabel>App id</FieldLabel>
          <Input
            autoComplete="off"
            defaultValue={bot?.appId ?? ""}
            mono
            name="appId"
            required
            spellCheck={false}
          />
          <FieldDescription>
            The bot app&apos;s Application (client) ID, from its registration in
            the company&apos;s own Entra.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel>Tenant</FieldLabel>
          <Input
            autoComplete="off"
            defaultValue={bot?.tenantId ?? ""}
            mono
            name="tenantId"
            required
            spellCheck={false}
          />
          <FieldDescription>
            The Directory (tenant) ID the bot app is registered in.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel>Secret expires on</FieldLabel>
          <DatePicker
            defaultValue={bot?.secretExpiresOn}
            name="secretExpiresOn"
            required
          />
          <FieldDescription>
            As Entra shows it beside the client secret.
          </FieldDescription>
        </Field>
      </FieldGroup>
      <Actions>
        <Button disabled={busy} size="sm" type="submit" variant="outline">
          Save bot
        </Button>
        {bot === null ? null : (
          <Button
            disabled={busy}
            onClick={() => {
              void run(
                async () =>
                  await thenRefresh(
                    async () =>
                      await setTeamsBotFn({ data: { clientId, bot: null } }),
                    refresh
                  )
              );
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            Remove bot
          </Button>
        )}
        <Failure failure={failure} />
      </Actions>
    </FormStack>
  );
};

/** Saves `bytes` as the file `fileName` in the browser. */
const saveFile = (fileName: string, bytes: Uint8Array<ArrayBuffer>): void => {
  const url = URL.createObjectURL(
    new Blob([bytes], { type: "application/zip" })
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
};

/** Downloads client `clientId`'s Teams app package; whether it could. */
const downloadTeamsPackage = async (clientId: string): Promise<boolean> => {
  try {
    const download = await fetchTeamsPackageFn({ data: { clientId } });
    if (download === null) {
      return false;
    }
    saveFile(download.fileName, fromBase64Url(download.zip));
    return true;
  } catch {
    return false;
  }
};

/**
 * Downloading its Teams app package, the one file its IT uploads to Teams
 * (src/clients/teams-package.ts).
 */
export const TeamsPackageDownload = ({ clientId }: { clientId: string }) => {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <Actions>
      <Button
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setFailed(false);
          void (async () => {
            const saved = await downloadTeamsPackage(clientId);
            setFailed(!saved);
            setBusy(false);
          })();
        }}
        size="sm"
        variant="outline"
      >
        Download app package
      </Button>
      <Text as="span" color="muted" size="sm">
        For its IT to upload in the Teams admin center, under Manage apps.
      </Text>
      <Failure
        failure={
          failed
            ? "The package couldn't be made: read the page again and retry."
            : null
        }
      />
    </Actions>
  );
};

/**
 * Setting one of its sealed secrets, or replacing it: sent once to the
 * admin, which seals it (src/clients/settings.ts) and never sends it
 * back, so the field always starts empty and is emptied again once it's
 * sent.
 */
export const SealedSecretChange = ({
  clientId,
  name,
  label,
  description,
  set,
  refresh,
}: {
  clientId: string;
  name: SealedSecretName;
  /** What the field asks for, such as "Client secret". */
  label: string;
  description: string;
  set: boolean;
  refresh: Refresh;
}) => {
  const { busy, failure, run } = useSettingsAction();
  return (
    <FormStack
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const value = textOf(new FormData(form), "value");
        form.reset();
        void run(
          async () =>
            await thenRefresh(
              async () =>
                await setSealedSecretFn({
                  data: { clientId, name, value },
                }),
              refresh
            )
        );
      }}
    >
      <Field>
        <FieldLabel>{set ? `New ${label.toLowerCase()}` : label}</FieldLabel>
        <SecretInput name="value" required spellCheck={false} />
        <FieldDescription>{description}</FieldDescription>
      </Field>
      <Actions>
        <Button disabled={busy} size="sm" type="submit" variant="outline">
          {set
            ? `Replace ${label.toLowerCase()}`
            : `Set ${label.toLowerCase()}`}
        </Button>
        <Failure failure={failure} />
      </Actions>
    </FormStack>
  );
};

/**
 * Rotating its secrets: everyone signs in again once the next deploy
 * makes them live, so asked first. Refused while the last rotation isn't
 * live yet, or went live within its window (src/deploy/rotation.ts).
 */
export const RotateSecrets = ({
  clientId,
  refresh,
}: {
  clientId: string;
  refresh: Refresh;
}) => {
  const { busy, failure, run } = useSettingsAction();
  const [notRotated, setNotRotated] = useState(false);
  const rotate = () => {
    void run(async () => {
      const result = await thenRefresh(
        async () => await rotateSecretsFn({ data: { clientId } }),
        refresh
      );
      setNotRotated(result.changed === false);
      return result;
    });
  };
  return (
    <Actions>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            disabled={busy}
            onClick={() => {
              setNotRotated(false);
            }}
            size="sm"
            variant="outline"
          >
            Rotate secrets
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rotate its secrets?</AlertDialogTitle>
            <AlertDialogDescription>
              Its people all sign in again once the next deploy makes the new
              secrets live.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep them</AlertDialogCancel>
            <AlertDialogAction onClick={rotate} variant="destructive">
              Rotate them
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Failure failure={failure} />
      <Failure
        failure={
          notRotated
            ? "Not rotated: its last rotation isn't live yet, or went live less than a week ago."
            : null
        }
      />
    </Actions>
  );
};

// What is read live of it.

const reachWords: Record<Reach, string> = {
  reachable: "Reachable",
  unreachable: "Not reachable",
  no_route: "The router has no route to it",
  unknown: "Not known",
};

const liveDriftWords: Record<ClientDriftState, string> = {
  in_sync: "In sync",
  drifted: "Changed outside the admin",
  split: "Traffic split between versions",
  off_pin: "Not on the release it is pinned to",
  unknown: "Not known",
};

/** Whether it runs the shared secrets in Secrets Store now, in words. */
const sharedWords = (current: boolean | null): string => {
  if (current === null) {
    return "Not known";
  }
  return current ? "Current" : "Behind: its next deploy brings it up";
};

/** Its account read live, or not: still reading (null), or it failed. */
type LiveRead = LiveStatus | "failed" | null;

/** Its account's live numbers as facts. */
const liveRows = (live: LiveStatus): Fact[] => [
  {
    label: "Reach",
    value: reachWords[live.reach],
    attention: live.reach === "unreachable" || live.reach === "no_route",
  },
  {
    label: "Drift",
    value: liveDriftWords[live.drift],
    attention: live.drift !== "in_sync" && live.drift !== "unknown",
  },
  {
    label: "Shared secrets",
    value: sharedWords(live.sharedSecretsCurrent),
    attention: live.sharedSecretsCurrent === false,
  },
];

/** Client `clientId`'s live numbers, or `failed` when they couldn't be read. Never throws. */
const readLive = async (clientId: string): Promise<LiveRead> => {
  try {
    return (await fetchClientLive({ data: { clientId } })) ?? "failed";
  } catch {
    return "failed";
  }
};

/**
 * What its account shows now, read once the Setup shows, as the admin's
 * grid read it: whether the router reaches its core, its drift, whether
 * it runs the shared secrets. Said only when one of them is off: a
 * company that is reachable, in sync and current is "Healthy" in its
 * facts already. Its Setup gives it a new key once what it runs
 * changed, so it is read again after a deploy.
 */
export const LiveNumbers = ({ clientId }: { clientId: string }) => {
  const [live, setLive] = useState<LiveRead>(null);
  useEffect(() => {
    let current = true;
    void (async () => {
      const read = await readLive(clientId);
      // A page left before its answer came doesn't take it.
      if (current) {
        setLive(read);
      }
    })();
    return () => {
      current = false;
    };
  }, [clientId]);
  if (live === null || live === "failed") {
    return null;
  }
  const rows = liveRows(live);
  return rows.some(({ attention }) => attention === true) ? (
    <Group id="numbers" title="Its platform in numbers">
      <Facts rows={rows} />
    </Group>
  ) : null;
};
