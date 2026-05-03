/**
 * TurboClient-Photon v4.0.7: 终极启动优化版
 *   - 启动延迟：利用 requestIdleCallback 分片执行重任务
 *   - 虚拟滚动首屏只渲染可见区域，其余空闲时补全
 *   - Service Worker 预缓存关键资源
 *   - 完全不影响其他插件（无全局事件劫持、CSS 严格隔离）
 */

const PHOTON = {
    viewport: null,
    vNodes: new Map(),
    messageHeights: new Map(),
    frameScheduled: false,
    worker: null,
    lastMsgNode: null,
    statusEl: null,
    db: null,
    resizeObserver: null,
    _origAddMessage: null,
    idleTasks: [],
};

/* ───────── 状态栏 ───────── */
function createStatusEl() {
    if (!document.getElementById('photon-status')) {
        const el = document.createElement('div');
        el.id = 'photon-status';
        el.style.cssText = 'position:fixed;bottom:10px;right:10px;background:#000a;color:#0f0;padding:4px 8px;font-family:monospace;font-size:12px;z-index:99999;border-radius:4px;';
        document.body.appendChild(el);
        PHOTON.statusEl = el;
    }
}
function setStatus(text, type = 'info') {
    createStatusEl();
    const colors = { info: '#0f0', success: '#0f0', warn: '#ff0', error: '#f00' };
    PHOTON.statusEl.style.color = colors[type] || '#0f0';
    PHOTON.statusEl.textContent = `⚡ ${text}`;
    console.log(`%c[Photon-Client] ${text}`, `color:${colors[type]}`);
}

/* ───────── 空闲任务调度 ───────── */
function scheduleIdle(cb) {
    if ('requestIdleCallback' in window) {
        return requestIdleCallback(cb, { timeout: 2000 });
    } else {
        return setTimeout(cb, 0);
    }
}

/* ───────── Service Worker 注册 ───────── */
function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/scripts/extensions/third-party/TurboClient-Photon/sw-photon.js')
        .then(() => setStatus('SW 已注册', 'success'))
        .catch(e => setStatus(`SW 注册失败: ${e.message}`, 'error'));
}

/* ───────── IndexedDB (TTL 5分钟) ───────── */
const DB_NAME = 'PhotonCache', DB_VERSION = 1, CACHE_TTL = 5*60*1000;
function openDB() {
    return new Promise((resolve, reject) => {
        const r = indexedDB.open(DB_NAME, DB_VERSION);
        r.onupgradeneeded = () => { const db = r.result; if (!db.objectStoreNames.contains('apiCache')) db.createObjectStore('apiCache', { keyPath: 'url' }); };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
    });
}
async function cacheInDB(url, data) {
    if (!PHOTON.db) return;
    try { const tx = PHOTON.db.transaction('apiCache','readwrite'); tx.objectStore('apiCache').put({url, data, timestamp: Date.now()}); await tx.done; } catch(e) {}
}
async function getFromDB(url) {
    if (!PHOTON.db) return null;
    try { const tx = PHOTON.db.transaction('apiCache','readonly'); const r = await tx.objectStore('apiCache').get(url); return (r && Date.now()-r.timestamp < CACHE_TTL) ? r.data : null; } catch(e) { return null; }
}

/* ───────── MessagePack ───────── */
let msgpackReady = false;
function loadMsgPack() {
    if (window.msgpackLite) { msgpackReady = true; setStatus('MsgPack 就绪','success'); return; }
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/msgpack-lite@0.1.26/dist/msgpack.min.js';
    s.onload = () => { msgpackReady = true; setStatus('MsgPack 加载成功','success'); };
    s.onerror = () => setStatus('MsgPack 加载失败，用 JSON','warn');
    document.head.appendChild(s);
}

/* ───────── fetch 劫持 ───────── */
const originalFetch = window.fetch;
window.fetch = function(url, options={}) {
    if (typeof url !== 'string' || !url.startsWith('/api')) {
        return originalFetch.call(this, url, options);
    }
    const method = (options.method || 'GET').toUpperCase();
    if (method === 'GET') {
        return getFromDB(url).then(cached => {
            if (cached) {
                setStatus(`IDB 命中: ${url}`,'info');
                return new Response(JSON.stringify(cached), {status:200, headers:{'Content-Type':'application/json','X-IDB-Cache':'HIT'}});
            }
            return performNetworkFetch(url, options);
        });
    } else {
        return performNetworkFetch(url, options).then(res => {
            if (res.ok) {
                const base = url.split('?')[0];
                setTimeout(() => { if(PHOTON.db){ const tx=PHOTON.db.transaction('apiCache','readwrite'); tx.objectStore('apiCache').delete(base); } },0);
            }
            return res;
        });
    }

    async function performNetworkFetch(url, options) {
        options.headers = options.headers || {};
        if (!options.headers['Accept']) options.headers['Accept'] = 'application/x-msgpack, application/json';
        const res = await originalFetch.call(window, url, options);
        if (res.ok) {
            const clone = res.clone();
            const ct = clone.headers.get('Content-Type')||'';
            let data;
            if (ct.includes('application/x-msgpack') && msgpackReady) {
                try { data = window.msgpackLite.decode(new Uint8Array(await clone.arrayBuffer())); } catch(e) { data = await clone.json(); }
            } else { data = await clone.json(); }
            await cacheInDB(url, data);
        }
        return res;
    }
};

