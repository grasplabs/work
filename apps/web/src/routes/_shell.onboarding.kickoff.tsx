import {
  answerMaxLength,
  transcriptFileKinds,
  transcriptFileMaxBytes,
  transcriptMaxLength,
  visionFields,
} from "@grasp-os/shared/kickoff";
import type {
  KickoffInput,
  KickoffView,
  VisionField,
} from "@grasp-os/shared/kickoff";
import { interviewLocaleSchema } from "@grasp-os/shared/onboarding";
import { Button } from "@grasp-os/ui/components/button";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { CircleCheckIcon, CircleHelpIcon, UploadIcon } from "lucide-react";
import { useId, useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { inLanguage } from "../onboarding/kickoff-errors.ts";
import { visionTitles } from "../onboarding/staff-words.ts";
import {
  SettingsBody,
  SettingsError,
  SettingsSection,
} from "../settings/settings-parts.tsx";
import { useCoreAction } from "../use-core-action.ts";

// The onboarding area's kickoff (GRA-318), as in the prototype
// (`components/admin/stage-conversation.tsx`): Grasp's first conversation
// with the sponsor, pasted or brought in as a file, and read for the ten
// things Stephen needs. What it said shows with the words it rests on;
// what it left open, with the question for the sponsor and their answer.
// Brought in again, it is read again.

const accept = transcriptFileKinds.map((kind) => `.${kind}`).join(",");

/** Brings the transcript in, pasted or as a file, and has it read. */
const BringIn = ({ replacing }: { replacing: boolean }) => {
  const { t, i18n } = useLingui();
  const router = useRouter();
  const textId = useId();
  const fileId = useId();
  const { busy, failure, run } = useCoreAction();
  const [text, setText] = useState("");
  const [tooLarge, setTooLarge] = useState(false);
  const spoken = interviewLocaleSchema.safeParse(i18n.locale);
  const locale = spoken.success ? spoken.data : "en";
  const read = async (
    transcript: KickoffInput["transcript"]
  ): Promise<void> => {
    // A file too large before says nothing about this read.
    setTooLarge(false);
    await run(async (session) => {
      await changeThenRefresh(
        async () => {
          try {
            await session.onboardingStaff.saveKickoff({ locale, transcript });
          } catch (error) {
            throw inLanguage(i18n, error);
          }
          setText("");
        },
        async () => {
          await router.invalidate({ sync: true });
        }
      );
    });
  };
  const readFile = async (file: File): Promise<void> => {
    const tooBig = file.size > transcriptFileMaxBytes;
    setTooLarge(tooBig);
    if (!tooBig) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await read({ file: { name: file.name, bytes } });
    }
  };
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void read({ text });
      }}
    >
      <label className="sr-only" htmlFor={textId}>
        <Trans>The transcript</Trans>
      </label>
      <Textarea
        className="max-h-80"
        disabled={busy}
        id={textId}
        maxLength={transcriptMaxLength}
        onChange={(event) => {
          setText(event.target.value);
        }}
        placeholder={t`Paste the transcript of the first conversation with the sponsor`}
        value={text}
      />
      <input
        accept={accept}
        className="sr-only"
        disabled={busy}
        id={fileId}
        onChange={(event) => {
          const [file] = event.target.files ?? [];
          // Empty again, so the same file can be chosen once more.
          event.target.value = "";
          if (file === undefined) {
            return;
          }
          void readFile(file);
        }}
        type="file"
      />
      <ErrorText>
        {tooLarge ? t`That file is too large for a transcript.` : failure}
      </ErrorText>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {busy ? (
          <span className="text-muted-foreground mr-auto flex items-center gap-2">
            <Spinner />
            <Trans>Stephen is reading it. This takes a minute.</Trans>
          </span>
        ) : null}
        <label
          className="border-input hover:bg-accent inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm font-medium shadow-xs has-[:disabled]:pointer-events-none has-[:disabled]:opacity-50"
          htmlFor={fileId}
        >
          <UploadIcon aria-hidden="true" className="size-4" />
          <Trans>Choose a file</Trans>
        </label>
        <Button disabled={busy || text.trim() === ""} type="submit">
          {replacing ? <Trans>Read it again</Trans> : <Trans>Read it</Trans>}
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        <Trans>A .txt, .vtt, .srt or .docx file, or pasted text.</Trans>
      </p>
    </form>
  );
};

