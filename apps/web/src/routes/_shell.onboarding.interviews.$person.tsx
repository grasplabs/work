import { interviewerNames } from "@grasp-os/shared/onboarding";
import type { StaffInterview } from "@grasp-os/shared/onboarding-staff";
import { Button } from "@grasp-os/ui/components/button";
import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";

import { formatDateTime } from "../format.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { SettingsError } from "../settings/settings-parts.tsx";

// One interview, as Grasp's staff see it (GRA-329): where it stands, who
// held it and on which version of their text, and its numbers. Never a
// word of it: nobody at Grasp reads what anyone said, so core sends none.
// Opening it is in the audit log first (core's staff-rpc.ts), by the
// interview's own id, without the person.

/** How many characters of a text's mark name it: as a commit's short hash does. */
const shortMark = 12;

/** How it was held: by voice or typed, how long, and when it ended. */
const howText = (i18n: I18n, read: StaffInterview): string => {
  const { mode, startedAt, completedAt } = read;
  const typed = mode === "type";
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

/** Whether they took part, and withdrew. */
const takingPartText = (i18n: I18n, read: StaffInterview): string => {
  if (read.withdrawnAt !== null) {
    const on = formatDateTime(read.withdrawnAt);
    return i18n._(msg`Withdrew on ${on}: nothing of it is used.`);
  }
  if (read.participatedAt === null) {
    return i18n._(msg`Has not agreed to take part yet.`);
  }
  const on = formatDateTime(read.participatedAt);
  return i18n._(msg`Agreed to take part on ${on}.`);
};

const Reader = ({ read }: { read: StaffInterview }) => {
  const { t, i18n } = useLingui();
  const who =
    read.interviewer === null ? "Stephen" : interviewerNames[read.interviewer];
  const { said, facts, out, approved } = read.counts;
  const { rating } = read;
  return (
    <section
      aria-labelledby="interview-heading"
      className="bg-card overflow-hidden rounded-xl border text-sm"
    >
      <div className="flex flex-col gap-0.5 px-5 py-4">
        <h2 className="font-medium" id="interview-heading">
          {read.name}
        </h2>
        <p className="text-muted-foreground">{read.team}</p>
        <p className="text-muted-foreground">
          {howText(i18n, read)} {t`With ${who}.`}{" "}
          {rating === null ? null : t`Rated ${rating} of 5.`}
        </p>
        <p className="text-muted-foreground">{takingPartText(i18n, read)}</p>
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
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 border-t px-5 py-4 sm:grid-cols-4">
        <dt className="text-muted-foreground">{t`Answers`}</dt>
        <dd>{said}</dd>
        <dt className="text-muted-foreground">{t`Written down`}</dt>
        <dd>{facts}</dd>
        <dt className="text-muted-foreground">{t`Taken out`}</dt>
        <dd>{out}</dd>
        <dt className="text-muted-foreground">{t`Approved`}</dt>
        <dd>{approved}</dd>
      </dl>
      <p className="text-muted-foreground border-t px-5 py-4">
        <Trans>
          What was said stays with the person who said it. Nobody at Grasp reads
          it.
        </Trans>
      </p>
    </section>
  );
};

const Interview = () => {
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
          <Trans>All interviews</Trans>
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
      async (session): Promise<StaffInterview> =>
        await session.onboardingStaff.interview(params.person)
    ),
  errorComponent: SettingsError,
  component: Interview,
});
