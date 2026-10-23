/**
 * A role card (role-card.ts): what someone who plays an employee of a
 * practice company reads, and nothing they couldn't know.
 */
import { describe, expect, it } from "vite-plus/test";

import { key } from "./keys/01-supplier-invoices.ts";
import { sliceOf } from "./keys/types.ts";
import { cardText, roleCardOf } from "./role-card.ts";

const [sanne] = key.employees;
if (sanne === undefined) {
  throw new Error("Key 01 has no first employee.");
}

describe("a role card", () => {
  const card = roleCardOf(key, sanne, "Robin Vermeulen");
  const text = cardText(card, "http://localhost:5173/interview#secret");

  it("says who they are and what to do with the card", () => {
    expect({
      who: card.who.startsWith(
        "You are Sanne de Vries, finance administrator of Bakker Installatietechniek B.V."
      ),
      lead: card.who.endsWith("Your team lead is Robin."),
      rules: card.rules.length,
      link: text.includes(
        "Your interview: http://localhost:5173/interview#secret"
      ),
    }).toStrictEqual({ who: true, lead: true, rules: 5, link: true });
  });

  it("holds every fact they know, and their numbers only as they remember them", () => {
    const missing = sliceOf(key, sanne).filter(
      (fact) =>
        !text.includes(
          fact.type === "number" ? (fact.remembered ?? "") : fact.text
        )
    );
    expect({
      missing,
      remembered: text.includes(
        "Supplier invoices per week: about a hundred, more at the end of the month"
      ),
      truth: text.includes("120"),
    }).toStrictEqual({ missing: [], remembered: true, truth: false });
  });

  it("says how they decide and when they stop and ask", () => {
    expect({
      decide: text.includes(
        "How you decide\n- Choose the project manager to ask from the delivery address and the name of the person who ordered."
      ),
      stop: text.includes(
        "When you stop and ask someone\n- Stop and ask the controller when a supplier asks to change its bank account number."
      ),
    }).toStrictEqual({ decide: true, stop: true });
  });

  it("holds nothing of what only others know", () => {
    const others = key.facts.filter(
      (fact) =>
        !sanne.knows.includes(fact.id) &&
        fact.text !== undefined &&
        text.includes(fact.text)
    );
    expect(others).toStrictEqual([]);
  });

  it("does not say twice where a step is done", () => {
    expect({
      once: text.includes("- Upload the invoice PDF to Exact Online.\n"),
      added: text.includes(
        "- Open the invoice email in the shared invoice mailbox. (in Outlook)"
      ),
    }).toStrictEqual({ once: true, added: true });
  });
});
