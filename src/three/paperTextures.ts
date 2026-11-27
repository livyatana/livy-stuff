import * as THREE from 'three';
import type { MovieRecord } from '../types/movie';

const POSTER_PALETTES = [
  ['#5A5854', '#ABA396'],
  ['#615753', '#A99282'],
  ['#535B57', '#8F9B93'],
  ['#5E564F', '#AA9B86'],
  ['#535961', '#9099A3'],
  ['#615553', '#AA8B7F'],
  ['#555D56', '#98A08D'],
  ['#5A565D', '#A09792'],
];

function hashString(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function hash2D(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041);
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function periodicNoise(u: number, v: number, freq: number, seed: number): number {
  const x = u * freq;
  const y = v * freq;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);

  const ix0 = ((ix % freq) + freq) % freq;
  const iy0 = ((iy % freq) + freq) % freq;
  const ix1 = (ix0 + 1) % freq;
  const iy1 = (iy0 + 1) % freq;

  const n00 = hash2D(ix0, iy0, seed);
  const n10 = hash2D(ix1, iy0, seed);
  const n01 = hash2D(ix0, iy1, seed);
  const n11 = hash2D(ix1, iy1, seed);

  const nx0 = n00 + sx * (n10 - n00);
  const nx1 = n01 + sx * (n11 - n01);
  return nx0 + sy * (nx1 - nx0);
}

let cachedPaperHeights: Float32Array | null = null;
let cachedBlotchField: Float32Array | null = null;
const PAPER_TEX_SIZE = 256;

function ensurePaperField(): { heights: Float32Array; blotches: Float32Array } {
  if (cachedPaperHeights && cachedBlotchField) {
    return { heights: cachedPaperHeights, blotches: cachedBlotchField };
  }

  const size = PAPER_TEX_SIZE;
  const heights = new Float32Array(size * size);
  const blotches = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const idx = y * size + x;
      const coarse = periodicNoise(u, v, 6, 11);
      const mid = periodicNoise(u, v, 20, 37);
      const fine = hash2D(x, y, 91);
      heights[idx] = coarse * 0.35 + mid * 0.35 + fine * 0.30;

      // Soft paper aging blotches
      const b1 = periodicNoise(u, v, 3, 211);
      const b2 = periodicNoise(u, v, 7, 241);
      blotches[idx] = b1 * 0.6 + b2 * 0.4;
    }
  }

  // Cellulose paper fibres across the sheet
  const fiberCount = 320;
  for (let f = 0; f < fiberCount; f++) {
    const startX = hash2D(f, 1, 503) * size;
    const startY = hash2D(f, 2, 509) * size;
    const angle = hash2D(f, 3, 521) * Math.PI * 2;
    const len = 7 + hash2D(f, 4, 541) * 20;
    const sign = hash2D(f, 5, 547) > 0.45 ? 0.14 : -0.11;

    for (let s = 0; s <= len; s += 1) {
      const px = ((Math.round(startX + Math.cos(angle) * s) % size) + size) % size;
      const py = ((Math.round(startY + Math.sin(angle) * s) % size) + size) % size;
      const taper = Math.sin((s / len) * Math.PI);
      heights[py * size + px] = Math.max(0, Math.min(1, heights[py * size + px] + sign * taper));
    }
  }

  cachedPaperHeights = heights;
  cachedBlotchField = blotches;
  return { heights, blotches };
}

/**
 * Generates a tileable crumpled-paper normal map with sharp crease lines,
 * faceted wrinkles, and paper fibre grain (for normalScale ~1.0).
 */
