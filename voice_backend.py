#!/usr/bin/env python3
"""语音识别的**本地**后端（a 层的服务端）。识别全程在本机 CPU 完成，不联网。

这是一个独立进程，与 demo 页面之间只有一条 HTTP 契约：

    GET  /health              → {"ok":true,"engine":"sherpa-onnx","model":..,"audio_ms":..}
    POST /asr  body=WAV 字节   → {"text":"...","audio_ms":3230,"ms":1110,"rtf":0.34}
                                失败时 HTTP 503/400 + {"error":"..."}

**为什么单独一个进程**：a 层（语音）与 b/c/d 三层唯一的耦合点是"一段文本"。
把识别引擎关在自己的进程里，换引擎（sherpa / vosk / whisper）只需换这个文件，
页面上的 `voice.js` 一行都不用改；反过来，`voice.js` 也只认这条契约，不知道引擎是什么。

用法：
    python voice_backend.py                      # 127.0.0.1:8415
    python voice_backend.py --port 8415 --model <模型目录>
    python serve.py --voice                      # 静态服务 + 识别服务一起起（推荐）

模型（首次联网下载一次，之后全离线）：
    python ../sherpa_onnx_asr/download_model.py
"""
from __future__ import annotations

import argparse
import io
import json
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
DEFAULT_MODEL = REPO / "sherpa_onnx_asr" / "models" / "sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30"
SAMPLE_RATE = 16000          # 模型固定 16k 输入
MAX_BODY = 12 * 1024 * 1024  # 单次最多 12MB（16k×16bit 约 6 分钟），防误传大文件


