import type {
  MemberState,
  MemberView,
} from "@grasp-os/shared/admin/admin-account";
import type { MemberRole } from "@grasp-os/shared/admin/onboarding-admin";
import { Avatar, AvatarFallback } from "@grasp-os/ui/components/avatar";
import { createFileRoute } from "@tanstack/react-router";
import { MailIcon } from "lucide-react";

import { useOrganization } from "../../../../admin/organization.tsx";
import { Tile } from "../../../../admin/parts.tsx";
import { formatDate } from "../../../../admin/words.ts";

/** Where someone stands with the platform, in a word or two. */
const stateWords: Record<MemberState, string> = {
  invited: "Invitation waits",
  ready: "Ready",
  active: "In",
  removed: "Access taken away",
};

/** A role in the platform, as the company's own Members page says it. */
const roleWords: Record<MemberRole, string> = {
  owner: "Owner",
  admin: "Admin",
  builder: "Builder",
  user: "User",
  viewer: "Viewer",
};

/** Where someone stands, in a sentence with its days. */
const standsLine = (member: MemberView): string => {
  const invited = formatDate(member.invited);
  const joined = member.joined === undefined ? "" : formatDate(member.joined);
  if (member.state === "removed") {
    return "Grasp took their access away.";
  }
  if (member.state === "invited") {
    return member.resent === null
      ? `Invited on ${invited}. Not accepted yet.`
      : `Invited on ${invited}, and again on ${formatDate(member.resent)}.`;
  }
  if (member.state === "ready") {
    return `Made an account on ${joined}. Comes in when Grasp opens.`;
  }
  return member.seen === null
    ? `In since ${joined}.`
    : `In since ${joined}. Last in on ${formatDate(member.seen)}.`;
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
      <span className="flex min-w-0 flex-col @2xl:w-56 @2xl:flex-none @5xl:w-72">
        <span>{stateWords[member.state]}</span>
        <span className="text-muted-foreground text-xs">
          {standsLine(member)}
        </span>
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
 * (grasplabs/prototype `components/admin/org-members.tsx`): how many seats
 * are taken and how many are in, then each member with where they stand
 * and their role.
 *
 * Core sends its members once they made their account, so nobody here
 * is still invited, and it doesn't say which of them is Grasp's own
 * staff: the prototype's counts of invitations that wait and of people
 * from Grasp aren't shown until it does. Nor are the prototype's
 * invitation, role change and taking access away: the console can't do
 * those in a company's Grasp.
 */
const Members = () => {
  const { view } = useOrganization();
  const { members, seats } = view;
  const here = members.filter(
    (member) => member.state === "ready" || member.state === "active"
  ).length;
  // A contract not known yet gives no number of seats either.
  const seatsKnown = !view.unknown.contract;
  const be = here === 1 ? "is" : "are";
  const hereLabel = view.open ? `${be} in` : `${be} ready for when Grasp opens`;
  return (
    <>
      <section
        aria-label="The members in short"
        className="overflow-hidden rounded-xl border text-sm"
      >
        <div className="bg-border grid grid-cols-2 gap-px">
          <Tile
            label={
              seatsKnown
                ? "seats taken"
                : "seats taken; the contract that gives them isn’t read yet"
            }
            value={seatsKnown ? `${seats.used} of ${seats.of}` : seats.used}
          />
          <Tile label={hereLabel} value={here} />
        </div>
      </section>
      <section className="bg-card overflow-hidden rounded-xl border">
        <div className="flex flex-col gap-0.5 px-5 py-4">
          <h2 className="font-medium">Members</h2>
          <p className="text-muted-foreground">
            The company invites its own people. Invitations that still wait, and
            who of them is from Grasp, aren’t read from the company’s own Grasp
            yet.
          </p>
        </div>
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
      </section>
    </>
  );
};

/** An organization's Members: everyone in its platform, where each stands, and their role. */
export const Route = createFileRoute("/admin/organizations/$clientId/members")({
  component: Members,
});
