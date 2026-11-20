import JSZip from 'jszip';
import { applyPostMaskRefinement, removeBackgroundRGBA } from '../shared/bgRemoval';
import type { BrushHistoryState, CropRect, EngineSettings, ProcessedOutput } from '../types/studio';

export interface CachedProxyImage {
  width: number;
  height: number;
  sourceImageData: ImageData;
}

const proxyCache = new Map<string, CachedProxyImage>();
const MAX_PREVIEW_DIM = 820;

export async function safeFetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const rawText = await response.text();
  const trimmed = rawText.trimStart();

  if (trimmed.startsWith('<')) {
    if (response.status === 413) {
      throw new Error(
        'La imagen supera el límite de transferencia del servidor (HTTP 413). Reduce la escala o procesa un formato más ligero.',
      );
    }
    if (response.status === 502 || response.status === 504) {
      throw new Error(
        `El servidor tardó demasiado en responder (HTTP ${response.status}). Intenta reducir el tamaño de salida.`,
      );
    }
    throw new Error(
      `El servidor devolvió una respuesta HTML inesperada (HTTP ${response.status}).`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error(`Respuesta inválida del servidor (HTTP ${response.status}).`);
  }

  if (!response.ok) {
    const errMsg =
      parsed && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : `Error del servidor (HTTP ${response.status}).`;
    throw new Error(errMsg);
  }

  return parsed as T;
}

/**
 * Prevents giant uncompressed RGBA PNG blobs (> 10 MB) from hitting reverse-proxy 413 limits
 * by encoding them as lossless/near-lossless WebP with full alpha before sending to Sharp/Jimp.
 */
export async function compactUploadBlobIfNeeded(blob: Blob): Promise<Blob> {
  const MAX_DIRECT_BYTES = 10 * 1024 * 1024;
  if (blob.size <= MAX_DIRECT_BYTES) {
    return blob;
  }

  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('No se pudo compactar la imagen para envío.'));
      img.src = url;
    });

    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return blob;
    ctx.drawImage(img, 0, 0);

    const webpBlob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/webp', 0.98),
    );
    if (webpBlob && webpBlob.size < blob.size) {
      return webpBlob;
    }
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function loadProxyImage(itemId: string, objectUrl: string): Promise<{
  proxy: CachedProxyImage;
  naturalWidth: number;
  naturalHeight: number;
}> {
  const existing = proxyCache.get(itemId);

  const img = new Image();
  img.crossOrigin = 'anonymous';
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('No se pudo cargar la imagen para previsualización.'));
    img.src = objectUrl;
  });

  const naturalWidth = img.naturalWidth;
  const naturalHeight = img.naturalHeight;

  if (existing) {
    return { proxy: existing, naturalWidth, naturalHeight };
  }

  const scale = Math.min(1, MAX_PREVIEW_DIM / Math.max(naturalWidth, naturalHeight));
  const width = Math.max(1, Math.round(naturalWidth * scale));
  const height = Math.max(1, Math.round(naturalHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    throw new Error('Contexto 2D no disponible.');
  }
  ctx.drawImage(img, 0, 0, width, height);
  const sourceImageData = ctx.getImageData(0, 0, width, height);

  const proxy: CachedProxyImage = { width, height, sourceImageData };
  proxyCache.set(itemId, proxy);
  return { proxy, naturalWidth, naturalHeight };
}

export function clearProxyCache(itemId: string): void {
  proxyCache.delete(itemId);
}

function applySolidBackdropPreview(
  rgba: Uint8ClampedArray,
  settings: EngineSettings,
): void {
  const needsSolid = settings.format === 'jpg' || settings.useSolidBackground;
  if (!needsSolid) return;

  const clean = settings.backgroundColor.replace('#', '').trim();
  const rBg = /^[0-9a-fA-F]{6}$/.test(clean) ? parseInt(clean.slice(0, 2), 16) : 255;
  const gBg = /^[0-9a-fA-F]{6}$/.test(clean) ? parseInt(clean.slice(2, 4), 16) : 255;
  const bBg = /^[0-9a-fA-F]{6}$/.test(clean) ? parseInt(clean.slice(4, 6), 16) : 255;

  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3] / 255;
    const inv = 1 - a;
    rgba[i] = Math.round(rgba[i] * a + rBg * inv);
    rgba[i + 1] = Math.round(rgba[i + 1] * a + gBg * inv);
    rgba[i + 2] = Math.round(rgba[i + 2] * a + bBg * inv);
    rgba[i + 3] = 255;
  }
}

export function renderImglyPreview(
  proxy: CachedProxyImage,
  imglyImageData: ImageData,
  settings: EngineSettings,
  brushLayer?: BrushHistoryState,
  imglyDurationMs?: number,
): {
  processedImageData: ImageData;
  durationMs: number;
  transparentRatio: number;
} {
  const refined = applyPostMaskRefinement(
    imglyImageData.data,
    imglyImageData.width,
    imglyImageData.height,
    brushLayer
      ? {
          width: brushLayer.width,
          height: brushLayer.height,
          data: brushLayer.data,
        }
      : undefined,
    proxy.sourceImageData.data,
  );

  let transparentPixels = 0;
  const totalPixels = imglyImageData.width * imglyImageData.height;
  for (let i = 3; i < refined.length; i += 4) {
    if (refined[i] < 128) transparentPixels++;
  }

  applySolidBackdropPreview(refined, settings);

  return {
    processedImageData: new ImageData(
      new Uint8ClampedArray(refined),
      imglyImageData.width,
      imglyImageData.height,
    ),
    durationMs: imglyDurationMs ?? 1,
    transparentRatio: totalPixels > 0 ? (transparentPixels / totalPixels) * 100 : 0,
  };
}

