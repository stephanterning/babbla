# Plan: statistik-/användnings-panel (`/stats`) — PoC

> **Status:** *byggd (PoC).* Implementerad enligt nedan — backend (`stats/`),
> server-tappar (`server.js`), klient (`client_id` + transport-rapport) och
> dashboarden (`/stats`). Enhetstester i `test/stats-*.test.js` + e2e i
> `scripts/stats-smoke-test.mjs` (i `npm run e2e`). **Operatörsdoc:
> `docs/stats.md`** (env, endpoints, infra-handoff) är nu den kanoniska
> drift-källan; det här dokumentet är design/motivering. Infra-bitar (volym,
> secret, ASN-data och åtkomstskydd) väljs av operatören utanför apprepot.
>
> **Reviderad efter granskning av tidigare granskning** — spec:en skärptes mot faktiskt
> kodbeteende (transport-events vs `mesh.js`, fristående grace-timer vs
> `removeIfEmpty`, conn→`client_id`-karta, dedup-regel, leave-orsaker,
> registry-enumerering, `node:sqlite` vs `engines>=24`). Se inline-noterna
> "granskningspunkt N".
>
> **Revision 2 (djupare design-pass efter review):** (1) **deploy-tålig
> sessionsidentitet** — en serveromstart (varje deploy nollar in-memory-state)
> får **inte** stycka en session. Lösning: öppna sessioner **härleds ur
> event-loggen vid start** och återupptas inom ett resume-fönster (ingen ny
> muterbar tabell). Detta **ersätter** den tidigare (felaktiga) motiveringen att
> grace-timern löste deploy-restore. (2) **Transport-dedup förenklad** — klient-
> gaten struken; servern är enda dedup och loggar/räknar bara vid faktisk
> klassningsändring. (3) **Datakvalitets-guards** tillagda (XFF-saknas→`asn:null`,
> `camera-limit` stänger alla kamera-spann, öppna spann stängs vid leave/slut).
>
> **Current ASN contract:** clients report their STUN-discovered public IP for
> best-effort ASN lookup. The server resolves it offline and does not store the
> raw IP. It does not trust proxy headers for this telemetry; the historical
> proxy-header proposals below are superseded. No particular hosting platform
> is required.

## Vad vi bygger

En intern statistik-/användningspanel för babbla. Uttalade behov från beställaren:

- Grafer över **hur många som är inne nu** *och* **historiskt**.
- Förstå **behovet av relä** — hur många av användarna som behöver TURN, och
  **hur många reläade anslutningar som behövs som mest**.
- **Hur många rum** som använts och **hur många som varit i respektive rum**.
- **Visualisera hur länge** deltagare spenderat i ett rum (dwell-tid).
- **Hur mycket skärmdelning** och **hur mycket kameradelning** som använts.
- Bonusmål (uttalat viktigt): kunna **"rita upp" en hel session utifrån
  events** — vem anslöt, vem slog på kamera, vem fokuserade vem, vem delade
  skärm, vilket par tvingades till relä, osv., med tidsstämplar.

Målbilden bakom allt: förstå **var optimeringar bör göras och var problem finns**
(särskilt P2P-anslutbarhet per nätverk).

## Grundval: event-sourcing

Vi loggar **tidsstämplade råhändelser** (append-only) och **härleder alla mått
vid läsning**. Vi sparar alltså *inte* förberäknade sammanfattningar.

**Varför:** beställaren vill kunna hitta på nya analyser i efterhand utan att ha
designat dem i förväg, och kunna återskapa hur en hel session såg ut. Råa events
ger det; sammanfattningar låser in en. Vid babblas volym (en handfull personer)
är kostnaden för råa events försumbar.

## Låsta beslut (med motivering)

