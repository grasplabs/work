import { failureText } from "@grasp-os/shared/errors";
import type { Opportunity } from "@grasp-os/shared/opportunities";
import type {
  CompanySkill,
  DecidedTeamSkill,
  ListedSkill,
  ListedTeamSkill,
  OwnSkillShare,
  SkillAudienceAsked,
  SkillProposal,
  SkillShare,
  SkillShareAudience,
  SkillInUse,
  SkillShareRequest,
  SkillsOverview,
  SkillTeam,
} from "@grasp-os/shared/skills";
import { i18n as lingui } from "@lingui/core";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useId, useRef, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDate } from "../format.ts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../grasp/alert-dialog/index.ts";
import { Badge } from "../grasp/badge/index.ts";
import { Button } from "../grasp/button/index.ts";
import { Card } from "../grasp/card/index.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../grasp/dropdown-menu/index.ts";
import { Field, FieldDescription, FieldLabel } from "../grasp/field/index.ts";
import { Heading } from "../grasp/heading/index.ts";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "../grasp/item/index.ts";
import { PageColumn } from "../grasp/page-column/index.ts";
import { PageHeader } from "../grasp/page-header/index.ts";
import { Text } from "../grasp/text/index.ts";
import { Textarea } from "../grasp/textarea/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { loadFromCore, notLoadedText } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";
import { skillOf, useStartFrom } from "./opportunity-drafts.ts";

// Skills (GRA-1754, GRA-1844): the person's own, which they write, edit
// and delete, for their own chats alone; asking to share one with the
// company or one of their teams, which waits for an admin; the company's
// skills and their teams'; and, for the organization's admins, the shares
// waiting for them, each with the exact text an approval adds and whom
// for, and retiring a shared skill. From an opportunity an admin drafts as
// a skill (`opportunity`, GRA-1751), the editor starts with a skill for
// it, to change and save as their own. Core holds every rule
// (skill-shares.ts): the page only asks. Texts are shown as text, never
// markup.

type Skills = Session["skills"];

/** What a call to core came to. */
type Read<T> =
  | { state: "loading" }
  | { state: "refused"; message: string }
  | { state: "ready"; data: T };

/**
 * What `call` answers on the person's session, or why not. Outside the
 * components, as the React Compiler can't compile `try`.
 */
const callCore = async <T,>(
  core: CoreConnection,
  call: (skills: Skills) => Promise<T>
): Promise<Read<T>> => {
  try {
    const data = await core.withSession(
      async (session) => await call(session.skills)
    );
    return { state: "ready", data };
  } catch (error) {
    return { state: "refused", message: failureText(error) };
  }
};

/**
 * What `read` answers on the person's session, or why not, as every read
 * from core is (`loadFromCore`): within its deadline, and out of reach or
 * not found said in the person's language, with the reference to quote.
 */
const readSkills = async <T,>(
  core: CoreConnection,
  read: (skills: Skills) => Promise<T>
): Promise<Read<T>> => {
  const loaded = await loadFromCore(
    core,
    async (session) => await read(session.skills)
  );
  return loaded.state === "ready"
    ? loaded
    : { state: "refused", message: notLoadedText(loaded, lingui) ?? "" };
};

/** A new skill's text, for the person to fill in. */
const newSkillText = `---
name: my-skill
description: When to use it, in one sentence.
---

The steps.
`;

const styles = stylex.create({
  // A page of the brain: its own pane that scrolls, round the library's page column.
  pane: { flexGrow: 1, minHeight: 0, overflowY: "auto" },
  section: { display: "flex", flexDirection: "column", gap: grasp.space3 },
  stack: { display: "flex", flexDirection: "column", gap: grasp.space2 },
  unread: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: grasp.space2,
  },
  row: { display: "flex", flexWrap: "wrap", gap: grasp.space2 },
  start: { alignSelf: "flex-start" },
  cards: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space3,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  // Focus lands on the heading itself once a skill is deleted.
  landing: { outline: "none" },
  // Texts are shown as text, with their own line breaks.
  plain: { whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
});

/**
 * Where the person's share stands: added (a later decision may replace it
 * since), or added and since taken out of use when its audience has no
 * such skill now (retired); otherwise waiting; declined; approved and on
 * its way to its audience's skills; or approved but overtaken by a later
 * decision before it was added.
 */
