#import "theme.typ": *

#let reading(body, sticky: false) = layout(size => block(width: calc.min(prose-width, size.width), sticky: sticky, body))
#let wide(body) = block(width: 100%, body)

#let inline-code(code) = box(
  fill: inline-fill,
  inset: (x: 3.1pt, y: 0.9pt),
  radius: radius-inline,
  text(font: font-mono, size: 8.05pt, fill: ink-soft)[#code],
)

// Insert zero-width break opportunities into long unbroken tokens (URLs, hashes) so they wrap inside narrow cells.
#let safe-text(value, run-limit: 18) = {
  let token-pattern = regex("[A-Za-z0-9_./:?&=#%+\\-]{24,}")
  let token-char = regex("[A-Za-z0-9_./:?&=#%+\\-]")
  if value.match(token-pattern) == none {
    value
  } else {
    let run = 0
    for cluster in value.clusters() {
      cluster
      if cluster.match(token-char) == none {
        run = 0
      } else {
        run += 1
        let punctuation = cluster in ("/", "_", "-", ".", ":", "?", "&", "=", "#")
        if punctuation or run >= run-limit {
          h(0pt, weak: true)
          run = 0
        }
      }
    }
  }
}

// Typst has no CSS box-shadow blur; approximate elevation with two offset translucent rects.
#let elevated-frame(width, height, radius, fill, body, stroke: none, level: 1) = box(
  width: width,
  height: height + if level > 0 { elevation-far-y } else { 0pt },
)[
  #if level > 0 {
    place(
      top + left,
      dy: elevation-far-y - elevation-far-spread,
      dx: -elevation-far-spread,
      rect(
        width: width + 2 * elevation-far-spread,
        height: height + 2 * elevation-far-spread,
        radius: radius + elevation-far-spread,
        fill: shadow-far,
      ),
    )
    place(
      top + left,
      dy: elevation-near-y,
      rect(width: width, height: height, radius: radius, fill: shadow-near),
    )
  }
  #place(
    top + left,
    rect(width: width, height: height, radius: radius, fill: fill, stroke: stroke),
  )
  #place(top + left, body)
]

#let truncate-to-width(value, width, font-size: 8.25pt, weight: 560) = {
  if measure(text(size: font-size, weight: weight)[#value]).width <= width {
    value
  } else {
    let chars = value.clusters()
    let result = value
    while chars.len() > 3 and measure(
      text(size: font-size, weight: weight)[#(chars.join("") + "…")]
    ).width > width {
      chars = chars.slice(0, chars.len() - 1)
    }
    result = chars.join("") + "…"
    result
  }
}

#let truncate-filename-to-width(value, width, font-size: 8.25pt, weight: 560) = {
  if measure(text(size: font-size, weight: weight)[#value]).width <= width {
    value
  } else {
    let ext-match = value.match(regex("\\.[^./]+$"))
    if ext-match == none or ext-match.start == 0 {
      truncate-to-width(value, width, font-size: font-size, weight: weight)
    } else {
      let ext = ext-match.text
      let base = value.slice(0, ext-match.start)
      let ext-width = measure(text(size: font-size, weight: weight)[#ext]).width
      let base-width = calc.max(width - ext-width, 16pt)
      let chars = base.clusters()
      while chars.len() > 1 and measure(
        text(size: font-size, weight: weight)[#(chars.join("") + "…")]
      ).width > base-width {
        chars = chars.slice(0, chars.len() - 1)
      }
      chars.join("") + "…" + ext
    }
  }
}

#let user-to-assistant-gap() = v(sp-xl)
#let assistant-to-user-gap() = v(sp-turn)

#let sparkle-mark() = box(width: 6.5pt, height: 6.5pt)[
  #place(center)[
    #rotate(45deg, square(size: 3.2pt, fill: accent))
  ]
]

#let assistant-mark(model: "") = {
  if model != "" {
    reading(
      block(sticky: true)[
        #grid(
          columns: (auto, auto),
          column-gutter: 5pt,
          align: horizon,
          sparkle-mark(),
          text(size: metadata-size, weight: 520, fill: muted)[#model],
        )
      ]
    )
  }
}

// Natural user bubble width is capped globally; height only controls pagination/elevation.
#let user-bubble(body, plain-text: "", min-content-width: 0pt) = layout(size => {
  let px = 12.5pt
  let py = 8.4pt
  let max-width = calc.min(size.width * user-bubble-max-ratio, prose-width)

  let styled-body = block(width: 100%)[
    #set par(leading: user-leading, spacing: 0pt)
    #align(left)[#body]
  ]

  let raw-width = if plain-text == "" {
    max-width
  } else {
    measure(text(size: body-size)[#plain-text]).width + 2 * px
  }

  let bubble-width = calc.min(calc.max(raw-width, 2 * px + calc.max(28pt, min-content-width)), max-width)

  let inner-width = calc.max(bubble-width - 2 * px, 28pt)
  let content-height = measure(width: inner-width, styled-body).height
  let bubble-height = content-height + 2 * py
  let compact = bubble-height < user-elevation-max-height

  block(width: 100%, sticky: compact)[
    #align(right)[
      #if compact {
        elevated-frame(
          bubble-width,
          bubble-height,
          radius-user,
          user-fill,
          [
            #box(width: bubble-width, height: bubble-height)[
              #place(top + left, dx: px, dy: py)[
                #box(width: inner-width)[#styled-body]
              ]
            ]
          ],
          level: 1,
        )
      } else {
        block(
          width: bubble-width,
          fill: user-fill,
          inset: (x: px, y: py),
          radius: radius-user-long,
          breakable: true,
        )[#styled-body]
      }
    ]
  ]
})

