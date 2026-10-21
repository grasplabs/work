import type {
  InterviewKind,
  InterviewLocale as Locale,
} from "@grasp-os/shared/onboarding";

import { escapeHtml } from "../mail-outbox.ts";
import type { QueuedMail } from "../mail-outbox.ts";

// The mails the onboarding sends (store.ts), in the five languages an
// interview is held in, as interviewer-text.ts keeps Stephen's: each text
// whole, in every language, with named places for what goes in it
// (`{name}`, `{company}`, `{closes}`, the counts). From Grasp, never from
// the company's own domain (GRA-359): a reply reaches the company's
// onboarding admin. Someone's link is in their mail alone, as the
// outbox's `{{link}}` slot, filled in only as the mail is sent; the
// admin's update holds numbers only, never a name or a word anyone said.

/** Who signs every mail: a name, the same in every language. */
const signature = "Stephen at Grasp";

/** Someone's link, and what it is for. */
interface LinkWords {
  subject: string;
  hello: string;
  own: string;
  lead: string;
  private: string;
  button: string;
  yours: string;
  until: string;
  reply: string;
}

/** The one reminder. */
interface ReminderWords {
  subject: string;
  body: string;
  last: string;
}

/** The admin's update. */
interface UpdateWords {
  subject: string;
  hello: string;
  intro: string;
  asked: string;
  talked: string;
  leads: string;
  note: string;
}

