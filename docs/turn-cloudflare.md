# Cloudflare TURN

Babbla can obtain short-lived TURN credentials from Cloudflare Realtime. Media
remains WebRTC peer-to-peer; this does not add an SFU or change signaling hosting.

## Configuration

Supply these server-side environment variables for the chosen installation:

- `TURN_PROVIDER=cloudflare` enables Cloudflare credential issuance. The default
  `native` uses credentials generated from `TURN_SECRET` and `TURN_URLS`.
- `CLOUDFLARE_TURN_KEY_ID`: the TURN key created in Cloudflare Realtime.
- `CLOUDFLARE_TURN_API_TOKEN`: that key's API token. Keep it out of Git and logs.
- `TURN_TTL_SECONDS`: credential lifetime (default 3600; clamped to 60–86400).
- Optional `TURN_SECRET` and `TURN_URLS`: native fallback if issuance fails.

See Cloudflare's [credential API](https://developers.cloudflare.com/realtime/turn/generate-credentials/).
Each WebSocket session receives separate short-lived credentials. Requests time
out after three seconds; refreshes reuse session credentials until half their
lifetime remains and share in-flight requests. Only validated ICE URLs and
short-lived credentials reach clients, never the long-lived API token.

Successful responses advertise only Cloudflare TURN. Invalid responses, API
errors/timeouts or missing key configuration use the native fallback and retry
Cloudflare after 30 seconds. Without either provider, clients retain STUN-only
behavior. Logs do not print response bodies or credentials.

This fallback handles credential issuance. It does not automatically switch
providers when a particular client network cannot reach an otherwise valid relay.
The operator can change `TURN_PROVIDER` and restart their application instance.

## Verify connectivity

```sh
node scripts/relay-cloudflare-check.mjs https://babbla.example.com
```

The target URL is mandatory. Node.js 24 and Chrome are required; `CHROME_BIN`
overrides the browser path. The script uses two separate headless browsers with
synthetic microphones and isolated rooms, verifies Cloudflare-only relay paths
for UDP 3478 and TLS 443, and closes its browsers afterward. It checks increasing
audio RTP and relay traffic in both directions without printing credentials.
A relay candidate or successful allocation alone does not establish media flow.

`npm test` covers credential issuance, validation, renewal, native fallback,
timeouts, duplicate joins and leaving during asynchronous requests using mocked
responses. Those tests do not establish external provider availability. Verify
real calls from separate networks before relying on a chosen relay configuration.
