# SPDX-License-Identifier: AGPL-3.0-only
# Regenerates the small document fixtures used by the mock e2e (python3 make-documents.py). They are
# structurally valid minimal files; the mock API never parses them (a NOTEXT marker makes it fail the
# parse with `no_text`), but they are also acceptable input for a real parser.
import zipfile

PDF = b"""%%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 44>>stream
BT /F1 12 Tf 10 50 Td (%s) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%%%EOF
"""


def ooxml(path, parts):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="xml" ContentType="application/xml"/></Types>',
        )
        for name, body in parts.items():
            z.writestr(name, body)


open("sample.pdf", "wb").write(PDF % b"Quarterly budget")
open("notext.pdf", "wb").write(PDF % b"NOTEXT")
ooxml("sample.docx", {"word/document.xml": "<w:document><w:body><w:p>Quarterly budget</w:p></w:body></w:document>"})
ooxml("sample.pptx", {"ppt/slides/slide1.xml": "<p:sld><a:t>Quarterly budget</a:t></p:sld>"})
ooxml("sample.xlsx", {"xl/worksheets/sheet1.xml": "<worksheet><sheetData/></worksheet>"})
open("sample.csv", "w").write("item,amount\ntravel,1200\ntooling,800\nhiring,9000\n")
open("sample.md", "w").write("# Handbook\n\nWelcome to the quarterly budget handbook.\n\n## Travel\n\nBook early.\n")
open("legacy.doc", "wb").write(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1legacy word file")
