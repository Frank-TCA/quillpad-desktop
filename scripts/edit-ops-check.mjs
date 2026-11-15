/** 编辑类命令的功能回归测试 */
import { chromium } from 'playwright-core';

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
};

const content = () => page.locator('.cm-content').first().innerText();
const reset = async (text) => {
  await page.locator('.cm-content').first().click();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await page.keyboard.type(text);
  // 光标统一回到文档开头，保证后续「当前行」类断言是确定的
  await page.keyboard.press('Control+Home');
  await page.waitForTimeout(150);
};

// 复制行 Ctrl+D
await reset('alpha\nbeta');
await page.keyboard.press('Control+d');
await page.waitForTimeout(200);
let t = await content();
check('Ctrl+D 复制当前行', t.split('\n').length === 3 && t.includes('alpha\nalpha'), JSON.stringify(t));

// 删除行 Ctrl+Shift+K（重新填入两行，光标在第 1 行再删）
await reset('alpha\nbeta');
await page.keyboard.press('Control+Shift+k');
await page.waitForTimeout(200);
t = await content();
check('Ctrl+Shift+K 删除当前行', !t.includes('alpha') && t.includes('beta'), JSON.stringify(t));

// 下移行 Alt+ArrowDown
await reset('one\ntwo');
await page.keyboard.press('Alt+ArrowDown');
await page.waitForTimeout(200);
t = await content();
check('Alt+↓ 下移一行', t.startsWith('two\none'), JSON.stringify(t));

// 注释切换 Ctrl+/（先切到 JavaScript，Markdown 的注释语法是 <!-- -->）
await page.evaluate(() => window.quillpad.setLanguage('javascript'));
await page.waitForTimeout(300);
await reset('const a = 1;');
await page.keyboard.press('Control+/');
await page.waitForTimeout(200);
t = await content();
check('Ctrl+/ 注释切换', t.includes('//'), JSON.stringify(t));

// 大写转换（编辑菜单 → 大小写 → 转换为大写）
/**
 * 按 label 精确匹配一个菜单项的 locator。
 *
 * 这里刻意用 locator 而不是 `page.$$`（ElementHandle 数组）：面板每次开合都会
 * 重建节点，旧的 ElementHandle 随即失效；locator 每轮重新查询 DOM，天然抗重建。
 *
 * @param {string} label 菜单项文字（精确匹配，避免「大小写」误中「转换为大写」）
 * @return {import('playwright-core').Locator}
 */
const menuItem = (label) => page.locator(`.dropdown__item:has(.dropdown__item-label:text-is("${label}"))`);

/**
 * 等菜单项出现并点它 —— 等条件，不猜时间。
 *
 * @param {string} label 菜单项文字
 * @param {number} [timeout] 等待上限（毫秒）
 * @return {Promise<boolean>} 是否点中并执行
 */
const clickMenuItem = async (label, timeout = 1500) => {
  const item = menuItem(label).first();
  try {
    await item.waitFor({ state: 'visible', timeout });
  } catch {
    return false;
  }
  await item.click();
  // 等菜单彻底收起来再读编辑器，避免读到「面板还盖着」的中间态
  await page
    .waitForFunction(() => !document.querySelector('.dropdown'), null, { timeout: 3000 })
    .catch(() => {});
  return true;
};

/**
 * 关掉所有可能残留的浮层（先关子菜单，再关根菜单）。
 * @return {Promise<void>}
 */
const closeFloatingMenus = async () => {
  // 子菜单是独立面板：一次 Escape 只关最内层，按两次保险
  for (let i = 0; i < 2; i += 1) {
    await page.keyboard.press('Escape').catch(() => {});
  }
  await page
    .waitForFunction(() => !document.querySelector('.dropdown'), null, { timeout: 2000 })
    .catch(() => {});
};

/**
 * 单次尝试：打开菜单 → 试平级项 → 逐个 hover 带子菜单的父项。
 * @param {string} menuLabel 菜单栏标题
 * @param {string} itemText 目标项文字
 * @return {Promise<string|null>} 命中返回目标文字，未命中返回 null
 */
