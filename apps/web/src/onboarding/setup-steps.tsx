import type { OAuthProvider } from "@grasp-os/shared/connect";
import {
  minTalkedShown,
  onboardingPeopleMax,
  onboardingTeamsMax,
  planDays,
} from "@grasp-os/shared/onboarding";
import type {
  InterviewLocale,
  OnboardingView,
  Roster,
  RosterInput,
  TeamProgress,
} from "@grasp-os/shared/onboarding";
import type { SetupChoices } from "@grasp-os/shared/onboarding-choices";
import { documentErrors } from "@grasp-os/shared/onboarding-documents";
import type { OnboardingDocument } from "@grasp-os/shared/onboarding-documents";
import type { GateView, KnownPart } from "@grasp-os/shared/onboarding-gate";
import type { Identity } from "@grasp-os/shared/rpc";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@grasp-os/ui/components/alert";
import { Button } from "@grasp-os/ui/components/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@grasp-os/ui/components/popover";
import { Progress } from "@grasp-os/ui/components/progress";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { Switch } from "@grasp-os/ui/components/switch";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { cn } from "@grasp-os/ui/lib/utils";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import {
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  InfoIcon,
  PenLineIcon,
  UploadIcon,
} from "lucide-react";
import { useContext, useEffect, useRef, useState } from "react";
import type { ComponentType } from "react";

import type { BrainScene } from "../brain/dot-brain.tsx";
import { CoreTimeoutError } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDate, formatList } from "../format.ts";
import { isLocale, localeNames } from "../i18n.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { speak, usePrepare, useSaid } from "../voice/voice.ts";
import { About } from "./about-story.tsx";
import {
  HrPlatform,
  Pulse as PulseStep,
  Sources as SourcesStep,
} from "./connect-steps.tsx";
import { DocumentDrop } from "./document-drop.tsx";
import type { DocumentRow } from "./document-drop.tsx";
import { LanguageChoice } from "./language-choice.tsx";
import { MailItem } from "./review-parts.tsx";
import { SendPlanForm, useSendWords } from "./send-plan-form.tsx";
import {
  choiceHolds,
  choiceOfPlan,
  firstChoice,
  replanOf,
} from "./send-plan.ts";
import {
  Asides,
  Callout,
  copyText,
  Cramped,
  evenVoice,
  Explained,
  Figure,
  Heading,
  Later,
  LaterLink,
  MoreAbout,
  Onward,
  Primary,
  stepLine,
  SupportLink,
  tones,
} from "./setup-parts.tsx";
import type { Answer, StepVoice } from "./setup-parts.tsx";
import {
  closesOn,
  openItems,
  stepIndex,
  steps,
  teamNumbersOf,
} from "./setup.ts";
import type { Listening, ReviewItemId, SetupStep } from "./setup.ts";
import {
  csvRows,
  exampleList,
  StaffListError,
  staffListOf,
  withSaved,
} from "./staff-list.ts";
import { XlsxError, xlsxMost, xlsxRows } from "./xlsx.ts";

// One screen of the client onboarding, by step (prototype
// `components/onboarding/onboarding-steps.tsx`, the steps of a real
// organization: `RealCompany`, `ConfirmOrg`, `RealTeam`, `RealListening`,
// `RealPulse`, `RealOpen`, and the others where nothing is different). What
// a step keeps goes to core: who works where, who leads which team and
// which teams take part, the documents and the answers to their questions,
// what the admin chose about what Grasp may connect (connect-steps.tsx),
// and when the interviews run. What needs the admin settled, this browser
// keeps.

/** What the onboarding reads from core, and who is going through it. */
export interface SetupData {
  /** The admin's first name. */
  admin: string;
  view: OnboardingView;
  documents: OnboardingDocument[];
  gate: GateView;
  /** Grasp's sending domain, which the admin lets through their mail filter. */
  sendingDomain: string;
  /** What the admin chose about what Grasp may connect. */
  choices: SetupChoices;
  /** The suites the company signs in with. */
  signIn: OAuthProvider[];
  identity: Identity;
}

export interface StepProps {
  data: SetupData;
  listening: Listening;
  percent: number;
  /** What Grasp knows, source by source. */
  parts: KnownPart[];
  /** Today, as an ISO date. */
  today: string;
  /** The message to the team, as the admin left it; null for the one drafted. */
  message: string | null;
  onMessage: (message: string) => void;
  /** What the admin settled of what needs them. */
  settled: ReviewItemId[];
  onSettle: (item: ReviewItemId, settled: boolean) => void;
  go: (step: SetupStep) => void;
  /** "How this works" tells its story in the brain's figures: this sets the figure, or gives it back with null. */
  onStory: (scene: BrainScene | null) => void;
}

const firstName = (name: string): string => name.split(" ")[0] ?? name;

/** A date as the page's language writes it, from an ISO day. */
const formatDay = (day: string): string => formatDate(`${day}T12:00:00Z`);

