// ============================================================
// 聊天全文搜索 chat-search
// 在首页(聊天列表)搜索所有角色所有聊天的内容，
// 定位：哪个角色 / 哪次聊天 / 第几楼 / 命中位置，点击直达并高亮。
// 纯前端实现：调用酒馆内置 /api/chats/search + /api/chats/get，
// 不改配置、不重启服务、不影响其他扩展。
// ============================================================

import { redisplayChat } from '../../../../script.js';
import { power_user } from '../../../power-user.js';

(function () {
    if (typeof window === 'undefined' || !window.SillyTavern) {
        return; // 非酒馆页面，不初始化
    }

    const EXT_NAME = '聊天全文搜索';
    const ROOT_ID = 'chat-search-modal';
    const BTN_ID = 'chat-search-btn';
    const STYLE_ID = 'chat-search-style';
    const CACHE_TTL = 5 * 60 * 1000; // 缓存5分钟
    const MAX_CACHE_ENTRIES = 600;   // 内存保护：最多缓存600个聊天内容
    const CONCURRENCY = 15;          // 并发请求数

    let ctx = null;
    let chatListCache = new Map();   // avatar -> [{file_name, message_count}]
    let messageCache = new Map();    // avatar::file_name -> [lines]
    let msgCacheOrder = [];
    let searching = false;
    // 筛选状态：选中的角色(avatar集合，空=全部) + 是否排除用户消息
    const FILTER_KEY = 'chat-search-filters';
    let selectedChars = new Set();
    let excludeUser = false;

    // ---------- 工具 ----------
    function loadJson(key, def) {
        try {
            const v = localStorage.getItem(key);
            return v ? JSON.parse(v) : def;
        } catch { return def; }
    }

    function saveFilters() {
        try {
            localStorage.setItem(FILTER_KEY, JSON.stringify({
                chars: Array.from(selectedChars),
                excludeUser: !!excludeUser,
            }));
        } catch { /* 忽略 */ }
    }

    function escHtml(s) {
        return String(s ?? '').replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function humanTime(fileName) {
        // 文件名形如 "角色名 - 2026-05-11@09h35m56s993ms"
        const m = String(fileName).match(/(\d{4}-\d{2}-\d{2})@(\d{2})h(\d{2})m(\d{2})s/);
        if (!m) return fileName;
        return m[1] + ' ' + m[2] + ':' + m[3] + ':' + m[4];
    }

    function setMessageCache(key, lines) {
        if (msgCacheOrder.includes(key)) {
            const i = msgCacheOrder.indexOf(key);
            msgCacheOrder.splice(i, 1);
        }
        msgCacheOrder.push(key);
        while (msgCacheOrder.length > MAX_CACHE_ENTRIES) {
            const old = msgCacheOrder.shift();
            messageCache.delete(old);
        }
        messageCache.set(key, lines);
    }

    // ---------- 调用酒馆 API ----------
    async function apiChatsSearch(query, avatar) {
        const r = await fetch('/api/chats/search', {
            method: 'POST',
            headers: ctx.getRequestHeaders(),
            body: JSON.stringify({ query: query, avatar_url: avatar }),
        });
        if (!r.ok) return [];
        const data = await r.json();
        return Array.isArray(data) ? data : [];
    }

    async function apiChatsGet(avatar, file_name) {
        const r = await fetch('/api/chats/get', {
            method: 'POST',
            headers: ctx.getRequestHeaders(),
            body: JSON.stringify({ avatar_url: avatar, file_name: file_name }),
        });
        if (!r.ok) return [];
        const data = await r.json();
        return Array.isArray(data) ? data : [];
    }

    // ---------- 客户端精确搜索 ----------
    function buildSnippet(text, frags) {
        const low = text.toLowerCase();
        let firstPos = -1;
        for (const f of frags) {
            const p = low.indexOf(f);
            if (p >= 0 && (firstPos < 0 || p < firstPos)) firstPos = p;
        }
        const win = 36;
        const start = Math.max(0, firstPos - win);
        const end = Math.min(text.length, firstPos + String(frags[0]).length + win);
        return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
    }

    function searchLines(lines, frags, opts) {
        if (!Array.isArray(lines) || frags.length === 0) return [];
        const excludeUser = !!(opts && opts.excludeUser);
        const hasMeta = lines[0] && typeof lines[0] === 'object' && lines[0].chat_metadata;
        const hits = [];
        for (let i = 0; i < lines.length; i++) {
            const m = lines[i];
            if (!m || typeof m !== 'object' || m.chat_metadata) continue;
            if (excludeUser && m.is_user) continue;
            const texts = [];
            if (typeof m.mes === 'string') texts.push(m.mes);
            if (Array.isArray(m.swipes)) texts.push(...m.swipes.filter(x => typeof x === 'string'));
            if (Array.isArray(m.swipe_info)) texts.push(...m.swipe_info.map(s => (s && typeof s.mes === 'string') ? s.mes : '').filter(Boolean));
            if (texts.length === 0) continue;
            let matched = false;
            let hitSwipe = 0;
            let hitText = '';
            for (let t = 0; t < texts.length && !matched; t++) {
                const low = texts[t].toLowerCase();
                if (frags.every(f => low.includes(f))) {
                    matched = true;
                    hitSwipe = t;
                    hitText = texts[t];
                }
            }
            if (!matched) continue;
            const msgIndex = hasMeta ? i - 1 : i;
            hits.push({
                msgIndex: msgIndex,
                speaker: m.name || (m.is_user ? '用户' : '角色'),
                isUser: !!m.is_user,
                swipeId: hitSwipe,
                swipeCount: texts.length,
                snippet: buildSnippet(hitText, frags),
            });
        }
        return hits;
    }

    // ---------- 主搜索流程 ----------
    async function doSearch(keyword) {
        if (searching) return;
        searching = true;
        // 每次搜索前刷新上下文（角色列表是页面加载后异步填充的）
        ctx = window.SillyTavern.getContext();
        const frags = keyword.trim().toLowerCase().split(/\s+/).filter(Boolean);
        if (frags.length === 0) {
            searching = false;
            renderResults([], 0);
            return;
        }
        // 角色列表可能还在加载，最多等 12 秒
        let chars = (ctx.characters || []).filter(c => c.avatar && c.avatar !== 'none' && Number(c.chat_size) > 0);
        for (let w = 0; w < 24 && chars.length === 0; w++) {
            await new Promise(res => setTimeout(res, 500));
            ctx = window.SillyTavern.getContext();
            chars = (ctx.characters || []).filter(c => c.avatar && c.avatar !== 'none' && Number(c.chat_size) > 0);
        }
        // 角色筛选：选中了角色就只搜这些角色，否则搜全部
        const selected = getSelectedChars();
        const targets = selected.size > 0 ? chars.filter(c => selected.has(c.avatar)) : chars;
        const results = [];
        let scanned = 0;
        setProgress('正在扫描 0/' + targets.length + ' 个角色…');
        const t0 = Date.now();
        for (let i = 0; i < targets.length; i += CONCURRENCY) {
            const batch = targets.slice(i, i + CONCURRENCY);
            await Promise.all(batch.map(async (c) => {
                try {
                    let list = chatListCache.get(c.avatar);
                    if (!list) {
                        list = await apiChatsSearch('', c.avatar);
                        chatListCache.set(c.avatar, list);
                    }
                    for (const chat of list) {
                        const file = chat.file_name;
                        if (!file) continue;
                        const key = c.avatar + '::' + file;
                        let lines = messageCache.get(key);
                        if (lines === undefined) {
                            lines = await apiChatsGet(c.avatar, file);
                            setMessageCache(key, lines);
                        }
                        const hits = searchLines(lines, frags, { excludeUser: excludeUser });
                        for (const h of hits) {
                            results.push({
                                avatar: c.avatar,
                                charName: c.name,
                                chatFile: file,
                                chatDate: humanTime(file),
                                msgIndex: h.msgIndex,
                                speaker: h.speaker,
                                isUser: h.isUser,
                                swipeId: h.swipeId,
                                swipeCount: h.swipeCount,
                                snippet: h.snippet,
                            });
                        }
                    }
                } catch (e) {
                    console.error('[chat-search] 扫描失败', c.name, e);
                }
            }));
            scanned += batch.length;
            setProgress('正在扫描 ' + Math.min(scanned, targets.length) + '/' + targets.length + ' 个角色…');
        }
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        searching = false;
        // 按聊天时间倒序（新的在前）
        results.sort((a, b) => String(b.chatDate).localeCompare(String(a.chatDate)));
        renderResults(results, elapsed);
    }

    // ---------- 渲染 ----------
    function renderResults(results, elapsed) {
        const listEl = document.getElementById('chat-search-results');
        const infoEl = document.getElementById('chat-search-info');
        if (!listEl || !infoEl) return;
        let filterNote = '';
        if (selectedChars.size > 0 || excludeUser) {
            const parts = [];
            if (selectedChars.size > 0) parts.push('已选 ' + selectedChars.size + ' 个角色');
            if (excludeUser) parts.push('排除用户消息');
            filterNote = '（筛选：' + parts.join(' · ') + '）';
        }
        infoEl.textContent = '共 ' + results.length + ' 条命中' + (elapsed ? '，耗时 ' + elapsed + 's' : '') + filterNote;
        if (results.length === 0) {
            listEl.innerHTML = '<div class="chat-search-empty">没有找到匹配内容，换个关键词试试</div>';
            return;
        }
        const html = results.map((r, idx) => {
            const who = r.isUser ? '用户' : '角色';
            const swipeTag = r.swipeCount > 1 ? '<span class="cs-swipe">命中第 ' + (r.swipeId + 1) + '/' + r.swipeCount + ' 条候选</span>' : '';
            return '<div class="cs-item" data-idx="' + idx + '">' +
                '<div class="cs-item-head">' +
                '<span class="cs-char">' + escHtml(r.charName) + '</span>' +
                '<span class="cs-date">' + escHtml(r.chatDate) + '</span>' +
                '<span class="cs-floor">第 ' + (r.msgIndex + 1) + ' 楼</span>' +
                '<span class="cs-who">' + who + '</span>' +
                swipeTag +
                '</div>' +
                '<div class="cs-snippet">' + escHtml(r.snippet) + '</div>' +
                '</div>';
        }).join('');
        listEl.innerHTML = html;
        // 绑定点击
        listEl.querySelectorAll('.cs-item').forEach(el => {
            el.addEventListener('click', () => {
                const idx = Number(el.getAttribute('data-idx'));
                const r = results[idx];
                if (r) jumpTo(r);
            });
        });
    }

    // ---------- 跳转 ----------
    function waitForMesid(mesid, timeoutMs) {
        return new Promise(resolve => {
            const t0 = Date.now();
            const timer = setInterval(() => {
                if (document.querySelector('.mes[mesid="' + mesid + '"]')) {
                    clearInterval(timer);
                    resolve(true);
                } else if (Date.now() - t0 > timeoutMs) {
                    clearInterval(timer);
                    resolve(false);
                }
            }, 200);
        });
    }

    // 清空当前渲染的消息DOM（保留聊天数据），避免重复渲染
    function clearRendered() {
        document.querySelectorAll('#chat .mes, #show_more_messages').forEach(el => el.remove());
    }

    async function jumpTo(r) {
        try {
            ctx = window.SillyTavern.getContext();
            const idx = (ctx.characters || []).findIndex(c => c.avatar === r.avatar);
            if (idx < 0) {
                toastr.warning('找不到该角色', EXT_NAME);
                return;
            }
            const needSwitch = String(ctx.characterId) !== String(idx);
            if (needSwitch) {
                await ctx.selectCharacterById(idx);
            }
            await ctx.openCharacterChat(r.chatFile);

            // 处理「聊天截断显示」：目标楼层可能在未渲染的旧消息里
            const savedTruncation = (typeof power_user !== 'undefined') ? power_user.chat_truncation : 0;
            try {
                if (typeof redisplayChat === 'function') {
                    if (savedTruncation) {
                        // 先全量渲染，确保目标存在
                        power_user.chat_truncation = 0;
                        clearRendered();
                        await redisplayChat({ startIndex: 0, fade: false });
                    }
                }
            } catch (e) {
                console.warn('[chat-search] 渲染全量失败，尝试直接定位', e);
            }

            const ok = await waitForMesid(r.msgIndex, 12000);
            const el = document.querySelector('.mes[mesid="' + r.msgIndex + '"]');
            if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                el.classList.add('chat-search-flash');
                setTimeout(() => el.classList.remove('chat-search-flash'), 3000);
            }

            // 恢复截断：从目标楼层前 5 条开始渲染，保住目标在画面里
            if (savedTruncation && typeof redisplayChat === 'function') {
                try {
                    power_user.chat_truncation = savedTruncation;
                    clearRendered();
                    const startIndex = Math.max(0, r.msgIndex - 5);
                    await redisplayChat({ startIndex: startIndex, fade: false });
                    const el2 = document.querySelector('.mes[mesid="' + r.msgIndex + '"]');
                    if (el2) {
                        el2.scrollIntoView({ behavior: 'auto', block: 'center' });
                        el2.classList.add('chat-search-flash');
                        setTimeout(() => el2.classList.remove('chat-search-flash'), 3000);
                    }
                } catch (e) {
                    console.warn('[chat-search] 恢复截断失败', e);
                }
            }

            if (!ok) {
                toastr.info('已打开该聊天，但没找到目标楼层（可能被合并/删除）', EXT_NAME);
            }
            closeModal();
        } catch (e) {
            console.error('[chat-search] 跳转失败', e);
            toastr.error('跳转失败：' + (e.message || e), EXT_NAME);
        }
    }

    // ---------- 进度/筛选 ----------
    function setProgress(text) {
        const el = document.getElementById('chat-search-progress');
        if (el) el.textContent = text;
    }

    function getSelectedChars() {
        return selectedChars;
    }

    function setExcludeUser(v) {
        excludeUser = !!v;
        saveFilters();
    }

    function toggleChar(avatar) {
        if (selectedChars.has(avatar)) {
            selectedChars.delete(avatar);
        } else {
            selectedChars.add(avatar);
        }
        saveFilters();
        renderChips();
    }

    function clearChars() {
        selectedChars = new Set();
        saveFilters();
        renderCharFilterUI();
    }

    // 等待角色列表加载完成（页面加载后异步填充，大实例可能很慢），最多等 15 秒
    async function ensureCharsLoaded() {
        for (let i = 0; i < 30; i++) {
            ctx = window.SillyTavern.getContext();
            if (ctx.characters && ctx.characters.length > 0) return true;
            await new Promise(res => setTimeout(res, 500));
        }
        return false;
    }

    // 只刷新 chips + 计数（勾选时不重绘列表，避免 checkbox 失焦/游离导致连点失效）
    function renderChips() {
        const box = document.getElementById('chat-search-char-box');
        const count = document.getElementById('chat-search-char-count');
        if (!box) return;
        const chipsWrap = box.querySelector('.cs-chips');
        if (chipsWrap) {
            chipsWrap.innerHTML = '';
            const all = (ctx.characters || []);
            if (selectedChars.size === 0) {
                const s = document.createElement('span');
                s.className = 'cs-chip cs-chip-all';
                s.textContent = '全部角色';
                chipsWrap.appendChild(s);
            } else {
                selectedChars.forEach(av => {
                    const c = all.find(x => x.avatar === av);
                    if (!c) return;
                    const chip = document.createElement('span');
                    chip.className = 'cs-chip';
                    chip.textContent = c.name + ' ×';
                    chip.title = '点击移除';
                    chip.addEventListener('click', ev => {
                        ev.stopPropagation();
                        toggleChar(av);
                    });
                    chipsWrap.appendChild(chip);
                });
            }
        }
        if (count) {
            count.textContent = selectedChars.size === 0 ? '全部角色' : ('已选 ' + selectedChars.size + ' 个角色');
        }
    }

    // 渲染角色多选 UI：chips + 下拉列表
    function renderCharFilterUI() {
        ctx = window.SillyTavern.getContext();
        renderChips();
        const list = document.getElementById('chat-search-char-list');
        if (!list) return;
        const q = document.getElementById('chat-search-char-q');
        const kw = q ? q.value.trim().toLowerCase() : '';
        const chars = (ctx.characters || [])
            .filter(c => c.avatar && c.avatar !== 'none' && Number(c.chat_size) > 0)
            .filter(c => !kw || c.name.toLowerCase().includes(kw))
            .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
        if (chars.length === 0 && (!ctx.characters || ctx.characters.length === 0)) {
            // 角色还在加载：显示提示并稍后自动重绘
            list.innerHTML = '<div class="cs-char-empty">角色列表加载中…</div>';
            setTimeout(() => {
                if (document.getElementById('chat-search-char-list')) renderCharFilterUI();
            }, 1000);
            return;
        }
        list.innerHTML = '';
        if (chars.length === 0) {
            list.innerHTML = '<div class="cs-char-empty">没有匹配的角色</div>';
            return;
        }
        for (const c of chars) {
            const row = document.createElement('label');
            row.className = 'cs-char-row';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = selectedChars.has(c.avatar);
            cb.addEventListener('change', () => toggleChar(c.avatar));
            const span = document.createElement('span');
            span.textContent = c.name;
            span.className = 'cs-char-name';
            row.appendChild(cb);
            row.appendChild(span);
            list.appendChild(row);
        }
    }

    // ---------- UI 构建 ----------
    function buildStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const css = document.createElement('style');
        css.id = STYLE_ID;
        css.textContent = `
#${BTN_ID} {
    display:inline-flex; align-items:center; gap:4px;
    padding:4px 10px; margin:2px 4px; cursor:pointer;
    border:1px solid var(--SmartThemeBorderColor, #666);
    border-radius:8px; background:var(--SmartThemeBlurTintColor, rgba(128,128,128,.15));
    color:var(--SmartThemeBodyColor, #ddd); font-size:13px; line-height:1.4;
}
#${BTN_ID}:hover { filter:brightness(1.25); }
#${ROOT_ID} {
    position:fixed; top:0; left:0; right:0; bottom:0; z-index:99999;
    display:none; align-items:flex-start; justify-content:center; padding:6vh 12px 12px;
    background:rgba(0,0,0,.45);
}
#${ROOT_ID}.open { display:flex; }
#${ROOT_ID} .cs-panel {
    width:min(680px, 96vw); max-height:82vh;
    display:flex; flex-direction:column;
    background:var(--SmartThemeBlurTintColor, #1e1e2e);
    border:1px solid var(--SmartThemeBorderColor, #555);
    border-radius:12px; box-shadow:0 8px 40px rgba(0,0,0,.5);
    color:var(--SmartThemeBodyColor, #eee);
}
.cs-panel-head {
    display:flex; align-items:center; gap:8px;
    padding:10px 14px; border-bottom:1px solid var(--SmartThemeBorderColor, #444);
    font-weight:600;
}
.cs-panel-head .cs-title { flex:1; }
.cs-panel-head button { cursor:pointer; background:none; border:none; color:inherit; font-size:18px; line-height:1; }
.cs-search-row {
    display:flex; gap:8px; padding:10px 14px;
    border-bottom:1px solid var(--SmartThemeBorderColor, #444);
}
.cs-search-row input {
    flex:1; padding:8px 10px; border-radius:8px;
    border:1px solid var(--SmartThemeBorderColor, #555);
    background:var(--SmartThemeBlurTintColor, #2a2a3a);
    color:var(--SmartThemeBodyColor, #eee); font-size:14px;
}
.cs-search-row button {
    padding:8px 16px; border-radius:8px; cursor:pointer;
    border:1px solid var(--SmartThemeBorderColor, #555);
    background:var(--SmartThemeBlurTintColor, #3a3a4a);
    color:var(--SmartThemeBodyColor, #eee); font-size:14px; white-space:nowrap;
}
.cs-search-row button:hover { filter:brightness(1.2); }
/* 筛选行 */
.cs-filter-row {
    display:flex; align-items:center; gap:8px; flex-wrap:wrap;
    padding:8px 14px; border-bottom:1px solid var(--SmartThemeBorderColor, #444);
}
.cs-char-box {
    position:relative; flex:1; min-width:200px;
    border:1px solid var(--SmartThemeBorderColor, #555);
    border-radius:8px; background:var(--SmartThemeBlurTintColor, #2a2a3a);
    padding:4px 6px; cursor:pointer; display:flex; align-items:center; gap:4px; flex-wrap:wrap;
}
.cs-chips { display:flex; align-items:center; gap:4px; flex-wrap:wrap; flex:1; }
.cs-chip {
    display:inline-flex; align-items:center; gap:2px;
    background:var(--SmartThemeBlurTintColor, #4a4a6a);
    border:1px solid var(--SmartThemeBorderColor, #666);
    border-radius:10px; padding:1px 8px; font-size:12px; line-height:1.5; cursor:pointer;
}
.cs-chip:hover { filter:brightness(1.2); }
.cs-chip-all { opacity:.7; cursor:default; font-style:italic; }
.cs-char-caret { font-size:11px; opacity:.7; }
.cs-char-count { font-size:12px; opacity:.75; white-space:nowrap; }
.cs-char-dd {
    position:absolute; top:calc(100% + 4px); left:0; right:0; z-index:50;
    background:var(--SmartThemeBlurTintColor, #23233a);
    border:1px solid var(--SmartThemeBorderColor, #555);
    border-radius:8px; box-shadow:0 6px 24px rgba(0,0,0,.45);
    padding:6px; display:none;
}
.cs-char-dd.open { display:block; }
.cs-char-dd-head { display:flex; gap:6px; align-items:center; padding-bottom:6px; }
.cs-char-dd-head input {
    flex:1; padding:6px 8px; border-radius:6px;
    border:1px solid var(--SmartThemeBorderColor, #555);
    background:var(--SmartThemeBlurTintColor, #2a2a3a);
    color:var(--SmartThemeBodyColor, #eee); font-size:13px;
}
.cs-char-dd-head button {
    padding:4px 10px; border-radius:6px; cursor:pointer; white-space:nowrap;
    border:1px solid var(--SmartThemeBorderColor, #555);
    background:var(--SmartThemeBlurTintColor, #3a3a4a);
    color:var(--SmartThemeBodyColor, #eee); font-size:12px;
}
.cs-char-dd-head button:hover { filter:brightness(1.2); }
.cs-char-list { max-height:240px; overflow-y:auto; }
.cs-char-row {
    display:flex; align-items:center; gap:8px; padding:5px 6px;
    border-radius:6px; cursor:pointer; font-size:13px;
}
.cs-char-row:hover { background:var(--SmartThemeBlurTintColor, rgba(255,255,255,.08)); }
.cs-char-row input { accent-color:#ffa657; }
.cs-char-name { word-break:break-all; }
.cs-char-empty { padding:10px; text-align:center; opacity:.6; font-size:12px; }
.cs-exclude-user {
    display:inline-flex; align-items:center; gap:5px;
    font-size:13px; white-space:nowrap; cursor:pointer; user-select:none;
}
.cs-exclude-user input { accent-color:#ffa657; }
.cs-exclude-user:hover { filter:brightness(1.15); }
.cs-meta { display:flex; justify-content:space-between; padding:4px 14px; font-size:12px; opacity:.8; }
#${ROOT_ID} .cs-list {
    overflow-y:auto; padding:4px 10px 12px;
}
.cs-item {
    padding:8px 10px; margin:4px 0; cursor:pointer;
    border:1px solid transparent; border-radius:8px;
}
.cs-item:hover { background:var(--SmartThemeBlurTintColor, rgba(255,255,255,.07)); border-color:var(--SmartThemeBorderColor,#555); }
.cs-item-head { display:flex; align-items:center; gap:8px; font-size:12px; flex-wrap:wrap; }
.cs-char { font-weight:700; }
.cs-date { opacity:.75; }
.cs-floor { background:var(--SmartThemeBlurTintColor, rgba(128,128,128,.25)); border-radius:4px; padding:1px 6px; }
.cs-who { opacity:.7; }
.cs-swipe { color:#ffa657; font-size:11px; }
.cs-snippet {
    margin-top:4px; font-size:13px; line-height:1.6;
    color:var(--SmartThemeBodyColor, #eee); opacity:.92;
    word-break:break-all;
}
.cs-empty { padding:24px; text-align:center; opacity:.6; }
.chat-search-flash { outline:3px solid #ffd54d; outline-offset:2px; border-radius:6px; animation:cs-flash 2.5s ease-out; }
@keyframes cs-flash { 0% { background:rgba(255,213,77,.4); } 100% { background:transparent; } }
`;
        document.head.appendChild(css);
    }

    function buildModal() {
        if (document.getElementById(ROOT_ID)) return;
        // 恢复上次筛选
        try {
            const saved = loadJson(FILTER_KEY, null);
            if (saved) {
                selectedChars = new Set(Array.isArray(saved.chars) ? saved.chars : []);
                excludeUser = !!saved.excludeUser;
            }
        } catch { /* 忽略 */ }
        const div = document.createElement('div');
        div.id = ROOT_ID;
        div.innerHTML = `
<div class="cs-panel">
  <div class="cs-panel-head">
    <span class="cs-title">🔍 聊天全文搜索</span>
    <button id="chat-search-close" title="关闭">×</button>
  </div>
  <div class="cs-search-row">
    <input id="chat-search-input" type="text" placeholder="输入关键词，多个词用空格分隔（AND）…" />
    <button id="chat-search-go">搜索</button>
    <button id="chat-search-clear" title="清空缓存重新扫描">刷新</button>
  </div>
  <div class="cs-filter-row">
    <div id="chat-search-char-box" class="cs-char-box" title="点击选择角色（可搜索多选，不选=全部）">
      <div class="cs-chips"></div>
      <span class="cs-char-caret">▾</span>
      <div id="chat-search-char-dd" class="cs-char-dd">
        <div class="cs-char-dd-head">
          <input id="chat-search-char-q" type="text" placeholder="搜索角色名…" />
          <button id="chat-search-char-all" type="button">全选</button>
          <button id="chat-search-char-none" type="button">清空</button>
        </div>
        <div id="chat-search-char-list" class="cs-char-list"></div>
      </div>
    </div>
    <span id="chat-search-char-count" class="cs-char-count"></span>
    <label class="cs-exclude-user"><input type="checkbox" id="chat-search-exclude-user" /> 排除用户消息</label>
  </div>
  <div class="cs-meta">
    <span id="chat-search-info"></span>
    <span id="chat-search-progress"></span>
  </div>
  <div id="chat-search-results" class="cs-list"></div>
</div>`;
        document.body.appendChild(div);

        const input = div.querySelector('#chat-search-input');
        const go = div.querySelector('#chat-search-go');
        const close = div.querySelector('#chat-search-close');
        const clear = div.querySelector('#chat-search-clear');
        const box = div.querySelector('#chat-search-char-box');
        const dd = div.querySelector('#chat-search-char-dd');
        const q = div.querySelector('#chat-search-char-q');
        const exUser = div.querySelector('#chat-search-exclude-user');

        // 角色多选交互
        exUser.checked = excludeUser;
        exUser.addEventListener('change', () => setExcludeUser(exUser.checked));
        box.addEventListener('click', ev => {
            // 点 chips 的 × 已 stopPropagation，这里只负责开关下拉
            dd.classList.toggle('open');
        });
        q.addEventListener('input', () => renderCharFilterUI());
        q.addEventListener('click', ev => ev.stopPropagation());
        div.querySelector('#chat-search-char-all').addEventListener('click', ev => {
            ev.stopPropagation();
            const chars = (ctx.characters || [])
                .filter(c => c.avatar && c.avatar !== 'none' && Number(c.chat_size) > 0);
            selectedChars = new Set(chars.map(c => c.avatar));
            saveFilters();
            renderCharFilterUI();
        });
        div.querySelector('#chat-search-char-none').addEventListener('click', ev => {
            ev.stopPropagation();
            clearChars();
        });
        document.addEventListener('click', ev => {
            if (box && !box.contains(ev.target)) dd.classList.remove('open');
        });
        renderCharFilterUI();

        function runSearch() {
            const kw = input.value.trim();
            if (!kw) {
                toastr.info('请输入关键词', EXT_NAME);
                return;
            }
            doSearch(kw);
        }
        go.addEventListener('click', runSearch);
        input.addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(); });
        close.addEventListener('click', closeModal);
        div.addEventListener('click', e => { if (e.target === div) closeModal(); });
        clear.addEventListener('click', () => {
            chatListCache.clear();
            messageCache.clear();
            msgCacheOrder = [];
            toastr.success('已清空缓存，下次搜索将重新扫描', EXT_NAME);
        });
    }

    async function openModal() {
        buildStyle();
        await ensureCharsLoaded();
        buildModal();
        const modal = document.getElementById(ROOT_ID);
        modal.classList.add('open');
        const input = document.getElementById('chat-search-input');
        setTimeout(() => input && input.focus(), 50);
    }

    function closeModal() {
        const modal = document.getElementById(ROOT_ID);
        if (modal) modal.classList.remove('open');
    }

    function buildButton() {
        if (document.getElementById(BTN_ID)) return;
        // 优先放进左侧聊天列表头部；找不到则放固定位置（左上、避开右下悬浮窗）
        const anchors = [
            '#chat_list_header',
            '.chat_list_header',
            '#character_list_header',
            '#left-nav-panel .flex-container',
            '#left-nav-panel',
        ];
        let anchor = null;
        for (const sel of anchors) {
            const el = document.querySelector(sel);
            if (el && el.offsetParent !== null) { anchor = el; break; }
        }
        const btn = document.createElement('button');
        btn.id = BTN_ID;
        btn.type = 'button';
        btn.innerHTML = '🔍 搜索聊天内容';
        btn.title = '在所有角色的聊天记录中搜索关键词，点击直达对应楼层';
        btn.addEventListener('click', openModal);
        if (anchor) {
            anchor.appendChild(btn);
        } else {
            btn.style.cssText = 'position:fixed; top:52px; left:12px; z-index:9999;';
            document.body.appendChild(btn);
        }
    }

    // ---------- 缓存失效 ----------
    function invalidateCurrent() {
        try {
            if (ctx.characterId !== undefined && ctx.characters && ctx.characters[ctx.characterId]) {
                const av = ctx.characters[ctx.characterId].avatar;
                const cid = ctx.getCurrentChatId ? ctx.getCurrentChatId() : null;
                if (av && cid) messageCache.delete(av + '::' + cid);
                if (av) chatListCache.delete(av);
            }
        } catch (e) { /* 忽略 */ }
    }

    // ---------- 初始化 ----------
    function init() {
        ctx = window.SillyTavern.getContext();
        buildStyle();
        buildButton();
        const ET = ctx.eventTypes;
        try {
            ctx.eventSource.on(ET.MESSAGE_SENT, invalidateCurrent);
            ctx.eventSource.on(ET.MESSAGE_RECEIVED, invalidateCurrent);
            ctx.eventSource.on(ET.CHAT_CHANGED, () => {
                chatListCache.clear();
                messageCache.clear();
                msgCacheOrder = [];
            });
        } catch (e) {
            console.warn('[chat-search] 事件绑定失败（不影响手动搜索）', e);
        }
        // 斜杠命令：/chatsearch 关键词
        try {
            ctx.registerSlashCommand('chatsearch', function (args, text) {
                openModal();
                const input = document.getElementById('chat-search-input');
                if (input && text) { input.value = text; doSearch(text); }
                return '';
            }, ['cs'], '搜索所有角色聊天记录的内容', 'chatsearch <关键词>');
        } catch (e) {
            console.warn('[chat-search] 斜杠命令注册失败', e);
        }
        console.log('[chat-search] 初始化完成');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
