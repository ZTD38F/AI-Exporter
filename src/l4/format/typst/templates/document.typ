#import "theme.typ": *
#import "components.typ": reading
#import "render-message.typ": render-messages

#let render-document(doc) = document-theme[
  #reading[
    #text(size: title-size, weight: visual.type.title.weight, fill: ink)[#doc.title]
    #v(doc.layout.headerGapPt * 1pt)
    #text(size: metadata-size, fill: muted)[
      #doc.metadata
    ]
  ]
  #v(doc.layout.bodyGapPt * 1pt)
  #render-messages(doc.messages)
]
