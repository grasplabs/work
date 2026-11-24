import { describe, expect, it } from "vite-plus/test";

import {
  formed,
  MOTION,
  moveBody,
  newBody,
  slotsOf,
  standIn,
  takeFigure,
} from "./sign-body.ts";
import type { PenPose, SignBody } from "./sign-body.ts";
import {
  PEN_TIP,
  SIGN_FIGURES,
  SIGN_PITCH,
  signFigure,
} from "./sign-figures.ts";
import type { SignFigure } from "./sign-figures.ts";

// How the dots of Grasp's sign move from one figure into the next
// (sign-body.ts), stepped frame by frame as the sign steps them; ported
// with the prototype's own tests of it.

const frame60 = 1 / 60;
/** How hard the spring pulls: its pull on a dot a distance away is this squared times that distance. */
const omega = 2 / MOTION.smooth;
const at = (values: ArrayLike<number>, index: number): number =>
  values[index] ?? 0;
const dotsOf = (body: { count: number }) =>
  Array.from({ length: body.count }, (_, dot) => dot);

/** Runs the sign on from `from` for some seconds, a frame at a time; `each` sees it after every frame. Returns the time it ends at. */
const run = (
  body: SignBody,
  from: number,
  seconds: number,
  {
    each,
    frame = frame60,
    pen,
  }: { each?: (now: number) => void; frame?: number; pen?: PenPose } = {}
): number => {
  let now = from;
  for (let step = 0; step < Math.round(seconds / frame); step += 1) {
    now += frame;
    moveBody(body, now, frame, pen);
    each?.(now);
  }
  return now;
};

/** A sign standing in a figure. */
const standing = (figure: SignFigure): SignBody => {
  const body = newBody();
  standIn(body, figure);
  return body;
};

/** A sign 0.3 seconds on its way from the head into the pen, at so many seconds a frame. */
const underWay = (frame: number): SignBody => {
  const body = standing("head");
  takeFigure(body, "pen", 0);
  run(body, 0, 0.3, { frame });
  return body;
};

/** The largest step any dot made from one frame to the next, and the largest change of that step: how fast, and how abruptly. */
const watch = (
  body: SignBody
): { see: () => void; most: () => { step: number; jolt: number } } => {
  const lastX = Float32Array.from(body.x);
  const lastY = Float32Array.from(body.y);
  const stepX = new Float32Array(body.count);
  const stepY = new Float32Array(body.count);
  let step = 0;
  let jolt = 0;
  return {
    see: () => {
      for (const dot of dotsOf(body)) {
        const dx = at(body.x, dot) - at(lastX, dot);
        const dy = at(body.y, dot) - at(lastY, dot);
        step = Math.max(step, Math.hypot(dx, dy));
        jolt = Math.max(
          jolt,
          Math.hypot(dx - at(stepX, dot), dy - at(stepY, dot))
        );
        stepX[dot] = dx;
        stepY[dot] = dy;
        lastX[dot] = at(body.x, dot);
        lastY[dot] = at(body.y, dot);
      }
    },
    most: () => ({ step, jolt }),
  };
};

/** How far the dots are from their places in a figure, at most. */
const off = (body: SignBody, figure: SignFigure): number => {
  const table = slotsOf(SIGN_FIGURES.indexOf(figure));
  return Math.max(
    ...dotsOf(body).map((dot) =>
      Math.max(
        Math.hypot(
          at(body.x, dot) - at(table.x, dot),
          at(body.y, dot) - at(table.y, dot)
        ),
        Math.abs(at(body.there, dot) - at(table.shown, dot))
      )
    )
  );
};

const fastest = (body: SignBody, ...speeds: Float32Array[]): number =>
  Math.max(
    ...speeds.flatMap((speed) =>
      dotsOf(body).map((dot) => Math.abs(at(speed, dot)))
    )
  );

