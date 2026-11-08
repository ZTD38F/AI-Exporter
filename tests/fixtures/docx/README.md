# DOCX image dimension fixtures

Synthetic RGB JPEGs created with Pillow (quality 85), with a red circle on a blue background:

- `portrait.jpg`: 300 × 900, baseline JPEG.
- `landscape.jpg`: 900 × 300, baseline JPEG.
- `progressive.jpg`: 300 × 900, progressive JPEG.

These are project layout fixtures, not provider captures. The frozen pixel dimensions and circular shape provide independent expectations for header decoding, physical OOXML extents and visual aspect-ratio checks.
