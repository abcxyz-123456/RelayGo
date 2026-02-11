/**
 * RelayGo - 新一代 Telegram 私聊机器人
 * 项目地址: https://github.com/abcxyz-123456/RelayGo
 * 版本: 1.1.6 (Standalone)
 * 官方频道：https://t.me/RelayGo
 * 当前版本可能仍不稳定，如遇到 BUG 请提交至 issues
 */

// 中心化服务配置，非必要请勿修改
const CENTRAL_API_URL = "https://verify.wzxabc.eu.org";
const CENTRAL_BOT_USERNAME = "RelayVerifyBot";
const CENTRAL_WEBAPP_NAME = "verify";
const FIXED_BRAND_MSG = "🔥 基于 @RelayGo 开源项目构建";
const CACHE_TTL_BAN_CHECK = 3600 * 24;     // 全局封禁状态缓存24小时

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

// Worker 级内存缓存
const memCache = new Map();
const MEMORY_CACHE_TTL = 1800_000; // 30 分钟

function memGet(key) {
    const item = memCache.get(key);
    if (!item) return undefined;
    if (Date.now() > item.expiry) { memCache.delete(key); return undefined; }
    return item.value;
}
function memSet(key, value, ttlMs = MEMORY_CACHE_TTL) {
    memCache.set(key, { value, expiry: Date.now() + ttlMs });
    if (memCache.size > 2000) memCache.clear(); // 缓存清理，防止内存溢出
}
function memDelete(key) { memCache.delete(key); }

