import type {
  Project,
  ProjectMember,
  ProjectMemberRef,
  ProjectRole,
  ProjectShareCandidates,
} from "@grasp-os/shared/projects";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@grasp-os/ui/components/alert-dialog";
import { Avatar, AvatarFallback } from "@grasp-os/ui/components/avatar";
import { Button } from "@grasp-os/ui/components/button";
import { Combobox, ComboboxEmpty } from "@grasp-os/ui/components/combobox";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import type { SelectItems } from "@grasp-os/ui/components/select";
import { Text } from "@grasp-os/ui/components/text";
import { Icon, UsersIcon } from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";

import { useAppRead } from "../apps/use-app-read.ts";
import { changeThenRefresh } from "../change-then-refresh.ts";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { roleLabel } from "../labels.ts";
import { usePeopleApart } from "../people/people-apart.ts";
import type { Named, PeopleApart } from "../people/people-apart.ts";
import { useCoreAction } from "../use-core-action.ts";
import { usePages } from "./project-pages.ts";

// Who is in a project: its owner, who always builds it, and the people and
// teams in it, each a user (sees it) or a builder (also changes it), as
// Damsko's share dialog lays them out (blocks/share-dialog-01): the add
// row on top, then everyone in it with their role. Being in a project
// reaches only what is shared with it. Its builders add people and teams
// from whom core offers, change a role at the row's end and take someone
// out, which first names what they lose; everyone else sees the list
// alone. Built here from Damsko's parts, as the block has no way to page
// a long list of members or say core's reason.

const NARROW = "@container (width < 30rem)";

const styles = stylex.create({
  section: {
    display: "grid",
    rowGap: space["6"],
    containerType: "inline-size",
  },
  // The add row: the picker takes what is left; on a narrow dialog it has a line of its own.
  add: {
    display: "grid",
    gridTemplateColumns: {
      default: "minmax(0, 1fr) auto auto",
      [NARROW]: "minmax(0, 1fr) auto",
    },
    gridTemplateAreas: {
      default: '"who role go"',
      [NARROW]: '"who who" "role go"',
    },
    gap: space["2"],
    alignItems: "start",
  },
  who: { gridArea: "who", minWidth: 0 },
  role: { gridArea: "role", minWidth: 0 },
  go: { gridArea: "go" },
  list: { display: "grid", rowGap: space["2"] },
  // The owner's role, where the others have their select: level with its words.
  owner: { paddingInlineEnd: space["2"] },
});

/** The roles to give, from least to most. */
const roles: readonly ProjectRole[] = ["user", "builder"];

/** A choice in a member's roles that is not a role: it takes them out. */
const remove = "\u0000remove";

/** A member's or a candidate's key: its kind and its ID. */
const keyOf = ({ type, id }: ProjectMemberRef): string => `${type}:${id}`;

/** The member a key names, back from the picker. */
const refOf = (key: string): ProjectMemberRef | undefined => {
  const [type, ...rest] = key.split(":");
  const id = rest.join(":");
  return type === "person" || type === "team" ? { type, id } : undefined;
};

/** Whom core offers to add: all but who is in it already, its owner included. */
const readCandidates = async (
  session: Session,
  project: string
): Promise<ProjectShareCandidates> =>
  await session.projects.shareCandidates(project);

/** A member as listed: a team says so, a person is told apart from a namesake. */
const useMemberName = (apart: PeopleApart) => {
  const { t } = useLingui();
  return (member: ProjectMember): string => {
    const name = member.name ?? member.id;
    return member.type === "team"
      ? t`${name} (team)`
      : apart.named({ id: member.id, name });
  };
};

/**
 * The project's people the page has read, its owner first, by name. A
 * namesake on a page of members not read yet isn't among them: reading
 * the next page tells them apart then.
 */
const knownPeople = (
  project: Project,
  members: readonly ProjectMember[]
): Named[] =>
  [project.owner, ...members.filter(({ type }) => type === "person")].flatMap(
    ({ id, name }) => (name === null ? [] : [{ id, name }])
  );

/** A person's face, or a team's icon. */
const Face = ({ name, team }: { name: string; team: boolean }) =>
  team ? (
    <Icon icon={UsersIcon} />
  ) : (
    <Avatar decorative name={name} size="sm">
      <AvatarFallback />
    </Avatar>
  );

