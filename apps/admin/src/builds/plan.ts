/**
 * The plan Grasp's agent writes before any code (src/builds/builds.ts),
 * which a person at Grasp approves or sends back: what the connector will
 * do, what each action may reach, and how a person signs in. It is data
 * only. The hosts it names are the only ones the connector's manifest may
 * name once it is written, so approving it decides where the new code can
 * reach.
 */
import {
  connectorNameSchema,
  hostSchema,
} from "@grasp-os/connector-kit/manifest";
import { permissionActionSchema } from "@grasp-os/shared/permissions";
import { z } from "zod";

/** Most actions one plan proposes: a connector's first version stays reviewable. */
const maxActions = 32;

/** Most hosts one connector may reach, as its manifest allows. */
const maxHosts = 16;

/** One action the connector will have. */
const plannedActionSchema = z.strictObject({
  /** Its permission action, such as `employees.read`. */
  action: permissionActionSchema,
  /** What it does, in a sentence the approver reads. */
  description: z.string().min(1).max(500),
  /** Whether it changes anything at the app, or only reads. */
  changes: z.boolean(),
  /** The hosts it reaches, each one of the plan's. */
  hosts: z.array(hostSchema).min(1).max(maxHosts),
});

export const buildPlanSchema = z
  .strictObject({
    /** The app's connector name, as the build's. */
    app: connectorNameSchema,
    /**
     * How a person signs in: Grasp's own OAuth app at the provider, whose
     * keys a person at Grasp registers, or an API key each company gives.
     */
    signIn: z.enum(["oauth2", "api_key"]),
    /** Every host the connector may reach, exactly. */
    hosts: z.array(hostSchema).min(1).max(maxHosts),
    actions: z.array(plannedActionSchema).min(1).max(maxActions),
    /** The public docs it was written from. */
    docs: z
      .array(z.url({ protocol: /^https$/u }))
      .min(1)
      .max(16),
  })
  .refine(
    ({ hosts }) => new Set(hosts).size === hosts.length,
    "Each host is named once"
  )
  .refine(
    ({ actions }) =>
      new Set(actions.map(({ action }) => action)).size === actions.length,
    "Each action is named once"
  )
  .refine(
    ({ hosts, actions }) =>
      actions.every((action) =>
        action.hosts.every((host) => hosts.includes(host))
      ),
    "Every action's host must be one of the plan's"
  );
export type BuildPlan = z.infer<typeof buildPlanSchema>;
