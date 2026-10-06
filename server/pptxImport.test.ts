import { describe, expect, it } from 'vitest';
import { buildSlide, newId, slideTitle, type Deck, type ImageElement, type LineElement, type ShapeElement, type TextElement } from '../shared/deck.ts';
import { buildPptx, fontFace, hexColor } from '../shared/pptxExport.ts';
import JSZip from 'jszip';
import { importPptx, isPptx } from './pptxImport.ts';

// A 1×1 red PNG.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

async function pptxBuffer(deck: Deck): Promise<{ buf: Buffer; warnings: string[] }> {
  const { pres, warnings } = await buildPptx(deck, 'Round trip', async (src) => (src.startsWith('data:') ? src : null));
  const out = (await pres.write({ outputType: 'nodebuffer' })) as Buffer;
  return { buf: Buffer.from(out), warnings };
}

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/**
 * A presentation the way Google Slides exports one: text takes its size, weight, color and font from the master's
 * text styles and placeholders, not from the runs.
 */
async function googleStylePptx(): Promise<Buffer> {
  const rels = (items: [string, string, string][]) =>
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join('')}</Relationships>`;
  const lvl = (inner: string) => `<a:lvl1pPr>${inner}</a:lvl1pPr>`;
  const sp = (id: string, inner: string) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="s${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>${inner}</p:sp>`;
  const ph = (id: string, phAttrs: string, inner: string) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="s${id}"/><p:cNvSpPr txBox="1"/><p:nvPr><p:ph ${phAttrs}/></p:nvPr></p:nvSpPr>${inner}</p:sp>`;
  const xfrm = (x: number, y: number, cx: number, cy: number, flip = '') => `<a:xfrm${flip}><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`;
  const geom = (prst: string) => `<a:prstGeom prst="${prst}"><a:avLst/></a:prstGeom>`;
  const theme = `<a:theme ${NS} name="T"><a:themeElements><a:clrScheme name="Simple Light"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="595959"/></a:dk2><a:lt2><a:srgbClr val="EEEEEE"/></a:lt2><a:accent1><a:srgbClr val="4285F4"/></a:accent1><a:accent2><a:srgbClr val="212121"/></a:accent2><a:accent3><a:srgbClr val="78909C"/></a:accent3><a:accent4><a:srgbClr val="FFAB40"/></a:accent4><a:accent5><a:srgbClr val="0097A7"/></a:accent5><a:accent6><a:srgbClr val="EEFF41"/></a:accent6><a:hlink><a:srgbClr val="0097A7"/></a:hlink><a:folHlink><a:srgbClr val="0097A7"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Arial"/></a:majorFont><a:minorFont><a:latin typeface="Verdana"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`;
  const master =
    `<p:sldMaster ${NS}><p:cSld><p:spTree>` +
    ph('1', 'type="title"', `<p:spPr>${xfrm(311700, 445025, 8520600, 572700)}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle>${lvl('<a:defRPr sz="2800"><a:solidFill><a:schemeClr val="dk1"/></a:solidFill></a:defRPr>')}</a:lstStyle><a:p/></p:txBody>`) +
    ph('2', 'idx="1" type="body"', `<p:spPr>${xfrm(311700, 1152475, 8520600, 3416400)}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle>${lvl('<a:lnSpc><a:spcPct val="115000"/></a:lnSpc><a:buChar char="●"/><a:defRPr sz="1800"><a:solidFill><a:schemeClr val="dk2"/></a:solidFill></a:defRPr>')}</a:lstStyle><a:p/></p:txBody>`) +
    `</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
    `<p:txStyles><p:titleStyle>${lvl('<a:defRPr b="0" sz="1400"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr>')}</p:titleStyle>` +
    `<p:bodyStyle>${lvl('<a:defRPr b="0" sz="1400"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr>')}</p:bodyStyle>` +
    `<p:otherStyle>${lvl('<a:defRPr b="0" i="1" sz="1400"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:latin typeface="Arial"/></a:defRPr>')}</p:otherStyle></p:txStyles></p:sldMaster>`;
  const layout =
    `<p:sldLayout ${NS}><p:cSld><p:spTree>` +
    ph('1', 'type="title"', `<p:spPr>${xfrm(311700, 445025, 8520600, 572700)}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle>${lvl('<a:defRPr/>')}</a:lstStyle><a:p/></p:txBody>`) +
    ph('2', 'idx="1" type="body"', `<p:spPr>${xfrm(311700, 1152475, 8520600, 3416400)}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle>${lvl('<a:defRPr/>')}</a:lstStyle><a:p/></p:txBody>`) +
    `</p:spTree></p:cSld></p:sldLayout>`;
  const run = (text: string, rPr = '<a:rPr lang="en"/>') => `<a:r>${rPr}<a:t>${text}</a:t></a:r>`;
  const link = (text: string) => run(text, '<a:rPr lang="en" u="sng"><a:solidFill><a:schemeClr val="hlink"/></a:solidFill><a:hlinkClick r:id="rId9"/></a:rPr>');
  const fill = `<a:solidFill><a:schemeClr val="lt2"/></a:solidFill><a:ln w="9525"><a:solidFill><a:schemeClr val="dk2"/></a:solidFill><a:headEnd type="none"/><a:tailEnd type="none"/></a:ln>`;
  const shapeBody = (ps: string) => `<p:txBody><a:bodyPr anchor="ctr" bIns="91425" lIns="91425" rIns="91425" tIns="91425"><a:noAutofit/></a:bodyPr><a:lstStyle/>${ps}</p:txBody>`;
  const cxn = (id: string, x: string, ln: string) => `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="c${id}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr>${x}${geom('straightConnector1')}<a:noFill/><a:ln w="9525"><a:solidFill><a:schemeClr val="dk2"/></a:solidFill>${ln}</a:ln></p:spPr></p:cxnSp>`;
  const slide =
    `<p:sld ${NS}><p:cSld><p:spTree>` +
    ph('10', 'type="title"', `<p:spPr>${xfrm(311700, 445025, 8520600, 572700)}${geom('rect')}</p:spPr><p:txBody><a:bodyPr><a:normAutofit fontScale="90000"/></a:bodyPr><a:lstStyle/><a:p><a:pPr><a:buNone/></a:pPr>${run('Intro')}</a:p></p:txBody>`) +
    ph('11', 'idx="1" type="body"', `<p:spPr>${xfrm(311700, 1152475, 8520600, 3416400)}${geom('rect')}</p:spPr><p:txBody><a:bodyPr><a:normAutofit/></a:bodyPr><a:lstStyle/>` +
      `<a:p><a:pPr><a:spcBef><a:spcPts val="0"/></a:spcBef><a:buNone/></a:pPr>${run('Deployed on Fly.io:')}</a:p>` +
      `<a:p><a:pPr marL="457200" indent="-342900"><a:spcBef><a:spcPts val="1200"/></a:spcBef><a:buChar char="-"/></a:pPr>${run('sc-dashboard')}</a:p>` +
      `<a:p><a:pPr marL="457200" indent="-342900"><a:spcBef><a:spcPts val="0"/></a:spcBef><a:buChar char="-"/></a:pPr>${run('engine')}</a:p></p:txBody>`) +
    sp('12', `<p:spPr>${xfrm(490800, 1325150, 2110500, 1246500)}${geom('rect')}${fill}</p:spPr>${shapeBody(`<a:p><a:pPr algn="ctr"><a:buNone/></a:pPr>${link('Fly.io')}${run(' machines')}</a:p>`)}`) +
    sp('13', `<p:spPr>${xfrm(3523875, 1168075, 1757050, 1560725)}${geom('flowChartMagneticDisk')}${fill}</p:spPr>${shapeBody(`<a:p><a:pPr algn="ctr"><a:buNone/></a:pPr>${run('Redis')}</a:p>`)}`) +
    sp('14', `<p:spPr>${xfrm(6000000, 3000000, 1500000, 800000)}${geom('rect')}${fill}</p:spPr>${shapeBody(`<a:p><a:pPr algn="ctr"><a:buNone/></a:pPr>${link('Rollbar')}${run(' ')}</a:p><a:p><a:pPr algn="ctr"><a:buNone/></a:pPr>${run('ops@example.com')}</a:p>`)}`) +
    sp('15', `<p:spPr>${xfrm(6000000, 4000000, 1500000, 800000)}${geom('roundRect')}<a:solidFill><a:schemeClr val="accent1"/></a:solidFill></p:spPr><p:style><a:lnRef idx="2"><a:schemeClr val="accent1"/></a:lnRef><a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></p:style>${shapeBody(`<a:p>${run('Styled')}</a:p>`)}`) +
    cxn('16', xfrm(2601300, 1948400, 922500, 0), '<a:headEnd type="none"/><a:tailEnd type="triangle"/>') +
    cxn('17', xfrm(1546050, 2571650, 360900, 628200), '<a:headEnd type="none"/><a:tailEnd type="triangle"/>') +
    cxn('18', xfrm(1546050, 3571650, 360900, 628200, ' flipH="1"'), '<a:headEnd type="triangle"/><a:tailEnd type="none"/>') +
    // An elbow connector from the bottom of shape 12 (site 2) to the top of shape 13 (site 0), dashed, with an open arrowhead.
    `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="19" name="c19"/><p:cNvCxnSpPr><a:stCxn id="12" idx="2"/><a:endCxn id="13" idx="0"/></p:cNvCxnSpPr><p:nvPr/></p:nvCxnSpPr><p:spPr>${xfrm(1500000, 3000000, 2000000, 600000)}${geom('bentConnector3')}<a:ln w="19050"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill><a:prstDash val="sysDash"/><a:tailEnd type="arrow"/></a:ln></p:spPr></p:cxnSp>` +
    `</p:spTree></p:cSld></p:sld>`;
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file('_rels/.rels', rels([['rId1', 'officeDocument', 'ppt/presentation.xml']]));
  zip.file('ppt/presentation.xml', `<p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/></p:presentation>`);
  zip.file('ppt/_rels/presentation.xml.rels', rels([['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'], ['rId2', 'slide', 'slides/slide1.xml']]));
  zip.file('ppt/slideMasters/slideMaster1.xml', master);
  zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'theme', '../theme/theme1.xml']]));
  zip.file('ppt/slideLayouts/slideLayout1.xml', layout);
  zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]));
  zip.file('ppt/theme/theme1.xml', theme);
  zip.file('ppt/slides/slide1.xml', slide);
  zip.file('ppt/slides/_rels/slide1.xml.rels', rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId9', 'hyperlink', 'https://fly.io']]));
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
}