const ShareStatus = ({
  share,
  live,
}: {
  share: SkillShare;
  /** Whether its audience has a skill of its name now. */
  live: boolean;
}) => {
  const forTeam = share.audience.kind === "team";
  if (share.version !== null) {
    if (live) {
      return (
        <Badge size="sm" tone="success">
          {forTeam ? (
            <Trans>Added to the team&apos;s skills.</Trans>
          ) : (
            <Trans>Added to the company&apos;s skills.</Trans>
          )}
        </Badge>
      );
    }
    return (
      <Badge size="sm">
        {forTeam ? (
          <Trans>
            Added to the team&apos;s skills, and since taken out of use.
          </Trans>
        ) : (
          <Trans>
            Added to the company&apos;s skills, and since taken out of use.
          </Trans>
        )}
      </Badge>
    );
  }
  if (share.status === "pending") {
    return (
      <Badge size="sm" tone="attention">
        <Trans>Waiting for an admin</Trans>
      </Badge>
    );
  }
  if (share.status === "declined") {
    return (
      <Badge size="sm">
        <Trans>Declined</Trans>
      </Badge>
    );
  }
  if (share.superseded) {
    return (
      <Badge size="sm">
        <Trans>
          Approved, but a later decision on this skill came before it was added.
        </Trans>
      </Badge>
    );
  }
  return (
    <Badge size="sm" tone="attention">
      {forTeam ? (
        <Trans>Approved, but not added to the team&apos;s skills yet.</Trans>
      ) : (
        <Trans>Approved, but not added to the company&apos;s skills yet.</Trans>
      )}
    </Badge>
  );
};

/** A team's name, or its ID once the team is gone. */
const teamName = (team: { id: string; name: string | null }): string =>
  team.name ?? team.id;

/** Whom a share is for, in a whole sentence. */
const ShareAudience = ({ audience }: { audience: SkillShareAudience }) => {
  if (audience.kind === "company") {
    return <Trans>For everyone in the company</Trans>;
  }
  const team = teamName(audience.team);
  return <Trans>For the team {team}</Trans>;
};

/**
 * Why the page couldn't be read, with a way to read it again: in place of
 * the page when it never loaded, or above what it showed last.
 */
const Unread = ({
  reason,
  busy,
  onRetry,
}: {
  /** Undefined while the page reads as it should: nothing is shown. */
  reason: string | undefined;
  busy: boolean;
  onRetry: () => void;
}) => {
  const { t } = useLingui();
  return reason === undefined ? null : (
    <div {...stylex.props(styles.unread)}>
      <ErrorText>{reason}</ErrorText>
      <Button
        disabled={busy}
        onClick={onRetry}
        size="sm"
        type="button"
        variant="quiet"
      >
        {t`Try again`}
      </Button>
    </div>
  );
};

/** Asks before something that can't be undone. */
const Confirmed = ({
  label,
  title,
  description,
  confirm,
  disabled,
  onConfirm,
}: {
  label: string;
  title: string;
  description: string;
  confirm: string;
  disabled: boolean;
  onConfirm: () => void;
}) => (
  <AlertDialog>
    <AlertDialogTrigger disabled={disabled} size="sm" variant="quiet">
      {label}
    </AlertDialogTrigger>
    <AlertDialogContent>
      <AlertDialogTitle>{title}</AlertDialogTitle>
      <AlertDialogDescription>{description}</AlertDialogDescription>
      <AlertDialogFooter>
        <AlertDialogCancel />
        <AlertDialogAction
          action={() => {
            onConfirm();
          }}
          variant="danger"
        >
          {confirm}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
);

/**
 * The person's share button for a skill: share it; or, while a share of
 * it waits, nothing to do unless they saved a newer version since, which
 * asking again shares instead (the waiting one goes).
 */
const ShareLabel = ({ waiting }: { waiting: Waiting | undefined }) => {
  if (waiting === "replaceable") {
    return <Trans>Share this version instead</Trans>;
  }
  return waiting === "current" ? (
    <Trans>Waiting for an admin</Trans>
  ) : (
    <Trans>Share with the company</Trans>
  );
};

/** A share of a skill that waits: of its current text, or of an older one a new ask replaces. */
type Waiting = "current" | "replaceable";

/** The key of a skill's shares for an audience: its name, and whom for. */
const waitingKey = (name: string, audience: SkillShareAudience): string =>
  audience.kind === "company"
    ? `company ${name}`
    : `team:${audience.team.id} ${name}`;

/** Of each of the person's skills and audiences with a share that waits: which kind. */
const waitingOf = (shares: OwnSkillShare[] = []): Map<string, Waiting> =>
  new Map(
    shares
      .filter(({ status }) => status === "pending")
      .map(({ name, audience, outdated }): [string, Waiting] => [
        waitingKey(name, audience),
        outdated ? "replaceable" : "current",
      ])
  );

