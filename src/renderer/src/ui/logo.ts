// The Espionage mark (incognito agent on the phone) as inline SVG, so it renders
// crisply at any size in the login screen and header without an asset request.
export function logoSvg(size = 32): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <defs>
      <linearGradient id="lg-bg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#1e293b"/><stop offset="1" stop-color="#0b1220"/>
      </linearGradient>
    </defs>
    <rect width="512" height="512" rx="112" fill="url(#lg-bg)"/>
    <path d="M84 470 C84 388 156 342 256 342 C356 342 428 388 428 470 L428 512 L84 512 Z" fill="#c9a26b"/>
    <path d="M256 352 L212 512 L256 512 Z" fill="#a9814d"/>
    <path d="M256 352 L300 512 L256 512 Z" fill="#b58f57"/>
    <path d="M188 360 L256 344 L256 300 L206 322 Z" fill="#8f6c3e"/>
    <path d="M324 360 L256 344 L256 300 L306 322 Z" fill="#8f6c3e"/>
    <rect x="232" y="300" width="48" height="52" rx="14" fill="#e0b389"/>
    <circle cx="184" cy="250" r="17" fill="#e8bd93"/>
    <circle cx="328" cy="250" r="17" fill="#e8bd93"/>
    <circle cx="256" cy="248" r="78" fill="#f0c8a0"/>
    <g fill="#0f172a">
      <rect x="192" y="228" width="54" height="34" rx="15"/>
      <rect x="266" y="228" width="54" height="34" rx="15"/>
      <rect x="244" y="238" width="24" height="9" rx="4"/>
      <rect x="316" y="236" width="24" height="8" rx="4"/>
    </g>
    <ellipse cx="256" cy="196" rx="140" ry="32" fill="#111827"/>
    <path d="M186 188 C186 120 214 96 256 96 C298 96 326 120 326 188 Z" fill="#1f2937"/>
    <rect x="186" y="170" width="140" height="20" rx="6" fill="#0ea5e9"/>
    <path d="M176 250 C150 288 150 322 190 348" fill="none" stroke="#38bdf8" stroke-width="26" stroke-linecap="round"/>
    <circle cx="176" cy="246" r="24" fill="#7dd3fc"/>
    <circle cx="196" cy="346" r="22" fill="#0ea5e9"/>
  </svg>`
}
