# Plan: Vidareutveckla "Snabbkontroller i helskärm"

> **Status:** *planerad, ej byggd.* Design/motivering inför implementation.
> Kommer ur en grillning av två önskemål: (1) en **dela-skärm-knapp** med ikon
> bland de andra knapparna i helskärmsmodulen, och (2) **enhetsval** (mikrofon,
> högtalare, kamera + brusreducering) via **kontext-menyer** som öppnas från en
> förlängd "disclosure"-del av mute- respektive kamera-knappen. Menyerna ska
> rendera sig så att de syns oavsett var den dragbara modulen är placerad.
>
> **Långsiktig avsikt (styr arkitekturen):** mönstret byggs först i
> `#fs-controls`, men ska **återanvändas i sidopanelen** senare för att göra den
> kompaktare. Därför byggs enhetsmenyn som en återanvändbar, yt-agnostisk modul
> redan nu — men **wire:as bara in i helskärmsmodulen i den här PR:en**.
>
> **Reviderad efter granskning (Medium):** ett fynd inarbetat — en custom-meny
> får **inte** webbläsarens "sätt `<select>.value` före handlern"-sidoeffekt, och
> `switchSpeaker`/`setNoiseReduction`/kamera-av-`switchCamera` notifierar inte
> vyn idag → menyns aktiva markering (och sidopanels-`<select>`) skulle drifta.
> Nu **beslut 16** + mekanik under implementationsdefaults.

## Vad vi bygger

Två funktioner i **enbart** `#fs-controls` (sidopanelen är orörd i den här
omgången):

1. **Dela-skärm-knapp** i helskärmsmodulen — motsvarar sidopanelens
   `#share-btn`-toggling men som **ikon** (monitor-glyf) i stället för text,
   inplacerad bland de andra snabbkontrollerna.
2. **Enhetsval från snabbkontrollerna** — mute- och kamera-knapparna blir
   **delade knappar** (toggle-del + disclosure-del). Disclosure-delen öppnar en
   **kontext-meny**:
   - **mute-knappens meny:** *Mikrofon* + *Högtalare* + *Brusreducering*,
   - **kamera-knappens meny:** *Kamera*.

   Menyerna **placerar om sig automatiskt** (upp/ner + sidled-klamp) så de alltid
   syns oavsett var modulen dragits.

## Bakgrund: nuläget i koden

- **`#fs-controls`** (i `public/index.html`, byggd/positionerad i
  `public/js/main.js` ~rad 1189–1293) finns **bara i helskärmsläge** — och
  helskärm går bara att slå på när man är fokuserad på en **fjärrdeltagare**
  (`fullscreenButtonVisible: !!focusObj && !fullscreen && !focusObj.isSelf` i
  `stage.js`). Modulen innehåller idag: grip · mute · kamera · lämna · exit.
- Modulen är **dragbar** (clampad 8px från kanterna) och **auto-göms** efter 3s
  inaktivitet (`fs-idle` → `opacity:0` + `pointer-events:none`). Esc lämnar
  helskärm (`onFsKeydown`, capture på `window`).
- **Dela skärm** finns redan som textknapp `#share-btn` →
  `controller.toggleShare()` → `startShare`/`stopShare` i `room-controller.js`,
  gated av `canShareScreen` (saknas `getDisplayMedia` ⇒ knappen disablad med
  förklaring).
- **Enhetsval** finns i sidopanelen som tre `<select>` (`#mic-select`,
  `#speaker-select`, `#camera-select`) → `controller.switchMicrophone/
  switchSpeaker/switchCamera`. Gating: högtalare kräver `setSinkId`-stöd, **iOS
  döljer mick + högtalare** (systemstyrt), kamera visas. Varje picker döljs vid
  `< 2` enheter. **Brusreducering** (`#noise-select`, off/lite/full →
  `controller.setNoiseReduction` / `getNoiseLevel`) är **alltid** synlig (ingen
  device-/iOS-gating).
- **Stage-pin:** `stage.js` äger `fullscreenPin` (alltid en fjärrdeltagare).
  `pinValid` kräver för `type:"screen"` att `sharerId === peerId`, för
  `type:"camera"` att `cameras.has(peerId)`.

## Arkitektur / seam-strategi (deep module)

