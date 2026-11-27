import * as THREE from 'three';
import type { MovieRecord } from '../types/movie';

const TMDB_W185 = 'https://image.tmdb.org/t/p/w185';
const IDB_NAME = 'movieDieCollageDB_v2';
const LEGACY_IDB_NAME = 'movieDieCollageDB_v1';
const IDB_STORE = 'collages';
const ID_MAP_SIZE = 512;

export interface BakeProgress {
  completed: number;
  total: number;
  label: string;
}

export interface BakedCollageResult {
  cubeTexture: THREE.CubeTexture;
  faceNormals: THREE.Vector3[];
  posterSpecs: PosterLayoutSpec[];
  sampleIdAtDirection: (dir: THREE.Vector3) => number;
  dispose: () => void;
}

interface Vec2 {
  x: number;
  y: number;
}

interface CubeFaceBasis {
  n: THREE.Vector3;
  u: THREE.Vector3;
  v: THREE.Vector3;
}

// Exact OpenGL / WebGL TEXTURE_CUBE_MAP basis (+X, -X, +Y, -Y, +Z, -Z) with flipY = false
const CUBE_FACES: CubeFaceBasis[] = [
  { n: new THREE.Vector3(1, 0, 0), u: new THREE.Vector3(0, 0, -1), v: new THREE.Vector3(0, -1, 0) },
  { n: new THREE.Vector3(-1, 0, 0), u: new THREE.Vector3(0, 0, 1), v: new THREE.Vector3(0, -1, 0) },
  { n: new THREE.Vector3(0, 1, 0), u: new THREE.Vector3(1, 0, 0), v: new THREE.Vector3(0, 0, 1) },
  { n: new THREE.Vector3(0, -1, 0), u: new THREE.Vector3(1, 0, 0), v: new THREE.Vector3(0, 0, -1) },
  { n: new THREE.Vector3(0, 0, 1), u: new THREE.Vector3(1, 0, 0), v: new THREE.Vector3(0, -1, 0) },
  { n: new THREE.Vector3(0, 0, -1), u: new THREE.Vector3(-1, 0, 0), v: new THREE.Vector3(0, -1, 0) },
];

const FALLBACK_PALETTES = [
  ['#2A3342', '#D8B467'],
  ['#42292E', '#E09F7D'],
  ['#243B34', '#8FC0A9'],
  ['#362B45', '#C7A4E0'],
  ['#3D3428', '#D9B882'],
  ['#223447', '#89B8DF'],
];

function hashIndex(i: number): number {
  let x = (i + 1) * 0x9e3779b1;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967295;
}

function hashString(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function noise1D(x: number, seed: number): number {
  const ix = Math.floor(x);
  const fx = x - ix;
  const s = fx * fx * (3 - 2 * fx);
  const a = hashIndex(ix * 131 + seed * 17) * 2 - 1;
  const b = hashIndex((ix + 1) * 131 + seed * 17) * 2 - 1;
  return a + s * (b - a);
}

function fractalNoise1D(x: number, seed: number): number {
  return (
    noise1D(x * 4, seed) * 0.55 +
    noise1D(x * 9 + 11.3, seed + 29) * 0.3 +
    noise1D(x * 19 + 27.7, seed + 71) * 0.15
  );
}

function buildTangentBasis(normal: THREE.Vector3, rotAngle: number): {
  tangent: THREE.Vector3;
  bitangent: THREE.Vector3;
} {
  const ref =
    Math.abs(normal.y) < 0.92
      ? new THREE.Vector3(0, 1, 0)
      : new THREE.Vector3(1, 0, 0);
  const t0 = new THREE.Vector3().crossVectors(ref, normal).normalize();
  const b0 = new THREE.Vector3().crossVectors(normal, t0).normalize();

  const c = Math.cos(rotAngle);
  const s = Math.sin(rotAngle);
  const tangent = new THREE.Vector3()
    .addScaledVector(t0, c)
    .addScaledVector(b0, s)
    .normalize();
  const bitangent = new THREE.Vector3()
    .addScaledVector(t0, -s)
    .addScaledVector(b0, c)
    .normalize();
  return { tangent, bitangent };
}

function directionToCubeFaceUv(dir: THREE.Vector3): { faceIdx: number; u: number; v: number } {
  const ax = Math.abs(dir.x);
  const ay = Math.abs(dir.y);
  const az = Math.abs(dir.z);

  let faceIdx = 0;
  let sc = 0;
  let tc = 0;
  let ma = 1;

  if (ax >= ay && ax >= az) {
    if (dir.x > 0) {
      faceIdx = 0;
      sc = -dir.z;
      tc = -dir.y;
      ma = ax;
    } else {
      faceIdx = 1;
      sc = dir.z;
      tc = -dir.y;
      ma = ax;
    }
  } else if (ay >= ax && ay >= az) {
    if (dir.y > 0) {
      faceIdx = 2;
      sc = dir.x;
      tc = dir.z;
      ma = ay;
    } else {
      faceIdx = 3;
      sc = dir.x;
      tc = -dir.z;
      ma = ay;
    }
  } else {
    if (dir.z > 0) {
      faceIdx = 4;
      sc = dir.x;
      tc = -dir.y;
      ma = az;
    } else {
      faceIdx = 5;
      sc = -dir.x;
      tc = -dir.y;
      ma = az;
    }
  }

  return {
    faceIdx,
    u: Math.max(0, Math.min(0.999999, 0.5 * (sc / ma + 1))),
    v: Math.max(0, Math.min(0.999999, 0.5 * (tc / ma + 1))),
  };
}

function projectDirToFacePx(
  dir: THREE.Vector3,
  faceIdx: number,
  faceSize: number,
): Vec2 | null {
  const basis = CUBE_FACES[faceIdx];
  const ma = dir.dot(basis.n);
  if (ma <= 0.18) return null;
  const s = dir.dot(basis.u) / ma;
  const t = dir.dot(basis.v) / ma;
  return {
    x: (s * 0.5 + 0.5) * faceSize,
    y: (t * 0.5 + 0.5) * faceSize,
  };
}

interface TornOutline {
  outer: Vec2[];
  inner: Vec2[];
}

/**
 * Generates an irregular torn-paper poster outline in local tangent angles,
 * with fractal wobble, occasional torn-off corner or ripped side bite,
 * plus an inset inner outline creating a 1–3px rough white paper-fibre rim.
 */
function buildTornPosterOutline(
  seedIdx: number,
  halfW: number,
  halfH: number,
  rimAngle: number,
): TornOutline {
  const r0 = hashIndex(seedIdx * 19 + 3);
  const r1 = hashIndex(seedIdx * 37 + 11);
  const r2 = hashIndex(seedIdx * 53 + 23);
  const r3 = hashIndex(seedIdx * 71 + 41);

  // Base 2:3 normalized corners in [-1, 1]^2 (clockwise)
  let corners: Vec2[] = [
    { x: -1, y: -1 },
    { x: 1, y: -1 },
    { x: 1, y: 1 },
    { x: -1, y: 1 },
  ];

  // ~38% chance of missing/torn corner
  if (r0 < 0.38) {
    const cornerIdx = Math.floor(r1 * 4) % 4;
    const prev = corners[(cornerIdx + 3) % 4];
    const curr = corners[cornerIdx];
    const next = corners[(cornerIdx + 1) % 4];
    const cutA = 0.24 + r2 * 0.22;
    const cutB = 0.20 + r3 * 0.22;
    const pA = { x: curr.x + (prev.x - curr.x) * cutA, y: curr.y + (prev.y - curr.y) * cutA };
    const pB = { x: curr.x + (next.x - curr.x) * cutB, y: curr.y + (next.y - curr.y) * cutB };
    const nextCorners: Vec2[] = [];
    for (let i = 0; i < 4; i++) {
      if (i === cornerIdx) {
        nextCorners.push(pA, pB);
      } else {
        nextCorners.push(corners[i]);
      }
    }
    corners = nextCorners;
  }

  // Subdivide perimeter into ~64 points
  const edgeSegs = Math.max(10, Math.round(64 / corners.length));
  const rawPts: Vec2[] = [];
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % corners.length];
    for (let s = 0; s < edgeSegs; s++) {
      const t = s / edgeSegs;
      rawPts.push({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
      });
    }
  }

  // ~32% chance of a ripped bite out of one side
  const hasBite = r2 < 0.32;
  const biteCenter = Math.floor(r3 * rawPts.length);
  const biteHalfSpan = Math.max(3, Math.round(rawPts.length * (0.07 + r0 * 0.05)));
  const biteDepth = 0.14 + r1 * 0.12;

  const n = rawPts.length;
  const outer: Vec2[] = new Array(n);
  const inner: Vec2[] = new Array(n);

  for (let i = 0; i < n; i++) {
    const prev = rawPts[(i - 1 + n) % n];
    const curr = rawPts[i];
    const next = rawPts[(i + 1) % n];

    const tx = next.x - prev.x;
    const ty = next.y - prev.y;
    const len = Math.max(1e-5, Math.hypot(tx, ty));
    // Clockwise polygon -> outward normal is (ty, -tx) / len? Let's verify:
    // top edge (-1,-1)->(1,-1): tx=+2, ty=0 -> (0,-1) points UP (outward) -> (-ty, tx)? Wait: (ty, -tx) = (0, -2)!
    const nx = ty / len;
    const ny = -tx / len;

    const wobble = fractalNoise1D((i / n) * 4.5, seedIdx + 5) * 0.055;

    let bite = 0;
    if (hasBite) {
      let dIdx = Math.abs(i - biteCenter);
      if (dIdx > n / 2) dIdx = n - dIdx;
      if (dIdx < biteHalfSpan) {
        const u = 1 - dIdx / biteHalfSpan;
        const jag = 0.72 + Math.abs(fractalNoise1D(i * 0.65, seedIdx + 91)) * 0.55;
        bite = -u * u * biteDepth * jag;
      }
    }

    const disp = wobble + bite;
    const ox = (curr.x + nx * disp) * halfW;
    const oy = (curr.y + ny * disp) * halfH;
    outer[i] = { x: ox, y: oy };

    // Inner border inset by 1–3px equivalent with rough fibre jitter
    const fibreRough = 0.65 + (hashIndex(seedIdx * 107 + i * 19) * 0.85);
    const inset = rimAngle * fibreRough;
    inner[i] = {
      x: ox - nx * inset,
      y: oy - ny * inset,
    };
  }

  return { outer, inner };
}

