import {
  directoryErrors,
  directorySuiteSchema,
} from "@grasp-os/shared/directory";
import type {
  DirectorySuite,
  OnboardingDirectoryAccount,
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
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@grasp-os/ui/components/input-group";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Separator } from "@grasp-os/ui/components/separator";
import { Text } from "@grasp-os/ui/components/text";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import {
  CircleCheckIcon,
  FileIcon,
  Icon,
  PlusIcon,
} from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { msg, plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { TopError } from "../frame/top-error.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { prepare, say } from "../voice/voice.ts";
import { CalmStep } from "./calm-frame.tsx";
import { useConnectionReturn } from "./connection-return.ts";
import {
  csvRows,
  directoryListOf,
  exampleList,
  StaffListError,
  staffListOf,
  addedTo,
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
// in, it shows on the step as read, Stephen says he has it, and the step
// moves on by itself: no page in between to confirm it (Ruben). Coming back,
// the sign-in in use is marked done, and a new list replaces the one kept.
// Never forced: without a list the admin skips on, and Grasp's own people
// sort the list out with them in their talks.

const styles = stylex.create({
  stack: { display: "grid", gap: space[4] },
  // The ways in, kept mounted (the upload is still settling) but out of sight while the list comes in.
  gone: { display: "none" },
  // Another account: which kind, then its domain and Connect, in one column.
  add: { display: "grid", gap: space[2] },
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
    return addedTo(staffListOf(rows, noTeam).roster, saved);
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
  saved: Roster | null,
  connectionId: string | null
): Promise<
  { roster: RosterInput; suite: DirectorySuite } | DirectoryProblem
> => {
  try {
    const { people, suite } = await core.withSession(async (session) =>
      connectionId === null
        ? await session.onboarding.readDirectory()
        : await session.onboarding.readDirectoryAccount(connectionId)
    );
    return {
      roster: addedTo(directoryListOf(people, noTeam).roster, saved),
      suite,
    };
  } catch (error) {
    if (error instanceof StaffListError) {
      return error.reason === "empty" ? "empty" : "large";
    }
    return directoryProblemOf(error);
  }
};

/**
 * Starts connecting the directory of `suite`, the company's own or, named
 * by its `domain`, another of its accounts: the browser goes to its
 * sign-in and comes back here. Why it could not start, if it couldn't:
 * a domain no account answers for, or a failure of the moment.
 */
const startDirectory = async (
  core: ReturnType<typeof useCore>,
  suite: DirectorySuite,
  domain?: string
): Promise<"unknown" | "failed" | null> => {
  try {
    const { url } = await core.withSession(async (session) =>
      domain === undefined
        ? await session.onboarding.connectDirectory(suite, companyStep)
        : await session.onboarding.connectOtherDirectory(
            suite,
            domain,
            companyStep
          )
    );
    window.location.assign(url);
    return null;
  } catch (error) {
    const code = directoryErrors.codeOf(error);
    return code === "directory.unknown_domain" || code === "directory.invalid"
      ? "unknown"
      : "failed";
  }
};

/** Whoever is new on a list saved while the plan runs gets no link until the admin has chosen again who takes part (the leads step). */
export const WaitingNote = ({ waiting }: { waiting: number }) =>
  waiting > 0 ? (
    <Text>
      {plural(waiting, {
        one: "# person is new on your list. Their link goes out once you’ve chosen who takes part.",
        other:
          "# people are new on your list. Their links go out once you’ve chosen who takes part.",
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
      spoken: t`Next, let’s bring in your company directory. Connect your work account so I can see who works where—that way I’ll know who to reach out to later.`,
    };
  }
  if (suites[0] !== undefined) {
    const signIn = suiteNames[suites[0]];
    return {
      title: t`Connect your ${signIn} account`,
      body: null,
      spoken: t`Next, let’s bring in your company directory. Connect your ${signIn} account so I can see who works where—that way I’ll know who to reach out to later.`,
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
  known,
}: {
  onUpload: (file: File) => Promise<void>;
  disabled: boolean;
  /** Coming back with a roster: another list adds to it. */
  known: boolean;
}) => {
  const { t } = useLingui();
  return (
    <div {...stylex.props(styles.drop)}>
      <FileUpload
        accept={[".csv", ".tsv", ".txt", ".xlsx"]}
        description={
          known
            ? t`Another list adds its people to the ones I have.`
            : t`A CSV or Excel file, one row per person`
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
 * A sign-in, as a row pressed to connect it: the company's own account
 * at a suite, or, once connected, any of its accounts, marked done, and
 * pressed again to connect it anew.
 */
const SignInRow = ({
  suite,
  label,
  done,
  onConnect,
}: {
  suite: DirectorySuite;
  label: string;
  done: boolean;
  onConnect: () => void;
}) => (
  <Item onClick={onConnect} variant="outline">
    <ItemMedia>
      <BrandIcon
        decorative
        logo={suiteLogos[suite]}
        name={suiteNames[suite]}
        size="sm"
      />
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

/** An account connected, as its row names it: the company's own by its suite, another by its domain where Google says it. */
const useAccountLabel = (): ((
  account: OnboardingDirectoryAccount
) => string) => {
  const { t } = useLingui();
  return (account) => {
    const signIn = suiteNames[account.suite];
    if (account.status !== "active") {
      return t`Connect ${signIn} again`;
    }
    if (account.own) {
      return t`${signIn} is connected`;
    }
    return account.suite === "google"
      ? t`${account.tenant} is connected`
      : t`Another ${signIn} account is connected`;
  };
};

/**
 * Another of the company's accounts, by its domain: a second Microsoft
 * tenant, a Google domain of a daughter company. Pressed open, it asks
 * which kind and the domain, and connects it; everyone in it joins the
 * roster, each email once.
 */
const AddAccount = ({
  suites,
  busy,
  onAdd,
}: {
  suites: DirectorySuite[];
  busy: boolean;
  onAdd: (suite: DirectorySuite, domain: string) => void;
}) => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [first = "microsoft"] = suites;
  const [suite, setSuite] = useState<DirectorySuite>(first);
  const [domain, setDomain] = useState("");
  if (!open) {
    return (
      <Item
        onClick={() => {
          setOpen(true);
        }}
        variant="outline"
      >
        <ItemMedia>
          <Icon icon={PlusIcon} />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>{t`Add another account`}</ItemTitle>
        </ItemContent>
      </Item>
    );
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onAdd(suite, domain.trim());
      }}
      {...stylex.props(styles.add)}
    >
      {suites.length > 1 ? (
        <ToggleGroup
          aria-label={t`Which kind of account`}
          onValueChange={(value) => {
            const picked = directorySuiteSchema.safeParse(value[0]);
            if (picked.success) {
              setSuite(picked.data);
            }
          }}
          value={[suite]}
        >
          {suites.map((each) => (
            <ToggleGroupItem key={each} value={each}>
              {suiteNames[each]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      ) : null}
      <InputGroup>
        <InputGroupInput
          aria-label={t`The account’s domain`}
          autoFocus
          onChange={(event) => {
            setDomain(event.target.value);
          }}
          placeholder={t`other-company.com`}
          value={domain}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            disabled={busy || domain.trim() === ""}
            type="submit"
            variant="default"
          >
            {t`Connect`}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </form>
  );
};

/**
 * The ways in by sign-in: before any, the company's own account at each
 * suite; once there is a roster, every account connected (its own and its
 * others), the own account of a suite not yet connected, and a way to add
 * another account.
 */
const SignIns = ({
  suites,
  accounts,
  known,
  reading,
  onConnect,
  onAdd,
}: {
  suites: DirectorySuite[];
  accounts: OnboardingDirectoryAccount[];
  known: boolean;
  reading: DirectorySuite | "list" | null;
  onConnect: (
    suite: DirectorySuite,
    account?: OnboardingDirectoryAccount
  ) => void;
  onAdd: (suite: DirectorySuite, domain: string) => void;
}) => {
  const { t } = useLingui();
  const labelOf = useAccountLabel();
  const shown = known ? accounts : [];
  const ownShown = new Set(
    shown.filter(({ own }) => own).map(({ suite }) => suite)
  );
  return (
    <ItemGroup aria-label={t`Your sign-in`}>
      {shown.map((account) => (
        <SignInRow
          done={account.status === "active"}
          key={account.id}
          label={labelOf(account)}
          onConnect={() => {
            onConnect(account.suite, account);
          }}
          suite={account.suite}
        />
      ))}
      {suites
        .filter((suite) => !ownShown.has(suite))
        .map((suite) => (
          <SignInRow
            done={false}
            key={suite}
            label={
              reading === suite
                ? t`Waiting for ${suiteNames[suite]}`
                : t`Continue with ${suiteNames[suite]}`
            }
            onConnect={() => {
              onConnect(suite);
            }}
            suite={suite}
          />
        ))}
      {shown.length > 0 ? (
        <AddAccount busy={reading !== null} onAdd={onAdd} suites={suites} />
      ) : null}
    </ItemGroup>
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

/** What came in on this visit: from where, and how many in how many teams. */
interface Kept {
  from: DirectorySuite | "list";
  people: number;
  teams: number;
}

/** "1 person", "12 people": the count with its word, in the page's language. */
const peopleWords = (count: number): string =>
  plural(count, { one: "# person", other: "# people" });

/** "1 team", "3 teams". */
const teamWords = (count: number): string =>
  plural(count, { one: "# team", other: "# teams" });

/**
 * The list as it comes in, in place of the ways in, for the moment
 * Stephen says he has it: where from, done, and how many. Not a page of
 * its own: the step moves on as he finishes.
 */
const ReadRow = ({ kept }: { kept: Kept }) => {
  const { t } = useLingui();
  const { from } = kept;
  const people = peopleWords(kept.people);
  const teams = teamWords(kept.teams);
  return (
    <ItemGroup aria-label={t`What came in`}>
      <Item variant="outline">
        <ItemMedia>
          {from === "list" ? (
            <Icon icon={FileIcon} />
          ) : (
            <BrandIcon
              decorative
              logo={suiteLogos[from]}
              name={suiteNames[from]}
              size="sm"
            />
          )}
        </ItemMedia>
        <ItemContent>
          <ItemTitle>
            {from === "list"
              ? t`Your staff list is in`
              : t`${suiteNames[from]} is connected`}
          </ItemTitle>
          <ItemDescription>{t`${people} in ${teams}`}</ItemDescription>
        </ItemContent>
        <ItemActions>
          <Icon icon={CircleCheckIcon} />
        </ItemActions>
      </Item>
    </ItemGroup>
  );
};

/** What Stephen says of the company: known by now, as the list comes in; or, as the next step arrives, left for later. */
const companyLeft = {
  known: msg`Good, now I have a clear picture of who works where.`,
  later: msg`No staff list for now—that’s fine. We’ll add it together later.`,
};

export const CompanyStep = (props: StepProps) => {
  const { t, i18n } = useLingui();
  const core = useCore();
  const { run } = useCoreAction();
  const refresh = useRefresh();
  const navigate = useNavigate();
  const search: unknown = useSearch({ strict: false });
  const returned = returnedSchema.safeParse(search).success;
  const [reading, setReading] = useState<DirectorySuite | "list" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Kept on this visit, from where and how many: shown as read while Stephen says so, then the step moves on.
  const [kept, setKept] = useState<Kept | null>(null);
  const { roster } = props.data.view;
  const { directory, suites } = props.data;
  const accounts = props.data.directoryAccounts ?? [];
  // A sign-in that didn't connect, back refused or not started: said over the step, with the way on.
  const [notConnected, setNotConnected] = useNotConnected(suites);
  // He says it's in right here, as it comes in; the next step only says it can wait, when skipped.
  useLeaving(roster === null ? companyLeft.later : null);
  const gotIt = i18n._(companyLeft.known);
  useEffect(() => {
    prepare(gotIt);
  }, [gotIt]);
  const noTeam = t({
    message: "Other",
    context: "the team for people a staff list gives no team",
  });
  const peopleMost = onboardingPeopleMax;
  const teamsMost = onboardingTeamsMax;
  // Kept in core and shown as read, Stephen says he has it, and on to the next step by itself:
  // nothing in between to confirm.
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
    setKept({ from, people: found.people.length, teams: found.teams.length });
    await refresh();
    await say(gotIt);
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
  const connect = async (suite: DirectorySuite, domain?: string) => {
    setReading(suite);
    setProblem(null);
    const signIn = suiteNames[suite];
    const failed = await startDirectory(core, suite, domain);
    if (failed === "unknown") {
      setProblem(
        t`I could not find a ${signIn} account for ${domain ?? ""}. Check how it is spelled.`
      );
    } else if (failed === "failed") {
      setNotConnected({
        suite,
        why: t`I could not reach ${signIn} just now. Try again in a moment, or use a staff list.`,
      });
    }
    if (failed !== null) {
      setReading(null);
    }
  };
  // Back from the sign-in: the directory is read once, made a roster and kept, and the step moves on;
  // when it can't be, the step stays, says why, and the address forgets the connection.
  const readOnReturn = async () => {
    // The account whose sign-in came back: the connection in the address, one of several.
    const connectionId =
      returnedSchema.safeParse(search).data?.connection ?? null;
    const account = accounts.find(({ id }) => id === connectionId);
    const suite = account?.suite ?? directory?.suite ?? null;
    setReading(suite ?? "list");
    setProblem(null);
    const found = await readDirectoryRoster(
      core,
      noTeam,
      roster,
      account === undefined ? null : account.id
    );
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
  const { title, body, spoken } = useWords(suites);
  return (
    <CalmStep
      body={body}
      end={
        // While the list comes in, nothing to press: the step moves on as Stephen finishes.
        kept === null ? (
          <CompanyWay known={roster !== null} onward={props.onward} />
        ) : null
      }
      spoken={spoken}
      title={title}
    >
      {kept === null ? null : <ReadRow kept={kept} />}
      <div {...stylex.props(kept === null ? styles.stack : styles.gone)}>
        {suites.length > 0 ? (
          <>
            <SignIns
              accounts={accounts}
              known={roster !== null}
              onAdd={(suite, domain) => {
                void connect(suite, domain);
              }}
              onConnect={(suite, account) => {
                if (reading === null) {
                  // Another account connects again by its own tenant; the company's own as ever.
                  void connect(
                    suite,
                    account === undefined || account.own
                      ? undefined
                      : account.tenant
                  );
                }
              }}
              reading={reading}
              suites={suites}
            />
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
          known={roster !== null}
          onUpload={upload}
        />
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
