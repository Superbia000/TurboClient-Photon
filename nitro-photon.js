/**
 * TurboClient-Photon v4.0.4: 终极客户端加速引擎 (修正 WeakMap 错误)
 * 
 * 功能:
 *   1. Service Worker 离线缓存 + 预取
 *   2. IndexedDB 本地 API 缓存 (带 TTL)
 *   3. MessagePack 二进制解码 (自动回退 JSON)
 *   4. 流式响应 Worker 处理 (主线程无阻塞)
 *   5. 完全虚拟滚动 (ResizeObserver 动态高度)
 *   6. 事件监听自动回收 (防止内存泄漏)
 *   7. 预测预取 (hover 角色时预加载)
 *   8. 图片预加载 (link rel=preload)
 *   9. 全局错误捕获 + 右下角状态栏
 * 
 * 修正: 事件回收模块增加 this 类型检查，避免 WeakMap 键无效导致崩溃
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
};

/* ───────── 状态提示 UI ───────── */
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

/* ───────── Service Worker 注册 ───────── */
function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) {
        setStatus('Service Worker 不支持，离线缓存关闭', 'warn');
        return;
    }
    navigator.serviceWorker.register('/scripts/extensions/third-party/TurboClient-Photon/sw-photon.js')
        .then(reg => setStatus('Service Worker 已注册', 'success'))
        .catch(err => setStatus(`SW 注册失败: ${err.message}`, 'error'));
}

/* ───────── IndexedDB (带 TTL) ───────── */
const DB_NAME = 'PhotonCache';
const DB_VERSION = 1;
const CACHE_TTL = 5 * 60 * 1000; // 5 分钟

function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains('apiCache')) {
                db.createObjectStore('apiCache', { keyPath: 'url' });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}
async function cacheInDB(url, data) {
    if (!PHOTON.db) return;
    try {
        const tx = PHOTON.db.transaction('apiCache', 'readwrite');
        tx.objectStore('apiCache').put({ url, data, timestamp: Date.now() });
        await tx.done;
    } catch(e) {}
}
async function getFromDB(url) {
    if (!PHOTON.db) return null;
    try {
        const tx = PHOTON.db.transaction('apiCache', 'readonly');
        const result = await tx.objectStore('apiCache').get(url);
        if (result && (Date.now() - result.timestamp) < CACHE_TTL) {
            return result.data;
        }
        return null;
    } catch(e) { return null; }
}

/* ───────── MessagePack 安全解码 ───────── */
let msgpackReady = false;
function loadMsgPack() {
    if (window.msgpackLite) { msgpackReady = true; setStatus('MsgPack 库就绪', 'success'); return; }
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/msgpack-lite@0.1.26/dist/msgpack.min.js';
    script.onload = () => { msgpackReady = true; setStatus('MsgPack 动态加载成功', 'success'); };
    script.onerror = () => setStatus('MsgPack 加载失败，使用 JSON', 'warn');
    document.head.appendChild(script);
}
async function safeDecodeMsgPack(response) {
    const ct = response.headers.get('Content-Type') || '';
    if (!msgpackReady || !ct.includes('application/x-msgpack')) return response.json();
    const clone = response.clone();
    try {
        const buf = await clone.arrayBuffer();
        const data = window.msgpackLite.decode(new Uint8Array(buf));
        setStatus('MsgPack 解压成功', 'info');
        return data;
    } catch(e) {
        setStatus(`MsgPack 解码失败: ${e.message}，回退 JSON`, 'error');
        return response.json();
    }
}

/* ───────── fetch 劫持 (IDB 缓存 + MsgPack) ───────── */
const originalFetch = window.fetch;
window.fetch = function(url, options = {}) {
    if (typeof url === 'string' && url.startsWith('/api')) {
        const method = (options.method || 'GET').toUpperCase();
        if (method === 'GET') {
            return getFromDB(url).then(cached => {
                if (cached) {
                    setStatus(`IDB 命中: ${url}`, 'info');
                    return new Response(JSON.stringify(cached), {
                        status: 200,
                        headers: { 'Content-Type': 'application/json', 'X-IDB-Cache': 'HIT' }
                    });
                }
                return performNetworkFetch(url, options);
            });
        } else {
            return performNetworkFetch(url, options).then(res => {
                if (res.ok) {
                    const baseKey = url.split('?')[0];
                    setTimeout(() => {
                        if (PHOTON.db) {
                            const tx = PHOTON.db.transaction('apiCache', 'readwrite');
                            tx.objectStore('apiCache').delete(baseKey);
                        }
                    }, 0);
                }
                return res;
            });
        }
    }
    return originalFetch.call(this, url, options);

    async function performNetworkFetch(url, options) {
        options.headers = options.headers || {};
        if (!options.headers['Accept']) options.headers['Accept'] = 'application/x-msgpack, application/json';
        const res = await originalFetch.call(window, url, options);
        if (res.ok) {
            const clone = res.clone();
            const ct = clone.headers.get('Content-Type') || '';
            let data;
            if (ct.includes('application/x-msgpack') && msgpackReady) {
                try {
                    data = window.msgpackLite.decode(new Uint8Array(await clone.arrayBuffer()));
                } catch(e) { data = await clone.json(); }
            } else {
                data = await clone.json();
            }
            await cacheInDB(url, data);
        }
        return res;
    }
};

