# Plan: "Stör ej" (Do Not Disturb) — full mediaisolering med kvar-i-rummet-närvaro

> **Status:** *planerad, ej byggd.* Design/motivering inför implementation.
> Kommer ur en grillning av förslaget: lägg till en knapp under "Stäng av video
> för mig" med texten **"Stör ej"** och tooltip **"Stanna kvar i rummet, men
> stäng av all inkommande och utgående ljud och bild"**. När läget är aktivt ska
> det **signaleras likt mute-statet** så andra ser att användaren varken hör
> eller ser dem, och **ingen video/ljud/bild ska skickas till** den som aktiverat
> läget.
>
> Den här planen dokumenterar besluten från grillningen (Q1–Q10) och hur de
> mappar mot befintliga sömmar (mute, video-opt-out, video-suppress). Inga
> kodändringar ingår i den här PR:en — bara planen.
>
> **Reviderad efter live-test (byte till full capture-stopp):** efter test i
> riktig browser ändrades en central del av modellen. Ursprungsdesignen **behöll
> mick-capturen** vid liv under DND (bara senders pausades) för iOS-paritet — men
> då lyste OS:ets mick-/kameraindikator kvar och det kändes som övervakning.
> Beslut nu: **all lokal capture (mick + kamera + skärm) stoppas** när DND slås
> på, så inga OS-indikatorer lyser. Micken släpps genom att stoppa det **råa
> getUserMedia-spåret** medan **Web Audio-pipelinen hålls vid liv** (mesh:en
> skickar dess syntetiska destinations-spår → ljud-m-linjerna överlever, en peer
> som joinar under DND får ändå en tyst sender som återupptas vid exit). **Manuell
> återaktivering** som "Stäng av video för mig": vid DND-av återacquireas **micken
> automatiskt** (baslinjen, i pre-DND-mute-läge) medan **kamera + skärm slås på
> manuellt**. Sub-kontrollerna **inaktiveras** under DND (ersätter det tidigare
> "intent-only, klickbara"). Dot-döljningen behövs inte längre (stoppad mick →
> inget utslag). iOS-bakgrunds-keep-alive gäller inte under DND (avsiktligt tyst).
> Detta ersätter besluten Q3 (B → sub-kontroller inaktiveras), Q4 (intent-only →
> full stopp + manuell återaktivering) och gap #5 (behåll capture → stoppa
> capture). Övriga beslut (kooperativ signal, en flagga, replaceTrack-paus,
> måne-badge, presentations-gate, livscykel som mute) står kvar.
>
> **Reviderad efter granskning (tidigare granskning):** granskningen godkände designen och
> bad om **specifikations-skärpning** (inga designvändningar). Inarbetat nedan:
> (1) **union-semantik** för DND-paus vs `pausedVideoPeers` — de får inte
> konkurrera (ny "Paus-mängder: union, inte ersätt"); (2) **lokal
> presentations-gate** som skild från Q1:s kooperativa nätverksmodell (ny "Lokal
> presentations-gate"); (3) **explicit DND-off-reconcile-sekvens** (ordnad lista
> i klientflödet); (4) **kamera-presence-broadcast** vid DND-on/off
> (`camera(false)`/`camera(true)`); (5) **behåll mick-capture, pausa bara
> senders** (iOS/reconnect-paritet); (6) `docs/session-restore.md` + `AGENTS.md`
> tillagda i fillistan. Dessutom utökade edge-cases och testfall.

## Vad vi bygger

**"Stör ej" (DND)** är ett enda **additivt närvaro-överlägg**: användaren är kvar
i rummet men utbyter **ingen media i någon riktning**. Andra ser ett tydligt
märke (måne) på användarens tile/self/scen. Läget är **kooperativt** — peers
hedrar signalen och slutar skicka (ingen lokal inbound-gate i v1) — och är
modellerat nära den befintliga **mute**-mekaniken.

Kort sagt: `DND on` ≈ (egen mick av) + (egen kamera av) + (egen skärmdelning av)
+ (alla peers slutar skicka ljud/kamera/skärm **till** mig) + (måne-badge till
andra), fullt **dubbelriktat**. `DND off` återställer det underliggande
tillståndet.

## Bakgrund: sömmarna vi bygger på

| Mekanism | MSG | Serverstate | Mesh-effekt | Livscykel |
| --- | --- | --- | --- | --- |
| **Mute** | `MSG.MUTE` | `mutedPeers` Set, i `welcome`, broadcast till *andra* | `replaceTrack(null)` på audio-senders (`setLocalAudioMuted`) | Återannonseras vid reconnect; nollas vid leave |
| **Video-opt-out** ("Stäng av video för mig") | `MSG.VIDEO_OPT_OUT` | `videoOptOuts` Set, i `welcome`, broadcast till **alla** | Peers slutar skicka **kamera** via `cameraSendToFilter` → `removeTrack` (omförhandling) | Persistent `localStorage`-pref |
| **Video-suppress** (helskärm-bandbredd) | `MSG.VIDEO_SUPPRESS` | *ingen* (ren relä) | Ägaren pausar kamera+skärm mot **en** tittare via `replaceTrack(null)` (`setVideoPausedPeers` / `applyVideoPauseForPeer`) | Härleds ur scenens fokus |

Nyckelgap i dag: **ljud går alltid till alla** — det finns ingen per-peer
ljud-suppression, och ingen mekanism för att stoppa **inkommande** media. DND
inför det (som en generalisering av `video-suppress` till att även omfatta ljud).

Relevanta befintliga anchor-punkter:

- `public/js/protocol.js` — `MSG`-konstanterna (lägg till `DND`).
- `room.js` — `mutedPeers`/`videoOptOuts` Set, `mute()`/`videoOptOut()`,
  `welcome`-roster (rad ~57–70), cleanup i `remove()` (rad ~80–96).
- `public/js/mesh.js` — `setVideoPausedPeers`/`applyVideoPauseForPeer`
  (rad ~316–346), `desiredCameraTrackFor`/`desiredScreenTrackFor`,
  `setLocalAudioMuted`/`applyAudioMuteForPeer`, `attachLocalTracks` (rad ~352–).
- `public/js/room-controller.js` — `toggleMute`, `toggleVideoOptOut`,
  `handleMute`/`handleVideoOptOut`, `reconcileVideoSuppression`/
  `handleVideoSuppress`, `processWelcome` (roster-applicering + mute-
  återannonsering), deploy-restore-snapshot.
- `public/js/main.js` — `MIC_OFF_SVG` + badge-render (`setPeerMuted`,
  `updateStageMute`, `createTile`), chimes (join/leave-toner), `setVideoOffButton`
  /`setVideoOptOutUi`, knapp-wiring.
- `public/index.html` — `#video-off-btn` i `.controls` (rad ~397); badge-span
  `#screen-mute` (rad ~62).
- `public/style.css` — `.video-off`, `.screen-mute`, `.tile-mute`/`.is-muted`.

## Låsta beslut (från grillningen)

| # | Beslut | Varför | Fråga |
| --- | --- | --- | --- |
| 1 | **Kooperativ signal ensam** — ingen lokal inbound-gate i v1. Peers slutar skicka till DND-användaren; om problem dyker upp senare kan en inbound-gate läggas till. | Matchar hur video-opt-out fungerar i dag; minst kod. Risk: en peer på gammal kod / mitt i reconnect / i propageringsglappet kan kortvarigt skicka frames. Accepterat. | Q1 |
| 2 | **En enda `MSG.DND`-flagga (A)**, inte tre komponerade opt-outs. | Mappar 1:1 mot mute-mönstret; badgen härleds trivialt; undviker att tangla ihop med den fristående video-opt-out-knappen. | Q2 |
| 3 | **Sub-kontrollerna förblir aktiva (klickbara) under DND (B)**. | Produktval: knapparna greyas inte ut. Konsekvens: implementeras som **härlett överlägg** (aldrig snapshot/mutation av underliggande state). | Q3 |
| 4 | **Intent-only (A)** när man togglar kamera/mick *på* under DND. | Ingen `getUserMedia`, ingen self-preview, ingen hårdvara startas, ingen presence-broadcast. Undviker meningslös kamera-LED, kringgår kamerataket och skärmdelningens gesture-krav. Applicera intenten vid DND-off. | Q4 |
| 5 | **Måne-glyf**, på **tile + self-tile + scen**, och **DND ersätter mute-badgen** (bara månen, aldrig mick-slash). | Månen är den universella DND-konventionen (iOS/Android/Slack); DND är det starkare, mer informativa tillståndet. | Q5 |
| 6 | **Lokal upplevelse:** behåll rummet läsbart med **namn-tiles (dimmade)** + levande presence, en liten kvarstående "Stör ej är på"-hint, egen måne-badge; knappen flippar till **"Avsluta Stör ej"** (`aria-pressed="true"`). Ingen heltäckande blackout-overlay. | Användaren valde *att stanna i rummet*, så hen vill fortfarande se vilka som är där och återvända med ett klick. | Q6 |
| 7 | **Livscykel = som mute:** persist + **återannonsera vid WS-reconnect**; **inkludera `dnd` i deploy-restore-snapshoten**; **nollställ vid leave-to-landing**; **ingen** cross-room `localStorage`. | DND är ett transient "jag har klivit undan från *det här* samtalet". Reconnect/deploy är ofrivilliga avbrott (kontinuitet förväntas); att lämna och gå till ett nytt rum är återengagemang (starta friskt). | Q7 |
| 8 | **Tysta chimes (A)** medan DND är på (join/leave-toner). | Läget är bokstavligen "stör ej"; en ljudande ping motsäger det. Visuell presence behålls. | Q8 |
| 9 | **`replaceTrack(null)`-paus (B)** för alla tre medietyper i båda riktningarna, byggt på `setVideoPausedPeers`-sömmen generaliserad till ljud. | Direkt, omförhandlingsfritt; undviker glare/`setParameters`-race/async-gap-buggar som `removeTrack`-omförhandling skulle sprida över hela meshen (särskilt på ljudvägen) vid varje toggle. Bandbredden faller till keepalive-nivå (inte fullt rivet spår), acceptabelt givet beslut 1. | Q9 |
| 10 | **Testplan i tre lager** (server-state, wiring-rail, dedikerad e2e). | Följer husets testkonvention; e2e-media-vägen (media stoppas + återupptas i båda riktningar) är must-have eftersom DND rör kärnljudvägen. | Q10 |

## Signalprotokoll

Ny konstant i `public/js/protocol.js`:

```
DND: "dnd",
```

- **Klient → server:** `{ type: "dnd", on: boolean }`.
- **Server → klient:** `{ type: "dnd", id: <fromId>, on: boolean }`.

Serverlogik i `room.js`, spegling av `mute()` men **broadcast till alla**
(nykomlingar och den som togglar ska konvergera på samma bild — mer likt
`videoOptOut()` än `mute()`):

```
const dndPeers = new Set();

function dnd(fromId, on) {
  if (!peers.has(fromId)) return [];
  if (on) {
    if (dndPeers.has(fromId)) return [];
    dndPeers.add(fromId);
  } else if (!dndPeers.delete(fromId)) {
    return [];
  }
  return [{ to: all(), msg: { type: MSG.DND, id: fromId, on: !!on } }];
}
```

- `welcome` får `dnd: [...dndPeers]` (invid `muted`/`videoOptOuts`).
- `remove()` gör `dndPeers.delete(id)` (tyst; `peer-left` städar tilen).
- `server.js` får en `case MSG.DND` i dispatchen (flush av effekterna, ev.
  `stats.event`).

## Mesh-mekanism (`public/js/mesh.js`)

Generalisera pausen till att omfatta **ljud** och att drivas av en **DND-riktad**
peer-mängd, separat från den fokus-drivna `pausedVideoPeers` (så de två
källorna inte trampar på varann):

