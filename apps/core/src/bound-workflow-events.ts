import { schemaFromDescriptor } from "@grasp-os/sdk/host";
import type { BoundWorkflowEvent } from "@grasp-os/sdk/host";

// The events of a workflow an App binds, as its references carry them
// (spec 10.4.6): `workflows.<wf>.events.<alias>` and the event waits of
// its listen tasks. Only events a person's screen may send become
// references: an event binding whose contract admits a browser-callable
// type (at most one, the catalog refuses more) is that type and its data's
// descriptor; any other event binding (a webhook's, a connector's, another
// workflow's emit) is no browser reference, and the listen tasks waiting
// on it are left out of the App's waits too. A type is never admitted
// without its data's contract, so no reference carries an untyped payload.

/** An event binding of a pinned version: its alias and its contract's types. */
export interface PinnedEventBinding {
  readonly alias: string;
  readonly events: Readonly<
    Record<string, { readonly data: string; readonly browser: boolean }>
  >;
}

/** What an App's reference carries of a bound workflow's events. */
export interface BoundEvents {
  readonly events: Record<string, BoundWorkflowEvent>;
  readonly listens: Record<string, string[]>;
}

/**
 * The events and listen tasks of a bound workflow version, from its event
 * bindings (`bindings`, each with its pinned catalog contract's types) and
 * the listen tasks its contract records (`listens`, task ID to aliases):
 * browser-callable events only, and only the listen tasks waiting on them.
 */
export const boundEventsOf = (
  bindings: readonly PinnedEventBinding[],
  listens: Readonly<Record<string, readonly string[]>>
): BoundEvents => {
  const events: Record<string, BoundWorkflowEvent> = {};
  for (const binding of bindings) {
    const sent = Object.entries(binding.events).filter(
      ([, event]) => event.browser
    );
    const [first] = sent;
    // The catalog admits at most one browser-callable type per contract.
    if (first !== undefined && sent.length === 1) {
      const [type, event] = first;
      events[binding.alias] = {
        type,
        data: schemaFromDescriptor(event.data).descriptor,
      };
    }
  }
  const tasks: Record<string, string[]> = {};
  for (const [task, aliases] of Object.entries(listens)) {
    const kept = aliases.filter((alias) => Object.hasOwn(events, alias));
    if (kept.length > 0) {
      tasks[task] = kept;
    }
  }
  return { events, listens: tasks };
};