export function createPaperNormalTexture(): THREE.DataTexture {
  const { heights } = ensurePaperField();
  const size = 512;
  const crumpled = new Float32Array(size * size);

  // Build toroidal Voronoi cells to produce sharp polygonal fold creases & tilted facets
  const buildVoronoiCells = (count: number, seedBase: number) => {
    const pts = new Array<{ x: number; y: number; tiltX: number; tiltY: number; bias: number }>(
      count,
    );
    for (let i = 0; i < count; i++) {
      pts[i] = {
        x: hash2D(i, 0, seedBase),
        y: hash2D(i, 1, seedBase),
        tiltX: (hash2D(i, 2, seedBase) - 0.5) * 0.45,
        tiltY: (hash2D(i, 3, seedBase) - 0.5) * 0.45,
        bias: (hash2D(i, 4, seedBase) - 0.5) * 0.06,
      };
    }
    return pts;
  };

  const primaryFolds = buildVoronoiCells(26, 701);
  const secondaryWrinkles = buildVoronoiCells(64, 919);

  const sampleCreaseHeight = (
    u: number,
    v: number,
    cells: { x: number; y: number; tiltX: number; tiltY: number; bias: number }[],
    creaseSharpness: number,
  ): number => {
    let d1 = 1e9;
    let d2 = 1e9;
    let bestDx = 0;
    let bestDy = 0;
    let bestIdx = 0;

    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      let dx = u - c.x;
      let dy = v - c.y;
      if (dx > 0.5) dx -= 1;
      else if (dx < -0.5) dx += 1;
      if (dy > 0.5) dy -= 1;
      else if (dy < -0.5) dy += 1;

      const dist = Math.hypot(dx, dy);
      if (dist < d1) {
        d2 = d1;
        d1 = dist;
        bestDx = dx;
        bestDy = dy;
        bestIdx = i;
      } else if (dist < d2) {
        d2 = dist;
      }
    }

    const edgeGap = d2 - d1;
    // Sharp V-ridge/valley along fold boundaries + planar facet tilt
    const ridge = Math.exp(-edgeGap * creaseSharpness);
    const cell = cells[bestIdx];
    const facet = cell.bias + bestDx * cell.tiltX + bestDy * cell.tiltY;
    const flip = (bestIdx & 1) === 0 ? 1 : -1;
    return facet + ridge * 0.28 * flip;
  };

  for (let y = 0; y < size; y++) {
    const v = y / size;
    const py = y % PAPER_TEX_SIZE;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const px = x % PAPER_TEX_SIZE;

      const major = sampleCreaseHeight(u, v, primaryFolds, 34.0);
      const minor = sampleCreaseHeight(u, v, secondaryWrinkles, 52.0);
      const fibre = (heights[py * PAPER_TEX_SIZE + px] - 0.5) * 0.14;
      crumpled[y * size + x] = major * 0.65 + minor * 0.32 + fibre;
    }
  }

  const data = new Uint8Array(size * size * 4);
  const strength = 5.4;

  for (let y = 0; y < size; y++) {
    const ym = (y - 1 + size) % size;
    const yp = (y + 1) % size;
    for (let x = 0; x < size; x++) {
      const xm = (x - 1 + size) % size;
      const xp = (x + 1) % size;

      const dX = (crumpled[y * size + xp] - crumpled[y * size + xm]) * strength;
      const dY = (crumpled[yp * size + x] - crumpled[ym * size + x]) * strength;

      const nx = -dX;
      const ny = -dY;
      const nz = 1.0;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);

      const idx = (y * size + x) * 4;
      data[idx] = Math.round(((nx / len) * 0.5 + 0.5) * 255);
      data[idx + 1] = Math.round(((ny / len) * 0.5 + 0.5) * 255);
      data[idx + 2] = Math.round(((nz / len) * 0.5 + 0.5) * 255);
      data[idx + 3] = 255;
    }
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

