// SPDX-License-Identifier: AGPL-3.0-only
// Real parsers on hand-built documents: golden chunks per kind (AC-2), the hidden-text rule, and one fixture
// per NEG-1 case (scaled limits where the real budget would be slow in a unit run; the runtime suite
// `runtime.integration.ts` runs the full-size fixtures in the compose sandbox).
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_LIMITS,
  EXTENSION_KIND,
  chunkBlocks,
  type DocKind,
  type ParseLimits,
  type RefusalCode,
} from '@our-stream/documents';
import { extractFile } from './extract.js';
import { bigSheetXml, writeZeroBomb, xxeDocx } from './testing/fixtures.js';
import { docx, pdf, pptx, xlsx, zip } from './testing/builders.js';

let dir = '';
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'parser-unit-'));
});
afterAll(() => undefined);

let n = 0;
async function run(
  kind: DocKind,
  data: Buffer | string,
  over: Partial<ParseLimits> = {},
  jobOver: { mime?: string | null; ext?: string | null } = {},
) {
  const path = join(dir, `f${(n += 1)}`);
  await writeFile(path, data);
  const ext =
    jobOver.ext === undefined
      ? (Object.entries(EXTENSION_KIND).find(([, k]) => k === kind)?.[0] ?? null)
      : jobOver.ext;
  return extractFile(
    path,
    {
      v: 1,
      jobId: 'a'.repeat(32),
      kind,
      declaredMime: jobOver.mime ?? null,
      declaredExt: ext,
    },
    { ...DEFAULT_LIMITS, ...over },
  );
}
const chunks = async (...a: Parameters<typeof run>) => {
  const r = await run(...a);
  if (!r.ok) throw new Error(`refused: ${r.code}`);
  return chunkBlocks(r.blocks);
};
const refused = async (code: RefusalCode, ...a: Parameters<typeof run>) => {
  const r = await run(...a);
  expect(r).toEqual({ ok: false, code });
};

