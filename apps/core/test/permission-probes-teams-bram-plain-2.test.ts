import { probedThrough } from "./permission-probing.ts";

// Who may see what (GRA-731): the permission probes
// (fixtures/permission-probes.ts) Bram asks plainly, through the Teams door,
// each its own test: part 2 of 2, the rest in
// permission-probes-teams-bram-plain-1.test.ts. The members' probes are
// split by channel, asker and tactic over nine files like this one, so
// they run apart; permission-probes-controls.test.ts has their count, the
// controls and the outsiders, permission-probes-people-*.test.ts people
// matters.

probedThrough("teams", "bram", "ask", [2, 2]);
