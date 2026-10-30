import type { ChatProject, ChatSummary } from "@grasp-os/shared/chat";
import { Plural, Trans } from "@lingui/react/macro";
import { Link, useNavigate } from "@tanstack/react-router";
import { FolderIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { chatsByProject } from "./chat-projects.ts";
import { ProjectDialog } from "./project-dialog.tsx";

// The person's projects under the box on an empty chat
// (grasplabs/prototype `components/chat/project-shelf.tsx`), as the place
// they start from: a quiet row each, the most recently used first, with
// how many chats it holds, and a new project from the line above them. A
// row opens the project's page, where its chats, instructions and files
// are.

/**
 * The projects, the most recently used first: by their latest chat's
 * last use, or, holding none, by when they were made.
 */
export const projectsByUse = (
  projects: readonly ChatProject[],
  chats: readonly ChatSummary[]
): { project: ChatProject; chats: number }[] => {
  const { inProject } = chatsByProject(chats, projects);
  const lastUsed = (project: ChatProject): string => {
    let latest = project.createdAt;
    for (const chat of inProject.get(project.id) ?? []) {
      if (chat.lastAt > latest) {
        latest = chat.lastAt;
      }
    }
    return latest;
  };
  return projects
    .toSorted((a, b) => lastUsed(b).localeCompare(lastUsed(a)))
    .map((project) => ({
      project,
      chats: inProject.get(project.id)?.length ?? 0,
    }));
};

export const ProjectShelf = ({
  projects,
  chats,
}: {
  projects: readonly ChatProject[];
  chats: readonly ChatSummary[];
}) => {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const shelf = projectsByUse(projects, chats);
  return (
    <section aria-labelledby="project-shelf" className="flex flex-col">
      <div className="flex items-center justify-between gap-2 pr-2 pb-1 pl-4.5">
        <h2 className="text-muted-foreground text-xs" id="project-shelf">
          <Trans>Projects</Trans>
        </h2>
        <button
          className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring/50 flex items-center gap-1 rounded-md px-2.5 py-1 text-xs transition-colors duration-150 outline-none focus-visible:ring-3"
          onClick={() => {
            setCreating(true);
          }}
          type="button"
        >
          <PlusIcon aria-hidden="true" className="size-3.5" />
          <Trans>New project</Trans>
        </button>
      </div>
      <ul className="flex flex-col">
        {shelf.map(({ project, chats: count }) => (
          <li className="flex" key={project.id}>
            <Link
              className="hover:bg-muted focus-visible:ring-ring/50 flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-4.5 py-2 text-sm transition-colors duration-150 outline-none focus-visible:ring-3"
              params={{ projectId: project.id }}
              to="/projects/$projectId"
            >
              <FolderIcon
                aria-hidden="true"
                className="text-muted-foreground size-4 flex-none"
              />
              <span className="truncate">{project.name}</span>
              <span className="text-muted-foreground ml-auto flex-none text-xs">
                <Plural one="# chat" other="# chats" value={count} />
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <ProjectDialog
        onOpenChange={setCreating}
        onSaved={(projectId) => {
          void navigate({
            to: "/projects/$projectId",
            params: { projectId },
          });
        }}
        open={creating}
      />
    </section>
  );
};
