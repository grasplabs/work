import type { KnownPart } from "@grasp-os/shared/onboarding-gate";
import { cn } from "@grasp-os/ui/lib/utils";
import { useLingui } from "@lingui/react/macro";
import { useContext, useEffect, useState, useSyncExternalStore } from "react";

import type { BrainScene } from "../brain/dot-brain.tsx";
import type { ShapeKey } from "../brain/dot-shapes.ts";
import { KnowledgeBar } from "./knowledge-bar.tsx";
import { Explained, Primary } from "./setup-parts.tsx";
import type { StepProps } from "./setup-steps.tsx";
import { readingSeconds } from "./setup.ts";

// "How this works" (prototype `About` in
// `components/onboarding/onboarding-steps.tsx`): what the onboarding is
// for, told as a story rather than read. Stephen lays out the plan a line
// at a time, each line alone in the middle, and the brain above takes a
// figure for each. After the fifth line, a taste of the interviews: he asks
// Mark, and three of the team answer; then he asks the last one how long it
// takes. Grasp has no voice here yet, so each line gets its reading time,
// as the prototype's do with the sound off. Last, the plan is summed up,
// the bar settles back to what Grasp knows now, and the way on fades in.

/**
 * What line three names, in order, and what each fills in the bar: who's
 * who (the staff list and the team leads), where the documents are, and the
 * tools.
 */
const storyConnections: KnownPart["source"][][] = [
  ["people", "leads"],
  ["sources", "documents"],
  ["tools"],
];

/** The lines that play something after them: the connections, the conversation, the gate. */
const spokesBeat = 2;
const conversationBeat = 4;
const gateBeat = 6;

/** The illustrative company the story's figures stand for: nine teams, largest first. */
const storyTeams = [42, 38, 30, 18, 14, 9, 8, 6, 5];

/** A short breath between the story's lines, and between the voices of the team. */
const breathMs = 350;

const readingMs = (line: string): number => readingSeconds(line) * 1000;

/**
 * The brain's figure for each line: Stephen laying out the plan; the two of
 * them from the first conversation; the company brain with a nerve to each
 * thing you connect; the team, as they are talked with; the plan, as a
 * folder of pages; the brain with a nerve to every team, filling in as they
 * can start. Told, it is the brain itself.
 */
const storyScene = (
  beat: number,
  fill: number,
  said: number,
  figure: ShapeKey | null
): BrainScene => {
  const shapes: ShapeKey[] = [
    { kind: "head" },
    { kind: "pair" },
    { kind: "spokes", count: storyConnections.length },
    { kind: "crowd" },
    { kind: "crowd" },
    { kind: "sheets" },
    { kind: "org", teams: storyTeams, leads: true },
    { kind: "brain" },
  ];
  const shape =
    beat === conversationBeat && figure !== null
      ? figure
      : (shapes[Math.min(beat, shapes.length - 1)] ?? { kind: "brain" });
  // Each thing fills over the words that name it, the last just before the line ends.
  const spokes = storyConnections.map((_, at) =>
    Math.min(Math.max(said * (storyConnections.length + 0.4) - at, 0), 1)
  );
  let teams: number[] | undefined;
  if (beat === spokesBeat) {
    teams = spokes;
  } else if (beat === gateBeat) {
    teams = storyTeams.map(() => said);
  } else if (beat > spokesBeat) {
    teams = storyConnections.map(() => 1);
  }
  return teams === undefined ? { shape, fill } : { shape, fill, teams };
};

/** One turn of the conversation: who, their role, what they say. */
interface Turn {
  name: string;
  role: string;
  text: string;
  /** One of the team, rather than Stephen himself. */
  team: boolean;
}

/** Where the story is. */
interface Told {
  beat: number;
  /** Where the conversation is: -1 before, its length once it is over. */
  turn: number;
  /** How far the line is said, 0 to 1. */
  progress: number;
  told: boolean;
}

/** How many of the things line three names are connected by now: one after another as it goes. */
const connectedAt = ({ beat, progress }: Told): number => {
  if (beat > spokesBeat) {
    return storyConnections.length;
  }
  if (beat < spokesBeat) {
    return 0;
  }
  return Math.min(
    storyConnections.length,
    Math.floor(progress * (storyConnections.length + 0.4))
  );
};

/** How many of the team have answered, the one speaking included. */
const spokenAt = ({ beat, turn }: Told, conversation: Turn[]): number => {
  if (beat < conversationBeat) {
    return 0;
  }
  const answered = beat > conversationBeat ? conversation.length : turn + 1;
  return conversation
    .slice(0, Math.max(answered, 0))
    .filter((each) => each.team).length;
};

