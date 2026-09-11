'use strict';

const { randomUUID } = require('crypto');
const axios = require('axios');
const store = require('./mysql-store');
const { getRegionConfig } = require('./region-config');
const { executePaymentWithRetry } = require('./payment-retry');
const { mintSentinelToken } = require('./sentinel');

function buildCheckoutPayload(planName, country, currency) {
    const uiMode = String(process.env.CHECKOUT_UI_MODE || 'custom').trim() || 'custom';
    return {
        entry_point: 'all_plans_pricing_modal',
        plan_name: planName,
        billing_details: { country, currency },
        checkout_ui_mode: uiMode
    };
}

// 部署校验标记：日志出现该版本号即代表新代码已生效
const CHECKOUT_IMPL_VERSION = 'v5-sentinel';

/**
 * 从 chatgpt.com 页面 HTML 提取前端上下文（attestation / client-version / build-number）
 * 这些值随每次部署动态下发，无法写死，必须实时抓取。
 */
async function bootstrapFrontendContext(page) {
    try {
        const html = await page.evaluate(async () => {
            try {
                const res = await fetch('https://chatgpt.com/', { credentials: 'include' });
                return await res.text();
            } catch (_) {
                return document.documentElement ? document.documentElement.outerHTML : '';
            }
        }).catch(() => '');
        if (!html) return {};
        const out = {};
        let m;
        if ((m = html.match(/"webDeploymentAttestation"\s*:\s*"([^"]+)"/i))) out.webDeploymentAttestation = m[1];
        if ((m = html.match(/<html[^>]+data-build="([^"]+)"/i))) out.clientVersion = m[1];
        if ((m = html.match(/<html[^>]+data-seq="([^"]+)"/i))) out.clientBuildNumber = m[1];
        if ((m = html.match(/"sessionId"\s*:\s*"([^"]+)"/i))) out.oaiSessionId = m[1];
        return out;
    } catch (_) {
        return {};
    }
}

/**
 * 页面内发起 Checkout 请求（对齐官方接口契约）
 *
 * 官方前端从 chatgpt.com 页面内部用 fetch 调用该端点，因此请求带：
 * 真实 Chrome TLS 指纹 + 真实 Origin/Referer/User-Agent/sec-ch-ua 头 + 真实 Cookie。
 * 这些都无法在 Node 侧（context.request / axios）伪造，只有页面内 fetch 能天然满足。
 * 同时补上设备绑定 oai-device-id / oai-language / oai-session-id，
 * 以及 Sentinel / attestation / client-version 等前端原生头（extraHeaders）。
 */
async function createCheckoutViaPage(page, payload, accessToken, deviceId, extraHeaders = {}) {
    const token = String(accessToken || '').trim();
    const did = String(deviceId || '').trim();
    const sessionId = randomUUID();
    return page.evaluate(async (args) => {
        try {
            const headers = {
                'Content-Type': 'application/json',
                Accept: '*/*',
                'oai-language': 'en-US',
                'oai-session-id': args.sessionId,
                'x-openai-target-path': '/backend-api/payments/checkout',
                'x-openai-target-route': '/backend-api/payments/checkout'
            };
            if (args.token) headers.Authorization = `Bearer ${args.token}`;
            if (args.deviceId) headers['oai-device-id'] = args.deviceId;
            if (args.extraHeaders && typeof args.extraHeaders === 'object') {
                Object.assign(headers, args.extraHeaders);
            }
            const res = await fetch('https://chatgpt.com/backend-api/payments/checkout', {
                method: 'POST',
                headers,
                credentials: 'include',
                body: JSON.stringify(args.payload)
            });
            const text = await res.text();
            return { transport: 'page', ok: true, status: res.status, text };
        } catch (e) {
            return { transport: 'page', ok: false, error: String((e && e.message) || e) };
        }
    }, { payload, token, deviceId: did, sessionId, extraHeaders });
}

function formatApiErrorDetail(detail, fallback = '') {
    if (detail == null || detail === '') return fallback;
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail)) {
        return detail.map((item) => (typeof item === 'object' ? JSON.stringify(item) : String(item))).join('; ');
    }
    if (typeof detail === 'object') {
        if (detail.message) return String(detail.message);
        if (detail.msg) return String(detail.msg);
        return JSON.stringify(detail);
    }
    return String(detail);
}

function parseCheckoutApiResponse(status, bodyText) {
    let data = {};
    try {
        data = bodyText ? JSON.parse(bodyText) : {};
    } catch (_) {
        data = {};
    }

    if (status !== 200) {
        const detail = formatApiErrorDetail(
            data.detail ?? data.message ?? data.error,
            bodyText.slice(0, 500) || `HTTP ${status}`
        );
        return { ok: false, status, data, error: detail };
    }

    const service = new ChatGPTService(null, '');
    const resolved = service.resolveCheckoutUrl(data);
    if (!resolved.checkoutUrl) {
        return {
            ok: false,
            status,
            data,
            error: `API 未返回 checkout_session_id 或 url: ${JSON.stringify(data).slice(0, 300)}`
        };
    }

    return { ok: true, status, data, ...resolved };
}

/**
 * 使用 axios 直接调用 Checkout API（供后台调试 / 无 Playwright 场景）
 */
async function createHostedCheckoutLink({ accessToken, planType = 'plus', planName, country, currency, deviceId }) {
    const token = String(accessToken || '').trim();
    if (!token) {
        return { success: false, error: '缺少 AccessToken' };
    }

    const region = String(country || 'PH').toUpperCase();
    const billingCurrency = String(currency || getRegionConfig(region)?.currency || 'PHP').toUpperCase();
    const planNameResolved = String(planName || store.resolvePlanName(planType)).trim();
    const payload = buildCheckoutPayload(planNameResolved, region, billingCurrency);
    const resolvedDeviceId = String(deviceId || '').trim();

    const response = await axios.post(
        'https://chatgpt.com/backend-api/payments/checkout',
        payload,
        {
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'oai-language': 'en-US',
                'oai-session-id': randomUUID(),
                ...(resolvedDeviceId ? { 'oai-device-id': resolvedDeviceId } : {})
            },
            validateStatus: () => true,
            timeout: 30000
        }
    );

    const parsed = parseCheckoutApiResponse(response.status, JSON.stringify(response.data ?? {}));
    const base = {
        plan_type: planType,
        plan_name: planNameResolved,
        country: region,
        currency: billingCurrency,
        request: payload,
        response: parsed.data,
        http_status: parsed.status
    };

    if (!parsed.ok) {
        return { success: false, ...base, error: parsed.error };
    }

    return {
        success: true,
        ...base,
        url: parsed.checkoutUrl,
        session_id: parsed.sessionId
    };
}

/**
 * ChatGPT 订阅服务 — Stripe 信用卡直付版本
 *
 * 职责：
 * 1. 根据 plan_type 解析 plan_name（通过 store.resolvePlanName）
 * 2. 创建 Stripe Checkout Session（调用 OpenAI 后端 API）
 * 3. 协调卡池管理、免税地址、Stripe 表单自动化完成支付
 * 4. 委托 payment-retry.js 处理支付重试与卡片轮换逻辑
 * 5. 记录账单信息（成功/失败）
 */
class ChatGPTService {
    /**
     * @param {object} request - Playwright context.request 实例
     * @param {string} token - OpenAI Bearer Token
     * @param {object} [options] - { deviceId?: string }
     */
    constructor(request, token, options = {}) {
        this.request = request;
        this.token = token;
        const deviceId = String(options.deviceId || '').trim();
        this.headers = {
            "Authorization": `Bearer ${this.token}`,
            "Content-Type": "application/json",
            "Accept": "application/json",
            "oai-language": "en-US",
            "oai-session-id": randomUUID()
        };
        if (deviceId) {
            this.headers["oai-device-id"] = deviceId;
        }
    }

    /**
     * 从 checkout API 响应解析支付链接
     * custom 模式：用 checkout_session_id 拼 https://chatgpt.com/checkout/openai_llc/{id}
     * hosted 模式：优先使用 API 返回的 url
     */
    resolveCheckoutUrl(data) {
        if (!data || typeof data !== 'object') {
            return { sessionId: null, checkoutUrl: null };
        }

        const jsonText = JSON.stringify(data);
        const sessionId = data.checkout_session_id
            || data.session_id
            || jsonText.match(/cs_(?:live|test)_[A-Za-z0-9]+/)?.[0]
            || null;

        const apiUrl = String(data.url || '').trim();
        if (apiUrl.startsWith('http')) {
            return { sessionId, checkoutUrl: apiUrl };
        }

        if (sessionId) {
            return {
                sessionId,
                checkoutUrl: `https://chatgpt.com/checkout/openai_llc/${sessionId}`
            };
        }

        return { sessionId, checkoutUrl: null };
    }

    /**
     * 创建 Stripe Checkout Session，根据 plan_type 选择对应 plan_name
     * @param {string} planType - 'plus' | 'pro_5x' | 'pro_20x'
     * @param {string} country - ISO 3166-1 alpha-2 国家代码
     * @param {string} currency - 币种代码 (USD/SGD/MYR)
     * @param {string} [planNameOverride] - 可选，覆盖默认 plan_name
     * @returns {Promise<{ sessionId: string|null, checkoutUrl: string|null, error?: string }>}
     */
    async createCheckoutSession(planType, country, currency, planNameOverride) {
        try {
            const planName = String(planNameOverride || store.resolvePlanName(planType)).trim();
            const payload = buildCheckoutPayload(planName, country, currency);
            console.log(`[ChatGPT] 创建 Checkout Session: plan_name=${planName}, country=${country}, currency=${currency}, checkout_ui_mode=${payload.checkout_ui_mode}`);

            const response = await this.request.post("https://chatgpt.com/backend-api/payments/checkout", {
                headers: this.headers,
                data: payload
            });

            const bodyText = await response.text().catch(() => "");
            const parsed = parseCheckoutApiResponse(response.status(), bodyText);

            if (!parsed.ok) {
                const detail = parsed.error;
                console.error(`[-] 订单创建失败 (Status: ${parsed.status})`);
                console.error(`    响应: ${detail}`);
                if (String(detail).includes('not_eligible') || String(detail).includes('Offer not found')) {
                    console.error("❌ [提示] 该账号不符合当前套餐/地区订阅条件");
                } else if (String(detail).includes('permission') || String(detail).includes('already_subscribed')) {
                    console.error("❌ [提示] 该账号可能已订阅或无权重复开通");
                }
                return { sessionId: null, checkoutUrl: null, error: detail };
            }

            console.log(`✅ 订单创建成功 (session: ${parsed.sessionId ? parsed.sessionId.slice(0, 24) + '...' : 'unknown'})`);
            if (parsed.checkoutUrl) {
                console.log(`    支付链接: ${parsed.checkoutUrl.slice(0, 120)}...`);
            }
            return { sessionId: parsed.sessionId, checkoutUrl: parsed.checkoutUrl };
        } catch (e) {
            console.error("[-] 创建 Checkout Session 异常:", e.message);
            return { sessionId: null, checkoutUrl: null, error: e.message };
        }
    }

    /**
     * @deprecated 请使用 createCheckoutSession 返回的 checkoutUrl
     */
    buildCheckoutUrl(checkoutSessionId) {
        if (!checkoutSessionId) {
            return null;
        }
        return `https://pay.openai.com/c/pay/${checkoutSessionId}`;
    }

    /**
     * 完整的 Stripe 信用卡支付流程
     *
     * 委托 payment-retry.js 处理卡片轮换和重试逻辑：
     * - 从卡池分配卡片（store.reserveCard）
     * - 填写 Stripe 表单（completeStripeCardPayment）
     * - 表单校验失败 → 同卡重试最多 2 次
     * - Stripe 拒绝 → 标记卡片报废，换卡
     * - 连续 3 张卡失败 → 终止，status='payment_failed'
     * - 记录账单（store.createBillingRecord）
     *
     * @param {import('playwright').Page} page - Playwright Page 实例
     * @param {object} options
     * @param {string} options.planType - 'plus' | 'pro_5x' | 'pro_20x'
     * @param {string} [options.cdkCode] - 关联的 CDK 码
     * @param {string} [options.email] - 关联的邮箱
     * @returns {Promise<{ success: boolean, error?: string, status?: string }>}
     */
    async processStripePayment(page, options = {}) {
        const { planType = 'plus', cdkCode = null, email = null } = options;

        console.log(`[ChatGPT] 启动 Stripe 信用卡支付流程 (plan: ${planType})`);

        // 委托 payment-retry.js 处理完整的支付重试逻辑
        // 包含：地区配置获取、免税地址选取、卡池分配、表单填写、重试换卡、账单记录
        const result = await executePaymentWithRetry(page, { planType, cdkCode, email });

        if (result.success) {
            console.log(`✅ [ChatGPT] 支付成功！`);
        } else {
            console.error(`❌ [ChatGPT] 支付失败: ${result.error}`);
        }

        return result;
    }

    /**
     * 根据 plan_type 和 currency 获取预估金额
     * 用于外部调用方查询参考价格
     * @param {string} planType - 'plus' | 'pro_5x' | 'pro_20x'
     * @param {string} currency - 币种代码
     * @returns {number} 预估金额
     */
    getPlanAmount(planType, currency) {
        // 基础美元定价
        const baseAmounts = {
            plus: 20.00,
            pro_5x: 100.00,
            pro_20x: 200.00
        };
        const amount = baseAmounts[planType] || baseAmounts.plus;

        // 非 USD 币种的简单转换（实际金额由 Stripe 返回，这里仅用于记录参考）
        if (currency === 'SGD') return Math.round(amount * 1.35 * 100) / 100;
        if (currency === 'MYR') return Math.round(amount * 4.50 * 100) / 100;
        if (currency === 'PHP') return Math.round(amount * 56 * 100) / 100;
        return amount;
    }
}

/**
 * 端到端 Stripe 信用卡支付入口函数
 *
 * 用户流程：CDK → GPT session token → 自动支付
 * 此函数封装完整流程：创建 Checkout Session → 导航到 Stripe 页面 → 执行支付（含重试换卡）
 *
 * @param {object} params
 * @param {import('playwright').Page} params.page - Playwright Page 实例
 * @param {string} params.accessToken - OpenAI Bearer Token（用于创建 checkout session）
 * @param {string} params.planType - 'plus' | 'pro_5x' | 'pro_20x'
 * @param {string} [params.cdkCode] - 关联的 CDK 码
 * @param {string} [params.email] - 关联的邮箱
 * @param {function} [params.onProgress] - 进度回调 (message: string) => void
 * @returns {Promise<{ success: boolean, error?: string, sessionId?: string }>}
 */
async function activateSubscription({ page, accessToken, planType, cdkCode, email, onProgress }) {
    const notify = typeof onProgress === 'function' ? onProgress : () => {};

    // Step 1: Resolve billing region and currency
    const region = await store.getPaymentRegion();
    const regionConfig = getRegionConfig(region);
    if (!regionConfig) {
        return { success: false, error: `不支持的支付地区: ${region}` };
    }
    const { currency } = regionConfig;
    const country = region;

    notify(`地区: ${region}, 币种: ${currency}, 套餐: ${planType}`);

    // Step 2: Create Checkout Session via OpenAI API
    notify('正在创建 Stripe Checkout Session...');
    const gpt = new ChatGPTService(page.context().request, accessToken);
    const checkout = await gpt.createCheckoutSession(planType, country, currency);

    if (!checkout.checkoutUrl) {
        return { success: false, error: '无法获取支付链接 (createCheckoutSession 失败)' };
    }

    // Step 3: Navigate to Stripe Checkout URL
    const checkoutUrl = checkout.checkoutUrl;
    notify('正在打开 Stripe Checkout 页面...');

    await page.goto(checkoutUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

    notify('Checkout 页面已打开，开始信用卡支付...');

    // Step 4: Execute payment with card pool retry logic
    const result = await executePaymentWithRetry(page, { planType, cdkCode, email });

    if (result.success) {
        notify('支付成功！');
        return { success: true, sessionId: checkout.sessionId };
    }

    return { success: false, error: result.error, sessionId: checkout.sessionId };
}

/**
 * 判断 Checkout 页面是否已正常加载（避免 body 里 incidental "404" 误报）
 */
async function assertCheckoutPageReady(page) {
    const { isCloudflareWallPage, isCheckoutPaymentReady } = require('./human-verification');
    const currentUrl = page.url();
    const pageText = String(await page.textContent('body', { timeout: 8000 }).catch(() => '') || '');
    const title = String(await page.title().catch(() => '') || '');

    if (await isCloudflareWallPage(page)) {
        throw new Error('Checkout 页面仍被 Cloudflare 人机验证拦截');
    }

    if (await isCheckoutPaymentReady(page)) {
        return currentUrl;
    }

    const checkoutReady = /Configure your plan|Subscribe|Plus plan|Pro plan|Due today|Card number|Expiration date|Security code|Monthly subscription/i.test(pageText);

    if (checkoutReady) {
        return currentUrl;
    }

    if (/Page not found|could not be found|Something went wrong|contact the merchant/i.test(pageText)) {
        throw new Error(`支付链接无效: ${currentUrl.slice(0, 120)}`);
    }

    if (/accounts\.google\.com|auth\.openai\.com/i.test(currentUrl)) {
        throw new Error(`Checkout 跳转到登录页: ${currentUrl.slice(0, 80)}`);
    }

    if (/^404(\s|$)/.test(title.trim())) {
        throw new Error(`支付链接无效 (404): ${currentUrl.slice(0, 120)}`);
    }

    throw new Error(`无法确认 Checkout 支付表单已加载: ${currentUrl.slice(0, 120)}`);
}

/**
 * 通过 API 注入 billing_details 创建 Checkout，并打开 chatgpt.com/checkout
 */
async function openApiCheckout(page, { accessToken, planType, country, currency, planNameOverride, verifyPage = true, proxyUrl = '' }) {
    const { assertChatGptLoggedIn } = require('./session-auth');
    const token = String(accessToken || '').trim();
    if (!token) {
        throw new Error('缺少 AccessToken，无法调用 Checkout API');
    }

    const region = String(country || 'PH').toUpperCase();
    const billingCurrency = String(currency || getRegionConfig(region)?.currency || 'PHP').toUpperCase();
    console.log(`🧭 [步骤] 正在通过 API 创建 Checkout (country=${region}, currency=${billingCurrency}, plan=${planType})...`);

    // 设备绑定 + 会话 cookie 头：从浏览器 context 取
    let deviceId = '';
    let cookieHeader = '';
    try {
        const cookies = await page.context().cookies('https://chatgpt.com').catch(() => []);
        const list = cookies || [];
        const oaiDid = list.find((c) => c.name === 'oai-did');
        if (oaiDid && oaiDid.value) deviceId = oaiDid.value;
        cookieHeader = list.map((c) => `${c.name}=${c.value}`).join('; ');
    } catch (_) { /* 缺失时留空，不致命 */ }
    if (deviceId) {
        console.log(`[ChatGPT] 设备绑定 oai-device-id: ${deviceId.slice(0, 8)}...`);
    } else {
        console.warn('[ChatGPT] 未找到 oai-did Cookie，checkout 请求将不带 oai-device-id（可能触发风控）');
    }

    const gpt = new ChatGPTService(page.context().request, token, { deviceId });
    const planName = String(planNameOverride || store.resolvePlanName(planType)).trim();
    const payload = buildCheckoutPayload(planName, region, billingCurrency);
    console.log(`[ChatGPT] Checkout 实现版本: ${CHECKOUT_IMPL_VERSION} (transport=page, 真实 TLS + Sentinel)`);

    // 前端上下文：attestation / client-version / build-number（实时抓页面）
    let frontendContext = {};
    try {
        frontendContext = await bootstrapFrontendContext(page);
        console.log(`[ChatGPT] 前端上下文: client-version=${frontendContext.clientVersion || '?'} attestation=${frontendContext.webDeploymentAttestation ? '有' : '无'}`);
    } catch (e) {
        console.warn(`[ChatGPT] 前端上下文提取失败: ${e.message}`);
    }

    // Sentinel PoW：Node bridge 跑真实 sdk.js（curl 走 SOCKS5 直连）
    let sentinelHeaders = {};
    try {
        const ua = await page.evaluate(() => navigator.userAgent).catch(() => '');
        const sentinel = await mintSentinelToken({
            deviceId,
            userAgent: ua,
            flow: 'chatgpt_checkout',
            proxy: proxyUrl,
            cookieHeader,
            pageUrl: 'https://chatgpt.com/',
        });
        sentinelHeaders['OpenAI-Sentinel-Token'] = sentinel.main;
        sentinelHeaders['OAI-Telemetry'] = '[1,null]';
        if (sentinel.so) sentinelHeaders['OpenAI-Sentinel-So-Token'] = sentinel.so;
        console.log(`[ChatGPT] Sentinel 已生成 (main ${sentinel.main.length} 字符${sentinel.hasSo ? '，含 so-token' : ''})`);
    } catch (e) {
        console.warn(`[ChatGPT] Sentinel 生成失败（将不带 sentinel 直调，大概率被风控）: ${e.message}`);
    }

    const extraHeaders = {
        ...(frontendContext.clientVersion ? { 'oai-client-version': frontendContext.clientVersion } : {}),
        ...(frontendContext.clientBuildNumber ? { 'oai-client-build-number': frontendContext.clientBuildNumber } : {}),
        ...(frontendContext.webDeploymentAttestation ? { 'oai-web-deployment-attestation': frontendContext.webDeploymentAttestation } : {}),
        ...sentinelHeaders,
    };

    let checkout = null;
    // 首选：页面内 fetch → 真实 Chrome TLS + 真实浏览器头 + Sentinel/attestation（官方接口契约）
    const inPage = await createCheckoutViaPage(page, payload, token, deviceId, extraHeaders);
    if (inPage.ok) {
        const parsed = parseCheckoutApiResponse(inPage.status, inPage.text);
        if (parsed.ok) {
            console.log(`✅ 订单创建成功 (session: ${parsed.sessionId ? parsed.sessionId.slice(0, 24) + '...' : 'unknown'})`);
            checkout = { sessionId: parsed.sessionId, checkoutUrl: parsed.checkoutUrl };
        } else {
            // 风控/业务拒绝：不回退重发，避免叠加风险标记
            console.error(`[-] 订单创建失败 (Status: ${parsed.status}, transport=page)`);
            console.error(`    响应: ${parsed.error}`);
            checkout = { sessionId: null, checkoutUrl: null, error: parsed.error };
        }
    } else {
        console.warn(`[Warn] 页面内 fetch 异常，回退 Node 请求: ${inPage.error}`);
    }

    // 回退：Node 侧请求（仅在页面内请求本身抛错时使用）
    if (!checkout) {
        checkout = await gpt.createCheckoutSession(planType, region, billingCurrency, planNameOverride);
    }

    if (!checkout.checkoutUrl) {
        throw new Error(`API 创建 Checkout 失败: ${checkout.error || '未返回 data.url'}`);
    }

    const url = checkout.checkoutUrl;
    console.log(`🔗 [步骤] 正在打开支付链接: ${url.slice(0, 120)}...`);

    if (!verifyPage) {
        console.log('✅ [步骤] Checkout Session 已创建（跳过页面打开验证）');
        return { checkoutUrl: url, sessionId: checkout.sessionId };
    }

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2000);

    const { hasVisibleLoginChrome, isCheckoutLoginGate, buildSessionNotLoggedInError } = require('./auth-page-detect');
    if (await isCheckoutLoginGate(page) || await hasVisibleLoginChrome(page)) {
        const title = await page.title().catch(() => '');
        console.error(`[Checkout] 打开后仍为未登录 UI url=${page.url().slice(0, 100)} title=${title}`);
        throw new Error(buildSessionNotLoggedInError('Checkout 支付页'));
    }

    const { clearHumanVerification, buildCaptchaRequiredError } = require('./human-verification');
    const captchaResult = await clearHumanVerification(page, {
        phase: 'checkout-open',
        maxWaitMs: Number(process.env.CAPTCHA_CLEAR_TIMEOUT_MS || 120000),
        maxBypassRounds: 6,
        requireCheckoutReady: true,
        checkoutReadyWaitMs: Number(process.env.CHECKOUT_READY_WAIT_MS || 60000)
    });
    if (!captchaResult.cleared) {
        const err = captchaResult.sessionRequired
            ? (captchaResult.message || buildSessionNotLoggedInError('Checkout 支付页'))
            : captchaResult.checkoutNotReady
                ? 'Checkout 支付表单未能加载，请检查网络或稍后重试'
                : buildCaptchaRequiredError();
        throw new Error(err);
    }

    const currentUrl = await assertCheckoutPageReady(page);

    await assertChatGptLoggedIn(page, 'Checkout');
    console.log(`✅ [步骤] Checkout 页面已打开: ${currentUrl.slice(0, 100)}...`);
    return { checkoutUrl: currentUrl, sessionId: checkout.sessionId };
}

module.exports = ChatGPTService;
module.exports.ChatGPTService = ChatGPTService;
module.exports.activateSubscription = activateSubscription;
module.exports.openApiCheckout = openApiCheckout;
module.exports.createHostedCheckoutLink = createHostedCheckoutLink;
module.exports.buildCheckoutPayload = buildCheckoutPayload;
module.exports.formatApiErrorDetail = formatApiErrorDetail;
