# Plan: selektiv coturn-fallback + relä-indikator

> The application supports optional TURN credentials and relay-aware media policy.
> This document describes the application contract and design rationale.

## Problemet vi löser

babbla kör idag **STUN-only** (`ICE_SERVERS` i `public/js/room-controller.js`).
Det räcker oftast, men inte alltid: en deltagare kan hamna i ett läge där det
**direkta** P2P-paret mot en (eller flera) andra deltagare aldrig kommer upp,
medan andra par i samma rum fungerar. Konkret observerat: en session A/B/C där
A–B var anslutna och B–C var anslutna, men **A–C aldrig anslöt**. Felet är
intermittent och verkar nätverksberoende (samma enhet funkar på ett nät men inte
ett annat).

Målet: en **fallback** så att *alla* par kan utbyta strömmar även när direkt P2P
failar för just det paret. Prioritet på **ljud och skärmdelning**; kamera får gå
med men nedprioriterad bandbredd.

Två uttalade krav som styr designen:

1. **Minimera datamängden genom serverinfrastrukturen** (last + kostnad).
2. **Undvik att babbla-servern blir en klartext-mellanhand** för media — dels
   för lasten, dels för att slippa rimliga avlyssningsanklagelser (t.ex.
   företagshemligheter som delas via skärmdelning).

> **Obs — verifiera rotorsaken först.** `docs/webrtc-field-diagnostics.md`
> dokumenterar att ett tidigare "STUN failar"-fall i själva verket var en
> **iOS-WebRTC-bugg, inte NAT** — TURN hade inte hjälpt. Innan coturn rullas i
> drift: bekräfta med riktig kandidat-/topologidata att det failande paret
> faktiskt saknar ett fungerande direkt par (symmetrisk NAT / portfiltrering),
> och inte är ett klient-/OS-fel som även skulle bryta relä-kandidatparet.

## Beslut: TURN (coturn) — inte en app-nivå-relä

Fallbacken är en **TURN-server (coturn)**, *inte* att relä:a media genom
babbla-Node-servern.

- **Avlyssning:** en TURN-relä vidarebefordrar bara **DTLS-SRTP-krypterad**
  media. Nycklarna förhandlas end-to-end mellan de två klienterna; reläet ser
  bara chiffer det inte kan dekryptera. "Media via relä" ≠ "servern kan
  avlyssna". En app-nivå-relä genom `server.js` (Opus/datachannel över WS) vore
  tvärtom precis det klartext-mellanhandsscenario vi vill undvika.
- **Selektivitet gratis:** ICE väljer relä-kandidatparet *bara* för det par som
  inte får ihop ett direkt par. I A/B/C-fallet fortsätter A–B och B–C gå
  `host`/`srflx` direkt P2P, och *bara* A–C faller tillbaka på `relay`. Ingen
  egen routing-logik behövs — det är vad ICE redan gör per kandidatpar.
- Rör **inte** signaleringens
  rum-/presence-logik.

## Media-policy (sändar-sidan, per peer)

Relä-trafik är **lägre prioriterad**, men grundprincipen står över allt: **ljud
med lägsta möjliga latens är alltid högsta prio.**

| Ström | Direkt P2P | Via relä (coturn) |
| --- | --- | --- |
| **Ljud** | high prio, full kvalitet | **oförändrat** — high prio, throttlas aldrig |
| **Kamera (standard)** | 250 kbps | 250 kbps |
| **Kamera (fokuserad på scen)** | boost 1080p @ 2,5 Mbps | **ingen boost — 250 kbps** |
| **Skärmdelning** | 1,5 Mbps | 1,5 Mbps (en delare i taget ⇒ självbegränsande) |

Detaljer och motiveringar:

- **Kamera-boost bara till direkta peers.** Idag höjer `applyCameraDistribution`
  (`room-controller.js`) både *capture-upplösningen* (→ 1080p@50) och *per-peer
  send-bitraten* (→ 2,5 Mbps) för en peer som fokuserar din kamera på scenen. Med
  reläet gäller: en fokuserare vars länk är **reläad** får aldrig boost — hen
  stannar på 250 kbps. `wantHigh` beräknas enbart från **icke-reläade**
  fokuserare (plus egen förstorad self-view).