/**
 * The bar as the story has it: each source dark once it has been told, the
 * talking up to where the team can start; told, what is known now.
 */
const storyBar = (
  parts: KnownPart[],
  told: Told,
  conversation: Turn[],
  threshold: number
): KnownPart[] => {
  const answers = conversation.filter((each) => each.team).length;
  const connected = connectedAt(told);
  const spoken = spokenAt(told, conversation);
  const before = parts
    .filter(
      (part) => part.source !== "conversations" && part.source !== "review"
    )
    .reduce((sum, part) => sum + part.weight, 0);
  const talkingWeight =
    parts.find((part) => part.source === "conversations")?.weight ?? 1;
  const toGate = Math.min(1, Math.max(0, (threshold - before) / talkingWeight));
  const shownOf = (part: KnownPart): number => {
    if (told.told) {
      return part.known;
    }
    if (part.source === "kickoff") {
      return told.beat >= 1 ? 1 : 0;
    }
    if (part.source === "conversations") {
      return told.beat > conversationBeat
        ? toGate
        : (toGate * Math.min(spoken, answers)) / answers;
    }
    if (part.source === "review") {
      return 0;
    }
    const at = storyConnections.findIndex((each) => each.includes(part.source));
    return at < connected ? 1 : 0;
  };
  return parts.map((part) => ({ ...part, known: shownOf(part) }));
};

const lessMotion = "(prefers-reduced-motion: reduce)";

const onMotionChange = (listener: () => void): (() => void) => {
  const media = window.matchMedia(lessMotion);
  media.addEventListener("change", listener);
  return () => {
    media.removeEventListener("change", listener);
  };
};

/**
 * The story's clock: a line at a time, each given its reading time and a
 * breath, and after the fifth line every turn of the conversation. With
 * less motion, it is told at once.
 */
const useStory = (lines: string[], conversation: Turn[]): Told => {
  const reduce = useSyncExternalStore(
    onMotionChange,
    () => window.matchMedia(lessMotion).matches,
    () => false
  );
  const beats = lines.length;
  const [beat, setBeat] = useState(0);
  const [turn, setTurn] = useState(-1);
  const [beganAt, setBeganAt] = useState(() => Date.now());
  const [now, setNow] = useState(beganAt);
  const told = reduce || beat >= beats;
  const line = lines[beat] ?? "";
  const reading = told ? 1 : readingMs(line);
  const finished = told || now - beganAt >= reading + 150;
  const turns = conversation.length;
  const saying = conversation[turn]?.text ?? "";

  // The pictures follow the clock.
  useEffect(() => {
    const id = finished
      ? undefined
      : window.setInterval(() => {
          setNow(Date.now());
        }, 100);
    return () => {
      window.clearInterval(id);
    };
  }, [finished]);

  // After "Here's what that sounds like", the conversation plays, each turn given its reading time.
  const playing =
    !told && beat === conversationBeat && finished && turn < turns;
  useEffect(() => {
    const last = turn === turns - 1 ? 2 : 1;
    const wait =
      turn < 0 ? breathMs : readingMs(saying) + 150 + last * breathMs;
    const id = playing
      ? window.setTimeout(() => {
          setTurn(turn + 1);
        }, wait)
      : undefined;
    return () => {
      window.clearTimeout(id);
    };
  }, [playing, turn, turns, saying]);

  // A breath after a line is finished, and after the team has spoken, the next one.
  const waiting = beat === conversationBeat && turn < turns;
  const next = !told && finished && !waiting;
  useEffect(() => {
    const id = next
      ? window.setTimeout(() => {
          const at = Date.now();
          setBeat(beat + 1);
          setBeganAt(at);
          setNow(at);
        }, breathMs)
      : undefined;
    return () => {
      window.clearTimeout(id);
    };
  }, [next, beat]);

  const progress = finished
    ? 1
    : Math.min(Math.max((now - beganAt - 150) / reading, 0), 1);
  return { beat: told ? beats : beat, turn, progress, told };
};

/** Whoever is speaking in the conversation, with their words. */
const Speaking = ({ turn }: { turn: Turn }) => (
  <div className="animate-in fade-in slide-in-from-bottom-2 flex flex-col items-center gap-3 duration-500">
    <span className="text-muted-foreground flex items-center gap-2">
      <span className="text-foreground">{turn.name}</span>
      {turn.role === "" ? null : (
        <>
          <span aria-hidden="true">·</span>
          {turn.role}
        </>
      )}
    </span>
    <p className="text-2xl font-medium tracking-tight text-balance">
      {turn.text}
    </p>
  </div>
);