const menuPickOnce = async (menuLabel, itemText) => {
  await page.click(`.menubar__item:has-text("${menuLabel}")`);
  try {
    // 等根面板真的出现，替代固定延时
    await page.locator('.dropdown__item').first().waitFor({ state: 'visible', timeout: 5000 });
  } catch {
    return null;
  }
  // 先试平级项。超时给足 1500ms（与子菜单同级），别用短超时：自动化里 hover 触发的
  // 子面板重渲染会替换平级节点，短超时会在 app 完全正常时误判「平级项不存在」。
  if (await clickMenuItem(itemText, 1500)) return itemText;
  // 再逐个 hover 带子菜单的父项，等目标项在新面板里出现
  const parents = page.locator('.dropdown__item--has-sub');
  const count = await parents.count();
  for (let i = 0; i < count; i += 1) {
    try {
      await parents.nth(i).hover();
    } catch {
      continue; // 父项正在被上一轮 hover 重建，跳过这一个
    }
    if (await clickMenuItem(itemText)) return itemText;
  }
  // 没命中：把当前面板里所有项的文本 + 索引一次性抓出来打日志，方便判断
  // 是「脚本没点对」还是「产品侧真的缺这一项」
  const snapshot = await page
    .evaluate(() =>
      [...document.querySelectorAll('.dropdown__item')].map((n, i) => ({
        i,
        sub: n.classList.contains('dropdown__item--has-sub'),
        text: (n.textContent || '').replace(/\s+/g, ' ').trim(),
      })),
    )
    .catch(() => []);
  console.log(`  ! ${menuLabel} 面板里没有「${itemText}」，当前项：${JSON.stringify(snapshot)}`);
  return null;
};

/**
 * 打开菜单并选一项，支持二级子菜单，失败按次数重试。
 *
 * 「编辑 → 大小写 → 转换为大写」里，`大小写` 是 hover 展开的二级菜单项
 * （`.dropdown__item--has-sub`，展开后是独立的嵌套面板），子菜单项在展开前
 * 不在 DOM 里 —— 只扫平级 `.dropdown__item` 会恒返回 null。
 *
 * 这里踩过两个坑，都别再犯：
 *   ① 子菜单项没展开就不在 DOM，必须 hover 父项；
 *   ② 用固定 `waitForTimeout(300)` 猜面板渲染、再用一把 `page.$$` 快照抓节点：
 *      面板开合会重建节点，ElementHandle 随即失效，机器忙时容易抓空（本机 6 CPU
 *      满载 + 3 路并发下复现过），且抓空异常会被 `continue` 静默吞掉。
 *      现已全部换成条件等待（locator + `waitFor`），并在外层加最多 3 次重试：
 *      失败先 Escape 关干净浮层、再重新点菜单栏 —— 不靠加长 sleep，也不一失败就放弃。
 *
 * @param {string} menuLabel 菜单栏标题
 * @param {string} itemText 目标项文字
 * @param {number} [attempts] 最多尝试次数
 * @return {Promise<string|null>} 命中项的文字，未命中返回 null
 */
const menuPick = async (menuLabel, itemText, attempts = 3) => {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) {
      await closeFloatingMenus();
      console.log(`  · ${menuLabel}/${itemText} 未选中，第 ${attempt} 次尝试`);
    }
    const hit = await menuPickOnce(menuLabel, itemText);
    if (hit) return hit;
  }
  console.log(`  ! 未找到 ${menuLabel}/${itemText}（已重试 ${attempts} 次）`);
  await closeFloatingMenus();
  return null;
};

await reset('hello');
const picked = await menuPick('编辑', '转换为大写');
t = await content();
check('菜单→转成大写', t.includes('HELLO'), `picked=${picked} text=${JSON.stringify(t)}`);

// 在文件中查找：输入关键词看结果
await page.keyboard.press('Control+Shift+F');
await page.waitForTimeout(500);
await page.keyboard.type('hello');
await page.waitForTimeout(600);
const findInfo = await page.evaluate(() => {
  const panel = document.querySelector('.find-files');
  const groups = panel?.querySelectorAll('.find-files__group')?.length ?? 0;
  const summary = panel?.querySelector('[data-role=summary]')?.textContent ?? '';
  return { groups, summary };
});
check('在文件中查找出结果', findInfo.groups > 0 || /[1-9]/.test(findInfo.summary), JSON.stringify(findInfo));
await page.screenshot({ path: 'shots/qa-findfiles-result.png' });

console.log('\nconsole 错误:', errors.length ? errors.join('\n') : '(无)');
const failed = results.filter((r) => !r.ok);
console.log(`通过 ${results.length - failed.length}/${results.length}`);
await browser.close();

// 有失败就以非零码退出：否则「打印 5/6 但退出码 0」会让 npm test / CI 永远绿。
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ' :: ' + f.detail : ''}`);
  process.exitCode = 1;
}
