# LINQA

> Built with Arc Studio - money-powered apps in minutes

LINQA is a tile-based onchain game on Arc Testnet. Players stake USDC, select tiles row-by-row, and either cash out (multiplied payout) or lose their stake. The current source is contract version 4 with an 8% theoretical house edge, rejects deployments outside Arc Testnet (chain ID 5042002), and remains testnet simulation only; its block randomness is not suitable for real-value play. Version 4 uses a round-scoped session key and server relayer for picks and cashout so players don't approve each action in their wallet; those actions still execute onchain.

## Deployed Contracts

The v4 address is the current Arc Testnet deployment. The v1 and v3 addresses are retained as deployment history; do not send new-game transactions to them.

| Contract | Network | Address |
|---|---|---|
| LinqaGame | Arc Testnet | `0x3f0b40ef11de3b466244ea77c268e4fdf79d71c8` |
| LinqaGame v3 | Arc Testnet | `0x1A7DE2Aa478A48aa75Ad39099B323E8B113A9A93` |
| LinqaGame v4 | Arc Testnet | `0x3fa58b5a0255953d11beb454dd32717d7aca1e42` |

Explorer: https://explorer.testnet.arc.io/address/0x3fa58b5a0255953d11beb454dd32717d7aca1e42

## Env vars

- `VITE_LINQA_CONTRACT_ADDRESS` and server-only `LINQA_CONTRACT_ADDRESS` must point to the same verified version 4 Arc Testnet deployment before gameplay is enabled. `LINQA_RELAYER_PRIVATE_KEY` is required server-side for sponsored actions. The existing v1/v3 contracts are historical, immutable deployments and must not receive new rounds after cutover.

## What This App Does

LINQA is a single-screen premium tile game. Players stake USDC, pick tiles on each row to survive, and collect a multiplied payout on cashout. Version 4 uses `block.prevrandao` for testnet simulation; it is not provably fair and must not be enabled for real-value gameplay.

## Tech Stack

- Frontend: React 18, Vite, TypeScript, Tailwind CSS
- Web3: wagmi v2, viem v2, ConnectKit
- Contracts: Solidity 0.8.28 + Foundry. Sources in `contracts/`, unit tests in `contracts/test/*.t.sol`. Build with `bun run contracts:build` (`forge build`), test with `bun run contracts:test` (`forge test`).
- Wallet: injected (MetaMask, etc.)
- Chain: Arc Testnet (Chain ID: 5042002, imported from `viem/chains`)
- Token: USDC (6 decimals) (Address: 0x3600000000000000000000000000000000000000, Chain: Arc Testnet)
- Toasts: Sonner

## Key Files

- `src/App.tsx` - Main application logic
- `src/components/` - UI components
- `src/config.ts` - wagmi config (chains, connectors, transports)

## To Run

```bash
bun install
bun run dev
```
