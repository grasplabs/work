// ComposerAdd: the plus at the start of a composer's footer (composer.tsx), after Capy's add menu.
// "Upload attachment" first, with its keys (Cmd or Ctrl and /, bound while focus is in this
// composer); then, under a hairline, the kinds of thing that can be added: people, agents, skills,
// files, or whatever the caller passes. Choosing a kind hands it to `onKind`, which usually opens
// the mention menu at that kind. Last, under a heading of their own ("This chat"), the actions about
// this chat rather than this message: instructions, memory, shortcuts. They stand here, not behind a
// second button, so the footer starts with one plus.
//
//   <ComposerAdd onAttach={attach} kinds={kinds} onKind={(kind) => mention(kind)}
//     actions={actions} onAction={(action) => open(action)} />
//
// Built from Grasp's Dropdown menu. Every value is a token (src/tokens).
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef } from "react";
import type { RefObject } from "react";

import {
  DropdownMenu,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../dropdown-menu";
import { Attach, Plus } from "../icons";
import type { IconData } from "../icons";
import { useComposerDisabled, useOpenMentions } from "./context";
import { cornerStyles } from "./corner";
import { stopEscape } from "./escape";

/** One kind of thing a person can add to a message. */
export interface ComposerKind {
  /** What `onKind` receives ("people"). */
  value: string;
  /** Its name ("People"). */
  label: string;
  /** Its mark. Import it from the icons entry (`@/components/grasp/icons`). */
  icon?: IconData;
  /** One line on what it is, shown in the mention menu ("Tag someone in the team"). */
  description?: string;
}

/** One action about the chat, in the plus menu's last group. */
export interface ComposerAddAction {
  /** What `onAction` receives ("instructions"). */
  value: string;
  /** Its words ("Edit instructions"). */
  label: string;
  /** Its mark. Import it from the icons entry (`@/components/grasp/icons`). */
  icon?: IconData;
  /** Its keys, as Dropdown menu's items take them ("mod+k"). */
  shortcut?: string;
  /** Out of use. */
  disabled?: boolean;
}

/** Every prop a ComposerAdd takes. */
export interface ComposerAddProps {
  /** Called with the files chosen from the device. Without it there is no Upload attachment. */
  onAttach?: (files: File[]) => void;
  /** The kinds of thing that can be added, after the upload. */
  kinds?: ComposerKind[];
  /** Called with the kind chosen. Without it, the composer's mention menu opens at that kind. */
  onKind?: (kind: string) => void;
  /** Actions about this chat, in a group of their own at the menu's end: what a separate adjust button used to hold. */
  actions?: ComposerAddAction[];
  /** Called with the action chosen. */
  onAction?: (action: string) => void;
  /**
   * The actions' heading.
   * @default "This chat"
   */
  actionsLabel?: string;
  /**
   * Which files the device's picker offers, as an input's `accept` ("image/*,.pdf").
   */
  accept?: string;
  /**
   * The plus button's name.
   * @default "Add to message"
   */
  "aria-label"?: string;
  /** @deprecated Use `aria-label`. */
  label?: string;
  /**
   * The upload item's words.
   * @default "Upload attachment"
   */
  uploadLabel?: string;
}

const noKinds: ComposerKind[] = [];
const noActions: ComposerAddAction[] = [];

// Cmd or Ctrl and / clicks the hidden file input, while focus is in its form. Returns the cleanup.
const listenForPicker = (picker: RefObject<HTMLInputElement | null>) => {
  const keys = (event: KeyboardEvent) => {
    if (event.key !== "/" || !(event.metaKey || event.ctrlKey)) {
      return;
    }
    const form = picker.current?.closest("form");
    if (
      !form ||
      !(event.target instanceof Node) ||
      !form.contains(event.target)
    ) {
      return;
    }
    event.preventDefault();
    picker.current?.click();
  };
  document.addEventListener("keydown", keys);
  return () => {
    document.removeEventListener("keydown", keys);
  };
};

/** The plus menu: upload a file, or add a person, an agent, a skill or a file. */
export const ComposerAdd = ({
  onAttach,
  kinds = noKinds,
  onKind,
  actions = noActions,
  onAction,
  actionsLabel = "This chat",
  accept,
  label: labelDeprecated,
  "aria-label": label = labelDeprecated ?? "Add to message",
  uploadLabel = "Upload attachment",
}: ComposerAddProps) => {
  const disabled = useComposerDisabled();
  // Without its own onKind, a kind opens the composer's mention menu at that kind.
  const openMentions = useOpenMentions();
  const choose = onKind ?? ((kind: string) => openMentions?.(kind));
  const picker = useRef<HTMLInputElement | null>(null);

  // Cmd or Ctrl and / opens the device's picker, while focus is in this composer.
  useEffect(
    () => (onAttach === undefined ? undefined : listenForPicker(picker)),
    [onAttach]
  );

  return (
    <DropdownMenu>
      {/* First or last in its side of the footer, the button nests in the card's corner (corner.ts);
          its menu stands outside the nest, so it keeps the system's corners. */}
      <span {...stylex.props(cornerStyles.nest)}>
        {onAttach && (
          <input
            ref={picker}
            type="file"
            multiple
            accept={accept}
            hidden
            tabIndex={-1}
            aria-hidden="true"
            onChange={(event) => {
              const files = [...(event.currentTarget.files ?? [])];
              event.currentTarget.value = "";
              if (files.length > 0) {
                onAttach(files);
              }
            }}
          />
        )}
        <DropdownMenuTrigger
          icon={Plus}
          aria-label={label}
          variant="ghost"
          size="sm"
          disabled={disabled}
        />
      </span>
      <DropdownMenuContent side="top" align="start" onKeyDown={stopEscape}>
        {onAttach && (
          <DropdownMenuItem
            icon={Attach}
            shortcut="mod+/"
            onSelect={() => {
              picker.current?.click();
            }}
          >
            {uploadLabel}
          </DropdownMenuItem>
        )}
        {onAttach && kinds.length > 0 && <DropdownMenuSeparator />}
        {kinds.map((kind) => (
          <DropdownMenuItem
            key={kind.value}
            icon={kind.icon}
            onSelect={() => {
              choose(kind.value);
            }}
          >
            {kind.label}
          </DropdownMenuItem>
        ))}
        {(Boolean(onAttach) || kinds.length > 0) && actions.length > 0 && (
          <DropdownMenuSeparator />
        )}
        {actions.length > 0 && (
          <DropdownMenuGroup>
            <DropdownMenuLabel>{actionsLabel}</DropdownMenuLabel>
            {actions.map((action) => (
              <DropdownMenuItem
                key={action.value}
                icon={action.icon}
                shortcut={action.shortcut}
                disabled={action.disabled}
                onSelect={() => {
                  onAction?.(action.value);
                }}
              >
                {action.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