export function createPaperRoughnessTexture(): THREE.DataTexture {
  const { heights } = ensurePaperField();
  const size = PAPER_TEX_SIZE;
  const data = new Uint8Array(size * size * 4);

  for (let i = 0; i < size * size; i++) {
    const r = Math.round(234 + heights[i] * 21); // 0.92 .. 1.0 matte roughness
    data[i * 4] = r;
    data[i * 4 + 1] = r;
    data[i * 4 + 2] = r;
    data[i * 4 + 3] = 255;
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

function drawStylizedFallbackPoster(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  movie: MovieRecord,
): void {
  const hash = hashString(`${movie.title}_${movie.year}`);
  const [bg, accent] = POSTER_PALETTES[hash % POSTER_PALETTES.length];

  const grad = ctx.createLinearGradient(x, y, x, y + h);
  grad.addColorStop(0, bg);
  grad.addColorStop(1, '#3B3833');
  ctx.fillStyle = grad;
  ctx.fillRect(x, y, w, h);

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();

  ctx.strokeStyle = accent;
  ctx.globalAlpha = 0.28;
  ctx.lineWidth = Math.max(1, w * 0.02);
  const motif = hash % 3;
  if (motif === 0) {
    ctx.beginPath();
    ctx.arc(x + w * 0.5, y + h * 0.42, w * 0.28, 0, Math.PI * 2);
    ctx.stroke();
  } else if (motif === 1) {
    ctx.strokeRect(x + w * 0.12, y + w * 0.12, w * 0.76, h - w * 0.24);
  } else {
    ctx.beginPath();
    ctx.moveTo(x + w * 0.12, y + h * 0.62);
    ctx.lineTo(x + w * 0.88, y + h * 0.62);
    ctx.stroke();
  }
  ctx.restore();

  ctx.fillStyle = '#E5DFD2';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `600 ${Math.max(8, Math.round(w * 0.13))}px "Helvetica Neue", Helvetica, Arial, sans-serif`;

  const words = movie.title.split(/\s+/).filter(Boolean);
  const line1 = (words[0] || '').slice(0, 9);
  const line2 = (words[1] || '').slice(0, 9);
  if (line2) {
    ctx.fillText(line1, x + w * 0.5, y + h * 0.36, w - 8);
    ctx.fillText(line2, x + w * 0.5, y + h * 0.5, w - 8);
  } else {
    ctx.fillText(line1, x + w * 0.5, y + h * 0.43, w - 8);
  }

  ctx.fillStyle = accent;
  ctx.font = `500 ${Math.max(7, Math.round(w * 0.11))}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  ctx.fillText(movie.year || '', x + w * 0.5, y + h * 0.76, w - 8);
}

// Reusable scratch canvas for faded ink-on-paper grading
let scratchCanvas: HTMLCanvasElement | null = null;
let scratchCtx: CanvasRenderingContext2D | null = null;

export function drawPrintedPosterSlot(
  atlasCtx: CanvasRenderingContext2D,
  slotX: number,
  slotY: number,
  slotW: number,
  slotH: number,
  drawSource: CanvasImageSource | null,
  movie: MovieRecord,
  indexSeed: number,
): void {
  if (!scratchCanvas || scratchCanvas.width !== slotW || scratchCanvas.height !== slotH) {
    scratchCanvas = document.createElement('canvas');
    scratchCanvas.width = slotW;
    scratchCanvas.height = slotH;
    scratchCtx = scratchCanvas.getContext('2d', { willReadFrequently: true });
  }
  const sCtx = scratchCtx!;

  sCtx.fillStyle = '#f6f6f4';
  sCtx.fillRect(0, 0, slotW, slotH);

  if (drawSource) {
    // Cover-fit centered on the poster's middle
    const srcW =
      'naturalWidth' in drawSource && drawSource.naturalWidth
        ? drawSource.naturalWidth
        : 'width' in drawSource
          ? Number(drawSource.width)
          : slotW;
    const srcH =
      'naturalHeight' in drawSource && drawSource.naturalHeight
        ? drawSource.naturalHeight
        : 'height' in drawSource
          ? Number(drawSource.height)
          : slotH;
    const scale = Math.max(slotW / Math.max(1, srcW), slotH / Math.max(1, srcH));
    const drawW = srcW * scale;
    const drawH = srcH * scale;
    const dx = (slotW - drawW) * 0.5;
    const dy = (slotH - drawH) * 0.5;
    sCtx.drawImage(drawSource, dx, dy, drawW, drawH);
  } else {
    drawStylizedFallbackPoster(sCtx, 0, 0, slotW, slotH, movie);
  }

  // Clean printed-on-paper processing:
  // - Desaturate ~12%
  // - Reduce contrast ~8%
  // - Lift blacks slightly to #1c1c1c (28, 28, 28)
  // - Keep whites clean #f6f6f4 (246, 246, 244)
  // - Blend ~8% crisp neutral paper texture (grain & subtle cellulose fibres), no sepia/warm multiply
  const { heights } = ensurePaperField();
  const imgData = sCtx.getImageData(0, 0, slotW, slotH);
  const px = imgData.data;
  const grainOffsetX = Math.floor(hash2D(indexSeed, 10, 43) * PAPER_TEX_SIZE);
  const grainOffsetY = Math.floor(hash2D(indexSeed, 11, 47) * PAPER_TEX_SIZE);

  for (let y = 0; y < slotH; y++) {
    const gy = (y + grainOffsetY) % PAPER_TEX_SIZE;
    for (let x = 0; x < slotW; x++) {
      const gx = (x + grainOffsetX) % PAPER_TEX_SIZE;
      const i = (y * slotW + x) * 4;

      let r = px[i];
      let g = px[i + 1];
      let b = px[i + 2];

      // 1. Desaturate ~12%
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      r = r * 0.88 + lum * 0.12;
      g = g * 0.88 + lum * 0.12;
      b = b * 0.88 + lum * 0.12;

      // 2. Reduce contrast ~8%
      r = (r - 128) * 0.92 + 128;
      g = (g - 128) * 0.92 + 128;
      b = (b - 128) * 0.92 + 128;

      r = r < 0 ? 0 : r > 255 ? 255 : r;
      g = g < 0 ? 0 : g > 255 ? 255 : g;
      b = b < 0 ? 0 : b > 255 ? 255 : b;

      // 3. Lift blacks slightly to #1c1c1c (28, 28, 28) & whites to #f6f6f4 (246, 246, 244)
      r = 28 + (r / 255) * (246 - 28);
      g = 28 + (g / 255) * (246 - 28);
      b = 28 + (b / 255) * (244 - 28);

      // 4. Blend ~8% clean neutral paper texture
      const grainH = heights[gy * PAPER_TEX_SIZE + gx];
      const paperTone = 0.94 + grainH * 0.08;
      const paperR = 246 * paperTone;
      const paperG = 246 * paperTone;
      const paperB = 244 * paperTone;

      r = r * 0.92 + paperR * 0.08;
      g = g * 0.92 + paperG * 0.08;
      b = b * 0.92 + paperB * 0.08;

      px[i] = Math.min(255, Math.max(0, Math.round(r)));
      px[i + 1] = Math.min(255, Math.max(0, Math.round(g)));
      px[i + 2] = Math.min(255, Math.max(0, Math.round(b)));
    }
  }

  sCtx.putImageData(imgData, 0, 0);
  atlasCtx.drawImage(scratchCanvas, slotX, slotY);
}
