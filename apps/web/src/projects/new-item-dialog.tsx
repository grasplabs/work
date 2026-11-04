import type { Project } from "@grasp-os/shared/projects";
import { Button } from "@grasp-os/ui/components/button";
import { Checkbox } from "@grasp-os/ui/components/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@grasp-os/ui/components/dialog";
import { Field, FieldLabel } from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import { Trans, useLingui } from "@lingui/react/macro";
import { useNavigate } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useId, useState } from "react";

import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { formatList } from "../format.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useMadeOnce } from "../use-made-once.ts";
import { useNewWorkflow } from "../workflows/new-workflow.ts";
import { namesInProject } from "./project-people-names.ts";

// Making an App or a workflow from inside a project: it goes in the
// project, and starts shared with everyone in it as users, which can be
// switched off before making it. Made first, then filed (and shared); a
// share core refuses leaves the new item made and filed nowhere, and
// making it again with the same name files that one rather than making
// another. A workflow opens as New workflow's do (new-workflow.ts).

type Kind = "app" | "workflow";

/** The form, a fresh one for each opening. */
const NewItemForm = ({ project }: { project: Project }) => {
  const { t } = useLingui();
  const ids = useId();
  const navigate = useNavigate();
  const app = useCoreAction();
  const workflow = useNewWorkflow();
  const { once } = useMadeOnce();
  const [kind, setKind] = useState<Kind>("workflow");
  const [name, setName] = useState("");
  const [share, setShare] = useState(true);
  const busy = app.busy || workflow.busy;
  const failure = kind === "app" ? app.failure : workflow.failure;
  const projectName = project.name;
  const who = formatList(namesInProject(project));
  const fileIn = async (
    session: Session,
    type: Kind,
    id: string
  ): Promise<void> => {
    await session.projects.file(project.id, { item: { type, id }, share });
  };
  const make = async (): Promise<void> => {
    if (kind === "workflow") {
      await workflow.make(name, async (session, id) => {
        await fileIn(session, "workflow", id);
      });
      return;
    }
    const typed = name.trim();
    const made = await app.run(async (session) => {
      const id = await once(typed, async () => {
        const created = await session.apps.create({ name: typed });
        return created.id;
      });
      await fileIn(session, "app", id);
      return id;
    });
    if (made !== undefined) {
      await navigate({ to: "/apps/$app/edit", params: { app: made } });
    }
  };
  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim() !== "" && !busy) {
          void make();
        }
      }}
    >
      <DialogHeader>
        <DialogTitle>
          <Trans>New in {projectName}</Trans>
        </DialogTitle>
        <DialogDescription>
          <Trans>It goes in the project from the start.</Trans>
        </DialogDescription>
      </DialogHeader>
      <ToggleGroup
        aria-label={t`What to make`}
        disabled={busy}
        onValueChange={(value) => {
          const [next] = value;
          if (next === "app" || next === "workflow") {
            setKind(next);
          }
        }}
        size="sm"
        value={[kind]}
        variant="outline"
      >
        <ToggleGroupItem value="workflow">
          <Trans>Workflow</Trans>
        </ToggleGroupItem>
        <ToggleGroupItem value="app">
          <Trans>App</Trans>
        </ToggleGroupItem>
      </ToggleGroup>
      <Field>
        <FieldLabel htmlFor={`${ids}-name`}>
          <Trans>Name</Trans>
        </FieldLabel>
        <Input
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          disabled={busy}
          id={`${ids}-name`}
          onChange={(event) => {
            setName(event.target.value);
          }}
          value={name}
        />
      </Field>
      <Field orientation="horizontal">
        <Checkbox
          checked={share}
          disabled={busy}
          id={`${ids}-share`}
          onCheckedChange={(checked) => {
            setShare(checked);
          }}
        />
        <FieldLabel htmlFor={`${ids}-share`}>
          <span>
            <Trans>Share it with everyone in {projectName}.</Trans>{" "}
            <span className="text-muted-foreground">
              <Trans>That is {who}.</Trans>
            </span>
          </span>
        </FieldLabel>
      </Field>
      <ErrorText>{failure}</ErrorText>
      <DialogFooter>
        <DialogClose
          disabled={busy}
          render={<Button type="button" variant="outline" />}
        >
          <Trans>Cancel</Trans>
        </DialogClose>
        <Button disabled={name.trim() === "" || busy} type="submit">
          <Trans>Make</Trans>
        </Button>
      </DialogFooter>
    </form>
  );
};

/** New on a project's page, for builders of it who build. */
export const NewItemDialog = ({ project }: { project: Project }) => {
  const [open, setOpen] = useState(false);
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger render={<Button />}>
        <PlusIcon data-icon="inline-start" />
        <Trans context="make something in a project">New</Trans>
      </DialogTrigger>
      <DialogContent>
        {open ? <NewItemForm project={project} /> : null}
      </DialogContent>
    </Dialog>
  );
};
