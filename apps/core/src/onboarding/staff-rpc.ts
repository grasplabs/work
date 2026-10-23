import { adminSnapshotSchema } from "@grasp-os/shared/admin-snapshot";
import type { AdminSnapshot } from "@grasp-os/shared/admin-snapshot";
import { actorOf } from "@grasp-os/shared/audit";
import {
  answerMaxLength,
  kickoffErrors,
  kickoffInputSchema,
  visionFieldSchema,
} from "@grasp-os/shared/kickoff";
import type {
  KickoffInput,
  KickoffView,
  VisionField,
} from "@grasp-os/shared/kickoff";
import {
  agreementsSchema,
  onboardingErrors,
  onboardingPeopleMax,
  rosterPersonSchema,
  rosterTeamSchema,
} from "@grasp-os/shared/onboarding";
import type {
  Agreements,
  OnboardingStaffApi,
  OnboardingView,
} from "@grasp-os/shared/onboarding";
import { organizationChangeSchema } from "@grasp-os/shared/onboarding-organization";
import type {
  OrganizationChangeInput,
  StaffOrganization,
} from "@grasp-os/shared/onboarding-organization";
import {
  aiPurposes,
  logFilterSchema,
  noteMaxLength,
  stephenSetupSchema,
} from "@grasp-os/shared/onboarding-staff";
import type {
  LogFilter,
  StaffAgreements,
  StaffAiUseRow,
  StaffInterviewers,
  StaffLog,
  StaffNote,
  StaffOverview,
  StaffTranscript,
  StephenSetup,
  StephenSetupView,
} from "@grasp-os/shared/onboarding-staff";
import type { Identity } from "@grasp-os/shared/rpc";
import { z } from "zod";

import { snapshotOf } from "../admin-snapshot.ts";
import { appendAuditEvent } from "../audit-outbox.ts";
import { organizationId } from "../auth/auth.ts";
import { CoreRpcTarget } from "../rpc-target.ts";
import { withPerson } from "../session-check.ts";
import type { SessionCheck } from "../session-check.ts";
import { gateView } from "./gate.ts";
import { interviewerNumbers } from "./interviewer-numbers.ts";
import { readKickoff, transcriptOf } from "./kickoff.ts";
import { needsOf, stagesOf } from "./staff-area.ts";
import type { StaffFacts } from "./staff-area.ts";
import { onboardingStore } from "./store.ts";

// What only Grasp's staff do in the onboarding, over `/rpc`: pause the
// interviews and let them run again, say where the agreements stand, give
// someone who lost their device a new start, send someone's mail that
// failed again, and Grasp's onboarding area
// (staff-area.ts): where it stands, what needs Grasp, notes, the log, and
// someone's interview, whose every read is in the audit log; and the
// kickoff, brought in, read for what Stephen needs (kickoff.ts), and the
// sponsor's answers to what it left open; how Stephen is set up for
// this deployment (stephen-setup.ts), in every interview turn's context;
// how Stephen and Claire are doing (interviewer-numbers.ts) and the AI the
// onboarding used, as numbers; and the interviews by name: where everyone
// stands (the admin's snapshot, as the console reads it), someone's own
// link to send by hand, the one reminder noted, a team asked in, and an
// interview deleted because its person asked; and the organization, team
// by team, and the list put right (organization.ts). Every read that names
// people, or holds a link, is in the audit log first, never with what was
// said or the link itself.
// Until the agreements are in and while the interviews are paused, no link
// opens and none goes out; once they are in and the interviews run, the
// links that are due go out at once, not at the store's next alarm. The client's admin sees both (`view()`), and
// the audit log has every change, as the staff member who made it.

const noteSchema = z.string().trim().min(1).max(noteMaxLength);

const personIdSchema = rosterPersonSchema.shape.id;

const remindSchema = z.array(personIdSchema).max(onboardingPeopleMax);

/** The sponsor's answer to one field the kickoff left open. */
const answerSchema = z.strictObject({
  field: visionFieldSchema,
  text: z.string().max(answerMaxLength),
});

/** Refuses anyone but Grasp's staff, with `onboarding.staff_only`. */
const requireStaff = (person: Identity): void => {
  if (!person.staff) {
    throw onboardingErrors.create("onboarding.staff_only");
  }
};

