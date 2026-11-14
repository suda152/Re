"""极简 CDP 客户端：直接连 Android WebView 的 page target。

Playwright 的 connect_over_cdp 走 browser 级 WS，会发 Browser.setDownloadBehavior，
安卓 WebView 不支持该命令，连不上。这里退到 page 级 WS，只发 Runtime.evaluate。
"""
import json
import urllib.request

import websocket


class CDP:
    def __init__(self, port=9222, timeout=30):
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=10) as r:
            targets = json.load(r)
        pages = [t for t in targets if t.get("type") == "page"]
        if not pages:
            raise RuntimeError(f"no page target, got {targets}")
        self.url = pages[0]["webSocketDebuggerUrl"]
        # Chrome 120+ 的 WebSocket 握手会校验 Origin，带 Origin 会 403；
        # 安卓 WebView 没有 --remote-allow-origins 可加，所以直接不发 Origin。
        self.ws = websocket.create_connection(self.url, timeout=timeout, suppress_origin=True)
        self._id = 0

    def cmd(self, method, **params):
        self._id += 1
        mid = self._id
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get("result")

    def eval(self, expr, await_promise=False):
        r = self.cmd(
            "Runtime.evaluate",
            expression=expr,
            returnByValue=True,
            awaitPromise=await_promise,
            userGesture=True,
        )
        if "exceptionDetails" in r:
            d = r["exceptionDetails"]
            desc = (d.get("exception") or {}).get("description") or d.get("text")
            raise RuntimeError(desc)
        return r["result"].get("value")

    def j(self, expr, await_promise=False):
        return json.dumps(self.eval(expr, await_promise), ensure_ascii=False, indent=1)

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass
