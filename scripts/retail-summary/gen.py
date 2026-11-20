#!/usr/bin/env python3
"""Build one Word file per region for the weekly retail recruitment summary.

Usage: python3 gen.py data.json outdir
data.json: {"week": "w/e Fri 13 Nov", "regions": [{"name": "North", "headline": "...",
  "stages": "Interviews 5 · ...", "filled": [[shop, role, hires, am], ...],
  "closed": [[shop, role, am], ...], "live": [[am, shop, role, stage, days], ...],
  "archived": [[am, shop, role, stage, days], ...] (status Archived, not in the Closed group; optional)}]}
"""
import json, sys, os
from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

FONT = "Arial"

def shade(cell, hex_fill):
    tcPr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear"); shd.set(qn("w:color"), "auto"); shd.set(qn("w:fill"), hex_fill)
    tcPr.append(shd)

def para(doc, text, size=10, bold=False, before=0, after=4, color=None):
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(before); p.paragraph_format.space_after = Pt(after)
    r = p.add_run(text); r.bold = bold; r.font.size = Pt(size); r.font.name = FONT
    if color: r.font.color.rgb = RGBColor.from_string(color)
    return p

def table(doc, headers, rows, widths_cm, bold_last_new=False):
    t = doc.add_table(rows=1, cols=len(headers))
    t.style = "Table Grid"; t.alignment = WD_TABLE_ALIGNMENT.LEFT; t.autofit = False
    for i, h in enumerate(headers):
        c = t.rows[0].cells[i]; c.text = ""
        r = c.paragraphs[0].add_run(h); r.bold = True; r.font.size = Pt(9.5); r.font.name = FONT
        shade(c, "D9E2EC")
    for row in rows:
        cells = t.add_row().cells
        for i, v in enumerate(row):
            cells[i].text = ""
            r = cells[i].paragraphs[0].add_run(str(v)); r.font.size = Pt(9.5); r.font.name = FONT
            if bold_last_new and i == len(row) - 1 and "New" in str(v):
                r.bold = True
    grid = t._tbl.tblGrid
    for i, gc in enumerate(grid.findall(qn("w:gridCol"))):
        gc.set(qn("w:w"), str(int(widths_cm[i] * 567)))
    trPr = t.rows[0]._tr.get_or_add_trPr()
    hdr = OxmlElement("w:tblHeader"); hdr.set(qn("w:val"), "true"); trPr.append(hdr)
    for row in t.rows:
        for i, w in enumerate(widths_cm):
            row.cells[i].width = Cm(w)
            for p in row.cells[i].paragraphs:
                p.paragraph_format.space_after = Pt(1); p.paragraph_format.space_before = Pt(1)
    return t

def build(region, week, outdir):
    doc = Document()
    s = doc.sections[0]
    s.page_width, s.page_height = Cm(21), Cm(29.7)
    for m in ("left_margin", "right_margin"): setattr(s, m, Cm(1.6))
    s.top_margin = s.bottom_margin = Cm(1.5)
    st = doc.styles["Normal"]; st.font.name = FONT; st.font.size = Pt(10)
    st.element.rPr.rFonts.set(qn("w:eastAsia"), FONT)

    para(doc, f"{region['name']} region – retail recruitment, {week}", size=14, bold=True, after=6)
    para(doc, region["headline"], size=11, bold=True, after=2)
    para(doc, "Live by stage: " + region["stages"], size=9.5, after=8, color="404040")

    para(doc, "Filled this week", size=11, bold=True, before=6, after=3)
    if region["filled"]:
        table(doc, ["Shop", "Role", "Hires", "Area manager"], region["filled"], [4.4, 6.8, 1.6, 4.6])
    else:
        para(doc, "None")

    if region["closed"]:
        para(doc, "Closed without a hire", size=11, bold=True, before=10, after=3)
        table(doc, ["Shop", "Role", "Area manager"], region["closed"], [4.4, 6.8, 4.6])

    para(doc, "All live vacancies", size=11, bold=True, before=10, after=3)
    table(doc, ["Area manager", "Shop", "Role", "Stage", "Days open"], region["live"],
          [3.5, 3.5, 5.0, 3.8, 2.0], bold_last_new=True)

    if region.get("archived"):
        para(doc, "Archived, still being worked on", size=11, bold=True, before=10, after=1)
        para(doc, "Archived on monday.com but not yet moved to Closed, so not advertised but still in progress.",
             size=9.5, after=3, color="404040")
        table(doc, ["Area manager", "Shop", "Role", "Stage", "Days open"], region["archived"],
              [3.5, 3.5, 5.0, 3.8, 2.0], bold_last_new=True)

    name = f"{region['name']} region retail recruitment {week.replace('/', '-')}.docx"
    path = os.path.join(outdir, name)
    doc.save(path)
    return path

if __name__ == "__main__":
    data = json.load(open(sys.argv[1]))
    os.makedirs(sys.argv[2], exist_ok=True)
    for reg in data["regions"]:
        print(build(reg, data["week"], sys.argv[2]))