// 工具函数
function escapeHtml(unsafe) {
    if (typeof unsafe !== 'string') return String(unsafe || '');
    return unsafe.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
const errorResponse = (msg, status = 500) => jsonResponse({ error: msg }, status);

async function tgRequest(token, method, payload) {
    const url = `https://api.telegram.org/bot${token}/${method}`;
    try {
        const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const result = await resp.json();
        if (!result.ok) {
            console.error(`[TG API Error] Method: ${method}, Error: ${result.description}, Payload:`, JSON.stringify(payload));
        }
        return result;
    } catch (e) {
        console.error(`[Network Error] Method: ${method}, Error:`, e);
        return { ok: false, description: e.message };
    }
}

// 中心化 API 调用
async function callCentralApi(endpoint, payload) {
    try {
        const baseUrl = CENTRAL_API_URL.endsWith('/') ? CENTRAL_API_URL.slice(0, -1) : CENTRAL_API_URL;
        const headers = { 'Content-Type': 'application/json' };

        const resp = await fetch(`${baseUrl}${endpoint}`, {
            method: 'POST', headers: headers,
            body: JSON.stringify(payload)
        });
        if (!resp.ok) {
            console.error(`Central API Error [${endpoint}]: HTTP ${resp.status}`);
            return null;
        }
        return await resp.json();
    } catch (e) {
        console.error(`Central API Network Error [${endpoint}]:`, e);
        return null;
    }
}

// 错误上报
async function reportError(env, error, context = "") {
    if (env.OWNER_ID && env.BOT_TOKEN) {
        await tgRequest(env.BOT_TOKEN, 'sendMessage', {
            chat_id: env.OWNER_ID,
            text: `🚨 Error: ${context}\n${error.message}`
        });
    }
}

// 按钮解析器
function parseButtons(input) {
    if (!input) return null;
    const rows = [];
    let totalCount = 0;

    const lines = input.split(',');
    for (const line of lines) {
        if (!line.trim()) continue;
        const row = [];
        const items = line.split('|');
        for (const item of items) {
            if (totalCount >= 3) break;

            const separatorMatch = item.match(/\s-\s/);
            let text, url;
            if (separatorMatch) {
                const idx = separatorMatch.index;
                text = item.substring(0, idx).trim();
                url = item.substring(idx + separatorMatch[0].length).trim();
            } else {
                const parts = item.split('-');
                if (parts.length >= 2) {
                    url = parts.pop().trim();
                    text = parts.join('-').trim();
                }
            }

            if (text && url) {
                row.push({ text, url });
                totalCount++;
            }
        }
        if (row.length > 0) rows.push(row);
        if (totalCount >= 3) break;
    }
    return rows.length > 0 ? rows : null;
}

// 发送欢迎消息
async function sendWelcomeMessage(env, userId) {
    const welcomeMsg = await env.KV.get('config:welcome_msg') || "👋 欢迎使用本机器人！";
    let welcomeText = welcomeMsg;
    welcomeText += `\n\n${FIXED_BRAND_MSG}`;

    const payload = { chat_id: userId, text: welcomeText, disable_web_page_preview: true };
    const buttonsJson = await env.KV.get('config:welcome_buttons');
    if (buttonsJson) {
        try { payload.reply_markup = { inline_keyboard: JSON.parse(buttonsJson) }; } catch (e) { }
    }
    await tgRequest(env.BOT_TOKEN, 'sendMessage', payload);
}

// 主入口
export default {
    async fetch(request, env, ctx) {
        if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

        try {
            // Webhook 路径验证
            const url = new URL(request.url);
            if (request.method === 'POST' && (url.pathname === '/webhook' || url.pathname.startsWith('/webhook'))) {
                const update = await request.json();
                ctx.waitUntil(handleUpdate(env, update, ctx));
                return jsonResponse({ ok: true });
            }
            return jsonResponse({ status: 'running', version: '1.1.6 (Standalone)' });
        } catch (e) {
            ctx.waitUntil(reportError(env, e, "Main Fetch Loop"));
            return errorResponse(e.message);
        }
    }
};

// 核心逻辑
async function handleUpdate(env, update, ctx) {
    const token = env.BOT_TOKEN;
    const ownerId = String(env.OWNER_ID);

    // 1. 处理回调查询
    if (update.callback_query) {
        if (String(update.callback_query.from.id) === ownerId) {
            return handleOwnerCallback(env, update.callback_query);
        } else {
            return tgRequest(token, 'answerCallbackQuery', { callback_query_id: update.callback_query.id, text: "🚫", show_alert: true });
        }
    }

    // 2. 自动绑定群组
    if (update.my_chat_member) {
        const chat = update.my_chat_member.chat;
        const newMember = update.my_chat_member.new_chat_member;

        // 只有当机器人被提升为管理员，且所在群组不是私聊时触发
        if (newMember.status === 'administrator' && chat.type !== 'private') {
            if (!newMember.can_manage_topics) {
                return tgRequest(token, 'sendMessage', {
                    chat_id: chat.id,
                    text: "⚠️ <b>自动绑定失败：权限不足</b>\n\n请修改机器人管理员权限，开启 <b>管理话题 (Manage Topics)</b>，否则无法转发消息。",
                    parse_mode: 'HTML'
                });
            }

            try {
                const chatInfo = await tgRequest(token, 'getChat', { chat_id: chat.id });
                if (!chatInfo.ok || !chatInfo.result.is_forum) {
                    return tgRequest(token, 'sendMessage', {
                        chat_id: chat.id,
                        text: "⚠️ <b>自动绑定失败：未开启话题</b>\n\n本群组未开启话题功能。请在群组设置中开启 <b>话题（Topics）</b> 后重试。",
                        parse_mode: 'HTML'
                    });
                }
                await env.KV.put('config:group_id', String(chat.id));

                // 缓存 Bot Username
                const getMe = await tgRequest(token, 'getMe', {});
                if (getMe.ok) await env.KV.put('config:bot_username', getMe.result.username);

                await tgRequest(token, 'sendMessage', {
                    chat_id: chat.id,
                    text: "✅ <b>机器人已绑定此群组！</b>\n\n权限检查通过，私聊转发功能已就绪。",
                    parse_mode: 'HTML'
                });

            } catch (e) {
                return tgRequest(token, 'sendMessage', { chat_id: chat.id, text: `❌ 绑定检查出错: ${e.message}` });
            }
        }
        return;
    }

    // 手动绑定逻辑 (/bind)
    if (update.message && update.message.chat.type !== 'private' && update.message.text === '/bind') {
        const chat = update.message.chat;
        const userId = String(update.message.from.id);

        if (userId !== ownerId) {
            return tgRequest(token, 'sendMessage', { chat_id: chat.id, text: "🚫 只有机器人所有者可以使用此命令。" });
        }

        try {
            const chatInfo = await tgRequest(token, 'getChat', { chat_id: chat.id });
            if (!chatInfo.ok || !chatInfo.result.is_forum) {
                return tgRequest(token, 'sendMessage', { chat_id: chat.id, text: "❌ <b>绑定失败</b>\n\n本群组未开启话题功能 (Topics)。\n请在群组设置中开启“话题”后重试。", parse_mode: 'HTML' });
            }

            // 检查自身权限
            const getMe = await tgRequest(token, 'getMe', {});
            const botUserId = getMe.result.id;
            const memberInfo = await tgRequest(token, 'getChatMember', { chat_id: chat.id, user_id: botUserId });

            if (!memberInfo.ok || memberInfo.result.status !== 'administrator') {
                return tgRequest(token, 'sendMessage', { chat_id: chat.id, text: "❌ <b>绑定失败</b>\n\n请先将机器人提升为管理员。", parse_mode: 'HTML' });
            }

            if (!memberInfo.result.can_manage_topics) {
                return tgRequest(token, 'sendMessage', { chat_id: chat.id, text: "❌ <b>权限不足</b>\n\n机器人管理员权限缺失：<b>管理话题 (Manage Topics)</b>。\n请修改权限后重试。", parse_mode: 'HTML' });
            }

            await env.KV.put('config:group_id', String(chat.id));
            if (getMe.ok) await env.KV.put('config:bot_username', getMe.result.username);

            return tgRequest(token, 'sendMessage', {
                chat_id: chat.id,
                text: `✅ <b>绑定成功！</b>\n\n群组 ID：<code>${chat.id}</code>\n群组名称：${escapeHtml(chat.title)}\n\n现在所有私聊消息将转发至此。`,
                parse_mode: 'HTML'
            });

        } catch (e) {
            return tgRequest(token, 'sendMessage', { chat_id: chat.id, text: `❌ 系统错误: ${e.message}` });
        }
    }

    const groupId = await env.KV.get('config:group_id');

    // 处理已绑定群组的消息
    if (update.message && String(update.message.chat.id) === groupId) {
        return handleGroupMessage(env, update.message);
    }

    // 私聊消息
    if (update.message && update.message.chat.type === 'private') {
        const currentUserId = String(update.message.from.id);
        if (currentUserId === ownerId) {
            return handleOwnerMenu(env, update.message, ctx);
        }
        return handleUserPrivateMessage(env, groupId, update.message);
    }
}

// 转发消息（支持媒体组相册）
const mediaGroupBuffers = new Map();

async function forwardMessage(env, token, targetChatId, fromChatId, msg, threadId = null) {
    if (!msg.media_group_id) {
        const payload = { chat_id: targetChatId, from_chat_id: fromChatId, message_id: msg.message_id };
        if (threadId) payload.message_thread_id = threadId;
        return tgRequest(token, 'copyMessage', payload);
    }

    const groupKey = msg.media_group_id;
    let buffer = mediaGroupBuffers.get(groupKey);
    const isFirst = !buffer;

    if (isFirst) {
        buffer = { messageIds: [], targetChatId, fromChatId, threadId, token, lastUpdate: 0 };
        mediaGroupBuffers.set(groupKey, buffer);
    }

    // 将当前消息加入缓冲并更新时间戳
    if (!buffer.messageIds.includes(msg.message_id)) {
        buffer.messageIds.push(msg.message_id);
    }
    buffer.lastUpdate = Date.now();

    // 仅首条消息负责等待并批量转发（防抖：300ms 无新消息则刷新，最长等待 3s）
    if (isFirst) {
        const maxWait = Date.now() + 3000;
        while (Date.now() < maxWait) {
            await new Promise(r => setTimeout(r, 300));
            if (Date.now() - buffer.lastUpdate >= 300) break;
        }
        mediaGroupBuffers.delete(groupKey);

        buffer.messageIds.sort((a, b) => a - b);
        const payload = { chat_id: buffer.targetChatId, from_chat_id: buffer.fromChatId, message_ids: buffer.messageIds };
        if (buffer.threadId) payload.message_thread_id = buffer.threadId;
        return tgRequest(buffer.token, 'copyMessages', payload);
    }
}

// 设置菜单
async function generateSettingsMenu(env) {
    const unionBanValue = await env.KV.get('config:union_ban');
    const unionBan = unionBanValue === '1' || unionBanValue === 'true';
    const verifyMode = await env.KV.get('config:verify_mode') || 'off';
    const autoReplyMsg = await env.KV.get('config:auto_reply_msg');
    const botUsername = await env.KV.get('config:bot_username') || 'My Bot';
    const unionStatus = unionBan ? '🟢 开启' : '🔴 关闭';
    let verifyDisplay = unionBan ? '🛡 Tunstile' : (['🔴 关闭', '🔢 算数', '🎨 贴纸'][['off', 'math', 'sticker'].indexOf(verifyMode)] || '🔴 关闭');
    const replyStatus = autoReplyMsg ? '🟢 已启用' : '⚪️ 已关闭';

    const info = `🛠 <b>${escapeHtml(botUsername)} 管理面板</b>\n\n` +
        `📊 <b>当前配置:</b>\n` +
        `🔸 联合封禁：${unionStatus}\n` +
        `🔸 人机验证：${verifyDisplay}\n` +
        `🔸 自动回复：${replyStatus}\n\n` +
        `👇 点击下方按钮修改设置`;

    const keyboard = {
        inline_keyboard: [
            [{ text: `🌐 联合封禁：${unionStatus}`, callback_data: 'toggle_union' }],
            [{ text: '👋 欢迎消息', callback_data: 'guide_welcome' }, { text: '🤖 自动回复', callback_data: 'guide_reply' }],
            [{ text: '📢 广播', callback_data: 'guide_broadcast' }, { text: '🔄 刷新', callback_data: 'refresh_menu' }]
        ]
    };
    if (!unionBan) keyboard.inline_keyboard.splice(1, 0, [{ text: `🛡 本地验证：${verifyDisplay}`, callback_data: 'cycle_verify_local' }]);
    return { text: info, reply_markup: keyboard };
}

async function handleOwnerCallback(env, query) {
    const token = env.BOT_TOKEN;
    const data = query.data;
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;

    if (data === 'toggle_union') {
        const currentVal = await env.KV.get('config:union_ban');
        const isEnabled = currentVal === '1' || currentVal === 'true';
        const newVal = isEnabled ? '0' : '1';
        await env.KV.put('config:union_ban', newVal);
        memDelete('config:union_ban');
    }
    else if (data === 'cycle_verify_local') {
        const currentUnion = await env.KV.get('config:union_ban');
        const isUnionEnabled = currentUnion === '1' || currentUnion === 'true';

        if (isUnionEnabled) return tgRequest(token, 'answerCallbackQuery', { callback_query_id: query.id, text: "❌ 需先关闭联合封禁", show_alert: true });

        const modes = ['off', 'math', 'sticker'];
        const currentMode = await env.KV.get('config:verify_mode') || 'off';
        const nextMode = modes[(modes.indexOf(currentMode) + 1) % modes.length];
        await env.KV.put('config:verify_mode', nextMode);
        memDelete('config:verify_mode');
    }
    // guide_* 只是提示信息，不涉及 KV 修改
    else if (data === 'guide_welcome') {
        const current = await env.KV.get('config:welcome_msg');
        const btns = await env.KV.get('config:welcome_buttons');
        const currentText = current ? escapeHtml(current) : "(无)";
        const btnInfo = btns ? "已设置按钮" : "(无)";
        const text = `📝 <b>欢迎消息设置</b>\n\n当前文本:\n<pre>${currentText}</pre>\n\n当前按钮: ${btnInfo}\n\n👉 <b>修改文本:</b>\n发送 <code>/welcome</code> {消息内容}\n\n👉 <b>修改按钮:</b>\n发送 <code>/welbtn</code> {按钮内容}\n格式：按钮1 - 链接1 | 按钮2 - 链接2 , 按钮3 - 链接3\n(逗号换行，竖线同行，最多设置3个)\n\n发送 /cancel 返回`;
        await tgRequest(token, 'editMessageText', { chat_id: chatId, message_id: messageId, text: text, parse_mode: 'HTML' });
        return tgRequest(token, 'answerCallbackQuery', { callback_query_id: query.id });
    }
    else if (data === 'guide_reply') {
        const current = await env.KV.get('config:auto_reply_msg');
        const currentText = current ? escapeHtml(current) : "(已关闭)";
        const text = `🤖 <b>自动回复设置</b>\n\n当前内容:\n<pre>${currentText}</pre>\n\n👉 <b>修改:</b>\n发送 <code>/reply</code> {消息内容}\n\n👉 <b>关闭:</b>\n发送 <code>/reply</code> (不带内容)\n\n发送 /cancel 返回`;
        await tgRequest(token, 'editMessageText', { chat_id: chatId, message_id: messageId, text: text, parse_mode: 'HTML' });
        return tgRequest(token, 'answerCallbackQuery', { callback_query_id: query.id });
    }
    else if (data === 'guide_broadcast') {
        const text = `📢 <b>消息广播</b>\n\n👉 <b>发送:</b>\n发送 <code>/broadcast</code> {广播内容}\n\n发送 /cancel 返回`;
        await tgRequest(token, 'editMessageText', { chat_id: chatId, message_id: messageId, text: text, parse_mode: 'HTML' });
        return tgRequest(token, 'answerCallbackQuery', { callback_query_id: query.id });
    }

    const menu = await generateSettingsMenu(env);
    try { await tgRequest(token, 'editMessageText', { chat_id: chatId, message_id: messageId, text: menu.text, parse_mode: 'HTML', reply_markup: menu.reply_markup }); } catch (e) { }
    return tgRequest(token, 'answerCallbackQuery', { callback_query_id: query.id });
}

async function handleOwnerMenu(env, msg, ctx) {
    const token = env.BOT_TOKEN;
    const chatId = msg.chat.id;
    let text = msg.text || '';

    if (text === '/start') {
        return tgRequest(token, 'sendMessage', { chat_id: chatId, text: `👋 您好，机器人管理员！\n\n您看到此消息说明机器人已成功启动。\n\n当前版本：1.1.6 (Standalone) \n发送 /menu 显示管理菜单`, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '查看帮助文档', url: 'https://t.me/RelayGo/14' }]] } });
    }

    if (['/menu', '/cancel'].includes(text)) {
        const menu = await generateSettingsMenu(env);
        return tgRequest(token, 'sendMessage', { chat_id: chatId, text: menu.text, parse_mode: 'HTML', reply_markup: menu.reply_markup });
    }

    // 手动封禁/解封
    if (text.startsWith('/ban ')) {
        const targetId = text.split(' ')[1];
        if (!targetId) return tgRequest(token, 'sendMessage', { chat_id: chatId, text: "❌ 命令错误。用法: <code>/ban</code> <uid>", parse_mode: 'HTML' });

        const userTopic = await env.KV.get(`user:${targetId}`, { type: 'json' });
        if (userTopic) {
            userTopic.is_banned = true;
            await env.KV.put(`user:${targetId}`, JSON.stringify(userTopic));
        } else {
            await env.KV.put(`user:${targetId}`, JSON.stringify({ is_banned: true }));
        }
        memDelete(`user:${targetId}`);

        return tgRequest(token, 'sendMessage', {
            chat_id: chatId,
            text: `🚫 用户 <a href="tg://user?id=${targetId}">${targetId}</a> 已在本地封禁。`,
            parse_mode: 'HTML'
        });
    }
    if (text.startsWith('/unban ')) {
        const targetId = text.split(' ')[1];
        if (!targetId) return tgRequest(token, 'sendMessage', { chat_id: chatId, text: "❌ 命令错误。用法: <code>/unban</code> <uid>", parse_mode: 'HTML' });

        const userTopic = await env.KV.get(`user:${targetId}`, { type: 'json' });
        if (userTopic) {
            userTopic.is_banned = false;
            await env.KV.put(`user:${targetId}`, JSON.stringify(userTopic));
        }
        memDelete(`user:${targetId}`);

        return tgRequest(token, 'sendMessage', {
            chat_id: chatId,
            text: `✅ 用户 <a href="tg://user?id=${targetId}">${targetId}</a> 已解封。`,
            parse_mode: 'HTML'
        });
    }

    if (text.startsWith('/welcome ')) {
        const val = text.replace('/welcome ', '').trim();
        await env.KV.put('config:welcome_msg', val);
        return tgRequest(token, 'sendMessage', { chat_id: chatId, text: "✅ 欢迎消息已更新。" });
    }
    if (text.startsWith('/welbtn ')) {
        const raw = text.replace('/welbtn ', '').trim();
        const btns = parseButtons(raw);
        if (!btns) return tgRequest(token, 'sendMessage', { chat_id: chatId, text: "❌ 欢迎按钮格式错误。" });
        await env.KV.put('config:welcome_buttons', JSON.stringify(btns));
        return tgRequest(token, 'sendMessage', { chat_id: chatId, text: "✅ 欢迎按钮已更新。" });
    }
    if (text === '/reply') {
        await env.KV.delete('config:auto_reply_msg');
        memDelete('config:auto_reply_msg');
        return tgRequest(token, 'sendMessage', { chat_id: chatId, text: "✅ 自动回复已关闭。" });
    }
    if (text.startsWith('/reply ')) {
        let val = text.replace('/reply ', '').trim();
        await env.KV.put('config:auto_reply_msg', val);
        memDelete('config:auto_reply_msg');
        return tgRequest(token, 'sendMessage', { chat_id: chatId, text: "✅ 自动回复已更新。" });
    }
    // 分批广播辅助函数
    async function sendBroadcastBatch(env, token, chatId, broadcastMsg, offset, batchSize) {
        let cursor = undefined;
        const allKeys = [];
        while (true) {
            const res = await env.KV.list({ prefix: 'user:', cursor });
            allKeys.push(...res.keys);
            if (res.list_complete) break;
            cursor = res.cursor;
        }

        const total = allKeys.length;
        const batch = allKeys.slice(offset, offset + batchSize);

        let sent = 0, failed = 0, skipped = 0;
        const startTime = Date.now();
        const maxDuration = 25000;
        let timedOut = false;

        for (const key of batch) {
            if (Date.now() - startTime > maxDuration) {
                timedOut = true;
                break;
            }
            const uid = key.name.split(':')[1];

            // 检查用户是否被封禁
            const userData = await env.KV.get(`user:${uid}`, { type: 'json' });
            if (userData && userData.is_banned) {
                skipped++;
                continue;
            }

            try {
                const result = await tgRequest(token, 'sendMessage', { chat_id: uid, text: broadcastMsg });
                if (result.ok) sent++; else failed++;
            } catch (e) { failed++; }
            if ((sent + failed) % 25 === 0) await new Promise(r => setTimeout(r, 1000));
        }

        return { sent: offset + sent, failed, skipped, total, hasMore: offset + sent + skipped < total && !timedOut, nextOffset: offset + sent + skipped, timedOut };
    }

    if (text.startsWith('/broadcast ')) {
        const broadcastMsg = text.replace('/broadcast ', '').trim();
        if (!broadcastMsg) return tgRequest(token, 'sendMessage', { chat_id: chatId, text: "❌ 消息内容不能为空。" });

        // 保存消息到 KV
        await env.KV.put(`broadcast_msg:${chatId}`, broadcastMsg, { expirationTtl: 86400 });

        // 发送第一批
        const result = await sendBroadcastBatch(env, token, chatId, broadcastMsg, 0, 500);
        const statusIcon = result.timedOut ? '⚠️' : '✅';
        const statusText = result.timedOut ? '部分完成（超时）' : '完成';
        return tgRequest(token, 'sendMessage', {
            chat_id: chatId,
            text: `${statusIcon} <b>广播${statusText}</b>\n\n✅ 已发送：${result.sent}/${result.total}\n❌ 失败：${result.failed}${result.skipped > 0 ? `\n⏭️ 跳过（封禁）：${result.skipped}` : ''}${result.hasMore ? `\n\n继续发送：/bcontinue ${result.nextOffset}` : ''}`,
            parse_mode: 'HTML'
        });
    }
    if (text.startsWith('/bcontinue')) {
        const offset = parseInt(text.split(' ')[1]) || 0;
        const broadcastMsg = await env.KV.get(`broadcast_msg:${chatId}`);
        if (!broadcastMsg) return tgRequest(token, 'sendMessage', { chat_id: chatId, text: "❌ 未找到广播消息，请先使用 /broadcast 开始广播" });

        const result = await sendBroadcastBatch(env, token, chatId, broadcastMsg, offset, 500);
        const statusIcon = result.timedOut ? '⚠️' : '✅';
        const statusText = result.timedOut ? '部分完成（超时）' : '完成';
        return tgRequest(token, 'sendMessage', {
            chat_id: chatId,
            text: `${statusIcon} <b>广播${statusText}</b>\n\n✅ 已发送：${result.sent}/${result.total}\n❌ 失败：${result.failed}${result.skipped > 0 ? `\n⏭️ 跳过（封禁）：${result.skipped}` : ''}${result.hasMore ? `\n\n继续发送：/bcontinue ${result.nextOffset}` : ''}`,
            parse_mode: 'HTML'
        });
    }
    if (text === '/bcancel') {
        await env.KV.delete(`broadcast_msg:${chatId}`);
        return tgRequest(token, 'sendMessage', { chat_id: chatId, text: "✅ 已取消广播" });
    }
    return tgRequest(token, 'sendMessage', { chat_id: chatId, text: "🤖 发送 /menu 打开面板" });
}

