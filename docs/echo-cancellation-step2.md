# Ekosläckning — steg 2 (om Chrome AEC inte räcker)

Steg 1 förlitar sig helt på **Chromes inbyggda ekosläckare (AEC3)**,
aktiverad via `getUserMedia`-constraints i `public/app.js`:

```js
audio: {
  echoCancellation: true,   // AEC3
  noiseSuppression: true,
  autoGainControl: true,
}
```

Det här dokumentet är planen för **om det inte räcker utan headset**.

## Varför detta är den svåra delen

Vårt kärnkoncept — "alla pratar i mun på varandra hela tiden" — är exakt det
scenario ekosläckare har svårast med: **double-talk** (du pratar samtidigt som
ekot från de andra kommer in i din mick). Under double-talk tvingas en AEC välja
mellan att släppa igenom eko eller klippa din egen röst. Det pressas dessutom
**konstant** här, inte bara ibland.

Viktigt att förstå: **äkta akustisk ekosläckning måste ske klient-side.** Den
behöver referenssignalen = exakt vad som spelades ut i *just den användarens*
högtalare, plus hur det studsade i *just det rummet*. Servern kan aldrig veta
det. Server-side går att göra brus-/eko-*reducering* i efterhand, men det är en
sämre krycka än riktig AEC vid källan. Därför ligger hela steg 2 i webbklienten.

## Beslutsgrind

Aktivera steg 2 **bara om** mätstickan failar specifikt på eko:

> Stör ekot samtalet märkbart för deltagare **utan** headset i ett normalt
> tyst rum vid måttlig volym?

- **Nej** → behåll steg 1, klart.
- **Ja** → implementera nedan i prioritetsordning, mät om efter varje steg.

## Åtgärder, i prioritetsordning

### 2a. Verifiera att AEC3 faktiskt är på (billigast)
- Logga faktiska track-settings: `track.getSettings()` ska visa
  `echoCancellation: true`. Vissa virtuella enheter/aggregat slår av det.
- Testa Chrome-flaggan för plattformens system-AEC vs WebRTC-AEC. Ibland ger
  den ena märkbart bättre resultat på en given maskin.
- Säkerställ måttlig utgångsvolym i UI (hög volym → ickelinjär distorsion som
  AEC inte modellerar).

### 2b. AI-baserad eko-/brusunderdrückning i browsern (WASM)
Lägg ett extra rensningssteg på det infångade ljudet **innan** det skickas,
körandes lokalt i klienten. Inget headset, inget server-beroende.

Kandidater:
- **RNNoise (WASM)** — lättviktig, öppen, främst brus men hjälper på residual-eko.
- **Krisp SDK / liknande kommersiell DNN** — bäst kvalitet på double-talk,
  licenskostnad.
- Egen liten DNN via **onnxruntime-web** om vi vill äga modellen.

Inkoppling via Web Audio + `AudioWorklet`:

```
getUserMedia(mic)
  → MediaStreamSource
  → AudioWorkletNode (RNNoise/DNN-processor)   // extra suppression
  → MediaStreamDestination
  → addTrack(processedStream)  // detta skickas till peers, inte rå micken
```

Notera: detta ligger **efter** Chromes AEC3 (som sitter i capture-pipen), så de
staplas — AEC3 tar grova ekot, DNN:en städar residualen.

### 2c. Web Audio-gating / ducking per röst (komplement)
- Mjuk **noise gate** på inkommande och/eller utgående ljud för att kapa låg
  nivå-läckage mellan inlägg.
- Lätt **ducking**: dämpa egen utgång marginellt när stark fjärrsignal spelas,
  för att minska feedback-loopen. Måste vara subtilt — annars dödar det
  duplex-känslan, vilket är hela poängen.

### 2d. Sista utväg: headset-rekommendation (inte krav)
Behåll det helt öppet, men visa en mjuk uppmaning i UI om vi upptäcker
högtalar-läckage. Vi har redan en hint i namn-vyn. Detta är medvetet **inte**
ett krav, per produktbeslut.

## Vad vi medvetet INTE gör
- **Ingen server-side mixning/MCU för att "lösa" eko** — fel verktyg, dödar
  P2P-latensen som ger "samma rum"-känslan, och kan ändå inte göra äkta AEC.
- **Ingen spatial audio** — bortvald produktmässigt.
- **Ingen push-to-talk / hård talar-gating** — det bryter "alla pratar
  samtidigt", vilket är själva idén.

## Mätning
Återanvänd mätstickan efter varje åtgärd:

> 3 personer på olika nät, utan headset, normalt rum — kan de prata samtidigt i
> 5 min utan att eko stör?

Logga subjektiv 1–5-skattning per deltagare före/efter varje steg så vi vet om
en åtgärd faktiskt hjälpte innan vi lägger till nästa.
