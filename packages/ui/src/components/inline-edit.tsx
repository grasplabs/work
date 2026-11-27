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
// save (`errorText`, or the catalogue's words). `validate` refuses a value before it is sent, in the
// words it returns. A screen reader hears the result once (`inlineEdit.saved`, or the error).
//
// Inline, the field takes the text's place and a line under it says "Working" or why a save failed:
// the row it stands in grows by that line. In a row of a fixed height (a bar, a panel's head) use
// `variant="popup"`, which keeps the text where it stands and opens the field in a small Popover beside
// it, titled by `aria-label`, with Cancel and Save (a page's or a panel's title, renamed without
// the field taking the title's room). The same rules: Enter or Save saves, Escape or Cancel keeps
// the value, a press outside keeps it too; it stays open while a save works or after one failed.
"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect, useId, useRef, useState } from "react";
import type {
  ComponentProps,
  FocusEvent,
  KeyboardEvent,
  ReactNode,
} from "react";

import { useAction } from "../hooks/use-action";
import { useI18n } from "../lib/i18n";
import { focusRing, visuallyHidden } from "../lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  size,
  space,
} from "../lib/tokens.stylex";
import { announce, renamed } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { Button } from "./button";
import { Input } from "./input";
import {
  Popover,
  PopoverContent,
  PopoverFooter,
  PopoverTitle,
  PopoverTrigger,
} from "./popover";

