# Felsökning: peers fastnar på "ansluter" (relä krävs)

SOP för rapporten *"deltagare på krångliga nät fastnar på 'ansluter'"*. Den är
skriven efter ett verkligt fall (serverflytt till ny IP bakom annan brandvägg),
men gäller varje gång relä-vägen är den enda möjliga och den inte fungerar.

Läs `docs/turn-coturn.md` för designen och `docs/operations.md` för
infra-uppsättningen. Den här filen är bara *diagnos → orsak → åtgärd*.

## Varför symptomet är just "ansluter" och inte ett fel

Det är värt att förstå, för det styr vilka bevis som är värda att samla.

En `RTCPeerConnection` behöver **minst en användbar kandidat** för att ens börja
göra connectivity-checks. På ett nät där direkta vägar är blockerade är den enda
användbara kandidaten en **relä-kandidat** från coturn. Går allokeringen inte
igenom blir resultatet inte ett fel utan **ingenting**: ICE-gatheringen blir
`complete` med noll användbara kandidater, checking startar aldrig, och
`connectionState` stannar på `"new"`. Uppmätt i Chrome: **2+ minuter utan en
enda state-ändring** (`scripts/relay-stuck-recovery-test.mjs`).

Det förklarar två saker som annars är förvirrande:

- **Inget syns i loggarna.** Ingen `failed`, ingen `disconnected`, inget som
  triggar återhämtning. Bägge mesh-mekanismerna (ICE-restart-backoffen och
  offer-retransmitten) armeras från en *state-övergång* och nås aldrig.
- **Det ser identiskt ut oavsett grundorsak.** Ett *felaktigt* relä (t.ex. stale
  `external-ip` efter en serverflytt) gathrar visserligen en relä-kandidat och
  når `failed` — men då startas ICE om, badgen målas om till "ansluter", och
  användaren ser samma sak som i fallet ovan.

Appen gör numera två saker åt detta (se "Vad appen själv berättar"), men
grundorsaken sitter nästan alltid i coturn-konfigurationen eller brandväggen.

## Steg 1 — Läs av vad appen själv säger

Sedan den här ändringen behöver du oftast inte gissa. Be den drabbade
deltagaren öppna **diagnostik-listen** i sidopanelen och läsa av:

- **Relä/ICE-hälsorutan** (gul ruta ovanför per-peer-raderna) — visar
  `Relä (TURN): ej konfigurerat` när deployen är STUN-only, och annars den
  **senaste** felkoden från STUN/TURN på en länk som är `osäker` *just nu*.
  Rutan är inte sessionshistorik: när paret läker försvinner raden, och ett
  nytt fel på samma par ersätter det gamla. En 401 från för några minuter
  sedan stannar alltså inte kvar bredvid ett färskt 701, och leftover
  701-timeouts från en frisk första gathering målas inte om vid en senare
  glitch.
- **Per-peer-raden** — status `osäker` (inte `ansluter…`) för ett par som aldrig
  kommit upp, med orsaken i radens tooltip.

Felkoden är hela svaret på "vems fel är det":

| Kod | Betyder | Nästan alltid |
| --- | --- | --- |
| **401** | Uppgifterna avvisades | `TURN_SECRET` ≠ coturns `static-auth-secret`, eller klockorna skiljer så mycket att det efemära användarnamnet redan gått ut |
| **403** | Reläet nekades | coturns kvoter, eller `denied-peer-ip` som blockerar motparten |
| **437** | Allokeringen finns inte | coturn startades om mitt i sessionen (självläker) |
| **701** | Inget svar alls | UDP-porten är blockerad eller inte vidarebefordrad till coturn-containern |

Samma händelse hamnar i serverloggen (servern accepterar bara joinade peers,
strippar kontrolltecken och begränsar distinkta `url`+kod per anslutning):

```
ice-error: 401 Unauthorized (turn:babbla.example.com:3478?transport=udp)
```

`701` **utan** att någon relä-rad syns betyder något annat: då nådde inte ens
STUN fram, dvs. nätet släpper igenom väldigt lite UDP — och det är just då
reläet behövs.

## Steg 2 — Verifiera reläet utifrån

Kör `npm run relay-check` **från ett nät utanför serverns eget**:

```sh
npm run relay-check -- https://babbla.example.com
npm run relay-check -- https://babbla-test.example.com
```

