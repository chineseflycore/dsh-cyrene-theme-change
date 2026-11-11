#!/usr/bin/env python3
"""向本机（或 LAN 上另一台）DSH Web 发一条消息，并把它的回复取回来。

这是本次「远端 DSH 通道」踩通后固化的最小客户端：DSH 的 API 不是 REST，
而是 POST 到 `<channel>/<endpoint>` 的 JSON-RPC 信封，且 payload 必须包成
`{"args": {"request": {...}}}`（参数名取决于 endpoint 的形参名，
这里用到的 create/prompt/wait/cancel 都是 `request`）。

用法：
    ./remote-dsh.py "让它做的事"                     # 默认在 /mnt/Storage1_sda1/cyrene 里干
    ./remote-dsh.py "让它做的事" --cwd /some/dir
    ./remote-dsh.py "只读检查一下" --wait 120

环境变量：
    DSH_WEB      默认 http://127.0.0.1:3080（即代理；直连 3081 也行）
    DSH_USER     默认 dsh
    DSH_PASS     默认 114514

注意：它会**真的**驱动那台机器上的 agent 干活并消耗额度。
如果目标机器的沙箱后端不可用（缺 bubblewrap/Landlock），agent 会申请
一次性 danger-full-access 而卡在 `input-required`——那种审批只能在
Web UI 里点，本脚本接不了双向 approval 通道，只会如实报告 pendingInput。
"""
from __future__ import annotations

import argparse
import http.cookiejar
import json
import os
import sys
import urllib.error
import urllib.request
import uuid


def build_opener(base: str, user: str, password: str) -> urllib.request.OpenerDirector:
    jar = http.cookiejar.CookieJar()
    manager = urllib.request.HTTPPasswordMgrWithDefaultRealm()
    manager.add_password(None, base, user, password)
    return urllib.request.build_opener(
        urllib.request.HTTPBasicAuthHandler(manager),
        urllib.request.HTTPCookieProcessor(jar),
    )


def rpc(opener, base: str, method: str, request: dict) -> dict:
    body = json.dumps({
        "type": "client-request",
        "rpcId": f"rpc-{uuid.uuid4().hex[:8]}",
        "method": method,
        "payload": {"args": {"request": request}},
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{base}/api/{method}",
        data=body,
        headers={"content-type": "application/json"},
        method="POST",
    )
    with opener.open(req, timeout=180) as response:
        envelope = json.loads(response.read().decode("utf-8"))
    result = envelope.get("result", {})
    if not result.get("ok"):
        raise SystemExit(f"{method} 失败：{json.dumps(result.get('error'), ensure_ascii=False)}")
    return result.get("value")


def text_of(record: dict) -> str:
    event = record.get("event") or {}
    data = event.get("data") or {}
    blocks = (data.get("message") or {}).get("content") or []
    return "\n".join(
        block.get("text", "")
        for block in blocks
        if isinstance(block, dict) and block.get("type") == "text" and block.get("text")
    ).strip()


def main() -> int:
    parser = argparse.ArgumentParser(description="向 DSH 发一条消息并取回回复")
    parser.add_argument("prompt", help="要发给它的任务")
    parser.add_argument("--cwd", default="/mnt/Storage1_sda1/cyrene", help="会话工作目录")
    parser.add_argument("--wait", type=int, default=90, help="等待回复的秒数")
    parser.add_argument("--keep", action="store_true", help="保留会话（默认跑完就取消）")
    args = parser.parse_args()

    base = os.environ.get("DSH_WEB", "http://127.0.0.1:3080").rstrip("/")
    user = os.environ.get("DSH_USER", "dsh")
    password = os.environ.get("DSH_PASS", "114514")
    opener = build_opener(base, user, password)

    # 走一次代理的 bootstrap：Basic 通过后会换到 DSH 自己的会话 cookie。
    try:
        opener.open(urllib.request.Request(f"{base}/"), timeout=30).read()
    except urllib.error.HTTPError as error:
        if error.code not in (200, 303):
            raise SystemExit(f"登录失败：HTTP {error.code}")

    session = rpc(opener, base, "session/create", {"cwd": args.cwd})
    session_id = session["sessionId"]
    print(f"session={session_id}  cwd={args.cwd}", file=sys.stderr)

    rpc(opener, base, "session/prompt", {
        "requestId": f"req-{uuid.uuid4().hex[:12]}",
        "sessionId": session_id,
        "mode": "queue",
        "content": [{"type": "text", "text": args.prompt}],
        "clientTimeZone": "Asia/Shanghai",
    })

    value = rpc(opener, base, "session/wait", {
        "sessionId": session_id,
        "timeoutMs": max(1000, args.wait * 1000),
        "maxMessages": 5,
    })
    reason = value.get("reason")
    state = value.get("state") or {}
    if reason == "input-required":
        print(f"[需要人工批准] pendingInput={state.get('pendingInput')}", file=sys.stderr)
    elif reason == "timeout":
        print("[超时] 它还在跑，可以稍后再读", file=sys.stderr)

    for record in (value.get("output") or {}).get("records") or []:
        text = text_of(record)
        if text:
            print(text)

    if not args.keep:
        try:
            rpc(opener, base, "session/cancel", {"sessionId": session_id})
        except SystemExit:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