// 处理群组消息 (Topic 内回复)
async function handleGroupMessage(env, msg) {
    if (!msg.is_topic_message || !msg.message_thread_id) return;

    // 通过 Thread ID 反查 User ID
    const userId = String(await env.KV.get(`thread:${msg.message_thread_id}`));
    if (!userId) return;

    if (msg.text && msg.text.startsWith('/')) {
        if (msg.text === '/ban') {
            const userData = await env.KV.get(`user:${userId}`, { type: 'json' }) || { thread_id: msg.message_thread_id };
            userData.is_banned = true;
            await env.KV.put(`user:${userId}`, JSON.stringify(userData));
            memDelete(`user:${userId}`);

            return tgRequest(env.BOT_TOKEN, 'sendMessage', { chat_id: msg.chat.id, message_thread_id: msg.message_thread_id, text: "🚫 用户已封禁。" });
        }
        if (msg.text === '/unban') {
            const userData = await env.KV.get(`user:${userId}`, { type: 'json' }) || { thread_id: msg.message_thread_id };
            userData.is_banned = false;
            await env.KV.put(`user:${userId}`, JSON.stringify(userData));
            memDelete(`user:${userId}`);

            return tgRequest(env.BOT_TOKEN, 'sendMessage', { chat_id: msg.chat.id, message_thread_id: msg.message_thread_id, text: "✅ 用户已解除封禁。" });
        }
    }
    await forwardMessage(env, env.BOT_TOKEN, userId, msg.chat.id, msg);
}

