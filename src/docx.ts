/**
 * Zero-dependency DOCX generator for viberadar docs export.
 * DOCX format = ZIP of XML files (OOXML spec).
 * Uses Node.js built-in `zlib` for DEFLATE compression.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

// ── CRC-32 ────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ── Minimal ZIP writer ────────────────────────────────────────────────────────

interface ZipEntry { name: string; data: Buffer; crc: number; compressed: Buffer; offset: number; }

class ZipBuilder {
  private entries: ZipEntry[] = [];
  private offset = 0;

  add(name: string, data: Buffer): void {
    const compressed = zlib.deflateRawSync(data, { level: 6 });
    const crc = crc32(data);
    this.entries.push({ name, data, crc, compressed, offset: this.offset });
    // local file header (30) + name + compressed data
    this.offset += 30 + Buffer.byteLength(name) + compressed.length;
  }

  toBuffer(): Buffer {
    const parts: Buffer[] = [];

    for (const e of this.entries) {
      const nameBuf = Buffer.from(e.name, 'utf-8');
      const hdr = Buffer.alloc(30);
      hdr.writeUInt32LE(0x04034B50, 0);   // signature
      hdr.writeUInt16LE(20, 4);            // version needed
      hdr.writeUInt16LE(0, 6);             // flags
      hdr.writeUInt16LE(8, 8);             // deflate
      hdr.writeUInt16LE(0, 10);            // mod time
      hdr.writeUInt16LE(0, 12);            // mod date
      hdr.writeUInt32LE(e.crc, 14);
      hdr.writeUInt32LE(e.compressed.length, 18);
      hdr.writeUInt32LE(e.data.length, 22);
      hdr.writeUInt16LE(nameBuf.length, 26);
      hdr.writeUInt16LE(0, 28);
      parts.push(hdr, nameBuf, e.compressed);
    }

    const centralStart = this.offset;
    for (const e of this.entries) {
      const nameBuf = Buffer.from(e.name, 'utf-8');
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014B50, 0);    // central dir sig
      cd.writeUInt16LE(20, 4);             // version made by
      cd.writeUInt16LE(20, 6);             // version needed
      cd.writeUInt16LE(0, 8);
      cd.writeUInt16LE(8, 10);             // deflate
      cd.writeUInt16LE(0, 12);
      cd.writeUInt16LE(0, 14);
      cd.writeUInt32LE(e.crc, 16);
      cd.writeUInt32LE(e.compressed.length, 20);
      cd.writeUInt32LE(e.data.length, 24);
      cd.writeUInt16LE(nameBuf.length, 28);
      cd.writeUInt16LE(0, 30);
      cd.writeUInt16LE(0, 32);
      cd.writeUInt16LE(0, 34);
      cd.writeUInt16LE(0, 36);
      cd.writeUInt32LE(0, 38);
      cd.writeUInt32LE(e.offset, 42);
      parts.push(cd, nameBuf);
    }

    const centralSize = parts.reduce((s, b, i) => i >= this.entries.length * 3 ? s + b.length : s, 0);
    // recalculate central dir size properly
    let cdSize = 0;
    for (const e of this.entries) cdSize += 46 + Buffer.byteLength(e.name);

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054B50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(centralStart, 16);
    eocd.writeUInt16LE(0, 20);
    parts.push(eocd);

    return Buffer.concat(parts);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function xe(s: string): string {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Read PNG width/height from binary header (bytes 16-23 in IHDR chunk) */
