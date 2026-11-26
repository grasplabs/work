/**
 * Everyone in the company's platform, a tab of its Details, as Grasp Work
 * lists people: how many seats are taken and where its members stand in a
 * few figures, then each member a row (a card on a phone) with their
 * email, where they stand and their role; a row writes to them.
 *
 * Core sends its members once they made their account, so nobody here
 * is still invited, and it doesn't say which of them is Grasp's own
 * staff. Nor are the prototype's invitation, role change and taking
 * access away here: the admin can't do those in a company's Grasp.
 */
import type { MemberView } from "@grasp-os/shared/admin/admin-account";
import type { MemberRole } from "@grasp-os/shared/admin/onboarding-admin";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import {
  Section as Part,
  SectionHeader,
} from "@grasp-os/ui/components/section-header";
import { Stat, StatGroup } from "@grasp-os/ui/components/stat";
import { UsersIcon } from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";

import { DataRows } from "./data-rows.tsx";
import type { DataColumn, RowLook } from "./data-rows.tsx";
import { useOrganization } from "./organization.tsx";
import { formatDate, plural } from "./words.ts";

const styles = stylex.create({
  parts: { display: "flex", flexDirection: "column", gap: space["10"] },
});

/** A role in the platform, as the company's own Members page says it. */
const roleWords: Record<MemberRole, string> = {
  owner: "Owner",
  admin: "Admin",
  builder: "Builder",
  user: "User",
  viewer: "Viewer",
};

/** Where someone stands, in one line with its days. */
const standsLine = (member: MemberView): string => {
  const invited = formatDate(member.invited);
  const joined = member.joined === undefined ? "" : formatDate(member.joined);
  if (member.state === "removed") {
    return "Access taken away";
  }
  if (member.state === "invited") {
    return member.resent === null
      ? `Invited on ${invited}`
      : `Invited on ${invited}, and again on ${formatDate(member.resent)}`;
  }
  if (member.state === "ready") {
    return `Ready since ${joined}`;
  }
  return member.seen === null
    ? `In since ${joined}`
    : `In since ${joined}, last in on ${formatDate(member.seen)}`;
};

/** A member by name, or by their email while they have none. */
const nameOf = (member: MemberView): string =>
  member.name === "" ? member.email : member.name;

/** Their email under a name, with their title; nothing for someone known by their email alone. */
const aboutOf = (member: MemberView): string | null => {
  const about = [member.name === "" ? "" : member.email, member.title]
    .filter((part) => part !== "")
    .join(" · ");
  return about === "" ? null : about;
};

const columns: readonly DataColumn<MemberView>[] = [
  {
    id: "about",
    head: "Email",
    cell: (member) => aboutOf(member) ?? "",
    fact: aboutOf,
  },
  { id: "stands", head: "Where they stand", cell: standsLine, wrap: true },
  { id: "role", head: "Role", cell: (member) => roleWords[member.role] },
];

/** A row writes to the member, as their email is all the admin has of them. */
const memberLink = (member: MemberView, look: RowLook) => (
  <a
    aria-label={`Write to ${nameOf(member)}`}
    href={`mailto:${member.email}`}
    {...look}
  />
);

const memberKey = (member: MemberView): string => member.id;

/** How many there are by where they stand. */
const countOf = (
  members: readonly MemberView[],
  state: MemberView["state"]
): number => members.filter((member) => member.state === state).length;

/** An organization's Members: its seats and where its people stand, then each of them. */
export const OrgMembers = () => {
  const { view } = useOrganization();
  const { members, seats } = view;
  if (members.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia icon={UsersIcon} variant="icon" />
          <EmptyTitle level={2}>Nobody has made an account yet.</EmptyTitle>
          <EmptyDescription>
            Each member is here, with where they stand and their role, once they
            made their account in the company’s Grasp.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  const ready = countOf(members, "ready");
  const removed = countOf(members, "removed");
  const notIn = [
    ready === 0 ? "" : `${ready} ready for when Grasp opens`,
    removed === 0 ? "" : `${removed} with access taken away`,
  ].filter((part) => part !== "");
  return (
    <div {...stylex.props(styles.parts)}>
      <StatGroup aria-label="Its members" columns={2}>
        <Stat
          // A contract not known yet gives no number of seats either.
          change={
            view.unknown.contract
              ? "No contract known yet"
              : `of ${seats.of} on its contract`
          }
          label="Seats taken"
          value={String(seats.used)}
        />
        <Stat
          change={notIn.length === 0 ? "Everyone" : notIn.join(", ")}
          label="In Grasp"
          value={String(countOf(members, "active"))}
        />
      </StatGroup>
      <Part aria-labelledby="members">
        <SectionHeader
          id="members"
          size="sm"
          title={`${members.length} ${plural(members.length, "member", "members")}`}
          variant="group"
        />
        <DataRows
          columns={columns}
          label="Its members"
          link={memberLink}
          name={nameOf}
          nameHead="Member"
          rowKey={memberKey}
          rows={members}
        />
      </Part>
    </div>
  );
};