export const About = ({ data, parts, percent, go, onStory }: StepProps) => {
  const { t } = useLingui();
  const { onExplained } = useContext(Explained);
  const { threshold } = data.gate;
  const lines = [
    t`Alright, here’s the plan.`,
    t`Our first conversation gave me the big picture. Now I need the details.`,
    t`You show me who’s who, where the documents are, and which tools people use.`,
    t`Then I talk to your team myself: short conversations, over two weeks. That’s where I learn the most.`,
    t`I do every interview myself. Here’s what that sounds like.`,
    t`From all of that, I work out where AI saves your team the most time.`,
    t`Once I have about ${threshold}% of the picture, your team can start. I’ll fill in the rest as we go.`,
  ];
  const conversation: Turn[] = [
    {
      name: "Stephen",
      role: "",
      team: false,
      text: t`Mark, where does the time go on a mortgage file?`,
    },
    {
      name: "Mark",
      role: t`Mortgage advice`,
      team: true,
      text: t`Chasing paperwork. Half of every file is waiting for payslips.`,
    },
    {
      name: "Lisa",
      role: t`Customer service`,
      team: true,
      text: t`Every morning I copy new tickets into a spreadsheet. There goes my first hour.`,
    },
    {
      name: "Tim",
      role: t`Finance`,
      team: true,
      text: t`Half my Monday goes on invoices. Most miss an order number, so I’m emailing around to ask.`,
    },
    {
      name: "Stephen",
      role: "",
      team: false,
      text: t`How long does one of those take you, Tim?`,
    },
    {
      name: "Tim",
      role: t`Finance`,
      team: true,
      text: t`Twenty minutes each, easily. About fifteen a week.`,
    },
  ];
  const story = useStory(lines, conversation);
  const { beat, turn, progress, told } = story;

  useEffect(() => {
    if (told) {
      onExplained();
    }
  }, [told, onExplained]);

  const shown = storyBar(parts, story, conversation, threshold);
  // Who is speaking in the conversation, if it is on.
  const current =
    beat === conversationBeat && turn >= 0
      ? conversation[Math.min(turn, conversation.length - 1)]
      : undefined;
  // Stephen as himself as he asks; the team, as they answer.
  let figure: "head" | "crowd" | null = null;
  if (current !== undefined) {
    figure = current.team ? "crowd" : "head";
  }
  const fill = told
    ? percent / 100
    : shown.reduce((sum, part) => sum + part.weight * part.known, 0) / 100;
  // Twenty steps a line are smooth enough for ink to fill, and few enough for the page.
  const along = Math.round(progress * 20) / 20;
  useEffect(() => {
    onStory(
      storyScene(beat, fill, along, figure === null ? null : { kind: figure })
    );
  }, [onStory, beat, fill, along, figure]);
  useEffect(
    () => () => {
      onStory(null);
    },
    [onStory]
  );

  let shownLine = (
    <div
      className="animate-in fade-in slide-in-from-bottom-2 flex w-full flex-col items-center gap-5 duration-600"
      key={beat}
    >
      <p className="text-2xl font-medium tracking-tight text-balance">
        {lines[beat]}
      </p>
    </div>
  );
  if (told) {
    shownLine = (
      <div
        className="animate-in fade-in flex flex-col gap-2 duration-800"
        key="told"
      >
        <p className="text-2xl font-medium tracking-tight">{t`Here’s the plan`}</p>
        <p className="text-muted-foreground text-balance">
          {t`Your people, documents and tools first. Then two weeks of short conversations with your team. At ${threshold}%, your team can start.`}
        </p>
      </div>
    );
  } else if (current !== undefined) {
    shownLine = <Speaking key={`turn-${turn}`} turn={current} />;
  }
  const gate = told || beat >= gateBeat;
  return (
    <>
      <h1 className="sr-only">{t`Here’s the plan`}</h1>
      <div
        aria-live="polite"
        className="flex min-h-40 w-full items-center justify-center"
      >
        {shownLine}
      </div>
      {/* The bar waits for the share where the team can start: before that, the brain shows what is told. */}
      <div
        className={cn(
          "w-full transition-opacity duration-600",
          !gate && "opacity-0"
        )}
      >
        <KnowledgeBar
          caption={told ? t`${percent}% known now` : undefined}
          gate={gate}
          parts={shown}
          threshold={threshold}
        />
      </div>
      <Primary
        onClick={() => {
          go("company");
        }}
      >
        {t`Continue`}
      </Primary>
    </>
  );
};
