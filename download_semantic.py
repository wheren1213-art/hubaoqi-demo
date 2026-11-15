#!/usr/bin/env python3
"""下载语义兜底层（semantic.js）需要的本地依赖。只在首次运行/换机器时联网一次。

补齐两处缺一即断的依赖：
  1. 句向量模型 bge-small-zh-v1.5（transformers.js 的 q8 量化版，约 24MB）
     → models/bge-small-zh-v1.5/{config.json, tokenizer.json, ...}
       models/bge-small-zh-v1.5/onnx/model_quantized.onnx
  2. onnxruntime-web 的 wasm 运行时（onnxruntime-web@1.22.0，与 vendor/transformers.min.js 3.8.1 内联胶水的 ABI 匹配）
     → vendor/ort-wasm-simd-threaded.jsep.mjs   （按 transformers.min.js 所在目录解析）
       ort-wasm-simd-threaded.jsep.wasm        （按 env.backends.onnx.wasm.wasmPaths='./' 相对页面根解析）
     两处都放副本，缺一即断。

用法（在本目录执行）：
    python download_semantic.py            # 缺什么补什么
    python download_semantic.py --mirror   # 走 hf-mirror.com（国内网络）
    python download_semantic.py --force    # 重新下载全部
    python download_semantic.py --check    # 只检查，不下载

下载完用本地 http 服务打开 demo 才生效（file:// 直开时 ES 模块不加载，本层静默缺席，demo 照常玩）：
    python -m http.server 8000    → http://localhost:8000/
"""
import argparse
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent          # cold_age_demo/
MODEL_DIR = ROOT / "models" / "bge-small-zh-v1.5"
VENDOR_DIR = ROOT / "vendor"

MODEL_REPO = "Xenova/bge-small-zh-v1.5"
HF_HOSTS = ["https://huggingface.co", "https://hf-mirror.com"]
# 必须与 vendor/transformers.min.js 内联的 ort 胶水 ABI 一致，否则报
# "_OrtGetInputOutputMetadata is not a function" / "getValue is not a function"。
# 实测（2026-10-27，transformers.js 3.8.1）：1.22.0 与 1.23.0 可用，1.21.0 / 1.20.0 不可用。
ORT_VERSION = "1.22.0"
CDN_HOSTS = [
    "https://cdn.jsdelivr.net/npm",
    "https://unpkg.com",
]

# 模型仓库里需要的那几个文件（vocab.txt / 其它 onnx 变体不要）
MODEL_FILES = [
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "onnx/model_quantized.onnx",
]

# wasm 运行时：文件名 → 目标路径列表
WASM_FILES = {
    "ort-wasm-simd-threaded.jsep.mjs": [VENDOR_DIR / "ort-wasm-simd-threaded.jsep.mjs",
                                        ROOT / "ort-wasm-simd-threaded.jsep.mjs"],
    "ort-wasm-simd-threaded.jsep.wasm": [VENDOR_DIR / "ort-wasm-simd-threaded.jsep.wasm",
                                         ROOT / "ort-wasm-simd-threaded.jsep.wasm"],
}

UA = {"User-Agent": "Mozilla/5.0 (cold-age-demo setup)"}


def human(n):
    return f"{n / 1048576:.1f} MB" if n >= 1048576 else f"{n / 1024:.0f} KB"


def fetch(url, dest, force=False, retries=3):
    """下载到 dest；已存在且非空则跳过。返回 True=有文件可用。"""
    if dest.exists() and dest.stat().st_size > 0 and not force:
        print(f"  跳过（已存在 {human(dest.stat().st_size)}）  {dest.relative_to(ROOT)}")
        return True
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(url, headers=UA)
            t0 = time.time()
            with urllib.request.urlopen(req, timeout=60) as r, open(tmp, "wb") as f:
                total = int(r.headers.get("Content-Length") or 0)
                got = 0
                while True:
                    chunk = r.read(1 << 20)
                    if not chunk:
                        break
                    f.write(chunk)
                    got += len(chunk)
                    if total:
                        pct = got * 100 // total
                        sys.stdout.write(f"\r  下载 {pct:3d}%  {human(got)}/{human(total)}")
                        sys.stdout.flush()
            if total and tmp.stat().st_size != total:
                raise IOError(f"大小不符 {tmp.stat().st_size} != {total}")
            tmp.replace(dest)
            print(f"\r  完成 {human(dest.stat().st_size)}  {dest.relative_to(ROOT)}"
                  f"  ({time.time() - t0:.1f}s)")
            return True
        except Exception as e:                      # noqa: BLE001
            print(f"\r  第 {attempt} 次失败：{type(e).__name__}: {str(e)[:120]}")
            tmp.unlink(missing_ok=True)
            if attempt < retries:
                time.sleep(1.5 * attempt)
    return False