Den långsiktiga avsikten (sidopanelen ska återanvända mönstret) gör seamet
**verkligt** — "two adapters means a real seam". Därför:

1. **Centralisera en device-model i vy-lagret (byggs nu).** `populateDevices()`
   i `main.js` ska, utöver att måla `<select>`-arna, **cacha payloaden** som ett
   enda objekt. Både sidopanelens väljare och helskärmsmenyn renderar ur samma
   källa → ingen drift. (Det är exakt vad sidopanelen läser senare.)
2. **En återanvändbar enhetsmeny-modul (byggs nu).** Litet interface
   (`open(anchorEl, kind)` / `close()` / `isOpen()`), mycket dolt bakom det
   (rendering av sektioner, placering, dismiss, fokus). Den läser device-modellen
   och anropar de **befintliga** `controller.switch…` + `setNoiseReduction`.
   **Yt-agnostisk:** behöver bara ett ankar-element → sidopanelen kan
   återanvända den genom att peka på en annan trigger.
3. **Delad-knapp-markup + placeringsmatematik är interna** delar av menymodulen
   (interna seams), inte separata publika moduler — tills en andra konsument
   faktiskt behöver dem.
4. **YAGNI-disciplin:** wire:a **bara `#fs-controls`** nu. **Ingen**
   sidopanels-refaktor, **inga** spekulativa sidopanels-knoppar i interfacet.
   Sidopanels-adoptionen är det som **bevisar** seamet och får forma om
   interfacet då (design-it-twice), billigt, eftersom all enhetslogik redan är
   centraliserad.

## Funktion 1 — dela-skärm-knapp

- **Placering:** `grip · [mute ▸] · [kamera ▸] · dela · lämna · exit`. Grupperar
  de tre media-togglarna (mute/kamera/dela) före lämna/exit; speglar
  sidopanelens ordning och den bifogade bilden (mick, kamera, monitor).
- **Ikon:** klassisk monitor-glyf (rundad `<rect>` + kort fot), inline-SVG som
  resten av UI:t (inga assets). Samma ikon i båda lägen.
- **Aktivt läge:** återanvänd `aria-pressed` + färg-highlight-mönstret modulen
  redan har. `fs-mute` blir **röd** (danger) när aktiv eftersom mute är ett
  varnings-läge; delning är ett **positivt/aktivt** läge → highlight i
  **accent/grön** när man delar (`aria-pressed="true"`), och `title`/`aria-label`
  växlar "Dela skärm" / "Sluta dela skärm". Inget slash, ingen separat stopp-ikon.
- **Dual-update:** `setShareButton(on)` ska driva **både** sidopanelens och
  helskärmens knapp (samma mönster som `setCameraButton` redan har för
  `fsCamera`), så att en *superseded* delning även släcker fs-knappens highlight.
- **Stöd saknas (`!canShareScreen`, dvs iOS/ingen `getDisplayMedia`):** **dölj**
  knappen helt i helskärmsmodulen (i stället för disablad). Baren är trång och
  dragbar; en permanent grå knapp är skräp. Sidopanelen bär kvar den förklarande
  disablade varianten. (iOS kan nå helskärm genom att titta på en fjärrkamera/
  delning, så fallet är verkligt.)

## Funktion 2 — enhets-kontext-menyer

### Anatomi (delad knapp)

- **Två riktiga `<button>` i en pill**, inte en knapp med klickbar sub-zon.
  Vänster knapp behåller exakt nuvarande beteende (mute togglar mute; kamera
  togglar kamera). Höger knapp är en smal **disclosure** med en chevron som
  **bara** öppnar menyn och **aldrig** togglar state. En tunn vertikal avdelare
  mellan dem (looken i bilden). Två element ⇒ var sin `aria-label` och
  disclosure:n bär `aria-haspopup="menu"` + `aria-expanded`.
- **mute-pill ▸ ljud-meny:** *Mikrofon* + *Högtalare* + *Brusreducering*.
- **kamera-pill ▸ kamera-meny:** *Kamera*.
- **Dela/grip/lämna/exit:** vanliga enkla knappar (ingen chevron).

### Menyinnehåll & interaktion