/** Hands the reader a CSV file to save, made in the browser. */
const downloadCsv = (content: string, filename: string): void => {
  const url = URL.createObjectURL(
    new Blob([content], { type: "text/csv;charset=utf-8" })
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
};

/** What the steps that connect read, from a step's props (connect-steps.tsx). */
const connectProps = ({ data, go }: StepProps) => ({
  choices: data.choices,
  signIn: data.signIn,
  identity: data.identity,
  go,
});

/** Reads core again after a change, so every step shows what core now has. */
const useRefresh = (): (() => Promise<void>) => {
  const router = useRouter();
  return async () => {
    await router.invalidate();
  };
};

/** The tools the documents named, each once, in the order they came. */
const toolsIn = (documents: OnboardingDocument[]): string[] => [
  ...new Set(documents.flatMap((each) => each.reading.tools)),
];

/** What Stephen says as a step arrives, and how; even, unless it says otherwise. */
interface Headline {
  title: string;
  sentence: string;
  voice?: StepVoice;
}

/**
 * What each step says as it arrives, in one place: so the step before can
 * fetch its voice ahead, and he starts the moment you arrive. "How this
 * works" tells a story of its own instead (about-story.tsx).
 */
const useHeadlines = ({
  data,
  settled,
}: Pick<StepProps, "data" | "settled">): Record<
  Exclude<SetupStep, "about">,
  Headline
> & { hr: Headline } => {
  const { t } = useLingui();
  const { admin } = data;
  const { sponsor } = data.view;
  const named = toolsIn(data.documents).slice(0, 4);
  const tools = formatList(named);
  const { progress } = data.view;
  const talked = (progress?.talked ?? 0) + (progress?.leadsTalked ?? 0);
  const openCount = openItems(settled).length;
  // Before the organization, the leads step asks for the HR platform, until the admin said which.
  const hr: Headline = {
    title: t`Which HR platform do you use?`,
    sentence: t`It knows who leads which team, so I can talk to the leads first. We connect it with you.`,
  };
  const organization: Headline = {
    title: t`Almost done: is this your organization?`,
    sentence: t`I talk to each team lead first, so they hear about me before their team does. Check who leads which team, and which teams take part.`,
  };
  return {
    hr,
    welcome: {
      title: t`Hi ${admin}, I’m Stephen`,
      // The sponsor by name, only when the kickoff gave one.
      sentence:
        sponsor === null
          ? t`Before we start, which language do you prefer?`
          : t`${sponsor} told me a lot about your company in our first conversation. Before we start, which language do you prefer?`,
      voice: { tone: tones.warm },
    },
    company: {
      title: t`Who’s who at your company?`,
      sentence: t`A staff list is the quickest way in: names, email addresses, teams and jobs, as a CSV or Excel file. I only use it to know who to talk to.`,
    },
    sources: {
      title: t`Where does the work get written down?`,
      sentence: t`Procedures, handbooks, how-tos. Connect where they live, and I’ll only read what you share with me.`,
    },
    documents: {
      title: t`Do you have anything that explains how you work?`,
      sentence: t`Policies, procedures, work instructions. Share whatever you have. Drafts are fine too.`,
    },
    pulse: {
      title: t`Which tools do people actually use?`,
      sentence: [
        named.length > 0 ? t`In your documents I saw ${tools}.` : "",
        t`Most people can’t name every tool they use, so a small app on the work laptops tells me. We set it up with you or your IT, or you skip it for now.`,
      ]
        .join(" ")
        .trim(),
    },
    leads: data.choices.hr === null ? hr : organization,
    team: {
      title: t`Before I reach out, let your team know`,
      sentence: t`People respond better when they know why I’m reaching out. I’ve drafted a message you can send yourself. Then pick the day the interviews start.`,
    },
    listening: {
      title: t`That’s everything from you. Now I’ll talk to your team.`,
      sentence: t`You can close this page now. Come back here to see how far I am.`,
      voice: { tone: tones.warm },
    },
    review: {
      title: plural(openCount, {
        0: "Nothing needs you",
        1: "Just one thing for you",
        other: "# things for you",
      }),
      sentence: t`I’ve handled everything else.`,
      voice: { tone: tones.even, quick: true },
    },
    open: {
      title: t`Thank you, ${admin}`,
      sentence: plural(talked, {
        one: "I talked with # person.",
        other: "I talked with # people.",
      }),
      voice: { tone: tones.glad, quick: true },
    },
  };
};

const sentenceEnd = /(?<=[.?!…])\s+/u;

/**
 * Whether Stephen has asked which language yet: as he starts the last
 * sentence of his greeting, or once the step is explained, as with the
 * sound off; or at once, when a language was `picked` already. Asked, the
 * languages come in, and stay.
 */
const useAsked = ({ title, sentence }: Headline, picked: boolean): boolean => {
  const { line } = stepLine(title, sentence);
  const question = line.lastIndexOf(sentence.split(sentenceEnd).at(-1) ?? "");
  const said = useSaid(line);
  const { explained } = useContext(Explained);
  const [asked, setAsked] = useState(picked);
  if (!asked && (explained || said >= question)) {
    setAsked(true);
  }
  return asked;
};

/** A language other than the page's was picked on the welcome a moment ago: the welcome drawn anew in it knows. */
let languagePicked = false;

/** About how long the steps take, for the welcome to say so. */
const onboardingMinutes = 8;

const Welcome = (props: StepProps) => {
  const { t } = useLingui();
  const lines = useHeadlines(props).welcome;
  const { i18n } = useLingui();
  // A language is chosen before anything else, every time: none is marked
  // until you pick one, unless the page was just drawn anew for it.
  const [picked, setPicked] = useState(() => languagePicked);
  useEffect(() => {
    languagePicked = false;
  }, []);
  const chosen = localeNames[isLocale(i18n.locale) ? i18n.locale : "en"];
  const minutes = onboardingMinutes;
  const asked = useAsked(lines, picked);
  return (
    <>
      {/* The question is the end of what Stephen says, not a line after it; answered, he says so in the new language. */}
      <Heading
        answer={
          picked
            ? {
                text: t`${chosen} it is. This takes about ${minutes} minutes. Ready to start?`,
                cut: true,
              }
            : undefined
        }
        sentence={lines.sentence}
        title={lines.title}
        voice={lines.voice}
      />
      <div
        className={cn(
          "transition-all duration-700 ease-out",
          !asked && "-translate-y-2 opacity-0"
        )}
        inert={!asked}
      >
        <LanguageChoice
          onPick={(locale) => {
            setPicked(true);
            // Another language draws the whole page anew (main.tsx), this welcome with it.
            languagePicked = locale !== i18n.locale;
          }}
          picked={picked}
        />
      </div>
      <Primary
        onClick={() => {
          props.go("about");
        }}
        ready={picked}
      >
        {t`Let’s start`}
      </Primary>
    </>
  );
};

const xlsxName = /\.xlsx$/iu;

/**
 * Who works where, from a staff list file, with what the admin set on the
 * one saved before kept; or why it could not be read. A file larger than
 * a workbook may be is refused before it is read, a CSV file too.
 */
const readStaffList = async (
  file: File,
  noTeam: string,
  saved: Roster | null
): Promise<RosterInput | "headings" | "empty" | "large" | "unreadable"> => {
  if (file.size > xlsxMost.bytes) {
    return "large";
  }
  try {
    const rows = xlsxName.test(file.name)
      ? await xlsxRows(await file.arrayBuffer())
      : csvRows(await file.text());
    return withSaved(staffListOf(rows, noTeam).roster, saved);
  } catch (error) {
    if (error instanceof StaffListError || error instanceof XlsxError) {
      return error.reason;
    }
    return "unreadable";
  }
};

/** Shares a document with core, which reads it at once; or why it could not be. */
const shareDocument = async (
  core: ReturnType<typeof useCore>,
  file: File,
  locale: InterviewLocale
): Promise<
  { shared: true; kept: OnboardingDocument } | { shared: false; error: unknown }
> => {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const kept = await core.withSession(
      async (session) =>
        await session.onboarding.shareDocument({
          locale,
          name: file.name,
          bytes,
        })
    );
    return { shared: true, kept };
  } catch (error) {
    return { shared: false, error };
  }
};