describe("the sign taking a figure", () => {
  it("gathers out of its cloud into the head, and comes to rest", () => {
    const body = newBody();
    expect(Math.max(...body.there)).toBe(0);
    takeFigure(body, "head", 0);
    run(body, 0, 1.6);
    expect(off(body, "head")).toBeLessThan(0.01);
    expect(fastest(body, body.vx, body.vy)).toBeLessThan(0.02);
  });

  it.each(SIGN_FIGURES)(
    "stands in a figure at once when asked to, every dot in its place and at rest (%s)",
    (figure) => {
      const body = standing(figure);
      expect(off(body, figure)).toBe(0);
      expect(fastest(body, body.vx, body.vy, body.vthere)).toBe(0);
      expect(body.there.filter((there) => there === 1)).toHaveLength(
        signFigure(figure).length
      );
    }
  );

  it.each(SIGN_FIGURES)(
    "goes from the %s into every other figure without a jolt, never past its place, and has arrived within a second",
    (from) => {
      for (const to of SIGN_FIGURES.filter((figure) => figure !== from)) {
        const body = standing(from);
        const goal = slotsOf(SIGN_FIGURES.indexOf(to));
        // The longest way any dot has to go, and how far each still has to
        // go: that never grows.
        const left = Float32Array.from(dotsOf(body), (dot) =>
          Math.hypot(
            at(body.x, dot) - at(goal.x, dot),
            at(body.y, dot) - at(goal.y, dot)
          )
        );
        const longest = Math.max(...left);
        const seen = watch(body);
        let grew = false;
        takeFigure(body, to, 0);
        run(body, 0, 1, {
          each: () => {
            seen.see();
            for (const dot of dotsOf(body)) {
              const now = Math.hypot(
                at(body.x, dot) - at(goal.x, dot),
                at(body.y, dot) - at(goal.y, dot)
              );
              grew ||= now > at(left, dot) + 1e-4;
              left[dot] = now;
            }
          },
        });
        expect(grew).toBeFalsy();
        // A spring from rest is never faster than this, and never changes
        // pace more than this from one frame to the next.
        const { step, jolt } = seen.most();
        expect(step).toBeLessThanOrEqual(
          (longest * omega * frame60) / Math.E + 1e-3
        );
        expect(jolt).toBeLessThanOrEqual(
          longest * omega * omega * frame60 * frame60 + 1e-3
        );
        expect(off(body, to)).toBeLessThan(0.02);
      }
    },
    // Every dot of every frame of every pair is checked: slow on a busy
    // machine.
    60_000
  );

  it("takes a new figure while the last change is still under way, and still does not jolt", () => {
    const body = standing("head");
    const seen = watch(body);
    let now = 0;
    const figures: SignFigure[] = [
      "brain",
      "pen",
      "flow",
      "check",
      "head",
      "alert",
      "lines",
      "brain",
      "head",
    ];
    for (const [index, figure] of figures.entries()) {
      takeFigure(body, figure, now);
      // Sometimes in the middle of a change, sometimes barely into it.
      now = run(body, now, index % 2 === 0 ? 0.12 : 0.05, { each: seen.see });
    }
    run(body, now, 1.2, { each: seen.see });
    // The sign is 2 wide: nothing moves more than a twentieth of that in a
    // frame, or changes pace by more than a fiftieth.
    expect(seen.most().step).toBeLessThan(0.1);
    expect(seen.most().jolt).toBeLessThan(0.04);
    expect(off(body, "head")).toBeLessThan(0.01);
  });

  it("moves the same however many frames a second there are", () => {
    const usual = underWay(1 / 60);
    for (const frame of [1 / 30, 1 / 120, 1 / 144]) {
      const other = underWay(frame);
      const apart = Math.max(
        ...dotsOf(usual).map((dot) =>
          Math.hypot(
            at(usual.x, dot) - at(other.x, dot),
            at(usual.y, dot) - at(other.y, dot)
          )
        )
      );
      expect(apart).toBeLessThan(0.06);
    }
  });

  it("survives a frame that took half a second: nothing flies off", () => {
    const body = standing("head");
    takeFigure(body, "flow", 0);
    moveBody(body, 0.5, 0.5);
    for (const dot of dotsOf(body)) {
      expect(Number.isFinite(at(body.x, dot))).toBeTruthy();
      expect(Number.isFinite(at(body.there, dot))).toBeTruthy();
      expect(Math.abs(at(body.x, dot))).toBeLessThan(1.1);
      expect(Math.abs(at(body.y, dot))).toBeLessThan(1.1);
    }
    run(body, 0.5, 1);
    expect(off(body, "flow")).toBeLessThan(0.01);
  });

  it("changes as a wave from its top to its foot", () => {
    const body = standing("head");
    const brain = SIGN_FIGURES.indexOf("brain");
    const homes = signFigure("head");
    const heights = homes.map((home) => home.y);
    const top = heights.indexOf(Math.max(...heights));
    const foot = heights.indexOf(Math.min(...heights));
    takeFigure(body, "brain", 0);
    moveBody(body, frame60, frame60);
    expect(body.aim[top]).toBe(brain);
    expect(body.aim[foot]).not.toBe(brain);
    run(body, frame60, MOTION.wave + frame60);
    expect([...body.aim].every((aim) => aim === brain)).toBeTruthy();
  });

  it("moves as one mass: a dot that shares a place is seen on its way there, and gone when it arrives", () => {
    // Out of the head into the pen: most of the head's dots go to share a
    // place in the pen.
    const pen = slotsOf(SIGN_FIGURES.indexOf("pen"));
    const homes = signFigure("head");
    const homeX = (dot: number) => homes[dot]?.x ?? 0;
    const homeY = (dot: number) => homes[dot]?.y ?? 0;
    const journey = (dot: number) =>
      Math.hypot(at(pen.x, dot) - homeX(dot), at(pen.y, dot) - homeY(dot));
    const sharing = dotsOf(pen).filter(
      (dot) => pen.shown[dot] === 0 && journey(dot) > 0.3
    );
    expect(sharing.length).toBeGreaterThan(50);
    const way = (body: SignBody, dot: number) =>
      Math.hypot(at(body.x, dot) - homeX(dot), at(body.y, dot) - homeY(dot)) /
      journey(dot);
    const body = standing("head");
    takeFigure(body, "pen", 0);
    const halfway = new Map<number, number>();
    run(body, 0, 1.2, {
      each: () => {
        for (const dot of sharing) {
          if (!halfway.has(dot) && way(body, dot) >= 0.5) {
            halfway.set(dot, at(body.there, dot));
          }
        }
      },
    });
    // Halfway there, it is still all there.
    expect(halfway.size).toBe(sharing.length);
    expect(Math.min(...halfway.values())).toBeGreaterThan(0.9);
    expect(Math.max(...sharing.map((dot) => at(body.there, dot)))).toBeLessThan(
      0.01
    );
  });

  it("opens up as one mass: a dot that shared a place is seen as soon as it leaves it", () => {
    const pen = slotsOf(SIGN_FIGURES.indexOf("pen"));
    const homes = signFigure("head");
    const shared = dotsOf(pen).filter(
      (dot) =>
        pen.shown[dot] === 0 &&
        Math.hypot(
          at(pen.x, dot) - (homes[dot]?.x ?? 0),
          at(pen.y, dot) - (homes[dot]?.y ?? 0)
        ) > 0.3
    );
    const body = standing("pen");
    expect(shared.map((dot) => at(body.there, dot))).toStrictEqual(
      shared.map(() => 0)
    );
    takeFigure(body, "head", 0);
    const out = new Map<number, number>();
    run(body, 0, 1, {
      each: () => {
        for (const dot of shared) {
          // Two rows of dots away from where it stood, it is mostly there.
          const away = Math.hypot(
            at(body.x, dot) - at(pen.x, dot),
            at(body.y, dot) - at(pen.y, dot)
          );
          if (!out.has(dot) && away >= 2 * SIGN_PITCH) {
            out.set(dot, at(body.there, dot));
          }
        }
      },
    });
    expect(out.size).toBe(shared.length);
    expect(Math.min(...out.values())).toBeGreaterThan(0.6);
    expect(off(body, "head")).toBeLessThan(0.02);
  });

  it("never has a dot appear or go at once: how much it is seen changes little from frame to frame", () => {
    const body = standing("head");
    const last = Float32Array.from(body.there);
    let most = 0;
    let now = 0;
    const figures: SignFigure[] = [
      "pen",
      "flow",
      "check",
      "head",
      "brain",
      "alert",
      "lines",
      "head",
    ];
    const each = (): void => {
      for (const dot of dotsOf(body)) {
        most = Math.max(most, Math.abs(at(body.there, dot) - at(last, dot)));
        last[dot] = at(body.there, dot);
      }
    };
    for (const figure of figures) {
      takeFigure(body, figure, now);
      now = run(body, now, 0.9, { each });
    }
    // A sixth of the way in a frame at most: at least six frames, a tenth
    // of a second, from unseen to seen.
    expect(most).toBeLessThan(0.17);
  });

  it("says a figure has formed only a while after it began", () => {
    const body = standing("head");
    takeFigure(body, "brain", 10);
    expect(formed(body, 10)).toBe(0);
    expect(formed(body, 10 + MOTION.formed[0])).toBeCloseTo(0, 6);
    expect(
      formed(body, 10 + (MOTION.formed[0] + MOTION.formed[1]) / 2)
    ).toBeCloseTo(0.5, 5);
    expect(formed(body, 10 + MOTION.formed[1])).toBe(1);
    expect(formed(newBody(), 3)).toBe(0);
  });
});