def try_hosts(path_tpl, hosts, dest, force):
    """按 hosts 顺序试，第一个成功即返回。"""
    for h in hosts:
        url = path_tpl(h)
        print(f"  ← {url}")
        if fetch(url, dest, force=force):
            return True
    return False


def check():
    ok = True
    print("模型：")
    for f in MODEL_FILES:
        p = MODEL_DIR / f
        good = p.exists() and p.stat().st_size > 0
        ok &= good
        print(f"  {'✓' if good else '✗'} {p.relative_to(ROOT)}"
              f"{'  ' + human(p.stat().st_size) if good else '  （缺失）'}")
    print("wasm 运行时：")
    for name, dests in WASM_FILES.items():
        for p in dests:
            good = p.exists() and p.stat().st_size > 0
            ok &= good
            print(f"  {'✓' if good else '✗'} {p.relative_to(ROOT)}"
                  f"{'  ' + human(p.stat().st_size) if good else '  （缺失）'}")
    print()
    print("结论：" + ("依赖齐全，语义兜底可用（需 http 打开）" if ok else "依赖不全，semantic.js 会静默缺席"))
    return ok


def main():
    ap = argparse.ArgumentParser(description="补齐 semantic.js 的本地依赖")
    ap.add_argument("--mirror", action="store_true", help="模型走 hf-mirror.com")
    ap.add_argument("--force", action="store_true", help="强制重新下载")
    ap.add_argument("--check", action="store_true", help="只检查不下载")
    args = ap.parse_args()

    if args.check:
        sys.exit(0 if check() else 1)

    hosts = HF_HOSTS[::-1] if args.mirror else HF_HOSTS
    failed = []

    print("=" * 60)
    print("1/2  句向量模型 bge-small-zh-v1.5（transformers.js q8 版）")
    print("=" * 60)
    for f in MODEL_FILES:
        dest = MODEL_DIR / f
        tpl = lambda h, f=f: f"{h}/{MODEL_REPO}/resolve/main/{f}"   # noqa: E731
        if not try_hosts(tpl, hosts, dest, args.force):
            failed.append(str(dest.relative_to(ROOT)))

    print()
    print("=" * 60)
    print(f"2/2  onnxruntime-web {ORT_VERSION} wasm 运行时（vendor/ 与页面根各一份）")
    print("=" * 60)
    for name, dests in WASM_FILES.items():
        # 先下到第一个目标，再复制到其余位置，避免重复下载
        first, rest = dests[0], dests[1:]
        tpl = lambda h, name=name: f"{h}/onnxruntime-web@{ORT_VERSION}/dist/{name}"   # noqa: E731
        if not try_hosts(tpl, CDN_HOSTS, first, args.force):
            failed.append(str(first.relative_to(ROOT)))
            continue
        for p in rest:
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(first.read_bytes())
            print(f"  复制到 {p.relative_to(ROOT)}  ({human(p.stat().st_size)})")

    print()
    if failed:
        print("以下文件未取到：")
        for f in failed:
            print("  -", f)
        print("可换 --mirror 重试，或手工放进对应目录。")
        sys.exit(1)

    check()
    print()
    print("下一步：在本目录起 http 服务后打开 demo（file:// 直开时本层不加载，demo 照常玩）")
    print("  python -m http.server 8000    → http://localhost:8000/")


if __name__ == "__main__":
    main()
