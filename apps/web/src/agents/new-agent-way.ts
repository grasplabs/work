// The ways a new agent is made, on their own: the address that names one
// comes with the app (the route's validateSearch), the page doesn't.

/** The ways a new agent is made, by the names its address carries. */
export const newAgentWays = ["manual", "chat"] as const;
export type NewAgentWay = (typeof newAgentWays)[number];

/** The way an address names; none for any other, which asks again. */
export const newAgentWayOf = (value: unknown): NewAgentWay | undefined =>
  newAgentWays.find((way) => way === value);