/**
 * Exact non-antialiased triangle-fan scanline rasterizer into an integer ID buffer.
 */
function rasterizeIdPolygon(
  idBuf: Int32Array,
  size: number,
  pts: Vec2[],
  center: Vec2,
  idVal: number,
): number {
  let written = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = center;
    const b = pts[i];
    const c = pts[(i + 1) % n];

    // Cross product (signed area * 2)
    const area2 = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (Math.abs(area2) < 1e-4) continue;
    const sign = area2 > 0 ? 1 : -1;

    const minX = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
    const maxX = Math.min(size - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
    const minY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
    const maxY = Math.min(size - 1, Math.ceil(Math.max(a.y, b.y, c.y)));

    if (maxX < minX || maxY < minY) continue;

    const abX = b.x - a.x;
    const abY = b.y - a.y;
    const bcX = c.x - b.x;
    const bcY = c.y - b.y;
    const caX = a.x - c.x;
    const caY = a.y - c.y;

    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5;
      const rowOff = y * size;
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const w0 = (abX * (py - a.y) - abY * (px - a.x)) * sign;
        if (w0 < 0) continue;
        const w1 = (bcX * (py - b.y) - bcY * (px - b.x)) * sign;
        if (w1 < 0) continue;
        const w2 = (caX * (py - c.y) - caY * (px - c.x)) * sign;
        if (w2 < 0) continue;
        idBuf[rowOff + x] = idVal;
        written++;
      }
    }
  }
  return written;
}

export interface PosterLayoutSpec {
  movieIdx: number;
  center: THREE.Vector3;
  tangent: THREE.Vector3;
  bitangent: THREE.Vector3;
  halfW: number;
  halfH: number;
  outline: TornOutline;
  brightScale: number;
  gradAngle: number;
}

const OVERLAP_SCHEDULE = [1.3, 1.23, 1.17, 1.11, 1.06];
const JITTER_SCHEDULE = [0.25, 0.22, 0.18, 0.14, 0.1];

