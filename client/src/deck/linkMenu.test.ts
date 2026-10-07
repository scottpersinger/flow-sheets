import { describe, expect, it } from 'vitest';
import { linkLabel, normalizeLinkUrl } from './SlideView.tsx';

describe('slide link menu helpers', () => {
  it('normalizes typed URLs', () => {
    expect(normalizeLinkUrl(' example.com ')).toBe('https://example.com');
    expect(normalizeLinkUrl('http://a.b/c')).toBe('http://a.b/c');
    expect(normalizeLinkUrl('mailto:a@b.c')).toBe('mailto:a@b.c');
    expect(normalizeLinkUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeLinkUrl('  ')).toBeNull();
  });
  it('shortens the label', () => {
    expect(linkLabel('https://example.com/x')).toBe('example.com/x');
    expect(linkLabel('mailto:a@b.c')).toBe('a@b.c');
  });
});
