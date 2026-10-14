import { planDays } from "@grasp-os/shared/onboarding";
import type {
  InterviewLocale,
  OnboardingView,
  Roster,
  RosterInput,
} from "@grasp-os/shared/onboarding";
import { documentErrors } from "@grasp-os/shared/onboarding-documents";
import type { OnboardingDocument } from "@grasp-os/shared/onboarding-documents";
import type { GateView, KnownPart } from "@grasp-os/shared/onboarding-gate";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@grasp-os/ui/components/alert";
import { Button } from "@grasp-os/ui/components/button";
import {
  Item,
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
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
import { useRef, useState } from "react";
import type { ComponentType } from "react";

import type { BrainScene } from "../brain/dot-brain.tsx";
import { AppLogo } from "../connections/app-logo.tsx";
import { CoreTimeoutError } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDate, formatList } from "../format.ts";
import { isLocale, localeNames } from "../i18n.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { About } from "./about-story.tsx";
import { DocumentDrop } from "./document-drop.tsx";
import type { DocumentRow } from "./document-drop.tsx";
import { LanguageChoice } from "./language-choice.tsx";
import { SendPlanForm, useSendWords } from "./send-plan-form.tsx";
import { choiceHolds, choiceOfPlan, firstChoice, planOf } from "./send-plan.ts";
import {
  Asides,
  Callout,
  Cramped,
  Explained,
  Figure,
  Heading,
  Later,
  LaterLink,
  MoreAbout,
  Onward,
  Primary,
  SupportLink,
} from "./setup-parts.tsx";
import { closesOn, documentSources } from "./setup.ts";
import type { Listening, SetupStep } from "./setup.ts";
import {
  csvRows,
  exampleList,
  StaffListError,
  staffListOf,
} from "./staff-list.ts";
import { xlsxRows } from "./xlsx.ts";

// One screen of the client onboarding, by step (prototype
// `components/onboarding/onboarding-steps.tsx`, the steps of a real
// organization: `RealCompany`, `ConfirmOrg`, `RealTeam`, `RealListening`,
// `RealPulse`, `RealOpen`, and the others where nothing is different). What
// a step keeps goes to core: who works where, who leads which team and
// which teams take part, the documents and the answers to their questions,
// and when the interviews run. What core keeps nothing of yet (where the
// documents live, Pulse, what needs the admin settled) shows the step as
// the prototype does with nothing in.

/** What the onboarding reads from core, and who is going through it. */
export interface SetupData {
  /** The admin's first name. */
  admin: string;
  view: OnboardingView;
  documents: OnboardingDocument[];
  gate: GateView;
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
  go: (step: SetupStep) => void;
  /** "How this works" tells its story in the brain's figures: this sets the figure, or gives it back with null. */
  onStory: (scene: BrainScene | null) => void;
}

const firstName = (name: string): string => name.split(" ")[0] ?? name;

/** A date as the page's language writes it, from an ISO day. */
const formatDay = (day: string): string => formatDate(`${day}T12:00:00Z`);

/** Copies text, and says whether it worked: browsers refuse without focus or permission. */
const copyText = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};

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

/** What each step says as it arrives: its title and sentence. */
const useHeadlines = ({
  data,
}: StepProps): Record<
  Exclude<SetupStep, "about">,
  { title: string; sentence: string }
