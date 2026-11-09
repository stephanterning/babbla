# Plan: "Systemstandard (<enhet>)" som följer OS-defaulten live

> **Status:** *planerad, ej byggd.* Design/motivering inför implementation.
> Kommer ur en diskussion om varför babbla har en "Systemstandard"-rad på
> **högtalaren** men inte på **mikrofonen**, jämfört med hur Slack (default på
> båda) och Teams (default på ingen) gör. Beslut: gå symmetriskt mot Slack-
> modellen och dessutom **skriva ut vilken fysisk enhet defaulten pekar på just
> nu** ("Systemstandard (AirPods)") och **uppdatera den automatiskt** när
> OS-defaulten byts.
>
> **Reviderad efter granskning (tidigare granskning):** två fynd inarbetade — (High)
> deploy-restore måste **bevara `"default"`-intentet** (snapshot:ade annars ett
> konkret id → intentet tappades vid restore), nu **beslut 9**; (Medium)
> mick-pickerns **synlighet** kontra den nya sentinel-raden, nu **beslut 10**.
> Granskningens öppna frågor besvaras i "Svar på granskningens öppna frågor".

## Vad vi bygger

Två saker, i samma PR men med olika risknivå:

1. **Högtalaren (säker, omedelbar):** den befintliga `Systemstandard`-raden får
   ett **resolvat enhetsnamn**: `Systemstandard (AirPods)`. Ljudet följer redan
   OS-defaulten live via `setSinkId("")`; det enda nya är att *etiketten* visar
   och uppdaterar vilken enhet defaulten är.
2. **Mikrofonen (ny rad, en sak att verifiera):** lägg till en motsvarande
   `Systemstandard (AirPods)`-rad som **genuint följer** OS-defaulten live
   (capture av den virtuella `"default"`-enheten), med intent-spegling så valet
   fastnar och med self-healing av etiketten.

Allt gäller **bara desktop-Chromium** — mick/högtalarväljarna är redan dolda på
iOS (`isIOS`-gaten i `populateDevices`), och både `setSinkId` och den virtuella
`"default"`-enheten finns bara där väljarna visas. Ingen iOS-påverkan.

## Bakgrund: varför asymmetrin finns idag

- **Högtalare = `setSinkId("")`.** Tom sträng är ett native sentinel för "följ
  OS:ets standardutgång" och används dessutom som fallback när en vald enhet
  försvinner (`setAudioOutput` → `els.speakerSelect.value = ""`). Därför finns en
  `Systemstandard`-rad med `value=""` (`populateSpeakerSelect`).
- **Mikrofon = `getUserMedia`.** babbla **strippar** Chromes virtuella
  `"default"`/`"communications"`-enheter (`isSelectableDevice`) så dropdownen
  mappar 1:1 mot fysiska enheter. Fresh join fångar utan deviceId → OS-defaulten
  väljs *en gång* och pinnas till en konkret enhet (`activeMicId()` =
  `getSettings().deviceId`). Ingen synlig "Systemstandard"-rad, ingen live-
  följning.

Konsekvens: högtalaren följer defaulten live, micken "väljer default en gång och
pinnar". Det är inkonsekvensen den här planen rättar.

## Hur vi tar reda på *vilken* enhet som är default just nu

OS-defaulten dyker upp i `enumerateDevices()` som en **virtuell post**
(`deviceId === "default"`) vars `groupId` matchar den konkreta enhet den pekar på
just nu. Resolvern (körs på den **råa**, ofiltrerade enhetslistan — `refreshDeviceList`
filtrerar i dag bort `"default"` innan den når vyn):

```
function resolveSystemDefaultName(devices, kind):
  def = devices.find(d => d.kind === kind && d.deviceId === "default")
  if !def: return null
  sibling = devices.find(d =>
    d.kind === kind && d.groupId && d.groupId === def.groupId &&
    d.deviceId !== "default" && d.deviceId !== "communications")
  return sibling?.label || stripDefaultPrefix(def.label) || null
```

- `stripDefaultPrefix`: ta bort ett ledande `"Default - "`/`"Default – "` ur
  default-postens egen label (Chrome-format) som fallback om syskonet inte hittas.
- Saknas labels (ingen mick-permission) → `null` → raden visar bara
  `Systemstandard` (i rummet har vi alltid permission, så namnet finns där).
- **`"communications"` (Windows):** vi följer den **allmänna** `"default"`-enheten,
  inte Windows VoIP-`"communications"`-defaulten, för enkel cross-platform-
  konsekvens. Ev. framtida förfining (voice-appar kan föredra `communications` på
  Windows) noteras men byggs inte nu.

