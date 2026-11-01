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
 * errors, drift, shared secrets), as the admin's grid read it,
 * and everything its audit log keeps of it.
 */
import { fromBase64Url } from "@grasp-os/shared/encoding";
import {
  Alert,
  AlertAction,
  AlertDescription,
} from "@grasp-os/ui/components/alert";
import { Button } from "@grasp-os/ui/components/button";
import { CardContent } from "@grasp-os/ui/components/card";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { useRouter } from "@tanstack/react-router";
import { TriangleAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import {
  applySettingsFn,
  fetchClientLive,
  fetchTeamsPackageFn,
  rotateSecretsFn,
  setSealedSecretFn,
  setSignInFn,
  setTeamsBotFn,
} from "../clients/functions.ts";
import type { LiveStatus, Reach } from "../clients/grid.ts";
import type { HistoryEntry } from "../clients/queries.ts";
import { SignInFields, signInOf, textOf } from "../clients/sign-in-fields.tsx";
import type { TeamsBot } from "../clients/teams-bot.ts";
import { useSettingsAction } from "../clients/use-action.ts";
import { channelIds } from "../db/schema.ts";
import type { Channel } from "../db/schema.ts";
import type { ClientSignInRecord } from "../deploy/core-config.ts";
import type { SealedSecretName } from "../deploy/sealed-secrets.ts";
import { formatTime } from "../releases/format.ts";
import { releaseName } from "../releases/version.ts";
import { channelWords } from "../rollout/channel-words.ts";
import type { ClientDriftState } from "../rollout/drift.ts";
import { pinClientFn, setChannelFn } from "../rollout/functions.ts";
import { useRolloutAction } from "../rollout/use-action.ts";
import { thenRefresh } from "../use-action.ts";
import { Facts, Failure, Quiet } from "./setup-parts.tsx";

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
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        pin(textOf(new FormData(event.currentTarget), "releaseId"));
      }}
    >
      <Field>
        <FieldLabel htmlFor="setup-pin">Pin it to</FieldLabel>
        <NativeSelect
          className="w-full"
          defaultValue={pinned ?? releases[0]?.id ?? ""}
          id="setup-pin"
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
      <div className="flex flex-wrap items-center gap-2">
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
      </div>
    </form>
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
    <form
      className="flex flex-col gap-3"
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
        <FieldLabel htmlFor="setup-channel">Channel</FieldLabel>
        <NativeSelect
          className="max-w-48"
          defaultValue={channel}
          id="setup-channel"
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
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={busy} size="sm" type="submit" variant="outline">
          Save channel
        </Button>
        <Failure failure={failure} />
      </div>
    </form>
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
    <form
      className="flex flex-col gap-4 border-t px-5 py-4"
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
        <SignInFields current={signIn} idPrefix="setup-sign-in" />
      </FieldGroup>
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={busy} size="sm" type="submit" variant="outline">
          Save sign-in
        </Button>
        <Failure failure={failure} />
      </div>
    </form>
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