Skriptet (`scripts/relay-live-check.mjs`) hämtar deployens egna efemära
credentials ur `welcome` och gör bägge kontrollerna som krävs:

1. **Kontrollplan:** STUN Binding + autentiserad TURN Allocate ska svara och
   `XOR-RELAYED-ADDRESS` ska vara serverns nuvarande publika IP, inte en privat
   adress. Skriptet kör dessutom **samma kontroll över den andra transporten**
   (UDP ↔ TCP). Att coturn svarar över TCP men är helt tyst över UDP pekar rakt
   på port-forwarden — inte på coturn, secreten eller `external-ip`.
2. **Dataplan:** två riktiga browsers låsta till `iceTransportPolicy: "relay"`
   mot deployen. Skriptet kräver att valt kandidatpar är ett `relay`-par och att
   RTP-paket **och** kandidatparets bytes ökar i **båda** riktningarna.

Kontroll 1 ensam räcker inte. En server kan dela ut en snygg publik
relay-kandidat samtidigt som relay-portintervallet är blockerat, TTL:n dör på
vägen eller container-NAT tappar payloaden. Det är just därför den definitiva
kontrollen måste mäta ett valt relay-par och verklig media.

### Vilken *riktning* är trasig?

Tystnad över UDP ser likadan ut oavsett om frågan aldrig kom fram eller om
svaret aldrig kom tillbaka — men åtgärden är den motsatta (port-forward
respektive serverns egen utgående trafik). När UDP är tyst men TCP svarar kör
`relay-check` därför automatiskt ett **riktningstest** som driver vardera halvan
från TCP-kanalen:

- **inbound** — skicka UDP mot allokeringens relay-adress. Når det fram kommer
  det tillbaka som en `Data`-indication på TCP-kanalen.
- **outbound** — be coturn (över TCP) skicka ett datagram till oss. Överlever
  reläets utgående UDP resan får vår UDP-socket det.

`inbound OK` + `outbound NO PAYLOAD` betyder att **port-forwarden är hel** och
att felet sitter i reläets egen utgående UDP — kontrollera hostens brandvägg, NAT och utgående paket (se nedan).

> **Ett `inbound OK` är ett bevis; ett `inbound NO PAYLOAD` är det inte.**
> coturn relä:ar bara från adresser med permission, och en mätvärd bakom en
> pool-NAT kan gå ut från en adress som aldrig blev permittad. Testet permittar
> alla mappningar det kan hitta och gör flera försök, men kör om vid negativt
> svar innan du misstänker brandväggen.

Med `RELAY_CHECK_SKIP_BROWSER=1` körs bara kontrollplanet (ingen Chrome behövs);
`RELAY_CHECK_SHOTS=/dir` sparar en skärmdump av diagnostik-listen.

> **Kalibrera verktyget innan du litar på ett rött svar.** Kör det mot en
> lokal coturn + `node server.js` med matchande `TURN_SECRET`/`TURN_URLS`; då
> ska det vara helt grönt. Ett verktyg som aldrig blir grönt bevisar ingenting.

## Check the relay host

If inbound relay traffic works but outbound payload is absent, inspect the
operator's host firewall, NAT rules, relay port range and packet TTL. The required
commands and any platform-specific workaround belong to that installation's
runbook. Do not infer a particular operating system or firewall from this symptom.

## Steg 3 — Vanliga orsaker, i sannolikhetsordning efter en serverflytt

1. **`external-ip` points to an old public address.** Verify the advertised
   address and NAT mapping in the operator's TURN configuration after moving a
   server or changing its public address.
2. **Brandväggen framför den nya servern släpper inte igenom UDP.** Både
   `3478/udp` **och hela relä-portintervallet** (`min-port`–`max-port`) måste
   forwardas. Bara 3478 räcker inte: allokeringen svarar, men själva median har
   ingen väg. Det syns först i dataplanstestet.
3. **`TURN_SECRET` ≠ `static-auth-secret`** (401). Uppstår lätt när `.env`
   återskapades på den nya hosten medan coturns renderade conf följde med, eller
   omvänt. Notera att appen läser secreten vid start — en ändrad `.env` kräver
   omstart av babbla-containern, inte bara av coturn.
