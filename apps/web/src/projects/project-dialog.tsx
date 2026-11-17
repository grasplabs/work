import {
  newProjectSchema,
  projectDescriptionMaxLength,
  projectIcons,
  projectNameMaxLength,
} from "@grasp-os/shared/projects";
import type { ProjectIcon, ProjectSummary } from "@grasp-os/shared/projects";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useId, useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { Button } from "../grasp/button/index.ts";
import {
  Dialog,
  DialogAction,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogContent,
  DialogTitle,
} from "../grasp/dialog/index.ts";
import { Field, FieldLabel } from "../grasp/field/index.ts";
import { Form } from "../grasp/form/index.ts";
import { Input } from "../grasp/input/index.ts";
import { Textarea } from "../grasp/textarea/index.ts";
import { Toggle, ToggleGroup } from "../grasp/toggle/index.ts";
import { useCoreAction } from "../use-core-action.ts";
import { projectIconShapes } from "./project-icon.tsx";

// Making a project, or changing one: its name, a line on what it is for,
// and its icon, in Grasp UI's dialog. A new project holds nothing and
// nobody else: what goes in it, and who, is added from its page.

/** Each icon's name, for whoever can't see it. */
const iconNames: Record<ProjectIcon, MessageDescriptor> = {
  folder: msg`Folder`,
  briefcase: msg`Briefcase`,
  target: msg`Target`,
  users: msg`People`,
  coins: msg`Coins`,
  rocket: msg`Rocket`,
  chart: msg`Chart`,
  lightbulb: msg`Lightbulb`,
  wrench: msg`Wrench`,
  sparkles: msg`Sparkles`,
};

/** What the form starts from: nothing, or the project it changes. */
type Editing = Pick<ProjectSummary, "id" | "name" | "description" | "icon">;

/** The dialog's panel, a fresh one for each opening. */
const ProjectForm = ({
  editing,
  onDone,
}: {
  editing?: Editing;
  onDone: (id: string) => void;
}) => {
  const { i18n, t } = useLingui();
  const formId = useId();
  const { busy, failure, run } = useCoreAction();
  const [name, setName] = useState(editing?.name ?? "");
  const [description, setDescription] = useState(editing?.description ?? "");
  const [icon, setIcon] = useState<ProjectIcon>(editing?.icon ?? "folder");
  const valid = newProjectSchema.safeParse({ name, description, icon }).success;
  const save = async (): Promise<void> => {
    const fields = { name: name.trim(), description: description.trim(), icon };
    const id = await run(async (session) => {
      if (editing === undefined) {
        const made = await session.projects.create(fields);
        return made.id;
      }
      await session.projects.update(editing.id, fields);
      return editing.id;
    });
    if (id !== undefined) {
      onDone(id);
    }
  };
  const title = editing === undefined ? t`New project` : t`Change project`;
  return (
    <DialogContent closeLabel={t`Close`}>
      <DialogTitle>{title}</DialogTitle>
      <DialogDescription>
        {t`A project groups apps and workflows for a process, a team or a goal. Putting something in it shares it with nobody.`}
      </DialogDescription>
      <DialogBody>
        <Form
          aria-label={title}
          id={formId}
          onSubmit={(event) => {
            event.preventDefault();
            if (valid && !busy) {
              void save();
            }
          }}
        >
          <Field>
            <FieldLabel>{t`Name`}</FieldLabel>
            <Input
              // Not a login: password managers keep out of it.
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
              disabled={busy}
              maxLength={projectNameMaxLength}
              onValueChange={setName}
              placeholder={t`For example Sell & get paid`}
              required
              value={name}
            />
          </Field>
          <Field>
            <FieldLabel>{t`What is it for?`}</FieldLabel>
            <Textarea
              disabled={busy}
              maxLength={projectDescriptionMaxLength}
              onValueChange={setDescription}
              rows={2}
              value={description}
            />
          </Field>
          <Field>
            <FieldLabel>{t`Icon`}</FieldLabel>
            <ToggleGroup
              aria-label={t`Icon`}
              disabled={busy}
              onValueChange={(value) => {
                const [next] = value;
                const chosen = projectIcons.find((each) => each === next);
                if (chosen !== undefined) {
                  setIcon(chosen);
                }
              }}
              value={[icon]}
            >
              {projectIcons.map((each) => (
                <Toggle
                  aria-label={i18n._(iconNames[each])}
                  icon={projectIconShapes[each]}
                  key={each}
                  value={each}
                />
              ))}
            </ToggleGroup>
          </Field>
        </Form>
        <ErrorText>{failure}</ErrorText>
      </DialogBody>
      <DialogFooter>
        <DialogAction>{t`Cancel`}</DialogAction>
        <Button
          disabled={!valid || busy}
          form={formId}
          type="submit"
          variant="ink"
        >
          {editing === undefined ? t`Make project` : t`Save`}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
};

/**
 * Makes a project, or changes `editing`; `onDone` gets its ID, the dialog
 * closing first.
 */
export const ProjectDialog = ({
  open,
  onOpenChange,
  onDone,
  editing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: (id: string) => void;
  editing?: Editing;
}) => (
  <Dialog onOpenChange={onOpenChange} open={open}>
    {open ? (
      <ProjectForm
        editing={editing}
        onDone={(id) => {
          onOpenChange(false);
          onDone(id);
        }}
      />
    ) : null}
  </Dialog>
);
