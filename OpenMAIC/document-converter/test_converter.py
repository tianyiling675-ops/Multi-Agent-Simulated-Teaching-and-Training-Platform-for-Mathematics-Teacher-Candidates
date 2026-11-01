import hashlib
import io
import unittest
import zipfile
from unittest.mock import patch

from converter import ConversionError, _defer_word_objects, convert_document


def make_docx(body, extra=None):
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", '''<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>''')
        archive.writestr("_rels/.rels", '''<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>''')
        archive.writestr("word/document.xml", f'''<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><w:body>{body}</w:body></w:document>''')
        archive.writestr("word/styles.xml", '''<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>''')
        archive.writestr("word/_rels/document.xml.rels", '''<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>''')
        for name, content in (extra or {}).items():
            archive.writestr(name, content)
    return data.getvalue()


def make_pdf(texts):
    # Small, genuine PDF fixtures without adding a document generation package
    # to the converter's production dependencies.
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>", b"", b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    kids = []
    for text in texts:
        page_id = len(objects) + 1
        stream_id = page_id + 1
        kids.append(f"{page_id} 0 R")
        stream = f"BT /F1 16 Tf 72 720 Td ({text}) Tj ET".encode() if text else b"q Q"
        objects.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents {stream_id} 0 R >>".encode())
        objects.append(f"<< /Length {len(stream)} >>\nstream\n".encode() + stream + b"\nendstream")
    objects[1] = f"<< /Type /Pages /Kids [{' '.join(kids)}] /Count {len(kids)} >>".encode()
    output = b"%PDF-1.4\n"
    offsets = [0]
    for index, content in enumerate(objects, 1):
        offsets.append(len(output))
        output += f"{index} 0 obj\n".encode() + content + b"\nendobj\n"
    xref = len(output)
    output += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    for offset in offsets[1:]:
        output += f"{offset:010d} 00000 n \n".encode()
    output += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF".encode()
    return output


class ConverterTests(unittest.TestCase):
    def test_word_headings_table_and_unicode(self):
        body = '''<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>椭圆教学设计</w:t></w:r></w:p><w:p><w:r><w:t>说明长半轴的判断依据。</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>教学环节</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>教师活动</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>情境导入</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>比较两个方程</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'''
        data = make_docx(body, {"docProps/core.xml": "PRIVATE_METADATA"})
        result = convert_document(data, "docx")
        self.assertIn("# 椭圆教学设计", result["markdown"])
        self.assertIn("| 教学环节 | 教师活动 |", result["markdown"])
        self.assertIn("比较两个方程", result["markdown"])
        self.assertNotIn("PRIVATE_METADATA", result["markdown"])
        self.assertEqual(hashlib.sha256(data).hexdigest(), result["sourceHash"])

    def test_math_is_deferred_and_default_formula_pipeline_never_runs(self):
        math = '<m:oMath><m:r><m:t>DO_NOT_CONVERT_ME</m:t></m:r></m:oMath>'
        data = make_docx(f'<w:p><w:r><w:t>之前</w:t></w:r>{math}<w:r><w:t>之后</w:t></w:r></w:p><w:p><m:oMathPara>{math}</m:oMathPara></w:p>')
        with patch('markitdown.converters._docx_converter.pre_process_docx', side_effect=AssertionError('Default DOCX pipeline must not run')) as default:
            result = convert_document(data, "docx")
            default.assert_not_called()
        deferred = result["conversion"]["deferredFormulas"]
        self.assertEqual(len(deferred), 2)
        self.assertEqual([entry["index"] for entry in deferred], [0, 1])
        self.assertEqual(result["conversion"]["formulaHandling"], "deferred")
        self.assertIn("之前", result["markdown"])
        self.assertIn("之后", result["markdown"])
        self.assertNotIn("DO_NOT_CONVERT_ME", result["markdown"])
        for entry in deferred:
            self.assertIn(entry["id"], result["markdown"])
        sanitized, _, _ = _defer_word_objects(data, result["sourceHash"])
        with zipfile.ZipFile(io.BytesIO(sanitized)) as archive:
            self.assertNotIn(b"oMath", archive.read("word/document.xml"))
        self.assertIn(b"oMath", zipfile.ZipFile(io.BytesIO(data)).read("word/document.xml"))

    def test_corrupt_word_has_a_specific_error(self):
        with self.assertRaises(ConversionError) as error:
            convert_document(b"PK-not-a-zip", "docx")
        self.assertEqual(error.exception.code, "MATERIAL_INVALID")

    def test_images_are_marked_without_network_or_ocr(self):
        result = convert_document(make_docx('<w:p><w:r><w:drawing/></w:r></w:p>'), "docx")
        self.assertIn("图片待核对", result["markdown"])
        self.assertTrue(any(w["code"] == "IMAGES_DEFERRED" for w in result["conversion"]["warnings"]))

    def test_xml_expansion_limit_precedes_parsing(self):
        data = make_docx('a' * (9 * 1024 * 1024))
        with self.assertRaises(ConversionError) as error:
            convert_document(data, "docx")
        self.assertEqual(error.exception.code, "MATERIAL_LIMIT_EXCEEDED")

    def test_real_pdf_text_and_page_metadata(self):
        result = convert_document(make_pdf(["Lesson plan", "Compare two equations"]), "pdf")
        self.assertIn("Lesson plan", result["markdown"])
        self.assertEqual(result["conversion"]["pages"], 2)
        self.assertEqual(result["conversion"]["formulaHandling"], "not_processed")

    def test_blank_pdf_requires_ocr(self):
        with self.assertRaises(ConversionError) as error:
            convert_document(make_pdf([""]), "pdf")
        self.assertEqual(error.exception.code, "OCR_REQUIRED")

    def test_mixed_pdf_marks_unreadable_pages(self):
        result = convert_document(make_pdf(["Lesson plan", ""]), "pdf")
        self.assertTrue(any(w["code"] == "PDF_PARTIAL_TEXT" for w in result["conversion"]["warnings"]))

    def test_pdf_page_limit(self):
        with self.assertRaises(ConversionError) as error:
            convert_document(make_pdf(["Page"] * 81), "pdf")
        self.assertEqual(error.exception.code, "MATERIAL_LIMIT_EXCEEDED")

    def test_formula_adapter_failure_does_not_fall_back_to_default(self):
        data = make_docx('<w:p><w:r><w:t>Text</w:t></w:r></w:p>')
        from markitdown import DocumentConverter

        class Failing(DocumentConverter):
            def accepts(self, *args, **kwargs): return True
            def convert(self, *args, **kwargs): raise ValueError('broken adapter')

        with patch('converter._word_converter', return_value=Failing()), patch('markitdown.converters._docx_converter.pre_process_docx') as default:
            with self.assertRaises(ConversionError):
                convert_document(data, "docx")
            default.assert_not_called()


if __name__ == '__main__':
    unittest.main()
