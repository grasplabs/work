import type {
  KnownAbout,
  KnownSentence,
  RestsOn,
  WorkKnowledge,
} from "@grasp-os/shared/work-knowledge";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { Heading } from "@grasp-os/ui/components/heading";
import { Text } from "@grasp-os/ui/components/text";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import { focusRing } from "@grasp-os/ui/lib/styles";
import {
  colors,
  font,
  media,
  radius,
  size,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
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
// is says whether its team told it or not yet, never how many, with Ask
// more people for the company's admins.

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

/** Where the page has room for what Grasp is sure of beside the story. */
const WIDE = media.xl;

const styles = stylex.create({
  page: {
    display: "flex",
    flexDirection: { default: "column", [WIDE]: "row" },
    alignItems: { default: "stretch", [WIDE]: "flex-start" },
    gap: { default: space["10"], [WIDE]: space["16"] },
    width: "100%",
    maxWidth: `calc(16 * ${space["16"]})`,
    marginInline: "auto",
  },
  story: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minWidth: 0,
    maxWidth: `calc(10 * ${space["16"]})`,
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: space["2"],
    paddingBlock: space["6"],
    borderTopWidth: size.hairline,
    borderTopStyle: "solid",
    borderTopColor: colors.border,
    ":first-child": { paddingTop: 0, borderTopWidth: 0 },
    ":last-child": { paddingBottom: 0 },
  },
  told: {
    margin: 0,
    fontSize: font.textBase,
    lineHeight: 2,
    color: colors.bodyForeground,
    textWrap: "pretty",
  },
  // The bead after a sentence: a small dot, pointed at for what it rests on.
  bead: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: space["3"],
    height: space["3"],
    margin: 0,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.circle,
    backgroundColor: "transparent",
    verticalAlign: "middle",
    cursor: "default",
  },
  beadDot: {
    width: size.severityDot,
    height: size.severityDot,
    borderRadius: radius.circle,
    backgroundColor: colors.mutedForeground,
  },
  aside: {
    display: "flex",
    flexDirection: "column",
    flexShrink: 0,
    overflow: "hidden",
    width: { default: "auto", [WIDE]: `calc(4 * ${space["16"]})` },
    position: { default: "static", [WIDE]: "sticky" },
    top: space["8"],
    borderRadius: radius.base,
    backgroundColor: colors.card,
    boxShadow: size.borderStrong,
  },
  list: {
    display: "flex",
    flexDirection: "column",
    margin: 0,
  },
  fact: {
    display: "flex",
    flexDirection: "column",
    gap: space["2"],
    paddingBlock: space["3"],
    paddingInline: space["4"],
    borderTopWidth: { default: size.hairline, ":first-child": 0 },
    borderTopStyle: "solid",
    borderTopColor: colors.border,
  },
  term: {
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    color: colors.mutedForeground,
  },
  value: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: space["2"],
    margin: 0,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.bodyForeground,
  },
  kinds: {
    display: "flex",
    flexWrap: "wrap",
    columnGap: space["3"],
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
});

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

/** The bead after a sentence: pointed at or focused, what it rests on. */
const Bead = ({ sentence }: { sentence: KnownSentence }) => {
  const said = useBeadText(sentence);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label={said}
          type="button"
          {...stylex.props(styles.bead, focusRing)}
        >
          <span aria-hidden="true" {...stylex.props(styles.beadDot)} />
        </button>
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
  <section {...stylex.props(styles.section)}>
    <Heading level={2} size="2xs">
      {title}
    </Heading>
    <p {...stylex.props(styles.told)}>{children}</p>
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
    <div {...stylex.props(styles.fact)}>
      <dt {...stylex.props(styles.term)}>
        <Trans>How sure</Trans>
      </dt>
      <dd {...stylex.props(styles.value)}>
        {heard ? (
          <Badge variant="success">{t`Told by the team that does it`}</Badge>
        ) : (
          <Badge variant="warning">{t`Waiting for more voices`}</Badge>
        )}
        {known.moreAsked ? (
          <Text as="span" size="sm" color="muted">
            <Trans>
              More people are asked about it in the next interviews.
            </Trans>
          </Text>
        ) : null}
        {known.canAskMore && !known.moreAsked ? (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              void ask();
            }}
            size="sm"
          >
            {t`Ask more people`}
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
    <div {...stylex.props(styles.page)}>
      <article {...stylex.props(styles.story)}>
        {told.length === 0 ? (
          <Text size="default" color="muted">
            <Trans>
              Grasp knows nothing about this work in its own words yet.
            </Trans>
          </Text>
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
      <aside {...stylex.props(styles.aside)}>
        <dl {...stylex.props(styles.list)}>
          <HowSure known={known} onChange={onChange} />
          {restsOn.length > 0 ? (
            <div {...stylex.props(styles.fact)}>
              <dt {...stylex.props(styles.term)}>
                <Trans context="what a piece of work's knowledge rests on: said, written, seen or done">
                  Rests on
                </Trans>
              </dt>
              <dd {...stylex.props(styles.value)}>
                <ul {...stylex.props(styles.kinds)}>
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
  const readWork = async (): Promise<Loaded<WorkKnowledge>> =>
    await loadFromCore(core, async (session) => await session.brain.work(work));
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
    return (
      <NotLoadedState
        reread={async () => {
          // What was read stays until the new read lands.
          setLoaded(await readWork());
        }}
        page={loaded}
      />
    );
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