// 用户私聊核心逻辑
async function handleUserPrivateMessage(env, groupId, msg) {
    const userId = String(msg.from.id);
    const token = env.BOT_TOKEN;

    // 1. 读取用户数据（内存缓存 → KV）
    const userKey = `user:${userId}`;
    let userData = memGet(userKey);
    if (userData === undefined) {
        userData = await env.KV.get(userKey, { type: 'json' });
        if (userData) memSet(userKey, userData);
    }

    // 本地封禁检查
    if (userData && userData.is_banned) {
        return tgRequest(token, 'sendMessage', {
            chat_id: userId,
            text: "🚫 您已被本机器人封禁，如有疑问请联系管理员。",
            parse_mode: 'HTML',
        });
    }

    // 2. 读取联合封禁配置（内存缓存 → KV）
    let isUnionBanEnabled = memGet('config:union_ban');
    if (isUnionBanEnabled === undefined) {
        const raw = await env.KV.get('config:union_ban');
        isUnionBanEnabled = raw === '1' || raw === 'true';
        memSet('config:union_ban', isUnionBanEnabled);
    }

    // 3. 联合封禁检查（内存缓存 → KV 缓存 → 远程 API）
    if (isUnionBanEnabled) {
        const gbanKey = `gban:${userId}`;
        let gbanStatus = memGet(gbanKey);
        if (gbanStatus === undefined) {
            gbanStatus = await env.KV.get(gbanKey);
            if (gbanStatus === null) {
                const remoteCheck = await callCentralApi('/check_ban', { user_id: String(userId) });
                gbanStatus = (remoteCheck && remoteCheck.banned) ? "true" : "false";
                await env.KV.put(gbanKey, gbanStatus, { expirationTtl: CACHE_TTL_BAN_CHECK });
            }
            memSet(gbanKey, gbanStatus);
        }
        if (gbanStatus === "true") {
            return tgRequest(token, 'sendMessage', { chat_id: userId, text: "🚫 <b>您已被联合封禁。</b>\n申请解封请 <a href=\"https://t.me/RelayGo/24\">查看此处</a> 。", parse_mode: 'HTML' });
        }
    }

    // 刷新 verify cache
    if (msg.text && msg.text.startsWith('/start refresh_') && isUnionBanEnabled) {
        return handleUnionRefresh(env, groupId, msg, userId, token);
    }

    // 已验证用户
    if (userData && userData.thread_id) {
        if (msg.text === '/start') return sendWelcomeMessage(env, userId);

        // 自动回复（媒体组只触发一次，内存缓存 → KV）
        if (!msg.media_group_id) {
            let autoReplyMsg = memGet('config:auto_reply_msg');
            if (autoReplyMsg === undefined) {
                autoReplyMsg = await env.KV.get('config:auto_reply_msg');
                memSet('config:auto_reply_msg', autoReplyMsg);
            }
            if (autoReplyMsg) {
                const replyKey = `last_reply:${userId}`;
                if (!(await env.KV.get(replyKey))) {
                    await tgRequest(token, 'sendMessage', { chat_id: userId, text: autoReplyMsg });
                    await env.KV.put(replyKey, '1', { expirationTtl: 600 });
                }
            }
        }
        return forwardMessage(env, token, groupId, userId, msg, userData.thread_id);
    }

    // 新用户验证
    if (isUnionBanEnabled) {
        const botUsername = memGet('config:bot_username') || await env.KV.get('config:bot_username') || "Bot";
        memSet('config:bot_username', botUsername);
        const payloadObj = { uid: userId, bot: botUsername, ts: Date.now() };
        const payload = btoa(JSON.stringify(payloadObj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const webAppUrl = `https://t.me/${CENTRAL_BOT_USERNAME}/${CENTRAL_WEBAPP_NAME}?startapp=${payload}`;

        return tgRequest(token, 'sendMessage', {
            chat_id: userId,
            text: "🔒 <b>安全验证</b>\n\n本机器人已接入联合人机安全验证，请点击下方按钮验证身份。\n\n请在 10 分钟内完成完成验证并返回，超时将导致被封禁。",
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: "👉 点击验证 (Click to Verify)", url: webAppUrl }]] }
        });
    } else {
        let verifyMode = memGet('config:verify_mode');
        if (verifyMode === undefined) {
            verifyMode = await env.KV.get('config:verify_mode') || 'off';
            memSet('config:verify_mode', verifyMode);
        }
        if (verifyMode === 'off') return initializeUser(env, groupId, msg, userId, token);
        return handleLocalVerification(env, groupId, msg, userId, token, verifyMode);
    }
}

