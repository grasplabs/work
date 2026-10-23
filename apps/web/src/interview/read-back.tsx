import { interviewerNames } from "@grasp-os/shared/onboarding";
import { Button } from "@grasp-os/ui/components/button";
import { Input } from "@grasp-os/ui/components/input";
import { cn } from "@grasp-os/ui/lib/utils";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { XIcon } from "lucide-react";
import { useRef, useState } from "react";

import { Head, headSizes, useHead } from "./head.tsx";
import { update, useInterviewer, useProgress } from "./kept.ts";
import { agreeToPart, changeLine, useLoop } from "./loop.ts";
import type { LoopState } from "./loop.ts";
import { partAt, withFactsBack, withFactToggled } from "./progress.ts";
import { useSaidIn, voiceLevel } from "./speech.ts";
import { SpokenText } from "./spoken.tsx";

// The read-back (prototype `interview-talk.tsx`, `ReadBack`): one part at
// a time, a few lines each, so it is read, checked and agreed to without
// scrolling. Stephen tells the lines back as a short story, and each lights
// up as he gets to it. A line is put right where it is, or taken out; the
// button agrees to what is left. What they type is taken as a correction.
// What they leave in is what counts.

/** A line of the read-back while he tells it: told, being told, or still to come. */
const toldLooks = {
  said: "text-foreground transition-colors duration-300",
  saying: "text-brain-heat transition-colors duration-150",
  waiting: "text-muted-foreground/60 transition-colors duration-300",
} as const;

const toldOf = (
  telling: LoopState["telling"],
  id: string
): keyof typeof toldLooks | null => {
  if (telling === null) {
    return null;
  }
  if (telling.now.includes(id)) {
    return "saying";
  }
  return telling.told.includes(id) ? "said" : "waiting";
};

/**
 * A line that can be put right where it is: a press turns it into a field
 * with its words; Enter or leaving it keeps the change and Stephen hears of
 * it; Escape lets it be.
 */
const ReadBackLine = ({
  id,
  text,
  told,
}: {
  id: string;
  text: string;
  told: keyof typeof toldLooks | null;
}) => {
  const { t } = useLingui();
  const [draft, setDraft] = useState<string | null>(null);
  // Escape lets it be, also when leaving the field follows.
  const letBe = useRef(false);
  const keep = (): void => {
    const now = draft?.trim() ?? "";
    setDraft(null);
    if (letBe.current || now === "" || now === text) {
      return;
    }
    changeLine(id, text, now);
  };
  return (
    <div className="flex items-center gap-3 py-1">
      <span className="min-w-0 flex-1">
        {draft === null ? (
          <button
            aria-label={t`Change: ${text}`}
            className="hover:bg-muted focus-visible:ring-ring/50 w-full cursor-text rounded-sm text-left outline-none focus-visible:ring-3"
            onClick={() => {
              letBe.current = false;
              setDraft(text);
            }}
            type="button"
          >
            <span className={told === null ? undefined : toldLooks[told]}>
              {text}
            </span>
          </button>
        ) : (
          <Input
            aria-label={t`Change: ${text}`}
            // The field takes the keys the moment it opens, with the cursor after its words.
            autoFocus
            maxLength={300}
            onBlur={keep}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            onFocus={(event) => {
              const { length } = event.target.value;
              event.target.setSelectionRange(length, length);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                keep();
              } else if (event.key === "Escape") {
                letBe.current = true;
                setDraft(null);
              }
            }}
            value={draft}
          />
        )}
      </span>
      <Button
        aria-label={t`Take out: ${text}`}
        onClick={() => {
          update((progress) => withFactToggled(progress, id));
        }}
        size="icon-sm"
        variant="ghost"
      >
        <XIcon />
      </Button>
    </div>
  );
};

export const ReadBack = ({ room }: { room: number }) => {
  const { t } = useLingui();
  const loop = useLoop();
  const progress = useProgress();
  const interviewer = useInterviewer();
  const who = interviewerNames[interviewer];
  const { parts, at, part } = partAt(progress);
  const { body, size } = useHead(room, headSizes.reading);
  const saidIn = useSaidIn(loop.line, loop.from);
  // What he says lights up as he says it; while he tells the lines, they light up instead.
  const said =
    loop.doing === "speaking" && loop.telling === null
      ? Math.max(loop.from, saidIn)
      : -1;
  if (part === undefined) {
    return null;
  }
  const left = part.facts.filter(({ out }) => out !== true);
  const out = part.facts.filter(({ out: taken }) => taken === true);
  const taken = plural(out.length, {
    one: "# line taken out.",
    other: "# lines taken out.",
  });
  let agree = t`Yes, that’s correct`;
  if (left.length === 0) {
    agree = t`None of this is right`;
  } else if (out.length > 0) {
    agree = t`The rest is correct`;
  }
  const n = at + 1;
  const count = parts.length;
  return (
    <div className="flex w-full max-w-xl flex-col items-center gap-6 text-center">
      <Head
        fill={1}
        label={t`${who}, reading back.`}
        sign={loop.sign}
        size={size}
        voice={voiceLevel}
        who={interviewer}
      />
      <div className="flex w-full flex-col items-center gap-5" ref={body}>
        <h1
          aria-live="polite"
          className="min-h-8 text-2xl font-medium tracking-tight text-balance"
        >
          <SpokenText said={said} text={loop.line} />
        </h1>
        {/* How much there is still to check: nobody agrees with care to pages without an end in sight. */}
        {count > 1 ? (
          <p className="text-muted-foreground text-xs">{t`Part ${n} of ${count}`}</p>
        ) : null}
        <ol className="flex w-full flex-col border-b text-left">
          {left.map(({ id, text }) => (
            <li className="animate-in fade-in border-t duration-300" key={id}>
              <ReadBackLine
                id={id}
                text={text}
                told={toldOf(loop.telling, id)}
              />
            </li>
          ))}
        </ol>
        {out.length > 0 ? (
          <p aria-live="polite" className="text-muted-foreground text-xs">
            {taken}{" "}
            <button
              className="hover:text-foreground focus-visible:ring-ring/50 rounded-sm underline underline-offset-4 outline-none focus-visible:ring-3"
              onClick={() => {
                const ids = out.map(({ id }) => id);
                update((now) => withFactsBack(now, ids));
              }}
              type="button"
            >
              {t`Put back`}
            </button>
          </p>
        ) : null}
        <div className="flex w-full flex-col items-center gap-2">
          <Button
            className={cn("w-full max-w-sm")}
            disabled={loop.doing === "idle"}
            onClick={() => {
              agreeToPart(out.length > 0 ? `${agree}.` : undefined);
            }}
            size="xl"
          >
            {agree}
          </Button>
          <p className="text-muted-foreground text-xs text-balance">{t`Press a line to change it, take out what is wrong, or type what is missing. What you leave in is what counts.`}</p>
        </div>
      </div>
    </div>
  );
};
