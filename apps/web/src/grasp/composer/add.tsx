// ComposerAdd: the plus at the start of a composer's footer (composer.tsx), after Capy's add menu.
// "Upload attachment" first, with its keys (Cmd or Ctrl and /, bound while focus is in this
// composer); then, under a hairline, the kinds of thing that can be added: people, agents, skills,
// files, or whatever the caller passes. Choosing a kind hands it to `onKind`, which usually opens
// the mention menu at that kind.
//
//   <ComposerAdd onAttach={attach} kinds={kinds} onKind={(kind) => mention(kind)} />
//
// Built from Grasp's Dropdown menu. Every value is a token (src/tokens).
"use client";

import { useEffect, useRef } from "react";
import type { RefObject } from "react";

import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuPanel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../dropdown-menu";
import { Attach, Plus } from "../icons";
import type { IconData } from "../icons";
import { useComposerDisabled, useOpenMentions } from "./context";

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

/** Every prop a ComposerAdd takes. */
export interface ComposerAddProps {
  /** Called with the files chosen from the device. Without it there is no Upload attachment. */
  onAttach?: (files: File[]) => void;
  /** The kinds of thing that can be added, after the upload. */
  kinds?: ComposerKind[];
  /** Called with the kind chosen. Without it, the composer's mention menu opens at that kind. */
  onKind?: (kind: string) => void;
  /**
   * Which files the device's picker offers, as an input's `accept` ("image/*,.pdf").
   */
  accept?: string;
  /**
   * The plus button's name.
   * @default "Add to message"
   */
  label?: string;
  /**
   * The upload item's words.
   * @default "Upload attachment"
   */
  uploadLabel?: string;
}

const noKinds: ComposerKind[] = [];

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
  accept,
  label = "Add to message",
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
    <>
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
      <DropdownMenu>
        <DropdownMenuTrigger
          icon={Plus}
          label={label}
          variant="quiet"
          size="sm"
          disabled={disabled}
        />
        <DropdownMenuPanel side="top" align="start">
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
        </DropdownMenuPanel>
      </DropdownMenu>
    </>
  );
};
