// A workflow's settings sections on their own: the address that names one
// comes with the app (the route's validateSearch), the settings page
// (workflow-settings.tsx) doesn't.

/** The sections, in the order the list shows them. */
export const workflowSettingsSections = [
  "general",
  "sharing",
  "triggers",
  "files",
  "parameters",
  "definition",
  "history",
] as const;

export type WorkflowSettingsSection = (typeof workflowSettingsSections)[number];

/** A section named in an address, or none for anything else. */
export const workflowSettingsSectionOf = (
  value: unknown
): WorkflowSettingsSection | undefined =>
  workflowSettingsSections.find((section) => section === value);
