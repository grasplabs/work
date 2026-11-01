import type {
  KnownAbout,
  KnownSentence,
  RestsOn,
  WorkKnowledge,
} from "@grasp-os/shared/work-knowledge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import { cn } from "@grasp-os/ui/lib/utils";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { ErrorText } from "../error-text.tsx";
import { LoadingLines, NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";

// A piece of work's Knowledge tab (prototype `inside-knowledge.tsx`, at
// `30e1e9f0`): what Grasp knows about it in its own sentences
// (`brain.work`), each ending in a bead that says what it rests on and
// the week, and who said it only where core says so. Never a face, a
// name, a day or a person's own words: core serves none. How sure Grasp
// is says enough or not yet, never how many, with Ask more people for the
// company's admins while not enough told it.

/** The parts of the story, in the order a reader wants them. */
const parts: {
  id: string;
  title: MessageDescriptor;
  about: readonly KnownAbout[];
}[] = [
  { id: "today", title: msg`How the work goes today`, about: ["today"] },
  {
    id: "way",
    title: msg`What gets in the way`,
    about: ["blocker", "handover", "tool"],
  },
  { id: "time", title: msg`Where the time goes`, about: ["timeSink"] },
  {
    id: "want",
    title: msg`What they want instead`,
    about: ["wish", "goal", "rule"],
  },
];

const restsOnText: Readonly<Record<RestsOn, MessageDescriptor>> = {
  said: msg`Said in an interview`,
  written: msg`Written in a document`,
  seen: msg`Seen in use`,
  done: msg`Done in a run`,
};

const restsOnKind: Readonly<Record<RestsOn, MessageDescriptor>> = {
  said: msg({
    message: "Said",
    context: "what something known rests on: people said it",
  }),
  written: msg({
    message: "Written",
    context: "what something known rests on: a document says it",
  }),
  seen: msg({
    message: "Seen",
    context: "what something known rests on: Grasp saw it in use",
  }),
  done: msg({
    message: "Done",
    context: "what something known rests on: it happened in a run",
  }),
};

/** "2026-W42" as its week number. */
const weekNumberOf = (week: string): number => Number(week.slice(-2));

/** What a sentence rests on, the week, and who, as one line. */
const useBeadText = (sentence: KnownSentence): string => {
  const { t, i18n } = useLingui();
  const rests = i18n._(restsOnText[sentence.restsOn]);
  const week = weekNumberOf(sentence.week);
  const { by } = sentence;
  if (by === null) {
    return t`${rests} · week ${week}`;
  }
  const { team } = by;
  if (by.role === null) {
    return t`${rests} · ${team} · week ${week}`;
  }
  const { role } = by;
  return t`${rests} · ${role}, ${team} · week ${week}`;
};

/** The bead after a sentence: pointed at, what it rests on. */
const Bead = ({ sentence }: { sentence: KnownSentence }) => {
  const said = useBeadText(sentence);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            aria-label={said}
            className="focus-visible:ring-ring/50 inline-flex size-3 -translate-y-px items-center justify-center rounded-full align-middle outline-none focus-visible:ring-3"
            type="button"
          />
        }
      >
        <span
          aria-hidden="true"
          className="bg-foreground/70 size-1.5 rounded-full"
        />
      </TooltipTrigger>
      <TooltipContent>{said}</TooltipContent>
    </Tooltip>
  );
};

/** A sentence as written, with its full stop. */
const asSentence = (text: string): string => {
  const trimmed = text.trim();
  const first = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/u.test(first) ? first : `${first}.`;
};

