import React, { useRef, useState } from 'react';
import { Upload, FolderPlus, ImagePlus } from 'lucide-react';
import { SAMPLE_PRESETS, type SamplePreset } from '../types/studio';

interface DropZoneStageProps {
  onFilesSelected: (files: File[]) => void;
  onLoadSamples: (presets: SamplePreset[]) => void;
  loadingSamples: boolean;
  compact?: boolean;
}

export const DropZoneStage: React.FC<DropZoneStageProps> = ({
  onFilesSelected,
  onLoadSamples,
  loadingSamples,
  compact = false,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isDragging) setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const droppedFiles = Array.from(e.dataTransfer.files).filter((f) =>
      f.type.startsWith('image/'),
    );
    if (droppedFiles.length > 0) {
      onFilesSelected(droppedFiles);
    }
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files || []).filter((f) =>
      f.type.startsWith('image/'),
    );
    if (selected.length > 0) {
      onFilesSelected(selected);
    }
    e.target.value = '';
  };

  if (compact) {
    return (
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`flex flex-wrap items-center justify-between gap-4 rounded-xl border border-dashed px-4 py-3 transition-colors ${
          isDragging
            ? 'border-blue-600 bg-blue-50/70'
            : 'border-neutral-300 bg-white hover:border-neutral-400'
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp,image/avif,image/bmp"
          onChange={handleFileInput}
          className="hidden"
          aria-label="Añadir más imágenes al lote"
        />
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-neutral-100 text-neutral-700">
            <ImagePlus className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-neutral-900 truncate">
              Arrastra y suelta más imágenes aquí para añadirlas al lote
            </p>
            <p className="text-xs text-neutral-500">
              PNG · JPG · WebP · AVIF · Hasta 30 archivos simultáneos
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="inline-flex h-10 items-center gap-2 rounded-lg border border-neutral-300 bg-white px-4 text-sm font-medium text-neutral-800 transition-colors hover:bg-neutral-50 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <FolderPlus className="h-4 w-4" />
            <span>Añadir archivos</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl py-6">
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`rounded-2xl border-2 border-dashed p-10 md:p-14 text-center transition-colors ${
          isDragging
            ? 'border-blue-600 bg-blue-50/60'
            : 'border-neutral-300 bg-white hover:border-neutral-400'
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp,image/avif,image/bmp"
          onChange={handleFileInput}
          className="hidden"
          aria-label="Seleccionar imágenes para quitar fondo"
        />

        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-xl border border-neutral-200 bg-neutral-50 text-neutral-800">
          <Upload className="h-6 w-6" />
        </div>

        <h1 className="font-display text-2xl md:text-4xl font-bold tracking-tight text-neutral-900 text-balance mx-auto max-w-2xl">
          Elimina fondos con precisión de estudio y procesa lotes completos
        </h1>

        <p className="mx-auto mt-3 max-w-xl text-base text-neutral-600 leading-relaxed">
          Arrastra una o varias imágenes aquí para previsualizar el recorte en tiempo real y exportar en PNG transparente, WebP o JPG mediante Sharp o Jimp.
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="inline-flex h-11 items-center gap-2 rounded-lg bg-blue-600 px-6 text-sm font-semibold text-white transition-colors hover:bg-blue-700 whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
          >
            <FolderPlus className="h-4 w-4" />
            <span>Seleccionar imágenes</span>
          </button>

          <button
            type="button"
            disabled={loadingSamples}
            onClick={() => onLoadSamples(SAMPLE_PRESETS)}
            className="inline-flex h-11 items-center gap-2 rounded-lg border border-neutral-300 bg-white px-5 text-sm font-medium text-neutral-800 transition-colors hover:bg-neutral-50 disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <span>{loadingSamples ? 'Cargando muestras...' : 'Probar con 3 imágenes de muestra'}</span>
          </button>
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs text-neutral-500">
          <span>Soporta carga por lote (hasta 30 archivos)</span>
          <span aria-hidden="true">·</span>
          <span>Pegar desde portapapeles (Ctrl+V)</span>
          <span aria-hidden="true">·</span>
          <span>Motores Sharp y Jimp</span>
        </div>
      </div>

      {/* Studio Sample Presets */}
      <div className="mt-10">
        <div className="flex flex-wrap items-baseline justify-between gap-4 border-b border-neutral-200 pb-3">
          <h2 className="font-display text-base font-semibold text-neutral-900">
            Muestras de estudio listas para probar
          </h2>
          <button
            type="button"
            disabled={loadingSamples}
            onClick={() => onLoadSamples(SAMPLE_PRESETS)}
            className="text-sm font-medium text-blue-600 hover:underline whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
          >
            Cargar lote completo (3 archivos)
          </button>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-5 sm:grid-cols-3">
          {SAMPLE_PRESETS.map((sample) => (
            <button
              key={sample.id}
              type="button"
              disabled={loadingSamples}
              onClick={() => onLoadSamples([sample])}
              className="group overflow-hidden rounded-xl border border-neutral-200 bg-white text-left transition-colors hover:border-neutral-400 cursor-pointer disabled:opacity-60"
            >
              <div className="aspect-[4/3] w-full overflow-hidden bg-neutral-100">
                <img
                  src={sample.url}
                  alt={sample.label}
                  referrerPolicy="no-referrer"
                  className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
                />
              </div>
              <div className="p-4">
                <p className="text-sm font-semibold text-neutral-900">{sample.label}</p>
                <p className="mt-1 text-xs text-neutral-500">
                  {sample.category} · Clic para abrir en el estudio
                </p>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