- Inför en per-peer **ljudpaus** analogt med video: `desiredAudioTrackFor(peerId)`
  returnerar `null` när peern ska tystas, annars mick-spåret; `applyAudioMuteForPeer`
  (finns för global mute) utökas/kompletteras så den även respekterar en
  per-peer-paus. Effektiv "skicka ljud till peer X" = `!globalMute && !pausedFor(X)`.
- Utöka `desiredCameraTrackFor`/`desiredScreenTrackFor` att också returnera `null`
  när peern är i DND-paus-mängden.
- Ny publik setter, t.ex. `setPeersReceivingNothing(Set)` (eller
  `setDndBlockedPeers`), som pausar **audio + kamera + skärm** per peer via
  `replaceTrack(null)` och återupptar via `replaceTrack(track)` — samma
  fire-and-forget-`.catch`-stil som `setVideoPausedPeers`.
- `attachLocalTracks` hedrar den aktuella paus-mängden för en peer som ansluter
  medan pausen är aktiv (analogt med `if (localAudioMuted) replaceTrack(null)`).

### Paus-mängder: union, inte ersätt (högsta integrationsrisken)

DND-pausen och den fokus-drivna `video-suppress`-pausen är **två oberoende
källor** till samma per-peer-effekt. I dag *ersätter* `handleVideoSuppress` hela
mängden:

```
function handleVideoSuppress(id, on) {   // nuvarande kod
  if (on) suppressViewers.add(id); else suppressViewers.delete(id);
  mesh?.setVideoPausedPeers(suppressViewers);   // skriver över allt
}
```

Om DND skrev till samma `pausedVideoPeers` skulle de två **stampa på varann**
(helskärms-pin och DND släcker varandras paus). Regeln måste vara en **union**,
inte ett ersättande. Två godtagbara implementationer:

1. **Två mängder, härledd effektiv paus:** behåll `pausedVideoPeers` (fokus) och
   inför `dndBlockedPeers` (DND-riktad). `desiredCameraTrackFor` /
   `desiredScreenTrackFor` / nya `desiredAudioTrackFor` kollar **båda** (logiskt
   OR). Explicit regel:

   > **Effektiv paus för peer P** = `P ∈ pausedVideoPeers` **ELLER**
   > `P ∈ dndBlockedPeers` **ELLER** `myDnd` (eget DND ⇒ alla peers).
   >
   > För **ljud** gäller dessutom global mute: skicka ljud till P endast om
   > `!localAudioMuted && !effektivPaus(P)`. (`video-suppress` rör aldrig ljud —
   > bara DND och global mute gör det.)

2. **En intern union-setter:** meshen exponerar separata settrar
   (`setVideoPausedPeers` för fokus, ny `setDndBlockedPeers` för DND) och slår
   ihop dem internt till den effektiva mängd som `applyVideoPauseForPeer`/
   ljudmotsvarigheten läser. Ingen anropare får skriva över den andras bidrag.

**Rekommendation:** alternativ 1 (två namngivna mängder + OR i `desired*Track`),
tydligast att testa och att resonera om. `applyVideoPauseForPeer` (och en
ljudmotsvarighet) reconcilerar mot den effektiva mängden; anropas när **endera**
källan ändras.

### Behåll mick-capture — pausa bara senders (iOS/reconnect-paritet)

DND pausar **senders** (`replaceTrack(null)`), **inte** `localStream`-capturen.
Stoppa aldrig mick-spåret vid DND — det skulle bryta (a) iOS VoIP-liknande
bakgrunds-keep-alive (dokumenterat i `AGENTS.md`: en aktiv mick-capture håller
WebKit-fliken vid liv) och (b) reconnect/deploy-restore-vägarna som behåller
micken över WS-tapp. Speglar exakt mute: `replaceTrack(null)` utgående, capturen
rullar vidare. Kameran är ett annat fall (den *stängs* vid DND-on, precis som en
vanlig "stäng av kamera", och åter-acquireas vid DND-off om intent är armad — se
klientflödet).

**Två riktningar, samma söm:**

