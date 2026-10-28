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
import {
  placeAndProvisionFn,
  releasePlacedClientFn,
  rollbackPlacedClientFn,
} from "./functions.ts";
import type { PlaceResult } from "./functions.ts";
import type {
  ClientHostingView,
  DestinationChoice,
  DestinationProblem,
} from "./placement.ts";
import { operationErrorWords, placeRefusals, problemWords } from "./words.ts";

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
  const stopped = operation.status === "failed";
  const others = releases.filter(({ id }) => id !== operation.releaseId);
  const [releaseId, setReleaseId] = useState(
    stopped ? operation.releaseId : (others[0]?.id ?? "")
  );
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
  const choices = stopped ? releases : others;
  return (
    <div className="flex flex-col gap-4">
      <Field>
        <FieldLabel htmlFor="hosting-next-release">
          {stopped ? "Release it to" : "Release"}
        </FieldLabel>
        <NativeSelect
          id="hosting-next-release"
          onChange={(event) => {
            setReleaseId(event.target.value);
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
  const done = view.operation?.status === "done";
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
      {view.operation === null ? null : (
        <Operation operation={view.operation} run={view.run} />
      )}
      {view.active && view.operation !== null ? (
        <Releases operation={view.operation} releases={releases} view={view} />
      ) : null}
      {done || view.active ? null : (
        <div className="flex flex-col gap-4">
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
      )}
    </div>
  );
};
