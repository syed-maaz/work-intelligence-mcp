/**
 * Tests for zodToJsonSchema walker (Phase 72-02)
 *
 * 12 tests covering all Zod shapes used in TOOL_MANIFEST.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { zodToJsonSchema } from '../../src/tools/zod-to-json-schema.js';
import { TOOL_MANIFEST } from '../../src/tools/manifest.js';

describe('zodToJsonSchema', () => {
  // Test 1: string
  it('converts ZodString to {type:"string"}', () => {
    expect(zodToJsonSchema(z.string())).toEqual({ type: 'string' });
  });

  // Test 2: number
  it('converts ZodNumber to {type:"number"}', () => {
    expect(zodToJsonSchema(z.number())).toEqual({ type: 'number' });
  });

  // Test 3: boolean
  it('converts ZodBoolean to {type:"boolean"}', () => {
    expect(zodToJsonSchema(z.boolean())).toEqual({ type: 'boolean' });
  });

  // Test 4: literal
  it("converts ZodLiteral('issues') to {const:'issues'}", () => {
    expect(zodToJsonSchema(z.literal('issues'))).toEqual({ const: 'issues' });
  });

  // Test 5: enum
  it("converts ZodEnum(['a','b']) to {enum:['a','b']}", () => {
    expect(zodToJsonSchema(z.enum(['a', 'b']))).toEqual({ enum: ['a', 'b'] });
  });

  // Test 6: strict object → additionalProperties:false; optional field absent from required
  it('strict object has additionalProperties:false and optional field not in required', () => {
    const schema = z.object({ name: z.string(), note: z.string().optional() }).strict();
    const result = zodToJsonSchema(schema);
    expect(result['additionalProperties']).toBe(false);
    expect(result['required']).toEqual(['name']);
    expect(result['properties']).toHaveProperty('name');
    expect(result['properties']).toHaveProperty('note');
  });

  // Test 7: passthrough object → additionalProperties:true
  it('passthrough object has additionalProperties:true', () => {
    const schema = z.object({ id: z.string() }).passthrough();
    const result = zodToJsonSchema(schema);
    expect(result['additionalProperties']).toBe(true);
  });

  // Test 8: optional field not in required array
  it('optional field is absent from required array', () => {
    const schema = z.object({ required_field: z.string(), opt_field: z.number().optional() }).strict();
    const result = zodToJsonSchema(schema);
    const req = result['required'] as string[];
    expect(req).toContain('required_field');
    expect(req).not.toContain('opt_field');
  });

  // Test 9: array of strings
  it('converts ZodArray of strings to {type:array, items:{type:string}}', () => {
    const schema = z.array(z.string());
    const result = zodToJsonSchema(schema);
    expect(result).toEqual({ type: 'array', items: { type: 'string' } });
  });

  // Test 10: discriminatedUnion → {oneOf:[...]}
  it('converts discriminatedUnion to {oneOf:[...]}', () => {
    const schema = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('a'), value: z.string() }).strict(),
      z.object({ kind: z.literal('b'), count: z.number() }).strict(),
    ]);
    const result = zodToJsonSchema(schema);
    expect(result).toHaveProperty('oneOf');
    const oneOf = result['oneOf'] as unknown[];
    expect(oneOf).toHaveLength(2);
  });

  // Test 11: throws on unsupported shape (z.function())
  it('throws on unsupported Zod type', () => {
    const fnSchema = z.function();
    expect(() => zodToJsonSchema(fnSchema as unknown as z.ZodTypeAny)).toThrow(
      'zodToJsonSchema: unsupported Zod type',
    );
  });

  // Test 12: manifest smoke test — all 22 tool inputSchemas must not throw
  it('does not throw for any TOOL_MANIFEST entry inputSchema', () => {
    expect(TOOL_MANIFEST).toHaveLength(22);
    for (const entry of TOOL_MANIFEST) {
      expect(() => zodToJsonSchema(entry.inputSchema)).not.toThrow();
    }
  });
});
