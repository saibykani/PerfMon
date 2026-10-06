import { useId } from 'react';

/** Perfmon mark: gradient tile with a performance waveform. `animated` draws the line in. */
export function LogoMark({ size = 28, animated = false }: { size?: number; animated?: boolean }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className={animated ? 'logo-anim' : undefined}>
      <defs>
        <linearGradient id={`g${id}`} x1="6" y1="4" x2="60" y2="62" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#8b5cf6" /><stop offset="0.5" stopColor="#3b82f6" /><stop offset="1" stopColor="#14b8a6" />
        </linearGradient>
        <linearGradient id={`s${id}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff" stopOpacity=".35" /><stop offset="1" stopColor="#fff" stopOpacity="0" /></linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="16" fill={`url(#g${id})`} />
      <rect x="2" y="2" width="60" height="30" rx="16" fill={`url(#s${id})`} />
      <path className="logo-wave" d="M12 38h9l5-14 7 22 6-17 4 9h9" fill="none" stroke="#fff" strokeWidth="4.2" strokeLinecap="round" strokeLinejoin="round" />
      <circle className="logo-dot" cx="52" cy="38" r="3.6" fill="#fff" />
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