- **Ljud-meny:** sektioner i ordningen **Mikrofon → Högtalare → Brusreducering**.
  Varje sektion är en vertikal lista; **aktiv** enhet/nivå får en bock/prick.
  Sentinels speglas ordagrant ur device-modellen ("Systemstandard (X)" för mick
  när `hasMicDefault`, för högtalare alltid `value=""`). Brusreducering = 3-vägs
  (Av/Lätt/Stark) som radio.
- **Kamera-meny:** en *Kamera*-sektion, samma item-stil.
- **Interaktion:** klick på item → anropa matchande `controller.switch…(id)` /
  `setNoiseReduction(level)` → **stäng menyn** (close-on-select). Re-klick på
  aktivt item = no-op + stäng.
- **Aktiv markering kommer ur `deviceModel`, som måste uppdateras på _varje_
  selektionsväg (beslut 16).** En native `<select>` får webbläsarens uppdatering
  av `.value` *före* handlern — det får en custom-meny **inte** gratis.
  `switchMicrophone` och kamera-**på**-`switchCamera` repaintar redan vyn via
  `refreshDeviceList()`, men `switchSpeaker`, `setNoiseReduction` och
  kamera-**av**-`switchCamera` gör det **inte** idag. Utan en explicit notify
  skulle `deviceModel` (och sidopanels-`<select>`) behålla det gamla värdet →
  nästa öppning markerar fel item. Mekanism: se implementationsdefaults.
- Menyn **renderar färskt ur `deviceModel`** vid varje öppning **och** vid
  `devicechange` medan den är öppen. Ett reverterat högtalarval (`setSinkId`
  faller tillbaka till Systemstandard) speglas korrekt eftersom `setAudioOutput`
  (vyn, som äger output-routningen) korrigerar **både** `speakerSelect.value`
  **och** `deviceModel.speakerId` till `""`.
- Items = `role="menuitemradio"` + `aria-checked` på den aktiva; sektioner
  `role="group"` + `aria-label`.

### Gating (när visas respektive disclosure)

| Sektion | Visas när |
| --- | --- |
| Mikrofon | inte iOS **och** ≥2 mickar |
| Högtalare | `setSinkId`-stöd, inte iOS, **och** ≥2 högtalare |
| Brusreducering | **alltid** |
| Kamera | ≥2 kameror (samma på iOS — fram/bak är användbart) |

Konsekvenser:

- **mute-pillens ljud-disclosure visas _alltid_** (det finns alltid minst
  Brusreducerings-sektionen). På iOS / en-micks-desktop visar menyn **bara
  Brusreducering** — i praktiken en "ljudinställningar"-popover. Mick-/
  högtalar-sektioner dyker upp först när de har ett verkligt val (speglar
  sidopanelen).
- **kamera-pillens disclosure är _villkorad_:** visas bara vid **≥2 kameror**.
  Med 0–1 kameror **kollapsar** kamera-pillen till en **vanlig enkel knapp**
  (ingen chevron) — toggeln funkar ändå.
- De två pillarna är alltså avsiktligt **asymmetriska** (mute har alltid chevron;
  kamerans kommer och går med enhetsantalet). Synligheten uppdateras live på
  `devicechange` (återanvänder den befintliga refresh-vägen).

### Placering (viewport-medveten)

Modulen är `position: fixed`, dragbar, clampad 8px från kanterna. Menyn mäts en
gång vid öppning (rendera dold, läs `offsetWidth/Height`) och placeras mot
disclosure-knappens `getBoundingClientRect()`:

- **Vertikalt (primär axel):** föredra **ovanför** baren om det får plats
  (`anchor.top − menyH − gap ≥ 8`) — default eftersom modulen startar
  nere-till-höger och det matchar upp-chevronen i bilden. Annars **under** om det
  får plats. Annars sidan med mest plats + **`max-height` + intern
  `overflow-y:auto`** (scroll), så en lång enhetslista på en låg viewport ändå
  går att nå.
- **Horisontellt:** rikta menyn mot ankaret, sedan **klampa** vänster ≥ 8px och
  höger ≤ `innerWidth − 8px` så den aldrig blöder ut i ett hörn.
- **Implementation:** menyn är ett eget `position: fixed`-element (z-index över
  barens 1002), tillagt som del av modulen så den rivs med helskärm. Kör om
  placeringen på `window.resize`. Återanvänd mätstilen från `positionShareArrow()`.
