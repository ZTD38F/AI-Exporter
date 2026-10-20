#import "theme.typ": *
#import "components.typ": *
#import "render-inline.typ": render-inlines
#import "mitex-scope.typ": mitex-scope

#let block-gap(previous, current) = {
  let a = previous.type
  let b = current.type
  if b == "heading" or b == "thematicBreak" or a == "thematicBreak" { sp-section }
  else if a == "heading" { sp-paragraph }
  else if a == "paragraph" and b == "paragraph" { sp-paragraph }
  else if a == "list" and b == "paragraph" or a == "paragraph" and b == "list" { sp-paragraph }
  else { sp-block }
}

#let in-flow(body, scope, sticky: false) = {
  if scope == "user" { block(width: 100%, sticky: sticky)[#body] }
  else { reading(body, sticky: sticky) }
}

#let render-paragraph(node, scope, sticky: false) = in-flow([
  #render-inlines(node.children)
], scope, sticky: sticky)

#let render-heading(node, scope) = {
  if scope == "user" {
    block(width: 100%, sticky: true)[#heading(level: node.level)[#render-inlines(node.children)]]
  } else {
    reading(sticky: true)[#heading(level: node.level)[#render-inlines(node.children)]]
  }
}

#let render-list(node, scope, recurse) = {
  let items = node.items.map(item => {
    let body = {
      for (index, sub) in item.blocks.enumerate() {
        if index > 0 { v(block-gap(item.blocks.at(index - 1), sub)) }
        recurse(sub, scope: scope)
      }
    }
    [#body]
  })
  let body = if node.ordered {
    if "start" in node { [#enum(start: node.start, ..items)] } else { [#enum(..items)] }
  } else { [#list(..items)] }
  in-flow(body, scope)
}

#let render-code(node, scope) = code-surface(
  node.language,
  node.text,
  filename: if "filename" in node { node.filename } else { none },
  meta: if "meta" in node { node.meta } else { none },
)

#let render-math(node, scope) = {
  if "typst" in node {
    let math = eval(node.typst, mode: "math", scope: mitex-scope)
    if scope == "user" { block(width: 100%)[#align(center)[#math]] } else { math-surface(math) }
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
  let aligns = if "aligns" in node { node.aligns } else { none }
  let table = modern-table(headers, rows, aligns: aligns)
  if "caption" in node and node.caption != "" {
    [
      #align(center)[#text(size: caption-size, fill: muted)[#node.caption]]
      #v(4pt)
      #table
    ]
  } else {
    table
  }
}

#let render-image(node, scope) = image-surface(
  node.asset,
  caption: if "caption" in node { node.caption } else { none },
)
#let render-file(node, scope) = {
  file-attachment(node.name, node.kind, node.size)
  if "description" in node and node.description != "" {
    v(3pt)
    text(size: caption-size, fill: muted)[#node.description]
  }
}

#let render-quote(node, scope, recurse) = {
  let body = {
    for (index, sub) in node.blocks.enumerate() {
      if index > 0 { v(block-gap(node.blocks.at(index - 1), sub)) }
      recurse(sub, scope: scope)
    }
  }
  if scope == "user" {
    block(width: 100%, stroke: (left: 1pt + rule-strong), inset: (left: 7pt))[#body]
  } else {
    quote-surface(body)
  }
}

#let render-note(node, scope, recurse) = {
  let label = if "label" in node and node.label != "" {
    [#text(size: 7.6pt, weight: 640, fill: ink-soft)[#node.label]#v(2.5pt)]
  }
  if "blocks" in node {
    let body = {
      for (index, sub) in node.blocks.enumerate() {
        if index > 0 { v(block-gap(node.blocks.at(index - 1), sub)) }
        recurse(sub, scope: scope)
      }
    }
    quiet-note[#label#body]
  } else {
    quiet-note[#label#render-inlines(node.children)]
  }
}

#let render-unknown(node) = {
  unknown-surface(node.label, node.fallback)
}

#let render-thematic-break(node, scope) = {
  in-flow([
    #v(2pt)
    #line(length: 100%, stroke: 0.6pt + muted)
    #v(2pt)
  ], scope)
}

#let render-block(node, scope: "assistant", sticky: false) = {
  let kind = node.type
  if kind == "paragraph" { render-paragraph(node, scope, sticky: sticky) }
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

#let should-keep-with-next(blocks, index) = {
  if index >= blocks.len() - 1 { false }
  else {
    let current = blocks.at(index)
    let next = blocks.at(index + 1)
    current.type == "paragraph" and next.type in ("table", "image", "math", "code")
  }
}

#let render-blocks(blocks, scope: "assistant") = {
  for (index, node) in blocks.enumerate() {
    if index > 0 { v(block-gap(blocks.at(index - 1), node)) }
    render-block(node, scope: scope, sticky: should-keep-with-next(blocks, index))
  }
}
