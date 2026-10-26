# LINQA

> Built with Arc Studio - money-powered apps in minutes

LINQA is a tile-based onchain game on Arc Testnet. Players stake USDC, select tiles row-by-row, and either cash out (multiplied payout) or lose their stake. The current source is contract version 3 with an 8% theoretical house edge, rejects deployments outside Arc Testnet (chain ID 5042002), and remains testnet simulation only; its block randomness is not suitable for real-value play.

## Deployed Contracts

The address below is the original version 1 deployment. It is retained as deployment history and is **not compatible with the version 3 frontend**. Do not send new-game transactions to it.

| Contract | Network | Address |
|---|---|---|
| LinqaGame | Arc Testnet | `0x3f0b40ef11de3b466244ea77c268e4fdf79d71c8` |

Explorer: https://explorer.testnet.arc.io/address/0x3f0b40ef11de3b466244ea77c268e4fdf79d71c8

## Env vars

- `VITE_LINQA_CONTRACT_ADDRESS` must point to a verified version 3 Arc Testnet deployment before gameplay is enabled. The checked-in deployment address is version 1 and the frontend intentionally disables new gameplay against it.

## What This App Does

LINQA is a single-screen premium tile game. Players stake USDC, pick tiles on each row to survive, and collect a multiplied payout on cashout. Version 2 uses `block.prevrandao` for testnet simulation; it is not provably fair and must not be enabled for real-value gameplay.

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
