'use client'

import { useRef, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useMjengo } from '@/frontend/hooks/use-mjengo'
import { PhotoAnalysisBody } from '@/frontend/mjengo/overview-tab'
import { DocumentsPanel } from '@/frontend/mjengo/copilot/documents-panel'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/frontend/ui/card'
import { Badge } from '@/frontend/ui/badge'
import { Button } from '@/frontend/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/frontend/ui/select'
import { Textarea } from '@/frontend/ui/textarea'
import { Progress } from '@/frontend/ui/progress'
import { Switch } from '@/frontend/ui/switch'
import { Label } from '@/frontend/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/frontend/ui/table'
import {
  Camera, Mic, Square, ScanSearch, Sparkles, Upload, Play, Loader2, CheckCircle2,
  AlertTriangle, TriangleAlert, Info, Lock, FileAudio, FileText,
} from 'lucide-react'
import { toast } from 'sonner'
import { formatKES } from '@/frontend/lib/format'
import { useT } from '@/frontend/i18n/provider'

interface PhotoAnalysisResult {
  analysis: {
    phaseShown?: string
    progressPct?: number
    confidence?: number
    summary?: string
    observations?: string[]
    safety?: Array<{ issue: string; severity: string }>
    materialsVisible?: Array<{ name: string; roughQty: string }>
    qualityFlags?: string[]
  }
  phaseId: string | null
  phaseName: string | null
  recordedProgress: number | null
  appliedPhotoId: string | null
}

interface ParsedVoice {
  transcript: string
  language: string
  supplier: string | null
  items: Array<{
    spokenName: string
    materialId: string | null
    materialName: string
    unit: string
    quantity: number
    unitCostKES: number
    totalKES: number
    matched: boolean
  }>
  totalKES: number
  notes: string | null
  confidence: number
}

interface ScanResult {
  summary: string
  alerts: Array<{ type: string; severity: string; title: string; message: string }>
}

export function CopilotTab() {
  const { data, dispatch, online, viewMode } = useMjengo()
  const t = useT()
  const [tab, setTab] = useState<'photo' | 'voice' | 'scan' | 'docs'>('photo')

  if (!data) return null

  // Diaspora clients see a locked placeholder — AI tools are site-team only
  if (viewMode === 'client') {
    return (
      <Card className="border-stone-200 shadow-sm">
        <CardContent className="py-16 flex flex-col items-center justify-center text-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-stone-100 flex items-center justify-center" aria-hidden>
            <Lock className="w-7 h-7 text-stone-400" />
          </div>
          <div className="max-w-md">
            <h2 className="text-lg font-semibold text-stone-900">{t('copilot.clientTitle')}</h2>
            <p className="mt-1.5 text-sm text-stone-500 leading-relaxed">
              {t('copilot.clientBody')}
            </p>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-6">
      <Card className="border-amber-200 bg-gradient-to-br from-amber-50 to-stone-50 shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg text-stone-900 flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-amber-600" aria-hidden /> {t('copilot.title')}
          </CardTitle>
          <CardDescription>
            {t('copilot.desc')}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex gap-2 flex-wrap">
          <Button variant={tab === 'photo' ? 'default' : 'outline'} size="sm" className="gap-1.5" onClick={() => setTab('photo')}>
            <Camera className="w-4 h-4" aria-hidden /> {t('copilot.tab.photo')}
          </Button>
          <Button variant={tab === 'voice' ? 'default' : 'outline'} size="sm" className="gap-1.5" onClick={() => setTab('voice')}>
            <Mic className="w-4 h-4" aria-hidden /> {t('copilot.tab.voice')}
          </Button>
          <Button variant={tab === 'scan' ? 'default' : 'outline'} size="sm" className="gap-1.5" onClick={() => setTab('scan')}>
            <ScanSearch className="w-4 h-4" aria-hidden /> {t('copilot.tab.scan')}
          </Button>
          {/* Issue #153: the document-intelligence review surface — the fourth
              AI route family consumer (extract + the human review gate). */}
          <Button variant={tab === 'docs' ? 'default' : 'outline'} size="sm" className="gap-1.5" onClick={() => setTab('docs')}>
            <FileText className="w-4 h-4" aria-hidden /> {t('copilot.tab.docs')}
          </Button>
          {!online && (
            <Badge className="gap-1 bg-amber-100 text-amber-800 border-0 ml-auto"><Lock className="w-3 h-3" aria-hidden /> {t('copilot.offlineBadge')}</Badge>
          )}
        </CardContent>
      </Card>

      {tab === 'photo' && <PhotoPanel online={online} />}
      {tab === 'voice' && <VoicePanel online={online} />}
      {tab === 'scan' && <ScanPanel online={online} />}
      {tab === 'docs' && <DocumentsPanel online={online} />}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[
          { icon: Camera, title: t('copilot.card.groundTruth.title'), text: t('copilot.card.groundTruth.text') },
          { icon: Mic, title: t('copilot.card.swahiliFirst.title'), text: t('copilot.card.swahiliFirst.text') },
          { icon: ScanSearch, title: t('copilot.card.trustEngine.title'), text: t('copilot.card.trustEngine.text') },
        ].map(({ icon: Icon, title, text }) => (
          <Card key={title} className="border-stone-200 shadow-sm bg-white">
            <CardContent className="p-4 flex gap-3">
              <div className="w-9 h-9 rounded-lg bg-amber-100 flex items-center justify-center shrink-0" aria-hidden>
                <Icon className="w-5 h-5 text-amber-700" />
              </div>
              <div>
                <p className="text-sm font-semibold text-stone-800">{title}</p>
                <p className="text-xs text-stone-500 mt-0.5 leading-relaxed">{text}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ Photo

/** Data-Saver downscale (spec §74): canvas resize to max 1024px, JPEG q0.72. */
async function downscaleDataUrl(dataUrl: string, max = 1024, quality = 0.72): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height))
      if (scale >= 1) { resolve(dataUrl); return } // already small enough
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(img.width * scale)
      canvas.height = Math.round(img.height * scale)
      const ctx = canvas.getContext('2d')
      if (!ctx) { reject(new Error('Canvas unavailable')); return }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      resolve(canvas.toDataURL('image/jpeg', quality))
    }
    img.onerror = () => reject(new Error('Could not load image for downscale'))
    img.src = dataUrl
  })
}

