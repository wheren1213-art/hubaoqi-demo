// voice.js — a 层：语音输入
//
// 职责边界（硬约束，改这个文件时不许破坏）：
//   本层只做一件事：麦克风录音 → 送本地识别服务 → 产出一段**原始文本**。
//   不引用 sim / understand / intent / enemy_commander 的任何东西，不认识部队、地标、命令动作；
//   产出的文本通过 onText 回调交给外部接线（main.js 里接 CMD.submit，与手动打字同一个入口）。
//   识别错了（同音字）也不许在本层纠正——那是 b 层的活（understand.js 的 CORRECTIONS）。
//
// 与后端的关系只有一条 HTTP 契约（见 voice_backend.py）：
//   POST {endpoint}/asr   body=WAV 16bit 单声道 → {text, audio_ms, ms}
//   换识别引擎只换后端，本文件不用改。
//
// 录音方式：getUserMedia + AudioContext + ScriptProcessorNode。
//   ScriptProcessorNode 已被标为废弃，但 AudioWorklet 需要额外一个模块文件与
//   addModule 异步加载，对这个 demo 是纯增复杂度；浏览器支持面已足够，先用它。
(() => {
  'use strict';

  const DEFAULTS = {
    endpoint: 'http://127.0.0.1:8415',
    mode: 'ptt',            // 'ptt' 按住说话（默认，最稳）| 'auto' 持续听、静音自动断句
    targetRate: 16000,      // 上行采样率；后端会重采样，所以拿不到 16k 也不影响
    bufferSize: 4096,
    rmsThreshold: 0.012,    // 能量阈值：低于它算静音
    silenceMs: 650,         // auto 模式：说完后静音多久算一句结束
    minSpeechMs: 280,       // 少于此长度当误触，不送识别
    maxUtteranceMs: 15000,  // 单句上限，防止一直说导致缓冲区无限增长
    trimMarginMs: 120,      // 前后各留一点余量，避免切掉字头字尾
    requestTimeoutMs: 20000,
  };

  // ── WAV 编码：Float32[-1,1] → 16bit PCM 单声道 ──────────────────────────
  function encodeWav(samples, rate) {
    const n = samples.length;
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
    v.setUint16(22, 1, true); v.setUint32(24, rate, true);
    v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, n * 2, true);
    let off = 44;
    for (let i = 0; i < n; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
    return buf;
  }

  function createVoiceLayer(env, options) {
    const opt = Object.assign({}, DEFAULTS, options || {});
    const listeners = { text: [], status: [] };
    let state = 'idle';       // idle|unsupported|arming|listening|recording|transcribing|error
    let lastError = null;
    let lastText = null;

    let ctx = null, node = null, source = null, micStream = null;
    let chunks = [], collecting = false, speechMs = 0, quietMs = 0, held = false, rate = opt.targetRate;

    const emit = (kind, payload) => {
      for (const fn of listeners[kind].slice()) {
        try { fn(payload); } catch (e) { /* 订阅方报错不影响录音 */ }
      }
    };
    function setState(s, detail) {
      state = s;
      emit('status', { state: s, detail: detail || null });
    }

    // 录音期间每帧回调里的样本；ptt 模式只受"按住"控制，auto 模式靠能量断句
    function onSamples(f32) {
      const frameMs = (f32.length / rate) * 1000;

      if (opt.mode === 'ptt') {
        if (!held) { collecting = false; return; }
        if (!collecting) { chunks = []; collecting = true; speechMs = 0; setState('recording'); }
        chunks.push(f32.slice());
        speechMs += frameMs;
        if (speechMs >= opt.maxUtteranceMs) finalize();
        return;
      }

      // auto 模式：能量判定
      let sum = 0;
      for (let i = 0; i < f32.length; i++) sum += f32[i] * f32[i];
      const rms = Math.sqrt(sum / Math.max(1, f32.length));

      if (rms >= opt.rmsThreshold) {
        if (!collecting) { chunks = []; collecting = true; speechMs = 0; quietMs = 0; setState('recording'); }
        speechMs += frameMs; quietMs = 0;
        chunks.push(f32.slice());
      } else if (collecting) {
        quietMs += frameMs;
        chunks.push(f32.slice());          // 静音也留着，容易切到字尾
        if (quietMs >= opt.silenceMs && speechMs >= opt.minSpeechMs) finalize();
        else if (speechMs + quietMs >= opt.maxUtteranceMs) finalize();
      }
    }

    // 按能量裁掉首尾静音（前后各留 trimMarginMs），缩短上行体积也少让模型偷懒
    function trim(samples) {
      const win = Math.max(64, Math.floor(rate * 0.02));
      const thr = opt.rmsThreshold * 0.8;
      const loud = i => {
        let s = 0;
        for (let k = i; k < Math.min(i + win, samples.length); k++) s += samples[k] * samples[k];
        return Math.sqrt(s / Math.max(1, Math.min(win, samples.length - i)));
      };
      let a = 0, b = samples.length;
      while (a < b && loud(a) < thr) a += win;
      while (b > a && loud(b - win) < thr) b -= win;
      if (b <= a) return samples;
      const margin = Math.floor(rate * opt.trimMarginMs / 1000);
      return samples.slice(Math.max(0, a - margin), Math.min(samples.length, b + margin));
    }

    function concat(list) {
      let n = 0;
      for (const c of list) n += c.length;
      const out = new Float32Array(n);
      let off = 0;
      for (const c of list) { out.set(c, off); off += c.length; }
      return out;
    }

    async function finalize() {
      if (!collecting) return;
      collecting = false;
      const raw = concat(chunks);
      chunks = [];
      const durationMs = (raw.length / rate) * 1000;
      if (durationMs < opt.minSpeechMs) {          // 误触，不打扰
        setState(opt.mode === 'ptt' ? 'listening' : 'listening');
        return;
      }
      await transcribe(trim(raw));
    }

    async function transcribe(samples) {
      setState('transcribing');
      const wav = encodeWav(samples, rate);
      const ctl = typeof env.AbortController === 'function' ? new env.AbortController() : null;
      const timer = ctl ? setTimeout(() => ctl.abort(), opt.requestTimeoutMs) : null;
      try {
        const res = await env.fetch(opt.endpoint.replace(/\/+$/, '') + '/asr', {
          method: 'POST',
          headers: { 'Content-Type': 'audio/wav' },
          body: wav,
          signal: ctl ? ctl.signal : undefined,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `识别服务返回 ${res.status}`);
        const text = String(data.text || '').trim();
        lastText = text;
        setState('listening', { ms: data.ms, audio_ms: data.audio_ms });
        if (text) emit('text', { text, raw: text, ms: data.ms, audioMs: data.audio_ms });
        else emit('text', { text: '', empty: true });   // 空识别也通知，便于界面提示"没听清"
      } catch (e) {
        lastError = { message: e && e.name === 'AbortError' ? '识别超时' : String(e && e.message || e) };
        setState('error', lastError);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    // ── 对外 API ──────────────────────────────────────────────────────────
    const api = {
      configure(patch) { Object.assign(opt, patch || {}); return { ...opt }; },
      options() { return { ...opt }; },
      isSupported() {
        return typeof env.getUserMedia === 'function' && typeof env.AudioContext === 'function';
      },
      status() { return state; },
      lastError() { return lastError; },
      lastText() { return lastText; },
      isRecording() { return collecting; },

      onText(fn) { listeners.text.push(fn); return () => { const i = listeners.text.indexOf(fn); if (i >= 0) listeners.text.splice(i, 1); }; },
      onStatus(fn) { listeners.status.push(fn); return () => { const i = listeners.status.indexOf(fn); if (i >= 0) listeners.status.splice(i, 1); }; },

      // 探测后端是否可用（不阻塞界面；失败只记状态，不影响打字下令）
      async checkBackend() {
        try {
          const res = await env.fetch(opt.endpoint.replace(/\/+$/, '') + '/health');
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.ok) throw new Error(data.error || `后端未就绪（${res.status}）`);
          return { ok: true, model: data.model };
        } catch (e) {
          const msg = String(e && e.message || e);
          lastError = { message: `识别服务不可用：${msg}` };
          return { ok: false, error: msg };
        }
      },

      async start() {
        if (!api.isSupported()) { setState('unsupported'); return false; }
        if (state === 'listening' || state === 'recording') return true;
        setState('arming');
        try {
          micStream = await env.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
          ctx = new env.AudioContext({ sampleRate: opt.targetRate });
          rate = ctx.sampleRate || opt.targetRate;   // 浏览器有权忽略 sampleRate，以后者为准
          source = ctx.createMediaStreamSource(micStream);
          node = ctx.createScriptProcessor(opt.bufferSize, 1, 1);
          node.onaudioprocess = ev => onSamples(ev.inputBuffer.getChannelData(0));
          source.connect(node);
          node.connect(ctx.destination);             // 某些浏览器不接 destination 不触发回调
          setState('listening');
          return true;
        } catch (e) {
          const denied = e && e.name === 'NotAllowedError';
          lastError = {
            message: denied
              // file:// 直开时浏览器不把页面当安全上下文，getUserMedia 会以"被拒绝"的形式失败，
              // 容易让人以为是自己点了拒绝——这里点明真实原因
              ? '麦克风权限被拒绝（若用 file:// 双击打开，浏览器不给麦克风，请改用本地 http 打开）'
              : String(e && e.message || e),
          };
          cleanup();
          setState('error', lastError);
          return false;
        }
      },

      stop() { cleanup(); setState('idle'); },

      // 按住说话：按下开始收，松开结束并送识别
      hold(on) {
        held = !!on;
        if (!held && collecting) finalize();
      },
    };

    function cleanup() {
      collecting = false; held = false; chunks = []; speechMs = 0; quietMs = 0;
      try { if (node) { node.onaudioprocess = null; node.disconnect(); } } catch (e) {}
      try { if (source) source.disconnect(); } catch (e) {}
      try { if (ctx && ctx.close) ctx.close(); } catch (e) {}
      try { if (micStream) micStream.getTracks().forEach(t => t.stop()); } catch (e) {}
      node = source = ctx = micStream = null;
    }

    return api;
  }

  globalThis.createVoiceLayer = createVoiceLayer;   // 供测试注入假环境

  // 浏览器里默认实例；node 测试不建（避免加载时就要 AudioContext）
  if (typeof window !== 'undefined' && typeof navigator !== 'undefined') {
    // file:// 下浏览器不提供 mediaDevices（非安全上下文），这里必须实探而不是传个函数了事，
    // 否则 isSupported() 会误报可用，按下去才失败。
    const md = navigator.mediaDevices;
    globalThis.VOICE = createVoiceLayer({
      getUserMedia: (md && typeof md.getUserMedia === 'function') ? (c => md.getUserMedia(c)) : undefined,
      AudioContext: window.AudioContext || window.webkitAudioContext,
      fetch: (...a) => fetch(...a),
      AbortController: typeof AbortController !== 'undefined' ? AbortController : undefined,
    });
  }
})();
