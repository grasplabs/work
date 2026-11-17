import { useState } from "react";

import { Input } from "../grasp/input/index.ts";
import { Textarea } from "../grasp/textarea/index.ts";
import type { SettingField } from "./section.tsx";

// A setting's text, saved as the person leaves the field (or presses
// Enter in a one-line field): an emptied field saves none, Escape puts
// back what was saved, and nothing is sent while it is what was saved.
// Read-only for whoever may not change it. The control alone: a
// SettingRow (settings/section.tsx) names it and says what it is for.

/** What a field is saved as: its text, trimmed; null when emptied. */
const savedAs = (draft: string): string | null => {
  const trimmed = draft.trim();
  return trimmed === "" ? null : trimmed;
};

export const SavedField = ({
  field,
  value,
  readOnly,
  multiline = false,
  maxLength,
  type,
  onSave,
}: {
  /** The row's id and help, which name and describe it. */
  field: SettingField;
  value: string | null;
  readOnly: boolean;
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
  return multiline ? (
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
      value={shown}
      {...field}
    />
  ) : (
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
      {...(type === undefined ? {} : { type })}
      value={shown}
      {...field}
    />
  );
};
