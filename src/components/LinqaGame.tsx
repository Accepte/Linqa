import { useState, useEffect, useCallback, useRef } from 'react'
import { useAccount, useWriteContract, useReadContract, useWaitForTransactionReceipt, useSwitchChain } from 'wagmi'
import { erc20Abi, keccak256, encodePacked, parseEventLogs, type Address } from 'viem'
import { arcTestnet } from 'viem/chains'
import { ConnectKitButton } from 'connectkit'
import { CircleAlert, Frown, History, Info, PartyPopper } from 'lucide-react'
import { toast } from 'sonner'
import { getUsdc } from '@/onchain-facts'
import { parseAmount, usdcDecimalsFor, Amount } from '@/onchain-money'
import LinqaBoard, { CONTRACT_ROW_PATTERN, createDemoRowPattern, DEMO_MAX_MULTIPLIER_WAD } from './LinqaBoard'
import HistoryPanel from './HistoryPanel'
import HowToPlayPanel from './HowToPlayPanel'
import RoundResultDialog, { type RoundOutcome } from './RoundResultDialog'
import type { GameRound } from './linqa-types'

// ─── Contract ────────────────────────────────────────────────────────────────
// Injected post-deploy via VITE_LINQA_CONTRACT_ADDRESS env var
// Fallback: zero address means "not deployed"
const CONTRACT_ADDRESS: Address = (import.meta.env.VITE_LINQA_CONTRACT_ADDRESS ?? '0x0000000000000000000000000000000000000000') as Address
// Local play mode keeps the game interactive without requiring a wallet or contract.
const LOCAL_DEMO_MODE: boolean = false

function createDemoGameId(): string {
  // Demo IDs are display-only. Use browser cryptographic randomness for a compact
  // 12-digit suffix; onchain IDs use the contract's collision-free round counter.
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  const value = bytes.reduce((number, byte) => (number << 8n) | BigInt(byte), 0n) % 1_000_000_000_000n
  return `DM${value.toString().padStart(12, '0')}`
}

function createContractGameId(roundId: bigint, chainId: number): string {
  const prefix = chainId === arcTestnet.id ? 'TN' : 'MN'
  return `${prefix}${roundId.toString().padStart(12, '0').slice(-12)}`
}

const LINQA_ABI = [
  { name: 'gameVersion', type: 'function', stateMutability: 'pure', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'startRound', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'stakeAmount', type: 'uint256' }, { name: 'commitHash', type: 'bytes32' }], outputs: [] },
  { name: 'selectTile', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'tileIndex', type: 'uint8' }, { name: 'secret', type: 'bytes32' }], outputs: [] },
  { name: 'advanceRow', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'newCommitHash', type: 'bytes32' }], outputs: [] },
  { name: 'cashOut', type: 'function', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { name: 'getActiveRound', type: 'function', stateMutability: 'view', inputs: [{ name: 'player', type: 'address' }], outputs: [{ name: '', type: 'tuple', components: [
    { name: 'roundId', type: 'uint256' }, { name: 'player', type: 'address' }, { name: 'stake', type: 'uint256' },
    { name: 'rowIndex', type: 'uint256' }, { name: 'multiplierWAD', type: 'uint256' },
    { name: 'status', type: 'uint8' }, { name: 'commitHash', type: 'bytes32' },
    { name: 'rowResultPending', type: 'bool' }, { name: 'losingTile', type: 'uint8' },
    { name: 'selectedTile', type: 'uint8' }, { name: 'wasSafe', type: 'bool' }
  ]}] },
  { name: 'getAvailableLiquidity', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'getRowTileCount', type: 'function', stateMutability: 'pure', inputs: [{ name: 'rowIndex', type: 'uint256' }], outputs: [{ name: '', type: 'uint8' }] },
  { name: 'getMultiplierAtRow', type: 'function', stateMutability: 'pure', inputs: [{ name: 'rowIndex', type: 'uint256' }], outputs: [{ name: 'multiplierWAD', type: 'uint256' }] },
  { name: 'isTestnetSimulation', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'bool' }] },
  { name: 'activeRound', type: 'function', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  {
    name: 'RoundStarted', type: 'event', inputs: [
      { name: 'roundId', type: 'uint256', indexed: true },
      { name: 'player', type: 'address', indexed: true },
      { name: 'stake', type: 'uint256', indexed: false }
    ]
  },
  {
    name: 'TileSelected', type: 'event', inputs: [
      { name: 'roundId', type: 'uint256', indexed: true },
      { name: 'player', type: 'address', indexed: true },
      { name: 'rowIndex', type: 'uint256', indexed: false },
      { name: 'tileIndex', type: 'uint8', indexed: false },
      { name: 'safe', type: 'bool', indexed: false },
      { name: 'losingTile', type: 'uint8', indexed: false },
      { name: 'newMultiplierWAD', type: 'uint256', indexed: false }
    ]
  },
  {
    name: 'CashedOut', type: 'event', inputs: [
      { name: 'roundId', type: 'uint256', indexed: true },
      { name: 'player', type: 'address', indexed: true },
      { name: 'payout', type: 'uint256', indexed: false },
      { name: 'multiplierWAD', type: 'uint256', indexed: false }
    ]
  },
  {
    name: 'RoundLost', type: 'event', inputs: [
      { name: 'roundId', type: 'uint256', indexed: true },
      { name: 'player', type: 'address', indexed: true },
      { name: 'stake', type: 'uint256', indexed: false },
      { name: 'rowIndex', type: 'uint256', indexed: false }
    ]
  },
] as const

// ─── Constants ───────────────────────────────────────────────────────────────
const WAD = 1_000_000_000_000_000_000n
const BASE_MULTIPLIER = 920_000_000_000_000_000n
const MIN_STAKE_RAW = 500_000n // $0.50 USDC (6 decimals)
const MAX_STAKE_RAW = 10_000_000_000n // $10,000 USDC (6 decimals)

function formatMultiplier(wadValue: bigint): string {
  const scaled = Number(wadValue) / 1e18
  return scaled.toFixed(2) + 'x'
}

function formatUsdc6(raw: bigint, chainId: number): string {
  const dec = usdcDecimalsFor(chainId)
  return Amount.fromRaw(raw, dec).toFixed(2)
}

function formatUsdc6Rounded(raw: bigint, chainId: number): string {
  const decimals = usdcDecimalsFor(chainId)
  if (decimals <= 2) return formatUsdc6(raw, chainId)
  const cent = 10n ** BigInt(decimals - 2)
  const roundedRaw = ((raw + cent / 2n) / cent) * cent
  return formatUsdc6(roundedRaw, chainId)
}

function conciseGameError(message: string): string {
  const normalized = message.toLowerCase()
  if (normalized.includes('minimum stake')) return 'Minimum stake is $0.50 USDC.'
  if (normalized.includes('maximum stake')) return 'Maximum stake is $10,000 USDC.'
  if (normalized.includes('invalid stake') || normalized.includes('enter a stake')) return 'Enter a valid stake.'
  if (normalized.includes('cancelled') || normalized.includes('user rejected')) return 'Wallet request cancelled.'
  if (normalized.includes('row key')) return 'Round key missing. Cash out safely.'
  if (normalized.includes('tile result')) return 'Tile result unavailable. Refresh to retry.'
  if (normalized.includes('round state')) return 'Round state unavailable. Refresh to retry.'
  if (normalized.includes('payout event')) return 'Payout not confirmed. Check transaction.'
  if (normalized.includes('approval')) return 'Approval failed. Please retry.'
  if (normalized.includes('advance')) return 'Could not continue round.'
  if (normalized.includes('cash out') || normalized.includes('cashout')) return 'Cashout failed. Please retry.'
  if (normalized.includes('start')) return 'Could not start game. Please retry.'
  if (normalized.includes('transaction')) return 'Transaction failed. Please retry.'
  return 'Something went wrong. Please try again.'
}

