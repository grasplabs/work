import { actorOf } from "@grasp-os/shared/audit";
import {
  onboardingErrors,
  planSchema,
  rosterSchema,
} from "@grasp-os/shared/onboarding";
import type {
  OnboardingApi,
  OnboardingView,
  PlanInput,
  RosterInput,
} from "@grasp-os/shared/onboarding";
import {
  documentAnswerMaxLength,
  documentErrors,
  shareDocumentSchema,
} from "@grasp-os/shared/onboarding-documents";
import type {
  OnboardingDocument,
  ShareDocumentInput,
} from "@grasp-os/shared/onboarding-documents";
import { requireAdmin } from "@grasp-os/shared/roles";
import { uploadMaxBytes } from "@grasp-os/shared/uploads";
import { RpcTarget } from "capnweb";
import { z } from "zod";

import { withPerson } from "../session-check.ts";
import type { SessionCheck } from "../session-check.ts";
import { shareDocument } from "./documents.ts";
import { dayOf } from "./rules.ts";
import { onboardingStore } from "./store.ts";

// The onboarding over `/rpc`. The company's admin (and Grasp's staff,
// whose access is the admin role) gives the store who works where and the
// plan, and reads back numbers per team, never anyone's words. What only
// Grasp's staff do is in staff-rpc.ts. The admin also shares documents,
// each read at once (documents.ts). Everything that comes in is checked
// against the shared schemas before the store sees it.

/** The admin's answer to a document's question. */
const answerSchema = z.strictObject({
  id: z.string().min(1).max(64),
  answer: z.string().trim().min(1).max(documentAnswerMaxLength),
});

/** The onboarding, for the client's admin. */
export class OnboardingRpc extends RpcTarget implements OnboardingApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async view(): Promise<OnboardingView> {
    return await withPerson(this.#check, async (person) => {
      requireAdmin(person);
      return await onboardingStore(this.#env).view();
    });
  }

  async saveRoster(roster: RosterInput): Promise<OnboardingView> {
    return await withPerson(this.#check, async (person) => {
      requireAdmin(person);
      const parsed = onboardingErrors.parse(
        "onboarding.invalid",
        rosterSchema,
        roster
      );
      return await onboardingStore(this.#env).saveRoster(
        parsed,
        actorOf(person)
      );
    });
  }

  async savePlan(plan: PlanInput): Promise<OnboardingView> {
    return await withPerson(this.#check, async (person) => {
      requireAdmin(person);
      const parsed = onboardingErrors.parse(
        "onboarding.invalid",
        planSchema,
        plan
      );
      if (parsed.start < dayOf(new Date().toISOString())) {
        throw onboardingErrors.create("onboarding.past");
      }
      const store = onboardingStore(this.#env);
      const { roster } = await store.view();
      if (roster === null) {
        throw onboardingErrors.create("onboarding.no_roster");
      }
      return await store.savePlan(parsed, actorOf(person));
    });
  }

  async documents(): Promise<OnboardingDocument[]> {
    return await withPerson(this.#check, async (person) => {
      requireAdmin(person);
      return await onboardingStore(this.#env).documents();
    });
  }

  async shareDocument(input: ShareDocumentInput): Promise<OnboardingDocument> {
    return await withPerson(this.#check, async (person) => {
      requireAdmin(person);
      // Its own reason, before the schema's refusal says only "invalid".
      if (
        input.bytes instanceof Uint8Array &&
        input.bytes.byteLength > uploadMaxBytes
      ) {
        throw documentErrors.create("document.too_large");
      }
      const parsed = documentErrors.parse(
        "document.invalid",
        shareDocumentSchema,
        input
      );
      return await shareDocument(this.#env, person, parsed);
    });
  }

  async answerDocument(
    id: string,
    answer: string
  ): Promise<OnboardingDocument> {
    return await withPerson(this.#check, async (person) => {
      requireAdmin(person);
      const parsed = documentErrors.parse("document.invalid", answerSchema, {
        id,
        answer,
      });
      const answered = await onboardingStore(this.#env).answerDocument(
        parsed.id,
        parsed.answer,
        actorOf(person)
      );
      if (answered === null) {
        throw documentErrors.create("document.not_found");
      }
      return answered;
    });
  }
}
