// worldgen.js — 世界生成（2026-10-30 57）
// 职责：**给定一个种子 → 地形 / 河 / 桥 / 营地 / 本营 / 出生点 / 巡逻区与路线 / 地标事实**。
//
// 界线（很重要，别越界）：
//   · 这个文件只产出**数据**，不碰战斗、士气、寻路、决策。
//   · 它不读也不写 SIM 的任何东西——sim.js 拿到结果后填进自己的常量与数组。
//     所以它可以脱离整个 demo 单测（worldgen_test 直接 require 这一份）。
//
// ── 57 改了什么（上司 2026-10-30 三条）──────────────────────────────
// ① **地名从地形长出来，不是反过来**。56 是"先定名字（北面森林/北面高地/西北营地），
//    再在地图的对应带里保证长出那块地形"——上司否掉了："地图上有什么，名字才叫什么"。
//    现在地形**自由散布**（不设纵向三带、不保任何方位），生成完之后**扫描成品地形**
//    找出真实存在的斑块，每个斑块按它自己的实际位置描述成名字。
//    所以某些图上就是没有"北面树林"，那就没有这个名字——这是诚实，不是缺陷。
// ② **河要能转弯**。56 刻意做成直河（怕 crossings 判据失效），上司："如果跟原有代码冲突，
//    那就修正它"。现在河是一条逐行摆动的中心线（±10 格），宽度沿程 1~3 变；
//    sim.js 的可渡通道改为**从桥格连通块反推**，不再假设"河占的每一列都可渡"。
// ③ **只加物理/常识约束，不预设"必须有什么"**：桥必须在河上且两头接岸、营地不在水/山/林里、
//    洼地贴着河、道路不穿河、森林不横跨河……但**不规定桥有几座、地形有几块**。
//    唯一的"必须有"是玩法底线：两岸必须能来往（否则打不起来）——那是可玩性，不是摆设要求。
//
// 确定性：同一个种子 → 逐字节相同的世界。禁止 Math.random / Date。
//   这条是硬要求：截图要对得上、测试要能复现、线上报 bug 要能拿种子回放。

