"use client";

import { useId, type SVGProps } from "react";
import { motion, type Transition } from "framer-motion";

/**
 * Miniature construction site assets for the animated hero (issue #402):
 * staged building, tower crane, evidence phone, progress ring.
 *
 * Stage animations are transform/opacity-only and spring into place
 * ("snap"), driven by the `stage` prop (0 = nothing built … 4 = complete).
 * The phone's verification story is prop-driven so the orchestrator times
 * it: a human review tick appears BEFORE the status flips to Verified —
 * the sequence must never imply automatic AI approval of work or money.
 */

const snap: Transition = { type: "spring", stiffness: 210, damping: 17, mass: 0.9 };
const rise: Transition = { type: "spring", stiffness: 120, damping: 16 };

export type BuildStage = 0 | 1 | 2 | 3 | 4;

export function MiniBuilding({ stage, ...props }: { stage: BuildStage } & SVGProps<SVGSVGElement>) {
  const id = useId();
  return (
    <svg viewBox="0 0 260 240" fill="none" {...props}>
      <defs>
        <linearGradient id={`${id}-wall`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f6f4ef" />
          <stop offset="1" stopColor="#dcd7cb" />
        </linearGradient>
        <linearGradient id={`${id}-slab`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#c8cccb" />
          <stop offset="1" stopColor="#8f9694" />
        </linearGradient>
      </defs>

      {/* ── Stage 1 · foundation ── */}
      <motion.g
        initial={false}
        animate={stage >= 1 ? { opacity: 1, y: 0, scale: 1 } : { opacity: 0, y: 14, scale: 0.92 }}
        transition={snap}
        style={{ transformOrigin: "130px 210px" }}
      >
        <rect x="34" y="200" width="192" height="16" rx="3" fill={`url(#${id}-slab)`} />
        <rect x="42" y="188" width="176" height="12" rx="2.5" fill="#b39a71" opacity="0.9" />
        <g stroke="#8a734f" strokeWidth="2" opacity="0.55">
          <path d="M56 188 V200 M86 188 V200 M116 188 V200 M146 188 V200 M176 188 V200 M204 188 V200" />
        </g>
      </motion.g>

      {/* ── Stage 2 · structural columns ── */}
      <motion.g
        initial={false}
        animate={stage >= 2 ? { opacity: 1, y: 0, scaleY: 1 } : { opacity: 0, y: 26, scaleY: 0.3 }}
        transition={rise}
        style={{ transformOrigin: "130px 200px" }}
      >
        {[52, 100, 148, 196].map((x) => (
          <g key={x}>
            <rect x={x} y="96" width="12" height="96" rx="2" fill="#8f9694" />
            <rect x={x} y="96" width="4" height="96" fill="#c8cccb" opacity="0.8" />
          </g>
        ))}
        <rect x="40" y="146" width="180" height="10" rx="2.5" fill={`url(#${id}-slab)`} />
        <rect x="46" y="96" width="168" height="9" rx="2.5" fill={`url(#${id}-slab)`} />
      </motion.g>

      {/* ── Stage 3 · walls ── */}
      <motion.g
        initial={false}
        animate={stage >= 3 ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
        transition={rise}
        style={{ transformOrigin: "130px 200px" }}
      >
        <rect x="66" y="108" width="30" height="36" rx="2" fill={`url(#${id}-wall)`} />
        <rect x="114" y="108" width="30" height="36" rx="2" fill={`url(#${id}-wall)`} />
        <rect x="162" y="108" width="30" height="36" rx="2" fill={`url(#${id}-wall)`} />
        <rect x="66" y="158" width="30" height="38" rx="2" fill={`url(#${id}-wall)`} />
        <rect x="114" y="158" width="30" height="38" rx="2" fill={`url(#${id}-wall)`} />
        <rect x="162" y="158" width="30" height="38" rx="2" fill={`url(#${id}-wall)`} />
        <rect x="66" y="62" width="30" height="30" rx="2" fill={`url(#${id}-wall)`} />
        <rect x="114" y="62" width="30" height="30" rx="2" fill={`url(#${id}-wall)`} />
        <rect x="162" y="62" width="30" height="30" rx="2" fill={`url(#${id}-wall)`} />
      </motion.g>

      {/* ── Stage 4 · windows + roof ── */}
      <motion.g
        initial={false}
        animate={stage >= 4 ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.85 }}
        transition={snap}
        style={{ transformOrigin: "130px 90px" }}
      >
        {/* windows — two rows of three */}
        {[
          [72, 114], [120, 114], [168, 114],
          [72, 164], [120, 164], [168, 164],
        ].map(([x, y], i) => (
          <g key={i}>
            <rect x={x} y={y} width="18" height="22" rx="2" fill="#123C32" />
            <rect x={x + 2.5} y={y + 2.5} width="13" height="8" rx="1.5" fill="#9DBDAF" opacity="0.85" />
            <path d={`M${x + 9} ${y + 2.5} V21.5 M${x + 2.5} ${y + 11} H15.5`} stroke="#0b2a23" strokeWidth="1.4" opacity="0.9" />
          </g>
        ))}
        {/* top-row windows on upper slab */}
        {[[72, 68], [120, 68], [168, 68]].map(([x, y], i) => (
          <rect key={i} x={x} y={y} width="18" height="18" rx="2" fill="#123C32" opacity="0.92" />
        ))}
        {/* roof slab + parapet */}
        <rect x="42" y="50" width="176" height="12" rx="3" fill={`url(#${id}-slab)`} />
        <rect x="48" y="42" width="164" height="8" rx="3" fill="#7d8482" />
      </motion.g>

      {/* door — always on once walls exist */}
      <motion.g initial={false} animate={stage >= 3 ? { opacity: 1 } : { opacity: 0 }} transition={rise}>
        <rect x="128" y="180" width="18" height="16" rx="2" fill="#b39a71" />
        <circle cx="143" cy="188" r="1.4" fill="#171918" />
      </motion.g>
    </svg>
  );
}

/* Tower crane behind the finished site (final frame dressing). */
export function Crane(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 200 260" fill="none" {...props}>
      {/* mast */}
      <rect x="92" y="60" width="10" height="192" fill="#c68a2b" />
      <path d="M92 84 H102 M92 116 H102 M92 148 H102 M92 180 H102 M92 212 H102" stroke="#a5681f" strokeWidth="2" />
      <path d="M92 84 L102 116 M102 84 L92 116 M92 148 L102 180 M102 148 L92 180" stroke="#a5681f" strokeWidth="1.6" opacity="0.7" />
      {/* jib */}
      <path d="M60 60 L182 60" stroke="#c68a2b" strokeWidth="7" strokeLinecap="round" />
      <path d="M97 60 L60 34 M97 60 L182 34" stroke="#c68a2b" strokeWidth="3.4" strokeLinecap="round" />
      <path d="M60 34 H182" stroke="#c68a2b" strokeWidth="3.4" strokeLinecap="round" />
      {/* counter-jib + weight */}
      <rect x="66" y="52" width="18" height="12" rx="2" fill="#8f9694" />
      {/* trolley + hook line */}
      <rect x="150" y="58" width="10" height="6" rx="1.5" fill="#5f6664" />
      <path d="M155 64 V128" stroke="#5f6664" strokeWidth="2" />
      <rect x="149" y="128" width="12" height="8" rx="2" fill="#5f6664" />
      {/* cab */}
      <rect x="84" y="52" width="26" height="16" rx="3" fill="#D9913C" />
      <rect x="88" y="55" width="9" height="7" rx="1.5" fill="#dfe9e4" />
      {/* beacon */}
      <circle cx="97" cy="34" r="3" fill="#b94a48" />
    </svg>
  );
}

/* Progress ring that completes around the site (scene 5). */
export function ProgressRing({ progress = 1, ...props }: { progress?: number } & SVGProps<SVGSVGElement>) {
  const R = 118;
  const C = 2 * Math.PI * R;
  return (
    <svg viewBox="0 0 260 260" fill="none" {...props}>
      <circle cx="130" cy="130" r={R} stroke="#123C32" strokeOpacity="0.14" strokeWidth="5" />
      <motion.circle
        cx="130"
        cy="130"
        r={R}
        stroke="#2F7D52"
        strokeWidth="5"
        strokeLinecap="round"
        strokeDasharray={C}
        initial={{ strokeDashoffset: C }}
        animate={{ strokeDashoffset: C * (1 - progress) }}
        transition={{ duration: 1.6, ease: [0.16, 1, 0.3, 1] }}
        transform="rotate(-90 130 130)"
      />
      <circle cx="130" cy="12" r="4.5" fill="#2F7D52" stroke="#F3F2EE" strokeWidth="2" />
    </svg>
  );
}

/* Evidence phone with the verification story (human-review-first). */
export function PhoneDashboard({
  reviewed = false,
  verified = false,
  deliveryVerified = false,
  ...props
}: {
  reviewed?: boolean;
  verified?: boolean;
  deliveryVerified?: boolean;
} & SVGProps<SVGSVGElement>) {
  const id = useId();
  return (
    <svg viewBox="0 0 190 380" fill="none" {...props}>
      <defs>
        <linearGradient id={`${id}-screen`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#eef1f0" />
        </linearGradient>
        <linearGradient id={`${id}-photo`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#dce7e0" />
          <stop offset="1" stopColor="#9DBDAF" />
        </linearGradient>
      </defs>
      {/* body */}
      <rect x="3" y="3" width="184" height="374" rx="30" fill="#171918" />
      <rect x="9" y="9" width="172" height="362" rx="25" fill={`url(#${id}-screen)`} />
      {/* notch */}
      <rect x="72" y="16" width="46" height="12" rx="6" fill="#171918" />
      {/* app header */}
      <circle cx="30" cy="48" r="9" fill="#123C32" />
      <path d="M26 52 L26 44 L30 47 L34 44 L34 52" stroke="#F3F2EE" strokeWidth="1.7" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <text x="46" y="46" fontSize="12.5" fontWeight="700" fill="#171918" fontFamily="inherit">MjengoOS</text>
      <text x="46" y="58" fontSize="8.5" fill="#6b706d" fontFamily="inherit">Project Dashboard</text>
      <path d="M18 68 H172" stroke="#dce7e0" strokeWidth="1.4" />
      {/* progress card */}
      <text x="20" y="88" fontSize="9" fontWeight="600" fill="#3a3d3b" fontFamily="inherit">Greenview Apartments</text>
      <text x="170" y="88" fontSize="8.5" fontWeight="700" textAnchor="end" fill="#123C32" fontFamily="inherit">68%</text>
      <rect x="20" y="94" width="150" height="6" rx="3" fill="#dce7e0" />
      <motion.rect
        x="20" y="94" width="102" height="6" rx="3" fill="#2F7D52"
        initial={false}
        animate={{ width: verified ? 102 : 88 }}
        transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
      />
      {/* site evidence photo */}
      <text x="20" y="122" fontSize="8.5" fontWeight="600" fill="#3a3d3b" fontFamily="inherit">Site Evidence</text>
      <rect x="20" y="128" width="150" height="74" rx="7" fill={`url(#${id}-photo)`} />
      {/* tiny building inside the photo */}
      <g opacity="0.85">
        <rect x="52" y="152" width="34" height="40" rx="2" fill="#123C32" opacity="0.85" />
        {[0, 1, 2].map((r) =>
          [0, 1, 2].map((c) => (
            <rect key={`${r}${c}`} x={57 + c * 10} y={157 + r * 12} width="6" height="7" fill="#9DBDAF" opacity="0.9" />
          )),
        )}
        <path d="M108 192 V162 L122 154 L136 162 V192 Z" fill="#e3a75f" opacity="0.9" />
        <path d="M96 192 H158" stroke="#2c6b58" strokeWidth="3" strokeLinecap="round" />
      </g>
      {/* GPS + time chip */}
      <rect x="28" y="188" width="64" height="9" rx="4.5" fill="#171918" opacity="0.55" />
      <circle cx="34" cy="192.5" r="2" fill="#9DBDAF" />
      {/* review → verified chip row */}
      <g>
        <rect x="20" y="212" width="70" height="18" rx="9" fill={verified ? "#e4f0e9" : "#f7eedc"} />
        <circle cx="30" cy="221" r="4.2" fill={verified ? "#2F7D52" : "#c68a2b"} />
        {verified ? (
          <path d="M28 221 L29.6 222.6 L32.4 219.4" stroke="#ffffff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        ) : (
          <circle cx="30" cy="221" r="1.6" fill="#ffffff" />
        )}
        <motion.text
          x="38" y="224.5" fontSize="8" fontWeight="700" fontFamily="inherit"
          initial={false}
          animate={{ fill: verified ? "#2F7D52" : "#a5681f" }}
        >
          {verified ? "Verified" : "Reported"}
        </motion.text>
        {/* human review tick appears BEFORE verification */}
        <motion.g
          initial={false}
          animate={{ opacity: reviewed && !verified ? 1 : 0, x: reviewed ? 0 : -6 }}
          transition={{ duration: 0.4 }}
        >
          <rect x="94" y="212" width="76" height="18" rx="9" fill="#eef3f0" />
          <circle cx="104" cy="221" r="4.2" fill="#123C32" />
          <path d="M102.2 221 L103.6 222.4 L106.2 219.4" stroke="#F3F2EE" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          <text x="112" y="224.5" fontSize="7.5" fontWeight="600" fill="#123C32" fontFamily="inherit">Reviewed · Eng.</text>
        </motion.g>
      </g>
      {/* delivery card */}
      <rect x="20" y="242" width="150" height="58" rx="9" fill="#ffffff" stroke="#dce7e0" strokeWidth="1.4" />
      <rect x="20" y="242" width="150" height="58" rx="9" fill={deliveryVerified ? "#e4f0e9" : "#ffffff"} opacity={deliveryVerified ? 0.45 : 0} />
      <circle cx="38" cy="264" r="9" fill={deliveryVerified ? "#2F7D52" : "#f7eedc"} />
      <TruckMini x={31} y={257} color={deliveryVerified ? "#ffffff" : "#c68a2b"} />
      <text x="54" y="261" fontSize="9" fontWeight="700" fill="#171918" fontFamily="inherit">
        {deliveryVerified ? "Delivery verified" : "Delivery received"}
      </text>
      <motion.text
        x="54" y="274" fontSize="8" fontFamily="inherit"
        initial={false}
        animate={{ fill: deliveryVerified ? "#2F7D52" : "#a5681f" }}
      >
        {deliveryVerified ? "Checked against order · Paid" : "Verification pending"}
      </motion.text>
      <path d="M54 282 H140" stroke="#eef1f0" strokeWidth="1.6" />
      <rect x="54" y="287" width="56" height="5" rx="2.5" fill="#eef1f0" />
      {/* home bar */}
      <rect x="72" y="356" width="46" height="4" rx="2" fill="#9a9e9b" opacity="0.6" />
    </svg>
  );
}

/* 12px truck glyph for the delivery card. */
function TruckMini({ x, y, color }: { x: number; y: number; color: string }) {
  return (
    <g transform={`translate(${x} ${y})`} fill={color}>
      <rect x="0" y="2" width="9" height="6" rx="1" />
      <path d="M9 3 H13 L15 5.5 V8 H9 Z" />
      <circle cx="3.4" cy="8.6" r="1.7" />
      <circle cx="11.6" cy="8.6" r="1.7" />
    </g>
  );
}
