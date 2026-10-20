<!--
  Provenance Evidence for Compatibility Rule GM-MD-001
  Observed on live Gemini: 2026-09-29T23:50:00Z
  Chat ID: 41f3f4aea881f034 (克尔黑洞微扰与Teukolsky方程推导)
  Description:
    Gemini model outputs multiline LaTeX math formulas with environment tags directly
    attached to the $$ delimiter on the opening line ($$\begin{aligned}) and/or closing
    line (\end{aligned}$$).
    Standard CommonMark / micromark-extension-math treats $$ followed by non-whitespace
    as a fence with meta string, stripping the environment tag from the math content and
    failing to match the closing fence when not on its own line, swallowing the entire
    rest of the document into an unclosed math block.
-->

#### 3. Teukolsky 主方程（TME）

将方向导数转化为 Boyer-Lindquist 坐标微商，Teukolsky 统一方程写作：
$$\begin{aligned}
\Biggl[ &\left(\frac{(r^2+a^2)^2}{\Delta} - a^2\sin^2\theta\right)\frac{\partial^2\psi}{\partial t^2} + \frac{4Mar}{\Delta}\frac{\partial^2\psi}{\partial t\partial\phi} + \left(\frac{a^2}{\Delta} - \frac{1}{\sin^2\theta}\right)\frac{\partial^2\psi}{\partial\phi^2} \\
&- \Delta^{-s}\frac{\partial}{\partial r}\left(\Delta^{s+1}\frac{\partial\psi}{\partial r}\right) - \frac{1}{\sin\theta}\frac{\partial}{\partial\theta}\left(\sin\theta\frac{\partial\psi}{\partial\theta}\right) \\
&- 2s\left(\frac{a(r-M)}{\Delta} + \frac{i\cos\theta}{\sin^2\theta}\right)\frac{\partial\psi}{\partial\phi} - 2s\left(\frac{M(r^2-a^2)}{\Delta} - r - ia\cos\theta\right)\frac{\partial\psi}{\partial t} \\
&+ (s^2\cot^2\theta - s) \psi \Biggr] = 4\pi \Sigma T
\end{aligned}$$
在真空辐射规范（Radiation Gauge / 无外源）条件下，令源项 $T = 0$。

---
