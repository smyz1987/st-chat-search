// ============================================================
// 聊天全文搜索 chat-search
// 在首页(聊天列表)搜索所有角色所有聊天的内容，
// 定位：哪个角色 / 哪次聊天 / 第几楼 / 命中位置，点击直达并高亮。
// 纯前端实现：调用酒馆内置 /api/chats/search + /api/chats/get，
// 不改配置、不重启服务、不影响其他扩展。
// ============================================================

import { redisplayChat, getCharacters } from '../../../../script.js';
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
    const FAV_KEY = 'chat-search-favorites';
    let selectedChars = new Set();
    let excludeUser = false;
    let favorites = [];   // [{avatar, charName, chatFile, msgIndex, snippet, favTime}]
    let lastSearchKeyword = '';   // 最近一次搜索的关键词（用于跳转后的金色高亮）
    let kwHighlightOn = false;    // 金色关键词高亮开关（再次点击结果时关闭）
    let liveChars = null;         // 在线加载的全量角色列表（每次打开弹窗刷新，新增角色卡后立即可见）
    let liveCharsLoading = false;

    // 在线拉取全量角色列表（新增角色卡后无需刷新酒馆页面）
    async function loadLiveChars(force) {
        if (liveChars && !force) return liveChars;
        if (liveCharsLoading) {
            for (let i = 0; i < 40 && liveCharsLoading; i++) await new Promise(r => setTimeout(r, 250));
            return liveChars || [];
        }
        liveCharsLoading = true;
        try {
            const resp = await fetch('/api/characters/all', {
                method: 'POST',
                headers: (typeof getRequestHeaders === 'function') ? getRequestHeaders() : {},
                body: JSON.stringify({}),
            });
            if (resp.ok) {
                const data = await resp.json();
                liveChars = (Array.isArray(data) ? data : [])
                    .filter(c => c && c.avatar && c.avatar !== 'none')
                    .map(c => ({ name: c.name, avatar: c.avatar, chat_size: c.chat_size }));
            } else {
                liveChars = null;
            }
        } catch (e) {
            console.warn('[chat-search] 角色列表在线加载失败', e);
            liveChars = null;
        }
        liveCharsLoading = false;
        return liveChars || [];
    }

    // 当前有效的角色来源：在线列表优先，兜底 ST 上下文
    function currentChars() {
        return (liveChars && liveChars.length) ? liveChars : ((ctx && ctx.characters) || []);
    }

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

    // ---------- 收藏 ----------
    function loadFavorites() {
        try {
            const v = loadJson(FAV_KEY, []);
            favorites = Array.isArray(v) ? v : [];
        } catch { favorites = []; }
    }

    function saveFavorites() {
        try { localStorage.setItem(FAV_KEY, JSON.stringify(favorites)); } catch { /* 忽略 */ }
    }

    function favKeyOf(r) {
        return r.avatar + '::' + r.chatFile + '::' + r.msgIndex;
    }

    function isFavorite(r) {
        const k = favKeyOf(r);
        return favorites.some(f => favKeyOf(f) === k);
    }

    function toggleFavorite(r) {
        const k = favKeyOf(r);
        const i = favorites.findIndex(f => favKeyOf(f) === k);
        if (i >= 0) {
            favorites.splice(i, 1);
        } else {
            favorites.unshift({
                avatar: r.avatar,
                charName: r.charName,
                chatFile: r.chatFile,
                msgIndex: r.msgIndex,
                snippet: r.snippet || '',
                favTime: Date.now(),
            });
        }
        saveFavorites();
        updateFavCount();
    }

    function updateFavCount() {
        const el = document.getElementById('chat-search-fav-count');
        if (el) el.textContent = favorites.length;
    }

    function removeFavorite(idx) {
        if (idx >= 0 && idx < favorites.length) {
            favorites.splice(idx, 1);
            saveFavorites();
            updateFavCount();
            renderFavList();
        }
    }

    function escHtml(s) {
        return String(s ?? '').replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function escAttr(s) {
        return String(s ?? '').replace(/[&"']/g, function (c) {
            return { '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c];
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
            // ST getChat() 无条件 shift 首行作 header（chat 数组从文件第 2 行起、mesid 从 0 起）
            // → 渲染 mesid = 文件行索引 - 1（无论首行是 header 还是消息都会被吃掉，故 <0 的行不可跳转）
            const msgIndex = i - 1;
            if (msgIndex < 0) continue;
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
        lastSearchKeyword = keyword;
        // 每次搜索前刷新上下文（角色列表是页面加载后异步填充的）
        ctx = window.SillyTavern.getContext();
        const frags = keyword.trim().toLowerCase().split(/\s+/).filter(Boolean);
        if (frags.length === 0) {
            searching = false;
            renderResults([], 0);
            return;
        }
        // 角色列表：在线加载优先（最新，含新增角色卡），兜底 ST 上下文；最多等 12 秒
        let allChars = currentChars().filter(c => c.avatar && c.avatar !== 'none');
        for (let w = 0; w < 24 && allChars.length === 0; w++) {
            await new Promise(res => setTimeout(res, 500));
            ctx = window.SillyTavern.getContext();
            // 兜底触发在线加载（刷新页面后首次搜索，保证拿到全量角色而不是空结果）
            if (!liveChars || liveChars.length === 0) {
                await loadLiveChars(false);
            }
            allChars = currentChars().filter(c => c.avatar && c.avatar !== 'none');
        }
        // 角色筛选：选中了角色就只搜这些角色（同名卡一起选中的都在集合里）；
        // 未选角色则扫描全部角色（无聊天记录的角色 API 快速返回空，不遗漏新增角色卡）
        const selected = getSelectedChars();
        const targets = selected.size > 0
            ? allChars.filter(c => selected.has(c.avatar))
            : allChars;
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

    // ---------- 渲染（角色分组 + 分页） ----------
    let resultGroups = [];      // [{ charName, items: [result,...] }]
    let resultPage = 1;         // 当前页码
    const RESULT_PAGE_SIZE = 6; // 每页最多 6 个角色分组
    const RESULT_GROUP_LIMIT = 6; // 单个角色展开后最多显示 6 条
    let expandedChars = new Set(); // 已展开的角色名（默认全部折叠）

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
        // 按角色分组（保持命中先后顺序，同一角色聚在一起）
        const groups = [];
        const map = new Map();
        results.forEach((r, idx) => {
            r.__gidx = idx;
            if (!map.has(r.charName)) {
                map.set(r.charName, []);
                groups.push({ charName: r.charName, items: map.get(r.charName) });
            }
            map.get(r.charName).push(r);
        });
        resultGroups = groups;
        resultPage = 1;
        expandedChars = new Set(); // 新搜索默认全部折叠
        renderGroupPage();
    }

    function itemHtml(r) {
        const who = r.isUser ? '用户' : '角色';
        const swipeTag = r.swipeCount > 1 ? '<span class="cs-swipe">命中第 ' + (r.swipeId + 1) + '/' + r.swipeCount + ' 条候选</span>' : '';
        const faved = isFavorite(r);
        return '<div class="cs-item" data-idx="' + r.__gidx + '">' +
            '<div class="cs-item-head">' +
            '<span class="cs-date">' + escHtml(r.chatDate) + '</span>' +
            '<span class="cs-floor">第 ' + (r.msgIndex) + ' 楼</span>' +
            '<span class="cs-who">' + who + '</span>' +
            swipeTag +
            '<span class="cs-fav-btn' + (faved ? ' faved' : '') + '" title="收藏此楼，之后可在「收藏」里直接跳转">' + (faved ? '★' : '☆') + '</span>' +
            '</div>' +
            '<div class="cs-snippet">' + escHtml(r.snippet) + '</div>' +
            '</div>';
    }

    function renderGroupPage() {
        const listEl = document.getElementById('chat-search-results');
        if (!listEl) return;
        const totalPages = Math.max(1, Math.ceil(resultGroups.length / RESULT_PAGE_SIZE));
        if (resultPage > totalPages) resultPage = totalPages;
        if (resultPage < 1) resultPage = 1;
        const start = (resultPage - 1) * RESULT_PAGE_SIZE;
        const pageGroups = resultGroups.slice(start, start + RESULT_PAGE_SIZE);

        const html = pageGroups.map(g => {
            const expanded = expandedChars.has(g.charName);
            const shown = expanded ? g.items.slice(0, RESULT_GROUP_LIMIT) : [];
            const more = expanded ? g.items.length - shown.length : 0;
            return '<div class="cs-group" data-char="' + escAttr(g.charName) + '">' +
                '<div class="cs-group-head' + (expanded ? ' open' : '') + '" title="点击展开/收起该角色的命中记录">' +
                '<span class="cs-group-arrow">' + (expanded ? '▼' : '▶') + '</span>' +
                '<span class="cs-char">' + escHtml(g.charName) + '</span>' +
                '<span class="cs-group-count">' + g.items.length + ' 条命中</span>' +
                '</div>' +
                (expanded ?
                    '<div class="cs-group-body">' +
                    shown.map(itemHtml).join('') +
                    (more > 0 ? '<div class="cs-group-more">该角色共 ' + g.items.length + ' 条命中，仅显示前 ' + RESULT_GROUP_LIMIT + ' 条，可用更精确的关键词缩小范围</div>' : '') +
                    '</div>' : '') +
                '</div>';
        }).join('');

        listEl.innerHTML = html +
            '<div class="cs-pager">' +
            '<button type="button" id="cs-prev"' + (resultPage <= 1 ? ' disabled' : '') + '>上一页</button>' +
            '<span class="cs-page-info">第 <input type="number" id="cs-page-input" min="1" max="' + totalPages + '" value="' + resultPage + '"> / ' + totalPages + ' 页</span>' +
            '<button type="button" id="cs-next"' + (resultPage >= totalPages ? ' disabled' : '') + '>下一页</button>' +
            '</div>';

        // 分组头：展开/收起
        listEl.querySelectorAll('.cs-group-head').forEach(el => {
            el.addEventListener('click', () => {
                const charName = el.closest('.cs-group').getAttribute('data-char');
                if (expandedChars.has(charName)) expandedChars.delete(charName);
                else expandedChars.add(charName);
                renderGroupPage();
            });
        });
        // 结果项：直达
        listEl.querySelectorAll('.cs-item').forEach(el => {
            el.addEventListener('click', () => {
                const idx = Number(el.getAttribute('data-idx'));
                const r = resultGroups.flatMap(g => g.items).find(x => x.__gidx === idx);
                if (r) jumpTo(r);
            });
        });
        // 收藏按钮（阻止冒泡，不触发跳转）
        listEl.querySelectorAll('.cs-fav-btn').forEach(el => {
            el.addEventListener('click', ev => {
                ev.stopPropagation();
                const idx = Number(el.closest('.cs-item').getAttribute('data-idx'));
                const r = resultGroups.flatMap(g => g.items).find(x => x.__gidx === idx);
                if (r) {
                    toggleFavorite(r);
                    const faved = isFavorite(r);
                    el.textContent = faved ? '★' : '☆';
                    el.classList.toggle('faved', faved);
                }
            });
        });
        // 翻页
        const prevBtn = listEl.querySelector('#cs-prev');
        const nextBtn = listEl.querySelector('#cs-next');
        const pageInput = listEl.querySelector('#cs-page-input');
        if (prevBtn) prevBtn.addEventListener('click', () => { if (resultPage > 1) { resultPage--; renderGroupPage(); } });
        if (nextBtn) nextBtn.addEventListener('click', () => { if (resultPage < totalPages) { resultPage++; renderGroupPage(); } });
        if (pageInput) {
            const go = () => {
                let v = parseInt(pageInput.value, 10);
                if (isNaN(v)) { pageInput.value = resultPage; return; }
                v = Math.max(1, Math.min(totalPages, v));
                resultPage = v;
                renderGroupPage();
            };
            pageInput.addEventListener('change', go);
            pageInput.addEventListener('keydown', ev => { if (ev.key === 'Enter') go(); });
        }
    }

    // ---------- 收藏列表 ----------
    function renderFavList() {
        const view = document.getElementById('chat-search-fav-view');
        if (!view) return;
        if (favorites.length === 0) {
            view.innerHTML = '<div class="cs-empty">还没有收藏。在搜索结果里点 ☆ 即可收藏该楼层，之后在这里一键直达。</div>';
            return;
        }
        view.innerHTML = favorites.map((f, idx) => {
            const when = new Date(f.favTime);
            const whenStr = (when.getMonth() + 1) + '/' + when.getDate() + ' ' +
                String(when.getHours()).padStart(2, '0') + ':' + String(when.getMinutes()).padStart(2, '0');
            return '<div class="cs-fav-item" data-fidx="' + idx + '">' +
                '<div class="cs-item-head">' +
                '<span class="cs-fav-del" title="取消收藏">×</span>' +
                '<span class="cs-char">' + escHtml(f.charName) + '</span>' +
                '<span class="cs-date">' + escHtml(humanTime(f.chatFile)) + '</span>' +
                '<span class="cs-floor">第 ' + (f.msgIndex) + ' 楼</span>' +
                '<span class="cs-fav-time">' + whenStr + ' 收藏</span>' +
                '</div>' +
                '<div class="cs-snippet">' + escHtml(f.snippet) + '</div>' +
                '</div>';
        }).join('') +
            '<div class="cs-fav-actions"><button id="chat-search-fav-clear" type="button">清空收藏</button></div>';
        // 点条目直达
        view.querySelectorAll('.cs-fav-item').forEach(el => {
            el.addEventListener('click', () => {
                const f = favorites[Number(el.getAttribute('data-fidx'))];
                if (f) jumpTo(f);
            });
        });
        // 删除单条
        view.querySelectorAll('.cs-fav-del').forEach(el => {
            el.addEventListener('click', ev => {
                ev.stopPropagation();
                const idx = Number(el.closest('.cs-fav-item').getAttribute('data-fidx'));
                removeFavorite(idx);
            });
        });
        // 清空全部
        const clearBtn = view.querySelector('#chat-search-fav-clear');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                favorites = [];
                saveFavorites();
                updateFavCount();
                renderFavList();
            });
        }
    }

    // ---------- 跳转 ----------
    // 清空当前渲染的消息DOM（保留聊天数据），避免重复渲染
    function clearRendered() {
        document.querySelectorAll('#chat .mes, #show_more_messages').forEach(el => el.remove());
    }

    // ---------- 关键词金色高亮 ----------
    // 在聊天消息的文本节点里把关键词包成金色 span（保留 ST 原有 HTML 结构）
    function applyKwHighlight(kw) {
        if (!kw) return;
        const frags = kw.trim().toLowerCase().split(/\s+/).filter(Boolean);
        if (frags.length === 0) return;
        const chat = document.getElementById('chat');
        if (!chat) return;
        const walker = document.createTreeWalker(chat, NodeFilter.SHOW_TEXT, null);
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        for (const node of nodes) {
            const text = node.nodeValue || '';
            const lower = text.toLowerCase();
            let hasHit = false;
            for (const f of frags) {
                if (lower.indexOf(f) >= 0) { hasHit = true; break; }
            }
            if (!hasHit) continue;
            const parent = node.parentNode;
            if (!parent || parent.closest && parent.closest('.cs-kw')) continue;
            const frag = document.createDocumentFragment();
            let rest = text;
            while (rest.length > 0) {
                const lrest = rest.toLowerCase();
                let bestIdx = -1;
                let bestLen = 0;
                for (const f of frags) {
                    const i = lrest.indexOf(f);
                    if (i >= 0 && (bestIdx < 0 || i < bestIdx)) { bestIdx = i; bestLen = f.length; }
                }
                if (bestIdx < 0) {
                    frag.appendChild(document.createTextNode(rest));
                    break;
                }
                if (bestIdx > 0) frag.appendChild(document.createTextNode(rest.slice(0, bestIdx)));
                const mark = document.createElement('span');
                mark.className = 'cs-kw';
                mark.textContent = rest.slice(bestIdx, bestIdx + bestLen);
                frag.appendChild(mark);
                rest = rest.slice(bestIdx + bestLen);
            }
            parent.replaceChild(frag, node);
        }
    }

    // 移除金色高亮（把 span 还原为纯文本，不破坏内容）
    function clearKwHighlight() {
        const marks = document.querySelectorAll('#chat .cs-kw');
        marks.forEach(el => {
            const t = document.createTextNode(el.textContent);
            el.parentNode.replaceChild(t, el);
        });
    }

    // 跳转后切换金色高亮：同一关键词再次点击结果 → 关闭；否则 → 开启
    function toggleKwHighlight() {
        const kw = lastSearchKeyword;
        if (!kw) return;
        if (kwHighlightOn) {
            clearKwHighlight();
            kwHighlightOn = false;
        } else {
            clearKwHighlight();
            applyKwHighlight(kw);
            kwHighlightOn = true;
        }
    }

    // 等待聊天界面渲染出消息（切换角色后数据异步加载，别太早重渲染）
    // 滚动保底：ST 异步渲染/截断恢复可能把滚动位置拉回顶部，持续纠正一段时间
    function startScrollGuard(mesid, durationMs, blockMode) {
        const t0 = Date.now();
        const timer = setInterval(() => {
            const el = document.querySelector('.mes[mesid="' + mesid + '"]');
            const chat = document.getElementById('chat');
            if (el && chat) {
                const rect = el.getBoundingClientRect();
                const cRect = chat.getBoundingClientRect();
                // 目标完全滚出消息区视口时才纠正，避免过度抖动
                if (rect.top < cRect.top - 40 || rect.bottom > cRect.bottom + 40) {
                    el.scrollIntoView({ behavior: 'auto', block: blockMode || 'center' });
                }
            }
            if (Date.now() - t0 > durationMs) clearInterval(timer);
        }, 800);
    }

    // 带超时的异步：超时返回 '__TIMEOUT__'（不抛错、不中断流程）
    function withTimeout(p, ms, label) {
        return Promise.race([
            Promise.resolve(p),
            new Promise(res => setTimeout(() => res('__TIMEOUT__'), ms)),
        ]);
    }

    let jumping = false; // 防止重复跳转叠加导致 ST 渲染冲突
    // 定位目标楼：只按精确 mesid 查找（ST getChat() 无条件 shift 首行作 header，msgIndex 已按 i-1 计算）
    function findMesidCandidates(base) {
        if (base >= 0 && document.querySelector('.mes[mesid="' + base + '"]')) return base;
        return -1;
    }
    function waitMesidAny(candidates, timeoutMs) {
        return new Promise(resolve => {
            const t0 = Date.now();
            const timer = setInterval(() => {
                for (const c of candidates) {
                    if (document.querySelector('.mes[mesid="' + c + '"]')) {
                        clearInterval(timer);
                        resolve(c);
                        return;
                    }
                }
                if (Date.now() - t0 > timeoutMs) {
                    clearInterval(timer);
                    resolve(-1);
                }
            }, 200);
        });
    }

    // 等待目标消息内容渲染完成（mes_text 非空），避免滚动定位到"卡成代码"的未渲染消息
    function waitMesText(mesEl, timeoutMs) {
        return new Promise(resolve => {
            const mt = mesEl.querySelector('.mes_text');
            if (mt && mt.textContent.trim().length > 0) { resolve(true); return; }
            const t0 = Date.now();
            const timer = setInterval(() => {
                const mt2 = mesEl.querySelector('.mes_text');
                if (mt2 && mt2.textContent.trim().length > 0) { clearInterval(timer); resolve(true); }
                else if (Date.now() - t0 > timeoutMs) { clearInterval(timer); resolve(false); }
            }, 200);
        });
    }

    // 等待目标消息内容渲染完成（mes_text 非空），避免滚动定位到"卡成代码"的未渲染消息

    async function jumpTo(r) {
        if (jumping) {
            toastr.info('正在跳转中，请稍候', EXT_NAME);
            return;
        }
        jumping = true;
        try {
            ctx = window.SillyTavern.getContext();
            let idx = (ctx.characters || []).findIndex(c => c.avatar === r.avatar);
            if (idx < 0 && typeof getCharacters === 'function') {
                // ST 上下文里没有该角色（页面加载后新增的角色卡）：刷新 ST 角色列表再找
                try {
                    const gc = await withTimeout(getCharacters(), 8000, '刷新角色列表');
                    if (gc === '__TIMEOUT__') console.warn('[chat-search] 刷新角色列表超时');
                    ctx = window.SillyTavern.getContext();
                    idx = (ctx.characters || []).findIndex(c => c.avatar === r.avatar);
                } catch (e) {
                    console.warn('[chat-search] 刷新角色列表失败', e);
                }
            }
            if (idx < 0) {
                toastr.warning('找不到该角色', EXT_NAME);
                return;
            }
            // 点击即反馈：用户知道跳转在进行（ST 渲染聊天需要数秒，避免以为卡死）
            toastr.info('正在跳转到「' + r.charName + '」第 ' + r.msgIndex + ' 楼…', EXT_NAME, { timeOut: 4000 });

            // 轻量切换角色：直接 setCharacterId + openCharacterChat（单次 getChat）。
            // 不用 selectCharacterById（它内部会先 getChat 加载角色默认聊天，再 openCharacterChat 又 getChat 一次，
            // 双重渲染是跳转慢的主因）；selectCharacterById 仅作为回退。
            const needSwitch = String(ctx.characterId) !== String(idx);
            if (needSwitch) {
                let switched = false;
                try {
                    if (typeof setCharacterId === 'function') {
                        // 离开群聊状态（openCharacterChat 针对单角色）
                        if (typeof resetSelectedGroup === 'function' && window.SillyTavern.getContext().selected_group) {
                            resetSelectedGroup();
                        }
                        setCharacterId(idx);
                        if (typeof setCharacterName === 'function' && ctx.characters && ctx.characters[idx]) {
                            setCharacterName(ctx.characters[idx].name);
                        }
                        switched = true;
                    }
                } catch (e) {
                    console.warn('[chat-search] 轻量切换失败，回退 selectCharacterById', e);
                }
                if (!switched) {
                    try {
                        const sw = await withTimeout(ctx.selectCharacterById(idx), 8000, '切换角色');
                        if (sw === '__TIMEOUT__') console.warn('[chat-search] 切换角色超时（继续尝试）');
                    } catch (e) {
                        console.warn('[chat-search] 切换角色异常（继续尝试）', e);
                    }
                }
            }
            // 目标聊天是否当前已打开（同一角色 + 同一聊天文件）→ 跳过重加载，直接定位（秒跳，参考单角色搜索体验）
            const selChatEl = document.getElementById('selected_chat_pole');
            const curChatFile = selChatEl ? selChatEl.value : null;
            const sameChat = String(ctx.characterId) === String(idx) && curChatFile === r.chatFile;
            if (!sameChat) {
                try {
                    const op = await withTimeout(ctx.openCharacterChat(r.chatFile), 8000, '打开聊天');
                    if (op === '__TIMEOUT__') console.warn('[chat-search] 打开聊天超时（继续尝试）');
                } catch (e) {
                    console.warn('[chat-search] 打开聊天异常（继续尝试）', e);
                }
            }

            // 快速定位：目标楼周围 ±5 条内足够（渲染量最小化 → 更快，实测明显提速）。
            // 1) 先轮询 ST 原生渲染：目标楼靠前时第一批就会出现，直接命中；
            // 2) 800ms 内未出现（目标楼靠后/被截断）→ 只渲染目标楼前后各 5 条（跳过前面大量消息）
            let el = null;
            let actualMesid = -1;
            let fastRendered = false;
            const jt0 = Date.now();
            while (Date.now() - jt0 < 10000) {
                actualMesid = findMesidCandidates(r.msgIndex);
                if (actualMesid >= 0) { el = document.querySelector('.mes[mesid="' + actualMesid + '"]'); break; }
                if (!fastRendered && Date.now() - jt0 > 800 && typeof redisplayChat === 'function') {
                    fastRendered = true;
                    const savedTruncation = (typeof power_user !== 'undefined') ? power_user.chat_truncation : 0;
                    (async () => {
                        try {
                            power_user.chat_truncation = 0;
                            clearRendered();
                            const startIndex = Math.max(0, r.msgIndex - 5);
                            await withTimeout(redisplayChat({ startIndex: startIndex, fade: false }), 12000, '渲染聊天');
                            // 只保留目标楼周围 ±5 条（渲染量最小化 → 跳转快）
                            const endMesid = r.msgIndex + 5;
                            document.querySelectorAll('#chat .mes').forEach(m => {
                                if (Number(m.getAttribute('mesid')) > endMesid) m.remove();
                            });
                        } catch (e) {
                            console.warn('[chat-search] 快速渲染失败，继续轮询定位', e);
                        }
                        if (typeof power_user !== 'undefined') {
                            power_user.chat_truncation = savedTruncation;
                        }
                    })();
                }
                await new Promise(res => setTimeout(res, 100));
            }

            if (el) {
                // 等消息内容渲染（短等待：多数消息 <0.8s 完成；未完成则先定位、后台再微调）
                const rendered = await waitMesText(el, 800);
                const textLen = (el.textContent || '').length;
                const blockMode = textLen > 4000 ? 'start' : 'center';
                el.scrollIntoView({ behavior: 'auto', block: blockMode });
                el.classList.add('chat-search-flash');
                setTimeout(() => el.classList.remove('chat-search-flash'), 3000);
                // 滚动保底：持续纠正 ST 渲染流程导致的回顶（后台，不阻塞）
                startScrollGuard(actualMesid, 4000, blockMode);
                if (!rendered) {
                    // 内容仍在渲染：后台等它完成后再微调一次定位（防"卡成代码"）
                    (async () => {
                        await waitMesText(el, 8000);
                        const el2 = document.querySelector('.mes[mesid="' + actualMesid + '"]');
                        if (el2) {
                            const len2 = (el2.textContent || '').length;
                            el2.scrollIntoView({ behavior: 'auto', block: len2 > 4000 ? 'start' : 'center' });
                        }
                    })();
                }
            }

            if (actualMesid >= 0) {
                if (actualMesid !== r.msgIndex) {
                    console.warn('[chat-search] 楼层偏移修正 ' + r.msgIndex + '→' + actualMesid);
                }
                // 金色关键词高亮：同一关键词再次点击结果 → 关闭；不同关键词 → 开启（仅跳转成功时）
                toggleKwHighlight();
                toastr.success('已跳转到「' + r.charName + '」第 ' + (actualMesid) + ' 楼', EXT_NAME);
            } else {
                toastr.info('已打开该聊天，但没找到目标楼层（可能被合并/删除）', EXT_NAME);
            }
            closeModal();
        } catch (e) {
            console.error('[chat-search] 跳转失败', e, e && e.stack);
            toastr.error('跳转失败：' + (e && e.message ? e.message : String(e)), EXT_NAME);
            // 失败也恢复搜索结果并关弹窗，避免界面卡死
            renderGroupPage();
            closeModal();
        } finally {
            jumping = false;
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
            const all = currentChars();
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

    // 渲染角色多选 UI：折叠按钮 + 下拉列表（全量角色，同名合并，点击一起筛）
    function renderCharFilterUI() {
        ctx = window.SillyTavern.getContext();
        renderChips();
        const list = document.getElementById('chat-search-char-list');
        if (!list) return;
        const q = document.getElementById('chat-search-char-q');
        const kw = q ? q.value.trim().toLowerCase() : '';
        const all = currentChars().filter(c => c.avatar && c.avatar !== 'none');
        if (all.length === 0) {
            // 角色还在加载：显示提示并稍后自动重绘
            list.innerHTML = '<div class="cs-char-empty">角色列表加载中…</div>';
            setTimeout(() => {
                if (document.getElementById('chat-search-char-list')) renderCharFilterUI();
            }, 1000);
            return;
        }
        // 按名字分组（同名卡合并，点击一起筛）
        const groups = new Map();
        for (const c of all) {
            if (!groups.has(c.name)) groups.set(c.name, []);
            groups.get(c.name).push(c);
        }
        const names = [...groups.keys()]
            .filter(n => !kw || n.toLowerCase().includes(kw))
            .sort((a, b) => a.localeCompare(b, 'zh'));
        list.innerHTML = '';
        if (names.length === 0) {
            list.innerHTML = '<div class="cs-char-empty">没有匹配的角色</div>';
            return;
        }
        for (const name of names) {
            const cards = groups.get(name);
            const row = document.createElement('div');
            row.className = 'cs-char-row';
            row.setAttribute('data-name', name);
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            const allSelected = cards.every(c => selectedChars.has(c.avatar));
            const someSelected = cards.some(c => selectedChars.has(c.avatar));
            cb.checked = allSelected;
            cb.indeterminate = someSelected && !allSelected;
            const span = document.createElement('span');
            span.textContent = name + (cards.length > 1 ? '（' + cards.length + ' 张卡）' : '');
            span.className = 'cs-char-name';
            span.title = cards.length > 1 ? '该名字有 ' + cards.length + ' 张卡，点击一起筛' : '';
            row.appendChild(cb);
            row.appendChild(span);
            // 整行可点（label 行为）
            row.addEventListener('click', ev => {
                if (ev.target.tagName === 'INPUT') return; // 原生 checkbox 自己处理
                toggleCharGroup(name, cards, row, cb);
            });
            cb.addEventListener('change', () => toggleCharGroup(name, cards, row, cb));
            list.appendChild(row);
        }
    }

    // 按同名组切换选中（同名卡一起选中/取消）
    function toggleCharGroup(name, cards, row, cb) {
        const allSelected = cards.every(c => selectedChars.has(c.avatar));
        if (allSelected) {
            cards.forEach(c => selectedChars.delete(c.avatar));
        } else {
            cards.forEach(c => selectedChars.add(c.avatar));
        }
        saveFilters();
        renderChips();
        const newAll = cards.every(c => selectedChars.has(c.avatar));
        const newSome = cards.some(c => selectedChars.has(c.avatar));
        cb.checked = newAll;
        cb.indeterminate = newSome && !newAll;
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
    width:min(680px, 96vw); max-height:82vh; overflow:hidden;
    display:flex; flex-direction:column;
    background:var(--SmartThemeBlurTintColor, #1e1e2e);
    border:1px solid var(--SmartThemeBorderColor, #555);
    border-radius:12px; box-shadow:0 8px 40px rgba(0,0,0,.5);
    color:var(--SmartThemeBodyColor, #eee);
}
#chat-search-search-view {
    display:flex; flex-direction:column; flex:1; min-height:0;
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
.cs-filter-btn {
    display:inline-flex; align-items:center; gap:6px;
    padding:6px 12px; border-radius:8px; cursor:pointer;
    border:1px solid var(--SmartThemeBorderColor, #555);
    background:var(--SmartThemeBlurTintColor, #3a3a4a);
    color:var(--SmartThemeBodyColor, #eee); font-size:13px; white-space:nowrap;
}
.cs-filter-btn:hover { filter:brightness(1.2); }
.cs-filter-btn.active { border-color:#ffa657; }
.cs-filter-btn.active .cs-char-caret { transform:rotate(180deg); }
.cs-filter-icon { opacity:.8; }
.cs-char-box {
    width:calc(100% - 28px); margin:0 14px 4px; box-sizing:border-box;
    border:1px solid var(--SmartThemeBorderColor, #555);
    border-radius:8px; background:var(--SmartThemeBlurTintColor, #2a2a3a);
    padding:4px 6px; display:flex; align-items:center; gap:4px; flex-wrap:wrap;
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
.cs-char-caret { font-size:11px; opacity:.7; transition:transform .2s; }
.cs-char-count { font-size:12px; opacity:.75; white-space:nowrap; }
.cs-char-dd {
    width:calc(100% - 28px); margin:0 14px 4px; box-sizing:border-box;
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
    flex:1; min-height:0; overflow-y:auto; padding:4px 10px 12px;
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
.cs-group { margin:4px 0; border:1px solid var(--SmartThemeBorderColor, #444); border-radius:8px; overflow:hidden; }
.cs-group-head {
    display:flex; align-items:center; gap:8px; padding:8px 10px; cursor:pointer;
    background:var(--SmartThemeBlurTintColor, rgba(128,128,128,.15)); font-size:13px; user-select:none;
}
.cs-group-head:hover { filter:brightness(1.15); }
.cs-group-head.open { border-bottom:1px solid var(--SmartThemeBorderColor, #444); }
.cs-group-arrow { font-size:10px; opacity:.8; transition:transform .2s; }
.cs-group-count {
    margin-left:auto; font-size:12px; opacity:.7;
    background:var(--SmartThemeBlurTintColor, rgba(128,128,128,.25)); border-radius:10px; padding:1px 8px;
}
.cs-group-body { padding:2px 6px 6px; }
.cs-group-body .cs-item { margin:4px 0; }
.cs-group-more { padding:6px 10px; font-size:12px; opacity:.65; }
.cs-pager {
    display:flex; align-items:center; justify-content:center; gap:10px;
    padding:10px 0 4px; flex-wrap:wrap;
}
.cs-pager button {
    padding:5px 14px; border-radius:6px; cursor:pointer; white-space:nowrap;
    border:1px solid var(--SmartThemeBorderColor, #555);
    background:var(--SmartThemeBlurTintColor, #3a3a4a);
    color:var(--SmartThemeBodyColor, #eee); font-size:12px;
}
.cs-pager button:hover:not(:disabled) { filter:brightness(1.2); }
.cs-pager button:disabled { opacity:.4; cursor:not-allowed; }
.cs-page-info { font-size:12px; display:inline-flex; align-items:center; gap:4px; }
#${ROOT_ID} #cs-page-input {
    width:56px; padding:3px 6px; border-radius:6px; text-align:center;
    border:1px solid var(--SmartThemeBorderColor, #555);
    background:var(--SmartThemeBlurTintColor, #2a2a3a);
    color:var(--SmartThemeBodyColor, #eee); font-size:12px;
}
.cs-snippet {
    margin-top:4px; font-size:13px; line-height:1.6;
    color:var(--SmartThemeBodyColor, #eee); opacity:.92;
    word-break:break-all;
}
.cs-empty { padding:24px; text-align:center; opacity:.6; }
.cs-tabs { display:flex; gap:6px; padding:0 14px 8px; flex-wrap:wrap; }
.cs-tab {
    background:var(--SmartThemeBlurTintColor, rgba(128,128,128,.15));
    border:1px solid var(--SmartThemeBorderColor, #666); border-radius:8px;
    color:var(--SmartThemeBodyColor, #ddd); font-size:13px; padding:5px 12px; cursor:pointer;
}
.cs-tab.active { background:var(--SmartThemeBlurTintColor, rgba(255,166,87,.35)); border-color:#ffa657; color:#ffd54d; font-weight:700; }
.cs-fav-num { font-weight:700; }
.cs-fav-btn { cursor:pointer; font-size:15px; margin-left:auto; opacity:.85; user-select:none; }
.cs-fav-btn:hover { opacity:1; transform:scale(1.15); }
.cs-fav-btn.faved { color:#ffd54d; opacity:1; }
.cs-fav-view { flex:1; min-height:0; overflow-y:auto; padding:4px 10px 12px; }
.cs-fav-item {
    padding:7px 10px; margin:4px 0; cursor:pointer;
    border:1px solid transparent; border-radius:8px;
}
.cs-fav-item:hover { background:var(--SmartThemeBlurTintColor, rgba(255,255,255,.07)); border-color:var(--SmartThemeBorderColor,#555); }
.cs-fav-del { cursor:pointer; color:#f87171; font-weight:700; font-size:14px; margin-right:2px; }
.cs-fav-del:hover { transform:scale(1.2); }
.cs-fav-time { opacity:.55; }
.cs-fav-actions { padding:10px; text-align:center; }
.cs-fav-actions button {
    background:var(--SmartThemeBlurTintColor, rgba(128,128,128,.15));
    border:1px solid var(--SmartThemeBorderColor, #666); border-radius:8px;
    color:var(--SmartThemeBodyColor, #ddd); font-size:13px; padding:5px 14px; cursor:pointer;
}
.cs-fav-actions button:hover { filter:brightness(1.2); }
.chat-search-flash { outline:3px solid #ffd54d; outline-offset:2px; border-radius:6px; animation:cs-flash 2.5s ease-out; }
@keyframes cs-flash { 0% { background:rgba(255,213,77,.4); } 100% { background:transparent; } }
.cs-kw {
    color:#ffd54d; background:rgba(255,213,77,.18);
    border-radius:3px; padding:0 1px; font-weight:700;
}
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
    <span class="cs-title">聊天全文搜索</span>
    <button id="chat-search-close" title="关闭">×</button>
  </div>
  <div class="cs-tabs">
    <button id="chat-search-tab-search" class="cs-tab active" type="button">🔍 搜索</button>
    <button id="chat-search-tab-fav" class="cs-tab" type="button">⭐ 收藏 <span id="chat-search-fav-count" class="cs-fav-num"></span></button>
  </div>
  <div id="chat-search-search-view">
  <div class="cs-search-row">
    <input id="chat-search-input" type="text" placeholder="输入关键词，多个词用空格分隔（AND）…" />
    <button id="chat-search-go">搜索</button>
    <button id="chat-search-clear" title="清空缓存重新扫描">刷新</button>
  </div>
  <div class="cs-filter-row">
    <button id="chat-search-filter-toggle" type="button" class="cs-filter-btn" title="点击展开/收起角色筛选（同名角色默认一起筛）">
      <span class="cs-filter-icon">⚙</span> 筛选角色
      <span id="chat-search-char-count" class="cs-char-count"></span>
      <span class="cs-char-caret">▾</span>
    </button>
    <label class="cs-exclude-user"><input type="checkbox" id="chat-search-exclude-user" /> 排除用户消息</label>
  </div>
  <div id="chat-search-char-dd" class="cs-char-dd">
    <div class="cs-char-dd-head">
      <input id="chat-search-char-q" type="text" placeholder="搜索角色名…" />
      <button id="chat-search-char-all" type="button">全选</button>
      <button id="chat-search-char-none" type="button">清空</button>
    </div>
    <div id="chat-search-char-list" class="cs-char-list"></div>
  </div>
  <div id="chat-search-char-box" class="cs-char-box" title="已选角色，点击标签可移除">
    <div class="cs-chips"></div>
  </div>
  <div class="cs-meta">
    <span id="chat-search-info"></span>
    <span id="chat-search-progress"></span>
  </div>
  <div id="chat-search-results" class="cs-list"></div>
  </div>
  <div id="chat-search-fav-view" class="cs-fav-view" style="display:none"></div>
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

        // 搜索 / 收藏 tab
        const tabSearch = div.querySelector('#chat-search-tab-search');
        const tabFav = div.querySelector('#chat-search-tab-fav');
        const searchView = div.querySelector('#chat-search-search-view');
        const favView = div.querySelector('#chat-search-fav-view');
        function switchTab(which) {
            const isFav = which === 'fav';
            tabSearch.classList.toggle('active', !isFav);
            tabFav.classList.toggle('active', isFav);
            searchView.style.display = isFav ? 'none' : '';
            favView.style.display = isFav ? '' : 'none';
            if (isFav) renderFavList();
        }
        tabSearch.addEventListener('click', () => switchTab('search'));
        tabFav.addEventListener('click', () => switchTab('fav'));
        updateFavCount();

        // 角色多选交互
        exUser.checked = excludeUser;
        exUser.addEventListener('change', () => setExcludeUser(exUser.checked));
        const filterToggle = div.querySelector('#chat-search-filter-toggle');
        filterToggle.addEventListener('click', ev => {
            ev.stopPropagation();
            dd.classList.toggle('open');
            filterToggle.classList.toggle('active', dd.classList.contains('open'));
        });
        q.addEventListener('input', () => renderCharFilterUI());
        q.addEventListener('click', ev => ev.stopPropagation());
        div.querySelector('#chat-search-char-all').addEventListener('click', ev => {
            ev.stopPropagation();
            const chars = currentChars()
                .filter(c => c.avatar && c.avatar !== 'none');
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
        await loadLiveChars(true);   // 每次打开弹窗都拉最新角色列表（新增角色卡后立即可筛）
        if (!document.getElementById(ROOT_ID)) {
            buildModal();
        } else {
            renderCharFilterUI();    // 弹窗已存在（复用）：刷新角色列表 UI，反映最新角色
        }
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
        let btn = document.getElementById(BTN_ID);
        if (!btn) {
            btn = document.createElement('button');
            btn.id = BTN_ID;
            btn.type = 'button';
            btn.innerHTML = '🔍 搜索聊天内容';
            btn.title = '在所有角色的聊天记录中搜索关键词，点击直达对应楼层';
            btn.addEventListener('click', openModal);
            document.body.appendChild(btn);
        }
        // 聊天历史弹窗打开时：按钮隐藏（不占空间，回到首页/关弹窗自动恢复）
        const popup = document.getElementById('select_chat_popup');
        const popupShadow = document.getElementById('shadow_select_chat_popup');
        const popupOpen = popup && getComputedStyle(popup).display !== 'none'
            && (!popupShadow || getComputedStyle(popupShadow).display !== 'none');
        if (popupOpen) {
            btn.style.display = 'none';
            btn.style.cssText = '';
            return;
        }
        // 按钮只在首页（总聊天列表 / 欢迎页"Recent Chats"）显示；
        // 进入角色聊天或打开聊天历史弹窗后不挂载、直接隐藏，不占空间。
        // 显隐由欢迎页容器控制（offsetParent 判断可见性），回到首页自动恢复。
        const anchors = ['.welcomeHeader', '#chat_list_header', '.chat_list_header', '#character_list_header'];
        for (const sel of anchors) {
            const el = document.querySelector(sel);
            if (el && el.offsetParent !== null) {
                if (el.contains(btn)) return; // 已在该锚点
                btn.style.cssText = '';
                btn.style.display = '';
                // 欢迎页：放在标题文本后面、快捷按钮前面，和"Recent Chats"同排
                if (sel === '.welcomeHeader') {
                    const title = el.querySelector('.recentChatsTitle');
                    if (title) {
                        el.insertBefore(btn, title.nextSibling);
                    } else {
                        el.insertBefore(btn, el.firstChild);
                    }
                } else {
                    el.appendChild(btn);
                }
                return;
            }
        }
        // 不在首页（进入角色聊天/弹窗/加载中）→ 隐藏，不占空间
        btn.style.display = 'none';
        btn.style.cssText = '';
    }

    // 欢迎页/聊天弹窗是异步渲染的，监听 DOM 变化保持按钮挂在对的位置
    let anchorObserver = null;
    function watchAnchors() {
        if (anchorObserver) return;
        let timer = null;
        anchorObserver = new MutationObserver(() => {
            if (timer) return;
            timer = setTimeout(() => {
                timer = null;
                buildButton();
            }, 400);
        });
        anchorObserver.observe(document.body, { childList: true, subtree: true });
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
        loadFavorites();
        buildStyle();
        buildButton();
        watchAnchors();
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
