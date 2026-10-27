# LINQA — Project Details

## What LINQA is

LINQA is a single-screen, tile-picking game being built for Arc. A player chooses a USDC stake, then picks one tile on each row. A safe pick advances the round and increases the displayed multiplier. The player can collect the displayed payout after a safe pick, or continue for a higher multiplier. Picking the losing tile ends the round and the stake is lost.

The current experience is for Arc Testnet. Testnet USDC has no real-world value, and the current outcome method is intended for testnet simulation only. The current game must not be presented or used as a production real-money game.

## How a round works

1. Connect an injected wallet on Arc Testnet and choose a stake. The interface currently accepts $0.50–$10,000 USDC.
2. Approve the game contract to transfer the stake when the token allowance is not sufficient.
3. Start a round. The contract records the stake, a temporary round-scoped session key, and the player's commitment to a secret.
4. Pick one tile in the active row. The browser signs the exact pick with the session key; a server relayer submits it, and the contract resolves and records the result onchain. Safe picks advance the row in the same transaction.
5. After a safe pick, either cash out or continue. Cashout is signed by the session key and relayed; the contract transfers the payout directly to the player's wallet. A losing pick ends the round and the stake is not returned.
6. A completed or cashed-out round shows its result, payout, multiplier, and transaction details. Round history is available in the interface.

The configured row pattern repeats `[4, 2, 4, 3, 4, 4, 5, 6]` and currently supports up to 27 rows. The base multiplier is `0.92x`, representing an 8% theoretical house edge in the contract's payout formula. Actual payout availability also depends on contract liquidity.

## What is being built

- A responsive game board that presents the tile rows, current multiplier, potential payout, and round state.
- Wallet connection and Arc Testnet transaction flows for stake approval and round start, followed by gas-sponsored, signature-authorized tile picks and cashout.
- Round result popups, transaction feedback, a round-history panel, and concise status messages.
- Contract-side stake limits, session-scoped authorization, replay-protected relayed actions, round state, payout reservations, and liquidity controls.
- A clear separation between the current testnet product and any future mainnet release.

## Current network and safety status

- Supported gameplay network: Arc Testnet, chain ID `5042002`.
- Token: testnet USDC, 6 decimals, address `0x3600000000000000000000000000000000000000`.
- The contract source identifies itself as game version 4 and uses `block.prevrandao` together with a player secret to resolve tile outcomes. This is not independently verifiable, secure randomness and is not appropriate for real-value play.
- Version 4 requires a new deployment and a server-only `LINQA_RELAYER_PRIVATE_KEY`; it is incompatible with the deployed version 3 contract. Keep new gameplay disabled until Vercel's browser and server contract addresses both point to a verified v4 Arc Testnet deployment and the relayer is funded.
- The frontend and current contract source both enforce a $0.50 minimum stake. The previously documented version 1 deployment predates this source and must not be treated as enforcing the current limits.

## Mainnet direction

Mainnet is a future goal, not a currently available game mode. A mainnet release should only be considered after the outcome system is redesigned around secure, independently verifiable randomness, the contract and payout model receive appropriate security review, the frontend and contract limits are aligned, and the production deployment and operations are ready. Until those conditions are met, LINQA remains an Arc Testnet experience using testnet assets.

## Project technology

- React, TypeScript, Vite, and Tailwind CSS for the interface.
- wagmi and viem for wallet and EVM interactions; ConnectKit for wallet connection.
- Solidity and Foundry for the game contract and contract tests.
- Arc Testnet as the only configured gameplay chain.

## Useful project files

- `src/components/LinqaGame.tsx` — round state and gameplay interactions.
- `src/components/LinqaBoard.tsx` — tile board display.
- `src/components/HistoryPanel.tsx` — round-history interface.
- `src/config.ts` — wallet and supported-chain configuration.
- `contracts/LinqaGame.sol` — game contract source.
- `contracts/test/LinqaGame.t.sol` — contract tests.
