# babbla

Ett full-duplex ljudrum med mesh WebRTC. Termer här speglar domänspråket i koden och handoff-dokumentationen.

## Language

**Room**:
Ett samtalsrum där deltagare möts; media går mesh P2P, servern håller presence.
Rum identifieras via URL: `/` = ett delat default-rum ("main"), `/room/<namn>` =
ett eget isolerat rum. Servern skapar rum vid behov (registry) och GC:ar tomma.
_Avoid_: Session, channel, lobby

**Peer**:
En annan deltagare i rummet, identifierad med ett server-tilldelat UUID. Klienten har en mesh-länk per peer.
_Avoid_: User, participant (reserverat för UI/roster)

**Mesh**:
Klientmodulen som äger alla `RTCPeerConnection`-länkar: perfect negotiation, ICE, lokala spår och inkommande track-dispatch. UI och presence ligger utanför seam:en.
_Avoid_: WebRTC layer, connection manager

**Signaling**:
WebSocket-relä av SDP/ICE mellan peers plus server-side presence (roster, sharer, kamera, video-opt-out).
_Avoid_: Protocol handler

**Presence**:
Server-auktoritativ state om vem som delar skärm, har kamera på, eller optat ut från inkommande video — speglad på klienten för visning.
_Avoid_: Room state (för brett)

**Sharer**:
Den peer som för närvarande delar skärm (max en åt gången; senaste vinner).
_Avoid_: Presenter, screen owner

**Video classification**:
Mappning av inkommande videospår till kamera vs skärm via `{ mid: role }` in-band i signaleringsmeddelanden.
_Avoid_: Track labeling, heuristics

**Stage**:
Den klient-härledda vyn av vad som visas: vilket fokus (skärm eller kamera) som
ligger på scenen, om det är fullscreen, layout-läge (compact/gallery/expanded)
samt de signaleringsintent (`camera-focus`, `video-suppress`) som följer av
fokus. Äger lokal fokus-intent (`userFocus`, `fullscreenPin`) och en spegling av
`Presence`; ren modul utan DOM/WebRTC (id:n + roller, renderaren resolvar streams
och namn). Tänkt att bo i `public/js/stage.js` (`createStageDirector`) och spegla
husstilen från `Mesh`.
_Avoid_: View, focus controller, layout manager

**RoomController**:
Orkestreringen som kopplar servermeddelanden och användarhändelser till
`Stage`-mutationer, `Mesh`/`Signaling`-anrop och rendering. Äger
sessionslivscykeln (join/connect/teardown), mesh- och lokal media-livscykel
(mik/kamera/skärm), presence/fokus-handlers, inbound-dispatch, reclassify-gating
och `camera-focus`/`video-suppress`-reconcilers. Hanterar bara id:n/roller/
booleans: all DOM går via en injicerad `ui`-port, all capture via `media`,
transport/mesh via injicerade fabriker, och `Stage` är injicerad — så hela
controllern kan köras (och testas) i Node utan webbläsare. Bor i
`public/js/room-controller.js` (`createRoomController`); `public/js/main.js` är
composition root + view-lagret (DOM-helpers + `ui`-adaptern, som äger
display-strömmar och resolvar `view`-id:n → streams/namn).
_Avoid_: Main, app, glue (för vagt)

**Device stack**:
Användarens **aktiva val** av mick, kamera eller högtalare, senast-först
(`babbla:micStack` / `babbla:cameraStack` / `babbla:speakerStack`, se
`public/js/device-stack.js`). Skrivs *bara* när användaren själv väljer. Auto-val
går ovanifrån och tar första posten som är närvarande och öppningsbar.
"Systemstandard" är en vanlig post och är alltid terminal (allt under prunas).
_Avoid_: History, preferences, last used (stacken är intent, inte en logg)

**Active device**:
Det som faktiskt är live just nu (capture-track eller `setSinkId`). Kan vara en
lägre stack-post, eller en okonstruerad capture, medan toppvalet är borta. UI:t
målar active; toppvalet återtas när enheten syns igen.
_Avoid_: Preferred, remembered, default (se Device stack)
