'use client';

import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { CtaLink } from './cta-link';
import {
  AnimatePresence,
  motion,
  useInView,
  useReducedMotion,
  type Transition,
} from 'framer-motion';
import {
  Boxes,
  Check,
  ClipboardCheck,
  HardHat,
  RotateCcw,
  ShoppingCart,
  Truck,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react';

/* ------------------------------------------------------------------ */
/* Timeline constants (ms) — the 17s master script                     */
/* ------------------------------------------------------------------ */

const TOTAL_DURATION_MS = 17000;
/** Duration of scenes 1-5. Scene 6 starts at 14s and rests forever. */
const SCENE_DURATIONS_MS = [2000, 3000, 3000, 3000, 3000];
const LAST_SCENE = 6;

const SCENE_CAPTIONS = [
  {
    title: 'Build with clarity.',
    sub: 'MjengoOS turns every site into a living, evidence-backed workspace.',
  },
  {
    title: 'Every material. Every movement.',
    sub: 'Stock, deliveries and usage recorded as they happen.',
  },
  {
    title: 'One connected construction site.',
    sub: 'Every module linked to the same source of truth.',
  },
  {
    title: 'Know what happened. See the evidence.',
    sub: 'Site reports are reviewed and verified by your own supervisors — accountability stays human.',
  },
  {
    title: 'From procurement to project completion.',
    sub: 'Progress you can audit — every milestone accounted for.',
  },
  {
    title: 'The evidence-backed operating system for construction.',
    sub: 'Every site. Every milestone. Accounted for.',
  },
] as const;

/* Idle float — transform-only CSS keyframes (no layout animation). */
const FLOAT_CSS = `
@keyframes mj-float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-9px); } }
@keyframes mj-float-alt { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(8px); } }
.mj-float, .mj-float-alt { animation-duration: 4.5s; animation-timing-function: ease-in-out; animation-iteration-count: infinite; will-change: transform; }
.mj-float { animation-name: mj-float; }
.mj-float-alt { animation-name: mj-float-alt; }
`;

/* ------------------------------------------------------------------ */
/* Original inline-SVG construction objects (shared by scenes 2 and 5) */
/* ------------------------------------------------------------------ */

function CementBagArt({ uid }: { uid: string }) {
  return (
    <g>
      <defs>
        <linearGradient id={`cb-body-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FAFAF9" />
          <stop offset="1" stopColor="#D6D3D1" />
        </linearGradient>
        <filter id={`cb-shadow-${uid}`} x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="5" stdDeviation="5" floodColor="#1C1917" floodOpacity="0.16" />
        </filter>
      </defs>
      <ellipse cx="60" cy="104" rx="40" ry="7" fill="#E7E5E4" opacity="0.7" />
      <g filter={`url(#cb-shadow-${uid})`}>
        <path
          d="M24 34 Q60 26 96 34 L92 96 Q60 102 28 96 Z"
          fill={`url(#cb-body-${uid})`}
          stroke="#A8A29E"
          strokeWidth="1.5"
        />
        <path d="M24 34 Q60 26 96 34 L95 44 Q60 37 25 44 Z" fill="#E7E5E4" stroke="#A8A29E" strokeWidth="1.2" />
        <line x1="60" y1="44" x2="60" y2="96" stroke="#D6D3D1" strokeWidth="1.5" strokeDasharray="4 3" />
        <rect x="38" y="56" width="44" height="16" rx="3" fill="#F59E0B" opacity="0.9" />
        <rect x="45" y="62" width="30" height="4" rx="2" fill="#FAFAF9" opacity="0.85" />
      </g>
    </g>
  );
}

function BrickStackArt({ uid }: { uid: string }) {
  const bricks: Array<[number, number]> = [
    [18, 82],
    [60, 82],
    [39, 65],
    [18, 48],
    [60, 48],
    [39, 31],
  ];
  return (
    <g>
      <defs>
        <linearGradient id={`br-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#F59E0B" />
          <stop offset="1" stopColor="#C2410C" />
        </linearGradient>
        <filter id={`br-shadow-${uid}`} x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="5" stdDeviation="5" floodColor="#1C1917" floodOpacity="0.16" />
        </filter>
      </defs>
      <ellipse cx="60" cy="103" rx="42" ry="7" fill="#E7E5E4" opacity="0.7" />
      <g filter={`url(#br-shadow-${uid})`}>
        {bricks.map(([x, y], i) => (
          <rect
            key={i}
            x={x}
            y={y}
            width="41"
            height="15"
            rx="2"
            fill={`url(#br-${uid})`}
            stroke="#7C2D12"
            strokeWidth="1"
          />
        ))}
        <line x1="18" y1="89.5" x2="101" y2="89.5" stroke="#7C2D12" strokeWidth="0.6" opacity="0.4" />
      </g>
    </g>
  );
}

function RebarBundleArt({ uid }: { uid: string }) {
  const bars = [30, 44, 58, 72, 86];
  return (
    <g>
      <defs>
        <linearGradient id={`rb-steel-${uid}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#A8A29E" />
          <stop offset="0.5" stopColor="#78716C" />
          <stop offset="1" stopColor="#57534E" />
        </linearGradient>
        <filter id={`rb-shadow-${uid}`} x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="5" stdDeviation="5" floodColor="#1C1917" floodOpacity="0.16" />
        </filter>
      </defs>
      <ellipse cx="60" cy="104" rx="38" ry="7" fill="#E7E5E4" opacity="0.7" />
      <g filter={`url(#rb-shadow-${uid})`}>
        {bars.map((x) => (
          <g key={x}>
            <rect x={x} y="26" width="7" height="72" rx="3.5" fill={`url(#rb-steel-${uid})`} />
            <line x1={x + 0.5} y1="38" x2={x + 6.5} y2="38" stroke="#44403C" strokeWidth="1.4" />
            <line x1={x + 0.5} y1="56" x2={x + 6.5} y2="56" stroke="#44403C" strokeWidth="1.4" />
            <line x1={x + 0.5} y1="74" x2={x + 6.5} y2="74" stroke="#44403C" strokeWidth="1.4" />
          </g>
        ))}
        <rect x="24" y="42" width="74" height="9" rx="4.5" fill="#D97706" stroke="#B45309" strokeWidth="1" />
        <rect x="24" y="76" width="74" height="9" rx="4.5" fill="#D97706" stroke="#B45309" strokeWidth="1" />
      </g>
    </g>
  );
}

function HardHatArt({ uid }: { uid: string }) {
  return (
    <g>
      <defs>
        <linearGradient id={`hh-dome-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FBBF24" />
          <stop offset="1" stopColor="#F59E0B" />
        </linearGradient>
        <linearGradient id={`hh-brim-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#F59E0B" />
          <stop offset="1" stopColor="#D97706" />
        </linearGradient>
        <filter id={`hh-shadow-${uid}`} x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="5" stdDeviation="5" floodColor="#1C1917" floodOpacity="0.16" />
        </filter>
      </defs>
      <ellipse cx="60" cy="100" rx="44" ry="7" fill="#E7E5E4" opacity="0.7" />
      <g filter={`url(#hh-shadow-${uid})`}>
        <ellipse cx="60" cy="82" rx="45" ry="9.5" fill={`url(#hh-brim-${uid})`} stroke="#B45309" strokeWidth="1" />
        <path
          d="M28 82 C28 52 40 34 60 34 C80 34 92 52 92 82 Z"
          fill={`url(#hh-dome-${uid})`}
          stroke="#B45309"
          strokeWidth="1"
        />
        <rect x="56" y="35" width="8" height="22" rx="4" fill="#B45309" opacity="0.55" />
        <rect x="53" y="60" width="14" height="20" rx="3" fill="#FAFAF9" opacity="0.3" />
      </g>
    </g>
  );
}

function BlueprintRollArt({ uid }: { uid: string }) {
  return (
    <g>
      <defs>
        <linearGradient id={`bp-body-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFFFFF" />
          <stop offset="1" stopColor="#E7E5E4" />
        </linearGradient>
        <filter id={`bp-shadow-${uid}`} x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="5" stdDeviation="5" floodColor="#1C1917" floodOpacity="0.16" />
        </filter>
      </defs>
      <ellipse cx="60" cy="98" rx="44" ry="7" fill="#E7E5E4" opacity="0.7" />
      <g filter={`url(#bp-shadow-${uid})`}>
        <rect x="20" y="46" width="68" height="30" rx="15" fill={`url(#bp-body-${uid})`} stroke="#A8A29E" strokeWidth="1.2" />
        <ellipse cx="88" cy="61" rx="12" ry="15" fill="#F5F5F4" stroke="#A8A29E" strokeWidth="1.2" />
        <path d="M88 51a10 10 0 1 1 -10 10" fill="none" stroke="#A8A29E" strokeWidth="1.4" />
        <path d="M88 56.5a4.5 4.5 0 1 0 4.5 4.5" fill="none" stroke="#A8A29E" strokeWidth="1.2" />
        <rect x="44" y="46" width="13" height="30" fill="#F59E0B" />
        <line x1="26" y1="55" x2="40" y2="55" stroke="#D6D3D1" strokeWidth="1.4" />
        <line x1="26" y1="62" x2="40" y2="62" stroke="#D6D3D1" strokeWidth="1.4" />
        <line x1="26" y1="69" x2="36" y2="69" stroke="#D6D3D1" strokeWidth="1.4" />
      </g>
    </g>
  );
}

function ToolboxArt({ uid }: { uid: string }) {
  return (
    <g>
      <defs>
        <linearGradient id={`tb-body-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#57534E" />
          <stop offset="1" stopColor="#292524" />
        </linearGradient>
        <filter id={`tb-shadow-${uid}`} x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="5" stdDeviation="5" floodColor="#1C1917" floodOpacity="0.18" />
        </filter>
      </defs>
      <ellipse cx="60" cy="101" rx="44" ry="7" fill="#E7E5E4" opacity="0.7" />
      <g filter={`url(#tb-shadow-${uid})`}>
        <path d="M42 50 Q60 32 78 50" fill="none" stroke="#44403C" strokeWidth="7" strokeLinecap="round" />
        <rect x="20" y="52" width="80" height="42" rx="7" fill={`url(#tb-body-${uid})`} stroke="#1C1917" strokeWidth="1" />
        <rect x="20" y="63" width="80" height="3" fill="#1C1917" opacity="0.45" />
        <rect x="53" y="57" width="14" height="12" rx="2.5" fill="#F59E0B" stroke="#B45309" strokeWidth="0.8" />
        <rect x="27" y="72" width="66" height="14" rx="3" fill="#FAFAF9" opacity="0.08" />
        <rect x="28" y="94" width="12" height="4" rx="1.5" fill="#1C1917" />
        <rect x="80" y="94" width="12" height="4" rx="1.5" fill="#1C1917" />
      </g>
    </g>
  );
}

/* ------------------------------------------------------------------ */
/* Shared mini construction-site building (scenes 3 and 5)             */
/* ------------------------------------------------------------------ */

function BuildingDefs({ uid }: { uid: string }) {
  return (
    <defs>
      <linearGradient id={`bld-slab-${uid}`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#D6D3D1" />
        <stop offset="1" stopColor="#A8A29E" />
      </linearGradient>
      <linearGradient id={`bld-col-${uid}`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#E7E5E4" />
        <stop offset="1" stopColor="#D6D3D1" />
      </linearGradient>
      <linearGradient id={`bld-roof-${uid}`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#57534E" />
        <stop offset="1" stopColor="#292524" />
      </linearGradient>
      <radialGradient id={`bld-ground-${uid}`} cx="0.5" cy="0.5" r="0.5">
        <stop offset="0" stopColor="#D6D3D1" stopOpacity="0.85" />
        <stop offset="1" stopColor="#D6D3D1" stopOpacity="0" />
      </radialGradient>
    </defs>
  );
}

const BUILDING_SPRING: Transition = { type: 'spring', stiffness: 340, damping: 20 };

function BuildingPieces({ animatePieces, uid }: { animatePieces: boolean; uid: string }) {
  const pieces: ReactNode[] = [
    <g key="slab">
      <rect
        x="94"
        y="230"
        width="172"
        height="16"
        rx="3"
        fill={`url(#bld-slab-${uid})`}
        stroke="#A8A29E"
        strokeWidth="1"
      />
    </g>,
    <g key="columns">
      {[108, 154, 200, 246].map((x) => (
        <rect
          key={x}
          x={x}
          y="162"
          width="12"
          height="68"
          rx="1.5"
          fill={`url(#bld-col-${uid})`}
          stroke="#A8A29E"
          strokeWidth="1"
        />
      ))}
    </g>,
    <g key="walls">
      {[121, 167, 213].map((x) => (
        <rect key={x} x={x} y="165" width="32" height="65" fill="#F5F5F4" stroke="#D6D3D1" strokeWidth="1" />
      ))}
    </g>,
    <g key="openings">
      <rect x="166" y="192" width="28" height="38" fill="#FAFAF9" stroke="#78716C" strokeWidth="1.2" />
      <circle cx="189" cy="212" r="1.6" fill="#78716C" />
      <rect x="126" y="180" width="22" height="22" fill="#FEF3C7" stroke="#78716C" strokeWidth="1.2" />
      <path d="M137 180v22M126 191h22" stroke="#78716C" strokeWidth="0.9" fill="none" />
      <rect x="220" y="180" width="22" height="22" fill="#FEF3C7" stroke="#78716C" strokeWidth="1.2" />
      <path d="M231 180v22M220 191h22" stroke="#78716C" strokeWidth="0.9" fill="none" />
    </g>,
    <g key="roof">
      <polygon
        points="86,158 180,98 274,158"
        fill={`url(#bld-roof-${uid})`}
        stroke="#1C1917"
        strokeWidth="1"
        strokeLinejoin="round"
      />
    </g>,
  ];
  return (
    <>
      {pieces.map((el, i) => (
        <motion.g
          key={i}
          initial={animatePieces ? { opacity: 0, y: 20, scale: 0.92 } : false}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ ...BUILDING_SPRING, delay: animatePieces ? 0.12 + i * 0.3 : 0 }}
          style={{ transformBox: 'fill-box', transformOrigin: '50% 100%' }}
        >
          {el}
        </motion.g>
      ))}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Scene 1 (0-2s): blueprint draws itself + wordmark                   */
/* ------------------------------------------------------------------ */

function SceneOne() {
  return (
    <div className="absolute inset-0">
      <svg viewBox="0 0 560 320" className="h-full w-full" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        <defs>
          <pattern id="bp-grid-sm" width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M20 0H0v20" fill="none" stroke="#E7E5E4" strokeWidth="1" />
          </pattern>
          <pattern id="bp-grid-lg" width="100" height="100" patternUnits="userSpaceOnUse">
            <path d="M100 0H0v100" fill="none" stroke="#D6D3D1" strokeWidth="1" />
          </pattern>
        </defs>

        <motion.g initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5 }}>
          <rect x="36" y="20" width="488" height="280" fill="url(#bp-grid-sm)" />
          <rect x="36" y="20" width="488" height="280" fill="url(#bp-grid-lg)" />
        </motion.g>

        <motion.rect
          x="36"
          y="20"
          width="488"
          height="280"
          fill="none"
          stroke="#A8A29E"
          strokeWidth="1.5"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.7, delay: 0.1, ease: 'easeInOut' }}
        />

        {/* house footprint */}
        <motion.rect
          x="150"
          y="112"
          width="220"
          height="148"
          fill="rgba(255,255,255,0.65)"
          stroke="#44403C"
          strokeWidth="2"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.85, delay: 0.3, ease: 'easeInOut' }}
        />

        {/* interior walls */}
        <motion.path
          d="M290 112v148M150 186h140"
          fill="none"
          stroke="#78716C"
          strokeWidth="1.5"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.5, delay: 0.85, ease: 'easeInOut' }}
        />

        {/* door swing — amber accent */}
        <motion.path
          d="M212 260v-38"
          fill="none"
          stroke="#F59E0B"
          strokeWidth="2.5"
          strokeLinecap="round"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.3, delay: 1.0, ease: 'easeOut' }}
        />
        <motion.path
          d="M212 222 A38 38 0 0 1 250 260"
          fill="none"
          stroke="#FBBF24"
          strokeWidth="1.5"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.4, delay: 1.05, ease: 'easeOut' }}
        />

        {/* window openings */}
        <motion.g initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4, delay: 1.15 }}>
          <rect x="170" y="107" width="34" height="10" fill="#FAFAF9" stroke="#78716C" strokeWidth="1.2" />
          <line x1="187" y1="107" x2="187" y2="117" stroke="#78716C" strokeWidth="1" />
          <rect x="145" y="140" width="10" height="34" fill="#FAFAF9" stroke="#78716C" strokeWidth="1.2" />
          <line x1="145" y1="157" x2="155" y2="157" stroke="#78716C" strokeWidth="1" />
          <rect x="365" y="172" width="10" height="34" fill="#FAFAF9" stroke="#78716C" strokeWidth="1.2" />
          <line x1="365" y1="189" x2="375" y2="189" stroke="#78716C" strokeWidth="1" />
        </motion.g>

        {/* walkway to the plot edge */}
        <motion.path
          d="M225 260v40M237 260v40"
          fill="none"
          stroke="#A8A29E"
          strokeWidth="2"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.35, delay: 1.25, ease: 'easeOut' }}
        />

        {/* site greenery */}
        <motion.g initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4, delay: 1.35 }}>
          <circle cx="86" cy="248" r="15" fill="#F5F5F4" stroke="#A8A29E" strokeWidth="1.5" />
          <circle cx="86" cy="248" r="2" fill="#A8A29E" />
          <circle cx="468" cy="86" r="15" fill="#F5F5F4" stroke="#A8A29E" strokeWidth="1.5" />
          <circle cx="468" cy="86" r="2" fill="#A8A29E" />
        </motion.g>

        {/* dimension line */}
        <motion.g initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4, delay: 1.45 }}>
          <line x1="150" y1="92" x2="370" y2="92" stroke="#78716C" strokeWidth="1" />
          <line x1="150" y1="86" x2="150" y2="98" stroke="#78716C" strokeWidth="1" />
          <line x1="370" y1="86" x2="370" y2="98" stroke="#78716C" strokeWidth="1" />
          <text x="260" y="85" textAnchor="middle" fontSize="11" fill="#78716C">
            12.0 m
          </text>
        </motion.g>
      </svg>

      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.55, delay: 0.6, ease: 'easeOut' }}
        className="absolute inset-x-0 top-[8%] flex flex-col items-center"
      >
        <span className="text-2xl font-bold tracking-tight text-stone-900 sm:text-3xl">MjengoOS</span>
        <motion.span
          initial={{ scaleX: 0 }}
          animate={{ scaleX: 1 }}
          transition={{ duration: 0.45, delay: 1.05, ease: 'easeOut' }}
          className="mt-1.5 h-[3px] w-10 rounded-full bg-amber-500"
        />
      </motion.div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Scene 2 (2-5s): six objects spring in and float in a loose arc      */
