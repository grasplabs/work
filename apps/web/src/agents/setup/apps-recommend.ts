import type { CatalogApp, Setup } from "./model.ts";

// Which of the company's apps suit a new agent (apps-step.tsx): the words
// of its starting point, its job and its name, matched against each app's
// name, categories and description. A connected app counts for more: it
// works the moment the agent is made. Words, not a model: Grasp writing
// the choice needs core (.context/core-needs.md, item 46).

/** The words that point to apps for each starting point (agent-templates.ts keys). */
const hints: Record<string, readonly string[]> = {
  invoices: [
    "accounting",
    "invoice",
    "finance",
    "bookkeeping",
    "exact",
    "moneybird",
    "xero",
    "quickbooks",
    "twinfield",
    "snelstart",
  ],
  inbox: ["mail", "outlook", "gmail", "email", "inbox"],
  meetings: ["calendar", "meeting", "outlook", "google", "zoom", "teams"],
  report: ["slack", "teams", "docs", "drive", "sheets", "notion", "analytics"],
  questions: [
    "docs",
    "drive",
    "notion",
    "sharepoint",
    "confluence",
    "knowledge",
    "wiki",
  ],
  leads: ["crm", "hubspot", "salesforce", "pipedrive", "sales"],
  documents: ["drive", "docs", "sharepoint", "dropbox", "onedrive", "files"],
  day: ["calendar", "task", "todo", "planner", "asana", "outlook", "gmail"],
};

const wordBreak = /[^\p{L}\p{N}]+/u;

/** A word long enough to point anywhere: "the" or "and" would match too much. */
const shortest = 4;

/** How much a connected app counts above one that is not connected yet. */
const connectedWeight = 2;

/** At most this many apps are recommended. */
export const recommendedMost = 4;

/** The words of `text`, lowercase, long enough to mean something. */
const wordsOf = (text: string): string[] =>
  text
    .toLowerCase()
    .split(wordBreak)
    .filter((word) => word.length >= shortest);

/** How well `app` suits the words; 0 when none of them points to it. */
const scoreOf = (app: CatalogApp, words: readonly string[]): number => {
  const about = [app.id, app.name, ...app.categories, app.description ?? ""]
    .join(" ")
    .toLowerCase();
  return words.filter((word) => about.includes(word)).length;
};

/**
 * Up to four apps that suit the agent, the best first; when nothing points
 * anywhere, the apps already connected, so there is always a start.
 */
export const recommendedApps = (
  apps: readonly CatalogApp[],
  setup: Setup,
  name: string
): CatalogApp[] => {
  const words = [
    ...(setup.template === undefined ? [] : (hints[setup.template] ?? [])),
    ...wordsOf(setup.job),
    ...wordsOf(name),
  ];
  const scored = apps
    .map((app) => ({ app, score: scoreOf(app, words) }))
    .filter(({ score }) => score > 0)
    .map(({ app, score }) => ({
      app,
      score: score + (app.connected ? connectedWeight : 0),
    }))
    .toSorted(
      (a, b) => b.score - a.score || a.app.name.localeCompare(b.app.name)
    )
    .map(({ app }) => app);
  if (scored.length > 0) {
    return scored.slice(0, recommendedMost);
  }
  return apps.filter(({ connected }) => connected).slice(0, recommendedMost);
};
