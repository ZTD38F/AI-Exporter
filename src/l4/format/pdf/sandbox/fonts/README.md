# Bundled Fonts for Typst Sandbox

## Release validation

`npm run test:release-fonts` verifies the exact SHA256 of all five fonts below
and their original license files. Unknown, renamed, missing or modified fonts,
symlinks and embedded `data:font/` payloads in generated JavaScript fail the gate.
The total font asset budget is 22 MiB (current total: 21,749,580 bytes).

Both full local `npm test` and CI run this gate after building `dist/`. This
replaces the former blanket CJK prohibition and 5 MiB budget: the licensed CJK
fallback is now required to keep offline PDF exports readable when Local Font
Access is denied or unavailable. Device fonts remain preferred when authorized.

## 1. NewCMMath-Regular.otf (1.2 MiB)

- **Source**: `NewCMMath-Regular.otf` from the `newcomputermodern` package on CTAN (`fonts/newcomputermodern/otf/`).
- **License**: GUST Font License (shipped verbatim alongside the font as `GUST-FONT-LICENSE.txt`).
- **Modification**: Internal family name renamed from `NewComputerModernMath` to `NewCMMath` (name IDs 1/4/16 + CFF TopDict FullName/FamilyName) so Typst matches `font-math = ("NewCMMath", "Noto Sans Math")` in `src/l4/format/typst/templates/theme.typ`. No glyphs were altered and the OpenType MATH table is intact.
- **Why bundled**: Guarantees `eval(..., mode: "math")` always has an OpenType MATH table regardless of host environment.

## 2. NotoSansCJKsc-Regular.otf (15.7 MiB)

- **Copyright** (font name table, verbatim): © 2014-2021 Adobe (http://www.adobe.com/).
- **Source**: <https://github.com/notofonts/noto-cjk/blob/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf>
- **License**: SIL Open Font License 1.1, reproduced verbatim in `OFL-NotoSansCJK.txt`.
- **SHA256**: `2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b`.
- **Modification**: None. Full upstream font, not a test-character subset.
- **Why bundled**: Preserves CJK and Latin text when Local Font Access is denied, unavailable, or returns no suitable fonts. Loaded from extension assets with no runtime network requests. Installed fonts remain preferred when authorized.

## 3. NotoSansMono-Variable.ttf (1.6 MiB)

- **Copyright**: Copyright 2022 The Noto Project Authors (https://github.com/notofonts/latin-greek-cyrillic)
- **Source**: <https://github.com/google/fonts/blob/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosansmono/NotoSansMono%5Bwdth,wght%5D.ttf>
- **License**: SIL Open Font License 1.1; verbatim copyright and license in `OFL-NotoSansMono.txt`.
- **SHA256**: `2cb2adb378a8f574213e23df697050b83c54c27df465a2015552740b2769a081`.
- **Modification**: None; file renamed for a stable asset path, font name tables unchanged.
- **Why bundled**: Keeps code and ASCII diagrams monospaced even when device fonts are unavailable. CJK characters in code fall back to Noto Sans CJK SC.

## 4. NotoEmoji-Variable.ttf (1.9 MiB)

- **Source**: Google Fonts `ofl/notoemoji/NotoEmoji[wght].ttf`, commit `8b0a1d0f5983c89bc2b93f1b5fb55f9e252744b5`.
- **License**: SIL Open Font License 1.1 (`OFL-NotoEmoji.txt`, verbatim).
- **Purpose**: monochrome offline emoji fallback for conversation text, without Local Font Access or network downloads. The text and monospace stacks use it after their regular fonts.
- **SHA256**: `de6c18832938afc99caf132b39d6a30a19bac7f2e812e28db2535b4608d27551`.

The font budget increases by 2 MiB to accommodate this fallback; the existing font hashes remain unchanged.

## 5. DejaVuSansMono.ttf (340,240 bytes)

- **Source**: <https://github.com/matplotlib/matplotlib/blob/39b27ddaafe636f06776a2044b5df05d07648dc4/lib/matplotlib/mpl-data/fonts/ttf/DejaVuSansMono.ttf>
- **License**: Bitstream Vera / DejaVu font license, shipped verbatim as `LICENSE-DejaVu.txt` from the same pinned directory.
- **SHA256**: `602ec86b8948cfcd956482fe64f94c36c867770149ef2f791d4613f443bcecb3`.
- **Modification**: None. Full upstream font, not a test-character subset.
- **Why bundled**: The current Typst PDF writer splits Noto Sans Mono's positioned combining marks into separate text runs, duplicating the cluster's Unicode mapping. DejaVu Sans Mono preserves mark placement and one selectable copy of each cluster without disabling mark positioning. It precedes Noto Sans Mono and affected device monospace fonts. No runtime network or local-font permission is needed; the existing 22 MiB budget is unchanged.
