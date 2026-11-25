import type {
  InterviewFact,
  InterviewLine,
  InterviewProgress,
} from "@grasp-os/shared/interview-links";
import type {
  InterviewPhase,
  InterviewWants,
} from "@grasp-os/shared/interview-turn";
import { Button } from "@grasp-os/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import { Icon, WrenchIcon } from "@grasp-os/ui/lib/icons";
import { Fragment, useEffect } from "react";

import { isRefused, participate } from "./api.ts";
import { tool } from "./frame.tsx";
import { keepNow, linkNow, progressNow, update } from "./kept.ts";
import { startLoop, stopLoop } from "./loop.ts";
import { freshProgress } from "./progress.ts";

// On a local stack only (`vp run dev`): a way through the interview for
// whoever works on it, so every part can be seen without talking through
// the ones before it. A menu in the interview's header jumps to the start,
// to any phase of the conversation (with what was said before it filled
// in), to the read-back, or to the end, his thanks; the same as an
// address, `/interview?jump=steps#<secret>`, read once as the page opens.
// What it sets is kept in core as any change is, so a reload stays where
// it jumped. A build for anywhere else has none of it: Vite leaves the
// menu and everything here out. Its words are a developer's, in English,
// and not in the catalogs.

/** Where the menu jumps: the start, a phase, the read-back, or done. */
export const jumps = [
  "start",
  "you",
  "anchor",
  "story",
  "steps",
  "exceptions",
  "numbers",
  "result",
  "readback",
  "done",
] as const;
type Jump = (typeof jumps)[number];

const jumpNames: Record<Jump, string> = {
  start: "Start over (the consent screen)",
  you: "You: their role",
  anchor: "Anchor: one piece of work",
  story: "Story: the last time",
  steps: "Steps",
  exceptions: "Exceptions",
  numbers: "Numbers",
  result: "Result",
  readback: "Read-back",
  done: "Done: his thanks",
};

/** The conversation, a phase at a time: his question, and what was said. */
const said: { phase: InterviewPhase; lines: [string, string] }[] = [
  {
    phase: "open",
    lines: [
      "Hi Noor, I'm Stephen. Twenty minutes about how your work runs. Ready?",
      "Yes, let's go.",
    ],
  },
  {
    phase: "you",
    lines: [
      "What do you do at Acme, in a sentence?",
      "I run accounts payable, so every supplier invoice goes through me.",
    ],
  },
  {
    phase: "anchor",
    lines: [
      "Which piece of that takes most of your week?",
      "Matching invoices to purchase orders before they get paid.",
    ],
  },
  {
    phase: "story",
    lines: [
      "Take me to the last time you did that. Where did it start?",
      "Yesterday a PDF came into the AP inbox from our packaging supplier.",
    ],
  },
  {
    phase: "steps",
    lines: [
      "And then what did you do with it?",
      "I book it in Exact, look up the PO, and check the amounts line by line.",
    ],
  },
  {
    phase: "exceptions",
    lines: [
      "What happens when it doesn't match?",
      "I email the buyer and it waits, sometimes a week, in a spreadsheet I keep.",
    ],
  },
  {
    phase: "numbers",
    lines: [
      "How many of those come in, roughly?",
      "About 400 invoices a month, and maybe one in ten doesn't match.",
    ],
  },
  {
    phase: "result",
    lines: [
      "When is one done, for you?",
      "When it's approved and in the Friday payment run.",
    ],
  },
];

/** What he wrote down from it, in the order it was said. */
const noted: (Omit<InterviewFact, "record"> & { phase: InterviewPhase })[] = [
  {
    id: "f1",
    phase: "you",
    tag: "step",
    text: "You run accounts payable.",
  },
  {
    id: "f2",
    phase: "story",
    tag: "step",
    text: "Invoices arrive as PDFs in the AP inbox.",
  },
  {
    id: "f3",
    phase: "steps",
    tag: "system",
    text: "You book each invoice in Exact.",
  },
  {
    id: "f4",
    phase: "steps",
    tag: "step",
    text: "You check the amounts against the PO line by line.",
  },
  {
    id: "f5",
    phase: "exceptions",
    tag: "handoff",
    text: "When it doesn't match, you email the buyer.",
  },
  {
    id: "f6",
    phase: "exceptions",
    tag: "workaround",
    text: "Open mismatches wait in a spreadsheet you keep.",
  },
  {
    id: "f7",
    phase: "numbers",
    tag: "number",
    text: "About 400 invoices a month, one in ten off.",
  },
  {
    id: "f8",
    phase: "result",
    tag: "done",
    text: "Done is approved and in the Friday payment run.",
  },
];

