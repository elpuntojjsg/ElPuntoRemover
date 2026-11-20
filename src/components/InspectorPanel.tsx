import React from 'react';
import { Download, Layers, RotateCcw, CopyCheck, X, Camera, Sparkles } from 'lucide-react';
import {
  DEFAULT_REMOVAL_OPTIONS,
  type ColorToAlphaTarget,
  type IllustrationStrategy,
  type ImglyModelSize,
  type PipelineMode,
  type RemovalMode,
} from '../shared/bgRemoval';
import type { EngineSettings, ExportFormat, ProcessingEngine } from '../types/studio';

interface InspectorPanelProps {
  settings: EngineSettings;
  batchCount: number;
  isProcessingCurrent: boolean;
  isProcessingBatch: boolean;
  onChange: (next: EngineSettings) => void;
  onApplyToAll: () => void;
  onProcessCurrent: () => void;
  onProcessBatch: () => void;
}

export const InspectorPanel: React.FC<InspectorPanelProps> = ({
  settings,
  batchCount,
  isProcessingCurrent,
  isProcessingBatch,
  onChange,
  onApplyToAll,
  onProcessCurrent,
  onProcessBatch,
}) => {
  const updateRemoval = <K extends keyof EngineSettings['removal']>(
    key: K,
    value: EngineSettings['removal'][K],
  ) => {
    onChange({
      ...settings,
      removal: {
        ...settings.removal,
        [key]: value,
      },
    });
  };

  const setPipelineMode = (pipelineMode: PipelineMode) => {
    onChange({ ...settings, pipelineMode });
  };

  const setImglyModel = (imglyModel: ImglyModelSize) => {
    onChange({ ...settings, imglyModel });
  };

  const setEngine = (engine: ProcessingEngine) => {
    onChange({ ...settings, engine });
  };

  const setFormat = (format: ExportFormat) => {
    onChange({ ...settings, format });
  };

  const removeTargetColor = (index: number) => {
    const current = settings.removal.targetColors || [];
    updateRemoval(
      'targetColors',
      current.filter((_, idx) => idx !== index),
    );
  };

  const resetRemovalDefaults = () => {
    onChange({
      ...settings,
      removal: { ...DEFAULT_REMOVAL_OPTIONS, targetColors: [] },
    });
  };

  const targetColors = settings.removal.targetColors || [];
  const showBgColorPicker = settings.format === 'jpg' || settings.useSolidBackground;

  return (
    <aside className="flex flex-col rounded-xl border border-neutral-200 bg-white divide-y divide-neutral-200">
      {/* 1. Interruptor Principal de Modo: Fotografía/Cabello vs Ilustración/Degradado */}
      <div className="p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-display text-sm font-semibold text-neutral-900">
            Modo de extracción
          </h2>
          <span className="text-xs text-neutral-500">
            {settings.pipelineMode === 'photo' ? '@imgly IA' : 'Canvas HTML5'}
          </span>
        </div>

        <div
          role="group"
          aria-label="Interruptor de modo de extracción"
          className="mt-3 grid grid-cols-1 gap-1.5 rounded-lg bg-neutral-100 p-1"
        >
          <button
            type="button"
            onClick={() => setPipelineMode('photo')}
            className={`flex h-10 items-center gap-2 rounded-md px-3 text-left text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
              settings.pipelineMode === 'photo'
                ? 'bg-white text-neutral-900 shadow-xs'
                : 'text-neutral-600 hover:text-neutral-900'
            }`}
          >
            <Camera className="h-3.5 w-3.5 shrink-0" />
            <span>Modo Fotografía / Cabello</span>
          </button>

          <button
            type="button"
            onClick={() => setPipelineMode('illustration')}
            className={`flex h-10 items-center gap-2 rounded-md px-3 text-left text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
              settings.pipelineMode === 'illustration'
                ? 'bg-white text-neutral-900 shadow-xs'
                : 'text-neutral-600 hover:text-neutral-900'
            }`}
          >
            <Sparkles className="h-3.5 w-3.5 shrink-0" />
            <span>Modo Ilustración / Degradado</span>
          </button>
        </div>

        {settings.pipelineMode === 'photo' ? (
          <div className="mt-4 space-y-2.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-neutral-700">Modelo @imgly/background-removal</span>
            </div>
            <div className="grid grid-cols-2 gap-1 rounded-lg bg-neutral-100 p-1">
              <button
                type="button"
                onClick={() => setImglyModel('medium')}
                className={`h-8 rounded-md text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                  settings.imglyModel === 'medium'
                    ? 'bg-white text-neutral-900 shadow-xs'
                    : 'text-neutral-600 hover:text-neutral-900'
                }`}
              >
                Medium (FP16)
              </button>
              <button
                type="button"
                onClick={() => setImglyModel('large')}
                className={`h-8 rounded-md text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                  settings.imglyModel === 'large'
                    ? 'bg-white text-neutral-900 shadow-xs'
                    : 'text-neutral-600 hover:text-neutral-900'
                }`}
              >
                Large (FP32)
              </button>
            </div>
            <p className="text-xs text-neutral-500 leading-relaxed">
              Segmentación neuronal para retratos, cabello, pelaje y fotografías complejas. Usa los pinceles de Borrar o Restaurar en el visor para retoques puntuales.
            </p>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            <div>
              <span className="block text-xs font-medium text-neutral-700 mb-1.5">
                Algoritmo Canvas HTML5
              </span>
              <div className="grid grid-cols-1 gap-1 rounded-lg bg-neutral-100 p-1">
                {(
                  [
                    { id: 'auto', label: 'Auto (Color a Alfa + Esquinas)' },
                    { id: 'color-to-alpha', label: 'Color a Alfa (Blanco / Negro)' },
                    { id: 'corner-edge', label: 'Bordes desde esquinas (Degradados intactos)' },
                  ] as Array<{ id: IllustrationStrategy; label: string }>
                ).map((st) => (
                  <button
                    key={st.id}
                    type="button"
                    onClick={() => updateRemoval('illustrationStrategy', st.id)}
                    className={`h-8 rounded-md px-2.5 text-left text-xs font-medium transition-colors truncate cursor-pointer ${
                      settings.removal.illustrationStrategy === st.id
                        ? 'bg-white text-neutral-900 shadow-xs'
                        : 'text-neutral-600 hover:text-neutral-900'
                    }`}
                  >
                    {st.label}
                  </button>
                ))}
              </div>
            </div>

            {settings.removal.illustrationStrategy !== 'corner-edge' && (
              <div>
                <span className="block text-xs font-medium text-neutral-700 mb-1.5">
                  Fondo objetivo Color a Alfa
                </span>
                <div className="grid grid-cols-3 gap-1 rounded-lg bg-neutral-100 p-1">
                  {(
                    [
                      { id: 'auto', label: 'Auto' },
                      { id: 'white', label: 'Blanco' },
                      { id: 'black', label: 'Negro' },
                    ] as Array<{ id: ColorToAlphaTarget; label: string }>
                  ).map((tgt) => (
                    <button
                      key={tgt.id}
                      type="button"
                      onClick={() => updateRemoval('colorToAlphaTarget', tgt.id)}
                      className={`h-8 rounded-md text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                        settings.removal.colorToAlphaTarget === tgt.id
                          ? 'bg-white text-neutral-900 shadow-xs'
                          : 'text-neutral-600 hover:text-neutral-900'
                      }`}
                    >
                      {tgt.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 2. Ajustes finos en tiempo real (Modo Ilustración / Degradado) */}
      {settings.pipelineMode === 'illustration' && (
        <div className="p-5 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-display text-sm font-semibold text-neutral-900">
              Precisión en tiempo real
            </h2>
            <button
              type="button"
              onClick={resetRemovalDefaults}
              className="inline-flex items-center gap-1 text-xs font-medium text-neutral-500 hover:text-neutral-900 cursor-pointer"
            >
              <RotateCcw className="h-3 w-3" />
              <span>Restablecer</span>
            </button>
          </div>

          <div className="grid grid-cols-3 gap-1 rounded-lg bg-neutral-100 p-1">
            {(
              [
                { id: 'auto', label: 'Ilustración' },
                { id: 'chroma', label: 'Color clave' },
                { id: 'silhouette', label: 'Silueta' },
              ] as Array<{ id: RemovalMode; label: string }>
            ).map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => updateRemoval('mode', m.id)}
                className={`h-8 rounded-md text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                  settings.removal.mode === m.id
                    ? 'bg-white text-neutral-900 shadow-xs'
                    : 'text-neutral-600 hover:text-neutral-900'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          <div>
            <div className="flex items-center justify-between text-xs mb-1.5">
              <label htmlFor="slider-tolerance" className="font-medium text-neutral-700">
                Tolerancia de color
              </label>
              <span className="font-mono tabular-nums text-neutral-900 font-medium">
                {settings.removal.tolerance}
              </span>
            </div>
            <input
              id="slider-tolerance"
              type="range"
              min={5}
              max={110}
              value={settings.removal.tolerance}
              onChange={(e) => updateRemoval('tolerance', Number(e.target.value))}
              className="w-full accent-blue-600 cursor-pointer"
            />
          </div>

          <div>
            <div className="flex items-center justify-between text-xs mb-1.5">
              <label htmlFor="slider-feather" className="font-medium text-neutral-700">
                Suavizado de bordes
              </label>
              <span className="font-mono tabular-nums text-neutral-900 font-medium">
                {settings.removal.feather} px
              </span>
            </div>
            <input
              id="slider-feather"
              type="range"
              min={0}
              max={10}
              step={1}
              value={settings.removal.feather}
              onChange={(e) => updateRemoval('feather', Number(e.target.value))}
              className="w-full accent-blue-600 cursor-pointer"
            />
          </div>

          <div>
            <div className="flex items-center justify-between text-xs mb-1.5">
              <label htmlFor="slider-edgeshift" className="font-medium text-neutral-700">
                Contracción de contorno
              </label>
              <span className="font-mono tabular-nums text-neutral-900 font-medium">
                {settings.removal.edgeShift > 0
                  ? `+${settings.removal.edgeShift} px`
                  : `${settings.removal.edgeShift} px`}
              </span>
            </div>
            <input
              id="slider-edgeshift"
              type="range"
              min={-4}
              max={6}
              step={1}
              value={settings.removal.edgeShift}
              onChange={(e) => updateRemoval('edgeShift', Number(e.target.value))}
              className="w-full accent-blue-600 cursor-pointer"
            />
          </div>

          <div>
            <div className="flex items-center justify-between text-xs mb-1.5">
              <label htmlFor="slider-defringe" className="font-medium text-neutral-700">
                Descontaminación de halo
              </label>
              <span className="font-mono tabular-nums text-neutral-900 font-medium">
                {settings.removal.defringe}%
              </span>
            </div>
            <input
              id="slider-defringe"
              type="range"
              min={0}
              max={100}
              step={5}
              value={settings.removal.defringe}
              onChange={(e) => updateRemoval('defringe', Number(e.target.value))}
              className="w-full accent-blue-600 cursor-pointer"
            />
          </div>

          {settings.removal.illustrationStrategy !== 'corner-edge' && (
            <label className="flex items-center justify-between gap-3 pt-1 cursor-pointer">
              <span className="text-xs font-medium text-neutral-700">
                Limpiar huecos interiores cerrados
              </span>
              <input
                type="checkbox"
                checked={settings.removal.removeInteriorHoles}
                onChange={(e) => updateRemoval('removeInteriorHoles', e.target.checked)}
                className="h-4 w-4 rounded border-neutral-300 accent-blue-600 cursor-pointer"
              />
            </label>
          )}

          {targetColors.length > 0 && (
            <div className="pt-1">
              <p className="text-xs font-medium text-neutral-700 mb-2">
                Colores muestreados ({targetColors.length})
              </p>
              <div className="flex flex-wrap gap-2">
                {targetColors.map((c, idx) => (
                  <div
                    key={`${c.r}-${c.g}-${c.b}-${idx}`}
                    className="inline-flex items-center gap-1.5 rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1 text-[11px] font-mono tabular-nums text-neutral-700"
                  >
                    <span
                      className="h-3 w-3 rounded-xs border border-neutral-300"
                      style={{ backgroundColor: `rgb(${c.r}, ${c.g}, ${c.b})` }}
                    />
                    <span>
                      {c.r},{c.g},{c.b}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeTargetColor(idx)}
                      aria-label="Quitar color muestreado"
                      className="text-neutral-400 hover:text-neutral-800 cursor-pointer"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 3. Motor de Exportación (Sharp vs Jimp) & Formato */}
      <div className="p-5 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-display text-sm font-semibold text-neutral-900">
            Motor y formato de salida
          </h2>
          <span className="text-xs text-neutral-500">Servidor</span>
        </div>

        <div className="grid grid-cols-2 gap-1 rounded-lg bg-neutral-100 p-1">
          <button
            type="button"
            onClick={() => setEngine('sharp')}
            className={`h-9 rounded-md text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
              settings.engine === 'sharp'
                ? 'bg-white text-neutral-900 shadow-xs'
                : 'text-neutral-600 hover:text-neutral-900'
            }`}
          >
            Sharp (libvips)
          </button>
          <button
            type="button"
            onClick={() => setEngine('jimp')}
            className={`h-9 rounded-md text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
              settings.engine === 'jimp'
                ? 'bg-white text-neutral-900 shadow-xs'
                : 'text-neutral-600 hover:text-neutral-900'
            }`}
          >
            Jimp (JS puro)
          </button>
        </div>

        <div className="grid grid-cols-3 gap-1 rounded-lg bg-neutral-100 p-1">
          {(
            [
              { id: 'png', label: 'PNG Alfa' },
              { id: 'webp', label: 'WebP' },
              { id: 'jpg', label: 'JPG' },
            ] as Array<{ id: ExportFormat; label: string }>
          ).map((fmt) => (
            <button
              key={fmt.id}
              type="button"
              onClick={() => setFormat(fmt.id)}
              className={`h-8 rounded-md text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                settings.format === fmt.id
                  ? 'bg-white text-neutral-900 shadow-xs'
                  : 'text-neutral-600 hover:text-neutral-900'
              }`}
            >
              {fmt.label}
            </button>
          ))}
        </div>

        <div>
          <div className="flex items-center justify-between text-xs mb-1.5">
            <label htmlFor="slider-quality" className="font-medium text-neutral-700">
              {settings.format === 'png' ? 'Optimización PNG' : 'Calidad de compresión'}
            </label>
            <span className="font-mono tabular-nums text-neutral-900 font-medium">
              {settings.quality}%
            </span>
          </div>
          <input
            id="slider-quality"
            type="range"
            min={20}
            max={100}
            step={5}
            value={settings.quality}
            onChange={(e) => onChange({ ...settings, quality: Number(e.target.value) })}
            className="w-full accent-blue-600 cursor-pointer"
          />
        </div>

        <div className="flex items-center justify-between gap-3">
          <label htmlFor="select-maxwidth" className="text-xs font-medium text-neutral-700">
            Ancho máximo
          </label>
          <select
            id="select-maxwidth"
            value={settings.maxWidth}
            onChange={(e) => onChange({ ...settings, maxWidth: Number(e.target.value) })}
            className="h-9 rounded-lg border border-neutral-300 bg-white px-3 text-xs font-medium text-neutral-800 cursor-pointer"
          >
            <option value={0}>Original (1:1)</option>
            <option value={2048}>2048 px</option>
            <option value={1200}>1200 px</option>
            <option value={800}>800 px</option>
          </select>
        </div>

        {settings.format !== 'jpg' && (
          <label className="flex items-center justify-between gap-3 cursor-pointer">
            <span className="text-xs font-medium text-neutral-700">
              Rellenar con fondo sólido
            </span>
            <input
              type="checkbox"
              checked={settings.useSolidBackground}
              onChange={(e) =>
                onChange({ ...settings, useSolidBackground: e.target.checked })
              }
              className="h-4 w-4 rounded border-neutral-300 accent-blue-600 cursor-pointer"
            />
          </label>
        )}

        {showBgColorPicker && (
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-neutral-700">
              {settings.format === 'jpg' ? 'Color de fondo (JPG)' : 'Color de relleno'}
            </span>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={settings.backgroundColor}
                onChange={(e) =>
                  onChange({ ...settings, backgroundColor: e.target.value })
                }
                aria-label="Color de fondo de exportación"
                className="h-8 w-10 rounded border border-neutral-300 bg-white p-0.5 cursor-pointer"
              />
              <span className="font-mono text-xs uppercase text-neutral-600 tabular-nums">
                {settings.backgroundColor}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* 4. Confirmación y Descarga */}
      <div className="p-5 space-y-2.5 bg-neutral-50/70 rounded-b-xl">
        {batchCount > 1 && (
          <button
            type="button"
            onClick={onApplyToAll}
            className="flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-neutral-300 bg-white px-4 text-xs font-semibold text-neutral-800 transition-colors hover:bg-neutral-50 whitespace-nowrap cursor-pointer"
          >
            <CopyCheck className="h-3.5 w-3.5" />
            <span>Aplicar estos ajustes a todo el lote ({batchCount})</span>
          </button>
        )}

        <button
          type="button"
          disabled={isProcessingCurrent || isProcessingBatch}
          onClick={onProcessCurrent}
          className="flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-neutral-300 bg-white px-4 text-sm font-semibold text-neutral-900 transition-colors hover:bg-neutral-100 disabled:opacity-50 whitespace-nowrap cursor-pointer"
        >
          <Download className="h-4 w-4" />
          <span>{isProcessingCurrent ? 'Procesando imagen...' : 'Exportar imagen actual'}</span>
        </button>

        <button
          type="button"
          disabled={isProcessingBatch || isProcessingCurrent}
          onClick={onProcessBatch}
          className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
        >
          <Layers className="h-4 w-4" />
          <span>
            {isProcessingBatch
              ? `Procesando lote (${batchCount})...`
              : batchCount > 1
                ? `Confirmar y procesar lote (${batchCount})`
                : 'Confirmar conversión final'}
          </span>
        </button>
      </div>
    </aside>
  );
};
