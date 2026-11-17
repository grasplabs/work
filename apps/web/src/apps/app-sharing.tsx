import type {
  App,
  AppMember,
  AppMemberRef,
  AppRole,
  ShareCandidates,
  ViewedApp,
} from "@grasp-os/shared/apps";
import type { Identity } from "@grasp-os/shared/rpc";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import type { Session } from "../core.ts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../grasp/alert-dialog/index.ts";
import { Alert } from "../grasp/alert/index.ts";
import { Avatar } from "../grasp/avatar/index.ts";
import { Button } from "../grasp/button/index.ts";
import { Checkbox } from "../grasp/checkbox/index.ts";
import {
  Dialog,
  DialogAction,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "../grasp/dialog/index.ts";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "../grasp/field/index.ts";
import { Icon, Folder, People, Search, UserAdd } from "../grasp/icons/index.ts";
import {
  InputGroup,
  InputGroupInput,
  InputGroupText,
} from "../grasp/input-group/index.ts";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "../grasp/select/index.ts";
import { Spinner } from "../grasp/spinner/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { roleLabel } from "../labels.ts";
import { usePeopleApart } from "../people/people-apart.ts";
import type { PeopleApart } from "../people/people-apart.ts";
import { useCoreAction } from "../use-core-action.ts";
import { buildsApp } from "./app-role.ts";

// Sharing an App (an App's): whom it is open to besides its owner and
// the admins, as a user (its pages) or a builder (its code, settings and
// whom it is shared with), in its Settings' Sharing. Each member is a row
// with their face (a team's or project's mark), their role at the row's
// end and Unshare, which asks first; Share opens a dialog to tick people,
// teams and projects by face and name, with the role to give them.
// Its builders share it, change a role and unshare it; everyone with a role
// in it sees whom it is shared with. Whom to share with comes from
// `apps.members.candidates`: the organization's people and teams by name,
// for whoever may share the App, since a builder isn't an admin and can't
// list the organization's members. Core checks every change (a builder of
// the App, not archived, and that everyone it would
// reach may read what the App has read) and records it in the audit log.

/** Whether `identity` may share `app`: a builder of it, while it isn't archived. */
export const sharesApp = (
  app: Pick<App, "archived"> & { role: AppRole },
  identity: Pick<Identity, "staff">
): boolean => buildsApp(app, identity) && !app.archived;

/** How a member is named: a team, and everyone in a project, say so. */
interface MemberWords {
  team: (name: string) => string;
  project: (name: string) => string;
  /** A project the viewer isn't in, whose name is its members' alone. */
  unnamedProject: string;
}

/** Who `member` is, in words: a person told apart from a namesake. */
const memberName = (
  member: AppMember,
  words: MemberWords,
  apart: PeopleApart
) => {
  if (member.type === "project") {
    return member.name === null
      ? words.unnamedProject
      : words.project(member.name);
  }
  const name = member.name ?? member.id;
  return member.type === "team"
    ? words.team(name)
    : apart.named({ id: member.id, name });
};

/** The people and teams App `app` is shared with. */
export const readMembers = async (
  session: Session,
  app: string
): Promise<AppMember[]> => await session.apps.members.list(app);

const styles = stylex.create({
  section: { display: "flex", flexDirection: "column", gap: grasp.space3 },
  head: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: grasp.space3,
  },
  // The candidates, scrolled within the dialog past a few.
  list: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space1,
    maxHeight: "18rem",
    overflowY: "auto",
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  candidate: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space3,
  },
  waiting: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    minHeight: grasp.controlMd,
  },
});

/** The roles to give, from least to most. */
const roles: readonly AppRole[] = ["user", "builder"];

/** A role's Select: its items in the page's language. */
const RoleSelect = ({
  role,
  label,
  disabled = false,
  onChange,
}: {
  role: AppRole;
  label: string;
  disabled?: boolean;
  onChange: (role: AppRole) => void;
}) => (
  <Select
    disabled={disabled}
    items={roles.map((each) => ({ value: each, label: roleLabel(each) }))}
    onValueChange={(value) => {
      const chosen = roles.find((each) => each === value);
      if (chosen !== undefined && chosen !== role) {
        onChange(chosen);
      }
    }}
    value={role}
  >
    <SelectTrigger aria-label={label} size="sm">
      <SelectValue />
    </SelectTrigger>
    <SelectContent />
  </Select>
);

