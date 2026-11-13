import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

const fixtures = resolve('test-results/document-fixtures');
test.beforeAll(() => {
  const python =
    process.env.DOCUMENT_CONVERTER_PYTHON ||
    resolve(
      'data/document-converter-venv',
      process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
    );
  execFileSync(python, ['document-converter/create_fixtures.py', fixtures], { stdio: 'pipe' });
});

async function createProject(page: import('@playwright/test').Page) {
  await page.goto('/teacher-training');
  await expect(page.getByRole('button', { name: '新建课题', exact: true })).toBeEnabled({
    timeout: 120_000,
  });
  await page.getByRole('button', { name: '新建课题', exact: true }).click();
  await page.getByLabel('课题名称').fill('文档导入验收 · ' + Date.now());
  await page.getByLabel('学段与年级').fill('高中二年级');
  await page.getByLabel('本次教学范围').fill('椭圆标准方程与方向');
  await page.getByRole('button', { name: '创建备课' }).click();
  await expect(page.getByRole('heading', { name: '教学设计', exact: true })).toBeVisible();
  return new URL(page.url()).searchParams.get('project')!;
}

test('real DOCX preview, formula deferral, cancel, apply, source archive and historical version', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const id = await createProject(page);
  await page.getByRole('textbox', { name: '教学目标', exact: true }).fill('已有目标保持');
  const process = page.getByLabel('教学过程', { exact: true });
  await process.fill('已有讲解。');
  await page.getByRole('button', { name: '教学设计', exact: true }).click();
  await page.getByRole('button', { name: '导入教案', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '导入教案', exact: true });
  await dialog.getByLabel('教案文件').setInputFiles(resolve(fixtures, '数学教案.docx'));
  await expect(
    dialog.getByTestId('document-markdown-preview').getByRole('heading', { name: '椭圆教学设计' }),
  ).toBeVisible({ timeout: 90_000 });
  await expect(dialog.getByTestId('document-markdown-preview').getByRole('table')).toContainText(
    '教师活动',
  );
  await expect(dialog.getByLabel('文档核对提示')).toContainText('尚未执行公式转换');
  await expect(dialog.getByLabel('导入内容')).toHaveValue(/公式待处理/);
  const convertedText = await dialog.getByLabel('导入内容').inputValue();
  const markdownEvent = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '下载 Markdown', exact: true }).click();
  const markdown = await markdownEvent;
  expect(markdown.suggestedFilename()).toBe('数学教案.md');
  expect(await readFile((await markdown.path())!, 'utf8')).toBe(convertedText);
  await page.screenshot({ path: 'test-results/teacher-document-preview-desktop.png' });
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(process).toHaveValue('已有讲解。');
  await page.getByRole('button', { name: '教学设计', exact: true }).click();
  await page.getByRole('button', { name: '导入教案', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '导入教案', exact: true });
  await dialog.getByLabel('教案文件').setInputFiles(resolve(fixtures, '数学教案.docx'));
  await expect(dialog.getByRole('button', { name: '应用到草稿' })).toBeEnabled({ timeout: 90_000 });
  const originalPreview = await dialog.getByLabel('导入内容').inputValue();
  await dialog.getByLabel('导入内容').fill(originalPreview + '\n\n已核对的补充讲解。');
  await dialog.getByRole('button', { name: '应用到草稿' }).click();
  await expect(process).toHaveValue('已有讲解。\n\n' + originalPreview + '\n\n已核对的补充讲解。');
  await expect(page.getByRole('textbox', { name: '教学目标', exact: true })).toHaveValue(
    '已有目标保持',
  );
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '草稿已保存' })).toBeVisible();
  const detail = (await (await page.request.get('/api/teacher-training/projects/' + id)).json())
    .data;
  expect(detail.draft.content.sources).toHaveLength(1);
  expect(detail.draft.content.sources[0].purpose).toBe('lesson_plan');
  expect(detail.draft.content.sources[0].originalData).toMatch(/^data:/);
  expect(detail.draft.content.sources[0].conversion.deferredFormulas).toHaveLength(1);
  expect(detail.draft.content.sources[0].originalText).not.toContain('已核对的补充讲解');
  await page.reload();
  await expect(process).toHaveValue(/已核对的补充讲解。/);
  await page.getByRole('button', { name: '确认试讲版本并继续' }).click();
  await expect(page.getByRole('status').filter({ hasText: '材料版本 V1 已确认' })).toBeVisible();
  await page.getByRole('button', { name: '01 材料准备' }).click();
  await page.getByRole('button', { name: '教学设计', exact: true }).click();
  await page.getByRole('button', { name: '导入教案', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '导入教案', exact: true });
  await dialog.getByLabel('教案文件').setInputFiles(resolve(fixtures, '数学教案.docx'));
  await expect(dialog.getByRole('button', { name: '应用到草稿' })).toBeEnabled({ timeout: 90_000 });
  await dialog.getByRole('button', { name: '应用到草稿' }).click();
  await expect(dialog.getByRole('alert')).toContainText('未重复追加');
  await dialog.getByRole('radio', { name: '替换教学过程' }).check();
  await dialog.getByLabel('导入内容').fill('明确替换后的讲解。');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/teacher-document-preview-mobile.png' });
  await dialog.getByRole('button', { name: '应用到草稿' }).click();
  await expect(process).toHaveValue('明确替换后的讲解。');
  await page.getByRole('button', { name: '确认试讲版本并继续' }).click();
  await expect(page.getByRole('status').filter({ hasText: '材料版本 V2 已确认' })).toBeVisible();
  const versions = (await (await page.request.get('/api/teacher-training/projects/' + id)).json())
    .data.materials;
  expect(versions.find((v: { number: number }) => v.number === 1).content.process).toContain(
    '已核对的补充讲解',
  );
  expect(versions.find((v: { number: number }) => v.number === 2).content.sources).toHaveLength(1);
  await page.getByRole('button', { name: '01 材料准备' }).click();
  await page.getByRole('button', { name: '参考材料', exact: true }).click();
  const sources = page.getByRole('region', { name: '原始来源', exact: true });
  await sources.locator('summary').click();
  await expect(sources).toContainText('尚未执行公式转换');
  await sources.getByRole('button', { name: '查看来源内容', exact: true }).click();
  const archived = page.getByRole('dialog', { name: '查看来源文档', exact: true });
  await expect(archived.getByTestId('document-markdown-preview')).toContainText('椭圆教学设计');
  await expect(archived.getByTestId('document-markdown-preview')).not.toContainText(
    '已核对的补充讲解',
  );
  await expect(archived.getByLabel('参考正文')).toHaveCount(0);
  await archived.getByRole('button', { name: '关闭', exact: true }).click();
  const downloadEvent = page.waitForEvent('download');
  await sources.getByRole('link', { name: '下载原文件' }).click();
  expect((await downloadEvent).suggestedFilename()).toBe('数学教案.docx');
  page.once('dialog', (dialog) => dialog.dismiss());
  await sources.getByRole('button', { name: '从草稿移除来源' }).click();
  await expect(sources).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await sources.getByRole('button', { name: '从草稿移除来源' }).click();
  await expect(sources).not.toBeVisible();
  await page.getByRole('button', { name: '教学设计', exact: true }).click();
  await expect(process).toHaveValue('明确替换后的讲解。');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '草稿已保存' })).toBeVisible();
  const afterRemoval = (
    await (await page.request.get('/api/teacher-training/projects/' + id)).json()
  ).data;
  expect(afterRemoval.draft.content.sources).toHaveLength(0);
  expect(
    afterRemoval.materials.find((v: { number: number }) => v.number === 1).content.sources[0]
      .originalData,
  ).toMatch(/^data:/);
  expect(errors).toEqual([]);
});

