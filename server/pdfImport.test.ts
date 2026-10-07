import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { docToMarkdown } from '../shared/docMarkdown.ts';
import { docSchema } from '../shared/doc.ts';
import { importPdf } from './pdfImport.ts';

function makePdf(content: string, compress = true): Buffer {
  const data = compress ? deflateSync(Buffer.from(content, 'latin1')) : Buffer.from(content, 'latin1');
  return Buffer.concat([
    Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${data.length}${compress ? ' /Filter /FlateDecode' : ''} >>\nstream\n`),
    data,
    Buffer.from('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF'),
  ]);
}

const md = (buf: Buffer) => docToMarkdown(docSchema.nodeFromJSON(importPdf(buf).doc.content));

describe('importPdf', () => {
  it('keeps paragraphs apart and turns large text into headings', () => {
    const pdf = makePdf(
      'BT /F1 24 Tf 72 720 Td (My Report) Tj ET\n' +
        'BT /F1 12 Tf 72 680 Td (First line of one) Tj 0 -14 Td [(second \\(line\\)) -300 (end)] TJ ET\n' +
        'BT /F1 12 Tf 72 620 Td (Another paragraph) Tj 0 -14 Td (continues here) Tj ET',
    );
    const out = md(pdf);
    expect(out).toContain('# My Report');
    expect(out).toContain('First line of one second (line) end');
    expect(out).toContain('Another paragraph continues here');
    expect(out.split('\n\n').length).toBeGreaterThanOrEqual(3);
  });

  it('reads uncompressed streams', () => {
    expect(md(makePdf('BT /F1 12 Tf 72 700 Td (Plain text) Tj ET', false))).toContain('Plain text');
  });

  it('rejects PDFs without text, and non-PDFs', () => {
    expect(() => importPdf(makePdf('0 0 m 10 10 l S'))).toThrow(/No text/);
    expect(() => importPdf(Buffer.from('hello'))).toThrow(/not a valid PDF/);
  });
});
