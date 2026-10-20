#import "theme.typ": *
#import "components.typ": *
#import "render-block.typ": render-blocks

#let render-user-message(message) = context {
  let file-widths = message.blocks.filter(node => node.type == "file").map(node => {
    file-attachment-natural-width(node.name, node.kind, node.size)
  })
  user-bubble(
    render-blocks(message.blocks, scope: "user"),
    min-content-width: calc.max(0pt, ..file-widths),
    plain-text: if "plainText" in message { message.plainText } else { "" },
  )
}

#let render-assistant-message(message) = {
  if "model" in message and message.model != "" { assistant-mark(model: message.model); v(sp-xs) }
  render-blocks(message.blocks)
}

#let render-message(message) = {
  if message.role == "user" { render-user-message(message) }
  else { render-assistant-message(message) }
}

#let render-messages(messages) = {
  for (index, message) in messages.enumerate() {
    render-message(message)
    if index < messages.len() - 1 {
      let next = messages.at(index + 1)
      if message.role == "user" and next.role == "assistant" {
        user-to-assistant-gap()
      } else if message.role == "assistant" and next.role == "user" {
        assistant-to-user-gap()
      } else {
        v(sp-xl)
      }
    }
  }
}