| # | Beslut | Varför | Alternativ vi valde bort |
| --- | --- | --- | --- |
| 1 | **SQLite på mountad volym** (`node:sqlite`, inget nytt npm-beroende) | Minsta avvikelsen från "minimal server" som ändå ger äkta historik som överlever container-omstart (varje deploy nollar annars allt — state är idag in-memory). `node:sqlite` finns inbyggt (mål Node ≥24; se driver-not under implementationsdefaults). | Postgres/TSDB (overkill, egen drift); JSONL-fil (klumpig att querya) |
| 2 | **Servern (adapter-lagret i `server.js`) är enda skribent**, server-klockan auktoritativ | Nästan alla events passerar redan servern som signaling → en skribent, en klocka, total ordning, ingen klock-skew. `room.js` förblir **ren** (den är medvetet klock-/socket-fri). | Klienterna emitterar events (N klockor, opålitlig ordning, kan ljuga) |
| 3 | **Event-sourcing** (råhändelser, härled vid läsning) | Se ovan. | Logga sammanfattningar/aggregat |
| 4 | **`client_id`: slumpat, per-flik i `sessionStorage`**, skickas vid join | Stabiliserar identitet över **auto-reconnect** och **deploy-restore** (annars blir dwell fragmenterad och distinkta-deltagare överräknat — varje WS-anslutning får nytt `randomUUID`). Per-flik ⇒ **ingen cross-besök-spårning** (passar tjänstens konto-lösa, öppna karaktär + lättare GDPR). | `localStorage` (cross-besök-spårning → integritetsfråga); ingen stabilisering (skört) |
| 5 | **`room_session_id`** myntas vid rum 0→1, stängs vid 1→0 (med **~15 s same-process-grace**), och är **deploy-tålig**: öppna sessioner härleds ur event-loggen vid serverstart och återupptas inom ett **resume-fönster** | Matchar session-definitionen ("första in → sista ut") mot en rum-instans. Same-process-grace hanterar transienta blippar medan servern lever; **resume ur loggen** hanterar att en **deploy startar om processen** (in-memory-`roomSessionId` försvinner annars → sessionen skulle styckas). Livscykel i `server.js` (klock-ägaren); `room.js` orört. Ingen ny muterbar tabell — loggen är enda sanningskällan (rev. 2). | Bara `room_name` + tidsfönster (skört); en muterbar `open_session`-tabell (andra sanningskälla, kan drifta från loggen) |
| 6 | **Denormaliserad metadata-snapshot på varje event** + fri `payload`-JSON | Vid den här datavolymen är redundansen gratis; ger självbeskrivande events, noll joins, och nya fält på nya event-typer **utan migration**. | Normaliserad dimensionstabell (joins, schema-beroende) |
| 7 | **Maximal metadata** men **leak-safe by default** (se nedan) | Beställaren vill ha så mycket metadata som möjligt *och* att en ev. läcka ska vara ofarlig. Lösningen: obfuskera *etiketterna*, behåll *strukturen*. | — |
| 8 | **Rent diskret händelsedriven logg** (inga bandbreddsprover) | Skärm-/kameraanvändning härleds ur on/off-paren (varaktigheter). Periodiska bandbreddsprover vore en kontinuerlig "firehose" utan tillräckligt mervärde för PoC:n. | `bandwidth-sample` var ~60 s |
| 9 | **`/stats` + `/stats/api` på samma server**, **öppen i PoC:n** | Ingen ny container, delar process/DB med skribenten. Öppen *bara* för PoC — se TODO om skydd. | Egen read-only-container (mer infra) |
| 10 | **Buffrad batch-skrivning + total felisolering**, tap **efter** flush | Babblas värde är låg latens; en statistik-bifeature får **aldrig** lägga latens på eller krascha signaleringen/ljudet. Hot-path:en gör bara en array-push; en `setInterval` flushar i batch; all loggning try/catch:ad. | Synkront skriv mitt i meddelandehanteringen |
| 11 | **Chart.js vendored** (statisk fil i `public/vendor/`) för aggregaten | Snabbaste vägen till sex graftyper i en PoC, utan byggsteg. Vendored (inte hot-länkat CDN) → självförsörjande, offline, ingen tredjepart (matchar integritetshållningen). | Handrullad SVG för allt (saktar ner iterationen); CDN-länk (tredjepart) |
| 12 | **Handrullad SVG-swimlane** för sessions-tidslinjen | Tidslinjen är en Gantt/swimlane — formen Chart.js är sämst på. SVG-swimlanes är rakt fram och förtjänar en rendering som passar. | Tvinga in i Chart.js floating-bars (hacky för överlagrade spann + par-kopplingar) |
| 13 | **`iptoasn.com`-TSV** som ASN-DB, in-memory, **best-effort** | Ingen konto/license-friktion (jfr MaxMind), public domain, en fil. Saknad DB → `asn: null`, pipelinen blockeras aldrig. | MaxMind GeoLite2 (konto + license key + uppdateringspipeline) |
| 14 | **Endast ASN/land lagras; rå-IP slängs vid ingestion** | Ger korrelationen "vissa ASN reläar oftare" utan att förvandla loggen till ett IP-register (GDPR). | Lagra rå-IP (PII-register) |
| 15 | **Ingen live-relästatus i PoC:n** — live = `deltagare nu` + `aktiva rum nu` | Live-relä skulle kräva **ny levande server-state** (en aktuell transport-karta) i en server som hålls medvetet transport-blind. Reläbehov visas i stället **historiskt** ur loggen. | Hålla en live transport-karta (ny state) |
| 16 | **Retention env-konfigurerbar, default 90 dagar**, daglig städning | Matchar PoC-andan (lätt att ändra) och håller exponeringsytan tidsbunden by default; kan sättas till "oändligt" under utvärdering. | För alltid; hård 90-dagarsgräns |

