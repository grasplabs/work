/**
 * What someone at Grasp does to a company's own Grasp, in its Setup
 * (src/admin/setup.tsx), as the admin's own client page did before the
 * admin took it in: follow and steer setting it up (confirm Workers Paid,
 * resume), pin it to a release, move it to another ring, change how its
 * people sign in, apply its settings now, rotate its secrets, roll it
 * back from the rollout that last reached it. Each is the same server
 * function, audited as the staff member Access vouches for, and each
 * reads the Setup again after, whether it worked or not.
 *
 * Also what is read live of its account once the Setup shows (reach,
 * errors, drift, shared secrets, cost), as the admin's grid read it,
 * and everything its audit log keeps of it.
 */
import { Button } from "@grasp-os/ui/components/button";
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
import { Link, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { z } from "zod";

import { usd } from "../clients/cost.tsx";
import {
  applySettingsFn,
  fetchClientLive,
  rotateSecretsFn,
  setRingFn,
  setSealedSecretFn,
  setSignInFn,
} from "../clients/functions.ts";
import type { LiveStatus, Reach } from "../clients/grid.ts";
import type { HistoryEntry } from "../clients/queries.ts";
import type { ClientSetup } from "../clients/setup.ts";
import { SignInFields, signInOf, textOf } from "../clients/sign-in-fields.tsx";
import { useSettingsAction } from "../clients/use-action.ts";
import type { ClientSignInRecord } from "../deploy/core-config.ts";
import {
  confirmClientWorkersPaid,
  retryClient,
} from "../provision/functions.ts";
import type { ProvisioningView } from "../provision/queries.ts";
import { useProvisionAction } from "../provision/use-action.ts";
import { formatTime } from "../releases/format.ts";
import type { ClientDriftState } from "../rollout/drift.ts";
import { pinClientFn, rollbackClientFn } from "../rollout/functions.ts";
import { useRolloutAction } from "../rollout/use-action.ts";
import { thenRefresh } from "../use-action.ts";
import { Body, Facts, Failure, Quiet } from "./setup-parts.tsx";

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

const dashboard = (accountId: string): string =>
  `https://dash.cloudflare.com/${accountId}`;

// Setting it up.

/** What someone at Grasp does while the run waits for Workers Paid. */
const WorkersPaid = ({
  view,
  refresh,
}: {
  view: ProvisioningView;
  refresh: Refresh;
}) => {
  const { busy, failure, run } = useProvisionAction();
  const confirm = () => {
    void run(
      async () =>
        await thenRefresh(
          async () =>
            await confirmClientWorkersPaid({
              data: { clientId: view.clientId },
            }),
          refresh
        )
    );
  };
  return (
    <>
      <ol className="flex list-decimal flex-col gap-2 pl-5">
        <li>
          <a
            className="underline underline-offset-4"
            href={dashboard(view.client?.accountId ?? "")}
            rel="noopener noreferrer"
            target="_blank"
          >
            Open the account in the Cloudflare dashboard
          </a>{" "}
          and upgrade it to Workers Paid.
        </li>
        <li>Turn on R2 in the same account: the deploy creates buckets.</li>
        <li>Confirm below; the deploy starts at once.</li>
      </ol>
      {view.workersPaidConfirmed ? (
        // Confirmed already: the run goes on by itself, and the page follows.
        <p>Confirmed, waiting for the run.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={busy} onClick={confirm} size="sm">
            Workers Paid is on
          </Button>
          <Failure failure={failure} />
        </div>
      )}
    </>
  );
};

/** Why the run stopped, and resuming it. */
const Stopped = ({
  view,
  refresh,
}: {
  view: ProvisioningView;
  refresh: Refresh;
}) => {
  const { busy, failure, run } = useProvisionAction();
  const resume = () => {
    void run(
      async () =>
        await thenRefresh(
          async () => await retryClient({ data: { clientId: view.clientId } }),
          refresh
        )
    );
  };
  if (view.client === null) {
    // It stopped before it recorded the company: nothing to resume.
    return (
      <>
        <p>{`The run stopped: ${view.stopped?.error ?? "before it recorded the company"}.`}</p>
        <p className="text-muted-foreground">
          Fix what it says, or pick another account, and{" "}
          <Link
            className="hover:text-foreground underline underline-offset-4"
            to="/new-organization"
          >
            add it again
          </Link>{" "}
          with the same address.
        </p>
      </>
    );
  }
  let reason = "its run is gone (Workflows keeps a run for a while only)";
  if (view.stopped !== null) {
    reason = `${view.stopped.step} step: ${view.stopped.error}`;
  } else if (view.run === "terminated") {
    reason = "it was ended outside the admin";
  } else if (view.run !== null && view.run !== "gone") {
    reason = `it failed after its retries${
      view.deploy === null || view.deploy.error === null
        ? ""
        : ` (${view.deploy.error})`
    }`;
  }
  return (
    <>
      <p>{`The run stopped: ${reason}.`}</p>
      <p className="text-muted-foreground">
        Fix what it says, then resume: it picks up from the deploy if it got
        that far, and makes nothing twice.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={busy} onClick={resume} size="sm">
          Resume
        </Button>
        <Failure failure={failure} />
      </div>
    </>
  );
};

/** Where setting a company up is now, and what someone at Grasp does there. */
export const SettingUpNow = ({
  view,
  refresh,
}: {
  view: ProvisioningView;
  refresh: Refresh;
}) => {
  switch (view.phase) {
    case "account": {
      return (
        <Body>
          <p>Setting up: its Cloudflare account, then its record.</p>
        </Body>
      );
    }
    case "workers_paid": {
      return (
        <Body>
          <WorkersPaid refresh={refresh} view={view} />
        </Body>
      );
    }
    case "deploying": {
      return (
        <Body>
          <p>
            {`Deploying ${view.deploy?.releaseId ?? "the release"}: ${
              view.deploy?.step === null || view.deploy === null
                ? "starting"
                : `${view.deploy.step} done`
            }.`}
          </p>
        </Body>
      );
    }
    case "failed": {
      return (
        <Body>
          <Stopped refresh={refresh} view={view} />
        </Body>
      );
    }
    case "active": {
      return (
        <Body>
          <p>{`Live at https://${view.hostname ?? ""}, and passed its smoke check.`}</p>
        </Body>
      );
    }
    default: {
      return null;
    }
  }
};

// Its releases.

/** A release in a line, for a list to choose from: its id, and its notes. */
const releaseLine = ({ id, notes }: { id: string; notes: string }): string =>
  notes === "" ? id : `${id} · ${notes}`;

/** Pinning it to a release, and letting it follow the rollouts again. */
export const PinRelease = ({
  clientId,
  pinned,
  releases,
  refresh,
}: {
  clientId: string;
  pinned: string | null;
  /** The imported releases, newest first. */
  releases: readonly { id: string; notes: string }[];
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
              {releaseLine(release)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <FieldDescription>
          {pinned === null
            ? "Not pinned: every rollout reaches it."
            : `Pinned to ${pinned}: rollouts of any other release skip it.`}
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

/** Moving it to another ring. */
export const RingChange = ({
  clientId,
  ring,
  refresh,
}: {
  clientId: string;
  ring: number;
  refresh: Refresh;
}) => {
  const { busy, failure, run } = useSettingsAction();
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const next = Number(textOf(new FormData(event.currentTarget), "ring"));
        void run(
          async () =>
            await thenRefresh(
              async () => await setRingFn({ data: { clientId, ring: next } }),
              refresh
            )
        );
      }}
    >
      <Field>
        <FieldLabel htmlFor="setup-ring">Ring</FieldLabel>
        <Input
          className="max-w-32"
          defaultValue={ring}
          id="setup-ring"
          // Keyed by the ring: it starts again from the one read after each change.
          key={ring}
          min={0}
          name="ring"
          required
          type="number"
        />
        <FieldDescription>
          When rollouts reach it: ring 0 first. Rollouts started from now on use
          it.
        </FieldDescription>
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={busy} size="sm" type="submit" variant="outline">
          Save ring
        </Button>
        <Failure failure={failure} />
      </div>
    </form>
  );
};

/** A rollout target's statuses once a step of it started there: what a rollback can undo. */
const reached: ReadonlySet<NonNullable<ClientSetup["rollout"]>["target"]> =
  new Set(["deploying", "done", "failed", "stopped"]);

/**
 * Rolling it back from the latest rollout that reached it, to what it ran
 * before. A secrets rollout's rollback puts the old shared secrets back,
 * which may be revoked at their providers already: asked first.
 */
export const RollBack = ({
  clientId,
  rollout,
  refresh,
}: {
  clientId: string;
  rollout: ClientSetup["rollout"];
  refresh: Refresh;
}) => {
  const { busy, failure, run } = useRolloutAction();
  const [confirming, setConfirming] = useState(false);
  if (rollout === null || !reached.has(rollout.target)) {
    return null;
  }
  const rollBack = () => {
    setConfirming(false);
    void run(
      async () =>
        await thenRefresh(
          async () =>
            await rollbackClientFn({
              data: { rolloutId: rollout.id, clientId },
            }),
          refresh
        )
    );
  };
  return (
    <Body>
      <p className="text-muted-foreground">
        {`Rolling it back from ${rollout.releaseId ?? "the secrets rollout"} puts back what it ran before, and waits for it.`}
      </p>
      {confirming ? (
        <div
          className="border-destructive flex flex-col gap-2 rounded-md border p-4"
          role="alert"
        >
          <p>
            Rolling it back puts the shared secrets it ran before back. If you
            revoked them at their providers, its people can&apos;t sign in or
            reach their connections until the next secrets rollout.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy}
              onClick={rollBack}
              size="sm"
              variant="destructive"
            >
              Roll back anyway
            </Button>
            <Button
              onClick={() => {
                setConfirming(false);
              }}
              size="sm"
              variant="outline"
            >
              Keep the new secrets
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            disabled={busy}
            onClick={() => {
              if (rollout.kind === "secrets") {
                setConfirming(true);
              } else {
                rollBack();
              }
            }}
            size="sm"
            variant="outline"
          >
            Roll it back
          </Button>
          <Failure failure={failure} />
        </div>
      )}
    </Body>
  );
};

