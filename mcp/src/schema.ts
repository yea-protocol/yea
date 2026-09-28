/**
 * The wrapper Standard Schema that carries `preview` (SPEC-mcp-ts, "The input schema and
 * `preview`"). The SDK validates `tools/call` arguments against the registered schema and hands
 * the callback the parsed value, so a plain object schema would silently drop `preview`. The
 * wrapper takes `preview` off, validates the rest with the author's schema, and marks the result
 * with a symbol key that can't come from JSON.
 *
 * SDK seam: this relies on the SDK passing `validate`'s value straight to the callback, and on
 * it converting `jsonSchema.input` for `tools/list`. Both are covered by tests.
 */
import type {
  StandardSchemaV1,
  StandardSchemaWithJSON,
} from '@modelcontextprotocol/server';
import { isObject, type Obj } from './util.js';

/** Set on the validated input when the call asked for a preview. */
export const PREVIEW: unique symbol = Symbol('yea.preview');

const TARGET = 'draft-2020-12';

const issue = (message: string): StandardSchemaV1.FailureResult => ({
  issues: [{ message }],
});

/** The author's JSON Schema with `preview` added; throws if its root can't carry it. */
function withPreviewField(json: Obj): Obj {
  if (json.type !== 'object') {
    throw new TypeError(
      'a job input schema must be a plain object at its root (z.object(...) or equivalent)',
    );
  }

  const properties = isObject(json.properties) ? json.properties : {};

  if (Object.hasOwn(properties, 'preview')) {
    throw new TypeError(
      'a job input schema may not have a field named preview: it is reserved for previews',
    );
  }

  return {
    ...json,
    properties: {
      ...properties,
      preview: {
        type: 'boolean',
        description: 'Show the plans without running anything.',
      },
    },
  };
}

/** Take `preview` off the arguments, validate the rest, and mark a preview with the symbol. */
async function validateWith(
  inner: StandardSchemaWithJSON,
  value: unknown,
): Promise<StandardSchemaV1.Result<unknown>> {
  if (!isObject(value)) {
    return issue('arguments must be an object');
  }

  const { preview, ...rest } = value;

  if (preview !== undefined && typeof preview !== 'boolean') {
    return issue('preview must be true or false');
  }

  const out = await inner['~standard'].validate(rest);

  if (out.issues) {
    return out;
  }

  if (!isObject(out.value)) {
    return issue('the input schema must produce an object');
  }

  return { value: preview ? { ...out.value, [PREVIEW]: true } : out.value };
}

/**
 * Wrap the author's schema so it carries `preview`. Converts its JSON Schema once now, because
 * the SDK only converts it when listing tools: a schema that can't convert fails registration.
 */
export function previewSchema(
  inner: StandardSchemaWithJSON,
): StandardSchemaWithJSON {
  const std = inner['~standard'];

  if (typeof std?.validate !== 'function' || !std.jsonSchema) {
    throw new TypeError(
      'a job input schema must be a Standard Schema that exposes JSON Schema (zod >= 4.2, ArkType, Valibot, or fromJsonSchema)',
    );
  }

  const json = withPreviewField(std.jsonSchema.input({ target: TARGET }));

  return {
    '~standard': {
      version: 1,
      vendor: 'yea',
      validate: (value) => validateWith(inner, value),
      jsonSchema: {
        input: (o) =>
          o.target === TARGET
            ? json
            : withPreviewField(std.jsonSchema.input(o)),
        output: (o) => std.jsonSchema.output(o),
      },
    },
  };
}

/** Split the wrapper's output into the author's input and whether a preview was asked for. */
export function takePreview(args: unknown): {
  input: Obj;
  preview: boolean;
} {
  if (!isObject(args)) {
    throw new TypeError('the job input was not validated as an object');
  }

  const { [PREVIEW]: preview, ...input } = args as Obj & {
    [PREVIEW]?: boolean;
  };

  return { input, preview: preview === true };
}
