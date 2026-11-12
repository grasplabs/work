/**
 * The modules of core that import its Brain module (src/brain-next.ts),
 * each with the surface of the Brain's permission harness that probes
 * what it hands on (`brainSurfaces`, brain-next-surfaces.ts). The lint
 * config (the root vite.config.ts) lets these alone import
 * src/brain-next.ts, so no module reaches the Brain without its probes,
 * and the harness fails when one names a surface it doesn't have. Plain
 * data, without imports: the lint config reads it outside workerd.
 *
 * A module whose exports are a way into the Brain of their own names its
 * own surface. One that only runs core's members, and hands on nothing
 * they return beyond what their probes already hold, names `core`.
 * Nothing checks that claim: a module mapped to an existing surface has
 * its own exports probed by no one, so its reviewer checks that it hands
 * on nothing new.
 */
export const brainModules = {
  "apps/core/src/instruction-files.ts": "instructions",
  // The skills' rules (GRA-1826): its own surface, each export probed.
  "apps/core/src/brain-skills.ts": "skills",
  // Runs core's workBrain on the clock, and hands nothing of it on.
  "apps/core/src/clock.ts": "core",
  // Answers the staff with core's brainStaffReport and actOnBrainForStaff,
  // through their schemas.
  "apps/core/src/brain-report.ts": "core",
  // The Brain's Sources page, for people: its own surface, each method
  // probed as the signed-in person.
  "apps/core/src/brain-sources-rpc.ts": "sources",
  // Erases the sources of runs past their retention with core's
  // eraseSource, and answers nothing of it.
  "apps/core/src/brain-next-origins.ts": "core",
  // Core's producers for the Brain's hand-overs and their relay: puts keys
  // on the queue with core's queueHandOvers, and reads the sources it
  // hands over from core's own records; answers nothing of the Brain.
  "apps/core/src/brain-sources.ts": "core",
  // Erases what an erased person alone may read with core's erasePerson,
  // and answers nothing of it.
  "apps/core/src/person-erasure.ts": "core",
  // Adds what a chat's agent read through a connection with core's
  // addSource, for the chat's person alone, and hands nothing on.
  "apps/core/src/connection-capture.ts": "core",
  // Core's subclass of the store: its alarm's host, from core's
  // alarmHostOf, given to the store inside its own object; it adds no
  // method, so the store's probes are its own.
  "apps/core/src/brain-store.ts": "store",
} as const satisfies Readonly<Record<string, string>>;
