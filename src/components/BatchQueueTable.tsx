import React from 'react';
import { Download, Trash2, Archive, Check, AlertCircle, Loader2 } from 'lucide-react';
import type { BatchItem } from '../types/studio';
import { downloadDataUrl, formatBytes } from '../utils/previewProcessor';

interface BatchQueueTableProps {
  items: BatchItem[];
  activeId: string;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onClearAll: () => void;
  onDownloadZip: () => void;
  downloadingZip: boolean;
}

export const BatchQueueTable: React.FC<BatchQueueTableProps> = ({
  items,
  activeId,
  onSelect,
  onRemove,
  onClearAll,
  onDownloadZip,
  downloadingZip,
}) => {
  const completedItems = items.filter((i) => i.status === 'done' && i.output);

  return (
    <section id="cola-lote" className="rounded-xl border border-neutral-200 bg-white overflow-hidden">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-neutral-200 px-5 py-3.5">
        <div className="flex flex-wrap items-baseline gap-2.5">
          <h2 className="font-display text-base font-semibold text-neutral-900">
            Cola de procesamiento por lotes
          </h2>
          <span className="text-xs text-neutral-500 tabular-nums">
            {items.length} {items.length === 1 ? 'archivo' : 'archivos'} · {completedItems.length}{' '}
            exportados
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {completedItems.length > 0 && (
            <button
              type="button"
              disabled={downloadingZip}
              onClick={onDownloadZip}
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-blue-600 px-4 text-xs font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Archive className="h-3.5 w-3.5" />
              <span>
                {downloadingZip
                  ? 'Empaquetando ZIP...'
                  : `Descargar todo en ZIP (${completedItems.length})`}
              </span>
            </button>
          )}
          <button
            type="button"
            onClick={onClearAll}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-neutral-300 bg-white px-3 text-xs font-medium text-neutral-700 transition-colors hover:bg-neutral-50 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>Vaciar cola</span>
          </button>
        </div>
      </div>

      {/* Filmstrip Selector */}
      <div className="flex items-center gap-3 overflow-x-auto border-b border-neutral-200 bg-neutral-50/70 px-5 py-3">
        {items.map((item) => {
          const isSelected = item.id === activeId;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelect(item.id)}
              className={`group relative flex w-36 shrink-0 flex-col overflow-hidden rounded-lg border text-left transition-colors cursor-pointer ${
                isSelected
                  ? 'border-blue-600 bg-white ring-2 ring-blue-600/20'
                  : 'border-neutral-200 bg-white hover:border-neutral-400'
              }`}
            >
              <div className="relative h-20 w-full overflow-hidden checkerboard-canvas">
                <img
                  src={item.output ? item.output.dataUrl : item.originalUrl}
                  alt={item.name}
                  referrerPolicy="no-referrer"
                  className="h-full w-full object-contain"
                />
              </div>
              <div className="px-2.5 py-1.5">
                <p className="truncate text-xs font-medium text-neutral-900">{item.name}</p>
                <p className="mt-0.5 text-[11px] font-mono tabular-nums text-neutral-500">
                  {item.settings.format.toUpperCase()} · {item.settings.engine}
                </p>
              </div>
            </button>
          );
        })}
      </div>

      {/* Dense Data Table */}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-xs">
          <thead>
            <tr className="border-b border-neutral-200 bg-neutral-50 text-neutral-500 font-medium">
              <th className="py-2.5 pl-5 pr-3">Archivo</th>
              <th className="py-2.5 px-3 text-right">Resolución</th>
              <th className="py-2.5 px-3 text-right">Original</th>
              <th className="py-2.5 px-3 text-right">Exportado</th>
              <th className="py-2.5 px-3">Motor / Formato</th>
              <th className="py-2.5 px-3 text-right">Tiempo</th>
              <th className="py-2.5 px-3">Estado</th>
              <th className="py-2.5 pl-3 pr-5 text-right">Acciones</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-200">
            {items.map((item) => {
              const isSelected = item.id === activeId;
              const deltaPct =
                item.output && item.originalBytes > 0
                  ? Math.round(
                      ((item.output.outputBytes - item.originalBytes) / item.originalBytes) * 100,
                    )
                  : null;

              return (
                <tr
                  key={item.id}
                  onClick={() => onSelect(item.id)}
                  className={`h-11 transition-colors cursor-pointer ${
                    isSelected ? 'bg-blue-50/60' : 'hover:bg-neutral-50'
                  }`}
                >
                  <td className="py-2 pl-5 pr-3 font-medium text-neutral-900 max-w-[220px] truncate">
                    {item.name}
                  </td>
                  <td className="py-2 px-3 text-right font-mono tabular-nums text-neutral-600 whitespace-nowrap">
                    {item.output
                      ? `${item.output.width}×${item.output.height}`
                      : item.naturalWidth > 0
                        ? `${item.naturalWidth}×${item.naturalHeight}`
                        : '—'}
                  </td>
                  <td className="py-2 px-3 text-right font-mono tabular-nums text-neutral-600 whitespace-nowrap">
                    {formatBytes(item.originalBytes)}
                  </td>
                  <td className="py-2 px-3 text-right font-mono tabular-nums text-neutral-900 whitespace-nowrap">
                    {item.output ? (
                      <span>
                        {formatBytes(item.output.outputBytes)}{' '}
                        {deltaPct !== null && (
                          <span className="text-neutral-500">
                            ({deltaPct > 0 ? `+${deltaPct}%` : `${deltaPct}%`})
                          </span>
                        )}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="py-2 px-3 text-neutral-700 whitespace-nowrap">
                    {item.output
                      ? `${item.output.engineUsed} · ${item.output.format.toUpperCase()}`
                      : `${item.settings.engine === 'sharp' ? 'Sharp' : 'Jimp'} · ${item.settings.format.toUpperCase()}`}
                  </td>
                  <td className="py-2 px-3 text-right font-mono tabular-nums text-neutral-600 whitespace-nowrap">
                    {item.output ? `${item.output.durationMs} ms` : '—'}
                  </td>
                  <td className="py-2 px-3 whitespace-nowrap">
                    {item.status === 'done' && (
                      <span className="inline-flex items-center gap-1 font-medium text-emerald-700">
                        <Check className="h-3.5 w-3.5" />
                        <span>Listo</span>
                      </span>
                    )}
                    {item.status === 'processing' && (
                      <span className="inline-flex items-center gap-1 font-medium text-blue-700">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        <span>Procesando</span>
                      </span>
                    )}
                    {item.status === 'error' && (
                      <span
                        title={item.error}
                        className="inline-flex items-center gap-1 font-medium text-red-700"
                      >
                        <AlertCircle className="h-3.5 w-3.5" />
                        <span>Error</span>
                      </span>
                    )}
                    {item.status === 'pending' && (
                      <span className="text-neutral-500">En espera</span>
                    )}
                  </td>
                  <td
                    className="py-2 pl-3 pr-5 text-right whitespace-nowrap"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="inline-flex items-center gap-1.5">
                      {item.output && (
                        <button
                          type="button"
                          onClick={() => downloadDataUrl(item.output!.dataUrl, item.output!.filename)}
                          className="inline-flex h-8 items-center gap-1 rounded-md border border-neutral-300 bg-white px-2.5 text-xs font-medium text-neutral-800 hover:bg-neutral-50 cursor-pointer"
                        >
                          <Download className="h-3 w-3" />
                          <span>Descargar</span>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => onRemove(item.id)}
                        title="Quitar de la cola"
                        aria-label={`Quitar ${item.name} de la cola`}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-neutral-200 bg-white text-neutral-500 hover:text-red-600 hover:border-red-200 cursor-pointer"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
};
