# Gas-sponsored Arc Testnet gameplay (contract v4)

## Player flow

The player's wallet approves the exact stake when allowance is insufficient, then sends one `startRoundWithSession` transaction that transfers the stake and registers a temporary, round-scoped browser key. Tile selections and cashout are signed locally by that key and submitted by `/api/relay`; the player's wallet does not show a transaction confirmation for those actions. The relayer still sends real Arc Testnet transactions and pays their USDC gas. A cashout transaction transfers USDC from the game contract directly to the player's wallet.

This is a testnet simulation only. Outcomes still use `block.prevrandao` and are not safe for real-value gameplay. A server relayer does not make the randomness provably fair.

## Scoped-session security

- The session key is created in the browser and stored only for the connected wallet and Arc Testnet. It can only sign tile picks and cashout for the round whose contract state registered it.
- The contract checks an EIP-712 signature over the player, round, action, tile, row secret, next commitment, nonce, deadline, chain and contract. Each round has a monotonic nonce, preventing replay.
- A session key cannot approve USDC, start a round, withdraw liquidity, or choose a payout destination. Payout always goes to the original player address.
- `relaySelectTile` advances the next row atomically after a safe pick, avoiding the second `advanceRow` call. Direct v3-style actions remain on the contract only as a recovery path if the browser session or relay is unavailable.
- The browser session key is stored in local storage. A same-origin script injection could use it to select a tile or cash out the active round early; it cannot transfer the player's wallet funds or redirect contract payout. Keep the frontend origin and dependencies protected.
- If the relay is unavailable, the round remains onchain. The player can reconnect and retry, or use the wallet-confirmed recovery path.

## Required Vercel environment

Set these as server-only environment variables, not `VITE_` variables:

- `LINQA_CONTRACT_ADDRESS`: the deployed v4 Arc Testnet contract address.
- `LINQA_RELAYER_PRIVATE_KEY`: a dedicated relayer wallet key. Never use the owner's main wallet key. The relayer wallet needs Arc Testnet USDC for gas; Arc uses USDC as its gas asset. The readiness check requires at least 10 USDC in this wallet before allowing a new round.
- `ARC_TESTNET_RPC_URL`: `https://rpc.testnet.arc.io` (optional; this is the default).
- `DATABASE_URL`: existing Neon pooled URL for history.
- `LINQA_ADMIN_TOKEN`: existing announcements admin token.

Also set `VITE_LINQA_CONTRACT_ADDRESS` to the same v4 address for the browser build. Do not put the relayer key under `VITE_`.

## Deployment and cutover

1. Resolve all active rounds on the existing v3 contract before switching the frontend. Its immutable code cannot be deleted. `removeLiquidity` returns only currently unreserved liquidity to the contract owner; outstanding round reserves stay in place.
2. Compile and test v4. With standard Foundry, deploy with `LINQA_INITIAL_LIQUIDITY_RAW=0`. Arc's USDC `transferFrom` invokes its blocklist check; standard Foundry simulation can fail at that Arc-specific call before broadcasting. This simulator trace does not prove the new game address is blocklisted. After V4 deploys, approve USDC for the new address, run `cast estimate` for `addLiquidity` against the live Arc RPC, and send the liquidity transaction only if that live estimate succeeds. If the estimate fails, stop and investigate; do not use `--skip-simulation` as a workaround.
3. Set the v4 contract address and dedicated relayer key in Vercel. Fund the relayer address with testnet USDC for gas.
4. Set the browser contract address to v4, then deploy the frontend/API. Test approval, round start, several safe picks, a loss, cashout, relay failure recovery, and history on Arc Testnet.

The new contract is a fresh deployment. It does not inherit v3 funds, round counters, session keys, or active rounds.
