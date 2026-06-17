(async () => {
    const MY_USER_ID = prompt(
        '请输入你的知乎ID（个人主页URL中 people/ 后面的部分）\n' +
        '例如：https://www.zhihu.com/people/your-id 中的 "your-id"'
    );

    if (!MY_USER_ID) {
        console.error('未输入知乎ID，脚本已终止。');
        return;
    }
    console.log(`你输入的ID是：${MY_USER_ID}`);

    const pageHref = location.href;
    const answerMatch = pageHref.match(/^https:\/\/www\.zhihu\.com\/question\/(\d+)\/answer\/(\d+)/);
    if (!answerMatch) {
        console.error('当前页面不是知乎回答页，请在回答页面运行此脚本。');
        return;
    }
    const targetAnswerId = answerMatch[2];
    const votersApi = `https://www.zhihu.com/api/v4/answers/${targetAnswerId}/upvoters`;

    async function getAllUserIds(apiUrl) {
        let allIds = new Set();
        let offset = 0;
        const limit = 20;
        let isEnd = false;

        while (!isEnd) {
            const url = `${apiUrl}?limit=${limit}&offset=${offset}`;
            try {
                const response = await fetch(url);
                if (!response.ok) {
                    console.error(`获取数据失败: ${response.status}`);
                    break;
                }
                const data = await response.json();
                const users = data.data || [];
                users.forEach(user => allIds.add(user.id));
                isEnd = data.paging.is_end;
                offset += limit;
            } catch (e) {
                console.error('请求出错:', e);
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
    infoDiv.innerHTML = '<b>正在获取你的关注和粉丝列表...</b><br>';

    const followees = await getAllUserIds(`https://www.zhihu.com/api/v4/members/${MY_USER_ID}/followees`);
    const followers = await getAllUserIds(`https://www.zhihu.com/api/v4/members/${MY_USER_ID}/followers`);
    const safeUserIds = new Set([...followees, ...followers]);

    infoDiv.innerHTML = `<b>已加载安全列表：${safeUserIds.size} 人 (关注 + 粉丝)</b><br><hr>`;
    console.log(`已加载安全列表：${safeUserIds.size} 人 (关注 + 粉丝)`);

    const blockedUsers = [];
    const sleep = timeout => new Promise(done => setTimeout(done, timeout));

    let pageOffset = 0;
    let reachedLastPage = false;
    let handledUsers = 0;
    let estimatedUsers = 0;

    while (!reachedLastPage) {
        const requestUrl = `${votersApi}?limit=10&offset=${pageOffset}`;
        try {
            const listResponse = await fetch(requestUrl);
            const listPayload = await listResponse.json();
            if (!listResponse.ok) {
                console.error('Failed to fetch upvoters:', listResponse.status, listResponse.statusText, listPayload);
                break;
            }
            const voterList = Array.isArray(listPayload.data) ? listPayload.data : [];
            estimatedUsers += voterList.length;

            for (const voterInfo of voterList) {
                handledUsers += 1;
                const userId = voterInfo.id;
                const userName = voterInfo.name;
                const userToken = voterInfo.url_token;
                const profileUrl = `https://www.zhihu.com${voterInfo.url}`;

                // 检查是否在安全列表中
                if (safeUserIds.has(userId)) {
                    infoDiv.innerHTML += `跳过 (关注/粉丝)：${userName} (${handledUsers}/${estimatedUsers})<br>`;
                    infoDiv.scrollTop = infoDiv.scrollHeight;
                    console.log(`[${handledUsers}/${estimatedUsers}] 跳过 ${userName} (在安全列表中)`);
                    continue;
                }

                // 执行拉黑
                const actionUrl = `https://www.zhihu.com/api/v4/members/${userToken}/actions/block`;
                infoDiv.scrollTop = infoDiv.scrollHeight;

                const actionResponse = await fetch(actionUrl, { method: 'POST' });
                if (actionResponse.ok) {
                    blockedUsers.push({ userName, userToken, profileUrl });
                    infoDiv.innerHTML += `已屏蔽：${userName}<br>`;
                } else {
                    infoDiv.innerHTML += `失败：${userName} (状态 ${actionResponse.status})<br>`;
                }
                infoDiv.scrollTop = infoDiv.scrollHeight;
                console.log(`[${handledUsers}/${estimatedUsers}] ${userName} -> ${actionResponse.ok ? '成功' : '失败'}`);

                await sleep(1000);
            }

            reachedLastPage = !!(listPayload.paging && listPayload.paging.is_end);
            pageOffset += 10;
        } catch (err) {
            console.error('Error:', err);
            break;
        }
    }

    infoDiv.innerHTML += `<hr><b>全部完成！共屏蔽 ${blockedUsers.length} 人</b><br>`;
})();