- **Chevron-riktning:** pekar mot där menyn faktiskt öppnas — **upp** som default,
  **ner** om placeringen löser sig nedåt (billigt; riktningen är redan beräknad).

### Livscykel (auto-göm, dismiss, Esc)

- **Pausa auto-göm medan en meny är öppen.** Grinda idle-timeouten så `fs-idle`
  aldrig läggs på medan en meny är öppen; starta om 3s-timern när den stängs.
- **En meny i taget.** En enda `openMenu`-referens; att öppna kamera-menyn medan
  ljud-menyn är öppen stänger ljud-menyn först.
- **Stäng öppen meny vid:** val av item (close-on-select), Esc, klick/tap
  **utanför** menyn och dess disclosure, **re-klick** på samma disclosure
  (toggle), klick på den **andra** disclosure:n, **drag-start** (grip
  `pointerdown`), samt helskärms-teardown (exit/reconnect). På `window.resize`
  **placeras den om** i stället för att stängas.
- **Stäng vid drag-start** i stället för att live-följa baren under draget
  (enklare; man läser inte menyn medan man flyttar baren).
- **Esc-precedens:** `onFsKeydown` stänger menyn först — `if (menuOpen) { close;
  stop; } else exitFullscreen()`. Ett Esc stänger menyn (kvar i helskärm); ett
  andra Esc lämnar helskärm.

### Tillgänglighet (mellan-nivå)

- Items = riktiga `<button>` (fokuserbara + Enter/Space), `role="menuitemradio"`
  + `aria-checked` på aktiv; sektioner i `role="group"` med `aria-label`.
- Disclosure: `aria-haspopup="menu"` + `aria-expanded`.
- **Vid öppning:** fokusera aktivt item. **Vid stängning:** återför fokus till
  disclosure:n.
- **Pil upp/ner** flyttar mellan items; **Esc** stänger (sedan lämnar ett andra
  Esc helskärm); **Tab** stänger menyn och låter fokus gå vidare.
- Hoppar över type-ahead och Home/End (låg payoff). Touch: pillen är 44px hög så
  chevron-träffytan räcker; disclosure:n får en rimlig min-bredd.

## Låsta beslut (med motivering)

