import { dayOf } from "@grasp-os/shared/admin/org-record";
import { actorOf } from "@grasp-os/shared/audit";
import type {
  DirectoryPeople,
  DirectorySuite,
  OnboardingDirectory,
} from "@grasp-os/shared/directory";
import type {
  DocumentPlace,
  OnboardingPlaces,
  PlaceItem,
  PlaceItemsInput,
  PlacesSuite,
  SharePlaceFileInput,
} from "@grasp-os/shared/document-places";
import type {
  HrCredentials,
  HrPeople,
  HrPlatform,
  OnboardingHr,
} from "@grasp-os/shared/hr";
import {
  linksTakenSchema,
  onboardingErrors,
  planSchema,
  programmeWeeks,
  rosterSchema,
  settleSchema,
} from "@grasp-os/shared/onboarding";
import type {
  LinkToSend,
  OnboardingApi,
  OnboardingReview,
  OnboardingView,
  PlanInput,
  Programme,
  RosterInput,
  SettleChoice,
} from "@grasp-os/shared/onboarding";
import { setupChoicesSchema } from "@grasp-os/shared/onboarding-choices";
import type {
  SetupChoices,
  SetupChoicesInput,
} from "@grasp-os/shared/onboarding-choices";
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
import { z } from "zod";

import { CoreRpcTarget } from "../rpc-target.ts";
import { withPerson } from "../session-check.ts";
import type { SessionCheck } from "../session-check.ts";
import {
  connectDirectory,
  onboardingDirectory,
  readOnboardingDirectory,
} from "./directory.ts";
import {
  connectPlaces,
  listPlaces,
  onboardingPlaces,
  placeItems,
  sharePlaceFile,
} from "./document-places.ts";
import { shareDocument } from "./documents.ts";
import { gateView } from "./gate.ts";
import { connectHr, onboardingHr, readOnboardingHr } from "./hr.ts";
import { mondayOf } from "./rules.ts";
import { onboardingStore } from "./store.ts";
import { summaryOf } from "./summary.ts";

// The onboarding over `/rpc`. The company's admin (and Grasp's staff,
// whose access is the admin role) gives the store who works where and the
// plan, and reads back numbers per team, never anyone's words; and takes
// everyone's own link, to send themselves as well (the threat model's L3:
// a link opens on the first device only, whoever holds it). At the end it
// settles the steps people told two ways and nobody could explain, never
// told who said which. What only Grasp's staff do is in staff-rpc.ts. The
// admin also shares documents,
// each read at once (documents.ts). Everything that comes in is checked
// against the shared schemas before the store sees it. Its programme
// (when it began, and where it stands) is for everyone signed in, for the
// dashboard: the plan's first week and the stage, and nothing of the plan
// or the roster past them. Who works where can also come from the
// organization's directory, connected here and read for the admin's
// browser to make the roster of (directory.ts); documents from where
// they live, picked in the admin's browser (document-places.ts); and who
// leads which team from its HR platform, the same way (hr.ts).

/** The admin's answer to a document's question. */
const answerSchema = z.strictObject({
  id: z.string().min(1).max(64),
  answer: z.string().trim().min(1).max(documentAnswerMaxLength),
});

