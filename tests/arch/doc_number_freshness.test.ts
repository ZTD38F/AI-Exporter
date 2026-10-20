// tests/arch/doc_number_freshness.test.ts
// Phase G (G3)：docs/architecture.md 里 Phase F 重锚的函数行为常量数字不再静默漂移。
// 代码是事实源：数字对不上时修文档（除非数字本身是 bug，此时按 bug 修代码并在 PR 说明）。
// 注意区分：文档 "600 条" 是 Google 侧边栏外部事实，代码 SLIDING_WINDOW=500 是另一回事，不得混为一谈。
export {};
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(REPO_ROOT, p), 'utf8');

test('arch: doc numbers match code constants', () => {
    const doc = read('docs/architecture.md');

    // 1. SLIDING_WINDOW（src/core/protocol/protocol.ts:110）↔ 文档"滑动窗口/水位"数字
    const proto = read('src/core/protocol/protocol.ts');
    const mWindow = proto.match(/SLIDING_WINDOW:\s*(\d+)/);
    assert.ok(mWindow, 'protocol.ts 里应能读到 SLIDING_WINDOW 常量');
    const slidingWindow = mWindow![1];
    assert.ok(
        doc.includes(`SLIDING_WINDOW = ${slidingWindow}`),
        `docs/architecture.md 必须与代码常量对齐：SLIDING_WINDOW = ${slidingWindow}`
    );

    // 2. liveSaveObserver 防抖默认毫秒数 ↔ 文档 "Nms 防抖"
    const observer = read('src/content/liveSaveObserver.ts');
    const mDebounce = observer.match(/debounceMs\s*\|\|\s*(\d+)/);
    assert.ok(mDebounce, 'liveSaveObserver.ts 里应能读到 debounce 默认毫秒数');
    const debounceMs = mDebounce![1];
    assert.ok(
        doc.includes(`${debounceMs}ms 防抖`) || doc.includes(`${debounceMs} ms 防抖`),
        `docs/architecture.md 必须与代码对齐：${debounceMs}ms 防抖冷却`
    );

    // 3. 反向保护：文档不得把 Google 外部事实 "600 条" 写成代码常量的值
    assert.ok(
        !doc.includes('SLIDING_WINDOW = 600'),
        'SLIDING_WINDOW 是代码常量 500，文档不得把它写成 Google 侧的 600'
    );

    // 4. pagination 默认 maxPages（src/core/api/client/pagination.ts:42）↔ 文档"默认最多翻 N 页"
    const pagination = read('src/core/api/client/pagination.ts');
    const mMaxPages = pagination.match(/maxPages:\s*[^=]*=\s*(\d+)/);
    assert.ok(mMaxPages, 'pagination.ts 里应能读到 maxPages 默认值');
    const maxPages = mMaxPages![1];
    assert.ok(
        doc.includes(`maxPages = ${maxPages}`),
        `docs/architecture.md 必须与代码对齐：maxPages = ${maxPages}`
    );
});