/** Whom a member or a candidate is: a person's face, or a team's or project's mark. */
const Mark = ({ type, name }: { type: AppMemberRef["type"]; name: string }) => {
  if (type === "person") {
    return <Avatar decorative name={name} size="xs" />;
  }
  return <Icon icon={type === "team" ? People : Folder} />;
};

/** Someone, a team or a project to share with, as the dialog lists them. */
interface Candidate {
  key: string;
  ref: AppMemberRef;
  /** Their own name, for their face and the search. */
  name: string;
  /** How the list says them: a team or a project says so. */
  label: string;
  /** What tells a person apart from a namesake. */
  note?: string;
}

/** Everyone the App can still be shared with, as the dialog lists them. */
const candidatesOf = (
  offered: ShareCandidates,
  apart: PeopleApart,
  words: MemberWords
): Candidate[] => [
  ...offered.people.map((person) => {
    const note = apart.hint(person);
    return {
      key: `person:${person.id}`,
      ref: { type: "person" as const, id: person.id },
      name: person.name,
      label: person.name,
      ...(note === undefined ? {} : { note }),
    };
  }),
  ...offered.teams.map((team) => ({
    key: `team:${team.id}`,
    ref: { type: "team" as const, id: team.id },
    name: team.name,
    label: words.team(team.name),
  })),
  ...offered.projects.map((project) => ({
    key: `project:${project.id}`,
    ref: { type: "project" as const, id: project.id },
    name: project.name,
    label: words.project(project.name),
  })),
];

/** Whether `candidate` is one `typed` finds: by their name, as typed. */
const found = (candidate: Candidate, typed: string): boolean =>
  candidate.label.toLowerCase().includes(typed.trim().toLowerCase());

/** The words that say a member's kind, in the page's language. */
const useMemberWords = (): MemberWords => {
  const { t } = useLingui();
  return {
    team: (team) => t`${team} (team)`,
    project: (project) => t`Everyone in ${project}`,
    unnamedProject: t`Everyone in a project you aren’t in`,
  };
};

/** While the list is read, or why it wasn't; nothing once it is. */
const Waiting = ({
  read,
  failure,
}: {
  read: boolean;
  failure: string | undefined;
}) => {
  const { t } = useLingui();
  if (read) {
    return null;
  }
  if (failure !== undefined) {
    return <Alert title={failure} variant="danger" />;
  }
  return (
    <span {...stylex.props(styles.waiting)}>
      <Spinner />
      <Text size="sm" tone="muted">
        {t`Loading…`}
      </Text>
    </span>
  );
};

/** The dialog's list: each candidate ticked or not, by face and name. */
const Candidates = ({
  candidates,
  chosen,
  onChosen,
}: {
  candidates: readonly Candidate[];
  chosen: readonly string[];
  onChosen: (chosen: string[]) => void;
}) => {
  const { t } = useLingui();
  return (
    <ul aria-label={t`Share with`} {...stylex.props(styles.list)}>
      {candidates.map(({ key, ref, name, label, note }) => (
        <li key={key}>
          <Field orientation="horizontal">
            <Checkbox
              checked={chosen.includes(key)}
              onCheckedChange={(checked) => {
                const rest = chosen.filter((one) => one !== key);
                onChosen(checked === true ? [...rest, key] : rest);
              }}
            />
            <span {...stylex.props(styles.candidate)}>
              <Mark name={name} type={ref.type} />
              <FieldContent>
                <FieldLabel>{label}</FieldLabel>
                {note === undefined ? null : (
                  <FieldDescription>{note}</FieldDescription>
                )}
              </FieldContent>
            </span>
          </Field>
        </li>
      ))}
    </ul>
  );
};

