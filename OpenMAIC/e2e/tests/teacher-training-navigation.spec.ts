import { expect, test } from '@playwright/test';

test('home, return, history and refresh preserve the teaching workflow', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page).toHaveURL(/\/teacher-training$/);
  await expect(
    page.getByRole('heading', { name: '让每一次试讲，都有进步', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '新建课题', exact: true }).click();
  await expect(page).toHaveURL(/view=new/);
  await page.getByLabel('课题名称').fill('导航验收 · 二次函数');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.goBack();
  await expect(page).toHaveURL(/view=new/);
  await expect(page.getByLabel('课题名称')).toHaveValue('导航验收 · 二次函数');
  // Clicking the current destination must not silently clear the form.
  await page.getByRole('button', { name: '新建课题', exact: true }).click();
  await expect(page.getByLabel('课题名称')).toHaveValue('导航验收 · 二次函数');
  await page.getByLabel('学段与年级').fill('初中三年级');
  await page.getByLabel('本次教学范围').fill('顶点与对称轴');
  await page.getByRole('button', { name: '创建备课' }).click();
  await expect(page).toHaveURL(/project=.+&tab=preparation$/);
  const projectUrl = page.url();
  const process = page.getByRole('textbox', { name: '教学过程', exact: true });
  await process.fill('保留这段尚未保存的教案。');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: '返回备课与历史' }).click();
  await expect(page).toHaveURL(projectUrl);
  await expect(process).toHaveValue('保留这段尚未保存的教案。');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.goBack();
  await expect(page).toHaveURL(projectUrl);
  await expect(process).toHaveValue('保留这段尚未保存的教案。');

  // Same-project tabs retain the editor, and cancellation must preserve the
  // forward history rather than creating duplicate entries.
  await page.getByRole('button', { name: '02 班级配置' }).click();
  await expect(page).toHaveURL(/tab=class$/);
  await page.goBack();
  await expect(process).toHaveValue('保留这段尚未保存的教案。');
  await page.goForward();
  await expect(page.getByRole('heading', { name: '选择本轮材料' })).toBeVisible();
  await page.goBack();
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '草稿已保存' })).toBeVisible();
  await page.getByRole('button', { name: '返回备课与历史' }).click();
  await expect(
    page.getByRole('heading', { name: '让每一次试讲，都有进步', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '继续备课', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/teacher-training-home-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/teacher-training-home-mobile.png', fullPage: true });
  await page.goto(projectUrl);
  await expect(process).toHaveValue('保留这段尚未保存的教案。');
  await page.getByRole('button', { name: '02 班级配置' }).click();
  await page.reload();
  await expect(page.getByRole('heading', { name: '选择本轮材料' })).toBeVisible();
  await page.getByRole('button', { name: '01 材料准备' }).click();
  await process.fill('用户明确放弃的修改');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '返回备课与历史' }).click();
  await page.getByRole('button', { name: '继续备课', exact: true }).click();
  await expect(process).toHaveValue('保留这段尚未保存的教案。');
  expect(errors).toEqual([]);
});

test('legacy learning entry stays separate and links back to teacher training', async ({
  page,
}) => {
  await page.goto('/legacy/openmaic');
  await expect(
    page.getByRole('img', { name: '多智能体课堂模拟与教学评测系统', exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: '教师训练 · 备课与试讲' }).click({ timeout: 120_000 });
  await expect(
    page.getByRole('heading', { name: '让每一次试讲，都有进步', exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/teacher-training$/);
});