// ─── Secret generation ────────────────────────────────────────────────────────
function generateSecret(): `0x${string}` {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return ('0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`
}

function computeCommitHash(secret: `0x${string}`): `0x${string}` {
  return keccak256(encodePacked(['bytes32'], [secret]))
}

const HISTORY_STORAGE_KEY = 'linqa_round_history_v1'

function secretsStorageKey(address: Address, chainId: number): string {
  return `linqa_round_secrets_v1:${chainId}:${address.toLowerCase()}`
}

function readSecrets(address: Address, chainId: number): `0x${string}`[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(secretsStorageKey(address, chainId)) ?? '[]')
    return Array.isArray(value) && value.every(item => item === '' || (typeof item === 'string' && /^0x[\da-f]{64}$/i.test(item)))
      ? value as `0x${string}`[]
      : []
  } catch {
    return []
  }
}

function saveSecrets(address: Address, chainId: number, secrets: `0x${string}`[]): void {
  try {
    localStorage.setItem(secretsStorageKey(address, chainId), JSON.stringify(secrets))
  } catch {
    // The round can still be played in memory if browser storage is unavailable.
  }
}

function clearSecrets(address: Address | undefined, chainId: number): void {
  if (!address) return
  try {
    localStorage.removeItem(secretsStorageKey(address, chainId))
  } catch {
    // Clearing local storage is best-effort; no transaction depends on it.
  }
}

function readHistory(): GameRound[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(HISTORY_STORAGE_KEY) ?? '[]')
    return Array.isArray(value) ? value as GameRound[] : []
  } catch {
    return []
  }
}

// ─── Game state types ─────────────────────────────────────────────────────────
type TxPhase = 'idle' | 'approving' | 'starting' | 'selecting' | 'advancing' | 'cashingout'
type RoundPhase = 'idle' | 'active' | 'result_pending' | 'collectable' | 'won' | 'lost'

interface RowReveal {
  rowIndex: number
  selectedTile: number
  losingTile: number
  safe: boolean
}

interface LinqaActionButtonProps {
  label: string
  hoverLabel: string
  variant: 'standard' | 'cashout'
  onClick?: () => void
  disabled: boolean
}

