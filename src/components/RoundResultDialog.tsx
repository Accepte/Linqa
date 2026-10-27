import { useEffect, useRef, useState } from 'react'
import { Copy, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { buildTxExplorerUrl } from '@/onchain-facts'
import { ARC_MARK_PATH, BADGE_PATH } from './LinqaBoard'

const LOSS_ILLUSTRATIONS = [
  '/loss-illustrations/halloween.svg',
  '/loss-illustrations/warnings.svg',
  '/loss-illustrations/page-eaten.svg',
  '/loss-illustrations/imagination.svg',
]

export interface RoundOutcome {
  type: 'won' | 'lost'
  gameId: string
  amount: string
  multiplier?: string
  txHash: `0x${string}` | null
  chainId: number
  demo: boolean
}

interface RoundResultDialogProps {
  outcome: RoundOutcome
  onClose: () => void
}

export default function RoundResultDialog({ outcome, onClose }: RoundResultDialogProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const confettiCanvasRef = useRef<HTMLCanvasElement>(null)
  const won = outcome.type === 'won'
  const [lossIllustration] = useState(() => LOSS_ILLUSTRATIONS[Math.floor(Math.random() * LOSS_ILLUSTRATIONS.length)])
  const [showWinnerLabel, setShowWinnerLabel] = useState(!won)
  const [showConfirmButton, setShowConfirmButton] = useState(!won)

  useEffect(() => {
    if (!won) return
    const winnerTimer = window.setTimeout(() => setShowWinnerLabel(true), 650)
    const confirmTimer = window.setTimeout(() => setShowConfirmButton(true), 950)
    return () => {
      window.clearTimeout(winnerTimer)
      window.clearTimeout(confirmTimer)
    }
  }, [won, outcome.gameId])

  useEffect(() => {
    if (showConfirmButton) closeButtonRef.current?.focus()
  }, [showConfirmButton])

  useEffect(() => {
    if (!won || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const canvas = confettiCanvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return

    const colors = ['#E9EDF4', '#D6BE8B', '#20283B']
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const pieces: Array<{
      x: number; y: number; size: number; vx: number; vy: number;
      rot: number; vr: number; sway: number; swaySpeed: number; color: string;
    }> = []
    let width = 0
    let height = 0
    let frame = 0
    let running = true

    const resize = () => {
      width = window.innerWidth
      height = window.innerHeight
      canvas.width = width * dpr
      canvas.height = height * dpr
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    const rand = (min: number, max: number) => min + Math.random() * (max - min)
    const spawnPiece = () => {
      pieces.push({
        x: rand(0, width), y: -20, size: rand(5, 11),
        vx: rand(-0.8, 0.8), vy: rand(1.4, 3.4),
        rot: rand(0, Math.PI * 2), vr: rand(-0.14, 0.14),
        sway: rand(0, Math.PI * 2), swaySpeed: rand(0.02, 0.05),
        color: colors[Math.floor(Math.random() * colors.length)],
      })
    }
    const update = () => {
      ctx.clearRect(0, 0, width, height)
      if (running && pieces.length < 160 && Math.random() < 0.9) spawnPiece()

      for (let i = pieces.length - 1; i >= 0; i--) {
        const piece = pieces[i]
        piece.sway += piece.swaySpeed
        piece.x += piece.vx + Math.sin(piece.sway) * 0.6
        piece.y += piece.vy
        piece.rot += piece.vr
        if (piece.y > height + 20) {
          if (running) {
            piece.y = -20
            piece.x = rand(0, width)
          } else {
            pieces.splice(i, 1)
            continue
          }
        }
        ctx.save()
        ctx.translate(piece.x, piece.y)
        ctx.rotate(piece.rot)
        ctx.fillStyle = piece.color
        ctx.fillRect(-piece.size / 2, -piece.size / 4, piece.size, piece.size / 2)
        ctx.restore()
      }
      frame = window.requestAnimationFrame(update)
    }

    resize()
    window.addEventListener('resize', resize)
    frame = window.requestAnimationFrame(update)
    return () => {
      running = false
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', resize)
      ctx.clearRect(0, 0, width, height)
    }
  }, [won])

  const copyGameId = async () => {
    try {
      await navigator.clipboard.writeText(outcome.gameId)
      toast.success('Game ID copied')
    } catch {
      toast.error('Could not copy Game ID')
    }
  }

  return (
    <>
      <div className="fortune-backdrop is-open" aria-hidden="true" />
      {won && <canvas ref={confettiCanvasRef} className="fortune-confetti-canvas" aria-hidden="true" />}
      <section
        className={`fortune-panel${won ? ' win-panel' : ' loss-panel'} is-open`}
        role="dialog"
        aria-modal="true"
        aria-label={won ? 'You won' : 'You lost'}
        onClick={(event) => {
          if (!won && event.target === event.currentTarget) onClose()
        }}
      >
        <div className="fortune-card">
          {won && <img className="fortune-win-illustration" src="/win-illustration.svg" alt="" aria-hidden="true" />}
          {won ? (
            <div className="fortune-win-heading">
              <span className="fortune-win-badge-flip" aria-hidden="true">
                <span className="fortune-win-badge-shake">
                  <svg className="fortune-panel-icon fortune-panel-icon--win" width="75" height="75" viewBox="0 0 200 200">
                    <path d={BADGE_PATH} fill="#3FBE7C" />
                    <path d={ARC_MARK_PATH} transform="translate(24.25 27.25) scale(0.75)" fill="#E9EDF4" />
                  </svg>
                </span>
              </span>
              <p
                className={`fortune-label fortune-label--winner${showWinnerLabel ? ' fortune-win-label-in' : ' fortune-win-label-wait'}`}
                aria-hidden={!showWinnerLabel}
              >
                WINNER!!
              </p>
            </div>
          ) : (
            <div className="fortune-win-heading fortune-loss-heading">
              <svg className="fortune-panel-icon fortune-panel-icon--loss" width="64" height="64" viewBox="0 0 200 200" aria-hidden="true">
                <path d="M100 8c14 0 22 12 34 15s27-4 36 6 4 25 10 36 20 17 20 35-14 24-20 35 0 26-10 36-24 3-36 6-20 15-34 15-22-12-34-15-27 4-36-6-4-25-10-36-20-17-20-35 14-24 20-35 0-26 10-36 24-3 36-6 20-15 34-15z" fill="#C8495A" stroke="#141A27" strokeWidth="2.5" />
                <g stroke="#E9EDF4" strokeWidth="7" strokeLinecap="round">
                  <path d="M66 66l24 24M90 66 66 90M110 66l24 24M134 66l-24 24" />
                </g>
                <path d="M64 142q36-26 72 0" fill="none" stroke="#E9EDF4" strokeWidth="7" strokeLinecap="round" />
                <g stroke="#E9EDF4" strokeWidth="2.5" fill="none" strokeLinecap="round" opacity=".8">
                  <path d="m56 42 20 22-14 22M144 50l-18 24 16 24" />
                </g>
              </svg>
              <p className="fortune-label fortune-label--loss">YOU LOST!!</p>
              <p className="fortune-loss-amount">−${outcome.amount} USDC</p>
            </div>
          )}
          {won && (
            <div className="fortune-win-payout-stack">
              <p className="fortune-amount">+${outcome.amount} USDC</p>
              {outcome.multiplier && (
                <div className="fortune-win-multiplier">
                  <strong>{outcome.multiplier}</strong>
                </div>
              )}
            </div>
          )}

          {!won && <img className="fortune-loss-illustration" src={lossIllustration} alt="" aria-hidden="true" />}
          <div className="fortune-game-id">
            <span>GAME ID:</span>
            <code title={outcome.gameId}>{outcome.gameId}</code>
            <button type="button" onClick={() => void copyGameId()} aria-label="Copy Game ID" title="Copy Game ID"><Copy size={14} /></button>
            {won && outcome.txHash && (
              <a className="fortune-tx-link" href={buildTxExplorerUrl(outcome.chainId, outcome.txHash)} target="_blank" rel="noopener noreferrer" aria-label="View winning transaction" title="View transaction">
                <span>TRANSACTION</span>
                <ExternalLink size={12} aria-hidden="true" />
              </a>
            )}
          </div>

          <div className="fortune-confirm-slot">
            {showConfirmButton && (
              <button ref={closeButtonRef} className={`fortune-btn fortune-btn-result fortune-btn-result--${won ? 'win' : 'loss'}${won ? ' fortune-win-button-in' : ''}`} type="button" onClick={onClose}>
                {won ? 'OK' : 'Play Again'}
              </button>
            )}
          </div>
        </div>
      </section>
    </>
  )
}
