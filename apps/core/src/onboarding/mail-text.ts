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
  /** Who signs the mail, in its language. */
  signed: string;
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
    subject: "{company} x Grasp: Your personal link to talk with Stephen",
    hello: "Hi {name},",
    own: "{company} has partnered with Grasp to see where repetitive work slows teams down—so we can take the manual admin off your plate. Stephen, Grasp’s AI interviewer, would like to have a short conversation with you (20 minutes at most) about your day-to-day work.",
    lead: "{company} has partnered with Grasp to see where repetitive work slows teams down—so we can take the manual admin off your team’s plate. Stephen, Grasp’s AI interviewer, would like to have a short conversation with you (20 minutes at most) about how your team works.",
    private:
      "You stay in full control: nothing is shared until you review and approve it. Process details are shared as how your team works (never under your name), and opinions are only shown anonymously once at least five people mention the same thing. You can pause anytime, and delete everything up to 7 days afterwards.",
    button: "Start conversation",
    yours:
      "This link is personal—please don’t forward it. Sign in with your work account to open it.",
    until: "Interviews are open until {closes}.",
    reply:
      "Questions? Just reply to this email—it goes straight to the person organizing this at {company}.",
    signed: "Stephen at Grasp",
  },
  nl: {
    subject:
      "{company} x Grasp: Je persoonlijke link voor het gesprek met Stephen",
    hello: "Hoi {name},",
    own: "{company} werkt samen met Grasp om te kijken waar herhalend regelwerk tijd kost—zodat we dat straks voor je kunnen verlichten. Stephen, de AI-interviewer van Grasp, gaat graag kort met je in gesprek (maximaal 20 minuten) over je dagelijkse werk.",
    lead: "{company} werkt samen met Grasp om te kijken waar herhalend regelwerk tijd kost—zodat we dat voor je team kunnen verlichten. Stephen, de AI-interviewer van Grasp, gaat graag kort met je in gesprek (maximaal 20 minuten) over hoe je team werkt.",
    private:
      "Jij houdt de volledige controle: er wordt niets gedeeld voordat je het hebt nagelezen en goedgekeurd. Hoe het werk loopt wordt gedeeld als werkwijze van je team (nooit onder jouw naam), en meningen worden alleen anoniem meegenomen zodra minstens vijf mensen hetzelfde aangeven. Je kunt altijd pauzeren en tot 7 dagen na afloop alles verwijderen.",
    button: "Start het gesprek",
    yours:
      "Deze link is persoonlijk—stuur hem niet door. Log in met je werkaccount om te starten.",
    until: "De interviews staan open tot en met {closes}.",
    reply:
      "Vragen? Beantwoord gewoon deze mail, dan kom je direct bij de organisator binnen {company} terecht.",
    signed: "Stephen van Grasp",
  },
  de: {
    subject:
      "{company} x Grasp: Dein persönlicher Link für das Gespräch mit Stephen",
    hello: "Hallo {name},",
    own: "{company} arbeitet mit Grasp zusammen, um herauszufinden, wo wiederkehrende Routinearbeit Zeit frisst – damit wir dir das künftig abnehmen können. Stephen, der KI-Interviewer von Grasp, möchte ein kurzes Gespräch (höchstens 20 Minuten) mit dir über deinen Arbeitsalltag führen.",
    lead: "{company} arbeitet mit Grasp zusammen, um herauszufinden, wo wiederkehrende Routinearbeit Zeit frisst – damit wir dein Team entlasten können. Stephen, der KI-Interviewer von Grasp, möchte ein kurzes Gespräch (höchstens 20 Minuten) mit dir über die Arbeit deines Teams führen.",
    private:
      "Du behältst die volle Kontrolle: Nichts wird geteilt, bevor du es geprüft und freigegeben hast. Abläufe werden als Arbeitsweise deines Teams geteilt (nie unter deinem Namen), und Meinungen fließen nur anonym ein, wenn mindestens fünf Personen dasselbe sagen. Du kannst jederzeit pausieren und bis zu 7 Tage danach alles löschen.",
    button: "Gespräch starten",
    yours:
      "Dieser Link ist persönlich – bitte nicht weiterleiten. Melde dich mit deinem Arbeitskonto an, um ihn zu öffnen.",
    until: "Die Interviews sind bis zum {closes} geöffnet.",
    reply:
      "Fragen? Antworte einfach auf diese E-Mail – sie geht direkt an deine Ansprechperson bei {company}.",
    signed: "Stephen von Grasp",
  },
  fr: {
    subject:
      "{company} x Grasp : Votre lien personnel pour échanger avec Stephen",
    hello: "Bonjour {name},",
    own: "{company} s’est associé à Grasp pour identifier les tâches répétitives qui font perdre du temps, afin de vous en décharger. Stephen, l’intervieweur IA de Grasp, aimerait échanger brièvement avec vous (20 minutes maximum) sur votre travail au quotidien.",
    lead: "{company} s’est associé à Grasp pour identifier les tâches répétitives qui ralentissent les équipes, afin d’alléger la charge de votre équipe. Stephen, l’intervieweur IA de Grasp, aimerait échanger brièvement avec vous (20 minutes maximum) sur le fonctionnement de votre équipe.",
    private:
      "Vous gardez le contrôle total : rien n’est partagé avant votre relecture et validation. Les étapes de travail sont partagées comme la façon de travailler de votre équipe (jamais sous votre nom), et vos avis restent anonymes et n’apparaissent que si au moins cinq personnes mentionnent la même chose. Vous pouvez mettre en pause à tout moment et tout supprimer jusqu’à 7 jours après.",
    button: "Démarrer l’échange",
    yours:
      "Ce lien est personnel, merci de ne pas le transférer. Connectez-vous avec votre compte professionnel pour l’ouvrir.",
    until: "Les entretiens sont ouverts jusqu’au {closes}.",
    reply:
      "Des questions ? Répondez simplement à cet e-mail pour joindre la personne en charge chez {company}.",
    signed: "Stephen chez Grasp",
  },
  es: {
    subject: "{company} x Grasp: Tu enlace personal para hablar con Stephen",
    hello: "Hola {name},",
    own: "{company} colabora con Grasp para ver dónde las tareas repetitivas quitan tiempo, y así poder quitarte esa carga de encima. Stephen, el entrevistador de IA de Grasp, quiere tener una breve conversación contigo (máximo 20 minutos) sobre tu trabajo diario.",
    lead: "{company} colabora con Grasp para ver dónde las tareas repetitivas frenan a los equipos, y así aliviar la carga del tuyo. Stephen, el entrevistador de IA de Grasp, quiere tener una breve conversación contigo (máximo 20 minutos) sobre cómo trabaja tu equipo.",
    private:
      "Tú mantienes el control total: no se comparte nada hasta que lo revises y apruebes. Los pasos del trabajo se comparten como la forma de trabajar de tu equipo (nunca con tu nombre), y tus opiniones solo se muestran de forma anónima cuando al menos cinco personas dicen lo mismo. Puedes pausar cuando quieras y borrarlo todo hasta 7 días después.",
    button: "Empezar conversación",
    yours:
      "Este enlace es personal, por favor no lo reenvíes. Inicia sesión con tu cuenta de trabajo para abrirlo.",
    until: "Las entrevistas están abiertas hasta el {closes}.",
    reply:
      "¿Preguntas? Responde a este correo y llegará directamente a quien organiza esto en {company}.",
    signed: "Stephen de Grasp",
  },
};

