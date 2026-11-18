import { failureText } from "@grasp-os/shared/errors";
import type { WorkflowStartForm } from "@grasp-os/shared/workflow-resources";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { formatList } from "../format.ts";
import { Button } from "../grasp/button/index.ts";
import { Checkbox } from "../grasp/checkbox/index.ts";
import {
  Dialog,
  DialogAction,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from "../grasp/dialog/index.ts";
import { Field, FieldDescription, FieldLabel } from "../grasp/field/index.ts";
import { Cross, Play } from "../grasp/icons/index.ts";
import { Input } from "../grasp/input/index.ts";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "../grasp/select/index.ts";
import { Text } from "../grasp/text/index.ts";
import { Textarea } from "../grasp/textarea/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { usePeopleApart } from "../people/people-apart.ts";
import {
  PeopleTeamsPicker,
  subjectKey,
  subjectNamed,
} from "../people/people-teams-picker.tsx";
import type { PeopleAndTeams } from "../people/people-teams-picker.tsx";
import { useCore } from "../use-core.ts";
import { inputSketchOf, startFieldsOf, startInputOf } from "./start-input.ts";
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
  /** The run it started, where the page can open it. */
  runId?: string;
}

/** The width of the workflow's bar under which Run shows its icon alone (frame/item-shell.tsx). */
const narrowBar = "@container bar (width < 64rem)";

const styles = stylex.create({
  // Its words, hidden from the eye where the bar is narrow, still its name.
  barWords: {
    position: { default: null, [narrowBar]: "absolute" },
    width: { default: null, [narrowBar]: 1 },
    height: { default: null, [narrowBar]: 1 },
    overflow: { default: null, [narrowBar]: "hidden" },
    clipPath: { default: null, [narrowBar]: "inset(50%)" },
    whiteSpace: { default: null, [narrowBar]: "nowrap" },
  },
  form: { display: "grid", rowGap: grasp.space4 },
  person: { display: "flex", alignItems: "center", gap: grasp.space1 },
});

