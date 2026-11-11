import { absent, answer, hidden } from "./company.ts";
import type { BrainEvalQuestion, BrainEvalSource } from "./company.ts";

// Groenhaven's long documents in English, its group language: the records
// retention policy, the planners' mail thread on the ERP 26.12 cutover and
// finance's year-end close manual. Written in English, never translated.

export const enLongSources: readonly BrainEvalSource[] = [
  {
    key: "en-records-retention",
    language: "en",
    readers: { team: "everyone" },
    text: `Records retention policy

Group policy POL-RR-03, version 2. Approved by the management team on 21 October 2026 and in force from 1 December 2026. It replaces the retention guidance of 2019 and the separate archiving note that the Duisburg site kept for its own paper files.

1. Scope
This policy applies to every Groenhaven company and site: the head office in Utrecht, the warehouses in Nieuwegein and Duisburg, the sales office in Lyon and the distribution centre in Valencia. It covers records in any form, whether on paper, in the ERP, on shared drives, in mailboxes or in chat. A record is anything that shows what the company agreed, decided, paid or delivered. Drafts, personal notes and duplicate copies are not records and may be deleted once they are no longer needed. Where local law in Germany, France or Spain requires a longer period than this policy sets, the longer period applies, and the site's line in the retention schedule (Annex A) says so.

2. Customer contracts
Signed customer contracts, framework agreements, price agreements and their amendments are kept for seven years after the contract ends, counted from the end of the calendar year in which it expires or is terminated. The owner is the sales director; in Lyon the head of the sales office acts on her behalf. The signed original is filed in the contract register on the intranet under the customer number, and paper originals are scanned and then kept in the locked contract cabinet at the head office. At the end of the period the owner approves disposal on form RR-21, and the papers are destroyed by the certified shredding service that visits the head office every month.

3. Supplier contracts
Signed supplier contracts, purchasing framework agreements, quality agreements and their amendments are kept for ten years after the contract ends, counted from the end of the calendar year in which it expires or is terminated. The owner is the head of purchasing; in Valencia the site manager acts on his behalf. The signed original is filed in the contract register on the intranet under the supplier number, and paper originals are scanned and then sent to the external archive in Houten. At the end of the period the owner approves disposal on form RR-22, and the archive company destroys the papers and returns a certificate of destruction.

4. Finance records
Ledgers, sales and purchase invoices, bank statements, tax returns and their supporting documents are kept for ten years from the end of the financial year they relate to, which meets the longest statutory period in the four countries we operate in. The group controller owns them. They are kept electronically in the ERP and the finance archive; once a paper invoice has been scanned under scanning procedure FIN-SC-02, the paper may be destroyed, except at the Lyon office, where French paper originals stay in the site archive for the full period.

5. Mail and chat
A mailbox is not an archive. Anything in a mail or a chat message that is a record, such as a customer's written acceptance of an offer, a supplier's price confirmation or a manager's approval, must be saved in the place where that kind of record belongs, for example the contract register. Mail is deleted from the mailbox after three years unless it is under legal hold. Messages in team channels are deleted after 18 months and one-to-one chats after 12 months. When someone leaves the company, their mailbox is kept for 90 days so that their manager can move any records out of it; after that it is deleted.

6. Legal hold
When a dispute, a claim, a tax inspection or an investigation is expected, Group Legal issues a legal hold notice. The hold stops all disposal of the records it names, whatever this policy otherwise says, and that includes the automatic deletion of mail and chat. Everyone who receives a notice confirms within five working days that they have read it. Only Group Legal lifts a hold, and always in writing. At present, legal hold LH-2026-04 covers all records about the dispute with the former landlord of the storage unit on the Nieuwegein industrial estate that we gave up in 2025.

7. Disposal
Paper records that hold personal or commercial information go into the locked shredding consoles, never into the ordinary waste paper bins. Electronic records are deleted by IT on the owner's instruction, including backup copies once their own cycle has run. Old hard drives, USB sticks and other data carriers are handed in at the IT service desk, which has them wiped or physically destroyed. Every disposal of a batch of records is entered in the disposal register with the date, the type of record, the period it covers and the number of the approval form. The disposal register itself is kept permanently.

8. Exceptions
To keep a record longer than its period, or to dispose of it earlier, send form RR-30 with your reason to Group Legal, which decides within ten working days. Some records are kept longer by rule. Product safety files for barbecues, patio heaters and other gas appliances are kept for 15 years after the last unit of that product was sold, because claims about them can come late. Records of historical value, such as the deed of incorporation, the minutes of shareholders' meetings and one copy of every product catalogue, are kept permanently in the company archive at the head office.

9. Who to ask
The records coordinator is Merel Hoekstra of Group Legal in Utrecht, on extension 2380. Each site also has a local records contact: Wouter Jansen in Nieuwegein, Katrin Vogel in Duisburg, Élodie Marchand in Lyon and Lucía Navarro in Valencia. They can tell you where a type of record belongs, help you fill in the disposal forms and arrange the shredding service. This policy is reviewed every two years; the next review is due in autumn 2028.`,
  },
  {
    key: "en-thread-erp-cutover",
    language: "en",
    readers: { team: "everyone" },
    text: `ERP 26.12 cutover weekend

From: Tom Hendriks
To: Eva; Sophie Turner; Daan Bakker; Lukas Becker; Javier Moreno
Subject: ERP 26.12 cutover weekend, first proposal

Hi all,

The vendor has confirmed that ERP release 26.12 is ready for production. Besides a batch of fixes, it brings the new pick-list layout and the changed customs fields for shipments outside the EU.

I propose that we cut over on the weekend of 5 and 6 December. Order entry would be frozen from Friday 4 December at 14:00 until Monday 7 December at 07:00. Could each of you tell me by Friday what that means for your site or team?

Best regards,
Tom Hendriks
IT project lead, ERP

From: Sophie Turner
To: Tom Hendriks
Cc: Eva; Daan Bakker; Lukas Becker; Javier Moreno
Subject: RE: ERP 26.12 cutover weekend, first proposal

Hi Tom,

The weekend of 5 December is too early for finance. The last November invoices and credit notes are still being posted in the first days of December, and I don't want them caught halfway between two releases. Could we move it a week later?

If we do, finance would do the last invoice run at 12:00 on the Friday, before the freeze, and bring the weekly supplier payment run forward to the Thursday, so that no bank files are sent while the system is down.

Thanks,
Sophie

From: Lukas Becker
To: Tom Hendriks
Cc: Eva; Sophie Turner; Daan Bakker; Javier Moreno
Subject: RE: ERP 26.12 cutover weekend, first proposal

Hello Tom,

Duisburg can live with either weekend, but a week later suits us better, because the containers from two ships are due in the first week of December.

During the freeze we will pick and ship everything that was released before it. On the Saturday the warehouse in Duisburg only receives inbound containers: they are unloaded against paper delivery notes, and the receipts are booked into the ERP on the Monday by the inbound team.

Regards,
Lukas

From: Javier Moreno
To: Tom Hendriks
Cc: Eva; Sophie Turner; Daan Bakker; Lukas Becker
Subject: RE: ERP 26.12 cutover weekend, first proposal

Hi Tom,

Valencia works on Saturdays in December for the Spanish garden centres, so we can't simply stop. We will keep loading the Saturday lorries from pick lists printed on Friday afternoon, and the goods issues are posted on Monday morning once the ERP is back.

One question: what happens if the new release doesn't work on Sunday? I'd like to know before I promise anything to the carriers.

Saludos,
Javier

From: Daan Bakker
To: Tom Hendriks
Cc: Eva; Sophie Turner; Lukas Becker; Javier Moreno
Subject: RE: ERP 26.12 cutover weekend, first proposal

Hi Tom,

Nieuwegein is closed on the Saturday anyway, so the freeze costs us little. I can offer three key users for the tests on Sunday morning: Fatima, Joost and myself. We would run the order-to-shipment scripts on real items in the new release, including a few of our standard customer orders from start to finish.

Groet,
Daan

From: Tom Hendriks
To: Eva; Sophie Turner; Daan Bakker; Lukas Becker; Javier Moreno
Subject: RE: ERP 26.12 cutover weekend, rollback and tests

Hi all,

To answer Javier: if at 18:00 on Sunday the smoke tests still show a blocking defect in order entry, invoicing or goods issue, we go back to the current release and try again in January. The vendor has rehearsed that restore and it takes about four hours, so everyone can work normally on the Monday either way.

The acceptance tests for the cutover are tracked in CHG-7720. We run a full dress rehearsal on the test system on Saturday 28 November, and Daan's scripts are attached to that ticket.

Tom

From: Eva
To: Tom Hendriks; Sophie Turner; Daan Bakker; Lukas Becker; Javier Moreno
Subject: RE: ERP 26.12 cutover weekend, decision

Hi all,

Thanks for the quick replies. We'll go with the later date: the cutover takes place on the weekend of 12 and 13 December. Order entry will be frozen from Friday 11 December at 16:00 until Monday 14 December at 06:00.

Tom, please let Camille know today, so that sales can warn the customers who usually order on Friday afternoons. Sophie's invoice and payment runs move with the new date.

Eva

From: Tom Hendriks
To: Eva; Sophie Turner; Daan Bakker; Lukas Becker; Javier Moreno
Subject: RE: ERP 26.12 cutover weekend, on-call rota

Hi all,

Here is who is on call during the cutover. On Saturday 12 December I lead the technical work together with Pieter Smulders, the vendor's consultant. On Sunday 13 December Pieter and I are joined by the key users from 08:00. On Monday 14 December the IT service desk opens at 05:30 with two extra people, and Pieter stays on site in Utrecht until Wednesday for hypercare.

Everyone involved dials in to the cutover bridge call, meeting code 618 204 773, at 09:00, 13:00 and 17:00 on both days. If you can't reach me, call the IT service desk and ask for the duty manager.

Tom

From: Lukas Becker
To: Tom Hendriks
Cc: Eva; Sophie Turner; Daan Bakker; Javier Moreno
Subject: RE: ERP 26.12 cutover weekend, on-call rota

Hi Tom,

Thanks, that works for Duisburg. Our key user for the Sunday tests will be Stefan Krämer; he will dial in from the warehouse office. Please send him the test login for the dress rehearsal in good time.

Lukas`,
  },
  {
    key: "en-year-end-close",
    language: "en",
    readers: { team: "finance" },
    text: `Year-end close 2026: instructions for the finance team

These instructions cover the closing of the 2026 financial year for all four Groenhaven companies: Groenhaven B.V. in Utrecht and Nieuwegein, Groenhaven GmbH in Duisburg, Groenhaven SAS in Lyon and Groenhaven Logística S.L. in Valencia. Sophie Turner coordinates the close for the group; each site controller is responsible for the figures of their own company. Read the whole document before you start, and keep the close checklist YE-01 up to date in the finance folder as you go.

1. Timetable
The 2026 ledgers close for operational posting on Thursday 7 January 2027; after that only finance may post to 2026. Year-end adjustments are posted by 22 January. The draft group accounts go to the auditors on 5 February. Audit fieldwork runs from 8 to 26 February 2027 at the head office in Utrecht, with one day in Duisburg in the second week. The management team approves the accounts on 16 March, and the shareholders' meeting adopts them on 22 April.

2. Accruals
At year end an accrual is booked for any single item above EUR 5,000 for which goods or services were received in 2026 but no invoice has arrived. Smaller items are left to be invoiced and booked as normal. Use template ACR-26 for every accrual, with the supplier, the purchase order number, the amount and how you arrived at it. Start from the goods received not invoiced report in the ERP and check it with the buyers, because that report also lists orders that were cancelled after delivery. Freight is accrued per site from the carriers' December shipment lists, as carriers often invoice six weeks late. Accruals are reversed automatically on 1 January 2027, so do not reverse them by hand.

3. Stock count valuation
The year-end stock counts in Nieuwegein, Duisburg and Valencia give the quantities; finance gives the values. Stock is valued at the lower of cost and net realisable value, using the standard cost prices of 2026. The site controller compares the count with the ERP and sends the differences to the site planner. Count differences above EUR 2,000 per item are investigated with the site planner before they are posted, and the outcome is noted in the valuation file STK-VAL-2026.

Slow movers are provided for in the same file. An item with no sales in the last 12 months is provided for at 50% of its cost price, and an item with no sales in the last 24 months is provided for in full. Seasonal stock is not a slow mover just because it is winter: parasols and garden furniture are judged on the sales of the last full season. Damaged stock found at the count is written down to its scrap value straight away.

4. Intercompany reconciliation
All balances between the four companies must agree at 31 December. Confirmations close on 13 January: by then each company enters its receivables from and payables to the other three in the intercompany reconciliation tool, and the counterparty either agrees or raises a difference. Differences above EUR 1,000 must be resolved by 15 January; smaller ones are written off in the company that raised the charge. The loan from Groenhaven B.V. to Groenhaven GmbH is reconciled separately, including the interest for 2026, against the loan statement that treasury issues. Do not post intercompany adjustments without the written agreement of the other company's controller.

5. Fixed assets and leases
Each site controller checks the fixed asset register of their company against what is actually there. Forklifts, racking, scanners and vehicles that were sold, scrapped or stolen in 2026 must be taken off the register with form FA-04 before the last depreciation run on 6 January 2027. Purchases below EUR 1,500 are expensed and do not go on the register. Projects still under construction at 31 December, such as racking that is partly installed, stay on the assets under construction account until they are brought into use. For leases, the lease schedule kept by the group controller is the source: check that every forklift and van lease at your site is on it, and report any lease signed locally that it does not list.

6. Audit requests
Our auditors, Lindeveld, send their requests through the audit portal, each with a number such as AR-2026-031 and a due date. Answer every request in the portal itself, never by mail with attachments, so that we keep one record of what was given to whom. Most requests are due within three working days; if you need longer, tell Sophie before the due date, not after it. Requests about user access, system changes or the ERP 26.12 release go to IT, and Sophie forwards them. Do not send the auditors drafts or explanations that have not been checked by the site controller.

7. Sign-off
When the adjustments are in, each site controller completes sign-off form YE-07 for their company: it confirms that the balance sheet is reconciled, that all known liabilities are in the accounts and that there are no open disputes left out. The forms are due with Sophie by 29 January 2027. Sophie reviews them with the group controller and then prepares the representation letter, which the finance director signs on behalf of the management team. Nobody posts to 2026 after the representation letter has been signed; any correction found after that goes into January 2027 as a prior-year item, with a note to Sophie.`,
  },
];

