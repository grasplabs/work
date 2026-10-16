/**
 * Sub-owners on the on-prem sandbox, on plain workerd: the supervisor
 * (workerd-sandbox.ts) holds one sub-owner of an owner (an App's builds,
 * of `platform:builder`) to part of that owner's share, places and waiting
 * room both, so another sub-owner always finds one or the other. Sessions
 * opened as core opens them, each held while its socket is open.
 */
import { once } from "node:events";
import { IncomingMessage, request as httpRequest } from "node:http";
import { Socket } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import {
  callIdHeader,
  cpuHeader,
  deadlineHeader,
  nativeWorkerd,
  ownerHeader,
  startSandboxSupervisor,
  subOwnerHeader,
  waitHeader,
} from "./workerd-sandbox.ts";
import type { SandboxSupervisor } from "./workerd-sandbox.ts";
import { cleanUp } from "./workerd-test-server.ts";

/** How long a refusal at once may take. */
const AT_ONCE_MS = 1000;

describe("sub-owners on the on-prem sandbox", () => {
  let supervisor: SandboxSupervisor;

  beforeAll(async () => {
    // Four processes: the builder's share is two, an App's part one.
    supervisor = await startSandboxSupervisor({
      workerd: nativeWorkerd,
      processes: 4,
      log: () => {},
    });
  }, 120_000);

  afterAll(async () => {
    await supervisor.stop();
    cleanUp();
  });

  /** A session opened as `subOwner` of the builder: its socket, or the status it was refused with. */
  const open = async (
    subOwner: string
  ): Promise<{ status: number; socket?: Socket; ms: number }> => {
    const started = Date.now();
    const upgrade = httpRequest({
      socketPath: supervisor.socket,
      path: "/session",
      headers: {
        connection: "upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        [deadlineHeader]: "20000",
        [cpuHeader]: "5000",
        [waitHeader]: "5000",
        [callIdHeader]: crypto.randomUUID(),
        [ownerHeader]: "platform:builder",
        [subOwnerHeader]: subOwner,
      },
    });
    upgrade.end();
    const answered = await Promise.race([
      once(upgrade, "upgrade").then((args: unknown[]) => ({
        args,
        upgraded: true,
      })),
      once(upgrade, "response").then((args: unknown[]) => ({
        args,
        upgraded: false,
      })),
    ]);
    const [first, second] = answered.args;
    const ms = Date.now() - started;
    if (answered.upgraded && second instanceof Socket) {
      return { status: 101, socket: second, ms };
    }
    if (first instanceof IncomingMessage) {
      first.resume();
      return { status: first.statusCode ?? 0, ms };
    }
    throw new TypeError("The session got no answer");
  };

  it("holds one sub-owner to part of its owner's places and waiting room, so another's session runs, and gives its places back", async () => {
    const held = await open("app-a");
    // Past its part: waits for its own place, though the owner has room.
    const waiting = open("app-a");
    await expect
      .poll(() => supervisor.stats().waitingForOwners, {
        timeout: 2000,
        interval: 50,
      })
      .toBe(1);
    // Past its part of the waiting room too: refused at once.
    const past = await open("app-a");
    // Another sub-owner takes the owner's other place at once.
    const other = await open("app-b");
    const placesWhileHeld = supervisor.stats().subOwnerPlaces;
    held.socket?.destroy();
    const turn = await waiting;

    expect({
      held: held.status,
      past: past.status,
      pastAtOnce: past.ms < AT_ONCE_MS,
      other: other.status,
      otherAtOnce: other.ms < AT_ONCE_MS,
      placesWhileHeld,
      turn: turn.status,
    }).toStrictEqual({
      held: 101,
      past: 429,
      pastAtOnce: true,
      other: 101,
      otherAtOnce: true,
      placesWhileHeld: 2,
      turn: 101,
    });
    other.socket?.destroy();
    turn.socket?.destroy();
    await expect
      .poll(() => supervisor.stats().subOwnerPlaces, {
        timeout: 5000,
        interval: 100,
      })
      .toBe(0);
  }, 60_000);

  it("refuses a session whose sub-owner is no owner's name", async () => {
    await expect(open("app a/../b")).resolves.toMatchObject({ status: 400 });
  });
});