/** What only Grasp's staff do in the onboarding. */
export class OnboardingStaffRpc
  extends CoreRpcTarget
  implements OnboardingStaffApi
{
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async pause(): Promise<OnboardingView> {
    return await this.#paused(true);
  }

  async resume(): Promise<OnboardingView> {
    return await this.#paused(false);
  }

  async agreements(): Promise<StaffAgreements> {
    return await withPerson(this.#check, async (person) => {
      requireStaff(person);
      return await onboardingStore(this.#env).staffAgreements();
    });
  }

  async setAgreements(agreements: Agreements): Promise<OnboardingView> {
    return await withPerson(this.#check, async (person) => {
      requireStaff(person);
      const parsed = onboardingErrors.parse(
        "onboarding.invalid",
        agreementsSchema,
        agreements
      );
      const store = onboardingStore(this.#env);
      await store.setAgreements(parsed, actorOf(person));
      await store.releaseDue();
      return await store.view();
    });
  }

  async stephen(): Promise<StephenSetupView> {
    return await withPerson(this.#check, async (person) => {
      requireStaff(person);
      return await onboardingStore(this.#env).stephen();
    });
  }

  async saveStephen(setup: StephenSetup | null): Promise<StephenSetupView> {
    return await withPerson(this.#check, async (person) => {
      requireStaff(person);
      const parsed = onboardingErrors.parse(
        "onboarding.invalid",
        stephenSetupSchema.nullable(),
        setup
      );
      return await onboardingStore(this.#env).saveStephen(
        parsed,
        actorOf(person)
      );
    });
  }

  async newStart(person: string): Promise<void> {
    await withPerson(this.#check, async (staff) => {
      requireStaff(staff);
      const id = onboardingErrors.parse(
        "onboarding.invalid",
        rosterPersonSchema.shape.id,
        person
      );
      if (!(await onboardingStore(this.#env).newStart(id, actorOf(staff)))) {
        throw onboardingErrors.create("onboarding.no_link");
      }
    });
  }

  async sendMailAgain(person: string): Promise<void> {
    await withPerson(this.#check, async (staff) => {
      requireStaff(staff);
      const id = onboardingErrors.parse(
        "onboarding.invalid",
        rosterPersonSchema.shape.id,
        person
      );
      if (!(await onboardingStore(this.#env).sendAgain(id, actorOf(staff)))) {
        throw onboardingErrors.create("onboarding.no_failed_mail");
      }
    });
  }

  async overview(): Promise<StaffOverview> {
    return await withPerson(this.#check, async (person) => {
      requireStaff(person);
      const store = onboardingStore(this.#env);
      const now = new Date().toISOString();
      const view = await store.view(now);
      const gate = await gateView(this.#env, view, now);
      const { sent, interviews } = await store.staffFacts();
      const { transcript } = await store.kickoff();
      const facts: StaffFacts = {
        agreements: await store.agreements(),
        sent: new Set(sent.map((link) => link.person)),
        sentAt: new Map(sent.map((link) => [link.person, link.sentAt])),
        interviews: new Map(interviews.map((one) => [one.person, one])),
        kickoff: transcript !== null,
      };
      return {
        stages: stagesOf(view, gate, facts),
        needs: needsOf(view, gate, facts, now),
        notes: await store.notes(),
      };
    });
  }

  async log(filter: LogFilter = {}): Promise<StaffLog> {
    return await withPerson(this.#check, async (person) => {
      requireStaff(person);
      const parsed = onboardingErrors.parse(
        "onboarding.invalid",
        logFilterSchema,
        filter
      );
      return await onboardingStore(this.#env).staffLog(parsed);
    });
  }

  async addNote(text: string): Promise<StaffNote> {
    return await withPerson(this.#check, async (person) => {
      requireStaff(person);
      const parsed = onboardingErrors.parse(
        "onboarding.invalid",
        noteSchema,
        text
      );
      return await onboardingStore(this.#env).addNote(parsed, actorOf(person));
    });
  }

  async transcript(personId: string): Promise<StaffTranscript> {
    return await withPerson(this.#check, async (person) => {
      requireStaff(person);
      const id = onboardingErrors.parse(
        "onboarding.invalid",
        rosterPersonSchema.shape.id,
        personId
      );
      const found = await onboardingStore(this.#env).transcriptOf(id);
      if (found === null) {
        throw onboardingErrors.create("onboarding.not_found");
      }
      const { interviewId, ...transcript } = found;
      // On record before it is read, by the link's random id: the company's
      // admin reads the audit log, and the person's id would name them.
      await appendAuditEvent(this.#env, {
        actor: actorOf(person),
        action: "onboarding.transcript.read",
        target: { type: "interview", id: interviewId },
        detail: {},
      });
      return transcript;
    });
  }

  async interviews(): Promise<AdminSnapshot> {
    return await withPerson(this.#check, async (person) => {
      requireStaff(person);
      // Only what the schema names leaves core, as for the console.
      const snapshot = adminSnapshotSchema.parse(
        await snapshotOf(this.#env, new Date().toISOString())
      );
      // It names people: on record before it is read.
      await appendAuditEvent(this.#env, {
        actor: actorOf(person),
        action: "onboarding.interviews.read",
        target: { type: "organization", id: organizationId },
        detail: {},
      });
      return snapshot;
    });
  }

  async link(personId: string): Promise<string> {
    return await withPerson(this.#check, async (person) => {
      requireStaff(person);
      const id = onboardingErrors.parse(
        "onboarding.invalid",
        personIdSchema,
        personId
      );
      const store = onboardingStore(this.#env);
      const linkId = await store.linkIdOf(id);
      if (linkId === null) {
        throw onboardingErrors.create("onboarding.not_found");
      }
      // A link is a credential: on record before it is read, by its
      // random id, as a transcript read is.
      await appendAuditEvent(this.#env, {
        actor: actorOf(person),
        action: "onboarding.link.read",
        target: { type: "interview", id: linkId },
        detail: {},
      });
      const path = await store.linkOf(id);
      if (path === null) {
        throw onboardingErrors.create("onboarding.not_found");
      }
      return path;
    });
  }

  async remind(people: string[]): Promise<number> {
    return await withPerson(this.#check, async (person) => {
      requireStaff(person);
      const parsed = onboardingErrors.parse(
        "onboarding.invalid",
        remindSchema,
        people
      );
      const noted = await onboardingStore(this.#env).remind(
        parsed,
        actorOf(person)
      );
      return noted.length;
    });
  }

  async askIn(team: string): Promise<OnboardingView> {
    return await withPerson(this.#check, async (person) => {
      requireStaff(person);
      const id = onboardingErrors.parse(
        "onboarding.invalid",
        rosterTeamSchema.shape.id,
        team
      );
      const store = onboardingStore(this.#env);
      if (!(await store.askIn(id, actorOf(person)))) {
        throw onboardingErrors.create("onboarding.no_team");
      }
      await store.releaseDue();
      return await store.view();
    });
  }

  async deleteInterview(personId: string): Promise<void> {
    await withPerson(this.#check, async (person) => {
      requireStaff(person);
      const id = onboardingErrors.parse(
        "onboarding.invalid",
        personIdSchema,
        personId
      );
      const store = onboardingStore(this.#env);
      if (!(await store.deleteOnRequest(id, actorOf(person)))) {
        throw onboardingErrors.create("onboarding.no_link");
      }
    });
  }

  async interviewers(): Promise<StaffInterviewers> {
    return await withPerson(this.#check, async (person) => {
      requireStaff(person);
      const facts = await onboardingStore(this.#env).interviewerFacts();
      return interviewerNumbers(facts, new Date().toISOString());
    });
  }

  async aiUse(): Promise<StaffAiUseRow[]> {
    return await withPerson(this.#check, async (person) => {
      requireStaff(person);
      const rows = await onboardingStore(this.#env).usage();
      return rows.flatMap((row) => {
        const purpose = aiPurposes.find((each) => each === row.purpose);
        return purpose === undefined ? [] : [{ ...row, purpose }];
      });
    });
  }

  async organization(): Promise<StaffOrganization> {
    return await withPerson(this.#check, async (person) => {
      requireStaff(person);
      const organization = await onboardingStore(this.#env).staffOrganization();
      // It names people: on record before it is read.
      await appendAuditEvent(this.#env, {
        actor: actorOf(person),
        action: "onboarding.organization.read",
        target: { type: "organization", id: organizationId },
        detail: {},
      });
      return organization;
    });
  }

  async changeOrganization(change: OrganizationChangeInput): Promise<void> {
    await withPerson(this.#check, async (person) => {
      requireStaff(person);
      const parsed = onboardingErrors.parse(
        "onboarding.invalid",
        organizationChangeSchema,
        change
      );
      const store = onboardingStore(this.#env);
      const refusal = await store.changeOrganization(parsed, actorOf(person));
      if (refusal !== null) {
        throw onboardingErrors.create(refusal);
      }
      // A link sent now, or a team asked in, may make links due at once.
      await store.releaseDue();
    });
  }

  async kickoff(): Promise<KickoffView> {
    return await withPerson(this.#check, async (person) => {
      requireStaff(person);
      return await onboardingStore(this.#env).kickoff();
    });
  }

  /**
   * Brings the kickoff's transcript in and reads it, before anything is
   * kept: a transcript that can't be read leaves the one before in place.
   */
  async saveKickoff(input: KickoffInput): Promise<KickoffView> {
    return await withPerson(this.#check, async (person) => {
      requireStaff(person);
      const { locale, transcript } = kickoffErrors.parse(
        "kickoff.invalid",
        kickoffInputSchema,
        input
      );
      const { text, fileName } = await transcriptOf(this.#env, transcript);
      const by = actorOf(person);
      const reading = await readKickoff(this.#env, text, locale, by);
      // The reading takes a while: the company may have ended Grasp's
      // access meanwhile. Nothing is kept unless they are still in.
      requireStaff(await this.#check());
      return await onboardingStore(this.#env).saveKickoff(
        { transcript: text, fileName, reading },
        by
      );
    });
  }

  async answerKickoff(field: VisionField, text: string): Promise<KickoffView> {
    return await withPerson(this.#check, async (person) => {
      requireStaff(person);
      const parsed = kickoffErrors.parse("kickoff.invalid", answerSchema, {
        field,
        text,
      });
      const store = onboardingStore(this.#env);
      if (
        !(await store.answerKickoff(parsed.field, parsed.text, actorOf(person)))
      ) {
        throw kickoffErrors.create("kickoff.invalid");
      }
      return await store.kickoff();
    });
  }

  async #paused(paused: boolean): Promise<OnboardingView> {
    return await withPerson(this.#check, async (person) => {
      requireStaff(person);
      const store = onboardingStore(this.#env);
      await store.setPaused(paused, actorOf(person));
      if (!paused) {
        await store.releaseDue();
      }
      return await store.view();
    });
  }
}
