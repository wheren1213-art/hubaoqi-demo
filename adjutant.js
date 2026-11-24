// adjutant.js — c 层子件 c8：副将（对外人格）
//
// 定位：c 层内部"说什么、什么顺序说"与"怎么发声"的分离点。副将不是新的一层——
//   · 不判命令对错、不补槽位、不改战场状态、不调执行器、不含任何词表；
//   · **不含任何浏览器 API**（`speechSynthesis` / `document` / `new Audio` 一个都不许有，
//     出声归 e′ 语音层 speech.js，见 ADJUTANT.md §2、§6）；
//   · 读的是 c1~c7 已定的结论 + d 层的公开只读查询（getFog / enemyFogState / statusReport…）。
// 四条职责：
//   ① 口吻：命令回执、追问、说明——把表单话翻成军中答话（产出 `screen`）；
//   ② 语音：把同一件事压成一句 ≤15 字的话（产出 `text`），交 e′ 念；
//   ③ 编组：九支部队同时变化时合成一句，不逐队复读（§4.4）；
//   ④ 情报：主动观察战场，只报**变化**，且只报"要玩家发话的"。
//
// 权限边界（2026-10-27 上司定）：**代办可以，代替决断不行。**
//   可自决：沿用部队、平分兵力、路线与姿态、把"打地标"按到点即战解释；
//   必须先问：选目标、定撤退、弃据点——这几样会死人，副将不替玩家拍板。
//
// 79 的关键改动（ADJUTANT.md §3.2）：**输出不是一个字符串，是一个 `Utterance`。**
//   `text` 只给嘴（短）、`screen` 只给眼（全）。旧实现只有一个字符串，
//   句子长短由内容决定、不由通道决定，于是"语音要短"和"屏幕要全"永远打架。
(() => {
  let S = null, UI = null;

  const ADDRESS = '将军';   // 称呼。副将不叫"您"以外的尊称，也不寒暄。
  const GAP = 1.6;          // 主动情报最小间隔（秒）：一句说完再攒下一句，不刷屏

  // ── 契约：Utterance（ADJUTANT.md §3.1）────────────────────────────
  // 九个 kind 是**唯一口径**：表外即违约，`assertUtterance()` 加载即跑。
  // prio 只决定排队位置，不决定抢占（§5.2）；droppable=false 的一条都不许丢（§5.4）。
  const KINDS = {
    ORDER_OK:   { prio: 6,  droppable: false },   // 得令
    ORDER_FAIL: { prio: 8,  droppable: false },   // 没下成 / 办不了 / 无关 / 没接住
    ORDER_WAIT: { prio: 5,  droppable: false },   // 已挂起，等条件
    ASK:        { prio: 7,  droppable: false, needsAnswer: true },
    ALERT:      { prio: 9,  droppable: false },   // 没了 / 溃退 / 主将挨打 / 本营失守 / 卡住
    TRIGGER:    { prio: 8,  droppable: false },   // 等的那件事来了（30 秒提醒那条可丢）
    INTEL:      { prio: 5,  droppable: true  },   // 据点 / 敌情 / 折损 / 薄雾
    REPORT:     { prio: 6,  droppable: false },   // 玩家问状况
    SYSTEM:     { prio: 10, droppable: false },   // 胜负已分
  };
  const KIND_KEYS = Object.keys(KINDS);
  const NEVER_DROP = ['ORDER_OK', 'ORDER_FAIL', 'ORDER_WAIT', 'ASK', 'ALERT', 'SYSTEM', 'REPORT'];
  let uid = 0;

  function assertUtterance(u) {
    const bad = [];
    if (!u || typeof u !== 'object') bad.push('不是一个对象');
    else {
      if (KIND_KEYS.indexOf(u.kind) < 0) bad.push(`kind 不在枚举内：${u.kind}`);
      if (!(u.prio >= 1 && u.prio <= 10)) bad.push(`prio 越界：${u.prio}`);
      if (typeof u.text !== 'string' || !u.text) bad.push('text 为空');
      else {
        if (u.text.length > 15) bad.push(`text 超 15 字（${u.text.length}）：${u.text}`);
        if (/[\n\r]/.test(u.text)) bad.push('text 里有换行（换行属于 screen）');
        if (/[（(][^）)]*[）)]/.test(u.text)) bad.push('text 里有括号注记（语音会把括号念出来）');
      }
      if (typeof u.screen !== 'string' || !u.screen) bad.push('screen 为空');
      if (!(u.maxMs >= 500 && u.maxMs <= 6000)) bad.push(`maxMs 越界：${u.maxMs}`);
      if (u.needsAnswer && u.droppable) bad.push('needsAnswer 的项不许可丢');
      // 这些 kind 一条都不许丢（§4.2 铁律）：丢了"枪兵队没了"就是事故
      if (u.droppable && NEVER_DROP.indexOf(u.kind) >= 0) bad.push(`${u.kind} 不许标成可丢`);
      if (!u.droppable && KINDS[u.kind] && KINDS[u.kind].droppable && !u.hard) {
        // INTEL/TRIGGER 默认可丢，但"等的那件事来了"这类必须硬保：靠 hard 显式声明
      }
      if (!u.key) bad.push('key 为空');
    }
    if (bad.length) {
      const err = new Error('Utterance 违约：' + bad.join('；'));
      err.violations = bad;
      throw err;
    }
    return u;
  }

  // 语音可念化：**在构造口统一做，不指望每个调用点都记得**。
  //   踩过的坑：57 起地名是从地形长出来的，重名会加「（二）（三）」后缀 →
  //   「营地（二）拿下了。」念出来是「营地括号二」，而且 assert 当场抛错把主循环打断
  //   （adapt_test 十张图上三张直接崩）。所以括号在这里转成内容本身，换行转空格。
  function speakableText(t) {
    let s = String(t == null ? '' : t)
      .replace(/[（(]([^）)]{1,8})[）)]/g, '$1')   // 「营地（二）」→「营地二」
      .replace(/[\n\r]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    // 给嘴的那一句必须短。"永远说完当前一句"意味着句子长度直接等于回执延迟，
    //   所以超了就在这里截——**在构造口截，不靠外层记得**。宁可少说半句，
    //   也不让一句拖长到把后面三条回执全堵住。
    if (s.length > 15) s = s.slice(0, 14).replace(/[，、；：,;:\s]+$/, '') + '。';
    return s;
  }

  // 唯一的构造口：所有产出都从这里过一遍 assert，形状不对当场炸，而不是等到念出来才发现
  function utter(kind, text, screen, opts) {
    const o = opts || {};
    const k = KINDS[kind] || KINDS.INTEL;
    const u = {
      id: ++uid,
      kind: kind,
      text: speakableText(text),
      screen: String(screen == null ? text : screen),
      prio: o.prio != null ? o.prio : k.prio,
      droppable: o.droppable != null ? o.droppable : k.droppable,
      needsAnswer: o.needsAnswer != null ? o.needsAnswer : !!k.needsAnswer,
      units: o.units || [],
      key: o.key || `${kind}:${uid}`,
      maxMs: o.maxMs || 3000,
      at: o.at != null ? o.at : (S ? S.simTime : 0),
    };
    return assertUtterance(u);
  }

  // ── 称呼降级链（§4.4 二）──────────────────────────────────────────
  // 五支部队叫「枪兵队 / 弓兵队 / 骑兵队 / 枪兵队乙 / 枪兵队丙」，逐队念就是灾难。
  //   1 支→点名 | 2~3 支同兵种→「两支枪兵」 | 跨兵种→并列点名 | ≥4 支→「五支 / 全军」
  const CN_NUM = ['零', '一', '两', '三', '四', '五', '六', '七', '八', '九', '十'];
  function cnNum(n) { return CN_NUM[n] != null ? CN_NUM[n] : String(n); }
  function grp(list) {
    const us = (list || []).filter(Boolean);
    const n = us.length;
    if (!n) return '部队';
    if (n === 1) return us[0].name || '那支部队';
    // "全军"只在"活着的部队全在里面"时才说——否则是撒谎
    let total = n;
    if (S && S.units) total = S.units.filter(u => u && u.hp > 0 && !u.isRouted).length;
    if (n >= 4) return (total === n && n >= 4) ? '全军' : `${cnNum(n)}支`;
    const types = [];
    for (const u of us) if (types.indexOf(u.type) < 0) types.push(u.type);
    if (types.length === 1) return `${cnNum(n)}支${types[0]}`;   // 两支枪兵
    return us.slice(0, 2).map(u => u.name).join('和');
  }
  // type 在 d 层是 '枪兵'/'弓兵'/'骑兵'，但外部可能只给名字——从名字里反推一个
  function typeOf(u) {
    if (u && u.type) return u.type;
    const n = String(u && u.name || '');
    if (/枪/.test(n)) return '枪兵';
    if (/弓/.test(n)) return '弓兵';
    if (/骑/.test(n)) return '骑兵';
    return '部队';
  }


  // ── 数值 → 人话 ──────────────────────────────────────────────
  // 分档而不是给数字：副将报的是"还能不能打"，不是血条。
  const HP_BANDS = [[0.9, '齐整'], [0.65, '折了些人'], [0.4, '折损过半'], [0.2, '只剩三成'], [-1, '快打光了']];
  // 注意：这些词前面会被拼上"士气"，所以不能自带"气"字（曾出现"士气气很盛"）
  const MO_BANDS = [[80, '很盛'], [60, '还稳'], [50, '有些躁'], [35, '在动摇'], [-1, '快撑不住了']];
  const DIRS = ['东', '东南', '南', '西南', '西', '西北', '北', '东北'];
  function bandIdx(v, bands) { for (let i = 0; i < bands.length; i++) if (v >= bands[i][0]) return i; return bands.length - 1; }
  function bandWord(v, bands) { return bands[bandIdx(v, bands)][1]; }

  // 以将旗为原点说方位——"东边"比"第 27 列"像人说的话
  function bearingAt(x, y) {
    const c = S && (S.commander || S.units.find(u => u.hp > 0));
    if (!c) return '';
    const dx = x - c.x, dy = y - c.y, d = Math.hypot(dx, dy);
    if (d < 1.5) return '触手可及的地方';
    const a = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
    return `${DIRS[Math.round(a / 45) % 8]}边`;
  }
  function spanAt(x, y) {
    const c = S && (S.commander || S.units.find(u => u.hp > 0));
    if (!c) return null;
    return Math.round(Math.hypot(x - c.x, y - c.y));
  }

  // ── 回执里的注记改口 ────────────────────────────────────────
  // c 层原来的注记是写给开发者看的（"未点名部队，对当前选中的部队生效"）。
  // 改口时**不改事实**，只换说法——所以动作词与实体名一律原样保留，测试与日志仍可检索。
  const NOTE_REWRITE = [
    [/^未点名部队，沿用上一条命令的部队/, '没点名，我沿用了上一道令的那几支'],
    [/^未点名部队，对当前选中的部队生效/, '没点名，我按您选中的几支办的'],
    [/^已自动纠正错字[：:](.*)$/, '您那句里有几个字我听岔了，已按「$1」改过来'],
    [/^占领目标默认为中央据点/, '没指哪一处，我按中央据点办'],
    [/^绕行[/／]包抄偏好暂未实现，按常规路线执行/, '包抄我还没学会，先让他们走常路'],
    [/^分兵指令需要说明分到哪几处.*$/, '要分兵得说清分到哪几处'],
    [/^新命令已取消此前的排队步骤/, '先前排的队我给撤了'],
    [/^部队站上据点 10 秒即占领，敌军同站在场时进度暂停/, '站上据点守满十秒才算拿下，敌人在场就僵着'],
  ];
  function humanNote(note) {
    for (const [re, to] of NOTE_REWRITE) if (re.test(note)) return note.replace(re, to);
    return note;   // 不在表里的原样保留，不猜
  }

  // c 层偶尔直接给整句人话（失败原因之类），这里只做态度上的收口，不改信息
  const PLAIN_REWRITE = [
    [/^敌军已全歼，没有攻击目标。?$/, '敌军已经全歼了，没得打。'],
    [/^战斗已结束，刷新页面可再来一局。?$/, '仗打完了，刷新页面能再来一局。'],
    [/^(.*)附近 4 格内没有发现敌军。?$/, '$1那边四格内没见着人。'],
    [/^(.*)已阵亡或正在溃退，无法受命。?$/, '$1已经没了或正在溃散，这令压不下去。'],
    [/^没有可停止的部队。?$/, '眼下没有正在行动的部队。'],
    [/^没听懂这句补充。/, '这句我没接上。'],
    [/^已放弃命令「(.*)」。?$/, '这条先撤了：「$1」。'],
    [/^组合命令没有执行：第 (\d+) 段无法理解——([\s\S]*)$/, '这条我拆段看了，第 $1 段站不住——$2。整条先不办。'],
    [/^排队命令缺少信息，已停下：([\s\S]*)$/, '排在后面的那段卡住了，先停下：$1'],
  ];
  function humanPlain(t) {
    for (const [re, to] of PLAIN_REWRITE) if (re.test(t)) return t.replace(re, to);
    return t;
  }

  // ── 追问改口 ────────────────────────────────────────────────
  // 机械问句换成军中问法，但**编号选项、地名清单、可用说法一律保留**——
  // 那些是玩家唯一能照着答的东西，副将不能为了好听把它们说没了。
  const ASK_REWRITE = [
    [/^请问由哪支部队执行？/, '这令交给谁？'],
    [/^要攻击哪个目标？/, '打哪一支？'],
    [/^要([\u4e00-\u9fa5]{1,4})哪里？/, '往哪儿？'],
    [/^要哪一处：/, '这几处您说的是哪一处：'],
    [/^要部队做什么？/, '您是要哪支部队、做什么？'],
    [/^没听懂这句补充。/, '这句我没接上。'],
    [/^请指明哪支部队、做什么。/, '得指名道姓——哪支部队、做什么？'],
    [/^护卫[/／]跟随需要"执行部队\+被护卫者"。/, '护卫这事得说两头：谁护谁。'],
  ];
  function askSentence(question) {
    let q = String(question || '').trim();
    for (const [re, to] of ASK_REWRITE) if (re.test(q)) { q = q.replace(re, to); break; }
    return q;
  }
  function ask(question, src) {
    const q = askSentence(question);
    if (!q) return '';
    const head = q.startsWith(ADDRESS) ? q : `${ADDRESS}，${q}`;
    // 追问要让人知道在补哪一条；用大白话说，不用「» 原句」这种机器符号
    return src ? `${head}\n（说的是「${src}」）` : head;
  }
  // 输入框 placeholder 只放第一句问话，太长会挤掉输入内容
  function askShort(question) {
    const q = askSentence(question);
    const i = q.search(/[？?]/);
    return i > 0 ? q.slice(0, i + 1) : q;
  }

  // ── ① 回执：c 层的结论 → 副将嘴里的话 ─────────────────────────
  // 协议：body 以「命令解读：」开头＝命令已下发；status/fb 是执行器回来的结论与播报。
  // 关键：**执行器说没办成，副将就不能说"得令"**——这是"执行情况反馈"的底线。
  // ── 命令回执：按字段从头生成（79 定，2026-11-02）────────────────────────
  // 命令层以前拼「命令解读：枪兵队、弓兵队 → 禁止过河」，副将只把箭头换成逗号。
  //   那只改得了措辞、改不了语序——「全军，向东推进 3 格」里那个逗号就是"模型没被重写"的痕迹；
  //   括号里的技术说明（「主将实体未实装」）更是原样落到玩家眼前。
  // 现在命令层只给字段，句子在这里生成。加一种说法＝改这张表，不必再猜正则。
  function whoText(w) {
    if (!w) return '';
    if (typeof w === 'string') return w;
    if (Array.isArray(w)) return grp(w);       // 「全军」「两支枪兵」由称呼降级链决定
    return '';
  }
  function bodyLine(o) {
    if (o.head && o.parts) return `${o.head}：${o.parts.join('，')}`;
    // 中文里动词和宾语之间不加空格：「撤到北桥」不是「撤到 北桥」。
    //   格数、距离这些阿拉伯数字两侧的空格要留（「推进 3 格」是两段）。
    return whoText(o.who) + o.act + (o.tgt ? o.tgt : '');
  }
  // 只去汉字之间的空格，数字与汉字之间的留着
  function tidy(s) {
    return String(s || '').replace(/([\u4e00-\u9fa5）])\s+(?=[\u4e00-\u9fa5（])/g, '$1');
  }
  function notesText(notes) {
    const ns = (notes || []).filter(Boolean);
    return ns.length ? `\n（${ns.join('；')}）` : '';
  }
  function render(src, order, status, fb) {
    cool = Math.max(cool, 0.9);   // 玩家刚下完令：先听回执，低优先级情报让路
    dropLow();
    // 字符串＝自由文案（域外、报错、汇报）：只做态度收口，不重排、不猜结构
    if (!order || typeof order === 'string') return humanPlain(String(order || ''));
    const line = tidy(bodyLine(order));
    const notes = notesText(order.notes);
    // 句号统一在这里补：命令层给的是短语（「全军转入戒备」），不带标点。
    //   补在副将侧而不是命令侧，是因为标点是"怎么说"的一部分——命令侧只管"说什么"。
    const say = (t, pre) => `${pre}${t}${/[。！？]$/.test(t) ? '' : '。'}${notes}`;
    const why = fb ? tuneWhy(String(fb)) : '';
    // 抗命 / 无路可走：不说「得令」，直说没办成与原因
    if (status === 'FAILED' || status === 'UNSUPPORTED') {
      return why ? `这令没下成——${why}。` : `这令没下成。${line}，可兵没动。`;
    }
    if (status === 'PARTIAL') return say(line, '得令，不过有人没照办。');
    if (!status) return say(line, '');          // 没有 status 的说明句
    return say(line, '得令。');
  }
  function tuneWhy(t) {
    return humanPlain(t).replace(/[。；;]\s*$/, '');
  }

  // 已执行但只是补充说明（"已放弃命令…""排队：…"）
  function remark(text) {
    const t = String(text || '');
    cool = Math.max(cool, 0.9);
    return humanPlain(t);
  }

  // ── ③ 态势汇报：玩家问「报告/情况如何」时由副将答 ─────────────
  // 输入是 d 层 statusReport 的原始字段，输出是口头话。
  // 铁律：只说"还能不能打"，不摆 hp/maxHp 这种血条数字；状态与折损同档的三队收成一句，不复读。
  const STATE_WORD = {
    '待命': '待命', '移动': '在走', '驻守': '守着', '推进': '在推进',
    '推进行列': '在推进', '撤退': '在撤', '交战': '在打',
    '迎敌': '在赶人', '归位': '正回守位',
    '接敌暂停': '跟敌人顶住了、动不了', '接近目标': '正摸向目标',
    '接敌停步': '路上撞见敌人，站着打',
    '集结': '正往一处靠', '跟随': '跟着', '跟随待命': '跟着', '溃退': '在溃散',
  };
  // 这些状态是"真的在动"；其余状态若还挂着 goal，说明令在却人没动——这才是
  //   "为什么没动"的答案，必须说清楚，不能报成"往北去"。
  const ON_THE_MOVE = new Set(['移动', '推进', '推进行列', '接近目标', '撤退', '集结', '跟随']);
  function reportLine(r) {
    const hpIdx = bandIdx(r.hp / r.maxHp, HP_BANDS);
    const moIdx = bandIdx(r.morale, MO_BANDS);
    let s = `${r.name}${STATE_WORD[r.state] || r.state}`;
    if (r.advancing) {
      s += ON_THE_MOVE.has(r.state)
        ? `，往${r.advancing}去`
        : `，令是往${r.advancing}去的，人却窝在原地`;
    }
    if (hpIdx > 0) s += `，${bandWord(r.hp / r.maxHp, HP_BANDS)}`;
    if (moIdx > 0) s += `，士气${bandWord(r.morale, MO_BANDS)}`;
    if (hpIdx === 0 && moIdx === 0) s += '，人齐、气也足';
    // 下面三项只有 REPORT 动作会带（问题通道的 statusReport 没有这些字段）
    if (r.stamina != null) {
      if (r.stamina < 25) s += '，精力见底';
      else if (r.stamina < 50) s += '，精力有些乏';
    }
    if (r.stance === 'FORMED') s += '，还列着阵';
    // 遇敌档只说"吃亏的那一头"：已发现不必夸一遍，没准备才要提醒（2026-11-23 改读 meet）
    if (r.meet === '未预期') s += '，未预期遇敌，这一波列不了阵';
    else if (r.meet === '有预期') s += '，看见时敌人已在近处';
    if (r.lastStopReason) s += `；之前是因为「${String(r.lastStopReason).replace(/[。.]\s*$/, '')}」停下的`;
    return `${s}。`;
  }
  function report(rows) {
    if (!rows || !rows.length) return '眼下没有还能动的部队了。';
    cool = Math.max(cool, 0.9);   // 玩家刚问过：让情报等一句
    dropLow();
    // 薄雾区的部队是"信使刚带回来的旧情报"：必须说出来，否则玩家会拿 2 秒前的战况做决定
    const staleOf = r => (r.stale > 0 ? `（这份是 ${r.stale.toFixed(1)} 秒前的情报）` : '');
    const lines = rows.map(r => reportLine(r) + staleOf(r));
    // 几队话完全一样（状态·折损·士气·精力·戒备·认知·停因全同）→ 合成一句，不念复读机
    const tails = rows.map((r, i) => lines[i].slice(String(r.name).length));
    if (rows.length > 1 && tails.every(t => t === tails[0])) {
      return `${rows.map(r => r.name).join('、')}都${tails[0]}`;
    }
    const lagged = rows.filter(r => r.stale > 0).length;
    const tail = lagged ? `\n（${lagged} 支在主将视野外，报文有延迟；要实时，把主将带过去。）` : '';
    return lines.join('\n') + tail;
  }

  // ── ② 情报：副将自己看战场，只报变化 ─────────────────────────
  // 79 起不再是「逐队一句」。`scan()` 只**收集**变化，`groupChanges()` 负责**编组**：
  //   五支部队同时折损 → 一句「五支折了些人」，不是五句「枪兵队折了些人」（ADJUTANT.md §4.4）。
  const q = [];              // 待发 Utterance（已编组、已过 assert）
  let cool = 0;              // 两句情报之间至少 GAP 秒（1.6）
  let acc = 0;               // 扫描累加
  let baselined = false;     // 开局先建基线：一上来不报"某队正在移动"这种废话
  const watch = new Map();   // 我方部队 id → {zone,hb,mb,routed}
  const foeWatch = new Map();// 敌军 id → {mode,x,y}
  const baseWatch = new Map();// 本营 id → 是否还在原主手里（㊺）
  const siteWatch = new Map();// 营地 id → 上一拍的归属（54：五处各记各的）
  let resultSeen = null;
  const dropLog = [];        // 溢出被丢的（不许静默，测试要能查）

  const Q_CAP = 12;
  function dropLow() { for (let i = q.length - 1; i >= 0; i--) if (q[i].prio < 7) q.splice(i, 1); }
  function pushQ(u) {
    if (q.length >= Q_CAP) { dropLog.push({ id: u.id, kind: u.kind, text: u.text, why: 'cap' }); return false; }
    q.push(u); return true;
  }
  // 一条情报的两个去处：**先上屏，再交语音**（§6.3）。
  //   顺序不能反：语音层出任何问题（无音色、被拦、超时）都不许影响"看不看得见"。
  function pushInfo(u) {
    if (!u) return null;
    if (UI && UI.echo) UI.echo(`副将：${u.screen}`);
    if (typeof SPEECH !== 'undefined' && SPEECH && SPEECH.say) { try { SPEECH.say(u); } catch (_) {} }
    return u;
  }

  function observe(dt) {
    if (!S) return;
    const d = dt > 0 ? Math.min(dt, 0.1) : 0;   // 掉帧时不让节流被一次性冲垮
    cool -= d;
    if (cool <= 0 && q.length) {
      q.sort((a, b) => b.prio - a.prio);
      pushInfo(q.shift());
      cool = GAP;   // 1.6 秒一句：半秒内最多一条（adjutant_test 守着）
    }
    acc += d;
    if (acc < 0.4) return;
    acc = 0;
    scan();
  }

  // ── 编组（§4.4）────────────────────────────────────────────────────
  // 只有"同一类事"才合并：死的与折损不合并，折损与士气不合并，坏消息与好消息不合并。
  //   sig 就是"同类"的判据；没有 sig 的条目（敌军/据点/本营/胜负）各说各的。
  function groupChanges(items) {
    const buckets = new Map(), singles = [];
    for (const it of (items || [])) {
      if (!it || !it.sig) { if (it) singles.push(it); continue; }
      let b = buckets.get(it.sig);
      if (!b) { b = { sig: it.sig, list: [] }; buckets.set(it.sig, b); }
      b.list.push(it);
    }
    const out = [];
    for (const b of buckets.values()) out.push(b.list[0].make(b.list));
    for (const s of singles) out.push(s.make([s]));
    return out.filter(Boolean);
  }

  // 抽稀：语音超过 3 类时只念前 2 条 + 一句概括，**被抽掉的全部进 screen**（§4.4 四）。
  //   注意抽稀只动 INTEL——ALERT / SYSTEM / TRIGGER 永远不抽（坏消息不许被"概括"掉）。
  function thin(list) {
    const keepHard = list.filter(u => u.kind !== 'INTEL');
    const intel = list.filter(u => u.kind === 'INTEL').sort((a, b) => b.prio - a.prio);
    if (intel.length <= 3) return list;
    const keep = intel.slice(0, 2), rest = intel.slice(2);
    if (rest.length && keep.length) {
      keep[keep.length - 1].screen += '\n（另有：' + rest.map(x => x.screen || x.text).join('；') + '）';
    }
    return keepHard.concat(keep);
  }

  function scan() {
    const items = [];   // 本拍收集到的变化，由 groupChanges 一次编组
    const fog = S.getFog();
    // 友军：薄雾、折损、士气、溃退。zone 只看"主将视野"——非主将单位本来就在薄雾里，
    // 玩家能看见方块，但看不清它周围，这才是该提醒的事。
    for (const u of S.units) {
      const prev = watch.get(u.id);
      if (u.hp <= 0) {
        if (prev && !prev.dead) {
          items.push({
            sig: 'dead', unit: u,
            make: list => {
              const us = list.map(x => x.unit);
              const ids = us.map(x => x.id).join(',');
              return utter('ALERT', `${grp(us)}没了。`, us.map(x => `${x.name}没了。`).join('\n'),
                { key: 'group:dead:' + ids, units: us.map(x => x.id) });
            },
          });
          watch.set(u.id, { dead: true });
        }
        continue;
      }
      const k = S.key(Math.round(u.x), Math.round(u.y));
      const zone = fog.bright.has(k) ? 'clear' : 'thin';
      const hb = bandIdx(u.hp / u.maxHp, HP_BANDS), mb = bandIdx(u.morale, MO_BANDS);
      // 主将（83）：**身份不是兵种**。胜负只看主将阵亡，所以主将的折损必须单独开口：
      //   以前主将和别的部队一样按血量分带报，「主将队折损过半」和「弓兵队乙折了些人」同一语气，
      //   玩家听到"快打光了"时离判负只剩十几秒（82 挂机实录：14 秒）。这条 ALERT 补的就是那段空窗。
      //   两处都要绕开普通折损组：① 第一次挨打 ② 每跨一道血量带。
      //   绕开的原因不是礼貌问题——普通折损会按 sig 编组，主将一旦和友军并进一句
      //   「枪兵队乙、主将队快打光了」，玩家就分不清哪句是要命的。
      const isCmdr = u.role === 'commander';
      if (!prev) { watch.set(u.id, { zone, hb, mb, routed: !!u.isRouted, hit: u.hp < u.maxHp }); continue; }
      if (baselined && isCmdr && u.hp < u.maxHp && !prev.hit) {
        // 第一次挨打**不报百分比**：149 秒那一下是 400→396，念"只剩 99%"是噪音。
        //   这条要传达的是"敌人已经摸到主将跟前"，不是血量。
        //   真正要命的是后面每条血量带，那几条报数。
        items.push({
          sig: 'cmdrHit', unit: u,
          make: () => utter('ALERT', `${u.name}挨打了！`,
            `${u.name}挨打了——敌人已经摸到主将跟前。主将阵亡，这一局就完了。`,
            { key: 'alert:cmdr:hit' }),
        });
      }
      if (baselined) {
        if (prev.zone !== zone && zone === 'thin') {
          const bear = bearingAt(u.x, u.y);
          items.push({
            sig: 'fogIn', unit: u,
            make: list => {
              const us = list.map(x => x.unit);
              const screen = us.length === 1
                ? `${us[0].name}进了${bear}的薄雾，我只看得见个大概。`
                : `${us.map(x => x.name).join('、')}都进了薄雾，我只看得见个大概。`;
              return utter('INTEL', `${grp(us)}进雾了。`, screen, { prio: 4, key: 'group:fogIn', units: us.map(x => x.id) });
            },
          });
        } else if (prev.zone !== zone) {
          items.push({
            sig: 'fogOut', unit: u,
            make: list => {
              const us = list.map(x => x.unit);
              return utter('INTEL', `${grp(us)}出雾了。`,
                us.map(x => `${x.name}出了雾，重新看得清了。`).join('\n'),
                { prio: 3, key: 'group:fogOut', units: us.map(x => x.id) });
            },
          });
        }
        if (hb > prev.hb) {
          const pct = Math.round(u.hp / u.maxHp * 100);
          const word = bandWord(u.hp / u.maxHp, HP_BANDS);
          if (isCmdr) {
            // 主将版：单人一句、ALERT、并说清"这是主将"。语音仍守 ≤15 字（句长＝回执延迟）。
            items.push({
              sig: 'cmdrHp:' + hb, unit: u,
              // 分带词本身已经带"只剩"（"只剩三成"），后面再接"只剩 30%"就是复读。
              make: () => utter('ALERT', `${u.name}${word}。`,
                `${u.name}（全军主将）${word}，现在 ${pct}%。主将阵亡，这一局就完了。`,
                { key: 'alert:cmdr:hp:' + hb, units: [u.id] }),
            });
          } else {
          items.push({
            sig: 'hp:' + hb, unit: u,
            make: list => {
              const us = list.map(x => x.unit);
              const worst = Math.min.apply(null, list.map(x => x.pct));
              const screen = us.length === 1
                ? `${us[0].name}${word}，还剩 ${worst}%。`
                : `${us.map(x => x.name).join('、')}${word}，最少的只剩 ${worst}%。`;
              return utter('INTEL', `${grp(us)}${word}。`, screen, { prio: 6, key: 'group:hp:' + hb, units: us.map(x => x.id) });
            },
            pct: pct,
          });
          }
        }
        if (mb > prev.mb) {
          const word = bandWord(u.morale, MO_BANDS);
          items.push({
            sig: 'morale:' + mb, unit: u,
            make: list => {
              const us = list.map(x => x.unit);
              const lowest = Math.min.apply(null, list.map(x => Math.round(x.unit.morale)));
              const screen = us.length === 1
                ? `${us[0].name}士气${word}——${lowest}。`
                : `${us.map(x => x.name).join('、')}士气${word}，最低 ${lowest}。`;
              return utter('INTEL', `${grp(us)}士气${word}。`, screen, { prio: 5, key: 'group:morale:' + mb, units: us.map(x => x.id) });
            },
          });
        }
        if (u.isRouted && !prev.routed) {
          items.push({
            sig: 'rout', unit: u,
            make: list => {
              const us = list.map(x => x.unit);
              return utter('ALERT', `${grp(us)}在溃退！`,
                us.map(x => `${x.name}顶不住了，正在溃退！`).join('\n'),
                { key: 'group:rout', units: us.map(x => x.id) });
            },
          });
        } else if (!u.isRouted && prev.routed) {
          items.push({
            sig: 'rally', unit: u,
            make: list => {
              const us = list.map(x => x.unit);
              return utter('INTEL', `${grp(us)}收住了。`,
                us.map(x => `${x.name}收拢住了，能重新受命。`).join('\n'),
                { prio: 7, key: 'group:rally', units: us.map(x => x.id) });
            },
          });
        }
      }
      watch.set(u.id, { zone, hb, mb, routed: !!u.isRouted, hit: u.hp < u.maxHp });
    }

    // 敌军：只在"看不看得见"这件事跳变时开口。看得见就说方位与距离，脱出就说最后一次在哪。
    const fs = S.enemyFogState();
    for (const e of S.enemies) {
      if (e.hp <= 0) continue;
      const st = fs.get(e.id), prev = foeWatch.get(e.id);
      if (st) {
        if (baselined && (!prev || prev.mode !== st.mode)) {
          if (st.mode === 'live') {
            const d = spanAt(st.x, st.y), bear = bearingAt(st.x, st.y);
            const seen = !!prev;
            items.push({
              make: () => utter('INTEL',
                seen ? `${e.name}又露面了。` : `${e.name}露头了。`,
                seen ? `${e.name}又露面了，${bear}${d != null ? `，约 ${d} 格` : ''}。`
                     : `${e.name}冒头了——${bear}${d != null ? `，约 ${d} 格` : ''}。`,
                { prio: seen ? 7 : 5, key: 'foe:' + e.id + ':live' }),
            });
          } else {
            items.push({
              make: () => utter('INTEL', `${e.name}脱出了。`,
                `${e.name}从视野里脱出去了，往后只能猜。`,
                { prio: 5, key: 'foe:' + e.id + ':gone' }),
            });
          }
        }
        foeWatch.set(e.id, { mode: st.mode, x: st.x, y: st.y });
      } else if (prev) {
        foeWatch.delete(e.id);
        if (baselined) {
          const where = prev.x != null ? `${bearingAt(prev.x, prev.y)}一带` : '原处';
          items.push({
            make: () => utter('INTEL', `${e.name}没影了。`,
              `${e.name}彻底没影了，最后在${where}。`,
              { prio: 4, key: 'foe:' + e.id + ':lost' }),
          });
        }
      }
    }

    // 营地（54：五处分散）：**逐处**报归属变化，不再报"据点控制百分之几"。
    //   五处营地的全部意义就在"哪一处、被谁拿了"——合成一个总百分比，
    //   "敌军摸到了东南营地"这种最该说的一句会被平均掉。
    //   话术落在"能歇脚回血"，因为营地 ㊺ 起不是胜负条件。
    for (const site of (S.sites || [])) {
      const prev = siteWatch.get(site.id);
      if (prev === undefined) { siteWatch.set(site.id, site.holder); continue; }
      if (prev === site.holder) continue;
      siteWatch.set(site.id, site.holder);
      if (!baselined) continue;
      const holder = site.holder;
      items.push({
        make: () => holder === 'blue'
          ? utter('INTEL', `${site.name}拿下了。`, `${site.name}拿下来了，部队可以在营里歇脚回血。`,
              { prio: 6, key: 'intel:site:' + site.id + ':holder' })
          : holder === 'red'
            ? utter('INTEL', `${site.name}被夺了。`, `${site.name}被敌军控住了，他们在营里回血。`,
                { prio: 7, key: 'intel:site:' + site.id + ':holder' })
            : utter('INTEL', `${site.name}空了。`, `${site.name}的控制被压平了。`,
                { prio: 3, key: 'intel:site:' + site.id + ':holder' }),
      });
    }

    // 本营（㊺）：失守是最重的一条消息，副将必须说话，不能只让战报闪一下
    for (const base of S.bases) {
      const own = base.owner === base.side;
      const prev = baseWatch.get(base.id);
      if (prev === undefined) { baseWatch.set(base.id, own); continue; }
      if (prev !== own) {
        baseWatch.set(base.id, own);
        if (baselined) {
          items.push({
            make: () => own
              ? utter('ALERT', `${base.name}夺回来了。`, `${base.name}夺回来了。`, { key: 'alert:base:' + base.id })
              : utter('ALERT', `${base.name}失守！`, `${base.name}失守！全军士气大挫。`, { key: 'alert:base:' + base.id }),
          });
        }
      }
    }

    // 胜负：只说一次（㊺ 起胜负只由主将决定，所以话术直接说主将）
    if (S.result && resultSeen !== S.result) {
      resultSeen = S.result;
      const win = S.result === 'WIN';
      const why = S.resultWhy || (win ? '敌主将阵亡' : '主将阵亡');
      items.push({
        make: () => utter('SYSTEM', win ? '这仗赢了。' : '这仗输了。',
          `${why}，这仗${win ? '赢' : '输'}了。`,
          { key: 'system:result' }),
      });
    }

    // 一坏一好不合并（§4.4 五★）：编组只合并"同一类事"，坏消息与好消息天然不同 sig；
    //   排序交给 prio（队列取出时降序），坏消息自然排在前面。
    const batch = thin(groupChanges(items));
    for (const u of batch) pushQ(u);
    baselined = true;
  }

  function wire(handles) {
    S = handles && handles.sim || null;
    UI = handles && handles.ui || null;
  }
  function reset() {
    watch.clear(); foeWatch.clear(); baseWatch.clear(); siteWatch.clear();
    q.length = 0; baselined = false; resultSeen = null; cool = 0; acc = 0; dropLog.length = 0;
  }

  // ── ③ 命令反馈：结论 → Utterance（§4.1 的映射表，唯一口径）──────────
  // 语音句**必须极短**。理由不是风格，是「永远说完当前一句」这条规则的命门：
  //   不抢占 ⇒ 最坏延迟 = 当前句剩余 + 队前各句。句子一长，回执就等不来了。
  //   所以这里念的只有"收没收到、办没办成"，细节全在 screen。
  const RECEIPT_TEXT = {
    EXECUTED: '得令。',
    PARTIAL: '得令，有人没照办。',
    FAILED: '这令没下成。',
    UNSUPPORTED: '这令办不了。',
    OFFTOPIC: '跟战场无关，没人动。',
    QUEUED: '已挂起，等条件。',
    NO_BRANCH: '这令我没接住。',
    CLARIFY: '这令说不清。',
  };
  function kindOfStatus(status, body) {
    if (status === 'QUEUED') return 'ORDER_WAIT';
    if (status === 'CLARIFY') return 'ASK';
    if (status === 'FAILED' || status === 'UNSUPPORTED' || status === 'OFFTOPIC' || status === 'NO_BRANCH') return 'ORDER_FAIL';
    if (status === 'EXECUTED' || status === 'PARTIAL') return 'ORDER_OK';
    // 没有 status 的纯说明句：看内容判断"是不是坏消息"，不猜动作。
    //   对象（命令回执）没有可读的内容，一律按好消息处理——真失败会带 status。
    return /没实现|没下成|办不了|压不下去|已全歼|无法|没接住/.test(String(typeof body === 'string' ? body : ''))
      ? 'ORDER_FAIL' : 'ORDER_OK';
  }
  let orderSeq = 0;
  function receipt(src, body, status, fb) {
    const screen = render(src, body, status, fb);
    const kind = kindOfStatus(status, body);
    // 屏幕与语音分岔就在这一行：屏幕是上面那句（多行、写全），语音只说定式。
    //   追问例外——它要把短问句念出来，玩家才知道该答话。
    const askTxt = typeof body === 'string' ? body : (body && body.act) || '';
    const text = kind === 'ASK' ? speakable(askShort(askTxt)) : (RECEIPT_TEXT[status] || RECEIPT_TEXT.EXECUTED);
    return utter(kind, text, screen, { key: 'order:' + (orderSeq++), droppable: false, needsAnswer: kind === 'ASK' });
  }
  function remarkU(text) {
    const screen = remark(text);
    return utter('ORDER_OK', '知道了。', screen, { key: 'remark:' + (orderSeq++), droppable: false });
  }
  // 追问：语音只念第一句短问话（≤15 字），编号选项一律留在屏幕上。
  //   把「一、枪兵队；二、骑兵队」念出来是灾难——玩家记不住编号，还得再看一遍屏幕。
  // 括号注记也必须在语音里剔掉：c 层的追问常带「（说的是「…」）」这类补充，
  //   念出来是「括号说的是…括号」，比不念更糟。屏幕上一个字都不少。
  function speakable(q) {
    let t = String(q || '')
      .replace(/[（(][^）)]*[）)]/g, '')
      .replace(/[\n\r]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!t) return '这令说得不够，您再补一句。';
    if (t.length > 15) t = t.slice(0, 14).replace(/[，、；：,;:\s]+$/, '') + '？';
    return t;
  }
  function askU(question, src) {
    const screen = ask(question, src);
    return utter('ASK', speakable(askShort(question)), screen, { key: 'ask:' + (orderSeq++), needsAnswer: true, droppable: false });
  }
  // 汇报：screen 逐队写全，text 一句摘要（§4.1 第 [18] 项验收）
  function reportU(rows) {
    const screen = report(rows);
    let text = '都在按令行事。';
    if (!rows || !rows.length) text = '没有还能动的部队了。';
    else {
      const routed = rows.filter(r => r.state === '溃退').length;
      const hurt = rows.filter(r => r.hp / r.maxHp < 0.65).length;
      if (routed) text = `有 ${routed} 支在溃散。`;
      else if (hurt) text = `${hurt} 支折损较重。`;
      else text = `${rows.length} 支都在按令行事。`;
    }
    return utter('REPORT', text, screen, { key: 'report:' + (orderSeq++), droppable: false });
  }

  // ── ④ 敌情汇报（83）────────────────────────────────────────────
  // 输入是 `SIM.enemyFogState()` 的条目，**已经按迷雾过滤过**（live／lagged／ghost）。
  // 铁律两条：
  //   ① 只说"看得见的"和"多久前看见的"。绝不报"敌军还有 8 支"——那是开图，等于把迷雾机制废掉。
  //   ② 滞后的必须说出年龄。不说的话玩家会拿 2 秒前的位置去下令，而 2 秒足够骑兵跑 9 格。
  function reportFoe(rows) {
    cool = Math.max(cool, 0.9);
    dropLow();
    const list = (rows || []).filter(r => r && r.mode);
    if (!list.length) return '一支敌军都没见着——要么他们还没过来，要么我们还没探到。';
    const where = r => {
      const bear = bearingAt(r.x, r.y), d = spanAt(r.x, r.y);
      return `${bear}${d != null ? `约 ${d} 格` : ''}`;
    };
    const pctOf = r => (r.maxHp && r.hp != null)
      ? `，还剩 ${Math.max(0, Math.round(r.hp / r.maxHp * 100))}%` : '';
    const lines = list.map(r => {
      if (r.mode === 'live') return `${r.name}在${where(r)}${pctOf(r)}。`;
      if (r.mode === 'lagged') return `${r.name}：${Math.round(r.age)} 秒前在${where(r)}${pctOf(r)}，那之后没再看见。`;
      return `${r.name}最后一次露头是 ${Math.round(r.age)} 秒前，在${where(r)}，现在不知道去哪了。`;
    });
    const live = list.filter(r => r.mode === 'live').length;
    const gone = list.length - live;
    const tail = gone ? `\n（${gone} 支只有旧消息；要看实时的，把主将带过去。）` : '';
    return lines.join('\n') + tail;
  }
  function reportFoeU(rows) {
    const screen = reportFoe(rows);
    const list = (rows || []).filter(r => r && r.mode);
    let text;
    if (!list.length) text = '还没见着敌军。';
    else {
      const live = list.filter(r => r.mode === 'live').length;
      text = live ? `看见 ${live} 支敌军。` : '敌军只剩旧消息了。';
    }
    return utter('REPORT', text, screen, { key: 'reportFoe:' + (orderSeq++), droppable: false });
  }

  // 命令回执的出口：**不加「副将：」前缀**（现有观感，adjutant_test 守着）。
  //   顺序仍是先上屏、后交语音——语音层出任何问题都不许影响"看不看得见"（§6.3）。
  function deliverOrder(u) {
    if (!u) return null;
    if (UI && UI.echo) UI.echo(u.screen);
    if (typeof SPEECH !== 'undefined' && SPEECH && SPEECH.say) { try { SPEECH.say(u); } catch (_) {} }
    return u;
  }

  globalThis.ADJUTANT = {
    wire, observe, reset,
    // 老的字符串口（screen 生成器）：留给"只想要那句话"的调用方，行为一字未改
    render, remark, ask, askShort, report,
    // 新的 Utterance 口：c 层只走这两个，屏幕与语音在这里分岔
    receipt, remarkU, askU, reportU, reportFoe, reportFoeU, deliverOrder,
    // 情报的直接出口（observe 内部用，测试也用）
    sayInfo: u => pushInfo(u),
    // 契约（测试与调试读）
    KINDS: KIND_KEYS, assertUtterance, utter, grp, groupChanges, thin,
    ready: () => !!S,
    // 供测试读内部队列，不参与运行逻辑
    _queue: () => q.slice(),
    _dropped: () => dropLog.slice(),
    // 状态词表也交出去（73）：d 层新加一个状态词，副将不认识就会原样吐出
    //   「枪兵队迎敌」这种机器话。测试要能直接查表，而不是靠拼一句话去猜。
    STATE_WORD,
  };
})();
