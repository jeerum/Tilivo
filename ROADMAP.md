# Tilivo roadmap – uus plaan alates v0.7.5

Kehtiv alates 2026-09-03.

## v0.14 Employee Registry

Employee and employment master data are complete for this release. Payroll
calculation, income-register submission and holiday accounting remain explicit
future scope; see `docs/EMPLOYEE_REGISTRY_GAP.md`.

## Otsus

- **v0.7.5 (Business Registry Integration) jääb viimaseks "vana plaani" punktiks** ja tehakse praegu lõpuni.
- Alates **v0.8** ehitatakse süsteemi **päris täisväärtusliku Soome raamatupidamistarkvarana (Accounting/ERP)**,
  mitte lihtsalt arvete programmina.
- Arhitektuurireegel: **desktop on põhivaade**, aga **100% funktsionaalsusest peab olema kasutatav ka mobiilis**.
  Mobiilis võib kasutajaliides olla lihtsustatud ning lisaks peab saama vajadusel avada täis-desktop-vaate.

## Repo seis ja seos vana plaaniga

Valmis ja production'is: v0.1–v0.7 (täpne seis: `IMPLEMENTATION_STATUS.md`, ajalugu: `CHANGELOG.md`).

Vana plaani (raamatupidamise_saas_ARCHITECTURE_v2.md §70) versioonid alates v0.8 asendab käesolev dokument.
Vana tabel jääb ajalooliseks kirjelduseks.

Osa uue plaani alusest on juba ehitatud teistsuguse nummerdusega ja **ei ehitata nullist uuesti**:

| Olemas (repo) | Uue plaani alus |
|---|---|
| v0.5 Accounting Core (journal, ledger, perioodid, tax codes, reversal, audit) | v0.8 Accounting Core 1 ja v0.9 VAT/ALV engine |
| v0.6 Sales (arved, numberdus, PDF, kreeditarved, pearaamatukanded) | v0.12 Müügireskontro 2.0 |
| v0.7 Purchases (ostuarved, e-arve Finvoice/PEPPOL/TEAPPSXML, approval, posting, OCR foundation) | v0.10 Ostuarved ja tšekid |
| v0.4 dokumendid, audit hash-chain, inbox/outbox, desktop-first UI | kogu uue plaani platvormiosa |

Uue plaani versioonikirjeldused näitavad, **mis lisandub nendele alustele**, et süsteemist saaks
täisväärtuslik Soome raamatupidamistarkvara.

---

## v0.7.5 – Business Registry Integration

See tehakse praegu lõpuni.

- ettevõtte otsing nime või Business ID / Y-tunnuse järgi;
- kliendi ja tarnija põhiandmete automaatne täitmine;
- aadress;
- ettevõtte nimi;
- registrikood;
- VAT-number;
- registriinfo uuendamine;
- ettevõtte staatuse kontroll;
- hiljem kasutatav ka arvete maksureeglite automaatseks kontrolliks.

---

## v0.8 – Accounting Core 1

Tuleb varakult, sest kogu ülejäänud raamatupidamine peab sellele toetuma. Soome osakeyhtiö vajab sisuliselt
kahekordset raamatupidamist; see on süsteemi tuum, mitte hilisem lisa (vt vero.fi allikaid allpool).

- kahekordne kirjendamine;
- päevik / journal;
- pearaamat;
- kontoplaan;
- deebet/krediit;
- automaatsed kanded;
- käsitsi kanded;
- kande kuupäev ja väärtuspäev;
- dokumendi sidumine kandega;
- dimensioonid / projektid / kulukohad;
- arvestusperioodid;
- perioodi lukustamine;
- avamis- ja sulgemiskanded;
- paranduskanded;
- audit trail: kes, mida ja millal muutis;
- kustutamise asemel tühistamine/parandamine;
- konto saldode kontroll;
- algsaldod vanast raamatupidamisest.

---

## v0.9 – VAT / ALV Engine

Üks süsteemi tähtsamaid osi.

**Käibemaks ei ole lihtsalt protsendiväli arvel.** Igal real on maksukood, mille taga on maksumäär,
raamatupidamiskanne, deklaratsioonikäitumine ja arvele nõutav tekst.

Toetatakse vähemalt:

- Soome üldine ALV;
- kõik vähendatud ALV määrad;
- 0% maksustatav müük;
- maksuvaba müük;
- sisendkäibemaks;
- osaliselt mahaarvatav ALV;
- mitte-mahaarvatav ALV;
- EU kaupade ühendusesisene müük;
- EU kaupade ühendusesisene ost;
- EU teenuste B2B müük;
- EU teenuste ost;
- eksport väljapoole EL-i;
- import;
- reverse charge;
- ehitusvaldkonna pöördmaksustamine;
- oma kasutuse käibemaks;
- krediitarvete ALV;
- ettemaksude ALV;
- ajaloolised ALV määrad, et vana dokument ei muutuks pärast maksureegli muutumist.

