export type PipelineMode = 'photo' | 'illustration';
export type ImglyModelSize = 'medium' | 'large';
export type IllustrationStrategy = 'auto' | 'color-to-alpha' | 'corner-edge';
export type ColorToAlphaTarget = 'auto' | 'white' | 'black';

export type RemovalMode = 'auto' | 'chroma' | 'silhouette';
export type ProcessingEngine = 'sharp' | 'jimp';
export type ExportFormat = 'png' | 'webp' | 'jpg';

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

export interface BrushMaskLayer {
  width: number;
  height: number;
  /** 0 = untouched, 1 = force erase (transparent), 2 = force restore (opaque) */
  data: Uint8Array;
}

export interface RemovalOptions {
  mode: RemovalMode;
  illustrationStrategy: IllustrationStrategy;
  colorToAlphaTarget: ColorToAlphaTarget;
  tolerance: number; // 5..120
  feather: number; // 0..12
  edgeShift: number; // -4..6 (positive contracts halo, negative expands)
  defringe: number; // 0..100
  removeInteriorHoles: boolean;
  targetColors?: RgbColor[];
  brushMask?: BrushMaskLayer;
}

export const DEFAULT_REMOVAL_OPTIONS: RemovalOptions = {
  mode: 'auto',
  illustrationStrategy: 'auto',
  colorToAlphaTarget: 'auto',
  tolerance: 34,
  feather: 2,
  edgeShift: 1,
  defringe: 70,
  removeInteriorHoles: false,
  targetColors: [],
};

// Precomputed sRGB -> linear LUT (256 entries)
const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// Precomputed Lab f(t) LUT for t in [0, 1.1]
const LAB_LUT_SIZE = 4096;
const LAB_LUT_MAX = 1.1;
const LAB_F_LUT = new Float32Array(LAB_LUT_SIZE + 1);
for (let i = 0; i <= LAB_LUT_SIZE; i++) {
  const t = (i / LAB_LUT_SIZE) * LAB_LUT_MAX;
  LAB_F_LUT[i] = t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
}

function labF(t: number): number {
  if (t <= 0) return 16 / 116;
  if (t >= LAB_LUT_MAX) return Math.cbrt(t);
  const idx = (t / LAB_LUT_MAX) * LAB_LUT_SIZE;
  return LAB_F_LUT[idx | 0];
}

