#let visual = json("/visual-contract.json")

#let page-fill = rgb("#FCFCFB")
#let ink = rgb("#202327")
#let ink-soft = rgb("#34383E")
#let muted = rgb("#737A84")
#let muted-2 = rgb("#A3A9B1")
#let rule = rgb("#E8EAED")
#let rule-strong = rgb("#DDE1E6")
#let user-fill = rgb("#EFF4F9")
#let embedded-fill = rgb("#F6F7F8")
#let header-fill = rgb("#F7F8F9")
#let inline-fill = rgb("#F1F3F5")
#let accent = rgb("#4E7CF6")
#let accent-soft = rgb("#EAF1FF")

#let shadow-near = rgb("#111827").transparentize(96%)
#let shadow-far = rgb("#111827").transparentize(98.4%)

#let font-ui = (
  "SF Pro Text",
  "SF Pro Display",
  "PingFang SC",
  "Helvetica Neue",
  "Arial",
  "Noto Sans SC",
  "Noto Sans CJK SC",
  "Noto Sans",
  "DejaVu Sans",
)

#let font-mono = (
  "SF Mono",
  "Menlo",
  "Monaco",
  "JetBrains Mono",
  "DejaVu Sans Mono",
)

#let font-math = (
  "NewCMMath",
  "Noto Sans Math",
)

#let body-size = visual.type.body.size * 0.625pt
#let body-leading = body-size * (visual.type.body.lineHeight - 1) * 0.6
#let user-leading = body-leading
// PDF follows the same semantic type hierarchy in native print units.
#let title-size = visual.type.title.size * 0.75pt
#let h1-size = visual.type.title.size * 0.625pt
#let h2-size = visual.type.h2.size * 0.625pt
#let h3-size = visual.type.h3.size * 0.625pt
#let small-size = visual.type.small.size * 0.625pt
#let metadata-size = visual.type.metadata.size * 0.625pt
#let caption-size = small-size
#let code-size = 8.15pt
// PDF shares the content/prose hierarchy with visualContract.ts, in print units.
#let content-width = 166mm
#let prose-width = content-width * visual.content.proseWidth / visual.content.maxWidth
#let reading-width = prose-width
#let user-bubble-max-ratio = 85%

#let page-width = 210mm
#let page-height = 297mm
#let page-margin-top = 18.5mm
#let page-margin-bottom = 18mm
#let page-side-padding = (page-width - content-width) / 2
#let page-margin-left = page-side-padding
#let page-margin-right = page-side-padding
#let page-body-height = page-height - page-margin-top - page-margin-bottom

#let radius-inline = 3.2pt
#let radius-code = 9pt
#let radius-user = 12pt
#let radius-user-long = 9.5pt
#let radius-attachment = 10pt
#let radius-image = 9pt

#let elevation-near-y = 0.75pt
#let elevation-far-y = 1.8pt
#let elevation-far-spread = 1.0pt

#let user-elevation-max-height = 120pt

#let figure-max-page-ratio = 0.60
#let figure-max-height = page-body-height * figure-max-page-ratio
#let figure-caption-max-width = 115mm

#let attachment-single-max-ratio = 48%
#let attachment-card-height = 38.6pt

// Semantic rhythm shares HTML tokens; px becomes pt at 72/96.
#let sp-inline = visual.spacing.inline * 0.75pt
#let sp-paragraph = visual.spacing.paragraph * 0.75pt
#let sp-block = visual.spacing.block * 0.75pt
#let sp-section = visual.spacing.section * 0.75pt
#let sp-turn = visual.spacing.turn * 0.75pt
// Compatibility names used by component internals.
#let sp-micro = sp-inline / 2
#let sp-xs = sp-inline
#let sp-sm = sp-paragraph
#let sp-md = sp-block
#let sp-lg = sp-section
#let sp-xl = sp-section

#let document-theme(body) = {
  set page(
    width: page-width,
    height: page-height,
    fill: page-fill,
    margin: (top: page-margin-top, bottom: page-margin-bottom, left: page-margin-left, right: page-margin-right),
    numbering: none,
    footer: context align(right)[
      #text(size: 6.8pt, fill: muted-2)[#counter(page).display("1")]
    ],
  )

  set text(
    font: font-ui,
    size: body-size,
    weight: visual.type.body.weight,
    fill: ink,
    lang: "zh",
    cjk-latin-spacing: auto,
  )
  show math.equation: set text(font: font-math)
  set par(leading: body-leading, spacing: 0pt, justify: false)
  set list(indent: 0pt, body-indent: 0.66em, spacing: sp-inline)
  set heading(numbering: none)

  show heading.where(level: 1): it => block(
    sticky: true,
    above: 0pt,
    below: 0pt,
    text(size: h1-size, weight: visual.type.title.weight, fill: ink, it.body),
  )
  show heading.where(level: 2): it => block(
    sticky: true,
    above: 0pt,
    below: 0pt,
    text(size: h2-size, weight: visual.type.h2.weight, fill: ink, it.body),
  )
  show heading.where(level: 3): it => block(
    sticky: true,
    above: 0pt,
    below: 0pt,
    text(size: h3-size, weight: visual.type.h3.weight, fill: ink, it.body),
  )
  show heading.where(level: 4): it => block(
    sticky: true,
    above: 0pt,
    below: 0pt,
    text(size: body-size, weight: 620, fill: ink, it.body),
  )
  show heading.where(level: 5): it => block(
    sticky: true,
    above: 0pt,
    below: 0pt,
    text(size: body-size, weight: 600, fill: ink, it.body),
  )
  show heading.where(level: 6): it => block(
    sticky: true,
    above: 0pt,
    below: 0pt,
    text(size: body-size, weight: 600, fill: ink-soft, it.body),
  )

  show link: set text(fill: accent)
  show raw.where(block: true): set text(font: font-mono, size: code-size)

  body
}
