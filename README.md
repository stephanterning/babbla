# Babbla

Babbla is a full-duplex audio room: people sharing a room link can talk at the
same time, with optional cameras and screen sharing. WebRTC mesh connections
carry media between browsers; the Node.js server serves the UI and relays
signaling and presence. It is designed for small groups, typically 2–6 people.

## Run locally

Requires Node.js 24 or later:

```sh
npm ci
npm start
```

Open http://localhost:8080. Choose a room and share its `/room/<name>` URL.
`npm run dev` restarts the server when source files change.

Alternatively, with Docker Compose:

```sh
cp .env.example .env
docker compose up --build -d
```

The example publishes the app on `127.0.0.1:8080` and creates its own network;
no pre-existing proxy or network is required. Change `BIND_ADDRESS` and
`HTTP_PORT` in `.env` to suit your installation. Access outside localhost
requires HTTPS for microphone and camera permissions. See
[operations](docs/operations.md) and the generic [Caddy example](Caddyfile.example).

## Configure

The application reads settings from its process environment. Compose reads the
example `.env`; plain `npm start` does not load `.env` automatically.

- `PORT`: HTTP and WebSocket listener (default `8080`). WebSocket path: `/ws`.
- `APP_ENV`: optional environment label shown by the UI.
- `TURN_PROVIDER`, `TURN_URLS`, `TURN_SECRET`, `TURN_TTL_SECONDS`: optional TURN.
- `CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_TURN_API_TOKEN`: optional Cloudflare TURN.
- `STATS_DB_PATH`, `STATS_HMAC_SECRET`, `STATS_ASN_TSV`, `STATS_RETENTION_DAYS`:
  optional usage statistics configuration.

Without TURN configuration the app uses its public STUN fallback. Some networks
require a reachable TURN service. See [coturn](docs/turn-coturn.md),
[Cloudflare TURN](docs/turn-cloudflare.md) and [relay diagnostics](docs/relay-troubleshooting.md).
Keep credentials in private runtime configuration, never in source or images.

Rooms have no built-in access control. Statistics endpoints under `/stats` are
also unauthenticated; operators decide which endpoints to expose or protect at
their reverse proxy. See [statistics](docs/stats.md) for data and storage details.

## Test

```sh
npm test
npm run e2e
```

Unit and WebSocket integration tests run with Node.js. Browser suites need
Chrome; the existing full suite targets Linux with Chrome at
`/usr/bin/google-chrome-stable` and a display (for example Xvfb). Relay suites
start an isolated coturn process and skip when `turnserver` is unavailable.
Live relay checks require an explicit installation URL and do not run in CI:

```sh
npm run relay-check -- https://babbla.example.com
node scripts/relay-cloudflare-check.mjs https://babbla.example.com
```

Automated tests do not establish audible quality on real devices. For significant
media changes, verify a call between three people on separate networks with
simultaneous speech, camera/screen controls and reconnects.

## Published images

CI tests pull requests. Successful branch pushes and manual CI runs publish
multi-platform images (`linux/amd64`, `linux/arm64`) using full commit SHA tags.
The image name is derived from the repository: `ghcr.io/<owner>/<repo>/app`.
Re-running a commit preserves its existing image. There are no floating `main`
or `latest` tags. Releases add a version tag to an existing image without
rebuilding it. The Actions summary records its immutable digest.

Publishing a commit or release never deploys an installation. Operators select
images and supply their own hostnames, secrets, storage and network configuration.
See [image-based installation](docs/operations.md#published-images).

## Development

[CONTEXT.md](CONTEXT.md) describes domain vocabulary. [AGENTS.md](AGENTS.md)
summarizes architecture and contribution rules. Design notes under `docs/` cover
media recovery, device selection, echo cancellation and statistics.

This repository is currently private. An open-source license has not yet been
selected; image publication does not imply permission to redistribute the code.