| # | Beslut | Varför | Bortvalt |
| --- | --- | --- | --- |
| 1 | **Bara `#fs-controls` nu**, sidopanelen orörd | Liten blast-radius; sidopanelens befintliga wiring/e2e förblir giltiga. | Refaktorera sidopanelen i samma PR (större risk innan mönstret bevisats). |
| 2 | **Bygg återanvändbar device-model + enhetsmeny-modul nu, wire bara fs** | Sidopanelen är en bekräftad andra konsument ⇒ verkligt seam. Centraliserad modell = ingen drift, billig sidopanels-migration senare. | Inline i `#fs-controls` och extrahera senare (dubbelarbete + drift-risk). |
| 3 | **Dela-knapp: placering mute·kamera·dela, monitor-ikon, grön aktiv-highlight** | Grupperar media-toggles; speglar sidopanel + bild. Grön skiljer "aktiv/positiv" från mutens röda "varning". | Disablad i stället för dold; annan färg. |
| 4 | **Dölj dela-knappen vid `!canShareScreen` i fs** | Trång, dragbar bar; grå knapp = skräp. Sidopanelen bär förklaringen. | Visa disablad (klutter i en liten flytande bar). |
| 5 | **Inga share-while-fullscreen-guards** | Kamera-pin: man stannar i helskärm och delar ut. Skärm-pin: server-regeln "senaste delaren vinner" tar över scenen och pin:en auto-rensas → helskärm avslutas. Det är bara den befintliga regeln synliggjord; guards = onödig yta för en sällan-kollision servern redan medlar. | Disabla knappen vid skärm-pin / bekräftelsedialog / tillåt helskärm-av-sig-själv (mer state). |
| 6 | **Delad knapp = två riktiga `<button>`** (toggle + disclosure) | Var sin `aria-label`; `aria-haspopup`/`aria-expanded` rent. Disclosure togglar **aldrig** state (beställarkrav). | En knapp med klickbar sub-zon (rörig a11y). |
| 7 | **mute-disclosure = mick+högtalare+brusreducering; kamera-disclosure = kamera; dela = ingen** | Matchar beställarens spec och bilden. Det finns ingen annan ljud-knapp att hänga ljudinställningarna på. | Separat ljud-knapp; brusreducering i sidopanelen bara. |
| 8 | **Inkludera Brusreducering som egen sektion** (beställaren) | Alltid tillgänglig kontroll; naturlig i en "ljudinställningar"-meny. | Utelämna (beställaren ville ha den). |
| 9 | **Close-on-select** | Standard kontext-meny-beteende; beställaren bekräftade. | Håll öppen för flera ändringar. |
| 10 | **Ljud-disclosure visas alltid; mick/högtalar-sektioner gated ≥2 & ej iOS; brusreducering alltid** | Brusreducering är alltid tillgänglig (sidopanelen visar den alltid) ⇒ menyn måste alltid gå att nå. Speglar sidopanelens device-gating inuti. | Dölja chevronen när inget *device*-val finns (då går brusreducering inte att nå). |
| 11 | **Kamera-disclosure villkorad ≥2 kameror; annars vanlig knapp** | Speglar sidopanelens `cams.length < 2`-gating; ingen chevron utan val. | Alltid chevron (öppnar en tom/en-items meny). |
| 12 | **Placering: föredra ovanför, annars under, annars scroll; klampa i sidled; chevron speglar riktning** | Uppfyller "syns oavsett var modulen är". Upp-default matchar bild + bottenhöger-startläge. Scroll-fallback räddar låg viewport. | Föredra under / centrera (sämre default givet startläget). |
| 13 | **Livscykel: en meny i taget, pausad auto-göm, stäng vid select/Esc/utanför/re-klick/andra-disclosure/drag/teardown; Esc stänger meny före helskärm** | Förutsägbar dismiss; baren får inte tona bort under en öppen meny; Esc-precedens undviker att man oavsiktligt lämnar helskärm. | Live-följ menyn under drag (komplext, lågt värde). |
| 14 | **A11y mellan-nivå** (roller + `aria-expanded` + fokus + pil-nav + Esc + Tab stänger) | Korrekt semantik + tangentbord utan tung roving-tabindex/type-ahead. | Minimal (ingen pil-nav) / full (Home/End, type-ahead). |
| 15 | **Tester: två rena Node-units + en e2e-svit** | Ren placeringsfunktion + ren meny-modell-byggare är Node-testbara (interfacet är testytan). DOM/placering på riktigt täcks av puppeteer. | Bara e2e (långsammare, missar gränsfall) / inga tester. |
| 16 | **`deviceModel` + sidopanels-`<select>` uppdateras på _varje_ menyselektion — förlita dig _inte_ på native `<select>.value`-sidoeffekten** (granskning, Medium) | En custom-meny får inte webbläsarens "sätt `.value` före handlern". `switchSpeaker`/`setNoiseReduction`/kamera-av-`switchCamera` notifierar inte vyn idag → reopen markerar fel item och modellen/`<select>` driftar. Att notifiera på alla vägar = en källa till sanning och rätt för sidopanels-återbruket. **`noiseLevel` saknas dessutom helt i dagens `populateDevices`-payload** och måste in i modellen. | Lita på native-sidoeffekten (finns inte i custom-menyn) / bara repaint:a vid `devicechange` (fyrar inte vid rena selektions-/nivåbyten). |

## Implementationsdefaults (antas om inget annat sägs)

### Övergripande val

- **Menyn är ett eget `position: fixed`-element** (inte native popover/`<dialog>`)
  för exakt placeringskontroll + integration med `fs-idle`-auto-gömningen.
- **`prefers-reduced-motion`** respekteras för ev. öppningsanimation.

### Ny modul: `public/js/device-menu.js` (återanvändbar, yt-agnostisk)

- **Interface:** `createDeviceMenu(deps) → { open(anchorEl, kind), close(),
  isOpen() }` där `kind ∈ {"audio","camera"}`.
- **Deps (injicerade, inga globaler):**
  - `getModel()` → den cachade device-modellen (mics/cams/speakers + aktiva id:n
    + sentinel-namn + `hasMicDefault` + iOS/sink-gating-flaggor + aktuell
    noise-nivå),
  - `actions`: `{ switchMicrophone, switchSpeaker, switchCamera,
    setNoiseReduction }` (controllerns befintliga metoder),
  - `onOpenChange(open)` (så vy-lagret kan pausa/återuppta auto-göm).
