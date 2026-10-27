import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { AlertTriangle, Frown, Info, PartyPopper, Trophy, X } from 'lucide-react'
import './NoticeBar.css'

export type NoticeTone = 'info' | 'promo' | 'warning' | 'win' | 'loss'

export interface NoticeBarItem {
  id: string
  tone: NoticeTone
  message: string
  subtitle?: string
  meta?: string
  player?: string
  amount?: string
  linkUrl?: string | null
  linkLabel?: string
}

interface NoticeBarProps {
  notice: NoticeBarItem
  durationMs: number
  paused: boolean
  onPauseChange: (paused: boolean) => void
}

interface Particle {
  kind: 'petal' | 'flame' | 'dot' | 'star'
  x: number; y: number; vx: number; vy: number; gravity: number
  age: number; life: number; size: number; rotation: number; spin: number
  phase: number; sway: number; color: string; alpha: number
}

const palette: Record<NoticeTone, string[]> = {
  win: ['#22c55e', '#16a34a', '#f5b301', '#fff'],
  loss: ['#e11d48', '#be123c', '#fff'],
  promo: ['#f5b301', '#e0a100', '#fff3c4'],
  info: ['#94a3b8', '#64748b', '#fff'],
  warning: ['#ff3b30', '#ff9f0a', '#fff'],
}
const PROMO_FLAME_HEIGHT = .1875

function NoticeIcon({ tone }: { tone: NoticeTone }) {
  const common = { size: 16, strokeWidth: 2.2, 'aria-hidden': true as const }
  if (tone === 'win') return <Trophy {...common} />
  if (tone === 'loss') return <Frown {...common} />
  if (tone === 'promo') return <PartyPopper {...common} />
  if (tone === 'warning') return <AlertTriangle {...common} />
  return <Info {...common} />
}