- **Capture vs encoding — viktig nyans.** Det finns **en** delad capture-track;
  varje PeerConnection *encodar* den oberoende med egen `maxBitrate`. Man kan
  alltså sätta olika *bitrate* per peer, men **inte** olika *upplösning* (ingen
  simulcast). Konsekvens i **blandat-fallet** (en direkt fokuserare *och* en
  reläad fokuserare samtidigt): capture tvingas till 1080p för den direkta, och
  den reläade matas då med 1080p-frames men bitrate-kapad till 250 kbps →
  blockig 1080p. **Detta accepteras medvetet** — databudgeten (≤250 kbps genom
  reläet) hålls, vilket var hela poängen; resolutions-mismatchen är ett sällsynt
  kantfall och simulcast bedöms inte värt komplexiteten ("håll lösningen
  minimal"). I det vanligare fallet (bara reläade fokuserare) bumpas capture
  aldrig och alla får ren standard.
- **Skärm 1,5 Mbps även reläad:** eftersom bara **en** kan dela skärm åt gången
  är skärm-strömmen självbegränsande och kan inte skena som N kameror. Läsbarhet
  prioriteras över datasnålhet här. **Förtydligande för implementeraren:**
  relä-status (`relayedPeers`) påverkar **inte** skärm-sendern — den befintliga
  `SCREEN_MAX_BITRATE` (1,5 Mbps, låg prio) gäller oförändrat för både direkta och
  reläade peers. Relä-status styr bara kamera-**boosten** och relä-indikatorn i
  UI:t.
- **Ljud orört:** `prioritizeAudio` i `mesh.js` sätter redan `priority` /
  `networkPriority: "high"` på varje audio-sender. Ljud throttlas aldrig, inte
  ens reläat.

### Relä-detektering (lokal, ingen ny signalering)

Sändaren avgör **lokalt** om en länk är reläad genom att läsa det valda
kandidatparet ur `getStats()`. **Obs:** `candidateType` sitter inte på själva
kandidat*paret* utan på candidate-rapporterna — slå därför upp parets
`localCandidateId`/`remoteCandidateId` i samma stats-utdata och läs deras
`candidateType`. `relay` på endera ⇒ trafiken går via coturn. (Implementerat som
den rena `transportFromPair()` i `mesh.js`, enhetstestad.)

- **Egen stats-sampler i `mesh.js`, inte UI:ns bandbreddsmätare.** Relä-status är
  *transportkritisk* media-policy och får inte vara beroende av att en UI-mätare
  råkar köra. `mesh.js` äger därför en egen ~1 s-poll (en intern stats-sampler)
  som uppdaterar `relayedPeers`-settet och **dessutom** matar UI:ns
  bandbreddsmätare med samma `getStats()`-sampel (en sampling, två konsumenter).
  Mätaren kan stoppas/byggas om utan att relä-detekteringen påverkas. Settet lever
  så länge meshen lever.
- **Vad `relayedPeers` styr:** kamera-**boostens** mottagare (reläad ⇒ ingen
  boost, 250 kbps) **och** relä-indikatorn i UI:t (`ui.setPeerRelayed`). Det styr
  **inte** skärm-sendern — skärm ligger fast på 1,5 Mbps oavsett relä (se
  media-policy ovan). `cameraPolicyKey`-no-op-gaten gör att oförändrad status inte
  ger någon `setParameters`-churn.
- Det valda paret kan **ändras mitt i samtalet** (nätbyte, ICE-restart kan byta
  direkt↔relä). Pollen fångar det inom ~1 s.
- **Konservativ default:** så länge det *inte* finns ett bekräftat **direkt**
  par (status okänd, eller `connectionState === "connecting"`) behandlas peern
  som ej boostbar (250 kbps). Då skickas aldrig 2,5 Mbps av misstag genom en väg
  som visar sig vara reläad. Priset är ~1 s reaktionsfördröjning efter ett
  path-byte direkt→relä — bedömt försumbart.

## Credentials & förnyelse

TURN kräver autentisering. Eftersom rummen är **öppna** och klient-JS:en är
publik får statiska credentials **inte** ligga i klientkoden — då blir det ett
öppet relä som vem som helst kan skrapa och tanka.

- **Efemära HMAC-credentials** (coturn `use-auth-secret`). En hemlighet delas med
  coturn via env-var (`TURN_SECRET`, coturn `static-auth-secret`). Hemligheten når
  **aldrig** klienten.
- **HMAC:en hör hemma i `server.js`, inte i `room.js`.** `room.js` är avsiktligt en
  *ren* presence-state-machine: den returnerar bara effekter (`{ to, msg }`) och ska
  inte känna till sockets, env-variabler, klockan eller crypto. Lägg därför
  credential-genereringen i transport-adaptern (`server.js`) och **injicera** den
  in i rummet/registryt som en provider, t.ex. `getIceServers()` eller
  `turnCredentialsProvider`, på samma sätt som `buildVersion` redan injiceras i
  `createRoomRegistry`. `room.js` *anropar* providern när den bygger `welcome` och
  bär in resultatet i `iceServers`-fältet — utan att själv läsa `TURN_SECRET` eller
  tiden. Det håller `room.js` testbart utan att stubba crypto/klocka.
- Providern bygger paret: `username = "<unix-utgångstid>:babbla"`,
  `credential = base64(HMAC-SHA1(TURN_SECRET, username))`, och returnerar en
  `iceServers`-array (STUN + TURN). `welcome` bär fältet bredvid `peers`,
  `sharer` osv.
- Klienten använder `welcome.iceServers` om det finns, annars faller den tillbaka
  på den hårdkodade **STUN-only**-listan i `room-controller.js`. Saknas
  `TURN_SECRET` (lokal dev / miljö utan coturn) returnerar providern bara STUN
  (eller inget) — allt fungerar oförändrat.
- Servern rör fortfarande ingen media — den räknar bara ut en HMAC. "Minimal
  server"-principen står kvar.

### Förnyelse (krav: fler-timmars-sessioner + nätbyten utan avbrott)

babbla används i **långa sessioner (flera timmar)** som inte får brytas, även vid
**wifi↔5G-byten**. WebRTC **auto-förnyar inte** TURN-credentials — `iceServers`
läses in när `RTCPeerConnection` skapas. En engångsbiljett vid join är därför
fel: för kort ⇒ den går ut mitt i samtalet och nästa ICE-restart (handover)
failar; "tillräckligt lång" går inte att gissa. Lösningen kopplar loss biljettens
livstid från samtalets längd genom att **rulla biljetter kontinuerligt**:

- **TTL ~1 h, klient-driven förnyelse ~var 30:e min.** Klienten vet
  utgångstiden (servern skickar med den) och begär en ny biljett i god tid via
  ett nytt litet meddelande, t.ex. `MSG.ICE_REFRESH`; servern svarar med färska
  `iceServers`. Servern förblir en ren svarare (ingen per-klient-schemaläggning).
- Klienten kör en ny `mesh.setIceServers(iceServers)` som loopar alla
  PeerConnections och kallar `pc.setConfiguration({ iceServers })`. Det uppdaterar
  vilka credentials *nästa* ICE-gathering använder — men ändrar **inte** en redan
  etablerad TURN-allokering, som lever vidare på de credentials den skapades med.
- **Proaktiv, staggrad ICE-restart krävs — inte "vänta på nästa restart".**
  `setConfiguration` ensamt räcker **inte** för kravet "flera timmar + wifi↔5G utan
  avbrott": en aktiv relä-allokering förblir bunden till de *gamla* biljetterna
  tills en ICE-restart faktiskt sker, och om den restarten råkar inträffa *efter*
  att de gamla biljetterna gått ut failar omförhandlingen — precis i det
  handover-ögonblick reläet behövs. Direkt efter en lyckad refresh ska klienten
  därför **proaktivt driva `pc.restartIce()`** på de anslutningar som behöver de
  färska biljetterna, så att en ny relä-allokering hinner etableras *medan de gamla
  credentials fortfarande är giltiga* (förnyelse ~30 min ⇒ ~30 min marginal till
  TTL-expiry). Krav på den proaktiva restarten:
  - **Bara där det behövs:** anslutningar som är **reläade** eller där relä-status
    ännu är **okänd**. Rena, bekräftat direkta P2P-par rörs inte (de använder inga
    TURN-credentials, så en restart vore ren onödig glitch-risk).
  - **Staggrad per peer** (t.ex. några hundra ms isär) så att en lång session inte
    river alla relä-par samtidigt och ger en hörbar samtidig glitch.
  - Återanvänder den befintliga ICE-restart-recoveryn i `mesh.js`
    (`restartIce()` + perfect negotiation över den oberoende WS-vägen); detta är
    bara en *proaktiv* trigger av samma maskineri, inte en ny väg.
- **Dubbel säkerhet:** auto-reconnect ger redan ett nytt `welcome` (med färska
  creds) vid varje WS-återanslutning — och ett wifi↔5G-byte triggar ofta just en
  reconnect. Den proaktiva förnyelsen täcker det *andra* fallet: en lång session
  som ligger kvar på samma WS i timmar utan reconnect, plus en peer som joinar sent.

## Transport

- **TURN/UDP först:** port **3478/udp** + ett **relä-portintervall** (UDP).
  Täcker symmetrisk NAT, det realistiska "P2P failar"-fallet på hemma-/mobilnät.
- **TURN/TLS-på-443 skjuts upp.** Nät som blockerar *all* utgående UDP hjälps
  inte av UDP-only-TURN; då krävs TURN över TCP/TLS på 443 (ser ut som HTTPS).
  Men det krockar med att babbla redan kör HTTPS på 443 via Caddy → kräver en
  **dedikerad IP** eller separat host för coturn. Bevisen för att det behövs är
  idag svaga (det enda testade företagsnätet fungerade STUN-only; det rapporterade
  "STUN failar"-fallet var en iOS-bugg). **Känd begränsning:** bygg TLS/443 först
  när fält-diagnostik faktiskt visar ett UDP-blockerat nät.

## Härdning av coturn (öppna rum ⇒ exponerad relä)

- **`denied-peer-ip`** för alla privata/loopback/link-local-intervall
  (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`,
  `169.254.0.0/16`, motsvarande IPv6) + **`no-multicast-peers`** → reläet kan
  bara koppla peers till publika IP:er, aldrig till internt nät (stänger
  SSRF-ytan).
- **`no-cli`** / exponera inte admin-porten publikt.
- **Kvoter:** `user-quota` / `total-quota` + **`bps-capacity`** (tak på total
  relä-bandbredd) så att ett missbruk inte kan sänka servern eller dra obegränsad
  data.
- Håll coturn patchad.

### Säkerhetsrisk att omvärdera före bred/skarp drift

- Reläet är **publikt upptäckbart** (känd port på publik IP; Shodan/masscan
  hittar det). Obskuritet är inget skydd.
- *Oautentiserat* missbruk är stängt av HMAC-credentials (kräver `TURN_SECRET`).
- **Restrisk:** eftersom rummen är **öppna** kan vem som helst joina ett rum och
  få en *äkta* biljett i sitt eget `welcome`, och missbruka reläet tills den går
  ut, inom kvoterna. Kort TTL + kvoter + `bps-capacity` **begränsar** skadan men
  **eliminerar** den inte.
- Innan bredare publik/skarp drift måste följande omvärderas: TTL-längd, kvoter,
  **rums-bundna eller autentiserade credentials**, moderation av öppna rum, och
  ett **kostnadstak** för relä-bandbredd. (Hör ihop med roadmap-punkt 5,
  moderation.)

## Relä-indikator (UI)

Peers vars länk *du* har via relä ska visas tydligt så användaren förstår att
anslutningen är annorlunda än direkt P2P.

- **Färg:** ny CSS-variabel **`--relay: #b388ff`** (lila/violett). Vald för att
  inte krocka med befintliga betydelser: grå = default, blå (`--accent`) =
  ansluter/fokus, **amber = anslutning *osäker*** (samt staging-banner +
  kamera-limit), grön (`--ok`) = pratar, röd (`--danger`) = mute/fel. Gul vore
  aktivt vilseledande eftersom amber redan betyder "håller på att fela", medan
  relä är en *fungerande* länk via annan väg.
- **Var:** lila ram på fjärr-peerens **tile** + speglad på **scenen** vid fokus
  (som mute-badgen). **Aldrig** på egen self-tile. Status är per-par sett från
  *din* sida — samma peer kan vara lila hos dig men grå hos en deltagare som har
  en direkt väg.
- **Precedens** (ramen har bara en färg): `ansluter (blå) > osäker (amber) >
  relä (lila) > default (grå)`. Transienta/brådskande tillstånd vinner; lila
  syns när den reläade länken är frisk. Dot + varningstext signalerar ändå
  ansluter/osäker.
- **Upptäckbarhet:** färg **+ `title`-tooltip** ("Ansluten via relä (servern) —
  direkt P2P misslyckades") **+ en förklaringsrad i info-modalen** (för
  mobil/förstagångsanvändare som inte kan hovra).
- Återanvänder samma `relayedPeers`-detektering som media-policyn (ingen ny
  signalering); ny `ui.setPeerRelayed(peerId, bool)` driven från
  `room-controller.js`.

## Berörda sömmar (app-sidan)

- **`public/js/mesh.js`** — egen ~1 s stats-sampler som driver `relayedPeers`
  *och* matar UI-mätaren (en sampling, två konsumenter); kamera-**boost**-gating
  mot reläade peers (skärm-sendern lämnas orörd på 1,5 Mbps); `setIceServers()` +
  en **proaktiv, staggrad `restartIce()`** för reläade/okända peers efter en
  credential-refresh (återanvänder befintlig ICE-restart-recovery).
- **`public/js/room-controller.js`** — `ICE_SERVERS` blir STUN-fallback;
  använd `welcome.iceServers`; gata kamera-boost (`applyCameraDistribution`) på
  direkt-P2P; `ui.setPeerRelayed`; begär `MSG.ICE_REFRESH` ~var 30:e min och
  applicera svaret (`setIceServers` + proaktiv restart).
- **`server.js`** — äger TURN-credential-providern (HMAC + `TURN_SECRET` + klocka),
  injiceras i room/registry; svarar på `MSG.ICE_REFRESH` med färska `iceServers`.
- **`room.js`** — *oförändrad som ren state-machine*: anropar den injicerade
  providern och bär in `iceServers` i `welcome` (ingen crypto/env/tid här).
- **`public/js/protocol.js`** — ev. ny `ICE_REFRESH`-konstant.
- **`public/style.css`** — `--relay`, `.connection-relayed`-tillstånd för tile +
  scen (med rätt precedens).
- **`public/index.html`** — förklaringsrad i info-modalen.

## Operator configuration

Configure `TURN_URLS` and `TURN_SECRET` in the application environment. The
selected TURN server must use the same shared secret for time-limited credentials.
Without these settings clients keep their STUN-only fallback.

The operator chooses TURN hosting, realm, reachable UDP/TCP/TLS endpoints, relay
port ranges, NAT mapping and firewall policy. Configure these outside the
application repository. Test both allocation and bidirectional media from another
network; a relay candidate alone is not sufficient evidence of connectivity.

## Testning (implementerat)

- **Enhetstest av relä-klassningen** — `test/transport-from-pair.test.js` driver
  den rena `transportFromPair()` (mesh.js) med en fejkad `getStats()`-karta:
  `relay` på endera kandidaten ⇒ `"relay"`, host/srflx ⇒ `"direct"`, inget par ⇒
  `"unknown"` (konservativt). Plus `test/room.test.js` för welcome-`iceServers` +
  `iceRefresh`. Ingen coturn behövs; körs med `npm test`.
- **E2e med lokal coturn** — `scripts/relay-fallback-test.mjs` startar en egen
  coturn (`turnserver`) + babbla-server med `TURN_SECRET`/`TURN_URLS`, joinar två
  klienter som **tvingas** på relä via `iceTransportPolicy: "relay"`, och
  verifierar: relä-vägen ansluter och bär media, valt kandidatpar är `relay`,
  relä-indikatorn (`connection-relayed`) syns på båda sidor, och en **reläad**
  fokuserare boostas **inte** (aldrig 2,5 Mbps; capture stannar 360p). Ingår i
  `npm run e2e` men **skippas automatiskt om `turnserver` saknas**.
  - **Obs (testmiljö):** coturn nekar som standard relä till loopback/privata
    IP:er, så single-host-testet startar coturn med `--allow-loopback-peers`.
    **Produktion behåller nekningen** (SSRF-härdningen ovan) — den hör hemma i
    operatörens TURN-konfiguration, inte i app-beteendet. Kräver `apt-get install coturn`.
  - `scripts/relay-border-screenshot.mjs` fångar UI-bevis (lila ram + info-modal-
    legenden) med samma uppsättning.
- **E2e för trasigt relä** — `scripts/relay-stuck-recovery-test.mjs` startar en
  coturn med **medvetet fel secret**, tvingar två klienter på relä, och
  asserterar att 401:an syns i UI:t, att paret redovisas som `osäker` (inte
  `ansluter`) och att ICE-restarter körs. Sedan **repareras coturn mitt i testet**
  och sviten kräver att paret läker av sig självt. Se
  [`relay-troubleshooting.md`](relay-troubleshooting.md) för varför symptomet blev
  ett tyst "ansluter" i stället för ett fel.
- **Mätstickan på riktigt failande nät** som slutgiltigt bevis när coturn är
  driftsatt.

## Felsökning i drift

En STUN Binding + autentiserad TURN Allocate verifierar kontrollplanet och
vilken relä-adress coturn delar ut, men **inte** att relay-portintervallet bär
payload. Slutverifiera utifrån med två klienter tvingade till relay och
kontrollera valt kandidatpar + faktisk RTP-trafik. SOP:n för rapporten "peers
fastnar på 'ansluter'" bor i
[`relay-troubleshooting.md`](relay-troubleshooting.md).

## Öppna frågor / framtid

- TURN/TLS-på-443 + dedikerad IP om ett verkligt UDP-blockerat nät dyker upp.
- Moderation / stängning av öppna rum, rums-bundna credentials, kostnadstak —
  förutsättning för säker bred drift (se säkerhetsrisken ovan).
- Exakta värden: credential-TTL (~1 h), relä-portintervallets storlek, `realm`,
  bandbreddsbudget för coturn-hosten.
