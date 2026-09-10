'use strict';

/**
 * Sentinel PoW 运行时封装（移植自 Aqvyn 项目）
 *
 * 通过 Node 子进程跑真实的 OpenAI sentinel_sdk.js，产出 checkout 请求所需的
 * OpenAI-Sentinel-Token（main）+ OpenAI-Sentinel-So-Token（so）。
 * 这是 HTTP 直调能否通过 OpenAI 风控的关键（缺失即 400 unusual activity）。
 */

const { spawn } = require('child_process');
const path = require('path');

const BRIDGE_PATH = path.join(__dirname, 'sentinel', 'sentinel_bridge.js');
const BRIDGE_VERSION = '20260219f9f6';

/**
 * @param {object} params
 * @param {string} params.deviceId - 与 oai-did cookie / oai-device-id 头一致的设备 ID
 * @param {string} params.userAgent - 浏览器 UA
 * @param {string} [params.flow]
 * @param {string} [params.proxy] - 本地 HTTP 中继地址（http://127.0.0.1:port）
 * @param {string} [params.cookieHeader] - 会话 cookie 字符串
 * @param {string} [params.language]
 * @param {string} [params.timezone]
 * @param {string} [params.pageUrl]
 * @param {number} [params.timeoutS]
 * @returns {Promise<{ main: string, so: string, hasSo: boolean }>}
 */
function mintSentinelToken(params, timeoutS = 120) {
    const payload = {
        ua: String(params.userAgent || '').trim(),
        cores: params.cores || 16,
        deviceId: String(params.deviceId || '').trim(),
        flow: String(params.flow || 'chatgpt_checkout'),
        proxy: String(params.proxy || '').trim(),
        version: BRIDGE_VERSION,
        pageUrl: String(params.pageUrl || 'https://chatgpt.com/'),
        language: String(params.language || 'en-US'),
        timezone: String(params.timezone || 'Asia/Manila'),
        cookieHeader: String(params.cookieHeader || '').trim(),
        sentinelOrigin: 'https://chatgpt.com',
    };

    return new Promise((resolve, reject) => {
        const nodeBin = process.env.SENTINEL_NODE || 'node';
        const child = spawn(nodeBin, [BRIDGE_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });

        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });

        let settled = false;
        const finish = (fn, arg) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn(arg);
        };
        const timer = setTimeout(() => {
            finish(reject, new Error(`Sentinel 生成超时（>${timeoutS}s）`));
            child.kill();
        }, timeoutS * 1000);

        child.on('error', (e) => finish(reject, new Error(`Sentinel 子进程启动失败: ${e.message}`)));
        child.on('close', (code) => {
            if (code !== 0) {
                finish(reject, new Error(`Sentinel 失败(code=${code}): ${(stderr || stdout).slice(0, 400)}`));
                return;
            }
            const result = parseResult(stdout);
            if (!result) {
                finish(reject, new Error(`Sentinel 输出解析失败: ${stdout.slice(0, 200)}`));
                return;
            }
            if (result.error) {
                finish(reject, new Error(`Sentinel 失败: ${result.error}`));
                return;
            }
            if (!result.main) {
                finish(reject, new Error('Sentinel 未返回 main token'));
                return;
            }
            finish(resolve, { main: result.main, so: result.so || '', hasSo: Boolean(result.so) });
        });

        child.stdin.write(JSON.stringify(payload));
        child.stdin.end();
    });
}

function parseResult(stdout) {
    const trimmed = String(stdout || '').trim();
    if (!trimmed) return null;
    try {
        return JSON.parse(trimmed);
    } catch (_) { /* 可能有 SDK 打印的前缀，回退提取最后一个 main 结果 */ }
    const idx = trimmed.lastIndexOf('{"main"');
    if (idx >= 0) {
        try {
            return JSON.parse(trimmed.slice(idx));
        } catch (_) { /* ignore */ }
    }
    return null;
}

module.exports = { mintSentinelToken };
