import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  SplitSquareHorizontal,
  Pipette,
  Eraser,
  Paintbrush,
  Undo2,
  RotateCcw,
  ZoomIn,
  ZoomOut,
  Maximize2,
  RefreshCw,
} from 'lucide-react';
import type {
  BatchItem,
  CanvasTool,
  PreviewBackdrop,
  RgbColor,
} from '../types/studio';
import {
  getCachedImglyResult,
  runImglySegmentation,
  type ImglyProgressInfo,
} from '../utils/imglyProcessor';
import {
  loadProxyImage,
  renderImglyPreview,
  renderRealtimePreview,
  type CachedProxyImage,
} from '../utils/previewProcessor';

interface PreviewCanvasProps {
  item: BatchItem;
  tool: CanvasTool;
  onToolChange: (tool: CanvasTool) => void;
  backdrop: PreviewBackdrop;
  onBackdropChange: (b: PreviewBackdrop) => void;
  customBackdropColor: string;
  onCustomBackdropColorChange: (hex: string) => void;
  brushSize: number;
  onBrushSizeChange: (size: number) => void;
  onPickColor: (color: RgbColor) => void;
  onCommitBrushStroke: (width: number, height: number, nextMask: Uint8Array) => void;
  onUndoBrush: () => void;
  onResetBrush: () => void;
  onSwitchToIllustration: () => void;
  onPreviewStats: (itemId: string, renderMs: number, transparentRatio: number) => void;
}

