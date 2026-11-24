import { describe, expect, it } from 'vitest';
import { longestSharedWordRun, nearCopyProblems, placeholderProblems } from '../src/index.ts';

describe('near-copy safeguards (not proof of originality)', () => {
  const H = 'Pace Man Pleads Guilty to Theft of National Park Signs';
  it('measures shared word runs after normalization', () => {
    expect(longestSharedWordRun('he pleads GUILTY to theft of national signs', H)).toBe(6); // "pleads guilty to theft of national"
    expect(longestSharedWordRun('a collector carted off federal signs', H)).toBe(1);
  });
  it('flags close rewordings and copied phrases, passes genuinely different wording', () => {
    expect(nearCopyProblems('Pace man pleads guilty in theft of national park signage', H, 'PLAY_TITLE').join()).toMatch(/PLAY_TITLE_NEAR_COPY/);
    expect(nearCopyProblems('Records show he pleads guilty to theft of national park signs', H, 'EXPLANATION').join()).toMatch(/EXPLANATION_SHARED_PHRASE/);
    expect(nearCopyProblems('A collector quietly carted off dozens of federal signs from a protected seashore', H, 'PLAY_TITLE')).toEqual([]);
    expect(nearCopyProblems('anything', '', 'PLAY_TITLE')).toEqual([]);
  });
});

describe('placeholderProblems', () => {
  const codes = (t: string, f: 'PLAY_TITLE' | 'EXPLANATION') => placeholderProblems(t, f).map((p) => p.split(':')[0]);
  it('refuses template, placeholder, all-caps and generic text', () => {
    expect(codes('YOUR OWN REVIEWED TITLE', 'PLAY_TITLE')).toEqual(['PLAY_TITLE_PLACEHOLDER', 'PLAY_TITLE_ALL_CAPS']);
    expect(codes('YOUR OWN VERIFIED EXPLANATION', 'EXPLANATION')).toEqual(['EXPLANATION_PLACEHOLDER', 'EXPLANATION_ALL_CAPS', 'EXPLANATION_GENERIC']);
    for (const t of ['Your own reviewed title here', 'Neutral title goes here please', 'Lorem ipsum dolor sit amet', 'TODO write a better one later', 'Insert the explanation text here', '{{playTitle}} for the round', 'A man did [SOMETHING] in a town', 'xxxxx xxxx xxxxx xxx'])
      expect(codes(t, 'PLAY_TITLE'), t).toContain('PLAY_TITLE_PLACEHOLDER');
    expect(codes('A MAN STEALS A BOAT IN TAMPA', 'PLAY_TITLE')).toContain('PLAY_TITLE_ALL_CAPS');
    expect(codes('Title title title title', 'PLAY_TITLE')).toContain('PLAY_TITLE_GENERIC');
    expect(codes('See the source', 'EXPLANATION')).toEqual(expect.arrayContaining(['EXPLANATION_PLACEHOLDER', 'EXPLANATION_GENERIC']));
  });
  it('accepts ordinary reviewer text, including acronyms and numbers', () => {
    expect(placeholderProblems('A collector quietly carted off dozens of federal signs from a protected seashore', 'PLAY_TITLE')).toEqual([]);
    expect(placeholderProblems('A crew ambushes an armored security van to grab the cash inside', 'PLAY_TITLE')).toEqual([]);
    expect(placeholderProblems('He admitted in federal court that he removed 40 signs from NPS land; the FBI and USCG assisted.', 'EXPLANATION')).toEqual([]);
    expect(placeholderProblems('Man steals a $2,000 alligator statue in Ocala', 'PLAY_TITLE')).toEqual([]);
  });
});
