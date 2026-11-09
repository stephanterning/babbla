# Latensjustering — framtida hävstänger (ej aktuellt)

Plan/anteckning från en grilling-session. **Inget av detta är byggt eller bör
byggas nu** — det här är de två enda hävstänger som faktiskt skulle sänka
latensen märkbart, dokumenterade så att de inte behöver återupptäckas, och så
att vi slipper re-litigera de återvändsgränder vi redan avfärdat (kodecbyte,
ersätta jitterbufferten, QUIC).

## Varför inte nu

Mouth-to-ear-latensen (din mun → motpartens öra) i en direkt P2P-anslutning
ligger typiskt på **~90–110 ms**. "Samma rum"-känslan börjar inte degraderas
förrän norr om **~130–150 ms** enkelriktat, så vi har **~40–50 ms marginal**.
Den föreslagna brusreduceringen ("minska oljud": högpass + mjuk expander) lägger
bara på **~3–6 ms** — väl inom den marginalen, och mindre än jitterbufferens egen
sekund-till-sekund-variation. Att jaga transportlatens nu är alltså **prematur
optimering**.

`rtt`-siffran i diagnostik-panelen (från candidate-pair
`currentRoundTripTime` i `mesh.js`) är **nätverkets ping, inte ljudlatensen** —
enkel väg ≈ RTT/2. Den dominerar inte budgeten; det gör buffring + kodec.

De två största posterna i budgeten är de enda värda att röra:

| Post | Storlek | Natur |
| --- | --- | --- |
| Jitterbuffer (NetEQ, adaptiv) | ~20–60 ms (~40) | mottagarsidan, variabel |
| Opus-framing (= paketeringsintervall, `ptime`) | ~20 ms | sändarsidan, fast |

## Beslutsgrind

Rör **bara** detta om en **verklig "samtalet känns laggigt"-rapport** dyker upp
(inte en mikrooptimering på känsla). Vid ~95 ms ska ingen uppleva lagg. Mät
först (RTT + uppskattad mouth-to-ear), åtgärda en hävstång i taget, mät om.

## Hävstång 1 — sänk jitterbufferns mål (`jitterBufferTarget`)

Den **största** tillgängliga knappen. NetEQ är inbyggd i `RTCPeerConnection`s
mottagarväg och **går inte att byta ut** i browsern, men målstorleken kan hintas
nedåt:

- `RTCRtpReceiver.jitterBufferTarget` (nyare Chrome) eller äldre
  `playoutDelayHint`.

**Avvägning:** bufferten finns för att absorbera *variation i pakettankomst*
(jitter). Sänker man målet under nätets faktiska jitter får man dropouts /
robotljud (NetEQ tvingas dölja luckor). Därför:

- **Rent trådbundet/lågjitter-nät:** går att dra åt → reell vinst (tiotals ms).
- **WiFi/mobilt (högt jitter):** måste vara stort ändå — fysik, ingen mjukvara
  slår nätets jitter. Hinta inte ner blint; överväg adaptivt (lågt mål bara när
  uppmätt jitter är lågt).

## Hävstång 2 — Opus `ptime` 20 → 10 ms

De ~20 ms "Opus-framing" är i själva verket **paketeringsintervallet** (`ptime`),
inte en Opus-specifik kostnad. Halvera det → spara **~10 ms**.

- Påverkas via SDP (`maxptime`/`ptime`); Chromes efterlevnad är **partiell** men
  reell.

**Avvägning:** dubbelt så många paket → ~2× paket-header-overhead (mer
bandbredd), och i mesh:en multipliceras det **per peer**. Modest vinst, reell
kostnad. Behåller Opus kvalitet och förlusttålighet.

## Vad vi medvetet INTE gör (avfärdade vägar)

- **Byta kodec (Opus → G.711/G.722).** De ~20 ms är `ptime` (kodec-oberoende),
  så ett byte sparar bara kodecens *interna lookahead* (~2–6 ms) — och kostar
  ljudkvalitet: G.711 är **telefonkvalitet** (smalband 8 kHz, 64 kbps),
  G.722 smalare än Opus fullband. Direkt emot produktens "bättre ljud än
  Teams/Meet"-position. Dålig affär.
- **Ersätta NetEQ helt.** Enda vägen är att lämna `RTCPeerConnection`s mediaväg
  (rå PCM → WASM-kodec → datachannel/WebTransport → egen jitterbuffer). Det
  **dödar AEC3/NS/AGC** (Chromes capture-processing som ekosläckning + "minska
  oljud" bygger på), kräver att återimplementera PLC/klockdrift (år av NetEQ-
  trimning), behöver en server, och är **ändå** begränsat av nätets jitter.
  Enorm insats, sämre på alla axlar här.
- **QUIC / WebTransport för median.** Ljudet går redan på **UDP/SRTP**, som
  saknar exakt de problem QUIC löser (handskaknings-RTT, head-of-line-blockering)
  — realtidsljud vill ha *opålitlig, oordnad* leverans, inte pålitliga ordnade
  strömmar. Dessutom: browsern låter inte `RTCPeerConnection` köra median över
  QUIC, och den enda QUIC-mediavägen (WebTransport/HTTP3) är **klient↔server** →
  tvingar fram ett media-serverhopp som *lägger till* latens och bryter
  P2P/minimal-server-beslutet. QUIC rör ~0 av budgeten.

## Mätning

Återanvänd mouth-to-ear-resonemanget: notera `rtt` (panelen) + uppskatta total
budget, åtgärda en hävstång, mät om subjektivt (känns samtalet snabbare?) och
mot dropouts (blev ljudet hackigt?). En hävstång som ökar glitch utan märkbar
latensvinst ska backas.
