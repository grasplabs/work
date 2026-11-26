import { Input } from "@grasp-os/ui/components/input";
import { Textarea } from "@grasp-os/ui/components/textarea";
import type { LayoutStyle } from "@grasp-os/ui/lib/utils";
import { useState } from "react";

// A setting's text, saved as the person leaves the field (or presses
// Enter in a one-line field), as the workspace's name is: an emptied
// field saves none, Escape puts back what was saved, and nothing is sent
// while it is what was saved. The Field round it names it. For every
// settings page (an App's, the organization's).

/** What a field is saved as: its text, trimmed; null when emptied. */
const savedAs = (draft: string): string | null => {
  const trimmed = draft.trim();
  return trimmed === "" ? null : trimmed;
};

export const SavedField = ({
  value,
  onSave,
  maxLength,
  multiline = false,
  readOnly = false,
  style,
}: {
  value: string | null;
  onSave: (value: string | null) => void;
  maxLength: number;
  /** Several lines (a description, an address), saved as the field is left. */
  multiline?: boolean;
  /** Shown, not changed: for whoever may not change it. */
  readOnly?: boolean;
  /** Placement only. */
  style?: LayoutStyle;
}) => {
  const [draft, setDraft] = useState<string | null>(null);
  const save = (): void => {
    if (draft === null) {
      return;
    }
    setDraft(null);
    const next = savedAs(draft);
    if (next !== value) {
      onSave(next);
    }
  };
  const shown = draft ?? value ?? "";
  if (multiline) {
    return (
      <Textarea
        maxLength={maxLength}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setDraft(null);
          }
        }}
        onValueChange={setDraft}
        readOnly={readOnly}
        rows={2}
        style={style}
        value={shown}
      />
    );
  }
  return (
    <Input
      maxLength={maxLength}
      onBlur={save}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        }
        if (event.key === "Escape") {
          setDraft(null);
        }
      }}
      onValueChange={setDraft}
      readOnly={readOnly}
      // A row's control is the small size, as every settings row's: rows line up.
      size="sm"
      style={style}
      value={shown}
    />
  );
};
