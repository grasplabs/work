// The time a run's deadlines are measured on: the wall clock, moved on by
// what the host advanced it (`WorkflowRun.advanceClock`), which nothing
// but a test does (an App's test's fixture clock, core's app-tests.ts). A
// run's sleeps, waits, retries, leases and retention all read it, and its
// alarm is set on the wall clock at what it says less the offset
// (run.ts, `sharingAlarm`), so a run moved on an hour wakes from an hour's
// sleep at once, and nothing of it waits on the wall clock for it. With
// no offset, which is every run but a test's, it is the wall clock.

/** Where the offset is kept, in the run object's own storage. */
const offsetKey = "workerflow_clock_offset_ms";

/** How far `storage`'s run is moved on from the wall clock, in ms. */
export const clockOffsetOf = (storage: DurableObjectStorage): number =>
  storage.kv.get<number>(offsetKey) ?? 0;

/** The time now, as `storage`'s run measures it. */
export const runNow = (storage: DurableObjectStorage): number =>
  Date.now() + clockOffsetOf(storage);

/** When `storage`'s alarm is set for, as its run measures time. */
export const runAlarmOf = async (
  storage: DurableObjectStorage
): Promise<number | null> => {
  const alarm = await storage.getAlarm();
  return alarm === null ? null : alarm + clockOffsetOf(storage);
};

/** Moves `storage`'s run's time `ms` on. */
export const moveClockOn = (
  storage: DurableObjectStorage,
  ms: number
): void => {
  storage.kv.put(offsetKey, clockOffsetOf(storage) + ms);
};