function rgbToLabTuple(r: number, g: number, b: number): [number, number, number] {
  const rl = SRGB_TO_LINEAR[r];
  const gl = SRGB_TO_LINEAR[g];
  const bl = SRGB_TO_LINEAR[b];

  const x = (rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375) / 0.95047;
  const y = rl * 0.2126729 + gl * 0.7151522 + bl * 0.072175;
  const z = (rl * 0.0193339 + gl * 0.119192 + bl * 0.9503041) / 1.08883;

  const fx = labF(x);
  const fy = labF(y);
  const fz = labF(z);

  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

interface LabCluster {
  l: number;
  a: number;
  b: number;
  r: number;
  g: number;
  blue: number;
  count: number;
}

function deltaE76(l1: number, a1: number, b1: number, l2: number, a2: number, b2: number): number {
  const dl = l1 - l2;
  const da = a1 - a2;
  const db = b1 - b2;
  return Math.sqrt(dl * dl + da * da + db * db);
}

function extractCornerAndBorderClusters(
  pixels: Uint8Array | Uint8ClampedArray,
  labL: Float32Array,
  labA: Float32Array,
  labB: Float32Array,
  width: number,
  height: number,
): LabCluster[] {
  const clusters: LabCluster[] = [];
  const stepX = Math.max(1, Math.floor(width / 80));
  const stepY = Math.max(1, Math.floor(height / 80));
  const borderDepth = Math.min(4, Math.floor(Math.min(width, height) / 8));

  const addSample = (x: number, y: number, weight: number) => {
    const idx = y * width + x;
    const p = idx * 4;
    if (pixels[p + 3] < 20) return;

    const l = labL[idx];
    const a = labA[idx];
    const b = labB[idx];
    const r = pixels[p];
    const g = pixels[p + 1];
    const blue = pixels[p + 2];

    let bestCluster: LabCluster | null = null;
    let bestDist = 14;
    for (let c = 0; c < clusters.length; c++) {
      const cl = clusters[c];
      const d = deltaE76(l, a, b, cl.l, cl.a, cl.b);
      if (d < bestDist) {
        bestDist = d;
        bestCluster = cl;
      }
    }

    if (bestCluster) {
      const n = bestCluster.count + weight;
      bestCluster.l = (bestCluster.l * bestCluster.count + l * weight) / n;
      bestCluster.a = (bestCluster.a * bestCluster.count + a * weight) / n;
      bestCluster.b = (bestCluster.b * bestCluster.count + b * weight) / n;
      bestCluster.r = (bestCluster.r * bestCluster.count + r * weight) / n;
      bestCluster.g = (bestCluster.g * bestCluster.count + g * weight) / n;
      bestCluster.blue = (bestCluster.blue * bestCluster.count + blue * weight) / n;
      bestCluster.count = n;
    } else if (clusters.length < 10) {
      clusters.push({ l, a, b, r, g, blue, count: weight });
    }
  };

  // Higher weight on the 4 corner regions
  const cornerPatch = Math.min(8, Math.floor(Math.min(width, height) / 10));
  for (let dy = 0; dy <= cornerPatch; dy++) {
    for (let dx = 0; dx <= cornerPatch; dx++) {
      addSample(dx, dy, 3);
      addSample(width - 1 - dx, dy, 3);
      addSample(dx, height - 1 - dy, 3);
      addSample(width - 1 - dx, height - 1 - dy, 3);
    }
  }

  for (let d = 0; d <= borderDepth; d++) {
    for (let x = 0; x < width; x += stepX) {
      addSample(x, d, 1);
      addSample(x, height - 1 - d, 1);
    }
    for (let y = 0; y < height; y += stepY) {
      addSample(d, y, 1);
      addSample(width - 1 - d, y, 1);
    }
  }

  clusters.sort((a, b) => b.count - a.count);
  return clusters.slice(0, 6);
}

/**
 * Detects whether the image corners/perimeter represent a near-pure white or black backdrop
 * suitable for Color-to-Alpha extraction.
 */
export function detectWhiteOrBlackBackdrop(
  source: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): 'white' | 'black' | null {
  const patch = Math.min(6, Math.floor(Math.min(width, height) / 12));
  const corners = [
    [0, 0],
    [width - 1 - patch, 0],
    [0, height - 1 - patch],
    [width - 1 - patch, height - 1 - patch],
  ];

  let count = 0;
  let whiteMatches = 0;
  let blackMatches = 0;

  for (const [sx, sy] of corners) {
    for (let dy = 0; dy <= patch; dy++) {
      for (let dx = 0; dx <= patch; dx++) {
        const p = ((sy + dy) * width + (sx + dx)) * 4;
        if (source[p + 3] < 20) continue;
        const r = source[p];
        const g = source[p + 1];
        const b = source[p + 2];
        const spread = Math.max(r, g, b) - Math.min(r, g, b);
        count++;
        if (r >= 232 && g >= 232 && b >= 232 && spread <= 20) {
          whiteMatches++;
        } else if (r <= 24 && g <= 24 && b <= 24 && spread <= 20) {
          blackMatches++;
        }
      }
    }
  }

  if (count === 0) return null;
  if (whiteMatches / count >= 0.85) return 'white';
  if (blackMatches / count >= 0.85) return 'black';
  return null;
}

/**
 * Classic GIMP-style Color-to-Alpha extraction against white or black backgrounds.
 * Preserves anti-aliasing, semi-transparent shadows, and line art cleanly.
 */
function runColorToAlpha(
  source: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  target: 'white' | 'black',
  tolerance: number,
  brushMask?: BrushMaskLayer,
): Uint8ClampedArray {
  const total = width * height;
  const out = new Uint8ClampedArray(source.length);
  const bgR = target === 'white' ? 255 : 0;
  const bgG = target === 'white' ? 255 : 0;
  const bgB = target === 'white' ? 255 : 0;

  // Tolerance controls deadzone floor (removes off-white / off-black compression noise)
  const noiseFloor = Math.min(0.32, Math.max(0.01, (tolerance - 10) / 320));

  for (let i = 0; i < total; i++) {
    const p = i * 4;
    const origA = source[p + 3];
    if (origA === 0) {
      out[p] = 0;
      out[p + 1] = 0;
      out[p + 2] = 0;
      out[p + 3] = 0;
      continue;
    }

    const r = source[p];
    const g = source[p + 1];
    const b = source[p + 2];

    const aR =
      r > bgR ? (r - bgR) / (255 - bgR) : r < bgR ? (bgR - r) / bgR : 0;
    const aG =
      g > bgG ? (g - bgG) / (255 - bgG) : g < bgG ? (bgG - g) / bgG : 0;
    const aB =
      b > bgB ? (b - bgB) / (255 - bgB) : b < bgB ? (bgB - b) / bgB : 0;

    let alpha = Math.max(aR, aG, aB);

    if (alpha <= noiseFloor) {
      out[p] = r;
      out[p + 1] = g;
      out[p + 2] = b;
      out[p + 3] = 0;
      continue;
    }

    // Remap [noiseFloor .. 1] -> [0 .. 1] smoothly
    const remapped = Math.min(1, (alpha - noiseFloor) / (1 - noiseFloor));
    const finalAlpha = Math.round((origA / 255) * remapped * 255);

    if (alpha > 0.001) {
      out[p] = Math.max(0, Math.min(255, Math.round(bgR + (r - bgR) / alpha)));
      out[p + 1] = Math.max(0, Math.min(255, Math.round(bgG + (g - bgG) / alpha)));
      out[p + 2] = Math.max(0, Math.min(255, Math.round(bgB + (b - bgB) / alpha)));
    } else {
      out[p] = r;
      out[p + 1] = g;
      out[p + 2] = b;
    }
    out[p + 3] = finalAlpha;
  }

  if (brushMask && brushMask.data.length > 0) {
    applyBrushMaskInPlace(out, width, height, source, brushMask);
  }

  return out;
}

function applyBrushMaskInPlace(
  out: Uint8ClampedArray,
  width: number,
  height: number,
  source: Uint8Array | Uint8ClampedArray,
  bm: BrushMaskLayer,
): void {
  const scaleX = bm.width / width;
  const scaleY = bm.height / height;
  for (let y = 0; y < height; y++) {
    const by = Math.min(bm.height - 1, Math.floor(y * scaleY));
    const row = y * width;
    const bRow = by * bm.width;
    for (let x = 0; x < width; x++) {
      const bx = Math.min(bm.width - 1, Math.floor(x * scaleX));
      const val = bm.data[bRow + bx];
      const p = (row + x) * 4;
      if (val === 1) {
        out[p + 3] = 0;
      } else if (val === 2) {
        out[p] = source[p];
        out[p + 1] = source[p + 1];
        out[p + 2] = source[p + 2];
        out[p + 3] = source[p + 3] === 0 ? 255 : source[p + 3];
      }
    }
  }
}

/**
 * Applies manual brush mask & edge cleanup to an already-segmented RGBA image
 * (e.g., produced by @imgly/background-removal).
 */
export function applyPostMaskRefinement(
  source: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  brushMask?: BrushMaskLayer,
  originalSource?: Uint8Array | Uint8ClampedArray,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(source.length);
  out.set(source);
  if (brushMask && brushMask.data.length > 0) {
    applyBrushMaskInPlace(out, width, height, originalSource || source, brushMask);
  }
  return out;
}

/**
 * Computes perceptual Lab background removal & alpha matting on an RGBA buffer.
 * Supports Color-to-Alpha (white/black) and Corner-Edge flood-fill preserving internal gradients.
 */
export function removeBackgroundRGBA(
  source: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  options: RemovalOptions,
): Uint8ClampedArray {
  const total = width * height;
  if (total === 0) return new Uint8ClampedArray(source);

  // Check Illustration / Color-to-Alpha dispatch
  if (options.mode === 'auto') {
    const strategy = options.illustrationStrategy || 'auto';
    if (strategy === 'color-to-alpha') {
      const resolvedTarget =
        options.colorToAlphaTarget === 'white' || options.colorToAlphaTarget === 'black'
          ? options.colorToAlphaTarget
          : detectWhiteOrBlackBackdrop(source, width, height) || 'white';
      return runColorToAlpha(
        source,
        width,
        height,
        resolvedTarget,
        options.tolerance,
        options.brushMask,
      );
    }

    if (strategy === 'auto') {
      const detectedWB =
        options.colorToAlphaTarget === 'white' || options.colorToAlphaTarget === 'black'
          ? options.colorToAlphaTarget
          : detectWhiteOrBlackBackdrop(source, width, height);
      if (detectedWB) {
        return runColorToAlpha(
          source,
          width,
          height,
          detectedWB,
          options.tolerance,
          options.brushMask,
        );
      }
    }
  }

  const out = new Uint8ClampedArray(source.length);
  out.set(source);

  // 1. Precompute Lab channels
  const labL = new Float32Array(total);
  const labA = new Float32Array(total);
  const labB = new Float32Array(total);

  for (let i = 0; i < total; i++) {
    const p = i * 4;
    const [l, a, b] = rgbToLabTuple(source[p], source[p + 1], source[p + 2]);
    labL[i] = l;
    labA[i] = a;
    labB[i] = b;
  }

  // 2. Build background color clusters from corners & perimeter
  let clusters: LabCluster[] = [];
  if (options.targetColors && options.targetColors.length > 0 && options.mode === 'chroma') {
    clusters = options.targetColors.map((c) => {
      const [l, a, b] = rgbToLabTuple(c.r, c.g, c.b);
      return { l, a, b, r: c.r, g: c.g, blue: c.b, count: 100 };
    });
  } else {
    clusters = extractCornerAndBorderClusters(source, labL, labA, labB, width, height);
    if (options.targetColors && options.targetColors.length > 0) {
      for (const c of options.targetColors) {
        const [l, a, b] = rgbToLabTuple(c.r, c.g, c.b);
        clusters.unshift({ l, a, b, r: c.r, g: c.g, blue: c.b, count: 200 });
      }
      clusters = clusters.slice(0, 8);
    }
  }

  if (clusters.length === 0) {
    clusters.push({ l: 100, a: 0, b: 0, r: 255, g: 255, blue: 255, count: 1 });
  }

  // 3. Sobel edge barrier magnitude
  const edgeMag = new Float32Array(total);
  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      const idx = row + x;
      const gxL =
        -labL[idx - width - 1] +
        labL[idx - width + 1] -
        2 * labL[idx - 1] +
        2 * labL[idx + 1] -
        labL[idx + width - 1] +
        labL[idx + width + 1];
      const gyL =
        -labL[idx - width - 1] -
        2 * labL[idx - width] -
        labL[idx - width + 1] +
        labL[idx + width - 1] +
        2 * labL[idx + width] +
        labL[idx + width + 1];

      const gxA = labA[idx + 1] - labA[idx - 1];
      const gyA = labA[idx + width] - labA[idx - width];
      const gxB = labB[idx + 1] - labB[idx - 1];
      const gyB = labB[idx + width] - labB[idx - width];

      edgeMag[idx] =
        Math.sqrt(gxL * gxL + gyL * gyL) * 0.28 +
        Math.sqrt(gxA * gxA + gyA * gyA + gxB * gxB + gyB * gyB) * 0.9;
    }
  }

  const nearestBgDist = new Float32Array(total);
  const nearestClusterIdx = new Uint8Array(total);

  for (let i = 0; i < total; i++) {
    const l = labL[i];
    const a = labA[i];
    const b = labB[i];
    let minD = 1e9;
    let minC = 0;
    for (let c = 0; c < clusters.length; c++) {
      const cl = clusters[c];
      const d = deltaE76(l, a, b, cl.l, cl.a, cl.b);
      if (d < minD) {
        minD = d;
        minC = c;
      }
    }
    nearestBgDist[i] = minD;
    nearestClusterIdx[i] = minC;
  }

  const tol = Math.max(4, options.tolerance);
  let alpha = new Uint8Array(total);
  alpha.fill(255);

  if (options.mode === 'chroma') {
    const low = tol * 0.65;
    const high = tol * 1.25;
    const span = Math.max(1, high - low);
    for (let i = 0; i < total; i++) {
      if (source[i * 4 + 3] === 0) {
        alpha[i] = 0;
        continue;
      }
      const d = nearestBgDist[i];
      if (d <= low) {
        alpha[i] = 0;
      } else if (d < high) {
        const t = (d - low) / span;
        alpha[i] = Math.round(t * t * (3 - 2 * t) * 255);
      }
    }
  } else if (options.mode === 'silhouette') {
    const bgLum = clusters[0].l;
    const low = tol * 0.7;
    const high = tol * 1.3;
    const span = Math.max(1, high - low);
    for (let i = 0; i < total; i++) {
      if (source[i * 4 + 3] === 0) {
        alpha[i] = 0;
        continue;
      }
      const d = nearestBgDist[i] * 0.75 + Math.abs(labL[i] - bgLum) * 0.35;
      if (d <= low) {
        alpha[i] = 0;
      } else if (d < high) {
        const t = (d - low) / span;
        alpha[i] = Math.round(t * t * (3 - 2 * t) * 255);
      }
    }
  } else {
    // 'corner-edge' / perimeter flood-fill: preserves all internal gradients intact!
    const visited = new Uint8Array(total);
    const queue = new Int32Array(total);
    let head = 0;
    let tail = 0;

    const trySeed = (idx: number) => {
      if (visited[idx]) return;
      if (source[idx * 4 + 3] < 20 || nearestBgDist[idx] <= tol * 1.15) {
        visited[idx] = 1;
        alpha[idx] = 0;
        queue[tail++] = idx;
      }
    };

    for (let x = 0; x < width; x++) {
      trySeed(x);
      trySeed((height - 1) * width + x);
    }
    for (let y = 1; y < height - 1; y++) {
      trySeed(y * width);
      trySeed(y * width + (width - 1));
    }

    const dx = [-1, 1, 0, 0];
    const dy = [0, 0, -1, 1];

    while (head < tail) {
      const cur = queue[head++];
      const cx = cur % width;
      const cy = (cur / width) | 0;

      for (let dir = 0; dir < 4; dir++) {
        const nx = cx + dx[dir];
        const ny = cy + dy[dir];
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const nIdx = ny * width + nx;
        if (visited[nIdx]) continue;

        if (source[nIdx * 4 + 3] < 20) {
          visited[nIdx] = 1;
          alpha[nIdx] = 0;
          queue[tail++] = nIdx;
          continue;
        }

        const edgePenalty = Math.min(0.62, edgeMag[nIdx] / 95);
        const allowedDist = tol * (1.0 - edgePenalty);
        const bgDist = nearestBgDist[nIdx];
        const stepDist = deltaE76(labL[cur], labA[cur], labB[cur], labL[nIdx], labA[nIdx], labB[nIdx]);

        if (bgDist <= allowedDist || (bgDist <= tol * 1.12 && stepDist < 8 && edgeMag[nIdx] < 16)) {
          visited[nIdx] = 1;
          alpha[nIdx] = 0;
          queue[tail++] = nIdx;
        }
      }
    }

    // Only clear interior pockets if explicitly requested (never in corner-edge gradient-preserving mode)
    const allowHoles =
      options.removeInteriorHoles && options.illustrationStrategy !== 'corner-edge';
    if (allowHoles) {
      const holeVisited = new Uint8Array(total);
      const minHolePixels = Math.max(16, Math.floor(total * 0.00018));
      const holeTol = tol * 0.68;

      for (let i = 0; i < total; i++) {
        if (alpha[i] === 0 || holeVisited[i]) continue;
        if (nearestBgDist[i] > holeTol || edgeMag[i] > 24) continue;

        const compQueue: number[] = [i];
        holeVisited[i] = 1;
        let ptr = 0;
        while (ptr < compQueue.length) {
          const cur = compQueue[ptr++];
          const cx = cur % width;
          const cy = (cur / width) | 0;
          for (let dir = 0; dir < 4; dir++) {
            const nx = cx + dx[dir];
            const ny = cy + dy[dir];
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
            const nIdx = ny * width + nx;
            if (alpha[nIdx] === 0 || holeVisited[nIdx]) continue;
            if (nearestBgDist[nIdx] <= tol * 0.78 && edgeMag[nIdx] < 32) {
              holeVisited[nIdx] = 1;
              compQueue.push(nIdx);
            }
          }
        }

        if (compQueue.length >= minHolePixels) {
          for (let k = 0; k < compQueue.length; k++) {
            alpha[compQueue[k]] = 0;
          }
        }
      }
    }

    // Soft edge ramp for boundary pixels
    for (let y = 1; y < height - 1; y++) {
      const row = y * width;
      for (let x = 1; x < width - 1; x++) {
        const idx = row + x;
        if (alpha[idx] === 0) continue;
        const touchesBg =
          alpha[idx - 1] === 0 || alpha[idx + 1] === 0 || alpha[idx - width] === 0 || alpha[idx + width] === 0;
        if (touchesBg && nearestBgDist[idx] < tol * 1.45) {
          const t = Math.max(0, Math.min(1, (nearestBgDist[idx] - tol * 0.65) / (tol * 0.8)));
          alpha[idx] = Math.round(t * 255);
        }
      }
    }
  }

  // 4. Edge Shift (Erode / Dilate)
  const shift = Math.round(options.edgeShift);
  if (shift !== 0) {
    const steps = Math.min(6, Math.abs(shift));
    const erode = shift > 0;
    let srcA = alpha;
    let dstA = new Uint8Array(total);
    for (let s = 0; s < steps; s++) {
      dstA.set(srcA);
      for (let y = 1; y < height - 1; y++) {
        const row = y * width;
        for (let x = 1; x < width - 1; x++) {
          const idx = row + x;
          dstA[idx] = erode
            ? Math.min(srcA[idx], srcA[idx - 1], srcA[idx + 1], srcA[idx - width], srcA[idx + width])
            : Math.max(srcA[idx], srcA[idx - 1], srcA[idx + 1], srcA[idx - width], srcA[idx + width]);
        }
      }
      const tmp = srcA;
      srcA = dstA;
      dstA = tmp;
    }
    alpha = srcA;
  }

  // 5. Separable Alpha Feathering near edges
  const featherRadius = Math.min(12, Math.max(0, Math.round(options.feather)));
  if (featherRadius > 0) {
    const temp = new Float32Array(total);
    const blurred = new Uint8Array(total);
    const r = featherRadius;

    for (let y = 0; y < height; y++) {
      const row = y * width;
      let sum = 0;
      const win = r * 2 + 1;
      for (let k = -r; k <= r; k++) {
        const sx = Math.max(0, Math.min(width - 1, k));
        sum += alpha[row + sx];
      }
      for (let x = 0; x < width; x++) {
        temp[row + x] = sum / win;
        const left = Math.max(0, x - r);
        const right = Math.min(width - 1, x + r + 1);
        sum += alpha[row + right] - alpha[row + left];
      }
    }

    for (let x = 0; x < width; x++) {
      let sum = 0;
      const win = r * 2 + 1;
      for (let k = -r; k <= r; k++) {
        const sy = Math.max(0, Math.min(height - 1, k));
        sum += temp[sy * width + x];
      }
      for (let y = 0; y < height; y++) {
        const idx = y * width + x;
        const orig = alpha[idx];
        const avg = sum / win;
        if (orig === 255 && avg > 245) {
          blurred[idx] = 255;
        } else if (orig === 0 && avg < 10) {
          blurred[idx] = 0;
        } else {
          blurred[idx] = Math.max(0, Math.min(255, Math.round(avg)));
        }
        const top = Math.max(0, y - r);
        const bottom = Math.min(height - 1, y + r + 1);
        sum += temp[bottom * width + x] - temp[top * width + x];
      }
    }
    alpha = blurred;
  }

  // 6. Apply manual brush mask overrides
  if (options.brushMask && options.brushMask.data.length > 0) {
    const bm = options.brushMask;
    const scaleX = bm.width / width;
    const scaleY = bm.height / height;
    for (let y = 0; y < height; y++) {
      const by = Math.min(bm.height - 1, Math.floor(y * scaleY));
      const row = y * width;
      const bRow = by * bm.width;
      for (let x = 0; x < width; x++) {
        const bx = Math.min(bm.width - 1, Math.floor(x * scaleX));
        const val = bm.data[bRow + bx];
        if (val === 1) {
          alpha[row + x] = 0;
        } else if (val === 2) {
          alpha[row + x] = 255;
        }
      }
    }
  }

  // 7. Color Decontamination (Defringe) & write output RGBA
  const defringeFactor = Math.max(0, Math.min(1, options.defringe / 100));
  for (let i = 0; i < total; i++) {
    const p = i * 4;
    const origA = source[p + 3];
    const finalA = origA === 0 ? 0 : Math.min(origA, alpha[i]);
    out[p + 3] = finalA;

    if (defringeFactor > 0 && finalA > 4 && finalA < 246) {
      const cl = clusters[nearestClusterIdx[i]];
      const aNorm = finalA / 255;
      const invA = 1 - aNorm;
      const denom = Math.max(0.28, aNorm);

      const estR = Math.max(0, Math.min(255, (source[p] - invA * cl.r) / denom));
      const estG = Math.max(0, Math.min(255, (source[p + 1] - invA * cl.g) / denom));
      const estB = Math.max(0, Math.min(255, (source[p + 2] - invA * cl.blue) / denom));

      out[p] = Math.round(source[p] * (1 - defringeFactor) + estR * defringeFactor);
      out[p + 1] = Math.round(source[p + 1] * (1 - defringeFactor) + estG * defringeFactor);
      out[p + 2] = Math.round(source[p + 2] * (1 - defringeFactor) + estB * defringeFactor);
    }
  }

  return out;
}
