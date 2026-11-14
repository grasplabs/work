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
  // Answers the staff with core's brainStaffReport, actOnBrainForStaff and
  // brainErasureForStaff, through their schemas.
  "apps/core/src/brain-report.ts": "core",
  // The Brain's Sources page, for people: its own surface, each method
  // probed as the signed-in person.
  "apps/core/src/brain-sources-rpc.ts": "sources",
  // Answers an admin's request with core's export and restore functions,
  // and a person's for their own export, whose probes hold what they
  // return, as they return it.
  "apps/core/src/brain-next-exports.ts": "core",
  // Erases the sources of runs past their retention and a deleted chat's
  // turns (its group) with core's eraseSource, and a disconnected
  // connection's captures (its group) with core's eraseOwnGroup, whose
  // count of them it answers (`eraseCaptures`) for their erasure's audit
  // event (capture-erasures.ts), and nothing else; names a chat's and its
  // turns' sources, and a connection's captures' group.
  "apps/core/src/brain-next-origins.ts": "core",
  // Core's producers for the Brain's hand-overs and their relay: puts keys
  // on the queue with core's queueHandOvers, and reads the sources it
  // hands over from core's own records; answers nothing of the Brain.
  "apps/core/src/brain-sources.ts": "core",
  // Erases what an erased person alone may read with core's erasePerson,
  // and answers nothing of it: `brainErasureStateOf` says only where core's
  // own record of that erasure stands, nothing the Brain answered.
  "apps/core/src/person-erasure.ts": "core",
  // Adds what a chat's agent read through a connection with core's
  // addSource, for the chat's person alone, and hands nothing on.
  "apps/core/src/connection-capture.ts": "core",
  // Writing and sharing skills (GRA-1754): its own surface, each export
  // probed as the signed-in person.
  "apps/core/src/skill-shares.ts": "shares",
  // Code's recall: an App's action, a workflow's step and a chat's code.
  "apps/core/src/brain-recall.ts": "recall",
  // Checks with core's readableVersionsAs that a run may still read what
  // it recalled, and hands on only a refusal.
  "apps/core/src/workflows/resource-reads.ts": "core",
  // A chat's recall before its question: hands the model what core's
  // recallAs gave the chat's own person, passages and memories, two of its
  // packs merged at most (mergeRecalled, which only drops what both hold
  // and orders them), as data; what an analysis says only ever becomes
  // that same person's question.
  "apps/core/src/turn-recall.ts": "core",
  // Checks what a chat once handed over with core's readableVersionsAs and
  // readableMemoriesAs, and hands on only which of those it may still
  // send, never what they say.
  "apps/core/src/history-access.ts": "core",
  // Remembers, forgets and corrects for a person, and reads entities for
  // them: its own surface, each export probed as the person.
  "apps/core/src/brain-memories.ts": "memories",
  // The chat's undo and the Brain's Memories page, for people: its own
  // surface, each method probed as the signed-in person.
  "apps/core/src/brain-memories-rpc.ts": "memoriesRpc",
  // The chat's tool that saves what a person says: reads core's
  // memoryChoices, and hands on nothing it returns beyond what
  // brain-memories.ts's probes hold.
  "apps/core/src/agent-remember.ts": "core",
  // Core's subclass of the store: its alarm's host, from core's
  // alarmHostOf, given to the store inside its own object; it adds no
  // method, so the store's probes are its own.
  "apps/core/src/brain-store.ts": "store",
} as const satisfies Readonly<Record<string, string>>;