/* ───────── 流式 Worker ───────── */
function initStreamWorker() {
    const code = `
        let buffer = '';
        self.onmessage = (e) => {
            if (e.data.type === 'token') {
                buffer += e.data.payload;
                if (buffer.length > 2 || e.data.payload.includes('\\n')) {
                    self.postMessage({ text: buffer });
                    buffer = '';
                }
            } else if (e.data.type === 'flush') {
                if (buffer) self.postMessage({ text: buffer });
                buffer = '';
            }
        };
    `;
    const blob = new Blob([code], { type: 'application/javascript' });
    PHOTON.worker = new Worker(URL.createObjectURL(blob));
    PHOTON.worker.onmessage = (e) => {
        requestAnimationFrame(() => {
            if (PHOTON.lastMsgNode) {
                const textEl = PHOTON.lastMsgNode.querySelector('.mes_text');
                if (textEl) textEl.textContent += e.data.text;
            }
        });
    };
    const ctx = SillyTavern.getContext();
    if (ctx?.streamingProcessor) {
        const origToken = ctx.streamingProcessor.onToken;
        ctx.streamingProcessor.onToken = (t) => PHOTON.worker.postMessage({ type:'token', payload: t });
        ctx.streamingProcessor.finish = (function(orig) {
            return function() { PHOTON.worker.postMessage({ type:'flush' }); orig.call(this); };
        })(ctx.streamingProcessor.finish);
        setStatus('流式 Worker 已接管', 'success');
    }
}

/* ───────── 虚拟滚动 (动态高度) ───────── */
function initVirtualScroll() {
    const chatEl = document.getElementById('chat');
    if (!chatEl) return setTimeout(initVirtualScroll, 200);
    const viewport = document.createElement('div');
    viewport.id = 'photon-viewport';
    viewport.style.cssText = 'position:relative;height:100%;overflow-y:scroll;overflow-x:hidden;contain:strict;';
    while (chatEl.firstChild) viewport.appendChild(chatEl.firstChild);
    chatEl.appendChild(viewport);
    PHOTON.viewport = viewport;
    const ctx = SillyTavern.getContext();
    const getChatData = () => ctx.chat || [];

    function createVNode(msg, idx) {
        const div = document.createElement('div');
        div.className = 'mes virtual-mes';
        div.innerHTML = `<div class="mes_text">${msg.mes || ''}</div>`;
        div.style.position = 'absolute';
        div.style.width = '100%';
        div.dataset.msgIndex = idx;
        return div;
    }

    PHOTON.resizeObserver = new ResizeObserver(entries => {
        let needUpdate = false;
        for (const entry of entries) {
            const node = entry.target;
            const id = node.dataset.msgId;
            if (id) {
                const newHeight = entry.contentBoxSize?.[0]?.blockSize || entry.contentRect.height;
                if (PHOTON.messageHeights.get(id) !== newHeight) {
                    PHOTON.messageHeights.set(id, newHeight);
                    needUpdate = true;
                }
            }
        }
        if (needUpdate) scheduleUpdate();
    });

    function updateVisible() {
        const chat = getChatData();
        const scrollTop = viewport.scrollTop;
        const viewH = viewport.clientHeight;
        let totalHeight = 0;
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
            const top = totalHeight;
            totalHeight += h;
            const bottom = top + h;
            if (bottom >= scrollTop - 200 && top <= scrollTop + viewH + 200) {
                visibleIds.add(id);
                const node = PHOTON.vNodes.get(id);
                if (node) {
                    node.style.top = top + 'px';
                    node.style.display = '';
                    node.setAttribute('aria-hidden', 'false');
                    const textEl = node.querySelector('.mes_text');
                    if (textEl && textEl.textContent !== (msg.mes || '')) textEl.textContent = msg.mes || '';
                    if (!node.isConnected) viewport.appendChild(node);
                }
            }
        });

        PHOTON.vNodes.forEach((node, id) => {
            if (!visibleIds.has(id)) {
                node.style.display = 'none';
                node.setAttribute('aria-hidden', 'true');
            }
        });

        const currentIds = new Set(chat.map(m => m.id || m._id));
        PHOTON.vNodes.forEach((node, id) => {
            if (!currentIds.has(id)) {
                node.remove();
                PHOTON.vNodes.delete(id);
                PHOTON.messageHeights.delete(id);
                PHOTON.resizeObserver.unobserve(node);
            }
        });

        viewport.style.height = totalHeight + 'px';
        setStatus(`虚拟滚动: 可见 ${visibleIds.size}/${chat.length}`, 'info');
    }

    function scheduleUpdate() {
        if (!PHOTON.frameScheduled) {
            PHOTON.frameScheduled = true;
            requestAnimationFrame(() => {
                updateVisible();
                PHOTON.frameScheduled = false;
            });
        }
    }

    viewport.addEventListener('scroll', scheduleUpdate, { passive: true });

    window.addOneMessage = function(msg) {
        const el = (window._originalAddOneMessage || window.addOneMessage).call(this, msg);
        scheduleUpdate();
        const chat = getChatData();
        if (chat.length) {
            const lastMsg = chat[chat.length-1];
            PHOTON.lastMsgNode = PHOTON.vNodes.get(lastMsg.id || lastMsg._id);
        }
        return el;
    };
    if (!window._originalAddOneMessage) window._originalAddOneMessage = window.addOneMessage;

    ctx.eventSource.on('message_edited', scheduleUpdate);
    ctx.eventSource.on('message_deleted', scheduleUpdate);
    ctx.eventSource.on('chat_changed', scheduleUpdate);
    updateVisible();
    setStatus('虚拟滚动引擎 (动态高度) 已启动', 'success');
}

