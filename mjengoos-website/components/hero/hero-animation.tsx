"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { motion, useReducedMotion, type Transition } from "framer-motion";
import {
  Boxes,
  Camera,
  CreditCard,
  ShoppingCart,
  Truck as TruckIcon,
  Users,
} from "lucide-react";
import { Button } from "@/components/button";
import { LogoMark } from "@/components/logo";
import { track } from "@/lib/analytics";
import {
  BlueprintRoll,
  BlueprintSheet,
  BrickStack,
  CementBag,
  DocCard,
  GroundShadow,
  HardHat,
  PayCard,
  Rebar,
  Spade,
  Toolbox,
  Truck,
  Wheelbarrow,
} from "@/components/hero/materials";
import {
  Crane,
  MiniBuilding,
  PhoneDashboard,
  ProgressRing,
  type BuildStage,
} from "@/components/hero/site";

/**
 * Animated hero — 6-scene construction story (issue #402).
 *
 * Scenes: 0 blueprint → 1 materials → 2 ecosystem/build → 3 evidence
 * phone → 4 orbit + progress ring → 5 final hero frame. The story plays
 * once (≈15s of scenes + caption crossfades ≈ the owner's 17s spec) and
 * settles into a stable hero composition.
 *
 * Timeline rules:
 *  - Starts only when the hero enters the viewport; pauses when it leaves
 *    or the tab hides; resumes with the remaining scene time.
 *  - `prefers-reduced-motion` jumps straight to the static final frame:
 *    no story motion, no idle float, everything verified/settled.
 *  - Without JS the server-rendered poster shows the drawn blueprint,
 *    scene-0 caption, badge, CTAs and trust chips — all functional.
 *  - Every animated property is transform/opacity/stroke-dashoffset only;
 *    the visual canvas is decorative (aria-hidden) and scales as one unit.
 */

/* ── timeline constants ─────────────────────────────────────────────── */

const FINAL = 5;
/** Duration of scenes 0–4 in ms; scene 5 is the resting frame. */
const SCENE_MS: readonly number[] = [2200, 3200, 3200, 3200, 3200];

/** Design-space canvas. Scaled as one unit to fit the column. */
const DESIGN_W = 1000;
const DESIGN_H = 700;
const SITE_CENTER = { x: 480, y: 390 };

const springSoft: Transition = { type: "spring", stiffness: 110, damping: 16 };
const springSnap: Transition = { type: "spring", stiffness: 200, damping: 15 };
const easeExpo = [0.16, 1, 0.3, 1] as const;

type Phase = 0 | 1 | 2 | 3 | 4 | 5;
type Target = { x: number; y: number; scale?: number; opacity?: number; rotate?: number };

/* ── floating-object choreography ───────────────────────────────────── */

const ORBIT = { cx: SITE_CENTER.x - 10, cy: SITE_CENTER.y + 8, rx: 330, ry: 200 };
const SETTLE_DEG = 26;

function orbitPos(i: number, extraDeg: number): { x: number; y: number } {
  const a = ((-90 + (i * 360) / 7 + extraDeg) * Math.PI) / 180;
  return { x: ORBIT.cx + ORBIT.rx * Math.cos(a), y: ORBIT.cy + ORBIT.ry * Math.sin(a) };
}

interface Floater {
  id: string;
  render: () => ReactNode;
  /** design-space width */
  w: number;
  /** entrance offset direction (scene-1 fly-in) */
  from: { dx: number; dy: number; rot: number };
  /** resting spot in scene 1 (exploded composition) */
  p1: Target;
  /** scenes 2–3: pushed outward, dimmed context */
  p2: Target;
  /** scene 4+ orbit slot (absent → fades out instead) */
  orbit?: number;
  idle: { amp: number; dur: number; delay: number; rot: number };
}

