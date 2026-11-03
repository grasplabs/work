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
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import { Field, FieldLabel } from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import { Textarea } from "@grasp-os/ui/components/textarea";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useId, useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { projectIconShapes } from "./project-icon.tsx";

// Making a project, or changing one: its name, a line on what it is for,
// and its icon. A new project holds nothing and nobody else: what goes in
// it, and who, is added from its page.

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

/** The form, a fresh one for each opening. */
const ProjectForm = ({
  editing,
  onDone,
}: {
  editing?: Editing;
  onDone: (id: string) => void;
}) => {
  const { i18n, t } = useLingui();
  const ids = useId();
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
  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && !busy) {
          void save();
        }
      }}
    >
      <DialogHeader>
        <DialogTitle>
          {editing === undefined ? (
            <Trans>New project</Trans>
          ) : (
            <Trans>Change project</Trans>
          )}
        </DialogTitle>
        <DialogDescription>
          <Trans>
            A project groups apps and workflows for a process, a team or a goal.
            Putting something in it shares it with nobody.
          </Trans>
        </DialogDescription>
      </DialogHeader>
      <Field>
        <FieldLabel htmlFor={`${ids}-name`}>
          <Trans>Name</Trans>
        </FieldLabel>
        <Input
          // Not a login: password managers keep out of it.
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          disabled={busy}
          id={`${ids}-name`}
          maxLength={projectNameMaxLength}
          onChange={(event) => {
            setName(event.target.value);
          }}
          placeholder={t`For example Sell & get paid`}
          value={name}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${ids}-description`}>
          <Trans>What is it for?</Trans>
        </FieldLabel>
        <Textarea
          disabled={busy}
          id={`${ids}-description`}
          maxLength={projectDescriptionMaxLength}
          onChange={(event) => {
            setDescription(event.target.value);
          }}
          rows={2}
          value={description}
        />
      </Field>
      <Field>
        <FieldLabel id={`${ids}-icon`}>
          <Trans>Icon</Trans>
        </FieldLabel>
        <ToggleGroup
          aria-labelledby={`${ids}-icon`}
          disabled={busy}
          onValueChange={(value) => {
            const [next] = value;
            const chosen = projectIcons.find((each) => each === next);
            if (chosen !== undefined) {
              setIcon(chosen);
            }
          }}
          size="sm"
          value={[icon]}
          variant="outline"
        >
          {projectIcons.map((each) => {
            const Shape = projectIconShapes[each];
            return (
              <ToggleGroupItem
                aria-label={i18n._(iconNames[each])}
                key={each}
                value={each}
              >
                <Shape />
              </ToggleGroupItem>
            );
          })}
        </ToggleGroup>
      </Field>
      <ErrorText>{failure}</ErrorText>
      <DialogFooter>
        <DialogClose
          disabled={busy}
          render={<Button type="button" variant="outline" />}
        >
          <Trans>Cancel</Trans>
        </DialogClose>
        <Button disabled={!valid || busy} type="submit">
          {editing === undefined ? (
            <Trans>Make project</Trans>
          ) : (
            <Trans>Save</Trans>
          )}
        </Button>
      </DialogFooter>
    </form>
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
    <DialogContent>
      {open ? (
        <ProjectForm
          editing={editing}
          onDone={(id) => {
            onOpenChange(false);
            onDone(id);
          }}
        />
      ) : null}
    </DialogContent>
  </Dialog>
);
