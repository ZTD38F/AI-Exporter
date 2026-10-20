#import "components.typ": inline-code, safe-text
#import "mitex-scope.typ": mitex-scope

// Nested children recurse via a local helper so render-inline does not reference render-inlines before its declaration.
#let render-inline(node) = {
  let children(nodes) = {
    for child in nodes { render-inline(child) }
  }

  // Measure natural width at a 4.5em height budget, then clamp to column width so wide inline images scale down without overflowing.
  let inline-image(path, alt: none) = layout(size => {
    let natural = measure(image(path, height: 4.5em, alt: alt))
    let w = calc.min(natural.width, size.width)
    image(path, width: w, fit: "contain", alt: alt)
  })

  let kind = node.type
  if kind == "text" {
    safe-text(node.text)
  } else if kind == "strong" {
    strong(children(node.children))
  } else if kind == "emphasis" {
    emph(children(node.children))
  } else if kind == "strikethrough" {
    strike(children(node.children))
  } else if kind == "inlineCode" {
    inline-code(node.text)
  } else if kind == "link" {
    link(node.url)[#children(node.children)]
  } else if kind == "lineBreak" {
    linebreak()
  } else if kind == "image" {
    inline-image(node.asset, alt: if "alt" in node { node.alt } else { none })
  } else if kind == "inlineMath" {
    if "typst" in node { eval(node.typst, mode: "math", scope: mitex-scope) } else { inline-code(node.latex) }
  } else {
    if "text" in node { node.text } else { [�] }
  }
}

#let render-inlines(nodes) = {
  for node in nodes { render-inline(node) }
}
