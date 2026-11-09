# Fält-diagnostik för WebRTC-anslutningsbuggar ("presence men ingen media")

En SOP för att felsöka den svåraste klassen av babbla-buggar: en deltagare
**syns i presence** (servern säger att de delar kamera/skärm, eller bara är i
rummet) men **ingen media kommer fram** (ljud och/eller video, åt ena eller båda
hållen) — medan andra deltagare fungerar mot varandra. Felet är ofta
enhets-/nätspecifikt, går sällan att reproducera lokalt, och drabbar gärna
mobil/iOS där man inte kan koppla en debugger.

Den här filen finns för att en framtida agent/utvecklare **inte ska behöva
treva sig fram igen**. Det tog en del iteration att lista ut *exakt* vad som
behövde fångas och hur — allt det står här. Själva diagnostik-koden ligger
**inte** kvar i `main` (den blev rörig utströsslad i `mesh.js`/`main.js`/
`server.js`); den finns bevarad på grenen **`cursor/diag-presence-no-media-e5aa`
(tidigare granskning, ej mergad)** att återanvända som startpunkt.

---

## TL;DR — vad som fungerade

1. Fånga från **två håll samtidigt**: klienten (rik per-peer-state + en
   händelse-timeline) **och** servern (den ser all signalering: presence + SDP-
   relän).
2. Skicka allt till en temporär **`POST /diag`** + läs via **`GET /diag`**
   (ring-buffer). Funkar i prod, lokalt och på iOS.
3. Exponera servern för riktiga enheter via en **`cloudflared` quick-tunnel**
   från dev-VM:en (HTTPS krävs för `getUserMedia` på mobil).
4. Två triggers: en **`?diag=1`-knapp** (manuell) och en **auto-probe** som
   postar när en anomali håller i sig >8 s.
5. Klassa anomalin med en `reason` — och **fånga ICE-kandidattyper +
   kandidatpar-utfall**, det är det som skiljer rotorsakerna åt.

---

## Vad som ska fångas (fälten som faktiskt avgjorde)

### Per peer (sluttillstånds-snapshot)
Byggs **inuti `mesh.js`** (en `diagnostics()`-metod) eftersom `getConnection`
medvetet *inte* exponeras längre — modulen äger sin `RTCPeerConnection`.

- `signalingState`, `connectionState`, `iceConnectionState`, `iceGatheringState`
- `polite`, `makingOffer`, `didInitialNegotiation`, `offerRetransmits`,
  `recoveryAttempts`, `pendingIce` (buffrade kandidater)
- `transceivers`: per transceiver `mid`, `direction`, `currentDirection`,
  sändarspår-kind, **mottagarspår** `{ kind, readyState, muted }`
- `localRoles` (mid→roll vi skickar) + `remoteRoles` (mid→roll vi tagit emot)
- `getStats`-utdrag: inbound-video `{ bytesReceived, framesDecoded,
  packetsReceived }` + outbound-video `{ bytesSent, framesEncoded }`.
  **`framesDecoded` är guld** — visar om media *faktiskt* flödar.
- **ICE (avgörande):** per anslutning — antal `local`/`remote`-kandidater per typ
  (`host`/`srflx`/`prflx`/`relay`), om **något kandidatpar `succeeded`**, och en
  lista av paren med `{ state, nominated, local, remote, proto }`.

### Timeline (rullande event-ring, ~300 events)
Matas av en `onDiag(peerId, type, detail)`-tapp i `mesh.js` på dessa punkter:
`add-peer`, `negotiationneeded` (fyrad **och** undertryckt-polite-initial),
`offer-sent`, `recv-desc` (+`offerCollision`/`ignoreOffer`), `answer-sent`,
`sig-state`, `conn-state`, `offer-retransmit`, `track`. Snapshotten visar *var*
det står; timelinen visar *hur* det gick dit (racen).

### Anomali-klassning (beslutsträd, mottagar-sidan)
För varje peer där presence säger kamera/skärm-på men inget levande spår finns:

- ingen video-transceiver → `no-video-transceiver`
- `mid` ej i `remoteRoles` → `mid-unmapped` (roll-kartan kom inte med)
- mottagarspår `ended` → `track-ended`
- `signalingState` fast i `have-local-offer`/`have-remote-offer` → `wedged-*`
- `connectionState !== "connected"` → `not-connected:<state>` / `transport-failed`
- `offerRetransmits >= 3` → `offer-retransmit-storm`
- transceiver + connected + roll, men `framesDecoded === 0` →
  `connected-but-0-frames`

Lägg dessutom till en **transport-anomali per peer** (`connectionState` ej
`connected` efter `didInitialNegotiation`) så att även "inget ljud heller"-fallet
fångas — inte bara saknad video.

### Server-sidan (observatör)
Servern relär all signalering, så den kan logga per-par-events utan klient-
samarbete: `join`, `share on/off`, `camera on/off`, och **`relay-desc`** (typ
`offer`/`answer` + vilka `roles` SDP:n bar). Spela **inte** in varje ICE-kandidat
(för brusigt) — bara descriptions + presence.

---

## Implementation (seams + var koden hör hemma)

- **`public/js/mesh.js`** (tappar, temporära): ett `onDiag`-option + en liten
  `diag(peerId, type, detail)`-helper anropad på punkterna ovan, plus en
  `diagnostics()`-metod som bygger snapshotten (läser `pc.getTransceivers()` +
  `pc.getStats()`).
