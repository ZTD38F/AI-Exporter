#import "theme.typ": *
#import "components.typ": *
#import "render-block.typ": render-blocks

#let render-bubble-message(message) = context {
  let file-widths = message.minWidthCards.map(card => file-attachment-natural-width(card.label, card.metadata))
  user-bubble(
    render-blocks(message.blocks, scope: "bubble"),
    min-content-width: calc.max(0pt, ..file-widths),
    plain-text: if "plainText" in message { message.plainText } else { "" },
  )
}

#let render-flow-message(message) = {
  if "model" in message and message.model != "" { assistant-mark(model: message.model); v(sp-xs) }
  render-blocks(message.blocks)
}

#let render-message(message) = {
  if message.variant == "bubble" { render-bubble-message(message) }
  else { render-flow-message(message) }
}

#let render-messages(messages) = {
  for (index, message) in messages.enumerate() {
    let next = messages.at(index + 1, default: none)
    let opening = if next != none and next.variant == "flow" { next.blocks.at(0, default: none) } else { none }
    // Only link to independently breakable prose. A figure or a paragraph
    // already bound to a following visual must not drag the question forward.
    let follows-prose = opening != none and opening.type == "paragraph" and not opening.layout.keepWithNext
    // Put the keep-with-next constraint on the page flow, outside the
    // bubble's context/layout wrappers. Keep long prompts breakable.
    if message.variant == "bubble" and follows-prose {
      context {
        let body = render-message(message)
        let compact = measure(width: content-width, body).height < user-elevation-max-height
        block(sticky: compact, breakable: true, above: 0pt, below: 0pt)[#body]
      }
    } else { render-message(message) }
    if message.gapAfterPt > 0 { v(message.gapAfterPt * 1pt) }
  }
}