function pngSize(buf: Buffer): { w: number; h: number } | null {
  if (buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== 0x89504E47) return null; // PNG magic
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

// ── Markdown → OOXML ─────────────────────────────────────────────────────────

interface ImgRef { rId: string; file: string; w: number; h: number; altText: string; }

function inlineRuns(text: string): string {
  // Process inline markup: **bold**, *italic*, `code`, links
  const parts: string[] = [];
  // Simple state machine
  let i = 0;
  let cur = '';
  const flush = (extra = '') => { if (cur || extra) parts.push(`<w:r><w:t xml:space="preserve">${xe(cur)}${extra}</w:t></w:r>`); cur = ''; };

  const raw = text;
  const tokens: Array<{ type: string; text: string; href?: string }> = [];

  // Tokenize
  const re = /\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    if (m.index > last) tokens.push({ type: 'text', text: raw.slice(last, m.index) });
    if (m[1] !== undefined) tokens.push({ type: 'bold', text: m[1] });
    else if (m[2] !== undefined) tokens.push({ type: 'italic', text: m[2] });
    else if (m[3] !== undefined) tokens.push({ type: 'code', text: m[3] });
    else if (m[4] !== undefined) tokens.push({ type: 'link', text: m[4], href: m[5] });
    last = m.index + m[0].length;
  }
  if (last < raw.length) tokens.push({ type: 'text', text: raw.slice(last) });

  return tokens.map(t => {
    if (t.type === 'text') return `<w:r><w:t xml:space="preserve">${xe(t.text)}</w:t></w:r>`;
    if (t.type === 'bold') return `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${xe(t.text)}</w:t></w:r>`;
    if (t.type === 'italic') return `<w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">${xe(t.text)}</w:t></w:r>`;
    if (t.type === 'code') return `<w:r><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/><w:sz w:val="18"/><w:shd w:val="clear" w:color="auto" w:fill="F0F0F0"/></w:rPr><w:t xml:space="preserve">${xe(t.text)}</w:t></w:r>`;
    if (t.type === 'link') return `<w:hyperlink w:tooltip="${xe(t.href || '')}"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t>${xe(t.text)}</w:t></w:r></w:hyperlink>`;
    return '';
  }).join('');
}

function para(style: string, content: string, extraPPr = ''): string {
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/>${extraPPr}</w:pPr>${content}</w:p>`;
}

function mdToOoxml(md: string, featureKey: string, imgRefs: ImgRef[], screenshotsDir: string): string {
  const lines = md.split('\n');
  const parts: string[] = [];
  let inCode = false, codeBuf = '';
  let listType: 'ul' | 'ol' | null = null;
  let numId = 1;

  const closeList = () => { listType = null; };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code block
    if (line.trimStart().startsWith('```')) {
      if (inCode) {
        // Emit code block
        const codeLines = codeBuf.trimEnd().split('\n');
        for (const cl of codeLines) {
          parts.push(`<w:p><w:pPr><w:pStyle w:val="Code"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">${xe(cl)}</w:t></w:r></w:p>`);
        }
        codeBuf = ''; inCode = false;
      } else { closeList(); inCode = true; }
      continue;
    }
    if (inCode) { codeBuf += line + '\n'; continue; }

    // Headings
    const hm = line.match(/^(#{1,6})\s+(.+)$/);
    if (hm) {
      closeList();
      const lvl = hm[1].length;
      const styleMap: Record<number, string> = { 1: 'Heading1', 2: 'Heading2', 3: 'Heading3', 4: 'Heading4', 5: 'Heading5', 6: 'Heading6' };
      parts.push(para(styleMap[lvl] || 'Heading3', inlineRuns(hm[2])));
      continue;
    }

    // Horizontal rule → page separator
    if (/^-{3,}$/.test(line.trim())) {
      closeList();
      parts.push(`<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="CCCCCC"/></w:pBdr></w:pPr></w:p>`);
      continue;
    }

    // Unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      if (listType !== 'ul') { closeList(); listType = 'ul'; }
      const txt = line.replace(/^\s*[-*]\s+/, '');
      parts.push(`<w:p><w:pPr><w:pStyle w:val="ListBullet"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>${inlineRuns(txt)}</w:p>`);
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      if (listType !== 'ol') { closeList(); listType = 'ol'; }
      const txt = line.replace(/^\s*\d+\.\s+/, '');
      parts.push(`<w:p><w:pPr><w:pStyle w:val="ListNumber"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr>${inlineRuns(txt)}</w:p>`);
      continue;
    }

    // Image
    const im = line.trim().match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (im) {
      closeList();
      const alt = im[1];
      let src = im[2];
      // Resolve screenshot path
      if (src.startsWith('screenshots/')) {
        const fname = src.replace('screenshots/', '');
        const fpath = path.join(screenshotsDir, fname);
        try {
          const imgBuf = fs.readFileSync(fpath);
          const size = pngSize(imgBuf) || { w: 800, h: 600 };
          // Max width 15cm = 5400000 EMU (at 96dpi)
          const maxW = 5400000;
          const scale = Math.min(1, maxW / (size.w * 9525));
          const emuW = Math.round(size.w * 9525 * scale);
          const emuH = Math.round(size.h * 9525 * scale);
          const rId = `rImg${imgRefs.length + 1}`;
          const mediaName = `media/img${imgRefs.length + 1}${path.extname(fname) || '.png'}`;
          imgRefs.push({ rId, file: fpath, w: emuW, h: emuH, altText: alt });
          parts.push(`<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr/><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="${emuW}" cy="${emuH}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${imgRefs.length}" name="Image${imgRefs.length}" descr="${xe(alt)}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${imgRefs.length}" name="Image${imgRefs.length}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rId}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${emuW}" cy="${emuH}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`);
          // Caption
          if (alt) parts.push(para('Caption', `<w:r><w:t>${xe(alt)}</w:t></w:r>`));
        } catch { /* skip missing image */ }
      }
      continue;
    }

    // Empty line
    if (!line.trim()) { closeList(); parts.push(`<w:p/>`); continue; }

    // Normal paragraph
    closeList();
    parts.push(para('Normal', inlineRuns(line)));
  }

  if (inCode && codeBuf) {
    for (const cl of codeBuf.split('\n')) {
      parts.push(`<w:p><w:pPr><w:pStyle w:val="Code"/></w:pPr><w:r><w:t xml:space="preserve">${xe(cl)}</w:t></w:r></w:p>`);
    }
  }

  return parts.join('\n');
}