/** Someone in the project: their face, their name, and their role or what a builder does with it. */
const MemberRow = ({
  name,
  team,
  children,
}: {
  name: string;
  team: boolean;
  children: ReactNode;
}) => (
  <Item size="xs">
    <ItemMedia align="center">
      <Face name={name} team={team} />
    </ItemMedia>
    <ItemContent>
      <ItemTitle>{name}</ItemTitle>
    </ItemContent>
    <ItemActions>{children}</ItemActions>
  </Item>
);

/** A role in words, as whoever only looks sees it. */
const RoleWords = ({ children }: { children: string }) => (
  <span {...stylex.props(styles.owner)}>
    <Text as="span" color="muted" size="sm">
      {children}
    </Text>
  </span>
);

/**
 * Adding people and teams, for the project's builders: whom core offers,
 * in a picker, at the role chosen. `known` is who is in it, read so far,
 * whom someone offered is told apart from too.
 */
const AddRow = ({
  project,
  known,
  change,
}: {
  project: Project;
  known: readonly Named[];
  change: (action: (session: Session) => Promise<unknown>) => Promise<boolean>;
}) => {
  const { t } = useLingui();
  // Read again whenever the project is (after an add, a change or a
  // removal), so who was just added isn't offered again.
  const offered = useAppRead(project.id, readCandidates);
  const [picked, setPicked] = useState<string | null>(null);
  const [role, setRole] = useState<ProjectRole>("user");
  const people = offered?.state === "ready" ? offered.data.people : [];
  const teams = offered?.state === "ready" ? offered.data.teams : [];
  const apart = usePeopleApart([...known, ...people]);
  const add = async (): Promise<void> => {
    const ref = picked === null ? undefined : refOf(picked);
    if (ref === undefined) {
      return;
    }
    const done = await change(async (session) => {
      await session.projects.addMember(project.id, { ...ref, role });
    });
    if (!done) {
      // The Button says it wasn't added; core's reason shows under the list.
      throw new Error("Not added.");
    }
    setPicked(null);
  };
  return (
    <div {...stylex.props(styles.add)}>
      <div {...stylex.props(styles.who)}>
        <Combobox
          aria-label={t`Search people and teams`}
          disabled={offered === undefined}
          items={[
            ...people.map((person) => {
              const note = apart.hint(person);
              return {
                value: keyOf({ type: "person", id: person.id }),
                label: person.name,
                ...(note === undefined ? {} : { description: note }),
                media: (
                  <Avatar decorative name={person.name} size="xs">
                    <AvatarFallback />
                  </Avatar>
                ),
              };
            }),
            ...teams.map((team) => {
              const { name } = team;
              return {
                value: keyOf({ type: "team", id: team.id }),
                label: t`${name} (team)`,
                media: <Icon icon={UsersIcon} />,
              };
            }),
          ]}
          media={<Icon icon={UsersIcon} />}
          onValueChange={setPicked}
          placeholder={t`Search people and teams`}
          value={picked}
        >
          <ComboboxEmpty>
            <Trans>Nobody else to add.</Trans>
          </ComboboxEmpty>
        </Combobox>
      </div>
      <div {...stylex.props(styles.role)}>
        <Select
          items={roles.map((each) => ({ value: each, label: roleLabel(each) }))}
          onValueChange={(value) => {
            const chosen = roles.find((each) => each === value);
            if (chosen !== undefined) {
              setRole(chosen);
            }
          }}
          value={role}
        >
          <SelectTrigger aria-label={t`Role in the project`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent />
        </Select>
      </div>
      <div {...stylex.props(styles.go)}>
        <Button
          disabled={picked === null}
          errorLabel={t`Not added`}
          loadingLabel={t`Adding`}
          onClick={add}
        >
          <Trans context="put in a project">Add</Trans>
        </Button>
      </div>
      {offered !== undefined && offered.state !== "ready" ? (
        <ErrorText>{t`Who to add couldn't be read. Try again in a moment.`}</ErrorText>
      ) : null}
    </div>
  );
};

/**
 * Taking someone out, once the builder says so in the alert dialog that
 * names what they lose. `removing` is who, while it asks.
 */
const RemoveDialog = ({
  project,
  removing,
  name,
  onClose,
  change,
}: {
  project: Project;
  removing: ProjectMember | undefined;
  name: string;
  onClose: () => void;
  change: (action: (session: Session) => Promise<unknown>) => Promise<boolean>;
}) => {
  const { t } = useLingui();
  const [working, setWorking] = useState(false);
  const projectName = project.name;
  const takeOut = async (): Promise<void> => {
    if (removing === undefined) {
      return;
    }
    const ref: ProjectMemberRef = { type: removing.type, id: removing.id };
    setWorking(true);
    const done = await change(async (session) => {
      await session.projects.removeMember(project.id, ref);
    }).finally(() => {
      setWorking(false);
    });
    if (!done) {
      // The dialog stays open, and core's reason shows under the list.
      throw new Error("They weren't taken out.");
    }
    onClose();
  };
  return (
    <AlertDialog
      onOpenChange={(open, details) => {
        if (working) {
          details.cancel();
          return;
        }
        if (!open) {
          onClose();
        }
      }}
      open={removing !== undefined}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            <Trans>
              Take {name} out of {projectName}?
            </Trans>
          </AlertDialogTitle>
          <AlertDialogDescription>
            {project.shared === 0 ? (
              <Trans>
                Nothing is shared with the project, so they lose no access.
              </Trans>
            ) : (
              <Trans>
                They lose access to what is shared with everyone in the project,
                unless it is also shared with them another way. Their open pages
                of it stop within seconds.
              </Trans>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel />
          <Button
            errorLabel={t`Not taken out`}
            loadingLabel={t`Taking out`}
            onClick={takeOut}
            size="sm"
            variant="destructive"
          >
            <Trans>Take out</Trans>
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

/** The project's people, and for its builders adding, changing and taking them out. */
export const ProjectPeople = ({ project }: { project: Project }) => {
  const { t } = useLingui();
  const router = useRouter();
  const { failure, run } = useCoreAction();
  const [removing, setRemoving] = useState<ProjectMember>();
  const pages = usePages(
    project,
    project.members,
    project.moreMembers,
    async (session, after) => {
      const page = await session.projects.members(project.id, after);
      return { list: page.members, more: page.more };
    }
  );
  const builds = project.role === "builder";
  const known = knownPeople(project, pages.all);
  const apart = usePeopleApart(known);
  const nameOf = useMemberName(apart);
  const owner = apart.named({
    id: project.owner.id,
    name: project.owner.name ?? project.owner.id,
  });
  const ownerWord = t({ message: "Owner", context: "a project's owner" });
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
  const choices: SelectItems = [
    ...roles.map((each) => ({ value: each, label: roleLabel(each) })),
    { type: "separator" as const },
    {
      value: remove,
      label: t({ message: "Remove", context: "take out of a project" }),
    },
  ];
  return (
    <div {...stylex.props(styles.section)}>
      {builds ? (
        <AddRow change={change} known={known} project={project} />
      ) : null}
      <div {...stylex.props(styles.list)}>
        <ItemGroup aria-label={t`People in the project`}>
          <MemberRow name={owner} team={false}>
            <RoleWords>{ownerWord}</RoleWords>
          </MemberRow>
          {pages.all.map((member) => {
            const name = nameOf(member);
            return (
              <MemberRow
                key={keyOf(member)}
                name={name}
                team={member.type === "team"}
              >
                {builds ? (
                  <Select
                    items={choices}
                    onValueChange={(value) => {
                      if (value === remove) {
                        setRemoving(member);
                        return;
                      }
                      const role = roles.find((each) => each === value);
                      if (role !== undefined && role !== member.role) {
                        void change(async (session) => {
                          await session.projects.addMember(project.id, {
                            type: member.type,
                            id: member.id,
                            role,
                          });
                        });
                      }
                    }}
                    value={member.role}
                  >
                    <SelectTrigger
                      aria-label={t`Role of ${name}`}
                      size="sm"
                      variant="ghost"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent />
                  </Select>
                ) : (
                  <RoleWords>{roleLabel(member.role)}</RoleWords>
                )}
              </MemberRow>
            );
          })}
        </ItemGroup>
        {pages.more ? (
          <Button
            disabled={pages.busy}
            onClick={() => {
              void pages.readMore();
            }}
            size="sm"
            variant="secondary"
          >
            <Trans>Show more</Trans>
          </Button>
        ) : null}
        <ErrorText>{pages.failure ?? failure}</ErrorText>
      </div>
      {builds ? (
        <RemoveDialog
          change={change}
          name={removing === undefined ? "" : nameOf(removing)}
          onClose={() => {
            setRemoving(undefined);
          }}
          project={project}
          removing={removing}
        />
      ) : null}
    </div>
  );
};
