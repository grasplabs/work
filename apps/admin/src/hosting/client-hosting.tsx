/**
 * A client's hosting, in its Setup in the admin (src/admin/setup.tsx),
 * folded away for staff: where it's placed, or where the admin places
 * it by itself, where its data is kept, its
 * operation, and trying again now once it stopped (src/hosting/placement.ts).
 * Once it's live, releasing it to a later release and rolling it back to
 * the one before, which run the same operation again.
 */
import { Button } from "@grasp-os/ui/components/button";
import { Checkbox } from "@grasp-os/ui/components/checkbox";
import { Field, FieldLabel } from "@grasp-os/ui/components/field";
import {
  NativeSelect,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import { rootRouteId, useNavigate, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { formatTime } from "../releases/format.ts";
import { thenRefresh, useAction } from "../use-action.ts";
import {
  discardClientFn,
  offboardPlacedClientFn,
  retryProvisioningFn,
  releasePlacedClientFn,
  rollbackPlacedClientFn,
} from "./functions.ts";
import type { OffboardResult, PlaceResult } from "./functions.ts";
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

const automaticWords = (view: ClientHostingView): string => {
  const { automatic: choice } = view;
  if (choice.destinationId !== null) {
    return `Goes in ${choice.destinationId}, Grasp's shared destination.`;
  }
  return "No shared destination is recorded yet: the admin records its own as soon as a page reads it.";
};

/** Facts, as a list of terms. */
const Facts = ({
  facts,
}: {
  facts: readonly (readonly [string, string])[];
}) => (
  <dl className="flex flex-col gap-1 text-sm">
    {facts.map(([term, value]) => (
      <div className="flex flex-wrap gap-x-4" key={term}>
        <dt className="text-muted-foreground w-48">{term}</dt>
        <dd className="font-mono break-all">{value}</dd>
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

/** Where the client's provisioning operation is. */
const Operation = ({
  operation,
  run,
}: {
  operation: NonNullable<ClientHostingView["operation"]>;
  run: ClientHostingView["run"];
}) => (
  <div className="flex flex-col gap-2">
    <Facts
      facts={[
        ["Release", operation.releaseId],
        ["Status", statusWords[operation.status]],
        ["Last step done", operation.step ?? "none yet"],
        ["Attempt", run ?? "none"],
        ["Started by", operation.startedBy],
        ["Updated (UTC)", formatTime(operation.updatedAt)],
      ]}
    />
    <StopReason code={stopCodeOf(operation, run)} />
  </div>
);

/**
 * A live client's releases: a later one, the one a stopped release was
 * of again (which resumes it), or back to the one before. Each runs its
 * operation for that release, as provisioning did.
 */
const Releases = ({
  view,
  operation,
  releases,
}: {
  view: ClientHostingView;
  operation: NonNullable<ClientHostingView["operation"]>;
  releases: readonly { id: string; notes: string }[];
}) => {
  const router = useRouter();
  const { busy, failure, run } = useAction(placeRefusals);
  // Stopped: failed, or left running by a runner that has ended.
  const stopped =
    operation.status === "failed" ||
    (operation.status === "running" && !view.going);
  const others = releases.filter(({ id }) => id !== operation.releaseId);
  const choices = stopped ? releases : others;
  // Staff's pick while it's still offered; otherwise the first offered,
  // so what's shown is what's sent after the page refreshes.
  const [picked, setPicked] = useState<string | null>(null);
  const fallback = stopped ? operation.releaseId : (others[0]?.id ?? "");
  const releaseId =
    picked !== null && choices.some(({ id }) => id === picked)
      ? picked
      : fallback;
  const refreshing = async (task: () => Promise<PlaceResult>) => {
    await run(
      async () =>
        await thenRefresh(task, async () => {
          await router.invalidate({ sync: true });
        })
    );
  };
  const release = () => {
    void refreshing(
      async () =>
        await releasePlacedClientFn({
          data: { clientId: view.clientId, releaseId },
        })
    );
  };
  const rollBack = () => {
    void refreshing(
      async () =>
        await rollbackPlacedClientFn({ data: { clientId: view.clientId } })
    );
  };
  return (
    <div className="flex flex-col gap-4">
      <Field>
        <FieldLabel htmlFor="hosting-next-release">
          {stopped ? "Release it to" : "Release"}
        </FieldLabel>
        <NativeSelect
          id="hosting-next-release"
          onChange={(event) => {
            setPicked(event.target.value);
          }}
          value={releaseId}
        >
          {choices.map((each) => (
            <NativeSelectOption key={each.id} value={each.id}>
              {each.id}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      <div className="flex flex-wrap items-center gap-4">
        <Button
          disabled={busy || view.going || releaseId === ""}
          onClick={release}
        >
          {stopped && releaseId === operation.releaseId
            ? "Resume the release"
            : "Release it"}
        </Button>
        {operation.previousReleaseId === null ? null : (
          <Button
            disabled={busy || view.going}
            onClick={rollBack}
            variant="outline"
          >
            {`Roll back to ${operation.previousReleaseId}`}
          </Button>
        )}
        {failure === null ? null : (
          <p className="text-destructive text-sm" role="alert">
            {failure}
          </p>
        )}
      </div>
    </div>
  );
};

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

/** Whether it is, or would be, in Grasp's shared destination. */
const sharedHosting = (view: ClientHostingView): boolean => {
  const id = view.placement?.destinationId ?? view.automatic.destinationId;
  return view.destinations.some(
    (choice) => choice.id === id && choice.kind === "workers_for_platforms"
  );
};

/** That its core sends no mail, where its hosting gives it none yet. */
const MailNotice = ({ view }: { view: ClientHostingView }) =>
  sharedHosting(view) ? (
    <p className="text-sm">
      Mail: not available on this hosting yet (GRA-965). Its core sends none, so
      its people get their interview links by hand.
    </p>
  ) : null;

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
 * automatic destination with the newest release that fits, as the
 * admin does by itself anyway.
 */
export const ClientHosting = ({
  view,
  releases,
}: {
  view: ClientHostingView;
  releases: readonly { id: string; notes: string }[];
}) => {
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
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1 text-sm">
        <p>{hostingWords(view.hosting)}</p>
      </div>
      <p className="text-sm">
        {view.placement === null
          ? automaticWords(view)
          : `Placed in ${view.placement.destinationId} by ${view.placement.placedBy} on ${formatTime(view.placement.placedAt)} UTC. It stays there: moving it is a migration.`}
      </p>
      <MailNotice view={view} />
      {view.operation === null ? null : (
        <Operation operation={view.operation} run={view.run} />
      )}
      {view.active && view.operation !== null ? (
        <Releases operation={view.operation} releases={releases} view={view} />
      ) : null}
      {view.placement === null ? null : <Offboarding view={view} />}
      {discardable(view) ? <Discard view={view} /> : null}
      {view.notStarted === null ? null : (
        <p className="text-sm">{notStartedWords(view.notStarted)}</p>
      )}
      {stopped ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-4">
            <Button disabled={busy} onClick={retry} variant="outline">
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
