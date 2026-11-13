import { failureText } from "@grasp-os/shared/errors";
import type {
  ListedSkill,
  ListedTeamSkill,
  OwnSkillShare,
  SkillAudienceAsked,
  SkillShare,
  SkillShareAudience,
  SkillShareRequest,
  SkillsOverview,
  SkillTeam,
} from "@grasp-os/shared/skills";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@grasp-os/ui/components/alert-dialog";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { Card, CardContent } from "@grasp-os/ui/components/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
} from "@grasp-os/ui/components/item";
import {
  PageHeader,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@grasp-os/ui/components/page-header";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useId, useRef, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import { useCore } from "../use-core.ts";

// Skills (GRA-1754, GRA-1844): the person's own, which they write, edit
// and delete, for their own chats alone; asking to share one with the
// company or one of their teams, which waits for an admin; the company's
// skills and their teams'; and, for the organization's admins, the shares
// waiting for them, each with the exact text an approval adds and whom
// for, and retiring a shared skill. Core holds every rule
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

/** A new skill's text, for the person to fill in. */
const newSkillText = `---
name: my-skill
description: When to use it, in one sentence.
---

The steps.
`;

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
        <Badge variant="passed">
          {forTeam ? (
            <Trans>Added to the team&apos;s skills.</Trans>
          ) : (
            <Trans>Added to the company&apos;s skills.</Trans>
          )}
        </Badge>
      );
    }
    return (
      <Badge variant="outline">
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
      <Badge variant="attention">
        <Trans>Waiting for an admin</Trans>
      </Badge>
    );
  }
  if (share.status === "declined") {
    return (
      <Badge variant="outline">
        <Trans>Declined</Trans>
      </Badge>
    );
  }
  if (share.superseded) {
    return (
      <Badge variant="outline">
        <Trans>
          Approved, but a later decision on this skill came before it was added.
        </Trans>
      </Badge>
    );
  }
  return (
    <Badge variant="attention">
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
}) =>
  reason === undefined ? null : (
    <div className="flex flex-col items-start gap-2">
      <ErrorText>{reason}</ErrorText>
      <Button
        disabled={busy}
        onClick={onRetry}
        size="sm"
        type="button"
        variant="outline"
      >
        <Trans>Try again</Trans>
      </Button>
    </div>
  );

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
    <AlertDialogTrigger
      render={
        <Button disabled={disabled} size="sm" type="button" variant="outline" />
      }
    >
      {label}
    </AlertDialogTrigger>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>{description}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>
          <Trans>Cancel</Trans>
        </AlertDialogCancel>
        <AlertDialogAction onClick={onConfirm} variant="destructive">
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
}) => (
  <DropdownMenu>
    <DropdownMenuTrigger
      render={
        <Button disabled={disabled} size="sm" type="button" variant="outline" />
      }
    >
      <Trans>Share with a team</Trans>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      {teams.map((team) => (
        <DropdownMenuItem
          disabled={waiting.get(team.id) === "current"}
          key={team.id}
          onClick={() => {
            onShare(team.id);
          }}
        >
          {team.name}
        </DropdownMenuItem>
      ))}
    </DropdownMenuContent>
  </DropdownMenu>
);

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
        <span className="text-sm font-medium">{name}</span>
        <span className="text-muted-foreground text-sm">
          {skill.description}
        </span>
        <span className="text-muted-foreground text-xs">
          <Trans>Version {version}</Trans>
        </span>
      </ItemContent>
      <ItemActions>
        <Button
          disabled={busy}
          onClick={onEdit}
          size="sm"
          type="button"
          variant="outline"
        >
          <Trans>Edit</Trans>
        </Button>
        <Button
          disabled={busy || waiting === "current"}
          onClick={() => {
            onShare("company");
          }}
          size="sm"
          type="button"
          variant="outline"
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
      <p className="text-sm">
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
      </p>
    );
  }
  const team = teamName(audience.team);
  if (replaces === "team") {
    return (
      <p className="text-sm">
        <Trans>
          Approving it replaces the team {team}&apos;s own skill {name} for its
          members.
        </Trans>
      </p>
    );
  }
  return (
    <p className="text-sm">
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
    </p>
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
  const asker = request.requestedBy.name ?? request.requestedBy.userId;
  const asked = formatDateTime(request.requestedAt);
  const { name } = request;
  return (
    <Card render={<li />} size="sm">
      <CardContent>
        <span className="text-sm font-medium">{name}</span>
        <p className="text-sm">
          <ShareAudience audience={request.audience} />
        </p>
        <Replaces request={request} />
        <p className="text-muted-foreground text-xs">
          <Trans>
            Asked by {asker} on {asked}
          </Trans>
        </p>
        <p className="text-sm whitespace-pre-wrap">{request.text}</p>
        <div className="flex gap-2">
          <Button disabled={busy} onClick={onApprove} size="sm" type="button">
            <Trans>Approve</Trans>
          </Button>
          <Button
            disabled={busy}
            onClick={onDecline}
            size="sm"
            type="button"
            variant="outline"
          >
            <Trans>Decline</Trans>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};

/** Whether `share`'s audience has a skill of its name now, as the page lists them. */
const isLive = (data: SkillsOverview, share: SkillShare): boolean => {
  const { audience, name } = share;
  return audience.kind === "company"
    ? data.company.some((skill) => skill.name === name)
    : data.team.some(
        (skill) => skill.name === name && skill.team.id === audience.team.id
      );
};

/** One of the person's teams' skills; for admins, with Retire. */
const TeamSkill = ({
  skill,
  admin,
  busy,
  onRetire,
}: {
  skill: ListedTeamSkill;
  admin: boolean;
  busy: boolean;
  onRetire: () => void;
}) => {
  const { t } = useLingui();
  const { name, version } = skill;
  const team = skill.team.name;
  return (
    <Item size="sm" variant="outline">
      <ItemContent>
        <span className="text-sm font-medium">{name}</span>
        <span className="text-muted-foreground text-sm">
          {skill.description}
        </span>
        <span className="text-muted-foreground text-xs">
          <Trans>
            {team}, version {version}
          </Trans>
        </span>
      </ItemContent>
      {admin ? (
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
      ) : null}
    </Item>
  );
};

/** The person's own asks to share, newest first, while they have any. */
const AskedShares = ({ data }: { data: SkillsOverview | undefined }) => {
  const heading = useId();
  if (data === undefined || data.shares.length === 0) {
    return null;
  }
  return (
    <section aria-labelledby={heading} className="flex flex-col gap-3">
      <h2 className="text-sm font-medium" id={heading}>
        <Trans>What you asked to share</Trans>
      </h2>
      <ItemGroup render={<ul />} spacing="tight">
        {data.shares.map((share) => (
          <li key={share.id}>
            <Item size="sm">
              <ItemContent>
                <span className="text-sm">{share.name}</span>
                <span className="text-muted-foreground text-xs">
                  <ShareAudience audience={share.audience} />
                </span>
                <span className="text-muted-foreground text-xs">
                  {formatDateTime(share.requestedAt)}
                </span>
              </ItemContent>
              <ItemActions>
                <ShareStatus live={isLive(data, share)} share={share} />
              </ItemActions>
            </Item>
          </li>
        ))}
      </ItemGroup>
    </section>
  );
};

/** The person's teams' skills, while they are in a team: for admins, with Retire. */
const TeamSkills = ({
  data,
  busy,
  onRetire,
}: {
  data: SkillsOverview | undefined;
  busy: boolean;
  onRetire: (skill: ListedTeamSkill) => void;
}) => {
  const heading = useId();
  if (data === undefined || data.teams.length === 0) {
    return null;
  }
  return (
    <section aria-labelledby={heading} className="flex flex-col gap-3">
      <h2 className="text-sm font-medium" id={heading}>
        <Trans>Your teams&apos; skills</Trans>
      </h2>
      {data.team.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          <Trans>Your teams have no skills of their own yet.</Trans>
        </p>
      ) : null}
      <ItemGroup render={<ul />} spacing="tight">
        {data.team.map((skill) => (
          <li key={`${skill.team.id} ${skill.name}`}>
            <TeamSkill
              admin={data.requests !== null}
              busy={busy}
              onRetire={() => {
                onRetire(skill);
              }}
              skill={skill}
            />
          </li>
        ))}
      </ItemGroup>
    </section>
  );
};

