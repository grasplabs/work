import { absent, answer, hidden } from "./company.ts";
import type { BrainEvalQuestion, BrainEvalSource } from "./company.ts";

// Groenhaven's long Dutch notes: a mail thread about the new packing line in
// hall 2 in Nieuwegein, the minutes of the third-quarter operations meeting
// and the retrospective of the ordering portal. Written in Dutch, sources and
// questions alike; never translated.

export const nlLongNotesSources: readonly BrainEvalSource[] = [
  {
    key: "nl-mailwisseling-inpakstraat",
    language: "nl",
    readers: { team: "planning" },
    text: `Mailwisseling: ombouw hal 2, nieuwe inpakstraat magazijn Nieuwegein

Van: Daan Bakker
Aan: Marloes Verhoef (Pakwerk Systemen)
Cc: Eva
Datum: dinsdag 22 september 2026
Onderwerp: Ombouw hal 2: voorstel planning

Beste Marloes,

Dank voor het goede gesprek van vorige week. Zoals besproken willen we de nieuwe inpakstraat in hal 2 van ons magazijn in Nieuwegein nog dit jaar in gebruik nemen. Ons voorstel: jullie monteren de straat in week 49, en hal 2 is dicht van maandag 30 november tot en met vrijdag 4 december. In die week pakken we in hal 3 met de hand in.

De voorraad uit hal 2, zo'n 260 pallets tuingereedschap en barbecues, zetten we die week in blokstapeling achter in hal 3. Kunnen jullie in diezelfde week ook de inpakkers trainen, bijvoorbeeld op vrijdag 4 december, de laatste installatiedag?

Groet,
Daan Bakker
Planner magazijn Nieuwegein

Van: Marloes Verhoef (Pakwerk Systemen)
Aan: Daan Bakker
Cc: Eva
Datum: donderdag 24 september 2026
Onderwerp: RE: Ombouw hal 2: voorstel planning

Beste Daan,

Week 49 gaat ons helaas niet lukken. De sorteermodule komt pas half december uit onze fabriek in Oosterhout, en we bouwen de inpakstraat het liefst in één keer op. De vroegste week die ik jullie kan bieden, is week 2 van 2027.

Nog een punt voor jullie technische dienst: de inpakstraat heeft een krachtstroomaansluiting van 3 x 63 ampère nodig, op hooguit tien meter van de kop van de straat. Willen jullie nagaan of die er in hal 2 al is? Ons projectnummer voor deze klus is PW-2611; vermeld dat graag in je mails.

Met vriendelijke groet,
Marloes Verhoef
Projectleider, Pakwerk Systemen

Van: Daan Bakker
Aan: Eva; Lukas Becker
Datum: vrijdag 25 september 2026
Onderwerp: Ombouw hal 2 schuift naar januari

Hoi Eva, hoi Lukas,

Pakwerk kan pas in januari, dus de ombouw van hal 2 schuift op. Dat geeft een probleem met de voorraad: begin januari komt de nieuwe collectie tuinmeubelen binnen, en dan is er in hal 3 geen ruimte meer voor de pallets uit hal 2.

Lukas, kan Duisburg die tijdelijk opvangen? Het gaat om ongeveer 260 pallets, vooral barbecues en tuingereedschap, voor hooguit twee weken. Orders voor die artikelen kunnen jullie dan rechtstreeks vanuit Duisburg verzenden.

Groet,
Daan

Van: Lukas Becker
Aan: Daan Bakker
Cc: Eva
Datum: maandag 28 september 2026
Onderwerp: RE: Ombouw hal 2 schuift naar januari

Hoi Daan,

Duisburg kan helpen, maar niet met alles. In hal A heb ik van 4 tot en met 22 januari plek voor maximaal 180 pallets; meer gaat niet, want begin januari komt bij ons ook de nieuwe collectie binnen. Stuur me het liefst de barbecues, die verzenden we toch al vaak vanuit Duisburg naar Duitse klanten.

Voor de rest, het tuingereedschap, moeten jullie in Nieuwegein een andere plek zoeken. Laat even weten wat je kiest, dan plan ik de vrachtwagens in. Een rit met de pendel tussen Nieuwegein en Duisburg kost ons zo'n 410 euro.

Groeten,
Lukas

Van: Daan Bakker
Aan: Marloes Verhoef (Pakwerk Systemen)
Datum: donderdag 1 oktober 2026
Onderwerp: PW-2611: aansluiting in hal 2

Beste Marloes,

Week 2 is voor ons akkoord, op voorwaarde dat de aansluiting op tijd klaar is. Onze technische dienst heeft gekeken: in hal 2 ligt nu alleen een aansluiting van 3 x 32 ampère. Installatiebedrijf Elektra Lekdijk trekt in december een nieuwe kabel vanaf de hoofdverdeelkast in hal 1. Intern loopt dit onder ticket GH-2417; de oplevering staat op vrijdag 18 december.

Kunnen jullie ons vóór 15 oktober de definitieve tekening sturen, met de plek van de aansluitkast erop? Dan kan de kabel in één keer goed worden gelegd.

Met vriendelijke groet,
Daan Bakker

Van: Marloes Verhoef (Pakwerk Systemen)
Aan: Daan Bakker
Cc: Eva
Datum: dinsdag 13 oktober 2026
Onderwerp: RE: PW-2611: aansluiting in hal 2

Beste Daan,

Bijgaand de definitieve tekening, revisie C. Bij het inmeten bleek dat de straat niet om de kolom bij dock 4 heen past zoals we eerst hadden getekend. We lossen dat op met een extra rollenbaanbocht van 90 graden en een langere afvoerband.

Dat is meerwerk: 14.200 euro exclusief btw bovenop jullie inkooporder PO-78140, die nu op 186.500 euro staat. Ik heb er een aparte meerwerkopdracht voor klaargezet. Zonder jullie akkoord kunnen we de extra bocht niet op tijd bestellen voor week 2.

Met vriendelijke groet,
Marloes

Van: Eva
Aan: Daan Bakker; Marloes Verhoef (Pakwerk Systemen)
Datum: donderdag 15 oktober 2026
Onderwerp: RE: PW-2611: aansluiting in hal 2

Hoi Daan, beste Marloes,

Akkoord met het meerwerk. Het past nog net binnen het investeringsbudget voor Nieuwegein, maar daarmee is de ruimte ook op. Daan, wil je de meerwerkopdracht in het inkoopsysteem aan de bestaande order koppelen, zodat Sophie hem bij de factuurcontrole terugvindt?

Marloes, nog één verzoek: graag vóór de montage een vaste prijs voor de inbedrijfstelling, zodat we in januari niet alsnog een tweede rekening krijgen.

Groet,
Eva

Van: Daan Bakker
Aan: Eva; Lukas Becker; Marloes Verhoef (Pakwerk Systemen)
Datum: dinsdag 3 november 2026
Onderwerp: Ombouw hal 2: definitieve planning

Hoi allemaal,

Hierbij de definitieve planning voor de ombouw van hal 2, vandaag zo met Marloes afgestemd. Pakwerk monteert de straat in week 2, en hal 2 is dicht van maandag 11 januari tot en met vrijdag 15 januari. In die week pakken we in hal 3 met de hand in, aan twee extra tafels bij dock 6.

De barbecues gaan op donderdag 7 en vrijdag 8 januari met de pendel naar hal A in Duisburg en komen in week 3 terug. Het tuingereedschap zetten we onder de overkapping op het buitenterrein, in stellingen en afgedekt.

Pakwerk traint de inpakkers op donderdag 14 en vrijdag 15 januari, in twee groepen van zes, zodat de straat op maandag 18 januari volledig kan draaien. Ik vraag de teamleiders om vóór 1 december door te geven wie van de inpakkers op die dagen vrij heeft gevraagd.

Groet,
Daan

Van: Marloes Verhoef (Pakwerk Systemen)
Aan: Eva; Daan Bakker
Datum: donderdag 5 november 2026
Onderwerp: RE: Ombouw hal 2: definitieve planning

Beste Eva, beste Daan,

Akkoord. De inbedrijfstelling en een proefdraaidag op zaterdag 16 januari vallen onder de vaste prijs; daar komt geen tweede rekening voor. Onze vier monteurs beginnen op maandag 11 januari om 7.00 uur, en de twee vrachtwagens met onderdelen staan die ochtend om 6.30 uur bij dock 5.

Onze trainer, Gert-Jan Smit, neemt voor elke inpakker een korte handleiding in het Nederlands mee, met foto's van de bediening.

Met vriendelijke groet,
Marloes

Van: Lukas Becker
Aan: Daan Bakker
Datum: vrijdag 6 november 2026
Onderwerp: RE: Ombouw hal 2: definitieve planning

Hoi Daan,

Ik heb op 7 en 8 januari per dag twee ritten ingepland bij Transport Brinkhorst. Stuur me uiterlijk maandag 4 januari de palletlijst met artikelnummers, dan zet ik de locaties in hal A alvast klaar in het WMS en kunnen we de orders voor de barbecues hier gewoon picken.

Groeten,
Lukas`,
  },
  {
    key: "nl-notulen-kwartaaloverleg",
    language: "nl",
    readers: { team: "planning" },
    text: `Notulen kwartaaloverleg operations, derde kwartaal 2026

Datum: donderdag 8 oktober 2026, kantoor Utrecht en online
Aanwezig: Eva (voorzitter), Daan Bakker, Lukas Becker, Javier Moreno, Sophie Turner (punt 5 tot en met 7), Ilse Kramer (preventiemedewerker, punt 8)
Notulen: Daan Bakker

1. Opening
Eva opent het overleg. De notulen van het tweede kwartaal worden ongewijzigd vastgesteld. Alle cijfers hieronder komen uit het WMS en de urenregistratie, met peildatum 30 september. Zoals afgesproken bespreekt elke locatie dezelfde vier cijfers: pickfouten, zendingen die op tijd de deur uit gingen, ziekteverzuim en overuren.

2. Nieuwegein
Daan licht de cijfers van Nieuwegein toe. Het pickfoutpercentage in Nieuwegein kwam in het derde kwartaal uit op 0,42 procent, tegen 0,51 procent in het tweede kwartaal. In Nieuwegein ging 96,8 procent van de zendingen op tijd de deur uit; de norm is 97 procent. Het ziekteverzuim in Nieuwegein was 4,1 procent, en er zijn 1.310 overuren gemaakt, vooral in juli.

Dat Nieuwegein de norm voor tijdig verzenden net niet haalde, komt vooral door de week van 17 augustus: toen lag de wikkelmachine twee dagen stil en liepen de zendingen een halve dag achter. Daan wil de nieuwe looproutes die in hal 3 goed werken, in het vierde kwartaal ook in hal 1 invoeren.

3. Duisburg
Lukas licht de cijfers van Duisburg toe. Het pickfoutpercentage in Duisburg kwam in het derde kwartaal uit op 0,31 procent, tegen 0,35 procent in het tweede kwartaal. In Duisburg ging 98,1 procent van de zendingen op tijd de deur uit; de norm is 97 procent. Het ziekteverzuim in Duisburg was 6,2 procent, en er zijn 2.040 overuren gemaakt.

Het hoge verzuim in Duisburg komt grotendeels door drie langdurig zieken in de expeditie; Lukas volgt dit samen met de bedrijfsarts. Om de expeditie in Duisburg toch bemand te houden, is in augustus en september veel overgewerkt. Lukas vraagt of een collega uit Nieuwegein in november twee weken kan bijspringen; Daan bekijkt dat.

4. Valencia
Javier licht de cijfers van Valencia toe. Het pickfoutpercentage in Valencia kwam in het derde kwartaal uit op 0,58 procent, tegen 0,49 procent in het tweede kwartaal. In Valencia ging 94,3 procent van de zendingen op tijd de deur uit; de norm is 97 procent. Het ziekteverzuim in Valencia was 3,4 procent, en er zijn 860 overuren gemaakt.

De meeste pickfouten in Valencia gingen over parasolvoeten van 25 en 30 kilo, die in dozen zitten die er bijna hetzelfde uitzien. Javier legt ze op aparte locaties en laat op de handscanner een foto van het artikel zien. De te late zendingen uit Valencia waren grotendeels voor Andalusië, waar de vervoerder in juli te weinig wagens had.

5. Vervoerders
Pakketvervoerder Velpaq heeft per 1 januari een tariefverhoging van 6,5 procent aangekondigd, voor alle drie de locaties. Eva vindt dat te veel voor de kwaliteit die we krijgen: in het derde kwartaal raakten bij Velpaq 23 pakketten zoek. We vragen voor 2027 offertes op bij twee andere pakketvervoerders; Sophie zet de prijzen naast elkaar. Voor het palletvervoer verandert er niets.

6. Klimaat in de hallen
In juli liep de temperatuur in de hal in Valencia op sommige middagen op tot 34 graden. Javier laat daarom vóór de zomer van 2027 vier grote plafondventilatoren ophangen; de goedkoopste van drie offertes is 18.600 euro, en Sophie neemt het bedrag op in de investeringen voor Valencia. In Nieuwegein en Duisburg speelt dit niet, maar Eva vraagt Daan en Lukas wel om bij de volgende hittegolf de temperatuur in de hallen bij te houden, zodat we weten waar we staan.

7. Verpakking
Vanaf 1 januari wikkelen we pallets op alle drie de locaties niet meer in stretchfolie. De lading zetten we dan vast met kartonnen hoekprofielen en spanbanden. Dat scheelt naar schatting 14 ton folie per jaar. Sophie heeft uitgerekend dat het per pallet 0,40 euro goedkoper is dan folie, de aanschaf van de spanapparaten meegerekend. Javier wil in december eerst een maand proefdraaien in Valencia, omdat de zendingen naar de Canarische Eilanden onderweg op een schip worden overgeslagen.

8. Veiligheid
Ilse geeft het overzicht van de veiligheidsincidenten in het derde kwartaal: twee in Nieuwegein, één in Duisburg en geen in Valencia. Niemand raakte gewond. De ernstigste staat in melding VM-2026-031: in Nieuwegein reed een heftruck achteruit tegen een stellingpoot in hal 1, waarna de stelling werd ontruimd en gekeurd. Vanaf november loopt Ilse elke maand per locatie een veiligheidsronde met de planner.

9. Actielijst
A1 Daan: nieuwe looproutes in hal 1 invoeren, gereed vóór 1 december.
A2 Daan: nagaan of iemand uit Nieuwegein in november in Duisburg kan bijspringen, vóór 16 oktober.
A3 Javier: aparte locaties en artikelfoto's voor parasolvoeten, gereed vóór 1 november.
A4 Sophie: offertes van twee pakketvervoerders vergelijken, vóór 1 december.
A5 Javier: proef met spanbanden in Valencia, uitkomst bespreken in het volgende overleg.
A6 Ilse: de planning van de veiligheidsrondes per locatie rondsturen, vóór 23 oktober.
A7 Javier: opdracht voor de plafondventilatoren in Valencia geven, vóór 1 maart.

10. Rondvraag
Lukas vraagt of de kwartaalcijfers voortaan een week vóór het overleg rondgaan, zodat iedereen ze kan voorbereiden. Afgesproken: Daan stuurt ze voortaan op de eerste maandag na het kwartaal. Javier meldt dat er in Valencia in december een nieuwe teamleider op de vroege dienst begint, intern doorgegroeid uit de expeditie.

11. Volgend overleg
Het kwartaaloverleg over het vierde kwartaal is op donderdag 21 januari 2027 in Duisburg.`,
  },
  {
    key: "nl-evaluatie-bestelportaal",
    language: "nl",
    readers: { team: "sales" },
    text: `Projectevaluatie: nieuw bestelportaal voor klanten

Project: BP-26 Bestelportaal tuincentra
Opdrachtgever: Eva
Projectleider: Thijs van Rooij, e-commerce, Utrecht
Opgesteld: 9 november 2026

1. Aanleiding
Tot dit jaar bestelden tuincentra bij Groenhaven per mail, telefonisch of via hun accountmanager. De binnendienst zette elke order met de hand in het ERP, en bij drukte liep dat dagen achter. Klanten konden bovendien niet zelf zien wat er op voorraad was en belden daarom vaak na. In januari 2026 besloot het managementteam tot een eigen bestelportaal, waarin een tuincentrum zijn eigen prijzen en de actuele voorraad ziet en op elk moment van de dag een order kan plaatsen.

2. Verloop
Het portaal is gebouwd door ontwikkelbureau Vlietwerk in Delft, met een koppeling op ons ERP. De oorspronkelijke livedatum was maandag 1 juni, vóór de zomer. Bij de acceptatietest in mei bleek de prijskoppeling niet te kloppen: staffelkortingen en actieprijzen kwamen niet goed mee, en ongeveer één op de acht orderregels had in het portaal een andere prijs dan later op de factuur. Na twee herstelrondes ging het portaal uiteindelijk op maandag 7 september live, ruim drie maanden later dan gepland.

Van 6 juli tot en met 28 augustus draaide een pilot van het bestelportaal met drie klanten: Tuincentrum De Vlasakker in Ede, Tuinwereld Hoornbeek in Zwolle en Jardinerie du Vieux Pont in Villeurbanne. Samen plaatsten zij in die acht weken 214 orders. Onze accountmanagers zaten de eerste twee weken bij hun inkopers om mee te kijken. Elke vrijdag hielden we met de drie klanten een kort telefonisch overleg over wat er misging.

Na de pilot hebben we de binnendienst in Utrecht en alle accountmanagers in twee middagen opgeleid. Voor klanten kwam er een korte handleiding, en wie voor het eerst inlogt, krijgt een rondleiding van vijf schermen langs zoeken, de winkelwagen en de orderhistorie. De accountmanagers hebben in augustus elke klant in hun rayon gebeld om de livegang aan te kondigen.

3. Wat ging goed
De pilotklanten vonden het portaal eenvoudig. De inkoper van De Vlasakker plaatst zijn bijbestellingen nu met de tablet vanaf de winkelvloer, zodra hij ziet dat een schap leeg raakt. Doordat de voorraad in het portaal elk kwartier wordt bijgewerkt, bellen klanten de binnendienst veel minder vaak om te vragen of iets leverbaar is. Ook de samenwerking met Vlietwerk liep goed: problemen werden binnen een dag opgepakt, ook in de zomer.

Ook intern pakte het goed uit. De binnendienst gebruikt de vrijgekomen tijd om offertes sneller rond te maken, en de accountmanagers praten bij klantbezoeken weer over het assortiment in plaats van over losse bestellingen. Een tuincentrum in Breda liet ons na een maand al weten dat bijbestellen nu net zo makkelijk gaat als boodschappen doen.

4. Wat ging mis
De scope groeide onderweg. Halverwege de bouw kwam de wens om ook retouren via het portaal te melden; dat kostte zes weken extra werk en is uiteindelijk toch naar fase 2 geschoven. De Franse vertaling was pas eind september klaar, waardoor Camille haar klanten in Frankrijk pas in oktober kon aansluiten. En bij de livegang kregen 38 klanten een welkomstmail met een verkeerde inloglink, wat een dag lang tot veel telefoontjes leidde.

Ook de ondersteuning na de livegang was te krap geregeld. In de eerste twee weken kwamen er ruim 140 vragen binnen, terwijl we op hooguit 50 hadden gerekend. Er was geen apart nummer voor het portaal, waardoor vragen over inloggen en prijzen tussen de gewone bestellingen in de wachtrij belandden. Pas in de derde week hebben we twee collega's van de binnendienst vrijgemaakt voor vragen over het portaal.

5. Cijfers
Op 31 oktober, ruim zeven weken na de livegang, hadden 87 van de 236 tuincentra die bij Groenhaven bestellen een actief account in het bestelportaal; 61 daarvan plaatsten in oktober minstens één order. In oktober kwam 34 procent van alle orderregels van tuincentra via het portaal binnen. Een portaalorder kost de binnendienst gemiddeld 2 minuten, tegen 11 minuten voor een order die met de hand wordt ingevoerd. BP-26 had een budget van 240.000 euro; de werkelijke kosten kwamen uit op 281.000 euro, vooral door de extra bouwtijd voor de prijskoppeling.

6. Lessen
Test een koppeling vanaf het begin met echte klantgegevens en echte prijsafspraken, niet met een verzonnen testset; de prijsfouten hadden we dan in maart al gezien. Leg de scope vast na het ontwerp: nieuwe wensen gaan op een lijst voor de volgende fase. Neem vertalingen vanaf dag één op in de planning. Kies pilotklanten van verschillende grootte, niet alleen klanten die al veel bestellen. En noem klanten pas een livedatum als de acceptatietest is goedgekeurd.

7. Vervolg
Fase 2 begint in januari 2027; daarin komen het volgen van zendingen in het portaal en het melden van retouren erbij, plus een koppeling voor grote klanten die rechtstreeks vanuit hun eigen kassasysteem bijbestellen. Het doel is 150 actieve accounts op 1 april 2027. De accountmanagers krijgen per klant een lijst van wie nog niet via het portaal bestelt, en Camille benadert de Franse klanten zelf. Thijs blijft ook na fase 2 eigenaar van het portaal.`,
  },
];

