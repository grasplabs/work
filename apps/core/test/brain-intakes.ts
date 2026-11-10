import type { Idp } from "./idp.ts";
/**
 * What the tests of the onboarding's brain intake share
 * (brain-intake*.test.ts): teams interviewed, drawn and given to the
 * brain, and what the brain holds of them after.
 */
import type { Ids } from "./onboarding-team.ts";
import { openRpc, signedIn, staffPerson } from "./sign-in.ts";

/** Whom the stored records point at: anyone's id or name, their own words, or the lead's facts. */
export const namedIn = (records: { body: string }[], ids: Ids) => {
  const stored = records.map(({ body }) => body).join("\n");
  const names = ["Lea", "Lind", "Max", "Mol", "Mia", "Mo", "Noor", "Nijs"];
  return {
    ids: [ids.lea, ids.max, ids.mia, ids.mo, ids.noor].filter((id) =>
      stored.includes(id)
    ),
    names: names.filter((name) =>
      new RegExp(`\\b${name}\\b`, "u").test(stored)
    ),
    words: stored.includes("You said"),
    lead: stored.includes("rota sheet"),
  };
};

/** The helpers that sign people in through `idp`. */
export const intakesWith = (idp: Idp) => {
  /** Grasp's staff, signed in to the client's core. */
  const asStaff = async () => {
    const session = await signedIn(idp, "grasp-staff", staffPerson());
    const { core } = await openRpc(session);
    return await core.authenticate();
  };

  return { asStaff };
};
