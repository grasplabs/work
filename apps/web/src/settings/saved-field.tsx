import { Input } from "@grasp-os/ui/components/input";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { useState } from "react";

// A setting's text, saved as the person leaves the field (or presses
// Enter in a one-line field), as the workspace's name is: an emptied
// field saves none, Escape puts back what was saved, and nothing is sent
// while it is what was saved.

/** What a field is saved as: its text, trimmed; null when emptied. */
const savedAs = (draft: string): string | null => {
  const trimmed = draft.trim();
  return trimmed === "" ? null : trimmed;
};

export const SavedField = ({
  id,
  value,
  disabled,
  multiline = false,
  maxLength,
  type,
  onSave,
}: {
  id: string;
  value: string | null;
  disabled: boolean;
  /** An address: several lines, saved as the field is left. */
  multiline?: boolean;
  maxLength: number;
  type?: "email";
  onSave: (value: string | null) => void;
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
        disabled={disabled}
        id={id}
        maxLength={maxLength}
        onBlur={save}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setDraft(null);
          }
        }}
        rows={3}
        value={shown}
      />
    );
  }
  return (
    <Input
      disabled={disabled}
      id={id}
      maxLength={maxLength}
      onBlur={save}
      onChange={(event) => {
        setDraft(event.target.value);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        }
        if (event.key === "Escape") {
          setDraft(null);
        }
      }}
      type={type}
      value={shown}
    />
  );
};
