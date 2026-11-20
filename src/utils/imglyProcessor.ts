import { removeBackground, type Config } from '@imgly/background-removal';
import type { ImglyModelSize } from '../types/studio';

export interface ImglyCachedResult {
  blob: Blob;
  proxyImageData: ImageData;
  width: number;
  height: number;
  durationMs: number;
}

export interface ImglyProgressInfo {
  stage: string;
  percent: number;
}

const MAX_PREVIEW_DIM = 820;
const imglyCache = new Map<string, ImglyCachedResult>();
const inFlight = new Map<string, Promise<ImglyCachedResult>>();

function cacheKey(itemId: string, model: ImglyModelSize): string {
  return `${itemId}::${model}`;
}

export function getCachedImglyResult(
  itemId: string,
  model: ImglyModelSize,
): ImglyCachedResult | undefined {
  return imglyCache.get(cacheKey(itemId, model));
}

export function clearImglyCacheForItem(itemId: string): void {
  imglyCache.delete(cacheKey(itemId, 'medium'));
  imglyCache.delete(cacheKey(itemId, 'large'));
}

function translateStage(key: string): string {
  if (key.includes('fetch')) return 'Descargando modelo neuronal';
  if (key.includes('compute:inference')) return 'Segmentando sujeto y cabello';
  if (key.includes('compute')) return 'Procesando máscara alfa';
  return 'Preparando @imgly/background-removal';
}

async function blobToProxyImageData(
  blob: Blob,
): Promise<{ imageData: ImageData; width: number; height: number }> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('No se pudo decodificar el resultado de @imgly.'));
      img.src = url;
    });

    const scale = Math.min(1, MAX_PREVIEW_DIM / Math.max(img.naturalWidth, img.naturalHeight));
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      throw new Error('Contexto 2D no disponible.');
    }
    ctx.drawImage(img, 0, 0, width, height);
    return {
      imageData: ctx.getImageData(0, 0, width, height),
      width,
      height,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function runImglySegmentation(
  itemId: string,
  source: File | Blob | string,
  model: ImglyModelSize,
  onProgress?: (info: ImglyProgressInfo) => void,
): Promise<ImglyCachedResult> {
  const key = cacheKey(itemId, model);
  const existing = imglyCache.get(key);
  if (existing) {
    return existing;
  }

  const pending = inFlight.get(key);
  if (pending) {
    return pending;
  }

  const job = (async () => {
    const t0 = performance.now();
    const config: Config = {
      model: model === 'large' ? 'isnet' : 'isnet_fp16',
      output: {
        format: 'image/png',
        quality: 1,
      },
      progress: (stageKey: string, current: number, total: number) => {
        if (!onProgress) return;
        const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
        onProgress({
          stage: translateStage(stageKey),
          percent: pct,
        });
      },
    };

    const blob = await removeBackground(source, config);
    const { imageData, width, height } = await blobToProxyImageData(blob);
    const durationMs = Math.max(1, Math.round(performance.now() - t0));

    const result: ImglyCachedResult = {
      blob,
      proxyImageData: imageData,
      width,
      height,
      durationMs,
    };
    imglyCache.set(key, result);
    return result;
  })();

  inFlight.set(key, job);
  try {
    return await job;
  } finally {
    inFlight.delete(key);
  }
}
