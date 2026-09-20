'use client'

// W6-2 — Trust digest section (the diaspora "what your money did" surface).
//
// One card in the Intel tab: the weekly bilingual digest — deterministic
// text composed from ledger rows (releases + ledger refs, evidence photos,
// MjengoScore delta, advisory AI flag counts, budget pace), an EN/SW
// language toggle, and the TTS voice note when one exists (honest
// "Audio not available" when it does not). Reading rides the SAME share
// token as the client link (GET /api/share?token&trustDigest=latest), so
// the owner surface and the client view show identical, revocable data;
// generating is the ai.trustDigest ACTION (contractor/admin only, flag
// OFF → button hidden, the honest off note stays).

import { useCallback, useEffect, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { useMjengo } from '@/frontend/hooks/use-mjengo'
import { useT } from '@/frontend/i18n/provider'
import { toast } from 'sonner'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/frontend/ui/card'
import { Button } from '@/frontend/ui/button'
import { Badge } from '@/frontend/ui/badge'
import { Volume2, RefreshCw, Languages, Download, ShieldCheck } from 'lucide-react'

/** The share-GET digest view (modules/ai/trust-digest.ts TrustDigestShareView). */
interface DigestView {
  id: string
  lang: 'en' | 'sw'
  windowStart: string
  windowEnd: string
  text: string
  textHash: string
  ruleVersion: number
  createdAt: string
  audioStatus: 'unavailable' | 'failed' | 'ready'
  audio: { dataUrl: string; mimeType: string } | null
  audioOnDemand: boolean
  audioNote: string | null
}

export function TrustDigestSection() {
  const { data, viewMode, shareToken, online, enqueuePendingNetwork } = useMjengo()
  const t = useT()
  const [lang, setLang] = useState<'en' | 'sw'>('en')
  const [digest, setDigest] = useState<DigestView | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [rendering, setRendering] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isClient = viewMode === 'client'
  // The AI generate surface is flag-gated (payload intel slice; stale
  // persisted payloads may lack it — fail closed to hidden), the same rule
  // as the W6-1 review button. READING stays open regardless of the flag.
  const aiFlagOn = data?.intel?.flags?.ai === true
  // The token that serves the digest: the share-link session's own token,
  // or the project's token on owner surfaces (the money-tab pack pattern).
  const token = shareToken ?? data?.project.shareToken ?? null

  const load = useCallback(
    async (targetLang: 'en' | 'sw', withAudio = false) => {
      if (!token) return
      setLoading(true)
      setError(null)
      try {
        const url =
          `/api/share?token=${encodeURIComponent(token)}&trustDigest=latest&lang=${targetLang}` +
          (withAudio ? '&audio=1' : '')
        const res = await fetch(url)
        const json = (await res.json().catch(() => null)) as { ok?: boolean; digest?: DigestView | null; error?: string } | null
        if (!res.ok || !json?.ok) {
          setError(typeof json?.error === 'string' && json.error ? json.error : t('trustDigest.error'))
          setDigest(null)
          return
        }
        setDigest(json.digest ?? null)
      } catch {
        setError(t('trustDigest.error'))
      } finally {
        setLoading(false)
      }
    },
    [token, t],
  )

  useEffect(() => {
    if (token) void load(lang)
    else setDigest(null)
    // Reload when the language toggle flips (the latest digest per language).
  }, [lang, token, load])

  /** Generate this week's digest for the selected language (the action path). */
  async function generate() {
    if (!data?.project?.id || !online) {
      toast.error(t('trustDigest.needsOnline'))
      // #150: digest generation composes server-side — the offline refusal
      // keeps a reminder (the selected language is re-chosen at retry, not
      // stored; the no-project arm stays toast-only, exactly as before).
      if (data?.project?.id) {
        enqueuePendingNetwork({ kind: 'ai.trustDigest', labelKey: 'netlist.kind.trustDigest', tab: 'intel' })
      }
      return
    }
    setBusy(true)
    try {
      const res = await fetch('/api/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'ai.trustDigest',
          payload: { lang },
          projectId: data.project.id,
        }),
      })
      const json = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string; audioStatus?: 'ready' | 'failed' | 'unavailable' }
        | null
      if (!res.ok || !json?.ok) {
        const errText =
          typeof json?.error === 'string' && json.error.trim() ? json.error.trim() : t('trustDigest.runFailedFallback')
        toast.error(`${t('trustDigest.runFailed')} — ${errText}`)
        return
      }
      toast.success(
        t('trustDigest.runOk', {
          lang: t(`trustDigest.lang.${lang}`),
          audio: t(`trustDigest.audioStatus.${json.audioStatus ?? 'unavailable'}`),
        }),
      )
      // Reload through the share read (serves the stored voice note, if any).
      await load(lang)
    } catch {
      toast.error(t('trustDigest.runNetwork'))
    } finally {
      setBusy(false)
    }
  }

  /** On-demand voice-note render (the &audio=1 leg — opt-in per request). */
  async function renderAudio() {
    if (!online) {
      toast.error(t('trustDigest.needsOnline'))
      // #150: the voice note renders server-side — a reminder, not a queue.
      enqueuePendingNetwork({ kind: 'ai.trustAudio', labelKey: 'netlist.kind.trustAudio', tab: 'intel' })
      return
    }
    setRendering(true)
    try {
      await load(lang, true)
    } finally {
      setRendering(false)
    }
  }

  if (!data || !token) return null

  const langLabel = (l: 'en' | 'sw') => t(`trustDigest.lang.${l}`)
  const weekLabel = digest ? `${digest.windowStart.slice(0, 10)} → ${digest.windowEnd.slice(0, 10)}` : ''

  return (
    <section aria-label="Trust digest">
      <Card className="border-stone-200 shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2 text-base">
                <Volume2 className="w-4 h-4 text-emerald-600" aria-hidden /> {t('trustDigest.title')}
              </CardTitle>
              <CardDescription>{t('trustDigest.desc')}</CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex rounded-md border border-stone-200 overflow-hidden" role="group" aria-label={t('trustDigest.langAria')}>
                {(['en', 'sw'] as const).map((l) => (
                  <button
                    key={l}
                    type="button"
                    onClick={() => setLang(l)}
                    className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                      lang === l ? 'bg-stone-900 text-stone-50' : 'bg-white text-stone-500 hover:bg-stone-50'
                    }`}
                    aria-pressed={lang === l}
                  >
                    {langLabel(l)}
                  </button>
                ))}
              </div>
              {!isClient && aiFlagOn && (
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  disabled={busy || loading || rendering}
                  onClick={() => void generate()}
                  data-testid="generate-trust-digest"
                >
                  <RefreshCw className={`w-4 h-4 ${busy ? 'animate-spin' : ''}`} aria-hidden />
                  {busy
                    ? t('trustDigest.generating')
                    : digest
                      ? t('trustDigest.regenerate')
                      : t('trustDigest.generate')}
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0 space-y-4">
          {!aiFlagOn && !isClient && (
            <p className="text-xs text-stone-400 flex items-center gap-1.5" role="note">
              <ShieldCheck className="w-3.5 h-3.5 shrink-0" aria-hidden /> {t('trustDigest.off')}
            </p>
          )}

          {loading && <p className="text-sm text-stone-400">{t('trustDigest.loading')}</p>}

          {error && !loading && (
            <div className="flex items-center gap-3" role="alert">
              <p className="text-sm text-red-600">{error}</p>
              <Button size="sm" variant="outline" onClick={() => void load(lang)}>
                {t('trustDigest.retry')}
              </Button>
            </div>
          )}

          {!loading && !error && !digest && (
            <div className="py-6 flex flex-col items-center text-center gap-2" role="status">
              <div className="w-12 h-12 rounded-full bg-stone-100 flex items-center justify-center" aria-hidden>
                <Languages className="w-6 h-6 text-stone-400" />
              </div>
              <p className="text-sm text-stone-500 max-w-sm">
                {t('trustDigest.empty', { lang: langLabel(lang) })}
              </p>
            </div>
          )}

          {!loading && !error && digest && (
            <div className="rounded-lg border border-stone-200 bg-stone-50/60 p-4 space-y-3" aria-label={`Trust digest ${langLabel(digest.lang)}`}>
              <div className="flex flex-wrap items-center gap-2">
                <Badge className="bg-stone-900 text-stone-50 text-[10px] gap-1">
                  {t('trustDigest.week', { start: digest.windowStart.slice(0, 10), end: digest.windowEnd.slice(0, 10) })}
                </Badge>
                <span className="text-[11px] text-stone-400">
                  {t('trustDigest.generated', { when: formatDistanceToNow(new Date(digest.createdAt), { addSuffix: true }) })}
                </span>
                <span className="text-[11px] text-stone-400 font-mono" title={digest.textHash}>
                  {t('trustDigest.hash', { hash: digest.textHash.slice(0, 12) })}
                </span>
              </div>

              <p className="text-sm text-stone-700 leading-relaxed whitespace-pre-wrap font-sans">
                {digest.text}
              </p>

              {digest.audio ? (
                <div className="space-y-2 pt-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-xs font-semibold text-stone-500 uppercase tracking-wide">{t('trustDigest.audioTitle')}</p>
                    {digest.audioOnDemand && (
                      <Badge variant="outline" className="text-[10px] text-stone-500 border-stone-300">
                        {t('trustDigest.audio.onDemand')}
                      </Badge>
                    )}
                    <a
                      href={digest.audio.dataUrl}
                      download={`mjengo-trust-digest-${digest.lang}.${digest.audio.mimeType === 'audio/mpeg' ? 'mp3' : 'wav'}`}
                      className="inline-flex items-center gap-1 text-xs text-emerald-700 hover:underline"
                    >
                      <Download className="w-3.5 h-3.5" aria-hidden /> {t('trustDigest.audio.download')}
                    </a>
                  </div>
                  {/* A voice note has no captions to offer; the full digest text sits right above it. */}
                  <audio controls src={digest.audio.dataUrl} className="w-full h-10" data-testid="trust-digest-audio">
                    {t('trustDigest.audio.unsupported')}
                  </audio>
                </div>
              ) : (
                <div className="space-y-1.5 pt-1">
                  <p className="text-xs text-stone-400">{t('trustDigest.audio.unavailable')}</p>
                  {digest.audioNote && <p className="text-[11px] text-stone-400">{digest.audioNote}</p>}
                  {aiFlagOn && online && !isClient && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="gap-1.5 text-stone-500"
                      disabled={rendering}
                      onClick={() => void renderAudio()}
                    >
                      <Volume2 className={`w-4 h-4 ${rendering ? 'animate-pulse' : ''}`} aria-hidden />
                      {rendering ? t('trustDigest.audio.rendering') : t('trustDigest.audio.render')}
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}

          <p className="text-[11px] text-stone-400 leading-relaxed border-t border-stone-100 pt-2.5" role="note">
            {t('trustDigest.honesty')}
          </p>
        </CardContent>
      </Card>
    </section>
  )
}
