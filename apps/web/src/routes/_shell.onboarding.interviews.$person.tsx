import type { InterviewLine } from "@grasp-os/shared/interview-links";
import { markedPieces } from "@grasp-os/shared/interview-turn";
import { interviewerNames } from "@grasp-os/shared/onboarding";
import type { StaffTranscript } from "@grasp-os/shared/onboarding-staff";
import { Button } from "@grasp-os/ui/components/button";
import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeftIcon, FileIcon } from "lucide-react";

import { formatDateTime } from "../format.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { tagTitles } from "../onboarding/interview-words.ts";
import { SettingsError } from "../settings/settings-parts.tsx";

// One transcript (prototype `org-transcripts.tsx`, its reader): the
// conversation, with what the interviewer wrote down marked in what the
// person said, beside the facts as the record keeps them; who held it, and
// on which version of their text. Opening it reads it from core, and every
// read is in the audit log first (core's staff-rpc.ts), by the interview's
// own id, without the person or their words.

/** How many characters of a text's mark name it: as a commit's short hash does. */
const shortMark = 12;

const markClass =
  "bg-muted text-foreground -mx-0.5 rounded-sm box-decoration-clone px-0.5 underline decoration-dotted underline-offset-4";

/** Something the person said, with what was written down from it marked. */
const Said = ({ line }: { line: InterviewLine }) => {
  const { i18n } = useLingui();
  if (line.file !== undefined) {
    return (
      <span className="flex items-center gap-2">
        <FileIcon
          aria-hidden="true"
          className="text-muted-foreground size-4 flex-none"
        />
        {line.file}
      </span>
    );
  }
  return (
    <>
      {markedPieces(line.text, line.marks).map((piece, index) =>
        piece.tag === null ? (
          <span key={index}>{piece.text}</span>
        ) : (
          <mark
            className={markClass}
            key={index}
            title={i18n._(tagTitles[piece.tag])}
          >
            {piece.text}
          </mark>
        )
      )}
    </>
  );
};

/** How it was held: by voice or typed, how long, and when it ended. */
const howText = (i18n: I18n, read: StaffTranscript): string => {
  const { progress, startedAt, completedAt } = read;
  const typed = progress?.mode === "type";
  if (startedAt === null) {
    return typed
      ? i18n._(msg`Typed, not started yet.`)
      : i18n._(msg`Not started yet.`);
  }
  const started = formatDateTime(startedAt);
  if (completedAt === null) {
    return typed
      ? i18n._(msg`Typed, started on ${started}, not agreed to yet.`)
      : i18n._(msg`By voice, started on ${started}, not agreed to yet.`);
  }
  const minutes = Math.max(
    0,
    Math.round((Date.parse(completedAt) - Date.parse(startedAt)) / 60_000)
  );
  const agreedOn = formatDateTime(completedAt);
  return typed
    ? i18n._(msg`Typed, ${minutes} minutes, agreed to on ${agreedOn}.`)
    : i18n._(msg`By voice, ${minutes} minutes, agreed to on ${agreedOn}.`);
};

