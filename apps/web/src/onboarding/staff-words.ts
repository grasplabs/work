import type {
  LogActor,
  StaffNeed,
  StaffStage,
  StageTodo,
} from "@grasp-os/shared/onboarding-staff";
import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

// What Grasp's onboarding area says of its stages, what needs Grasp and
// who did something, as in the prototype (`components/admin/stage-lines`,
// `need-lines.ts`): one place for the words, so the overview, the sidebar
// and the log say the same.

export const stageTitles: Record<StaffStage, MessageDescriptor> = {
  kickoff: msg({ message: "Kickoff", context: "onboarding stage" }),
  agreements: msg({ message: "Agreements", context: "onboarding stage" }),
  people: msg({ message: "People", context: "onboarding stage" }),
  leads: msg({ message: "Leads", context: "onboarding stage" }),
  interviews: msg({ message: "Interviews", context: "onboarding stage" }),
  open: msg({ message: "Open", context: "onboarding stage" }),
};

export const actorTitles: Record<LogActor, MessageDescriptor> = {
  staff: msg({ message: "Grasp's staff", context: "who did it, in the log" }),
  company: msg({ message: "The company", context: "who did it, in the log" }),
  person: msg({
    message: "Someone at the company",
    context: "who did it, in the log",
  }),
  grasp: msg({ message: "Grasp itself", context: "who did it, in the log" }),
};

type PlainTodo = Exclude<
  StageTodo["kind"],
  "leadsTalked" | "linksOut" | "talked" | "known"
>;

const plainTodos: Record<PlainTodo, MessageDescriptor> = {
  kickoff: msg`The kickoff with the company`,
  processing: msg`Data processing agreement signed`,
  assessment: msg`Risk assessment done`,
  council: msg`Works council heard, where there is one`,
  people: msg`Who works where is in`,
  leadsNamed: msg`Every team has its lead`,
  plan: msg`The interview days are set`,
  go: msg`Grasp gave its go`,
};

/** One thing a stage asks for, in words, with how far it is. */
export const todoText = (i18n: I18n, todo: StageTodo): string => {
  if (todo.kind === "known") {
    const { known, threshold } = todo;
    return i18n._(msg`Known: ${known}% of the ${threshold}% to open`);
  }
  if ("count" in todo) {
    const { count, of } = todo;
    if (todo.kind === "leadsTalked") {
      return i18n._(msg`Leads talked: ${count} of ${of}`);
    }
    return todo.kind === "linksOut"
      ? i18n._(msg`Links out: ${count} of ${of}`)
      : i18n._(msg`Talked: ${count} of ${of}`);
  }
  return i18n._(plainTodos[todo.kind]);
};

const agreementNeeds = {
  processing: msg`The data processing agreement isn't signed`,
  assessment: msg`The risk assessment isn't done`,
  council: msg`The works council hasn't been heard`,
} as const;

/** What needs Grasp, in words. */
export const needText = (i18n: I18n, need: StaffNeed): string => {
  if (need.kind === "agreement") {
    return i18n._(agreementNeeds[need.what]);
  }
  if (need.kind === "paused") {
    return i18n._(msg`The interviews are paused`);
  }
  if (need.kind === "lead") {
    const { teamName } = need;
    return i18n._(msg`${teamName}'s lead hasn't talked yet: the team waits`);
  }
  const { known, threshold } = need;
  return need.kind === "go"
    ? i18n._(
        msg`Enough is known (${known}% of ${threshold}%): the company waits for Grasp's go`
      )
    : i18n._(
        msg`The interviews are over with ${known}% known, short of ${threshold}%: Grasp decides`
      );
};
