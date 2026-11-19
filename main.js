// main.js — 装配与主循环
// 职责只有四件：把命令层接到模拟层和界面上、把语音层接到命令层上、驱动固定顺序的帧循环、首次渲染。
// 帧内顺序与拆分前一致：模拟推进 →（有变化才）重绘画布 → 每帧刷新列表/详情/战况 → 取走播报。
//
// 语音接线在这里，不在 voice.js 里——这是分层的关键：
//   a 层（voice.js）只吐文本，b/c/d 三层不知道有语音这回事；
//   谁把文本送进命令层，由装配层决定（此处与手动打字走同一个入口 CMD.submit）。
(() => {
  // ── 版本指纹：判断「这是哪一版 / 线上跑的是哪一版」只认这一个值 ──────────────
  // 页头右上角显示的就是它，浏览器控制台敲 `BUILD` 也能读到。
  // 改版本时改这里，并在 HANDOFF §5 记一行、同步根目录 CURRENT.md。
  const BUILD = '2026-11-19 104';
  try { if (typeof window !== 'undefined') window.BUILD = BUILD; } catch (_) {}
  try {
    const el = document.getElementById('buildTag');
    // 56 起地图按种子生成，**种子必须显示出来**：玩家看到一个奇怪的图，
    //   报给我们时只要说这个号，就能用 ?seed=号 逐格复现同一张图。
    if (el) el.textContent = '版本 ' + BUILD + (SIM.SEED ? ' · 图 ' + SIM.SEED : '');
  } catch (_) {}

  // 装配顺序即依赖顺序：副将先就位，命令层的对外出口才会走它；没它就回落原文案。
  // ── B 层训练记录器（只在 ?rec=1 时启用）────────────────────────────────
  // 记的是四件事：玩家说了什么 / 当时的战场上下文 / b 层怎么理解 / 最后怎么执行。
  // **上下文必须记全**：没有它，「往前」「北桥」「他们」这类说法事后无法判定对错，
  //   盲标就退化成瞎标。快照在这里取（装配层是唯一同时看得见 SIM 与 UI 的地方）。
  // recorder.js 本身不碰 SIM/UI，只收这里递过去的数据——分层照旧。
  let recHook = null;
  let recSettle = null;   // 68：到点把 post 快照贴回最后一条记录（由 tick 每帧问一次）
  try {
    if (globalThis.REC && REC.enabled()) {
      REC.start({ build: BUILD, seed: SIM.SEED });
      const snap = () => {
        try {
          return {
            sel: (UI.selection || []).map(u => u.id),
            // 62 起"画面"是一条游戏规则（战斗短令只喊画面内的部队），所以画面范围必须进快照——
            //   少了它，「放箭」被拒这件事事后无法判定对错（到底是他没点名，还是敌人在画面外）。
            view: (() => { const v = UI.viewTiles(); return { x0: +v.x0.toFixed(1), y0: +v.y0.toFixed(1), x1: +v.x1.toFixed(1), y1: +v.y1.toFixed(1) }; })(),
            units: SIM.units.map(u => ({ id: u.id, name: u.name, type: u.type,
              x: +u.x.toFixed(2), y: +u.y.toFixed(2), hp: Math.round(u.hp), maxHp: u.maxHp,
              state: u.state, form: TROOP.formKeyOf(u) || null, path: u.path.length,
              // 68：判"命令执行对不对"要的四个状态量。少了它们，判分器只能看位置，
              //   于是「戒备」「停止」「撤退」「攻击某支敌军」这四类命令全都判不了。
              stance: u.stance, order: u.order || null, tgt: u.targetId || null,
              routed: !!u.isRouted })),
            foes: [...SIM.enemyFogState()].map(([id, st]) => ({ id, mode: st.mode,
              x: +st.x.toFixed(2), y: +st.y.toFixed(2) })),
            places: SIM.LANDMARKS.map(p => ({ id: p.id, name: p.name, kind: p.kind,
              x: p.x, y: p.y, owner: p.owner || null })),
          };
        } catch (_) { return null; }
      };
      // 68：`out` 之后挂一个"3 个模拟秒后回看战场"的待结算，到点把 post 快照贴回那条记录。
      //   为什么是 3 秒：长距离行军 3 秒走不到，所以判分只看**过程方向**（有没有朝那边动起来），
      //   不看终点。口径与判分规则都在 `.workbuddy/exec_accuracy.js` 顶部。
      //   为什么用模拟时间不是墙钟：掉帧、切标签页不该让"3 秒后"变成 7 秒后。
      const POST_AFTER = 3;
      let postDue = null, postAt = 0;
      recSettle = force => {
        if (postDue == null) return;
        if (!force && SIM.simTime < postDue) return;
        const dt = +(SIM.simTime - postAt).toFixed(2);
        postDue = null;
        if (typeof REC.attach !== 'function') return;      // 老 recorder：静默跳过
        const s = snap() || {};
        s.dt = dt;
        // 提前结算（下一条命令抢先到）标出来：判分器会把它们排除，否则"没跑够时间"会被算成"没执行"
        s.early = dt < POST_AFTER - 0.6;
        REC.attach('post', s);
      };
      recHook = (phase, payload) => {
        if (phase === 'in') recSettle(true);   // 新命令来之前先把上一条结掉（晚到的 post 会被新命令污染，比没有更糟）
        REC.push(phase, payload, phase === 'in' ? snap() : null);
        if (phase === 'out' && payload && (payload.status === 'EXECUTED' || payload.status === 'PARTIAL')) {
          postAt = SIM.simTime; postDue = SIM.simTime + POST_AFTER;
        }
      };
    }
  } catch (_) { recHook = null; }   // 记录器出任何问题都不许影响下令

  // e′ 语音层：先于副将接线。它不认识 SIM / CMD，只认 Utterance；驱动自己挑
  //   （浏览器 speechSynthesis）。接不上就是"没有声音"，屏幕反馈照常。
  //   onCut 是唯一的反向通道：玩家按下 PTT 时正在念的半句话被掐断，
  //   必须回到屏幕并标「被打断，未念完」——半句话不许只活在扬声器里。
  try {
    if (typeof SPEECH !== 'undefined' && SPEECH) {
      SPEECH.wire({ onCut: cut => { try { UI.echo('副将（被打断）：' + cut.screen); } catch (_) {} } });
    }
  } catch (_) {}
  ADJUTANT.wire({sim:SIM,ui:UI});
  CMD.wire({sim:SIM,ui:UI,rec:recHook});
  COMMANDER.wire(SIM);
  UI.boot();

  // ── b 层兜底的提示通道：semantic.js 不碰 UI，由装配层把它的说明接到界面 ──
  // 这个钩子必须在这里（同步）设好：semantic.js 是 ES module，一定在本文件之后执行；
  // 它加载失败时也要走这条路把原因说出来，所以不能等它先来注册。
  try { globalThis.SEMANTIC_NOTE = (msg) => UI.echo(msg); } catch (_) {}

  // ── a 层接线：VOICE --文本--> CMD.submit   VOICE --状态--> UI ──────────
  // 任何一步失败都只影响语音，不影响打字下令与游戏循环。
  function wireVoice(){
    if (typeof VOICE === 'undefined' || !VOICE) return;
    if (!VOICE.isSupported()) { UI.setVoiceState('unsupported'); return; }

    // 识别后端只跑在操作者本机（默认 127.0.0.1:8415）。页面一旦从别的机器或远端地址打开，
    // 就一定连不上——线上托管正是这种情况，而且 https 页面去 fetch http 回环地址会被浏览器
    // 按混合内容直接拦掉，用户按下去只得到一句看不懂的报错。所以先按页面来源判一次：
    // 非本机来源直接标不可用，把"语音只在本机"的现状如实说清，键盘与点击下令不受影响。
    // 将来识别服务也搬上线时（单端口合并），删掉这段判定即可。
    const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '::1', '[::1]'];
    const pageHost = (typeof location !== 'undefined' && location.hostname) || '';
    if (pageHost && !LOCAL_HOSTS.includes(pageHost)) {
      UI.setVoiceState('unsupported', {
        message: '语音只在本机演示可用（需要同时运行本地识别服务）。此页面的键盘与点击下令不受影响。',
      });
      return;
    }

    // 后端地址默认 127.0.0.1:8415；换端口时用 ?voice=http://127.0.0.1:8416 打开即可
    // 102：**只认回环地址**。以前把参数原样塞进 endpoint，一条构造好的链接就能让
    //   页面把麦克风录音 POST 到别人的服务器（页面来源校验只管了"从哪打开"，没管"发给谁"）。
    try {
      const ep = new URLSearchParams(location.search).get('voice');
      if (ep) {
        let epHost = '';
        try { epHost = new URL(ep, location.href).hostname.replace(/^\[|\]$/g, ''); } catch (_) {}
        if (LOCAL_HOSTS.some(h => h.replace(/^\[|\]$/g, '') === epHost)) VOICE.configure({ endpoint: ep });
        else UI.echo('已忽略 ?voice= 里的外部地址：识别服务只允许本机回环地址（127.0.0.1 / localhost）。');
      }
    } catch (_) {}

    VOICE.onText(({text,empty}) => {
      // 识别回来 = 麦克风这一趟用完了 → 放开语音层（内部再留 250ms 回声尾巴）。
      //   放在这里而不是松手时：松手到识别返回之间，声音仍会被录进去。
      try { if (typeof SPEECH !== 'undefined' && SPEECH) SPEECH.setMic(false); } catch (_) {}
      if (empty || !text) { UI.echo('没听清，再说一次（或直接打字）。'); return; }
      UI.echo(`🎤 ${text}`);
      CMD.submit(text);              // 与手动输入完全同一入口：校验/追问/抗命照常
    });
    VOICE.onStatus(({state,detail}) => UI.setVoiceState(state, detail));

    const btn = document.getElementById('voiceBtn');
    if (!btn || !btn.addEventListener) return;

    // 按住说话。注意首次按下要先申请麦克风权限，start() 可能比"松开"慢；
    // 若不等它就去置 hold，会出现"已经松手却还在录"——所以用 pressed 记录按键真实状态，
    // start() 回来后再检查一次：手已经松了就提示重按，不偷偷录下去。
    let pressed = false, starting = false;
    const press = async ev => {
      if (ev && ev.preventDefault) ev.preventDefault();
      pressed = true;
      // PTT 与语音播报互斥（ADJUTANT.md §7，硬约束不是优化）：
      //   不掐断的话，麦克风会把副将自己的话录进去，识别成一条新命令，再念再录 → 死循环。
      //   掐断的内容由语音层记进 cut 日志并转屏（半句话不许只活在扬声器里）。
      try { if (typeof SPEECH !== 'undefined' && SPEECH) SPEECH.setMic(true); } catch (_) {}
      if (starting) return;
      starting = true;
      try {
        if (VOICE.status() !== 'listening') {
          const ok = await VOICE.start();
          if (!ok) return;
        }
        if (!pressed) {
          UI.setVoiceState(VOICE.status(), { hint: '麦克风刚就绪，再按住说一次' });
          return;
        }
        VOICE.hold(true);
      } finally { starting = false; }
    };
    const release = () => {
      pressed = false;
      // 102：**无条件松手**。以前判 `VOICE.isRecording()`，而它在首个音频块到达前是 false
      //   （4096 样本 ≈ 256ms 一块）——任何短于 256ms 的点按都会把 held=true 留在语音层，
      //   随后一直录到 15 秒上限，松手以后说的话照样被当成军令执行（审查实测）。
      //   hold(false) 在没在收的时候只是把 held 放掉，不会误发识别。
      VOICE.hold(false);
      // 释放麦克风要等**识别返回**之后（见 onText），不是松手就解——上传那 1 秒里
      //   副将若开口，声音仍在录音尾巴里。这里只挂一个兜底：识别始终没回来也得解开，
      //   否则这一局副将永远哑掉。
      setTimeout(() => {
        try {
          if (typeof SPEECH !== 'undefined' && SPEECH && SPEECH.__micOn && SPEECH.__micOn()) SPEECH.setMic(false);
        } catch (_) {}
      }, 3000);
    };

    btn.addEventListener('pointerdown', press);
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointerleave', release);
    btn.addEventListener('pointercancel', release);
    // 键盘/读屏可达：空格按下即开始、松开即结束
    btn.addEventListener('keydown', ev => { if (ev.key === ' ' || ev.key === 'Enter') press(ev); });
    btn.addEventListener('keyup', ev => { if (ev.key === ' ' || ev.key === 'Enter') release(); });

    // 启动时探一次后端：不可用就明说，别让人按了才发现
    Promise.resolve(VOICE.checkBackend()).then(r => {
      if (r && r.ok) {
        UI.setVoiceState(VOICE.status(), { hint: '按住说话，松开即下令（本地识别，不联网）' });
      } else {
        UI.setVoiceState('error', { message: `识别服务未连接：${(r && r.error) || '未知原因'}　另开终端跑 python voice_backend.py` });
      }
    });
  }
  try { wireVoice(); } catch (e) { try { UI.setVoiceState('error', { message: String(e && e.message || e) }); } catch (_) {} }

  let lastTime=performance.now();
  function tick(now){
    // 真实时间不再直接当模拟步长（66）：它只回答"这一帧该推进几步、插值多少"。
    //   0.25 秒上限＝MAX_CATCHUP 步，切标签页回来最多补 5 步，不会一帧跑上千步卡死。
    const dt=Math.min((now-lastTime)/1000,.25);lastTime=now;
    // c / c′ 与 d 层走**同一个逻辑步**（102）：以前它们拿"这一帧共补了几步"的合计，
    //   一帧里补 2 步时只跑一次，补步越多越慢半拍——10fps 与 20fps 同种子轨迹不同，
    //   而 `?seed=` 复现是硬约束。现在交给 sim 在每一步之后回调一次，合计一秒仍是 1 秒。
    const f=SIM.tick(dt,stepSec=>{
      CMD.tick(stepSec);        // c 层：组合句排队
      COMMANDER.tick(stepSec);  // c′ 层：敌军指挥决策
    });
    // e1（编制/队形）走**真实帧 dt**，不走 20Hz 逻辑步：逻辑步决定事实，帧决定画面。
    //   67 之前它在 sim.step() 里按 1/20 推进，而重绘只在下面那几个 dirty 标志为真时才发生——
    //   全场静止时 tick 连续返回全 false，兵位却还在逼近模板，于是队形冻在"过渡到一半"。
    //   现在由它自己回答"这一帧还用不用再画"（换阵了 / 还有兵没站到位 / 队形还在转）。
    const troopDirty=TROOP.update(SIM.allUnits, dt);
    // 68：执行正确率的取证——到了"命令后 3 个模拟秒"就把战场真值贴回那条记录。
    //   放在这里是因为只有装配层知道"SIM 的钟走到哪了"，recorder 本身不认时间。
    if(recSettle)recSettle(false);
    // 营地可以是 0 处（55：营地数是地图数据，不是常量）。这里原来直接读 `SIM.site.progress`，
    //   空营地地图上第一帧就 null.progress 抛异常，requestAnimationFrame 断掉 → 整局卡在开局。
    if(f.changed||f.moving||f.moraleDirty||f.awareDirty||f.staminaDirty||troopDirty||(SIM.site&&SIM.site.progress>0))UI.draw();
    UI.renderList();UI.updateInfo();UI.updateWar();
    ADJUTANT.observe(dt);   // c8 副将：只报变化，节流 1.6 秒一句，自己决定说不说（跟墙上的钟走）
    // e′ 语音层：自己排队、自己念完一句再取下一句（不抢占）。吃真实帧 dt 的毫秒数——
    //   它管的是"人说话的节奏"，与 20Hz 逻辑步无关。
    try { if (typeof SPEECH !== 'undefined' && SPEECH) SPEECH.tick(dt * 1000); } catch (_) {}
    UI.flush();
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();
