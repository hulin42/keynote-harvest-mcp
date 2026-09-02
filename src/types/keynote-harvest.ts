import type { KeynoteHarvestManifestVersion } from '../schema/version.js';

export type KeynoteHarvestWarningCode =
  | 'missing-preview'
  | 'failed-extraction'
  | 'unsupported-media'
  | 'private-redacted'
  | 'unknown';

export type KeynoteHarvestWarning = {
  id: string;
  code: KeynoteHarvestWarningCode;
  severity: 'info' | 'warning' | 'error';
  message: string;
  slideId?: string;
  assetId?: string;
};

export type HarvestTextSource = 'pdf-text' | 'ocr-text' | 'vision-observation' | 'manual' | 'unknown';

export type HarvestSourceKind = 'keynote' | 'pdf' | 'edited-pdf' | 'unknown';

export type KeynoteExportStatus = 'completed' | 'completed-with-warning' | 'failed';

export type KeynoteHarvestExportMetadata = {
  sourceKind: HarvestSourceKind;
  sourceDisplayName?: string;
  sourcePath?: string;
  redactedSourceFileName?: string;
  exportedPdfPath?: string;
  redactedExportedPdfFileName?: string;
  exportedAt?: string;
  exportTool?: string;
  selectedKeynoteAppPath?: string;
  selectedKeynoteAppName?: string;
  selectedKeynoteAppVersion?: string;
  selectedKeynoteAppBundleId?: string;
  appSelectionSource?: 'cli' | 'env' | 'discovered' | 'fallback';
  appSelectionWarnings?: string[];
  exportStatus?: KeynoteExportStatus;
  exportWarnings?: string[];
  pdfPageCount?: number;
  pdfSizeBytes?: number;
  pdfModifiedAt?: string;
  timedOut?: boolean;
  manuallyEditedPdfArtifact?: boolean;
};

export type KeynoteHarvestSource = {
  id: string;
  kind: HarvestSourceKind;
  title?: string;
  displayName?: string;
  sourceFilePath?: string;
  redactedSourceFileName?: string;
  harvestedAt: string;
  tool: string;
  manuallyEditedPdfArtifact?: boolean;
  export?: KeynoteHarvestExportMetadata;
};

export type KeynoteHarvestPreview = {
  id: string;
  slideId: string;
  path: string | null;
  width?: number;
  height?: number;
  mimeType?: string;
  checksum?: string;
};

export type KeynoteHarvestTextRun = {
  id: string;
  text: string;
  role?: 'title' | 'subtitle' | 'body' | 'caption' | 'label' | 'unknown';
  source?: HarvestTextSource;
  confidence?: number;
  bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  redacted?: boolean;
};

export type KeynoteHarvestAsset = {
  id: string;
  kind: 'embedded-image' | 'video' | 'shape-render' | 'unknown';
  path: string | null;
  sourceSlideId: string;
  alt?: string;
  width?: number;
  height?: number;
  mimeType?: string;
  checksum?: string;
  redacted?: boolean;
};

export type KeynoteHarvestSlide = {
  id: string;
  index: number;
  title?: string;
  dimensions: {
    width: number;
    height: number;
    aspectRatio: string;
  };
  preview?: KeynoteHarvestPreview;
  textRuns: KeynoteHarvestTextRun[];
  assetIds: string[];
  warnings?: KeynoteHarvestWarning[];
};

export type KeynoteHarvestManifest = {
  schemaVersion: KeynoteHarvestManifestVersion;
  id: string;
  deckTitle: string;
  source: KeynoteHarvestSource;
  harvestedAt: string;
  slideCount: number;
  slideDimensions: {
    width: number;
    height: number;
    aspectRatio: string;
  };
  slides: KeynoteHarvestSlide[];
  assets: KeynoteHarvestAsset[];
  warnings?: KeynoteHarvestWarning[];
};

export type KeynoteHarvestPackage = {
  manifest: KeynoteHarvestManifest;
  previews: KeynoteHarvestPreview[];
  assets: KeynoteHarvestAsset[];
  warnings?: KeynoteHarvestWarning[];
};

export type DeckHarvestManifest = KeynoteHarvestManifest;
export type DeckHarvestPackage = KeynoteHarvestPackage;
export type DeckHarvestSlide = KeynoteHarvestSlide;
export type DeckHarvestPreview = KeynoteHarvestPreview;
export type DeckHarvestAsset = KeynoteHarvestAsset;
export type DeckHarvestWarning = KeynoteHarvestWarning;
