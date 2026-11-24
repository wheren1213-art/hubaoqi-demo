// understand.js — 语义理解层（b 层）：文字 → 意图要素
// 职责：归一化/错字纠正/动作词表/实体别名/解析消歧/问句识别/组合句切分/容错应答理解/语义兜底合并。
// 独立性约定：本文件加载时不依赖 SIM/UI/DOM（纯语言逻辑）；实体表经 initRegistry() 注入，
// 换地图/换实体零改解析。上层入口：intent.js（c 层）调用本层产物，把意图转成行动命令。
// b→c 的交接物：parse() 的结果 {cmd:{action,unitIds,foeId,locId,dir,dist,unsupported}, ...}。
(() => {
  // 动作词表：匹配时最长词优先；同长取位置靠后的（"绕过去再攻击"的主任务是攻击）。
  // 未实现的命令（侦察/跟随）也列入词表，为的是给出明确的"没实现"说明而不是装懂。
  const TXT_ACTIONS=[
    // 「渡河」原来挂在"允许过河"名下，是错的：它只是"过河"这个动作，不是许可。
    //   61 起移到 MOVE（"渡"本来就在 MOVE 里），许可只认"可以/允许/准许过河"。
    //   不改的话"等他们渡河到一半再打"会被读成一条"开放渡口"的许可令，主任务整个丢掉。
    ['RIVER_OFF', ['可以过河','允许过河','准许过河','同意过河','解除过河','解除限制','开放渡口']],
    ['RIVER_ON',  ['不要过河','禁止过河','别过河','不过河']],
    // 109：**"列阵"不再是一句"没设计"**——阵型与戒备打通之后，"列阵"就是转入戒备
    //   （保持战斗队形）。这四个词原来在 `NOT_YET` 里回"阵型数值还没定"，现在归到这一条。
    ['STANCE_ON', ['转入戒备','进入戒备','戒备状态','提高警惕','保持戒备','戒备','警戒','警惕','绷紧',
                   '列阵','结阵','布阵','摆阵']],
    ['STANCE_OFF',['转为常行','解除戒备','取消戒备','恢复常行','常行']],
    // 101：加速行军。**只收"没有去向"的说法**——带「前进／去某处」的句子由下面的
    //   `FORCED_RE` 还原成「主令 ＋ 第二段开档位」，否则词表按长度取胜会把去向整段吃掉。
    //   「急行军／强行军」都含「行军」（MOVE 的词），靠"最长优先"才能压住，别再拆短。
    ['FORCED_ON', ['加速行军','急行军','强行军','快速行军','加快行军','加速赶路','快步行军','加速']],
    ['FORCED_OFF',['常速行军','常规行军','转常速','回常速','恢复常速','恢复正常行军','恢复常规行军','恢复行军速度',
      '取消加速行军','停止加速行军','取消加速','停止加速','不必加速','放缓行军','放慢行军','按常速',
      // 带否定的整句必须**比被否定的词更长**，否则"最长优先"会把「不加速行军」读成「加速行军」。
      '不加速行军','不加速','不再加速行军','不用加速行军','别加速行军','别加速']],
    ['RALLY',     ['集结','集合','站到一起','聚到一起','靠拢','抱团','聚拢','收拢']],
    ['CAPTURE',   ['占领','夺取','拿下','夺下','抢占','攻占',
      // 90：「占下来/占住」是"占领"最口语的说法，原来一个都不在表里，于是
      //   「全军去东侧营地，到了就占下来」的第二段认不出动作，整条组合令被判"第 2 段无效"——
      //   玩家说了要占，系统整条不办。只收两字以上的（单字"占"会接住"占卜"这类无关词）。
      '占下来','占下','占住','占了']],
    ['ATTACK',    ['攻击','进攻','围攻','打击','消灭','干掉','打掉','出击','冲锋','掩杀','冲杀','直取','放箭','冲阵','强攻','冲上去','集火','开始攻击','自由射击','贴脸','打过去','杀过去','杀出去','我们上','冲啊','杀啊','擂鼓','一鼓作气','都给我冲','冲呀','扫荡','平推','搜索前进','打','夺回','冲杀','接战','直捣','截杀','杀出城','杀出去','骑兵冲锋','放箭','生擒','活捉','起兵','出兵',
      // ↓ 战术术语扩充（docs/tactical_terms.md 2.1，现状 ✅ 的进攻类同义组）
      '突击','突袭','奇袭','偷袭','奔袭','急袭','硬攻','死磕','硬冲','总攻',
      '追击','追杀','追歼','集中火力','火力覆盖',
      // ↓ 61 补：玩家真会说的短促军令。**单字动词只收"在本游戏里几乎不会有别的意思"的**
      //   （冲/杀/追/射），"上/守/停"这类最容易夹在生活用语里的（马上、上面、停下思考）留给短令表，
      //   短令表只在**整句就是它**时才认，见 SHORT_MAP。
      //   包抄/迂回/穿插/压上 以前只进"未实现"注记、不进动作表，结果"往他们右边包抄"没有动作可执行；
      //   它们是货真价实的进攻动作，注记照旧保留（路线偏好仍未实现），动作要认得出来。
      '冲','杀','追','射','射箭','射击','齐射','击溃','包抄','包夹','夹击','迂回','穿插','上去',
      '上啊','上呀','冲进去','冲进','冲入',
      // 62 补：反击/回击。原来不在表里，「全军撤退并反击」只剩"撤退"一个动作，
      //   于是被当成一条正常的撤退令**直接执行**——而它其实是句矛盾话（见 selfConflict）。
      '反击','回击',
      // 98（Q36）：全力冲锋的四个说法已在 cmdNorm 精确归一成「全力冲」，这里只收归一后那一个。
      //   「冲锋」「冲」「硬冲」**仍是普通进攻**（Q32 要区分两者），不许一起改判；
      //   「全速前进」不含「冲」，永远不会命中——那句里「全」只是速度修饰。
      '全力冲',
      // 72 补：合围/包围/围住/围困/围歼 是**谓语**，不是修饰语。
      //   以前它们只挂在 TACTICS 注记和 CMD_PHRASE（判"在不在讲战场"）里，
      //   「全军合围敌枪兵队」落到 c 层只有"要部队做什么？"——玩家说了动作，却被告知没说动作。
      //   现在它们进 ATTACK：谓＝打（怎么打由 tactics 的 encircle 说清），宾＝被围的那支/那处。
      //   「围点打援」故意不收：它不是"打那个点"，是"围点＋伏击援军"两阶段，
      //   当作普通进攻执行会和玩家心里的打算完全相反（见 TACTIC_CAPS 的 blocking 判据）。
      '合围','包围','围住','围困','围歼',
      // 75：「跟我上」原来挂在 GUARD_ME（护卫我）名下，方向正好相反——
      //   一个是往前冲，一个是围着我守。它是**进攻**，宾语缺省＝前方敌人。
      '跟我上','兄弟们跟我上']],
    ['DEFEND',    ['驻守','防守','守住','坚守','防御','守卫','退守','坚守不出','压住阵脚','据守','把守','把住','压阵','顶住','蹲坑','蹲点','守线','稳住','稳住战线','守阵地','别让他们过来','给我顶住','守','卡住要道','堵口',
      // 75 移出本行：「安营/扎营/下寨/扎寨」是**扎营**（状态，未做），不是驻守；
      //   「筑垒/深沟高垒」是修工事（未做）。以前它们被当"守"的同义词收进来，
      //   玩家说"扎营"得到"去中央营地驻守"——名字相近不等于动作相同。见 NOT_YET。
      // 「拦住/挡住/堵住/封锁」留在表里，但**由宾语改判**：宾语是敌军→攻击，是地点/没有→守。
      // 61 补：驻防（纠正表里"住防→驻防"早就在，词表却没有，纠了也认不出）、硬顶/死顶（"顶住"的口语变体）
      // 90 补：留在/留驻。"骑兵队过南桥，弓兵队留在北岸"里的"留在"原来不在任何词表里，
      //   于是整句被读成"两支部队一起过河"——玩家明说了有一支不动，系统把两支都拉走了。
      //   与 MOVE 的冲突已核：MOVE 认的是"到/去/往"，不含"在"。
      '驻防','硬顶','死顶','堵住','守住阵脚','拦住','挡住','封锁','留在','留驻',
      // 113+：「留下」「待着」——与「留在」是同一件事（兵停在这儿不走），原来只有"留在"在表里，
      //   于是「把弓兵队留下」「在那儿待着」都回一句"要部队做什么"。
      //   不收单字「待」：「待命」已在 STOP、且"待人接物"这类说法不该变成军令。
      '留下','待着','待这儿','待那儿','待原地']],
    ['RECON',     ['侦察','侦查','搜索','探查','探路']],
    ['RETREAT',   ['撤退','后撤','撤回','退回','撤下','且战且退','收兵','鸣金','撤军','撤到','退到','撤往','跑路','溜了','拉扯','快跑','快退','闻金而退','全线后退','全线撤退','拔寨退兵','拔寨','撤',
      // 61 补：往后退的说法（后退/退缩/往后缩/往后拉/往回撤）——「后退」原来只在 CMD_PHRASE 里，
      //   能判"在讲战场"却认不出动作；「跑」是单字，同上只在这一层收。
      '后退','退缩','后缩','往后缩','往后拉','往回撤','往回退','后拉','跑','退宿']],
    ['STOP',      ['原地待命','按兵不动','停止','停下','待命','别动','站住','取消','停',
      // 75 移出：「停战」不是部队的动作（政治决定）；「休整/歇会」是恢复（未做）——
      //   它们原来都落 STOP，玩家说"休整"得到"站着不动"，是两件事。
      ]],
    ['REPORT',    ['报告情况','汇报情况','军情如何','军情','战况','报点','报一下','报告','汇报','怎么样','状态如何','状态']],
    ['CALL_ARMS', ['派出援军',
      // 75 移出：「列阵/准备迎战/弓箭手准备」全不是"叫援军"——分别是阵型（未给数值）、
      //   驻守/戒备、放箭。见 NOT_YET。
      ]],
    ['GUARD_ME',  ['火力掩护我','掩护我']],
    ['FOLLOW',    ['跟随','跟上','跟着','护卫','保护','协同','掩护']],
    ['MOVE',      ['移动','前进','前往','赶往','开往','行军','进发','推进','转移','驰援','支援','挺进','压上','回营','回师','出发','动身','过江','过去','过','渡','跨','走','去','到',
      // 61 补：接近/靠近/逼近（"从侧面接近敌人"）、绕过/绕开（"绕开森林"）、过来/回来（"他们过来了吗"）
      //   这几个都是移动语义；不收的话句子有战场名词、没动作，只能回一句"要部队做什么"。
      '接近','靠近','逼近','绕过','绕开','过来','回来','回撤','开赴','开进',
      // 方位短语当动作："别再往前了"里的"往前"是"继续走"，配否定词才翻得出"停"。
      '往前','往后','往左','往右']]
  ];
  const CMD_VERBS={MOVE:'前往',DEFEND:'驻守',CAPTURE:'占领',RALLY:'集结于',ATTACK:'攻击',RETREAT:'撤退',STOP:'停止',
    STANCE_ON:'转入戒备',STANCE_OFF:'转为常行',REPORT:'报告',RECON:'侦察',FOLLOW:'跟随',
    RIVER_ON:'禁止过河',RIVER_OFF:'允许过河',CAPTURE_ON:'活捉',RUSH_ON:'全力冲锋',
    FORCED_ON:'加速行军',FORCED_OFF:'转常速行军'};

  // 错字/同音纠正表：只收确定性映射，不搞模糊匹配——纠正后原句与改写在日志里都可追溯。
  const CORRECTIONS={急结:'集结',集节:'集结',警备:'戒备',界备:'戒备',
    澈退:'撤退',撤煺:'撤退',澈回:'撤回',公击:'攻击',攻即:'攻击',宫兵:'弓兵',抢兵:'枪兵',
    聚点:'据点',巨点:'据点',剧点:'据点',告地:'高地',予期:'预期',站领:'占领',退宿:'撤退',极火:'集火',住防:'驻防',接战:'接战',
    // 75：删掉「宿营→驻守」。宿营是**状态**（+8、回血），驻守是**命令**，纠错表把两个
    //   状态纠成一个，等于替玩家改了口令。宿营现在明确回"还没做"（见 NOT_YET）。
    // ↓ 61 补：训练语料里真出现的两个。「宫击」是"攻击"的声母错；
    //   「全君」是"全军"的同音错——不纠正就丢了主语，"全君撤腿"只能回一句"要做什么"。
    //   注意「退宿→撤退」是本轮改的：原来纠正成"退缩"，而词表里根本没有"退缩"，
    //   等于纠正了个不存在的词（现在"退缩"也进了词表，这条改回更直接的"撤退"）。
    宫击:'攻击',全君:'全军',
    // ↓ 语音识别实测出来的同音错（2026-10-27，20 条 TTS 命令跑本地 sherpa 得到，见 .workbuddy/voice_accuracy.py）。
    //   放在 b 层而不是语音层：a 层只负责把声音转成字，纠正语义是 b 层的事。
    //   只收"本游戏里不可能有别的意思"的：弓→工/枪→相·香 都是声母韵母接近导致，工兵在本 demo 没有兵种对应。
    工兵:'弓兵',相兵:'枪兵',香兵:'枪兵',香柱:'枪兵队',三联:'三连',
    // ↓ 战术术语同音错（2026-10-27，见 docs/tactical_terms.md 第 3 节）。
    //   只收确定性映射；与常用词撞车的**故意不收**（有敌→诱敌 / 把手→把守 / 扎在→扎寨 /
    //   抢攻→强攻 / 总工→总攻 / 合为→合围 / 移兵·一兵→疑兵）——否则"前方有敌"会被改成"前方诱敌"、
    //   "总工程师"会被改成"总攻程师"，属于把正常话讲坏，比不纠正更糟。
    包家:'包夹',报夹:'包夹',佳击:'夹击',家击:'夹击',夹机:'夹击',包超:'包抄',包钞:'包抄',包巢:'包抄',
    合违:'合围',河围:'合围',围点打圆:'围点打援',围点打远:'围点打援',
    余回:'迂回',鱼回:'迂回',迂迴:'迂回',穿叉:'穿插',串插:'穿插',川插:'穿插',分哥:'分割',分歌:'分割',
    前形:'钳形',钱形:'钳形',潜形:'钳形',
    羊攻:'佯攻',扬攻:'佯攻',阳攻:'佯攻',炸败:'诈败',咋败:'诈败',炸降:'诈降',咋降:'诈降',
    声东击夕:'声东击西',声东击希:'声东击西',半度而击:'半渡而击',半渡而急:'半渡而击',
    饿守:'扼守',厄守:'扼守',恶守:'扼守',句守:'据守',
    迟援:'驰援',持援:'驰援',池援:'驰援',争援:'增援',增原:'增援',接映:'接应',结应:'接应',侧应:'策应',册应:'策应',
    雷鼓:'擂鼓',累鼓:'擂鼓',泪鼓:'擂鼓',明金:'鸣金',鸣今:'鸣金',名金:'鸣金',
    拔债:'拔寨',八寨:'拔寨',拔在:'拔寨',赤候:'斥候',翅候:'斥候',斥后:'斥候',少探:'哨探',稍探:'哨探',哨碳:'哨探',
    烈阵:'列阵',列镇:'列阵',结镇:'结阵',接阵:'结阵',
    左意:'左翼',左义:'左翼',右意:'右翼',右义:'右翼',两意:'两翼',两义:'两翼',
    鹤意:'鹤翼',和翼:'鹤翼',鱼林:'鱼鳞',玉鳞:'鱼鳞',掩月:'偃月',眼月:'偃月',
    抢度:'抢渡',墙渡:'强渡',战框:'战况',站况:'战况',代命:'待命',带命:'待命',
    根随:'跟随',护位:'护卫',互卫:'护卫',考拢:'靠拢',修整:'休整',
    // ↓ 92：只收**结构上必错**的三条（同音字不做拼音模糊匹配，那是猜，见 ROADMAP 92 的"不做"栏）
    //   侨→桥：「全军去北侨」现在只剩一个"去"，地点解不出 → 追问 19 处地名；
    //     "侨"在本 demo 的军令语域里没有第二个意思（"华侨"剥成"华桥"也不影响域外判定）
    侨:'桥',
    //   住守→驻守：语音里"驻"几乎总被写成"住"，而"住守"不是词；**不收单字"住"**
    //     ——"住手"是叫停，"守住"里的"住"是补语，收了会把两句正常话讲坏
    住守:'驻守',
    //   撤腿→撤退：**不收单字"腿"**——"拖后腿"是真词，收了就成了静默改写
    撤腿:'撤退'};

  // 实体别名：语言知识留在 b 层；id 与坐标等地图知识由模拟层经 initRegistry 注入。
  const UNIT_ALIASES={
    INF:['枪兵队','枪兵','长枪兵'],
    ARC:['弓兵队','弓兵','弓箭手'],
    CAV:['骑兵队','骑兵','铁骑'],
    ALL:['全军','全部','全体','所有部队','大家','所有人','各位','弟兄们','兄弟们',
      // 61 补：三军/各队/众将/全体将士 都是"全体"的口语说法。
      //   「各队」尤其要紧——开场白剥离原来把"各队注意"整段删掉，主语跟着没了，
      //   现在剥成"各队"（见 parseCommand 的第一行替换）。
      '三军','各队','众将','全体将士','诸位']
  };
  const FOE_ALIASES={
    E_INF:['敌枪兵队','敌枪兵','敌方枪兵'],
    E_ARC:['敌弓兵队','敌弓兵','敌方弓兵'],
    E_CAV:['敌骑兵队','敌骑兵','敌方骑兵']
  };
  // 地标**不再有固定别名表**（2026-10-30 57 删掉）。
  // 56 的做法是给每个地标配一串别名：FOR_N → ['北面森林','北边森林','西北森林',…]。
  //   上司否掉了这条路：名字应该是"地图上有什么"的描述，而且**不同玩家叫法不一样**——
  //   "北边那片林子""上面的树林""敌人占的那处营地"都得听得懂，靠穷举别名永远补不齐。
  // 现在改成三步解析（见下面的 placeQuery / landmarkCandidates）：
  //   ① 认**地形类别词**（森林/树林/林子/树…都算一路）
  //   ② 抽**限定语**（方位：北/上/左上；岸：我方这岸/对岸；归属：敌人占的/中立；远近：最近的/最远的；大小：大片/小片）
  //   ③ 拿限定语给候选地标**打分**，分高者胜；分不开就问，不猜。
  // 地标表里的 kind / band / area / owner 全部是生成器按实际位置算出来的**事实**，
  //   不是预设的名字——地图上没有树林，就没有"树林"这个地标，说"去树林"会被如实回"没有"。

  // 锚点词表（2026-10-28 ㊷）：**会动的目标，不是地点**。
  // 为什么必须单列：主将的坐标每帧都可能变。当成地标写进 LANDMARK_ALIASES，就会在下令那一刻
  //   被换算成一个固定格子——那正是上司否掉的 A 方案（一次性），而且要改注册表签名。
  // "我" 不放进这里：它太容易出现在别的位置（"我命令全军戒备"），只在
  //   FOLLOW/MOVE/RALLY 三种动作下才算锚点，见 anchorOf。
  // 故意不收"中军"——它同时是阵型/翼侧词（见下方 unsupported 那组），收进来会把
  //   "中军压上"这类说法从阵型注记变成"向我靠拢"。
  const ANCHOR_ALIASES={COMMANDER:['主将','将旗','主帅','主公','大将']};
  // 问敌情的两个判据（83）：必须**同时**成立才把这句话接成"报告敌情"，理由见 parseCommand 里的注释。
  const FOE_REF=/(敌|对面|对方|他们)/;
  const FOE_ASK=/(在哪|到哪|几支|几路|几股|多少|剩几|还剩|伤亡|损失|动向|动静|情况|怎么样|如何|报一下|报告|汇报)/;  const ANCHOR_ACTIONS=['FOLLOW','MOVE','RALLY'];
  // "我" 但排除"我方/我军/我部/我们"——那些指全体，不是主将个人
  const SELF_RE=/我(?!方|军|部|们)/;
  // 但"我带/我率/我领/我命/我让"里的"我"是**主语**，不是"向我靠拢"的那个目标。
  //   61 之前"我带骑兵绕后，你们正面压上"被读成"全军向主将靠拢"（FOLLOW），
  //   命令从"进攻"变成了"跟随"，是最典型的"主语当成宾语"。
  const SELF_SUBJECT=/(我带|我率|我领|我亲率|我命|我令|我让|我去|我来|我叫|等我|等我一下)/;

  // 注册表：{units:[{id,name}],enemies:[{id,name}],landmarks:[{id,name,x,y}]}
  let REG={units:[],enemies:[],landmarks:[]};
  function initRegistry(reg){
    REG={
      units:reg.units||[],
      enemies:reg.enemies||[],
      landmarks:reg.landmarks||[],
      // 87：地标**事实表**。83 写在这里的注释说"`places` 是函数、每次现取"，
      //   但赋值清单里漏了这一行 —— 于是 placeList() 一路回落到 landmarks，
      //   而那张表没有 `d`、没有营地归属、也没滤掉 hidden：
      //     · 远近打分整段被 `ctx.maxD > 0` 短路 →「最近的营地」靠名单顺序碰巧对，
      //       「最远的营地」挑到最近那处，「最近的高地」挑到全图最远那座；
      //     · 「敌人占的营地」永远回"图上没有"（owner 不在表里，不可能命中）；
      //     · 生成器留在 LANDMARKS 里的隐藏标记（OBJ）也当成了真地名在匹配。
      //   这一条是 83 留下的活缺口，87 修：注入了就用，没注入仍回落 landmarks
      //   （老单测只给 landmarks，行为不变）。
      places:typeof reg.places==='function'?reg.places:(Array.isArray(reg.places)?(()=>reg.places):null),
      // 83：两个**函数**口。画面与站位每帧都在变，存快照等于拿开机那一帧去判断。
      view:reg.view||null,
      where:reg.where||null
    };
  }
  // 注册表只读出口：同层的语义兜底（semantic.js）要靠它建实体语料，
  // 不许它反过来直接读 SIM——那是 d 层的东西，b 层只认这份注入表。
  // 返回浅拷贝数组，调用方改不动内部状态。
  function registry(){
    return {units:REG.units.slice(),enemies:REG.enemies.slice(),landmarks:REG.landmarks.slice()};
  }
  // 只用来"文本里是否原样出现了某个地名"——不做同义扩展，同义走 placeQuery。
  function landmarkWords(){const t={};for(const l of REG.landmarks)if(l.name)t[l.id]=[l.name];return t;}
  // 我方的身份词（83）：主将自己的叫法。**只挂到主将那一支**，不挂给别的部队。
  //   「元帅」「首领」这类也收：玩家不会把"我们的元帅"理解成一支普通枪兵队。
  const ROLE_SELF_WORDS=['主将队','主将','本将','主帅','大将','统将','元帅','首领','头目'];
  // 我方主将：把"身份词"直接挂到那支部队的别名上。**它们是别名不是改名**——
  //   玩家说「主将去北桥」「主将进攻」时，"主将"要能当主语，而当主语需要的是一个
  //   `unitWords()` 里认得的词。改名只解决"显示成什么"，解决不了"叫得响不响"。
  function unitWords(){
    const t={};
    for(const u of REG.units)t[u.id]=[u.name,...(UNIT_ALIASES[u.id]||[])];
    const mine=myCommander();
    if(mine)t[mine.id]=[...(t[mine.id]||[]),...ROLE_SELF_WORDS];
    if(REG.units.length)t.ALL=UNIT_ALIASES.ALL;
    return t;
  }
  function foeWords(){const t={};for(const e of REG.enemies)t[e.id]=[e.name,...(FOE_ALIASES[e.id]||[])];return t;}
  function unitName(id){const u=REG.units.find(x=>x.id===id);return u?u.name:id;}
  function foeName(id){const e=REG.enemies.find(x=>x.id===id);return e?e.name:id;}
  function landmarkById(id){return REG.landmarks.find(l=>l.id===id)||null;}
  function landmarkNames(){return REG.landmarks.map(l=>l.name);}

  // ── 角色称呼：主将（83）──────────────────────────────────────────
  // 主将以前只有 `leader.kind==='commander'` 这个数据标记，**没有名字**：我方叫「枪兵队」，
  //   敌方叫「敌枪兵队」，所以「攻击敌主将」点不到目标（82 体检的阻断项）。
  // 修法**不是**给主将加一串别名——那和 57 删掉的地标别名表是同一个坑，穷举永远补不齐
  //   （上司要的是"敌主将、对方主将、敌军主将都听得懂"）。改成一条**生成规则**：
  //     ① 敌对修饰词 + 角色词 → 敌方主将
  //     ② 光秃秃的角色词   → 我方主将
  //   命中之后在文本上**归一成实体名**，因为后面点名、打分、消歧全都按"文本里出现了实体名"走。
  //   角色词表只放"身份"词：主将队是枪兵，但「枪兵」指的是另一支，那不是身份词。
  //   人名（`person`）不在这里处理——它由 sim 直接写进实体名（见 sim.js `ARMY_ALL[0].person`），
  //   所以"填了人名就人名叫得响、角色名也照旧叫得响"是自动成立的。
  const ROLE_WORDS='主将队|主将|主帅|大将|统帅|统将|元帅|首领|头目|本将';
  const ROLE_FOE_MARK='敌方的?|敌军的?|敌人的?|敌|对方的?|对面的?|他们(?:的)?|那边的?';
  // 「帅」「将」只有戴上敌对修饰才算数：光秃秃的「将」太脏——「将军」（称呼）、「将士」「将领」
  //   都会误伤，而「敌将」「敌帅」是干净的说法。所以它们只出现在带前缀那一条规则里。
  const ROLE_FOE_EXTRA='帅|将(?!军|士|领|旗)';
  function roleOf(list){return (list||[]).find(x=>x&&x.role==='commander')||null;}
  function myCommander(){return roleOf(REG.units);}
  function foeCommander(){return roleOf(REG.enemies);}
  // 占位符只走一遍替换链：先落成占位、最后统一换名。
  //   直接替换会自己吃自己——「敌主将」→「敌主将队」之后，裸词规则又把里面的「主将」再换一次，
  //   变成「敌主将队队」（第一版就这么写坏过）。
  const ROLE_PH_F='\u0001F\u0001';
  // **只归一敌方**。我方不改文本：主将自己的名字本来就在 `unitWords()` 里（见下），
  //   而「主将 / 向主将靠拢」这套锚点机制是按**原词**判的（`ANCHOR_ALIASES`）。
  //   把「主将」改写成实体名会把锚点词从文本里抹掉——除非实体名正好含"主将"，
  //   那就变成"改个名字就把跟随功能改没了"的隐性耦合。
  function normalizeRoles(raw){
    const foe=foeCommander();
    if(!foe)return String(raw||'');
    let s=String(raw||'');
    s=s.replace(new RegExp('('+ROLE_FOE_MARK+')\\s*(?:'+ROLE_WORDS+'|'+ROLE_FOE_EXTRA+')','g'),()=>ROLE_PH_F);
    return s.split(ROLE_PH_F).join(foe.name);
  }

  // ── 指代解析：事实 + 泛化（2026-10-30 57）──────────────────────────
  // 输入一句话，输出"它指的是哪一处地标"（可能多处＝需要追问，可能一处都没有）。
  //
  // 类别词表按**匹配长度**定胜负，不按数组顺序：说"营地"时 base(本营) 和 camp(营) 都会命中，
  //   靠长度让"本营"赢"营"；说"河滩"时 marsh(河滩) 赢 river(河)。
  const KIND_DEFS = [
    ['base', /(本营|大营|主营|主寨|老营|老巢|营寨|营垒|本阵|大后方|后方|后阵|老家|出发点|回营|归营|返营|收兵回营)/],
    ['camp', /(营地|营盘|据点|目标点|补给点|补给站|前哨站|前哨|寨子|营)/],
    ['bridge', /(桥头|桥梁|浮桥|渡口|渡河处|过河点|桥)/],
    ['forest', /(森林|树林|林子|林中|林里|树丛|密林|树|林)/],
    ['hill', /(高地|山脊|山岭|山岗|山头|山坡|山上|山顶|岭|山)/],
    ['marsh', /(洼地|河滩|滩涂|沼泽|烂泥|泥滩)/],
    ['river', /(河流|河道|河水|河)/],
  ];
  function kindOf(text) {
    let best = null;
    for (const [k, re] of KIND_DEFS) {
      const m = re.exec(text);
      if (!m) continue;
      if (!best || m[0].length > best.len || (m[0].length === best.len && m.index < best.at)) {
        best = { k, len: m[0].length, at: m.index };
      }
    }
    return best ? best.k : null;
  }
  // 方位词：**先长后短**。复合词（西北/左上）必须赢过单字（北），
  //   否则"西北的树林"会被读成"北边的树林"。
  // 表里三列 = [词, 南北, 东西]；只定一个轴的写 null（"左边"只定东西，不定南北）。
  // 上下左右一律只认**方位说法**（上面/上边/顶部/右上…），不认裸字——
  //   裸"上"在"压上高地""追上敌人"里到处都是，认了会把方向搞反。
  const DIR_TOKENS = [
    ['西北', 'n', 'w'], ['左上', 'n', 'w'], ['上左', 'n', 'w'],
    ['东北', 'n', 'e'], ['右上', 'n', 'e'], ['上右', 'n', 'e'],
    ['西南', 's', 'w'], ['左下', 's', 'w'], ['下左', 's', 'w'],
    ['东南', 's', 'e'], ['右下', 's', 'e'], ['下右', 's', 'e'],
    ['北面', 'n'], ['北边', 'n'], ['北侧', 'n'], ['北部', 'n'], ['北方', 'n'],
    ['北头', 'n'], ['北端', 'n'], ['正北', 'n'], ['北岸', 'n'], ['北境', 'n'], ['北边儿', 'n'],
    ['上方', 'n'], ['上面', 'n'], ['上边', 'n'], ['上侧', 'n'], ['顶部', 'n'], ['顶上', 'n'], ['上头', 'n'],
    ['南面', 's'], ['南边', 's'], ['南侧', 's'], ['南部', 's'], ['南方', 's'],
    ['南头', 's'], ['南端', 's'], ['正南', 's'], ['南岸', 's'], ['南境', 's'],
    ['下方', 's'], ['下面', 's'], ['下边', 's'], ['下侧', 's'], ['底部', 's'], ['底下', 's'], ['下头', 's'],
    ['东面', null, 'e'], ['东边', null, 'e'], ['东侧', null, 'e'], ['东部', null, 'e'], ['东方', null, 'e'],
    ['东头', null, 'e'], ['东端', null, 'e'], ['正东', null, 'e'], ['东岸', null, 'e'],
    ['右边', null, 'e'], ['右侧', null, 'e'], ['右面', null, 'e'], ['右手边', null, 'e'], ['右首', null, 'e'],
    ['西面', null, 'w'], ['西边', null, 'w'], ['西侧', null, 'w'], ['西部', null, 'w'], ['西方', null, 'w'],
    ['西头', null, 'w'], ['西端', null, 'w'], ['正西', null, 'w'], ['西岸', null, 'w'],
    ['左边', null, 'w'], ['左侧', null, 'w'], ['左面', null, 'w'], ['左手边', null, 'w'], ['左首', null, 'w'],
    ['中间', 'mid'], ['中央', 'mid'], ['正中', 'mid'], ['中路', 'mid'], ['中部', 'mid'], ['中段', 'mid'],
    ['北', 'n'], ['南', 's'], ['东', null, 'e'], ['西', null, 'w'],
  ];
  // 相对说话人的"这岸 / 那岸"
  const SIDE_HOME = /(我方这岸|我们这岸|我岸|本岸|这岸|这边|我方一侧|自家这岸|后方|后边|后面|大后方|我后方|自家地盘)/;
  const SIDE_FAR = /(对岸|对面|河对岸|敌岸|敌人那边|敌方那岸|敌人后方|敌后|前线|前沿|前方|前面|前边)/;
  // 归属：营地/本营是**有主人的**，局势一变指代就跟着变（"敌人占的那处营地"）。
  const OW_RED = /(敌人占|敌方占|敌军占|敌占|被敌人|落在敌人|敌人控制|敌人手[里上]|敌人拿|敌人夺|敌营|敌军占领|敌人手里)/;
  const OW_BLUE = /(我们占|我方占|我军占|被我们|我们控制|我们拿|我们夺|我们的|我方的|我军的|自己人|自家占)/;
  const OW_NONE = /(中立|没人守|无人守|空着|空的|没归属|还没拿下|没有主人|无主|没人占|无人占据)/;
  const Q_NEAR = /(最近|附近的|近处|跟前|旁边|最近的|就近)/;
  const Q_FAR = /(最远|远处|最远的|远端)/;
  const Q_BIG = /(大片|大的|最大|大块|很大|最广)/;
  const Q_SMALL = /(小片|小的|最小|小块的|最小|一小)/;
  // 87：地形价值。「最高的那处」——高度是地图事实（heightAt），不是策略判断。
  const Q_HIGH = /(最高|最高的|高一点|高些|更高|地势高)/;
  // 87：**空间限定**（林子里／桥边／河滩上）。它修饰的是"要找的那类地方"，
  //   不是类别本身：「守住林子里那处营地」要去的是**营地**，林子只是条件。
  //   顺序即优先级：先认长词，避免"桥头"被"桥"抢先（表里没有裸"桥"）。
  //   **必须带"的/那/这"这个后接标记**（lookahead）：没有它，「那片树林在河的哪边」
  //   里的"树林"会被当成限定语摘掉，剩下"在河的哪边"反而被读成"去河边"——
  //   问句于是变成一条移动令，这是 87 第一次实现时实测踩到的。
  const ADJ_DEFS = [
    ['forest', /(?:树林|森林|林子|林中|林里|密林|树丛|林间)(?:里|中|内|里头|里面|深处|边上|旁边|附近)?(?=的|那|这)/],
    ['bridge', /(?:桥头|桥边|桥旁|桥下|桥附近|桥那头)(?=的|那|这)/],
    ['marsh', /(?:河滩|滩涂|沼泽|洼地|烂泥)(?:里|上|边|附近|中)?(?=的|那|这)/],
  ];

  function placeList() { return (REG.places && REG.places()) || REG.landmarks; }
  // ── 分不开时按"主将画面"收窄（83，上司 2026-11-04 定）──────────────────
  // 为什么以前"桥有多处"整条作废：候选池是**全图**的，四座桥一起摆出来问，
  //   而玩家眼前的画面里往往只有一座。让玩家对自己看不见的地方选一处，这不是严谨，是刁难。
  // 四级，顺序不能换：
  //   ① 某一处上面（或 3 格内）有部队站着 → 就是那一处。"部队已经在桥上"这句话本身
  //      就是在说"守的是这座"，这时候再问一遍是没听懂人话。
  //   ② 画面里只剩一处 → 就是它。
  //   ③ 画面里两处以上 → 追问（用画面内的那几处，不再列全图）。
  //   ④ 画面里一处都没有 → 也追问，但要说清"画面里没有桥"并给全图——
  //      否则玩家会以为是自己没说清，换个说法再试，越试越远。
  const NEAR_SELF = 3;
  function narrowByView(pool) {
    const spots = (REG.where && REG.where()) || [];
    const near = pool.filter(p => spots.some(s =>
      Math.abs(s.x - p.x) + Math.abs(s.y - p.y) <= NEAR_SELF));
    if (near.length === 1) return { ids: [near[0].id], why: 'units' };
    if (near.length > 1) return { ids: near.map(p => p.id), why: 'units' };
    const v = (REG.view && REG.view()) || null;
    if (!v) return { ids: pool.map(p => p.id), why: null };
    const inView = pool.filter(p => p.x >= v.x0 && p.x <= v.x1 && p.y >= v.y0 && p.y <= v.y1);
    if (inView.length === 1) return { ids: [inView[0].id], why: 'view' };
    if (!inView.length) return { ids: [], why: 'none' };
    return { ids: inView.map(p => p.id), why: 'view' };
  }
  const KIND_CN = { base: '本营', camp: '营地', bridge: '桥', forest: '树林', hill: '高地', marsh: '河滩', river: '河' };
  // 95① 「视野好／有利位置」是**硬限定词**，与「林子里／这岸／最高的」同级（87 决策）。
  //   放在 placeQuery 之前定义：它是解析期就要用的判据，不依赖任何地图事实。
  const SIGHT_LIMIT_RE = /(视野好|视野最好|看得远|看得到桥|能看到桥|有利位置|制高点|视野开阔|望得远)/;
  // 我方在河哪一岸：从事实表里读（蓝方本营在哪岸）。b 层不碰 SIM，只读注入的事实。
  function ourSide() {
    const b = placeList().find(p => p.kind === 'base' && p.owner === 'blue');
    return b ? b.area : null;
  }
  // 动词里的"营/寨"不是地名：「扎营/安营/下寨/扎寨/宿营/拔营/拔寨」里的字是动词的宾语，
  //   不是图上哪一处地方。不剔掉的话，单字"营"会被 KIND_DEFS 的 camp 接住，
  //   「全军扎营」就变成"去中央营地驻守"——凭空给玩家补了一个他从没说的地点。
  const CAMP_VERB=/(扎营|安营|下寨|扎寨|结营|立营|宿营|拔营|拔寨)/g;
  // 把一句话拆成"要找什么样的地方"
  function placeQuery(text0) {
    const rawText = String(text0 || '').replace(CAMP_VERB, '');
    // 87：先把空间限定摘出来（见 ADJ_DEFS 的注释）。**摘掉之后必须还剩一个类别词**
    //   才算限定语——否则「全军去树林」里的"树林"本身就是目的地，摘掉就什么都不剩了。
    let text = rawText, adj = null;
    for (const [k, re] of ADJ_DEFS) {
      const m = re.exec(text);
      if (!m) continue;
      const stripped = text.replace(re, '');
      if (kindOf(stripped)) { adj = k; text = stripped; }
      break;
    }
    const q = { kind: kindOf(text), ns: null, ew: null, mid: false, side: null, owner: null, size: null, near: false, far: false, high: false, sight: false, adj: adj, nameHit: null, nameHits: null };
    // 原样叫名字（"去西北树林"）：最强的信号。这里**收全部命中**，不只取第一个——
    //   一句话点了两处名字（"北桥南桥"）是"分兵"或"没说清"，b 层不能闷头挑一个。
    //   但被更长名字盖住的短名字要丢掉：地图上同时有"西北树林"和"北树林"时，
    //   说"西北树林"只算点了**一处**，否则每次都会莫名其妙地追问。
    const hitsN = [];
    for (const p of placeList()) {
      if (!p.name || p.name.length < 2) continue;
      const at = text.indexOf(p.name);
      if (at < 0) continue;
      hitsN.push({ p, at, end: at + p.name.length });
    }
    hitsN.sort((a, b) => (b.p.name.length - a.p.name.length) || (a.at - b.at));
    const named = [];
    for (const h of hitsN) {
      if (named.some(k => h.at >= k.at && h.end <= k.end)) continue;   // 被更长的名字覆盖
      if (named.some(k => k.p.id === h.p.id)) continue;                // 同一个名字说了两遍
      named.push(h);
    }
    if (named.length) {
      q.nameHits = named.map(h => h.p.id);
      q.nameHit = named.length === 1 ? named[0].p.id : null;
      // 类别词以名字的类别为准（"北桥"里的"桥"比后文的泛称更硬）
      if (named.every(h => h.p.kind === named[0].p.kind)) q.kind = named[0].p.kind;
    }
    const hits = [];
    for (const t of DIR_TOKENS) { const at = text.indexOf(t[0]); if (at >= 0) hits.push({ w: t[0], ns: t[1] || null, ew: t[2] || null, at }); }
    hits.sort((a, b) => b.w.length - a.w.length || a.at - b.at);
    for (const h of hits) {
      if (h.ns === 'mid') { if (!q.mid && q.ns == null && q.ew == null) q.mid = true; continue; }
      if (h.ns && !q.ns) q.ns = h.ns;
      if (h.ew && !q.ew) q.ew = h.ew;
    }
    if (q.mid) { q.ns = null; q.ew = null; }
    // "回营/归营/收兵" 说的**一定是自己家的营**——中文里没人用"回营"指敌人营寨。
    //   不加这条，"全军回营"会因为图上有两处本营而反问"哪一处"，那是抬杠。
    if (q.kind === 'base' && /(回营|归营|返营|收兵|撤回|退回|回大营)/.test(text)) q.owner = 'blue';
    if (SIDE_FAR.test(text)) q.side = 'far';
    else if (SIDE_HOME.test(text)) q.side = 'home';
    if (OW_RED.test(text)) q.owner = 'red';
    else if (OW_BLUE.test(text)) q.owner = 'blue';
    else if (OW_NONE.test(text)) q.owner = 'neutral';
    if (Q_NEAR.test(text)) q.near = true;
    if (Q_FAR.test(text)) q.far = true;
    if (Q_HIGH.test(text)) q.high = true;
    if (SIGHT_LIMIT_RE.test(text)) q.sight = true;   // 95① 只在 hill 候选里生效，见 landmarkCandidates
    if (Q_BIG.test(text)) q.size = 'big';
    else if (Q_SMALL.test(text)) q.size = 'small';
    return q;
  }
  // 给一处地标打分。**只用事实**（归一化位置 / 岸 / 归属 / 面积 / 距离），不查名字表。
  //   方位用**连续量**而不是"三等分档"：说"北边的树林"时，地图最北那片该赢，
  //   而不是"只要落在北三分之一里就都一样"。分档只作为一点加成，防止边界处突然翻脸。
  function scorePlace(p, q, ctx) {
    let s = 0;
    if (q.nameHit && q.nameHit === p.id) s += 8;
    const ny = typeof p.ny === 'number' ? p.ny : 0.5;
    const nx = typeof p.nx === 'number' ? p.nx : 0.5;
    if (q.mid) {
      s += 3 * (1 - Math.min(1, Math.abs(ny - 0.5) * 2));
      if (p.band === 'mid') s += 1;
    } else {
      if (q.ns === 'n') { s += 4 * (0.5 - ny); if (p.band === 'north') s += 1; }
      if (q.ns === 's') { s += 4 * (ny - 0.5); if (p.band === 'south') s += 1; }
      if (q.ew === 'e') { s += 4 * (nx - 0.5); if (p.area === 'east') s += 1; }
      if (q.ew === 'w') { s += 4 * (0.5 - nx); if (p.area === 'west') s += 1; }
    }
    if (q.side && p.area) {
      const home = ourSide();
      if (home) s += q.side === 'home' ? (p.area === home ? 2.5 : -3) : (p.area === home ? -3 : 2.5);
    }
    if (q.owner && (p.kind === 'camp' || p.kind === 'base') && p.owner) {
      if (q.owner === p.owner) s += 3.5;
      else if (p.owner !== 'neutral') s -= 3.5;
      else s -= 1.5;                     // "敌人占的"里不该包含无人营地，但也不该和"我方营地"同罚
    }
    if ((q.near || q.far) && ctx.maxD > 0 && typeof p.d === 'number') {
      const t = 1 - p.d / ctx.maxD;      // 1＝就在眼前，0＝全图最远
      s += (q.far ? 1 - t : t) * 2.6;
    }
    if (q.size && p.tiles && ctx.med) s += q.size === 'big' ? (p.tiles > ctx.med ? 1.2 : -0.8) : (p.tiles < ctx.med ? 1.2 : -0.8);
    return s;
  }

  // ── 87：把地图事实接进指代（地形 / 岸别 / 高度 / 可达）──────────────
  // 三条原则：
  //   ① **只筛事实，不打策略分**：「这处营地在林子里吗」是地图事实；
  //      「林子里那处更适合守」是判断，b 层不下这种结论（d 层也不给）。
  //   ② **没有地图事实就不筛**：老单测只注入 landmarks（没有 BattleContext），
  //      这时 adjMatch 一律放行，行为与 86 之前完全一致——不凭空造条件。
  //   ③ 筛完为空要**直说没有**，不许默默滑回全体：那等于把玩家给的限定词吞掉。
  function footprintCells(p) {
    // 营地/本营是 3×3 的方块（生成器给了 x1..x2）；其余地标只给中心，取 3×3。
    const x1 = (typeof p.x1 === 'number') ? p.x1 : Math.round(p.x) - 1;
    const x2 = (typeof p.x2 === 'number') ? p.x2 : Math.round(p.x) + 1;
    const y1 = (typeof p.y1 === 'number') ? p.y1 : Math.round(p.y) - 1;
    const y2 = (typeof p.y2 === 'number') ? p.y2 : Math.round(p.y) + 1;
    const out = [];
    for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) out.push({ x, y });
    return out;
  }
  const ADJ_TYPES = { forest: ['forest'], marsh: ['marsh', 'ford', 'shallow'] };
  const ADJ_CN = { forest: '树林里', bridge: '桥边', marsh: '河滩上' };
  function adjMatch(p, adj) {
    const bc = mapCtx();
    if (!bc) return true;
    if (adj === 'bridge') {
      // 「桥边」按离桥面的**直线距离**算（8 格内）：桥横跨两岸，两侧都算桥边。
      const bs = (bc.places || []).filter(x => x.kind === 'bridge');
      return bs.some(b => Math.hypot(b.x - p.x, b.y - p.y) <= 8);
    }
    const want = ADJ_TYPES[adj];
    if (!want || !bc.terrainAt) return true;
    const cells = footprintCells(p);
    let hit = 0;
    for (const c of cells) { const t = bc.terrainAt(c); if (t && want.indexOf(t.type) >= 0) hit++; }
    // 过半才算"在里头"：营地是 3×3，只在角上蹭到一格，说"林子里的营地"就是抬杠。
    return hit * 2 >= cells.length;
  }
  function heightOf(p) {
    const bc = mapCtx();
    if (!bc || !bc.terrainAt) return null;
    const t = bc.terrainAt(p);
    return t ? t.height : null;
  }

  // ── 87：战地问答（地形 / 过河点 / 岸别 / 可达）──────────────────────
  // 这四类问题以前一律落到「我军都待命，人齐气足」——不是答错，是**没答**。
  //   现在地图事实已经在手上（BattleContext），没有理由再拿状态报告糊过去。
  // 判据一律收成**明确的问法**，不收"含地形/过河"这类宽词：
  //   这几组词日常说话太常见，按宽词接管会把真命令吃掉（58 的教训）。
  const MAP_TERRAIN_RE = /(什么地形|地形怎么样|地形如何|地势怎么样|脚下是什么|这地方是什么|这儿是什么地|站的是什么地|什么地方的地形)/;
  const MAP_CROSS_RE = /(怎么过河|从哪过河|哪儿过河|哪里过河|在哪过河|哪个桥|哪座桥|最近的桥|过河点在哪|渡口在哪|哪儿能过河|哪能过河|能过河吗|过得了河|能不能过河)/;
  const MAP_SIDE_RE = /(在河的?哪边|哪一岸|哪边岸|东岸还是西岸|河的那边|在河哪边)/;
  const MAP_REACH_RE = /(走得到|到得了|能不能过去|能过去吗|通不通|走得通|路通不通|路好走|能不能到|能到吗|多久能到)/;
  const TERRAIN_CN = { plain: '平原', forest: '林地', hill: '高地', marsh: '河滩', river: '河面', bridge: '桥面', ford: '浅滩', shallow: '浅水', water: '水面' };
  const SIDE_CN = { west: '西岸', east: '东岸' };
  // 95：三类"说得出口的替代"。判据一律收成**明确的问法／限定语**，不收宽词（58 的教训）。
  const MAP_SIGHT_RE = /(哪处高地视野好|哪座高地视野好|哪处高地看得远|哪处高地能看到|高地视野最好|哪处能看到桥|哪处高地有利|视野最好的高地)/;
  const MAP_FLANK_RE = /(侧翼|翼侧|两翼|侧后|侧背)/;
  // 95② 侧翼问答**必须同时是方位问法**。只凭「侧翼」两个字就接管，会把
  //   「报一下敌人侧翼的情况」「敌人侧翼有几支」从 83 的问敌情改成方位推断——
  //   玩家问的是兵力，系统答的是方向，这就是 91 清掉的"没听懂还不吭声"。
  //   收紧后：问方位才按 ghost 推，问兵力/情况仍走原来的敌情回报。
  const MAP_DIR_RE = /(在哪|哪边|哪儿|哪里|哪个方向|什么方位|方位|朝哪|方向|在哪一侧)/;
  function flankAsk(text) { return MAP_FLANK_RE.test(text) && MAP_DIR_RE.test(text); }
  function bankCN(bc, area) {
    if (!area) return '河上';
    if (!bc.homeSide) return SIDE_CN[area] || area;
    return area === bc.homeSide ? '我方这岸' : '对岸';
  }
  // 95① 视野：装配层只给事实表，排序与挑选在 b 层（87 决策：限定词是硬条件，不掺进打分）。
  function sightFacts(bc, hillIds, targetIds) {
    if (!bc || typeof bc.sightOf !== 'function') return [];
    const hs = hillIds || (bc.places || []).filter(p => p.kind === 'hill').map(p => p.id);
    const ts = targetIds || (bc.places || []).filter(p => p.kind === 'bridge').map(p => p.id);
    return bc.sightOf(hs, ts);
  }
  function sightRank(rows) {
    return rows.map(r => ({
      id: r.id, name: r.name, d: r.d || 0,
      n: r.seen.filter(s => s.visible).length,
      names: r.seen.filter(s => s.visible).map(s => s.name),
    })).sort((a, b) => b.n - a.n || a.d - b.d);
  }
  function saySight(bc) {
    const rows = sightFacts(bc);
    if (!rows.length) return '这张图上没有高地，谈不上哪处视野好。';
    const ranked = sightRank(rows);
    const best = ranked[0];
    if (!best.n) return '这几处高地都看不到桥头，没有明显视野更好的一处。';
    return `视野最好的是${best.name}（能看到${best.names.join('、')}）；` +
      `共看了 ${rows.length} 处高地。`;
  }
  // 95② 敌情方位：只报方位与滞后年龄，**不报坐标**（契约 §4.3「可以推理，不许校正」）。
  //   ghost/lagged 的 x/y 是最后目击点，只用来算相对于主将的方向；说出来的一律是中文方位。
  function compassCN(dx, dy) {
    const ns = dy < -0.4 ? '北' : dy > 0.4 ? '南' : '';
    const ew = dx > 0.4 ? '东' : dx < -0.4 ? '西' : '';
    return (ew + ns) || '附近';   // 中文习惯：东北／东南／西北／西南，不写「北东」
  }
  function sayFlank(bc) {
    const foes = (bc && bc.enemy) || [];
    if (!foes.length) return '现在没有敌军目击点，说不出侧翼在哪边。';
    const sorted = foes.slice().sort((a, b) => (a.age || 0) - (b.age || 0));
    const e = sorted[0], age = e.age || 0;
    const lead = age > 0 ? `按 ${Math.round(age)} 秒前的目击点` : '按刚看见的目击点';
    const here = bc && bc.here;
    if (!here) return `${lead}，还不知道主将位置，说不出侧翼方位。`;
    const dx = e.x - here.x, dy = e.y - here.y;
    const dir = compassCN(dx, dy);
    // 侧翼＝「主将 → 目击点」这根轴的两侧；两侧都给，不替玩家挑一边（57 指代不猜）。
    const f1 = compassCN(-dy, dx), f2 = compassCN(dy, -dx);
    return `${lead}，敌人在${dir}方向；侧翼大约在其${f1}或${f2}侧。` +
      '这是按最后目击点推的，不是实时位置——要派兵请直接说地名。';
  }
  // 95③ 过河点：只列图上的桥名与直线距离，**不承诺这支部队走得过去**。
  function crossingNames(bc) {
    return (bc.places || []).filter(p => p.kind === 'bridge').slice()
      .sort((a, b) => (a.d || 0) - (b.d || 0)).slice(0, 2)
      .map(b => `${b.name}（直线 ${Math.round(b.d || 0)} 格）`);
  }
  // 一条直线要蹚过几格水：**零成本**（逐点 terrainAt），用来给"走不到"一个真原因。
  //   不跑 A*——那是 23ms，而这里只需要"这条线上有没有水"这一个事实。
  function lineWet(bc, a, b) {
    if (!b || !bc.terrainAt) return 0;
    const n = 24, wet = ['river', 'ford', 'shallow'];
    let c = 0;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const q = { x: Math.round(a.x + (b.x - a.x) * t), y: Math.round(a.y + (b.y - a.y) * t) };
      const g = bc.terrainAt(q);
      if (g && wet.indexOf(g.type) >= 0) c++;
    }
    return c;
  }
  function sayTerrain(bc) {
    const t = bc.terrain;
    if (!t) return '还不知道我们在什么地形上。';
    const name = TERRAIN_CN[t.type] || t.type;
    const side = bc.side ? (bc.side === 'west' ? '西岸' : bc.side === 'east' ? '东岸' : '河里') : null;
    return `脚下是${name}${side ? '，在' + side : ''}。`;
  }
  function sayCrossing(bc) {
    const bs = (bc.places || []).filter(p => p.kind === 'bridge').slice()
      .sort((a, b) => (a.d || 0) - (b.d || 0));
    if (!bs.length) return '这张图上没有桥，也没有渡口。';
    const b = bs[0];
    const c = (bc.crossings || [])[0] || null;
    const side = c && c.side ? SIDE_CN[c.side] : null;
    // 不报坐标：格坐标是内部表示，玩家看的是画面（"（66,35）"对他来说是一串没用的数字）。
    return `最近的过河点是${b.name}，直线 ${Math.round(b.d || 0)} 格` +
      (side ? `；你现在在${side}` : '') + '。';
  }
  // 岸别：优先答"点名的那一处"，没点名或多处时答**最近的那一处**并说清是"最近的"。
  function pickPlace(bc, ids) {
    const all = bc.places || [];
    if (ids && ids.length === 1) { const p = all.find(x => x.id === ids[0]); if (p) return p; }
    const pool = (ids && ids.length) ? all.filter(x => ids.indexOf(x.id) >= 0) : all;
    return pool.slice().sort((a, b) => (a.d || 0) - (b.d || 0))[0] || null;
  }
  function saySide(bc, ids) {
    const p = pickPlace(bc, ids);
    if (!p) return '图上没有可指的地方。';
    const exact = ids && ids.length === 1;
    return `${exact ? '' : '最近的那处是'}${p.name}，在${bankCN(bc, p.area)}${p.area ? '（' + SIDE_CN[p.area] + '）' : ''}。`;
  }
  function sayReach(bc, ids) {
    if (!bc.reach) return null;
    // 没点地名就别去算"最近那处"——那会答成"走得到：我军本营，约 7 格"，等于答非所问。
    if (!ids || !ids.length) return '要到哪一处？说「走得到北桥吗」这样带上地名，我才好算。';
    const p = pickPlace(bc, ids);
    if (!p) return '要到哪一处？说「走得到北桥吗」这样带上地名，我才好算。';
    const r = bc.reach(p.id);
    if (!r || r.why === 'dead') return '主将已经不在了，没人可派。';
    if (r.ok) return `走得到：${p.name}，约 ${r.steps} 格。`;
    if (r.why === 'outside') return `${p.name}在战场之外，走不到。`;
    const wet = bc.here ? lineWet(bc, bc.here, p) : 0;
    // 95③：契约 §4.5 要「指出可用的桥」。实做的 `crossingsFor` 收的是点、不判兵种，
    //   所以只列**图上的过河点**并明说"能不能走到要另算"——不谎称这支部队能过，
    //   也不额外调 `reach`（87：一句最多一处 A*）。可达时这段根本不会走到。
    const alt = crossingNames(bc);
    const altText = alt.length
      ? `；图上的过河点：${alt.join('、')}（能不能走到要另算）`
      : '；这张图上没有过河点';
    return `${p.name}走不到——没有可通行的路线` +
      (wet ? `；直线要过 ${wet} 格水面，得先找桥或浅滩` : '') + altText + '。';
  }
  // 判"这句是不是在问地图"，是就返回 {kind,text}。**只在没有动作、或已经是 REPORT 时**调用。
  function mapAskOf(text, lmC) {
    const bc = mapCtx();
    if (!bc) return null;
    const ids = (lmC && lmC.ids) || [];
    // 95：两类新问答排在四类旧问答前面。方位问法里的「侧翼」会同时命中 83 的问敌情
    //   （FOE_REF+FOE_ASK），所以在 1823 那处先让开；这里才轮到按 ghost 算方位
    //   （不给坐标、不落成地点）。非方位问法一律不接管，见 flankAsk 的注释。
    if (flankAsk(text)) return { kind: 'flank', text: sayFlank(bc) };
    if (MAP_SIGHT_RE.test(text)) return { kind: 'sight', text: saySight(bc) };
    if (MAP_TERRAIN_RE.test(text)) return { kind: 'terrain', text: sayTerrain(bc) };
    if (MAP_CROSS_RE.test(text)) return { kind: 'crossing', text: sayCrossing(bc) };
    if (MAP_SIDE_RE.test(text)) return { kind: 'side', text: saySide(bc, ids) };
    if (MAP_REACH_RE.test(text)) return { kind: 'reach', text: sayReach(bc, ids) };
    return null;
  }

  // 地标候选：1 个＝确定，多个＝需要追问，0 个＝没提到地点 / 这张图上没有那一类。
  function landmarkCandidates(text) {
    const q = placeQuery(text);
    // 一句话点了两处地方的名字：要么是分兵，要么是没说清。两种都轮不到 b 层替玩家挑。
    if (q.nameHits && q.nameHits.length > 1) return { ids: q.nameHits.slice(), via: 'ambiguous', q };
    if (!q.kind) return { ids: [], via: null, q };
    let pool = placeList().filter(p => p.kind === q.kind && !p.hidden);
    if (!pool.length) return { ids: [], via: 'missing', kind: q.kind, q };
    // 87：空间限定是**硬条件**，先筛再打分。加分制在"这岸/对岸"上吃过亏——
    //   两处营地差 5.5 分也会被"分不开就问"的规则拉回去追问，等于把限定词丢了。
    if (q.adj) {
      const kept = pool.filter(p => adjMatch(p, q.adj));
      if (!kept.length) return { ids: [], via: 'no-adj', kind: q.kind, adj: q.adj, q };
      pool = kept;
    }
    if (q.side) {
      const home = ourSide();
      if (home) {
        const kept = pool.filter(p => p.area && (q.side === 'home' ? p.area === home : p.area !== home));
        // 一处都不在那一岸时**不筛**：'后方/前面' 这类词同时是类别词的一部分，
        //   判错了就回"没有"比漏筛更糟（宁可多问一句，也别告诉玩家图上不存在）。
        if (kept.length) pool = kept;
      }
    }
    // 说了归属、但图上没有那一种归属的（"敌人占的营地"而营地全是中立）：
    //   不要含糊其辞地反问"哪一处"，要直说"没有"——否则玩家会以为是自己没说清。
    if (q.owner && (q.kind === 'camp' || q.kind === 'base') && !pool.some(p => p.owner === q.owner)) {
      return { ids: [], via: 'no-owner', kind: q.kind, owner: q.owner, q };
    }
    const tiles = pool.map(p => p.tiles || 0).filter(n => n > 0).sort((a, b) => a - b);
    const ds = pool.map(p => (typeof p.d === 'number' ? p.d : 0));
    const ctx = { med: tiles.length ? tiles[Math.floor(tiles.length / 2)] : 0, maxD: Math.max.apply(null, ds) || 0 };
    const scored = pool.map(p => ({ p, s: scorePlace(p, q, ctx) }));
    // 同分时优先"离主将近的"——人说话默认指眼前那处，除非明说"最远"
    scored.sort((a, b) => b.s - a.s || (a.p.d || 0) - (b.p.d || 0));
    // 87：地形价值——「最高的那处」用高度事实直接定，不掺进打分。
    //   两处高度差不到半格就交回打分（同高时"最近"更说得通）。
    if (q.high) {
      const hs = pool.map(p => ({ p, h: heightOf(p) })).filter(o => o.h !== null);
      if (hs.length) {
        hs.sort((a, b) => b.h - a.h || (a.p.d || 0) - (b.p.d || 0));
        if (hs.length === 1 || hs[0].h > hs[1].h + 0.5) return { ids: [hs[0].p.id], via: 'resolved', q };
        // 一样高就别硬挑一处：说清"一样高"再问，比随便给一处更接近人话。
        if (hs.every(o => Math.abs(o.h - hs[0].h) < 0.01))
          return { ids: hs.map(o => o.p.id), via: 'ambiguous', highTie: hs[0].h, kind: q.kind, q };
      }
    }
    // 95① 视野是**硬限定词**，不是加分：说了「视野好／有利位置」就按"能看见几处桥头"挑。
    //   只在**高地**候选里生效——「全军去最近的高地」没有这个限定词，照旧按远近；
    //   没有地图事实（老单测只注入 landmarks）时整段不接管，行为与 87 完全一致。
    //   筛空直说没有，不许滑回"最近的那处"（87 决策③）。
    if (q.sight && q.kind === 'hill') {
      const bc = mapCtx();
      // 87 的退化规矩：老单测只注入 landmarks、没有 BattleContext 时**整段不接管**，
      //   落回下面的打分路径。没有事实就说"这几处都看不到桥头"是凭空下结论
      //   （mapctx_test [6] 守的就是"没事实不筛"）。
      if (bc && typeof bc.sightOf === 'function') {
        const rows = sightFacts(bc, pool.map(p => p.id));
        if (rows.length) {
          const top = sightRank(rows)[0];
          if (top.n > 0) {
            return {
              ids: [top.id], via: 'resolved', q,
              sightWhy: `按视野挑了${top.name}（能看到${top.names.join('、')}）`,
            };
          }
        }
        return { ids: [], via: 'no-sight', kind: q.kind, q };
      }
    }
    const best = scored[0];
    // "最近的营地"本身就是在让你挑一处——人听到这句不会反问"哪一个最近"。
    //   所以只要远近是唯一的限定语，就直接给最近（最远）那处。
    const onlyRange = (q.near || q.far) && !q.ns && !q.ew && !q.mid && !q.side && !q.owner && !q.size;
    if (onlyRange) return { ids: [best.p.id], via: 'resolved', q };
    const tied = scored.filter(o => best.s - o.s < 0.6).map(o => o.p.id);
    if (tied.length === 1) return { ids: tied, via: 'resolved', q };
    // 83：打分分不开 → 按主将画面收窄（四级见 narrowByView）。
    //   收窄成一处就等于"解析出来了"，不再追问；收窄不了才问，且只问画面里那几处。
    const nb = narrowByView(tied.map(id => pool.find(p => p.id === id)).filter(Boolean));
    if (nb.ids.length === 1) return { ids: nb.ids, via: 'resolved', q, narrowed: nb.why };
    if (nb.why === 'none') return { ids: tied, via: 'ambiguous', q, outOfView: true, kind: q.kind };
    return { ids: nb.ids.length ? nb.ids : tied, via: 'ambiguous', q, narrowed: nb.why };
  }

  // 相对位置说法（"原地/站到一起"）→ 哨兵值，c 层换算成部队质心（质心计算是 d 层的事）
  const HERE='__HERE__';
  function isHerePhrase(t){return /(原地|这里|此处|在此|当前位置|站到一起|聚在一起|在一起|一起|顶住|压住阵脚)/.test(t);}

  // 92：**语音转写形态**。a 层（voice.js）只吐一段裸文本，与键盘输入有三个差别：
  //   没有标点（流式中文模型不出标点）、带口水词（嗯/那个/然后呢）、带同音字（在/再、侨/桥）。
  //   两条入口共用 cmdNorm，所以归一只做在这里：isOffTopic / isQuestion / splitSegments 都过它。
  // 只剥"剥掉也不改意思"的：犹豫音（嗯呃唉哎噢）与句首填充（那个/这个/就是说）。
  //   三处刻意不做的：
  //     · 「额」只在句首剥——"名额""额度"是真词
  //     · 「呢」不剥——Q_FORM 靠它认问句（「敌人呢」），只把"然后呢/那呢"里的那个当口水
  //     · 「啊」照剥（"杀啊/冲啊"剥完还是"杀/冲"）
  const HESIT='嗯呃唉哎噢喔';
  function stripSpoken(t){
    let s=t;
    // 「然后呢」后面**还有内容**时才是口水；句尾的「然后呢？」是问句，不能吞
    s=s.replace(/(然后|那|这|好|行)呢(?=[\u4e00-\u9fa5])/g,'$1');
    s=s.replace(new RegExp('^['+HESIT+']+'),'');
    s=s.replace(new RegExp('['+HESIT+']','g'),'');
    s=s.replace(/^(那个|这个|就是说|怎么说|我说)+/,'');
    s=s.replace(/^额+/,'');
    // 流式识别偶尔把同一个虚字吐两遍（"全军就就是去北桥"→ 被切成"全军｜是去北桥"整条作废）。
    //   **只收连接词与虚字**，不收动词："看看/慢慢/处处"都是真词，收了会把正常话讲坏。
    s=s.replace(/([就再先也都])\1+/g,'$1');
    return s;
  }
  // 98（Q36）：全力冲锋四个说法的**精确归一**。只在这个漏斗做，不放进 CORRECTIONS
  //   （那是错字纠正表，放进去会在回显里报一句「已把 全速冲 理解为 全力冲」，把同义说法说成错字），
  //   也不做拼音/模糊匹配——沾「全」就改判会把「全速前进」也读成冲锋，是新的静默改写。
  const RUSH_NORM=[['不计代价地冲','全力冲'],['全速冲','全力冲'],['死冲','全力冲']];
  function cmdNorm(s){
    let t=stripSpoken((s||'').toLowerCase().replace(/[，,。！？!？;；:：、\s]+/g,''));
    for(const wrong in CORRECTIONS)t=t.split(wrong).join(CORRECTIONS[wrong]);
    for(const [from,to] of RUSH_NORM)t=t.split(from).join(to);
    return t;
  }
  // 是否发生了错字纠正（用于回显提示"已把 X 理解为 Y"）
  function cmdCorrected(raw){
    const t=cmdNorm(raw);
    const notes=[];
    for(const wrong in CORRECTIONS)if(raw&&raw.indexOf(wrong)>=0)notes.push(`${wrong}→${CORRECTIONS[wrong]}`);
    return notes;
  }
  // 在文本里圈出实体：长词优先，被更长词覆盖的短词丢弃
  //（"敌枪兵队"命中后，落在它里面的"枪兵队"不再单独算一次）
  function cmdFindSpans(text,table){
    const hits=[];
    for(const id in table)for(const w of table[id]){
      const p=text.indexOf(w);
      if(p>=0)hits.push({id,w,start:p,end:p+w.length});
    }
    hits.sort((a,b)=>b.w.length-a.w.length||a.start-b.start);
    const kept=[];
    for(const h of hits)if(!kept.some(k=>h.start<k.end&&k.start<h.end))kept.push(h);
    return kept;
  }
  function numbered(labels){return labels.map((l,i)=>`${i+1}.${l}`).join(' ');}

  // ── 短口令表（61）──────────────────────────────────────────────
  // 单字军令（"上""退""守""停"）**只在整句就是它**时才当动作：塞进正文就会误伤生活用语
  //   （"下午三点开会"里的"下"、"上次那个方案"里的"上"），这条边界从 58 起就没动过。
  // 与"域外判定"里的 SHORT_CMD 分工不同：SHORT_CMD 判"这句在讲战场"，这张表判"讲的是哪个动作"。
  const SHORT_MAP={冲:'ATTACK',杀:'ATTACK',上:'ATTACK',攻:'ATTACK',打:'ATTACK',追:'ATTACK',射:'ATTACK',
    退:'RETREAT',撤:'RETREAT',跑:'RETREAT',守:'DEFEND',防:'DEFEND',顶:'DEFEND',
    停:'STOP',站住:'STOP',动:'MOVE',走:'MOVE',来:'MOVE'};
  const SHORT_PRE=/(全体|全部|全都|都|一起|一齐|统一|大家|所有人|各位|弟兄们|兄弟们|各队|三军|全军)/;
  function shortCmdAction(t){
    // 剥群体前缀与语气尾（"都上啊"→"上"），剩下的必须 ≤2 字才对表
    const s=t.replace(new RegExp('^'+SHORT_PRE.source+'+'),'').replace(/(吧|啊|呀|了|嘛|呢|哦|啦)+$/,'');
    if(!s||s.length>2)return null;
    return SHORT_MAP[s]||null;
  }

  // ── 否定式（61）──────────────────────────────────────────────
  // 玩家说"别追了""不许退""不要打"是在**撤令**。原来否定词被当普通文本丢掉，
  //   于是"别放箭"被老老实实执行成"放箭"——把玩家明确叫停的事做了一遍，这是最坏的一类错。
  // 规则是**逐条写死**的映射，不做语义推测：否定 X 就换成 X 的对立动作。
  //   落不下去的（"不到万不得已不许撤"这类带条件的）只取最近的那个动作词，不当条件逻辑理解。
  const NEG_WORDS=['不许','不准','不要','不让','不必','不用','不得','禁止','休要','甭管','别管','取消','停止','中止','别','莫','勿'];
  // 71：「取消」补进来，因为它在 STOP 词表里是个动作词，而「取消驻守」里"驻守"位置更靠后、
  //   同长取胜的规则让它压过了"取消"——玩家要取消，游戏收到的是驻守。这是"命令被改写成反意"
  //   那一类，和「生擒」同性质，必须修。
  //   注意 **"解除"没有加进来**：「解除过河」在 RIVER_OFF 词表里意思是"允许过河"，
  //   一旦当成否定词，会被 ② 翻成 RIVER_ON（禁止过河）——正好反了。所以"解除"只走词表匹配。
  const NEG_TO={ATTACK:'STOP',RETREAT:'DEFEND',MOVE:'STOP',STOP:'MOVE',CAPTURE:'STOP',
    DEFEND:'STOP',RALLY:'STOP',RECON:'STOP',STANCE_ON:'STANCE_OFF',STANCE_OFF:'STANCE_ON',
    FOLLOW:'STOP',GUARD_ME:'STOP',CALL_ARMS:'STOP',
    // 101：「别加速了／不用加速行军」＝撤掉档位，不是"停下不走"。这两件事必须分开——
    //   加速的对立面是常速，不是原地不动。
    FORCED_ON:'FORCED_OFF'};
  // 91：**站桩动作**——"停在某处做某事"。用来判「别追，守住阵地」里第二句是不是主令。
  //   判据不是"这两个动作哪个重要"，而是形状：站桩动作自带"不再前进"的含义，
  //   与前面那句"别追/别退"不冲突，可以并存；两个都是"打"的时候才需要问玩家要哪个。
  const STANDING_ACTS=['DEFEND','CAPTURE','RALLY','STANCE_ON','STANCE_OFF','GUARD_ME'];
  // 91：能当"占有者"说的词——定语从句判据只认这一小撮。
  //   不做通用句法分析的理由见 isModifierVerbIn 的注释：放宽会把谓语一起吃掉。
  const OWNER_WORDS=/(我方|我军|我们|敌人|敌方|敌军|他们|对方|友军|己方|被)/;
  // 91：**定语从句里的动词不是谓语**。「去我方占领的营地」——"占领"修饰"营地"，谓语是"去"。
  //   长度规则会取两字的"占领"（"去"只一字），动作变成 CAPTURE；地点又解不出（图上此刻没有
  //   我方占领的营地），于是 c 层拿默认目标顶上，实际下达的是"去占领中央据点"——
  //   玩家说的地方一处没去，还多了一件他没说的事。
  //   判据只认**占有者 + 动词 + 的**这一种定语，不做通用句法分析：
  //     · 放宽成"任何 X 的 Y"会把「守住敌人占的桥」的谓语也吃掉（"守住"同样在"的"前面）
  //     · 只认能当占有者说的词（我方/敌人/他们/被…），"去北桥的东边"这种不算
  //   t 是**当前被扫描的那段文字**：主扫描传 scanText，整句复核传 text——
  //   两处下标不在同一个坐标系里，混用会把定语判到别的位置上（90 的 bestPos 就是栽在这上面）。
  function isModifierVerbIn(t,p,w){
    if(t.slice(p+w.length,p+w.length+3).indexOf('的')<0)return false;
    return OWNER_WORDS.test(t.slice(Math.max(0,p-8),p));
  }
  // 否定词与动作之间**允许**夹的虚字。这一条是"别怂，上啊"逼出来的：
  //   不加限制的话"怂"这种字也会被当成填充，玩家喊冲锋会被读成"停止"。
  const NEG_FILL=/^(再|乱|瞎|老|一直|继续|这么|那么|给我|往[东西南北前后左右]|向[东西南北前后左右]|朝[东西南北前后左右]|马上|立刻|立即)$/;
  // 动作扫描口径：正式词表 + 短令表（"退""动"这类只有整句才算，但否定式里跟着否定词出现是确定的）
  function actScanWords(){
    const out=[];
    for(const [name,ws] of TXT_ACTIONS)for(const w of ws)out.push([name,w]);
    for(const w in SHORT_MAP)out.push([SHORT_MAP[w],w]);
    return out;
  }
  function negationOf(t){
    // 否定词可能不止一个（"不到万不得已不许撤"），**逐个试**，取第一个能翻出动作的。
    //   只取最早那个的话，"不到"（不是否定动作）会把后面的"不许撤"整个挡掉。
    const cands=[];
    for(const w of NEG_WORDS)for(let p=t.indexOf(w);p>=0;p=t.indexOf(w,p+1))cands.push({w,p});
    cands.sort((a,b)=>a.p-b.p||b.w.length-a.w.length);
    for(const neg of cands){
      const r=negationAt(t,neg);
      if(r)return r;
    }
    return null;
  }
  function negationAt(t,neg){
    const tail=t.slice(neg.p+neg.w.length);
    // ① 阻止敌方通过/靠近："别让他们过桥"不是"我们不过桥"，是"守住桥别让他们过来"
    if(/^[^]{0,4}(敌人|敌军|对方|他们|他|人家)[^]{0,4}(过|渡|靠|接近|上|冲)/.test(tail))
      return {to:'DEFEND',base:'阻止敌方通过',at:neg.p};
    // ② 我方不过桥/不过河 → 收回过河许可
    if(/^[^]{0,2}(过|渡)(桥|河|江)/.test(tail))return {to:'RIVER_ON',base:'过河',at:neg.p};
    // ③ 别放走 → 杀光
    if(/^[^]{0,2}放(走|过)/.test(tail))return {to:'ATTACK',base:'放走',at:neg.p};
    // ④ 别管某处 → 不再理会，停止。注意要看**否定词本身**：NEG_WORDS 里的"别管/甭管"是整词，
    //   取完否定词后 tail 里已经没有"管"了，只看 tail 就永远不命中。
    if(/^[^]{0,2}(管|理|顾)/.test(tail)||/^(别管|甭管|不管)/.test(neg.w))
      return {to:'STOP',base:'管',at:neg.p};
    // ⑤ 通用：否定词后出现动作词，且中间只夹虚字 → 取对立动作
    let best=null;
    for(const [name,w] of actScanWords()){
      const p=tail.indexOf(w);
      if(p<0)continue;
      const fill=tail.slice(0,p);
      if(fill&&!NEG_FILL.test(fill))continue;
      if(!best||p<best.p||(p===best.p&&w.length>best.w.length))best={name,w,p};
    }
    if(!best||!NEG_TO[best.name])return null;
    return {to:NEG_TO[best.name],base:best.name,at:neg.p};
  }

  // ── 问句形态（61）──────────────────────────────────────────────
  // 玩家问"北桥守住了吗""谁在挨打""还剩几个"，是在**问情况**，不是在下令。
  //   原来只认"为什么/怎么回事"，于是"北桥守住了吗"被执行成一条驻守令——
  //   他问的是一件事，系统做的是另一件事。
  // 判据：疑问形态 ∧ 不是否定式命令（"谁都不许后退"含"谁"，但那是命令）。
  // 注意 `不` 后面那个反向引用必须是 **\2**：正则里第一个分组是 ([了过]没)，
  //   写成 \1 会变成"引用一个没参与匹配的分组"＝空串，于是"兵不""来不"全被当成疑问形态
  //   （"全军撤退并按兵不动""快点快点来不及了"就是这么被读成问句的）。
  const Q_FORM=/([了过]没|吗|呢|[?？]|多少|几[个支处人格次]|谁|什么|哪|怎么|为什么|为啥|如何|是不是|有没有|能不能|可不可以|([\u4e00-\u9fa5])不\2)/;
  // 问句识别：玩家在问"为什么没动"这类问题，不是在下令（真实日志#3 的教训）
  function isQuestion(raw){
    const t=cmdNorm(raw);
    if(negationOf(t))return false;      // "谁都不许后退""停止进攻"是命令，不是问句
    // "什么叫阵型""什么是士气"是在问概念，不是问战况——别拿战况去答
    if(/(什么|怎么|啥)(叫|是)/.test(t))return false;
    // 组合句（"先报告再今天天气怎么样"）先按组合句处理，别被句尾的问句尾巴整句当问句——
    //   那样第二段的"和战场无关"就永远报不出来，玩家以为整条都执行了。
    if(/^先/.test(t)||/(然后|随后|接着|之后)/.test(t))return false;
    return Q_FORM.test(t);
  }
  function hasActionWord(t){return TXT_ACTIONS.some(([,ws])=>ws.some(w=>t.indexOf(w)>=0));}
  // 动作锁兵种（上司 2026-10-30 定）：放箭/射只能是弓兵，句子里没点名就补 ARC。
  //   **只补被动作锁死的那一类**；"进攻"这类不锁兵种的绝不补全军，那是 c 层的活。
  //   场上没有弓兵时不是"b 层猜错"，是这条命令不成立——交执行层报失败。
  const ARCHER_LOCK=/(放箭|射箭|射击|齐射|乱箭|往死里射|射)/;
  // 群体词：句子里只有"都/全/各队"而没有点名具体部队 → 全体。
  //   「都别动」「全都上去干」这类原来一个主体都不给，c 层只能落到"选中那支"，是猜的。
  //   **不收光杆"全"**："全速前进"里的"全"是速度修饰，收进来就成了"全军"。
  const GROUP_SUBJ=/(都|全都|全部|全体|三军|各队|众将|诸位)/;

  // ── 域外判定（2026-10-30 58）────────────────────────────────────
  // 起因：玩家输入「今天天气怎么样」，REPORT 词表里的"怎么样"把它接住，
  //   然后一本正经地汇报战况。这不是"没听懂命令"，是"根本没在说战场"——
  //   两者必须给不同的反应，所以判据放在解析**之外**，单独判。
  //
  // 判据是**有没有战场成分**，不是命中哪条黑名单：黑名单永远补不齐
  //   （换个人换个话题就漏），而"这句话里一个我接得住的词都没有"是可判定的。
  //   所以只收"在别的话题里几乎不出现"的词，宁可漏判也不能误判——
  //   把一个真命令说成"无关"，比多问一句"要做什么"糟得多。
  //
  // **故意不收**"怎么样/状态"：它们在任意话题里都出现（"今天天气怎么样"），
  //   收了就等于没判。判之前先把"怎么样"摘掉，摘完还剩什么才算证据。
  //   "状态"不摘：图上有"各队状态"这种真命令，靠"各队"也留得住，没必要冒险。
  const DOMAIN_NOUN=/(军|兵|敌|营|寨|桥|渡|河|江|森林|树林|林子|山|岭|滩|阵地|旗|据点|地形|战场|部队|各队|队伍|将士|主将|鸣金|战鼓)/;
  // 状态类说法：「为什么没动」是**最重要的一句战场问话**（真实日志#3 的由来），
  //   它一个战场名词都不含，所以单列。同时把"为什么不听话/怎么回事"这类一起兜住。
  const DOMAIN_PHRASE=/(没动|不动|没反应|没动静|不听话|站(着|那)|发愣|卡住|怎么回事|什么情况|咋回事)/;
  // 战况词（61）：玩家问战况时常常一个战场名词都不带——"士气怎么样""我们赢了没""谁最累"。
  //   这些词在别的话题里基本不出现（"我今天很累"是例外，按既定口径宁可多问一句，
  //   回一句"这件和战场无关"才是更坏的结果）。
  const DOMAIN_STATUS=/(士气|阵型|阵脚|伤亡|兵力|人马|胜负|输赢|赢|输|胜|败|多少人|多少兵|剩多少|最累|体力|精力|血)/;
  // 续令词（61）："继续""照旧""原计划"离不开上一道命令，只可能出现在指挥语境里。
  //   它们本身没有动作可解析（b 层看不到上一条命令），收进来是为了不被判成闲话——
  //   判成闲话＝玩家这句话被没收，比多问一句"要部队做什么"糟得多。
  const DOMAIN_CONT=/(继续|照旧|照原|原计划|再来一次|接着来|按刚才|老规矩|快点|赶紧|来不及|麻利)/;
  // 整句就是一个字的命令（"上""左""冲""杀""退"）：
  //   只在**整句就是它**时算数。塞进正文当证据会误伤生活用语——"下午三点开会"里有"下"，
  //   "上次说的那个"里有"上"，一收进去这些句子就再也判不成域外了。
  const SHORT_CMD=/^(上|下|左|右|前|后|东|西|南|北|冲|杀|退|进|攻|防|追|逃|散|聚|原地|待命)$/;
  // 动宾式军令（"向左""包抄""跟我来"）：都带"朝哪边动"或"怎么打"，
  //   这些说法在别的话题里不出现，可以当证据。注意只收**成套**的说法，不收单字。
  const CMD_PHRASE=/(向左|向右|向前|向后|往前|往后|往前走|往后走|往前推|往后撤|往上|往下|往里|往外|前进|后退|后撤|包抄|包围|围住|围上|围起来|绕后|绕到|迂回|穿插|抄后路|抄侧翼|断后|殿后|掩护|接应|策应|压上|顶上|顶住|顶回去|冲上去|冲出去|杀出去|上啊|上呀|冲啊|散开|展开|收拢|跟我来|随我来|全军上|原地待命|原地不动|听令|领命)/;
  // 集体口令："都上""全都上""都能上""一起冲"——中间常夹一两个虚字（能/可以/往前），
  //   所以放宽成"群体词 + 至多两字 + 单字动作"。这是把它们留在域内，不是拿去解析：
  //   解析层认不出就照旧追问"要部队做什么"，但至少不会回一句"这和战场无关"。
  const GROUP_ACT=/(都|全|全部|全都|一起|一齐|统一)[^]{0,2}(上|冲|压|顶|攻|打|撤|退|走|动)/;
  function domainEvidence(raw){
    const t=cmdNorm(raw).replace(/怎么样/g,'');   // 唯一要摘掉的泛用词（见上面的说明）
    // "什么叫阵型""什么是士气"是在问概念，不是在给部队下令——也不该拿战况去回答
    if(/(什么|怎么|啥)(叫|是)/.test(t))return [];
    const ev=[];
    if(cmdFindSpans(t,unitWords()).length||cmdFindSpans(t,foeWords()).length)ev.push('实体');
    if(cmdFindSpans(t,ANCHOR_ALIASES).length)ev.push('主将');
    if(kindOf(t))ev.push('地形');
    if(DOMAIN_NOUN.test(t))ev.push('战场名词');
    if(DOMAIN_PHRASE.test(t))ev.push('状态说法');
    if(DOMAIN_STATUS.test(t))ev.push('战况词');
    if(DOMAIN_CONT.test(t))ev.push('续令词');
    if(negationOf(t))ev.push('否定军令');
    if(CMD_PHRASE.test(t))ev.push('军令短语');
    if(GROUP_ACT.test(t))ev.push('集体口令');
    if(SHORT_CMD.test(t))ev.push('单字令');
    if(hasActionWord(t))ev.push('军令动作');
    // 「筑垒」「扎营」这类**还没做**的军令也是军令：它们已经从动作表里移出去了，
    //   不加这一条，玩家单说一句"筑垒"会被判成"这和战场无关"——比"还没做"更不讲理。
    if(notYetOf(t))ev.push('未实现的军令');
    if(DIR_TOKENS.some(([w])=>w.length>=2&&t.indexOf(w)>=0))ev.push('方位');
    if(/[0-9]+格/.test(t))ev.push('距离');
    return ev;
  }
  // 一个战场成分都没有 → 当它不是在给部队下令
  function isOffTopic(raw){return domainEvidence(raw).length===0;}
  // 「这句是在下令，还是在补一句话」——c 层追问挂着时要靠它区分，否则真命令会被当答案吞掉。
  //   比 hasActionWord 宽：短口令（"冲""跟我来""向左""都能上"）没有正规动作词，
  //   但玩家显然在下令；当成"补充没听懂"问下去，等于把他刚说的命令吃掉了。
  //   例外是"原地/待命"：它们正是追问地点时最该被当答案接住的词，不能算新命令。
  function looksLikeCommand(raw){
    const t=cmdNorm(raw);
    if(hasActionWord(t))return true;
    if(/^(原地|待命|原地待命)$/.test(t))return false;
    return SHORT_CMD.test(t)||CMD_PHRASE.test(t)||GROUP_ACT.test(t);
  }

  // 组合句切分（"先X再Y"）：按连接词切段、剥段首"先"；返回段数组或 null（单命令不切段）
  //   「就」也算连接词（"打完就回来""到了北桥就守"）：不收它，句尾那个动作会因为"更长"
  //   把真正的主令顶掉（"回来"压过"打"）。「就地待命」这类切出空段的情况由 filter 兜住。
  const CHAIN_CONNS=['然后','再','随后','接着','之后','就'];
  // 切出来的纯语气段要丢掉（62）："那就退到北桥" 会在「就」上切成 "那" + "退到北桥"，
  //   头一段一个字都不是命令，却会让整句判成"组合句第 1 段无效"——玩家追问后的
  //   第一句补充十有八九带"那就/那好/行吧"，不拦就会把正常补充吃掉。
  const SEG_FILLER=/^[那这好行嗯哦啊呀嘛吧的是了个呢]*$/;
  function splitSegments(raw){
    let segs=[cmdNorm(raw)];
    for(const c of CHAIN_CONNS){
      segs=segs.flatMap(s=>{
        // 「就」要挑着切：粘在「地/近/此/位/绪」前面时它是副词的一部分（就地驻守、就近戒备、就位），
        //   不是"然后"。切了它，一句完全成立的命令会变成「全军 ⧸ 地驻守」，整条作废。
        //   这个坑是 78 加条件从句时暴露的：条件解析本身没碰「就地」，
        //   但把「全军就地驻守」送到这一层的正是 ③ 的拆段路径。
        if(c==='就')return s.split(/就(?![地近此位绪还是在])/);
        return s.split(c);
      });
    }
    segs=segs.map(s=>s.replace(/^先+/,'')).filter(s=>s&&!SEG_FILLER.test(s));
    if(segs.length>1)return segs;
    // 92：「在」常是「再」的同音——语音里组合句断链的头号原因（见 splitAtZai）
    const z=splitAtZai(segs[0]);
    if(z)return z;
    // 90：没有连接词时，再试"分兵句"——按标点切成"各带主语"的分句（见 splitBySubject）。
    //   顺序不能反：连接词切的是"同一批部队先后做两件事"，分兵切的是"不同部队各做一件事"。
    //   反了的话「全军先去北桥，再放箭」会先被分兵规则切成 ["全军先去北桥","再放箭"]，
    //   而"再放箭"的主语是系统按兵种补的、不是玩家点的——那一步该走连接词的排队逻辑。
    // 92：标点路径切不出来时，再试**无标点**的分兵句（语音转写不出标点，见 splitBySubjectNoPunct）
    return splitBySubject(raw)||splitBySubjectNoPunct(raw);
  }

  // ── 「在」= 「再」的同音（92）────────────────────────────────────
  // 语音转写里"再"几乎总被写成"在"：`全军先去北桥在去南桥` 因此只剩第一段，第二道令
  //   整段消失且没有提示——和 90 修的是同一类错，只是触发条件从"没标点"变成"连接词写错"。
  // 只在"在 + 动作词"、且**前段像一条令**（有动作词，或点名了地标）时才当连接词，所以：
  //   「现在去北桥」「正在撤退」「还在北桥」「已在原地」「就地驻守」一个都不受影响。
  //   「全军在去北桥」也不受影响——前段只是"全军"，既无动作也无地名。
  //   允许"点名了地标"是为了 C07：「先占北桥在让弓兵队上去」的前段「占北桥」在 b 层不算完整令，
  //   不切就会塌成单条 ATTACK 并静默派兵，而规范写法「再让」是明确没执行（见守卫 ③ 的注释）。
  //   「在」自己不进 CHAIN_CONNS——那样"在原地驻守"会被切成"原地驻守"两段，整条作废。
  const ZAI_NEXT=/[去往到进退攻守打撤占集走跑上冲杀过跨跟支服调让]/;
  const ZAI_PREV=/[现正还仍已就存所并再]/;
  function splitAtZai(t){
    const s=String(t||'');
    if(s.indexOf('在')<0)return null;
    const cuts=[];
    for(let i=s.indexOf('在');i>=0;i=s.indexOf('在',i+1)){
      if(i===0||i===s.length-1)continue;
      if(!ZAI_NEXT.test(s[i+1]))continue;       // "在"后面不是动作 → 介词/存现句，不动
      if(ZAI_PREV.test(s[i-1]))continue;        // 现在/正在/还在/已在/就地… → 不是"再"
      // ③ 前段要"像一条令"：有动作词，**或**点名了地标。
      //   「先占北桥在让弓兵队上去」的前段「占北桥」在 b 层不算完整令（"占"单字不在词表），
      //   若不切，整句会塌成一条 ATTACK 并**静默派兵**；而规范写法（"再"）是明确 FAILED。
      //   噪声不该把"说得出错在哪"变成"悄悄执行一条错的令"——切了第一段照旧 FAILED，但同归。
      //   放宽只认地标名，不认泛词：「全军在去北桥」的前段是"全军"，仍不切（那句本来就该执行）。
      const pre=s.slice(0,i);
      if(!primaryActionIn(pre)&&!REG.landmarks.some(l=>pre.indexOf(l.name)>=0))continue;
      if(!primaryActionIn(s.slice(i+1)))continue;   // 后面没动作，切了只剩个尾巴
      cuts.push(i);
    }
    if(!cuts.length||cuts.length>3)return null;
    const out=[];
    let prev=0;
    for(const c of cuts){
      const seg=s.slice(prev,c).replace(/^先+/,'');
      if(seg&&!SEG_FILLER.test(seg))out.push(seg);
      prev=c+1;                                  // 连"在"一起吃掉：它是连接词，不是内容
    }
    const tail=s.slice(prev).replace(/^先+/,'');
    if(tail&&!SEG_FILLER.test(tail))out.push(tail);
    return out.length>1?out:null;
  }

  // ── 分兵句（90）──────────────────────────────────────────────────
  // 「主将队去北桥，骑兵队去打敌弓兵队」——一句话里两支部队各有一个任务。
  // 为什么不切就是错的：两段落在同一个 parseCommand 里，实体被一起收走，结果是
  //   `MOVE(主将队+骑兵队) → 敌弓兵队`：部队被合成一支、地点丢了、目标变成"移动到敌人身上"，
  //   而"打敌弓兵队"这件事**整段消失**（连"未执行"的提示都没有，因为动作只取了一个）。
  // 判据刻意收得很紧，三条同时成立才切：
  //   ① 每一段都**自带我方部队**做主语 —— 只有一段有主语的是"命令 + 说明/条件"
  //      （「顶住，等我过来」），那是 parseCommand 里"主令在第一分句"的活，切了会把说明当第二步执行；
  //   ② 每一段都**自带动作词** —— 只是提到一支部队（「全军去北桥，敌弓兵队在南边」）不算第二道令；
  //   ③ 段首不是条件引导词，段数不超过 4。
  // 主语必须是**我方**：敌军做主语的是敌情说明（「全军去北桥，敌弓兵队在后面掩护」里的"掩护"
  //   在我们词表里是 FOLLOW，不剔就会当真下一条"跟着敌军"的令）。
  const SEG_COND_LEAD=/^(等|待|如果|要是|假如|若|一旦|万一)/;
  function splitBySubject(raw){
    const clauses=String(raw||'').split(/[，,。；;]/).map(s=>cmdNorm(s)).filter(Boolean);
    if(clauses.length<2||clauses.length>4)return null;
    const uW=unitWords();
    for(const s of clauses){
      if(SEG_COND_LEAD.test(s))return null;
      if(!primaryActionIn(s))return null;
      if(!cmdFindSpans(s,uW).length)return null;
    }
    return clauses;
  }

  // ── 无标点的分兵句（92）──────────────────────────────────────────
  // 语音转写**不出标点**（流式中文模型），90 的 splitBySubject 就永远只拿到一段——
  //   「主将队去北桥骑兵队去打敌弓兵队」会被读成一条：两支部队合并、地点只剩一个、
  //   第二件事整段消失。这里不靠标点，靠**我方主语的第二次出现**找切点。
  // 四条守卫（少一条就会把宾语当主语、把一道令切成两道）：
  //   ① 切点**紧前不是动作词**——「弓兵队攻击｜枪兵队」里后者是宾语，不是第二道令
  //   ② 切点紧前不是连词（和/与/跟/及）——「枪兵队和骑兵队去北桥」是一道令
  //   ③ 切点之前**已经是一条完整的令**（有动作词），切点之后也还有动作词
  //   ④ 段数 2~4，第一个主语在句首附近
  // 只对**完全无标点**的文本生效：有标点的仍走 90 的路径，两条判据不叠加
  //   （叠加会让「全军去北桥，敌弓兵队在南边」这类"命令+说明"多出一次切分机会）。
  // 找主语必须**找全部出现**：cmdFindSpans 只取第一处，「全军…全军…」会漏掉第二个。
  function findAllSpans(text,table){
    const hits=[];
    for(const id in table)for(const w of table[id]){
      for(let p=text.indexOf(w);p>=0;p=text.indexOf(w,p+1))hits.push({id,w,start:p,end:p+w.length});
    }
    hits.sort((a,b)=>b.w.length-a.w.length||a.start-b.start);
    const kept=[];
    for(const h of hits)if(!kept.some(k=>h.start<k.end&&k.start<h.end))kept.push(h);
    return kept.sort((a,b)=>a.start-b.start);
  }
  function endsWithAction(s){
    return TXT_ACTIONS.some(([,ws])=>ws.some(w=>w.length<=s.length&&s.slice(-w.length)===w));
  }
  const JOIN_CH=/[和与跟及]/;
  // ① 的例外：状态类动作**不带宾语**，后面跟的只能是新主语，不可能是它的宾语。
  //   没有这一条，「全军戒备｜全军去北桥」会被当成"戒备谁"而整句不切——
  //   而「弓兵队攻击｜枪兵队」必须挡住，那才是"打谁"。
  const END_OK=/(戒备|集结|集合|待命|驻守|驻防|驻扎|休整|撤退|后撤|停止|停下|按兵不动)$/;
  // 92：统称前缀属于**第二段的主语**，不属于上一段的尾巴。
  //   「所有骑兵去东侧营地所有枪兵去北桥」按"枪兵"下刀，会把"所有"留在第一段，
  //   第二段的 `expandArms` 就展不开——4 支枪兵缩成 1 支（噪声不变式测量 C18 抓到）。
  //   前缀与 `ARM_ALL_RE` 同源，不另造词表；只挪**切片位置**，守卫仍按语义主语起点判。
  const ARM_ALL_PREFIX=/(?:所有的?|全部的?|各个|各位|全体|全)$/;
  function splitBySubjectNoPunct(raw){
    const s=cmdNorm(raw);
    if(!s)return null;
    if(/[，,。；;、！？!?：:]/.test(String(raw||'')))return null;   // 有标点：归 90 的路径
    const uW=unitWords();
    const spans=findAllSpans(s,uW).filter(sp=>s[sp.start-1]!=='敌');
    if(spans.length<2||spans.length>4)return null;
    if(spans[0].start>2)return null;                  // 第一个主语得在句首附近
    const cuts=[];
    for(let i=1;i<spans.length;i++){
      const sp=spans[i];
      const before=s.slice(0,sp.start);
      if(JOIN_CH.test(before.slice(-1)))return null;  // ②
      if(endsWithAction(before)&&!END_OK.test(before))return null;   // ①
      if(!primaryActionIn(before))return null;        // ③ 前
      if(!primaryActionIn(s.slice(sp.start)))return null;  // ③ 后
      const qm=ARM_ALL_PREFIX.exec(before);
      const cut=qm?sp.start-qm[0].length:sp.start;
      if(!cuts.length||cut!==cuts[cuts.length-1])cuts.push(cut);
    }
    if(!cuts.length)return null;
    const out=[];
    let prev=0;
    for(const c of cuts){
      if(c<=prev)continue;
      const seg=s.slice(prev,c);
      if(seg&&!SEG_FILLER.test(seg))out.push(seg);
      prev=c;
    }
    const tail=s.slice(prev);
    if(tail&&!SEG_FILLER.test(tail))out.push(tail);
    return out.length>1?out:null;
  }

  // ── 条件从句（78）：把"什么时候做"从一句话里拆出来 ──────────────────────
  // 上司 2026-11-02 的 ③：一段话里有先后的主谓宾，中间要有**触发**。
  //   "去北面树林埋伏，遇到普通敌人不攻击，直到看到敌人主将才发动进攻"——
  //   这里其实有两种东西，不能混：
  //     · 触发（when）：条件成立才做下一段 → 交给 c 层的 step.when，真假由 d 层算
  //     · 压制（suppress）：等的时候**不许主动打** → 这是部队状态，不是条件
  // 混在一起的后果很具体：把"不攻击"当成条件，兵就会等一个永远不会成立的条件。
  //
  // 认三种说法，落点是同一个 when：
  //   ① 「（一直）直到/等到 X 才 Y」——条件在前、主句在后
  //   ② 「X 就 Y」且 X 只有"看见了谁"、没有主令动作（"遇到敌人就打"）
  //   ③ 同一句里条件与主句顺序反过来（"守着，直到他们过河"）——**本轮不认**，
  //      因为它和"先守、再等到…"在中文里同形，认错方向就是把兵钉在原地一整局。
  // 换不成 when 的，**不许当条件放过**：原样返回 ok:false，由 c 层拒令并说清。
  //   宁可问一句，不可把条件句当成无条件令执行——那正是 70 定为 blocking 的理由。
  const COND_LEAD=/(?:一直|就)?(?:直到|等到|待到)/;
  const PERCEIVE=/(看到|看见|望见|发现|遇到|碰上|撞上|遇见|听见|听到|见到)/;
  const CMDER_RE=/(敌主将|敌人主将|敌军主将|敌方主将|敌将|我主将|主将|将旗|首领|头目)/;
  const FOE_RE=/(敌人|敌军|敌兵|敌队|敌骑|敌枪|敌弓|敌方|敌)/;
  // 「遇到 X 不攻击」不是条件，是压制：整句在说"别主动打"。
  //   判据是"感知短语 + 否定 + 攻击类动词"，不是黑名单词——换个动词照样认得出。
  const SUPPRESS_RE=/(?:遇到|碰上|撞上|看见|发现|见到)[^]{0,12}?(?:不|别|不要|不许|不准)(?:主动)?(?:攻击|打|动手|还手|出击|接敌)/;
  const SUPPRESS_ANY=/(不许接敌|不准接敌|不接敌|别接敌|不要接敌|不主动攻击|不要主动|不许动手|不要动手|按兵不动等他)/;
  function isSuppressClause(s){return SUPPRESS_RE.test(s)||SUPPRESS_ANY.test(s);}
  // 中文数字（"等两秒"）。与 gridCount 同一个口径，但这里拿到的是不带"格"的数。
  function cnNum(s){
    if(/^[0-9]+$/.test(s))return +s;
    if(s==='十')return 10;
    if(s.length===2&&s[0]==='十')return 10+(CN_NUM[s[1]]||0);
    if(s.length===2&&s[1]==='十')return (CN_NUM[s[0]]||1)*10;
    return CN_NUM[s[0]]||null;
  }
  // 条件短语 → when。认不出就是 null（不猜）。
  //   · 带"过河/一半/半渡/渡到"的不认：「等他们渡河到一半」要的是"半渡而击"，
  //     换成"看到敌人"会把时机整个提前，比拒令更糟。
  function condOfCond(s){
    const t=(s||'').replace(COND_LEAD,'');
    if(/渡河|过河|一半|半渡|渡到/.test(t))return null;
    const sec=/([0-9]+|[一二两三四五六七八九十]{1,3})\s*秒/.exec(t);
    if(sec){const n=cnNum(sec[1]);if(n)return {kind:'elapsed',sec:n};}
    if(PERCEIVE.test(t)&&FOE_RE.test(t)){
      const w={kind:'sight',who:CMDER_RE.test(t)?'commander':'foe'};
      const d=/([0-9]+|[一二两三四五六七八九十]{1,3})(?:个)?\s*格/.exec(t);
      if(d&&cnNum(d[1]))w.dist=cnNum(d[1]);
      return w;
    }
    return null;
  }
  // 一条指令 → {ok, pre:[前段文字], suppress:bool, mainText, cond, condText}
  //   返回 null 表示"这句话没有条件结构"，走原来的路（不改变任何既有行为）。
  function extractCond(raw){
    let clauses=(raw||'').split(/[，,。；;！!？?]/).map(s=>(s||'').trim()).filter(Boolean);
    // 没有标点的「遇到敌人就打」：中文里这类条件句常常一口气说完，靠"就"分界。
    //   不先切这一刀，整句会被当成一条命令，条件从句根本认不出来（splitSegments 会切成
    //   ["遇到敌人","打"]，但那时"遇到敌人"已经被当成主令去解析）。
    if(clauses.length<2){
      // 没有标点的一口气句：「遇到敌人就打」「全军等 3 秒再进攻」。
      //   分界词抓到了还不够，前半句必须**确实是个条件**（感知或时间），否则
      //   「全军去北桥再驻守」也会被这一刀切开——那句该交给 splitSegments。
      const m=/^(.{1,18}?)(就|便|再|然后|才)(.{1,40})$/.exec((raw||'').trim());
      if(m&&(PERCEIVE.test(m[1])||COND_LEAD.test(m[1])||/[0-9一二两三四五六七八九十]\s*秒/.test(m[1])))
        clauses=[m[1],m[3]];
    }
    if(clauses.length<2)return null;
    // ① 「… 直到 X 才 Y」
    for(let i=0;i<clauses.length;i++){
      const c=clauses[i];
      const m=COND_LEAD.exec(c);
      if(!m)continue;
      const head=c.slice(0,m.index).trim();       // "直到"前面可能还有半句（"守着一直等到…"）
      const rest=c.slice(m.index);
      const ci=rest.indexOf('才');
      const condText=(ci>0?rest.slice(0,ci):rest).trim();
      const cond=condOfCond(condText);
      if(!cond)
        return {ok:false,seg:i+1,
          reason:`「${condText}」这个条件现在说不成触发。能等的有两种：看到某支敌军（或敌主将）进视野、过几秒；`
            +`「渡河到一半」这类时机还表达不了。`};
      let mainText=(ci>0?rest.slice(ci+1):'').trim(), mi=i;
      if(!mainText||!primaryActionIn(mainText)){
        mainText=null;
        for(let j=i+1;j<clauses.length;j++)
          if(primaryActionIn(clauses[j])){mainText=clauses[j];mi=j;break;}
      }
      if(!mainText)
        return {ok:false,seg:i+1,reason:'只说到了条件，没说条件成立之后做什么'};
      const pre=clauses.slice(0,i);
      // "直到"前面那半截：是命令就单独成段，是主语就拼回主句。
      //   不拼的话「全军直到看到敌主将才进攻」会让"全军"两个字单独成段——
      //   它解析不出动作，整条命令就地作废，而玩家说的是完全成立的一句话。
      if(head){
        if(primaryActionIn(head))pre.push(head);
        else if(mainText.indexOf(head)<0)mainText=head+mainText;
      }
      return buildItems(pre,clauses,mainText,cond,condText,i,mi);
    }
    // ② 「X 就 Y」：X 没有主令动作，只有条件（看见谁 / 过几秒）
    for(let i=0;i<clauses.length-1;i++){
      const c=clauses[i];
      if(primaryActionIn(c))continue;
      const cond=condOfCond(c);
      if(!cond)continue;
      for(let j=i+1;j<clauses.length;j++){
        if(!primaryActionIn(clauses[j]))continue;
        const sub=condSubj(c);
        const main=(sub&&clauses[j].indexOf(sub)<0)?sub+clauses[j]:clauses[j];
        return buildItems(clauses.slice(0,i),clauses,main,cond,c,i,j);
      }
    }
    return null;
  }
  // 条件从句里夹着的主语（"全军等 3 秒""全军直到看到敌主将"）：摘走条件词之后，
  //   若还剩一个**认得出**的主语，就把它拼回主句。不拼的话"全军"跟着条件一起被扔掉，
  //   命令会悄悄变成"对画面内所有部队"——人数变了，玩家还不知道。
  //   只认得出才用：残渣不是主语时宁可丢掉，也不要往主句里塞一段谁也解析不了的字。
  function condSubj(c){
    const r=(c||'')
      .replace(/[等待]+\s*[0-9一二两三四五六七八九十]{1,3}\s*秒/g,'')   // "等 3 秒"
      .replace(COND_LEAD,'')
      .replace(new RegExp(PERCEIVE.source,'g'),'')
      .replace(/敌[^]{0,4}?(主将|将|军|兵|队|人)/g,'')
      .replace(/[的了吗呢吧啊，,]/g,'').trim();
    return r&&cmdFindSpans(r,unitWords()).length?r:'';
  }
  // 前段里夹着"遇到普通敌人不攻击"这种压制从句：它不是一条命令，读成 STOP 就错了
  //   （"不攻击"里的否定会被 negationOf 翻成"停止"），所以先摘出来当 suppress。
  function buildItems(pre,clauses,mainText,cond,condText,condAt,mainAt){
    const segs=[],supp=[];
    for(const s of pre){
      if(isSuppressClause(s)){supp.push(s);continue;}
      if(s&&(primaryActionIn(s)||hasActionWord(s)))segs.push(s);
      else if(s)return {ok:false,seg:1,reason:`「${s}」这段没有一个能执行的动作`};
    }
    // 条件与本段之间被跳过的句子（"直到X才Y"后面还有半句）：不静默吞掉，报出来
    const skipped=clauses.slice(mainAt+1).filter(Boolean);
    return {ok:true,pre:segs,suppress:supp.length>0||isSuppressClause(condText),
      mainText:mainText,cond:cond,condText:condText,skipped:skipped};
  }

  // 只有这几类动作"需要一个地点"，其余动作里出现的地名只是顺带提到，不该拿它追问。
  //   "不许过桥"被判成"你提到多处（1.南桥 2.北桥）"就是这么来的——
  //   那是一条过河许可令，问"要去哪一处"完全没有意义。
  const LOC_ASK=['MOVE','DEFEND','CAPTURE','RALLY','RECON','ATTACK','FOLLOW'];
  // 「往前三格」和「往前3格」一样常见，只认阿拉伯数字的话"北桥前面两格"就整句没动作。
  const CN_NUM={一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10};
  function gridCount(t){
    // 92：口语会说"三个格子""3 个格子"，同一个数——`个?` 可省，其余口径不变
    const m=/([0-9]+|[一二两三四五六七八九十]{1,3})(?:个)?\s*格/.exec(t);
    if(!m)return null;
    if(/^[0-9]+$/.test(m[1]))return +m[1];
    const s=m[1];
    if(s==='十')return 10;
    if(s.length===2&&s[0]==='十')return 10+(CN_NUM[s[1]]||0);
    if(s.length===2&&s[1]==='十')return (CN_NUM[s[0]]||1)*10;
    return CN_NUM[s[0]]||null;
  }
  // "看到/听到/遇到"里的"到"是补语，不是移动。不放这个例外，
  //   "看到敌人就放箭"会被读成"前进"（第一分句"看到敌人"里只有那个"到"）。
  const SEE_VERB=/(看到|看见|听见|听到|遇到|想到|收到|见到|得到|达到|做到|料到|碰到|撞到|闻到)/;
  // 这一小句里到底有没有"主令动作"：剥掉"看到/听到"这类动词后，还剩动作词，或整句是个短令。
  //   不剥的话"看到敌人"里的"到"会被当移动；剥了之后仍靠完整词表判，单字令（"撤""打"）也不丢。
  function primaryActionIn(s){
    const t=s.replace(new RegExp(SEE_VERB.source,'g'),'');
    return hasActionWord(t)||!!shortCmdAction(t);
  }
  // 91：**这个分句里的动作是什么**（不只是"有没有动作"）。
  //   F6 要判"第二分句是不是站桩动作"，光知道"有动作"不够。
  //   口径与主扫描完全一致（同一张 TXT_ACTIONS、同一套最长优先）——
  //   两处各写一遍就会漂：这里认为第二段是 DEFEND、主扫描却给出别的。
  function actionInClause(s){
    if(!s)return null;
    let best=null;
    for(const [name,words] of TXT_ACTIONS)for(const w of words){
      const p=s.indexOf(w);
      if(p<0)continue;
      if(!best||w.length>best.len||(w.length===best.len&&p>best.p))best={action:name,len:w.length,p};
    }
    return best?best.action:null;
  }
  // ── b→c 契约（69）：c 层能力声明 + b 层出口闸 ──────────────────────────
  // 要解决的问题不是"b 层偶尔认错"，而是"b 层交出一条 c 层没有办法执行的命令"。
  //   后者一旦发生，c 层的 switch 走到末尾返回 undefined，调用方读 out.status 直接崩——
  //   这不是执行错，是整个命令通道断掉。
  // 做法两道：
  //   ① bindCaps() 在启动时断言：b 层所有**产出点**的 action 都必须在 c 层能力表里。
  //      不是抄一遍词表了事——TXT_ACTIONS 只是四个产出点之一，另外三个是短令表
  //      SHORT_MAP、否定式表 NEG_TO、以及"某地+几格"处硬编码的 MOVE。只查词表会漏。
  //   ② guardOut() 在每次 parse 出口兜一道：万一漏了，把 action 摘掉变成追问，
  //      而不是把一个 c 层不认识的动作交出去。
  // 未绑定（纯 b 层测试环境）时**不设闸**：那时要测的正是"b 层能认出什么"，
  //   和"认出来的东西 c 层接不接得住"是两件事，必须分开测。绑定后才要求两者一致。
  let gCaps=null;
  function declaredActions(){
    const s=new Set();
    for(const [a] of TXT_ACTIONS)s.add(a);
    for(const k in SHORT_MAP)s.add(SHORT_MAP[k]);
    for(const k in NEG_TO)s.add(NEG_TO[k]);
    s.add('MOVE');   // "北桥前面两格"这类无动作词的补全，硬编码在 parseCommand 里
    // 97：`CAPTURE_ON` 不会作为 `cmd.action` 出现（主令仍然是 ATTACK），
    //   但 b 层确实会把它写进 `cmd.ops`（「活捉」的第二段），c 层必须接得住——
    //   所以它同样是"b 层能产出"的动作，必须在这里声明，否则就是 b 吐了 c 不认的东西。
    s.add('CAPTURE_ON');
    // 98：RUSH_ON 同样不会作为 cmd.action 出现（主令仍是 ATTACK），但 b 层会写进 ops，
    //   c 层必须接得住——87 教训：注入了不等于收下了，声明与能力表要成对加。
    s.add('RUSH_ON');
    s.delete(null);s.delete(undefined);
    return [...s];
  }
  // 战术词与动作同理：b 能认出的战术 key，c 层必须有对应判据（做到 / 做不到 / 怎么降级）。
  //   'conditional' 不在 TACTICS 表里——它依赖句内的 noEscape 这类上下文，只能单独测——
  //   但同样会写进 cmd.tactics，所以必须一并声明，否则就是漏一个 c 层不认识的槽。
  function declaredTactics(){
    const s=new Set(TACTICS.map(r=>r[0]));
    s.add('conditional');
    return [...s];
  }
  function bindCaps(caps,tactCaps){
    gCaps=caps||{};
    const all=declaredActions();
    const missing=all.filter(a=>!gCaps[a]);
    if(missing.length){
      const cn=missing.map(a=>CMD_VERBS[a]||a).join('、');
      throw new Error(`[b→c 契约] b 层能产出、c 层没有执行方式的动作：${missing.join(', ')}（${cn}）。`
        +`加动作的顺序必须是「先在 ACTION_CAPS 声明，再往词表加词」，反过来就会产出无法执行的命令。`);
    }
    let tk=null;
    if(tactCaps){
      const keys=declaredTactics();
      const mt=keys.filter(k=>!tactCaps[k]);
      if(mt.length){
        throw new Error(`[b→c 契约] b 层能认出、c 层没有判据的战术词：${mt.join(', ')}。`
          +`加战术词的顺序必须是「先在 TACTIC_CAPS 声明，再往 TACTICS 加词」——`
          +`否则玩家说了「${mt.join('、')}」，b 层标了出来，c 层却当成没说过。`);
      }
      tk={ok:true,tactics:keys.length};
    }
    return {ok:true,caps:Object.keys(gCaps).length,actions:all.length,tactics:tk};
  }
  function guardOut(res){
    if(!gCaps||!res||!res.cmd)return res;
    const a=res.cmd.action;
    if(!a)return res;
    if(!gCaps[a]){
      res.cmd.action=null;
      res.cmd.op=null;
      res.clarification_required=true;
      res.missing=null;
      res.contractViolation={action:a,code:'UNKNOWN_ACTION'};
      res.assistantQuestion=`「${a}」这个动作还没有对应的执行方式。`
        +`现在能做：${Object.keys(gCaps).map(k=>CMD_VERBS[k]||k).join(' / ')}。`;
      return res;
    }
    // 71 四类收拢：表内动作把类别挂在出口，c 层分发前不必再查表。
    //   放出口而不是放 c 层，是因为"这个动作属于哪一类"是**语义**，不是执行细节——
    //   c 层只需要知道"这是移动/攻击/状态"，不需要知道 MOVE 和 RETREAT 的区别。
    res.cmd.op=gCaps[a].op||null;
    return res;
  }
  // ── 战术词：b 层只标"这句话说了什么"，不判"做不做得到"（70）────────────
  // 为什么拆开：做到做不到取决于世界规则（有没有俘虏机制、阵型加不加成），那是能力表
  //   的知识，属于 c 层。b 层写死一遍、c 层再写一遍，两处一定会漂——"生擒按攻击执行"
  //   就是漂出来的那一类：b 层认出来了，却仍然让兵把人打死了。
  // b 的门槛是"认出这个词"，c 的门槛是"这个词现在接不接得住"。
  // 每行的 say 就是原来 push 进 unsupported 的那句话，一字未改：注记是审计信息，
  //   证明"我认出来了"；能不能执行由 c 层单独判。两件事不能合并成一句。
  const TACTICS=[
    ['flank',      t=>/绕过去|绕行|绕开|侧面绕|包抄|包夹|夹击|绕后|绕到敌后|迂回|穿插|抄后路|断敌退路/.test(t),
                   '绕行/包抄偏好暂未实现，按常规路线执行'],
    ['ambush',     t=>/埋伏|伏击|设伏|伏兵|打个伏击|隐伏|伏于|藏在.{0,6}等/.test(t),
                   '伏击：停在设伏点不主动接敌，说定的条件成立才动手；被打了会还手，位置也就暴露了'],
    ['encircle',   t=>/合围|包围|围住|围攻|围困|围歼|围而不打|围点打援|分割包围|分割|各个击破|割裂/.test(t),
                   '合围：各队分头占住目标周围一个方位，到点即战；兵少则围不满，会写明占住几个方位'],
    ['stratagem',  t=>/诈降|诱敌|引蛇出洞|声东击西|调虎离山|疑兵|虚张声势|空城计/.test(t),
                   '计谋类战术（诱敌/诈降/疑兵）暂未实现：按字面动作执行'],
    ['formation',  t=>/布阵|组阵|结阵|鹤翼|鱼鳞|锋矢|偃月|一字长蛇/.test(t),
                   '阵型配置暂未实现：部队按各自命令行动'],
    ['formation',  t=>/在前|在后|左翼|右翼|两翼|中军|前锋|后卫/.test(t),
                   '阵型/翼侧配置暂未实现：部队将按各自命令行动'],
    ['capture',    t=>/生擒|活捉/.test(t),
                   '活捉：照常攻击，打垮对方那一刻留活口（随军没有将领的敌人抓不到人）'],
  ];
  // ── "没设计"的词（75）──────────────────────────────────────────────
  // 这些词玩家真会说，但**现在没有对应的动作**。以前它们被打包进长得最近的那个
  //   （扎营→驻守、列阵→叫援军、休整→停止、停战→停止），玩家说了 A 得到 B，
  //   而且一句提示都没有——这比"没做"更坏："没做"他会换个说法，"做错了"他不会。
  // 判据沿用上司那句话：**对应不上三类动作，就是没设计，要明说没设计。**
  // 只在**整句没有别的动作**时才接（`!cmd.action`），所以"先扎营再攻击"仍以攻击为主令。
  const NOT_YET=[
    [/(扎营|安营|下寨|扎寨|结营|立营|宿营)/, '扎营/宿营还没做（它是个状态：回血、士气 +8）。现在能让部队「驻守」或「原地待命」，但不会就地立营'],
    [/(筑垒|深沟高垒|修工事|挖壕|立栅|结硬寨)/, '筑垒（修工事）还没做：现在只有驻守的静态防守，没有工事加成'],
    [/(休整|歇会|歇一歇|喘口气)/, '休整（恢复精力、回血）还没做：可以说「原地待命」，兵会站着，但不会特意恢复'],
    [/(准备迎战|弓箭手准备|做好战斗准备|准备战斗)/, '「准备迎战」还不成句：要守住这儿说「驻守」，要抬警戒说「戒备」，要放箭说「弓兵队放箭」'],
    // 「停战/休战/和谈」在 parseCommand 开头就截住了（STOP 的单字"停"会抢先接住），不在这张表里。
  ];
  function notYetOf(text){
    for(const [re,say] of NOT_YET)if(re.test(text))return say;
    return null;
  }
  // ── 必须要宾语才定类的两组词（75）──────────────────────────────────
  // 词表只能给"这类词最常见的那个动作"，**宾语才决定它到底是哪个动作**：
  //   · 支援/驰援：宾语是友军→跟随（跟着它走），是地点→移动，都没有→问"支援谁"。
  //   · 拦住/挡住/堵住/封锁：宾语是敌军→攻击（迎上去拦），是地点/没有→驻守。
  // 这两组原来硬编码了一个动作，于是"支援骑兵队"变成"往某处移动（地点还不知道）"——
  //   宾语被认出来了却没有参与决策。见 ACTIONS.md §6.3 第 11、12 条。
  const SUPPORT_RE=/(支援|驰援|增援|接应|策应|救援|援助)/;
  const BLOCK_RE=/(拦住|挡住|堵住|封锁|卡住|堵口|别让他们过来)/;
  // ── 上下文还原（84）──────────────────────────────────────────────────
  // 契约见 BC_CONTEXT_TASKBOOK §3.4 / §3.5。三条铁律：
  //   ① **只改文本，不造 cmd** —— 造结构就会长出第二套动作识别，两套必然漂；
  //   ② 词表封闭（只增不删，每次增要配断言），不做"有活任务就都当命令"的启发；
  //   ③ 位置固定：normalizeRoles 之后、cmdNorm/域外判定/动作识别之前。
  //     放后面等于永不执行 —— 省略句没有实体也没有动作词，domainEvidence 一定返回空。
  let ctxReader=null;
  function wireCtx(fn){ctxReader=fn||null;}
  function ctxSnapshot(){try{return ctxReader?ctxReader():null;}catch(e){return null;}}
  // ── BattleContext 注入通道（86 建通道 / 87 开始消费）────────────────
  // 和 wireCtx 同一形态：**传函数不传快照**（每帧都在变，存下来就是旧数）。
  // 86 只建通道不消费，先让 mapread_test 把口上的数逐条对真值；
  // 87 起消费，但只消费**事实**：地表类型、岸别、过河点、可达性——
  //   不消费任何"该去哪、哪条路更好"的结论（d 层不给判断，b 层也不替玩家挑）。
  let battleCtxReader=null;
  function wireBattleContext(fn){battleCtxReader=fn||null;}
  function battleContext(){
    if(!battleCtxReader)return null;
    try{return battleCtxReader();}catch(e){return null;}
  }
  // 87：地图事实的取用口。**每句只装配一次**——parseCommand 开头清空。
  //   为什么要"每句一次"而不是"每次调用一次"：c 层处理一句话会调好几次 parse
  //   （整句、分句、条件从句），每次都重建快照既是白花钱，同一次解析里还可能读到两份不同的世界。
  //   也不做成跨句缓存：世界每 tick 都在变，"上一句话看到的地图"不是这一句话的事实。
  let mapSnap=null, mapTaken=false;
  function mapReset(){mapSnap=null;mapTaken=false;}
  function mapCtx(){
    if(mapTaken)return mapSnap;
    mapTaken=true;
    mapSnap=battleContext();
    return mapSnap;
  }
  // 续令词（封闭）。与 DOMAIN_CONT 同源但更严：只在这些词**独占整句**时才还原。
  const ELL_CONT=['继续','照旧','照原计划','原计划','按刚才','照刚才那样','再来一次','接着来','重复','重来'];
  const ELL_THERE=/(那儿|那里|这儿|这里|那地方|老地方|原来那)/;
  const ELL_PRONOUN=/(他们|她们|它们|他|她|它|那支|那几支|这几支|这两个)/;
  // 「跟上」「跟着」自带的默认被跟随者（85）。
  //   为什么要有：`跟上/跟着` 在 FOLLOW 词表里，c 层拿到"有动作、没有两头"就问
  //   「护卫这事得说两头：谁护谁」——玩家说的是"后队跟上"，被读成一条护卫令。
  //   **收成一条整句式**（不是"含跟上就靠拢"）：否则「跟上时代」也会变成行军。
  const FOLLOW_SELF_RE=/^(?:(?:全军|全体|所有人|大家|各队|众将|后队|前队|前军|后军|其余|剩下的|其余的|后面的)[^，。]{0,6})?(?:都|全|快|赶紧|一起)*?(?:跟上|跟着|跟上来|跟紧|跟住|跟上队伍|跟着我|跟上我|跟着来)(?:了|吧|啊|来)?$/;
  const ELL_DONE=['done','lost','superseded'];
  // 还原目标 → 能被下文的动作识别重新吃进去的动词（必须出自 TXT_ACTIONS 的词）
  const ELL_VERB={MOVE:'前往',DEFEND:'驻守',CAPTURE:'占领',RALLY:'集结于',ATTACK:'攻击',
    STANCE_ON:'转入戒备',STANCE_OFF:'转为常行',RETREAT:'撤退',STOP:'停止',FOLLOW:'跟随'};
  function ellFinal(ph){return ELL_DONE.indexOf(ph)>=0;}
  // 部队展开成文本：覆盖全部队时写"全军"，否则逐个点名（不能写 ALL，那次解析会漏掉"哪支"）
  function ellUnits(ids){
    const all=REG.units.map(u=>u.id);
    if(ids&&ids.length&&all.length&&all.every(id=>ids.indexOf(id)>=0))return '全军';
    return (ids||[]).map(unitName).join('、');
  }
  // 目的地只还原 **place**：坐标（`dest.type==='cell'`，鼠标点地图那条路）在语言里没有说法，
  //   硬写成"第 12 格"既不是玩家的话，也违背 55 的去坐标化。
  function ellPlace(dest){
    if(!dest||dest.type!=='place')return null;
    const l=landmarkById(dest.id);
    return l?l.name:null;
  }
  function ellDoneMsg(tk){
    const place=ellPlace(tk.dest);
    return `刚才那条已经办完（${ellUnits(tk.units)}已在${place||'位'}），要改哪一步？`;
  }
  // 把一条任务渲染回一句完整命令。办不到（缺地点/缺目标）就返回 null，交给原路径追问。
  function ellRender(tk,kind,units,dir){
    const u=ellUnits(units||tk.units);
    if(!u)return null;
    const k=kind||tk.kind;
    const verb=ELL_VERB[k];
    if(!verb)return null;
    if(k==='MOVE'||k==='DEFEND'||k==='CAPTURE'||k==='RALLY'){
      if(dir)return `${u}往${dir}推进`;
      const place=ellPlace(tk.dest);
      return place?`${u}${verb}${place}`:null;
    }
    if(k==='ATTACK'){const foe=tk.foe?foeName(tk.foe):null;return foe?`${u}${verb}${foe}`:null;}
    return `${u}${verb}`;
  }
  // ── 统称·兵种展开（85）──────────────────────────────────────────────
  // 「所有枪兵」＝4 支（含主将队）—— 已拍板。为什么必须由 b 层展开：
  //   兵种是**语言层的知识**（玩家说"枪兵"），哪几支属于它由注入表说明（`type`），
  //   不该让 c 层拿 SIM 去数。展开方式沿用 84 的做法：**只改文本、不造结构**，
  //   展开成实体名之后照样走同一套实体识别与消歧（两套表必然漂）。
  // 词表封闭，且**必须带统称标记**才展开：
  //   「骑兵队」是一支部队的名字（实机里真有），绝不能因为含"骑兵"就展成两支。
  const ARM_KINDS=[
    [/枪兵|长枪兵|长枪|枪队/,'枪兵'],
    [/弓兵|弓箭手|弓手/,'弓兵'],
    [/骑兵|铁骑/,'骑兵'],
  ];
  function armOf(word){
    const hit=ARM_KINDS.find(([re])=>re.test(word));
    return hit?hit[1]:null;
  }
  function unitsOfArm(type){
    return REG.units.filter(u=>u.type===type).map(u=>u.name);
  }
  // 两种句式：① 统称前缀 + 兵种（所有枪兵／各个枪兵队／全体弓兵）
  //           ② 兵种 + 都/全（骑兵都／弓兵全）
  const ARM_ALL_RE=/(?:所有的?|全部的?|各个|各位|全体|全)(枪兵队?|长枪兵|长枪|弓兵队?|弓手|弓箭手|骑兵队?|铁骑)(?:们)?/g;
  const ARM_DOU_RE=/(枪兵|长枪兵|长枪|弓兵|弓手|弓箭手|骑兵|铁骑)(?:们)?(?:都|全)(?!军)/g;
  function expandArms(text){
    if(!text)return text;
    // 没注入兵种（老测试桩只给 id/name）就不展开：没有事实依据的展开是猜。
    if(!REG.units.some(u=>u.type))return text;
    const rep=(word)=>{
      const type=armOf(word);
      const names=type?unitsOfArm(type):[];
      return names.length?names.join('、'):null;
    };
    let t=text.replace(ARM_ALL_RE,(m,word)=>rep(word)||m);
    t=t.replace(ARM_DOU_RE,(m,word)=>rep(word)||m);
    return t;
  }
  // ── 序数（85）──────────────────────────────────────────────────────
  // 「第一支／第三支／最后那支」＝**右栏那张部队名单**的第 N 支（REG.units 的次序，
  //   与界面 `numberd()` 同源）。b 层只认序号，不认"哪支更能打"这种价值判断。
  const ORD_NUM={'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10};
  const ORD_RE=/(?:第\s*([一二两三四五六七八九十\d]+)\s*(?:支|个|队)|(最后|最前)(?:那|这)?(?:一)?支)/;
  function ordIndex(txt){
    const hit=ORD_RE.exec(txt||'');
    if(!hit)return 0;                          // 0＝不是序数句。别用 -1，那是"最后一支"
    if(hit[2])return hit[2]==='最后'?-1:-2;   // -1=最后一支，-2=最前一支
    const raw=hit[1];
    const n=/^\d+$/.test(raw)?parseInt(raw,10):(ORD_NUM[raw]||0);
    return n>0?n:0;
  }
  // 还原一条省略句。返回 null ＝ 不动（维持原判，58 的域外判据照旧）；{refuse} ＝ 追问；{text} ＝ 补全后的文本。
  function resolveEllipsis(raw,view){
    // 113+：先展开兵种统称（「所有枪兵」→ 四支）再判。
    //   原来 expandArms 只在 parseCommand 里、省略还原之后跑，于是「所有枪兵也一样」
    //   在这一层只认出"枪兵"一支，还原成"枪兵队前往某地"——说全军种，只去了一支。
    const t0=expandArms(cmdNorm(raw||''));
    if(!t0)return null;
    const focus=(view&&view.focus)||null;
    const bare=t0.replace(/^(全军|全体|所有人|大家|各位|弟兄们|兄弟们|各队|众将)/,'').replace(/[。！!？?]/g,'');
    const none=()=>({refuse:'这句我接不上——没有可沿用的上一条。'});
    // ① 续令：「继续」「照旧」——整句只有续令词时才认，避免"继续往前压"被当成纯续令
    if(ELL_CONT.some(w=>bare===w||bare===w+'吧'||bare===w+'了')){
      if(!focus)return none();
      if(ellFinal(focus.phase))return {refuse:ellDoneMsg(focus)};
      const txt=ellRender(focus);
      return txt?{text:txt,from:focus.id,kind:'cont'}:null;
    }
    // ② 指示：「守在那儿」「去那儿」
    if(ELL_THERE.test(t0)){
      if(!focus)return none();
      if(ellFinal(focus.phase))return {refuse:ellDoneMsg(focus)};
      const place=ellPlace(focus.dest);
      if(!place)return null;
      // 114 收口（上司拍）：**「在那儿射」不成话，不猜，直接说听不懂、请他重下。**
      //   先记下这条的来路，免得下次又"顺手修好"：
      //     · 113 及以前：这里只辨"守"与"走"，「在那儿射」落成 MOVE —— 兵走过去站着不射（错法一）。
      //     · 114 我改成 ATTACK（到点即战，无敌则驻守），理由写在当时的注释里：
      //       "宾语是地点不等于只是走过去"。**上司否了**：这条命令本身不该被理解——
      //       射谁？射什么？玩家没说过。把它读成"去那儿打"或"去那儿守"，两个都是在替他补主语。
      //     · 所以判据不是"改成另一个动作"，而是**这一类句子根本没构成命令**：
      //       带打的动作、只有指示地点、没有目标 → 拒绝并要求重新输入。
      //   ⚠ 只封"打"这一族；「守在那儿」「去那儿」照旧成立——它们的地点是真宾语，
      //     补全不改变这句话的意思（57：猜错的代价远大于多问一句；这里连猜都不该猜）。
      //   115 把这条写成了**通用判据**（见 `clauseGate`／`VALENCE`）：判的是配价，不是词表——
      //     这一层补不出来的正是**宾语**，而"打"的必需成分就是宾语；"守/去"的必需成分是地点，
      //     地点已经在那儿了，所以同一刀不该落在它们身上。两处结论相同，理由同源。
      if(/射|打|攻|冲|放箭|齐射/.test(t0)&&!/守|驻|防|待/.test(t0))
        return {refuse:'这句我听不懂——只说了要打、没说打谁。请重新下一道令：要打就点名打哪一支，要守就说「守住那儿」。'};
      const k=/守|驻|防|待/.test(t0)?'DEFEND'
        :(/去|到|过|往|走|开/.test(t0)?'MOVE':focus.kind);
      const verb=ELL_VERB[k];
      return verb?{text:`${ellUnits(focus.units)}${verb}${place}`,from:focus.id,kind:'there'}:null;
    }
    // ②b 序数（85）：「第一支去南桥」「最后那支过来」——按**右栏那张名单**取（REG.units 次序）。
    //   它不依赖上下文：名单一直摆在那儿，所以这条路放在 focus 判空之前。
    //   必须带动作词，否则「第一，我先说两句」会被当成点名（那就是新的误判）。
    {
      const idx=ordIndex(t0);
      if(idx!==0&&hasActionWord(t0)){
        const ids=REG.units.map(u=>u.id);
        const pick=idx===-1?ids[ids.length-1]:(idx===-2?ids[0]:ids[idx-1]);
        const u=pick?REG.units.find(x=>x.id===pick):null;
        // 句子里另外点了名就不抢：两种指代并存时，明说的那个赢（57：不猜）。
        const named=cmdFindSpans(t0,unitWords()).filter(sp=>sp.id!=='ALL');
        if(u&&(!named.length||named.every(sp=>sp.id===u.id)))
          return {text:t0.replace(ORD_RE,u.name),from:null,kind:'ordinal'};
      }
    }
    // ③ 代词：「追上他」——宾语指向焦点任务打的那支
    //   85 加了一道闸：**句中有地点就不当宾语**。「他们去北桥」是派部队过去，
    //   不是"去打上一条打的那支"；原来这条会把"他们去北桥"读成攻击令。
    if(focus&&focus.foe&&ELL_PRONOUN.test(t0)&&hasActionWord(t0)
       &&landmarkCandidates(t0).ids.length===0){
      if(ellFinal(focus.phase))return {refuse:ellDoneMsg(focus)};
      const foe=foeName(focus.foe);
      if(foe){
        // 113+：**玩家点了名就听他的**——代词只补宾语，不许覆盖主语。
        //   原来这里无条件用 focus.units 重写整句，「骑兵队也去打他们」被执行成
        //   「弓兵队去打」：玩家明说了骑兵队，系统把它换成上一条任务里的弓兵队，
        //   回执还念"弓兵队正接近敌弓兵队"——这句是卷子 A10，实测就错在这里。
        //   闸的形态与下面 ③b（代词作主语）同源：点了名就是明说，代词只剩语气作用。
        //   **「全军」也算点名**——第一版按 ③b 的写法把 ALL 过滤掉了，
        //   「全军去打他们」于是被改写成"上一条那几支去打"，说全军却只去了一支。
        const named=cmdFindSpans(t0,unitWords());
        if(named.length)return {text:t0.replace(ELL_PRONOUN,foe),from:focus.id,kind:'pronoun'};
        return {text:`${ellUnits(focus.units)}攻击${foe}`,from:focus.id,kind:'pronoun'};
      }
    }
    // ③b 代词作主语（85）：「他们去南桥」——代词指**上一任务派出去的那几支**。
    //   与 ③ 的分工一句话：**带地点指部队，带目标且没地点指敌人**。
    //   三道闸（缺一条就会把闲话或问句接成命令）：
    //     ① 代词之外没有点名部队（点了名就是明说，代词只是语气）；
    //     ② 句子里有地点（否则「他们怎么样了」这种问句会被接走）；
    //     ③ 不是问句（他们/哪/几/多少 同时出现时先当问话）。
    if(focus&&focus.units&&focus.units.length&&ELL_PRONOUN.test(t0)&&hasActionWord(t0)){
      if(ellFinal(focus.phase))return {refuse:ellDoneMsg(focus)};
      const named=cmdFindSpans(t0,unitWords()).filter(sp=>sp.id!=='ALL');
      const hasPlace=landmarkCandidates(t0).ids.length>0;
      const isAsk=/[哪吗呢几什么怎么为何多少]/.test(t0);
      if(!named.length&&hasPlace&&!isAsk)
        return {text:t0.replace(ELL_PRONOUN,ellUnits(focus.units)),from:focus.id,kind:'pronounUnit'};
    }
    if(!focus||ellFinal(focus.phase))return null;
    // ③c 代词作地点宾语（113+）：「守住它」「把它占下来」——"它"指上一条去过的那处。
    //   原来只有 ②（那儿/那里）认地点指代，「它」只被当成"不明指代"，一路问到 c 层
    //   回一句"你说的「它」我认不出指哪儿"。玩家上一句刚说了地名，这一句的"它"没有第二个候选。
    //   闸：① 句中没有任何具体地标（说了地名就听他的）；② 动作是守/占/夺/控这类**认地方**的。
    if(focus.dest&&ellPlace(focus.dest)&&/(它|它们|那座|那条|那片)/.test(t0)
       &&landmarkCandidates(t0).ids.length===0){
      const k=/守|驻|防|待/.test(t0)?'DEFEND'
        :(/占|夺|拿|控制|据/.test(t0)?'CAPTURE'
        :(/去|到|过|往|走|开/.test(t0)?'MOVE':null));
      if(k){
        const txt=ellRender(focus,k,focus.units);
        if(txt)return {text:txt,from:focus.id,kind:'pronounPlace'};
      }
    }
    // ④ 地点继承：「骑兵队也过去」——点了名、带省略标记、句中没有别的地点
    {
      const spans=cmdFindSpans(t0,unitWords());
      const noPlace=landmarkCandidates(t0).ids.length===0;
      const ellMark=/(也|再|同样|还)/.test(t0);
      // 113+：**「跟着」也算走**。原来只认 MOVE 词表里两字以上的词，
      //   「骑兵队也跟着去」「所有枪兵也跟着」都被 FOLLOW 抢走，回一句"护卫得说两头"——
      //   玩家说的是"他们也去那儿"，根本没提护卫。
      //   闸：必须同时有承接标记（也/同样/一起/都）和**不是"跟着我"**（那是真护卫）。
      //   ⚠ 判"跟着我"要看**宾语**，不能看句中有没有"主将"两个字：
      //     「所有枪兵」展开后会变成"…、主将队"（85：枪兵含主将队），
      //     第一版用 /主将/ 当闸，于是「所有枪兵也跟着」被自己的展开结果拦掉了。
      const followish=ellMark&&/(跟着|跟上)/.test(t0)&&!/跟(着|上)?(我|我们|咱们)/.test(t0);
      const moveish=actionWords('MOVE').some(w=>w.length>=2&&t0.indexOf(w)>=0)||followish;
      if(spans.length&&ellMark&&noPlace&&moveish){
        const place=ellPlace(focus.dest);
        if(place){
          const k=focus.kind==='DEFEND'?'DEFEND':'MOVE';
          const ids=spans.map(s=>s.id).filter(id=>id!=='ALL');
          const txt=ellRender(focus,k,ids.length?ids:focus.units);
          if(txt)return {text:txt,from:focus.id,kind:'place'};
        }
      }
    }
    // ⑦ 承接换主语（113+）：「弓兵队继续」「所有枪兵也一样」——
    //   主语是新的（玩家点了名），动作与宾语沿用上一条。
    //   与 ①（整句只有"继续"）的分工：那条连主语一起沿用，这条只换主语、不换事。
    //   四道闸：① 点了名；② 句中没有地点（有地点就是一条新命令）；
    //   ③ 没有自己的动作词（有动作词的走 ④）；④ 上一条真有宾语可接。
    if(focus&&focus.dest){
      const spans=cmdFindSpans(t0,unitWords());
      const noPlace=landmarkCandidates(t0).ids.length===0;
      const contMark=/(继续|接着|一样|同样|照样|照旧|照原样)/.test(t0);
      const ownAct=hasActionWord(t0);
      if(spans.length&&noPlace&&contMark&&!ownAct){
        const place=ellPlace(focus.dest);
        const k=focus.kind==='DEFEND'?'DEFEND':(focus.kind==='CAPTURE'?'CAPTURE':'MOVE');
        const ids=spans.map(s=>s.id).filter(id=>id!=='ALL');
        const txt=place?ellRender(focus,k,ids.length?ids:focus.units):null;
        if(txt)return {text:txt,from:focus.id,kind:'cont-subj'};
      }
    }
    // ⑥ 承接「占下来」（113+）：「占下来/拿下来/夺下来」里的"下来"指的是**上一条说的那一处**，
    //   不是地图中央那个据点。不接住的话，c 层会给 CAPTURE 补默认目标 OBJ——
    //   玩家说的是刚打到的这块地，兵却跑向中央：这是"猜了宾语且猜错"，比追问坏得多。
    //   闸：只认占领义的复合词（「打下来」是攻击，不收）；上一条必须真有一个地点。
    if(focus&&focus.dest&&/(占下来|占下|拿下来|拿下|夺下来|夺下|控制下来)/.test(t0)){
      if(ellFinal(focus.phase))return {refuse:ellDoneMsg(focus)};
      const place=ellPlace(focus.dest);
      const verb=ELL_VERB.CAPTURE;
      if(place&&verb)return {text:`${ellUnits(focus.units)}${verb}${place}`,from:focus.id,kind:'down'};
    }
    // ⑤ 零形式：「再往东」「往北」——整句只有方位（+可选"再/推进"）
    {
      const m=/^(再|又)?(往|向|朝)?(东|西|南|北|前|后|左|右)(边|面)?(推进|前进|进|走|去)?$/.exec(bare);
      // 两道闸（契约 §3.5）：有活任务（前面已判）、整句没有别的实体（正则已保证）
      if(m){
        const txt=ellRender(focus,'MOVE',focus.units,m[3]);
        if(txt)return {text:txt,from:focus.id,kind:'zero'};
      }
    }
    return null;
  }

  // ══ 成句性闸（clauseGate，115）══════════════════════════════════════════
  // 起因（上司 2026-11-24）：「『他们在那儿射』不是一个孤立事件——你首先要判断这句话是不是
  //   一个正常的表达，如果是，才进入语义分析；如果不是就应该立刻反馈不理解。」
  //   ⇒ 判据不能是"又发现一句补一句"，必须是一条能回答"什么话算一条命令"的规则。
  //
  // **判据是配价，不是黑名单。** 每个动作都有它必须被回答的那一问：
  //   打 → 打谁；占 → 占哪儿；去 → 去哪儿。这一问答不出来、又无法从上一条继承，
  //   这句话就**没有成立**（不是"解析失败"，是"你没说清楚"），回听不懂并指出缺哪一问。
  //   拿默认值顶上等于替他补宾语——这正是「在那儿射」被读成 DEFEND/ATTACK 的根子。
  //
  // 与既有默认值的分界（**这两条保留，别顺手改成追问**）：
  //   · 73「驻守/守住」缺地点＝脚下：'驻守'这个词本身蕴含就地，不是缺件；
  //   · 62「冲锋」＝打眼前那支：战斗口令蕴含"朝眼前的敌人"，同上。
  //   · 91「占领」缺地点＝中央据点：**按上司本轮口径收回**——"占"说不出占哪儿就不成立。
  //
  // 补件的顺序也是判据的一部分：**先查 CTX 继承，再追问**。
  //   91 的经验：能继承却去问，是把玩家上一句说过的话再问一遍；不能继承却默认，是替他编。
  // **表里只有一行，这是量出来的，不是漏了。** ATTACK 的"打谁"不进这张表：
  //   62 已经把"喊一声就往上冲"定成产品规则——「冲／杀／上／全线进攻／给我打」这些
  //   **战斗喊话**的宾语就是"眼前的敌人"，反过来问"打哪个"是把玩家的话退回给他。
  //   实测（115）：把 ATTACK 也塞进这张表，`全线进攻／给我打／放箭／齐射／扫荡／打过去`
  //   七句全部从"打眼前那支"变成"请点名"，那是**拿新规则推翻了 62**，不是修缺件。
  //   所以 ATTACK 只做"先继承、继承不到交给 c 层原有处置"（点名下令追问目标、喊话打眼前）；
  //   而「在那儿射」这种"地点状语＋及物动词"由省略还原层拒（见 ② 指示 分支）——
  //   那一层才知道"在那儿"是状语还是宾语，c 层看不到这个区别。
  const VALENCE={
    CAPTURE:{need:'place',
      ask:()=>'这句我听不懂——只说了要占、没说占哪儿。可以说「占领中央据点」，或者「全军去西侧营地，到了就占下来」。'},
  };
  // 战斗口令（62）：整句就是一声喊，标的物由"眼前的敌人"给出，不算缺宾语。
  //   判据是**整句只剩这个口令**——「用箭射」多了"用箭"两个字就不是口令了（那是缺宾语）。
  const BATTLE_CRY=/^(全军|全体|所有人|各队|三军|众将|都|一起)?(冲|杀|上|冲啊|杀啊|冲呀|上啊|冲锋|全力冲|跟我上|冲阵|掩杀|冲杀|突击|压上|包抄|追击)$/;
  // 从 CTX 补一件：能补上就补，补不上返回 false（**不写默认值**）。
  //   只补"上一条真说过的那件事"：ATTACK 补目标、CAPTURE 补地点。
  //   **先看 focus，再往回翻**：`停止/戒备/常行` 这类动作本身没有宾语，
  //   它们不该把上下文里的宾语作废——「攻击敌弓兵队」→「全军停止」→「继续打」，
  //   玩家心里那支敌人一直是敌弓兵队（B19）。只看 focus 的话，中间插一句"停止"就把宾语丢了。
  //   往回翻最多到**最近一次带该宾语的同类任务**，不跨动作族：
  //   上一个任务是"去北桥"，不能拿那座桥去填"打谁"。
  //   已完成的任务不补（`ellFinal`）——那是另一件事的宾语，拿过来就是新的猜。
  //   另一条边界：**续令词才许穿过"被顶掉"的任务**。「攻击敌弓兵队」→「全军停止」会让那条
  //   ATTACK 变成 superseded（`dropTasks`），此时「继续打」说的正是它——玩家明说了"接着刚才那件"，
  //   所以续令词（继续/接着/照旧/恢复）允许从 superseded 里取；没有续令词就不许，
  //   否则「攻击」会莫名其妙接着十分钟前那支敌人打。
  const RESUME_RE=/(继续|接着|照旧|恢复|还打|还是打)/;
  function valveFromCtx(cmd,text){
    const view=ctxSnapshot();
    if(!view)return false;
    const resume=RESUME_RE.test(String(text||''));
    const want=cmd.action==='ATTACK'?'foe':(cmd.action==='CAPTURE'?'place':null);
    if(!want)return false;
    const hit=t=>{
      if(!t)return null;
      if(want==='foe')return (t.kind==='ATTACK'&&t.foe)?t.foe:null;
      return (t.kind==='CAPTURE'&&t.dest&&t.dest.type==='place'&&t.dest.id)?t.dest.id:null;
    };
    const f=view.focus;
    if(f&&!ellFinal(f.phase)){
      const v=hit(f);
      if(v){if(want==='foe')cmd.foeId=v;else cmd.locId=v;return true;}
    }
    if(!resume)return false;
    const ts=view.taskings||[];
    for(let i=ts.length-1;i>=0;i--){
      const t=ts[i];
      if(!t)continue;
      // 'done'/'lost' 是真的办完了/部队没了——拿它补就不是"接着"，是翻旧账
      if(t.phase==='done'||t.phase==='lost')continue;
      const v=hit(t);
      if(v){if(want==='foe')cmd.foeId=v;else cmd.locId=v;return true;}
      // 往回翻的闸：只穿过"没有宾语"的任务（停止/戒备/常行/报告），
      //   碰到一个**有自己宾语的**任务就停——那说明玩家已经换了目标，再往前翻就是旧账。
      if(t.dest&&t.dest.type==='place')break;
      if(t.foe)break;
    }
    return false;
  }
  // 返回 null ＝ 这句话成立；否则返回"该怎么追问"。只判**补足语**，
  //   主语缺省（62 画面内 / 选中那支）不在这道闸里——那是产品规则，不是句子残缺。
  function clauseGate(cmd,text){
    if(!cmd||!cmd.action)return null;          // 连动作都没有：由"要部队做什么"那条管
    if(cmd.ops&&cmd.ops.length)return null;    // 多步令自带完整两段
    const v=VALENCE[cmd.action];
    if(!v)return null;
    // ① 已经齐了
    if(v.need==='target'&&(cmd.foeId||cmd.dir||cmd.locId))return null;
    if(v.need==='place'&&(cmd.locId||cmd.dir||cmd.multiLocs))return null;
    // ② 战斗口令不算缺
    if(v.need==='target'&&BATTLE_CRY.test(String(text||'').replace(/[。！!？?，,]/g,'')))return null;
    // ③ 从上一条继承（"用箭射""继续打""占下来"都是这一条救回来的）
    if(valveFromCtx(cmd,text))return null;
    // ④ 真的缺 → 追问，不许执行
    return {need:v.need,question:v.ask()};
  }

  // 解析一条自然语言指令 → 结构化命令。这里只做"识别与消歧"，
  // 缺件主要由 c 层在执行前统一校验并追问；**例外是成句性**（115 `clauseGate`）——
  //   一句话缺的是"必需成分"（打谁/占哪儿）时，那不是"待补的槽"，而是这句话没成立，
  //   必须在 b 层就回"听不懂并说明缺哪一问"，否则 c 层只能用默认值替玩家补上。
  function parseCommand(raw,opt){
    // 115：`opt.chain` ＝"这是组合句里的一段"。**成句性判据要看整句**——
    //   「到了就占下来」的"占哪儿"在前一段里，单看这一段它永远缺地点。
    //   组合句的补件由 c 层 `parseChain` 的 inherit 负责（它才看得见前一段），
    //   所以这一段不判成句、也不从 CTX 抢宾词。单句调用（opt 缺省）照判。
    const chainSeg=!!(opt&&opt.chain);
    // 87：每句话只装配一次地图事实（见 mapCtx 的注释）。**必须在这里清**——
    //   这是解析的唯一入口，放在别处会漏掉直接调 parseCommand 的路径（测试与 c 层都在用）。
    mapReset();
    // 83：角色称呼归一（敌主将／对方主将／敌军主将／敌帅 → 实体名）必须在一切取实体之前，
    //   否则「敌主将」进不了 foeWords，「攻击敌主将」就只能追问"打哪一支"。
    //   放在 cmdNorm 之前：归一结果是汉字实体名，后面的同音字纠正对它无害。
    raw=normalizeRoles(raw||'');
    // 94：**玩家原话**（已归一／已纠同音错字，但**还没做省略还原**）。
    //   ops 是"玩家说出的动作词隐含两件事"，只能由原话判——省略句里玩家根本没说动词，
    //   `resolveEllipsis` 补出来的「驻守」不该长出 ops（84 契约：省略还原只补文本、不造结构）。
    //   94 实测：拿补全后的 text 兜底，A03/A06/B06 三句省略句会被误标，93 金标当场报 7 条红。
    //   走 cmdNorm 是为了让 92 的同音纠正生效（「住守」→「驻守」），它不碰省略还原。
    const spokenText=cmdNorm(raw);
    // 84：省略还原，**必须在这里**（契约 §3.4）。
    //   ① 在域外判定之前：省略句没有实体、没有动作词，domainEvidence 一定返回空，
    //     放后面等于永不执行；② 在动作识别之前：还原产物要重新走一遍同一个识别，不能绕过；
    //   ③ 在 normalizeRoles 之后：「追上他」的"他"要指向归一后的实体名，顺序反了就对不上。
    if(ctxReader){
      const ell=resolveEllipsis(raw,ctxSnapshot());
      if(ell&&ell.refuse)
        return {cmd:{action:null,unitIds:[],foeId:null,locId:null,unsupported:[],tactics:[]},
          clarification_required:true,missing:'ctx',assistantQuestion:ell.refuse};
      if(ell&&ell.text)raw=ell.text;
    }
    let text=cmdNorm(raw);
    // 开场白剥离：**保留主语词**。"各队注意，向北撤退"原来把"各队注意"整段删掉，
    //   主语跟着没了，等于玩家点了名却没人受命（61 改）。
    text=text.replace(/^(各队注意|末将领命|得令)+/,m=>/^各队/.test(m)?'各队':'');
    text=text.replace(/(众将|三军|全军)?听令/g,'$1');
    // 分句（按句读切）：句读在 cmdNorm 里被抹掉，但"命令在前、条件在后"这件事只能靠它认。
    const clauses=(raw||'').split(/[，,。；;、！!？?]/).map(s=>cmdNorm(s)).filter(Boolean);
    // 否定式与问句必须在动作扫描**之前**定性：
    //   否定决定动作（"别放箭"≠"放箭"），疑问决定这是不是在问（"北桥守住了吗"≠"守着北桥"）。
    //   两件都放在后面"按词表取最长"的逻辑里做，都会被词表本身顶掉。
    let neg=negationOf(text);
    // "别管桥了，全力打营地"：否定只落在一件被丢下的事上，**后面那句才是命令**。
    //   不做这一步的话，整句会被"别管"按成停止，玩家真正的命令（打营地）被吃掉。
    let dismissClause=false;
    if(neg&&neg.base==='管'&&clauses.length>1){
      const later=clauses.slice(1).find(c=>primaryActionIn(c));
      if(later){neg=null;dismissClause=true;}
    }
    // 91：否定式**只否定它所在的分句**。第一句是"别追"、第二句是"守住阵地"时，
    //   主令是第二句：玩家说的是"别追"（约束）＋"守住"（要做的），系统原来整条只剩一个 STOP，
    //   玩家说了要守，兵没守，也没人告诉他"守"没被执行。
    //   只认第二句是**站桩动作**（守/占/集结/戒备）的情形：
    //     · 这类动作本身就是"停在某处做某事"，正好替掉被否定的那个前冲动作（"别追"自然满足）
    //     · 「别放箭，冲上去」不走：两句都是打，主令取谁要看语境，不能替玩家挑打法
    //     · 「不要过河，守住北桥」**也不走**（2026-11-08 实测）：禁止过河是**模式开关**
    //       （RIVER_ON），不是"停止某个动作"，换成驻守就等于把这条约束丢了。
    //       宁可维持现状（禁止过河、守桥另说），也不新增一处静默丢弃——
    //       本轮的账是"别再悄悄换掉玩家的话"，不是"用一种丢弃换另一种丢弃"。
    if(!dismissClause&&neg&&clauses.length>1&&['STOP','DEFEND'].includes(neg.to)){
      const later=clauses.slice(1).find(c=>actionInClause(c));
      const la=later?actionInClause(later):null;
      if(la&&STANDING_ACTS.includes(la)){neg=null;dismissClause=true;}
    }
    const ask=!neg&&isQuestion(text);
    // "休要放走一个敌兵"：把"放走"短语摘出来记条件注记，否则句中的"走"会被误判成移动
    if(/(休要|不得|不许|不要)?放走/.test(text)){
      text=text.replace(/(休要|不得|不许|不要)?放走/g,'');
      var noEscape=true;
    }
    const cmd={action:null,unitIds:[],foeId:null,locId:null,unsupported:[],tactics:[]};
    // 域外：这句话里一个战场成分都没有 → 根本不进解析，直接交回 c 层按"不是命令"回应。
    //   **必须放在动作识别之前**：REPORT 词表里的"怎么样"会把"今天天气怎么样"接住，
    //   先识别动作再判域外，就会造出一条假的"报告战况"命令（这正是 58 要修的那个毛病）。
    const ev=domainEvidence(raw);
    if(!ev.length)return {cmd,clarification_required:false,offTopic:true,offTopicEvidence:ev};
    // 85：统称展开。位置有讲究——**在域外判定之后**（58 的判据看玩家原话，不许因为展开
    //   多出几个实体就把闲话判进战场），**在实体识别之前**（展开产物重新走同一套识别）。
    text=expandArms(text);
    // 「停战」这类必须**在动作扫描之前**截住：STOP 表里有单字"停"，"停战"会被它接住，
    //   于是玩家说"停战"、系统让部队站住。它不是"一句话里还夹着别的动作"那种情况
    //   （政治决定从不跟部队动作复合），所以不必等扫描完再判。
    if(/(停战|休战|和谈|议和)/.test(text))
      return {cmd,clarification_required:true,missing:null,notYet:true,
        assistantQuestion:'停战是政治上的决定，不是一支部队能执行的命令'};
    // 战术术语「只识别、不下令」：先不立项新动作，给明确注记，不静默吞掉（docs/tactical_terms.md 第 4 节）。
    //   70 起注记与 key 都由 TACTICS 表产出：注记给人看，key 给 c 层判"接不接得住"。
    for(const [k,re,say] of TACTICS){
      if(!re(text))continue;
      cmd.tactics.push({key:k,say});
      cmd.unsupported.push(say);
    }
    // 78：伏击不只是注记——它本身就是**压制**（伏着不主动接敌，挨打才还手）。
    //   不在这里写进 cmd.suppress，c 层只看到一句"伏击"，兵照样会迎上去。
    if(cmd.tactics.some(t=>t.key==='ambush'))cmd.suppress={engage:'none',why:'伏击'};
    // 分兵（"兵分两路过桥/分兵守两座桥"）：若句中出现类别词（桥/森林/高地），
    // 把该类别下全部地标记为 multiLocs——c 层把部队平分到各地标；不再当"未实现"注记
    if(/(兵分两路|兵分三路|分兵|两路|三路)/.test(text)){
      const cat=[[/桥|桥头/,'BR_'],[/森林|树林|林子/,'FOR_'],[/高地|山坡/,'HILL_']].find(([re])=>re.test(text));
      if(cat){
        const pool=REG.landmarks.filter(l=>l.id.indexOf(cat[1])===0);
        if(pool.length>=2)cmd.multiLocs=pool.map(l=>l.id);
      }
      if(!cmd.multiLocs)cmd.unsupported.push('分兵指令需要说明分到哪几处（如"分兵守两座桥"）');
    }
    // 「不要追击」不再走注记：61 起否定式能直接翻成"停止"，比一句"暂未实现"有用。
    // 「在前/左翼」与「生擒/活捉」已由上面的 TACTICS 表统一产出，这里不再重复检测
    //   —— 两处都写会在同一句里留下两条一模一样的注记。
    // 分句与组合句：**主令在第一个分句**。
    //   "顶住，等我过来"——逗号前是命令，逗号后是条件。句读在 cmdNorm 里被抹掉了，
    //   于是"过来"（MOVE）和"顶住"（DEFEND）一样长、取靠后的，主令整个反了（变成"向主将靠拢"）。
    //   所以先按标点取第一分句；第一分句没动作词时再按连接词切；都没有就整句扫。
    //   以"等/待"开头的不按连接词切（"等他们渡河到一半再打"是条件句，不是先后两步）。
    let scanText=text;
    if(dismissClause)scanText=clauses.slice(1).find(c=>primaryActionIn(c))||text;
    else if(clauses.length>1&&primaryActionIn(clauses[0]))scanText=clauses[0];
    else{
      const segs=/^(等|待)/.test(text)?null:splitSegments(text);
      if(segs&&primaryActionIn(segs[0]))scanText=segs[0];
    }
  // 91：定语从句判据在模块级（见 isModifierVerbIn 的定义）——不放这里：
  //   它是纯函数，不闭包 parseCommand 的任何局部量；放在函数体里还会把"函数体到哪结束"
  //   这类静态检查（mapread_test [12]）切错位置。
    let bestLen=0,bestPos=-1,bestWord='';
    const found=[];
    for(const [name,words] of TXT_ACTIONS)for(const w of words){
      // 同一个词可能出现两次（一次作定语、一次作谓语）——逐个位置试，取第一个非定语的
      let p=scanText.indexOf(w);
      while(p>=0&&isModifierVerbIn(scanText,p,w))p=scanText.indexOf(w,p+1);
      if(p<0)continue;
      found.push({action:name,w,p});
      if(w.length>bestLen||(w.length===bestLen&&p>bestPos)){cmd.action=name;bestLen=w.length;bestPos=p;bestWord=w;}
    }
    // 否定式 / 问句在这里定案，压过词表的最长匹配：
    //   "别放箭"词表给 ATTACK，"别"必须能把它翻成 STOP；"北桥守住了吗"词表给 DEFEND，
    //   疑问形态必须能把它翻成 REPORT。两者都是"玩家说的和系统做的不是一件事"的源头。
    if(neg)cmd.action=neg.to;
    else if(ask)cmd.action='REPORT';
    // "让全军过河""准许他们渡江"：这是**放行**，不是移动。单独的"过河"仍是移动。
    else if(/(让|准|允许|准许|同意|放开|放行)[^]{0,4}(过|渡)(河|江|桥)/.test(text)){cmd.action='RIVER_OFF';bestWord='过河';}
    // 趋向补语不是主令："绕过去打"的主令是"打"，"过去"只是方向补语。
    //   词表按"最长优先"取词，两字的"过去"会把一字的"打"顶掉——这是纯长度规则的副作用，
    //   所以只在这些补语身上改判：后面还有真正的动作词时，取后面那个。
    const MOTION_FILLER=['过去','过来','去','到','走','过','渡','接近','靠近','逼近'];
    if(cmd.action==='MOVE'&&MOTION_FILLER.includes(bestWord)){
      const later=found.filter(f=>f.p>bestPos&&['ATTACK','RETREAT','CAPTURE'].includes(f.action))
        .sort((a,b)=>a.p-b.p||b.w.length-a.w.length)[0];
      if(later){cmd.action=later.action;bestWord=later.w;bestPos=later.p;bestLen=later.w.length;}
    }
    // 句尾的停止词是"到位之后再做的事"，不是主令："撤退然后休整""撤退并按兵不动"。
    //   只在停止词**位于**另一个动作之后时才降级——"停止进攻"里的"停止"在最前面，不动它。
    if(cmd.action==='STOP'&&!neg){
      const alt=found.filter(f=>f.action!=='STOP'&&f.action!=='REPORT'
        &&['MOVE','RETREAT','ATTACK'].includes(f.action)&&f.w.length>1&&f.p<bestPos)
        .sort((a,b)=>b.w.length-a.w.length||a.p-b.p)[0];
      if(alt){cmd.action=alt.action;bestWord=alt.w;bestPos=alt.p;bestLen=alt.w.length;}
    }
    // 一句话里还有别的动作没被执行——必须说清楚，不能静默丢弃（真实日志#5）。
    //   组合句（主令取第一段）尤其要报：第一段之外那段不能悄悄消失。
    // 被主词包含的子词不算（"取消戒备"里的"取消"）；"去打X"里的"去"是从属动作；
    // 单字词（到/走/停…）常是别的词的一部分（"遇到"含"到"），注明只会添噪。
    // 否定句与问句不报：句里其他动词正是被否定/被问的那个对象（"停止进攻""打不打"）。
    const foundAll=scanText===text?found:[];
    if(scanText!==text)
      for(const [name,words] of TXT_ACTIONS)for(const w of words){
        let p=text.indexOf(w);
        while(p>=0&&isModifierVerbIn(text,p,w))p=text.indexOf(w,p+1);
        if(p>=0)foundAll.push({action:name,w,p});
      }
    // 91：方向状语不是"第二个任务"。「往后退两格」整句都执行了（RETREAT dir=后 dist=2），
    //   回执却同时通知玩家「未执行：往后」——"往后"是同一件事的状语。
    //   方向词进动作表只为兜住光杆说法（"往后"当一句整令），一旦句子里已有谓语它就是状语。
    const DIR_ADV=['往前','往后','往左','往右','向前','向后','向左','向右','朝前','朝后','朝左','朝右'];
    const leftover=(neg||ask)?[]:foundAll.filter(f=>f.action!==cmd.action&&f.action!=='REPORT'
      &&f.w.length>1
      &&!DIR_ADV.includes(f.w)
      &&!bestWord.includes(f.w)
      &&!(f.action==='MOVE'&&['去','到','走'].includes(f.w)&&cmd.action==='ATTACK'));
    if(leftover.length&&cmd.action)
      cmd.unsupported.push(`一次只执行一个主任务，未执行：「${[...new Set(leftover.map(f=>f.w))].join('、')}」请分开说`);
    // 句子里还夹着"没设计"的东西（"休整一下就再打"）：主令照执行，但要说清没做哪一半。
    //   这些词已经不在动作表里，leftover 抓不到它们——不说一句，玩家会以为"边打边休整"。
    if(cmd.action&&!(neg||ask)){
      const ny=notYetOf(text);
      if(ny&&cmd.unsupported.indexOf(ny)<0)cmd.unsupported.push(ny);
    }
    // 条件指令（"遇到敌人就攻击"）：78 起**能说成 when 的就不再算没实现**。
    //   判据反过来用——只有"条件结构认得出来、却换不成触发"时才是没设计。
    //   这一条必须与 extractCond 同一份判据，两处各写一遍就会漂：
    //   b 层认了、c 层仍把它当没实现拒掉，玩家会看到"你说的话我听懂了但不能做"，白问。
    if(noEscape||/(遇到|发现|看见)[^]*?(就|再|然后)?[^]*?(攻击|打|撤|报)/.test(text)||/(且战且退|半渡而击|佯攻|诈败)/.test(text)){
      const ec=extractCond(raw);
      if(!ec||!ec.ok){
        const say='条件指令（"遇到敌人就…"）暂未实现：部队停下会自动还击，但不会按条件主动行事';
        cmd.unsupported.push(say);
        cmd.tactics.push({key:'conditional',say});
      }
    }
    // 先圈敌军，再圈友军：友军匹配落在敌军 span 里、或紧挨着"敌"字的都剔除
    // 「他们的弓兵」「敌方骑兵」：没写"敌"字，但指的是敌军。这类短语原来被当成**我方**部队，
    //   "骑兵从左边绕过去打他们的弓兵"于是变成"骑兵+弓兵一起上"——主体和敌我全错。
    const foeOf=(()=>{
      const m=/(他们|敌方|敌军|敌人|对方|对面)的?(枪兵|弓兵|骑兵|步兵)/.exec(text);
      if(!m)return null;
      const type={枪兵:'INF',弓兵:'ARC',骑兵:'CAV',步兵:'INF'}[m[2]];
      return {id:'E_'+type,start:m.index,end:m.index+m[0].length,w:m[0]};
    })();
    const foeSpans=cmdFindSpans(text,foeWords());
    if(foeOf&&!foeSpans.some(f=>f.start<foeOf.end&&foeOf.start<f.end))foeSpans.push(foeOf);
    const friendSpans=cmdFindSpans(text,unitWords())
      .filter(s=>!foeSpans.some(f=>s.start<f.end&&f.start<s.end)&&text[s.start-1]!=='敌');
    // 「全军」把点到的部队都包含了（83）：主将现在也是可点名的实体，
    //   「所有部队向主将靠拢」会同时圈出 ALL 和主将那一支——留着就是同一批兵写两遍。
    //   这不是特判主将，规则是**一个集合和它的子集同时出现时取集合**。
    const rawUnitIds=[...new Set(friendSpans.map(s=>s.id))];
    const unitIds=rawUnitIds.includes('ALL')?['ALL']:rawUnitIds;
    const foeIds=[...new Set(foeSpans.map(s=>s.id))];
    const lmC=landmarkCandidates(text);
    const lmIds=lmC.ids;
    // 95① 替玩家挑了哪处高地，**必须明说理由**（91：不许静默改写）。
    //   `unsupported` 会被 c 层收进回执念出来，所以这里不用改 c 层的执行链路。
    if(lmC.sightWhy)(cmd.unsupported||(cmd.unsupported=[])).push(lmC.sightWhy);
    if(!lmIds.length&&lmC.via==='no-sight'){cmd.placeMissing=lmC.kind;cmd.placeSight=true;}
    // 地名找不到时**要说清是哪种找不到**（图上没这种地形 / 没有这种归属），
    //   否则 c 层只会笼统地问"要去哪"，玩家以为是自己没说清，反复换说法。
    if(!lmIds.length&&lmC.via==='missing')cmd.placeMissing=lmC.kind;
    if(!lmIds.length&&lmC.via==='no-owner'){cmd.placeMissing=lmC.kind;cmd.placeOwner=lmC.owner;}
    // 87：说了限定词、但图上没有那种地方（"林子里那处营地"而营地都不在林子里）。
    //   必须与"图上没有营地"分开说——前者是玩家的条件没命中，后者是地图上真没有。
    if(!lmIds.length&&lmC.via==='no-adj'){cmd.placeMissing=lmC.kind;cmd.placeAdj=lmC.adj;}
    // 问敌情（83）：「敌人在哪」「敌情如何」「对面还剩几支」以前一律答成"我军都待命、人齐气足"。
    //   能力一直是现成的（`SIM.enemyFogState()` 早就按迷雾过滤好），缺的只是一个入口。
    //   判据两条**同时**成立才接管：
    //     ① 句子里点了敌方（敌方实体，或"敌/对面/他们"这类指代）；
    //     ② 在问情况（在哪/几支/多少/伤亡/如何/报一下）。
    //   缺 ① 会把「我们的弓兵队在哪」接成敌情；缺 ② 会把「全军攻击敌人」接成问句。
    //   只在 action 为空或已经是 REPORT 时接管——句子里有真动作时，命令优先。
    // 95② 「敌人侧翼在哪」也命中 FOE_REF+FOE_ASK，但它问的是**方位推断**不是"报一下敌情"：
    //   让给下面的 flank 问答（按 ghost 点算方位、报年龄），否则 83 的问敌情会把它接走。
    //   **只让开方位问法**：「敌人侧翼有几支」「报一下敌人侧翼的情况」仍走 83 的敌情回报，
    //   「敌人在哪边」「敌人还剩几支」照旧走 83。判据与 mapAskOf 共用 flankAsk，不许两把尺子。
    if((!cmd.action||cmd.action==='REPORT')&&FOE_REF.test(text)&&FOE_ASK.test(text)&&!flankAsk(text)){
      cmd.action='REPORT';cmd.reportFoe=true;
    }
    // 战地问答（87）：地形 / 过河点 / 岸别 / 可达。**排在敌情之后**——问的是敌人就不该被
    //   "怎么过河"这类词抢走；也**排在真动作之前面**（只在没有动作或已是 REPORT 时接管），
    //   免得「全军从北桥过河」被读成一句关于过河点的提问。
    if(!neg&&!cmd.reportFoe&&(!cmd.action||cmd.action==='REPORT')){
      const ma=mapAskOf(text,lmC);
      if(ma&&ma.text){
        cmd.action='REPORT';cmd.mapAsk=ma.kind;cmd.mapAnswer=ma.text;
        // 95① 问答形态不是"替玩家挑了一处"，别把命令形态的理由念出来（答案里自带理由）。
        if(Array.isArray(cmd.unsupported))
          cmd.unsupported=cmd.unsupported.filter(x=>x.indexOf('按视野挑了')<0);
      }
    }
    // ── 锚点与"靠拢"分流（2026-10-28 ㊷）─────────────────────────────
    // 「全军向主将靠拢」原来执行不了：词表里根本没有"主将"这个实体，"主将"被当普通文本丢掉，
    //   locId 只能为 null，c 层只能追问地点。
    // 上司 2026-10-28 拍板按**持续跟随**（B 方案）实现，所以锚点一律归一成 FOLLOW：
    //   只有 FOLLOW 每帧都读目标的当前坐标；MOVE 是"下令那一刻定格"，正是被否掉的 A 方案。
    //   由此 c 层只有一条执行路径，不会出现"b 给了 MOVE + 锚点、c 层又去追问地点"的旧毛病。
    // 90：`bestPos` 是 **scanText** 里的下标，而 friendSpans / anchorSpans 的位置是相对 **text** 的。
    //   两者不同源时（上面为了"主令在第一分句"把 scanText 收窄成分句）拿它们互相比较就是错位。
    //   实测后果：「全军去南桥，过河之后攻击敌主将队」——"主将"在整句里的位置远大于 bestPos，
    //   于是被判成"动词之后的宾语"，MOVE 被升成 FOLLOW。玩家说"过去打"，兵变成了跟着敌人走。
    //   这里统一换算到 text 的坐标系；换算不出（scanText 不是 text 的子串）时按"动词在句末"处理，
    //   那是保守的一侧：after 为空，锚点只能靠介词（向/朝/往…）认出来。
    const verbPos=(scanText===text)?bestPos:(()=>{
      const off=text.indexOf(scanText);
      return off>=0?off+Math.max(0,bestPos):text.length;
    })();
    const after=friendSpans.filter(sp=>sp.start>verbPos);
    const before=friendSpans.filter(sp=>sp.end<=verbPos);
    // 83：锚点**只有在动词之后**才算"跟着谁"。以前只要句子里出现「主将」就升 FOLLOW，
    //   于是「主将去北桥」变成"五支向主将靠拢"——主将自己是主语，被当成了宾语。
    //   这是 61 修过的那一类错（"我带骑兵绕后"读成"全军向我靠拢"）的同款，
    //   只不过 61 只防了"我"，没防「主将」这个更需要防的词（83 起它是实体名，出现频率暴涨）。
    // 90：锚点必须是**我方**主将。落在敌方实体里的"主将"是敌人的队名（「敌主将队」），
    //   把它当锚点会让「全军去南桥，过河之后攻击敌主将队」变成"跟着敌主将走"——
    //   玩家说打，系统去跟。判据与 friendSpans 剔敌军同源：不出现在我方表里的不算数。
    const anchorSpans=cmdFindSpans(text,ANCHOR_ALIASES)
      .filter(sp=>!foeSpans.some(f=>sp.start<f.end&&f.start<sp.end)&&text[sp.start-1]!=='敌');
    // 判"主语还是宾语"看两条：① 在动词之后；② 前面紧跟着趋向介词（向/朝/往/对/跟/随…）。
    //   只判 ① 会把「全军向主将靠拢」判成主语——那个"主将"夹在"向"和"靠拢"中间，
    //   位置在动词之前，但它显然是宾语；判错就变成"没对象，往哪儿？"。
    const TOWARD=/(向|朝|往|对|跟|随|奔|投|冲)[着]?$/;
    const anchorIsObject=anchorSpans.some(sp=>sp.start>=verbPos
      ||TOWARD.test(text.slice(Math.max(0,sp.start-3),sp.start)));
    const anchorHit=anchorIsObject?'COMMANDER'
      :(SELF_RE.test(text)&&!SELF_SUBJECT.test(text)&&ANCHOR_ACTIONS.includes(cmd.action)?'COMMANDER':null);
    // ── 宾语决定动作（75）：同一批词换个宾语就是另一个动作 ──────────────
    // 位置很关键：必须在上面 after/before 之后（要知道宾语在动词哪一侧）、
    //   又在下面"DEFEND 没地点＝原地驻守"之前（改判成 ATTACK 之后就不该再塞 HERE）。
    if(cmd.action==='MOVE'&&SUPPORT_RE.test(text)){
      if(after.length)cmd.action='FOLLOW';                 // 支援某支友军＝跟着它，不是"去某处"
      else if(!lmIds.length&&!cmd.locId){cmd.action=null;cmd.missingObject='support';}
    }
    // 「拦住敌骑兵队」＝迎上去打，不是"守住原地"。开状态不该带 foe——
    //   上一版这里是 DEFEND+loc=原地+foe，三个槽里有两个互相矛盾。
    if(cmd.action==='DEFEND'&&BLOCK_RE.test(text)&&foeIds.length)cmd.action='ATTACK';
    // "靠拢/抱团/聚拢/收拢"挂在 RALLY 名下，本身只是"凑到一起"；**凑到谁身上**才决定它是集合还是跟随。
    //   有锚点、或动词后面点了名（"枪兵队向弓兵队靠拢"）→ 升为 FOLLOW；其余仍是原地集合
    //   （"抱团取暖""全军聚拢"这类没对象的说法还得是 RALLY，词表也就不用动，基线不变）。
    if(cmd.action==='RALLY'&&(anchorHit||after.length))cmd.action='FOLLOW';
    if(anchorHit&&['MOVE','RALLY'].includes(cmd.action))cmd.action='FOLLOW';
    // 91：召回令里没有地名，"回哪儿"就是"我这儿"。
    //   「把骑兵队调回来」原来落成一条缺地点的 MOVE，c 层只能问"要前往哪里"，
    //   还列了 19 处地名——19 个里没有一个是"我这儿"。这不是参数没给，是宾语本身指人。
    //   只认**召回义**的说法：光杆"回来/撤"是 RETREAT 的词，收进来会把撤退令改成跟随。
    const RECALL_RE=/(调回来|调回|叫回来|召回来|收回来|撤回我这儿|回到我身边|回我这儿|回我身边)/;
    if(cmd.action==='MOVE'&&RECALL_RE.test(text)&&!lmIds.length&&!cmd.locId&&!after.length){
      cmd.action='FOLLOW';cmd.followAnchor='COMMANDER';
    }
    if(cmd.action==='FOLLOW'){
      // FOLLOW 语义："骑兵队跟着枪兵队"——动词**后**的友军是被跟随者，**前**的是执行者
      if(anchorHit)cmd.followAnchor=anchorHit;
      else if(after.length)cmd.followId=after[0].id;
      // 85：「后队跟上」「跟着」「都快跟上」——"跟上"本身就指明"跟着我"，
      //   不该再被当成"谁护谁"的护卫令去追问。**只认整句式**（FOLLOW_SELF_RE），
      //   句中还有别的东西（"跟上时代"）就不动，交回原路径。
      else if(FOLLOW_SELF_RE.test(text))cmd.followAnchor='COMMANDER';
      if(before.length){const b=[...new Set(before.map(sp=>sp.id))];cmd.unitIds=b.includes('ALL')?['ALL']:b;}
      // 注意不能无条件回退 unitIds：after 里的被跟随者也在 unitIds 中，
      //   无脑回退会让"跟着枪兵队"变成"枪兵队跟着自己"。
      else if(anchorHit&&unitIds.length)cmd.unitIds=unitIds.includes('ALL')?['ALL']:unitIds;
    } else if(unitIds.length)cmd.unitIds=unitIds.includes('ALL')?['ALL']:unitIds;
    // 动作锁兵种：放箭/射只能是弓兵，句子里没点名就补 ARC（见 ARCHER_LOCK 的说明）。
    //   注意顺序：先标"射"类，再补弓兵，最后判群体词——"全军放箭"要点的是全军，不该被锁成弓兵。
    //   arrow 标记还有第二个用途：这类命令的**目标由射程决定**，玩家不需要点名，
    //   所以它缺 target 不算"该问没问"（判分与 c 层的追问都该看这个标记）。
    if(cmd.action==='ATTACK'&&ARCHER_LOCK.test(text))cmd.arrow=true;
    if(cmd.action==='ATTACK'&&!cmd.unitIds.length&&!GROUP_SUBJ.test(text)&&cmd.arrow){
      cmd.unitIds=['ARC'];
      // 62：这是**系统补的**，不是玩家点的名。c 层要靠这个标记分辨两件事：
      //   「弓兵队放箭」= 点了名，哪怕它在画面外也照样传令；
      //   「放箭」    = 没点名，只喊给画面里的弓兵听，画面里没有就白喊（见 c 层 commandScope）。
      // 没有这个标记，两种说法在 c 层长得一模一样，规则没法分开执行。
      cmd.subjectAuto=true;
    }
    // 只有群体词、没有点名 → 全体。"都别动""全都上去干"原来一个主体都不给，
    //   c 层只能落到"选中那支"，那是猜的（玩家可能一支部队都没选）。
    if(!cmd.unitIds.length&&GROUP_SUBJ.test(text)
      &&['ATTACK','DEFEND','MOVE','RETREAT','STOP','CAPTURE','RALLY'].includes(cmd.action))cmd.unitIds=['ALL'];
    if(foeIds.length===1)cmd.foeId=foeIds[0];
    if(lmIds.length===1)cmd.locId=lmIds[0];
    // DEFEND 是**状态**，它的宾语只能是自己的部队。「顶住敌骑兵队」里的敌军是"顶谁"，
    //   不是"去打它"：把 foeId 留着，c 层会当成攻击目标，兵就冲出去了——和"顶住"正好相反。
    //   所以挪进 guardAgainst（守的方向），slot 清空，并说清楚"按原地守执行，不追"。
    if(cmd.action==='DEFEND'&&cmd.foeId){
      cmd.guardAgainst=cmd.foeId;cmd.foeId=null;
      cmd.unsupported.push(`「守住、不追出去」按原地驻守执行：只在射程内还击${foeName(cmd.guardAgainst)}，不会追它`);
    }
    // 撤退目的地："全军撤到北桥"——RETREAT+地标＝撤到那里（c 层转 retreatTo）
    if(cmd.action==='RETREAT'&&lmIds.length===1)cmd.retreatTo=lmIds[0];
    // 91：**指代词不能静默变成"原地"**。「守住它」里的"它"谁都解不出来，
    //   于是 lmIds 空、placeMissing 也空（"它"根本不算地名），最后落到下面那条 DEFEND 兜底，
    //   玩家听到"驻守当前位置"——他说的是"它"，系统办的是"脚下"。这是换掉宾语，不是少一个槽。
    //   57 定的规矩是**指代不猜**：解不出就问，不替玩家挑一个地方。
    //   只认"宾语槽要地点、句里只有指代、一个实体都没解出"这一种情形：
    //     · 「原地/这里/此处/阵地/顶住」不是指代（isHerePhrase 认的那些是真·原地），不受影响
    //     · 「守住它旁边的桥」不走这条——地名解出来了，指代只是定语
    const PRONOUN_OBJ=/(它|它们|那个|那座|那条|那片|那儿|那边)/;
    const NEED_PLACE=['MOVE','DEFEND','CAPTURE','RALLY'];
    if(NEED_PLACE.includes(cmd.action)&&!lmIds.length&&!cmd.locId&&!cmd.placeMissing
       &&!isHerePhrase(text)){
      const m=PRONOUN_OBJ.exec(text);
      if(m)cmd.pronounMissing=m[1];
    }
    // "原地集合/站到一起"：位置就是部队自己，不用问地点
    if(!lmIds.length&&['MOVE','DEFEND','RALLY','CAPTURE'].includes(cmd.action)&&isHerePhrase(text))cmd.locId=HERE;
    // 113+：「回来/回撤/退回」——说了"回"、没说地名，指的就是**本方本营**。
    //   为什么补 HOME 而不是留着追问：这三个字在玩家嘴里只有一个意思（回自家后方），
    //   问一句"要回到哪里"等于把他说过的话再问一遍。卷子里的 A19「让他们都回来」、
    //   B14「回来吧」都卡在这里，而「回营」这条早就通——差别只在地标词表里有没有那个名词。
    //   四条闸：
    //     ① 一个地点都没认出来（说了"回北桥"就听他的，地标优先）；
    //     ② 动作是在走（MOVE / RETREAT）——「撤回归还」不是军令；
    //     ③ 不收「过来」：它常用来描述（"他们过来了吗"），收进来会把一句问话变成命令；
    //     ④ 不收「本营/后方/老家」这类**名词**：它们归地标词表，这里只认动作性的"回"。
    //   放在方向解析之前：「往后退」里的"后"是走一段，不是回营——它由下面的方向表接住；
    //   放在这条之前的话，"撤回后方"会先被认成 dir='后'。
    //   ⚠ `'HOME'` **不是新哨兵，是图上真有的地标 id**：`worldgen.js` 里写死
    //     `{id:'HOME', name:'我军本营', kind:'base'}`（敌军是 `HOME_E`），十种种子都验过。
    //     c 层 `RETREAT` 的 `arrive:'HOME'` 用的也是它——所以这里填它，`cmdValidate` 认得、
    //     d 层拿得到坐标。**别改成新造的常量**，那会让 `DANGLING_LOC` 把整句拒掉。
    if(!lmIds.length&&!cmd.locId&&!cmd.placeMissing
       &&(cmd.action==='MOVE'||cmd.action==='RETREAT')
       &&/(回来|回去|回撤|撤回|回营|回师|返回|退回来)/.test(text))cmd.locId='HOME';
    // 驻守没给地点＝就地驻守（73）。这不是"少了一个槽"，而是这句话本来就成立：
    //   「全军驻守」的意思是"守你们脚下这块地"，而「全军出发」没有地点根本不成话。
    //   这正是原则①的样子——谓语不因缺宾而改变，宾语缺省时取"当前阵地"。
    //   位置在 isHerePhrase 之后：说了"原地"就是原地，没说地点才是脚下。
    //   不给这条兜底，c 层就只回一句"要驻守哪里？"——玩家说了"守"，却被告知没说守哪儿。
    //   出现多个地标时（"全军守桥"）不进这里：那是真歧义，b 层照旧带编号追问。
    if(cmd.action==='DEFEND'&&!lmIds.length&&!cmd.locId&&!cmd.placeMissing&&!cmd.pronounMissing)cmd.locId=HERE;
    // 方向解析：MOVE=方向推进（"向东走/向前3格"），ATTACK=方向性攻击（"向北进攻"→朝北找敌军），
    //   RETREAT=往哪个方向退（"后退三格""往北边跑"）。
    // 三者都以"有明确实体（地标/敌军/原地）优先"为前提，方向只是缺实体时的回退语义
    const DIR_WORDS=['东北','东南','西北','西南','东','西','南','北','前','后','左','右'];
    const dirCapable=(cmd.action==='MOVE'||cmd.action==='ATTACK'||cmd.action==='RETREAT')&&!lmIds.length&&!cmd.locId&&!cmd.foeId;
    if(dirCapable){
      for(const d of DIR_WORDS){
        let p=text.indexOf(d);
        while(p>=0&&/[敌背身]/.test(text[p-1]||''))p=text.indexOf(d,p+1);
        if(p>=0){cmd.dir=d;break;}
      }
      const n=gridCount(text);
      if(n&&cmd.dir&&(cmd.action==='MOVE'||cmd.action==='RETREAT'))cmd.dist=Math.max(1,Math.min(40,n));
    }
    // 短令补全（"上/退/守/停"）：词表里没有单字动词（会误伤生活用语），
    //   但整句就是它时毫无歧义——"冲""上""杀"是玩家最常喊的三个字，不能只会回一句"要部队做什么"。
    if(!cmd.action){
      const sa=shortCmdAction(text);
      if(sa)cmd.action=sa;
    }
    // 只说了"某地 + 几格"（"北桥前面两格"）：没有动作词，但"到那儿前面两格"是唯一合理的读法
    if(!cmd.action&&lmIds.length===1&&gridCount(text)){
      cmd.action='MOVE';cmd.dist=Math.max(1,Math.min(40,gridCount(text)));
    }
    // 「支援/驰援」没给宾语：不是"没说清要做什么"，是"说了做什么、没说对谁做"。
    //   和"要部队做什么？"必须分开——前者补个宾语就行，后者要整句重说。
    if(!cmd.action&&cmd.missingObject==='support')
      return {cmd,clarification_required:true,missing:'target',
        assistantQuestion:'支援谁？说「支援骑兵队」是跟着那支走，说「支援北桥」是开到那儿去。'};
    // 「没设计」的词：也不是"没说清"，是**这件还没做**。以前它们被打包进最近的动作
    //   （扎营→驻守、列阵→叫援军、休整/停战→停止），玩家说了 A 得到 B 还没有提示。
    if(!cmd.action){
      const ny=notYetOf(text);
      if(ny)return {cmd,clarification_required:true,missing:null,notYet:true,assistantQuestion:ny};
    }
    // 歧义优先于缺件：一句话里出现两个地点/两个敌人，必须先问清，这是"不猜"原则
    if(!cmd.action)
      return {cmd,clarification_required:true,missing:null,
        assistantQuestion:'要部队做什么？可以说：移动 / 攻击 / 驻守 / 占领 / 集结 / 撤退 / 戒备 / 常行 / 停止 / 报告。'};
    if(lmIds.length>1&&LOC_ASK.includes(cmd.action)){
      // 分兵语境：多地标不是歧义而是"分配目标"（multiLocs 已在前面捕获）
      if(cmd.multiLocs&&cmd.multiLocs.length>=2)return {cmd,clarification_required:false};
      const labels=lmIds.map(id=>{const l=landmarkById(id);return l?l.name:id});
      // 画面里一处都没有时说清楚是哪种"没有"（83）：不是"你没说清"，是"你看的这块地上没有"。
      //   两种回执必须不同——同一种说法会让玩家换个词再试，越试越远。
      const q=lmC.highTie!=null
        ?`图上 ${labels.length} 处${KIND_CN[lmC.kind]||'地方'}一样高（${lmC.highTie} 层），要哪一处？`
        :lmC.outOfView
        ?`画面里没有${KIND_CN[lmC.kind]||'那处地方'}——图上共 ${labels.length} 处（${numbered(labels)}），要哪一处？`
        :`你提到多处（${numbered(labels)}），要去哪一处？`;
      return {cmd,clarification_required:true,missing:'location',
        assistantQuestion:q,
        options:lmIds.map((id,i)=>({id,label:labels[i]}))};
    }
    if(foeIds.length>1&&cmd.action==='ATTACK')
      return {cmd,clarification_required:true,missing:'target',
        assistantQuestion:`你提到了多支敌军（${foeIds.map(foeName).join('、')}），要攻击哪一支？`};
    // 自相矛盾的双动作（62）：**排在所有缺件追问之后**——缺件是"少一个槽"，
    //   矛盾是"这句话本身不成立"，玩家要先把它说成一句成立的话，才有槽可填。
    if(cmd.action&&!neg&&!ask){
      cmd.__bestWord=bestWord;cmd.__bestPos=bestPos;   // 只给 selfConflict 看，出这个名字就删
      const c=selfConflict(cmd,text);
      delete cmd.__bestWord;delete cmd.__bestPos;
      if(c){
        // 把前面那条"一次只执行一个主任务，未执行：「按兵不动」"撤掉：
        //   那条注记的含义是"我替你挑了一个主任务"，而矛盾恰恰是不许替他挑。
        cmd.unsupported=cmd.unsupported.filter(x=>!(x.indexOf('一次只执行一个主任务')===0&&x.indexOf(c.bWord)>=0));
        cmd.conflict=c.key;
        return {cmd,clarification_required:true,missing:null,conflict:c.key,
          assistantQuestion:`「${c.aWord}」和「${c.bWord}」是反的：${c.why}。这一句我只能挑一件做——你要${c.ask}？`};
      }
    }
    // ── 94：多步计划的**来源在 b 层**，不许 c 层拿 cmd 反猜 ─────────────────
    // 「驻守北桥」的真实形状是两件事：先到北桥，再驻守。以前 b 层只交出一条 DEFEND+loc，
    //   c 层 planOf 只能压成一步（c 层训练台 793 条挂 SHAPE_FLAT，其中 757 条可展开）。
    //   **不能让 c 层按 action+locId 猜**：「务必守住北桥」交出的 cmd 与「驻守北桥」一模一样，
    //   而它的规格是单步同义键——94 实测按 cmd 展开会误伤 36 条（SHAPE_OK→SHAPE_WRONG；
    //   改前探针在真实地图只量到 30 条，训练台 fixture 全量是 36 条）。
    //   所以由 b 层按**玩家原话**（spokenText）显式给出 ops，c 层只照着展开、不认中文。
    //   （初稿按 bestWord 判，但词表没收全「死守／攻打」这类词，会漏掉一族；实测见 EVAL §4「94 复跑」。）
    // 四条守卫缺一不可：
    //   ① 有真实地点（HERE 是"脚下"，不用走）② 没有敌军宾语（「攻击敌枪兵队」是一步）
    //   ③ 动作在这三类里（MOVE/RALLY/RETREAT 带地点本就是"走"，不是"走完再做"）
    //   ④ **玩家原话**（spokenText）里出现"先到某处、再做这件事"的语义族动词。
    //      「守住／稳住／待着」是**保持状态**、不隐含移动，所以「务必守住北桥」不标；
    //      「驻守／占领／拦住／攻击＋地点」才隐含"到位之后开始"。
    //      用原话而不是补全省略后的 text，也顺手覆盖了词表没收全的同义词
    //      （「死守」「攻打」在词表里只落到单字「守」「打」，但原话里说得清清楚楚）。
    //      **错字不进这张表**：「炷守」靠单字「守」认出 DEFEND，本轮不为凑数给它标 ops。
    const MULTI_STEP_RE=/(?:驻守|驻防|防守|坚守|守卫|据守|把守|死守|拦住|挡住|堵住|封锁|占领|夺取|拿下|夺下|抢占|攻占|占下来|占下|占住|占了|攻击|进攻|攻打|打过去|杀过去|杀出去|扫荡)/;
    if(cmd.locId&&cmd.locId!==HERE&&!cmd.foeId&&
       ['DEFEND','ATTACK','CAPTURE'].indexOf(cmd.action)>=0&&
       MULTI_STEP_RE.test(spokenText))
      cmd.ops=['MOVE',cmd.action];
    // ── 97：活捉的第二步（`ATTACK` ＋ `CAPTURE_ON`）──────────────────────
    // 94 在这里写过"不许造 CAPTURE_ON"——那时它确实不存在（能力表没有、d 层没实现），
    //   标上去就是 91 清掉的静默改写。**97 把它真做出来了**，所以这条从"不许"变成"必须"：
    //   规格（`eval/spec.js` capture.foe）要的两段式，现在两段都有落点。
    // 与上面 MOVE 那条同一个口径：**只认玩家原话**（spokenText，即 cmdNorm 后、省略还原前）。
    //   不用 `cmd.tactics` 判，因为那张表走的是补全省略之后的 text——省略句里补出来的
    //   「活捉」不是玩家说的词（84 契约：省略还原只补文本、不造结构）。
    // 守卫只有一条但缺不得：**必须真有敌军宾语**。「活捉」没点目标时该追问"活捉谁"，
    //   标上 ops 会让开关先被打开、再回头问目标，等于替玩家把状态改了。
    const CAPTURE_RE=/(?:生擒|活捉)/;
    if(cmd.action==='ATTACK'&&cmd.foeId&&CAPTURE_RE.test(spokenText))
      cmd.ops=['ATTACK','CAPTURE_ON'];
    // ── 98：全力冲锋的第二步（ATTACK ＋ RUSH_ON）──────────────────────
    // 与活捉同一个口径：**只认玩家原话**（spokenText，cmdNorm 后、省略还原前）。
    //   四个都列上是防御：将来有人绕过 cmdNorm 直调 parseCommand，也不至于整条落空。
    //   不要求 foeId：「全军全力冲」和既有「冲锋」一样是战斗口令，没点名时 c 层按画面筛。
    //   `!cmd.ops` 是守卫：同一句既说「活捉」又喊「全力冲」时活捉先标了，不许被覆盖
    //   （本轮不处理两种状态叠加，宁可只做一件，也不静默丢掉一件）。
    const RUSH_RE=/(?:全力冲|全速冲|死冲|不计代价地冲)/;
    if(cmd.action==='ATTACK'&&!cmd.ops&&RUSH_RE.test(spokenText))
      cmd.ops=['ATTACK','RUSH_ON'];
    // ── 101：加速行军（主令 ＋ FORCED_ON）──────────────────────────────
    // 两种句子都要接住，**都不能丢动作**：
    //   ① 「全军加速行军」＝只说档位、没说去向 → 主令就是 FORCED_ON（词表里直接认出）；
    //   ② 「全军加速行军去北桥」「全军全速前进」＝档位 ＋ 去向。这一种若只让词表按长度取胜，
    //      会得到"加速行军 ＋ 一个没被用上的地点"，玩家说的"去北桥"整段蒸发——
    //      所以这里把它还原成「主令 ＋ 第二段开档位」，两段同刻下达，走的第一步就按 1.2 倍算。
    //   注意「全速前进」原来被 98 专门注记为"不含冲、只是速度修饰"：那时没有速度档位可挂，
    //      现在有了——它就该挂到 FORCED_ON 上，而不是继续被当成一句普通的前进。
    //   守卫 `!cmd.ops`：同一句既说活捉又喊加速时，先标的那个算（不静默丢掉一件）。
    //   与冲锋不冲突：`RUSH_RE` 先跑，喊「全力冲」的那句到这里 ops 已经有值了。
    const FORCED_RE=/(?:加速行军|急行军|强行军|快速行军|加快行军|加速前进|加速开进|加速赶路|全速前进|快速前进)/;
    if(!cmd.ops&&FORCED_RE.test(spokenText)){
      if(cmd.action==='MOVE'||cmd.action==='ATTACK'){
        cmd.ops=[cmd.action,'FORCED_ON'];
      }else if(cmd.action==='FORCED_ON'&&(cmd.locId||cmd.dir||cmd.foeId)){
        // 词表按长度取胜把它读成了"档位"，可句子还带着去向：还原成"走过去 ＋ 开档位"
        const main=cmd.foeId?'ATTACK':'MOVE';
        cmd.action=main;
        cmd.ops=[main,'FORCED_ON'];
      }
    }
    // ── 115：成句性闸 ────────────────────────────────────────────────────
    // 放在**最后**：前面那些追问（多地标、多目标、双动作矛盾）都比"缺宾语"更具体，
    //   有更该说的话就先说那句话。到这里还没被拦下、却不满足配价的，才交给这道闸。
    // 只对 ATTACK 的目标、CAPTURE 的地点动手（`VALENCE` 表里两行）——
    //   其余动作的缺件由 c 层原有追问处理（MOVE/RALLY 问"要前往哪里"，带候选列表），
    //   在 b 层再造一套只会出现两种措辞问同一件事。
    // ATTACK 不在这张表里，但**继承要先做**：`VALENCE` 只管"缺了要不要追问"，
    //   而"上一条说过"对所有动作都一样该补（B10「用箭射」、B19「继续打」都靠这一步）。
    //   补完仍没有目标是 c 层的事（点名下令→追问；喊话→打眼前那支，62）。
    if(!chainSeg){
      if(cmd.action==='ATTACK'&&!cmd.foeId&&!cmd.dir&&!cmd.locId&&!(cmd.ops&&cmd.ops.length))
        valveFromCtx(cmd,text);
      const g=clauseGate(cmd,text);
      if(g)return {cmd,clarification_required:true,missing:g.need==='target'?'target':'location',
        assistantQuestion:g.question};
    }
    return {cmd,clarification_required:false};
  }

  // ── 自相矛盾的军令（62，上司给的例子：「全军撤退并按兵不动」）────────────────
  // 为什么不能"只执行主任务、把另一个记成注记"：那等于替玩家挑了方向，而这类句子里
  //   被丢掉的那一半往往是**阻止兵力被拉走**的那一半（按兵不动）。撤退一旦执行，
  //   部队会一路退到后方——猜错的代价是全队跑掉，所以只能问。
  // 判据只认**并列**：中间夹着"先/再/然后/就/等"就是先后两步（"撤到北桥原地待命""打完就待命"），
  //   那是正常的组合句，不算矛盾。所以这里对每个候选词都先算两词之间的那段夹空。
  const SEQ_BRIDGE=/(先|再|然后|接着|之后|以后|才|就|等|待|后)/;
  // "强静止"只收真在说"别动"的那几个：休整/待命/取消/停战**不算**——
  //   "撤下去休整""撤回本营待命"都是正常的命令，把它们判成矛盾就是新的误伤。
  const HARD_STOP=/(按兵不动|原地待命|原地不动|不许动|不准动|别动|站住|停住|停下|停止|别走)/;
  const CONFLICT_PAIRS=[
    ['RETREAT','ATTACK','一个是往后退、一个是往前打','撤退，还是打出去'],
    ['ATTACK','RETREAT','一个是往前打、一个是往后退','打出去，还是撤退'],
    ['STANCE_ON','STANCE_OFF','戒备和常行是相反的两种状态','转入戒备，还是解除戒备'],
    // 反向也要有：主令取词是"同长取靠后"，"全军戒备并转常行"里**常行**才是主令，
    //   只写正向那一对就漏判（实测就是这么漏的）。
    ['STANCE_OFF','STANCE_ON','常行和戒备是相反的两种状态','解除戒备，还是转入戒备'],
  ];
  function actionWords(action){
    const row=TXT_ACTIONS.find(r=>r[0]===action);
    return row?row[1]:[];
  }
  function firstHit(action,text,skipWord){
    let best=null;
    for(const w of actionWords(action)){
      if(skipWord&&(skipWord.includes(w)||w.includes(skipWord)))continue;
      const p=text.indexOf(w);
      if(p<0)continue;
      if(!best||w.length>best.w.length)best={w,p};
    }
    return best;
  }
  function selfConflict(cmd,text){
    const main={w:cmd.__bestWord||'',p:cmd.__bestPos==null?-1:cmd.__bestPos};
    // ① 撤退/进攻 + 强静止
    if(cmd.action==='RETREAT'||cmd.action==='ATTACK'){
      const m=HARD_STOP.exec(text);
      if(m){
        // 撤退有目的地（"撤到北桥原地待命"）就不是矛盾，是两步
        const hasDest=!!(cmd.locId||cmd.dir||cmd.retreatTo);
        if(!(cmd.action==='RETREAT'&&hasDest)){
          const bridge=main.p>=0?text.slice(Math.min(main.p+main.w.length,m.index),Math.max(main.p,m.index+m[0].length)):'';
          if(!SEQ_BRIDGE.test(bridge))
            return {key:'move_stop',aWord:main.w||CMD_VERBS[cmd.action],bWord:m[0],
              why:'一边要走、一边不许走',ask:main.w?`${main.w}，还是原地不动`:'走，还是原地不动'};
        }
      }
    }
    // ② 相反方向/相反状态（撤退↔进攻、戒备↔常行）：两句动作词各出现一次且并列
    for(const [a,b,why,ask] of CONFLICT_PAIRS){
      if(cmd.action!==a)continue;
      const other=firstHit(b,text,main.w);
      if(!other)continue;
      const lo=Math.min(main.p+main.w.length,other.p), hi=Math.max(main.p,other.p+other.w.length);
      const bridge=(lo>=0&&hi>=lo)?text.slice(lo,hi):'';
      if(SEQ_BRIDGE.test(bridge))continue;
      return {key:`${a}_${b}`,aWord:main.w||CMD_VERBS[a],bWord:other.w,why,ask};
    }
    return null;
  }

  // 追问应答的容错理解（编号 / 裸兵种 / 统称 / 原地）：
  // 返回 {ok,value} / {reAsk:{hits}} / null（听不懂）。aliveEnemyIds 由 c 层传入（b 层不读战场）。
  const TYPE_CHAR={枪:'INF',弓:'ARC',骑:'CAV'};
  function typeCharHit(t){for(const ch in TYPE_CHAR)if(t.indexOf(ch)>=0)return TYPE_CHAR[ch];return null;}
  function numberAnswer(t){
    const m=/^([1-9])$/.exec(t)||/^第?([1-9一二三])个?$/.exec(t);
    if(!m)return null;
    return +({'一':1,'二':2,'三':3}[m[1]]||m[1]);
  }
  function extractAnswer(raw,kind,aliveEnemyIds){
    const t=cmdNorm(raw);
    if(kind==='unit'){
      const foe=cmdFindSpans(t,foeWords());
      const spans=cmdFindSpans(t,unitWords()).filter(s=>!foe.some(f=>s.start<f.end&&f.start<s.end)&&t[s.start-1]!=='敌');
      if(spans.length)return {ok:true,value:[...new Set(spans.map(s=>s.id))]};
      const uid=typeCharHit(t);
      if(uid)return {ok:true,value:[uid]};
      return null;
    }
    if(kind==='location'){
      if(isHerePhrase(t))return {ok:true,value:HERE};
      const c=landmarkCandidates(t);
      if(c.ids.length===1)return {ok:true,value:c.ids[0]};
      if(c.ids.length>1){
        const hits=c.ids.map(id=>landmarkById(id)).filter(Boolean);
        return {reAsk:{hits}};
      }
      return null;
    }
    const spans=cmdFindSpans(t,foeWords());
    if(spans.length)return {ok:true,value:spans[0].id};
    const uid=typeCharHit(t);
    if(uid){
      const id='E_'+uid;
      if(aliveEnemyIds&&aliveEnemyIds.includes(id))return {ok:true,value:id};
    }
    return null;
  }

  // 语义兜底（semantic.js 注入；node 测试与 file:// 直开时不存在，规则解析独立成立）
  let semantic=null;
  function wireSemantic(layer){semantic=layer;}
  function semanticReady(){return !!(semantic&&semantic.ready());}
  function semanticMatch(text){return semantic?semantic.match(text):Promise.resolve(null);}
  // 语义兜底合并（纯函数，可单测）：规则层已识别的字段永远优先，语义候选只补缺。
  // 槽位按动作类型补：MOVE/DEFEND/RALLY/CAPTURE 只认地点，ATTACK 只认目标。
  function applySemantic(parsed, cand){
    const cmd = parsed.cmd;
    // 语义兜底是**第四个 action 产出点**（前三个：词表、短令表、否定式表）。
    //   semantic.js 的模板里可以写任何动作名，它是唯一一条能把表外动作塞进 cmd 的后门——
    //   规则层不认识的动作，兜底层却能给你补上，这比"认出个错动作"更糟。
    let dropped=null;
    if(cand.action && gCaps && !gCaps[cand.action]){
      dropped=cand.action;
      cmd.unsupported.push(`语义候选「${cand.action}」没有对应的执行方式，已忽略`);
      cand = Object.assign({},cand,{action:null});
    }
    if(!cmd.action && cand.action) cmd.action = cand.action;
    if(!cmd.unitIds.length && cand.unitIds && cand.unitIds.length) cmd.unitIds = cand.unitIds.slice();
    if(cmd.action === 'ATTACK' && !cmd.foeId && cand.foeId) cmd.foeId = cand.foeId;
    if(['MOVE','DEFEND','RALLY','CAPTURE'].includes(cmd.action) && !cmd.locId && cand.locId) cmd.locId = cand.locId;
    // 动作被丢掉时不能再写"按「X」理解"——那句话会让玩家以为令已经下了，实际只补了实体。
    cmd.unsupported.push(dropped
      ? `语义匹配 ${cand.score.toFixed(2)}：「${cand.template}」的动作没执行方式，只补了部队/地点`
      : `语义匹配 ${cand.score.toFixed(2)}：按「${cand.template}」理解`);
    return cmd;
  }

  globalThis.UNDERSTAND={
    // 解析与理解（纯逻辑，不依赖 wire，可注入任意注册表独立测试）
    // parse 走 guardOut：绑定了 c 层能力表之后，b 层不会交出 c 层不认识的 action。
    parse:(raw,opt)=>guardOut(parseCommand(raw,opt)),parseCommand:parseCommand,guard:guardOut,
    bindCaps:bindCaps,declaredActions:declaredActions,
    declaredTactics:declaredTactics,TACTICS:TACTICS,
    initRegistry:initRegistry,cmdNorm:cmdNorm,cmdFindSpans:cmdFindSpans,
    cmdCorrected:cmdCorrected,isQuestion:isQuestion,hasActionWord:hasActionWord,
    // 域外判定：c 层要在 isQuestion 之前先问一句"这到底是不是在讲战场"
    isOffTopic:isOffTopic,domainEvidence:domainEvidence,looksLikeCommand:looksLikeCommand,
    splitSegments:splitSegments,extractAnswer:extractAnswer,numberAnswer:numberAnswer,
    // 78：条件从句 → step.when。c 层用它把"先…等到…才…"拆成带触发的阶段；
    //   返回 null ＝ 这句没有条件结构（走原来的路），ok:false ＝ 认得出条件却换不成触发。
    parseCondition:extractCond,condOfCond:condOfCond,isSuppressClause:isSuppressClause,
    applySemantic:applySemantic,wireSemantic:wireSemantic,semanticReady:semanticReady,semanticMatch:semanticMatch,
    // 84：上下文（CTX）只读视图的注入口。与 initRegistry 同一个哲学：b 层不读战场，只读被注入的事实。
    //   **传函数不传快照** —— 任务列表每 tick 都在变（phase），快照会在下一句话时过期。
    wireCtx:wireCtx,resolveEllipsis:resolveEllipsis,
    // 86：BattleContext 通道。battleContext() 只给界面/测试读，**parse 不调用**（87 才消费）。
    wireBattleContext:wireBattleContext,battleContext:battleContext,
    battleCtxReady:()=>!!battleCtxReader,
    // 87：解析实际用到的那份地图事实（每句装配一次）。测试拿它和"答案里说的数"对账——
    //   这样断言验的是"b 层说的和地图一致"，不是"b 层和自己一致"。
    mapFacts:mapCtx,mapReset:mapReset,
    // 词表与注册表访问（c 层回显/测试用；registry 供同层 semantic.js 建语料）
    TXT_ACTIONS:TXT_ACTIONS,CMD_VERBS:CMD_VERBS,CORRECTIONS:CORRECTIONS,HERE:HERE,registry:registry,
    ANCHOR_ALIASES:ANCHOR_ALIASES,
    numbered:numbered,unitName:unitName,foeName:foeName,landmarkById:landmarkById,landmarkNames:landmarkNames
  };
})();
