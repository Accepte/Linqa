import type { IncomingMessage, ServerResponse } from 'node:http'
import { neon } from '@neondatabase/serverless'
import { createPublicClient, http, parseEventLogs, type Address, type Hex } from 'viem'
import { arcTestnet } from 'viem/chains'

const CHAIN_ID = 5_042_002
const RETENTION_DAYS = 90
const DEFAULT_CONTRACT = process.env.LINQA_CONTRACT_ADDRESS ?? process.env.VITE_LINQA_CONTRACT_ADDRESS
const CONTRACT_ADDRESS = DEFAULT_CONTRACT?.toLowerCase() as Address | undefined
const RPC_URL = process.env.ARC_TESTNET_RPC_URL ?? 'https://rpc.testnet.arc.io'
const ROUND_ABI = [
  { type: 'function', name: 'getRound', stateMutability: 'view', inputs: [{ name: 'roundId', type: 'uint256' }], outputs: [{ name: '', type: 'tuple', components: [
    { name: 'roundId', type: 'uint256' }, { name: 'player', type: 'address' }, { name: 'stake', type: 'uint256' },
    { name: 'rowIndex', type: 'uint256' }, { name: 'multiplierWAD', type: 'uint256' }, { name: 'status', type: 'uint8' },
    { name: 'commitHash', type: 'bytes32' }, { name: 'rowResultPending', type: 'bool' }, { name: 'losingTile', type: 'uint8' },
    { name: 'selectedTile', type: 'uint8' }, { name: 'wasSafe', type: 'bool' },
  ] }] },
  { type: 'event', name: 'TileSelected', inputs: [
    { name: 'roundId', type: 'uint256', indexed: true },
    { name: 'player', type: 'address', indexed: true },
    { name: 'rowIndex', type: 'uint256', indexed: false },
    { name: 'tileIndex', type: 'uint8', indexed: false },
    { name: 'safe', type: 'bool', indexed: false },
    { name: 'losingTile', type: 'uint8', indexed: false },
    { name: 'newMultiplierWAD', type: 'uint256', indexed: false },
  ] },
  { type: 'event', name: 'CashedOut', inputs: [
    { name: 'roundId', type: 'uint256', indexed: true },
    { name: 'player', type: 'address', indexed: true },
    { name: 'payout', type: 'uint256', indexed: false },
    { name: 'multiplierWAD', type: 'uint256', indexed: false },
  ] },
  { type: 'event', name: 'RoundLost', inputs: [
    { name: 'roundId', type: 'uint256', indexed: true },
    { name: 'player', type: 'address', indexed: true },
    { name: 'stake', type: 'uint256', indexed: false },
    { name: 'rowIndex', type: 'uint256', indexed: false },
  ] },
] as const

type ApiRequest = IncomingMessage & { body?: unknown }
type ApiResponse = ServerResponse
type RoundRow = {
  round_id: string
  player_address: string
  stake_raw: string
  payout_raw: string
  multiplier_wad: string
  won: boolean
  tx_hash: string
  created_at: Date | string
}

let schemaReady: Promise<void> | undefined

function json(res: ApiResponse, status: number, data: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(data))
}

async function readBody(req: ApiRequest): Promise<unknown> {
  if (req.body !== undefined) return req.body
  let body = ''
  for await (const chunk of req) {
    body += chunk.toString()
    if (body.length > 16_384) throw new Error('Request body too large')
  }
  return body ? JSON.parse(body) : {}
}

function getSql() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not configured')
  return neon(url)
}

