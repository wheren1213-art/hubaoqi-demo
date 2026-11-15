// semantic.js — 本地语义匹配层（C 方案原型）：规则解析不了的说法，交给句向量最近邻兜底
//
// 定位与边界（与设计文档"模型不直接操纵游戏世界"一致）：
//   · 规则解析器仍是第一道，永远优先；本层只在"规则问'要做什么'或地点缺失"时出手；
//   · 本层只产出**候选**（动作 + 语料里出现过的真实实体 ID），实体校验/追问/执行仍走确定性层；
//   · 模型是判别式句向量（bge-small-zh-v1.5 量化版，约 24MB），不生成任何文本，全程本地推理；
//   · 语音接入后同一段逻辑直接复用——ASR 的同音错字正是"不精确说法"的最大来源。
//
// 层纯度（2026-10-27 收口，改动时不许破坏）：
//   · 实体表**只从 `UNDERSTAND.registry()` 取**，那是 c 层 `CMD.wire()` 从模拟层映射进来的注入表。
//     本文件**不许再出现 SIM 引用**——当初直读 `SIM.enemies` 是唯一一处 b→d 的越层依赖；
//   · 本文件**不调 UI/CMD**。要往界面说话就走装配层预置的 `SEMANTIC_NOTE(msg)` 钩子
//     （main.js 里把它接到 UI.echo），没人接就静默——b 层不该知道界面长什么样。
//   · `.workbuddy/parser_test.js` 第 [18] 节用正则守着这两条。
//
// 运行环境：transformers.js 是 ES 模块 + 需要按需取模型文件，file:// 直开加载不了本脚本——
// 那种情况下本层静默缺席，demo 自动退回纯规则解析（六套 node 测试就是这条路径）。
// 通过本地 http 服务（python3 -m http.server）打开时本层可用。
import {pipeline, env} from './vendor/transformers.min.js';

env.allowRemoteModels = false;          // 只用本地文件，绝不联网取模型
env.allowLocalModels = true;
env.localModelPath = './models/';
env.backends.onnx.wasm.wasmPaths = './';   // .mjs 按 transformers.min.js 所在目录(vendor/)解析、.wasm 按 wasmPaths 相对页面根解析——两处都要有副本，缺一即断
// 嵌入式 webview / 普通页面没有跨域隔离（无 SharedArrayBuffer），多线程 wasm 起不来——固定单线程
try{ env.backends.onnx.wasm.numThreads = 1; }catch(e){}

const THRESHOLD = 0.55;   // 余弦相似度阈值：低于它宁可追问也不猜

let embedder = null, corpus = [], readyFlag = false;

// 往界面说话的唯一通道：装配层（main.js）预置的钩子。没人接就静默——
// b 层不认识 UI，也就不会因为界面改了而连带改这里。
function note(msg){
  try{
    const fn = globalThis.SEMANTIC_NOTE;
    if(typeof fn === 'function') fn(msg);
  }catch(_){}
}

// 实体表的唯一来源：b 层自己的注册表（由 c 层 CMD.wire() 从模拟层映射注入）。
// 拿不到就退化成"只有意图模板、没有实体槽位"——宁可少认几个实体，也不越过 b 层去读 SIM。
function registryOf(){
  try{
    if(typeof UNDERSTAND !== 'undefined' && UNDERSTAND && typeof UNDERSTAND.registry === 'function') return UNDERSTAND.registry();
  }catch(_){}
  return {units:[],enemies:[],landmarks:[]};
}