# ── 引擎 ────────────────────────────────────────────────────────────────────
class AsrEngine:
    """sherpa-onnx 流式 Zipformer 中文模型的薄封装。

    只对外暴露 transcribe(wav_bytes)，返回 (text, audio_ms)——
    调用方（HTTP 层）不需要知道下面是 sherpa 还是别的东西。
    """

    def __init__(self, model_dir: Path, num_threads: int = 2):
        self.model_dir = Path(model_dir)
        self.num_threads = num_threads
        self._rec = None
        self._lock = threading.Lock()   # recognizer 共享，stream 每次新建
        self.ready = False
        self.error = None

    def load(self) -> None:
        import sherpa_onnx  # 延迟导入：没装也能给出可读报错，而不是起不来

        need = ["encoder.int8.onnx", "decoder.onnx", "joiner.int8.onnx", "tokens.txt"]
        missing = [n for n in need if not (self.model_dir / n).is_file()]
        if missing:
            raise FileNotFoundError(
                f"模型文件缺失：{', '.join(missing)}\n"
                f"模型目录：{self.model_dir}\n"
                f"先跑：python {REPO / 'sherpa_onnx_asr' / 'download_model.py'}"
            )
        d = self.model_dir
        self._rec = sherpa_onnx.OnlineRecognizer.from_transducer(
            tokens=str(d / "tokens.txt"),
            encoder=str(d / "encoder.int8.onnx"),
            decoder=str(d / "decoder.onnx"),
            joiner=str(d / "joiner.int8.onnx"),
            num_threads=self.num_threads,
            sample_rate=SAMPLE_RATE,
            feature_dim=80,
            decoding_method="greedy_search",
        )
        self.ready = True

    # -- 音频解码：任何采样率/声道/位深都收敛到 16k 单声道 float32 --
    @staticmethod
    def _decode_wav(data: bytes) -> "list[float]":
        import numpy as np

        with wave.open(io.BytesIO(data), "rb") as w:
            sr = w.getframerate()
            sw = w.getsampwidth()
            ch = w.getnchannels()
            raw = w.readframes(w.getnframes())

        if sw == 1:      # 8-bit 无符号
            a = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
        elif sw == 2:
            a = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        elif sw == 4:
            a = np.frombuffer(raw, dtype=np.int32).astype(np.float32) / 2147483648.0
        else:
            raise ValueError(f"不支持的位深：{sw * 8} bit")

        if ch > 1:
            a = a.reshape(-1, ch).mean(axis=1)
        if sr != SAMPLE_RATE:   # 线性插值足够：识别模型本身对轻微重采样不敏感
            n = int(round(len(a) * SAMPLE_RATE / sr))
            a = np.interp(np.linspace(0, 1, n, endpoint=False),
                          np.linspace(0, 1, len(a), endpoint=False), a)
        return a.astype(np.float32)

    def transcribe(self, wav_bytes: bytes) -> tuple[str, int]:
        import numpy as np

        if not self.ready:
            raise RuntimeError("引擎未就绪")
        samples = self._decode_wav(wav_bytes)
        audio_ms = int(len(samples) / SAMPLE_RATE * 1000)
        with self._lock:
            s = self._rec.create_stream()
            s.accept_waveform(SAMPLE_RATE, samples)
            # 尾部补 0.5 秒静音：流式模型的最后一个字要靠后续帧才能定稿
            s.accept_waveform(SAMPLE_RATE, np.zeros(SAMPLE_RATE // 2, dtype=np.float32))
            s.input_finished()
            while self._rec.is_ready(s):
                self._rec.decode_stream(s)
            text = self._rec.get_result(s)
        return (text or "").strip(), audio_ms


# ── HTTP 层 ─────────────────────────────────────────────────────────────────
def make_handler(engine: AsrEngine):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def _send(self, code: int, payload: bytes, ctype="application/json"):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            # 页面在 8000/8412，识别服务在 8415，属跨源；只监听 127.0.0.1，放开即可
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
            self.end_headers()
            self.wfile.write(payload)

        def _json(self, code: int, obj) -> None:
            self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"))

        def do_OPTIONS(self):          # audio/wav 触发预检，必须应答
            self._send(204, b"")

        def do_GET(self):
            if self.path.split("?")[0] == "/health":
                self._json(200, {
                    "ok": bool(engine.ready),
                    "engine": "sherpa-onnx",
                    "model": engine.model_dir.name,
                    "sample_rate": SAMPLE_RATE,
                    "error": engine.error,
                })
            else:
                self._json(404, {"error": "只有 /health 和 /asr"})

        def do_POST(self):
            if self.path.split("?")[0] != "/asr":
                self._json(404, {"error": "只有 /health 和 /asr"})
                return
            if not engine.ready:
                self._json(503, {"error": f"识别引擎未就绪：{engine.error or '正在加载'}"})
                return
            try:
                n = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                n = 0
            if n <= 0:
                self._json(400, {"error": "空请求体"})
                return
            if n > MAX_BODY:
                self._json(413, {"error": f"音频过大（{n} 字节）"})
                return

            body = self.rfile.read(n)
            t0 = time.perf_counter()
            try:
                text, audio_ms = engine.transcribe(body)
            except Exception as e:                      # 单次失败不能把服务带崩
                self._json(400, {"error": f"识别失败：{type(e).__name__}: {e}"})
                return
            ms = int((time.perf_counter() - t0) * 1000)
            self._json(200, {
                "text": text,
                "audio_ms": audio_ms,
                "ms": ms,
                "rtf": round(ms / audio_ms, 3) if audio_ms else None,
            })

        def log_message(self, fmt, *args):
            pass    # 识别是高频短请求，终端不刷屏

    return Handler


def serve(port: int = 8415, host: str = "127.0.0.1", model: Path = DEFAULT_MODEL,
          quiet: bool = False) -> ThreadingHTTPServer:
    """起识别服务（阻塞）。返回 server 对象供调用方管理生命周期。"""
    engine = AsrEngine(model)
    t0 = time.time()
    try:
        engine.load()
        if not quiet:
            print(f"[语音] 模型已加载（{time.time() - t0:.1f}s）：{model.name}")
    except Exception as e:
        engine.error = f"{type(e).__name__}: {e}"
        print(f"[语音] 引擎不可用：{engine.error}", file=sys.stderr)
        print("[语音] 服务照常起，/asr 会返回 503；页面上的语音按钮会提示不可用。", file=sys.stderr)

    httpd = ThreadingHTTPServer((host, port), make_handler(engine))
    if not quiet:
        print(f"[语音] 识别服务：http://{host}:{port}/asr  （本地推理，不联网）")
    return httpd


def main() -> None:
    ap = argparse.ArgumentParser(description="本地离线语音识别服务（给 cold_age_demo 的 a 层用）")
    ap.add_argument("--port", type=int, default=8415)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--model", default=str(DEFAULT_MODEL))
    args = ap.parse_args()

    httpd = serve(args.port, args.host, Path(args.model))
    print("Ctrl+C 停止")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
        httpd.server_close()


if __name__ == "__main__":
    main()