/**
 * Who works there, from a staff list the admin shares: a CSV or Excel file
 * with a row per person. It is read in this browser; only names, email
 * addresses, teams and jobs are kept, in core.
 */
const Company = (props: StepProps) => {
  const { t } = useLingui();
  const lines = useHeadlines(props).company;
  const { run } = useCoreAction();
  const refresh = useRefresh();
  const [reading, setReading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Read on this visit: then Stephen says so, even when a list was there as the step arrived.
  const [fresh, setFresh] = useState(false);
  const list = useRef<HTMLInputElement>(null);
  const { roster } = props.data.view;
  const people = roster?.people.length ?? 0;
  const teams = roster?.teams.length ?? 0;
  const noTeam = t({
    message: "Other",
    context: "the team for people a staff list gives no team",
  });
  const read = async (file: File) => {
    setReading(true);
    setProblem(null);
    const found = await readStaffList(file, noTeam, roster);
    if (typeof found === "string") {
      const why = found;
      const peopleMost = onboardingPeopleMax;
      const teamsMost = onboardingTeamsMax;
      if (why === "headings") {
        setProblem(
          t`I could not find the columns. The first row should name them: name, email, team and job.`
        );
      } else if (why === "empty") {
        setProblem(t`There is nobody in this list.`);
      } else if (why === "large") {
        setProblem(
          t`This list is too large. I can take up to ${peopleMost} people in up to ${teamsMost} teams.`
        );
      } else {
        setProblem(
          t`I could not read this file. A CSV or an Excel file works.`
        );
      }
    }
    if (typeof found !== "string") {
      const saved = await run(
        async (session) => await session.onboarding.saveRoster(found),
        () => {
          setProblem(t`I could not keep it. Try again in a moment.`);
        }
      );
      if (saved !== undefined) {
        await refresh();
        setFresh(true);
      }
    }
    setReading(false);
  };
  // Said plainly, and quick: the counts are only known as he says them.
  let answer: Answer | undefined;
  if (problem !== null) {
    answer = { text: problem, announce: true, tone: tones.plain, quick: true };
  } else if (roster !== null) {
    answer = {
      text: t`Thank you. From your staff list I can see ${people} people in ${teams} teams.`,
      announce: fresh,
      tone: tones.plain,
      quick: true,
    };
  }
  return (
    <>
      <Heading
        answer={answer}
        sentence={lines.sentence}
        title={lines.title}
        voice={lines.voice}
      />
      {roster === null ? (
        <Onward>
          <Button
            className="w-full max-w-sm"
            disabled={reading}
            onClick={() => {
              list.current?.click();
            }}
            size="xl"
          >
            {reading ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <UploadIcon data-icon="inline-start" />
            )}
            {reading ? t`Reading your staff list` : t`Choose your staff list`}
          </Button>
          <p className="text-muted-foreground text-balance">
            {t`From your HR or payroll system. Microsoft 365 or Google can be connected later, with us.`}{" "}
            <button
              className="hover:text-foreground focus-visible:ring-ring/50 rounded-sm underline underline-offset-4 outline-none focus-visible:ring-3"
              onClick={() => {
                downloadCsv(exampleList, "staff-list-example.csv");
              }}
              type="button"
            >
              {t`See an example`}
            </button>
          </p>
          <MoreAbout page="staffList">{t`More about the staff list`}</MoreAbout>
        </Onward>
      ) : (
        <>
          <Primary
            onClick={() => {
              props.go("sources");
            }}
          >
            {t`Continue`}
          </Primary>
          <Asides>
            <LaterLink
              onClick={() => {
                list.current?.click();
              }}
            >
              {t`Use another list`}
            </LaterLink>
            <SupportLink page="staffList">{t`More about the staff list`}</SupportLink>
          </Asides>
        </>
      )}
      <input
        accept=".csv,.tsv,.txt,.xlsx"
        aria-hidden="true"
        aria-label={t`Choose your staff list`}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file !== undefined) {
            void read(file);
          }
          event.target.value = "";
        }}
        ref={list}
        tabIndex={-1}
        type="file"
      />
    </>
  );
};

