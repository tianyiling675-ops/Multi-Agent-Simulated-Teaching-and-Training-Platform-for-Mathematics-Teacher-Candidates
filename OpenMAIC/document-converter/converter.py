"""Uploaded document bytes -> Markdown. Word math is deliberately deferred.

There is no URL/path API and no default DOCX converter registration. Formula
markers locate nodes in the original archive; they contain no converted math.
"""
from __future__ import annotations

import hashlib
import importlib.metadata
import io
import zipfile
from xml.etree import ElementTree as ET

from defusedxml.ElementTree import fromstring

ADAPTER_VERSION = "openmaic-documents-v1"
FILE_LIMIT = 8 * 1024 * 1024
TEXT_LIMIT = 100_000
XML_LIMIT = 8 * 1024 * 1024
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
M = "{http://schemas.openxmlformats.org/officeDocument/2006/math}"
WORD_PARTS = {"word/document.xml", "word/footnotes.xml", "word/endnotes.xml"}


class ConversionError(Exception):
    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def warning(code: str, message: str) -> dict:
    return {"code": code, "message": message}


def _replace_with_text(parent: ET.Element, node: ET.Element, text: str) -> None:
    # oMath may sit inside a run, paragraph or table cell. Keep Word's run
    # structure valid so replacing inline math does not merge adjacent words.
    replacement = ET.Element(W + "t")
    replacement.text = text
    replacement.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    if parent.tag != W + "r":
        run = ET.Element(W + "r")
        run.append(replacement)
        replacement = run
    if parent.tag in {W + "body", W + "tc", W + "footnote", W + "endnote"}:
        paragraph = ET.Element(W + "p")
        paragraph.append(replacement)
        replacement = paragraph
    replacement.tail = node.tail
    position = list(parent).index(node)
    parent.remove(node)
    parent.insert(position, replacement)


def _defer_word_objects(data: bytes, digest: str) -> tuple[bytes, list, list]:
    """Make a working copy, masking math before Mammoth sees it.

    index is the zero-based ordinal of top-level math/object blocks in that
    original XML part. Nested oMath inside oMathPara receives only one marker.
    The uploaded source bytes are never modified or replaced in persistence.
    """
    deferred, warnings = [], []
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        if "word/document.xml" not in names or "[Content_Types].xml" not in names:
            raise ConversionError("MATERIAL_INVALID", "文件不是完整的 DOCX 文档。")
        if len(names) != len(set(names)) or len(entries) > 2000:
            raise ConversionError("MATERIAL_INVALID", "DOCX 压缩包包含重复或过多的内容项。")
        if any(e.flag_bits & 1 for e in entries):
            raise ConversionError("MATERIAL_ENCRYPTED", "请先解除 Word 文档密码后上传。")
        if sum(e.file_size for e in entries) > 64 * 1024 * 1024:
            raise ConversionError("MATERIAL_LIMIT_EXCEEDED", "文档解压内容过大，请拆分后上传。")
        images = 0
        output = io.BytesIO()
        with archive, zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as target:
            for entry in entries:
                if entry.filename.endswith(".xml") and entry.file_size > XML_LIMIT:
                    raise ConversionError("MATERIAL_LIMIT_EXCEEDED", "文档正文过大，请拆分后上传。")
                content = archive.read(entry)
                if entry.filename in WORD_PARTS:
                    root = fromstring(content)
                    parents = {child: parent for parent in root.iter() for child in parent}
                    targets = []
                    for node in root.iter():
                        if node.tag not in {M + "oMath", M + "oMathPara", W + "object"}:
                            continue
                        ancestor = parents.get(node)
                        nested = False
                        while ancestor is not None:
                            if ancestor.tag in {M + "oMath", M + "oMathPara", W + "object"}:
                                nested = True
                                break
                            ancestor = parents.get(ancestor)
                        if not nested:
                            targets.append(node)
                    for index, node in enumerate(targets):
                        if len(deferred) >= 512:
                            raise ConversionError("MATERIAL_LIMIT_EXCEEDED", "待处理公式或内嵌对象过多，请拆分文档。")
                        marker_id = f"formula_{digest[:12]}_{len(deferred) + 1}"
                        kind = "office_math" if node.tag.startswith(M) else "embedded_object"
                        deferred.append({"id": marker_id, "part": entry.filename, "index": index, "kind": kind})
                        label = "公式待处理" if kind == "office_math" else "内嵌对象待处理"
                        _replace_with_text(parents[node], node, f"【{label}：{marker_id}】")
                    # Images, including images of equations, are not OCR'd. Keep
                    # an explicit source marker rather than a temporary URL.
                    parents = {child: parent for parent in root.iter() for child in parent}
                    for node in list(root.iter()):
                        if node.tag not in {W + "drawing", W + "pict"}:
                            continue
                        ancestor = parents.get(node)
                        nested = False
                        while ancestor is not None:
                            if ancestor.tag in {W + "drawing", W + "pict"}:
                                nested = True
                                break
                            ancestor = parents.get(ancestor)
                        if not nested:
                            images += 1
                            _replace_with_text(parents[node], node, f"【图片待核对：{entry.filename}，第{images}处】")
                    content = ET.tostring(root, encoding="utf-8", xml_declaration=True)
                target.writestr(entry.filename, content)
        if deferred:
            warnings.append(warning("FORMULAS_DEFERRED", f"保留了 {len(deferred)} 处公式或内嵌对象的位置，尚未执行公式转换；原文件随材料保留。"))
        if images:
            warnings.append(warning("IMAGES_DEFERRED", f"文档中有 {images} 处图片，已标出位置，未进行图片识别；请对照原文件核对。"))
        return output.getvalue(), deferred, warnings
    except ConversionError:
        raise
    except Exception as error:
        raise ConversionError("MATERIAL_INVALID", "Word 文件损坏或格式不受支持，请重新另存为 DOCX。") from error