#let file-icon() = box(width: 22pt, height: 22pt)[
  #place(center)[
    #rect(width: 22pt, height: 22pt, radius: 6pt, fill: accent-soft)
  ]
  #place(center)[
    #rect(width: 8.4pt, height: 10.6pt, radius: 1.3pt, stroke: 0.85pt + accent)
  ]
  #place(center, dy: 1.8pt)[
    #line(length: 4.3pt, stroke: 0.65pt + accent)
  ]
]

#let file-attachment-card(name, kind, size, card-width: none) = layout(size-info => {
  let px = 10.5pt
  let py = 8.3pt
  let icon-w = 22pt
  let gap = 8pt
  let resolved-width = if card-width == none { size-info.width } else { card-width }
  let card-height = attachment-card-height
  let text-area = calc.max(resolved-width - 2 * px - icon-w - gap, 32pt)
  let display-name = truncate-filename-to-width(name, text-area)
  let meta = kind + " · " + size

  elevated-frame(
    resolved-width,
    card-height,
    radius-attachment,
    page-fill,
    [
      #box(width: resolved-width, height: card-height)[
        #place(top + left, dx: px, dy: py)[#file-icon()]
        #place(top + left, dx: px + icon-w + gap, dy: py + 1pt)[
          #box(width: text-area)[
            #text(size: 8.25pt, weight: 560, fill: ink-soft)[#display-name]
            #v(2.2pt)
            #text(size: metadata-size, fill: muted)[#meta]
          ]
        ]
      ]
    ],
    stroke: 0.45pt + rule,
    level: 2,
  )
})

// File cards reserve their actual label/metadata width plus icon and insets.
// The enclosing user bubble must account for the same intrinsic width.
#let file-attachment-natural-width(name, kind, size) = {
  let name-w = measure(text(size: 8.25pt, weight: 560)[#name]).width
  let meta-w = measure(text(size: metadata-size)[#(kind + " · " + size)]).width
  22pt + 8pt + calc.max(name-w, meta-w) + 2 * 10.5pt
}

#let file-attachment(name, kind, size) = layout(size-info => {
  let natural = file-attachment-natural-width(name, kind, size)
  let max-width = size-info.width
  let card-width = calc.min(natural, max-width)

  block(width: 100%)[
    #align(right)[#file-attachment-card(name, kind, size, card-width: card-width)]
  ]
})

#let code-surface(lang, code, filename: none, meta: none) = wide(
  block(
    width: 100%,
    fill: embedded-fill,
    stroke: 0.35pt + rule,
    radius: radius-code,
    clip: true,
    breakable: true,
  )[
    #block(sticky: true, inset: (left: 12pt, right: 12pt, top: 7pt, bottom: 2pt))[
      #text(size: metadata-size, weight: 530, fill: muted)[
        #if filename == none { lang } else if lang == "text" { filename } else { filename + " · " + lang }#if meta != none and meta != "" [ · #meta]
      ]
    ]
    #block(inset: (left: 12pt, right: 12pt, top: 2.5pt, bottom: 9.5pt))[
      // REGRESSION (typst.ts 0.7.0 vendored WASM): passing `lang:` to `raw`
      // dropped every space in code blocks (`def foo(a, b):` -> `deffoo(a,b):`).
      // Code fidelity wins over syntax highlighting, so `lang:` is dropped here.
      // The header above still shows the language tag; that is separate.
      // Do not restore `raw(..., lang:)` until the vendored Typst runtime is upgraded and this regression test passes.
      #raw(code, block: true, theme: "quiet-light.tmTheme")
    ]
  ]
)