/** The onboarding, for the client's admin. */
export class OnboardingRpc extends CoreRpcTarget implements OnboardingApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async programme(): Promise<Programme | null> {
    return await withPerson(this.#check, async () => {
      const now = new Date().toISOString();
      const view = await onboardingStore(this.#env).view(now);
      if (view.plan === null) {
        return null;
      }
      const { stage } = summaryOf(
        view,
        await gateView(this.#env, view, now),
        now
      );
      return {
        start: mondayOf(view.plan.start),
        weeks: programmeWeeks,
        stage: stage === "none" ? null : stage,
      };
    });
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

  async directory(): Promise<OnboardingDirectory | null> {
    return await withPerson(
      this.#check,
      async (person) => await onboardingDirectory(this.#env, person)
    );
  }

  async connectDirectory(
    suite: DirectorySuite,
    returnTo: string
  ): Promise<{ url: string }> {
    return await withPerson(
      this.#check,
      async (person) =>
        await connectDirectory(this.#env, person, suite, returnTo)
    );
  }

  async readDirectory(): Promise<DirectoryPeople> {
    return await withPerson(
      this.#check,
      async (person) => await readOnboardingDirectory(this.#env, person)
    );
  }

  async documentPlaces(): Promise<OnboardingPlaces | null> {
    return await withPerson(
      this.#check,
      async (person) => await onboardingPlaces(this.#env, person)
    );
  }

  async connectDocumentPlaces(
    suite: PlacesSuite,
    returnTo: string
  ): Promise<{ url: string }> {
    return await withPerson(
      this.#check,
      async (person) => await connectPlaces(this.#env, person, suite, returnTo)
    );
  }

  async listDocumentPlaces(): Promise<DocumentPlace[]> {
    return await withPerson(
      this.#check,
      async (person) => await listPlaces(this.#env, person)
    );
  }

  async placeItems(
    input: PlaceItemsInput
  ): Promise<{ items: PlaceItem[]; next: string | null }> {
    return await withPerson(
      this.#check,
      async (person) => await placeItems(this.#env, person, input)
    );
  }

  async sharePlaceFile(
    input: SharePlaceFileInput
  ): Promise<OnboardingDocument> {
    return await withPerson(
      this.#check,
      async (person) => await sharePlaceFile(this.#env, person, input)
    );
  }

  async hrPlatform(): Promise<OnboardingHr | null> {
    return await withPerson(
      this.#check,
      async (person) => await onboardingHr(this.#env, person)
    );
  }

  async connectHrPlatform(
    platform: HrPlatform,
    credentials: HrCredentials
  ): Promise<OnboardingHr> {
    return await withPerson(
      this.#check,
      async (person) =>
        await connectHr(this.#env, person, platform, credentials)
    );
  }

  async readHrPlatform(): Promise<HrPeople> {
    return await withPerson(
      this.#check,
      async (person) => await readOnboardingHr(this.#env, person)
    );
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

  async review(): Promise<OnboardingReview> {
    return await withPerson(this.#check, async (person) => {
      requireAdmin(person);
      return await onboardingStore(this.#env).review();
    });
  }

  async settle(work: string, holds: SettleChoice): Promise<OnboardingReview> {
    return await withPerson(this.#check, async (person) => {
      requireAdmin(person);
      const parsed = onboardingErrors.parse(
        "onboarding.invalid",
        settleSchema,
        { work, holds }
      );
      const review = await onboardingStore(this.#env).settle(
        parsed.work,
        parsed.holds,
        actorOf(person)
      );
      if (review === null) {
        throw onboardingErrors.create("onboarding.no_difference");
      }
      return review;
    });
  }

  async links(): Promise<LinkToSend[]> {
    return await withPerson(this.#check, async (person) => {
      requireAdmin(person);
      return await onboardingStore(this.#env).linksToSend();
    });
  }

  async linksTaken(people: string[]): Promise<void> {
    await withPerson(this.#check, async (person) => {
      requireAdmin(person);
      const parsed = onboardingErrors.parse(
        "onboarding.invalid",
        linksTakenSchema,
        people
      );
      await onboardingStore(this.#env).linksTaken(parsed, actorOf(person));
    });
  }

  async choices(): Promise<SetupChoices> {
    return await withPerson(this.#check, async (person) => {
      requireAdmin(person);
      return await onboardingStore(this.#env).choices();
    });
  }

  async saveChoices(choices: SetupChoicesInput): Promise<SetupChoices> {
    return await withPerson(this.#check, async (person) => {
      requireAdmin(person);
      const parsed = onboardingErrors.parse(
        "onboarding.invalid",
        setupChoicesSchema,
        choices
      );
      return await onboardingStore(this.#env).saveChoices(
        parsed,
        actorOf(person)
      );
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
