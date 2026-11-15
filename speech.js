// speech.js — e′ 语音输出层（2026-11-02 79 新增）
//
// 唯一职责：把 `Utterance` 变成声音。
//   **它不认识战场，也不认识命令**——只认 Utterance 的五个字段：
//   `text`（念这个）、`prio`（排队位置）、`droppable`（能不能丢）、
//   `needsAnswer`（念完等答）、`maxMs`（硬上限）。
//
// 三条硬规则（ADJUTANT.md §5、§7）：
//   ① **永远说完当前一句**：新反馈不打断正在念的，只排队（不抢占）。
//      唯一的打断者是**玩家的动作**——按住说话 / 关掉语音 / 切到后台。那不是"新反馈"，不冲突。
//   ② **不许静默丢**：队列满了按 §5.4 处理，每一步都记 `dropped`。丢"士气跨档"不要紧，
//      丢"枪兵队没了"是事故——所以不可丢项一条都不许丢。
//   ③ **与 PTT 互斥**：录音期间一声不出。否则麦克风会把副将自己的话录进去，
//      识别成一条新命令，再念再录，死循环。这条是硬约束，不是优化。
//
// 依赖全部从 env 注入：浏览器驱动取 `speechSynthesis`，测试驱动是假的、
//   由测试自己控制 `fireEnd()`。所以这一层能在 node 里跑，也能在无音频设备的机器上跑。
(() => {
  'use strict';

  // ── 常量（改这两个数之前先读 ADJUTANT.md §5.3、§5.6）──────────────────
  const ANSWER_MS = 5000;        // 追问等答：5 秒。20 秒等于把战场封了音（2026-11-02 改）
  const QUEUE_CAP = 3;           // 队列上限
  const QUEUE_CAP_MAX = 5;       // 全是不可丢项时的临时扩容
  const DEFAULT_MAX_MS = 3000;   // 一句的硬上限（约 15 字）
  const HARD_MAX_MS = 6000;
  const MS_PER_CHAR = 190;       // 中文 TTS 约 5 字/秒，留 20% 余量
  const MS_BASE = 250;
  const WATCHDOG_MS = 1500;      // 驱动看门狗的余量
  const DUPE_MS = 3000;          // 同一编组同一类事 3 秒内不重复（ALERT 不受限）
  const RESUME_MS = 250;         // PTT 结束后的静默尾巴（留出回声）

  let env = {};
  let driver = null;
  let current = null;            // 正在念的条目 {u, left, startedAt}
  let queue = [];                // 待念 [{u, at}]
  let watchdog = 0;              // 看门狗定时器（Chrome 的 TTS 有挂死 bug）
  let now = 0;                   // 本层自己的钟（毫秒），由 tick 累加
  let micOn = false;             // PTT 录音中
  let off = false;               // 玩家关了语音
  let waitUntil = 0;             // 等答截止时刻（0＝不在等答）
  let resumeAt = 0;              // PTT 结束后最早的恢复时刻
  let lastSaid = new Map();      // 去重键 → 上次开口时刻
  const log = { spoken: [], dropped: [], suppressed: [], cut: [] };
  let seq = 0;

  // ── 驱动 ─────────────────────────────────────────────────────────────
  // 唯一的替换点。换后端（sherpa-onnx vits）时只实现这五个方法，逻辑层一行不动。
  function browserDriver() {
    const synth = env.speechSynthesis ||
      (typeof globalThis !== 'undefined' ? globalThis.speechSynthesis : null);
    if (!synth || typeof synth.speak !== 'function') return null;
    const U = env.UtteranceCtor ||
      (typeof globalThis !== 'undefined' ? globalThis.SpeechSynthesisUtterance : null);
    if (!U) return null;
    let voice = null;
    const pick = () => {
      let vs = [];
      try { vs = synth.getVoices() || []; } catch (_) { vs = []; }
      // 中文音色优先；一个中文都没有就用第一个——宁可音色不对，也别哑着
      voice = vs.find(v => /^zh/i.test(String(v.lang || ''))) || vs[0] || null;
      return voice;
    };
    pick();
    // Chrome 首次 getVoices() 返回空数组，靠这个事件异步就绪。只取一次，之后不再重绑。
    try {
      if (typeof synth.addEventListener === 'function') synth.addEventListener('voiceschanged', pick);
      else if ('onvoiceschanged' in synth) synth.onvoiceschanged = pick;
    } catch (_) {}

    return {
      name: 'browser',
      ready() { return !!(voice || pick()); },
      // 必须保证 onEnd 恰好回调一次：只挂 onend 会让队列在 Chrome 的已知 bug 下永久卡死
      speak(text, o) {
        o = o || {};
        let done = false;
        const finish = () => { if (done) return; done = true; if (o.onEnd) o.onEnd(); };
        const u = new U(text);
        u.lang = 'zh-CN';
        u.rate = 1.05;
        u.pitch = 1.0;
        if (voice) u.voice = voice;
        u.onend = finish;
        u.onerror = finish;     // 出错也必须结算，否则队列停在这一句上
        try { synth.speak(u); } catch (_) { finish(); }
        return () => { done = true; try { synth.cancel(); } catch (_) {} };
      },
      cancel() { try { synth.cancel(); } catch (_) {} },
      estimate(text) { return text.length * MS_PER_CHAR + MS_BASE; },
    };
  }

  function pickDriver() {
    if (env.driver) return env.driver;
    try { return browserDriver(); } catch (_) { return null; }
  }

  // ── 切句（§5.3）───────────────────────────────────────────────────────
  // 超 maxMs 在最近的**句号或逗号**处切开，绝不切在词中间。
  //   "切出「等视野内出现敌主…」比不切更糟"。
  function estimate(text) {
    if (driver && typeof driver.estimate === 'function') {
      try { const ms = driver.estimate(text); if (ms > 0) return ms; } catch (_) {}
    }
    return text.length * MS_PER_CHAR + MS_BASE;
  }
  function cutAt(text, maxMs) {
    if (estimate(text) <= maxMs) return [text];
    const stops = ['。', '！', '？', '；', '，', '、'];
    const out = [];
    let rest = text;
    let guard = 0;
    while (rest && guard++ < 8) {
      if (estimate(rest) <= maxMs) { out.push(rest); break; }
      // 找切点：优先"不超过上限的最后一个停顿符"；一个都没有就退到"第一个停顿符"
      //   （宁可这一段略超上限，也不把半句话拆到词中间）。用 estimate() 累加而不是
      //   字数乘系数——驱动换了语速，切点会跟着漂，硬编码系数迟早对不上。
      let cut = -1, firstStop = -1;
      for (let i = 0; i < rest.length; i++) {
        if (stops.indexOf(rest[i]) < 0) continue;
        if (firstStop < 0) firstStop = i;
        if (estimate(rest.slice(0, i + 1)) <= maxMs) cut = i;
      }
      if (cut < 0) cut = firstStop;
      if (cut < 0) {
        // 整句没有停顿符：宁可整句超一点，也不切在词中间（切出「等视野内出现敌主…」比不切更糟）
        out.push(rest); break;
      }
      out.push(rest.slice(0, cut + 1));
      rest = rest.slice(cut + 1);
    }
    if (rest && out[out.length - 1] !== rest && out.join('') !== text) out.push(rest);
    return out;
  }

  // ── 队列 ──────────────────────────────────────────────────────────────
  function isCommandKind(kind) {
    // 等答期间"命令类仍可入队"（玩家可能直接下新令）；情报类让路
    return kind === 'ASK' || kind === 'ORDER_OK' || kind === 'ORDER_FAIL' ||
      kind === 'ORDER_WAIT' || kind === 'SYSTEM';
  }
  function prioOf(u) { return typeof u.prio === 'number' ? u.prio : 5; }
  function isDupe(u) {
    const k = u.key;
    if (!k) return false;
    const at = lastSaid.get(k);
    if (at == null) return false;
    // ALERT / SYSTEM 不受防抖限制：坏消息重复一遍不叫噪音，叫确认
    if (u.kind === 'ALERT' || u.kind === 'SYSTEM') return false;
    return (now - at) < DUPE_MS;
  }
  function recordDrop(u, why) {
    log.dropped.push({ id: u && u.id, kind: u && u.kind, text: u && u.text, why: why, at: now });
  }
  // 溢出处理（§5.4）：先换可丢的最低项 → 否则丢新来的可丢项 → 否则扩容 → 否则丢队尾最低并记 dropped
  function admit(entry) {
    const cap = queue.some(e => !e.u.droppable) ? QUEUE_CAP_MAX : QUEUE_CAP;
    if (queue.length < cap) { queue.push(entry); return 'queued'; }
    if (entry.u.droppable) {
      // 找一个可丢且优先级最低的替换掉
      let wi = -1, wp = Infinity;
      for (let i = 0; i < queue.length; i++) {
        if (!queue[i].u.droppable && queue[i].u.prio >= prioOf(entry.u)) continue;
        if (queue[i].u.droppable && prioOf(queue[i].u) < wp) { wp = prioOf(queue[i].u); wi = i; }
      }
      if (wi >= 0 && wp <= prioOf(entry.u)) {
        recordDrop(queue[wi].u, 'replaced');
        queue[wi] = entry;
        return 'replaced';
      }
      recordDrop(entry.u, 'queue-full');   // 队列里全是要紧的，新来的这条可丢
      return 'dropped';
    }
    // 新来的不可丢：临时扩容已经算过了，仍满就丢队尾最低的一条并记 dropped
    let wi = -1, wp = Infinity;
    for (let i = 0; i < queue.length; i++) if (prioOf(queue[i].u) < wp) { wp = prioOf(queue[i].u); wi = i; }
    if (wi >= 0 && wp < prioOf(entry.u)) {
      recordDrop(queue[wi].u, 'evicted');
      queue[wi] = entry;
      return 'evicted';
    }
    recordDrop(entry.u, 'queue-full-hard');
    return 'dropped';
  }

  // ── 播放 ──────────────────────────────────────────────────────────────
  function blocked() {
    if (off) return 'off';
    if (micOn) return 'mic';                 // PTT 录音中：一声不出
    if (resumeAt && now < resumeAt) return 'resume';
    if (waitUntil && now < waitUntil) return 'waiting';   // 等答：不插播情报（命令类另判）
    if (!driver) return 'nodriver';
    let ready = true;
    try { ready = driver.ready !== false && (typeof driver.ready === 'function' ? driver.ready() : true); } catch (_) { ready = false; }
    if (!ready) return 'novoice';            // 无音色：降级为纯文本（屏幕已经在 adjutant 里写过）
    return null;
  }

  function pump() {
    if (current) return;                     // 不抢占：正在念的一定念完
    const why = blocked();
    if (why) {
      if (why !== 'nodriver') return;        // 被压制就等下次 tick，不入驱动
      return;
    }
    // 取哪一条：**优先级最高的**（同级 FIFO）。等答期间只许取命令类。
    //   这条不能省——PTT 结束后新命令的回执必须排在积压的情报之前（§7 定）。
    let idx = -1, best = -1;
    for (let i = 0; i < queue.length; i++) {
      const e = queue[i];
      if (waitUntil && now < waitUntil && !isCommandKind(e.u.kind)) continue;
      if (prioOf(e.u) > best) { best = prioOf(e.u); idx = i; }
    }
    if (idx < 0) return;                   // 剩下的全是被压着的情报
    const entry = queue.splice(idx, 1)[0];
    const u = entry.u;
    const parts = cutAt(String(u.text), Math.min(HARD_MAX_MS, u.maxMs || DEFAULT_MAX_MS));
    // 切出来的后半句按 prio-1 重排进队（不是丢掉）
    for (let i = parts.length - 1; i >= 1; i--) {
      queue.push({
        u: Object.assign({}, u, { id: ++seq, text: parts[i], prio: Math.max(1, prioOf(u) - 1), key: null }),
        at: now,
      });
    }
    const say = parts[0];
    current = { u: u, startedAt: now, text: say };
    lastSaid.set(u.key || ('#' + u.id), now);
    log.spoken.push({ id: u.id, kind: u.kind, text: say, at: now });
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      current = null;
      if (u.needsAnswer) waitUntil = now + ANSWER_MS;   // 念完开麦等答
      // 立刻念下一句（不等下一帧，免得一句话之间空一拍）
      if (queue.length) pump();
    };
    if (watchdog) clearTimeout(watchdog);
    // 看门狗：Chrome 的 speechSynthesis 有挂死 bug，没有这个队列会永久卡住
    const budget = estimate(say) + WATCHDOG_MS;
    try {
      watchdog = setTimeout(() => {
        try { if (driver && driver.cancel) driver.cancel(); } catch (_) {}
        log.cut.push({ id: u.id, text: say, why: 'watchdog' });
        settle();
      }, budget);
    } catch (_) { watchdog = 0; }
    try {
      driver.speak(say, {
        rate: u.kind === 'ALERT' ? 1.12 : 1.05,
        onEnd: () => { if (watchdog) { clearTimeout(watchdog); watchdog = 0; } settle(); },
      });
    } catch (_) {
      if (watchdog) { clearTimeout(watchdog); watchdog = 0; }
      settle();                                // 驱动抛错也不许把队列堵死
    }
  }

  // ── 对外 ──────────────────────────────────────────────────────────────
  // 唯一入口。adjutant 产出 Utterance → 调这里。**屏幕由 adjutant 先写**，
  //   这里只负责"听不听得见"；这一层出任何问题都不影响屏幕。
  function say(u) {
    if (!u || !u.text) return { accepted: false, why: 'empty' };
    if (off) { log.suppressed.push({ id: u.id, kind: u.kind, why: 'off' }); return { accepted: false, why: 'off' }; }
    if (waitUntil && now < waitUntil && !isCommandKind(u.kind)) {
      log.suppressed.push({ id: u.id, kind: u.kind, why: 'waiting' });
      return { accepted: false, why: 'waiting' };
    }
    if (isDupe(u)) {
      log.suppressed.push({ id: u.id, kind: u.kind, why: 'dupe' });
      return { accepted: false, why: 'dupe' };
    }
    // 录音期间：**不发一声，但队列继续攒**（§7）。所以入队照收、只是进不了驱动，
    //   同时记一条 suppressed —— 事后要能查"这句话当时为什么没念出来"。
    if (micOn) log.suppressed.push({ id: u.id, kind: u.kind, why: 'mic' });
    // 同 key 未开口 → 覆盖（新的内容更好，不重复入队）
    if (u.key) {
      for (let i = 0; i < queue.length; i++) {
        if (queue[i].u.key === u.key) { queue[i] = { u: u, at: now }; pump(); return { accepted: true, why: 'coalesced' }; }
      }
    }
    const r = admit({ u: u, at: now });
    pump();
    return { accepted: r !== 'dropped', why: r };
  }

  // 玩家按下 PTT：立刻停播，不计入 dropped，录音全程静音，结束后留 250ms 尾巴
  function abort(reason) {
    const why = reason || 'manual';
    let cut = null;
    if (current) {
      // 半句话不许只活在扬声器里：被掐断的那句必须回到屏幕（§7）。
      //   这一层不碰 UI——把条目交给装配层注入的 onCut，由它决定写到哪
      const u = current.u;
      cut = { id: u.id, kind: u.kind, text: current.text, why: why, screen: (u.screen || u.text) + '\n（被打断，未念完）' };
      log.cut.push(cut);
      if (driver && driver.cancel) { try { driver.cancel(); } catch (_) {} }
      current = null;
    }
    if (driver && driver.cancel) { try { driver.cancel(); } catch (_) {} }
    if (watchdog) { try { clearTimeout(watchdog); } catch (_) {} watchdog = 0; }
    queue.length = 0;                 // PTT 期间清空积压（§7 定）
    waitUntil = 0;                    // 抢话即视为回答，等答状态一并解开
    if (cut && typeof env.onCut === 'function') { try { env.onCut(cut); } catch (_) {} }
    return cut;
  }

  function tick(dtMs) {
    const d = dtMs > 0 ? Math.min(dtMs, 250) : 0;   // 掉帧不让节流被一次性冲垮
    now += d;
    if (waitUntil && now >= waitUntil) {
      waitUntil = 0;                  // 等答超时：积压按 prio 放行，追问不重复念
    }
    pump();
  }

  function wire(handles) {
    env = handles || {};
    driver = pickDriver();
    // 注意：这里不能 return api.xxx()——api 是它下面的 const，此刻还在 TDZ 里
    return { driver: driver ? (driver.name || 'custom') : null, ready: !!(driver && (typeof driver.ready !== 'function' || driver.ready())) };
  }

  const api = {
    wire: wire,
    tick: tick,
    say: say,
    abort: abort,
    // PTT 互斥：录音期间静音（入队照收，只是不出声）
    setMic: function (on) {
      const was = micOn;
      micOn = !!on;
      if (micOn && !was) abort('ptt');
      if (!micOn && was) { resumeAt = now + RESUME_MS; pump(); }
    },
    setEnabled: function (on) { off = !on; if (off) abort('off'); else { resumeAt = now + RESUME_MS; pump(); } },
    isEnabled: function () { return !off; },
    busy: function () { return !!current || queue.length > 0; },
    speaking: function () { return current ? { id: current.u.id, text: current.text } : null; },
    waitingAnswer: function () { return !!(waitUntil && now < waitUntil); },
    queue: function () { return queue.map(e => ({ id: e.u.id, kind: e.u.kind, text: e.u.text, prio: e.u.prio })); },
    dropped: function () { return log.dropped.slice(); },
    suppressed: function () { return log.suppressed.slice(); },
    spoken: function () { return log.spoken.slice(); },
    cutLog: function () { return log.cut.slice(); },
    driverName: function () { return driver ? (driver.name || 'custom') : null; },
    driverReady: function () { try { return !!(driver && (driver.ready === undefined || (typeof driver.ready === 'function' ? driver.ready() : true))); } catch (_) { return false; } },
    reset: function () {
      queue = []; current = null; now = 0; micOn = false; off = false;
      waitUntil = 0; resumeAt = 0; lastSaid.clear();
      log.spoken.length = 0; log.dropped.length = 0; log.suppressed.length = 0; log.cut.length = 0;
      if (watchdog) { try { clearTimeout(watchdog); } catch (_) {} watchdog = 0; }
    },
    // 测试用：直接读内部状态，不参与运行逻辑
    _now: function () { return now; },
    _setDriver: function (d) { driver = d; },
    _estimate: estimate,
    _cutAt: cutAt,
    __micOn: function () { return micOn; },
    ANSWER_MS: ANSWER_MS,
    QUEUE_CAP: QUEUE_CAP,
  };

  if (typeof globalThis !== 'undefined') globalThis.SPEECH = api;
})();