export const PreviewCanvas: React.FC<PreviewCanvasProps> = ({
  item,
  tool,
  onToolChange,
  backdrop,
  onBackdropChange,
  customBackdropColor,
  onCustomBackdropColorChange,
  brushSize,
  onBrushSizeChange,
  onPickColor,
  onCommitBrushStroke,
  onUndoBrush,
  onResetBrush,
  onSwitchToIllustration,
  onPreviewStats,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const displayCanvasRef = useRef<HTMLCanvasElement>(null);

  const [proxy, setProxy] = useState<CachedProxyImage | null>(null);
  const [processedImageData, setProcessedImageData] = useState<ImageData | null>(null);
  const [loadingProxy, setLoadingProxy] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [imglyLoading, setImglyLoading] = useState<boolean>(false);
  const [imglyProgress, setImglyProgress] = useState<ImglyProgressInfo | null>(null);
  const [imglyError, setImglyError] = useState<string | null>(null);
  const [imglyVersionTick, setImglyVersionTick] = useState<number>(0);

  const [splitRatio, setSplitRatio] = useState<number>(0.5);
  const [isDraggingSplit, setIsDraggingSplit] = useState<boolean>(false);
  const [zoom, setZoom] = useState<number>(1);
  const [hoverSample, setHoverSample] = useState<{ x: number; y: number; rgb: RgbColor } | null>(
    null,
  );

  const workingMaskRef = useRef<Uint8Array | null>(null);
  const isPaintingRef = useRef<boolean>(false);
  const lastPaintPosRef = useRef<{ x: number; y: number } | null>(null);

  // Load proxy image when item changes
  useEffect(() => {
    let cancelled = false;
    setLoadingProxy(true);
    setLoadError(null);
    setProxy(null);
    setProcessedImageData(null);

    loadProxyImage(item.id, item.originalUrl)
      .then(({ proxy: loadedProxy }) => {
        if (cancelled) return;
        setProxy(loadedProxy);
        setLoadingProxy(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : 'Error al cargar la imagen.');
        setLoadingProxy(false);
      });

    return () => {
      cancelled = true;
    };
  }, [item.id, item.originalUrl]);

  // Run @imgly/background-removal when in 'photo' mode
  const triggerImglyIfNeeded = useCallback(() => {
    if (item.settings.pipelineMode !== 'photo') {
      setImglyLoading(false);
      setImglyError(null);
      return;
    }

    const cached = getCachedImglyResult(item.id, item.settings.imglyModel);
    if (cached) {
      setImglyLoading(false);
      setImglyError(null);
      setImglyVersionTick((t) => t + 1);
      return;
    }

    let cancelled = false;
    setImglyLoading(true);
    setImglyError(null);
    setImglyProgress({
      stage: `Iniciando modelo ${item.settings.imglyModel === 'large' ? 'Large' : 'Medium'}`,
      percent: 0,
    });

    runImglySegmentation(item.id, item.file, item.settings.imglyModel, (info) => {
      if (!cancelled) setImglyProgress(info);
    })
      .then(() => {
        if (cancelled) return;
        setImglyLoading(false);
        setImglyProgress(null);
        setImglyVersionTick((t) => t + 1);
      })
      .catch((err) => {
        if (cancelled) return;
        setImglyLoading(false);
        setImglyProgress(null);
        setImglyError(
          err instanceof Error
            ? err.message
            : 'No se pudo cargar o ejecutar el modelo @imgly/background-removal.',
        );
      });

    return () => {
      cancelled = true;
    };
  }, [item.id, item.file, item.settings.pipelineMode, item.settings.imglyModel]);

  useEffect(() => {
    const cleanup = triggerImglyIfNeeded();
    return cleanup;
  }, [triggerImglyIfNeeded]);

  const currentBrushLayer =
    item.brushIndex >= 0 && item.brushHistory[item.brushIndex]
      ? item.brushHistory[item.brushIndex]
      : undefined;

  // Recompute real-time preview whenever proxy, mode, settings, brush, or @imgly result changes
  useEffect(() => {
    if (!proxy) return;

    if (item.settings.pipelineMode === 'photo') {
      const cached = getCachedImglyResult(item.id, item.settings.imglyModel);
      if (!cached) {
        // Show original until @imgly segmentation finishes
        setProcessedImageData(proxy.sourceImageData);
        return;
      }
      const res = renderImglyPreview(
        proxy,
        cached.proxyImageData,
        item.settings,
        currentBrushLayer,
        cached.durationMs,
      );
      setProcessedImageData(res.processedImageData);
      onPreviewStats(item.id, res.durationMs, res.transparentRatio);
      return;
    }

    const result = renderRealtimePreview(proxy, item.settings, currentBrushLayer);
    setProcessedImageData(result.processedImageData);
    onPreviewStats(item.id, result.durationMs, result.transparentRatio);
  }, [
    proxy,
    item.id,
    item.settings,
    currentBrushLayer,
    imglyVersionTick,
    onPreviewStats,
  ]);

  const paintCanvas = useCallback(() => {
    const canvas = displayCanvasRef.current;
    if (!canvas || !proxy || !processedImageData) return;

    if (canvas.width !== proxy.width || canvas.height !== proxy.height) {
      canvas.width = proxy.width;
      canvas.height = proxy.height;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, proxy.width, proxy.height);

    if (tool === 'compare') {
      ctx.putImageData(processedImageData, 0, 0);

      const splitX = Math.round(proxy.width * splitRatio);
      if (splitX > 0) {
        const off = document.createElement('canvas');
        off.width = proxy.width;
        off.height = proxy.height;
        const offCtx = off.getContext('2d');
        if (offCtx) {
          offCtx.putImageData(proxy.sourceImageData, 0, 0);
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, 0, splitX, proxy.height);
          ctx.clip();
          ctx.drawImage(off, 0, 0);
          ctx.restore();
        }
      }
    } else {
      ctx.putImageData(processedImageData, 0, 0);
    }
  }, [proxy, processedImageData, tool, splitRatio]);

  useEffect(() => {
    paintCanvas();
  }, [paintCanvas]);

  const getCanvasCoords = (clientX: number, clientY: number) => {
    const canvas = displayCanvasRef.current;
    if (!canvas || !proxy) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const x = Math.max(
      0,
      Math.min(proxy.width - 1, Math.floor(((clientX - rect.left) / rect.width) * proxy.width)),
    );
    const y = Math.max(
      0,
      Math.min(proxy.height - 1, Math.floor(((clientY - rect.top) / rect.height) * proxy.height)),
    );
    return { x, y, normX: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) };
  };

  const paintBrushDot = (
    mask: Uint8Array,
    w: number,
    h: number,
    cx: number,
    cy: number,
    radius: number,
    val: 1 | 2,
  ) => {
    const r2 = radius * radius;
    const minX = Math.max(0, Math.floor(cx - radius));
    const maxX = Math.min(w - 1, Math.ceil(cx + radius));
    const minY = Math.max(0, Math.floor(cy - radius));
    const maxY = Math.min(h - 1, Math.ceil(cy + radius));
    for (let y = minY; y <= maxY; y++) {
      const dy = y - cy;
      const row = y * w;
      for (let x = minX; x <= maxX; x++) {
        const dx = x - cx;
        if (dx * dx + dy * dy <= r2) {
          mask[row + x] = val;
        }
      }
    }
  };

  const paintBrushSegment = (
    mask: Uint8Array,
    w: number,
    h: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    radius: number,
    val: 1 | 2,
  ) => {
    const dist = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.ceil(dist / Math.max(1, radius * 0.35)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      paintBrushDot(mask, w, h, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, radius, val);
    }
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const coords = getCanvasCoords(e.clientX, e.clientY);
    if (!coords || !proxy) return;

    if (tool === 'compare') {
      setIsDraggingSplit(true);
      setSplitRatio(coords.normX);
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }

    if (tool === 'eyedropper') {
      const idx = (coords.y * proxy.width + coords.x) * 4;
      const d = proxy.sourceImageData.data;
      onPickColor({ r: d[idx], g: d[idx + 1], b: d[idx + 2] });
      return;
    }

    if (tool === 'erase' || tool === 'restore') {
      const total = proxy.width * proxy.height;
      const baseMask =
        currentBrushLayer &&
        currentBrushLayer.width === proxy.width &&
        currentBrushLayer.height === proxy.height
          ? new Uint8Array(currentBrushLayer.data)
          : new Uint8Array(total);
      workingMaskRef.current = baseMask;
      isPaintingRef.current = true;
      lastPaintPosRef.current = { x: coords.x, y: coords.y };
      const val: 1 | 2 = tool === 'erase' ? 1 : 2;
      paintBrushDot(baseMask, proxy.width, proxy.height, coords.x, coords.y, brushSize / 2, val);

      if (item.settings.pipelineMode === 'photo') {
        const cached = getCachedImglyResult(item.id, item.settings.imglyModel);
        if (cached) {
          const res = renderImglyPreview(
            proxy,
            cached.proxyImageData,
            item.settings,
            { width: proxy.width, height: proxy.height, data: baseMask },
            cached.durationMs,
          );
          setProcessedImageData(res.processedImageData);
        }
      } else {
        const res = renderRealtimePreview(proxy, item.settings, {
          width: proxy.width,
          height: proxy.height,
          data: baseMask,
        });
        setProcessedImageData(res.processedImageData);
      }

      e.currentTarget.setPointerCapture(e.pointerId);
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const coords = getCanvasCoords(e.clientX, e.clientY);
    if (!coords || !proxy) return;

    if (tool === 'eyedropper') {
      const idx = (coords.y * proxy.width + coords.x) * 4;
      const d = proxy.sourceImageData.data;
      setHoverSample({
        x: coords.x,
        y: coords.y,
        rgb: { r: d[idx], g: d[idx + 1], b: d[idx + 2] },
      });
    } else if (hoverSample) {
      setHoverSample(null);
    }

    if (tool === 'compare' && isDraggingSplit) {
      setSplitRatio(coords.normX);
      return;
    }

    if ((tool === 'erase' || tool === 'restore') && isPaintingRef.current && workingMaskRef.current) {
      const prev = lastPaintPosRef.current || { x: coords.x, y: coords.y };
      const val: 1 | 2 = tool === 'erase' ? 1 : 2;
      paintBrushSegment(
        workingMaskRef.current,
        proxy.width,
        proxy.height,
        prev.x,
        prev.y,
        coords.x,
        coords.y,
        brushSize / 2,
        val,
      );
      lastPaintPosRef.current = { x: coords.x, y: coords.y };

      if (item.settings.pipelineMode === 'photo') {
        const cached = getCachedImglyResult(item.id, item.settings.imglyModel);
        if (cached) {
          const res = renderImglyPreview(
            proxy,
            cached.proxyImageData,
            item.settings,
            { width: proxy.width, height: proxy.height, data: workingMaskRef.current },
            cached.durationMs,
          );
          setProcessedImageData(res.processedImageData);
        }
      } else {
        const res = renderRealtimePreview(proxy, item.settings, {
          width: proxy.width,
          height: proxy.height,
          data: workingMaskRef.current,
        });
        setProcessedImageData(res.processedImageData);
      }
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (isDraggingSplit) {
      setIsDraggingSplit(false);
    }
    if (isPaintingRef.current && workingMaskRef.current && proxy) {
      isPaintingRef.current = false;
      lastPaintPosRef.current = null;
      onCommitBrushStroke(proxy.width, proxy.height, workingMaskRef.current);
      workingMaskRef.current = null;
    }
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const backdropStyle: React.CSSProperties =
    backdrop === 'white'
      ? { backgroundColor: '#ffffff' }
      : backdrop === 'black'
        ? { backgroundColor: '#09090b' }
        : backdrop === 'slate'
          ? { backgroundColor: '#334155' }
          : backdrop === 'custom'
            ? { backgroundColor: customBackdropColor }
            : {};

  const hasBrushEdits = item.brushIndex >= 0;

  return (
    <div className="flex flex-col rounded-xl border border-neutral-200 bg-white overflow-hidden">
      {/* Studio Viewport Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-200 px-4 py-2.5 bg-neutral-50/70">
        {/* Interactive Canvas Tools */}
        <div className="flex flex-wrap items-center gap-1 rounded-lg bg-neutral-200/70 p-1">
          <button
            type="button"
            onClick={() => onToolChange('compare')}
            className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              tool === 'compare'
                ? 'bg-white text-neutral-900 shadow-xs'
                : 'text-neutral-600 hover:text-neutral-900'
            }`}
          >
            <SplitSquareHorizontal className="h-3.5 w-3.5" />
            <span>Comparar</span>
          </button>

          {item.settings.pipelineMode === 'illustration' && (
            <button
              type="button"
              onClick={() => onToolChange('eyedropper')}
              className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                tool === 'eyedropper'
                  ? 'bg-white text-neutral-900 shadow-xs'
                  : 'text-neutral-600 hover:text-neutral-900'
              }`}
            >
              <Pipette className="h-3.5 w-3.5" />
              <span>Cuentagotas</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => onToolChange('erase')}
            className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              tool === 'erase'
                ? 'bg-white text-neutral-900 shadow-xs'
                : 'text-neutral-600 hover:text-neutral-900'
            }`}
          >
            <Eraser className="h-3.5 w-3.5" />
            <span>Borrar</span>
          </button>

          <button
            type="button"
            onClick={() => onToolChange('restore')}
            className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              tool === 'restore'
                ? 'bg-white text-neutral-900 shadow-xs'
                : 'text-neutral-600 hover:text-neutral-900'
            }`}
          >
            <Paintbrush className="h-3.5 w-3.5" />
            <span>Restaurar</span>
          </button>
        </div>

        {/* Backdrop Preview & Zoom */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5" role="group" aria-label="Fondo de previsualización">
            <span className="text-xs text-neutral-500 mr-1 hidden sm:inline">Fondo:</span>
            <button
              type="button"
              title="Damero transparente"
              onClick={() => onBackdropChange('checkerboard')}
              className={`h-7 w-7 rounded-md border checkerboard-canvas cursor-pointer ${
                backdrop === 'checkerboard' ? 'ring-2 ring-blue-600 border-blue-600' : 'border-neutral-300'
              }`}
            />
            <button
              type="button"
              title="Fondo blanco"
              onClick={() => onBackdropChange('white')}
              className={`h-7 w-7 rounded-md border bg-white cursor-pointer ${
                backdrop === 'white' ? 'ring-2 ring-blue-600 border-blue-600' : 'border-neutral-300'
              }`}
            />
            <button
              type="button"
              title="Fondo negro"
              onClick={() => onBackdropChange('black')}
              className={`h-7 w-7 rounded-md border bg-neutral-950 cursor-pointer ${
                backdrop === 'black' ? 'ring-2 ring-blue-600 border-blue-600' : 'border-neutral-300'
              }`}
            />
            <button
              type="button"
              title="Fondo pizarra"
              onClick={() => onBackdropChange('slate')}
              className={`h-7 w-7 rounded-md border bg-slate-700 cursor-pointer ${
                backdrop === 'slate' ? 'ring-2 ring-blue-600 border-blue-600' : 'border-neutral-300'
              }`}
            />
            <label
              title="Color personalizado"
              className={`relative h-7 w-7 rounded-md border overflow-hidden cursor-pointer ${
                backdrop === 'custom' ? 'ring-2 ring-blue-600 border-blue-600' : 'border-neutral-300'
              }`}
              style={{ backgroundColor: customBackdropColor }}
            >
              <input
                type="color"
                value={customBackdropColor}
                onChange={(e) => {
                  onCustomBackdropColorChange(e.target.value);
                  onBackdropChange('custom');
                }}
                className="opacity-0 absolute inset-0 w-full h-full cursor-pointer"
                aria-label="Color de fondo personalizado"
              />
            </label>
          </div>

          <div className="h-4 w-px bg-neutral-200 hidden sm:block" />

          <div className="flex items-center gap-1">
            <button
              type="button"
              title="Alejar"
              onClick={() => setZoom((z) => Math.max(0.5, Number((z - 0.25).toFixed(2))))}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50 cursor-pointer"
            >
              <ZoomOut className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setZoom(1)}
              className="inline-flex h-8 items-center justify-center rounded-md border border-neutral-200 bg-white px-2.5 font-mono text-xs tabular-nums text-neutral-700 hover:bg-neutral-50 whitespace-nowrap shrink-0 cursor-pointer"
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              title="Acercar"
              onClick={() => setZoom((z) => Math.min(2.5, Number((z + 0.25).toFixed(2))))}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50 cursor-pointer"
            >
              <ZoomIn className="h-3.5 w-3.5" />
            </button>
            {zoom !== 1 && (
              <button
                type="button"
                title="Ajustar al visor"
                onClick={() => setZoom(1)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50 cursor-pointer"
              >
                <Maximize2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Contextual Sub-bar for Brush or Eyedropper */}
      {(tool === 'erase' || tool === 'restore' || tool === 'eyedropper' || hasBrushEdits) && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-200 bg-neutral-50 px-4 py-2 text-xs text-neutral-700">
          {tool === 'eyedropper' && (
            <div className="flex items-center gap-2">
              <span>Haz clic sobre el fondo en la imagen para añadir ese color a la extracción.</span>
              {hoverSample && (
                <span className="inline-flex items-center gap-1.5 font-mono tabular-nums text-neutral-900">
                  <span
                    className="inline-block h-3.5 w-3.5 rounded border border-neutral-300"
                    style={{
                      backgroundColor: `rgb(${hoverSample.rgb.r}, ${hoverSample.rgb.g}, ${hoverSample.rgb.b})`,
                    }}
                  />
                  rgb({hoverSample.rgb.r}, {hoverSample.rgb.g}, {hoverSample.rgb.b})
                </span>
              )}
            </div>
          )}

          {(tool === 'erase' || tool === 'restore') && (
            <div className="flex items-center gap-3">
              <span className="font-medium text-neutral-900">
                {tool === 'erase' ? 'Pincel de borrado' : 'Pincel de restauración'}
              </span>
              <label className="flex items-center gap-2">
                <span className="text-neutral-500">Tamaño:</span>
                <input
                  type="range"
                  min={6}
                  max={64}
                  value={brushSize}
                  onChange={(e) => onBrushSizeChange(Number(e.target.value))}
                  className="w-28 accent-blue-600 cursor-pointer"
                />
                <span className="font-mono tabular-nums w-10">{brushSize}px</span>
              </label>
            </div>
          )}

          {tool === 'compare' && hasBrushEdits && (
            <span className="text-neutral-600">Máscara manual activa sobre el recorte.</span>
          )}

          {hasBrushEdits && (
            <div className="flex items-center gap-2 ml-auto">
              <button
                type="button"
                onClick={onUndoBrush}
                className="inline-flex h-7 items-center gap-1 rounded border border-neutral-300 bg-white px-2.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 cursor-pointer"
              >
                <Undo2 className="h-3 w-3" />
                <span>Deshacer trazo</span>
              </button>
              <button
                type="button"
                onClick={onResetBrush}
                className="inline-flex h-7 items-center gap-1 rounded border border-neutral-300 bg-white px-2.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 cursor-pointer"
              >
                <RotateCcw className="h-3 w-3" />
                <span>Limpiar máscara</span>
              </button>
            </div>
          )}
        </div>
      )}

      {/* Main Canvas Stage */}
      <div
        ref={containerRef}
        className={`relative flex min-h-[420px] max-h-[580px] w-full items-center justify-center overflow-auto p-6 ${
          backdrop === 'checkerboard' ? 'checkerboard-canvas' : ''
        }`}
        style={backdropStyle}
      >
        {loadingProxy && (
          <div className="flex flex-col items-center gap-2 rounded-lg bg-white/95 px-5 py-4 border border-neutral-200">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-neutral-300 border-t-blue-600" />
            <p className="text-xs font-medium text-neutral-700">Preparando visor en tiempo real...</p>
          </div>
        )}

        {loadError && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {loadError}
          </div>
        )}

        {!loadingProxy && !loadError && proxy && (
          <div
            className="relative inline-block select-none shadow-sm"
            style={{
              transform: `scale(${zoom})`,
              transformOrigin: 'center center',
            }}
          >
            <canvas
              ref={displayCanvasRef}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              className={`block max-h-[510px] max-w-full rounded ${
                tool === 'compare'
                  ? 'cursor-ew-resize'
                  : tool === 'eyedropper'
                    ? 'cursor-crosshair'
                    : 'cursor-cell'
              }`}
              style={{ width: 'auto', height: 'auto' }}
            />

            {tool === 'compare' && (
              <div
                className="pointer-events-none absolute inset-y-0 w-0.5 bg-white shadow-[0_0_0_1px_rgba(15,23,42,0.35)]"
                style={{ left: `${splitRatio * 100}%` }}
              >
                <div className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 flex h-7 w-7 items-center justify-center rounded-full border border-neutral-300 bg-white text-[10px] font-bold text-neutral-800 shadow">
                  ↔
                </div>
                <span className="absolute top-2 right-2 rounded bg-neutral-900/75 px-2 py-0.5 text-[11px] font-medium text-white whitespace-nowrap">
                  Original
                </span>
                <span className="absolute top-2 left-2 rounded bg-blue-600/90 px-2 py-0.5 text-[11px] font-medium text-white whitespace-nowrap">
                  Recorte
                </span>
              </div>
            )}
          </div>
        )}

        {/* @imgly Neural Progress / Error Overlay */}
        {item.settings.pipelineMode === 'photo' && imglyLoading && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 w-[min(380px,90%)] rounded-xl border border-neutral-200 bg-white/95 px-4 py-3 shadow-sm">
            <div className="flex items-center justify-between text-xs font-medium text-neutral-900">
              <span>{imglyProgress?.stage || 'Ejecutando @imgly/background-removal'}</span>
              <span className="font-mono tabular-nums">{imglyProgress?.percent ?? 0}%</span>
            </div>
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-neutral-200">
              <div
                className="h-full bg-blue-600 transition-all duration-150"
                style={{ width: `${Math.max(8, imglyProgress?.percent ?? 10)}%` }}
              />
            </div>
          </div>
        )}

        {item.settings.pipelineMode === 'photo' && imglyError && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 w-[min(460px,92%)] rounded-xl border border-red-200 bg-white px-4 py-3 shadow-sm">
            <p className="text-xs font-semibold text-red-700">
              Error en @imgly/background-removal: {imglyError}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => triggerImglyIfNeeded()}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-neutral-300 bg-white px-3 text-xs font-medium text-neutral-800 hover:bg-neutral-50 cursor-pointer"
              >
                <RefreshCw className="h-3 w-3" />
                <span>Reintentar</span>
              </button>
              <button
                type="button"
                onClick={onSwitchToIllustration}
                className="inline-flex h-8 items-center rounded-md bg-blue-600 px-3 text-xs font-medium text-white hover:bg-blue-700 cursor-pointer"
              >
                Usar Modo Ilustración / Degradado
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Clean Unboxed Telemetry Bar */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-neutral-200 bg-white px-4 py-2.5 text-xs text-neutral-600">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <span className="font-medium text-neutral-900 truncate max-w-[240px]">{item.name}</span>
          <span aria-hidden="true">·</span>
          <span className="font-mono tabular-nums">
            {item.naturalWidth} × {item.naturalHeight} px
          </span>
          {typeof item.previewTransparentRatio === 'number' && (
            <>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">
                Fondo eliminado: {item.previewTransparentRatio.toFixed(1)}%
              </span>
            </>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <span className="font-medium text-neutral-800">
            {item.settings.pipelineMode === 'photo'
              ? `@imgly (${item.settings.imglyModel === 'large' ? 'Large' : 'Medium'})`
              : 'Canvas HTML5 (Ilustración)'}
          </span>
          {typeof item.previewRenderMs === 'number' && (
            <>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums text-neutral-500">
                {item.previewRenderMs} ms
              </span>
            </>
          )}
          <span aria-hidden="true">·</span>
          <span className="font-medium text-neutral-800">
            Salida: {item.settings.format.toUpperCase()}
            {(item.settings.format === 'png' || item.settings.format === 'webp') &&
            !item.settings.useSolidBackground
              ? ' Transparente'
              : ' Fondo sólido'}
          </span>
        </div>
      </div>
    </div>
  );
};