function buildSpecsForAttempt(
  movieCount: number,
  baseDirs: THREE.Vector3[],
  overlapMul: number,
  sizeJitter: number,
): PosterLayoutSpec[] {
  const avgArea = (4 * Math.PI) / Math.max(12, movieCount);
  const baseW = Math.sqrt(avgArea / 1.5);
  const baseH = baseW * 1.5;
  const rimAngle = (2.1 / 2048) * 2.0;

  const specs: PosterLayoutSpec[] = new Array(movieCount);
  for (let i = 0; i < movieCount; i++) {
    const center = baseDirs[i];
    const rot = (hashIndex(i * 41 + 13) - 0.5) * 2 * ((25 * Math.PI) / 180);
    const { tangent, bitangent } = buildTangentBasis(center, rot);
    const sizeScale =
      overlapMul * (1 + (hashIndex(i * 67 + 19) - 0.5) * 2 * sizeJitter);
    const halfW = baseW * 0.5 * sizeScale;
    const halfH = baseH * 0.5 * sizeScale;

    specs[i] = {
      movieIdx: i,
      center,
      tangent,
      bitangent,
      halfW,
      halfH,
      outline: buildTornPosterOutline(i, halfW, halfH, rimAngle),
      brightScale: 0.94 + hashIndex(i * 83 + 5) * 0.12,
      gradAngle: hashIndex(i * 97 + 17) * Math.PI * 2,
    };
  }
  return specs;
}

function buildBaseFibonacciDirs(movieCount: number): THREE.Vector3[] {
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const baseDirs: THREE.Vector3[] = new Array(movieCount);
  for (let i = 0; i < movieCount; i++) {
    const y = 1 - (2 * (i + 0.5)) / movieCount;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = i * goldenAngle;
    baseDirs[i] = new THREE.Vector3(Math.cos(theta) * r, y, Math.sin(theta) * r).normalize();
  }
  return baseDirs;
}

function solveLayoutWithVisibilityCheck(
  movieCount: number,
  faceNormalsOut: THREE.Vector3[],
): {
  specs: PosterLayoutSpec[];
  drawOrder: number[];
  idBuffers: Int32Array[];
  attemptUsed: number;
} {
  const baseDirs = buildBaseFibonacciDirs(movieCount);
  for (let i = 0; i < movieCount; i++) {
    faceNormalsOut[i] = baseDirs[i];
  }

  let drawOrder = Array.from({ length: movieCount }, (_, idx) => idx);
  for (let i = movieCount - 1; i > 0; i--) {
    const j = Math.floor(hashIndex(i * 29 + 7) * (i + 1));
    const tmp = drawOrder[i];
    drawOrder[i] = drawOrder[j];
    drawOrder[j] = tmp;
  }

  const idBuffers: Int32Array[] = Array.from(
    { length: 6 },
    () => new Int32Array(ID_MAP_SIZE * ID_MAP_SIZE),
  );
  let specs: PosterLayoutSpec[] = [];
  let attemptUsed = 0;

  const tmpDir = new THREE.Vector3();

  for (let attempt = 0; attempt < OVERLAP_SCHEDULE.length; attempt++) {
    attemptUsed = attempt;
    const overlapMul = OVERLAP_SCHEDULE[attempt];
    const sizeJitter = JITTER_SCHEDULE[attempt];

    specs = buildSpecsForAttempt(movieCount, baseDirs, overlapMul, sizeJitter);
    const idealPixels = new Int32Array(movieCount);
    for (let f = 0; f < 6; f++) idBuffers[f].fill(0);

    // Rasterize all posters in drawOrder onto the 6 ID buffers
    for (let rank = 0; rank < movieCount; rank++) {
      const idx = drawOrder[rank];
      const spec = specs[idx];
      const maxRadius = Math.hypot(spec.halfW, spec.halfH) * 1.15;

      for (let f = 0; f < 6; f++) {
        if (spec.center.dot(CUBE_FACES[f].n) < 0.25 - maxRadius) continue;

        const cPx = projectDirToFacePx(spec.center, f, ID_MAP_SIZE);
        if (!cPx) continue;

        const polyPx: Vec2[] = [];
        let inBounds = false;
        let valid = true;

        for (let p = 0; p < spec.outline.outer.length; p++) {
          const lp = spec.outline.outer[p];
          tmpDir
            .copy(spec.center)
            .addScaledVector(spec.tangent, lp.x)
            .addScaledVector(spec.bitangent, lp.y)
            .normalize();
          const pt = projectDirToFacePx(tmpDir, f, ID_MAP_SIZE);
          if (!pt) {
            valid = false;
            break;
          }
          if (pt.x >= -8 && pt.x <= ID_MAP_SIZE + 8 && pt.y >= -8 && pt.y <= ID_MAP_SIZE + 8) {
            inBounds = true;
          }
          polyPx.push(pt);
        }

        if (!valid || !inBounds) continue;
        // Ideal pixel area = sum of pixels written when rasterized for this poster (only once per face pixel)
        const written = rasterizeIdPolygon(
          idBuffers[f],
          ID_MAP_SIZE,
          polyPx,
          cPx,
          idx + 1,
        );
        // Count how many pixels of this poster land inside [0, ID_MAP_SIZE) across faces
        idealPixels[idx] += written;
      }
    }

    // Measure actual visible pixels for every movie
    const visibleCounts = new Int32Array(movieCount);
    for (let f = 0; f < 6; f++) {
      const buf = idBuffers[f];
      for (let k = 0; k < buf.length; k++) {
        const id = buf[k];
        if (id > 0) visibleCounts[id - 1]++;
      }
    }

    const underVisible: { idx: number; ratio: number }[] = [];
    for (let i = 0; i < movieCount; i++) {
      const ideal = Math.max(1, idealPixels[i]);
      const ratio = visibleCounts[i] / ideal;
      if (ratio < 0.35) {
        underVisible.push({ idx: i, ratio });
      }
    }

    if (underVisible.length === 0 || attempt === OVERLAP_SCHEDULE.length - 1) {
      break;
    }

    // Promote buried movies toward the top of drawOrder so every movie stays >= 35% visible
    const buriedSet = new Set(underVisible.map((u) => u.idx));
    const upper = drawOrder.filter((id) => !buriedSet.has(id));
    const promoted = underVisible
      .sort((a, b) => a.ratio - b.ratio)
      .map((u) => u.idx);
    drawOrder = [...upper, ...promoted];
  }

  return { specs, drawOrder, idBuffers, attemptUsed };
}

