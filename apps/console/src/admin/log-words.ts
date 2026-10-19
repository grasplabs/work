/**
 * What each entry of an organization's log says, in English, ported from
 * the prototype (grasplabs/prototype `components/admin/org-log.tsx`, its
 * `happened` and `done`). The entries are the model's (`logItemsOf`); this
 * only says them. Names come along (people's, teams', works', integrations'),
 * never anything someone wrote or said.
 */
import type {
  LogActor,
  LogItem,
  LogTopic,
} from "@grasp-os/shared/admin/admin-log";
import type { AccountEvent } from "@grasp-os/shared/admin/admin-view";
import type { Agreed } from "@grasp-os/shared/admin/onboarding-admin";
import type { LogEvent } from "@grasp-os/shared/admin/onboarding-admin-record";
import type { TrailEntry } from "@grasp-os/shared/admin/trail";

/** What an entry is about, as the log's filter names it. */
export const topicWords: Record<LogTopic, string> = {
  interviews: "Interviews and links",
  work: "Workflows and drawings",
  people: "People and teams",
  agreements: "Contract and agreements",
  platform: "The platform",
  setup: "Setting up",
};

/** Who did it, as the log's filter and its chart name them. */
export const actorWords: Record<LogActor, string> = {
  grasp: "Grasp, by hand",
  company: "The company",
  person: "Someone in their interview",
  itself: "Grasp, by itself",
};

/** Each agreement by its name. */
const paperWords: Record<keyof Agreed, string> = {
  processing: "Agreement on handling data",
  assessment: "The company’s look at the risks to its people",
  council: "Works council",
};

/** `count` and the noun for it, one or many. */
const counted = (count: number, one: string, other: string): string =>
  `${count} ${count === 1 ? one : other}`;

/** What happened around the company's interviews, said plainly: its contract, agreements and platform. */
const happenedAround = (event: AccountEvent): string => {
  switch (event.kind) {
    case "contractSent": {
      return "The contract was sent.";
    }
    case "contractSigned": {
      return "The contract was signed.";
    }
    case "contractStarts": {
      return "The contract started.";
    }
    case "agreement": {
      return `In place: ${paperWords[event.paper]}.`;
    }
    case "connected": {
      return `${event.name} was connected.`;
    }
    case "invited": {
      return event.count === 1
        ? "1 person was invited into the platform."
        : `${event.count} people were invited into the platform.`;
    }
    case "joined": {
      return `${counted(event.count, "person", "people")} made their account.`;
    }
    case "live": {
      return `“${event.work}” went live.`;
    }
    default: {
      return "";
    }
  }
};

/** What happened in the company's onboarding, said plainly. */
const happenedIn = (event: LogEvent): string => {
  switch (event.kind) {
    case "conversation": {
      return "The first conversation with the sponsor.";
    }
    case "told": {
      return `The company told its team. ${counted(event.leads, "team lead", "team leads")} got a link.`;
    }
    case "lead": {
      const links = event.links === 1 ? "link" : "links";
      return `${event.lead} talked, and ${event.team.name} got its ${links}: ${counted(event.links, "colleague", "colleagues")}.`;
    }
    case "reminded": {
      const people = `${counted(event.count, "person", "people")} got the one reminder`;
      return event.byHand ? `${people}, sent by hand.` : `${people}.`;
    }
    case "talked": {
      return [
        event.count > 0
          ? `${counted(event.count, "person", "people")} finished their interview.`
          : "",
        event.stopped > 0 ? `${event.stopped} stopped halfway.` : "",
      ]
        .filter((part) => part !== "")
        .join(" ");
    }
    case "go": {
      return "Grasp gave its go: the company can come in.";
    }
    case "closed": {
      return `The link closed. ${event.talked} of ${event.people} talked.`;
    }
    default: {
      return "";
    }
  }
};

/** The kinds of what happened around the interviews rather than in them. */
const aroundKinds: ReadonlySet<string> = new Set<AccountEvent["kind"]>([
  "contractSent",
  "contractSigned",
  "contractStarts",
  "agreement",
  "connected",
  "invited",
  "joined",
  "live",
]);

const isAround = (event: LogEvent | AccountEvent): event is AccountEvent =>
  aroundKinds.has(event.kind);

/** What happened at the company, said plainly. */
const happened = (event: LogEvent | AccountEvent): string =>
  isAround(event) ? happenedAround(event) : happenedIn(event);

/**
 * What a person at Grasp did by hand: here only what the console records
 * that the prototype's trail has, adding the organization. Anything else
 * says nothing, and the log leaves it out.
 */
const done = (entry: TrailEntry): string =>
  entry.what === "made" ? "Added this organization." : "";

/** What a log entry says; empty for one the log leaves out. */
export const logLine = (item: LogItem): string => {
  const { source } = item;
  if (source.from === "company") {
    return happened(source.event);
  }
  // The console reads nothing the prototype's Worker noted: core's snapshot has no such events.
  return source.from === "hand" ? done(source.entry) : "";
};
