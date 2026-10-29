import type { ChatProject, ChatSummary } from "@grasp-os/shared/chat";
import { chatTitleSchema } from "@grasp-os/shared/chat";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import { Input } from "@grasp-os/ui/components/input";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import {
  CheckIcon,
  EllipsisIcon,
  FolderIcon,
  FolderInputIcon,
  FolderMinusIcon,
  FolderPlusIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";

// What can be done to a chat where it is listed, in the ⌘K window or on its
// project's page (grasplabs/prototype `components/chat/chat-menus.tsx`):
// rename it in place, move it into a project or out of one, start a project
// for it, and delete it after a check; and deleting a project. Each goes to
// core, and the page reads its lists again once it has.

/** The longest name a chat takes, as core checks it. */
export const chatTitleMaxLength = 200;

/**
 * A name being changed in place: Enter or leaving the field keeps it,
 * Escape keeps the old one. `onDone` gets the new name, or `null` when
 * nothing should change, and whether a key ended it, so the focus can go
 * back to the row (leaving the field put it somewhere else already).
 */
export const RenameField = ({
  value,
  label,
  maxLength,
  onDone,
}: {
  value: string;
  label: string;
  maxLength: number;
  onDone: (name: string | null, byKey: boolean) => void;
}) => {
  const [text, setText] = useState(value);
  // Enter and Escape end it before the field loses focus; leaving it must
  // not end it a second time.
  const done = useRef(false);
  const finish = (name: string | null, byKey: boolean): void => {
    if (done.current) {
      return;
    }
    done.current = true;
    onDone(name, byKey);
  };
  return (
    <Input
      aria-label={label}
      // It opens to be typed in.
      autoFocus
      maxLength={maxLength}
      onBlur={() => {
        finish(text, false);
      }}
      onChange={(event) => {
        setText(event.target.value);
      }}
      onFocus={(event) => {
        event.currentTarget.select();
      }}
      onKeyDown={(event) => {
        // The window around it keeps its own keys out of a name being typed.
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          finish(text, true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          finish(null, true);
        }
      }}
      value={text}
    />
  );
};

/**
 * For a row that is renamed in place: the ref for what the row is focused
 * by, given the focus back once Enter or Escape ended the renaming.
 */
export const useRenameFocus = <Element extends HTMLElement>(
  renaming: boolean
) => {
  const row = useRef<Element>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (renaming || !refocus.current) {
      return;
    }
    refocus.current = false;
    row.current?.focus();
  }, [renaming]);
  return {
    row,
    ended: (byKey: boolean) => {
      refocus.current = byKey;
    },
  };
};

/** Renaming and moving one of the person's chats, then reading the page again. */
export const useChatChanges = (chat: ChatSummary) => {
  const router = useRouter();
  const { failure, run } = useCoreAction();
  const rename = async (name: string | null): Promise<void> => {
    const trimmed = name?.trim();
    if (
      trimmed === undefined ||
      trimmed === chat.title ||
      !chatTitleSchema.safeParse(trimmed).success
    ) {
      return;
    }
    const renamed = await run(async (session) => {
      await session.chats.rename(chat.id, trimmed);
      return true;
    });
    if (renamed === true) {
      await router.invalidate();
    }
  };
  const move = async (projectId: string | null): Promise<void> => {
    const moved = await run(async (session) => {
      await session.chats.moveChat(chat.id, projectId);
      return true;
    });
    if (moved === true) {
      await router.invalidate();
    }
  };
  return { failure, rename, move };
};

/**
 * A chat's three dots, there while its row is pointed at or in focus, and
 * always on a touch screen: rename it, move it into a project or out of
 * one, make a project for it, or delete it. Choosing Rename leaves the
 * focus in the field that opens rather than here.
 */
export const ChatMenu = ({
  chat,
  projects,
  onRename,
  onMove,
  onNewProject,
  onDelete,
}: {
  chat: ChatSummary;
  projects: readonly ChatProject[];
  onRename: () => void;
  onMove: (projectId: string | null) => void;
  onNewProject: () => void;
  onDelete: () => void;
}) => {
  const { t } = useLingui();
  const renaming = useRef(false);
  const { title } = chat;
  return (
    <span className="absolute top-1.5 right-1.5 opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100 has-data-popup-open:opacity-100 pointer-coarse:opacity-100">
      <DropdownMenu
        onOpenChange={(open) => {
          if (open) {
            renaming.current = false;
          }
        }}
      >
        <DropdownMenuTrigger
          aria-label={t`More for ${title}`}
          render={<Button size="icon-xs" variant="ghost" />}
        >
          <EllipsisIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-60"
          finalFocus={() => !renaming.current}
        >
          <DropdownMenuItem
            onClick={() => {
              renaming.current = true;
              onRename();
            }}
          >
            <PencilIcon />
            <Trans>Rename</Trans>
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <FolderInputIcon />
              <Trans>Move to project</Trans>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-52">
              {projects.map((project) => (
                <DropdownMenuItem
                  disabled={project.id === chat.projectId}
                  key={project.id}
                  onClick={() => {
                    onMove(project.id);
                  }}
                >
                  <FolderIcon />
                  <span className="min-w-0 flex-1 truncate">
                    {project.name}
                  </span>
                  {project.id === chat.projectId ? <CheckIcon /> : null}
                </DropdownMenuItem>
              ))}
              {projects.length === 0 ? null : <DropdownMenuSeparator />}
              <DropdownMenuItem onClick={onNewProject}>
                <FolderPlusIcon />
                <Trans>New project…</Trans>
              </DropdownMenuItem>
              {chat.projectId === null ? null : (
                <DropdownMenuItem
                  onClick={() => {
                    onMove(null);
                  }}
                >
                  <FolderMinusIcon />
                  <Trans>Take out of the project</Trans>
                </DropdownMenuItem>
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onDelete} variant="destructive">
            <Trash2Icon />
            <Trans>Delete</Trans>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
};

/** Deletes a project, once the person confirms; its chats stay. */
export const DeleteProjectDialog = ({
  project,
  open,
  onOpenChange,
  onDeleted,
}: {
  project: ChatProject;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => Promise<void>;
}) => {
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const { name } = project;
  const remove = async (): Promise<void> => {
    const removed = await run(async (session) => {
      await session.chats.removeProject(project.id);
      return true;
    });
    if (removed === true) {
      onOpenChange(false);
      await onDeleted?.();
      await router.invalidate();
    }
  };
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <Trans>Delete the project “{name}”?</Trans>
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm">
          <Trans>
            Its goal and documents are deleted. Its chats stay, back among the
            chats by date.
          </Trans>
        </p>
        <ErrorText>{failure}</ErrorText>
        <DialogFooter showCloseButton>
          <Button
            disabled={busy}
            onClick={() => {
              void remove();
            }}
            variant="destructive"
          >
            <Trans>Delete project</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
