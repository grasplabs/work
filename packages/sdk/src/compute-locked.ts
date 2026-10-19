// Whether a module isolate is locked down (compute-lockdown.ts), for the
// runner to check: a module of its own, so the runner can import the
// lockdown itself as a side effect, first, and read this after.
export { lockedDown } from "./compute-lockdown.ts";
