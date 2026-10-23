/**
 * `simulate`: a model plays everyone of a practice company who hasn't
 * talked yet, as people really answer (people.ts), each on their own link,
 * every turn a real turn of the local core. Who has which temper follows
 * from their place in the company and the seed, so a second company of
 * the same key meets the same people. Ported from the prototype
 * (grasplabs/prototype, packages/grasp: playRest in lab/cli.ts).
 */
import type { Interviewer } from "@grasp-os/shared/onboarding";

import { inTurns, linkOn, linksOf } from "./core.ts";
import type { Core } from "./core.ts";
import type { AnswerKey } from "./keys/types.ts";
import { realPlayer, realSystem, tempersFor } from "./people.ts";
import { employeeSystem, modelPlayer } from "./person.ts";
import { playInterview } from "./play.ts";
import { askerOf, keepPractice } from "./practice.ts";
import type { Practice, PracticePerson } from "./practice.ts";

export interface SimulateOptions {
  /** Only these people, by roster id or key id. */
  only: readonly string[] | null;
  /** Which mix of tempers. */
  seed: number;
  /** The first practice people, who tell all they know. */
  ideal: boolean;
  interviewer: Interviewer;
  /** How many interviews at once. */
  parallel: number;
  log: (line: string) => void;
}

/**
 * The device key to play `person` with: the one the lab opened their link
 * with before, or a new start when it was opened on another device
 * meanwhile. `null` when they talked already.
 */
const deviceKey = async (
  core: Core,
  person: PracticePerson,
  link: ReturnType<typeof linkOn>
): Promise<string | null | undefined> => {
  let session = await link.open(person.key);
  if (session.state === "elsewhere") {
    await core.session.api.onboardingStaff.newStart(person.id);
    session = await link.open();
  }
  if (session.state === "elsewhere") {
    throw new Error(`${person.name}'s link opens on another device.`);
  }
  if (session.progress?.person === "completed") {
    return null;
  }
  return session.key ?? person.key;
};

/** Lets a model play everyone asked for who hasn't talked yet; says how many it played. */
export const simulate = async (
  core: Core,
  practice: Practice,
  key: AnswerKey,
  { only, seed, ideal, interviewer, parallel, log }: SimulateOptions
): Promise<number> => {
  const tempers = tempersFor(practice.people.length, seed);
  const links = await linksOf(core);
  const asker = askerOf(core);
  const open = practice.people.filter(
    (person) =>
      person.played === undefined &&
      (only === null ||
        only.includes(person.id) ||
        only.includes(person.employee))
  );
  log(
    `A model plays ${open.length} people${ideal ? ", who tell all they know" : `, as people really answer (seed ${seed})`}`
  );
  const played = await inTurns(open, parallel, async (person) => {
    const employee = key.employees.find((each) => each.id === person.employee);
    const link = links.get(person.id);
    if (employee === undefined || link === undefined) {
      return false;
    }
    const onLink = linkOn(link);
    const deviced = await deviceKey(core, person, onLink);
    if (deviced === null) {
      return false;
    }
    const temper = tempers[practice.people.indexOf(person)] ?? "plain";
    const mark = `${key.id}:${employee.id}:${seed}`;
    const player = ideal
      ? modelPlayer(
          asker,
          employee.name,
          employeeSystem(key, employee, practice.lead.name, practice.locale),
          employee.knows
        )
      : realPlayer({
          asker,
          name: employee.name,
          system: realSystem({
            key,
            employee,
            lead: practice.lead.name,
            locale: practice.locale,
            temper,
            seed: mark,
          }),
          known: employee.knows,
          temper,
          seed: mark,
          locale: practice.locale,
        });
    log(`> ${person.id}`);
    const interview = await playInterview(onLink, player, {
      locale: practice.locale,
      interviewer,
      ...(ideal ? {} : { clock: "talk" as const }),
      ...(deviced === undefined ? {} : { key: deviced }),
    });
    const { key: device, answers: _answers, ...kept } = interview;
    person.key = device;
    person.played = {
      ...kept,
      interviewer,
      people: ideal ? "ideal" : "real",
      ...(ideal ? {} : { temper, seed }),
    };
    // Kept at once, so an interview that fails later loses none before it.
    keepPractice(practice);
    log(
      `< ${person.id}: ${interview.answers} answers${interview.left ? ", went away before the read-back" : ""}`
    );
    return true;
  });
  return played.filter(Boolean).length;
};
