import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import { Jimp, JimpMime } from 'jimp';
import { createServer as createViteServer } from 'vite';
import {
  applyPostMaskRefinement,
  DEFAULT_REMOVAL_OPTIONS,
  removeBackgroundRGBA,
  type BrushMaskLayer,
  type ExportFormat,
  type ProcessingEngine,
  type RemovalOptions,
} from './src/shared/bgRemoval.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);

interface ProcessSettings {
  engine: ProcessingEngine;
  format: ExportFormat;
  quality: number;
  maxWidth: number;
  backgroundColor: string;
  useSolidBackground: boolean;
  preSegmented?: boolean;
  removal: RemovalOptions;
}

function parseHexColor(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '').trim();
  if (/^[0-9a-fA-F]{6}$/.test(clean)) {
    return {
      r: parseInt(clean.slice(0, 2), 16),
      g: parseInt(clean.slice(2, 4), 16),
      b: parseInt(clean.slice(4, 6), 16),
    };
  }
  return { r: 255, g: 255, b: 255 };
}

function compositeOnSolidRgb(
  rgba: Uint8ClampedArray,
  bg: { r: number; g: number; b: number },
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3] / 255;
    const inv = 1 - a;
    out[i] = Math.round(rgba[i] * a + bg.r * inv);
    out[i + 1] = Math.round(rgba[i + 1] * a + bg.g * inv);
    out[i + 2] = Math.round(rgba[i + 2] * a + bg.b * inv);
    out[i + 3] = 255;
  }
  return out;
}

function parseBrushMask(rawMask: unknown): BrushMaskLayer | undefined {
  if (!rawMask || typeof rawMask !== 'object') return undefined;
  const candidate = rawMask as { width?: number; height?: number; base64?: string };
  if (
    typeof candidate.width === 'number' &&
    typeof candidate.height === 'number' &&
    typeof candidate.base64 === 'string' &&
    candidate.width > 0 &&
    candidate.height > 0
  ) {
    const buf = Buffer.from(candidate.base64, 'base64');
    return {
      width: candidate.width,
      height: candidate.height,
      data: new Uint8Array(buf),
    };
  }
  return undefined;
}

function parseSettings(rawJson: string | undefined): ProcessSettings {
  let parsed: Partial<ProcessSettings> = {};
  if (rawJson) {
    try {
      parsed = JSON.parse(rawJson) as Partial<ProcessSettings>;
    } catch {
      parsed = {};
    }
  }

  const removalRaw: Partial<RemovalOptions> = parsed.removal || {};
  return {
    engine: parsed.engine === 'jimp' ? 'jimp' : 'sharp',
    format:
      parsed.format === 'jpg' || parsed.format === 'webp' || parsed.format === 'png'
        ? parsed.format
        : 'png',
    quality: Math.max(10, Math.min(100, Number(parsed.quality) || 90)),
    maxWidth: Math.max(0, Number(parsed.maxWidth) || 0),
    backgroundColor: typeof parsed.backgroundColor === 'string' ? parsed.backgroundColor : '#ffffff',
    useSolidBackground: Boolean(parsed.useSolidBackground),
    preSegmented: Boolean(parsed.preSegmented),
    removal: {
      mode:
        removalRaw.mode === 'chroma' || removalRaw.mode === 'silhouette' ? removalRaw.mode : 'auto',
      illustrationStrategy:
        removalRaw.illustrationStrategy === 'color-to-alpha' ||
        removalRaw.illustrationStrategy === 'corner-edge'
          ? removalRaw.illustrationStrategy
          : 'auto',
      colorToAlphaTarget:
        removalRaw.colorToAlphaTarget === 'white' || removalRaw.colorToAlphaTarget === 'black'
          ? removalRaw.colorToAlphaTarget
          : 'auto',
      tolerance: Math.max(4, Math.min(120, Number(removalRaw.tolerance) || DEFAULT_REMOVAL_OPTIONS.tolerance)),
      feather: Math.max(0, Math.min(12, Number(removalRaw.feather) ?? DEFAULT_REMOVAL_OPTIONS.feather)),
      edgeShift: Math.max(-4, Math.min(6, Number(removalRaw.edgeShift) ?? DEFAULT_REMOVAL_OPTIONS.edgeShift)),
      defringe: Math.max(0, Math.min(100, Number(removalRaw.defringe) ?? DEFAULT_REMOVAL_OPTIONS.defringe)),
      removeInteriorHoles:
        typeof removalRaw.removeInteriorHoles === 'boolean'
          ? removalRaw.removeInteriorHoles
          : DEFAULT_REMOVAL_OPTIONS.removeInteriorHoles,
      targetColors: Array.isArray(removalRaw.targetColors) ? removalRaw.targetColors : [],
    },
  };
}

