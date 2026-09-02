export type HarvestWarningSummary = {
  id?: string;
  code?: string;
  severity?: string;
  message: string;
  slideId?: string;
  assetId?: string;
};

export type HarvestManifestLike = {
  schemaVersion?: string;
  id?: string;
  deckTitle?: string;
  slideCount?: number;
  source?: unknown;
  slides?: {
    preview?: { path?: string | null };
    textRuns?: unknown[];
  }[];
  assets?: unknown[];
  warnings?: HarvestWarningSummary[];
};

export function summarizeHarvestManifest(manifest: HarvestManifestLike) {
  const slides = manifest.slides ?? [];
  return {
    schemaVersion: manifest.schemaVersion,
    id: manifest.id,
    deckTitle: manifest.deckTitle,
    slideCount: manifest.slideCount ?? slides.length,
    previewCount: slides.filter((slide) => Boolean(slide.preview?.path)).length,
    extractedTextRunCount: slides.reduce((count, slide) => count + (slide.textRuns?.length ?? 0), 0),
    assetCount: manifest.assets?.length ?? 0,
    warnings: manifest.warnings ?? [],
  };
}

export function textContent(payload: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}
