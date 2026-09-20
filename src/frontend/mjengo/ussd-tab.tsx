'use client'

// USSD Muster Line — SIMULATION (M-8).
//
// A phone-frame simulation of the *384# feature-phone attendance flow
// MjengoOS would run on any Kenyan network. The demo is honest about being a
// simulation, but it dispatches REAL attendance records through the store's
// dispatch() — the same actions the Fundis tab uses:
//   · Present → 'attendance.checkin' { workerId, toggle: 'in', method: 'ussd' }
//     (the worker keyed their own PIN — worker evidence, verification
//     'verified', evidence ['ussd','device'], method 'ussd' → USSD badge)
//   · Absent  → 'attendance.record' { records, verification: 'reported',
//     recordedBy: 'USSD *384#' } (an absence is a statement, not evidence)
//
// PIN mapping (demo): the worker's kiosk PIN (Worker.pin) when set, otherwise
// the last 4 digits of their phone. Both are accepted for workers with a PIN.
//
// Offline story: when the store's online toggle is OFF the dispatch queues
// in the on-device outbox — the screen says so, visibly.
//
// W4-3: this tab is the FIELD CHANNELS surface — the WhatsApp panel
// (whatsapp-panel.tsx) renders below the USSD card: the other honest
// out-of-app capture line, exercised through the public webhook seam.
//
// #140 (audit FE-9): the whole simulation body renders through the ussd.*
// dict family (EN+SW) — LCD script, input-line status, keypad aria-labels,
// network notes, explainer, demo-PIN list, toasts and the client-only
// dispatch labels. Dial SYNTAX stays data, never copy: *384#, menu digit
// prefixes ("1. "), ITU E.161 keypad letters and the stored
// recordedBy: 'USSD *384#' value are identical in both locales. The LCD is
// a session transcript — pushed lines snapshot the locale at push time
// (same semantics as the WhatsApp chat); a locale flip re-renders the boot
// lines only while the sim still sits on the idle screen.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useMjengo } from '@/frontend/hooks/use-mjengo'
import type { WorkerWithAttendance } from '@/backend/lib/mjengo'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/frontend/ui/card'
import { Badge } from '@/frontend/ui/badge'
import { Button } from '@/frontend/ui/button'
import { Phone, PhoneCall, PhoneOff, Delete, Smartphone, WifiOff, Info } from 'lucide-react'
import { toast } from 'sonner'
import { useT } from '@/frontend/i18n/provider'
import { WhatsAppPanel } from '@/frontend/mjengo/whatsapp-panel'

// ---------------- LCD session types ----------------

type Screen = 'dial' | 'dialing' | 'menu' | 'pin' | 'worker' | 'confirm' | 'saving' | 'done' | 'ended'

type LcdTone = 'normal' | 'dim' | 'ok' | 'warn' | 'err'

interface LcdLine {
  text: string
  tone?: LcdTone
}

const TONE_CLASS: Record<LcdTone, string> = {
  normal: 'text-emerald-100/90',
  dim: 'text-emerald-200/40',
  ok: 'text-emerald-300 font-bold',
  warn: 'text-amber-300',
  err: 'text-red-400',
}

const MAX_PIN_TRIES = 3

/** Last 4 digits of a phone — the demo PIN for workers without a kiosk PIN. */
function phonePin(phone: string): string {
  const digits = (phone || '').replace(/\D/g, '')
  return digits.slice(-4)
}

const KEYS: Array<{ main: string; sub?: string }> = [
  { main: '1' },
  { main: '2', sub: 'ABC' },
  { main: '3', sub: 'DEF' },
  { main: '4', sub: 'GHI' },
  { main: '5', sub: 'JKL' },
  { main: '6', sub: 'MNO' },
  { main: '7', sub: 'PQRS' },
  { main: '8', sub: 'TUV' },
  { main: '9', sub: 'WXYZ' },
  { main: '*', sub: '+' },
  { main: '0', sub: '␣' },
  { main: '#', sub: '⌗' },
]

