#import "theme.typ": *
#import "components.typ": reading
#import "render-message.typ": render-messages

#let render-document(doc) = document-theme[
  #reading[
    #text(size: title-size, weight: visual.type.title.weight, fill: ink)[#doc.title]
    #v(sp-inline)
    #text(size: metadata-size, fill: muted)[
      #doc.provider · #doc.date · #doc.messageCount messages
    ]
  ]
  #v(sp-section)
  #render-messages(doc.messages)
]