const FLOATERS: Floater[] = [
  {
    id: "hardhat", w: 150, orbit: 3,
    render: () => <HardHat className="h-auto w-full" />,
    from: { dx: -90, dy: -170, rot: -24 },
    p1: { x: 130, y: 118, rotate: -10 },
    p2: { x: 60, y: 60, scale: 0.8, opacity: 0.32, rotate: -14 },
    idle: { amp: 7, dur: 5.2, delay: 0.4, rot: 2 },
  },
  {
    id: "bricks", w: 165, orbit: 1,
    render: () => <BrickStack className="h-auto w-full" />,
    from: { dx: 220, dy: -40, rot: 16 },
    p1: { x: 640, y: 96, rotate: 7 },
    p2: { x: 750, y: 60, scale: 0.8, opacity: 0.32, rotate: 10 },
    idle: { amp: 6, dur: 6.1, delay: 1.1, rot: -1.6 },
  },
  {
    id: "rebar", w: 195,
    render: () => <Rebar className="h-auto w-full" />,
    from: { dx: 240, dy: 130, rot: 22 },
    p1: { x: 690, y: 300, rotate: -18 },
    p2: { x: 800, y: 330, scale: 0.8, opacity: 0.32, rotate: -24 },
    idle: { amp: 5, dur: 6.8, delay: 0.8, rot: 1.2 },
  },
  {
    id: "cement", w: 150, orbit: 0,
    render: () => <CementBag className="h-auto w-full" />,
    from: { dx: -200, dy: 60, rot: -18 },
    p1: { x: 120, y: 320, rotate: 6 },
    p2: { x: 55, y: 370, scale: 0.8, opacity: 0.32, rotate: 2 },
    idle: { amp: 8, dur: 5.6, delay: 1.7, rot: 1.8 },
  },
  {
    id: "blueprint-roll", w: 145,
    render: () => <BlueprintRoll className="h-auto w-full" />,
    from: { dx: -160, dy: 150, rot: -14 },
    p1: { x: 295, y: 505, rotate: -8 },
    p2: { x: 210, y: 570, scale: 0.8, opacity: 0.32, rotate: -12 },
    idle: { amp: 5, dur: 6.4, delay: 0.2, rot: -1.2 },
  },
  {
    id: "toolbox", w: 160,
    render: () => <Toolbox className="h-auto w-full" />,
    from: { dx: 120, dy: 190, rot: 12 },
    p1: { x: 545, y: 512, rotate: 4 },
    p2: { x: 585, y: 590, scale: 0.8, opacity: 0.32, rotate: 6 },
    idle: { amp: 6, dur: 5.9, delay: 2.1, rot: 1.4 },
  },
  {
    id: "spade", w: 82, orbit: 6,
    render: () => <Spade className="h-auto w-full" />,
    from: { dx: 260, dy: -140, rot: 26 },
    p1: { x: 848, y: 118, rotate: 14 },
    p2: { x: 900, y: 110, scale: 0.8, opacity: 0.32, rotate: 18 },
    idle: { amp: 7, dur: 6.6, delay: 1.4, rot: -2 },
  },
  {
    id: "wheelbarrow", w: 175,
    render: () => <Wheelbarrow className="h-auto w-full" />,
    from: { dx: 40, dy: 230, rot: 10 },
    p1: { x: 348, y: 548, rotate: -5 },
    p2: { x: 320, y: 620, scale: 0.8, opacity: 0.32, rotate: -8 },
    idle: { amp: 6, dur: 7.2, delay: 0.9, rot: 1.1 },
  },
  {
    id: "truck", w: 165, orbit: 2,
    render: () => <Truck className="h-auto w-full" />,
    from: { dx: 300, dy: 40, rot: 14 },
    p1: { x: 810, y: 428, rotate: -6 },
    p2: { x: 870, y: 470, scale: 0.8, opacity: 0.32, rotate: -10 },
    idle: { amp: 5, dur: 6.2, delay: 2.4, rot: -1 },
  },
  {
    id: "doc", w: 88, orbit: 4,
    render: () => <DocCard className="h-auto w-full" />,
    from: { dx: -60, dy: -210, rot: -12 },
    p1: { x: 392, y: 128, rotate: 8 },
    p2: { x: 420, y: 92, scale: 0.8, opacity: 0.32, rotate: 12 },
    idle: { amp: 8, dur: 5.4, delay: 1.9, rot: 2.2 },
  },
 {
    id: "pay", w: 108, orbit: 5,
    render: () => <PayCard className="h-auto w-full" />,
    from: { dx: 200, dy: 180, rot: 18 },
    p1: { x: 700, y: 555, rotate: -10 },
    p2: { x: 760, y: 615, scale: 0.8, opacity: 0.32, rotate: -14 },
    idle: { amp: 7, dur: 6.9, delay: 0.6, rot: -1.8 },
  },
];

