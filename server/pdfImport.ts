// PDF -> document blocks. A small dependency-free text extractor: it inflates the page content streams and reads
// the text-showing operators, so it handles ordinary text PDFs with simple font encodings. Scanned (image-only)
// PDFs, encrypted files and fonts with custom encodings yield no (or garbled) text.
import { inflateSync } from 'node:zlib';
import type { Doc } from '../shared/doc.ts';
import { markdownToDoc } from '../shared/docMarkdown.ts';
import { ImportError } from './xlsxImport.ts';

export const MAX_PDF_BYTES = 20 * 1024 * 1024;

export const isPdf = (buf: Buffer): boolean => buf.subarray(0, 1024).includes('%PDF-');

interface Line {
  text: string;
  y: number;
  size: number;
}

const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };

/** Pull the text lines out of one decoded content stream. */
function readContent(src: string, out: Line[]): void {
  let i = 0;
  let y = 0;
  let size = 12;
  let cur = '';
  let curY = 0;
  let curSize = 12;
  const nums: number[] = [];
  const flush = () => {
    if (cur.trim()) out.push({ text: cur.replace(/\s+/g, ' ').trim(), y: curY, size: curSize });
    cur = '';
  };
  const show = (s: string) => {
    if (!cur) {
      curY = y;
      curSize = size;
    }
    cur += s;
  };
  const readString = (): string => {
    let depth = 1;
    let s = '';
    i++;
    while (i < src.length && depth > 0) {
      const c = src[i++];
      if (c === '\\') {
        const n = src[i++];
        if (/[0-7]/.test(n)) {
          let oct = n;
          while (oct.length < 3 && /[0-7]/.test(src[i] ?? '')) oct += src[i++];
          s += String.fromCharCode(parseInt(oct, 8));
        } else if (n === '\n' || n === '\r') {
          if (n === '\r' && src[i] === '\n') i++;
        } else s += ESCAPES[n] ?? n;
      } else if (c === '(') {
        depth++;
        s += c;
      } else if (c === ')') {
        if (--depth > 0) s += c;
      } else s += c;
    }
    return s;
  };
  const readHex = (): string => {
    const end = src.indexOf('>', i);
    const hex = src.slice(i + 1, end < 0 ? src.length : end).replace(/\s+/g, '');
    i = end < 0 ? src.length : end + 1;
    let s = '';
    for (let k = 0; k < hex.length; k += 2) s += String.fromCharCode(parseInt(hex.slice(k, k + 2).padEnd(2, '0'), 16));
    return s;
  };
  const move = (dy: number) => {
    y += dy;
    flush();
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '(') show(readString());
    else if (c === '<' && src[i + 1] !== '<') show(readHex());
    else if (c === '[') {
      // TJ array: strings joined, large negative kerning is a word space.
      i++;
      while (i < src.length && src[i] !== ']') {
        if (src[i] === '(') show(readString());
        else if (src[i] === '<') show(readHex());
        else {
          const m = /^-?\d+(\.\d+)?/.exec(src.slice(i, i + 20));
          if (m) {
            if (Number(m[0]) < -200) show(' ');
            i += m[0].length;
          } else i++;
        }
      }
      i++;
    } else if (c === '%') {
      while (i < src.length && src[i] !== '\n' && src[i] !== '\r') i++;
    } else if (/[-+.\d]/.test(c)) {
      const m = /^[-+]?(\d+\.?\d*|\.\d+)/.exec(src.slice(i, i + 24));
      if (m) {
        nums.push(Number(m[0]));
        if (nums.length > 8) nums.shift();
        i += m[0].length;
      } else i++;
    } else if (/[A-Za-z'"*]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9'"*]/.test(src[j])) j++;
      const op = src.slice(i, j);
      i = j;
      if (op === 'Tf') size = Math.abs(nums[nums.length - 1] ?? size) || size;
      else if (op === 'Td' || op === 'TD') move(nums[nums.length - 1] ?? 0);
      else if (op === 'Tm') {
        const ny = nums[nums.length - 1] ?? y;
        if (Math.abs(ny - y) > 0.5) flush();
        y = ny;
        const scale = Math.abs(nums[nums.length - 5] ?? 1);
        if (scale && scale !== 1) size = size * scale;
      } else if (op === 'T*' || op === "'" || op === '"') move(-size * 1.2);
      else if (op === 'ET' || op === 'BT') flush();
      nums.length = op === 'Tf' || op === 'Td' || op === 'TD' || op === 'Tm' ? 0 : nums.length;
    } else i++;
  }
  flush();
}

