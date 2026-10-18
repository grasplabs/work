import type {
  AdminInterview,
  AdminLink,
  AdminSnapshot,
} from "../admin-snapshot.ts";
import type { Role } from "../roles.ts";
import { stateWith } from "./admin-state.ts";
import type { Agreed, Member, Org, OrgState } from "./onboarding-admin.ts";
import { orgOfSnapshot } from "./org-adapter.ts";
import { daysBetween, NEW_CLIENT, NOTHING_SAID } from "./org-record.ts";
import type {
  HeldInterview,
  Json,
  OrgContact,
  Plan,
  StaffLink,
  StaffSnapshot,
} from "./org-record.ts";
import { present } from "./present.ts";

/**
 * What Grasp OS's core answers for Grasp's admin (`AdminSnapshot`, ../admin-snapshot.ts), as the
 * prototype's Worker kept an organization (`StaffSnapshot`), so the admin reads a real client the
 * way it reads every organization (`orgOfSnapshot`). Pure.
 *
 * Core keeps back what anyone said: an interview comes as numbers, a link without its code. So
 * nothing here is made up to fill the prototype's shape. Where core has no source, the record is
 * as the model has it for "nothing yet" (`NEW_CLIENT`, `NOTHING_SAID`, empty lists, no link code),
 * and where the model needs a number core has but its own records would count from what was said,
 * the number travels as one (`HeldInterview.counted`, `StaffSnapshot.known`). The only words that
 * come along are names: the company's, its teams' with what each does, its people's with their
 * titles, and its members'.
 *
 * Limits of what core says, which the admin then shows as they are:
 * - An interview's length is from its start to its agreement or last save. Core records no stop,
 *   only the part an unfinished one is in, so an interview someone left and came back to counts
 *   the time away too, and the admin can't tell it apart.
 * - Before any link went out, a plan core holds is left out: the prototype's plan is the day the
 *   team was told, and the admin would count the interviews' days from it.
 * - The gate opened without Grasp's go (a deployment that never closed it) has no day of a go:
 *   the admin shows it closed.
 */

/** Who the console knows the client as. */
export interface AdminClient {
  id: string;
  name?: string;
  /** When Grasp added it, as an ISO time: what the days count from before there is a plan. */
  created?: string;
}

/** What core holds that the admin keeps as done by hand, per organization (`OrgState`). */
type CoreDone = Pick<
  OrgState,
  "threshold" | "opened" | "deleted" | "papers" | "conversation"
> & { agreed?: Agreed };

const nobody: OrgContact = { name: "", title: "", email: "" };

/** Core's role, as the admin names it: Grasp OS's builders and users are their own. */
const roleOf = (role: Role): Member["role"] => role;

const council = {
  agreed: "yes",
  none: "none",
  waiting: "waiting",
} as const satisfies Record<string, Agreed["council"]>;

/** The first time a link went out: when the team was told. */
const toldAt = (links: AdminLink[]): string | null =>
  links
    .flatMap((link) => (link.sentAt === null ? [] : [link.sentAt]))
    .toSorted()
    .at(0) ?? null;

/** The plan as the prototype keeps it: once the team was told, and when that was. */
const planOf = (snapshot: AdminSnapshot): Plan | null => {
  const { plan } = snapshot;
  if (plan === null || !snapshot.told) {
    return null;
  }
  return {
    start: plan.start,
    days: plan.days,
    told: toldAt(snapshot.links) ?? plan.at ?? `${plan.start}T00:00:00.000Z`,
    ...(plan.at === undefined ? {} : { at: plan.at }),
    ...(plan.later === undefined ? {} : { later: { ...plan.later } }),
  };
};

/** One person's link, without its code: core never sends one, for a link is a credential. */
const linkOf = (link: AdminLink): StaffLink => ({
  person: link.person,
  secret: "",
  code: "",
  sent: link.sentAt,
  opened: link.openedAt,
  reminded: link.remindedAt,
  state: link.state,
});

/** One interview as the Worker kept it, its numbers in place of what was said. */
const interviewOf = (
  interview: AdminInterview,
  link: AdminLink | undefined
): HeldInterview => {
  const started = interview.startedAt !== null;
  let mode: HeldInterview["progress"]["mode"] = null;
  if (started) {
    mode = interview.typed ? "type" : "talk";
  }
  const state = link?.state ?? "invited";
  return {
    person: interview.person,
    kind: interview.kind === "lead" ? "lead" : "employee",
    progress: {
      ...NOTHING_SAID,
      person: state === "waiting" ? "invited" : state,
      mode,
      phase: interview.phase ?? NOTHING_SAID.phase,
      startedAt: started ? Date.parse(interview.startedAt ?? "") : null,
      confirmed: interview.confirmed,
      ...(interview.rating === null ? {} : { rating: interview.rating }),
      ...(interview.interviewer === null
        ? {}
        : { interviewer: interview.interviewer }),
    },
    version: 0,
    updated: interview.updatedAt,
    completed: interview.completedAt,
    // Core says only the part an unfinished interview is in; its last save is when it stood there.
    stopped:
      interview.stoppedAt === null
        ? null
        : { at: interview.updatedAt, phase: interview.stoppedAt },
    // Core counts the facts kept apart from those taken out; the admin counts every one written.
    counted: { facts: interview.facts + interview.out, out: interview.out },
  };
};

