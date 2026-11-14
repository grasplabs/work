import type { OnErase } from "@grasp-os/brain/purge";
import { auditActorSchema } from "@grasp-os/shared/audit";
import type { OnboardingDocument } from "@grasp-os/shared/onboarding-documents";

import { onboardingStore } from "./store.ts";

// The readings of the documents shared in the onboarding (documents.ts) as
// a Knowledge purge reaches them (GRA-970): a purge of terms forgets each
// reading holding one whole, with every drawing made since it was shared
// and what of those the brain holds (the store's `forgetDocuments`). Never
// rewritten instead: the model's words for the document may say a term
// otherwise than the purge spells it. The onboarding keeps no file, so a
// purge naming a Knowledge document never names one of these (GRA-1889),
// and a reading names no person, so a personal purge has no one to forget
// here.

/** Every text a document's reading keeps: its name, the reading and the admin's answer. */
const textsOf = ({ name, reading, answer }: OnboardingDocument): string[] => [
  name,
  reading.about,
  ...reading.tools,
  ...reading.teams,
  ...reading.unclear,
  ...(reading.ask === null
    ? []
    : [reading.ask.question, ...reading.ask.options]),
  ...(answer === null ? [] : [answer]),
];

/** The shared documents' readings as a content purge reaches them. */
export const documentReadingErasure = (env: Env): Pick<OnErase, "rewrite"> => {
  const store = onboardingStore(env);
  return {
    rewrite: async (by, rewrite) => {
      const shared = await store.documents();
      const holding = shared.filter((document) =>
        textsOf(document).some((text) => rewrite(text) !== text)
      );
      if (holding.length > 0) {
        await store.forgetDocuments(
          holding.map(({ id }) => id),
          auditActorSchema.parse(by.actor)
        );
      }
    },
  };
};
