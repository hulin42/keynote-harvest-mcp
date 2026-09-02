import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020Module from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

const Ajv2020 = Ajv2020Module.default;
const addFormats = addFormatsModule.default;
import { CURRENT_KEYNOTE_HARVEST_MANIFEST_VERSION } from './version.js';
import type { KeynoteHarvestManifest } from '../types/keynote-harvest.js';

type ValidationOptions = {
  allowLegacyVersion?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

// The distributed JSON Schema is the canonical field-level contract; the
// runtime validator compiles it rather than mirroring it by hand, so the two
// cannot drift apart. Format checks run in "full" mode, which validates real
// calendar dates instead of only their shape.
let compiledSchemaValidator: ValidateFunction | undefined;

function schemaValidator(): ValidateFunction {
  if (compiledSchemaValidator) return compiledSchemaValidator;
  const schemaPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'schema',
    'keynote-harvest-manifest-v1.schema.json'
  );
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as Record<string, unknown>;
  const ajv = new Ajv2020({ allErrors: true });
  addFormats(ajv, { mode: 'full' });
  const compiled = ajv.compile(schema);
  compiledSchemaValidator = compiled;
  return compiled;
}

function formatSchemaErrors(validate: ValidateFunction) {
  return (validate.errors ?? []).map((error) => {
    const location = error.instancePath ? error.instancePath.replace(/^\//, '').replace(/\//g, '.') : 'manifest';
    return `${location} ${error.message ?? 'is invalid'}`;
  });
}

function slideIdSet(slides: unknown[]) {
  const ids = new Set<string>();
  for (const slide of slides) {
    if (isRecord(slide) && isNonEmptyString(slide.id)) ids.add(slide.id);
  }
  return ids;
}

// Referential rules the JSON Schema cannot express: slide/asset counts,
// identifier uniqueness, and cross-references between records.
function collectCrossReferenceErrors(value: Record<string, unknown>) {
  const errors: string[] = [];

  if (Array.isArray(value.slides)) {
    if (Number.isInteger(value.slideCount) && value.slides.length !== value.slideCount) {
      errors.push('slides length must match slideCount');
    }
    const slideIds = new Set<string>();
    const slideIndexes = new Set<number>();
    value.slides.forEach((slide, arrayIndex) => {
      if (!isRecord(slide)) return;
      const field = `slides[${arrayIndex}]`;
      if (isNonEmptyString(slide.id)) {
        if (slideIds.has(slide.id)) errors.push(`${field}.id must be unique`);
        else slideIds.add(slide.id);
      }
      if (typeof slide.index === 'number') {
        if (slideIndexes.has(slide.index)) errors.push(`${field}.index must be unique`);
        else slideIndexes.add(slide.index);
      }
      if (isRecord(slide.preview) && isNonEmptyString(slide.preview.slideId) && slide.preview.slideId !== slide.id) {
        errors.push(`${field}.preview.slideId must match the slide id`);
      }
    });
  }

  const assetIds = new Set<string>();
  const knownSlideIds = Array.isArray(value.slides) ? slideIdSet(value.slides) : undefined;
  if (Array.isArray(value.assets)) {
    value.assets.forEach((asset, arrayIndex) => {
      if (!isRecord(asset)) return;
      if (isNonEmptyString(asset.id)) assetIds.add(asset.id);
      if (isNonEmptyString(asset.sourceSlideId) && knownSlideIds && !knownSlideIds.has(asset.sourceSlideId)) {
        errors.push(`assets[${arrayIndex}].sourceSlideId does not match any slide id`);
      }
    });
  }

  if (Array.isArray(value.slides) && Array.isArray(value.assets)) {
    value.slides.forEach((slide, arrayIndex) => {
      if (!isRecord(slide) || !Array.isArray(slide.assetIds)) return;
      slide.assetIds.forEach((assetId, assetIdIndex) => {
        if (isNonEmptyString(assetId) && !assetIds.has(assetId)) {
          errors.push(`slides[${arrayIndex}].assetIds[${assetIdIndex}] does not match any asset id`);
        }
      });
    });
  }

  return errors;
}

export function collectKeynoteHarvestManifestErrors(value: unknown, options: ValidationOptions = {}) {
  if (!isRecord(value)) return ['manifest must be an object'];

  // Pre-versioned private manifests remain readable when explicitly
  // requested: the current version is injected so the schema's required
  // const still applies to everything else.
  const candidate =
    options.allowLegacyVersion && value.schemaVersion === undefined
      ? { ...value, schemaVersion: CURRENT_KEYNOTE_HARVEST_MANIFEST_VERSION }
      : value;

  const validate = schemaValidator();
  const errors = validate(candidate) ? [] : formatSchemaErrors(validate);
  errors.push(...collectCrossReferenceErrors(value));
  return errors;
}

export function validateKeynoteHarvestManifest(
  value: unknown,
  options: ValidationOptions = {}
): asserts value is KeynoteHarvestManifest {
  const errors = collectKeynoteHarvestManifestErrors(value, options);
  if (errors.length > 0) {
    throw new Error(`Invalid KeynoteHarvestManifest: ${errors.join('; ')}`);
  }
}