function floaterTarget(f: Floater, phase: Phase, simplified: boolean): Target {
  if (phase === 0) {
    return {
      ...f.p1,
      x: f.p1.x + f.from.dx,
      y: f.p1.y + f.from.dy,
      rotate: (f.p1.rotate ?? 0) + f.from.rot,
      opacity: 0,
    };
  }
  if (phase === 1) return { ...f.p1, opacity: 1 };
  if (phase === 2 || phase === 3) return { ...f.p2, opacity: f.p2.opacity ?? 0.32 };
  // scenes 4–5: orbit members move onto the ring; the rest retire
  if (f.orbit === undefined) return { ...f.p2, opacity: 0 };
  const extra = phase === 5 ? SETTLE_DEG : 0;
  const pos = orbitPos(f.orbit, extra);
  const shrink = simplified ? 0.92 : 1;
  return {
    x: pos.x - (f.w * shrink) / 2,
    y: pos.y - 55 * shrink,
    scale: 0.88 * shrink,
    opacity: 1,
    rotate: f.p1.rotate ?? 0,
  };
}

/* ecosystem chips (scenes 2–3) */
const CHIPS = [
  { id: "procurement", label: "Procurement", Icon: ShoppingCart, x: 165, y: 205 },
  { id: "inventory", label: "Inventory", Icon: Boxes, x: 470, y: 78 },
  { id: "workforce", label: "Workforce", Icon: Users, x: 780, y: 205 },
  { id: "deliveries", label: "Deliveries", Icon: TruckIcon, x: 165, y: 545 },
  { id: "evidence", label: "Site evidence", Icon: Camera, x: 780, y: 545 },
  { id: "payments", label: "Payments", Icon: CreditCard, x: 470, y: 632 },
] as const;

const CAPTIONS = [
  { kicker: "Every project starts with a plan.", text: "Build with clarity." },
  { kicker: "Materials, tools, people — in one frame.", text: "Every material. Every movement." },
  { kicker: "Procurement to payments, wired together.", text: "One connected construction site." },
  { kicker: "Photo, GPS, time — then a human verifies.", text: "Know what happened. See the evidence." },
  { kicker: "Track value from order to milestone.", text: "From procurement to project completion." },
] as const;

/* ── component ──────────────────────────────────────────────────────── */

