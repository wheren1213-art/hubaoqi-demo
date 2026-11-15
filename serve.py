#!/usr/bin/env python3
"""起本地静态服务跑 demo。语义兜底层（semantic.js）需要 http 打开才生效——
file:// 直开时 ES 模块不加载，demo 自动退回纯规则解析（照常可玩）。

要起这个服务的原因有两个，缺一不可：
  1. `semantic.js` 是 ES 模块（type="module"），file:// 下被浏览器拦掉；
  2. `.wasm` / `.mjs` 必须是正确 MIME，否则 onnxruntime 的 wasm 运行时加载失败。

用法：
    python serve.py                # 默认 127.0.0.1:8000，自动开浏览器
    python serve.py --port 8123
    python serve.py --no-open
    python serve.py --host 0.0.0.0  # 给同网段的平板/另一台机器看（注意：无鉴权）
    python serve.py --voice         # 同时起语音识别服务（a 层后端，默认 8415）
"""
import argparse
import functools
import http.server
import socket
import sys
import threading
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".wasm": "application/wasm",
        ".mjs": "text/javascript",
        ".js": "text/javascript",
        ".json": "application/json",
        ".onnx": "application/octet-stream",
    }

    def end_headers(self):
        # 模型/wasm 有 20MB+，改完重跑时不要吃缓存；同时也避免改了 js 看不到效果
        self.send_header("Cache-Control", "no-store, must-revalidate")
        # wasm 单线程模式不需要跨域隔离，这里不加 COOP/COEP，避免副作用
        super().end_headers()

    def log_message(self, fmt, *args):
        # 只报非 200，免得 20MB 模型的分块请求把终端刷满
        try:
            code = int(args[1])
        except Exception:
            code = 200
        if code >= 400:
            super().log_message(fmt, *args)


def main():
    ap = argparse.ArgumentParser(description="起本地服务跑 cold_age_demo")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--no-open", action="store_true", help="不自动开浏览器")
    ap.add_argument("--voice", action="store_true", help="同时起本地语音识别服务（a 层后端）")
    ap.add_argument("--voice-port", type=int, default=8415)
    args = ap.parse_args()

    for must in ["index.html", "semantic.js"]:
        if not (ROOT / must).exists():
            print(f"警告：{ROOT / must} 不存在，确认是在 cold_age_demo/ 目录下运行")
    if not (ROOT / "models" / "bge-small-zh-v1.5" / "onnx" / "model_quantized.onnx").exists():
        print("提示：语义模型未就位，本次只有纯规则解析。先跑 `python download_semantic.py`。")

    handler = functools.partial(Handler, directory=str(ROOT))
    try:
        httpd = http.server.ThreadingHTTPServer((args.host, args.port), handler)
    except OSError as e:
        print(f"端口 {args.port} 起不来：{e}")
        print(f"换一个：python serve.py --port {args.port + 1}")
        sys.exit(1)

    url = f"http://{'127.0.0.1' if args.host in ('0.0.0.0', '') else args.host}:{args.port}/"
    print(f"服务目录：{ROOT}")
    print(f"打开：{url}")
    print("Ctrl+C 停止")
    if not args.no_open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()

    # 语音后端：只是"顺手多起一个端口"，起不来不影响静态站与打字下令
    if args.voice:
        sys.path.insert(0, str(ROOT))
        try:
            import voice_backend
            vs = voice_backend.serve(args.voice_port, quiet=False)
            threading.Thread(target=vs.serve_forever, daemon=True).start()
            if args.voice_port != 8415:
                print(f"提示：页面默认连 8415，用 {url}?voice=http://127.0.0.1:{args.voice_port} 打开")
        except Exception as e:
            print(f"[语音] 起不来（{type(e).__name__}: {e}）；打字下令不受影响")

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
        httpd.server_close()


if __name__ == "__main__":
    main()
