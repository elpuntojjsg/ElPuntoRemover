import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Archive, CheckCircle2, AlertTriangle, X, Camera, Sparkles } from 'lucide-react';
import { DEFAULT_REMOVAL_OPTIONS, type PipelineMode } from './shared/bgRemoval';
import type {
  BatchItem,
  CanvasTool,
  CropRect,
  EngineSettings,
  PreviewBackdrop,
  ProcessedOutput,
  RgbColor,
  SamplePreset,
} from './types/studio';
import {
  clearImglyCacheForItem,
  runImglySegmentation,
} from './utils/imglyProcessor';
import {
  clearProxyCache,
  compactUploadBlobIfNeeded,
  downloadBatchZip,
  downloadDataUrl,
  loadProxyImage,
  safeFetchJson,
  uint8ToBase64,
} from './utils/previewProcessor';
import { DropZoneStage } from './components/DropZoneStage';
import { PreviewCanvas } from './components/PreviewCanvas';
import { InspectorPanel } from './components/InspectorPanel';
import { BatchQueueTable } from './components/BatchQueueTable';
import { EngineComparisonView } from './components/EngineComparisonView';

function createDefaultSettings(
  pipelineMode: PipelineMode = 'illustration',
  tolerance?: number,
): EngineSettings {
  return {
    pipelineMode,
    imglyModel: 'medium',
    engine: 'sharp',
    format: 'png',
    quality: 90,
    scalePercent: 100,
    maxWidth: 0,
    pngOptimize: false,
    pngColors: 256,
    backgroundColor: '#ffffff',
    useSolidBackground: false,
    cropRect: undefined,
    removal: {
      ...DEFAULT_REMOVAL_OPTIONS,
      tolerance: tolerance ?? DEFAULT_REMOVAL_OPTIONS.tolerance,
      targetColors: [],
    },
  };
}

