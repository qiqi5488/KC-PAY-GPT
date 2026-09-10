'use strict';

/**
 * 浏览器运行时调度：按模式选择独立启动或池 CDP 接入，两套实现互不影响。
 */

const { connectStandaloneBrowser } = require('./browser-standalone');
const { connectPoolBrowser } = require('./browser-pool-client');

function resolveBrowserRuntimeMode(env = process.env) {
    // 外部指纹浏览器直连优先：设置了 EXTERNAL_BROWSER_CDP_URL 即进入外部模式。
    // 必须放在 BROWSER_RUNTIME_MODE 判断之前——server 的 buildWorkerRuntimeEnv
    // 会强制写 BROWSER_RUNTIME_MODE=standalone，只有在这里按该变量优先才能命中。
    if (String(env.EXTERNAL_BROWSER_CDP_URL || '').trim()) {
        return 'external';
    }
    const explicit = String(env.BROWSER_RUNTIME_MODE || '').trim().toLowerCase();
    if (explicit === 'pool' || explicit === 'standalone') {
        return explicit;
    }
    const poolCdpUrl = String(env.BROWSER_POOL_CDP_URL || '').trim();
    if (env.BROWSER_POOL === '1' && poolCdpUrl) {
        return 'pool';
    }
    return 'standalone';
}

/**
 * 子进程连接浏览器（由 server 注入 BROWSER_RUNTIME_MODE / 池 CDP 环境变量）
 */
async function connectTaskBrowser(options = {}) {
    const env = options.env || process.env;
    const mode = resolveBrowserRuntimeMode(env);

    if (mode === 'external') {
        const { connectExternalBrowser } = require('./browser-external');
        return connectExternalBrowser({
            cdpUrl: env.EXTERNAL_BROWSER_CDP_URL
        });
    }

    if (mode === 'pool') {
        return connectPoolBrowser({
            poolCdpUrl: env.BROWSER_POOL_CDP_URL,
            poolSlotId: env.BROWSER_POOL_SLOT
        });
    }

    return connectStandaloneBrowser({
        proxyConfig: options.proxyConfig,
        headful: options.headful,
        chromiumChannel: options.chromiumChannel || env.CHROMIUM_CHANNEL,
        cdpPort: env.CDP_PORT
    });
}

function applyCdpEnv(session) {
    if (!session?.cdpUrl) {
        return;
    }
    process.env.CDP_URL = session.cdpUrl;
    if (session.cdpPort) {
        process.env.CDP_PORT = String(session.cdpPort);
    }
}

async function closeTaskBrowser(session, browser) {
    if (!browser) {
        return;
    }
    if (session?.ownsBrowser) {
        await browser.close().catch(() => {});
        return;
    }
    console.log('♻️ [Browser/pool] 任务 context 已关闭，槽位归还（Chromium 保持常驻）');
}

function buildWorkerRuntimeEnv(baseEnv, slot, mode) {
    if (mode === 'pool' && slot) {
        return {
            ...baseEnv,
            BROWSER_RUNTIME_MODE: 'pool',
            BROWSER_POOL: '1',
            BROWSER_POOL_SLOT: String(slot.slotId),
            BROWSER_POOL_CDP_URL: slot.cdpUrl,
            CDP_URL: slot.cdpUrl,
            CDP_PORT: String(slot.port)
        };
    }
    if (mode === 'external') {
        return {
            ...baseEnv,
            BROWSER_RUNTIME_MODE: 'external',
            BROWSER_POOL: '0',
            BROWSER_POOL_CDP_URL: '',
            BROWSER_POOL_SLOT: ''
        };
    }
    return {
        ...baseEnv,
        BROWSER_RUNTIME_MODE: 'standalone',
        BROWSER_POOL: '0',
        BROWSER_POOL_CDP_URL: '',
        BROWSER_POOL_SLOT: ''
    };
}

module.exports = {
    resolveBrowserRuntimeMode,
    connectTaskBrowser,
    applyCdpEnv,
    closeTaskBrowser,
    buildWorkerRuntimeEnv
};
