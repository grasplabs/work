import type { TransportFailure } from "./model-transport.ts";

// A circuit breaker per transport, per isolate, for a deployment that
// fails over (`MODEL_TRANSPORT.failover`): after a run of failures
// that say the transport is down (5xx, no answer, refused credentials),
// its circuit opens and the gateway stops sending it requests for a
// while, failing over where the deployment set a failover transport
// (model-routing.ts), or refusing at once rather than adding to the load
// and to the requests that may be billed without an answer. After the
// pause one request is let through (half open): it closes the circuit if
// it works, and opens it again if it doesn't. A rate limit doesn't count:
// the endpoint is up, and asks for a wait the gateway already respects.
//
// Per isolate, in memory, by design: no extra round trip on the way to
// every model, and an isolate that can't reach a transport is the one that
// stops trying it. Isolates come and go, so a circuit is never open for
// long anywhere.

/** Failures within {@link failureWindowMs} that open a circuit. */
export const failuresToOpen = 5;

/** How far back failures count. */
export const failureWindowMs = 60_000;

/** How long an open circuit stays open before one request may try again. */
export const openForMs = 30_000;

interface Circuit {
  /** When each recent failure was, oldest first. */
  failures: number[];
  /** When it opened; none while closed. */
  openedAt: number | undefined;
  /**
   * Whether a request is trying it again, half open. A try that never
   * reports back (held by the ledger, say) lapses after {@link openForMs}.
   */
  trying: boolean;
  triedAt: number;
}

const circuits = new Map<string, Circuit>();

const circuitOf = (transport: string): Circuit => {
  let circuit = circuits.get(transport);
  if (circuit === undefined) {
    circuit = {
      failures: [],
      openedAt: undefined,
      trying: false,
      triedAt: 0,
    };
    circuits.set(transport, circuit);
  }
  return circuit;
};

/** Where a transport's circuit stands, as Setup shows it. */
export type CircuitState = "closed" | "open" | "half_open";

/** `transport`'s circuit at `now`. */
export const circuitState = (
  transport: string,
  now = Date.now()
): CircuitState => {
  const { openedAt } = circuitOf(transport);
  if (openedAt === undefined) {
    return "closed";
  }
  return now - openedAt < openForMs ? "open" : "half_open";
};

/**
 * Whether a request may go to `transport` now; takes the one try of a
 * half-open circuit, which `succeeded` or `failed` gives back.
 */
export const mayTry = (transport: string, now = Date.now()): boolean => {
  const circuit = circuitOf(transport);
  const state = circuitState(transport, now);
  if (state === "closed") {
    return true;
  }
  if (
    state === "open" ||
    (circuit.trying && now - circuit.triedAt < openForMs)
  ) {
    return false;
  }
  circuit.trying = true;
  circuit.triedAt = now;
  return true;
};

/** A request to `transport` worked: its circuit closes. */
export const succeeded = (transport: string): void => {
  circuits.set(transport, {
    failures: [],
    openedAt: undefined,
    trying: false,
    triedAt: 0,
  });
};

/** Whether `failure` says the transport, not the request, is at fault. */
const countsAgainst = (failure: TransportFailure): boolean =>
  failure.kind === "provider_down" || failure.kind === "auth";

/** A request to `transport` failed `failure`'s way, at `now`. */
export const failed = (
  transport: string,
  failure: TransportFailure,
  now = Date.now()
): void => {
  const circuit = circuitOf(transport);
  if (!countsAgainst(failure)) {
    circuit.trying = false;
    return;
  }
  if (circuit.trying) {
    // The try of a half-open circuit failed: open again, for a while.
    circuits.set(transport, {
      failures: [now],
      openedAt: now,
      trying: false,
      triedAt: 0,
    });
    return;
  }
  const failures = [
    ...circuit.failures.filter((at) => now - at < failureWindowMs),
    now,
  ];
  circuits.set(transport, {
    failures,
    openedAt: failures.length >= failuresToOpen ? now : circuit.openedAt,
    trying: false,
    triedAt: 0,
  });
};

/** Every circuit closed: for tests, which share an isolate. */
export const resetCircuits = (): void => {
  circuits.clear();
};
