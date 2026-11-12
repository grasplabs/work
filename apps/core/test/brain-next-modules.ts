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
 */
export const brainModules = {
  "apps/core/src/instruction-files.ts": "instructions",
  // Runs core's workBrain on the clock, and hands nothing of it on.
  "apps/core/src/clock.ts": "core",
  // Answers the staff with core's brainStaffReport and actOnBrainForStaff,
  // through their schemas.
  "apps/core/src/brain-report.ts": "core",
} as const satisfies Readonly<Record<string, string>>;
