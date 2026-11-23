import type { Project } from "@grasp-os/shared/projects";
import { AvatarGroup } from "@grasp-os/ui/components/avatar";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import { Icon, UserPlusIcon } from "@grasp-os/ui/lib/icons";
import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";

import { ProjectPeople } from "./project-people.tsx";

// Who is in a project, in its header: Damsko's AvatarGroup of their
// faces; pressing them, or Add people, opens the people in a dialog,
// where its builders add and take people out.

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
        tooltip={false}
        variant="ghost"
      >
        <AvatarGroup items={names.map((name) => ({ name }))} size="xs" />
      </Button>
      {builds ? (
        <Button
          aria-label={t`Add people`}
          onClick={openPeople}
          size="icon"
          variant="secondary"
        >
          <Icon icon={UserPlusIcon} />
        </Button>
      ) : null}
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              <Trans>People</Trans>
            </DialogTitle>
          </DialogHeader>
          <DialogBody>
            <ProjectPeople project={project} />
          </DialogBody>
          <DialogFooter>
            <DialogClose>
              <Trans>Close</Trans>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