#let math-surface(body) = wide(
  block(width: 100%, breakable: false)[#align(center)[#body]]
)

#let image-surface(path, caption: none) = wide(
  layout(size => {
    let full = image(path, width: size.width)
    let natural = measure(full)
    let scaled = natural.height > figure-max-height
    let img-h = if scaled { figure-max-height } else { natural.height }
    let img-w = if scaled { size.width * (figure-max-height / natural.height) } else { size.width }
    let img = image(path, width: img-w)
    let caption-natural = if caption == none or caption == "" {
      img-w
    } else {
      calc.min(
        measure(text(size: caption-size)[#caption]).width + 4pt,
        figure-caption-max-width,
      )
    }
    let figure-w = calc.min(calc.max(img-w, caption-natural), size.width)

    block(width: 100%, breakable: false)[
      #align(center)[
        #block(width: figure-w)[
          #align(center)[
            #elevated-frame(
              img-w,
              img-h,
              radius-image,
              page-fill,
              [
                #box(width: img-w, height: img-h)[
                  #place(top + left)[
                    #block(width: img-w, height: img-h, radius: radius-image, clip: true)[#img]
                  ]
                ]
              ],
              stroke: 0.3pt + rule,
              level: 1,
            )
          ]
          #if caption != none and caption != "" {
            v(4.5pt)
            text(size: caption-size, fill: muted)[#caption]
          }
        ]
      ]
    ]
  })
)

#let quiet-note(body) = reading(
  block(stroke: (left: 1pt + rule-strong), inset: (left: 7.5pt, y: 1pt))[
    #text(size: 8.1pt, fill: muted)[#body]
  ]
)

#let quote-surface(body) = reading(
  block(stroke: (left: 1pt + rule-strong), inset: (left: 8pt, y: 0pt))[
    #text(fill: ink-soft)[#body]
  ]
)

#let unknown-surface(label, body) = reading(
  block(fill: embedded-fill, radius: 7pt, inset: 8pt)[
    #text(size: metadata-size, fill: muted)[#label]
    #v(3pt)
    #body
  ]
)

#let modern-table(headers, rows, columns: none, aligns: none) = wide(
  block(width: 100%)[
    #set text(size: 8.5pt)
    #let logical-cols = (headers + rows).map(row => row.fold(0, (n, c) => n + c.colspan)).fold(0, calc.max)
    #let cols = if columns == none {
      if logical-cols > 0 { logical-cols } else { 1 }
    } else { columns.map(x => x * 1fr) }
    #let al = if aligns == none { left } else {
      aligns.map(x => if x == "center" { center } else if x == "right" { right } else { left })
    }
    #let span-args(cell) = {
      let args = (:)
      if cell.colspan > 1 { args.insert("colspan", cell.colspan) }
      if cell.rowspan > 1 { args.insert("rowspan", cell.rowspan) }
      args
    }
    #let header-cells = headers.flatten().map(h => table.cell(
      fill: header-fill,
      stroke: (bottom: 0.4pt + rule),
      ..span-args(h),
      text(size: 8.1pt, weight: 600)[#h.body],
    ))
    #let body-cells = rows.flatten().map(cell => table.cell(
      stroke: (bottom: 0.3pt + rule),
      ..span-args(cell),
      cell.body,
    ))
    #let header-arg = if headers.len() > 0 {
      (table.header(repeat: true, ..header-cells),)
    } else { () }
    #table(
      columns: cols,
      inset: (x: 7pt, y: 6.5pt),
      align: al,
      stroke: none,
      ..header-arg,
      ..body-cells,
    )
  ]
)
