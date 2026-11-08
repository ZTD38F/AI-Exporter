"""Native quota evidence, restricted to UI chrome outside authored messages."""
QUOTA_EXPRESSION = r"""(()=>{
    if(!document.body)return null;
    const clone=document.body.cloneNode(true);
    clone.querySelectorAll('[data-testid=chat-input],[data-testid=user-message],[data-testid=assistant-message],#geminiExportBadge,script,style').forEach(e=>e.remove());
    const text=clone.textContent||'';
    return text.match(/(?:您的免费消息额度已用完|您已达到\s*5\s*小时消息限额|(?:you(?:'ve| have)?\s+)?(?:reached|hit)\s+(?:your|the)\s+(?:free\s+)?(?:message|usage|5.hour)\s+limit)[^\n]{0,180}/i)?.[0]||null;
})()"""
