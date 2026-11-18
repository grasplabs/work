import type { OfferedCatalog } from "@grasp-os/shared/connect";

// CONCEPT BRANCH ONLY, never merged. A local stack has no Composio key, so
// its catalog holds only the native apps (Microsoft 365, Google
// Workspace) and a directory of apps has nothing to show. These stand in
// for what Composio lists on a client's deployment, so the concepts can be
// judged with a full catalog. Brands the library draws (BrandIcon), so
// the marks are real; names, kinds and sentences as Composio gives them.

type Entry = OfferedCatalog["entries"][number];

const entry = (
  id: string,
  name: string,
  group: Entry["group"],
  description: string,
  toolCount: number,
  offered = true
): Entry => ({
  source: "composio",
  id,
  name,
  categories: [group],
  toolCount,
  logo: null,
  description,
  group,
  auth: "managed",
  offered,
});

export const sampleEntries: readonly Entry[] = [
  entry("slack", "Slack", "Chat", "Messages and channels for teams.", 42),
  entry("teams", "Microsoft Teams", "Chat", "Chat, meetings and calls.", 31),
  entry("discord", "Discord", "Chat", "Voice and text communities.", 18, false),
  entry("whatsapp", "WhatsApp", "Chat", "Messages with customers.", 9),
  entry("hubspot", "HubSpot", "CRM", "Contacts, deals and marketing.", 120),
  entry("linkedin", "LinkedIn", "Marketing", "Posts and company pages.", 14),
  entry(
    "notion",
    "Notion",
    "Files and documents",
    "Notes, docs and wikis.",
    36
  ),
  entry("dropbox", "Dropbox", "Files and documents", "Files in the cloud.", 22),
  entry("figma", "Figma", "Design and media", "Design files and comments.", 12),
  entry("youtube", "YouTube", "Design and media", "Videos and channels.", 16),
  entry(
    "stripe",
    "Stripe",
    "Finance and accounting",
    "Payments, invoices and payouts.",
    64
  ),
  entry(
    "shopify",
    "Shopify",
    "Commerce",
    "Orders, products and customers.",
    58
  ),
  entry(
    "trello",
    "Trello",
    "Projects and tasks",
    "Boards, lists and cards.",
    27
  ),
  entry(
    "github",
    "GitHub",
    "Projects and tasks",
    "Code, issues and pull requests.",
    88
  ),
  entry("zoom", "Zoom", "Email and calendar", "Meetings and recordings.", 19),
];

/** The catalog with the samples after its own entries, where Composio didn't list any. */
export const withSamples = (catalog: OfferedCatalog): OfferedCatalog =>
  catalog.composio === "listed"
    ? catalog
    : { ...catalog, entries: [...catalog.entries, ...sampleEntries] };