/** Where the field opens: in the text's place, or in a small popup beside it. */
export type InlineEditVariant = "inline" | "popup";

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
  /**
   * Runs when the field closes and keeps the value as it was: Escape, and in the popup also Cancel,
   * a press outside and Tab away. (Inline, leaving the field saves; in the popup it discards.)
   */
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
  /**
   * `inline` opens the field in the text's place; `popup` opens it in a small Popover beside the
   * text, titled by `aria-label`, with Cancel and Save.
   * @default "inline"
   */
  variant?: InlineEditVariant;
  /** The most the field takes, counted as the browser's `maxlength` counts (UTF-16 code units). */
  maxLength?: number;
  /**
   * Said under the field, and to a screen reader, when a save fails ("Could not rename: that name
   * is taken"), in place of the catalogue's `inlineEdit.error`.
   */
  errorText?: string;
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
    position: "relative",
    display: "block",
    minWidth: 0,
    margin: 0,
    marginInline: `calc(-1 * ${space[1]})`,
    paddingBlock: 0,
    paddingInline: space[1],
    borderWidth: 0,
    borderRadius: radius.sm,
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
  // A finger's height on a touch screen, up and down round its line, the look unchanged.
  target: {
    position: "absolute",
    insetInline: 0,
    insetBlock: {
      default: 0,
      [media.pointerCoarse]: `min(0px, calc((100% - ${size.tapTarget}) / 2))`,
    },
  },
  // The popup's form: its title, the field, what it says, and Cancel and Save.
  form: {
    display: "grid",
    rowGap: space[3],
    margin: 0,
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

/** Whether an input method is composing as the key comes: its Enter and Escape are the method's. */
const composing = (event: KeyboardEvent<HTMLInputElement>): boolean =>
  event.nativeEvent.isComposing;

/**
 * The field's words. Each time the field opens, from a press or from the host, they start from the
 * value as it is (`onOpen` runs), and `opens` counts it, so a field open from the start takes no
 * focus: nobody asked for it, and focus would scroll the page to it from wherever the reader is.
 * Until the person types they follow the value, so a name the host changes meanwhile is never
 * saved over by the old one.
 */
const useDraft = (value: string, editing: boolean, onOpen: () => void) => {
  const [draft, setDraft] = useState(value);
  const [typed, setTyped] = useState(false);
  const [opened, setOpened] = useState(editing);
  const [opens, setOpens] = useState(0);
  if (opened !== editing) {
    setOpened(editing);
    if (editing) {
      setDraft(value);
      setTyped(false);
      setOpens(opens + 1);
      onOpen();
    }
  } else if (editing && !typed && draft !== value) {
    setDraft(value);
  }
  const type = (next: string) => {
    setDraft(next);
    setTyped(true);
  };
  return { draft, opens, type };
};

/** What the popup form is drawn from: the text that opens it, the field, and how it ends. */
interface PopupFieldProps {
  open: boolean;
  saving: boolean;
  /** Its title, the field's name ("Rename"). */
  title: string;
  /** The text, the popup's trigger. */
  children: ReactNode;
  triggerProps: ComponentProps<"button">;
  fieldProps: ComponentProps<typeof Input>;
  /** The field took the focus: its words are chosen as it opens. */
  onFocusField: (field: HTMLInputElement) => void;
  message: ReactNode;
  onOpen: () => void;
  /** It closes and keeps the value; `byKey` when Escape or Cancel closed it. */
  onDismiss: (byKey: boolean) => void;
  onSave: () => void;
}

/** The popup form beside the text: its title, the field, Cancel and Save. */
const PopupField = ({
  open,
  saving,
  title,
  children,
  triggerProps,
  fieldProps,
  onFocusField,
  message,
  onOpen,
  onDismiss,
  onSave,
}: PopupFieldProps) => {
  const words = useI18n().inlineEdit;
  return (
    <Popover
      open={open}
      // While a save works it stays; Escape, a press outside, Tab away or a press on the text keep
      // the value.
      dismissible={!saving}
      onOpenChange={(next, details) => {
        if (next) {
          onOpen();
        } else if (saving) {
          details.cancel();
        } else {
          onDismiss(details.reason === "escape-key");
        }
      }}
    >
      {/* The text is the popup's trigger: a press on it while it is open closes it, never closing
        and opening it again over the words typed. */}
      <PopoverTrigger asChild>
        <button
          type="button"
          {...triggerProps}
          onClick={undefined}
          aria-haspopup="dialog"
        >
          <span aria-hidden="true" {...stylex.props(styles.target)} />
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSave();
          }}
          {...stylex.props(styles.form)}
        >
          <PopoverTitle>{title}</PopoverTitle>
          <span data-slot="inline-edit-input" {...stylex.props(styles.editor)}>
            <Input
              {...fieldProps}
              // Enter and Escape while an input method composes pick its words: they neither save
              // nor close.
              onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                if (
                  composing(event) &&
                  (event.key === "Enter" || event.key === "Escape")
                ) {
                  event.preventDefault();
                  event.stopPropagation();
                }
              }}
              onFocus={(event: FocusEvent<HTMLInputElement>) => {
                onFocusField(event.currentTarget);
              }}
            />
            {message}
          </span>
          <PopoverFooter>
            <Button
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={() => {
                onDismiss(true);
              }}
            >
              {words.cancel}
            </Button>
            <Button
              type="submit"
              size="sm"
              status={saving ? "loading" : "idle"}
            >
              {words.save}
            </Button>
          </PopoverFooter>
        </form>
      </PopoverContent>
    </Popover>
  );
};

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
  variant = "inline",
  maxLength,
  errorText,
  style,
}: InlineEditProps) => {
  const words = useI18n().inlineEdit;
  const hint = useId();
  const messageId = useId();
  const [own, setOwn] = useState(defaultEditing);
  const editing = given ?? own;
  // Why the value was not saved: `validate`'s words, or the failure's.
  const [problem, setProblem] = useState("");
  const { draft, opens, type } = useDraft(value, editing, () => {
    setProblem("");
  });
  const failed = errorText ?? words.error;
  // The host's work runs inside the action, so its guard comes first: nothing reaches the host
  // while a save works. Each save is new work, so a rename may follow a rename at once.
  const save = useAction(async (next: string) => await onSubmit(next), {
    successText: words.saved(draft.trim()),
    errorText: failed,
    runWhileShown: true,
  });
  const saving = save.status === "loading";

  const text = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  // Set when a key closes the field, so focus goes back to the text once it is drawn again.
  const backToText = useRef(false);
  // Set once the field is closing, so the blur that follows a key does not save a second time.
  const closing = useRef(false);
  // Set as the popup opens, so the field's words are chosen as it takes the focus.
  const choose = useRef(false);
  // Each close asked for, so the render after it can tell whether a host that keeps `editing`
  // closed the field or kept it open.
  const [asked, setAsked] = useState(0);
  // Whether the field is open as last drawn, for work that ends after the host closed it.
  const open = useRef(editing);
  useEffect(() => {
    open.current = editing;
  });

  const setEditing = (next: boolean) => {
    if (given === undefined) {
      setOwn(next);
    }
    onEditingChange?.(next);
  };
  const close = (byKey: boolean) => {
    // Already closed by the host (while a save worked): nothing to close, and no focus to move.
    if (!open.current) {
      return;
    }
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
      backToText.current = false;
    } else if (backToText.current) {
      backToText.current = false;
      text.current?.focus();
    }
  }, [editing]);

  useEffect(() => {
    if (opens > 0) {
      choose.current = true;
      field.current?.focus();
      field.current?.select();
    }
  }, [opens]);

  const submit = async (byKey: boolean) => {
    if (closing.current || saving) {
      return;
    }
    const next = renamed(draft, value);
    if (next === undefined) {
      close(byKey);
      return;
    }
    const refused = validate?.(next);
    if (refused !== undefined && refused !== "") {
      setProblem(refused);
      announce(refused);
      return;
    }
    const outcome = await save.run(next);
    if (outcome.ok) {
      close(byKey);
    } else if (!("busy" in outcome)) {
      setProblem(failed);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (composing(event)) {
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
  const message =
    shown === "" ? null : (
      <span
        id={messageId}
        {...stylex.props(styles.message, problem !== "" && styles.problem)}
      >
        {shown}
      </span>
    );
  const fieldProps = {
    ref: field,
    size: "sm" as const,
    "aria-label": ariaLabel,
    value: draft,
    maxLength,
    onValueChange: (next: string) => {
      type(next);
      setProblem("");
    },
    readOnly: saving,
    "aria-busy": saving || undefined,
    "aria-invalid": problem === "" ? undefined : true,
    "aria-describedby": shown === "" ? undefined : messageId,
  };
  const textProps = {
    ref: text,
    "aria-label": value === "" ? ariaLabel : undefined,
    "aria-describedby": hint,
    onClick: () => {
      setEditing(true);
    },
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === "F2") {
        event.preventDefault();
        setEditing(true);
      }
    },
    ...stylex.props(styles.text, focusRing),
  };
  const hintText = (
    <span id={hint} {...stylex.props(visuallyHidden)}>
      {words.edit}
    </span>
  );
  if (variant === "popup") {
    return (
      <span data-slot="inline-edit" {...stylex.props(styles.root, style)}>
        <PopupField
          open={editing}
          saving={saving}
          title={ariaLabel}
          triggerProps={textProps}
          fieldProps={fieldProps}
          onFocusField={(input) => {
            if (choose.current) {
              choose.current = false;
              input.select();
            }
          }}
          message={message}
          onOpen={() => {
            setEditing(true);
          }}
          onDismiss={(byKey) => {
            close(byKey);
            onCancel?.();
          }}
          onSave={() => {
            void submit(true);
          }}
        >
          {children ?? value}
        </PopupField>
        {hintText}
      </span>
    );
  }
  return (
    <span data-slot="inline-edit" {...stylex.props(styles.root, style)}>
      {editing ? (
        <span data-slot="inline-edit-input" {...stylex.props(styles.editor)}>
          <Input
            {...fieldProps}
            onKeyDown={onKeyDown}
            onBlur={() => {
              void submit(false);
            }}
          />
          {message}
        </span>
      ) : (
        <>
          <button type="button" {...textProps}>
            <span aria-hidden="true" {...stylex.props(styles.target)} />
            {children ?? value}
          </button>
          {hintText}
        </>
      )}
    </span>
  );
};
