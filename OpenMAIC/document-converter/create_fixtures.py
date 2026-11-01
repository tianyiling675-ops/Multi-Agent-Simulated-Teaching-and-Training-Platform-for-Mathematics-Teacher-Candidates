"""Generate non-private fixtures for the isolated browser acceptance suite."""
from pathlib import Path
import sys
from test_converter import make_docx, make_pdf

folder = Path(sys.argv[1])
folder.mkdir(parents=True, exist_ok=True)
body = '''<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>椭圆教学设计</w:t></w:r></w:p>
<w:p><w:r><w:t>引导学生比较分母，说明长半轴方向。</w:t></w:r></w:p>
<w:p><w:r><w:t>示例方程：</w:t></w:r><m:oMath><m:r><m:t>x^2/9+y^2/16=1</m:t></m:r></m:oMath></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>教学环节</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>教师活动</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>情境导入</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>比较横向和纵向椭圆</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'''
(folder / '数学教案.docx').write_bytes(make_docx(body))
(folder / '参考材料.pdf').write_bytes(make_pdf(['Reference lesson plan', 'Compare two equations']))
(folder / '扫描件.pdf').write_bytes(make_pdf(['']))
(folder / '损坏文件.docx').write_bytes(b'PK-broken-fixture')
(folder / '超长教案.md').write_text('# 长教案\n\n' + '需要核对的教学过程。' * 3100, encoding='utf-8')