/** What waits for its next deploy, and applying its settings now. */
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
    <CardContent>
      <p>{pendingWords(configPending, pinned)}</p>
      {active ? (
        <div className="flex flex-wrap items-center gap-3">
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
          <span className="text-muted-foreground">
            Deploys the release it runs, live at once.
          </span>
          <Failure failure={failure} />
        </div>
      ) : null}
    </CardContent>
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
    <form
      className="flex flex-col gap-4 border-t px-5 py-4"
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
          <FieldLabel htmlFor="setup-teams-bot-app">App id</FieldLabel>
          <Input
            autoComplete="off"
            className="max-w-md"
            defaultValue={bot?.appId ?? ""}
            id="setup-teams-bot-app"
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
          <FieldLabel htmlFor="setup-teams-bot-tenant">Tenant</FieldLabel>
          <Input
            autoComplete="off"
            className="max-w-md"
            defaultValue={bot?.tenantId ?? ""}
            id="setup-teams-bot-tenant"
            name="tenantId"
            required
            spellCheck={false}
          />
          <FieldDescription>
            The Directory (tenant) ID the bot app is registered in.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="setup-teams-bot-expiry">
            Secret expires on
          </FieldLabel>
          <Input
            className="max-w-xs"
            defaultValue={bot?.secretExpiresOn ?? ""}
            id="setup-teams-bot-expiry"
            name="secretExpiresOn"
            required
            type="date"
          />
          <FieldDescription>
            As Entra shows it beside the client secret.
          </FieldDescription>
        </Field>
      </FieldGroup>
      <div className="flex flex-wrap items-center gap-3">
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
            variant="ghost"
          >
            Remove bot
          </Button>
        )}
        <Failure failure={failure} />
      </div>
    </form>
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
    <div className="flex flex-wrap items-center gap-3">
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
      <span className="text-muted-foreground">
        For its IT to upload in the Teams admin center, under Manage apps.
      </span>
      {failed ? (
        <span className="text-destructive">
          The package couldn&apos;t be made: read the page again and retry.
        </span>
      ) : null}
    </div>
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
  const id = `setup-${name.toLowerCase().replaceAll("_", "-")}`;
  return (
    <form
      className="flex flex-col gap-3 border-t px-5 py-4"
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
        <FieldLabel htmlFor={id}>
          {set ? `New ${label.toLowerCase()}` : label}
        </FieldLabel>
        <Input
          autoComplete="off"
          className="max-w-md"
          id={id}
          name="value"
          required
          spellCheck={false}
          type="password"
        />
        <FieldDescription>{description}</FieldDescription>
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={busy} size="sm" type="submit" variant="outline">
          {set
            ? `Replace ${label.toLowerCase()}`
            : `Set ${label.toLowerCase()}`}
        </Button>
        <Failure failure={failure} />
      </div>
    </form>
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
  const [confirming, setConfirming] = useState(false);
  const [notRotated, setNotRotated] = useState(false);
  const rotate = () => {
    setConfirming(false);
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
    <CardContent>
      {confirming ? (
        <Alert variant="destructive">
          <TriangleAlertIcon aria-hidden />
          <AlertDescription>
            <p>
              Its people all sign in again once the next deploy makes the new
              secrets live.
            </p>
          </AlertDescription>
          <AlertAction placement="below">
            <Button
              disabled={busy}
              onClick={rotate}
              size="sm"
              variant="destructive"
            >
              Rotate them
            </Button>
            <Button
              onClick={() => {
                setConfirming(false);
              }}
              size="sm"
              variant="outline"
            >
              Keep them
            </Button>
          </AlertAction>
        </Alert>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            disabled={busy}
            onClick={() => {
              setNotRotated(false);
              setConfirming(true);
            }}
            size="sm"
            variant="outline"
          >
            Rotate secrets
          </Button>
          <Failure failure={failure} />
          {notRotated ? (
            <p className="text-destructive" role="alert">
              Not rotated: its last rotation isn&apos;t live yet, or went live
              less than a week ago.
            </p>
          ) : null}
        </div>
      )}
    </CardContent>
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
  return current ? "Current" : "Behind: a secrets rollout brings it up";
};

/** Its account read live, or not: still reading (null), or it failed. */
type LiveRead = LiveStatus | "failed" | null;

/** Its account's live numbers as facts. */
const liveRows = (
  live: LiveStatus
): { label: string; value: ReactNode; attention?: boolean }[] => [
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
 * What its account shows now, read once the Setup shows and kept a
 * minute, as the admin's grid read it: whether the router reaches its
 * core, its errors over the last day, its drift, whether it runs the
 * shared secrets. Only an active company is read.
 */
export const LiveNumbers = ({
  clientId,
  active,
}: {
  clientId: string;
  active: boolean;
}) => {
  const [live, setLive] = useState<LiveRead>(null);
  useEffect(() => {
    let current = true;
    if (active) {
      void (async () => {
        const read = await readLive(clientId);
        // A page left before its answer came doesn't take it.
        if (current) {
          setLive(read);
        }
      })();
    }
    return () => {
      current = false;
    };
  }, [active, clientId]);
  if (!active) {
    return <Quiet>Read once it is live.</Quiet>;
  }
  if (live === null) {
    return <Quiet>Reading its account…</Quiet>;
  }
  if (live === "failed") {
    return <Quiet>Its account couldn’t be read just now.</Quiet>;
  }
  return <Facts rows={liveRows(live)} />;
};

// Everything the audit log keeps of it.

/** Everything the audit log keeps of it, the newest first. */
export const History = ({ history }: { history: HistoryEntry[] }) =>
  history.length === 0 ? (
    <Quiet>Nothing yet.</Quiet>
  ) : (
    <div className="@container border-t">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead variant="card">When (UTC)</TableHead>
            <TableHead variant="card">Action</TableHead>
            <TableHead className="hidden @xl:table-cell" variant="card">
              By
            </TableHead>
            <TableHead className="hidden @2xl:table-cell" variant="card">
              On
            </TableHead>
            <TableHead className="hidden @3xl:table-cell" variant="card">
              Detail
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {history.map((entry) => (
            <TableRow key={entry.id}>
              <TableCell variant="card">
                <span className="tabular-nums">{formatTime(entry.at)}</span>
              </TableCell>
              <TableCell variant="card">
                <span className="font-mono text-xs">{entry.action}</span>
              </TableCell>
              <TableCell
                className="hidden whitespace-normal @xl:table-cell"
                variant="card"
              >
                <span className="text-muted-foreground">{entry.actor}</span>
              </TableCell>
              <TableCell className="hidden @2xl:table-cell" variant="card">
                <span className="font-mono text-xs">{entry.target ?? ""}</span>
              </TableCell>
              <TableCell
                className="hidden whitespace-normal @3xl:table-cell"
                variant="card"
              >
                <span className="font-mono text-xs break-all">
                  {entry.detail ?? ""}
                </span>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