const LINK: Record<Locale, LinkWords> = {
  en: {
    subject: "{company} would like to hear how your work goes",
    hello: "Hello {name},",
    own: "{company} asked Grasp to learn how the work really goes, so the dull parts can be taken off people's hands. Stephen, Grasp's AI interviewer, would like to talk with you for 12 to 15 minutes about one piece of your work.",
    lead: "{company} asked Grasp to learn how the work really goes, so the dull parts can be taken off people's hands. Stephen, Grasp's AI interviewer, would like to talk with you for 12 to 15 minutes about the work of your team.",
    private:
      "Your company never sees what one person said, only what five or more people said, put together. You can stop at any time, and delete everything for 7 days afterwards.",
    button: "Talk with Stephen",
    yours:
      "This link is yours alone, so please don't pass it on. It opens your interview on the first device you open it on.",
    until: "The interviews run until {closes}.",
    reply:
      "Questions? Reply to this email, and it reaches the person at {company} who runs the interviews.",
  },
  nl: {
    subject: "{company} hoort graag hoe je werk gaat",
    hello: "Hallo {name},",
    own: "{company} heeft Grasp gevraagd te leren hoe het werk echt gaat, zodat de saaie delen je uit handen genomen kunnen worden. Stephen, de AI-interviewer van Grasp, praat graag 12 tot 15 minuten met je over een stuk van je werk.",
    lead: "{company} heeft Grasp gevraagd te leren hoe het werk echt gaat, zodat de saaie delen je uit handen genomen kunnen worden. Stephen, de AI-interviewer van Grasp, praat graag 12 tot 15 minuten met je over het werk van je team.",
    private:
      "Je bedrijf ziet nooit wat één persoon zei, alleen wat vijf of meer mensen samen zeiden. Je kunt altijd stoppen, en daarna nog 7 dagen alles verwijderen.",
    button: "Praat met Stephen",
    yours:
      "Deze link is alleen van jou, dus geef hem niet door. Hij opent je interview op het eerste apparaat waarop je hem opent.",
    until: "De interviews lopen tot en met {closes}.",
    reply:
      "Vragen? Beantwoord deze e-mail, dan komt hij bij de persoon bij {company} die de interviews regelt.",
  },
  de: {
    subject: "{company} möchte wissen, wie Ihre Arbeit läuft",
    hello: "Hallo {name},",
    own: "{company} hat Grasp gebeten herauszufinden, wie die Arbeit wirklich läuft, damit Ihnen die lästigen Teile abgenommen werden können. Stephen, der KI-Interviewer von Grasp, möchte 12 bis 15 Minuten mit Ihnen über einen Teil Ihrer Arbeit sprechen.",
    lead: "{company} hat Grasp gebeten herauszufinden, wie die Arbeit wirklich läuft, damit Ihnen die lästigen Teile abgenommen werden können. Stephen, der KI-Interviewer von Grasp, möchte 12 bis 15 Minuten mit Ihnen über die Arbeit Ihres Teams sprechen.",
    private:
      "Ihr Unternehmen sieht nie, was eine einzelne Person gesagt hat, nur, was fünf oder mehr Personen zusammen gesagt haben. Sie können jederzeit aufhören und danach noch 7 Tage lang alles löschen.",
    button: "Mit Stephen sprechen",
    yours:
      "Dieser Link gehört nur Ihnen, bitte geben Sie ihn nicht weiter. Er öffnet Ihr Interview auf dem ersten Gerät, auf dem Sie ihn öffnen.",
    until: "Die Interviews laufen bis zum {closes}.",
    reply:
      "Fragen? Antworten Sie auf diese E-Mail, dann erreicht sie die Person bei {company}, die die Interviews betreut.",
  },
  fr: {
    subject: "{company} aimerait savoir comment se passe votre travail",
    hello: "Bonjour {name},",
    own: "{company} a demandé à Grasp de comprendre comment le travail se passe vraiment, afin de vous décharger des tâches les plus fastidieuses. Stephen, l’intervieweur IA de Grasp, aimerait parler avec vous pendant 12 à 15 minutes d’une partie de votre travail.",
    lead: "{company} a demandé à Grasp de comprendre comment le travail se passe vraiment, afin de vous décharger des tâches les plus fastidieuses. Stephen, l’intervieweur IA de Grasp, aimerait parler avec vous pendant 12 à 15 minutes du travail de votre équipe.",
    private:
      "Votre entreprise ne voit jamais ce qu’une personne a dit, seulement ce que cinq personnes ou plus ont dit, mis ensemble. Vous pouvez arrêter à tout moment, et tout supprimer pendant les 7 jours qui suivent.",
    button: "Parler avec Stephen",
    yours:
      "Ce lien n’est qu’à vous, merci de ne pas le transmettre. Il ouvre votre entretien sur le premier appareil où vous l’ouvrez.",
    until: "Les entretiens sont ouverts jusqu’au {closes}.",
    reply:
      "Des questions ? Répondez à cet e-mail : il parviendra à la personne de {company} qui organise les entretiens.",
  },
  es: {
    subject: "{company} quiere saber cómo va tu trabajo",
    hello: "Hola, {name}:",
    own: "{company} ha pedido a Grasp que conozca cómo funciona de verdad el trabajo, para quitarte de encima las partes más pesadas. Stephen, el entrevistador de IA de Grasp, quiere hablar contigo de 12 a 15 minutos sobre una parte de tu trabajo.",
    lead: "{company} ha pedido a Grasp que conozca cómo funciona de verdad el trabajo, para quitarte de encima las partes más pesadas. Stephen, el entrevistador de IA de Grasp, quiere hablar contigo de 12 a 15 minutos sobre el trabajo de tu equipo.",
    private:
      "Tu empresa nunca ve lo que dijo una sola persona, solo lo que dijeron cinco o más personas, en conjunto. Puedes parar cuando quieras, y borrarlo todo durante los 7 días siguientes.",
    button: "Hablar con Stephen",
    yours:
      "Este enlace es solo tuyo, así que no lo compartas. Abre tu entrevista en el primer dispositivo en el que lo abras.",
    until: "Las entrevistas están abiertas hasta el {closes}.",
    reply:
      "¿Tienes preguntas? Responde a este correo y le llegará a la persona de {company} que organiza las entrevistas.",
  },
};

