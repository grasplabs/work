import type { MemberView } from "@grasp-os/shared/admin/admin-account";
import type { MemberRole } from "@grasp-os/shared/admin/onboarding-admin";
import { Avatar, AvatarFallback } from "@grasp-os/ui/components/avatar";
import { MailIcon } from "lucide-react";

import { useOrganization } from "./organization.tsx";
import { Section } from "./section.tsx";
import { formatDate } from "./words.ts";

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

/** A capitalised name's first letters, at most two: "Anna de Vries" is "AV". */
const initialsOf = (name: string): string =>
  name
    .split(" ")
    .map((part) => part.charAt(0))
    .filter((first) => first !== "" && first === first.toUpperCase())
    .slice(0, 2)
    .join("");

/** One member a row: who they are, where they stand, and their role; on a narrow screen, under each other. */
const MemberRow = ({ member }: { member: MemberView }) => {
  const name = member.name === "" ? member.email : member.name;
  const gone = member.state === "removed";
  const under = [member.name === "" ? "" : member.email, member.title]
    .filter((part) => part !== "")
    .join(" · ");
  return (
    <li className="flex flex-col gap-x-4 gap-y-2 border-t px-5 py-3 @2xl:flex-row @2xl:items-center">
      <span className="flex min-w-0 flex-1 items-center gap-3">
        <Avatar>
          <AvatarFallback>
            {/* Someone known only by their email has no initials to show. */}
            {member.name === "" ? <MailIcon aria-hidden /> : initialsOf(name)}
          </AvatarFallback>
        </Avatar>
        <span className="flex min-w-0 flex-col">
          <span
            className={
              gone
                ? "text-muted-foreground decoration-border truncate line-through"
                : "truncate"
            }
          >
            {name}
          </span>
          {under === "" ? null : (
            <span className="text-muted-foreground truncate text-xs">
              {under}
            </span>
          )}
        </span>
      </span>
      <span className="text-muted-foreground min-w-0 @2xl:w-56 @2xl:flex-none @5xl:w-72">
        {standsLine(member)}
      </span>
      <span className="@2xl:w-24 @2xl:flex-none @2xl:text-right">
        <span className="sr-only">Role: </span>
        {roleWords[member.role]}
      </span>
    </li>
  );
};

/**
 * Everyone in the company's platform, as the prototype shows them
 * (grasplabs/prototype `components/admin/org-members.tsx`), a tab of its
 * Details: how many seats are taken, then each member with where they
 * stand and their role.
 *
 * Core sends its members once they made their account, so nobody here
 * is still invited, and it doesn't say which of them is Grasp's own
 * staff. Nor are the prototype's invitation, role change and taking
 * access away here: the admin can't do those in a company's Grasp.
 */
export const OrgMembers = () => {
  const { view } = useOrganization();
  const { members, seats } = view;
  // A contract not known yet gives no number of seats either.
  const taken = view.unknown.contract
    ? `${seats.used} ${seats.used === 1 ? "seat" : "seats"} taken`
    : `${seats.used} of ${seats.of} seats taken`;
  return (
    <Section description={taken} title="Members">
      {members.length === 0 ? (
        <p className="text-muted-foreground border-t px-5 py-4">
          Nobody has made an account yet.
        </p>
      ) : (
        <div className="@container">
          <ul className="flex flex-col">
            {members.map((member) => (
              <MemberRow key={member.id} member={member} />
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
};
