#!/usr/bin/env python3
"""
scripts/cdp_client.py
---------------------
Shared lightweight CDP (Chrome DevTools Protocol) WebSocket client and helper utilities
for Gemini Exporter automation, staging, and scenario generation.
No external dependencies required (uses Python standard library only).
"""

import sys
import os
import json
import time
import socket
import base64
import struct
import urllib.request
import urllib.error

CDP_DEFAULT_PORT = 9222


class CDPConnection:
    def __init__(self, ws_url):
        self.ws_url = ws_url
        self.msg_id = 0
        host, port_path = ws_url.replace("ws://", "").split(":", 1)
        port, path = port_path.split("/", 1)
        self.sock = socket.create_connection((host, int(port)), timeout=30)

        # WebSocket Handshake
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        req = (
            f"GET /{path} HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            f"Upgrade: websocket\r\n"
            f"Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            f"Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(req.encode("ascii"))
        res = self.sock.recv(4096)
        if b"101 " not in res:
            raise RuntimeError(f"WebSocket 握手失败: {res.decode('utf-8', errors='ignore')}")

    def reconnect(self):
        try:
            self.sock.close()
        except Exception:
            pass
        host, port_path = self.ws_url.replace("ws://", "").split(":", 1)
        port, path = port_path.split("/", 1)
        self.sock = socket.create_connection((host, int(port)), timeout=30)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        req = (
            f"GET /{path} HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            f"Upgrade: websocket\r\n"
            f"Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            f"Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(req.encode("ascii"))
        res = self.sock.recv(4096)
        if b"101 " not in res:
            raise RuntimeError(f"WebSocket 握手失败: {res.decode('utf-8', errors='ignore')}")

    def call(self, method, params=None, timeout=30):
        self.msg_id += 1
        current_id = self.msg_id
        payload = json.dumps({"id": current_id, "method": method, "params": params or {}}).encode("utf-8")

        mask = os.urandom(4)
        length = len(payload)
        if length <= 125:
            header = bytes([0x81, 0x80 | length]) + mask
        elif length <= 65535:
            header = bytes([0x81, 0x80 | 126]) + struct.pack(">H", length) + mask
        else:
            header = bytes([0x81, 0x80 | 127]) + struct.pack(">Q", length) + mask

        masked_payload = bytes([b ^ mask[i % 4] for i, b in enumerate(payload)])

        for attempt in range(2):
            try:
                self.sock.sendall(header + masked_payload)

                start = time.time()
                while time.time() - start < timeout:
                    b1, b2 = self._recv_exact(2)
                    masked = (b2 & 0x80) != 0
                    payload_len = b2 & 0x7F
                    if payload_len == 126:
                        payload_len = struct.unpack(">H", self._recv_exact(2))[0]
                    elif payload_len == 127:
                        payload_len = struct.unpack(">Q", self._recv_exact(8))[0]

                    mask_key = self._recv_exact(4) if masked else b""
                    raw_data = self._recv_exact(payload_len)

                    if masked:
                        raw_data = bytes([b ^ mask_key[i % 4] for i, b in enumerate(raw_data)])

                    try:
                        data = json.loads(raw_data.decode("utf-8", errors="ignore"))
                        if data.get("id") == current_id:
                            return data
                    except Exception:
                        continue
                raise TimeoutError(f"CDP call {method} 超时 ({timeout}s)")
            except (ConnectionError, socket.error):
                if attempt == 0:
                    time.sleep(1.0)
                    try:
                        self.reconnect()
                    except Exception:
                        raise
                else:
                    raise

    def _recv_exact(self, num_bytes):
        chunks = []
        received = 0
        while received < num_bytes:
            chunk = self.sock.recv(num_bytes - received)
            if not chunk:
                raise ConnectionError("WebSocket 连接意外关闭")
            chunks.append(chunk)
            received += len(chunk)
        return b"".join(chunks)

    def eval(self, expr, await_promise=False, timeout=30):
        params = {"expression": expr, "returnByValue": True}
        if await_promise:
            params["awaitPromise"] = True
        res = self.call("Runtime.evaluate", params, timeout=timeout)
        result = res.get("result", {})
        if "exceptionDetails" in result:
            desc = result["exceptionDetails"].get("text") or result["exceptionDetails"].get("exception", {}).get("description")
            print(f"    ⚠️ JS 执行异常: {desc}")
        return result.get("result", {}).get("value")

    def close(self):
        try:
            self.sock.close()
        except Exception:
            pass


def get_tabs(port=CDP_DEFAULT_PORT):
    for endpoint in ["/json/list", "/json"]:
        try:
            url = f"http://127.0.0.1:{port}{endpoint}"
            req = urllib.request.Request(url)
            with urllib.request.urlopen(req, timeout=5) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception:
            continue
    return []


GOOGLE_INTERNAL_EXTS = {
    "admccjkmockfdflocgggjfgdacdodkdf",
    "fignfifoniblkonapihmkfakmlgkbkcf",
    "nkeimhogjdpnpccoofpliimaahmaaome",
    "nmmhkkegccagdldgiimedpiccmgmieda",
}


def get_extension_id(port=CDP_DEFAULT_PORT):
    tabs = get_tabs(port)
    # First look for service workers or pages belonging to Gemini Exporter
    for t in tabs:
        u = t.get("url", "")
        if u.startswith("chrome-extension://"):
            if "background/background.js" in u or "options.html" in u or "popup.html" in u:
                return u.split("/")[2]

    # Fallback: check chrome-extension tabs excluding internal google components
    for t in tabs:
        u = t.get("url", "")
        if u.startswith("chrome-extension://"):
            ext = u.split("/")[2]
            if ext not in GOOGLE_INTERNAL_EXTS:
                return ext

    for t in tabs:
        if "gemini.google.com" in t.get("url", ""):
            cdp = CDPConnection(t["webSocketDebuggerUrl"])
            try:
                eid = cdp.eval("typeof chrome !== 'undefined' && chrome.runtime ? chrome.runtime.id : null")
                if eid and eid not in GOOGLE_INTERNAL_EXTS:
                    return eid
            finally:
                cdp.close()

    return None


def ensure_extension_loaded(port=CDP_DEFAULT_PORT, repo_path=None):
    """
    确保工作区扩展已加载到 Chrome 中。若未加载，直接通过 Chrome Browser WebSocket
    调用 Extensions.loadUnpacked 原生静默挂载，杜绝一切系统文件弹窗。
    """
    eid = get_extension_id(port)
    if eid:
        return eid

    repo_path = os.path.abspath(repo_path or os.path.join(os.path.dirname(__file__), ".."))
    browser_ws = get_browser_ws_url(port)
    if browser_ws:
        cdp = None
        try:
            cdp = CDPConnection(browser_ws)
            res = cdp.call("Extensions.loadUnpacked", {"path": repo_path})
            loaded_id = res.get("result", {}).get("id")
            if loaded_id:
                return loaded_id
        except Exception:
            pass
        finally:
            if cdp:
                cdp.close()

    return get_extension_id(port)


def get_browser_ws_url(port=CDP_DEFAULT_PORT):
    for endpoint in ["/json/version"]:
        try:
            url = f"http://127.0.0.1:{port}{endpoint}"
            with urllib.request.urlopen(url, timeout=5) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                return data.get("webSocketDebuggerUrl")
        except Exception:
            continue
    return None