async function handleUnionRefresh(env, groupId, msg, userId, token) {
    // 强制清除 KV 缓存 + 内存缓存
    await env.KV.delete(`gban:${userId}`);
    memDelete(`gban:${userId}`);
    console.log(`[UnionRefresh] Cleared ban cache for user ${userId}`);

    const payload = { user_id: String(userId) };
    const checkRes = await callCentralApi('/check_verify_temp', payload);

    if (!checkRes) return tgRequest(token, 'sendMessage', { chat_id: userId, text: "❌ 网络错误" });

    if (checkRes.verified) {
        await tgRequest(token, 'sendMessage', { chat_id: userId, text: "✅ 验证通过，您可以开始聊天了。" });
        return initializeUser(env, groupId, msg, userId, token);
    } else {
        let debugText = "❌ 验证状态已过期。请发送 /start 重新验证。";
        if (checkRes.debug_info) {
            debugText += `\n\nDebug: Q=${checkRes.debug_info.key} Found=${checkRes.debug_info.timestamp}`;
        }
        return tgRequest(token, 'sendMessage', { chat_id: userId, text: debugText });
    }
}

async function handleLocalVerification(env, groupId, msg, userId, token, mode) {
    const tempKey = `verify_pending:${userId}`;
    const pendingState = await env.KV.get(tempKey, { type: 'json' });

    if (!pendingState && msg.text === '/start') {
        if (mode === 'sticker') {
            await env.KV.put(tempKey, JSON.stringify({ type: 'sticker' }), { expirationTtl: 180 });
            return tgRequest(token, 'sendMessage', { chat_id: userId, text: "🔒 <b>安全验证</b>\n\n本机器人已开启人机验证，请发送任意 <em>贴纸（Stickers）</em> 以通过验证。\n\n请在 2 分钟内完成完成验证，超时将导致被封禁。", parse_mode: 'HTML' });
        } else if (mode === 'math') {
            const a = Math.floor(Math.random() * 10), b = Math.floor(Math.random() * 10);
            await env.KV.put(tempKey, JSON.stringify({ type: 'math', ans: a + b }), { expirationTtl: 180 });
            return tgRequest(token, 'sendMessage', { chat_id: userId, text: `🔒 <b>安全验证</b>\n\n本机器人已开启人机验证，请计算结果（直接发送数字）: ${a} + ${b} = ?\n\n请在 2 分钟内完成完成验证，超时将导致被封禁。`, parse_mode: 'HTML' });
        }
    }

    if (pendingState) {
        let passed = false;
        if (pendingState.type === 'sticker' && msg.sticker) passed = true;
        else if (pendingState.type === 'math' && msg.text && parseInt(msg.text) === pendingState.ans) passed = true;
        await env.KV.delete(tempKey);

        if (passed) {
            await tgRequest(token, 'sendMessage', { chat_id: userId, text: "✅ 验证通过，您可以开始聊天了。" });
            return initializeUser(env, groupId, msg, userId, token);
        } else {
            // 本地验证失败 -> 封禁
            await env.KV.put(`user:${userId}`, JSON.stringify({ is_banned: true }));
            return tgRequest(token, 'sendMessage', { chat_id: userId, text: "❌ 验证失败，您已被封禁。" });
        }
    }
}

