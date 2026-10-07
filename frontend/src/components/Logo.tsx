import { useId } from 'react';

/**
 * Perfmon mark: a "P" monogram whose bowl carries a heartbeat pulse, drawn with an
 * aurora gradient on an ink tile. `animated` traces the pulse and breathes the spark.
 */
export function LogoMark({ size = 28, animated = false }: { size?: number; animated?: boolean }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className={animated ? 'logo-anim' : undefined}>
      <defs>
        <linearGradient id={`a${id}`} x1="10" y1="8" x2="56" y2="58" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#a78bfa" /><stop offset=".45" stopColor="#38bdf8" /><stop offset="1" stopColor="#a3e635" />
        </linearGradient>
        <linearGradient id={`b${id}`} x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#8b5cf6" stopOpacity=".9" /><stop offset=".5" stopColor="#0ea5e9" stopOpacity=".35" /><stop offset="1" stopColor="#84cc16" stopOpacity=".8" />
        </linearGradient>
        <radialGradient id={`g${id}`} cx="44" cy="20" r="34" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#6366f1" stopOpacity=".38" /><stop offset="1" stopColor="#6366f1" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect x="1.5" y="1.5" width="61" height="61" rx="17" fill="#0a0a12" />
      <rect x="1.5" y="1.5" width="61" height="61" rx="17" fill={`url(#g${id})`} />
      <rect x="2.25" y="2.25" width="59.5" height="59.5" rx="16.4" fill="none" stroke={`url(#b${id})`} strokeWidth="1.5" />
      {/* P: stem + bowl */}
      <path d="M20 50V16h14.5a12.5 12.5 0 0 1 0 25H27" fill="none" stroke={`url(#a${id})`} strokeWidth="5.2" strokeLinecap="round" strokeLinejoin="round" />
      {/* pulse running through the bowl */}
      <path className="logo-wave" d="M20 29.5h6.5l3-6.5 4.5 13 3-6.5h4.5" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <circle className="logo-dot" cx="47" cy="29.5" r="2.9" fill="#d9f99d" />
    </svg>
  );
}

export function Logo({ size = 28, animated = false, tagline = true }: { size?: number; animated?: boolean; tagline?: boolean }) {
  return (
    <div className="logo">
      <LogoMark size={size} animated={animated} />
      <div>
        <div className="logo-word">Perf<span>mon</span></div>
        {tagline && <div className="logo-tag">Performance Engineering · Observability · Intelligence</div>}
      </div>
    </div>
  );
}
