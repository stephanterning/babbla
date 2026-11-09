# Operating Babbla

## Runtime interface

Run the image's default `node server.js` command. HTTP and WebSocket signaling
share `PORT` (8080 by default); the WebSocket endpoint is `/ws`. Use an HTTPS
reverse proxy that supports WebSocket upgrades outside localhost. The proxy,
DNS, certificates and deployment scheduling are operator choices.

Room state is in memory. Server restarts disconnect signaling temporarily;
clients implement reconnect and version-change restoration. Statistics are
in memory unless `STATS_DB_PATH` points to persistent writable storage. The
container runs as the unprivileged `node` user. Mount storage with appropriate
ownership and back up it together with the separately stored HMAC secret when
persistent statistics are required. Mount an operator-supplied ASN TSV read-only
and point `STATS_ASN_TSV` at its container path if ASN lookups are desired.

`GET /` returning the application is a basic HTTP smoke check, not proof of
working calls. Verify WebSocket joins and actual bidirectional media separately.
There is no built-in authentication for rooms or `/stats*`; apply access controls
at your chosen proxy where needed.

## TURN

TURN is a separate service or provider. Configure its reachable URLs and shared
secret, or the Cloudflare credential provider, through the documented environment
variables. Neither provider is tied to a particular environment name. See
[TURN design](turn-coturn.md) and [Cloudflare configuration](turn-cloudflare.md).

## Published images

The image name is `ghcr.io/<owner>/<repo>/app`. Branch builds publish
`sha-<full-40-character-commit>` after tests pass. Pull-request runs never publish.
A release such as `v0.2.0` assigns that version to the released commit's already
published image; creating a release before its build completes fails clearly and
can be retried after publication. A version tag cannot be reassigned to a
different digest by the release workflow.

Use the digest recorded in Actions when installing or rolling back. For example,
create an operator-owned Compose file with an `image:` reference instead of
`build:`, retain the same port/environment interface, and mount any required
storage. The image is identical across installation environments; do not rebuild
it to change configuration. Private packages require registry read access.

Repository visibility and package visibility are separate. Published images and
source retain the project's licensing terms; no license is inferred by CI.

Publishing an image or release does not contact or update any server. The
operator owns deployment, verification, rollback, backups and secret rotation.
