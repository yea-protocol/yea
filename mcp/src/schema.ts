/**
 * The wrapper Standard Schema that carries `preview` and `yea_consent` (SPEC-mcp-ts, "The input
 * schema, `preview` and `yea_consent`"). The SDK validates `tools/call` arguments against the
 * registered schema and hands the callback the parsed value, so a plain object schema would
 * silently drop them. The wrapper takes them off, validates the rest with the author's schema,
 * and marks the result with symbol keys that can't come from JSON.
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

/** Set on the validated input to the consent the call carries (SPEC-approval §6). */
const CONSENT: unique symbol = Symbol('yea.consent');

/** What a job call takes beside the tool's own input. */
export interface Reserved {
  preview: boolean;
  /** The consent `yea approve` printed, passed back as `yea_consent`. */
  consent?: string;
}

/** The arguments every job tool takes beside its own, and what each is reserved for. */
const RESERVED = {
  preview: {
    for: 'previews',
    schema: {
      type: 'boolean',
      description: 'Show the plans without running anything.',
    },
  },
  yea_consent: {
    for: 'consents from yea approve',
    schema: {
      type: 'string',
      description:
        'The consent (pg1.…) the user got from `yea approve` and pasted back, exactly as printed. Only when calling again after a result asked for approval.',
    },
  },
} as const;

const TARGET = 'draft-2020-12';

const issue = (message: string): StandardSchemaV1.FailureResult => ({
  issues: [{ message }],
});

/** The author's JSON Schema with the reserved fields added; throws if its root can't carry them. */
function withReservedFields(json: Obj): Obj {
  if (json.type !== 'object') {
    throw new TypeError(
      'a job input schema must be a plain object at its root (z.object(...) or equivalent)',
    );
  }

  const properties = isObject(json.properties) ? json.properties : {};

  for (const [name, field] of Object.entries(RESERVED)) {
    if (Object.hasOwn(properties, name)) {
      throw new TypeError(
        `a job input schema may not have a field named ${name}: it is reserved for ${field.for}`,
      );
    }
  }

  return {
    ...json,
    properties: {
      ...properties,
      preview: RESERVED.preview.schema,
      yea_consent: RESERVED.yea_consent.schema,
    },
  };
}

/** Why the reserved arguments can't be used, or null: a JSON boolean, and a string or null. */
function reservedIssue(preview: unknown, consent: unknown): string | null {
  if (preview !== undefined && typeof preview !== 'boolean') {
    return 'preview must be true or false';
  }

  return consent === undefined ||
    consent === null ||
    typeof consent === 'string'
    ? null
    : 'yea_consent must be a string: the consent yea approve printed';
}

/** Take the reserved arguments off, validate the rest, and mark what was given with symbols. */
async function validateWith(
  inner: StandardSchemaWithJSON,
  value: unknown,
): Promise<StandardSchemaV1.Result<unknown>> {
  if (!isObject(value)) {
    return issue('arguments must be an object');
  }

  const { preview, yea_consent: consent, ...rest } = value;
  const why = reservedIssue(preview, consent);

  if (why) {
    return issue(why);
  }

  const out = await inner['~standard'].validate(rest);

  if (out.issues) {
    return out;
  }

  if (!isObject(out.value)) {
    return issue('the input schema must produce an object');
  }

  return {
    value: {
      ...out.value,
      ...(preview ? { [PREVIEW]: true } : {}),
      ...(typeof consent === 'string' ? { [CONSENT]: consent } : {}),
    },
  };
}

/**
 * Wrap the author's schema so it carries `preview` and `yea_consent`. Converts its JSON Schema
 * once now, because the SDK only converts it when listing tools: a schema that can't convert
 * fails registration.
 */
export function jobInputSchema(
  inner: StandardSchemaWithJSON,
): StandardSchemaWithJSON {
  const std = inner['~standard'];

  if (typeof std?.validate !== 'function' || !std.jsonSchema) {
    throw new TypeError(
      'a job input schema must be a Standard Schema that exposes JSON Schema (zod >= 4.2, ArkType, Valibot, or fromJsonSchema)',
    );
  }

  const json = withReservedFields(std.jsonSchema.input({ target: TARGET }));

  return {
    '~standard': {
      version: 1,
      vendor: 'yea',
      validate: (value) => validateWith(inner, value),
      jsonSchema: {
        input: (o) =>
          o.target === TARGET
            ? json
            : withReservedFields(std.jsonSchema.input(o)),
        output: (o) => std.jsonSchema.output(o),
      },
    },
  };
}

/**
 * What `guard` wraps for a tool registered without a schema, which the SDK calls as `cb(ctx)`:
 * any object, of which the tool takes nothing, so `describe` sees `{}`. Its JSON Schema is the
 * SDK's own listing for such a tool.
 */
export const NO_INPUT: StandardSchemaWithJSON = {
  '~standard': {
    version: 1,
    vendor: 'yea',
    validate: (value) =>
      isObject(value) ? { value: {} } : issue('arguments must be an object'),
    jsonSchema: {
      input: () => ({ type: 'object', properties: {} }),
      output: () => ({ type: 'object', properties: {} }),
    },
  },
};

/** Split the wrapper's output into the author's input and the reserved arguments. */
export function takeReserved(args: unknown): Reserved & { input: Obj } {
  if (!isObject(args)) {
    throw new TypeError('the job input was not validated as an object');
  }

  const {
    [PREVIEW]: preview,
    [CONSENT]: consent,
    ...input
  } = args as Obj & { [PREVIEW]?: boolean; [CONSENT]?: string };

  return {
    input,
    preview: preview === true,
    ...(typeof consent === 'string' ? { consent } : {}),
  };
}
