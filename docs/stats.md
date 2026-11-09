# Användningsstatistik (`/stats`)

Operatörsdoc för Babblas statistikpanel och dess generella konfiguration.

> **Status:** PoC, byggd och i drift bakom flaggor. Endpointen är **oskyddad** —
> se Säkerhet nedan innan den behålls.

## Vad det är

En **event-sourcad** användningslogg: servern skriver tidsstämplade råhändelser
(join/leave/share/camera/mute/fokus/transport…) till SQLite, och panelen
**härleder alla mått vid läsning**. Inget ljud/media rör statistiken; allt sker i
adapter-lagret i `server.js` (Room-modulen förblir ren). Loggningen är buffrad +
helt felisolerad — en statistikfel kan aldrig störa signalering/ljud.

## Endpoints

| Path | Beskrivning |
| --- | --- |
| `/stats` | Dashboard (Chart.js-aggregat); länkar till sessions-utforskaren |
| `/stats/sessions` | **Sessions-utforskare** — dygnsvis, en rad per session, klicka för detalj-tidslinje |
| `/stats/api/live` | Live-snapshot: deltagare + aktiva rum **nu** (ur in-memory-state) |
| `/stats/api/summary?range=today\|7d\|30d\|all` | Aggregat över intervallet |
| `/stats/api/sessions?from=<ms>&to=<ms>` | Sessionslista för ett godtyckligt fönster (`hadRelay`-flagga); driver utforskaren |
| `/stats/api/timeline?session=<id>` | En sessions hela tidslinje (per deltagare) |

### Sessions-utforskaren (`/stats/sessions`)

Egen, **dygns-paginerad** vy (den dygns-modellen passar inte dashboardens
range-väljare). Visar **en rad per session** för en dag på en horisontellt
scrollbar 00–24-axel (fast 10-timmars zoom, default-fokus 08–18; scrolla i sidled
för resten). Tidigaste session överst, frusen etikettkolumn (`HH:MM · N p · rum8`),
lila prick på sessioner som behövde relä. Klick på en rad ritar den sessionen i
detalj-swimlane:n under (samma som tidigare tidslinje). Dag-navigering: ‹ föregående
/ nästa ›, datumväljare, "Idag"; tom dag → genväg till senaste aktiva dag. All
tidslogik är i **tittarens lokala tidszon** (klienten räknar dygnets `from/to`).

**Relä-attribution i detaljen:** ett valt kandidatpar är gemensamt för båda peers,
men relä-kandidaten *ägs* av den ena sidan. Detaljens transport-understreck färgar
därför en deltagare som **relä bara när hens *egen* kandidat var reläet** — dvs.
hen var den troliga restriktiva parten (symmetrisk NAT/brandvägg). Är man bara den
*andra* änden av en reläad länk läses det som **direkt** (motparten var "skyldig").
Kan reläet inte attribueras (klassning=relä men kandidattyper saknas) flaggas båda.
Heuristik, inte bevis — jfr `docs/webrtc-field-diagnostics.md`.

## Konfiguration (env)

| Variabel | Default | Beskrivning |
| --- | --- | --- |
| `STATS_DB_PATH` | `:memory:` | SQLite-fil. **In-memory = ingen historik över omstart** — sätt till en sökväg på en **mountad volym** i drift. |
| `STATS_HMAC_SECRET` | *(dev-fallback)* | Nyckel som HMAC:ar rumsnamn. **Måste sättas i drift** och ligga **utanför** DB-volymen. Långlivad (rotation re-pseudonymiserar rum). |
| `STATS_ASN_TSV` | *(tom)* | Sökväg till en `iptoasn.com`-TSV (v4/v6). Saknas ⇒ `asn: null` (best-effort, blockerar inget). |
| `STATS_RETENTION_DAYS` | `90` | Daglig städning av äldre events. `0` = spara för alltid. |
| `APP_ENV` | `dev` | Stämplas på varje event (`staging`/`prod`). |

**Client IP to ASN:** the browser discovers a public IP using a STUN server
already used by the application and reports it for statistics only. The server
looks up ASN offline through `STATS_ASN_TSV` and does not persist the raw IP.
Client reports are untrusted telemetry, never an authentication or authorization
signal. If discovery or lookup fails, ASN remains unknown. Proxy headers are not
used for this lookup, so installations do not require a particular proxy topology.

## Vad som lagras (leak-safe)

- **Inga namn.** Identitet = ett slumpat per-flik `client_id` (sessionStorage,
  ingen cross-besök-spårning).
- **Rumsnamn som HMAC** (`room_hash`) — aldrig klartext.
- **ASN + org + land** i klartext (beskriver nätverk, inte person).
- **User-agent bucketad** (browser-familj/major/OS/`is_ios`/`is_chromium`) — rå
  UA slängs.
- `build_version`, `env`, transport-klassning (direct/relay), kandidattyper.

The data is pseudonymous, not anonymous: timestamps and participation patterns
may identify people when combined with outside information. Treat the database
and statistics endpoints according to the operator's privacy requirements.

## Deploy-tålighet

En serveromstart (varje deploy) nollar in-memory-state. För att en deploy inte
ska **stycka** en pågående session härleds öppna sessioner **ur event-loggen vid
start** och återupptas inom `SESSION_RESUME_WINDOW` (~5 min); återanslutande
klienter (samma `client_id` över deploy-restore-reloaden) hamnar i **samma**
`room_session_id`. Sessioner äldre än fönstret avslutas med ett syntetiskt
`room-session-end`. Kräver `STATS_DB_PATH` på en beständig volym för att funka
över en deploy.

## Access and storage

`/stats*` has no built-in authentication. The operator can protect these paths
through a reverse proxy without changing room access. Persistent statistics need
a writable volume for `STATS_DB_PATH`; the default is ephemeral memory. Keep
`STATS_HMAC_SECRET` outside that volume and preserve it across restarts when
stable room pseudonyms are required. ASN data is optional and operator-supplied.

## Förhandsgranska lokalt (innan deploy)

Vill du se hur panelen ser ut **ifylld** utan att deploya? Seeda en
slängbar demo-DB med realistisk syntetisk data (flera rum, sessioner över en
vecka, dwell, relä per ASN, kamera/skärm, reconnects) och kör servern mot den:

```bash
node scripts/stats-seed-demo.mjs ./stats-demo.db 7 24   # [db] [dagar] [sessioner]
STATS_DB_PATH=./stats-demo.db STATS_HMAC_SECRET=demo node server.js
# öppna http://localhost:8080/stats
```

All data är påhittad (inga riktiga IP/namn). `stats-demo.db*` är gitignorerad;
radera filen för att börja om. Köra mot **riktig** lokal trafik i stället: hoppa
över seedningen, sätt bara `STATS_DB_PATH` till en fil och gå med i ett rum i en
annan flik — eller lämna `STATS_DB_PATH` osatt (in-memory) för en snabb titt på
just den körningen.

## Drift / felsökning

- Allt stats är best-effort: fel loggas (`[babbla:stats] …`) men kastas aldrig
  vidare. Saknad ASN-TSV, låst DB osv. ⇒ tappad statistik, aldrig tappade samtal.
- `node:sqlite` (`DatabaseSync`) används — inget npm-beroende. Kräver Node ≥ 22.5
  (containern kör Node 24).
- Tester: enhetstester i `test/stats-*.test.js`; server-tappens e2e i
  `scripts/stats-smoke-test.mjs` (ingår i `npm run e2e`).
