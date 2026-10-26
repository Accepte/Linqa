import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { X, Hash, Copy, Check } from 'lucide-react'
import { buildTxExplorerUrl } from '@/onchain-facts'
import type { GameRound } from './linqa-types'

interface HistoryPanelProps {
  rounds: GameRound[]
  onClose: () => void
}

export default function HistoryPanel({ rounds, onClose }: HistoryPanelProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(onClose)
  const [expandedRoundId, setExpandedRoundId] = useState<string | null>(null)
  const [copiedRoundId, setCopiedRoundId] = useState<string | null>(null)
  onCloseRef.current = onClose

  const relativeTime = (timestamp?: number) => {
    if (!timestamp || !Number.isFinite(timestamp)) return 'Not found'
    const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
    if (seconds < 60) return `${seconds || 1} sec ago`
    if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`
    if (seconds < 86_400) return `${Math.floor(seconds / 3600)} hr ago`
    if (seconds < 2_592_000) return `${Math.floor(seconds / 86_400)} day${seconds >= 172_800 ? 's' : ''} ago`
    if (seconds < 31_536_000) return `${Math.floor(seconds / 2_592_000)} month${seconds >= 5_184_000 ? 's' : ''} ago`
    const years = Math.floor(seconds / 31_536_000)
    return `${years} year${years === 1 ? '' : 's'} ago`
  }

  const exactTime = (timestamp?: number) => {
    if (!timestamp || !Number.isFinite(timestamp)) return 'Not found'
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'medium',
    }).format(timestamp)
  }

  const compactExactTime = (timestamp?: number) => {
    if (!timestamp || !Number.isFinite(timestamp)) return 'Not found'
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(timestamp)
  }

  const copyGameId = async (event: MouseEvent<HTMLButtonElement>, gameId: string) => {
    event.stopPropagation()
    try {
      await navigator.clipboard.writeText(gameId)
      setCopiedRoundId(gameId)
      window.setTimeout(() => setCopiedRoundId(current => current === gameId ? null : current), 1600)
    } catch {
      setCopiedRoundId(null)
    }
  }

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeButtonRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  return (
    <div className="history-overlay" onClick={onClose}>
      <div className="history-panel" role="dialog" aria-modal="true" aria-labelledby="history-title" onClick={e => e.stopPropagation()}>
        <div className="history-header">
          <span className="history-title" id="history-title">Round History</span>
          <button ref={closeButtonRef} className="history-close" onClick={onClose} aria-label="Close history">
            <X size={16} />
          </button>
        </div>

        {rounds.length === 0 ? (
          <div className="history-empty">No rounds yet. Play a game to see your history here.</div>
        ) : (
          <div className="history-list">
            <div className="history-table-head">
              <span>Time</span>
              <span>Stake</span>
              <span>Result</span>
              <span>Mult</span>
              <span>Payout</span>
              <span>Tx</span>
            </div>
            {rounds.map((r, i) => {
              const expanded = expandedRoundId === `${r.roundId}-${i}`
              const toggleExpanded = () => setExpandedRoundId(expanded ? null : `${r.roundId}-${i}`)
              return (
                <div
                  key={r.roundId + '-' + i}
                  className={`history-record${expanded ? ' history-record--expanded' : ''}`}
                >
                  <div
                    className="history-row"
                    role="button"
                    tabIndex={0}
                    aria-expanded={expanded}
                    onClick={toggleExpanded}
                    onKeyDown={event => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        toggleExpanded()
                      }
                    }}
                  >
                    <span className="history-cell history-cell--time">{relativeTime(r.createdAt)}</span>
                    <span className="history-cell">${r.stake}</span>
                    <span className={`history-cell history-cell--result ${r.won ? 'history-cell--won' : 'history-cell--lost'}`}>
                      {r.won ? 'WON' : 'LOST'}
                    </span>
                    <span className={`history-cell${r.won ? ' history-cell--gold' : ''}`}>{r.multiplier}</span>
                    <span className={`history-cell${r.won ? ' history-cell--gold' : ''}`}>${r.payout}</span>
                    <span className="history-cell">
                      {r.txHash ? (
                        <a
                          href={buildTxExplorerUrl(r.chainId, r.txHash)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="history-link"
                          aria-label="View transaction hash"
                          title="View transaction hash"
                          onClick={event => event.stopPropagation()}
                          onKeyDown={event => event.stopPropagation()}
                        >
                          <Hash size={13} />
                        </a>
                      ) : '—'}
                    </span>
                  </div>
                  {expanded && (
                    <div className="history-detail">
                      <span className="history-detail__time" title={exactTime(r.createdAt)}>
                        <span className="history-detail__time-full">{exactTime(r.createdAt)}</span>
                        <span className="history-detail__time-compact">{compactExactTime(r.createdAt)}</span>
                      </span>
                      <div className="history-detail__meta">
                        <div className="history-detail__game">
                          <span className="history-detail__label">Game ID:</span>
                          <code className="history-detail__id">{r.roundId}</code>
                          <button
                            className="history-copy"
                            type="button"
                            aria-label={copiedRoundId === r.roundId ? 'Game ID copied' : 'Copy game ID'}
                            title={copiedRoundId === r.roundId ? 'Copied' : 'Copy game ID'}
                            onClick={event => void copyGameId(event, r.roundId)}
                          >
                            {copiedRoundId === r.roundId ? <Check size={13} /> : <Copy size={13} />}
                          </button>
                        </div>
                        {r.won && (
                          <div className="history-detail__winning-hash">
                            <span className="history-detail__label">Winning hash:</span>
                            {r.txHash ? (
                              <a
                                href={buildTxExplorerUrl(r.chainId, r.txHash)}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="history-tx-hash"
                                aria-label="View winning transaction hash"
                                title="Winning hash"
                              >
                                <Hash size={13} />
                              </a>
                            ) : <span className="history-detail__missing-hash">—</span>}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
            <div className="history-end">No More</div>
          </div>
        )}
      </div>
    </div>
  )
}
