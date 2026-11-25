// Concepts only: what the canvas concept (`?concept=d`) shows of the
// company's work as the interviews end, as fixtures until core serves it.
// Each comes from what core already draws when someone's interview ends:
// a team's map (team-map.ts) names its pieces of work; a piece of work's
// drawing (work-drawing.ts) names each step's tool, a list or sheet of
// someone's own (`own`), an AI tool (`ai`), and who gets the work next
// (`next`), when that is another team. What Grasp sees across them, and
// the ideas it forms, would be core's to say; here they are written out.
// `day` is the campaign's day (0 = its first) on which it was first heard.
// Never anyone's name, never anyone's words: Grasp's own.

/** A piece of work, as a team's map names it. */
export interface CanvasWork {
  id: string;
  team: string;
  name: string;
  day: number;
  /** How many steps are drawn so far. */
  steps: number;
  /** A step its people told two ways, and nobody could say why. */
  twoWays?: boolean;
}

/** What a tool is, for its picture. */
export type ToolKind = "system" | "sheet" | "chat" | "mail" | "paper" | "ai";

/** A tool a step was said to happen in, and the teams that named it. */
export interface CanvasTool {
  id: string;
  name: string;
  kind: ToolKind;
  day: number;
  /** In the order they first named it. */
  teams: string[];
  /** Someone's own list or sheet, beside the company's systems. */
  own?: boolean;
}

/** Work that goes from one team to another. */
export interface CanvasHandoff {
  id: string;
  from: string;
  to: string;
  what: string;
  day: number;
}

/** Something Grasp sees across the interviews (`trend`), or an idea it is forming (`idea`). */
export interface CanvasNote {
  id: string;
  kind: "trend" | "idea";
  text: string;
  day: number;
}

export interface CanvasPicture {
  works: CanvasWork[];
  tools: CanvasTool[];
  handoffs: CanvasHandoff[];
  notes: CanvasNote[];
}

/** Veldhuis Installatie: five teams, as the campaign fixtures. */
const company: CanvasPicture = {
  works: [
    { id: "w1", team: "planning", name: "Planning the week", day: 0, steps: 6 },
    {
      id: "w2",
      team: "planning",
      name: "Urgent call-outs",
      day: 1,
      steps: 4,
      twoWays: true,
    },
    {
      id: "w3",
      team: "planning",
      name: "Moving a booked job",
      day: 2,
      steps: 5,
    },
    { id: "w4", team: "planning", name: "Holiday cover", day: 4, steps: 3 },
    { id: "w5", team: "field", name: "A job on site", day: 0, steps: 7 },
    {
      id: "w6",
      team: "field",
      name: "Closing a work order",
      day: 1,
      steps: 4,
      twoWays: true,
    },
    { id: "w7", team: "field", name: "Parts used on site", day: 2, steps: 3 },
    { id: "w8", team: "field", name: "Restocking the van", day: 4, steps: 4 },
    {
      id: "w9",
      team: "service",
      name: "When is the engineer coming",
      day: 1,
      steps: 3,
    },
    {
      id: "w10",
      team: "service",
      name: "Taking a complaint",
      day: 4,
      steps: 4,
      twoWays: true,
    },
    { id: "w11", team: "service", name: "Booking a repair", day: 5, steps: 5 },
    { id: "w12", team: "finance", name: "Sending invoices", day: 0, steps: 5 },
    {
      id: "w13",
      team: "finance",
      name: "Credit check",
      day: 2,
      steps: 3,
      twoWays: true,
    },
    { id: "w14", team: "finance", name: "Chasing payments", day: 3, steps: 4 },
    { id: "w15", team: "purchasing", name: "Ordering stock", day: 1, steps: 4 },
    {
      id: "w16",
      team: "purchasing",
      name: "Supplier returns",
      day: 5,
      steps: 3,
    },
  ],
  tools: [
    {
      id: "t1",
      name: "Whiteboard",
      kind: "paper",
      day: 0,
      teams: ["planning"],
    },
    {
      id: "t2",
      name: "Planning tool",
      kind: "system",
      day: 0,
      teams: ["planning", "service"],
    },
    {
      id: "t3",
      name: "WhatsApp",
      kind: "chat",
      day: 0,
      teams: ["field", "planning"],
    },
    {
      id: "t4",
      name: "Paper work order",
      kind: "paper",
      day: 0,
      teams: ["field"],
    },
    {
      id: "t5",
      name: "Exact Online",
      kind: "system",
      day: 0,
      teams: ["finance"],
    },
    {
      id: "t6",
      name: "Shared mailbox",
      kind: "mail",
      day: 1,
      teams: ["service", "finance"],
    },
    {
      id: "t7",
      name: "Stock list",
      kind: "sheet",
      day: 1,
      teams: ["purchasing", "field"],
      own: true,
    },
    {
      id: "t8",
      name: "Invoice checklist",
      kind: "sheet",
      day: 2,
      teams: ["finance"],
      own: true,
    },
    { id: "t9", name: "ChatGPT", kind: "ai", day: 3, teams: ["finance"] },
    {
      id: "t10",
      name: "Complaints sheet",
      kind: "sheet",
      day: 4,
      teams: ["service"],
      own: true,
    },
  ],
  handoffs: [
    { id: "h1", from: "field", to: "finance", what: "Work orders", day: 0 },
    {
      id: "h2",
      from: "planning",
      to: "field",
      what: "The week’s jobs",
      day: 1,
    },
    { id: "h3", from: "service", to: "planning", what: "Urgent calls", day: 2 },
    { id: "h4", from: "field", to: "purchasing", what: "Parts used", day: 4 },
  ],
  notes: [
    {
      id: "n1",
      kind: "trend",
      day: 0,
      text: "WhatsApp carries the work between the field and the office.",
    },
    {
      id: "n2",
      kind: "trend",
      day: 1,
      text: "A work order is written twice: on paper on site, then typed over in the office.",
    },
    {
      id: "n3",
      kind: "idea",
      day: 2,
      text: "A work order filled in once, on site, could reach planning and finance by itself.",
    },
    {
      id: "n4",
      kind: "trend",
      day: 3,
      text: "Three teams keep a list of their own beside the systems.",
    },
    {
      id: "n5",
      kind: "trend",
      day: 4,
      text: "Finance waits each week for field service before an invoice can go out.",
    },
    {
      id: "n6",
      kind: "idea",
      day: 4,
      text: "A minimum per shelf, written down once, would end ordering by eye.",
    },
    {
      id: "n7",
      kind: "idea",
      day: 5,
      text: "An arrival time customer service can see, without calling planning.",
    },
  ],
};

