import { AppError } from "@grasp-os/sdk";

// What the map takes as text, beyond its schema's lengths: no control
// characters in a name (a tab, a newline or a character JSON writes as six
// bytes), none but tabs and line breaks in notes, no half of a surrogate
// pair anywhere (JSON writes each as six bytes too), and an App's or a
// workflow's ID as an identifier. So a workflow's figures, as the map
// answers them to another App, are as long in JSON as their lengths allow
// and no longer (figures.ts), whatever a builder types.

/** Control characters: none belongs in a name. */
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const control = /[\u0000-\u001F\u007F]/u;

/** Control characters but tabs and line breaks: none belongs in notes. */
// oxlint-disable-next-line no-control-regex -- as above
const controlInNotes = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

/** An App's or a workflow's ID: letters, digits, `.`, `_`, `:` and `-`. */
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

/** Refuses what the map doesn't take (`map.invalid`), saying which field. */
const refuse = (field: string, why: string): never => {
  throw new AppError("map.invalid", `The ${field} ${why}.`);
};

/** Refuses a name, a role, a tool or a value with characters it doesn't take. */
export const requireText = (field: string, value: string | undefined): void => {
  if (value === undefined) {
    return;
  }
  if (control.test(value) || !value.isWellFormed()) {
    refuse(field, "has characters the map doesn't take");
  }
};

/** Refuses notes with characters they don't take. */
export const requireNotes = (value: string): void => {
  if (controlInNotes.test(value) || !value.isWellFormed()) {
    refuse("notes", "have characters the map doesn't take");
  }
};

/** Refuses an ID that isn't an identifier. */
export const requireIdentifier = (field: string, value: string): void => {
  if (!identifier.test(value)) {
    refuse(field, "isn't an ID: letters, digits, `.`, `_`, `:` and `-`");
  }
};

/** What a workflow's save takes as text: its names and notes. */
export interface EditedText {
  title: string;
  steps: readonly { name: string; who?: string; tool?: string }[];
  parameters: readonly { name: string; value?: string }[];
  notes: string;
}

/** Refuses a workflow whose names or notes have what the map doesn't take. */
export const requireWorkflowText = (edited: EditedText): void => {
  requireText("title", edited.title);
  for (const step of edited.steps) {
    requireText("step's name", step.name);
    requireText("step's role", step.who);
    requireText("step's tool", step.tool);
  }
  for (const parameter of edited.parameters) {
    requireText("parameter's name", parameter.name);
    requireText("parameter's value", parameter.value);
  }
  requireNotes(edited.notes);
};