describe('pptx export and import', () => {
  it('round-trips arcs with their angles and no warning', async () => {
    const s = buildSlide('blank', {}, newId);
    s.elements.push({ id: newId(), type: 'shape', shape: 'arc', x: 180, y: 187, w: 223, h: 223, fill: 'none', stroke: '#ff0000', strokeWidth: 3, startAngle: 90, endAngle: 200 });
    const { buf } = await pptxBuffer({ version: 1, theme: 'light', slides: [s] });
    const { deck, warnings } = await importPptx(buf, async () => '/api/images/x');
    const arc = deck.slides[0].elements.find((e): e is ShapeElement => e.type === 'shape' && e.shape === 'arc')!;
    expect(arc).toMatchObject({ fill: 'none', stroke: '#ff0000', startAngle: 90, endAngle: 200 });
    expect(warnings.join(' ')).not.toMatch(/arc/);
  });

  it('inherits text styles from the master and layout, keeps link colors to links, and converts lines and cylinders', async () => {
    const { deck, warnings } = await importPptx(await googleStylePptx(), async () => '');
    expect(warnings).toEqual([]);
    const els = deck.slides[0].elements;
    const texts = els.filter((e): e is TextElement => e.type === 'text');
    // The title: 28pt from the master placeholder, shrunk to 90% by autofit, regular weight, the heading font.
    const title = texts.find((t) => t.role === 'title')!;
    expect(title.style).toEqual({ size: 34, font: 'Arial', bold: false });
    // The body: 18pt in the theme's dark gray from the master placeholder, 115% line spacing, the body font;
    // the widest gap between paragraphs stands for the box.
    const body = texts.find((t) => t.paragraphs[0].text === 'Deployed on Fly.io:')!;
    expect(body.style).toEqual({ size: 24, font: 'Verdana', color: '#595959', lineHeight: 1.38, paraSpacing: 16 });
    expect(body.paragraphs.map((p) => !!p.bullet)).toEqual([false, true, true]);
    // Text in a plain shape: 14pt italic (the master's "other" style) in the theme text color, not white, and
    // a hyperlink inside it does not recolor the whole box.
    const fly = texts.find((t) => t.paragraphs[0].text === 'Fly.io machines')!;
    expect(fly.style).toEqual({ size: 19, font: 'Arial', italic: true, align: 'center', valign: 'middle' });
    // A paragraph that is only a link keeps the link color.
    const rollbar = texts.find((t) => t.paragraphs[0].text === 'Rollbar ')!;
    expect(rollbar.style?.color).toBeUndefined();
    expect(rollbar.paragraphs[0].color).toBe('#0097a7');
    expect(rollbar.paragraphs[1].color).toBeUndefined();
    // A styled shape's font reference gives its text color (PowerPoint's light text on filled shapes).
    expect(texts.find((t) => t.paragraphs[0].text === 'Styled')!.style?.color).toBe('#ffffff');
    // Cylinders, and connectors with their arrowheads and diagonals.
    expect(els.find((e) => e.type === 'shape' && e.shape === 'cylinder')).toMatchObject({ fill: '#eeeeee', stroke: '#595959' });
    const lines = els.filter((e): e is LineElement => e.type === 'line');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatchObject({ kind: 'straight', h: 0, endArrow: 'triangle', strokeColor: '#595959', strokeWidth: 1 });
    expect(lines[1]).toMatchObject({ w: 38, h: 66, endArrow: 'triangle' });
    expect(lines[1].flipH).toBeUndefined();
    expect(lines[2]).toMatchObject({ w: 38, h: 66, startArrow: 'triangle', flipH: true }); // flipped: the start is on the right
    // Elbow connectors keep their route, dash, arrowhead and the shapes they are attached to.
    const rect = els.find((e) => e.type === 'shape' && e.shape === 'rect' && e.text === undefined && e.id === lines[3].startConnection?.elementId);
    const disk = els.find((e) => e.type === 'shape' && e.shape === 'cylinder')!;
    expect(lines[3]).toMatchObject({ kind: 'elbow', dash: 'dash', endArrow: 'open', strokeColor: '#ff0000', startConnection: { site: 'bottom' }, endConnection: { elementId: disk.id, site: 'top' } });
    expect(rect).toBeDefined();
  });

  it('converts colors and fonts for PowerPoint', () => {
    expect(hexColor('#1a73e8')).toBe('1A73E8');
    expect(hexColor('#abc')).toBe('AABBCC');
    expect(hexColor('red')).toBeUndefined();
    expect(fontFace("Georgia, 'Times New Roman', serif")).toBe('Georgia');
    expect(fontFace("'Google Sans', Roboto, sans-serif")).toBe('Arial');
  });

  it('round-trips text, bullets, shapes, pictures, backgrounds and notes', async () => {
    const title = buildSlide('title', { title: 'Quarterly review', subtitle: 'October 2026', notes: 'Welcome everyone' }, newId);
    const body = buildSlide('title-body', { title: 'Highlights', body: ['Revenue up 12%', '  Mostly in EMEA', 'Churn down'], background: '#123456' }, newId);
    body.elements.push(
      { id: newId(), type: 'shape', shape: 'ellipse', x: 700, y: 380, w: 120, h: 120, fill: '#00aa00', text: 'Go' },
      { id: newId(), type: 'shape', shape: 'line', x: 60, y: 500, w: 400, h: 0, stroke: '#ff0000', strokeWidth: 4 },
      { id: newId(), type: 'shape', shape: 'star', x: 500, y: 400, w: 100, h: 100, fill: '#ffcc00' },
      { id: newId(), type: 'shape', shape: 'rounded', x: 60, y: 420, w: 200, h: 40, fill: 'rgba(255, 255, 255, 0.12)', stroke: 'rgba(255, 255, 255, 0.3)', strokeWidth: 1 },
      { id: newId(), type: 'shape', shape: 'line', x: 480, y: 160, w: 0, h: 200, stroke: '#00ff00', strokeWidth: 2 },
      {
        id: newId(),
        type: 'text',
        x: 620,
        y: 400,
        w: 200,
        h: 100,
        paragraphs: [
          { text: '2-3x', size: 47, bold: false },
          { text: 'Average program cost reduction', bold: true },
        ],
        style: { size: 17, align: 'center', color: '#ffffff', font: 'Poppins', lineHeight: 1.5 },
      },
      { id: newId(), type: 'shape', shape: 'arrow', x: 300, y: 420, w: 160, h: 60, fill: 'none', stroke: '#0000ff', strokeWidth: 2 },
      { id: newId(), type: 'shape', shape: 'cylinder', x: 840, y: 100, w: 80, h: 100, fill: '#dddddd', stroke: '#333333', strokeWidth: 1 },
      { id: newId(), type: 'shape', shape: 'line', x: 700, y: 60, w: 120, h: 80, flip: true, arrow: 'both', stroke: '#123456', strokeWidth: 2 },
      { id: newId(), type: 'image', x: 600, y: 160, w: 200, h: 150, src: PNG },
      { id: newId(), type: 'line', kind: 'elbow', x: 100, y: 200, w: 150, h: 90, flipV: true, dash: 'dot', startArrow: 'diamond', endArrow: 'circle', strokeColor: '#abcdef', strokeWidth: 3 },
      { id: newId(), type: 'line', kind: 'curved', x: 100, y: 320, w: 150, h: 40, endArrow: 'open' },
    );
    const deck: Deck = { version: 1, theme: 'light', slides: [title, body] };

    const { buf, warnings: exportWarnings } = await pptxBuffer(deck);
    expect(exportWarnings).toEqual([]);
    expect(await isPptx(buf)).toBe(true);
    expect(await isPptx(Buffer.from('not a zip'))).toBe(false);

    const stored: { type: string; size: number }[] = [];
    const { deck: imported, warnings } = await importPptx(buf, async (type, data) => {
      stored.push({ type, size: data.length });
      return `/api/images/00000000-0000-0000-0000-00000000000${stored.length}`;
    });
    expect(warnings).toEqual([]);
    expect(imported.slides).toHaveLength(2);

    const s1 = imported.slides[0];
    expect(slideTitle(s1)).toBe('Quarterly review');
    expect(s1.notes).toBe('Welcome everyone');
    expect(s1.layout).toBe('title');
    const t1 = s1.elements.find((e): e is TextElement => e.type === 'text' && e.role === 'title')!;
    // Positions survive within a point or two (EMU rounding).
    expect(Math.abs(t1.x - 60)).toBeLessThanOrEqual(2);
    expect(Math.abs(t1.w - 840)).toBeLessThanOrEqual(2);
    expect(t1.style).toMatchObject({ align: 'center', valign: 'bottom', size: 40 });
    const sub = s1.elements.find((e): e is TextElement => e.type === 'text' && e.role === 'subtitle')!;
    expect(sub.paragraphs[0].text).toBe('October 2026');

    const s2 = imported.slides[1];
    expect(s2.bg).toBe('#123456');
    const bodyEl = s2.elements.find((e): e is TextElement => e.type === 'text' && e.role === 'body')!;
    expect(bodyEl.paragraphs).toEqual([
      { text: 'Revenue up 12%', bullet: true },
      { text: 'Mostly in EMEA', bullet: true, level: 1 },
      { text: 'Churn down', bullet: true },
    ]);
    const ellipse = s2.elements.find((e): e is ShapeElement => e.type === 'shape' && e.shape === 'ellipse')!;
    // A filled shape with text comes back as the shape plus a centered text element on top, so styling survives.
    expect(ellipse).toMatchObject({ fill: '#00aa00' });
    expect(ellipse.text).toBeUndefined();
    const go = s2.elements[s2.elements.indexOf(ellipse) + 1] as TextElement;
    expect(go).toMatchObject({ type: 'text', paragraphs: [{ text: 'Go' }], style: { align: 'center', valign: 'middle', color: '#ffffff' } });
    expect(Math.abs(ellipse.x - 700)).toBeLessThanOrEqual(2);
    const line = s2.elements.find((e): e is LineElement => e.type === 'line')!;
    expect(line).toMatchObject({ strokeColor: '#ff0000', h: 0 });
    expect(line.strokeWidth).toBeGreaterThanOrEqual(3);
    // Translucent fills, vertical lines and per-paragraph sizes survive too.
    const pill = s2.elements.find((e): e is ShapeElement => e.type === 'shape' && e.shape === 'rounded')!;
    expect(pill.fill).toBe('rgba(255, 255, 255, 0.12)');
    expect(pill.stroke).toBe('rgba(255, 255, 255, 0.3)');
    const vline = s2.elements.find((e): e is LineElement => e.type === 'line' && e.w === 0)!;
    expect(Math.abs(vline.h - 200)).toBeLessThanOrEqual(2);
    expect(vline.strokeColor).toBe('#00ff00');
    const figure = s2.elements.find((e): e is TextElement => e.type === 'text' && e.paragraphs[0]?.text === '2-3x')!;
    expect(figure.style).toMatchObject({ size: 47, align: 'center', color: '#ffffff', font: 'Poppins', lineHeight: 1.5 });
    expect(figure.paragraphs[0].size).toBeUndefined(); // the first paragraph is the box's own style
    expect(figure.paragraphs[1]).toMatchObject({ text: 'Average program cost reduction', size: 17, bold: true });

    // Preset geometries map both ways through the shape table.
    expect(s2.elements.find((e): e is ShapeElement => e.type === 'shape' && e.shape === 'star')).toMatchObject({ fill: '#ffcc00', w: 100, h: 100 });
    expect(s2.elements.find((e): e is ShapeElement => e.type === 'shape' && e.shape === 'arrow')).toMatchObject({ fill: 'none', stroke: '#0000ff' });
    // Cylinders, diagonal lines and arrowheads round-trip too.
    expect(s2.elements.find((e): e is ShapeElement => e.type === 'shape' && e.shape === 'cylinder')).toMatchObject({ fill: '#dddddd', stroke: '#333333' });
    const diagonal = s2.elements.find((e): e is LineElement => e.type === 'line' && e.w > 0 && e.h > 0)!;
    expect(diagonal).toMatchObject({ flipV: true, startArrow: 'triangle', endArrow: 'triangle', strokeColor: '#123456' });
    expect(Math.abs(diagonal.w - 120)).toBeLessThanOrEqual(2);
    expect(Math.abs(diagonal.h - 80)).toBeLessThanOrEqual(2);
    // Elbow and curved connectors keep their kind, flips, dash and arrowheads.
    const elbow = s2.elements.find((e): e is LineElement => e.type === 'line' && e.kind === 'elbow')!;
    expect(elbow).toMatchObject({ flipV: true, dash: 'dot', startArrow: 'diamond', endArrow: 'circle', strokeColor: '#abcdef' });
    expect(s2.elements.find((e): e is LineElement => e.type === 'line' && e.kind === 'curved')).toMatchObject({ endArrow: 'open' });
    const img = s2.elements.find((e): e is ImageElement => e.type === 'image')!;
    expect(img.src).toBe('/api/images/00000000-0000-0000-0000-000000000001');
    expect(stored).toEqual([{ type: 'image/png', size: expect.any(Number) }]);
  });

  it('reports what it drops and rejects files that are not presentations', async () => {
    await expect(importPptx(Buffer.from('nope'), async () => '')).rejects.toThrow(/not a valid PowerPoint/);
    const deck: Deck = { version: 1, theme: 'dark', slides: [buildSlide('image', { title: 'Pic', image: 'https://example.com/missing.png' }, newId)] };
    const { buf, warnings } = await pptxBuffer(deck); // the image cannot be loaded in this test
    expect(warnings[0]).toMatch(/1 image could not be loaded/);
    const { deck: imported } = await importPptx(buf, async () => '');
    expect(imported.slides[0].bg).toBe('#1b1b1f'); // the dark theme's background travels as a slide color
    expect(imported.slides[0].elements.some((e) => e.type === 'text' && e.paragraphs[0].text === 'Image unavailable')).toBe(true);
  });
});
