// recorder.js — 在线记录器（B 层训练用），只在 ?rec=1 时启用。
//
// 定位：**纯数据工具**。这里不读 SIM、不读 UI、不读 CMD——所有内容由装配层
//   （main.js）作为 payload 传进来。这样它既守住了分层（接线只在 main.js），
//   也能单独在 node 里被 train_b/split_rec.js 消费。
//
// 记什么：一条命令 = 一行 JSONL
//   {i, ts, build, seed, t, text, ctx, b, out, post}
//   ctx 是**上下文快照**（选中、各队位置/阵型、可见敌军、地标表）。没有它，
//   「往前」「北桥」「他们」这些说法回放时无法判定对错——盲标会变成瞎标。
//
// post（68 加）：**执行 3 个模拟秒后的战场真值**，由装配层定时贴上来（`attach('post', …)`）。
//   没有它就只能判"解析对不对"，判不了"部队到底动没动"——那是 §4.3 那个 P0 指标的分母。
//   ★ 本文件仍然不认识时间、不认识 SIM：到点由 main.js 决定，这里只负责贴。
//
// 为什么另存两栏（b 与 out 分开）：训练集要求**盲标**。标注时只允许看 text+ctx，
//   否则看见 B 层答案再"判断它对不对"就是自己给自己判分。导出后用
//   train_b/split_rec.js 拆成只有 text+ctx 的 cases 文件，物理上隔离。
//
// 隐私：只写本机 localStorage，不上传任何服务器（页面是静态托管，没有后端）。
globalThis.REC = (function () {
  const KEY = 'hubaoqi.rec.v1';
  const MAX = 300;              // 条数上限：每条含快照约 1.5KB，300 条 ≈ 450KB，远低于 5MB 配额
  let on = false, buf = [], cur = null, meta = {}, seq = 0;

  function enabled() {
    try { return /(^|[?&])rec=1(&|$)/.test(location.search); } catch (_) { return false; }
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) { const d = JSON.parse(raw); buf = d.items || []; seq = d.seq || buf.length; }
    } catch (_) { buf = []; }
  }
  function save() {
    try {
      if (buf.length > MAX) buf = buf.slice(buf.length - MAX);
      localStorage.setItem(KEY, JSON.stringify({ v: 1, seq, items: buf }));
    } catch (_) { /* 配额满或被禁用：只影响记录，绝不影响游戏 */ }
  }

  // 一次落盘：try 包死，任何异常都吞掉
  function flush() {
    if (!cur) return;
    if (cur.text) { cur.i = ++seq; cur.at = new Date().toISOString(); buf.push(cur); save(); }
    cur = null;
  }

  // phase: 'in' | 'b' | 'out'
  function push(phase, payload, ctx) {
    if (!on) return;
    try {
      if (phase === 'in') {
        flush();                                  // 上一条没等到 out 也要落地，不许丢
        cur = { build: meta.build || '', seed: meta.seed == null ? null : meta.seed,
                t: payload.t == null ? null : +(payload.t.toFixed(2)),
                text: payload.text || '', ctx: ctx || null, b: null, out: null };
      } else if (cur) {
        if (phase === 'b') cur.b = payload || null;
        else if (phase === 'out') { cur.out = payload || null; flush(); }   // 结果到了就落盘，不等下一条
      }
    } catch (_) { /* 记录失败不影响下令 */ }
  }

  function exportJsonl() {
    flush();
    const name = `rec_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.jsonl`;
    const body = buf.map(x => JSON.stringify(x)).join('\n') + '\n';
    try {
      const blob = new Blob([body], { type: 'application/jsonl' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
    } catch (_) {
      // 兜底：Blob 不可用时退成 data URL（和命令日志导出同一手法）
      const a = document.createElement('a');
      a.href = 'data:application/jsonl;charset=utf-8,' + encodeURIComponent(body);
      a.download = name; if (a.click) a.click();
    }
  }

  function clear() { buf = []; seq = 0; cur = null; save(); paint(); }

  // 往**最后一条已落盘**的记录上贴一栏（68：post 快照走这里）。
  //   为什么贴在"最后一条"而不是继续放在 cur 里：out 一到就 flush（崩了也不丢），
  //   所以命令记录早已进 buf；post 是"过一会儿才有"的数据，只能回头补写。
  //   贴不上（没有记录 / 存储坏了）就返回 false，绝不抛——记录器出问题不许影响游戏。
  function attach(key, value) {
    if (!on) return false;
    try {
      const it = buf[buf.length - 1];
      if (!it) return false;
      it[key] = value; save(); return true;
    } catch (_) { return false; }
  }

  // 只在 ?rec=1 时挂一个角落按钮。不占版面、不抢焦点——它是给测试者用的，
  //   普通玩家看不到这一整套东西。
  function paint() {
    if (!on) return;
    let box = document.getElementById('recBox');
    if (!box) {
      box = document.createElement('div');
      box.id = 'recBox';
      box.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:9999;font:11px/1.6 system-ui,sans-serif;' +
        'background:rgba(18,22,20,.88);color:#9fb2c8;border:1px solid #35403a;border-radius:6px;' +
        'padding:6px 8px;display:flex;gap:8px;align-items:center;user-select:none';
      box.innerHTML = '<span id="recCnt">记录 0</span>' +
        '<button id="recDl" style="all:unset;cursor:pointer;color:#e3c96a;padding:0 2px">导出</button>' +
        '<button id="recCl" style="all:unset;cursor:pointer;color:#7d8a80;padding:0 2px">清空</button>';
      document.body.appendChild(box);
      box.querySelector('#recDl').onclick = exportJsonl;
      box.querySelector('#recCl').onclick = clear;
    }
    const c = box.querySelector('#recCnt');
    if (c) c.textContent = '记录 ' + buf.length;
  }

  function start(m) {
    on = enabled();
    if (!on) return false;
    meta = m || {};
    load(); paint();
    window.addEventListener('beforeunload', flush);
    return true;
  }

  return { start, enabled, push, attach, flush, exportJsonl, clear, count: () => buf.length, items: () => buf.slice() };
})();
