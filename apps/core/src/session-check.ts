import { roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";

/**
 * Who is behind the connection, as its latest reading says (at most
 * {@link sessionRecheckMs} old); throws once the session has ended.
 */
export type SessionCheck = (() => Promise<Identity>) & {
  /**
   * Drops the latest reading, so the next check reads who is behind the
   * connection now: for when core learns their role or teams may have
   * changed (query-subscriptions.ts). A check that keeps no reading has
   * none.
   */
  readonly forget?: () => void;
};

/**
 * Runs `run` as the person behind the session: checks it first and hands
 * over the identity that check returned, so nothing reaches the person
 * without the check, or with an identity a method kept for itself. The
 * call checks it again before its answer goes back (call-context.ts).
 */
export const withPerson = async <T>(
  check: SessionCheck,
  run: (person: Identity) => T | Promise<T>
): Promise<T> => await run(await check());

/**
 * Whether `person` may act inside the client's workspace: a member, never
 * a Grasp staff session (`sessionIdentity`), which reaches the onboarding
 * alone. Asked of the staff mark itself too, so a staff identity that
 * somehow lacks `onboardingOnly` is still refused.
 */
export const reachesWorkspace = (
  person: Pick<Identity, "staff" | "onboardingOnly">
): boolean => !(person.staff || person.onboardingOnly === true);

/**
 * `check`, refusing Grasp staff with `role.forbidden`: what every
 * namespace but the onboarding's checks with. A staff session manages a
 * deployment and never acts inside the client's workspace
 * (`sessionIdentity`); a staff member added as a member signs in as one.
 */
export const fullAccess = (check: SessionCheck): SessionCheck =>
  Object.assign(
    async (): Promise<Identity> => {
      const person = await check();
      if (!reachesWorkspace(person)) {
        throw roleErrors.create("role.forbidden");
      }
      return person;
    },
    {
      forget: (): void => {
        check.forget?.();
      },
    }
  );

/**
 * How long one reading of who is behind a connection holds: a call, or a
 * push about to reach the page, reads again once the latest reading is
 * older than this, and nothing reads on a timer (rpc.ts). So a revoked or
 * expired session, a removal, a changed role or team, or a closed staff
 * window reaches whatever a connection still asks or is sent within this
 * long, even when the telling that makes it about a second
 * (identity-changes.ts) is lost; an idle connection reads nothing, and the
 * database's load follows the connections that are in use.
 *
 * What it costs: at most one reading (about four queries) per five seconds
 * per connection in use. A streaming answer is in use; a tab left open is
 * not. Raise it only with a measurement that shows tellings arrive (a
 * staging count of `identity.untold` against revocations made) and that
 * these readings weigh on the database (D1's queries per second); the
 * bound it gives is the most a lost telling lets a person keep getting.
 * A new connection always reads now.
 */
export const sessionRecheckMs = 5000;

/**
 * `read`, run again at most every `ms` and shared by everyone who asks
 * meanwhile: so a stream of calls or pushes costs a reading every few
 * seconds, not one each. A reading that fails isn't kept: the next ask
 * reads again, and so does the next ask once `forget` dropped the latest.
 */
export const recheckedEvery = <T>(
  ms: number,
  read: () => Promise<T>
): (() => Promise<T>) & { forget: () => void } => {
  let latest: { value: Promise<T>; until: number } | undefined;
  return Object.assign(
    async (): Promise<T> => {
      const now = Date.now();
      if (latest !== undefined && latest.until > now) {
        return await latest.value;
      }
      const reading = { value: read(), until: now + ms };
      latest = reading;
      try {
        return await reading.value;
      } catch (error) {
        if (latest === reading) {
          latest = undefined;
        }
        throw error;
      }
    },
    {
      forget: (): void => {
        latest = undefined;
      },
    }
  );
};

/**
 * `run`, made when asked, with asks that come together sharing runs: an
 * ask while a run is under way gets one more run after it (the run under
 * way may have begun before what the ask tells of), which every other ask
 * meanwhile shares. So however many asks come at once, at most two runs.
 * Never waited for: `run` handles its own failures.
 */
export const coalesced = (run: () => Promise<void>): (() => void) => {
  let running = false;
  let askedMeanwhile = false;
  const runs = async (): Promise<void> => {
    running = true;
    try {
      do {
        askedMeanwhile = false;
        // oxlint-disable-next-line no-await-in-loop -- one run at a time, again only if asked meanwhile
        await run();
      } while (askedMeanwhile);
    } finally {
      running = false;
    }
  };
  return (): void => {
    if (running) {
      askedMeanwhile = true;
      return;
    }
    void runs();
  };
};