const REMINDER: Record<Locale, ReminderWords> = {
  en: {
    subject:
      "Reminder — {company} x Grasp: Your personal link to talk with Stephen",
    body: "A few days ago we sent you a link for a short conversation with Stephen about your work. If you haven’t had a chance yet, it takes 20 minutes at most—and you can pause and pick up where you left off anytime.",
    last: "This is the only reminder we’ll send.",
  },
  nl: {
    subject:
      "Herinnering — {company} x Grasp: Je persoonlijke link voor het gesprek met Stephen",
    body: "Een paar dagen geleden kreeg je een link voor een kort gesprek met Stephen over je werk. Nog geen tijd gehad? Het duurt maximaal 20 minuten—en je kunt altijd pauzeren en later verdergaan waar je gebleven was.",
    last: "Dit is de enige herinnering die we sturen.",
  },
  de: {
    subject:
      "Erinnerung — {company} x Grasp: Dein persönlicher Link für das Gespräch mit Stephen",
    body: "Vor ein paar Tagen haben wir dir einen Link für ein kurzes Gespräch mit Stephen über deine Arbeit geschickt. Falls du noch keine Zeit hattest: Es dauert höchstens 20 Minuten – und du kannst jederzeit pausieren und später weitermachen.",
    last: "Das ist die einzige Erinnerung, die wir schicken.",
  },
  fr: {
    subject:
      "Rappel — {company} x Grasp : Votre lien personnel pour échanger avec Stephen",
    body: "Il y a quelques jours, nous vous avons envoyé un lien pour un court échange avec Stephen sur votre travail. Si vous n’avez pas encore eu le temps, cela prend 20 minutes maximum — et vous pouvez mettre en pause et reprendre plus tard.",
    last: "C’est le seul rappel que nous vous enverrons.",
  },
  es: {
    subject:
      "Recordatorio — {company} x Grasp: Tu enlace personal para hablar con Stephen",
    body: "Hace unos días te enviamos un enlace para una breve conversación con Stephen sobre tu trabajo. Si aún no has tenido tiempo, dura 20 minutos como máximo y puedes pausar y seguir más tarde donde lo dejaste.",
    last: "Este es el único recordatorio que te enviaremos.",
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
    LINK[locale].signed,
  ].join("\n\n");
  const html = [
    ...parts.map((part) =>
      typeof part === "string"
        ? `<p>${escapeHtml(part)}</p>`
        : `<p><a href="${linkSlot}">${escapeHtml(part.button)}</a></p><p>${linkSlot}</p>`
    ),
    `<p>${escapeHtml(LINK[locale].signed)}</p>`,
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
    fill(words.subject, values),
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
