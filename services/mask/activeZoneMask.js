// Haircut State Lab — active-zone mask rasterization.
//
// Turns the planner's activeZonePolygon (fraction coordinates, 0-1) into a
// grayscale PNG mask at the source image's pixel dimensions: white = region
// to remove/edit, black = region to preserve. This matches FLUX Fill's mask
// convention (see services/haircutState — mask semantics are being kept
// consistent across providers even though flux2-edit's own mask support is
// still an unresolved spike).
//
// Pure code, no AI call, no added cost. Uses sharp's built-in SVG rasterizer
// (librsvg) rather than a new canvas dependency — sharp is already a
// dependency of this project.
const sharp = require('sharp');

function buildActiveZoneMaskSvg(polygonFracs, widthPx, heightPx) {
  const points = polygonFracs
    .map(p => `${(p.x * widthPx).toFixed(2)},${(p.y * heightPx).toFixed(2)}`)
    .join(' ');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${heightPx}">
    <rect x="0" y="0" width="${widthPx}" height="${heightPx}" fill="black" />
    <polygon points="${points}" fill="white" />
  </svg>`;
}

async function buildActiveZoneMask(polygonFracs, widthPx, heightPx) {
  if (!Array.isArray(polygonFracs) || polygonFracs.length < 3) {
    throw new Error('MASK_POLYGON_INVALID: activeZonePolygon needs at least 3 points');
  }
  if (!widthPx || !heightPx || widthPx <= 0 || heightPx <= 0) {
    throw new Error('MASK_DIMENSIONS_INVALID: widthPx/heightPx must be positive');
  }
  const svg = buildActiveZoneMaskSvg(polygonFracs, widthPx, heightPx);
  return sharp(Buffer.from(svg)).png().toBuffer();
}

module.exports = { buildActiveZoneMask };
