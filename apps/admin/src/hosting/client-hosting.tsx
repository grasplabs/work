/**
 * A client's hosting, in its Setup in the admin (src/admin/setup.tsx),
 * which titles it: where it's placed, or where it would
 * go (the destination the admin picks by itself, and what keeps every
 * other from taking it), dedicated hosting as an advanced choice, and
 * starting or resuming its provisioning there, with where its operation
 * is (src/hosting/placement.ts). Once it's live, releasing it to a later
 * release and rolling it back to the one before, which run the same
 * operation again.
 */
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { Checkbox } from "@grasp-os/ui/components/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldTitle,
} from "@grasp-os/ui/components/field";
import {
  NativeSelect,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import {
  RadioGroup,
  RadioGroupItem,
} from "@grasp-os/ui/components/radio-group";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { formatTime } from "../releases/format.ts";
import { thenRefresh, useAction } from "../use-action.ts";
import { CapabilityChecklist } from "./capability-checks.tsx";
import {
  offboardPlacedClientFn,
  placeAndProvisionFn,
  releasePlacedClientFn,
  rollbackPlacedClientFn,
} from "./functions.ts";
import type { OffboardResult, PlaceResult } from "./functions.ts";
import type {
  ClientHostingView,
  DestinationChoice,
  DestinationProblem,
} from "./placement.ts";
import {
  offboardRefusals,
  operationErrorWords,
  placeRefusals,
  problemWords,
} from "./words.ts";

/** What the radio for the automatic destination is worth. */
const automatic = "automatic";

const kindWords: Readonly<Record<DestinationChoice["kind"], string>> = {
  workers_for_platforms: "shared",
  dedicated: "dedicated",
  workerd: "workerd",
};

const statusWords: Readonly<
  Record<NonNullable<ClientHostingView["operation"]>["status"], string>
> = {
  running: "running",
  failed: "stopped",
  done: "done",
};

const problemKey = (problem: DestinationProblem): string =>
  "capability" in problem
    ? `${problem.kind}:${problem.capability}`
    : problem.kind;

/** What keeps a destination from taking the client, each in words. */
const Problems = ({
  problems,
}: {
  problems: readonly DestinationProblem[];
}) => (
  <ul className="text-muted-foreground flex list-disc flex-col gap-1 pl-5 text-sm">
    {problems.map((problem) => (
      <li key={problemKey(problem)}>{problemWords(problem)}</li>
    ))}
  </ul>
);

/** One destination to choose, or why it can't be. */
const DestinationOption = ({
  choice,
  policyId,
}: {
  choice: DestinationChoice;
  policyId: string;
}) => {
  const blocked = choice.problems.length > 0;
  const id = `destination-${choice.id}`;
  return (
    <FieldLabel htmlFor={id}>
      <Field data-disabled={blocked} orientation="horizontal">
        <RadioGroupItem disabled={blocked} id={id} value={choice.id} />
        <FieldContent>
          <FieldTitle>
            <span className="font-mono">{choice.id}</span>
            <Badge variant="outline">{kindWords[choice.kind]}</Badge>
          </FieldTitle>
          {blocked ? (
            <Problems problems={choice.problems} />
          ) : (
            <FieldDescription>{`Meets every requirement of ${policyId}.`}</FieldDescription>
          )}
        </FieldContent>
      </Field>
    </FieldLabel>
  );
};

/** What the admin picks by itself, in words. */
const automaticWords = (view: ClientHostingView): string => {
  const { automatic: choice, policy } = view;
  if (choice.destinationId !== null) {
    return `Automatic: ${choice.destinationId}, the one shared destination that meets every requirement of ${policy.id}.`;
  }
  return choice.reason === "several"
    ? `Several shared destinations meet every requirement of ${policy.id}, so the admin doesn't pick one: choose it below.`
    : `No shared destination meets every requirement of ${policy.id}, so nothing is picked. Each one's blocking requirements are below.`;
};

/** Where the client could go, the automatic destination first, dedicated hosting folded away. */
const Destinations = ({
  view,
  chosen,
  onChoose,
}: {
  view: ClientHostingView;
  chosen: string;
  onChoose: (destinationId: string) => void;
}) => {
  const shared = view.destinations.filter((choice) => choice.shared);
  const others = view.destinations.filter((choice) => !choice.shared);
  const picked = view.automatic.destinationId;
  return (
    <RadioGroup
      onValueChange={(value) => {
        onChoose(String(value));
      }}
      value={chosen}
    >
      <p className="text-sm">{automaticWords(view)}</p>
      {picked === null ? null : (
        <FieldLabel htmlFor="destination-automatic">
          <Field orientation="horizontal">
            <RadioGroupItem id="destination-automatic" value={automatic} />
            <FieldContent>
              <FieldTitle>{`Automatic (${picked})`}</FieldTitle>
              <FieldDescription>
                The shared destination the admin picks.
              </FieldDescription>
            </FieldContent>
          </Field>
        </FieldLabel>
      )}
      {shared
        .filter((choice) => choice.id !== picked)
        .map((choice) => (
          <DestinationOption
            choice={choice}
            key={choice.id}
            policyId={view.policy.id}
          />
        ))}
      {others.length === 0 ? null : (
        <Collapsible>
          <CollapsibleTrigger render={<Button variant="outline" />}>
            Advanced: dedicated hosting
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-3 flex flex-col gap-3">
              <p className="text-muted-foreground text-sm">
                A destination for this client alone. Never picked by itself:
                choose it only when this client calls for it.
              </p>
              {others.map((choice) => (
                <DestinationOption
                  choice={choice}
                  key={choice.id}
                  policyId={view.policy.id}
                />
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </RadioGroup>
  );
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
    {operation.error === null ? null : (
      <p className="text-destructive text-sm" role="alert">
        <span className="font-mono">{operation.error}</span>
        {`: ${operationErrorWords(operation.error)}`}
      </p>
    )}
  </div>
);

/** What starting it says, by where the client is. */
const startWords = (view: ClientHostingView): string => {
  if (view.operation !== null) {
    return "Resume provisioning";
  }
  return view.placement === null
    ? "Place and start provisioning"
    : "Start provisioning";
};

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

/** That nothing runs until staff start it, and what they start it with. */
const NotStarted = ({ imported }: { imported: boolean }) => (
  <p className="text-sm">
    {imported
      ? "Nothing runs for it yet: provisioning starts only when you choose its release and start it here."
      : "Nothing runs for it yet, and no release is imported to provision it with. CI publishes one on every merge to main, and the admin imports new ones every 5 minutes: once one is in, choose it here and start."}
  </p>
);

/**
 * What the policy needs of each destination the client is in or could go
 * to, as a checklist with the form to record a check: the one it's
 * placed in, or every shared one while it isn't placed.
 */
const Requirements = ({ view }: { view: ClientHostingView }) => {
  if (view.active) {
    return null;
  }
  const shown = view.destinations.filter((choice) =>
    view.placement === null
      ? choice.shared
      : choice.id === view.placement.destinationId
  );
  return (
    <div className="flex flex-col gap-4">
      {shown.map((choice) => (
        <div className="flex flex-col gap-2" key={choice.id}>
          <h3 className="text-sm font-medium">
            {`What ${view.policy.id} needs of ${choice.id}`}
          </h3>
          <CapabilityChecklist
            checks={choice.checks}
            destinationId={choice.id}
          />
        </div>
      ))}
    </div>
  );
};

/** Whether it's still to provision: not live, done, or offboarded. */
const provisionable = (view: ClientHostingView): boolean =>
  view.operation?.status !== "done" &&
  !view.active &&
  view.offboardedAt === null;

export const ClientHosting = ({
  view,
  releases,
}: {
  view: ClientHostingView;
  releases: readonly { id: string; notes: string }[];
}) => {
  const router = useRouter();
  const { busy, failure, run } = useAction(placeRefusals);
  const [chosen, setChosen] = useState(
    view.automatic.destinationId === null ? "" : automatic
  );
  const [releaseId, setReleaseId] = useState(
    view.operation?.releaseId ?? releases[0]?.id ?? ""
  );
  const [blocking, setBlocking] = useState<DestinationProblem[]>([]);
  const placing = view.placement === null;
  const start = () => {
    void run(async () => {
      // Refreshed even when it fails: the client may be placed already.
      const result = await thenRefresh(
        async () =>
          await placeAndProvisionFn({
            data: {
              clientId: view.clientId,
              releaseId,
              policyId: view.policy.id,
              destinationId: !placing || chosen === automatic ? null : chosen,
            },
          }),
        async () => {
          await router.invalidate({ sync: true });
        }
      );
      setBlocking(result.problems);
      return result;
    });
  };
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1 text-sm">
        <p>{`Policy: ${view.policy.id}`}</p>
        <p className="text-muted-foreground">{view.policy.description}</p>
      </div>
      {view.placement === null ? (
        <Destinations onChoose={setChosen} view={view} chosen={chosen} />
      ) : (
        <p className="text-sm">
          {`Placed in ${view.placement.destinationId} by ${view.placement.placedBy} on ${formatTime(view.placement.placedAt)} UTC. It stays there: moving it is a migration.`}
        </p>
      )}
      <Requirements view={view} />
      {view.operation === null ? null : (
        <Operation operation={view.operation} run={view.run} />
      )}
      {view.active && view.operation !== null ? (
        <Releases operation={view.operation} releases={releases} view={view} />
      ) : null}
      {view.placement === null ? null : <Offboarding view={view} />}
      {provisionable(view) ? (
        <div className="flex flex-col gap-4">
          {view.operation === null ? (
            <NotStarted imported={releases.length > 0} />
          ) : null}
          {view.operation === null ? (
            <Field>
              <FieldLabel htmlFor="hosting-release">Release</FieldLabel>
              <NativeSelect
                id="hosting-release"
                onChange={(event) => {
                  setReleaseId(event.target.value);
                }}
                value={releaseId}
              >
                {releases.map((release) => (
                  <NativeSelectOption key={release.id} value={release.id}>
                    {release.id}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          ) : null}
          <div className="flex flex-wrap items-center gap-4">
            <Button
              disabled={busy || releaseId === "" || (placing && chosen === "")}
              onClick={start}
            >
              {startWords(view)}
            </Button>
            {failure === null ? null : (
              <p className="text-destructive text-sm" role="alert">
                {failure}
              </p>
            )}
          </div>
          {failure === null || blocking.length === 0 ? null : (
            <Problems problems={blocking} />
          )}
        </div>
      ) : null}
    </div>
  );
};
