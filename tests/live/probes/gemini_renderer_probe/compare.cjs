#!/usr/bin/env node
// Run from the main checkout with its installed dependencies and ts_register.
const fs = require('node:fs');
const path = require('node:path');
const main = process.cwd();
const artifactRoot = process.argv[2];
const {fromMarkdown} = require(path.join(main,'node_modules/mdast-util-from-markdown'));
const {gfm} = require(path.join(main,'node_modules/micromark-extension-gfm'));
const {gfmFromMarkdown} = require(path.join(main,'node_modules/mdast-util-gfm'));
const {math} = require(path.join(main,'node_modules/micromark-extension-math'));
const {mathFromMarkdown} = require(path.join(main,'node_modules/mdast-util-math'));
const {parseMarkdownToBlocks} = require(path.join(main,'src/core/export/canonical/markdown/parseMarkdown.ts'));
function compact(node) {
  if (Array.isArray(node)) return node.map(compact);
  if (!node || typeof node !== 'object') return node;
  const x={type:node.type || node.kind};
  for(const k of ['value','text','source','latex','display','align']) if(node[k]!==undefined)x[k]=node[k];
  if(node.children)x.children=compact(node.children);
  if(node.rows)x.rows=compact(node.rows);
  if(node.cells)x.cells=compact(node.cells);
  if(node.header)x.header=compact(node.header);
  if(node.items)x.items=compact(node.items);
  if(node.blocks)x.blocks=compact(node.blocks);
  return x;
}
for (const caseName of fs.readdirSync(artifactRoot).filter(x=>x.startsWith('case-'))) {
  const dir=path.join(artifactRoot,caseName), file=path.join(dir,'raw.md');
  if(!fs.existsSync(file))continue;
  const source=fs.readFileSync(file,'utf8');
  const mdast=fromMarkdown(source,{extensions:[gfm(),math()],mdastExtensions:[gfmFromMarkdown(),mathFromMarkdown()]});
  let next=0;
  const canonical=parseMarkdownToBlocks(source,'probe',{nextBlockId:()=>`probe-${++next}`,diagnostics:[]});
  fs.writeFileSync(path.join(dir,'current-parser.json'),JSON.stringify({mdast:compact(mdast),canonical:compact(canonical)},null,2));
  console.log(caseName, JSON.stringify(compact(mdast)).slice(0,350));
}
