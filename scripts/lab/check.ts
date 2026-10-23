/**
 * The check of the judge against people. The judge is a model, so before
 * its numbers decide anything, people answer the questions it answered,
 * without seeing what it said: did the person say this fact, and does this
 * note rest on what they said. A page shows each conversation with its
 * questions and saves the answers as a file; the lab then counts how often
 * the judge agrees. Nine in ten is the least for it to be trusted. Pure but
 * for reading what `score` kept. Ported from the prototype
 * (grasplabs/prototype, packages/grasp: lab/check.ts, check in lab/cli.ts).
 */
import path from "node:path";

import { z } from "zod";

import { folderOf, keptJson } from "./kept.ts";
import { isHidden, keyOf } from "./keys/index.ts";
import { sliceOf } from "./keys/types.ts";
import type { Said } from "./person.ts";

/** One question for a person: about a fact the interviewee knows, or about a note Stephen made. */
export interface CheckItem {
  id: string;
  /** The interview it is about. */
  interview: string;
  kind: "said" | "supported";
  text: string;
  /** What the judge answered: never on the page. */
  judge: boolean;
}

export interface CheckInterview {
  id: string;
  name: string;
  lines: Said[];
}

/** Nine in ten: the least the judge must agree with people before its numbers decide anything. */
export const trustedFrom = 0.9;

/** How many questions a page asks. */
const asked = 50;

const hashBase = 31;
const hashModulus = 1_000_003;

/** A number from a text that is the same every time: what makes a pick of items the same for everyone who checks. */
const numberOf = (text: string): number => {
  let sum = 0;
  for (const letter of text) {
    sum = (sum * hashBase + (letter.codePointAt(0) ?? 0)) % hashModulus;
  }
  return sum;
};

/**
 * The items people are asked, at most `most`: every one the judge said no
 * to, as far as half of them go, since those are few and matter most, then
 * the rest from its yeses; the same pick for everyone, and mixed, so
 * nobody sees a pattern.
 */
export const pickItems = (
  all: readonly CheckItem[],
  most = asked
): CheckItem[] => {
  const mixed = all.toSorted((a, b) => numberOf(a.id) - numberOf(b.id));
  const no = mixed.filter((item) => !item.judge).slice(0, Math.floor(most / 2));
  const yes = mixed.filter((item) => item.judge).slice(0, most - no.length);
  return [...no, ...yes].toSorted(
    (a, b) =>
      a.interview.localeCompare(b.interview) || numberOf(a.id) - numberOf(b.id)
  );
};

export interface Agreement {
  answered: number;
  agreed: number;
  byKind: Record<CheckItem["kind"], { answered: number; agreed: number }>;
  /** Where the judge and the person differ: the question, and what the person said. */
  differ: { item: CheckItem; person: boolean }[];
}

/** How often the judge agrees with what a person answered, by item id. */
export const agreementOf = (
  items: readonly CheckItem[],
  answers: Readonly<Record<string, boolean>>
): Agreement => {
  const answered = items.filter((item) => answers[item.id] !== undefined);
  const agrees = (item: CheckItem) => answers[item.id] === item.judge;
  const kind = (which: CheckItem["kind"]) => {
    const of = answered.filter((item) => item.kind === which);
    return { answered: of.length, agreed: of.filter(agrees).length };
  };
  return {
    answered: answered.length,
    agreed: answered.filter(agrees).length,
    byKind: { said: kind("said"), supported: kind("supported") },
    differ: answered
      .filter((item) => !agrees(item))
      .map((item) => ({ item, person: answers[item.id] === true })),
  };
};

/** What someone answered on the page, as the page saves it. */
export const answersSchema = z.object({
  by: z.string(),
  at: z.string().optional(),
  answers: z.record(z.string(), z.boolean()),
});

