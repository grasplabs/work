import { failureText } from "@grasp-os/shared/errors";
import type { WorkflowStartForm } from "@grasp-os/shared/workflow-resources";
import { Button } from "@grasp-os/ui/components/button";
import { Checkbox } from "@grasp-os/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@grasp-os/ui/components/dialog";
import { Input } from "@grasp-os/ui/components/input";
import { Label } from "@grasp-os/ui/components/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { PlayIcon, XIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { ReactNode } from "react";

import { ErrorText } from "../error-text.tsx";
import { usePeopleApart } from "../people/people-apart.ts";
import {
  PeopleTeamsPicker,
  subjectKey,
  subjectNamed,
} from "../people/people-teams-picker.tsx";
import type { PeopleAndTeams } from "../people/people-teams-picker.tsx";
import { useCore } from "../use-core.ts";
import { startFieldsOf, startInputOf } from "./start-input.ts";
import type {
  StartField,
  StartFieldProblem,
  StartValues,
} from "./start-input.ts";
import { isUnapprovedStart, ToApprovals } from "./unapproved-start.tsx";

// Starting a workflow by hand from its page (GRA-1305), as the person
// who presses Start: a run at the version core says a start runs, with a
// form for its input from that version's schema
// (`workflowResources.startForm`, start-input.ts). A field that takes a
// person is picked from the organization's people, teams and roles: core
// gives the people and teams with the form. Offered to anyone with a role
// in the workflow, who may start it; core decides again on the start, and
// what it refuses is said in the dialog.
// Each start carries a key made when the dialog opens, so pressing again
// after a lost answer starts nothing twice.

/** What a start started, as the dialog says it. */
interface Started {
  kind: "listed";
}

/** What the dialog says once a start went through: where its run is listed. */
const StartedText = () => (
  <Trans>The run started. It is listed with the workflow&apos;s runs.</Trans>
);

/** What is said under a field whose value can't be sent. */
const ProblemText = ({ problem }: { problem: StartFieldProblem }) => {
  if (problem === "missing") {
    return <Trans>Fill this in.</Trans>;
  }
  return problem === "integer" ? (
    <Trans>Type a whole number.</Trans>
  ) : (
    <Trans>Type a number.</Trans>
  );
};

