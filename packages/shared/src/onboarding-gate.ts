// The gate of a deployment that is onboarding (core's onboarding/gate.ts):
// while it is closed, only the admins named in its sign-in settings and
// Grasp's staff come in; everyone else who signs in is told Grasp opens
// soon. Grasp's staff close it for the onboarding and open it with their
// go, once Grasp knows enough of the company or the interviews are over.

/** How much each source counts towards what Grasp knows, in percent. */
export const knownWeights = {
  /** The kickoff with the sponsor, and the website. */
  kickoff: 20,
  /** Who works where. */
  people: 15,
  /** Where the documents live. */
  sources: 5,
  /** The documents shared. */
  documents: 5,
  /** Pulse: the tools in use. */
  tools: 5,
  /** Who leads which team. */
  leads: 10,
  /** The interviews: the leads', then everyone else's, half each. */
  conversations: 30,
  /** What needs the admin settled, and the work drawn. */
  review: 10,
} as const;
export type KnownSource = keyof typeof knownWeights;

/** The thresholds staff choose from, and the one unless they choose. */
export const gateThresholds = [70, 80, 90] as const;
export type GateThreshold = (typeof gateThresholds)[number];
export const gateThresholdDefault: GateThreshold = 80;

/** One source of what Grasp knows, and how much of it is in (0 to 1). */
export interface KnownPart {
  source: KnownSource;
  weight: number;
  known: number;
}

/** Where the gate stands. */
export interface GateView {
  /** Open to everyone in the company. */
  open: boolean;
  /** Since when it is closed (ISO 8601), while it is. */
  closedSince: string | null;
  threshold: GateThreshold;
  /** How much Grasp knows, in percent, and of what. */
  known: number;
  parts: KnownPart[];
  /** Grasp knows enough, or the interviews are over: staff may give the go. */
  ready: boolean;
}

/** The gate over `/rpc`: read by the company's admin and staff, moved by staff only. */
export interface OnboardingGateApi {
  view: () => Promise<GateView>;
  /** Closes the deployment to all but its admins and staff, for the onboarding. */
  close: () => Promise<GateView>;
  /** Grasp's go: everyone in the company comes in. */
  open: () => Promise<GateView>;
  setThreshold: (threshold: GateThreshold) => Promise<GateView>;
}