/** What `score` kept of a practice company, as far as the check reads it. */
const scoresSchema = z.object({
  practice: z.string(),
  key: z.string(),
  scored: z.array(
    z.object({
      person: z.object({
        id: z.string(),
        name: z.string(),
        employee: z.string(),
      }),
      judged: z.object({
        known: z.array(z.object({ id: z.string(), said: z.boolean() })),
        written: z.array(z.object({ id: z.string(), verdict: z.string() })),
      }),
      lines: z.array(
        z.object({ from: z.enum(["stephen", "person"]), text: z.string() })
      ),
      facts: z.array(z.object({ id: z.string(), record: z.string() })),
    })
  ),
});
export type KeptScores = z.output<typeof scoresSchema>;

/** What `score` kept of a practice company of `key`; none when it wasn't scored. */
export const keptScores = (
  practice: string,
  key: string
): KeptScores | undefined =>
  keptJson(
    path.join(folderOf("out", key), practice, "scores.json"),
    scoresSchema
  );

/**
 * Every question the judge answered about the scored interviews of some
 * practice companies, with the conversations they are about. Never of a
 * hidden key: nobody reads those.
 */
export const checkOf = (
  kept: readonly KeptScores[]
): { interviews: CheckInterview[]; items: CheckItem[] } => {
  const interviews: CheckInterview[] = [];
  const items: CheckItem[] = [];
  for (const scores of kept.filter((each) => !isHidden(each.key))) {
    const key = keyOf(scores.key);
    for (const { person, judged, lines, facts } of scores.scored) {
      const employee = key?.employees.find(
        (each) => each.id === person.employee
      );
      if (key === undefined || employee === undefined) {
        continue;
      }
      const id = `${scores.practice.slice(-4)}/${person.id}`;
      interviews.push({ id, name: person.name, lines });
      const slice = sliceOf(key, employee);
      for (const each of judged.known) {
        const fact = slice.find((known) => known.id === each.id);
        if (fact !== undefined) {
          items.push({
            id: `${id}/said/${each.id}`,
            interview: id,
            kind: "said",
            text: `${fact.text}${fact.remembered === undefined ? "" : ` (${fact.remembered})`}`,
            judge: each.said,
          });
        }
      }
      for (const each of judged.written) {
        const fact = facts.find((written) => written.id === each.id);
        // A repeat was said too: the question is only whether the note rests on their words.
        if (fact !== undefined) {
          items.push({
            id: `${id}/supported/${each.id}`,
            interview: id,
            kind: "supported",
            text: fact.record,
            judge: each.verdict !== "not said",
          });
        }
      }
    }
  }
  return { interviews, items };
};

const ampersand = /&/gu;
const lessThan = /</gu;
const greaterThan = />/gu;
const quote = /"/gu;

/** Text as HTML shows it, and nothing more. */
export const escaped = (text: string): string =>
  text
    .replace(ampersand, "&amp;")
    .replace(lessThan, "&lt;")
    .replace(greaterThan, "&gt;")
    .replace(quote, "&quot;");

/** How the lab's pages look: plain, light and dark, nothing loaded from elsewhere. */
export const pageStyle = `:root{--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--line:#e7e5e4;--card:#fff;--on:#1c1917;--onfg:#fafaf9;--good:#15803d;--bad:#b91c1c}
@media (prefers-color-scheme:dark){:root{--bg:#0c0a09;--fg:#f5f5f4;--muted:#a8a29e;--line:#292524;--card:#1c1917;--on:#f5f5f4;--onfg:#0c0a09;--good:#4ade80;--bad:#f87171;color-scheme:dark}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 Geist,ui-sans-serif,system-ui,sans-serif;padding:32px 16px 96px}
main{max-width:860px;margin:0 auto;display:flex;flex-direction:column;gap:24px}
h1{font-size:24px;font-weight:500;line-height:1.2;margin:0}h2{font-size:16px;font-weight:500;margin:0}h3{font-size:14px;font-weight:500;margin:0}
p{margin:0}.muted{color:var(--muted)}small{font-size:12px;color:var(--muted)}.good{color:var(--good)}.bad{color:var(--bad)}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px;display:flex;flex-direction:column;gap:12px;overflow-x:auto}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:6px 8px;border-top:1px solid var(--line);vertical-align:top}th{font-weight:500;color:var(--muted)}
.talk{max-height:320px;overflow:auto;display:flex;flex-direction:column;gap:6px;border-top:1px solid var(--line);padding-top:12px}
.talk b{font-weight:500}.talk .s{color:var(--muted)}
.item{border-top:1px solid var(--line);padding-top:12px;display:flex;flex-direction:column;gap:8px}
.ask{display:flex;gap:8px;flex-wrap:wrap}
button{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:8px;padding:6px 14px;cursor:pointer}
button[aria-pressed="true"]{background:var(--on);color:var(--onfg);border-color:var(--on)}
footer{position:fixed;left:0;right:0;bottom:0;background:var(--card);border-top:1px solid var(--line);padding:12px 16px;display:flex;gap:12px;align-items:center;justify-content:center;flex-wrap:wrap}
input{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:8px;padding:6px 10px}`;

