/**
 * filedisk _worker.js
 * 核心全栈逻辑：静态托管 + API + D1数据库 + 智能缓存 + 阿里云盘转发
 * 更新 v6：新增网盘浏览功能 (API /api/list)
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // === 1. 静态资源托管 ===
    if (!path.startsWith('/api') && !path.startsWith('/d')) {
      return env.ASSETS.fetch(request);
    }

    // === 通用函数：获取有效 AccessToken ===
    async function getAccessToken() {
        const tokenRecord = await env.DB.prepare("SELECT * FROM tokens ORDER BY RANDOM() LIMIT 1").first();
        if (!tokenRecord) throw new Error('No tokens available');

        let accessToken = tokenRecord.access_token;
        const nowTime = Math.floor(Date.now() / 1000);

        if (!accessToken || !tokenRecord.expires_at || tokenRecord.expires_at < (nowTime + 60)) {
            const tokenRes = await fetch('https://api.alistgo.com/alist/ali_open/token', {
                method: 'POST',
                body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: tokenRecord.token.trim() }),
                headers: { 'Content-Type': 'application/json' }
            });
            const tokenData = await tokenRes.json();
            if (!tokenData.access_token) throw new Error('Token刷新失败');
            
            accessToken = tokenData.access_token;
            const newExpire = nowTime + (tokenData.expires_in || 7200);
            const newRefreshToken = tokenData.refresh_token || tokenRecord.token;
            env.DB.prepare("UPDATE tokens SET token = ?, access_token = ?, expires_at = ? WHERE id = ?")
                  .bind(newRefreshToken, accessToken, newExpire, tokenRecord.id).run().catch(e => console.error(e));

        }
        return accessToken;
    }

    // === 2. API: 管理员登录 ===
    if (path === '/api/login' && request.method === 'POST') {
      try {
        const { username, password } = await request.json();
        const user = await env.DB.prepare('SELECT * FROM admin WHERE username = ? AND password = ?').bind(username, password).first();
        if (user) return new Response(JSON.stringify({ success: true, token: 'session_ok' }), { headers: { 'Content-Type': 'application/json' } });
        return new Response(JSON.stringify({ success: false, msg: '账号或密码错误' }), { status: 401 });
      } catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
    }

    // === 3. API: Token 管理 (查询/添加/修改) ===
    if (path === '/api/tokens') {
        if (request.method === 'GET') {
            const { results } = await env.DB.prepare('SELECT id, name, substr(token, 1, 10) || "..." as token_preview, created_at FROM tokens ORDER BY id DESC').all();
            return new Response(JSON.stringify(results), { headers: { 'Content-Type': 'application/json' } });
        }
        if (request.method === 'POST') {
            const { name, token } = await request.json();
            await env.DB.prepare("INSERT INTO tokens (name, token) VALUES (?, ?)").bind(name, token.trim()).run();
            return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
        }
        if (request.method === 'PUT') {
            const { id, name, token } = await request.json();
            if (token && token.trim() !== '') {
                await env.DB.prepare("UPDATE tokens SET name = ?, token = ?, access_token = NULL, expires_at = NULL WHERE id = ?")
                      .bind(name, token.trim(), id).run();
            } else {
                await env.DB.prepare("UPDATE tokens SET name = ? WHERE id = ?").bind(name, id).run();
            }
            return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
        }
        if (request.method === 'DELETE') {
             const { id } = await request.json();
             await env.DB.prepare("DELETE FROM tokens WHERE id = ?").bind(id).run();
             return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
        }
    }

    // === 4. API: 修改管理员密码 ===
    if (path === '/api/password' && request.method === 'POST') {
      const { username, password } = await request.json();
      await env.DB.prepare("UPDATE admin SET username = ?, password = ? WHERE id = 1").bind(username, password).run();
      return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    // === 5. [新增] API: 获取网盘列表 (用于前端选择 Drive) ===
    if (path === '/api/drives' && request.method === 'GET') {
        try {
            const token = await getAccessToken();
            const res = await fetch('https://openapi.alipan.com/adrive/v1.0/user/getDriveInfo', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
            const data = await res.json();
            return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
        } catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
    }

    // === 6. [新增] API: 获取文件列表 ===
    if (path === '/api/list' && request.method === 'POST') {
        try {
            const { drive_id, parent_file_id } = await request.json();
            const token = await getAccessToken();
            
            const res = await fetch('https://openapi.alipan.com/adrive/v1.0/openFile/list', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    drive_id: drive_id, 
                    parent_file_id: parent_file_id || 'root',
                    limit: 100,
                    order_by: "name",
                    order_direction: "ASC"
                })
            });
            const data = await res.json();
            return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
        } catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
    }

    // === 7. 核心业务: 智能下载 (v5 逻辑) ===
    if (path === '/d') {
      const fileId = url.searchParams.get('id');
      if (!fileId) return new Response('Missing File ID', { status: 400 });

      // [新增] 极简短链接: 如果直接访问 /d/xxxx 也可以
      // 这里保持 query param 模式: /d?id=xxx

      try {
        const tokenRecord = await env.DB.prepare("SELECT * FROM tokens ORDER BY RANDOM() LIMIT 1").first();
        if (!tokenRecord) return new Response('No tokens available.', { status: 503 });

        let accessToken = tokenRecord.access_token;
        const nowTime = Math.floor(Date.now() / 1000);

        // 刷新 Token 逻辑 (复用)
        if (!accessToken || !tokenRecord.expires_at || tokenRecord.expires_at < (nowTime + 60)) {
            // ... (省略重复代码，上面 getAccessToken 已包含，但为了 fetch 独立性这里保留或简化)
            // 为简化，这里直接用上面定义的 getAccessToken 逻辑，但在 fetch 中需重写一遍或提取
            // 简单起见，这里直接调用 getAccessToken 拿到 token 即可
             accessToken = await getAccessToken();
        }

        // 获取 Drive ID
        const userRes = await fetch('https://openapi.alipan.com/adrive/v1.0/user/getDriveInfo', {
            method: 'POST', headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({})
        });
        const userData = await userRes.json();
        const driveSet = new Set();
        if (userData.resource_drive_id) driveSet.add(userData.resource_drive_id);
        if (userData.backup_drive_id) driveSet.add(userData.backup_drive_id);
        if (userData.default_drive_id) driveSet.add(userData.default_drive_id);
        const driveList = Array.from(driveSet);

        let downloadUrl = null;
        let lastError = null;

        for (const dId of driveList) {
            try {
                const downRes = await fetch('https://openapi.alipan.com/adrive/v1.0/openFile/getDownloadUrl', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ file_id: fileId, drive_id: dId })
                });
                const downData = await downRes.json();
                
                if (downData.url) { downloadUrl = downData.url; break; }
                
                const msg = downData.message || downData.code || '';
                if (msg.includes('folder') || msg.includes('InvalidResourceType')) {
                    // 文件夹穿透逻辑
                    const listRes = await fetch('https://openapi.alipan.com/adrive/v1.0/openFile/list', {
                        method: 'POST', headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ parent_file_id: fileId, drive_id: dId, limit: 1 })
                    });
                    const listData = await listRes.json();
                    if (listData.items && listData.items.length > 0) {
                        const first = listData.items.find(i => i.type === 'file');
                        if (first) {
                            const subRes = await fetch('https://openapi.alipan.com/adrive/v1.0/openFile/getDownloadUrl', {
                                method: 'POST', headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                                body: JSON.stringify({ file_id: first.file_id, drive_id: dId })
                            });
                            const subData = await subRes.json();
                            if (subData.url) { downloadUrl = subData.url; break; }
                        }
                    }
                }
                lastError = msg;
            } catch (e) { lastError = e.message; }
        }

        if (!downloadUrl) throw new Error(`下载失败: ${lastError}`);

        return new Response(null, {
            status: 302,
            headers: { 'Location': downloadUrl, 'Referrer-Policy': 'no-referrer' }
        });

      } catch (e) {
        return new Response(`Error: ${e.message}`, { status: 400, headers: {'Content-Type': 'text/plain;charset=UTF-8'} });
      }
    }
    
    // 短链接跳转支持 /67xxxx -> /d?id=67xxx
    if (path.length > 20 && /^\/[a-zA-Z0-9]+$/.test(path)) {
        return Response.redirect(`${url.origin}/d?id=${path.slice(1)}`, 302);
    }

    return new Response('Not Found', { status: 404 });
  }
};