const writingAt = (spot: number, lift = 0): PenPose => ({
  at: spot,
  lift,
  writing: true,
});

describe("the pen", () => {
  const index = SIGN_FIGURES.indexOf("pen");
  const table = slotsOf(index);
  const partOf = (part: number) =>
    dotsOf(table).filter(
      (dot) => table.shown[dot] === 1 && table.part[dot] === part
    );

  it("goes along its line, and the line is there as far as the pen has come", () => {
    const body = newBody();
    standIn(body, "pen", writingAt(0));
    // The pen stands at the head of its line, and almost none of the line
    // is there yet.
    for (const dot of partOf(1)) {
      expect(at(body.x, dot)).toBeCloseTo(at(table.x, dot) - PEN_TIP.travel, 5);
    }
    expect(
      partOf(0).filter((dot) => at(body.there, dot) > 0.5).length
    ).toBeLessThan(partOf(0).length / 5);
    // At the end of the line, all of it is.
    standIn(body, "pen", writingAt(1));
    for (const dot of partOf(1)) {
      expect(at(body.x, dot)).toBeCloseTo(at(table.x, dot) + PEN_TIP.travel, 5);
    }
    expect(partOf(0).every((dot) => at(body.there, dot) > 0.99)).toBeTruthy();
  });

  it("keeps what it has not written yet under its point, and lays it down as it passes", () => {
    const body = newBody();
    for (const spot of [0, 0.3, 0.6, 1]) {
      standIn(body, "pen", writingAt(spot));
      const point = PEN_TIP.x + (spot - 0.5) * 2 * PEN_TIP.travel;
      const line = partOf(0);
      // Written: in its place. Not yet: under the point.
      expect(line.map((dot) => at(body.x, dot).toFixed(4))).toStrictEqual(
        line.map((dot) => Math.min(at(table.x, dot), point).toFixed(4))
      );
      // And what is well ahead of the point is not seen.
      const ahead = line.filter((dot) => at(table.x, dot) > point + 0.08);
      expect(ahead.map((dot) => at(body.there, dot))).toStrictEqual(
        ahead.map(() => 0)
      );
    }
  });

  it("lifts off its line to start again, and the line goes", () => {
    const body = newBody();
    standIn(body, "pen", writingAt(0.5, 0.5));
    for (const dot of partOf(1)) {
      expect(at(body.y, dot)).toBeGreaterThan(at(table.y, dot) + 0.1);
    }
    standIn(body, "pen", writingAt(0, 1));
    expect(partOf(0).every((dot) => at(body.there, dot) === 0)).toBeTruthy();
  });

  it("at rest stands in the middle of its whole line", () => {
    expect(off(standing("pen"), "pen")).toBe(0);
  });

  it("keeps the dots that share its places unseen while it writes, however fast it goes back", () => {
    const body = standing("pen");
    const sharing = dotsOf(table).filter((dot) => table.shown[dot] === 0);
    takeFigure(body, "pen", 0);
    let written = 0;
    let now = 0;
    let most = 0;
    for (let step = 0; step < 400; step += 1) {
      now += frame60;
      written = (written + frame60 / 0.7) % 1.3;
      const lift = written > 1 ? (written - 1) / 0.3 : 0;
      moveBody(
        body,
        now,
        frame60,
        writingAt(written <= 1 ? written : 1 - lift, lift)
      );
      // Once the change of figure is well over.
      if (now > MOTION.over[1] + 0.5) {
        most = Math.max(most, ...sharing.map((dot) => at(body.there, dot)));
      }
    }
    expect(most).toBeLessThan(0.01);
  });

  it("follows its line softly while it writes: no dot jolts", () => {
    const body = standing("head");
    const seen = watch(body);
    takeFigure(body, "pen", 0);
    let written = 0;
    let now = 0;
    for (let step = 0; step < 300; step += 1) {
      now += frame60;
      written = (written + frame60 / 1.2) % 1.3;
      const lift = written > 1 ? (written - 1) / 0.3 : 0;
      moveBody(
        body,
        now,
        frame60,
        writingAt(written <= 1 ? written : 1 - lift, lift)
      );
      seen.see();
    }
    expect(seen.most().step).toBeLessThan(0.1);
    expect(seen.most().jolt).toBeLessThan(0.04);
  });
});
