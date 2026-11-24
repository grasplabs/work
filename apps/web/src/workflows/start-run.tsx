import { failureText } from "@grasp-os/shared/errors";
import { roleSchema } from "@grasp-os/shared/roles";
import type { WorkflowStartForm } from "@grasp-os/shared/workflow-resources";
import { Button } from "@grasp-os/ui/components/button";
import { Checkbox } from "@grasp-os/ui/components/checkbox";
import { Combobox, ComboboxEmpty } from "@grasp-os/ui/components/combobox";
import type { ComboboxItems } from "@grasp-os/ui/components/combobox";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@grasp-os/ui/components/dialog";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { Text } from "@grasp-os/ui/components/text";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { Icon, PlayIcon } from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { formatList } from "../format.ts";
import { roleLabel } from "../labels.ts";
import { usePeopleApart } from "../people/people-apart.ts";
import type { PeopleApart } from "../people/people-apart.ts";
import { subjectKey } from "../people/people-teams-picker.tsx";
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
  form: { display: "grid", rowGap: space["4"] },
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

/**
 * Whom a field that takes a person may name, as a search's items: the
 * people (told apart from a namesake), the teams, and everyone with a
 * role, each under the key a start's input names it by (`subjectKey`). A
 * group with nobody in it (an organization without teams) has no heading.
 */
const usePickable = () => {
  const { t } = useLingui();
  return (people: PeopleAndTeams | null, apart: PeopleApart): ComboboxItems =>
    [
      {
        type: "group" as const,
        label: t`People`,
        items: (people?.people ?? []).map((person) => ({
          value: subjectKey({ type: "person", id: person.id }),
          label: apart.named(person),
        })),
      },
      {
        type: "group" as const,
        label: t`Teams`,
        items: (people?.teams ?? []).map((team) => ({
          value: subjectKey({ type: "team", id: team.id }),
          label: team.name,
        })),
      },
      {
        type: "group" as const,
        label: t`Roles`,
        items: roleSchema.options.map((role) => {
          const name = roleLabel(role);
          return {
            value: subjectKey({ type: "role", id: role }),
            label: t`Everyone with the ${name} role`,
          };
        }),
      },
    ].filter((group) => group.items.length > 0);
};

/** One input field, as `field` asks for it. */
const FieldInput = ({
  field,
  value,
  people,
  onChange,
}: {
  field: StartField;
  value: string | boolean | undefined;
  /** Whom a field that takes a person may name, as core gave them. */
  people: PeopleAndTeams | null;
  onChange: (value: string | boolean) => void;
}) => {
  const { t } = useLingui();
  const apart = usePeopleApart(people?.people ?? []);
  const pickable = usePickable();
  const text = typeof value === "string" ? value : "";
  switch (field.kind) {
    case "person": {
      // Picked from the organization's people, teams and roles, as a
      // search; emptying its words picks nobody again (the Combobox's
      // own clearing). Core checks the start's input again.
      return (
        <Combobox
          items={pickable(people, apart)}
          onValueChange={(chosen) => {
            onChange(chosen ?? "");
          }}
          placeholder={t`Search people, teams and roles`}
          value={text === "" ? null : text}
        >
          <ComboboxEmpty>{t`Nobody has that name.`}</ComboboxEmpty>
        </Combobox>
      );
    }
    case "yes": {
      return (
        <Checkbox
          checked={value === true}
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
          <SelectTrigger>
            <SelectValue placeholder={t`Choose…`} />
          </SelectTrigger>
          <SelectContent />
        </Select>
      );
    }
    case "number": {
      return (
        <Input
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
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Icon icon={PlayIcon} />
          <span {...stylex.props(styles.barWords)}>
            {t({ message: "Run", context: "start a workflow's run by hand" })}
          </span>
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t`Start a run`}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
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
                const { name } = field;
                return (
                  <Field
                    {...(problem !== undefined && problem.field === name
                      ? { "data-invalid": true }
                      : {})}
                    key={name}
                  >
                    <FieldLabel>
                      {field.required ? name : t`${name} (optional)`}
                    </FieldLabel>
                    <FieldInput
                      field={field}
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
          <DialogClose>{t`Close`}</DialogClose>
          {/* Once started, the next step is to see it: Open the run takes
              Start's place, and Close closes as before. */}
          {runId !== undefined && onOpenRun !== undefined ? (
            <Button
              onClick={() => {
                setOpen(false);
                onOpenRun(runId);
              }}
            >
              {t`Open the run`}
            </Button>
          ) : (
            <Button disabled={busy} form={formId} type="submit">
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
  live,
  onFiles,
  onOpenRun,
}: {
  workflow: string;
  /** The version live now: what Run starts is read again for each, in place, so a Run dialog already open stays open. None live, there is nothing to start. */
  live: number | null;
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
      if (live === null) {
        return;
      }
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
  }, [core, workflow, live]);

  if (live === null) {
    return null;
  }
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
              // The version the form was filled in for: core says so if
              // another went live meanwhile.
              expected: version,
              args: input,
              key,
            })
        );
        // Its runs, as core lists them now: the new one among them.
        await router.invalidate({ sync: true });
        return { kind: "listed", runId: started.id };
      }}
    />
  );
};
