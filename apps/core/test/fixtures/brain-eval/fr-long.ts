import { absent, answer, hidden } from "./company.ts";
import type { BrainEvalQuestion, BrainEvalSource } from "./company.ts";

// Groenhaven in French, at length: the Lyon sales office's commercial
// terms for 2027 and its welcome handbook (company.ts). Written in French,
// texts and questions alike; never translated.

export const frLongSources: readonly BrainEvalSource[] = [
  {
    key: "fr-conditions-vente",
    language: "fr",
    readers: { team: "sales" },
    text: `Conditions commerciales 2027 : guide pour l'équipe de Lyon

Ce guide reprend les conditions commerciales applicables aux clients français suivis par le bureau de Lyon. Il ne traite pas des prix : ceux-ci figurent dans la grille tarifaire, qu'il complète sans la remplacer. En cas de doute, posez toujours la question à Camille Laurent avant de vous engager auprès d'un client.

Article 1 – Champ d'application
Les présentes conditions distinguent deux types de clients. Les jardineries indépendantes sont les magasins qui commandent en leur nom propre, y compris lorsqu'ils adhèrent à un groupement d'achat. Les enseignes sont les réseaux d'au moins cinq magasins qui passent par une centrale d'achat et ont signé un contrat de référencement avec Groenhaven. Un client qui change de catégorie en cours d'année conserve ses conditions jusqu'au 31 décembre.

Article 2 – Ouverture de compte
Tout nouveau client remplit le formulaire d'ouverture de compte OC-27, que vous joignez à sa fiche dans le CRM, avec un extrait Kbis de moins de trois mois et un RIB au nom de la société. Le service crédit du groupe, à Utrecht, étudie le dossier et fixe le plafond d'encours ; comptez cinq jours ouvrés. Tant que le compte n'est pas ouvert, les commandes sont payables d'avance.

Article 3 – Conditions des jardineries indépendantes
Pour les jardineries indépendantes, le minimum de commande est de 350 € HT par livraison. Leurs factures sont payables à 30 jours date de facture ; un escompte de 1 % est accordé pour tout règlement reçu sous huit jours. Reprise des invendus : une jardinerie indépendante peut nous retourner, avant le 15 juillet, les articles de saison invendus, dans la limite de 10 % du montant de sa précommande et à condition qu'ils soient dans leur emballage d'origine. Les frais de retour restent à la charge du client.

Article 4 – Conditions des enseignes
Pour les enseignes, le minimum de commande est de 2 000 € HT par magasin livré. Leurs factures sont payables à 60 jours date de facture, sans escompte ; le règlement passe par la centrale d'achat, jamais par le magasin. Reprise des invendus : les enseignes ne peuvent pas nous retourner leurs invendus de saison ; en contrepartie, leur contrat de référencement prévoit une remise de fin d'année, calculée par le service grands comptes à Utrecht. Seuls les colis endommagés ou manquants à la livraison donnent lieu à un avoir, selon l'article 7.

Article 5 – Échantillons
Chaque commercial peut faire envoyer des échantillons à un client ou à un prospect, dans la limite de 250 € HT par client et par saison. Les échantillons se commandent dans le CRM avec le type de commande ECH ; ils partent du centre de distribution de Valence, en Espagne, et ne sont pas facturés. Au-delà du plafond, l'échantillon est facturé au client à moitié prix, sauf accord de Camille Laurent. Les meubles prêtés à un client pour son espace d'exposition restent la propriété de Groenhaven et sont repris en fin de saison.

Article 6 – Précommandes de saison
Les précommandes pour la saison de printemps sont ouvertes du 1er octobre au 31 janvier. Elles se saisissent dans le CRM avec le code campagne PRE-27, en indiquant la semaine de livraison souhaitée, entre la semaine 8 et la semaine 16. Le client peut modifier sa précommande sans frais jusqu'à trois semaines avant la semaine de livraison choisie. Une modification à la baisse ou une annulation plus tardive entraîne des frais de 15 % du montant annulé, sauf pour les articles que nous ne sommes pas en mesure de livrer à la date prévue.

Article 7 – Litiges à la livraison
Un colis endommagé ou manquant doit faire l'objet de réserves précises sur le bon de livraison du transporteur, en présence du chauffeur. Le client confirme ensuite ses réserves par écrit dans les 48 heures, avec des photos ; passé ce délai, le transporteur refuse toute prise en charge. Vous ouvrez alors un dossier de litige dans le CRM avec le formulaire LIT-03. Un avoir de 800 € HT au plus peut être accordé directement par le commercial ; au-delà, il doit être validé par Camille Laurent.

Article 8 – Dérogations et validations
Toute dérogation aux présentes conditions se demande avec le formulaire DER-11 dans le CRM, avant d'en parler au client comme d'un accord acquis. Une dérogation au minimum de commande, ou une reprise d'invendus hors délai, est validée par Camille Laurent. Un délai de paiement plus long est validé par Sophie Turner, au service finance, qui consulte le service crédit. Toute dérogation valable plus de six mois, ou qui concerne une enseigne, est validée par Eva, directrice des opérations. La réponse est donnée sous deux jours ouvrés ; sans réponse, la demande est considérée comme refusée.

Article 9 – Entrée en vigueur
Ces conditions s'appliquent aux commandes passées à partir du 1er janvier 2027. Une commande passée en 2026 garde les conditions de 2026, même si elle est livrée en 2027. Les conditions particulières déjà signées avec un client restent valables jusqu'à leur échéance ; à leur renouvellement, elles sont alignées sur le présent guide. Les précommandes PRE-27 suivent le présent guide, quelle que soit leur date de saisie.`,
  },
  {
    key: "fr-livret-accueil-lyon",
    language: "fr",
    readers: { team: "everyone" },
    text: `Livret d'accueil du bureau de Lyon

Bienvenue chez Groenhaven ! Ce livret rassemble ce qu'il faut savoir pour vos premières semaines au bureau de Lyon : l'accès aux locaux, le matériel, le courrier, la sécurité et les déplacements vers le siège d'Utrecht. Les règles RH font l'objet de pages à part sur l'intranet. Ce livret est tenu à jour par Margaux Perrin, assistante du bureau ; signalez-lui toute information devenue inexacte.

1. Arrivée et badge
Le bureau occupe le 4e étage de l'immeuble Les Tisserands, 27 quai des Mariniers, dans le 2e arrondissement. Le jour de votre arrivée, Margaux vous accueille et vous remet votre badge nominatif, dont le numéro (du type LYB-0412) figure au dos. Ce badge vous donne accès à l'immeuble, à l'ascenseur et au bureau.

Vous avez perdu votre badge ? Prévenez Margaux le jour même : elle le désactive dans le système de contrôle d'accès de l'immeuble et en commande un nouveau, qui arrive en général sous trois jours ouvrés. En attendant, demandez chaque matin un badge visiteur à l'accueil, contre une pièce d'identité. Ne prêtez jamais votre badge, même à un collègue d'Utrecht de passage : il doit demander son propre badge visiteur à l'accueil.

2. Locaux et salles de réunion
L'étage compte un open space de quatorze postes, deux bureaux fermés et deux salles de réunion. La salle Saône accueille dix personnes et dispose d'un écran et d'un système de visioconférence ; c'est là que se tient la réunion d'équipe du lundi à 10 h. La salle Fourvière, plus petite, accueille quatre personnes et sert aux appels et aux entretiens. Les deux salles se réservent dans l'agenda partagé, sous le nom de la salle ; une réservation de plus d'une demi-journée doit être validée par Margaux.

Au fond de l'étage, le showroom présente une sélection de la collection : salons de jardin, parasols, barbecues et outillage. Les clients y sont reçus sur rendez-vous ; prévenez Margaux la veille pour qu'elle prépare la pièce. Ne déplacez pas les meubles exposés sans l'accord de Camille Laurent, qui revoit la présentation à chaque changement de saison.

Dans l'espace détente, le réfrigérateur est vidé chaque vendredi à 16 h : tout ce qui y reste est jeté.

3. Horaires
L'immeuble est ouvert de 7 h 30 à 20 h du lundi au vendredi ; il est fermé le week-end et les jours fériés, et votre badge ne fonctionne pas ces jours-là. Au bureau, vous organisez votre journée autour d'une plage fixe de 10 h à 16 h, pendant laquelle on doit pouvoir vous joindre. Le dernier à partir le soir vérifie que les fenêtres sont fermées et active l'alarme du bureau, avec le code que Margaux vous communique la première semaine. Si l'alarme se déclenche par erreur, appelez la société de télésurveillance au numéro affiché près de la porte et donnez le mot de passe du bureau.

4. Matériel
Votre ordinateur portable et votre casque sont préparés par le service informatique d'Utrecht et vous attendent sur votre poste le premier jour, avec un écran et une station d'accueil. Le téléphone mobile professionnel est réservé aux commerciaux itinérants ; c'est Camille Laurent qui le commande. Pour toute panne ou demande, passez par le portail du service desk. Pour un souci urgent sur place, Thomas Girard, commercial sédentaire, est notre correspondant informatique local et peut vous dépanner.

L'imprimante multifonction se trouve près de l'entrée. Vos impressions ne sortent que lorsque vous présentez votre badge devant l'imprimante, pour que personne d'autre ne récupère vos documents. Le papier et les toners sont rangés dans l'armoire de la salle Fourvière ; prévenez Margaux quand il reste moins de deux cartons de papier.

5. Courrier et colis
Le courrier du bureau de Lyon arrive à l'accueil de l'immeuble ; Margaux le monte chaque jour vers 11 h et le distribue dans les casiers nominatifs, près de l'espace détente. Le courrier à envoyer se dépose dans la bannette « départ » avant 15 h pour partir le jour même. Les lettres recommandées passent toutes par Margaux, qui les inscrit au registre du courrier.

Les colis professionnels (échantillons, catalogues, présentoirs) sont réceptionnés par l'accueil de l'immeuble, qui signe le bon de livraison. Pour expédier un colis depuis le bureau de Lyon, établissez un bon d'envoi BE-LY dans le CRM et collez l'étiquette imprimée sur le carton. Le transporteur Messagerie Rhodanienne passe enlever les colis à 16 h 30 du lundi au vendredi. Les colis personnels ne sont pas acceptés au bureau : faites-vous livrer chez vous ou dans un point relais de votre choix.

6. Sécurité incendie
En cas d'alarme incendie, quittez l'étage immédiatement par l'escalier B, jamais par l'ascenseur. Margaux Perrin, guide-file, vous conduit dehors ; Thomas Girard, serre-file, vérifie que personne n'est resté à l'étage. Les extincteurs se trouvent près de l'entrée et devant la salle Saône. Un exercice d'évacuation a lieu deux fois par an, organisé par le gestionnaire de l'immeuble ; le prochain est prévu le mardi 16 mars 2027 dans la matinée.

7. Déplacements vers Utrecht
Vous irez au siège d'Utrecht au moins une fois dans l'année, notamment pour la réunion commerciale du groupe, qui se tient chaque année en septembre. Le trajet le plus simple : un vol de Lyon vers Amsterdam, puis le train direct jusqu'à la gare centrale d'Utrecht, en une demi-heure environ. Le siège est à dix minutes à pied de la gare. Les billets se réservent auprès du travel desk, selon la politique de voyage du groupe.

Groenhaven a un accord avec l'hôtel De Vlonder, à cinq minutes du siège : indiquez le code de réservation GH-LYON pour obtenir le tarif négocié, petit déjeuner compris. Pour entrer au siège, demandez à Anna de Wit, au moins trois jours ouvrés avant votre venue, un badge temporaire qui vous attendra à la réception. Si vous souhaitez visiter l'entrepôt de Nieuwegein pendant votre séjour, les visites ont lieu le mercredi, sur rendez-vous avec Daan Bakker.

8. Contacts utiles
Margaux Perrin, assistante du bureau : accueil, badges, salles, courrier et colis, poste 210.
Thomas Girard, correspondant informatique local : premiers dépannages, poste 214.
Camille Laurent, équipe commerciale : showroom, téléphones mobiles, questions sur les clients.
Anna de Wit, RH au siège d'Utrecht : contrat, paie, badge temporaire pour le siège.
Gardien de l'immeuble : touche 0 de l'interphone du hall, de 7 h 30 à 20 h.`,
  },
];