export function renderRealtimePreview(
  proxy: CachedProxyImage,
  settings: EngineSettings,
  brushLayer?: BrushHistoryState,
): {
  processedImageData: ImageData;
  durationMs: number;
  transparentRatio: number;
} {
  const t0 = performance.now();
  const processedRgba = removeBackgroundRGBA(
    proxy.sourceImageData.data,
    proxy.width,
    proxy.height,
    {
      ...settings.removal,
      brushMask: brushLayer
        ? {
            width: brushLayer.width,
            height: brushLayer.height,
            data: brushLayer.data,
          }
        : undefined,
    },
  );

  let transparentPixels = 0;
  const totalPixels = proxy.width * proxy.height;
  for (let i = 3; i < processedRgba.length; i += 4) {
    if (processedRgba[i] < 128) transparentPixels++;
  }

  applySolidBackdropPreview(processedRgba, settings);

  const durationMs = Math.max(1, Math.round(performance.now() - t0));
  const transparentRatio = totalPixels > 0 ? (transparentPixels / totalPixels) * 100 : 0;

  return {
    processedImageData: new ImageData(new Uint8ClampedArray(processedRgba), proxy.width, proxy.height),
    durationMs,
    transparentRatio,
  };
}

/**
 * Computes a tight bounding box around non-transparent pixels (+ 3% padding)
 * so the crop handles snap around the isolated subject.
 */
export function computeSubjectTrimRect(imageData: ImageData): CropRect | null {
  const { width, height, data } = imageData;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (data[(row + x) * 4 + 3] > 20) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) return null;

  const padX = Math.max(2, Math.round((maxX - minX) * 0.03));
  const padY = Math.max(2, Math.round((maxY - minY) * 0.03));

  const x0 = Math.max(0, minX - padX);
  const y0 = Math.max(0, minY - padY);
  const x1 = Math.min(width, maxX + 1 + padX);
  const y1 = Math.min(height, maxY + 1 + padY);

  return {
    x: x0 / width,
    y: y0 / height,
    w: Math.max(0.05, (x1 - x0) / width),
    h: Math.max(0.05, (y1 - y0) / height),
  };
}

export function computeEffectiveDimensions(
  naturalWidth: number,
  naturalHeight: number,
  settings: EngineSettings,
): { width: number; height: number } {
  if (naturalWidth <= 0 || naturalHeight <= 0) {
    return { width: 0, height: 0 };
  }
  let w = settings.cropRect ? Math.round(naturalWidth * settings.cropRect.w) : naturalWidth;
  let h = settings.cropRect ? Math.round(naturalHeight * settings.cropRect.h) : naturalHeight;

  let targetW = w;
  if (settings.scalePercent < 100) {
    targetW = Math.max(16, Math.round((w * settings.scalePercent) / 100));
  }
  if (settings.maxWidth > 0 && targetW > settings.maxWidth) {
    targetW = settings.maxWidth;
  }
  if (targetW < w) {
    h = Math.max(1, Math.round((h * targetW) / w));
    w = targetW;
  }
  return { width: w, height: h };
}

export function estimateOutputBytes(
  outWidth: number,
  outHeight: number,
  settings: EngineSettings,
): number {
  const pixels = outWidth * outHeight;
  if (pixels <= 0) return 0;
  const q = settings.quality / 100;

  if (settings.format === 'jpg') {
    return Math.round(pixels * (0.08 + q * q * 0.42));
  }
  if (settings.format === 'webp') {
    return Math.round(pixels * (0.05 + q * q * 0.28));
  }
  // PNG: palette quantization cuts size dramatically vs full 32-bit RGBA
  if (settings.pngOptimize) {
    const colorFactor = 0.35 + (settings.pngColors / 256) * 0.45;
    return Math.round(pixels * 0.42 * colorFactor);
  }
  return Math.round(pixels * (0.75 + (1 - q) * 0.15));
}

export function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const sub = bytes.subarray(i, Math.min(i + chunk, bytes.length));
    binary += String.fromCharCode(...sub);
  }
  return btoa(binary);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function downloadDataUrl(dataUrl: string, filename: string): void {
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export async function downloadBatchZip(outputs: ProcessedOutput[]): Promise<void> {
  const zip = new JSZip();
  const usedNames = new Map<string, number>();

  for (const out of outputs) {
    const commaIdx = out.dataUrl.indexOf(',');
    const base64 = commaIdx >= 0 ? out.dataUrl.slice(commaIdx + 1) : out.dataUrl;

    let finalName = out.filename;
    const count = usedNames.get(finalName) || 0;
    if (count > 0) {
      const dot = finalName.lastIndexOf('.');
      if (dot > 0) {
        finalName = `${finalName.slice(0, dot)}_${count + 1}${finalName.slice(dot)}`;
      } else {
        finalName = `${finalName}_${count + 1}`;
      }
    }
    usedNames.set(out.filename, count + 1);

    zip.file(finalName, base64, { base64: true });
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `recorte-studio-lote-${outputs.length}.zip`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