/* ───────── 事件自动回收 (修正 WeakMap 错误) ───────── */
function initEventCleaner() {
    const reg = new WeakMap();
    const origAdd = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function(type, fn, opts) {
        // 修复：仅当 this 是合法对象时才记录，否则直接调用原方法
        if (this && typeof this === 'object') {
            if (!reg.has(this)) reg.set(this, []);
            reg.get(this).push({ type, fn, opts });
        }
        return origAdd.call(this, type, fn, opts);
    };
    new MutationObserver(muts => {
        muts.forEach(m => m.removedNodes.forEach(node => {
            if (node instanceof Element && reg.has(node)) {
                reg.get(node).forEach(l => {
                    try { node.removeEventListener(l.type, l.fn, l.opts); } catch(e) {}
                });
                reg.delete(node);
            }
        }));
    }).observe(document.body, { childList: true, subtree: true });
    setStatus('事件自动回收已激活', 'success');
}

/* ───────── 预取 & 预加载 ───────── */
function initPrefetchAndLazy() {
    document.addEventListener('mouseover', ((fn, limit) => {
        let ready = true;
        return (e) => {
            if (ready && e.target.closest('[data-character-id]') && navigator.serviceWorker.controller) {
                navigator.serviceWorker.controller.postMessage('PREFETCH_CHARACTERS');
                ready = false;
                setTimeout(() => ready = true, limit);
            }
        };
    })(undefined, 200));
    ['/img/logo.png'].forEach(src => {
        const link = document.createElement('link');
        link.rel = 'preload'; link.as = 'image'; link.href = src;
        document.head.appendChild(link);
    });
    setStatus('预取与预加载就绪', 'success');
}

/* ───────── 全局错误处理 ───────── */
window.addEventListener('error', e => setStatus(`错误: ${e.message}`, 'error'));
window.addEventListener('unhandledrejection', e => setStatus(`未捕获Promise: ${e.reason}`, 'error'));

/* ───────── 引擎总启动 ───────── */
function startAllEngines() {
    if (window.__photonEnginesStarted) return;
    window.__photonEnginesStarted = true;
    initVirtualScroll();
    initStreamWorker();
    initEventCleaner();
    initPrefetchAndLazy();
    setStatus('全速运行 ⚡', 'success');
    if ('requestIdleCallback' in window) {
        requestIdleCallback(() => {
            fetch('/api/characters/all').then(r => r.json()).then(d => cacheInDB('/api/characters/all', d));
        }, { timeout: 2000 });
    }
}

async function main() {
    registerServiceWorker();
    loadMsgPack();
    setStatus('Photon 引擎启动中...', 'info');
    try {
        PHOTON.db = await openDB();
        setStatus('IndexedDB 就绪', 'success');
    } catch(e) { setStatus('IndexedDB 不可用，跳过本地缓存', 'warn'); }

    while (!window.SillyTavern?.getContext) await new Promise(r => setTimeout(r, 100));
    const ctx = SillyTavern.getContext();
    let ready = false;
    ctx.eventSource.on('APP_READY', () => { if (!ready) { ready = true; startAllEngines(); } });
    setTimeout(() => { if (!ready) { ready = true; startAllEngines(); } }, 5000);
}

main();
