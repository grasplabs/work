---
name: draw-a-workflow
description: Draws a workflow in the workflow map, step by step, with who does each step, in which tool, how often and how long it takes. Use to record how work runs today (drawn) or how it should run (designed).
---

# Draw a workflow

A workflow is one piece of recurring work, from what starts it to what ends it. Draw it in the workflow map App, which keeps it in its own store, every version of it too.

## Steps

1. **Pick the state.** `drawn` for how it runs today; `designed` for how it should run. Draw before you design: a design is measured against the drawing.
2. **Name it** by its outcome, such as "Pay supplier invoices", and set its `team` to the map's team that owns it (add the team in the map when it has none).
3. **List the `steps`** in order. For each: a short `name`, `who` does it (a role), the `tool` used, and `handover: true` when the work passes to someone else after it.
4. **Add each step's `numbers`** where known: `frequency` (times a week), `minutes` (each time) and `people` (each time), each as `{ value, basis }` with a `basis` of `estimated` or `observed`. Numbers belong on a step, never on the workflow as a whole.
5. **Designed only:** give each step its `kind` (`automated`, `ai_checked`, `tool` or `instruction`), list what can be set as `parameters: [{ name, value }]` (such as an approval limit), and estimate the time it saves as `gain: { hoursPerWeek }`.
6. **Write its description** for a person: what starts the work, what done looks like, and the statements it rests on, named by their sources in the intake.
7. **Design it** by saving the same workflow as `designed`: the map keeps the version of it last drawn, to set beside the design.

## Example step

```yaml
steps:
  - name: Match the invoice
    who: Controller
    tool: Exact Online
    handover: true
    numbers:
      frequency: { value: 40, basis: estimated }
      minutes: { value: 5, basis: observed }
      people: { value: 1, basis: estimated }
```

## Good to know

- Handovers and waiting are where time goes: record every one.
- Keep a step to one person doing one thing. Split steps that aren't.
- A designed workflow names the version of it last drawn (`drawnVersion`), so both can be compared. Once built, it is linked to the App workflow that runs it (`app`). Only the workflow map sets either: a save never changes them.
