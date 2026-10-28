import { useId, useLayoutEffect, useRef, useState } from 'react'

export const ARC_MARK_PATH = 'M 75.90 24.30 L 64.80 34.50 L 57.00 44.50 L 47.80 60.80 L 39.40 81.60 L 28.50 124.80 L 24.60 152.90 L 23.10 178.90 L 51.50 178.90 L 56.20 131.00 L 66.20 90.80 L 71.60 76.90 L 80.20 60.70 L 90.30 48.90 L 99.60 44.20 L 105.90 45.00 L 112.10 48.80 L 119.40 56.80 L 127.20 69.20 L 138.80 98.60 L 146.50 134.60 L 119.30 130.70 L 91.50 130.00 L 88.70 144.00 L 87.80 158.00 L 109.50 156.80 L 136.00 159.90 L 156.10 166.20 L 179.20 178.60 L 178.00 152.90 L 170.30 106.40 L 161.00 75.50 L 154.70 60.80 L 145.50 44.50 L 131.60 28.20 L 124.50 22.80 L 112.70 17.40 L 102.50 15.70 L 92.80 16.60 Z'
export const BADGE_PATH = 'M100 8c14 0 22 12 34 15s27-4 36 6 4 25 10 36 20 17 20 35-14 24-20 35 0 26-10 36-24 3-36 6-20 15-34 15-22-12-34-15-27 4-36-6-4-25-10-36-20-17-20-35 14-24 20-35 0-26 10-36 24-3 36-6 20-15 34-15z'

function ArcTileBadge() {
  const id = useId().replace(/:/g, '')
  const clipId = `tileBadgeClip-${id}`
  const glossId = `tileGloss-${id}`
  const crackPath = 'M74,36 L92,66 L76,88 L103,118 L84,148 L106,178'
  return (
    <span className="tile-badge-frame" aria-hidden="true">
      <span className="tile-badge-inner">
        <svg className="tile-badge" viewBox="0 0 200 200" focusable="false">
          <defs>
            <linearGradient id={glossId} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#fff" stopOpacity="0" />
              <stop offset="50%" stopColor="#fff" stopOpacity=".9" />
              <stop offset="100%" stopColor="#fff" stopOpacity="0" />
            </linearGradient>
            <clipPath id={clipId}><path d={BADGE_PATH} /></clipPath>
          </defs>
          <path className="tile-badge__shape" d={BADGE_PATH} />
          <path className="tile-badge__rim" d={BADGE_PATH} />
          <path className="tile-badge__logo" d={ARC_MARK_PATH} transform="translate(24.25 27.25) scale(0.75)" />
          <g className="tile-badge__crack">
            <path className="tile-badge__crack-shadow" d={crackPath} />
            <path className="tile-badge__crack-shadow" d="M103,118 L132,132 L121,158" />
            <path className="tile-badge__crack-edge" d={crackPath} />
            <path className="tile-badge__crack-edge" d="M103,118 L132,132 L121,158" />
          </g>
          <g className="tile-badge__gloss" clipPath={`url(#${clipId})`}>
            <rect x="-10" y="-40" width="40" height="280" fill={`url(#${glossId})`} />
          </g>
        </svg>
      </span>
    </span>
  )
}

export const CONTRACT_ROW_PATTERN = [4, 2, 4, 3, 4, 4, 5, 6, 4, 2, 4, 3, 4, 4, 5, 6, 4, 2, 4, 3, 4, 4, 5, 6, 4, 2, 4]
const BASE_MULTIPLIER = 920_000_000_000_000_000n
export const DEMO_MAX_MULTIPLIER_WAD = 10_000n * 1_000_000_000_000_000_000n
const DEMO_ROW_WEIGHTS = [2, 2, 3, 3, 3, 4, 4, 5, 5, 6, 7, 8]

