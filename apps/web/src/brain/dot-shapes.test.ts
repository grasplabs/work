import { describe, expect, it } from "vite-plus/test";

import {
  CORE,
  dotShape,
  HEAD_EAR,
  LINK,
  NONE,
  OPEN,
  POINTS,
} from "./dot-shapes.ts";
import type { DotShape, ShapeKey } from "./dot-shapes.ts";

// The figures the brain takes (dot-shapes.ts): pure numbers, ported with
// the prototype's own tests of them.

const org = (teams: number[], leads = false): ShapeKey => ({
  kind: "org",
  teams,
  leads,
});
const known = [42, 38, 30, 18, 14, 9, 8, 6, 5];
const figures: ShapeKey[] = [
  { kind: "head" },
  { kind: "listen" },
  { kind: "listen", who: "claire" },
  { kind: "pair" },
  { kind: "crowd" },
  { kind: "sheets" },
  { kind: "laptop" },
  { kind: "brain" },
  { kind: "hub", linked: [true, false, false, true, false, false] },
  { kind: "spokes", count: 5 },
  org(known, true),
];

const points = Array.from({ length: POINTS }, (_, index) => index);
const at = (values: ArrayLike<number>, index: number): number =>
  values[index] ?? 0;
const xOf = (shape: DotShape, index: number) => at(shape.position, index * 3);
const yOf = (shape: DotShape, index: number) =>
  at(shape.position, index * 3 + 1);
const shown = (shape: DotShape, index: number) => shape.presence[index] === 1;
/** How many of a group's dots are seen: the spare ones repeat them. */
const seen = (shape: DotShape, group: number) =>
  points.filter((index) => shape.group[index] === group && shown(shape, index))
    .length;
/** A nerve's own dots that are seen. */
const ownDots = (shape: DotShape, nerve: number) =>
  points.filter((index) => shape.nerve[index] === nerve && shown(shape, index));
const fromMiddle = (shape: DotShape, index: number) =>
  Math.hypot(xOf(shape, index), yOf(shape, index));

describe("the brain shapes", () => {
  it.each(figures)(
    "has every point, fitted into the square, so one flows into the next ($kind)",
    (key) => {
      const shape = dotShape(key);
      const widest = Math.max(
        ...points.map((index) =>
          Math.max(Math.abs(xOf(shape, index)), Math.abs(yOf(shape, index)))
        )
      );
      expect(shape.position).toHaveLength(POINTS * 3);
      expect(widest).toBeLessThanOrEqual(1.05);
      expect(widest).toBeGreaterThan(0.3);
    }
  );

  it("connects a team once it is known, and gives a larger team more of the dots", () => {
    const seed = dotShape(org([0, 0, 3, 0, 0, 0, 0, 0, 0]));
    const all = dotShape(org(known));
    // Not known yet: a small node on a line still to make, grey with its team.
    expect(seen(seed, 0)).toBeGreaterThan(0);
    expect(seen(seed, 0)).toBeLessThan(seen(all, 0));
    // Only the one known team is connected: all nine are once the directory is in.
    expect(seen(all, LINK)).toBeGreaterThan(seen(seed, LINK) * 5);
    expect(seen(all, 0)).toBeGreaterThan(seen(all, 8));
    expect(all.group).not.toContain(NONE);
  });

  it("lights the leads only once they are known", () => {
    expect(dotShape(org(known)).hot.some((heat) => heat > 0)).toBeFalsy();
    expect(
      dotShape(org(known, true)).hot.some((heat) => heat > 0.5)
    ).toBeTruthy();
  });

  it("gives the listening head a voice and two heads a voice each", () => {
    const pair = dotShape({ kind: "pair" });
    const voices = new Set(
      points
        .filter((index) => at(pair.hot, index) > 0.5)
        .map((index) => pair.channel[index])
    );
    expect(
      dotShape({ kind: "listen" }).hot.some((heat) => heat > 0.5)
    ).toBeTruthy();
    expect(voices).toStrictEqual(new Set([0, 1]));
  });

  it("draws Claire from a portrait of her own, not Stephen's", () => {
    const his = dotShape({ kind: "listen" });
    const hers = dotShape({ kind: "listen", who: "claire" });
    expect(hers.position).not.toStrictEqual(his.position);
    expect(hers.hot.some((heat) => heat > 0.5)).toBeTruthy();
  });

  it("inks the places where documents live once they are connected, and leaves the rest open", () => {
    const none = dotShape({
      kind: "hub",
      linked: [false, false, false, false, false, false],
    });
    const two = dotShape({
      kind: "hub",
      linked: [true, true, false, false, false, false],
    });
    expect(seen(none, LINK)).toBe(0);
    expect(seen(none, OPEN)).toBeGreaterThan(0);
    expect(seen(two, LINK)).toBeGreaterThan(0);
    expect(seen(two, OPEN)).toBeLessThan(seen(none, OPEN));
  });

  it("knows where Stephen's ear is on the head, the dots the listening head warms", () => {
    const head = dotShape({ kind: "head" });
    const listening = dotShape({ kind: "listen" });
    const [earX, earY] = HEAD_EAR.at;
    const ear = points.filter(
      (index) =>
        shown(head, index) &&
        Math.hypot(xOf(head, index) - earX, yOf(head, index) - earY) <=
          HEAD_EAR.radius
    );
    expect(ear.length).toBeGreaterThan(20);
    expect(ear.every((index) => at(listening.hot, index) > 0)).toBeTruthy();
  });
});

