# Auto-skydd vid inaktivitet (auto-mute)

Plan för en **nice-to-have**-funktion: babbla stänger automatiskt av din
**mick + kamera** (och stoppar **skärmdelning**) när du verkar ha glömt bort att
du fortfarande strömmar.

Status: **plan, ej byggd.** Den här filen beskriver *vad* och *varför* (besluten
från en grilling-session). Implementationen lever sedan i `public/js/main.js`
(detektion, notis, UI/banner) — inga serverändringar behövs.

## Problemet

Vid långa heldagssessioner kommer folk och går, och man glömmer att man
fortfarande är live. Skräckscenariot är **integritetsläckage**, inte spök-peers:

- Du sitter kvar efter arbetstid och **tar av dig tröjan** för att det är varmt —
  kameran strömmar fortfarande.
- Din sambo kommer hem och ni har ett **privat samtal** — micken strömmar ut det
  i rummet medan någon kanske är kvar eller kommer in igen, utan att du märker
  det.

Det här handlar alltså om **strömning** (mick/kamera/skärm), inte om att städa
bort närvaro. Vi lämnar aldrig rummet automatiskt.

## Grundprinciper (besluten, och varför)

1. **Engagemang med appen är primärsignalen — inte ljudnivå.**
   Den ursprungliga idén var att muta vid *tystnad* under en dB-nivå. Den
   slopas helt i v1: en dB-baserad VAD missar huvudscenariot, eftersom ett
   **privat samtal = högt ljud** och då skulle detektorn se "aktivitet" och hålla
   dig live exakt när du som mest vill bli avstängd. Tystnad ≈ "pratar inte just
   nu", men risken är "pratar om fel saker till fel publik utan att veta om det".
   En ständigt mätande `AnalyserNode` är dessutom extra komplexitet utan vinst.

2. **Signalerna går inte att skilja åt passivt.**
   "babbla i bakgrunden men jag jobbar och pratar aktivt" och "babbla i bakgrunden
   för att jag glömt bort det" är, sett från en bakgrundsflik, omöjliga att
   särskilja: en bakgrundsflik kan inte se mus/tangent i andra appar, och
   mick-ljud ("pratar i samtalet" vs "pratar privat") är identiskt. Det enda som
   säkert skiljer är *om pratet är riktat till rummet* — vilket är omöjligt att
   veta. Därför **gissar vi inte; vi varnar först** och gör falska positiver
   billiga.

3. **Integritet > bekvämlighet.**
   Skyddet (auto-mute) sker **även om varningen inte kan levereras** (nekade
   notiser, iOS utan stöd). Varningen är en artighet, inte mekanismen.

## Detektion

Disengagemang mäts per signal nedan. **Timern nollställs** av valfri interaktion i
babbla (mus/tangent/klick) eller av att fliken blir synlig + i fokus. Det avbryter
även en pågående grace-period.

| Signal | Tröskel → notis | Grace → auto-mute |
| --- | --- | --- |
| Flik **dold/obevakad** (`document.hidden` / `blur`) | 10 min | 2 min |
| Flik **synlig men idle** (ingen interaktion) | 30 min | 2 min |
| **Aktiv skärmdelning** (egen, mildare klocka) | 30 min | 5 min |

Startvärden — tuna efter verklig användning.

### Varför olika trösklar

- **Dold/obevakad** är huvudtriggern: du tittar bevisligen på något annat, och
  läckagescenariona (privat samtal, byta tröja) sker nästan alltid när babbla
  *inte* är det du tittar på.
- **Synlig men idle** är en mycket svagare signal — den som **sitter och lyssnar
  uppmärksamt på en skärmdelning rör inte musen på 20 minuter** men är fullt
  närvarande. Därför en mycket längre tröskel, så vi inte klipper uppmärksamma
  tittare.
- **Aktiv skärmdelning** behandlas mildare (egen, längre klocka). När du delar
  tittar du oftast på *det du delar*, så babbla-fliken är dold under hela
  presentationen — med samma korta tröskel som mick/kamera skulle vi **klippa en
  pågående presentation**. En skärmdelning är dessutom en medveten broadcast och
  OS:et visar redan en "du delar"-indikator, så glömska-risken är lägre.

## Flöde