4. **`TURN_URLS` är osatt i den nya deployen.** Då är det STUN-only och det finns
   inget relä att fastna på. Hälsorutan säger `Relä (TURN): ej konfigurerat`,
   och det är ett annat problem än ett trasigt relä.
5. **Klockskev.** De efemära uppgifterna är `<unix-tid>:babbla` och avvisas som
   utgångna (401) om serverklockan ligger efter. Kontrollera NTP på hosten.

## Vad appen själv gör numera (och vad den medvetet inte gör)

Ändringen som följde den här rapporten gör symptomet självläkande och
självförklarande, men **den fixar inte ett trasigt relä** — den ser till att en
lagning slår igenom utan att alla laddar om sidan:

- **Initial-connect-watchdog** (15 s från att paret skapades, ~5× den värsta
  observerade friska relä-uppkopplingen). Ett par som inte nått `connected`
  lämnas till samma ICE-restart-backoff som `failed` använder. Effekten: när
  reläet börjar fungera igen — ny secret, öppnad port, rättad `external-ip` —
  kommer paret upp av sig självt inom några sekunder, i stället för att vara
  dött resten av sessionen.
- **Ärlig status.** Ett par som aldrig varit uppe och blåst watchdogen redovisas
  som `osäker`, inte `ansluter`. Utan det målade varje ICE-restart om en
  permanent trasig länk till en hoppfull "ansluter" varannan sekund.
- **`icecandidateerror` fångas** och klassas (tabellen ovan) till konsolen, UI:t
  och serverns användningslogg — en gång per distinkt `url`+kod.
- **Credential-refreshens relä-restart hoppar över par som aldrig anslutit**, så
  den inte nollar en pågående första gathering.

Det appen medvetet **inte** gör: den byter inte automatiskt till någon annan
transport och den döljer inte problemet. Finns ingen väg fram finns ingen väg
fram — men nu står det varför på skärmen.

### Varför diagnosen inte får vänta på `icecandidateerror`

Det första försöket att förklara ett trasigt relä lutade sig helt mot browserns
`icecandidateerror`. Det räcker **inte** för det vanligaste fallet — en relä-port
som aldrig svarar:

- Chrome deklarerar en TURN-allokering död först efter **~40 s** av
  retransmits (uppmätt: `701 TURN allocate request timed out` vid 39,9 s).
- Initial-connect-watchdogen lämnar paret till ICE-restart-backoffen redan vid
  **15 s**, och varje restart startar en **ny** gathering.

Backoffen hinner alltså alltid före timeouten, så eventet fyrar aldrig. Uppmätt
mot prod med UDP-porten stängd: **3 minuter, 14 ICE-restarter, noll
`icecandidateerror`, tom hälsoruta** — exakt den tystnad funktionen fanns till
för att ta bort.

Därför härleds diagnosen numera även ur **vilka kandidater gatheringen faktiskt
gav** (`describeGatheringFailure` i `mesh.js`): är TURN konfigurerat men ingen
`relay`-kandidat kom fram, så svarade inte reläet — oavsett vilken kod browsern
till slut hade landat på. Den slutsatsen finns tillgänglig direkt vid 15 s.
Fyrar ett riktigt `icecandidateerror` (401/403/437) ersätter det den härledda
texten, eftersom det är mer exakt. Regressionsskydd: sektion 6 i
`scripts/relay-stuck-recovery-test.mjs` (se nedan).

## Regressionsskydd

`scripts/relay-stuck-recovery-test.mjs` (ingår i `npm run e2e`) startar en
coturn med **medvetet fel secret**, tvingar två klienter på relä
(`iceTransportPolicy: "relay"`), och asserterar att 401:an syns i UI:t, att
paret redovisas som `osäker` i stället för `ansluter`, och att ICE-restarter
faktiskt körs. Sedan **repareras coturn mitt i testet** och sviten kräver att
paret läker till `ansluten`/relayed av sig självt. Den failar 0/11 på koden före
fixen.

Sviten täcker dessutom **reläet som aldrig svarar**: en `TURN_URLS` som pekar på
en UDP-socket som sväljer allt (hermetiskt, inget nät behövs) — samma symptom
som prod med stängd port. Kravet är att hälsorutan förklarar felet inom
watchdog-tiden **utan** att något `icecandidateerror` hunnit fyra. De två
checkarna failar på koden före den härledda diagnosen.