Näiteks 2026. aastal on Soomes üldmäär 25,5%, paljude kaupade ja teenuste vähendatud määr 13,5% ning
ajalehtedel ja ajakirjadel 10%. Maksumäärasid **ei kodeerita programmi ühe fikseeritud väärtusena**.

### Arve tegemisel

Kasutaja valib näiteks:

- tavaline Soome müük;
- rakennusalan käännetty ALV;
- EU B2B goods;
- EU B2B services;
- export outside EU;
- VAT exempt.

Programm teeb taustal ülejäänu. Ehitusvaldkonna reverse charge'i puhul tuleb arvele muu hulgas ostja tunnus,
reverse-charge märge ja õiguslik alus; kasutaja ei kirjuta paragrahvi ise arvele.

---

## v0.10 – Ostuarved ja tšekid

Vana ostuarvete mõte jääb alles, aga palju põhjalikumalt.

### Ostuarve

- PDF;
- e-arve;
- XML;
- pilt;
- drag & drop;
- e-mailist saabunud dokument;
- AI/OCR andmete lugemine;
- tarnija;
- arve number;
- kuupäev;
- maksetähtpäev;
- summa;
- ALV;
- viitenumber;
- IBAN;
- BIC;
- makseviis;
- projekt / objekt;
- kulukoht;
- dokumentide duplikaadikontroll.

### "Lisa tšekk"

Ostuarvete moodulis eraldi kiire nupp.

- Telefonis: kaamera → pilt → AI loeb → kinnita.
- Desktopis: skänni / lohista fail / laadi pilt.
- Makseviis näiteks: ettevõtte kaart, pangakaart, sularaha, isiklik kaart / töötaja maksis, muu.
- Programm teeb vajadusel automaatselt võlgnevuse töötajale või vastava raha-/pangakande.

---

## v0.11 – AI kulude klassifitseerimine

AI loeb ostuarve või tšeki ja pakub näiteks:

> BAUHAUS
> ehitusmaterjal
> soovitus: Materjalikulud
> ALV: täielikult mahaarvatav
> Projekt: Espoo / töömaa X
> kindlus: 96%

Kasutaja vajutab **Kinnita**.

AI õpib tarnijast, varasematest arvetest, selgitusest, arveridadest, projektist ja kasutaja parandustest.

AI soovitus ja lõplik raamatupidamiskanne jäävad eraldi, et raamatupidamist saaks auditeerida.

---

## v0.12 – Müügireskontro 2.0

Olemasolevad müügiarved ühendatakse Accounting Core'iga täismahus:

- automaatsed raamatupidamiskanded;
- maksetähtajad;
- osamaksed;
- ettemaksuarved;
- krediitarved;
- kordusarved;
- viivis;
- maksemeeldetuletused;
- automaatne laekumise sidumine;
- EU/international invoice;
- mitme ALV määraga üks arve;
- maksukood rea kaupa;
- projekti/objekti määramine rea kaupa;
- PDF;
- e-arve;
- e-mail;
- arve keeled FI / ET / EN;
- erinevad arvenumbrid / seeriad;
- arve mallid;
- kliendi enda ostutellimuse number;
- viitenumber;
- QR/barcode makseinfo vajadusel.

---

## v0.13 – Pangandus

- pangaväljavõtte import;
- automaatne tehingute sobitamine;
- müügiarve ↔ makse;
- ostuarve ↔ makse;
- palk ↔ makse;
- maksud ↔ makse;
- teenustasud;
- laenud;
- intressid;
- kaardimaksed;
- sularaha;
- AI soovitab tundmatu makse konto;
- üks makse mitme arve vastu;
- osaline makse;
- üle-/alamakse.

Hiljem pangaliides / Open Banking ning maksekorralduste edastamine.

---

## v0.14 – Töötajate register

Iga töötaja:

- nimi;
- kontaktandmed;
- töösuhte algus/lõpp;
- töötaja number;
- amet;
- tööleping;
- töötasu tüüp;
- tunni-/kuupalk;
- maksustamise andmed;
- pangakonto;
- puhkused;
- haiguspäevad;
- tööajad;
- projektid/objektid;
- kuluhüvitised;
- päevarahad;
- kilometraaž;
- dokumendid.

Ligipääs peab olema rangelt rollipõhine.

---

## v0.15 – Tööaja arvestus

