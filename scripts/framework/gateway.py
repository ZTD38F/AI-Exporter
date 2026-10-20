# scripts/framework/gateway.py
"""
Safe Interaction Gateway for AI Chat Automation.
Provides:
1. URL Allowlist Validation — Prevents accidental navigations to unauthorized domains.
2. Rate Limiting & Cooldown Protection — Prevents hyperactive triggering and risk flags.
3. Central Audit Logging — Records all sensitive operations (navigate, send, delete) with timestamps and status.
4. Circuit Breaking & Fault Isolation — Protects ongoing browser state.
"""

import os
import json
import time
from urllib.parse import urlparse
from typing import List, Dict, Any, Optional, Callable


class SecurityViolationError(RuntimeError):
    """Raised when an automation action violates safety or domain policies."""
    pass


class CircuitBreakerError(SecurityViolationError):
    """Raised when an active security circuit breaker triggers (e.g. CAPTCHA, rate limit, abuse wall)."""
    pass


class SafeInteractionGateway:
    """
    中央安全网关：所有对 AI 聊天平台的敏感操作（导航、发帖、删除、模型切换）统一受此网关监管与审计。
    """

    DEFAULT_ALLOWED_HOSTS: List[str] = [
        "gemini.google.com",
        "accounts.google.com",
        "chrome.google.com"
    ]

    DEFAULT_ALLOWED_SCHEMES: List[str] = [
        "https",
        "chrome-extension",
        "chrome"
    ]

    def __init__(
        self,
        allowed_hosts: Optional[List[str]] = None,
        min_action_interval: float = 0.5,
        min_turn_interval: float = 3.0,
        min_delete_interval: float = 1.0,
        max_turns_per_run: int = 50,
        enable_strict_domain_check: bool = True
    ):
        self.allowed_hosts = set(allowed_hosts or self.DEFAULT_ALLOWED_HOSTS)
        self.allowed_schemes = set(self.DEFAULT_ALLOWED_SCHEMES)
        self.min_action_interval = min_action_interval
        self.min_turn_interval = min_turn_interval
        self.min_delete_interval = min_delete_interval
        self.max_turns_per_run = max_turns_per_run
        self.enable_strict_domain_check = enable_strict_domain_check
        self.audit_log: List[Dict[str, Any]] = []
        self._last_action_ts: float = 0.0
        self._last_turn_ts: float = 0.0
        self._last_delete_ts: float = 0.0
        self._turn_count: int = 0

    def validate_url(self, url: str) -> bool:
        """
        验证目标 URL 是否在合法白名单内。
        支持绝对 URL (https://gemini.google.com/...) 与 Chrome 扩展 URL (chrome-extension://...)。
        """
        if not url:
            return False

        try:
            parsed = urlparse(url)
        except Exception:
            return False

        # 允许扩展协议与 chrome 特殊页面
        if parsed.scheme in ("chrome-extension", "chrome"):
            return True

        if self.enable_strict_domain_check:
            if parsed.scheme not in self.allowed_schemes:
                return False
            hostname = (parsed.hostname or "").lower()
            if not any(hostname == h or hostname.endswith("." + h) for h in self.allowed_hosts):
                return False

        return True

    def enforce_cooldown(self, action_name: str, custom_cooldown: Optional[float] = None):
        """对高敏操作强制实行最小间隔控制，防止短时间高频请求"""
        interval = custom_cooldown if custom_cooldown is not None else self.min_action_interval
        if interval <= 0:
            return

        now = time.time()
        elapsed = now - self._last_action_ts
        if elapsed < interval:
            time.sleep(interval - elapsed)
        self._last_action_ts = time.time()

    def record_audit(
        self,
        action: str,
        target: str,
        status: str,
        duration: float = 0.0,
        details: Optional[Dict[str, Any]] = None,
        error: Optional[str] = None
    ) -> Dict[str, Any]:
        """记录一次敏感操作的审计记录"""
        entry = {
            "timestamp": time.time(),
            "time_iso": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime()),
            "action": action,
            "target": target,
            "status": status,
            "duration_ms": int(duration * 1000),
            "details": details or {},
            "error": error
        }
        self.audit_log.append(entry)
        return entry

    def safe_navigate(self, cdp: Any, url: str, timeout: float = 20.0) -> bool:
        """安全导航：先校验 URL 白名单，再记录审计并执行跳转"""
        t0 = time.time()
        if not self.validate_url(url):
            err_msg = f"安全网关拦截非法导航目标: '{url}' 不在白名单域名列表中"
            self.record_audit("NAVIGATE", url, "BLOCKED", time.time() - t0, error=err_msg)
            raise SecurityViolationError(err_msg)

        self.enforce_cooldown("NAVIGATE", custom_cooldown=0.3)

        try:
            cdp.call("Page.navigate", {"url": url})
            self.record_audit("NAVIGATE", url, "SUCCESS", time.time() - t0)
            return True
        except Exception as e:
            # 降级尝试 JS 跳转
            try:
                cdp.eval(f"window.location.href = '{url}'")
                self.record_audit("NAVIGATE_FALLBACK", url, "SUCCESS", time.time() - t0)
                return True
            except Exception as e2:
                err_msg = f"导航失败: {e}; 降级失败: {e2}"
                self.record_audit("NAVIGATE", url, "FAILED", time.time() - t0, error=err_msg)
                return False

    def check_circuit_breaker(self, cdp: Any) -> None:
        """检查当前宿主页面是否被 Google 验证码 (CAPTCHA) 或滥用风控墙拦截"""
        if not cdp:
            return
        try:
            status = cdp.eval("""
            (() => {
                const text = (document.body ? document.body.innerText || "" : "").toLowerCase();
                const hasCaptcha = text.includes("recaptcha") || text.includes("unusual traffic") || text.includes("verify it's you") || !!document.querySelector('iframe[src*="recaptcha"]');
                const hasAbuse = text.includes("account suspended") || text.includes("temporarily locked") || text.includes("violation of terms of service");
                return { hasCaptcha, hasAbuse };
            })()
            """)
            if status and (status.get("hasCaptcha") or status.get("hasAbuse")):
                reason = "检测到 Google 验证码 (CAPTCHA) 拦截" if status.get("hasCaptcha") else "检测到账号安全封控警告"
                err_msg = f"安全网关触发主动熔断停机 (CircuitBreaker): {reason}"
                self.record_audit("CIRCUIT_BREAKER", "PAGE_STATUS", "BLOCKED", error=err_msg)
                raise CircuitBreakerError(err_msg)
        except CircuitBreakerError:
            raise
        except Exception:
            pass

    def safe_send_turn(
        self,
        cdp: Any,
        send_fn: Callable[..., Any],
        prompt: Any,
        *args,
        custom_cooldown: Optional[float] = None,
        **kwargs
    ) -> Any:
        """
        高危发帖操作安全守门：
        1. 检查页面是否已触发 CAPTCHA / Abuse 拦截；
        2. 校验单次测试最大发帖轮次上限；
        3. 强制实施发帖安全冷却期 (防抖)；
        4. 执行发帖并记录审计与耗时；
        5. 检验返回值与错误，异常时触发熔断。
        """
        t0 = time.time()
        p_preview = (str(prompt)[:50] + "...") if len(str(prompt)) > 50 else str(prompt)

        # 1. 页面风控熔断检测
        self.check_circuit_breaker(cdp)

        # 2. 发帖轮次上限保护
        if self._turn_count >= self.max_turns_per_run:
            err_msg = f"单次测试累计发帖轮次达到安全上限 ({self.max_turns_per_run})，网关主动熔断停机以保护账号安全"
            self.record_audit("SEND_TURN", p_preview, "BLOCKED", error=err_msg)
            raise CircuitBreakerError(err_msg)

        # 3. 强制冷却防抖 (避免流式刚结束瞬间连续秒发)
        cooldown = custom_cooldown if custom_cooldown is not None else self.min_turn_interval
        now = time.time()
        elapsed = now - self._last_turn_ts
        if self._last_turn_ts > 0 and elapsed < cooldown:
            time.sleep(cooldown - elapsed)

        try:
            res = send_fn(cdp, prompt, *args, **kwargs)
            duration = time.time() - t0
            self._last_turn_ts = time.time()
            self._last_action_ts = time.time()
            self._turn_count += 1

            # 检查返回结果是否有 429 或 quota exceeded
            err_text = ""
            if isinstance(res, tuple) and len(res) >= 2 and not res[0]:
                err_text = str(res[1])
            elif hasattr(res, "success") and not getattr(res, "success", True):
                err_text = str(getattr(res, "error", ""))

            if any(kw in err_text.lower() for kw in ["429", "quota", "too many requests", "rate limit"]):
                circuit_err = f"检测到平台限流或配额熔断报错: {err_text}"
                self.record_audit("SEND_TURN", p_preview, "BLOCKED", duration, error=circuit_err)
                raise CircuitBreakerError(circuit_err)

            self.record_audit("SEND_TURN", p_preview, "SUCCESS" if not err_text else "FAILED", duration, error=err_text or None)
            return res
        except CircuitBreakerError:
            raise
        except Exception as e:
            duration = time.time() - t0
            self.record_audit("SEND_TURN", p_preview, "FAILED", duration, error=str(e))
            raise

    def safe_delete(
        self,
        cdp: Any,
        delete_fn: Callable[..., Any],
        chat_id: str,
        *args,
        custom_cooldown: Optional[float] = None,
        **kwargs
    ) -> Any:
        """
        高危删除会话操作安全守门：
        强制实施删除操作冷却与完整审计轨迹。
        """
        t0 = time.time()
        cooldown = custom_cooldown if custom_cooldown is not None else self.min_delete_interval
        now = time.time()
        elapsed = now - self._last_delete_ts
        if self._last_delete_ts > 0 and elapsed < cooldown:
            time.sleep(cooldown - elapsed)

        try:
            res = delete_fn(cdp, chat_id, *args, **kwargs)
            duration = time.time() - t0
            self._last_delete_ts = time.time()
            self._last_action_ts = time.time()
            success = bool(res[0] if isinstance(res, tuple) else res)
            self.record_audit("DELETE_CHAT", chat_id, "SUCCESS" if success else "FAILED", duration)
            return res
        except Exception as e:
            duration = time.time() - t0
            self.record_audit("DELETE_CHAT", chat_id, "FAILED", duration, error=str(e))
            raise

    def dump_audit_log(self, filepath: str) -> None:
        """导出审计轨迹到指定 JSON 文件"""
        os.makedirs(os.path.dirname(os.path.abspath(filepath)), exist_ok=True)
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump({
                "total_actions": len(self.audit_log),
                "entries": self.audit_log
            }, f, indent=2, ensure_ascii=False)

    def get_summary(self) -> Dict[str, Any]:
        """获取当前网关审计统计概览"""
        total = len(self.audit_log)
        success = sum(1 for e in self.audit_log if e.get("status") == "SUCCESS")
        blocked = sum(1 for e in self.audit_log if e.get("status") == "BLOCKED")
        failed = sum(1 for e in self.audit_log if e.get("status") == "FAILED")
        return {
            "total": total,
            "success": success,
            "blocked": blocked,
            "failed": failed
        }


# 全局单例网关实例
_GLOBAL_GATEWAY: Optional[SafeInteractionGateway] = None


def get_gateway() -> SafeInteractionGateway:
    """获取全局共享的安全网关实例"""
    global _GLOBAL_GATEWAY
    if _GLOBAL_GATEWAY is None:
        _GLOBAL_GATEWAY = SafeInteractionGateway()
    return _GLOBAL_GATEWAY