export default function App() {
  const headerFileInputRef = useRef<HTMLInputElement>(null);

  const [items, setItems] = useState<BatchItem[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [defaultPipelineMode, setDefaultPipelineMode] = useState<PipelineMode>('illustration');
  const [tool, setTool] = useState<CanvasTool>('compare');
  const [backdrop, setBackdrop] = useState<PreviewBackdrop>('checkerboard');
  const [customBackdropColor, setCustomBackdropColor] = useState<string>('#e2e8f0');
  const [brushSize, setBrushSize] = useState<number>(22);

  const [loadingSamples, setLoadingSamples] = useState<boolean>(false);
  const [isProcessingCurrent, setIsProcessingCurrent] = useState<boolean>(false);
  const [isProcessingBatch, setIsProcessingBatch] = useState<boolean>(false);
  const [batchProgressText, setBatchProgressText] = useState<string | null>(null);
  const [downloadingZip, setDownloadingZip] = useState<boolean>(false);

  const [banner, setBanner] = useState<{
    type: 'success' | 'error';
    message: string;
    canDownloadZip?: boolean;
  } | null>(null);

  const activeItem = useMemo(
    () => items.find((i) => i.id === activeId) || items[0] || null,
    [items, activeId],
  );

  // Add local Files to queue and decode thumbnails/dimensions smoothly without blocking main thread
  const addFilesToQueue = useCallback(
    async (files: File[], presetTolerances?: number[]) => {
      if (files.length === 0) return;

      const availableSlots = Math.max(0, 30 - items.length);
      const accepted = files.slice(0, availableSlots > 0 ? availableSlots : 30);

      const created: BatchItem[] = accepted.map((file, idx) => {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${idx}`;
        const url = URL.createObjectURL(file);
        return {
          id,
          file,
          name: file.name,
          originalUrl: url,
          originalBytes: file.size,
          naturalWidth: 0,
          naturalHeight: 0,
          status: 'pending',
          settings: createDefaultSettings(defaultPipelineMode, presetTolerances?.[idx]),
          brushHistory: [],
          brushIndex: -1,
        };
      });

      setItems((prev) => [...prev, ...created].slice(0, 30));
      setActiveId((prevActive) => prevActive || created[0]?.id || '');
      setBanner(null);

      // Throttled 2-worker queue for decoding image dimensions without UI freeze
      let cursor = 0;
      const workerCount = Math.min(2, created.length);
      const workers = Array.from({ length: workerCount }, async () => {
        while (cursor < created.length) {
          const entry = created[cursor++];
          try {
            const { naturalWidth, naturalHeight } = await loadProxyImage(
              entry.id,
              entry.originalUrl,
            );
            setItems((prev) =>
              prev.map((item) =>
                item.id === entry.id
                  ? { ...item, naturalWidth, naturalHeight }
                  : item,
              ),
            );
          } catch {
            // Handled in canvas preview if image fails
          }
          // Yield to browser paint loop between images
          await new Promise((r) => setTimeout(r, 0));
        }
      });

      await Promise.all(workers);
    },
    [defaultPipelineMode, items.length],
  );

  // Clipboard paste support (Ctrl+V)
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const clipboardItems = e.clipboardData?.items;
      if (!clipboardItems) return;
      const pastedFiles: File[] = [];
      for (let i = 0; i < clipboardItems.length; i++) {
        const item = clipboardItems[i];
        if (item.type.startsWith('image/')) {
          const f = item.getAsFile();
          if (f) {
            const ext = f.type.split('/')[1] || 'png';
            pastedFiles.push(
              new File([f], `portapapeles-${Date.now()}.${ext}`, { type: f.type }),
            );
          }
        }
      }
      if (pastedFiles.length > 0) {
        addFilesToQueue(pastedFiles);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [addFilesToQueue]);

  const handleLoadSamples = async (presets: SamplePreset[]) => {
    setLoadingSamples(true);
    setBanner(null);
    try {
      const files: File[] = [];
      const tolerances: number[] = [];
      for (const preset of presets) {
        const resp = await fetch(preset.url);
        if (!resp.ok) {
          throw new Error(`No se pudo cargar la muestra ${preset.label}.`);
        }
        const blob = await resp.blob();
        files.push(new File([blob], preset.filename, { type: blob.type || 'image/jpeg' }));
        tolerances.push(preset.suggestedTolerance);
      }
      await addFilesToQueue(files, tolerances);
    } catch (err) {
      setBanner({
        type: 'error',
        message: err instanceof Error ? err.message : 'Error al cargar las imágenes de muestra.',
      });
    } finally {
      setLoadingSamples(false);
    }
  };

  const handlePreviewStats = useCallback(
    (itemId: string, renderMs: number, transparentRatio: number) => {
      setItems((prev) =>
        prev.map((item) =>
          item.id === itemId &&
          (item.previewRenderMs !== renderMs || item.previewTransparentRatio !== transparentRatio)
            ? { ...item, previewRenderMs: renderMs, previewTransparentRatio: transparentRatio }
            : item,
        ),
      );
    },
    [],
  );

  const handleUpdateActiveSettings = (nextSettings: EngineSettings) => {
    if (!activeItem) return;
    setDefaultPipelineMode(nextSettings.pipelineMode);
    if (nextSettings.pipelineMode === 'photo' && tool === 'eyedropper') {
      setTool('compare');
    }
    setItems((prev) =>
      prev.map((item) =>
        item.id === activeItem.id ? { ...item, settings: nextSettings } : item,
      ),
    );
  };

  const handleSwitchActivePipelineMode = (mode: PipelineMode) => {
    setDefaultPipelineMode(mode);
    if (!activeItem) return;
    if (mode === 'photo' && tool === 'eyedropper') {
      setTool('compare');
    }
    handleUpdateActiveSettings({
      ...activeItem.settings,
      pipelineMode: mode,
    });
  };

  const handleCropChange = (cropRect: CropRect | undefined) => {
    if (!activeItem) return;
    handleUpdateActiveSettings({
      ...activeItem.settings,
      cropRect,
    });
  };

  const handleApplySettingsToAll = () => {
    if (!activeItem) return;
    const base = activeItem.settings;
    setItems((prev) =>
      prev.map((item) => ({
        ...item,
        settings: {
          ...base,
          cropRect: item.id === activeItem.id ? base.cropRect : item.settings.cropRect,
          removal: {
            ...base.removal,
            targetColors: [...(base.removal.targetColors || [])],
          },
        },
      })),
    );
    setBanner({
      type: 'success',
      message: `Ajustes de optimización y recorte aplicados a los ${items.length} archivos (${
        base.pipelineMode === 'photo'
          ? `Modo Fotografía / Cabello · @imgly ${base.imglyModel}`
          : 'Modo Ilustración / Degradado'
      }, ${base.engine === 'sharp' ? 'Sharp' : 'Jimp'}, ${base.format.toUpperCase()} al ${base.scalePercent}%).`,
    });
  };

  const handlePickColor = (color: RgbColor) => {
    if (!activeItem) return;
    const currentColors = activeItem.settings.removal.targetColors || [];
    const nextColors = [...currentColors.slice(-4), color];
    handleUpdateActiveSettings({
      ...activeItem.settings,
      removal: {
        ...activeItem.settings.removal,
        targetColors: nextColors,
      },
    });
  };

  const handleCommitBrushStroke = (width: number, height: number, nextMask: Uint8Array) => {
    if (!activeItem) return;
    setItems((prev) =>
      prev.map((item) => {
        if (item.id !== activeItem.id) return item;
        const truncated = item.brushHistory.slice(0, item.brushIndex + 1);
        const updated = [...truncated, { width, height, data: new Uint8Array(nextMask) }].slice(-12);
        return {
          ...item,
          brushHistory: updated,
          brushIndex: updated.length - 1,
        };
      }),
    );
  };

  const handleUndoBrush = () => {
    if (!activeItem) return;
    setItems((prev) =>
      prev.map((item) =>
        item.id === activeItem.id && item.brushIndex >= 0
          ? { ...item, brushIndex: item.brushIndex - 1 }
          : item,
      ),
    );
  };

  const handleResetBrush = () => {
    if (!activeItem) return;
    setItems((prev) =>
      prev.map((item) =>
        item.id === activeItem.id ? { ...item, brushHistory: [], brushIndex: -1 } : item,
      ),
    );
  };

  const handleRemoveItem = (id: string) => {
    setItems((prev) => {
      const target = prev.find((i) => i.id === id);
      if (target) {
        URL.revokeObjectURL(target.originalUrl);
        clearProxyCache(id);
        clearImglyCacheForItem(id);
      }
      const remaining = prev.filter((i) => i.id !== id);
      if (activeId === id) {
        setActiveId(remaining[0]?.id || '');
      }
      return remaining;
    });
  };

  const handleClearAll = () => {
    for (const item of items) {
      URL.revokeObjectURL(item.originalUrl);
      clearProxyCache(item.id);
      clearImglyCacheForItem(item.id);
    }
    setItems([]);
    setActiveId('');
    setBanner(null);
  };

  const processItemOnServer = async (item: BatchItem): Promise<ProcessedOutput> => {
    let uploadBlob: Blob = item.file;
    let preSegmented = false;

    if (item.settings.pipelineMode === 'photo') {
      const segmented = await runImglySegmentation(
        item.id,
        item.file,
        item.settings.imglyModel,
      );
      uploadBlob = segmented.blob;
      preSegmented = true;
    }

    uploadBlob = await compactUploadBlobIfNeeded(uploadBlob);

    const fd = new FormData();
    fd.append('image', uploadBlob, item.name);
    fd.append(
      'settings',
      JSON.stringify({
        ...item.settings,
        preSegmented,
      }),
    );
    const brushLayer =
      item.brushIndex >= 0 ? item.brushHistory[item.brushIndex] : undefined;
    if (brushLayer) {
      fd.append(
        'brushMask',
        JSON.stringify({
          width: brushLayer.width,
          height: brushLayer.height,
          base64: uint8ToBase64(brushLayer.data),
        }),
      );
    }

    return safeFetchJson<ProcessedOutput>('/api/process', { method: 'POST', body: fd });
  };

  const handleProcessCurrent = async () => {
    if (!activeItem) return;
    setIsProcessingCurrent(true);
    setBanner(null);
    setItems((prev) =>
      prev.map((item) =>
        item.id === activeItem.id ? { ...item, status: 'processing', error: undefined } : item,
      ),
    );

    try {
      const output = await processItemOnServer(activeItem);
      setItems((prev) =>
        prev.map((item) =>
          item.id === activeItem.id ? { ...item, status: 'done', output, error: undefined } : item,
        ),
      );

      downloadDataUrl(output.dataUrl, output.filename);
      setBanner({
        type: 'success',
        message: `"${output.filename}" procesado en ${output.durationMs} ms con ${output.engineUsed}.`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Fallo en el procesamiento.';
      setItems((prev) =>
        prev.map((item) =>
          item.id === activeItem.id ? { ...item, status: 'error', error: message } : item,
        ),
      );
      setBanner({ type: 'error', message });
    } finally {
      setIsProcessingCurrent(false);
    }
  };

  const handleProcessBatch = async () => {
    if (items.length === 0) return;
    if (items.length === 1) {
      await handleProcessCurrent();
      return;
    }

    setIsProcessingBatch(true);
    setBanner(null);
    setBatchProgressText(`Preparando lote de ${items.length} imágenes...`);

    const t0 = performance.now();
    const snapshot = [...items];
    let completed = 0;
    let okCount = 0;
    let firstError: string | null = null;

    setItems((prev) => prev.map((item) => ({ ...item, status: 'pending', error: undefined })));

    // Process each image via /api/process with concurrency 2 so requests stay well below proxy payload limits
    let cursor = 0;
    const concurrency = Math.min(2, snapshot.length);

    const workers = Array.from({ length: concurrency }, async () => {
      while (cursor < snapshot.length) {
        const item = snapshot[cursor++];
        setItems((prev) =>
          prev.map((it) => (it.id === item.id ? { ...it, status: 'processing' } : it)),
        );
        setBatchProgressText(
          `Procesando ${completed + 1} de ${snapshot.length}: ${item.name}`,
        );

        try {
          const output = await processItemOnServer(item);
          okCount++;
          setItems((prev) =>
            prev.map((it) =>
              it.id === item.id ? { ...it, status: 'done', output, error: undefined } : it,
            ),
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Error al procesar archivo';
          if (!firstError) firstError = msg;
          setItems((prev) =>
            prev.map((it) => (it.id === item.id ? { ...it, status: 'error', error: msg } : it)),
          );
        } finally {
          completed++;
          setBatchProgressText(
            `Completadas ${completed} de ${snapshot.length} imágenes...`,
          );
        }
      }
    });

    await Promise.all(workers);

    const totalMs = Math.max(1, Math.round(performance.now() - t0));
    setIsProcessingBatch(false);
    setBatchProgressText(null);

    if (okCount === snapshot.length) {
      setBanner({
        type: 'success',
        message: `Lote completado: ${okCount} de ${snapshot.length} imágenes procesadas en ${totalMs} ms.`,
        canDownloadZip: okCount > 1,
      });
    } else if (okCount > 0) {
      setBanner({
        type: 'error',
        message: `Lote parcial: ${okCount} de ${snapshot.length} exportadas.${firstError ? ` Primer error: ${firstError}` : ''}`,
        canDownloadZip: okCount > 1,
      });
    } else {
      setBanner({
        type: 'error',
        message: firstError || 'No se pudo procesar ninguna imagen del lote.',
      });
    }
  };

  const handleDownloadZip = async () => {
    const outputs = items.filter((i) => i.status === 'done' && i.output).map((i) => i.output!);
    if (outputs.length === 0) return;
    setDownloadingZip(true);
    try {
      await downloadBatchZip(outputs);
    } finally {
      setDownloadingZip(false);
    }
  };

  const currentMode = activeItem ? activeItem.settings.pipelineMode : defaultPipelineMode;

  return (
    <div className="min-h-screen bg-[#F7F7F5] text-neutral-900 flex flex-col">
      {/* Top Bar Contract: 3 zones separated by gap-8 */}
      <header className="sticky top-0 z-30 border-b border-neutral-200 bg-white/95 backdrop-blur-xs">
        <div className="mx-auto flex h-16 max-w-[1440px] items-center justify-between gap-8 px-6">
          <a
            href="#estudio"
            className="font-display text-lg font-bold tracking-tight text-neutral-900 whitespace-nowrap shrink-0"
          >
            Recorte Studio
          </a>

          <nav
            aria-label="Navegación principal"
            className="hidden md:flex items-center gap-7 text-sm font-medium text-neutral-600"
          >
            <a
              href="#estudio"
              className="hover:text-neutral-900 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
            >
              Estudio
            </a>
            <a
              href="#cola-lote"
              className="hover:text-neutral-900 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
            >
              Cola de Lote
            </a>
            <a
              href="#comparativa-motores"
              className="hover:text-neutral-900 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
            >
              Motores
            </a>
            <a
              href="#guia-uso"
              className="hover:text-neutral-900 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
            >
              Guía
            </a>
          </nav>

          <div className="flex items-center shrink-0">
            <input
              ref={headerFileInputRef}
              type="file"
              multiple
              accept="image/png,image/jpeg,image/webp,image/avif,image/bmp"
              onChange={(e) => {
                const chosen = Array.from(e.target.files || []).filter((f) =>
                  f.type.startsWith('image/'),
                );
                if (chosen.length > 0) addFilesToQueue(chosen);
                e.target.value = '';
              }}
              className="hidden"
              aria-label="Cargar imágenes"
            />
            {items.length > 0 ? (
              <button
                type="button"
                disabled={isProcessingBatch || isProcessingCurrent}
                onClick={handleProcessBatch}
                className="inline-flex h-10 items-center justify-center rounded-lg bg-blue-600 px-4 text-xs font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
              >
                {isProcessingBatch ? 'Procesando...' : `Exportar Lote (${items.length})`}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => headerFileInputRef.current?.click()}
                className="inline-flex h-10 items-center justify-center rounded-lg bg-blue-600 px-4 text-xs font-semibold text-white transition-colors hover:bg-blue-700 whitespace-nowrap shrink-0 cursor-pointer"
              >
                Cargar Imágenes
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main id="estudio" className="mx-auto w-full max-w-[1440px] flex-1 px-6 py-6 space-y-6">
        {/* Global Mode Toggle Bar (Fotografía / Cabello vs Ilustración / Degradado) */}
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-neutral-200 bg-white px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-neutral-900">
              Selector de tecnología de recorte
            </p>
            <p className="text-xs text-neutral-500">
              {currentMode === 'photo'
                ? 'Usa @imgly/background-removal (Medium o Large) para retratos, cabello y escenas fotográficas.'
                : 'Usa Canvas HTML5 con Color a Alfa (blanco/negro) y detección desde esquinas preservando degradados internos.'}
            </p>
          </div>

          <div
            role="tablist"
            aria-label="Modo de recorte"
            className="flex flex-wrap items-center gap-1 rounded-lg bg-neutral-100 p-1"
          >
            <button
              type="button"
              role="tab"
              aria-selected={currentMode === 'photo'}
              onClick={() => handleSwitchActivePipelineMode('photo')}
              className={`inline-flex h-9 items-center gap-2 rounded-md px-3.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                currentMode === 'photo'
                  ? 'bg-white text-neutral-900 shadow-xs'
                  : 'text-neutral-600 hover:text-neutral-900'
              }`}
            >
              <Camera className="h-3.5 w-3.5" />
              <span>Modo Fotografía / Cabello</span>
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={currentMode === 'illustration'}
              onClick={() => handleSwitchActivePipelineMode('illustration')}
              className={`inline-flex h-9 items-center gap-2 rounded-md px-3.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                currentMode === 'illustration'
                  ? 'bg-white text-neutral-900 shadow-xs'
                  : 'text-neutral-600 hover:text-neutral-900'
              }`}
            >
              <Sparkles className="h-3.5 w-3.5" />
              <span>Modo Ilustración / Degradado</span>
            </button>
          </div>
        </div>

        {/* Batch Progress Indicator */}
        {batchProgressText && (
          <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm font-medium text-blue-900">
            {batchProgressText}
          </div>
        )}

        {/* Feedback Banner */}
        {banner && (
          <div
            role="status"
            className={`flex flex-wrap items-center justify-between gap-4 rounded-xl border px-4 py-3 text-sm ${
              banner.type === 'success'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                : 'border-red-200 bg-red-50 text-red-900'
            }`}
          >
            <div className="flex items-center gap-2.5 min-w-0">
              {banner.type === 'success' ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-700" />
              ) : (
                <AlertTriangle className="h-4 w-4 shrink-0 text-red-700" />
              )}
              <span className="font-medium">{banner.message}</span>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {banner.canDownloadZip && (
                <button
                  type="button"
                  disabled={downloadingZip}
                  onClick={handleDownloadZip}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-emerald-700 px-3 text-xs font-semibold text-white hover:bg-emerald-800 cursor-pointer"
                >
                  <Archive className="h-3.5 w-3.5" />
                  <span>{downloadingZip ? 'Comprimiendo...' : 'Descargar ZIP'}</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => setBanner(null)}
                aria-label="Cerrar aviso"
                className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-black/5 cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}

        {/* Empty State vs Active Studio Workspace */}
        {items.length === 0 ? (
          <DropZoneStage
            onFilesSelected={(files) => addFilesToQueue(files)}
            onLoadSamples={handleLoadSamples}
            loadingSamples={loadingSamples}
          />
        ) : (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
            <div className="min-w-0 space-y-6">
              <DropZoneStage
                compact
                onFilesSelected={(files) => addFilesToQueue(files)}
                onLoadSamples={handleLoadSamples}
                loadingSamples={loadingSamples}
              />

              {activeItem && (
                <PreviewCanvas
                  item={activeItem}
                  tool={tool}
                  onToolChange={setTool}
                  backdrop={backdrop}
                  onBackdropChange={setBackdrop}
                  customBackdropColor={customBackdropColor}
                  onCustomBackdropColorChange={setCustomBackdropColor}
                  brushSize={brushSize}
                  onBrushSizeChange={setBrushSize}
                  onPickColor={handlePickColor}
                  onCommitBrushStroke={handleCommitBrushStroke}
                  onUndoBrush={handleUndoBrush}
                  onResetBrush={handleResetBrush}
                  onCropChange={handleCropChange}
                  onSwitchToIllustration={() => handleSwitchActivePipelineMode('illustration')}
                  onPreviewStats={handlePreviewStats}
                />
              )}

              <BatchQueueTable
                items={items}
                activeId={activeItem?.id || ''}
                onSelect={setActiveId}
                onRemove={handleRemoveItem}
                onClearAll={handleClearAll}
                onDownloadZip={handleDownloadZip}
                downloadingZip={downloadingZip}
              />

              <EngineComparisonView activeItem={activeItem} />
            </div>

            {activeItem && (
              <div className="lg:sticky lg:top-22">
                <InspectorPanel
                  settings={activeItem.settings}
                  naturalWidth={activeItem.naturalWidth}
                  naturalHeight={activeItem.naturalHeight}
                  originalBytes={activeItem.originalBytes}
                  batchCount={items.length}
                  isProcessingCurrent={isProcessingCurrent}
                  isProcessingBatch={isProcessingBatch}
                  onChange={handleUpdateActiveSettings}
                  onApplyToAll={handleApplySettingsToAll}
                  onProcessCurrent={handleProcessCurrent}
                  onProcessBatch={handleProcessBatch}
                />
              </div>
            )}
          </div>
        )}

        {/* Workflow Guide */}
        <section
          id="guia-uso"
          className="rounded-xl border border-neutral-200 bg-white p-6 md:p-8"
        >
          <h2 className="font-display text-lg font-semibold text-neutral-900">
            Flujo de trabajo en tres pasos
          </h2>
          <div className="mt-5 grid grid-cols-1 gap-6 md:grid-cols-3">
            <div className="border-t border-neutral-200 pt-4">
              <h3 className="font-display text-sm font-semibold text-neutral-900">
                01. Elige modo Fotografía o Ilustración
              </h3>
              <p className="mt-2 text-sm text-neutral-600 leading-relaxed">
                Usa el interruptor superior para procesar retratos y cabello con @imgly/background-removal (Medium o Large) o ilustraciones con Color a Alfa y detección desde esquinas.
              </p>
            </div>
            <div className="border-t border-neutral-200 pt-4">
              <h3 className="font-display text-sm font-semibold text-neutral-900">
                02. Ajusta con jaladores y encuadra
              </h3>
              <p className="mt-2 text-sm text-neutral-600 leading-relaxed">
                Recorta márgenes con los jaladores sobre el lienzo y regula escala, calidad y paleta PNG de 8-bit viendo el peso estimado antes de exportar.
              </p>
            </div>
            <div className="border-t border-neutral-200 pt-4">
              <h3 className="font-display text-sm font-semibold text-neutral-900">
                03. Exporta con Sharp o Jimp por lote
              </h3>
              <p className="mt-2 text-sm text-neutral-600 leading-relaxed">
                Procesa cada archivo sin bloqueos en PNG transparente, WebP ligero o JPG usando Sharp (libvips) o Jimp y descarga todo el lote en un archivo ZIP.
              </p>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-neutral-200 bg-white">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-4 px-6 py-4 text-xs text-neutral-500">
          <span>Recorte Studio · @imgly/background-removal · Canvas HTML5 · Sharp &amp; Jimp</span>
          <span>PNG Transparente · WebP · JPG</span>
        </div>
      </footer>
    </div>
  );
}
