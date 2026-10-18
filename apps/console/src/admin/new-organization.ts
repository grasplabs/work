/**
 * Adding an organization, as the prototype's admin starts one
 * (grasplabs/prototype `components/admin/new-org-dialog.tsx`): from a deal
 * won in Attio, a proposal signed in Rooms, or by hand. The console reads
 * neither Attio nor Rooms yet (no connector for them), so only by hand can
 * be chosen; the other two are shown, with why not, where they will be.
 */

/** Where a new organization's details can come from. */
export interface StartingPoint {
  id: "hand" | "attio" | "rooms";
  label: string;
  description: string;
  /** Why it can't be chosen now; null when it can. */
  unavailable: string | null;
}

export const startingPoints: readonly StartingPoint[] = [
  {
    id: "hand",
    label: "By hand",
    description: "Nothing filled in: for a company that is in no system yet.",
    unavailable: null,
  },
  {
    id: "attio",
    label: "A deal won in Attio",
    description: "Its company and contacts, filled in below to put right.",
    unavailable: "Not yet: the console isn't connected to Attio.",
  },
  {
    id: "rooms",
    label: "A proposal signed in Rooms",
    description: "Its company and signatory, filled in below to put right.",
    unavailable: "Not yet: the console isn't connected to Rooms.",
  },
];

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
