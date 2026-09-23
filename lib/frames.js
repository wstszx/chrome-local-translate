/**
 * lib/frames.js —— 多 frame 场景下的「该听谁的」判定（纯函数，不碰 chrome.*）
 *
 * 背景：一个标签页里可能有几十个 frame（弹窗、客服挂件、广告位…），而
 * `chrome.tabs.sendMessage(tabId, msg)` 不带 frameId 时是**广播**给所有 frame，
 * 但 Promise 只会被**第一个**应答的 frame 兑现，其它 frame 的回答会被丢掉。
 *
 * 而 `document.hasFocus()` 在 Chrome 里对「焦点所在 frame 的所有祖先」都是 true，
 * 所以焦点在弹窗 iframe 里时，顶层 frame 也会说自己有焦点 —— 它会抢答
 * 「当前没有聚焦的输入框」，而真正拿得到文本的那个子 frame 的正确答案被丢弃。
 * 这就是「快捷键/转写捕获不到已经输入的内容」的根因。
 *
 * 解法有两层：
 *   1) 内容脚本一边打字一边「认领」（lt:editor-claim），后台记下
 *      `tabId → frameId`，下次直接把指令发给那一个 frame（不需要广播）；
 *   2) 没有认领时（或认领的 frame 已经不认账）才去问所有 frame，
 *      并把**所有**回答收齐后挑一个最好的，而不是听第一个。
 *
 * 这里只放判定用的纯函数，方便单测。
 */

/** 认领的有效期：超过这个时间没用过就当作过期（用户可能已经换到了别的 frame） */
export const CLAIM_TTL = 30_000;

/** 一个 frame 的「应答权重」：越大越可能是用户真正在打字的那个 frame */
export function scoreResponse(entry) {
  if (!entry) return -Infinity;
  const res = entry.res || {};
  const info = res.info || res;
  let score = 0;

  // 能真正干活的（ok:true）压倒一切
  if (res.ok === true) score += 1000;
  if (res.canWrite) score += 150; // 明确说自己能写（探路阶段的候选）
  if (res.handled && !res.ok) score += 50; // 认了这件事，但确实没有输入框

  // 有活着的编辑目标 ⇒ 很可能就是它
  if (info.hasTarget) score += 300;
  // 自己报告有焦点（可能是真的，也可能只是祖先 frame）
  if (info.hasFocus) score += 100;
  // 顶层 frame 只有在别的 frame 都没有目标时才有意义（它是祖先，容易误判有焦点）
  if (entry.frameId === 0) score -= 20;
  // 读到了字符 ⇒ 用户确实在这里打了字
  if (typeof info.chars === 'number' && info.chars > 0) score += 20;
  // 最近有过编辑活动（认领时间）
  if (typeof info.lastActivity === 'number') {
    score += Math.max(0, 20 - Math.floor((Date.now() - info.lastActivity) / 1000));
  }
  return score;
}

/** 从所有 frame 的回答里挑最好的一个；都没干活就返回 null */
export function pickBestResponse(entries) {
  let best = null;
  let bestScore = -Infinity;
  for (const entry of entries || []) {
    if (!entry || !entry.res) continue;
    const score = scoreResponse(entry);
    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }
  if (!best) return null;
  // 全都不 ok 时返回最好的那个（让调用方能拿到错误信息）
  return best;
}

/** 认领是否还能用 */
export function isClaimUsable(claim, now = Date.now()) {
  if (!claim || typeof claim.frameId !== 'number') return false;
  if (typeof claim.at !== 'number') return false;
  return now - claim.at <= CLAIM_TTL && claim.at <= now + 5000;
}

/**
 * 汇总多 frame 的自检结果（侧边栏「自检当前输入框」用）
 * entries: [{frameId, res}]（res 为 lt:inline-status 的回答）
 */
export function summarizeFrames(entries) {
  return (entries || [])
    .filter((e) => e && e.res)
    .map((e) => {
      const info = e.res.info || e.res;
      return {
        frameId: e.frameId,
        ok: !!e.res.ok,
        top: !!info.isTop,
        hasFocus: !!info.hasFocus,
        hasTarget: !!info.hasTarget,
        kind: info.kind || null,
        tag: info.tag || null,
        chars: typeof info.chars === 'number' ? info.chars : null,
        url: info.url || e.res.url || '',
        enabled: info.enabled !== false,
        mode: info.mode || null,
      };
    })
    .sort((a, b) => (a.frameId === 0 ? -1 : b.frameId === 0 ? 1 : a.frameId - b.frameId));
}
