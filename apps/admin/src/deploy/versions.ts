/**
 * What a release's Workers deploy in: the Durable Object migrations a
 * script's upload carries, worked out from the tag it is at as Wrangler
 * does, and the order the Workers go live in (connect before core, which
 * binds it).
 */
import type { WorkerEntry } from "@grasp-os/shared/release";

import { DeployError } from "./errors.ts";
/** The migrations section of a script upload, as the API takes it. */
interface MigrationsUpload {
  old_tag?: string;
  new_tag: string;
  steps: Record<string, unknown>[];
}

/**
 * The Durable Object migrations the script at `tag` hasn't run, from the
 * release's whole ordered history; none when it's at the last one. A tag
 * the history doesn't have is refused (`unknown_migration_tag`), where
 * Wrangler would run them all again: the script ran migrations this
 * release doesn't know, such as a later release's, and replaying the rest
 * could undo them.
 */
export const pendingMigrations = (
  history: WorkerEntry["durableObjectMigrations"],
  tag?: string
): MigrationsUpload | undefined => {
  const last = history.at(-1);
  const at =
    tag === undefined ? -1 : history.findIndex((step) => step.tag === tag);
  if (tag !== undefined && at === -1) {
    throw new DeployError(
      "unknown_migration_tag",
      `The script is at Durable Object migration ${tag}, which the release doesn't have`
    );
  }
  if (last === undefined || at === history.length - 1) {
    return undefined;
  }
  const steps = history.slice(at + 1).map(({ tag: _tag, ...step }) => step);
  return {
    ...(tag === undefined ? {} : { old_tag: tag }),
    new_tag: last.tag,
    steps,
  };
};

/**
 * The order to upload and deploy a release's Workers in, by app: each
 * Worker after every Worker it binds as a service (connect before core),
 * so none goes live before what it calls. Apps with no such tie keep
 * their name order. A cycle of service bindings has no such order, and is
 * refused (`service_binding_cycle`).
 */
export const deployOrder = (workers: Record<string, WorkerEntry>): string[] => {
  const appByName = new Map(
    Object.entries(workers).map(([app, worker]) => [worker.name, app])
  );
  /** The apps `app` binds as services, in the release. */
  const dependencies = (app: string): string[] =>
    (workers[app]?.bindings ?? []).flatMap((binding) => {
      const bound =
        binding.type === "service" && typeof binding.service === "string"
          ? appByName.get(binding.service)
          : undefined;
      return bound === undefined ? [] : [bound];
    });
  const order: string[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();
  const visit = (app: string): void => {
    if (done.has(app)) {
      return;
    }
    if (visiting.has(app)) {
      throw new DeployError(
        "service_binding_cycle",
        `The release's Workers bind each other in a cycle through ${app}`
      );
    }
    visiting.add(app);
    for (const dependency of dependencies(app).toSorted()) {
      visit(dependency);
    }
    visiting.delete(app);
    done.add(app);
    order.push(app);
  };
  for (const app of Object.keys(workers).toSorted()) {
    visit(app);
  }
  return order;
};