/** The sponsor's answer to what the kickoff left open about `field`. */
const Answer = ({
  field,
  answer,
}: {
  field: VisionField;
  answer: string | undefined;
}) => {
  const { t, i18n } = useLingui();
  const router = useRouter();
  const id = useId();
  const { busy, failure, run } = useCoreAction();
  const [text, setText] = useState(answer ?? "");
  const save = async (): Promise<void> => {
    await run(async (session) => {
      await changeThenRefresh(
        async () => {
          try {
            await session.onboardingStaff.answerKickoff(field, text);
          } catch (error) {
            throw inLanguage(i18n, error);
          }
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
        void save();
      }}
    >
      <label className="sr-only" htmlFor={id}>
        <Trans>The sponsor&apos;s answer</Trans>
      </label>
      <Textarea
        disabled={busy}
        id={id}
        maxLength={answerMaxLength}
        onChange={(event) => {
          setText(event.target.value);
        }}
        placeholder={t`The sponsor's answer`}
        value={text}
      />
      <ErrorText>{failure}</ErrorText>
      <div className="flex justify-end">
        <Button
          disabled={busy || text.trim() === (answer ?? "")}
          size="sm"
          type="submit"
          variant="outline"
        >
          <Trans>Keep the answer</Trans>
        </Button>
      </div>
    </form>
  );
};

/** One of the ten: what the kickoff said, or the question it left open. */
const Field = ({
  field,
  kickoff,
}: {
  field: VisionField;
  kickoff: KickoffView;
}) => {
  const { i18n } = useLingui();
  const said = kickoff.reading?.fields[field];
  const ask = kickoff.reading?.ask[field];
  const answer = kickoff.answers[field];
  const known = said !== undefined || answer !== undefined;
  const title = i18n._(visionTitles[field]);
  const Icon = known ? CircleCheckIcon : CircleHelpIcon;
  return (
    <li className="flex flex-col gap-2 border-t px-5 py-4">
      <div className="flex items-center gap-2">
        <Icon
          aria-hidden="true"
          className={
            known ? "size-4" : "text-status-attention size-4 flex-none"
          }
        />
        <h3 className="font-medium">{title}</h3>
      </div>
      {said === undefined ? (
        <div className="flex flex-col gap-2 pl-6">
          <p>
            {ask === undefined || ask === "" ? (
              <Trans>Ask the sponsor about {title}.</Trans>
            ) : (
              <Trans>Ask the sponsor: {ask}</Trans>
            )}
          </p>
          <Answer answer={answer} field={field} key={answer ?? ""} />
        </div>
      ) : (
        <div className="flex flex-col gap-2 pl-6">
          <p>{said.text}</p>
          <blockquote className="text-muted-foreground border-l-2 pl-3 italic">
            {said.quote}
          </blockquote>
          {/* An answer from before a new reading stays in Stephen's
              context: in sight, to change or take back. */}
          {answer === undefined ? null : (
            <Answer answer={answer} field={field} key={answer} />
          )}
        </div>
      )}
    </li>
  );
};

const Reading = ({ kickoff }: { kickoff: KickoffView }) => {
  const { t } = useLingui();
  const teams = kickoff.reading?.teams ?? [];
  return (
    <>
      <SettingsSection
        description={t`What Stephen takes into every interview. What the conversation left open goes to the sponsor.`}
        title={t`What it brought`}
      >
        <ol>
          {visionFields.map((field) => (
            <Field field={field} key={field} kickoff={kickoff} />
          ))}
        </ol>
      </SettingsSection>
      {teams.length === 0 ? null : (
        <SettingsSection
          description={t`As the company named them, until the staff list is in.`}
          title={t`Teams named`}
        >
          <ul>
            {teams.map((team) => (
              <li
                className="flex items-baseline gap-3 border-t px-5 py-3"
                key={team.name}
              >
                <span className="font-medium">{team.name}</span>
                <span className="text-muted-foreground min-w-0 flex-1">
                  {team.does}
                </span>
                {team.people === undefined ? null : (
                  <span className="text-muted-foreground tabular-nums">
                    {plural(team.people, {
                      one: "# person",
                      other: "# people",
                    })}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </SettingsSection>
      )}
    </>
  );
};

/** When the transcript came in, and from where; what the section is, before. */
const BroughtIn = ({
  transcript,
}: {
  transcript: KickoffView["transcript"];
}) => {
  const { t } = useLingui();
  if (transcript === null) {
    return t`Grasp's first conversation with the sponsor, read for the ten things Stephen needs before his first interview.`;
  }
  const when = formatDateTime(transcript.at);
  const { fileName } = transcript;
  return fileName === null
    ? t`Pasted on ${when}. Bring it in again to read it again.`
    : t`${fileName}, brought in on ${when}. Bring it in again to read it again.`;
};

const Kickoff = () => {
  const { t } = useLingui();
  const kickoff = Route.useLoaderData();
  if (kickoff.state !== "ready") {
    return (
      <div className="bg-card overflow-hidden rounded-xl border">
        <NotLoadedState heading="h2" page={kickoff} />
      </div>
    );
  }
  const { transcript } = kickoff.data;
  return (
    <>
      <SettingsSection
        description={<BroughtIn transcript={transcript} />}
        title={t`The kickoff`}
      >
        <SettingsBody>
          <BringIn replacing={transcript !== null} />
        </SettingsBody>
      </SettingsSection>
      {kickoff.data.reading === null ? null : (
        <Reading kickoff={kickoff.data} />
      )}
    </>
  );
};

export const Route = createFileRoute("/_shell/onboarding/kickoff")({
  loader: async ({ context: { core } }) =>
    await loadFromCore(
      core,
      async (session) => await session.onboardingStaff.kickoff()
    ),
  errorComponent: SettingsError,
  component: Kickoff,
});