> => {
  const { t } = useLingui();
  const { admin } = data;
  const named = toolsIn(data.documents).slice(0, 4);
  const tools = formatList(named);
  const { progress } = data.view;
  const talked = (progress?.talked ?? 0) + (progress?.leadsTalked ?? 0);
  // Nothing core keeps needs the admin settled yet.
  const openCount = 0;
  return {
    welcome: {
      title: t`Hi ${admin}, I’m Stephen`,
      sentence: t`Before we start, which language do you prefer?`,
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
    leads: {
      title: t`Almost done: is this your organization?`,
      sentence: t`I talk to each team lead first, so they hear about me before their team does. Check who leads which team, and which teams take part.`,
    },
    team: {
      title: t`Before I reach out, let your team know`,
      sentence: t`People respond better when they know why I’m reaching out. I’ve drafted a message you can send yourself. Then pick the day the interviews start.`,
    },
    listening: {
      title: t`That’s everything from you. Now I’ll talk to your team.`,
      sentence: t`You can close this page now. Come back here to see how far I am.`,
    },
    review: {
      title: plural(openCount, {
        0: "Nothing needs you",
        1: "Just one thing for you",
        other: "# things for you",
      }),
      sentence: t`I’ve handled everything else.`,
    },
    open: {
      title: t`Thank you, ${admin}`,
      sentence: plural(talked, {
        one: "I talked with # person.",
        other: "I talked with # people.",
      }),
    },
  };
};

/** About how long the steps take, for the welcome to say so. */
const onboardingMinutes = 8;

const Welcome = (props: StepProps) => {
  const { t } = useLingui();
  const lines = useHeadlines(props).welcome;
  // A language is chosen before anything else, every time: none is marked until you pick one.
  const [picked, setPicked] = useState(false);
  const { i18n } = useLingui();
  const chosen = localeNames[isLocale(i18n.locale) ? i18n.locale : "en"];
  const minutes = onboardingMinutes;
  return (
    <>
      {/* The question is the end of what Stephen says, not a line after it; answered, he says so in the new language. */}
      <Heading
        answer={
          picked
            ? {
                text: t`${chosen} it is. This takes about ${minutes} minutes. Ready to start?`,
              }
            : undefined
        }
        sentence={lines.sentence}
        title={lines.title}
      />
      <Onward>
        <LanguageChoice
          onPick={() => {
            setPicked(true);
          }}
          picked={picked}
        />
      </Onward>
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

/** Who works where, from a staff list file; or why it could not be read. */
const readStaffList = async (
  file: File,
  noTeam: string
): Promise<RosterInput | "headings" | "empty" | "unreadable"> => {
  try {
    const rows = xlsxName.test(file.name)
      ? await xlsxRows(await file.arrayBuffer())
      : csvRows(await file.text());
    return staffListOf(rows, noTeam).roster;
  } catch (error) {
    return error instanceof StaffListError ? error.reason : "unreadable";
  }
};

/** Shares a document with core, which reads it at once; or why it could not be. */
const shareDocument = async (
  core: ReturnType<typeof useCore>,
  file: File,
  locale: InterviewLocale
): Promise<{ shared: true } | { shared: false; error: unknown }> => {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await core.withSession(
      async (session) =>
        await session.onboarding.shareDocument({
          locale,
          name: file.name,
          bytes,
        })
    );
    return { shared: true };
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
    const found = await readStaffList(file, noTeam);
    if (typeof found === "string") {
      const why = found;
      if (why === "headings") {
        setProblem(
          t`I could not find the columns. The first row should name them: name, email, team and job.`
        );
      } else if (why === "empty") {
        setProblem(t`There is nobody in this list.`);
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
      }
    }
    setReading(false);
  };
  let answer: { text: string } | undefined;
  if (problem !== null) {
    answer = { text: problem };
  } else if (roster !== null) {
    answer = {
      text: t`Thank you. From your staff list I can see ${people} people in ${teams} teams.`,
    };
  }
  return (
    <>
      <Heading answer={answer} sentence={lines.sentence} title={lines.title} />
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

/**
 * Where the documents live. Grasp connects none of them here yet, and core
 * keeps nothing of them: the places are listed, and the step can be
 * skipped, as the prototype's is with none connected.
 */
const Sources = (props: StepProps) => {
  const { t } = useLingui();
  const lines = useHeadlines(props).sources;
  return (
    <>
      <Heading sentence={lines.sentence} title={lines.title} />
      <Onward>
        <ItemGroup className="grid w-full text-left sm:grid-cols-2">
          {documentSources.map((name) => (
            <Item key={name} size="sm" variant="outline">
              <ItemMedia>
                <AppLogo name={name} size="sm" />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{name}</ItemTitle>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      </Onward>
      <Asides>
        <LaterLink
          onClick={() => {
            props.go("documents");
          }}
        >
          {t`Skip for now`}
        </LaterLink>
        <SupportLink page="documents">{t`More about these connections`}</SupportLink>
      </Asides>
    </>
  );
};

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

/**
 * Documents that explain how they work. Each is read the moment it is
 * dropped, for real, by core: every row says what it is about. Only what
 * nobody but the one who shared it can say, Stephen asks at once, with the
 * answers to pick from.
 */
const Documents = (props: StepProps) => {
  const { t, i18n } = useLingui();
  const lines = useHeadlines(props).documents;
  const core = useCore();
  const refresh = useRefresh();
  const { run } = useCoreAction();
  const problemOf = useProblemOf();
  const [pending, setPending] = useState<Pending[]>([]);
  const [fresh, setFresh] = useState(false);
  const kept = props.data.documents;
  const locale: InterviewLocale = isLocale(i18n.locale) ? i18n.locale : "en";
  const take = (files: File[]) => {
    const added = files
      .filter(
        (file) =>
          !kept.some((each) => each.name === file.name) &&
          !pending.some((busy) => busy.name === file.name)
      )
      .map((file, at): Pending => ({
        key: `${file.name}-${file.size}-${Date.now()}`,
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
          setPending((now) => now.filter((busy) => busy.key !== each.key));
          return;
        }
        const problem = problemOf(result.error);
        setPending((now) =>
          now.map((busy) =>
            busy.key === each.key ? { ...busy, state: "failed", problem } : busy
          )
        );
      })();
    }
  };
  // His one question about a document, while it waits for an answer: answered with a press.
  const open = kept.find(
    (each) => each.reading.ask !== null && each.answer === null
  );
  const answer = async (option: string) => {
    if (open === undefined) {
      return;
    }
    const saved = await run(
      async (session) =>
        await session.onboarding.answerDocument(open.id, option)
    );
    if (saved !== undefined) {
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
            ? {
                text: t`Thank you. I’m reading them now, and you can add more at any time.`,
              }
            : undefined
        }
        sentence={lines.sentence}
        title={lines.title}
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

/**
 * Pulse: there is nothing to download here yet, and core keeps no wish for
 * it, so the step says what it is and can be skipped, as the prototype's is
 * before anything is chosen.
 */
const Pulse = (props: StepProps) => {
  const { t } = useLingui();
  const lines = useHeadlines(props).pulse;
  return (
    <>
      <Heading sentence={lines.sentence} title={lines.title} />
      <Asides>
        <LaterLink
          onClick={() => {
            props.go("leads");
          }}
        >
          {t`Skip for now`}
        </LaterLink>
        <SupportLink page="pulse">{t`More about Pulse`}</SupportLink>
      </Asides>
    </>
  );
};

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
  const lines = useHeadlines(props).leads;
  const { roster } = props.data.view;
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
                  planOf(choice, planDays.usual)
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
 * The weeks Stephen talks to the team: how far the days are, three
 * numbers, and the team that needs a word from its lead. Numbers per team
 * only for teams of five or more, and never who talked or what anyone said.
 */
const ListeningStep = (props: StepProps) => {
  const { t } = useLingui();
  const { listening, percent, today, data } = props;
  const lines = useHeadlines(props).listening;
  const { plan, progress, roster, agreed } = data.view;
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
      <Heading sentence={lines.sentence} title={lines.title} />
      <div className="flex w-full flex-col gap-4 text-left">
        {agreed ? null : (
          <Callout
            text={t`Grasp is still putting the agreements in place. Your people’s links go out once that is done.`}
          />
        )}
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
                {teams.map((team) => {
                  const share =
                    team.asked === null || team.asked === 0
                      ? 0
                      : (team.talked ?? 0) / team.asked;
                  const shown = team.talked !== null;
                  const of = team.asked ?? 0;
                  const talked = team.talked ?? 0;
                  return (
                    <div
                      className="setup-team-row grid items-center gap-3 py-1.5"
                      key={team.id}
                    >
                      <span className="truncate">{team.name}</span>
                      {shown ? (
                        <Progress
                          aria-label={team.name}
                          value={Math.round(share * 100)}
                        />
                      ) : (
                        <span className="text-muted-foreground text-xs">
                          {team.leadTalked ? t`Lead talked` : t`Lead not yet`}
                        </span>
                      )}
                      <span className="text-muted-foreground text-right tabular-nums">
                        {shown ? t`${talked} of ${of}` : t`Under 5`}
                      </span>
                    </div>
                  );
                })}
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
 * What only the admin can settle. Core keeps none of it yet, so nothing
 * needs them: the prototype's step with every item settled.
 */
const Review = (props: StepProps) => {
  const { t } = useLingui();
  const lines = useHeadlines(props).review;
  return (
    <>
      <Heading sentence={lines.sentence} title={lines.title} />
      <Primary
        onClick={() => {
          props.go("open");
        }}
      >
        {t`Continue`}
      </Primary>
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
      <Heading sentence={lines.sentence} title={lines.title} />
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