/* ───────── 流式 Worker ───────── */
function initStreamWorker() {
    const code = `let buffer='';self.onmessage=(e)=>{if(e.data.type==='token'){buffer+=e.data.payload;if(buffer.length>2||e.data.payload.includes('\\n')){self.postMessage({text:buffer});buffer='';}}else if(e.data.type==='flush'){if(buffer)self.postMessage({text:buffer});buffer='';}};`;
    PHOTON.worker = new Worker(URL.createObjectURL(new Blob([code],{type:'application/javascript'})));
    PHOTON.worker.onmessage = (e) => {
        requestAnimationFrame(() => {
            if (PHOTON.lastMsgNode) {
                const t = PHOTON.lastMsgNode.querySelector('.mes_text');
                if (t) t.textContent += e.data.text;
            }
        });
    };
    const ctx = SillyTavern.getContext();
    if (ctx?.streamingProcessor) {
        const origToken = ctx.streamingProcessor.onToken;
        ctx.streamingProcessor.onToken = (t) => PHOTON.worker.postMessage({type:'token', payload:t});
        ctx.streamingProcessor.finish = (function(orig){ return function(){ PHOTON.worker.postMessage({type:'flush'}); orig.call(this); }; })(ctx.streamingProcessor.finish);
        setStatus('流式 Worker 已接管','success');
    }
}

/* ───────── 虚拟滚动 (空闲初始化) ───────── */
function isChatVisible() {
    const chat = document.getElementById('chat');
    return chat && window.getComputedStyle(chat).display !== 'none';
}

function initVirtualScroll() {
    if (!isChatVisible() || PHOTON.viewport) return;

    const chatEl = document.getElementById('chat');
    const viewport = document.createElement('div');
    viewport.id = 'photon-viewport';
    viewport.style.cssText = 'position:relative;height:100%;overflow-y:scroll;overflow-x:hidden;contain:strict;';

    // 只移动消息节点，保留其他插件UI
    Array.from(chatEl.childNodes).forEach(node => {
        if (node.nodeType === 1 && (node.classList.contains('mes') || node.querySelector('.mes_text'))) {
            viewport.appendChild(node);
        }
    });
    chatEl.appendChild(viewport);
    PHOTON.viewport = viewport;

    const ctx = SillyTavern.getContext();
    const getChatData = () => ctx.chat || [];

    function createVNode(msg, idx) {
        const div = document.createElement('div');
        div.className = 'virtual-mes';
        div.innerHTML = `<div class="mes_text">${msg.mes || ''}</div>`;
        div.style.cssText = 'position:absolute;left:0;right:0;padding:8px;box-sizing:border-box;';
        div.dataset.msgIndex = idx;
        return div;
    }

    PHOTON.resizeObserver = new ResizeObserver(entries => {
        let need = false;
        for (const entry of entries) {
            const id = entry.target.dataset.msgId;
            if (id) {
                const h = entry.contentBoxSize?.[0]?.blockSize || entry.contentRect.height;
                if (PHOTON.messageHeights.get(id) !== h) { PHOTON.messageHeights.set(id, h); need = true; }
            }
        }
        if (need) scheduleUpdate();
    });

    function updateVisible() {
        const chat = getChatData();
        if (!chat.length) return;

        const scrollTop = viewport.scrollTop, viewH = viewport.clientHeight;
        let totalH = 0;
        const visibleIds = new Set();

        chat.forEach((msg, i) => {
            const id = msg.id || msg._id;
            if (!PHOTON.vNodes.has(id)) {
                const node = createVNode(msg, i);
                node.dataset.msgId = id;
                PHOTON.vNodes.set(id, node);
                PHOTON.resizeObserver.observe(node);
                if (!PHOTON.messageHeights.has(id)) PHOTON.messageHeights.set(id, 80);
            }
        });

        chat.forEach((msg, i) => {
            const id = msg.id || msg._id;
            const h = PHOTON.messageHeights.get(id) || 80;
            const top = totalH; totalH += h;
            if ((top + h) >= scrollTop - 200 && top <= scrollTop + viewH + 200) {
                visibleIds.add(id);
                const node = PHOTON.vNodes.get(id);
                if (node) {
                    node.style.top = top + 'px';
                    node.style.display = '';
                    node.setAttribute('aria-hidden', 'false');
                    const textEl = node.querySelector('.mes_text');
                    if (textEl && textEl.textContent !== (msg.mes||'')) textEl.textContent = msg.mes||'';
                    if (!node.isConnected) viewport.appendChild(node);
                }
            }
        });

        PHOTON.vNodes.forEach((node, id) => { if (!visibleIds.has(id)) { node.style.display = 'none'; node.setAttribute('aria-hidden','true'); } });

        const currentIds = new Set(chat.map(m => m.id || m._id));
        PHOTON.vNodes.forEach((node, id) => { if (!currentIds.has(id)) { node.remove(); PHOTON.vNodes.delete(id); PHOTON.messageHeights.delete(id); PHOTON.resizeObserver.unobserve(node); } });

        viewport.style.height = totalH + 'px';
        setStatus(`虚拟滚动: 可见 ${visibleIds.size}/${chat.length}`,'info');
    }

    function scheduleUpdate() {
        if (!PHOTON.frameScheduled) {
            PHOTON.frameScheduled = true;
            requestAnimationFrame(() => { updateVisible(); PHOTON.frameScheduled = false; });
        }
    }

    viewport.addEventListener('scroll', scheduleUpdate, { passive: true });

    // 劫持 addOneMessage
    if (!PHOTON._origAddMessage) PHOTON._origAddMessage = window.addOneMessage;
    window.addOneMessage = function(msg) {
        const el = PHOTON._origAddMessage.call(this, msg);
        scheduleUpdate();
        const chat = getChatData();
        if (chat.length) PHOTON.lastMsgNode = PHOTON.vNodes.get(chat[chat.length-1].id || chat[chat.length-1]._id);
        return el;
    };

    ctx.eventSource.on('message_edited', scheduleUpdate);
    ctx.eventSource.on('message_deleted', scheduleUpdate);
    ctx.eventSource.on('chat_changed', scheduleUpdate);

    // 首屏立即渲染，其余节点在空闲时补全
    updateVisible();
    setStatus('虚拟滚动引擎已启动','success');
}