function LinqaActionButton({ label, hoverLabel, variant, onClick, disabled }: LinqaActionButtonProps) {
  return (
    <button className={`linqa-start-button${variant === 'cashout' ? ' linqa-start-button--cashout' : ''}`} onClick={onClick} disabled={disabled} aria-label={label}>
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36" width="36" height="36" aria-hidden="true">
        <path fill="#e53935" d="M38.67,42H11.52C11.27,40.62,11,38.57,11,36c0-5,0-11,0-11s1.44-7.39,3.22-9.59 c1.67-2.06,2.76-3.48,6.78-4.41c3-0.7,7.13-0.23,9,1c2.15,1.42,3.37,6.67,3.81,11.29c1.49-0.3,5.21,0.2,5.5,1.28 C40.89,30.29,39.48,38.31,38.67,42z" />
        <path fill="#b71c1c" d="M39.02,42H11.99c-0.22-2.67-0.48-7.05-0.49-12.72c0.83,4.18,1.63,9.59,6.98,9.79 c3.48,0.12,8.27,0.55,9.83-2.45c1.57-3,3.72-8.95,3.51-15.62c-0.19-5.84-1.75-8.2-2.13-8.7c0.59,0.66,3.74,4.49,4.01,11.7 c0.03,0.83,0.06,1.72,0.08,2.66c4.21-0.15,5.93,1.5,6.07,2.35C40.68,33.85,39.8,38.9,39.02,42z" />
        <path fill="#212121" d="M35,27.17c0,3.67-0.28,11.2-0.42,14.83h-2C32.72,38.42,33,30.83,33,27.17 c0-5.54-1.46-12.65-3.55-14.02c-1.65-1.08-5.49-1.48-8.23-0.85c-3.62,0.83-4.57,1.99-6.14,3.92L15,16.32 c-1.31,1.6-2.59,6.92-3,8.96v10.8c0,2.58,0.28,4.61,0.54,5.92H10.5c-0.25-1.41-0.5-3.42-0.5-5.92l0.02-11.09 c0.15-0.77,1.55-7.63,3.43-9.94l0.08-0.09c1.65-2.03,2.96-3.63,7.25-4.61c3.28-0.76,7.67-0.25,9.77,1.13 C33.79,13.6,35,22.23,35,27.17z" />
        <path fill="#01579b" d="M17.165,17.283c5.217-0.055,9.391,0.283,9,6.011c-0.391,5.728-8.478,5.533-9.391,5.337 c-0.913-0.196-7.826-0.043-7.696-5.337C9.209,18,13.645,17.32,17.165,17.283z" />
        <path fill="#212121" d="M40.739,37.38c-0.28,1.99-0.69,3.53-1.22,4.62h-2.43c0.25-0.19,1.13-1.11,1.67-4.9 c0.57-4-0.23-11.79-0.93-12.78c-0.4-0.4-2.63-0.8-4.37-0.89l0.1-1.99c1.04,0.05,4.53,0.31,5.71,1.49 C40.689,24.36,41.289,33.53,40.739,37.38z" />
        <path fill="#81d4fa" d="M10.154,20.201c0.261,2.059-0.196,3.351,2.543,3.546s8.076,1.022,9.402-0.554 c1.326-1.576,1.75-4.365-0.891-5.267C19.336,17.287,12.959,16.251,10.154,20.201z" />
        <path fill="#212121" d="M17.615,29.677c-0.502,0-0.873-0.03-1.052-0.069c-0.086-0.019-0.236-0.035-0.434-0.06 c-5.344-0.679-8.053-2.784-8.052-6.255c0.001-2.698,1.17-7.238,8.986-7.32l0.181-0.002c3.444-0.038,6.414-0.068,8.272,1.818 c1.173,1.191,1.712,3,1.647,5.53c-0.044,1.688-0.785,3.147-2.144,4.217C22.785,29.296,19.388,29.677,17.615,29.677z M17.086,17.973 c-7.006,0.074-7.008,4.023-7.008,5.321c-0.001,3.109,3.598,3.926,6.305,4.27c0.273,0.035,0.48,0.063,0.601,0.089 c0.563,0.101,4.68,0.035,6.855-1.732c0.865-0.702,1.299-1.57,1.326-2.653c0.051-1.958-0.301-3.291-1.073-4.075c-1.262-1.281-3.834-1.255-6.825-1.222L17.086,17.973z" />
        <path fill="#e1f5fe" d="M15.078,19.043c1.957-0.326,5.122-0.529,4.435,1.304c-0.489,1.304-7.185,2.185-7.185,0.652 C12.328,19.467,15.078,19.043,15.078,19.043z" />
      </svg>
      <span className="linqa-start-button__label play">{label}</span>
      <span className="linqa-start-button__label now">{hoverLabel}</span>
    </button>
  )
}
export default function LinqaGame() {
  const { address, isConnected, chainId: walletChainId } = useAccount()
  const { switchChain } = useSwitchChain()

  const targetChainId = arcTestnet.id

  // Game state
  const [stakeInput, setStakeInput] = useState('1')
  const [roundPhase, setRoundPhase] = useState<RoundPhase>('idle')
  const [demoRowPattern, setDemoRowPattern] = useState<number[]>(createDemoRowPattern)
  const [txPhase, setTxPhase] = useState<TxPhase>('idle')
  const [currentMultiplierWAD, setCurrentMultiplierWAD] = useState<bigint>(BASE_MULTIPLIER)
  const [currentRowIndex, setCurrentRowIndex] = useState(0)
  const [reveals, setReveals] = useState<RowReveal[]>([])
  const [lastResult, setLastResult] = useState<{ type: 'won' | 'lost' | 'collectable'; amount?: string } | null>(null)
  const [resultOutcome, setResultOutcome] = useState<RoundOutcome | null>(null)
  const [currentGameId, setCurrentGameId] = useState<string | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  const [showHowToPlay, setShowHowToPlay] = useState(false)
  const [historyRounds, setHistoryRounds] = useState<GameRound[]>(readHistory)
  const [hasCurrentSecret, setHasCurrentSecret] = useState(false)
  const [pendingTileIndex, setPendingTileIndex] = useState<number | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  // Secrets per row
  const secretsRef = useRef<`0x${string}`[]>([])
  const currentRoundIdRef = useRef<bigint>(0n)
  const autoAdvanceRef = useRef(false)

  useEffect(() => {
    const app = document.querySelector('.linqa-root') as HTMLElement | null
    const content = app?.querySelector('.linqa-fit-content') as HTMLElement | null
    if (!app || !content) return
    const header = app.querySelector('.linqa-header') as HTMLElement | null

    const updateLayout = () => {
      // On phones, fit the fixed board viewport and controls together when
      // possible; longer tile ladders scroll inside the board itself.
      content.style.zoom = '1'
      content.style.width = '100%'
      app.style.setProperty('--linqa-fit-scale', '1')
      const viewportHeight = window.visualViewport?.height || window.innerHeight
      const isPhone = window.matchMedia('(max-width: 760px)').matches
      const rootStyle = window.getComputedStyle(app)
      const rootVerticalPadding = (parseFloat(rootStyle.paddingTop) || 0) + (parseFloat(rootStyle.paddingBottom) || 0)
      const headerHeight = header?.getBoundingClientRect().height || 0
      // The wrapper flexes to the viewport, so its scrollHeight includes blank
      // flex space. Sum the real content blocks instead of that stretched box.
      const naturalHeight = Array.from(content.children).reduce((height, child) => {
        const element = child as HTMLElement
        const style = window.getComputedStyle(element)
        return height + element.getBoundingClientRect().height
          + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0)
      }, rootVerticalPadding)
      const fitScale = isPhone && naturalHeight > 0
        ? Math.min(1, Math.max(0.5, (viewportHeight - headerHeight - 12) / naturalHeight))
        : 1
      app.style.setProperty('--linqa-fit-scale', String(fitScale))
      const viewportWidth = window.visualViewport?.width || window.innerWidth
      const resultScale = Math.max(0.5, Math.min(
        fitScale,
        (viewportWidth - 48) / 380,
        (viewportHeight - 48) / 420,
      ))
      app.style.setProperty('--linqa-result-scale', String(resultScale))
      content.style.zoom = String(fitScale)
      content.style.width = `${100 / fitScale}%`

      const board = document.querySelector('.linqa-board-wrap')
      if (board) {
        const appTop = app.getBoundingClientRect().top
        const boardBottom = board.getBoundingClientRect().bottom
        // The content wrapper is zoomed, but these DOMRect values already
        // report the rendered on-screen position. Do not scale them again.
        const split = boardBottom - appTop
        app.style.setProperty('--linqa-bg-split', `${Math.round(split)}px`)
      }
    }
    let frame = 0
    const scheduleUpdate = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(updateLayout)
    }
    // Do not use ResizeObserver here: applying browser zoom changes the
    // observed boxes and would feed another measurement back into itself.
    const contentObserver = new MutationObserver(scheduleUpdate)
    contentObserver.observe(content, { childList: true, characterData: true, subtree: true })
    scheduleUpdate()
    window.addEventListener('resize', scheduleUpdate)
    window.addEventListener('orientationchange', scheduleUpdate)
    window.visualViewport?.addEventListener('resize', scheduleUpdate)
    document.fonts?.ready.then(scheduleUpdate)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', scheduleUpdate)
      window.removeEventListener('orientationchange', scheduleUpdate)
      window.visualViewport?.removeEventListener('resize', scheduleUpdate)
      contentObserver.disconnect()
      content.style.zoom = ''
      content.style.width = ''
      app.style.removeProperty('--linqa-fit-scale')
      app.style.removeProperty('--linqa-result-scale')
      app.style.removeProperty('--linqa-bg-split')
    }
  }, [roundPhase])

  const usdc = getUsdc(targetChainId)
  const usdcAddress = usdc?.address as Address | undefined

  // ── Contract reads ──────────────────────────────────────────────────────────
  const { data: activeRoundData, refetch: refetchRound } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: LINQA_ABI,
    functionName: 'getActiveRound',
    args: address ? [address] : undefined,
    chainId: targetChainId,
    query: { enabled: !LOCAL_DEMO_MODE && !!address && CONTRACT_ADDRESS !== '0x0000000000000000000000000000000000000000' },
  })

  const { data: deployedGameVersion, isLoading: isCheckingGameVersion } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: LINQA_ABI,
    functionName: 'gameVersion',
    chainId: targetChainId,
    query: { enabled: !LOCAL_DEMO_MODE && CONTRACT_ADDRESS !== '0x0000000000000000000000000000000000000000' },
  })

  const { data: usdcBalance, refetch: refetchBalance } = useReadContract({
    address: usdcAddress,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: targetChainId,
    // Display a connected wallet's selected-network USDC balance even while
    // the game itself is in local demo mode. This is a read-only token query.
    query: { enabled: !!address && !!usdcAddress },
  })

  const { data: usdcAllowance, refetch: refetchAllowance } = useReadContract({
    address: usdcAddress,
    abi: erc20Abi,
    functionName: 'allowance',
    args: address && CONTRACT_ADDRESS ? [address, CONTRACT_ADDRESS] : undefined,
    chainId: targetChainId,
    query: { enabled: !LOCAL_DEMO_MODE && !!address && !!usdcAddress && CONTRACT_ADDRESS !== '0x0000000000000000000000000000000000000000' },
  })

  // ── Write hooks ─────────────────────────────────────────────────────────────
  const { writeContract, data: writeTxHash, isPending: isWritePending, isError: isWriteError, error: writeError, reset: resetWrite } = useWriteContract()
  const { isLoading: isTxConfirming, isSuccess: isTxSuccess, isError: isTxError, error: txError, data: receipt } = useWaitForTransactionReceipt({ hash: writeTxHash })

  // ── Sync active round from chain on load ────────────────────────────────────
  useEffect(() => {
    if (!activeRoundData) return
    const r = activeRoundData as { roundId: bigint; status: number; rowIndex: bigint; multiplierWAD: bigint; rowResultPending: boolean; losingTile: number; selectedTile: number; wasSafe: boolean }
    if ((r.status === 1 /* Active */ || r.status === 2 /* Won */) && r.roundId !== 0n) {
      currentRoundIdRef.current = r.roundId
      setCurrentGameId(createContractGameId(r.roundId, targetChainId))
      setCurrentRowIndex(Number(r.rowIndex))
      setCurrentMultiplierWAD(r.multiplierWAD)
      secretsRef.current = address ? readSecrets(address, targetChainId) : []
      setHasCurrentSecret(!!secretsRef.current[Number(r.rowIndex)])
      if (r.status === 2) {
        setRoundPhase('collectable')
        setReveals(prev => prev.some(item => item.rowIndex === Number(r.rowIndex)) ? prev : [...prev, {
          rowIndex: Number(r.rowIndex), selectedTile: r.selectedTile, losingTile: r.losingTile, safe: r.wasSafe,
        }])
      } else if (r.rowResultPending) {
        setRoundPhase('result_pending')
        setReveals(prev => prev.some(item => item.rowIndex === Number(r.rowIndex)) ? prev : [...prev, {
          rowIndex: Number(r.rowIndex), selectedTile: r.selectedTile, losingTile: r.losingTile, safe: r.wasSafe,
        }])
        autoAdvanceRef.current = true
      } else {
        setRoundPhase('active')
        if (!secretsRef.current[Number(r.rowIndex)]) {
          setErrorMsg('This round was restored, but its current row key is missing. Cash out to safely end the round.')
        }
      }
    }
  }, [activeRoundData, address, targetChainId])

  // ── Track tx completion ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!isTxSuccess || !receipt) return
    const hash = writeTxHash

    if (txPhase === 'approving') {
      setTxPhase('idle')
      void refetchAllowance()
      toast.success('Approval confirmed')
    } else if (txPhase === 'starting') {
      setTxPhase('idle')
      setRoundPhase('active')
      const started = parseEventLogs({ abi: LINQA_ABI, logs: receipt.logs, eventName: 'RoundStarted', strict: true })
        .find(event => event.address.toLowerCase() === CONTRACT_ADDRESS.toLowerCase())
      if (started) {
        currentRoundIdRef.current = started.args.roundId
        setCurrentGameId(createContractGameId(started.args.roundId, targetChainId))
      }
      void refetchRound()
      void refetchBalance()
      toast.success('Round started')
    } else if (txPhase === 'selecting') {
      const selection = parseEventLogs({ abi: LINQA_ABI, logs: receipt.logs, eventName: 'TileSelected', strict: true })
        .find(event => event.address.toLowerCase() === CONTRACT_ADDRESS.toLowerCase())
      if (!selection) {
        setTxPhase('idle')
        setErrorMsg('The transaction confirmed, but the tile result could not be read. Refresh the game state before continuing.')
        void refetchRound()
        return
      }
      const eventArgs = selection.args
      const rowIndex = Number(eventArgs.rowIndex)
      const reveal: RowReveal = {
        rowIndex,
        selectedTile: Number(eventArgs.tileIndex),
        losingTile: Number(eventArgs.losingTile),
        safe: eventArgs.safe,
      }
      setReveals(prev => [...prev, reveal])
      setPendingTileIndex(null)
      const revealedSecrets = [...secretsRef.current]
      revealedSecrets[rowIndex] = '' as `0x${string}`
      secretsRef.current = revealedSecrets
      if (address) saveSecrets(address, targetChainId, revealedSecrets)

      if (eventArgs.safe) {
        void refetchRound().then(({ data }) => {
          const r = data as { roundId: bigint; status: number; rowIndex: bigint; multiplierWAD: bigint; rowResultPending: boolean; losingTile: number; selectedTile: number; wasSafe: boolean; stake: bigint } | undefined
          const newMultiplier = eventArgs.newMultiplierWAD
          setCurrentMultiplierWAD(newMultiplier)
          if (r?.status === 2 /* Won — full board complete; payout still needs claiming */) {
            const payout = (r.stake * newMultiplier) / WAD
            setLastResult({ type: 'collectable', amount: formatUsdc6Rounded(payout, targetChainId) })
          } else {
            setLastResult(null)
          }
          window.setTimeout(() => {
            setTxPhase('idle')
            if (r?.status === 2) {
              setRoundPhase('collectable')
            } else {
              setHasCurrentSecret(!!secretsRef.current[rowIndex + 1])
              autoAdvanceRef.current = true
              setRoundPhase('result_pending')
            }
          }, 900)
        }).catch(() => {
          setTxPhase('idle')
          setErrorMsg('The tile was revealed, but the latest round state could not be loaded. Refresh before continuing.')
          void refetchRound()
        })
      } else {
        const loss = parseEventLogs({ abi: LINQA_ABI, logs: receipt.logs, eventName: 'RoundLost', strict: true })
          .find(event => event.address.toLowerCase() === CONTRACT_ADDRESS.toLowerCase())
        const gameId = createContractGameId(eventArgs.roundId, targetChainId)
        const lostStake = loss?.args.stake ?? 0n
        setCurrentGameId(gameId)
        setHasCurrentSecret(false)
        setLastResult({ type: 'lost', amount: formatUsdc6(lostStake, targetChainId) })
        currentRoundIdRef.current = 0n
        secretsRef.current = []
        clearSecrets(address, targetChainId)
        if (loss) {
          addToHistory(eventArgs.roundId, loss.args.stake, false, eventArgs.newMultiplierWAD, eventArgs.newMultiplierWAD, hash, targetChainId)
        }
        void refetchRound()
        void refetchBalance()
        window.setTimeout(() => {
          setTxPhase('idle')
          setRoundPhase('lost')
          setResultOutcome({
            type: 'lost', gameId, amount: formatUsdc6(lostStake, targetChainId),
            txHash: hash ?? null, chainId: targetChainId, demo: false,
          })
        }, 2000)
      }
    } else if (txPhase === 'advancing') {
      setTxPhase('idle')
      setCurrentRowIndex(prev => prev + 1)
      setRoundPhase('active')
      void refetchRound()
    } else if (txPhase === 'cashingout') {
      setTxPhase('idle')
      const cashedOut = parseEventLogs({ abi: LINQA_ABI, logs: receipt.logs, eventName: 'CashedOut', strict: true })
        .find(event => event.address.toLowerCase() === CONTRACT_ADDRESS.toLowerCase())
      if (cashedOut) {
        const args = cashedOut.args
        const amount = formatUsdc6Rounded(args.payout, targetChainId)
        const gameId = createContractGameId(args.roundId, targetChainId)
        setCurrentGameId(gameId)
        setLastResult({ type: 'won', amount })
        setResultOutcome({ type: 'won', gameId, amount, multiplier: formatMultiplier(args.multiplierWAD), txHash: hash ?? null, chainId: targetChainId, demo: false })
        const r = activeRoundData as { stake: bigint } | undefined
        if (r) addToHistory(args.roundId, r.stake, true, args.multiplierWAD, args.multiplierWAD, hash, targetChainId)
        setRoundPhase('won')
        setHasCurrentSecret(false)
        secretsRef.current = []
        clearSecrets(address, targetChainId)
        currentRoundIdRef.current = 0n
      } else {
        setErrorMsg('The transaction confirmed, but its payout event could not be read. Check the explorer before retrying.')
      }
      void refetchRound()
      void refetchBalance()
    }
    resetWrite()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTxSuccess, receipt])

  useEffect(() => {
    if (isWriteError) {
      if (txPhase === 'starting') {
        secretsRef.current = []
        clearSecrets(address, targetChainId)
      }
      setTxPhase('idle')
      setPendingTileIndex(null)
      setErrorMsg((writeError as { shortMessage?: string } | null)?.shortMessage ?? 'Wallet request was cancelled or could not be submitted.')
      resetWrite()
    }
  }, [isWriteError, writeError, resetWrite, txPhase, address, targetChainId])

  useEffect(() => {
    if (isTxError) {
      if (txPhase === 'starting') {
        secretsRef.current = []
        clearSecrets(address, targetChainId)
      }
      setTxPhase('idle')
      setPendingTileIndex(null)
      setErrorMsg((txError as { shortMessage?: string } | null)?.shortMessage ?? 'The transaction did not complete. Your onchain round state is unchanged.')
      resetWrite()
    }
  }, [isTxError, txError, resetWrite, txPhase, address, targetChainId])

  function addToHistory(roundId: bigint, stake: bigint, won: boolean, finalMult: bigint, mult: bigint, hash: `0x${string}` | undefined, chainId: number) {
    const payout = won ? (stake * finalMult) / WAD : 0n
    const round: GameRound = {
      roundId: createContractGameId(roundId, chainId),
      stake: formatUsdc6(stake, chainId),
      won,
      multiplier: formatMultiplier(mult),
      payout: formatUsdc6Rounded(payout, chainId),
      txHash: hash ?? null,
      chainId,
      createdAt: Date.now(),
    }
    setHistoryRounds(prev => {
      return [round, ...prev].slice(0, 20)
    })
  }

  const addDemoToHistory = useCallback((gameId: string, won: boolean, multiplier: bigint, payout: bigint, chainId: number) => {
    const stake = parseAmount(chainId, stakeInput)?.raw ?? 0n
    const round: GameRound = {
      roundId: gameId,
      stake: formatUsdc6(stake, chainId),
      won,
      multiplier: formatMultiplier(multiplier),
      payout: formatUsdc6Rounded(won ? payout : 0n, chainId),
      txHash: null,
      chainId,
      createdAt: Date.now(),
    }
    setHistoryRounds(prev => [round, ...prev].slice(0, 20))
  }, [stakeInput])

  useEffect(() => {
    try { localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(historyRounds)) } catch { /* History remains available for this session. */ }
  }, [historyRounds])

  // ── Actions ─────────────────────────────────────────────────────────────────
  const ensureChain = useCallback(() => {
    if (walletChainId !== targetChainId) {
      void switchChain({ chainId: targetChainId })
      return false
    }
    return true
  }, [walletChainId, targetChainId, switchChain])

  const handleStartGame = useCallback(() => {
    if (LOCAL_DEMO_MODE) {
      setErrorMsg(null)
      const stakeRaw = parseAmount(targetChainId, stakeInput)
      if (!stakeRaw) {
        setErrorMsg('Enter a valid stake amount.')
        return
      }
      if (stakeRaw.raw < MIN_STAKE_RAW) {
        setErrorMsg('Minimum stake is $0.50 USDC.')
        return
      }
      if (stakeRaw.raw > MAX_STAKE_RAW) {
        setErrorMsg('Maximum stake is $10,000 USDC.')
        return
      }
      const gameId = createDemoGameId()
      setCurrentGameId(gameId)
      setTxPhase('starting')
      setReveals([])
      setCurrentRowIndex(0)
      setCurrentMultiplierWAD(BASE_MULTIPLIER)
      setLastResult(null)
      setResultOutcome(null)
      setPendingTileIndex(null)
      setHasCurrentSecret(true)
      window.setTimeout(() => {
        setTxPhase('idle')
        setRoundPhase('active')
      }, 250)
      return
    }
    if (!address || !usdcAddress) return
    if (!ensureChain()) return
    setErrorMsg(null)

    const stakeRaw = parseAmount(targetChainId, stakeInput)
    if (!stakeRaw) { setErrorMsg('Invalid stake amount'); return }
    if (stakeRaw.raw < MIN_STAKE_RAW) {
      setErrorMsg('Minimum stake is $0.50 USDC.')
      return
    }
    if (stakeRaw.raw > MAX_STAKE_RAW) {
      setErrorMsg('Maximum stake is $10,000 USDC.')
      return
    }

    const stakeAmount = stakeRaw.raw
    setCurrentGameId(null)

    // Approve if needed
    if ((usdcAllowance ?? 0n) < stakeAmount) {
      setTxPhase('approving')
      try {
        writeContract({
          address: usdcAddress,
          abi: erc20Abi,
          functionName: 'approve',
          args: [CONTRACT_ADDRESS, stakeAmount],
          chainId: targetChainId,
        })
      } catch {
        setTxPhase('idle')
        setErrorMsg('Approval failed')
      }
      return
    }

    // Generate secrets for all rows upfront
    secretsRef.current = Array.from({ length: 27 }, () => generateSecret())
    setHasCurrentSecret(true)
    saveSecrets(address, targetChainId, secretsRef.current)
    const firstSecret = secretsRef.current[0]
    const commitHash = computeCommitHash(firstSecret)

    setTxPhase('starting')
    setReveals([])
    setCurrentRowIndex(0)
    setCurrentMultiplierWAD(BASE_MULTIPLIER)
    setLastResult(null)
    setResultOutcome(null)
    autoAdvanceRef.current = false

    try {
      writeContract({
        address: CONTRACT_ADDRESS,
        abi: LINQA_ABI,
        functionName: 'startRound',
        args: [stakeAmount, commitHash],
        chainId: targetChainId,
      })
    } catch {
      setTxPhase('idle')
      setErrorMsg('Failed to start round')
    }
  }, [address, usdcAddress, usdcAllowance, stakeInput, ensureChain, writeContract, targetChainId])

  const handleTileClick = useCallback((tileIndex: number) => {
    if (LOCAL_DEMO_MODE) {
      if (roundPhase !== 'active' || txPhase !== 'idle') return
      setErrorMsg(null)
      setPendingTileIndex(tileIndex)
      setTxPhase('selecting')
      const rowIndex = currentRowIndex
      const tileCount = demoRowPattern[rowIndex]
      if (!tileCount) return
      const losingTile = Math.floor(Math.random() * tileCount)
      const safe = tileIndex !== losingTile
      window.setTimeout(() => {
        setReveals(prev => [...prev.filter(item => item.rowIndex !== rowIndex), {
          rowIndex, selectedTile: tileIndex, losingTile, safe,
        }])
        setPendingTileIndex(null)
        setHasCurrentSecret(false)
        window.setTimeout(() => {
          setTxPhase('idle')
          if (!safe) {
            const lostStake = parseAmount(targetChainId, stakeInput)
            const gameId = currentGameId ?? createDemoGameId()
            const amount = lostStake?.toFixed(2) ?? '0.00'
            setCurrentGameId(gameId)
            setLastResult({ type: 'lost', amount })
            addDemoToHistory(gameId, false, currentMultiplierWAD, 0n, targetChainId)
            setRoundPhase('lost')
            setResultOutcome({ type: 'lost', gameId, amount, txHash: null, chainId: targetChainId, demo: true })
            return
          }
          const calculatedMultiplier = (currentMultiplierWAD * BigInt(tileCount)) / BigInt(tileCount - 1)
          const nextMultiplier = calculatedMultiplier > DEMO_MAX_MULTIPLIER_WAD
            ? DEMO_MAX_MULTIPLIER_WAD
            : calculatedMultiplier
          setCurrentMultiplierWAD(nextMultiplier)
          const nextRowIndex = rowIndex + 1
          if (nextRowIndex >= demoRowPattern.length) {
            const rawStake = parseAmount(targetChainId, stakeInput)?.raw ?? 0n
            const payout = (rawStake * nextMultiplier) / WAD
            const gameId = currentGameId ?? createDemoGameId()
            const amount = formatUsdc6Rounded(payout, targetChainId)
            setCurrentGameId(gameId)
            setLastResult({ type: 'won', amount })
            addDemoToHistory(gameId, true, nextMultiplier, payout, targetChainId)
            setRoundPhase('won')
            setResultOutcome({ type: 'won', gameId, amount, multiplier: formatMultiplier(nextMultiplier), txHash: null, chainId: targetChainId, demo: true })
            return
          }
          setCurrentRowIndex(nextRowIndex)
          setHasCurrentSecret(true)
        }, 900)
      }, 450)
      return
    }
    if (!address) return
    if (roundPhase !== 'active') return
    if (txPhase !== 'idle') return
    if (!ensureChain()) return
    setErrorMsg(null)

    const secret = secretsRef.current[currentRowIndex]
    if (!secret) { setErrorMsg('The saved row key is unavailable. Cash out to safely end this round.'); return }

    setPendingTileIndex(tileIndex)
    setTxPhase('selecting')

    try {
      writeContract({
        address: CONTRACT_ADDRESS,
        abi: LINQA_ABI,
        functionName: 'selectTile',
        args: [tileIndex, secret],
        chainId: targetChainId,
      })
    } catch {
      setTxPhase('idle')
      setPendingTileIndex(null)
      setErrorMsg('Transaction failed')
    }
  }, [address, roundPhase, txPhase, ensureChain, currentRowIndex, currentMultiplierWAD, stakeInput, writeContract, targetChainId, demoRowPattern, currentGameId, addDemoToHistory])

  const handleAdvanceRow = useCallback(() => {
    if (LOCAL_DEMO_MODE) return
    if (!address) return
    if (roundPhase !== 'result_pending') return
    if (txPhase !== 'idle') return
    if (!ensureChain()) return

    const nextRowIndex = currentRowIndex + 1
    const nextSecret = secretsRef.current[nextRowIndex] ?? generateSecret()
    if (!secretsRef.current[nextRowIndex]) {
      secretsRef.current[nextRowIndex] = nextSecret
      if (address) saveSecrets(address, targetChainId, secretsRef.current)
    }
    setHasCurrentSecret(!!nextSecret)
    const nextCommit = computeCommitHash(nextSecret)

    setTxPhase('advancing')
    try {
      writeContract({
        address: CONTRACT_ADDRESS,
        abi: LINQA_ABI,
        functionName: 'advanceRow',
        args: [nextCommit],
        chainId: targetChainId,
      })
    } catch {
      setTxPhase('idle')
      setErrorMsg('Advance failed')
    }
  }, [address, roundPhase, txPhase, ensureChain, currentRowIndex, writeContract, targetChainId])

  useEffect(() => {
    if (roundPhase === 'result_pending' && txPhase === 'idle' && autoAdvanceRef.current) {
      autoAdvanceRef.current = false
      handleAdvanceRow()
    }
  }, [roundPhase, txPhase, handleAdvanceRow])

  const handleCashOut = useCallback(() => {
    if (LOCAL_DEMO_MODE) {
      if (roundPhase !== 'active' || currentRowIndex === 0 || txPhase !== 'idle') return
      setErrorMsg(null)
      setTxPhase('cashingout')
      const rawStake = parseAmount(targetChainId, stakeInput)?.raw ?? 0n
      const payout = (rawStake * currentMultiplierWAD) / WAD
      const amount = formatUsdc6Rounded(payout, targetChainId)
      window.setTimeout(() => {
        setTxPhase('idle')
        setLastResult({ type: 'won', amount })
        const gameId = currentGameId ?? createDemoGameId()
        setCurrentGameId(gameId)
        setResultOutcome({ type: 'won', gameId, amount, multiplier: formatMultiplier(currentMultiplierWAD), txHash: null, chainId: targetChainId, demo: true })
        addDemoToHistory(gameId, true, currentMultiplierWAD, payout, targetChainId)
        setRoundPhase('won')
        setHasCurrentSecret(false)
      }, 300)
      return
    }
    if (!address) return
    if (roundPhase !== 'active' && roundPhase !== 'collectable') return
    if (roundPhase === 'active' && currentRowIndex === 0) return
    if (txPhase !== 'idle') return
    if (!ensureChain()) return
    setErrorMsg(null)

    setTxPhase('cashingout')
    try {
      writeContract({
        address: CONTRACT_ADDRESS,
        abi: LINQA_ABI,
        functionName: 'cashOut',
        chainId: targetChainId,
        args: [],
      })
    } catch {
      setTxPhase('idle')
      setErrorMsg('Cash out failed')
    }
  }, [address, roundPhase, currentRowIndex, txPhase, ensureChain, currentMultiplierWAD, stakeInput, writeContract, targetChainId, currentGameId, addDemoToHistory])

  const handleReset = useCallback(() => {
    if (LOCAL_DEMO_MODE) setDemoRowPattern(createDemoRowPattern())
    setRoundPhase('idle')
    setTxPhase('idle')
    setReveals([])
    setCurrentRowIndex(0)
    setCurrentMultiplierWAD(BASE_MULTIPLIER)
    // Keep the win notice visible after the popup closes; loss results stay hidden.
    if (lastResult?.type === 'lost') setLastResult(null)
    setResultOutcome(null)
    setCurrentGameId(null)
    setPendingTileIndex(null)
    setErrorMsg(null)
    secretsRef.current = []
    setHasCurrentSecret(false)
    clearSecrets(address, targetChainId)
    autoAdvanceRef.current = false
    currentRoundIdRef.current = 0n
    void refetchRound()
    void refetchBalance()
    resetWrite()
  }, [address, targetChainId, refetchRound, refetchBalance, resetWrite, lastResult])

  // ── Computed UI values ──────────────────────────────────────────────────────
  const isRoundActive = roundPhase === 'active' || roundPhase === 'result_pending' || roundPhase === 'collectable'
  const canCashOut = roundPhase === 'collectable' || (roundPhase === 'active' && currentRowIndex > 0)
  const isBusy = txPhase !== 'idle' || isWritePending || isTxConfirming
  const isPlaying = isRoundActive || isBusy || resultOutcome !== null
  const displayMultiplier = formatMultiplier(currentMultiplierWAD)
  const cashoutAmount = (() => {
    try {
      const activeRound = activeRoundData as { stake?: bigint } | undefined
      const contractStake = !LOCAL_DEMO_MODE && isRoundActive && activeRound?.stake !== undefined && activeRound.stake > 0n
        ? activeRound.stake
        : undefined
      const rawStake = contractStake !== undefined
        ? contractStake
        : parseAmount(targetChainId, stakeInput).raw
      if (rawStake <= 0n) return '0.00'
      const payout = (rawStake * currentMultiplierWAD) / WAD
      return formatUsdc6Rounded(payout, targetChainId)
    } catch { return '0.00' }
  })()
  const firstRowTileCount = LOCAL_DEMO_MODE ? demoRowPattern[0] : CONTRACT_ROW_PATTERN[0]
  const firstTileMultiplierWAD = firstRowTileCount > 1
    ? (BASE_MULTIPLIER * BigInt(firstRowTileCount)) / BigInt(firstRowTileCount - 1)
    : BASE_MULTIPLIER

  const contractDeployed = CONTRACT_ADDRESS !== '0x0000000000000000000000000000000000000000'
  const contractCompatible = deployedGameVersion === 3n
  const currentRound = activeRoundData as { roundId?: bigint; status?: number } | undefined
  const hasExistingRound = !!currentRound?.roundId && currentRound.roundId !== 0n && (currentRound.status === 1 || currentRound.status === 2)
  const isWrongChain = isConnected && walletChainId !== targetChainId

  function getButtonLabel(): string {
    if (LOCAL_DEMO_MODE) {
      if (isBusy) {
        if (txPhase === 'starting') return 'STARTING...'
        if (txPhase === 'selecting') return 'REVEALING...'
        if (txPhase === 'cashingout') return 'CASHING OUT...'
      }
      if (roundPhase === 'won' || roundPhase === 'lost') return 'START GAME'
      if (isRoundActive) return canCashOut ? `CASH OUT  $${cashoutAmount}` : 'OPEN TILES'
      return 'START GAME'
    }
    if (!contractDeployed) return 'CONTRACT NOT DEPLOYED'
    if (!contractCompatible && !hasExistingRound) return isCheckingGameVersion ? 'CHECKING CONTRACT...' : 'CONTRACT UPDATE REQUIRED'
    if (isBusy) {
      if (txPhase === 'approving') return 'APPROVING...'
      if (txPhase === 'starting') return 'STARTING...'
      if (txPhase === 'selecting') return 'CONFIRMING...'
      if (txPhase === 'advancing') return 'ADVANCING...'
      if (txPhase === 'cashingout') return 'CASHING OUT...'
      return 'CONFIRMING...'
    }
    if (roundPhase === 'result_pending') return 'MOVING TO NEXT ROW...'
    if (roundPhase === 'won' || roundPhase === 'lost') return 'START GAME'
    if (isRoundActive) return canCashOut ? `${contractCompatible ? 'CASH OUT' : 'CASH OUT LEGACY ROUND'}  $${cashoutAmount}` : 'OPEN TILES'
    return 'START GAME'
  }

  const topNotice = 'TESTNET SIMULATION · PICK A TILE · BUILD YOUR MULTIPLIER'
  let actionStatus = ''
  let actionStatusTone = ''
  if (errorMsg) {
    actionStatus = conciseGameError(errorMsg)
    actionStatusTone = 'linqa-action-status--error'
  } else if (isWrongChain && !isPlaying) {
    actionStatus = 'SWITCH TO ARC TESTNET TO PLAY'
    actionStatusTone = 'linqa-action-status--warning'
  } else if (!LOCAL_DEMO_MODE && !contractDeployed) {
    actionStatus = 'CONTRACT NOT DEPLOYED · LINQA IS NOT READY TO PLAY'
    actionStatusTone = 'linqa-action-status--warning'
  } else if (!LOCAL_DEMO_MODE && isCheckingGameVersion) {
    actionStatus = 'CHECKING GAME CONTRACT…'
  } else if (!LOCAL_DEMO_MODE && !contractCompatible && !hasExistingRound) {
    actionStatus = 'CONTRACT UPDATE REQUIRED · NEW ROUNDS ARE DISABLED'
    actionStatusTone = 'linqa-action-status--warning'
  } else if (lastResult) {
    if (lastResult.type !== 'lost') {
      actionStatus = `Congrats! You won $${lastResult.amount} USDC`
      actionStatusTone = 'linqa-action-status--success'
    }
  } else if (LOCAL_DEMO_MODE) {
    actionStatus = 'LOCAL DEMO · NO WALLET OR CONTRACT REQUIRED'
  } else if (isBusy || roundPhase === 'result_pending') {
    actionStatus = getButtonLabel()
  }

  function renderActionStatus() {
    if (!actionStatus) return null
    const isWarning = actionStatusTone === 'linqa-action-status--warning'
    return (
      <div className={`linqa-action-status ${actionStatusTone}`} aria-live="polite" role={actionStatusTone === 'linqa-action-status--error' ? 'status' : undefined}>
        {isWrongChain && !isPlaying ? (
          <button className="linqa-action-status__switch" type="button" onClick={() => void switchChain({ chainId: targetChainId })}>
            <CircleAlert className="linqa-action-status__icon" size={16} aria-hidden="true" />
            <span>{actionStatus}</span>
          </button>
        ) : (
          <span className={isWarning ? 'linqa-action-status__message linqa-action-status__message--warning' : 'linqa-action-status__message'}>
            {isWarning && <CircleAlert className="linqa-action-status__icon" size={16} aria-hidden="true" />}
            <span>{actionStatus}</span>
          </span>
        )}
      </div>
    )
  }

  function handleMainButton() {
    if (roundPhase === 'won' || roundPhase === 'lost') { handleReset(); return }
    if (LOCAL_DEMO_MODE) {
      if (isBusy) return
      if (isRoundActive) { handleCashOut(); return }
      handleStartGame()
      return
    }
    if (!contractDeployed) return
    if (!contractCompatible) {
      if (hasExistingRound && (roundPhase === 'active' || roundPhase === 'collectable')) handleCashOut()
      return
    }
    if (isBusy) return
    if (isRoundActive) { handleCashOut(); return }
    handleStartGame()
  }

  return (
    <div className="linqa-root">
      {/* ── Header ── */}
      <header className="linqa-header">
        <img className="linqa-logo" src="/linqa-logo.svg" alt="Linqa" />
        <div className="linqa-header-right">
          <button
            className="linqa-icon-btn"
            onClick={() => { setShowHistory(false); setShowHowToPlay(true) }}
            aria-label="How to play"
            title="How to play"
          >
            <Info size={18} />
          </button>
          <button
            className="linqa-icon-btn"
            onClick={() => { setShowHowToPlay(false); setShowHistory(h => !h) }}
            aria-label="History"
            title="Round history"
          >
            <History size={18} />
          </button>
          <ConnectKitButton.Custom>
            {({ isConnected: ck_connected, show, address: ck_address }) => (
              <button className="linqa-connect-btn" onClick={show}>
                {ck_connected && ck_address
                  ? `${ck_address.slice(0, 6)}…${ck_address.slice(-4)}`
                  : 'Connect Wallet'}
              </button>
            )}
          </ConnectKitButton.Custom>
        </div>
      </header>

      {historyRounds.length > 0 && !isRoundActive && !isBusy && !resultOutcome && (
        <aside className="recent-activity" aria-label="Recent activities">
          <div className="recent-activity__header">
            <h2>Recent Activities</h2>
            <button type="button" onClick={() => setShowHistory(true)}>View all</button>
          </div>
          <ul className="recent-activity__list">
            {historyRounds.slice(0, 5).map(round => {
              const amount = round.won ? round.payout : round.stake
              const ageSeconds = round.createdAt ? Math.max(0, Math.floor((Date.now() - round.createdAt) / 1000)) : null
              const age = ageSeconds === null
                ? 'Not found'
                : ageSeconds < 60
                  ? `${ageSeconds || 1}s ago`
                  : ageSeconds < 3600
                    ? `${Math.floor(ageSeconds / 60)}m ago`
                    : ageSeconds < 86_400
                      ? `${Math.floor(ageSeconds / 3600)}h ago`
                      : `${Math.floor(ageSeconds / 86_400)}d ago`
              return (
                <li className={`recent-activity__item${round.won ? ' recent-activity__item--win' : ' recent-activity__item--loss'}`} key={round.roundId}>
                  <time>{age}</time>
                  <span>{round.won ? 'You won' : 'You lost'}</span>
                  <strong>${amount} USDC</strong>
                  {round.won ? <PartyPopper size={15} aria-label="Congrats" /> : <Frown size={15} aria-label="Sad" />}
                </li>
              )
            })}
          </ul>
        </aside>
      )}

      {showHowToPlay && <HowToPlayPanel onClose={() => setShowHowToPlay(false)} />}

      {/* ── History panel ── */}
      {showHistory && (
        <HistoryPanel
          rounds={historyRounds}
          onClose={() => setShowHistory(false)}
        />
      )}
      {resultOutcome && <RoundResultDialog outcome={resultOutcome} onClose={handleReset} />}

      <div className="linqa-fit-content">
      {/* ── Main content ── */}
      <main className={`linqa-main${isRoundActive ? ' linqa-main--playing' : ''}`}>
        <div className="linqa-notice" aria-live="polite" aria-atomic="true">
          <span className="linqa-notice__text">{topNotice}</span>
        </div>

        <div className="linqa-play-panel">
        {/* Game board */}
        <div className="linqa-board-wrap">
          <LinqaBoard
            currentRowIndex={currentRowIndex}
            reveals={reveals}
            roundPhase={roundPhase}
            pendingTileIndex={pendingTileIndex}
            onTileClick={handleTileClick}
            isBusy={isBusy || (!LOCAL_DEMO_MODE && (!contractCompatible || !hasCurrentSecret))}
            rowPattern={LOCAL_DEMO_MODE ? demoRowPattern : undefined}
            multiplierCap={LOCAL_DEMO_MODE ? DEMO_MAX_MULTIPLIER_WAD : undefined}
          />
        </div>

        {/* Stake input & multiplier row */}
        {!isRoundActive && roundPhase !== 'won' && roundPhase !== 'lost' && (
          <div className="linqa-controls">
            <div className="linqa-divider-lines" aria-hidden="true">
              <span className="linqa-divider-line linqa-divider-line--left-top" />
              <span className="linqa-divider-line linqa-divider-line--left-bottom" />
              <span className="linqa-divider-line linqa-divider-line--right-top" />
              <span className="linqa-divider-line linqa-divider-line--right-bottom" />
              <span className="linqa-divider-line linqa-divider-line--left-down" />
              <span className="linqa-divider-line linqa-divider-line--right-down" />
            </div>
            <div className="linqa-stake-row">
              <div className="linqa-stake-copy">
                <label className="linqa-label" htmlFor="stake-amount">ENTER AMOUNT</label>
              </div>
              <div className="linqa-stake-entry-row">
                <div className="linqa-input-wrap">
                  <span className="linqa-currency">$</span>
                  <input
                    id="stake-amount"
                    className="linqa-input"
                    type="number"
                    aria-label="Stake amount in USDC"
                    min="0.5"
                    max="100"
                    step="0.01"
                    value={stakeInput}
                    onChange={e => setStakeInput(e.target.value)}
                    disabled={isBusy}
                    placeholder="1.00"
                  />
                  <span className="linqa-currency-end"><img src="/usdc-logo.webp" alt="" />USDC</span>
                </div>
                <div className="linqa-stake-presets" role="group" aria-label="Quick stake amounts">
                  {[1, 2, 5, 10].map(amount => (
                    <button
                      key={amount}
                      type="button"
                      className={`linqa-stake-preset${Number(stakeInput) === amount ? ' linqa-stake-preset--selected' : ''}`}
                      onClick={() => setStakeInput(String(amount))}
                      disabled={isBusy}
                      aria-pressed={Number(stakeInput) === amount}
                    >
                      {amount} <span>USDC</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="linqa-play-actions linqa-play-actions--within-controls">
              <ConnectKitButton.Custom>
                {({ show }) => (
                  <>
                    <LinqaActionButton
                      label={LOCAL_DEMO_MODE ? getButtonLabel() : isConnected ? 'START GAME' : 'CONNECT WALLET'}
                      hoverLabel={LOCAL_DEMO_MODE ? "Let's play" : isConnected ? "Let's play" : 'CONNECT WALLET'}
                      variant="standard"
                      onClick={LOCAL_DEMO_MODE || isConnected ? handleMainButton : show}
                      disabled={LOCAL_DEMO_MODE ? isBusy : isConnected && (isBusy || !contractDeployed || (!contractCompatible && !hasExistingRound))}
                    />
                    {renderActionStatus()}
                  </>
                )}
              </ConnectKitButton.Custom>
            </div>
            <div className="linqa-mult-row">
              <div className="linqa-mult-copy" aria-label={`First tile multiplier ${formatMultiplier(firstTileMultiplierWAD)}`}>
                <span className="linqa-mult-caption">First tile multiplier:</span>
                <span className="linqa-mult-first-value">{formatMultiplier(firstTileMultiplierWAD)}</span>
              </div>
              <div className="linqa-wallet-balance" aria-label={isConnected
                ? `Balance: ${usdcBalance === undefined ? 'loading' : formatUsdc6(usdcBalance, targetChainId)} USDC`
                : 'Connect Wallet'}>
                {isConnected ? (
                  <>
                    <span className="linqa-balance-caption">Balance:</span>
                    <span>{usdcBalance === undefined ? '—' : formatUsdc6(usdcBalance, targetChainId)}</span>
                    <img src="/usdc-logo.webp" alt="" />
                  </>
                ) : (
                  <>
                    <span className="linqa-balance-caption">Balance:</span>
                    <span className="linqa-connect-wallet-text">Connect Wallet</span>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {isRoundActive && (
          <div className="linqa-active-info">
            <div className="linqa-mult-live">
              <span className="linqa-label">MULTIPLIER</span>
              <span className="linqa-mult-val">{displayMultiplier}</span>
            </div>
            <div className="linqa-cashout-live">
              <span className="linqa-label">WINNING</span>
              <span className={`linqa-cashout-amt${canCashOut ? '' : ' linqa-cashout-amt--pending'}`}>${cashoutAmount}</span>
            </div>
          </div>
        )}
        {/* Advancing row prompt */}
        {roundPhase === 'result_pending' && txPhase === 'idle' && errorMsg && (
          <button className="linqa-advance-btn" onClick={handleAdvanceRow}>
            Retry Next Row
          </button>
        )}

        {/* Main CTA */}
        {(isRoundActive || roundPhase === 'won' || roundPhase === 'lost') && (
          <div className="linqa-play-actions">
            <ConnectKitButton.Custom>
              {({ show }) => {
                const showCashout = (LOCAL_DEMO_MODE || isConnected) && canCashOut
                const roundFinished = roundPhase === 'won' || roundPhase === 'lost'
                return (
                  <>
                    <LinqaActionButton
                      label={LOCAL_DEMO_MODE ? getButtonLabel() : !isConnected ? 'CONNECT WALLET' : isRoundActive ? getButtonLabel() : 'START GAME'}
                      hoverLabel={isRoundActive && !canCashOut ? 'OPEN TILES' : LOCAL_DEMO_MODE ? (showCashout || isBusy ? getButtonLabel() : "Let's play") : isConnected ? "Let's play" : 'CONNECT WALLET'}
                      variant={showCashout ? 'cashout' : 'standard'}
                      onClick={LOCAL_DEMO_MODE || isConnected ? handleMainButton : show}
                      disabled={LOCAL_DEMO_MODE ? isBusy || (roundPhase === 'active' && !canCashOut) : isConnected && !roundFinished && (isBusy || roundPhase === 'result_pending' || (roundPhase === 'active' && !canCashOut) || !contractDeployed || (!contractCompatible && !hasExistingRound))}
                    />
                    {renderActionStatus()}
                  </>
                )
              }}
            </ConnectKitButton.Custom>
          </div>
        )}
        </div>

      </main>

      {/* ── Network selector ── */}
      <footer className="linqa-footer">
        <div className={`linqa-net-selector${isPlaying ? ' linqa-net-selector--hidden' : ''}`}>
          <button
            className="linqa-net-btn linqa-net-btn--disabled"
            type="button"
            disabled
            title="Mainnet is disabled for now"
            aria-label="Mainnet disabled for now"
          >
            MAINNET
          </button>
          <span className="linqa-net-sep">|</span>
          <button
            className="linqa-net-btn linqa-net-btn--active"
            type="button"
            aria-current="true"
          >
            TESTNET
          </button>
        </div>
      </footer>
      </div>
    </div>
  )
}