1. **Andra peers → DND-användaren (inkommande):** när peer X ser att en peer är i
   DND lägger X den peern i sin paus-mängd → X pausar sina audio/kamera/skärm-
   senders mot DND-användaren. (Detta är den kooperativa signalen ur beslut 1.)
2. **DND-användaren → alla (utgående):** DND-användaren pausar **alla sina egna**
   senders mot **alla** peers. (Så andra får inget från DND-användaren; deras
   tile för DND-användaren blir namn + måne.)

## Lokal presentations-gate (ej protokoll-gate)

Beslut 1 (Q1) skjuter medvetet upp en **nätverks**-inbound-gate: vi litar på att
peers slutar skicka. Men beslut 6 (Q6) lovar att DND-användaren lokalt varken
**hör eller ser** andra — och tills alla peers hunnit hedra flaggan
(propageringsglapp, reconnect-race, gammal klient) kan frames fortfarande komma
in. Utan en lokal gate skulle DND kortvarigt kunna låta/se aktivt trots
efterlevnad. Det underminerar funktionen mer än den *nätverks*-risk Q1
accepterade.

Därför: en **presentations-lager-gate** i view/controllern (skild från
mesh-lagrets kooperativa modell). Medan `myDnd` är sant:

- **Ljud:** gate `onAudioTrack` → `ui.setPeerAudio` så inkommande audio inte
  attachas/spelas (eller pausa/`muted` på `<audio>`-elementen i `#audio-sink`).
- **Video:** bind inte inkommande kamera/skärm till tiles/scen (samma anda som
  `clearIncomingCameras`, men för **all** media). Reclassify får inte återställa
  strömmar medan DND är på.
- **Indikatorer:** stäng av talar-/volymindikatorer och liknande härledningar av
  inkommande ljud.

Vid DND-off häver gaten: attacha inkommande igen (nästa `track`/reclassify-pass
speglar rummet på nytt). Detta är **inte** samma sak som den skippade
nätverks-inbound-gaten — den lokala gaten stoppar *rendering/uppspelning*, inte
mottagandet av RTP. (En framtida nätverks-gate skulle vara additiv ovanpå denna.)

## Klientflöde (`public/js/room-controller.js`)

**`toggleDnd()`** (spegling av `toggleMute`/`toggleVideoOptOut`):

- Flippa `myDnd`.
- `signaling.dnd(myDnd)`.
- `ui.setDndUi(myDnd)` (knapp-flip, self-badge, dimning/hint).
- Driv mesh + presence (se de två ordnade sekvenserna nedan).

### DND-on-sekvens (ordnad)

1. `myDnd = true`; `signaling.dnd(true)`; `ui.setDndUi(true)`.
2. Pausa alla **egna** utgående senders mot alla (`replaceTrack(null)` för
   audio+kamera+skärm) — men **behåll mick-capturen** (se mesh-noten).
3. **Kamera-presence:** om lokal kamera var på → `signaling.camera(false)` **och**
   stäng lokal kamera-capture. *Utan* detta stannar `camerasOn`-rostern på och
   andra visar en spök-kamera-tile utan ström (fel ihop med måne-berättelsen).
   Rör **inte** `myVideoOptOut`-intentet (beslut 3).
4. **Skärm-presence:** om användaren var `currentSharer` → `signaling.share(false)`
   + stäng lokal skärmström.
5. Aktivera den **lokala presentations-gaten** (sluta rendera/spela inkommande).
6. Peers slutar skicka **till** mig när de ser flaggan (kooperativt, beslut 1).

Notera att steg 2–4 **inte** muterar de underliggande intent-flaggorna (mute-
intent = `track.enabled`, kamera-intent, `myVideoOptOut`). De läses vid off.

### DND-off-reconcile-sekvens (ordnad — trickigaste delen)

Kör **en** reconcile-pass i den här ordningen (spegling av hur `processWelcome`
återställer state efter en reconnect):