export const nlLongNotesQuestions: readonly BrainEvalQuestion[] = [
  // Mailwisseling over de ombouw van hal 2.
  {
    id: "nl-long-hal-2-dicht",
    language: "nl",
    question:
      "Van wanneer tot wanneer is hal 2 volgens de definitieve planning dicht?",
    expects: answer(
      "words",
      "nl-mailwisseling-inpakstraat",
      "hal 2 is dicht van maandag 11 januari tot en met vrijdag 15 januari",
      "hal 2 is dicht van maandag 30 november tot en met vrijdag 4 december"
    ),
  },
  {
    id: "nl-long-inpakker-training",
    language: "nl",
    question: "Wanneer krijgt een inpakker nu eigenlijk zijn training?",
    expects: answer(
      "forms",
      "nl-mailwisseling-inpakstraat",
      "traint de inpakkers op donderdag 14 en vrijdag 15 januari",
      "de inpakkers trainen, bijvoorbeeld op vrijdag 4 december"
    ),
  },
  {
    id: "nl-long-po-78140",
    language: "nl",
    question: "Hoeveel meerwerk komt er bovenop PO-78140?",
    expects: answer(
      "exact",
      "nl-mailwisseling-inpakstraat",
      "14.200 euro exclusief btw"
    ),
  },
  {
    id: "nl-long-stroom-verpakkingslijn",
    language: "nl",
    question:
      "Welke firma zorgt voor de stroomvoorziening van de verpakkingslijn na de verbouwing?",
    expects: answer(
      "paraphrase",
      "nl-mailwisseling-inpakstraat",
      "Installatiebedrijf Elektra Lekdijk trekt"
    ),
  },
  // Notulen van het kwartaaloverleg.
  {
    id: "nl-long-valencia-op-tijd",
    language: "nl",
    question:
      "Hoeveel procent van de zendingen ging in Valencia in het derde kwartaal op tijd de deur uit?",
    expects: answer(
      "words",
      "nl-notulen-kwartaaloverleg",
      "In Valencia ging 94,3 procent van de zendingen",
      "In Nieuwegein ging 96,8 procent van de zendingen"
    ),
  },
  {
    id: "nl-long-pickfouten-duisburg",
    language: "nl",
    question:
      "Hoe hoog lag het percentage pickfouten in Duisburg in het derde kwartaal?",
    expects: answer(
      "forms",
      "nl-notulen-kwartaaloverleg",
      "uit op 0,31 procent",
      "uit op 0,42 procent"
    ),
  },
  {
    id: "nl-long-vm-2026-031",
    language: "nl",
    question: "Wat is er gebeurd bij VM-2026-031?",
    expects: answer(
      "exact",
      "nl-notulen-kwartaaloverleg",
      "reed een heftruck achteruit tegen een stellingpoot"
    ),
  },
  {
    id: "nl-long-plastic-vracht",
    language: "nl",
    question: "Hoe houden we de vracht straks bij elkaar zonder plastic?",
    expects: answer(
      "paraphrase",
      "nl-notulen-kwartaaloverleg",
      "met kartonnen hoekprofielen en spanbanden"
    ),
  },
  // Evaluatie van het bestelportaal.
  {
    id: "nl-long-actieve-accounts",
    language: "nl",
    question:
      "Hoeveel tuincentra hadden eind oktober een actief account in het bestelportaal?",
    expects: answer(
      "words",
      "nl-evaluatie-bestelportaal",
      "87 van de 236 tuincentra"
    ),
  },
  {
    id: "nl-long-bestelportaal-live",
    language: "nl",
    question: "Op welke datum is het bestelportaal live gegaan?",
    expects: answer(
      "forms",
      "nl-evaluatie-bestelportaal",
      "ging het portaal uiteindelijk op maandag 7 september live"
    ),
  },
  {
    id: "nl-long-bp-26",
    language: "nl",
    question: "Wat heeft BP-26 uiteindelijk gekost?",
    expects: answer(
      "exact",
      "nl-evaluatie-bestelportaal",
      "de werkelijke kosten kwamen uit op 281.000 euro"
    ),
  },
  {
    id: "nl-long-webshop-uitproberen",
    language: "nl",
    question: "Welke afnemers mochten de webshop vóór iedereen uitproberen?",
    expects: answer(
      "paraphrase",
      "nl-evaluatie-bestelportaal",
      "Tuincentrum De Vlasakker in Ede"
    ),
  },
  // Antwoord nergens te vinden.
  {
    id: "nl-long-capaciteit-inpakstraat",
    language: "nl",
    question:
      "Hoeveel pakketten per uur kan de nieuwe inpakstraat in hal 2 aan?",
    expects: absent,
  },
  // Antwoord alleen in een bron die de vrager niet mag lezen.
  {
    id: "nl-long-verzuim-duisburg",
    language: "nl",
    asker: "anna",
    question:
      "Hoe hoog was het ziekteverzuim in Duisburg in het derde kwartaal?",
    expects: hidden(
      "nl-notulen-kwartaaloverleg",
      "6,2 procent",
      "drie langdurig zieken",
      "Het hoge verzuim in Duisburg"
    ),
  },
];