- töötunnid;
- objekt;
- kuupäev;
- algus/lõpp;
- pausid;
- ületunnid;
- nädalavahetus;
- õhtu-/öötöö lisad;
- puhkus;
- haiguspäev;
- tööreis.

Mobiilist eriti lihtne: **Alusta tööd → vali objekt → lõpeta töö**. Sellest saab hiljem automaatselt sisend
palgaarvestusse.

---

## v0.16 – Tööreisid, päevarahad ja kilometraaž

- tööreisi algus/lõpp;
- kestuse arvutamine;
- sihtkoht;
- riik;
- päevaraha;
- osapäevaraha/täispäevaraha vastavalt kehtivatele reeglitele;
- söögikordade mõju;
- kilometraaž;
- enda auto / ettevõtte auto;
- muud reisikulud;
- tšekid tööreisiga kokku;
- automaatne kuludokument;
- palgaarvestusse kandmine.

Maksumäärad ja hüvitiste piirid on **aastapõhises reeglitabelis**, mitte koodi sees.

---

## v0.17 – Palgaarvestus

Täielik payroll engine:

- kuu- ja tunnipalk;
- ületunnid;
- lisad;
- preemiad;
- puhkusetasu;
- haiguspäevad;
- maksuvabad hüvitised;
- päevarahad;
- kilometraaž;
- palga ettemaks;
- kinnipidamised;
- brutopalk;
- maksud;
- netopalk;
- tööandja kulud;
- automaatsed raamatupidamiskanded.

Näiteks töövoog:

> tööpäevad + reisid → päevaraha → muu summa palk → maksud → neto → makse

---

## v0.18 – Palgalehed

- palgaleht PDF;
- FI / ET / EN;
- töötaja portaal;
- e-mail;
- brutopalk;
- lisad;
- hüvitised;
- maksud;
- netopalk;
- puhkuseinfo;
- periood.

Töötaja näeb mobiilis ainult enda dokumente.

---

## v0.19 – Tulorekisteri / Incomes Register

Soome palgaarvestuse jaoks oluline eraldi integratsioon.

Pärast palga kinnitamist:

> Payroll → kontroll → Tulorekisteri deklaratsioon → maksed → raamatupidamiskanded

See ei tohi olla käsitsi topeltsisestamine.

---

## v0.20 – Maksud ja deklaratsioonid (Tax Center)

- ALV deklaratsioon;
- palgaga seotud deklaratsioonid;
- employer obligations;
- EU tehingute vajalik aruandlus;
- maksmisele kuuluvad maksud;
- tähtajad;
- esitatud deklaratsioonid;
- parandused;
- deklaratsiooni ja pearaamatu kontroll.

Näiteks:

> August 2026
> ALV return: valmis
> Payroll reporting: valmis
> 2 kontrolli vajavad tehingud
> Esita

---

## v0.21 – Põhivara

- masinad;
- autod;
- arvutid;
- tööriistad;
- kinnisvara;
- soetusmaksumus;
- soetuskuupäev;
- amortisatsioonimeetod;
- amortisatsiooniperiood;
- automaatsed amortisatsioonikanded;
- müük;
- mahakandmine;
- põhivararegister.

---

## v0.22 – Ladu ja tooted

Kõigil ettevõtetel vaja ei ole – eraldi aktiveeritav moodul.

- tooted;
- materjalid;
- ühikud;
- ostuhind;
- müügihind;
- laoseis;
- inventuur;
- laoliikumised;
- mahakandmine;
- projektile materjali väljastamine;
- lao väärtus.

---

## v0.23 – Projektid ja ehitusobjektid

Iga objekt näitab:

> Tulu – materjalid – alltöövõtt – töötunnid – palgakulud – sõidud – muud kulud = tegelik kasum

- eelarve;
- tegelik kulu;
- ostuarved;
- tšekid;
- müügiarved;
- töötunnid;
- töötajad;
- materjalid;
- alltöövõtjad;
- dokumendid;
- kasumlikkus.

---

## v0.24 – Aruandlus

- kasumiaruanne;
- bilanss;
- pearaamat;
- päevik;
- konto väljavõte;
- müügireskontro;
- ostureskontro;
- ALV raport;
- palgaraport;
- projektide kasumlikkus;
- rahavoog;
- võlad;
- nõuded;
- võrdlus eelmise perioodiga.

Kõigest: ekraan, PDF, Excel/CSV, print.

---

## v0.25 – Majandusaasta ja sulgemine

Soome Oy vajab majandusaasta lõpetamise ja financial statements'i võimekust.