/** The person's teams' share of `name` that waits, by team. */
const waitingForTeams = (
  waiting: Map<string, Waiting>,
  name: string,
  teams: readonly SkillTeam[]
): Map<string, Waiting | undefined> =>
  new Map(
    teams.map(({ id }) => [
      id,
      waiting.get(waitingKey(name, { kind: "team", team: { id, name: null } })),
    ])
  );

/**
 * Sharing a skill with one of the person's teams: a team with a share of
 * its current text waiting can't be asked again; one of an older text can
 * (the waiting one goes).
 */
const ShareWithTeam = ({
  teams,
  waiting,
  disabled,
  onShare,
}: {
  teams: readonly SkillTeam[];
  waiting: Map<string, Waiting | undefined>;
  disabled: boolean;
  onShare: (team: string) => void;
}) => {
  const { t } = useLingui();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger disabled={disabled} size="sm" variant="quiet">
        {t`Share with a team`}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {teams.map((team) => (
          <DropdownMenuItem
            disabled={waiting.get(team.id) === "current"}
            key={team.id}
            onSelect={() => {
              onShare(team.id);
            }}
          >
            {team.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** Whether `page` still lists the person's own skill `name`. */
const listsOwn = (page: Read<SkillsOverview>, name: string): boolean =>
  page.state !== "ready" || page.data.own.some((skill) => skill.name === name);

/** One of the person's own skills, with what they can do with it. */
const OwnSkill = ({
  skill,
  waiting,
  teams,
  teamsWaiting,
  busy,
  reading,
  onEdit,
  onShare,
  onRemove,
}: {
  skill: ListedSkill;
  /** Undefined while no share of it with the company waits. */
  waiting: Waiting | undefined;
  /** The teams the person is in, which they may share it with. */
  teams: readonly SkillTeam[];
  /** Of each of those teams, the share of it that waits, if one does. */
  teamsWaiting: Map<string, Waiting | undefined>;
  busy: boolean;
  /** A skill is being read into the editor: nothing is deleted meanwhile. */
  reading: boolean;
  onEdit: () => void;
  onShare: (audience: SkillAudienceAsked) => void;
  onRemove: () => void;
}) => {
  const { t } = useLingui();
  const { name, version } = skill;
  return (
    <Item size="sm" variant="outline">
      <ItemContent>
        <ItemTitle>{name}</ItemTitle>
        <ItemDescription>{skill.description}</ItemDescription>
        <Text element="span" size="xs" tone="muted">
          <Trans>Version {version}</Trans>
        </Text>
      </ItemContent>
      <ItemActions>
        <Button
          disabled={busy}
          onClick={onEdit}
          size="sm"
          type="button"
          variant="quiet"
        >
          {t`Edit`}
        </Button>
        <Button
          disabled={busy || waiting === "current"}
          onClick={() => {
            onShare("company");
          }}
          size="sm"
          type="button"
          variant="quiet"
        >
          <ShareLabel waiting={waiting} />
        </Button>
        {teams.length === 0 ? null : (
          <ShareWithTeam
            disabled={busy}
            onShare={(team) => {
              onShare({ team });
            }}
            teams={teams}
            waiting={teamsWaiting}
          />
        )}
        <Confirmed
          confirm={t`Delete for good`}
          description={t`${name} and every version of it are deleted for good, with a share of it that waits. You can't use its name again.`}
          disabled={busy || reading}
          label={t`Delete`}
          onConfirm={onRemove}
          title={t`Delete ${name}?`}
        />
      </ItemActions>
    </Item>
  );
};

/** What approving a share replaces for its audience, in a whole sentence; nothing when nothing. */
const Replaces = ({ request }: { request: SkillShareRequest }) => {
  const { name, audience, replaces } = request;
  if (replaces === null) {
    return null;
  }
  if (audience.kind === "company") {
    return (
      <Text size="sm">
        {replaces === "grasp" ? (
          <Trans>
            Approving it replaces Grasp&apos;s own skill {name} for everyone.
          </Trans>
        ) : (
          <Trans>
            Approving it replaces the company&apos;s own skill {name} for
            everyone.
          </Trans>
        )}
      </Text>
    );
  }
  const team = teamName(audience.team);
  if (replaces === "team") {
    return (
      <Text size="sm">
        <Trans>
          Approving it replaces the team {team}&apos;s own skill {name} for its
          members.
        </Trans>
      </Text>
    );
  }
  return (
    <Text size="sm">
      {replaces === "grasp" ? (
        <Trans>
          Approving it replaces Grasp&apos;s own skill {name} for the members of{" "}
          {team}.
        </Trans>
      ) : (
        <Trans>
          Approving it replaces the company&apos;s own skill {name} for the
          members of {team}.
        </Trans>
      )}
    </Text>
  );
};

/** A share waiting for an admin, with the exact text approving it adds and whom for. */
const ShareRequest = ({
  request,
  busy,
  onApprove,
  onDecline,
}: {
  request: SkillShareRequest;
  busy: boolean;
  onApprove: () => void;
  onDecline: () => void;
}) => {
  const { t } = useLingui();
  const asker = request.requestedBy.name ?? request.requestedBy.userId;
  const asked = formatDate(request.requestedAt);
  const { name } = request;
  return (
    <Card element="li" padding="md">
      <div {...stylex.props(styles.stack)}>
        <Text size="sm" weight="medium">
          {name}
        </Text>
        <Text size="sm">
          <ShareAudience audience={request.audience} />
        </Text>
        <Replaces request={request} />
        <Text size="xs" tone="muted">
          <Trans>
            Asked by {asker} on {asked}
          </Trans>
        </Text>
        <Text size="sm">
          <span {...stylex.props(styles.plain)}>{request.text}</span>
        </Text>
        <div {...stylex.props(styles.row)}>
          <Button
            disabled={busy}
            onClick={onApprove}
            size="sm"
            type="button"
            variant="quiet"
          >
            {t`Approve`}
          </Button>
          <Button
            disabled={busy}
            onClick={onDecline}
            size="sm"
            type="button"
            variant="quiet"
          >
            {t`Decline`}
          </Button>
        </div>
      </div>
    </Card>
  );
};

/** One of the person's teams' skills, as their agents use it. */
const TeamSkill = ({ skill }: { skill: ListedTeamSkill }) => {
  const { name, version } = skill;
  const team = skill.team.name;
  return (
    <Item size="sm" variant="outline">
      <ItemContent>
        <ItemTitle>{name}</ItemTitle>
        <ItemDescription>{skill.description}</ItemDescription>
        <Text element="span" size="xs" tone="muted">
          <Trans>
            {team}, version {version}
          </Trans>
        </Text>
      </ItemContent>
    </Item>
  );
};

/**
 * Where a shared skill stands, in a whole sentence: the version in use,
 * and a new version or its retirement on its way; a team's by its name.
 */
const InUseLine = ({
  team,
  inUse,
}: {
  /** The team's name, or null for the company's. */
  team: string | null;
  inUse: SkillInUse;
}) => {
  const { version, onItsWay } = inUse;
  if (version === null) {
    return team === null ? (
      <Trans>Not added yet</Trans>
    ) : (
      <Trans>{team}, not added yet</Trans>
    );
  }
  if (onItsWay === "version") {
    return team === null ? (
      <Trans>Version {version}; a new version is on its way</Trans>
    ) : (
      <Trans>
        {team}, version {version}; a new version is on its way
      </Trans>
    );
  }
  if (onItsWay === "retirement") {
    return team === null ? (
      <Trans>Version {version}; being taken out of use</Trans>
    ) : (
      <Trans>
        {team}, version {version}; being taken out of use
      </Trans>
    );
  }
  return team === null ? (
    <Trans>Version {version}</Trans>
  ) : (
    <Trans>
      {team}, version {version}
    </Trans>
  );
};

/** One of the company's skills; for admins, with Retire while no retirement is on its way. */
const CompanySkillItem = ({
  skill,
  admin,
  busy,
  onRetire,
}: {
  skill: CompanySkill;
  admin: boolean;
  busy: boolean;
  onRetire: () => void;
}) => {
  const { t } = useLingui();
  const { name } = skill;
  return (
    <Item size="sm" variant="outline">
      <ItemContent>
        <ItemTitle>{name}</ItemTitle>
        {skill.description === null ? null : (
          <ItemDescription>{skill.description}</ItemDescription>
        )}
        <Text element="span" size="xs" tone="muted">
          <InUseLine inUse={skill} team={null} />
        </Text>
      </ItemContent>
      {admin && skill.onItsWay !== "retirement" ? (
        <ItemActions>
          <Confirmed
            confirm={t`Retire`}
            description={t`Nobody's agents use ${name} from then on. Its versions stay as history, and a new approved share of its name brings it back.`}
            disabled={busy}
            label={t`Retire`}
            onConfirm={onRetire}
            title={t`Retire ${name}?`}
          />
        </ItemActions>
      ) : null}
    </Item>
  );
};

/** A team's skill in use, for an admin, in the team or not: with Retire. */
const DecidedSkill = ({
  skill,
  busy,
  onRetire,
}: {
  skill: DecidedTeamSkill;
  busy: boolean;
  onRetire: () => void;
}) => {
  const { t } = useLingui();
  const { name } = skill;
  const team = teamName(skill.team);
  return (
    <Item size="sm" variant="outline">
      <ItemContent>
        <ItemTitle>{name}</ItemTitle>
        <Text element="span" size="xs" tone="muted">
          <InUseLine inUse={skill} team={team} />
        </Text>
      </ItemContent>
      {skill.onItsWay === "retirement" ? null : (
        <ItemActions>
          <Confirmed
            confirm={t`Retire`}
            description={t`The agents of ${team}'s members no longer use ${name}. Its versions stay as history, and a new approved share of its name with the team brings it back.`}
            disabled={busy}
            label={t`Retire`}
            onConfirm={onRetire}
            title={t`Retire ${name} for ${team}?`}
          />
        </ItemActions>
      )}
    </Item>
  );
};

/**
 * For the organization's admins: every team's skill in use, as core's
 * decisions have it, whether or not they are in the team, to retire one.
 */
const EveryTeamsSkills = ({
  data,
  busy,
  onRetire,
}: {
  data: SkillsOverview | undefined;
  busy: boolean;
  onRetire: (skill: DecidedTeamSkill) => void;
}) => {
  const heading = useId();
  if (data?.teamSkills === null || data?.teamSkills === undefined) {
    return null;
  }
  return (
    <section aria-labelledby={heading} {...stylex.props(styles.section)}>
      <Heading id={heading} level={2} size="ui-sm">
        <Trans>Every team&apos;s skills</Trans>
      </Heading>
      {data.teamSkills.length === 0 ? (
        <Text size="sm" tone="muted">
          <Trans>No team has a skill of its own yet.</Trans>
        </Text>
      ) : null}
      <ItemGroup>
        {data.teamSkills.map((skill) => (
          <DecidedSkill
            busy={busy}
            key={`${skill.team.id} ${skill.name}`}
            onRetire={() => {
              onRetire(skill);
            }}
            skill={skill}
          />
        ))}
      </ItemGroup>
    </section>
  );
};

/** The person's own asks to share, newest first, while they have any. */
const AskedShares = ({ data }: { data: SkillsOverview | undefined }) => {
  const heading = useId();
  if (data === undefined || data.shares.length === 0) {
    return null;
  }
  return (
    <section aria-labelledby={heading} {...stylex.props(styles.section)}>
      <Heading id={heading} level={2} size="ui-sm">
        <Trans>What you asked to share</Trans>
      </Heading>
      <ItemGroup>
        {data.shares.map((share) => (
          <Item key={share.id} size="sm">
            <ItemContent>
              <ItemTitle>{share.name}</ItemTitle>
              <Text element="span" size="xs" tone="muted">
                <ShareAudience audience={share.audience} />
              </Text>
              <Text element="span" size="xs" tone="muted">
                {formatDate(share.requestedAt)}
              </Text>
            </ItemContent>
            <ItemActions>
              <ShareStatus live={share.inUse} share={share} />
            </ItemActions>
          </Item>
        ))}
      </ItemGroup>
    </section>
  );
};

/** The person's teams' skills, while they are in a team. */
const TeamSkills = ({ data }: { data: SkillsOverview | undefined }) => {
  const heading = useId();
  if (data === undefined || data.teams.length === 0) {
    return null;
  }
  return (
    <section aria-labelledby={heading} {...stylex.props(styles.section)}>
      <Heading id={heading} level={2} size="ui-sm">
        <Trans>Your teams&apos; skills</Trans>
      </Heading>
      {data.team.length === 0 ? (
        <Text size="sm" tone="muted">
          <Trans>Your teams have no skills of their own yet.</Trans>
        </Text>
      ) : null}
      <ItemGroup>
        {data.team.map((skill) => (
          <TeamSkill key={`${skill.team.id} ${skill.name}`} skill={skill} />
        ))}
      </ItemGroup>
    </section>
  );
};

/** A skill proposed to the person, with what it rests on and the exact text adding it saves. */
const ProposedSkill = ({
  proposal,
  busy,
  onAdd,
  onDismiss,
}: {
  proposal: SkillProposal;
  busy: boolean;
  onAdd: () => void;
  onDismiss: () => void;
}) => {
  const { t } = useLingui();
  const { name, description, text, basis } = proposal;
  const workflow = basis.workflow.name;
  const { version } = basis;
  const count = basis.runs.length;
  const [latest] = basis.runs;
  const ended = latest === undefined ? "" : formatDate(latest.endedAt);
  return (
    <Card element="li" padding="md">
      <div {...stylex.props(styles.stack)}>
        <Text size="sm" weight="medium">
          {name}
        </Text>
        <Text size="sm" tone="muted">
          {description}
        </Text>
        <Text size="xs" tone="muted">
          {t`${plural(count, {
            one: `From your last run of ${workflow}, version ${version}, which succeeded on ${ended}.`,
            other: `From your last # runs of ${workflow}, version ${version}, which all succeeded, the latest on ${ended}.`,
          })}`}
        </Text>
        <Text size="sm">
          <span {...stylex.props(styles.plain)}>{text}</span>
        </Text>
        <div {...stylex.props(styles.row)}>
          <Button
            disabled={busy}
            onClick={onAdd}
            size="sm"
            type="button"
            variant="quiet"
          >
            {t`Add to your skills`}
          </Button>
          <Button
            disabled={busy}
            onClick={onDismiss}
            size="sm"
            type="button"
            variant="ghost"
          >
            {t({ message: "Dismiss", context: "a skill proposed to you" })}
          </Button>
        </div>
      </div>
    </Card>
  );
};

/**
 * The skills Grasp proposes to the person from their own runs that keep
 * succeeding: shown to them alone, used nowhere until they add one.
 * Nothing while there are none, or they couldn't be read: the rest of the
 * page doesn't depend on them.
 */
const ProposedSkills = ({ onAdded }: { onAdded: () => void }) => {
  const core = useCore();
  const heading = useId();
  const [proposals, setProposals] = useState<Read<SkillProposal[]>>({
    state: "loading",
  });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string>();

  useEffect(() => {
    let left = false;
    const read = async (): Promise<void> => {
      const answer = await readSkills(
        core,
        async (skills) => await skills.proposals()
      );
      if (!left) {
        setProposals((current) =>
          current.state === "loading" ? answer : current
        );
      }
    };
    void read();
    return () => {
      left = true;
    };
  }, [core]);

  /** Runs `call`, then reads the proposals again; `added` tells the page to read its skills again. */
  const settle = (
    call: (skills: Skills) => Promise<unknown>,
    added: boolean
  ) => {
    setBusy(true);
    setFailed(undefined);
    void (async () => {
      const answer = await callCore(core, call);
      if (answer.state === "refused") {
        setFailed(answer.message);
      } else if (added) {
        onAdded();
      }
      setProposals(
        await readSkills(core, async (skills) => await skills.proposals())
      );
      setBusy(false);
    })();
  };

  if (proposals.state !== "ready" || proposals.data.length === 0) {
    return failed === undefined ? null : <ErrorText>{failed}</ErrorText>;
  }
  return (
    <section aria-labelledby={heading} {...stylex.props(styles.section)}>
      <Heading id={heading} level={2} size="ui-sm">
        <Trans>Proposed for you</Trans>
      </Heading>
      <Text size="sm" tone="muted">
        <Trans>
          Drafted from your own runs of a workflow that keep succeeding. Only
          you see them, and none is used until you add it to your skills.
        </Trans>
      </Text>
      {failed === undefined ? null : <ErrorText>{failed}</ErrorText>}
      <ul {...stylex.props(styles.cards)}>
        {proposals.data.map((proposal) => (
          <ProposedSkill
            busy={busy}
            key={proposal.key}
            onAdd={() => {
              settle(
                async (skills) => await skills.acceptProposal(proposal.key),
                true
              );
            }}
            onDismiss={() => {
              settle(async (skills) => {
                await skills.dismissProposal(proposal.key);
              }, false);
            }}
            proposal={proposal}
          />
        ))}
      </ul>
    </section>
  );
};

/** The skills page: the person's own, their shares, the company's and their teams', and for admins what waits. */
export const SkillsPage = ({
  opportunity,
}: {
  /** The opportunity whose skill the editor starts with, once read. */
  opportunity?: Promise<Loaded<Opportunity | undefined>> | undefined;
}) => {
  const core = useCore();
  const { i18n, t } = useLingui();
  const ownHeading = useId();
  const companyHeading = useId();
  const requestsHeading = useId();
  const [overview, setOverview] = useState<Read<SkillsOverview>>({
    state: "loading",
  });
  /** Why the page couldn't be read again, while it shows what it read before. */
  const [unread, setUnread] = useState<string>();
  const [text, setText] = useState(newSkillText);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string>();
  /** The own skill the editor is reading, while it reads. */
  const [reading, setReading] = useState<string | null>(null);
  /** The read asked for last: only its reply fills the editor. */
  const lastRead = useRef<string | null>(null);
  /** Where focus goes once the page is read again after an action. */
  const focusNext = useRef<HTMLElement | null>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const ownHeadingRef = useRef<HTMLDivElement>(null);

  // Focus returns where the action left the person, once the page holds
  // still again (a disabled control takes no focus).
  useEffect(() => {
    if (!busy) {
      focusNext.current?.focus();
      focusNext.current = null;
    }
  }, [busy]);

  // The opportunity's skill, once read, fills the editor.
  useStartFrom(opportunity, (read) => {
    setText(skillOf(read, i18n));
  });

  useEffect(() => {
    let left = false;
    const read = async (): Promise<void> => {
      const answer = await readSkills(
        core,
        async (skills) => await skills.overview()
      );
      if (!left) {
        // Unless an action read the page meanwhile, which is newer.
        setOverview((current) =>
          current.state === "loading" ? answer : current
        );
      }
    };
    void read();
    return () => {
      left = true;
    };
  }, [core]);

  /**
   * Shows `page`, or, when it couldn't be read, keeps what the page showed
   * and says why, with Try again.
   */
  const show = (page: Read<SkillsOverview>) => {
    setOverview((current) =>
      page.state === "refused" && current.state === "ready" ? current : page
    );
    setUnread(page.state === "refused" ? page.message : undefined);
  };

  /**
   * Runs `call`, then reads the page again, refused or not: a refusal may
   * follow a change (an approval decided, its add failed), and the page
   * shows where things stand with why. Busy until the page is read again,
   * so no later action's page is overwritten by this one's.
   */
  const act = (
    call: (skills: Skills) => Promise<unknown>,
    after?: () => void
  ) => {
    setBusy(true);
    setFailed(undefined);
    void (async () => {
      const answer = await callCore(core, call);
      if (answer.state === "refused") {
        setFailed(answer.message);
      } else {
        after?.();
      }
      const page = await readSkills(
        core,
        async (skills) => await skills.overview()
      );
      // A read of a skill the page no longer lists fills nothing.
      if (lastRead.current !== null && !listsOwn(page, lastRead.current)) {
        lastRead.current = null;
        setReading(null);
      }
      show(page);
      setBusy(false);
    })();
  };

  /** Reads the page again, after a read that failed. */
  const readAgain = () => {
    setBusy(true);
    void (async () => {
      show(await readSkills(core, async (skills) => await skills.overview()));
      setBusy(false);
    })();
  };

  /** Fills the editor with the own skill `name`, if it is still the one asked for last. */
  const edit = (name: string) => {
    lastRead.current = name;
    setReading(name);
    setFailed(undefined);
    void (async () => {
      const answer = await readSkills(
        core,
        async (skills) => await skills.read("own", name)
      );
      if (lastRead.current !== name) {
        return;
      }
      lastRead.current = null;
      setReading(null);
      if (answer.state === "ready") {
        setText(answer.data.text);
      } else if (answer.state === "refused") {
        setFailed(answer.message);
      }
    })();
  };

  if (overview.state === "refused") {
    return <Unread busy={busy} onRetry={readAgain} reason={overview.message} />;
  }
  const data = overview.state === "ready" ? overview.data : undefined;
  const waiting = waitingOf(data?.shares);
  const teams = data?.teams ?? [];
  /** Saving or reading into the editor: it holds still meanwhile. */
  const editorBusy = busy || reading !== null;

  return (
    // A page of the brain: the title in the serif, in the library's page column.
    <div {...stylex.props(styles.pane)}>
      <PageColumn measure="page">
        <PageHeader
          description={
            <Trans>
              How things are done here: guidance that never grants access.
            </Trans>
          }
          title={<Trans context="the Brain's skills page">Skills</Trans>}
        />
        {failed === undefined ? null : <ErrorText>{failed}</ErrorText>}
        <Unread busy={busy} onRetry={readAgain} reason={unread} />

        <form
          onSubmit={(event) => {
            event.preventDefault();
            act(
              async (skills) => await skills.save(text),
              () => {
                setText(newSkillText);
                focusNext.current = editorRef.current;
              }
            );
          }}
          {...stylex.props(styles.section)}
        >
          <Field disabled={editorBusy}>
            <FieldLabel>
              <Trans>Write a skill</Trans>
            </FieldLabel>
            <Textarea
              mono
              onValueChange={setText}
              ref={editorRef}
              rows={12}
              value={text}
            />
            <FieldDescription>
              <Trans>
                A SKILL.md: a name of lowercase letters, digits and hyphens, and
                a description of when to use it, then the steps. Saving a skill
                of a name you have already makes its next version.
              </Trans>
            </FieldDescription>
          </Field>
          <Button
            disabled={editorBusy || text.trim() === ""}
            layout={styles.start}
            size="sm"
            type="submit"
            variant="ink"
          >
            {t`Save`}
          </Button>
        </form>

        <section aria-labelledby={ownHeading} {...stylex.props(styles.section)}>
          <div
            ref={ownHeadingRef}
            tabIndex={-1}
            {...stylex.props(styles.landing)}
          >
            <Heading id={ownHeading} level={2} size="ui-sm">
              <Trans>Your skills</Trans>
            </Heading>
          </div>
          {data !== undefined && data.own.length === 0 ? (
            <Text size="sm" tone="muted">
              <Trans>You have no skills of your own yet.</Trans>
            </Text>
          ) : null}
          <ItemGroup>
            {data?.own.map((skill) => (
              <OwnSkill
                busy={busy}
                key={skill.name}
                reading={reading !== null}
                onEdit={() => {
                  edit(skill.name);
                }}
                onRemove={() => {
                  act(
                    async (skills) => {
                      await skills.remove(skill.name);
                    },
                    () => {
                      focusNext.current = ownHeadingRef.current;
                    }
                  );
                }}
                onShare={(audience) => {
                  act(
                    async (skills) =>
                      await skills.share(skill.name, skill.version, audience)
                  );
                }}
                skill={skill}
                teams={teams}
                teamsWaiting={waitingForTeams(waiting, skill.name, teams)}
                waiting={waiting.get(
                  waitingKey(skill.name, { kind: "company" })
                )}
              />
            ))}
          </ItemGroup>
        </section>

        <ProposedSkills
          onAdded={() => {
            void (async () => {
              show(
                await readSkills(
                  core,
                  async (skills) => await skills.overview()
                )
              );
            })();
          }}
        />

        <AskedShares data={data} />

        {data?.requests === null || data?.requests === undefined ? null : (
          <section
            aria-labelledby={requestsHeading}
            {...stylex.props(styles.section)}
          >
            <Heading id={requestsHeading} level={2} size="ui-sm">
              <Trans>Shares waiting for you</Trans>
            </Heading>
            {data.requests.length === 0 ? (
              <Text size="sm" tone="muted">
                <Trans>Nobody is waiting for you to decide a share.</Trans>
              </Text>
            ) : (
              <ul {...stylex.props(styles.cards)}>
                {data.requests.map((request) => (
                  <ShareRequest
                    busy={busy}
                    key={request.id}
                    onApprove={() => {
                      act(async (skills) => await skills.approve(request.id));
                    }}
                    onDecline={() => {
                      act(async (skills) => await skills.decline(request.id));
                    }}
                    request={request}
                  />
                ))}
              </ul>
            )}
          </section>
        )}

        <section
          aria-labelledby={companyHeading}
          {...stylex.props(styles.section)}
        >
          <Heading id={companyHeading} level={2} size="ui-sm">
            <Trans>The company&apos;s skills</Trans>
          </Heading>
          {data !== undefined && data.company.length === 0 ? (
            <Text size="sm" tone="muted">
              <Trans>The company has no skills of its own yet.</Trans>
            </Text>
          ) : null}
          <ItemGroup>
            {data?.company.map((skill) => (
              <CompanySkillItem
                admin={data.requests !== null}
                busy={busy}
                key={skill.name}
                onRetire={() => {
                  act(async (skills) => {
                    await skills.retire(skill.name, "company");
                  });
                }}
                skill={skill}
              />
            ))}
          </ItemGroup>
        </section>

        <TeamSkills data={data} />
        <EveryTeamsSkills
          busy={busy}
          data={data}
          onRetire={(skill) => {
            act(async (skills) => {
              await skills.retire(skill.name, { team: skill.team.id });
            });
          }}
        />
      </PageColumn>
    </div>
  );
};