/** Where the documents live (connect-steps.tsx). */
const Sources = (props: StepProps) => (
  <SourcesStep {...connectProps(props)} lines={useHeadlines(props).sources} />
);

/** About how long reading a document takes, in milliseconds, for its bar to fill at; a bigger one longer. */
const readMs = 4500;
const readStaggerMs = 450;

/** A document being read, or refused, on this visit. */
interface Pending extends DocumentRow {
  file: File;
}

/** Why core could not read a document, as its row says it. */
const useProblemOf = (): ((error: unknown) => string) => {
  const { t } = useLingui();
  return (error) => {
    if (error instanceof CoreTimeoutError) {
      return t`Not read: no connection`;
    }
    const code = documentErrors.codeOf(error);
    if (code === "document.too_large") {
      return t`Too large to read`;
    }
    if (code === "document.old_format" || code === "document.slides") {
      return t`An old format: save it as PDF or a newer file`;
    }
    if (
      code === "document.unsupported" ||
      code === "document.empty" ||
      code === "document.too_complex"
    ) {
      return t`I couldn’t read this one`;
    }
    return t`Not read: add it again`;
  };
};

/** A document's question as Stephen asks it: with what the document is about. */
const questionLine = ({ reading: { about, ask } }: OnboardingDocument) =>
  `${about} ${ask?.question ?? ""}`.trim();

/** What Stephen says when core could not read a document: an old format has a way out of its own. */
const useSaidProblemOf = (): ((name: string, error: unknown) => string) => {
  const { t } = useLingui();
  return (name, error) =>
    documentErrors.codeOf(error) === "document.old_format"
      ? t`I can’t read ${name}: it’s in an old format. As a PDF or a newer file, I can.`
      : t`I couldn’t read ${name}. Add it again, or as a PDF.`;
};

/**
 * Documents that explain how they work. Each is read the moment it is
 * dropped, for real, by core: Stephen thanks them at the drop, then says
 * what he took from the first one, and every row says what it is about.
 * Only what nobody but the one who shared it can say, he asks at once,
 * with the answers to pick from. Such a question comes with what its
 * document is about, so then he sums up nothing else first; and one
 * answered on screen before he gets to it, he does not ask.
 */