const Section = ({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) => (
  <section className="flex flex-col gap-2 py-6 first:pt-0 last:pb-0">
    <h2 className="font-medium">{title}</h2>
    <p className="leading-loose text-pretty">{children}</p>
  </section>
);

/** How sure Grasp is, and the way to more voices. */
const HowSure = ({
  known,
  onChange,
}: {
  known: WorkKnowledge;
  onChange: (known: WorkKnowledge) => void;
}) => {
  const { t } = useLingui();
  const { busy, failure, run } = useCoreAction();
  const heard = known.confidence === "heard";
  const ask = async (): Promise<void> => {
    const changed = await run(
      async (session) => await session.brain.askMorePeople(known.id)
    );
    if (changed !== undefined) {
      onChange(changed);
    }
  };
  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <dt className="text-muted-foreground text-xs">
        <Trans>How sure</Trans>
      </dt>
      <dd className="flex flex-col items-start gap-2">
        <span className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className={cn(
              "size-1.5 rounded-full",
              heard ? "bg-status-agreed" : "bg-status-attention"
            )}
          />
          {heard ? t`Heard from enough people` : t`Waiting for more voices`}
        </span>
        {known.moreAsked ? (
          <span className="text-muted-foreground">
            <Trans>
              More people are asked about it in the next interviews.
            </Trans>
          </span>
        ) : null}
        {known.canAskMore && !known.moreAsked ? (
          <Button
            disabled={busy}
            onClick={() => {
              void ask();
            }}
            size="sm"
            variant="outline"
          >
            <Trans>Ask more people</Trans>
          </Button>
        ) : null}
        <ErrorText>{failure}</ErrorText>
      </dd>
    </div>
  );
};

/** What Grasp knows about one piece of work, as read. */
const Known = ({
  known,
  onChange,
}: {
  known: WorkKnowledge;
  onChange: (known: WorkKnowledge) => void;
}) => {
  const { i18n } = useLingui();
  const told = parts.flatMap((part) => {
    const sentences = known.sentences.filter(({ about }) =>
      part.about.includes(about)
    );
    return sentences.length > 0 ? [{ ...part, sentences }] : [];
  });
  const restsOn = (["said", "written", "seen", "done"] as const).filter(
    (kind) => known.sentences.some(({ restsOn: rests }) => rests === kind)
  );
  return (
    <div className="@container mx-auto flex w-full max-w-5xl flex-col gap-10 @4xl:flex-row @4xl:items-start @4xl:gap-16">
      <article className="flex max-w-2xl min-w-0 flex-1 flex-col divide-y">
        {told.length === 0 ? (
          <p className="text-muted-foreground">
            <Trans>
              Grasp knows nothing about this work in its own words yet.
            </Trans>
          </p>
        ) : null}
        {told.map((part) => (
          <Section key={part.id} title={i18n._(part.title)}>
            {part.sentences.map((sentence) => (
              <span key={sentence.id}>
                {asSentence(sentence.text)} <Bead sentence={sentence} />{" "}
              </span>
            ))}
          </Section>
        ))}
      </article>
      <aside className="bg-card flex flex-none flex-col overflow-hidden rounded-xl border @4xl:sticky @4xl:top-8 @4xl:w-64">
        <dl className="flex flex-col divide-y">
          <HowSure known={known} onChange={onChange} />
          {restsOn.length > 0 ? (
            <div className="flex flex-col gap-2 px-4 py-3">
              <dt className="text-muted-foreground text-xs">
                <Trans context="what a piece of work's knowledge rests on: said, written, seen or done">
                  Rests on
                </Trans>
              </dt>
              <dd>
                <ul className="flex flex-wrap gap-x-3">
                  {restsOn.map((kind) => (
                    <li key={kind}>{i18n._(restsOnKind[kind])}</li>
                  ))}
                </ul>
              </dd>
            </div>
          ) : null}
        </dl>
      </aside>
    </div>
  );
};

/** The Knowledge tab of piece of work `work`, read from core when it opens. */
export const WorkKnowledgeTab = ({ work }: { work: string }) => {
  const core = useCore();
  const [loaded, setLoaded] = useState<Loaded<WorkKnowledge>>();
  useEffect(() => {
    let left = false;
    void (async () => {
      const read = await loadFromCore(
        core,
        async (session) => await session.brain.work(work)
      );
      if (!left) {
        setLoaded(read);
      }
    })();
    return () => {
      left = true;
    };
  }, [core, work]);
  if (loaded === undefined) {
    return <LoadingLines />;
  }
  if (loaded.state !== "ready") {
    return <NotLoadedState page={loaded} />;
  }
  return (
    <Known
      known={loaded.data}
      onChange={(known) => {
        setLoaded({ state: "ready", data: known });
      }}
    />
  );
};
