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
import { Link, useRouter } from "@tanstack/react-router";
import { PlayIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { ReactNode } from "react";

import { ErrorText } from "../error-text.tsx";
import { useCore } from "../use-core.ts";
import { startFieldsOf, startInputOf } from "./start-input.ts";
import type {
  StartField,
  StartFieldProblem,
  StartValues,
} from "./start-input.ts";

// Starting a workflow by hand from its page (GRA-1305), as the person
// who presses Start: a run of an independent workflow at the version
// core says a start runs, with a form for its input from that version's
// schema (`workflowResources.startForm`, start-input.ts), or a run of an
// App's workflow, whose input, if it takes any, is typed as JSON (an
// App's workflow says what it takes only in its own code). Offered to
// anyone with a role in the workflow or the App, who may start it; core
// decides again on the start, and what it refuses is said in the dialog.
// Each start carries a key made when the dialog opens, so pressing again
// after a lost answer starts nothing twice.

/** What a start started, as the dialog says it. */
type Started =
  | { kind: "unrunnable"; version: number }
  | { kind: "listed" }
  | { kind: "run"; app: string; workflow: string; run: string };

/** What the dialog says once a start went through. */
const StartedText = ({ started }: { started: Started }) => {
  switch (started.kind) {
    case "unrunnable": {
      const { version } = started;
      return (
        <Trans>Version {version} has no build that runs, so nothing ran.</Trans>
      );
    }
    case "listed": {
      return (
        <Trans>
          The run started. It is listed with the workflow&apos;s runs.
        </Trans>
      );
    }
    case "run": {
      return (
        <Link
          className="underline-offset-4 hover:underline"
          params={{
            app: started.app,
            workflow: started.workflow,
            run: started.run,
          }}
          to="/workflows/$app/$workflow/runs/$run"
        >
          <Trans>The run started. Open it.</Trans>
        </Link>
      );
    }
    default: {
      return started satisfies never;
    }
  }
};

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
  onChange,
}: {
  field: StartField;
  id: string;
  value: string | boolean | undefined;
  onChange: (value: string | boolean) => void;
}) => {
  const { t } = useLingui();
  const text = typeof value === "string" ? value : "";
  switch (field.kind) {
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
 * when they are undefined (left empty, no input, where `jsonOptional`);
 * `start` starts the run with the input and the dialog's key, and says
 * what it started.
 */
const StartDialog = ({
  description,
  fields,
  jsonOptional,
  start,
}: {
  description: ReactNode;
  fields: StartField[] | undefined;
  jsonOptional: boolean;
  start: (input: unknown, key: string) => Promise<Started>;
}) => {
  const { t } = useLingui();
  const ids = useId();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<StartValues>({});
  const [json, setJson] = useState(jsonOptional ? "" : "{}");
  const [problem, setProblem] = useState<{
    field: string;
    problem: StartFieldProblem;
  }>();
  const [failure, setFailure] = useState<string>();
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
    if (jsonOptional && json.trim() === "") {
      return { ok: true, input: undefined };
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
                {jsonOptional ? (
                  <Trans>Input, as JSON, if it takes any</Trans>
                ) : (
                  <Trans>Input, as JSON</Trans>
                )}
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
          {started === undefined ? null : (
            <output className="flex flex-col gap-1">
              <StartedText started={started} />
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

/** Start for independent workflow `workflow`, once core says how it starts. */
export const StartIndependentRun = ({ workflow }: { workflow: string }) => {
  const core = useCore();
  const router = useRouter();
  const [form, setForm] = useState<WorkflowStartForm>();

  useEffect(() => {
    let stopped = false;
    const read = async (): Promise<void> => {
      try {
        const given = await core.withSession(
          async (session) => await session.workflowResources.startForm(workflow)
        );
        if (!stopped) {
          setForm(given);
        }
      } catch {
        // Not offered then: core would refuse the start anyway.
      }
    };
    void read();
    return () => {
      stopped = true;
    };
  }, [core, workflow]);

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
      fields={startFieldsOf(form?.input)}
      jsonOptional={false}
      start={async (input, key) => {
        const started = await core.withSession(
          async (session) =>
            await session.workflowResources.start(workflow, {
              version,
              input,
              key,
            })
        );
        // Its runs, as core lists them now.
        void router.invalidate();
        return started.runId === null
          ? { kind: "unrunnable", version }
          : { kind: "listed" };
      }}
    />
  );
};

/** Start for workflow `workflow` of App `app`, at the App's current version. */
export const StartAppRun = ({
  app,
  workflow,
}: {
  app: string;
  workflow: string;
}) => {
  const core = useCore();
  return (
    <StartDialog
      description={
        <Trans>Starts it as you, on the domain&apos;s current version.</Trans>
      }
      fields={undefined}
      jsonOptional
      start={async (input) => {
        const run = await core.withSession(
          async (session) => await session.workflows.start(app, workflow, input)
        );
        return { kind: "run", app, workflow, run: run.id };
      }}
    />
  );
};
