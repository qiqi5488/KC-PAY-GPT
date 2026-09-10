'use strict';

/**
 * 外部指纹浏览器接入（AdsPower / BitBrowser / 候鸟 / 紫鸟 等指纹浏览器）
 *
 * 用途：自动化直连用户已启动的指纹浏览器 profile（CDP），在该真实浏览器环境内
 * 执行 Checkout 流程，从而完全规避无头 Chromium 的指纹与自动化特征。
 * （实测：指纹浏览器 + PH 代理可正常创建支付链接，而脚本自带无头 Chromium 被风控拦截）
 *
 * 注意：这里使用原生 playwright（非 playwright-extra / stealth）连接——
 * 指纹浏览器自身已做指纹伪装，再叠加 stealth 反而可能造成自相矛盾。
 */

const { chromium } = require('playwright');

/**
 * @param {object} options
 * @param {string} options.cdpUrl - 指纹浏览器 CDP 地址，如 http://127.0.0.1:9527 或 ws://127.0.0.1:9527
 */
async function connectExternalBrowser(options = {}) {
    const cdpUrl = String(options.cdpUrl || '').trim();
    if (!cdpUrl) {
        throw new Error('缺少外部浏览器 CDP 地址 (EXTERNAL_BROWSER_CDP_URL)');
    }

    console.log(`🧩 [Browser/external] 正在接入外部指纹浏览器 CDP: ${cdpUrl}`);
    const browser = await chromium.connectOverCDP(cdpUrl, { timeout: 30000 });
    console.log('🧩 [Browser/external] CDP 接入成功');

    // 探测真实 UA（指纹浏览器的 UA，用于日志与后续一致性），失败不阻断
    let realUserAgent = '';
    try {
        const ctxs = browser.contexts();
        if (ctxs.length > 0 && ctxs[0].pages().length > 0) {
            realUserAgent = await ctxs[0].pages()[0].evaluate(() => navigator.userAgent).catch(() => '');
        }
        if (!realUserAgent) {
            const probeCtx = await browser.newContext();
            const probePage = await probeCtx.newPage();
            realUserAgent = await probePage.evaluate(() => navigator.userAgent).catch(() => '');
            await probeCtx.close().catch(() => {});
        }
    } catch (_) { /* 忽略 */ }
    console.log(`🧩 [Browser/external] 外部浏览器 UA: ${realUserAgent || '(探测失败)'}`);

    return {
        mode: 'external',
        browser,
        ownsBrowser: false,
        cdpUrl,
        realUserAgent
    };
}

module.exports = { connectExternalBrowser };