/** Studio Lindeboom: seven people, no teams. */
const studio: CanvasPicture = {
  works: [
    {
      id: "s1",
      team: "everyone",
      name: "Starting a project",
      day: 0,
      steps: 5,
    },
    { id: "s2", team: "everyone", name: "Permit drawings", day: 1, steps: 6 },
    {
      id: "s3",
      team: "everyone",
      name: "Logging hours",
      day: 2,
      steps: 3,
      twoWays: true,
    },
    { id: "s4", team: "everyone", name: "Invoicing a phase", day: 3, steps: 4 },
  ],
  tools: [
    { id: "u1", name: "ArchiCAD", kind: "system", day: 0, teams: ["everyone"] },
    {
      id: "u2",
      name: "Timesheet",
      kind: "sheet",
      day: 1,
      teams: ["everyone"],
      own: true,
    },
    {
      id: "u3",
      name: "Printed drawings",
      kind: "paper",
      day: 1,
      teams: ["everyone"],
    },
    { id: "u4", name: "Outlook", kind: "mail", day: 2, teams: ["everyone"] },
  ],
  handoffs: [],
  notes: [
    {
      id: "m1",
      kind: "trend",
      day: 1,
      text: "Drawings are checked on paper, then the changes are drawn again.",
    },
    {
      id: "m2",
      kind: "idea",
      day: 3,
      text: "Hours logged once a day could turn into the phase invoice by themselves.",
    },
  ],
};

/** The picture for a company with teams, or without. */
export const pictureFor = (grouped: boolean): CanvasPicture =>
  grouped ? company : studio;

/** The picture as it stood at the end of `day`. */
export const pictureOn = (
  picture: CanvasPicture,
  day: number
): CanvasPicture => ({
  works: picture.works.filter((each) => each.day <= day),
  tools: picture.tools.filter((each) => each.day <= day),
  handoffs: picture.handoffs.filter((each) => each.day <= day),
  notes: picture.notes.filter((each) => each.day <= day),
});