describe("the brain in the middle of its nerves", () => {
  const networks: ShapeKey[] = [
    org(known),
    { kind: "hub", linked: [true, false, false, true, false, false] },
    { kind: "spokes", count: 3 },
  ];

  it.each(networks)(
    "stands in the middle, larger than everything around it ($kind)",
    (key) => {
      const shape = dotShape(key);
      const core = points.filter(
        (index) => shape.group[index] === CORE && shown(shape, index)
      );
      const middleX =
        core.reduce((sum, index) => sum + xOf(shape, index), 0) / core.length;
      const middleY =
        core.reduce((sum, index) => sum + yOf(shape, index), 0) / core.length;
      expect(shape.nerves.length).toBeGreaterThan(0);
      // More of the figure's dots are the brain than all of its places and nerves together.
      expect(core.length).toBeGreaterThan(
        shape.presence.filter((there) => there === 1).length / 2
      );
      expect(Math.abs(middleX)).toBeLessThan(0.1);
      expect(Math.abs(middleY)).toBeLessThan(0.15);
    }
  );

  const hub = dotShape({
    kind: "hub",
    linked: [true, true, false, false, false, false],
  });

  it.each([...hub.nerves.entries()])(
    "runs nerve %i from its place in to the brain's edge",
    (nerve, { x, y, along, group }) => {
      // It meets the brain's edge well before the brain's middle, and nearer the middle than its place is.
      expect(along).toBeGreaterThan(0.2);
      expect(along).toBeLessThan(0.95);
      expect(Math.hypot(x, y)).toBeLessThan(0.75);
      expect(group).toBe(nerve < 2 ? LINK : OPEN);
    }
  );

  it.each([...hub.nerves.entries()])(
    "knows how far along nerve %i each of its dots is",
    (nerve, { along }) => {
      const own = ownDots(hub, nerve);
      // Its dots run from the place, at 0, towards the brain: the further along, the nearer the middle.
      const far = own
        .filter((index) => at(hub.along, index) < 0.15)
        .map((index) => fromMiddle(hub, index));
      const near = own
        .filter((index) => at(hub.along, index) > along * 0.8)
        .map((index) => fromMiddle(hub, index));
      expect(own.length).toBeGreaterThan(5);
      expect(far.length).toBeGreaterThan(0);
      expect(near.length).toBeGreaterThan(0);
      expect(Math.min(...far)).toBeGreaterThan(Math.max(...near));
    }
  );

  it("puts the brain itself on no nerve, and gives a figure without nerves none", () => {
    expect(
      points.every(
        (index) => hub.group[index] !== CORE || hub.nerve[index] === NONE
      )
    ).toBeTruthy();
    expect(dotShape({ kind: "brain" }).nerves).toHaveLength(0);
    expect(
      dotShape({ kind: "head" }).nerve.every((nerve) => nerve === NONE)
    ).toBeTruthy();
  });

  it("keeps the brain and every other nerve where they are when one nerve is connected", () => {
    const one = dotShape({
      kind: "hub",
      linked: [true, false, false, false, false, false],
    });
    const two = dotShape({
      kind: "hub",
      linked: [true, false, false, false, false, true],
    });
    const same = (index: number) =>
      [0, 1, 2].every(
        (axis) =>
          one.position[index * 3 + axis] === two.position[index * 3 + axis]
      ) && one.presence[index] === two.presence[index];
    // Only the dots of the nerve that was connected, and of its place, change.
    const ofIt = (index: number) =>
      two.nerve[index] === 5 || one.nerve[index] === 5;
    expect(
      points.filter((index) => !ofIt(index) && !same(index))
    ).toStrictEqual([]);
    expect(
      points.filter((index) => ofIt(index) && !same(index)).length
    ).toBeGreaterThan(10);
  });

  it("is the same dots in every figure it stands in the middle of", () => {
    const hubbed = dotShape({
      kind: "hub",
      linked: [true, false, false, false, false, false],
    });
    const teams = dotShape(org(known));
    const core = points.filter(
      (index) => hubbed.group[index] === CORE && shown(hubbed, index)
    );
    expect(
      core.filter(
        (index) =>
          xOf(teams, index) !== xOf(hubbed, index) ||
          yOf(teams, index) !== yOf(hubbed, index)
      )
    ).toStrictEqual([]);
  });

  it("brings nerves from other steps in from beyond the picture, thinning out towards the edge", () => {
    const linked = [true, false, false, false, false, false];
    const one = dotShape({ kind: "hub", linked, beyond: 1 });
    const first = ownDots(one, 6);
    const inkAt = (from: number, to: number) => {
      const there = first.filter((index) => {
        const far = fromMiddle(one, index);
        return far >= from && far < to;
      });
      return (
        there.reduce((sum, index) => sum + at(one.ink, index), 0) /
        Math.max(there.length, 1)
      );
    };
    expect(one.nerves[6]?.group).toBe(LINK);
    expect(first.length).toBeGreaterThan(8);
    // It has no place at its end: it runs to the edge of the picture, its dots smaller the further out.
    expect(
      Math.max(...first.map((index) => fromMiddle(one, index)))
    ).toBeGreaterThan(0.9);
    expect(inkAt(0.9, 2)).toBeLessThan(inkAt(0, 0.7) * 0.5);
  });

  it("gives each nerve from beyond a place of its own: one more leaves the others where they are", () => {
    const linked = [true, false, false, false, false, false];
    const none = dotShape({ kind: "hub", linked });
    const one = dotShape({ kind: "hub", linked, beyond: 1 });
    const two = dotShape({ kind: "hub", linked, beyond: 2 });
    const first = ownDots(one, 6);
    expect([none, one, two].map((shape) => shape.nerves.length)).toStrictEqual([
      6, 7, 8,
    ]);
    expect(
      first.filter(
        (index) => two.nerve[index] !== 6 || xOf(two, index) !== xOf(one, index)
      )
    ).toStrictEqual([]);
    expect(ownDots(two, 7).length).toBeGreaterThan(8);
  });

  it("gives each spoke its own group, the same figure however many are filled", () => {
    const spokes = dotShape({ kind: "spokes", count: 5 });
    expect(
      [0, 1, 2, 3, 4].filter((group) => seen(spokes, group) === 0)
    ).toStrictEqual([]);
    expect(seen(spokes, CORE)).toBeGreaterThan(0);
  });
});
