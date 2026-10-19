import { schemaFromDescriptor } from "@grasp-os/sdk/host";
import type { BoundWorkflowEvent } from "@grasp-os/sdk/host";

// The events of a workflow an App binds, as its references carry them
// (spec 10.4.6): `workflows.<wf>.events.<alias>` and the event waits of
// its listen tasks. Only events a person's screen may send become
// references: an event binding whose contract admits a browser-callable
// type (at most one, the catalog refuses more) is that type and its data's
// descriptor; any other event binding (a webhook's, a connector's, another
// workflow's emit) is no browser reference. A listen task becomes one of
// the App's event waits only when every type its filters name is its
// binding's browser-callable type: one waiting on another type of the same
// contract (a timeout beside a completion), alone or among others in an
// `any` or `all`, is left out, so no wait is typed by a descriptor that
// isn't the data it waits for. A type is never admitted without its data's
// contract, so no reference carries an untyped payload.

/** An event binding of a pinned version: its alias and its contract's types. */
export interface PinnedEventBinding {
  readonly alias: string;
  readonly events: Readonly<
    Record<string, { readonly data: string; readonly browser: boolean }>
  >;
}

/** A listen task as a version records it: its binding and its filters' types. */
export interface RecordedListen {
  readonly alias: string;
  readonly types: readonly string[];
}

/** What an App's reference carries of a bound workflow's events. */
export interface BoundEvents {
  readonly events: Record<string, BoundWorkflowEvent>;
  readonly listens: Record<string, string[]>;
}

/**
 * The events and listen tasks of a bound workflow version, from its event
 * bindings (`bindings`, each with its pinned catalog contract's types) and
 * the listen tasks its contract records (`listens`, task ID to binding and
 * filter types): browser-callable events only, and only the listen tasks
 * waiting on nothing but them.
 */
export const boundEventsOf = (
  bindings: readonly PinnedEventBinding[],
  listens: Readonly<Record<string, RecordedListen>>
): BoundEvents => {
  const events: Record<string, BoundWorkflowEvent> = {};
  for (const binding of bindings) {
    const sent = Object.entries(binding.events).filter(
      ([, event]) => event.browser
    );
    if (sent.length > 1) {
      // The catalog refuses this contract: one here is corrupt data.
      throw new Error(
        `Event binding ${binding.alias} admits more than one type a screen sends.`
      );
    }
    const [first] = sent;
    if (first !== undefined) {
      const [type, event] = first;
      events[binding.alias] = {
        type,
        data: schemaFromDescriptor(event.data).descriptor,
      };
    }
  }
  const tasks: Record<string, string[]> = {};
  for (const [task, listen] of Object.entries(listens)) {
    const sent = events[listen.alias]?.type;
    if (
      sent !== undefined &&
      listen.types.length > 0 &&
      listen.types.every((type) => type === sent)
    ) {
      tasks[task] = [listen.alias];
    }
  }
  return { events, listens: tasks };
};
