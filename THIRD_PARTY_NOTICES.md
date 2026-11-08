# Third-Party Software Notices and Information

This project incorporates or bundles the following open-source third-party software:

---

### 1. JSZip

- **Component**: JSZip v3.10.1
- **Homepage**: <https://stuk.github.io/jszip/>
- **Copyright**: (c) 2009-2016 Stuart Knightley <stuart@stuartk.com>
- **License**: Dual-licensed under MIT License or GPLv3 License

#### MIT License Text:

```text
Copyright (c) 2009-2016 Stuart Knightley, David Duponchel, Franz Buchinger, António Afonso

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

---

### 2. Pako (bundled in JSZip)

- **Component**: Pako (zlib port to JavaScript)
- **Homepage**: <https://github.com/nodeca/pako>
- **Copyright**: (C) 2014-2017 Vitaly Puzrin and Andrei Tuputcyn
- **License**: MIT License

#### MIT License Text:

```text
(C) 2014-2017 Vitaly Puzrin and Andrei Tuputcyn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
---

### 3. typst.ts — Typst compiler for the PDF export sandbox

- **Components**:
  - `@myriaddreamin/typst.ts` v0.7.0 — JS glue bundled into `dist/ui/sandbox/typst-compile.js`
  - `@myriaddreamin/typst-ts-web-compiler` v0.7.0 — WebAssembly compiler binary, vendored byte-identical from npm at `src/l4/format/pdf/sandbox/vendor/typst_ts_web_compiler_bg.wasm` (sha256 `1fc968438a672366dfec39c96c842c26ed29caff4eb1bcaab19a6c60867de5fd`; provenance recorded in `src/l4/format/pdf/sandbox/vendor/README.md`)
  - `@myriaddreamin/typst-ts-renderer` v0.7.0 — declared npm dependency; its code/WASM is **not** included in the shipped extension
- **Upstream**: <https://github.com/Myriad-Dreamin/typst.ts> (packages the Typst compiler, <https://typst.app>, also Apache-2.0)
- **Copyright**: Copyright 2023-2025 Myriad-Dreamin
- **License**: Apache License, Version 2.0

#### Apache License Text:

```text
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "{}"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright 2023-2025 Myriad-Dreamin

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

---

### 4. NewCMMath-Regular.otf (math fallback font for the PDF sandbox)

- **Component**: `NewCMMath-Regular.otf` (1.2 MiB) at `src/l4/format/pdf/sandbox/fonts/`
- **Source**: the `newcomputermodern` package on CTAN (`fonts/newcomputermodern/otf/`), downloaded 2026-09-26
- **License**: GUST Font License v1.0 (2009-06-22) — the work is distributed under the LaTeX Project Public License (LPPL) v1.3c or later, plus a rename request for derived works. The full license text ships with the font at `src/l4/format/pdf/sandbox/fonts/GUST-FONT-LICENSE.txt`.
- **Modification**: renamed from upstream `NewComputerModernMath` to `NewCMMath` (name IDs 1/4/16 + CFF TopDict FullName/FamilyName) via fontTools so Typst matches the pinned `font-math` stack in `src/l4/format/typst/templates/theme.typ`. No glyphs were altered; the OpenType MATH table is intact. The rename satisfies clause 1 of the GUST Font License. Provenance recorded in `src/l4/format/pdf/sandbox/fonts/README.md`.

#### GUST Font License Text (shipped verbatim with the font):

```text
% This is version 1.0, dated 22 June 2009, of the GUST Font License.
% (GUST is the Polish TeX Users Group, http://www.gust.org.pl)
%
% For the most recent version of this license see
% http://www.gust.org.pl/fonts/licenses/GUST-FONT-LICENSE.txt
% or
% http://tug.org/fonts/licenses/GUST-FONT-LICENSE.txt
%
% This work may be distributed and/or modified under the conditions
% of the LaTeX Project Public License, either version 1.3c of this
% license or (at your option) any later version.
%
% Please also observe the following clause:
% 1) it is requested, but not legally required, that derived works be
%    distributed only after changing the names of the fonts comprising this
%    work and given in an accompanying "manifest", and that the
%    files comprising the Work, as listed in the manifest, also be given
%    new names. Any exceptions to this request are also given in the
%    manifest.
%
%    We recommend the manifest be given in a separate file named
%    MANIFEST-<fontid>.txt, where <fontid> is some unique identification
%    of the font family. If a separate "readme" file accompanies the Work,
%    we recommend a name of the form README-<fontid>.txt.
%
% The latest version of the LaTeX Project Public License is in
% http://www.latex-project.org/lppl.txt and version 1.3c or later
% is part of all distributions of LaTeX version 2006/05/20 or later.
```

---

### 5. MiTeX

- **Version**: `0.2.5` (upstream commit `192593c5b817f6c38afd7888f7c84e514c759cf9`)
- **Authors**: `Myriad-Dreamin`, `OrangeX4`, `mgt`, `Enter-tainer`
- **Source**: <https://github.com/mitex-rs/mitex>
- **License**: `Apache-2.0` (Apache License, Version 2.0)
- **Provenance**:
  - WASM & JS glue (`src/l4/format/typst/mitex/vendor/`): vendored from third-party npm build `mitex-wasm@0.2.5` (`https://registry.npmjs.org/mitex-wasm/-/mitex-wasm-0.2.5.tgz`). `mitex_wasm_bg.wasm` SHA256: `7907415f9e7bbc8447dd2ac1d9a4b7bbc3f4f42b96f855d41883dc39f904c0cf`.
  - Typst scope (`src/l4/format/typst/templates/mitex-scope.typ`): consolidated from `@preview/mitex:0.2.5` (`specs/prelude.typ` and `specs/latex/standard.typ`) with `#let mitex-scope = scope` appended and no LaTeX command mapping modifications.
  - Full provenance and policy recorded in `src/l4/format/typst/mitex/vendor/README.md`.