function NoticeParticles({ tone, noticeId }: { tone: NoticeTone; noticeId: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const toneRef = useRef(tone)
  const idRef = useRef(noticeId)
  toneRef.current = tone
  idRef.current = noticeId

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    const host = canvas?.parentElement
    if (!canvas || !ctx || !host) return
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let width = 0, height = 40, dpr = 1, raf = 0, previous = performance.now(), seenId = idRef.current
    let particles: Particle[] = []
    let heat = 0
    const resize = () => {
      const box = host.getBoundingClientRect()
      dpr = Math.min(2, window.devicePixelRatio || 1)
      width = box.width
      height = box.height
      canvas.width = Math.ceil((width + 48) * dpr)
      canvas.height = Math.ceil((height + 300) * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    resize()
    const rand = (min: number, max: number) => min + Math.random() * (max - min)
    const add = (p: Particle) => { if (particles.length < 360) particles.push(p) }
    const make = (kind: Particle['kind'], x: number, y: number, vx: number, vy: number, life: number, size: number, color: string, gravity = 0) => add({ kind, x, y, vx, vy, gravity, age: 0, life, size, rotation: rand(0, 6.28), spin: rand(-3, 3), phase: rand(0, 6.28), sway: rand(14, 34), color, alpha: 1 })
    const burst = (mode: NoticeTone) => {
      if (reducedMotion) return
      const x = 24 + width * 0.28, y = 150 + height / 2
      if (mode === 'win') for (let i = 0; i < 24; i++) make('petal', x, y, rand(-120, 260), -rand(50, 200), rand(1.4, 2.2), rand(4, 8), palette.win[i % palette.win.length], 150)
      if (mode === 'promo') {
        for (let i = 0; i < 18; i++) { const a = rand(0, 6.28), v = rand(30, 120); make('star', x, y, Math.cos(a) * v, Math.sin(a) * v, rand(.9, 1.5), rand(4, 9), palette.promo[i % 3]) }
        for (let i = 0; i < 56; i++) {
          const bottom = i % 2 === 0
          make('flame', 24 + rand(8, width - 8), bottom ? 150 + height - rand(0, 6) : 150 + rand(0, 6), rand(-20, 20) * PROMO_FLAME_HEIGHT, (bottom ? 1 : -1) * rand(120, 230) * PROMO_FLAME_HEIGHT, rand(.8, 1.2), rand(7, 12), '#ff9a22', (bottom ? -60 : 60) * PROMO_FLAME_HEIGHT)
        }
      }
      if (mode === 'warning') for (let i = 0; i < 14; i++) make('dot', x, y, rand(-120, 120), rand(-120, 60), rand(.5, .9), rand(1.2, 2.4), palette.warning[i % 3])
    }
    burst(toneRef.current)
    const draw = (now: number) => {
      const dt = Math.min(.05, (now - previous) / 1000)
      previous = now
      const mode = toneRef.current
      if (seenId !== idRef.current) { seenId = idRef.current; burst(mode) }
      if (!reducedMotion) {
        if (mode === 'win' && Math.random() < dt * 9) make('petal', 24 + rand(8, width - 8), 150 + height + 4, rand(-8, 8), -rand(28, 62), rand(2, 3.2), rand(4, 8), palette.win[Math.floor(rand(0, 4))])
        if (mode === 'loss' && Math.random() < dt * 4.5) make('petal', 24 + rand(8, width - 8), 150, rand(-6, 6), rand(22, 46), rand(2, 3.2), rand(4, 8), palette.loss[Math.floor(rand(0, 3))])
        if (mode === 'promo') {
          const count = Math.floor(dt * 135)
          for (let i = 0; i < count; i++) {
            const bottom = Math.random() < .5
            make('flame', 24 + rand(8, width - 8), bottom ? 150 + height - 2 : 150 + 2, rand(-12, 12) * PROMO_FLAME_HEIGHT, (bottom ? 1 : -1) * rand(80, 170) * PROMO_FLAME_HEIGHT, rand(.7, 1.1), rand(5.5, 10), '#ff9a22', (bottom ? -60 : 60) * PROMO_FLAME_HEIGHT)
          }
          if (Math.random() < dt * 7) make('star', 24 + rand(-6, width + 6), 150 + rand(-10, height + 10), 0, -rand(4, 12), rand(.9, 1.5), rand(4, 9), palette.promo[Math.floor(rand(0, 3))])
        }
        if (mode === 'info' && Math.random() < dt * 2) make('petal', 24 + rand(0, width * .3), 150 + rand(6, height - 6), rand(16, 28), rand(-4, 4), rand(2, 3), rand(4, 8), palette.info[Math.floor(rand(0, 3))])
        if (mode === 'warning' && Math.random() < dt * 14) make('dot', 24 + rand(8, width - 8), 150 + height, rand(-14, 14), -rand(80, 150), rand(.4, .8), rand(1.2, 2.4), palette.warning[Math.floor(rand(0, 3))])
      }
      ctx.clearRect(0, 0, width + 48, height + 300)
      heat += ((mode === 'promo' && !reducedMotion ? 1 : 0) - heat) * Math.min(1, dt * 4)
      if (heat > .01) for (const y of [142, 158 + height]) {
        ctx.save(); ctx.translate(24 + width / 2, y); ctx.scale(1, .3)
        const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, width * .6)
        glow.addColorStop(0, `rgba(255,120,0,${.18 * heat})`); glow.addColorStop(1, 'rgba(255,120,0,0)')
        ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(0, 0, width * .6, 0, 6.283); ctx.fill(); ctx.restore()
      }
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i]; p.age += dt
        if (p.age >= p.life) { particles.splice(i, 1); continue }
        p.vy += p.gravity * dt; p.x += p.vx * dt; p.y += p.vy * dt
        const f = p.age / p.life, fade = 1 - f
        if (p.kind === 'petal') {
          p.x += Math.sin(p.age * 2.2 + p.phase) * p.sway * dt; p.rotation += p.spin * dt
          ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rotation); ctx.scale(1, Math.cos(p.age * 3 + p.phase)); ctx.globalAlpha = Math.min(1, fade * 2.2, f * 7); ctx.fillStyle = p.color
          ctx.beginPath(); ctx.moveTo(-p.size, 0); ctx.quadraticCurveTo(0, -p.size * .8, p.size, 0); ctx.quadraticCurveTo(0, p.size * .8, -p.size, 0); ctx.fill(); ctx.restore()
        } else if (p.kind === 'flame') {
          p.x += Math.sin(p.age * 7 + p.phase) * p.sway * dt
          const radius = p.size * (1 - f * .75), gradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius)
          gradient.addColorStop(0, `hsla(${52 - f * 46},100%,${58 - f * 14}%,${fade * .75})`); gradient.addColorStop(1, 'hsla(38,100%,50%,0)')
          ctx.fillStyle = gradient; ctx.beginPath(); ctx.arc(p.x, p.y, radius, 0, 6.283); ctx.fill()
        } else if (p.kind === 'dot') {
          ctx.globalAlpha = Math.min(1, fade * 1.6); ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, 6.283); ctx.fill(); ctx.globalAlpha = 1
        } else {
          const size = p.size * Math.sin(f * Math.PI); ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(f * 1.2); ctx.fillStyle = p.color; ctx.globalAlpha = .95
          ctx.beginPath(); ctx.moveTo(0, -size); ctx.quadraticCurveTo(0, 0, size, 0); ctx.quadraticCurveTo(0, 0, 0, size); ctx.quadraticCurveTo(0, 0, -size, 0); ctx.fill(); ctx.restore(); ctx.globalAlpha = 1
        }
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => { cancelAnimationFrame(raf); observer.disconnect() }
  }, [])

  return <canvas ref={canvasRef} className="lq-fx" aria-hidden="true" />
}

