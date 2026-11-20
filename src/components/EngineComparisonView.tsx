import React, { useState } from 'react';
import { Gauge, Play } from 'lucide-react';
import type { BatchItem, ProcessedOutput } from '../types/studio';
import { runImglySegmentation } from '../utils/imglyProcessor';
import {
  compactUploadBlobIfNeeded,
  formatBytes,
  safeFetchJson,
  uint8ToBase64,
} from '../utils/previewProcessor';

interface EngineComparisonViewProps {
  activeItem: BatchItem | null;
}

interface BenchmarkPair {
  sharp: ProcessedOutput;
  jimp: ProcessedOutput;
  imageName: string;
}

export const EngineComparisonView: React.FC<EngineComparisonViewProps> = ({ activeItem }) => {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [benchmark, setBenchmark] = useState<BenchmarkPair | null>(null);

  const runLiveBenchmark = async () => {
    if (!activeItem) return;
    setRunning(true);
    setError(null);

    const runOne = async (engine: 'sharp' | 'jimp'): Promise<ProcessedOutput> => {
      const fd = new FormData();
      let uploadBlob: Blob = activeItem.file;
      let preSegmented = false;

      if (activeItem.settings.pipelineMode === 'photo') {
        const segmented = await runImglySegmentation(
          activeItem.id,
          activeItem.file,
          activeItem.settings.imglyModel,
        );
        uploadBlob = segmented.blob;
        preSegmented = true;
      }

      uploadBlob = await compactUploadBlobIfNeeded(uploadBlob);
      fd.append('image', uploadBlob, activeItem.name);
      fd.append(
        'settings',
        JSON.stringify({
          ...activeItem.settings,
          engine,
          preSegmented,
        }),
      );
      const currentBrush =
        activeItem.brushIndex >= 0 ? activeItem.brushHistory[activeItem.brushIndex] : undefined;
      if (currentBrush) {
        fd.append(
          'brushMask',
          JSON.stringify({
            width: currentBrush.width,
            height: currentBrush.height,
            base64: uint8ToBase64(currentBrush.data),
          }),
        );
      }

      return safeFetchJson<ProcessedOutput>('/api/process', { method: 'POST', body: fd });
    };

    try {
      const sharpRes = await runOne('sharp');
      const jimpRes = await runOne('jimp');
      setBenchmark({
        sharp: sharpRes,
        jimp: jimpRes,
        imageName: activeItem.name,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo ejecutar la comparativa.');
    } finally {
      setRunning(false);
    }
  };

  return (
    <section
      id="comparativa-motores"
      className="rounded-xl border border-neutral-200 bg-white p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-neutral-200 pb-4">
        <div>
          <h2 className="font-display text-lg font-semibold text-neutral-900">
            Comparativa técnica: Sharp vs Jimp
          </h2>
          <p className="mt-1 text-sm text-neutral-600">
            Ejecuta el procesamiento real sobre la imagen activa con ambos motores en el servidor para comparar tiempos y tamaño de salida.
          </p>
        </div>

        <button
          type="button"
          disabled={!activeItem || running}
          onClick={runLiveBenchmark}
          className="inline-flex h-10 items-center gap-2 rounded-lg border border-neutral-300 bg-white px-4 text-sm font-medium text-neutral-900 transition-colors hover:bg-neutral-50 disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
        >
          {running ? (
            <>
              <Gauge className="h-4 w-4 animate-spin" />
              <span>Midiendo ambos motores...</span>
            </>
          ) : (
            <>
              <Play className="h-4 w-4" />
              <span>
                {activeItem
                  ? `Comparar con "${activeItem.name}"`
                  : 'Carga una imagen para comparar'}
              </span>
            </>
          )}
        </button>
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="mt-5 grid grid-cols-1 gap-6 md:grid-cols-2">
        {/* Sharp Specification */}
        <div className="rounded-lg border border-neutral-200 p-5">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="font-display text-base font-semibold text-neutral-900">
              Sharp (libvips C++)
            </h3>
            <span className="text-xs font-medium text-blue-700">Recomendado para lotes</span>
          </div>
          <p className="mt-2 text-sm text-neutral-600 leading-relaxed">
            Usa instrucciones SIMD nativas y streaming de memoria mediante libvips. Ideal para lotes grandes y compresión nativa WebP, MozJPEG y PNG adaptativo.
          </p>
          {benchmark && (
            <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-neutral-200 pt-3 text-xs">
              <div>
                <dt className="text-neutral-500">Tiempo real</dt>
                <dd className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-neutral-900">
                  {benchmark.sharp.durationMs} ms
                </dd>
              </div>
              <div>
                <dt className="text-neutral-500">Peso salida</dt>
                <dd className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-neutral-900">
                  {formatBytes(benchmark.sharp.outputBytes)}
                </dd>
              </div>
              <div>
                <dt className="text-neutral-500">Formato</dt>
                <dd className="mt-0.5 font-mono text-sm font-semibold text-neutral-900">
                  {benchmark.sharp.format.toUpperCase()}
                </dd>
              </div>
            </dl>
          )}
        </div>

        {/* Jimp Specification */}
        <div className="rounded-lg border border-neutral-200 p-5">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="font-display text-base font-semibold text-neutral-900">
              Jimp (JavaScript puro)
            </h3>
            <span className="text-xs font-medium text-neutral-500">Cero dependencias nativas</span>
          </div>
          <p className="mt-2 text-sm text-neutral-600 leading-relaxed">
            Decodificación y manipulación directa de bitmaps RGBA en JavaScript puro. Excelente portabilidad y control directo sobre cada píxel exportado en PNG y JPEG.
          </p>
          {benchmark && (
            <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-neutral-200 pt-3 text-xs">
              <div>
                <dt className="text-neutral-500">Tiempo real</dt>
                <dd className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-neutral-900">
                  {benchmark.jimp.durationMs} ms
                </dd>
              </div>
              <div>
                <dt className="text-neutral-500">Peso salida</dt>
                <dd className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-neutral-900">
                  {formatBytes(benchmark.jimp.outputBytes)}
                </dd>
              </div>
              <div>
                <dt className="text-neutral-500">Formato</dt>
                <dd className="mt-0.5 font-mono text-sm font-semibold text-neutral-900">
                  {benchmark.jimp.format.toUpperCase()}
                </dd>
              </div>
            </dl>
          )}
        </div>
      </div>
    </section>
  );
};