1. `myDnd = false`; `signaling.dnd(false)`; `ui.setDndUi(false)`.
2. Häv den **lokala presentations-gaten** (attacha inkommande igen).
3. Häv egen utgående paus i meshen (`replaceTrack(originalTrack)` där tracket
   finns).
4. **Ljud:** `mesh.setLocalAudioMuted(currentMicMuted())` — dvs applicera
   mute-*intentet*; `signaling.mute(currentMicMuted())` bara om värdet skiljer
   sig från vad servern senast fick.
5. **Video-opt-out:** kör opt-out-logiken igen från `myVideoOptOut` (persistent
   pref överlevde DND) — inklusive `signaling.videoOptOut(myVideoOptOut)` och
   `cameraSendToFilter` — **innan** kameran åter-acquireas, så en opt-out-peer
   inte kortvarigt får kamera.
6. **Kamera:** om kamera-intent är armad *och* `!myVideoOptOut` → åter-acquire
   (`getUserMedia`) och `signaling.camera(true)` (gäller kamerataket max 6 →
   `CAMERA_LIMIT` som vanligt om det slår i taket).
7. **Skärmdelning: ingen auto-resume** — `getDisplayMedia` kräver ny
   användargest; användaren får klicka "Dela skärm" igen.

**Intent-lagringen** som gör detta möjligt: mute-intent = mick-spårets
`track.enabled`; kamera-intent = en boolean som `toggleCamera` sätter även under
DND (utan capture); `myVideoOptOut` = befintlig flagga/pref. DND läser dem, äger
dem aldrig.

**Inkommande DND från peer** (`handleDnd(id, on)`): lägg/ta bort `id` i en lokal
`dndPeers`-mängd; uppdatera den peerns paus (så jag slutar skicka till hen) och
`ui.setPeerDnd(id, on)` (måne-badge, subsumera mute-badge). `applyFocusView()`.

**Intent-only under DND (beslut 4):** medan `myDnd` är sant ska `toggleMute`,
`toggleCamera`, `toggleShare`, `toggleVideoOptOut` **bara uppdatera
underliggande intent + lokal knapp-UI** — ingen `getUserMedia`/`getDisplayMedia`,
ingen presence-broadcast, ingen mediaförändring mot peers. Vid `off` appliceras
och (åter)annonseras intenten (utom skärm).

**`welcome`-applicering** (`processWelcome`): `for (const id of msg.dnd || [])
handleDnd(id, true)`. Om `myDnd` fortfarande är sant efter en reconnect:
`signaling.dnd(true)` (spegling av mute-återannonseringen).

**Härlett överlägg, ej snapshot (beslut 3):** DND muterar aldrig `muted` /
`videoOptOut` / kamera-state. Effektiv utgående/inkommande media = `myDnd ?
allt-av : underliggande`. När DND släpps återuppstår det underliggande av sig
självt. (Sub-kontrollerna är klickbara men verkar via *intent* under DND, så
underliggande state kan ändras utan att läcka media förrän DND-off.)

## Livscykel (beslut 7)

- **WS-reconnect:** `myDnd` behålls i sessionen; återannonseras på färska
  `welcome`. Egna senders är ändå pausade; nya peers hedrar flaggan via rostern.
- **Deploy-restore:** lägg `dnd` i sessionStorage-snapshoten (invid
  mute/kamera/skärm/enheter); återställ `myDnd` efter reload + auto-join.
- **Leave-to-landing:** `resetFreshSessionState` nollar `myDnd` (som mute).
  **Ingen** `localStorage`-pref (till skillnad från video-opt-out).

## UI, badge & lokal upplevelse

- **Knapp:** ny textknapp direkt under `#video-off-btn` i `public/index.html`,
  text **"Stör ej"**, `title="Stanna kvar i rummet, men stäng av all inkommande
  och utgående ljud och bild"`, `aria-pressed="false"`, stil som `.video-off`.
  Aktiv → text **"Avsluta Stör ej"**, `aria-pressed="true"`, distinkt aktiv-stil.
