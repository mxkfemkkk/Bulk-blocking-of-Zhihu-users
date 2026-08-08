// ==UserScript==
// @name         Zhihu PLUS 批量拉黑知乎用户和优化知乎网页版使用体验
// @namespace    http://tampermonkey.net/
// @version      2026-08-08
// @description  Better Zhihu
// @author       maxkk26
// @match        https://www.zhihu.com/*
// @match        https://zhuanlan.zhihu.com/*
// @match        https://zhihu.com/*
// @icon         data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==
// @grant        none
// ==/UserScript==

(function () {
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
            } catch (e) { }
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
        } catch (e) { }

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
        const selector = 'a.RichContent-EntityWord[href*="zhida.zhihu.com"], a[href*="zhida.zhihu.com"], a[data-paste-text="true"]';
        document.querySelectorAll(selector).forEach(el => {
            // 已处理且未被 React 恢复原样时跳过；React 重渲染恢复 zhida 链接后重新处理
            // 「已处理」以污染标志是否还在为准：旧格式已删 href 但残留控制属性（data-paste-text 等）时仍需重处理
            const alreadyDone = el.dataset.zhidaProcessed === mode &&
                (mode === 'google'
                    ? el.href.startsWith('https://www.google.com/search')
                    : !el.hasAttribute('href') && !el.hasAttribute('data-paste-text') && !el.hasAttribute('data-za-not-track-link'));
            if (alreadyDone) return;

            const text = el.textContent.trim();
            if (!text) return; // 空文本保护：文本未渲染时跳过（不标记），等后续 MutationObserver 周期再处理

            el.dataset.zhidaProcessed = mode;

            if (mode === 'google') {
                el.href = `https://www.google.com/search?q=${encodeURIComponent(text)}`;
                el.target = '_blank';
                el.rel = 'noopener noreferrer';
            } else if (mode === 'plain') {
                // 保留节点、仅去除链接语义（不用 replaceChild，避免破坏 React 渲染导致文本丢失）
                el.removeAttribute('href');
                el.removeAttribute('target');
                el.removeAttribute('rel');
                el.classList.remove('RichContent-EntityWord');
                el.classList.remove('css-1x3bg93'); // 新格式实体蓝色样式类（hash 类名，配合下一条兜底）
                el.style.setProperty('color', 'inherit', 'important'); // 强制继承正文颜色，深浅色主题均正确
                // 折叠子节点为纯文本：保留全部文字、移除 ✦ 角标等图标元素
                el.textContent = text;
            }

            // 删除直答污染控制属性（新格式），避免知乎 JS 仍把它当直答实体处理（点击唤起看山）
            // google 模式也要删：若属性残留，知乎的点击拦截可能抢在 Google 链接跳转前唤起看山
            el.removeAttribute('data-paste-text');
            el.removeAttribute('data-za-not-track-link');
        });
    }

    // ====== 知乎超链接美化开关（cookie 持久化，默认开启） ======

    function getLinkBeautifyEnabled() {
        const cookieMatch = document.cookie.match(/(?:^|;\s*)zhihu_link_beautify=([^;]+)/);
        if (cookieMatch) return decodeURIComponent(cookieMatch[1]) === 'true';
        return true; // 默认开启
    }

    function setLinkBeautifyEnabled(enabled) {
        const expires = '; max-age=31536000; path=/';
        const domain = location.hostname.endsWith('zhihu.com') ? '; domain=.zhihu.com' : '';
        document.cookie = `zhihu_link_beautify=${enabled}${expires}${domain}`;
    }

    // 模块级状态：事件回调中快速判断，避免每次读 cookie
    let linkBeautifyEnabled = getLinkBeautifyEnabled();

    function toggleLinkBeautify() {
        linkBeautifyEnabled = !linkBeautifyEnabled;
        setLinkBeautifyEnabled(linkBeautifyEnabled);
        applyLinkBeautify(); // 立即对当前页面生效（开启=应用，关闭=还原）
        return linkBeautifyEnabled;
    }

    // ====== 知乎超链接美化（正文内链接 = 蓝色 + 下划线，排除直答） ======

    function applyLinkBeautify() {
        if (!linkBeautifyEnabled) { undoLinkBeautify(); return; }
        // 只处理知乎主站和专栏的回答/文章正文
        const bodySelectors = '.css-376mun, .css-1od93p9';
        document.querySelectorAll(bodySelectors).forEach(container => {
            container.querySelectorAll('a').forEach(link => {
                // 跳过已处理和直答链接
                if (link.dataset.zhLinkBeautified) return;
                if (link.dataset.zhidaProcessed || link.classList.contains('RichContent-EntityWord') || link.href.includes('zhida.zhihu.com') || link.hasAttribute('data-paste-text')) return;

                link.dataset.zhLinkBeautified = 'true';
                link.style.setProperty('color', 'rgb(85, 142, 255)', 'important');
                link.style.setProperty('text-decoration', 'underline', 'important');
                link.style.setProperty('transition', 'color 0.15s', 'important');
                if (!link.dataset.zhLinkBeautifyBound) {
                    link.dataset.zhLinkBeautifyBound = 'true';
                    link.addEventListener('mouseenter', () => {
                        if (!linkBeautifyEnabled) return;
                        link.style.setProperty('color', '#7ec8e3', 'important');
                    }, { passive: true });
                    link.addEventListener('mouseleave', () => {
                        if (!linkBeautifyEnabled) return;
                        link.style.setProperty('color', 'rgb(85, 142, 255)', 'important');
                    }, { passive: true });
                    link.addEventListener('mousedown', () => {
                        if (!linkBeautifyEnabled) return;
                        link.style.setProperty('color', '#7ec8e3', 'important');
                    }, { passive: true });
                    link.addEventListener('mouseup', () => {
                        if (!linkBeautifyEnabled) return;
                        link.style.setProperty('color', 'rgb(85, 142, 255)', 'important');
                    }, { passive: true });
                }
            });
        });
    }

    // 还原美化的内联样式（监听器保留但会因开关检查空转；绑定标记保留，避免重复绑定）
    function undoLinkBeautify() {
        document.querySelectorAll('a[data-zh-link-beautified]').forEach(link => {
            delete link.dataset.zhLinkBeautified;
            link.style.removeProperty('color');
            link.style.removeProperty('text-decoration');
            link.style.removeProperty('transition');
        });
    }

    // ====== 去除知乎超链接中转（link.zhihu.com/?target=...） ======

    function removeLinkRedirect() {
        document.querySelectorAll('a[href*="link.zhihu.com/?target="]').forEach(link => {
            if (link.dataset.zhRedirectRemoved) return;
            link.dataset.zhRedirectRemoved = 'true';

            try {
                const urlObj = new URL(link.href);
                const target = urlObj.searchParams.get('target');
                if (target) {
                    const decodedTarget = decodeURIComponent(target);
                    link.href = decodedTarget;
                    // 外部链接新窗口打开
                    if (!decodedTarget.startsWith('https://www.zhihu.com') && !decodedTarget.startsWith('/')) {
                        link.target = '_blank';
                        link.rel = 'noopener noreferrer';
                    }
                }
            } catch (e) {
                // 解析失败则跳过
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

    // ---------- 并发控制：限制同时执行的任务数 ----------
    async function pMapConcurrent(items, concurrency, fn) {
        const results = [];
        const executing = new Set();

        for (let i = 0; i < items.length; i++) {
            const p = Promise.resolve().then(() => fn(items[i], i)).then(r => {
                executing.delete(p);
                return r;
            }, e => {
                executing.delete(p);
                throw e;
            });
            results.push(p);
            executing.add(p);

            if (executing.size >= concurrency) {
                await Promise.race(executing);
            }
        }
        return Promise.all(results);
    }

    // ---------- 带指数退避重试的拉黑（应对限流 429） ----------
    async function blockUserWithRetry(userToken, maxRetries = 3) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const response = await blockUser(userToken);
                if (response.ok) return response;
                if (response.status === 429) {
                    const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
                    console.warn(`拉黑 ${userToken} 被限流(429)，第 ${attempt} 次重试，等待 ${delay}ms`);
                    await new Promise(r => setTimeout(r, delay));
                    continue;
                }
                // 其他错误直接返回，不重试
                return response;
            } catch (e) {
                if (attempt === maxRetries) throw e;
                const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
                console.warn(`拉黑 ${userToken} 异常(${e.message})，第 ${attempt} 次重试，等待 ${delay}ms`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }

    async function getCurrentUserId() {
        try {
            if (window.__INITIAL_STATE__?.config?.currentUser?.urlToken) {
                const userId = window.__INITIAL_STATE__.config.currentUser.urlToken;
                console.log(`Auto detected user ID: ${userId}`);
                return userId;
            }
        } catch (e) { }

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
    // 优先跟随服务端 paging.next 翻页（实测：自拼 offset 分页存在约 580 人的服务端上限，
    // 跟随 paging.next 可获取全量粉丝）；paging.next 缺失/非字符串时回退自拼 offset
    async function getAllUserIds(apiUrl) {
        const allIds = new Set();
        const limit = 50;
        const MAX_PAGES = 100;   // 安全阀，防无限循环
        let offset = 0;
        let nextUrl = null;
        let isEnd = false;
        let pageCount = 0;

        while (!isEnd && pageCount < MAX_PAGES) {
            // 首页自拼，后续页优先跟随 paging.next（服务端自带 limit=20，原样使用）
            const url = pageCount === 0
                ? `${apiUrl}?limit=${limit}&offset=${offset}`
                : (nextUrl || `${apiUrl}?limit=${limit}&offset=${offset}`);
            try {
                const response = await fetchWithCreds(url);
                const data = await safeJson(response);
                if (!data || !data.data) break; // 空响应/参数不被支持 → 停止
                const users = data.data || [];
                // 使用 String(user.id) 确保类型一致（新版用到 String 转换）
                users.forEach(user => allIds.add(String(user.id)));
                nextUrl = (data.paging && typeof data.paging.next === 'string' && data.paging.next) ? data.paging.next : null;
                // paging 缺失时视为已结束，避免无限循环
                isEnd = !data.paging || data.paging.is_end === true;
                offset += limit;
                pageCount++;
                // 分页间短暂延迟，防止高频请求压垮页面
                if (!isEnd) {
                    await new Promise(r => setTimeout(r, 80));
                }
            } catch (e) {
                console.warn(`获取白名单失败 (${url}):`, e.message);
                break;
            }
        }
        return allIds;
    }

    // ---------- 从知乎 API 拉取当前用户的真实黑名单 ----------
    // 端点：/api/v3/settings/blocked_users（设置页 /settings/filter 的真实接口；
    // 旧的 /api/v4/me/blocks 系列已废弃，实测 404）
    // 分页跟随 paging.next（与白名单同一成熟模式，可突破自拼 offset 的上限），返回 { list, completed }
    async function fetchZhihuBlockedList(meToken, opts = {}) {
        const { maxPages = 100, onProgress, isCancelled } = opts;
        const baseUrl = 'https://www.zhihu.com/api/v3/settings/blocked_users';
        const seen = new Map(); // url_token -> {url_token, name, id}（去重）
        const limit = 50;
        let offset = 0;
        let nextUrl = null;
        let isEnd = false;
        let completed = false;
        let pageCount = 0;
        let ok = false;

        try {
            while (!isEnd && pageCount < maxPages) {
                if (isCancelled && isCancelled()) break;
                // 首页自拼，后续页优先跟随 paging.next（原样使用其自带 limit）
                const url = pageCount === 0
                    ? `${baseUrl}?limit=${limit}&offset=${offset}`
                    : (nextUrl || `${baseUrl}?limit=${limit}&offset=${offset}`);
                let resp = await fetchWithCreds(url);
                if (resp.status === 429) {
                    // 限流退避重试一次
                    await new Promise(r => setTimeout(r, 1000));
                    resp = await fetchWithCreds(url);
                }
                const data = await safeJson(resp);
                if (!data || !data.data) break;
                ok = true;
                for (const u of data.data) {
                    const key = u.url_token || String(u.id || '');
                    if (!key || seen.has(key)) continue;
                    seen.set(key, { url_token: u.url_token, name: u.name, id: u.id });
                }
                nextUrl = (data.paging && typeof data.paging.next === 'string' && data.paging.next) ? data.paging.next : null;
                isEnd = !data.paging || data.paging.is_end === true;
                if (isEnd) completed = true;
                if (data.data.length === 0) break; // 防空转：空 data + is_end:false 时不再翻页
                offset += limit;
                pageCount++;
                if (pageCount % 10 === 0 && onProgress) onProgress(seen.size);
                if (!isEnd) {
                    await new Promise(r => setTimeout(r, 120));
                }
            }
        } catch (e) {
            console.warn(`黑名单端点 ${baseUrl} 拉取失败:`, e.message);
        }

        if (ok && seen.size > 0) {
            console.log(`从知乎拉取到黑名单 ${seen.size} 人（端点: ${baseUrl}）`);
            return { list: [...seen.values()], completed };
        }
        console.warn('黑名单端点不可用，保留本地黑名单。');
        return { list: [], completed: false };
    }

    // 将知乎真实黑名单同步到本地 blockedTokens + localStorage
    // 仅在远程拉取到非空黑名单时才执行合并（防止误清空本地记录）
    async function syncBlockedUsersFromZhihu() {
        const me = await getCurrentUserId();
        if (!me) return false;

        // maxPages=50 限制后台拉取量（约 1000-2500 人覆盖，与现状相当），避免每次页面加载拉 100+ 页
        const remote = await fetchZhihuBlockedList(me, { maxPages: 50 });
        if (!remote || remote.list.length === 0) return false;

        // 合并到本地 Set
        let changed = 0;
        const existing = loadBlockedUsers();
        const merged = existing.slice();
        const seen = new Set(existing.map(u => u.token));

        for (const u of remote.list) {
            if (!u.url_token) continue;
            if (!seen.has(u.url_token)) {
                merged.push({ token: u.url_token, name: u.name, time: Date.now() });
                changed++;
            }
            blockedTokens.add(u.url_token);
            seen.add(u.url_token);
        }

        // 清理本地存在但知乎已不在黑名单中的记录
        // 仅完整拉取（completed）时执行 prune，防止按部分拉取结果误删本地记录
        let finalList = merged;
        let prunedCount = 0;
        if (remote.completed) {
            const remoteTokens = new Set(remote.list.map(u => u.url_token).filter(Boolean));
            finalList = merged.filter(u => remoteTokens.has(u.token));
            prunedCount = merged.length - finalList.length;
            if (prunedCount > 0) {
                blockedTokens.clear();
                finalList.forEach(u => blockedTokens.add(u.token));
            }
            console.log(`黑名单同步完成：新增 ${changed} 人，移除 ${prunedCount} 人，本地共 ${finalList.length} 人`);
        } else {
            console.log(`黑名单同步完成（部分拉取，保留本地记录）：新增 ${changed} 人，本地共 ${finalList.length} 人`);
        }

        localStorage.setItem(BLOCKED_KEY, JSON.stringify(finalList));
        return true;
    }

    // ---------- 核心拉黑流程（抽取公用，供不同入口调用） ----------
    // 优化策略：① 两阶段——先预取全部点赞者，再统一拉黑
    //           ② 拉黑阶段并发执行（3路并行），带限流重试
    //           ③ 分页加大到 50，减少请求次数
    async function executeBlockFlow({ apiCandidates, sourceLabel }) {
        const MY_USER_ID = await getCurrentUserId();
        if (!MY_USER_ID) {
            console.error('Cannot get user ID, abort.');
            return;
        }

        // 先创建 UI（让 appendLog 可用）
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

        const startTime = Date.now();

        // 同步当前用户的真实黑名单到本地
        appendLog('正在同步你的黑名单...');
        await syncBlockedUsersFromZhihu();

        // 白名单（每次拉黑请求都重新获取）
        appendLog('正在获取你的关注和粉丝列表（白名单）...');
        const followees = await getAllUserIds(`https://www.zhihu.com/api/v4/members/${MY_USER_ID}/followees`);
        const followers = await getAllUserIds(`https://www.zhihu.com/api/v4/members/${MY_USER_ID}/followers`);
        const safeUserIds = new Set([...followees, ...followers]);

        appendLog(`白名单人数：${safeUserIds.size} 人（关注 + 粉丝）`);
        appendLog('─────────────────────────────');

        // ========== 第一阶段：预取所有排序的全部点赞者，本地去重 ==========
        appendLog('正在获取点赞列表（多个排序，自动去重）...');

        const allVoters = new Map();  // url_token -> voterInfo
        let apiErrors = [];

        for (const baseUrl of apiCandidates) {
            let offset = 0;
            const PAGE_SIZE = 50;
            let isEnd = false;
            let pageCount = 0;

            while (!isEnd && !shouldStop) {
                const url = `${baseUrl}&limit=${PAGE_SIZE}&offset=${offset}`;
                try {
                    const resp = await fetchWithCreds(url);
                    const data = await safeJson(resp);
                    if (!data || !data.data) {
                        if (data === null) break; // 空响应，跳过此候选
                        break;
                    }
                    for (const v of data.data) {
                        if (!allVoters.has(v.url_token)) {
                            allVoters.set(v.url_token, v);
                        }
                    }
                    isEnd = !data.paging || data.paging.is_end === true;
                    offset += PAGE_SIZE;
                    pageCount++;
                    // yield 点：每 5 页让出事件循环，避免长时间阻塞主线程
                    if (pageCount % 5 === 0) {
                        await new Promise(r => setTimeout(r, 0));
                    }
                } catch (err) {
                    console.warn(`获取点赞列表失败 (${url}):`, err);
                    apiErrors.push({ url, error: err.message });
                    break; // 跳过此候选
                }
            }
            if (shouldStop) break;
        }

        if (apiErrors.length > 0 && allVoters.size === 0) {
            appendLog('所有 API 均失败，无法获取点赞用户列表。');
            return;
        }

        if (allVoters.size === 0) {
            appendLog('未获取到任何点赞用户。');
            return;
        }

        // ========== 第二阶段：本地过滤（白名单 + 已拉黑） ==========
        appendLog(`获取到 ${allVoters.size} 名不同用户，正在过滤白名单和已拉黑用户...`);

        const toBlock = [];
        const skippedWhitelist = [];
        const skippedBlocked = [];

        for (const [token, info] of allVoters) {
            if (safeUserIds.has(String(info.id))) {
                skippedWhitelist.push(info);
                continue;
            }
            if (blockedTokens.has(token)) {
                skippedBlocked.push(info);
                continue;
            }
            toBlock.push(info);
        }

        appendLog(`需拉黑：${toBlock.length} 人 | 白名单跳过：${skippedWhitelist.length} 人 | 已拉黑跳过：${skippedBlocked.length} 人`);
        appendLog('─────────────────────────────');

        // 过滤完成后弹窗，显示完整统计（含已拉黑跳过人数）
        if (!confirm(`白名单跳过 ${skippedWhitelist.length} 人 | 已拉黑跳过 ${skippedBlocked.length} 人\n需拉黑 ${toBlock.length} 人\n\n确定要继续执行拉黑操作吗？`)) {
            appendLog('用户取消了拉黑操作。');
            return;
        }

        if (toBlock.length === 0) {
            appendLog('没有需要拉黑的用户。');
            return;
        }

        // ========== 第三阶段：并发拉黑（3路并行，带重试） ==========
        appendLog(`开始拉黑（3 路并发）...`);
        const CONCURRENCY = 3;
        const blockedUsers = [];
        let completedCount = 0;
        let failCount = 0;

        const blockOne = async (voterInfo) => {
            if (shouldStop) return;

            const userName = voterInfo.name;
            const userToken = voterInfo.url_token;
            const profileUrl = `https://www.zhihu.com${voterInfo.url}`;

            try {
                const actionResponse = await blockUserWithRetry(userToken);
                if (actionResponse.ok) {
                    blockedUsers.push({ userName, userToken, profileUrl });
                    saveBlockedUser(userToken, userName);
                    blockedTokens.add(userToken);
                    completedCount++;
                    appendLog(`[已屏蔽] ${userName} (${tokenLink(userToken)}) [${completedCount + failCount}/${toBlock.length}]`);
                    console.log(`[已拉黑] ${userName} - 主页：https://www.zhihu.com/people/${userToken}`);
                } else {
                    failCount++;
                    const errText = await actionResponse.text().catch(() => '');
                    appendLog(`[失败] ${userName} (${tokenLink(userToken)}) 状态 ${actionResponse.status} [${completedCount + failCount}/${toBlock.length}]`);
                    console.warn(`拉黑失败 ${userName}: ${actionResponse.status} - ${errText}`);
                }
            } catch (err) {
                failCount++;
                appendLog(`[异常] ${userName} (${tokenLink(userToken)}) ${err.message} [${completedCount + failCount}/${toBlock.length}]`);
                console.error(`拉黑异常 ${userName}:`, err);
            }
        };

        await pMapConcurrent(toBlock, CONCURRENCY, blockOne);

        // 拉黑完成后，用最新数据标注点赞弹窗内的用户名
        labelVoterPopupFromData(toBlock);

        const elapsed = Math.round((Date.now() - startTime) / 1000);

        if (shouldStop) {
            appendLog(`[中断] 用户已停止，未完全完成。`);
        }
        appendLog(`─────────────────────────────`);
        appendLog(`执行完毕！共拉黑：${blockedUsers.length} 人，失败：${failCount} 人，用时 ${elapsed} 秒`);
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

    // ---------- 在每个回答操作栏「分享」右侧添加「拉黑」按钮 ----------
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
            btn.innerHTML = '[拉黑]';
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
                btn.innerHTML = '[执行中...]';
                btn.disabled = true;
                btn.style.background = '#bbb';
                blockAnswerUpvoters(answerId).finally(() => {
                    btn.innerHTML = '[拉黑]';
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
            } catch (e) { }
        }

        // 尝试 data-za-detail 属性
        const zaDetail = card.getAttribute('data-za-detail');
        if (zaDetail) {
            try {
                const parsed = JSON.parse(zaDetail);
                if (parsed.answer_id) return String(parsed.answer_id);
            } catch (e) { }
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

    // ---------- 标注已拉黑用户（由统一 Observer 节流调用，不内嵌独立 Observer） ----------
    function labelBlockedLinks() {
        // 覆盖所有带 /people/ 的 <a>：正文、评论区、点赞弹窗、关注列表等
        const selector = 'a[href*="/people/"]:not(.zhihu-labeled)';

        document.querySelectorAll(selector).forEach(link => {
            const match = link.href && link.href.match(/\/people\/([^/?&]+)/);
            if (!match) return;
            const token = match[1];

            link.classList.add('zhihu-labeled');

            // 跳过空文本或纯数字文本（如点赞数 "123"）
            const text = link.textContent.trim();
            if (/^\d+$/.test(text) || text.length === 0) return;
            if (text.includes('（已拉黑）')) return;

            if (blockedTokens.has(token)) {
                link.append('（已拉黑）');
            }
        });
    }

    // 主动标注点赞弹窗：拉黑流程拿到数据后，直接找到弹窗内元素追加标记
    function labelVoterPopupFromData(voters) {
        if (!voters || voters.length === 0) return;
        const popupContainer = document.querySelector('.VoterList, [class*="VoterList"], .Modal-content');
        if (!popupContainer) return;

        for (const voter of voters) {
            if (!blockedTokens.has(voter.url_token)) continue;
            const link = popupContainer.querySelector(
                `a[href*="/people/${voter.url_token}"]`
            );
            if (link && !link.textContent.includes('（已拉黑）')) {
                link.classList.add('zhihu-labeled');
                link.append('（已拉黑）');
            }
        }
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

        // 同步当前用户的真实黑名单到本地
        await syncBlockedUsersFromZhihu();

        // 获取白名单（每次拉黑请求都重新获取）
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

        const startTime = Date.now();

        appendLog('正在获取作者的粉丝列表（排除白名单）...');
        appendLog(`白名单人数：${safeUserIds.size} 人（你的关注 + 粉丝）`);
        appendLog('─────────────────────────────');

        // ========== 第一阶段：预取全部粉丝 ==========
        appendLog('正在获取全部粉丝...');

        const allFans = new Map();  // url_token -> fanInfo
        let offset = 0;
        const PAGE_SIZE = 50;
        let isEnd = false;
        let pageCount = 0;

        while (!isEnd && !shouldStop) {
            const url = `${fansApi}?limit=${PAGE_SIZE}&offset=${offset}`;
            try {
                const response = await fetchWithCreds(url);
                const data = await safeJson(response);
                if (!data) break;
                for (const fan of (data.data || [])) {
                    if (!allFans.has(fan.url_token)) {
                        allFans.set(fan.url_token, fan);
                    }
                }
                isEnd = !data.paging || data.paging.is_end === true;
                offset += PAGE_SIZE;
                pageCount++;
                // yield 点：每 5 页让出事件循环，避免长时间阻塞主线程
                if (pageCount % 5 === 0) {
                    await new Promise(r => setTimeout(r, 0));
                }
            } catch (e) {
                console.error('获取粉丝列表出错：', e);
                appendLog('获取粉丝列表出错：' + e.message);
                break;
            }
        }

        if (allFans.size === 0) {
            appendLog('未获取到任何粉丝。');
            return;
        }

        // ========== 第二阶段：本地过滤 ==========
        appendLog(`获取到 ${allFans.size} 名粉丝，正在过滤白名单和已拉黑用户...`);

        const toBlock = [];
        const skippedWhitelist = [];
        const skippedBlocked = [];

        for (const [token, info] of allFans) {
            if (safeUserIds.has(String(info.id))) {
                skippedWhitelist.push(info);
                continue;
            }
            if (blockedTokens.has(token)) {
                skippedBlocked.push(info);
                continue;
            }
            toBlock.push(info);
        }

        appendLog(`需拉黑：${toBlock.length} 人 | 白名单跳过：${skippedWhitelist.length} 人 | 已拉黑跳过：${skippedBlocked.length} 人`);
        appendLog('─────────────────────────────');

        // 过滤完成后弹窗，显示完整统计（含已拉黑跳过人数）
        if (!confirm(`白名单跳过 ${skippedWhitelist.length} 人 | 已拉黑跳过 ${skippedBlocked.length} 人\n需拉黑 ${toBlock.length} 人\n\n确定要继续执行拉黑操作吗？`)) {
            return;
        }

        if (toBlock.length === 0) {
            appendLog('没有需要拉黑的用户。');
            return;
        }

        // ========== 第三阶段：并发拉黑 ==========
        appendLog(`开始拉黑（3 路并发）...`);
        const CONCURRENCY = 3;
        const blockedUsers = [];
        let completedCount = 0;
        let failCount = 0;

        const blockOne = async (fanInfo) => {
            if (shouldStop) return;

            const userName = fanInfo.name;
            const userToken = fanInfo.url_token;
            const profileUrl = `https://www.zhihu.com${fanInfo.url}`;

            try {
                const actionResponse = await blockUserWithRetry(userToken);
                if (actionResponse.ok) {
                    blockedUsers.push({ userName, userToken, profileUrl });
                    saveBlockedUser(userToken, userName);
                    blockedTokens.add(userToken);
                    completedCount++;
                    appendLog(`[已屏蔽] ${userName} (${tokenLink(userToken)}) [${completedCount + failCount}/${toBlock.length}]`);
                    console.log(`[已拉黑] ${userName} - 主页：${profileUrl}`);
                } else {
                    failCount++;
                    const errText = await actionResponse.text().catch(() => '');
                    appendLog(`[失败] ${userName} (${tokenLink(userToken)}) 状态 ${actionResponse.status} [${completedCount + failCount}/${toBlock.length}]`);
                    console.warn(`拉黑失败 ${userName}: ${actionResponse.status} - ${errText}`);
                }
            } catch (err) {
                failCount++;
                appendLog(`[异常] ${userName} (${tokenLink(userToken)}) ${err.message} [${completedCount + failCount}/${toBlock.length}]`);
                console.error(`拉黑异常 ${userName}:`, err);
            }
        };

        await pMapConcurrent(toBlock, CONCURRENCY, blockOne);

        // 拉黑完成后标注弹窗
        labelVoterPopupFromData(toBlock);

        const elapsed = Math.round((Date.now() - startTime) / 1000);

        if (shouldStop) {
            appendLog(`[中断] 用户已停止，未完全完成。`);
        }
        appendLog(`─────────────────────────────`);
        appendLog(`执行完毕！共拉黑：${blockedUsers.length} 人，失败：${failCount} 人，用时 ${elapsed} 秒`);
        console.log('====== 拉黑作者粉丝完成 ======');
        console.table(blockedUsers);
        console.log('总拉黑数：', blockedUsers.length);
    }

    // ==========================================================
    // ========== 导出用户功能 ==========
    // ==========================================================

    // 通用分页收集用户（多候选端点 + Map 去重），返回 [{name, url_token, profileUrl}]
    async function collectUsersPaged(baseUrls, appendLog) {
        const allUsers = new Map(); // url_token -> 原始记录
        for (const baseUrl of baseUrls) {
            const sep = baseUrl.includes('?') ? '&' : '?'; // 点赞者 base 已含 ?order=，粉丝/关注 base 是干净的
            let offset = 0;
            const limit = 50;
            let nextUrl = null;
            let isEnd = false;
            let pageCount = 0;
            try {
                while (!isEnd && pageCount < 100) {
                    // 首页自拼，后续页优先跟随 paging.next（实测可突破自拼 offset 分页的 ~580 人上限）
                    const url = pageCount === 0
                        ? `${baseUrl}${sep}limit=${limit}&offset=${offset}`
                        : (nextUrl || `${baseUrl}${sep}limit=${limit}&offset=${offset}`);
                    const resp = await fetchWithCreds(url);
                    const data = await safeJson(resp);
                    if (!data || !data.data) break;
                    for (const u of data.data) {
                        // 多候选合并时首个候选优先
                        if (u.url_token && !allUsers.has(u.url_token)) {
                            allUsers.set(u.url_token, u);
                        }
                    }
                    nextUrl = (data.paging && typeof data.paging.next === 'string' && data.paging.next) ? data.paging.next : null;
                    isEnd = !data.paging || data.paging.is_end === true;
                    offset += limit;
                    pageCount++;
                    // yield 点：每 5 页让出事件循环，避免长时间阻塞主线程
                    if (pageCount % 5 === 0) {
                        if (appendLog) appendLog(`已获取 ${allUsers.size} 人...`);
                        await new Promise(r => setTimeout(r, 0));
                    }
                }
            } catch (e) {
                console.warn(`收集用户失败 (${baseUrl}):`, e.message);
                // 单候选失败：跳过该候选，保留已收集数据
            }
        }
        return [...allUsers.values()].map(normalizeExportUser);
    }

    // 统一导出记录形状：{name, url_token, profileUrl}
    function normalizeExportUser(u) {
        const token = u.url_token || u.token || '';
        return {
            name: u.name || token || '(未知)',
            url_token: token,
            profileUrl: u.url ? `https://www.zhihu.com${u.url}` : `https://www.zhihu.com/people/${token}`
        };
    }

    // CSV 字段转义：含逗号/引号/换行的字段加双引号，内部引号翻倍
    function csvEscape(field) {
        const str = String(field == null ? '' : field);
        return /[",\r\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
    }

    // 生成 CSV 内容：BOM 前缀（Excel 中文兼容）+ CRLF 换行
    function toCsv(users) {
        const header = ['用户名', '用户token', '个人主页链接'];
        const rows = users.map(u => [u.name, u.url_token, u.profileUrl].map(csvEscape).join(','));
        return '\uFEFF' + [header.join(','), ...rows].join('\r\n') + '\r\n';
    }

    // 生成 JSON 内容（英文键名）
    function toJson(users) {
        return JSON.stringify(users, null, 2);
    }

    // 导出文件名时间戳：YYYYMMDD_HHMMSS
    function exportTimestamp() {
        const d = new Date();
        const p = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    }

    // 下载文件到本地
    function downloadFile(filename, content, mimeType) {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
    }

    // 导出格式选择弹窗（Promise）：resolve 'csv' | 'json' | null（取消）
    function askExportFormat(title) {
        return new Promise(resolve => {
            const isDark = isDarkMode();
            const btnStyle = `
                display: block; width: 100%; margin: 8px 0; padding: 10px 0;
                background: ${isDark ? '#3d3d3d' : '#f0f0f0'};
                color: ${isDark ? '#e0e0e0' : '#000'};
                border: 1px solid ${isDark ? '#555' : '#ccc'};
                border-radius: 4px;
                cursor: pointer;
                font-size: 14px;
                font-family: '微软雅黑', sans-serif;
            `;

            const overlay = document.createElement('div');
            overlay.style.cssText = `
                position: fixed; top: 0; left: 0; right: 0; bottom: 0;
                background: rgba(0,0,0,0.45); z-index: 100000;
                display: flex; align-items: center; justify-content: center;
            `;

            const box = document.createElement('div');
            box.style.cssText = `
                background: ${isDark ? '#2d2d2d' : '#fff'};
                color: ${isDark ? '#e0e0e0' : '#000'};
                padding: 24px 32px;
                border-radius: 8px;
                box-shadow: 0 4px 20px rgba(0,0,0,0.3);
                font-family: '微软雅黑', sans-serif;
                font-size: 14px;
                min-width: 300px;
                text-align: center;
            `;

            const titleEl = document.createElement('div');
            titleEl.textContent = title;
            titleEl.style.cssText = 'font-size: 16px; font-weight: bold; margin-bottom: 8px;';

            const hintEl = document.createElement('div');
            hintEl.textContent = '请选择导出格式（A 或 B）';
            hintEl.style.cssText = `color: ${isDark ? '#999' : '#666'}; margin-bottom: 16px; font-size: 13px;`;

            const btnCsv = document.createElement('button');
            btnCsv.textContent = 'A. 导出为 CSV 表格';
            btnCsv.style.cssText = btnStyle;
            const btnJson = document.createElement('button');
            btnJson.textContent = 'B. 导出为 JSON';
            btnJson.style.cssText = btnStyle;

            const onKeydown = (e) => {
                // 避免影响后台输入框中的打字
                if (e.target.matches && e.target.matches('input, textarea, select')) return;
                if (e.key === 'a' || e.key === 'A') { e.preventDefault(); cleanup('csv'); }
                else if (e.key === 'b' || e.key === 'B') { e.preventDefault(); cleanup('json'); }
                else if (e.key === 'Escape' || e.key === 'Esc') { cleanup(null); }
            };

            const cleanup = (result) => {
                document.removeEventListener('keydown', onKeydown);
                overlay.remove();
                resolve(result);
            };

            btnCsv.addEventListener('click', () => cleanup('csv'));
            btnJson.addEventListener('click', () => cleanup('json'));
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) cleanup(null);
            });
            box.addEventListener('click', (e) => e.stopPropagation());

            document.addEventListener('keydown', onKeydown);
            box.appendChild(titleEl);
            box.appendChild(hintEl);
            box.appendChild(btnCsv);
            box.appendChild(btnJson);
            overlay.appendChild(box);
            document.body.appendChild(overlay);
        });
    }

    // 共享导出流程：选择格式 → 进度框 → 收集 → 下载
    // splitSize 可选：人数超出时按 ≤splitSize/份 拆分为多文件（黑名单导出用 3000）
    async function exportUsersFlow({ label, getUsers, splitSize }) {
        const format = await askExportFormat('导出' + label);
        if (!format) return; // 取消：连进度框都不创建

        const infoDiv = document.createElement('div');
        infoDiv.style.cssText = getInfoDivStyle();
        document.body.appendChild(infoDiv);

        const logArea = document.createElement('div');
        logArea.style.cssText = 'flex: 1; overflow-y: auto; white-space: pre-wrap; padding-bottom: 8px;';
        infoDiv.appendChild(logArea);

        const btnContainer = document.createElement('div');
        btnContainer.style.textAlign = 'center';
        const closeBtn = document.createElement('button');
        closeBtn.textContent = '停止';
        closeBtn.style.padding = '4px 16px';
        btnContainer.appendChild(closeBtn);
        infoDiv.appendChild(btnContainer);

        function appendLog(html) {
            logArea.innerHTML += html + '<br>';
            logArea.scrollTop = logArea.scrollHeight;
        }

        let stopped = false;   // 收集期间点击：停止收集；收集完成后点击：关闭窗口
        let collecting = true;
        closeBtn.addEventListener('click', () => {
            if (collecting) {
                stopped = true;
                console.log('用户请求停止收集');
            } else {
                infoDiv.remove();
            }
        });

        appendLog(`正在导出${label}...`);
        let users = [];
        try {
            users = await getUsers(appendLog, { isCancelled: () => stopped });
        } catch (e) {
            appendLog('导出失败：' + e.message);
            console.error('导出失败:', e);
            return;
        }
        collecting = false;
        closeBtn.textContent = '关闭';

        if (!users || users.length === 0) {
            appendLog('没有可导出的用户。');
            return;
        }

        const ext = format === 'csv' ? 'csv' : 'json';
        const ts = exportTimestamp(); // 时间戳只算一次，各分片文件共用
        // 多文件拆分
        const chunks = [];
        if (splitSize && users.length > splitSize) {
            for (let i = 0; i < users.length; i += splitSize) chunks.push(users.slice(i, i + splitSize));
        } else {
            chunks.push(users);
        }

        if (chunks.length > 1) {
            // confirm 同时获得 transient activation，绕过 Chrome 多文件下载提示
            const ok = confirm(`共 ${users.length} 人，将导出为 ${chunks.length} 个文件（每个 ≤${splitSize} 人）\n\n确定继续导出吗？`);
            if (!ok) {
                appendLog('用户取消了导出。');
                return;
            }
        }

        if (stopped) appendLog(`[中断] 已停止收集，导出已收集的 ${users.length} 人。`);

        for (let i = 0; i < chunks.length; i++) {
            const suffix = chunks.length > 1 ? `_part${i + 1}of${chunks.length}` : '';
            const filename = `zhihu_${label}_${ts}${suffix}.${ext}`;
            if (format === 'csv') {
                downloadFile(filename, toCsv(chunks[i]), 'text/csv;charset=utf-8');
            } else {
                downloadFile(filename, toJson(chunks[i]), 'application/json;charset=utf-8');
            }
            appendLog(`导出完成：第 ${i + 1}/${chunks.length} 份，${chunks[i].length} 人，文件 ${filename}`);
            if (i < chunks.length - 1) {
                await new Promise(r => setTimeout(r, 800)); // 分片间间隔，避免连续下载被拦截
            }
        }
        appendLog(`导出完成：共 ${users.length} 人，${chunks.length} 份文件`);
    }

    // ---------- 导出入口：点赞用户（回答/文章页） ----------
    async function exportUpvoters() {
        const pageHref = location.href;
        let apiCandidates = [];

        const answerMatch = pageHref.match(/^https:\/\/www\.zhihu\.com\/question\/(\d+)\/answer\/(\d+)/);
        const articleMatch = pageHref.match(/^https:\/\/zhuanlan\.zhihu\.com\/p\/(\d+)/);

        if (answerMatch) {
            // 两个排序：default（按粉丝量）和 newest（按点赞时间），合并去重
            apiCandidates = [
                `https://www.zhihu.com/api/v4/answers/${answerMatch[2]}/upvoters?order=default`,
                `https://www.zhihu.com/api/v4/answers/${answerMatch[2]}/upvoters?order=newest`
            ];
        } else if (articleMatch) {
            apiCandidates = [
                `https://www.zhihu.com/api/v4/articles/${articleMatch[1]}/voters?order=default`,
                `https://www.zhihu.com/api/v4/articles/${articleMatch[1]}/voters?order=newest`,
                `https://www.zhihu.com/api/v4/articles/${articleMatch[1]}/likers?order=default`,
                `https://www.zhihu.com/api/v4/articles/${articleMatch[1]}/likers?order=newest`
            ];
        } else {
            alert('当前页面不是知乎回答或文章，无法导出点赞用户。');
            return;
        }

        await exportUsersFlow({
            label: '点赞用户',
            getUsers: (log) => collectUsersPaged(apiCandidates, log)
        });
    }

    // ---------- 导出入口：关注答主的用户（回答/文章页） ----------
    async function exportAuthorFollowers() {
        const pageHref = location.href;
        let authorId = null;

        const answerMatch = pageHref.match(/^https:\/\/www\.zhihu\.com\/question\/(\d+)\/answer\/(\d+)/);
        const articleMatch = pageHref.match(/^https:\/\/zhuanlan\.zhihu\.com\/p\/(\d+)/);

        if (answerMatch) {
            try {
                const answerApi = `https://www.zhihu.com/api/v4/answers/${answerMatch[2]}`;
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
            try {
                const articleApi = `https://www.zhihu.com/api/v4/articles/${articleMatch[1]}`;
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
            alert('当前页面不是知乎回答或文章，无法导出关注答主的用户。');
            return;
        }

        await exportUsersFlow({
            label: '答主粉丝',
            getUsers: (log) => collectUsersPaged([`https://www.zhihu.com/api/v4/members/${authorId}/followers`], log)
        });
    }

    // ---------- 导出入口：自身黑名单用户 ----------
    async function exportBlockedUsers() {
        // 专栏页（zhuanlan.zhihu.com）跨域 CORS，无法访问 www.zhihu.com 的黑名单接口，
        // 且 localStorage 与主站隔离（无本地记录），提示前往主站导出
        if (!/^(www\.)?zhihu\.com$/.test(location.hostname)) {
            if (confirm('黑名单导出需要知乎主站（www.zhihu.com）。\n当前页面（' + location.hostname + '）无法访问黑名单接口。\n\n点击「确定」前往首页导出？')) {
                location.href = 'https://www.zhihu.com/';
            }
            return;
        }

        const me = await getCurrentUserId();
        if (!me) {
            alert('无法获取你的用户ID，请重新登录后重试。');
            return;
        }

        await exportUsersFlow({
            label: '黑名单用户（时间很长）',
            splitSize: 3000, // 黑名单可达 1w+，按 3000 人/份拆分为多文件
            getUsers: async (log, ctx) => {
                // 优先从知乎 API 拉取真实黑名单（paging.next 全量翻页）
                const remote = await fetchZhihuBlockedList(me, {
                    maxPages: 2500, // 知乎黑名单上限 50k；next limit=20 时约需 2500 页，is_end 会提前终止
                    onProgress: (count) => log(`已拉取 ${count} 人...`),
                    isCancelled: ctx && ctx.isCancelled
                });
                if (remote.list.length > 0) {
                    log(`从知乎拉取到 ${remote.list.length} 人`);
                    return remote.list.filter(u => u.url_token).map(u => normalizeExportUser(u));
                }
                // 兜底：本地黑名单记录（键名为 token）
                log('知乎接口不可用，使用本地黑名单记录...');
                return loadBlockedUsers()
                    .filter(u => u.token)
                    .map(u => normalizeExportUser({ url_token: u.token, name: u.name }));
            }
        });
    }

    // ---------- 导出入口：关注我的用户（我的粉丝） ----------
    async function exportMyFollowers() {
        const me = await getCurrentUserId();
        if (!me) {
            alert('无法获取你的用户ID，请重新登录后重试。');
            return;
        }
        await exportUsersFlow({
            label: '我的粉丝',
            getUsers: (log) => collectUsersPaged([`https://www.zhihu.com/api/v4/members/${me}/followers`], log)
        });
    }

    // ---------- 导出入口：我关注的用户 ----------
    async function exportMyFollowees() {
        const me = await getCurrentUserId();
        if (!me) {
            alert('无法获取你的用户ID，请重新登录后重试。');
            return;
        }
        await exportUsersFlow({
            label: '我的关注',
            getUsers: (log) => collectUsersPaged([`https://www.zhihu.com/api/v4/members/${me}/followees`], log)
        });
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

        menu.appendChild(item1);
        menu.appendChild(item2);

        // —— 二级菜单「知乎网页版美化」（样式与主菜单一致） ——
        const subMenu = document.createElement('div');
        subMenu.style.cssText = menu.style.cssText;

        // —— 深色模式切换 ——
        const item3 = document.createElement('div');
        const initialThemeMode = getThemeMode();
        item3.textContent = initialThemeMode === 'dark' ? '浅色模式' : '深色模式';
        item3.style.cssText = `padding: 8px 16px; cursor: pointer; color: ${isDark ? '#e0e0e0' : '#000'};`;
        item3.addEventListener('mouseenter', () => { item3.style.backgroundColor = isDark ? '#3d3d3d' : '#f0f0f0'; });
        item3.addEventListener('mouseleave', () => { item3.style.backgroundColor = 'transparent'; });
        item3.addEventListener('click', () => {
            subMenu.style.display = 'none';
            const nextMode = getThemeMode() === 'dark' ? 'light' : 'dark';
            setThemeMode(nextMode);
        });
        subMenu.appendChild(item3);

        // —— 知乎直答处理设置 ——
        const currentZhidaMode = getZhidaMode();
        const itemZhida = document.createElement('div');
        itemZhida.textContent = `知乎直答: ${zhidaModeLabels[currentZhidaMode]}`;
        itemZhida.style.cssText = `padding: 8px 16px; cursor: pointer; color: ${isDark ? '#e0e0e0' : '#000'};`;
        itemZhida.addEventListener('mouseenter', () => { itemZhida.style.backgroundColor = isDark ? '#3d3d3d' : '#f0f0f0'; });
        itemZhida.addEventListener('mouseleave', () => { itemZhida.style.backgroundColor = 'transparent'; });
        itemZhida.addEventListener('click', () => {
            subMenu.style.display = 'none';
            const current = getZhidaMode();
            const idx = zhidaModeCycle.indexOf(current);
            const next = zhidaModeCycle[(idx + 1) % zhidaModeCycle.length];
            setZhidaMode(next);
            itemZhida.textContent = `知乎直答: ${zhidaModeLabels[next]}`;
            // 如果当前页面有 zhida 链接，立即应用新设置
            applyZhidaMode(next);
        });
        subMenu.appendChild(itemZhida);

        // —— 超链接美化开关 ——
        const itemLink = document.createElement('div');
        itemLink.textContent = `超链接美化: ${linkBeautifyEnabled ? '开' : '关'}`;
        itemLink.style.cssText = `padding: 8px 16px; cursor: pointer; color: ${isDark ? '#e0e0e0' : '#000'};`;
        itemLink.addEventListener('mouseenter', () => { itemLink.style.backgroundColor = isDark ? '#3d3d3d' : '#f0f0f0'; });
        itemLink.addEventListener('mouseleave', () => { itemLink.style.backgroundColor = 'transparent'; });
        itemLink.addEventListener('click', () => {
            subMenu.style.display = 'none';
            const enabled = toggleLinkBeautify();
            itemLink.textContent = `超链接美化: ${enabled ? '开' : '关'}`;
        });
        subMenu.appendChild(itemLink);

        // —— 专栏优化入口（仅 zhuanlan.zhihu.com） ——
        if (location.hostname === 'zhuanlan.zhihu.com') {
            const item4 = document.createElement('div');
            const optimized = getZhuanlanOptimized();
            item4.textContent = optimized ? '专栏优化 ✓' : '优化专栏阅读';
            item4.style.cssText = `padding: 8px 16px; cursor: pointer; color: ${isDark ? '#e0e0e0' : '#000'}; border-top: 1px solid ${isDark ? '#555' : '#e0e0e0'}; margin-top: 4px; padding-top: 12px;`;
            item4.addEventListener('mouseenter', () => { item4.style.backgroundColor = isDark ? '#3d3d3d' : '#f0f0f0'; });
            item4.addEventListener('mouseleave', () => { item4.style.backgroundColor = 'transparent'; });
            item4.addEventListener('click', () => {
                subMenu.style.display = 'none';
                toggleZhuanlanOptimize();
                item4.textContent = zhuanlanSavedState ? '专栏优化 ✓' : '优化专栏阅读';
            });
            subMenu.appendChild(item4);
        }

        // —— 二级菜单「导出用户」 ——
        const exportSubMenu = document.createElement('div');
        exportSubMenu.style.cssText = menu.style.cssText;

        // 创建导出菜单项（复用统一 item 样式与 hover 逻辑）
        function createExportItem(text, handler) {
            const item = document.createElement('div');
            item.textContent = text;
            item.style.cssText = `padding: 8px 16px; cursor: pointer; color: ${isDark ? '#e0e0e0' : '#000'};`;
            item.addEventListener('mouseenter', () => { item.style.backgroundColor = isDark ? '#3d3d3d' : '#f0f0f0'; });
            item.addEventListener('mouseleave', () => { item.style.backgroundColor = 'transparent'; });
            item.addEventListener('click', () => {
                exportSubMenu.style.display = 'none';
                handler();
            });
            return item;
        }

        exportSubMenu.appendChild(createExportItem('导出点赞用户', exportUpvoters));
        exportSubMenu.appendChild(createExportItem('导出关注答主的用户', exportAuthorFollowers));
        exportSubMenu.appendChild(createExportItem('导出自身黑名单用户', exportBlockedUsers));
        exportSubMenu.appendChild(createExportItem('导出关注我的用户', exportMyFollowers));
        exportSubMenu.appendChild(createExportItem('导出我关注的用户', exportMyFollowees));

        document.body.appendChild(exportSubMenu);

        document.body.appendChild(subMenu);

        // —— 主菜单：二级菜单入口 ——
        const itemSub = document.createElement('div');
        itemSub.textContent = '知乎网页版美化 ›';
        itemSub.style.cssText = `padding: 8px 16px; cursor: pointer; color: ${isDark ? '#e0e0e0' : '#000'}; border-top: 1px solid ${isDark ? '#555' : '#e0e0e0'}; margin-top: 4px; padding-top: 12px;`;
        itemSub.addEventListener('mouseenter', () => { itemSub.style.backgroundColor = isDark ? '#3d3d3d' : '#f0f0f0'; });
        itemSub.addEventListener('mouseleave', () => { itemSub.style.backgroundColor = 'transparent'; });
        itemSub.addEventListener('click', () => {
            menu.style.display = 'none';
            subMenu.style.display = 'block';
        });
        menu.appendChild(itemSub);

        // —— 主菜单：导出用户二级菜单入口 ——
        const itemExport = document.createElement('div');
        itemExport.textContent = '导出用户 ›';
        itemExport.style.cssText = `padding: 8px 16px; cursor: pointer; color: ${isDark ? '#e0e0e0' : '#000'}; border-top: 1px solid ${isDark ? '#555' : '#e0e0e0'}; margin-top: 4px; padding-top: 12px;`;
        itemExport.addEventListener('mouseenter', () => { itemExport.style.backgroundColor = isDark ? '#3d3d3d' : '#f0f0f0'; });
        itemExport.addEventListener('mouseleave', () => { itemExport.style.backgroundColor = 'transparent'; });
        itemExport.addEventListener('click', () => {
            menu.style.display = 'none';
            exportSubMenu.style.display = 'block';
        });
        menu.appendChild(itemExport);

        document.body.appendChild(menu);

        floatBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            // 二级菜单打开时点击 ⚙ 返回主菜单
            if (subMenu.style.display === 'block' || exportSubMenu.style.display === 'block') {
                subMenu.style.display = 'none';
                exportSubMenu.style.display = 'none';
                menu.style.display = 'block';
                return;
            }
            const isVisible = menu.style.display === 'block';
            menu.style.display = isVisible ? 'none' : 'block';
        });

        document.addEventListener('click', (e) => {
            if (!menu.contains(e.target) && !subMenu.contains(e.target) && !exportSubMenu.contains(e.target) && e.target !== floatBtn) {
                menu.style.display = 'none';
                subMenu.style.display = 'none';
                exportSubMenu.style.display = 'none';
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

        // 保存并去除知乎直答按钮（保留正文实体链接，交给直答模式处理）
        saved.zhidaBtns = [];
        document.querySelectorAll('a[href*="zhida.zhihu.com"]').forEach(el => {
            if (el.classList.contains('RichContent-EntityWord')) return; // 正文实体链接不删除
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

        // 后台同步知乎真实黑名单到本地（不影响页面加载，异步执行）
        syncBlockedUsersFromZhihu().then(ok => {
            if (ok) {
                // 同步完成后刷新一次标注
                labelBlockedLinks();
            }
        }).catch(e => console.warn('黑名单同步失败:', e));

        // 需要响应 DOM 变化的处理函数集合
        const domHandlers = [];

        // 标注已拉黑用户
        domHandlers.push(labelBlockedLinks);

        // 问题页面：操作栏「拉黑」按钮
        if (/^https:\/\/www\.zhihu\.com\/question\/\d+$/.test(location.href)) {
            domHandlers.push(addBlockButtonsToActionBar);
        }

        // 个人主页：添加「拉黑 Ta」按钮
        if (isProfilePage()) {
            domHandlers.push(addProfilePageBlockButton);
        }

        // —— 自动应用已保存的偏好 ——

        // 专栏优化
        if (location.hostname === 'zhuanlan.zhihu.com' && getZhuanlanOptimized()) {
            toggleZhuanlanOptimize(true);
        }

        // 知乎直答链接处理
        const savedZhidaMode = getZhidaMode();
        if (savedZhidaMode !== 'disabled') {
            domHandlers.push(() => applyZhidaMode(savedZhidaMode));
        }

        // —— 超链接美化（可在菜单开关）+ 去除中转（自动应用） ——
        domHandlers.push(() => { applyLinkBeautify(); removeLinkRedirect(); });

        // 统一 MutationObserver：防抖批量执行所有 DOM 处理（替代原来多个独立 Observer）
        let scheduled = false;
        const runHandlers = () => {
            scheduled = false;
            for (const fn of domHandlers) {
                try { fn(); } catch (e) { console.warn('DOM 处理出错:', e); }
            }
        };

        // 首次执行
        runHandlers();

        const observer = new MutationObserver(() => {
            if (scheduled) return;
            scheduled = true;
            // 用双重延时（rAF + setTimeout）合并高频 DOM 变更，避免频繁全量扫描
            requestAnimationFrame(() => {
                setTimeout(runHandlers, 120);
            });
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
