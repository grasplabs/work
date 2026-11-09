import { probedThrough } from "./permission-probing.ts";

// Who may see what (GRA-731): the permission probes
// (fixtures/permission-probes.ts) Bram asks with a pretext, through
// `Workspace.ask`, each its own test. The members' probes are split by
// channel, asker and tactic over nine files like this one, so they run
// apart; permission-probes-controls.test.ts has their count, the controls
// and the outsiders, permission-probes-people-*.test.ts people matters.

probedThrough("workspace", "bram", "pretext");
