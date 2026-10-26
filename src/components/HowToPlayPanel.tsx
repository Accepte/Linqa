import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'

interface HowToPlayPanelProps {
  onClose: () => void
}

const steps = [
  'Choose your stake. The minimum is $0.50 USDC.',
  'Pick one tile in each row. A safe pick moves you forward and raises your multiplier.',
  'Cash out when you want to collect the displayed payout. Cashout becomes available after your first safe pick.',
  'If you hit a losing tile, the round ends and you lose your stake.',
]

export default function HowToPlayPanel({ onClose }: HowToPlayPanelProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

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
      <section
        className="how-to-play-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="how-to-play-title"
        onClick={event => event.stopPropagation()}
      >
        <header className="how-to-play-header">
          <h2 id="how-to-play-title">How to Play</h2>
          <button ref={closeButtonRef} className="how-to-play-close" type="button" onClick={onClose} aria-label="Close how to play">
            <X size={17} />
          </button>
        </header>
        <ol className="how-to-play-steps">
          {steps.map((step, index) => (
            <li key={step}>
              <span className="how-to-play-step-number">{index + 1}</span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  )
}