async function initializeUser(env, groupId, msg, userId, token) {
    if (!groupId) return tgRequest(token, 'sendMessage', { chat_id: userId, text: "⚠️ 机器人未绑定群组" });

    try {
        // 创建 Topic
        const name = `${msg.from.first_name}`.trim().slice(0, 128) || `User ${userId}`;
        const newTopic = await tgRequest(token, 'createForumTopic', { chat_id: groupId, name: name });

        if (!newTopic.ok) {
            throw new Error(newTopic.description);
        }

        const threadId = newTopic.result.message_thread_id;

        // 保存映射关系到 KV
        // 1. User -> Thread + Info
        const userData = {
            thread_id: threadId,
            is_banned: false,
            user_info: msg.from
        };
        await env.KV.put(`user:${userId}`, JSON.stringify(userData));

        // 2. Thread -> User (用于快速反查)
        await env.KV.put(`thread:${threadId}`, String(userId));

        // 新用户通知
        const firstName = escapeHtml(msg.from.first_name || '');
        const lastName = escapeHtml(msg.from.last_name || '');
        const fullName = (firstName + ' ' + lastName).trim() || 'No Name';
        const uidLink = `tg://user?id=${userId}`;
        const username = msg.from.username ? `@${escapeHtml(msg.from.username)}` : 'None';

        const infoMsg = `👤 <b>新用户接入</b>\n\n` +
            `🔸 名称：${fullName}\n` +
            `🆔 UID：<a href="${uidLink}">${userId}</a>\n` +
            `💫 用户名：${username}`;

        await tgRequest(token, 'sendMessage', { chat_id: groupId, message_thread_id: threadId, text: infoMsg, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: "👉 点击查看", url: uidLink }]] } });
        await sendWelcomeMessage(env, userId);

        if (!msg.text || !msg.text.startsWith('/start')) {
            await forwardMessage(env, token, groupId, userId, msg, threadId);
        }
    } catch (e) {
        return tgRequest(token, 'sendMessage', { chat_id: userId, text: "Error: " + e.message });
    }
}
