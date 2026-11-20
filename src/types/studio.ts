import type {
  ColorToAlphaTarget,
  ExportFormat,
  IllustrationStrategy,
  ImglyModelSize,
  PipelineMode,
  ProcessingEngine,
  RemovalOptions,
  RgbColor,
} from '../shared/bgRemoval';

export type PreviewBackdrop = 'checkerboard' | 'white' | 'black' | 'slate' | 'custom';
export type CanvasTool = 'compare' | 'eyedropper' | 'erase' | 'restore';
export type BatchStatus = 'pending' | 'processing' | 'done' | 'error';

export interface EngineSettings {
  pipelineMode: PipelineMode;
  imglyModel: ImglyModelSize;
  engine: ProcessingEngine;
  format: ExportFormat;
  quality: number;
  maxWidth: number;
  backgroundColor: string;
  useSolidBackground: boolean;
  removal: RemovalOptions;
}

export interface BrushHistoryState {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface ProcessedOutput {
  filename: string;
  mimeType: string;
  format: ExportFormat;
  width: number;
  height: number;
  originalBytes: number;
  outputBytes: number;
  durationMs: number;
  engineUsed: string;
  dataUrl: string;
}

export interface BatchItem {
  id: string;
  file: File;
  name: string;
  originalUrl: string;
  originalBytes: number;
  naturalWidth: number;
  naturalHeight: number;
  status: BatchStatus;
  settings: EngineSettings;
  brushHistory: BrushHistoryState[];
  brushIndex: number;
  previewTransparentRatio?: number;
  previewRenderMs?: number;
  output?: ProcessedOutput;
  error?: string;
}

export interface SamplePreset {
  id: string;
  label: string;
  category: string;
  url: string;
  filename: string;
  suggestedTolerance: number;
}

export const SAMPLE_PRESETS: SamplePreset[] = [
  {
    id: 'sneaker',
    label: 'Zapatilla Deportiva',
    category: 'Fondo gris estudio',
    url: '/src/assets/images/sample_sneaker_studio_1795192476898.jpg',
    filename: 'zapatilla-studio.jpg',
    suggestedTolerance: 34,
  },
  {
    id: 'headphones',
    label: 'Auriculares Aluminio',
    category: 'Ciclorama claro + arco',
    url: '/src/assets/images/sample_headphones_studio_1795192476525.jpg',
    filename: 'auriculares-studio.jpg',
    suggestedTolerance: 32,
  },
  {
    id: 'vase',
    label: 'Jarrón Terracota',
    category: 'Fondo salvia + hojas',
    url: '/src/assets/images/sample_ceramic_vase_1795192477141.jpg',
    filename: 'jarron-ceramica.jpg',
    suggestedTolerance: 36,
  },
];

export type {
  ColorToAlphaTarget,
  ExportFormat,
  IllustrationStrategy,
  ImglyModelSize,
  PipelineMode,
  ProcessingEngine,
  RemovalOptions,
  RgbColor,
};
