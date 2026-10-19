import { Button } from "@grasp-os/ui/components/button";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { cn } from "@grasp-os/ui/lib/utils";
import { useLingui } from "@lingui/react/macro";
import { CheckIcon } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";

import { readingSeconds } from "./setup.ts";

// The parts every step of the client onboarding is made of (prototype
// `components/onboarding/onboarding-steps.tsx`): one title, one sentence,
// one small action, one main button. Grasp has no voice here yet, so each
// step goes as the prototype's does with the sound off: its way on waits
// for most of the time its line takes to read, then fades in.

/**
 * Whether a step has been explained yet: given its reading time. Its way
 * on, the main button and any "skip", waits for it and then fades in.
 */
export const Explained = createContext<{
  explained: boolean;
  onExplained: () => void;
}>({
  explained: true,
  onExplained: () => {
    // Explained from the start.
  },
});

/**
 * Whether, on a phone, the step does not fit beside even the smallest
 * brain: its sentence then makes way once read and tells how much room that
 * frees, so the brain can make way too where that is not enough.
 */
export const Cramped = createContext<{
  cramped: boolean;
  onMadeWay: (freed: number) => void;
}>({
  cramped: false,
  onMadeWay: () => {
    // Nothing to make way for.
  },
});

/** Explained once there was time to read `line`: most of its reading time, never more than four seconds. */
export const useExplainedAfter = (line: string): void => {
  const { onExplained } = useContext(Explained);
  useEffect(() => {
    const wait = Math.min(readingSeconds(line) * 1000 * 0.7, 4000);
    const id = window.setTimeout(onExplained, wait);
    return () => {
      window.clearTimeout(id);
    };
  }, [line, onExplained]);
};

/**
 * Whether a step's sentence has made way for what the step shows, `when`
 * nothing else stands in its place: on a phone where the step does not fit,
 * once there was time to read it all. Gone, it stays gone on this visit, so
 * it never comes and goes as the room it leaves changes.
 */
const useMadeWay = (
  line: string,
  when: boolean,
  sentence: RefObject<HTMLElement | null>
): boolean => {
  const { cramped, onMadeWay } = useContext(Cramped);
  const { explained } = useContext(Explained);
  const arrived = useRef(0);
  const [away, setAway] = useState(false);
  useEffect(() => {
    arrived.current = Date.now();
  }, []);
  useEffect(() => {
    const due = !away && when && cramped && explained;
    const reading = readingSeconds(line) * 1000 * 0.7;
    const id = due
      ? window.setTimeout(
          () => {
            // The room it frees is measured as it goes, before it folds away.
            onMadeWay(sentence.current?.offsetHeight ?? 0);
            setAway(true);
          },
          Math.max(0, arrived.current + reading - Date.now())
        )
      : undefined;
    return () => {
      window.clearTimeout(id);
    };
  }, [away, when, cramped, explained, line, onMadeWay, sentence]);
  return away;
};

/** The way on, fading in once the step has been explained, and `ready` if it waits on something more. */
export const Onward = ({
  children,
  ready = true,
}: {
  children: ReactNode;
  ready?: boolean;
}) => {
  const { explained } = useContext(Explained);
  const shown = explained && ready;
  return (
    <div
      className={cn(
        "flex w-full flex-col items-center gap-6 transition-all duration-1000 ease-out",
        !shown && "translate-y-1.5 opacity-0"
      )}
      inert={!shown}
    >
      {children}
    </div>
  );
};

/** What Grasp says back to what was just done on a step, in place of its sentence. */
export interface Answer {
  text: string;
}

/**
 * A step's title and sentence. Once something is done, Grasp's answer
 * takes the sentence's place, as in a conversation: the sentence fades at
 * once and the answer comes in. The sentence keeps its room, so nothing
 * below moves. On a phone where the step does not fit, the sentence makes
 * way once read, giving its room to what the step shows; an answer then
 * takes only the room it needs.
 */
