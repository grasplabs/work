// Inline edit: a value read as text that turns into a field where it stands (Ark's and Chakra's
// Editable, Atlassian's InlineEdit). A press on the text, Enter or F2 opens the field with the value
// chosen; Enter saves, Escape keeps the value as it was, and leaving the field saves too. Focus goes
// back to the text after Enter or Escape. The host keeps the value: `onSubmit` runs with the new
// one, trimmed, when it is not empty and differs.
//
//   <InlineEdit aria-label="Project name" value={name} onSubmit={setName} />
//   <InlineEdit aria-label="Title" value={title} onSubmit={(next) => save(next)}>   a promise: the
//     <Heading>{title}</Heading>                                                    field waits for it
//   </InlineEdit>
//
// `onSubmit` may return a promise: the field stays open and read only while it works, closes when
// it is done, and says so; when it fails the field keeps the words typed and says that it could not
// save. `validate` refuses a value before it is sent, in the words it returns. A screen reader
// hears the result once (`inlineEdit.saved`, or `inlineEdit.error`).
"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { useAction } from "../hooks/use-action";
import { useI18n } from "../lib/i18n";
import { focusRing, visuallyHidden } from "../lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  space,
} from "../lib/tokens.stylex";
import { announce } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { Input } from "./input";

/** Every prop an InlineEdit takes. */
export interface InlineEditProps {
  /** The value as it stands. The host keeps it, and changes it in `onSubmit`. */
  value: string;
  /**
   * Runs with the new value, trimmed, when it is not empty and differs. Return a promise for work
   * that takes time: the field waits, read only, closes once it settles, and stays open with the
   * words typed when it rejects.
   */
  onSubmit: (next: string) => unknown;
  /** Runs when Escape closes the field and keeps the value as it was. */
  onCancel?: () => void;
  /**
   * Checks the new value before it is sent: the words that say why it is refused ("Up to 40
   * letters"), or nothing when it may be saved. Refused, the field stays open, marked wrong.
   */
  validate?: (next: string) => string | undefined;
  /** Whether the field is open, when you keep it in state. Pair it with `onEditingChange`. */
  editing?: boolean;
  /**
   * Whether the field starts open, when you do not keep it in state. A field that starts open
   * takes no focus; one that opens later does.
   * @default false
   */
  defaultEditing?: boolean;
  /** Runs when the field opens or closes. */
  onEditingChange?: (editing: boolean) => void;
  /** The field's name, for a screen reader ("Project name"); the text's too while it is empty. */
  "aria-label": string;
  /** The read view, when it is more than the value's words (a heading). @default value */
  children?: ReactNode;
  /** Layout only: where it sits and how wide it is. */
  style?: LayoutStyle;
}

const HOVER = media.hover;

const styles = stylex.create({
  root: {
    display: "inline-grid",
    minWidth: 0,
    maxWidth: "100%",
    verticalAlign: "middle",
  },
  // The read view: the words where they stand, as a button with no look of one but a quiet fill
  // under a pointer, so it shows it can be changed.
  text: {
    display: "block",
    minWidth: 0,
    margin: 0,
    marginInline: `calc(-1 * ${space[1]})`,
    paddingBlock: 0,
    paddingInline: space[1],
    borderWidth: 0,
    borderRadius: radius.mark,
    cornerShape: radius.shape,
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [HOVER]: colors.accent },
    },
    color: "inherit",
    fontFamily: "inherit",
    fontSize: "inherit",
    lineHeight: "inherit",
    fontWeight: "inherit",
    letterSpacing: "inherit",
    textAlign: "start",
    overflowWrap: "anywhere",
    cursor: "text",
    transitionProperty: "background-color",
    transitionDuration: duration.hover,
    transitionTimingFunction: duration.ease,
  },
  // The field and, under it, what it says while it saves or why it did not.
  editor: {
    display: "grid",
    rowGap: space[1],
    minWidth: 0,
  },
  message: {
    margin: 0,
    fontFamily: font.sans,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    color: colors.mutedForeground,
  },
  problem: { color: colors.destructive },
});

/** Whether onSubmit handed back work still running. */
const isPromise = (result: unknown): result is Promise<unknown> =>
  result instanceof Promise;