- **Intern (privata seams):**
  - `buildMenuModel(model, kind)` → ordnade sektioner (ren funktion → Node-testbar),
  - `computeMenuPlacement({ anchorRect, menuSize, viewport, gap })` →
    `{ left, top, openUp }` (ren funktion → Node-testbar),
  - rendering, fokus, pil-nav, outside-click/Esc-dismiss.

### Vy-lagret (`public/js/main.js`)

- **`populateDevices(...)`**: utöver att måla `<select>`-arna, **cacha** payloaden
  i en modul-lokal `deviceModel` som `device-menu.js` läser via `getModel()`.
  Modellen **inkluderar `noiseLevel`** (`controller.getNoiseLevel()`) — finns
  **inte** i dagens payload — så Brusrederings-sektionen kan markera aktiv nivå.
- **Aktiv-selektion-synk (beslut 16):** ny lättviktig
  `ui.syncActiveSelection({ speakerId, camId, noiseLevel })` (eller en utökad
  `syncDeviceSelects`) som uppdaterar `deviceModel` + speglade `<select>` + en
  ev. öppen meny **utan** `enumerateDevices()` (enhetslistan ändrades inte, bara
  valet/nivån). Controllern kallar den i svansen på `switchSpeaker`,
  `setNoiseReduction` och kamera-**av**-grenen av `switchCamera`.
  (`switchMicrophone` + kamera-på refreshar redan hela modellen via
  `refreshDeviceList()` → `populateDevices`.)
- **Högtalar-revert:** `setAudioOutput` (vyn äger output-routningen) korrigerar
  redan `speakerSelect.value` till `""` när `setSinkId` faller; den ska **även**
  sätta `deviceModel.speakerId = ""`, så menyns aktiva markering följer den
  faktiskt routade sinken (inte det begärda men avvisade valet).
- **`#fs-controls`-wiring:** instansiera `createDeviceMenu`; bind mute- och
  kamera-disclosure → `open(anchorEl, kind)`; gör om `setShareButton` till
  dual-update (sidopanel + ny `fsShare`); lägg fs-dela i `setRoomControlsEnabled`
  (disabla vid reconnect, dölj vid `!canShareScreen`).
- **Auto-göm:** grinda `showFsControls`-timeouten på `deviceMenu.isOpen()`;
  `onOpenChange` startar om timern vid stängning.
- **Esc:** i `onFsKeydown`, `if (deviceMenu.isOpen()) { deviceMenu.close();
  stop; return; }` före `exitFullscreen`.
- **Drag:** `onGripPointerDown` anropar `deviceMenu.close()`.

### HTML (`public/index.html`)

- Strukturera om `#fs-controls`: mute → pill med toggle + disclosure; kamera →
  dito; lägg `fs-share`-knapp (monitor-SVG) mellan kamera och lämna; lägg en
  meny-container (eller låt `device-menu.js` skapa elementet vid första öppning).

### CSS (`public/style.css`)

- Pill-look (toggle + avdelare + chevron), aktiv-highlight för fs-dela (grön),
  meny-popover (bakgrund/blur som baren, `max-height`/scroll), `menuitemradio` +
  bock, chevron upp/ner-rotation, `prefers-reduced-motion`.

### Controllern (`public/js/room-controller.js`)

- **Publika action-namn oförändrade.** Menyn återanvänder `switchMicrophone/
  switchSpeaker/switchCamera/setNoiseReduction` + `getNoiseLevel` (finns redan).
- **Additivt vy-notify (beslut 16):** tre metoder som idag *inte* notifierar vyn
  får ett anrop till `ui.syncActiveSelection(...)` i svansen:
  - `switchSpeaker` (sätter `preferredSpeakerId`, ingen refresh idag),
  - `setNoiseReduction` (sätter `noiseLevel`, ingen refresh idag),
  - `switchCamera`s **kamera-av-gren** (`!localCameraStream` → sätter bara
    `preferredCameraId` och returnerar).

  `switchMicrophone` och kamera-på-`switchCamera` lämnas orörda (de kallar redan
  `refreshDeviceList()`). Inga signaturer ändras; det är en additiv
  vy-notifiering, inget nytt publikt action.

## Filer som sannolikt berörs