function AnimatedAmount({ value }: { value: string }) {
  const [shown, setShown] = useState(value)
  useEffect(() => {
    const match = value.match(/^(.*?)(\d[\d,]*(?:\.\d+)?)(.*)$/)
    if (!match) { setShown(value); return }
    const [, prefix, raw, suffix] = match
    const target = Number(raw.replaceAll(',', ''))
    if (!Number.isFinite(target) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setShown(value); return }
    const decimals = raw.includes('.') ? raw.split('.')[1].length : 0
    const start = performance.now()
    let raf = 0
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / 1100)
      const eased = 1 - Math.pow(1 - progress, 4)
      setShown(`${prefix}${(target * eased).toFixed(decimals)}${suffix}`)
      if (progress < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value])
  return <strong className="lq-amt">{shown}</strong>
}

export default function NoticeBar({ notice, durationMs, paused, onPauseChange }: NoticeBarProps) {
  const [entered, setEntered] = useState(false)
  const [shaking, setShaking] = useState(false)
  useEffect(() => {
    setEntered(false)
    const timer = window.setTimeout(() => setEntered(true), 35)
    setShaking(notice.tone === 'loss')
    const shakeTimer = window.setTimeout(() => setShaking(false), 550)
    return () => { window.clearTimeout(timer); window.clearTimeout(shakeTimer) }
  }, [notice.id])

  return (
    <div className={`lq-notice${shaking ? ' lq-shake' : ''}`} data-mode={notice.tone} aria-live="polite" aria-atomic="true" style={{ '--notice-duration': `${durationMs}ms` } as CSSProperties} onPointerEnter={() => onPauseChange(true)} onPointerLeave={() => onPauseChange(false)}>
      <div className="lq-glow" />
      <div className="lq-ground" />
      <div className="lq-wash">
        <div className="lq-shine" />
        <div className="lq-flash" key={`flash-${notice.id}`} />
        <div className="lq-haz" />
        <div className="lq-stage">
          <div className={`lq-slide${entered ? ' in' : ''}${notice.linkUrl ? ' hascta' : ''}`} data-m={notice.tone}>
            <span className="lq-med"><NoticeIcon tone={notice.tone} /></span>
            <span className="lq-txt">
              <span className="lq-t">
                {notice.player && <span className="lq-who">{notice.player}</span>}
                {notice.message}
                {notice.amount && <AnimatedAmount value={notice.amount} />}
              </span>
              {notice.subtitle && <small>{notice.subtitle}</small>}
            </span>
            {notice.meta && <span className="lq-meta">{notice.meta}</span>}
          </div>
        </div>
        {notice.linkUrl && <a className="lq-cta" href={notice.linkUrl} target="_blank" rel="noopener noreferrer"><X size={13} aria-hidden="true" /><span>{notice.linkLabel ?? 'Open'}</span></a>}
      </div>
      <i className="lq-rail t" />
      <i className="lq-rail b" />
      <i className="lq-prog" key={`progress-${notice.id}`} style={{ animationPlayState: paused ? 'paused' : 'running' }} />
      <NoticeParticles tone={notice.tone} noticeId={notice.id} />
    </div>
  )
}
