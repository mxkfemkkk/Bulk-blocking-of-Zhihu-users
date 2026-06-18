(async () => {
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
            console.warn('JSON 解析失败，原始内容:', text.substring(0, 200));
            throw new Error('JSON 解析失败: ' + e.message);
        }
    };

    async function getCurrentUserId() {
        try {
            if (window.__INITIAL_STATE__?.config?.currentUser?.urlToken) {
                const userId = window.__INITIAL_STATE__.config.currentUser.urlToken;
                console.log(`自动检测到用户ID: ${userId}`);
                return userId;
            }
        } catch (e) {}

        try {
            const response = await fetchWithCreds('https://www.zhihu.com/api/v4/me');
            const data = await safeJson(response);
            if (data && data.url_token) {
                console.log(`通过API获取用户ID: ${data.url_token}`);
                return data.url_token;
            }
        } catch (e) {
            console.warn('通过API获取用户信息失败:', e);
        }

        const manualInput = prompt('无法自动获取用户ID，请手动输入你的知乎ID：');
        if (manualInput) {
            console.log(`手动输入: ${manualInput}`);
            return manualInput;
        }
        return null;
    }

    const MY_USER_ID = await getCurrentUserId();
    if (!MY_USER_ID) {
        console.error('❌ 无法获取知乎ID，脚本已终止。');
        return;
    }

    const pageHref = location.href;
    let apiCandidates = [];
    let contentType = '';
    let contentId = '';

    const answerMatch = pageHref.match(/^https:\/\/www\.zhihu\.com\/question\/(\d+)\/answer\/(\d+)/);
    const articleMatch = pageHref.match(/^https:\/\/zhuanlan\.zhihu\.com\/p\/(\d+)/);

    if (answerMatch) {
        contentType = '回答';
        contentId = answerMatch[2];
        apiCandidates = [`https://www.zhihu.com/api/v4/answers/${contentId}/upvoters`];
        console.log(`识别为【回答】页面，ID: ${contentId}`);
    } else if (articleMatch) {
        contentType = '文章';
        contentId = articleMatch[1];
        apiCandidates = [
            `https://www.zhihu.com/api/v4/articles/${contentId}/voters`,
            `https://www.zhihu.com/api/v4/articles/${contentId}/likers`
        ];
        console.log(`识别为【文章】页面，ID: ${contentId}`);
    } else {
        console.error('当前页面不是知乎回答或文章页。');
        return;
    }
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
                users.forEach(user => allIds.add(user.id));
                isEnd = data.paging && data.paging.is_end;
                offset += limit;
            } catch (e) {
                console.error(`获取数据失败 (${url}):`, e);
                break;
            }
        }
        return allIds;
    }
    const infoDiv = document.createElement('div');
    infoDiv.style.cssText = `
        position: fixed; top: 10px; right: 10px; z-index: 9999;
        background: #000; color: #0f0; padding: 12px 20px;
        border-radius: 8px; font-family: monospace; font-size: 14px;
        max-height: 400px; overflow-y: auto; width: 350px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.5);
        border: 1px solid #0f0;
    `;
    document.body.appendChild(infoDiv);
    infoDiv.innerHTML = '<b>正在获取你的关注和粉丝列表，这一步是为了添加一套白名单机制，防止误伤...</b><br>';

    const followees = await getAllUserIds(`https://www.zhihu.com/api/v4/members/${MY_USER_ID}/followees`);
    const followers = await getAllUserIds(`https://www.zhihu.com/api/v4/members/${MY_USER_ID}/followers`);
    const safeUserIds = new Set([...followees, ...followers]);

    infoDiv.innerHTML = `<b>安全列表：${safeUserIds.size} 人 (关注 + 粉丝)</b><br><hr>`;
    console.log(`安全列表：${safeUserIds.size} 人`);

    const blockedUsers = [];
    const sleep = timeout => new Promise(done => setTimeout(done, timeout));

    let currentApiIndex = 0;
    let votersApi = apiCandidates[0]; 

    let pageOffset = 0;
    let reachedLastPage = false;
    let handledUsers = 0;
    let estimatedUsers = 0;

    while (!reachedLastPage) {
        const requestUrl = `${votersApi}?limit=10&offset=${pageOffset}`;
        try {
            const listResponse = await fetchWithCreds(requestUrl);
            const listPayload = await safeJson(listResponse);
            if (!listPayload) {
                if (currentApiIndex < apiCandidates.length - 1) {
                    currentApiIndex++;
                    votersApi = apiCandidates[currentApiIndex];
                    console.log(`切换到备用 API: ${votersApi}`);
                    continue; 
                } else {
                    console.warn('所有 API 均返回空数据，终止');
                    break;
                }
            }
            const voterList = listPayload.data || [];
            estimatedUsers += voterList.length;
            for (const voterInfo of voterList) {
                handledUsers++;
                const userId = voterInfo.id;
                const userName = voterInfo.name;
                const userToken = voterInfo.url_token;
                const profileUrl = `https://www.zhihu.com${voterInfo.url}`;
                if (safeUserIds.has(userId)) {
                    infoDiv.innerHTML += `跳过 (关注/粉丝)：${userName} (${handledUsers}/${estimatedUsers})<br>`;
                    infoDiv.scrollTop = infoDiv.scrollHeight;
                    console.log(`跳过 ${userName} (在安全列表)`);
                    continue;
                }

                // 检查小号
                const isDefaultName = /^知乎用户[A-Za-z0-9]+$/.test(userName);
                let isInactiveAndDefault = false;
                if (isDefaultName) {
                    try {
                        const activityUrl = `https://www.zhihu.com/api/v4/members/${userToken}/activities?limit=1`;
                        const actResponse = await fetchWithCreds(activityUrl);
                        const actData = await safeJson(actResponse);
                        if (!actData || !actData.data || actData.data.length === 0) {
                            isInactiveAndDefault = true;
                        }
                    } catch (e) {
                        console.warn(`获取 ${userName} 动态失败:`, e);
                        isInactiveAndDefault = false;
                    }
                }

                if (isDefaultName && isInactiveAndDefault) {
                    infoDiv.innerHTML += `⏭️ 跳过疑似小号：${userName} (${handledUsers}/${estimatedUsers})<br>`;
                    infoDiv.scrollTop = infoDiv.scrollHeight;
                    console.log(`跳过小号 ${userName} (无动态)`);
                    continue;
                }

                // 执行拉黑
                const actionUrl = `https://www.zhihu.com/api/v4/members/${userToken}/actions/block`;
                infoDiv.scrollTop = infoDiv.scrollHeight;

                const actionResponse = await fetchWithCreds(actionUrl, { method: 'POST' });
                if (actionResponse.ok) {
                    blockedUsers.push({ userName, userToken, profileUrl });
                    infoDiv.innerHTML += `已屏蔽：${userName}<br>`;
                } else {
                    const errText = await actionResponse.text().catch(() => '');
                    infoDiv.innerHTML += `❌ 失败：${userName} (状态 ${actionResponse.status})<br>`;
                    console.warn(`拉黑失败 ${userName}: ${actionResponse.status} - ${errText}`);
                }
                infoDiv.scrollTop = infoDiv.scrollHeight;
                await sleep(1000);
            }

            reachedLastPage = !!(listPayload.paging && listPayload.paging.is_end);
            pageOffset += 10;
        } catch (err) {
            console.error('主循环出错:', err);
            // 如果是 405 且还有备用 API，则切换
            if (err.message && err.message.includes('405') && currentApiIndex < apiCandidates.length - 1) {
                currentApiIndex++;
                votersApi = apiCandidates[currentApiIndex];
                console.log(`浏览器遇到405错误，切换到备用 API: ${votersApi}`);
                continue;
            } else {
                break;
            }
        }
    }

    // ---------- 汇总 ----------
    infoDiv.innerHTML += `<hr><b>全部完成！共屏蔽 ${blockedUsers.length} 人</b><br>`;
})();