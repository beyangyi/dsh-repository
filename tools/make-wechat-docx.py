"""把 `docs/user-guide.md` 导出成 `docs/wechat/guide.docx`（公众号复制用）。

Word 里全选复制 → 粘贴进公众号编辑器，排版与 9 张配图会一起过去（图片由公众号自动上传）。
这份是 MD → DOCX 的定向转换，只覆盖指南实际用到的语法。

用法：python tools/make-wechat-docx.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor

ROOT = Path(__file__).resolve().parents[1]
GUIDE = ROOT / "docs" / "user-guide.md"
OUT = ROOT / "docs" / "wechat" / "guide.docx"
IMAGE_DIR = ROOT / "docs" / "images"

TITLE = "星野计划：把「去哪拍、什么时候拍、怎么拍」一次算清"
INTRO = (
    "这份指南按「查询 → 结果 → 便签 → 参数 → 画面模拟 → 数据」的顺序介绍全部功能，"
    "配 9 张真实界面截图。适合收藏后按图索骥。"
)
FOOTER = "星野计划（dsh-astro-plan）· 作者 Sirius YANG · MIT 许可 · github.com/SiriusYANG91/dsh-astro-plan"

BODY_FONT = "Microsoft YaHei"
MONO_FONT = "Consolas"
BODY_SIZE = Pt(10.5)


def set_font(run, *, name: str = BODY_FONT, size=BODY_SIZE, bold=None, color=None) -> None:
    run.font.name = name
    run.font.size = size
    if bold is not None:
        run.font.bold = bold
    if color is not None:
        run.font.color.rgb = color
    run._element.rPr.rFonts.set(qn("w:eastAsia"), name)


def shade(paragraph, hex_fill: str) -> None:
    p_pr = paragraph._p.get_or_add_pPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:fill"), hex_fill)
    p_pr.append(shd)


def add_inline(paragraph, text: str) -> None:
    """`code`、**bold**、[text](url) 三种行内语法。"""
    pattern = re.compile(r"`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\(([^)]+)\)")
    position = 0
    for match in pattern.finditer(text):
        if match.start() > position:
            set_font(paragraph.add_run(text[position:match.start()]))
        if match.group(1) is not None:
            set_font(paragraph.add_run(match.group(1)), name=MONO_FONT, size=Pt(9.5), color=RGBColor(0xC7, 0x25, 0x4E))
        elif match.group(2) is not None:
            set_font(paragraph.add_run(match.group(2)), bold=True, color=RGBColor(0x1F, 0x23, 0x29))
        elif match.group(3) is not None:
            run = paragraph.add_run(match.group(3))
            set_font(run, color=RGBColor(0x6B, 0x72, 0x80))
            run.font.italic = True
        else:
            set_font(paragraph.add_run(match.group(4)), color=RGBColor(0x57, 0x6B, 0x95))
            url = match.group(5)
            if url.startswith("http"):
                set_font(paragraph.add_run(f"（{url.split('/')[2]}）"), size=Pt(8.5), color=RGBColor(0x9A, 0xA4, 0xB2))
        position = match.end()
    if position < len(text):
        set_font(paragraph.add_run(text[position:]))


def heading(doc, text: str, level: int) -> None:
    paragraph = doc.add_paragraph()
    paragraph.paragraph_format.space_before = Pt(16 if level == 2 else 12)
    paragraph.paragraph_format.space_after = Pt(6)
    paragraph.paragraph_format.keep_with_next = True
    run = paragraph.add_run(text)
    set_font(run, size=Pt(15 if level == 2 else 12), bold=True, color=RGBColor(0x1F, 0x23, 0x29))
    if level == 2:
        p_pr = paragraph._p.get_or_add_pPr()
        borders = OxmlElement("w:pBdr")
        left = OxmlElement("w:left")
        left.set(qn("w:val"), "single")
        left.set(qn("w:sz"), "18")
        left.set(qn("w:space"), "8")
        left.set(qn("w:color"), "D8B46A")
        borders.append(left)
        p_pr.append(borders)


def code_block(doc, lines: list[str]) -> None:
    for index, line in enumerate(lines):
        paragraph = doc.add_paragraph()
        paragraph.paragraph_format.space_after = Pt(2 if index < len(lines) - 1 else 8)
        paragraph.paragraph_format.left_indent = Inches(0.12)
        shade(paragraph, "F7F8FA")
        set_font(paragraph.add_run(line if line else " "), name=MONO_FONT, size=Pt(9))


def table(doc, rows: list[list[str]]) -> None:
    header = rows[0]
    body = [row for row in rows[1:] if not all(re.fullmatch(r":?-{2,}:?", cell.strip()) for cell in row)]
    table_obj = doc.add_table(rows=1, cols=len(header))
    table_obj.style = "Table Grid"
    table_obj.alignment = WD_TABLE_ALIGNMENT.CENTER
    for index, cell_text in enumerate(header):
        cell = table_obj.rows[0].cells[index]
        cell.text = ""
        add_inline(cell.paragraphs[0], cell_text.strip())
        shading = OxmlElement("w:shd")
        shading.set(qn("w:val"), "clear")
        shading.set(qn("w:fill"), "F6F7F9")
        cell._tc.get_or_add_tcPr().append(shading)
        for run in cell.paragraphs[0].runs:
            run.font.bold = True
    for row in body:
        cells = table_obj.add_row().cells
        for index, cell_text in enumerate(row[: len(header)]):
            cells[index].text = ""
            add_inline(cells[index].paragraphs[0], cell_text.strip())


def image(doc, path: Path, caption: str) -> None:
    paragraph = doc.add_paragraph()
    paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
    paragraph.paragraph_format.space_before = Pt(10)
    paragraph.add_run().add_picture(str(path), width=Inches(6.2))
    note = doc.add_paragraph()
    note.alignment = WD_ALIGN_PARAGRAPH.CENTER
    note.paragraph_format.space_after = Pt(10)
    set_font(note.add_run(caption), size=Pt(8.5), color=RGBColor(0x9A, 0xA4, 0xB2))


def build() -> None:
    markdown = GUIDE.read_text(encoding="utf-8").split("\n")
    doc = Document()
    section = doc.sections[0]
    section.left_margin = section.right_margin = Inches(0.7)

    normal = doc.styles["Normal"]
    normal.font.name = BODY_FONT
    normal.font.size = BODY_SIZE
    normal.element.rPr.rFonts.set(qn("w:eastAsia"), BODY_FONT)
    normal.paragraph_format.line_spacing = 1.5
    normal.paragraph_format.space_after = Pt(6)

    title = doc.add_paragraph()
    title.paragraph_format.space_after = Pt(10)
    set_font(title.add_run(TITLE), size=Pt(17), bold=True, color=RGBColor(0x1F, 0x23, 0x29))
    lead = doc.add_paragraph()
    set_font(lead.add_run(INTRO), color=RGBColor(0x5A, 0x60, 0x6A))

    in_code = False
    code_lines: list[str] = []
    table_rows: list[list[str]] = []

    def flush_table() -> None:
        nonlocal table_rows
        if table_rows:
            table(doc, table_rows)
            table_rows = []

    for line in markdown:
        fence = line.startswith("```")
        if in_code:
            if fence:
                code_block(doc, code_lines)
                in_code, code_lines = False, []
            else:
                code_lines.append(line)
            continue
        if fence:
            flush_table()
            in_code = True
            continue
        if line.startswith("|"):
            table_rows.append(line.split("|")[1:-1])
            continue
        flush_table()

        if re.match(r"^#{1,6} ", line):
            level = len(line) - len(line.lstrip("#"))
            text = re.sub(r"^#+\s+", "", line)
            if level >= 2:
                heading(doc, text, 2 if level == 2 else 3)
            continue
        image_match = re.match(r"^!\[([^\]]*)\]\(([^)]+)\)", line)
        if image_match:
            caption, source = image_match.group(1), IMAGE_DIR / Path(image_match.group(2)).name
            image(doc, source, caption)
            continue
        if line.startswith("> "):
            paragraph = doc.add_paragraph()
            shade(paragraph, "FAF7F0")
            add_inline(paragraph, line[2:])
            continue
        if re.fullmatch(r"---", line):
            dot = doc.add_paragraph()
            dot.alignment = WD_ALIGN_PARAGRAPH.CENTER
            set_font(dot.add_run("· · ·"), color=RGBColor(0xD8, 0xB4, 0x6A))
            continue
        bullet = re.match(r"^[-*] (.+)$", line)
        numbered = re.match(r"^\d+\. (.+)$", line)
        if bullet:
            paragraph = doc.add_paragraph(style="List Bullet")
            add_inline(paragraph, bullet.group(1))
            continue
        if numbered:
            paragraph = doc.add_paragraph(style="List Number")
            add_inline(paragraph, numbered.group(1))
            continue
        if not line.strip():
            continue
        paragraph = doc.add_paragraph()
        add_inline(paragraph, line)

    flush_table()
    if in_code and code_lines:
        code_block(doc, code_lines)

    end = doc.add_paragraph()
    end.paragraph_format.space_before = Pt(18)
    set_font(end.add_run(FOOTER), size=Pt(9), color=RGBColor(0x8A, 0x94, 0xA6))

    OUT.parent.mkdir(parents=True, exist_ok=True)
    doc.save(OUT)
    print(f"OK {OUT} ({OUT.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    sys.exit(build())
