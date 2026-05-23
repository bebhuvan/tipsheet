// Build-time icon PNG generator. Renders a high-resolution version of the
// favicon SVG to PNG for Apple touch / Android home-screen / PWA icons.

import { Resvg } from '@resvg/resvg-js';

// Light-mode variant for raster icons. The PNG is rendered once at build, so we
// don't carry the prefers-color-scheme media query — we render the light version
// (brick triangle, black sheet) which reads well on both light and dark home screens.
export function iconSvg({ size = 512, withBackground = true } = {}) {
  // Scale our 32-unit design space up to `size`. Keep proportions identical
  // to the SVG favicon so the marks visually match across surfaces.
  const s = size / 32;
  const bg = withBackground ? `<rect width="${size}" height="${size}" fill="#ffffff"/>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  ${bg}
  <path d="M ${16*s} ${7*s} L ${22.5*s} ${18*s} L ${9.5*s} ${18*s} Z" fill="#b5341e"/>
  <rect x="${6*s}" y="${22*s}" width="${20*s}" height="${2*s}" fill="#111111"/>
</svg>`;
}

export function renderIconPng(size) {
  const svg = iconSvg({ size, withBackground: true });
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: size },
    background: 'white',
  });
  return resvg.render().asPng();
}