/** One input field, as `field` asks for it. */
const FieldInput = ({
  field,
  id,
  value,
  people,
  onChange,
}: {
  field: StartField;
  id: string;
  value: string | boolean | undefined;
  /** Whom a field that takes a person may name, as core gave them. */
  people: PeopleAndTeams | null;
  onChange: (value: string | boolean) => void;
}) => {
  const { t } = useLingui();
  const apart = usePeopleApart(people?.people ?? []);
  const text = typeof value === "string" ? value : "";
  switch (field.kind) {
    case "person": {
      // The one picked, by name, and for an optional field a way to pick
      // nobody again: core checks the start's input again.
      const picked =
        text === "" ? undefined : subjectNamed(text, people, apart);
      return (
        <div className="flex items-center gap-1">
          <PeopleTeamsPicker
            candidates={people}
            disabled={false}
            holding={new Set(text === "" ? [] : [text])}
            buttonId={id}
            label={picked ?? (text === "" ? t`Choose…` : text)}
            onPick={(subject) => {
              onChange(subjectKey(subject));
            }}
            roles
          />
          {field.required || text === "" ? null : (
            <Button
              aria-label={t`Clear ${field.name}`}
              onClick={() => {
                onChange("");
              }}
              size="icon-sm"
              variant="ghost"
            >
              <XIcon />
            </Button>
          )}
        </div>
      );
    }
    case "yes": {
      return (
        <Checkbox
          checked={value === true}
          id={id}
          onCheckedChange={(checked) => {
            onChange(checked);
          }}
        />
      );
    }
    case "choice": {
      return (
        <NativeSelect
          id={id}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          value={text}
        >
          <NativeSelectOption value="">{t`Choose…`}</NativeSelectOption>
          {field.choices.map((choice) => (
            <NativeSelectOption key={choice} value={choice}>
              {choice}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      );
    }
    case "number": {
      return (
        <Input
          id={id}
          inputMode={field.integer ? "numeric" : "decimal"}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          value={text}
        />
      );
    }
    case "text": {
      return (
        <Input
          id={id}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          value={text}
        />
      );
    }
    default: {
      return field satisfies never;
    }
  }
};

/**
 * The Start button, and the dialog it opens: `fields` as a form, or JSON
 * when they are undefined;
 * `start` starts the run with the input and the dialog's key, and says
 * what it started.
 */
const StartDialog = ({
  description,
  fields,
  people = null,
  start,
  onFiles,
}: {
  description: ReactNode;
  fields: StartField[] | undefined;
  /** Whom a field that takes a person may name, as core gave them. */
  people?: PeopleAndTeams | null;
  start: (input: unknown, key: string) => Promise<Started>;
  /** Shows the workflow's Files and apps, where a refused binding is approved. */
  onFiles?: (() => void) | undefined;
}) => {
  const { t } = useLingui();
  const ids = useId();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<StartValues>({});
  const [json, setJson] = useState("{}");
  const [problem, setProblem] = useState<{
    field: string;
    problem: StartFieldProblem;
  }>();
  const [failure, setFailure] = useState<string>();
  const [unapproved, setUnapproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState<Started>();
  const [key, setKey] = useState(() => crypto.randomUUID());

  const inputOf = ():
    | { ok: true; input: unknown }
    | { ok: false; failure?: string } => {
    if (fields !== undefined) {
      const taken = startInputOf(fields, values);
      if (!taken.ok) {
        setProblem({ field: taken.field, problem: taken.problem });
        return { ok: false };
      }
      return { ok: true, input: taken.input };
    }
    try {
      const parsed: unknown = JSON.parse(json);
      return { ok: true, input: parsed };
    } catch {
      return { ok: false, failure: t`The input isn't JSON.` };
    }
  };

  const submit = async (): Promise<void> => {
    setProblem(undefined);
    setFailure(undefined);
    setUnapproved(false);
    const taken = inputOf();
    if (!taken.ok) {
      setFailure(taken.failure);
      return;
    }
    setBusy(true);
    try {
      setStarted(await start(taken.input, key));
      // Another start is another run.
      setKey(crypto.randomUUID());
    } catch (error) {
      setFailure(failureText(error));
      setUnapproved(isUnapprovedStart(error));
    }
    setBusy(false);
  };

  return (
    <Dialog
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setStarted(undefined);
          setFailure(undefined);
          setUnapproved(false);
          setProblem(undefined);
        }
      }}
      open={open}
    >
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        <PlayIcon aria-hidden="true" />
        <Trans context="start a workflow's run by hand">Start</Trans>
      </DialogTrigger>
      <DialogContent closeLabel={t`Close`}>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              <Trans>Start a run</Trans>
            </DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          {fields === undefined ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${ids}-json`}>
                <Trans>Input, as JSON</Trans>
              </Label>
              <Textarea
                id={`${ids}-json`}
                onChange={(event) => {
                  setJson(event.target.value);
                }}
                spellCheck={false}
                value={json}
                variant="code"
              />
            </div>
          ) : (
            fields.map((field) => {
              const id = `${ids}-${field.name}`;
              const { name } = field;
              return (
                <div className="flex flex-col gap-2" key={name}>
                  <Label htmlFor={id}>
                    {field.required ? name : <Trans>{name} (optional)</Trans>}
                  </Label>
                  <FieldInput
                    field={field}
                    id={id}
                    onChange={(value) => {
                      setValues({ ...values, [name]: value });
                    }}
                    people={people}
                    value={values[name]}
                  />
                  {problem?.field === name ? (
                    <p className="text-destructive text-sm" role="alert">
                      <ProblemText problem={problem.problem} />
                    </p>
                  ) : null}
                </div>
              );
            })
          )}
          <ErrorText>{failure}</ErrorText>
          {unapproved && onFiles !== undefined ? (
            <ToApprovals
              onFiles={() => {
                setOpen(false);
                onFiles();
              }}
            />
          ) : null}
          {started === undefined ? null : (
            <output className="flex flex-col gap-1">
              <StartedText />
            </output>
          )}
          <DialogFooter closeLabel={t`Close`} showCloseButton>
            <Button disabled={busy} type="submit">
              {busy ? t`Starting…` : t`Start the run`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

/**
 * Start for independent workflow `workflow`, once core says how it starts;
 * why it can't when core couldn't say. `onFiles` shows its Files and apps.
 */
export const StartIndependentRun = ({
  workflow,
  onFiles,
}: {
  workflow: string;
  onFiles?: () => void;
}) => {
  const core = useCore();
  const router = useRouter();
  const { t } = useLingui();
  const [form, setForm] = useState<WorkflowStartForm>();
  const [unread, setUnread] = useState<string>();

  useEffect(() => {
    let stopped = false;
    const read = async (): Promise<void> => {
      try {
        const given = await core.withSession(
          async (session) => await session.workflowResources.startForm(workflow)
        );
        if (!stopped) {
          setForm(given);
          setUnread(undefined);
        }
      } catch (error) {
        if (!stopped) {
          setUnread(failureText(error));
        }
      }
    };
    void read();
    return () => {
      stopped = true;
    };
  }, [core, workflow]);

  if (unread !== undefined) {
    return <ErrorText>{t`Can't offer Start: ${unread}`}</ErrorText>;
  }
  const version = form?.version ?? null;
  if (version === null) {
    return null;
  }
  return (
    <StartDialog
      description={
        <Trans>
          Starts version {version} as you, with the input you give it.
        </Trans>
      }
      fields={startFieldsOf(form?.args)}
      people={form?.people ?? null}
      onFiles={onFiles}
      start={async (input, key) => {
        await core.withSession(
          async (session) =>
            await session.workflowResources.start(workflow, {
              version,
              args: input,
              key,
            })
        );
        // Its runs, as core lists them now.
        void router.invalidate();
        return { kind: "listed" };
      }}
    />
  );
};
