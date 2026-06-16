(async () => {
    const pageHref = location.href;
    const answerMatch = pageHref.match(/^https:\/\/www\.zhihu\.com\/question\/(\d+)\/answer\/(\d+)/);
    if (!answerMatch) {
        console.error("URL does not match the expected format.");
        return;
    }
    const targetAnswerId = answerMatch[2];
    const votersApi = `https://www.zhihu.com/api/v4/answers/${targetAnswerId}/upvoters`;

    // 创建浮动显示框（让你实时看到拉黑了谁）
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
    infoDiv.innerHTML = '<b>拉黑进度</b><br>';

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
                console.error("Failed to fetch upvoters:", listResponse.status, listResponse.statusText, listPayload);
                break;
            }
            const voterList = Array.isArray(listPayload.data) ? listPayload.data : [];
            estimatedUsers += voterList.length;

            for (const voterInfo of voterList) {
                handledUsers += 1;
                const userName = voterInfo.name;
                const userToken = voterInfo.url_token;
                const profileUrl = `https://www.zhihu.com${voterInfo.url}`;
                const actionUrl = `https://www.zhihu.com/api/v4/members/${userToken}/actions/block`;

                const actionResponse = await fetch(actionUrl, { method: "POST" });
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
            console.error("Error:", err);
            break;
        }
    }

    infoDiv.innerHTML += `<hr><b>全部完成！共屏蔽 ${blockedUsers.length} 人</b><br>`;
})();