export function HeroAnimation() {
  const [phase, setPhase] = useState<Phase>(0);
  const [started, setStarted] = useState(false);
  const [running, setRunning] = useState(false);
  const [buildStage, setBuildStage] = useState<BuildStage>(0);
  const [phoneStep, setPhoneStep] = useState(0); // 0 idle · 1 reviewed · 2 verified · 3 delivery verified
  const [scale, setScale] = useState(0.5);

  const sectionRef = useRef<HTMLElement | null>(null);
  const canvasWrapRef = useRef<HTMLDivElement | null>(null);
  const remainRef = useRef<number | null>(null);
  const advancedRef = useRef(false);
  const inViewRef = useRef(false);

  const reduce = useReducedMotion();
  const reduced = reduce === true;
  const playing = started && !reduced;
  const simplified = scale < 0.52;

  /* Derived view state — no effect-synced mirrors (react-hooks/set-state-in-effect).
     Reduced motion derives the settled final frame straight from the flag. */
  const effPhase = (reduced ? FINAL : phase) as Phase;
  const shownPhoneStep = effPhase >= 4 ? 3 : effPhase === 3 ? phoneStep : 0;
  const shownStage: BuildStage = effPhase >= 4 ? 4 : buildStage;
  const effProgress = effPhase >= 4 ? 0.985 : 0;

  /* viewport visibility — drives start + pause/resume */
  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        inViewRef.current = entry.isIntersecting;
        if (entry.isIntersecting) setStarted(true); // first sight starts the story (once)
        setRunning(entry.isIntersecting && document.visibilityState === "visible");
      },
      { threshold: 0.25 },
    );
    io.observe(el);
    const onVis = () =>
      setRunning(document.visibilityState === "visible" && inViewRef.current);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  /* main scene clock — pausable, resumes with remaining scene time */
  useEffect(() => {
    if (!playing || !running || phase >= FINAL) return;
    const remain = remainRef.current ?? SCENE_MS[phase];
    remainRef.current = null;
    const deadline = Date.now() + remain;
    const t = setTimeout(() => {
      advancedRef.current = true;
      setPhase((p) => (p + 1) as Phase);
    }, remain);
    return () => {
      clearTimeout(t);
      if (!advancedRef.current) remainRef.current = Math.max(0, deadline - Date.now());
      advancedRef.current = false;
    };
  }, [phase, playing, running]);

  /* scene-2 sub-clock: the building rises in four stages */
  useEffect(() => {
    if (!playing || !running || phase !== 2) return;
    const steps = [0, 650, 1300, 1950].map((ms, i) =>
      setTimeout(() => setBuildStage((i + 1) as BuildStage), ms),
    );
    return () => steps.forEach(clearTimeout);
  }, [phase, playing, running]);

  /* scene-3 sub-clock: human review happens BEFORE the status verifies */
  useEffect(() => {
    if (phase !== 3 || !playing || !running || reduced) return;
    const steps = [
      setTimeout(() => setPhoneStep(1), 1100),
      setTimeout(() => setPhoneStep(2), 2000),
      setTimeout(() => setPhoneStep(3), 2650),
    ];
    return () => steps.forEach(clearTimeout);
  }, [phase, playing, running, reduced]);

  /* canvas fit: scale the 1000×700 design box to the column width */
  useEffect(() => {
    const el = canvasWrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const s = entry.contentRect.width / DESIGN_W;
      setScale(Math.max(0.2, Math.min(1.05, s)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const renderFloater = useCallback(
    (f: Floater) => {
      const t = floaterTarget(f, effPhase, simplified);
      const w = f.w * (simplified ? 0.92 : 1);
      return (
        <motion.div
          key={f.id}
          className="absolute left-0 top-0 will-change-transform"
          style={{ width: w }}
          initial={false}
          animate={{
            x: t.x,
            y: t.y,
            scale: t.scale ?? 1,
            opacity: t.opacity ?? 1,
            rotate: t.rotate ?? 0,
          }}
          transition={effPhase === 1 ? springSnap : springSoft}
        >
          <motion.div
            animate={
              reduced
                ? undefined
                : { y: [0, -f.idle.amp, 0], rotate: [0, f.idle.rot, 0, -f.idle.rot, 0] }
            }
            transition={
              reduced
                ? undefined
                : { duration: f.idle.dur, delay: f.idle.delay, repeat: Infinity, ease: "easeInOut" }
            }
          >
            {f.render()}
          </motion.div>
        </motion.div>
      );
    },
    [effPhase, simplified, reduced],
  );

  const floaters = useMemo(
    () => (effPhase >= 1 || playing ? FLOATERS.map(renderFloater) : []),
    [effPhase, playing, renderFloater],
  );

  const chipVisible = effPhase === 2 || effPhase === 3;

  return (
    <section
      ref={sectionRef}
      data-hero-animation=""
      data-phase={effPhase}
      className="relative overflow-hidden border-b border-ink/10"
    >
      <div className="absolute inset-0 bg-survey-grid" aria-hidden />
      <div className="absolute inset-0 bg-gradient-to-b from-paper/40 via-paper/60 to-paper" aria-hidden />

      <div className="relative mx-auto w-full max-w-6xl px-4 pb-14 pt-12 sm:px-6 sm:pt-16 lg:px-8 lg:pb-20 lg:pt-20">
        <div className="grid items-center gap-10 lg:grid-cols-[1fr_1.12fr] lg:gap-12">
          {/* ── copy column ── */}
          <div className="min-w-0">
            <p className="inline-flex items-center gap-2 rounded-full border border-forest-100 bg-forest-50/80 px-3 py-1 text-xs font-medium text-forest-800 backdrop-blur">
              <Camera className="h-3.5 w-3.5 text-earth-600" aria-hidden />
              The operating system for real-world construction
            </p>

            {/* headline slot — scene captions crossfade; the real h1 is sr-only */}
            <div className="relative mt-5 min-h-[220px] sm:min-h-[240px] lg:min-h-[262px]">
              <h1 className="sr-only">
                MjengoOS — The evidence-backed operating system for construction. Every site. Every milestone. Accounted for.
              </h1>

              {CAPTIONS.map((c, i) => (
                <motion.div
                  key={c.text}
                  aria-hidden
                  className="absolute inset-x-0 top-0"
                  initial={false}
                  animate={{ opacity: effPhase === i ? 1 : 0, y: effPhase === i ? 0 : 14 }}
                  transition={{ duration: 0.55, ease: easeExpo }}
                >
                  <p className="text-[13px] font-medium uppercase tracking-[0.14em] text-forest-700">{c.kicker}</p>
                  <p className="mt-3 font-display text-[34px] font-bold leading-[1.05] tracking-tight text-ink sm:text-[42px]">
                    {c.text}
                  </p>
                </motion.div>
              ))}

              {/* final brand lockup */}
              <motion.div
                aria-hidden
                className="absolute inset-x-0 top-0"
                initial={false}
                animate={{ opacity: effPhase === FINAL ? 1 : 0, y: effPhase === FINAL ? 0 : 14 }}
                transition={{ duration: 0.55, ease: easeExpo }}
              >
                <div className="inline-flex items-center gap-2.5">
                  <LogoMark className="h-9 w-9" />
                  <span className="font-display text-[22px] font-semibold leading-none tracking-tight text-ink">
                    MjengoOS
                  </span>
                </div>
                <p className="mt-4 font-display text-[34px] font-bold leading-[1.05] tracking-tight text-ink sm:text-[42px]">
                  The evidence-backed operating system{" "}
                  <span className="text-forest-800">for construction.</span>
                </p>
                <p className="mt-4 text-lg leading-relaxed text-ink-mute sm:text-xl">
                  Every site. Every milestone. Accounted for.
                </p>
              </motion.div>
            </div>

            {/* CTAs — real links, live from SSR onward (no-JS / reduced-motion included) */}
            <div className="mt-2 flex flex-col gap-3 sm:flex-row">
              <Button
                href="/platform"
                size="lg"
                variant="secondary"
                onClick={() => track("hero_cta_clicked", { cta: "explore_platform" })}
              >
                Explore MjengoOS
              </Button>
              <Button
                href="/signup"
                size="lg"
                onClick={() => track("hero_cta_clicked", { cta: "start_project" })}
              >
                Get Started
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M5 12h14" />
                  <path d="m12 5 7 7-7 7" />
                </svg>
              </Button>
            </div>

            <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-ink-mute">
              <span className="inline-flex items-center gap-1.5">
                <Camera className="h-3.5 w-3.5 text-forest-600" aria-hidden />
                Photo evidence with GPS + time
              </span>
              <span className="inline-flex items-center gap-1.5">
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-forest-600" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M12 20h.01" />
                  <path d="M8.5 16.4a5 5 0 0 1 7 0" />
                  <path d="M5 12.9a10 10 0 0 1 14 0" />
                  <path d="M1.8 9.4a15 15 0 0 1 20.4 0" />
                </svg>
                Works offline on site
              </span>
              <span className="inline-flex items-center gap-1.5">
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-forest-600" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
                  <circle cx="12" cy="10" r="3" />
                </svg>
                Kenya first · Africa next
              </span>
            </div>
          </div>

          {/* ── animated canvas column (decorative) ── */}
          <div
            ref={canvasWrapRef}
            aria-hidden
            className="relative mx-auto w-full max-w-[620px] select-none lg:max-w-none"
            style={{ height: Math.round(DESIGN_H * scale) }}
          >
            <div
              className="absolute left-0 top-0 origin-top-left"
              style={{ width: DESIGN_W, height: DESIGN_H, transform: `scale(${scale})` }}
            >
              {/* crane behind the finished site (final frame dressing) */}
              <motion.div
                className="absolute left-0 top-0"
                style={{ width: 205 }}
                initial={false}
                animate={{
                  opacity: effPhase === FINAL ? 1 : 0,
                  x: 218,
                  y: 96,
                  scale: effPhase === FINAL ? 1 : 0.95,
                }}
                transition={{ duration: 0.9, ease: easeExpo }}
              >
                <Crane className="h-auto w-full" />
              </motion.div>

              {/* progress ring around the site (scenes 4–5) */}
              <motion.div
                className="absolute left-0 top-0"
                style={{ width: 288 }}
                initial={false}
                animate={{ opacity: effPhase >= 4 ? 1 : 0, x: 336, y: 246 }}
                transition={{ duration: 0.7, ease: easeExpo }}
              >
                <ProgressRing progress={effProgress} className="h-auto w-full" />
              </motion.div>

              {/* miniature site — rises in four stages from scene 2 */}
              <motion.div
                className="absolute left-0 top-0"
                style={{ width: 300 }}
                initial={false}
                animate={{
                  opacity: effPhase >= 2 ? 1 : 0,
                  x: effPhase === 3 ? 330 : 340,
                  y: effPhase >= 2 ? 262 : 300,
                  scale: effPhase === 5 ? 1.07 : effPhase === 3 ? 0.94 : 1,
                }}
                transition={springSoft}
              >
                <GroundShadow className="absolute -bottom-3 left-1/2 w-[240px] -translate-x-1/2" />
                <MiniBuilding stage={shownStage} className="h-auto w-full" />
              </motion.div>

              {/* connecting lines under the chips */}
              <svg
                viewBox="0 0 1000 700"
                className="absolute left-0 top-0"
                style={{ width: DESIGN_W, height: DESIGN_H }}
              >
                {CHIPS.map((c, i) => (
                  <motion.line
                    key={c.id}
                    x1={SITE_CENTER.x}
                    y1={SITE_CENTER.y}
                    x2={c.x}
                    y2={c.y}
                    stroke="#2F7D52"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    initial={{ pathLength: 0, opacity: 0 }}
                    animate={{ pathLength: chipVisible ? 1 : 0, opacity: chipVisible ? 0.5 : 0 }}
                    transition={{ duration: 0.55, delay: chipVisible && playing ? 2.35 + i * 0.11 : 0, ease: easeExpo }}
                  />
                ))}
              </svg>

              {/* ecosystem chips (scenes 2–3) */}
              {CHIPS.map((c, i) => (
                <motion.div
                  key={c.id}
                  className="absolute left-0 top-0 flex items-center gap-2 rounded-2xl bg-white px-3.5 py-2.5 shadow-[0_10px_28px_-12px_rgb(23_25_24/0.35)] ring-1 ring-ink/5"
                  initial={false}
                  animate={{
                    x: c.x - 66,
                    y: chipVisible ? c.y - 22 : c.y - 2,
                    opacity: chipVisible ? 1 : 0,
                    scale: chipVisible ? 1 : 0.82,
                  }}
                  transition={{ type: "spring", stiffness: 170, damping: 16, delay: chipVisible && playing ? 2.2 + i * 0.13 : 0 }}
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-forest-50 text-forest-800">
                    <c.Icon className="h-4 w-4" aria-hidden />
                  </span>
                  <span className="text-[11.5px] font-semibold leading-tight text-ink-soft">{c.label}</span>
                </motion.div>
              ))}

              {/* scene 0 · self-drawing blueprint + logo reveal */}
              <motion.div
                className="absolute left-0 top-0"
                style={{ width: 264 }}
                initial={false}
                animate={{
                  opacity: effPhase === 0 ? 1 : 0,
                  scale: effPhase === 0 ? 1 : 0.72,
                  x: 368,
                  y: 226,
                }}
                transition={{ duration: 0.6, ease: easeExpo }}
              >
                {playing ? <DrawingBlueprint /> : <BlueprintSheet className="h-auto w-full" />}
              </motion.div>
              <motion.div
                className="absolute left-0 top-0 flex items-center justify-center gap-2.5"
                style={{ width: 264, x: 368, y: 448 }}
                initial={false}
                animate={{ opacity: effPhase === 0 ? 1 : 0, scale: effPhase === 0 ? 1 : 0.9 }}
                transition={{ duration: 0.7, delay: playing ? 0.95 : 0, ease: easeExpo }}
              >
                <LogoMark className="h-8 w-8" />
                <span className="font-display text-[19px] font-semibold tracking-tight text-ink">MjengoOS</span>
              </motion.div>

              {/* evidence phone (scenes 3–4) */}
              <motion.div
                className="absolute left-0 top-0"
                style={{ width: simplified ? 238 : 205 }}
                initial={false}
                animate={phoneTarget(effPhase, simplified)}
                transition={springSoft}
              >
                <motion.div
                  className="will-change-transform"
                  animate={reduced ? undefined : { y: [0, -9, 0], rotate: [0, -1.4, 0, 1.4, 0] }}
                  transition={reduced ? undefined : { duration: 6.4, repeat: Infinity, ease: "easeInOut" }}
                >
                  <PhoneDashboard
                    reviewed={shownPhoneStep >= 1}
                    verified={shownPhoneStep >= 2}
                    deliveryVerified={shownPhoneStep >= 3}
                    className="h-auto w-full drop-shadow-[0_24px_32px_rgb(23_25_24/0.18)]"
                  />
                </motion.div>
              </motion.div>

              {/* floating materials */}
              {floaters}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* evidence phone position per scene */
function phoneTarget(effPhase: Phase, simplified: boolean): Target {
  if (effPhase <= 2) return { x: 760, y: 780, opacity: 0, scale: 0.9 };
  if (effPhase === 3) {
    return simplified
      ? { x: 330, y: 140, opacity: 1, scale: 1.05 }
      : { x: 700, y: 145, opacity: 1, scale: 1 };
  }
  if (effPhase === 4) return { x: 800, y: 200, opacity: 0.35, scale: 0.82 };
  return { x: 1120, y: 230, opacity: 0, scale: 0.82 };
}

/* blueprint that draws itself — mounted only while the story plays */
function DrawingBlueprint() {
  const mains = [
    "M34 30 H164 V114 H34 Z",
    "M34 58 H164",
    "M34 86 H164",
    "M76 30 V114",
    "M122 30 V114",
    "M44 20 H154",
  ];
  const details = [
    "M46 44 H64 M46 72 H64 M88 44 H110 M134 44 H152",
    "M34 129 H164",
    "M20 146 H220",
  ];
  return (
    <div className="relative">
      <BlueprintSheet className="h-auto w-full [&_g]:hidden" />
      <svg viewBox="0 0 240 170" className="absolute inset-0 h-full w-full">
        {mains.map((d, i) => (
          <motion.path
            key={d}
            d={d}
            fill="none"
            stroke="#123C32"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            initial={{ pathLength: 0, opacity: 0 }}
            animate={{ pathLength: 1, opacity: 1 }}
            transition={{ duration: 0.8, delay: 0.15 + i * 0.22, ease: easeExpo }}
          />
        ))}
        {details.map((d, i) => (
          <motion.path
            key={d}
            d={d}
            fill="none"
            stroke="#2C6B58"
            strokeWidth="1.4"
            strokeLinecap="round"
            initial={{ pathLength: 0, opacity: 0.7 }}
            animate={{ pathLength: 1, opacity: 0.7 }}
            transition={{ duration: 0.7, delay: 1.25 + i * 0.25, ease: easeExpo }}
          />
        ))}
        <motion.g
          stroke="#D9913C"
          strokeWidth="1.6"
          strokeLinecap="round"
          fill="none"
          initial={{ opacity: 0 }}
          animate={{ opacity: 0.9 }}
          transition={{ delay: 1.65, duration: 0.5 }}
        >
          <path d="M34 126 V132 M164 126 V132 M34 129 H164" />
          <path d="M28 30 H22 M28 114 H22 M25 30 V114" />
        </motion.g>
      </svg>
    </div>
  );
}
