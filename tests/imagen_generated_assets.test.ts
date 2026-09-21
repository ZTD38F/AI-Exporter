export {};

const test = require('node:test');
const assert = require('node:assert');
const { GeminiResponseParserClass } = require('../src/core/api/geminiParser.js');
const ChatFormatter = require('../src/core/engine/chatFormatter.js');

test('geminiParser - extracts Imagen generated image node (Pattern 2)', () => {
    const imagenNode = [
        null,
        1,
        "watermarked_img_16704480932994645752.jpg",
        "https://lh3.googleusercontent.com/gg/ACRwjavPniU5LRENaIm-6aleFKYDMfW02Me91e7oUbbDuHypWF8TDRUFAz5zE2Y7M1upuCMvqxWTVyWcLXR8BwcVS1nerGoqpPu_QVQx8_PKx7s90wbEEzU0K6jFPcN3gXW6a9r0aQRbMqAMsf5E2BbXFF-3_mNpi2NYTk2rLDYXVLuG2f-nf8sSUFMX2PNySGUpMhnTrNU2Iil4KOYL8TDvZZOI5wa85y-OZPgrXaGw55oLUzGQJJOtD3BZLbQRLm3GnxbTSA-CyHJYaTRmpJ7cK8uHN0-FKXzDVsR5hsn8aiVJ3Es0XnINPusg9R-RD24UC9C8sj2zuiqELa38-2ydh9s",
        null,
        "$AXzLiRwXeOJl0Bt2a6m8QL9S1mQCi42r7EROQ1BwqIcZuJ7TcSejJZs1+VG6z1sCdz04lS3zi0VG15MJu/gH9vxDCduu2HXts8vz4GGsQACLzMBNRkW16m2RT7Ouec1LmWXZjummxEQf6ZbbqLwtbtXEGcQJRDhYy2YazFTtCGLdjg1Pi+BDKbu4lcp9+ByL1UwZkfImLoEqSIsdcoiiXVpbCtPyTb3FfJ54JfznUZyNlnJPRnF7kESwJSf9uIscq385RSrXqTJ56Bf9SNFADjThOQ==",
        null,
        null,
        null,
        [1788550788, 840331369],
        null,
        "image/jpeg",
        null,
        null,
        null,
        [1408, 768, 924784]
    ];

    const candidateBlock = [
        "rc_3244407ff0cfc512",
        ["\n\nhttp://googleusercontent.com/image_generation_content/2_557\n\n"],
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        [
            null, null, null, null, null, null, null,
            [
                [
                    [
                        [null, null, null, imagenNode],
                        ["http://googleusercontent.com/image_generation_content/2_557"]
                    ]
                ]
            ]
        ]
    ];

    const images = GeminiResponseParserClass.extractImages(candidateBlock);
    assert.strictEqual(images.length, 1);
    assert.strictEqual(images[0].fileName, "watermarked_img_16704480932994645752.jpg");
    assert.strictEqual(images[0].mimeType, "image/jpeg");
    assert.strictEqual(images[0].width, 1408);
    assert.strictEqual(images[0].height, 768);
    assert.strictEqual(images[0].size, 924784);
    assert.ok(images[0].sourceUrl.startsWith("https://lh3.googleusercontent.com/gg/"));
});

test('geminiParser - extracts Python plot generated asset (Pattern 2)', () => {
    const plotNode = [
        null,
        1,
        "ekf_fusion_result.png",
        "https://lh3.googleusercontent.com/gg/ACRwjaub7uiGm3T7VzMR-_B160VqDtHahpFPSKkGxl83nyPiTl-gQAGRonXla9yjtkouerHkESRUW4PIsBzk-oRy4_prRC8-BU2I1iR0TB8p6ZZQJyF6bacgakdj3wTxqKqDI9tU6xGmHIC5nGU-OlDGXaG-q1ocDIvbLpwEGMy5zwJys8ynKyYhfZ2F99G8iBEwgZaFpp8Wa15Rp92w0yLMXxYVK5d6kTc_4IM-pKyGbYkpJXopNxDEyu5MT5OjsVJCwTgwuC9nKdQAkPr3sV-IVLgW2QmHaLGtOEo1ThTv8qRnaVMyuY2K61ZQEuhdOes5Waz5xEjb8RPb-70ytUu6Inpg",
        null,
        "$AXzLiRxGsTj2Vi/eWubYyP3wsoOqlIpX7K7b29iA9U+LHs7m3Q+0YN+fSvvLNMqwSUGRf4V7BlyRLZfpU8QVKbDdYyzDeMWMyrEbU0G6/v/2FgkxqzDhxcbSzutREhVQfLFWW2DNwuGmJ1qHmyng7ikzbzl9UYG1JAi15eNBTjZCJqYIId++YuNoLqi0UUKymeaVgwYNIiVrgwxTJREFX/LrCTVk0jTATeTqWeXM6yl1",
        null,
        null,
        null,
        null,
        null,
        "image/png",
        null,
        null,
        null,
        [900, 700, 93650]
    ];

    const images = GeminiResponseParserClass.extractImages(plotNode);
    assert.strictEqual(images.length, 1);
    assert.strictEqual(images[0].fileName, "ekf_fusion_result.png");
    assert.strictEqual(images[0].mimeType, "image/png");
    assert.strictEqual(images[0].width, 900);
    assert.strictEqual(images[0].height, 700);
    assert.strictEqual(images[0].size, 93650);
});