const REMINDER: Record<Locale, ReminderWords> = {
  en: {
    subject: "A reminder: your interview with Stephen",
    body: "A few days ago you got a link to talk with Stephen about your work. If you haven't found the time yet: it takes 12 to 15 minutes, and if you stop, you carry on later where you left off.",
    last: "This is the only reminder you'll get.",
  },
  nl: {
    subject: "Een herinnering: je interview met Stephen",
    body: "Een paar dagen geleden kreeg je een link om met Stephen over je werk te praten. Had je er nog geen tijd voor? Het duurt 12 tot 15 minuten, en als je stopt, ga je later verder waar je was.",
    last: "Dit is de enige herinnering die je krijgt.",
  },
  de: {
    subject: "Zur Erinnerung: Ihr Interview mit Stephen",
    body: "Vor ein paar Tagen haben Sie einen Link bekommen, um mit Stephen über Ihre Arbeit zu sprechen. Falls Sie noch keine Zeit dafür gefunden haben: Es dauert 12 bis 15 Minuten, und wenn Sie aufhören, machen Sie später dort weiter, wo Sie waren.",
    last: "Dies ist die einzige Erinnerung, die Sie bekommen.",
  },
  fr: {
    subject: "Un rappel : votre entretien avec Stephen",
    body: "Il y a quelques jours, vous avez reçu un lien pour parler de votre travail avec Stephen. Si vous n’avez pas encore trouvé le temps : cela prend 12 à 15 minutes, et si vous vous arrêtez, vous reprenez plus tard là où vous en étiez.",
    last: "C’est le seul rappel que vous recevrez.",
  },
  es: {
    subject: "Un recordatorio: tu entrevista con Stephen",
    body: "Hace unos días recibiste un enlace para hablar con Stephen sobre tu trabajo. Si aún no has encontrado el momento: son de 12 a 15 minutos, y si paras, sigues más tarde donde lo dejaste.",
    last: "Este es el único recordatorio que recibirás.",
  },
};

const UPDATE: Record<Locale, UpdateWords> = {
  en: {
    subject: "Where the interviews at {company} stand",
    hello: "Hello,",
    intro: "Here is where the interviews stand, up to yesterday.",
    asked: "People asked so far: {asked}.",
    talked: "People who talked with Stephen: {talked}.",
    leads: "Team leads who talked: {leadsTalked} of {leads}.",
    note: "A team shows numbers of its own only once five people in it were asked, so nobody can be singled out. These numbers count only those teams.",
  },
  nl: {
    subject: "Hoe de interviews bij {company} ervoor staan",
    hello: "Hallo,",
    intro: "Zo staan de interviews ervoor, tot en met gisteren.",
    asked: "Tot nu toe gevraagd: {asked}.",
    talked: "Met Stephen gepraat: {talked}.",
    leads: "Teamleiders die gepraat hebben: {leadsTalked} van {leads}.",
    note: "Een team toont pas eigen cijfers als er vijf mensen in gevraagd zijn, zodat niemand eruit te halen is. Deze cijfers tellen alleen die teams.",
  },
  de: {
    subject: "Wo die Interviews bei {company} stehen",
    hello: "Hallo,",
    intro: "So stehen die Interviews, Stand gestern.",
    asked: "Bisher gefragt: {asked}.",
    talked: "Mit Stephen gesprochen: {talked}.",
    leads: "Teamleitungen, die gesprochen haben: {leadsTalked} von {leads}.",
    note: "Ein Team zeigt eigene Zahlen erst, wenn fünf Personen darin gefragt wurden, damit niemand herausgegriffen werden kann. Diese Zahlen zählen nur solche Teams.",
  },
  fr: {
    subject: "Où en sont les entretiens chez {company}",
    hello: "Bonjour,",
    intro: "Voici où en sont les entretiens, jusqu’à hier.",
    asked: "Personnes sollicitées jusqu’ici : {asked}.",
    talked: "Personnes qui ont parlé avec Stephen : {talked}.",
    leads: "Responsables d’équipe qui ont parlé : {leadsTalked} sur {leads}.",
    note: "Une équipe n’affiche ses propres chiffres qu’une fois cinq personnes sollicitées, pour que personne ne puisse être identifié. Ces chiffres ne comptent que ces équipes.",
  },
  es: {
    subject: "Cómo van las entrevistas en {company}",
    hello: "Hola:",
    intro: "Así van las entrevistas, hasta ayer.",
    asked: "Personas a las que se ha preguntado: {asked}.",
    talked: "Personas que han hablado con Stephen: {talked}.",
    leads: "Responsables de equipo que han hablado: {leadsTalked} de {leads}.",
    note: "Un equipo solo muestra sus propias cifras cuando se ha preguntado a cinco personas de él, para que nadie pueda ser identificado. Estas cifras solo cuentan esos equipos.",
  },
};

/** Where the link goes in a mail: the outbox fills it in as it is sent. */
const linkSlot = "{{link}}";

/** What a mail says, in order: a paragraph, or the link's button. */
type Part = string | { button: string };

/**
 * `text` with each `{name}` filled in from `values`. What goes in loses
 * its braces, so a name can't make a slot of its own.
 */