1. En tröskel nås → **system-notis** ("babbla stänger av din mick & kamera om
   N minuter om du inte gör något").
2. **Grace-period** (se tabell). Sker någon kvalificerande aktivitet under grace
   → **allt avbryts** och timern nollställs (ingen auto-mute).
3. Annars: auto-mute av **mick + kamera**; skärmdelning stoppas på sin egen,
   längre klocka.

### Notiskanal

- **Notification API** är vald kanal: den når dig även när du inte tittar på
  babbla-fliken, till skillnad från en in-app-banner (osynlig när fliken är dold).
- **Glapp vi accepterar (nice-to-have):** användaren kan **neka** notiser, och på
  **iOS Safari** fungerar webbnotiser i praktiken inte utan installerad PWA — just
  den plattform där "glömt att jag strömmar i bakgrunden" är mest sannolik. I de
  fallen sker **auto-mute ändå tyst**, och en in-app-banner förklarar vid
  återkomst vad som hänt.

## Återhämtning (vägen tillbaka)

- **Ingen auto-unmute någonsin.** Att slå på micken automatiskt när du börjar
  prata igen skulle återinföra precis det privata-samtal-läckaget. Allt
  återaktiverande kräver en **explicit handling**.
- **Mick & kamera:** förblir av tills användaren själv klickar på igen.
- **"Slå på igen" återställer bara det som auto-mute faktiskt stängde av.** Om
  kameran redan var av ska knappen inte slå på kameran bara för att micken
  auto-mutades. Spara därför en liten återställningssnapshot när auto-mute
  triggar (`hadMicOn`, `hadCameraOn`, `hadShareOn`) och använd den enbart för
  bannertext + explicita återställningsknappar.
- **Skärmdelning:** återupptas inte automatiskt (webben kan inte återuppta
  `getDisplayMedia` utan ny användargest).
- **Notis-klick** tar dig bara tillbaka till fliken — det slår inte på något. Du
  landar i ett tydligt läge: en banner *"babbla stängde av din mick och kamera
  efter inaktivitet"* med en **[Slå på igen]**-knapp (mick + kamera, ej
  skärmdelning).
- **Redan tyst + kamera/delning av när tröskeln nås → gör ingenting.** Det finns
  inget att skydda; vi river inte närvaron och lämnar inte rummet.

## Default & UI

- **På som default, ingen toggle i v1.** Funktionen mutar folk, vilket kan
  överraska — men den förklarande bannern gör beteendet begripligt, och projektets
  linje är minimal UI. En av/på-inställning kan läggas till senare om det irriterar.

## Implementationsanteckningar

- Allt lever i klienten (`public/js/main.js`); **inga serverändringar**.
- **Bygg idempotenta interna operationer — använd inte toggles direkt.**
  `toggleMute` är farlig för auto-mute eftersom den inverterar nuvarande state:
  om micken redan är av skulle den kunna slås på. Lägg hellre till små hjälpare:
  - `setMicMuted(true)` → sätter `track.enabled = false`, uppdaterar mute-UI och
    anropar `mesh.setLocalAudioMuted(true)`.
  - `setCameraOn(false)` → går via samma presence-väg som en användarklickad
    kamera-av, dvs servern måste få `camera(false)` och peers ska se kamera-av.
  - `setShareOn(false)` → använder `stopShare(false)` så servern får
    `share(false)`. Använd inte `superseded=true`; den vägen är bara för när
    någon annan tar över delningen och hoppar medvetet över signaleringen.
  De här hjälparna kan fortfarande återanvända befintlig implementation under
  huven, men deras kontrakt ska vara "sätt detta state", inte "växla state".
- **Presence lämnas ifred.** Auto-mute får inte stänga WebSocketen, lämna rummet,
  trigga reconnect eller spela join-/leave-toner. Den ska bara sluta skicka
  lokala mediaflöden och signalera kamera-/skärm-state som en vanlig manuell
  avstängning.
- **Timer-överlevnad i bakgrund:** webbläsare strypar timers i dolda flikar, men en
  **aktiv mick-ström håller sidan vid liv** (samma mekanism som iOS-bakgrundsljudet
  i AGENTS.md). Minut-skala-trösklarna här tål den strypningen — vi behöver ingen
  sekundprecision.
- En interaktions-/synlighetslyssnare (`pointerdown`/`keydown`/`visibilitychange`,
  m.fl.) nollställer en gemensam "senast engagerad"-tidsstämpel; en periodisk koll
  (t.ex. var 30:e sekund) jämför mot trösklarna och driver notis → grace → mute.

## Testkrav innan implementationen räknas som klar

- **Automatiskt browser-mediatest med fake media:** kör minst två separata
  Chromium-instanser (en per deltagare, enligt AGENTS.md) i ett isolerat
  `/room/test-...`. Snabba upp trösklarna i testet, slå på mick + kamera +
  skärmdelning för en klient, låt auto-mute trigga och verifiera att den andra
  klienten ser kamera/skärm försvinna och att ljudsändningen tystnar.
- **Idempotensfall:** testa att auto-mute inte unmutar en redan mutad mick och
  inte slår på en kamera som redan var av. Det här är viktigare än ett rent
  "happy path"-test eftersom privacy-buggen annars blir värre än funktionen.
- **Återkomstflöde:** efter auto-mute ska bannern förklara vad som hände, och
  "Slå på igen" ska kräva klick och bara återställa mick/kamera som auto-mute
  själv stängde av. Skärmdelning får aldrig återupptas automatiskt.
- **Regression:** verifiera att auto-mute inte påverkar presence: inga
  join-/leave-toner, inget `leave`, ingen reconnect, och deltagaren ligger kvar
  i rummet som tyst/utan kamera.

## Utanför scope (v1)

- dB-/VAD-baserad tystnadsdetektion (se princip 1).
- Att automatiskt **lämna rummet** vid inaktivitet (det här gäller strömning, inte
  närvarostädning).
- En användarinställning för av/på (kan tillkomma senare).
- Auto-återupptagning av mick/kamera/skärm.