test('chatFormatter - formats generated image as markdown and cleans placeholder URLs', () => {
    const mockChat = {
        id: '61a5e19c42b800f3',
        title: '深渊AUV材料与通信挑战',
        url: 'https://gemini.google.com/app/61a5e19c42b800f3',
        timestamp: 1788550788000,
        messages: [
            {
                role: 'user',
                content: '请帮我生成一张图片：深海潜水器'
            },
            {
                role: 'model',
                content: 'http://googleusercontent.com/image_generation_content/2_557',
                images: [
                    {
                        sourceUrl: 'https://lh3.googleusercontent.com/gg/ACRwjavPniU5LRENaIm-6aleFKYDMfW02Me91e7oUbb',
                        resolvedUrl: 'https://lh3.googleusercontent.com/gg/ACRwjavPniU5LRENaIm-6aleFKYDMfW02Me91e7oUbb=s0',
                        localName: 'assets/b800f3_watermarked_img_16704480932994645752.jpg',
                        fileName: 'watermarked_img_16704480932994645752.jpg',
                        width: 1408,
                        height: 768,
                        type: 'image'
                    }
                ]
            }
        ]
    };

    const res = ChatFormatter.toMarkdown(mockChat);
    // 必须包含 Markdown 图片引用 ![]
    assert.ok(res.includes('!['));
    assert.ok(res.includes('assets/b800f3_watermarked_img_16704480932994645752.jpg'));
    // 不应泄露裸露的 image_generation_content 占位行
    assert.ok(!res.includes('http://googleusercontent.com/image_generation_content/2_557'));
});

test('assetFetcher - ensureAlr appends or preserves alr=yes parameter', () => {
    const AssetFetcher = require('../src/content/assetFetcher.js');
    const ensureAlr = AssetFetcher.ensureAlr || (AssetFetcher.AssetFetcher && AssetFetcher.AssetFetcher.ensureAlr);

    assert.strictEqual(ensureAlr('https://lh3.googleusercontent.com/gg/abc'), 'https://lh3.googleusercontent.com/gg/abc?alr=yes');
    assert.strictEqual(ensureAlr('https://lh3.googleusercontent.com/gg/abc?foo=bar'), 'https://lh3.googleusercontent.com/gg/abc?foo=bar&alr=yes');
    assert.strictEqual(ensureAlr('https://lh3.googleusercontent.com/gg/abc?alr=yes'), 'https://lh3.googleusercontent.com/gg/abc?alr=yes');
    assert.strictEqual(ensureAlr('https://lh3.googleusercontent.com/gg/abc?foo=bar&alr=yes'), 'https://lh3.googleusercontent.com/gg/abc?foo=bar&alr=yes');
});

test('assetFetcher - extractLh3 parses lh3-lh6 and unescapes json characters', () => {
    const AssetFetcher = require('../src/content/assetFetcher.js');
    const extractLh3 = AssetFetcher.extractLh3 || (AssetFetcher.AssetFetcher && AssetFetcher.AssetFetcher.extractLh3);

    const normal = 'https://lh3.google.com/rd-gg/abc123=s512?alr=yes';
    assert.strictEqual(extractLh3(normal), normal);

    const escaped = '[\"https:\\/\\/lh4.googleusercontent.com\\/rd-gg\\/xyz\\u003d512\\u0026alr=yes\"]';
    assert.strictEqual(extractLh3(escaped), 'https://lh4.googleusercontent.com/rd-gg/xyz=512&alr=yes');
});

test('assetFetcher - fetchGgChain follows multi-hop ALR text redirects to final image', async () => {
    const AssetFetcher = require('../src/content/assetFetcher.js');
    const fetchGgChain = AssetFetcher.fetchGgChain || (AssetFetcher.AssetFetcher && AssetFetcher.AssetFetcher.fetchGgChain);

    const oldFetch = (global as any).fetch;
    const callLog: string[] = [];

    try {
        (global as any).fetch = async (url: string) => {
            callLog.push(url);
            if (url.includes('/gg/start')) {
                // Hop 0: returns text/plain pointing to rd-gg/hop1 (without alr=yes)
                return {
                    ok: true,
                    status: 200,
                    headers: new Map([['content-type', 'text/plain; charset=UTF-8']]),
                    clone: () => ({
                        text: async () => 'https://lh3.google.com/rd-gg/hop1'
                    })
                };
            } else if (url.includes('/rd-gg/hop1')) {
                // Hop 1: returns text/plain pointing to rd-gg/final
                return {
                    ok: true,
                    status: 200,
                    headers: new Map([['content-type', 'text/plain; charset=UTF-8']]),
                    clone: () => ({
                        text: async () => 'https://lh3.googleusercontent.com/rd-gg/final'
                    })
                };
            } else if (url.includes('/rd-gg/final')) {
                // Hop 2: returns binary image/jpeg
                const fakeBinary = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 4]);
                return {
                    ok: true,
                    status: 200,
                    headers: new Map([['content-type', 'image/jpeg']]),
                    blob: async () => ({
                        size: fakeBinary.length,
                        type: 'image/jpeg',
                        arrayBuffer: async () => fakeBinary.buffer
                    })
                };
            }
            return { ok: false, status: 404, headers: new Map() };
        };

        const res = await fetchGgChain('https://lh3.googleusercontent.com/gg/start');
        assert.ok(res, 'Must return response');
        assert.strictEqual(res.ok, true);
        assert.strictEqual(res.headers.get('content-type'), 'image/jpeg');
        assert.strictEqual(callLog.length, 3, 'Must follow 3 hops to resolve image');
        // Ensure every hop was queried with alr=yes
        assert.ok(callLog[0].includes('alr=yes'), 'Hop 0 must include alr=yes');
        assert.ok(callLog[1].includes('alr=yes'), 'Hop 1 must enforce alr=yes');
        assert.ok(callLog[2].includes('alr=yes'), 'Hop 2 must enforce alr=yes');
    } finally {
        (global as any).fetch = oldFetch;
    }
});
