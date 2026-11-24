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
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Link } from "@grasp-os/ui/components/link";
import { Text } from "@grasp-os/ui/components/text";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { CalmStep } from "./calm-frame.tsx";
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
import { SupportLink } from "./support-link.tsx";
import { XlsxError, xlsxMost, xlsxRows } from "./xlsx.ts";

// Who works there: from the organization's Microsoft or Google sign-in,
// connected here and read through Grasp's own read-only connection
// (names, teams, jobs and who reports to whom, nothing else), or from a
// staff list the admin shares, a CSV or Excel file with a row per person,
// read in this browser. Either way only names, email addresses, teams and
// jobs are kept, in core. A sign-in is offered for each suite this
// deployment signs in with, as a row pressed to connect it.

const styles = stylex.create({
  stack: { display: "grid", gap: space[4] },
});

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
    <Text size="lg">
      {plural(waiting, {
        one: "# person new on your list gets a link once you confirm your organization.",
        other:
          "# people new on your list get their links once you confirm your organization.",
      })}
    </Text>
  ) : null;

/** What there is now, said in the step's line: who is in, and from where; or the quickest way in. */
const useBody = ({
  roster,
  fromDirectory,
  suites,
  people,
  teams,
}: {
  roster: Roster | null;
  fromDirectory: DirectorySuite | null;
  suites: DirectorySuite[];
  people: number;
  teams: number;
}): string => {
  const { t } = useLingui();
  if (roster !== null && fromDirectory !== null) {
    const signIn = suiteNames[fromDirectory];
    return t`${signIn} is connected. I can see ${people} people in ${teams} teams.`;
  }
  if (roster !== null) {
    return t`From your staff list I can see ${people} people in ${teams} teams.`;
  }
  if (suites.length > 1) {
    return t`The quickest way is to connect your Microsoft or Google sign-in. I’ll only see names, teams and roles. Your email, chats and calendars stay closed.`;
  }
  if (suites[0] !== undefined) {
    const signIn = suiteNames[suites[0]];
    return t`The quickest way is to connect your ${signIn} sign-in. I’ll only see names, teams and roles. Your email, chats and calendars stay closed.`;
  }
  return t`A staff list is the quickest way in: names, email addresses, teams and jobs, as a CSV or Excel file. I only use it to know who to talk to.`;
};

/** The step's end: Continue once there is a roster, a staff list instead of a sign-in, and more about it. */
const CompanyEnd = ({
  roster,
  another,
  signInsFirst,
  fromDirectory,
  onAnother,
  onward,
}: {
  roster: boolean;
  another: boolean;
  signInsFirst: boolean;
  fromDirectory: DirectorySuite | null;
  onAnother: () => void;
  onward: () => void;
}) => {
  const { t } = useLingui();
  if (roster) {
    return (
      <>
        <Button
          onClick={() => {
            onward();
          }}
          size="lg"
        >
          {t`Continue`}
        </Button>
        {another ? null : (
          <Button onClick={onAnother} size="lg" variant="outline">
            {fromDirectory === null
              ? t`Use another list`
              : t`Use a staff list instead`}
          </Button>
        )}
        {fromDirectory === null ? (
          <SupportLink page="staffList">{t`More about the staff list`}</SupportLink>
        ) : (
          <SupportLink page="directory">{t`More about this connection`}</SupportLink>
        )}
      </>
    );
  }
  if (signInsFirst) {
    return (
      <>
        <Button onClick={onAnother} size="lg" variant="outline">
          {t`Use a staff list instead`}
        </Button>
        <SupportLink page="directory">{t`More about this connection`}</SupportLink>
      </>
    );
  }
  return (
    <Text as="span" size="lg">
      <Link
        download="staff-list-example.csv"
        href={`data:text/csv;charset=utf-8,${encodeURIComponent(exampleList)}`}
      >
        {t`See an example`}
      </Link>
    </Text>
  );
};

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
  // Read on this visit, and from where.
  const [fresh, setFresh] = useState<DirectorySuite | "list" | null>(null);
  // Another list, once there is one: the upload shows again.
  const [another, setAnother] = useState(false);
  const { roster, waiting } = props.data.view;
  const { directory, suites } = props.data;
  const people = roster?.people.length ?? 0;
  const teams = roster?.teams.length ?? 0;
  const noTeam = t({
    message: "Other",
    context: "the team for people a staff list gives no team",
  });
  const peopleMost = onboardingPeopleMax;
  const teamsMost = onboardingTeamsMax;
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
    await refresh();
    setFresh(from);
    setAnother(false);
    return true;
  };
  // A staff list, read here and kept in core; a refusal says why on its row and below.
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
      setProblem(
        t`I could not reach ${signIn} just now. Try again in a moment, or use a staff list.`
      );
      setReading(null);
    }
  };
  // Back from the sign-in: the directory is read once, made a roster and kept, and the address forgets the connection.
  const readOnReturn = async () => {
    const suite = directory?.suite ?? null;
    setReading(suite ?? "list");
    setProblem(null);
    const found = await readDirectoryRoster(core, noTeam, roster);
    const signIn = suite === null ? "" : suiteNames[suite];
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
    } else {
      await keep(found.roster, found.suite);
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
  const fromDirectory = directoryShown(fresh, directory);
  const body = useBody({ roster, fromDirectory, suites, people, teams });
  const signInsFirst = roster === null && suites.length > 0 && !another;
  const listShown = roster === null ? !signInsFirst : another;
  const end = (
    <CompanyEnd
      another={another}
      fromDirectory={fromDirectory}
      onAnother={() => {
        setAnother(true);
      }}
      onward={props.onward}
      roster={roster !== null}
      signInsFirst={signInsFirst}
    />
  );
  return (
    <CalmStep end={end} title={t`Who’s who at your company?`} body={body}>
      {signInsFirst || listShown || problem !== null || waiting > 0 ? (
        <div {...stylex.props(styles.stack)}>
          {signInsFirst ? (
            <ItemGroup aria-label={t`Your sign-in`}>
              {suites.map((suite) => {
                const signIn = suiteNames[suite];
                return (
                  <Item
                    key={suite}
                    onClick={() => {
                      if (reading === null) {
                        void connect(suite);
                      }
                    }}
                    variant="outline"
                  >
                    <ItemMedia>
                      <BrandIcon
                        decorative
                        logo={suiteLogos[suite]}
                        name={signIn}
                        size="sm"
                      />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>
                        {reading === suite
                          ? t`Waiting for ${signIn}`
                          : t`Continue with ${signIn}`}
                      </ItemTitle>
                    </ItemContent>
                  </Item>
                );
              })}
            </ItemGroup>
          ) : null}
          {listShown ? (
            <FileUpload
              accept={[".csv", ".tsv", ".txt", ".xlsx"]}
              description={t`A CSV or Excel file, a row per person`}
              disabled={reading !== null && reading !== "list"}
              onUpload={upload}
            />
          ) : null}
          <ErrorText>{problem ?? undefined}</ErrorText>
          <WaitingNote waiting={waiting} />
        </div>
      ) : null}
    </CalmStep>
  );
};
