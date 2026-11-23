// Where an address inside the Brain leads, as the app's router reads it: the
// atlas, one of the Brain's own pages, a part of the brain or a note. A
// page's text links to the brain by address (`/brain/sections/teams`,
// `/brain/<note id>`); the page draws each as the router's own link to the
// route it names, so a press stays in this tab and a new tab opens one.

/** The Brain's own pages, each at its own address. */
const brainPages = [
  "/brain/activity",
  "/brain/memories",
  "/brain/opportunities",
  "/brain/skills",
  "/brain/sources",
] as const;

type BrainPage = (typeof brainPages)[number];

/** Where it leads, by route, with what the address keeps after its path. */
export type BrainRoute = {
  /** After `#`, decoded; empty for none. */
  hash: string;
  /** After `?`, each name with its value. */
  search: Record<string, string>;
} & (
  | { to: "/brain" }
  | { to: BrainPage }
  | { to: "/brain/sections/$sectionId"; params: { sectionId: string } }
  | { to: "/brain/$noteId"; params: { noteId: string } }
);

/** An address of no origin of its own resolves against this one: a path stays on it. */
const here = "http://brain.invalid";

const isBrainPage = (path: string): path is BrainPage =>
  brainPages.some((page) => page === path);

/** A part of a path decoded, or undefined when it is not a part's encoding. */
const decoded = (part: string): string | undefined => {
  try {
    return decodeURIComponent(part);
  } catch {
    return undefined;
  }
};

/**
 * The route `href` leads to inside the Brain, or undefined for an address that is not one
 * (another site, another part of Grasp, a path no Brain route takes). As the router matches: a
 * page's own address wins over a note of the same id; one more part after the brain is a note's
 * id, `sections/<id>` a part of the brain.
 */
export const brainRoute = (href: string): BrainRoute | undefined => {
  let url: URL;
  try {
    url = new URL(href, here);
  } catch {
    return undefined;
  }
  if (url.origin !== here) {
    return undefined;
  }
  const [first, ...rest] = url.pathname.split("/").slice(1);
  if (first !== "brain") {
    return undefined;
  }
  const hash = decoded(url.hash.slice(1));
  if (hash === undefined) {
    return undefined;
  }
  const kept = { hash, search: Object.fromEntries(url.searchParams) };
  const parts = rest.at(-1) === "" ? rest.slice(0, -1) : rest;
  if (parts.length === 0) {
    return { ...kept, to: "/brain" };
  }
  const [one, two] = parts.map(decoded);
  if (one === undefined || one === "" || two === "") {
    return undefined;
  }
  if (parts.length === 1) {
    const page = `/brain/${parts[0] ?? ""}`;
    return isBrainPage(page)
      ? { ...kept, to: page }
      : { ...kept, to: "/brain/$noteId", params: { noteId: one } };
  }
  if (parts.length === 2 && parts[0] === "sections" && two !== undefined) {
    return {
      ...kept,
      to: "/brain/sections/$sectionId",
      params: { sectionId: two },
    };
  }
  return undefined;
};