function replaceExtension(filename: string, format: ExportFormat): string {
  const base = path.parse(filename).name || 'imagen';
  return `${base}_recorte.${format}`;
}

function mimeForFormat(format: ExportFormat): string {
  if (format === 'jpg') return 'image/jpeg';
  if (format === 'webp') return 'image/webp';
  return 'image/png';
}

async function processWithSharp(
  inputBuffer: Buffer,
  settings: ProcessSettings,
  brushMask?: BrushMaskLayer,
): Promise<{ outputBuffer: Buffer; width: number; height: number; engineLabel: string }> {
  let pipeline = sharp(inputBuffer).rotate();
  const meta = await pipeline.metadata();

  if (settings.maxWidth > 0 && meta.width && meta.width > settings.maxWidth) {
    pipeline = pipeline.resize({ width: settings.maxWidth, withoutEnlargement: true });
  }

  const { data, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  const processed = settings.preSegmented
    ? applyPostMaskRefinement(data, info.width, info.height, brushMask)
    : removeBackgroundRGBA(data, info.width, info.height, {
        ...settings.removal,
        brushMask,
      });

  const needsFlatten = settings.format === 'jpg' || settings.useSolidBackground;
  const finalRgba = needsFlatten
    ? compositeOnSolidRgb(processed, parseHexColor(settings.backgroundColor))
    : processed;

  let outSharp = sharp(Buffer.from(finalRgba.buffer, finalRgba.byteOffset, finalRgba.byteLength), {
    raw: { width: info.width, height: info.height, channels: 4 },
  });

  if (settings.format === 'jpg') {
    outSharp = outSharp.flatten({ background: parseHexColor(settings.backgroundColor) }).jpeg({
      quality: settings.quality,
      mozjpeg: true,
    });
  } else if (settings.format === 'webp') {
    outSharp = outSharp.webp({
      quality: settings.quality,
      alphaQuality: 100,
      effort: 4,
    });
  } else {
    outSharp = outSharp.png({
      compressionLevel: Math.max(1, Math.min(9, Math.round((100 - settings.quality) / 10) + 4)),
      adaptiveFiltering: true,
    });
  }

  const outputBuffer = await outSharp.toBuffer();
  return {
    outputBuffer,
    width: info.width,
    height: info.height,
    engineLabel: 'Sharp (libvips)',
  };
}

async function processWithJimp(
  inputBuffer: Buffer,
  settings: ProcessSettings,
  brushMask?: BrushMaskLayer,
): Promise<{ outputBuffer: Buffer; width: number; height: number; engineLabel: string }> {
  let readableBuffer = inputBuffer;
  // Jimp natively decodes PNG, JPEG, BMP, TIFF, GIF; normalize WebP/AVIF via Sharp if supplied
  const detectedMeta = await sharp(inputBuffer).metadata();
  const jimpNativeFormats = new Set(['png', 'jpeg', 'bmp', 'tiff', 'gif']);
  if (
    !detectedMeta.format ||
    !jimpNativeFormats.has(detectedMeta.format) ||
    (detectedMeta.orientation && detectedMeta.orientation > 1)
  ) {
    readableBuffer = await sharp(inputBuffer).rotate().png().toBuffer();
  }

  const image = await Jimp.read(readableBuffer);
  if (settings.maxWidth > 0 && image.width > settings.maxWidth) {
    image.resize({ w: settings.maxWidth });
  }

  const width = image.width;
  const height = image.height;
  const rawBytes = new Uint8ClampedArray(
    image.bitmap.data.buffer,
    image.bitmap.data.byteOffset,
    image.bitmap.data.byteLength,
  );

  const processed = settings.preSegmented
    ? applyPostMaskRefinement(rawBytes, width, height, brushMask)
    : removeBackgroundRGBA(rawBytes, width, height, {
        ...settings.removal,
        brushMask,
      });

  const needsFlatten = settings.format === 'jpg' || settings.useSolidBackground;
  const finalRgba = needsFlatten
    ? compositeOnSolidRgb(processed, parseHexColor(settings.backgroundColor))
    : processed;

  // Write processed pixels back into Jimp bitmap
  image.bitmap.data.set(finalRgba);

  let outputBuffer: Buffer;
  let engineLabel = 'Jimp (JS puro)';

  if (settings.format === 'jpg') {
    outputBuffer = await image.getBuffer(JimpMime.jpeg, { quality: settings.quality });
  } else if (settings.format === 'webp') {
    // Jimp does not ship a native WebP encoder; bridge its processed bitmap via Sharp WebP encoder
    outputBuffer = await sharp(
      Buffer.from(finalRgba.buffer, finalRgba.byteOffset, finalRgba.byteLength),
      { raw: { width, height, channels: 4 } },
    )
      .webp({ quality: settings.quality, alphaQuality: 100 })
      .toBuffer();
    engineLabel = 'Jimp + WebP';
  } else {
    outputBuffer = await image.getBuffer(JimpMime.png);
  }

  return {
    outputBuffer,
    width,
    height,
    engineLabel,
  };
}

async function processSingleFile(
  file: Express.Multer.File,
  settings: ProcessSettings,
  brushMask?: BrushMaskLayer,
) {
  const t0 = performance.now();
  const result =
    settings.engine === 'jimp'
      ? await processWithJimp(file.buffer, settings, brushMask)
      : await processWithSharp(file.buffer, settings, brushMask);
  const durationMs = Math.max(1, Math.round(performance.now() - t0));
  const mimeType = mimeForFormat(settings.format);
  const outFilename = replaceExtension(file.originalname, settings.format);

  return {
    originalName: file.originalname,
    filename: outFilename,
    mimeType,
    format: settings.format,
    width: result.width,
    height: result.height,
    originalBytes: file.size,
    outputBytes: result.outputBuffer.length,
    durationMs,
    engineUsed: result.engineLabel,
    dataUrl: `data:${mimeType};base64,${result.outputBuffer.toString('base64')}`,
  };
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '50mb' }));

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 25 * 1024 * 1024,
      files: 30,
    },
  });

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      engines: {
        sharp: true,
        jimp: true,
      },
    });
  });

  app.post('/api/process', upload.single('image'), async (req: Request, res: Response) => {
    try {
      const file = req.file;
      if (!file) {
        res.status(400).json({ error: 'No se recibió ninguna imagen para procesar.' });
        return;
      }

      const settings = parseSettings(typeof req.body?.settings === 'string' ? req.body.settings : undefined);
      if (req.body?.preSegmented === 'true' || req.body?.preSegmented === true) {
        settings.preSegmented = true;
      }
      let brushMask: BrushMaskLayer | undefined;
      if (typeof req.body?.brushMask === 'string' && req.body.brushMask.length > 0) {
        try {
          brushMask = parseBrushMask(JSON.parse(req.body.brushMask));
        } catch {
          brushMask = undefined;
        }
      }

      const result = await processSingleFile(file, settings, brushMask);
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al procesar la imagen.';
      res.status(500).json({ error: message });
    }
  });

  app.post('/api/process-batch', upload.array('images', 30), async (req: Request, res: Response) => {
    try {
      const files = req.files as Express.Multer.File[] | undefined;
      if (!files || files.length === 0) {
        res.status(400).json({ error: 'No se recibieron imágenes para procesar en el lote.' });
        return;
      }

      const globalSettings = parseSettings(
        typeof req.body?.settings === 'string' ? req.body.settings : undefined,
      );

      let perItemMap: Record<
        string,
        { settings?: Partial<ProcessSettings>; brushMask?: unknown }
      > = {};
      if (typeof req.body?.itemOverrides === 'string') {
        try {
          perItemMap = JSON.parse(req.body.itemOverrides);
        } catch {
          perItemMap = {};
        }
      }

      let clientIds: string[] = [];
      if (typeof req.body?.clientIds === 'string') {
        try {
          clientIds = JSON.parse(req.body.clientIds);
        } catch {
          clientIds = [];
        }
      }

      const t0 = performance.now();
      const concurrency = 4;
      const results: Array<Record<string, unknown>> = new Array(files.length);

      let cursor = 0;
      const workers = Array.from({ length: Math.min(concurrency, files.length) }, async () => {
        while (cursor < files.length) {
          const index = cursor++;
          const file = files[index];
          const clientId = clientIds[index] || String(index);
          const override = perItemMap[clientId];

          const mergedSettings: ProcessSettings = override?.settings
            ? {
                ...globalSettings,
                ...override.settings,
                preSegmented: Boolean(override.settings.preSegmented ?? globalSettings.preSegmented),
                removal: {
                  ...globalSettings.removal,
                  ...(override.settings.removal || {}),
                },
              }
            : globalSettings;

          const brushMask = override?.brushMask ? parseBrushMask(override.brushMask) : undefined;

          try {
            const processed = await processSingleFile(file, mergedSettings, brushMask);
            results[index] = {
              clientId,
              ok: true,
              ...processed,
            };
          } catch (err) {
            results[index] = {
              clientId,
              ok: false,
              originalName: file.originalname,
              error: err instanceof Error ? err.message : 'Fallo al procesar archivo',
            };
          }
        }
      });

      await Promise.all(workers);
      const totalDurationMs = Math.max(1, Math.round(performance.now() - t0));

      res.json({
        results,
        totalDurationMs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al procesar el lote.';
      res.status(500).json({ error: message });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Recorte Studio server running on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
