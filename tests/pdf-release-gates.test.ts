/**
 * tests/pdf-release-gates.test.ts
 * §16 P0 release-blocker gates: formula-as-text + Chinese lossless at the
 * Typst payload level (Tier 1, runs before build.js — no dist/ dependency).
 *
 * P0 formal experiment结论 (goals/gemini-exporter/hidden_files/p0-formal/REPORT.md):
 *  - 公式必须为可选文本，绝不是图片 (pypdf 提取到 𝑥/Δ/±/√ 等真实字形, 嵌入图片数=0)
 *  - 中文 2000+ 字零丢失
 *  - 转换失败的公式必须可见 (原文回退), 不静默丢
 *
 * These tests pin those invariants at the toTypstPayload boundary: if the
 * adapter ever turns math into an image placeholder, mangles Chinese text,
 * or silently drops an unconvertible formula, the gate fails.
 *
 * 已知缺口 (生产逻辑, 本测试不覆盖、留给 P1a/F2 完整转换器):
 *  payload.ts 对 convertMath 失败当前只做原文回退, 不发射 diagnostic。
 *  本测试锁定"原文回退可见"这一现有保证; 加 diagnostic 属 src/ 生产逻辑
 *  改动, 不在本 PR 地盘内。
 */
export {};
const test = require('node:test');
const assert = require('node:assert');

const { toTypstPayload } = require('../src/core/export/typst/payload.js');

// ------------------------------------------------------------------ fixtures

/** 千字文 + 常用符号/数字/希腊字母, 单份 ~1100 字; 重复两次 > 2000 字。 */
const ZH_UNIT =
    '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥天地玄黄宇宙洪荒日月盈昃' +
    '辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出' +
    '昆冈剑号巨阙珠称夜光果珍李柰菜重芥姜海咸河淡鳞潜羽翔龙师火帝鸟官人皇' +
    '始制文字乃服衣裳推位让国有虞陶唐吊民伐罪周发殷汤坐朝问道垂拱平章爱育' +
    '黎首臣伏戎羌遐迩一体率宾归王鸣凤在竹白驹食场化被草木赖及万方盖此身发' +
    '四大五常恭惟鞠养岂敢毁伤女慕贞洁男效才良知过必改得能莫忘罔谈彼短靡恃' +
    '己长信使可覆器欲难量墨悲丝染诗赞羔羊景行维贤克念作圣德建名立形端表正' +
    '空谷传声虚堂习听祸因恶积福缘善庆尺璧非宝寸阴是竞资父事君曰严与敬孝当' +
    '竭力忠则尽命临深履薄夙兴温凊似兰斯馨如松之盛川流不息渊澄取映容止若思' +
    '言辞安定笃初诚美慎终宜令荣业所基籍甚无竟学优登仕摄职从政存以甘棠去而' +
    '益咏乐殊贵贱礼别尊卑上和下睦夫唱妇随外受傅训入奉母仪诸姑伯叔犹子比儿' +
    '孔怀兄弟同气连枝交友投分切磨箴规仁慈隐恻造次弗离节义廉退颠沛匪亏性静' +
    '情逸心动神疲守真志满逐物意移坚持雅操好爵自縻都邑华夏东西二京背邙面洛' +
    '浮渭据泾宫殿盘郁楼观飞惊图写禽兽画彩仙灵丙舍旁启甲帐对楹肆筵设席鼓瑟' +
    '吹笙升阶纳陛弁转疑星右通广内左达承明既集坟典亦聚群英杜稿钟文漆书壁经' +
    '府罗将相路侠槐卿户封八县家给千兵高冠陪辇驱毂振缨世禄侈富车驾肥轻策功' +
    '茂实勒碑刻铭磻溪伊尹佐时阿衡奄宅曲阜微旦孰营桓公匡合济弱扶倾绮回汉惠' +
    '说感武丁俊乂密勿多士实宁晋楚更霸赵魏困横假途灭虢践土会盟何遵约法韩弊' +
    '烦刑起翦颇牧用军最精宣威沙漠驰誉丹青九州禹迹百郡秦并岳宗泰岱禅主云亭' +
    '雁门紫塞鸡田赤城昆池碣石巨野洞庭旷远绵邈岩岫杳冥治本于农务兹稼穑俶载' +
    '南亩我艺黍稷税熟贡新劝赏黜陟孟轲敦素史鱼秉直庶几中庸劳谦谨敕聆音察理' +
    '鉴貌辨色贻厥嘉猷勉其祗植省躬讥诫宠增抗极殆辱近耻林皋幸即两疏见机解组' +
    '谁逼索居闲处沉默寂寥求古寻论散虑逍遥欣奏累遣戚谢欢招渠荷的历园莽抽条' +
    '枇杷晚翠梧桐蚤凋陈根委翳落叶飘摇游鹍独运凌摩绛霄耽读玩市寓目囊箱易輶' +
    '攸畏属耳垣墙具膳餐饭适口充肠饱饫烹宰饥厌糟糠亲戚故旧老少异粮妾御绩纺' +
    '侍巾帷房纨扇圆洁银烛炜煌昼眠夕寐蓝笋象床弦歌酒宴接杯举觞矫手顿足悦豫' +
    '且康嫡后嗣续祭祀烝尝稽颡再拜悚惧恐惶笺牒简要顾答审详骸垢想浴执热愿凉' +
    '驴骡犊特骇跃超骧诛斩贼盗捕获奸宄满招损谦受益时中 1234567890 ' +
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz ' +
    '零一二三四五六七八九十百千万亿兆 π≈3.14159265358979 e≈2.71828182845905 ' +
    'αβγδεζηθικλμνξοπρστυφχψω ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ ' +
    '∂∇∫∑∏√±×÷∞∠∴∵∽≈≠≡≤≥∈∀∃∅△□○◇☆★';

