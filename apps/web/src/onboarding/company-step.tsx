import { directoryErrors } from "@grasp-os/shared/directory";
import type {
  DirectorySuite,
  OnboardingDirectory,
} from "@grasp-os/shared/directory";
import {
  onboardingPeopleMax,
  onboardingTeamsMax,
} from "@grasp-os/shared/onboarding";
import type { Roster, RosterInput } from "@grasp-os/shared/onboarding";
import { BrandIcon } from "@grasp-os/ui/components/brand-icon";
import { Button } from "@grasp-os/ui/components/button";
import { FileUpload } from "@grasp-os/ui/components/file-upload";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Separator } from "@grasp-os/ui/components/separator";
import { Text } from "@grasp-os/ui/components/text";
import { CircleCheckIcon, Icon } from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { msg, plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { TopError } from "../frame/top-error.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { CalmStep } from "./calm-frame.tsx";
import { useConnectionReturn } from "./connection-return.ts";
import {
  csvRows,
  directoryListOf,
  exampleList,
  StaffListError,
  staffListOf,
  withSaved,
} from "./staff-list.ts";
import {
  returnedSchema,
  suiteLogos,
  suiteNames,
  useRefresh,
} from "./step-parts.ts";
import type { StepProps } from "./step-parts.ts";
import { useLeaving } from "./step-voice.tsx";
import { XlsxError, xlsxMost, xlsxRows } from "./xlsx.ts";

// Who works there: from the organization's Microsoft or Google sign-in,
// connected here and read through Grasp's own read-only connection
// (names, teams, jobs and who reports to whom, nothing else), or from a
// staff list the admin shares, a CSV or Excel file with a row per person,
// read in this browser. Either way only names, email addresses, teams and
// jobs are kept, in core. A sign-in is offered for each suite this
// deployment signs in with, as a row pressed to connect it. Once a list is
// in, the step moves on by itself: no page in between to confirm it
// (Ruben), Stephen says what came in as the next step arrives. Coming back,
// the sign-in in use is marked done, and a new list replaces the one kept.
// Never forced: without a list the admin skips on, and Grasp's own people
// sort the list out with them in their talks.

const styles = stylex.create({
  stack: { display: "grid", gap: space[4] },
  drop: { display: "grid", gap: space[2] },
  example: { justifySelf: "center" },
  // "Or use a staff list", through the middle of a line either side.
  or: { display: "flex", alignItems: "center", gap: space[3] },
  orLine: { flexGrow: 1, flexBasis: 0, alignSelf: "center" },
});

/** The first few people on the list, by name; someone core erased has none. */
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

/** Where connecting a directory comes back to: this step. */
const companyStep = "/setup?step=company";

/** Why the directory could not become a roster. */
type DirectoryProblem = "large" | "empty" | "inactive" | "failed";

/**
 * What core's refusal of a directory read means here: too large, a
 * connection an admin's account must make again, or a failure of the moment.
 */
export const directoryProblemOf = (
  error: unknown
): Exclude<DirectoryProblem, "empty"> => {
  const code = directoryErrors.codeOf(error);
  if (code === "directory.too_large") {
    return "large";
  }
  // Each asks for the directory connected again by an admin's account.
  return code === "directory.inactive" ||
    code === "directory.not_admin" ||
    code === "directory.not_connected"
    ? "inactive"
    : "failed";
};

/**
 * Who works where, from the connected directory, as a roster with what the
 * admin set on the one saved before kept: the same path a staff list
 * takes, so everyone keeps their id and their link. Or why it could not be.
 */
const readDirectoryRoster = async (
  core: ReturnType<typeof useCore>,
  noTeam: string,
  saved: Roster | null
): Promise<
  { roster: RosterInput; suite: DirectorySuite } | DirectoryProblem
> => {
  try {
    const { people, suite } = await core.withSession(
      async (session) => await session.onboarding.readDirectory()
    );
    return {
      roster: withSaved(directoryListOf(people, noTeam).roster, saved),
      suite,
    };
  } catch (error) {
    if (error instanceof StaffListError) {
      return error.reason === "empty" ? "empty" : "large";
    }
    return directoryProblemOf(error);
  }
};

/** Starts connecting the directory of `suite`: the browser goes to its sign-in, and comes back here. False if it could not start. */
const startDirectory = async (
  core: ReturnType<typeof useCore>,
  suite: DirectorySuite
): Promise<boolean> => {
  try {
    const { url } = await core.withSession(
      async (session) =>
        await session.onboarding.connectDirectory(suite, companyStep)
    );
    window.location.assign(url);
    return true;
  } catch {
    return false;
  }
};

/** Which directory the roster came from: the one read on this visit, or, arriving, the one connected; none for a staff list. */
const directoryShown = (
  fresh: DirectorySuite | "list" | null,
  directory: OnboardingDirectory | null
): DirectorySuite | null => {
  if (fresh === "list") {
    return null;
  }
  if (fresh !== null) {
    return fresh;
  }
  return directory?.status === "active" ? directory.suite : null;
};

/** Whoever is new on a list saved while the plan runs gets no link until the organization is confirmed again. */
export const WaitingNote = ({ waiting }: { waiting: number }) =>
  waiting > 0 ? (
    <Text>
      {plural(waiting, {
        one: "# person new on your list gets a link once you confirm your organization.",
        other:
          "# people new on your list get their links once you confirm your organization.",
      })}
    </Text>
  ) : null;

/**
 * The step's title and line: just the ask, the same arriving or coming
 * back. It leads with the sign-in, named for what Grasp reads through it;
 * a staff list is the way in only where this deployment signs in with no
 * suite. What came in, Stephen says as the next step arrives.
 */
const useWords = (
  suites: DirectorySuite[]
): { title: string; body: string | null; spoken: string } => {
  const { t } = useLingui();
  // Just the ask, no line under it (Ruben: what matters is that they connect their account).
  if (suites.length > 1) {
    return {
      title: t`Connect your work account`,
      body: null,
      spoken: t`Now let’s get to know your company. If you connect your work account, I can see who works there and in which team, so I know who to talk to later on.`,
    };
  }
  if (suites[0] !== undefined) {
    const signIn = suiteNames[suites[0]];
    return {
      title: t`Connect your ${signIn} account`,
      body: null,
      spoken: t`Now let’s get to know your company. If you connect your ${signIn} account, I can see who works there and in which team, so I know who to talk to later on.`,
    };
  }
  return {
    title: t`Share your staff list`,
    body: t`Share a staff list as a CSV or Excel file, a row per person. No list at hand? Skip this, and we’ll sort it out with you.`,
    spoken: t`Now let’s get to know your company. A staff list works fine for that, one row per person with their team and job. Don’t have one at hand? No problem, skip it and we’ll sort it out together.`,
  };
};

/**
 * The step's way on, in the bottom bar: Continue when a list is already
 * in (coming back), else a way past it. Never forced: Grasp's own people
 * sort the list out with them in their talks.
 */
const CompanyWay = ({
  known,
  onward,
}: {
  known: boolean;
  onward: () => Promise<void>;
}) => {
  const { t } = useLingui();
  return (
    <Button
      onClick={() => {
        void onward();
      }}
      size="lg"
      variant={known ? "default" : "outline"}
    >
      {known ? t`Continue` : t`Skip for now`}
    </Button>
  );
};

/** Where a staff list goes: dropped or chosen right here, with an example to copy. */
const StaffListDrop = ({
  onUpload,
  disabled,
  inUse,
}: {
  onUpload: (file: File) => Promise<void>;
  disabled: boolean;
  /** Coming back with a staff list kept: a new one replaces it. */
  inUse: boolean;
}) => {
  const { t } = useLingui();
  return (
    <div {...stylex.props(styles.drop)}>
      <FileUpload
        accept={[".csv", ".tsv", ".txt", ".xlsx"]}
        description={
          inUse
            ? t`Your staff list is in. A new one replaces it.`
            : t`A CSV or Excel file, a row per person`
        }
        disabled={disabled}
        onUpload={onUpload}
      />
      <Button asChild size="sm" style={styles.example} variant="link">
        <a
          download="staff-list-example.csv"
          href={`data:text/csv;charset=utf-8,${encodeURIComponent(exampleList)}`}
        >
          {t`See an example`}
        </a>
      </Button>
    </div>
  );
};

/**
 * A sign-in, as a row pressed to connect it. The one in use is marked
 * done; pressed again, it connects anew and replaces the list kept.
 */
const SignInRow = ({
  suite,
  done,
  waiting,
  onConnect,
}: {
  suite: DirectorySuite;
  done: boolean;
  waiting: boolean;
  onConnect: () => void;
}) => {
  const { t } = useLingui();
  const signIn = suiteNames[suite];
  let label = t`Continue with ${signIn}`;
  if (waiting) {
    label = t`Waiting for ${signIn}`;
  } else if (done) {
    label = t`${signIn} is connected`;
  }
  return (
    <Item onClick={onConnect} variant="outline">
      <ItemMedia>
        <BrandIcon decorative logo={suiteLogos[suite]} name={signIn} size="sm" />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{label}</ItemTitle>
      </ItemContent>
      {done ? (
        <ItemActions>
          <Icon icon={CircleCheckIcon} />
        </ItemActions>
      ) : null}
    </Item>
  );
};

/** A directory sign-in that didn't connect, and why: one that came back refused (`useConnectionReturn`), or one the step couldn't start. */
const useNotConnected = (suites: readonly DirectorySuite[]) => {
  const returnedWhy = useConnectionReturn();
  const [notConnected, setNotConnected] = useState<{
    suite: DirectorySuite;
    why: string;
  } | null>(null);
  const [returnSeen, setReturnSeen] = useState<string | null>(null);
  const [suite] = suites;
  if (
    returnedWhy !== null &&
    returnedWhy !== returnSeen &&
    suite !== undefined
  ) {
    setReturnSeen(returnedWhy);
    setNotConnected({ suite, why: returnedWhy });
  }
  return [notConnected, setNotConnected] as const;
};

/** What went wrong on the step, across the top of the window: a sign-in that didn't connect, with Try again, or any other problem. */
const CompanyError = ({
  notConnected,
  problem,
  connect,
  onClose,
}: {
  notConnected: { suite: DirectorySuite; why: string } | null;
  problem: string | null;
  connect: (suite: DirectorySuite) => Promise<void>;
  onClose: () => void;
}) => {
  const { t } = useLingui();
  return (
    <TopError
      action={
        notConnected === null
          ? undefined
          : {
              label: t`Try again`,
              run: () => {
                void connect(notConnected.suite);
              },
            }
      }
      onClose={onClose}
      title={
        notConnected === null
          ? undefined
          : t`${suiteNames[notConnected.suite]} didn't connect`
      }
    >
      {notConnected?.why ?? problem}
    </TopError>
  );
};

/** What Stephen says of the company as the next step arrives: known by now, or left for later. */
const companyLeft = {
  known: msg`Good, now I know who works where.`,
  later: msg`No staff list for now, that’s fine. We’ll sort it out together later.`,
};

const companyLeftAs = (known: boolean) =>
  known ? companyLeft.known : companyLeft.later;

export const CompanyStep = (props: StepProps) => {
  const { t } = useLingui();
  const core = useCore();
  const { run } = useCoreAction();
  const refresh = useRefresh();
  const navigate = useNavigate();
  const search: unknown = useSearch({ strict: false });
  const returned = returnedSchema.safeParse(search).success;
  const [reading, setReading] = useState<DirectorySuite | "list" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Kept on this visit, and from where: the row it came through shows done while the step moves on.
  const [kept, setKept] = useState<DirectorySuite | "list" | null>(null);
  const { roster, waiting } = props.data.view;
  const { directory, suites } = props.data;
  // A sign-in that didn't connect, back refused or not started: said over the step, with the way on.
  const [notConnected, setNotConnected] = useNotConnected(suites);
  // As the next step arrives, Stephen says it's in (or that it can wait): no line for it here.
  useLeaving(companyLeftAs(roster !== null));
  const noTeam = t({
    message: "Other",
    context: "the team for people a staff list gives no team",
  });
  const peopleMost = onboardingPeopleMax;
  const teamsMost = onboardingTeamsMax;
  // Kept in core, and on to the next step by itself: nothing in between to confirm.
  const keep = async (
    found: RosterInput,
    from: DirectorySuite | "list"
  ): Promise<boolean> => {
    const saved = await run(
      async (session) => await session.onboarding.saveRoster(found),
      () => {
        setProblem(t`I could not keep it. Try again in a moment.`);
      }
    );
    if (saved === undefined) {
      return false;
    }
    setKept(from);
    await refresh();
    await props.onward();
    return true;
  };
  // A staff list, read here and kept in core; a refusal says why across the top.
  const upload = async (file: File): Promise<void> => {
    setReading("list");
    setProblem(null);
    const found = await readStaffList(file, noTeam, roster);
    setReading(null);
    if (typeof found !== "string") {
      if (await keep(found, "list")) {
        return;
      }
      throw new Error(t`I could not keep it. Try again in a moment.`);
    }
    const why = {
      headings: t`I could not find the columns. The first row should name them: name, email, team and job.`,
      empty: t`There is nobody in this list.`,
      large: t`This list is too large. I can take up to ${peopleMost} people in up to ${teamsMost} teams.`,
      unreadable: t`I could not read this file. A CSV or an Excel file works.`,
    }[found];
    setProblem(why);
    throw new Error(why);
  };
  const connect = async (suite: DirectorySuite) => {
    setReading(suite);
    setProblem(null);
    const signIn = suiteNames[suite];
    if (!(await startDirectory(core, suite))) {
      setNotConnected({
        suite,
        why: t`I could not reach ${signIn} just now. Try again in a moment, or use a staff list.`,
      });
      setReading(null);
    }
  };
  // Back from the sign-in: the directory is read once, made a roster and kept, and the step moves on;
  // when it can't be, the step stays, says why, and the address forgets the connection.
  const readOnReturn = async () => {
    const suite = directory?.suite ?? null;
    setReading(suite ?? "list");
    setProblem(null);
    const found = await readDirectoryRoster(core, noTeam, roster);
    const signIn = suite === null ? "" : suiteNames[suite];
    if (typeof found !== "string" && (await keep(found.roster, found.suite))) {
      return;
    }
    if (found === "large") {
      setProblem(
        t`There are more people in ${signIn} than I can take: up to ${peopleMost} people in up to ${teamsMost} teams. A staff list of those taking part works.`
      );
    } else if (found === "empty") {
      setProblem(t`I found nobody in ${signIn}.`);
    } else if (found === "inactive") {
      setProblem(
        t`I could not read who works where from ${signIn}. Connect it again with an administrator’s account.`
      );
    } else if (found === "failed") {
      setProblem(
        t`I could not read ${signIn} just now. Try again in a moment, or use a staff list.`
      );
    }
    setReading(null);
    void navigate({ to: "/setup", search: { step: "company" }, replace: true });
  };
  const readOnce = useRef(false);
  useEffect(() => {
    if (returned && !readOnce.current) {
      readOnce.current = true;
      void readOnReturn();
    }
  });
  // The sign-in in use: kept on this visit, or, coming back, the one connected; none for a staff list.
  const inUse = directoryShown(kept, roster === null ? null : directory);
  const listInUse = roster !== null && inUse === null;
  const { title, body, spoken } = useWords(suites);
  return (
    <CalmStep
      body={body}
      end={<CompanyWay known={roster !== null} onward={props.onward} />}
      spoken={spoken}
      title={title}
    >
      <div {...stylex.props(styles.stack)}>
        {suites.length > 0 ? (
          <>
            <ItemGroup aria-label={t`Your sign-in`}>
              {suites.map((suite) => (
                <SignInRow
                  done={inUse === suite}
                  key={suite}
                  onConnect={() => {
                    if (reading === null) {
                      void connect(suite);
                    }
                  }}
                  suite={suite}
                  waiting={reading === suite}
                />
              ))}
            </ItemGroup>
            <div {...stylex.props(styles.or)}>
              <Separator decorative style={styles.orLine} />
              <Text color="muted" size="sm">
                {t`Or use a staff list`}
              </Text>
              <Separator decorative style={styles.orLine} />
            </div>
          </>
        ) : null}
        <StaffListDrop
          disabled={reading !== null && reading !== "list"}
          inUse={listInUse}
          onUpload={upload}
        />
        <WaitingNote waiting={waiting} />
      </div>
      <CompanyError
        connect={connect}
        notConnected={notConnected}
        onClose={() => {
          setNotConnected(null);
          setProblem(null);
        }}
        problem={problem}
      />
    </CalmStep>
  );
};