/**
 * Share: a dialog of the organization's people, teams and projects the
 * App isn't shared with yet, read when it opens, to tick by face and
 * name, and the role to give them.
 */
export const ShareApp = ({
  app,
  members,
}: {
  app: App;
  /** Whom it is shared with now, left out of the list; none while unknown. */
  members: readonly AppMemberRef[];
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const words = useMemberWords();
  const reading = useCoreAction();
  const sharing = useCoreAction();
  const [open, setOpen] = useState(false);
  const [candidates, setCandidates] = useState<ShareCandidates>();
  const [chosen, setChosen] = useState<string[]>([]);
  const [role, setRole] = useState<AppRole>("user");
  const [typed, setTyped] = useState("");
  // Everyone in the organization, so someone is told apart from a
  // namesake it is shared with already, or its owner.
  const apart = usePeopleApart(candidates?.people ?? []);
  const shared = new Set(members.map(({ type, id }) => `${type}:${id}`));
  const isOffered = (type: AppMemberRef["type"], id: string): boolean =>
    !shared.has(`${type}:${id}`) && !(type === "person" && id === app.owner);
  const offered =
    candidates === undefined
      ? undefined
      : candidatesOf(
          {
            people: candidates.people.filter(({ id }) =>
              isOffered("person", id)
            ),
            teams: candidates.teams.filter(({ id }) => isOffered("team", id)),
            // Only the projects the person builds: sharing with one reaches
            // everyone in it, which its builders decide.
            projects: candidates.projects.filter(({ id }) =>
              isOffered("project", id)
            ),
          },
          apart,
          words
        );
  const read = async (): Promise<void> => {
    const listed = await reading.run(
      async (session) => await session.apps.members.candidates(app.id)
    );
    if (listed !== undefined) {
      setCandidates(listed);
    }
  };
  const share = async (): Promise<void> => {
    const picked = (offered ?? []).filter(({ key }) => chosen.includes(key));
    let done = false;
    await sharing.run(async (session) => {
      await changeThenRefresh(
        async () => {
          for (const { ref } of picked) {
            // oxlint-disable-next-line no-await-in-loop -- one share at a time, in the order ticked
            await session.apps.members.add(app.id, { ...ref, role });
          }
          done = true;
        },
        async () => {
          await router.invalidate({ sync: true });
        }
      );
    });
    if (!done) {
      throw new Error("Not shared.");
    }
  };
  const { name } = app;
  const shown = (offered ?? []).filter((each) => found(each, typed));
  return (
    <>
      <Button
        icon={UserAdd}
        onClick={() => {
          setChosen([]);
          setTyped("");
          setOpen(true);
          void read();
        }}
        size="sm"
        variant="quiet"
      >
        {t`Share`}
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent closeLabel={t`Close`}>
          <DialogTitle>{t`Share ${name}`}</DialogTitle>
          <DialogBody>
            <Field>
              <FieldLabel>{t`Share as`}</FieldLabel>
              <RoleSelect label={t`Share as`} onChange={setRole} role={role} />
            </Field>
            <Waiting failure={reading.failure} read={offered !== undefined} />
            {offered !== undefined && offered.length === 0 ? (
              <Text size="sm" tone="muted">
                {t`Nobody else to share with.`}
              </Text>
            ) : null}
            {offered !== undefined && offered.length > 0 ? (
              <>
                <InputGroup>
                  <InputGroupText icon={Search} />
                  <InputGroupInput
                    aria-label={t`Find someone`}
                    onValueChange={setTyped}
                    placeholder={t`Find someone`}
                    type="search"
                    value={typed}
                  />
                </InputGroup>
                <Candidates
                  candidates={shown}
                  chosen={chosen}
                  onChosen={setChosen}
                />
              </>
            ) : null}
            {sharing.failure === undefined ? null : (
              <Alert title={sharing.failure} variant="danger" />
            )}
          </DialogBody>
          <DialogFooter>
            <DialogAction>{t`Cancel`}</DialogAction>
            <DialogAction
              action={share}
              disabled={chosen.length === 0}
              failedLabel={t`Couldn't share`}
              variant="ink"
            >
              {t`Share`}
            </DialogAction>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

/** Someone the App is shared with: their role, and unsharing, for its builders. */
const MemberRow = ({
  app,
  member,
  editable,
  apart,
}: {
  app: App;
  member: AppMember;
  editable: boolean;
  /** Telling apart the people it is shared with of the same name. */
  apart: PeopleApart;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const words = useMemberWords();
  const { busy, failure, run } = useCoreAction();
  const name = memberName(member, words, apart);
  const ref: AppMemberRef = { type: member.type, id: member.id };
  const change = async (
    action: (session: Session) => Promise<unknown>
  ): Promise<boolean> => {
    let done = false;
    await run(async (session) => {
      await changeThenRefresh(
        async () => {
          await action(session);
          done = true;
        },
        async () => {
          await router.invalidate({ sync: true });
        }
      );
    });
    return done;
  };
  return (
    <Item size="sm">
      <ItemMedia>
        <Mark name={member.name ?? name} type={member.type} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{name}</ItemTitle>
        {failure === undefined ? null : (
          <ItemDescription>
            <Alert quiet title={failure} tone="danger" />
          </ItemDescription>
        )}
      </ItemContent>
      <ItemActions>
        {editable ? (
          <>
            <RoleSelect
              disabled={busy}
              label={t`Role of ${name}`}
              onChange={(role) => {
                void change(
                  async (session) =>
                    await session.apps.members.add(app.id, { ...ref, role })
                );
              }}
              role={member.role}
            />
            <AlertDialog>
              <AlertDialogTrigger
                aria-label={t`Stop sharing with ${name}`}
                disabled={busy}
                size="sm"
                variant="ghost"
              >
                {t`Unshare`}
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogTitle>{t`Stop sharing with ${name}?`}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t`Their open pages of it stop within seconds, and they can no longer open it. You can share it with them again.`}
                </AlertDialogDescription>
                <AlertDialogFooter>
                  <AlertDialogAction>{t`Cancel`}</AlertDialogAction>
                  <AlertDialogAction
                    action={async () => {
                      const done = await change(async (session) => {
                        await session.apps.members.remove(app.id, ref);
                      });
                      if (!done) {
                        throw new Error("Still shared.");
                      }
                    }}
                    failedLabel={t`Couldn't stop sharing`}
                    variant="danger"
                  >
                    {t`Stop sharing`}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        ) : (
          <Text element="span" size="sm" tone="muted">
            {roleLabel(member.role)}
          </Text>
        )}
      </ItemActions>
    </Item>
  );
};

/**
 * Who opens the App: its owner and the admins, who build it, and the
 * people, teams and projects it is shared with, each as a user or a
 * builder.
 */
export const AppMembers = ({
  app,
  members,
  identity,
}: {
  app: ViewedApp;
  members: AppMember[];
  identity: Identity;
}) => {
  const { t } = useLingui();
  const editable = sharesApp(app, identity);
  const apart = usePeopleApart(
    members.flatMap(({ type, id, name }) =>
      type === "person" && name !== null ? [{ id, name }] : []
    )
  );
  return (
    <div {...stylex.props(styles.section)}>
      <div {...stylex.props(styles.head)}>
        <Text size="sm" tone="muted">
          {app.owner === identity.userId
            ? t`Created by you. It opens for you, the admins, and whoever it is shared with.`
            : t`It opens for the member who created it, the admins, and whoever it is shared with.`}
        </Text>
        {editable ? <ShareApp app={app} members={members} /> : null}
      </div>
      {members.length === 0 ? (
        <Text size="sm" tone="muted">
          {t`It isn’t shared with anyone.`}
        </Text>
      ) : (
        <ItemGroup aria-label={t`Shared with`} separated>
          {members.map((member) => (
            <MemberRow
              apart={apart}
              app={app}
              editable={editable}
              key={`${member.type}:${member.id}`}
              member={member}
            />
          ))}
        </ItemGroup>
      )}
    </div>
  );
};