async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      const sql = getSql()
      await sql`CREATE TABLE IF NOT EXISTS linqa_round_history (
        chain_id integer NOT NULL,
        contract_address text NOT NULL,
        round_id numeric(78,0) NOT NULL,
        player_address text NOT NULL,
        stake_raw numeric(78,0) NOT NULL,
        payout_raw numeric(78,0) NOT NULL,
        multiplier_wad numeric(78,0) NOT NULL,
        won boolean NOT NULL,
        tx_hash text NOT NULL,
        block_number numeric(78,0) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (chain_id, contract_address, round_id)
      )`
      await sql`CREATE INDEX IF NOT EXISTS linqa_round_history_player_time_idx ON linqa_round_history (chain_id, player_address, created_at DESC)`
      await sql`CREATE INDEX IF NOT EXISTS linqa_round_history_feed_time_idx ON linqa_round_history (created_at DESC)`
      await sql`CREATE TABLE IF NOT EXISTS linqa_announcements (
        id bigserial PRIMARY KEY,
        kind text NOT NULL CHECK (kind IN ('info', 'promo', 'warning')),
        message text NOT NULL,
        link_url text,
        starts_at timestamptz NOT NULL DEFAULT now(),
        ends_at timestamptz,
        enabled boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now()
      )`
      await sql`CREATE INDEX IF NOT EXISTS linqa_announcements_active_idx ON linqa_announcements (enabled, starts_at, ends_at)`
    })().catch(error => {
      schemaReady = undefined
      throw error
    })
  }
  await schemaReady
}

function toDisplayRound(row: RoundRow) {
  const cents = (raw: string) => {
    const value = BigInt(raw)
    const rounded = (value + 5_000n) / 10_000n
    return `${rounded / 100n}.${(rounded % 100n).toString().padStart(2, '0')}`
  }
  const multiplier = (BigInt(row.multiplier_wad) + 5_000_000_000_000_000n) / 10_000_000_000_000_000n
  const id = BigInt(row.round_id).toString()
  const date = row.created_at instanceof Date ? row.created_at : new Date(row.created_at)
  return {
    roundId: `TN${id.padStart(12, '0').slice(-12)}`,
    stake: cents(row.stake_raw),
    won: row.won,
    multiplier: `${multiplier / 100n}.${(multiplier % 100n).toString().padStart(2, '0')}x`,
    payout: cents(row.payout_raw),
    txHash: row.tx_hash,
    chainId: CHAIN_ID,
    createdAt: date.getTime(),
    playerAddress: row.player_address,
  }
}

