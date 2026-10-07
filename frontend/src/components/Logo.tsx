import { useId } from 'react';

/**
 * Perfmon brand mark (rose-gold "P": ascending bars form the stem, a folded ribbon forms the bowl).
 * Source artwork: /brand/perfmon-logo-original.png · vector: /brand/perfmon-mark.svg.
 * `animated` grows the bars and sweeps a light across the ribbon.
 */
export function LogoMark({ size = 28, animated = false }: { size?: number; animated?: boolean }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="28.5 9 320 320" aria-hidden="true" className={animated ? 'logo-anim' : undefined}>
      <defs>
        <linearGradient id={`b${id}`} x1="90" y1="28" x2="330" y2="250" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fde6da" /><stop offset=".3" stopColor="#f0b9a6" /><stop offset=".65" stopColor="#dc907e" /><stop offset="1" stopColor="#f3c7b6" />
        </linearGradient>
        <linearGradient id={`f${id}`} x1="262" y1="95" x2="330" y2="210" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#8f4a43" stopOpacity=".6" /><stop offset=".6" stopColor="#8f4a43" stopOpacity=".15" /><stop offset="1" stopColor="#8f4a43" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={`v${id}`} x1="0" y1="130" x2="0" y2="310" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#f6cbbb" /><stop offset=".5" stopColor="#e5a08e" /><stop offset="1" stopColor="#cf8576" />
        </linearGradient>
        <linearGradient id={`s${id}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="0" /><stop offset=".5" stopColor="#fff" stopOpacity=".55" /><stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <clipPath id={`c${id}`}>
          <path d="M35 242Q57 231 80 226V310H35ZM108 197Q134 184 160 179V310H108ZM180 151Q206 137 232 131V310H180ZM90 28H262C310 28 342 70 342 135C342 205 305 258 258 258V195C278 192 288 170 288 145C288 115 278 95 262 95H160Z" />
        </clipPath>
      </defs>
      <g className="logo-bars" fill={`url(#v${id})`}>
        <path className="logo-bar b1" d="M35 242Q57 231 80 226V310H35Z" />
        <path className="logo-bar b2" d="M108 197Q134 184 160 179V310H108Z" />
        <path className="logo-bar b3" d="M180 151Q206 137 232 131V310H180Z" />
      </g>
      <path className="logo-ribbon" d="M90 28H262C310 28 342 70 342 135C342 205 305 258 258 258V195C278 192 288 170 288 145C288 115 278 95 262 95H160Z" fill={`url(#b${id})`} />
      <path d="M262 95C278 95 288 115 288 145C288 170 278 192 258 195V258C287 250 316 220 322 170C300 185 300 120 262 95Z" fill={`url(#f${id})`} />
      {animated && <g clipPath={`url(#c${id})`}><rect className="logo-sheen" x="-60" y="0" width="70" height="340" fill={`url(#s${id})`} transform="skewX(-18)" /></g>}
    </svg>
  );
}

export function Logo({ size = 28, animated = false, tagline = true }: { size?: number; animated?: boolean; tagline?: boolean }) {
  return (
    <div className="logo">
      <LogoMark size={size} animated={animated} />
      <div>
        <div className="logo-word">Perf<span>mon</span></div>
        {tagline && <div className="logo-tag">Performance Engineering</div>}
      </div>
    </div>
  );
}