function loadW185Image(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load ${url}`));
    img.src = url;
  });
}

// Subtle 128x128 seamless neutral paper grain tile for ~6% multiply overlay
let paperGrainPatternCanvas: HTMLCanvasElement | null = null;
function getPaperGrainCanvas(): HTMLCanvasElement {
  if (paperGrainPatternCanvas) return paperGrainPatternCanvas;
  const size = 128;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < size * size; i++) {
    const n = hashIndex(i * 17 + 31);
    const v = Math.round(236 + n * 19); // subtle ~6% grain variation
    d[i * 4] = v;
    d[i * 4 + 1] = v;
    d[i * 4 + 2] = Math.max(0, v - 1);
    d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  paperGrainPatternCanvas = c;
  return c;
}

function renderPosterStamp(
  stampCanvas: HTMLCanvasElement,
  stampCtx: CanvasRenderingContext2D,
  img: HTMLImageElement | null,
  movie: MovieRecord,
  brightScale: number,
  gradAngle: number,
): void {
  const w = stampCanvas.width;
  const h = stampCanvas.height;

  stampCtx.globalCompositeOperation = 'source-over';
  stampCtx.filter = 'none';
  stampCtx.fillStyle = '#f4f4f2';
  stampCtx.fillRect(0, 0, w, h);

  if (img && img.naturalWidth > 0) {
    // Keep natural poster colors cleanly cover-fitted
    const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
    const dw = img.naturalWidth * scale;
    const dh = img.naturalHeight * scale;
    stampCtx.drawImage(img, (w - dw) * 0.5, (h - dh) * 0.5, dw, dh);

    // ±6% per-piece brightness variation
    if (brightScale > 1.002) {
      stampCtx.fillStyle = `rgba(255, 255, 255, ${(brightScale - 1).toFixed(3)})`;
      stampCtx.fillRect(0, 0, w, h);
    } else if (brightScale < 0.998) {
      stampCtx.fillStyle = `rgba(0, 0, 0, ${(1 - brightScale).toFixed(3)})`;
      stampCtx.fillRect(0, 0, w, h);
    }
  } else {
    const hVal = hashString(`${movie.title}_${movie.year}`);
    const [bg, accent] = FALLBACK_PALETTES[hVal % FALLBACK_PALETTES.length];
    const grad = stampCtx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, bg);
    grad.addColorStop(1, '#181A22');
    stampCtx.fillStyle = grad;
    stampCtx.fillRect(0, 0, w, h);

    stampCtx.fillStyle = '#F2F1EC';
    stampCtx.textAlign = 'center';
    stampCtx.textBaseline = 'middle';
    stampCtx.font = `700 ${Math.round(w * 0.12)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
    const words = movie.title.split(/\s+/).filter(Boolean);
    stampCtx.fillText((words[0] || '').slice(0, 10), w * 0.5, h * 0.4, w - 12);
    if (words[1]) {
      stampCtx.fillText(words[1].slice(0, 10), w * 0.5, h * 0.53, w - 12);
    }
    stampCtx.fillStyle = accent;
    stampCtx.font = `500 ${Math.round(w * 0.1)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
    stampCtx.fillText(movie.year || '', w * 0.5, h * 0.78, w - 12);
  }

  // Faint per-piece directional lighting gradient (sheet angled slightly relative to light)
  const gx = Math.cos(gradAngle) * w * 0.5;
  const gy = Math.sin(gradAngle) * h * 0.5;
  const lightGrad = stampCtx.createLinearGradient(w * 0.5 - gx, h * 0.5 - gy, w * 0.5 + gx, h * 0.5 + gy);
  lightGrad.addColorStop(0, 'rgba(255, 255, 255, 0.045)');
  lightGrad.addColorStop(0.5, 'rgba(255, 255, 255, 0)');
  lightGrad.addColorStop(1, 'rgba(0, 0, 0, 0.055)');
  stampCtx.fillStyle = lightGrad;
  stampCtx.fillRect(0, 0, w, h);

  // Subtle ~6% paper grain multiply
  stampCtx.globalCompositeOperation = 'multiply';
  const grain = getPaperGrainCanvas();
  const pat = stampCtx.createPattern(grain, 'repeat');
  if (pat) {
    stampCtx.fillStyle = pat;
    stampCtx.fillRect(0, 0, w, h);
  }
  stampCtx.globalCompositeOperation = 'source-over';
}

/**
 * Draws a textured triangle from `srcCanvas` onto `ctx`, expanding vertices
 * outward by `bleedPx` (preserving exact affine mapping) so Canvas2D never
 * leaves subpixel seams between subdivided mesh triangles.
 */
function drawExpandedTexturedTriangle(
  ctx: CanvasRenderingContext2D,
  srcCanvas: HTMLCanvasElement,
  d0: Vec2,
  d1: Vec2,
  d2: Vec2,
  s0: Vec2,
  s1: Vec2,
  s2: Vec2,
  bleedPx = 0.65,
): void {
  const denom = (s1.x - s0.x) * (s2.y - s0.y) - (s2.x - s0.x) * (s1.y - s0.y);
  if (Math.abs(denom) < 1e-5) return;

  // Affine matrix M mapping source UV -> dest XY
  const a = ((d1.x - d0.x) * (s2.y - s0.y) - (d2.x - d0.x) * (s1.y - s0.y)) / denom;
  const b = ((d1.y - d0.y) * (s2.y - s0.y) - (d2.y - d0.y) * (s1.y - s0.y)) / denom;
  const c = ((d2.x - d0.x) * (s1.x - s0.x) - (d1.x - d0.x) * (s2.x - s0.x)) / denom;
  const d = ((d2.y - d0.y) * (s1.x - s0.x) - (d1.y - d0.y) * (s2.x - s0.x)) / denom;
  const e = d0.x - a * s0.x - c * s0.y;
  const f = d0.y - b * s0.x - d * s0.y;

  const cx = (d0.x + d1.x + d2.x) / 3;
  const cy = (d0.y + d1.y + d2.y) / 3;
  const expand = (p: Vec2): Vec2 => {
    const vx = p.x - cx;
    const vy = p.y - cy;
    const len = Math.max(1e-4, Math.hypot(vx, vy));
    return { x: p.x + (vx / len) * bleedPx, y: p.y + (vy / len) * bleedPx };
  };

  const e0 = expand(d0);
  const e1 = expand(d1);
  const e2 = expand(d2);

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(e0.x, e0.y);
  ctx.lineTo(e1.x, e1.y);
  ctx.lineTo(e2.x, e2.y);
  ctx.closePath();
  ctx.clip();
  ctx.transform(a, b, c, d, e, f);
  ctx.drawImage(srcCanvas, 0, 0);
  ctx.restore();
}

// Consistent 3D light direction for drop shadow offset across all 6 cube faces
const SHADOW_3D_OFFSET = new THREE.Vector3(0.0022, -0.0024, 0.0014);

function buildCacheSignature(movies: MovieRecord[], faceSize: number): string {
  const sample = movies.map((m) => `${m.id}:${m.poster_path}`).join('|');
  const h1 = hashString(sample).toString(36);
  const h2 = hashString(`${movies.length}:${sample.slice(0, 600)}:${sample.slice(-600)}`).toString(36);
  return `collage_v4_${faceSize}_${movies.length}_${h1}_${h2}`;
}

interface StoredCollageRecord {
  signature: string;
  faceBlobs: Blob[];
  idBuffers: ArrayBuffer[];
  faceNormals: [number, number, number][];
  attemptUsed: number;
}

let legacyDbCleaned = false;

function openCollageDb(): Promise<IDBDatabase> {
  if (!legacyDbCleaned) {
    legacyDbCleaned = true;
    try {
      indexedDB.deleteDatabase(LEGACY_IDB_NAME);
    } catch {
      // Ignore
    }
  }
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: 'signature' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const COLLAGE_SW_CACHE_NAME = 'movie-die-baked-collage-v2';

function getCollageCacheUrl(path: string): string {
  return new URL(`./__baked-collage__/${path}`, window.location.href).toString();
}

async function readCollageFromCacheStorage(signature: string): Promise<StoredCollageRecord | null> {
  if (typeof caches === 'undefined') return null;
  try {
    const cache = await caches.open(COLLAGE_SW_CACHE_NAME);
    const metaRes = await cache.match(getCollageCacheUrl('meta.json'));
    if (!metaRes) return null;
    const meta = (await metaRes.json()) as {
      signature?: string;
      faceNormals?: [number, number, number][];
      attemptUsed?: number;
      faceCount?: number;
    };
    if (meta.signature !== signature || !Array.isArray(meta.faceNormals)) {
      return null;
    }
    const faceCount = typeof meta.faceCount === 'number' ? meta.faceCount : 6;
    const faceBlobs: Blob[] = [];
    const idBuffers: ArrayBuffer[] = [];

    for (let i = 0; i < faceCount; i++) {
      const [imgRes, idRes] = await Promise.all([
        cache.match(getCollageCacheUrl(`face-${i}.jpg`)),
        cache.match(getCollageCacheUrl(`id-${i}.bin`)),
      ]);
      if (!imgRes || !idRes) return null;
      faceBlobs.push(await imgRes.blob());
      idBuffers.push(await idRes.arrayBuffer());
    }

    return {
      signature,
      faceBlobs,
      idBuffers,
      faceNormals: meta.faceNormals,
      attemptUsed: typeof meta.attemptUsed === 'number' ? meta.attemptUsed : 0,
    };
  } catch {
    return null;
  }
}

async function writeCollageToCacheStorage(record: StoredCollageRecord): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    await caches.delete(COLLAGE_SW_CACHE_NAME);
    const cache = await caches.open(COLLAGE_SW_CACHE_NAME);
    const puts: Promise<void>[] = [
      cache.put(
        getCollageCacheUrl('meta.json'),
        new Response(
          JSON.stringify({
            signature: record.signature,
            faceNormals: record.faceNormals,
            attemptUsed: record.attemptUsed,
            faceCount: record.faceBlobs.length,
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    ];

    for (let i = 0; i < record.faceBlobs.length; i++) {
      puts.push(
        cache.put(
          getCollageCacheUrl(`face-${i}.jpg`),
          new Response(record.faceBlobs[i], {
            headers: { 'Content-Type': record.faceBlobs[i].type || 'image/jpeg' },
          }),
        ),
      );
      puts.push(
        cache.put(
          getCollageCacheUrl(`id-${i}.bin`),
          new Response(record.idBuffers[i], {
            headers: { 'Content-Type': 'application/octet-stream' },
          }),
        ),
      );
    }

    await Promise.all(puts);
  } catch {
    // Ignore Cache Storage quota errors gracefully
  }
}

async function readCachedCollage(signature: string): Promise<StoredCollageRecord | null> {
  try {
    const db = await openCollageDb();
    const idbRecord = await new Promise<StoredCollageRecord | null>((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const store = tx.objectStore(IDB_STORE);
      const getReq = store.get(signature);
      getReq.onsuccess = () => resolve((getReq.result as StoredCollageRecord) || null);
      getReq.onerror = () => resolve(null);
    });
    if (idbRecord) return idbRecord;
  } catch {
    // Fall through to Cache Storage fallback
  }

  return readCollageFromCacheStorage(signature);
}

async function writeCachedCollage(record: StoredCollageRecord): Promise<void> {
  try {
    const db = await openCollageDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      // Keep only the latest bake so IndexedDB doesn't bloat
      store.clear();
      store.put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Ignore storage quota errors cleanly
  }

  await writeCollageToCacheStorage(record);
}

export async function clearBakedCollageCache(): Promise<void> {
  try {
    const db = await openCollageDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Ignore
  }

  if (typeof caches !== 'undefined') {
    try {
      await caches.delete(COLLAGE_SW_CACHE_NAME);
    } catch {
      // Ignore
    }
  }
}

function blobToCanvas(blob: Blob, faceSize: number): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = faceSize;
      c.height = faceSize;
      c.getContext('2d')!.drawImage(img, 0, 0, faceSize, faceSize);
      URL.revokeObjectURL(url);
      resolve(c);
    };
    img.onerror = (err) => {
      URL.revokeObjectURL(url);
      reject(err);
    };
    img.src = url;
  });
}

function createSampler(
  idBuffers: Int32Array[],
  faceNormals: THREE.Vector3[],
): (dir: THREE.Vector3) => number {
  return (dir: THREE.Vector3): number => {
    const { faceIdx, u, v } = directionToCubeFaceUv(dir);
    const cx = Math.min(ID_MAP_SIZE - 1, Math.max(0, Math.floor(u * ID_MAP_SIZE)));
    const cy = Math.min(ID_MAP_SIZE - 1, Math.max(0, Math.floor(v * ID_MAP_SIZE)));
    const buf = idBuffers[faceIdx];

    const direct = buf[cy * ID_MAP_SIZE + cx];
    if (direct > 0) return direct - 1;

    // If hitting a 1–2px gap, spiral outward slightly
    for (let rad = 1; rad <= 8; rad++) {
      for (let dy = -rad; dy <= rad; dy++) {
        const py = cy + dy;
        if (py < 0 || py >= ID_MAP_SIZE) continue;
        for (let dx = -rad; dx <= rad; dx++) {
          const px = cx + dx;
          if (px < 0 || px >= ID_MAP_SIZE) continue;
          const id = buf[py * ID_MAP_SIZE + px];
          if (id > 0) return id - 1;
        }
      }
    }

    // Ultimate fallback: closest Fibonacci normal
    let bestIdx = 0;
    let bestDot = -Infinity;
    for (let i = 0; i < faceNormals.length; i++) {
      const d = dir.dot(faceNormals[i]);
      if (d > bestDot) {
        bestDot = d;
        bestIdx = i;
      }
    }
    return bestIdx;
  };
}

function buildCubeTextureFromCanvases(
  canvases: HTMLCanvasElement[],
  maxAnisotropy: number,
): THREE.CubeTexture {
  const cubeTex = new THREE.CubeTexture(canvases);
  cubeTex.colorSpace = THREE.SRGBColorSpace;
  cubeTex.generateMipmaps = true;
  cubeTex.minFilter = THREE.LinearMipmapLinearFilter;
  cubeTex.magFilter = THREE.LinearFilter;
  cubeTex.anisotropy = Math.min(8, maxAnisotropy);
  cubeTex.needsUpdate = true;
  return cubeTex;
}

function yieldFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export async function bakeCollageCubeMap(
  movies: MovieRecord[],
  options: {
    maxTextureSize: number;
    maxAnisotropy: number;
    isSoftwareGl: boolean;
  },
  onProgress: (prog: BakeProgress) => void,
  signal?: AbortSignal,
): Promise<BakedCollageResult> {
  const faceSize = options.isSoftwareGl || options.maxTextureSize < 2048 ? 1024 : 2048;
  const signature = buildCacheSignature(movies, faceSize);

  // 1. Check IndexedDB cache first for instant startup
  const cached = await readCachedCollage(signature);
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  if (
    cached &&
    cached.faceBlobs.length === 6 &&
    cached.idBuffers.length === 6 &&
    cached.faceNormals.length === movies.length
  ) {
    try {
      onProgress({ completed: 1, total: 1, label: 'Gluing posters…' });
      const canvases = await Promise.all(
        cached.faceBlobs.map((blob) => blobToCanvas(blob, faceSize)),
      );
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const idBuffers = cached.idBuffers.map((buf) => new Int32Array(buf));
      const faceNormals = cached.faceNormals.map(([x, y, z]) => new THREE.Vector3(x, y, z));
      const attemptIdx = Math.min(
        OVERLAP_SCHEDULE.length - 1,
        Math.max(0, cached.attemptUsed ?? 0),
      );
      const posterSpecs = buildSpecsForAttempt(
        movies.length,
        faceNormals,
        OVERLAP_SCHEDULE[attemptIdx],
        JITTER_SCHEDULE[attemptIdx],
      );
      const cubeTexture = buildCubeTextureFromCanvases(canvases, options.maxAnisotropy);

      return {
        cubeTexture,
        faceNormals,
        posterSpecs,
        sampleIdAtDirection: createSampler(idBuffers, faceNormals),
        dispose: () => {
          cubeTexture.dispose();
        },
      };
    } catch {
      // Cache corrupt; fall through to fresh bake
    }
  }

  // 2. Solve spherical Fibonacci collage layout + verify >= 35% visibility via ID cube map
  const faceNormals: THREE.Vector3[] = new Array(movies.length);
  onProgress({ completed: 0, total: movies.length * 2, label: 'Gluing posters…' });
  const { specs, drawOrder, idBuffers, attemptUsed } = solveLayoutWithVisibilityCheck(
    movies.length,
    faceNormals,
  );

  // 3. Download TMDB w185 posters concurrently
  const loadedImages: (HTMLImageElement | null)[] = new Array(movies.length).fill(null);
  const toFetch = movies
    .map((m, idx) => ({ m, idx }))
    .filter((item) => Boolean(item.m.poster_path) && !item.m.isPreviewFallback);

  let fetchedCount = 0;
  let fetchCursor = 0;
  const totalSteps = Math.max(1, toFetch.length + movies.length);

  if (toFetch.length > 0) {
    const worker = async () => {
      while (!signal?.aborted) {
        const ptr = fetchCursor++;
        if (ptr >= toFetch.length) break;
        const { m, idx } = toFetch[ptr];
        try {
          loadedImages[idx] = await loadW185Image(`${TMDB_W185}${m.poster_path}`);
        } catch {
          loadedImages[idx] = null;
        }
        fetchedCount++;
        if (fetchedCount % 12 === 0 || fetchedCount === toFetch.length) {
          onProgress({
            completed: fetchedCount,
            total: totalSteps,
            label: 'Gluing posters…',
          });
        }
      }
    };

    const concurrency = 18;
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  }

  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  // 4. Create the 6 visual cube-map canvases (2048x2048 each)
  const faceCanvases: HTMLCanvasElement[] = [];
  const faceCtxs: CanvasRenderingContext2D[] = [];
  for (let f = 0; f < 6; f++) {
    const c = document.createElement('canvas');
    c.width = faceSize;
    c.height = faceSize;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#f2f2ef';
    ctx.fillRect(0, 0, faceSize, faceSize);
    faceCanvases.push(c);
    faceCtxs.push(ctx);
  }

  // Scratch canvas for individual poster pre-grading (2:3)
  const stampCanvas = document.createElement('canvas');
  stampCanvas.width = 160;
  stampCanvas.height = 240;
  const stampCtx = stampCanvas.getContext('2d')!;

  const tmpDir = new THREE.Vector3();
  const shadowBlurPx = Math.max(4, Math.round(faceSize * 0.003)); // ~6px at 2048

  // 2x2 UV grid coordinates on stampCanvas
  const gridSteps = 2;
  const uvSteps = [0, 0.5, 1];
  const sPts: Vec2[][] = [];
  for (let gy = 0; gy <= gridSteps; gy++) {
    const row: Vec2[] = [];
    for (let gx = 0; gx <= gridSteps; gx++) {
      row.push({ x: uvSteps[gx] * stampCanvas.width, y: uvSteps[gy] * stampCanvas.height });
    }
    sPts.push(row);
  }

  // 5. Paint each movie in drawOrder across all overlapped cube faces
  for (let rank = 0; rank < movies.length; rank++) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const idx = drawOrder[rank];
    const spec = specs[idx];
    const movie = movies[idx];
    renderPosterStamp(
      stampCanvas,
      stampCtx,
      loadedImages[idx],
      movie,
      spec.brightScale,
      spec.gradAngle,
    );

    const maxRadius = Math.hypot(spec.halfW, spec.halfH) * 1.18;

    for (let f = 0; f < 6; f++) {
      const basis = CUBE_FACES[f];
      if (spec.center.dot(basis.n) < 0.22 - maxRadius) continue;

      const outerFacePts: Vec2[] = [];
      const innerFacePts: Vec2[] = [];
      let inFaceBounds = false;
      let valid = true;

      for (let p = 0; p < spec.outline.outer.length; p++) {
        const lo = spec.outline.outer[p];
        tmpDir
          .copy(spec.center)
          .addScaledVector(spec.tangent, lo.x)
          .addScaledVector(spec.bitangent, lo.y)
          .normalize();
        const op = projectDirToFacePx(tmpDir, f, faceSize);
        if (!op) {
          valid = false;
          break;
        }

        const li = spec.outline.inner[p];
        tmpDir
          .copy(spec.center)
          .addScaledVector(spec.tangent, li.x)
          .addScaledVector(spec.bitangent, li.y)
          .normalize();
        const ip = projectDirToFacePx(tmpDir, f, faceSize);
        if (!ip) {
          valid = false;
          break;
        }

        if (op.x >= -24 && op.x <= faceSize + 24 && op.y >= -24 && op.y <= faceSize + 24) {
          inFaceBounds = true;
        }
        outerFacePts.push(op);
        innerFacePts.push(ip);
      }

      if (!valid || !inFaceBounds) continue;

      // Project the 2x2 grid corners for seamless curved mapping onto cube face
      // gy=0 (top of poster image) -> +halfH (+bitangent = up); gy=2 (bottom) -> -halfH
      const dGrid: Vec2[][] = [];
      let gridValid = true;
      for (let gy = 0; gy <= gridSteps; gy++) {
        const row: Vec2[] = [];
        const ly = (1 - uvSteps[gy] * 2) * spec.halfH;
        for (let gx = 0; gx <= gridSteps; gx++) {
          const lx = (uvSteps[gx] * 2 - 1) * spec.halfW;
          tmpDir
            .copy(spec.center)
            .addScaledVector(spec.tangent, lx)
            .addScaledVector(spec.bitangent, ly)
            .normalize();
          const pt = projectDirToFacePx(tmpDir, f, faceSize);
          if (!pt) {
            gridValid = false;
            break;
          }
          row.push(pt);
        }
        if (!gridValid) break;
        dGrid.push(row);
      }
      if (!gridValid) continue;

      const ctx = faceCtxs[f];
      const outerPath = new Path2D();
      outerPath.moveTo(outerFacePts[0].x, outerFacePts[0].y);
      for (let p = 1; p < outerFacePts.length; p++) {
        outerPath.lineTo(outerFacePts[p].x, outerFacePts[p].y);
      }
      outerPath.closePath();

      const innerPath = new Path2D();
      innerPath.moveTo(innerFacePts[0].x, innerFacePts[0].y);
      for (let p = 1; p < innerFacePts.length; p++) {
        innerPath.lineTo(innerFacePts[p].x, innerFacePts[p].y);
      }
      innerPath.closePath();

      // Consistent 1-2px shadow offset projected onto this cube face
      const sx = SHADOW_3D_OFFSET.dot(basis.u) * faceSize * 0.5;
      const sy = SHADOW_3D_OFFSET.dot(basis.v) * faceSize * 0.5;

      // A. Drop shadow + white torn-paper base core
      ctx.save();
      ctx.shadowBlur = shadowBlurPx;
      ctx.shadowColor = 'rgba(0, 0, 0, 0.25)';
      ctx.shadowOffsetX = sx;
      ctx.shadowOffsetY = sy;
      ctx.fillStyle = '#f3f2ee';
      ctx.fill(outerPath);
      ctx.restore();

      // B. Subtle fibrous edge texture inside white core + inner poster artwork
      ctx.save();
      ctx.clip(innerPath);
      for (let gy = 0; gy < gridSteps; gy++) {
        for (let gx = 0; gx < gridSteps; gx++) {
          const d00 = dGrid[gy][gx];
          const d10 = dGrid[gy][gx + 1];
          const d01 = dGrid[gy + 1][gx];
          const d11 = dGrid[gy + 1][gx + 1];

          const s00 = sPts[gy][gx];
          const s10 = sPts[gy][gx + 1];
          const s01 = sPts[gy + 1][gx];
          const s11 = sPts[gy + 1][gx + 1];

          drawExpandedTexturedTriangle(ctx, stampCanvas, d00, d10, d11, s00, s10, s11);
          drawExpandedTexturedTriangle(ctx, stampCanvas, d00, d11, d01, s00, s11, s01);
        }
      }
      ctx.restore();
    }

    if ((rank + 1) % 16 === 0 || rank === movies.length - 1) {
      onProgress({
        completed: toFetch.length + rank + 1,
        total: totalSteps,
        label: 'Gluing posters…',
      });
      await yieldFrame();
    }
  }

  // Free downloaded HTMLImageElement references immediately
  loadedImages.length = 0;

  const cubeTexture = buildCubeTextureFromCanvases(faceCanvases, options.maxAnisotropy);

  // Cache baked cube faces + ID map in IndexedDB in background for instant future reloads
  void Promise.all(
    faceCanvases.map(
      (c) =>
        new Promise<Blob | null>((resolve) => {
          c.toBlob((blob) => resolve(blob), 'image/webp', 0.92);
        }),
    ),
  ).then((blobs) => {
    if (blobs.every((b): b is Blob => b !== null)) {
        void writeCachedCollage({
          signature,
          faceBlobs: blobs,
          idBuffers: idBuffers.map((buf) => buf.buffer.slice(0) as ArrayBuffer),
          faceNormals: faceNormals.map((n) => [n.x, n.y, n.z]),
          attemptUsed,
        });
      }
    });

  return {
    cubeTexture,
    faceNormals,
    posterSpecs: specs,
    sampleIdAtDirection: createSampler(idBuffers, faceNormals),
    dispose: () => {
      cubeTexture.dispose();
    },
  };
}

const TMDB_W780 = 'https://image.tmdb.org/t/p/w780';

/**
 * Creates a high-res (512x768) torn-paper front Texture, blank torn-paper spot
 * Texture left on the ball, and soft drop-shadow Texture.
 */
export function createWinningPosterTextures(
  movie: MovieRecord,
  spec: PosterLayoutSpec,
  maxAnisotropy: number,
  onHighResReady: () => void,
  signal?: AbortSignal,
): {
  posterTexture: THREE.CanvasTexture;
  blankTexture: THREE.CanvasTexture;
  shadowTexture: THREE.CanvasTexture;
  dispose: () => void;
} {
  const padScale = 1.15;
  const cw = 512;
  const ch = 768;

  const posterCanvas = document.createElement('canvas');
  posterCanvas.width = cw;
  posterCanvas.height = ch;
  const pCtx = posterCanvas.getContext('2d')!;

  const stampCanvas = document.createElement('canvas');
  stampCanvas.width = cw;
  stampCanvas.height = ch;
  const sCtx = stampCanvas.getContext('2d')!;

  const toCanvasPt = (p: Vec2): Vec2 => ({
    x: ((p.x / (spec.halfW * padScale)) * 0.5 + 0.5) * cw,
    y: (0.5 - (p.y / (spec.halfH * padScale)) * 0.5) * ch,
  });

  const outerPath = new Path2D();
  const innerPath = new Path2D();
  const outerPts = spec.outline.outer.map(toCanvasPt);
  const innerPts = spec.outline.inner.map(toCanvasPt);

  outerPath.moveTo(outerPts[0].x, outerPts[0].y);
  innerPath.moveTo(innerPts[0].x, innerPts[0].y);
  for (let i = 1; i < outerPts.length; i++) {
    outerPath.lineTo(outerPts[i].x, outerPts[i].y);
    innerPath.lineTo(innerPts[i].x, innerPts[i].y);
  }
  outerPath.closePath();
  innerPath.closePath();

  const paintComposite = (img: HTMLImageElement | null) => {
    pCtx.clearRect(0, 0, cw, ch);

    // White torn paper core rim
    pCtx.save();
    pCtx.fillStyle = '#f3f2ee';
    pCtx.fill(outerPath);
    pCtx.restore();

    // Inner artwork fitted inside inner torn edge
    renderPosterStamp(
      stampCanvas,
      sCtx,
      img,
      movie,
      spec.brightScale,
      spec.gradAngle,
    );

    const artX = cw * (0.5 - 0.5 / padScale);
    const artY = ch * (0.5 - 0.5 / padScale);
    const artW = cw / padScale;
    const artH = ch / padScale;

    pCtx.save();
    pCtx.clip(innerPath);
    pCtx.drawImage(stampCanvas, artX, artY, artW, artH);
    pCtx.restore();
  };

  paintComposite(null);

  const posterTexture = new THREE.CanvasTexture(posterCanvas);
  posterTexture.colorSpace = THREE.SRGBColorSpace;
  posterTexture.generateMipmaps = true;
  posterTexture.minFilter = THREE.LinearMipmapLinearFilter;
  posterTexture.magFilter = THREE.LinearFilter;
  posterTexture.anisotropy = Math.min(8, maxAnisotropy);
  posterTexture.needsUpdate = true;

  // Blank off-white paper patch left behind on the ball while the copy lifts away
  const blankCanvas = document.createElement('canvas');
  blankCanvas.width = 256;
  blankCanvas.height = 384;
  const blCtx = blankCanvas.getContext('2d')!;
  blCtx.save();
  blCtx.scale(256 / cw, 384 / ch);
  blCtx.fillStyle = '#f2f0ea';
  blCtx.fill(outerPath);
  blCtx.clip(outerPath);
  // Subtle paper fiber grain & dried paste edge hint
  const seedBase = hashString(String(movie.id)) ^ 0x51a9;
  for (let i = 0; i < 420; i++) {
    const px = hashIndex(seedBase + i * 3) * cw;
    const py = hashIndex(seedBase + i * 3 + 1) * ch;
    const pr = 0.8 + hashIndex(seedBase + i * 3 + 2) * 2.2;
    blCtx.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.22)' : 'rgba(210,204,192,0.16)';
    blCtx.fillRect(px, py, pr, pr);
  }
  blCtx.strokeStyle = 'rgba(205, 200, 188, 0.35)';
  blCtx.lineWidth = 4;
  blCtx.stroke(innerPath);
  blCtx.restore();

  const blankTexture = new THREE.CanvasTexture(blankCanvas);
  blankTexture.colorSpace = THREE.SRGBColorSpace;
  blankTexture.needsUpdate = true;

  // Soft peeling drop-shadow underneath the winning poster
  const shadowCanvas = document.createElement('canvas');
  shadowCanvas.width = 256;
  shadowCanvas.height = 384;
  const shCtx = shadowCanvas.getContext('2d')!;
  shCtx.save();
  shCtx.scale(256 / cw, 384 / ch);
  shCtx.shadowBlur = 24;
  shCtx.shadowColor = 'rgba(0, 0, 0, 0.55)';
  shCtx.shadowOffsetX = 6;
  shCtx.shadowOffsetY = 8;
  shCtx.fillStyle = 'rgba(0, 0, 0, 0.28)';
  shCtx.fill(outerPath);
  shCtx.restore();

  const shadowTexture = new THREE.CanvasTexture(shadowCanvas);
  shadowTexture.needsUpdate = true;

  if (movie.poster_path && !movie.isPreviewFallback) {
    void loadW185Image(`${TMDB_W780}${movie.poster_path}`)
      .then((img) => {
        if (signal?.aborted) return;
        paintComposite(img);
        posterTexture.needsUpdate = true;
        onHighResReady();
      })
      .catch(() => {
        if (!signal?.aborted) onHighResReady();
      });
  } else {
    queueMicrotask(() => {
      if (!signal?.aborted) onHighResReady();
    });
  }

  return {
    posterTexture,
    blankTexture,
    shadowTexture,
    dispose: () => {
      posterTexture.dispose();
      blankTexture.dispose();
      shadowTexture.dispose();
    },
  };
}

/**
 * Renders a clean, straight-edged 2:3 poster data URL for fallback movies
 * when no TMDB poster_path is available.
 */
export function createCleanFallbackPosterDataUrl(movie: MovieRecord): string {
  const canvas = document.createElement('canvas');
  canvas.width = 500;
  canvas.height = 750;
  const ctx = canvas.getContext('2d')!;

  const hVal = hashString(`${movie.title}_${movie.year}`);
  const [bg, accent] = FALLBACK_PALETTES[hVal % FALLBACK_PALETTES.length];
  const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
  grad.addColorStop(0, bg);
  grad.addColorStop(1, '#181A22');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = '#F2F1EC';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '700 44px "Helvetica Neue", Helvetica, Arial, sans-serif';
  const words = movie.title.split(/\s+/).filter(Boolean);
  const line1 = words.slice(0, 2).join(' ');
  const line2 = words.slice(2, 4).join(' ');
  ctx.fillText(line1, canvas.width * 0.5, canvas.height * 0.42, canvas.width - 56);
  if (line2) {
    ctx.fillText(line2, canvas.width * 0.5, canvas.height * 0.51, canvas.width - 56);
  }
  if (movie.year) {
    ctx.fillStyle = accent;
    ctx.font = '500 32px "Helvetica Neue", Helvetica, Arial, sans-serif';
    ctx.fillText(movie.year, canvas.width * 0.5, canvas.height * 0.78, canvas.width - 56);
  }

  return canvas.toDataURL('image/png');
}

