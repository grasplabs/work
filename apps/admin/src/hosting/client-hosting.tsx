/**
 * A client's hosting, in its Setup in the admin (src/admin/setup.tsx),
 * folded away for staff: where it's placed, or where the admin places
 * it by itself, where its data is kept, its
 * operation, and trying again now once it stopped (src/hosting/placement.ts).
 * Which release it runs once live is its channel's or its pin's, which the
 * reconciler deploys (src/rollout/reconciler.ts): nothing here changes it.
 */
import { Button } from "@grasp-os/ui/components/button";
import { Checkbox } from "@grasp-os/ui/components/checkbox";
import { Field, FieldLabel } from "@grasp-os/ui/components/field";
import { rootRouteId, useNavigate, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";

import { formatTime } from "../releases/format.ts";
import { thenRefresh, useAction } from "../use-action.ts";
import {
  discardClientFn,
  offboardPlacedClientFn,
  retryProvisioningFn,
} from "./functions.ts";
import type { OffboardResult } from "./functions.ts";
import { hostingWords } from "./organization.ts";
import type { ClientHostingView } from "./placement.ts";
import {
  discardRefusals,
  notStartedWords,
  offboardRefusals,
  operationErrorWords,
  placeRefusals,
} from "./words.ts";

const statusWords: Readonly<
  Record<NonNullable<ClientHostingView["operation"]>["status"], string>
> = {
  running: "running",
  failed: "stopped",
  done: "done",
};

const destinationWords = ({ destinationId }: ClientHostingView): string =>
  destinationId === null
    ? "No destination: this admin's STAGE names no stage."
    : `Goes in ${destinationId}, Grasp's shared destination.`;

/**
 * Facts, as a list of terms: what each is in one column, the fact beside
 * it, in the text's own face, so the list reads as the rest of the page
 * and not as a log.
 */
const Facts = ({
  facts,
}: {
  facts: readonly (readonly [string, ReactNode])[];
}) => (
  <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[11rem_minmax(0,1fr)]">
    {facts.map(([term, value]) => (
      <div className="contents" key={term}>
        <dt className="text-muted-foreground">{term}</dt>
        <dd className="wrap-break-word">{value}</dd>
      </div>
    ))}
  </dl>
);

/** Run statuses of an attempt that ended without finishing. */
const endedRuns: ReadonlySet<string> = new Set([
  "errored",
  "terminated",
  "gone",
]);

/**
 * Why it stopped: the code its operation recorded, or, for one left
 * running by an attempt that ended without saying why, how that ended.
 */
const stopCodeOf = (
  operation: NonNullable<ClientHostingView["operation"]>,
  run: ClientHostingView["run"]
): string | null => {
  if (operation.error !== null) {
    return operation.error;
  }
  return operation.status === "running" && run !== null && endedRuns.has(run)
    ? `run_${run}`
    : null;
};

/** A stop's code, and what it means. */
const StopReason = ({ code }: { code: string | null }) =>
  code === null ? null : (
    <p className="text-destructive text-sm" role="alert">
      <span className="font-mono">{code}</span>
      {`: ${operationErrorWords(code)}`}
    </p>
  );

/** Where the client's provisioning operation is, as facts. */
const operationFacts = (
  operation: NonNullable<ClientHostingView["operation"]>,
  run: ClientHostingView["run"]
): (readonly [string, ReactNode])[] => [
  ["Release", operation.releaseId],
  ["Status", statusWords[operation.status]],
  ["Last step done", operation.step ?? "none yet"],
  ["Attempt", run ?? "none"],
  ["Started by", operation.startedBy],
  ["Updated (UTC)", formatTime(operation.updatedAt)],
];

/**
 * Offboarding it: its address out of the router at once, nothing deleted
 * (src/hosting/offboarding.ts). Deleting its resources is a second step,
 * once their retention is over, on Platform's Offboarded page.
 */
const Offboarding = ({ view }: { view: ClientHostingView }) => {
  const router = useRouter();
  const { busy, failure, run } = useAction(offboardRefusals);
  const [understood, setUnderstood] = useState(false);
  const act = (task: () => Promise<OffboardResult>) => {
    void run(
      async () =>
        await thenRefresh(task, async () => {
          await router.invalidate({ sync: true });
        })
    );
  };
  const { offboardedAt } = view;
  if (offboardedAt === null) {
    return (
      <div className="flex flex-col gap-3 border-t pt-4">
        <p className="text-sm">
          Offboarding takes its address out of the router at once: its people
          reach it no more. Nothing is deleted.
        </p>
        <Field orientation="horizontal">
          <Checkbox
            checked={understood}
            id="offboard-understood"
            onCheckedChange={setUnderstood}
          />
          <FieldLabel htmlFor="offboard-understood">
            It stops serving its people now
          </FieldLabel>
        </Field>
        <div className="flex flex-wrap items-center gap-4">
          <Button
            size="sm"
            disabled={busy || !understood}
            onClick={() => {
              act(
                async () =>
                  await offboardPlacedClientFn({
                    data: { clientId: view.clientId },
                  })
              );
            }}
            variant="destructive"
          >
            Offboard it
          </Button>
          {failure === null ? null : (
            <p className="text-destructive text-sm" role="alert">
              {failure}
            </p>
          )}
        </div>
      </div>
    );
  }
  return (
    <p className="border-t pt-4 text-sm">
      {`Offboarded on ${formatTime(offboardedAt)} UTC: its resources are deleted, after their retention, from Platform's Offboarded page.`}
    </p>
  );
};

/** That its core sends no mail, where its hosting gives it none yet. */
const mailNotice = (view: ClientHostingView): string | null =>
  view.hosting.hosting === "grasp_cloud"
    ? "Not available on this hosting yet (GRA-965). Its core sends none, so its people get their interview links by hand."
    : null;

/**
 * Discarding it: only for a client never placed, with nothing anywhere
 * (src/hosting/discard.ts). Its record goes, audited, and its id is free;
 * the page then goes back to every organization.
 */
const Discard = ({ view }: { view: ClientHostingView }) => {
  const navigate = useNavigate();
  const router = useRouter();
  const { busy, failure, run } = useAction(discardRefusals);
  const [understood, setUnderstood] = useState(false);
  const discard = () => {
    void run(async () => {
      const result = await discardClientFn({
        data: { clientId: view.clientId },
      });
      if (result.refused === null) {
        // The organizations stand a while (src/routes/__root.tsx): read
        // them again, so it leaves the list and the sidebar at once.
        await router.invalidate({
          filter: (match) => match.routeId === rootRouteId,
          sync: true,
        });
        await navigate({ to: "/" });
      }
      return result;
    });
  };
  return (
    <div className="flex flex-col gap-3 border-t pt-4">
      <p className="text-sm">
        Added by mistake, or for a test? It was never placed and nothing of it
        exists anywhere: discarding it removes its record, and its id can be
        used again. The audit log keeps what was done.
      </p>
      <Field orientation="horizontal">
        <Checkbox
          checked={understood}
          id="discard-understood"
          onCheckedChange={setUnderstood}
        />
        <FieldLabel htmlFor="discard-understood">
          Remove this organization for good
        </FieldLabel>
      </Field>
      <div className="flex flex-wrap items-center gap-4">
        <Button
          size="sm"
          disabled={busy || !understood}
          onClick={discard}
          variant="destructive"
        >
          Discard it
        </Button>
        {failure === null ? null : (
          <p className="text-destructive text-sm" role="alert">
            {failure}
          </p>
        )}
      </div>
    </div>
  );
};

/** Whether it may be discarded: never placed, nothing started, not live or offboarded. */
const discardable = (view: ClientHostingView): boolean =>
  view.placement === null &&
  view.operation === null &&
  !view.going &&
  !view.active &&
  view.offboardedAt === null;

/** Whether it's still to provision: not live, done, or offboarded. */
const provisionable = (view: ClientHostingView): boolean =>
  view.operation?.status !== "done" &&
  !view.active &&
  view.offboardedAt === null;

/**
 * Its hosting for staff, read-only: where it runs, where it is placed or
 * would go, what each requirement stands at, its operation, and once it
 * stopped or hasn't started, one button that tries again now, in the
 * automatic destination on the release it should run, as the admin does
 * by itself anyway.
 */
export const ClientHosting = ({ view }: { view: ClientHostingView }) => {
  const router = useRouter();
  const { busy, failure, run } = useAction(placeRefusals);
  const retry = () => {
    void run(async () => {
      // Refreshed even when it fails: the client may be placed already.
      const result = await thenRefresh(
        async () =>
          await retryProvisioningFn({ data: { clientId: view.clientId } }),
        async () => {
          await router.invalidate({ sync: true });
        }
      );
      return result;
    });
  };
  const stopped =
    provisionable(view) &&
    view.hosting.hosting === "grasp_cloud" &&
    !view.going &&
    view.operation?.status !== "done";
  const mail = mailNotice(view);
  return (
    <div className="flex flex-col gap-5">
      <Facts
        facts={[
          ["Where it runs", hostingWords(view.hosting)],
          [
            view.placement === null ? "Destination" : "Placed",
            view.placement === null
              ? destinationWords(view)
              : `Placed in ${view.placement.destinationId} by ${view.placement.placedBy} on ${formatTime(view.placement.placedAt)} UTC. It stays there: moving it is a migration.`,
          ],
          ...(mail === null ? [] : [["Mail", mail] as const]),
          ...(view.operation === null
            ? []
            : operationFacts(view.operation, view.run)),
        ]}
      />
      {view.operation === null ? null : (
        <StopReason code={stopCodeOf(view.operation, view.run)} />
      )}
      {view.placement === null ? null : <Offboarding view={view} />}
      {discardable(view) ? <Discard view={view} /> : null}
      {view.notStarted === null ? null : (
        <p className="text-sm">{notStartedWords(view.notStarted)}</p>
      )}
      {stopped ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-4">
            <Button disabled={busy} onClick={retry} size="sm" variant="outline">
              Retry now
            </Button>
            {failure === null ? null : (
              <p className="text-destructive text-sm" role="alert">
                {failure}
              </p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
};