describe('golden chunks (exact), real parsers', () => {
  it('pdf: one chunk per page with a page locator; embedded JavaScript is ignored', async () => {
    const out = await chunks(
      'pdf',
      pdf([['Quarterly report', 'Revenue grew 10 percent.'], ['Second page text']], {
        script: true,
      }),
    );
    expect(out).toEqual([
      { locator: { page: 1 }, text: 'Quarterly report\nRevenue grew 10 percent.', lang: 'en' },
      { locator: { page: 2 }, text: 'Second page text', lang: 'en' },
    ]);
  });

  it('docx: heading path locators; tracked-change deletions and comments excluded', async () => {
    const out = await chunks(
      'docx',
      docx([
        { text: 'Overview', style: 'Heading1' },
        { text: 'Visible para' },
        { text: 'DELETED-TEXT-MARKER', deleted: true },
        { text: 'Commented para', comment: 'COMMENT-MARKER' },
        { text: 'Details', style: 'Heading2' },
        { text: 'Detail text' },
      ]),
    );
    expect(out).toEqual([
      {
        locator: { heading: 'Overview' },
        text: 'Overview\n\nVisible para\n\nCommented para',
        lang: 'en',
      },
      { locator: { heading: 'Overview > Details' }, text: 'Details\n\nDetail text', lang: 'en' },
    ]);
    const all = JSON.stringify(out);
    expect(all).not.toContain('DELETED-TEXT-MARKER');
    expect(all).not.toContain('COMMENT-MARKER');
  });

  it('pptx: slide locators; hidden slides and speaker notes excluded', async () => {
    const out = await chunks(
      'pptx',
      pptx([
        { paras: ['Slide one title', 'body one'], notes: 'NOTES-MARKER' },
        { paras: ['HIDDEN-SLIDE-MARKER'], hidden: true, notes: 'HIDDEN-NOTES-MARKER' },
        { paras: ['Slide three'] },
      ]),
    );
    expect(out).toEqual([
      { locator: { slide: 1 }, text: 'Slide one title\n\nbody one', lang: 'en' },
      { locator: { slide: 3 }, text: 'Slide three', lang: 'en' },
    ]);
    const all = JSON.stringify(out);
    for (const m of ['NOTES-MARKER', 'HIDDEN-SLIDE-MARKER', 'HIDDEN-NOTES-MARKER'])
      expect(all).not.toContain(m);
  });

  it('xlsx: sheet and row-range locators; hidden sheets excluded; formulas never evaluated or echoed', async () => {
    const out = await chunks(
      'xlsx',
      xlsx([
        {
          name: 'S1',
          rows: [
            ['h1', 'h2'],
            ['a', 1],
            [{ f: 'SUM(B2)+EXTERNAL-FORMULA-MARKER', v: 5 }, 'z'],
          ],
        },
        { name: 'Hidden', rows: [['HIDDEN-SHEET-MARKER']], state: 'hidden' },
        { name: 'VeryHidden', rows: [['VERY-HIDDEN-MARKER']], state: 'veryHidden' },
        { name: 'S3', rows: [['x', 'y']] },
      ]),
    );
    expect(out).toEqual([
      {
        locator: { sheet: 'S1', rowStart: 1, rowEnd: 3 },
        text: 'h1 | h2\na | 1\n5 | z',
        lang: 'en',
      },
      { locator: { sheet: 'S3', rowStart: 1, rowEnd: 1 }, text: 'x | y', lang: 'en' },
    ]);
    const all = JSON.stringify(out);
    for (const m of [
      'HIDDEN-SHEET-MARKER',
      'VERY-HIDDEN-MARKER',
      'EXTERNAL-FORMULA-MARKER',
      'SUM(',
    ])
      expect(all).not.toContain(m);
  });

  it('csv: row-range locators, quoted commas and newlines, delimiter detection', async () => {
    expect(await chunks('csv', 'name,qty\nwidget,3\n"gadget, big","multi\nline"\n')).toEqual([
      {
        locator: { rowStart: 1, rowEnd: 3 },
        text: 'name | qty\nwidget | 3\ngadget, big | multi\nline',
        lang: 'en',
      },
    ]);
    expect(await chunks('csv', 'a;b\n1;2\n')).toEqual([
      { locator: { rowStart: 1, rowEnd: 2 }, text: 'a | b\n1 | 2', lang: 'en' },
    ]);
  });

  it('markdown: heading locators; fenced code is not a heading', async () => {
    expect(
      await chunks(
        'md',
        '# Title\n\nIntro para one.\n\n## Sub\n\nSub text\nsecond line\n\n```\ncode # not heading\n```\n',
      ),
    ).toEqual([
      { locator: { heading: 'Title' }, text: 'Title\n\nIntro para one.', lang: 'en' },
      {
        locator: { heading: 'Title > Sub' },
        text: 'Sub\n\nSub text\nsecond line\n\n```\ncode # not heading\n```',
        lang: 'en',
      },
    ]);
  });

  it('is a double-run no-op: the same bytes give identical chunks', async () => {
    const buf = docx([{ text: 'Same', style: 'Heading1' }, { text: 'text' }]);
    expect(await chunks('docx', buf)).toEqual(await chunks('docx', buf));
  });
});