/** > 2000 字的混合中英数长文本, 确定性构造。 */
const ZH_LONG = `${ZH_UNIT}‖${ZH_UNIT}`;
assert.ok(ZH_LONG.length > 2000, `fixture must exceed 2000 chars, got ${ZH_LONG.length}`);

const INLINE_LATEX = 'E = mc^2';
const DISPLAY_LATEX_OK = '\\frac{a}{b} + \\sqrt{x}';
/** P0 报告同款故意不可转换公式: mathshim 子集拒收 operatormame。 */
const DISPLAY_LATEX_UNCONVERTIBLE = '\\operatorname{erf}(x) = \\frac{2}{\\sqrt{\\pi}}\\int_0^x e^{-t^2}\\,dt';

/**
 * 最小受控转换器 (模拟 P0 实验 mathshim): 只认 frac/sqrt 子集,
 * 其余返回 undefined -> adapter 走原文回退。
 */
function fakeConvertMath(source: string, _display: boolean): string | undefined {
    if (source.includes('\\operatorname')) return undefined;
    if (source.includes('\\frac') || source.includes('\\sqrt')) return `TYPST(${source})`;
    if (/^[A-Za-z0-9 =^+_\-{}]+$/.test(source)) return `TYPST(${source})`;
    return undefined;
}

function bundle(messages: any[]) {
    return {
        schemaVersion: 1,
        conversation: {
            key: { providerId: 'gemini', accountId: 'test-account', conversationId: 'gates-1' },
            title: 'P0 门禁回归',
            createdAt: '2026-09-26T00:00:00Z',
            messages,
        },
        assets: [],
        citations: [],
    };
}

function msg(id: string, role: string, blocks: any[]) {
    return { id, role, blocks };
}

const opts = { assetPath: (_a: any) => undefined, convertMath: fakeConvertMath };

function gatesBundle() {
    const mid = Math.floor(ZH_LONG.length / 2);
    const zhHead = ZH_LONG.slice(0, mid);
    const zhTail = ZH_LONG.slice(mid);
    return bundle([
        msg('m1', 'user', [
            { type: 'heading', level: 2, children: [{ type: 'text', text: '中文长文本完整性验证' }] },
            {
                type: 'paragraph',
                children: [
                    { type: 'text', text: zhHead },
                    { type: 'inlineMath', source: INLINE_LATEX },
                    { type: 'text', text: zhTail },
                ],
            },
        ]),
        msg('m2', 'assistant', [
            { type: 'math', source: DISPLAY_LATEX_OK },
            { type: 'math', source: DISPLAY_LATEX_UNCONVERTIBLE },
            { type: 'paragraph', children: [{ type: 'text', text: '以上是两个公式, 其中第二个故意超出转换器能力。' }] },
        ]),
    ]);
}

