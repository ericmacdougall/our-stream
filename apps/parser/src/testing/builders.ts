// SPDX-License-Identifier: AGPL-3.0-only
// Test-only builders for hand-made documents: a zip writer (with knobs to forge headers), minimal OOXML
// packages and a minimal PDF writer. Not imported by the service.
import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  data: Buffer | string;
  method?: 'store' | 'deflate';
  /** Forge the central-directory uncompressed size (bomb with a lying header). */
  declaredSize?: number;
  /** Set general-purpose bit 0 (encrypted). */
  encrypted?: boolean;
}

export function zip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const method = e.method ?? 'deflate';
    const body = method === 'deflate' ? deflateRawSync(raw, { level: 9 }) : raw;
    const name = Buffer.from(e.name, 'utf8');
    const flags = (e.encrypted ? 1 : 0) | 0x800;
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method === 'deflate' ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.declaredSize ?? raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method === 'deflate' ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(e.declaredSize ?? raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

export interface DocxPara {
  text: string;
  style?: string;
  /** Tracked-change deletion: the text sits in w:del / w:delText. */
  deleted?: boolean;
  /** Comment text attached to this paragraph (goes to word/comments.xml). */
  comment?: string;
}

export function docx(
  paras: DocxPara[],
  opts: {
    extra?: ZipEntry[];
    macro?: boolean;
    macroContentType?: boolean;
    documentXmlPrefix?: string;
  } = {},
): Buffer {
  const comments: string[] = [];
  const body = paras
    .map((p) => {
      const style = p.style ? `<w:pPr><w:pStyle w:val="${p.style}"/></w:pPr>` : '';
      const run = p.deleted
        ? `<w:del w:id="1" w:author="a" w:date="2026-01-01T00:00:00Z"><w:r><w:delText xml:space="preserve">${esc(p.text)}</w:delText></w:r></w:del>`
        : `<w:r><w:t xml:space="preserve">${esc(p.text)}</w:t></w:r>`;
      let comment = '';
      if (p.comment) {
        const id = comments.length;
        comments.push(
          `<w:comment w:id="${id}" w:author="a"><w:p><w:r><w:t>${esc(p.comment)}</w:t></w:r></w:p></w:comment>`,
        );
        comment = `<w:commentRangeStart w:id="${id}"/>${run}<w:commentRangeEnd w:id="${id}"/><w:r><w:commentReference w:id="${id}"/></w:r>`;
      }
      return `<w:p>${style}${comment || run}</w:p>`;
    })
    .join('');
  const ct =
    XML +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${
      opts.macroContentType
        ? 'application/vnd.ms-word.document.macroEnabled.main+xml'
        : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
    }"/>${
      opts.macro
        ? '<Override PartName="/word/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/>'
        : ''
    }</Types>`;
  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: ct },
    {
      name: '_rels/.rels',
      data:
        XML +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    },
    {
      name: 'word/document.xml',
      data:
        (opts.documentXmlPrefix ?? XML) +
        `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    },
    {
      name: 'word/styles.xml',
      data:
        XML +
        '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style></w:styles>',
    },
  ];
  if (comments.length)
    entries.push({
      name: 'word/comments.xml',
      data:
        XML +
        `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${comments.join('')}</w:comments>`,
    });
  if (opts.macro) entries.push({ name: 'word/vbaProject.bin', data: Buffer.from('fake-vba') });
  return zip([...entries, ...(opts.extra ?? [])]);
}

export interface Slide {
  paras: string[];
  hidden?: boolean;
  notes?: string;
}

export function pptx(slides: Slide[], opts: { extra?: ZipEntry[] } = {}): Buffer {
  const entries: ZipEntry[] = [];
  const ids = slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('');
  const rels = slides
    .map(
      (_, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`,
    )
    .join('');
  const overrides = [
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>',
    ...slides.map(
      (_, i) =>
        `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
    ),
  ].join('');
  entries.push(
    {
      name: '[Content_Types].xml',
      data:
        XML +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides}</Types>`,
    },
    {
      name: '_rels/.rels',
      data:
        XML +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>',
    },
    {
      name: 'ppt/presentation.xml',
      data:
        XML +
        `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>${ids}</p:sldIdLst></p:presentation>`,
    },
    {
      name: 'ppt/_rels/presentation.xml.rels',
      data:
        XML +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
    },
  );
  slides.forEach((s, i) => {
    const sp = s.paras
      .map(
        (t, j) =>
          `<p:sp><p:nvSpPr><p:cNvPr id="${j + 2}" name="t${j}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>${esc(t)}</a:t></a:r></a:p></p:txBody></p:sp>`,
      )
      .join('');
    entries.push({
      name: `ppt/slides/slide${i + 1}.xml`,
      data:
        XML +
        `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"${s.hidden ? ' show="0"' : ''}><p:cSld><p:spTree>${sp}</p:spTree></p:cSld></p:sld>`,
    });
    if (s.notes) {
      entries.push(
        {
          name: `ppt/slides/_rels/slide${i + 1}.xml.rels`,
          data:
            XML +
            `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${i + 1}.xml"/></Relationships>`,
        },
        {
          name: `ppt/notesSlides/notesSlide${i + 1}.xml`,
          data:
            XML +
            `<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${esc(s.notes)}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`,
        },
      );
    }
  });
  return zip([...entries, ...(opts.extra ?? [])]);
}