- **Badge:** ny inline-SVG `MOON_SVG` (inga binära assets, som `MIC_OFF_SVG`), på
  tile + self-tile + scen. `setPeerDnd`/`updateStageDnd` speglar
  `setPeerMuted`/`updateStageMute`. **Subsumering:** när en peer är i DND visas
  **bara** månen; mick-slash-badgen döljs för den peern (även på egen self-tile).
- **Lokal vy:** dimma deltagar-tiles (namn-only, ingen inkommande A/V), visa en
  liten kvarstående "Stör ej är på"-hint. Behåll presence (namn/antal/join-leave
  kommer via signaling, oberoende av media).
- **Chimes:** gate join/leave-tonerna på `!myDnd`.

## Edge cases (härledda, inga nya beslut)

- **DND-användaren delade skärm** → delningen avslutas vid DND-on
  (`currentSharer` frigörs, `sharer`-broadcast); återupptas **inte** automatiskt
  vid DND-off (gesture-krav).
- **Någon annan delar skärm** när jag går in i DND → delningen blir blank för
  mig; återkommer vid DND-off (symmetrisk paus hos delaren när min flagga släpps).
- **Kameratak (max 6)** vid DND-off med armad kamera → vanliga
  `camera`/`CAMERA_LIMIT`-logiken gäller som annars.
- **DND + underliggande mute** → bara måne visas (subsumering); vid DND-off
  återställs mick-slash-badgen om mute-intentet är sant (reconcile-steg 4).
- **DND + `videoOptOut`-pref** → opt-outen består (persistent pref); vid DND-off
  måste reconcile köra opt-out-logiken (steg 5) **före** kamera-återstart, annars
  kan en opt-out-peer kortvarigt få kamera.
- **Peer i DND medan jag har hen helskärms-pinnad** → union av paus-mängderna:
  `video-suppress` **och** DND båda sanna ⇒ fortsatt pausad; att endera släpps
  får inte av misstag återuppta den andra (se "Paus-mängder: union, inte ersätt").
- **Chimes** → gate på `!myDnd`. Gör det på **ett** ställe: centralisera i den
  gemensamma chime-hjälparen (`playChime`/motsv.) i stället för att strö
  `!myDnd`-villkor på varje join/leave/`removeParticipant`-väg, så ingen väg
  glöms.
- **Bandbreddsmätaren** faller mot ~0 inkommande under DND (keepalive-nivå p.g.a.
  `replaceTrack(null)`), stiger igen vid DND-off. Endast observation.

## Test (beslut 10)

1. **Server-statemaskin** (`test/room.test.js`, ren Node): `dnd()` broadcastar
   till alla, `welcome` bär `dnd`-rostern, no-op-gating (re-DND spammar inte),
   `remove()` städar flaggan.
2. **Wiring-rail** (`test/room-controller.test.js`, fake mesh/signaling/ui):
   `toggleDnd` signalerar + driver mesh-pausen i båda riktningar; inkommande DND
   togglar peerns måne-badge; `welcome` applicerar `dnd`-peers; reconnect
   återannonserar DND; deploy-restore återställer DND; sub-kontroll-toggles under
   DND är **intent-only** (ingen `getUserMedia`, ingen presence-broadcast) och
   appliceras/reconcileras vid DND-off; chimes tystade under DND. Dessutom:
   - **DND + video-suppress-interaktion:** en helskärms-pin som sätter
     `video-suppress` bryts inte när endera parten togglar DND (union-mängderna,
     inte ersättning) — pausen består så länge *någon* källa vill pausa.
   - **DND-on rensar kamera-presence:** `toggleDnd(true)` med armad/på kamera
     ger `signaling.camera(false)` (rostern rensas, ingen spök-kamera-tile);
     `toggleDnd(false)` ger `signaling.camera(true)` bara om intent är armad
     och `!myVideoOptOut`.
   - **DND-off-reconcile-ordning:** opt-out-logiken körs före kamera-återstart
     (steg 5 → 6), och mute-intentet speglas via `setLocalAudioMuted`.