const Reader = ({ read }: { read: StaffTranscript }) => {
  const { t, i18n } = useLingui();
  const { progress } = read;
  const who =
    read.interviewer === null ? "Stephen" : interviewerNames[read.interviewer];
  const first = read.name.split(" ")[0] ?? read.name;
  const agreed = progress?.person === "completed";
  const rating = progress?.rating;
  return (
    <>
      <section
        aria-labelledby="transcript-heading"
        className="bg-card overflow-hidden rounded-xl border text-sm"
      >
        <div className="flex flex-col gap-0.5 px-5 py-4">
          <h2 className="font-medium" id="transcript-heading">
            {read.name}
          </h2>
          <p className="text-muted-foreground">{read.team}</p>
          <p className="text-muted-foreground">
            {howText(i18n, read)} {t`With ${who}.`}{" "}
            {rating === undefined ? null : t`Rated ${rating} of 5.`}
          </p>
          <p className="text-muted-foreground">
            {read.texts.length === 0 ? (
              <Trans>
                No turn of this interview has a text version on record.
              </Trans>
            ) : (
              <>
                {t`${who}'s text:`}{" "}
                {read.texts.map((mark, index) => (
                  <code className="mr-2 text-xs" key={mark} title={mark}>
                    {index > 0 ? "→ " : ""}
                    {mark.slice(0, shortMark)}
                  </code>
                ))}
              </>
            )}
          </p>
        </div>
      </section>
      {progress === null ? (
        <p className="bg-card text-muted-foreground rounded-xl border px-5 py-4 text-sm">
          <Trans>
            Nothing was said yet, or it was deleted because {first} asked.
          </Trans>
        </p>
      ) : (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
          <section
            aria-label={t`The conversation`}
            className="bg-card overflow-hidden rounded-xl border text-sm"
          >
            <div className="flex flex-col gap-0.5 px-5 py-4">
              <h2 className="font-medium">{t`The conversation`}</h2>
              <p className="text-muted-foreground">
                {t`What is marked is what ${who} wrote down.`}
              </p>
            </div>
            <ol className="flex flex-col gap-3 border-t px-5 py-4">
              {progress.lines.map((line, index) =>
                line.from === "stephen" ? (
                  <li className="max-w-[85%] self-start" key={index}>
                    <span className="sr-only">{`${who}: `}</span>
                    {line.text}
                  </li>
                ) : (
                  <li
                    className="bg-muted max-w-[85%] self-end rounded-2xl px-3.5 py-2"
                    key={index}
                  >
                    <span className="sr-only">{`${first}: `}</span>
                    <Said line={line} />
                  </li>
                )
              )}
            </ol>
          </section>
          <section
            aria-label={t`What ${who} wrote down`}
            className="bg-card overflow-hidden rounded-xl border text-sm"
          >
            <div className="flex flex-col gap-0.5 px-5 py-4">
              <h2 className="font-medium">{t`What ${who} wrote down`}</h2>
              <p className="text-muted-foreground">
                {agreed
                  ? t`As the record keeps it. What they took out is struck through and does not count.`
                  : t`As the record keeps it so far. Nothing counts until the person has agreed to it.`}
              </p>
            </div>
            <ul className="flex flex-col">
              {progress.facts.map((fact) => (
                <li
                  className="flex flex-col gap-0.5 border-t px-5 py-2.5"
                  key={fact.id}
                >
                  <span className="text-muted-foreground text-xs">
                    {i18n._(tagTitles[fact.tag])}
                  </span>
                  <span
                    className={
                      fact.out === true
                        ? "text-muted-foreground line-through"
                        : undefined
                    }
                  >
                    {fact.record === "" ? fact.text : fact.record}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </>
  );
};

const Transcript = () => {
  const loaded = Route.useLoaderData();
  return (
    <>
      <div>
        <Button
          render={
            <Link search={{ tab: "transcripts" }} to="/onboarding/interviews" />
          }
          size="sm"
          variant="ghost"
        >
          <ArrowLeftIcon data-icon="inline-start" />
          <Trans>All transcripts</Trans>
        </Button>
      </div>
      {loaded.state === "ready" ? (
        <Reader read={loaded.data} />
      ) : (
        <div className="bg-card overflow-hidden rounded-xl border">
          <NotLoadedState heading="h2" page={loaded} />
        </div>
      )}
    </>
  );
};

export const Route = createFileRoute("/_shell/onboarding/interviews/$person")({
  loader: async ({ context: { core }, params }) =>
    await loadFromCore(
      core,
      async (session): Promise<StaffTranscript> =>
        await session.onboardingStaff.transcript(params.person)
    ),
  errorComponent: SettingsError,
  component: Transcript,
});
