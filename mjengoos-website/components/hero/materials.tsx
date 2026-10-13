"use client";

import { useId, type SVGProps } from "react";

/**
 * Construction-object asset library for the animated hero (issue #402).
 *
 * All objects are original, gradient-shaded SVG "product cutouts" in the
 * MjengoOS identity: paper #F3F2EE, ink #171918, forest greens (#123C32
 * family), earth ambers (#D9913C family). Light comes from the top-left;
 * every object carries its own baked shading so the scene layer only adds
 * a moving ground shadow. No reference artwork is reproduced.
 *
 * Each component accepts standard SVGProps so the orchestrator controls
 * size/position; viewBoxes are per-object design units.
 */

type AssetProps = SVGProps<SVGSVGElement>;

/* Kraft-cement bag, leaning slightly — "CEMENT 50kg" paperwork. */
export function CementBag(props: AssetProps) {
  const id = useId();
  return (
    <svg viewBox="0 0 150 170" fill="none" {...props}>
      <defs>
        <linearGradient id={`${id}-body`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#e7d9bf" />
          <stop offset="0.55" stopColor="#d9c5a0" />
          <stop offset="1" stopColor="#b39a71" />
        </linearGradient>
        <linearGradient id={`${id}-face`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#efe3cc" />
          <stop offset="1" stopColor="#d3bd94" />
        </linearGradient>
      </defs>
      {/* bag body, gently leaned */}
      <g transform="rotate(-8 75 95)">
        <path
          d="M28 30 Q24 22 34 20 L112 14 Q124 13 123 24 L128 138 Q129 152 114 153 L38 158 Q26 159 25 146 Z"
          fill={`url(#${id}-body)`}
        />
        {/* front face panel */}
        <path d="M40 34 L110 29 L114 140 L44 146 Z" fill={`url(#${id}-face)`} />
        {/* stitched top */}
        <path d="M34 20 L123 14" stroke="#8a734f" strokeWidth="2" strokeDasharray="4 3" strokeLinecap="round" />
        {/* paperwork */}
        <rect x="56" y="46" width="42" height="26" rx="3" fill="#123C32" />
        <path d="M62 66 L70 52 L78 66 M75 60 L81 60" stroke="#F3F2EE" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        <text x="77" y="90" textAnchor="middle" fontSize="13" fontWeight="700" fill="#3a3d3b" fontFamily="inherit">CEMENT</text>
        <text x="77" y="106" textAnchor="middle" fontSize="10" fontWeight="600" fill="#6b706d" fontFamily="inherit">50 kg</text>
        <path d="M56 118 H98" stroke="#b39a71" strokeWidth="2" strokeLinecap="round" />
        <path d="M56 126 H88" stroke="#b39a71" strokeWidth="2" strokeLinecap="round" />
        {/* soft corner crease */}
        <path d="M40 34 Q36 80 44 146" stroke="#c4ab80" strokeWidth="1.4" opacity="0.7" />
        {/* highlight */}
        <path d="M46 30 Q42 60 46 96" stroke="#fdfaf3" strokeWidth="5" strokeLinecap="round" opacity="0.5" />
      </g>
    </svg>
  );
}

/* Stretcher-bond stack of clay bricks. */
export function BrickStack(props: AssetProps) {
  const id = useId();
  const brick = (x: number, y: number, k: number) => (
    <g key={k}>
      <rect x={x} y={y} width="62" height="26" rx="3.5" fill={`url(#${id}-b${k % 2})`} />
      <rect x={x + 4} y={y + 3.5} width="24" height="7" rx="3" fill="#ffffff" opacity="0.35" />
      <rect x={x} y={y + 20} width="62" height="6" rx="3" fill="#171918" opacity="0.12" />
    </g>
  );
  return (
    <svg viewBox="0 0 150 112" fill="none" {...props}>
      <defs>
        <linearGradient id={`${id}-b0`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#d98d5f" />
          <stop offset="1" stopColor="#b8643c" />
        </linearGradient>
        <linearGradient id={`${id}-b1`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#c97a4e" />
          <stop offset="1" stopColor="#a55633" />
        </linearGradient>
      </defs>
      {/* bottom row of two, middle two, top one */}
      {brick(6, 80, 0)}
      {brick(72, 80, 1)}
      {brick(24, 52, 1)}
      {brick(90, 52, 0)}
      {brick(57, 24, 0)}
      {/* mortar hairlines */}
      <path d="M8 79 H140 M26 51 H118 M59 23 H95" stroke="#e8ddcf" strokeWidth="2.4" opacity="0.85" />
    </svg>
  );
}

/* Ribbed steel reinforcement bars, diagonal bundle. */
export function Rebar(props: AssetProps) {
  const id = useId();
  const rods = [-16, 0, 16, 32];
  return (
    <svg viewBox="0 0 170 64" fill="none" {...props}>
      <defs>
        <linearGradient id={`${id}-steel`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#c8cccb" />
          <stop offset="0.5" stopColor="#8f9694" />
          <stop offset="1" stopColor="#5f6664" />
        </linearGradient>
      </defs>
      {rods.map((dy, i) => (
        <g key={i}>
          <rect x="6" y={16 + dy * 0.55} width="158" height="9" rx="4.5" fill={`url(#${id}-steel)`} />
          {Array.from({ length: 12 }).map((_, r) => (
            <path
              key={r}
              d={`M${16 + r * 13} ${17.5 + dy * 0.55} l5 7`}
              stroke="#eef1f0"
              strokeWidth="1.6"
              opacity="0.75"
              strokeLinecap="round"
            />
          ))}
          <rect x="6" y={16 + dy * 0.55} width="158" height="3" rx="1.5" fill="#ffffff" opacity="0.45" />
        </g>
      ))}
      {/* tie wire */}
      <path d="M34 18 Q40 32 34 46 M126 16 Q132 30 126 44" stroke="#b8643c" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

/* Safety helmet, earth-amber shell with ridge and brim. */
export function HardHat(props: AssetProps) {
  const id = useId();
  return (
    <svg viewBox="0 0 140 100" fill="none" {...props}>
      <defs>
        <linearGradient id={`${id}-shell`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f2b45c" />
          <stop offset="0.55" stopColor="#e3a75f" />
          <stop offset="1" stopColor="#c68a2b" />
        </linearGradient>
        <linearGradient id={`${id}-brim`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ebc48c" />
          <stop offset="1" stopColor="#a5681f" />
        </linearGradient>
      </defs>
      {/* shell */}
      <path d="M22 66 Q22 24 70 22 Q118 24 118 66 Z" fill={`url(#${id}-shell)`} />
      {/* ridge */}
      <path d="M64 22 Q70 18 76 22 L76 64 L64 64 Z" fill="#c68a2b" opacity="0.9" />
      <path d="M67 20 Q70 18.5 73 20 L73 62 L67 62 Z" fill="#f7d9a8" opacity="0.8" />
      {/* brim */}
      <path d="M12 66 Q10 74 20 76 L120 76 Q130 74 128 66 Q127 60 118 62 L22 62 Q13 60 12 66 Z" fill={`url(#${id}-brim)`} />
      <path d="M20 68 H120" stroke="#8a551a" strokeWidth="1.6" opacity="0.5" />
      {/* highlight */}
      <path d="M40 34 Q52 26 66 26" stroke="#ffe9c4" strokeWidth="5" strokeLinecap="round" opacity="0.7" />
      {/* front badge */}
      <rect x="60" y="44" width="20" height="12" rx="2.5" fill="#123C32" />
      <path d="M64 52 L68 46 L72 52" stroke="#F3F2EE" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* Rolled site blueprint with forest band. */
export function BlueprintRoll(props: AssetProps) {
  const id = useId();
  return (
    <svg viewBox="0 0 130 90" fill="none" {...props}>
      <defs>
        <linearGradient id={`${id}-paper`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#dfe4ea" />
        </linearGradient>
      </defs>
      <g transform="rotate(-10 65 45)">
        <rect x="30" y="30" width="94" height="30" rx="15" fill={`url(#${id}-paper)`} />
        <circle cx="32" cy="45" r="15" fill="#eef1f4" />
        <circle cx="32" cy="45" r="10.5" fill="#ffffff" />
        <circle cx="32" cy="45" r="5.5" fill="#dfe4ea" />
        <circle cx="32" cy="45" r="1.8" fill="#8f9694" />
        <rect x="86" y="30" width="10" height="30" fill="#123C32" />
        <path d="M48 40 H80 M48 45 H74 M48 50 H80" stroke="#aeb6bd" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M34 57 H120" stroke="#aeb6bd" strokeWidth="2" opacity="0.55" />
      </g>
    </svg>
  );
}

/* Unfolded blueprint sheet — doubles as the scene-0 self-drawing plan. */
export function BlueprintSheet(props: AssetProps) {
  const id = useId();
  return (
    <svg viewBox="0 0 240 170" fill="none" {...props}>
      <defs>
        <linearGradient id={`${id}-paper`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#e9edf2" />
        </linearGradient>
      </defs>
      <rect x="6" y="6" width="228" height="158" rx="6" fill={`url(#${id}-paper)`} stroke="#c9d1d8" strokeWidth="1.4" />
      {/* title block */}
      <rect x="150" y="128" width="74" height="26" rx="3" fill="#f4f6f8" stroke="#c9d1d8" strokeWidth="1" />
      <path d="M156 136 H196 M156 143 H186" stroke="#9aa4ac" strokeWidth="1.6" strokeLinecap="round" />
      {/* the building plan */}
      <g stroke="#123C32" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none">
        <rect x="34" y="30" width="130" height="84" rx="3" />
        <path d="M34 58 H164 M34 86 H164 M76 30 V114 M122 30 V114" />
        <path d="M46 44 H64 M46 72 H64 M88 44 H110 M134 44 H152 M88 100 H110" opacity="0.7" />
        <rect x="44" y="20" width="110" height="10" rx="2" opacity="0.85" />
      </g>
      {/* dimension marks */}
      <g stroke="#D9913C" strokeWidth="1.6" strokeLinecap="round">
        <path d="M34 126 V132 M164 126 V132 M34 129 H164" opacity="0.9" />
        <path d="M28 30 H22 M28 114 H22 M25 30 V114" opacity="0.9" />
      </g>
      {/* foundation grid */}
      <g stroke="#2C6B58" strokeWidth="1.1" opacity="0.55">
        <path d="M20 152 H220 M20 146 H220" />
        <path d="M34 146 V158 M64 146 V158 M94 146 V158 M124 146 V158 M154 146 V158 M184 146 V158 M214 146 V158" />
      </g>
    </svg>
  );
}

/* Steel toolbox, forest lid, charcoal body. */
export function Toolbox(props: AssetProps) {
  const id = useId();
  return (
    <svg viewBox="0 0 150 112" fill="none" {...props}>
      <defs>
        <linearGradient id={`${id}-lid`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#17493d" />
          <stop offset="1" stopColor="#0b2a23" />
        </linearGradient>
        <linearGradient id={`${id}-body`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3a3d3b" />
          <stop offset="1" stopColor="#171918" />
        </linearGradient>
      </defs>
      {/* handle */}
      <path d="M55 26 Q75 8 95 26" stroke="#171918" strokeWidth="7" strokeLinecap="round" fill="none" />
      <path d="M55 26 Q75 12 95 26" stroke="#5f6664" strokeWidth="2.4" strokeLinecap="round" fill="none" opacity="0.8" />
      {/* lid */}
      <path d="M18 40 Q18 32 26 32 L124 32 Q132 32 132 40 L132 54 L18 54 Z" fill={`url(#${id}-lid)`} />
      {/* body */}
      <rect x="14" y="54" width="122" height="42" rx="6" fill={`url(#${id}-body)`} />
      {/* latches */}
      <rect x="40" y="48" width="12" height="12" rx="2.5" fill="#D9913C" />
      <rect x="98" y="48" width="12" height="12" rx="2.5" fill="#D9913C" />
      {/* lid seam + label */}
      <path d="M18 54 H132" stroke="#0b2a23" strokeWidth="2" />
      <rect x="60" y="66" width="30" height="14" rx="3" fill="#123C32" />
      <path d="M65 76 L69 70 L73 76" stroke="#9DBDAF" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      {/* highlights */}
      <path d="M24 40 Q70 34 122 38" stroke="#2c6b58" strokeWidth="3" strokeLinecap="round" opacity="0.8" />
      <path d="M20 60 Q75 57 130 60" stroke="#5f6664" strokeWidth="2" strokeLinecap="round" opacity="0.6" />
    </svg>
  );
}

/* Long-handled spade — owner asked for it by name. */
export function Spade(props: AssetProps) {
  const id = useId();
  return (
    <svg viewBox="0 0 60 170" fill="none" {...props}>
      <defs>
        <linearGradient id={`${id}-blade`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#c8cccb" />
          <stop offset="0.5" stopColor="#9aa1a0" />
          <stop offset="1" stopColor="#6b706d" />
        </linearGradient>
        <linearGradient id={`${id}-wood`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#d9c5a0" />
          <stop offset="1" stopColor="#b39a71" />
        </linearGradient>
      </defs>
      {/* D-grip */}
      <path d="M22 8 H38 V30 H22 Z" fill="none" stroke={`url(#${id}-wood)`} strokeWidth="7" strokeLinejoin="round" />
      {/* shaft */}
      <rect x="26.5" y="28" width="7" height="86" rx="3" fill={`url(#${id}-wood)`} />
      <rect x="28" y="30" width="1.8" height="82" fill="#efe3cc" opacity="0.7" />
      {/* socket collar */}
      <rect x="24" y="112" width="12" height="8" rx="2" fill="#5f6664" />
      {/* blade */}
      <path d="M18 120 Q18 116 22 116 H38 Q42 116 42 120 L42 138 Q42 156 30 162 Q18 156 18 138 Z" fill={`url(#${id}-blade)`} />
      <path d="M18 128 H42" stroke="#6b706d" strokeWidth="2.4" />
      <path d="M23 122 Q22 138 26 152" stroke="#eef1f0" strokeWidth="3.4" strokeLinecap="round" opacity="0.75" />
    </svg>
  );
}

/* Site wheelbarrow, forest tray. */
export function Wheelbarrow(props: AssetProps) {
  const id = useId();
  return (
    <svg viewBox="0 0 160 120" fill="none" {...props}>
      <defs>
        <linearGradient id={`${id}-tray`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2c6b58" />
          <stop offset="1" stopColor="#123C32" />
        </linearGradient>
      </defs>
      {/* tray */}
      <path d="M18 30 L134 30 L118 74 Q116 80 108 80 L52 80 Q44 80 40 74 Z" fill={`url(#${id}-tray)`} />
      <path d="M24 36 H128" stroke="#9DBDAF" strokeWidth="2.4" opacity="0.65" />
      {/* aggregate heap */}
      <path d="M40 30 Q56 14 74 26 Q88 12 106 24 Q118 16 128 30 Z" fill="#b39a71" />
      <circle cx="60" cy="22" r="4.5" fill="#8f9694" />
      <circle cx="86" cy="18" r="5.5" fill="#9aa1a0" />
      <circle cx="110" cy="22" r="4" fill="#8f9694" />
      {/* legs + handles */}
      <path d="M50 80 L38 104 M108 80 L120 100" stroke="#5f6664" strokeWidth="5.5" strokeLinecap="round" />
      <path d="M112 34 L148 44" stroke="#b39a71" strokeWidth="6" strokeLinecap="round" />
      <path d="M144 40 L150 46" stroke="#8a734f" strokeWidth="6" strokeLinecap="round" />
      {/* wheel */}
      <circle cx="38" cy="96" r="14" fill="#171918" />
      <circle cx="38" cy="96" r="6" fill="#5f6664" />
      <circle cx="34" cy="92" r="2.2" fill="#c8cccb" />
    </svg>
  );
}

/* Flatbed delivery truck (orbit item). */
export function Truck(props: AssetProps) {
  const id = useId();
  return (
    <svg viewBox="0 0 160 100" fill="none" {...props}>
      <defs>
        <linearGradient id={`${id}-cab`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#e3a75f" />
          <stop offset="1" stopColor="#c68a2b" />
        </linearGradient>
      </defs>
      {/* bed + cargo */}
      <rect x="8" y="34" width="86" height="34" rx="4" fill="#171918" />
      <rect x="12" y="38" width="78" height="6" rx="3" fill="#3a3d3b" />
      <rect x="22" y="18" width="30" height="18" rx="3" fill="#d9c5a0" />
      <rect x="58" y="22" width="26" height="14" rx="2.5" fill="#b8643c" />
      {/* cab */}
      <path d="M96 68 L96 24 Q96 16 104 16 L122 16 Q128 16 131 22 L140 40 Q142 44 142 48 L142 68 Z" fill={`url(#${id}-cab)`} />
      <path d="M104 24 L118 24 L118 38 L100 38 Z" fill="#dfe9e4" />
      <path d="M122 26 L132 42 L122 42 Z" fill="#dfe9e4" opacity="0.9" />
      {/* chassis + wheels */}
      <rect x="8" y="66" width="134" height="8" rx="3" fill="#171918" />
      <circle cx="36" cy="78" r="12" fill="#171918" />
      <circle cx="36" cy="78" r="5" fill="#8f9694" />
      <circle cx="120" cy="78" r="12" fill="#171918" />
      <circle cx="120" cy="78" r="5" fill="#8f9694" />
      <rect x="138" y="52" width="5" height="7" rx="2" fill="#f7e9d6" />
    </svg>
  );
}

/* Project document card (orbit item). */
export function DocCard(props: AssetProps) {
  const id = useId();
  return (
    <svg viewBox="0 0 90 112" fill="none" {...props}>
      <defs>
        <linearGradient id={`${id}-p`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#e9edf2" />
        </linearGradient>
      </defs>
      <rect x="6" y="4" width="78" height="102" rx="7" fill={`url(#${id}-p)`} stroke="#c9d1d8" strokeWidth="1.4" />
      <rect x="16" y="14" width="34" height="8" rx="3" fill="#123C32" />
      <path d="M16 32 H74 M16 42 H64 M16 52 H74 M16 62 H54" stroke="#aeb6bd" strokeWidth="2.2" strokeLinecap="round" />
      {/* verified tick */}
      <circle cx="26" cy="84" r="11" fill="#2F7D52" />
      <path d="M20.5 84 L24.5 88 L32 79.5" stroke="#ffffff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <path d="M44 82 H70 M44 90 H62" stroke="#c9d1d8" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

/* Payment card (orbit item). */
export function PayCard(props: AssetProps) {
  const id = useId();
  return (
    <svg viewBox="0 0 112 74" fill="none" {...props}>
      <defs>
        <linearGradient id={`${id}-c`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#17493d" />
          <stop offset="1" stopColor="#06231c" />
        </linearGradient>
      </defs>
      <rect x="4" y="4" width="104" height="66" rx="8" fill={`url(#${id}-c)`} />
      <rect x="4" y="20" width="104" height="12" fill="#0b2a23" />
      <rect x="16" y="34" width="22" height="16" rx="3.5" fill="#D9913C" />
      <path d="M50 40 H92 M50 48 H76" stroke="#9DBDAF" strokeWidth="2.4" strokeLinecap="round" opacity="0.85" />
      <circle cx="92" cy="56" r="6" fill="#2F7D52" opacity="0.95" />
      <path d="M89.4 56 L91.4 58 L95 53.6" stroke="#ffffff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <rect x="16" y="12" width="30" height="5" rx="2.5" fill="#9DBDAF" opacity="0.5" />
    </svg>
  );
}

/* Soft ground shadow used under every floating object. */
export function GroundShadow(props: AssetProps) {
  return (
    <svg viewBox="0 0 120 24" fill="none" aria-hidden {...props}>
      <ellipse cx="60" cy="12" rx="52" ry="8" fill="#171918" opacity="0.10" />
      <ellipse cx="60" cy="12" rx="34" ry="5.5" fill="#171918" opacity="0.08" />
    </svg>
  );
}