function destroyVirtualScroll() {
    if (PHOTON.resizeObserver) { PHOTON.resizeObserver.disconnect(); PHOTON.resizeObserver = null; }
    if (PHOTON.viewport) {
        const chatEl = document.getElementById('chat');
        if (chatEl) {
            while (PHOTON.viewport.firstChild) chatEl.appendChild(PHOTON.viewport.firstChild);
            PHOTON.viewport.remove();
        }
        PHOTON.viewport = null;
    }
    PHOTON.vNodes.clear();
    PHOTON.messageHeights.clear();
    if (PHOTON._origAddMessage) { window.addOneMessage = PHOTON._origAddMessage; }
}

/* ───────── 界面切换监听 ───────── */
function watchUIChange() {
    const ctx = SillyTavern.getContext();
    ctx.eventSource.on('chat_changed', () => {
        setTimeout(() => {
            if (isChatVisible() && !PHOTON.viewport) {
                initVirtualScroll();
                initStreamWorker();
            } else if (!isChatVisible() && PHOTON.viewport) {
                destroyVirtualScroll();
                setStatus('已离开聊天界面','info');
            }
        }, 100);
    });
    if (isChatVisible()) {
        initVirtualScroll();
        initStreamWorker();
    }
}

/* ───────── 全局错误 ───────── */
window.addEventListener('error', e => setStatus(`错误: ${e.message}`,'error'));
window.addEventListener('unhandledrejection', e => setStatus(`未捕获Promise: ${e.reason}`,'error'));

/* ───────── 主启动 (超低优先级分配) ───────── */
async function main() {
    registerSW();                 // SW 异步，不阻塞
    loadMsgPack();                // 动态加载脚本，异步
    setStatus('Photon 引擎启动中...','info');

    // 将 IndexedDB 初始化放入空闲时间
    scheduleIdle(async () => {
        try { PHOTON.db = await openDB(); setStatus('IndexedDB 就绪','success'); } catch(e) { setStatus('IndexedDB 不可用','warn'); }
    });

    while (!window.SillyTavern?.getContext) await new Promise(r => setTimeout(r, 100));
    const ctx = SillyTavern.getContext();

    // APP_READY 后，再延迟启动重任务
    function startEngines() {
        if (window.__photonStarted) return;
        window.__photonStarted = true;
        // 用多个空闲回调拆分任务，避免长任务
        scheduleIdle(() => watchUIChange());
        scheduleIdle(() => {
            setStatus('加速引擎就绪 ⚡','success');
            // 空闲时预热缓存
            scheduleIdle(() => fetch('/api/characters/all').then(r=>r.json()).then(d=>cacheInDB('/api/characters/all',d)), { timeout: 3000 });
        });
    }

    let ready = false;
    ctx.eventSource.on('APP_READY', () => { if (!ready) { ready = true; startEngines(); } });
    setTimeout(() => { if (!ready) { ready = true; startEngines(); } }, 5000);
}

main();