// Known stored attendance statuses (mirrors fundis-tab's STATUS_LABELS
// guard): a rogue stored value must not leak a raw dict key onto the LCD.
const KNOWN_STATUSES = new Set(['present', 'half_day', 'absent', 'excused'])

// ---------------- component ----------------

export function UssdTab() {
  const { data, dispatch, online, outbox, viewMode } = useMjengo()
  const t = useT()

  const [screen, setScreen] = useState<Screen>('dial')
  const [dialBuf, setDialBuf] = useState('*384#')
  const [pinBuf, setPinBuf] = useState('')
  const [pinTries, setPinTries] = useState(0)
  const [worker, setWorker] = useState<WorkerWithAttendance | null>(null)
  const [choice, setChoice] = useState<'present' | 'absent' | null>(null)

  // t()-aware boot lines (#140): the idle LCD renders in the active locale.
  const bootLines = useMemo<LcdLine[]>(
    () => [
      { text: t('ussd.lcd.bootReady') },
      { text: t('ussd.lcd.bootDial'), tone: 'dim' },
    ],
    [t],
  )

  // Session transcript only — the idle screen's boot lines are DERIVED
  // (lcdLines below), so the state starts empty and holds pushed lines.
  const [log, setLog] = useState<LcdLine[]>([])

  const lcdRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<number | null>(null)

  const isClient = viewMode === 'client'
  const busy = screen === 'dialing' || screen === 'saving'

  const activeWorkers = useMemo(
    () => (data?.workers ?? []).filter((w) => w.active !== false),
    [data],
  )

  // Auto-scroll the LCD to the newest line.
  useEffect(() => {
    const el = lcdRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [log])

  // Clear any pending transition timer on unmount.
  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
  }, [])

  // A locale flip while the sim still sits on the idle screen re-renders the
  // boot lines in the new language (#140) — DERIVED, not synced: the idle
  // screen always renders the current-locale boot lines; a session in
  // progress keeps its pushed transcript (the LCD is a session log, not a
  // live template), so the state only ever holds session lines.
  const lcdLines = screen === 'dial' ? bootLines : log

  function pushLog(lines: LcdLine[]) {
    setLog((prev) => [...prev, ...lines])
  }

  function resetSession() {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    setScreen('dial')
    setDialBuf('*384#')
    setPinBuf('')
    setPinTries(0)
    setWorker(null)
    setChoice(null)
    setLog([])
  }

  /** Begin the *384# dial sequence from the dial screen. */
  function beginDial() {
    setScreen('dialing')
    pushLog([{ text: t('ussd.lcd.dialing'), tone: 'dim' }])
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      pushLog([
        { text: t('ussd.lcd.welcome') },
        { text: t('ussd.lcd.muster') },
        { text: `1. ${t('ussd.lcd.mark')}` },
        { text: `2. ${t('ussd.lcd.exit')}` },
      ])
      setScreen('menu')
    }, 900)
  }

  // ---------------- state machine ----------------

  function startDial() {
    if (screen === 'done' || screen === 'ended') {
      // "Dial again": fresh session that dials straight away.
      resetSession()
      beginDial()
      return
    }
    if (screen === 'dial') {
      if (dialBuf.trim() !== '*384#') {
        pushLog([{ text: t('ussd.lcd.invalid'), tone: 'warn' }])
        return
      }
      beginDial()
      return
    }
    if (screen === 'pin') {
      if (pinBuf.length === 4) validatePin(pinBuf)
      return
    }
    if (screen === 'confirm') {
      void doRecord()
    }
  }

  function hangUp() {
    if (screen === 'dial' || screen === 'done' || screen === 'ended') {
      resetSession()
      return
    }
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    pushLog([{ text: t('ussd.lcd.callEnded'), tone: 'dim' }])
    setScreen('ended')
  }

  function backspace() {
    if (screen === 'dial') setDialBuf((b) => b.slice(0, -1))
    if (screen === 'pin') setPinBuf((b) => b.slice(0, -1))
  }

  function validatePin(pin: string) {
    // Kiosk PIN match first, then phone last-4.
    const found =
      activeWorkers.find((w) => (w.pin ?? '') === pin && pin !== '') ??
      activeWorkers.find((w) => phonePin(w.phone) === pin && pin !== '')

    if (found) {
      setWorker(found)
      setScreen('worker')
      const lines: LcdLine[] = [
        { text: t('ussd.lcd.name', { name: found.name }) },
        { text: t('ussd.lcd.role', { role: found.role }) },
      ]
      const st = found.todayStatus.status
      if (st && KNOWN_STATUSES.has(st)) {
        lines.push({ text: t('ussd.lcd.alreadyToday', { status: t(`fundis.status.${st}`) }), tone: 'dim' })
      }
      lines.push(
        { text: `1. ${t('fundis.status.present')}` },
        { text: `2. ${t('fundis.status.absent')}` },
      )
      pushLog(lines)
      return
    }

    const tries = pinTries + 1
    setPinTries(tries)
    setPinBuf('')
    if (tries >= MAX_PIN_TRIES) {
      pushLog([
        { text: t('ussd.lcd.tooMany'), tone: 'err' },
        { text: t('ussd.lcd.endedKwaheri') },
      ])
      setScreen('ended')
      return
    }
    pushLog([
      { text: t('ussd.lcd.pinBadA'), tone: 'warn' },
      { text: t('ussd.lcd.pinBadB', { n: MAX_PIN_TRIES - tries }), tone: 'warn' },
    ])
  }

  async function doRecord() {
    if (!worker || !choice) return
    if (isClient) {
      pushLog([
        { text: t('ussd.lcd.readonlyA'), tone: 'err' },
        { text: t('ussd.lcd.readonlyB') },
        { text: t('ussd.lcd.readonlyC') },
      ])
      setScreen('ended')
      return
    }
    setScreen('saving')
    pushLog([{ text: t('ussd.lcd.recording'), tone: 'dim' }])

    let ok = false
    if (choice === 'present') {
      // Worker-initiated USSD check-in — carries 'ussd' evidence.
      ok = await dispatch(
        'attendance.checkin',
        { workerId: worker.id, toggle: 'in', method: 'ussd' },
        t('ussd.dispatch.checkIn', { name: worker.name }),
      )
    } else {
      // Absence is a reported statement from the line, not worker evidence.
      ok = await dispatch(
        'attendance.record',
        {
          records: JSON.stringify([{ workerId: worker.id, status: 'absent' }]),
          verification: 'reported',
          recordedBy: 'USSD *384#', // stored data — identical in both locales
        },
        t('ussd.dispatch.absent', { name: worker.name }),
      )
    }

    setScreen(ok ? 'done' : 'ended')
    if (ok) {
      if (online) {
        pushLog([
          { text: t('ussd.lcd.recorded'), tone: 'ok' },
          { text: t('ussd.lcd.asante') },
        ])
        toast.success(
          choice === 'present'
            ? t('ussd.toast.checkedIn', { name: worker.name })
            : t('ussd.toast.absent', { name: worker.name }),
        )
      } else {
        pushLog([
          { text: t('ussd.lcd.queuedA'), tone: 'warn' },
          { text: t('ussd.lcd.queuedB'), tone: 'warn' },
          { text: t('ussd.lcd.recorded') },
        ])
        toast.info(t('ussd.toast.queued'))
      }
      pushLog([{ text: t('ussd.lcd.sessionEnded'), tone: 'dim' }])
    } else {
      pushLog([
        { text: t('ussd.lcd.failA'), tone: 'err' },
        { text: t('ussd.lcd.failB'), tone: 'err' },
      ])
    }
  }

  function pressKey(key: string) {
    if (busy) return
    switch (screen) {
      case 'dial': {
        if (/^[0-9*#]$/.test(key)) setDialBuf((b) => (b.length < 16 ? b + key : b))
        break
      }
      case 'menu': {
        if (key === '1') {
          setScreen('pin')
          pushLog([{ text: t('ussd.lcd.pinPrompt') }])
        } else if (key === '2') {
          pushLog([{ text: t('ussd.lcd.bye') }])
          setScreen('ended')
        }
        break
      }
      case 'pin': {
        if (!/^[0-9]$/.test(key)) return
        const next = (pinBuf + key).slice(0, 4)
        setPinBuf(next)
        if (next.length === 4) {
          // Feature-phone feel: short pause, then the network replies.
          timerRef.current = window.setTimeout(() => {
            timerRef.current = null
            validatePin(next)
          }, 600)
        }
        break
      }
      case 'worker': {
        if (key === '1') {
          setChoice('present')
          setScreen('confirm')
          pushLog([
            { text: t('ussd.lcd.confirm', { status: t('fundis.status.present').toUpperCase() }) },
            { text: `1. ${t('ussd.lcd.yes')}` },
            { text: `2. ${t('ussd.lcd.no')}` },
          ])
        } else if (key === '2') {
          setChoice('absent')
          setScreen('confirm')
          pushLog([
            { text: t('ussd.lcd.confirm', { status: t('fundis.status.absent').toUpperCase() }) },
            { text: `1. ${t('ussd.lcd.yes')}` },
            { text: `2. ${t('ussd.lcd.no')}` },
          ])
        }
        break
      }
      case 'confirm': {
        if (key === '1') void doRecord()
        else if (key === '2') {
          pushLog([{ text: t('ussd.lcd.cancelled'), tone: 'dim' }])
          setChoice(null)
          setScreen('menu')
          pushLog([
            { text: `1. ${t('ussd.lcd.mark')}` },
            { text: `2. ${t('ussd.lcd.exit')}` },
          ])
        }
        break
      }
      default:
        break
    }
  }

  // ---------------- input line (below the LCD) ----------------

  const inputLine = (() => {
    switch (screen) {
      case 'dial':
        return dialBuf || '—'
      case 'dialing':
        return t('ussd.input.calling')
      case 'pin':
        return t('ussd.input.pin', {
          mask: `${'•'.repeat(pinBuf.length)}${'_'.repeat(4 - pinBuf.length)}`,
        })
      case 'menu':
        return t('ussd.input.reply')
      case 'worker':
        return t('ussd.input.reply')
      case 'confirm':
        return t('ussd.input.reply')
      case 'saving':
        return t('ussd.input.sending')
      case 'done':
        return t('ussd.input.ended')
      case 'ended':
        return t('ussd.input.dialAgain')
      default:
        return ''
    }
  })()

  // ---------------- render ----------------

  if (!data) return null

  const pinRows = activeWorkers.slice(0, 8).map((w) => ({
    name: w.name,
    pin: w.pin && /^\d{4}$/.test(w.pin) ? w.pin : phonePin(w.phone),
    // source is a discriminant; the display labels resolve via t() below.
    source: w.pin && /^\d{4}$/.test(w.pin) ? ('kiosk' as const) : ('phone' as const),
  }))

  const callDisabled = busy

  return (
    <div className="space-y-6">
      <section aria-label={t('ussd.aria')}>
        <Card className="border-stone-200 shadow-sm">
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Phone className="w-4 h-4 text-stone-500" aria-hidden />
                {t('ussd.title')}
              </CardTitle>
              <Badge className="bg-amber-100 text-amber-900 border-0 text-[10px] hover:bg-amber-100">
                {t('ussd.demo')}
              </Badge>
              {isClient && (
                <Badge variant="outline" className="text-[10px] font-medium text-stone-500 border-stone-200">
                  {t('ussd.readonly')}
                </Badge>
              )}
            </div>
            <CardDescription>
              {t('ussd.desc')}
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="grid gap-8 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)] items-start justify-items-center lg:justify-items-start">
              {/* ---------- phone frame ---------- */}
              <div className="w-[300px] max-w-full">
                <div className="bg-stone-900 border border-stone-800 rounded-[2.2rem] p-3 shadow-xl">
                  {/* earpiece */}
                  <div className="mx-auto mb-3 w-16 h-1.5 rounded-full bg-stone-800" aria-hidden />

                  {/* screen */}
                  <div className="rounded-xl bg-stone-950 border border-stone-800 p-2 shadow-inner">
                    <div className="flex items-center justify-between px-1 pb-1 font-mono text-[9px] text-stone-600" aria-hidden>
                      <span>MjengoOS · KE</span>
                      <span className={online ? 'text-stone-500' : 'text-amber-500'}>
                        {online ? '▮▮▮▮ E' : '× OFFLINE'}
                      </span>
                    </div>
                    <p className="sr-only">
                      {online ? t('ussd.net.srOnline') : t('ussd.net.srOffline')}
                    </p>

                    {/* LCD log */}
                    <div
                      ref={lcdRef}
                      role="log"
                      aria-live="polite"
                      aria-label={t('ussd.lcd.screenAria')}
                      className="h-60 overflow-y-auto px-1.5 py-2 font-mono text-[11px] leading-relaxed break-words max-h-60 [scrollbar-width:thin]"
                    >
                      {lcdLines.map((line, i) => (
                        <p key={i} className={TONE_CLASS[line.tone ?? 'normal']}>
                          {line.text}
                        </p>
                      ))}
                    </div>

                    {/* input line */}
                    <div className="mt-1 border-t border-stone-800 px-1.5 py-1.5 min-h-7 font-mono text-[11px] text-amber-200 truncate" aria-label={t('ussd.input.aria')}>
                      {inputLine}
                    </div>
                  </div>

                  {/* keypad */}
                  <div className="mt-4 grid grid-cols-3 gap-2">
                    {KEYS.map((k) => (
                      <button
                        key={k.main}
                        type="button"
                        onClick={() => pressKey(k.main)}
                        disabled={busy}
                        aria-label={
                          k.sub
                            ? t('ussd.keypad.keyWithSub', { main: k.main, sub: k.sub })
                            : t('ussd.keypad.key', { main: k.main })
                        }
                        className="h-11 rounded-lg bg-stone-800 hover:bg-stone-700 active:bg-stone-600 disabled:opacity-50 disabled:hover:bg-stone-800 text-stone-100 font-mono text-sm leading-none flex flex-col items-center justify-center gap-0.5 focus-visible:outline-2 focus-visible:outline-amber-400 focus-visible:-outline-offset-2"
                      >
                        <span aria-hidden>{k.main}</span>
                        {k.sub && <span className="text-[8px] text-stone-500 leading-none" aria-hidden>{k.sub}</span>}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={backspace}
                      disabled={busy || (screen !== 'dial' && screen !== 'pin')}
                      aria-label={t('ussd.keypad.delete')}
                      className="h-11 rounded-lg bg-stone-800 hover:bg-stone-700 active:bg-stone-600 disabled:opacity-40 text-stone-400 flex items-center justify-center focus-visible:outline-2 focus-visible:outline-amber-400 focus-visible:-outline-offset-2"
                    >
                      <Delete className="w-4 h-4" aria-hidden />
                    </button>
                    <button
                      type="button"
                      onClick={startDial}
                      disabled={callDisabled}
                      aria-label={
                        screen === 'done' || screen === 'ended'
                          ? t('ussd.keypad.callNew')
                          : t('ussd.keypad.callAria')
                      }
                      className="h-11 rounded-lg bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 disabled:opacity-50 text-white font-semibold text-xs flex items-center justify-center gap-1.5 focus-visible:outline-2 focus-visible:outline-emerald-300 focus-visible:-outline-offset-2"
                    >
                      <PhoneCall className="w-4 h-4" aria-hidden />
                      {t('ussd.keypad.call')}
                    </button>
                    <button
                      type="button"
                      onClick={hangUp}
                      aria-label={t('ussd.keypad.end')}
                      className="h-11 rounded-lg bg-red-600 hover:bg-red-500 active:bg-red-700 text-white flex items-center justify-center focus-visible:outline-2 focus-visible:outline-red-300 focus-visible:-outline-offset-2"
                    >
                      <PhoneOff className="w-4 h-4" aria-hidden />
                    </button>
                  </div>
                </div>

                {/* live network note under the phone */}
                <p className={`mt-3 text-xs text-center flex items-center justify-center gap-1.5 ${online ? 'text-stone-500' : 'text-amber-700'}`}>
                  {online ? (
                    <>
                      <Smartphone className="w-3.5 h-3.5" aria-hidden />
                      {t('ussd.net.onlineNote')}
                    </>
                  ) : (
                    <>
                      <WifiOff className="w-3.5 h-3.5" aria-hidden />
                      {outbox.length > 0
                        ? t('ussd.net.offlinePending', { n: outbox.length })
                        : t('ussd.net.offlineNote')}
                    </>
                  )}
                </p>
              </div>

              {/* ---------- explainer + demo PIN reference ---------- */}
              <div className="w-full space-y-4">
                <div className="rounded-lg border border-stone-200 bg-stone-50 p-4">
                  <h3 className="text-sm font-semibold text-stone-900 mb-2">{t('ussd.explainer.title')}</h3>
                  <ul className="list-disc pl-4 space-y-1.5 text-xs text-stone-600 leading-relaxed">
                    <li>
                      {t('ussd.explainer.anyPhone')}{' '}
                      <code className="font-mono text-[11px] bg-stone-100 px-1 rounded">*384#</code>
                      {t('ussd.explainer.anyPhoneRest')}
                    </li>
                    <li>{t('ussd.explainer.pin')}</li>
                    <li>{t('ussd.explainer.muster')}</li>
                    <li>{t('ussd.explainer.offline')}</li>
                  </ul>
                </div>

                <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
                  <h3 className="text-sm font-semibold text-amber-900 mb-2 flex items-center gap-1.5">
                    <Info className="w-4 h-4" aria-hidden />
                    {t('ussd.pin.title')} — {data.project.name}
                  </h3>
                  {pinRows.length === 0 ? (
                    <p className="text-xs text-amber-800">{t('ussd.pin.empty')}</p>
                  ) : (
                    <>
                      <div className="flex flex-wrap gap-1.5">
                        {pinRows.map((r) => (
                          <Badge
                            key={`${r.pin}-${r.name}`}
                            variant="outline"
                            className={`text-[10px] font-mono ${
                              r.source === 'kiosk'
                                ? 'bg-white text-amber-900 border-amber-300'
                                : 'bg-amber-100/60 text-amber-800 border-amber-200'
                            }`}
                            title={r.source === 'kiosk' ? t('ussd.pin.kiosk') : t('ussd.pin.phone')}
                          >
                            {r.pin} · {r.name}
                          </Badge>
                        ))}
                        {activeWorkers.length > 8 && (
                          <Badge variant="outline" className="text-[10px] bg-amber-100/60 text-amber-800 border-amber-200">
                            {t('ussd.pin.more', { n: activeWorkers.length - 8 })}
                          </Badge>
                        )}
                      </div>
                      <p className="mt-2 text-xs text-amber-800">{t('ussd.pin.note')}</p>
                    </>
                  )}
                </div>

                <p className="text-xs text-stone-400 leading-relaxed">{t('ussd.honesty')}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* W4-3 — the WhatsApp field line: same surface, other honest seam */}
      <WhatsAppPanel />
    </div>
  )
}