async function saveVerifiedRound(txHash: Hex) {
  if (!/^0x[0-9a-f]{64}$/i.test(txHash)) throw new Error('Invalid transaction hash')
  if (!CONTRACT_ADDRESS || !/^0x[0-9a-f]{40}$/.test(CONTRACT_ADDRESS)) throw new Error('Linqa contract address is not configured')
  const client = createPublicClient({ chain: arcTestnet, transport: http(RPC_URL, { timeout: 12_000 }) })
  const [chainId, receipt, transaction] = await Promise.all([
    client.getChainId(),
    client.getTransactionReceipt({ hash: txHash }),
    client.getTransaction({ hash: txHash }),
  ])
  if (chainId !== CHAIN_ID || receipt.status !== 'success') throw new Error('Transaction is not a successful Arc Testnet transaction')
  if (!transaction.to || transaction.to.toLowerCase() !== CONTRACT_ADDRESS) throw new Error('Transaction does not target the configured Linqa contract')

  const gameLogs = receipt.logs.filter(log => log.address.toLowerCase() === CONTRACT_ADDRESS)
  const cashedOut = parseEventLogs({ abi: ROUND_ABI, logs: gameLogs, eventName: 'CashedOut', strict: false })[0]
  const lost = parseEventLogs({ abi: ROUND_ABI, logs: gameLogs, eventName: 'RoundLost', strict: false })[0]

  let roundId: bigint
  let player: Address
  let stake: bigint
  let payout: bigint
  let multiplierWad: bigint
  let won: boolean
  if (cashedOut) {
    roundId = cashedOut.args.roundId
    player = cashedOut.args.player
    payout = cashedOut.args.payout
    multiplierWad = cashedOut.args.multiplierWAD
    won = true
  } else if (lost) {
    roundId = lost.args.roundId
    player = lost.args.player
    stake = lost.args.stake
    payout = 0n
    won = false
    const selected = parseEventLogs({ abi: ROUND_ABI, logs: gameLogs, eventName: 'TileSelected', strict: false })
      .find(event => event.args.roundId === roundId && event.args.player.toLowerCase() === player.toLowerCase() && !event.args.safe)
    if (!selected) throw new Error('Loss could not be verified from its contract events')
    multiplierWad = selected.args.newMultiplierWAD
  } else {
    throw new Error('Transaction does not contain a completed Linqa round')
  }
  if (transaction.from.toLowerCase() !== player.toLowerCase()) throw new Error('Transaction sender does not match the round player')

  const storedRound = await client.readContract({
    address: CONTRACT_ADDRESS,
    abi: ROUND_ABI,
    functionName: 'getRound',
    args: [roundId],
  }) as readonly [bigint, Address, bigint, bigint, bigint, number]
  if (storedRound[1].toLowerCase() !== player.toLowerCase() || storedRound[2] <= 0n) throw new Error('Contract round state does not match its result event')
  if ((won && storedRound[5] !== 2) || (!won && storedRound[5] !== 3)) throw new Error('Contract round is not in a completed state')
  if (!won && storedRound[2] !== stake) throw new Error('Contract stake does not match its loss event')
  stake = storedRound[2]
  if (storedRound[4] !== multiplierWad) throw new Error('Contract multiplier does not match its result event')
  const minedBlock = await client.getBlock({ blockNumber: receipt.blockNumber })
  const playedAt = new Date(Number(minedBlock.timestamp) * 1_000).toISOString()

  await ensureSchema()
  const sql = getSql()
  await sql`INSERT INTO linqa_round_history (
    chain_id, contract_address, round_id, player_address, stake_raw, payout_raw,
    multiplier_wad, won, tx_hash, block_number, created_at
  ) VALUES (
    ${CHAIN_ID}, ${CONTRACT_ADDRESS}, ${roundId.toString()}, ${player.toLowerCase()},
    ${stake.toString()}, ${payout.toString()}, ${multiplierWad.toString()}, ${won},
    ${txHash.toLowerCase()}, ${receipt.blockNumber.toString()}, ${playedAt}
  ) ON CONFLICT (chain_id, contract_address, round_id) DO NOTHING`
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const sql = getSql()
    await ensureSchema()
    await sql`DELETE FROM linqa_round_history WHERE created_at < now() - interval '90 days'`

    if (req.method === 'GET') {
      const scope = url.searchParams.get('scope')
      const wallet = url.searchParams.get('wallet')?.toLowerCase()
      const parsedLimit = Number(url.searchParams.get('limit') ?? (scope === 'recent' ? 5 : 500))
      const limit = Number.isSafeInteger(parsedLimit) ? Math.min(2_000, Math.max(1, parsedLimit)) : 500
      let rows: RoundRow[]
      if (scope === 'recent') {
        rows = await sql`SELECT round_id::text, player_address, stake_raw::text, payout_raw::text,
            multiplier_wad::text, won, tx_hash, created_at
          FROM linqa_round_history WHERE chain_id = ${CHAIN_ID} AND contract_address = ${CONTRACT_ADDRESS}
            AND created_at >= now() - interval '90 days'
          ORDER BY created_at DESC LIMIT ${limit}` as RoundRow[]
      } else if (wallet && /^0x[0-9a-f]{40}$/.test(wallet)) {
        rows = await sql`SELECT round_id::text, player_address, stake_raw::text, payout_raw::text,
            multiplier_wad::text, won, tx_hash, created_at
          FROM linqa_round_history WHERE chain_id = ${CHAIN_ID} AND contract_address = ${CONTRACT_ADDRESS}
            AND player_address = ${wallet}
            AND created_at >= now() - interval '90 days'
          ORDER BY created_at DESC LIMIT ${limit}` as RoundRow[]
      } else {
        return json(res, 400, { error: 'A valid wallet address is required.' })
      }
      return json(res, 200, { rounds: rows.map(toDisplayRound), retentionDays: RETENTION_DAYS })
    }

    if (req.method === 'POST') {
      const body = await readBody(req) as { txHash?: unknown }
      if (typeof body.txHash !== 'string') return json(res, 400, { error: 'A transaction hash is required.' })
      await saveVerifiedRound(body.txHash as Hex)
      return json(res, 201, { saved: true })
    }

    res.setHeader('Allow', 'GET, POST')
    return json(res, 405, { error: 'Method not allowed.' })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Request failed'
    const status = message === 'Invalid transaction hash' ? 400
      : message.includes('not configured') ? 503
        : message.includes('not contain') || message.includes('could not be verified') || message.includes('does not') || message.includes('not a successful') ? 422
          : 500
    if (status === 500) console.error('History API request failed:', message)
    return json(res, status, { error: status === 500 ? 'History service is temporarily unavailable.' : message })
  }
}