/* ------------------------------------------------------------------ */

type Floater = {
  key: string;
  Art: ComponentType<{ uid: string }>;
  left: string;
  top: string;
  size: string;
  rotate: number;
  dur: string;
  floatDelay: string;
  floatAlt: boolean;
  hideOnMobile: boolean;
};

const FLOATERS: Floater[] = [
  {
    key: 'cement-bag',
    Art: CementBagArt,
    left: '12%',
    top: '58%',
    size: 'h-20 w-20 sm:h-24 sm:w-24 lg:h-28 lg:w-28',
    rotate: -6,
    dur: '4.4s',
    floatDelay: '1.2s',
    floatAlt: false,
    hideOnMobile: false,
  },
  {
    key: 'bricks',
    Art: BrickStackArt,
    left: '28%',
    top: '33%',
    size: 'h-20 w-20 sm:h-24 sm:w-24 lg:h-28 lg:w-28',
    rotate: 4,
    dur: '5s',
    floatDelay: '1.5s',
    floatAlt: true,
    hideOnMobile: true,
  },
  {
    key: 'rebar',
    Art: RebarBundleArt,
    left: '45.5%',
    top: '24%',
    size: 'h-20 w-20 sm:h-24 sm:w-24 lg:h-28 lg:w-28',
    rotate: -2,
    dur: '4.7s',
    floatDelay: '1s',
    floatAlt: false,
    hideOnMobile: false,
  },
  {
    key: 'hard-hat',
    Art: HardHatArt,
    left: '63.5%',
    top: '33%',
    size: 'h-20 w-20 sm:h-24 sm:w-24 lg:h-28 lg:w-28',
    rotate: 5,
    dur: '4.3s',
    floatDelay: '1.7s',
    floatAlt: true,
    hideOnMobile: false,
  },
  {
    key: 'blueprint-roll',
    Art: BlueprintRollArt,
    left: '80%',
    top: '44%',
    size: 'h-20 w-20 sm:h-24 sm:w-24 lg:h-28 lg:w-28',
    rotate: -4,
    dur: '5.1s',
    floatDelay: '1.3s',
    floatAlt: false,
    hideOnMobile: true,
  },
  {
    key: 'toolbox',
    Art: ToolboxArt,
    left: '90%',
    top: '62%',
    size: 'h-20 w-20 sm:h-24 sm:w-24 lg:h-28 lg:w-28',
    rotate: 3,
    dur: '4.6s',
    floatDelay: '1.6s',
    floatAlt: false,
    hideOnMobile: false,
  },
];

