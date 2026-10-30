/**
 * Adding an organization, as the prototype's admin starts one
 * (grasplabs/prototype `components/admin/new-org-dialog.tsx`): from a deal
 * won in Attio, a proposal signed in Rooms, or by hand. A deal won in
 * Attio can be chosen once Attio is read and has one no organization is
 * linked to (src/crm/crm.ts); Rooms has no list of signed proposals to
 * start from yet, so it is shown, with why not, where it will be: whether
 * the admin isn't connected to Rooms, or is and Rooms can't list them.
 */
import type { WonDeal } from "../crm/attio.ts";
import type { WonDeals } from "../crm/crm.ts";
import { addSecretStep } from "./words.ts";

/** Where a new organization's details can come from. */
export interface StartingPoint {
  id: "hand" | "attio" | "rooms";
  label: string;
  description: string;
  /** Why it can't be chosen now; null when it can. */
  unavailable: string | null;
}

const startingPoints: readonly StartingPoint[] = [
  {
    id: "hand",
    label: "By hand",
    description: "Nothing filled in: for a company that is in no system yet.",
    unavailable: null,
  },
  {
    id: "attio",
    label: "A deal won in Attio",
    description:
      "Its company, filled in below to put right, and linked to it in Attio.",
    unavailable: null,
  },
  {
    id: "rooms",
    label: "A proposal signed in Rooms",
    description: "Its company and signatory, filled in below to put right.",
    unavailable: null,
  },
];

/** Why a deal won in Attio can't be started from, when it can't. */
const attioUnavailable = (won: WonDeals): string | null => {
  switch (won.state) {
    case "not_connected": {
      return `Not yet: the admin isn't connected to Attio. ${addSecretStep("ATTIO_READ_KEY")}`;
    }
    case "unread": {
      return "Attio can't be read now: try again in a moment.";
    }
    case "read": {
      return won.deals.length === 0
        ? "No deal won in Attio waits to be added."
        : null;
    }
    default: {
      return won satisfies never;
    }
  }
};

/**
 * Why a proposal signed in Rooms can't be started from: Rooms reads one
 * room at a time (src/proposal/rooms.ts) and lists none, so never yet;
 * what to do instead depends on whether the admin reaches Rooms at all.
 */
const roomsUnavailable = (roomsConnected: boolean): string =>
  roomsConnected
    ? "Not yet: Rooms can't list its signed proposals. Add it by hand, then link its room under its Contract."
    : "Not yet: the admin isn't connected to Rooms.";

/**
 * Where a new organization can start from, with the won deals Attio has
 * now, and whether the admin reaches Rooms (`roomsConnected`).
 */
export const startingPointsOf = (
  won: WonDeals,
  roomsConnected: boolean
): readonly StartingPoint[] =>
  startingPoints.map((start) => {
    if (start.id === "attio") {
      return { ...start, unavailable: attioUnavailable(won) };
    }
    if (start.id === "rooms") {
      return { ...start, unavailable: roomsUnavailable(roomsConnected) };
    }
    return start;
  });

const listSeparator = /[\s,]+/u;

/**
 * The email domains for a new organization's sign-in: `domains` as given,
 * or, left empty, those of the emails in `admins`, each once, in order:
 * the first admin's is nearly always the company's own.
 */
export const domainsOrAdmins = (domains: string, admins: string): string => {
  if (domains.trim() !== "") {
    return domains;
  }
  const ofAdmins = admins
    .split(listSeparator)
    .filter((email) => email.includes("@"))
    .map((email) => email.slice(email.lastIndexOf("@") + 1).toLowerCase())
    .filter((domain) => domain !== "");
  return [...new Set(ofAdmins)].join(", ");
};

const accents = /\p{M}/gu;
const notInAnAddress = /[^a-z0-9]+/gu;
const dashesAtEnds = /^-+|-+$/gu;

/**
 * What a won deal fills in: the company's name, an address made from it
 * (to put right: it can't change once added), and its domains for the
 * sign-in. Its people aren't, as Attio doesn't say who goes through the
 * onboarding.
 */
export const prefillOf = (
  deal: WonDeal
): { name: string; clientId: string; domains: string } => ({
  name: deal.name,
  clientId: deal.name
    .normalize("NFKD")
    .replaceAll(accents, "")
    .toLowerCase()
    .replaceAll(notInAnAddress, "-")
    .replaceAll(dashesAtEnds, "")
    .slice(0, 50)
    .replaceAll(dashesAtEnds, ""),
  domains: deal.domains.join(", "),
});