const Documents = (props: StepProps) => {
  const { t, i18n } = useLingui();
  const lines = useHeadlines(props).documents;
  const core = useCore();
  const refresh = useRefresh();
  const { run, busy, failure } = useCoreAction();
  const problemOf = useProblemOf();
  const saidProblemOf = useSaidProblemOf();
  const [pending, setPending] = useState<Pending[]>([]);
  const [fresh, setFresh] = useState(false);
  // Whether the step is still on screen: a reading that ends after it is left is kept, but not said.
  const here = useRef(true);
  useEffect(() => {
    here.current = true;
    return () => {
      here.current = false;
    };
  }, []);
  // How many documents he has told about on this visit: the first he sums up out loud, the rest say it in their rows.
  const told = useRef(0);
  // His questions about documents read on this visit, by document, until they are answered.
  const asking = useRef(new Set<string>());
  const kept = props.data.documents;
  const locale: InterviewLocale = isLocale(i18n.locale) ? i18n.locale : "en";
  // His thanks and his "Got it." are fetched as the step opens, so each follows what was done without a pause.
  const thanks = t`Thank you. I’m reading them now, and you can add more at any time.`;
  const gotIt = t`Got it.`;
  usePrepare(thanks, { tone: tones.warm });
  usePrepare(gotIt, { tone: tones.plain });
  const tell = (read: OnboardingDocument) => {
    const { about, ask } = read.reading;
    // A question only they can answer is always asked, with what its document is about, unless it was answered by then; otherwise only the first is summed up, and not while a question waits to be asked.
    if (ask !== null && read.answer === null) {
      asking.current.add(read.id);
      speak(questionLine(read), {
        after: true,
        still: () => here.current && asking.current.has(read.id),
        tone: tones.even,
        quick: true,
      });
    } else if (told.current === 0) {
      speak(about, {
        after: true,
        still: () => here.current && asking.current.size === 0,
        tone: tones.even,
        quick: true,
      });
    }
    told.current += 1;
  };
  // Core keeps two documents of the same name as two: each row is its own upload, by an id of its own.
  const take = (files: File[]) => {
    const added = files.map((file, at): Pending => ({
      key: crypto.randomUUID(),
      name: file.name,
      size: file.size,
      state: "reading",
      startedAt: Date.now(),
      ms: readMs + at * readStaggerMs + Math.min(6000, file.size / 400),
      file,
    }));
    if (added.length === 0) {
      return;
    }
    setPending((now) => [...now, ...added]);
    // He answers the drop itself, as he starts reading.
    setFresh(true);
    for (const each of added) {
      void (async () => {
        const result = await shareDocument(core, each.file, locale);
        if (result.shared) {
          await refresh();
          setPending((now) => now.filter((row) => row.key !== each.key));
          if (here.current) {
            tell(result.kept);
          }
          return;
        }
        const problem = problemOf(result.error);
        setPending((now) =>
          now.map((row) =>
            row.key === each.key ? { ...row, state: "failed", problem } : row
          )
        );
        speak(saidProblemOf(each.name, result.error), {
          after: true,
          still: () => here.current,
          tone: tones.plain,
          quick: true,
        });
      })();
    }
  };
  // His one question about a document, while it waits for an answer: answered with a press. The first shared is asked first (core lists the newest first).
  const open = kept.findLast(
    (each) => each.reading.ask !== null && each.answer === null
  );
  const answer = async (option: string) => {
    if (open === undefined) {
      return;
    }
    asking.current.delete(open.id);
    const saved = await run(
      async (session) =>
        await session.onboarding.answerDocument(open.id, option)
    );
    if (saved !== undefined) {
      // His answer cuts what waited to be said: a question still open comes with it.
      const next = kept.findLast(
        (each) => each.id !== open.id && asking.current.has(each.id)
      );
      if (next === undefined) {
        speak(gotIt, { soon: true, tone: tones.plain });
      } else {
        speak(`${gotIt} ${questionLine(next)}`, {
          soon: true,
          tone: tones.even,
          quick: true,
        });
      }
      await refresh();
    }
  };
  const reading = pending.filter((each) => each.state === "reading");
  const count = kept.length;
  const rows: DocumentRow[] = [
    ...kept.map((each): DocumentRow => ({
      key: each.id,
      name: each.name,
      size: null,
      state: "read",
      about: each.reading.about,
    })),
    ...pending,
  ];
  const ask = open?.reading.ask ?? null;
  return (
    <>
      <Heading
        answer={
          fresh && count + reading.length > 0
            ? { text: thanks, tone: tones.warm }
            : undefined
        }
        sentence={lines.sentence}
        title={lines.title}
        voice={lines.voice}
      />
      <Onward>
        <DocumentDrop
          onAdd={take}
          onRemove={(row) => {
            setPending((now) => now.filter((each) => each.key !== row.key));
          }}
          rows={rows}
        />
        {open === undefined || ask === null ? null : (
          <div
            className="animate-in fade-in slide-in-from-bottom-1 flex flex-col items-center gap-2 duration-300"
            key={open.id}
          >
            <p className="text-balance">
              {ask.question}{" "}
              <span className="text-muted-foreground">{open.name}</span>
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {ask.options.map((option) => (
                <Button
                  disabled={busy}
                  key={option}
                  onClick={() => {
                    void answer(option);
                  }}
                  size="sm"
                  variant="outline"
                >
                  {option}
                </Button>
              ))}
            </div>
            <ErrorText>{failure}</ErrorText>
          </div>
        )}
        <p className="text-muted-foreground text-xs">{t`Leave out personnel files and anything about one person.`}</p>
      </Onward>
      <Primary
        disabled={reading.length > 0}
        onClick={() => {
          props.go("pulse");
        }}
        ready={count > 0}
      >
        {t`Continue`}
      </Primary>
      {count === 0 && reading.length === 0 ? (
        <Later
          onClick={() => {
            props.go("pulse");
          }}
        >
          {t`Skip for now`}
        </Later>
      ) : null}
    </>
  );
};

/** Pulse on the work laptops (connect-steps.tsx). */
const Pulse = (props: StepProps) => (
  <PulseStep {...connectProps(props)} lines={useHeadlines(props).pulse} />
);