- **License Text**: Licensed under the Apache License, Version 2.0. The full license text is reproduced in Section 3 above.

### 6. Noto Sans CJK SC Regular

- **Copyright** (embedded in the font): © 2014-2021 Adobe (http://www.adobe.com/).
- **Source**: <https://github.com/notofonts/noto-cjk/tree/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans>
- **License**: SIL Open Font License 1.1; full license and copyright notices shipped as `src/l4/format/pdf/sandbox/fonts/OFL-NotoSansCJK.txt`.
- **Modification**: None. Offline PDF text fallback; provenance and SHA256 recorded in the fonts README.

### 7. Noto Sans Mono

- **Copyright**: Copyright 2022 The Noto Project Authors (https://github.com/notofonts/latin-greek-cyrillic)
- **Source**: <https://github.com/google/fonts/tree/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosansmono>
- **License**: SIL Open Font License 1.1; full license and copyright shipped as `src/l4/format/pdf/sandbox/fonts/OFL-NotoSansMono.txt`.
- **Modification**: File renamed only; offline PDF code fallback. SHA256 recorded in the fonts README.



### 8. docx.js (local Word export)

- **Component**: `docx` v9.14.0, bundled into the extension's local export UI.
- **Source**: <https://github.com/dolanmiu/docx>
- **License**: MIT; copyright (c) 2016 Dolan.
- **License text**: The standard MIT permission/warranty terms are reproduced above in Section 1. Upstream license: <https://github.com/dolanmiu/docx/blob/9.14.0/LICENSE>.
- **Bundled dependencies**: `hash.js` (MIT), `jszip` (MIT/GPLv3 dual license; MIT option), `nanoid` (MIT), and their MIT-licensed transitive dependencies. Exact versions are locked in `package-lock.json`. JSZip and Pako license notices also appear above.

---

### Loominary Grok parser and source normalization

- Source: https://github.com/Laumss/loominary
- Revision: `5ae077b5bc010d80289a851621514397cf95422b`
- Adapted files: `src/grok.js`, `src/utils/fileParser/grokParser.js`, and helper subsets.
- Local files and modifications: `src/l1/parsers/grok/vendor/loominary/UPSTREAM.md`.

```text
MIT License

Copyright (c) 2025 Yalums

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### PDF Unicode mapping repair

- **pdf-lib 1.17.1**: Copyright (c) 2019 Andrew Dillon; MIT License. The complete license is shipped in `src/l4/format/pdf/typst/LICENSE-pdf-lib.txt`. Used to decode and rewrite ToUnicode dictionaries while preserving the page drawing and source ActualText.
- **DejaVu Sans Mono**: unmodified font from matplotlib commit `39b27ddaafe636f06776a2044b5df05d07648dc4`; Bitstream Vera / DejaVu license. Font provenance and hashes are in `src/l4/format/pdf/sandbox/fonts/README.md`, and the complete original license is shipped as `LICENSE-DejaVu.txt` in that directory.


### @xmldom/xmldom

- **Component**: @xmldom/xmldom v0.9.12
- **Homepage**: <https://github.com/xmldom/xmldom>
- **License**: MIT
- **Use**: Parse locally generated KaTeX MathML for native Word equation export.

```text
Copyright 2019 - present Christopher J. Brody and other contributors, as listed in: https://github.com/xmldom/xmldom/graphs/contributors
Copyright 2012 - 2017 @jindw <jindw@xidea.org> and other contributors, as listed in: https://github.com/jindw/xmldom/graphs/contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

```


### React, React DOM and Scheduler

- **Upstream**: <https://github.com/facebook/react>
- **License**: MIT
- **Use**: Locally bundled Options conversation-list rendering. Exact versions are locked in `package-lock.json`.

```text
MIT License

Copyright (c) Meta Platforms, Inc. and affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
