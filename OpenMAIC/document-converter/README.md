# 教案文档转换服务

将 DOCX、文字型 PDF 转为 Markdown，供教师训练的教案／参考材料导入使用。
MarkItDown 固定为 0.1.9，完整解析依赖锁定在 requirements.lock.txt。
上游项目：[Microsoft MarkItDown](https://github.com/microsoft/markitdown)。沿用其结构化文字转 Markdown 的用途，不承诺 Word/PDF 原页面版式还原。PDF 复杂表格、数学符号和图片需核对原件。

## 应用内使用

- “导入教案”：先预览、编辑，再追加或替换教学过程；后续课件生成使用核对后的教学过程，不重新加入归档的未编辑全文。
- “导入参考文档”：保存核对后的参考正文。在“原始来源 → 查看来源内容”可以再次编辑，应用后仍需保存草稿；原文件和初次转换结果保持归档。
- 导入预览和已保存来源均可下载 Markdown，导出当前预览中的文字。教案来源展示的是原始转换归档，当前教案在“教学设计”中编辑。
- 来源中的修改不会改写已确认材料版本。

## Word 公式边界

- 内置转换器和第三方插件均不启用，只注册自定义 DOCX 适配器与 PDF 转换器。
- DOCX 适配器使用 Mammoth 和 MarkItDown HTML 转换器处理正文、标题、列表和表格，**不调用默认 DocxConverter 或其公式预处理**。
- 原生 Office Math 与内嵌对象只替换成待处理标记。结果保存标记 ID、原 DOCX 包中的 part 路径和零基序号，留给后续独立公式项目。
- 原始上传字节由主应用随来源保留，转换过程仅修改内存中的工作副本。图片标出待核对位置，不执行 OCR。
- 测试覆盖默认 DOCX 转换器不被调用、失败后不回退、公式标记与原文件对应关系。

## 本机启动（Windows）

从 OpenMAIC 根目录运行：

```powershell
python -m venv data/document-converter-venv
data/document-converter-venv/Scripts/python.exe -m pip install -r document-converter/requirements.lock.txt
data/document-converter-venv/Scripts/python.exe document-converter/server.py
```

默认监听 127.0.0.1:9040，Next.js 开发环境会使用这个地址。
可设置 DOCUMENT_CONVERTER_HOST、DOCUMENT_CONVERTER_PORT；Next.js 通过 DOCUMENT_CONVERTER_URL 指向其他实例。
如设置 DOCUMENT_CONVERTER_TOKEN，主应用与服务必须一致。不要把服务凭据传给浏览器。

## Docker

```sh
docker compose --env-file .env.local --profile document-import up --build
```

独立 Python 镜像运行于内部 documents 网络，不公开端口，不需要外部模型或网络访问。
主应用镜像保持 Node.js；生产环境需要明确配置 DOCUMENT_CONVERTER_URL。
Compose 通过 `--env-file .env.local` 将可选 DOCUMENT_CONVERTER_TOKEN 同时传给主应用和转换服务；本机直接启动时也需要两端使用相同令牌。

## 协议与容量

- GET /health 返回适配器版本、支持格式及公式处理状态。
- POST /convert/docx、/convert/pdf 接收 application/octet-stream 原文件字节，不接受 URL 或文件系统路径。
- 单份 8 MiB；PDF 最多80页；转换结果最多10万字符；Word 解压总量64 MiB，单个 XML 8 MiB。
- 至多两个并发转换；每次转换在独立工作进程执行，默认60秒超时并终止工作进程。
- 错误区分文件损坏、加密、需要 OCR、容量超限、繁忙和超时。混合 PDF 会指出没有提取到文字的页面。
- 不持久保存上传内容，不写文档正文、文件名或令牌日志。主应用负责身份校验、导入确认、归档及版本保存。

## 验证

```powershell
data/document-converter-venv/Scripts/python.exe -m unittest discover -s document-converter -p "test_*.py" -v
```

Node／浏览器验收仍在 tests/teacher-training 和 e2e/tests/teacher-training-documents.spec.ts。
浏览器的真实文档用例需要本服务运行，且使用独立验收数据库。