export function createDemoRowPattern(): number[] {
  const pattern: number[] = []
  let multiplier = BASE_MULTIPLIER
  while (multiplier < DEMO_MAX_MULTIPLIER_WAD && pattern.length < 80) {
    const tileCount = DEMO_ROW_WEIGHTS[Math.floor(Math.random() * DEMO_ROW_WEIGHTS.length)]
    const nextMultiplier = (multiplier * BigInt(tileCount)) / BigInt(tileCount - 1)
    // Stop before a row that would overshoot the cap. This keeps the 8% edge
    // consistent on every playable rung instead of clamping its payout.
    if (nextMultiplier > DEMO_MAX_MULTIPLIER_WAD) break
    pattern.push(tileCount)
    multiplier = nextMultiplier
  }
  return pattern
}

function computeMultiplierAfterRows(upToRow: number, rowPattern: number[], multiplierCap?: bigint): bigint {
  let m = BASE_MULTIPLIER
  for (let i = 0; i <= upToRow; i++) {
    const t = BigInt(rowPattern[i] ?? CONTRACT_ROW_PATTERN[i % CONTRACT_ROW_PATTERN.length])
    m = (m * t) / (t - 1n)
    if (multiplierCap && m >= multiplierCap) return multiplierCap
  }
  return m
}

function formatMultiplier(wadValue: bigint): string {
  const scaled = Number(wadValue) / 1e18
  if (scaled >= 1_000) return `${Math.floor(scaled).toLocaleString('en-US')}x`
  if (scaled >= 100) return scaled.toFixed(0) + 'x'
  if (scaled >= 10) return scaled.toFixed(1) + 'x'
  return scaled.toFixed(2) + 'x'
}

interface RowReveal {
  rowIndex: number
  selectedTile: number
  losingTile: number
  safe: boolean
}

interface LinqaBoardProps {
  currentRowIndex: number
  reveals: RowReveal[]
  roundPhase: string
  pendingTileIndex: number | null
  onTileClick: (tileIndex: number) => void
  isBusy: boolean
  rowPattern?: number[]
  multiplierCap?: bigint
}