const fill = (text: string, values: Record<string, string>): string =>
  text.replaceAll(/\{(?<name>\w+)\}/gu, (whole, name: string) =>
    (values[name] ?? whole).replaceAll(/[{}]/gu, "")
  );

/** A day as the mail's language writes it: "31 October". */
const dayIn = (day: string, locale: Locale): string =>
  new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(`${day}T12:00:00Z`));

/** A mail of `parts`, as text and as HTML, signed. */
const mailOf = (
  locale: Locale,
  subject: string,
  parts: readonly Part[],
  headers: Pick<QueuedMail, "replyTo" | "unsubscribe">
): QueuedMail => {
  const text = [
    ...parts.map((part) => (typeof part === "string" ? part : linkSlot)),
    signature,
  ].join("\n\n");
  const html = [
    ...parts.map((part) =>
      typeof part === "string"
        ? `<p>${escapeHtml(part)}</p>`
        : `<p><a href="${linkSlot}">${escapeHtml(part.button)}</a></p><p>${linkSlot}</p>`
    ),
    `<p>${escapeHtml(signature)}</p>`,
  ].join("\n");
  return {
    subject,
    text,
    html: `<!doctype html>\n<html lang="${locale}"><body>\n${html}\n</body></html>`,
    language: locale,
    ...headers,
  };
};

/** Where replies go, and a way to stop the mails: to the same person. */
const repliesTo = (
  replyTo: string | undefined
): Pick<QueuedMail, "replyTo" | "unsubscribe"> =>
  replyTo === undefined
    ? {}
    : { replyTo, unsubscribe: `mailto:${replyTo}?subject=Unsubscribe` };

/** What every mail to someone about their interview names. */
export interface PersonMail {
  locale: Locale;
  /** Their first name. */
  name: string;
  company: string;
  /** The last day of the interviews. */
  closes: string;
  /** The company's onboarding admin, whom replies reach. */
  replyTo: string | undefined;
}

/** Someone's link, on its day. */
export const linkMail = (
  mail: PersonMail & { kind: InterviewKind }
): QueuedMail => {
  const words = LINK[mail.locale];
  const values = {
    name: mail.name,
    company: mail.company,
    closes: dayIn(mail.closes, mail.locale),
  };
  return mailOf(
    mail.locale,
    fill(words.subject, values),
    [
      fill(words.hello, values),
      fill(mail.kind === "lead" ? words.lead : words.own, values),
      words.private,
      { button: words.button },
      words.yours,
      fill(words.until, values),
      fill(words.reply, values),
    ],
    repliesTo(mail.replyTo)
  );
};

/** The one reminder, for someone who hasn't finished. */
export const reminderMail = (mail: PersonMail): QueuedMail => {
  const words = REMINDER[mail.locale];
  const link = LINK[mail.locale];
  const values = {
    name: mail.name,
    company: mail.company,
    closes: dayIn(mail.closes, mail.locale),
  };
  return mailOf(
    mail.locale,
    words.subject,
    [
      fill(link.hello, values),
      words.body,
      { button: link.button },
      link.yours,
      fill(link.until, values),
      words.last,
      fill(link.reply, values),
    ],
    repliesTo(mail.replyTo)
  );
};

/** The numbers the admin's update gives: the admin's own, nothing more. */
export interface UpdateNumbers {
  asked: number;
  talked: number;
  leadsTalked: number;
  leads: number;
}

/** The company's admin's update: numbers only. */
export const updateMail = (mail: {
  locale: Locale;
  company: string;
  closes: string;
  numbers: UpdateNumbers;
}): QueuedMail => {
  const words = UPDATE[mail.locale];
  const link = LINK[mail.locale];
  const { asked, talked, leadsTalked, leads } = mail.numbers;
  const values = {
    company: mail.company,
    closes: dayIn(mail.closes, mail.locale),
    asked: String(asked),
    talked: String(talked),
    leadsTalked: String(leadsTalked),
    leads: String(leads),
  };
  return mailOf(
    mail.locale,
    fill(words.subject, values),
    [
      words.hello,
      words.intro,
      fill(words.asked, values),
      fill(words.talked, values),
      fill(words.leads, values),
      fill(link.until, values),
      words.note,
    ],
    {}
  );
};
