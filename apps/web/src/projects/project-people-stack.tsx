import type { Project } from "@grasp-os/shared/projects";
import { useLingui } from "@lingui/react/macro";
import { useState } from "react";

import { AvatarGroup } from "../grasp/avatar/index.ts";
import { Button } from "../grasp/button/index.ts";
import {
  Dialog,
  DialogAction,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "../grasp/dialog/index.ts";
import { UserAdd } from "../grasp/icons/index.ts";
import { ProjectPeople } from "./project-people.tsx";

// Who is in a project, in its header: Grasp UI's AvatarGroup of their
// faces; pressing them, or Add, opens the people in a dialog, where its
// builders add and take people out.

/** The project's people as faces, and the dialog that lists them. */
export const ProjectPeopleStack = ({ project }: { project: Project }) => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const builds = project.role === "builder";
  const names = [
    project.owner.name ?? project.owner.id,
    ...project.members.map(({ name, id }) => name ?? id),
  ];
  const count = project.people;
  const openPeople = () => {
    setOpen(true);
  };
  return (
    <>
      <Button
        aria-label={t`People in it: ${count}`}
        onClick={openPeople}
        variant="ghost"
      >
        <AvatarGroup people={names.map((name) => ({ name }))} size="xs" />
      </Button>
      {builds ? (
        <Button
          aria-label={t`Add people`}
          icon={UserAdd}
          onClick={openPeople}
          variant="quiet"
        />
      ) : null}
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent>
          <DialogTitle>{t`People`}</DialogTitle>
          <DialogBody>
            <ProjectPeople project={project} />
          </DialogBody>
          <DialogFooter>
            <DialogAction>{t`Close`}</DialogAction>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