function contentStreams(buf: Buffer): string[] {
  const raw = buf.toString('latin1');
  const streams: string[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    const dict = raw.slice(Math.max(0, raw.lastIndexOf('obj', m.index)), m.index);
    re.lastIndex = end;
    if (/\/(Image|XObject|ObjStm|XRef|FontFile|Metadata)/.test(dict)) continue;
    let data = buf.subarray(start, end);
    if (/\/FlateDecode/.test(dict)) {
      try {
        data = inflateSync(data);
      } catch {
        continue;
      }
    } else if (/\/Filter/.test(dict)) continue;
    const text = data.toString('latin1');
    if (/\bBT\b/.test(text) && /\bET\b/.test(text)) streams.push(text);
  }
  return streams;
}

const escapeMd = (s: string) => s.replace(/^([#>*+-]|\d+[.)])(\s)/, '\\$1$2').replace(/[\\`*_[\]]/g, '\\$&');

/** Turn extracted lines into Markdown: blank line between paragraphs, larger text becomes headings. */
export function linesToMarkdown(lines: Line[]): string {
  if (!lines.length) return '';
  const counts = new Map<number, number>();
  for (const l of lines) counts.set(Math.round(l.size), (counts.get(Math.round(l.size)) ?? 0) + l.text.length);
  const body = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const bigs = [...new Set(lines.filter((l) => l.size >= body * 1.15).map((l) => Math.round(l.size)))].sort((a, b) => b - a);
  const gaps = lines.slice(1).map((l, k) => Math.abs(lines[k].y - l.y)).filter((g) => g > 0 && g < 100).sort((a, b) => a - b);
  const typical = gaps.length ? gaps[Math.floor(gaps.length / 2)] : body * 1.2;
  const blocks: string[] = [];
  let para: string[] = [];
  const endPara = () => {
    if (para.length) blocks.push(escapeMd(para.join(' ')));
    para = [];
  };
  lines.forEach((l, k) => {
    const level = l.size >= body * 1.15 && l.text.length <= 120 ? Math.min(3, bigs.indexOf(Math.round(l.size)) + 1) : 0;
    if (level) {
      endPara();
      blocks.push(`${'#'.repeat(level)} ${escapeMd(l.text)}`);
      return;
    }
    const gap = k > 0 ? Math.abs(lines[k - 1].y - l.y) : 0;
    if (para.length && gap > typical * 1.5) endPara();
    para.push(l.text);
  });
  endPara();
  return blocks.join('\n\n');
}

export function importPdf(buf: Buffer): { doc: Doc; warnings: string[] } {
  if (!isPdf(buf)) throw new ImportError('This file is not a valid PDF.');
  if (buf.length > MAX_PDF_BYTES) throw new ImportError(`This PDF is too large to import (${MAX_PDF_BYTES / 1024 / 1024} MB maximum).`);
  if (/\/Encrypt\b/.test(buf.toString('latin1'))) throw new ImportError('This PDF is password-protected and cannot be imported.');
  const lines: Line[] = [];
  for (const s of contentStreams(buf)) readContent(s, lines);
  const md = linesToMarkdown(lines);
  if (!md.trim()) throw new ImportError('No text could be extracted from this PDF. It may be a scanned image.');
  return { doc: markdownToDoc(md), warnings: [] };
}
