import { describe, expect, it } from 'vitest';
import { bearerTokenProblems } from '../src/index.ts';

/** The API Worker's parser (apps/worker/src/security/auth.ts) plus its 32-char minimum for configured secrets. */
const apiAccepts = (t: string) => /^Bearer ([\x21-\x7e]{1,512})$/.test(`Bearer ${t}`) && t.length >= 32;

describe('bearerTokenProblems', () => {
  it('accepts exactly what the API Worker can authenticate (randomized)', () => {
    let seed = 7;
    const r = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const alphabet = ['a', 'Z', '0', '-', '_', '+', '/', '=', '"', ' ', '\t', '\n', '\r', '\u001b', '\u007f', ' ', 'é', '​'];
    for (let i = 0; i < 3000; i++) {
      const len = Math.floor(r() * 80);
      // Mostly clean tokens with an occasional bad character, plus boundary lengths.
      let t = Array.from({ length: len }, () => (r() < 0.9 ? 'a0Z-_'[Math.floor(r() * 5)]! : alphabet[Math.floor(r() * alphabet.length)]!)).join('');
      if (i % 500 === 0) t = 'b'.repeat([31, 32, 512, 513][(i / 500) % 4]!);
      expect(bearerTokenProblems(t).length === 0, JSON.stringify({ len: t.length })).toBe(apiAccepts(t));
    }
  });

  it('names the problem category without echoing the value', () => {
    const t = 'c'.repeat(40);
    expect(bearerTokenProblems(`${t}\n`)).toEqual(['contains spaces, tabs or line breaks']);
    expect(bearerTokenProblems(`Bearer ${t}`)).toEqual(['contains spaces, tabs or line breaks', 'includes the "Bearer " prefix']);
    expect(bearerTokenProblems(`\u001b[200~${t}\u001b[201~`)).toEqual(['contains control characters (e.g. pasted terminal escape codes)']);
    expect(bearerTokenProblems(undefined)).toEqual(['missing']);
    expect(bearerTokenProblems({ toString: () => t })).toEqual(['not a string']);
    for (const p of bearerTokenProblems(`${t} x`)) expect(p.includes(t)).toBe(false);
  });
});
