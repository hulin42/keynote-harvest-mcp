import { z, type ZodRawShape } from 'zod';
import { HARVEST_SLUG_PATTERN } from './paths.js';

export const harvestSlugSchema = z
  .string()
  .regex(
    HARVEST_SLUG_PATTERN,
    'Use 1-100 lowercase letters, numbers, or hyphens, beginning and ending with a letter or number.'
  );

export function parseToolArgs<Shape extends ZodRawShape>(
  toolName: string,
  shape: Shape,
  args: unknown
): z.infer<z.ZodObject<Shape>> {
  const result = z.object(shape).strict().safeParse(args ?? {});
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
      .join('; ');
    throw new Error(`Invalid arguments for ${toolName}: ${issues}`);
  }
  return result.data;
}