## Datamodell

Varje event är en rad. Förslag på envelope (justeras vid implementation):

```
id               INTEGER PRIMARY KEY        -- rowid
ts               INTEGER NOT NULL           -- server epoch ms (auktoritativ)
type             TEXT    NOT NULL           -- se taxonomin nedan
room_hash        TEXT                       -- HMAC(rumsnamn) — aldrig klartext
room_session_id  TEXT                       -- rum-instansen (beslut 5)
actor_client_id  TEXT                       -- stabil per-flik (beslut 4)
actor_conn_id    TEXT                       -- efemärt randomUUID (per WS-anslutning)
target_client_id TEXT                       -- nullable (focus/suppress/transport-par)
payload          TEXT                       -- JSON: typ-specifika fält
-- metadata-snapshot (denormaliserat, beslut 6):
asn              INTEGER                    -- nullable (best-effort)
asn_org          TEXT
country          TEXT
ua_browser       TEXT                       -- bucketad: familj
ua_version_major TEXT
ua_os            TEXT
is_ios           INTEGER                    -- 0/1
is_chromium      INTEGER                    -- 0/1
build_version    TEXT
env              TEXT                       -- staging/prod
```

**Härlett state (ingen extra tabell).** "Öppna sessioner", medlemsmängder och
per-par-transport är **inte** egna tabeller — de härleds ur `events` vid
serverstart (deploy-tålighet, beslut 5). Det kräver ett **index** på
`(room_session_id, ts)` (+ ev. `(type, ts)`), så startup-härledningen och de
historiska aggregaten inte gör fulla scans. Vid PoC-volym är även ett naivt scan
ofarligt; indexet är billig framtidssäkring. Resume-fönstret styrs av
`SESSION_RESUME_WINDOW_MS` (env).

### Event-taxonomi

**Serverobserverade** (passerar redan signaleringen):

- Livscykel: `room-session-start`, `room-session-end`, `join`,
  `leave` (`payload.reason` = `explicit` | `ws-close` | `heartbeat-timeout`),
  `reconnect` (nytt `conn_id`, samma `client_id` inom sessionen)
- Media/presence: `share-on`, `share-off`, `camera-on`, `camera-off`,
  `camera-limit` (taket som släcker alla kameror), `mute`, `unmute`,
  `video-opt-out-on`, `video-opt-out-off`, `camera-focus-on`,
  `camera-focus-off`, `video-suppress-on`, `video-suppress-off`

#### `MSG.*` → logg-event (granskningsnit)

De serverobserverade händelserna är **inte** 1:1 med `MSG.*`-typerna. Tappen
sitter i adapter-switchen i `server.js` (`ws.on("message")`), inte i `room.js`
(som bara returnerar effects och förblir ren). Mappning:

| `MSG.*` (in) | Logg-event | Not |
| --- | --- | --- |
| `JOIN` | `join` (+ `room-session-start` vid 0→1, + `reconnect` om känt `client_id`) | Roster-effekten från `room.js` loggas inte separat |
| `SHARE {on}` | `share-on` / `share-off` | — |
| `CAMERA {on}` | `camera-on` / `camera-off` | Om effekten blev `CAMERA_LIMIT` → logga `camera-limit` i stället |
| `MUTE {on}` | `mute` / `unmute` | — |
| `VIDEO_OPT_OUT {on}` | `video-opt-out-on/off` | — |
| `CAMERA_FOCUS {targetId,on}` | `camera-focus-on/off` | **Relä-only** (se not) — `targetId` (conn_id) → `target_client_id` via conn→context-kartan |
| `VIDEO_SUPPRESS {targetId,on}` | `video-suppress-on/off` | **Relä-only** — dito |
| `LEAVE` | `leave` (`reason: explicit`) (+ ev. `room-session-end`) | — |
| `SIGNAL`, `ICE_REFRESH` | *loggas inte* | SDP/ICE-relä + cred-förnyelse: chatty, inget analytiskt värde |
| `TRANSPORT` (ny, klient) | `transport` | Se klient-rapporterade nedan |

> **`camera-focus` / `video-suppress` håller inget rum-state** — `room.js` bara
> reläar dem (`{ to: [targetId], … }`). De loggas alltså i adapter-switchen som
> en sidoeffekt av relä:t, **inte** härledda ur någon presence-effekt. `targetId`
> på tråden är mottagarens **conn_id**; adaptern slår upp det → `target_client_id`
> via conn→context-kartan (se implementationsdefaults).

**Klient-rapporterade** — **exakt en** ny klient→server-meddelandetyp
(`MSG.TRANSPORT`), eftersom servern annars är transport-blind:

- `transport` — per par; `payload` = `{ classification: "direct"|"relay"|"unknown",
  localCandidateType, remoteCandidateType }` (host/srflx/prflx/relay per sida).
  Skickas när `mesh.js` `onRelayChanged` fyrar — dvs. när klassningen i
  `peerTransport` faktiskt ändras (`transportFromPair` på den valda
  kandidat-paret). **Båda sidor får rapportera** (ingen klient-gate); servern
  kollapsar paret (se dedup-noten). Vi loggar **varje faktisk klassningsändring**
  (inkl. → `unknown`, som approximerar ett tappat/failande par); en räknare på
  antal flippar faller ut ur historiken. `peer-failed`/`peer-recovered`/
  `ice-restart` som mellansteg härleds, **inte** skickas (se nästa not).

> **Verklighetskoll mot `mesh.js` (granskningspunkt 4).** `onPeerFailed` fyrar
> **bara** på `connectionState === "closed"` (teardown/borttagen PC); ett
> `"failed"`-tillstånd river *inte* paret utan markerar "osäker" + driver
> **intern** ICE-restart, och "recovery" är bara att tillståndet återgår till
> `connected`. Det finns alltså inga rena `peer-failed`/`peer-recovered`/
> `ice-restart`-signaler att haka på utan att uppfinna nya callbacks. **PoC:n
> uppfinner dem inte** — den enda nya klient→server-signalen är `MSG.TRANSPORT`.
> "Osäker"/recovery förblir lokalt UI-state (som idag). Vill man ha explicita
> failure-/restart-events senare krävs nya mesh-callbacks → utanför PoC-scope.

> **Relä = per par, inte per person.** I en mesh kan A↔B vara direkt medan A↔C
> går via relä. Vi loggar rådata **per par** och visualiserar primärt **per
> deltagare**: "X av Y deltagare hade ≥1 reläad länk" (intuitivt: *den personen
> hade inte fungerat utan TURN*). Per-session/rum-flaggan härleds ur samma data.
>
> **Dedup-regel (granskningspunkt 2 — förenklad i rev. 2): servern är enda
> mekanismen.** Klient-gaten på `min(conn_id)` är **struken** (sparade trivial
> trafik vid ≤15 par men införde skörhet — fel sida kunde vara den tysta). I
> stället håller servern **senaste klassning per kanoniskt par**
> (`(room_session_id, min(client_id_a, client_id_b), max(…))`) och:
> - en rapport som **matchar** nuvarande klassning → **ignoreras** (uppdaterar
>   bara `last_seen`),
> - en rapport som **skiljer sig** → loggar ett `transport`-event + ökar
>   flip-räknaren + uppdaterar tillståndet.
>
> Så även om **båda** sidor rapporterar samma flip (de bör konvergera —
> relä-ness är symmetriskt över paret) loggas/räknas den **en gång**. Per-par-
> tillståndet är in-memory men **rekonstrueras vid session-resume** ur det
> senaste `transport`-eventet per par (symmetri med deploy-tåligheten, beslut 5),
> så en omstart inte dubbelloggar en flip.

