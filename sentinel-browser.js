'use strict';

/**
 * Sentinel 浏览器内运行（路径 A）：
 * 在 chatgpt.com 主页面开一个 srcdoc iframe（继承同源、独立 realm 隔离污染），
 * 注入 sentinel_bootstrap.js + 真实 sentinel_sdk.js，让 sdk 内部的
 * /backend-api/sentinel/req 走 iframe 的 fetch → 浏览器网络栈（真实 Chrome TLS + 同代理）。
 * sdk 只负责拿 {t, so, c, seed, diff, powReq}，PoW 在 Node 侧解（对齐 bridge）。
 *
 * 相比 spawn bridge + curl：TLS 指纹与 checkout 完全一致（都是 Chrome），
 * 且不再依赖 curl / 代理传递。
 */

const { readFileSync } = require('fs');
const { randomBytes } = require('crypto');
const path = require('path');

const BOOTSTRAP_SRC = readFileSync(path.join(__dirname, 'sentinel', 'sentinel_assets', 'sentinel_bootstrap.js'), 'utf8');
const SDK_SRC = readFileSync(path.join(__dirname, 'sentinel', 'sentinel_assets', 'sentinel_sdk.js'), 'utf8');
const BRIDGE_VERSION = '20260219f9f6';

// ---- PoW（复制自 sentinel_bridge.js，对齐 sentinel.go）----
function fnv1a32(buf) {
    let h = 0x811c9dc5 >>> 0;
    for (let i = 0; i < buf.length; i++) {
        h ^= buf[i];
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= h >>> 16;
    h = Math.imul(h, 2246822507) >>> 0;
    h ^= h >>> 13;
    h = Math.imul(h, 3266489909) >>> 0;
    h ^= h >>> 16;
    return h >>> 0;
}

function b64Compact(v) {
    return Buffer.from(JSON.stringify(v), 'utf8').toString('base64');
}

function uuidv4() {
    const b = randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => (x + 0x100).toString(16).slice(1));
    return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`;
}

const SEP = '\u2212'; // U+2212 MINUS SIGN
const ANS_SDK_URL = 'https://sentinel.openai.com/backend-api/sentinel/sdk.js';

function makeGenerator(ua, cores, language, timezone) {
    const initialPerformance = 350.0 + Math.random() * 2200.0;
    return {
        ua,
        cores: cores || 16,
        language: language || 'en-US',
        languages: [language || 'en-US', 'en-US', 'en'],
        timezone: timezone || 'America/New_York',
        sid: uuidv4(),
        heapLimit: 4395630592,
        screenNum: 3000,
        nine: 0,
        loadTs: Date.now() - initialPerformance,
        initialPerformance,
        startedAt: Date.now(),
        probeNav: 'getBattery' + SEP + 'function getBattery() { [native code] }',
        reactKey: 'location',
        eventName: 'onbeforeunload',
    };
}

function configArray(g) {
    const perfNow = g.initialPerformance + Math.max(0, Date.now() - g.startedAt);
    const now = new Date();
    let offsetMinutes = 0;
    try {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: g.timezone,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hourCycle: 'h23',
        }).formatToParts(now).reduce((out, part) => {
            if (part.type !== 'literal') out[part.type] = Number(part.value);
            return out;
        }, {});
        const localAsUtc = Date.UTC(
            parts.year, parts.month - 1, parts.day,
            parts.hour, parts.minute, parts.second
        );
        offsetMinutes = Math.round((localAsUtc - now.getTime()) / 60000);
    } catch (_) { /* 忽略 */ }
    const d = new Date(now.getTime() + offsetMinutes * 60000);
    const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
    const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
    const p2 = (n) => (n < 10 ? '0' : '') + n;
    const sign = offsetMinutes >= 0 ? '+' : '-';
    const offset = Math.abs(offsetMinutes);
    const tstr =
        `${wd} ${mo} ${p2(d.getUTCDate())} ${d.getUTCFullYear()} ` +
        `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} ` +
        `GMT${sign}${p2(Math.floor(offset / 60))}${p2(offset % 60)} (${g.timezone})`;
    return [
        g.screenNum, // 0
        tstr, // 1
        g.heapLimit, // 2
        0, // 3 PoW 计数器
        g.ua, // 4
        ANS_SDK_URL, // 5
        null, // 6
        g.language, // 7
        g.languages.join(','), // 8
        g.nine, // 9
        g.probeNav, // 10
        g.reactKey, // 11
        g.eventName, // 12
        perfNow, // 13
        g.sid, // 14
        '', // 15
        g.cores, // 16
        g.loadTs, // 17
        0, 0, 0, 0, 0, 0, 0, // 18..24
    ];
}

const MAX_ATTEMPTS = 500000;
const ERR_PREFIX = 'wQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D';

function solvePoW(g, seed, difficulty) {
    if (!difficulty) difficulty = '0';
    const data = configArray(g);
    const seedB = Buffer.from(seed, 'ascii');
    const dl = difficulty.length;
    const startedAt = Date.now();
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
        data[3] = i;
        data[9] = Math.round(Date.now() - startedAt);
        const payload = b64Compact(data);
        const h = fnv1a32(Buffer.concat([seedB, Buffer.from(payload, 'ascii')]));
        const hex = h.toString(16).padStart(8, '0');
        const cmpLen = Math.min(dl, hex.length);
        if (hex.slice(0, cmpLen) <= difficulty.slice(0, cmpLen)) {
            return 'gAAAAAB' + payload + '~S';
        }
    }
    return 'gAAAAAB' + ERR_PREFIX + b64Compact(null) + '~S';
}

/**
 * @param {object} page - Playwright Page（已登录 chatgpt.com）
 * @param {object} params
 * @param {string} params.deviceId
 * @param {string} params.userAgent
 * @param {string} [params.flow]
 * @param {string} [params.language]
 * @param {string} [params.timezone]
 * @param {string} [params.pageUrl]
 * @param {number} [params.timeoutMs]
 * @returns {Promise<{ main: string, so: string, hasSo: boolean }>}
 */
async function mintSentinelTokenInPage(page, params) {
    const ua = String(params.userAgent || '').trim();
    const cores = params.cores || 16;
    const deviceId = String(params.deviceId || '').trim();
    const flow = String(params.flow || 'chatgpt_checkout');
    const language = String(params.language || 'en-US');
    const timezone = String(params.timezone || 'Asia/Manila');
    const pageUrl = String(params.pageUrl || 'https://chatgpt.com/');

    const evaluatePromise = page.evaluate(async (args) => {
        const iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        iframe.srcdoc = '<!DOCTYPE html><html><head></head><body></body></html>';
        document.body.appendChild(iframe);
        await new Promise((resolve) => { iframe.onload = resolve; });

        const win = iframe.contentWindow;
        try {
            // sdk/bridge 需要的全局变量
            win.__UA__ = args.ua;
            win.__CORES__ = args.cores;
            win.__SDK_URL__ = 'https://chatgpt.com/sentinel/' + args.version + '/sdk.js';
            win.__SEED_DID_KEY__ = 'oai-did';
            win.__SEED_DID_VAL__ = args.deviceId;
            win.__PAGE_URL__ = args.pageUrl;
            win.__LANGUAGE__ = args.language;
            win.__LANGUAGES__ = [args.language, 'en-US', 'en'];
            win.__TIMEZONE__ = args.timezone;
            win.__COOKIE_HEADER__ = '';

            // 覆写 fetch：相对路径 → chatgpt.com（同源，真实 Chrome TLS + 同代理 + 自动带 cookie）
            const origFetch = win.fetch.bind(win);
            win.fetch = function (url, opts) {
                let u = String(url);
                if (u.startsWith('/')) u = 'https://chatgpt.com' + u;
                return origFetch(u, opts);
            };

            // 先 bootstrap 后 sdk（bootstrap 会短路 sdk 的防篡改正则）
            win.eval(args.bootstrapSrc);
            win.eval(args.sdkSrc + '\n;globalThis.__SENTINEL_SDK__ = SentinelSDK;');

            const SDK = win.__SENTINEL_SDK__;
            if (!SDK || typeof SDK.__proto2 !== 'function') {
                throw new Error('SentinelSDK.__proto2 未定义');
            }
            return await SDK.__proto2(args.flow);
        } finally {
            iframe.remove();
        }
    }, {
        bootstrapSrc: BOOTSTRAP_SRC,
        sdkSrc: SDK_SRC,
        ua, cores, deviceId, flow, language, timezone, pageUrl, version: BRIDGE_VERSION,
    });

    // Playwright evaluate 不接受 options 参数，用 Promise.race 实现超时，
    // 避免 iframe 内 sdk 卡死时拖满 180 秒无输出保护。
    const timeoutMs = Number(params.timeoutMs) || 25000;
    let timer = null;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`页面内 Sentinel 超时(${timeoutMs}ms)`)), timeoutMs);
        if (timer.unref) timer.unref();
    });
    const driverJson = await Promise.race([evaluatePromise, timeoutPromise]).finally(() => {
        if (timer) clearTimeout(timer);
    });

    let rd;
    try {
        rd = JSON.parse(String(driverJson));
    } catch (e) {
        throw new Error('Sentinel driver 解析失败: ' + String(driverJson).slice(0, 300));
    }
    if (!rd.c) {
        throw new Error('Sentinel driver 无 c (soErr: ' + String(rd.soErr || '').slice(0, 200) + ')');
    }

    const g = makeGenerator(ua, cores, language, timezone);
    let p;
    if (rd.powReq && rd.seed) {
        p = solvePoW(g, rd.seed, rd.diff);
    } else {
        const data0 = configArray(g);
        data0[3] = 1;
        p = 'gAAAAAB' + b64Compact(data0) + '~S';
    }

    const main = JSON.stringify({ p, t: rd.t || '', c: rd.c, id: deviceId, flow });
    let so = '';
    if (rd.so) {
        so = JSON.stringify({ so: rd.so, c: rd.c, id: deviceId, flow });
    }
    return { main, so, hasSo: Boolean(rd.so) };
}

module.exports = { mintSentinelTokenInPage };
