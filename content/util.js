/**
 * content/util.js —— 内容脚本用的纯工具函数（无依赖、无 chrome.* 调用）
 *
 * 为什么这里的语言函数和 lib/languages.js 有重复？
 * 因为 manifest 声明的内容脚本必须是普通脚本（Chrome 尚不支持 ESM 内容脚本），
 * 所以这里只保留页面侧真正需要的一小部分：语言代码归一化、语言名、方向、
 * 文本过滤、站点匹配。翻译与语言检测全部走 background（Service Worker）。
 */
(function () {
  const NS = (globalThis.__LOCAL_TRANSLATE__ = globalThis.__LOCAL_TRANSLATE__ || {});

  /**
   * 页内弹窗（划词气泡 / 转写面板）共享的设计令牌。
   * 暗玻璃风格：近黑底 + 白字 + 蓝紫强调，类似 macOS 暗色控件。
   * 改这里 = 全应用弹窗换肤。
   */
  NS.designTokens = `
    :host {
      --lt-bg: rgba(24, 24, 27, 0.92);
      --lt-bg-soft: rgba(39, 39, 42, 0.85);
      --lt-fg: #ffffff;
      --lt-fg-muted: rgba(255, 255, 255, 0.6);
      --lt-border: rgba(255, 255, 255, 0.12);
      --lt-accent: #818cf8;
      --lt-accent-soft: rgba(129, 140, 248, 0.15);
      --lt-accent-fg: #ffffff;
      --lt-grad: linear-gradient(135deg, #6366f1 0%, #8b5cf6 60%, #a855f7 100%);
      --lt-grad-soft: rgba(99, 102, 241, 0.18);
      --lt-ok: #34d399;
      --lt-warn: #fbbf24;
      --lt-err: #f87171;
      --lt-radius: 12px;
      --lt-radius-sm: 8px;
      --lt-shadow: 0 8px 32px rgba(0, 0, 0, 0.5), 0 1px 0 rgba(255, 255, 255, 0.06) inset;
      --lt-blur: blur(20px) saturate(1.6);
    }
  `;

  const ZH_NAMES = {
    zh: '中文（简体）', 'zh-Hant': '中文（繁體）', en: '英语', ja: '日语', ko: '韩语', fr: '法语', de: '德语',
    es: '西班牙语', pt: '葡萄牙语', it: '意大利语', ru: '俄语', uk: '乌克兰语', nl: '荷兰语', pl: '波兰语',
    cs: '捷克语', sk: '斯洛伐克语', sl: '斯洛文尼亚语', hr: '克罗地亚语', bg: '保加利亚语', ro: '罗马尼亚语',
    hu: '匈牙利语', el: '希腊语', da: '丹麦语', sv: '瑞典语', no: '挪威语', fi: '芬兰语', lt: '立陶宛语',
    tr: '土耳其语', ar: '阿拉伯语', he: '希伯来语', hi: '印地语', bn: '孟加拉语', ta: '泰米尔语',
    te: '泰卢固语', th: '泰语', vi: '越南语', id: '印尼语',
  };

  const ALIASES = {
    'zh-cn': 'zh', 'zh-sg': 'zh', 'zh-hans': 'zh', 'zh-tw': 'zh-Hant', 'zh-hk': 'zh-Hant', 'zh-mo': 'zh-Hant',
    iw: 'he', nb: 'no', nn: 'no', in: 'id', 'pt-br': 'pt', 'pt-pt': 'pt', 'en-us': 'en', 'en-gb': 'en',
    'en-ca': 'en', 'en-au': 'en', 'fr-ca': 'fr', 'fr-fr': 'fr', 'es-419': 'es', 'es-mx': 'es',
  };

  function normalizeCode(tag) {
    if (!tag || typeof tag !== 'string') return '';
    const raw = tag.trim().replace(/_/g, '-');
    const lower = raw.toLowerCase();
    if (ZH_NAMES[lower]) return lower === 'zh-hant' ? 'zh-Hant' : lower;
    if (ALIASES[lower]) return ALIASES[lower];
    const primary = lower.split('-')[0];
    if (ZH_NAMES[primary]) return primary;
    if (ALIASES[primary]) return ALIASES[primary];
    if (primary === 'zh') return /hant|tw|hk|mo/.test(lower) ? 'zh-Hant' : 'zh';
    return primary;
  }

  function langLabel(code) {
    if (!code || code === 'auto') return '自动检测';
    const n = normalizeCode(code);
    return ZH_NAMES[n] || ZH_NAMES[n.toLowerCase()] || n;
  }

  const RTL = new Set(['ar', 'he', 'fa', 'ur']);
  const isRtl = (code) => RTL.has(normalizeCode(code));

  const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
  function isCJKHeavy(text) {
    const s = String(text || '').slice(0, 300);
    if (!s) return false;
    const hits = s.match(new RegExp(CJK.source, 'g'));
    return !!hits && hits.length / s.length > 0.25;
  }

  function needsSpace(left, right) {
    if (!left || !right) return false;
    const a = left.slice(-1);
    const b = right.slice(0, 1);
    if (CJK.test(a) || CJK.test(b)) return false;
    return /[\p{L}\p{N}]/u.test(a) && /[\p{L}\p{N}]/u.test(b);
  }

  const HAS_LETTER = /[\p{L}]/u;
  /** 页面里值得翻译的文本：有字母、不是纯数字/URL/邮箱/文件名 */
  function looksTranslatable(input) {
    const s = String(input || '').trim();
    if (s.length < 2) return false;
    if (!HAS_LETTER.test(s)) return false;
    if (/^(https?:\/\/|www\.)\S+$/i.test(s)) return false;
    if (/^[\w.+-]+@[\w-]+\.[\w.]+$/.test(s)) return false;
    if (/^[\d\s.,:;%$€¥+\-/()|]+$/.test(s)) return false;
    if (/^(?:[\w-]+\.)+[a-z]{2,}(?:\/\S*)?$/i.test(s)) return false;
    if (/^[\w-]+\.(?:js|jsx|ts|tsx|css|json|png|jpe?g|gif|svg|webp|mp4|pdf|zip|exe|dmg)$/i.test(s)) return false;
    return true;
  }

  /** 快速脚本级粗判：用于页面自动翻译的「要不要动手」判断，不算正式识别 */
  function roughScript(text) {
    const s = String(text || '').slice(0, 800);
    if (/[\u3040-\u30ff]/.test(s)) return 'ja';
    if (/[\uac00-\ud7af]/.test(s)) return 'ko';
    if (/[\u4e00-\u9fff]/.test(s)) return /[們這說時體國學語為妳裡麼]/.test(s) ? 'zh-Hant' : 'zh';
    if (/[\u0400-\u04ff]/.test(s)) return /[іїєґ]/i.test(s) ? 'uk' : 'ru';
    if (/[\u0600-\u06ff]/.test(s)) return 'ar';
    if (/[\u0e00-\u0e7f]/.test(s)) return 'th';
    if (/[\u0590-\u05ff]/.test(s)) return 'he';
    if (/[\u0900-\u097f]/.test(s)) return 'hi';
    return '';
  }

  /**
   * 这段文本是不是「已经是目标语言」（评审 A6）：混合语言页面里，中文页面夹的英文引用
   * 反过来、外语页里夹的中文评论等，逐段用脚本粗判一次，同脚本的直接跳过 ——
   * 既省算力又不产生「把中文再翻一遍」的噪音。判定不了（返回空）时保守地翻。
   */
  function isSameLang(text, targetLang) {
    const t = String(text || '').trim();
    if (!t || !targetLang) return false;
    const norm = normalizeCode(targetLang);
    if (!norm) return false;
    // 拉丁字母系目标语言（en/fr/de/es/…）没有可靠的廉价判定：罗马字化文本和英文
    // 单词难以区分，误跳过的代价（该翻的没翻）比多翻一段高 → 保守地翻。
    const script = roughScript(t);
    // 判定不了（拉丁字母系或空）→ 保守地翻：罗马字化文本和英文难以区分，
    // 误跳过的代价（该翻的没翻）比多翻一段高。
    if (!script) return false;
    const p = (x) => String(x || '').toLowerCase().split('-')[0];
    // 中文简繁：粗判分不出用户想要的简/繁时，同脚本（zh）即视为相同，避免漏翻
    return p(script) === p(norm) || (p(script) === 'zh' && p(norm) === 'zh');
  }

  const hostOf = (url) => {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch (err) {
      return '';
    }
  };

  /** 域名白/黑名单匹配：'example.com' 命中 'a.example.com' 与 'example.com' */
  function matchSite(host, list) {
    if (!host || !Array.isArray(list)) return false;
    return list.some((raw) => {
      const item = String(raw || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
      if (!item) return false;
      return host === item || host.endsWith(`.${item}`);
    });
  }

  function debounce(fn, ms) {
    let t = null;
    return (...args) => {
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        t = null;
        fn(...args);
      }, ms);
    };
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * 把矩形钳制在视口内（拖动气泡、恢复上次位置时用）
   * @param {{left:number, top:number, width:number, height:number,
   *          viewportWidth:number, viewportHeight:number, margin?:number}} box
   * @returns {{left:number, top:number}}
   */
  function clampToViewport({ left, top, width, height, viewportWidth, viewportHeight, margin = 8 }) {
    const maxLeft = Math.max(margin, viewportWidth - width - margin);
    const maxTop = Math.max(margin, viewportHeight - height - margin);
    const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
    return {
      left: Math.round(clamp(Number(left) || 0, margin, maxLeft)),
      top: Math.round(clamp(Number(top) || 0, margin, maxTop)),
    };
  }

  /**
   * 视口优先排序（评审 B1）：整页翻译不再按 DOM 顺序「从头翻到尾」，而是先翻
   * 用户眼前的段落 —— 长页面 1 秒内就能看到正文译文，而不是等全页跑完。
   *
   * 纯函数便于单测：nodes 里每项取 rect.top（无布局时用 0），可见的排在最前，
   * 其余按「到视口的垂直距离」从近到远。
   * @template T
   * @param {T[]} items 每项需带 rect（{top, bottom}，可选）
   * @param {{viewportTop?: number, viewportBottom?: number}} [vp]
   * @returns {T[]} 排序后的新数组（不改原数组）
   */
  function sortByViewport(items, vp = {}) {
    const arr = Array.isArray(items) ? items : [];
    if (arr.length < 2) return arr.slice();
    const vt = Number.isFinite(vp.viewportTop) ? vp.viewportTop : 0;
    const vb = Number.isFinite(vp.viewportBottom) ? vp.viewportBottom : Number.POSITIVE_INFINITY;
    // 注意：不用 Number.isFinite（跨 vm 领域的对象会误判），用自写的有限数判定
    const isNum = (v) => typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity;
    const dist = (item) => {
      const rect = item && item.rect;
      const top = rect && isNum(rect.top) ? rect.top : Number.POSITIVE_INFINITY;
      const bottom = rect && isNum(rect.bottom) ? rect.bottom : top;
      if (!isNum(top)) return Number.POSITIVE_INFINITY - 1; // 无位置信息 → 排可见之后
      if (bottom >= vt && top <= vb) return 0; // 在视口内（含相交）
      return top >= vt ? top - vb : vt - bottom; // 视口下方/上方的最近距离
    };
    return arr
      .map((item, i) => ({ item, i, d: dist(item) }))
      .sort((a, b) => a.d - b.d || a.i - b.i)
      .map((x) => x.item);
  }

  function copyText(text) {
    return new Promise((resolve) => {
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(() => resolve(true), () => resolve(fallback()));
        return;
      }
      resolve(fallback());
      function fallback() {
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
          document.body.appendChild(ta);
          ta.select();
          const ok = document.execCommand('copy');
          ta.remove();
          return ok;
        } catch (err) {
          return false;
        }
      }
    });
  }

  function speak(text, lang) {
    try {
      if (!window.speechSynthesis) return false;
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(String(text).slice(0, 600));
      const l = normalizeCode(lang);
      u.lang = l === 'zh' ? 'zh-CN' : l === 'zh-Hant' ? 'zh-TW' : (l || 'en');
      window.speechSynthesis.speak(u);
      return true;
    } catch (err) {
      return false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* 扩展上下文健康检查                                                   */
  /* ------------------------------------------------------------------ */

  /**
   * 扩展上下文还活着吗？
   *
   * 在 chrome://extensions 里点「刷新/重新加载」，或者扩展自动更新之后，
   * **已经打开的页面**里那份内容脚本会立刻与扩展失去联系：
   * 再调 chrome.runtime.* / chrome.storage.* 就会抛
   * 「Extension context invalidated.」——而且这个脚本自己没法重新连上，
   * 只能刷新页面。所以这里主动检测，好给用户一句人话，而不是抛英文报错。
   */
  function extAlive() {
    try {
      return !!(globalThis.chrome && globalThis.chrome.runtime && globalThis.chrome.runtime.id);
    } catch (err) {
      return false;
    }
  }

  /** 这个错误是不是「扩展上下文已失效」这一类？ */
  function isContextInvalidated(err) {
    if (!err) return false;
    const msg = String((err && err.message) || err);
    return /extension context invalidated|receiving end does not exist|message port closed|the message port closed before a response/i.test(
      msg,
    );
  }

  /**
   * 这个错误是不是「扩展上下文真的没了」（页面里这份脚本没救了，只能刷新页面）？
   *
   * 关键是把两类错误分开：
   *   ① runtime.id 没了 / 「Extension context invalidated.」
   *      → 扩展被重新加载或更新过，这份脚本确实再也连不上，只能标记失效；
   *   ② 「The message port closed before a response was received.」
   *      「Could not establish connection. Receiving end does not exist.」
   *      → 在 MV3 里绝大多数是**瞬时**的：Service Worker 正在重启 / 还没应答就被
   *      Chrome 回收了。扩展上下文（runtime.id）还在，下一条消息就正常了。
   *
   * 老代码把 ② 也当成「上下文失效」→ markDead()：后台抖动一次，这个页面上的
   * 转写和翻译就**永久**停摆（必须刷新页面才恢复），表现出来就是
   * 「第一次能用、后面就不能用」。所以这里只认 ①，② 交给调用方当可重试错误处理。
   */
  function isContextGone(err) {
    if (!extAlive()) return true;
    const msg = String((err && err.message) || err);
    return /extension context invalidated/i.test(msg);
  }

  /**
   * 最后一道防线：把漏网的「扩展上下文失效」未捕获异常/拒绝拦截下来。
   *
   * 旧版 Chrome 在上下文失效后的行为并不一致：有的版本抛错、有的只给 lastError、
   * 还有的既不抛也不回 —— 逐个调用点包 try/catch 总有遗漏。这里在页面全局兜底：
   * 只要冒出来的未捕获错误是「上下文失效」类，就阻止它在控制台刷英文报错
   * （preventDefault）。返回 true 表示这个错误已被识别并拦截。
   *
   * 注意：只有上下文**真的没了**才调用 onStale 把脚本弄死；上下文还活着时
   * （瞬时的 message port closed）只静默拦下，不影响继续使用。
   */
  function installStaleGuard(onStale) {
    const handle = (reason) => {
      if (!isContextInvalidated(reason)) return false;
      if (isContextGone(reason) && typeof onStale === 'function') {
        try {
          onStale();
        } catch (err) {
          /* 忽略 */
        }
      }
      return true;
    };
    try {
      window.addEventListener('unhandledrejection', (e) => {
        if (handle(e && e.reason)) e.preventDefault();
      });
      window.addEventListener('error', (e) => {
        if (e && e.error && handle(e.error)) e.preventDefault();
      });
    } catch (err) {
      /* 极老环境没有这些事件：逐点 try/catch 已能覆盖主要路径 */
    }
    return true;
  }

  const STALE_TEXT =
    '扩展刚刚被重新加载（chrome://extensions 里的「刷新」）或更新过，这个页面上的旧脚本已经失效。刷新本页（F5）后即可继续使用。';

  NS.util = {
    extAlive,
    isContextInvalidated,
    isContextGone,
    installStaleGuard,
    staleText: () => STALE_TEXT,
    normalizeCode,
    langLabel,
    isRtl,
    isCJKHeavy,
    needsSpace,
    looksTranslatable,
    roughScript,
    isSameLang,
    hostOf,
    matchSite,
    debounce,
    sleep,
    clampToViewport,
    sortByViewport,
    copyText,
    speak,
    designTokens: NS.designTokens, // ui.js / inline.js 通过 U.designTokens 访问
  };

  /** 输入框转写面板用的语言下拉（第一项 = 跟随主目标语言） */
  NS.inlineLanguages = [
    { value: '', label: '跟随主语言' },
    ...[
      ['en', '英语'], ['zh', '中文（简体）'], ['zh-Hant', '中文（繁體）'], ['ja', '日语'], ['ko', '韩语'],
      ['fr', '法语'], ['de', '德语'], ['es', '西班牙语'], ['pt', '葡萄牙语'], ['it', '意大利语'],
      ['ru', '俄语'], ['uk', '乌克兰语'], ['nl', '荷兰语'], ['pl', '波兰语'], ['cs', '捷克语'],
      ['sk', '斯洛伐克语'], ['sl', '斯洛文尼亚语'], ['hr', '克罗地亚语'], ['bg', '保加利亚语'],
      ['ro', '罗马尼亚语'], ['hu', '匈牙利语'], ['el', '希腊语'], ['da', '丹麦语'], ['sv', '瑞典语'],
      ['no', '挪威语'], ['fi', '芬兰语'], ['lt', '立陶宛语'], ['tr', '土耳其语'], ['ar', '阿拉伯语'],
      ['he', '希伯来语'], ['hi', '印地语'], ['bn', '孟加拉语'], ['ta', '泰米尔语'], ['te', '泰卢固语'],
      ['th', '泰语'], ['vi', '越南语'], ['id', '印尼语'],
    ].map(([value, label]) => ({ value, label })),
  ];
})();
