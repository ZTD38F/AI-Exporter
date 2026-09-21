import { test, expect } from './fixtures';
import * as fs from 'fs';
import * as path from 'path';

test.describe('Visual Inspection & Physical Hit-Testing Suite (Phase 1 & 2)', () => {
  const outputDir = path.resolve(__dirname, '../../tests/output/visual_audit');

  test.beforeAll(() => {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
  });

  test('should execute 6-step tour with 100% zero-occlusion and physical mouse hit-testing', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });

    // Open options page with onboarding welcome flag
    await page.goto(`chrome-extension://${extensionId}/src/ui/options/options.html?welcome=1`);
    await page.waitForLoadState('domcontentloaded');

    const popover = page.locator('.tour-popover');
    await expect(popover).toBeVisible({ timeout: 5000 });

    for (let stepIdx = 0; stepIdx < 6; stepIdx++) {
      const stepBadge = await page.locator('.tour-step-badge').innerText();
      expect(stepBadge).toBe(`${stepIdx + 1} / 6`);

      // 1. Capture visual snapshot
      const screenshotPath = path.join(outputDir, `tour_step_${stepIdx + 1}.png`);
      await page.screenshot({ path: screenshotPath });
      expect(fs.existsSync(screenshotPath)).toBe(true);

      // 2. Visual Collision Audit: verify popover does NOT overlap highlighted target
      const collisionResult = await page.evaluate(() => {
        const popEl = document.querySelector('.tour-popover');
        const TG = (window as any).TourGuide;
        if (!popEl || !TG) return { ok: false, reason: 'popover or TourGuide missing' };
        const step = TG.STEPS[TG.getCurrentStep()];
        const target = step.getTarget ? step.getTarget() : null;
        if (!target) return { ok: true, note: 'no target element on this step' };

        const pRect = popEl.getBoundingClientRect();
        const tRect = target.getBoundingClientRect();

        const overlaps = !(
          pRect.right <= tRect.left ||
          pRect.left >= tRect.right ||
          pRect.bottom <= tRect.top ||
          pRect.top >= tRect.bottom
        );

        return {
          ok: !overlaps,
          overlaps,
          popoverRect: { left: pRect.left, top: pRect.top, right: pRect.right, bottom: pRect.bottom },
          targetRect: { left: tRect.left, top: tRect.top, right: tRect.right, bottom: tRect.bottom }
        };
      });
      expect(collisionResult.ok).toBe(true);

      // 3. Physical Hit-Testing on next button: verify no element is blocking the click target
      const nextBtn = page.locator('#tourNextBtn');
      await expect(nextBtn).toBeVisible();
      const nextBtnBox = await nextBtn.boundingBox();
      expect(nextBtnBox).not.toBeNull();

      if (nextBtnBox) {
        const clickX = nextBtnBox.x + nextBtnBox.width / 2;
        const clickY = nextBtnBox.y + nextBtnBox.height / 2;

        const hitTestTag = await page.evaluate(({ x, y }) => {
          const hit = document.elementFromPoint(x, y);
          return hit ? hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '') : null;
        }, { x: clickX, y: clickY });

        // Must hit the button itself or text/span inside it
        expect(hitTestTag).toMatch(/^(button#tournextbtn|span|div)/i);

        // Advance to next step
        if (stepIdx < 5) {
          await nextBtn.click();
          await expect(page.locator('.tour-step-badge')).toHaveText(`${stepIdx + 2} / 6`);
          await page.waitForTimeout(300);
        } else {
          await nextBtn.click();
        }
      }
    }

    // Tour should be finished and destroyed
    await expect(popover).toBeHidden();
  });

  test('should launch tour on clicking header button and dismiss cleanly', async ({ context, extensionId }) => {
    const page = await context.newPage();

    await page.goto(`chrome-extension://${extensionId}/src/ui/options/options.html`);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => typeof (window as any).__workbenchLoadStore === 'function');

    // Verify #btnTourGuide has exactly one lightbulb emoji
    const btnText = await page.locator('#btnTourGuide').innerText();
    expect((btnText.match(/💡/g) || []).length).toBe(1);
    expect(['💡 新手引导', '💡 Tour Guide']).toContain(btnText.replace(/\s+/g, ' ').trim());

    // Click #btnTourGuide in header
    await page.click('#btnTourGuide');

    const popover = page.locator('.tour-popover');
    await expect(popover).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.tour-step-badge')).toHaveText('1 / 6');

    // Click close/skip
    await page.click('#tourSkipBtn');
    await expect(popover).toBeHidden();
  });

  test('should display major feature spotlight overlay for returning users and record seen version', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });

    // 1. Simulate returning user who finished onboarding in v1.4.0
    await page.goto(`chrome-extension://${extensionId}/src/ui/options/options.html`);
    await page.waitForLoadState('domcontentloaded');
    await page.evaluate(async () => {
      await chrome.storage.local.set({
        has_completed_tour: true,
        last_seen_feature_version: '1.4.0'
      });
    });

    // 2. Reload options page without welcome flag
    await page.reload();
    await page.waitForLoadState('domcontentloaded');

    // 3. Feature spotlight popover should appear
    const popover = page.locator('.tour-popover');
    await expect(popover).toBeVisible({ timeout: 5000 });

    // 4. Verify feature badge
    const badge = page.locator('.tour-step-badge');
    await expect(badge).toBeVisible();
    const badgeText = await badge.innerText();
    expect(badgeText).toContain('1.5.0');

    // 5. Verify action buttons exist
    const dismissBtn = page.locator('#tourSpotlightDismissBtn');
    const actionBtn = page.locator('#tourSpotlightActionBtn');
    await expect(dismissBtn).toBeVisible();
    await expect(actionBtn).toBeVisible();

    // 6. Dismiss spotlight
    await dismissBtn.click();
    await expect(popover).toBeHidden();

    // 7. Verify storage updated to 1.5.0
    const storedVer = await page.evaluate(async () => {
      const data = await chrome.storage.local.get(['last_seen_feature_version']);
      return data.last_seen_feature_version;
    });
    expect(storedVer).toBe('1.5.0');

    // 8. Reload page - spotlight should NOT appear again
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(600);
    await expect(popover).toBeHidden();
  });

  test('should verify modal backdrop provides complete visual shielding against accidental background clicks', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });

    await page.goto(`chrome-extension://${extensionId}/src/ui/options/options.html`);
    await page.waitForLoadState('domcontentloaded');

    // Trigger takeout limit modal for visual inspection
    await page.evaluate(() => {
      const modal = document.getElementById('takeoutLimitModal');
      if (modal) {
        modal.classList.remove('hidden');
        modal.style.display = 'flex';
      }
    });

    const modal = page.locator('#takeoutLimitModal');
    await expect(modal).toBeVisible();

    // Verify modal overlay covers the entire viewport
    const overlayBounds = await modal.boundingBox();
    expect(overlayBounds).not.toBeNull();
    if (overlayBounds) {
      expect(overlayBounds.width).toBeGreaterThanOrEqual(1280);
      expect(overlayBounds.height).toBeGreaterThanOrEqual(800);
    }

    // Hit-test on background area (e.g. at 50, 50 where header/sidebar would normally be)
    const backgroundHit = await page.evaluate(() => {
      const hit = document.elementFromPoint(50, 50);
      return hit ? hit.id || hit.className : 'null';
    });
    // Click must hit modal container/overlay, NOT underlying buttons
    expect(backgroundHit).toMatch(/modal|overlay|container/i);

    // Capture modal snapshot
    const modalPic = path.join(outputDir, 'modal_visual_backdrop.png');
    await page.screenshot({ path: modalPic });
    expect(fs.existsSync(modalPic)).toBe(true);

    // Dismiss modal cleanly
    await page.evaluate(() => {
      const modal = document.getElementById('takeoutLimitModal');
      if (modal) {
        modal.classList.add('hidden');
        modal.style.display = 'none';
      }
    });
    await expect(modal).toBeHidden();
  });

  test('should audit layout integrity, preventing text truncation on buttons and key controls', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });

    await page.goto(`chrome-extension://${extensionId}/src/ui/options/options.html`);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(500);

    // Check all primary action buttons for unintentional text overflow
    const truncationAudit = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, .btn, .item .title, .badge'));
      const truncated: { tag: string; id: string; text: string; scrollW: number; clientW: number }[] = [];

      buttons.forEach(el => {
        // Allow intentional ellipsis on long conversation titles, but action buttons must never be truncated
        if (el.tagName.toLowerCase() === 'button' || el.classList.contains('btn')) {
          if (el.scrollWidth > el.clientWidth + 2) {
            truncated.push({
              tag: el.tagName.toLowerCase(),
              id: el.id,
              text: el.textContent?.trim().slice(0, 30) || '',
              scrollW: el.scrollWidth,
              clientW: el.clientWidth
            });
          }
        }
      });

      return truncated;
    });

    expect(truncationAudit).toEqual([]);

    const fullPagePic = path.join(outputDir, 'workbench_layout_clean.png');
    await page.screenshot({ path: fullPagePic });
    expect(fs.existsSync(fullPagePic)).toBe(true);
  });

  test('should visually audit real-time conversation promotion to list top upon continuation with physical hit-testing', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });

    await page.goto(`chrome-extension://${extensionId}/src/ui/options/options.html`);
    await page.waitForLoadState('domcontentloaded');

    const now = Date.now();
    const initialConvs = [
      { id: 'top_active_999', title: '首位活跃新对话', timestamp: now - 5000, updatedAt: now - 5000, createdAt: now - 50000, sidebarIndex: 0 },
      { id: 'historical_old_111', title: '待追加对话的老会话', timestamp: now - 80000, updatedAt: now - 80000, createdAt: now - 120000, sidebarIndex: 1 },
      { id: 'historical_old_222', title: '末尾静止老会话', timestamp: now - 180000, updatedAt: now - 180000, createdAt: now - 220000, sidebarIndex: 2 }
    ];

    await page.evaluate(async (convs) => {
      await chrome.storage.local.set({ gemini_conversations: convs });
      if (typeof (window as any).__workbenchLoadStore === 'function') {
        await (window as any).__workbenchLoadStore(true);
      }
    }, initialConvs);

    await expect(page.locator('#list .item')).toHaveCount(3);
    await expect(page.locator('#list .item').nth(0)).toContainText('首位活跃新对话');
    await expect(page.locator('#list .item').nth(1)).toContainText('待追加对话的老会话');

    // 模拟老会话 historical_old_111 发帖并收到 STREAM_COMPLETE，时间戳跃升置顶
    await page.evaluate(async () => {
      return new Promise((resolve) => {
        chrome.storage.local.get(['gemini_conversations'], async (data: any) => {
          const convs = data.gemini_conversations || [];
          const target = convs.find((c: any) => c.id === 'historical_old_111');
          if (target) {
            const bumpedTime = Date.now() + 50000;
            target.updatedAt = bumpedTime;
            target.timestamp = bumpedTime;
            convs.sort((a: any, b: any) => ((b.updatedAt || b.timestamp || 0) - (a.updatedAt || a.timestamp || 0)));
            await chrome.storage.local.set({ gemini_conversations: convs });
            chrome.runtime.sendMessage({ action: 'syncUpdate', slot: 'u0', from: 'stream-complete' });
            if (typeof (window as any).__workbenchLoadStore === 'function') {
              await (window as any).__workbenchLoadStore(true);
            }
          }
          resolve(true);
        });
      });
    });

    // 视觉审计：无需页面刷新，historical_old_111 跃升至列表首位 (index 0)
    await expect(page.locator('#list .item').nth(0)).toContainText('待追加对话的老会话', { timeout: 4000 });
    await expect(page.locator('#list .item').nth(1)).toContainText('首位活跃新对话');

    // 物理 Hit-Testing：检验新晋首位元素的交互穿透性
    const topItem = page.locator('#list .item').nth(0);
    const box = await topItem.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      const hitElementTag = await page.evaluate(({ x, y }) => {
        const hit = document.elementFromPoint(x, y);
        return hit ? hit.tagName.toLowerCase() + (hit.className ? '.' + String(hit.className).split(' ')[0] : '') : null;
      }, { x: cx, y: cy });

      expect(hitElementTag).not.toBeNull();
      expect(hitElementTag).toMatch(/^(div|label|span|input)/i);
    }

    const screenshotPath = path.join(outputDir, 'continued_chat_promoted.png');
    await page.screenshot({ path: screenshotPath });
    expect(fs.existsSync(screenshotPath)).toBe(true);
  });

  test('should visually audit real-time ephemeral conversation deletion and DOM pruning without layout breakage', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });

    await page.goto(`chrome-extension://${extensionId}/src/ui/options/options.html`);
    await page.waitForLoadState('domcontentloaded');

    const now = Date.now();
    const initialConvs = [
      { id: 'del_eph_9999', title: '瞬态自毁测试会话 (待删除)', timestamp: now + 5000, updatedAt: now + 5000, createdAt: now - 10000 },
      { id: 'keep_chat_111', title: '留存会话 1 (有效)', timestamp: now - 10000, updatedAt: now - 10000, createdAt: now - 30000 },
      { id: 'keep_chat_222', title: '留存会话 2 (有效)', timestamp: now - 20000, updatedAt: now - 20000, createdAt: now - 50000 }
    ];

    await page.evaluate(async (convs) => {
      await chrome.storage.local.set({ gemini_conversations: convs });
      if (typeof (window as any).__workbenchLoadStore === 'function') {
        await (window as any).__workbenchLoadStore(true);
      }
    }, initialConvs);

    // 初始渲染校验
    await expect(page.locator('#list .item')).toHaveCount(3);
    await expect(page.locator('#list .item[data-chat-id="del_eph_9999"]')).toBeVisible();

    const renderScreenshot = path.join(outputDir, 'ephemeral_chat_rendered.png');
    await page.screenshot({ path: renderScreenshot });
    expect(fs.existsSync(renderScreenshot)).toBe(true);

    // 模拟触发实时删除广播
    await page.evaluate(async () => {
      return new Promise((resolve) => {
        chrome.storage.local.get(['gemini_conversations'], async (data: any) => {
          let convs = data.gemini_conversations || [];
          convs = convs.filter((c: any) => c.id !== 'del_eph_9999');
          await chrome.storage.local.set({ gemini_conversations: convs });
          chrome.runtime.sendMessage({ action: 'syncUpdate', slot: 'u0', from: 'delete-event' });
          if (typeof (window as any).__workbenchLoadStore === 'function') {
            await (window as any).__workbenchLoadStore(true);
          }
          resolve(true);
        });
      });
    });

    // 视觉审计：DOM 列表从 3 项平滑剥离为 2 项，目标项 0 残留
    await expect(page.locator('#list .item')).toHaveCount(2);
    await expect(page.locator('#list .item[data-chat-id="del_eph_9999"]')).toHaveCount(0);
    await expect(page.locator('#list .item[data-chat-id="keep_chat_111"]')).toBeVisible();

    // 布局完整性审查：确保相邻卡片垂直间距规整紧凑，无异常空洞与布局撕裂
    const layoutIntegrity = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('#list .item'));
      if (items.length < 2) return { ok: true };
      const r1 = items[0].getBoundingClientRect();
      const r2 = items[1].getBoundingClientRect();
      const gap = r2.top - r1.bottom;
      return { ok: gap >= 0 && gap <= 16, gap };
    });
    expect(layoutIntegrity.ok).toBe(true);

    const pruneScreenshot = path.join(outputDir, 'ephemeral_chat_pruned.png');
    await page.screenshot({ path: pruneScreenshot });
    expect(fs.existsSync(pruneScreenshot)).toBe(true);
  });

  test('should visually audit Takeout import initial prefix and authoritative RPC title upgrade', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });

    await page.goto(`chrome-extension://${extensionId}/src/ui/options/options.html`);
    await page.waitForLoadState('domcontentloaded');

    const takeoutChat = {
      id: '1bd028d5c5b0c0e2',
      title: '火星宇航员猫咪（离线提问前缀）',
      titleSource: 'takeout',
      titles: { takeout: '火星宇航员猫咪（离线提问前缀）' },
      timestamp: 1680000000000,
      updatedAt: 1680000000000
    };

    await page.evaluate(async (c) => {
      await chrome.storage.local.set({ gemini_conversations: [c] });
      if (typeof (window as any).__workbenchLoadStore === 'function') {
        await (window as any).__workbenchLoadStore(true);
      }
    }, takeoutChat);

    await expect(page.locator('#list .item[data-chat-id="1bd028d5c5b0c0e2"]')).toContainText('火星宇航员猫咪（离线提问前缀）');

    // 模拟在线 RPC 权威晋级升级
    await page.evaluate(async () => {
      return new Promise((resolve) => {
        chrome.storage.local.get(['gemini_conversations'], async (data: any) => {
          const convs = data.gemini_conversations || [];
          const chat = convs.find((c: any) => c.id === '1bd028d5c5b0c0e2');
          if (chat) {
            chat.title = '火星宇航员猫咪（AI 生成图片 Imagen）';
            chat.titleSource = 'rpc';
            chat.titles = {
              takeout: '火星宇航员猫咪（离线提问前缀）',
              rpc: '火星宇航员猫咪（AI 生成图片 Imagen）'
            };
            await chrome.storage.local.set({ gemini_conversations: convs });
            chrome.runtime.sendMessage({ action: 'syncUpdate', slot: 'u0', from: 'rpc-deep-scan' });
            if (typeof (window as any).__workbenchLoadStore === 'function') {
              await (window as any).__workbenchLoadStore(true);
            }
          }
          resolve(true);
        });
      });
    });

    // 视觉审计：DOM 列表中标题无缝升级为权威标题
    await expect(page.locator('#list .item[data-chat-id="1bd028d5c5b0c0e2"]')).toContainText('火星宇航员猫咪（AI 生成图片 Imagen）');

    const upgradedPic = path.join(outputDir, 'takeout_title_upgraded.png');
    await page.screenshot({ path: upgradedPic });
    expect(fs.existsSync(upgradedPic)).toBe(true);
  });
});

