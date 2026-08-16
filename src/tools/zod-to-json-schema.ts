/**
 * Hand-rolled Zod → JSON Schema walker.
 *
 * Supports the Zod shapes used in TOOL_MANIFEST (ADR-025 Phase 72-02).
 * No external dependencies — intentionally not using zod-to-json-schema package.
 */

import { z } from 'zod';

/**
 * Convert a Zod schema to a plain JSON Schema object.
 * Handles the subset of Zod types used in TOOL_MANIFEST.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = schema._def as ZodDef;
  const typeName: string = def.typeName;

  switch (typeName) {
    case 'ZodString':
      return { type: 'string' };

    case 'ZodNumber':
      return { type: 'number' };

    case 'ZodBoolean':
      return { type: 'boolean' };

    case 'ZodLiteral': {
      const literalDef = def as { typeName: string; value: unknown };
      return { const: literalDef.value };
    }

    case 'ZodEnum': {
      const enumDef = def as { typeName: string; values: string[] };
      return { enum: enumDef.values };
    }

    case 'ZodOptional': {
      const optionalDef = def as { typeName: string; innerType: z.ZodTypeAny };
      return zodToJsonSchema(optionalDef.innerType);
    }

    case 'ZodDefault': {
      // .default(value) — runtime substitutes the value when input is undefined.
      // For JSON Schema purposes, the field is treated like the inner type;
      // optionality (i.e. exclusion from `required`) is handled in
      // zodObjectToJsonSchema by inspecting the wrapper typeName.
      const defaultDef = def as {
        typeName: string;
        innerType: z.ZodTypeAny;
        defaultValue: () => unknown;
      };
      const inner = zodToJsonSchema(defaultDef.innerType);
      try {
        inner['default'] = defaultDef.defaultValue();
      } catch {
        // defaultValue() may throw if the closure references runtime state;
        // omit `default` rather than fail the whole conversion.
      }
      return inner;
    }

    case 'ZodNullable': {
      const nullableDef = def as { typeName: string; innerType: z.ZodTypeAny };
      const inner = zodToJsonSchema(nullableDef.innerType);
      // JSON Schema doesn't have a first-class nullable; widen via oneOf so the
      // converter stays lossless for documented input shapes.
      return { oneOf: [inner, { type: 'null' }] };
    }

    case 'ZodRecord': {
      const recordDef = def as {
        typeName: string;
        keyType?: z.ZodTypeAny;
        valueType?: z.ZodTypeAny;
      };
      const valueSchema = recordDef.valueType
        ? zodToJsonSchema(recordDef.valueType)
        : {};
      return { type: 'object', additionalProperties: valueSchema };
    }

    case 'ZodObject': {
      return zodObjectToJsonSchema(schema as z.ZodObject<z.ZodRawShape>);
    }

    case 'ZodArray': {
      const arrayDef = def as { typeName: string; type: z.ZodTypeAny };
      return {
        type: 'array',
        items: zodToJsonSchema(arrayDef.type),
      };
    }

    case 'ZodDiscriminatedUnion': {
      const duDef = def as {
        typeName: string;
        options: Map<string, z.ZodTypeAny> | z.ZodTypeAny[];
      };
      // options can be a Map (Zod v3.20+) or an array depending on version
      let optionsList: z.ZodTypeAny[];
      if (duDef.options instanceof Map) {
        optionsList = Array.from(duDef.options.values()) as z.ZodTypeAny[];
      } else if (Array.isArray(duDef.options)) {
        optionsList = duDef.options as z.ZodTypeAny[];
      } else {
        // Fallback: treat as iterable
        optionsList = Array.from(
          duDef.options as Iterable<z.ZodTypeAny>,
        );
      }
      return { oneOf: optionsList.map(zodToJsonSchema) };
    }

    case 'ZodUnion': {
      const unionDef = def as { typeName: string; options: z.ZodTypeAny[] };
      return { oneOf: unionDef.options.map(zodToJsonSchema) };
    }

    case 'ZodAny':
      return {};

    case 'ZodUnknown':
      // Same JSON-Schema shape as ZodAny — no type constraint.
      return {};

    default:
      throw new Error(`zodToJsonSchema: unsupported Zod type ${typeName}`);
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

interface ZodDef {
  typeName: string;
  [key: string]: unknown;
}

function zodObjectToJsonSchema(
  schema: z.ZodObject<z.ZodRawShape>,
): Record<string, unknown> {
  const shape = schema.shape as Record<string, z.ZodTypeAny>;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, fieldSchema] of Object.entries(shape)) {
    // Unwrap optionality to get the inner JSON schema. Fields wrapped in
    // ZodOptional or ZodDefault are not required: ZodDefault substitutes a
    // value when input is undefined, so the caller can legally omit the key.
    const fieldDef = (fieldSchema._def as ZodDef).typeName;
    const isOptional = fieldDef === 'ZodOptional' || fieldDef === 'ZodDefault';

    properties[key] = zodToJsonSchema(fieldSchema);

    if (!isOptional) {
      required.push(key);
    }
  }

  const result: Record<string, unknown> = {
    type: 'object',
    properties,
  };

  if (required.length > 0) {
    result['required'] = required;
  }

  // unknownKeys strategy:
  //   'strip'       → default ZodObject (no constraint added)
  //   'strict'      → z.object({}).strict()       → additionalProperties: false
  //   'passthrough' → z.object({}).passthrough()  → additionalProperties: true
  const unknownKeys = (schema._def as { unknownKeys?: string }).unknownKeys;
  if (unknownKeys === 'strict') {
    result['additionalProperties'] = false;
  } else if (unknownKeys === 'passthrough') {
    result['additionalProperties'] = true;
  }

  return result;
}