test('real PDF reference, OCR and damaged-file errors, long text and cancelled requests retain the draft', async ({
  page,
}) => {
  const id = await createProject(page);
  const process = page.getByLabel('教学过程', { exact: true });
  await process.fill('保留已有教案。');
  await page.getByRole('button', { name: '参考材料', exact: true }).click();
  await page.getByRole('button', { name: '导入参考文档', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '导入参考文档', exact: true });
  await dialog.getByLabel('参考文档文件').setInputFiles(resolve(fixtures, '参考材料.pdf'));
  await expect(dialog.getByTestId('document-markdown-preview')).toContainText(
    'Reference lesson plan',
    { timeout: 90_000 },
  );
  await dialog.getByRole('button', { name: '加入参考材料' }).click();
  await page.getByRole('button', { name: '教学设计', exact: true }).click();
  await expect(process).toHaveValue('保留已有教案。');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '草稿已保存' })).toBeVisible();
  const saved = (await (await page.request.get('/api/teacher-training/projects/' + id)).json()).data
    .draft.content;
  expect(saved.sources[0].purpose).toBe('reference');
  expect(saved.sources[0].conversion.pages).toBe(2);
  await page.getByRole('button', { name: '确认试讲版本并继续', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '材料版本 V1 已确认' })).toBeVisible();
  await page.getByRole('button', { name: '01 材料准备' }).click();
  await page.getByRole('button', { name: '参考材料', exact: true }).click();
  const sources = page.getByRole('region', { name: '原始来源', exact: true });
  await sources.locator('summary').click();
  await sources.getByRole('button', { name: '查看来源内容', exact: true }).click();
  let archived = page.getByRole('dialog', { name: '查看来源文档', exact: true });
  const reviewed = '# 核对后的参考\n\nComparison from reviewed reference.';
  await archived.getByLabel('参考正文').fill(reviewed);
  page.once('dialog', (d) => d.dismiss());
  await archived.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(archived).toBeVisible();
  await archived.getByRole('button', { name: '应用参考修改', exact: true }).click();
  await page.getByRole('button', { name: '教学设计', exact: true }).click();
  await expect(process).toHaveValue('保留已有教案。');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '草稿已保存' })).toBeVisible();
  await page.getByRole('button', { name: '参考材料', exact: true }).click();
  await page.reload();
  await page.getByRole('region', { name: '原始来源', exact: true }).locator('summary').click();
  await page.getByRole('button', { name: '查看来源内容', exact: true }).click();
  archived = page.getByRole('dialog', { name: '查看来源文档', exact: true });
  await expect(archived.getByLabel('参考正文')).toHaveValue(reviewed);
  await page.screenshot({ path: 'test-results/teacher-saved-reference-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect
    .poll(async () => {
      const bounds = await archived.boundingBox();
      return (
        !!bounds &&
        bounds.x >= 0 &&
        bounds.x + bounds.width <= 390 &&
        bounds.y >= 0 &&
        bounds.y + bounds.height <= 844
      );
    })
    .toBe(true);
  await page.screenshot({
    path: 'test-results/teacher-saved-reference-mobile.png',
    animations: 'disabled',
  });
  const exported = page.waitForEvent('download');
  await archived.getByRole('button', { name: '下载 Markdown', exact: true }).click();
  const download = await exported;
  expect(download.suggestedFilename()).toBe('参考材料.md');
  expect(await readFile((await download.path())!, 'utf8')).toBe(reviewed);
  await archived.getByRole('button', { name: '关闭', exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 720 });
  const refreshed = (await (await page.request.get('/api/teacher-training/projects/' + id)).json())
    .data;
  expect(refreshed.draft.content.sources[0].referenceText).toBe(reviewed);
  expect(refreshed.draft.content.sources[0].originalText).toContain('Reference lesson plan');
  expect(
    refreshed.materials.find((v: { number: number }) => v.number === 1).content.sources[0]
      .referenceText,
  ).toBeUndefined();
  await page.getByRole('button', { name: '教学设计', exact: true }).click();
  await page.getByRole('button', { name: '导入教案', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '导入教案', exact: true });
  await dialog.getByLabel('教案文件').setInputFiles(resolve(fixtures, '扫描件.pdf'));
  await expect(dialog.getByRole('alert')).toContainText('OCR', { timeout: 90_000 });
  await expect(dialog.getByRole('button', { name: '应用到草稿' })).toBeDisabled();
  await dialog.getByLabel('教案文件').setInputFiles(resolve(fixtures, '损坏文件.docx'));
  await expect(dialog.getByRole('alert')).toContainText('损坏', { timeout: 90_000 });
  await dialog.getByLabel('教案文件').setInputFiles(resolve(fixtures, '超长教案.md'));
  await expect(
    dialog
      .getByTestId('document-markdown-preview')
      .getByRole('heading', { name: '长教案', exact: true }),
  ).toBeVisible();
  await expect(dialog.getByRole('button', { name: '应用到草稿' })).toBeDisabled();
  await dialog.getByLabel('导入内容').fill('# 本次选取\n\n仅导入已经核对的一小段。');
  await dialog.getByRole('button', { name: '应用到草稿' }).click();
  await expect(process).toHaveValue(/仅导入已经核对/);
  const existing = await process.inputValue();
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route('**/api/teacher-training/materials/extract', async (route) => {
    await held;
    await route.fulfill({ status: 503, json: { message: '受控取消请求' } }).catch(() => {});
  });
  await page.getByRole('button', { name: '教学设计', exact: true }).click();
  await page.getByRole('button', { name: '导入教案', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '导入教案', exact: true });
  await dialog.getByLabel('教案文件').setInputFiles(resolve(fixtures, '参考材料.pdf'));
  await expect(dialog.getByRole('status')).toContainText('正在转换');
  await dialog.getByRole('button', { name: '取消转换', exact: true }).click();
  release();
  await expect(dialog).not.toBeVisible();
  await expect(process).toHaveValue(existing);
});
