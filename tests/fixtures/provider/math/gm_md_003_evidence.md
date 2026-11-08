<!-- Captured 2026-10-15, live conversation 4dd132917fa84407, arithmetic coding turn 1.
Webpage data-math sources: \\$, f(\\$) = 1, \\$.
The standard micromark math tokenizer treats the inner dollars as delimiters.
Minimal reproduction retains the observed doubled-backslash variant. -->
在字母表中加入专用的终止符（如 $\\$$），赋予其频数 $f(\\$) = 1$。编码完成时追加编码该符号，解码器遇到 $\\$$ 时终止。