function PhotoPanel({ online }: { online: boolean }) {
  const { data, dispatch, load, enqueuePendingNetwork } = useMjengo()
  const dataMode = useMjengo((s) => s.dataMode)
  const { data: session } = useSession()
  const t = useT()
  const [preview, setPreview] = useState<string | null>(null)
  const [previewIsData, setPreviewIsData] = useState(false)
  const [phaseId, setPhaseId] = useState<string>('')
  const [applyToLedger, setApplyToLedger] = useState(true)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<PhotoAnalysisResult | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  if (!data) return null

  // Feature flag (spec §81): ai_progress gates this whole panel's analysis.
  // Task 9-a: admins now bypass the flag (same rule the route enforces via
  // requireFlagOn) so they can toggle & test — non-admins get the disabled
  // button + honest note below.
  const isAdmin = session?.user?.role === 'admin'
  const aiProgressOn = isAdmin || data.intel.flags?.ai_progress !== false
  const saver = dataMode === 'data_saver'

  function pickSeeded(url: string, caption: string | null) {
    setPreview(url)
    setPreviewIsData(false)
    setResult(null)
    const match = data?.photos.find((p) => p.url === url)
    setPhaseId(match?.phaseId ?? '')
    if (caption) toast.info(t('copilot.toast.picked', { caption }))
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    const reader = new FileReader()
    reader.onload = () => { setPreview(String(reader.result)); setPreviewIsData(true); setResult(null); setPhaseId('') }
    reader.readAsDataURL(f)
  }

  async function analyze() {
    if (!preview) { toast.error(t('copilot.toast.needPhoto')); return }
    if (!online) {
      toast.error(t('copilot.toast.needOnline'))
      // #150: the photo itself is ephemeral (a dataURL/URL, never queued) —
      // the worklist keeps a reminder, not the input.
      enqueuePendingNetwork({ kind: 'copilot.analyze', labelKey: 'netlist.kind.analyze', tab: 'copilot' })
      return
    }
    if (!aiProgressOn) { toast.error(t('copilot.toast.flagOff')); return }
    setBusy(true); setResult(null)
    try {
      let url: string | undefined
      let dataUrl: string | undefined
      let photoId: string | undefined
      if (previewIsData) {
        // Data Saver (spec §74): compress on-device BEFORE anything is sent.
        let toSend = preview
        if (saver) {
          try {
            toSend = await downscaleDataUrl(preview)
            toast.info(t('copilot.toast.saverCompressed'))
          } catch {
            toast.info(t('copilot.toast.saverFailed'))
          }
        }
        // Upload first (POST /api/upload) so the photo persists at a real URL —
        // the analysis AND the photo.apply action both need that url; a raw
        // dataUrl used to leave "Apply to ledger" silently dead.
        const up = await fetch('/api/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dataUrl: toSend }),
        })
        const upJson = await up.json().catch(() => null)
        if (!up.ok || !upJson?.url) {
          toast.error(upJson?.error ?? t('copilot.toast.uploadFailed'))
          return
        }
        url = upJson.url as string
        setPreview(url)
        setPreviewIsData(false)
      } else {
        url = preview
        const match = data?.photos.find((p) => p.url === url)
        photoId = match?.id
      }
      const res = await fetch('/api/ai/analyze-photo', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataUrl, url, photoId, phaseId: phaseId || undefined, apply: applyToLedger, projectId: data?.project.id }),
      })
      const json = await res.json()
      if (json.ok) {
        setResult(json as PhotoAnalysisResult)
        if (json.appliedPhotoId) {
          toast.success(t('copilot.toast.appliedOk', { phase: json.phaseName, pct: json.analysis.progressPct }))
          await load()
        } else {
          toast.success(t('copilot.toast.analysisOk'))
        }
      } else {
        toast.error(json.error ?? t('copilot.toast.analysisFailed'))
      }
    } catch {
      toast.error(t('copilot.toast.network'))
    } finally {
      setBusy(false)
    }
  }

  async function applyNow() {
    if (!result) return
    const ok = await dispatch('photo.apply', {
      photoId: result.appliedPhotoId ?? undefined,
      url: !result.appliedPhotoId && !previewIsData ? preview : undefined,
      caption: result.analysis.summary ?? 'AI-analyzed site photo',
      phaseId: result.phaseId ?? undefined,
      progressPct: typeof result.analysis.progressPct === 'number' ? result.analysis.progressPct : undefined,
      analysis: result.analysis,
    }, 'Apply AI photo analysis')
    if (ok) {
      toast.success(t('copilot.toast.applyOk'))
      setResult(null)
    } else {
      // Dispatch failures are surfaced, never silent (spec §84 no dead UI).
      toast.error(t('copilot.toast.applyFailed'))
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <Card className="border-stone-200 shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg text-stone-900">{t('copilot.photo.captureTitle')}</CardTitle>
          <CardDescription>{t('copilot.photo.captureDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div
            className="border-2 border-dashed border-stone-300 rounded-xl p-4 flex flex-col items-center gap-3 bg-stone-50/50"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) { const dt = new DataTransfer(); dt.items.add(f); if (fileRef.current) { fileRef.current.files = dt.files; onFile({ target: { files: dt.files } } as never) } } }}
          >
            {preview ? (
              <img src={preview} alt={t('copilot.photo.previewAlt')} className="max-h-64 rounded-lg border border-stone-200 object-cover" />
            ) : (
              <div className="py-8 flex flex-col items-center gap-2 text-stone-400">
                <Camera className="w-10 h-10" aria-hidden />
                <p className="text-sm">{t('copilot.photo.dropHere')}</p>
              </div>
            )}
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" capture="environment" className="sr-only" onChange={onFile} aria-label={t('copilot.photo.uploadAria')} />
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => fileRef.current?.click()}>
              <Upload className="w-4 h-4" aria-hidden /> {preview ? t('copilot.photo.changePhoto') : t('copilot.photo.uploadPhoto')}
            </Button>
            {saver && <p className="text-[11px] text-stone-400">{t('copilot.photo.saverNote')}</p>}
          </div>

          <div>
            <p className="text-xs font-medium text-stone-500 mb-2">{t('copilot.photo.pickLabel')}</p>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {data.photos.slice(0, 5).map((p) => (
                <button key={p.id} onClick={() => pickSeeded(p.url, p.caption)} className={`shrink-0 w-20 aspect-[4/3] rounded-lg overflow-hidden border-2 ${preview === p.url ? 'border-amber-500' : 'border-stone-200'} focus:outline-none focus:ring-2 focus:ring-amber-500`} aria-label={t('copilot.photo.pickAria', { caption: p.caption ?? t('overview.photos.sitePhoto') })}>
                  <img src={p.url} alt="" className="w-full h-full object-cover" />
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between gap-4 rounded-lg border border-stone-200 p-3">
            <div className="min-w-0">
              <Label htmlFor="phase-pick" className="text-sm font-medium text-stone-700">{t('copilot.photo.phaseContext')}</Label>
              <p className="text-xs text-stone-400">{t('copilot.photo.phaseHint')}</p>
            </div>
            <Select value={phaseId} onValueChange={setPhaseId}>
              <SelectTrigger id="phase-pick" size="sm" className="w-44 bg-white shrink-0"><SelectValue placeholder={t('copilot.photo.autoDetect')} /></SelectTrigger>
              <SelectContent>
                {data.phases.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-stone-200 p-3">
            <div>
              <Label htmlFor="apply-ledger" className="text-sm font-medium text-stone-700">{t('copilot.photo.applyLabel')}</Label>
              <p className="text-xs text-stone-400">{t('copilot.photo.applyHint')}</p>
            </div>
            <Switch id="apply-ledger" checked={applyToLedger} onCheckedChange={setApplyToLedger} className="data-[state=checked]:bg-amber-600" />
          </div>

          <Button
            className="w-full gap-2 bg-amber-600 hover:bg-amber-700 text-white"
            size="lg"
            onClick={() => void analyze()}
            disabled={busy || !preview || !aiProgressOn}
            title={!aiProgressOn ? t('copilot.flagOff') : undefined}
          >
            {busy ? <Loader2 className="w-5 h-5 animate-spin" aria-hidden /> : <ScanSearch className="w-5 h-5" aria-hidden />}
            {busy ? t('copilot.photo.analyzing') : t('copilot.photo.analyze')}
          </Button>
          {!aiProgressOn && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2" role="status">
              {t('copilot.photo.flagOffNote')}
            </p>
          )}
          {busy && <Progress value={70} className="h-1.5 bg-stone-200 [&>[data-slot=progress-indicator]]:bg-amber-500" />}
        </CardContent>
      </Card>

      <Card className="border-stone-200 shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg text-stone-900">{t('copilot.photo.readsTitle')}</CardTitle>
          <CardDescription>{t('copilot.photo.readsDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          {result ? (
            <div className="space-y-4">
              <PhotoAnalysisBody analysis={result.analysis} />
              {result.recordedProgress !== null && (
                <div className="flex items-center justify-between rounded-lg bg-stone-50 border border-stone-200 px-3 py-2 text-sm">
                  <span className="text-stone-600">{t('copilot.photo.recordedProgress')} <strong>{result.recordedProgress}%</strong></span>
                  {!result.appliedPhotoId ? (
                    <Button size="sm" className="gap-1 bg-amber-600 hover:bg-amber-700 text-white" onClick={() => void applyNow()}>
                      <CheckCircle2 className="w-4 h-4" aria-hidden /> {t('copilot.photo.applyButton')}
                    </Button>
                  ) : (
                    <Badge className="bg-emerald-100 text-emerald-800 border-0 gap-1"><CheckCircle2 className="w-3.5 h-3.5" aria-hidden /> {t('copilot.photo.appliedBadge')}</Badge>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="text-sm text-stone-400 border border-dashed border-stone-200 rounded-lg p-8 text-center">
              {t('copilot.photo.emptyReport')}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// ------------------------------------------------------------------ Voice

function VoicePanel({ online }: { online: boolean }) {
  const { data, dispatch, load, enqueuePendingNetwork } = useMjengo()
  const { data: session } = useSession()
  const t = useT()
  const [recording, setRecording] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [busy, setBusy] = useState(false)
  const [parsed, setParsed] = useState<ParsedVoice | null>(null)
  const [textMode, setTextMode] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const mediaRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const audioFileRef = useRef<HTMLInputElement>(null)

  if (!data) return null

  // Feature flag (spec §81, task 9-a): ai_voice gates the VOICE entry points
  // (record / samples / audio upload — the /api/ai/voice-log route answers
  // the uniform 403 for non-admins). Admins bypass (requireFlagOn rule) so
  // they can toggle & test. Typed parsing ("Parse text" → /api/ai/parse-text)
  // is a different route and deliberately NOT gated by this flag.
  const isAdmin = session?.user?.role === 'admin'
  const aiVoiceOn = isAdmin || data.intel.flags?.ai_voice !== false
  const langLabel = (lang: string) =>
    lang === 'sw' ? t('copilot.voice.langSw') : lang === 'mix' ? t('copilot.voice.langMixed') : t('copilot.voice.langEn')

  function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia) { toast.error(t('copilot.voice.toast.noMic')); return }
    navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
      const mr = new MediaRecorder(stream)
      mediaRef.current = mr
      chunksRef.current = []
      mr.ondataavailable = (e) => chunksRef.current.push(e.data)
      mr.onstop = () => { stream.getTracks().forEach((t) => t.stop()); void processBlob(chunksRef.current[0] ?? new Blob()) }
      mr.start()
      setRecording(true); setElapsed(0); setParsed(null); setConfirmed(false)
      timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000)
    }).catch(() => toast.error(t('copilot.voice.toast.micDenied')))
  }

  function stopRecording() {
    mediaRef.current?.stop()
    setRecording(false)
    if (timerRef.current) clearInterval(timerRef.current)
  }

  async function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve) => {
      const reader = new FileReader()
      reader.onloadend = () => resolve(String(reader.result).split(',')[1])
      reader.readAsDataURL(blob)
    })
  }

  async function processBlob(blob: Blob) {
    if (blob.size < 1000) { toast.error(t('copilot.voice.toast.tooShort')); return }
    await runVoice(await blobToBase64(blob))
  }

  async function runVoice(base64: string) {
    if (!online) {
      toast.error(t('copilot.voice.toast.needOnline'))
      // #150: the recording is ephemeral — remind, never queue the input.
      enqueuePendingNetwork({ kind: 'copilot.voice', labelKey: 'netlist.kind.voice', tab: 'copilot' })
      return
    }
    if (!aiVoiceOn) { toast.error(t('copilot.voice.toast.flagOff')); return }
    setBusy(true); setParsed(null); setConfirmed(false)
    try {
      const res = await fetch('/api/ai/voice-log', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioBase64: base64, projectId: data?.project.id }),
      })
      const json = await res.json()
      if (json.ok) { setParsed(json as ParsedVoice); toast.success(t('copilot.voice.toast.transcribed', { lang: langLabel(json.language) })) }
      else toast.error(json.error ?? t('copilot.voice.toast.voiceFailed'))
    } catch { toast.error(t('copilot.voice.toast.network')) } finally { setBusy(false) }
  }

  async function playSample(file: string) {
    if (!online) {
      toast.error(t('copilot.voice.toast.needOnlineShort'))
      // #150: same voice-AI intent as runVoice — one reminder, not two.
      enqueuePendingNetwork({ kind: 'copilot.voice', labelKey: 'netlist.kind.voice', tab: 'copilot' })
      return
    }
    setBusy(true); setParsed(null); setConfirmed(false)
    try {
      const blob = await fetch(file).then((r) => r.blob())
      await runVoice(await blobToBase64(blob))
    } catch { toast.error(t('copilot.voice.toast.sampleFailed')); setBusy(false) }
  }

  async function parseText() {
    if (!textMode.trim()) { toast.error(t('copilot.voice.toast.typeFirst')); return }
    if (!online) {
      toast.error(t('copilot.voice.toast.parseOnline'))
      // #150: the typed text is an ephemeral input — remind, never queue.
      enqueuePendingNetwork({ kind: 'copilot.voiceParse', labelKey: 'netlist.kind.voiceParse', tab: 'copilot' })
      return
    }
    setBusy(true); setParsed(null); setConfirmed(false)
    try {
      const res = await fetch('/api/ai/parse-text', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: textMode.trim(), projectId: data?.project.id }) })
      const json = await res.json()
      if (json.ok) { setParsed(json as ParsedVoice); toast.success(t('copilot.voice.toast.parsed')) }
      else toast.error(json.error ?? t('copilot.voice.toast.parseFailed'))
    } catch { toast.error(t('copilot.voice.toast.network')) } finally { setBusy(false) }
  }

  async function confirmLog() {
    if (!parsed || !parsed.items.length) return
    let ok = true
    for (const item of parsed.items) {
      if (!item.materialId) continue
      ok = ok && await dispatch('delivery.create', {
        materialId: item.materialId,
        quantity: item.quantity,
        unitCost: item.unitCostKES,
        supplier: parsed.supplier ?? 'Unknown supplier',
        source: 'voice',
        rawTranscript: parsed.transcript,
      }, `Voice-logged ${item.quantity} ${item.unit} ${item.materialName}`)
    }
    if (ok) {
      toast.success(t('copilot.voice.toast.logged', { count: parsed.items.length }))
      setConfirmed(true)
      await load()
    } else toast.error(t('copilot.voice.toast.someFailed'))
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <Card className="border-stone-200 shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg text-stone-900">{t('copilot.voice.sendTitle')}</CardTitle>
          <CardDescription>{t('copilot.voice.sendDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex flex-col items-center gap-3 rounded-xl border border-stone-200 bg-stone-50/60 p-6">
            <button
              onClick={recording ? stopRecording : startRecording}
              disabled={busy || !aiVoiceOn}
              title={!aiVoiceOn ? t('copilot.voice.flagOff') : undefined}
              className={`w-20 h-20 rounded-full flex items-center justify-center transition-all focus:outline-none focus:ring-4 focus:ring-amber-300 ${recording ? 'bg-red-600 animate-pulse' : 'bg-amber-600 hover:bg-amber-700'}`}
              aria-label={recording ? t('copilot.voice.stopAria') : t('copilot.voice.startAria')}
            >
              {recording ? <Square className="w-8 h-8 text-white" aria-hidden /> : <Mic className="w-8 h-8 text-white" aria-hidden />}
            </button>
            <p className="text-sm text-stone-600 font-medium tabular-nums">
              {recording
                ? t('copilot.voice.recording', { time: `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}` })
                : busy ? t('copilot.voice.transcribing') : t('copilot.voice.tapRecord')}
            </p>
            {!aiVoiceOn && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2" role="status">
                {t('copilot.voice.flagOffNote')}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium text-stone-500">{t('copilot.voice.samplesLabel')}</p>
            <div className="flex gap-2 flex-wrap">
              <Button variant="outline" size="sm" className="gap-1.5" disabled={busy || !aiVoiceOn} title={!aiVoiceOn ? t('copilot.voice.flagOff') : undefined} onClick={() => void playSample('/audio/voice-cement-delivery.wav')}>
                <Play className="w-3.5 h-3.5" aria-hidden /> “20 bags cement + 5 wire — Karioke”
              </Button>
              <Button variant="outline" size="sm" className="gap-1.5" disabled={busy || !aiVoiceOn} title={!aiVoiceOn ? t('copilot.voice.flagOff') : undefined} onClick={() => void playSample('/audio/voice-sand-ballast.wav')}>
                <Play className="w-3.5 h-3.5" aria-hidden /> “12t sand + 5t ballast — Mwangaza”
              </Button>
            </div>
            <input ref={audioFileRef} type="file" accept="audio/*" className="sr-only" aria-label={t('copilot.voice.uploadAudioAria')}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void processBlob(f) }} />
            <Button variant="ghost" size="sm" className="gap-1.5 self-start text-stone-500" disabled={busy || !aiVoiceOn} title={!aiVoiceOn ? t('copilot.voice.flagOff') : undefined} onClick={() => audioFileRef.current?.click()}>
              <FileAudio className="w-4 h-4" aria-hidden /> {t('copilot.voice.uploadAudio')}
            </Button>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-medium text-stone-500">{t('copilot.voice.typeLabel')}</p>
            <Textarea value={textMode} onChange={(e) => setTextMode(e.target.value)} rows={3}
              placeholder={t('copilot.voice.typePh')} />
            <Button variant="outline" size="sm" className="gap-1.5" disabled={busy || !textMode.trim()} onClick={() => void parseText()}>
              <Sparkles className="w-4 h-4" aria-hidden /> {t('copilot.voice.parseText')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="border-stone-200 shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg text-stone-900">{t('copilot.voice.previewTitle')}</CardTitle>
          <CardDescription>{t('copilot.voice.previewDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          {!parsed ? (
            <div className="text-sm text-stone-400 border border-dashed border-stone-200 rounded-lg p-8 text-center">
              {t('copilot.voice.emptyPreview')}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="rounded-lg bg-stone-900 text-stone-100 p-3 text-sm font-mono">
                <p className="text-[10px] text-stone-400 uppercase tracking-wide mb-1">{t('copilot.voice.transcriptLabel', { lang: langLabel(parsed.language), conf: Math.round(parsed.confidence * 100) })}</p>
                “{parsed.transcript}”
              </div>
              {parsed.items.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>{t('copilot.voice.table.item')}</TableHead>
                      <TableHead className="text-right">{t('copilot.voice.table.qty')}</TableHead>
                      <TableHead className="text-right">{t('copilot.voice.table.cost')}</TableHead>
                      <TableHead>{t('copilot.voice.table.match')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {parsed.items.map((item, i) => (
                      <TableRow key={i}>
                        <TableCell className="font-medium text-stone-800 text-sm">{item.materialName}</TableCell>
                        <TableCell className="text-right tabular-nums">{item.quantity} {item.unit}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatKES(item.totalKES)}</TableCell>
                        <TableCell>
                          {item.matched ? <Badge className="bg-emerald-100 text-emerald-800 border-0 text-[10px] hover:bg-emerald-100">{t('copilot.voice.matchCatalog')}</Badge> : <Badge className="bg-amber-100 text-amber-800 border-0 text-[10px] hover:bg-amber-100">{t('copilot.voice.matchManual')}</Badge>}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3">
                  {t('copilot.voice.noDeliveries')} {parsed.notes && <span className="italic">“{parsed.notes}”</span>}
                </p>
              )}
              <div className="flex items-center justify-between">
                <div className="text-sm">
                  {parsed.supplier && <p className="text-stone-500">{t('copilot.voice.supplierLabel')} <strong className="text-stone-800">{parsed.supplier}</strong></p>}
                  {parsed.items.length > 0 && <p className="text-stone-500">{t('copilot.voice.totalLabel')} <strong className="text-stone-900">{formatKES(parsed.totalKES)}</strong></p>}
                </div>
                {confirmed ? (
                  <Badge className="bg-emerald-100 text-emerald-800 border-0 gap-1"><CheckCircle2 className="w-3.5 h-3.5" aria-hidden /> {t('copilot.voice.loggedBadge')}</Badge>
                ) : (
                  <Button className="gap-1.5 bg-amber-600 hover:bg-amber-700 text-white" disabled={!parsed.items.length} onClick={() => void confirmLog()}>
                    <CheckCircle2 className="w-4 h-4" aria-hidden /> {t('copilot.voice.confirmLog')}
                  </Button>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// ------------------------------------------------------------------ Scan

function ScanPanel({ online }: { online: boolean }) {
  const { data, load, enqueuePendingNetwork } = useMjengo()
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ScanResult | null>(null)

  if (!data) return null

  async function runScan() {
    if (!online) {
      toast.error(t('copilot.scan.toast.needOnline'))
      // #150: reminder for the anomaly scan (server-side AI — ephemeral intent).
      enqueuePendingNetwork({ kind: 'copilot.scan', labelKey: 'netlist.kind.scan', tab: 'copilot' })
      return
    }
    setBusy(true); setResult(null)
    try {
      const res = await fetch('/api/ai/anomaly-scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: data?.project.id }),
      })
      const json = await res.json()
      if (json.ok) {
        setResult({ summary: json.summary, alerts: json.alerts ?? [] })
        toast.success(t('copilot.scan.toast.ok', { count: json.alerts?.length ?? 0 }))
        await load()
      } else toast.error(json.error ?? t('copilot.scan.toast.failed'))
    } catch { toast.error(t('copilot.scan.toast.network')) } finally { setBusy(false) }
  }

  const openIssues = data.alerts.filter((a) => !a.acknowledged)

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <Card className="border-stone-200 shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg text-stone-900">{t('copilot.scan.title')}</CardTitle>
          <CardDescription>
            {t('copilot.scan.desc', {
              deliveries: data.deliveries.length,
              consumptions: data.consumptions.length,
              progress: data.summary.progressPct,
            })}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-lg bg-stone-50 border border-stone-200 p-3">
              <p className="text-lg font-bold text-stone-900 tabular-nums">{data.materials.reduce((s, m) => s + m.deliveredQty, 0).toLocaleString()}</p>
              <p className="text-[10px] text-stone-500 uppercase tracking-wide">{t('copilot.scan.unitsDelivered')}</p>
            </div>
            <div className="rounded-lg bg-stone-50 border border-stone-200 p-3">
              <p className="text-lg font-bold text-stone-900 tabular-nums">{data.materials.reduce((s, m) => s + m.consumedQty, 0).toLocaleString()}</p>
              <p className="text-[10px] text-stone-500 uppercase tracking-wide">{t('copilot.scan.unitsConsumed')}</p>
            </div>
            <div className="rounded-lg bg-stone-50 border border-stone-200 p-3">
              <p className="text-lg font-bold text-stone-900 tabular-nums">{formatKES(data.materials.reduce((s, m) => s + m.stockValue, 0), true)}</p>
              <p className="text-[10px] text-stone-500 uppercase tracking-wide">{t('copilot.scan.stockAtRisk')}</p>
            </div>
          </div>
          <Button className="w-full gap-2 bg-amber-600 hover:bg-amber-700 text-white" size="lg" onClick={() => void runScan()} disabled={busy}>
            {busy ? <Loader2 className="w-5 h-5 animate-spin" aria-hidden /> : <ScanSearch className="w-5 h-5" aria-hidden />}
            {busy ? t('copilot.scan.running') : t('copilot.scan.run')}
          </Button>
          <p className="text-xs text-stone-400 leading-relaxed">
            {t('copilot.scan.note')}
          </p>
        </CardContent>
      </Card>

      <Card className="border-stone-200 shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg text-stone-900">{t('copilot.scan.findingsTitle')}</CardTitle>
          <CardDescription>{t('copilot.scan.findingsDesc', { count: openIssues.length })}</CardDescription>
        </CardHeader>
        <CardContent>
          {result && (
            <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <p className="font-semibold flex items-center gap-1.5 mb-1"><Sparkles className="w-4 h-4" aria-hidden /> {t('copilot.scan.verdict')}</p>
              {result.summary}
            </div>
          )}
          <div className="space-y-3 max-h-96 overflow-y-auto pr-1">
            {openIssues.length === 0 && !result && (
              <p className="text-sm text-stone-400 border border-dashed border-stone-200 rounded-lg p-6 text-center">
                {t('copilot.scan.empty')}
              </p>
            )}
            {openIssues.map((a) => (
              <div key={a.id} className={`rounded-lg border p-3 ${a.severity === 'critical' ? 'border-red-200 bg-red-50/60' : a.severity === 'warning' ? 'border-amber-200 bg-amber-50/60' : 'border-stone-200'}`}>
                <div className="flex items-start gap-2">
                  {a.severity === 'critical' ? <TriangleAlert className="w-4 h-4 text-red-600 mt-0.5 shrink-0" aria-hidden />
                    : a.severity === 'warning' ? <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" aria-hidden />
                    : <Info className="w-4 h-4 text-stone-400 mt-0.5 shrink-0" aria-hidden />}
                  <div>
                    <p className="text-sm font-semibold text-stone-800">{a.title}</p>
                    <p className="text-xs text-stone-600 mt-1 leading-relaxed">{a.message}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