/** What is said under a field whose value can't be sent. */
const useProblemText = () => {
  const { t } = useLingui();
  return (problem: StartFieldProblem): string => {
    if (problem === "missing") {
      return t`Fill this in.`;
    }
    return problem === "integer" ? t`Type a whole number.` : t`Type a number.`;
  };
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
        <div {...stylex.props(styles.person)}>
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
              icon={Cross}
              onClick={() => {
                onChange("");
              }}
              size="sm"
              variant="ghost"
            />
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
            onChange(checked === true);
          }}
        />
      );
    }
    case "choice": {
      return (
        <Select
          items={field.choices}
          onValueChange={(chosen) => {
            onChange(chosen ?? "");
          }}
          value={text === "" ? null : text}
        >
          <SelectTrigger id={id}>
            <SelectValue placeholder={t`Choose…`} />
          </SelectTrigger>
          <SelectContent />
        </Select>
      );
    }
    case "number": {
      return (
        <Input
          id={id}
          inputMode={field.integer ? "numeric" : "decimal"}
          onValueChange={(typed) => {
            onChange(typed);
          }}
          value={text}
        />
      );
    }
    case "text": {
      return (
        <Input
          id={id}
          onValueChange={(typed) => {
            onChange(typed);
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

/** Under an input typed as JSON: the fields the workflow's input takes, in one line. */
export const ExpectedInput = ({ keys }: { keys: readonly string[] }) => {
  const { t } = useLingui();
  const fields = formatList(keys);
  return <FieldDescription>{t`It takes ${fields}.`}</FieldDescription>;
};

/**
 * The Run button, and the dialog it opens: `fields` as a form, or JSON
 * when they are undefined;
 * `start` starts the run with the input and the dialog's key, and says
 * what it started.
 */
const StartDialog = ({
  description,
  fields,
  sketch,
  people = null,
  start,
  onFiles,
  onOpenRun,
}: {
  /** Opens a run beside the workflow's runs: "Open the run" once one started. */
  onOpenRun?: ((id: string) => void) | undefined;
  description: string;
  fields: StartField[] | undefined;
  /** The input's shape, to start the JSON from: none when the page can't know it. */
  sketch?: { json: string; keys: string[] } | undefined;
  /** Whom a field that takes a person may name, as core gave them. */
  people?: PeopleAndTeams | null;
  start: (input: unknown, key: string) => Promise<Started>;
  /** Shows the workflow's Files and apps, where a refused binding is approved. */
  onFiles?: (() => void) | undefined;
}) => {
  const { t } = useLingui();
  const ids = useId();
  const problemText = useProblemText();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<StartValues>({});
  const [json, setJson] = useState(sketch?.json ?? "{}");
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

  const formId = `${ids}-form`;
  const runId = started?.runId;
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
      <DialogTrigger icon={Play} size="sm">
        <span {...stylex.props(styles.barWords)}>
          {t({ message: "Run", context: "start a workflow's run by hand" })}
        </span>
      </DialogTrigger>
      <DialogContent closeLabel={t`Close`}>
        <DialogTitle>{t`Start a run`}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
        <DialogBody>
          <form
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
            {...stylex.props(styles.form)}
          >
            {fields === undefined ? (
              <Field>
                <FieldLabel>{t`Input, as JSON`}</FieldLabel>
                <Textarea
                  mono
                  onValueChange={setJson}
                  spellCheck={false}
                  value={json}
                />
                {sketch === undefined ? null : (
                  <ExpectedInput keys={sketch.keys} />
                )}
              </Field>
            ) : (
              fields.map((field) => {
                const id = `${ids}-${field.name}`;
                const { name } = field;
                return (
                  <Field
                    invalid={problem !== undefined && problem.field === name}
                    key={name}
                  >
                    <FieldLabel>
                      {field.required ? name : t`${name} (optional)`}
                    </FieldLabel>
                    <FieldInput
                      field={field}
                      id={id}
                      onChange={(value) => {
                        setValues({ ...values, [name]: value });
                      }}
                      people={people}
                      value={values[name]}
                    />
                    {problem !== undefined && problem.field === name ? (
                      <ErrorText>{problemText(problem.problem)}</ErrorText>
                    ) : null}
                  </Field>
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
              <output>
                <Text size="sm">
                  {t`The run started. It is listed with the workflow's runs.`}
                </Text>
              </output>
            )}
          </form>
        </DialogBody>
        <DialogFooter>
          <DialogAction>{t`Close`}</DialogAction>
          {/* Once started, the next step is to see it: Open the run takes
              Start's place, and Close closes as before. */}
          {runId !== undefined && onOpenRun !== undefined ? (
            <Button
              onClick={() => {
                setOpen(false);
                onOpenRun(runId);
              }}
              variant="ink"
            >
              {t`Open the run`}
            </Button>
          ) : (
            <Button disabled={busy} form={formId} type="submit" variant="ink">
              {busy ? t`Starting…` : t`Start the run`}
            </Button>
          )}
        </DialogFooter>
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
  onOpenRun,
}: {
  workflow: string;
  onFiles?: () => void;
  /** Opens a run beside the workflow's runs. */
  onOpenRun?: (id: string) => void;
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
    return <ErrorText>{t`Can't offer Run: ${unread}`}</ErrorText>;
  }
  const version = form?.version ?? null;
  if (version === null) {
    return null;
  }
  return (
    <StartDialog
      description={t`Starts version ${version} as you, with the input you give it.`}
      fields={startFieldsOf(form?.args)}
      sketch={inputSketchOf(form?.args)}
      people={form?.people ?? null}
      onFiles={onFiles}
      onOpenRun={onOpenRun}
      start={async (input, key) => {
        const started = await core.withSession(
          async (session) =>
            await session.workflowResources.start(workflow, {
              version,
              args: input,
              key,
            })
        );
        // Its runs, as core lists them now: the new one among them.
        await router.invalidate();
        return { kind: "listed", runId: started.id };
      }}
    />
  );
};
