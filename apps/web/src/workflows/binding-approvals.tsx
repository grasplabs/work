import type {
  PendingWorkflowBindings,
  WorkflowBindingTarget,
} from "@grasp-os/shared/workflow-resources";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  NativeSelect,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import { Trans, useLingui } from "@lingui/react/macro";
import { XIcon } from "lucide-react";
import { useState } from "react";

import { ErrorText } from "../error-text.tsx";
import {
  PeopleTeamsPicker,
  readPeopleAndTeams,
  subjectKey,
} from "../people/people-teams-picker.tsx";
import type {
  PeopleAndTeams,
  PickedSubject,
} from "../people/people-teams-picker.tsx";
import { useCoreAction } from "../use-core-action.ts";

// A workflow version's bindings that wait on an admin, each approved for
// that version: where core offers targets that would serve it, the choice
// of one; for a decision, the people and teams who answer it, which core
// can't pick; otherwise why nothing can be approved yet. The inbox and the
// workflow's own page list them alike. Core checks every approval again:
// that the person is one of the organization's admins, and that the target
// serves.

/** One binding that waits. */
export type PendingBinding = PendingWorkflowBindings["bindings"][number];

type Offered = PendingBinding["offered"][number];

/** Approves `alias` with `target`, for the version listed. */
type Approve = (alias: string, target: WorkflowBindingTarget) => Promise<void>;

/** The choice of a target core offers, and Approve. */
const OfferedChoice = ({
  alias,
  offered,
  busy,
  onApprove,
}: {
  alias: string;
  offered: [Offered, ...Offered[]];
  busy: boolean;
  onApprove: Approve;
}) => {
  const { t } = useLingui();
  const [chosen, setChosen] = useState(0);
  const choice = offered[chosen] ?? offered[0];
  // What an offered target is, in words: what it names, or what it is.
  const wordsOf = ({ target, label }: Offered) => {
    if (target.kind === "event") {
      return t`The events its contract admits`;
    }
    if (target.kind === "files") {
      return t`The run's own files`;
    }
    return label === "" ? target.kind : label;
  };
  return (
    <div className="flex flex-wrap items-end gap-2">
      {offered.length === 1 ? (
        <span>{wordsOf(choice)}</span>
      ) : (
        <NativeSelect
          aria-label={t`What ${alias} reaches`}
          onChange={(event) => {
            setChosen(Number(event.target.value));
          }}
          value={String(chosen)}
        >
          {offered.map((each, at) => (
            <NativeSelectOption
              key={JSON.stringify(each.target)}
              value={String(at)}
            >
              {wordsOf(each)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      )}
      <Button
        aria-label={t`Approve ${alias}`}
        disabled={busy}
        onClick={() => {
          void onApprove(alias, choice.target);
        }}
        size="sm"
      >
        <Trans>Approve</Trans>
      </Button>
    </div>
  );
};

/** Who answers a decision, picked from the organization, and Approve. */
const DecidersChoice = ({
  alias,
  busy,
  onApprove,
}: {
  alias: string;
  busy: boolean;
  onApprove: Approve;
}) => {
  const { t } = useLingui();
  const { busy: reading, failure, run } = useCoreAction();
  const [candidates, setCandidates] = useState<PeopleAndTeams | null>(null);
  const [deciders, setDeciders] = useState<PickedSubject[]>([]);
  const holding = new Set(deciders.map((each) => subjectKey(each)));
  const readCandidates = async (): Promise<void> => {
    if (candidates !== null) {
      return;
    }
    const read = await run(readPeopleAndTeams);
    if (read !== undefined) {
      setCandidates(read);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <ul aria-label={t`Who answers ${alias}`} className="flex flex-wrap gap-2">
        {deciders.map((decider) => {
          const { name } = decider;
          return (
            <li key={subjectKey(decider)}>
              <Badge variant="secondary">
                {name}
                <Button
                  aria-label={t`Remove ${name}`}
                  onClick={() => {
                    setDeciders(
                      deciders.filter(
                        (each) => subjectKey(each) !== subjectKey(decider)
                      )
                    );
                  }}
                  size="icon-xs"
                  variant="ghost"
                >
                  <XIcon />
                </Button>
              </Badge>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-end gap-2">
        <PeopleTeamsPicker
          candidates={candidates}
          disabled={busy || reading}
          holding={holding}
          label={<Trans>Add who answers</Trans>}
          onOpen={() => {
            void readCandidates();
          }}
          onPick={(picked) => {
            setDeciders([...deciders, picked]);
          }}
        />
        <Button
          aria-label={t`Approve ${alias}`}
          disabled={busy || deciders.length === 0}
          onClick={() => {
            void onApprove(alias, {
              kind: "decision",
              deciders: deciders.map((each) => subjectKey(each)),
            });
          }}
          size="sm"
        >
          <Trans>Approve</Trans>
        </Button>
      </div>
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};

/** How one binding is approved: its deciders, a target offered, or why not yet. */
const BindingChoice = ({
  binding: { alias, kind, offered },
  busy,
  onApprove,
}: {
  binding: PendingBinding;
  busy: boolean;
  onApprove: Approve;
}) => {
  const [first, ...rest] = offered;
  if (kind === "decision") {
    return <DecidersChoice alias={alias} busy={busy} onApprove={onApprove} />;
  }
  if (first === undefined) {
    return (
      <p className="text-muted-foreground">
        <Trans>
          Nothing the workflow may use serves it yet: grant the workflow what it
          needs first.
        </Trans>
      </p>
    );
  }
  return (
    <OfferedChoice
      alias={alias}
      busy={busy}
      offered={[first, ...rest]}
      onApprove={onApprove}
    />
  );
};

/** One binding that waits: what it reaches, and how it is approved. */
const BindingRow = ({
  binding,
  busy,
  onApprove,
}: {
  binding: PendingBinding;
  busy: boolean;
  onApprove: Approve;
}) => {
  const { t } = useLingui();
  const { alias, kind, contractId } = binding;
  return (
    <li className="flex flex-col gap-2 rounded-lg border px-4 py-3">
      <span className="flex flex-wrap items-center gap-2">
        <code className="font-mono">{alias}</code>
        <span className="text-muted-foreground">
          {t`${kind}: ${contractId}`}
        </span>
      </span>
      <BindingChoice binding={binding} busy={busy} onApprove={onApprove} />
    </li>
  );
};

/** The bindings of one version that wait, each approved through `onApprove`. */
export const PendingBindingList = ({
  bindings,
  busy,
  onApprove,
}: {
  bindings: readonly PendingBinding[];
  busy: boolean;
  onApprove: Approve;
}) => {
  const { t } = useLingui();
  return (
    <ul aria-label={t`Its bindings`} className="flex flex-col gap-2">
      {bindings.map((binding) => (
        <BindingRow
          binding={binding}
          busy={busy}
          key={binding.alias}
          onApprove={onApprove}
        />
      ))}
    </ul>
  );
};
