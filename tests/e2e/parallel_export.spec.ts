import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect, seedRegistryAccounts } from './fixtures';
import { accountId, openOptions } from './uiFixture';
import type { ExportResult } from '../../src/application/export/types';
import type { ConversationKey } from '../../src/l2/conversationKey';

for (const delivery of ['browserDownload','folderWriter'] as const) {
test(`${delivery}: source preparation stays independent and final documents resolve all local attachments`, async ({context,extensionId}) => {
    await seedRegistryAccounts(context);
    const page = await openOptions(context, extensionId);
    const bundle = await build({stdin:{resolveDir:path.resolve(__dirname,'../..'),loader:'ts',contents:`
        import { runExport } from './src/application/export/runExport.ts';
        import { createSourceResourceContext } from './src/l1/resources/sourceResources.ts';
        globalThis.parallelExportProbe = {runExport,createSourceResourceContext};
    `},bundle:true,write:false,format:'iife',platform:'browser',conditions:['worker','browser'],logLevel:'silent'});
    await page.evaluate(bundle.outputFiles[0].text);
    const downloads: import('@playwright/test').Download[] = [];
    page.on('download', file => downloads.push(file));
    await page.evaluate(async ({accountId,delivery}) => {
        const storage = Reflect.get(window, 'uiFixture');
        const api = Reflect.get(window, 'parallelExportProbe');
        const resources = api.createSourceResourceContext();
        if (delivery === 'folderWriter') await storage.setDirectoryHandle(await navigator.storage.getDirectory());
        let release = (): void => {};
        const ready = new Promise<void>(resolve => { release = resolve; });
        Reflect.set(window, 'releaseParallelAttachments', release);
        const state: {receipts:string[];prepared:number;downloads:number[];settled:boolean;result:ExportResult|null} =
            {receipts:[],prepared:0,downloads:[],settled:false,result:null};
        Reflect.set(window, 'parallelState', state);
        const keys: ConversationKey[] = [];
        for (const id of ['first','second','third','fourth','fifth']) {
            const key = {accountId,conversationId:id};
            keys.push(key);
            await storage.ingestDetail(accountId,id,{savedAt:100,quality:{status:'complete'},assets:[
                {id:'image',kind:'image',name:'photo.png',mediaType:'image/png'},
                {id:'file',kind:'file',name:'report.md',mediaType:'text/markdown'},
            ],messages:[
                {role:'user',content:[{type:'paragraph',children:[{type:'text',text:`Question ${id}`}]}]},
                {role:'assistant',content:[{type:'paragraph',children:[{type:'text',text:`Answer ${id}`}]},
                    {type:'image',assetId:'image'},{type:'file',assetId:'file'}]},
            ]},{title:id,titleSource:'provider',updatedAt:100});
            resources.retain(key,'image',async()=>{
                await ready;
                return {bytes:Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='),c=>c.charCodeAt(0)),mediaType:'image/png'};
            });
            resources.retain(key,'file',async()=>{ await ready; return {bytes:new TextEncoder().encode(`Report ${id}`),mediaType:'text/markdown'}; });
        }
        api.runExport({keys,format:'markdown',delivery,includeAssets:true,skipUnchanged:false},{
            importedResources:resources,
            onConversationPrepared:()=>state.prepared++,
            onBodyDelivered:(key:ConversationKey)=>state.receipts.push(key.conversationId),
            onResourceProgress:(value:{downloaded:number})=>state.downloads.push(value.downloaded),
        }).then((result:ExportResult)=>{state.result=result;state.settled=true;resources.release();});
    }, {accountId,delivery});
    try {
        await expect.poll(()=>page.evaluate(()=>Reflect.get(window,'parallelState').prepared)).toBe(5);
        if (delivery === 'folderWriter') await expect.poll(()=>page.evaluate(()=>Reflect.get(window,'parallelState').receipts.length)).toBe(5);
        const blocked = await page.evaluate(()=>Reflect.get(window,'parallelState'));
        expect(blocked.settled).toBe(false);
        expect(blocked.downloads.at(-1)).toBe(0);
        expect(blocked.receipts).toHaveLength(delivery === 'folderWriter' ? 5 : 0);
        expect(downloads).toHaveLength(0);
        const records = await page.evaluate(accountId=>Reflect.get(window,'uiFixture').listExportRecords(accountId),accountId);
        expect(records).toEqual({});
        await page.evaluate(()=>Reflect.get(window,'releaseParallelAttachments')());
        await expect.poll(()=>page.evaluate(()=>Reflect.get(window,'parallelState').settled)).toBe(true);
        expect(downloads).toHaveLength(delivery === 'browserDownload' ? 1 : 0);
        const bodyDownload = downloads[0];
        const JSZip = require(path.resolve(__dirname,'../../lib/jszip.min.js'));
        let documents: {name:string;body:string}[];
        if (bodyDownload) {
            const bodyPath = await bodyDownload.path();
            if (!bodyPath) throw new Error('Missing document download');
            const zip = await JSZip.loadAsync(await readFile(bodyPath));
            const paths = Object.keys(zip.files).filter(name=>name.endsWith('.md') && !name.includes('/'));
            documents = await Promise.all(paths.map(async name=>({name,body:await zip.file(name).async('string')})));
        } else documents = await page.evaluate(async()=>{
            const root = await navigator.storage.getDirectory();
            const files: {name:string;body:string}[] = [];
            for await (const [name,handle] of Reflect.get(root,'entries').call(root))
                if (handle.kind==='file' && name.endsWith('.md')) files.push({name,body:await(await handle.getFile()).text()});
            return files;
        });
        expect(documents).toHaveLength(5);
        const referencedPaths: string[] = [];
        for (const {body} of documents) {
            expect(body).toContain('Answer');
            for (const match of body.matchAll(/!?\[[^\]]*\]\(((?:assets|files)\/[^)]+)\)/g)) referencedPaths.push(decodeURIComponent(match[1]));
        }
        expect(referencedPaths).toHaveLength(10);
        if (bodyDownload) {
            const attachmentPath = await bodyDownload.path();
            if (!attachmentPath) throw new Error('Missing combined download');
            const attachments = await JSZip.loadAsync(await readFile(attachmentPath));
            for (const name of referencedPaths) {
                expect(attachments.file(name),name).toBeTruthy();
                expect((await attachments.file(name).async('uint8array')).length).toBeGreaterThan(0);
            }
        } else {
            const sizes = await page.evaluate(async paths=>{
                const root = await navigator.storage.getDirectory();
                return Promise.all(paths.map(async name=>{
                    const segments = name.split('/');
                    const file = segments.pop();
                    if (!file) throw new Error('Empty attachment filename');
                    let folder = root;
                    for (const directory of segments) folder = await folder.getDirectoryHandle(directory);
                    return (await(await folder.getFileHandle(file)).getFile()).size;
                }));
            },referencedPaths);
            for (const size of sizes) expect(size).toBeGreaterThan(0);
        }
        expect(new Set(referencedPaths).size).toBe(10);
        await expect.poll(()=>page.evaluate(()=>Reflect.get(window,'parallelState').settled)).toBe(true);
        expect(await page.evaluate(()=>Reflect.get(window,'parallelState').result)).toMatchObject({exported:5,partial:0,aborted:false});
    } finally {
        await page.evaluate(()=>Reflect.get(window,'releaseParallelAttachments')());
    }
});

}
