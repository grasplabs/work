import type { ChatSummary } from "@grasp-os/shared/chat";
import { chatTitleSchema } from "@grasp-os/shared/chat";
import { Button } from "@grasp-os/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import { Input } from "@grasp-os/ui/components/input";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { EllipsisIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

import { useCoreAction } from "../use-core-action.ts";

// What can be done to a chat where it is listed, in the ⌘K window
// (grasplabs/prototype `components/chat/chat-menus.tsx`): rename it in
// place, and delete it after a check. Each goes to core, and the page reads
// its lists again once it has.

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

/** Renaming one of the person's chats, then reading the page again. */
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
  return { failure, rename };
};

/**
 * Keeps a menu's keys to itself: the ⌘K window around it would take Enter
 * and the arrows for its list, opening a chat instead of the menu's item.
 */
const ownKeys = (event: KeyboardEvent): void => {
  event.stopPropagation();
};

/**
 * A chat's three dots, there while its row is pointed at or in focus, and
 * always on a touch screen: rename it or delete it. Choosing Rename leaves the
 * focus in the field that opens rather than here.
 */
export const ChatMenu = ({
  chat,
  onRename,
  onDelete,
}: {
  chat: ChatSummary;
  onRename: () => void;
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
          onKeyDown={ownKeys}
          render={<Button size="icon-xs" variant="ghost" />}
        >
          <EllipsisIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-60"
          finalFocus={() => !renaming.current}
          onKeyDown={ownKeys}
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