function SceneTwo() {
  return (
    <div className="absolute inset-0">
      {FLOATERS.map((f, i) => {
        const Art = f.Art;
        return (
          <div
            key={f.key}
            className={`absolute ${f.hideOnMobile ? 'hidden sm:block' : ''}`}
            style={{ left: f.left, top: f.top }}
          >
            <div className="-translate-x-1/2 -translate-y-1/2">
              <motion.div
                initial={{ opacity: 0, y: 90, rotate: f.rotate, scale: 0.8 }}
                animate={{ opacity: 1, y: 0, rotate: 0, scale: 1 }}
                transition={{ type: 'spring', stiffness: 240, damping: 16, delay: 0.1 + i * 0.15 }}
              >
                <div
                  className={f.floatAlt ? 'mj-float-alt' : 'mj-float'}
                  style={{ animationDuration: f.dur, animationDelay: f.floatDelay }}
                >
                  <div className={f.size}>
                    <svg viewBox="0 0 120 120" className="h-full w-full" aria-hidden="true">
                      <Art uid="s2" />
                    </svg>
                  </div>
                </div>
              </motion.div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Scene 3 (5-8s): site assembles, six module chips link in            */
/* ------------------------------------------------------------------ */

type ModuleChipDef = { label: string; Icon: LucideIcon; x: number; y: number };

const MODULE_CHIPS: ModuleChipDef[] = [
  { label: 'Procurement', Icon: ShoppingCart, x: 14, y: 20 },
  { label: 'Inventory', Icon: Boxes, x: 86, y: 22 },
  { label: 'Workforce', Icon: Users, x: 7, y: 52 },
  { label: 'Deliveries', Icon: Truck, x: 93, y: 54 },
  { label: 'Site evidence', Icon: ClipboardCheck, x: 17, y: 84 },
  { label: 'Payments', Icon: Wallet, x: 83, y: 84 },
];

function ModuleChip({ label, Icon, index }: { label: string; Icon: LucideIcon; index: number }) {
  return (
    <motion.span
      initial={{ opacity: 0, scale: 0.4, y: 8 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 420, damping: 17, delay: 1.7 + index * 0.09 }}
      className="inline-flex items-center gap-1.5 rounded-full border border-stone-200 bg-white/95 px-2.5 py-1.5 shadow-[0_2px_10px_rgba(28,25,23,0.08)]"
    >
      <Icon className="h-3.5 w-3.5 text-amber-600" strokeWidth={2.25} aria-hidden="true" />
      <span className="text-[11px] font-medium leading-none text-stone-700">{label}</span>
    </motion.span>
  );
}

function SceneThree() {
  return (
    <div className="absolute inset-0">
      {/* connector lines — md+ only, drawn after the chips pop in */}
      <svg
        className="absolute inset-0 hidden h-full w-full md:block"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <defs>
          <filter id="chip-line-glow" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="1.4" />
          </filter>
        </defs>
        {MODULE_CHIPS.map((m, i) => (
          <g key={m.label}>
            <motion.line
              x1="50"
              y1="53"
              x2={m.x}
              y2={m.y}
              stroke="#FCD34D"
              strokeWidth="4.5"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              filter="url(#chip-line-glow)"
              opacity="0.45"
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: 0.45, delay: 2.05 + i * 0.06, ease: 'easeInOut' }}
            />
            <motion.line
              x1="50"
              y1="53"
              x2={m.x}
              y2={m.y}
              stroke="#F59E0B"
              strokeWidth="1.5"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: 0.45, delay: 2.05 + i * 0.06, ease: 'easeInOut' }}
            />
          </g>
        ))}
      </svg>

      {/* assembling mini site */}
      <div className="absolute left-1/2 top-[36%] z-10 w-[64%] -translate-x-1/2 -translate-y-1/2 sm:top-[42%] md:top-[54%] md:w-[50%] lg:w-[46%]">
        <svg viewBox="0 0 360 280" className="h-auto w-full" aria-hidden="true">
          <BuildingDefs uid="s3" />
          <ellipse cx="180" cy="248" rx="150" ry="12" fill="url(#bld-ground-s3)" />
          <BuildingPieces animatePieces uid="s3" />
        </svg>
      </div>

      {/* module chips positioned around the site (md+) */}
      <div className="absolute inset-0 z-20 hidden md:block">
        {MODULE_CHIPS.map((m, i) => (
          <div
            key={m.label}
            className="absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${m.x}%`, top: `${m.y}%` }}
          >
            <ModuleChip label={m.label} Icon={m.Icon} index={i} />
          </div>
        ))}
      </div>
      {/* module chips wrap below the site (mobile) */}
      <div className="absolute inset-x-0 bottom-2 z-20 flex flex-wrap items-center justify-center gap-1.5 px-3 md:hidden">
        {MODULE_CHIPS.map((m, i) => (
          <ModuleChip key={m.label} label={m.label} Icon={m.Icon} index={i} />
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Scene 4 (8-11s): human verification flow on a card mockup           */
/* ------------------------------------------------------------------ */

function SceneFour() {
  const [verified, setVerified] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setVerified(true), 1400);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="absolute inset-0 flex items-center justify-center p-4 sm:p-6">
      <motion.div
        initial={{ opacity: 0, y: 26, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: 'spring', stiffness: 260, damping: 22, delay: 0.1 }}
        className="w-full max-w-md rounded-2xl border border-stone-200 bg-white p-5 shadow-[0_24px_60px_-24px_rgba(28,25,23,0.25)] sm:p-6"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-amber-500/15 text-amber-600">
              <ClipboardCheck className="h-4 w-4" aria-hidden="true" />
            </span>
            <span className="text-sm font-semibold text-stone-900">Verification queue</span>
          </div>
          <span className="text-xs text-stone-400">Today, 14:32</span>
        </div>

        <div className="mt-4 rounded-xl border border-stone-200 bg-stone-50/80 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <HardHat className="mt-0.5 h-4 w-4 shrink-0 text-stone-400" aria-hidden="true" />
              <p className="text-sm font-medium leading-snug text-stone-900">
                Site report — Concrete pour, Block C
              </p>
            </div>
            <AnimatePresence mode="wait" initial={false}>
              {verified ? (
                <motion.span
                  key="verified"
                  initial={{ opacity: 0, y: 8, scale: 0.85 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ type: 'spring', stiffness: 400, damping: 18 }}
                  className="inline-flex shrink-0 items-center gap-1 rounded-full border border-green-200 bg-green-50 px-2.5 py-1 text-xs font-semibold text-green-700"
                >
                  <Check className="h-3 w-3" strokeWidth={3} aria-hidden="true" />
                  Verified
                </motion.span>
              ) : (
                <motion.span
                  key="reported"
                  exit={{ opacity: 0, y: -8 }}
                  className="inline-flex shrink-0 items-center rounded-full border border-stone-200 bg-white px-2.5 py-1 text-xs font-medium text-stone-500"
                >
                  Reported
                </motion.span>
              )}
            </AnimatePresence>
          </div>

          <AnimatePresence>
            {verified && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.45, duration: 0.4, ease: 'easeOut' }}
                className="mt-4 flex items-center gap-2.5 border-t border-stone-200 pt-3"
              >
                <svg
                  viewBox="0 0 24 24"
                  className="h-7 w-7 shrink-0 rounded-full bg-stone-200 p-1 text-stone-500"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="9" r="3.2" fill="currentColor" />
                  <path d="M5.5 19.5a6.5 6.5 0 0 1 13 0Z" fill="currentColor" />
                </svg>
                <p className="text-xs leading-relaxed text-stone-500">
                  Reviewed by <span className="font-semibold text-stone-700">A. Supervisor</span> — human
                  sign-off
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Scene 5 (11-14s): orbiting site + progress ring to 100%             */
/* ------------------------------------------------------------------ */

const ORBIT_CX = 400;
const ORBIT_CY = 252;
const ORBIT_RX = 282;
const ORBIT_RY = 142;
const ORBIT_STEPS = 24;
const ORBIT_ARTS: ComponentType<{ uid: string }>[] = [
  CementBagArt,
  BrickStackArt,
  RebarBundleArt,
  HardHatArt,
  BlueprintRollArt,
  ToolboxArt,
];

const ORBIT_TRANSITION: Transition = { duration: 11, ease: 'linear', repeat: Infinity };

function orbitPoints(index: number) {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let k = 0; k <= ORBIT_STEPS; k++) {
    const a = ((index * 60 + (k * 360) / ORBIT_STEPS) * Math.PI) / 180;
    xs.push(ORBIT_CX + ORBIT_RX * Math.cos(a));
    ys.push(ORBIT_CY + ORBIT_RY * Math.sin(a));
  }
  return { xs, ys };
}

function Orbiter({ index, children }: { index: number; children: ReactNode }) {
  const { xs, ys } = orbitPoints(index);
  const delay = 0.2 + index * 0.08;
  return (
    <motion.g
      initial={{ opacity: 0, scale: 0.5, x: xs[0], y: ys[0] }}
      animate={{ opacity: 1, scale: 1, x: xs, y: ys }}
      transition={{
        opacity: { duration: 0.45, delay },
        scale: { type: 'spring', stiffness: 300, damping: 16, delay },
        x: { ...ORBIT_TRANSITION, delay: delay + 0.5 },
        y: { ...ORBIT_TRANSITION, delay: delay + 0.5 },
      }}
      style={{ transformBox: 'fill-box', transformOrigin: '50% 50%' }}
    >
      <g transform="translate(-25 -25) scale(0.4167)">{children}</g>
    </motion.g>
  );
}

function SceneFive() {
  return (
    <div className="absolute inset-0">
      <svg viewBox="0 0 800 460" className="h-full w-full" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        <BuildingDefs uid="s5" />

        {/* orbit guide */}
        <motion.ellipse
          cx={ORBIT_CX}
          cy={ORBIT_CY}
          rx={ORBIT_RX}
          ry={ORBIT_RY}
          fill="none"
          stroke="#D6D3D1"
          strokeWidth="1.5"
          strokeDasharray="4 8"
          initial={{ opacity: 0 }}
          animate={{ opacity: 0.9 }}
          transition={{ duration: 0.6 }}
        />

        {/* completed building with a celebratory settle */}
        <motion.g
          initial={{ scale: 0.985 }}
          animate={{ scale: [0.985, 1.012, 1] }}
          transition={{ duration: 1.1, times: [0, 0.55, 1], ease: 'easeInOut', delay: 0.15 }}
          style={{ transformBox: 'fill-box', transformOrigin: '50% 100%' }}
        >
          <g transform="translate(256 138) scale(0.8)">
            <ellipse cx="180" cy="248" rx="150" ry="12" fill="url(#bld-ground-s5)" />
            <BuildingPieces animatePieces={false} uid="s5" />
          </g>
        </motion.g>

        {/* progress ring draws to 100% */}
        <g>
          <circle cx="118" cy="104" r="42" fill="none" stroke="#E7E5E4" strokeWidth="7" />
          <motion.circle
            cx="118"
            cy="104"
            r="42"
            fill="none"
            stroke="#F59E0B"
            strokeWidth="7"
            strokeLinecap="round"
            transform="rotate(-90 118 104)"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 1.8, delay: 0.55, ease: 'easeInOut' }}
          />
          <motion.text
            x="118"
            y="111"
            textAnchor="middle"
            fontSize="19"
            fontWeight="700"
            fill="#1C1917"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 2.4, duration: 0.3 }}
          >
            100%
          </motion.text>
          <motion.text
            x="118"
            y="170"
            textAnchor="middle"
            fontSize="12.5"
            fill="#78716C"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 2.5, duration: 0.3 }}
          >
            Milestones verified
          </motion.text>
        </g>

        {/* the six objects orbit the completed site */}
        {ORBIT_ARTS.map((Art, i) => (
          <Orbiter key={i} index={i}>
            <Art uid="s5" />
          </Orbiter>
        ))}
      </svg>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Scene 6 (14-17s, then rests): end frame                             */
/* ------------------------------------------------------------------ */

function EndFrame({
  onExplore,
  onGetStarted,
  getStartedHref,
}: {
  onExplore: () => void;
  onGetStarted: () => void;
  getStartedHref?: string | null;
}) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-4 text-center sm:gap-5">
      <div className="flex items-center gap-3">
        <span className="grid h-11 w-11 place-items-center rounded-xl bg-stone-950 shadow-[0_12px_28px_-12px_rgba(28,25,23,0.55)] sm:h-12 sm:w-12">
          <svg viewBox="0 0 32 32" className="h-6 w-6 sm:h-7 sm:w-7" aria-hidden="true">
            <path d="M9 21v-2.5a7 7 0 0 1 14 0V21" fill="#F59E0B" />
            <rect x="14.4" y="8.5" width="3.2" height="6" rx="1.6" fill="#FBBF24" />
            <rect x="6.5" y="21" width="19" height="3" rx="1.5" fill="#D97706" />
          </svg>
        </span>
        <span className="text-2xl font-bold tracking-tight text-stone-900 sm:text-3xl">MjengoOS</span>
      </div>

      <div className="flex flex-col items-center gap-3 sm:flex-row sm:gap-4">
        <CtaLink
          href={getStartedHref ?? null}
          onActivate={onGetStarted}
          className="inline-flex min-h-11 items-center justify-center rounded-lg bg-amber-500 px-6 text-sm font-semibold text-stone-950 shadow-[0_12px_28px_-12px_rgba(245,158,11,0.65)] transition-colors hover:bg-amber-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600"
        >
          Get Started
        </CtaLink>
        <button
          type="button"
          onClick={onExplore}
          className="inline-flex min-h-11 items-center justify-center rounded-lg border border-stone-300 bg-white/70 px-6 text-sm font-semibold text-stone-800 transition-colors hover:border-stone-400 hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-600"
        >
          Explore MjengoOS
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 0-17s progress bar + replay control                                 */
/* ------------------------------------------------------------------ */

function TimelineBar({
  paused,
  reduce,
  runId,
  onReplay,
}: {
  paused: boolean;
  reduce: boolean;
  runId: number;
  onReplay: () => void;
}) {
  const fillRef = useRef<HTMLDivElement>(null);
  const elapsedRef = useRef(0);

  // Reset on replay (declared first so the rAF effect below restarts cleanly).
  useEffect(() => {
    elapsedRef.current = 0;
    if (fillRef.current) fillRef.current.style.width = '0%';
  }, [runId]);

  useEffect(() => {
    if (reduce) {
      elapsedRef.current = TOTAL_DURATION_MS;
      if (fillRef.current) fillRef.current.style.width = '100%';
      return;
    }
    if (paused || elapsedRef.current >= TOTAL_DURATION_MS) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      elapsedRef.current = Math.min(elapsedRef.current + (now - last), TOTAL_DURATION_MS);
      last = now;
      if (fillRef.current) {
        fillRef.current.style.width = `${(elapsedRef.current / TOTAL_DURATION_MS) * 100}%`;
      }
      if (elapsedRef.current < TOTAL_DURATION_MS) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [paused, reduce, runId]);

  return (
    <div className="flex w-full items-center gap-3">
      <div className="h-[3px] flex-1 overflow-hidden rounded-full bg-stone-200" aria-hidden="true">
        <div ref={fillRef} className="h-full rounded-full bg-amber-500" style={{ width: '0%' }} />
      </div>
      {!reduce && (
        <button
          type="button"
          onClick={onReplay}
          aria-label="Replay hero animation"
          className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-600"
        >
          <RotateCcw className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Hero                                                                */
/* ------------------------------------------------------------------ */

export function Hero({
  onExplore,
  onGetStarted,
  getStartedHref,
}: {
  onExplore: () => void;
  onGetStarted: () => void;
  getStartedHref?: string | null;
}) {
  const sectionRef = useRef<HTMLElement | null>(null);
  const inView = useInView(sectionRef, { amount: 0.25 });
  const prefersReduce = useReducedMotion();
  const [scene, setScene] = useState(1);
  const [runId, setRunId] = useState(0);

  // framer's useReducedMotion resolves false during SSR/first paint and updates
  // after mount, so hydration stays consistent without a manual mounted gate.
  const reduce = prefersReduce === true;
  // Reduced motion lands on the static end frame — derived, not a state jump.
  const effectiveScene = reduce ? LAST_SCENE : scene;

  // Master timeline — one timeout per scene, frozen while offscreen.
  useEffect(() => {
    if (reduce || !inView) return;
    if (scene >= LAST_SCENE) return;
    const t = setTimeout(() => {
      setScene((s) => (s >= LAST_SCENE ? s : s + 1));
    }, SCENE_DURATIONS_MS[scene - 1]);
    return () => clearTimeout(t);
  }, [scene, inView, reduce, runId]);

  const replay = () => {
    setRunId((k) => k + 1);
    setScene(1);
  };

  const renderScene = () => {
    switch (effectiveScene) {
      case 1:
        return <SceneOne />;
      case 2:
        return <SceneTwo />;
      case 3:
        return <SceneThree />;
      case 4:
        return <SceneFour />;
      case 5:
        return <SceneFive />;
      default:
        return <EndFrame onExplore={onExplore} onGetStarted={onGetStarted} getStartedHref={getStartedHref} />;
    }
  };

  const caption = SCENE_CAPTIONS[effectiveScene - 1];

  return (
    <section
      ref={sectionRef}
      data-testid="hero"
      className="relative bg-stone-50 pb-8 pt-8 sm:pt-12 md:pb-12 md:pt-16"
    >
      <style>{FLOAT_CSS}</style>

      <p className="sr-only">
        Animated product tour in six scenes over seventeen seconds: a site blueprint draws itself and the
        MjengoOS wordmark appears; construction materials — a cement bag, brick stack, rebar bundle, hard
        hat, rolled blueprint and toolbox — appear and settle; a construction site assembles piece by piece
        and links six modules: procurement, inventory, workforce, deliveries, site evidence and payments; a
        supervisor verifies a site report, with the review signed by a named human; the materials orbit the
        completed site as a progress ring reaches one hundred percent; and a closing frame invites you to
        get started or explore MjengoOS.
      </p>

      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
        {/* Stage */}
        <div className="relative mx-auto aspect-[4/3] w-full max-w-5xl overflow-hidden rounded-2xl border border-stone-200/80 bg-gradient-to-b from-white via-stone-50 to-stone-100 shadow-[0_1px_2px_rgba(28,25,23,0.04),0_28px_60px_-28px_rgba(28,25,23,0.22)] md:aspect-[16/9] md:rounded-3xl">
          {reduce ? (
            <div data-testid="hero-scene-6" className="absolute inset-0">
              <EndFrame onExplore={onExplore} onGetStarted={onGetStarted} getStartedHref={getStartedHref} />
            </div>
          ) : (
            <AnimatePresence initial={false}>
              <motion.div
                key={`${effectiveScene}-${runId}`}
                data-testid={`hero-scene-${effectiveScene}`}
                className="absolute inset-0"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.38, ease: 'easeInOut' }}
              >
                {renderScene()}
              </motion.div>
            </AnimatePresence>
          )}
        </div>

        {/* Scene captions */}
        <div className="relative mx-auto mt-7 w-full max-w-3xl px-2 text-center md:mt-9">
          <div className="relative min-h-[10.5rem] sm:min-h-[10rem] md:min-h-[10.5rem]">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={effectiveScene}
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.34, ease: 'easeOut' }}
                className="absolute inset-x-0 top-0 flex flex-col items-center"
              >
                {effectiveScene === 1 || effectiveScene === LAST_SCENE ? (
                  <h1 className="text-balance text-3xl font-semibold tracking-tight text-stone-900 sm:text-4xl md:text-5xl">
                    {caption.title}
                  </h1>
                ) : (
                  <h2 className="text-balance text-3xl font-semibold tracking-tight text-stone-900 sm:text-4xl md:text-5xl">
                    {caption.title}
                  </h2>
                )}
                <p className="mt-3 max-w-xl text-pretty text-base leading-relaxed text-stone-600 sm:text-lg">
                  {caption.sub}
                </p>
              </motion.div>
            </AnimatePresence>
          </div>
        </div>

        {/* Timeline progress + replay */}
        <div className="mx-auto mt-2 w-full max-w-5xl px-2 md:mt-3">
          <TimelineBar paused={!inView} reduce={reduce} runId={runId} onReplay={replay} />
        </div>
      </div>
    </section>
  );
}