// Its settings.

/** Changing how its people sign in. */
export const SignInChange = ({
  clientId,
  signIn,
  overridden,
  refresh,
}: {
  clientId: string;
  signIn: ClientSignInRecord | null;
  overridden: boolean;
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
      {overridden ? (
        <p>A SIGN_IN setting replaces this on deploy, until it is removed.</p>
      ) : null}
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
    return "Its core runs its sign-in as it is. A change reaches it with its next deploy: apply it now, or a rollout that reaches it deploys it.";
  }
  if (pinned !== null) {
    return `Sign-in changed since its last deploy. It's pinned to ${pinned}, so only a rollout of that release reaches it: apply it now.`;
  }
  return "Sign-in changed since its last deploy: apply it now, or the next rollout that reaches it deploys it, even on the release it runs.";
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
    <Body>
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
    </Body>
  );
};

/**
 * Setting its Teams bot's secret, or replacing it: sent once to the admin,
 * which seals it (src/clients/settings.ts) and never sends it back, so the
 * field always starts empty and is emptied again once it's sent.
 */
export const TeamsBotSecretChange = ({
  clientId,
  set,
  refresh,
}: {
  clientId: string;
  set: boolean;
  refresh: Refresh;
}) => {
  const { busy, failure, run } = useSettingsAction();
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
                  data: { clientId, name: "TEAMS_BOT_SECRET", value },
                }),
              refresh
            )
        );
      }}
    >
      <Field>
        <FieldLabel htmlFor="setup-teams-bot-secret">
          {set ? "New client secret" : "Client secret"}
        </FieldLabel>
        <Input
          autoComplete="off"
          className="max-w-md"
          id="setup-teams-bot-secret"
          name="value"
          required
          spellCheck={false}
          type="password"
        />
        <FieldDescription>
          The bot app&apos;s client secret, from its registration in the
          company&apos;s own Entra. It is sealed and never shown again, here or
          anywhere; its connect gets it with the next deploy.
        </FieldDescription>
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={busy} size="sm" type="submit" variant="outline">
          {set ? "Replace secret" : "Set secret"}
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
    <Body>
      {confirming ? (
        <div
          className="border-destructive flex flex-col gap-2 rounded-md border p-4"
          role="alert"
        >
          <p>
            Its people all sign in again once the next deploy makes the new
            secrets live.
          </p>
          <div className="flex flex-wrap gap-2">
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
          </div>
        </div>
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
    </Body>
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

const percent = new Intl.NumberFormat("en", {
  style: "percent",
  maximumFractionDigits: 1,
});

/** The last day's errors, in words: unknown, none asked, or their share. */
const errorsWords = (day: LiveStatus["day"]): string => {
  if (day === null) {
    return "Not known";
  }
  if (day.requests === 0) {
    return "No requests";
  }
  return `${percent.format(day.errors / day.requests)} of ${day.requests}`;
};

/** Whether it runs the shared secrets in Secrets Store now, in words. */
const sharedWords = (current: boolean | null): string => {
  if (current === null) {
    return "Not known";
  }
  return current ? "Current" : "Behind: a secrets rollout brings it up";
};

/** What it cost this month so far, with its AI Gateway share. */
const costWords = (cost: LiveStatus["costUsd"]): string =>
  cost === null
    ? "Not known"
    : `${usd.format(cost.workers + cost.ai)} (AI ${usd.format(cost.ai)})`;

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
  { label: "Errors, last 24 h", value: errorsWords(live.day) },
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
  { label: "Cost this month", value: costWords(live.costUsd) },
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
 * shared secrets, and what it cost this month (an estimate: its Workers
 * Paid plan past what it includes, and AI Gateway spend; not storage or
 * Durable Objects). Only an active company is read.
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

/** The actions whose target is a rollout's id: the others name a version, a release or nothing. */
const rolloutActions: ReadonlySet<string> = new Set([
  "rollout.client_start",
  "rollout.client_done",
  "rollout.client_skip",
  "rollout.client_stop",
  "rollout.rollback",
  "rollout.client_rolled_back",
]);

/** The rollout an entry names, to link its page; null for any other. */
const rolloutOf = (entry: HistoryEntry): string | null =>
  rolloutActions.has(entry.action) && z.uuid().safeParse(entry.target).success
    ? entry.target
    : null;

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
          {history.map((entry) => {
            const rolloutId = rolloutOf(entry);
            return (
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
                  {rolloutId === null ? (
                    <span className="font-mono text-xs">
                      {entry.target ?? ""}
                    </span>
                  ) : (
                    <Link
                      className="hover:text-foreground font-mono text-xs underline underline-offset-4"
                      params={{ rolloutId }}
                      to="/platform/rollouts/$rolloutId"
                    >
                      {rolloutId.slice(0, 8)}
                    </Link>
                  )}
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
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