/** 递归收集 payload 里所有 math/inlineMath 节点。 */
function collectMathNodes(payload: any): any[] {
    const out: any[] = [];
    const walk = (o: any): void => {
        if (Array.isArray(o)) { o.forEach(walk); return; }
        if (o && typeof o === 'object') {
            if (o.type === 'math' || o.type === 'inlineMath') out.push(o);
            Object.values(o).forEach(walk);
        }
    };
    walk(payload);
    return out;
}

/** 递归收集 payload 里所有 image 节点。 */
function collectImageNodes(payload: any): any[] {
    const out: any[] = [];
    const walk = (o: any): void => {
        if (Array.isArray(o)) { o.forEach(walk); return; }
        if (o && typeof o === 'object') {
            if (o.type === 'image') out.push(o);
            Object.values(o).forEach(walk);
        }
    };
    walk(payload);
    return out;
}

/** 递归收集对象里所有字符串值 (用于 JSON 往返后的可见性断言)。 */
function collectAllStrings(o: any): string[] {
    const out: string[] = [];
    const walk = (v: any): void => {
        if (typeof v === 'string') { out.push(v); return; }
        if (Array.isArray(v)) { v.forEach(walk); return; }
        if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(o);
    return out;
}

// ------------------------------------------------------------------ gate (a)

test('P0 gate (a): math travels as TEXT in the payload, never an image placeholder', () => {
    const { payload, diagnostics } = toTypstPayload(gatesBundle(), opts);
    assert.strictEqual(payload.messageCount, 2);

    const maths = collectMathNodes(payload);
    assert.strictEqual(maths.length, 3, `expected 1 inline + 2 display math nodes, got ${maths.length}`);

    const byLatex = new Map(maths.map((m: any) => [m.latex, m]));

    // 行内公式: latex 源码逐字保留, 且有文本形式的转换结果。
    const inline = byLatex.get(INLINE_LATEX);
    assert.ok(inline, 'inline math node must exist');
    assert.strictEqual(inline.type, 'inlineMath');
    assert.strictEqual(inline.latex, INLINE_LATEX, 'inline latex must be byte-identical');
    assert.ok(typeof inline.typst === 'string' && inline.typst.length > 0, 'converted math must be text');

    // 行间公式 (可转换): 同样走文本。
    const displayOk = byLatex.get(DISPLAY_LATEX_OK);
    assert.ok(displayOk, 'display math node must exist');
    assert.strictEqual(displayOk.type, 'math');
    assert.strictEqual(displayOk.latex, DISPLAY_LATEX_OK);
    assert.ok(typeof displayOk.typst === 'string' && displayOk.typst.includes('TYPST('));

    // 绝不是图片占位: payload 里没有任何 image 节点携带公式, 也没有任何
    // data:image URI (P0: 4 份 PDF 嵌入图片数 = 0, 公式为可选文本)。
    const images = collectImageNodes(payload);
    assert.deepStrictEqual(images, [], 'no image nodes may appear for math content');
    const json = JSON.stringify(payload);
    assert.ok(!json.includes('data:image'), 'payload must not embed image data URIs');
    // JSON 往返后 (模板走 json() 消费), 公式源码必须仍以文本形式存在。
    const allText = collectAllStrings(JSON.parse(json)).join('\n');
    for (const src of [INLINE_LATEX, DISPLAY_LATEX_OK, DISPLAY_LATEX_UNCONVERTIBLE]) {
        assert.ok(allText.includes(src), `math source must survive JSON round-trip as text: ${src.slice(0, 30)}…`);
    }
    void diagnostics;
});

// ------------------------------------------------------------------ gate (b)

test('P0 gate (b): 2000+ char Chinese text survives byte-identical', () => {
    const { payload } = toTypstPayload(gatesBundle(), opts);
    assert.strictEqual(payload.messageCount, 2);

    // 用户消息段落: text 节点拼接必须与输入逐字相等。
    const para: any = payload.messages[0].blocks[1];
    assert.strictEqual(para.type, 'paragraph');
    const roundTripped = para.children.map((c: any) => c.text ?? '').join('');
    assert.strictEqual(roundTripped, ZH_LONG, 'Chinese long text must be byte-identical (exact equality)');
    assert.ok(roundTripped.length > 2000, `must exceed 2000 chars, got ${roundTripped.length}`);

    // 标题中文同样精确无损。
    const heading: any = payload.messages[0].blocks[0];
    assert.strictEqual(heading.children[0].text, '中文长文本完整性验证');

    // JSON 序列化往返 (模板走 json() 消费) 不丢字: 在解析后的结构上重组段落文本。
    const reparsed = JSON.parse(JSON.stringify(payload));
    const reParaText = reparsed.messages[0].blocks[1].children.map((c: any) => c.text ?? '').join('');
    assert.strictEqual(reParaText, ZH_LONG, 'full 2000+ char text must survive JSON round-trip intact');
    const allText = collectAllStrings(reparsed).join('');
    assert.ok(allText.includes('中文长文本完整性验证'), 'heading Chinese must survive JSON round-trip');

    // plainText 摘要同样包含完整中文 (P0: s4 2076 字全部命中)。
    // 注: plainInline 把行内公式展开为源码, 所以摘要 = 中文前半 + 公式源码 + 中文后半。
    const plain: string = payload.messages[0].plainText ?? '';
    const mid = Math.floor(ZH_LONG.length / 2);
    assert.ok(plain.includes(ZH_LONG.slice(0, mid)), 'plainText must contain Chinese head verbatim');
    assert.ok(plain.includes(ZH_LONG.slice(mid)), 'plainText must contain Chinese tail verbatim');
    assert.ok(plain.includes(INLINE_LATEX), 'plainText must contain inline math source');
});

// ------------------------------------------------------------------ gate (c)

test('P0 gate (c): unconvertible formula degrades to visible source fallback, never silently dropped', () => {
    const { payload, diagnostics } = toTypstPayload(gatesBundle(), opts);

    const maths = collectMathNodes(payload);
    const failed = maths.find((m: any) => m.latex === DISPLAY_LATEX_UNCONVERTIBLE);
    assert.ok(failed, 'unconvertible formula node must still exist in payload (not dropped)');
    assert.strictEqual(failed.type, 'math');
    // 原文回退: latex 源码逐字保留, 无伪造的 typst 转换结果。
    assert.strictEqual(failed.latex, DISPLAY_LATEX_UNCONVERTIBLE, 'failed formula source must be preserved verbatim');
    assert.ok(!('typst' in failed), 'no fabricated typst output for failed conversion');

    // 可见性: 源码全文在 JSON 往返后仍以文本存在 (模板侧渲染为可见注释, 见 payload.ts 模块注释)。
    const allText = collectAllStrings(JSON.parse(JSON.stringify(payload))).join('\n');
    assert.ok(allText.includes(DISPLAY_LATEX_UNCONVERTIBLE), 'failed formula source must be visible in payload as text');

    // 节点计数对账: 3 个输入公式 -> 3 个 payload 公式节点, 一个都不能少。
    assert.strictEqual(maths.length, 3, 'every input formula must yield exactly one payload node');
    void diagnostics;
});

test('P0 gate (c2): formula node count reconciles against bundle input (no silent loss)', () => {
    const b = gatesBundle();
    const inputMathCount = b.conversation.messages
        .flatMap((m: any) => m.blocks)
        .filter((blk: any) => blk.type === 'math').length
        + b.conversation.messages
            .flatMap((m: any) => m.blocks)
            .flatMap((blk: any) => blk.children ?? [])
            .filter((n: any) => n.type === 'inlineMath').length;
    assert.strictEqual(inputMathCount, 3);
    const { payload } = toTypstPayload(b, opts);
    assert.strictEqual(collectMathNodes(payload).length, inputMathCount,
        'payload math node count must equal bundle math node count');
});