- **`public/js/diagnostics.js`** (egen modul): ring-buffer för timelinen,
  `bundle()`-byggare, anomali-klassaren, `?diag=1`-knappen, och auto-proben
  (interval ~5 s; posta en gång per anomali-uppkomst). POST:ar `fetch("/diag")`.
- **`server.js`**: `POST /diag` (logga `[DIAG] …` + lägg i ring-buffer) och
  `GET /diag` (returnera senaste). Observera presence + `relay-desc` i
  meddelande-switchen. **Håll klientbuntar i en *egen* ring** (separat från
  server-events) — annars kan en server-event-storm (t.ex. en offer-retransmit-
  loop) tränga undan de värdefulla klientfångsterna.
- **`main.js`**: skapa `createDiagnostics({ getMesh, getContext })`, kör
  `diagnostics.start()` en gång, och skicka `onDiag` till `createMesh`.
  `getContext()` ger `myId`, `room`, `sharerId`, `hasCamera(id)`, `myVideoOptOut`.

Allt märks med `// TEMP DIAGNOSTICS` och tas bort med en ren revert efteråt.

---

## Köra en session

På den här typen av VM finns ingen publik HTTPS, och mobil kräver secure context
för `getUserMedia`. Lösning — en accountless tunnel från dev-VM:en:

```bash
npm start                                   # babbla på :8080 (med diag-koden)
cloudflared tunnel --url http://localhost:8080 --no-autoupdate   # ger en https://<rand>.trycloudflare.com
```

`cloudflared` quick-tunnel kräver **inget konto** (till skillnad från ngrok som
vill ha en authtoken), så en agent kan starta den själv. Ge användaren tunnel-
URL:en; deras enheter (inkl. iOS) ansluter över HTTPS medan du läser
`<url>/diag` live. Obs: quick-tunnel-URL:en är **efemär** — byts vid omstart.
Behövs en stabil adress: namngiven cloudflared-tunnel (egen domän) eller ngrok
med reserverad domän.

Reproduktion: låt enheterna joina **samma rum** (`/room/test1`), slå på det som
ska felsökas (kameror osv.), och lägg `?diag=1` på de misstänkta enheterna så
🐞-knappen finns.

---

## Att läsa datan — fallgropar (det här kostade tid)

- **Lyckat = ingen anomali = ingen auto-post.** Auto-proben fyrar bara på fel.
  För att fånga ett *fungerande* tillstånd (för jämförelse) måste man trycka på
  **knappen** — den postar oavsett.
- **Fånga ICE-kandidattyper + par-utfall.** Det är *det* som skiljer
  rotorsakerna: signalerings-wedge (`have-local-offer` + `offer-retransmit`) vs
  ICE/transport-fel (`checking`→`failed`) vs klassning (`mid-unmapped`) vs
  media-flödar-inte (`connected` men `framesDecoded === 0`).
- **Känn nätverkstopologin innan du drar slutsatser.** Mönstret "`srflx` samlad
  men inget par lyckas" *ser ut* som symmetrisk NAT → TURN. **Men** om den
  failande enheten sitter på **samma LAN** som de andra (då ska `host/host`
  lyckas trivialt) och ändå failar, är det **inte** NAT — det är en klient-/OS-
  bugg. Vi var nära att bygga coturn/TURN i onödan; det som faktiskt löste det
  var att uppgradera enhetens iOS. Fråga *alltid*: var sitter den failande
  enheten, och fungerar `host/host` på samma nät?
- **iOS UA är fryst.** iOS 26 rapporterar `iPhone OS 18_7` i user-agent — lita
  inte på versionssträngen; bekräfta OS på annat sätt.
- **Offer-retransmit-"storm".** Watchdogen i `mesh.js` (som läker en tappad
  offer) kan *loopa* när den körs mot en anslutning som ändå inte kan etableras
  (t.ex. ICE som aldrig connectar). En storm av `relay-desc` i serverloggen är
  alltså ett *symptom* på en anslutning som inte går att få upp — inte
  nödvändigtvis en signaleringsbugg.

---

## Vad utredningen kom fram till (exempel, juni 2026)

Symptom: en deltagare (iOS) fick varken ljud eller bild, åt något håll, medan
övriga fungerade. Diagnostiken visade: enheten samlade `srflx` men **inget
kandidatpar lyckades** — såg ut som symmetrisk NAT. Men nyckeln var att enheten
satt på **samma hemma-wifi** som de andra (så `host/host` borde lyckats) och
ändå failade — och felet **försvann när telefonens iOS uppgraderades** (samma
telefon, samma nät). Rotorsak: en **WebRTC/ICE-defekt i iOS 18.1**, inte NAT och
inte en babbla-bugg. **TURN behövdes inte.** Lärdomen: verifiera med riktig
kandidat-data + topologi-fakta innan man bygger infrastruktur.

> Inte att förväxla med den separata, *riktiga* fix som ligger i `main`
> (offer-retransmit-watchdogen, tidigare granskning): den läker en **tappad första offer**
> som annars wedge:ar ett par i `have-local-offer`. Det var en äkta
> signaleringsbugg; "presence men ingen media" ovan var ett klient-OS-problem.

**Tumregel:** wedge:ad/tappad förhandling (`have-local-offer`, offer-retransmit)
→ signaleringsvägen (jfr tidigare granskning). Media som inte flödar fast paret är `connected`
på samma LAN → misstänk klient/OS, inte NAT/TURN.