3. **E2E puppeteer** (ny `scripts/dnd-test.mjs`, två separata browser-instanser,
   fake media, isolerat rum, inlagd i `scripts/e2e.mjs`): måne-badge på
   tile/self/scen; inkommande audio-element + video borta på DND-sidan och
   senders pausade; sen joinare ser DND ur `welcome`-rostern; DND-off återställer
   media i båda riktningar. **Instrumentera senders** (hooka
   `RTCRtpSender.replaceTrack` / läs `getParameters`) i stället för att bara läsa
   DOM — samma mönster som `scripts/baseline-camera-bitrate-test.mjs` — så
   media-vägs-testet inte kan bli falskt negativt (assertera att pausen faktiskt
   applicerades, inte bara att en badge dök upp).

Dessutom: `npm test` + `npm run e2e` gröna; kör om **mätstickan** (3 personer,
riktig media) som regressionskoll före deploy eftersom detta rör kärnljudvägen.

## Filer som sannolikt ändras (vid implementation)

- `public/js/protocol.js` — `MSG.DND`.
- `room.js` — `dndPeers`, `dnd()`, `welcome.dnd`, cleanup i `remove()`.
- `server.js` — `case MSG.DND` i dispatchen.
- `public/js/signaling.js` — `dnd: (on) => send({ type: MSG.DND, on })`.
- `public/js/mesh.js` — per-peer ljudpaus (`desiredAudioTrackFor`) +
  `dndBlockedPeers`-mängd med **union** mot `pausedVideoPeers` i `desired*Track`,
  ny `setDndBlockedPeers`, `attachLocalTracks`-hedring. **Rör inte** capturen.
- `public/js/room-controller.js` — `toggleDnd`, `handleDnd`, intent-only-gating,
  DND-on/off-reconcile-sekvenserna, kamera-presence-broadcast, lokal
  presentations-gate, `processWelcome`-applicering + återannonsering, snapshot.
- `public/js/main.js` — `MOON_SVG`, `setDndUi`/`setPeerDnd`/`updateStageDnd`,
  badge-subsumering, knapp-wiring, **centraliserad** chime-gating, dimning/hint,
  presentations-gate i view-lagret (inkommande audio/video + talarindikatorer).
- `public/index.html` — DND-knapp + badge-span(ar).
- `public/style.css` — DND-knapp aktiv-stil, måne-badge, dimmad-tiles/hint.
- `test/room.test.js`, `test/room-controller.test.js`, `scripts/dnd-test.mjs`,
  `scripts/e2e.mjs`.
- **Docs (husets konvention efter en funktion):** `docs/session-restore.md` (nytt
  `dnd`-snapshot-fält) och `AGENTS.md` (status-sektionen).

## Mindre noteringar (från granskningen)

- **Symbolnamn > radnummer:** radankarna i "Relevanta befintliga anchor-punkter"
  ovan (`rad ~57–70` m.fl.) driver med tiden. De är ok i ett plandokument, men i
  själva implementations-PR:en bör referenser göras på **symbolnamn** (funktioner/
  `MSG`-nycklar/CSS-selektorer), inte radnummer.
- **`stats.event`-namngivning:** `case MSG.DND` bör följa befintlig
  mute/kamera-namnkonvention för stats-eventet (t.ex. `dnd`/`undnd` i paritet med
  `mute`/`unmute`).
- **v1 utan helskärms-DND** är rimligt och konsekvent med var `#video-off-btn`
  bor (sidopanelen).

## Ej i scope (v1)

- **Lokal inbound-gate** (hård garanti oberoende av peer-efterlevnad) — medvetet
  utelämnad (beslut 1); läggs till om kooperativ signal visar sig otillräcklig.
- **Fullt `removeTrack`-rivning** av spår mot DND-peers — vi pausar
  (`replaceTrack(null)`) i stället (beslut 9).
- **Cross-room-persistens** av DND (ingen `localStorage`) — beslut 7.
- **DND-knapp i helskärmskontrollerna** — v1 håller den i sidopanelen, som den
  befintliga "Stäng av video för mig"-knappen.