// ── DOCX assembly ─────────────────────────────────────────────────────────────

export interface DocFeature { key: string; label: string; latestVersion: number | null; docVersions: string[]; }

export function buildDocx(features: DocFeature[], projectRoot: string): Buffer {
  const zip = new ZipBuilder();

  // Collect all image refs across all features
  const allImgRefs: ImgRef[] = [];
  const featureBlocks: string[] = [];

  for (const f of features) {
    const docDir = path.join(projectRoot, 'docs', 'features', f.key);
    const ssDir = path.join(docDir, 'screenshots');

    // Read latest markdown
    let mdContent = '';
    try {
      const entries = fs.readdirSync(docDir);
      const versions = entries
        .map((e: string) => { const m = e.match(/^v(\d+)\.md$/); return m ? { file: e, n: parseInt(m[1], 10) } : null; })
        .filter((x: any): x is { file: string; n: number } => x !== null)
        .sort((a: any, b: any) => b.n - a.n);
      if (versions.length) mdContent = fs.readFileSync(path.join(docDir, versions[0].file), 'utf-8');
    } catch { continue; }
    if (!mdContent) continue;

    // Feature heading
    featureBlocks.push(para('Heading1', `<w:r><w:t>${xe(f.label)}</w:t></w:r>`));
    featureBlocks.push(mdToOoxml(mdContent, f.key, allImgRefs, ssDir));
    // Page break between features
    featureBlocks.push(`<w:p><w:r><w:br w:type="page"/></w:r></w:p>`);
  }

  // Build relationships for images
  const imgRelsXml = allImgRefs.map((r, i) =>
    `<Relationship Id="${r.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/img${i + 1}${path.extname(r.file) || '.png'}"/>`
  ).join('\n');

  const documentRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
  ${imgRelsXml}
</Relationships>`;

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"
  xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex"
  xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
  xmlns:aink="http://schemas.microsoft.com/office/drawing/2016/ink"
  xmlns:am3d="http://schemas.microsoft.com/office/drawing/2017/model3d"
  xmlns:o="urn:schemas-microsoft-com:office:office"
  xmlns:oel="http://schemas.microsoft.com/office/2019/extlst"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"
  xmlns:v="urn:schemas-microsoft-com:vml"
  xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing"
  xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
  xmlns:w10="urn:schemas-microsoft-com:office:word"
  xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"
  xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"
  xmlns:w16cex="http://schemas.microsoft.com/office/word/2018/wordml/cex"
  xmlns:w16cid="http://schemas.microsoft.com/office/word/2016/wordml/cid"
  xmlns:w16="http://schemas.microsoft.com/office/word/2018/wordml"
  xmlns:w16sdtdh="http://schemas.microsoft.com/office/word/2020/wordml/sdtdatahash"
  xmlns:w16se="http://schemas.microsoft.com/office/word/2015/wordml/symex"
  xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"
  xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk"
  xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml"
  xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"
  mc:Ignorable="w14 w15 w16se w16cid w16 w16cex w16sdtdh wp14">
  <w:body>
${featureBlocks.join('\n')}
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="jpg" ContentType="image/jpeg"/>
  <Default Extension="jpeg" ContentType="image/jpeg"/>
  <Default Extension="webp" ContentType="image/webp"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:docDefaults>
    <w:rPrDefault><w:rPr>
      <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>
      <w:sz w:val="22"/><w:szCs w:val="22"/>
    </w:rPr></w:rPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:pPr><w:spacing w:before="480" w:after="160"/><w:outlineLvl w:val="0"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="40"/><w:color w:val="1F2328"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/>
    <w:pPr><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="1"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="32"/><w:color w:val="1F2328"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading3">
    <w:name w:val="heading 3"/>
    <w:pPr><w:spacing w:before="280" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="26"/><w:color w:val="1F2328"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading4">
    <w:name w:val="heading 4"/>
    <w:pPr><w:outlineLvl w:val="3"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="24"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading5">
    <w:name w:val="heading 5"/>
    <w:pPr><w:outlineLvl w:val="4"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="22"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading6">
    <w:name w:val="heading 6"/>
    <w:pPr><w:outlineLvl w:val="5"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="20"/><w:color w:val="656D76"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Code">
    <w:name w:val="Code"/>
    <w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F6F8FA"/><w:spacing w:before="0" w:after="0"/></w:pPr>
    <w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/><w:sz w:val="18"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Caption">
    <w:name w:val="caption"/>
    <w:pPr><w:jc w:val="center"/><w:spacing w:before="80" w:after="160"/></w:pPr>
    <w:rPr><w:i/><w:sz w:val="18"/><w:color w:val="656D76"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="ListBullet">
    <w:name w:val="List Bullet"/>
    <w:basedOn w:val="Normal"/>
  </w:style>
  <w:style w:type="paragraph" w:styleId="ListNumber">
    <w:name w:val="List Number"/>
    <w:basedOn w:val="Normal"/>
  </w:style>
  <w:style w:type="character" w:styleId="Hyperlink">
    <w:name w:val="Hyperlink"/>
    <w:rPr><w:color w:val="0969DA"/><w:u w:val="single"/></w:rPr>
  </w:style>
</w:styles>`;

  const numberingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="0">
    <w:multiLevelType w:val="hybridMultilevel"/>
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>
  </w:abstractNum>
  <w:abstractNum w:abstractNumId="1">
    <w:multiLevelType w:val="hybridMultilevel"/>
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;

  // Pack into ZIP
  zip.add('[Content_Types].xml', Buffer.from(contentTypes, 'utf-8'));
  zip.add('_rels/.rels', Buffer.from(rootRels, 'utf-8'));
  zip.add('word/document.xml', Buffer.from(documentXml, 'utf-8'));
  zip.add('word/_rels/document.xml.rels', Buffer.from(documentRels, 'utf-8'));
  zip.add('word/styles.xml', Buffer.from(stylesXml, 'utf-8'));
  zip.add('word/numbering.xml', Buffer.from(numberingXml, 'utf-8'));

  // Add images
  for (let i = 0; i < allImgRefs.length; i++) {
    const ref = allImgRefs[i];
    const ext = path.extname(ref.file) || '.png';
    try {
      const imgBuf = fs.readFileSync(ref.file);
      zip.add(`word/media/img${i + 1}${ext}`, imgBuf);
    } catch { /* skip */ }
  }

  return zip.toBuffer();
}
