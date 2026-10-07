// The outside world the fixture's steps act on (test/death-fixture.ts): an
// HTTP server that records each effect it receives and can withhold its
// answer, so a test can kill workerd while an effect is out.
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { setTimeout as wait } from "node:timers/promises";

const pollMs = 25;
/** How long any wait in these tests may take before it fails. */
const deadlineMs = 20_000;

/** Polls `check` until it returns something, or throws at the deadline. */
export const until = async <T>(
  what: string,
  check: () => Promise<T | undefined> | T | undefined
): Promise<T> => {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    // oxlint-disable-next-line no-await-in-loop -- polling, one check at a time
    const value = await check();
    if (value !== undefined) {
      return value;
    }
    // oxlint-disable-next-line no-await-in-loop -- polling, one check at a time
    await wait(pollMs);
  }
  throw new Error(`timed out waiting for ${what}`);
};

/** One effect as the outside world received it. */
export interface Effect {
  run: string;
  label: string;
  key: string;
  attempt: number;
  receipt: string;
}

interface Arrival {
  run: string;
  label: string;
  attempt?: number;
}

interface Hold {
  matches: (arrival: Arrival) => boolean;
  held: PromiseWithResolvers<true>;
}

const isArrival = (value: unknown): value is Omit<Effect, "receipt"> =>
  typeof value === "object" &&
  value !== null &&
  "run" in value &&
  typeof value.run === "string";

export class Outside {
  readonly effects: Effect[] = [];
  readonly #holds: Hold[] = [];
  readonly #withheld: {
    arrival: Arrival;
    response: ServerResponse;
    answer: string;
  }[] = [];
  readonly #server = createServer((request, response) => {
    void this.#answer(request, response);
  });

  async listen(): Promise<number> {
    this.#server.listen(0, "127.0.0.1");
    await once(this.#server, "listening");
    const address = this.#server.address();
    if (address === null || typeof address === "string") {
      throw new Error("the effect server has no port");
    }
    return address.port;
  }

  /**
   * Withholds the answer to the effect `label` of `run` (at `attempt`, if
   * given), or to the announcement of `run`'s start (label "announce").
   * Resolves once it arrived: the effect happened, its step hasn't heard
   * back. Registered when called, so call it before the effect can arrive.
   */
  async hold(run: string, label: string, attempt?: number): Promise<void> {
    const held = Promise.withResolvers<true>();
    this.#holds.push({
      matches: (arrival) =>
        arrival.run === run &&
        arrival.label === label &&
        (attempt === undefined || arrival.attempt === attempt),
      held,
    });
    await held.promise;
  }

  /** Sends the answer withheld from `label` of `run`, late. */
  release(run: string, label: string): void {
    const index = this.#withheld.findIndex(
      ({ arrival }) => arrival.run === run && arrival.label === label
    );
    const [withheld] = index === -1 ? [] : this.#withheld.splice(index, 1);
    if (withheld === undefined) {
      throw new Error(`nothing of ${label} in ${run} is withheld`);
    }
    withheld.response.end(withheld.answer);
  }

  of(run: string, label?: string): Effect[] {
    return this.effects.filter(
      (effect) =>
        effect.run === run && (label === undefined || effect.label === label)
    );
  }

  async #answer(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    let body = "";
    for await (const chunk of request) {
      body += String(chunk);
    }
    const sent: unknown = JSON.parse(body);
    if (!isArrival(sent)) {
      response.statusCode = 400;
      response.end();
      return;
    }
    if (request.url === "/announce") {
      if (
        !this.#withhold({ run: sent.run, label: "announce" }, response, "{}")
      ) {
        response.end("{}");
      }
      return;
    }
    const receipt = `${sent.label}#${this.effects.length + 1}`;
    this.effects.push({ ...sent, receipt });
    if (!this.#withhold(sent, response, receipt)) {
      response.end(receipt);
    }
  }

  #withhold(
    arrival: Arrival,
    response: ServerResponse,
    answer: string
  ): boolean {
    const index = this.#holds.findIndex((hold) => hold.matches(arrival));
    if (index === -1) {
      return false;
    }
    const [hold] = this.#holds.splice(index, 1);
    this.#withheld.push({ arrival, response, answer });
    hold?.held.resolve(true);
    return true;
  }

  async close(): Promise<void> {
    for (const { response } of this.#withheld) {
      response.destroy();
    }
    this.#server.closeAllConnections();
    this.#server.close();
    await once(this.#server, "close");
  }
}
