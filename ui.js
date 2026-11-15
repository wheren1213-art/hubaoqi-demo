// ui.js — 界面层（画布渲染 / 部队列表 / 鼠标与按钮 / 文字输入框 / 命令日志面板）
// 约定：UI 可以读 SIM 的任何状态，但 SIM 永远不反向调用 UI。
// 执行命令后统一走 flush()（把模拟层攒的播报写到状态栏）+ refresh()（重绘列表/详情/地图）。
// 依赖加载顺序：sim.js → command.js → 本文件（输入框直接调全局 CMD）→ main.js。
(() => {
  const S=SIM;
  const canvas=document.getElementById('map');
  const ctx=canvas.getContext('2d');
  ctx.imageSmoothingEnabled=false;
  const statusText=document.getElementById('statusText');
  const info=document.getElementById('selectedInfo');
  const warInfo=document.getElementById('warInfo');
  const unitList=document.getElementById('unitList');
  const cmdInput=document.getElementById('cmdInput');
  const cmdButton=document.getElementById('cmdButton');
  const cmdEchoEl=document.getElementById('cmdEcho');
  const cmdBox=document.getElementById('textCmdBox');
  const cmdLogListEl=document.getElementById('cmdLogList');
  const cmdLogStatsEl=document.getElementById('cmdLogStats');
  const cmdLogBoxEl=document.getElementById('cmdLogBox');
  const voiceBtnEl=document.getElementById('voiceBtn');
  const voiceHintEl=document.getElementById('voiceHint');
  const CMD_PLACEHOLDER=cmdInput.placeholder||'';

  // ── 地形底色（2026-10-28 ㊵ 起，㊹ 柔化）──────────────────────────
  // 目标：拼起来像连续地面，既不能有格线，也不能有"一格一色块"的台阶。
  // 演进：
  //   ㊵ 逐格独立扰动 → 一格一个色块，缩小后马赛克比格线更显眼；
  //   ㊶ 改成 3×3 共用一档、幅度 ±2.5 → 马赛克没了，但 60px 的块边界成了新的台阶；
  //   ㊹（本版）改成**平滑值噪声**：噪声在**格坐标**上做双线性插值（smoothstep），
  //     相邻格取到的值只差一点点，一格之内是一个颜色、格与格之间是渐变 → 台阶消失。
  //     仍然是确定性的（坐标哈希，无 Math.random），否则每帧重算颜色整张图会闪。
  //
  // 性能：不能每格都拼 RGB 字符串（可见格约 1000 个 × 60fps）。
  //   把噪声量化成 SHADE_N 档，每档颜色预计算进调色板：台阶 = 幅度/档数 ≈ 0.17 个色阶，
  //   肉眼不可见，但省掉了每帧的 parseInt + 模板字符串。
  const SHADE_AMP = 11;     // 明暗总幅度（±5.5）：再大就会看出"一格深一格浅"
  const SHADE_N = 64;       // 量化档数：64 档 × ±5.5 → 每档 0.17，绝对看不出分档
  function shiftColor(hex, d) {
    const n = parseInt(hex.slice(1), 16);
    const clamp = v => Math.max(0, Math.min(255, Math.round(v)));
    return `rgb(${clamp(((n >> 16) & 255) + d)},${clamp(((n >> 8) & 255) + d)},${clamp((n & 255) + d)})`;
  }
  const PALETTE = {};
  for (const [k, v] of Object.entries(S.colors)) {
    PALETTE[k] = [];
    for (let i = 0; i < SHADE_N; i++) PALETTE[k].push(shiftColor(v, (i / (SHADE_N - 1) - .5) * SHADE_AMP));
  }
  // 确定性格点哈希 → 0..1。
  // 65：从 Math.sin 换成整数哈希。成像一遍要算 5000 多万次格点哈希，
  //   Math.sin 那种写法在浏览器里要 1.8 秒（实测烘图 1823ms 全花在这上面），
  //   整数哈希（Math.imul 三轮）快十几倍，分布一样均匀、一样确定。
  const vhash = (i, j) => h2(i | 0, j | 0);
  // 双线性 + smoothstep 插值：**跨格连续**是柔化的全部要点。
  //   scale = 噪声的格周期（5 ≈ 100px 的大斑块，2.2 是小起伏），两层叠起来才不像塑料。
  function vnoise(x, y, scale) {
    const fx = x / scale, fy = y / scale;
    const x0 = fx | 0, y0 = fy | 0;              // 坐标恒为非负，|0 比 Math.floor 快得多
    const tx = fx - x0, ty = fy - y0;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const a = vhash(x0, y0), b = vhash(x0 + 1, y0), c = vhash(x0, y0 + 1), d = vhash(x0 + 1, y0 + 1);
    return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
  }
  function tintAt(x, y, type) {
    const pal = PALETTE[type] || PALETTE.plain;
    const n = vnoise(x, y, 5) * .65 + vnoise(x + 13, y + 7, 2.2) * .35;
    return pal[Math.min(SHADE_N - 1, Math.max(0, Math.round(n * (SHADE_N - 1))))];
  }

  // ── 相机（2026-10-30 62 重定：**没有缩放**，主视图就是主将的视野框）────────
  // 整图 3584×2688（128×96 格）装不进 800×600 画布，必须要有个视口。
  // 画法上只动一处：draw() 开头 setTransform，之后所有绘制照旧写世界像素，
  //   不用给每个 fillRect 手动加减偏移——那是几十处、改必漏。
  // 约定：cam.x/cam.y 是「视口左上角的世界像素坐标」，zoom 是世界像素→画布像素的比例。
  //
  // 62 改的是什么：**缩放整条去掉**，视口大小固定，镜头每帧跟着主将走。
  //   理由（上司 2026-10-30 的原话）："大地图不要有缩放，只能在小地图上看到全貌。
  //   大地图它代表主将能感受到的地图范围。"
  //   于是 62 以前的"滚轮在 0.55~2.2 之间调"整套作废：
  //     · 一屏画多大不是玩家选的，是由主将视距（S.DETECT=8 格）定死的；
  //     · 镜头不是玩家的自由摄像机，是主将的眼睛——他走到哪，画面就到哪；
  //     · 全图只在**小地图**上看，那是"斥候回报的地图"，不是主将的视线。
  //   这条还牵到一条游戏规则（62 起）：**战斗短令只对画面里的部队有效**。
  //   画面能拖能缩，那条规则就随玩家的滑动松紧变化，等于没规则——所以视窗必须定死。
  // 63 改的是什么：**一屏从 16 格高放到 20 格高**（上司："把大地图看到的地图范围扩大一些"）。
  //   原来 VIEW_TILES 直接等于视距直径（2×8=16），画面边缘正好是视野圆的切线——一条"我能看多远"
  //   和"我能看到哪"完全重合的硬边。放到 20 格后，视距圆（直径 16 格）居中占 80% 高度，
  //   上下各余 2 格、左右各余 5.3 格：这一圈画的是**已探索但不在视野里**的地形（迷雾压暗），
  //   作用是给方向感——桥在哪边、本营在哪个方向，一眼能对出来。
  //   **代价要记清楚**：63 起短令范围跟着画面走（见下面 viewTiles 注释），画面放大＝能喊到的范围变大。
  //   下限是被视距卡死的：小于 2×视距，视野圆会被裁掉一块，那就不是"主将的视野"了。
  const VIEW_TILES = 20;                              // 一屏 20 格高（= 视距 8 的直径 16 + 上下各 2 格余量）
  const ZOOM_VIEW = canvas.height / (VIEW_TILES * S.TILE);   // 800÷(20×28) ≈ 1.071（每格 30 屏幕像素）
  const cam = { x: 0, y: 0, zoom: ZOOM_VIEW };
  let camFollow = true;   // ?cam= 指定取景的截图验收模式会把它关掉（生产页面没有这个参数）
  let zoomOverride = 0;   // 同上：只有验收参数能覆盖倍率，别的路一律走 ZOOM_VIEW
  const worldW = () => S.COLS * S.TILE, worldH = () => S.ROWS * S.TILE;
  function clampCam(){
    cam.zoom = zoomOverride || ZOOM_VIEW;              // 只有一个倍率：写死比"夹紧"更难被改坏
    const vw = canvas.width / cam.zoom, vh = canvas.height / cam.zoom;
    cam.x = Math.max(0, Math.min(worldW() - vw, cam.x));
    cam.y = Math.max(0, Math.min(worldH() - vh, cam.y));
    if (worldW() <= vw) cam.x = 0;
    if (worldH() <= vh) cam.y = 0;
    // 63：**把视口对齐到整屏幕像素**。倍率 1.071 不是整数，相机停在半像素上时，
    //   整张地形会被"每帧换一个采样相位"地重采样——固定不动时看不出来，
    //   **跟着主将平移时它就是一层持续抖动的噪点**（树冠/岩粒会一跳一跳）。
    //   对齐后每帧的偏移都是整数像素，采样相位不变，画面是"整块平移"而不是"重新采样"。
    //   代价：相机最多偏 0.5 屏幕像素（≈0.47 世界像素 ≈0.017 格），肉眼无感，
    //   但它保证 viewTiles() 折出来的范围与画出来的完全一致（同一套数，不另算）。
    cam.x = Math.round(cam.x * cam.zoom) / cam.zoom;
    cam.y = Math.round(cam.y * cam.zoom) / cam.zoom;
  }
  const camRect = () => ({ x: cam.x, y: cam.y, w: canvas.width / cam.zoom, h: canvas.height / cam.zoom });
  function centerOn(wx, wy){ cam.x = wx - canvas.width / cam.zoom / 2; cam.y = wy - canvas.height / cam.zoom / 2; clampCam(); }
  // 画面（= 主将视野框）内的格范围，c 层判"这句短令谁能听见"用。
  //   +1 格的余量：兵簇会跨出中心格（散阵最远到 1 格），卡在边界上的部队不该被算成画面外。
  function viewTiles(){
    const r = camRect();
    return { x0: r.x / S.TILE - 1, y0: r.y / S.TILE - 1,
             x1: (r.x + r.w) / S.TILE + 1, y1: (r.y + r.h) / S.TILE + 1 };
  }
  // 镜头跟主将：每帧画之前对一次（主将阵亡后落到地图中心，那时画面已经没有指挥意义）。
  //   不做缓动：主将走 3 格/秒，视口 26.7×20 格，硬跟不会晕，缓动反而让他在急停时飘一下。
  //
  // 63 修的**卡顿根因**（上司："移动的时候地图一格一格在移动，一顿一顿的"）：
  //   原来这里读的是 `c.x`——那是**格坐标，整数**，只在跨格那一刻变。于是兵在画面上是
  //   按 progress 平滑滑过去的（见下面画兵那段），**画面却整格整格地跳**：主将每走完一格，
  //   整张地图瞬移 30 像素。3 格/秒就是每秒顿三下，越慢越明显。
  //   修法：相机与兵用**同一套插值**（path[0] × progress），两边从同一个数出发，
  //   就不会再出现"兵在走、世界在跳"。跨格瞬间 progress 归 1，位置正好等于新格的整数坐标，
  //   所以衔接处不会回跳。
  //   66 起这套插值搬进 SIM：`S.renderPos(c)` 给的就是"这一步到下一步之间的成像坐标"，
  //   相机与兵读同一个函数，逻辑跑 20Hz、画面仍按帧率走。两边同源，不会再出现"兵在走、世界在跳"。
  //   跨格瞬间 progress 归 1，位置正好等于新格的整数坐标，所以衔接处不会回跳。
  function commanderFrac(){
    const c = (S.commander && S.commander.hp > 0) ? S.commander : null;
    if (!c) return null;
    return S.renderPos(c);
  }
  function followCommander(){
    if(!camFollow)return;
    const f = commanderFrac();
    if (f) centerOn(f.x * S.TILE + S.TILE / 2, f.y * S.TILE + S.TILE / 2);
    else centerOn(worldW() / 2, worldH() / 2);
  }
  function resetCamera(){ camFollow = true; followCommander(); }
  // 截图验收用的取景参数：?cam=格x,格y（可选 ,zoom 覆盖，仅验收；生产页面没有这个参数）。
  // 为什么要它：像"视野边界上兵簇怎么画"这类问题，只有真的在某个位置截到那一帧才能判断，
  //   光读代码猜不准；而镜头锁主将之后，无头浏览器没法把主将挪到你想要的位置（2026-10-28 ㊶）。
  function camFromQuery(){
    let q='';
    try{ q=new URLSearchParams(location.search).get('cam')||''; }catch(_){ return false; }
    const m=/^(-?[\d.]+),(-?[\d.]+)(?:,([\d.]+))?$/.exec(q);
    if(!m)return false;
    camFollow=false;                       // 验收模式：镜头不再被主将拉回去
    if(m[3])zoomOverride=+m[3]||0;
    // 98 真机截图抓到的尺子缺陷：centerOn 用 `canvas/zoom` 反算中心，而 cam.zoom 平时只在
    //   clampCam()（下一帧 draw）里跟着 zoomOverride 更新。带第三参 `?cam=x,y,zoom` 时，
    //   这里仍拿旧的 ZOOM_VIEW 算中心 → 镜头落在目标格以北十来格，截出来是一片平地，
    //   "坡上林"看着像没做。**先让倍率生效再定中心**，验收参数才指向它说的那一格。
    cam.zoom = zoomOverride || ZOOM_VIEW;
    centerOn((+m[1]+.5)*S.TILE,(+m[2]+.5)*S.TILE);
    return true;
  }

  // 画布内部像素 → 世界像素 → 格。鼠标点选用这一条换算（62 起不再用于平移）。
  function screenToTile(sx, sy){
    return { x: Math.floor((sx / cam.zoom + cam.x) / S.TILE), y: Math.floor((sy / cam.zoom + cam.y) / S.TILE) };
  }
  // 格中心 → 画布内部像素（测试与「点小地图/点列表」用同一条）
  function tileToScreen(tx, ty){
    return { x: (tx * S.TILE + S.TILE / 2 - cam.x) * cam.zoom, y: (ty * S.TILE + S.TILE / 2 - cam.y) * cam.zoom };
  }
  // 62：选中不再把镜头带过去（画面锁主将）。留着这个函数名是给外部调用方兜底——
  //   "把它挪进画面"这件事在 62 的模型里做不到，也不该做：看不见就是看不见，靠情报与命令。
  function ensureVisible(u){ return !!u; }
  // 鼠标事件 → 画布内部坐标（CSS 可能把画布拉伸过，得按 rect 换算回属性尺寸）
  function canvasPoint(event){
    const rect = canvas.getBoundingClientRect();
    return {
      sx: (event.clientX - rect.left) * (canvas.width / (rect.width || canvas.width)),
      sy: (event.clientY - rect.top) * (canvas.height / (rect.height || canvas.height))
    };
  }
  let hoverTile = null;   // 鼠标当前指着的格：格线隐藏后，这是"点哪一格"的唯一视觉依据

  // selected＝详情面板正在看的（可以是任何友军）；selection＝真正受令的（只能是主将）。
  // 两者分开是这套指挥权模型的地基，见下方 selectUnit / syncAuthority。
  let selected=S.commander||S.units[0];
  let selection=S.commander?[S.commander]:[];
  // 鼠标下令只有一件事：点到哪就做什么。点空地＝过去，点敌军＝打它（2026-10-28 ㊶）。
  //   原来要在"移动/攻击"两个模式之间切换，等于每次看见敌人都先按一下按钮声明意图——
  //   这一步没有任何信息量，只是让人多按一次。驻守/集结偶尔用，留按钮，但做成一次性：
  //   点完地图立刻回到默认，不会出现"以为是移动，结果全军驻守在半路"。
  let pending=null;   // null＝默认（过去/打它）｜'DEFEND'＝下一个点指驻守｜'RALLY'＝集结

  function show(message){statusText.textContent=message;}
  // 取走模拟层攒的播报：立即类（toast）最后一条获胜，批量类（logEvent）拼一句、优先显示——
  // 与拆分前"show() 即时覆盖 + 帧末 flushLog"的可见效果一致
  function flush(){
    const toasts=S.drainToasts(),events=S.drainEvents();
    if(events.length)show(events.join(' '));
    else if(toasts.length)show(toasts[toasts.length-1]);
  }
  function lastToast(){return S.peekLastToast();}
  function refresh(){renderList();updateInfo();draw();}
  // 回显留存（D）：不再只留最后一条，追加保留最近 4 条，旧的逐级淡出——
  // "报告"这类多行内容不会被下一条命令立刻冲掉。textContent 仍是全部文字拼接，测试照常可读。
  function echo(t){
    const row=document.createElement('div');
    row.textContent=t;
    cmdEchoEl.appendChild(row);
    while(cmdEchoEl.children.length>4)cmdEchoEl.removeChild(cmdEchoEl.firstChild);
  }
  function echoText(){return cmdEchoEl.textContent;}
  function lastEchoText(){const c=cmdEchoEl.children;return c.length?c[c.length-1].textContent:cmdEchoEl.textContent;}
  function ask(question){cmdInput.placeholder=question;cmdBox.classList.add('clarify');show(question);}
  function clearAsk(){cmdInput.placeholder=CMD_PLACEHOLDER;cmdBox.classList.remove('clarify');}

  // ── 语音按钮的外观（a 层的状态由 main.js 转过来，界面只管画） ──
  // 这里不判断语音能不能用、也不调识别服务：那是 a 层与装配的事。
  const VOICE_LABEL={idle:'🎤 按住',unsupported:'🎤 不可用',arming:'🎤 连接中',listening:'🎤 按住',
                     recording:'● 松开识别',transcribing:'… 识别中',error:'🎤 重试'};
  function setVoiceState(state,detail){
    if(!voiceBtnEl)return;
    voiceBtnEl.className='action'+(state&&state!=='idle'&&state!=='listening'?' '+state:'')+(state==='unsupported'?' error':'');
    voiceBtnEl.textContent=VOICE_LABEL[state]||VOICE_LABEL.idle;
    voiceBtnEl.disabled=(state==='unsupported');
    // 按钮的悬停说明跟着状态走：置灰时还挂着「按住说话」会误导
    voiceBtnEl.title=(state==='unsupported')
      ? ((detail&&detail.message)||'语音不可用（需要本机识别服务）')
      : '按住说话：松开即识别并下令';
    if(voiceHintEl){
      let h='';
      if(state==='unsupported')h=(detail&&detail.message)||'浏览器不支持录音（需要麦克风 + 本地 http 打开）。打字下令不受影响。';
      else if(state==='arming')h='正在请求麦克风权限…';
      else if(state==='transcribing')h='本地识别中…';
      else if(state==='error')h=(detail&&detail.message)||'语音不可用';
      else if(state==='listening'&&detail&&detail.hint)h=detail.hint;
      voiceHintEl.textContent=h;
    }
  }

  // ── 选择与列表 ──
  // 指挥权模型：**鼠标只直接指挥主将**。其它部队只能靠文字/语音命令调动（b→c→d 那条链路）。
  // 所以 selection（受令对象）恒为 [主将]；selected（详情面板正在看的）可以是任一友军——
  // "看得见"和"指挥得了"是两件事，混在一起就会出现"点一下就把别人的部队拖走"。
  function directUnit(){ return (S.commander && S.commander.hp > 0) ? S.commander : null; }
  function canDirect(u){ return !!u && u === S.commander && u.hp > 0; }
  // selection 与主将保持一致：改立将旗后，鼠标指挥权随之转移
  function syncAuthority(){
    const c = directUnit();
    if (!c) { if (selection.length) selection = []; return; }
    if (selection.length !== 1 || selection[0] !== c) selection = [c];
    if (!selected || selected.hp <= 0) selected = c;
  }
  // 选中"新鲜度"：刚用鼠标点选过 → 文字命令未点名时优先用选中；
  // 被文字命令当作回退用过一次、或从未点选 → 让位给命令层的"沿用上一条命令的部队"
  let selectionFresh=false;
  // 返回 true＝真的指挥到了（主将）；false＝只是看了一眼
  function selectUnit(u,additive){
    if(!u||u.hp<=0)return false;
    selected=u;
    if(canDirect(u)){ selection=[u]; selectionFresh=true; }
    else { syncAuthority(); selectionFresh=false; }   // 看别人不会抢走主将的受令权
    ensureVisible(u);   // 扩图后部队可能在视野外：选中了就得看得见（在视野内则不动）
    renderList();updateInfo();
    return canDirect(u);
  }
  function liveSelection(){syncAuthority();return selection.filter(u=>u.hp>0&&!u.isRouted);}
  function renderList(){
    syncAuthority();
    // 只在数量变化时重建按钮，其余情况只刷新文字，避免每帧重建 DOM
    if(unitList.children.length!==S.units.length){
      unitList.innerHTML='';
      for(const u of S.units){
        const b=document.createElement('button');b.className='unit';
        b.onclick=e=>{
          if(u.hp<=0)return;
          const ok=selectUnit(u,!!(e&&e.shiftKey));
          // 62：画面锁在主将身上，选一支画面外的部队只能看情报——这一点必须说清楚，
          //   否则玩家会以为"点了它却没反应"是坏了。
          const vt=viewTiles(), far=u.x<vt.x0||u.x>vt.x1||u.y<vt.y0||u.y>vt.y1;
          show(ok
            ? `已选中主将${u.name}：点地图即移动。`
            : (far
                ? `${u.name}不在主将视野里，面板上是它最近一次回报的情况。要调它请点名下令，比如「${u.name}去北桥」。`
                : `${u.name}只能看，不能拖——它不归鼠标直接指挥。要调它请下令，比如「${u.name}去北桥」。`));
        };
        unitList.appendChild(b);
      }
    }
    for(let i=0;i<S.units.length;i++){
      const u=S.units[i],b=unitList.children[i];
      // 薄雾区的部队走 reported()：面板上是信使带回来的旧情报，不是此刻的真值
      const v=S.reported(u);
      const txt=u.hp>0
        ? `${u.type} · ${u.speed} 格/秒 · ${v.hp}/${v.maxHp} HP · 士气 ${Math.round(v.morale)}（${S.moraleWord(v.morale)}） · ${v.stance==='GUARDED'?'戒备':'常行'} · ${S.alertWord(v)} · ${v.state}${v.stale>0?` · 情报 ${v.stale.toFixed(1)}s 前`:''}`
        : (u.captured ? '被俘' : '阵亡');
      if(b.dataset.txt!==txt){
        b.dataset.txt=txt;
        const flag=u===S.commander?' · 主将（鼠标指挥）':(v.stale>0?' · 待传令':'');
        b.innerHTML=`<span>${u.name}<small>${txt}${flag}</small></span><i class="unit-mark" style="background:${u.color}"></i>`;
      }
      const cls='unit'+(selection.includes(u)?' active':'')+(v.stale>0?' stale':'');
      if(b.className!==cls)b.className=cls;
      b.disabled=u.hp<=0;
    }
    refreshStance();
  }
  function updateInfo(){
    let t='';
    if(selected){
      const u=selected;
      if(u.hp<=0)t=`${u.name}${u.captured?'已被俘（部众放下兵器，未加诛杀）':'已阵亡'}。`;
      else{
        // 薄雾区（主将视线外）：只报信使带回的旧情报。
        // 这里刻意不显示戒备/精力/接触点这些"此刻"才有的内部量——否则延迟就形同虚设。
        const v=S.reported(u);
        if(v.stale>0){
          t=`${u.name} · 情报约 ${v.stale.toFixed(1)} 秒前\n`
           +`生命 ${v.hp}/${v.maxHp} · 士气 ${Math.round(v.morale)}（${S.moraleWord(v.morale)}） · ${v.stance==='GUARDED'?'戒备':'常行'} · 状态：${v.state}\n`
           +`位置 (${Math.round(v.x)}, ${Math.round(v.y)}) · 认知：${S.alertWord(v)}\n`
           +`它在主将视野之外，这是信使刚带回的旧情报；要实时，把主将带过去。`;
        } else {
        const {allies,foes}=S.localBalance(u);
        const edge=foes===0?'周边无敌情':allies>foes?`局部优势 ${allies}:${foes}`:allies<foes?`局部劣势 ${allies}:${foes}`:`势均力敌 ${allies}:${foes}`;
        // 2026-11-13：面板与结算同源，只报**稳态**那四项和交战状态。
        //   已删掉的地形／命令／主将自身／认知加成一律不再显示——机制没了还留着说明，
        //   玩家会照着面板去找一个不存在的原因。
        const extras=[];
        if(S.isEngaged(u))extras.push('交战中（士气冻结，不向稳态靠近）');
        let 兵力差=0;
        {
          let mine=S.兵力权重(u),theirs=0;
          for(const o of S.allUnits){
            if(o===u||o.hp<=0||S.distance(u,o)>S.MORALE.RADIUS)continue;
            if(o.team===u.team){if(!o.isRouted)mine+=S.兵力权重(o);}
            else theirs+=S.兵力权重(o);
          }
          兵力差=theirs===0?0:(mine-theirs)*S.MORALE.SWING;
        }
        if(兵力差)extras.push(`周边兵力 ${兵力差>0?'+':''}${兵力差.toFixed(1)}`);
        const boss=S.commanderOf(u.team);
        if(boss&&boss.hp>0&&!boss.isRouted&&boss!==u&&S.distance(u,boss)<=S.MORALE.AURA_RADIUS)
          extras.push(`将旗光环 +${S.MORALE.AURA}`);
        extras.push(u.stance==='GUARDED'?`戒备中 精力 ${Math.round(u.stamina)}`:`常行 精力 ${Math.round(u.stamina)}`);
        const grp=selection.length>1?`｜编组 ${selection.length} 支`:'';
        const foeName=u.contact?(S.targetById(u.contact.id)||{}).name:'';
        const ago=u.contact&&u.contact.t!=null?Math.max(0,S.simTime-u.contact.t):null;
        const g=Math.round(u.guard*100);
        const aware=u.reactTimer>0
          ? `措手不及，还要 ${u.reactTimer.toFixed(1)} 秒才反应得过来`
          : u.alert==='ALERT'
            ? `已目视${foeName?`（${foeName} 在视野内）`:'来敌'}，自动摆正正面`
            : u.alert==='SUSPECT'
              ? `有预期——戒备 ${g}%${u.contact?`，最后目击在 (${Math.round(u.contact.x)}, ${Math.round(u.contact.y)})${ago!=null?` ${ago.toFixed(0)} 秒前`:''}`:''}，但没看见人`
              : `未预期——戒备 ${g}%，被贴身撞上会吃全威力突袭`;
        // ㊵：阵型与将领只报状态，不提加成——机制还没接，说了就是骗玩家
        // ⑸9：阵型名跟着"这支在干什么"变（行军纵阵 / 接敌线阵 / 溃退散阵），
        //   结阵状态另外报，两件事不混：一名是排法，一个是稳不稳。
        // 67：阵型名归 troop.js 算（它才是那份动画状态的持有者），面板只读不给。
        const formTxt=`${TROOP.formationLabel(TROOP.formKeyOf(u))}（${u.formation==='FORMED'?'已结阵':'破阵'+(u.formationWhy?`：${u.formationWhy}`:'')}）`;
        const leadTxt=(u.leader&&u.leader.alive)?` · ${u.leader.kind==='commander'?'主将亲在':'将领随军'}`:'';
        // ㊸：地形对视野的影响要报出"为什么"，不能只给一个数。
        //   数字是结果，原因是玩家能拿来决策的东西（要不要现在上山/钻林/贴河走）。
        const eye=S.eyeHeight(u), whys=[];
        if(eye>0)whys.push(`高地 +${(S.SIGHT.HILL*eye).toFixed(1)}`);
        else if(eye<0)whys.push(`洼地 ${(S.SIGHT.HILL*eye).toFixed(1)}`);
        if(S.tileOf(u)==='forest')whys.push(`林中 ×${S.SIGHT.IN_FOREST}`);
        // 主将报"基础视距"（＝判定距离），友军报"侦察半径"（薄雾小圈）——两个数本来就不是一回事
        const isC=u===S.commander;
        const visionLine=`视野：${isC?'基础视距':'侦察半径'} ${S.fogRadius(u).toFixed(1)} 格${whys.length?`（${whys.join('，')}）`:''}`;
        // 78：挂着等条件的部队，面板必须写清"等谁、挂了多久"。
        //   这是防 SILENT_STEP 的唯一手段——界面像已下令、兵其实在等，是最难被发现的错：
        //   它不报错、不卡死，只是这一局你少了几支部队，而且要到打输了才会发现。
        const armedTxt=u.armed
          ? `\n待触发：等${u.armed.text} · 已挂 ${Math.max(0,S.simTime-u.armed.since).toFixed(0)} 秒${u.holdFire?' · 伏着不动（被打了才还手并暴露）':''}`
          : (u.holdFire?'\n伏击中：不主动接敌（被打了才还手并暴露位置）':'');
        t=`生命 ${u.hp}/${u.maxHp} · 士气 ${Math.round(u.morale)}（${S.moraleWord(u.morale)}） · 精力 ${Math.round(u.stamina)} · 状态：${u.state}${u.path.length?` · 剩余 ${u.path.length} 格`:''}${grp}\n${edge} · 伤害系数 ×${(.7+S.MORALE.BONUS*(u.morale/100)).toFixed(2)}${extras.length?` · ${extras.join(' · ')}`:''}\n阵型：${formTxt}${leadTxt}\n${visionLine}\n认知：${aware}${armedTxt}`;
        }
      }
    }
    if(info.textContent!==t)info.textContent=t;
  }
  function avgMorale(list){
    const alive=list.filter(u=>u.hp>0);
    if(!alive.length)return 0;
    // 优先统计还在战线上的部队；全员溃退时才退回统计溃兵，避免显示为 0
    const steady=alive.filter(u=>!u.isRouted);
    const pool=steady.length?steady:alive;
    return Math.round(pool.reduce((s,u)=>s+u.morale,0)/pool.length);
  }
  function updateWar(){
    const blueAlive=S.units.filter(u=>u.hp>0).length, redAlive=S.enemies.filter(e=>e.hp>0).length;
    const blueRouted=S.units.filter(u=>u.hp>0&&u.isRouted).length, redRouted=S.enemies.filter(e=>e.hp>0&&e.isRouted).length;
    // 战况面板（54）：营地是**分散五处**，胜负只剩主将一条。
    //   五处逐条列出来，面板会变成一张表，玩家在战斗里不会读——
    //   所以报"我几处/敌几处 + 争夺中几处 + 最激烈那处几成"。
    const wb=S.baseOf('blue'), eb=S.baseOf('red');
    const sites=S.sites||[];
    const siteMine=sites.filter(s=>s.holder==='blue').length, siteHis=sites.filter(s=>s.holder==='red').length;
    const siteHot=sites.filter(s=>!s.holder&&s.progress>0).sort((a,b)=>b.progress-a.progress)[0];
    const siteTxt=sites.length
      ? `我 ${siteMine} / 敌 ${siteHis} / 中立 ${sites.length-siteMine-siteHis}`
        +(siteHot?`（最烈 ${siteHot.name} ${Math.round(siteHot.progress*100)}%）`:'')
      : '—';
    const baseTxt=b=>!b?'—':(b.owner===b.side?'完好':'失守');
    // 52：敌军 3→5 支，"x/3" 这种写死的分母会显示成 "敌军 5/3"。分母一律问 d 层。
    const t=S.result
      ? `战斗结束：${S.resultWhy||''}。`
      : `我方 ${blueAlive}/${S.units.length} · 敌军 ${redAlive}/${S.enemies.length} · 主将 ${S.commanderDown('blue')?(S.commander&&S.commander.leader&&S.commander.leader.captured?'被俘':'阵亡'):'在阵'}\n营地 ${siteTxt}\n本营 我${baseTxt(wb)} / 敌${baseTxt(eb)} · 我方均气 ${avgMorale(S.units)}${blueRouted?` · 溃退 ${blueRouted}`:''} · 敌方均气 ${avgMorale(S.enemies)}${redRouted?` · 溃退 ${redRouted}`:''}`;
    if(warInfo.textContent!==t)warInfo.textContent=t;
  }

  // ── 一支部队 = 一簇单位（2026-10-28 ㊵ 立，2026-10-30 ⑸9 改成阵型）──────
  // 场上仍然只有一条单位记录，这几个点纯属表现：兵力下降 → 队形变稀，
  //   玩家不用读数字就能看出"谁被打残了"。
  // ⑸9：位次不再写死 3×3，改由 TROOP.troopMen 算——它已经把"九兵各自的过渡位次 +
  //   队形朝向旋转"算好了，这里只负责画。**锚点是格中心的世界像素**，不是格左上角：
  //   阵型会跨出本格（线阵约 1.4 格宽），按左上角锚定会让整队偏向左上。
  // 将领（含主将）占模板的第 4 号位，比兵大一圈、带金/银边——**部队没全灭它就一直在**。
  // 67：编制/队形整块归 troop.js（e1），本文件只读它，不再碰任何 `u.men / u.head`。
  function drawCluster(u, ax, ay, d) {
    const B = TROOP.BODY, men = TROOP.troopMen(u, ax, ay, d);
    // 不画底衬：试过一层半透明暗底，结果整个簇立刻又变成一个"棋子方块"，
    //   多单位的意义就没了。现在只靠兵自己的深描边把队形和地面分开。
    for (const m of men) {
      if (m.leader) continue;
      ctx.fillStyle = '#10171a'; ctx.fillRect(m.x - B / 2 - .45, m.y - B / 2 - .45, B + .9, B + .9);
      ctx.fillStyle = (u && u.color) || '#8a8f8a'; ctx.fillRect(m.x - B / 2, m.y - B / 2, B, B);
      ctx.fillStyle = 'rgba(255,255,255,.3)'; ctx.fillRect(m.x - B / 2 + .7, m.y - B / 2 + .7, 1.3, 1.3);
    }
    // 将只比兵大一圈（+0.6），靠颜色区分而不是靠尺寸：做太大就会压到相邻兵位，
    //   整簇糊成一团，多单位反而看不出来（实机截图后定的尺寸）
    for (const m of men) {
      if (!m.leader) continue;
      const L = B + .6, isC = m.kind === 'commander';
      ctx.fillStyle = '#141108'; ctx.fillRect(m.x - L / 2 - .9, m.y - L / 2 - .9, L + 1.8, L + 1.8);
      ctx.fillStyle = isC ? '#e8c65a' : '#b9c6cd'; ctx.fillRect(m.x - L / 2, m.y - L / 2, L, L);
      ctx.fillStyle = isC ? '#4a3a12' : '#31403f'; ctx.fillRect(m.x - L / 2 + 1.2, m.y - L / 2 + 1.2, L - 2.4, L - 2.4);
      ctx.fillStyle = isC ? '#f8ea9f' : '#eef4f6';
      ctx.fillRect(m.x - .9, m.y - .9, 1.8, 1.8);
    }
  }

  // 每格地面的填充矩形。**故意比格子大一圈**（左右各 0.5 世界像素）：
  //   滚轮缩放到非整数倍率时，两个相邻 fillRect 的边缘各自抗锯齿，中间会透出一条
  //   背景色的细缝——那就是"缩放后还能看见的格线"。让它俩重叠半像素，缝就没了。
  //   单独抽成函数并导出（UI.tileRect），是为了让测试能盯住"相邻格必须重叠"这条。
  const TILE_PAD = .5;
  function tileRect(x, y){
    return { x: x * S.TILE - TILE_PAD, y: y * S.TILE - TILE_PAD,
             w: S.TILE + TILE_PAD * 2, h: S.TILE + TILE_PAD * 2 };
  }

  // ── 视野环（2026-10-28 ㊸）────────────────────────────────────
  // 选中部队时，沿 VISION_RAYS 条射线往外走，走到"看不清为止"，端点连成一条虚线。
  // 它和 canSee / 迷雾用的是同一个 visionRadius 与 losCap，所以这条线**就是判定边界**：
  //   山脊后面、林子后面会直接塌进来一个缺口。这就是"地形影响视野"在画面上的样子——
  //   不需要玩家去读数字，也不需要另建一套"视野预览"公式（另建就必然和判定分叉）。
  // 缓存键里带 guard：戒备拉满时环会当场变大，玩家看得见"戒备换情报"这件事。
  const VISION_RAYS = 72;
  let visionCache = { key: '', pts: [] };
  function visionPolygon(u) {
    const key = `${u.id}|${Math.round(u.x)}|${Math.round(u.y)}|${Math.round(u.guard * 10)}|${u.facing}`;
    if (visionCache.key === key) return visionCache.pts;
    const R = S.fogRadius(u), pts = [];
    const ox = Math.round(u.x), oy = Math.round(u.y);
    for (let i = 0; i < VISION_RAYS; i++) {
      const a = i / VISION_RAYS * Math.PI * 2, dx = Math.cos(a), dy = Math.sin(a);
      let r = R;
      for (let t = .5; t <= R; t += .5) {
        const x = Math.round(u.x + dx * t), y = Math.round(u.y + dy * t);
        if (!S.inside(x, y) || t > S.losCap(ox, oy, x, y)) { r = t; break; }
      }
      pts.push({ x: u.x + dx * r, y: u.y + dy * r });
    }
    visionCache = { key, pts };
    return pts;
  }

  // ── 地形：一次烘成"一张画"，之后每帧只贴一张图 ──────────────────────
  // 65（上司："不行 还是都是方块，我希望地图更自然一些"）——把"格"从画面上拆掉。
  //   64 及以前是"逐格填底色 + 每格一个图元"：格是 28px 的硬边界，一格一个色块、一格一棵树、
  //   一格一道脊线，抖得再狠也还是一盘贴砖。这次三条一起换掉：
  //   ① 底图**逐像素**成像（世界 1/2 分辨率，再双线性放大 2 倍）：每像素先用噪声把采样坐标
  //      推歪 8~9 像素（域扭曲）再去查地形 —— 林地/山/洼地的边界成了歪的曲线，直角台阶没了；
  //      配色叠三层噪声（大斑块 / 中起伏 / 细颗粒）+ **高程梯度打光**，地面不再是一块死绿。
  //   ② 树/石/水纹按**世界坐标散点**画（9px 起，位置全由哈希给），密度取自**模糊后的掩膜**：
  //      林缘是一圈渐稀的树而不是一刀切；冠幅 6~13px 随机、两三个圆叠出来 —— 读成"林冠"。
  //   ③ 山不再画"北亮脊 + 南暗脚"的逐格描边：梯度光影已经把山形立起来了，散点只补岩粒。
  //
  // 判定层一个数没动：地形还是那些格，寻路 / 视野 / 迷雾照旧按格算，被改的只有"长什么样"。
  // 烘图仍然只做一次（换图才重建，63 起就是这么定的）；成像失败（node 桩 / 内存不够）
  //   退回逐格平涂 —— 没有有机感，但功能和判定一模一样。
  const TYPES = Object.keys(S.colors);
  const TYPE_IX = {};
  TYPES.forEach((t, i) => { TYPE_IX[t] = i; });
  const tix = n => (TYPE_IX[n] === undefined ? 0 : TYPE_IX[n]);
  const T_PLAIN = tix('plain'), T_ROAD = tix('road'), T_FOREST = tix('forest'),
        T_HILL = tix('hill'), T_MARSH = tix('marsh'), T_RIVER = tix('river'), T_BRIDGE = tix('bridge');
  const TYPE_RGB = TYPES.map(name => {
    const n = parseInt(S.colors[name].slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  });
  // 整数哈希：散点位置用它。原来那套 Math.sin 哈希在成像里要跑几百万次，慢一个数量级。
  function h2(i, j) {
    let n = (Math.imul(i, 374761393) + Math.imul(j, 668265263)) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177) | 0;
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  }

  // ── 场：地形编号 + 高程 + 林地/山地密度（逐格算一次，之后逐像素双线性取样）──
  // 为什么要有"场"：逐格数据是硬的（0 或 1），画面要的是连续的（0.0~1.0）。
  //   模糊两遍之后，林缘/山脚就有了"渐稀"的过渡 —— 树按密度撒才不会一刀切。
  const clampI = (v, n) => (v < 0 ? 0 : v >= n ? n - 1 : v);
  function blurBox(a, C, R, passes) {
    const tmp = new Float32Array(a.length);
    for (let p = 0; p < passes; p++) {
      for (let y = 0; y < R; y++) for (let x = 0; x < C; x++) {
        const i = y * C + x;
        tmp[i] = (a[y * C + (x > 0 ? x - 1 : 0)] + a[i] + a[y * C + (x < C - 1 ? x + 1 : C - 1)]) / 3;
      }
      for (let y = 0; y < R; y++) for (let x = 0; x < C; x++) {
        const i = y * C + x;
        a[i] = (tmp[(y > 0 ? y - 1 : 0) * C + x] + tmp[i] + tmp[(y < R - 1 ? y + 1 : R - 1) * C + x]) / 3;
      }
    }
  }
  let fieldCache = null, fieldKey = '';
  function fields() {
    const key = `${S.COLS}x${S.ROWS}#${S.SEED || ''}`;
    if (fieldCache && fieldKey === key) return fieldCache;
    const C = S.COLS, R = S.ROWS, N = C * R;
    const id = new Uint8Array(N), gid = new Uint8Array(N);
    const elev = new Float32Array(N), tree = new Float32Array(N), rock = new Float32Array(N);
    for (let y = 0; y < R; y++) for (let x = 0; x < C; x++) {
      // 98：森林住 cover 层。底图编号取"地表"，高程/岩石只按 base，树密度只按 cover，
      //   这样坡上林＝山体打光 + 岩石 + 树，而不是把高地整格涂成深绿（Q12/Q22）。
      const bt = S.tileBase ? S.tileBase(x, y) : S.terrain[y][x];
      const wood = S.isForest ? S.isForest(x, y) : (S.terrain[y][x] === 'forest');
      const bk = tix(bt), k = wood ? T_FOREST : bk, i = y * C + x;
      id[i] = k;
      // gid ＝ 只给底图用的"地面类型"：路/桥/河并进平地。
      //   它们不按格染色，而是由 paintRoads / paintBridge / paintRiver 当带子画在底图之上；
      //   底图若还按格涂一层路色，带子两侧就会漏出方形残影。
      gid[i] = (k === T_ROAD || k === T_RIVER || k === T_BRIDGE) ? T_PLAIN : k;
      // 高程只用来打光：高地抬起来、洼地和水压下去。**不参与任何判定**（判定用 S.HEIGHT）
      elev[i] = bk === T_HILL ? 1 : bk === T_MARSH ? -.5 : (bk === T_RIVER ? -.8 : 0);
      tree[i] = wood ? 1 : 0;
      rock[i] = bk === T_HILL ? 1 : 0;
    }
    blurBox(elev, C, R, 2); blurBox(tree, C, R, 2); blurBox(rock, C, R, 2);
    fieldCache = { id, gid, elev, tree, rock, C, R };
    fieldKey = key;
    return fieldCache;
  }
  // 世界像素 → 场（按格中心做双线性）。格心在 (x+.5)·TILE，所以先减半格再取整数部分。
  function fieldAt(arr, C, R, wx, wy) {
    const T = S.TILE;
    const fx = wx / T - .5, fy = wy / T - .5;
    let x0 = Math.floor(fx), y0 = Math.floor(fy);
    const sx = fx - x0, sy = fy - y0;
    const x1 = clampI(x0 + 1, C), y1 = clampI(y0 + 1, R);
    x0 = clampI(x0, C); y0 = clampI(y0, R);
    const a = arr[y0 * C + x0], b = arr[y0 * C + x1], c = arr[y1 * C + x0], d = arr[y1 * C + x1];
    return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
  }
  function typeAtWorld(F, wx, wy) {
    const T = S.TILE;
    return F.id[clampI(wy / T | 0, F.R) * F.C + clampI(wx / T | 0, F.C)];
  }

  // ── 底图：逐像素成像 ───────────────────────────────────────────────
  // BASE_DIV = 2：算 1792×1344 个像素（世界的一半），再双线性放大 2 倍。
  //   为什么不在世界分辨率上算：4 倍像素、4 倍时间，而底图本来就该是"柔和的"，放大那步
  //   正好把像素级锯齿化开；真正的锐度交给上面那层散点细节。
  const BASE_DIV = 2;
  function paintBase(g) {
    const C = S.COLS, R = S.ROWS, TT = S.TILE;
    const W = Math.ceil(C * TT / BASE_DIV), H = Math.ceil(R * TT / BASE_DIV);
    let cv = null, cg = null, img = null;
    try {
      cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      cg = cv.getContext('2d');
      img = (cg && cg.createImageData) ? cg.createImageData(W, H) : null;
    } catch (_) { img = null; }
    if (!img || !img.data) return false;              // node 桩 / 内存不够 → 交给逐格平涂
    const F = fields(), d = img.data, gid = F.gid;
    for (let j = 0; j < H; j++) {
      const wy = (j + .5) * BASE_DIV;
      let o = j * W * 4;
      for (let i = 0; i < W; i++, o += 4) {
        const wx = (i + .5) * BASE_DIV;
        // ① 域扭曲：两组低频噪声各管一个方向，把采样点推歪 ±11 像素（两倍频叠加，最大 ±23）。
        //   位移量必须**跟格宽同量级**，不然 28px 的直角台阶只是被"晃"了一下，还是台阶。
        //   路和河不走这条路——它们由 paintRoads / paintRiver 当"带子"画，见下。
        const sx = wx + (vnoise(wx + 31, wy + 17, 72) - .5) * 44 + (vnoise(wx + 9, wy + 47, 27) - .5) * 20;
        const sy = wy + (vnoise(wx + 73, wy + 59, 66) - .5) * 44 + (vnoise(wx + 55, wy + 11, 25) - .5) * 20;
        const tx = clampI(sx / TT | 0, C), ty = clampI(sy / TT | 0, R);
        const k = gid[ty * C + tx];                    // gid：路/桥/河已经并进 plain
        const rgb = TYPE_RGB[k] || TYPE_RGB[0];
        let r = rgb[0], gg = rgb[1], bb = rgb[2];
        // ② 三层色阶：大斑块（150px）定调、中起伏（46px）破均、细颗粒（8px）当土质
        let lum = (vnoise(wx + 5, wy + 91, 150) - .5) * 12
                + (vnoise(wx + 41, wy + 7, 44) - .5) * 14
                + (vnoise(wx + 3, wy + 63, 9) - .5) * 8;
        // ③ 高程光影：西北受光、东南背光。山形自己浮出来，不用再去描一圈台阶边。
        lum += (fieldAt(F.elev, C, R, sx - 14, sy - 14) - fieldAt(F.elev, C, R, sx + 14, sy + 14)) * 52;
        // ④ 材质微差：洼地更闷、林地更暗（都在 lum 上做，不另调色板）
        if (k === T_MARSH) lum += (vnoise(wx + 29, wy + 43, 13) - .5) * 8 - 2;
        else if (k === T_FOREST) lum -= 3;
        else if (k === T_HILL) {
          // 山体内部必须有自己的起伏：只靠上面那层"整块山"的梯度，一大片山就是一块平灰板。
          //   拿两层噪声当假高程，再沿西北→东南求差打光 —— 坡、沟、脊就出来了。
          const a1 = vnoise(wx - 7, wy - 7, 17), a2 = vnoise(wx - 7, wy - 7, 7);
          const b1 = vnoise(wx + 7, wy + 7, 17), b2 = vnoise(wx + 7, wy + 7, 7);
          lum += ((a1 * .6 + a2 * .4) - (b1 * .6 + b2 * .4)) * 54
               + (vnoise(wx + 7, wy + 23, 9) - .5) * 12;
        }
        // ⑤ 交界过渡：离格线 9px 以内才掺邻格颜色（最多掺 55%）。
        //   没有这一步，地形交界在像素级是一条硬边，放大后看着像贴纸剪出来的。
        const fx = sx - tx * TT, fy = sy - ty * TT;
        const BW = 9;
        let w = 0, nk = k;
        if (fx < BW) { nk = gid[ty * C + clampI(tx - 1, C)]; w = (BW - fx) / BW; }
        else if (fx > TT - BW) { nk = gid[ty * C + clampI(tx + 1, C)]; w = (fx - TT + BW) / BW; }
        if (fy < BW) { const w2 = (BW - fy) / BW; if (w2 > w) { nk = gid[clampI(ty - 1, R) * C + tx]; w = w2; } }
        else if (fy > TT - BW) { const w2 = (fy - TT + BW) / BW; if (w2 > w) { nk = gid[clampI(ty + 1, R) * C + tx]; w = w2; } }
        if (nk !== k) {
          const c2 = TYPE_RGB[nk], a = w * .55;
          r = r * (1 - a) + (c2[0] + lum) * a;
          gg = gg * (1 - a) + (c2[1] + lum) * a;
          bb = bb * (1 - a) + (c2[2] + lum) * a;
        } else { r += lum; gg += lum; bb += lum; }
        // 大尺度"干/湿"色相：一大片偏黄（干草）、一大片偏青（阴湿）。
        //   只调明暗永远是同一块绿布；真实地面是**色相**在变，这是让它不像贴图的关键一层。
        const dry = vnoise(wx + 101, wy + 13, 95) - .5;
        r += dry * 17; gg += dry * 5; bb -= dry * 13;
        // 亮处偏暖、暗处偏冷：只加同一个数会显得发灰
        r += lum * .07; bb -= lum * .07;
        d[o] = r < 0 ? 0 : r > 255 ? 255 : r;
        d[o + 1] = gg < 0 ? 0 : gg > 255 ? 255 : gg;
        d[o + 2] = bb < 0 ? 0 : bb > 255 ? 255 : bb;
        d[o + 3] = 255;
      }
    }
    cg.putImageData(img, 0, 0);
    g.imageSmoothingEnabled = true;
    g.drawImage(cv, 0, 0, C * TT, R * TT);
    g.imageSmoothingEnabled = false;
    return true;
  }

  // ── 河：从格数据反推一条**中心线**，当带子画 ─────────────────────────
  // 为什么不逐像素查格：河只有 1~3 格宽，域扭曲一推就断成几截。
  //   河本身是"一条流"，世界生成时就是逐行摆动的中心线，这里把它读回来再平滑一遍，
  //   画出来是一条连续曲线——28px 的台阶自然消失。
  // 试过另一条路（把水做成模糊掩膜再掺色）：半径小了不起作用，半径大了 1 格宽的河会被抹淡，
  //   实测台阶还在、水还变虚了。窄的东西必须走矢量，宽的东西才适合走场。
  let riverCache = null, riverKey = '';
  function riverProfile() {
    const key = `${S.COLS}x${S.ROWS}#${S.SEED || ''}`;
    if (riverCache && riverKey === key) return riverCache;
    const F = fields(), C = F.C, R = F.R, TT = S.TILE;
    const rows = new Array(R).fill(null);
    for (let y = 0; y < R; y++) {
      let lo = -1, hi = -1;
      for (let x = 0; x < C; x++) {
        const k = F.id[y * C + x];
        // **桥格不算水**：桥比河宽（跨河＋两岸各一列），把它算进去，桥所在那两行就成了
        //   "河宽 = 河＋两格"，画出来是一个气球鼓包（65 实机截图里一眼就看见）。
        //   整行没有水格＝那一行交给下面的线性补，河从桥底下照常流过。
        if (k === T_RIVER) { if (lo < 0) lo = x; hi = x; }
      }
      if (lo >= 0) rows[y] = { c: (lo + hi + 1) / 2 * TT, w: (hi - lo + 1) * TT };
    }
    let first = -1, last = -1;
    for (let y = 0; y < R; y++) if (rows[y]) { if (first < 0) first = y; last = y; }
    if (first >= 0) {
      for (let y = first; y <= last; y++) if (!rows[y]) {          // 缺行 → 线性补，否则河会断
        let a = y - 1; while (a > first && !rows[a]) a--;
        let b = y + 1; while (b < last && !rows[b]) b++;
        const ra = rows[a], rb = rows[b];
        rows[y] = (ra && rb) ? { c: ra.c + (rb.c - ra.c) * ((y - a) / (b - a)), w: ra.w + (rb.w - ra.w) * ((y - a) / (b - a)) } : (ra || rb);
      }
      const raw = rows.map(r => r && r.c);
      for (let y = first; y <= last; y++) {                        // 5 点滑平均：河是流出来的
        let s = 0, n = 0;
        for (let dd = -2; dd <= 2; dd++) { const v = raw[y + dd]; if (v != null) { s += v; n++; } }
        if (n && rows[y]) rows[y].c = s / n;
      }
    }
    riverCache = { rows, first, last }; riverKey = key;
    return riverCache;
  }
  function onWater(wx, wy) {
    const rp = riverProfile(), TT = S.TILE;
    const y = Math.floor(wy / TT);
    if (y < rp.first || y > rp.last) return false;
    const r = rp.rows[y];
    return !!r && Math.abs(wx - r.c) < r.w * .46;
  }
  function paintRiver(g) {
    const rp = riverProfile(), TT = S.TILE;
    if (rp.first < 0) return;
    g.lineCap = 'round';
    // 三遍：岸（暗、宽）→ 水（本色）→ 水面薄光。岸这一遍是关键——水陆之间要有一段过渡，
    //   一刀切才是"方块感"的来源。
    for (const [k, col] of [[1.20, '#3f5f6a'], [1.04, '#4a7d8f'], [0.74, '#538894']]) {
      g.strokeStyle = col;
      for (let y = rp.first; y < rp.last; y++) {
        const a = rp.rows[y], b = rp.rows[y + 1];
        if (!a || !b) continue;
        g.lineWidth = Math.min(a.w, b.w) * k;
        g.beginPath(); g.moveTo(a.c, (y + .5) * TT); g.lineTo(b.c, (y + 1.5) * TT); g.stroke();
      }
    }
    g.lineCap = 'butt';
  }

  // ── 路：把路格连成折线 → 去抖 → 圆角描边 ─────────────────────────
  // 逐格填色时，路是一条 28px 的直角折线，每个拐弯都是一个方块角；岔口是一个方形补丁。
  // 改矢量后有个坑要记：路格本身是"走一格挪一下"的，直接 Chaikin 会把每格的小折圆成
  //   **正弦波**（实测整条路像蛇）。所以顺序必须是 先去抖（三角窗滑平均）→ 再抽稀 → 最后圆角。
  let roadCache = null, roadKey = '';
  function smoothPath(pts, radius) {
    if (pts.length < 3) return pts;
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      let sx = 0, sy = 0, sw = 0;
      for (let d = -radius; d <= radius; d++) {
        const j = i + d;
        if (j < 0 || j >= pts.length) continue;
        const w = radius + 1 - Math.abs(d);
        sx += pts[j][0] * w; sy += pts[j][1] * w; sw += w;
      }
      out.push([sx / sw, sy / sw]);
    }
    // 两端必须**钉回原位**：滑平均会把端点往内拽，路和桥头/岔口之间就裂开一道缝（实机见到过）
    out[0] = [pts[0][0], pts[0][1]];
    out[out.length - 1] = [pts[pts.length - 1][0], pts[pts.length - 1][1]];
    return out;
  }
  function simplify(pts, tol) {
    if (pts.length < 3) return pts;
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const sg = stack.pop(), i = sg[0], j = sg[1];
      if (j - i < 2) continue;
      const ax = pts[i][0], ay = pts[i][1], bx = pts[j][0], by = pts[j][1];
      const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1;
      let best = -1, bi = -1;
      for (let k = i + 1; k < j; k++) {
        const d = Math.abs((pts[k][0] - ax) * dy - (pts[k][1] - ay) * dx) / L;
        if (d > best) { best = d; bi = k; }
      }
      if (best > tol) { keep[bi] = 1; stack.push([i, bi], [bi, j]); }
    }
    return pts.filter((_, i) => keep[i]);
  }
  function chaikin(p, iters) {
    let a = p;
    for (let k = 0; k < iters && a.length > 2; k++) {
      const q = [a[0]];
      for (let i = 0; i < a.length - 1; i++) {
        const u = a[i], v = a[i + 1];
        q.push([u[0] * .75 + v[0] * .25, u[1] * .75 + v[1] * .25]);
        q.push([u[0] * .25 + v[0] * .75, u[1] * .25 + v[1] * .75]);
      }
      q.push(a[a.length - 1]);
      a = q;
    }
    return a;
  }
  function roadPaths() {
    const key = `${S.COLS}x${S.ROWS}#${S.SEED || ''}`;
    if (roadCache && roadKey === key) return roadCache;
    const F = fields(), C = F.C, R = F.R;
    const isR = (x, y) => (x < 0 || y < 0 || x >= C || y >= R) ? false : F.id[y * C + x] === T_ROAD;
    const seen = new Uint8Array(C * R);
    const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const deg = (x, y) => { let n = 0; for (const [dx, dy] of DIRS) if (isR(x + dx, y + dy)) n++; return n; };
    const paths = [];
    const starts = [];
    for (let y = 0; y < R; y++) for (let x = 0; x < C; x++) if (isR(x, y) && deg(x, y) !== 2) starts.push([x, y]);
    for (let y = 0; y < R; y++) for (let x = 0; x < C; x++) if (isR(x, y) && deg(x, y) === 2) starts.push([x, y]);
    for (const [sx0, sy0] of starts) {
      if (seen[sy0 * C + sx0]) continue;
      let cx = sx0, cy = sy0;
      const pts = [[cx, cy]];
      seen[cy * C + cx] = 1;
      for (;;) {
        const prev = pts.length > 1 ? pts[pts.length - 2] : null;
        let nx = -1, ny = -1;
        if (prev) {                                     // 先试直行，再试转弯：直路不被岔口截成锯齿
          const dx = cx - prev[0], dy = cy - prev[1];
          if (isR(cx + dx, cy + dy) && !seen[(cy + dy) * C + cx + dx]) { nx = cx + dx; ny = cy + dy; }
        }
        if (nx < 0) for (const [dx, dy] of DIRS) {
          if (isR(cx + dx, cy + dy) && !seen[(cy + dy) * C + cx + dx]) { nx = cx + dx; ny = cy + dy; break; }
        }
        if (nx < 0) break;
        cx = nx; cy = ny; seen[cy * C + cx] = 1; pts.push([cx, cy]);
      }
      if (pts.length > 1) paths.push(pts);
    }
    // 世界像素 + 三步处理；短于 2 段的残段（数据里的单格毛刺）直接丢
    const out = [];
    for (const seg of paths) {
      if (seg.length < 2) continue;
      const px = seg.map(([x, y]) => [(x + .5) * S.TILE, (y + .5) * S.TILE]);
      out.push(chaikin(simplify(smoothPath(px, 3), S.TILE * .3), 2));
    }
    roadCache = out; roadKey = key;
    return out;
  }
  function paintRoads(g) {
    const paths = roadPaths(), TT = S.TILE;
    // 不用 stroke 描边：描边出来是一条**充气管**，两端还是圆的，一看就是画的符号。
    // 改成沿路径每 6px 铺一个抖过位置/大小的小圆 —— 圆与圆叠起来是一条连续的土路，
    //   边缘是毛的（像被踩出来的），不是一条切线。
    const ROAD_TONES = ['#b29b73', '#ab946c', '#b7a179'];
    const stamp = (p, rMul, color, seedOff) => {
      g.fillStyle = color;
      let idx = seedOff;
      for (let i = 0; i < p.length - 1; i++) {
        const a = p[i], b = p[i + 1];
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const n = Math.max(1, Math.ceil(L / 6));
        for (let k = 0; k < n; k++, idx++) {
          const t = k / n;
          const x = a[0] + (b[0] - a[0]) * t + (h2(idx * 977 + 13, idx * 31 + 7) - .5) * 2.6;
          const y = a[1] + (b[1] - a[1]) * t + (h2(idx * 61 + 7, idx * 97 + 3) - .5) * 2.6;
          const r = TT * (.29 + h2(idx * 17 + 3, idx * 23 + 11) * .10) * rMul;
          g.beginPath(); g.arc(x, y, r, 0, 6.2832); g.fill();
        }
      }
    };
    for (const p of paths) stamp(p, 1.16, 'rgba(128,106,72,.55)', 0);   // 路肩（磨损带）
    let q = 0;
    for (const p of paths) { stamp(p, 1.0, ROAD_TONES[q++ % 3], 1); }    // 路面
    for (const p of paths) stamp(p, .74, 'rgba(198,178,140,.35)', 2);    // 中间被踩实的那一道
    // 车辙：两道很淡的断续线，跟法线偏 ±0.15 格。虚线密一点、透明一点，别读成车道线
    g.strokeStyle = 'rgba(110,90,60,.22)'; g.lineWidth = 1.3; g.setLineDash([5, 7]);
    for (const p of paths) {
      const nr = p.map((v, i) => {
        const a = p[Math.max(0, i - 1)], b = p[Math.min(p.length - 1, i + 1)];
        const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
        return [-dy / L, dx / L];
      });
      for (const sg of [-1, 1]) {
        g.beginPath();
        for (let i = 0; i < p.length; i++) {
          const x = p[i][0] + nr[i][0] * TT * .15 * sg, y = p[i][1] + nr[i][1] * TT * .15 * sg;
          i ? g.lineTo(x, y) : g.moveTo(x, y);
        }
        g.stroke();
      }
    }
    g.setLineDash([]);
  }

  // ── 桥：人做的桥面，就该是清楚的木板 —— 不做模糊 ─────────────────────
  // 65 重写。原来"每个桥格铺一块 28px 板色方块"，拼出来是一座 2 格粗的**褐色方盒**，
  //   横在一条 1 格宽的河上、两端各伸出去一格草地——地形换成有机底图之后，全画面最"方"的就是它。
  //   判定没动（桥格照旧可走）；改的只是画法：把桥格连通成一座，只在**水上**铺一条 ~24px 厚的
  //   木板道，上下边线每 6px 抖一点（不是直尺画的长方形），板缝锚世界坐标跨格连续，
  //   两端各垫一块石座收口。**"桥比河宽"这条数据没改**（写地图的规矩就是跨河＋两岸各一列），
  //   只是画出来不再是一整块板砖。
  function paintBridges(g) {
    const F = fields(), C = F.C, R = F.R, TT = S.TILE, rp = riverProfile();
    const seen = new Uint8Array(C * R);
    const jit = (k) => (h2(k, 7) - .5) * 3;                 // 边线抖动 ±1.5px
    for (let y0 = 0; y0 < R; y0++) for (let x0 = 0; x0 < C; x0++) {
      const i0 = y0 * C + x0;
      if (F.id[i0] !== T_BRIDGE || seen[i0]) continue;
      // 一座桥＝一个四连通块，顺手取包围盒
      const stk = [i0]; seen[i0] = 1;
      let xa = x0, xb = x0, ya = y0, yb = y0;
      while (stk.length) {
        const i = stk.pop(), cx = i % C, cy = (i - cx) / C;
        if (cx < xa) xa = cx; if (cx > xb) xb = cx;
        if (cy < ya) ya = cy; if (cy > yb) yb = cy;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= C || ny >= R) continue;
          const j = ny * C + nx;
          if (F.id[j] === T_BRIDGE && !seen[j]) { seen[j] = 1; stk.push(j); }
        }
      }
      const horiz = (xb - xa) >= (yb - ya);      // 桥面沿东西（本项目河是纵向的，这是常态）
      const cwx = (xa + xb + 1) / 2 * TT, cwy = (ya + yb + 1) / 2 * TT;
      if (!horiz) {                               // 竖向桥：worldgen 不会生成，留着兜底（照旧整格铺）
        for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) {
          g.fillStyle = '#8d744c'; g.fillRect(x * TT, y * TT, TT, TT);
        }
        continue;
      }
      const th = Math.min(24, (yb - ya + 1) * TT - 6);        // 桥面厚度：不跟格数线性涨
      const half = th / 2;
      const r = rp.rows[Math.max(0, Math.min(R - 1, Math.round(cwy / TT - .5)))];
      const L = r ? r.c - r.w / 2 - 6 : xa * TT + 2;         // 只在有水的那一段，两端各多 6px
      const Rt = r ? r.c + r.w / 2 + 6 : (xb + 1) * TT - 2;
      // 板面：每 6px 一带，上下边各自抖一点 → 边缘是木头的，不是直尺的
      for (let q = Math.floor(L); q < Rt; q += 6) {
        const w = Math.min(6, Rt - q);
        const t1 = jit(q * 13 + 1), t2 = jit(q * 29 + 5);
        g.fillStyle = '#8d744c';
        g.fillRect(q, cwy - half + t1, w, th + (t2 - t1));
        g.fillStyle = 'rgba(96,76,50,.55)';                   // 桥沿：板道才有厚度
        g.fillRect(q, cwy - half + t1, w, 2);
        g.fillRect(q, cwy + half + t2 - 2, w, 2);
        g.fillStyle = 'rgba(190,168,124,.22)';                // 顶面高光，往上一档
        g.fillRect(q, cwy - half + t1 + 4, w, 2);
      }
      g.fillStyle = 'rgba(110,88,58,.7)';                     // 板缝 8px 一档，锚世界坐标
      for (let q = Math.ceil(L / 8) * 8; q < Rt; q += 8) g.fillRect(q, cwy - half + 3, 1, th - 6);
      g.fillStyle = '#7c6a52';                                // 石座：两端收口，桥不悬空
      g.fillRect(L - 7, cwy - half - 3, 7, th + 6);
      g.fillRect(Rt, cwy - half - 3, 7, th + 6);
    }
  }

  // ── 细节层：散点（树 / 石 / 水纹 / 草叶 / 坑洼）────────────────────
  // 全部画在**世界坐标**上，落点由哈希给：不跟格对齐，才不会又是一盘点阵。
  // 密度不是常数——取自模糊过的掩膜，所以林缘/山脚自然变稀。
  const CANOPY = [['#2c4628', '#3b5d32', '#4f7b40'], ['#274024', '#35562d', '#48713b'], ['#314b28', '#416034', '#558544']];
  function paintDetails(g) {
    const C = S.COLS, R = S.ROWS, TT = S.TILE, F = fields();
    paintRiver(g); paintRoads(g); paintBridges(g);

    // 草叶：34px 一方格，只在平地上长。没有它，大片草地是一张均匀的绿纸。
    {
      const P = 34, cc = Math.ceil(C * TT / P), rr = Math.ceil(R * TT / P);
      for (let gy = 0; gy < rr; gy++) for (let gx = 0; gx < cc; gx++) {
        const cx = (gx + h2(gx * 3 + 5, gy * 9 + 7)) * P, cy = (gy + h2(gx * 11 + 1, gy * 5 + 3)) * P;
        if (typeAtWorld(F, cx, cy) !== T_PLAIN) continue;
        const r1 = h2(gx * 17 + 3, gy * 13 + 11);
        if (r1 > .42) continue;
        const len = 3 + h2(gx * 7 + 2, gy * 19 + 4) * 4;
        g.fillStyle = r1 < .22 ? 'rgba(52,78,40,.26)' : 'rgba(104,124,68,.24)';
        if (h2(gx * 29 + 5, gy * 7 + 1) > .5) g.fillRect(cx, cy, 1.3, len);
        else g.fillRect(cx, cy, len, 1.3);
      }
    }
    // 树：10px 一方格撒一棵，位置抖到格内任意处；3 层错开的圆叠成树冠。
    // **必须批成 9 条路径一次 fill**（3 配色 × 3 层）：四万个圆逐个 arc+fill 要 1.5 秒，
    //   实测烘图 1.8s 里绝大部分是它；批完之后只剩几十毫秒。
    const PITCH = 10, cols = Math.ceil(C * TT / PITCH), rows = Math.ceil(R * TT / PITCH);
    const batched = (typeof Path2D === 'function');
    const PATH = [];
    if (batched) for (let c2 = 0; c2 < 3; c2++) PATH.push([new Path2D(), new Path2D(), new Path2D()]);
    const put = (pi, layer, x, y, r) => {
      if (!batched) { g.fillStyle = CANOPY[pi][layer === 2 ? 2 : layer === 1 ? 1 : 0]; g.beginPath(); g.arc(x, y, r, 0, 6.2832); g.fill(); return; }
      const pp = PATH[pi][layer];
      pp.moveTo(x + r, y); pp.arc(x, y, r, 0, 6.2832);
    };
    for (let gy = 0; gy < rows; gy++) for (let gx = 0; gx < cols; gx++) {
      const cx = (gx + h2(gx * 3 + 11, gy * 7 + 5)) * PITCH;
      const cy = (gy + h2(gx * 13 + 3, gy * 5 + 9)) * PITCH;
      const dns = fieldAt(F.tree, C, R, cx, cy);
      if (dns < .14) continue;
      // 密度场是**模糊过**的，林缘会漫到路/桥/水面上 —— 落到真实格上一查，不是林地就不种
      const kk = typeAtWorld(F, cx, cy);
      if (kk === T_ROAD || kk === T_BRIDGE || kk === T_RIVER) continue;
      const pick = h2(gx * 29 + 7, gy * 17 + 1);
      if (pick > dns * 1.08) continue;                 // 越靠林缘越稀：边缘是一圈散树
      // 冠幅 5~11px：必须**大于**散点间距的一半，相邻树冠才会互相压住连成林冠。
      //   前一版 4~9 且每棵带一圈淡影 —— 影把每棵描成一个绿气泡，整片林子读成"一串葡萄"。
      const rad = 5.5 + h2(gx * 5 + 2, gy * 11 + 6) * 5.5;
      const pi = pick < .34 ? 0 : pick < .67 ? 1 : 2;
      const nx = h2(gx * 23 + 13, gy * 31 + 5), ny = h2(gx * 19 + 7, gy * 23 + 9);
      put(pi, 0, cx - rad * .14, cy - rad * .10, rad);
      put(pi, 0, cx + (nx - .5) * rad * .9, cy + (ny - .5) * rad * .85, rad * .72);
      put(pi, 1, cx - rad * .30, cy - rad * .30, rad * .62);
      put(pi, 2, cx - rad * .40, cy - rad * .40, rad * .22);
    }
    if (batched) for (let pi = 0; pi < 3; pi++) for (let l = 0; l < 3; l++) {
      g.fillStyle = CANOPY[pi][l];
      g.fill(PATH[pi][l]);
    }
    // 岩粒：15px 一方格、成簇，只在山上
    const RP = 15, rcols = Math.ceil(C * TT / RP), rrows = Math.ceil(R * TT / RP);
    for (let gy = 0; gy < rrows; gy++) for (let gx = 0; gx < rcols; gx++) {
      const cx = (gx + h2(gx * 7 + 3, gy * 11 + 8)) * RP;
      const cy = (gy + h2(gx * 17 + 5, gy * 3 + 2)) * RP;
      const dns = fieldAt(F.rock, C, R, cx, cy);
      if (dns < .4) continue;
      if (h2(gx * 23 + 9, gy * 13 + 4) > dns * .72) continue;
      const w = 2.6 + h2(gx * 3 + 7, gy * 19 + 1) * 3.0;
      const n = 2 + (h2(gx * 13 + 3, gy * 5 + 9) > .55 ? 1 : 0);
      for (let i = 0; i < n; i++) {
        const ox = (h2(gx * 31 + i * 7, gy * 11 + i * 5) - .5) * 7;
        const oy = (h2(gx * 17 + i * 11, gy * 23 + i * 3) - .5) * 6;
        const s2 = w * (.7 + h2(gx * 5 + i, gy * 29 + i) * .5);
        g.fillStyle = 'rgba(30,28,24,.28)'; g.fillRect(cx + ox - s2 / 2 + 1.2, cy + oy - s2 / 2 + 1.6, s2, s2 * .72);
        g.fillStyle = '#7b7567'; g.fillRect(cx + ox - s2 / 2, cy + oy - s2 / 2, s2, s2 * .7);
        g.fillStyle = '#8d8779'; g.fillRect(cx + ox - s2 / 2, cy + oy - s2 / 2, s2 * .55, s2 * .28);
      }
    }
    // 水纹：14px 散点，掩膜够"湿"的地方才画
    {
      const P = 14, cc = Math.ceil(C * TT / P), rr = Math.ceil(R * TT / P);
      for (let gy = 0; gy < rr; gy++) for (let gx = 0; gx < cc; gx++) {
        const wx = (gx + h2(gx * 5 + 1, gy * 9 + 3)) * P;
        const wy = (gy + h2(gx * 11 + 7, gy * 7 + 5)) * P;
        if (!onWater(wx, wy)) continue;
        const len = 5 + h2(gx * 13 + 2, gy * 3 + 9) * 9;
        g.fillStyle = 'rgba(168,208,216,.20)';
        g.fillRect(wx, wy, len, 1.3);
        if (h2(gx * 7 + 4, gy * 17 + 2) > .5) {
          g.fillStyle = 'rgba(24,48,56,.16)';
          g.fillRect(wx + 2, wy + 3.4, len * .66, 1.2);
        }
      }
    }
    // 洼地积水：暗斑 + 一点反光，跟着洼地掩膜
    {
      const P = 17, cc = Math.ceil(C * TT / P), rr = Math.ceil(R * TT / P);
      for (let gy = 0; gy < rr; gy++) for (let gx = 0; gx < cc; gx++) {
        const cx = (gx + h2(gx * 3 + 9, gy * 7 + 2)) * P;
        const cy = (gy + h2(gx * 13 + 5, gy * 11 + 6)) * P;
        if (typeAtWorld(F, cx, cy) !== T_MARSH) continue;
        const w = 6 + h2(gx * 5 + 3, gy * 15 + 7) * 10, hh = 3 + h2(gx * 11 + 1, gy * 9 + 5) * 4;
        g.fillStyle = 'rgba(46,66,58,.55)';
        g.beginPath(); g.ellipse(cx, cy, w / 2, hh / 2, 0, 0, 6.2832); g.fill();
        g.fillStyle = 'rgba(140,168,152,.24)';
        g.fillRect(cx - w * .22, cy - hh * .18, w * .34, 1.2);
      }
    }
  }

  // 兜底：逐格平涂。没有有机感，但渲染路径与判定路径都不缺（node 桩 / 成像失败时走这里）
  function paintTerrainFlat(g, tx0, ty0, tx1, ty1) {
    for (let y = ty0; y <= ty1; y++) for (let x = tx0; x <= tx1; x++) {
      const t = S.tileOf ? S.tileOf({x,y}) : S.terrain[y][x], r = tileRect(x, y);
      g.fillStyle = tintAt(x, y, t); g.fillRect(r.x, r.y, r.w, r.h);
      if (t === 'forest') {
        g.fillStyle = 'rgba(30,48,30,.55)';
        g.fillRect(x * S.TILE + 8, y * S.TILE + 8, 12, 12);
      }
    }
  }

  let terrainCache = null, terrainCacheKey = '', terrainCacheTried = false, terrainBuilds = 0, terrainStatsMs = 0;
  function terrainCanvas() {
    const W = worldW(), H = worldH();
    const key = `${S.COLS}x${S.ROWS}@${S.TILE}#${S.SEED || ''}`;
    if (terrainCache && terrainCacheKey === key) return terrainCache;
    if (terrainCacheTried && terrainCacheKey === key) return null;   // 试过且失败，别每帧重试
    terrainCacheTried = true; terrainCacheKey = key;
    // 单张画布上限：Chrome 约 268M 像素，这里留足余量，超了就不烘（退回逐格画）
    if (W * H > 80000000) return null;
    let c = null, g = null;
    try { c = document.createElement('canvas'); c.width = W; c.height = H; g = c.getContext('2d'); } catch (_) { return null; }
    if (!g) return null;
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
    try {
      g.imageSmoothingEnabled = false;
      const tm0 = performance.now();
      const ok = paintBase(g);
      const tm1 = performance.now();
      if (ok) paintDetails(g); else paintTerrainFlat(g, 0, 0, S.COLS - 1, S.ROWS - 1);
      if (typeof window !== 'undefined') window.__tm = { base: Math.round(tm1 - tm0), detail: Math.round(performance.now() - tm1) };
    } catch (_) { terrainCache = null; return null; }
    terrainCache = c; terrainBuilds++;
    terrainStatsMs = Math.round((typeof performance !== 'undefined' && performance.now) ? (performance.now() - t0) : 0);
    return c;
  }
  // 把烘好的地形按"相机看到的那一块"贴到画布上：源矩形与目标矩形都按屏幕像素对齐，
  //   采样相位恒定（配合 clampCam 的整像素对齐），平移时不会有噪点抖动。
  function blitTerrain(tc){
    const vr = camRect(), z = cam.zoom;
    const sx = Math.max(0, Math.floor(vr.x)), sy = Math.max(0, Math.floor(vr.y));
    const sw = Math.min(tc.width - sx, Math.ceil(vr.x + vr.w) - sx + 1);
    const sh = Math.min(tc.height - sy, Math.ceil(vr.y + vr.h) - sy + 1);
    if (sw <= 0 || sh <= 0) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tc, sx, sy, sw, sh, (sx - vr.x) * z, (sy - vr.y) * z, sw * z, sh * z);
    ctx.imageSmoothingEnabled = true;
    ctx.restore();
  }

  // ── 迷雾软边（64）────────────────────────────────────────────────
  // 迷雾的**判定**是逐格的（视野半径、山影、树影全按格算），所以"亮/薄暗/重暗"的边界天生是方格台阶。
  //   台阶在画面上比格线更扎眼：一整片 30 屏幕像素的方块明暗，读起来就是马赛克。
  // 做法：把迷雾画成"每格 FOG_SS 个纹素"的小图（384×288），再**开着双线性**放大到世界尺寸——
  //   一格之内是渐变、格与格之间没有硬边。判定一个数都没动，被抹开的只有画面。
  //   贴图对齐：整张小图铺满 0..COLS×T，第 i 格占据的纹素正好覆盖 i·T..(i+1)·T，
  //   渐变落在格边界上，不会"迷雾比地形偏半格"。
  //   **65 修的 bug**：64 的源矩形写成了 S.COLS×S.ROWS（而小图是 COLS·SS 宽），
  //   等于只取了左上 1/4 张图铺满全图 —— 迷雾整片放大 2 倍、位置全错（实测亮度与
  //   迷雾状态错开 4~5 格）。这里改成按画布真实尺寸取源。
  // 代价：一张 128×96 的 ImageData，只在 S.fogVersion 变了的时候重建（迷雾本身 6~7 次/秒才重算）。
  // node 桩里没有 createImageData → 返回 null，draw() 退回原来逐格 fillRect 的路径。
  // 98（Q10）：四档 → 两档，**没有黑雾**。清晰档 alpha=0；薄雾档只压一层极淡的冷色，
  //   地形轮廓必须始终可读（LoL 能看见草丛、看不见里面的人）。
  //   敌情不靠这层遮罩——敌军画不画由 canSee/enemyFogState 决定，营地归属在薄雾下改中性色。
  const FOG_LEVELS = [[10, 14, 12, 34]];   // 薄雾（唯一一档）
  // SS = 每格几个纹素。双线性的过渡宽度恒等于**一个纹素**：
  //   1 → 过渡有一整格（30px）宽，河、桥这种细结构会被抹成一片渐变，画面对不上焦；
  //   2 → 过渡半格（14px），台阶的直角没了、细节还在；
  //   65 改 3 → 过渡三分之一格（9px）。地形换成有机底图之后，14px 的方块明暗反而成了
  //   全画面最"方"的东西，收窄到 9px 才不抢眼。
  const FOG_SS = 3;
  let fogCanvas = null, fogCtx = null, fogStamp = '', fogBuilds = 0;
  function fogLayer() {
    const stamp = `${S.COLS}x${S.ROWS}#${S.fogVersion}`;
    if (fogCanvas && fogStamp === stamp) return fogCanvas;
    const W = S.COLS * FOG_SS, H = S.ROWS * FOG_SS;
    try {
      if (!fogCanvas) {
        fogCanvas = document.createElement('canvas');
        fogCanvas.width = W; fogCanvas.height = H;
        fogCtx = fogCanvas.getContext('2d');
        if (!fogCtx) { fogCanvas = null; return null; }
      }
      const fog = S.getFog();
      const img = fogCtx.createImageData(W, H);
      if (!img || !img.data) { fogCanvas = null; return null; }
      const d = img.data;
      for (let y = 0; y < S.ROWS; y++) for (let x = 0; x < S.COLS; x++) {
        const k = x + ',' + y;
        const clear = (fog.clear && fog.clear.has(k)) || fog.bright.has(k);
        // 窗外＝清晰地形、不铺薄雾（Q11）；窗内没被看见的格才落薄雾。
        const c = clear ? null : fog.thin.has(k) ? FOG_LEVELS[0] : null;
        if (!c) continue;                        // 明亮格：alpha 保持 0
        for (let sy = 0; sy < FOG_SS; sy++) for (let sx = 0; sx < FOG_SS; sx++) {
          const i = ((y * FOG_SS + sy) * W + (x * FOG_SS + sx)) * 4;
          d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = c[3];
        }
      }
      fogCtx.putImageData(img, 0, 0);
      fogStamp = stamp; fogBuilds++;
      return fogCanvas;
    } catch (_) { fogCanvas = null; return null; }   // 兜底：任何一步失败都退回逐格画
  }

  function draw(){
    followCommander();     // 62：画面就是主将的视野，每帧先把他摆在中间（验收模式除外）
    clampCam();
    ctx.setTransform(1,0,0,1,0,0);
    ctx.clearRect(0,0,canvas.width,canvas.height);
    // 世界坐标 → 画布坐标：画布 = (世界 - cam) × zoom。之后所有绘制照旧用世界像素。
    ctx.setTransform(cam.zoom,0,0,cam.zoom,-cam.x*cam.zoom,-cam.y*cam.zoom);
    // 视野内的格范围：迷雾、悬停、视口换算都用它（地形不再按格画，见下）
    const vr=camRect();
    const tx0=Math.max(0,Math.floor(vr.x/S.TILE)), tx1=Math.min(S.COLS-1,Math.ceil((vr.x+vr.w)/S.TILE));
    const ty0=Math.max(0,Math.floor(vr.y/S.TILE)), ty1=Math.min(S.ROWS-1,Math.ceil((vr.y+vr.h)/S.TILE));
    // 63：地形只在换图时变，烘一次就能一直贴（见 paintBase / paintDetails / terrainCanvas）。
    //   tx0..ty1 只在"烘不出来、退回逐格平涂"时用得到——所以这条兜底路径必须一直留着。
    const tc = terrainCanvas();
    if (tc) blitTerrain(tc); else paintTerrainFlat(ctx, tx0, ty0, tx1, ty1);
    // "别过河"约束的可见反馈：受限制的部队存在时，禁区（东岸）盖一层淡红
    if(S.units.some(u=>u.hp>0&&u.avoid)){
      const Z=S.AVOID_RIVER_EAST;
      ctx.fillStyle='rgba(217,83,79,.12)';
      ctx.fillRect(Z.x1*S.TILE,Z.y1*S.TILE,(Z.x2-Z.x1+1)*S.TILE,(Z.y2-Z.y1+1)*S.TILE);
      ctx.strokeStyle='#d9534f';ctx.setLineDash([6,4]);
      ctx.beginPath();ctx.moveTo(Z.x1*S.TILE,0);ctx.lineTo(Z.x1*S.TILE,worldH());ctx.stroke();ctx.setLineDash([]);
    }
    // 战争迷雾渲染（d11 数据）：明亮无遮罩 / 薄雾轻暗 / 已探索重暗 / 未探索近黑
    {
      const fl = fogLayer();
      if (fl) {
        // 双线性放大：一格的过渡把台阶抹成渐变。imageSmoothingEnabled 属于画布状态，
        //   save/restore 会把它带回来（这里必须在 restore 之后才是逐格路径那种硬边）。
        ctx.save();
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(fl, 0, 0, fl.width, fl.height, 0, 0, S.COLS * S.TILE, S.ROWS * S.TILE);
        ctx.restore();
      } else {
        // 兜底（node 桩 / 建不出小图时）：原来的逐格路径，硬边但功能不缺。
        //   同级格攒成一条路径一次 fill()——逐格 fillRect 一旦相邻重叠，重叠处 alpha 会叠两次、边界更暗。
        // 98（Q10）：兜底路径同样只有一档薄雾，没有"已探索压暗 / 未探索近黑"。
        const fog = S.getFog(), P = .5, T = S.TILE;
        const bucket = [];
        for (let y = ty0; y <= ty1; y++) for (let x = tx0; x <= tx1; x++) {
          const k = x + ',' + y;
          if ((fog.clear && fog.clear.has(k)) || fog.bright.has(k)) continue;
          if (fog.thin.has(k)) bucket.push(x, y);
        }
        if (bucket.length) {
          ctx.beginPath();
          for (let i = 0; i < bucket.length; i += 2) ctx.rect(bucket[i] * T - P, bucket[i + 1] * T - P, T + 2 * P, T + 2 * P);
          ctx.fillStyle = 'rgba(10,14,12,.13)'; ctx.fill();
        }
      }
    }
    const fogState=S.enemyFogState();   // 提前算：悬停高亮要判断"这一格上是不是敌军"
    // 悬停格高亮：格线拿掉之后，玩家得靠这个知道自己指在哪一格（否则点哪打哪全靠猜）。
    // 颜色就是"点下去会发生什么"：金框＝过去，红框＝打它。不需要先切模式才敢点。
    if(hoverTile&&!S.result&&S.inside(hoverTile.x,hoverTile.y)){
      const hx=hoverTile.x*S.TILE,hy=hoverTile.y*S.TILE;
      const overFoe=[...fogState].some(([,st])=>st.mode!=='ghost'&&Math.floor(st.x)===hoverTile.x&&Math.floor(st.y)===hoverTile.y);
      ctx.strokeStyle=overFoe?'rgba(226,114,106,.85)':'rgba(240,220,131,.5)';ctx.lineWidth=1.5;
      ctx.strokeRect(hx+.75,hy+.75,S.TILE-1.5,S.TILE-1.5);ctx.lineWidth=1;
    }
    // ── 三处目标点（㊺／54）：营地＝宿营地，本营＝士气命门，主将以金/红框在单位里 ──
    // 营地 **54 起是分散五处**，逐个画。名字只在"已归某方"或"正在争夺"时写出来：
    //   五处全写名字，在最小缩放（0.8，一屏五分之一个图）下就是一层噪点，反而看不出哪里在打。
    for(const site of (S.sites||[])){
      const sx=site.x1*S.TILE,sy=site.y1*S.TILE;
      const sw=(site.x2-site.x1+1)*S.TILE,sh=(site.y2-site.y1+1)*S.TILE;
      const held=site.holder;
      ctx.fillStyle=held==='blue'?'rgba(71,138,194,.2)':held==='red'?'rgba(186,89,75,.2)':'rgba(232,217,154,.16)';
      ctx.fillRect(sx,sy,sw,sh);
      ctx.strokeStyle=held==='blue'?'#8fc0e4':held==='red'?'#d99a8c':'#e8d99a';
      ctx.lineWidth=2;ctx.setLineDash([5,4]);ctx.strokeRect(sx+1,sy+1,sw-2,sh-2);ctx.setLineDash([]);ctx.lineWidth=1;
      if(held||site.progress>0.02){
        ctx.fillStyle='#f0e5bd';ctx.font=`${10/cam.zoom}px sans-serif`;
        // 显式左对齐：画布上别处（问号/终局大字）会把 textAlign 改成 center，
        //   靠"后面那行会改回来"是运气，不是约定。营地靠边时标签会被裁掉前半截（实测只剩 "91%"）。
        ctx.textAlign='left';
        ctx.fillText(held?`${site.name} · 营内恢复`:`${site.name} · 争夺 ${Math.round(site.progress*100)}%`,
          Math.max(2,sx-1),Math.max(11,sy-3));
      }
      // 进度条：只用"争夺中"的力度，归谁的颜色。满了（=1）就是整条，读作"这处已经归他"。
      if(site.progress>0&&!S.result){
        ctx.fillStyle='#2a3128';ctx.fillRect(sx+3,sy+sh-7,sw-6,4);
        ctx.fillStyle=held==='blue'?'#8fc0e4':held==='red'?'#d99a8c':'#e8d99a';
        ctx.fillRect(sx+3,sy+sh-7,(sw-6)*Math.min(1,site.progress),4);
      }
    }
    // 本营：3×3，颜色跟着**此刻的归属**走（丢了就换色，不用读文字）。
    for(const base of S.bases){
      const bx=base.x1*S.TILE,by=base.y1*S.TILE;
      const bw=(base.x2-base.x1+1)*S.TILE,bh=(base.y2-base.y1+1)*S.TILE;
      const mine=base.owner==='blue', lost=base.owner!==base.side;
      const col=mine?'#7fb2dc':'#d68d7c';
      ctx.fillStyle=mine?'rgba(71,138,194,.13)':'rgba(186,89,75,.13)';
      ctx.fillRect(bx,by,bw,bh);
      ctx.strokeStyle=col;ctx.lineWidth=1.6;ctx.setLineDash([7,5]);
      ctx.strokeRect(bx+1,by+1,bw-2,bh-2);ctx.setLineDash([]);ctx.lineWidth=1;
      // 营旗：杆 + 三角旗，位置在营中心。比起"再画一个彩色框"，一面旗才叫"这是谁的家"。
      const fx=bx+bw/2,fy=by+bh/2;
      ctx.fillStyle=col;
      ctx.fillRect(fx-0.7,fy-9,1.4,13);
      ctx.beginPath();ctx.moveTo(fx+0.7,fy-9);ctx.lineTo(fx+9,fy-6);ctx.lineTo(fx+0.7,fy-3);ctx.closePath();ctx.fill();
      ctx.font=`${10/cam.zoom}px sans-serif`;
      ctx.fillStyle=lost?'#ffd0c2':col;
      ctx.fillText(lost?`${base.name}（失守）`:base.name,Math.max(2,bx-1),Math.max(11,by-4));
      if(base.progress>0&&!S.result){
        ctx.fillStyle='#2a3128';ctx.fillRect(bx+3,by+bh-6,bw-6,3.5);
        ctx.fillStyle=col;ctx.fillRect(bx+3,by+bh-6,(bw-6)*Math.min(1,base.progress),3.5);
      }
    }
    // 视野环：画在迷雾之上、单位之下。它不是射程，是"看清到哪"——
    //   缺口就是山影/树影，和"点上去能不能打"用的是同一条判定。
    if(selected&&selected.hp>0&&!S.result&&!S.isStale(selected)){
      const pts=visionPolygon(selected),T=S.TILE;
      ctx.beginPath();
      for(let i=0;i<pts.length;i++){const p=pts[i];i?ctx.lineTo(p.x*T,p.y*T):ctx.moveTo(p.x*T,p.y*T);}
      ctx.closePath();
      ctx.strokeStyle='rgba(246,228,150,.72)';ctx.lineWidth=Math.max(.9,1.4/cam.zoom);
      ctx.setLineDash([4,4]);ctx.stroke();ctx.setLineDash([]);ctx.lineWidth=1;
    }
    // 路径线只在"真知道它往哪走"时画；薄雾区的旧情报不画路线，免得把 2 秒前的计划当成现在
    if(selected&&selected.path.length&&!S.isStale(selected)){ctx.beginPath();ctx.strokeStyle='#f3e88a';ctx.lineWidth=2;ctx.setLineDash([4,3]);ctx.moveTo((selected.x+.5)*S.TILE,(selected.y+.5)*S.TILE);for(const p of selected.path)ctx.lineTo((p.x+.5)*S.TILE,(p.y+.5)*S.TILE);ctx.stroke();ctx.setLineDash([]);ctx.lineWidth=1;}
    for(const u of S.allUnits){if(u.hp<=0)continue;
      if(u.team!=='blue'){
        const st=fogState.get(u.id);
        if(!st||st.mode!=='live'){continue;}   // 非实时的敌军在下面单独画（滞后/残影）
      }
      // 友军在薄雾区：位置/状态全部取 reported()，也就是 FOG.lag 秒前那一份。
      // 这里绝不能用 u.x/u.hp——那等于把延迟机制在画面上作废。
      const v=u.team==='blue'?S.reported(u):null;
      const stale=!!v&&v.stale>0;
      const d=stale?v:u;
      // 位置取 SIM 的成像坐标（66）：20Hz 逻辑步 + 帧间插值，画面不会一格一格跳。
      //   滞后情报（stale）不插值——那份是 FOG.lag 秒前的快照，插值等于替它编造中间位置。
      let drawX=d.x,drawY=d.y;
      if(!stale){const p=S.renderPos(u);drawX=p.x;drawY=p.y;}
      // 锚点＝格**中心**的世界像素（⑸9 起）：阵型会跨出本格，按格左上角锚定会整体偏向左上
      const ax=(drawX+.5)*S.TILE,ay=(drawY+.5)*S.TILE;
      // 溃退单位整体减淡，一眼就能看出哪支已经不受控；滞后单位也减淡
      ctx.globalAlpha=(d.isRouted?.5:1)*(stale?.75:1);
      drawCluster(u,ax,ay,d);
      // 状态三条全部让到簇**外面**（实机截图后改的）：原来生命/士气条压在兵身上，
      //   主将框又占满中央，整簇糊成一团色块，多单位白做。
      // ⑸9 起一律按**编队包围盒**定位：方阵 0.65 格宽、线阵 1.4 格宽，写死 20px 就会条子飘在兵外面。
      const bb=TROOP.troopBounds(u,ax,ay,d);
      const bw=Math.max(15,bb.x1-bb.x0), bx=(bb.x0+bb.x1)/2-bw/2, by=bb.y0-6.6;
      const bh=Math.max(16,bb.y1-bb.y0);
      ctx.fillStyle='#211d1b';ctx.fillRect(bx-.5,by,bw+.9,2.6);
      ctx.fillStyle=u.team==='blue'?'#9ac77e':'#d77861';ctx.fillRect(bx,by+.5,bw*(d.hp/d.maxHp),1.6);
      ctx.fillStyle='#191d19';ctx.fillRect(bx-.5,by+2.8,bw+.9,2.6);
      ctx.fillStyle=d.morale>=70?'#e3c96a':d.morale>=40?'#d59a55':'#cf6152';ctx.fillRect(bx,by+3.3,bw*(d.morale/100),1.6);
      // 右侧竖条：精力。戒备中转金色——一眼看出谁在烧精力、谁已经累了
      //   ⑸9：队形高的时候（线阵两排、纵阵五排）竖条不能跟着涨到 60px——那会读成一条杂线，
      //   所以钉死 18 像素高、贴包围盒顶端，长度只表示精力比例。
      const sh=Math.min(18,bh);
      ctx.fillStyle='#191d19';ctx.fillRect(bb.x1+1.4,bb.y0+.6,1.5,sh);
      ctx.fillStyle=d.stance==='GUARDED'?'#e3c96a':d.stamina<S.STAMINA.TIRED?'#cf6152':'#7fae7a';
      const staminaH=sh*(d.stamina/S.STAMINA.MAX);ctx.fillRect(bb.x1+1.4,bb.y0+.6+sh-staminaH,1.5,staminaH);
      ctx.globalAlpha=1;
      // 认知角标：灰点＝未预期，黄点＝有预期（戒备中但没看见人），红杠＝已目视；白框闪烁＝措手不及
      if(d.reactTimer<=0){
        if(d.alert==='ALERT'){
          ctx.fillStyle='#e2726a';ctx.fillRect(bx+bw+1.6,by+.2,2,4.8);
        } else {
          ctx.fillStyle=d.alert==='SUSPECT'?'#e0c25f':'#7d8a80';
          ctx.fillRect(bx+bw+1.6,by+1.4,2.4,2.4);
        }
      }
      if(d.reactTimer>0&&Math.floor(performance.now()/130)%2===0){ctx.strokeStyle='#fff2b8';ctx.lineWidth=2;ctx.strokeRect(bb.x0-1.5,bb.y0-1.5,bb.x1-bb.x0+3,bb.y1-bb.y0+3);ctx.lineWidth=1;}
      if(d.isRouted){ctx.strokeStyle='#e7d98f';ctx.setLineDash([3,2]);ctx.strokeRect(bb.x0-.5,bb.y0-.5,bb.x1-bb.x0+1,bb.y1-bb.y0+1);ctx.setLineDash([]);}
      else if(d.morale<=35){ctx.strokeStyle='#d9534f';ctx.strokeRect(bb.x0-1.5,bb.y0-1.5,bb.x1-bb.x0+3,bb.y1-bb.y0+3);}
      // 情报滞后：虚框 + 上方小沙漏，和"实时"一眼能分开
      if(stale){
        ctx.strokeStyle='#9fb2c8';ctx.setLineDash([2,2]);ctx.strokeRect(bb.x0-1.2,bb.y0-1.2,bb.x1-bb.x0+2.4,bb.y1-bb.y0+2.4);ctx.setLineDash([]);
        ctx.fillStyle='#9fb2c8';ctx.font=`${7/cam.zoom}px sans-serif`;ctx.fillText('⧗',bb.x1-8,bb.y0-9);
      }
      if(u===S.commander&&u.hp>0){
        // 将旗：小旗杆 + 旗面，画在簇右上（认知角标在左上，两者不撞）
        ctx.fillStyle='#f2d97a';ctx.fillRect(bb.x1+1.4,by-6.4,1.4,4.5);
        ctx.fillStyle='#e8b93f';ctx.fillRect(bb.x1+2.4,by-6.4,4,3.2);
      }
      // 选中框画四个角标而不是整框：整框会把一簇兵重新框成"一个方块"，
      //   和"多单位"的设定打架。角标只标范围，不封口。
      if(selection.includes(u)){
        // 角标压在编队外一点点，不压兵：压在兵上会让人以为那几个兵才是入选的
        const x0=bb.x0-2.5,y0=bb.y0-2.5,x1=bb.x1+2.5,y1=bb.y1+2.5,k=5;
        ctx.strokeStyle='#f0dc83';ctx.lineWidth=2;ctx.beginPath();
        ctx.moveTo(x0,y0+k);ctx.lineTo(x0,y0);ctx.lineTo(x0+k,y0);
        ctx.moveTo(x1-k,y0);ctx.lineTo(x1,y0);ctx.lineTo(x1,y0+k);
        ctx.moveTo(x0,y1-k);ctx.lineTo(x0,y1);ctx.lineTo(x0+k,y1);
        ctx.moveTo(x1-k,y1);ctx.lineTo(x1,y1);ctx.lineTo(x1,y1-k);
        ctx.stroke();ctx.lineWidth=1;
        // 正面小三角：阵型一摊开，"哪边是正面"就得靠它，否则线阵看不出朝谁。
        //   ⑸9：贴着包围盒边缘画、尖端只出 2.2 像素——做大了会盖过士兵，还会戳到选中角标外面。
        //   67：队形朝向也归 troop.js 的动画状态（`u.head` 已退役）。
        const hd=TROOP.headOf(u);
        const fx=ax+hd.x*((bb.x1-bb.x0)/2+1), fy=ay+hd.y*((bb.y1-bb.y0)/2+1);
        ctx.fillStyle='#f0dc83';ctx.beginPath();
        ctx.moveTo(fx+hd.x*2.2,fy+hd.y*2.2);
        ctx.lineTo(fx-hd.y*1.4-hd.x*.6,fy+hd.x*1.4-hd.y*.6);
        ctx.lineTo(fx+hd.y*1.4-hd.x*.6,fy-hd.x*1.4-hd.y*.6);
        ctx.closePath();ctx.fill();
      }
      if(!stale&&u.order==='DEFEND'&&u.hold){ctx.strokeStyle='#8fbf6a';ctx.strokeRect(u.hold.x*S.TILE+3,u.hold.y*S.TILE+3,14,14);}
    }
    // 薄雾区里的敌军（只有友军看见）：位置与状态是滞后的，画成半透明 + 沙漏
    {
      for(const [id,st] of fogState){
        if(st.mode!=='lagged')continue;
        const ax=(st.x+.5)*S.TILE,ay=(st.y+.5)*S.TILE,e=S.enemies.find(x=>x.id===id);
        ctx.globalAlpha=.72;
        // 敌军同样是"一簇单位"：统一表现，否则只有我方像军队、敌方还是棋子
        // 67：队形名不再随情报滞后（快照里没有它了）——兵位动画一直是实时的，
        //   只有模板名曾滞后 2 秒，两者本来就不一致；现在读的是它当下的样子。
        const view={hp:st.hp!=null?st.hp:1,maxHp:st.maxHp||1,leader:null};
        drawCluster(e,ax,ay,view);
        const bb=TROOP.troopBounds(e,ax,ay,view), bw=Math.max(15,bb.x1-bb.x0), bx=(bb.x0+bb.x1)/2-bw/2;
        if(st.maxHp){ctx.fillStyle='#211d1b';ctx.fillRect(bx-.5,bb.y0-6.6,bw+.9,2.6);ctx.fillStyle='#d77861';ctx.fillRect(bx,bb.y0-6.1,bw*(st.hp/st.maxHp),1.6);}
        ctx.globalAlpha=1;
        ctx.strokeStyle='#9fb2c8';ctx.setLineDash([2,2]);ctx.strokeRect(bb.x0-1.2,bb.y0-1.2,bb.x1-bb.x0+2.4,bb.y1-bb.y0+2.4);ctx.setLineDash([]);
        ctx.fillStyle='#9fb2c8';ctx.font=`${7/cam.zoom}px sans-serif`;ctx.fillText('⧗',bb.x1-8,bb.y0-9);
      }
    }
    // 敌军残影（薄雾区）：灰色半透明方块 + ?，位置=最后目击点
    {
      const fogState=S.enemyFogState();
      for(const [id,st] of fogState){
        if(st.mode!=='ghost')continue;
        const px=st.x*S.TILE,py=st.y*S.TILE;
        const e=S.enemies.find(x=>x.id===id);
        ctx.globalAlpha=Math.max(.25,1-st.age/S.FOG.ghostTTL);
        ctx.fillStyle='#8a8f8a';ctx.fillRect(px+4,py+4,12,12);
        ctx.fillStyle='#f1edcf';ctx.fillRect(px+7,py+7,6,6);
        ctx.globalAlpha=1;
        ctx.fillStyle='#c7caba';ctx.font=`${9/cam.zoom}px sans-serif`;ctx.fillText('?',px+15,py+8);
      }
    }
    // 选中部队的最后目击点：有预期时画个问号，玩家能看出情报指向哪里，也知道那是旧位置
    if(selected&&selected.hp>0&&selected.alert==='SUSPECT'&&selected.contact){
      const cx=selected.contact.x*S.TILE+S.TILE/2,cy=selected.contact.y*S.TILE+S.TILE/2;
      ctx.strokeStyle='#e0c25f';ctx.setLineDash([2,3]);
      ctx.beginPath();ctx.arc(cx,cy,S.TILE*.85,0,Math.PI*2);ctx.stroke();ctx.setLineDash([]);
      ctx.fillStyle='#e0c25f';ctx.font=`600 ${10/cam.zoom}px "Microsoft YaHei UI",sans-serif`;ctx.textAlign='center';
      ctx.fillText('?',cx,cy+3.5);ctx.textAlign='left';
    }
    // 覆盖层回到屏幕坐标画：胜负横幅、小地图都跟相机无关，缩放里画会跑偏
    ctx.setTransform(1,0,0,1,0,0);
    if(S.result){
      ctx.fillStyle='rgba(15,20,18,.72)';ctx.fillRect(0,canvas.height/2-40,canvas.width,80);
      ctx.fillStyle=S.result==='WIN'?'#b6dd8c':'#e19a86';ctx.font='600 22px "Microsoft YaHei UI",sans-serif';ctx.textAlign='center';
      ctx.fillText(`${S.resultWhy||''} · ${S.result==='WIN'?'我方胜利':'战斗失败'}`,canvas.width/2,canvas.height/2+8);ctx.textAlign='left';
    }
    drawMinimap();
  }

  // ── 小地图：整图缩略 + 视口框 + 点蓝点看部队 ──────────────────────
  const mini=document.getElementById('minimap');
  const mctx=mini&&mini.getContext?mini.getContext('2d'):null;
  // 63：小地图的**地形也只烘一次**。原来每帧 64×48=3072 个块、每块一到两次 fillRect，
  //   是这一帧里开销最大的一块（实测比主地图还多），而地形在换图前根本不变。
  //   烘完每帧只剩：贴图 1 次 + 迷雾 3 次路径填充 + 十来个点位。
  let miniCache=null, miniCacheKey='';
  function miniTerrain(){
    const W=mini.width||240,H=mini.height||180;
    const key=`${S.COLS}x${S.ROWS}#${S.SEED||''}@${W}x${H}`;
    if(miniCache&&miniCacheKey===key)return miniCache;
    let c=null,g=null;
    try{c=document.createElement('canvas');c.width=W;c.height=H;g=c.getContext('2d');}catch(_){}
    if(!g)return null;
    // 65：直接缩贴主地图那张烘好的地形。原来按 2 格一块平涂，一格 1.9 像素——
    //   小地图本来就是判断"哪边是林子、河往哪弯"的地方，画成一盘马赛克等于白画。
    //   顺手还快：一次 drawImage 换掉 3072 次 fillRect。
    const tc=terrainCanvas();
    if(tc){
      g.imageSmoothingEnabled=true;
      g.drawImage(tc,0,0,W,H);
      miniCache=c;miniCacheKey=key;
      return c;
    }
    // 兜底（node 桩 / 烘图失败）：逐块平涂
    const cw=W/S.COLS,ch=H/S.ROWS,STEP=2;
    for(let y=0;y<S.ROWS;y+=STEP)for(let x=0;x<S.COLS;x+=STEP){
      const bx=Math.floor(x*cw),by=Math.floor(y*ch),bw=Math.ceil(cw*STEP),bh=Math.ceil(ch*STEP);
      g.fillStyle=S.colors[S.tileOf({x,y})];
      g.fillRect(bx,by,bw,bh);
    }
    miniCache=c;miniCacheKey=key;
    return c;
  }
  function drawMinimap(){
    if(!mctx)return;
    const W=mini.width||160,H=mini.height||120;
    const cw=W/S.COLS, ch=H/S.ROWS;
    mctx.setTransform(1,0,0,1,0,0);
    mctx.clearRect(0,0,W,H);
    // 98（Q10/Q11）：小地图也守两档，**不要全黑的迷雾**（上司特别补的那条）。
    //   它画的是全图军图，地形轮廓始终可见；只有敌情信息受视野约束。
    const fog=S.getFog(), STEP=2;
    const mc=miniTerrain();
    if(mc)mctx.drawImage(mc,0,0);
    // 薄雾攒成一条路径一次填（和主视图同一手法）：逐块换 fillStyle 是这里最贵的部分。
    {
      const bucket=[];
      for(let y=0;y<S.ROWS;y+=STEP)for(let x=0;x<S.COLS;x+=STEP){
        const k=x+','+y;
        if((fog.clear&&fog.clear.has(k))||fog.bright.has(k))continue;
        if(fog.thin.has(k))bucket.push(x,y);
      }
      if(bucket.length){
        mctx.beginPath();
        for(let i=0;i<bucket.length;i+=2){
          const bx=Math.floor(bucket[i]*cw),by=Math.floor(bucket[i+1]*ch);
          mctx.rect(bx,by,Math.ceil(cw*STEP),Math.ceil(ch*STEP));
        }
        mctx.fillStyle='rgba(10,14,12,.13)';mctx.fill();
      }
    }
    // 三处目标点在小地图上也要能看见：营地（按控制方染色）+ 双方本营（按归属染色）
    // 98：**已知泄漏已修** —— 旧写法按 `sys.holder` 真值染色、完全不过迷雾，等于开图。
    //   现在只有"清晰"格才报归属，其余一律中性色（Q10 薄雾只压敌情，营地归属是敌情）。
    for(const sys of (S.sites||[])){
      const ck=(sys.x!=null?sys.x:Math.round((sys.x1+sys.x2)/2))+','+
               (sys.y!=null?sys.y:Math.round((sys.y1+sys.y2)/2));
      const known=(fog.clear&&fog.clear.has(ck))||fog.bright.has(ck);
      mctx.fillStyle=!known?'#e8d99a':sys.holder==='blue'?'#8fc0e4':sys.holder==='red'?'#d99a8c':'#e8d99a';
      mctx.fillRect(sys.x1*cw,sys.y1*ch,(sys.x2-sys.x1+1)*cw,(sys.y2-sys.y1+1)*ch);
    }
    for(const b of S.bases){
      mctx.fillStyle=b.owner==='blue'?'#7fb2dc':'#d68d7c';
      mctx.fillRect(b.x1*cw,b.y1*ch,(b.x2-b.x1+1)*cw,(b.y2-b.y1+1)*ch);
    }
    const fs=S.enemyFogState();
    for(const u of S.allUnits){
      if(u.hp<=0)continue;
      if(u.team!=='blue'){const st=fs.get(u.id);if(!st)continue;mctx.globalAlpha=st.mode==='live'?1:.6;mctx.fillStyle=u.color;
        mctx.fillRect(st.x*cw-2,st.y*ch-2,4,4);mctx.globalAlpha=1;continue;}
      // 友军也走 reported()：小地图是"我知道的战场"，不是上帝视角
      const v=S.reported(u);
      mctx.globalAlpha=v.stale>0?.55:1;
      mctx.fillStyle=u.color;
      mctx.fillRect(v.x*cw-2,v.y*ch-2,4,4);
      if(u===S.commander){mctx.strokeStyle='#f2d97a';mctx.lineWidth=1;mctx.strokeRect(v.x*cw-3,v.y*ch-3,7,7);}
      mctx.globalAlpha=1;
    }
    const r=camRect();
    mctx.strokeStyle='#f0dc83';mctx.lineWidth=1.5;
    mctx.strokeRect(r.x/worldW()*W,r.y/worldH()*H,r.w/worldW()*W,r.h/worldH()*H);
    mctx.lineWidth=1;
  }
  if(mini&&mini.addEventListener){
    // 点击跳转 + **按住拖动**（㊼）：主视图缩不到全图之后，小地图成了唯一的全局入口，
    //   只许"点一下跳一次"太笨——按住它，视野框就该像滑块一样跟着走。
    //   位置换算与小地图绘制同一条：格 → 世界像素 → centerOn，不另算一套比例。
    // 62：镜头锁在主将身上，小地图不再是"跳转"入口——它变成**唯一的全貌**。
    //   点它上面的蓝点＝把详情面板切到那支部队（画面不动：主将看不到的地方，画面也不该去）。
    //   这就是"看得见"与"看全貌"分家的地方：全貌归小地图，细节归主视图。
    const pickAt=e=>{
      const rect=mini.getBoundingClientRect();
      const fx=(e.clientX-rect.left)/(rect.width||mini.width||1);
      const fy=(e.clientY-rect.top)/(rect.height||mini.height||1);
      const tx=fx*S.COLS, ty=fy*S.ROWS;
      let best=null,bd=Infinity;
      for(const u of S.units){
        if(u.hp<=0)continue;
        const v=S.reported(u);
        const d=Math.hypot(v.x-tx,v.y-ty);
        if(d<bd){bd=d;best=u;}
      }
      if(!best||bd>5)return;
      const ok=selectUnit(best,false);
      const vt=viewTiles();
      const far=best.x<vt.x0||best.x>vt.x1||best.y<vt.y0||best.y>vt.y1;
      show(ok
        ? `已选中主将${best.name}：点地图上的空地就过去，点敌军就打它。`
        : (far?`${best.name}不在主将视野里，面板上只有它最近一次回报的情况。要调它请点名下令，比如「${best.name}去北桥」。`
              : `${best.name}只能看，不能拖——它不归鼠标直接指挥。要调它请下令，比如「${best.name}去北桥」。`));
      draw();
    };
    mini.addEventListener('click',pickAt);
  }

  // ── 鼠标：只有"点"，没有"拖/滚"（62 起相机不可平移、不可缩放）──────────
  // 为什么不给平移：画面＝主将视野。能拖能缩，"短令只对画面内部队有效"就会随玩家
  //   把画面拖到哪而变化——那等于没有规则。要看别处，靠小地图看全貌＋点名下令。
  if(canvas.addEventListener){
    canvas.addEventListener('mousemove',e=>{
      const p=canvasPoint(e);
      // 悬停格：格线隐藏后这是"指在哪一格"的唯一依据。只在换格时重绘，别每个像素都全画一遍
      const t=screenToTile(p.sx,p.sy);
      const changed=!hoverTile||hoverTile.x!==t.x||hoverTile.y!==t.y;
      hoverTile=t;
      if(changed)draw();
    });
    canvas.addEventListener('mouseleave',()=>{ if(hoverTile){ hoverTile=null; draw(); } });
    // 滚轮什么都不做，但必须**拦住**默认行为：不拦就会把整页滚走，玩家以为地图动了
    canvas.addEventListener('wheel',e=>{ if(e.preventDefault)e.preventDefault(); },{passive:false});
  }
  if(document.addEventListener){
    document.addEventListener('keydown',e=>{
      const tag=(e.target&&e.target.tagName)||'';
      if(/^(INPUT|TEXTAREA|SELECT)$/.test(tag))return;   // 正在打字就别抢按键
      const key=String(e.key||'');
      // 62 起只剩一个相机键：R ＝ 把画面拽回主将（验收模式下 R 也一样回到主将）。
      //   方向键平移整条去掉了——画面就是主将的视野，没有"把眼睛移开"这回事。
      if(key==='r'||key==='R'){ camFollow=true; zoomOverride=0; resetCamera(); draw(); return; }
      // 81：G ＝ 整队（主将收编周围友军兵力）。跟 R 一样是**即时操作**，不进命令日志、不播报。
      if(key==='g'||key==='G'){ doAbsorb(); return; }
    });
  }

  // 屏内像素 → 世界像素（点选用；格坐标已经不够用了，见 pickBlueAt）
  function screenToWorld(sx, sy){ return { x: sx / cam.zoom + cam.x, y: sy / cam.zoom + cam.y }; }
  // 点选（⑸9）：阵型会跨出本格，按"格的坐标相等"判就点不着散到格外的兵。
  //   规则：落点在某支的编队包围盒里（含 2px 余量）→ 选它；否则取 0.9 格内最近的一支。
  //   仍然按**你看到的位置**判（薄雾区的兵画的是滞后位置），看到什么点什么。
  function pickBlueAt(wx, wy){
    let best = null, bestD = Infinity;
    for (const u of S.units) {
      if (u.hp <= 0 || u.team !== 'blue') continue;
      const v = S.reported(u);
      const ax = (v.x + .5) * S.TILE, ay = (v.y + .5) * S.TILE;
      // 98（Q29）：点选按 **footprint 包围盒**，不是按兵位动画包围盒。
      //   两者差别在"减员/半血"时最要命：troopBounds 只框住还在画的那几个兵，
      //   而这一队实际占的地仍是整块 footprint —— 玩家点它散出去的那半边会点空。
      const bb = TROOP.footprintBounds ? TROOP.footprintBounds(u, ax, ay, v) : TROOP.troopBounds(u, ax, ay, v);
      const inBox = wx >= bb.x0 - 2 && wx <= bb.x1 + 2 && wy >= bb.y0 - 2 && wy <= bb.y1 + 2;
      const d = Math.hypot(wx - ax, wy - ay);
      if ((inBox || d <= S.TILE * .9) && d < bestD) { best = u; bestD = d; }
    }
    return best;
  }
  function pickEnemyAt(wx, wy, fogNow){
    let best = null, bestD = Infinity;
    for (const [id, st] of fogNow) {
      if (st.mode === 'ghost') continue;
      const e = S.enemies.find(x => x.id === id && x.hp > 0);
      if (!e) continue;
      const ax = (st.x + .5) * S.TILE, ay = (st.y + .5) * S.TILE;
      // 98（Q29）：同上，敌队点选也按 footprint（薄雾里画的是滞后位置，包围盒跟着滞后锚点走）。
      const bb = TROOP.footprintBounds ? TROOP.footprintBounds(e, ax, ay, { hp: st.hp, maxHp: st.maxHp, leader: null })
        : TROOP.troopBounds(e, ax, ay, { hp: st.hp, maxHp: st.maxHp, leader: null });
      const inBox = wx >= bb.x0 - 2 && wx <= bb.x1 + 2 && wy >= bb.y0 - 2 && wy <= bb.y1 + 2;
      const d = Math.hypot(wx - ax, wy - ay);
      if ((inBox || d <= S.TILE * .9) && d < bestD) { best = e; bestD = d; }
    }
    return best;
  }
  // ── 鼠标与按钮：与文字命令共用 SIM 的同一批执行器 ──
  function clickMap(event){
    const p=canvasPoint(event),t=screenToTile(p.sx,p.sy),x=t.x,y=t.y;
    const wp=screenToWorld(p.sx,p.sy);
    if(S.result){show('战斗已结束，刷新页面可再来一局。');return;}
    // 点选按"你看到的位置"判定，不按真位置：薄雾区的单位画的是 FOG.lag 秒前的位置，
    // 若按真位置判定，就会出现"明明看得见却点不着"。看到什么点什么。
    const clicked=pickBlueAt(wp.x,wp.y);
    if(clicked){
      const ok=selectUnit(clicked,event.shiftKey);
      show(ok
        ? `已选中主将${clicked.name}：点地图上的空地就过去，点敌军就打它。`
        : `${clicked.name}只能看，不能拖——它不归鼠标直接指挥。要调它请下令，比如「${clicked.name}去北桥」。`);
      draw();return;
    }
    // 敌军同理：能点的是"这一份情报里的位置"（live / lagged）；残影是旧位置，点它不算锁定
    const fogNow=S.enemyFogState();
    const enemy=pickEnemyAt(wp.x,wp.y,fogNow);
    if(enemy){
      // 点敌军就是打它——不再要求先切到"攻击"模式。看见谁想打，点下去就该开打。
      if(liveSelection().length){
        S.orderAttackGroup(selection,enemy);
        if(fogNow.get(enemy.id).mode==='lagged')show(`按${S.FOG.lag.toFixed(1)} 秒前的情报打过去了——敌军可能已经挪了位置，注意看着。`);
        flush();refresh();
      }
      else show(`发现${enemy.name}，但手上没有能受令的部队（主将已阵亡或正在溃退）。其它部队仍可用文字命令调动。`);
      return;
    }
    const live=liveSelection();
    if(!live.length){show(selection.length?'主将已阵亡或正在溃退，鼠标暂时没有可指挥的部队。':'主将已阵亡：鼠标没有直属部队了，其它部队仍可用文字命令调动。');return;}
    // 一次性指令（驻守/集结）：执行完立刻回到默认，不用记得按回去
    const kind=pending||'MOVE';
    S.groupAssign(selection,x,y,kind,{strictSingle:true});
    if(pending)setPending(null);
    flush();refresh();
  }
  canvas.addEventListener('click',clickMap);
  function setPending(m){
    pending=m;
    document.querySelectorAll('button[data-mode]').forEach(b=>b.classList.toggle('selected',b.dataset.mode===m));
  }
  document.querySelectorAll('button[data-mode]').forEach(button=>button.addEventListener('click',()=>{
    const m=button.dataset.mode;
    if(m==='RETREAT'){
      const live=liveSelection();
      if(!live.length){show('请先选择可用的部队。');return;}
      if(live.length===1)S.orderRetreat(live[0]);
      else S.retreatUnits(live);
      setPending(null);flush();refresh();return;
    }
    // 驻守/集结是一次性的：按下去备好，点完一个位置就自动失效。
    // 再按一次同一个按钮＝取消（不用去别的按钮上找"取消"）。
    if(pending===m){ setPending(null); show('已取消，回到默认：点空地过去，点敌军打它。'); return; }
    setPending(m);
    if(m==='DEFEND')show('驻守：点一个位置就执行一次，之后自动回到默认（点哪去哪、点敌军就打）。');
    else if(m==='RALLY')show('集结：点一个集结点就执行一次，之后自动回到默认。要让全军集结，直接说「全军集合」。');
  }));
  document.getElementById('stopButton').addEventListener('click',()=>{
    const live=liveSelection();
    if(!live.length){show('请先选择一支部队。');return;}
    S.stopUnits(live);
    flush();refresh();
  });
  // 戒备是一条命令，不是自动状态：由你决定哪一段路值得绷紧，代价是速度与精力。
  const stanceButton=document.getElementById('stanceButton');
  function refreshStance(){
    const live=liveSelection();
    const on=live.length>0&&live.every(u=>u.stance==='GUARDED');
    const label=on?'转为常行':'转入戒备';
    if(stanceButton.textContent!==label)stanceButton.textContent=label;
    stanceButton.classList.toggle('selected',on);
  }
  stanceButton.addEventListener('click',()=>{
    const live=liveSelection();
    if(!live.length){show('请先选择可用的部队。');return;}
    if(live.every(u=>u.stance==='GUARDED'))S.stanceUnitsOff(live);
    else S.stanceUnitsOn(live);
    flush();refresh();
  });
  document.getElementById('commanderButton').addEventListener('click',()=>{
    if(!selected||selected.hp<=0){show('请先选择一支存活部队。');return;}
    if(S.commander===selected){show(`${selected.name}已经是将旗。`);return;}
    S.commander=selected;
    show(`${selected.name}受命为将旗：${S.MORALE.AURA_RADIUS} 格内友军士气 +${S.MORALE.AURA}，将领阵亡则全军 ${S.MORALE.LEADER_LOST}。`);
    refresh();
  });
  // ── 整队（主将收编周围兵力，81）────────────────────────────────
  // 为什么是"键 + 按钮"而不是一条文字命令：这是**对单一单位的即时操作**（像"停止"），
  //   不是"下一个意图"。走 b 层要为它加动词、词表、训练语料与判分口径，
  //   而它能做的事只有一件——把身边友军的兵补进主将部队。为一件操作开一条语言通道不划算。
  // 反馈口径按 79 定的规矩：**上屏、不播报**（鼠标/按键直接操作进不了副将的对话）。
  function doAbsorb(){
    if(!S.absorbNear){show('这一版没有整队功能。');return;}
    const r=S.absorbNear('blue');
    if(!r.ok)show(`整队：${r.why}。`);
    // 成功时 d 层已经 toast（谁补进来多少），这里不重复一遍
    flush();refresh();
  }
  const absorbButton=document.getElementById('absorbButton');
  if(absorbButton)absorbButton.addEventListener('click',doAbsorb);

  // ── 文字命令输入框与命令日志面板 ──
  function cmdSubmitFromInput(){
    CMD.submit(cmdInput.value);
    cmdInput.value='';
    refresh();
    // 提交后焦点留在输入框，玩家可以连续输入下一条命令
    if(cmdInput.focus)cmdInput.focus();
  }
  cmdButton.addEventListener('click',cmdSubmitFromInput);
  cmdInput.addEventListener('keydown',e=>{if(e.key==='Enter')cmdSubmitFromInput();});
  echo('鼠标只直接指挥主将（带将旗那支）：点地图即移动，点别的部队只是看。其它部队用命令调，试「枪兵队和骑兵队去北桥」或「报告」。');

  const CMD_LOG_ROW_CLASS={EXECUTED:'ok',PARTIAL:'partial',FAILED:'fail',CLARIFY:'clarify',CANCELLED:'cancel',UNSUPPORTED:'unsupported',OFFTOPIC:'offtopic',QUEUED:'clarify'};
  function renderLog(){
    const entries=CMD.getLog(),label=CMD.CMD_LOG_STATUS_LABEL;
    cmdLogListEl.innerHTML='';
    for(const e of entries.slice(-50).reverse()){
      const row=document.createElement('div');
      row.className='cmdlog-row '+(CMD_LOG_ROW_CLASS[e.status]||'');
      row.textContent=`#${e.n} · ${Math.round(e.at)}s · ${e.text} → ${label[e.status]||e.status}`
        +(e.interp?`（${e.interp}）`:'')
        +(e.feedback&&e.feedback!==e.interp?` · ${e.feedback}`:'')
        +(e.followUp?' · 追问补全':'');
      cmdLogListEl.appendChild(row);
    }
    const c=CMD.counts();
    if(!c.total){if(cmdLogStatsEl.textContent!=='暂无输入')cmdLogStatsEl.textContent='暂无输入';return;}
    const done=c.EXECUTED+c.PARTIAL,valid=done+c.FAILED+c.UNSUPPORTED;
    // 「无关内容」单独一列，且只在真的出现时才显示——它不该挤进"成功率"，
    //   也不该让没遇到过的玩家以为界面上有个槽位是空的。
    const off=c.OFFTOPIC?` ⬜${c.OFFTOPIC}`:'';
    // 已挂起（78）单列：兵还没动，现在算成算败都是猜，所以既不进分子也不进分母。
    const queued=c.QUEUED?` ⏳${c.QUEUED}`:'';
    const t=`共 ${c.total} 条：✅${c.EXECUTED} ◐${c.PARTIAL} ❌${c.FAILED} ❓${c.CLARIFY} 🚫${c.UNSUPPORTED} ✖${c.CANCELLED}${off}${queued}`+(valid?` · 成功率 ${Math.round(done/valid*100)}%`:'');
    if(cmdLogStatsEl.textContent!==t)cmdLogStatsEl.textContent=t;
  }
  document.getElementById('cmdLogExport').addEventListener('click',()=>CMD.exportLog());
  document.getElementById('cmdLogClear').addEventListener('click',()=>CMD.clearLog());
  document.getElementById('cmdLogToggle').addEventListener('click',()=>{
    const collapsed=cmdLogBoxEl.classList.toggle('collapsed');
    const label=collapsed?'展开':'收起';
    const btn=document.getElementById('cmdLogToggle');
    if(btn.textContent!==label)btn.textContent=label;
  });

  function boot(){
    resetCamera();         // 开局：画面落在主将身上（62 起这是唯一的取景方式）
    camFromQuery();        // 截图验收可指定取景，生产页面没有这个参数
    CMD.onLogChange=renderLog;
    renderLog();           // 恢复上次会话的日志（localStorage，file:// 下通常可用）
    renderList();updateInfo();updateWar();draw();
  }

  globalThis.UI={
    // 渲染
    draw,renderList,updateInfo,updateWar,refresh,
    // 播报与回显（供命令层回调）
    show,flush,lastToast,echo,echoText,lastEchoText,ask,clearAsk,
    // 语音按钮外观（a 层状态由装配层转进来；界面不含语音逻辑）
    setVoiceState,
    // 选择（命令层的"未点名回退"要用）
    liveSelection,get selection(){return selection},get selected(){return selected},
    canDirect,get commander(){return directUnit()},
    isSelectionFresh:()=>selectionFresh,consumeSelectionFresh:()=>{selectionFresh=false},
    // 相机（供测试换算点击坐标、也供外部调用）
    // 62：没有 setZoom / openingZoom 了——倍率只有一个（ZOOM_VIEW），由主将视距决定。
    cam:()=>({x:cam.x,y:cam.y,zoom:cam.zoom}),
    zoomView:()=>ZOOM_VIEW, viewTiles, followCommander,
    // 63：地形烘图的体检口（测试用）——建了几次、烘出来多大。烘图是"每帧省 7000 次 fillRect"的
    //   全部依据，所以它必须能被独立验证，而不是只能靠肉眼看帧率。
    terrainStats:()=>({built:terrainBuilds,w:terrainCache?terrainCache.width:0,h:terrainCache?terrainCache.height:0,
      view:VIEW_TILES,ms:terrainStatsMs}),
    // 65：拿到烘好的地形图本身（**只给验收/截图用**）。判"格子还在不在"必须看没有迷雾、
    //   没有部队、没有覆盖层的纯地形；从主画布截会被迷雾盖掉一半，量出来的是迷雾的格子。
    terrainImage:()=>terrainCache,
    // 相机插值（测试用）：主将"此刻真正在哪"，与画面中心必须是同一个数
    commanderFrac,
    camRect,resetCamera,centerOn,ensureVisible,tileToScreen,screenToTile,
    tileRect,   // 每格地面填充矩形（外扩 0.5）：测试用，盯住"相邻格必须重叠、缩放不留缝"
    tintAt,     // 地面明暗扰动：测试用，盯住"噪声必须是块级低频，不许回到逐格马赛克"
    // 供测试核对"视野裁剪不缺口"：返回本帧实际会画的格子范围与视口范围
    cullRange:()=>{
      const vr=camRect();
      return {vr,
        tx0:Math.max(0,Math.floor(vr.x/S.TILE)), tx1:Math.min(S.COLS-1,Math.ceil((vr.x+vr.w)/S.TILE)),
        ty0:Math.max(0,Math.floor(vr.y/S.TILE)), ty1:Math.min(S.ROWS-1,Math.ceil((vr.y+vr.h)/S.TILE))};
    },
    boot
  };
})();