## Auto-uppdatering när OS-defaulten byts

- **Primär trigger finns redan:** `devicechange` → `controller.refreshDevices()`
  (i `main.js`, gated på `!els.roomView.hidden`). Om resolvern körs inne i
  `refreshDeviceList`/`populateDevices` repaintas "Systemstandard (X)"
  automatiskt vid varje enhetsändring — **ingen ny event-wiring**.
- **Self-heal (sekundär):** re-resolva när dropdownen *öppnas* (`mousedown`/`focus`
  på mick-/högtalar-`<select>`) så en eventuellt missad event läker vid nästa
  interaktion. Best-effort, låg risk.
- **Säkerhetsegenskap:** även om en label hinner bli inaktuell är **routningen
  ändå korrekt** — `setSinkId("")` (högtalare) och `"default"`-capture (mick)
  följer OS-defaulten oavsett om etiketten hann repaintas. Värsta fel = kosmetiskt
  inaktuellt namn, aldrig fel enhet.

## Låsta beslut (med motivering)

| # | Beslut | Varför | Bortvalt |
| --- | --- | --- | --- |
| 1 | **Gå symmetriskt mot Slack-modellen** (Systemstandard på *både* mick och högtalare) | Ingen mogen app är asymmetrisk: Slack = båda, Teams = ingen. Symmetri är normen. Default-följning är dessutom **mer robust** — när AirPods/headset kopplas ur mitt i ett samtal följer defaulten automatiskt till nästa enhet i stället för tystnad (#1 verkliga strulkällan på Mac). | Teams-modellen (ta bort från högtalaren) = funktionsregression + bryter `""`-fallbacken. Behåll-asymmetrin = UX-inkonsekvens. |
| 2 | **Skriv ut resolvat enhetsnamn** i raden: `Systemstandard (AirPods)` | Beställarkravet. Resolvas via `groupId`-matchning mot den virtuella `"default"`-posten. | Bara generiskt "Systemstandard" (säger inte vad det är). |
| 3 | **Resolva ur den råa enhetslistan** och tråda namnet till vyn | `isSelectableDevice` slänger `"default"`-posten innan vyn ser den; vi måste beräkna namnet *före* filtreringen och skicka `speakerDefaultName`/`micDefaultName` separat. Den konkreta 1:1-listan förblir orörd. | Parsa labels i vyn (vyn ser inte default-posten). |
| 4 | **Högtalaren: behåll `value=""`**, ändra bara *texten* | `setSinkId("")` följer redan live och är den enda garanterat giltiga fallbacken (testad). Vi rör inte routningen, bara etiketten. **Säker, omedelbar del.** | Byta value till `"default"` (rör testad routning i onödan). |
| 5 | **Micken: capture av virtuella `"default"`-enheten** (`deviceId:{exact:"default"}`) för **äkta live-följning** | Bara så följer mick-spåret OS-defaulten live (paritet med högtalaren). En no-deviceId-capture pinnar en konkret enhet och följer *inte*. | No-deviceId (= "välj default en gång", ingen följning — beställaren vill ha följning). |
| 6 | **Intent-spegling, inte `getSettings()`-härledd selektion** | `getSettings().deviceId` kan rapportera det *konkreta* id:t även för default-capture (versions-/plattformsberoende). Spegla i stället intentet `preferredMicId === "default"` (precis som högtalarens `preferredSpeakerId === ""`), så raden fastnar oavsett `getSettings`. | Lita på `getSettings()` (skört — raden kan hoppa till den konkreta enheten). |
| 7 | **Behåll både följ-raden och de konkreta enheterna** (Slack-likt) | Följ-default och pinna-konkret är **semantiskt olika** och båda önskade. Parentesen (`Systemstandard (AirPods)` vs `AirPods`) disambiguerar. (Detta korrigerar en tidigare tanke om att "deduppa bort dubbletten" — dubbletten är meningsfull, inte brus.) | Dölja den default-konkreta enheten (listan muterar när defaulten byts; går inte att pinna nuvarande default-enhet explicit). |
| 8 | **Self-heal på dropdown-öppning** utöver `devicechange` | Robust mot en ev. missad `devicechange` vid rent default-byte. Billig, best-effort. | Bara `devicechange` (kan i värsta fall lämna inaktuell *label* tills nästa enhetsändring — ofarligt för ljudet men fult). |
| 9 | **Deploy-restore bevarar `"default"`-intentet** — snapshot:ar `"default"`, inte det resolvade konkreta id:t (granskning, High) | `captureDeployRestoreState` snapshot:ar idag `activeMicId() \|\| preferredMicId` (`room-controller.js:405`), vilket serialiserar ett **konkret** id även när intentet är "följ default" → efter restore återställs konkret (`:1366`) och intentet tappas tyst. Bryter beslut 6 ("valet ska fastna"). Restore-sidan funkar oförändrad när snapshot:en bär `"default"`. | Degradera till konkret mick efter restore (tyst intentförlust). |
| 10 | **Mick-pickerns synlighet speglar högtalaren: baseras på antal *konkreta* enheter** (`mics.length < 2`); sentinel-raden tvingar inte fram den (granskning, Medium) | Högtalar-pickern göms redan vid `speakers.length < 2` **trots** sin "Systemstandard"-rad (`main.js:2072`) — en användare med 1 utgång ser ingen högtalar-picker. Mick speglar det. Med exakt 1 mick är "Systemstandard (X)" och "X" **samma fysiska enhet** → en väljare mellan dem är brus; skillnaden materialiseras först vid ≥2 konkreta mickar (då pickern ändå visas). | Visa pickern vid ≥2 *optioner* (konkret + sentinel) → laptop-användare får plötsligt en mick-väljare med två snarlika rader, och det blir inkonsekvent mot högtalaren om man inte ändrar båda. |

### Svar på granskningens öppna frågor

- **"Visa mick-pickern vid exakt 1 fysisk mick + sentinel?"** → **Nej** (beslut
  10). Spegla högtalaren: göm vid `<2 konkreta` mickar. I 1-mick-fallet är de två
  raderna samma fysiska enhet; skillnaden (följ vs pinna) materialiseras först när
  en andra mick dyker upp — och då visas pickern automatiskt. Den enda förlusten
  är att man inte hinner *opt-in:a* "följ default" i exakt det ögonblick en andra
  enhet pluggas in (= dagens beteende, micken byter inte själv). Vill man i
  stället ha följ-raden *alltid* tillgänglig bör **båda** pickrarna räkna sin
  sentinel (symmetriskt) — ett bredare UX-val som inte tas här.
- **"Ska deploy-restore bevara 'följ default' exakt?"** → **Ja** (beslut 9).
  Restore återställer redan mute/kamera/skärm/enheter troget; att tyst degradera
  till en konkret mick skulle bryta "valet fastnar". Fixen är liten: snapshot:a
  intentet (se implementationsdefaults).
- **Kvarstående produktbeslut (default-*beteende*, inte UI):** med ovan
  konservativa val *defaultar* högtalaren till att följa (`""` även när pickern är
  gömd) medan micken *defaultar till pin-vid-första-capture* (dagens beteende) och
  "följ default" blir **opt-in** via raden. Den **synliga UI:n är symmetrisk**
  (båda har en "Systemstandard (X)"-rad när pickern visas), men default-beteendet
  skiljer. Motiv: output-följning är gratis + säker via `setSinkId`; input-följning
  är mer opinionated (oväntat mick-byte när man pluggar i hörlurar) och bär
  capture-kostnad → opt-in. **Alternativ (full paritet, mer aggressivt):** låt
  micken också *defaulta* till `"default"`-capture. Det är strikt **inte sämre än
  idag** även om live-följning skulle saknas (degraderar till "välj default en
  gång"). Lämnas som ett uttalat val till beställaren; default i planen = det
  konservativa.

## Implementationsdefaults (antas om inget annat sägs)

### Vy-lagret (`public/js/main.js`)

- **`populateDevices(...)`** tar emot två nya valfria fält:
  `speakerDefaultName` och `micDefaultName`.
- **`populateSpeakerSelect(devices, currentId, defaultName)`**: första optionen
  behåller `value=""`, texten blir
  ``defaultName ? `Systemstandard (${defaultName})` : "Systemstandard"``.
  Routning (`setAudioOutput("")`) **oförändrad**.
- **Mick-default-rad:** antingen en dedikerad `populateMicSelect(devices, currentId, defaultName)`
  som speglar `populateSpeakerSelect` (renast), **eller** en valfri
  `defaultName`-param till `populateDeviceSelect` (som är delad med kameran och
  därför inte får en default-rad). **Val: dedikerad `populateMicSelect`** för att
  hålla kamerans väljare orörd. Default-raden: `value="default"`, text
  ``micDefaultName ? `Systemstandard (${micDefaultName})` : "Systemstandard"``.
  Raden visas **bara** när en `audioinput`-post med `deviceId==="default"` finns
  (annars kan vi inte lova följning).
- **Picker-synlighet (beslut 10):** behåll
  `els.micPicker.hidden = isIOS || mics.length < 2` (konkret-antal, speglar
  högtalaren `main.js:2072`). Sentinel-raden adderas i `populateMicSelect` men
  tvingar **inte** fram pickern; den syns först vid ≥2 konkreta mickar. Med
  pickern gömd spelar default-radens existens ingen roll (inget val kan göras),
  och micken styrs ändå av `preferredMicId` via join/switch.
- **Self-heal:** `mousedown`/`focus`-lyssnare på `els.speakerSelect` och
  `els.micSelect` → `controller.refreshDevices()` (best-effort).

### Controllern (`public/js/room-controller.js`)

- **Resolver:** `resolveSystemDefaultName(devices, kind)` (se ovan), körs i
  `refreshDeviceList` på den **råa** `devices`-listan; resultatet skickas som
  `speakerDefaultName` (`"audiooutput"`) och `micDefaultName` (`"audioinput"`)
  till `ui.populateDevices`.
- **Mick-intent-sentinel `"default"`:**
  - `switchMicrophone("default")`: fånga `buildAudioConstraints("default", /*exact*/ true)`
    → `{ audio: { ...AUDIO_PROCESSING, deviceId: { exact: "default" } } }`, sätt
    `preferredMicId = "default"`, `saveDevicePref(MIC_ID_KEY, "default")`. Resten
    (mute-överföring, `micPipeline.rebuild`, `mesh.setLocalAudioStream`,
    `setSelfMicMeter`) som i nuvarande `switchMicrophone`.
  - **Bevaka guarden** `if (!deviceId || deviceId === activeMicId()) return;`:
    `"default"` är truthy och `activeMicId()` returnerar (sannolikt) ett konkret
    id, så bytet körs. Men för att undvika onödig re-capture när vi *redan* står
    på default, jämför mot **intentet**: `if (deviceId === preferredMicId) return;`
    (för default-fallet), annars nuvarande aktiv-jämförelse.
  - **Join (`buildAudioConstraints(preferredMicId, false)`):** om
    `preferredMicId === "default"` blir det `{ ideal: "default" }` (ideal så en
    miljö utan default-enhet ändå får ljud).
  - **Skydda intentet vid join:** raden
    `preferredMicId = activeMicId() || preferredMicId` får **inte** skriva över
    `"default"` med det konkreta id:t →
    `if (preferredMicId !== "default") preferredMicId = activeMicId() || preferredMicId;`.
- **Dropdown-selektion speglar intentet:** i `refreshDeviceList` och
  `syncDeviceSelectsToActive`, skicka
  `micId: preferredMicId === "default" ? "default" : (activeMicId() || preferredMicId)`.
- **Persistens:** `MIC_ID_KEY` kan nu lagra `"default"`. Det är ett **stabilt
  token** ("följ default"), så instabilitets-argumentet bakom `isSelectableDevice`
  gäller inte här (vi pinnar inte en specifik fysisk enhet via ett ostabilt id).
- **Deploy-restore-snapshot (beslut 9):** `captureDeployRestoreState`
  (`room-controller.js:405`) ska snapshot:a **intentet**, inte det resolvade id:t:
  `micDeviceId: preferredMicId === "default" ? "default" : (activeMicId() || preferredMicId)`.
  Restore-sidan (`if (restore.micDeviceId) preferredMicId = restore.micDeviceId;`,
  `:1366`) är då **oförändrad**: `preferredMicId` blir `"default"`, join bygger
  `{ ideal: "default" }`, och join-intent-guarden ovan bevarar `"default"` förbi
  raden `preferredMicId = activeMicId() || preferredMicId`. Enda fixen sitter på
  snapshot-sidan.
- **`isSelectableDevice`:** lämna orörd för *filtreringen* av de konkreta
  listorna; `"default"` hanteras separat som sentinel/namn-resolver, inte som en
  vanlig listrad. (Vi släpper alltså **inte** in `"default"` i mick-konkretlistan;
  vi lägger till en egen sentinel-rad.)

### Verifiering som krävs på riktig hårdvara (Mac, riktiga enheter)

Två frågor jag inte kan testa i VM:en (inga riktiga enheter att byta default på;
fake-devices saknar en meningsfull `"default"`-post):

1. **Fyrar `devicechange` vid ett *rent* default-byte** (båda enheterna redan
   inkopplade, byte i Systeminställningar)? Brukar göra det på desktop-Chrome
   (default-postens `groupId` ändras) men är plattforms-/versionsberoende.
2. **Följer ett `deviceId:"default"`-capture live** när OS-defaulten byts, eller
   pinnas det vid capture? Default-enheten är *tänkt* att följa; bekräfta.

**Fallback om (2) visar sig pinna:** re-acquira micken på `devicechange` **bara**
när man står på Systemstandard (`preferredMicId === "default"`) — samma steg som
`switchMicrophone` (rebuild pipeline + `setLocalAudioStream`). Tyngre (kort glapp)
→ byggs bara om verifieringen kräver det. Etikett-följningen (via `devicechange`)
fungerar oavsett.

Intent-speglingen (beslut 6) gör att **raden fastnar oavsett** utfallet på
`getSettings()`, så själva UI-korrektheten hänger inte på verifieringen.

## Filer som sannolikt berörs

- `public/js/main.js` — `populateDevices` (nya namn-fält), `populateSpeakerSelect`
  (namn i texten), ny `populateMicSelect` (default-rad), self-heal-lyssnare på
  väljarna.
- `public/js/room-controller.js` — `resolveSystemDefaultName`, `refreshDeviceList`
  (resolva + skicka namn, intent-speglad `micId`), `switchMicrophone`
  (`"default"`-sentinel + guard), join-capture (skydda `"default"`-intentet),
  `syncDeviceSelectsToActive`, **`captureDeployRestoreState` (snapshot:a
  `"default"`-intentet — beslut 9)**.
- `public/js/main.js` (visibility) — `populateDevices` håller kvar
  `els.micPicker.hidden = isIOS || mics.length < 2` (beslut 10); ingen sentinel-
  räkning. Tas med här bara för att markera att raden medvetet **inte** ändras.
- `test/room-controller.test.js` — utöka högtalar-sviten (assert:a `speakerDefaultName`
  och resolvern via `groupId`); nya mick-wiring-tester: (a) val av `"default"`
  sätter/persisterar intent + bygger `{exact:"default"}`; (b) dropdownen fastnar
  på `"default"` **trots** att `activeMicId()` returnerar konkret; (c) en konkret
  enhet pinnas fortfarande; (d) join med sparat `"default"` använder `{ideal:"default"}`
  och skriver inte över intentet; **(e) `captureDeployRestoreState` snapshot:ar
  `"default"` när intentet är default (inte `activeMicId()`), och en restore med
  `micDeviceId:"default"` återställer follow-intentet (beslut 9)**.
- `scripts/speaker-picker-test.mjs` + `scripts/speaker-picker-screenshot.mjs` —
  lägg en `{ deviceId: "default", groupId: "g1", … }`-post i de stubbade
  enheterna; assert:a "Systemstandard (…)"-texten + skärmdump.
- **Ev. nytt:** `scripts/mic-default-test.mjs` (puppeteer, stubbad
  `enumerateDevices` med en `"default"`-audioinput) som verifierar att raden visas,
  fastnar och att en konkret enhet fortfarande går att pinna. (Live-följningen
  kräver riktig hårdvara — manuell verifiering.)
- `AGENTS.md` — kort statusrad när det är byggt och verifierat.

## Test- & verifieringsplan

1. `npm test` — nya/utökade wiring-tester gröna.
2. `npm run e2e` — `speaker-picker`-sviten (uppdaterad) + ev. ny `mic-default`-svit.
3. Skärmdumpar via de stubbade picker-skripten: "Systemstandard (AirPods)" i båda
   väljarna, plus de konkreta enheterna kvar.
4. **Manuellt på riktig Mac (Chrome):** byt OS-default mellan AirPods och inbyggd
   enhet → (a) etiketten i båda väljarna uppdateras, (b) högtalarljudet följer,
   (c) mick-spåret följer (eller, om inte, aktivera re-acquire-fallbacken).
5. **Mätstickan** vid behov som regressionskoll (mick-vägen rörs).

## Inte i scope (senare ev.)

- Windows `"communications"`-default som separat följ-mål (voice-appar kan föredra
  den; cross-platform-förenkling nu).
- Re-acquire-fallback för micken **byggs bara** om verifieringen visar att
  `"default"`-capture inte följer live.
- Eventuell visning av default-namnet på andra ställen än väljarna.
