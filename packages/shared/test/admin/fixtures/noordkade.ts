/**
 * Noordkade Finance, the sample client the rest of the prototype shows: only what the admin's
 * sample reads of it (`admin-sample.ts`), with the values the prototype's `data/noordkade.ts` gave
 * them, so the admin's tests count what they counted there. Made up, like the client itself.
 */

/** A number with how it is known: the client gave it. */
interface Figure {
  value: number | null;
  basis: "estimated";
  sourceId: string;
  date: string;
}

interface Connection {
  id: string;
  name: string;
  category: string;
  logo?: string;
  status: "connected" | "available";
  connectedBy?: string;
  connectedAt?: string;
  access?: string;
  signInAgain?: boolean;
}

interface WorkspaceMember {
  id: string;
  name: string;
  email: string;
  title: string;
  role: "owner" | "admin" | "viewer";
}

interface Invitation {
  email: string;
  role: "owner" | "admin" | "viewer";
  sentAt: string;
}

export const company: { name: string; hourlyCost: Figure } = {
  name: "Noordkade Finance",
  hourlyCost: {
    value: 55,
    basis: "estimated",
    sourceId: "src-finance",
    date: "2026-08-28",
  },
};

/** What Noordkade connected, in the catalog's order; what it did not connect is left out. */
export const connections: Connection[] = [
  {
    id: "microsoft-365",
    name: "Microsoft 365",
    category: "Mail, files and spreadsheets",
    logo: "microsoft-365.svg",
    status: "connected",
    connectedBy: "your IT admin",
    connectedAt: "2026-09-12",
    access:
      "Your directory, plus the mailboxes and folders a workflow is connected to",
  },
  {
    id: "microsoft-teams",
    name: "Microsoft Teams",
    category: "Approvals and messages",
    logo: "microsoft-teams.svg",
    status: "connected",
    connectedBy: "your IT admin",
    connectedAt: "2026-09-12",
    access: "Posts approval requests to the people who own a decision",
  },
  {
    id: "salesforce",
    name: "Salesforce",
    category: "CRM",
    logo: "salesforce.svg",
    status: "connected",
    connectedBy: "Mark Jansen",
    connectedAt: "2026-09-15",
    access: "Reads and creates client records; never deletes",
  },
  {
    id: "exact-online",
    name: "Exact Online",
    category: "Accounting",
    logo: "exact-online.svg",
    status: "connected",
    connectedBy: "Eva Bakker",
    connectedAt: "2026-09-18",
    access:
      "Reads ledgers and purchase orders; booking waits for a person to approve",
  },
  {
    id: "afas",
    name: "AFAS",
    category: "HR and payroll",
    logo: "afas.png",
    status: "available",
  },
  {
    id: "zoom",
    name: "Zoom",
    category: "Meetings",
    logo: "zoom.svg",
    status: "connected",
    connectedBy: "your IT admin",
    connectedAt: "2026-09-14",
    signInAgain: true,
    access: "Reads meeting transcripts for follow-ups",
  },
  {
    id: "firecrawl",
    name: "Firecrawl",
    category: "Reads PDFs, scans and web pages",
    logo: "https://logos.composio.dev/api/firecrawl",
    status: "connected",
    connectedBy: "Eva Bakker",
    connectedAt: "2026-09-09",
    access: "Reads the files a workflow hands it; keeps nothing",
  },
  {
    id: "typeform",
    name: "Typeform",
    category: "Forms",
    logo: "typeform.svg",
    status: "connected",
    connectedBy: "Lisa de Vries",
    connectedAt: "2026-09-16",
    access: "Reads new answers to the website’s forms",
  },
  {
    id: "calendly",
    name: "Calendly",
    category: "Booking a call",
    logo: "https://logos.composio.dev/api/calendly",
    status: "connected",
    connectedBy: "Lisa de Vries",
    connectedAt: "2026-09-16",
    access: "Reads which advisor has which booking page",
  },
];

/** The people with access to the workspace. */
export const members: WorkspaceMember[] = [
  {
    id: "member-sanne",
    name: "Sanne de Wit",
    email: "sanne.dewit@noordkade.nl",
    title: "COO",
    role: "owner",
  },
  {
    id: "member-daan",
    name: "Daan Kuiper",
    email: "daan.kuiper@noordkade.nl",
    title: "CEO",
    role: "owner",
  },
  {
    id: "member-pieter",
    name: "Pieter de Boer",
    email: "pieter.deboer@noordkade.nl",
    title: "IT admin",
    role: "admin",
  },
  {
    id: "member-ruben",
    name: "Ruben Altena",
    email: "ruben@joingrasp.com",
    title: "Grasp",
    role: "admin",
  },
  {
    id: "member-eva",
    name: "Eva Bakker",
    email: "eva.bakker@noordkade.nl",
    title: "Finance",
    role: "admin",
  },
  {
    id: "member-nina",
    name: "Nina Visser",
    email: "nina.visser@noordkade.nl",
    title: "Client onboarding",
    role: "admin",
  },
  {
    id: "member-mark",
    name: "Mark Jansen",
    email: "mark.jansen@noordkade.nl",
    title: "Mortgage advice",
    role: "admin",
  },
  {
    id: "member-lisa",
    name: "Lisa de Vries",
    email: "lisa.devries@noordkade.nl",
    title: "Customer service",
    role: "viewer",
  },
  {
    id: "member-joost",
    name: "Joost Smit",
    email: "joost.smit@noordkade.nl",
    title: "Compliance",
    role: "viewer",
  },
];

export const invitations: Invitation[] = [
  { email: "hr@noordkade.nl", role: "viewer", sentAt: "2026-09-21" },
];

export const workspaceSettings = { domain: "noordkade.nl" };

interface Billing {
  plan: { name: string };
  details: {
    email: string;
    company: string;
    address: string[];
    vatNumber?: string;
  };
}

/** What Stripe keeps for Noordkade: one monthly plan at a fixed price. */
export const billing: Billing = {
  plan: { name: "Team" },
  details: {
    email: "finance@noordkade.nl",
    company: "Noordkade Finance B.V.",
    address: ["Oostelijke Handelskade 12", "1019 BM Amsterdam", "Netherlands"],
    vatNumber: "NL862315478B01",
  },
};

/** Pulse, rolled out by the IT admin. */
export const pulse: { installedAt?: string } = { installedAt: "2026-09-15" };
