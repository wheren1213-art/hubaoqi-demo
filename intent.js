// intent.js — 意图转化层（c 层）：意图要素 → 行动命令，经执行器契约递给 d 层
// 职责：追问对话状态机、把 b 层的解析结果分发到 sim 执行器、组合句排队、部队上下文、命令日志。
// "命令=目标"的交接点：本层只调 sim.js 底部的执行器契约（order*/groupAssign/stanceUnits*/setRiverBan/
// rallyPoint/statusReport…），不直接读写战斗单位内部状态——d 层内部怎么改都不影响这里。
// 语言逻辑（词表/分词/纠错）全部在 understand.js（b 层），本文件不出现词表。
// 语音接入时（sherpa-onnx 只负责声音转文字）把识别文本提交给 CMD.submit() 即可。
(() => {
  const U=UNDERSTAND;
  let api=null;   // wire({sim,ui}) 注入：模拟层执行器 + 界面回调

  // ── ACTION_CAPS（69 立表，71 按四类收拢）：c 层「我能执行什么」的唯一声明 ────
  // 这张表是 b→c 契约的唯一定义处。b 层在加载时调 U.bindCaps() 校验自己的词表，
  //   表里没有的动作 b 层就产不出来——不是"产出来再拒收"，是启动就炸。
  //
  // ── 71 收拢：一切部队操作只有四类（照 RTS 的四种输入动作）─────────────
  //   1️⃣ MOVE   走到某处                    （右键点地）
  //   2️⃣ ATTACK 打某个目标                  （右键点敌）
  //   3️⃣ ATTACK 走过去、路上遇到就打        （A + 点地）
  //   4️⃣ STATE  打开/关闭某种状态            （技能/姿态）
  //   对话（报告/叫援军/侦察）不是部队操作 → 单列 TALK，不进这四类，也不实现。
  //
  // **op 只有三个值而类别有四个**：2️⃣3️⃣ 在手上是两个键，在意图上是同一件事——「打」，
  //   区别只是打**点名的那个人**还是打**路上遇到的人**。拆成两个 op 等于承认
  //   "右键"和"A键"是两种不同的战争行为，而它们在战场上是同一件事的两种参数。
  //
  // **arrive / engage 是参数，不是新动作**：
  //   arrive = 走到了以后干什么   NONE(什么都不干) / RALLY(汇合) / CAPTURE(占住) /
  //                               FOLLOW(跟着) / HOME(回本方后方) / SELF(就地停)
  //   engage = 路上遇敌怎么办     FIGHT(停下打) / PASS(穿过去)
  //   RALLY / CAPTURE / FOLLOW / RETREAT / STOP 以前是五个动作，其实是 arrive 的五个取值。
  //   它们被做成独立动作，是执行细节泄漏到了语义层——玩家心里只有"去哪儿"一件事。
  //
  // **slots 不是 need**（71 修正）：原来写 `need:['unitIds','locId|dir']`，字面意思是
  //   "必须有这些槽"，等于把"缺不缺"写成了动作的固有属性。但缺主语只是想不起叫谁、
  //   缺宾语只是想不起说哪儿，是**这句话没说全**，不是**这个动作不成立**。
  //   所以改成 `slots`：这个动作**能接受**哪些槽。缺了走补全/追问，不算违约。
  //   （实测：need/ch 两个字段全项目零处读取，纯注释——所以上一版连"必须"都没真校验过。）
  const ACTION_CAPS={
    // ── 1️⃣ MOVE：兵会走，位置会变。差别只在 arrive ──
    MOVE:     {op:'MOVE',   arrive:'NONE',    slots:['unitIds','locId','dir'],             exec:'groupAssign / orderAdvance'},
    RALLY:    {op:'MOVE',   arrive:'RALLY',   slots:['unitIds','locId','dir'],             exec:'groupAssign(GROUP)'},
    CAPTURE:  {op:'MOVE',   arrive:'CAPTURE', slots:['unitIds','locId'],                   exec:'groupAssign（缺地点→默认中央据点）'},
    FOLLOW:   {op:'MOVE',   arrive:'FOLLOW',  slots:['unitIds','followId','followAnchor'], exec:'followUnit'},
    GUARD_ME: {op:'MOVE',   arrive:'FOLLOW',  slots:['unitIds'],                           exec:'followUnit(将旗)'},
    RETREAT:  {op:'MOVE',   arrive:'HOME',    slots:['unitIds'],                           exec:'retreatUnits（目标＝本方后方）'},
    STOP:     {op:'MOVE',   arrive:'SELF',    slots:['unitIds'],                           exec:'stopUnits（目标＝当前位置）'},
    // ── 2️⃣3️⃣ ATTACK：一个 op，两条路，靠宾语决定 ──
    //   宾语是敌军        → 2️⃣ 打他（engage 无关）
    //   宾语是地点/方向   → 3️⃣ 走过去，engage 决定路上打不打
    ATTACK:   {op:'ATTACK', engage:'FIGHT',   slots:['unitIds','foeId','locId','dir','arrow'], exec:'orderAttackGroup / attackMove / groupAssign'},
    // ── 4️⃣ STATE：兵不动，只有开关变。state+on 两个字段说清"哪个状态、开还是关" ──
    STANCE_ON:  {op:'STATE', state:'GUARD',  on:true,  slots:['unitIds'],           exec:'stanceUnitsOn'},
    STANCE_OFF: {op:'STATE', state:'GUARD',  on:false, slots:['unitIds'],           exec:'stanceUnitsOff'},
    DEFEND:     {op:'STATE', state:'DEFEND', on:true,  slots:['unitIds','locId','dir'], exec:'groupAssign(HOLD)（缺地点→原地守）'},
    RIVER_ON:   {op:'STATE', state:'RIVER',  on:true,  slots:['unitIds'],           exec:'setRiverBan(true)＝开启过河禁令'},
    RIVER_OFF:  {op:'STATE', state:'RIVER',  on:false, slots:['unitIds'],           exec:'setRiverBan(false)＝解除禁令'},
    // 97：活捉（不击杀）。**不是一个"更客气的攻击"**，是打起来之后"最后一下换个收场"：
    //   兵照打、照挨打、照掉血，只在"这一下本来会把人打死"时掷一次骰——抓到就是俘获，没抓到照常击杀。
    //   所以它是 STATE 类（兵不动、只改接敌时的结算），宾语是开关本身（obj.kind==='state'）。
    //   它跟着**这一道攻击令**走：普通攻击令会把它复位（见 ATTACK 分支），因为活捉没有反向开关，
    //   不复位就成了单向门（说一次活捉，此后再也收不回来）。
    //   为什么要单独一条动作：规格的 struct 是 `['ATTACK','CAPTURE_ON']` 两件事，
    //   而 94 定的规矩是"能力表里没有的动作不许造"——要做，就得真做出来。
    CAPTURE_ON: {op:'STATE', state:'CAPTURE', on:true, slots:['unitIds'],           exec:'setCapture(true)＝致命一击按概率改判俘获'},
    // 98（Q36/Q38/Q40）：全力冲锋＝**这一道攻击令的形态**，不是新能力、更不是加速。
    //   兵照常打、照常挨打，只多两件看得见的事：切第七阵型 RUSH、破阵原因写成「全力冲锋」。
    //   没有反向开关，所以下一道普通命令必须复位（97 单向门教训 / A7）。
    RUSH_ON: {op:'STATE', state:'RUSH', on:true, slots:['unitIds'], exec:'setRush(true)＝切冲锋乱锋阵，接战/新令/目标消失即收'},
    // 101：加速行军＝**行军档位**，不是一次动作。三条与冲锋相反的规矩写在这里：
    //   ① 跨命令保留（说一次一直有效，不会因为下一道移动令就没了）；
    //   ② 兵不动的时候不扣费（扣费在移动链上，见 FORCED.DRAIN）；
    //   ③ 必须有反向命令（FORCED_OFF），否则就是单向门（97 的教训）。
    //   接战／体力见底由 d 层的 updateForced 收场，c 层不重复判——判据只留一处。
    FORCED_ON:  {op:'STATE', state:'FORCED', on:true,  slots:['unitIds'], exec:'setForced(true)＝行军档位切常行的 1.2 倍，真走时扣体力 2.0/秒'},
    FORCED_OFF: {op:'STATE', state:'FORCED', on:false, slots:['unitIds'], exec:'setForced(false)＝回到常速行军'},
    // ── TALK：不是部队操作。不进四类；本轮不投入开发（上司：先不做，不在游戏机制里）──
    //   注意"不开发"不等于"已拆掉"：这三条现在的行为一字未动，只是明确它们不占四类的位置。
    REPORT:    {op:'TALK', slots:[], exec:'statusReport（照旧）'},
    CALL_ARMS: {op:'TALK', slots:[], exec:'追问式对话，无执行器（照旧）'},
    RECON:     {op:'TALK', slots:[], exec:'明确回执"未实现"（照旧）'},
  };
  // 四类的取值集合：用来断言"没有第五类"。TALK 不是操作类别，所以不在其中。
  const OP_KINDS=['MOVE','ATTACK','STATE'];
  const OP_ALL=OP_KINDS.concat('TALK');

  // ── 71 结构自检：四类之外不许有第五类 ──────────────────────────────────
  // 这查的不是风格。加了新动作却忘了说它属于哪一类，c 层就没法把它归到四条路里的任何一条，
  //   以前的表现是"悄悄多一个 switch 分支"——没人发现，直到某天它返回 undefined。
  //   现在在加载时停住，并指名是哪个动作没说清楚。
  function assertOps(tbl){
    tbl=tbl||ACTION_CAPS;   // 传参是为了可测：测试要能塞一张"缺 op"的表进来，证明它真会抛
    const bad=[],cnt={};
    for(const [act,c] of Object.entries(tbl)){
      if(!c.op){bad.push(`${act} 没写 op（没说它属于哪一类）`);continue;}
      if(OP_ALL.indexOf(c.op)<0){bad.push(`${act} 的 op='${c.op}' 不在四类里（只许 ${OP_ALL.join(' / ')}）`);continue;}
      cnt[c.op]=(cnt[c.op]||0)+1;
    }
    if(bad.length)throw new Error(`[四类收拢] ${bad.join('；')}。四类操作＝MOVE/ATTACK/STATE，对话＝TALK。`);
    return cnt;
  }
  const OP_COUNT=assertOps();

  // ── 战术词能力表：玩家说了 b 层认得出的战术词，c 层判"接不接得住"（70）────
  // 判两件事，不能混：
  //   have     —— 这个战术现在有没有实现
  //   blocking —— 没实现时，「按字面降级执行」的结果会不会和玩家说的**相反**
  // blocking 的判据不是"重要不重要"，是 **不可逆 + 与明示意图相反**：
  //   capture    打死不可逆，玩家要的是活的，落地就是把活人打死  → 拒
  //   stratagem  玩家以为敌会上钩，实际不会，据此做的判断全错      → 拒
  //   conditional 玩家以为有触发器，实际没有，兵会无条件冲上去      → 拒
  //   formation  有和没有一个样（FORMATION.BONUS 恒 1.0），说一句就够 → 不拒
  //   flank      走直线，但到的还是那个地方，结果对得上              → 不拒
  //   encircle   72 起 have:true——它不再是一句注记，而是一张并行主谓宾的 plan
  //              （每支部队一个环位）。判据留在表里，是为了"能做到"也要有个地方写明怎么做。
  // 拒的时候不调任何执行器，回执必须写"未执行"并给出能用的说法——
  //   只说"不支持"等于把命令吃掉，玩家会再换十种说法试。
  const TACTIC_CAPS={
    // 97：**不再拒了**——活捉已经真做出来了（ATTACK + CAPTURE_ON 两段，见 ACTION_CAPS）。
    //   blocking 由"打起来就是打到死"变成 false，是因为那句话已经不成立：
    //   现在打垮目标那一刻，随军的将会被俘而不是被杀，玩家说的和做的方向一致。
    //   判据留在表里仍然有用：它写清"能做到"具体指什么，别处不必再猜。
    capture:     {have:true,  blocking:false, why:'活捉＝照常攻击，打垮对方那一刻把随军的将改判俘获；随军无将的敌人抓不到人，仍按击破结算',
                  fix:'说「击败」「击溃」或「打那支」'},
    stratagem:   {have:false, blocking:true,  why:'诱敌、诈降、疑兵要敌方按计策反应，当前敌军不会上钩',
                  fix:'直接说你想让对方怎么样，或者直接下攻击令'},
    conditional: {have:false, blocking:true,  why:'这句话里的条件换不成触发器（现在只认"看到某支敌军/敌主将进视野"和"过几秒"两种）',
                  fix:'把条件说成「直到看到敌主将才…」或「等 10 秒再…」；要等"渡河到一半"这类时机，现在还说不了'},
    // 78 埋伏：能做了——它就是"停在设伏点 + 压制（不主动接敌）"，两样都是现有机制。
    //   判据留在表里仍然有用：它说清"能做到"具体是哪两件事，别处不必再猜。
    ambush:      {have:true,  blocking:false, why:'伏击＝停在设伏点不主动接敌，条件成立才动手；被打了会还手并暴露位置'},
    encircle:    {have:true,  blocking:false, why:'合围＝各队分头占住目标周围的一个方位，到点即战'},
    formation:   {have:false, blocking:false, why:'阵型由部队自动选择，且不影响战力'},
    flank:       {have:false, blocking:false, why:'会走直线，不会绕行'},
  };
  // 拒的命令里只能出现玩家自己的说法，不能出现代码里的 key。
  const TACTIC_CN={capture:'生擒/活捉',stratagem:'诱敌/诈降这类计策',conditional:'条件指令',
    ambush:'埋伏/伏击',encircle:'合围/包围',formation:'阵型/翼侧',flank:'包抄/绕行'};
  // 被拒的战术词：返回 {block:[{key,why,fix}], say:[被删掉的注记]}
  //   say 要删掉的原因：注记写的是"按攻击执行"，可命令实际没执行，
  //   同一条日志里两句话互相打脸，玩家会以为兵已经动了。
  function tacticBlock(cmd){
    const list=(cmd&&cmd.tactics)||[];
    if(!list.length)return null;
    const block=[],say=[];
    for(const t of list){
      const c=TACTIC_CAPS[t.key];
      // 表外 key 不在这里报——那是 bindCaps 该在启动时挡掉的事，
      //   到运行期说明有人绕过断言往 cmd.tactics 塞了东西，按"没判据"处理最安全。
      if(!c)  {block.push({key:t.key,why:'这条战术没有对应判据',fix:'换个说法'});say.push(t.say);continue;}
      if(c.blocking){block.push({key:t.key,why:c.why,fix:c.fix});say.push(t.say);}
    }
    return block.length?{block,say}:null;
  }
  // 拒绝一条"说了但做不到"的命令。两处共用：issueCommand 执行前，dispatchOrClarify 追问前。
  //   追问前那一处是必须的——「遇到敌人就打」在 b 层会先追问"往哪儿"，
  //   玩家答了地点也换不来条件触发器，等于用一个能回答的问题掩盖了一个不成立的要求。
  function rejectTactic(cmd,src,tb){
    if(tb.say.length&&Array.isArray(cmd.unsupported))
      cmd.unsupported=cmd.unsupported.filter(x=>tb.say.indexOf(x)<0);
    const why=tb.block.map(b=>`「${TACTIC_CN[b.key]||b.key}」${b.why}`).join('；');
    const fix=[...new Set(tb.block.map(b=>b.fix).filter(Boolean))].join('；也可以');
    const msg=`这条命令没有执行：${why}。`+(fix?`\n要这么做的话，${fix}。`:'');
    emit(src,msg);
    return {status:'UNSUPPORTED',interp:'',feedback:`未执行：${tb.block.map(b=>b.key).join('、')}`,tactics:tb.block};
  }

  // ── PLAN（72）：一条命令的规范形状 ＝ 主谓宾 × 阶段 × 并行 ────────────────
  // 上司 2026-11-01 定的三条，是**接口的形状**，不是实现口味：
  //   ① 一切指令收拢到主谓宾——原子＝{act 谓, subj 主, obj 宾}；
  //      谓语**不因缺主或缺宾而改变**（缺了是"这句话没说全"，走补全/追问，不是换一个动词）。
  //   ② 一条指令可以有多阶段——steps[] 之间顺序，前一步做完才做下一步
  //      （"先占桥再北上"；组合句队列跑的就是这个）。
  //   ③ 一条指令可以有多个同步主谓宾——step.assigns[] 之间并行，同一时刻下达。
  //      「兵分两路守两座桥」＝每队一个宾语；「合围」＝同一目标周围的不同点，
  //      分别指定给不同部队（主语不同、宾语也不同）。
  //
  // 为什么值得单独立个形状：b 层说得出"一句话里几件事、谁跟谁同时"，
  //   而 c 层以前只有一条扁平 cmd 接得住"一件事"。于是分兵被做成 multiLocs 特例、
  //   合围被做成一句注记——不是不想做，是没有地方放"第二件事"。
  //   形状定下来之后这类话才有落点，断言也才查得出"同一支部队被同时派了两遍"。
  //
  // 宾语（obj）按"执行器最后要什么"分，不按中文语法分：
  //   foe 点名敌军 · loc 图上地点或坐标点 · dir 方向+距离 · unit 某支部队 ·
  //   self 就地 · home 本方后方 · state 状态开关
  // 这七种正好把四类操作分开：MOVE 认 loc/dir/self/home/unit，ATTACK 认 foe/loc/dir，
  //   STATE 认 state/loc，TALK 没有宾语（它不是部队操作）。表在 OP_OBJ，登记一次。
  //
  // **STATE 为什么认两种宾**（72 断言逼出来的）：4️⃣ 里其实是两种东西——
  //   开关型（戒备、过河禁令）：宾是**开关本身**（state:GUARD on/off），兵不动；
  //   任务型（驻守、到点即战）：宾是**地点**（守哪儿），兵要走到那儿去守。
  //   两者都属于"打开某种状态"，但一个的参数是开关、一个的参数是位置。
  //   把它们塞进同一个宾语种类，等于承认"守北桥"和"守"是一回事——那不是玩家的话。
  const OP_OBJ={
    MOVE:  ['loc','dir','self','home','unit'],
    ATTACK:['foe','loc','dir'],
    STATE: ['state','loc'],
    TALK:  [],
  };
  function hasTactic(cmd,key){return ((cmd&&cmd.tactics)||[]).some(t=>t&&t.key===key);}
  // 平坦 cmd 的"宾"：按执行器实际会读到的东西取，不按句子成分猜。
  //   顺序有讲究：STATE 先判（它的宾是状态开关，不是地点），FOE 先于 LOC（"攻击北桥的敌人"
  //   两个都有时，宾语是那个人）。
  function objOf(cmd){
    const caps=ACTION_CAPS[cmd.action]||{};
    if(caps.op==='TALK')return null;
    // 状态类要分两种：任务型（守哪儿，宾是地点）先取地点；开关型（戒备/过河）宾才是开关。
    //   顺序反了会得到"DEFEND 的宾语是 GUARD"——守桥这条命令的地点凭空消失。
    if(caps.op==='STATE'&&!cmd.locId)return {kind:'state',state:caps.state,on:!!caps.on};
    if(cmd.foeId)return {kind:'foe',id:cmd.foeId};
    if(cmd.locId)return {kind:'loc',id:cmd.locId};
    if(cmd.dir)return {kind:'dir',dir:cmd.dir,dist:cmd.dist||null};
    if(cmd.followId)return {kind:'unit',id:cmd.followId};
    if(cmd.action==='STOP')return {kind:'self'};
    if(cmd.action==='RETREAT'||cmd.action==='GUARD_ME')return {kind:'home'};
    return null;
  }
  function assignOf(cmd){return {act:cmd.action,subj:(cmd.unitIds||[]).slice(),obj:objOf(cmd)};}
  // ── 阶段（78）：一组并行主谓宾 ＋ 一个触发 ＋ 一个压制开关 ─────────────
  // when 的语义只有一句：**进这一段之前要等什么**。默认 {kind:'arrived'}＝等上一段到位。
  //   四档：arrived（现状）/ elapsed{sec} / sight{who,dist} / foeDown{foeId}。
  //   为什么挂在阶段上而不是挂在命令上：一条命令只能有一个 when，而"先去、再等、才打"
  //   需要三个不同的等待点——它们本来就属于不同的阶段。
  //   arrived 不写进 step：它是默认值，写进去等于每个阶段都带一个"等上一段"，
  //   而第一段前面没有上一段（写了就得特判 idx===0，那是自找的分支）。
  // suppress：这一段下达时，主语进入"不主动接敌"（伏着）。它跟着阶段走，
  //   所以"伏着等"和"条件成立后冲锋"能写在同一条命令里——前者带 suppress，后者不带。
  // cmd 是扁平命令的保留副本：d 层执行器（一支部队一条令）现在仍收 cmd；
  //   assigns 是人能读、断言能查的规范形状。两者同源，不各写一份、也不会漂。
  function stepOf(cmd){
    const st={assigns:[assignOf(cmd)],cmd:cmd};
    if(cmd.when&&cmd.when.kind!=='arrived')st.when=cmd.when;
    if(cmd.suppress)st.suppress=cmd.suppress;
    return st;
  }
  // 一条扁平命令＝只有一个阶段、一个主谓宾的计划（**所有**命令都过这一关，没有例外）
  // 94 例外由 b 层显式声明：cmd.ops 说"这条命令真实是两件事"，c 层只照着展成两个阶段。
  //   **c 层不猜中文、也不按 action+locId 反推**——「务必守住北桥」与「驻守北桥」交出的 cmd
  //   一模一样，反推会把本该单步的 36 条展开错（94 训练台实测）。来源归 b 层是唯一不误伤的办法。
  //   第一步 MOVE 保留原 locId（槽位不丢，训练台 slotLost 才量得出来），第二步仍是原动作；
  //   两步都必须是 ACTION_CAPS 里已有的动作 —— 绝不凭空造 `CAPTURE_ON`（d 层没有它）。
  //   planOfSteps（组合句排队）从 102 起对**含同刻开关**的段也二次展开——不展开就会把
  //   「再活捉/再冲锋/再加速」整段丢掉；其余段仍是"玩家明说的几件事"，保持一段一阶段。
  function planOf(cmd){
    const ops=cmd&&cmd.ops;
    // ── 97 活捉：一句话的两个阶段（2️⃣ 打他 ＋ 4️⃣ 开活捉）────────────────────
    // 形状与「驻守北桥」（MOVE→DEFEND）**完全一样**，所以它不需要新的执行路径，
    //   只是又多了一种"一句话两段"的来源。规格（`eval/spec.js` capture.foe）要的就是这个结构。
    // 第一步保留 foeId（要打的还是那个人）；第二步**只带开关**：
    //   locId/dir 一律清空，否则 objOf 会把"地点"当宾语，STATE 的宾语种类对不上，assertPlan 会红。
    //   这一步改的是"接敌时的结算"，不是"再打谁一次"——所以它没有敌我宾语。
    if(ops&&ops.length===2&&ops[0]==='ATTACK'&&ops[1]==='CAPTURE_ON'&&
       cmd.action==='ATTACK'&&cmd.foeId){
      // 注记只说一次：b 层在 `unsupported` 里留了一句"活捉：照常攻击…"，那是**给这条命令**的；
      //   摊成两段后两段各带一份，回执上就出现两条几乎一样的话（实测第一版就是这样）。
      //   由真正做这件事的那一段（第二段）说，第一段（攻击）把它摘掉。
      //   摘法是按 `cmd.tactics` 里那条 say 精确比对，不是靠"以活捉开头"这类字面猜。
      const capSay=((cmd.tactics||[]).find(t=>t&&t.key==='capture')||{}).say;
      const rest=(cmd.unsupported||[]).filter(n=>n!==capSay);
      const first=Object.assign({},cmd,{ops:null,unsupported:rest.slice()});
      const second=Object.assign({},cmd,{action:'CAPTURE_ON',ops:null,
        locId:null,dir:null,dist:null,multiLocs:null,
        unsupported:rest.slice()});
      return {steps:[stepOf(first),stepOf(second)]};
    }
    // ── 98 全力冲锋：与活捉同形（2️⃣ 打 ＋ 4️⃣ 开冲锋）────────────────
    // 第二段只带开关：locId/dir 清空，否则 objOf 会把地点当宾语、STATE 对不上（97 同款坑）。
    //   foeId **保留**：STATE 且无 locId 时 objOf 先返回 state， foeId 不干扰形状，
    //   但 d 层要靠它记「目标没了就收场」。
    if(ops&&ops.length===2&&ops[0]==='ATTACK'&&ops[1]==='RUSH_ON'&&cmd.action==='ATTACK'){
      const first=Object.assign({},cmd,{ops:null,unsupported:(cmd.unsupported||[]).slice()});
      const second=Object.assign({},cmd,{action:'RUSH_ON',ops:null,
        locId:null,dir:null,dist:null,multiLocs:null,
        unsupported:(cmd.unsupported||[]).slice()});
      return {steps:[stepOf(first),stepOf(second)]};
    }
    // ── 101 加速行军：「去北桥 ＋ 加速行军」这一句话的两段 ────────────────
    // 与冲锋同形，但**只在本条命令上成立**：档位本身跨命令保留（说一次一直有效），
    //   所以第二段不是"这一次走快些"，而是"把档位打开"——两段同刻下达，
    //   第一段（MOVE/ATTACK）走的时候就已经按 1.2 倍算了。
    // 第二段只带开关：locId/dir/foeId 一律清空，否则 objOf 会把地点/敌人当宾语，
    //   STATE 的宾语种类对不上，assertPlan 当场红（97/98 同款坑）。
    if(ops&&ops.length===2&&ops[0]===cmd.action&&ops[1]==='FORCED_ON'){
      const first=Object.assign({},cmd,{ops:null,unsupported:(cmd.unsupported||[]).slice()});
      const second=Object.assign({},cmd,{action:'FORCED_ON',ops:null,
        locId:null,dir:null,dist:null,multiLocs:null,foeId:null,
        unsupported:(cmd.unsupported||[]).slice()});
      return {steps:[stepOf(first),stepOf(second)]};
    }
    if(ops&&ops.length===2&&ops[0]==='MOVE'&&ops[1]===cmd.action&&
       cmd.locId&&cmd.locId!==U.HERE&&!cmd.foeId&&
       ['DEFEND','ATTACK','CAPTURE'].indexOf(cmd.action)>=0){
      // 96：两段各自一份副本、各自一份 `unsupported`。
      //   摊成两段之后，每一段都会往注记里写自己的话（"未点名部队""已纠正错字"…）。
      //   共用同一个数组的话，第一段的注记会粘到第二段上——回执里出现一句它没做过的事。
      //   `ops` 在副本上清掉：副本是**已经展开过**的段，再展开一次就会长出第三段。
      const first=Object.assign({},cmd,{action:'MOVE',ops:null,
        unsupported:(cmd.unsupported||[]).slice()});
      const second=Object.assign({},cmd,{ops:null,
        unsupported:(cmd.unsupported||[]).slice()});
      return {steps:[stepOf(first),stepOf(second)]};
    }
    return {steps:[stepOf(cmd)]};
  }
  // 多阶段：组合句的每一段是一个阶段，各自一个主谓宾（现在每段都只有一个执行者集合）
  // 102：**每一段也要展开它自己的 ops**。
  //   以前这里只 `stepOf(cmd)`，而 `issueCommand` 根本不认 `cmd.ops`——「枪兵队先去北桥再活捉敌弓兵队」
  //   的第二段只下发了一次普通 ATTACK，`captureMode` 全程 false，回执却写着"打垮那一刻留活口"。
  //   冲锋（RUSH_ON）、加速行军（FORCED_ON）同一条路径，一起中招。
  // 只展开"含同刻开关"的那一类：`MOVE→DEFEND` 这种 d 层原生承接的两段照旧一次下发，
  //   否则一条命令的回执会被拆成两句（96 探针的结论，本轮不改）。
  //   `now` 标在开关段上：它必须和前一段**同一刻**下发，排队等"到位"就变成"打死了再想抓活的"。
  function planOfSteps(cmds){
    const steps=[];
    for(const cmd of cmds){
      const sub=planOf(cmd).steps;
      if(sub.length>1&&sub.some((st,i)=>i>0&&isSwitchStep(st))){
        for(let i=0;i<sub.length;i++){
          if(i>0&&isSwitchStep(sub[i]))sub[i].now=true;
          steps.push(sub[i]);
        }
      } else steps.push(stepOf(cmd));
    }
    return {steps};
  }
  // 一个阶段里的 N 个并行主谓宾：调用方给"谁 + 去哪儿"，这里只保证形状
  function planOfParallel(act,parts){
    return {steps:[{assigns:parts.map(p=>({act:act,subj:(p.ids||[]).slice(),obj:p.obj||null}))}]};
  }
  // 方位词：环位要说话（"合围敌弓兵队：枪兵队守东北侧"）。y 轴向下，所以 sin>0 是南。
  function bearing(dx,dy){
    const i=Math.round(Math.atan2(dy,dx)/(Math.PI/4));
    return ['东','东南','南','西南','西','西北','北','东北'][(i+8)%8];
  }
  // 合围：一个目标、N 支部队、各自一个方位。
  //   宾语不是"那个目标"，是"目标周围的第 i 个点"——这就是它写不成一条 cmd、
  //   只能写成并行主谓宾的原因。谓是 ATTACK（走过去、遇到就打），不是 MOVE：
  //   围上去就是去打仗的，不是去站岗的。
  function planOfRing(ring,center){
    return {steps:[{assigns:ring.map(p=>({act:'ATTACK',subj:[p.unit.id],
      obj:{kind:'loc',x:p.x,y:p.y,name:`${bearing(p.x-center.x,p.y-center.y)}侧`}}))}]};
  }
  // 分兵：按地标数均分（每处至少一支；n<m 时余下的地标不派人）。
  //   5 支 4 座桥不能切成 2/2/1/0——最后一座桥没人守，"分兵守桥"就落空了。
  function splitUnits(list,m){
    const n=list.length,base=Math.floor(n/m),extra=n%m,out=[];
    let at=0;
    for(let i=0;i<m;i++){const size=base+(i<extra?1:0);out.push(list.slice(at,at+size));at+=size;}
    return out;
  }
  // ── 形状断言：加载即跑（跟 assertOps 一个规矩）─────────────────────────
  // 查四件事，都是"结构上就不可能对"的：
  //   ① 没有阶段 / 阶段里没有主谓宾      —— 空计划等于把命令吃掉
  //   ② 谓语不在能力表里                —— c 层没有这条执行路径
  //   ③ 宾语的种类和谓语不配            —— MOVE 带个敌军、"戒备"带个坐标
  //   ④ 同一个阶段里同一支部队被派了两次 —— 后一条会**静默盖掉**前一条，
  //      玩家看到"分兵"两个字，实际只有一半部队动了（分兵最容易踩这个）
  function assertPlan(plan,tbl){
    tbl=tbl||ACTION_CAPS;
    const bad=[],S=(plan&&plan.steps)||[];
    if(!S.length)bad.push('没有阶段（steps 为空）');
    S.forEach((st,i)=>{
      const as=(st&&st.assigns)||[];
      if(!as.length){bad.push(`第 ${i+1} 阶段没有主谓宾`);return;}
      const seen=new Set();
      as.forEach(a=>{
        const caps=a&&tbl[a.act];
        if(!caps){bad.push(`第 ${i+1} 阶段有说不清谓语的项（${a&&a.act}）`);return;}
        if(!Array.isArray(a.subj)){bad.push(`第 ${i+1} 阶段「${a.act}」的主语不是列表`);return;}
        const okk=OP_OBJ[caps.op]||[];
        if(a.obj&&okk.indexOf(a.obj.kind)<0)
          bad.push(`第 ${i+1} 阶段「${a.act}」的宾语是 ${a.obj.kind}，${caps.op} 类只认 ${okk.join('/')||'（无宾语）'}`);
        for(const id of a.subj){
          if(seen.has(id))bad.push(`第 ${i+1} 阶段同一支部队（${id}）被同时指派了两次：后一条会静默盖掉前一条`);
          seen.add(id);
        }
      });
    });
    if(bad.length)throw new Error(`[主谓宾/阶段/并行] ${bad.join('；')}`);
    return {steps:S.length,assigns:S.reduce((n,s)=>n+((s.assigns||[]).length),0)};
  }
  // 启动自检：一条最普通的命令必须能过断言。过不了说明表本身写坏了，
  //   不能等到玩家真说那句话才发现（那时 c 层已经半只脚进了执行器）。
  const PLAN_SELFTEST=assertPlan(planOf({action:'MOVE',unitIds:[]}));
  // 人话：阶段之间用 →，同一阶段的并行项用 ＋。回执和测试都用它，避免各写一套措辞。
  function unitName(id){
    if(api&&api.sim){const u=api.sim.units.find(x=>x.id===id);if(u)return u.name;}
    return id;
  }
  function objText(o){
    if(!o)return '';
    if(o.kind==='foe')return (U.foeName&&U.foeName(o.id))||o.id;
    if(o.kind==='loc'){
      if(o.name)return o.name;
      if(o.id)return (U.landmarkById(o.id)||{}).name||o.id;
      return `第 ${o.x+1} 列、第 ${o.y+1} 行`;
    }
    if(o.kind==='dir')return `向${o.dir}${o.dist?` ${o.dist} 格`:''}`;
    if(o.kind==='unit')return unitName(o.id);
    if(o.kind==='self')return '原地';
    if(o.kind==='home')return '本方后方';
    return '';
  }
  function planText(plan){
    return ((plan&&plan.steps)||[]).map(st=>st.assigns.map(a=>{
      const who=a.subj.length?a.subj.map(unitName).join('、'):'（未点名）';
      const verb=(U.CMD_VERBS&&U.CMD_VERBS[a.act])||a.act;
      const obj=objText(a.obj);
      return `${who}${verb}${obj?' '+obj:''}`;
    }).join(' ＋ ')).join(' → ');
  }

  // ── 入口校验（69）────────────────────────────────────────────────
  //   缺件是正常业务（追问一句就补上了），和接口故障混在一起报，
  //   真正的契约违约会淹在一堆追问日志里，等于没报。
  //   查三类：action 不认识 / 类型不对 / 引用了不存在的实体。
  function cmdValidate(cmd){
    const bad=[];
    if(!cmd||typeof cmd!=='object')return [{code:'NO_CMD',detail:typeof cmd}];
    if(!ACTION_CAPS[cmd.action])bad.push({code:'UNKNOWN_ACTION',detail:String(cmd.action),ch:'—'});
    if(cmd.unitIds!=null&&!Array.isArray(cmd.unitIds))
      bad.push({code:'BAD_UNIT_IDS',detail:typeof cmd.unitIds,ch:ACTION_CAPS[cmd.action]?ACTION_CAPS[cmd.action].ch:'—'});
    const R=(typeof U.registry==='function')?U.registry():{units:[],enemies:[],landmarks:[]};
    const known=(arr,id)=>arr.some(x=>x.id===id);
    // 地标：locId / multiLocs。HERE 是哨兵值，不是地标 id。
    if(cmd.locId&&cmd.locId!==U.HERE&&R.landmarks.length&&!known(R.landmarks,cmd.locId))
      bad.push({code:'DANGLING_LOC',detail:cmd.locId});
    for(const id of (cmd.multiLocs||[]))
      if(R.landmarks.length&&!known(R.landmarks,id))bad.push({code:'DANGLING_LOC',detail:id});
    // 敌军 / 跟随对象：只看注册表里有没有这个 id，不看死活——
    //   阵亡是战场事实（c 层 filter 掉并追问），不是 b 层说错了话。
    if(cmd.foeId&&R.enemies.length&&!known(R.enemies,cmd.foeId))
      bad.push({code:'DANGLING_FOE',detail:cmd.foeId});
    if(cmd.followId&&R.units.length&&!known(R.units,cmd.followId))
      bad.push({code:'DANGLING_FOLLOW',detail:cmd.followId});
    for(const id of (cmd.unitIds||[]))
      if(id!=='ALL'&&R.units.length&&!known(R.units,id))bad.push({code:'DANGLING_UNIT',detail:id});
    return bad;
  }
  // 契约违约的统一回执：说清是哪一类、哪个 id，不静默吞。
  const VIOLATION_CN={
    UNKNOWN_ACTION:'这个动作没有执行方式',BAD_UNIT_IDS:'部队字段不是列表',
    DANGLING_LOC:'提到了图上没有的地点',DANGLING_FOE:'提到了不存在的敌军',
    DANGLING_FOLLOW:'提到了不存在的部队',DANGLING_UNIT:'提到了不存在的部队',NO_CMD:'没有拿到命令'
  };
  function violationText(bad){
    return bad.map(b=>`${VIOLATION_CN[b.code]||b.code}${b.detail?`（${b.detail}）`:''}`).join('；');
  }

  // ── 对外说话的唯二出口（c8 副将的接线点）─────────────────────────
  // c 层只负责"说什么"（结论与事实），"怎么说、什么时候说"交给 c8 副将。
  // 副将缺席时（纯逻辑环境、极小构建）回落到原文案，c 层不依赖 c8 也能跑。
  function adj(){ return (typeof ADJUTANT!=='undefined'&&ADJUTANT&&ADJUTANT.ready())?ADJUTANT:null; }
  // 79：受令部队（供副将把"名字串"压成"全军/三支枪兵"）。只在 issueCommand 里写、
  //   emit 里取用一次就清空——早退路径（追问/校验失败）时它必须是 null，不能带上一条的部队。
  // status 是执行器回来的结论（EXECUTED/PARTIAL/FAILED），fb 是执行器当时的播报。
  // 有副将时按这个结论说话——说"得令"就得真下得去，抗命要说抗命。
  // 地名找不到时，把"为什么找不到"说清楚（2026-10-30 57）。
  //   57 起地名是从地形长出来的：图上没有树林，就没有"树林"这个地标。
  //   这时若只回一句"要去哪里"，玩家会以为是自己没说清，于是换十种说法都不对。
  const PLACE_KIND_CN={forest:'树林',hill:'高地',marsh:'洼地',camp:'营地',base:'本营',bridge:'桥',river:'河'};
  // 87：限定词没命中时要说清是**哪个条件**没命中（"林子里那处营地"而营地都不在林子里）。
  const PLACE_ADJ_CN={forest:'树林里',bridge:'桥边',marsh:'河滩上'};
  function placeHint(cmd){
    if(!cmd)return '';
    // 91：指代没解出来——这与"地名没命中"是两件事，说清楚区别：
    //   前者是"你说的那个，我认不出指哪儿"，后者是"你点的这类地方图上没有"。
    //   混成一句"要驻守哪里"，玩家会以为自己没说清，于是换十种说法都不对。
    if(cmd.pronounMissing)return `你说的「${cmd.pronounMissing}」我认不出指哪儿——请直接说地名。`;
    // 95① 筛空要直说"看不到桥头"，不能笼统说"图上没有高地"（图上有，是条件没命中）。
    if(cmd.placeSight)return '这几处高地都看不到桥头，没有视野更好的一处。';
    if(!cmd.placeMissing)return '';    const k=PLACE_KIND_CN[cmd.placeMissing]||'那类地方';
    if(cmd.placeOwner==='red')return `这张图上目前没有敌人占领的${k}。`;
    if(cmd.placeOwner==='blue')return `这张图上目前没有我方占领的${k}。`;
    if(cmd.placeOwner==='neutral')return `这张图上目前没有中立的${k}。`;
    if(cmd.placeAdj)return `这张图上没有${PLACE_ADJ_CN[cmd.placeAdj]||'那附近'}的${k}。`;
    return `这张图上没有${k}。`;
  }
  // 可选地名列表：地名一多（图上二十多处）一口气列全会撑爆一行，取前 8 个再加省略
  function placeChoices(){
    const all=U.landmarkNames();
    if(!all.length)return '';
    const head=all.slice(0,8).join('、');
    return `可选：${head}${all.length>8?` 等 ${all.length} 处`:''}。`;
  }
  // ── 命令回执的字段契约（79 定，2026-11-02）─────────────────────────────
  // 屏幕和语音都不再从命令层拿整句。以前命令层拼「命令解读：枪兵队、弓兵队 → 禁止过河」，
  //   副将拿正则把箭头换成逗号——那只改得了措辞、改不了语序；更糟的是括号里的技术说明
  //   （「主将实体未实装，暂以将旗部队代理」）会原样落到玩家眼前的屏幕上。
  // 现在命令层只给字段，怎么说归副将。六个字段够表达全部命令：
  //   head  整句抬头（分兵 / 合围），有它就不看 who/act/tgt
  //   who   受令的部队（已编组，如「全军」「三支枪兵」）；自由文案时为空
  //   act   动作短语，不含 who、不含地点（「转入戒备」「向东北推进 3 格」）
  //   tgt   目标或目的地名
  //   parts 明细（分兵、合围用）：['枪兵队去北桥','弓兵队去南桥']
  //   notes 补一句说明，屏幕上用括号显示，语音不念
  function orderOf(o){
    const x=o||{};
    return {
      head : x.head||null,
      who  : x.who||null,
      act  : x.act||'',
      tgt  : x.tgt||null,
      parts: x.parts&&x.parts.length?x.parts.slice():null,
      notes: x.notes&&x.notes.length?x.notes.slice():null,
    };
  }
  // 字符串化：**只给命令日志与排队播报用**，不参与屏幕渲染。
  //   口径与 79 之前的 interp 保持一致，这样日志里的历史数据照样可比。
  function whoStr(w){
    if(!w)return '';
    if(typeof w==='string')return w;
    return w.map(u=>u&&u.name?u.name:String(u)).join('、');
  }
  function orderText(o){
    if(o==null)return '';
    if(typeof o==='string')return o;
    let t;
    if(o.head&&o.parts)t=`${o.head}：${o.parts.join('，')}`;
    else t=whoStr(o.who)+o.act+(o.tgt||'');
    if(o.notes&&o.notes.length)t+=`（注：${o.notes.join('；')}）`;
    return t;
  }
  function emit(src,body,status,fb){
    const a=adj();
    // 79：副将交回的不再是一个字符串，而是一条 Utterance——`screen` 上屏、`text` 交语音。
    //   两者分岔是这一轮的核心（ADJUTANT.md §3.2）：语音要短、屏幕要全，
    //   旧实现只有一个字符串，句子长短由内容决定而不由通道决定，迟早打架。
    // `body` 两种形态：**对象＝命令回执（字段）**，**字符串＝自由文案**（域外、报错、汇报）。
    //   分岔点只在这里，副将靠类型判断，不靠「命令解读：」这种前缀去猜。
    if(a){
      a.deliverOrder(a.receipt(src,body,status,fb));
      return;
    }
    api.ui.echo(`» ${src}\n${typeof body==='string'?body:orderText(body)}`);
  }
  // ── 域外内容的回执（2026-10-30 58 加的，**话术是暂用的，等上司定稿**）──────
  // 只说三件事：这不是命令 / 我听得懂什么 / 没有任何部队被调动。
  //   第三句是必须的：玩家分不清"没执行"和"没听懂"时，会以为兵已经动了而实际上没动。
  // 换文案只改这一处（OFF_TOPIC_TIP 与 offTopicBody），别散到调用点。
  const OFF_TOPIC_TIP='我听两类话：下令（枪兵队去北桥 / 全军向东推进三格 / 兵分两路守两座桥 / 全军戒备），'
    +'问情况（为什么没动 / 各队状态 / 敌人在哪）。';
  function offTopicBody(src){
    return `这句我没接住——「${src}」里没有部队、地点或战场动作，我当它不是在给部队下令。\n`
      +OFF_TOPIC_TIP+`\n没有部队被调动。`;
  }
  function tell(text){               // 不属于某条命令的说明（战局已终、排队播报…）
    const a=adj();
    if(a){ a.deliverOrder(a.remarkU(text)); return; }
    api.ui.echo(text);
  }
  function askTurn(question,src){    // 追问：输入框放短问句，回显放整句
    const a=adj();
    api.ui.ask(a?a.askShort(question):question);
    if(a){ a.deliverOrder(a.askU(question,src)); return; }   // 79：screen 由副将写，这里不再重复 echo
    api.ui.echo(`» ${src}\n${question}`);
  }
  // 部队上下文（真实日志教训：玩家说"到东边森林集合"不点名，预期沿用上一条命令的"所有部队"）。
  // 规则：鼠标刚点选过 → 用选中；否则 → 沿用上一条命令的部队；再不行才用选中/追问。
  let lastSubjects=null;

  // ── CTX：当前任务上下文（84，契约 BC_CONTEXT_TASKBOOK §3.1–3.3）────────────
  // 挂的东西从"上一句话"改成"那件事"：`lastSubjects` 只记得哪几支部队，记不住"去干什么"，
  //   所以「守在那儿」「继续」「追上他」全都接不住。
  // 三条边界：**只有 c 写**、d 不感知、b 只读且拿浅拷贝视图（`ctxView()` 每次现拼）。
  let taskSeq=0;
  const CTX={taskings:[],focus:null};
  // 会变成"一件事"的动作。REPORT/STOP 不算：前者是问话，后者是收摊（它要清掉任务，不是新建）。
  const TASK_KINDS=['MOVE','DEFEND','ATTACK','CAPTURE','RALLY','STANCE_ON','STANCE_OFF','RETREAT','FOLLOW','GUARD_ME'];
  const TASK_FINAL=['done','lost','superseded'];
  // 状态类与跟随类是**持续**的：没有"办完"，只有被覆盖或部队没了。
  const TASK_STICKY=['STANCE_ON','STANCE_OFF','FOLLOW','GUARD_ME'];
  function simUnit(id){return api.sim.units.find(u=>u.id===id)||null;}
  function unitAlive(u){return !!u&&u.hp>0&&!u.isRouted;}
  // phase 的**唯一**推导点（契约 §3.2）。判据全部读 d 层事实，不用时钟——
  //   66 定的时间纪律是"只有一条时间路径"，再引入一套倒计时就是第二套真相。
  //   也不许有 expired：只有"办完了"和"没了"。
  function syncPhase(){
    const LM=api.sim.LANDMARKS||[];
    for(const t of CTX.taskings){
      if(t.phase==='superseded')continue;
      const us=t.units.map(simUnit).filter(Boolean);
      const live=us.filter(unitAlive);
      if(!us.length||!live.length){t.phase='lost';continue;}
      const engaged=live.some(u=>u.targetId&&(simUnit(u.targetId)||{}).hp>0);
      const moving=live.some(u=>u.path&&u.path.length);
      if(TASK_STICKY.indexOf(t.kind)>=0){t.phase=engaged?'engaged':'holding';continue;}
      if(t.kind==='ATTACK'){
        const foe=t.foe?api.sim.enemies.find(e=>e.id===t.foe):null;
        t.phase=(foe&&foe.hp>0)?(engaged?'engaged':'moving'):'done';
        continue;
      }
      if(moving){t.started=true;t.phase=engaged?'engaged':'moving';continue;}
      if(engaged){t.phase='engaged';continue;}
      if(t.kind==='DEFEND'&&live.some(u=>u.hold)){t.phase='holding';continue;}
      if(t.dest&&t.dest.type==='place'){
        const l=LM.find(x=>x.id===t.dest.id);
        if(l&&live.every(u=>Math.abs(u.x-l.x)<=1.5&&Math.abs(u.y-l.y)<=1.5)){t.phase='done';continue;}
      }
      // 走到这里说明没有任何 d 层事实支持"还在动"——发过令就是办完了，没发出去还算刚下单。
      t.phase=t.started?'done':'issued';
    }
  }
  // 记一条任务。**同一批部队的新任务覆盖旧的**（契约 §3.2 superseded）：
  //   不覆盖的话，「继续」会拿到一条早就被新命令顶掉的老任务。
  function noteTasking(cmd,list,lm,src){
    const i=TASK_KINDS.indexOf(cmd.action);
    if(i<0)return;
    const ids=list.filter(u=>u.hp>0&&!u.isRouted).map(u=>u.id);
    if(!ids.length)return;
    for(const t of CTX.taskings)
      if(TASK_FINAL.indexOf(t.phase)<0&&t.units.some(id=>ids.indexOf(id)>=0))t.phase='superseded';
    const dest=lm?{type:'place',id:lm.id}:(cmd.locId?{type:'place',id:cmd.locId}:null);
    const t={id:'T'+(++taskSeq),seq:taskSeq,kind:cmd.action,units:ids,
      dest:dest,foe:cmd.foeId||null,phase:'issued',
      src:{text:src||'',logN:CMD_LOG.length},
      derivedFrom:cmd.derivedFrom||null,
      createdAt:api.sim.simTime,updatedAt:api.sim.simTime,started:false};
    CTX.taskings.push(t);
    CTX.focus=t;
    // 只留最近 20 条：任务列表是上下文，不是档案（档案在命令日志里）。
    if(CTX.taskings.length>20)CTX.taskings=CTX.taskings.slice(-20);
  }
  // 撤销/取消时把受影响的任务标掉：不清掉的话，下一句「继续」会把它复活（契约 §3.6）。
  function dropTasks(ids){
    for(const t of CTX.taskings)
      if(TASK_FINAL.indexOf(t.phase)<0&&t.units.some(id=>ids.indexOf(id)>=0))t.phase='superseded';
  }
  function lastLiveTask(){
    syncPhase();
    for(let i=CTX.taskings.length-1;i>=0;i--)
      if(TASK_FINAL.indexOf(CTX.taskings[i].phase)<0)return CTX.taskings[i];
    return null;
  }
  // b 层只看这个：浅拷贝，改不动 c 的状态。
  function ctxView(){
    syncPhase();
    const f=CTX.focus;
    const cp=t=>t?{id:t.id,kind:t.kind,units:t.units.slice(),
      dest:t.dest?Object.assign({},t.dest):null,foe:t.foe,phase:t.phase}:null;
    return {taskings:CTX.taskings.map(cp),focus:cp(f)};
  }
  function taskLabel(t){
    if(!t)return '';
    const names=t.units.map(id=>{const u=simUnit(id);return u?u.name:id;}).join('、');
    const place=t.dest&&t.dest.type==='place'?U.landmarkById(t.dest.id):null;
    const foe=t.foe?U.foeName(t.foe):null;
    return `${names}${U.CMD_VERBS[t.kind]||''}${place?place.name:(foe||'')}`;
  }
  // 「撤销上一条」—— 必须在 b 层之前截住：`撤` 字命中 RETREAT 词表，
  //   以前玩家说要撤销，部队真的就撤退了（契约 §3.6 点名的高危误读）。
  //   只认"撤销 + 上一条"这种**整句**说法，不碰普通的「取消」（那是 STOP，另行清账）。
  const REVOKE_RE=/^(撤销|撤回|作废|取消)(掉)?(上一条|上一道|上一条命令|刚才那条|刚才那条命令|刚才的命令|上条)(命令)?$/;
  const REVOKE_RE2=/^(刚才那条|刚才|上一条|上条)(不算|作废|不要了|撤回)/;

  // ── 修正上一条（85，契约 §3.6）────────────────────────────────────
  // 「不对，是南桥」＝**撤回上一条、改执行新的**，回执点名撤了什么、改成什么。
  // 只认句首的修正语：句中随便一个"不是"（"不是那座桥，是这座"也算改，但"他们不是敌人"不是命令）
  //   都会把闲聊接成改令，所以收成整句式，且后面必须真的能落到地点/目标上才动手。
  const REVISE_RE=/^(不对|不是|错了|说错|我说错|我是说|我是想|改成|改为|换成|应该是|应当是|而是|换个|换一个)/;
  // 修正只改一处：地点（去/守/占）或目标（打）。动作沿用上一条——
  //   玩家说"不对，是南桥"时，他改的是**去哪儿**，不是"改成什么都不做"。
  let revising=false;   // 防重入：改令内部会再走一遍 submitText

  // ── 追问对话状态机 ──
  // 只挂一条待补全命令。玩家回答缺的那一件即可：
  //   · 回答本身带动作词 → 当成一条新命令重新解析；说"取消"放弃；
  //   · 回答编号（"2"/"第二个"）→ 从本轮追问的编号选项里取；
  //   · 容错：问目标时答裸兵种（"弓兵"）指向敌方那一支；问地点时答类别（"桥"）
  //     命中多座就带编号重问"1.北桥 2.南桥"，而不是报"没听懂"。
  let cmdPending=null;   // {cmd, question, src, options:[{id,label}] | null, chain:[cmd] | null}
  function cmdClarify(cmd,question,src,options){
    cmdPending={cmd,question,src,options:options||null,chain:cmdPending&&cmdPending.chain||null};
    askTurn(question,src);   // 79：上屏由副将的 screen 负责，这里不再二次 echo
  }
  function cmdReAsk(question,options){   // 同一个对话里换一批候选（如"桥"→两座桥），不另记日志
    cmdPending.question=question;cmdPending.options=options;
    askTurn(question,cmdPending.src);
  }
  function cmdClearPending(){cmdPending=null;api.ui.clearAsk();}

  function submitText(raw){
    const src=(raw||'').trim();
    if(!src)return;
    const sim=api.sim,ui=api.ui;
    // 训练记录（?rec=1 时才存在这个钩子）：在**最外层入口**开一条记录，
    //   之后 b 层解析与最终结果各自补进同一条。钩子不存在时零成本。
    if(api.rec)api.rec('in',{text:src,t:sim.simTime});
    if(sim.result){tell('战斗已结束，刷新页面可再来一局。');cmdLogCommit({at:sim.simTime,text:src,status:'FAILED',interp:'',feedback:'战斗已结束'});ui.flush();return;}
    // ── 域外内容（2026-10-30 58，**暂用话术，等定稿**）────────────────────
    // 判据在 b 层 U.isOffTopic：这句话里一个战场成分都没有（部队/地点/军令动作/方位/距离…）。
    // 这里只管怎么说话。它和"没听懂"必须分开：
    //   没听懂 = 你在下令，但我缺件 → 进追问态，等你补；
    //   域外   = 这不是命令       → **不进追问态**，否则下一句会被当成答案吞掉。
    // 两处**必须让路**给追问的应答语法（否则"2"和"算了"会被当成无关内容）：
    //   正在等追问时，编号（"2"/"第二个"）和取消（"算了"）不是新命令，是回答。
    const answering=!!cmdPending&&(/^(取消|算了|不用了|放弃)/.test(src)||!!U.numberAnswer(U.cmdNorm(src)));
    if(!answering&&U.isOffTopic(src)){
      // 域外也要进记录：这是训练集里最坏的一类（把命令当闲话＝没收玩家一句话），
      //   不能被"没走解析"这个实现细节漏掉。
      if(api.rec)api.rec('b',{text:src,parsed:{offTopic:true,cmd:{action:null,unitIds:[],foeId:null,locId:null,unsupported:[]},clarification_required:false}});
      // 已经在等追问时说了句无关的话：**不取消**那条命令，追问原样挂着，只在回执里提一句。
      const waiting=cmdPending?`\n（刚才那句还在等你补：${cmdPending.question}）`:'';
      emit(src,offTopicBody(src)+waiting,'OFFTOPIC');
      cmdLogCommit({at:sim.simTime,text:src,status:'OFFTOPIC',interp:'',feedback:'与战场无关，未作为命令'});
      ui.flush();return;
    }
    // 问答通道：玩家在问"为什么没动"这类问题，不是在下令。逐队报告状态与上次停下的原因。
    if(U.isQuestion(src)){
      // 83：问的是**敌方**（「敌人在哪」「敌情如何」）就走敌情汇报。
      //   为什么必须在这条分支里也判一次：问句在 c 层是**早退**的，根本不进 switch 的 REPORT 分支——
      //   只在 switch 里加，玩家看到的还是"我军都待命"（第一版就这么漏的）。
      const qc=U.parse(src).cmd;
      if(qc&&qc.reportFoe){
        const n=deliverFoeReport(src);
        cmdLogCommit({at:sim.simTime,text:src,status:'EXECUTED',interp:'询问敌情',feedback:`回答了 ${n} 条目击`,followUp:false});
        ui.flush();return;
      }
      // 87：**战地问答也必须在早退分支里接**——问句根本不进 switch 的 REPORT 分支。
      //   83 的敌情问答就是在这里漏过一次（只在 switch 里加，玩家看到的仍是"我军都待命"）。
      if(qc&&qc.mapAnswer){
        emit(src,qc.mapAnswer);
        cmdLogCommit({at:sim.simTime,text:src,status:'EXECUTED',interp:'战地问答',feedback:qc.mapAnswer,followUp:false});
        ui.flush();return;
      }
      const rows=sim.statusReport();
      const lines=rows.map(r=>`${r.name}：${r.state}${r.advancing?`（正在向${r.advancing}推进）`:''}${r.lastStopReason?`（上次停下：${r.lastStopReason}）`:''} · 生命 ${r.hp}/${r.maxHp} · 士气 ${r.morale}`);
      // 副将在线就由他用自己的话汇报态势；没有副将时回落到原来的字段式输出
      const a=adj();
      if(a){
        // 79：REPORT 自成一类（`REPORT`），不是命令回执——绝不能说"得令"。
        //   text 是一句摘要（"3 支都在按令行事"），screen 是逐队明细。
        const u=a.reportU(rows);
        u.screen+='\n（这是回话，不是命令；要下令请直接说动作。）';
        a.deliverOrder(u);
      }else{
        emit(src, `${lines.length?lines.join('\n'):'（已无存活部队）'}\n（我在回答问题，这不是命令；要下令请直接说动作。）`);
      }
      cmdLogCommit({at:sim.simTime,text:src,status:'EXECUTED',interp:'询问',feedback:`回答了 ${lines.length} 支部队的状态`});
      ui.flush();return;
    }
    // ── 撤销上一条（84）──────────────────────────────────────────────
    // 必须在这里截住，不能等到 b 层：`撤` 字会命中 RETREAT 词表，
    //   以前「撤销上一条」的结果是**部队真的撤退**（契约 §3.6 点名的高危误读）。
    // 只认整句式的"撤销 + 上一条"；裸「取消」仍走 STOP（那是让部队停下，不是撤令）。
    {
      const rv=U.cmdNorm(src);
      if(REVOKE_RE.test(rv)||REVOKE_RE2.test(rv)){
        const t=lastLiveTask();
        if(!t){
          const msg='没有可撤销的命令——上一条已经办完，或者还没下过令。';
          tell(msg);
          cmdLogCommit({at:sim.simTime,text:src,status:'FAILED',interp:'',feedback:msg});
          ui.flush();return;
        }
        const us=t.units.map(simUnit).filter(Boolean);
        // 顺序要紧：**先标任务、再停部队**。
        //   反过来的话，`stopUnits` 会清掉 path，`syncPhase()` 立刻把这条任务推成 `done`
        //   （"发过令、现在没在动"＝办完了），于是 dropTasks 因为它是终态而跳过——
        //   结果这条任务永远留着 done，下一句「继续」看不出它其实是被撤掉的。
        dropTasks(t.units);
        sim.stopUnits(us);
        CTX.focus=null;
        const said=`已取消：${taskLabel(t)}`;
        tell(said);
        cmdLogCommit({at:sim.simTime,text:src,status:'CANCELLED',interp:said,feedback:said});
        ui.flush();return;
      }
    }
    // ── 修正上一条（85）：「不对，是南桥」────────────────────────────────
    // 与"撤销"的区别：撤销是**不要了**，修正是**要，但换个地方/换个目标**。
    // 判断次序刻意放在撤销之后、待补全追问之前：
    //   ① 撤销有整句式词表，先让位给它；
    //   ② 追问挂起时玩家最常说的就是"不对，是X"，放后面会被当成补充答案吞掉。
    if(!revising){
      const rv=U.cmdNorm(src);
      const hit=REVISE_RE.exec(rv);
      if(hit){
        const focus=lastLiveTask();
        if(focus){
          // 剥掉修正语，剩下的是新宾语；"是/去/到/往"这类连接字也一并剥
          let rest=rv.slice(hit[0].length).replace(/^[，,。、\s]+/,'')
            .replace(/^(是|成|为|去|到|往|在|就|要)/,'');
          // 反问句不算改令：「不是让你守北桥吗」剥完剩下"让你守北桥吗"，
          //   它照样能认出地点，照着改就成了一条凭空的多余命令。
          if(rest&&!/[吗呢么？?]/.test(rest)){
            const p=U.parse(rest);            // 只借它认地点/目标，动作以上一条为准
            const newLoc=p&&p.cmd?p.cmd.locId:null;
            const newFoe=p&&p.cmd?p.cmd.foeId:null;
            const kind=focus.kind;
            const coverAll=(()=>{
              const live=sim.units.filter(u=>u.hp>0&&!u.isRouted);
              return live.length&&live.every(u=>focus.units.indexOf(u.id)>=0);
            })();
            const who=coverAll?'全军':focus.units.map(id=>{const u=simUnit(id);return u?u.name:id;}).join('、');
            let newText=null,newName=null;
            if(newFoe&&(kind==='ATTACK'||kind==='FOLLOW')){
              newName=U.foeName(newFoe);newText=`${who}攻击${newName}`;
            }else if(newLoc){
              const lm=U.landmarkById(newLoc);
              const verb=U.CMD_VERBS[kind]||U.CMD_VERBS.MOVE;
              if(lm){newName=lm.name;newText=`${who}${verb}${lm.name}`;}
            }
            if(newText){
              // 先标任务作废、再停部队（顺序同撤销：停了会被 syncPhase 判成 done），最后下单
              const us=focus.units.map(simUnit).filter(Boolean);
              dropTasks(focus.units);
              sim.stopUnits(us);
              const said=`已撤掉${taskLabel(focus)}，改${newName}`;
              tell(said);
              const before=CMD_LOG.length;
              revising=true;
              let r=null;
              try{ r=submitText(newText); } finally { revising=false; }
              // 命令日志里记**玩家原话**：历史要能对上他说的那句，不能只留改写后的命令
              const row=CMD_LOG[CMD_LOG.length-1];
              if(row&&CMD_LOG.length>before)row.text=src;
              return r;
            }
          }
        }
      }
    }
    if(cmdPending){
      if(/^(取消|算了|不用了|放弃)/.test(src)){
        const s=cmdPending.src;cmdClearPending();tell(`已放弃命令「${s}」。`);
        cmdLogCommit({at:sim.simTime,text:src,status:'CANCELLED',interp:s,feedback:'放弃待补全命令'});
        ui.flush();return;
      }
      const t=U.cmdNorm(src);
      // 看着像在下令就当成一条新命令（任何长度都要算——"所有部队到东面森林"曾被当补充吞掉过）。
      //   58 起从 hasActionWord 放宽到 looksLikeCommand：短口令（"冲""跟我来""向左"）
      //   没有正规动作词，但玩家显然在下令；判成"补充没听懂"等于把他的命令吃掉。
      //   "原地/待命"在 looksLikeCommand 里被排除——它们是追问地点时最该被当答案接住的词。
      if(U.looksLikeCommand(t)){cmdClearPending();dispatchOrClarify(src,false);return;}
      const missing=cmdPending.cmd.__missing;
      // 62：矛盾类追问**没有缺的槽**（missing=null，见 b 层 selfConflict）。
      //   玩家怎么答都是在把这句话说成一条成立的新命令（"那就撤到北桥"/"不撤了"），
      //   所以直接当新命令重解析；绝不能落到 fillAndRun 的 else 分支——
      //   那里会把他的回答当成 foeId（"撤到北桥"被塞进敌人 id，命令连执行的机会都没有）。
      if(!missing){cmdClearPending();dispatchOrClarify(src,false);return;}

      // 编号应答："2"/"第二个" → 直接取本轮追问的选项
      const num=U.numberAnswer(t);
      if(num&&cmdPending.options&&cmdPending.options[num-1]){
        const id=cmdPending.options[num-1].id;
        fillAndRun(missing,missing==='unit'?[id]:id,src,`选择 ${num}. ${cmdPending.options[num-1].label}`);
        return;
      }
      const got=U.extractAnswer(src,missing,knownFoes().map(f=>f.id));
      // 追问应答也要记：这是最容易错的一段（它不经过 U.parse，走的是 extractAnswer）。
      if(api.rec)api.rec('b',{text:src,answer:{missing,got:got?(got.reAsk?{reAsk:got.reAsk.hits.map(l=>l.id)}:got.value):null}});
      if(!got){
        const q=cmdPending.question;
        tell(`没听懂这句补充。${q}`);
        cmdLogCommit({at:sim.simTime,text:src,status:'FAILED',interp:'',feedback:`补充没听懂：${q}`});
        ui.flush();return;
      }
      if(got.reAsk){
        // 答了统称（如"森林"）但命中多处：带着编号重问，同一个对话继续
        cmdReAsk(`要哪一处：${U.numbered(got.reAsk.hits.map(l=>l.name))}？`,
          got.reAsk.hits.map(l=>({id:l.id,label:l.name})));
        ui.flush();return;
      }
      fillAndRun(missing,got.value,src,null);
      return;
    }
    dispatchOrClarify(src,false);
  }
  function fillAndRun(missing,value,src,how){
    const ui=api.ui;
    const c=cmdPending.cmd,orig=cmdPending.src,tail=cmdPending.chain||null;
    if(missing==='unit')c.unitIds=Array.isArray(value)?value:[value];
    else if(missing==='location')c.locId=value;else c.foeId=value;
    cmdClearPending();
    // 96：补全后的执行也走唯一入口。「补出来的地点/部队 + 原本排在后面的段」＝
    //   一张由玩家明说几件事组成的计划，所以 explicit（每段都要真发生一次）。
    const out=execPlan(planOfSteps([c].concat(tail||[])),`${orig}（补充：${src}）`,
      {explicit:true,followUp:true});
    cmdLogCommit({at:api.sim.simTime,text:src,status:out.status,interp:out.interp,feedback:out.feedback,
      followUp:true,mergedFrom:orig,queued:out.staged||0,how});
    ui.flush();
  }

  // ── 组合句（"先X再Y" 拆段排队）──
  // 切分在 b 层（splitSegments）；继承（后段沿用前段的部队/地点/目标）与"哪些动作可排队"
  // 是 c 层的可执行性知识：中间段必须是能判"到位"的动作，其余只能当最后一段；
  // 任何一段无法理解 → 整条不执行并说明是第几段、为什么（不静默跳段）。
  const CHAINABLE=['MOVE','DEFEND','CAPTURE','RALLY'];
  function parseChain(raw){
    // 78：有条件的句子先按"条件结构"拆（语言归 b 层，c 层不认中文）。
    //   认得出条件却换不成触发的（ok:false），整条不执行，并指名是哪一句说不成——
    //   这比笼统回一句"条件指令没实现"有用：玩家知道该换个说法。
    const pc=U.parseCondition?U.parseCondition(raw):null;
    if(pc&&!pc.ok)return {ok:false,seg:pc.seg||1,reason:pc.reason};
    let items;
    if(pc&&pc.ok){
      items=pc.pre.map(t=>({text:t}));
      items.push({text:pc.mainText,when:pc.cond,condText:pc.condText});
    }else{
      const segs=U.splitSegments(raw);
      if(!segs)return null;
      items=segs.map(t=>({text:t}));
    }
    const cmds=[];let inherit=null;
    for(let i=0;i<items.length;i++){
      const parsed=U.parse(items[i].text);
      // 组合句里夹了一段无关内容（"先报告再今天天气怎么样"）：整条不执行，但要指名是第几段，
      //   不能报"第 2 段无效"却让玩家以为是战术没听懂。
      if(parsed.offTopic)return {ok:false,seg:i+1,reason:'这段和战场无关（没有部队、地点或动作）'};
      // 83：带槽位的歧义**不再把整条扔掉**。以前这里直接 return，后面那句
      //   「等我喊冲再冲」跟着一起没了——玩家答完"南桥"，命令已经蒸发，只能从头重说。
      //   现在歧义在**第一段**且后面还有能解析的段时，改成挂着等答，答完前后段一起下发
      //   （复用 fillAndRun 已有的 chain：它本来就是"答完把剩下几段接着发"的机制）。
      //   歧义不在第一段、或后面那段自己也要追问/不是动作时，仍然整条不办——
      //   前段已经拆好却没执行，硬接回去等于让"先X再Y"的顺序在补答那一刻重排。
      if(parsed.clarification_required){
        if(parsed.missing&&i===0&&items.length>1){
          const tailCmds=[];
          for(const t of items.slice(1)){
            const p2=U.parse(t.text);
            if(p2.clarification_required||p2.offTopic||!p2.cmd||!p2.cmd.action){tailCmds.length=0;break;}
            if(t.when)p2.cmd.when=t.when;
            tailCmds.push(p2.cmd);
          }
          if(tailCmds.length)
            return {ok:false,seg:i+1,reason:parsed.assistantQuestion,
              clarify:{cmd:parsed.cmd,missing:parsed.missing,question:parsed.assistantQuestion,
                options:parsed.options||null,tailCmds}};
        }
        return {ok:false,seg:i+1,reason:parsed.assistantQuestion};
      }
      const c=parsed.cmd;
      if(items[i].when)c.when=items[i].when;
      if(!c.unitIds.length&&inherit&&inherit.unitIds.length)c.unitIds=inherit.unitIds.slice();
      // 90：**打了谁就不继承地点**。「主将队去北桥，骑兵队去打敌弓兵队」的第二段
      //   若把前一段的 BR_N 继承过来，plan 里就成了"移动到敌人身上"那种自相矛盾的宾语组合：
      //   ATTACK 的宾语由 foeId 定，locId 是多出来的、会和"去打"打架。
      //   继承的本意是补"下一段没说清的去哪"，而说了要打谁的时候，去哪已经由猎物决定了。
      if(!c.locId&&inherit&&inherit.locId&&!(c.action==='ATTACK'&&c.foeId))c.locId=inherit.locId;
      if(!c.foeId&&inherit&&inherit.foeId)c.foeId=inherit.foeId;
      cmds.push(c);inherit=c;
    }
    // 带条件的段：受令部队必须**现在**定下来（谁在等），不能等到条件成立那一刻再按画面挑人——
    //   到那时玩家看的是另一个角落，等的人和动手的人会变成两拨。
    for(const c of cmds)
      if(c.when&&c.when.kind!=='arrived'&&!(c.unitIds&&c.unitIds.length))
        c.unitIds=subjectsFor(c).map(u=>u.id);
    // 「看到敌主将才发动进攻」这句话**没有宾语**——宾语就是"眼前那支"。
    //   不带 nearScope 的话，条件成立那一刻会回一句"打哪一支"，前面等的全白等。
    //   只在带条件的段上这么做：无条件句里"攻击"仍照旧追问，那才是有信息量的一问。
    for(const c of cmds)
      if(c.when&&c.when.kind!=='arrived'&&c.action==='ATTACK'
        &&!c.foeId&&!c.locId&&!c.dir&&!c.arrow){
        c.nearScope=true;
        // 条件说的是"看到谁"，动手时打的就是那个谁——不是眼前随便一支。
        //   "看到敌主将才发动进攻"打的是主将（斩首），"看到敌人就打"打的是看得见的那支。
        //   判据留在 b 层给的条件里，c 层只负责照它去认人。
        if(c.when.kind==='sight')c.autoTarget=c.when.who==='commander'?'commander':'foe';
      }
    // 压制：句子里明说了"遇到普通敌人不攻击"。它和"埋伏"是同一件事的两种说法，
    //   一起落到第一个阶段——伏着不动，等条件。不落到条件那个阶段：那一段本身就是要动手的。
    if(pc&&pc.ok&&pc.suppress&&!cmds[0].suppress)
      cmds[0].suppress={engage:'none',why:'按你说的，不主动接敌'};
    // 中间段能不能当中间段：下一段若带非 arrived 的触发，"到位"就不再是放行条件，
    //   任何动作都能当中间段（"打完就回去守着"——打完了自然结束，不必有"到位"这一说）。
    for(let i=0;i<cmds.length-1;i++){
      const nxt=cmds[i+1].when;
      if(nxt&&nxt.kind!=='arrived')continue;
      if(!CHAINABLE.includes(cmds[i].action))
        return {ok:false,seg:i+1,reason:`「${U.CMD_VERBS[cmds[i].action]||cmds[i].action}」不能用在组合句中间，只有移动/驻守/占领/集结可以排队`};
    }
    return {ok:true,cmds,single:cmds.length===1};
  }
  function chainInterp(cmds){
    const arr=Array.isArray(cmds)?cmds:((cmds&&cmds.cmds)||[]);
    return arr.map(c=>{
      // 攻击段显示目标，不显示继承来的地点。
      //   没点名目标时（78 的 nearScope / autoTarget：目标由条件或射程决定），
      //   U.foeName(空) 会返回 null —— 直接拼就是「攻击 null」，不能出层。
      if(c.action==='ATTACK'){
        const nm=c.foeId?U.foeName(c.foeId):'';
        // 90：中文和中文之间不留空格。"攻击 敌弓兵队"是英文排版习惯，
        //   在排队播报里连读会断一下（"再攻击  敌弓兵队"）。
        if(nm)return `攻击${nm}`;
        return c.autoTarget==='commander'?'打敌主将':'攻击近处敌军';
      }
      const verb=U.CMD_VERBS[c.action]||c.action;
      // __HERE__ 是"脚下这块地"的哨兵值，不是地名。漏出来玩家会看见一串下划线
      //   （「驻守 __HERE__」）——排队播报是给玩家看的，内部常量一个都不许出层。
      if(c.locId===U.HERE)return `${verb}脚下`;
      const nm=c.locId?((U.landmarkById(c.locId)||{}).name||c.locId):'';
      return verb+nm;
    }).join('，再');
  }
  // ── 队列（78）：一个计划，逐段放行 ──────────────────────────────────────
  // 以前队列是"扁平 cmds[] + idx"，能不能进下一段只看**上一段到位没有**。
  // 现在队列就是一张 plan：进下一段的条件由 step.when 决定，arrived 只是它的默认值。
  // 为什么非要搬进 plan：不搬的话，每加一种触发都要在"队列"和"plan"两套系统里各写一遍；
  //   而 plan 迟早要成为唯一执行入口（ops[] 那轮），搬一次总比写两遍便宜。
  // 生命期（上司 2026-11-02 定）：**没有超时**。挂着就是挂着，只在三种情况消失——
  //   条件成立、被新命令覆盖、部队阵亡/溃散。代价是可能出现部队整局蹲着，所以面板必须写清在等什么。
  let activeQueue=null;   // {plan, idx, src, since, noticed, armedIdx}
  function stepSubjects(st){
    const out=[];
    for(const a of (st&&st.assigns)||[])for(const id of a.subj||[]){
      // 'ALL' 是哨兵值不是 id：不展开的话，"全军在等"会被判成"没人在等"，
      //   队列当场被 deadEnd 收掉——兵还在走，界面说排队停了。
      if(id==='ALL'){for(const u of api.sim.units)if(out.indexOf(u.id)<0)out.push(u.id);continue;}
      if(out.indexOf(id)<0)out.push(id);
    }
    return out;
  }
  function stepUnits(st){
    return stepSubjects(st).map(id=>api.sim.units.find(u=>u.id===id)).filter(Boolean);
  }
  // 谁在"看"：上一段的部队（设伏的那几支）。第一段前面没有人，就是这一段自己的部队。
  function watchIds(q){
    const prev=q.plan.steps[q.idx-1];
    return stepSubjects(prev||q.plan.steps[q.idx]);
  }
  const ARRIVED_STATES=['待命','驻守','集结待命','埋伏'];
  function stepArrived(st){
    const list=stepUnits(st).filter(u=>u.hp>0);
    if(!list.length)return true;
    return list.every(u=>!u.isRouted&&!u.path.length&&ARRIVED_STATES.includes(u.state));
  }
  function condText(w){
    if(!w||w.kind==='arrived')return '上一段到位';
    if(w.kind==='elapsed')return `再过 ${w.sec} 秒`;
    if(w.kind==='foeDown')return `${(U.foeName&&U.foeName(w.foeId))||w.foeId} 被歼灭`;
    if(w.kind==='sight')return w.who==='commander'
      ? `${w.dist?`${w.dist} 格内`:'视野内'}出现敌主将`
      : `${w.dist?`${w.dist} 格内`:'视野内'}出现敌军`;
    return '条件';
  }
  function gateOpen(q){
    const st=q.plan.steps[q.idx];
    if(!st)return true;
    const w=st.when||{kind:'arrived'};
    if(w.kind==='arrived')return q.idx===0?true:stepArrived(q.plan.steps[q.idx-1]);
    if(w.kind==='elapsed')return api.sim.simTime-q.since>=(w.sec||0);
    // 真假只在 d 层算：它有位置、视野和敌人。c 层算不出来，也不该算。
    return api.sim.condMet(w,watchIds(q),q.since);
  }
  // 等不到的情形（这不是超时）：人等没了、敌人等没了。必须立刻说，
  //   否则队列永远挂着、面板还写着"在等"——那是另一种 SILENT_STEP。
  function deadEnd(q,w){
    if(w.kind!=='sight')return null;
    const watch=watchIds(q).map(id=>api.sim.units.find(u=>u.id===id)).filter(Boolean);
    if(!watch.filter(u=>u.hp>0&&!u.isRouted).length)return '等的部队已经阵亡或溃散了';
    if(!api.sim.enemies.filter(e=>e.hp>0&&!e.isRouted).length)return '敌军已经全歼，这个条件不会成立了';
    return null;
  }
  function armQueue(plan,src){
    const q={plan:plan,idx:0,src:src,since:api.sim.simTime,noticed:false,armedIdx:-1};
    activeQueue=q;
    // 一支兵都没有的"挂着等"是没有意义的：界面会显示一条在等的命令，实际没人听。
    if(!watchIds(q).length){activeQueue=null;return false;}
    syncArmed(q);return true;
  }
  // 受令部队的"预解析"：只在**挂起**时用（等的那个人要在挂起那一刻定下来）。
  //   与 issueCommand 的主语优先级同序（点名 → 选中 → 上一条 → 画面内），但**不产生副作用**：
  //   它不改选中、不写注记、不追问。受令集合最终仍由 issueCommand 在真正发出那一刻定。
  //   为什么必须预解析：条件成立之前要回答"谁在等"——面板、视野归属、阵亡检测都靠这个人名单。
  function subjectsFor(cmd){
    if(cmd.unitIds&&cmd.unitIds.length)return cmdResolveUnits(cmd);
    if(api.ui&&api.ui.liveSelection){const s=api.ui.liveSelection();if(s&&s.length)return s;}
    if(lastSubjects&&lastSubjects.length)return lastSubjects.slice();
    return unitsInView();
  }
  // 把"在等什么"写到部队身上（面板读它）。换段/结束时必须**清掉**，
  //   否则面板会一直写着上一段的条件——那正是 SILENT_STEP 的另一面：看着像在等，其实早不等了。
  function syncArmed(q){
    if(!q){api.sim.setArmed(null,null);return;}
    if(q.armedIdx===q.idx)return;
    const st=q.plan.steps[q.idx];
    const w=st&&st.when;
    const list=watchIds(q).map(id=>api.sim.units.find(u=>u.id===id)).filter(Boolean);
    if(w&&w.kind!=='arrived')api.sim.setArmed(list,{text:condText(w),since:q.since,cond:w});
    else api.sim.setArmed(list,null);
    q.armedIdx=q.idx;
  }
  function dropQueue(msg){
    if(!activeQueue)return;
    api.sim.setArmed(null,null);
    if(msg)api.sim.toast(msg);
    activeQueue=null;
  }
  function tickQueue(){
    if(!api||!api.sim)return;
    if(api.sim.result){dropQueue(null);return;}
    const q=activeQueue;
    if(!q)return;
    if(q.idx>=q.plan.steps.length){
      // 最后一段是可判到位的动作，就等它到位再收队（与旧口径一致）；
      //   是攻击这类"发完即完"的，发令那一刻就收。
      const prev=q.plan.steps[q.idx-1];
      const pa=prev&&prev.cmd?prev.cmd.action:null;
      if(pa&&CHAINABLE.includes(pa)&&!stepArrived(prev))return;
      dropQueue('排队的命令已全部执行完毕。');return;
    }
    syncArmed(q);
    const st=q.plan.steps[q.idx];
    const w=st.when||{kind:'arrived'};
    if(!gateOpen(q)){
      const why=deadEnd(q,w);
      if(why){dropQueue(`排队停止：${why}`);return;}
      // 等太久**不取消**，但要提醒一次：不然十分钟后没人记得兵还在等。
      if(w.kind!=='arrived'&&!q.noticed&&api.sim.simTime-q.since>=30){
        q.noticed=true;
        api.sim.toast(`仍在等待：${condText(w)}（已挂 ${Math.round(api.sim.simTime-q.since)} 秒）。`);
      }
      return;
    }
    q.idx++;
    q.since=api.sim.simTime;
    q.noticed=false;
    api.sim.setArmed(null,null);
    const out=issueStep(st,`${q.src}（排队第 ${q.idx} 段自动执行）`);
    // 102：紧跟着的"同刻开关段"（活捉/冲锋/加速）不进排队，发完这一段立刻跟上。
    //   它等的是"打起来的那一刻"，排队等"到位"就变成打死了再想起来抓活的。
    while(q.idx<q.plan.steps.length&&q.plan.steps[q.idx].now&&!q.plan.steps[q.idx].when){
      const sw=q.plan.steps[q.idx];
      q.idx++;
      q.since=api.sim.simTime;
      issueStep(sw,`${q.src}（第 ${q.idx} 段，同刻）`);
    }
    if(out.status==='CLARIFY'){
      tell(`排队命令缺少信息，已停下：${out.feedback}`);
      dropQueue(null);return;
    }
    if(out.status==='FAILED'||out.status==='UNSUPPORTED'){
      // 这一段没成，后面的段就悬空了（"到了再守"——没到守什么）。停下并说清是第几段，
      //   不接着发：接着发等于让玩家以为整条命令都照着做了。
      dropQueue(`排队在第 ${q.idx} 段停下：${out.feedback||'这一段没能执行'}`);
      return;
    }
    if(q.idx>=q.plan.steps.length){
      const a=st.cmd?st.cmd.action:null;
      if(!a||!CHAINABLE.includes(a))dropQueue('排队命令已全部下达。');
    }
  }
  // 发一个阶段。现在每一段都带扁平 cmd（b 层产出），所以走的就是那条唯一执行入口；
  //   没有 cmd 的段（将来 ops[] 直接产出的计划）按主谓宾合成最小命令，不另开一条执行路径。
  function issueStep(st,src){
    if(st.cmd)return issueCommand(st.cmd,src);
    let out={status:'FAILED',interp:'',feedback:'空计划'};
    for(const a of st.assigns||[]){
      const c={action:a.act,unitIds:(a.subj||[]).slice()};
      const o=a.obj;
      if(o){
        if(o.kind==='foe')c.foeId=o.id;
        else if(o.kind==='loc')c.locId=o.id||U.HERE;
        else if(o.kind==='dir'){c.dir=o.dir;c.dist=o.dist;}
        else if(o.kind==='unit')c.followId=o.id;
      }
      out=issueCommand(c,src);
    }
    return out;
  }

  // ── 96：执行入口收敛到 plan ────────────────────────────────────────────
  // 以前"这条命令包含几件事"只活在 `planOf` 里（表示／评估视图），执行仍由
  //   `issueCommand(cmd)` 一次下发——计划说两段、产品做一段，两套东西各说各的。
  // 现在一条命令先摊成 plan，再照 plan 执行：**plan 是唯一执行入口**。
  //
  // 但"照 plan 执行"不等于"每段都单独下发一次"。96 开工探针（`_probe96_split.js`）
  //   量出两件事，它们一起决定了拆分规则：
  //   ① **最终位置 0 差异**：同一张图、同一条 seed，「全军驻守北桥」一次下发
  //      与"先移动、到位后再驻守"两段下发，45 秒后 8 支部队的位置逐支相同。
  //      因为 d 层的 `groupAssign(DEFEND,x,y)` 本来就含"走过去"——94 说的"功能等价"。
  //   ② **回执会掉一句**：拆成两段，第一段的回执只说得清第一段。
  //      「全军攻击南桥」原本回执里写着"到点即战：沿途接敌，到点打 4 格内敌军"，
  //      拆完只剩"前往南桥"——玩家在按下这句话的那一刻，就不知道到了桥头要打。
  //      这是 91 那条「不许用另一种丢弃换一种丢弃」的直接反例。
  //
  // 所以拆不拆，由**这一段有没有"必须单独发生时点"**决定，不由段数决定：
  //   · 段带显式 `when`（要在中间等一个条件）→ **必须拆**，否则条件无处可挂；
  //   · 段是**开关型状态**（宾语是开关、兵不动：戒备、过河禁令、不击杀）→ **必须单独下发**，
  //     因为它改的是"接敌时怎么办"，等到位就晚了（「活捉」会变成"打死了再想起来抓活的"）；
  //   · 其余多段（走过去再守／再攻／再占）→ **一次下发，下发最后一段的 cmd**。
  //     前面几段是它的前置，d 层原生承接。这不是"退回旧实现"，是照探针的结论执行：
  //     拆了没有收益，还丢一句回执。
  //
  // 于是"条件插不进阶段中间"这件事的落点就有了：b 层哪天给第二段挂上 `when`，
  //   同一张 plan 立刻从"一次下发"变成"两段放行"，c 层不必再改。
  function isSwitchStep(st){
    const a=((st&&st.assigns)||[])[0]||{};
    // 宾语是"开关本身"（obj.kind==='state'）才是兵不动的那种；DEFEND 也是 STATE 类，
    //   但它的宾语是地点，那一段必须等兵走到，不能同刻下发。
    return !!(a.obj&&a.obj.kind==='state');
  }
  // 受令集合钉进整张计划。为什么必须钉：拆出来的第二段是**过一会儿**才发的一句话，
  //   那时玩家可能已经改了选中、部队也可能走出了画面——不钉的话
  //   「全军驻守北桥」的第二段会按"当前选中"重新解析主语，八支兵的令变成一支兵的令。
  //   权威来源是第 1 段实际受令的那批部队（`lastSubjects`），不再算一遍：两套算法必漂。
  function pinPlan(plan,ids){
    if(!ids||!ids.length)return;
    for(const st of (plan&&plan.steps)||[]){
      for(const a of st.assigns||[]){
        if(!a.subj||!a.subj.length||(a.subj.length===1&&a.subj[0]==='ALL'))a.subj=ids.slice();
      }
      if(st.cmd){
        // 玩家点了名就照他点的——钉住只负责"没说清的那部分"，不替玩家改主语
        const cur=st.cmd.unitIds||[];
        if(!cur.length||(cur.length===1&&cur[0]==='ALL')){
          st.cmd.unitIds=ids.slice();
          st.cmd.subjectAuto=false;
        }
      }
    }
  }
  function okStatus(s){return s!=='FAILED'&&s!=='UNSUPPORTED'&&s!=='CLARIFY';}
  function execPlan(plan,src,opt){
    opt=opt||{};
    const steps=(plan&&plan.steps)||[];
    if(!steps.length)return {status:'FAILED',interp:'',feedback:'空计划',staged:0};
    const first=steps[0];
    if(first.when&&first.when.kind!=='arrived'){
      // 「先前排的队我给撤了」只在玩家自己另下一句时说；补全缺口（followUp）不算
      if(activeQueue&&!opt.followUp&&first.cmd&&Array.isArray(first.cmd.unsupported))
        first.cmd.unsupported.push('新命令已取消此前的排队步骤');
      if(!armQueue(plan,src)){
        emit(src,'这条命令没有挂起：现在没有可受令的部队（画面里没有，也没点名）。');
        return {status:'FAILED',interp:'',feedback:'没有可受令的部队',staged:0};
      }
      const act=first.cmd?first.cmd.action:null;
      const fb=`已挂起：等${condText(first.when)}再${(act&&U.CMD_VERBS[act])||'执行'}`;
      tell(`${fb}。部队面板会显示在等什么、挂了多久；下一条命令会取消它。`);
      return {status:'QUEUED',interp:'',feedback:fb,armed:true,staged:0};
    }
    // 不需要拆：一次下发，下发**最后一段**——它才是完整动作（前面几段是它的前置）
    //   `opt.explicit` ＝ 这张计划的每一段都是**玩家自己明说的几件事**（组合句），
    //   它们各自都要真发生一次，不能压成"最后那件事"。与 ops 那种"一句话隐含的阶段"
    //   是两种东西：前者是玩家的两句话，后者是一句话的两个阶段。
    const split=opt.explicit?(steps.length>1):steps.some((st,k)=>k>0&&(st.when||isSwitchStep(st)));
    if(!split){
      const last=steps[steps.length-1];
      const out=last.cmd?issueCommand(last.cmd,src):issueStep(last,src);
      return Object.assign({},out,{staged:0});
    }
    const out=first.cmd?issueCommand(first.cmd,src):issueStep(first,src);
    if(!okStatus(out.status))return Object.assign({},out,{staged:0});
    pinPlan(plan,(lastSubjects||[]).map(u=>u.id));
    // 紧跟着的"开关型状态段"同刻下发：它不改位置，等到位只会让它来得太晚。
    //   **只对"一句话隐含的阶段"成立**（ops）：玩家说「活捉敌枪兵队」，俘虏状态必须和
    //   攻击同刻打开。但玩家明说「去桥上然后戒备」时，那个"然后"是他说的时间点——
    //   提前开到路上就把"然后"丢了，所以 explicit 的计划一律按段放行（78 口径不变）。
    //   102：组合句里含 ops 的那一段（`st.now`）是例外——它同样是"一句话的两个阶段"，
    //   只是这句话长在组合句里；不在这里放行，活捉/冲锋/加速就会被排到"到位之后"。
    let i=1;
    while(i<steps.length&&isSwitchStep(steps[i])&&!steps[i].when&&(!opt.explicit||steps[i].now)){
      issueStep(steps[i],`${src}（第 ${i+1} 段）`);
      i++;
    }
    let staged=0;
    if(i<steps.length){
      // 与组合句那条路同一个对象形状（78），tickQueue 不必知道这是哪种来源的计划
      activeQueue={plan:plan,idx:i,src:src,since:api.sim.simTime,noticed:false,armedIdx:-1};
      syncArmed(activeQueue);
      staged=steps.length-i;
      const cmds=steps.map(s=>s.cmd).filter(Boolean);
      tell(`排队：${cmds.length>1?chainInterp(cmds):planText(plan)}`
        +`（共 ${steps.filter(s=>!s.now).length} 段，${i>1?'前一段已下达，':''}到位后自动接着做）`);
    }
    return Object.assign({},out,{staged:staged,queued:staged});
  }
  // 扁平命令一律走这里：先摊成 plan，再照 plan 执行
  function execPlanOf(cmd,src){return execPlan(planOf(cmd),src);}

  // 敌情汇报（83）：**问答通道与 REPORT 动作共用这一处**。
  //   分两处写必然漂（"问句里报的和下令报的不一样"），而且两处都得记得走迷雾。
  //   数据源只有 `enemyFogState()`——它已经按迷雾过滤过（live / lagged / ghost），
  //   绝不遍历 `sim.enemies` 数总数：那是开图。
  function deliverFoeReport(src){
    const sim=api.sim;
    const st=sim.enemyFogState();
    const rows=[];
    for(const [id,s] of st){
      const e=sim.enemies.find(x=>x.id===id);
      rows.push({id,name:e?e.name:'敌军',mode:s.mode,x:s.x,y:s.y,age:s.age||0,hp:s.hp,maxHp:s.maxHp});
    }
    const a=adj();
    if(a&&a.reportFoeU)a.deliverOrder(a.reportFoeU(rows));
    else emit(src,rows.length
      ?rows.map(r=>`${r.name}：${r.mode==='live'?'看得见':'最后在 ('+Math.round(r.x)+','+Math.round(r.y)+')'}`).join('\n')
      :'还没见到敌军。');
    return rows.length;
  }
  // ── 102：「我知道哪些敌人」只有这一个来源 ──────────────────────────────
  // 凡是**要对玩家说出来**的敌军（点名、报距离、列候选、接受补充）一律走这里，
  //   绝不遍历 `sim.enemies`：那是整张战斗序列，念出来就是开图。
  //   条目形态与 deliverFoeReport 一致：live 看得见 / lagged 友军报告（位置滞后）/ ghost 残影。
  function knownFoes(){
    const out=[];
    for(const [id,s] of api.sim.enemyFogState()){
      const e=api.sim.enemies.find(x=>x.id===id);
      out.push({id,name:(e&&e.name)||'敌军',mode:s.mode,x:s.x,y:s.y,age:s.age||0});
    }
    return out;
  }
  function nearestKnown(point,list){
    if(!point)return null;
    let best=null;
    for(const f of list){
      const d=Math.hypot(point.x-f.x,point.y-f.y);
      if(!best||d<best.dist)best={foe:f,dist:d};
    }
    return best;
  }

  // 102：提交代次。语义兜底是**异步**的（本地句向量模型就绪时），一句"枪兵队"挂起后
  //   玩家改下"全军停止"，旧结果晚到会把停止顶掉、又发一条机动令（审查实测 88 格）。
  //   每次进 dispatchOrClarify +1，回来时对不上就作废——晚到的旧理解不许覆盖新命令。
  let submitSeq=0;

  function dispatchOrClarify(src,followUp){
    const seq=++submitSeq;
    const sim=api.sim;
    const corr=U.cmdCorrected(src);
    // 战术词判定排在最前，且必须按**整句**判（70）：
    //   「遇到敌人就打」会被 parseChain 切成「前往 + 攻击」两段，条件指令的模式跨段，
    //   分段后哪一段都匹配不到——按段判等于漏判。
    // 为什么必须先于追问：若先问"往哪儿"，玩家答了地点，兵就会无条件冲向那个地点；
    //   他以为设好了条件，实际下的是一条无条件令。"要求不成立"必须排在"命令成立但缺件"前面。
    const wholeCmd=U.parse(src).cmd;
    const tbWhole=tacticBlock(wholeCmd);
    if(tbWhole){
      const out=rejectTactic(wholeCmd,src,tbWhole);
      cmdLogCommit({at:sim.simTime,text:src,status:out.status,interp:'',feedback:out.feedback,followUp});
      api.ui.flush();return;
    }
    const chain=parseChain(src);
    if(chain){
      if(api.rec)api.rec('b',{text:src,chain:{ok:chain.ok,seg:chain.seg,cmds:chain.cmds}});
      if(!chain.ok){
        // 83：能被"答一句"补上的歧义（缺地点/缺部队/缺目标）先挂着，不把整条打掉。
        const cq=chain.clarify;
        if(cq&&cq.missing&&cq.tailCmds&&cq.tailCmds.length){
          // `__missing` 必须写在 cmd 上：应答路径读的是它（submitText 里 `cmdPending.cmd.__missing`），
          //   不写的话玩家答"北桥"会被当成一条新的、不完整的命令，追问上下文当场丢光——
          //   第一版就是这么写的，现象和"整条作废"一模一样。
          cq.cmd.__missing=cq.missing;
          cmdPending={cmd:cq.cmd,question:cq.question,src,options:cq.options||null,chain:cq.tailCmds};
          askTurn(cq.question,src);
          cmdLogCommit({at:sim.simTime,text:src,status:'CLARIFY',interp:'',feedback:cq.question,followUp});
          api.ui.flush();return;
        }
        emit(src, `组合命令没有执行：第 ${chain.seg} 段无法理解——${chain.reason}`);
        cmdLogCommit({at:sim.simTime,text:src,status:'FAILED',interp:'',feedback:`组合第 ${chain.seg} 段无效：${chain.reason}`});
        api.ui.flush();return;
      }
      if(corr.length)chain.cmds[0].unsupported.push('已自动纠正错字：'+corr.join('、'));
      const first=chain.cmds[0];
      // 96：整条链交 execPlan —— 与单段命令、与 b 层 ops 走的是**同一个执行入口**。
      //   78 那条"第一段自己带条件就不发令、整条挂起"搬进 execPlan，判据与文案一字未改；
      //   区别只在于：以前这里手写"发第一条 + 挂剩下的"，现在是把整张计划交出去。
      const out=execPlan(planOfSteps(chain.cmds),src,{followUp:followUp,explicit:true});
      if(out.status==='CLARIFY'){
        cmdPending.chain=chain.cmds;   // 补全后连后面的段一起排队
        cmdLogCommit({at:sim.simTime,text:src,status:'CLARIFY',interp:chainInterp(chain.cmds),feedback:out.feedback,followUp});
        api.ui.flush();return;
      }
      if(out.armed){
        cmdLogCommit({at:sim.simTime,text:src,status:'QUEUED',interp:chainInterp(chain.cmds),feedback:out.feedback,followUp});
        api.ui.flush();return;
      }
      if(okStatus(out.status)&&!(out.staged>0))dropQueue(null);
      cmdLogCommit({at:sim.simTime,text:src,status:out.status,interp:chainInterp(chain.cmds),feedback:out.feedback,queued:out.staged||0,followUp});
      api.ui.flush();return;
    }
    const parsed=U.parse(src);
    // 记录 b 层的原始返回（不是"最终怎么执行"）——对拍要比的正是这一层。
    if(api.rec)api.rec('b',{text:src,parsed});
    if(corr.length)parsed.cmd.unsupported.push('已自动纠正错字：'+corr.join('、'));
    // 规则层说"听不懂要做什么"或"什么地点都没认出来"时，先问语义兜底层（b 层的本地句向量）；
    // 规则已检测到多处歧义、正要带编号追问的，不交给语义猜。匹配到就用候选补缺（规则字段优先）。
    const needsFallback=parsed.clarification_required
      // 62：**矛盾句不许交给语义兜底**。兜底是"猜出一个最像的整句"，而矛盾句的整句
      //   恰恰是玩家说错的那一句——实测"全军撤退并按兵不动"被兜底成"全军撤退"（0.87）
      //   直接执行了，追问白问、兵还真被拉走了。矛盾是"要人回答"，不是"要人猜"。
      &&!parsed.conflict
      &&(parsed.missing===null
        ||(parsed.missing==='location'&&!parsed.cmd.locId&&!(parsed.options&&parsed.options.length)));
    if(needsFallback&&U.semanticReady()){
      U.semanticMatch(src).then(cand=>{
        if(seq!==submitSeq)return;     // 这一句早被后面一句覆盖了：旧理解直接作废
        if(cand){U.applySemantic(parsed,cand);runIssued();}
        else runClarify();
      }).catch(()=>{if(seq===submitSeq)runClarify();});
      return;
    }
    if(parsed.clarification_required){runClarify();return;}
    runIssued();
    return;
    function runClarify(){
      parsed.cmd.__missing=parsed.missing;
      cmdClarify(parsed.cmd,parsed.assistantQuestion,src,parsed.options);
      cmdLogCommit({at:sim.simTime,text:src,status:'CLARIFY',interp:'',feedback:parsed.assistantQuestion,followUp});
      api.ui.flush();
    }
    function runIssued(){
      if(activeQueue&&!followUp)parsed.cmd.unsupported.push('新命令已取消此前的排队步骤');
      // 96：单条命令也先摊成 plan 再执行（一段＝一次下发，两段＝排队）。
      //   以前这里直接 `issueCommand(cmd)`——b 层说了"这条命令是两件事"，产品仍只做一次下发。
      const out=execPlanOf(parsed.cmd,src);
      // 新命令＝覆盖整条队列（含挂着的触发）。这不是顺手清一下：
      //   不清的话，部队身上还挂着"等敌人"，面板会一直写着在等，而它其实已经在执行新命令。
      //   但**新命令自己刚挂上的队不许撤**（out.staged>0 就是它），否则"分两段"永远只剩第一段。
      if(okStatus(out.status)&&!(out.staged>0)&&!out.armed)dropQueue(null);
      cmdLogCommit({at:sim.simTime,text:src,status:out.status,interp:out.interp,feedback:out.feedback,
        queued:out.staged||0,followUp});
      api.ui.flush();
    }
  }
  function cmdResolveUnits(cmd){
    if(cmd.unitIds.includes('ALL'))return api.sim.units.filter(u=>u.hp>0);
    return cmd.unitIds.map(id=>api.sim.units.find(u=>u.id===id)).filter(Boolean);
  }
  // ── 画面内的友军（62）────────────────────────────────────────────
  // "画面"就是主视图＝主将视野框（ui.viewTiles 与相机同源，玩家看到什么，规则就是什么）。
  // 为什么不让 c 层自己按"离主将多少格"再算一套：两套数一定会在边界上打架——
  //   画面内画着、命令却不生效（或者反过来），这种自相矛盾最难解释。
  // 纯逻辑环境（没有 ui.viewTiles）时不设限：宁可放宽，也不要让命令在测试桩里凭空失败。
  function unitsInView(){
    const live=api.sim.units.filter(u=>u.hp>0&&!u.isRouted);
    if(!api.ui||!api.ui.viewTiles)return live;
    const vt=api.ui.viewTiles();
    return live.filter(u=>u.x>=vt.x0&&u.x<=vt.x1&&u.y>=vt.y0&&u.y<=vt.y1);
  }
  function cmdNotes(cmd){
    // 部队回退（选中/沿用上一条）的说明已在回退发生处直接写进 unsupported，这里只收集
    return [...cmd.unsupported];
  }
  // 统一执行入口：文字命令全部经此分发到与鼠标相同的执行器（sim 底部的 c↔d 契约）。
  // 每条路径返回 {status, interp, feedback}，命令日志据此统计"多少命令被正确执行"：
  //   EXECUTED 全部受命 · PARTIAL 部分受命（其余抗命/无路） · FAILED 未能执行 · CLARIFY 需要补信息 · UNSUPPORTED 未实现
  function issueCommand(cmd,src){
    const sim=api.sim,ui=api.ui;
    lastIntent=null;   // 68：每条命令从"没有意图"开始，任何早退路径都不许把上一条的意图带进来
    const lastToast=()=>ui.lastToast();   // 执行器刚推送的播报，原样入日志
    const notes=()=>cmdNotes(cmd);
    // 契约校验（69）：b 层交出来的东西如果是 c 层执行不了的，**在这里就停**，不进 switch。
    //   以前这条路径空着，switch 落到末尾会返回 undefined，调用方读 out.status 直接 TypeError——
    //   表现是整条命令通道崩掉，连"命令没执行"这句话都吐不出来。
    //   现在违约会变成一条能看懂的回执，并且带上 violation 明细供判分器归类（A 类）。
    const bad=cmdValidate(cmd);
    if(bad.length){
      const msg=`这条命令没有执行：${violationText(bad)}。`;
      emit(src,msg);
      return {status:'FAILED',interp:'',feedback:msg,violation:bad};
    }
    // 战术词判定（70）：b 层只标了"玩家说了什么"，"现在做不做得到"在这里判。
    //   必须在任何执行器调用之前——capture 放过去就是把活人打死，
    //   这不是"执行得不够好"，是执行结果和玩家说的那句话相反。
    const tb=tacticBlock(cmd);
    if(tb)return rejectTactic(cmd,src,tb);
    if(cmd.action==='RECON'){
      const msg='侦察命令（RECON）这一版还没实现。当前获取敌情靠视野：移动接近（正面 8 格），下令戒备可拉到 10 格，队友目视后 11 格内友军会收到通报。';
      emit(src, `${msg}${notes().length?`\n（注：${notes().join('；')}）`:''}`);
      return {status:'UNSUPPORTED',interp:'',feedback:'侦察（RECON）命令未实现'};
    }
    // "掩护我/跟我上"（上司定：护卫主将；主将未实装前以将旗单位为代理）——b 层 GUARD_ME 动作
    if(cmd.action==='GUARD_ME'){
      const bodyguard=sim.units.filter(u=>u.hp>0&&!u.isRouted&&u!==sim.commander);
      if(bodyguard.length){
        const r=sim.followUnit(bodyguard,sim.commander,true);
        const label=sim.commander?sim.commander.name:'主将';
        const st=r.n>0?'EXECUTED':'FAILED';
        // 「主将实体未实装，暂以将旗部队代理」是写给开发的话，玩家看了只会以为程序有毛病。
        //   79 起屏幕由副将按字段生成，这类免责说明不进字段，也就不用再从屏幕上删。
        const ord=orderOf({who:bodyguard,act:'护卫',tgt:label});
        emit(src, ord, st, lastToast());
        return {status:st,interp:orderText(ord),feedback:lastToast()};
      }
    }
    // 缺件校验，一次只问一件，按 部队 → 地点 → 目标 的顺序
    let list=cmdResolveUnits(cmd);
    // ── 短令的作用范围（62 定规矩、63 扩到全部动作）──────────────────────
    // 「放箭」「冲锋」「往前走」「原地驻守」「撤」「戒备」这种**没点名**的口令，
    //   是对**画面里的部队**喊的；画面外的部队听不见，要调它必须报名字（"弓兵队放箭"）。
    // 62 只做了战斗口令；63 上司明确"扩到移动/驻守/撤退/戒备"，其余占营/侦察/集合/跟随/停止
    //   一并纳入——不是顺手扩权，而是同一条原则本来就不分动作。例外只有 REPORT：
    //   汇报问的是全军状况，跟"喊谁去做"不是一类事。
    //
    // **顺序很重要**（63 定）：先按老规矩解析主语（点名 → 选中 → 上一条），**最后**才按画面过滤。
    //   反过来的话，"选中弓兵队 + 去北桥"会变成"画面内全军开拔"——玩家选了谁就该是谁动。
    //   只有**一个主语都解析不出来**时，短令才默认取画面内全部（这才是"对附近直接下的命令"）；
    //   这也顺手统一了 62 留下的两种口径（那时「放箭」取画面全部、「戒备」却要追问一句）。
    const SCOPE_VERB={ATTACK:'放箭',MOVE:'去北桥',DEFEND:'驻守',RETREAT:'撤退',STANCE_ON:'戒备',
      STANCE_OFF:'转常行',CAPTURE:'占领营地',RALLY:'到北桥集合',RECON:'去侦察',FOLLOW:'跟着我',
      GUARD_ME:'护驾',STOP:'原地停止',FORCED_ON:'加速行军',FORCED_OFF:'转常速'};
    const unitless=!cmd.unitIds.length||cmd.subjectAuto;              // 没点名（"全军"有 ALL，算点名）
    const scoped=cmd.action!=='REPORT'&&!!SCOPE_VERB[cmd.action]&&unitless;
    // 战斗口令（放箭/冲锋）与其它短令的区别，63 定：
    //   · 放箭/冲锋是**集体喊**，天生没有"单数主语"，所以取画面内**全部**（62 就是这口径，不变）；
    //   · 去/驻守/撤退/戒备是**对某个主语下的令**，所以先认选中、再认上一条，都没有才取画面内全部。
    //   两条都受同一条约束：画面外的一律不认，要认必须点名。
    const attackCry=scoped&&cmd.action==='ATTACK';
    const verb=cmd.action==='ATTACK'?(cmd.arrow?'放箭':'冲锋'):(SCOPE_VERB[cmd.action]||'');
    let fromView=false;   // 主语是不是"画面内全部"补出来的（决定要不要写那条注记）
    if(!list.length){
      if(cmd.multiLocs&&cmd.multiLocs.length>=2)list=sim.units.filter(u=>u.hp>0&&!u.isRouted);   // 分兵：默认全部可用部队（分兵的含义就是拆开它们）
      else if(cmd.action==='REPORT')list=sim.units.filter(u=>u.hp>0);   // 裸"报告"默认报全军，不套用选中回退
      else if(attackCry){list=unitsInView();fromView=true;}           // 战斗口令：就是眼前这些，不看选中
      else{
        let via='';
        if(ui.isSelectionFresh&&ui.isSelectionFresh()){list=ui.liveSelection();via='selection';}
        else if(lastSubjects&&lastSubjects.length){
          list=lastSubjects.filter(u=>u.hp>0&&!u.isRouted);
          if(list.length)via='last';
        }
        if(!list.length){list=ui.liveSelection();via='selection';}   // 没有可沿用的历史时仍回退选中
        if(!list.length&&scoped){list=unitsInView();fromView=true;}   // 短令：一个主语都没有 → 就是眼前这些
        if(!list.length){
          cmd.__missing='unit';
          const alive=sim.units.filter(u=>u.hp>0);
          const q=`请问由哪支部队执行？当前可选：${U.numbered(alive.map(u=>u.name))}（或"全军"）。`;
          cmdClarify(cmd,q,src,alive.map(u=>({id:u.id,label:u.name})));
          return {status:'CLARIFY',interp:'',feedback:q};
        }
        if(via)cmd.unsupported.push(via==='last'?'未点名部队，沿用上一条命令的部队':'未点名部队，对当前选中的部队生效');
        if(via==='selection'&&ui.consumeSelectionFresh)ui.consumeSelectionFresh();
      }
    }
    // 最后一道：主语解析完了，短令一律按画面筛一遍（点名的不筛——报了名字就该听得见）。
    if(scoped&&list.length){
      const view=unitsInView();
      const pool=list.filter(u=>view.indexOf(u)>=0);
      if(!pool.length){
        // 玩家手里可能正选着一支画面外的部队（点小地图选中的）。不能只说"画面里没有部队"，
        //   要指名它是谁——否则他会以为命令坏了，而不是"我选的这支部队听不见"。
        const sel=(api.ui&&api.ui.liveSelection)?api.ui.liveSelection():[];
        const who=`${list.map(u=>u.name).join('、')}现在不在你的画面里（主将视野之外）。`;
        const hint=(list[0]&&list[0].name)||(sel[0]&&sel[0].name)||(sim.units.find(u=>u.hp>0)||{name:'骑兵队'}).name;
        const msg=`${who}\n短令只喊给画面里的部队听——画面外的部队要点名，比如「${hint}${verb}」。`;
        emit(src,msg);
        return {status:'FAILED',interp:'',feedback:'画面内没有可受令的部队'};
      }
      // nearScope 的语义是"这句话是冲眼前喊的，目标也由眼前决定"（「放箭」打射程内最近那支）。
      //   只有没点名的短令才配它：点了名的"弓兵队攻击"没给目标，该问"打哪个"，不能替他打眼前的。
      cmd.nearScope=true;
      list=pool;
      // 注记只写一条：主语是"画面内全部"时说明这条规矩；主语是选中的那支就不必再提范围
      if(fromView||cmd.subjectAuto)cmd.unsupported.push('未点名部队：只对画面内的部队生效');
    }
    if(cmd.action!=='REPORT'){
      const live=list.filter(u=>u.hp>0&&!u.isRouted);
      if(!live.length){
        const msg=`${list.map(u=>u.name).join('、')}已阵亡或正在溃退，无法受命。`;
        emit(src, `${msg}`);
        return {status:'FAILED',interp:'',feedback:msg};
      }
      lastSubjects=live;   // 这条命令点名/回退到的部队，就是下一次"未点名"的上下文
    }
    const names=list.filter(u=>u.hp>0).map(u=>u.name).join('、');
    const lm=cmd.locId?U.landmarkById(cmd.locId):null;
    // 68：把"谁、做什么、去哪"记成**结构化意图**——判分器只认这四样，不认回显文字。
    //   主语取"活着且没溃退的"，与执行器实际受令的集合同源（上一段刚算过）；
    //   目的地取地标的**真坐标**，不是名字——判分要看位移方向，名字没法算。
    //   只在这里记一次：执行器（SIM.order*）一概不参与，否则 d 层要为指标改形状。
    lastIntent={act:cmd.action,
      ids:list.filter(u=>u.hp>0&&!u.isRouted).map(u=>u.id),
      at:lm?{id:lm.id,x:lm.x,y:lm.y}:null,
      foe:cmd.foeId||null,arrow:!!cmd.arrow,dir:cmd.dir||null};
    // 压制（78）：这条命令要求"伏着别主动打"，就开；没要求，就**一律关**。
    //   关是默认而不是"顺手清一下"：伏击是个状态，不清的话它会粘在部队身上，
    //   下一道冲锋令下来兵还在原地蹲着——而玩家以为自己下的是进攻令。
    //   对话类动作（报告/求援/侦察）不动部队，不去碰别人的压制状态。
    if((ACTION_CAPS[cmd.action]||{}).op!=='TALK'){
      const subs=cmd.action==='REPORT'?[]:list.filter(u=>u.hp>0&&!u.isRouted);
      api.sim.setHoldFire(subs,cmd.suppress?'passive':null);
    }
    // 84：记进 CTX（契约 §3.3——只有 c 写）。放在 switch 之前：
    //   任务在"命令成立"这一刻就成立，此后 phase 由 d 层事实推，不由"执行器返回了什么"推。
    if(cmd.action!=='REPORT')noteTasking(cmd,list,lm,src);
    // 98（Q40/A7）：**下任何新命令都结束上一道全力冲锋**（97 单向门规矩）。
    //   跳过 RUSH_ON 自己——它是同一条令的第二段，在这里复位就永远打不开。
    //   放在主语解析完、switch 分发前：追问/违约/被拒的命令不算「下了新令」，
    //   不该把玩家正在冲的状态悄悄取消。只复位本道令受命的部队（与 97 setCapture 同口径），
    //   点名一支部队时不许顺手把别队的冲锋也关掉。
    if(cmd.action!=='RUSH_ON')sim.setRush(list,false,true);
    switch(cmd.action){
      case 'RIVER_ON':{
        const r=sim.setRiverBan(list,true);
        const st=r.n>0?'EXECUTED':'FAILED';
        const ord=orderOf({who:list,act:'禁止过河',notes:notes()});
        emit(src, ord, st, lastToast());
        return {status:st,interp:orderText(ord),feedback:lastToast()};
      }
      case 'RIVER_OFF':{
        const r=sim.setRiverBan(list,false);
        const st=r.n>0?'EXECUTED':'FAILED';
        const ord=orderOf({who:list,act:'允许过河',notes:notes()});
        emit(src, ord, st, lastToast());
        return {status:st,interp:orderText(ord),feedback:lastToast()};
      }
      case 'CAPTURE_ON':{
        // 97：活捉的**开关**这一段。它只改 d 层的结算开关，不动位置、不动路径。
        //   单独下发（玩家只说「活捉」不给目标）也能成立——那时 foeId 是空的，
        //   回执就不写目标名，不能编一个出来。
        const r=sim.setCapture(list,true);
        const foe=cmd.foeId?sim.enemies.find(e=>e.id===cmd.foeId):null;
        // 措辞跟着 d 层的 CAPTURE.CHANCE 走：那个数是数值设计，将来上司改了，
        //   回执必须说当时的真话。写死在文案里就是"改一个数要改五处字"，迟早有一处漏。
        const ch=sim.CAPTURE?sim.CAPTURE.CHANCE:1;
        const how=ch>=1?'打垮那一刻一律留活口'
          :`打垮那一刻按 ${Math.round(ch*100)}% 改判俘获，没抓到的照常战死`;
        const ns=notes().slice();
        ns.push(`活捉：照常攻击，${how}；随军没有将领的敌人抓不到人`);
        const ord=orderOf({who:list,act:'活捉',tgt:foe?foe.name:null,notes:ns});
        const st=r.n>0?'EXECUTED':'FAILED';
        emit(src, ord, st, lastToast());
        return {status:st,interp:orderText(ord),feedback:lastToast()};
      }
      case 'RUSH_ON':{
        // 98：只改形态，不动位置。100 轮起真加速（+50%）并烧体力，目标从 planOf 第二段保留的 foeId 带来。
        const foe=cmd.foeId?sim.enemies.find(e=>e.id===cmd.foeId):null;
        const r=sim.setRush(list,true,false,foe?foe.id:null);
        const ns=notes().slice();
        ns.push('全力冲锋：速度 +50%、起手提气；代价是体力 4/秒、阵型散开，接战或另下一令即收');
        const ord=orderOf({who:list,act:'全力冲锋',tgt:foe?foe.name:null,notes:ns});
        const st=r.n>0?'EXECUTED':'FAILED';
        emit(src, ord, st, lastToast());
        return {status:st,interp:orderText(ord),feedback:lastToast()};
      }
      case 'FORCED_ON':{
        // 101：行军档位。取真值写进回执，不把 1.2／2.0 抄成两处字——
        //   数值口径只有 d 层一处（85/98 都吃过"改一个数要改五处文案"的亏）。
        const r=sim.setForced(list,true);
        const mult=sim.FORCED?sim.FORCED.SPEED_MULT:1.2;
        const drain=sim.FORCED?sim.FORCED.DRAIN:2;
        const ns=notes().slice();
        ns.push(`加速行军：常行的 ${mult} 倍速度；代价是行军途中体力 ${drain}/秒，接战或体力见底自动转回常行`);
        const ord=orderOf({who:list,act:'加速行军',notes:ns});
        const st=r.n>0?'EXECUTED':'FAILED';
        emit(src, ord, st, lastToast());
        return {status:st,interp:orderText(ord),feedback:lastToast()};
      }
      case 'FORCED_OFF':{
        const r=sim.setForced(list,false);
        const ns=notes().slice();
        ns.push('回到常速行军（常行的 1 倍），行军途中不再扣体力');
        const ord=orderOf({who:list,act:'转常速行军',notes:ns});
        const st=r.n>0?'EXECUTED':'FAILED';
        emit(src, ord, st, lastToast());
        return {status:st,interp:orderText(ord),feedback:lastToast()};
      }
      case 'MOVE': case 'DEFEND': case 'RALLY': case 'CAPTURE':{
        // 分兵（"兵分两路过桥"）＝原则③ 的第一个真实用例：
        //   一条指令、一个阶段、N 个**同步**主谓宾（每队几支部队 → 各自一个地点）。
        //   以前这里是一段手写的切片循环，分兵"几件事"只存在于这段循环的局部变量里；
        //   现在它先是一张 plan（谁→哪儿，人能读、断言能查重叠），执行只是照着走。
        if(cmd.multiLocs&&cmd.multiLocs.length>=2&&!lm){
          const locs=cmd.multiLocs;
          const slices=splitUnits(list,locs.length);
          const plan=planOfParallel(cmd.action,slices.map((us,i)=>{
            const place=U.landmarkById(locs[i]);
            // 悬空 id 不在这里报（cmdValidate 已经拦过一道），但 obj 得如实说"没坐标"，
            //   不能编一个 (0,0) 出来——那会让部队真的往地图角上走。
            return {ids:us.map(u=>u.id),
              obj:place?{kind:'loc',id:place.id,name:place.name,x:place.x,y:place.y}
                       :{kind:'loc',id:locs[i],name:locs[i],x:null,y:null}};
          }));
          assertPlan(plan);   // 真实产出的形状也要过一遍，不是只在测试里过
          const kind=cmd.action==='RALLY'?'RALLY':cmd.action==='DEFEND'?'DEFEND':'MOVE';
          let total=0,failed=0,detail=[];
          for(const a of plan.steps[0].assigns){
            const locId=a.obj.id;
            const us=a.subj.map(id=>list.find(u=>u.id===id)).filter(Boolean);
            if(!us.length)continue;
            const place=U.landmarkById(locId);
            if(!place){failed+=us.length;detail.push(`${us.map(u=>u.name).join('、')}去${locId}（没这个地方）`);continue;}
            const r=sim.groupAssign(us,place.x,place.y,kind,{strictSingle:false});
            total+=r.n;failed+=r.failed;
            detail.push(`${us.map(u=>u.name).join('、')}去${place.name}`);
          }
          const ord=orderOf({head:'分兵',parts:detail});
          const st=total>0?(failed>0?'PARTIAL':'EXECUTED'):'FAILED';
          emit(src, ord, st, lastToast());
          return {status:st,interp:orderText(ord),feedback:lastToast()};
        }
        // 方向推进：命令是"目标"不是"落点"，d 层每帧自己判断走多远、何时停
        if(!lm&&cmd.dir){
          const r=sim.orderAdvance(list,cmd.dir,cmd.dist);
          const ord=orderOf({who:list,act:`向${cmd.dir}推进${cmd.dist?` ${cmd.dist} 格`:''}`,notes:notes()});
          const st=r.n>0?'EXECUTED':'FAILED';
          emit(src, ord, st, lastToast());
          return {status:st,interp:orderText(ord),feedback:lastToast()};
        }
        // 91：默认目标**不许越过"说了但没命中"**。CAPTURE 缺地点时用中央据点兜底，
        //   那是给"根本没说要占哪儿"（「全军占领」）准备的。`placeMissing` 一旦有值，
        //   说明玩家点了地方、图上没有——这时拿默认目标顶上，等于把他的话换成另一件事：
        //   「去我方占领的营地」实际下达的是"去占领中央据点"，他说的营地一处没去。
        //   有 placeMissing 就让它走到下面那条追问，把"为什么没有"说清楚。
        let target=lm||(cmd.action==='CAPTURE'&&!cmd.placeMissing&&!cmd.pronounMissing?U.landmarkById('OBJ'):null);
        // ── 就地驻守（73）：每支守自己脚下 ───────────────────────────────
        // 「全军驻守」没有宾语不是缺件，它的宾语就是"现在站的这块地"——b 层已经把它填成 HERE。
        // 以前这里落到 rallyPoint（全军质心）再铺格，结果是"驻守"把散开的部队聚成一团：
        //   部队被命令挪了窝，而玩家说的是"别动"。这就是"宾语要按执行器最后要什么分"的用处。
        // 形状上是原则③：一个阶段、N 个同步主谓宾，主语各不相同、宾语是各自那一格。
        if(cmd.action==='DEFEND'&&cmd.locId===U.HERE){
          const plan=planOfParallel('DEFEND',list.map(u=>({
            ids:[u.id],
            obj:{kind:'loc',x:Math.round(u.x),y:Math.round(u.y),
                 name:`第 ${Math.round(u.x)+1} 列、第 ${Math.round(u.y)+1} 行`}})));
          assertPlan(plan);
          let n=0,failed=0;
          for(const a of plan.steps[0].assigns){
            const u=list.find(x=>x.id===a.subj[0]);
            if(!u)continue;
            // 单支走 strictSingle：目标就是它自己那一格，不许 collectSlots 再挪它一格
            const r=sim.groupAssign([u],a.obj.x,a.obj.y,'DEFEND',{strictSingle:true});
            n+=r.n;failed+=r.failed;
          }
          const ord=orderOf({who:list,act:'就地驻守',
            notes:[`各守脚下，防区 ${sim.HOLD.R} 格`].concat(notes())});
          const st=n>0?(failed>0?'PARTIAL':'EXECUTED'):'FAILED';
          const fb=`${n} 支部队就地驻守${failed?`，${failed} 支守住不了原位`:''}`;
          emit(src, ord, st, fb);
          return {status:st,interp:orderText(ord),feedback:fb};
        }
        if(!target&&cmd.locId===U.HERE){
          // "原地/站到一起"：目标就是这批部队的质心（d 层算）
          const cell=sim.rallyPoint(list);
          target=cell?{id:U.HERE,name:'当前位置',x:cell.x,y:cell.y}:null;
        }
        if(!target){
          cmd.__missing='location';
          // 91：**有原因时不再问"哪儿"**。原来的句子是「要前往哪里？这张图上目前没有我方占领的营地。可选…」——
          //   先问再自己回答，玩家读到的是"你到底要我说什么"。原因本身就是这一轮的答复：
          //   玩家说的是"去我方的营地"，该告诉他的是"这一处不存在、图上都有哪些"，不是再问一遍地点。
          const why=placeHint(cmd);
          const q=why
            ? `${why}${placeChoices()}`
            : `要${U.CMD_VERBS[cmd.action]}哪里？${placeChoices()}（也可答"北边的树林""敌人占的营地"这类说法）。`;
          cmdClarify(cmd,q,src,null);
          return {status:'CLARIFY',interp:'',feedback:q};
        }
        const kind=cmd.action==='RALLY'?'RALLY':cmd.action==='DEFEND'?'DEFEND':'MOVE';
        const ns=notes();
        if(cmd.action==='CAPTURE'){
          if(!lm)ns.push('占领目标默认为中央据点');
          ns.push('部队站上据点 10 秒即占领，敌军同站在场时进度暂停');
        }
        const r=sim.groupAssign(list,target.x,target.y,kind,{strictSingle:false});
        // 驻守要说清"守多大一块地"（73）：只报"驻守北桥"，玩家没法判断敌人走到
        //   两格之外算不算"来了"。防区是这条命令的实际含义，不是参数细节。
        //   ★ 这句必须在 orderOf 之前 push：orderOf 会复制 notes，
        //   复制完再 push 等于白写（79 改模板时踩过一次，防区说明整句消失）。
        if(cmd.action==='DEFEND')ns.push(`防区 ${sim.HOLD.R} 格：敌人进圈就迎上去，赶走或出圈就回守位`);
        const ord=orderOf({who:list,act:U.CMD_VERBS[cmd.action],tgt:target.name,notes:ns});
        const st=r.n>0?(r.failed>0?'PARTIAL':'EXECUTED'):'FAILED';
        emit(src, ord, st, lastToast());
        return {status:st,interp:orderText(ord),feedback:lastToast()};
      }
      case 'ATTACK':{
        // 97：活捉是**这一道攻击令的收场方式**，不是永久姿态——下一道普通攻击令就复位。
        //   为什么必须复位：活捉没有反向开关（`CAPTURE_OFF` 未做），不复位就成了**单向门**：
        //   玩家说过一次「活捉」，此后每一仗都只能抓活的，想杀人却没有话能收回。单向门比缺功能更坏。
        //   同刻下发时顺序天然对：`ATTACK` 先复位（silent，不出声），`CAPTURE_ON` 再打开。
        //   复位是 d 层执行器调用，不是 c 层去改单位字段——c↔d 契约那一层不许越。
        sim.setCapture(list,false,true);
        let foe=cmd.foeId?sim.enemies.find(e=>e.id===cmd.foeId&&e.hp>0):null;
        // ── 合围（72）：一条指令、一个阶段、N 个同步主谓宾 ────────────────
        //   「合围敌弓兵队」不是"打它"，是"你、你、你，各守它周围一个方位"。
        //   每支部队的主语不同、宾语也不同（同一个目标的第 i 个环位），
        //   所以它天然写不成一条 cmd——只能是一张并行主谓宾的 plan。
        //   到点即战（DEFEND 种）：站住围位就打射程内的，没敌就守着。与"进攻地标"同口径，
        //   玩家不会看到"围住了却在发呆"。
        //   只有 1 支部队围不住：照普通攻击走（并在注记里说清，见 b 层 TACTICS）。
        if(hasTactic(cmd,'encircle')&&list.length>=2){
          const tgt=foe||lm;
          if(tgt){
            const ring=sim.ringPositions(list,tgt);
            if(ring.length>=2){
              const plan=planOfRing(ring,tgt);
              assertPlan(plan);
              let total=0,failed=0;const detail=[];
              for(const a of plan.steps[0].assigns){
                const us=a.subj.map(id=>list.find(u=>u.id===id)).filter(Boolean);
                if(!us.length)continue;
                const r=sim.groupAssign(us,a.obj.x,a.obj.y,'DEFEND',{strictSingle:false});
                total+=r.n;failed+=r.failed;
                detail.push(`${us.map(u=>u.name).join('、')}去${a.obj.name}`);
              }
              // 围不满就说围不满：几支部队只站了几个方位，别让玩家以为四面都封死了
              const ord=orderOf({head:`合围 ${tgt.name}`,parts:detail,
                notes:ring.length<8?[`只有 ${ring.length} 支部队，占住 ${ring.length} 个方位`]:null});
              const st=total>0?(failed>0?'PARTIAL':'EXECUTED'):'FAILED';
              // fb 不用 lastToast()：合围是 N 次 groupAssign，最后一次的播报只有一支
              //   （"1 支部队前往驻守位置"）——拿它当整条命令的结论，等于把五支说成一支。
              const fb=`${total} 支部队分头前往围位${failed?`，${failed} 支无路可走`:''}`;
              emit(src, ord, st, fb);
              return {status:st,interp:orderText(ord),feedback:fb};
            }
          }
        }
        // ── 放箭（62）：目标由**射程**决定，不要玩家点名 ────────────────
        // b 层给 arrow 标记（放箭/齐射/射…），这层就用 d 层的射程查询把目标补上。
        // 以前是回一句"要攻击哪个目标？"，等于让玩家把"眼前的敌人"再说一遍——
        //   而这句话的语义本来就是"别问了，射你能射到的"。
        if(!foe&&cmd.arrow){
          // 102：只射**迷雾里认得的**敌人。以前只判距离，弓兵能隔着山脊打一支
          //   玩家看不见的敌人，回执还把它的名字和距离念出来（审查实测：迷雾 0 条仍报"197.2 格"）。
          const known=knownFoes();
          const hit=sim.enemyInRange(list,new Set(known.map(f=>f.id)));
          if(hit){
            const ord=orderOf({who:list,act:'放箭打',tgt:hit.foe.name,
              notes:[`射程内 ${hit.dist.toFixed(1)} 格`].concat(notes())});
            const r=sim.orderAttackGroup(list,hit.foe);
            const st=r.ok>0?(r.defied>0?'PARTIAL':'EXECUTED'):'FAILED';
            emit(src, ord, st, lastToast());
            return {status:st,interp:orderText(ord),feedback:lastToast()};
          }
          // 射程内没有：**必须把距离说出来**，否则玩家以为令下去了、只是没射中
          const range=Math.max(...list.map(u=>u.range||1));
          const at=list[0]||sim.commander;
          // 自由文案也得编组：五支部队名并列念出来是这轮要消灭的机器腔之一。
          //   编组规则只有一份（副将的 grp），这里借他的，不另写一套。
          const A=adj();
          const who=A?A.grp(list):names;
          const near=nearestKnown(at,known);
          if(!near){
            emit(src,`${who}的射程是 ${range} 格，现在视野里没有敌军。`);
            return {status:'FAILED',interp:'',feedback:'视野里没有敌军'};
          }
          const msg=`${who}的射程是 ${range} 格，现在射程内没有敌人（我记得最近的一支在 ${near.dist.toFixed(1)} 格外）。`
            +`要他们靠前，或者说「${who}攻击 ${near.foe.name}」让弓兵自己走过去。`;
          emit(src,msg);
          return {status:'FAILED',interp:'',feedback:'射程内没有敌人'};
        }
        if(!foe&&lm){
          // 攻击地标（上司定：到点即战）：移动过去，沿途接敌（groupAssign 走打由交火循环被动还击），
          // 到点后攻击 4 格内敌军；无敌则驻守桥头/据点（进攻据点/夺回据点转占领姿态）
          const kind='DEFEND';   // 到点即战：DEFEND 就地还击＝打射程内敌军，无敌则驻守
          const r=sim.groupAssign(list,lm.x,lm.y,kind,{strictSingle:false});
          const ord=orderOf({who:list,act:'进攻',tgt:lm.name,
            notes:['到点即战：沿途接敌，到点打 4 格内敌军，无敌则驻守'].concat(notes())});
          const st=r.n>0?(r.failed>0?'PARTIAL':'EXECUTED'):'FAILED';
          emit(src, ord, st, lastToast());
          return {status:st,interp:orderText(ord),feedback:lastToast()};
        }
        if(!foe&&cmd.dir&&!lm){
          // 方向性攻击（上司定：A 过去）＝朝方向扫荡前进、沿途接敌即战（attackMove）
          const r=sim.attackMove(list,cmd.dir);
          const ord=orderOf({who:list,act:`向${cmd.dir}扫荡前进`,
            notes:['沿途接敌即战'].concat(notes())});
          const st=r.n>0?'EXECUTED':'FAILED';
          emit(src, ord, st, lastToast());
          return {status:st,interp:orderText(ord),feedback:lastToast()};
        }
        // ── 条件句的动手目标（78）：条件说的是"看到谁"，打的就是谁 ──────────
        // 与下面"冲锋"的区别：冲锋是喊一声往上冲，随便哪支都行；
        //   "看到敌主将才动手"是认人的——打错人等于伏击白设，玩家还得再下一次令。
        // 只认**看得见**的：靠"我记得它在那边"去打，等于替玩家开图。
        if(!foe&&cmd.autoTarget){
          const cands=sim.enemies.filter(e=>e.hp>0&&!e.isRouted
            &&(cmd.autoTarget!=='commander'||(e.leader&&e.leader.alive!==false&&e.leader.kind==='commander')));
          let best=null,bd=Infinity;
          for(const u of list)for(const e of cands){
            if(!sim.canSee(u,e))continue;
            const d=sim.distance(u,e);
            if(d<bd){bd=d;best=e;}
          }
          if(best)foe=best;
        }
        // ── 冲锋类短令（62）：没点名、也没指方向 → 打**眼前那一支** ────────
        // 「冲锋」是喊一声就往上冲，不该反过来问"打哪个"——那等于让玩家替他找敌人。
        // 判据是 nearScope（上面按画面筛过部队），而不是"有没有目标"：
        //   点名下令（"骑兵队攻击"）仍然要问清目标，因为那时省下的一句话是有信息量的。
        if(!foe&&cmd.nearScope){
          const anchor=sim.commander||list[0];
          const near=sim.enemyNear(anchor,sim.DETECT);
          const seenKnown=near&&knownFoes().some(f=>f.id===near.foe.id);
          if(seenKnown)foe=near.foe;
          else{
            const one=list[0]?list[0].name:names;
            const msg=`画面里没有敌军（主将视距 ${sim.DETECT} 格内），这一声冲锋没人可冲。远处的敌人要点名，比如「${one}攻击 敌骑兵队」。`;
            emit(src,msg);
            return {status:'FAILED',interp:'',feedback:'画面里没有敌军'};
          }
        }
        if(!foe){
          // 102：候选只列**迷雾里认得的**。以前列全 `sim.enemies`——迷雾 0 条也把 8 支敌军的
          //   名册念一遍，那是整张战斗序列；玩家照着答一句就能锁定看不见的目标（审查实测 193 格）。
          const known=knownFoes();
          if(!known.length){
            const who=adj()?adj().grp(list):names;
            emit(src,`${who}没有可攻击的目标：现在视野里没有敌军。远处的敌人要先靠近才看得见。`);
            return {status:'FAILED',interp:'',feedback:'视野里没有敌军'};
          }
          cmd.__missing='target';
          const q=`要攻击哪个目标？视野里的敌军：${U.numbered(known.map(f=>f.name))}（也可答"弓兵"这类兵种名）。`;
          cmdClarify(cmd,q,src,known.map(f=>({id:f.id,label:f.name})));
          return {status:'CLARIFY',interp:'',feedback:q};
        }
        const ord=orderOf({who:list,act:'攻击',tgt:foe.name,notes:notes()});
        const r=sim.orderAttackGroup(list,foe);
        // 先执行再回执：抗命（士气<50）是 d 层说了算，副将不能抢在它前面说"得令"
        const st=r.ok>0?(r.defied>0?'PARTIAL':'EXECUTED'):'FAILED';
        emit(src, ord, st, lastToast());
        return {status:st,interp:orderText(ord),feedback:lastToast()};
      }
      case 'STANCE_ON':{
        const r=sim.stanceUnitsOn(list);
        const st=r.ok>0?(r.tired>0?'PARTIAL':'EXECUTED'):'FAILED';
        {const ord=orderOf({who:list,act:'转入戒备',notes:notes()});
        emit(src, ord, st, lastToast());
        return {status:st,interp:orderText(ord),feedback:lastToast()};}
      }
      case 'STANCE_OFF':{
        const r=sim.stanceUnitsOff(list);
        const st=r.n>0?'EXECUTED':'FAILED';
        {const ord=orderOf({who:list,act:'转为常行',notes:notes()});
        emit(src, ord, st, lastToast());
        return {status:st,interp:orderText(ord),feedback:lastToast()};}
      }
      case 'RETREAT':{
        if(cmd.retreatTo){
          const place=U.landmarkById(cmd.retreatTo);
          if(place){
            const r=sim.retreatTo(list,place.x,place.y,place.name);
            const ord=orderOf({who:list,act:'撤到',tgt:place.name,
              notes:['到了就驻守'].concat(notes())});
            const st=r.n>0?'EXECUTED':'FAILED';
            emit(src, ord, st, lastToast());
            return {status:st,interp:orderText(ord),feedback:lastToast()};
          }
        }
        const r=sim.retreatUnits(list);
        const st=r.ok>0?(r.ok<r.total?'PARTIAL':'EXECUTED'):'FAILED';
        {const ord=orderOf({who:list,act:'撤退',notes:notes()});
        emit(src, ord, st, lastToast());
        return {status:st,interp:orderText(ord),feedback:lastToast()};}
      }
      case 'STOP':{
        const n=sim.stopUnits(list);
        // 84：停止＝这条任务作废。不清账的话，下一句「继续」会把它复活（契约 §3.6）。
        dropTasks(list.map(u=>u.id));
        const st=n?'EXECUTED':'FAILED';
        {const ord=orderOf({who:list,act:'停止',notes:notes()});
        emit(src, ord, st, lastToast());
        return {status:st,interp:orderText(ord),feedback:lastToast()};}
      }
      case 'FOLLOW':{
        // 跟随/护卫：cmd.followId 是被跟随者（b 层语义）；执行者=list（c 层回退/追问）
        // 锚点（2026-10-28 ㊷）：被跟随者是**主将本人**，坐标由 d 层每帧现取——这就是"持续跟随"。
        const isAnchor=cmd.followAnchor==='COMMANDER';
        let target=cmd.followId?sim.units.find(u=>u.id===cmd.followId&&u.hp>0):null;
        if(isAnchor){
          // 主将阵亡后锚点没有任何意义：必须明说，不能静默落回地图中心（那会让部队往空地走）
          if(!sim.commander||sim.commander.hp<=0){
            const q='主将已经阵亡了，没有可以靠拢的人。要往哪里去？可以说地点，比如"全军撤到北桥"。';
            cmd.__missing='location';
            cmdClarify(cmd,q,src,[]);
            return {status:'CLARIFY',interp:'',feedback:q};
          }
          target=sim.commander;
          // 执行者永远不可能是被跟随者本人。说"向我靠拢"时若只选中了主将自己，
          //   按"叫所有人过来"理解（这是这句话的常态语义），不要反问"谁向你靠拢"。
          //   但**点了名**的情况不这样放宽："枪兵队靠拢主将"而主将正是枪兵队时，
          //   放宽成"全员靠拢"是过度解读，宁可回一句说清楚。
          const named=cmd.unitIds.length>0;
          list=list.filter(u=>u!==target);
          if(named&&!list.length){
            const q=`${target.name}就是主将本人，不用向自己靠拢。要让别的部队过来，说「全军向主将靠拢」。`;
            cmdClarify(cmd,q,src,sim.units.filter(u=>u.hp>0&&u!==target).map(u=>({id:u.id,label:u.name})));
            return {status:'CLARIFY',interp:'',feedback:q};
          }
          if(!list.length)list=sim.units.filter(u=>u.hp>0&&!u.isRouted&&u!==target);
        }
        if(!target&&list.length)target=list[0],list=[];   // 只点名了被跟随者：执行者回退选中
        const followers=list.filter(u=>u!==target&&u.hp>0);
        if(!target||!followers.length){
          const alive=sim.units.filter(u=>u.hp>0);
          cmd.__missing='unit';
          const q=isAnchor
            ? `当前没有可以靠拢的部队（主将以外都在溃退或已阵亡）。`
            : `护卫/跟随需要"执行部队+被护卫者"。当前可选：${U.numbered(alive.map(u=>u.name))}。说如"骑兵队保护弓兵队"。`;
          cmdClarify(cmd,q,src,alive.map(u=>({id:u.id,label:u.name})));
          return {status:'CLARIFY',interp:'',feedback:q};
        }
        const escort=cmd.unsupported.some(x=>x.includes('护卫'))||/护卫|保护/.test(src);
        const r=sim.followUnit(followers,target,escort);
        const ord=isAnchor
          ? orderOf({who:followers,act:'向主将靠拢',
              notes:['一直跟着：主将再动，他们也跟着动'].concat(notes())})
          : orderOf({who:followers,act:escort?'护卫':'跟随',tgt:target.name,notes:notes()});
        const st=r.n>0?'EXECUTED':'FAILED';
        emit(src, ord, st, lastToast());
        return {status:st,interp:orderText(ord),feedback:lastToast()};
      }
      case 'CALL_ARMS':{
        // "派出援军/弓箭手准备"：对系统说的话，需指明哪支部队执行什么
        cmd.__missing='unit';
        const alive=sim.units.filter(u=>u.hp>0);
        const q=`请指明哪支部队、做什么。当前可选：${U.numbered(alive.map(u=>u.name))}（如"弓兵队驻守北桥"）。`;
        cmdClarify(cmd,q,src,alive.map(u=>({id:u.id,label:u.name})));
        return {status:'CLARIFY',interp:'',feedback:q};
      }
      case 'REPORT':{
        // 87：战地问答（地形／过河点／岸别／可达）。b 层已经把结论说完整了——
        //   这里只负责"说出来"。c 层不拿 BattleContext，也不该拿：地图事实只有一个来源。
        if(cmd.mapAnswer){
          emit(src,cmd.mapAnswer);
          return {status:'EXECUTED',interp:'战地问答',feedback:cmd.mapAnswer};
        }
        // 问敌情（83）：**只答看得见的**。数据源是 `enemyFogState()`——它已经按迷雾过滤过
        //   （live 主将亲见 / lagged 友军看见但滞后 / ghost 只剩最后目击点），
        //   绝不遍历 `sim.enemies` 去数"敌军还有 8 支"：那是开图，60 多项迷雾测试守着的就是这条。
        if(cmd.reportFoe){
          const nF=deliverFoeReport(src);
          return {status:'EXECUTED',interp:'敌情报告',feedback:`敌情：${nF} 条目击`};
        }
        const pool=list.length?list:sim.units.filter(u=>u.hp>0);
        // 一律走 sim.reported()：薄雾区的部队只有"信使带回的旧情报"，不能按真值汇报
        const views=pool.filter(u=>u.hp>0).map(u=>{
          const v=sim.reported(u);
          return {name:v.name,state:v.state,advancing:v.advancing||null,
            lastStopReason:v.stop||null,
            hp:v.hp,maxHp:v.maxHp,morale:Math.round(v.morale),
            stamina:Math.round(v.stamina),stance:v.stance,alert:sim.alertWord(v),
            stale:v.stale||0};
        });
        const lines=pool.map(u=>u.hp>0
          ?`${u.name}：生命 ${u.hp}/${u.maxHp} · 士气 ${Math.round(u.morale)}（${sim.moraleWord(u.morale)}） · 精力 ${Math.round(u.stamina)} · ${u.stance==='FORMED'?'列阵':'散阵'} · ${sim.alertWord(u)} · ${u.state}`
          :`${u.name}：阵亡`);
        // 副将在就由他汇报（带精力/戒备/认知，翻成人话）；不在则回落到字段式输出
        const a=adj();
        if(a)a.deliverOrder(a.reportU(views));
        else emit(src, lines.join('\n'));
        return {status:'EXECUTED',interp:'状态报告',feedback:`报告 ${pool.length} 支部队`};
      }
      // default（69）：**兜底不是为了容错，是为了不静默**。
      //   走到这里说明 cmdValidate 放行了一个 switch 没有分支的动作——
      //   也就是 ACTION_CAPS 里声明了、但 switch 忘了实现。这种不一致以前会让函数
      //   返回 undefined，崩在调用方。现在它变成一条指名道姓的失败回执。
      default:{
        const msg=`内部不一致：动作 ${cmd.action} 在能力表里声明过，但没有对应的执行分支。这条命令没有执行。`;
        emit(src,msg);
        return {status:'FAILED',interp:'',feedback:msg,
          violation:[{code:'NO_BRANCH',detail:cmd.action,ch:ACTION_CAPS[cmd.action]?ACTION_CAPS[cmd.action].ch:'—'}]};
      }
    }
  }

  // ───── 命令日志：记录每条文字命令与它的反馈，量化"多少命令被正确执行" ─────
  // 每条记录：{n 序号, at 游戏秒, text 原句, status, interp 命令解读, feedback 执行反馈, followUp 是否追问补全}
  // 状态七类：EXECUTED 全部受命 · PARTIAL 部分受命 · FAILED 未能执行 · CLARIFY 已追问 · CANCELLED 已取消 · UNSUPPORTED 未实现 · QUEUED 已挂起等条件
  // 成功率口径：（EXECUTED+PARTIAL）/（EXECUTED+PARTIAL+FAILED+UNSUPPORTED），追问不算失败（补全后另记一条）
  // QUEUED（78）既不进分子也不进分母：兵还没动，现在判它成或败都是猜。
  const CMD_LOG_STATUS_LABEL={EXECUTED:'✅ 执行',PARTIAL:'◐ 部分执行',FAILED:'❌ 未执行',CLARIFY:'❓ 已追问',CANCELLED:'✖ 已取消',UNSUPPORTED:'🚫 未实现',OFFTOPIC:'⬜ 无关内容',QUEUED:'⏳ 已挂起'};
  let CMD_LOG=[];
  let onLogChange=null;   // ui.js 注册的渲染回调
  // 68：**这一条命令要谁、做什么、去哪**——结构化记下来，供执行正确率指标判分（§4.3）。
  //   只在 issueCommand 里写、cmdLogCommit 里取用一次就清空；解析失败/追问时它必须是 null，
  //   否则会把上一条的意图贴到这一条上（宁可没意图，也不许贴错）。
  let lastIntent=null;
  try{const saved=localStorage.getItem('cmdLog');if(saved){const parsed=JSON.parse(saved);if(Array.isArray(parsed))CMD_LOG=parsed;}}catch(e){}   // file:// 或测试桩里没有 localStorage，静默跳过
  function cmdLogPersist(){try{localStorage.setItem('cmdLog',JSON.stringify(CMD_LOG.slice(-200)));}catch(e){}}
  function cmdLogCounts(){
    // OFFTOPIC 单独计数：它既不进"成功率"的分母（那不是一次失败的指挥），
    //   也不该被当成"我听懂了但没做到"，所以在统计里自成一列。
    const c={EXECUTED:0,PARTIAL:0,FAILED:0,CLARIFY:0,CANCELLED:0,UNSUPPORTED:0,OFFTOPIC:0,QUEUED:0,total:CMD_LOG.length};
    for(const e of CMD_LOG)if(c[e.status]!=null)c[e.status]++;
    return c;
  }
  function cmdLogCommit(entry){
    entry.n=CMD_LOG.length+1;
    // 68：意图只贴一次。CLARIFY/FAILED 走的多半是 issueCommand 里早退的路径，那时 lastIntent 仍是 null。
    if(lastIntent){entry.intent=lastIntent;lastIntent=null;}
    CMD_LOG.push(entry);
    // 最终结果（状态/理解/反馈）另存一栏：标注时不许看它，否则等于看着答案判分。
    if(api.rec)api.rec('out',entry);
    cmdLogPersist();
    if(onLogChange)onLogChange();
  }
  function exportLog(){
    // 导出 JSON（含统计），用来离线分析或喂给 AI 复盘解析质量
    const data=`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify({exportedAt:new Date().toISOString(),counts:cmdLogCounts(),entries:CMD_LOG},null,2))}`;
    const a=document.createElement('a');a.href=data;a.download='命令日志.json';
    if(a.click)a.click();
  }
  function clearLog(){CMD_LOG=[];cmdLogPersist();if(onLogChange)onLogChange();}

  function wire(handles){
    api=handles;
    U.initRegistry({
      // 83：`role` / `person` 一起注入。b 层不许读 SIM，所以"谁是主将"这件事必须
      //   从这条唯一注入路径过去（原来只有 id/name，b 层根本不知道有主将这回事）。
      // 85：`type`（兵种）同理——「所有枪兵」要展开成哪几支，是**编成事实**，
      //   不能让 b 层按名字里有没有"枪"字去猜（主将队叫「主将队」，它也是枪兵）。
      units:handles.sim.units.map(u=>({id:u.id,name:u.name,role:u.role||null,person:u.person||null,type:u.type||null})),
      enemies:handles.sim.enemies.map(e=>({id:e.id,name:e.name,role:e.role||null,person:e.person||null})),
      // 83：主将画面（`viewTiles()` 折出来的格范围）+ 友军此刻的站位。地名分不开时按这两样收窄——
      //   62 定的"短令只对画面内部队有效"用的是同一个矩形，这里只是让地名也认同一套坐标。
      //   **两样都必须传函数**：相机每帧在跟主将、部队每帧在走，快照会在玩家转头的瞬间过期。
      //   站位只给"活着的"：阵亡部队的坐标停在倒下那一格，留着会让"这桥有人守着"永远为真。
      view:()=>(handles.ui&&handles.ui.viewTiles)?handles.ui.viewTiles():null,
      where:()=>handles.sim.units.filter(u=>u.hp>0).map(u=>({x:u.x,y:u.y})),
      // 地标事实表：不再只给 id/name/坐标，也不给别名——b 层要看 kind/band/area/owner 自己推。
      //   营地归属会变，所以 places 是**函数**：每次解析都现取（"敌人占的营地"才追得上局势）。
      landmarks:handles.sim.LANDMARKS.map(l=>Object.assign({},l)),
      places:()=>handles.sim.read.places()
    });
    // 84：把 CTX 的**只读视图**交给 b 层。传函数不传对象——phase 每 tick 都在变。
    U.wireCtx(ctxView);
    // 86：BattleContext 注入通道。同样传函数（每次现装配），且**这一轮 b 层不消费**——
    //   87 才让理解层拿它做地形/通行性/可达性判断。先建通道的目的见 battle_ctx.js 头注释。
    if(typeof BATTLE_CTX!=='undefined'&&U.wireBattleContext)
      U.wireBattleContext(()=>BATTLE_CTX.build());
    globalThis.__textcmd={submit:submitText,parse:U.parse,
      echo:()=>api.ui.echoText(),pending:()=>!!cmdPending,
      log:()=>CMD_LOG.slice(),counts:cmdLogCounts,clearLog:clearLog,
      queue:()=>activeQueue?queueInfo():null};
  }
  // 队列对外的样子（测试与副将读它）：等在第几段、在等什么、挂了多久。
  //   不暴露 plan 本体——外部要的是"当前状态"，不是可以改的内部结构。
  function queueInfo(){
    const q=activeQueue;
    if(!q)return null;
    const st=q.plan.steps[q.idx];
    const w=st&&st.when;
    return {steps:q.plan.steps.length,idx:q.idx,
      waiting:(w&&w.kind!=='arrived')?{kind:w.kind,text:condText(w),sec:api.sim.simTime-q.since,
        ids:watchIds(q)}:null};
  }

  // 加载即校验：c 层的能力表交给 b 层，让 b 层在产出前就知道边界。
  // 这里**故意让它抛**：表里少一个动作，说明有人只改了词表没改能力表；
  //   这种错必须在启动时停住，而不是等玩家真说到那句话，命令通道才崩在 switch 末尾。
  let capsInfo=null;
  if(typeof U.bindCaps!=='function'){
    console.error('[b→c 契约] understand.js 没有 bindCaps —— 两个文件不是同一版（多半是浏览器缓存）。'
      +'硬刷新一次；仍不行就说明 understand.js 没更新。');
  }else{
    // 第二个参数是战术词能力表：b 层认得出的战术 key 必须在这里有判据，
    //   否则玩家说了「生擒」，b 层标了出来，c 层却当成没说过——那就是静默丢弃。
    try{capsInfo=U.bindCaps(ACTION_CAPS,TACTIC_CAPS);}
    catch(e){console.error(e.message);throw e;}
  }

  globalThis.CMD={
    wire:wire,submit:submitText,tick:tickQueue,queue:()=>activeQueue,
    // 78：队列的对外读数（等待哪一段、等什么、挂多久）。外部读这个，不要读 plan 本体。
    queueInfo:queueInfo,condText:condText,stepArrived:stepArrived,gateOpen:gateOpen,
    // 84：任务上下文（Tasking）的对外读数。和 queueInfo 一个道理：给界面与真机脚本读，
    //   返回浅拷贝，改不动 c 的状态；phase 由 syncPhase() 现场推，不是存下来的旧值。
    ctx:()=>ctxView(),
    // 契约自检（69/70）：供测试与界面查"c 层到底能执行什么、哪些战术词会挡"
    ACTION_CAPS:ACTION_CAPS,TACTIC_CAPS:TACTIC_CAPS,validate:cmdValidate,capsInfo:()=>capsInfo,
    // 四类收拢（71）：OP_KINDS 是唯一的类别全集；opOf 给 b 层出口挂 op；opCount 给测试对账
    OP_KINDS:OP_KINDS,opOf:a=>(ACTION_CAPS[a]?ACTION_CAPS[a].op:null),opCount:()=>OP_COUNT,assertOps:assertOps,
    // 主谓宾/阶段/并行（72）：形状、断言、人话。planOf 把任何命令归一成"1 阶段 × 1 主谓宾"，
    //   所以"这条命令能做几件事"从今天起是一张能查、能断言的结构，不是散在各分支里的循环。
    OP_OBJ:OP_OBJ,planOf:planOf,planOfSteps:planOfSteps,planOfParallel:planOfParallel,
    planOfRing:planOfRing,splitUnits:splitUnits,assertPlan:assertPlan,planText:planText,
    planSelfTest:()=>PLAN_SELFTEST,hasTactic:hasTactic,
    // 96：执行入口。**对外的执行入口只有 execPlanOf**，`issueCommand` 是它内部的单次下发器
    //   （d 层契约是"一条扁平命令"，所以它必须还在）。导出这三样是给闸门量"下发了几次"用的：
    //   拆分规则写在 execPlan 里，测试必须能直接喂一张 plan 进去验证，而不是靠跑一局猜。
    execPlan:execPlan,execPlanOf:execPlanOf,isSwitchStep:isSwitchStep,pinPlan:pinPlan,
    // 90：**只拆不执行**。评估台必须看"玩家实际会被拆成几步"，不能拿 U.parse(整句) 套 planOf:
    //   后者绕过了这一层的 parseChain，88 的对照实验正是这么量的，于是
    //   「全军去南桥，过河之后攻击敌主将队」被判成 FOLLOW（反向动作），而真实链路一直是对的。
    //   尺子量错地方，比被测对象出错更麻烦——它会把一条不存在的缺陷写进台账。
    //   返回 null ＝ 不是组合句（调用方走单命令那条路）。
    previewPlan:function(src){
      const chain=parseChain(src);
      if(!chain)return null;
      if(!chain.ok)return {ok:false,reason:chain.reason,seg:chain.seg};
      return {ok:true,cmds:chain.cmds,plan:planOfSteps(chain.cmds)};
    },
    // 命令日志
    getLog:()=>CMD_LOG.slice(),counts:cmdLogCounts,exportLog:exportLog,clearLog:clearLog,
    set onLogChange(fn){onLogChange=fn},get onLogChange(){return onLogChange},
    CMD_LOG_STATUS_LABEL:CMD_LOG_STATUS_LABEL
  };
})();