export default function LinqaBoard({
  currentRowIndex,
  reveals,
  roundPhase,
  pendingTileIndex,
  onTileClick,
  isBusy,
  rowPattern = CONTRACT_ROW_PATTERN,
  multiplierCap,
}: LinqaBoardProps) {
  const totalRows = rowPattern.length
  const ladderScrollRef = useRef<HTMLDivElement>(null)
  const isActive = roundPhase === 'active' || roundPhase === 'result_pending' || roundPhase === 'won' || roundPhase === 'lost'
  const previousRowRef = useRef(currentRowIndex)
  const [isProgressing, setIsProgressing] = useState(false)

  useLayoutEffect(() => {
    const advanced = currentRowIndex > previousRowRef.current
    previousRowRef.current = currentRowIndex
    if (!advanced) return

    // The mobile board distributes its rows to fill the viewport, so its real
    // row stride can differ from the CSS fallback. Measure the committed layout
    // before paint so the roll animation lands exactly on the next row.
    const board = ladderScrollRef.current
    const fullRows = board?.querySelectorAll<HTMLElement>('.board-row:not(.board-row--half-slot)')
    if (fullRows && fullRows.length > 1) {
      const rowStep = Math.abs(fullRows[1].offsetTop - fullRows[0].offsetTop)
      if (rowStep > 0) board?.style.setProperty('--flow-row-step', `${rowStep}px`)
    }

    setIsProgressing(true)
    const timeout = window.setTimeout(() => setIsProgressing(false), 420)
    return () => window.clearTimeout(timeout)
  }, [currentRowIndex])

  const isRoundFlowActive = roundPhase === 'active' || roundPhase === 'result_pending' || roundPhase === 'collectable' || roundPhase === 'won' || roundPhase === 'lost'
  useLayoutEffect(() => {
    if (isRoundFlowActive || !ladderScrollRef.current) return
    ladderScrollRef.current.scrollTop = ladderScrollRef.current.scrollHeight
  }, [isRoundFlowActive, rowPattern])

  const visibleRows = isRoundFlowActive
    ? Array.from({ length: 6 }, (_, slot) => currentRowIndex + 4 - slot)
    : Array.from({ length: totalRows }, (_, slotIndex) => totalRows - slotIndex - 1)

  function getTileState(rowIndex: number, tileIndex: number): 'default' | 'safe' | 'losing' | 'pending' {
    const reveal = reveals.find(r => r.rowIndex === rowIndex)
    if (reveal) {
      if (tileIndex === reveal.selectedTile && reveal.safe) return 'safe'
      if (tileIndex === reveal.losingTile) return 'losing'
    }
    if (rowIndex === currentRowIndex && pendingTileIndex === tileIndex) return 'pending'
    return 'default'
  }

  return (
    <div className={`board-container${isRoundFlowActive ? '' : ' board-container--ladder'}`}>
      <div
        ref={ladderScrollRef}
        className={`board-inner${isRoundFlowActive ? ' board-inner--active-flow' : ' board-inner--ladder'}${isRoundFlowActive && isProgressing ? ' board-inner--advancing' : ''}`}
        tabIndex={isRoundFlowActive ? undefined : 0}
        aria-label={isRoundFlowActive ? undefined : 'Multiplier ladder. Scroll upward to view higher multipliers.'}
      >
        {visibleRows.map((rowIndex, slotIndex) => {
          const isLeadingHalf = isRoundFlowActive && slotIndex === 0
          const isTrailingHalf = isRoundFlowActive && slotIndex === 5
          if (rowIndex < 0 || rowIndex >= totalRows) {
            return (
              <div
                key={`spacer-${slotIndex}`}
                className={`board-row board-row--half-slot board-row--spacer${isLeadingHalf ? ' board-row--leading' : ''}${isTrailingHalf ? ' board-row--trailing' : ''}`}
                aria-hidden="true"
              />
            )
          }

          const tileCount = rowPattern[rowIndex]
          const multWAD = computeMultiplierAfterRows(rowIndex, rowPattern, multiplierCap)
          const multLabel = formatMultiplier(multWAD)
          const previousMultiplier = rowIndex > 0 ? computeMultiplierAfterRows(rowIndex - 1, rowPattern, multiplierCap) : BASE_MULTIPLIER
          const isMilestone = [10n, 100n, 1_000n, 10_000n].some(target =>
            previousMultiplier < target * 1_000_000_000_000_000_000n && multWAD >= target * 1_000_000_000_000_000_000n,
          )
          const isCurrentRow = rowIndex === currentRowIndex
          const isPastRow = rowIndex < currentRowIndex
          const isFutureRow = rowIndex > currentRowIndex
          const rowOpacity = !isRoundFlowActive
            ? 1
            : isCurrentRow
              ? 1
              : isPastRow
              ? 0.5
              : Math.max(0.42, 1 - (rowIndex - currentRowIndex) * 0.1)
          const canClick = isActive && isCurrentRow && roundPhase === 'active' && !isBusy && !isProgressing

          return (
            <div
              key={rowIndex}
              className={`board-row${isCurrentRow ? ' board-row--current' : ''}${isPastRow ? ' board-row--past' : ''}${isFutureRow ? ' board-row--future' : ''}${isLeadingHalf ? ' board-row--half-slot board-row--leading' : ''}${isTrailingHalf ? ' board-row--half-slot board-row--trailing' : ''}`}
            >
              {/* Multiplier label */}
              <div className="row-mult-label">
                <span className={`row-mult-text${isCurrentRow ? ' row-mult-text--current' : ''}${isMilestone ? ' row-mult-text--milestone' : ''}`}>
                  {multLabel}
                </span>
              </div>

              {/* Tiles */}
              <div className={`row-tiles row-tiles--${tileCount}`} style={{ opacity: rowOpacity }}>
                {Array.from({ length: tileCount }, (_, tileIndex) => {
                  const state = getTileState(rowIndex, tileIndex)
                  return (
                    <button
                      key={tileIndex}
                      className={`tile tile--${state}${canClick ? ' tile--clickable' : ''}`}
                      onClick={() => canClick && onTileClick(tileIndex)}
                      disabled={!canClick}
                      aria-label={`Row ${rowIndex + 1} tile ${tileIndex + 1}`}
                    >
                      <ArcTileBadge />
                    </button>
                  )
                })}
              </div>

              {/* Row number */}
              <div className="row-num">
                <span className="row-num-text">{rowIndex + 1}</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