export const enLongQuestions: readonly BrainEvalQuestion[] = [
  {
    id: "en-long-mail-deleted",
    language: "en",
    question: "When is mail deleted from the mailbox?",
    expects: answer(
      "words",
      "en-records-retention",
      "Mail is deleted from the mailbox after three years"
    ),
  },
  {
    id: "en-long-barbecue-safety-file",
    language: "en",
    question:
      "How long do we keep the safety file of a barbecue we've stopped selling?",
    expects: answer(
      "forms",
      "en-records-retention",
      "kept for 15 years after the last unit of that product was sold"
    ),
  },
  {
    id: "en-long-lh-2026-04",
    language: "en",
    question: "What does LH-2026-04 cover?",
    expects: answer(
      "exact",
      "en-records-retention",
      "dispute with the former landlord of the storage unit"
    ),
  },
  {
    id: "en-long-vendor-deal-paperwork",
    language: "en",
    question:
      "How long do we have to hang on to the paperwork for a deal with a vendor once it's over?",
    expects: answer(
      "paraphrase",
      "en-records-retention",
      "kept for ten years after the contract ends",
      "kept for seven years after the contract ends"
    ),
  },
  {
    id: "en-long-order-entry-freeze",
    language: "en",
    question: "From what time will order entry be frozen for the cutover?",
    expects: answer(
      "words",
      "en-thread-erp-cutover",
      "frozen from Friday 11 December at 16:00",
      "frozen from Friday 4 December at 14:00"
    ),
  },
  {
    id: "en-long-valencia-goods-issue",
    language: "en",
    question:
      "When will Valencia post the goods issue for the loads it ships during the cutover?",
    expects: answer(
      "forms",
      "en-thread-erp-cutover",
      "the goods issues are posted on Monday morning"
    ),
  },
  {
    id: "en-long-chg-7720",
    language: "en",
    question: "What is CHG-7720?",
    expects: answer(
      "exact",
      "en-thread-erp-cutover",
      "The acceptance tests for the cutover are tracked in CHG-7720"
    ),
  },
  {
    id: "en-long-abandon-upgrade",
    language: "en",
    question:
      "At what point do we give up on the upgrade and return to the old version?",
    expects: answer(
      "paraphrase",
      "en-thread-erp-cutover",
      "we go back to the current release and try again in January"
    ),
  },
  {
    id: "en-long-accrual-threshold",
    language: "en",
    asker: "sophie",
    question: "Above what amount is an accrual booked at year end?",
    expects: answer(
      "words",
      "en-year-end-close",
      "an accrual is booked for any single item above EUR 5,000"
    ),
  },
  {
    id: "en-long-acr-26",
    language: "en",
    asker: "sophie",
    question: "What do I use ACR-26 for?",
    expects: answer(
      "exact",
      "en-year-end-close",
      "Use template ACR-26 for every accrual"
    ),
  },
  {
    id: "en-long-two-year-old-goods",
    language: "en",
    asker: "sophie",
    question:
      "How much do we knock off products nobody has bought for two years?",
    expects: answer(
      "paraphrase",
      "en-year-end-close",
      "no sales in the last 24 months is provided for in full"
    ),
  },
  {
    id: "en-long-audit-fieldwork",
    language: "en",
    asker: "camille",
    question: "When are the auditors coming in for the 2026 accounts?",
    expects: hidden(
      "en-year-end-close",
      "from 8 to 26 February 2027",
      "go to the auditors on 5 February",
      "with one day in Duisburg in the second week",
      "Lindeveld"
    ),
  },
  {
    id: "en-long-count-differences",
    language: "en",
    asker: "camille",
    question:
      "Which stock count differences does finance look into at year end?",
    expects: hidden(
      "en-year-end-close",
      "above EUR 2,000 per item",
      "STK-VAL-2026"
    ),
  },
  {
    id: "en-long-cctv",
    language: "en",
    question: "How long do we keep the CCTV footage from the warehouses?",
    expects: absent,
  },
];
