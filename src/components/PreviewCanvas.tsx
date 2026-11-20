import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  SplitSquareHorizontal,
  Crop,
  Pipette,
  Eraser,
  Paintbrush,
  Undo2,
  RotateCcw,
  ZoomIn,
  ZoomOut,
  Maximize2,
  RefreshCw,
  Scissors,
} from 'lucide-react';
import type {
  BatchItem,
  CanvasTool,
  CropRect,
  PreviewBackdrop,
  RgbColor,
} from '../types/studio';
import {
  getCachedImglyResult,
  runImglySegmentation,
  type ImglyProgressInfo,
} from '../utils/imglyProcessor';
import {
  computeSubjectTrimRect,
  loadProxyImage,
  renderImglyPreview,
  renderRealtimePreview,
  type CachedProxyImage,
} from '../utils/previewProcessor';

type CropHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'move';

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
  onCropChange: (cropRect: CropRect | undefined) => void;
  onSwitchToIllustration: () => void;
  onPreviewStats: (itemId: string, renderMs: number, transparentRatio: number) => void;
}

const FULL_CROP: CropRect = { x: 0, y: 0, w: 1, h: 1 };

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
  onCropChange,
  onSwitchToIllustration,
  onPreviewStats,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const displayCanvasRef = useRef<HTMLCanvasElement>(null);
  const stageWrapperRef = useRef<HTMLDivElement>(null);

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

  // Interactive crop handle dragging state
  const cropDragRef = useRef<{
    handle: CropHandle;
    startX: number;
    startY: number;
    startRect: CropRect;
  } | null>(null);

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

  useEffect(() => {
    if (!proxy) return;

    if (item.settings.pipelineMode === 'photo') {
      const cached = getCachedImglyResult(item.id, item.settings.imglyModel);
      if (!cached) {
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
    if (tool === 'crop') return;
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
    if (tool === 'crop') return;
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

  // Crop Handle (Jaladores) drag handlers
  const activeCrop: CropRect = item.settings.cropRect || FULL_CROP;

  const startCropDrag = (handle: CropHandle, e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    cropDragRef.current = {
      handle,
      startX: e.clientX,
      startY: e.clientY,
      startRect: { ...activeCrop },
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const moveCropDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = cropDragRef.current;
    const wrapper = stageWrapperRef.current;
    if (!drag || !wrapper) return;
    const rect = wrapper.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const dx = (e.clientX - drag.startX) / rect.width;
    const dy = (e.clientY - drag.startY) / rect.height;
    const minSize = 0.08;
    const s = drag.startRect;

    let x = s.x;
    let y = s.y;
    let right = s.x + s.w;
    let bottom = s.y + s.h;

    if (drag.handle === 'move') {
      const nextX = Math.max(0, Math.min(1 - s.w, s.x + dx));
      const nextY = Math.max(0, Math.min(1 - s.h, s.y + dy));
      onCropChange({ x: nextX, y: nextY, w: s.w, h: s.h });
      return;
    }

    if (drag.handle.includes('w')) {
      x = Math.max(0, Math.min(right - minSize, s.x + dx));
    }
    if (drag.handle.includes('e')) {
      right = Math.min(1, Math.max(x + minSize, s.x + s.w + dx));
    }
    if (drag.handle.includes('n')) {
      y = Math.max(0, Math.min(bottom - minSize, s.y + dy));
    }
    if (drag.handle.includes('s')) {
      bottom = Math.min(1, Math.max(y + minSize, s.y + s.h + dy));
    }

    onCropChange({
      x,
      y,
      w: Math.max(minSize, right - x),
      h: Math.max(minSize, bottom - y),
    });
  };

  const endCropDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (cropDragRef.current) {
      cropDragRef.current = null;
    }
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const handleAutoTrimToSubject = () => {
    if (!processedImageData) return;
    const trimmed = computeSubjectTrimRect(processedImageData);
    if (trimmed) {
      onCropChange(trimmed);
      if (tool !== 'crop') {
        onToolChange('crop');
      }
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
  const hasCustomCrop = Boolean(item.settings.cropRect);
  const cropPxW = Math.round(item.naturalWidth * activeCrop.w);
  const cropPxH = Math.round(item.naturalHeight * activeCrop.h);

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

          <button
            type="button"
            onClick={() => onToolChange('crop')}
            className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              tool === 'crop'
                ? 'bg-white text-neutral-900 shadow-xs'
                : 'text-neutral-600 hover:text-neutral-900'
            }`}
          >
            <Crop className="h-3.5 w-3.5" />
            <span>Encuadrar (Jaladores)</span>
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

      {/* Contextual Sub-bar for Crop, Brush, or Eyedropper */}
      {(tool === 'crop' ||
        tool === 'erase' ||
        tool === 'restore' ||
        tool === 'eyedropper' ||
        hasBrushEdits ||
        hasCustomCrop) && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-200 bg-neutral-50 px-4 py-2 text-xs text-neutral-700">
          {tool === 'crop' && (
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-medium text-neutral-900">
                Arrastra los jaladores de esquinas o bordes para recortar márgenes vacíos
              </span>
              {cropPxW > 0 && cropPxH > 0 && (
                <span className="font-mono tabular-nums text-neutral-600">
                  Recorte: {cropPxW} × {cropPxH} px
                </span>
              )}
            </div>
          )}

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

          {tool === 'compare' && (hasBrushEdits || hasCustomCrop) && (
            <span className="text-neutral-600">
              {hasCustomCrop
                ? `Encuadre activo (${cropPxW} × ${cropPxH} px)`
                : 'Máscara manual activa'}
            </span>
          )}

          <div className="flex flex-wrap items-center gap-2 ml-auto">
            {(tool === 'crop' || hasCustomCrop) && (
              <>
                <button
                  type="button"
                  onClick={handleAutoTrimToSubject}
                  className="inline-flex h-7 items-center gap-1 rounded border border-blue-200 bg-blue-50 px-2.5 text-xs font-medium text-blue-700 hover:bg-blue-100 cursor-pointer"
                >
                  <Scissors className="h-3 w-3" />
                  <span>Ajustar al sujeto</span>
                </button>
                {hasCustomCrop && (
                  <button
                    type="button"
                    onClick={() => onCropChange(undefined)}
                    className="inline-flex h-7 items-center gap-1 rounded border border-neutral-300 bg-white px-2.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 cursor-pointer"
                  >
                    <RotateCcw className="h-3 w-3" />
                    <span>Restablecer encuadre</span>
                  </button>
                )}
              </>
            )}

            {hasBrushEdits && (
              <>
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
              </>
            )}
          </div>
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
            ref={stageWrapperRef}
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
                  : tool === 'crop'
                    ? 'cursor-default'
                    : tool === 'eyedropper'
                      ? 'cursor-crosshair'
                      : 'cursor-cell'
              }`}
              style={{ width: 'auto', height: 'auto' }}
            />

            {/* Split Line Overlay in Compare Mode */}
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

            {/* Subtle Crop Guide when custom crop is active in non-crop tools */}
            {tool !== 'crop' && hasCustomCrop && (
              <div
                className="pointer-events-none absolute border border-dashed border-blue-600/80"
                style={{
                  left: `${activeCrop.x * 100}%`,
                  top: `${activeCrop.y * 100}%`,
                  width: `${activeCrop.w * 100}%`,
                  height: `${activeCrop.h * 100}%`,
                }}
              />
            )}

            {/* Interactive Crop Box with 8 Jaladores (Corner & Edge Handles) */}
            {tool === 'crop' && (
              <div className="absolute inset-0 overflow-hidden rounded">
                {/* Darkened exterior mask around crop rectangle */}
                <div
                  className="pointer-events-none absolute inset-x-0 top-0 bg-neutral-950/45"
                  style={{ height: `${activeCrop.y * 100}%` }}
                />
                <div
                  className="pointer-events-none absolute inset-x-0 bottom-0 bg-neutral-950/45"
                  style={{ height: `${(1 - activeCrop.y - activeCrop.h) * 100}%` }}
                />
                <div
                  className="pointer-events-none absolute left-0 bg-neutral-950/45"
                  style={{
                    top: `${activeCrop.y * 100}%`,
                    height: `${activeCrop.h * 100}%`,
                    width: `${activeCrop.x * 100}%`,
                  }}
                />
                <div
                  className="pointer-events-none absolute right-0 bg-neutral-950/45"
                  style={{
                    top: `${activeCrop.y * 100}%`,
                    height: `${activeCrop.h * 100}%`,
                    width: `${(1 - activeCrop.x - activeCrop.w) * 100}%`,
                  }}
                />

                {/* Active Crop Box + 8 Handles */}
                <div
                  onPointerDown={(e) => startCropDrag('move', e)}
                  onPointerMove={moveCropDrag}
                  onPointerUp={endCropDrag}
                  className="absolute border-2 border-blue-500 cursor-move"
                  style={{
                    left: `${activeCrop.x * 100}%`,
                    top: `${activeCrop.y * 100}%`,
                    width: `${activeCrop.w * 100}%`,
                    height: `${activeCrop.h * 100}%`,
                  }}
                >
                  {/* Rule of thirds hairline */}
                  <div className="pointer-events-none absolute inset-x-0 top-1/3 border-t border-white/30" />
                  <div className="pointer-events-none absolute inset-x-0 top-2/3 border-t border-white/30" />
                  <div className="pointer-events-none absolute inset-y-0 left-1/3 border-l border-white/30" />
                  <div className="pointer-events-none absolute inset-y-0 left-2/3 border-l border-white/30" />

                  {/* 4 Corner Jaladores */}
                  <div
                    onPointerDown={(e) => startCropDrag('nw', e)}
                    onPointerMove={moveCropDrag}
                    onPointerUp={endCropDrag}
                    title="Ajustar esquina superior izquierda"
                    className="absolute -left-2 -top-2 h-4 w-4 rounded-sm border-2 border-blue-600 bg-white shadow cursor-nwse-resize"
                  />
                  <div
                    onPointerDown={(e) => startCropDrag('ne', e)}
                    onPointerMove={moveCropDrag}
                    onPointerUp={endCropDrag}
                    title="Ajustar esquina superior derecha"
                    className="absolute -right-2 -top-2 h-4 w-4 rounded-sm border-2 border-blue-600 bg-white shadow cursor-nesw-resize"
                  />
                  <div
                    onPointerDown={(e) => startCropDrag('sw', e)}
                    onPointerMove={moveCropDrag}
                    onPointerUp={endCropDrag}
                    title="Ajustar esquina inferior izquierda"
                    className="absolute -bottom-2 -left-2 h-4 w-4 rounded-sm border-2 border-blue-600 bg-white shadow cursor-nesw-resize"
                  />
                  <div
                    onPointerDown={(e) => startCropDrag('se', e)}
                    onPointerMove={moveCropDrag}
                    onPointerUp={endCropDrag}
                    title="Ajustar esquina inferior derecha"
                    className="absolute -bottom-2 -right-2 h-4 w-4 rounded-sm border-2 border-blue-600 bg-white shadow cursor-nwse-resize"
                  />

                  {/* 4 Edge Jaladores */}
                  <div
                    onPointerDown={(e) => startCropDrag('n', e)}
                    onPointerMove={moveCropDrag}
                    onPointerUp={endCropDrag}
                    title="Ajustar borde superior"
                    className="absolute left-1/2 -top-1.5 h-3 w-7 -translate-x-1/2 rounded-sm border border-blue-600 bg-white shadow cursor-ns-resize"
                  />
                  <div
                    onPointerDown={(e) => startCropDrag('s', e)}
                    onPointerMove={moveCropDrag}
                    onPointerUp={endCropDrag}
                    title="Ajustar borde inferior"
                    className="absolute left-1/2 -bottom-1.5 h-3 w-7 -translate-x-1/2 rounded-sm border border-blue-600 bg-white shadow cursor-ns-resize"
                  />
                  <div
                    onPointerDown={(e) => startCropDrag('w', e)}
                    onPointerMove={moveCropDrag}
                    onPointerUp={endCropDrag}
                    title="Ajustar borde izquierdo"
                    className="absolute top-1/2 -left-1.5 h-7 w-3 -translate-y-1/2 rounded-sm border border-blue-600 bg-white shadow cursor-ew-resize"
                  />
                  <div
                    onPointerDown={(e) => startCropDrag('e', e)}
                    onPointerMove={moveCropDrag}
                    onPointerUp={endCropDrag}
                    title="Ajustar borde derecho"
                    className="absolute top-1/2 -right-1.5 h-7 w-3 -translate-y-1/2 rounded-sm border border-blue-600 bg-white shadow cursor-ew-resize"
                  />
                </div>
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
            {hasCustomCrop
              ? `${cropPxW} × ${cropPxH} px (recortado)`
              : `${item.naturalWidth} × ${item.naturalHeight} px`}
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
