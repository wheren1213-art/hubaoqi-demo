// troop.js — e1 编制表现层（全局名 TROOP）
//
// 职责只有一件：把"这一支部队此刻长什么样"算成 98 起 **十六个兵位**的世界坐标，交给 ui.js 画。
// 98（Q7B/Q26a/Q34）：兵位 9→16，一支部队从"一个点"变成**松散集合的 footprint**——
//   16 兵仍共享 hp / 命令 / 路径 / 胜负，**不拆真子实体**；footprint 由兵位目标格取整取并集算出，
//   只管占格／堆叠／落点／点选／绘制，寻路与落脚仍只认锚点（Q28a，75 的教训）。
//
// 为什么单独成层（2026-10-31 67，静态审查报告 §2.1）：
//   这些代码原来住在 sim.js 里，`u.men / u.head / u.formKey` 挂在单位记录上，
//   等于"一支＝一条记录"的模拟实体里混进了一份动画状态。它当时不算 bug（数值判定一处都没读），
//   但它是**结构债**：做快照、做存档、换渲染器、转 Unity 时，
//   这份动画状态会跟着模拟一起被搬走，而那些地方没有一样需要它。
//
// 三条界线：
//   ① **只读模拟，不写模拟**。输入是 u.x/u.y/u.path/u.facing/u.targetId/u.alert/u.contact/
//      u.isRouted/u.type/u.hp/u.maxHp/u.leader，外加 SIM.foesWithin()、SIM.stackAt() 这两个查询；
//      输出只给 ui.js。这里不调任何执行器、不改任何字段。
//   ② **状态自己拿着**。动画状态存在下面的 WeakMap 里，不挂回单位。
//      单位被回收 → 状态跟着消失，不需要谁记得来清理（旧写法要手工 prune 一个 Map）。
//   ③ **时钟自己走**。`update()` 吃**真实帧 dt**，不走 20Hz 逻辑步：
//      逻辑步决定"事实"，帧决定"画面"。混用的代价实测过——全场静止时
//      `tick` 连续 40 帧返回全 false、`UI.draw()` 一次都不调，而兵位仍在逼近模板，
//      于是队形冻在"过渡到一半"的样子上。现在由 `update()` 的返回值驱动重绘。
//
// 依赖：必须先于本文件加载 sim.js（要 SIM.TILE / SIM.allUnits / SIM.foesWithin / SIM.facingVec / SIM.stackAt）。
(() => {
  const tile = () => SIM.TILE;

  // ── 编制参数（2026-10-28 ㊵ 立，2026-10-30 ⑸9 改，10-31 67 搬到本层）─────────
  // 关键界线没变：**这些"兵"是表现，不是模拟实体**。战斗、寻路、占位、士气
  //   仍然只认 `units[]` 里那一条记录（一支＝一格）。把它们塞进 allUnits 会立刻
  //   把占位判定、路径代价和攻击结算全部破坏掉，一行都改不回来。
  // 所以编制只影响"画哪儿"，以及"主将是不是在编内"这一条判定。
  //
  // ⑸9 改的是"这一簇怎么排"：从**格内固定 3×3** 改成 **编队坐标系里的 9 个独立位置**。
  //   理由：固定 3×3 无论部队在干什么都长一个样，玩家看不出"这队在行军还是在结阵"。
  //   现在每兵有自己的局部坐标（右 + 前）、自己的过渡速度，阵型模板决定排布，
  //   整簇按 heading 旋转 —— 行军拉成纵阵、接敌摊成线阵、被打散散成一团。
  // **兵位允许跨出本格**（线阵约 1.4 格宽），所以 ui.js 的血条/选中框一律按包围盒算，
  //   不能再按 28px 方框写死。占位判定不受影响：模拟层仍然只认那一格。
  const PARAMS = {
    SLOTS: 16,       // 98（Q8）：9 → 16。**不动 ARMY.length**（它参与 worldgen rng 消耗顺序）
    CORE: 8,         // 98：将位＝每套模板第 8 号位，恒为 (0,0) ⇒ **主将恒在锚点格**（Q29）
    BODY: 4.8,       // 单个兵的边长（世界像素，格宽 28）
    GAP: 1.3,        // 方阵里兵之间的缝：缝要大于描边，否则相邻两兵的黑边连成一张网格，
                     // 看上去还是"一个画着格子的方块"，多单位就白做了（㊵ 实机截图后调的）
    MIN: 1,          // 只剩一个兵也还画一个，不能变成空队
    RATE: 9,         // 队形过渡速率（1/秒）：9 ≈ 0.35 秒站好位，快到不拖沓、慢到看得见"在挪位"
    BOB: 0.6,        // 行军时每兵前后微摆的幅度（世界像素）：0.6 只够"活着"，再大就像抽搐
    SETTLE: 0.05,    // 与模板差小于这个值（世界像素）就算"站好了"——重绘不用再为它出帧
    SEP_R: .42,      // 同格分离半径（格）：同格 k 支的锚点摊在这个圆上
    SEP_MIN: .6,     // 同格分离的**保证值**（格）：任意两支的锚点间距 ≥ 它
    SEP_RATE: 6      // 锚点偏移的缓动速率（1/秒）：堆叠变化时不跳
  };

  // 98（Q29 / overlap_test）：方阵 16 兵位必须**同时**满足「第 CORE 号在锚点 (0,0)」
  //   和「整簇重心仍在格中心」。把对称 4×4 网格里的一个点直接挪到中心会打破对称，
  //   实测单支部队的画面重心偏 0.719px（不是"看着差不多"——那条不变量的红线是 .01px）。
  //   所以把挪出来的偏移**均摊回其余 15 个兵位**：重心精确为 0，主将恒在锚点。
  //   均摊只动 0.026 格（0.7px），仍是收在本格内的 4×4 方阵，不改任何玩法口径。
  const BLOCK_GRID = [];
  //   外圈取 ±.37 而不是 ±.39：加上兵身 4.8px 后包围盒正好还在 1 格内（+ 余量），
  //   内圈仍取 ±.13，保证将位 (0,0) 与最近一兵 > 4.8px（troop_test 两条都盯这个）。
  for (const gy of [-.37, -.13, .13, .37]) for (const gx of [-.37, -.13, .13, .37]) BLOCK_GRID.push([gx, gy]);
  const BLOCK_CELLS = BLOCK_GRID.map((p, i) => i === PARAMS.CORE ? [0, 0] : [p[0], p[1]]);
  //   均摊**按离中心的距离加权**：均摊成常数会把靠中心那一圈推进主将 4.8px 身位以内
  //   （troop_test「十六兵两两不重叠」实测 4.475px），外圈反而几乎不用让。加权后重心仍为 0。
  {
    const sx = BLOCK_CELLS.reduce((s, p) => s + p[0], 0), sy = BLOCK_CELLS.reduce((s, p) => s + p[1], 0);
    const pts = BLOCK_CELLS.filter(p => !(p[0] === 0 && p[1] === 0));   // CORE 不动：主将恒在锚点格
    const wsum = pts.reduce((s, p) => s + p[0] * p[0] + p[1] * p[1], 0) || 1;
    for (const p of pts) {
      const w = (p[0] * p[0] + p[1] * p[1]) / wsum;
      p[0] -= sx * w; p[1] -= sy * w;
    }
  }

  // 阵型模板：局部坐标，**单位＝格**（用时乘 TILE）；x 正＝右翼，y 正＝正面。
  // 下标 CORE 恒为将位。数组顺序＝**填充顺序**：减员时取前 n 个，
  //   所以后排写在前、前排写在后 —— 打残时前排先空，看起来是被打退，不是被挖空。
  // 98（Q9/Q39）：七套模板，每套**正好 16 个局部坐标**，第 `CORE` 号恒为 (0,0)。
  //   单位＝格，允许跨出本格 —— footprint 就是这些**目标坐标**旋转后取整取并集（Q34），
  //   **不读动画状态**：读动画会让 60fps 污染 20Hz，`?seed=` 当场失效。
  //   减员取前 n 个，所以后排写在前、前排写在后（打残时前排先空，看着像被打退）。
  //   坐标全部写死常量，**不用三角函数**：8 方向旋转是查表（见 head8），保住复现。
  const FORM_SLOTS = {
    BLOCK: { name: '方阵', cells: BLOCK_CELLS },       // 结阵待命：4×4 紧凑，仍收在**本格**内
    LINE: { name: '线阵', cells: [                     // 迎敌：正面摊开约 2.7 格（比方阵宽三倍）
      [-1.35, -.16], [-.96, -.16], [-.58, -.16], [-.19, -.16],
      [.19, -.16], [.58, -.16], [.96, -.16], [1.35, -.16],
      [0, 0],
      [-1.35, .16], [-.96, .16], [-.58, .16], [-.19, .16],
      [.58, .16], [.96, .16], [1.35, .16]
    ] },
    COLUMN: { name: '纵阵', cells: [                   // 行军：两列纵队，占道窄、队尾长
      [-.18, -1.05], [.18, -1.05], [-.18, -.75], [.18, -.75],
      [-.18, -.45], [.18, -.45], [-.18, -.15], [.18, -.15],
      [0, 0],
      [.18, .15], [-.18, .45], [.18, .45], [-.18, .75],
      [.18, .75], [-.18, 1.05], [.18, 1.05]
    ] },
    WEDGE: { name: '楔形', cells: [                    // 骑兵冲击：尖端朝前，越往后越宽
      [0, -.95],
      [-.30, -.65], [.30, -.65],
      [-.60, -.35], [0, -.35], [.60, -.35],
      [-.90, -.05], [-.45, -.05],
      [0, 0],
      [.45, -.05], [.90, -.05],
      [-.60, .25], [-.20, .25], [.20, .25], [.60, .25],
      [0, .55]
    ] },
    RING: { name: '圆阵', cells: [                     // 被围：将居中，十五兵围一圈
      [.85, 0], [.78, .33], [.60, .60], [.33, .78],
      [0, .85], [-.33, .78], [-.60, .60], [-.78, .33],
      [0, 0],
      [-.85, 0], [-.78, -.33], [-.60, -.60], [-.33, -.78],
      [0, -.85], [.33, -.78], [.60, -.60]
    ] },
    RUSH: { name: '冲锋乱锋', cells: [                 // 98（Q39）：全力冲锋专属，前冲的松散乱锋
      [-1.15, -.85], [-.55, -1.05], [.10, -.95], [.75, -1.15],
      [-.95, -.35], [-.30, -.55], [.35, -.45], [1.05, -.60],
      [0, 0],
      [-1.20, .25], [-.60, .15], [-.05, .35], [.55, .20],
      [1.15, .40], [-.35, .75], [.45, .85]
    ] },
    SKIRMISH: { name: '散阵', cells: null }            // 溃退/破阵：位置按单位 id 现算，见 scatterSlots
  };

  // 散阵位置：由单位 id 定，**同一支部队每次算出来一样**——每帧随机的话整簇会抖成一片噪声。
  function scatterSlots(u) {
    let h = 2166136261;
    const s = String((u && u.id) || '?');
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    const rnd = () => { h ^= h << 13; h |= 0; h ^= h >>> 17; h ^= h << 5; h |= 0; return (h >>> 0) / 4294967296; };
    const out = [];
    for (let i = 0; i < PARAMS.SLOTS; i++) {
      if (i === PARAMS.CORE) { out.push([0, 0]); continue; }      // 散了也得有个中心，将站中间
      const a = rnd() * Math.PI * 2, r = .30 + rnd() * .34;
      out.push([Math.cos(a) * r * 1.2, Math.sin(a) * r]);        // 横向略扁：人跑起来是横向散开的
    }
    return out;
  }
  function cellsOf(u, key) {
    if (key === 'SKIRMISH') return scatterSlots(u);
    const f = FORM_SLOTS[key];
    return (f && f.cells) || FORM_SLOTS.BLOCK.cells;
  }
  function formationLabel(key) { return (FORM_SLOTS[key] || FORM_SLOTS.BLOCK).name; }

  // 该部队此刻该画几个兵。有将时兵位少一个（将占一个位），将不计入兵数。
  function fillCount(hp, maxHp, led) {
    const body = PARAMS.SLOTS - (led ? 1 : 0);
    const ratio = Math.max(0, Math.min(1, hp / (maxHp || 1)));
    return Math.max(PARAMS.MIN, Math.round(body * ratio));
  }
  function troopFill(u) { return fillCount(u.hp, u.maxHp, !!(u.leader && u.leader.alive)); }

  // ── 同格分离（75）──────────────────────────────────────────────────
  // d 层放开了一格多支（友军共格，上限 OVERLAP.CAP），于是**画面必须跟着放开**：
  //   两支部队画得一模一样，玩家会以为场上只有一支 —— 这就是"看不出有不止一个单位"。
  // 做法：同一格里的单位按 id 排序取序号，锚点在一个小圆上错开。
  //   圆半径 SEP_R（0.42 格）：k≤3 时相邻两支的锚点间距 = 2R·sin(π/k) ≥ 0.72 格，
  //   比保证值 SEP_MIN（0.6 格 ≈ 17 像素）还宽 —— 方阵一簇宽约 0.6 格，
  //   两簇中心隔这么开，边缘刚好不搭上，看得出是两支而不是一坨。
  //   k 超过上限是行军途中的瞬时挤压（分配层不会这么派）：角距仍大于 0，
  //   也就是**永远不会完全重合**，只是分得没那么开。
  // **单独一支在格内时偏移 = 0**：画面和今天一模一样，不给玩家添乱的位移。
  // 偏移走缓动（和兵位一样）：堆叠刚形成/刚散开时不跳。
  // 格子 → 一个固定角度：同一格的圆周方向不随帧变，画面可复现。
  function cellAngle(cx, cy) {
    let h = Math.imul(cx + 1, 73856093) ^ Math.imul(cy + 1, 19349663);
    h = Math.imul(h ^ (h >>> 15), 2246822519);
    h ^= h >>> 13; h = Math.imul(h, 3266489917);
    return ((h >>> 0) % 3600) / 3600 * Math.PI * 2;
  }
  // 这一支在同格里的位次（0 起）。名单由 d 层给（stackAt，按 id 排序），排序稳定 → 顺序可复现。
  function stackSlot(u) {
    if (!u || typeof SIM === 'undefined' || !SIM.stackAt) return { k: 1, rank: 0 };
    const list = SIM.stackAt(Math.round(u.x), Math.round(u.y));
    if (!list || list.length <= 1) return { k: 1, rank: 0 };
    const i = list.indexOf(u);
    return { k: list.length, rank: i < 0 ? 0 : i };
  }
  // 目标偏移（世界像素）。k=1 → 零偏移；k>1 → 均匀摊在圆上。
  function stackTarget(u) {
    const s = stackSlot(u);
    if (s.k <= 1) return { x: 0, y: 0 };
    const T = tile();
    const base = cellAngle(Math.round(u.x), Math.round(u.y));
    const a = base + s.rank * (Math.PI * 2 / s.k);
    const r = PARAMS.SEP_R * T;
    return { x: Math.cos(a) * r, y: Math.sin(a) * r };
  }
  const offsetOf = u => stateOf(u).off;

  // 锚点＝格中心 ＋ 同格分离偏移。**troopMen 与 troopBounds 必须用同一个**，
  //   否则包围盒和兵对不上：点选会挑错部队、血条会飘在兵外面。
  function anchorOf(u, ax, ay) {
    const T = tile();
    // 104：没传锚点时用**连续坐标**——判定格每半格翻一次，拿它锚定会让整簇跳一格。
    if (ax == null) { ax = ((u.cx == null ? u.x : u.cx) + .5) * T; ay = ((u.cy == null ? u.y : u.cy) + .5) * T; }
    const st = stateOf(u);
    return { x: ax + st.off.x, y: ay + st.off.y };
  }

  // ── 动画状态：WeakMap 持有，不挂回单位 ────────────────────────────
  // 一份状态 = { men:[{x,y,k}×16], head:{x,y}, formKey, off:{x,y} }（98 起 16 兵位）
  //   men  ：未旋转的局部坐标（世界像素），每帧向模板逼近
  //   head ：队形朝向（单位向量）。它与 u.facing 是两件事，见 update()
  //   formKey：此刻该用哪套模板
  //   off   ：**同格分离偏移**（世界像素），75 起。同一格里的几支部队靠它错开画。
  const states = new WeakMap();
  function blankState() {
    const T = tile();
    return {
      men: FORM_SLOTS.BLOCK.cells.map(([cx, cy], i) => ({ x: cx * T, y: cy * T, k: .8 + (i % 3) * .2 })),
      head: { x: 0, y: -1 },
      formKey: 'BLOCK',
      off: { x: 0, y: 0 }
    };
  }
  function stateOf(u) {
    if (!u || typeof u !== 'object') return blankState();
    let st = states.get(u);
    if (!st) { st = blankState(); states.set(u, st); }
    return st;
  }
  // 把某支部队的动画状态**直接摆到**某套阵型上（不做过渡）。
  // 用途只有两个：开局铺位，以及测试里造"已经站在某套阵型上"的假单位。
  function setFormation(u, key) {
    const st = stateOf(u);
    const k = FORM_SLOTS[key] ? key : 'BLOCK';
    const cells = cellsOf(u, k);
    const T = tile();
    st.formKey = k;
    for (let i = 0; i < PARAMS.SLOTS; i++) {
      const c = cells[i] || [0, 0];
      st.men[i] = { x: c[0] * T, y: c[1] * T, k: st.men[i] ? st.men[i].k : 1 };
    }
    return st;
  }
  const formKeyOf = u => stateOf(u).formKey;
  const headOf = u => stateOf(u).head;

  // 队形由"这支部队此刻在干什么"推出来，**不另存一份状态**（存了就要有人负责同步，迟早不一致）。
  //   溃退 → 散阵（散阵是"这支已经不成队"的画面说法，只给真散了的人）
  //   接敌 → 骑兵楔形、弓兵线阵、枪兵线阵；被三面围住就收圆阵护将
  //   行军（含撤退）→ 纵阵；其余 → 方阵
  // **破阵不换队形**：强攻/撤退在途也算"破阵"，但那是战备状态、不是队列散了——
  //   把它们也画成散阵，玩家就分不清"这队在冲锋"和"这队已经崩了"。破阵只在面板上报。
  const isEngaged = u => !!u.targetId || u.alert === 'ALERT' || !!u.contact;
  function pickFormation(u) {
    if (!u || u.hp <= 0) return 'BLOCK';
    if (u.isRouted) return 'SKIRMISH';
    // 98（Q36/Q37/Q39）：**只有玩家明确下了全力冲锋令**才切 RUSH。
    //   Q31 那个"自动 isCharging 标签"已取消——系统静默替玩家散队形＝95 禁的"静默替玩家做"。
    //   正常进攻照常按兵种/接战选现有阵型，不额外切楔形。
    if (u.rush) return 'RUSH';
    if (isEngaged(u)) {
      if (u.type === '骑兵') return 'WEDGE';
      if (u.type === '弓兵') return 'LINE';
      if (SIM.foesWithin(u, 2) >= 3) return 'RING';
      return 'LINE';
    }
    if (u.path && u.path.length) return 'COLUMN';
    return 'BLOCK';
  }

  // 表现层的钟（秒）。只用来给行军微摆一个相位，不参与任何判定。
  let clock = 0;

  // 每帧：heading（队形往哪摊）+ 九兵的位次过渡。
  // heading 与 u.facing 是两件事：facing 是**战斗朝向**（正面/侧面/背面判定用它，转到敌人身上），
  //   行军时它是不动的旧值；照着它排队形会出现"整队面朝北、一路往东走"。
  //   所以行军看脚下这一格的方向，接敌看 facing。
  // 返回 true ＝"画面这一帧还得再出一张"：换阵了，或还有兵没站到位、队形还在转。
  function update(list, dt) {
    const arr = list || (typeof SIM !== 'undefined' && SIM.allUnits) || [];
    if (!(dt > 0)) return false;
    clock += dt;
    const T = tile();
    let dirty = false;
    for (const u of arr) {
      if (!u || u.hp <= 0) continue;
      const st = stateOf(u);
      const engaged = isEngaged(u);
      let tx = 0, ty = 0;
      // 行军朝向看"还差多少格"：104 起判定格是最近格，翻格那一刻 u.x 会等于 path[0]，
      //   差变成 (0,0) → 落到 facingVec 的兜底、整队朝东闪一下。所以这里读**连续坐标**。
      if (!engaged && u.path && u.path.length) {
        const n = u.path[0];
        tx = n.x - (u.cx == null ? u.x : u.cx); ty = n.y - (u.cy == null ? u.y : u.cy);
      }
      if (!tx && !ty) { const d = SIM.facingVec(u.facing); tx = d[0]; ty = d[1]; }
      const len = Math.hypot(tx, ty) || 1;
      const want = Math.atan2(ty / len, tx / len);
      const cur = Math.atan2(st.head.y, st.head.x);
      const diff = ((want - cur + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      const a = cur + diff * Math.min(1, dt * (engaged ? 12 : 6));
      st.head.x = Math.cos(a); st.head.y = Math.sin(a);
      if (Math.abs(diff) > .01) dirty = true;      // 队形还在转，画面上整簇在晃

      const key = pickFormation(u);
      if (key !== st.formKey) { st.formKey = key; dirty = true; }
      const cells = cellsOf(u, key);
      let far = 0;
      for (let i = 0; i < PARAMS.SLOTS; i++) {
        const m = st.men[i] || (st.men[i] = { x: 0, y: 0, k: 1 });
        const c = cells[i] || [0, 0];
        const k = 1 - Math.exp(-dt * PARAMS.RATE * (m.k || 1));
        m.x += (c[0] * T - m.x) * k;
        m.y += (c[1] * T - m.y) * k;
        far = Math.max(far, Math.abs(m.x - c[0] * T), Math.abs(m.y - c[1] * T));
      }
      if (far > PARAMS.SETTLE) dirty = true;       // 还有兵在往位上挪

      // 同格分离（75）：锚点偏移缓动到目标位置。堆叠刚形成/刚散开时不跳。
      const tgt = stackTarget(u);
      const k2 = 1 - Math.exp(-dt * PARAMS.SEP_RATE);
      st.off.x += (tgt.x - st.off.x) * k2;
      st.off.y += (tgt.y - st.off.y) * k2;
      if (Math.abs(tgt.x - st.off.x) > PARAMS.SETTLE || Math.abs(tgt.y - st.off.y) > PARAMS.SETTLE) dirty = true;
    }
    return dirty;
  }

  // 兵位世界坐标（格中心锚点 + 按 heading 旋转）。
  //   view 可传一份滞后/快照读数（薄雾区部队要用旧血、旧将领），不传就读本单位。
  //   注意：阵型名现在读的是**动画状态里最后算出来的那个**（67 起），
  //   而不是迷雾快照里存的 formKey——兵位动画一直是实时的，原来只有模板名滞后，
  //   两者本来就不一致，现在统一成"你看到的那一簇就是它现在的样子"。
  function troopMen(u, ax, ay, view) {
    const a = anchorOf(u, ax, ay);
    return menAt(u, a.x, a.y, view);
  }
  function menAt(u, ax, ay, view) {
    const v = view || u;
    const T = tile();
    const st = stateOf(u);
    const hx = st.head.x, hy = st.head.y;
    const hp = v.hp != null ? v.hp : u.hp, maxHp = v.maxHp || u.maxHp;
    const led = !!(v.leader && v.leader.alive);
    const n = fillCount(hp, maxHp, led);
    const fallback = cellsOf(u, v.formKey || st.formKey);
    const moving = !!(u.path && u.path.length);
    const t = clock * 7;
    const out = [];
    let kept = 0;
    for (let i = 0; i < PARAMS.SLOTS; i++) {
      const isLeader = i === PARAMS.CORE && led;
      if (!isLeader) { if (kept >= n) continue; kept++; }
      // 位次是**动画状态**（每帧向模板坐标逼近，见 update），这里只读不推。
      const fc = fallback[i] || [0, 0];
      const m = st.men[i] || { x: fc[0] * T, y: fc[1] * T };
      let lx = m.x, ly = m.y;
      if (moving) ly += Math.sin(t + i * 1.7) * PARAMS.BOB;
      // right = (-hy, hx) 与 forward = (hx, hy) 垂直（y 向下，北是 -y）
      const wx = ax + (-hy) * lx + hx * ly, wy = ay + hx * lx + hy * ly;
      // 98（Q35）：**逐单位裁剪** —— 落在不可站格（水里）的兵不画。
      //   footprint 也不计那一格，两件事用同一把尺子（walkable）。窄桥上整队"被裁扁"
      //   是 Q28a 上司明确接受的视觉代价：footprint 不参与通行，寻路仍只认锚点。
      //   ⚠️ 必须按**相对锚点的格偏移**判，不能拿 `floor(wx/T)`：测试桩传的 ax/ay 可能是 0
      //   （不是真实格心像素），那样会把大半队兵判成"在水里"——90 那种"尺子绕过被测链路"的错。
      if (Number.isFinite(u.x) && Number.isFinite(u.y)) {
        const gdx = Math.round(((-hy) * lx + hx * ly) / T), gdy = Math.round((hx * lx + hy * ly) / T);
        if (!walkable(Math.round(u.x) + gdx, Math.round(u.y) + gdy)) continue;
      }
      out.push({
        x: wx, y: wy,
        leader: isLeader,
        kind: isLeader && v.leader ? v.leader.kind : null
      });
    }
    return out;
  }

  // 编队包围盒（世界像素）：血条、士气条、选中角标、异常框全部按它定位，
  //   否则阵型一摊开，条子还在 28px 方块上方，和兵对不上。
  function troopBounds(u, ax, ay, view) {
    const a = anchorOf(u, ax, ay);
    const B = PARAMS.BODY / 2 + .6;
    const men = menAt(u, a.x, a.y, view);
    if (!men.length) return { x0: a.x - B, y0: a.y - B, x1: a.x + B, y1: a.y + B };
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const m of men) {
      if (m.x - B < x0) x0 = m.x - B;
      if (m.y - B < y0) y0 = m.y - B;
      if (m.x + B > x1) x1 = m.x + B;
      if (m.y + B > y1) y1 = m.y + B;
    }
    return { x0, y0, x1, y1 };
  }

  // ── 98：footprint（Q26a / Q27 / Q29 / Q34 / Q35）────────────────────
  // 8 方向查表：与 `menAt` 用的是同一套 right/forward 旋转，只是把 head 量化到 8 个方向。
  //   **不用 atan2 / Math.cos**：逐方向点积取最大（8 次乘加），结果离散、完全确定、跨平台一致。
  const DIR8 = [
    [0, -1], [.7071, -.7071], [1, 0], [.7071, .7071],
    [0, 1], [-.7071, .7071], [-1, 0], [-.7071, -.7071]
  ];
  function head8(u) {
    const h = stateOf(u).head;
    let best = 0, bd = -Infinity;
    for (let i = 0; i < 8; i++) {
      const p = h.x * DIR8[i][0] + h.y * DIR8[i][1];
      if (p > bd) { bd = p; best = i; }
    }
    return DIR8[best];
  }
  // 一格能不能落脚（**只看地形，不看单位**）：footprint 不参与寻路（Q28a），
  //   这里只是"兵站在水里就别画也别计这一格"的裁剪（Q35）。
  //   node 桩 / 没有地形数据时退回全可画，别让离线测试凭空少一堆兵。
  function walkable(x, y) {
    if (typeof SIM === 'undefined') return true;
    if (SIM.walkableTile) return SIM.walkableTile(x, y);
    return !SIM.inside || SIM.inside(x, y);
  }
  // footprint ＝ 16 个兵位**目标格**取整取并集。锚点格恒在（CORE 位就是 (0,0)，
  //   旋转后仍是 (0,0) ⇒ 主将恒在锚点格，Q29）。允许空洞、允许跨出包围盒（Q35）。
  //   **只读目标阵型、不读动画状态**（Q34）：读动画会让 60fps 污染 20Hz。
  // `atX/atY` 供 d 层**落点分配**用：把同一套模板摆到候选锚点 (cx,cy) 上问"整块 footprint 空不空"，
  //   不修改 u 的任何字段（e1 只读模拟，这条界线不能破）。
  function footprintCells(u, view, formKey, atX, atY) {
    const cells = cellsOf(u, formKey || pickFormation(u));
    const h = head8(u), hx = h[0], hy = h[1];
    const ax = atX != null ? atX : Math.round(u.x), ay = atY != null ? atY : Math.round(u.y);
    const out = [], seen = new Set();
    for (let i = 0; i < PARAMS.SLOTS; i++) {
      const c = cells[i] || [0, 0];
      // right = (-hy, hx)、forward = (hx, hy)，与 menAt 同一套旋转
      const dx = Math.round((-hy) * c[0] + hx * c[1]);
      const dy = Math.round(hx * c[0] + hy * c[1]);
      const k = dx + ',' + dy;
      if (seen.has(k)) continue;
      seen.add(k);
      if (!walkable(ax + dx, ay + dy)) continue;      // 逐单位裁剪：不画也不计这一格
      out.push({ dx, dy, x: ax + dx, y: ay + dy });
    }
    return out;
  }
  // 点选包围盒（Q29）：按 footprint 格范围算，比 troopBounds 更贴合"这一队占了哪几格"。
  //   窄桥被裁扁后包围盒跟着变小，点选不会框到隔壁的桥外格。
  function footprintBounds(u, ax, ay, view) {
    const a = anchorOf(u, ax, ay), T = tile();
    let x0 = a.x - T / 2, y0 = a.y - T / 2, x1 = a.x + T / 2, y1 = a.y + T / 2;
    for (const c of footprintCells(u, view)) {
      x0 = Math.min(x0, a.x + c.dx * T - T / 2); y0 = Math.min(y0, a.y + c.dy * T - T / 2);
      x1 = Math.max(x1, a.x + c.dx * T + T / 2); y1 = Math.max(y1, a.y + c.dy * T + T / 2);
    }
    return { x0, y0, x1, y1 };
  }

  globalThis.TROOP = {
    // 编制参数（e 层内部也读它，测试按名字盯它）
    SLOTS: PARAMS.SLOTS, CORE: PARAMS.CORE, BODY: PARAMS.BODY, GAP: PARAMS.GAP,
    MIN: PARAMS.MIN, RATE: PARAMS.RATE, BOB: PARAMS.BOB, SETTLE: PARAMS.SETTLE,
    SEP_R: PARAMS.SEP_R, SEP_MIN: PARAMS.SEP_MIN, SEP_RATE: PARAMS.SEP_RATE,
    FORMS: FORM_SLOTS,
    // 运行时
    update, troopMen, troopBounds, troopFill, formationLabel, pickFormation,
    formKeyOf, headOf, stateOf, setFormation,
    // 98：松散集合的占格读口（d 层 occupancy 表 / ui 点选都从这里取）
    footprintCells, footprintBounds, head8, DIR8, cellsOf, walkable,
    // 同格分离（75）：offsetOf 给出这一支当前的锚点偏移（世界像素），测试与调试读它
    offsetOf, stackSlot, stackTarget, anchorOf,
    get time() { return clock; }
  };
})();