def _word_converter():
    import mammoth
    from markitdown import DocumentConverter
    from markitdown.converters import HtmlConverter

    class DeferredDocxConverter(DocumentConverter):
        def accepts(self, file_stream, stream_info, **kwargs):
            return stream_info.extension == ".docx"

        def convert(self, file_stream, stream_info, **kwargs):
            # Do not call DocxConverter.convert or pre_process_docx. In
            # particular, no upstream OMML -> LaTeX function is invoked here.
            html = mammoth.convert_to_html(
                file_stream, include_embedded_style_map=False, external_file_access=False,
            ).value
            return HtmlConverter().convert_string(html)

    return DeferredDocxConverter()


def _inspect_pdf(data: bytes) -> tuple[int, list]:
    import pdfplumber
    from pdfminer.pdfdocument import PDFPasswordIncorrect
    try:
        with pdfplumber.open(io.BytesIO(data)) as document:
            pages = len(document.pages)
            if pages > 80:
                raise ConversionError("MATERIAL_LIMIT_EXCEEDED", "PDF 超过80页，请拆分后上传。")
            if not pages:
                raise ConversionError("MATERIAL_EMPTY", "PDF 没有可读取的页面。")
            blank = []
            for index, page in enumerate(document.pages):
                if not (page.extract_text() or "").strip():
                    blank.append(index + 1)
                page.close()
            if len(blank) == pages:
                raise ConversionError("OCR_REQUIRED", "PDF 未包含可提取文字，可能是扫描件；当前未接入 OCR，请上传文字型 PDF 或 DOCX。")
            warnings = [warning("PDF_REVIEW_REQUIRED", "已提取 PDF 可复制文字；复杂表格、原版式、数学符号和图片请对照原文件核对，未执行 OCR 或公式识别。")]
            if blank:
                numbers = "、".join(map(str, blank[:20]))
                warnings.append(warning("PDF_PARTIAL_TEXT", f"第 {numbers} 页等共 {len(blank)} 页没有提取到文字，相关内容需要对照原件核对。"))
            return pages, warnings
    except PDFPasswordIncorrect as error:
        raise ConversionError("MATERIAL_ENCRYPTED", "PDF 有密码保护，请解除密码后上传。") from error
    except ConversionError:
        raise
    except Exception as error:
        raise ConversionError("MATERIAL_INVALID", "PDF 文件损坏或无法读取，请检查原文件。") from error


def convert_document(data: bytes, format: str) -> dict:
    if format not in {"docx", "pdf"}:
        raise ConversionError("MATERIAL_UNSUPPORTED", "仅支持 DOCX 和 PDF。")
    if not data or len(data) > FILE_LIMIT:
        raise ConversionError("MATERIAL_LIMIT_EXCEEDED", "请选择不超过8 MiB的非空文档。")
    if format == "pdf" and not data.startswith(b"%PDF-"):
        raise ConversionError("MATERIAL_INVALID", "文件不是有效 PDF。")
    digest = hashlib.sha256(data).hexdigest()
    from markitdown import MarkItDown, StreamInfo
    from markitdown.converters import PdfConverter
    # With builtins OFF, a failing custom DOCX adapter cannot fall through to
    # upstream's formula converter, a ZIP converter or arbitrary URL handlers.
    engine = MarkItDown(enable_builtins=False, enable_plugins=False)
    deferred, warnings = [], []
    pages = None
    if format == "docx":
        converted, deferred, warnings = _defer_word_objects(data, digest)
        engine.register_converter(_word_converter())
        warnings.append(warning("WORD_LAYOUT_REVIEW", "已转换 Word 正文、标题、列表和表格；不保留原页面排版，公式由后续独立模块处理。"))
    else:
        pages, warnings = _inspect_pdf(data)
        converted = data
        engine.register_converter(PdfConverter())
    try:
        result = engine.convert_stream(io.BytesIO(converted), stream_info=StreamInfo(extension="." + format))
        markdown = result.markdown.strip()
        # Markdownify escapes underscores. Keep our machine-readable marker IDs
        # stable for the future formula adapter as well as the visible preview.
        for entry in deferred:
            markdown = markdown.replace(entry["id"].replace("_", "\\_"), entry["id"])
    except Exception as error:
        raise ConversionError("MATERIAL_INVALID", "文档转换未完成，请检查文件或重新另存后上传。") from error
    if not markdown:
        raise ConversionError("MATERIAL_EMPTY", "没有提取到可用内容，请检查原文件。")
    if len(markdown) > TEXT_LIMIT:
        raise ConversionError("MATERIAL_LIMIT_EXCEEDED", "转换内容超过10万字符，请拆分文档。")
    metadata = {
        "engine": "markitdown", "version": importlib.metadata.version("markitdown"),
        "adapterVersion": ADAPTER_VERSION, "contentFormat": "markdown",
        "formulaHandling": "deferred" if deferred else "not_processed",
        "warnings": warnings, "deferredFormulas": deferred,
    }
    if pages is not None:
        metadata["pages"] = pages
    return {"text": markdown, "markdown": markdown, "warning": " ".join(w["message"] for w in warnings),
            "format": format, "sourceHash": digest, "conversion": metadata}