// 语料：意图模板（不带槽位）+ 实体模板（带真实 ID）。实体来自上面那张注入表，
// 所以换地图/换部队时语料自动跟着重建，模型层不需要知道地图长什么样。
function buildCorpus(){
  const c = [];
  const add = (text, slots) => c.push(Object.assign({text}, slots));
  // 意图模板：只定动作，槽位交给规则层或追问
  const intents = {
    MOVE:      ['部队前进','出发','都动起来','向前进','行军','过去','马上出发','动身','走起来','跟上','快走','过江直捣','全军压上去','跟上部队'],
    ATTACK:    ['把敌人消灭掉','打他们','收拾他们','灭了他们','发起进攻','冲上去打','攻击敌人','全线进攻','掩杀过去','放箭','冲阵','开始攻击','给我打','杀过去','打过去','贴脸干','集火敌人','自由射击','我们上','冲啊','杀啊','全军冲杀','截杀敌军','杀出城来','杀出去','兄弟们跟我上','直杀出去','为了国王冲锋'],
    DEFEND:    ['守在这里','守住','原地防守','组织防御','守卫这里','坚守阵地','稳住战线','蹲坑','蹲好','守好这里','别让他们过来','顶住他们','守住阵地'],
    CAPTURE:   ['把据点占了','拿下据点','去抢点','占领目标'],
    RALLY:     ['集合','都集合','聚拢过来','到一起','靠拢'],
    RETREAT:   ['撤退','退回来','都撤回来','撤下来','鸣金收兵','收兵','跑路','溜了','快撤','快退','撤了撤了','先撤','拔寨退兵'],
    STANCE_ON: ['绷紧点','提高警惕','警戒起来','小心点','注意周围','警戒'],
    STANCE_OFF:['放松下来','别那么紧张','解除戒备','恢复常行'],
    STOP:      ['停下','都别动了','站住','全部停止','别动','停一下','先停下','等等','等一下'],
    REPORT:    ['汇报一下情况','现在什么情况','战况如何','报告情况','报个点','报点','啥情况','怎么样了','啥事'],
    RECON:     ['去探探路','侦察一下','派人侦察'],
    RIVER_ON:  ['别过河','不要渡河','禁止渡河'],
    RIVER_OFF: ['可以过河了','允许过河','解除限制'],
    FOLLOW:    ['跟着我','跟上']
  };
  for(const action in intents) for(const t of intents[action]) add(t, {action});
  // 实体模板：动宾组合（打 X / 去 Y / 占 Z），带真实 ID
  const reg = registryOf();
  for(const e of reg.enemies){
    add(`消灭${e.name}`, {action:'ATTACK', foeId:e.id});
    add(`先打${e.name}`, {action:'ATTACK', foeId:e.id});
    add(`收拾${e.name.replace('敌','')}`, {action:'ATTACK', foeId:e.id});
  }
  for(const l of reg.landmarks){
    add(`前往${l.name}`, {action:'MOVE', locId:l.id});
    add(`去${l.name}`, {action:'MOVE', locId:l.id});
    add(`到${l.name}去`, {action:'MOVE', locId:l.id});
  }
  add('占领中央据点', {action:'CAPTURE', locId:'OBJ'});
  add('夺取据点', {action:'CAPTURE', locId:'OBJ'});
  add('全军戒备', {action:'STANCE_ON', unitIds:['ALL']});
  add('全军停止', {action:'STOP', unitIds:['ALL']});
  add('全军撤退', {action:'RETREAT', unitIds:['ALL']});
  return c;
}

function cosine(a, b){
  let dot = 0, na = 0, nb = 0;
  for(let i = 0; i < a.length; i++){ dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

async function embed(text){
  const out = await embedder(text, {pooling:'cls', normalize:true});   // bge 用 CLS 池化 + 归一化
  return Array.from(out.data);
}

// 规则层的兜底入口：返回 {action, unitIds?, foeId?, locId?, template, score} 或 null（宁可追问也不猜）
async function match(text){
  if(!readyFlag) return null;
  // 空串/单字不兜底：空文本的句向量会与任意模板都算出中等相似度（实测空串→「等等」STOP 0.627），
  // 高于阈值就会把一个"什么都没说"的输入当成命令。规则层没听懂才轮到语义层，这种输入理应原样交回。
  const q = String(text == null ? '' : text).trim();
  if(q.length < 2) return null;
  const v = await embed(q);
  let best = null;
  for(const t of corpus){
    const s = cosine(v, t.vec);
    if(!best || s > best.score) best = {action:t.action, unitIds:t.unitIds, foeId:t.foeId, locId:t.locId, template:t.text, score:s};
  }
  return best && best.score >= THRESHOLD ? best : null;
}

(async function boot(){
  try{
    embedder = await pipeline('feature-extraction', 'bge-small-zh-v1.5', {dtype:'q8'});
    corpus = buildCorpus();
    const vecs = await embedder(corpus.map(t => t.text), {pooling:'cls', normalize:true});
    corpus.forEach((t, i) => { t.vec = Array.from(vecs[i].data); });
    readyFlag = true;
    UNDERSTAND.wireSemantic({ready: () => readyFlag, match});
    const reg = registryOf();
    note(`语义匹配已就绪：${corpus.length} 条说法（其中实体模板 ${reg.enemies.length * 3 + reg.landmarks.length * 3} 条），`
       + '本地 bge-small-zh（不精确的表达也能懂个大概；规则解析仍优先）。');
  }catch(e){
    // 加载失败（file:// 直开、文件缺失等）不算错误：demo 照常玩，只是没有这层兜底
    note(`语义匹配不可用（${String(e && e.message || e).slice(0, 200)}），继续按规则解析。`);
  }
})();