describe('NEG-1 fixtures: refused with a neutral code, never a crash (real parser control above)', () => {
  it('OOXML over the uncompressed budget: forged header and a real bomb', async () => {
    await refused(
      'ooxml_too_large',
      'docx',
      docx([{ text: 'x' }], {
        extra: [{ name: 'word/x.xml', data: 'y', declaredSize: 600 * 1024 * 1024 }],
      }),
    );
    const bomb = join(dir, 'bomb.docx');
    await writeZeroBomb(bomb, 20 * 1024 * 1024);
    const r = await extractFile(
      bomb,
      { v: 1, jobId: 'b'.repeat(32), kind: 'docx', declaredMime: null, declaredExt: 'docx' },
      { ...DEFAULT_LIMITS, maxOoxmlUncompressedBytes: 5 * 1024 * 1024 },
    );
    expect(r).toEqual({ ok: false, code: 'ooxml_too_large' });
  });

  it('OOXML ratio over 200 (small total, real data)', async () => {
    const bomb = join(dir, 'ratio.docx');
    await writeZeroBomb(bomb, 20 * 1024 * 1024);
    const r = await extractFile(
      bomb,
      { v: 1, jobId: 'b'.repeat(32), kind: 'docx', declaredMime: null, declaredExt: 'docx' },
      DEFAULT_LIMITS,
    );
    expect(r).toEqual({ ok: false, code: 'ooxml_ratio' });
  });

  it('a lying central directory is caught by the real byte count', async () => {
    const bomb = join(dir, 'lie.docx');
    // Declares 100 KiB (passes size and ratio checks), actually inflates to 12 MiB.
    await writeZeroBomb(bomb, 12 * 1024 * 1024, { lieAboutSize: 100 * 1024 });
    const r = await extractFile(
      bomb,
      { v: 1, jobId: 'b'.repeat(32), kind: 'docx', declaredMime: null, declaredExt: 'docx' },
      DEFAULT_LIMITS,
    );
    expect(r).toEqual({ ok: false, code: 'malformed' });
  });

  it('PDF over the page budget', async () => {
    const pages = Array.from({ length: 12 }, (_, i) => [`page ${i + 1}`]);
    await refused('pdf_pages', 'pdf', pdf(pages), { maxPdfPages: 10 });
    expect((await run('pdf', pdf(pages), { maxPdfPages: 12 })).ok).toBe(true); // control: at the limit passes
  });

  it('file over the size budget (enforced in the parser too)', async () => {
    await refused('file_too_large', 'md', Buffer.alloc(2048, 'a'), { maxFileBytes: 1024 });
  });

  it('extracted text over the budget', async () => {
    await refused('text_too_large', 'csv', `a,b\n${'word '.repeat(2000)},x\n`.repeat(50), {
      maxTextBytes: 50_000,
    });
    await refused('text_too_large', 'md', 'paragraph text '.repeat(10_000), {
      maxTextBytes: 50_000,
    });
  });

  it('XLSX over the cell budget (streamed) and a CSV line over the line budget', async () => {
    const x = xlsx([{ name: 'Big', rows: [['x']] }], { sheetXml: () => bigSheetXml(5000) });
    await refused('cell_limit', 'xlsx', x, { maxXlsxCells: 1000 });
    expect((await run('xlsx', x, { maxXlsxCells: 5000 })).ok).toBe(true);
    await refused('csv_line', 'csv', `a,b\n${'x'.repeat(2000)},y\n`, { maxCsvLineBytes: 1000 });
  });

  it('spoofed extension or MIME type', async () => {
    await refused('spoofed_type', 'docx', pdf([['not a docx']]));
    await refused('spoofed_type', 'docx', '<html><script>alert(1)</script></html>');
    await refused('spoofed_type', 'pdf', docx([{ text: 'x' }]));
    await refused('spoofed_type', 'xlsx', docx([{ text: 'a docx under an xlsx name' }]));
    await refused(
      'spoofed_type',
      'csv',
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]),
    );
    await refused(
      'spoofed_type',
      'csv',
      '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>',
    );
    await refused('spoofed_type', 'docx', docx([{ text: 'x' }]), {}, { mime: 'application/pdf' });
    await refused('spoofed_type', 'docx', docx([{ text: 'x' }]), {}, { ext: 'pdf' });
    expect(
      (
        await run(
          'docx',
          docx([{ text: 'x' }]),
          {},
          { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
        )
      ).ok,
    ).toBe(true);
  });

  it('password-protected files (PDF, encrypted OLE package, encrypted zip entry)', async () => {
    await refused('password_protected', 'pdf', pdf([['secret']], { encrypt: true }));
    const ole = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(512),
      Buffer.from('EncryptedPackage', 'utf16le'),
    ]);
    await refused('password_protected', 'docx', ole);
    await refused('spoofed_type', 'docx', Buffer.concat([ole.subarray(0, 8), Buffer.alloc(600)])); // legacy .doc
    await refused(
      'password_protected',
      'docx',
      docx([{ text: 'x' }], { extra: [{ name: 'word/enc.bin', data: 'z', encrypted: true }] }),
    );
  });

  it('macro-enabled Office files', async () => {
    await refused('macro_enabled', 'docx', docx([{ text: 'x' }], { macro: true }));
    await refused('macro_enabled', 'xlsx', xlsx([{ name: 'S', rows: [['x']] }], { macro: true }));
    // A macro-enabled content type without a vbaProject part is refused as well (.docm renamed .docx).
    await refused('macro_enabled', 'docx', docx([{ text: 'x' }], { macroContentType: true }));
  });

  it('archive entries with ../ or absolute paths', async () => {
    for (const name of [
      '../evil.xml',
      '/abs/evil.xml',
      'word/../../evil.xml',
      'C:/evil.xml',
      'a\\..\\b.xml',
    ])
      await refused('unsafe_path', 'docx', docx([{ text: 'x' }], { extra: [{ name, data: 'z' }] }));
  });

  it('XML external entities and DTDs are refused before any library sees them', async () => {
    await refused('xml_dtd', 'docx', xxeDocx());
    await refused(
      'xml_dtd',
      'xlsx',
      xlsx([{ name: 'S', rows: [['x']] }], {
        sheetXml: () =>
          `<?xml version="1.0"?><!DOCTYPE s [<!ENTITY a "b">]><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>`,
      }),
    );
    // UTF-16 XML would hide a DTD from a byte scan: refused too.
    await refused(
      'xml_dtd',
      'docx',
      docx([{ text: 'x' }], {
        extra: [{ name: 'word/u16.xml', data: Buffer.from('\ufeff<a/>', 'utf16le') }],
      }),
    );
  });

  it('XLSX external links: the target is never emitted or followed', async () => {
    const out = await chunks(
      'xlsx',
      xlsx([{ name: 'S', rows: [['linked', { f: "'[1]Sheet1'!A1", v: 'cached' }]] }], {
        extra: [
          {
            name: 'xl/externalLinks/externalLink1.xml',
            data: '<externalLink xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><externalBook/></externalLink>',
          },
          {
            name: 'xl/externalLinks/_rels/externalLink1.xml.rels',
            data: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="http://169.254.169.254/latest/meta-data/" TargetMode="External"/></Relationships>',
          },
        ],
      }),
    );
    expect(out).toEqual([
      { locator: { sheet: 'S', rowStart: 1, rowEnd: 1 }, text: 'linked | cached', lang: 'en' },
    ]);
    expect(JSON.stringify(out)).not.toContain('169.254');
  });

  it('NUL bytes', async () => {
    await refused('nul_bytes', 'csv', Buffer.from('a,b\n1,\u00002\n', 'utf8'));
    await refused('nul_bytes', 'md', Buffer.from('# T\n\nbad\u0000text\n', 'utf8'));
  });

  it('zero extractable text ends as no_text', async () => {
    await refused('no_text', 'docx', docx([{ text: 'gone', deleted: true }]));
    await refused('no_text', 'csv', ',,\n,,\n');
    await refused('no_text', 'md', '   \n\n');
    await refused('no_text', 'pdf', pdf([['']]));
    await refused('no_text', 'pptx', pptx([{ paras: ['hidden only'], hidden: true }]));
  });

  it('truncated or malformed files fail neutrally', async () => {
    await refused('malformed', 'docx', docx([{ text: 'x' }]).subarray(0, 300));
    await refused('malformed', 'pdf', Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog'));
    await refused(
      'malformed',
      'xlsx',
      zip([{ name: '[Content_Types].xml', data: '<Types/>' }]).subarray(0, 40),
    );
  });
});
