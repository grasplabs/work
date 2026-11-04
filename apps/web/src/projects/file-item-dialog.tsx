import type { Project, ProjectItemCandidate } from "@grasp-os/shared/projects";
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
import {
  NativeSelect,
  NativeSelectOptGroup,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useId, useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { ErrorText } from "../error-text.tsx";
import { formatList } from "../format.ts";
import { useCoreAction } from "../use-core-action.ts";
import { namesInProject } from "./project-people-names.ts";

// Putting an App or workflow the person can open in a project. Filing
// shares nothing: "Also give the N people in X access?" is off unless
// they tick it, says who gains access, and is offered only for what they
// build, since only a builder shares.

/** The form, a fresh one for each opening. */
const FileForm = ({
  project,
  candidates,
  onDone,
}: {
  project: Project;
  /** What the person may add; undefined while it is read. */
  candidates: ProjectItemCandidate[] | undefined;
  onDone: () => void;
}) => {
  const { t } = useLingui();
  const ids = useId();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const [chosen, setChosen] = useState("");
  const [share, setShare] = useState(false);
  const picked = candidates?.find(({ type, id }) => `${type}:${id}` === chosen);
  const { people } = project;
  const projectName = project.name;
  const who = formatList(namesInProject(project));
  const file = async (): Promise<void> => {
    if (picked === undefined) {
      return;
    }
    const done = await run(async (session) => {
      await changeThenRefresh(
        async () => {
          await session.projects.file(project.id, {
            item: { type: picked.type, id: picked.id },
            share: share && picked.builds,
          });
        },
        async () => {
          await router.invalidate({ sync: true });
        }
      );
      return true;
    });
    if (done === true) {
      onDone();
    }
  };
  const apps = (candidates ?? []).filter(({ type }) => type === "app");
  const workflows = (candidates ?? []).filter(
    ({ type }) => type === "workflow"
  );
  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (picked !== undefined && !busy) {
          void file();
        }
      }}
    >
      <DialogHeader>
        <DialogTitle>
          <Trans>Add to {projectName}</Trans>
        </DialogTitle>
        <DialogDescription>
          <Trans>
            Adding an app or workflow shares it with nobody. Only those it is
            shared with see it here.
          </Trans>
        </DialogDescription>
      </DialogHeader>
      <Field>
        <FieldLabel htmlFor={`${ids}-item`}>
          <Trans>App or workflow</Trans>
        </FieldLabel>
        <NativeSelect
          disabled={busy || candidates === undefined}
          id={`${ids}-item`}
          onChange={(event) => {
            setChosen(event.target.value);
            setShare(false);
          }}
          value={chosen}
        >
          <NativeSelectOption value="">{t`Choose…`}</NativeSelectOption>
          {apps.length === 0 ? null : (
            <NativeSelectOptGroup label={t`Apps`}>
              {apps.map((app) => (
                <NativeSelectOption key={app.id} value={`app:${app.id}`}>
                  {app.name}
                </NativeSelectOption>
              ))}
            </NativeSelectOptGroup>
          )}
          {workflows.length === 0 ? null : (
            <NativeSelectOptGroup label={t`Workflows`}>
              {workflows.map((workflow) => (
                <NativeSelectOption
                  key={workflow.id}
                  value={`workflow:${workflow.id}`}
                >
                  {workflow.name}
                </NativeSelectOption>
              ))}
            </NativeSelectOptGroup>
          )}
        </NativeSelect>
      </Field>
      {picked?.builds === true ? (
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
              <Plural
                one={`Also give the # person in ${projectName} access?`}
                other={`Also give the # people in ${projectName} access?`}
                value={people}
              />{" "}
              <span className="text-muted-foreground">
                <Trans>That is {who}.</Trans>
              </span>
            </span>
          </FieldLabel>
        </Field>
      ) : null}
      <ErrorText>{failure}</ErrorText>
      <DialogFooter>
        <DialogClose
          disabled={busy}
          render={<Button type="button" variant="outline" />}
        >
          <Trans>Cancel</Trans>
        </DialogClose>
        <Button disabled={picked === undefined || busy} type="submit">
          <Trans context="put in a project">Add</Trans>
        </Button>
      </DialogFooter>
    </form>
  );
};

/** Add on a project's page, for its builders. */
export const FileItemDialog = ({ project }: { project: Project }) => {
  const { failure, run } = useCoreAction();
  const [open, setOpen] = useState(false);
  const [candidates, setCandidates] = useState<ProjectItemCandidate[]>();
  const read = async (): Promise<void> => {
    setCandidates(undefined);
    const listed = await run(
      async (session) => await session.projects.itemCandidates(project.id)
    );
    setCandidates(listed ?? []);
  };
  return (
    <Dialog
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          void read();
        }
      }}
      open={open}
    >
      <DialogTrigger render={<Button variant="outline" />}>
        <PlusIcon data-icon="inline-start" />
        <Trans context="put in a project">Add</Trans>
      </DialogTrigger>
      <DialogContent>
        {open ? (
          <>
            <FileForm
              candidates={candidates}
              onDone={() => {
                setOpen(false);
              }}
              project={project}
            />
            <ErrorText>{failure}</ErrorText>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
};
