import { decisionDecidersMax } from "@grasp-os/shared/workflow-resources";
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
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import { ErrorText } from "../error-text.tsx";
import { formatList } from "../format.ts";
import { roleLabel } from "../labels.ts";
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
// of one; for a decision, the people, teams and roles who answer it, which core
// can't pick; otherwise why nothing can be approved yet. The inbox and the
// workflow's own page list them alike, but the inbox has no offers for the
// kinds slow to read (a connector, a store operation, a template), so it
// leads to the workflow's page for those. Core checks every approval
// again: that the person is one of the organization's admins, and that the
// target serves. The workflow's page lists the bindings approved in the
// same frame, each with what it reaches (`targetWords`).

/** One binding that waits. */
export type PendingBinding = PendingWorkflowBindings["bindings"][number];

type Offered = PendingBinding["offered"][number];

/** The names of people and teams, by ID, where they are known. */
export interface KnownNames {
  people: ReadonlyMap<string, string>;
  teams: ReadonlyMap<string, string>;
}

const noNames: KnownNames = { people: new Map(), teams: new Map() };

/** A decision's decider (`person:`, `team:` or `role:` and an ID), in words. */
const deciderWords = (decider: string, known: KnownNames): string => {
  const [type, id = ""] = decider.split(":");
  if (type === "person") {
    return known.people.get(id) ?? id;
  }
  if (type === "team") {
    return known.teams.get(id) ?? id;
  }
  return roleLabel(id);
};

/**
 * What `target` reaches, in words: `label` where core named it (an offer's),
 * else what the target itself names, a decision's deciders by the names
 * `known` holds.
 */
export const targetWords = (
  target: WorkflowBindingTarget,
  label = "",
  known: KnownNames = noNames
): string => {
  if (label !== "") {
    return label;
  }
  switch (target.kind) {
    case "model": {
      return target.model;
    }
    case "connector": {
      return target.contract;
    }
    case "storeOperation": {
      return target.operation;
    }
    case "template": {
      const { templateId, version } = target;
      return i18n._(msg`Template ${templateId}, version ${version}`);
    }
    case "decision": {
      const deciders = formatList(
        target.deciders.map((decider) => deciderWords(decider, known))
      );
      return i18n._(msg`Answered by ${deciders}`);
    }
    case "knowledge": {
      return i18n._(msg`A Brain collection it may read`);
    }
    case "event": {
      return i18n._(msg`The events its contract admits`);
    }
    case "files": {
      return i18n._(msg`The run's own files`);
    }
    default: {
      return target satisfies never;
    }
  }
};

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
  const wordsOf = ({ target, label }: Offered) => targetWords(target, label);
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

/** Who answers a decision, picked from the organization's people, teams and roles, and Approve. */
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
          disabled={busy || reading || deciders.length >= decisionDecidersMax}
          holding={holding}
          label={<Trans>Add who answers</Trans>}
          // A decision sent to a role (`role:admin`) is answered only by a
          // binding that names that role.
          roles
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

/**
 * How one binding is approved: its deciders, a target offered, or why not
 * yet. With `elsewhere`, a connector, store operation or template offered
 * nothing leads to the workflow's page, where they are offered targets.
 */
const BindingChoice = ({
  binding: { alias, kind, offered },
  busy,
  onApprove,
  elsewhere,
}: {
  binding: PendingBinding;
  busy: boolean;
  onApprove: Approve;
  elsewhere: string | undefined;
}) => {
  const [first, ...rest] = offered;
  if (kind === "decision") {
    return <DecidersChoice alias={alias} busy={busy} onApprove={onApprove} />;
  }
  // The kinds offered their targets on the workflow's page alone.
  const slow =
    kind === "connector" || kind === "operation" || kind === "template";
  if (first === undefined && slow && elsewhere !== undefined) {
    return (
      <Link
        className="underline-offset-4 hover:underline"
        params={{ workflow: elsewhere }}
        search={{ tab: "files" }}
        to="/workflows/$workflow"
      >
        <Trans>Approve it on the workflow&apos;s page</Trans>
      </Link>
    );
  }
  if (first === undefined) {
    return (
      <p className="text-muted-foreground">
        <Trans>
          Nothing the workflow may use serves it now: grant the workflow what it
          needs, or try again later.
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

/**
 * One binding of a version: its alias and kind, with its contract where
 * the reader may see it, above `children`.
 */
export const BindingFrame = ({
  alias,
  kind,
  contractId,
  children,
}: {
  alias: string;
  kind: string;
  contractId: string | null;
  children: ReactNode;
}) => {
  const { t } = useLingui();
  return (
    <li className="flex flex-col gap-2 rounded-lg border px-4 py-3">
      <span className="flex flex-wrap items-center gap-2">
        <code className="font-mono">{alias}</code>
        <span className="text-muted-foreground">
          {contractId === null ? kind : t`${kind}: ${contractId}`}
        </span>
      </span>
      {children}
    </li>
  );
};

/** One binding that waits: what it reaches, and how it is approved. */
const BindingRow = ({
  binding,
  busy,
  onApprove,
  elsewhere,
}: {
  binding: PendingBinding;
  busy: boolean;
  onApprove: Approve;
  elsewhere: string | undefined;
}) => (
  <BindingFrame
    alias={binding.alias}
    contractId={binding.contractId}
    kind={binding.kind}
  >
    <BindingChoice
      binding={binding}
      busy={busy}
      elsewhere={elsewhere}
      onApprove={onApprove}
    />
  </BindingFrame>
);

/**
 * The bindings of one version that wait, each approved through
 * `onApprove`; `elsewhere` the workflow whose page approves those offered
 * nothing here (the inbox's).
 */
export const PendingBindingList = ({
  bindings,
  busy,
  onApprove,
  elsewhere,
}: {
  bindings: readonly PendingBinding[];
  busy: boolean;
  onApprove: Approve;
  elsewhere?: string;
}) => {
  const { t } = useLingui();
  return (
    <ul aria-label={t`Its bindings`} className="flex flex-col gap-2">
      {bindings.map((binding) => (
        <BindingRow
          binding={binding}
          busy={busy}
          elsewhere={elsewhere}
          key={binding.alias}
          onApprove={onApprove}
        />
      ))}
    </ul>
  );
};
