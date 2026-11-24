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
    BODY: 8.0,       // 单个兵的边长（世界像素，格宽 28）。105：4.8 → 8.0。
    GAP: 3.8,        // 方阵里兵之间的缝（世界像素）＝ 间距 11.8 − 兵身 8.0。
                     //   ⚠️ 这个比例（缝/兵 ≈ 0.47）是**看图定的**，不是算出来的：
                     //   第一版铺开时用了 0.5 格间距 + 7.5 兵（缝 6.5，比例 0.87），
                     //   放大截图里是"撒了一地的方块"——独立感有了，编组感没了。
                     //   现在缝不到兵身一半，看着才是"一群人挤在一起排队"，而不是散兵游勇。
    MIN: 1,          // 只剩一个兵也还画一个，不能变成空队
    RATE: 9,         // 队形过渡速率的**中位值**（1/秒）。108 起每兵在此上下浮动，见 RATE_JIT
    RATE_JIT: .55,   // 108：个体缓动速率的离散幅度。每兵 = RATE × [1−.55, 1+.55] ⇒ [0.55, 1.6] 倍
                     //   原来只有 .8/1.0/1.2 三档、按 i%3 循环——整个三角地带是等距的，
                     //   所以"走得整不整齐"其实由模板坐标决定，跟人没关系。改成按 id 哈希取连续值。
    BOB: 1.5,        // 行军时每兵前后微摆的幅度（世界像素）。108：0.6 → 1.5。
                     //   0.6 只够"不死"——105 把兵身从 4.8 放大到 8.0 之后，1px 的摆幅
                     //   在 8px 的方块上根本读不出来。1.5 是兵身的 19%：看得出在迈步、又不到抽搐。
    PUSH: .35,       // 108：起步延迟的跨度（秒）。最前排立刻走，最后排晚 PUSH 秒。
                     //   依据：队深 2.2 格 ÷ 行速 3 格/秒 ≈ 0.73 秒是"整队鱼贯通过一点"的真实时间；
                     //   起步错峰取它的一半——够看出层次，又不会让队伍散成两截。
    REST: .25,       // 108：停多久才算"真站住"（秒）。不到这个时长的停顿不重设起步基准——
                     //   追击时弓兵每帧清空/重建路径，若每次都重设，尾部兵会被门永久挡住、
                     //   队形冻在半路（位移不受影响，但画面上有人一直不迈步）。
    STRETCH: .16,    // 108：全速时纵向拉长的比例（队形沿行进方向变长）
    SQUEEZE: .08,    // 108：全速时横向收窄的比例（细长＝走得快）
    V_NORM: 3,       // 速度归一化的分母（格/秒）：3 格/秒（枪兵裸速）算"全速"
    SPD_TAU: .3,     // 实际速度估计的平滑时间常数（秒）：cx 只在 20Hz 步里更新，
                     //   帧级位移一帧 0、一帧一大跳，不平滑就没法用
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
  //   （105 把方阵铺开到两格后，均摊量变成 0.09 格 ≈ 2.5px，仍是肉眼不可见的一档。）
  // ── 105：方阵从"收在一格里"改成"铺满两格" ───────────────────────
  // 上司的原话是"一个部队不要死板地站在一个方格里"。98 把方阵压到 ±.37（包围盒 0.91 格）
  //   是**故意**的，为了让待命时一支部队正好占一格；代价是 16 个兵挤在 25px 里，
  //   缝只剩 1.9px、黑边连成一张网格 —— 看着是"打了孔的方块"，不是"一群人"。
  // 现在：**两圈** 4×4（内圈 ±0.34、外圈 ±0.76）、隔行左右错 0.11 格。
  //   为什么不是等距 4×4：`PARAMS.CORE` 那位必须在 (0,0)（主将恒在锚点格），等距网格里
  //   (0,0) 会紧贴最近的兵——间距 0.42 时中心到最近兵只有 0.25 格 ≈ 7px，兵身 8px 就叠了。
  //   把内圈往外推、外圈再往外推，中心自然留出一个"将位"，四个方向都是 0.42 格。
  //   顺带的效果：阵型读起来是"两圈人围着将"，不是一张等距网格。
  //   跨度 ±0.87 格 + 兵身 0.29 ⇒ 包围盒约 1.9 格，**看起来跨两格**。
  //   ⚠️ 占位不是 2×2 而是 3×3：`footprintCells` 按 `round(局部坐标)` 取格，锚点恒在
  //   **格心**，对称块取整只能是 1/3/5 格。要精确 2×2 得把锚点挪到格角，那判定点就与
  //   视觉中心差 0.5 格 —— 正是 104 刚消灭的那个病，不能为一格占位退回去。
  //   所以 9 格是"锚点居中"下铺开的**最小**代价，不是选出来的。
  const BLOCK_RING = [-.76, -.34, .34, .76];
  const BLOCK_GRID = [];
  for (let r = 0; r < 4; r++) {
    const gy = BLOCK_RING[r];
    const shift = (r % 2 === 0) ? -.11 : .11;        // 隔行错开：整列对齐就是棋盘
    for (const gx of BLOCK_RING) BLOCK_GRID.push([gx + shift, gy]);
  }
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
    BLOCK: { name: '方阵', cells: BLOCK_CELLS },       // 结阵待命：4×4 铺开约 1.8 格（105 起跨格）
    LINE: { name: '线阵', cells: [                     // 迎敌：正面摊开约 2.7 格（比方阵宽五成）
      [-1.35, -.16], [-.96, -.16], [-.58, -.16], [-.19, -.16],
      [.19, -.16], [.58, -.16], [.96, -.16], [1.35, -.16],
      [0, 0],
      [-1.35, .16], [-.96, .16], [-.58, .16], [-.19, .16],
      [.58, .16], [.96, .16], [1.35, .16]
    ] },
    COLUMN: { name: '纵阵', cells: [                   // 行军：两列纵队，占道窄、队尾长
      // ── 110：退回 105 的严格两列 ─────────────────────────────────────
      // 108 曾把这里改成"水滴"（前尖后宽、错落不齐），理由是 105 的两列「排列过于整齐」。
      // 109 之后玩家能自己开关戒备，那句话的前提就没了：
      //   **开着戒备行军 = 整齐**（这是纪律，也是"开戒备"唯一看得见的那点代价），
      //   **关掉戒备才是不整齐的**（那一档 110 换成了随机撒点，见 scatterSlots）。
      // 水滴那张表本身没错，但它是"一份写死的坐标、16 支部队长得一模一样"——
      //   论自然不如随机撒点，论整齐不如两列，放在中间这档上两头不占。
      // 三条硬约束（破一条就会静默坏掉）：
      //   ① |x| = 0.18 < 0.5 ⇒ 正面朝上/下时 `Math.round` 后 dx 恒 0，
      //      |y| = 1.20 ∈ (0.5, 1.5] ⇒ dy ∈ {-1,0,1}，footprint 是"锚点格前后各一格"的 3 格竖条。
      //      （斜 45° 时旋转会把 dx 推到 ±1，那是 105 起所有阵型共有的老账，不是这里引入的。）
      //   ② 任意两兵中心距 ≥ 兵身 0.286 格 —— **105 的原表在这一条上是错的**：
      //      它把将位 (0,0) 夹在 (±0.18, ±0.15) 之间，间距只有 0.234 格（6.55px），
      //      108 换水滴时才顺手盖掉。退回两列不能连这个一起退回来，所以整张表按 0.30 重排：
      //      两列 x=±0.18、每排 y 隔 0.30，将单独占 y=0，相邻两排退到 ±0.30（到将 0.350 格）。
      //   ③ 数组顺序＝**填充顺序**，减员取前 n 个 ⇒ 队尾写在前、前尖写在后。
      // 形状：两列 + 前尖一个尖兵（16 位 = 8 + 将 + 6 + 1）。
      [-.18, -1.20], [.18, -1.20],
      [-.18, -.90], [.18, -.90],
      [-.18, -.60], [.18, -.60],
      [-.18, -.30], [.18, -.30],
      [   0,    0],                                     // ← CORE：将恒在锚点格
      [.18,  .30], [-.18,  .30],
      [.18,  .60], [-.18,  .60],
      [.18,  .90], [-.18,  .90],
      [   0, 1.20]                                      // 前尖（前导兵，不是将）
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
    SKIRMISH: { name: '未列阵', cells: null }            // 溃退/破阵：位置按单位 id 现算，见 scatterSlots
  };

  // ── 关掉戒备时的兵位（110 重写）────────────────────────────────────
  // 110 之前是极坐标纯随机（角度 + 半径 0.30~0.64、横向 ×1.2），**不检查间距**。
  //   三个毛病叠在一起变成重叠：① 半径 0.30 以内挖空，11 个兵全挤在 0.34 格厚的薄环里
  //   （一个兵身就 0.286 格，径向塞不下两圈）；② 掷完就落地，不问"这里有没有人"；
  //   ③ 短 id 的哈希熵不足，会出近重复点。实测每支 4~23 对兵中心距 < 8px、最近 0.09px——
  //   11 个人在画面上看像八九个。
  // 现在两处一起改，**面积一格没放大**：
  //   ① **不挖洞**：椭圆盘里均匀撒（半径取 sqrt，否则点全糊在边上）；
  //   ② **拒绝采样**：每落一个兵先跟已落的比距离，< 兵身就重掷（600 次封顶）。
  //      600 次都没落成，取 4000 次里离别人最远的那个（兜底；实测一次都用不到）。
  // 形状：**竖长椭圆、长轴朝行进方向**（局部 y 正＝前方），与 108 的水滴同向。
  //   区别在于水滴是"一份写死的坐标、16 支部队长得一样"，这里**每支部队都不同**（id 做种子）——
  //   上司 110 的原话是「水滴不是阵型，是散阵的自然状态」（原话用的是旧词，111 起统一改称「未列阵」，
  //   引用不改字），自然感来自"每支都不一样"，不是形状本身。
  // 两条硬边界与 COLUMN 同一套：|x| < 0.5 ⇒ 横向不跨格；|y| < 1.5 ⇒ 纵向 ±1 格。
  // 实测（19 支部队 × 11/16 兵 = 38 组）：重叠 0 对、最小间距 8.0px、占格恒 3 格、兜底 0 次。
  const SKIRM_RX = .46, SKIRM_RY = 1.36;
  function buildScatter(id) {
    // 需要连续多个随机值，所以单独开一条 xorshift 流（hash01 只回一个数）
    let h = 2166136261;
    const s = String(id || '?');
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    const rnd = () => { h ^= h << 13; h |= 0; h ^= h >>> 17; h ^= h << 5; h |= 0; return (h >>> 0) / 4294967296; };
    const gap = PARAMS.BODY / tile();                 // 兵身＝0.286 格，格宽恒定所以可缓存
    const gap2 = gap * gap;
    // ⚠️ 将位必须落在 **CORE 号位**（索引 8），不是 0 号——全项目都按
    //   `cells[CORE] === [0,0]` 认将（troop_test 有断言钉着）。第一次写成了 out[0]，当场被抓住。
    const out = new Array(PARAMS.SLOTS).fill(null);
    out[PARAMS.CORE] = [0, 0];
    const placed = [[0, 0]];
    for (let i = 0; i < PARAMS.SLOTS; i++) {
      if (i === PARAMS.CORE) continue;
      let spot = null;
      for (let t = 0; t < 600 && !spot; t++) {
        const a = rnd() * Math.PI * 2, u = Math.sqrt(rnd());
        const px = Math.cos(a) * u * SKIRM_RX, py = Math.sin(a) * u * SKIRM_RY;
        let ok = true;
        for (const q of placed) {
          const dx = px - q[0], dy = py - q[1];
          if (dx * dx + dy * dy < gap2) { ok = false; break; }
        }
        if (ok) spot = [px, py];
      }
      if (!spot) {                                    // 兜底：取离别人最远的那个
        let best = [0, 0], bd = -1;
        for (let t = 0; t < 4000; t++) {
          const a = rnd() * Math.PI * 2, u = Math.sqrt(rnd());
          const px = Math.cos(a) * u * SKIRM_RX, py = Math.sin(a) * u * SKIRM_RY;
          let md = Infinity;
          for (const q of placed) { const dx = px - q[0], dy = py - q[1]; md = Math.min(md, dx * dx + dy * dy); }
          if (md > bd) { bd = md; best = [px, py]; }
        }
        spot = best;
      }
      out[i] = spot;
      placed.push(spot);
    }
    return out;
  }
  // 算一次就够（拒绝采样比原来的纯随机贵三个量级），存在单位状态里——`states` 是 WeakMap，
  //   部队对象回收时缓存自动跟着走，不需要另写清理。
  function scatterSlots(u) {
    const st = stateOf(u);
    if (!st.scat) st.scat = buildScatter(u && u.id);
    return st.scat;
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
      men: FORM_SLOTS.BLOCK.cells.map(([cx, cy], i) => ({ x: cx * T, y: cy * T, k: 1 })),
      head: { x: 0, y: -1 },
      formKey: 'BLOCK',
      off: { x: 0, y: 0 },
      // ── 108 新增：都是**纯画面**的量，d 层一个都不读 ──────────────────
      spd: 0,          // 平滑后的实际速度（格/秒），用于纵向拉伸与微摆幅度
      goAt: -1e9,      // 起步那一帧的 clock（起步延迟的基准）
      pushSpan: 0,     // 这一次起步的错峰跨度（秒，按剩余路程缩放，见 update）
      stopAt: -1e9,    // 上一次开始站立的那一帧（判"停够 REST 没"）
      wasMove: false,  // 上一帧在不在走（检"静止→移动"这个沿）
      rate: null,      // 每兵的缓动速率倍率（懒算，见 rateOf）
      jit: null,       // 每兵的微摆参数 {f, p}（懒算，见 jitterOf）
      scat: null       // 关掉戒备时的兵位（110，懒算，见 scatterSlots／buildScatter）
    };
  }
  function stateOf(u) {
    if (!u || typeof u !== 'object') return blankState();
    let st = states.get(u);
    if (!st) { st = blankState(); states.set(u, st); }
    return st;
  }

  // ── 108：逐兵的"个体差异"（都由 (单位 id, 兵位号) 决定，同一局同一支永远是同一组值）──
  // 为什么不读 Math.random：20Hz 逻辑步与 60fps 渲染会拿到不同的随机流，
  //   `?seed=` 复现当场失效（Q34 的老红线）。这里用 id 哈希，纯函数、可复现、无状态。
  function hash01(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    h ^= h << 13; h |= 0; h ^= h >>> 17; h ^= h << 5; h |= 0;
    return (h >>> 0) / 4294967296;
  }
  // 缓动速率倍率：不是三档循环（旧写法 .8/1.0/1.2 按 i%3 排），是连续值。
  //   末兵慢一点是好事——队伍到位的收尾是"陆陆续续站好"，不是"啪一下齐了"。
  function rateOf(u, i, st) {
    if (!st.rate) st.rate = [];
    let r = st.rate[i];
    if (r == null) r = st.rate[i] = 1 + (hash01(((u && u.id) || '?') + '#' + i) - .5) * 2 * PARAMS.RATE_JIT;
    return r;
  }
  // 微摆参数：频率（rad/s）与相位。频率也逐兵不同——所有人同频摆，看起来是"整体在抖"，
  //   不同频才会读成"各自在迈步"。
  function jitterOf(u, i, st) {
    if (!st.jit) st.jit = [];
    let j = st.jit[i];
    if (!j) {
      const a = hash01(((u && u.id) || '?') + '~f' + i), b = hash01(((u && u.id) || '?') + '~p' + i);
      j = st.jit[i] = { f: 5.6 + a * 3.2, p: b * Math.PI * 2 };
    }
    return j;
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
  //   110 起只有三档：溃退／关掉戒备 → 没有坐标表（随机撒，见 scatterSlots）；
  //   开戒备 + 战斗或停下 → BLOCK；开戒备 + 走且无敌情 → COLUMN。
  const isEngaged = u => !!u.targetId || u.meet === '已发现' || u.meet === '有预期';
  // ── 队形只有三个状态，由"戒备开关 + 遇敌档 + 是否在移动"推出 ──
  // 玩家**不选队形**，只开/关戒备（＝列阵＝战斗准备，`GAME_RULES` §4.9）：
  //   关                          → 未列阵（SKIRMISH）。走也散、停也散。
  //   开 + 已发现/有预期          → 战斗队形（BLOCK），**移动、进攻时也保持**。
  //   开 + 停下                   → 战斗队形（BLOCK）。"停下"与"接敌"在队形上是同一档。
  //   开 + 在走 + 没接敌          → 行军（COLUMN，两列纵队）。
  // 2026-11-23：判据从 `alert` 改成 `u.meet`。`alert` 现在只表示"此刻看不看得见"，
  //   而队形该跟的是**这一波遭遇的档**：已发现/有预期列阵，未预期锁死不能列阵（见 sim 的 updateStanceAuto）。
  //   "未预期"根本到不了这里——它的 stance 被锁在 LOOSE，上面第二行就返回 SKIRMISH 了。
  // 兵种分支（骑兵楔形/弓兵线阵/三支以上圆阵）**已摘**：阵型形态还没设计，`BLOCK` 是占位。
  //   那三套模板的定义仍留在上面（占格与落点都验过，将来设计阵型要参照），只是不再被选。
  function pickFormation(u) {
    if (!u || u.hp <= 0) return 'BLOCK';
    if (u.isRouted) return 'SKIRMISH';                 // 溃退 > 一切
    if (u.stance !== 'FORMED') return 'SKIRMISH';      // 关着戒备＝未列阵（含"未预期"锁死）
    if (u.rush) return 'RUSH';                         // 冲锋是战斗档的特殊形态，不是兵种分支
    const inCombat = u.meet === '已发现' || u.meet === '有预期';
    const moving = !!(u.path && u.path.length);
    if (inCombat || !moving) return 'BLOCK';           // 接敌 或 停下
    return 'COLUMN';                                   // 只有在走且没接敌
  }

  // 表现层的钟（秒）。只用来给行军微摆一个相位，不参与任何判定。
  let clock = 0;

  // 每帧：heading（队形往哪摊）+ 十六兵的位次过渡。
  // heading 与 u.facing 是两件事：facing 是**战斗朝向**（正面/侧面/背面判定用它，转到敌人身上），
  //   行军时它是不动的旧值；照着它排队形会出现"整队面朝北、一路往东走"。
  //
  // ⚠️ 107 起 heading **不再由 e1 自己插值**：唯一账本是 d 层的 `u.turn`
  //   （`sim.js` 的积分器按角速度上限推进，位移速度要按它打折，所以角度只能在那儿算）。
  //   这里只读，不写角度——在 e1 再插值一遍就会分叉：位移那边 0.6 秒转完、队形这边 0.17 秒
  //   转完，画面是"队形已经朝东、人还在往西漂"。两个账本必然迟早不一致（103 的教训）。
  //   没有 `turn` 的单位（测试里手造的假单位、还没被积分器碰过的）退回旧算法，
  //   这样 `troop_test` 之类能单独驱动 e1 而不必先跑一遍 sim。
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
      let a;
      if (Number.isFinite(u.turn)) {
        a = u.turn;
      } else {
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
        // 107：折角统一用 atan2(sin,cos)。原来那套 `((d+3π)%2π)-π` 在 JS 里对负数取模返回负，
        //   越过 ±π 那一帧会翻符号——107 探针实测反向途中冒出一帧 +45° 的抽动。
        const diff = Math.atan2(Math.sin(want - cur), Math.cos(want - cur));
        a = cur + diff * Math.min(1, dt * (engaged ? 12 : 6));
      }
      const prevA = Math.atan2(st.head.y, st.head.x);
      st.head.x = Math.cos(a); st.head.y = Math.sin(a);
      if (Math.abs(Math.atan2(Math.sin(a - prevA), Math.cos(a - prevA))) > .01) dirty = true;   // 队形还在转，画面上整簇在晃

      const key = pickFormation(u);
      if (key !== st.formKey) { st.formKey = key; dirty = true; }
      const cells = cellsOf(u, key);

      // ── 108：队形拉伸要的"实际速度"由 d 层给（`u.spd`，格/秒，含地形/姿态/转身折扣）──
      //   这里**不自己差分**：`u.cx` 只在 20Hz 步里更新，60fps 下差分是"三帧 0、一帧一大跳"，
      //   实测平滑后仍抖 0~2.19、均值 0.69（真值 3.0）——那就是第二个速度账本，必然错。
      //   107 立的规矩（朝向只能有一个账本）在这里同样成立，所以由积分器写、这里只读。
      //   剩下的台阶（20Hz 写 / 60fps 读）用 SPD_TAU 低通，仍是同一份数据。
      const rawSpd = Number.isFinite(u.spd) ? u.spd : 0;
      st.spd += (rawSpd - st.spd) * (1 - Math.exp(-dt / PARAMS.SPD_TAU));

      // ── 108：起步的轻重 ──
      //   上司原话：「最前方的单位先动一点，后面的单位晚一点动」。
      //   只在 **静止 → 行走** 那一帧设基准（中途改向、换阵都不重来，否则每翻一格就有人卡一下）；
      //   每兵延迟 = PUSH × (它离最后一排有多远)/(队深)。ly 正＝前 ⇒ 靠前的延迟趋 0。
      //   ⚠️ 必须先"停够 REST"才算真站住：追击时 path 会被清空再重建，
      //   每次重设基准的话尾部兵被门永久挡住（画面有人一直不迈步）。
      const walking = !!(u.path && u.path.length);
      if (!walking) {
        if (st.wasMove) st.stopAt = clock;
        if (clock - st.stopAt > PARAMS.REST) st.goAt = -1e9;
      } else if (!st.wasMove && clock - st.stopAt > PARAMS.REST) {
        st.goAt = clock;
        // 错峰的跨度按剩余路程缩放：走 4 格以上才给满 PUSH，走一格只给 1/4。
        //   不缩放的话，短距离挪一下就整队慢半拍——玩家会觉得"点了不动"。
        //   长距离行军才是"队伍开拔"，那才需要看得出层次。
        st.pushSpan = PARAMS.PUSH * Math.min(1, (u.path ? u.path.length : 0) / 4);
      }
      st.wasMove = walking;

      let lyMin = Infinity, lyMax = -Infinity;
      for (let i = 0; i < PARAMS.SLOTS; i++) {
        const c = cells[i] || [0, 0];
        if (c[1] < lyMin) lyMin = c[1];
        if (c[1] > lyMax) lyMax = c[1];
      }
      const lySpan = (lyMax - lyMin) || 1;
      let far = 0;
      for (let i = 0; i < PARAMS.SLOTS; i++) {
        const m = st.men[i] || (st.men[i] = { x: 0, y: 0, k: 1 });
        const c = cells[i] || [0, 0];
        const gate = st.goAt + (st.pushSpan || PARAMS.PUSH) * (lyMax - c[1]) / lySpan;
        if (clock < gate) { dirty = true; continue; }   // 还没轮到它迈步：原地不动，但画面要继续出帧
        const k = 1 - Math.exp(-dt * PARAMS.RATE * rateOf(u, i, st));
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
    // ── 108：队形随速度呼吸 ────────────────────────────────────────
    // v01 = 0（站着）→ 1（全速）。走的快时纵向拉开、横向收窄，整簇变成细长的一条；
    //   慢下来又鼓回原状。这是"流动感"里最容易被眼睛读出来的那一半——
    //   原来的队形是常数，走得快走得慢一样紧，看着像一块被拖动的刚体。
    // ⚠️ 只乘在这里（绘制），**不要写回 st.men**：st.men 是往模板逼近的过渡量，
    //   把拉伸混进去，换阵时拉伸会被当成"没站好"反复修正。footprint 更不受影响（它读模板）。
    const v01 = Math.min(1, (st.spd || 0) / PARAMS.V_NORM);
    const stY = moving ? 1 + PARAMS.STRETCH * v01 : 1;
    const stX = moving ? 1 - PARAMS.SQUEEZE * v01 : 1;
    const bobAmp = PARAMS.BOB * (.45 + .55 * v01);   // 站着也留四成：站桩时也有一点起伏
    const out = [];
    let kept = 0;
    for (let i = 0; i < PARAMS.SLOTS; i++) {
      const isLeader = i === PARAMS.CORE && led;
      if (!isLeader) { if (kept >= n) continue; kept++; }
      // 位次是**动画状态**（每帧向模板坐标逼近，见 update），这里只读不推。
      const fc = fallback[i] || [0, 0];
      const m = st.men[i] || { x: fc[0] * T, y: fc[1] * T };
      let lx = m.x * stX, ly = m.y * stY;
      // ── 108：微摆 ──
      // 每兵的频率与相位都不同（jitterOf）。旧写法全场同频 7 rad/s、只有相位差 i*1.7，
      //   读起来是"整块布在抖"；不同频才是"各人在迈步"。
      //   幅度还乘了速度：站着时只剩四成（哨兵也会重心的微动，不是雕像）。
      if (moving) {
        const j = jitterOf(u, i, st);
        ly += Math.sin(clock * j.f + j.p) * bobAmp;
        lx += Math.cos(clock * j.f * .83 + j.p * 1.7) * bobAmp * .42;   // 左右晃：人走路是"八"字，不是平移
      }
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
  // 角度 → 八向里最接近的那个。与 `head8` 同一条规则，**喂进去的东西不同**：
  //   `head8(u)` 读的是 e1 的动画朝向 `stateOf(u).head`（每帧按真实 dt 插值，跟帧率走）；
  //   d 层判"阵型排不排得下"必须读**唯一朝向账本 `u.turn`**，所以从角度取。
  //   两个函数摆在一起，是为了让"八向怎么取整"只有一处实现可对照。
  function dir8Of(a) {
    const cx = Math.cos(a), cy = Math.sin(a);
    let best = 0, bd = -Infinity;
    for (let i = 0; i < 8; i++) {
      const p = cx * DIR8[i][0] + cy * DIR8[i][1];
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
  // ── 112+：阵型"排不排得下"的几何口（只在落位时调用，不进 A*）───────────────
  // 「一行装不下、必须排第二行」——判的是**正面那一行**在地形与友军身体上放不放得下。
  //   一行 = 本地 y 最大的那批兵位；它横向铺到第几格，就扫几格：
  //     k = round(该排兵位 |x| 的最大值)   ← 正好是最外侧那个兵自己取整后的格偏移
  //   采样点 = `anchor + forward*该排纵深 + right*t`（t 取 -k..k），再取整到格。
  //   为什么用采样而不是直接用"兵位取整后的那几格"：中间的格也要看。
  //   一格宽的墙夹在前排两个兵之间时，两个兵各自的格都是可走的，但这一行事实上被劈开了
  //   ——采样会把中间那格扫出来，正好兑现"一行装不下"。
  // 三条硬约束（§4.9）在这里怎么兑现：
  //   · 二值：只回答放得下／放不下，不量"挤了几成"；
  //   · 落位时一次：本函数**无状态**，调用方（d 层的 judgeFormFit）只在站定那一步、
  //     且队形档或八向朝向变过时才调；
  //   · 不进 A*：纯读，不返回代价、不改路径、不看 footprint 覆盖表（Q28a：寻路只认锚点）。
  function frontRowCells(u, formKey, atX, atY, dir) {
    const key = formKey || pickFormation(u);
    const cells = cellsOf(u, key);
    if (!cells) return [];
    let ymax = -Infinity, half = 0;
    for (let i = 0; i < PARAMS.SLOTS; i++) {
      const c = cells[i] || [0, 0];
      if (c[1] > ymax) ymax = c[1];
    }
    for (let i = 0; i < PARAMS.SLOTS; i++) {
      const c = cells[i] || [0, 0];
      if (c[1] >= ymax - .01) half = Math.max(half, Math.abs(c[0]));
    }
    const d = dir || head8(u), hx = d[0], hy = d[1];
    const ax = atX != null ? atX : Math.round(u.x), ay = atY != null ? atY : Math.round(u.y);
    const k = Math.round(half);
    const out = [], seen = new Set();
    for (let t = -k; t <= k; t++) {
      // right = (-hy, hx)、forward = (hx, hy)，与 menAt / footprintCells 同一套旋转
      const dx = Math.round((-hy) * t + hx * ymax);
      const dy = Math.round(hx * t + hy * ymax);
      const sk = dx + ',' + dy;
      if (seen.has(sk)) continue;
      seen.add(sk);
      out.push({ dx, dy, x: ax + dx, y: ay + dy });
    }
    return out;
  }
  // 判一次。`occOf(x,y)` 由 d 层递进来（只有它认识别的部队），true＝这格上有友军身体。
  // 未列阵（SKIRMISH）不判：没有阵型就没有"一行"，`firm:true` 不带任何含义
  //   （增益本来就只挂在列阵上，这里给 false 反而会让面板出现"未列阵但排不下"这种假话）。
  function formFits(u, occOf, dir) {
    const key = pickFormation(u);
    if (key === 'SKIRMISH') return { firm: true, key, cells: [], bad: [] };
    const cells = frontRowCells(u, key, null, null, dir);
    const bad = [];
    for (const c of cells) {
      if (!walkable(c.x, c.y)) bad.push({ x: c.x, y: c.y, why: 'terrain' });
      else if (occOf && occOf(c.x, c.y)) bad.push({ x: c.x, y: c.y, why: 'ally' });
    }
    return { firm: bad.length === 0, key, cells, bad };
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
    RATE_JIT: PARAMS.RATE_JIT, PUSH: PARAMS.PUSH, REST: PARAMS.REST, STRETCH: PARAMS.STRETCH,
    SQUEEZE: PARAMS.SQUEEZE, V_NORM: PARAMS.V_NORM, SPD_TAU: PARAMS.SPD_TAU,
    SEP_R: PARAMS.SEP_R, SEP_MIN: PARAMS.SEP_MIN, SEP_RATE: PARAMS.SEP_RATE,
    FORMS: FORM_SLOTS,
    // 运行时
    update, troopMen, troopBounds, troopFill, formationLabel, pickFormation,
    formKeyOf, headOf, stateOf, setFormation,
    // 98：松散集合的占格读口（d 层 occupancy 表 / ui 点选都从这里取）
    footprintCells, footprintBounds, head8, DIR8, cellsOf, walkable,
    // 112+：阵型排不排得下（d 层 judgeFormFit 调；dir8Of 与 head8 同一规则、不同来源）
    dir8Of, frontRowCells, formFits,
    // 同格分离（75）：offsetOf 给出这一支当前的锚点偏移（世界像素），测试与调试读它
    offsetOf, stackSlot, stackTarget, anchorOf,
    get time() { return clock; }
  };
})();