const ConfirmOrg = (props: StepProps & { roster: Roster }) => {
  const { t } = useLingui();
  const lines = useHeadlines(props).leads;
  const { run, busy, failure } = useCoreAction();
  const refresh = useRefresh();
  const [draft, setDraft] = useState<Roster>(props.roster);
  const [saved, setSaved] = useState(false);
  const teams = draft.teams
    .map((team) => ({
      team,
      people: draft.people.filter((person) => person.team === team.id),
    }))
    .toSorted((a, b) => b.people.length - a.people.length);
  const leads = draft.teams.filter(
    (team) => !team.off && team.lead !== null
  ).length;
  const missing = draft.teams.filter(
    (team) => !team.off && team.lead === null
  ).length;
  const change = (id: string, next: Partial<Roster["teams"][number]>) => {
    setSaved(false);
    setDraft({
      ...draft,
      teams: draft.teams.map((team) =>
        team.id === id ? { ...team, ...next } : team
      ),
    });
  };
  return (
    <>
      <Heading
        answer={
          saved
            ? {
                text: plural(leads, {
                  one: "Thank you. I’ll start with this lead.",
                  other: "Thank you. I’ll start with these # leads.",
                }),
              }
            : undefined
        }
        sentence={lines.sentence}
        title={lines.title}
      />
      <Onward>
        <div className="setup-org-list flex w-full flex-col overflow-auto rounded-xl border text-left">
          {teams.map(({ team, people }) => {
            const options = people.map((person) => ({
              value: person.id,
              label: person.name,
            }));
            const { name } = team;
            const count = people.length;
            return (
              <div
                className="setup-org-row grid items-center gap-3 border-b px-4 py-2.5 last:border-b-0"
                key={team.id}
              >
                <div className="flex min-w-0 flex-col">
                  <span
                    className={cn(
                      "truncate",
                      team.off &&
                        "text-muted-foreground decoration-border line-through"
                    )}
                  >
                    {name}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {plural(count, { one: "# person", other: "# people" })}
                  </span>
                </div>
                <Select
                  disabled={team.off}
                  items={options}
                  onValueChange={(value: unknown) => {
                    change(team.id, {
                      lead:
                        typeof value === "string" && value !== ""
                          ? value
                          : null,
                    });
                  }}
                  value={team.lead ?? ""}
                >
                  <SelectTrigger
                    aria-label={t`Lead of ${name}`}
                    className="w-full"
                  >
                    <SelectValue placeholder={t`Who leads it?`} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {options.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <Switch
                  aria-label={t`${name} takes part`}
                  checked={!team.off}
                  onCheckedChange={(on: boolean) => {
                    change(team.id, { off: !on });
                  }}
                />
              </div>
            );
          })}
        </div>
        <p className="text-muted-foreground text-xs">
          {missing > 0
            ? t`A team without a lead gets its links on the first day, and I ask each person what they do.`
            : t`Switch a team off and nobody in it gets a link.`}
        </p>
        <ErrorText>{failure}</ErrorText>
      </Onward>
      {saved ? (
        <Primary
          onClick={() => {
            props.go("team");
          }}
        >
          {t`Continue`}
        </Primary>
      ) : (
        <Primary
          busy={busy}
          onClick={() => {
            void (async () => {
              const kept = await run(
                async (session) => await session.onboarding.saveRoster(draft)
              );
              if (kept !== undefined) {
                await refresh();
                setSaved(true);
              }
            })();
          }}
        >
          {t`This is right`}
        </Primary>
      )}
    </>
  );
};

/**
 * The organization as Stephen will interview it, on one screen: every
 * team with its head count, who leads it, and whether it takes part. A lead
 * is picked from the team's own people; a team that is off gets no links.
 * What the staff list guessed, the admin puts right here.
 */
const Leads = (props: StepProps) => {
  const { t } = useLingui();
  const headlines = useHeadlines(props);
  const lines = headlines.leads;
  const { roster } = props.data.view;
  // The HR platform comes first, until the admin said which; then, on this visit, the organization.
  const [hrSaid, setHrSaid] = useState(props.data.choices.hr !== null);
  if (!hrSaid) {
    return (
      <HrPlatform
        choices={props.data.choices}
        lines={headlines.hr}
        onDone={() => {
          setHrSaid(true);
        }}
      />
    );
  }
  if (roster === null) {
    return (
      <>
        <Heading
          sentence={t`First I need your staff list.`}
          title={lines.title}
        />
        <Primary
          onClick={() => {
            props.go("company");
          }}
        >
          {t`Share your staff list`}
        </Primary>
      </>
    );
  }
  return <ConfirmOrg {...props} roster={roster} />;
};

/**
 * Tell the team, and plan the interviews: the message the admin sends
 * themselves, and the day the interviews start. The leads get their link
 * that morning; everyone else once their lead talked.
 */
const Team = (props: StepProps) => {
  const { t } = useLingui();
  const lines = useHeadlines(props).team;
  const { admin, view } = props.data;
  const { run, busy, failure } = useCoreAction();
  const refresh = useRefresh();
  const written = [
    t`Hi everyone,`,
    t`We want to spend less time on repetitive work, so there’s more time for our clients. This is about how work flows, not about jobs.`,
    t`Over the next two weeks you’ll get a short personal link to talk with Stephen, Grasp’s AI interviewer: leads for about 20 minutes, everyone else for 10 to 15. By voice or by typing.`,
    admin,
  ].join("\n\n");
  const message = props.message ?? written;
  // The teams that take part, with how many of their people do.
  const teams = (view.roster?.teams ?? [])
    .filter((team) => !team.off)
    .map((team) => ({
      id: team.id,
      name: team.name,
      people: (view.roster?.people ?? []).filter(
        (person) => person.team === team.id && !person.away
      ).length,
    }));
  // What they set before stands; else the next working day at nine, every team.
  const [choice, setChoice] = useState(() =>
    view.plan === null ? firstChoice(props.today) : choiceOfPlan(view.plan)
  );
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const when = useSendWords()(choice.day, choice.time);
  const going = teams.length - choice.held.length;
  const next =
    choice.held.length === 0
      ? t`Leads get their link ${when}. Everyone else right after their lead has talked to me.`
      : t`The leads of ${going} teams get their link ${when}. Everyone else right after their lead has talked to me.`;
  return (
    <>
      <Heading sentence={lines.sentence} title={lines.title} />
      <div className="flex w-full flex-col gap-3.5 text-left">
        <div className="bg-card overflow-hidden rounded-xl border shadow-sm">
          <div className="flex items-center gap-2.5 border-b px-4 py-3">
            <div className="flex min-w-0 flex-1 flex-col">
              <span>{admin}</span>
              <span className="text-muted-foreground">{t`To everyone`}</span>
            </div>
            <Button
              onClick={() => {
                setEditing(!editing);
              }}
              size="sm"
              variant="ghost"
            >
              {editing ? (
                <CheckIcon data-icon="inline-start" />
              ) : (
                <PenLineIcon data-icon="inline-start" />
              )}
              {editing ? t`Done` : t`Edit`}
            </Button>
            <Button
              onClick={() => {
                void (async () => {
                  setCopied(await copyText(message));
                })();
              }}
              size="sm"
              variant="ghost"
            >
              {copied ? (
                <CheckIcon data-icon="inline-start" />
              ) : (
                <CopyIcon data-icon="inline-start" />
              )}
              {copied ? t`Copied` : t`Copy`}
            </Button>
          </div>
          {editing ? (
            <div className="p-3">
              <Textarea
                aria-label={t`The message`}
                onChange={(event) => {
                  props.onMessage(event.target.value);
                }}
                rows={8}
                value={message}
              />
            </div>
          ) : (
            <div className="flex max-h-48 flex-col gap-2.5 overflow-auto px-4 py-4 whitespace-pre-line">
              {message.split(/\n{2,}/u).map((paragraph, index) => (
                <p key={index}>{paragraph}</p>
              ))}
            </div>
          )}
        </div>
        <SendPlanForm
          choice={choice}
          onChange={setChoice}
          teams={teams}
          today={props.today}
        />
        <Alert>
          <InfoIcon />
          <AlertTitle>{t`What happens next`}</AlertTitle>
          <AlertDescription>{next}</AlertDescription>
        </Alert>
        <ErrorText>{failure}</ErrorText>
      </div>
      <Primary
        busy={busy}
        disabled={
          !choiceHolds(
            choice,
            teams.map((team) => team.id)
          )
        }
        onClick={() => {
          void (async () => {
            const saved = await run(
              async (session) =>
                await session.onboarding.savePlan(
                  replanOf(choice, view.plan, planDays.usual)
                )
            );
            if (saved !== undefined) {
              await refresh();
              props.go("listening");
            }
          })();
        }}
      >
        {t`I sent it`}
      </Primary>
    </>
  );
};

/** Letting Grasp's mail through, as one of what needs the admin. */
const Mail = ({ data, settled, onSettle }: StepProps) => (
  <MailItem
    domain={data.sendingDomain}
    onSettle={(done) => {
      onSettle("mail", done);
    }}
    settled={settled.includes("mail")}
  />
);

/** The one team far behind, named with the lead whose word usually helps. */
const QuietTeam = ({ team, lead }: { team: string; lead: string }) => {
  const { t } = useLingui();
  return (
    <p className="text-muted-foreground">
      {t`${team} has been quiet so far. A short message from ${lead}, their lead, usually helps. I’ll remind everyone once myself.`}
    </p>
  );
};

/**
 * What keeps the links from going out, before anything else on the step:
 * Grasp's staff paused the interviews (in the words of their own switch),
 * or the agreements are not in place yet.
 */
const Waiting = ({ paused, agreed }: { paused: boolean; agreed: boolean }) => {
  const { t } = useLingui();
  return (
    <>
      {paused ? (
        <Callout
          text={t`Paused: no link opens and none goes out. The links that are due go out once they run again.`}
        />
      ) : null}
      {agreed ? null : (
        <Callout
          text={t`Grasp is still putting the agreements in place. Your people’s links go out once that is done.`}
        />
      )}
    </>
  );
};

/**
 * One team's row of how far it is: how many talked of how many were
 * asked; while too few talked, how many were asked and whether the lead
 * talked; while too few were asked, only whether the lead talked.
 */
const TeamRow = ({ team }: { team: TeamProgress }) => {
  const { t } = useLingui();
  const numbers = teamNumbersOf(team);
  const least = minTalkedShown;
  let count = t`Under 5`;
  if (numbers.shown === "both") {
    const { talked, asked: of } = numbers;
    count = t`${talked} of ${of}`;
  } else if (numbers.shown === "asked") {
    const { asked: of } = numbers;
    count = t`Fewer than ${least} of ${of}`;
  }
  return (
    <div className="setup-team-row grid items-center gap-3 py-1.5">
      <span className="truncate">{team.name}</span>
      {numbers.shown === "both" ? (
        <Progress
          aria-label={team.name}
          value={
            numbers.asked === 0
              ? 0
              : Math.round((numbers.talked / numbers.asked) * 100)
          }
        />
      ) : (
        <span className="text-muted-foreground text-xs">
          {team.leadTalked ? t`Lead talked` : t`Lead not yet`}
        </span>
      )}
      <span className="text-muted-foreground text-right tabular-nums">
        {count}
      </span>
    </div>
  );
};

/**
 * The weeks Stephen talks to the team: how far the days are, three
 * numbers, and the team that needs a word from its lead. Numbers per team
 * only for teams of five or more, and never who talked or what anyone said.
 */
const ListeningStep = (props: StepProps) => {
  const { t } = useLingui();
  const { listening, percent, today, data } = props;
  const lines = useHeadlines(props).listening;
  // oxlint-disable-next-line react/hook-use-state -- read once as the step arrives, never set
  const [mailShown] = useState(() => !props.settled.includes("mail"));
  const { plan, progress, roster, agreed, paused } = data.view;
  const closes = plan === null ? "" : formatDay(closesOn(plan));
  const { days } = listening;
  const day = Math.max(
    listening.day,
    plan !== null && plan.start <= today ? 1 : 0
  );
  const teams = progress?.teams.filter((team) => !team.off) ?? [];
  // Once the others are well under way, a team of five or more far behind is named, with the lead who can help.
  const quiet =
    listening.progress > 0.35
      ? teams.find((team) => {
          const lead = roster?.teams.find((each) => each.id === team.id)?.lead;
          return (
            lead !== null &&
            lead !== undefined &&
            team.asked !== null &&
            team.asked > 0 &&
            (team.talked ?? 0) / team.asked < 0.35
          );
        })
      : undefined;
  const quietLead =
    quiet === undefined
      ? ""
      : (roster?.people.find(
          (person) =>
            person.id ===
            roster.teams.find((each) => each.id === quiet.id)?.lead
        )?.name ?? "");
  const gateOpen = percent >= data.gate.threshold;
  const leads = progress?.leads ?? 0;
  const { leadsHeard } = listening;
  const starts = plan === null ? "" : formatDay(plan.start);
  return (
    <>
      <Heading
        sentence={lines.sentence}
        title={lines.title}
        voice={lines.voice}
      />
      <div className="flex w-full flex-col gap-4 text-left">
        <Waiting agreed={agreed} paused={paused} />
        {/* Before the links go out, until it's done: the admin's mail filter lets Grasp's mail through. Settled here, it stays to say so until they leave. */}
        {mailShown ? <Mail {...props} /> : null}
        <div className="flex flex-col gap-2">
          <div className="flex gap-1">
            {Array.from({ length: days }, (_, index) => (
              <span
                className={
                  index < day
                    ? "bg-foreground h-1.5 flex-1 rounded-full transition-colors duration-500"
                    : "bg-border h-1.5 flex-1 rounded-full transition-colors duration-500"
                }
                key={index}
              />
            ))}
          </div>
          <div className="text-muted-foreground flex justify-between">
            <span>
              {plan !== null && plan.start > today
                ? t`Starts ${starts}`
                : t`Day ${day} of ${days}`}
            </span>
            {closes === "" ? null : <span>{t`Closes ${closes}`}</span>}
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2.5">
          <Figure
            label={t`team leads talked`}
            value={t`${leadsHeard} of ${leads}`}
          />
          <Figure
            label={t`colleagues talked`}
            value={String(listening.colleaguesHeard)}
          />
          {/* Core draws no work from the interviews yet: unknown stays unknown, never 0. */}
          <Figure label={t`pieces of work found`} value="–" />
        </div>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            {quiet === undefined ? null : (
              <QuietTeam lead={firstName(quietLead)} team={quiet.name} />
            )}
          </div>
          <Popover>
            <PopoverTrigger
              render={
                <Button className="-my-1 flex-none" size="sm" variant="ghost" />
              }
            >
              {t`By team`}
              <ChevronDownIcon data-icon="inline-end" />
            </PopoverTrigger>
            <PopoverContent align="end" className="w-96">
              {/* One list, close together: the content's own room is between its parts. */}
              <div className="flex flex-col">
                {teams.map((team) => (
                  <TeamRow key={team.id} team={team} />
                ))}
                <p className="text-muted-foreground pt-2 text-xs">{t`Teams under five people show only whether their lead talked, so nobody can be singled out.`}</p>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>
      {gateOpen ? (
        <div className="animate-in fade-in slide-in-from-bottom-2 flex w-full flex-col gap-3 duration-400">
          <Callout
            text={t`I’ve heard enough to open. There are just a few things I need from you first.`}
          />
          <Primary
            onClick={() => {
              props.go("review");
            }}
          >
            {t`See what needs you`}
          </Primary>
        </div>
      ) : null}
    </>
  );
};

/**
 * What only the admin can settle, each with a way to settle it. Nothing
 * moves on by itself: they read what they settled, and go on once nothing
 * is open.
 */
const Review = (props: StepProps) => {
  const { t } = useLingui();
  const lines = useHeadlines(props).review;
  const open = openItems(props.settled).length;
  return (
    <>
      <Heading
        sentence={lines.sentence}
        title={lines.title}
        voice={lines.voice}
      />
      <div className="w-full">
        <Mail {...props} />
      </div>
      {open === 0 ? (
        <Primary
          onClick={() => {
            props.go("open");
          }}
        >
          {t`Continue`}
        </Primary>
      ) : null}
    </>
  );
};

/**
 * The end of the onboarding: what Stephen heard, and that Grasp opens the
 * platform once it gives its go. Nothing to press; the admin hears from
 * Grasp.
 */
const Open = (props: StepProps) => {
  const { t } = useLingui();
  const lines = useHeadlines(props).open;
  return (
    <>
      <Heading
        sentence={lines.sentence}
        title={lines.title}
        voice={lines.voice}
      />
      <Callout
        text={
          props.data.gate.open
            ? t`Your platform is open. We’ll walk you through it.`
            : t`We open your platform once we’ve checked everything with you. You’ll hear from us.`
        }
      />
    </>
  );
};

/**
 * One screen per step. A step is a component of its own, given what the
 * onboarding read from core and how to go on; it is made of the parts in
 * setup-parts.tsx, and says its line from `useHeadlines`.
 */
const bodies: Record<SetupStep, ComponentType<StepProps>> = {
  welcome: Welcome,
  about: About,
  company: Company,
  sources: Sources,
  documents: Documents,
  pulse: Pulse,
  leads: Leads,
  team: Team,
  listening: ListeningStep,
  review: Review,
  open: Open,
};

/**
 * One screen of the onboarding, by step: one title, one sentence, one
 * small action, one main button. `cramped`: on a phone, the step does not
 * fit beside even the smallest brain; `onMadeWay` hears how much room its
 * sentence frees as it makes way.
 */
export const SetupStepBody = ({
  step,
  cramped,
  onMadeWay,
  ...props
}: StepProps & {
  step: SetupStep;
  cramped: boolean;
  onMadeWay: (freed: number) => void;
}) => {
  // Each step is drawn anew, so this starts over with every step.
  const [explained, setExplained] = useState(false);
  // This step's line and the next one's are fetched ahead, so he starts the moment a step arrives.
  const headlines = useHeadlines(props);
  const [here, ahead] = [step, steps[stepIndex(step) + 1]].map((each) => {
    const headline =
      each === undefined || each === "about" ? undefined : headlines[each];
    return {
      line: stepLine(headline?.title ?? "", headline?.sentence).line,
      voice: headline?.voice ?? evenVoice,
    };
  });
  usePrepare(here?.line ?? "", here?.voice);
  usePrepare(ahead?.line ?? "", ahead?.voice);
  const onExplained = () => {
    setExplained(true);
  };
  const Body = bodies[step];
  return (
    <Cramped value={{ cramped, onMadeWay }}>
      <Explained value={{ explained, onExplained }}>
        <Body {...props} />
      </Explained>
    </Cramped>
  );
};
