import { agentErrors } from "@grasp-os/shared/agent";
import type { ChatMention, MentionablePerson } from "@grasp-os/shared/chat";
import { memberErrors } from "@grasp-os/shared/members";
import { isMemberAdmin, roleSchema } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import type { QuestionMention } from "./agent.ts";
import { appFor } from "./apps.ts";
import { currentMembership, notRemoved, organizationId } from "./auth/auth.ts";
import { teamsOf } from "./auth/identity.ts";
import { chatAgentsFor } from "./chat-agents.ts";
import { members, users } from "./db/core/schema.ts";
import { requireWorkflowRole } from "./workflow-resources.ts";

// What a question mentions (`ChatQuestion.mentions`): what the person
// picked with `@` as they wrote it, by ID, found here by name for the
// note its agent reads beside it (`aboutNotes`, agent.ts). What could go
// wrong, and what stops it:
//
// - A page names something the person may not see, to learn its name
//   from the agent's answer or to point the agent at it: each is found as
//   the person reaches it anywhere else, an App or workflow they have a
//   role in, a current member, and the question is refused as those reads
//   refuse it (`app.not_found`, `workflow.resource_unavailable`,
//   `member.not_found`), with no turn taken.
// - A page names a thing by one name and means another: the page sends
//   IDs alone; every name in the note is core's.
// - A mention says more of a member than the person sees: their name and
//   ID, which whoever shares or starts a workflow picks people by
//   (workflow-share-candidates.ts); their role and teams only for the
//   organization's admins, whose member list shows those.
// - A page names an agent the person may not ask, to have it answer them:
//   it is found among the agents they may ask, as their list has them,
//   and refused as one the company doesn't have (`agent.unknown`).

/** A current member of the organization, by name, or `member.not_found`. */
const mentionedMember = async (
  env: Env,
  by: Identity,
  userId: string
): Promise<QuestionMention> => {
  const member = await drizzle(env.DB)
    .select({ name: users.name, role: members.role })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(currentMembership(userId))
    .get();
  // A role that isn't ours gives no access, so it isn't a member's.
  const role = roleSchema.safeParse(member?.role);
  if (member === undefined || !role.success) {
    throw memberErrors.create("member.not_found");
  }
  const mention = { kind: "person" as const, id: userId, name: member.name };
  if (!isMemberAdmin(by)) {
    return mention;
  }
  const teams = await teamsOf(env.DB, userId);
  return { ...mention, role: role.data, teams: teams.map(({ name }) => name) };
};

/** One mention, as `by` may see it, by name. */
const mentionOf = async (
  env: Env,
  by: Identity,
  { kind, id }: ChatMention
): Promise<QuestionMention> => {
  if (kind === "app") {
    const app = await appFor(env, by, id, "user");
    return { kind, id: app.id, name: app.name };
  }
  if (kind === "workflow") {
    const workflow = await requireWorkflowRole(env, by, id, "user");
    return { kind, id: workflow.id, name: workflow.name };
  }
  if (kind === "agent") {
    // One they may ask in Grasp's chat, as its list has it: any other is
    // one the company doesn't have, to them (chat-agents.ts).
    const theirs = await chatAgentsFor(env, by.userId);
    const agent = theirs.find((each) => each.id === id);
    if (agent === undefined) {
      throw agentErrors.create("agent.unknown");
    }
    return { kind, id: agent.id, name: agent.name };
  }
  return await mentionedMember(env, by, id);
};

/**
 * What a question mentions, as `by` may see each, by name, in the order
 * they wrote them; refused for any they may not.
 */
export const mentionsOf = async (
  env: Env,
  by: Identity,
  mentions: readonly ChatMention[]
): Promise<QuestionMention[]> =>
  await Promise.all(
    mentions.map(async (mention) => await mentionOf(env, by, mention))
  );

/**
 * The members `by` can mention, by name: name and user ID for anyone,
 * as a mention notes them (`mentionedMember`), and their role for admins.
 */
export const mentionablePeople = async (
  env: Env,
  by: Identity
): Promise<MentionablePerson[]> => {
  const people = await drizzle(env.DB)
    .select({ id: users.id, name: users.name, role: members.role })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(
      and(
        eq(members.organizationId, organizationId),
        notRemoved(members.userId)
      )
    )
    .orderBy(asc(users.name), asc(users.id));
  const admin = isMemberAdmin(by);
  return people.flatMap(({ id, name, role }) => {
    const known = roleSchema.safeParse(role);
    if (!known.success) {
      return [];
    }
    return [admin ? { id, name, role: known.data } : { id, name }];
  });
};
