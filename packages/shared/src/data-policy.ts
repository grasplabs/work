import { z } from "zod";

import type { AppId } from "./ids.ts";

// Whether an App's data goes to code Grasp didn't serve: a portable host
// (spec 10.7.1, the App's UI outside Grasp's shell, holding an App token),
// whose code runs with the network a browser or a native app gives it.
// An App's own pages run in Grasp's sandboxed frame and get its data
// whatever this says (core's page-delivery.ts), but `ordinary` also lets
// them open the links their App declares on a click, without the person
// confirming each with the whole URL shown (core's app-link-route.ts).

/**
 * What an App's data is to code Grasp didn't serve:
 * - `sensitive`, as every App's is until an admin says otherwise: it gets
 *   none of it;
 * - `ordinary`: an admin accepted that it goes there, and out in its
 *   pages' declared links without the person confirming each.
 */
export const outputClassSchema = z.enum(["sensitive", "ordinary"]);
export type OutputClass = z.output<typeof outputClassSchema>;

/** A policy generation, as an admin was shown it. */
export const generationSchema = z.int().nonnegative();

/**
 * What an App's data is now (`output`), and the policy generation it was
 * read under: a classification names it, and a grant to the App or a
 * classification since moves it on.
 */
export interface DataPolicy {
  app: AppId;
  output: OutputClass;
  generation: number;
}

/**
 * A signed-in person's way to what an App's data is to code Grasp didn't
 * serve. Only the organization's own admins classify, from their own
 * session: never Grasp staff, an agent, a workflow or an App.
 */
export interface DataPolicyApi {
  /** What the App's data is now, for its builders, which every admin is. */
  read: (app: string) => Promise<DataPolicy>;
  /**
   * Says what the App's data is, under the policy generation the admin
   * read (`DataPolicy.generation`): refused with `page.review_outdated`
   * once it moved on, by a classification or a grant. `ordinary` holds
   * only for the permissions the App had when it was said: a permission
   * granted to the App afterwards makes its data `sensitive` again, in
   * the grant's batch, for an admin to decide again.
   */
  classify: (
    app: string,
    output: OutputClass,
    generation: number
  ) => Promise<OutputClass>;
}