export interface Sheet {
  name: string;
  rows: (string | number | { f: string; v: string | number })[][];
  state?: 'visible' | 'hidden' | 'veryHidden';
}

const colName = (i: number) =>
  String.fromCharCode(65 + (i % 26)) + (i >= 26 ? String(Math.floor(i / 26)) : '');

export function xlsxSheetXml(rows: Sheet['rows'], strings?: string[]): string {
  const rowXml = rows
    .map((r, ri) => {
      const cells = r
        .map((c, ci) => {
          const ref = `${colName(ci)}${ri + 1}`;
          if (typeof c === 'number') return `<c r="${ref}"><v>${c}</v></c>`;
          if (typeof c === 'string') {
            if (!strings) return `<c r="${ref}" t="inlineStr"><is><t>${esc(c)}</t></is></c>`;
            let idx = strings.indexOf(c);
            if (idx < 0) idx = strings.push(c) - 1;
            return `<c r="${ref}" t="s"><v>${idx}</v></c>`;
          }
          return typeof c.v === 'number'
            ? `<c r="${ref}"><f>${esc(c.f)}</f><v>${c.v}</v></c>`
            : `<c r="${ref}" t="str"><f>${esc(c.f)}</f><v>${esc(c.v)}</v></c>`;
        })
        .join('');
      return `<row r="${ri + 1}">${cells}</row>`;
    })
    .join('');
  return (
    XML +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowXml}</sheetData></worksheet>`
  );
}

export function xlsx(
  sheets: Sheet[],
  opts: {
    extra?: ZipEntry[];
    sheetXml?: (i: number) => Buffer | string | undefined;
    macro?: boolean;
  } = {},
): Buffer {
  const entries: ZipEntry[] = [
    {
      name: '[Content_Types].xml',
      data:
        XML +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets
          .map(
            (_, i) =>
              `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
          )
          .join('')}</Types>`,
    },
    {
      name: '_rels/.rels',
      data:
        XML +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    },
    {
      name: 'xl/workbook.xml',
      data:
        XML +
        `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
          .map(
            (s, i) =>
              `<sheet name="${esc(s.name)}" sheetId="${i + 1}"${s.state && s.state !== 'visible' ? ` state="${s.state}"` : ''} r:id="rId${i + 1}"/>`,
          )
          .join('')}</sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data:
        XML +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
          .map(
            (_, i) =>
              `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
          )
          .join('')}</Relationships>`,
    },
  ];
  // Like Excel: shared strings come before the worksheets in the package (the streaming reader relies on it).
  const strings: string[] = [];
  const sheetEntries = sheets.map((s, i) => ({
    name: `xl/worksheets/sheet${i + 1}.xml`,
    data: opts.sheetXml?.(i) ?? xlsxSheetXml(s.rows, strings),
  }));
  entries.push(
    {
      name: 'xl/sharedStrings.xml',
      data:
        XML +
        `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((t) => `<si><t xml:space="preserve">${esc(t)}</t></si>`).join('')}</sst>`,
    },
    ...sheetEntries,
  );
  if (opts.macro) entries.push({ name: 'xl/vbaProject.bin', data: Buffer.from('fake-vba') });
  return zip([...entries, ...(opts.extra ?? [])]);
}

/** Minimal text PDF; each inner array is a page of lines. `script` adds an OpenAction JavaScript. */
export function pdf(pages: string[][], opts: { script?: boolean; encrypt?: boolean } = {}): Buffer {
  const objs: string[] = [];
  const add = (body: string) => {
    objs.push(body);
    return objs.length;
  };
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds: number[] = [];
  const pagesId = objs.length + 1 + pages.length * 2; // reserved: pages object comes after page+content pairs
  for (const lines of pages) {
    const stream = `BT /F1 12 Tf 14 TL 50 740 Td ${lines
      .map((l) => `(${l.replace(/[\\()]/g, '\\$&')}) Tj T*`)
      .join(' ')} ET`;
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`,
      ),
    );
  }
  const pagesObj = add(
    `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`,
  );
  let action = '';
  if (opts.script) {
    const js = add('<< /S /JavaScript /JS (app.alert\\(1\\)) >>');
    action = ` /OpenAction ${js} 0 R`;
  }
  const catalog = add(`<< /Type /Catalog /Pages ${pagesObj} 0 R${action} >>`);
  let encrypt = '';
  if (opts.encrypt) {
    // A syntactically valid but unusable standard handler dictionary: readers must ask for a password.
    const e = add(
      '<< /Filter /Standard /V 1 /R 2 /O (' +
        '0'.repeat(32) +
        ') /U (' +
        '0'.repeat(32) +
        ') /P -4 >>',
    );
    encrypt = ` /Encrypt ${e} 0 R /ID [<00112233445566778899aabbccddeeff> <00112233445566778899aabbccddeeff>]`;
  }
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((b, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${b}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R${encrypt} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
