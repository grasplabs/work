import {
  newProjectSchema,
  projectDescriptionMaxLength,
  projectIcons,
  projectNameMaxLength,
} from "@grasp-os/shared/projects";
import type { ProjectIcon, ProjectSummary } from "@grasp-os/shared/projects";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import { Field, FieldLabel } from "@grasp-os/ui/components/field";
import { Form } from "@grasp-os/ui/components/form";
import { Input } from "@grasp-os/ui/components/input";
import { Textarea } from "@grasp-os/ui/components/textarea";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import { Icon } from "@grasp-os/ui/lib/icons";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useId, useState } from "react";

import { ErrorText } from "../error-text.tsx";
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
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        {/* What a project is, said once, as one is made; changing it, the person knows. */}
        {editing === undefined ? (
          <DialogDescription>
            {t`A project groups apps and workflows for a process, a team or a goal. Putting something in it shares it with nobody.`}
          </DialogDescription>
        ) : null}
      </DialogHeader>
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
            <FieldLabel>
              {t({ message: "What it is for", context: "a project" })}
            </FieldLabel>
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
                <ToggleGroupItem
                  aria-label={i18n._(iconNames[each])}
                  key={each}
                  value={each}
                >
                  <Icon icon={projectIconShapes[each]} />
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>
        </Form>
        <ErrorText>{failure}</ErrorText>
      </DialogBody>
      <DialogFooter>
        <DialogClose>{t`Cancel`}</DialogClose>
        <Button
          disabled={!valid || busy}
          form={formId}
          // At the footer's own height, as #2503's: Damsko's footer makes
          // a Button with no size a small one.
          size="default"
          type="submit"
          variant="default"
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
