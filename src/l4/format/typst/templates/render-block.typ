#import "theme.typ": *
#import "components.typ": *
#import "render-inline.typ": render-inlines
#import "mitex-scope.typ": mitex-scope

#let in-flow(body, scope, sticky: false) = {
  if scope == "container" or scope == "full" { block(width: 100%, sticky: sticky)[#body] }
  else { reading(body, sticky: sticky) }
}

#let render-paragraph(node, scope, sticky: false) = in-flow([
  #render-inlines(node.children)
], scope, sticky: sticky)

#let render-heading(node, scope) = in-flow(
  heading(level: node.level)[#render-inlines(node.children)],
  node.layout.width,
  sticky: node.layout.keepWithNext,
)

#let render-list(node, scope, recurse) = {
  let items = node.items.map(item => {
    let body = {
      for (index, sub) in item.blocks.enumerate() {
        if sub.layout.gapBeforePt > 0 { v(sub.layout.gapBeforePt * 1pt, weak: true) }
        recurse(sub, scope: scope)
      }
    }
    [#body]
  })
  let make-list(items, offset: 0) = if node.ordered {
    enum(start: (if "start" in node { node.start } else { 1 }) + offset, ..items)
  } else { list(..items) }
  let body = layout(size => {
    // Keep a short final pair together, without making a long list unbreakable.
    let tail = make-list(items.slice(calc.max(0, items.len() - 2)), offset: calc.max(0, items.len() - 2))
    if items.len() >= 3 and measure(width: size.width, tail).height <= 100pt {
      make-list(items.slice(0, items.len() - 2))
      v(sp-inline)
      block(breakable: false, above: 0pt, tail)
    } else { make-list(items) }
  })
  in-flow(body, node.layout.width, sticky: node.layout.keepWithNext)
}

#let render-code(node, scope) = code-surface(node.header, node.text, width: node.layout.width)

#let render-math(node, scope) = {
  if "typst" in node {
    let math = eval(node.typst, mode: "math", scope: mitex-scope)
    if scope == "bubble" { block(width: 100%)[#align(center)[#math]] } else { math-surface(math, width: node.layout.width) }
  } else {
    quiet-note[
      #node.fallbackLabel#inline-code(node.latex)
    ]
  }
}

#let render-table(node, scope) = {
  let mk(cell) = (
    body: [#render-inlines(cell.children)],
    colspan: if "colspan" in cell { cell.colspan } else { 1 },
    rowspan: if "rowspan" in cell { cell.rowspan } else { 1 },
  )
  let headers = node.headers.map(row => row.map(mk))
  let rows = node.rows.map(row => row.map(mk))
  let aligns = node.aligns
  let table = modern-table(headers, rows, node.columnCount, aligns, node.repeatHeader, width: node.layout.width)
  if "caption" in node and node.caption.len() > 0 {
    [
      #align(center)[#text(size: caption-size, fill: muted)[#render-inlines(node.caption)]]
      #v(4pt)
      #table
    ]
  } else {
    table
  }
}

#let render-image(node, scope) = image-surface(
  node.asset,
  width: node.layout.width,
  caption: if "caption" in node { [#render-inlines(node.caption)] } else { none },
)
#let render-file(node, scope) = {
  file-attachment(node.name, node.metadata, width: node.layout.width)
  if "description" in node and node.description.len() > 0 {
    v(3pt)
    text(size: caption-size, fill: muted)[#render-inlines(node.description)]
  }
}

#let render-quote(node, scope, recurse) = {
  let body = {
    for (index, sub) in node.blocks.enumerate() {
      if sub.layout.gapBeforePt > 0 { v(sub.layout.gapBeforePt * 1pt, weak: true) }
      recurse(sub, scope: scope)
    }
  }
  if node.layout.width == "container" {
    block(width: 100%, stroke: (left: 1pt + rule-strong), inset: (left: 7pt))[#body]
  } else {
    quote-surface(body, width: node.layout.width)
  }
}

#let render-note(node, scope, recurse) = {
  let label = if "label" in node and node.label != "" {
    [#text(size: 7.6pt, weight: 640, fill: ink-soft)[#node.label]#v(2.5pt)]
  }
  if "blocks" in node {
    let body = {
      for (index, sub) in node.blocks.enumerate() {
        if sub.layout.gapBeforePt > 0 { v(sub.layout.gapBeforePt * 1pt, weak: true) }
        recurse(sub, scope: scope)
      }
    }
    quiet-note(width: node.layout.width)[#label#body]
  } else {
    quiet-note(width: node.layout.width)[#label#render-inlines(node.children)]
  }
}

#let render-unknown(node) = {
  unknown-surface(node.label, [#node.fallback#if "details" in node { v(3pt); render-inlines(node.details) }], width: node.layout.width)
}

#let render-thematic-break(node, scope) = {
  in-flow([
    #v(2pt)
    #line(length: 100%, stroke: 0.6pt + muted)
    #v(2pt)
  ], node.layout.width)
}

#let render-block(node, scope: "flow") = {
  let kind = node.type
  if kind == "paragraph" { render-paragraph(node, node.layout.width, sticky: node.layout.keepWithNext) }
  else if kind == "heading" { render-heading(node, scope) }
  else if kind == "list" { render-list(node, scope, render-block) }
  else if kind == "code" { render-code(node, scope) }
  else if kind == "math" { render-math(node, scope) }
  else if kind == "table" { render-table(node, scope) }
  else if kind == "image" { render-image(node, scope) }
  else if kind == "file" { render-file(node, scope) }
  else if kind == "thematicBreak" { render-thematic-break(node, scope) }
  else if kind == "quote" { render-quote(node, scope, render-block) }
  else if kind == "note" { render-note(node, scope, render-block) }
  else { render-unknown(node) }
}

#let render-blocks(blocks, scope: "flow") = {
  let sequence(nodes) = {
    for node in nodes {
      if node.layout.gapBeforePt > 0 { v(node.layout.gapBeforePt * 1pt, weak: true) }
      render-block(node, scope: scope)
    }
  }
  // A short source footer must carry its preceding context onto the next page.
  if blocks.len() >= 2 and blocks.last().type == "note" and blocks.at(-2).type == "paragraph" {
    layout(size => {
      let tail = sequence(blocks.slice(blocks.len() - 2))
      if measure(width: size.width, tail).height <= 180pt {
        sequence(blocks.slice(0, blocks.len() - 2))
        block(breakable: false, tail)
      } else { sequence(blocks) }
    })
  } else { sequence(blocks) }
}