/** The company's members, by the day they joined: core has members once they joined, not before. */
const membersOf = (snapshot: AdminSnapshot): Member[] =>
  snapshot.members.map((member) => ({
    id: member.userId,
    name: member.name,
    email: member.email,
    title: "",
    role: roleOf(member.role),
    invited: member.joinedAt.slice(0, 10),
    joined: member.joinedAt.slice(0, 10),
  }));

/** When Grasp added it: the console's day, or else core's clock, as nothing earlier is known. */
const createdOf = (snapshot: AdminSnapshot, client: AdminClient): string =>
  client.created ?? snapshot.now;

/** What core holds of what the admin keeps by hand: the agreements, the gate and deleted interviews. */
const doneOf = (snapshot: AdminSnapshot, client: AdminClient): CoreDone => {
  const plan = planOf(snapshot);
  const start = plan?.start ?? createdOf(snapshot, client).slice(0, 10);
  // As the admin counts the days: from the start, up to the end of its own plan, none before the team is told.
  const today =
    plan === null
      ? 0
      : Math.min(Math.max(daysBetween(start, snapshot.now), 0), plan.days);
  const { agreements, gate, kickoff } = snapshot;
  const { openedAt } = gate;
  let conversation: OrgState["conversation"] = "none";
  if (kickoff !== null) {
    // Something of it known is Stephen's reading of it, or the sponsor's answers to what it left open.
    conversation = kickoff.known > 0 ? "read" : "in";
  }
  return {
    ...(agreements === null
      ? {}
      : {
          agreed: {
            processing: agreements.processing,
            assessment: agreements.assessment,
            council: council[agreements.council],
          },
        }),
    papers: {
      ...(agreements?.processingOn === undefined
        ? {}
        : { processing: agreements.processingOn }),
      ...(agreements?.assessmentOn === undefined
        ? {}
        : { assessment: agreements.assessmentOn }),
      ...(agreements?.councilOn === undefined
        ? {}
        : { council: agreements.councilOn }),
    },
    threshold: gate.threshold,
    opened:
      gate.open && openedAt !== null
        ? Math.min(Math.max(daysBetween(start, openedAt), 0), today)
        : null,
    // Core forgets a deleted interview at once but keeps when it was deleted, and the link still
    // opens: an interview started since is a fresh one, not the one they deleted.
    deleted: snapshot.links.flatMap((link) =>
      link.deletedAt === null ||
      snapshot.interviews.some(
        (interview) =>
          interview.person === link.person && interview.startedAt !== null
      )
        ? []
        : [link.person]
    ),
    conversation,
  };
};

/** What the admin keeps by hand, as JSON: how the prototype's Worker kept it (`agreementsIn`). */
const graspOf = (done: CoreDone): Record<string, Json> => ({
  ...(done.agreed === undefined ? {} : { agreed: { ...done.agreed } }),
  papers: { ...done.papers },
  threshold: done.threshold,
  opened: done.opened,
  deleted: done.deleted,
  conversation: done.conversation,
});

/**
 * Core's admin snapshot of one client as the prototype's Worker kept an organization. What it
 * kept by hand (`grasp`) holds what core keeps instead: the agreements, the gate's threshold and
 * go, the interviews deleted, and how far the first conversation is.
 */
export const staffSnapshotOf = (
  snapshot: AdminSnapshot,
  client: AdminClient
): StaffSnapshot => {
  const links = new Map(snapshot.links.map((link) => [link.person, link]));
  return {
    profile: {
      id: client.id,
      name: present(snapshot.company.name)
        ? snapshot.company.name
        : (client.name ?? client.id),
      about: "",
      website: "",
      place: "",
      // Core says no language for the company, and the profile can't be without one: this
      // stands in, and `adminOrgOf` names none for Stephen rather than claim it.
      language: "en",
      sponsor: nobody,
      admin: nobody,
      created: createdOf(snapshot, client),
      test: false,
    },
    clientCode: "",
    client: NEW_CLIENT,
    roster:
      snapshot.roster === null
        ? null
        : {
            teams: snapshot.roster.teams.map((team) => ({
              id: team.id,
              name: team.name,
              lead: team.lead,
              does: team.does,
              off: team.off,
            })),
            people: snapshot.roster.people.map((person) => ({
              id: person.id,
              name: person.name,
              email: person.email,
              team: person.team,
              title: person.title,
              away: person.away,
              // Which piece of work someone is asked about comes from the drawing core doesn't hold yet.
              work: null,
            })),
          },
    plan: planOf(snapshot),
    grasp: graspOf(doneOf(snapshot, client)),
    links: snapshot.links.map(linkOf),
    interviews: snapshot.interviews.map((interview) =>
      interviewOf(interview, links.get(interview.person))
    ),
    works: [],
    mapped: [...snapshot.mapped],
    events: [],
    // Already as the Worker counted it: by day, then purpose, then model.
    usage: snapshot.usage.map((day) => ({ day: day.day, use: { ...day.use } })),
    now: snapshot.now,
    members: membersOf(snapshot),
    known: snapshot.gate.known,
  };
};

/**
 * Core's admin snapshot of one client as the admin reads it: the organization, and where it
 * stands with what core keeps in place of what the admin did by hand.
 */
export const adminOrgOf = (
  snapshot: AdminSnapshot,
  client: AdminClient
): { org: Org; state: OrgState } => {
  const read = orgOfSnapshot(staffSnapshotOf(snapshot, client));
  // Core says no language Stephen speaks there: the profile's stand-in is not one.
  const org: Org = { ...read, stephen: { ...read.stephen, languages: [] } };
  return { org, state: stateWith(org, doneOf(snapshot, client)) };
};
