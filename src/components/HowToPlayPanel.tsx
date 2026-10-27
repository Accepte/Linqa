import { useEffect, useRef } from 'react'
import { ExternalLink, X } from 'lucide-react'

interface HowToPlayPanelProps {
  onClose: () => void
}

const steps = [
  'Choose your stake. The minimum is $0.50 USDC.',
  'Pick one tile in each row. A safe pick moves you forward and raises your multiplier.',
  'Cash out when you want to collect the displayed payout. Cashout becomes available after your first safe pick.',
  'If you hit a losing tile, the round ends and you lose your stake.',
]

function XBrandMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="how-to-play-social-mark">
      <path d="M18.9 2h3.2l-7 8 8.2 12h-6.4l-5.1-7.6L5.2 22H2l7.5-8.6L1.8 2h6.6l4.6 6.9L18.9 2Zm-1.1 17.9h1.8L7.6 4H5.7l12.1 15.9Z" />
    </svg>
  )
}

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
        aria-labelledby="social-title"
        onClick={event => event.stopPropagation()}
      >
        <header className="how-to-play-header">
          <h2 id="social-title">Social</h2>
          <button ref={closeButtonRef} className="how-to-play-close" type="button" onClick={onClose} aria-label="Close game information">
            <X size={17} />
          </button>
        </header>
        <nav className="how-to-play-social-links" aria-label="Linqa social accounts">
          <a className="how-to-play-social-link" href="https://x.com/linqagame" target="_blank" rel="noopener noreferrer">
            <span className="how-to-play-social-icon"><XBrandMark /></span>
            <span className="how-to-play-social-copy"><strong>Linqa</strong><span>@linqagame</span></span>
            <ExternalLink className="how-to-play-social-external" size={14} aria-hidden="true" />
          </a>
          <a className="how-to-play-social-link" href="https://x.com/acceptesui" target="_blank" rel="noopener noreferrer">
            <span className="how-to-play-social-icon"><XBrandMark /></span>
            <span className="how-to-play-social-copy"><strong>Founder</strong><span>@acceptesui</span></span>
            <ExternalLink className="how-to-play-social-external" size={14} aria-hidden="true" />
          </a>
        </nav>
        <h3 className="how-to-play-section-title">How to Play</h3>
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
