import type { Project, ProjectItemCandidate } from "@grasp-os/shared/projects";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { ErrorText } from "../error-text.tsx";
import { formatList } from "../format.ts";
import { Button } from "../grasp/button/index.ts";
import { Checkbox } from "../grasp/checkbox/index.ts";
import { Combobox } from "../grasp/combobox/index.ts";
import type { ComboboxItems } from "../grasp/combobox/index.ts";
import {
  Dialog,
  DialogAction,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../grasp/dialog/index.ts";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "../grasp/field/index.ts";
import { Plus } from "../grasp/icons/index.ts";
import { useCoreAction } from "../use-core-action.ts";
import { namesInProject } from "./project-people-names.ts";

// Putting an App or workflow the person can open in a project, in the
// library's Dialog: one field to find it by name (a Combobox, grouped into
// Apps and Workflows, so a long list is never unsearched). Filing shares
// nothing: "Also give the N people in X access?" is off unless they tick
// it, says who gains access, and is offered only for what they build,
// since only a builder shares.

/** What a candidate is called in the field: its type and ID. */
const keyOf = ({ type, id }: ProjectItemCandidate): string => `${type}:${id}`;

/** The candidates as the field lists them: Apps, then workflows. */
const itemsOf = (
  candidates: readonly ProjectItemCandidate[],
  words: { apps: string; workflows: string }
): ComboboxItems => {
  const group = (type: ProjectItemCandidate["type"], label: string) => {
    const items = candidates
      .filter((candidate) => candidate.type === type)
      .map((candidate) => ({ value: keyOf(candidate), label: candidate.name }));
    return items.length === 0 ? [] : [{ type: "group" as const, label, items }];
  };
  return [...group("app", words.apps), ...group("workflow", words.workflows)];
};

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
  const router = useRouter();
  const { failure, run } = useCoreAction();
  const [chosen, setChosen] = useState<string | null>(null);
  const [share, setShare] = useState(false);
  const picked = candidates?.find((candidate) => keyOf(candidate) === chosen);
  const { people } = project;
  const projectName = project.name;
  const who = formatList(namesInProject(project));
  const file = async (): Promise<void> => {
    if (picked === undefined) {
      throw new Error("Nothing is chosen.");
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
    if (done !== true) {
      // The dialog stays open, with core's reason under the field.
      throw new Error("It wasn't added.");
    }
    onDone();
  };
  return (
    <>
      <DialogBody>
        <Field name="project-item">
          <FieldLabel>{t`App or workflow`}</FieldLabel>
          <Combobox
            disabled={candidates === undefined}
            items={itemsOf(candidates ?? [], {
              apps: t`Apps`,
              workflows: t`Workflows`,
            })}
            onValueChange={(value) => {
              setChosen(value);
              setShare(false);
            }}
            placeholder={t`Find an app or workflow`}
            triggerLabel={t`Show the apps and workflows`}
            value={chosen}
          />
        </Field>
        {picked?.builds === true ? (
          <Field orientation="horizontal">
            <Checkbox
              checked={share}
              onCheckedChange={(checked) => {
                setShare(checked === true);
              }}
            />
            <FieldContent>
              <FieldLabel>
                {t`${plural(people, {
                  one: `Also give the # person in ${projectName} access?`,
                  other: `Also give the # people in ${projectName} access?`,
                })}`}
              </FieldLabel>
              <FieldDescription>{t`That is ${who}.`}</FieldDescription>
            </FieldContent>
          </Field>
        ) : null}
        <ErrorText>{failure}</ErrorText>
      </DialogBody>
      <DialogFooter>
        <DialogAction>{t`Cancel`}</DialogAction>
        <DialogAction
          action={file}
          disabled={picked === undefined}
          failedLabel={t`Not added`}
          variant="ink"
          workingLabel={t`Adding`}
        >
          {t({ message: "Add", context: "put in a project" })}
        </DialogAction>
      </DialogFooter>
    </>
  );
};

/** Add on a project's page, for its builders. */
export const FileItemDialog = ({ project }: { project: Project }) => {
  const { t } = useLingui();
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
  const projectName = project.name;
  return (
    <>
      <Button
        icon={Plus}
        onClick={() => {
          setOpen(true);
          void read();
        }}
        variant="quiet"
      >
        {t({ message: "Add", context: "put in a project" })}
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent closeLabel={t`Close`}>
          <DialogTitle>{t`Add to ${projectName}`}</DialogTitle>
          {/* Said here, as one might think adding shares: it doesn't. */}
          <DialogDescription>
            {t`Adding an app or workflow shares it with nobody. Only those it is shared with see it here.`}
          </DialogDescription>
          {open ? (
            <FileForm
              candidates={candidates}
              onDone={() => {
                setOpen(false);
              }}
              project={project}
            />
          ) : null}
          <ErrorText>{failure}</ErrorText>
        </DialogContent>
      </Dialog>
    </>
  );
};
