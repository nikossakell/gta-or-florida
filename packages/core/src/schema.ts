/**
 * Lean runtime validation (no dependency): strict object shapes, bounded
 * strings/arrays, enums. Used for untrusted input at every boundary
 * (HTTP bodies, model output, import batches). Unknown object keys are errors.
 */

export type SchemaIssue = { path: string; message: string };
export type ParseResult<T> = { ok: true; value: T } | { ok: false; issues: SchemaIssue[] };

export interface Schema<T> {
  readonly _type?: T;
  check(value: unknown, path: string, issues: SchemaIssue[]): T | undefined;
}

export type Infer<S> = S extends Schema<infer T> ? T : never;

const at = (path: string, key: string | number) => (path ? `${path}.${key}` : String(key));

function make<T>(check: Schema<T>['check']): Schema<T> {
  return { check };
}

export const s = {
  string(opts: { min?: number; max: number; pattern?: RegExp; trim?: boolean }): Schema<string> {
    return make((v, path, issues) => {
      if (typeof v !== 'string') return void issues.push({ path, message: 'expected string' });
      const value = opts.trim === false ? v : v.trim();
      if (value.length < (opts.min ?? 0)) return void issues.push({ path, message: `must be at least ${opts.min} characters` });
      if (value.length > opts.max) return void issues.push({ path, message: `must be at most ${opts.max} characters` });
      if (opts.pattern && !opts.pattern.test(value)) return void issues.push({ path, message: 'has an invalid format' });
      return value;
    });
  },
  int(opts: { min: number; max: number }): Schema<number> {
    return make((v, path, issues) => {
      if (typeof v !== 'number' || !Number.isInteger(v)) return void issues.push({ path, message: 'expected integer' });
      if (v < opts.min || v > opts.max) return void issues.push({ path, message: `must be between ${opts.min} and ${opts.max}` });
      return v;
    });
  },
  number(opts: { min: number; max: number }): Schema<number> {
    return make((v, path, issues) => {
      if (typeof v !== 'number' || !Number.isFinite(v)) return void issues.push({ path, message: 'expected number' });
      if (v < opts.min || v > opts.max) return void issues.push({ path, message: `must be between ${opts.min} and ${opts.max}` });
      return v;
    });
  },
  boolean(): Schema<boolean> {
    return make((v, path, issues) => (typeof v === 'boolean' ? v : void issues.push({ path, message: 'expected boolean' })));
  },
  literal<const L extends string | number | boolean>(lit: L): Schema<L> {
    return make((v, path, issues) => (v === lit ? lit : void issues.push({ path, message: `expected ${JSON.stringify(lit)}` })));
  },
  enum<const E extends string>(values: readonly E[]): Schema<E> {
    return make((v, path, issues) =>
      typeof v === 'string' && (values as readonly string[]).includes(v) ? (v as E) : void issues.push({ path, message: `expected one of ${values.join(', ')}` }),
    );
  },
  array<T>(of: Schema<T>, opts: { max: number; min?: number }): Schema<T[]> {
    return make((v, path, issues) => {
      if (!Array.isArray(v)) return void issues.push({ path, message: 'expected array' });
      if (v.length > opts.max) return void issues.push({ path, message: `at most ${opts.max} items` });
      if (v.length < (opts.min ?? 0)) return void issues.push({ path, message: `at least ${opts.min} items` });
      const before = issues.length;
      const out = v.map((item, i) => of.check(item, at(path, i), issues));
      return issues.length === before ? (out as T[]) : undefined;
    });
  },
  optional<T>(inner: Schema<T>): Schema<T | undefined> & { optional: true } {
    return { optional: true, check: (v, path, issues) => (v === undefined ? undefined : inner.check(v, path, issues)) };
  },
  nullable<T>(inner: Schema<T>): Schema<T | null> {
    return make((v, path, issues) => (v === null ? null : inner.check(v, path, issues)));
  },
  object<Shape extends Record<string, Schema<unknown>>>(shape: Shape): Schema<ObjectOf<Shape>> {
    return make((v, path, issues) => {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return void issues.push({ path, message: 'expected object' });
      const before = issues.length;
      const rec = v as Record<string, unknown>;
      for (const key of Object.keys(rec)) {
        if (!Object.hasOwn(shape, key)) issues.push({ path: at(path, key), message: 'unknown field' });
      }
      const out: Record<string, unknown> = {};
      for (const [key, schema] of Object.entries(shape)) {
        const value = rec[key];
        if (value === undefined && !(schema as { optional?: boolean }).optional) {
          issues.push({ path: at(path, key), message: 'is required' });
          continue;
        }
        const parsed = schema.check(value, at(path, key), issues);
        if (parsed !== undefined) out[key] = parsed;
        else if (value === null) out[key] = null;
      }
      return issues.length === before ? (out as ObjectOf<Shape>) : undefined;
    });
  },
};

type OptionalKeys<Shape> = { [K in keyof Shape]: Shape[K] extends { optional: true } ? K : never }[keyof Shape];
type ObjectOf<Shape extends Record<string, Schema<unknown>>> = {
  [K in Exclude<keyof Shape, OptionalKeys<Shape>>]: Infer<Shape[K]>;
} & { [K in OptionalKeys<Shape>]?: Exclude<Infer<Shape[K]>, undefined> };

export function parse<T>(schema: Schema<T>, value: unknown): ParseResult<T> {
  const issues: SchemaIssue[] = [];
  const out = schema.check(value, '', issues);
  if (issues.length > 0 || (out === undefined && value !== undefined)) {
    return { ok: false, issues: issues.length ? issues : [{ path: '', message: 'invalid value' }] };
  }
  return { ok: true, value: out as T };
}

export function formatIssues(issues: readonly SchemaIssue[], max = 8): string {
  const shown = issues.slice(0, max).map((i) => `${i.path || '(root)'}: ${i.message}`);
  return shown.join('; ') + (issues.length > max ? `; +${issues.length - max} more` : '');
}
