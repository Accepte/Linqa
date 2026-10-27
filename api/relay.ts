import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createPublicClient, createWalletClient, http, isAddress, verifyTypedData, type Address, type Hex } from 'viem'
import { neon } from '@neondatabase/serverless'
import { privateKeyToAccount } from 'viem/accounts'
import { arcTestnet } from 'viem/chains'

const CHAIN_ID = 5_042_002
const RELAYER_MIN_GAS_BALANCE = 10_000_000n // Keep at least 10 USDC available for sponsored gameplay.
const RPC_URL = process.env.ARC_TESTNET_RPC_URL ?? 'https://rpc.testnet.arc.io'
const CONTRACT_ADDRESS = process.env.LINQA_CONTRACT_ADDRESS as Address | undefined
const RELAYER_PRIVATE_KEY = process.env.LINQA_RELAYER_PRIVATE_KEY as Hex | undefined
const RELAY_ABI = [
  { type: 'function', name: 'gameVersion', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'relaySelectTile', stateMutability: 'nonpayable', inputs: [
    { name: 'player', type: 'address' }, { name: 'tileIndex', type: 'uint8' }, { name: 'secret', type: 'bytes32' },
    { name: 'nextCommitHash', type: 'bytes32' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
    { name: 'signature', type: 'bytes' },
  ], outputs: [] },
  { type: 'function', name: 'relayCashOut', stateMutability: 'nonpayable', inputs: [
    { name: 'player', type: 'address' }, { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' }, { name: 'signature', type: 'bytes' },
  ], outputs: [] },
  { type: 'function', name: 'getRelayNonce', stateMutability: 'view', inputs: [{ name: 'roundId', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'sessionKeyForRound', stateMutability: 'view', inputs: [{ name: 'roundId', type: 'uint256' }], outputs: [{ name: '', type: 'address' }] },
] as const
const USDC_ABI = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }] as const

const RELAY_ACTION_TYPES = {
  RelayAction: [
    { name: 'player', type: 'address' }, { name: 'roundId', type: 'uint256' }, { name: 'action', type: 'uint8' },
    { name: 'tileIndex', type: 'uint8' }, { name: 'secret', type: 'bytes32' }, { name: 'nextCommitHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
  ],
} as const

type ApiRequest = IncomingMessage & { body?: unknown; headers: IncomingMessage['headers'] }
type ApiResponse = ServerResponse

type RelayBody = {
  action?: unknown
  contractAddress?: unknown
  player?: unknown
  roundId?: unknown
  tileIndex?: unknown
  secret?: unknown
  nextCommitHash?: unknown
  nonce?: unknown
  deadline?: unknown
  signature?: unknown
}

let relaySchemaReady: Promise<void> | undefined

function relaySql() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('Relay database is not configured')
  return neon(url)
}

async function ensureRelaySchema() {
  if (!relaySchemaReady) {
    relaySchemaReady = (async () => {
      const sql = relaySql()
      await sql`CREATE TABLE IF NOT EXISTS linqa_relay_actions (
        contract_address text NOT NULL,
        round_id numeric(78,0) NOT NULL,
        nonce numeric(78,0) NOT NULL,
        player_address text NOT NULL,
        state text NOT NULL CHECK (state IN ('pending', 'submitted', 'failed')),
        tx_hash text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (contract_address, round_id, nonce)
      )`
      await sql`CREATE INDEX IF NOT EXISTS linqa_relay_actions_player_time_idx ON linqa_relay_actions (player_address, created_at DESC)`
      await sql`CREATE TABLE IF NOT EXISTS linqa_relayer_lock (
        id smallint PRIMARY KEY CHECK (id = 1),
        lease_until timestamptz NOT NULL,
        lease_token text
      )`
      await sql`ALTER TABLE linqa_relayer_lock ADD COLUMN IF NOT EXISTS lease_token text`
    })().catch(error => {
      relaySchemaReady = undefined
      throw error
    })
  }
  await relaySchemaReady
}

function json(res: ApiResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

async function readBody(req: ApiRequest): Promise<RelayBody> {
  if (req.body && typeof req.body === 'object') return req.body as RelayBody
  let raw = ''
  for await (const chunk of req) {
    raw += chunk.toString()
    if (raw.length > 8_192) throw new Error('Request body too large')
  }
  const parsed: unknown = raw ? JSON.parse(raw) : {}
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid request body')
  return parsed as RelayBody
}

function isBytes32(value: unknown): value is Hex {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)
}

function isSignature(value: unknown): value is Hex {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{130}$/.test(value)
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method === 'GET') {
    res.setHeader('Cache-Control', 'no-store')
    try {
      if (!CONTRACT_ADDRESS || !isAddress(CONTRACT_ADDRESS) || !RELAYER_PRIVATE_KEY || !/^0x[0-9a-fA-F]{64}$/.test(RELAYER_PRIVATE_KEY) || !process.env.DATABASE_URL) {
        return json(res, 503, { ready: false })
      }
      const account = privateKeyToAccount(RELAYER_PRIVATE_KEY)
      const client = createPublicClient({ chain: arcTestnet, transport: http(RPC_URL, { timeout: 12_000 }) })
      if (await client.getChainId() !== CHAIN_ID) return json(res, 503, { ready: false })
      const [version, gasBalance] = await Promise.all([
        client.readContract({ address: CONTRACT_ADDRESS, abi: RELAY_ABI, functionName: 'gameVersion' }),
        client.readContract({ address: '0x3600000000000000000000000000000000000000', abi: USDC_ABI, functionName: 'balanceOf', args: [account.address] }),
      ])
      if (version !== 4n || gasBalance < RELAYER_MIN_GAS_BALANCE) return json(res, 503, { ready: false })
      await ensureRelaySchema()
      return json(res, 200, { ready: true })
    } catch {
      return json(res, 503, { ready: false })
    }
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return json(res, 405, { error: 'Method not allowed' })
  }

  try {
    const body = await readBody(req)
    if (body.action !== 'selectTile' && body.action !== 'cashOut') return json(res, 400, { error: 'Invalid action' })
    if (typeof body.contractAddress !== 'string' || !isAddress(body.contractAddress)) return json(res, 400, { error: 'Invalid game contract' })
    if (typeof body.player !== 'string' || !isAddress(body.player)) return json(res, 400, { error: 'Invalid player address' })
    if (typeof body.roundId !== 'string' || !/^\d{1,78}$/.test(body.roundId)) return json(res, 400, { error: 'Invalid round id' })
    if (typeof body.nonce !== 'string' || !/^\d{1,78}$/.test(body.nonce)) return json(res, 400, { error: 'Invalid action nonce' })
    if (typeof body.deadline !== 'number' || !Number.isSafeInteger(body.deadline)) return json(res, 400, { error: 'Invalid deadline' })
    if (body.deadline < Math.floor(Date.now() / 1_000) || body.deadline > Math.floor(Date.now() / 1_000) + 300) {
      return json(res, 400, { error: 'Action signature expired or deadline is too long' })
    }
    if (!isSignature(body.signature)) return json(res, 400, { error: 'Invalid signature' })
    if (body.action === 'selectTile') {
      if (!Number.isInteger(body.tileIndex) || (body.tileIndex as number) < 0 || (body.tileIndex as number) > 5) return json(res, 400, { error: 'Invalid tile index' })
      if (!isBytes32(body.secret) || !isBytes32(body.nextCommitHash)) return json(res, 400, { error: 'Invalid round commitment' })
    }
    if (!CONTRACT_ADDRESS || !isAddress(CONTRACT_ADDRESS)) return json(res, 503, { error: 'Game relay is not configured' })
    if (body.contractAddress.toLowerCase() !== CONTRACT_ADDRESS.toLowerCase()) return json(res, 409, { error: 'The game and relay contract addresses do not match.' })
    if (!RELAYER_PRIVATE_KEY || !/^0x[0-9a-fA-F]{64}$/.test(RELAYER_PRIVATE_KEY)) return json(res, 503, { error: 'Game relay is not configured' })

    const account = privateKeyToAccount(RELAYER_PRIVATE_KEY)
    const publicClient = createPublicClient({ chain: arcTestnet, transport: http(RPC_URL, { timeout: 12_000 }) })
    const walletClient = createWalletClient({ account, chain: arcTestnet, transport: http(RPC_URL, { timeout: 12_000 }) })
    if (await publicClient.getChainId() !== CHAIN_ID) return json(res, 503, { error: 'Relay RPC is not connected to Arc Testnet' })

    const player = body.player as Address
    const roundId = BigInt(body.roundId)
    const nonce = BigInt(body.nonce)
    const deadline = BigInt(body.deadline)
    const signature = body.signature
    const address = CONTRACT_ADDRESS

    await ensureRelaySchema()
    const sql = relaySql()
    const existing = await sql`SELECT state, tx_hash, created_at, player_address FROM linqa_relay_actions
      WHERE contract_address = ${address.toLowerCase()} AND round_id = ${roundId.toString()} AND nonce = ${nonce.toString()}
      LIMIT 1`
    const existingAction = existing[0] as { state: string; tx_hash: string | null; created_at: Date | string; player_address: string } | undefined
    if (existingAction && existingAction.player_address !== player.toLowerCase()) return json(res, 409, { error: 'This round action is already claimed.' })
    if (existingAction?.state === 'submitted' && existingAction.tx_hash) {
      try {
        const priorReceipt = await publicClient.getTransactionReceipt({ hash: existingAction.tx_hash as Hex })
        if (priorReceipt.status === 'success') return json(res, 202, { txHash: existingAction.tx_hash })
        await sql`UPDATE linqa_relay_actions SET state = 'failed', updated_at = now()
          WHERE contract_address = ${address.toLowerCase()} AND round_id = ${roundId.toString()} AND nonce = ${nonce.toString()}`
      } catch {
        // The prior transaction may still be pending; return its hash so the client can keep waiting.
        return json(res, 202, { txHash: existingAction.tx_hash })
      }
    }
    if (existingAction?.state === 'pending') {
      const ageMs = Date.now() - new Date(existingAction.created_at).getTime()
      if (ageMs < 120_000) return json(res, 409, { error: 'This action is already being submitted. Wait briefly and refresh the round.' })
    }

    const sessionKey = await publicClient.readContract({ address, abi: RELAY_ABI, functionName: 'sessionKeyForRound', args: [roundId] })
    const chainNonce = await publicClient.readContract({ address, abi: RELAY_ABI, functionName: 'getRelayNonce', args: [roundId] })
    if (sessionKey === '0x0000000000000000000000000000000000000000' || chainNonce !== nonce) {
      return json(res, 409, { error: 'The round has advanced. Refresh the game before trying again.' })
    }
    const signatureAction = body.action === 'selectTile' ? 1 : 2
    const signatureTile = body.action === 'selectTile' ? body.tileIndex as number : 0
    const signatureSecret = body.action === 'selectTile' ? body.secret as Hex : `0x${'00'.repeat(32)}` as Hex
    const signatureNextCommit = body.action === 'selectTile' ? body.nextCommitHash as Hex : `0x${'00'.repeat(32)}` as Hex
    const validSignature = await verifyTypedData({
      address: sessionKey,
      domain: { name: 'LinqaGame', version: '4', chainId: CHAIN_ID, verifyingContract: address },
      types: RELAY_ACTION_TYPES,
      primaryType: 'RelayAction',
      message: {
        player,
        roundId,
        action: signatureAction,
        tileIndex: signatureTile,
        secret: signatureSecret,
        nextCommitHash: signatureNextCommit,
        nonce,
        deadline,
      },
      signature,
    })
    if (!validSignature) return json(res, 422, { error: 'This action signature is invalid. Please retry from the game.' })

    const leaseToken = randomUUID()
    const relayLock = await sql`INSERT INTO linqa_relayer_lock (id, lease_until, lease_token)
      VALUES (1, now() + interval '120 seconds', ${leaseToken})
      ON CONFLICT (id) DO UPDATE SET lease_until = EXCLUDED.lease_until, lease_token = EXCLUDED.lease_token
      WHERE linqa_relayer_lock.lease_until < now()
      RETURNING id`
    if (relayLock.length === 0) return json(res, 409, { error: 'The game relay is busy. Wait a moment and retry.' })
    try {
      const claim = await sql`INSERT INTO linqa_relay_actions (
        contract_address, round_id, nonce, player_address, state, created_at, updated_at
      ) VALUES (
        ${address.toLowerCase()}, ${roundId.toString()}, ${nonce.toString()}, ${player.toLowerCase()}, 'pending', now(), now()
      ) ON CONFLICT (contract_address, round_id, nonce) DO UPDATE SET
        player_address = EXCLUDED.player_address, state = 'pending', tx_hash = NULL, created_at = now(), updated_at = now()
      WHERE linqa_relay_actions.state = 'failed' OR linqa_relay_actions.created_at < now() - interval '2 minutes'
      RETURNING nonce`
      if (claim.length === 0) return json(res, 409, { error: 'This action is already being submitted. Wait briefly and refresh the round.' })

      let hash: Hex
      try {
      if (body.action === 'selectTile') {
        const args = [player, body.tileIndex as number, body.secret as Hex, body.nextCommitHash as Hex, nonce, deadline, signature] as const
        const request = await publicClient.simulateContract({ address, abi: RELAY_ABI, functionName: 'relaySelectTile', args, account })
        hash = await walletClient.writeContract(request.request)
      } else {
        const args = [player, nonce, deadline, signature] as const
        const request = await publicClient.simulateContract({ address, abi: RELAY_ABI, functionName: 'relayCashOut', args, account })
        hash = await walletClient.writeContract(request.request)
      }
      await sql`UPDATE linqa_relay_actions SET state = 'submitted', tx_hash = ${hash.toLowerCase()}, updated_at = now()
        WHERE contract_address = ${address.toLowerCase()} AND round_id = ${roundId.toString()} AND nonce = ${nonce.toString()}`
      return json(res, 202, { txHash: hash })
      } catch (error) {
        await sql`UPDATE linqa_relay_actions SET state = 'failed', updated_at = now()
          WHERE contract_address = ${address.toLowerCase()} AND round_id = ${roundId.toString()} AND nonce = ${nonce.toString()} AND state = 'pending'`.catch(() => undefined)
        throw error
      }
    } finally {
      await sql`UPDATE linqa_relayer_lock SET lease_until = now() WHERE id = 1 AND lease_token = ${leaseToken}`.catch(() => undefined)
    }
  } catch (error) {
    // Return a short message only; provider errors may contain internal request details.
    const message = error instanceof Error ? error.message : ''
    const status = /revert|signature|nonce|round|tile|stake|liquidity|active|deadline/i.test(message) ? 422 : 502
    return json(res, status, { error: status === 422 ? 'The action was rejected by the game contract. Refresh the game and retry.' : 'Could not submit the game action. Please retry.' })
  }
}
