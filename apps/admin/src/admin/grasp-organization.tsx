/**
 * Choosing Grasp's own organization on Platform (src/platform-settings.ts):
 * the one whose Grasp answers Ask Grasp. Audited as the staff member
 * Access vouches for, and the page is read again after, whether it worked
 * or not.
 */
import { Button } from "@grasp-os/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import {
  NativeSelect,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import { useRouter } from "@tanstack/react-router";

import { setGraspClientFn } from "../platform-settings.ts";
import type {
  GraspClientRefusal,
  PlatformSettingsView,
} from "../platform-settings.ts";
import { thenRefresh, useAction } from "../use-action.ts";
import { Section } from "./section.tsx";

/** What a refusal says. */
const refusals: Readonly<Record<GraspClientRefusal, string>> = {
  client_unknown:
    "That organization is gone or offboarded: choose another, or none.",
};

/** The value the select gives for no organization. */
const none = "";

/** What the panel says of the choice as it stands. */
const standingWords = ({
  graspClientId,
  graspClientName,
}: PlatformSettingsView): string => {
  if (graspClientId === null) {
    return "None is chosen, so Ask Grasp isn't set up: choose the organization Grasp itself runs on.";
  }
  return graspClientName === null
    ? `The one chosen (${graspClientId}) is gone or offboarded: choose it again.`
    : `${graspClientName} answers Ask Grasp, with its own model gateway, rules and budget.`;
};

/** Grasp's own organization, and choosing it. */
export const GraspOrganization = ({
  settings,
}: {
  settings: PlatformSettingsView;
}) => {
  const router = useRouter();
  const { busy, failure, run } = useAction(refusals);
  return (
    <Section
      description={standingWords(settings)}
      title="Grasp's own organization"
    >
      <form
        className="flex flex-col gap-3 border-t px-5 py-4"
        onSubmit={(event) => {
          event.preventDefault();
          const chosen = new FormData(event.currentTarget).get("grasp-client");
          const clientId =
            typeof chosen === "string" && chosen !== none ? chosen : null;
          void run(
            async () =>
              await thenRefresh(
                async () => await setGraspClientFn({ data: { clientId } }),
                async () => {
                  await router.invalidate({ sync: true });
                }
              )
          );
        }}
      >
        <Field>
          <FieldLabel htmlFor="grasp-client">Organization</FieldLabel>
          <NativeSelect
            className="max-w-80"
            defaultValue={settings.graspClientId ?? none}
            id="grasp-client"
            // Keyed by the choice: it starts again from the one read after each change.
            key={settings.graspClientId ?? none}
            name="grasp-client"
          >
            <NativeSelectOption value={none}>None</NativeSelectOption>
            {settings.candidates.map((candidate) => (
              <NativeSelectOption key={candidate.id} value={candidate.id}>
                {candidate.status === "active"
                  ? candidate.name
                  : `${candidate.name} (being set up)`}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <FieldDescription>
            Ask Grasp asks this organization’s own Grasp, so it answers once
            that organization is live.
          </FieldDescription>
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={busy} size="sm" type="submit" variant="outline">
            Save
          </Button>
          {failure === null ? null : (
            <p className="text-destructive text-sm" role="alert">
              {failure}
            </p>
          )}
        </div>
      </form>
    </Section>
  );
};
