import type { Project } from "@grasp-os/shared/projects";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { Avatar, AvatarFallback } from "../grasp/avatar/index.ts";
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
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { ProjectPeople } from "./project-people.tsx";

// Who is in a project, in its header: their faces, overlapping, and how
// many more; pressing them, or Add, opens the people in a dialog, where
// its builders add and take people out. Grasp UI has no avatar stack:
// this overlaps its Avatars, nothing more.

/** How many faces show before the rest are counted. */
const shownFaces = 4;

const styles = stylex.create({
  row: {
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space2,
  },
  faces: {
    display: "inline-flex",
    alignItems: "center",
  },
  face: {
    marginInlineStart: `calc(-1 * ${grasp.space1})`,
  },
  first: {
    marginInlineStart: 0,
  },
});

/** The project's people as faces, and the dialog that lists them. */
export const ProjectPeopleStack = ({ project }: { project: Project }) => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const builds = project.role === "builder";
  const names = [
    project.owner.name ?? project.owner.id,
    ...project.members.map(({ name, id }) => name ?? id),
  ];
  const more = project.people - Math.min(names.length, shownFaces);
  const count = project.people;
  const openPeople = () => {
    setOpen(true);
  };
  return (
    <span {...stylex.props(styles.row)}>
      <Button
        aria-label={t`People in it: ${count}`}
        onClick={openPeople}
        variant="ghost"
      >
        <span {...stylex.props(styles.faces)}>
          {names.slice(0, shownFaces).map((name, index) => (
            <span
              key={`${name}-${String(index)}`}
              {...stylex.props(styles.face, index === 0 && styles.first)}
            >
              <Avatar decorative name={name} size="xs">
                <AvatarFallback />
              </Avatar>
            </span>
          ))}
          {more > 0 ? (
            <Text element="span" size="xs" tone="muted">
              {` +${String(more)}`}
            </Text>
          ) : null}
        </span>
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
        <DialogContent closeLabel={t`Close`}>
          <DialogTitle>{t`People`}</DialogTitle>
          <DialogBody>
            <ProjectPeople project={project} />
          </DialogBody>
          <DialogFooter>
            <DialogAction>{t`Close`}</DialogAction>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </span>
  );
};