export const Heading = ({
  title,
  sentence,
  answer,
}: {
  title: string;
  sentence?: string;
  answer?: Answer;
}) => {
  const heading = useRef<HTMLHeadingElement>(null);
  const paragraph = useRef<HTMLParagraphElement>(null);
  const line = sentence === undefined ? title : `${title} ${sentence}`;
  // A new step moves focus to its title, so a screen reader starts there, and the keys go on from it.
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);
  useExplainedAfter(line);
  const away = useMadeWay(line, answer === undefined, paragraph);
  return (
    <div className="flex flex-col gap-2">
      {/* A title that takes two lines breaks them evenly, never leaving one word alone on the second. */}
      <h1
        className="text-2xl font-medium tracking-tight text-balance outline-none"
        ref={heading}
        tabIndex={-1}
      >
        {title}
      </h1>
      {sentence === undefined ? null : (
        // Two lines kept in every language, and the sentence's own room once answered, so nothing below moves; once it made way, none.
        <p
          aria-live="polite"
          className={cn(
            "text-muted-foreground grid text-balance transition-all duration-500",
            away ? "overflow-hidden" : "min-h-10",
            away && answer === undefined && "h-0 opacity-0"
          )}
          ref={paragraph}
        >
          <span
            aria-hidden={answer === undefined ? undefined : true}
            className={cn(
              "col-start-1 row-start-1 transition-opacity",
              answer === undefined ? "duration-400" : "opacity-0 duration-200",
              away && answer !== undefined && "hidden"
            )}
          >
            {sentence}
          </span>
          {answer === undefined ? null : (
            <span
              className="animate-in fade-in slide-in-from-bottom-1 col-start-1 row-start-1 self-center duration-500"
              key={answer.text}
            >
              {answer.text}
            </span>
          )}
        </p>
      )}
    </div>
  );
};

/**
 * The main button of a step, which waits until the step has been explained
 * and then fades in. Never wider than a comfortable reach, centred under
 * the step however wide it is.
 */
export const Primary = ({
  children,
  busy = false,
  done = false,
  disabled = false,
  ready = true,
  onClick,
}: {
  children: ReactNode;
  busy?: boolean;
  done?: boolean;
  disabled?: boolean;
  /** Whether the step has what it needs beyond being explained, such as a language chosen. */
  ready?: boolean;
  onClick: () => void;
}) => {
  let icon: ReactNode = null;
  if (busy) {
    icon = <Spinner data-icon="inline-start" />;
  } else if (done) {
    icon = <CheckIcon data-icon="inline-start" />;
  }
  return (
    <Onward ready={ready}>
      <Button
        className="w-full max-w-sm"
        disabled={disabled || busy}
        onClick={onClick}
        size="xl"
      >
        {icon}
        {children}
      </Button>
    </Onward>
  );
};

export const laterClass =
  "text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-3";

/** The small way past a step that can wait: a muted link, never a second button. */
export const LaterLink = ({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) => (
  <button className={laterClass} onClick={onClick} type="button">
    {children}
  </button>
);

/** That way past a step, on a line of its own: it waits with the main button. */
export const Later = (props: { children: ReactNode; onClick: () => void }) => (
  <Onward>
    <LaterLink {...props} />
  </Onward>
);

/** Grasp's support site, where every connection has a page of its own: what it reads, what it never reads, and how to take it away again. */
const supportUrl = "https://support.joingrasp.com";

/** The pages the onboarding links to, by what is connected on a step. */
const connectionPages = {
  /** A staff list shared as a file. */
  staffList: "connections/staff-list",
  /** The places where documents live: SharePoint, Google Drive, Notion and the like. */
  documents: "connections/documents",
  /** Pulse, the app on the work laptops. */
  pulse: "connections/pulse",
} as const;

export type ConnectionPage = keyof typeof connectionPages;

/**
 * More about what a step connects, on Grasp's support site, in a new tab:
 * always underlined, so it is seen to be a link.
 */
export const SupportLink = ({
  page,
  children: label,
}: {
  page: ConnectionPage;
  children: string;
}) => {
  const { t } = useLingui();
  return (
    <a
      aria-label={t`${label}, on Grasp’s support site, in a new tab`}
      className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 rounded-sm underline underline-offset-4 outline-none focus-visible:ring-3"
      href={`${supportUrl}/${connectionPages[page]}`}
      rel="noopener noreferrer"
      target="_blank"
    >
      {label}
    </a>
  );
};

/** That link on a line of its own under a step: it waits with the step's way on. */
export const MoreAbout = (props: {
  page: ConnectionPage;
  children: string;
}) => (
  <Onward>
    <SupportLink {...props} />
  </Onward>
);

/**
 * The small lines under a step: a way past it, and more about what it
 * connects. Side by side where both fit, and under each other where they
 * do not. They wait with the step's way on.
 */
export const Asides = ({ children }: { children: ReactNode }) => (
  <Onward>
    <div className="flex w-full flex-wrap items-center justify-center gap-x-5 gap-y-2">
      {children}
    </div>
  </Onward>
);

/** A line that turns up on a step later on. */
export const Callout = ({ text }: { text: string }) => (
  <p className="animate-in fade-in duration-500">{text}</p>
);

/** A number with what it counts. */
export const Figure = ({ value, label }: { value: string; label: string }) => (
  <div className="flex flex-col rounded-xl border p-4">
    <span className="text-2xl leading-tight font-medium tabular-nums">
      {value}
    </span>
    <span className="text-muted-foreground">{label}</span>
  </div>
);
