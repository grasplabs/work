import type { VisionField } from "./interviews.ts";
import type {
  Agreed,
  Channel,
  ClientStep,
  Company,
  ContactRole,
  Contract,
  MemberRole,
  OrgRules,
  PlatformPart,
  ResearchSource,
} from "./onboarding-admin.ts";

/**
 * Something a person at Grasp did to an organization here, and when: the admin's own trail. It
 * names what it was about by id, so the page can say it in the reader's language. The prototype
 * kept it beside its page's store (`data/onboarding-admin.ts`); only its shape came along.
 */
export type TrailEntry = { at: number } & (
  | {
      what:
        | "made"
        | "transcript"
        | "reading"
        | "research"
        | "rulesReset"
        | "go"
        | "goBack"
        | "stephen"
        | "stephenReset";
    }
  | { what: "answer"; field: VisionField }
  | { what: "passed"; source: ResearchSource }
  | { what: "agreed"; paper: keyof Agreed; to: boolean | Agreed["council"] }
  | { what: "client"; step: ClientStep }
  | { what: "rules"; rule: keyof OrgRules }
  | { what: "channel"; team: string; channel: Channel }
  | { what: "settled" | "counted" | "uncounted"; work: string }
  | {
      what: "interviewRead" | "interviewDeleted" | "away" | "back";
      person: string;
    }
  /** A team asked in or left out of the interviews, added, changed, given a lead, or taken off the list: by id, and by the name it had. */
  | {
      what:
        | "teamIn"
        | "teamOut"
        | "teamAdded"
        | "teamEdited"
        | "teamRemoved"
        | "leadSet";
      team: string;
      name: string;
    }
  /** Someone added to the list, changed, moved to another team, taken off it, or asked about other work. */
  | {
      what:
        | "personAdded"
        | "personEdited"
        | "personMoved"
        | "personRemoved"
        | "askedAbout";
      person: string;
      name: string;
    }
  | { what: "reminded"; count: number }
  | { what: "threshold"; percent: number }
  | { what: "part"; part: PlatformPart; on: boolean }
  | { what: "company"; field: keyof Company }
  | { what: "contract"; field: keyof Contract }
  | { what: "contact"; role: ContactRole }
  | { what: "invited" | "removed" | "restored" | "resent"; member: string }
  | { what: "role"; member: string; role: MemberRole }
  | { what: "asked"; integration: string }
);