- **Ny:** `public/js/device-menu.js` — återanvändbar enhetsmeny + interna rena
  helpers (`buildMenuModel`, `computeMenuPlacement`).
- `public/index.html` — omstrukturerad `#fs-controls` (delade pillar + fs-dela +
  ev. meny-container).
- `public/style.css` — pill/avdelare/chevron, fs-dela aktiv-highlight,
  meny-popover + scroll, `menuitemradio`, reduced-motion.
- `public/js/main.js` — `deviceModel`-cache (inkl. `noiseLevel`) i
  `populateDevices`; ny `ui.syncActiveSelection` (beslut 16); `setAudioOutput`
  sätter även `deviceModel.speakerId` vid revert; instansiera + wire
  `device-menu.js`; `setShareButton` dual-update; `setRoomControlsEnabled`
  (fs-dela); auto-göm-gating; Esc-precedens; drag-stäng; dölj fs-dela vid
  `!canShareScreen`; `els`-poster för de nya elementen.
- `public/js/room-controller.js` — **additivt vy-notify (beslut 16):**
  `switchSpeaker`, `setNoiseReduction` och kamera-av-grenen av `switchCamera`
  kallar `ui.syncActiveSelection(...)` i svansen. Inga signaturer/publika
  action-namn ändras.
- **Ny:** `test/device-menu.test.js` — rena units för `computeMenuPlacement`
  (föredrar ovan; flippar under nära toppen; klampar i sidled; cap+scroll när
  ingetdera får plats) och `buildMenuModel` (iOS döljer mick/högtalare men
  behåller brusreducering + kamera; `<2` utelämnar device-sektion; sentinels med;
  aktivt item flaggat **inkl. `noiseLevel`**).
- `test/room-controller.test.js` — **wiring-tester (beslut 16):** `switchSpeaker`,
  `setNoiseReduction` och kamera-av-`switchCamera` kallar `ui.syncActiveSelection`
  med rätt aktivt/önskat värde (fejk-ui asserterar anropet), så menyns aktiva
  markering inte driftar.
- **Ny:** `scripts/fs-controls-menu-test.mjs` (puppeteer) + registrera i
  `scripts/e2e.mjs` — i helskärm: fs-dela-toggle speglar aktivt läge; ljud-
  disclosure öppnar förväntade sektioner; val av enhet driver `switch…` (assert
  via synkad sidopanels-`<select>` / live spår-`deviceId`); close-on-select; Esc
  stänger meny sedan lämnar helskärm; auto-göm pausad medan öppen; placering
  (dra modulen till toppen → öppnar nedåt; nära kant → klampad);
  **stale-active-regression:** efter val av **högtalare / brus / kamera-av**,
  återöppna menyn → **nytt** item markerat aktivt + sidopanels-`<select>` speglar;
  och en högtalar-revert (stubbat `setSinkId`-fail) → **Systemstandard** markeras.

## Test- & verifieringsplan

1. `npm test` — nya rena units (placering + meny-modell) + wiring-testerna för
   `ui.syncActiveSelection` (beslut 16) gröna, befintliga gröna.
2. `npm run e2e` — ny `fs-controls-menu`-svit (inkl. stale-active-regressionen)
   + alla befintliga gröna (tre gröna körningar på default-concurrency = stabilt).
3. **Manuellt browsertest (Chrome, fake media):** gå in i helskärm på en
   fjärrdeltagare; verifiera dela-toggle (grön aktiv), ljud-/kamera-menyer öppnas
   och placerar om sig när modulen dras till olika hörn/toppen, enhetsbyte
   fungerar, close-on-select/Esc/utanför-klick, auto-göm pausas medan meny är
   öppen. **Aktiv-markerings-regression:** byt högtalare / brusnivå / kamera (med
   kameran av) i menyn, återöppna → rätt item markerat aktivt. Skärmdumpar i
   olika modul-positioner.
4. **Mätstickan** vid behov som regressionskoll (media-vägen rörs indirekt via
   enhetsbyte/delning).

## Inte i scope (senare ev.)

- **Sidopanels-migration** till samma kompakta delade-knapp + meny-mönster
  (huvudmålet med att bygga modulen återanvändbar — egen PR; bevisar/omformar
  interfacet).
- Type-ahead / Home/End i menyn.
- Brusreducering eller andra inställningar på fler ytor än de beskrivna.