/** A value read as text that becomes a field where it stands. */
export const InlineEdit = ({
  value,
  onSubmit,
  onCancel,
  validate,
  editing: given,
  defaultEditing = false,
  onEditingChange,
  "aria-label": ariaLabel,
  children,
  style,
}: InlineEditProps) => {
  const words = useI18n().inlineEdit;
  const hint = useId();
  const messageId = useId();
  const [own, setOwn] = useState(defaultEditing);
  const editing = given ?? own;
  const [draft, setDraft] = useState(value);
  // Why the value was not saved: `validate`'s words, or the failure's.
  const [problem, setProblem] = useState("");
  // Each time the field opens, from a press or from the host, it starts from the value as it is,
  // and takes focus. Counted, so a field that is open from the start takes none: nobody asked for
  // it, and focus would scroll the page to it from wherever the reader is.
  const [opened, setOpened] = useState(editing);
  const [opens, setOpens] = useState(0);
  if (opened !== editing) {
    setOpened(editing);
    if (editing) {
      setDraft(value);
      setProblem("");
      setOpens(opens + 1);
    }
  }
  const save = useAction(async (work: Promise<unknown>) => await work, {
    successLabel: words.saved(draft.trim()),
    errorLabel: words.error,
  });
  const saving = save.status === "loading";

  const text = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  // Set when a key closes the field, so focus goes back to the text once it is drawn again.
  const backToText = useRef(false);
  // Set once the field is closing, so the blur that follows a key does not save a second time.
  const closing = useRef(false);
  // Each close asked for, so the render after it can tell whether a host that keeps `editing`
  // closed the field or kept it open.
  const [asked, setAsked] = useState(0);

  const setEditing = (next: boolean) => {
    if (given === undefined) {
      setOwn(next);
    }
    onEditingChange?.(next);
  };
  const close = (byKey: boolean) => {
    closing.current = true;
    backToText.current = byKey;
    setEditing(false);
    setAsked((count) => count + 1);
  };

  // Still open after a close was asked for: the host kept it open, so it is not closing, and the
  // next Enter or blur saves again.
  useEffect(() => {
    if (asked > 0 && editing) {
      closing.current = false;
      backToText.current = false;
    }
  }, [asked, editing]);

  useEffect(() => {
    if (editing) {
      closing.current = false;
    } else if (backToText.current) {
      backToText.current = false;
      text.current?.focus();
    }
  }, [editing]);

  useEffect(() => {
    if (opens > 0) {
      field.current?.focus();
      field.current?.select();
    }
  }, [opens]);

  const submit = async (byKey: boolean) => {
    if (closing.current || saving) {
      return;
    }
    const next = draft.trim();
    if (next === "" || next === value) {
      close(byKey);
      return;
    }
    const refused = validate?.(next);
    if (refused !== undefined && refused !== "") {
      setProblem(refused);
      announce(refused);
      return;
    }
    const result = onSubmit(next);
    if (!isPromise(result)) {
      announce(words.saved(next));
      close(byKey);
      return;
    }
    const outcome = await save.run(result);
    if (outcome.ok) {
      close(byKey);
    } else if (!("busy" in outcome)) {
      setProblem(words.error);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) {
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      void submit(true);
    } else if (event.key === "Escape" && !saving) {
      // Escape closes the field only: not also a dialog or a sheet round it.
      event.preventDefault();
      event.stopPropagation();
      close(true);
      onCancel?.();
    }
  };

  const shown = saving ? (save.label ?? "") : problem;
  return (
    <span data-slot="inline-edit" {...stylex.props(styles.root, style)}>
      {editing ? (
        <span data-slot="inline-edit-input" {...stylex.props(styles.editor)}>
          <Input
            ref={field}
            size="sm"
            aria-label={ariaLabel}
            value={draft}
            onValueChange={(next: string) => {
              setDraft(next);
              setProblem("");
            }}
            readOnly={saving}
            aria-busy={saving || undefined}
            aria-invalid={problem === "" ? undefined : true}
            aria-describedby={shown === "" ? undefined : messageId}
            onKeyDown={onKeyDown}
            onBlur={() => {
              void submit(false);
            }}
          />
          {shown === "" ? null : (
            <span
              id={messageId}
              {...stylex.props(
                styles.message,
                problem !== "" && styles.problem
              )}
            >
              {shown}
            </span>
          )}
        </span>
      ) : (
        <>
          <button
            ref={text}
            type="button"
            aria-label={value === "" ? ariaLabel : undefined}
            aria-describedby={hint}
            onClick={() => {
              setEditing(true);
            }}
            onKeyDown={(event) => {
              if (event.key === "F2") {
                event.preventDefault();
                setEditing(true);
              }
            }}
            {...stylex.props(styles.text, focusRing)}
          >
            {children ?? value}
          </button>
          <span id={hint} {...stylex.props(visuallyHidden)}>
            {words.edit}
          </span>
        </>
      )}
    </span>
  );
};
