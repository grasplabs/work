import { noteMaxLength } from "@grasp-os/shared/onboarding-staff";
import { Button } from "@grasp-os/ui/components/button";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useId, useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import {
  SettingsBody,
  SettingsError,
  SettingsSection,
} from "../settings/settings-parts.tsx";
import { useCoreAction } from "../use-core-action.ts";

// The onboarding area's notes (prototype `org-home.tsx`): what Grasp's
// staff keep for each other on this onboarding, the newest first. Only
// staff read them; the company never sees them.

const NewNote = () => {
  const { t } = useLingui();
  const router = useRouter();
  const id = useId();
  const { busy, failure, run } = useCoreAction();
  const [text, setText] = useState("");
  const add = async (): Promise<void> => {
    await run(async (session) => {
      await changeThenRefresh(
        async () => {
          await session.onboardingStaff.addNote(text);
          setText("");
        },
        async () => {
          await router.invalidate({ sync: true });
        }
      );
    });
  };
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void add();
      }}
    >
      <label className="sr-only" htmlFor={id}>
        <Trans>New note</Trans>
      </label>
      <Textarea
        disabled={busy}
        id={id}
        maxLength={noteMaxLength}
        onChange={(event) => {
          setText(event.target.value);
        }}
        placeholder={t`What should the next person at Grasp know?`}
        value={text}
      />
      <ErrorText>{failure}</ErrorText>
      <div className="flex justify-end">
        <Button disabled={busy || text.trim() === ""} type="submit">
          <Trans>Add note</Trans>
        </Button>
      </div>
    </form>
  );
};

const Notes = () => {
  const { t } = useLingui();
  const overview = Route.useLoaderData();
  return (
    <SettingsSection
      description={t`For Grasp's staff on this onboarding alone; the company doesn't see them.`}
      title={t`Notes`}
    >
      <SettingsBody>
        <NewNote />
      </SettingsBody>
      {overview.state === "ready" ? (
        <ol>
          {overview.data.notes.map((note) => (
            <li
              className="flex flex-col gap-1 border-t px-5 py-4"
              key={note.id}
            >
              <time
                className="text-muted-foreground text-xs"
                dateTime={note.at}
              >
                {formatDateTime(note.at)}
              </time>
              <p className="whitespace-pre-wrap">{note.text}</p>
            </li>
          ))}
        </ol>
      ) : (
        <div className="border-t">
          <NotLoadedState heading="h3" page={overview} />
        </div>
      )}
    </SettingsSection>
  );
};

export const Route = createFileRoute("/_shell/onboarding/notes")({
  loader: async ({ context: { core } }) =>
    await loadFromCore(
      core,
      async (session) => await session.onboardingStaff.overview()
    ),
  errorComponent: SettingsError,
  component: Notes,
});
