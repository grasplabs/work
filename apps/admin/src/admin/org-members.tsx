import type { MemberView } from "@grasp-os/shared/admin/admin-account";
import type { MemberRole } from "@grasp-os/shared/admin/onboarding-admin";
import { Avatar, AvatarFallback } from "@grasp-os/ui/components/avatar";
import { CardContent } from "@grasp-os/ui/components/card";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Text } from "@grasp-os/ui/components/text";
import { Icon, MailIcon } from "@grasp-os/ui/lib/icons";
import { visuallyHidden } from "@grasp-os/ui/lib/styles";
import { colors, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";

import { useOrganization } from "./organization.tsx";
import { Panel, PanelNote } from "./panel.tsx";
import { formatDate } from "./words.ts";

const styles = stylex.create({
  // Someone whose access was taken away: their name struck through.
  gone: {
    color: colors.mutedForeground,
    textDecorationLine: "line-through",
  },
  stands: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    columnGap: space["4"],
    rowGap: space["1"],
  },
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

/** One member a row: who they are, where they stand, and their role. */
const MemberRow = ({ member }: { member: MemberView }) => {
  const name = member.name === "" ? member.email : member.name;
  const gone = member.state === "removed";
  const under = [member.name === "" ? "" : member.email, member.title]
    .filter((part) => part !== "")
    .join(" · ");
  return (
    <Item size="sm">
      <ItemMedia>
        <Avatar decorative name={name}>
          {/* Someone known only by their email has no initials to show. */}
          {member.name === "" ? (
            <AvatarFallback>
              <Icon icon={MailIcon} />
            </AvatarFallback>
          ) : (
            <AvatarFallback />
          )}
        </Avatar>
      </ItemMedia>
      <ItemContent>
        <ItemTitle>
          <span {...stylex.props(gone && styles.gone)}>{name}</span>
        </ItemTitle>
        {under === "" ? null : <ItemDescription>{under}</ItemDescription>}
      </ItemContent>
      <ItemActions>
        <span {...stylex.props(styles.stands)}>
          <Text as="span" color="muted" size="sm">
            {standsLine(member)}
          </Text>
          <Text as="span" size="sm">
            <span {...stylex.props(visuallyHidden)}>Role: </span>
            {roleWords[member.role]}
          </Text>
        </span>
      </ItemActions>
    </Item>
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
    <Panel description={taken} title="Members">
      {members.length === 0 ? (
        <PanelNote>Nobody has made an account yet.</PanelNote>
      ) : (
        <CardContent flush>
          <ItemGroup separated>
            {members.map((member) => (
              <MemberRow key={member.id} member={member} />
            ))}
          </ItemGroup>
        </CardContent>
      )}
    </Panel>
  );
};
