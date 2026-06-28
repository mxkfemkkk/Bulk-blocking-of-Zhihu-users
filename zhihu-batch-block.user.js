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
        console.error('无法获取知乎ID，脚本已终止。');
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
        background: #fff; color: #000; padding: 12px 20px;
        border-radius: 4px; font-family: '微软雅黑', sans-serif; font-size: 14px;
        max-height: 500px; overflow: hidden;
        width: 420px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        border: 1px solid #999;
        display: flex; flex-direction: column;
    `;
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
        console.log('用户请求停止，将在下一个用户处理前终止。');
    });

    function appendLog(html) {
        logArea.innerHTML += html + '<br>';
        logArea.scrollTop = logArea.scrollHeight;
    }

    function tokenLink(userToken) {
        return `<a href="https://www.zhihu.com/people/${userToken}" target="_blank">${userToken}</a>`;
    }

    appendLog('正在获取你的关注和粉丝列表（白名单）...');

    const followees = await getAllUserIds(`https://www.zhihu.com/api/v4/members/${MY_USER_ID}/followees`);
    const followers = await getAllUserIds(`https://www.zhihu.com/api/v4/members/${MY_USER_ID}/followers`);
    const safeUserIds = new Set([...followees, ...followers]);

    appendLog(`白名单：${safeUserIds.size} 人 (关注 + 粉丝)`);
    appendLog('─────────────────────────────');

    const blockedUsers = [];
    const sleep = timeout => new Promise(done => setTimeout(done, timeout));

    let currentApiIndex = 0;
    let votersApi = apiCandidates[0];
    let pageOffset = 0;
    let reachedLastPage = false;
    let handledUsers = 0;
    let estimatedUsers = 0;

    while (!reachedLastPage && !shouldStop) {
        const requestUrl = `${votersApi}?limit=10&offset=${pageOffset}`;
        try {
            const listResponse = await fetchWithCreds(requestUrl);
            const listPayload = await safeJson(listResponse);
            if (!listPayload) {
                if (currentApiIndex < apiCandidates.length - 1) {
                    currentApiIndex++;
                    votersApi = apiCandidates[currentApiIndex];
                    appendLog(`切换到备用 API: ${votersApi}`);
                    continue;
                } else {
                    appendLog('所有 API 均返回空数据，终止');
                    break;
                }
            }
            const voterList = listPayload.data || [];
            estimatedUsers += voterList.length;

            for (const voterInfo of voterList) {
                if (shouldStop) {
                    appendLog('已停止，不再继续处理。');
                    break;
                }

                handledUsers++;
                const userId = voterInfo.id;
                const userName = voterInfo.name;
                const userToken = voterInfo.url_token;
                const profileUrl = `https://www.zhihu.com${voterInfo.url}`;

                if (safeUserIds.has(userId)) {
                    appendLog(`跳过 (关注/粉丝)：${userName} (${tokenLink(userToken)}) [${handledUsers}/${estimatedUsers}]`);
                    continue;
                }

                let isSuspectedSpam = false;
                try {
                    const userInfoUrl = `https://www.zhihu.com/api/v4/members/${userToken}`;
                    const infoResponse = await fetchWithCreds(userInfoUrl);
                    const infoData = await safeJson(infoResponse);
                    if (infoData) {
                        const createdAt = infoData.created_at;
                        const followeeCount = infoData.followee_count;
                        const now = Math.floor(Date.now() / 1000);
                        const isOldEnough = (now - createdAt) > 7 * 24 * 3600;
                        const hasFewFollowees = (followeeCount !== undefined && followeeCount <= 1);

                        let hasActivity = false;
                        try {
                            const activityUrl = `https://www.zhihu.com/api/v4/members/${userToken}/activities?limit=1`;
                            const actResponse = await fetchWithCreds(activityUrl);
                            const actData = await safeJson(actResponse);
                            if (actData && actData.data && actData.data.length > 0) {
                                hasActivity = true;
                            }
                        } catch (e) {
                            console.warn(`获取 ${userName} 动态失败:`, e);
                            hasActivity = true; // 保守认为有动态
                        }

                        if (isOldEnough && hasFewFollowees && !hasActivity) {
                            isSuspectedSpam = true;
                        }
                    }
                } catch (e) {
                    console.warn(`获取用户 ${userName} 信息失败:`, e);
                }

                if (isSuspectedSpam) {
                    appendLog(`跳过疑似小号：${userName} (${tokenLink(userToken)}) [${handledUsers}/${estimatedUsers}]`);
                    continue;
                }

                const actionUrl = `https://www.zhihu.com/api/v4/members/${userToken}/actions/block`;
                const actionResponse = await fetchWithCreds(actionUrl, { method: 'POST' });
                if (actionResponse.ok) {
                    blockedUsers.push({ userName, userToken, profileUrl });
                    appendLog(`已屏蔽：${userName} (${tokenLink(userToken)}) [${handledUsers}/${estimatedUsers}]`);
                } else {
                    const errText = await actionResponse.text().catch(() => '');
                    appendLog(`失败：${userName} (${tokenLink(userToken)}) 状态 ${actionResponse.status}`);
                    console.warn(`拉黑失败 ${userName}: ${actionResponse.status} - ${errText}`);
                }

                await sleep(1000);
            }

            if (shouldStop) break;

            reachedLastPage = !!(listPayload.paging && listPayload.paging.is_end);
            pageOffset += 10;
        } catch (err) {
            console.error('主循环出错:', err);
            if (err.message && err.message.includes('405') && currentApiIndex < apiCandidates.length - 1) {
                currentApiIndex++;
                votersApi = apiCandidates[currentApiIndex];
                appendLog(`遇到405，切换到备用 API: ${votersApi}`);
                continue;
            } else {
                break;
            }
        }
    }

    if (shouldStop) {
        appendLog('用户主动停止，未完成全部处理。');
    }
    appendLog(`全部完成！共屏蔽 ${blockedUsers.length} 人`);
})();