(() => {
  'use strict';

  // 2026-11-03：128×96 → 160×120（与 sim.js 的 MAP 同步；sim.js 显式传 cols/rows，这里只是独立单测的默认值）。
  const DEF_COLS = 160, DEF_ROWS = 120;

  // mulberry32：32 位、无依赖、分布够用。种子 0 会被映射到 1（0 是好几个 PRNG 的不动点）。
  function mulberry32(seed) {
    let a = (seed >>> 0) || 1;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const KIND_NAME = { forest: '树林', hill: '高地', marsh: '洼地', camp: '营地', base: '本营', bridge: '桥' };

  function build(seed, opt) {
    const o = opt || {};
    const cols = o.cols || DEF_COLS, rows = o.rows || DEF_ROWS;
    const perSide = o.perSide || 5;
    // 2026-11-03：巡逻路线挂哪些 id，由调用方给（`enemyIds`），不再写死五个。
    //   为什么必须能变：c′ 拿 `e.patrol` 当"这支部队归我管"的判据（`S.enemies.filter(e=>e.patrol)`），
    //   8 支而这里只发 5 条路线时，后 3 支**永远不巡逻也永远不进军团**——它们在原地当木头人，
    //   玩家会看到三支敌军站着不动、也不反击。不传就退回老的五个 id（独立单测不用改）。
    const enemyIds = (o.enemyIds && o.enemyIds.length)
      ? o.enemyIds.slice()
      : ['E_INF', 'E_ARC', 'E_CAV', 'E_INF2', 'E_INF3'];
    const sd = (seed >>> 0) || 1;
    const rng = mulberry32(sd);

    let last = null;
    for (let i = 0; i < 40; i++) {
      const w = attempt(rng, cols, rows, perSide, enemyIds);
      last = w;
      if (!w.fail) {
        delete w.fail;
        w.attempt = i + 1;
        w.seed = sd;
        return w;
      }
    }
    // 降级：40 次都不合格。把最后一个交出去，但**明确标出来**——
    //   静默返回一张坏图，比降级更糟：没人会知道为什么这局的部队不动。
    const why = last && last.fail;
    if (last) delete last.fail;
    last.degraded = why || '重试 40 次仍不满足约束';
    last.attempt = 40;
    last.seed = sd;
    return last;
  }

  function attempt(rng, cols, rows, perSide, enemyIds) {
    const T = Array.from({ length: rows }, () => Array(cols).fill('plain'));
    // 98（Q20a）：森林从 terrain 单值枚举里搬出来，成为**地貌层**。
    //   T 只存 base（plain/road/river/bridge/hill/marsh），C 只存 cover（null | 'forest'）。
    //   上司 Q12：「森林是地形上的地貌，也就是说山坡上也可以有森林」——
    //   旧写法 forest 与 hill 互斥，blob('forest') 先写、ridge('hill') 后写直接把树覆盖掉。
    //   C 存字符串而非布尔，后续加可埋伏地形只往 AMBUSH_COVER 白名单加值。
    const C = Array.from({ length: rows }, () => Array(cols).fill(null));
    const ins = (x, y) => x >= 0 && y >= 0 && x < cols && y < rows;
    const R = (a, b) => a + rng() * (b - a);
    const RI = (a, b) => Math.floor(R(a, b + 1));

    // 边缘抖动的确定性哈希。salt 让不同斑块的边缘纹理不一样，
    //   否则所有林子长得像同一个模子刻的（一眼就看得出"这是程序生的"）。
    const hash = (x, y, s) => {
      const v = Math.sin((x + s * 17.7) * 127.1 + (y + s * 31.3) * 311.7) * 43758.5453;
      return v - Math.floor(v);
    };

    // ── ① 河道：一条逐行摆动的中心线 ────────────────────────────
    // 56 的直河是从"怕 crossings 判据失效"来的，不是从物理来的——真河会拐。
    //   现在按两条正弦叠出走向（一条大摆幅定大势，一条小摆幅做细节），
    //   宽度沿程 1~3 变（上游宽一点下游窄一点这类感觉，不必真有水文逻辑）。
    // 位置约束只有一条（物理常识）：**河不能贴着地图边**，否则岸边没地方站人、
    //   本营就会泡在水里。抖动区间按河幅留够余量。
    const amp = cols * (0.055 + rng() * 0.045);         // ±7~13 格
    const baseX = cols * (0.5 + (rng() - 0.5) * 0.10);  // 0.45~0.55
    const f1 = 0.75 + rng() * 0.7, p1 = rng() * Math.PI * 2;
    const f2 = 1.9 + rng() * 1.3, p2 = rng() * Math.PI * 2;
    const fw = 1.1 + rng() * 1.4, pw = rng() * Math.PI * 2;
    const spineX = [], spineW = [], runs = [];
    for (let y = 0; y < rows; y++) {
      const t = y / (rows - 1);
      const sx = baseX + Math.sin(t * Math.PI * 2 * f1 + p1) * amp * 0.8
        + Math.sin(t * Math.PI * 2 * f2 + p2) * amp * 0.2;
      const w = clamp(Math.round(1.6 + Math.sin(t * Math.PI * 2 * fw + pw) * 0.85 + (rng() - .5) * .5), 1, 3);
      const x1 = Math.round(sx - (w - 1) / 2);
      spineX.push(sx); spineW.push(w);
      runs.push({ x1, x2: x1 + w - 1, cx: x1 + (w - 1) / 2, w });
    }
    let rx1 = Infinity, rx2 = -1;
    for (const r of runs) { rx1 = Math.min(rx1, r.x1); rx2 = Math.max(rx2, r.x2); }
    if (rx1 < 14 || rx2 > cols - 15) return { fail: '河太靠边' };
    const rivC = (rx1 + rx2) / 2;
    // 某一行上的河段（哪里到哪里的水）
    const runAt = y => runs[clamp(Math.round(y), 0, rows - 1)];
    // 某点在哪一岸（`river` = 站在水面上）
    const bankOf = (x, y) => {
      const r = runAt(y);
      return x < r.x1 ? 'west' : x > r.x2 ? 'east' : 'river';
    };

    // ── ② 桥：位置由河自己决定，数量不预设 ────────────────────
    // 上司明确否掉了"必须有一座桥/必须几座"：桥是"人在这条河上修了几座过河的口子"，
    //   修几座取决于河有多宽、地图有多长，不取决于设计者的清单。
    // 所以这里是**打分选点**：河道越窄越容易架桥（物理），离双方本营越近越可能架桥（常识），
    //   再加一点随机。数量由"这张图上挑得出几个合格点"决定，1 座到 4 座都可能出现——
    //   单桥图确实吃亏（守方好守），但那是**这局的地理**，不是规矩。
    // 唯一硬约束来自玩法底线：两岸必须能来往，一座都架不上就换一张图（见 ⑫）。
    // 河段划分：一条长河上，人会**在每个河段各找一处最窄的地方**架桥，不会全挤在一段。
    //   所以这里按行分段，每段挑一个"水窄 + 偏段中"的位置，再看这一处架不架得起来。
    //   段数 2~4 是"这条河有几个河段需要过河点"的随机，不是"规定必须几座"。
    const segN = 2 + Math.floor(rng() * 3);            // 2~4
    const segH = (rows - 26) / segN;
    const bridgeCand = [];
    for (let i = 0; i < segN; i++) {
      const a = 12 + segH * i, b = a + segH;
      for (let y = Math.round(a + 2); y <= Math.round(b - 2); y++) {
        bridgeCand.push({
          seg: i, y,
          score: runAt(y).w * 3.2 + rng() * 4.5 + Math.abs(y - (a + b) / 2) * 0.12,
        });
      }
    }
    bridgeCand.sort((a, b) => a.score - b.score || a.y - b.y);
    const wantB = segN;
    const bridges = [];
    const segUsed = {};
    for (const c of bridgeCand) {
      if (bridges.length >= wantB) break;
      if (segUsed[c.seg]) continue;
      if (bridges.some(b => Math.abs(b.cy - c.y) < 14)) continue;   // 两桥贴太近＝实际只有一条通道
      const y1 = c.y, y2 = c.y + 1;
      const a = runAt(y1), b = runAt(y2);
      // 98 修既有边界：河宽逐行变（1~3），相邻两行河段一旦错位，
      //   "盖住最宽那段 + 两端各探 1 格"的桥面在较窄那一行就会伸出水面 → ⑦ 校验
      //   「桥没架在河上」直接返回 fail。原来靠 rng 顺序罕见地躲过去了，98 翻了地貌生成
      //   顺序后 seed 166 连试 40 次全撞上、生成器降级出坏图。只挑两行河段完全相同的位点，
      //   **不改桥面画法、不碰 rng 消耗**（打分阶段已经摇完，这里没有 rng 调用）。
      if (a.x1 !== b.x1 || a.x2 !== b.x2) continue;
      // 桥面必须**盖住这两行里最宽的那段水**，再向两岸各探出 1 格——
      //   这是"桥不悬空、两头接岸"的物理要求，不是美观要求：少盖一格，
      //   部队走到桥中间会掉进水里（A* 直接无路，命令被静默丢弃）。
      const bx1 = Math.min(a.x1, b.x1) - 1, bx2 = Math.max(a.x2, b.x2) + 1;
      if (bx1 < 2 || bx2 > cols - 3) continue;
      segUsed[c.seg] = true;
      bridges.push({
        id: '', y1, y2, cy: y1 + 0.5, x1: bx1, x2: bx2,
        west: { x: bx1 - 1, y: y1 }, east: { x: bx2 + 1, y: y1 },
      });
    }
    if (!bridges.length) return { fail: '一处过河点都架不起来' };

    // ── ③ 本营：蓝在西、红在东，纵向位置各自随机 ──────────────
    const bw = 4, bh = 4;
    const blueX1 = 3 + RI(0, 2), blueX2 = blueX1 + bw - 1;
    const redX2 = cols - 4 - RI(0, 2), redX1 = redX2 - bw + 1;
    // 81：半跨度按**实际排数**算（两排时纵向只占 ceil(n/2) 个位置），
    //   否则 8 支会按 8 个纵位留 32 格空地，把本营挤出可行范围。
    const rowsN = perSide > 5 ? Math.ceil(perSide / 2) : perSide;
    const halfSpan = Math.ceil((rowsN - 1) / 2) * 4;              // 5 支、间距 4 → 上下各 8 格
    const bc = clamp(Math.round(rows * 0.5 + (rng() - 0.5) * rows * 0.20), halfSpan + 6, rows - halfSpan - 6);
    const rc = clamp(Math.round(rows * 0.5 + (rng() - 0.5) * rows * 0.20), halfSpan + 6, rows - halfSpan - 6);
    const blueBase = { id: 'HOME', side: 'blue', name: '我军本营', kind: 'base', owner: 'blue', x1: blueX1, y1: bc - 2, x2: blueX2, y2: bc + 1 };
    const redBase = { id: 'HOME_E', side: 'red', name: '敌军本营', kind: 'base', owner: 'red', x1: redX1, y1: rc - 2, x2: redX2, y2: rc + 1 };

    // ── ④ 地貌：自由散布，不预设方位 ──────────────────────────
    // 每种地形都要服务一个战术选择（沿用 ㊸ 的三条规矩）：
    //   山成脊（站上去看得远、岭那边是山影）、林成盘（穿一层树还能透、两层就断）、
    //   洼地贴河（看得近，沿河推进是有代价的选择）。
    //
    // **不再按"纵向三带"摆**：56 为了让"北面森林"永远存在，强行在西岸北/南带各放一片林，
    //   代价是每张图的骨架长得一模一样，而且"名字"成了原因、地形成了结果。
    //   现在反过来：位置、数量、走向全随机，长出来什么样就是什么样。
    //   斑块尺寸按图幅缩放（56 收的那一刀保留）：128×96 用 80×60 的尺寸会稀得像摆了几盆花。
    const SC = Math.sqrt((cols * rows) / 4800);
    // 斑块不许横跨河：它长在哪一岸，就只长那一岸（物理常识：河两岸是两块地）。
    //   river 是最后落笔的，所以就算这里不判，水也会把斑块切开——
    //   但那会把一块林子切成"西岸半块 + 东岸半块"两个地标，读起来像地图出错了。
    // 98：第 8 个参数 `toCover`（森林专用）。写 cover 时**不覆盖 base**，
    //   斑块只落在 plain 上；坡上那 35% 由下面 ④′ 统一按确定性 hash 逐格撒（Q21），
    //   不引第二随机源。写 terrain（洼地）时顺手清掉该格 cover——"洼地里长着树"是数据错。
    function blob(type, cx, cy, rx, ry, rough, salt, toCover) {
      const j = rough == null ? .55 : rough, s0 = salt || 0;
      const side = bankOf(cx, cy);
      for (let y = Math.floor(cy - ry - 1); y <= Math.ceil(cy + ry + 1); y++)
        for (let x = Math.floor(cx - rx - 1); x <= Math.ceil(cx + rx + 1); x++) {
          if (!ins(x, y)) continue;
          if (side !== 'river' && bankOf(x, y) !== side) continue;
          const nx = (x - cx) / rx, ny = (y - cy) / ry;
          if (nx * nx + ny * ny > 1 + (hash(x, y, s0) - .5) * j) continue;
          if (toCover) {
            if (T[y][x] !== 'plain') continue;    // 斑块只铺平地；坡上林见 ④′
            C[y][x] = 'forest';
          } else {
            C[y][x] = null;
            T[y][x] = type;
          }
        }
    }
    // 山脊：沿折线扫一条带。判据是**点到线段距离**（不是沿线画圆）——
    //   画圆在拐弯处会漏一格，一条岭中间出现豁口，山影就断在那儿。
    function ridge(type, pts, w, salt) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      const side = bankOf(pts[0][0], pts[0][1]);
      for (let y = Math.floor(y0 - w); y <= Math.ceil(y1 + w); y++)
        for (let x = Math.floor(x0 - w); x <= Math.ceil(x1 + w); x++) {
          if (!ins(x, y)) continue;
          if (side !== 'river' && bankOf(x, y) !== side) continue;
          for (let i = 0; i < pts.length - 1; i++) {
            const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
            const vx = bx - ax, vy = by - ay, len2 = vx * vx + vy * vy;
            let t = len2 ? ((x - ax) * vx + (y - ay) * vy) / len2 : 0;
            t = clamp(t, 0, 1);
            const dx = x - (ax + vx * t), dy = y - (ay + vy * t);
            if (dx * dx + dy * dy <= w * w + (hash(x, y, salt || 0) - .5) * 1.6) { T[y][x] = type; break; }
          }
        }
    }
    // 在某一岸的合法范围内随机取点（避开河与已有的东西）
    const onBank = side => {
      const xa = side === 'west' ? 6 : rx2 + 6, xb = side === 'west' ? rx1 - 6 : cols - 7;
      if (xb - xa < 14) return null;
      return { x: R(xa, xb), y: R(10, rows - 11) };
    };
    const blotchCount = k => Math.max(1, Math.round((cols * rows) / k));
    // 98（Q21）：**生成顺序翻成先山脊后森林**。旧顺序 forest 写 T、ridge 再写 T 会把树覆盖掉；
    //   现在森林写 C 不覆盖 base，所以必须先有 hill 才能让"坡上 35% 披林"这条成立。
    //   ⚠️ rng 消耗顺序因此变了，`?seed=` 基线逐格全变（Q25 上司已接受；只承诺同版本同种子逐帧一致）。
    // 山：3~5 道脊，东岸西岸都有可能（"东面高地"这类说法由此而来，不是硬塞的）
    for (let i = 0, n = blotchCount(3000) + RI(-1, 1); i < n; i++) {
      const p = onBank(rng() < 0.5 ? 'west' : 'east'); if (!p) break;
      const len = R(12 * SC, 26 * SC), dir = rng() < 0.5 ? 1 : -1;
      ridge('hill', [[p.x, p.y], [p.x + dir * len * 0.5, p.y + R(-5, 5)], [p.x + dir * len, p.y + R(-7, 7)]],
        R(1.4, 2.3), i + 1);
    }
    // 林地：**少而大**。57 第一版按 900 格/块撒，一张图长出 12 块碎林子，
    //   "西北树林"重名三次，玩家说"去西北树林"根本不知道指哪——地名一重就没用了。
    //   现在 2200 格/块（约 5~6 块），块也放大一半，读起来才像"几片林子"而不是"一地灌木"。
    // 98：写 cover 层；`extract` 也改在 cover 层跑 4 邻连通，跨平地与坡地算同一片（Q23）。
    for (let i = 0, n = blotchCount(2200) + RI(-1, 1); i < n; i++) {
      const p = onBank(rng() < 0.5 ? 'west' : 'east'); if (!p) break;
      blob('forest', p.x, p.y, Math.min(R(4.5, 9.0) * SC, 14 * SC), R(3.2, 6.0) * SC, .6, i + 11, true);
    }
    // ④′ 坡上林（98，Q21）：**约 35% 的 hill 格披林**。逐格按同一份确定性 hash 判，
    //   不引第二随机源、不额外摇 rng（摇了会让同种子地形随调用顺序变，复现就废了）。
    //   放在斑块之后、保护区之前：桥头/本营/出生带的树随后会被 clearRect 清掉。
    //   Q22 明确接受「高地林＝看得远又藏得住」，本轮不额外加数值去压它。
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      if (T[y][x] !== 'hill' || C[y][x] === 'forest') continue;
      if (hash(x, y, 77) < .35) C[y][x] = 'forest';
    }
    // 洼地：**必须贴河**（河滩低地的物理位置就是河边，不能长在山坳里）。
    //   81 改法：横向（垂直河的方向）**不随图幅放大**，只放大纵向。
    //   原来两个半径都乘 SC，160×120 时 SC=2，洼地横向半径到 6.8 格、加噪声抖动后
    //   边缘离河 12.2 格——那已经不是"河滩"，是一片滩涂了；测试"离河 ≤12"因此变红。
    //   物理上河滩是**沿着河的一条带**，不是一块圆饼，所以只沿河拉长是对的。
    for (let i = 0, n = 1 + RI(0, 2); i < n; i++) {
      const west = rng() < 0.5, y = R(9, rows - 10), r = runAt(y);
      blob('marsh', west ? r.x1 - R(2, 5) : r.x2 + R(2, 5), y,
        R(2.2, 3.4), R(3, 5) * SC, .95, 30 + i);
    }

    // ── ⑤ 空地保护区：桥头、本营、出生带 ──────────────────────
    // 顺序是**斑块之后**：保护区要能确定地清掉任何地貌，不然"开局视野被树挡住""桥头站不开"。
    const clearRect = (x1, y1, x2, y2) => {
      for (let y = Math.max(0, y1); y <= Math.min(rows - 1, y2); y++)
        for (let x = Math.max(0, x1); x <= Math.min(cols - 1, x2); x++) {
          if (T[y][x] !== 'river') T[y][x] = 'plain';
          C[y][x] = null;              // 98（Q24）：保护区连 cover 一起清，桥头/本营/出生带不许有树
        }
    };
    for (const b of bridges) clearRect(b.x1 - 9, b.y1 - 4, b.x2 + 9, b.y2 + 4);
    clearRect(blueBase.x1 - 2, bc - halfSpan - 2, blueBase.x2 + perSide + 3, bc + halfSpan + 2);
    clearRect(redBase.x1 - perSide - 3, rc - halfSpan - 2, redBase.x2 + 2, rc + halfSpan + 2);

    // ── ⑥ 道路 ──────────────────────────────────────────────
    // 横道从桥位派生（有几座桥就有几条），纵道**贴着河走**——因为河会拐，
    //   纵道不能是常量列：它必须逐行跟着岸线退到水边之外，否则会插进河里。
    //   这同时让"沿河联络道"这个说法成立（现实里河边的路就是这么修的）。
    // 三条老规矩照旧：斜走补角（否则四方向寻路在拐角断开）、桥头归零（保证接上桥面）、
    //   纵道绕山不切山（岭线保持完整）。
    const pave = (x, y) => {
      if (!ins(x, y)) return;
      const t = T[y][x];
      // 98：路面不披林（旧写法 pave 会把 forest 格直接改成 road，效果一致，别让两层分叉）
      if (t !== 'river' && t !== 'bridge' && t !== 'hill') { T[y][x] = 'road'; C[y][x] = null; }
    };
    for (const b of bridges) {
      const y0 = b.y1, wob = 3;
      let y = y0;
      for (let x = 0; x < cols; x++) {
        pave(x, y);
        const dw = Math.min(wob, Math.floor(Math.abs(x - (b.x1 + b.x2) / 2) / 7) - 1);
        if (dw <= 0) continue;
        if (rng() < 0.09) {
          const ny = clamp(y + (rng() < 0.5 ? -1 : 1), y0 - dw, y0 + dw);
          if (ny !== y) { pave(x, ny); y = ny; }
        }
      }
    }
    const laneX = { west: [], east: [] };
    for (const side of ['west', 'east']) {
      const off = RI(6, 13);                       // 离水边多远修路
      let prev = null;
      for (let y = 3; y <= rows - 4; y++) {
        const r = runAt(y);
        let x = side === 'west' ? r.x1 - off : r.x2 + off;
        x = clamp(x, 3, cols - 4);
        if (prev != null && Math.abs(x - prev) > 1) x = prev + Math.sign(x - prev);  // 逐行只挪一格，路才顺
        laneX[side][y] = x;
        if (T[y][x] === 'hill') { if (prev != null) laneX[side][y] = prev; continue; }
        if (prev != null && Math.abs(x - prev) === 1) pave(prev, y);   // 补角
        pave(x, y); prev = x;
      }
    }
    const linkRow = (y, xa, xb) => {
      for (let x = Math.min(xa, xb); x <= Math.max(xa, xb); x++)
        if (ins(x, y) && T[y][x] !== 'river') { T[y][x] = 'road'; C[y][x] = null; }
    };
    linkRow(bc, blueBase.x2 + 1, laneX.west[bc] == null ? blueBase.x2 + 3 : laneX.west[bc]);
    linkRow(rc, redBase.x1 - 1, laneX.east[rc] == null ? redBase.x1 - 3 : laneX.east[rc]);

    // ── ⑦ 河与桥：最后落笔 ──────────────────────────────────
    // 顺序铁律：自然地貌 → 保护区 → 道路 → **河与桥**。
    //   反过来写会把河抹断、把桥盖成平地（㊸ 已经踩过一次）。
    for (let y = 0; y < rows; y++) {
      const r = runs[y];
      for (let x = r.x1; x <= r.x2; x++) { T[y][x] = 'river'; C[y][x] = null; }
    }
    for (const b of bridges)
      for (let y = b.y1; y <= b.y2; y++)
        for (let x = b.x1; x <= b.x2; x++) if (ins(x, y)) { T[y][x] = 'bridge'; C[y][x] = null; }

    // ── ⑦′ 森林片 id（98，Q23）─────────────────────────────────────
    // 在 **cover 层**跑 4 邻连通，跨平地与坡地算同一片；每格一个 forestId（无树 = -1）。
    // 不过滤碎块：`extract(minTiles)` 过滤是为了地名好读，一片 10 格的小树林里
    // 两队也该互相看得见——"同片森林"是物理判据，不是命名判据。
    const forestId = Array.from({ length: rows }, () => Array(cols).fill(-1));
    let forestN = 0;
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      if (C[y][x] !== 'forest' || forestId[y][x] >= 0) continue;
      const q = [[x, y]]; forestId[y][x] = forestN;
      while (q.length) {
        const [cx0, cy0] = q.pop();
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx0 + dx, ny = cy0 + dy;
          if (!ins(nx, ny) || C[ny][nx] !== 'forest' || forestId[ny][nx] >= 0) continue;
          forestId[ny][nx] = forestN; q.push([nx, ny]);
        }
      }
      forestN++;
    }

    // ── ⑧ 营地采样：只受物理约束，不设"每岸几处" ──────────────
    // 常识规则（每一条都对应一条"这条不满足就会出戏/出 bug"）：
    //   · 营地要能扎在平地（3×3 全可站），不在水里、山上、林子里、桥面上；
    //   · 不贴地图边（贴边的营地玩家会觉得"这块地不在图上"）；
    //   · 不堵桥头（营地是补给点，不是路障）；
    //   · 彼此不挤（两处营地挨着＝实际只有一处）。
    // 数量：3~6 处随机。**但两岸数量差不超过 1**——这不是"必须有几处"，
    //   是攻守平衡：一边五处一边一处，开局就把补给线白送给一方。
    const campOk = (x, y) => {
      if (x < 8 || y < 8 || x > cols - 9 || y > rows - 9) return false;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const t = T[y + dy][x + dx];
        if (t !== 'plain' && t !== 'road') return false;
        if (C[y + dy][x + dx] !== null) return false;   // 98：营地 3×3 连 cover 一起不许有树
      }
      for (const b of [blueBase, redBase])
        if (x >= b.x1 - 4 && x <= b.x2 + 4 && y >= b.y1 - 4 && y <= b.y2 + 4) return false;
      for (const b of bridges)
        if (x >= b.x1 - 5 && x <= b.x2 + 5 && y >= b.y1 - 5 && y <= b.y2 + 5) return false;
      return true;
    };
    const wantC = 3 + RI(0, 3);                     // 3~6
    const sites = [];
    const placedAt = [];
    const tryCamp = (side, gap) => {
      for (let t = 0; t < 400; t++) {
        const xa = side === 'west' ? 9 : rx2 + 5, xb = side === 'west' ? rx1 - 5 : cols - 10;
        if (xb <= xa) return false;
        const x = RI(xa, xb), y = RI(9, rows - 10);
        if (bankOf(x, y) !== side) continue;
        if (!campOk(x, y)) continue;
        if (placedAt.some(p => Math.max(Math.abs(p.x - x), Math.abs(p.y - y)) < gap)) continue;
        placedAt.push({ x, y, side });
        return true;
      }
      return false;
    };
    // 先保证"两岸各至少一处"，其余随机，全程守住数量差 ≤ 1
    const cnt = { west: 0, east: 0 };
    tryCamp('west', 15); cnt.west++;
    tryCamp('east', 15); cnt.east++;
    for (let i = 2, guard = 0; i < wantC && guard < 200; guard++) {
      const prefer = cnt.west <= cnt.east ? 'west' : 'east';
      const side = rng() < 0.7 ? prefer : (prefer === 'west' ? 'east' : 'west');
      if (Math.abs(cnt.west - cnt.east) >= 1 && side !== prefer) continue;   // 差 1 时不许再加到多的那岸
      if (tryCamp(side, 15)) { cnt[side]++; i++; }
    }
    if (sites.length >= 0 && placedAt.length < 3) return { fail: '营地太少' };
    for (const p of placedAt) {
      sites.push({ x1: p.x - 1, y1: p.y - 1, x2: p.x + 1, y2: p.y + 1, x: p.x, y: p.y, side: p.side });
    }

    // ── ⑨ 出生点 ────────────────────────────────────────────
    // 本营内/营侧一字排开（y 间距 4）。落在营外朝河那一侧，开局第一屏就能看到部队。
    const spawns = { blue: [], red: [] };
    // 81：6 支以上改**两排**。一屏只有 26.7 格宽（`VIEW_TILES = 20`），8 支一字排开要 28 格，
    //   最远的两支开局就落在画面外——「全军」这类短令按 62 的规矩只喊给画面内的部队，
    //   于是"喊了全军、有一半没动"。两排之后阵线宽 16 格，一屏装得下。
    //   没有兵的格子留在第二排末尾，不影响"每支都有出生点"。
    const twoRows = perSide > 5;
    const cols2 = twoRows ? Math.ceil(perSide / 2) : perSide;
    for (let i = 0; i < perSide; i++) {
      const row = twoRows ? i % 2 : 0;
      const col = twoRows ? Math.floor(i / 2) : i;
      const dy = Math.round((col - (cols2 - 1) / 2) * 4);
      const dx = row * 3;                       // 第二排离本营再远 3 格（仍在出生保护区里）
      spawns.blue.push({ x: blueBase.x2 + 3 + dx, y: bc + dy });
      spawns.red.push({ x: redBase.x1 - 3 - dx, y: rc + dy });
    }

    // ── ⑩ 巡逻区与路线 ──────────────────────────────────────
    // 巡防区＝红方本营与河之间那一段（不是手画矩形）：河挪、营挪，区自己跟着走。
    const hz = Math.min(Math.round(rows * 0.19), 22);
    let py1 = clamp(rc - hz, 5, rows - 22), py2 = clamp(rc + hz, py1 + 18, rows - 6);
    if (py2 - py1 < 18) py2 = Math.min(rows - 6, py1 + 18);
    const redEast = bankOf((redBase.x1 + redBase.x2) / 2, rc) === 'east';
    let pz;
    if (redEast) {
      // 巡防区**必须盖住本营**：守备队（主将＋护卫）就驻在营里，
      //   区把它排除在外，越区检查会天天报"守备队擅离防区"——它其实一步没动。
      const x2 = Math.min(cols - 6, Math.round(redBase.x2) + 2);
      const x1 = Math.max(Math.round(runAt(rc).x2 + 3), x2 - 40);
      pz = { x1, x2: Math.max(x1 + 16, x2), y1: py1, y2: py2 };
    } else {
      const x1 = Math.max(5, Math.round(redBase.x1) - 2);
      const x2 = Math.min(Math.round(runAt(rc).x1 - 3), x1 + 40);
      pz = { x1: Math.min(x2 - 16, x1), x2, y1: py1, y2: py2 };
    }

    const snap = (x, y, cavalry) => {
      x = clamp(Math.round(x), 1, cols - 2); y = clamp(Math.round(y), 1, rows - 2);
      const t0 = (px, py) => (ins(px, py) ? T[py][px] : null);
      // 只认"真正能当巡逻落脚点"的地形：平地/道路/桥。
      //   81 收紧了判据（原来第二档允许山地与洼地）：地图放大到 160×120 之后，
      //   环位公式给出的点更容易落在山脊背后，退档一开就把巡逻点丢在山上——
      //   巡逻队爬山 0.55 倍速，走到那儿要很久，玩家看到的是"敌人不出门"。
      const ok = (px, py) => { const t = t0(px, py); return t != null && (t === 'plain' || t === 'road' || t === 'bridge'); };
      // 搜索半径 7 → 14：图大了，7 格内没有空地的情况变多，原来会直接兜底返回原坐标，
      //   把点丢在森林里（骑兵巡逻点落森林是硬错：它根本走不进去）。
      if (ok(x, y)) return [x, y];
      for (let r = 1; r <= 14; r++)
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (ok(x + dx, y + dy)) return [x + dx, y + dy];
        }
      return [x, y];
    };
    const pcx = (pz.x1 + pz.x2) / 2, pcy = (pz.y1 + pz.y2) / 2;
    const prx = (pz.x2 - pz.x1) / 2, pry = (pz.y2 - pz.y1) / 2;
    // 五条环线，半径系数各不相同——同一条路上排纵队看着像赶集，也浪费巡逻覆盖。
    const RINGS = [[0.80, 0.30], [0.26, 0.74], [0.92, 0.88], [0.46, 0.16], [0.46, 0.84]];
    // 巡逻路线按调用方给的 id 列表发，环位轮转；**超过环位数的（第 6 支起）整条路外扩 3 格**，
    //   否则多出来的几支会跟前面同环位的挤在一条线上（贴太近会被行军避让互相顶开，走成锯齿）。
    // 骑兵标记：只给 index 2（编成表里唯一的"老骑兵位"，worldgen 的骑兵可达校验也拿它当样本），
    //   第 6 支起一律按骑兵可达吸附——骑兵能走的路步兵一定也能走，反过来不成立。
    const patrols = {};
    const ringN = RINGS.length;
    for (let i = 0; i < enemyIds.length; i++) {
      const [kx, ky] = RINGS[i % ringN];
      const grow = Math.floor(i / ringN) * 3;
      const cav = i === 2 || i >= ringN;
      const rx = prx + grow, ry = pry + grow;
      patrols[enemyIds[i]] = [
        [pcx - rx * kx, pcy - ry * ky], [pcx + rx * kx, pcy - ry * ky],
        [pcx + rx * kx, pcy + ry * ky], [pcx - rx * kx, pcy + ry * ky],
      ].map(([x, y]) => snap(x, y, cav));
    }

    // ── ⑪ 地标事实：扫描**成品地形**，按真实位置描述 ──────────
    // 这是 57 最要紧的一处改动。56 是"先有名字（北面森林/北面高地），再保证那边长出地形"，
    //   上司否掉的就是这个因果：**地图上有什么，名字才叫什么**。
    // 所以这里完全不看"我当初想放什么"，而是对最终 terrain 做连通块提取，
    //   每个真实存在的斑块按它自己的质心所在岸、所在纵向三分之一来命名。
    //   图上没有林子 → 就没有"树林"这个地标 → 说"去树林"会被如实回"地图上没有树林"。
    const bandOf = y => (y < rows / 3 ? 'north' : y > rows * 2 / 3 ? 'south' : 'mid');
    const dirCode = (area, band) => {
      if (band === 'north') return area === 'east' ? 'NE' : area === 'west' ? 'NW' : 'N';
      if (band === 'south') return area === 'east' ? 'SE' : area === 'west' ? 'SW' : 'S';
      return area === 'east' ? 'E' : area === 'west' ? 'W' : 'C';
    };
    const dirLabel = code => ({
      NW: '西北', N: '北面', NE: '东北', W: '西侧', C: '中路', E: '东侧', SW: '西南', S: '南面', SE: '东南',
    })[code] || '中路';

    function extract(kind, minTiles) {
      // 98（Q23）：森林改在 **cover 层**提取连通块，跨平地与坡地算同一片。
      //   其余地貌仍读 T；同一份代码只换"看哪张表"，不写第二套 BFS。
      const grid = (kind === 'forest') ? C : T;
      const seen = new Set(), out = [];
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
        if (grid[y][x] !== kind || seen.has(y * cols + x)) continue;
        const cells = [], q = [[x, y]];
        seen.add(y * cols + x);
        let sx = 0, sy = 0, x1 = x, x2 = x, y1 = y, y2 = y;
        while (q.length) {
          const [cx0, cy0] = q.pop();
          cells.push([cx0, cy0]); sx += cx0; sy += cy0;
          if (cx0 < x1) x1 = cx0; if (cx0 > x2) x2 = cx0;
          if (cy0 < y1) y1 = cy0; if (cy0 > y2) y2 = cy0;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = cx0 + dx, ny = cy0 + dy;
            if (!ins(nx, ny) || grid[ny][nx] !== kind) continue;
            const k = ny * cols + nx;
            if (seen.has(k)) continue;
            seen.add(k); q.push([nx, ny]);
          }
        }
        if (cells.length < minTiles) continue;
        out.push({ kind, cells, tiles: cells.length, x1, y1, x2, y2, cx: sx / cells.length, cy: sy / cells.length });
      }
      return out;
    }
    // 相邻同类斑块先合并成"一片"再命名：道路、桥头空地会把一片林子切成两三块，
    //   逐块命名会长出"东侧树林（三）（四）（五）"——那不是地名，是碎片编号。
    //   人说的"东边那片树林"本来就是连着的一片。合并半径 18 格（约一个视野）。
    // **但绝不跨河合并**：河两岸是两块地，中间那道水谁也走不过去。
    //   跨河合并会得到"西南洼地"，而它的落点在东岸——名字和地面对不上（seed 6 实测）。
    const mergeNear = (list, gap) => {
      const out = list.slice();
      const bankOfBlob = r => bankOf(r.cx, r.cy);
      let merged = true;
      while (merged) {
        merged = false;
        for (let i = 0; i < out.length && !merged; i++)
          for (let j = i + 1; j < out.length && !merged; j++) {
            const a = out[i], b = out[j];
            if (bankOfBlob(a) !== bankOfBlob(b)) continue;
            if (Math.hypot(a.cx - b.cx, a.cy - b.cy) > gap) continue;
            out[i] = {
              kind: a.kind, cells: a.cells.concat(b.cells), tiles: a.tiles + b.tiles,
              x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1),
              x2: Math.max(a.x2, b.x2), y2: Math.max(a.y2, b.y2),
              cx: (a.cx * a.tiles + b.cx * b.tiles) / (a.tiles + b.tiles),
              cy: (a.cy * a.tiles + b.cy * b.tiles) / (a.tiles + b.tiles),
            };
            out.splice(j, 1);
            merged = true;
          }
      }
      return out;
    };
    // 落点：取"离质心最近、且周围同类最多"的那一格——避免把地标钉在斑块的一条细尾巴上
    const anchorOf = r => {
      const grid = (r.kind === 'forest') ? C : T;   // 98：森林的"周围同类最多"要在 cover 层数
      let best = null, bd = Infinity;
      for (const [x, y] of r.cells) {
        const d = Math.hypot(x - r.cx, y - r.cy);
        let nb = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++)
          if (grid[y + dy] && grid[y + dy][x + dx] === r.kind) nb++;
        const score = d - nb * 0.6;
        if (score < bd) { bd = score; best = { x, y }; }
      }
      return best || { x: Math.round(r.cx), y: Math.round(r.cy) };
    };

    const landmarks = [];
    const idUsed = {};
    // id 前缀**沿用旧契约**（BR_ / FOR_ / HILL_ / CAMP_）：分兵解析靠 BR_ 找"所有桥"，
    //   截图脚本和测试也按这个名字找地标。曾经用 kind.slice(0,3) 自动生成，
    //   结果桥变成 BRI_、高地变成 HIL_，分兵直接失灵——前缀不是装饰，是给别的层看的接口。
    const ID_PRE = { forest: 'FOR', hill: 'HILL', marsh: 'MARSH', camp: 'CAMP', bridge: 'BR' };
    const makeId = (kind, code) => {
      const base = (ID_PRE[kind] || 'LM') + '_' + code;
      idUsed[base] = (idUsed[base] || 0) + 1;
      return idUsed[base] === 1 ? base : base + idUsed[base];
    };
    // 同名的第二处起加"（二）（三）"：重名地名等于没有地名——
    //   玩家说"去西北树林"，系统反问"哪一处"时列出的两行字一模一样，等于没问。
    //   下标对齐要小心：计数 2 应当得到"（二）"。第一版写成 `['', '（二）', '（三）'][2]`
    //   等于"（三）"，于是地图上只有"树林""树林（三）"、永远缺"（二）"——看着像漏了一块地。
    const nameUsed = {};
    const ORD = ['', '', '（二）', '（三）', '（四）', '（五）', '（六）', '（七）', '（八）'];
    const uniqueName = nm => {
      nameUsed[nm] = (nameUsed[nm] || 0) + 1;
      const n = nameUsed[nm];
      return n === 1 ? nm : nm + (ORD[n] || '（' + n + '）');
    };
    const pushPlace = p => { landmarks.push(p); return p; };

    // 地貌地标
    const MIN_T = { forest: 14, hill: 14, marsh: 8 };
    // 小得不成片的（一片灌木丛）依然是地形，但**不当地标**：
    //   给它起个名字只会让"去东侧树林"多出一堆候选。玩家指的还是那些看得出来的大片。
    const NAME_MIN = { forest: 40, hill: 35, marsh: 18 };
    for (const kind of ['forest', 'hill', 'marsh']) {
      for (const r of mergeNear(extract(kind, MIN_T[kind]), 18)) {
        if (r.tiles < NAME_MIN[kind]) continue;
        const a = anchorOf(r);
        const area = bankOf(r.cx, r.cy) === 'east' ? 'east' : 'west';
        const band = bandOf(a.y);
        const code = dirCode(area, band);
        const nm = uniqueName(dirLabel(code) + KIND_NAME[kind]);
        pushPlace({
          id: makeId(kind, code), kind, name: nm, label: nm,
          x: a.x, y: a.y, cx: r.cx, cy: r.cy, x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2,
          nx: r.cx / cols, ny: r.cy / rows,
          // 98（Q23）：把连通块的格表带出到地标，**只读、不进模拟**；
          //   b/c 层与埋伏判据要按"这片林子到底铺到哪儿"说话，不能靠包围盒猜。
          cells: r.cells,
          tiles: r.tiles, area, band, owner: null,
        });
      }
    }
    // 桥
    const bs = bridges.slice().sort((a, b) => a.cy - b.cy);
    // 桥的名字按**南北次序**排（最北那座叫北桥），不按"落在地图哪三分之一"——
    //   河段分段架桥时三座桥常常都落在中间三分之一，那样会得到"中桥（二）（三）"，
    //   等于没名字。按理序排，玩家说"北桥""最南那座桥"都对得上。
    const BR_NAMES = bs.length === 1 ? ['桥']
      : bs.length === 2 ? ['北桥', '南桥']
        : bs.length === 3 ? ['北桥', '中桥', '南桥']
          : bs.length === 4 ? ['北桥', '中北桥', '中南桥', '南桥']
            : bs.map((_, i) => (i === 0 ? '北桥' : i === bs.length - 1 ? '南桥' : '桥' + (i + 1)));
    bs.forEach(b => {
      const band = bandOf(b.cy);
      const code = band === 'north' ? 'N' : band === 'south' ? 'S' : 'C';
      b.id = makeId('bridge', code);
      const nm = uniqueName(BR_NAMES[bs.indexOf(b)] || '桥');
      pushPlace({
        id: b.id, kind: 'bridge', name: nm, label: nm,
        x: Math.round((b.x1 + b.x2) / 2), y: Math.round(b.cy),
        cx: (b.x1 + b.x2) / 2, cy: b.cy, x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2,
        nx: (b.x1 + b.x2) / 2 / cols, ny: b.cy / rows,
        tiles: (b.x2 - b.x1 + 1) * (b.y2 - b.y1 + 1),
        area: null, band, owner: null, west: b.west, east: b.east,
      });
    });
    // 营地
    sites.forEach(s => {
      s.side = bankOf(s.x, s.y) === 'east' ? 'east' : 'west';
      const band = bandOf(s.y);
      const code = dirCode(s.side, band);
      s.id = makeId('camp', code);
      s.name = uniqueName(dirLabel(code) + '营地');
      s.kind = 'camp'; s.owner = 'neutral'; s.area = s.side; s.band = band;
      pushPlace({
        id: s.id, kind: 'camp', name: s.name, label: s.name,
        x: s.x, y: s.y, cx: s.x, cy: s.y, x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2,
        nx: s.x / cols, ny: s.y / rows,
        tiles: 9, area: s.area, band, owner: 'neutral',
      });
    });
    // 本营（两处，owner 固定）
    for (const b of [blueBase, redBase]) {
      pushPlace({
        id: b.id, kind: 'base', name: b.name, label: b.name,
        x: Math.round((b.x1 + b.x2) / 2), y: Math.round((b.y1 + b.y2) / 2),
        cx: (b.x1 + b.x2) / 2, cy: (b.y1 + b.y2) / 2, x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2,
        nx: (b.x1 + b.x2) / 2 / cols, ny: (b.y1 + b.y2) / 2 / rows,
        tiles: 16, area: b.side === 'red' ? 'east' : 'west', band: bandOf((b.y1 + b.y2) / 2),
        owner: b.side === 'blue' ? 'blue' : 'red',
      });
    }
    // "中央营地"= 离河最近的那处（占领默认目标沿用旧口径）。hidden：不参与地名解析，
    //   否则同一个营地在解析器里会出现两次（一次叫"西北营地"、一次叫"中央营地"）。
    let objSite = sites[0], bd = Infinity;
    for (const s of sites) { const d = Math.abs(s.x - rivC); if (d < bd) { bd = d; objSite = s; } }
    const obj = {
      id: 'OBJ', kind: 'camp', name: '营地', label: objSite.name, hidden: true,
      x: objSite.x, y: objSite.y, x1: objSite.x1, y1: objSite.y1, x2: objSite.x2, y2: objSite.y2,
    };
    landmarks.push(obj);

    // ── ⑫ 校验：只验"物理上不能坏"的，不验"好不好玩" ──────────
    // 这几条全部是"不满足就说明这张图是错的"：
    //   ① 桥面每一格都必须在河上、两头必须接岸（悬空的桥＝部队走到中间无路可走）
    //   ② 营地/出生点必须站得住
    //   ③ 步兵能从蓝方出生点走到红方本营（两岸真的能来往）
    //   ④ 每处营地都走得到；骑兵能走到每座桥的本岸桥头（它进不了森林）
    // 反过来说，这里**不检查**"桥有几座""树林有几块""北边有没有森林"——
    //   那些是这张图长出来的样子，不是合格标准。
    for (const b of bridges) {
      for (let y = b.y1; y <= b.y2; y++)
        for (let x = b.x1 + 1; x <= b.x2 - 1; x++) {
          // 桥面中段必须在原河道上（两端的 ±1 格是搭在岸上的桥台，允许是陆地）
          if (runs[y] && (x < runs[y].x1 || x > runs[y].x2)) return { fail: '桥没架在河上' };
        }
      if (!ins(b.x1 - 1, b.y1) || !ins(b.x2 + 1, b.y1)) return { fail: '桥头出界' };
    }
    // 98：forest 已不在 T 里，出生点/营地的"无树"由 cover 判；保护区已清 C，这条是断言不是补救。
    const standable = (x, y) => ins(x, y) && T[y][x] !== 'river' && T[y][x] !== 'marsh' && C[y][x] === null;
    for (const p of spawns.blue) if (!standable(p.x, p.y)) return { fail: '蓝方出生点不可站' };
    for (const p of spawns.red) if (!standable(p.x, p.y)) return { fail: '红方出生点不可站' };
    for (const s of sites) if (!standable(s.x, s.y)) return { fail: '营地不可站' };

    const bfs = (sx, sy, allowForest) => {
      const seen = new Set([sy * cols + sx]);
      const q = [[sx, sy]];
      while (q.length) {
        const [x, y] = q.pop();
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy;
          if (!ins(nx, ny)) continue;
          const t = T[ny][nx];
          if (t === 'river') continue;
          // 98（Q6）：骑兵**可以进森林**，只是速度严重降低；所以不再把 cover 当墙。
          //   `allowForest` 参数保留（调用点与测试都在用），现在两档都走同一套 base 通行判据；
          //   "骑兵到不了桥"这条校验仍在，抓的是桥头被河/地形隔断，不是"路上有树"。
          const k = ny * cols + nx;
          if (seen.has(k)) continue;
          seen.add(k); q.push([nx, ny]);
        }
      }
      return seen;
    };
    const seen = bfs(spawns.blue[0].x, spawns.blue[0].y, true);
    const has = (x, y) => seen.has(y * cols + x);
    const rbx = Math.round((redBase.x1 + redBase.x2) / 2), rby = Math.round((redBase.y1 + redBase.y2) / 2);
    if (!has(rbx, rby)) return { fail: '两岸不连通' };
    for (const s of sites) if (!has(s.x, s.y)) return { fail: '营地不可达' };
    const cavSeen = bfs(spawns.blue[2].x, spawns.blue[2].y, false);
    for (const b of bs) {
      const head = bankOf(b.west.x, b.west.y) === 'east' ? b.east : b.west;
      if (!cavSeen.has(head.y * cols + head.x)) return { fail: '骑兵到不了桥' };
    }

    return {
      cols, rows, terrain: T,
      // 98：地貌层与森林片 id（同片森林埋伏判据的唯一事实源）。
      //   forestId[y][x] = -1 表示无树；>=0 是 4 邻连通块编号，跨平地/坡地算同一片。
      cover: C, forestId, forestN,
      // river 保留旧字段（x1/x2/width/cx = 全图包络），新增 spine 与 at(y)：
      //   河会拐之后，"x 在河的哪边"这个问题只有带上行号才有答案。
      river: {
        x1: rx1, x2: rx2, width: rx2 - rx1 + 1, cx: rivC,
        spine: spineX.map((x, y) => ({ x, w: spineW[y] })),
        at: y => runAt(y), bankOf,
      },
      bridges: bs, sites, obj, bases: [blueBase, redBase],
      landmarks, patrolZone: pz, patrols, spawns,
      hills: landmarks.filter(l => l.kind === 'hill'),
      forests: landmarks.filter(l => l.kind === 'forest'),
    };
  }

  globalThis.WORLDGEN = { build, mulberry32 };
})();