/** What the page does: keeps each answer in the browser, and saves them all as one file. */
const checkScript = `const KEY='grasp.lab.judge-check';let answers={};try{answers=JSON.parse(localStorage.getItem(KEY)||'{}')}catch{}
const show=()=>{let done=0;document.querySelectorAll('.item').forEach(item=>{const given=answers[item.dataset.id];if(typeof given==='boolean')done++;item.querySelectorAll('button').forEach(button=>button.setAttribute('aria-pressed',String(given===(button.dataset.answer==='yes'))))});document.getElementById('done').textContent=done+' of '+document.querySelectorAll('.item').length+' answered'}
document.addEventListener('click',event=>{const button=event.target.closest('button[data-answer]');if(button){answers[button.closest('.item').dataset.id]=button.dataset.answer==='yes';try{localStorage.setItem(KEY,JSON.stringify(answers))}catch{}show()}})
document.getElementById('save').addEventListener('click',()=>{const by=document.getElementById('by').value.trim()||'someone';const file=new Blob([JSON.stringify({by,at:new Date().toISOString(),answers},null,2)],{type:'application/json'});const link=document.createElement('a');link.href=URL.createObjectURL(file);link.download='judge-check-'+by.toLowerCase().replace(/[^a-z0-9]+/g,'-')+'.json';link.click()})
show()`;

const questionOf = (item: CheckItem): string =>
  item.kind === "said"
    ? "Did the person say this, in their own words or by a clear yes?"
    : "Stephen wrote this down. Did the person say it?";

const lineOf = (line: Said, name: string): string =>
  `<p${line.from === "stephen" ? ' class="s"' : ""}><b>${line.from === "stephen" ? "Stephen" : escaped(name.split(" ")[0] ?? name)}:</b> ${escaped(line.text)}</p>`;

const itemOf = (item: CheckItem): string =>
  `<div class="item" data-id="${escaped(item.id)}"><p><strong>${escaped(item.text)}</strong></p><p class="muted">${questionOf(item)}</p><div class="ask"><button data-answer="yes" aria-pressed="false">Yes</button><button data-answer="no" aria-pressed="false">No</button></div></div>`;

/** The page a person answers on: each interview with its conversation and the questions about it. Nothing of the judge's answers is in it. */
export const checkPage = (
  interviews: readonly CheckInterview[],
  items: readonly CheckItem[]
): string => {
  const parts = interviews
    .filter((interview) =>
      items.some((item) => item.interview === interview.id)
    )
    .map(
      (interview) =>
        `<section><h2>${escaped(interview.name)}</h2><div class="talk">${interview.lines.map((line) => lineOf(line, interview.name)).join("")}</div>${items
          .filter((item) => item.interview === interview.id)
          .map(itemOf)
          .join("")}</section>`
    );
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Check the judge</title><style>${pageStyle}</style></head><body><main><div><small>Stephen Lab · check of the judge</small><h1>Did they say it?</h1></div><p>Read each conversation, then answer the questions under it. Other words count; so does a clear yes to something Stephen asked. What only Stephen said does not. When you are not sure, answer no. Your answers stay in this browser until you save them.</p>${parts.join("")}</main><footer><span id="done" class="muted"></span><input id="by" placeholder="Your name" aria-label="Your name"><button id="save">Save my answers</button></footer><script>${checkScript}</script></body></html>\n`;
};