export const frLongQuestions: readonly BrainEvalQuestion[] = [
  {
    id: "fr-long-echantillons-plafond",
    language: "fr",
    question: "Quel est le plafond d'échantillons par client et par saison ?",
    expects: answer(
      "words",
      "fr-conditions-vente",
      "250 € HT par client et par saison"
    ),
  },
  {
    id: "fr-long-precommandes-ouverture",
    language: "fr",
    question: "Quand ouvre-t-on la précommande de printemps ?",
    expects: answer(
      "words",
      "fr-conditions-vente",
      "ouvertes du 1er octobre au 31 janvier"
    ),
  },
  {
    id: "fr-long-der-11",
    language: "fr",
    question: "Qui valide un DER-11 pour allonger un délai de paiement ?",
    expects: answer(
      "exact",
      "fr-conditions-vente",
      "validé par Sophie Turner, au service finance"
    ),
  },
  {
    id: "fr-long-casse-reception",
    language: "fr",
    question:
      "Une jardinerie cliente a constaté de la casse à la livraison : combien de temps a-t-elle pour confirmer ses réserves au transporteur ?",
    expects: answer(
      "words",
      "fr-conditions-vente",
      "par écrit dans les 48 heures, avec des photos"
    ),
  },
  {
    id: "fr-long-minimum-enseignes",
    language: "fr",
    question: "Quel est le minimum de commande pour les enseignes ?",
    expects: answer(
      "words",
      "fr-conditions-vente",
      "2 000 € HT par magasin livré",
      "350 € HT par livraison"
    ),
  },
  {
    id: "fr-long-enlevement-colis",
    language: "fr",
    question:
      "À quelle heure le transporteur passe-t-il enlever les colis au bureau de Lyon ?",
    expects: answer(
      "words",
      "fr-livret-accueil-lyon",
      "passe enlever les colis à 16 h 30"
    ),
  },
  {
    id: "fr-long-salle-saone",
    language: "fr",
    question: "Quelle est la capacité de la salle Saône ?",
    expects: answer(
      "exact",
      "fr-livret-accueil-lyon",
      "La salle Saône accueille dix personnes"
    ),
  },
  {
    id: "fr-long-gh-lyon",
    language: "fr",
    question: "À quoi sert le code GH-LYON ?",
    expects: answer(
      "exact",
      "fr-livret-accueil-lyon",
      "le code de réservation GH-LYON"
    ),
  },
  {
    id: "fr-long-carte-acces-egaree",
    language: "fr",
    question: "J'ai égaré ma carte magnétique, qu'est-ce que je fais ?",
    expects: answer(
      "paraphrase",
      "fr-livret-accueil-lyon",
      "elle le désactive dans le système de contrôle d'accès"
    ),
  },
  {
    id: "fr-long-paiement-independants",
    language: "fr",
    asker: "javier",
    question:
      "Quel délai de paiement accorde-t-on aux jardineries indépendantes ?",
    expects: hidden(
      "fr-conditions-vente",
      "30 jours date de facture",
      "escompte de 1 %"
    ),
  },
  {
    id: "fr-long-parking-lyon",
    language: "fr",
    question:
      "Y a-t-il des places de parking pour les salariés du bureau de Lyon ?",
    expects: absent,
  },
];