/** The skills page: the person's own, their shares, the company's and their teams', and for admins what waits. */
export const SkillsPage = () => {
  const { t } = useLingui();
  const core = useCore();
  const editorId = useId();
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
  const ownHeadingRef = useRef<HTMLHeadingElement>(null);

  // Focus returns where the action left the person, once the page holds
  // still again (a disabled control takes no focus).
  useEffect(() => {
    if (!busy) {
      focusNext.current?.focus();
      focusNext.current = null;
    }
  }, [busy]);

  useEffect(() => {
    let left = false;
    const read = async (): Promise<void> => {
      const answer = await callCore(
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
      const page = await callCore(
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
      show(await callCore(core, async (skills) => await skills.overview()));
      setBusy(false);
    })();
  };

  /** Fills the editor with the own skill `name`, if it is still the one asked for last. */
  const edit = (name: string) => {
    lastRead.current = name;
    setReading(name);
    setFailed(undefined);
    void (async () => {
      const answer = await callCore(
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
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="pb-chat mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 pt-8 md:px-12">
        <PageHeader>
          <PageHeaderTitle>
            <Trans context="the Brain's skills page">Skills</Trans>
          </PageHeaderTitle>
          <PageHeaderDescription>
            <Trans>
              How things are done here. Your own skills are used in your own
              chats alone. Sharing one with the company or one of your teams
              waits for an admin, and from then on the agents of everyone in it
              use it. A skill is guidance: it never grants access.
            </Trans>
          </PageHeaderDescription>
        </PageHeader>
        {failed === undefined ? null : <ErrorText>{failed}</ErrorText>}
        <Unread busy={busy} onRetry={readAgain} reason={unread} />

        <form
          className="flex flex-col gap-3"
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
        >
          <Field>
            <FieldLabel htmlFor={editorId}>
              <Trans>Write a skill</Trans>
            </FieldLabel>
            <Textarea
              disabled={editorBusy}
              id={editorId}
              ref={editorRef}
              onChange={(event) => {
                setText(event.target.value);
              }}
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
            className="self-start"
            disabled={editorBusy || text.trim() === ""}
            type="submit"
            variant="highlight"
          >
            <Trans>Save</Trans>
          </Button>
        </form>

        <section aria-labelledby={ownHeading} className="flex flex-col gap-3">
          <h2
            className="text-sm font-medium"
            id={ownHeading}
            ref={ownHeadingRef}
            tabIndex={-1}
          >
            <Trans>Your skills</Trans>
          </h2>
          {data !== undefined && data.own.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              <Trans>You have no skills of your own yet.</Trans>
            </p>
          ) : null}
          <ItemGroup render={<ul />} spacing="tight">
            {data?.own.map((skill) => (
              <li key={skill.name}>
                <OwnSkill
                  busy={busy}
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
              </li>
            ))}
          </ItemGroup>
        </section>

        <AskedShares data={data} />

        {data?.requests === null || data?.requests === undefined ? null : (
          <section
            aria-labelledby={requestsHeading}
            className="flex flex-col gap-3"
          >
            <h2 className="text-sm font-medium" id={requestsHeading}>
              <Trans>Shares waiting for you</Trans>
            </h2>
            {data.requests.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                <Trans>Nobody is waiting for you to decide a share.</Trans>
              </p>
            ) : (
              <ul className="flex flex-col gap-3">
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
          className="flex flex-col gap-3"
        >
          <h2 className="text-sm font-medium" id={companyHeading}>
            <Trans>The company&apos;s skills</Trans>
          </h2>
          {data !== undefined && data.company.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              <Trans>The company has no skills of its own yet.</Trans>
            </p>
          ) : null}
          <ItemGroup render={<ul />} spacing="tight">
            {data?.company.map((skill) => {
              const { name, version } = skill;
              return (
                <li key={name}>
                  <Item size="sm" variant="outline">
                    <ItemContent>
                      <span className="text-sm font-medium">{name}</span>
                      <span className="text-muted-foreground text-sm">
                        {skill.description}
                      </span>
                      <span className="text-muted-foreground text-xs">
                        <Trans>Version {version}</Trans>
                      </span>
                    </ItemContent>
                    {data.requests === null ? null : (
                      <ItemActions>
                        <Confirmed
                          confirm={t`Retire`}
                          description={t`Nobody's agents use ${name} from then on. Its versions stay as history, and a new approved share of its name brings it back.`}
                          disabled={busy}
                          label={t`Retire`}
                          onConfirm={() => {
                            act(async (skills) => {
                              await skills.retire(name, "company");
                            });
                          }}
                          title={t`Retire ${name}?`}
                        />
                      </ItemActions>
                    )}
                  </Item>
                </li>
              );
            })}
          </ItemGroup>
        </section>

        <TeamSkills
          busy={busy}
          data={data}
          onRetire={(skill) => {
            act(async (skills) => {
              await skills.retire(skill.name, { team: skill.team.id });
            });
          }}
        />
      </div>
    </div>
  );
};
