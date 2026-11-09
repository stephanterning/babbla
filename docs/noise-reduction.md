# Brusreducering — högpass + mjuk expander (plan, ej byggd)

Plan från en grilling-session. Den här filen beskriver *vad* och *varför*
(besluten); implementationen lever sedan klient-side i en ny modul
`public/js/mic-pipeline.js` + inkoppling i `public/js/room-controller.js` och
`public/js/main.js`. **Inga serverändringar.**

Status: **plan, ej byggd.**

## Problemet

Användarfeedback: ljudet saknar brusreducering. Rapportören körde **Chrome med
macOS Voice Isolation (VI)** påslaget. **När de själva pratar är ljudet fint** —
men när de **lyssnar** hör de mer **bakgrundsljud och tangentbordstryckningar**
från *andra* deltagare än de förväntar sig (jämfört med Teams/Slack/Meet).

Två insikter styr hela designen:

1. **Det är ett sändarsidesproblem, observerat av en lyssnare.** Oljudet sitter
   på varje *bullrig* deltagares capture. Lyssnaren som klagar kan inte fixa det
   från sin egen maskin, och mottagarsides-städning är en sämre krycka (lägre
   kvalitet, CPU per peer, och avfärdat i `docs/echo-cancellation-step2.md`).
   Fixen måste alltså ligga på **allas utgående ljud**.
2. **"När de pratar är det fint"** ⇒ oljudet märks mest **mellan orden / när man
   lyssnar och skriver**, dvs precis under talnivå. Det är det *lätta* fallet —
   en expander som dämpar under tröskel löser det utan tung DSP. Det *svåra*
   fallet (döda tangentbord *medan* man pratar) kräver en DNN och den latensen
   väljer vi bort (se "Utanför scope").

Vi förlitar oss medvetet på **inbyggda verktyg** (Chrome AEC3/NS/AGC + macOS VI)
plus minimal egen native-DSP. Ingen tredjepartslib.

## Grundprinciper (besluten, och varför)

1. **Mjuk nedåt-expander — aldrig hård grind, aldrig till äkta tystnad.** En hård
   noise gate är talar-gating med en volymtröskel, och kapar exakt de "samma
   rum"-signaler produkten bygger på (mm/ja/precis, inandningar, rumston). Det
   bryter "alla pratar samtidigt". Vi dämpar därför mjukt under tröskel (behåller
   rumston), aldrig till noll.

2. **Default på (lätt) — inte ren opt-in.** Den som är bullrig **hör inte sitt
   eget brus** och har ingen anledning att slå på en av-default-inställning. En
   opt-in default-av skulle därför *inte* lösa det rapporterade problemet. Därför
   körs en **gentle reduktion default-på för alla**, med en kontroll för att gå
   starkare eller stänga av.

3. **Latens är värsta fienden — håll det native och lätt.** Expandern är en liten
   AudioWorklet (~3–6 ms). Mouth-to-ear ligger på ~95 ms med ~40–50 ms marginal,
   så tillägget är omärkbart (mindre än jitterbufferns egen variation). Se
   `docs/latency-levers.md` för budgeten. Ingen WASM/DNN i v1.

## Design

### Alltid på, för alla (oberoende av kontrollen)

- **80 Hz högpass** via en native `BiquadFilter`. Tar bort rummel/duns/lågfrekvent
  läckage och hjälper expandern att inte hållas öppen av lågfrekvent energi.
- Chrome-constraints **`echoCancellation` / `noiseSuppression` / `autoGainControl`
  förblir `true`** (AGC behålls — jämn nivå hjälper en alla-pratar-samtidigt-mix;
  expanderns adaptiva tröskel hanterar AGC:s rörliga golv, se nedan).
- **`-6 dB low-shelf @ 140 Hz är uttryckligen UTANFÖR scope** (en tonsmak, inte
  brusreducering; thinnar dessutom röster och motverkar "samma rum"-värmen).

### Kontrollen "Brusreducering": Av / Lätt / Stark (default Lätt)

En `<select class="device-select">` med label **"Brusreducering"** och alternativ
i ordning **Av / Lätt / Stark** (default **Lätt**), placerad direkt efter
mikrofonväljaren i `.controls`. Internt: Av = expander bypassad, Lätt = gentle,
Stark = kraftigare.

> **Obs:** "Brusreducering: Av" stänger bara av **expandern** — den **80 Hz
> högpassen ligger kvar** (den är ovillkorlig för alla). "Av" = HPF-only-graf,
> inte den råa enhetssignalen.

### Expandern (DSP)

- **Mjuk nedåt-expander som AudioWorklet** (envelope-follower → gain, per render-
  quantum). Web Audio saknar en native expander-nod, och `DynamicsCompressorNode`
  är fel kurva *och* lägger på 6 ms lookahead → en egen worklet är rätt.
- **Envelope-only** (ingen separat VAD): den agerar på signalens egen kortsiktiga
  RMS. Konsekvens att acceptera: en skarp tangenttransient kan kort överstiga
  tröskeln och "öppna" — expandern är därför bra på **stadigt** brus / brus mellan
  ord, men bara **delvis** på tangentklick. Full tangentdödning = DNN = bortvald
  latens.
- **Adaptiv tröskel (golv-spårning):** spåra ett långsamt brusgolv (minimum-
  follower / låg percentil över några sekunder) och lägg öppningströskeln några
  dB över. Tröskeln **rider då med** AGC:s rörliga golv och anpassar sig per
  mikrofon/rum automatiskt (en fast dBFS-tröskel vore bräcklig och skulle slåss
  med AGC).
- **Cold-start = pass-through:** dämpa inte förrän golvuppskattningen är säker
  (~1–2 s), så vi aldrig klipper de första orden efter join.
- **Tuning-filosofi:**
  - **Lätt (default) = fail-open** — klipp **aldrig** en talare; vid tvekan,
    släpp igenom. Acceptera att lite restbrus läcker. Skyddar kärnkänslan.
  - **Stark = lätt fail-closed** — för den som uttryckligen vill ha mer tystnad
    och accepterar att det allra svagaste talet kan klippas ibland.

Startvärden (tunas mot verklig media):

| Parameter | Lätt (fail-open) | Stark (mild fail-closed) |
| --- | --- | --- |
| Tröskel över golv | nära golvet | någon dB högre |
| Ratio | ~2:1 | ~4:1 |
| Attack | ~5–10 ms | ~5–10 ms |
| Release | ~150–250 ms | ~150–250 ms |
| Hold | ~100–200 ms | ~100–200 ms |
| Max dämpning (range) | ~−9…−12 dB | ~−18…−24 dB (aldrig tystnad) |

### Konsekvens vs Teams

Med Lätt = fail-open default blir babbla **fortfarande något mer bullrigt** än
Teams/Meet (som kör aggressiv fail-closed-DNN). Det är det **medvetna priset**
för full-duplex-känslan. "Stark" + macOS VI är flyktvägarna för den som vill ha
mer tystnad.

## Arkitektur / inkoppling

- **Ny modul `public/js/mic-pipeline.js`:** tar en rå `MediaStream` + config
  (`{ highpass: true, level: "off"|"lite"|"full" }`) och returnerar en
  **processad** `MediaStream`. Metoder: `rebuild(stream)`, `setConfig(level)`.
  Grafen: `MediaStreamSource → BiquadFilter(HPF) → [worklet om lite/full] →
  MediaStreamDestination`.
- **DSP-kärnan extraheras till en ren modul** (envelope + golv-spårning +
  gain-kurva) som *både* worklet:en och node-testerna importerar — samma mönster
  som `room-name.js` / `stage.js`. Worklet:en blir ett tunt browser-only-skal.
- **Controllern äger en pipeline-instans** för sessionen. `switchMic` och
  deploy-restore anropar `rebuild`; `<select>` → `setNoiseReduction(level)` →
  `pipeline.setConfig` + persist (mirrorar `switchMic`-mönstret).
- **Persistens:** localStorage-nyckel, läses vid init (mirrorar device-prefs).
  localStorage överlever reload, så deploy-restore/reconnect läser bara om — inget
  behov i deploy-restore-snapshoten.
- **`new AudioContext({ latencyHint: "interactive" })`** för minsta render-quantum.

### Rå vs processad ström — ägarskap (kritiskt)

`localStream` är idag den **råa** `getUserMedia`-strömmen och flera vägar läser
den (deviceId, mute-sanning, deploy-restore, self-tile, mesh-fäste). En
`MediaStreamDestination`-ström saknar `deviceId` och har ett eget spår, så vi får
**inte** bara byta `localStream` mot den processade — då tappar `activeMicId()`
mikrofonens deviceId och mute-sanningen (`track.enabled`) hamnar på fel spår.

**Regel:** `localStream` förblir **rå**. Pipelinen håller en **separat**
`processedStream` (utbytt vid `rebuild`). Endast två vägar migreras till den
processade; allt deviceId/mute/restore-arbete bor kvar på `localStream`:

| Väg | Idag | Efter |
| --- | --- | --- |
| `activeMicId()` / deviceId | rå | **rå** (oförändrad) |
| Mute-sanning (`track.enabled`) | rå | **rå** (oförändrad) |
| Deploy-restore-snapshot | rå | **rå** (oförändrad) |
| Reconnect mute-carry | rå | **rå** (oförändrad) |
| `mesh.setLocalAudioStream` | rå | **processad** (rå vid fail-open) |
| `addSelfTile` / `setSelfMicMeter` | rå | **processad** (rå vid fail-open) |

`addSelfTile(id, name, micStream)` skickar strömmen vidare till
`setSelfMicMeter`, så self-metern blir post-processing genom att den matas med
den processade strömmen — den speglar då vad peers faktiskt hör.

### Liveness / fail-open (kritiskt — pipelinen är allas utgående väg)

HPF-grafen är default-på för **alla**, så ett pipeline-fel = peers får **tystnad**.
Det måste vara omöjligt:

- **Registrera pipelinens `AudioContext` i `audioContexts`** och `resume()` den, så
  "aktivera ljud"-knappen (som redan `resume()`:ar alla registrerade kontexter,
  `main.js` rad ~503–507) väcker även den om autoplay-policyn startat den suspended.
- **Fail-open:** om kontexten inte kan köra (förblir suspended),
  `audioWorklet.addModule()` failar, eller worklet:en kastar — **faller mesh:en
  (och self-metern) tillbaka till den råa `getUserMedia`-strömmen** i stället för
  den processade. Hellre oprocessat ljud än tyst. (Om bara worklet:en failar men
  kontexten lever kan HPF-only-grafen användas som mellansteg.)
- **Invariant:** den utgående ljudvägen får **aldrig** vara tyst pga pipelinen.

### Livscykel-edges

- **Mute:** behåll nuvarande mute **oförändrad** — `track.enabled = false` på den
  **råa** micken + `mesh.setLocalAudioMuted` (`replaceTrack(null)`). Det tystar
  pipelinens *källa*, så golvet hålls **inte** varmt; i stället **fryser
  golv-spårningen medan man är mutad** (controllern speglar mute-state till
  pipelinen → ingen adaptering mot tystnad) och återupptas vid unmute från det
  frysta värdet. (Alternativet — hålla spåret enabled och bara skicka null — vore
  fel; det flyttar mute-sanningen som andra vägar läser via `track.enabled`.)
- **Device-switch:** bygg om grafen mot nya källan; golv-spåraren nollställs.
- **Reconnect:** mikrofonen behålls → bygg om grafen; nivån läses från localStorage.
- **CPU:** pipelinen processar **en gång**, oberoende av antal peers (mesh:en får
  samma processade spår) — kostnaden skalar inte med rumstorlek.
- **Skärmdelning:** `audio: false` → ingen interaktion.

## Steg 1 (kollapsat — ingen ny nudge-UI)

- **Log-only:** vid capture, kolla att `track.getSettings()` faktiskt rapporterar
  `echoCancellation/noiseSuppression/autoGainControl: true` (vissa virtuella/
  aggregat-enheter slår tyst av dem). `console.warn` om inte — **ingen UI**
  (`docs/echo-cancellation-step2.md` §2a).
- **macOS VI-modalen behålls som den är** (ingen ny nudge/detektor). VI gick från
  "fixen" till "trevligt extra" eftersom expandern nu sköter "brus när jag inte
  pratar" default-på för alla.
- **Info-modalen auto-visas en gång:** post-join, i det ögonblick den **egna
  mikrofonen blir live** (permission given + capture startad — visas även om man
  är ensam i rummet, eftersom VI gäller den egna micken). Gatas av en global
  "seen"-flagga i localStorage som sätts vid **valfri** öppning (manuell eller
  auto), och **visas inte om på reconnect**. Fullt stängbar (×/backdrop/Esc).
- **VI-sektionen flyttas till andra plats** i modalen (ordning: Webbläsare →
  Voice Isolation → Anslutningsfärger). Den är fortsatt `hidden` utanför macOS, så
  på icke-mac ändras inget synligt.

## Testkrav (alla tre nivåer + mätstickan)

- **Nivå 1 — ren DSP-enhetstest (node):** mot den extraherade DSP-kärnan —
  dämpar en signal under golvet med ~range dB, släpper en signal över tröskel
  ~oförändrad, attack/release-timing, **golv-spåraren rider ett medvetet stigande
  golv** (AGC-interaktionen), och **cold-start = pass-through** (fail-open).
- **Nivå 2 — wiring (node):** pipelinen — `Av` = HPF-only-graf, `Lätt`/`Stark` =
  HPF+expander med rätt parametrar (injicera en fejk-AudioContext/node-factory);
  controllern — `setNoiseReduction` persistar + applicerar, åter-applicerad efter
  reconnect (room-controller-harnessen); info-modal-skript (UA-override, jfr
  `scripts/ios-device-pickers-test.mjs`): auto-visas en gång efter mic-live,
  flaggan dämpar omvisning, VI-sektionen är 2:a på macOS-UA.
- **Nivå 3 — end-to-end-attenuering (puppeteer):** mata en preparerad WAV
  (tyst golv → hög ton → tystnad) via Chrome-flaggan
  `--use-file-for-fake-audio-capture=FIL.wav`, fånga den **processade** utströmmen
  och asserta att golvsegmentets RMS **sjunker** vid `Lätt`/`Stark` men **inte**
  vid `Av`, medan det höga segmentet är ~orört. **Plus ett fail-open-fall:**
  simulera att worklet-laddningen failar och asserta att peers ändå får
  (oprocessat) ljud — aldrig tystnad.
- **Manuellt — mätstickan** (3 personer, riktiga tangentbord/rum): den enda
  perceptuella regressionen — validerar fail-open-känslan och "klippte vi någons
  ord?", vilket inget syntetiskt test fångar.

## Utanför scope (v1)

- **DNN/WASM-brusreducering** (RNNoise/DeepFilterNet) — uppskjuten tills en
  **uppmätt** "tangentbord hörs *medan* jag pratar trots VI"-rapport kvarstår.
  Det är det enda som motiverar dess latens (~15–45 ms), och latens är bortvald.
- **Mottagarsides-processing** (städa andras inkommande ljud) — sämre kvalitet,
  CPU per peer, fel ställe.
- **Ducking** (dämpa egen utgång vid stark fjärrsignal) — risk att döda
  duplex-känslan.
- **Multiband-expander / spektral VAD** — överteknik för v1.
- **Hård noise gate / push-to-talk / talar-gating** — bryter "alla pratar
  samtidigt" (låst beslut).
- **`-6 dB low-shelf @ 140 Hz`** — tonsmak, inte brus; bortvald här.
- **Per-peer-processing** — pipelinen är delad (en gång), inte per anslutning.
