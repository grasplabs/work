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
import { Separator } from "@grasp-os/ui/components/separator";
import { Text } from "@grasp-os/ui/components/text";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { ErrorText } from "../error-text.tsx";
import { formatList } from "../format.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { CalmStep } from "./calm-frame.tsx";
import { CompanyDots } from "./company-dots.tsx";
import { namedOf, useCompanyConcept } from "./company-picture.ts";
import type { CompanyConcept } from "./company-picture.ts";
import { CompanyRows } from "./company-rows.tsx";
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
// deployment signs in with, as a row pressed to connect it. Once they are
// in, the line names a few of them, so the admin sees their own company.
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
const namesOf = (roster: Roster): string[] =>
  namedOf(roster).map(({ name }) => name);

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
 * The step's title and line. Without a roster it leads with the sign-in,
 * named for what Grasp reads through it; a staff list is the way in only
 * where this deployment signs in with no suite. With one, it says who is in
 * and from where.
 */
const useWords = ({
  roster,
  another,
  fromDirectory,
  suites,
  people,
  teams,
  pictured,
}: {
  roster: Roster | null;
  /** Another list asked for, over the roster there is. */
  another: boolean;
  /** A concept draws the roster: the line says what it holds, and leaves the names to the picture. */
  pictured: boolean;
  fromDirectory: DirectorySuite | null;
  suites: DirectorySuite[];
  people: number;
  teams: number;
}): { title: string; body: string | null } => {
  const { t } = useLingui();
  if (roster !== null && another) {
    return {
      title: t`Use another staff list`,
      body: t`Share another staff list as a CSV or Excel file, a row per person. It replaces the one I have now.`,
    };
  }
  if (roster !== null) {
    const signIn = fromDirectory === null ? "" : suiteNames[fromDirectory];
    const seen =
      fromDirectory === null
        ? t`From your staff list I can see ${people} people in ${teams} teams.`
        : t`${signIn} is connected. I can see ${people} people in ${teams} teams.`;
    if (pictured) {
      return { title: t`Here’s your company`, body: seen };
    }
    // A few of them by name, so the admin sees it is their own company.
    const names = formatList(namesOf(roster));
    const among = t`Among them ${names}.`;
    return { title: t`Here’s your company`, body: `${seen} ${among}` };
  }
  // Just the ask, no line under it (Ruben: what matters is that they connect their account).
  if (suites.length > 1) {
    return { title: t`Connect your work account`, body: null };
  }
  if (suites[0] !== undefined) {
    const signIn = suiteNames[suites[0]];
    return { title: t`Connect your ${signIn} account`, body: null };
  }
  return {
    title: t`Share your staff list`,
    body: t`Share a staff list as a CSV or Excel file, a row per person. No list at hand? Skip this, and we’ll sort it out with you.`,
  };
};

/**
 * The step's ways on: Continue once there is a roster, another list or a
 * staff list instead of a sign-in, and more about it; without one, a way
 * past it. `end` holds the buttons, main first; `also` the link on its own
 * line under them.
 */
const useCompanyWays = ({
  roster,
  another,
  fromDirectory,
  onAnother,
  onward,
}: {
  roster: boolean;
  another: boolean;
  fromDirectory: DirectorySuite | null;
  onAnother: () => void;
  onward: () => Promise<void>;
}): { end: ReactNode; also: ReactNode } => {
  const { t } = useLingui();
  if (roster) {
    return {
      end: (
        <>
          <Button
            onClick={() => {
              void onward();
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
        </>
      ),
      also:
        fromDirectory === null ? (
          <SupportLink page="staffList">{t`More about the staff list`}</SupportLink>
        ) : (
          <SupportLink page="directory">{t`More about this connection`}</SupportLink>
        ),
    };
  }
  // No list yet: never forced. Grasp's own people sort it out with them in their talks. The way past
  // stands in the bottom bar, so the middle holds only the sign-in and the list.
  return {
    end: (
      <Button
        onClick={() => {
          void onward();
        }}
        size="lg"
        variant="outline"
      >
        {t`Skip for now`}
      </Button>
    ),
    also: null,
  };
};

/** Where a staff list goes: dropped or chosen right here, with an example to copy. */
const StaffListDrop = ({
  onUpload,
  disabled,
}: {
  onUpload: (file: File) => Promise<void>;
  disabled: boolean;
}) => {
  const { t } = useLingui();
  return (
    <div {...stylex.props(styles.drop)}>
      <FileUpload
        accept={[".csv", ".tsv", ".txt", ".xlsx"]}
        description={t`A CSV or Excel file, a row per person`}
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

/** Concepts only: the roster drawn, as dots (a) or as rows (b). */
const Pictured = ({
  concept,
  roster,
}: {
  concept: CompanyConcept;
  roster: Roster;
}) =>
  concept === "a" ? (
    <CompanyDots roster={roster} />
  ) : (
    <CompanyRows roster={roster} />
  );

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
  // Without a roster the sign-ins lead and the drop zone stands right under them; with one, only when another list is asked for.
  const signIns = roster === null && suites.length > 0;
  const listShown = roster === null || another;
  // Concepts only: `?concept=a|b` draws the roster, once there is one and no other list is asked for.
  const concept = useCompanyConcept();
  const pictured = concept !== null && roster !== null && !listShown;
  const { title, body } = useWords({
    another,
    pictured,
    roster,
    fromDirectory,
    suites,
    people,
    teams,
  });
  const { end, also } = useCompanyWays({
    another,
    fromDirectory,
    onAnother: () => {
      setAnother(true);
    },
    onward: props.onward,
    roster: roster !== null,
  });
  return (
    <CalmStep also={also} body={body} end={end} title={title}>
      {pictured ? <Pictured concept={concept} roster={roster} /> : null}
      {listShown || problem !== null || waiting > 0 ? (
        <div {...stylex.props(styles.stack)}>
          {signIns ? (
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
          {signIns ? (
            <div {...stylex.props(styles.or)}>
              <Separator decorative style={styles.orLine} />
              <Text color="muted" size="sm">
                {t`Or use a staff list`}
              </Text>
              <Separator decorative style={styles.orLine} />
            </div>
          ) : null}
          {listShown ? (
            <StaffListDrop
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
