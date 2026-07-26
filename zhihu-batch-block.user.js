// ==UserScript==
// @name         Block Zhihu User
// @namespace    http://tampermonkey.net/
// @version      2026-07-25
// @description  Better Zhihu
// @author       maxkk26
// @match        https://zhihu.com
// @mach         https://zhuanlan.zhihu.com
// @mach         https://www.zhihu.com
// @icon         data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // ====== 已拉黑用户追踪（localStorage 持久化 + 快速 Set） ======
    const BLOCKED_KEY = 'zhihu_blocked_users';

    function loadBlockedUsers() {
        try {
            return JSON.parse(localStorage.getItem(BLOCKED_KEY) || '[]');
        } catch (e) {
            return [];
        }
    }

    function saveBlockedUser(userToken, userName) {
        const list = loadBlockedUsers();
        if (!list.some(u => u.token === userToken)) {
            list.push({ token: userToken, name: userName, time: Date.now() });
            localStorage.setItem(BLOCKED_KEY, JSON.stringify(list));
        }
    }

    // 当前会话中的已拉黑 token 集合（快速查找，避免频繁读 localStorage）
    const blockedTokens = new Set(loadBlockedUsers().map(u => u.token));

    // 从本地拉黑列表中移除指定用户
    function removeBlockedUser(userToken) {
        blockedTokens.delete(userToken);
        const list = loadBlockedUsers().filter(u => u.token !== userToken);
        localStorage.setItem(BLOCKED_KEY, JSON.stringify(list));
    }

    // 已验证的拉黑状态缓存（避免重复请求）
    const verifiedBlockCache = new Map();

    // 验证用户是否真的被知乎拉黑（异步，会从知乎 API 同步真实状态）
    async function verifyBlockedStatus(userToken) {
        if (verifiedBlockCache.has(userToken)) {
            return verifiedBlockCache.get(userToken);
        }

        // 如果在个人主页，尝试从页面 __INITIAL_STATE__ 获取
        const profileMatch = location.href.match(/https:\/\/www\.zhihu\.com\/people\/([^/?&]+)/);
        if (profileMatch && profileMatch[1] === userToken) {
            try {
                const state = window.__INITIAL_STATE__;
                if (state) {
                    const isBlocked = state?.people?.profile?.isBlocked ??
                                      state?.people?.isBlocked ??
                                      state?.profile?.isBlocked;
                    if (typeof isBlocked === 'boolean') {
                        verifiedBlockCache.set(userToken, isBlocked);
                        return isBlocked;
                    }
                }
            } catch (e) {}
        }

        // 通过知乎 API 获取用户关系状态
        try {
            const resp = await fetch(
                `https://www.zhihu.com/api/v4/members/${userToken}?include=is_blocked`,
                {
                    credentials: 'include',
                    headers: {
                        'Accept': 'application/json',
                        'X-Requested-With': 'XMLHttpRequest'
                    }
                }
            );
            if (resp.ok) {
                const data = await resp.json().catch(() => ({}));
                const isBlocked = data.is_blocked === true || data.blocking === true;
                verifiedBlockCache.set(userToken, isBlocked);
                return isBlocked;
            }
        } catch (e) {}

        // 无法确定，回退到本地缓存
        verifiedBlockCache.set(userToken, blockedTokens.has(userToken));
        return blockedTokens.has(userToken);
    }

    // ---------- 检测知乎深色模式 ----------
    function getThemeMode() {
        const urlTheme = new URLSearchParams(location.search).get('theme');
        if (urlTheme === 'dark' || urlTheme === 'light') {
            return urlTheme;
        }

        const cookieMatch = document.cookie.match(/(?:^|;\s*)zhihu_theme=([^;]+)/);
        if (cookieMatch) {
            const cookieTheme = decodeURIComponent(cookieMatch[1]).toLowerCase();
            if (cookieTheme === 'dark' || cookieTheme === 'light') {
                return cookieTheme;
            }
        }

        return document.documentElement.getAttribute('data-theme') === 'dark' ||
               document.documentElement.classList.contains('dark') ||
               window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }

    function isDarkMode() {
        return getThemeMode() === 'dark';
    }

    function setThemeMode(mode) {
        const normalizedMode = mode === 'dark' ? 'dark' : 'light';
        const expires = '; max-age=31536000; path=/';
        const domain = location.hostname.endsWith('zhihu.com') ? '; domain=.zhihu.com' : '';
        document.cookie = `zhihu_theme=${normalizedMode}${expires}${domain}`;

        const url = new URL(location.href);
        url.searchParams.set('theme', normalizedMode);
        window.location.href = url.toString();
    }

    // ====== 知乎直答链接处理 ======

    function getZhidaMode() {
        const cookieMatch = document.cookie.match(/(?:^|;\s*)zhihu_zhida_mode=([^;]+)/);
        if (cookieMatch) {
            const mode = decodeURIComponent(cookieMatch[1]);
            if (mode === 'google' || mode === 'plain') return mode;
        }
        return 'disabled';
    }

    function setZhidaMode(mode) {
        const expires = '; max-age=31536000; path=/';
        const domain = location.hostname.endsWith('zhihu.com') ? '; domain=.zhihu.com' : '';
        document.cookie = `zhihu_zhida_mode=${mode}${expires}${domain}`;
    }

    const zhidaModeLabels = { disabled: '禁用', google: 'Google搜索', plain: '纯文本' };
    const zhidaModeCycle = ['disabled', 'google', 'plain'];

    function applyZhidaMode(mode) {
        if (mode === 'disabled') return;
        const selector = 'a.RichContent-EntityWord[href*="zhida.zhihu.com"], a[href*="zhida.zhihu.com"]';
        document.querySelectorAll(selector).forEach(el => {
            if (el.dataset.zhidaProcessed) return;
            el.dataset.zhidaProcessed = 'true';

            if (mode === 'google') {
                const query = el.textContent.trim();
                el.href = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
                el.target = '_blank';
                el.rel = 'noopener noreferrer';
            } else if (mode === 'plain') {
                const text = el.textContent;
                const span = document.createElement('span');
                span.textContent = text;
                span.style.cssText = window.getComputedStyle(el).cssText;
                el.parentNode.replaceChild(span, el);
            }
        });
    }

    // ====== 专栏优化状态持久化 ======

    function getZhuanlanOptimized() {
        const cookieMatch = document.cookie.match(/(?:^|;\s*)zhihu_zhuanlan_optimized=([^;]+)/);
        return cookieMatch && decodeURIComponent(cookieMatch[1]) === 'true';
    }

    function setZhuanlanOptimizedCookie(value) {
        const expires = '; max-age=31536000; path=/';
        const domain = location.hostname.endsWith('zhihu.com') ? '; domain=.zhihu.com' : '';
        document.cookie = `zhihu_zhuanlan_optimized=${value}${expires}${domain}`;
    }

    // ---------- 获取深色模式下的信息框样式 ----------
    function getInfoDivStyle() {
        const dark = isDarkMode();
        return `
            position: fixed; top: 10px; right: 10px; z-index: 9999;
            background: ${dark ? '#2d2d2d' : '#fff'}; color: ${dark ? '#e0e0e0' : '#000'};
            padding: 12px 20px;
            border-radius: 4px; font-family: '微软雅黑', sans-serif; font-size: 14px;
            max-height: 500px; overflow: hidden;
            width: 420px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.3);
            border: 1px solid ${dark ? '#555' : '#999'};
            display: flex; flex-direction: column;
        `;
    }

    // 获取 XSRF Token（CSRF 防护）
    function getXsrfToken() {
        const match = document.cookie.match(/xsrf=([^;]+)/);
        return match ? match[1] : '';
    }

    // ---------- 拉黑单个用户（带 CSRF Token 和备用 API） ----------
    async function blockUser(userToken) {
        let xsrfToken = getXsrfToken();
        if (!xsrfToken) {
            // 部分版本知乎使用 _xsrf cookie，再试一次
            const match = document.cookie.match(/[;]?\s*_xsrf=([^;]+)/);
            xsrfToken = match ? match[1] : '';
            if (!xsrfToken) {
                console.warn('未找到 xsrf/_xsrf cookie，CSRF token 为空，拉黑请求可能被拒绝');
            }
        }
        const headers = {
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            'x-xsrftoken': xsrfToken
        };

        // 尝试主接口：/actions/block
        const primaryUrl = `https://www.zhihu.com/api/v4/members/${userToken}/actions/block`;
        const primaryResponse = await fetch(primaryUrl, {
            method: 'POST',
            credentials: 'include',
            headers: headers
        });

        if (primaryResponse.ok) {
            return primaryResponse;
        }

        // 主接口失败，尝试备用接口：/block
        const fallbackUrl = `https://www.zhihu.com/api/v4/members/${userToken}/block`;
        const fallbackResponse = await fetch(fallbackUrl, {
            method: 'POST',
            credentials: 'include',
            headers: headers
        });

        return fallbackResponse;
    }

    // ---------- 工具函数 ----------
    const fetchWithCreds = (url, options = {}) => {
        return fetch(url, {
            ...options,
            credentials: 'include',
            headers: {
                'Accept': 'application/json',
                'X-Requested-With': 'XMLHttpRequest',
                'Referer': location.href,
                ...(options.headers || {})
            }
        });
    };

    const safeJson = async (response) => {
        if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }
        const text = await response.text();
        if (!text) return null;
        try {
            return JSON.parse(text);
        } catch (e) {
            console.warn('JSON parse failed:', text.substring(0, 200));
            throw new Error('JSON parse failed: ' + e.message);
        }
    };

    async function getCurrentUserId() {
        try {
            if (window.__INITIAL_STATE__?.config?.currentUser?.urlToken) {
                const userId = window.__INITIAL_STATE__.config.currentUser.urlToken;
                console.log(`Auto detected user ID: ${userId}`);
                return userId;
            }
        } catch (e) {}

        try {
            const response = await fetchWithCreds('https://www.zhihu.com/api/v4/me');
            const data = await safeJson(response);
            if (data && data.url_token) {
                console.log(`Got user ID via API: ${data.url_token}`);
                return data.url_token;
            }
        } catch (e) {
            console.warn('Failed to get user info via API:', e);
        }

        const manualInput = prompt('无法自动检测用户ID，请手动输入你的知乎用户ID（url_token）：');
        if (manualInput) {
            console.log(`Manual input: ${manualInput}`);
            return manualInput;
        }
        return null;
    }

    // 获取所有关注/粉丝ID（白名单）
    async function getAllUserIds(apiUrl) {
        let allIds = new Set();
        let offset = 0;
        const limit = 20;
        let isEnd = false;

        while (!isEnd) {
            const url = `${apiUrl}?limit=${limit}&offset=${offset}`;
            try {
                const response = await fetchWithCreds(url);
                const data = await safeJson(response);
                if (!data) break;
                const users = data.data || [];
                users.forEach(user => allIds.add(String(user.id)));
                isEnd = data.paging && data.paging.is_end;
                offset += limit;
            } catch (e) {
                console.error(`Failed to fetch data (${url}):`, e);
                break;
            }
        }
        return allIds;
    }

    // ---------- 核心拉黑流程（抽取公用，供不同入口调用） ----------
    async function executeBlockFlow({ apiCandidates, sourceLabel }) {
        const MY_USER_ID = await getCurrentUserId();
        if (!MY_USER_ID) {
            console.error('Cannot get user ID, abort.');
            return;
        }

        // 白名单
        const followees = await getAllUserIds(`https://www.zhihu.com/api/v4/members/${MY_USER_ID}/followees`);
        const followers = await getAllUserIds(`https://www.zhihu.com/api/v4/members/${MY_USER_ID}/followers`);
        const safeUserIds = new Set([...followees, ...followers]);

        // UI 进度框
        const infoDiv = document.createElement('div');
        infoDiv.style.cssText = getInfoDivStyle();
        document.body.appendChild(infoDiv);

        const logArea = document.createElement('div');
        logArea.style.cssText = 'flex: 1; overflow-y: auto; white-space: pre-wrap; padding-bottom: 8px;';
        infoDiv.appendChild(logArea);

        const btnContainer = document.createElement('div');
        btnContainer.style.textAlign = 'center';
        const stopBtn = document.createElement('button');
        stopBtn.textContent = '停止';
        stopBtn.style.padding = '4px 16px';
        btnContainer.appendChild(stopBtn);
        infoDiv.appendChild(btnContainer);

        let shouldStop = false;
        stopBtn.addEventListener('click', () => {
            shouldStop = true;
            console.log('用户请求停止');
        });

        function appendLog(html) {
            logArea.innerHTML += html + '<br>';
            logArea.scrollTop = logArea.scrollHeight;
        }

        function tokenLink(userToken) {
            return `<a href="https://www.zhihu.com/people/${userToken}" target="_blank">${userToken}</a>`;
        }

        appendLog('正在获取你的关注和粉丝列表（白名单）...');
        appendLog(`白名单人数：${safeUserIds.size} 人（关注 + 粉丝）`);
        appendLog('─────────────────────────────');

        const blockedUsers = [];

        // 跨排序去重集合：记录所有排序中已经处理过的用户 token
        const processedTokens = new Set();

        let currentApiIndex = 0;
        let votersApi = apiCandidates[0];
        let pageOffset = 0;
        let reachedLastPage = false;
        let handledUsers = 0;
        let estimatedUsers = 0;

        while (!shouldStop) {
            const requestUrl = `${votersApi}?limit=10&offset=${pageOffset}`;
            try {
                const listResponse = await fetchWithCreds(requestUrl);
                const listPayload = await safeJson(listResponse);
                if (!listPayload) {
                    if (currentApiIndex < apiCandidates.length - 1) {
                        currentApiIndex++;
                        votersApi = apiCandidates[currentApiIndex];
                        pageOffset = 0;
                        reachedLastPage = false;
                        appendLog(`已切换到备用 API：${votersApi}`);
                        continue;
                    } else {
                        appendLog('所有 API 返回空数据，终止执行');
                        break;
                    }
                }
                const voterList = listPayload.data || [];
                // 过滤掉其他排序中已处理过的用户，避免重复
                const newVoters = voterList.filter(v => !processedTokens.has(v.url_token));
                estimatedUsers += voterList.length;

                for (const voterInfo of voterList) {
                    if (shouldStop) {
                        appendLog('用户已停止');
                        break;
                    }

                    // 跨排序去重：标记此用户已被处理
                    processedTokens.add(voterInfo.url_token);

                    handledUsers++;
                    const userId = voterInfo.id;
                    const userName = voterInfo.name;
                    const userToken = voterInfo.url_token;
                    const profileUrl = `https://www.zhihu.com${voterInfo.url}`;

                    // 只跳过白名单，不再进行小号判断
                    if (safeUserIds.has(String(userId))) {
                        appendLog(`已跳过（白名单）：${userName} (${tokenLink(userToken)}) [${handledUsers}/${estimatedUsers}]`);
                        continue;
                    }

                    // 已拉黑用户标记后跳过
                    if (blockedTokens.has(userToken)) {
                        appendLog(`${userName}（已屏蔽）(${tokenLink(userToken)}) [${handledUsers}/${estimatedUsers}]`);
                        continue;
                    }

                    // 直接拉黑
                    const actionResponse = await blockUser(userToken);
                    if (actionResponse.ok) {
                        blockedUsers.push({ userName, userToken, profileUrl });
                        // 记录已拉黑用户
                        saveBlockedUser(userToken, userName);
                        blockedTokens.add(userToken);
                        const msg = `已屏蔽：${userName} (${tokenLink(userToken)}) [${handledUsers}/${estimatedUsers}]`;
                        appendLog(msg);
                        // ---- 控制台显示拉黑进度 ----
                        console.log(`[已拉黑] ${userName} - 主页：https://www.zhihu.com/people/${userToken}`);
                    } else {
                        const errText = await actionResponse.text().catch(() => '');
                        appendLog(`失败：${userName} (${tokenLink(userToken)}) 状态 ${actionResponse.status}`);
                        console.warn(`拉黑失败 ${userName}: ${actionResponse.status} - ${errText}`);
                    }
                }

                if (shouldStop) break;

                if (listPayload.paging && listPayload.paging.is_end) {
                    // 当前排序已到末尾，尝试下一个 API 候选
                    if (currentApiIndex < apiCandidates.length - 1) {
                        currentApiIndex++;
                        votersApi = apiCandidates[currentApiIndex];
                        pageOffset = 0;
                        appendLog(`当前排序已拉取完毕，切换到下一个 API 以获取更多用户：${votersApi}`);
                        continue;
                    } else {
                        reachedLastPage = true;
                        break;
                    }
                }
                pageOffset += 10;
            } catch (err) {
                console.error('主循环错误：', err);
                const is404or405 = err.message && (err.message.includes('404') || err.message.includes('405'));
                if (is404or405 && currentApiIndex < apiCandidates.length - 1) {
                    currentApiIndex++;
                    votersApi = apiCandidates[currentApiIndex];
                    pageOffset = 0;
                    const code = err.message.includes('404') ? '404' : '405';
                    appendLog(`遇到 ${code} 错误，已切换到备用 API：${votersApi}`);
                    continue;
                } else {
                    break;
                }
            }
        }

        if (shouldStop) {
            appendLog('用户已停止，未完全完成。');
        }
        appendLog(`执行完毕！共拉黑：${blockedUsers.length} 人`);
        console.log(`====== 已拉黑用户 (${sourceLabel}) ======`);
        console.table(blockedUsers);
        console.log('总拉黑数：', blockedUsers.length);
    }

    // ---------- 拉黑点赞者（原 answer/article 页面入口） ----------
    async function blockUpvoters() {
        const pageHref = location.href;
        let apiCandidates = [];
        let contentType = '';
        let contentId = '';

        const answerMatch = pageHref.match(/^https:\/\/www\.zhihu\.com\/question\/(\d+)\/answer\/(\d+)/);
        const articleMatch = pageHref.match(/^https:\/\/zhuanlan\.zhihu\.com\/p\/(\d+)/);

        if (answerMatch) {
            contentType = 'answer';
            contentId = answerMatch[2];
            // 两个排序：default（按粉丝量，默认）和 newest（按点赞时间），分别可获取最多约2000人，合并后可达约4000人
            apiCandidates = [
                `https://www.zhihu.com/api/v4/answers/${contentId}/upvoters?order=default`,
                `https://www.zhihu.com/api/v4/answers/${contentId}/upvoters?order=newest`
            ];
        } else if (articleMatch) {
            contentType = 'article';
            contentId = articleMatch[1];
            apiCandidates = [
                `https://www.zhihu.com/api/v4/articles/${contentId}/voters?order=default`,
                `https://www.zhihu.com/api/v4/articles/${contentId}/voters?order=newest`,
                `https://www.zhihu.com/api/v4/articles/${contentId}/likers?order=default`,
                `https://www.zhihu.com/api/v4/articles/${contentId}/likers?order=newest`
            ];
        } else {
            alert('当前页面不是知乎回答或文章，无法使用此功能。');
            return;
        }

        await executeBlockFlow({
            apiCandidates,
            sourceLabel: `${contentType} upvoters`
        });
    }

    // ---------- 拉黑指定回答的点赞者（问题页面按钮使用） ----------
    async function blockAnswerUpvoters(answerId) {
        // 两种排序：default（按粉丝量）和 newest（按点赞时间），合并可达约4000人
        await executeBlockFlow({
            apiCandidates: [
                `https://www.zhihu.com/api/v4/answers/${answerId}/upvoters?order=default`,
                `https://www.zhihu.com/api/v4/answers/${answerId}/upvoters?order=newest`
            ],
            sourceLabel: `answer #${answerId} upvoters`
        });
    }

    // ---------- 在每个回答操作栏「分享」右侧添加「🚫拉黑」按钮 ----------
    function addBlockButtonsToActionBar() {
        if (!/^https:\/\/www\.zhihu\.com\/question\/\d+$/.test(location.href)) return;

        document.querySelectorAll('.AnswerItem, [data-za-module="AnswerItem"]').forEach(card => {
            if (card.querySelector('.zhihu-block-action-btn')) return;

            const answerId = extractAnswerId(card);
            if (!answerId) return;

            const actionsBar = card.querySelector('.ContentItem-actions');
            if (!actionsBar) return;

            // 找到「分享」按钮（文本包含「分享」的元素）
            const allActions = [...actionsBar.querySelectorAll('button, a, [role="button"], .ContentItem-action')];
            const shareBtn = allActions.find(el => el.textContent.includes('分享'));
            if (!shareBtn) return;

            const btn = document.createElement('button');
            btn.className = 'zhihu-block-action-btn';
            btn.innerHTML = '🚫拉黑';
            btn.style.cssText = `
                margin-left: 8px;
                padding: 0 10px;
                height: 28px;
                background: #999;
                color: #fff;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                font-size: 13px;
                font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', 'PingFang SC', 'Microsoft YaHei', sans-serif;
                line-height: 28px;
                white-space: nowrap;
                vertical-align: middle;
                opacity: 0.85;
                transition: background 0.15s, opacity 0.15s;
            `;
            btn.addEventListener('mouseenter', () => { btn.style.background = '#777'; btn.style.opacity = '1'; });
            btn.addEventListener('mouseleave', () => { btn.style.background = '#999'; btn.style.opacity = '0.85'; });
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (btn.disabled) return;
                btn.innerHTML = '⏳执行中...';
                btn.disabled = true;
                btn.style.background = '#bbb';
                blockAnswerUpvoters(answerId).finally(() => {
                    btn.innerHTML = '🚫拉黑';
                    btn.disabled = false;
                    btn.style.background = '#999';
                });
            });

            shareBtn.insertAdjacentElement('afterend', btn);
        });
    }

    // 从回答元素中提取回答ID
    function extractAnswerId(card) {
        // 尝试 data-zop 属性（Zhihu 常用，包含 JSON）
        const zop = card.getAttribute('data-zop');
        if (zop) {
            try {
                const parsed = JSON.parse(zop);
                if (parsed.answerId) return String(parsed.answerId);
            } catch (e) {}
        }

        // 尝试 data-za-detail 属性
        const zaDetail = card.getAttribute('data-za-detail');
        if (zaDetail) {
            try {
                const parsed = JSON.parse(zaDetail);
                if (parsed.answer_id) return String(parsed.answer_id);
            } catch (e) {}
        }

        // 尝试查找包含 answer ID 的链接
        const link = card.querySelector('a[href*="/answer/"]');
        if (link) {
            const match = link.href.match(/\/answer\/(\d+)/);
            if (match) return match[1];
        }

        // 尝试 data-answer-id 属性
        const dataId = card.getAttribute('data-answer-id');
        if (dataId) return String(dataId);

        // 尝试查找带 data-aid 属性的子元素
        const aidEl = card.querySelector('[data-aid]');
        if (aidEl) return aidEl.getAttribute('data-aid');

        return null;
    }

    // ---------- 在已拉黑用户的用户名后追加「（已拉黑）」 ----------
    function setupBlockedLabel() {
        const observer = new MutationObserver(() => {
            const selector = [
                '.UserLink-link:not(.zhihu-labeled)',                   // 用户名链接
                '.CommentItem a[href*="/people/"]:not(.zhihu-labeled)'  // 评论区用户名
            ].join(', ');

            document.querySelectorAll(selector).forEach(link => {
                const match = link.href && link.href.match(/\/people\/([^/?&]+)/);
                if (!match) return;
                const token = match[1];

                link.classList.add('zhihu-labeled');

                // 过滤数字文本（如点赞数 "123"）或空文本
                const text = link.textContent.trim();
                if (/^\d+$/.test(text) || text.length === 0) return;
                if (text.includes('（已拉黑）')) return;

                if (blockedTokens.has(token)) {
                    // 先在用户名后追加文字（即时响应本地缓存）
                    link.append('（已拉黑）');

                    // 异步验证真实拉黑状态，如果已取消则清理
                    verifyBlockedStatus(token).then(isBlocked => {
                        if (!isBlocked) {
                            removeBlockedUser(token);
                            const textNode = [...link.childNodes].find(n =>
                                n.nodeType === Node.TEXT_NODE && n.textContent.includes('（已拉黑）')
                            );
                            if (textNode) textNode.remove();
                        }
                    });
                }
            });
        });

        observer.observe(document.body, { childList: true, subtree: true });
    }

    // ---------- 拉黑答主的粉丝（无小号判断，三次确认） ----------
    async function blockAuthorFollowers() {
        if (!confirm('警告：即将拉黑本回答/文章作者的粉丝。此操作不可逆，且会排除你的关注和粉丝。确定要继续吗？')) {
            return;
        }
        if (!confirm('再次确认：确定要拉黑该答主的所有粉丝（排除你的关注和粉丝）吗？')) {
            return;
        }
        if (!confirm('最后确认：此操作将会拉黑大量用户，请确保你已了解后果。确定执行？')) {
            return;
        }

        const MY_USER_ID = await getCurrentUserId();
        if (!MY_USER_ID) {
            alert('无法获取你的用户ID，请重新登录后重试。');
            return;
        }

        const pageHref = location.href;
        let authorId = null;
        let contentType = '';
        let contentId = '';

        const answerMatch = pageHref.match(/^https:\/\/www\.zhihu\.com\/question\/(\d+)\/answer\/(\d+)/);
        const articleMatch = pageHref.match(/^https:\/\/zhuanlan\.zhihu\.com\/p\/(\d+)/);

        if (answerMatch) {
            contentType = 'answer';
            contentId = answerMatch[2];
            try {
                const answerApi = `https://www.zhihu.com/api/v4/answers/${contentId}`;
                const resp = await fetchWithCreds(answerApi);
                const data = await safeJson(resp);
                if (data && data.author && data.author.url_token) {
                    authorId = data.author.url_token;
                } else {
                    alert('无法获取回答作者信息。');
                    return;
                }
            } catch (e) {
                alert('获取回答作者失败：' + e.message);
                return;
            }
        } else if (articleMatch) {
            contentType = 'article';
            contentId = articleMatch[1];
            try {
                const articleApi = `https://www.zhihu.com/api/v4/articles/${contentId}`;
                const resp = await fetchWithCreds(articleApi);
                const data = await safeJson(resp);
                if (data && data.author && data.author.url_token) {
                    authorId = data.author.url_token;
                } else {
                    alert('无法获取文章作者信息。');
                    return;
                }
            } catch (e) {
                alert('获取文章作者失败：' + e.message);
                return;
            }
        } else {
            alert('当前页面不是知乎回答或文章，无法执行此操作。');
            return;
        }

        // 获取白名单
        const followees = await getAllUserIds(`https://www.zhihu.com/api/v4/members/${MY_USER_ID}/followees`);
        const followers = await getAllUserIds(`https://www.zhihu.com/api/v4/members/${MY_USER_ID}/followers`);
        const safeUserIds = new Set([...followees, ...followers]);

        const fansApi = `https://www.zhihu.com/api/v4/members/${authorId}/followers`;

        // UI 进度框
        const infoDiv = document.createElement('div');
        infoDiv.style.cssText = getInfoDivStyle();
        document.body.appendChild(infoDiv);

        const logArea = document.createElement('div');
        logArea.style.cssText = 'flex: 1; overflow-y: auto; white-space: pre-wrap; padding-bottom: 8px;';
        infoDiv.appendChild(logArea);

        const btnContainer = document.createElement('div');
        btnContainer.style.textAlign = 'center';
        const stopBtn = document.createElement('button');
        stopBtn.textContent = '停止';
        stopBtn.style.padding = '4px 16px';
        btnContainer.appendChild(stopBtn);
        infoDiv.appendChild(btnContainer);

        let shouldStop = false;
        stopBtn.addEventListener('click', () => {
            shouldStop = true;
            console.log('用户请求停止');
        });

        function appendLog(html) {
            logArea.innerHTML += html + '<br>';
            logArea.scrollTop = logArea.scrollHeight;
        }

        function tokenLink(userToken) {
            return `<a href="https://www.zhihu.com/people/${userToken}" target="_blank">${userToken}</a>`;
        }

        appendLog('正在获取作者的粉丝列表（排除白名单）...');
        appendLog(`白名单人数：${safeUserIds.size} 人（你的关注 + 粉丝）`);
        appendLog('─────────────────────────────');

        const blockedUsers = [];

        let offset = 0;
        const limit = 20;
        let isEnd = false;
        let handled = 0;
        let estimated = 0;

        while (!isEnd && !shouldStop) {
            const url = `${fansApi}?limit=${limit}&offset=${offset}`;
            try {
                const response = await fetchWithCreds(url);
                const data = await safeJson(response);
                if (!data) break;
                const fans = data.data || [];
                estimated += fans.length;

                for (const fan of fans) {
                    if (shouldStop) {
                        appendLog('用户已停止');
                        break;
                    }
                    handled++;
                    const userId = fan.id;
                    const userName = fan.name;
                    const userToken = fan.url_token;
                    const profileUrl = `https://www.zhihu.com${fan.url}`;

                    if (safeUserIds.has(String(userId))) {
                        appendLog(`已跳过（白名单）：${userName} (${tokenLink(userToken)}) [${handled}/${estimated}]`);
                        continue;
                    }

                    // 已拉黑用户标记后跳过
                    if (blockedTokens.has(userToken)) {
                        appendLog(`${userName}（已屏蔽）(${tokenLink(userToken)}) [${handled}/${estimated}]`);
                        continue;
                    }

                    const actionResponse = await blockUser(userToken);
                    if (actionResponse.ok) {
                        blockedUsers.push({ userName, userToken, profileUrl });
                        // 记录已拉黑用户
                        saveBlockedUser(userToken, userName);
                        blockedTokens.add(userToken);
                        appendLog(`已屏蔽：${userName} (${tokenLink(userToken)}) [${handled}/${estimated}]`);
                        // ---- 控制台显示拉黑进度 ----
                        console.log(`[已拉黑] ${userName} - 主页：https://www.zhihu.com/people/${userToken}`);
                    } else {
                        const errText = await actionResponse.text().catch(() => '');
                        appendLog(`失败：${userName} (${tokenLink(userToken)}) 状态 ${actionResponse.status}`);
                        console.warn(`拉黑失败 ${userName}: ${actionResponse.status} - ${errText}`);
                    }
                }

                if (shouldStop) break;
                isEnd = data.paging && data.paging.is_end;
                offset += limit;
            } catch (e) {
                console.error('获取粉丝列表出错：', e);
                appendLog('获取粉丝列表出错：' + e.message);
                break;
            }
        }

        if (shouldStop) {
            appendLog('用户已停止，未完全完成。');
        }
        appendLog(`执行完毕！共拉黑：${blockedUsers.length} 人`);
        console.log('====== 拉黑作者粉丝完成 ======');
        console.table(blockedUsers);
        console.log('总拉黑数：', blockedUsers.length);
    }

    // ---------- 创建悬浮按钮和菜单 ----------
    function createUI() {
        const floatBtn = document.createElement('div');
        floatBtn.style.cssText = `
            position: fixed;
            bottom: 80px;
            right: 20px;
            z-index: 99999;
            background: #007bff;
            color: #fff;
            padding: 10px 14px;
            border-radius: 50%;
            font-size: 24px;
            cursor: pointer;
            box-shadow: 0 2px 8px rgba(0,0,0,0.3);
            user-select: none;
            font-family: '微软雅黑', sans-serif;
            width: 48px;
            height: 48px;
            display: flex;
            align-items: center;
            justify-content: center;
            border: none;
        `;
        floatBtn.textContent = '⚙';
        document.body.appendChild(floatBtn);

        const isDark = isDarkMode();
        const menu = document.createElement('div');
        menu.style.cssText = `
            position: fixed;
            bottom: 140px;
            right: 20px;
            z-index: 99999;
            background: ${isDark ? '#2d2d2d' : '#fff'};
            color: ${isDark ? '#e0e0e0' : '#000'};
            border: 1px solid ${isDark ? '#555' : '#ccc'};
            border-radius: 4px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.2);
            padding: 8px 0;
            min-width: 180px;
            display: none;
            font-family: '微软雅黑', sans-serif;
            font-size: 14px;
        `;
        const item1 = document.createElement('div');
        item1.textContent = '拉黑点赞者';
        item1.style.cssText = `padding: 8px 16px; cursor: pointer; color: ${isDark ? '#e0e0e0' : '#000'};`;
        item1.addEventListener('mouseenter', () => { item1.style.backgroundColor = isDark ? '#3d3d3d' : '#f0f0f0'; });
        item1.addEventListener('mouseleave', () => { item1.style.backgroundColor = 'transparent'; });
        item1.addEventListener('click', () => {
            menu.style.display = 'none';
            blockUpvoters();
        });

        const item2 = document.createElement('div');
        item2.textContent = '拉黑答主粉丝';
        item2.style.cssText = `padding: 8px 16px; cursor: pointer; color: ${isDark ? '#e0e0e0' : '#000'};`;
        item2.addEventListener('mouseenter', () => { item2.style.backgroundColor = isDark ? '#3d3d3d' : '#f0f0f0'; });
        item2.addEventListener('mouseleave', () => { item2.style.backgroundColor = 'transparent'; });
        item2.addEventListener('click', () => {
            menu.style.display = 'none';
            blockAuthorFollowers();
        });

        const item3 = document.createElement('div');
        const initialThemeMode = getThemeMode();
        item3.textContent = initialThemeMode === 'dark' ? '浅色模式' : '深色模式';
        item3.style.cssText = `padding: 8px 16px; cursor: pointer; color: ${isDark ? '#e0e0e0' : '#000'};`;
        item3.addEventListener('mouseenter', () => { item3.style.backgroundColor = isDark ? '#3d3d3d' : '#f0f0f0'; });
        item3.addEventListener('mouseleave', () => { item3.style.backgroundColor = 'transparent'; });
        item3.addEventListener('click', () => {
            menu.style.display = 'none';
            const nextMode = getThemeMode() === 'dark' ? 'light' : 'dark';
            setThemeMode(nextMode);
        });

        menu.appendChild(item1);
        menu.appendChild(item2);
        menu.appendChild(item3);

        // —— 知乎直答处理设置 ——
        const currentZhidaMode = getZhidaMode();
        const itemZhida = document.createElement('div');
        itemZhida.textContent = `知乎直答: ${zhidaModeLabels[currentZhidaMode]}`;
        itemZhida.style.cssText = `padding: 8px 16px; cursor: pointer; color: ${isDark ? '#e0e0e0' : '#000'};`;
        itemZhida.addEventListener('mouseenter', () => { itemZhida.style.backgroundColor = isDark ? '#3d3d3d' : '#f0f0f0'; });
        itemZhida.addEventListener('mouseleave', () => { itemZhida.style.backgroundColor = 'transparent'; });
        itemZhida.addEventListener('click', () => {
            menu.style.display = 'none';
            const current = getZhidaMode();
            const idx = zhidaModeCycle.indexOf(current);
            const next = zhidaModeCycle[(idx + 1) % zhidaModeCycle.length];
            setZhidaMode(next);
            itemZhida.textContent = `知乎直答: ${zhidaModeLabels[next]}`;
            // 如果当前页面有 zhida 链接，立即应用新设置
            applyZhidaMode(next);
        });
        menu.appendChild(itemZhida);

        // —— 专栏优化入口（仅 zhuanlan.zhihu.com） ——
        if (location.hostname === 'zhuanlan.zhihu.com') {
            const item4 = document.createElement('div');
            const optimized = getZhuanlanOptimized();
            item4.textContent = optimized ? '专栏优化 ✓' : '优化专栏阅读';
            item4.style.cssText = `padding: 8px 16px; cursor: pointer; color: ${isDark ? '#e0e0e0' : '#000'}; border-top: 1px solid ${isDark ? '#555' : '#e0e0e0'}; margin-top: 4px; padding-top: 12px;`;
            item4.addEventListener('mouseenter', () => { item4.style.backgroundColor = isDark ? '#3d3d3d' : '#f0f0f0'; });
            item4.addEventListener('mouseleave', () => { item4.style.backgroundColor = 'transparent'; });
            item4.addEventListener('click', () => {
                menu.style.display = 'none';
                toggleZhuanlanOptimize();
                item4.textContent = zhuanlanSavedState ? '专栏优化 ✓' : '优化专栏阅读';
            });
            menu.appendChild(item4);
        }

        document.body.appendChild(menu);

        floatBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isVisible = menu.style.display === 'block';
            menu.style.display = isVisible ? 'none' : 'block';
        });

        document.addEventListener('click', (e) => {
            if (!menu.contains(e.target) && e.target !== floatBtn) {
                menu.style.display = 'none';
            }
        });
    }

    // ====== 个人主页「拉黑」按钮 ======

    // 检测当前页面是否是知乎个人主页（非本人）
    function isProfilePage() {
        const match = location.pathname.match(/^\/people\/([^/?&]+)/);
        return match ? match[1] : null;
    }

    // 获取红按钮的标准样式
    function getBlockButtonStyle(isHover) {
        const bgColor = isHover ? '#C0392B' : '#E03A3A';
        const borderColor = isHover ? '#A93226' : '#E03A3A';
        return `
            max-width: 100.797px;
            height: 34px;
            min-width: 96px;
            padding: 0 16px;
            border: 1px solid ${borderColor};
            border-radius: 3px;
            background: ${bgColor};
            color: rgb(255, 255, 255);
            font-size: 14px;
            line-height: 32px;
            font-weight: 400;
            font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', 'PingFang SC', 'Microsoft YaHei', sans-serif;
            box-sizing: border-box;
            display: inline-block;
            text-align: center;
            cursor: pointer;
            transition: background 0.2s, border-color 0.2s;
            vertical-align: middle;
            user-select: none;
            outline: none;
            margin: 0;
            margin-right: 8px;
        `;
    }

    // 在非本人的个人主页添加红色「拉黑」按钮
    function addProfilePageBlockButton() {
        // 仅当在 /people/{token} 路径时执行
        const targetToken = isProfilePage();
        if (!targetToken) return;

        // 如果已经有我们添加的按钮，不再重复添加
        if (document.querySelector('.zhihu-profile-block-btn')) return;

        // 查找关注按钮所在的容器
        const followSelectors = [
            '.ProfileHeader-actions button',           // 经典个人主页
            '.ProfileHeader-contentFooter button',     // 新版个人主页
            '.SelfProfileHeader-actions button',       // 旧版
            '.ProfileMain-header button',              // 另一种布局
            'button.FollowButton',                     // 通用 FollowButton
            '[class*="ProfileHeader"] button',          // 模糊匹配
            '[class*="profileHeader"] button'
        ];

        // 找到包含「关注」文本的按钮
        let followBtn = null;
        for (const sel of followSelectors) {
            const btns = document.querySelectorAll(sel);
            for (const btn of btns) {
                const text = btn.textContent.trim();
                if (text.includes('关注') && !text.includes('已关注') && !text.includes('拉黑')) {
                    followBtn = btn;
                    break;
                }
            }
            if (followBtn) break;
        }

        if (!followBtn) return;

        // 确定按钮容器（父元素）
        const container = followBtn.parentElement;
        if (!container) return;

        // 检查是否已有我们的按钮
        if (container.querySelector('.zhihu-profile-block-btn')) return;

        // 创建拉黑按钮
        const blockBtn = document.createElement('button');
        blockBtn.className = 'zhihu-profile-block-btn';
        const isAlreadyBlocked = blockedTokens.has(targetToken);
        blockBtn.textContent = isAlreadyBlocked ? '已拉黑' : '拉黑 Ta';
        if (isAlreadyBlocked) {
            blockBtn.dataset.blocked = 'true';
            blockBtn.style.cssText = getBlockButtonStyle(false)
                .replace('#E03A3A', '#999')
                .replace('#C0392B', '#888');
            blockBtn.style.background = '#999';
            blockBtn.style.borderColor = '#888';
            blockBtn.style.cursor = 'not-allowed';
            blockBtn.style.opacity = '0.7';
        } else {
            blockBtn.style.cssText = getBlockButtonStyle(false);
        }

        // hover 效果
        blockBtn.addEventListener('mouseenter', () => {
            blockBtn.style.cssText = getBlockButtonStyle(true);
        });
        blockBtn.addEventListener('mouseleave', () => {
            if (blockBtn.dataset.blocked === 'true') {
                blockBtn.style.cssText = getBlockButtonStyle(false)
                    .replace('#E03A3A', '#999')
                    .replace('#C0392B', '#888');
                blockBtn.style.background = '#999';
                blockBtn.style.borderColor = '#888';
            } else {
                blockBtn.style.cssText = getBlockButtonStyle(false);
            }
        });

        // 点击事件
        blockBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            e.preventDefault();

            if (blockBtn.dataset.blocked === 'true') return;
            if (blockBtn.dataset.loading === 'true') return;

            // 二次确认
            if (!confirm('确定要拉黑该用户吗？拉黑后将无法看到对方的内容，且此操作不可逆。')) {
                return;
            }

            blockBtn.dataset.loading = 'true';
            blockBtn.textContent = '处理中...';
            blockBtn.style.background = '#b03a2e';
            blockBtn.style.borderColor = '#b03a2e';
            blockBtn.style.cursor = 'not-allowed';

            try {
                // 检查是否登录
                const myUserId = await getCurrentUserId();
                if (!myUserId) {
                    alert('获取用户信息失败，请确认已登录知乎。');
                    blockBtn.dataset.loading = 'false';
                    blockBtn.textContent = '拉黑 Ta';
                    blockBtn.style.cssText = getBlockButtonStyle(false);
                    return;
                }

                // 如果是自己的主页，不操作
                if (targetToken === myUserId) {
                    alert('不能拉黑自己。');
                    blockBtn.dataset.loading = 'false';
                    blockBtn.textContent = '拉黑 Ta';
                    blockBtn.style.cssText = getBlockButtonStyle(false);
                    return;
                }

                // 调用拉黑 API
                const response = await blockUser(targetToken);

                if (response.ok) {
                    // 成功：记录到缓存
                    const userName = document.querySelector('[class*="ProfileHeader"] h1, [class*="profileHeader"] h1, .ProfileHeader-name, .title')?.textContent?.trim() || targetToken;
                    saveBlockedUser(targetToken, userName);
                    blockedTokens.add(targetToken);

                    // 更新按钮状态为「已拉黑」
                    blockBtn.dataset.blocked = 'true';
                    blockBtn.dataset.loading = 'false';
                    blockBtn.textContent = '已拉黑';
                    blockBtn.style.cssText = getBlockButtonStyle(false)
                        .replace('#E03A3A', '#999')
                        .replace('#C0392B', '#888');
                    blockBtn.style.background = '#999';
                    blockBtn.style.borderColor = '#888';
                    blockBtn.style.cursor = 'not-allowed';
                    blockBtn.style.opacity = '0.7';
                } else {
                    const errText = await response.text().catch(() => '');
                    console.error('拉黑失败:', response.status, errText);
                    alert(`拉黑失败（HTTP ${response.status}），请稍后重试。`);
                    blockBtn.dataset.loading = 'false';
                    blockBtn.textContent = '拉黑 Ta';
                    blockBtn.style.cssText = getBlockButtonStyle(false);
                }
            } catch (err) {
                console.error('拉黑过程中出错:', err);
                alert('拉黑过程中发生错误，请查看控制台了解详情。');
                blockBtn.dataset.loading = 'false';
                blockBtn.textContent = '拉黑 Ta';
                blockBtn.style.cssText = getBlockButtonStyle(false);
            }
        });

        // 插入到关注按钮之前
        container.insertBefore(blockBtn, followBtn);
    }

    // ====== 知乎专栏阅读优化 ======

    let zhuanlanSavedState = null;

    function toggleZhuanlanOptimize(skipSave) {
        if (location.hostname !== 'zhuanlan.zhihu.com') return;

        // 如果是还原操作
        if (zhuanlanSavedState) {
            try {
                // 还原边栏
                if (zhuanlanSavedState.sidebar && zhuanlanSavedState.sidebar.parent) {
                    zhuanlanSavedState.sidebar.parent.appendChild(zhuanlanSavedState.sidebar.el);
                }
                // 还原文章样式
                if (zhuanlanSavedState.article && zhuanlanSavedState.article.origStyle) {
                    const art = zhuanlanSavedState.article.el;
                    art.style.margin = zhuanlanSavedState.article.origStyle.margin;
                    art.style.float = zhuanlanSavedState.article.origStyle.float;
                    art.style.maxWidth = zhuanlanSavedState.article.origStyle.maxWidth;
                }
                // 还原导航链接（用 contains 检查 nextSibling 仍在 DOM 中，避免 insertBefore 抛异常）
                if (zhuanlanSavedState.navItems) {
                    zhuanlanSavedState.navItems.forEach(item => {
                        if (item.parent && item.nextSibling && item.parent.contains(item.nextSibling)) {
                            item.parent.insertBefore(item.el, item.nextSibling);
                        } else if (item.parent) {
                            item.parent.appendChild(item.el);
                        }
                    });
                }
                // 还原知乎直答按钮
                if (zhuanlanSavedState.zhidaBtns) {
                    zhuanlanSavedState.zhidaBtns.forEach(item => {
                        if (item.parent && item.nextSibling && item.parent.contains(item.nextSibling)) {
                            item.parent.insertBefore(item.el, item.nextSibling);
                        } else if (item.parent) {
                            item.parent.appendChild(item.el);
                        }
                    });
                }
            } catch (e) {
                console.warn('专栏还原过程中出现异常:', e);
            }
            zhuanlanSavedState = null;
            if (!skipSave) setZhuanlanOptimizedCookie('false');
            return;
        }

        // 执行优化
        const saved = {};

        // 第一步：删除边栏并保存
        const sidebar = document.querySelector('.css-1bcbfml');
        if (sidebar) {
            saved.sidebar = { el: sidebar, parent: sidebar.parentElement };
            sidebar.remove();
        }

        // 第二步：让文章正文居中，保存原始样式
        const article = document.querySelector('.css-12tmx22');
        if (article) {
            saved.article = {
                el: article,
                origStyle: {
                    margin: article.style.margin,
                    float: article.style.float,
                    maxWidth: article.style.maxWidth
                }
            };
            article.style.margin = '0 auto';
            article.style.float = 'none';
            article.style.maxWidth = '100%';
        }

        // 第三步：优化顶栏——保存并去除多余导航链接
        saved.navItems = [];
        document.querySelectorAll('div.css-c400lu').forEach(el => {
            const text = el.textContent.trim();
            if (text === '推荐' || text === '热榜' || text === '圈子' || text === '故事') {
                const parent = el.closest('a') || el;
                saved.navItems.push({
                    el: parent,
                    parent: parent.parentElement,
                    nextSibling: parent.nextSibling
                });
                parent.remove();
            }
        });

        // 保存并去除知乎直答按钮
        saved.zhidaBtns = [];
        document.querySelectorAll('a[href*="zhida.zhihu.com"]').forEach(el => {
            saved.zhidaBtns.push({
                el: el,
                parent: el.parentElement,
                nextSibling: el.nextSibling
            });
            el.remove();
        });

        zhuanlanSavedState = saved;
        if (!skipSave) setZhuanlanOptimizedCookie('true');
    }

    // ---------- 页面加载后的主初始化 ----------
    function init() {
        createUI();

        // 在已拉黑用户的用户名后追加「（已拉黑）」
        setupBlockedLabel();

        // 如果是问题页面，在操作栏添加「🚫拉黑」按钮
        if (/^https:\/\/www\.zhihu\.com\/question\/\d+$/.test(location.href)) {
            addBlockButtonsToActionBar();
            // 监听动态加载的回答（无限滚动）
            const pageObserver = new MutationObserver(() => {
                addBlockButtonsToActionBar();
            });
            pageObserver.observe(document.body, { childList: true, subtree: true });
        }

        // 如果是个人主页，添加「拉黑 Ta」按钮
        if (isProfilePage()) {
            // 初始尝试
            addProfilePageBlockButton();

            // 监听 DOM 变化，等待关注按钮加载完成
            const profileObserver = new MutationObserver(() => {
                addProfilePageBlockButton();
            });
            profileObserver.observe(document.body, { childList: true, subtree: true });
        }

        // —— 自动应用已保存的偏好 ——

        // 专栏优化
        if (location.hostname === 'zhuanlan.zhihu.com' && getZhuanlanOptimized()) {
            toggleZhuanlanOptimize(true);
        }

        // 知乎直答链接处理
        const savedZhidaMode = getZhidaMode();
        if (savedZhidaMode !== 'disabled') {
            applyZhidaMode(savedZhidaMode);
            // 监听动态加载的内容，持续处理新出现的 zhida 链接
            const zhidaObserver = new MutationObserver(() => {
                applyZhidaMode(savedZhidaMode);
            });
            zhidaObserver.observe(document.body, { childList: true, subtree: true });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
