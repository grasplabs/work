import type { ContextWords } from "@grasp-os/shared/onboarding-context";
import type { KnownPart } from "@grasp-os/shared/onboarding-gate";
import { cn } from "@grasp-os/ui/lib/utils";
import { useLingui } from "@lingui/react/macro";
import {
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import type { BrainScene } from "../brain/dot-brain.tsx";
import type { ShapeKey, Teammate } from "../brain/dot-shapes.ts";
import { isLocale } from "../i18n.ts";
import { SpokenText } from "../voice/spoken-text.tsx";
import {
  hold,
  say,
  stopSpeaking,
  usePrepare,
  useSaid,
  useVoice,
  voiceClock,
} from "../voice/voice.ts";
import type { Tone } from "../voice/voice.ts";
import { KnowledgeBar } from "./knowledge-bar.tsx";
import {
  Explained,
  Primary,
  Seen,
  tones,
  useEntrance,
} from "./setup-parts.tsx";
import type { StepProps } from "./setup-steps.tsx";
import { readingSeconds } from "./setup.ts";

// "How this works" (prototype `About` in
// `components/onboarding/onboarding-steps.tsx`): what the onboarding is
// for, told as a story rather than read. Stephen lays out the plan a line
// at a time, each line alone in the middle, and the brain above takes a
// figure for each. After the fifth line, a taste of the interviews: one
// conversation, about the work the kickoff named where it named any: he
// asks one of the team, who answers in their own voice, and how long it
// takes. With the sound off, each line gets the time
// it takes to say; paused, the story holds where it is. Last, the plan is
// summed up, the bar settles back to what Grasp knows now, and the way on
// fades in.

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

/** A line of the story, and how Stephen says it. */
interface Line {
  text: string;
  tone: Tone;
}

/** Who is shown while someone speaks in the conversation: Stephen as himself, one of the team from their photo. */
const figureOf = (speaker: Teammate | "stephen" | null): ShapeKey | null => {
  if (speaker === null) {
    return null;
  }
  return speaker === "stephen"
    ? { kind: "head" }
    : { kind: "person", who: speaker };
};

/** One turn of the conversation: who, their role, what they say, and how. */
interface Turn {
  name: string;
  role: string;
  text: string;
  tone: Tone;
  /** One of the team, in their own voice and drawn from their photo; none for Stephen himself. */
  who?: Teammate;
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
    .filter((each) => each.who !== undefined).length;
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
  const answers = conversation.filter((each) => each.who !== undefined).length;
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

/** A line comes in on its own first, and is said a moment after, in ms. */
const lineDelayMs = 150;

/** What the story says, as it is now: in the language the page is in now. */
interface Script {
  lines: Line[];
  conversation: Turn[];
}

/** What the story tells the page as it goes. */
interface Telling {
  line: (beat: number) => void;
  said: () => void;
  turn: (turn: number) => void;
  told: () => void;
}

/** The story as it is now, and whether the step was left: read afresh at every turn. */
interface Teller {
  now: () => { script: Script; on: Telling };
  left: () => boolean;
}

/**
 * Plays the conversation from `turn` on, each a breath after the one
 * before, in the voice of who says it; false once the step is left.
 */
const playFrom = async (teller: Teller, turn: number): Promise<boolean> => {
  const each = teller.now().script.conversation[turn];
  await hold(each === undefined ? breathMs * 2 : breathMs);
  if (teller.left()) {
    return false;
  }
  teller.now().on.turn(turn);
  if (each === undefined) {
    return true;
  }
  await say(each.text, { speaker: each.who, tone: each.tone });
  return !teller.left() && (await playFrom(teller, turn + 1));
};

/** Tells the story from line `beat` on, until it is told or the step is left. */
const tellFrom = async (teller: Teller, beat: number): Promise<void> => {
  if (beat >= teller.now().script.lines.length) {
    teller.now().on.told();
    return;
  }
  teller.now().on.line(beat);
  await hold(lineDelayMs);
  const line = teller.now().script.lines[beat];
  if (teller.left() || line === undefined) {
    return;
  }
  await say(line.text, { tone: line.tone });
  if (teller.left()) {
    return;
  }
  teller.now().on.said();
  if (beat === conversationBeat && !(await playFrom(teller, 0))) {
    return;
  }
  await hold(breathMs);
  if (!teller.left()) {
    await tellFrom(teller, beat + 1);
  }
};

/**
 * Plays the story: each line said, a breath after the one before, and
 * after the fifth line each turn of the conversation, in the voice of who
 * says it. With the sound off, `say` gives each its time to say instead;
 * paused, `say` and `hold` stand still, and so does the story. A change of
 * language goes on where it is, with the words of the new one. Leaving,
 * the voices stop with it.
 */
const useTelling = (script: Script, reduce: boolean, on: Telling): void => {
  const latest = useRef({ script, on });
  useEffect(() => {
    latest.current = { script, on };
  });
  useEffect(() => {
    let left = false;
    if (!reduce) {
      void tellFrom({ now: () => latest.current, left: () => left }, 0);
    }
    return () => {
      left = true;
      stopSpeaking();
    };
  }, [reduce]);
};

/** A line the story says, fetched as the story opens, so nothing waits on the voice later; again in another language. */
const Prepared = ({
  text,
  tone,
  who,
}: {
  text: string;
  tone: Tone;
  who?: Teammate;
}) => {
  usePrepare(text, { tone, speaker: who });
  return null;
};

/**
 * The story's clock: a line at a time, said by Stephen, and after the
 * fifth line every turn of the conversation, in the team's own voices.
 * How far a line is comes from his voice as he says it; with the sound
 * off, from the time it takes to say. With less motion, or coming back to
 * it once it was told, it is told at once.
 */
const useStory = (script: Script): Told => {
  const lessMotionWanted = useSyncExternalStore(
    onMotionChange,
    () => window.matchMedia(lessMotion).matches,
    () => false
  );
  const seen = useContext(Seen);
  const reduce = lessMotionWanted || seen;
  const voice = useVoice();
  const beats = script.lines.length;
  const [beat, setBeat] = useState(0);
  const [turn, setTurn] = useState(-1);
  const [finished, setFinished] = useState(false);
  const [beganAt, setBeganAt] = useState(voiceClock);
  const [now, setNow] = useState(beganAt);
  const told = reduce || beat >= beats;
  const line = told ? "" : (script.lines[beat]?.text ?? "");
  const said = useSaid(line);
  const saying = voice.line?.text === line;

  useTelling(script, reduce, {
    line: (at) => {
      const start = voiceClock();
      setBeat(at);
      setFinished(false);
      setBeganAt(start);
      setNow(start);
    },
    said: () => {
      setFinished(true);
    },
    turn: setTurn,
    told: () => {
      setBeat(beats);
    },
  });

  // With the sound off, the pictures follow the voice's clock, which a pause holds.
  const ticking = !told && !finished && !voice.on;
  useEffect(() => {
    const id = ticking
      ? window.setInterval(() => {
          setNow(voiceClock());
        }, 100)
      : undefined;
    return () => {
      window.clearInterval(id);
    };
  }, [ticking]);

  let progress = 0;
  if (told || finished) {
    progress = 1;
  } else if (saying) {
    progress = Math.max(said, 0) / Math.max(line.length, 1);
  } else if (!voice.on) {
    progress = Math.min(
      Math.max((now - beganAt - lineDelayMs / 1000) / readingSeconds(line), 0),
      1
    );
  }
  return { beat: told ? beats : beat, turn, progress, told };
};

/** Whoever is speaking in the conversation, their words lighting up as they say them. */
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
    <p className="type-title">
      <SpokenText from={0} line={turn.text} text={turn.text} />
    </p>
  </div>
);

/**
 * The taste of an interview: one of the team, asked by Stephen where the
 * time goes, answers in their own voice, short and quick, as said on a
 * call rather than read out; and Stephen asks how long it takes, as he
 * does on every call, so the hours can be worked out. About the work the
 * kickoff named, where it named any, in the company's own words; else
 * Tim's invoices, which every company has.
 */
const useConversation = (words: ContextWords | undefined): Turn[] => {
  const { t } = useLingui();
  const example = words?.example ?? null;
  const name = "Tim";
  const who: Teammate = "tim";
  const asking = { name: "Stephen", role: "" };
  if (example !== null) {
    return [
      {
        ...asking,
        tone: "interested, a little lighter",
        text: example.question,
      },
      {
        name,
        role: example.role,
        who,
        tone: "easy, light",
        text: example.answer,
      },
      {
        ...asking,
        tone: "curious, gently",
        text: t`How long does that take you, ${name}?`,
      },
      {
        name,
        role: example.role,
        who,
        tone: "easy, light",
        text: example.time,
      },
    ];
  }
  const role = t`Finance`;
  return [
    {
      ...asking,
      tone: "interested, a little lighter",
      text: t`${name}, where does the time go in your week?`,
    },
    {
      name,
      role,
      who,
      tone: "easy, light",
      text: t`Half my Monday goes on invoices. Most miss an order number, so I’m emailing around to ask.`,
    },
    {
      ...asking,
      tone: "curious, gently",
      text: t`How long does one of those take you, ${name}?`,
    },
    {
      name,
      role,
      who,
      tone: "easy, light",
      text: t`Twenty minutes each, easily. About fifteen a week.`,
    },
  ];
};

/** What the story says: seven lines, and the conversation after the fifth. */
const useScript = (data: StepProps["data"]): Script => {
  const { t, i18n } = useLingui();
  const words =
    data.view.context.words[isLocale(i18n.locale) ? i18n.locale : "en"];
  const conversation = useConversation(words);
  const { threshold } = data.gate;
  const { sponsor } = data.view;
  const { even } = tones;
  return {
    lines: [
      { text: t`Alright, here’s the plan.`, tone: even },
      {
        // The sponsor by name, when the kickoff gave one.
        text:
          sponsor === null
            ? t`Our first conversation gave me the big picture. Now I need the details.`
            : t`${sponsor} gave me the big picture. Now I need the details.`,
        tone: even,
      },
      {
        text: t`You show me who’s who, where the documents are, and which tools people use.`,
        tone: even,
      },
      {
        text: t`Then I talk to your team myself: short conversations, over two weeks. That’s where I learn the most.`,
        tone: even,
      },
      {
        text: t`I do every interview myself. Here’s what that sounds like.`,
        tone: even,
      },
      {
        text: t`From all of that, I work out where AI saves your team the most time.`,
        tone: even,
      },
      {
        text: t`Once I have about ${threshold}% of the picture, your team can start. I’ll fill in the rest as we go.`,
        tone: even,
      },
    ],
    conversation,
  };
};

/**
 * "How this works", told rather than read: Stephen says the plan a line
 * at a time, each alone in the middle with its words lighting up as he
 * says them, and the brain above takes a figure for each. After the fifth
 * line, a sample interview: Stephen asks, shown as himself, and one of
 * the team answers in their own voice, drawn in dots from their photo.
 * Last, the plan is summed up, the bar settles back to what is known now,
 * and the way on fades in.
 */
export const About = ({ data, parts, percent, go, onStory }: StepProps) => {
  const { t } = useLingui();
  const { onExplained } = useContext(Explained);
  const { threshold } = data.gate;
  const script = useScript(data);
  const { lines, conversation } = script;
  const story = useStory(script);
  const seen = useContext(Seen);
  const { beat, turn, progress, told } = story;

  useEffect(() => {
    if (told) {
      onExplained();
    }
  }, [told, onExplained]);

  const shown = storyBar(parts, story, conversation, threshold);
  // Who is speaking in the conversation, if it is on: the last to speak stays until the next line takes over.
  const current =
    beat === conversationBeat && turn >= 0
      ? conversation[Math.min(turn, conversation.length - 1)]
      : undefined;
  // Stephen as himself as he asks; the one of the team who answers, from their photo.
  let speaker: Teammate | "stephen" | null = null;
  if (current !== undefined) {
    speaker = current.who ?? "stephen";
  }
  const fill = told
    ? percent / 100
    : shown.reduce((sum, part) => sum + part.weight * part.known, 0) / 100;
  // Twenty steps a line are smooth enough for ink to fill, and few enough for the page.
  const along = Math.round(progress * 20) / 20;
  useEffect(() => {
    onStory(storyScene(beat, fill, along, figureOf(speaker)));
  }, [onStory, beat, fill, along, speaker]);
  useEffect(
    () => () => {
      onStory(null);
    },
    [onStory]
  );

  const line = lines[beat]?.text ?? "";
  // Told before, the plan is there summed up at once.
  const toldEntrance = useEntrance(
    told ? "told" : "",
    "animate-in fade-in duration-800"
  );
  let shownLine = (
    <div
      className="animate-in fade-in slide-in-from-bottom-2 flex w-full flex-col items-center gap-5 duration-600"
      key={beat}
    >
      <p className="type-title">
        <SpokenText from={0} line={line} text={line} />
      </p>
    </div>
  );
  if (told) {
    shownLine = (
      <div className={cn("flex flex-col gap-2", toldEntrance)} key="told">
        <p className="type-title">{t`Here’s the plan`}</p>
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
      {/* Told before, nothing of it is said again, so nothing is fetched. */}
      {seen
        ? null
        : [...lines, ...conversation].map((each) => (
            <Prepared key={each.text} {...each} />
          ))}
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