- majandusaasta;
- perioodide sulgemine;
- periodiseerimine;
- amortisatsioon;
- bilansikontroll;
- kasumiaruanne;
- bilanss;
- eelmine aasta;
- järgmise aasta algsaldod;
- audit log;
- lukustatud majandusaasta.

---

## v0.26 – AI Accountant

Alles siin muutub AI päris raamatupidamisabiliseks. Näiteks:

> "Miks oli augustis kasum väiksem?"

AI analüüsib päris raamatupidamisandmeid ja vastab nt:

> Materjalikulu suurenes juuliga võrreldes 18%.
> Suurim erinevus tuli projektist X.
> Lisaks on kaks ostuarvet veel kliendile edasi arveldamata.

Samuti:

- puuduva tšeki avastamine;
- kahtlane ALV;
- võimalik duplikaatarve;
- vale kulukonto;
- maksmata arved;
- pangatehing ilma dokumendita;
- tavapärasest suurem kulu;
- võimalik vale reverse charge;
- kuu sulgemise checklist.

**AI ei muuda vaikimisi kinnitatud raamatupidamist omaalgatuslikult.** Ta pakub → inimene kinnitab.

---

## v0.27 – Mitmekeelne süsteem

Olemas on ET + EN. Lisatakse 🇫🇮 Suomi ja tõlgitakse kogu süsteem:

- UI;
- e-mailid;
- PDF-id;
- arved;
- palgalehed;
- aruanded;
- veateated;
- AI;
- maksuterminoloogia.

Ühe ettevõtte UI võib olla eesti keeles, aga arve kliendile soome keeles.

---

## v0.28 – Täielik mobiilitugi

See ei tähenda, et mobiili hakatakse alles v0.28 tegema. **Mobiil on iga eelmise versiooni acceptance criteria
osa.** v0.28 on lõplik mobiili lihvimine / PWA või mobiilirakenduse kiht.

Telefonist peab saama vähemalt:

- arve luua;
- ostuarve kinnitada;
- tšekk pildistada;
- arvet saata;
- makseid vaadata;
- töötunde sisestada;
- tööreisi sisestada;
- kulusid kinnitada;
- palgalehte vaadata;
- aruandeid vaadata;
- AI-ga rääkida;
- deklaratsiooni kontrollida.

Ja vajadusel: **Desktop view** – telefon horisontaali → kogu desktop-liides.

---

# Läbivad nõuded KÕIGILE versioonidele

Need ei ole enam eraldi "hiljem teeme" ülesanded.

1. **Desktop first, mobile complete.**
2. **FI / ET / EN valmis lokaliseerimiseks.**
3. **Kõik rahalised tegevused lähevad Accounting Core'i kaudu.**
4. **Maksureeglid on konfigureeritavad ja kuupäevapõhised.** Näiteks Soome vähendatud ALV muutus
   1. jaanuaril 2026 14%-lt 13,5%-le: vana arve peab jääma vana reegliga, uus kasutab uut.
5. **Ühel arvel võib olla mitu maksukoodi.**
6. **Rahvusvahelise tehingu maksustamist ei otsustata ainult selle järgi, et "EU = 0%".**
   Kauba ja teenuse, B2B/B2C, VAT-numbrite, müügikoha ja reverse-charge'i reeglid erinevad.
7. **Ühtegi kinnitatud kannet ei kustutata jäljetult.**
8. **Igal numbril peab olema võimalik jõuda algdokumendini.**
9. **AI soovitab, raamatupidamisreegel otsustab.**
10. **Kõik tuleb ehitada API-põhiselt**, et hiljem saaks sama backendi kasutada desktop, mobiil,
    integratsioonid ja automaatika.

---

## Allikad

Soome raamatupidamis- ja käibemaksunõuete kohta:

- [Accounting, financial year, tax period – vero.fi](https://www.vero.fi/en/businesses-and-corporations/business-operations/setting-up-a-business/accounting-financial-year-tax-period/)
- [Rates of VAT – vero.fi](https://www.vero.fi/en/businesses-and-corporations/taxes-and-charges/vat/rates-of-vat/)
- [VAT reverse charge in the construction sector – vero.fi](https://www.vero.fi/en/businesses-and-corporations/taxes-and-charges/vat/vat-in-different-lines-of-business/vat-reverse-charge-in-the-construction-sector/)
- [The changes to VAT rates – vero.fi](https://www.vero.fi/en/businesses-and-corporations/taxes-and-charges/vat/rates-of-vat/the-changes-to-VAT-rates/)
- [Value-added taxation of cross-border supply and acquisition of services – vero.fi](https://www.vero.fi/en/detailed-guidance/guidance/48679/value-added-taxation-of-cross-border-supply-and-acquisition-of-services/)
