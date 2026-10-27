# LINQA Neon storage

The Vercel API stores completed Arc Testnet rounds in Neon. It reads the result, stake, payout, multiplier, player, and block number from the deployed contract and a successful transaction receipt. The browser sends only a transaction hash; the API ignores any client-supplied amount or outcome.

## Environment

- `DATABASE_URL`: the pooled Neon connection string. Keep it server-side; never name it `VITE_DATABASE_URL`.
- `LINQA_CONTRACT_ADDRESS`: recommended server-only copy of the active version 3 contract address. The API temporarily falls back to `VITE_LINQA_CONTRACT_ADDRESS` if this is not set.
- `ARC_TESTNET_RPC_URL`: optional; defaults to `https://rpc.testnet.arc.io`.
- `LINQA_ADMIN_TOKEN`: required only to create or disable saved announcements. Generate a long random value and add it to Vercel as a server-only environment variable before managing announcements.

Tables and indexes are created automatically by the API on first use. The database keeps up to 90 days of rounds; older rows are excluded and deleted when the history API is used. Player history is queried by wallet. The public recent feed endpoint is available for the future shared activity UI.

## API

- `GET /api/history?wallet=0x...&limit=500` returns up to 2,000 rounds for a wallet.
- `GET /api/history?scope=recent&limit=5` returns the newest public activity records, including the player address.
- `POST /api/history` with JSON `{"txHash":"0x..."}` validates and stores a completed round. Repeated submissions are safe.
- `GET /api/announcements` returns currently active promo, info, and warning messages.
- `GET /api/announcements` with `Authorization: Bearer <LINQA_ADMIN_TOKEN>` returns recent messages including disabled ones.
- `POST /api/announcements` with that bearer token creates an announcement. JSON fields: `kind` (`info`, `promo`, or `warning`), `message` (up to 240 characters), optional HTTPS `linkUrl`, optional ISO `startsAt` and `endsAt`.
- `DELETE /api/announcements?id=<id>` with that bearer token disables an announcement.

Message content is returned as plain text; render it as text, never as HTML. The admin token must never be included in browser code or a `VITE_` variable.

## Install dependency

The runtime uses Neon’s official serverless Postgres driver (`@neondatabase/serverless`). After adding that dependency, refresh and commit `bun.lock` with `bun install` before the eventual push/deploy.
