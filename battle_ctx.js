// battle_ctx.js — BattleContext（86，阶段一）
//
// 定位：夹在 d 层（sim）和 b 层（understand）之间的一层**事实装配**。
//   它自己不算任何东西，只把 SIM.read 的读数整理成"一句话能说清的一层结构"，
//   这样 b 层以后要问"最近的桥在哪、那条路通不通、我身边有谁"时，
//   不必连着调七八个口、也不必知道坐标和格子。
//
// 这一轮（86）**只装配、只注入，不消费**：
//   b 层的 parse 一行都不读它。先建通道是为了让 mapread_test 能对着真值验
//   "这些数准不准"——87 才让理解层真的拿它做判断。
//   反过来做（先消费后验数）就会拿错数当结论，而且错了看不出来。
//
// 87 起 b 层开始消费：地形（站的是什么地）、通行性（过河点在哪）、岸别、可达性。
//   消费口径是「谁问谁付」——`terrainAt` 零成本随便问，`reach` 每句最多一处（单次 23ms）。
//
// 三条硬规矩：
//   1. **不碰敌军真值数组**。近处敌情从 `SIM.read.whoIsNear` 来；95 起另有一份 `enemy[]`
//      **全量快照**，也只从 `SIM.enemyFogState()` 浅拷贝（live / lagged / ghost，后两者带 age）。
//      两者的源头都是同一份按迷雾过滤过的事实——"我不知道那边有敌人"本身就是要用的事实，
//      直接扫真值等于开图（AGENTS 第 5 条）。
//   2. **不写策略**。这里不出现"该去守哪""哪条路更好"，只有"在哪、多远、通不通、
//      看不看得见"。`sightOf` 给的是每个候选各自的事实，排序与挑选在 b 层。
//   3. **不缓存整包**。每次 build 都现取；贵的东西（A*／视线）由 d 层读口按帧缓存，
//      在这里再套一层缓存就会出现"两份真相、各错一半"。
(function () {
  const NEAR_R = 6;        // "身边"的半径，与 d 层 foesWithin 的口径一致
  const LANDMARK_R = 20;   // 装配地标时的默认半径（够覆盖一张图的营地/桥/林）
  const MAX_UNITS = 8;     // 81 定的编制上限；超了截断，不静默扩容

  function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }

  // 装配一份快照。opts.reach === true 时才顺带算"每处营地走不走得到"
  //   （18 个地标 = 20~30ms，86 没人消费，默认不算；87 按需开）。
  function build(opts) {
    const S = (typeof SIM !== 'undefined') ? SIM : null;
    if (!S || !S.read) return null;
    const o = opts || {};
    const R = S.read;

    // 参照点：主将优先，没有就第一支活着的。和 livePlaces 的 ref 同口径。
    const me = (S.commander && S.commander.hp > 0) ? S.commander
      : (S.units.find(u => u.hp > 0) || null);
    const here = me ? { x: Math.round(me.x), y: Math.round(me.y) } : null;

    const places = R.places().map(p => ({
      id: p.id, name: p.name, kind: p.kind, x: p.x, y: p.y,
      owner: p.owner || null,
      // 87：`area`＝在西岸还是东岸（生成器按实际位置算出来的事实，桥是 null）。
      //   b 层答「那处营地在哪一岸」只用这一个字段，不必再问 d 层要 sideOf。
      area: p.area || null,
      tiles: num(p.tiles),
      // d 是"离主将多远"（d 层算的）；这里再算一个"离参照点多远"会变成第二把尺子，
      //   所以直接沿用，不重算。
      d: num(p.d),
    }));

    const own = S.units.filter(u => u.hp > 0).slice(0, MAX_UNITS).map(u => ({
      id: u.id, name: u.name, type: u.type || null, role: u.role || null,
      x: u.x, y: u.y, order: u.order || null, hold: !!u.hold,
    }));

    // 可达性：只对地标做（营地/桥头是命令最常提的落点），而且必须走读口缓存。
    //   **默认不算**：这张图 18 个地标，各跑一次 A* 是 20~30ms。86 还没有一处消费它，
    //   不该先让命令链路付这笔钱。87 真要用时按需开，并且只对"这句话提到的"那几个点算
    //   （d 层按帧缓存，同一帧内重复问不再花时间）。
    let reachTo = [];
    if (here && me && o.reach === true) {
      reachTo = places.map(p => {
        const r = R.reach(me, p);
        return { id: p.id, ok: !!r.ok, cost: num(r.cost), steps: r.steps, why: r.why || null };
      });
    }

    // 95：敌情**全量**快照，只从 enemyFogState() 来。
    //   `near.contact` 只有半径 6，视野之外的最后目击点一条都拿不到——契约 §4.2 要求的
    //   `enemy[]` 一直缺，所以「敌人侧翼」按 ghost 算方位从来没有数据可用。
    //   这里不做筛选、不推断位置，只把已按迷雾过滤的事实（mode / age / x / y）原样搬过来。
    const foes = [];
    if (S && typeof S.enemyFogState === 'function') {
      for (const [id, st] of S.enemyFogState()) {
        foes.push({
          id, mode: st.mode, age: st.age || 0, x: st.x, y: st.y,
          hp: st.hp === undefined ? null : st.hp,
        });
      }
    }

    const snap = {
      at: num(S.simTime) || 0,
      seed: S.SEED || null,
      bounds: R.bounds(),
      river: R.river(),
      here,
      // 87：本方在河哪一岸（按本营位置判，不按阵营名判——换图后蓝方也可能在东岸）。
      //   没有它，b 层只能从第 0 条通道的 side 反推；图上没有通道时就没有答案。
      homeSide: R.homeSide('blue'),
      // 87：参照点自己在哪一岸（'west'/'east'/'river'）。「我们在哪岸」只读这一个事实。
      side: here ? R.sideOf(here) : null,
      terrain: here ? R.terrainAt(here) : null,
      crossings: here ? R.crossingsFor(here).map(c => ({
        cy: c.cy, x1: c.x1, x2: c.x2, west: c.west, east: c.east, side: c.side, d: c.d,
      })) : [],
      places,
      landmarks: here ? R.nearbyLandmarks(here, LANDMARK_R) : [],
      near: here ? R.whoIsNear(here, NEAR_R) : { friendly: [], contact: [] },
      enemy: foes,
      own,
      reachTo,
    };

    // ── 87：按需口（两个零成本 + 一个按句限额）──────────────────────────
    // 这里给的是**函数**，不是预算好的数：用不上的人一分钱不花。
    //   86 的教训是「默认算全表 = 1.3 秒」，这里的规矩是「谁问谁付」。
    // 一格地表（任意点）：b 层要判断"这处营地是不是在林子里"，就得问旁人脚下的地，
    //   `terrain` 只覆盖 here，不够用。零成本（一次数组查表 + 高度/速度系数）。
    snap.terrainAt = (p, py) => R.terrainAt(p, py);
    // 可达性单点问答：**一句最多问一处**。86 实测单次 A* 23ms，
    //   所以这里不做任何预装，只有真的问"走得到吗、到那儿多远"时才跑一次，
    //   而且 d 层同帧缓存，同一句话里重复问同一处不再花时间。
    snap.reach = (idOrPoint) => {
      if (!me) return { ok: false, cost: Infinity, steps: 0, why: 'dead' };
      let pt = idOrPoint;
      if (typeof idOrPoint === 'string') {
        const p = places.find(x => x.id === idOrPoint);
        if (!p) return { ok: false, cost: Infinity, steps: 0, why: 'noplace' };
        pt = p;
      }
      const r = R.reach(me, pt);
      return { ok: !!r.ok, cost: num(r.cost), steps: r.steps, why: r.why || null };
    };
    // 95：视野**事实表**。契约 §4.4 要"用 visibleFrom 挑视野最好的高地"，但 d 层那个
    //   `visibleFrom(a,b)` 的实做是"a 能不能看见 b"（visible/cap/from），不是"该点能看到多少格"，
    //   `sightFor` 又是单位对单位、b 层拿不到单位。所以这里给的是"每个候选各自能看见哪几处目标"，
    //   **不排序、不下结论**——哪处更好由 b 层按硬限定词决定（87 决策：限定词是硬条件）。
    //   内部循环调 R.visibleFrom：它按 readFrame 缓存且只做逐格视线插值，不是 A*；
    //   b 层一次解析只调这个口一次，实测耗时见 mapadvice_test [5]。
    snap.sightOf = (hillIds, targetIds) => {
      const hs = (hillIds || []).map(id => places.find(p => p.id === id)).filter(Boolean);
      const ts = (targetIds || []).map(id => places.find(p => p.id === id)).filter(Boolean);
      return hs.map(h => ({
        id: h.id, name: h.name, d: num(h.d),
        seen: ts.map(t => {
          const v = R.visibleFrom(h, t);
          return {
            id: t.id, name: t.name, visible: !!v.visible,
            cap: (typeof v.cap === 'number' && isFinite(v.cap)) ? v.cap : null,
          };
        }),
      }));
    };
    return snap;
  }

  globalThis.BATTLE_CTX = { build, NEAR_R, LANDMARK_R, MAX_UNITS };
})();
