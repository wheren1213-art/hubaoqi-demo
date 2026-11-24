// enemy_commander.js — c′ 敌军指挥层：玩家侧 c 层（intent.js）的镜像
// 职责：感知战场（只读 d 层公开查询）→ 按指挥官画像决策 → 经执行器契约给自己的部队下命令。
// 它和玩家 c 层地位对等：都是"意图 → 目标 → 契约下发"，都发同款命令（推进/驻守/攻击/撤退…）。
//
// 预留路径（上司定）：
//   · 难度档位 = PROFILES 参数对象，将来映射主将"统率"值（线性/查表），改数值不改结构；
//   · 军团 legion：一支军团 = 一个指挥官实例 + 若干部队。㊾ 起真的**分成两个**（守备队/主队），
//     多军团不是"将来"了——见 buildLegions。
// 行为等价性：㊾ 起**不再要求**与旧 enemyThink 逐字等价（上司拍板：优化本来就是改行为）。
//   现在三档跑同一套逻辑，只调参数强弱。commander_test 守的是"分层顺序"和"每条能力真的生效"。
(() => {
  let S = null;   // wire(sim) 注入的 d 层句柄（执行器契约 + 公开查询）

  // ── 指挥官画像：难度档位的决策参数。统率值将来映射到这里。 ──
  const PROFILES = {
    // phaseMachine：阶段机开关（easy 关＝只巡逻，不集结不反扑）
    // reinforce：军团协同（求援/支援）；supportRadius：支援呼叫半径
    // ㊺ 四条（胜负改由主将决定）：
    //   huntCommander  看见敌方主将就优先打他（他是对方的胜负手）
    //   guardCommanderDist 玩家进到距我主将多少格 → 携带主将的军团回救
    //   defendBaseDist 玩家进到距我本营多少格 → 守备队回防
    //   garrisonBase   我主将的部队不巡逻，坐镇本营
    //   highGround     占岭（㊻）：只 hard 开（占岭是加分项，不占也能打）
    // ㊻ 四条（此时才真的被读）：
    //   engageDist   接战半径：乘 aggression 后是"够得着"的判定，够不着先逼近
    //   chaseDist    追击上限：已锁定的目标跑出这个距离就放弃追
    //   retreatAt    残血撤退线（占满血百分比）
    //   aggression   凶悍度：放大接战半径
    // ㊾ 新增五条（本轮"会打仗 + 会运营"）：
    //   balanceW     兵力对比权重：局部（7 格内）友军−敌军 乘它进接战分。
    //                这是三档最明显的性格差异——easy 0.6 几乎不算账（看见就冲），
    //                hard 1.5 会先数人头。别调得太高：超过 1.6 之后 2v1 也会被它算成"不敢打"。
    //   flankLimit   同一目标最多几支一起围（第 3 支换目标）。1＝永不叠人，3＝随便叠。
    //   splitGuard   分兵：主将单独守家、其余主攻（见 buildLegions）。easy 不分，全军一起扑。
    //   postRadius   要点守备半径：玩家进到距营地/桥头多少格 → 主队去守（不是"回防据点"）
    //   archerKeep   弓兵保命距离系数：近战贴到 射程×这个系数 以内就后退（0.7×5＝3.5 格）
    // ㊾ 第六条第（实机挖出来的）：
    //   guardLeash  "营门半径"：主将只在营心这个半径内接战，出圈即回。
    //               不是分数、是**硬约束**——理由见 leashLocked() 的注释，别改成"加大守营分"。
    //               ㊿ 起是"出圈即锁、锁住期间不生成接战选项"，带 3 格滞回。
    //               数值跟 defendBaseDist 对齐：同一个圈，主队管圈外、主将管圈内。
    // 52 新增三条（主动进攻）：
    //   press       会不会主动过河打过来。从此 c′ 不再是纯反应式——
    //               "会打仗"不等于"只还手"，玩家不动 90 秒就零接触，那不叫难，那叫没戏。
    //   pressAfter  多久没敌情就出门（秒）。三档差在这里：hard 30 秒就动身，easy 50 秒还在磨蹭。
    //               注意它是"起步"，不是"到场"：起步之后还要在桥头等齐（MASS_TIMEOUT 上限 12 秒）、
    //               再过桥走 10 余格，所以第一波真正压到玩家营前，约是 pressAfter + 15~20 秒。
    //               24 秒起步实测下来太急——玩家刚看清界面，敌军已经在本营门口了。
    //   pressMin    少于几支活着就不打了、缩回东岸。不是"怕"，是"再打下去连看家的都没了"。
    easy:   { engageDist: 7,  investigate: 0, chaseDist: 8,  swapTarget: 2.0, retreatAt: 20, aggression: 0.7, balanceW: 0.6, flankLimit: 3, splitGuard: false, postRadius: 6,  archerKeep: 0.5, guardLeash: 0, phaseMachine: false, reinforce: false, supportRadius: 0,  defendObjDist: 6, huntCommander: false, guardCommanderDist: 0, defendBaseDist: 0, garrisonBase: false, highGround: false, press: true,  pressAfter: 50, pressMin: 3, uncertainty: 0.80 },
    normal: { engageDist: 8,  investigate: 1, chaseDist: 12, swapTarget: 0,   retreatAt: 25, aggression: 1.0, balanceW: 1.0, flankLimit: 2, splitGuard: true,  postRadius: 8,  archerKeep: 0.7, guardLeash: 7, phaseMachine: true,  reinforce: false, supportRadius: 0,  defendObjDist: 6, huntCommander: true,  guardCommanderDist: 5, defendBaseDist: 18, garrisonBase: true,  highGround: false, press: true,  pressAfter: 40, pressMin: 2, uncertainty: 1.00 },
    hard:   { engageDist: 9,  investigate: 1, chaseDist: 16, swapTarget: 0.6, retreatAt: 30, aggression: 1.3, balanceW: 1.5, flankLimit: 2, splitGuard: true,  postRadius: 10, archerKeep: 0.8, guardLeash: 9, phaseMachine: true,  reinforce: true,  supportRadius: 10, defendObjDist: 6, huntCommander: true,  guardCommanderDist: 7, defendBaseDist: 24, garrisonBase: true, highGround: true,  press: true,  pressAfter: 30, pressMin: 2, uncertainty: 1.20 },
  };
  // 默认 hard（2026-10-29 ㊿，上司拍板）：先把最强的一档做成唯一体验，
  //   "怎么往下削"是之后的事——削要基于一个已经调好的满配版本，而不是三个半成品。
  //   三档参数表照旧留着（easy/normal 仍是可切的档位），只是线上不暴露选择。
  let profileName = 'hard';
  function setDifficulty(name){ if (PROFILES[name]) { profileName = name; rebuildLegions(); } }
  function profile(){ return PROFILES[profileName]; }
  // 将来：主将带"统率"字段后，用 统率→档位 映射替换手动 setDifficulty。
  // commanderRating(rating /*0-100*/) { profileName = rating < 40 ? 'easy' : rating < 75 ? 'normal' : 'hard'; }

  // ── 军团编成 ──
  // 一支军团 = 一个指挥官实例 + 若干部队，**每支军团自己感知、自己定阶段**。
  // ㊾ 起真的分两个：守备队（主将自己，守家）＋ 主队（其余，巡逻/反扑）。
  //   为什么必须分开：只有一个军团时，DEFEND_HOME 是"全军团回救"，一告警正面就空了，
  //   玩家只要在主将身边晃一下，整条战线就自己让开——那不是"会防守"，那是"被牵着走"。
  //   分成两队之后，"主将受逼"只有守备队管；主队只在**本营真被踩**或**已失守**时才回。
  class Legion {
    constructor(name, troops, role) {
      this.name = name;
      this.troops = troops;             // 归属本军团的敌军部队引用
      this.role = role || 'both';       // 'home' 守备 | 'field' 主攻 | 'both' 不分兵
      this.decideTimer = 0;
      // 阶段机：PATROL 巡逻戒备 → RALLYING 集结 → ASSAULT 反扑（真的打过去）
      //        → HOLD_POST 守要点（营地/桥头）  ＋ DEFEND_HOME 回救本营（旁路，最高优先）
      //        ＋ PRESS 主动进攻（52：过河压过去，见 pressGoal）
      // ㊾ 修掉两个旧账：
      //   ① 旧 DEFEND_OBJ 的目标是"据点"，而 ㊺ 起据点不判胜负了——全军团为一个不决定胜负的
      //      点跑回来，纯属空转。现在守的是**要点**（营地=回血、桥头=玩家必经、本营=命门）。
      //   ② 旧 RALLYING → DEFEND_OBJ：集结完就往据点走，"反扑"从来没发生过
      //      （集结点设在威胁处，到位后又掉头回家，实际行为是"集结后撤退"）。
      //      现在 RALLYING → ASSAULT，目标就是威胁点，集完真的压上去。
      this.phase = 'PATROL';
      this.alarm = null;                // 当前告警来源：主将受逼 / 本营失守 / 本营受威胁
      this.underAttackSince = null;     // 本军团任一部队最近接敌的时刻
      this.lastThreatAt = null;         // 最后一次"看得见人或被咬"的时刻（ASSAULT 退出用）
      this.rallyAt = null;              // 集结点 / 反扑目标
      this.post = null;                 // HOLD_POST 时守的要点 {x,y,kind}
      this.pressAt = null;              // PRESS 时的入侵目标 {kind, at}
      this.pressStage = null;           // PRESS 的两段：'MASS' 桥头等齐 → 'GO' 过河压上
      this.massUntil = null;            // 等齐的截止时刻（落单的卡住也不能拖死全军）
      // 53 战略意图：军团级"这一段时间我要干什么"。它是**比阶段机更高的一层**——
      //   阶段机管"现在在哪种状态"，意图管"为了什么"。阶段机问它要目标，它不直接下令。
      this.intent = null;               // INTENT.* 之一
      this.intentAt = -99;              // 上次换意图的时刻（最小驻留用）
      this.intentWhy = '';              // 换意图的依据，自检口用
      this.foeMem = new Map();          // 敌情记忆：id → {p:战力, t:时刻, x, y}
      // 54 营地记账：id → 拿下的时刻。五处各记各的——营地不再是"中央一处"，
      //   一个布尔量表达不了"这三处拿过、那两处没走"。
      this.sitesDone = {};
    }
    get prof() { return PROFILES[profileName]; }
  }
  let legions = [];

  // 护卫挑选（㊿）：营里需要一个能挡枪的。
  //   近战（枪/刀）> 弓兵 > 骑兵。理由：骑兵的价值在机动，拴在营门口等于把马当鹿角用；
  //   弓兵在营里能放箭（玩家进营要挨射），但被贴脸就没了，所以排在近战之后。
  const GUARD_RANK = { '枪兵': 3, '刀兵': 3, '弓兵': 2, '骑兵': 1 };
  const escortScore = u => (GUARD_RANK[u.type] || 0) * 10 + (u.hp / (u.maxHp || 100));

  function buildLegions() {
    const all = S.enemies.filter(e => e.patrol);
    const P = PROFILES[profileName];
    const guard = ownCommander();
    // 分兵规模随**人数**派生，不写死"主将＋1 护卫"：
    //   55 的账：原先门槛是 `all.length >= 3`，5 支时分成 2/3 正好，可一到 3 支的图就分成 2/1——
    //   主队只剩 1 支，赢面永远算不过门禁（WIN_HOLD），于是 170 秒一步不动、一处营地不占。
    //   兵力是可变的（demo 5v5、以后可能 3v3 或 8v8），所以"守备队留几支"也得是算出来的：
    //   守备队 = clamp(round(n×0.4), 1, 4)，剩下的给主队；主队少于 2 支就干脆不拆。
    // 2026-11-03（demo 81，8v8）：上限从 2 提到 4。原上限 2 在 5 支时正好，8 支时算出 round(3.2)=3
    //   却被 min(2,…) 压回 2 —— 守备还是 2、主队变 6，玩家 8 支压过去就是 8 打 2，
    //   比 5v5 时代更容易速胜（实测 6/6 全胜、中位 80 秒，见 `.workbuddy/memory/2026-11-02.md`）。
    //   **"封顶"这个念头本身是错的**：它把"兵力可变"写成了"兵力多到一定程度就不再分兵"。
    //   现在上限只防"守备队吃掉主队"，具体值由比例算：8 支 → 3 守备 / 5 主队。
    const guardSize = Math.max(1, Math.min(6, Math.round(all.length * 0.55)));
    // 分兵要求**两边都能成建制**（各 ≥2 支）。兵力不足以两边都成形时，宁可不拆：
    //   3 支拆成 2/1 的话，主队只剩 1 支，赢面永远过不了门禁（WIN_HOLD），
    //   于是 170 秒一步不动、一处营地不占（W6 实机测出来的）。
    //   不拆 ＝ 3 支合成一团、守家与出门都用它，攻守都吃亏，但至少会打。
    const canSplit = P.splitGuard && guard && all.indexOf(guard) >= 0 &&
      guardSize >= 2 && all.length - guardSize >= 2;
    if (!canSplit) legions = [new Legion('本队', all, 'both')];
    else {
      // ㊿ 守备队＝主将＋护卫。㊾ 是主将**孤身**一支守家，实机 41 秒被三支围杀斩将——
      //   那不是"难"，是把胜负手摆在营门口当靶子。主将阵亡即终局，所以营里必须有人挡枪。
      const others = all.filter(u => u !== guard);
      const escort = others.slice().sort((a, b) => escortScore(b) - escortScore(a)).slice(0, guardSize - 1);
      legions = [
        new Legion('守备队', [guard, ...escort], 'home'),
        new Legion('主队', others.filter(u => !escort.includes(u)), 'field'),
      ];
    }
    // 换编成等于换了指挥官：旧的动作记忆（_act/_actUntil）必须清掉，
    //   否则一支部队带着"上一套编制里的当前动作"进新军团，驻留闸会替它挡掉第一次决策。
    for (const L of legions) for (const u of L.troops) { u._act = undefined; u._actUntil = 0; u._leashLock = false; }
  }
  const rebuildLegions = buildLegions;

  function wire(sim) {
    S = sim;
    buildLegions();
  }

  // ── 感知：只读公开查询 ──
  const dist = (a, b) => S.distance(a, b);
  function visibleFrom(e) {
    return S.units.filter(u => u.hp > 0 && S.canSee(e, u));
  }
  // ── 主将与本营（㊺）：一律走 d 层契约，c′ 不读 terrain、不猜坐标 ──
  // 契约缺席时返回 null 而不是抛错：这份 c′ 要能在"没有主将/本营概念"的假 d 层上单独测，
  //   否则每加一条 d 层查询，单测就得跟着改一遍假 S——测试会变成契约的影子。
  const ownCommander = () => (S.commanderOf ? S.commanderOf('red') : null);
  const foeCommander = () => (S.commanderOf ? S.commanderOf('blue') : null);
  const homeBase = () => (S.baseOf ? S.baseOf('red') : null);
  const baseCenter = b => ({ x: (b.x1 + b.x2) / 2, y: (b.y1 + b.y2) / 2 });
  // ── 世界读数（2026-10-29 55）─────────────────────────────────────────
  // 铁律：**这一层以下（c′ 的全部决策）不许出现坐标。**
  //   河在哪、桥在哪、我该在哪岸、最近的通道、桥面占几列、该拿几处营地——
  //   一律问 d 层的 S.read。换图/挪河/增删桥/改营地数量/改人数，读数跟着变，
  //   下面这些函数一行不动。
  //
  // 为什么要立这条（54 的账单）：上一版把"东桥头＝RIVER_X+2""桥面＝[rx, rx+1]"
  //   "该拿三处营地"写进了决策里。地图 80×60→128×96、营地一→五处之后：
  //   ① 桥头等齐点正好落在"桥面判据"的窗口里 → 三支互相谦让，死锁 60 秒；
  //   ② 河一改宽，+2 就落水里；
  //   ③ 营地改八处，"拿三处"这个数就没意义了。
  //   没有一个 bug 是"算错"，全是"把地图的具体形状抄进了策略"。
  const RD = () => (S && S.read) || null;
  // 河占的列范围。d 层没给读数（老 mock）才退化成从 RIVER_X 推——仍然不写死数字。
  function riverSpan() {
    const r = RD();
    if (r && r.river) return r.river();
    const raw = S.RIVER_X;
    const x = (typeof raw === 'number' ? raw : 0);
    return { x1: x, x2: x, width: 1, cx: x };
  }
  // 可渡通道（桥/浅滩）。每条带桥面列范围与两侧桥头。
  function crossingList() {
    const r = RD();
    if (r && r.crossings) return r.crossings();
    // 没有读数时按最常见的形状推：河 1 列、桥比河宽 1 列，桥面 ＝ [rx, rx+1]，
    //   两侧桥头 ＝ rx-1 / rx+2。**这是退化路径**，真机永远走 S.read。
    const R = riverSpan();
    return (S.BRIDGES || []).map(b => {
      const cy = (b.y1 + b.y2) / 2;
      return { y1: b.y1, y2: b.y2, cy, x1: R.x1, x2: R.x1 + 1,
        west: { x: R.x1 - 1, y: cy }, east: { x: R.x1 + 2, y: cy } };
    });
  }
  // 某点在哪一岸。**必须带行号**：57 起河会拐，"x 小于河道"这种判据在河湾处会判反。
  const sideOfPt = p => {
    const r = RD();
    if (r && r.sideOf) return r.sideOf({ x: p.x, y: p.y });
    const R = riverSpan();
    return p.x < R.x1 ? 'west' : p.x > R.x2 ? 'east' : 'river';
  };
  // 本方在哪一岸：按本营位置判（换图后蓝方也可能在东岸，别用队伍名硬编码）
  const homeSide = team => {
    const r = RD();
    if (r && r.homeSide) return r.homeSide(team);
    return team === 'blue' ? 'west' : 'east';
  };
  const onBank = (team, p) => !!p && sideOfPt(p) === homeSide(team);
  // 过河点：离目标最近那条通道，取**我们这岸**的桥头（等齐就在这儿等）。
  function crossingAt(goal) {
    const list = crossingList();
    if (!list.length) return goal ? { x: goal.x, y: goal.y } : null;
    const r = RD();
    let best = null, bd = Infinity;
    if (r && r.crossingNear) best = r.crossingNear(goal);
    if (!best) for (const c of list) {
      const d = goal ? Math.abs(c.cy - goal.y) : 0;
      if (d < bd) { bd = d; best = c; }
    }
    return homeSide('red') === 'west' ? best.west : best.east;
  }

  // 军团还在不在自己这岸的巡防区里。用**重心**判，不用"有一个人出界"：
  //   部队散开时队尾出界是正常的，按单兵判会让整支部队每 0.55 秒在"撤/不撤"之间跳。
  function inOwnZone(L) {
    const Z = S.patrolZone ? S.patrolZone() : null;
    if (!Z) return true;
    const alive = (L ? L.troops : []).filter(u => u.hp > 0 && !u.isRouted);
    if (!alive.length) return true;
    let cx = 0, cy = 0;
    for (const u of alive) { cx += u.x; cy += u.y; }
    cx /= alive.length; cy /= alive.length;
    return cx >= Z.x1 && cx <= Z.x2 && cy >= Z.y1 && cy <= Z.y2;
  }
  // 局部兵力对比（㊾ 1a）：d 层的 localBalance 只数 7 格内的人，正合适——
  //   "远处还有两支友军"救不了这一拍，AI 也不该拿全局兵力给自己壮胆。
  //   契约缺席（假 d 层）返回 null，打分时按"1 对 1"处理。
  const balanceOf = u => (S.localBalance ? S.localBalance(u) : null);

  // ── 告警评估：只回答"哪里着火了"，不做移动、不改任何状态 ──
  // ㊾ 每条告警带 hard 标记：hard＝真在丢（兵已进营 / 本营已失守），软＝逼近。
  //   主攻队只认 hard 的那几条，否则"玩家在主将身边晃一下"就能把整条战线叫回家。
  function assessBase(P) {
    const home = homeBase();
    if (!home) return null;
    const foes = S.units.filter(u => u.hp > 0);
    if (!foes.length) return null;
    const c = baseCenter(home);
    if (home.owner !== home.side) return { why: '本营失守', at: c, hard: true };
    const inside = S.inRect ? foes.some(u => S.inRect(u, home)) : false;
    const nearN = P.defendBaseDist > 0
      ? foes.filter(u => Math.hypot(u.x - c.x, u.y - c.y) <= P.defendBaseDist).length : 0;
    if (inside) return { why: '本营受威胁', at: c, hard: true, troops: nearN };
    if (nearN > 0) return { why: '本营受威胁', at: c, hard: false, troops: nearN };
    return null;
  }
  function assessCommander(P) {
    const g = ownCommander();
    if (!g || g.hp <= 0 || !(P.guardCommanderDist > 0)) return null;
    const near = S.units.some(u => u.hp > 0 && dist(u, g) <= P.guardCommanderDist);
    return near ? { why: '主将受逼', at: { x: g.x, y: g.y }, hard: true } : null;
  }
  function assessHome(P) {
    const g = ownCommander();
    // 主将已经倒了就不再"回救"（本局已经结束，回救没有意义）
    if (g && g.hp > 0) { const a = assessCommander(P); if (a) return a; }
    return assessBase(P);
  }
  // 这支军团该不该管这条告警
  function dutyFor(L, alarm) {
    if (!alarm) return false;
    if (L.role === 'home' || L.role === 'both') return true;    // 守备队/未分兵：全管
    if (alarm.why === '本营失守') return true;                   // 主攻队：本营真丢了要回来夺
    // 主将受逼：主将阵亡＝终局，这不是"分心"，是"这局要没了"——主队必须回。
    //   ㊾ 这里写的是"交给守备队"，而守备队就是主将自己的那支部队：它正在被打，
    //   等于这条告警没人管。实机复现：主将被三支围着，主队在 20 格外 PATROL 到主将阵亡。
    if (alarm.why === '主将受逼') return true;
    if (alarm.why === '本营受威胁') {
      if (alarm.hard) return true;                                // 兵已进营，没得商量
      // 81（8v8 实测的账）：原来只有 hard 才回，于是玩家全军压到营门口时，
      //   主队还在外面抢营——等"兵已进营"再回，主将已经被围死了。
      //   实测 4/4 局玩家全胜、中位 72 秒，红方主队几乎满血没参战。
      //   放宽成"逼近的敌军 ≥3 支才回"：零星骚扰照旧交给守备队（那是它的活），
      //   一支军队压过来才把主队叫回来。**不改成"软告警一律回"**——
      //   那样玩家在主将身边晃一下就能把整条战线叫回家，主队会一直在路上。
      return (alarm.troops || 0) >= 3;
    }
    return false;
  }

  // ── 决策与下发（每 0.55 秒一次，与旧 enemyThink 节拍一致） ──
  function tick(dt) {
    if (!S || S.result) return;
    for (const L of legions) {
      // 逐帧部分：巡逻等待计时衰减 + 目视/有预期时的转向反应（与旧 enemyThink 逐帧段等价）
      for (const e of L.troops) {
        if (e.hp <= 0 || e.isRouted) continue;
        if (e.patrolWait > 0) e.patrolWait = Math.max(0, e.patrolWait - dt);
        // 转向看遇敌档（2026-11-23）：已发现→朝敌，有预期→朝最后目击点，未预期→保持原朝向
        if (e.meet === '已发现' && e.contact) {
          const foe = S.units.find(u => u.id === e.contact.id && u.hp > 0);
          if (foe && S.canSee(e, foe)) S.turnToward(e, S.directionTo(e, foe), dt);
        } else if (e.meet === '有预期' && e.contact) {
          S.turnToward(e, S.directionTo(e, e.contact), dt);
        }
      }
      // 53 态势与意图：1 秒一次（比 0.55 秒的战术拍慢一档——战略不该跟着每一帧抖）。
      //   必须先评估再跑阶段机：阶段机的 PRESS 分支要看 L.intent 才知道往哪去。
      L.assessTimer = (L.assessTimer || 0) - dt;
      if (L.assessTimer <= 0) { L.assessTimer = 1; refreshFoeMem(L); updateIntent(L); }
      if (L.prof.phaseMachine) advancePhase(L, dt);
      L.decideTimer -= dt;
      if (L.decideTimer > 0) continue;
      L.decideTimer = 0.55;
      for (const e of L.troops) decideFor(L, e);
    }
  }

  // ── 阶段机：巡逻 → 集结 → 反扑 → 守要点，本营告警走旁路 ──
  function advancePhase(L, dt) {
    const P = L.prof;
    const alive = L.troops.filter(u => u.hp > 0 && !u.isRouted);
    if (!alive.length) return;
    const engaged = alive.filter(u => u.targetId && S.units.find(x => x.id === u.targetId && x.hp > 0));
    if (engaged.length) { L.underAttackSince = S.simTime; L.lastThreatAt = S.simTime; }

    // 旁路：本营告警（本营失守 > 本营受威胁 > 主将受逼，全在 dutyFor 里按角色分流）
    const alarm = assessHome(P);
    if (alarm && dutyFor(L, alarm)) {
      L.phase = 'DEFEND_HOME'; L.rallyAt = alarm.at; L.alarm = alarm.why;
      return;
    }
    if (L.phase === 'DEFEND_HOME') {          // 告警解除 → 回巡逻（不做记忆：拖着不散会让敌军永远龟在家里）
      L.phase = 'PATROL'; L.alarm = null; L.underAttackSince = null; L.rallyAt = null;
      L.pressStage = null;                    // 半路被叫回家：集结段作废，下次出门重新在桥头等齐
    }

    const threat = threatPoint(L);            // 看得见的玩家部队位置（取最近那支）
    if (threat) L.lastThreatAt = S.simTime;

    // 撤退闸（54）：意图是固守/整补、人却在**巡防区外** → 回家，不问当前在哪一阶段。
    //   为什么必须放在阶段机顶上、而不是 PATROL 分支里：本营 54 起会回血，玩家的战力评估
    //   边打边涨，PRESS/ASSAULT 打到一半就会掉到 WIN_HOLD 以下 → 意图翻成 HOLD。
    //   若 HOLD 只表示"不再前进"，这支部队会插在玩家本营门口：既不撤也不打，标签还写着固守
    //   （实测：敌骑兵队停在 10,55 半分钟，aware[8] 判红）。
    //   从玩家本营退回东岸是 20 多格的路，必须在意图翻转的当拍就起步，
    //   不能等"连续 4 秒没威胁"——那个条件在被人咬住时永远不成立。
    if (L.role === 'field' && (L.intent === INTENT.HOLD || L.intent === INTENT.REGROUP)) {
      const hb = homeBase();
      if (hb && !inOwnZone(L)) {
        L.phase = 'HOLD_POST'; L.post = baseCenter(hb);
        L.rallyAt = null; L.pressAt = null; L.pressStage = null;
        return;
      }
    }

    switch (L.phase) {
      case 'PATROL': {
        // 守备队没有"集结/反扑/守要点"这几项业务（㊾ 3）：它的威胁处理已经全写在打分表里——
        //   圈内迎战、圈外不动。让它跟着 threat 去集结，等于从阶段机绕过 guardLeash 把主将牵出门；
        //   让它去守桥头更离谱：那是主队的活，守备队走了本营就空门。
        if (L.role === 'home') { if (L.post) L.post = null; break; }
        // 53 守势门禁：意图是固守/整补时，**不越河反扑**。
        //   为什么必须在这里管：意图说"打不过，守住"，阶段机却一见威胁就 RALLYING→ASSAULT
        //   往威胁点压——两套意见打架，部队照样过河去送，意图层等于摆设。
        //   （实测证据：53 第一版只给 canPress 加了闸，52 与 53 各跑"玩家不动/玩家推"
        //     两种打法，逐帧结果完全相同——意图根本没被任何人读。）
        //   守势的正确形状：只认**已经过河**的威胁（那是真在打我），河西的不理；
        //   顺带守桥头——玩家想过河就撞上来，地形帮我们打。
        const holding = (L.intent === INTENT.HOLD || L.intent === INTENT.REGROUP);
        // 守势只认**已经过河**的威胁（那是真在打我），河对岸的不理。
        //   判"过没过河"用读数（sideOf），不用 x 跟某个数比——河一挪位置这个判断就废。
        //   顺带守桥头——玩家想过河就撞上来，地形帮我们打。
        const engageThreat = (holding && threat && !onBank('red', threat)) ? null : threat;
        // 整补：撤回本营。营里有回血，血没回就出去打是送——这是"整补"这个名字的全部含义。
        const hb = homeBase();
        if (L.intent === INTENT.REGROUP && hb) {
          L.phase = 'HOLD_POST'; L.post = baseCenter(hb); L.rallyAt = null; break;
        }
        // 威胁判定：有人能看见，或有人已经压到要点上（营地被踩/桥头被贴）
        const post = pickPost(P);
        if (engaged.length || engageThreat || post) {
          L.rallyAt = engageThreat ? clampRally(L, engageThreat) : (post ? { x: post.x, y: post.y } : clampRally(L, engaged[0] || alive[0]));
          L.phase = 'RALLYING';
        } else if (canPress(L)) {
          // 52 主动进攻：没人来，那就自己过去。这一步让"玩家不动"不再等于"没有仗打"。
          //   先 MASS（到桥头等齐）再过河，见 PRESS 分支——部队速度差 1.8 倍，
          //   一起步就各走各的，骑兵会先到 20 秒独自被围杀，那是送不是打。
          L.phase = 'PRESS'; L.pressAt = pressGoal(L);
          L.pressStage = 'MASS'; L.massUntil = S.simTime + MASS_TIMEOUT;
          // 目标在**我们自己这岸**就不去桥头等齐：桥头等齐只对"要过河"有意义。
          //   54 五处营地后这成了常见情况（东北/东南营地在东岸），照旧走桥头等于为了
          //   占自己后方的营地先绕到河边排队——玩家能看出这是"蠢"。
          const onOurBank = !!(L.pressAt && L.pressAt.at && onBank('red', L.pressAt.at));
          if (onOurBank) L.pressStage = 'GO';
          L.rallyAt = onOurBank ? L.pressAt.at : crossingAt(L.pressAt && L.pressAt.at);
          L.post = null;
        } else if (L.post) L.post = null;
        break;
      }
      case 'PRESS': {
        // ① 打光了就缩回东岸。人少还往前压，那不是勇敢，是一支一支送。
        //   53 起多一条同样的闸：**看得见敌情、但会战预言机说打不赢**也撤。
        //   这不是"怕"，是 UAlbertaBot 的做法——预测输就退回重整，别把残兵送进绞肉机。
        if (alive.length < P.pressMin || (foePowerEst(L) > 0.05 && willWin(L) < 0.6)) {
          L.phase = 'PATROL'; L.rallyAt = null; L.pressAt = null; L.pressStage = null; break;
        }
        // ①b 集结段：先到**过河点**（离目标最近那座桥的东桥头），等到齐再上桥。
        //   为什么必须有这一段：三支速度差 1.8 倍（骑 4.5 / 枪 3 / 弓 2.5 格·秒），
        //   一起步就各走各的——实测骑兵先到玩家本营 13 秒，枪弓还在桥上，
        //   骑兵一支顶三支被打崩，后面两支过河正好接上残局。桥只有一座，本来就要排队，
        //   在桥头等齐是**必须付的过路费**，也顺带给了玩家一个能看懂的前兆。
        if (L.pressStage === 'MASS') {
          const at = crossingAt(L.pressAt && L.pressAt.at);
          const ready = alive.filter(u => Math.hypot(u.x - at.x, u.y - at.y) <= MASS_RADIUS).length;
          // 到齐就走；等超时了也走（至少两支到位）——落单的困住不能拖死整支部队
          if (ready >= alive.length || (ready >= 2 && S.simTime >= (L.massUntil || 0))) {
            L.pressStage = 'GO';
          } else {
            L.rallyAt = at;
            break;
          }
        }
        // ② 到营地一笔账：**真拿下才算**（holder 变红）。
        //   曾经写成"有人站进营区就算到过"——54 实测：主队路过东北营地，距离 1 格，
        //   当拍就记成"拿下了"，转身去下一处，五处营地到最后全是 0%，一次回血都没吃到。
        //   "到过"不是目的，"拿下来能歇脚"才是。记下之后不再回头（控制度衰减也不管），
        //   否则部队刚离开 holder 变 null，又会被叫回来——一辈子过不了河（52 的老坑）。
        if (!L.sitesDone) L.sitesDone = {};
        for (const s of allSites()) {
          if (!L.sitesDone[s.id] && s.holder === 'red') L.sitesDone[s.id] = S.simTime;
        }
        // ③ 目标会随战况变（另一处营地 / 本营破了 → 追杀主将），每拍重算
        const g = pressGoal(L);
        if (!g) { L.phase = 'HOLD_POST'; L.pressAt = null; L.pressStage = null; break; }
        // ③b **换了河岸就得重新等齐**（54）。等齐点是"离目标最近那座桥"，目标从
        //   自己这岸的营地（GO，直接走）换成对岸的营地/本营时，队伍已经散在半路上，
        //   照旧 GO 就是各走各的上桥——MASS 那一整段等于没写（实测 63 秒目标从东北营地
        //   切到河岸营地，stage 一直是 GO，桥头一次没等过）。
        //   只在**跨河状态变了**时重置，不按坐标抖动重置：追主将时目标每拍都在动。
        const nowCross = !onBank('red', g.at);
        const wasCross = !!(L.pressAt && L.pressAt.at && !onBank('red', L.pressAt.at));
        if (nowCross !== wasCross) {
          L.pressStage = nowCross ? 'MASS' : 'GO';
          L.massUntil = S.simTime + MASS_TIMEOUT;
        }
        L.pressAt = g; L.rallyAt = g.at;
        break;
      }
      case 'RALLYING': {
        const ready = alive.filter(u => !u.targetId && Math.hypot(u.x - L.rallyAt.x, u.y - L.rallyAt.y) <= 2.5).length;
        // 到位（≥2 支或全军团）→ 反扑。**不是**回防：集结点就在威胁处，下一步就是压上去。
        if (engaged.length + ready >= Math.min(2, alive.length)) L.phase = 'ASSAULT';
        else if (!threat && !engaged.length && !pickPost(P)) { L.phase = 'PATROL'; L.rallyAt = null; }
        break;
      }
      case 'ASSAULT':
        // 连续 4 秒既看不见人也没被咬 → 打完了：有要点就守要点，没有就回巡逻
        if (S.simTime - (L.lastThreatAt || 0) > 4 && !engaged.length) {
          const post = pickPost(P);
          if (post) { L.phase = 'HOLD_POST'; L.post = post; }
          else { L.phase = 'PATROL'; L.rallyAt = null; L.post = null; }
        }
        break;
      case 'HOLD_POST': {
        // 整补期间守的是**本营**，不是"最近的要点"：pickPost 一看没人在附近就打回 PATROL，
        //   那是"养伤养到一半又出门巡逻"。守备队本来就在营里，这条对它没有意义。
        const hb2 = homeBase();
        if (L.role !== 'home' && L.intent === INTENT.REGROUP && hb2) {
          L.post = baseCenter(hb2); L.rallyAt = null; break;
        }
        const post = pickPost(P);
        if (threat || engaged.length) { L.phase = 'ASSAULT'; break; }   // 送上门就先打
        if (!post) { L.phase = 'PATROL'; L.post = null; break; }
        L.post = post;
        break;
      }
    }
  }
  // 把威胁位置夹进巡防区（集结点不越界，否则部队会追过河）
  function clampRally(L, from) {
    // 只在**自己还在区里**时夹。人已经在河对岸（PRESS 压过去了）就不夹：
    //   54 实测的折返就是这么来的——PRESS 到河西看见玩家部队 → RALLYING 拿"被夹回东岸"
    //   的集结点，全队掉头往回走；走回东岸又满足 canPress，再出发。300 秒跑了三个来回，
    //   一次仗没打完。判据用**位置**不用意图：意图和位置打架时，位置才是事实。
    if (!inOwnZone(L)) return { x: Math.round(from.x), y: Math.round(from.y) };
    // 夹进巡防区。区域本身由 d 层按"本营 + 河"派生（sim.js 的 patrolZone() 会把它与本方
    //   河岸取交集），所以这里只是"读一个区域"，不是"抄一组坐标"——
    //   河一挪、本营一换，区域自己跟着变，这一行不用动。
    const Z = S.patrolZone ? S.patrolZone() : null;
    if (!Z) return { x: Math.round(from.x), y: Math.round(from.y) };
    return {
      x: Math.max(Z.x1, Math.min(Z.x2, Math.round(from.x))),
      y: Math.max(Z.y1, Math.min(Z.y2, Math.round(from.y))),
    };
  }
  // 看得见的玩家部队里最近的那支的位置：反扑的目标点
  function threatPoint(L) {
    let best = null, bd = Infinity;
    for (const e of L.troops) {
      if (e.hp <= 0 || e.isRouted) continue;
      for (const u of visibleFrom(e)) {
        const d = dist(e, u);
        if (d < bd) { bd = d; best = { x: u.x, y: u.y }; }
      }
    }
    return best;
  }

  // ══ 主动进攻（52）═════════════════════════════════════════════════════
  // 为什么要有：之前的 c′ 是纯反应式——玩家不动，它就巡逻到天荒地老（实测静置 90 秒**零接触**）。
  //   "会打仗"不等于"只还手"：一个从不主动压上来的对手，玩家没有任何决策压力，
  //   屏幕上能看到的最聪明的行为也只是"被打了才还手"。
  // 目标序列（上司口径：斩将是终局目的，攻营是削士气的战略手段）：
  //   ① **中央营地**——它就在中桥西端（x37-38 / y28-29，河在 39），过河第一步顺手就占；
  //      而且营地是玩家的回血点，占下来等于同时拿到桥头堡和"停掉他的治疗"。
  //   ② **玩家本营**——单独站满 8 秒攻破，玩家全军士气一次性 −32、基准再 −12。
  //      这才是"削士气"的落地动作，也是把玩家逼回来决战的钩子。
  //   ③ **斩将**——本营破了之后才追杀主将。顺序不能反：主将通常守在营边，
  //      先打营能把他的援军钉在原地；反过来先追人，会被牵着走、营也打不下来。
  // 打断：本营/主将告警走 DEFEND_HOME 旁路（assessHome 在阶段机之前判），人少了自动缩回。
  const foeBase = () => (S.baseOf ? S.baseOf('blue') : null);
  const centerOf = b => ({ x: (b.x1 + b.x2) / 2, y: (b.y1 + b.y2) / 2 });

  // ── 营地（54：一处 → 五处分散）──────────────────────────────────────
  // c′ 读营地只有 S.sites 一条口径（兼容口 S.site 只在 mock 里出现）。
  //   为什么不能留第二条：五处各有控制度，任何"取最近/取最该关注"的单点读法都会
  //   在不同调用点算出不同的那一处——意图写着抢 A，目标是 B，自检口查不出来。
  // 配额：营地是**补给**，不是目的。拿满配额还继续扩张，就是把斩将忘了——
  //   玩家会看到一支到处占营、从不来打的军队。
  //   55：配额不再写死"三处"，由营地数量派生（5 处→3，8 处→5）。营地是可变的地图数据，
  //   把它写成常量等于"地图一改，目标序列就跟着错"。
  const siteQuota = () => {
    const r = RD();
    if (r && r.siteQuota) return r.siteQuota();
    return Math.max(1, Math.ceil(allSites().length * 0.6));
  };
  function allSites() {
    if (S.sites && S.sites.length) return S.sites;
    return S.site ? [S.site] : [];
  }
  const siteCenter = s => ({ x: (s.x1 + s.x2) / 2, y: (s.y1 + s.y2) / 2 });
  // 「这处营地拿过没有」＝ 归我了 或 我自己记过账。
  //   **不单看 holder**：控制度没人站会自然衰减（SITE.DECAY），一衰减 holder 就变回 null，
  //   部队刚离开就被叫回去——原地来回，一辈子过不了河（52 的老坑）。
  const siteTaken = (L, s) => !!(s && (s.holder === 'red' || (L && L.sitesDone && L.sitesDone[s.id])));
  function sitesTaken(L) {
    let n = 0;
    for (const s of allSites()) if (L && L.sitesDone && L.sitesDone[s.id]) n++;
    return n;
  }
  // 最近的、我还没拿下的一处营地。距离量**军团里最近的那一支**，不量重心：
  //   部队散开时重心会落在一个没人走的位置，算出"看着近、其实要绕回去"的假近。
  function nextSite(L) {
    let best = null, bd = Infinity;
    const mine = (L ? L.troops : []).filter(u => u.hp > 0 && !u.isRouted);
    const ref = mine.length ? mine : (S.enemies || []).filter(u => u.hp > 0 && !u.isRouted);
    for (const s of allSites()) {
      if (siteTaken(L, s)) continue;
      const c = siteCenter(s);
      // d 必须从 Infinity 起算：从 0 起算时 Math.min 永远得 0，五处距离全是 0，
      //   结果永远是数组里第一个（西北营地）——抢营目标写死成"最远的那个"，
      //   实测就是 30 秒时主队选中 (29,46)，放着 13 格外的东北营地不走。
      let d = ref.length ? Infinity : 0;
      for (const u of ref) d = Math.min(d, Math.hypot(u.x - c.x, u.y - c.y));
      if (d < bd) { bd = d; best = s; }
    }
    return best ? { site: best, at: siteCenter(best), d: bd } : null;
  }
  // 桥面是否已被自己人占住（排队用）：只数"在桥面及两端"的，多算一格是为了让
  //   刚上桥和刚下桥的都不算"让路条件已解除"——否则下一支会在桥尾顶上来，两支部队在桥心对撞。
  // 桥面占用判定：只有**真的站在桥面格上**才算占桥。
  //   52 版窗口是 [rx-1, rx+2]，把"已经在桥头排队的人"也算成在桥上。
  //   54 扩图后这条变成死锁：桥头等齐点正好等于 rx+2，三支站成一排后互相都看见对方"在桥上"，
  //   于是全部原地等——实测弓/骑/枪 停在 (64,45)(64,46)(65,46) 整整 60 秒，玩家在对面站着没人来打。
  //   桥面列范围直接问读数（55）：桥可能 2 列宽、也可能只有 1 列，写死 [rx, rx+1] 就是
  //   把"这张图的桥宽"抄进决策里——54 的死锁正是这么来的（等齐点恰好落进窗口）。
  function bridgeBusyFor(L, e) {
    const deck = crossingAt(L.pressAt && L.pressAt.at);
    const c = crossingList().find(x => x.cy === (deck && deck.y));
    const onDeck = u => !!c && u.x >= c.x1 && u.x <= c.x2 && Math.abs(u.y - c.cy) <= (c.y2 - c.y1) / 2 + 1;
    if (L.troops.some(u => u !== e && u.hp > 0 && !u.isRouted && onDeck(u))) return true;
    // 排队先后：还没上桥的人里，**离桥最近**的那支先走。
    //   少了这条，三支会同时挤上两格桥面（走起来像并排推进，桥的意义就没了）。
    //   只在"我们这岸"的人之间排名次——已经过河的那支不该跟桥头的抢先后。
    const at = c ? c.cy : (deck ? deck.y : 0);
    const waiting = L.troops.filter(u => u.hp > 0 && !u.isRouted && onBank('red', u));
    if (waiting.length < 2) return false;
    const head = waiting.reduce((a, b) => (Math.hypot(a.x - (c ? c.x2 : 0), a.y - at) <
                                           Math.hypot(b.x - (c ? c.x2 : 0), b.y - at) ? a : b));
    if (head === e) { e._queueSince = null; return false; }
    // 保险丝：头车 8 秒没挪窝（寻路失败、被地形卡住），放后面的人走——
    //   宁可挤一点，也不能把整支部队钉死在桥头。这是 54 死锁那条的兜底。
    if (!e._queueSince) e._queueSince = S.simTime;
    return S.simTime - e._queueSince <= 8;
  }
  // 过河前在桥头等齐（52）：到齐半径与最久等待。
  //   TIMEOUT 是保险丝：落单的一支被地形/占位卡住时，不能把整支部队永远钉在桥头。
  const MASS_RADIUS = 3, MASS_TIMEOUT = 12;

  // ══ 战略意图层（53）═════════════════════════════════════════════════
  // 为什么要有：52 的 PRESS 只解决"会不会主动"——等够 30 秒就出门，目标写死成
  //   「营地→本营→斩将」。它不解决"该不该打、打谁"。对着经典 RTS 看，差距就两处：
  //   魔兽 3 的目标优先权**带条件门**，UAlbertaBot **每秒用会战模拟判断赢就上、输就撤**。
  //   我们两样都没有，于是敌人只有"莽"和"等"两个档位。对照见 docs/rts-ai-intent.md。
  //
  // 三条铁律（改这里之前先认）：
  //   ① 意图只决定**去哪、打谁、打不打**，不决定单支部队怎么走——执行仍走 advanceTo/engage，
  //      51/52 修好的落点认领与排队过桥完全不受影响；
  //   ② **门禁优先于分数**：不满足条件的意图不生成，而不是给它低分（51/52 的教训）；
  //   ③ **只能看"看得见的"**：敌情走 visibleFrom + 记忆，绝不读 S.units 全量当敌情——
  //      玩家在雾里调兵、AI 立刻知道，这局就没法玩了。
  const INTENT = {
    DECISIVE: '决战', RAZE_BASE: '破营', HUNT: '斩将', TAKE_CAMP: '抢营',
    HOLD: '固守', REGROUP: '整补', HARASS: '骚扰',
  };
  const TYPE_W = { '枪兵': 1.0, '刀兵': 1.0, '弓兵': 0.95, '骑兵': 1.15 };
  // 战力单位：折成"满血枪兵当量"。士气 70 是基准；**溃退只剩 0.25**——
  //   一支溃退的部队纸面上还有人，实际上已经不在战场上了，不算进战力。
  function unitPower(u) {
    const hp = Math.max(0, u.hp) / (u.maxHp || 100);
    const mor = Math.max(0.3, Math.min(1.4, (u.morale == null ? 70 : u.morale) / 70));
    return hp * (TYPE_W[u.type] || 1) * mor * (u.isRouted ? 0.25 : 1);
  }
  // **两个战力口径，别混用**（混用会让整补永远不触发，且不报错，见下）：
  //   powerOf  —— 带士气，用于"这一仗打不打得赢"（会战预言机）
  //   hpPowerOf —— 只按血，用于"我还剩几成"（整补门禁）
  const powerOf = list => list.filter(u => u.hp > 0).reduce((s, u) => s + unitPower(u), 0);
  // 兵力剩几成：**按血算，不乘士气**。
  //   士气在 unitPower 里最高 ×1.4（100/70）——拿它跟"满编基准"比，40% 的血会被算成 56%，
  //   45% 的整补线就永远够不着（实测：全军三成七的血，pool 读出 57%）。
  //   "还剩几成"本来就是血的问题；士气对战斗的影响另有通道（会战预言机用 unitPower）。
  //   两条口径必须分开，否则一个动作（回营整补）永远不会触发，而且不报错。
  const hpPower = u => Math.max(0, u.hp / (u.maxHp || 100)) * (TYPE_W[u.type] || 1);
  const hpPowerOf = list => list.filter(u => u.hp > 0).reduce((s, u) => s + hpPower(u), 0);
  // 满编基准：按**编制**算（每支满血 × 兵种权重），不是"第一次评估时的血量"。
  //   为什么不能用实时血量当基准：第一次评估若发生在掉血之后（换难度重建军团、
  //   或者从中途局面接手），基准就偏低——"打到只剩三成"也永远到不了 45% 的线。
  let FULL_POWER = 0;
  const fullPower = () => {
    if (FULL_POWER > 0.5) return FULL_POWER;
    let s = 0;
    for (const u of (S.enemies || [])) if (u.hp > 0) s += (TYPE_W[u.type] || 1);
    return (FULL_POWER = Math.max(1, s));
  };

  // 敌情记忆：看见了记下战力，没看见的按 25 秒线性衰减，**不是直接忘掉**。
  //   忘了＝敌人不存在，AI 会一路莽进空营；记死＝一支早撤走的部队永远把它吓得不敢动。
  //   BW 的区域威胁记忆、UAB 的 InformationManager 带时间戳，都是这两条。
  const FOE_MEM_TTL = 25;
  function refreshFoeMem(L) {
    const seen = new Set();
    for (const e of L.troops) {
      if (e.hp <= 0) continue;
      for (const u of visibleFrom(e)) {
        seen.add(u.id);
        L.foeMem.set(u.id, { p: unitPower(u), t: S.simTime, x: u.x, y: u.y });
      }
    }
    for (const [id, m] of L.foeMem) if (!seen.has(id) && S.simTime - m.t > FOE_MEM_TTL) L.foeMem.delete(id);
  }
  // 敌方战力估计 = 记忆衰减后的战力 × 不确定性系数。
  //   uncertainty 是本轮唯一新增的难度旋钮：>1 高估敌人（谨慎、先积累）、<1 低估（更莽）。
  //   这是 Odin 论文的记法，**不是资源作弊**——暴雪那种"Insane 不要资源"我们不做。
  function foePowerEst(L) {
    let p = 0;
    for (const [, m] of L.foeMem) p += m.p * Math.max(0, 1 - Math.max(0, S.simTime - m.t) / FOE_MEM_TTL);
    return p * (L.prof.uncertainty || 1);
  }
  // 会战预言机：只回答"这一仗值不值得打"，**不复算伤害**（伤害仍归 d 层）。
  //   修正只留两个能测的：3 格内友军支援（每支 +10%，上限 +30%）、脚下高地（+10%）。
  //   SparCraft 那种全量模拟，对 3 兵种、公式已知的我们是过度工程。
  function willWin(L) {
    const mine = powerOf(L.troops);
    const foe = foePowerEst(L);
    if (foe <= 0.05) return 99;                        // 视野里没人：没有阻力，出门与否交给门禁
    let mod = 0;
    // 2026-11-03（81）：原来这里遍历的是 `S.enemies`（**别的红方部队**），再问"我有没有一支贴着它"——
    //   也就是只有守备队贴上来才算支援。同一军团四支挤成一团，一支都不加分。
    //   53 定的口径是"队形靠拢 → 支援项生效"，实现和口径反了；8v8 之后主队有四支，
    //   "挤在一起"是常态，这个反着的口径会让会战预言机系统性低估自己。
    //   改回字面意思：**每支身边 3 格内有活着的同伴，+10%，上限 +30%**。
    for (const t of L.troops) {
      if (t.hp <= 0) continue;
      if (L.troops.some(o => o !== t && o.hp > 0 && dist(o, t) <= 3)) mod += 0.1;
    }
    mod = Math.min(0.3, mod);
    if (S.heightAt) {
      const es = L.troops.filter(u => u.hp > 0);
      if (es.length) {
        const avg = es.reduce((s, u) => s + (S.heightAt(Math.round(u.x), Math.round(u.y)) || 0), 0) / es.length;
        if (avg > 0.5) mod += 0.1;
      }
    }
    return mine * (1 + mod) / foe;
  }
  // 敌将孤立＝看得见的敌将，且他 3 格内没有**看得见的**友军。这才是"斩将"的机会窗。
  //   两处都必须走视野：不判可见＝AI 开图。实机后果不是"变聪明"，是**调虎离山一眼被看穿**——
  //   玩家把主将藏到地图角落，AI 照样知道"他落单了"，回头就来斩，玩家会觉得规则在作弊。
  //   （这也是本层第三条铁律"只能看看得见的"的落地处，别图省事改回 S.units 全量。）
  function commanderIsolated(L) {
    const g = foeCommander();
    if (!g || g.hp <= 0) return false;
    const seen = seenFoes(L);
    if (seen.indexOf(g) < 0) return false;
    return !seen.some(u => u !== g && u.hp > 0 && dist(u, g) <= 3);
  }
  function seenFoes(L) {
    const seen = [];
    for (const e of L.troops) {
      if (e.hp <= 0) continue;
      for (const u of visibleFrom(e)) if (seen.indexOf(u) < 0) seen.push(u);
    }
    return seen;
  }
  // 敌方主力位置（最靠拢的那一团）：决战目标
  function visibleMainBody(L) {
    const seen = seenFoes(L);
    let best = null, bn = 0;
    for (const u of seen) {
      const n = seen.filter(o => dist(o, u) <= 6).length;
      if (n > bn) { bn = n; best = u; }
    }
    return best ? { kind: '敌主力', at: { x: best.x, y: best.y }, n: bn } : null;
  }
  // 落单的敌部队（7 格内没有别的友军）：骚扰目标
  function loneFoe(L) {
    const seen = seenFoes(L);
    for (const u of seen) if (!seen.some(o => o !== u && dist(o, u) <= 7)) return { kind: '落单', at: { x: u.x, y: u.y } };
    return null;
  }
  // 意图驻留：4 秒。切换过密就是"抽搐"——战术层已有 SWITCH_MARGIN，战略层用时间闸。
  //   两个例外可以立刻换：HUNT（本营破了，追杀）和 REGROUP（崩了，撤）——那是救火。
  //   **单向**：进入救火项立刻生效，离开照样等满 4 秒。
  const INTENT_DWELL = 4;
  // 会战门槛的两个数（53 定，别凭手感调）：
  //   WIN_HOLD   赢面低于它就不出门。
  //   **不能是 0.85**：foePowerEst 乘了 uncertainty（hard 1.2），"势均力敌"读出来就是 3/3.6=0.83。
  //   0.85 会让 hard 档在 3 打 3 时永远固守——敌人变成缩头乌龟，跟"主动追求胜利"正好相反。
  //   0.75 ＝"敌人估计比我强三成才守"，势均力敌照打。
  //   WIN_DECISIVE 赢面到它、且看得见成团的主力，才选"决战"；否则宁可去拆营
  //   （打人还是拆营是两条路，别混：看得见的那一团交给打分表的接战分去处理）。
  const WIN_HOLD = 0.75, WIN_DECISIVE = 1.15;
  // 意图选择：**列表顺序 + 门禁**，不是加权求和（魔兽 3 的 target priorities 就是这个形状）。
  //   顺序即优先级：先活下来 → 再看打得赢 → 挑要害 → 占地利 → 保持主动。
  function chooseIntent(L) {
    const P = L.prof;
    if (L.role === 'home') return { id: INTENT.HOLD, why: '守备队固守' };
    const my = powerOf(L.troops);
    const allMy = hpPowerOf(S.enemies || []);
    const ratio = willWin(L);
    const fb = S.baseOf ? S.baseOf('blue') : null;
    const baseBroken = !!(fb && fb.owner !== fb.side);
    const next = nextSite(L);
    // 「营地拿了没有」只有一条口径：nextSite + siteTaken（和 pressGoal 共用）。
    //   曾出现过"意图写着抢营、目标其实是本营"——两条口径各算各的，
    //   自检口和实际行为对不上，排查时会被这条误导。
    //   配额见 siteQuota()：拿够了就不再抢营，把兵力交给"破营/斩将"。
    const wantCamp = !!(next && sitesTaken(L) < siteQuota());
    const main = visibleMainBody(L);
    const lone = loneFoe(L);
    const fc = foeCommander();
    if (allMy < fullPower() * 0.45) return { id: INTENT.REGROUP, why: `战力仅 ${Math.round(allMy / fullPower() * 100)}%` };
    if (baseBroken && fc && fc.hp > 0) return { id: INTENT.HUNT, why: '本营已破，追杀主将' };
    if (commanderIsolated(L) && ratio >= 1.0) return { id: INTENT.HUNT, why: '敌将孤立' };
    // 已经压出去的部队**不为"赢面不足"掉头**（54）。区别在于 ratio 是给谁看的：
    //   出门前它是门禁（该不该打）；已经过河/已经在打之后，只有真伤亡（上面的 REGROUP）
    //   才值得撤回。否则会出现折返循环：打分→HOLD→后撤 20 格→敌情记忆衰减→又 PRESS，
    //   实测 300 秒跑了三个来回、一次仗没打完，玩家只会看到一支永远在过桥的军队。
    //   committed 的口径就是"人或意图已经在区外"，和撤退闸同一套判据。
    const committed = !inOwnZone(L) || L.phase === 'PRESS' || L.phase === 'ASSAULT';
    if (ratio < WIN_HOLD && !committed) return { id: INTENT.HOLD, why: `赢面 ${ratio.toFixed(2)} 不足` };
    if (ratio >= WIN_DECISIVE && main && main.n >= 2) return { id: INTENT.DECISIVE, why: `赢面 ${ratio.toFixed(2)}，敌主力可见` };
    if (P.splitGuard && lone && my >= 1.4) return { id: INTENT.HARASS, why: '敌方落单' };
    if (wantCamp) return { id: INTENT.TAKE_CAMP, why: `营地未拿下（${next.site.name || next.site.id}，${Math.round(next.d)} 格）` };
    return { id: INTENT.RAZE_BASE, why: '保持主动' };
  }
  function updateIntent(L) {
    const want = chooseIntent(L);
    if (!L.intent) { L.intent = want.id; L.intentWhy = want.why; L.intentAt = S.simTime; return; }
    if (want.id === L.intent) { L.intentWhy = want.why; return; }
    const urgent = want.id === INTENT.HUNT || want.id === INTENT.REGROUP;
    if (!urgent && S.simTime - (L.intentAt || 0) < INTENT_DWELL) return;
    L.intent = want.id; L.intentWhy = want.why; L.intentAt = S.simTime;
    L.pressStage = null;            // 换了意图就得重新在桥头等齐：方向变了，等齐点也变了
  }

  function pressGoal(L) {
    const it = (L && L.intent) || INTENT.RAZE_BASE;
    // 固守/整补：不出门。**返回 null 本身就是门禁**——不是"给低分"。
    if (it === INTENT.HOLD || it === INTENT.REGROUP) return null;
    // ① 抢营：**最近的一处还没拿下的营地**（54 起营地是分散五处）。
    //   判"拿过没有"用军团自己的账 L.sitesDone，不判 holder（理由见 siteTaken）。
    //   配额到顶就落下去走本营——营地是手段，斩将是目的。
    if (it === INTENT.TAKE_CAMP && sitesTaken(L) < siteQuota()) {
      const g = nextSite(L);
      if (g) return { kind: '营地', at: g.at, site: g.site.id };
    }
    // ② 斩将：只在"营已破"或"敌将孤立"时才会被选到（门禁在 chooseIntent 里）
    if (it === INTENT.HUNT) {
      const fc = foeCommander();
      if (fc && fc.hp > 0) return { kind: '斩将', at: { x: fc.x, y: fc.y } };
    }
    // ③ 决战：打看得见的那一团主力
    if (it === INTENT.DECISIVE) { const m = visibleMainBody(L); if (m) return m; }
    // ④ 骚扰：咬落单的那支（咬完就走，不恋战——HARASS 的退出由阶段机的 threat 判定管）
    if (it === INTENT.HARASS) { const l = loneFoe(L); if (l) return l; }
    // ⑤ 破营（默认）：本营破了就转追杀，否则压向本营
    const pb = foeBase();
    if (!pb) return null;
    if (pb.owner !== pb.side) {
      const fc = foeCommander();
      return (fc && fc.hp > 0) ? { kind: '斩将', at: { x: fc.x, y: fc.y } } : null;
    }
    return { kind: '本营', at: centerOf(pb) };
  }
  // 该不该出门：攒够"没敌情"的时间、人还够、**意图不是固守/整补**、且这支队本来就是主攻队。
  //   53 起多了第三道闸（意图）：赢面不够时 chooseIntent 会给 HOLD/REGROUP，
  //   这里直接不放行——**门禁优于分数**，跟营门锁同一个道理。
  function canPress(L) {
    const P = L.prof;
    // 'both'（没分兵的军团）也要能主动进攻。55 的账：兵力少到不值得分兵时整支部队是 'both'，
    //   而这里原来只放行 'field'——于是 3 支的图上意图明明写着"抢营"，部队 170 秒一步不动。
    //   "不主动追求胜利"正是 53 立意图层要修的病，不能因为编制形态把它放回来。
    //   easy 不受影响：它的 phaseMachine 是关的，走不到这里。
    if (!P.press || (L.role !== 'field' && L.role !== 'both')) return false;
    if (L.intent === INTENT.HOLD || L.intent === INTENT.REGROUP) return false;
    const alive = L.troops.filter(u => u.hp > 0 && !u.isRouted);
    if (alive.length < P.pressMin) return false;
    // 刚打完一仗不立刻压过去：血没回、士气没回，压过去只是送。
    //   lastThreatAt 是"最后一次看见人/被咬"的时刻，null（从没见过人）按 0 算——
    //   玩家龟缩不动时，这一条就是"等够时间就出门"的唯一触发源。
    if (S.simTime - (L.lastThreatAt || 0) < P.pressAfter) return false;
    return !!pressGoal(L);
  }

  // ── 战略要点（㊾ 2b/2d）：三座桥的东岸桥头 ──
  // 为什么是桥头，而不是"回防据点"：
  //   ① 旧实现只会回防据点，而据点 ㊺ 起不判胜负了——全军团为一个不决定胜负的点跑回来，纯空转；
  //   ② 更糟的是**据点在地图西岸（x 37–38，河在 39）**，那是玩家那一侧。让敌军"回防据点"
  //      等于把部队送到对面主场，而且还得先过桥。旧代码里它永远走不到（advanceTo 的目标不可达），
  //      只是没人发现——看起来"敌军在动"，其实在朝河边走。
  //   ③ 桥头＝**我们这岸的桥头**（读数给的），站那儿能同时看见桥面和这岸大路；玩家过河必经，
  //      卡住就是在"拦截"而不是"送死"。三座桥＝三条路，敌军守得住两条就算有防线。
  function postsFor() {
    const out = [];
    for (const c of crossingList()) {
      const p = homeSide('red') === 'west' ? c.west : c.east;
      out.push({ x: p.x, y: c.cy, kind: '桥头' });
    }
    // 营地的价值改走"堵桥"：营地本身不作为守备点（它在地图对面），
    //   但玩家占着营地回血时，他迟早要从某座桥回东岸——堵那座最近的桥，比抢营地实在。
    //   54 起营地是五处：只标**最急的一座桥**（离某一处被占营地最近的那座）。
    //   五处全标等于每座桥都是"最急"，那就等于没有优先级——pickPost 会随便挑一个近的。
    let hot = null, hd = Infinity;
    for (const site of allSites()) {
      if (site.holder !== 'blue') continue;
      const c = siteCenter(site);
      for (const p of out) {
        const d = Math.hypot(p.x - c.x, p.y - c.y);
        if (d < hd) { hd = d; hot = p; }
      }
    }
    if (hot) hot.block = true;        // "堵他回程"的那座桥
    return out;
  }
  function pickPost(P) {
    const posts = postsFor();
    if (!posts.length) return null;
    const foes = S.units.filter(u => u.hp > 0);
    if (!foes.length) return null;
    let best = null, bs = -Infinity;
    for (const p of posts) {
      let d = Infinity;
      for (const u of foes) d = Math.min(d, Math.hypot(u.x - p.x, u.y - p.y));
      // 堵截桥的守备半径放宽：玩家在营地（离桥 4~8 格）也算"要往这儿来"
      const reach = P.postRadius + (p.block ? 6 : 0);
      if (d > reach) continue;
      let s = -d;                                     // 越近越急
      if (p.block) s += 6;                            // 他在营地回血：这座桥最急
      if (d <= 4) s += 2;                             // 已经贴到桥头：急
      if (s > bs) { bs = s; best = p; }
    }
    return best;
  }

  // ══ 效用仲裁（Utility，㊻）═══════════════════════════════════════════════
  // 一个动机＝一个打分项，仲裁函数只干两件事：取分最高者、挡住无意义的抖动。
  //
  // 三条规约（动这里之前先认）：
  //   ① 分数只由**观测 + 查询 + 画像**算，绝不读 d 层内部字段算账——c′ 不是第二个 d 层；
  //   ② 执行仍走原契约（engage / advanceTo / investigate / patrolStep / orderRetreat / orderHoldFire）；
  //   ③ 战略项（回救/守要点）**一律低于"在接触中的接战分"**。理由：背对着眼前的敌人走去干别的，
  //      会被白打——"先打完这一架"几乎永远是对的。战略项真正的作用，是管住"没接触"的那些部队。
  //      **唯一的例外是主将守营**：他已经被牵出营门时，守营 12.2 高于接战。
  //      这一条例外不靠分数保证（接战能到 16.8，压得死任何静态项），靠 leashLocked() 在出圈时直接切断接战选项。
  const ACT = {
    ENGAGE: '接战', APPROACH: '逼近', RETREAT: '脱离', DISENGAGE: '避战',
    DEFEND_HOME: '回救', HOLD_POST: '守要点', ASSAULT: '反扑', PRESS: '进攻',
    HOLD_HOME: '守营', HIGH_GROUND: '占岭', INVESTIGATE: '查证', PATROL: '巡逻',
  };
  // 抖动的两道闸：新选项要**超过现选项 SWITCH_MARGIN 分**才换；换过之后有最短驻留。
  //   为什么非要它：决策 0.55 秒一拍，"守要点 6.5 / 守营 6.0"这种只差半分的两项，
  //   会让部队在营心和要点之间原地抽搐。分数差得小就该承认"两个都对"，然后别动。
  const SWITCH_MARGIN = 1.0, MIN_DWELL = 1.6;
  const HIGH_GROUND_RADIUS = 12, RETREAT_COOLDOWN = 25;
  // 营门滞回（㊿）：出圈 → 锁；退回到 圈半径−3 格 才解锁。
  //   只有"出圈"一半没有另半，会在边界上每拍来回（跨出去→回来→跨出去），
  //   屏幕上就是主将在营门口原地抽搐。
  const LEASH_HYST = 3;

  // ── 目标价值（㊾ 1b）：斩将、兵种克制、可击杀性、孤立 ──
  // 原则：只做**加成**，不改胜负规则，也不复算战斗（克制倍率直接问 d 层的 counterMultiplier）。
  //   为什么要有"可击杀性"：满血枪兵和残血弓兵同价，AI 就永远在挑最近的那个，
  //   而不是"先把这只快死的收掉"——收掉一支，局部兵力对比立刻就变了。
  function targetValue(e, P, u) {
    let v = 0;
    // 斩将：主将战败＝本局结束，所以看见就打。但**必须带条件**——
    //   实机挖出来的坑：1 支残兵撞见对方主将 +2 支护卫（1v3），斩将 +3 把接战分抬到 11，
    //   压过了避战 8.7，于是它一头撞进三倍兵力里送死。"机会"不能盖过"能力"：
    //   兵力不吃亏（我方不少于对方）时斩将才加分，否则这支部队连自身都保不住。
    const mb = balanceOf(e);
    const outmatched = mb ? mb.foes >= mb.allies + 2 : false;
    if (P.huntCommander && u === foeCommander() && !outmatched) v += 3;
    // 兵种克制：1.6→+1.2 / 1.5→+1.0 / 1.35→+0.7 / 0.75→−0.5
    if (S.counterMultiplier) v += (S.counterMultiplier(e, u) - 1) * 2;
    // 可击杀：血越少越值钱（满血 0，残血最高 +2）
    const pct = u.hp / (u.maxHp || 100);
    v += (1 - Math.min(1, Math.max(0, pct))) * 2;
    // 孤立：目标自己 7 格内没有别的友军 → 好咬（围杀孤兵不会招来援军）
    const tb = balanceOf(u);
    if (tb && tb.allies <= 1) v += 0.8;
    return v;
  }
  // 同一目标已经咬了几支（㊾ 1d）
  function claimedBy(L, target, except) {
    let n = 0;
    for (const u of L.troops) if (u !== except && u.hp > 0 && u.targetId === target.id) n++;
    return n;
  }
  // ── 将不离营（㊾ 3，㊿ 改成真硬约束）── 主将的"营门半径"
  // 为什么是硬约束而不是"把守营分调高"：主将阵亡＝本局终局，所以营门外那个问题是
  //   "这局还要不要打"，不是"哪个更划算"。而分数表只能表达偏好——接战分能到 10+价值（最高 15）。
  // ㊾ 的做法是"选目标时撇掉圈外目标 + 出圈给 12.2 分兜底"，**兜不住**：
  //   hard 档接战分 = 10 + 斩将 3 + 兵力项 3（balanceW 1.5 夹到 +2 再乘）+ 孤立 0.8 ≈ 16.8，
  //   12.2 只是看起来比 10 高，遇到满加成仍会输。而且 hard 营门半径 9 > 正面视野 8，
  //   "撇掉圈外目标"这层在 hard 上根本不做事（他看不见 9 格外）。
  // ㊿ 改成锁：出圈即锁，锁住期间**接战/逼近选项不生成**——不是"算完再比"，是没有这个选项。
  //   回到 圈半径−3 格 才解锁（滞回，防边界抽搐）。营门内的敌人照打：玩家真踩进来，
  //   主将当然迎战，这是守家的意思，不是抱头蹲。
  function guardLeashC(e, P) {                        // 营心半径（Infinity＝不设限）
    if (!P.garrisonBase || e !== ownCommander()) return Infinity;
    const home = homeBase();
    return home ? P.guardLeash : Infinity;
  }
  // 营门锁：有副作用（会写 e._leashLock），只该在决策流程里调，别当纯函数用来做断言。
  function leashLocked(e, P, visible) {
    const r = guardLeashC(e, P);
    if (r === Infinity) { e._leashLock = false; return false; }
    const c = baseCenter(homeBase());
    const d = Math.hypot(e.x - c.x, e.y - c.y);
    // 营门外：**一律锁**，被贴身也不解。
    //   实机踩到：原来"贴身即解锁"不分圈内外，主将被追到 14 格外还在打，越打越远（最后到 41 格）。
    //   营外被追的正确反应是往回跑——营里有回血、有护卫，跑到营门里再打。
    if (d > r) { e._leashLock = true; return true; }
    // 营门内被贴身＝营门已被突破，锁失效（这时唯一的选项是"回营心"，而它已经在营心，等于原地挨刀）。
    if (visible && visible.some(u => Math.hypot(u.x - e.x, u.y - e.y) <= 2)) { e._leashLock = false; return false; }
    if (e._leashLock && d <= r - LEASH_HYST) e._leashLock = false;
    return !!e._leashLock;
  }
  // 选目标（含斩将优先、不叠人、换目标迟滞）。返回 {target, sticky}；null＝这一拍不接战。
  function pickTarget(L, e, visible) {
    const P = L.prof;
    // 营门外的东西不进候选池。注意判的是"离**营心**多远"，不是"离自己多远"：
    //   主将自己被牵出去时，贴身的目标也一并撇掉——先回家，出去打赢了也是丢家。
    const leash = guardLeashC(e, P);
    let visible2 = visible;
    if (leash !== Infinity) {
      const c = baseCenter(homeBase());
      visible2 = visible.filter(u => Math.hypot(u.x - c.x, u.y - c.y) <= leash);
      if (!visible2.length) return null;
    }
    // 擒贼先擒王：主将战败＝本局结束，看见就打，跳过迟滞与叠人限制——迟滞是防抖的，
    //   不是为了"放过对方的胜负手"；追击上限照算（chaseDist），否则能被牵着绕全图。
    if (P.huntCommander) {
      const foeC = foeCommander();
      if (foeC && foeC.hp > 0 && visible2.indexOf(foeC) >= 0 && dist(e, foeC) <= P.chaseDist)
        return { target: foeC, sticky: false };
    }
    // 骑兵优先咬弓兵，其余看"可击杀价值 + 距离"的综合分
    let pool = visible2;
    if (e.type === '骑兵') {
      const arcs = visible2.filter(u => u.type === '弓兵');
      if (arcs.length) pool = arcs;
    }
    // 不叠人：已经被 flankLimit 支咬住的目标先放一边。
    //   没有这一条，三支部队各自选最近 → 全叠在同一支上，另外两支敌人白打我们。
    const spread = pool.filter(u => claimedBy(L, u, e) < P.flankLimit);
    const cand = spread.length ? spread : pool;      // 全被咬了还是得上（叠着打总比站着看强）
    const target = cand.slice().sort((a, b) =>
      (targetValue(e, P, b) - dist(e, b) / 6) - (targetValue(e, P, a) - dist(e, a) / 6))[0];
    if (!target) return null;
    const cur = e.targetId ? S.units.find(u => u.id === e.targetId && u.hp > 0) : null;
    // 现目标没有显著更差 → 迟滞期内不换（easy 换得慢，hard 换得快）。
    //   sticky＝"保持，别重新下令"：重发 engage 会把 d 层的路径与 state 打回原点。
    if (cur && cur !== target && dist(e, cur) <= dist(e, target) * P.swapTarget + 1)
      return { target: cur, sticky: true };
    // 追击上限：现目标跑出这个距离 → 放弃追击，回去查证/巡逻
    if (cur && cur === target && dist(e, cur) > P.chaseDist) { S.orderHoldFire(e); return null; }
    return { target, sticky: false };
  }
  // 接战下发（㊾ 1c：弓兵按射程保命）
  function engageAndKite(e, P, target, visible) {
    if (e.type === '弓兵') {
      // 近战贴到 射程×archerKeep 以内就后退。旧写法是"贴到 2 格才退"——弓兵射程 5，
      //   放到 2 格才动，等于两轮齐射的时间白送，射程优势完全没兑现。
      const melee = visible.filter(u => u.type !== '弓兵').sort((a, b) => dist(e, a) - dist(e, b))[0];
      const keep = (e.range || 5) * P.archerKeep;
      if (melee && dist(e, melee) <= keep) { S.engage(e, melee); S.kiteBack(e, melee); return; }
    }
    S.engage(e, target);
  }
  // ── 高地候选（占岭，hard）──
  // 缓存 2 秒：27×27 格每 0.55 秒扫一遍是白烧 CPU，而地形本来就不动。
  let highCache = { key: '', spots: [] };
  function highSpots() {
    if (!S.heightAt || !S.patrolZone) return [];
    const Z = S.patrolZone();
    const key = [Z.x1, Z.y1, Z.x2, Z.y2, Math.floor(S.simTime / 2)].join(',');
    if (highCache.key === key) return highCache.spots;
    const spots = [];
    for (let y = Z.y1; y <= Z.y2; y++) for (let x = Z.x1; x <= Z.x2; x++) {
      const h = S.heightAt(x, y) || 0;
      if (h > 0) spots.push({ x, y, h });
    }
    highCache = { key, spots };
    return spots;
  }
  function bestHighSpot(e) {
    if (!S.heightAt) return null;
    if ((S.heightAt(Math.round(e.x), Math.round(e.y)) || 0) > 0) return null;   // 已在岭上别上下折腾
    let best = null, bd = Infinity;
    for (const s of highSpots()) {
      // 75：占位判据统一走 d 层（cellFree＝这一格真没人）。
      //   旧写法读 S.occupied，那时它的意思是"有人就算占着"；75 起 occupied 变成
      //   "对这一支而言站不站得下"，语义不同，直接拿来会判错。
      const taken = S.cellFree ? !S.cellFree(s.x, s.y, e) : (S.occupied ? S.occupied(s.x, s.y, e) : false);
      if (taken) continue;
      const d = Math.hypot(s.x - e.x, s.y - e.y);
      if (d < bd) { bd = d; best = s; }
    }
    return best && bd <= HIGH_GROUND_RADIUS ? best : null;
  }
  // ── 避战（㊾ 1a）：少打多就往远离威胁的一侧退，退不动了才硬着头皮打 ──
  // 和"脱离"的分工：脱离是**负伤**（orderRetreat，按 d 的安全路线回后方，掉士气）；
  //   避战是**吃亏**（自己找个方向后撤，不掉士气，也不放弃接触）。
  function backoffPoint(L, e, threats) {
    if (!threats || !threats.length) return null;
    // 守备队不吃"往空旷处跑"这一套（㊾ 3）：它跑掉＝本营空门。它的"避战"就是**缩回营里**——
    //   营内回血回士气，站在营门口 1v3 才是真吃亏。方向反过来会把它推出营门，与 guardLeash 直接打架。
    if (L.role === 'home') {
      const home = homeBase();
      if (home) return baseCenter(home);
    }
    let cx = 0, cy = 0;
    for (const t of threats) { cx += t.x; cy += t.y; }
    cx /= threats.length; cy /= threats.length;
    let dx = e.x - cx, dy = e.y - cy;
    let n = Math.hypot(dx, dy);
    if (n < 0.01) { dx = -1; dy = 0; n = 1; }        // 贴身重合：随便给个方向，别算出 (0,0)
    const STEP = 6;
    let x = e.x + (dx / n) * STEP, y = e.y + (dy / n) * STEP;
    const Z = S.patrolZone ? S.patrolZone() : null;
    // 52：只有**自己在巡防区内**时才夹回区内。
    //   过河之后（主动进攻）再夹一次，等于在河西一挨打就往东岸掉头——而威胁往往就卡在它和桥之间，
    //   "退路"正好从敌人身上穿过去，屏幕上看到的是"绕圈跑然后被咬死"。
    //   人在区外时，往哪退交给"背离威胁"决定，再由可通行性兜底。
    const inZone = !Z || (e.x >= Z.x1 && e.x <= Z.x2 && e.y >= Z.y1 && e.y <= Z.y2);
    if (Z && L.role !== 'home' && inZone) {           // 主攻队不退出巡防区；守备队可以退向本营
      x = Math.max(Z.x1, Math.min(Z.x2, x));
      y = Math.max(Z.y1, Math.min(Z.y2, y));
    }
    // 退到河里/林子里＝这条退路不存在，改往本营方向退（"回自己家"永远说得通）
    if (S.tileCost && !Number.isFinite(S.tileCost(e, Math.round(x), Math.round(y)))) {
      const home = homeBase();
      if (home) return baseCenter(home);
    }
    // 被夹到原地（已经贴在区边）→ 改往本营方向退，否则"避战"等于站着不动被打
    if (Math.hypot(x - e.x, y - e.y) < 2) {
      const home = homeBase();
      if (home) {
        const c = baseCenter(home), bx = c.x - x, by = c.y - y, bn = Math.hypot(bx, by) || 1;
        x += (bx / bn) * STEP; y += (by / bn) * STEP;
      }
    }
    return { x, y };
  }

  // ── 一个动机＝一个选项 {a 动作, s 分数, run 怎么下发} ──
  function optionsFor(L, e, visible) {
    const P = L.prof, out = [];
    const guard = ownCommander(), home = homeBase();
    const bal = balanceOf(e);
    const allies = bal ? bal.allies : 1, foes = bal ? bal.foes : (visible.length || 1);
    // 兵力项：局部友军−敌军。夹在 −6..+2，别让"优势巨大"把接战分吹到压倒战略项。
    const balTerm = Math.max(-6, Math.min(2, (allies - foes) * P.balanceW));

    // 兵门锁（㊿）：主将出圈即锁，锁住期间不生成"接战/逼近"——不是算完比分数，是没这个选项。
    //   被贴身（≤2 格）时锁自动失效：玩家已经骑到脸上了，"回营心"等于原地挨刀，这时候只能打。
    const locked = leashLocked(e, P, visible);

    // 明显吃亏（差 2 支以上）且退得掉 → **不生成接战选项**（不是分低，是不给）。
    //   为什么：接战分 = 10 + val + balTerm，而 balTerm 随"7 格内有几支友军"每拍波动；
    //   它和避战 8.2+ 只差零点几分，实机表现是"接战→避战→接战"每 1.6 秒翻一次
    //   （骑兵独自撞上三支时，屏幕上就是一个原地抽搐的骑兵，还被白白磨死）。
    //   门槛取"差 2 支"而不是"少就退"：1v2 是能打的（有克制、有地形），怯到这个程度
    //   会变成"看着敌人不敢动"，那是另一种坏体验。easy 不算账（balanceW 0.6），整条不适用。
    const canBackOff = P.balanceW >= 1.0 && foes >= allies + 2 && !!backoffPoint(L, e, visible);

    // ① 接战 / 逼近（+ 目标价值 + 兵力项）
    if (!locked && !canBackOff && visible.length) {
      const pick = pickTarget(L, e, visible);
      if (pick) {
        const val = targetValue(e, P, pick.target);
        if (pick.sticky) out.push({ a: ACT.ENGAGE, s: 10 + val + balTerm, run: () => {} });
        else if (dist(e, pick.target) <= P.engageDist * P.aggression)
          out.push({ a: ACT.ENGAGE, s: 10 + val + balTerm, run: () => engageAndKite(e, P, pick.target, visible) });
        else out.push({ a: ACT.APPROACH, s: 9.5 + val + balTerm, run: () => S.advanceTo(L, e, pick.target) });
      }
    }

    // ② 避战（㊾ 1a）：少打多就退。只在"确实吃亏"时出现，不出现就不影响分层。
    //   分数放在 8 出头：低于回救（9.x，该回家还是回家），高于反扑/守要点/巡逻。
    if (visible.length && foes > allies) {
      const back = backoffPoint(L, e, visible);
      if (back) out.push({
        a: ACT.DISENGAGE, s: 8.2 + Math.min(1, (foes - allies) * 0.25),
        run: () => { S.orderHoldFire(e); S.advanceTo(L, e, back); },   // 收枪后撤：别一边退一边被咬着
      });
    }

    // ③ 脱离（残血；占满血百分比，各兵种上限不同，用 maxHp 折算）
    //   条件里带 visible：**只有还在接触中才谈得上脱离**。已经脱身了就别再下令，
    //   否则残部会被反复"撤退"成一支永远在跑、永远不回来的部队。
    //   冷却期里这一项**照样留在表里**（只是不再重复下令）：实机踩到的坑——
    //   撤完立刻把选项撤掉，下一拍接战 10 分就赢了，部队当场掉头回去打，
    //   屏幕上只看得到"撤退"闪一下（state 交战、order 撤退）。
    const hpPct = (e.hp / (e.maxHp || 100)) * 100;
    if (visible.length && hpPct <= P.retreatAt && e !== guard) {
      const cooling = S.simTime < (e._retreatUntil || 0);
      out.push({
        a: ACT.RETREAT, s: 13.5 + (P.retreatAt - hpPct) * 0.05,
        run: () => {
          if (cooling) return;                                  // 已在撤退途中：重下令会把路径与状态打回原点
          e._retreatUntil = S.simTime + RETREAT_COOLDOWN;
          S.orderRetreat(e, true);                              // 静默：敌军撤退不该在玩家屏幕上弹提示
        },
      });
    }

    // ④ 回救本营（旁路阶段的落地）：分数按"急不急"分三档，一律低于接战 10。
    //   目的地必须按角色分开：**守备队回营心**，主队才去告警点。
    //   实机踩到：主将受逼的告警点就是主将自己（`assessCommander` 的 at = 主将坐标），
    //   于是守备队执行的是"回救自己"——它在营心时原地不动，它在营外时追着自己的尾巴跑，
    //   被拖到距营心 41 格（营门锁因为"贴身解锁"也没拉住它）。
    if (P.phaseMachine && L.phase === 'DEFEND_HOME') {
      const s = L.alarm === '本营失守' ? 9.8 : L.alarm === '本营受威胁' ? 9.6 : 9.4;
      const dst = (L.role === 'home' && home) ? baseCenter(home) : L.rallyAt;
      if (dst) out.push({ a: ACT.DEFEND_HOME, s, run: () => S.advanceTo(L, e, dst) });
    }

    // ⑤ 集结 / 反扑（ASSAULT）：朝 L.rallyAt 压上去。
    //   看得见人时接战分（10+）会盖过它，所以这一项管的是"看不见但知道大概在哪"的部队——
    //   这正是旧的"集结后回家"缺的那一步：集结点就是威胁点，到位后**继续往那儿走**，不是掉头。
    if (P.phaseMachine && (L.phase === 'ASSAULT' || L.phase === 'RALLYING') && L.rallyAt)
      out.push({ a: L.phase === 'ASSAULT' ? ACT.ASSAULT : ACT.HOLD_POST, s: 7, run: () => S.advanceTo(L, e, L.rallyAt) });

    // ⑤b 主动进攻（52）：朝入侵目标压上去。
    //   和"反扑"同档 7——两者都是"往某处推进"，差别只在目标从哪来（威胁点 vs 入侵序列）。
    //   高于守要点 6.5：正在过河的部队不该半路改去守桥头；低于避战 8.2：
    //   明显吃亏时还是先退，进攻不是"不许回头"。
    //   **桥面排队**：一座桥一次过一支。谁在桥上，其余在桥头等。
    //   不排队的后果是实测出来的：三支同时朝目标走，先到的两支占住桥面，
    //   第三支 findPath 走不通就绕到**南桥**去了——多跑 30 格、从侧翼迟到 15 秒，
    //   屏幕上看着像"这支部队自己想别的事去了"。桥只有一座，排队本来就是必须的。
    if (P.phaseMachine && L.phase === 'PRESS' && L.rallyAt) {
      const stillHome = onBank('red', e);                   // 还在自己这岸（没过河）
      const queueAt = crossingAt(L.pressAt && L.pressAt.at);
      // 桥面排队只在**目标真在河对岸**时成立。54 加这条闸的原因：
      //   抢东北营地（自己这岸）时，全队被判成"在东岸等桥"，
      //   于是全员改道去桥头排队——目标在正北，人却往西南走，营地一次也没拿下来
      //   （实测 30→40 秒质心从 98,43 漂到 93,45，越走越远）。
      //   55：判据改成"目标在不在我这岸"，不再拿 x 跟河边比——河一挪位置这行就错。
      const crossRiver = !onBank('red', L.rallyAt);
      const dst = (crossRiver && stillHome && bridgeBusyFor(L, e)) ? queueAt : L.rallyAt;
      out.push({ a: ACT.PRESS, s: 7, run: () => S.advanceTo(L, e, dst) });
    }

    // ⑥ 守要点（HOLD_POST）：营地（回血）/ 桥头（玩家必经）。到位就站着，被贴上来就转 ASSAULT。
    if (P.phaseMachine && L.phase === 'HOLD_POST' && L.post)
      out.push({ a: ACT.HOLD_POST, s: 6.5, run: () => S.advanceTo(L, e, { x: L.post.x, y: L.post.y }) });

    // ⑦ 守营（将不离营）：守备队全员坐镇营区，不巡逻、不追查证。
    //   放在查证之前——有敌情也不许他们追出去，追出去就没人看家了。
    //   ㊿ 覆盖到**整支守备队**，不只是主将：实机挖出来的——封了占岭之后，护卫弓兵改去巡逻，
    //   照样跑出 22 格，主将身边还是空的。"守备"必须是一种**编制属性**，不是主将一个人的特权。
    //   主将：被锁/出圈 → 20（压过表里一切）；圈内未到营心 → 6（低于接战：踩进来的先打）。
    //   护卫：出营区（>4 格）→ 7（高于守要点/占岭/巡逻，先回营区）；营区内 → 5.5（站住待命）。
    //    主将分支只认 e === guard（不分兵时也成立）；护卫分支只认 role='home' 的非主将成员。
    if (P.garrisonBase && home && (e === guard || L.role === 'home')) {
      const c = baseCenter(home);
      const dd = Math.hypot(e.x - c.x, e.y - c.y);
      if (e === guard) {
        if (locked || dd > P.guardLeash)
          out.push({ a: ACT.HOLD_HOME, s: 20, run: () => S.advanceTo(L, e, c) });
        else if (dd > 1.2) out.push({ a: ACT.HOLD_HOME, s: 6, run: () => S.advanceTo(L, e, c) });
        else out.push({ a: ACT.HOLD_HOME, s: 6, run: () => { e.state = '驻守'; } });
      } else if (dd > 4)
        out.push({ a: ACT.HOLD_HOME, s: 7, run: () => S.advanceTo(L, e, c) });
      else
        out.push({ a: ACT.HOLD_HOME, s: 5.5, run: () => { e.state = '驻守'; } });
    }

    // ⑧ 占岭（hard，只给弓兵）：站高看远（视距 +4.5 格），射界也高。
    //   为什么只给弓兵：三支全爬上去就没人巡逻了，敌人会集体变成山上的摆设；
    //   步骑的价值在机动，弓兵的价值在射界。
    //   ㊿ 再加一条：**守备队不占岭**。实机挖出来的——护卫弓兵跑去岭上（距营心 11 格），
    //   主将又变回孤身一个，"主将＋护卫"这层等于白做。守备队的职责是守营，
    //   离开营区等于营门空虚，与"将不离营"正面冲突；占岭是主队的事。
    if (P.highGround && e.type === '弓兵' && !e.targetId && L.role !== 'home') {
      const here = S.heightAt ? (S.heightAt(Math.round(e.x), Math.round(e.y)) || 0) : 0;
      if (here > 0) out.push({ a: ACT.HIGH_GROUND, s: 5.9, run: () => { e.state = '占岭'; } });
      else {
        const spot = bestHighSpot(e);
        if (spot) out.push({ a: ACT.HIGH_GROUND, s: 5.9, run: () => S.advanceTo(L, e, spot) });
      }
    }

    // ⑨ 查证（定过档、手里有位置，但此刻看不见人）与 ⑩ 巡逻（兜底，永远在场）
    if (e.meet && e.alert !== 'ALERT' && e.contact && P.investigate)
      out.push({ a: ACT.INVESTIGATE, s: 4, run: () => S.investigate(e, e.contact) });
    out.push({ a: ACT.PATROL, s: 2, run: () => S.patrolStep(e) });
    return out;
  }

  // 仲裁：取分最高者；驻留期内、且新选项没明显更好 → 保持原动作。
  //   记在 e._act 上而不是军团的公共变量上：一个军团里三支部队可以各干各的
  //   （一支守营、两支反扑），共用一份"当前动作"会把它们焊死在一起。
  function arbitrate(e, opts) {
    let best = opts[0];
    for (const o of opts) if (o.s > best.s) best = o;
    const cur = e._act;
    if (cur && cur !== best.a && S.simTime < (e._actUntil || 0)) {
      const kept = opts.find(o => o.a === cur);
      if (kept && best.s - kept.s < SWITCH_MARGIN) return kept;
    }
    e._act = best.a; e._actUntil = S.simTime + MIN_DWELL;
    return best;
  }

  function decideFor(L, e) {
    const P = L.prof;
    if (e.hp <= 0 || e.isRouted) return;      // 阵亡/溃退不归指挥官管
    const visible = visibleFrom(e);
    // 军团协同（hard）：被打的部队呼救 → 指挥官派最近的空闲友军去支援。
    //   这是"替别人下令"，不是 e 自己的动作，所以放在打分表**外面**——
    //   塞进表里就会变成"呼救"和"接战"抢同一支队的动作权，两件事根本不在一个层面。
    if (P.reinforce && e.lastHitBy && S.simTime - (e._helpCalledAt || -99) > 6) {
      const helper = L.troops.find(u => u !== e && u.hp > 0 && !u.isRouted && !u.targetId && dist(e, u) <= P.supportRadius);
      if (helper) { e._helpCalledAt = S.simTime; S.investigate(helper, { x: e.x, y: e.y }); }
    }
    // 看不见人＝没有目标可打：先收枪（旧行为，也是被埋伏时的正确反应），再在战略项里挑
    if (!visible.length) S.orderHoldFire(e);
    const pick = arbitrate(e, optionsFor(L, e, visible));
    if (pick) pick.run();
  }

  globalThis.COMMANDER = {
    wire, tick,
    setDifficulty, profile, profileName: () => profileName,
    PROFILES, legions: () => legions,
    // 自检口（单测用）：不执行决策，只把这一拍的打分表算出来。
    //   加它是为了让"分数分层"能被直接断言——否则只能从调用序列侧面猜，
    //   而"为什么它选了回防而不是守营"这种事，靠猜测不出来。
    ACT, scores: (L, e) => optionsFor(L, e, visibleFrom(e)).map(o => ({ a: o.a, s: o.s })).sort((a, b) => b.s - a.s),
    // 要点清单（营地/桥头）也是自检口：运营层的选点是"看不见的决策"，
    //   只能靠把它算出来的东西直接吐出来验（靠最终调用序列反推不出来）。
    posts: (L) => postsFor(),
    // 入侵目标（52）：同上是自检口——"过河去打什么"同样反推不出来。
    //   不传 L 时取主队，方便在控制台看当拍计划。
    press: (L) => pressGoal(L || legions.find(l => l.role === 'field') || legions[0]),
    // 战略意图（53）：自检口。intent/why/willWin/我敌方战力一次吐全，
    //   否则"它为什么选择固守而不是压上"只能靠看回放猜。
    INTENT,
    intent: (L) => {
      const l = L || legions.find(x => x.role === 'field') || legions[0];
      if (!l) return null;
      return {
        id: l.intent, why: l.intentWhy,
        willWin: Number(willWin(l).toFixed(2)),
        myPower: Number(powerOf(l.troops).toFixed(2)),
        foePower: Number(foePowerEst(l).toFixed(2)),
        pool: Number(hpPowerOf(S.enemies || []).toFixed(2)),
        plan: pressGoal(l),
      };
    },
  };
})();