/** Every phase before `phase`, in order. */
const phasesBefore = (phase: InterviewPhase): Set<InterviewPhase> => {
  const at = said.findIndex((part) => part.phase === phase);
  return new Set(
    (at === -1 ? said : said.slice(0, at)).map((part) => part.phase)
  );
};

/** About two minutes a phase: the countdown shows what is left of twenty. */
const minutesPerPhase = 2;

/** What he waits for at the end: the read-back read, then nothing more. */
const wantsAt: Partial<Record<Jump, InterviewWants>> = {
  readback: "readback",
  done: "end",
};

/** The interview as it stands at `jump`: what was said before it, and where it is. */
const progressAt = (
  jump: Exclude<Jump, "start">,
  was: InterviewProgress
): InterviewProgress => {
  const ended = jump === "readback" || jump === "done";
  const phase: InterviewPhase = ended ? "readback" : jump;
  const before = phasesBefore(phase);
  const lines: InterviewLine[] = said.flatMap((part) => {
    if (before.has(part.phase)) {
      return [
        { from: "stephen" as const, text: part.lines[0] },
        { from: "person" as const, text: part.lines[1] },
      ];
    }
    // The phase jumped to: his question, waiting for their answer.
    return part.phase === phase
      ? [{ from: "stephen" as const, text: part.lines[0] }]
      : [];
  });
  const facts: InterviewFact[] = noted
    .filter((fact) => before.has(fact.phase))
    .map(({ phase: _phase, ...fact }) => ({
      ...fact,
      record: fact.text,
      ...(jump === "done" ? { agreed: true as const } : {}),
    }));
  const now = Date.now();
  return {
    ...freshProgress,
    interviewer: was.interviewer,
    person: jump === "done" ? "completed" : "progress",
    told: true,
    mode: was.mode ?? "type",
    lines,
    facts,
    phase,
    wants: wantsAt[jump] ?? "answer",
    startedAt: now - before.size * minutesPerPhase * 60_000,
    seenAt: now,
    awayMs: 0,
    confirmed: jump === "done" ? facts.length : 0,
  };
};

/**
 * Jumps the interview on this link to `jump`, kept in core as any change
 * is; core is told they take part first, so what it keeps isn't refused.
 */
const jumpTo = async (jump: Jump, onJumped?: () => void): Promise<void> => {
  const link = linkNow();
  if (link === null) {
    return;
  }
  if (jump !== "start") {
    const answer = await participate(link.secret);
    if (isRefused(answer)) {
      console.warn(`Jumping in the interview: ${answer.message}`);
    }
  }
  // The conversation goes on from where it jumped, not from where it was.
  stopLoop({ keep: false });
  const was = progressNow();
  update(() =>
    jump === "start"
      ? { ...freshProgress, interviewer: was.interviewer }
      : progressAt(jump, was)
  );
  keepNow();
  onJumped?.();
  if (jump !== "start" && jump !== "done") {
    // Started again where it now stands; the page starts it too when it
    // wasn't on screen, and the second start does nothing.
    window.setTimeout(startLoop, 120);
  }
};

const isJump = (value: string | null): value is Jump =>
  jumps.some((jump) => jump === value);

/** `?jump=` in the address, once, as the page opens; taken out of it after. */
const useJumpFromAddress = (): void => {
  useEffect(() => {
    const url = new URL(window.location.href);
    const asked = url.searchParams.get("jump");
    if (!isJump(asked)) {
      return;
    }
    url.searchParams.delete("jump");
    window.history.replaceState(window.history.state, "", url);
    // The page has only just opened: nothing to put away.
    void jumpTo(asked);
  }, []);
};

const label = "Jump through the interview (local only)";

const Menu = ({ onJumped }: { onJumped: () => void }) => {
  useJumpFromAddress();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button aria-label={label} size={tool.button} variant="ghost">
          <Icon icon={WrenchIcon} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Jump to (local only)</DropdownMenuLabel>
          {jumps.map((jump) => (
            <Fragment key={jump}>
              {jump === "you" || jump === "readback" ? (
                <DropdownMenuSeparator />
              ) : null}
              <DropdownMenuItem
                onSelect={() => {
                  void jumpTo(jump, onJumped);
                }}
              >
                {jumpNames[jump]}
              </DropdownMenuItem>
            </Fragment>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** The jump menu in the interview's header: on a local stack only. */
export const DevJump = ({ onJumped }: { onJumped: () => void }) =>
  import.meta.env.DEV ? <Menu onJumped={onJumped} /> : null;
