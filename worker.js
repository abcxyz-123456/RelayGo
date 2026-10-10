/**
 * RelayGo - 新一代 Telegram 私聊机器人
 * 项目地址: https://github.com/abcxyz-123456/RelayGo
 * 版本: 1.1.8 (Standalone)
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

function utf16Length(str) {
    let len = 0;
    for (const ch of str) {
        len += (ch.codePointAt(0) || 0) > 0xFFFF ? 2 : 1;
    }
    return len;
}

function getMessageTextContent(msg) {
    if (msg.text) return msg.text;
    if (msg.caption) return msg.caption;
    if (msg.photo) return '[图片]';
    if (msg.video) return '[视频]';
    if (msg.voice) return '[语音]';
    if (msg.audio) return '[音频]';
    if (msg.document) return msg.document.file_name || '[文件]';
    if (msg.sticker) return (msg.sticker.emoji || '') + ' [贴纸]';
    if (msg.animation) return '[GIF]';
    if (msg.video_note) return '[视频消息]';
    if (msg.contact) return `[联系人] ${msg.contact.first_name || ''}`;
    if (msg.location) return '[位置]';
    if (msg.poll) return `[投票] ${msg.poll.question || ''}`;
    return '[消息]';
}

function isServiceMessage(msg) {
    if (!msg) return false;
    return !!(msg.forum_topic_created || msg.forum_topic_edited || msg.forum_topic_reopened
        || msg.forum_topic_closed || msg.general_forum_topic_hidden || msg.general_forum_topic_unhidden
        || msg.pinned_message || msg.new_chat_members || msg.left_chat_member
        || msg.new_chat_title || msg.new_chat_photo || msg.delete_chat_photo
        || msg.group_chat_created || msg.supergroup_chat_created || msg.channel_chat_created
        || msg.message_auto_delete_timer_changed || msg.video_chat_scheduled
        || msg.video_chat_started || msg.video_chat_ended || msg.video_chat_participants_invited);
}

// 话题内未显式回复的消息会自动关联到话题根消息（服务消息），不应视为回复
function shouldFormatAsReply(msg) {
    if (!msg.reply_to_message) return false;
    const replied = msg.reply_to_message;
    if (isServiceMessage(replied)) return false;
    if (msg.is_topic_message && msg.message_thread_id && replied.message_id === msg.message_thread_id) {
        return false;
    }
    return true;
}

function buildReplyPrefix(replyToMsg) {
    const prefix = '回复： ';
    const quotedText = getMessageTextContent(replyToMsg);
    const separator = '\n\n';
    return {
        prefix,
        quotedText,
        separator,
        headerLength: utf16Length(prefix + quotedText + separator),
        blockquoteOffset: utf16Length(prefix),
        blockquoteLength: utf16Length(quotedText),
    };
}

function shiftEntities(entities, offset) {
    if (!entities?.length) return undefined;
    return entities.map(e => ({ ...e, offset: e.offset + offset }));
}

function buildReplyEntities(prefixInfo, contentEntities) {
    const entities = [{ type: 'blockquote', offset: prefixInfo.blockquoteOffset, length: prefixInfo.blockquoteLength }];
    const shifted = shiftEntities(contentEntities, prefixInfo.headerLength);
    if (shifted) entities.push(...shifted);
    return entities;
}

function isTextOnlyMessage(msg) {
    return msg.text !== undefined && !msg.photo && !msg.video && !msg.document && !msg.audio
        && !msg.voice && !msg.sticker && !msg.animation && !msg.video_note && !msg.contact
        && !msg.location && !msg.poll;
}

async function sendReplyHeader(token, basePayload, prefixInfo) {
    const fullPrefix = prefixInfo.prefix + prefixInfo.quotedText + prefixInfo.separator;
    return tgRequest(token, 'sendMessage', {
        ...basePayload,
        text: fullPrefix.trimEnd(),
        entities: [{ type: 'blockquote', offset: prefixInfo.blockquoteOffset, length: prefixInfo.blockquoteLength }],
    });
}

async function forwardMessageWithReply(token, targetChatId, fromChatId, msg, threadId) {
    const prefixInfo = buildReplyPrefix(msg.reply_to_message);
    const fullPrefix = prefixInfo.prefix + prefixInfo.quotedText + prefixInfo.separator;
    const basePayload = { chat_id: targetChatId };
    if (threadId) basePayload.message_thread_id = threadId;

    if (isTextOnlyMessage(msg)) {
        return tgRequest(token, 'sendMessage', {
            ...basePayload,
            text: fullPrefix + msg.text,
            entities: buildReplyEntities(prefixInfo, msg.entities),
        });
    }

    const caption = fullPrefix + (msg.caption || '');
    const captionEntities = buildReplyEntities(prefixInfo, msg.caption_entities);
    const mediaPayload = { ...basePayload, caption, caption_entities: captionEntities };

    if (msg.photo) return tgRequest(token, 'sendPhoto', { ...mediaPayload, photo: msg.photo[msg.photo.length - 1].file_id });
    if (msg.video) return tgRequest(token, 'sendVideo', { ...mediaPayload, video: msg.video.file_id });
    if (msg.animation) return tgRequest(token, 'sendAnimation', { ...mediaPayload, animation: msg.animation.file_id });
    if (msg.document) return tgRequest(token, 'sendDocument', { ...mediaPayload, document: msg.document.file_id });
    if (msg.audio) return tgRequest(token, 'sendAudio', { ...mediaPayload, audio: msg.audio.file_id });
    if (msg.voice) return tgRequest(token, 'sendVoice', { ...mediaPayload, voice: msg.voice.file_id });

    const headerResult = await sendReplyHeader(token, basePayload, prefixInfo);
    if (!headerResult.ok) return headerResult;

    const copyPayload = { chat_id: targetChatId, from_chat_id: fromChatId, message_id: msg.message_id };
    if (threadId) copyPayload.message_thread_id = threadId;
    return tgRequest(token, 'copyMessage', copyPayload);
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

// 给原始消息添加 Telegram 原生表情回应；失败不应影响消息转发。
async function reactToMessage(token, chatId, messageId) {
    if (!token || chatId === undefined || chatId === null || !messageId) return;
    return tgRequest(token, 'setMessageReaction', {
        chat_id: chatId,
        message_id: messageId,
        reaction: [{ type: 'emoji', emoji: '🐳' }],
        is_big: false,
    });
}

function isTopicNotFoundError(result) {
    if (!result || result.ok) return false;
    const desc = (result.description || '').toLowerCase();
    return desc.includes('message thread not found')
        || desc.includes('topic deleted')
        || desc.includes('topic not found')
        || desc.includes('forum topic deleted');
}

async function clearStaleTopicMapping(env, userId, threadId) {
    const userKey = `user:${userId}`;
    const userData = await env.KV.get(userKey, { type: 'json' });
    if (userData) {
        delete userData.thread_id;
        const hasOtherData = userData.is_banned || userData.user_info;
        if (hasOtherData) {
            await env.KV.put(userKey, JSON.stringify(userData));
        } else {
            await env.KV.delete(userKey);
        }
    }
    if (threadId) await env.KV.delete(`thread:${threadId}`);
    memDelete(userKey);
    console.log(`[TopicRecovery] Cleared stale mapping for user ${userId}, thread ${threadId}`);
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
            return jsonResponse({ status: 'running', version: '1.1.8 (Standalone)' });
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
    if (shouldFormatAsReply(msg) && !msg.media_group_id) {
        return forwardMessageWithReply(token, targetChatId, fromChatId, msg, threadId);
    }

    if (!msg.media_group_id) {
        const payload = { chat_id: targetChatId, from_chat_id: fromChatId, message_id: msg.message_id };
        if (threadId) payload.message_thread_id = threadId;
        return tgRequest(token, 'copyMessage', payload);
    }

    const groupKey = msg.media_group_id;
    let buffer = mediaGroupBuffers.get(groupKey);
    const isFirst = !buffer;

    if (isFirst) {
        buffer = { messageIds: [], targetChatId, fromChatId, threadId, token, lastUpdate: 0, replyTo: shouldFormatAsReply(msg) ? msg.reply_to_message : null };
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

        if (buffer.replyTo) {
            const prefixInfo = buildReplyPrefix(buffer.replyTo);
            const basePayload = { chat_id: buffer.targetChatId };
            if (buffer.threadId) basePayload.message_thread_id = buffer.threadId;
            await sendReplyHeader(buffer.token, basePayload, prefixInfo);
        }

        buffer.messageIds.sort((a, b) => a - b);
        const payload = { chat_id: buffer.targetChatId, from_chat_id: buffer.fromChatId, message_ids: buffer.messageIds };
        if (buffer.threadId) payload.message_thread_id = buffer.threadId;
        return tgRequest(buffer.token, 'copyMessages', payload);
    }
}

async function forwardToGroupWithRecovery(env, token, groupId, userId, msg, threadId, userData) {
    const result = await forwardMessage(env, token, groupId, userId, msg, threadId);
    if (result === undefined) return;
    if (result.ok || !isTopicNotFoundError(result)) {
        if (!result.ok) console.error(`[ForwardError] user ${userId}: ${result.description}`);
        return result;
    }

    console.log(`[TopicRecovery] Topic ${threadId} missing for user ${userId}, recreating session`);
    await clearStaleTopicMapping(env, userId, threadId);
    return initializeUser(env, groupId, msg, userId, token, { recreate: true, preserveBan: userData?.is_banned });
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

function isUserBlockedError(result) {
    if (!result || result.ok) return false;
    const desc = (result.description || '').toLowerCase();
    return desc.includes('bot was blocked by the user')
        || desc.includes('user is deactivated')
        || desc.includes('chat not found')
        || desc.includes('bot was kicked')
        || desc.includes('blocked');
}

const broadcastMediaGroupBuffers = new Map();

async function setBroadcastState(env, id, state) {
    const key = `broadcast_state:${id}`;
    if (state) {
        memSet(key, state);
        await env.KV.put(key, state, { expirationTtl: 3600 });
    } else {
        memDelete(key);
        await env.KV.delete(key);
    }
}

async function getBroadcastState(env, id) {
    const key = `broadcast_state:${id}`;
    let val = memGet(key);
    if (val === undefined) {
        val = await env.KV.get(key);
        if (val) memSet(key, val);
    }
    return val;
}

async function setBroadcastDraft(env, id, draft) {
    const key = `broadcast_draft:${id}`;
    if (draft) {
        const str = JSON.stringify(draft);
        memSet(key, str);
        await env.KV.put(key, str, { expirationTtl: 86400 });
    } else {
        memDelete(key);
        await env.KV.delete(key);
    }
}

async function getBroadcastDraft(env, id) {
    const key = `broadcast_draft:${id}`;
    let str = memGet(key);
    if (str === undefined) {
        str = await env.KV.get(key);
        if (str) memSet(key, str);
    }
    if (!str) return null;
    try { return JSON.parse(str); } catch (e) { return { text: str }; }
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
        await setBroadcastState(env, chatId, 'waiting_content');
        const text = `📢 <b>创建消息广播</b>\n\n请直接发送您要广播的消息内容（支持文本、富文本、图片、视频、文件及图文相册）。\n\n发送 /cancel 可取消操作。`;
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
        return tgRequest(token, 'sendMessage', { chat_id: chatId, text: `👋 您好，机器人管理员！\n\n您看到此消息说明机器人已成功启动。\n\n当前版本：1.1.8 (Standalone) \n发送 /menu 显示管理菜单`, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '查看帮助文档', url: 'https://t.me/RelayGo/14' }]] } });
    }

    if (text === '/menu') {
        const menu = await generateSettingsMenu(env);
        return tgRequest(token, 'sendMessage', { chat_id: chatId, text: menu.text, parse_mode: 'HTML', reply_markup: menu.reply_markup });
    }

    if (['/cancel', '/bcancel'].includes(text)) {
        await setBroadcastState(env, chatId, null);
        await setBroadcastDraft(env, chatId, null);
        return tgRequest(token, 'sendMessage', { chat_id: chatId, text: "✅ 已取消广播操作。" });
    }

    // 分批广播辅助函数
    async function sendBroadcastBatch(env, token, chatId, draft, offset, batchSize) {
        let cursor = undefined;
        const allKeys = [];
        while (true) {
            const listOpts = { prefix: 'user:' };
            if (cursor) listOpts.cursor = cursor;
            const res = await env.KV.list(listOpts);
            if (res && res.keys) allKeys.push(...res.keys);
            if (!res || res.list_complete) break;
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
                let result;
                if (draft.message_ids && draft.message_ids.length > 0) {
                    result = await tgRequest(token, 'copyMessages', { chat_id: uid, from_chat_id: draft.from_chat_id, message_ids: draft.message_ids });
                } else if (draft.message_id) {
                    result = await tgRequest(token, 'copyMessage', { chat_id: uid, from_chat_id: draft.from_chat_id, message_id: draft.message_id });
                } else if (typeof draft.text === 'string') {
                    result = await tgRequest(token, 'sendMessage', { chat_id: uid, text: draft.text });
                }
                if (result && result.ok) sent++; else failed++;
            } catch (e) { failed++; }
            if ((sent + failed) > 0 && (sent + failed) % 25 === 0) await new Promise(r => setTimeout(r, 1000));
        }

        return { sent: offset + sent, failed, skipped, total, hasMore: offset + sent + skipped < total && !timedOut, nextOffset: offset + sent + skipped, timedOut };
    }

    // 广播状态检查
    const broadcastState = await getBroadcastState(env, chatId);

    if (broadcastState === 'waiting_confirm') {
        if (text === '/confirm') {
            await setBroadcastState(env, chatId, null);
            const draft = await getBroadcastDraft(env, chatId);
            if (!draft) return tgRequest(token, 'sendMessage', { chat_id: chatId, text: "❌ 未找到广播草稿，请重新使用 /broadcast 开始。" });

            await tgRequest(token, 'sendMessage', { chat_id: chatId, text: "🔄 <b>已开始发送广播...</b>", parse_mode: 'HTML' });
            const result = await sendBroadcastBatch(env, token, chatId, draft, 0, 500);
            const statusIcon = result.timedOut ? '⚠️' : '✅';
            const statusText = result.timedOut ? '部分完成（超时）' : '完成';
            return tgRequest(token, 'sendMessage', {
                chat_id: chatId,
                text: `${statusIcon} <b>广播${statusText}</b>\n\n✅ 已发送：${result.sent}/${result.total}\n❌ 失败：${result.failed}${result.skipped > 0 ? `\n⏭️ 跳过（封禁）：${result.skipped}` : ''}${result.hasMore ? `\n\n继续发送：/bcontinue ${result.nextOffset}` : ''}`,
                parse_mode: 'HTML'
            });
        } else {
            return tgRequest(token, 'sendMessage', {
                chat_id: chatId,
                text: "⚠️ <b>请确认广播内容</b>\n\n如需发送，请发送 <code>/confirm</code> 确认发布；\n如需取消，请发送 <code>/cancel</code> 。",
                parse_mode: 'HTML'
            });
        }
    }

    if (broadcastState === 'waiting_content') {
        if (msg.media_group_id) {
            const groupKey = `broadcast:${chatId}:${msg.media_group_id}`;
            let buffer = broadcastMediaGroupBuffers.get(groupKey);
            const isFirst = !buffer;

            if (isFirst) {
                buffer = { messageIds: [], lastUpdate: 0 };
                broadcastMediaGroupBuffers.set(groupKey, buffer);
            }

            if (!buffer.messageIds.includes(msg.message_id)) {
                buffer.messageIds.push(msg.message_id);
            }
            buffer.lastUpdate = Date.now();

            if (isFirst) {
                const maxWait = Date.now() + 3000;
                while (Date.now() < maxWait) {
                    await new Promise(r => setTimeout(r, 300));
                    if (Date.now() - buffer.lastUpdate >= 300) break;
                }
                broadcastMediaGroupBuffers.delete(groupKey);

                buffer.messageIds.sort((a, b) => a - b);
                const draft = { from_chat_id: chatId, message_ids: buffer.messageIds };
                await setBroadcastDraft(env, chatId, draft);
                await setBroadcastState(env, chatId, 'waiting_confirm');

                await tgRequest(token, 'copyMessages', { chat_id: chatId, from_chat_id: chatId, message_ids: buffer.messageIds });
                return tgRequest(token, 'sendMessage', {
                    chat_id: chatId,
                    text: "📢 <b>广播预览如上</b>\n\n如确认无误，请发送 <code>/confirm</code> 开始发布广播；\n如需取消，请发送 <code>/cancel</code> 。",
                    parse_mode: 'HTML'
                });
            }
            return;
        } else {
            const draft = { from_chat_id: chatId, message_id: msg.message_id };
            await setBroadcastDraft(env, chatId, draft);
            await setBroadcastState(env, chatId, 'waiting_confirm');

            await tgRequest(token, 'copyMessage', { chat_id: chatId, from_chat_id: chatId, message_id: msg.message_id });
            return tgRequest(token, 'sendMessage', {
                chat_id: chatId,
                text: "📢 <b>广播预览如上</b>\n\n如确认无误，请发送 <code>/confirm</code> 开始发布广播；\n如需取消，请发送 <code>/cancel</code> 。",
                parse_mode: 'HTML'
            });
        }
    }

    if (text.startsWith('/broadcast')) {
        const bodyContent = text.replace('/broadcast', '').trim();
        if (bodyContent.length > 0) {
            const draft = { from_chat_id: chatId, message_id: msg.message_id };
            await setBroadcastDraft(env, chatId, draft);
            await setBroadcastState(env, chatId, 'waiting_confirm');

            await tgRequest(token, 'copyMessage', { chat_id: chatId, from_chat_id: chatId, message_id: msg.message_id });
            return tgRequest(token, 'sendMessage', {
                chat_id: chatId,
                text: "📢 <b>广播预览如上</b>\n\n如确认无误，请发送 <code>/confirm</code> 开始发布广播；\n如需取消，请发送 <code>/cancel</code> 。",
                parse_mode: 'HTML'
            });
        } else {
            await setBroadcastState(env, chatId, 'waiting_content');
            return tgRequest(token, 'sendMessage', {
                chat_id: chatId,
                text: "📢 <b>创建消息广播</b>\n\n请直接发送您要广播的消息内容（支持文本、富文本、图片、视频、文件及图文相册）。\n\n发送 /cancel 可取消操作。",
                parse_mode: 'HTML'
            });
        }
    }

    if (text.startsWith('/bcontinue')) {
        const offset = parseInt(text.split(' ')[1]) || 0;
        const draft = await getBroadcastDraft(env, chatId);
        if (!draft) return tgRequest(token, 'sendMessage', { chat_id: chatId, text: "❌ 未找到广播内容，请先使用 /broadcast 开始广播" });

        const result = await sendBroadcastBatch(env, token, chatId, draft, offset, 500);
        const statusIcon = result.timedOut ? '⚠️' : '✅';
        const statusText = result.timedOut ? '部分完成（超时）' : '完成';
        return tgRequest(token, 'sendMessage', {
            chat_id: chatId,
            text: `${statusIcon} <b>广播${statusText}</b>\n\n✅ 已发送：${result.sent}/${result.total}\n❌ 失败：${result.failed}${result.skipped > 0 ? `\n⏭️ 跳过（封禁）：${result.skipped}` : ''}${result.hasMore ? `\n\n继续发送：/bcontinue ${result.nextOffset}` : ''}`,
            parse_mode: 'HTML'
        });
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
    if (text === '/bcancel') {
        await env.KV.delete(`broadcast_msg:${chatId}`);
        return tgRequest(token, 'sendMessage', { chat_id: chatId, text: "✅ 已取消广播" });
    }
    return tgRequest(token, 'sendMessage', { chat_id: chatId, text: "🤖 发送 /menu 打开面板" });
}

// 处理群组消息 (Topic 内回复)
async function handleGroupMessage(env, msg) {
    if (!msg.is_topic_message || !msg.message_thread_id) return;
    if (isServiceMessage(msg) || (msg.from && msg.from.is_bot)) return;

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
    const [, result] = await Promise.all([
        reactToMessage(env.BOT_TOKEN, msg.chat.id, msg.message_id),
        forwardMessage(env, env.BOT_TOKEN, userId, msg.chat.id, msg),
    ]);
    if (result && !result.ok) {
        if (isUserBlockedError(result)) {
            await tgRequest(env.BOT_TOKEN, 'sendMessage', {
                chat_id: msg.chat.id,
                message_thread_id: msg.message_thread_id,
                text: "⚠️ <b>消息发送失败</b>\n\n该用户已拉黑机器人或账号已注销，消息无法转达。",
                parse_mode: 'HTML'
            });
        } else {
            await tgRequest(env.BOT_TOKEN, 'sendMessage', {
                chat_id: msg.chat.id,
                message_thread_id: msg.message_thread_id,
                text: `⚠️ <b>消息发送失败</b>\n\n错误提示：${escapeHtml(result.description || '未知错误')}`,
                parse_mode: 'HTML'
            });
        }
    }
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
        const [, result] = await Promise.all([
            reactToMessage(token, userId, msg.message_id),
            forwardToGroupWithRecovery(env, token, groupId, userId, msg, userData.thread_id, userData),
        ]);
        return result;
    }

    // 曾接入但话题映射丢失（如话题被删后清理不完整）
    if (userData && userData.user_info && !userData.thread_id) {
        return initializeUser(env, groupId, msg, userId, token, { recreate: true, preserveBan: userData.is_banned });
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

async function initializeUser(env, groupId, msg, userId, token, options = {}) {
    const { recreate = false, preserveBan = false } = options;
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
            is_banned: preserveBan || false,
            user_info: msg.from
        };
        await env.KV.put(`user:${userId}`, JSON.stringify(userData));
        memSet(`user:${userId}`, userData);

        // 2. Thread -> User (用于快速反查)
        await env.KV.put(`thread:${threadId}`, String(userId));

        const firstName = escapeHtml(msg.from.first_name || '');
        const lastName = escapeHtml(msg.from.last_name || '');
        const fullName = (firstName + ' ' + lastName).trim() || 'No Name';
        const uidLink = `tg://user?id=${userId}`;
        const username = msg.from.username ? `@${escapeHtml(msg.from.username)}` : 'None';

        const userDetails =
            `🔸 名称：${fullName}\n` +
            `🆔 UID：<a href="${uidLink}">${userId}</a>\n` +
            `💫 用户名：${username}`;

        const infoMsg = recreate
            ? `⚠️ <b>会话已恢复</b>\n\n原话题已被删除，已自动创建新会话。\n\n${userDetails}`
            : `👤 <b>新用户接入</b>\n\n${userDetails}`;

        const sendRes = await tgRequest(token, 'sendMessage', { chat_id: groupId, message_thread_id: threadId, text: infoMsg, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: "👉 点击查看", url: uidLink }]] } });
        if (!sendRes || !sendRes.ok) {
            console.error(`[NewUserCard Fail] User ${userId}: ${sendRes?.description}, falling back to name mention.`);
            const nameMention = `<a href="tg://user?id=${userId}">${fullName}</a>`;
            const fallbackText = recreate
                ? `⚠️ ${nameMention} (ID: <code>${userId}</code>) 会话已恢复`
                : `👤 ${nameMention} (ID: <code>${userId}</code>) 已加入会话`;
            await tgRequest(token, 'sendMessage', { chat_id: groupId, message_thread_id: threadId, text: fallbackText, parse_mode: 'HTML' });
        }
        if (!recreate) await sendWelcomeMessage(env, userId);

        if (!msg.text || !msg.text.startsWith('/start')) {
            await Promise.all([
                reactToMessage(token, userId, msg.message_id),
                forwardMessage(env, token, groupId, userId, msg, threadId),
            ]);
        }
    } catch (e) {
        return tgRequest(token, 'sendMessage', { chat_id: userId, text: "Error: " + e.message });
    }
}
