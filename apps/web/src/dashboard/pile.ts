// The dashboard's pile of what waits on the person (`todo-pile.tsx`), as
// the prototype goes through it (`lib/todo.ts`, `data/todo-pile.ts`): one
// card on top at a time, in core's order, with the arrows going one on or
// one back, round and round. Skipping puts a card at the back of the pile
// for this visit to the app: it is given to nobody and put off to no date,
// and core never hears of it. Pure.

/** The card someone has on top: which item it is, and its place in the pile, for when that item is no longer there. */
export interface Place {
  id: string;
  index: number;
}

/** What the person did to the pile: the card they have on top, and those they skipped, the last skipped last. */
export interface Turned {
  at: Place | null;
  skipped: readonly string[];
}

/** A pile nobody went through yet: its first card on top, none skipped. */
export const untouched: Turned = { at: null, skipped: [] };

/**
 * The pile's order: what waits in core's order, with what was skipped at
 * the back, in the order it was skipped. What no longer waits drops out.
 */
export const orderOf = (
  ids: readonly string[],
  skipped: readonly string[]
): string[] => {
  const back = skipped.filter((id) => ids.includes(id));
  return [...ids.filter((id) => !back.includes(id)), ...back];
};

/**
 * The place of the card on top in the pile: the item last on top, while it
 * still waits; once it is dealt with, the one that came after it, which now
 * stands in its place, or the first past the end; the first when nothing
 * was on top yet. -1 when nothing waits.
 */
export const placeIn = (order: readonly string[], at: Place | null): number => {
  if (order.length === 0) {
    return -1;
  }
  if (at === null) {
    return 0;
  }
  const found = order.indexOf(at.id);
  return found === -1 ? Math.max(at.index, 0) % order.length : found;
};

/** The place one card on, or one back, going round: after the last comes the first. -1 when nothing waits. */
export const stepFrom = (count: number, place: number, by: 1 | -1): number =>
  count <= 0 ? -1 : (place + by + count) % count;

/** The pile turned one card on, or one back. */
export const turn = (
  ids: readonly string[],
  turned: Turned,
  by: 1 | -1
): Turned => {
  const order = orderOf(ids, turned.skipped);
  const next = stepFrom(order.length, placeIn(order, turned.at), by);
  const id = order[next];
  return id === undefined ? turned : { ...turned, at: { id, index: next } };
};

/**
 * The card on top skipped: it goes to the back of the pile, and the one
 * after it comes up in its place (the first, when it was the last). With
 * one card there is nothing to skip to.
 */
export const skip = (ids: readonly string[], turned: Turned): Turned => {
  const order = orderOf(ids, turned.skipped);
  const place = placeIn(order, turned.at);
  const id = order[place];
  if (id === undefined || order.length < 2) {
    return turned;
  }
  const skipped = [
    ...turned.skipped.filter((each) => each !== id && ids.includes(each)),
    id,
  ];
  const index = place === order.length - 1 ? 0 : place;
  const next = orderOf(ids, skipped)[index];
  return next === undefined ? turned : { skipped, at: { id: next, index } };
};