## Leak-safe by default

Mål: loggen ska vara **analytiskt rik men innehålla noll direkta identifierare
och noll användarskriven fritext i klartext** — en läcka till en **utomstående**
ska vara ofarlig.

| Fält | Transform | Varför fortfarande användbart |
| --- | --- | --- |
| **Namn** | **Lagras inte alls.** Identitet = opakt `client_id`. | Samma person känns igen via `client_id` → dwell, vem-med-vem, distinkta deltagare. (Hasha namn vore sämre: låg entropi, brute-forcas.) |
| **Rumsnamn** | **HMAC(namn, hemlig nyckel)** → `room_hash`. | Samma rum länkas över tid utan att avslöja etiketten/ämnet. |
| **ASN / org / land** | Klartext. | Hela poängen; beskriver *nätverk*, inte person. |
| **User-agent** | Bara **bucketat** (familj/major/OS/`is_ios`/`is_chromium`). Rå UA slängs. | "iOS-WebKit reläar oftare", versions-korrelationer — utan fingerprint. |
| **Tidsstämplar** | Full upplösning (server-ts). | Dwell, samtidighet, mönster. |
| **Rå-IP** | Slängs vid ingestion (efter ASN-uppslag). | — |
| `client_id`, transport, ICE-typ, kamera/skärm-flaggor, build, env | Behålls. | Teknisk analys. |

**Två förbehåll (dokumenterade med flit):**

1. **Nyckelhantering är hela skillnaden.** HMAC-nyckeln (rumshash) får **inte**
   ligga på samma volym som SQLite — då läcker båda ihop. Den ska vara en
   **env-secret** injicerad vid runtime. Då är en volym-/DB-läcka ensam ofarlig.
2. **Stark pseudonymisering, inte äkta anonymisering.** Den sociala grafen
   **bevaras med flit** (det är det som ska analyseras). En **insider med
   sidokunskap** ("jag gick in i standup-rummet 14:03") kan pivotera och hitta
   sin egen rad + se vilka andra opaka tokens som var där samtidigt. Skyddet är
   "ofarligt för en utomstående som får dumpen", inte "omöjligt att
   re-identifiera för en insider". Det går inte bort utan att förstöra analysen.
   **Med öppen `/stats` i PoC:n gäller insider-förbehållet vem som helst som
   öppnar URL:en** → därav TODO:n nedan.

## Panelen (`/stats`)

- **Live-kort** (ur befintlig in-memory state, polling ~5 s): `deltagare inne nu`,
  `aktiva rum nu`. (Ingen live-relä — beslut 15.)
- **Samtidighet över tid** (linje): deltagare + aktiva rum + **samtidiga reläpar**,
  samplat per minut/timme ur join/leave (reläpar ur samma `relayIntervals` som
  `max samtidiga reläade par`, så kurvans topp matchar kortet).
- **Reläbehov (historiskt)**: andel deltagare med ≥1 reläad länk över tid +
  **max samtidiga reläade par**; stapel **per ASN** med reläfrekvens.
- **Tidsintervall-väljare** (idag / 7d / 30d / allt) som alla historiska grafer
  respekterar.

> **Bortvalt (övervakningsfokus):** panelerna **Rum**, **Dwell-tid** och
> **Skärm- & kameraanvändning** togs bort — de bedömdes inte relevanta för
> övervakning. Underliggande spann (presence/kamera/skärm) finns kvar och driver
> fortfarande sessions-tidslinjen; bara dashboard-aggregaten `rooms`/`dwell`/
> `mediaUsage` och deras panel-paneler är borta.

### Sessions-tidslinje ("rita upp sessionen")

Handrullad **SVG-swimlane** för en vald `room_session_id`:

- En **lane per deltagare** (`client_id` som opak token, t.ex. "deltagare 7c2a").
- **Närvarobalk** (join→leave; reconnect-glapp synligt som avbrott).
- **Overlay-spann** inuti lanen: kamera-på, skärmdela, mute — färgade band.
- **Transport-färg** på lanen/understräng: direkt/relä/okänd.
- **Diskreta markörer**: camera-focus, video-suppress, camera-limit.
- **Par-händelser** (relä/focus/suppress): i PoC:n **markör + tooltip i källans
  lane** (utritade kopplingslinjer mellan lanes = senare iteration).
