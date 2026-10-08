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
  rosterPersonSchema,
} from "@grasp-os/shared/onboarding";
import type {
  Agreements,
  OnboardingStaffApi,
  OnboardingView,
} from "@grasp-os/shared/onboarding";
import {
  logFilterSchema,
  noteMaxLength,
} from "@grasp-os/shared/onboarding-staff";
import type {
  LogFilter,
  StaffLog,
  StaffNote,
  StaffOverview,
  StaffTranscript,
} from "@grasp-os/shared/onboarding-staff";
import type { Identity } from "@grasp-os/shared/rpc";
import { RpcTarget } from "capnweb";
import { z } from "zod";

import { appendAuditEvent } from "../audit-outbox.ts";
import { withPerson } from "../session-check.ts";
import type { SessionCheck } from "../session-check.ts";
import { gateView } from "./gate.ts";
import { readKickoff, transcriptOf } from "./kickoff.ts";
import { needsOf, stagesOf } from "./staff-area.ts";
import type { StaffFacts } from "./staff-area.ts";
import { onboardingStore } from "./store.ts";

// What only Grasp's staff do in the onboarding, over `/rpc`: pause the
// interviews and let them run again, say where the agreements stand, give
// someone who lost their device a new start, and Grasp's onboarding area
// (staff-area.ts): where it stands, what needs Grasp, notes, the log, and
// someone's interview, whose every read is in the audit log; and the
// kickoff, brought in, read for what Stephen needs (kickoff.ts), and the
// sponsor's answers to what it left open.
// Until the agreements are in and while the interviews are paused, no link
// opens and none goes out. The client's admin sees both (`view()`), and
// the audit log has every change, as the staff member who made it.

const noteSchema = z.string().trim().min(1).max(noteMaxLength);

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
  extends RpcTarget
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

  async setAgreements(agreements: Agreements): Promise<OnboardingView> {
    return await withPerson(this.#check, async (person) => {
      requireStaff(person);
      const parsed = onboardingErrors.parse(
        "onboarding.invalid",
        agreementsSchema,
        agreements
      );
      return await onboardingStore(this.#env).setAgreements(
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
      return await onboardingStore(this.#env).setPaused(
        paused,
        actorOf(person)
      );
    });
  }
}
