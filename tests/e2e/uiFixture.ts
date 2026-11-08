import { build } from 'esbuild';
import path from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import type { GlobalSettings } from '../../src/application/settings/index.ts';
import type { DomainConversationIndex } from '../../src/l2/conversationIndex.ts';
import type { ExportRecord } from '../../src/application/export/types.ts';
export const accountId = '10000000-0000-4000-8000-000000000001';
let bundle: Promise<string> | undefined;
export async function uiProbeBundle() {
    bundle ??= build({stdin:{resolveDir:path.resolve(__dirname,'../..'),loader:'ts',contents:`
        import * as storage from './src/l3a/storageService.ts';
        import * as domain from './src/l2/ingestion.ts';
        import * as settings from './src/application/settings/index.ts';
        import { readConversation } from './src/l2/readConversation.ts';
        import { runLiveSave } from './src/runtime/background/liveSaveHandler.ts';
        globalThis.uiFixture = {...storage,...domain,...settings,readConversation,runLiveSave};
    `},bundle:true,write:false,format:'iife',platform:'browser',conditions:['worker','browser'],logLevel:'silent'}).then(x=>x.outputFiles[0].text);
    return bundle;
}
export async function exposeUIStorage(page: Page) {
    await page.evaluate(await uiProbeBundle());
}
export async function openOptions(context: BrowserContext,extensionId: string) {
    const page=await context.newPage(); await page.goto(`chrome-extension://${extensionId}/src/ui/options/options.html`);
    await exposeUIStorage(page);await page.evaluate(async()=>Reflect.get(globalThis,'uiFixture').updateSettings({language:'en',lastSeenFeatureVersion:'999.0.0'}));
    await page.reload();await exposeUIStorage(page);await expect(page.locator('body')).toHaveAttribute('data-busy','false');return page;
}
export async function seedConversations(page:Page,rows: readonly ({id:string;body?:string;question?:string;missingAsset?:boolean}&Partial<Omit<DomainConversationIndex,'key'>>)[],records:Record<string,ExportRecord>={}) {
    await page.evaluate(async({rows,records,accountId})=>{
        const api=Reflect.get(globalThis,'uiFixture');
        for(const row of rows) {
            await api.ingestDetail(accountId,row.id,{savedAt:100,quality:{status:'complete'},assets:row.missingAsset?[{id:'image',kind:'image',sourceUri:'photo.png',name:'photo.png'}]:[],messages:[
                {role:'user',content:[{type:'paragraph',children:[{type:'text',text:row.question??`Question ${row.id}`}]}]},
                {role:'assistant',content:[{type:'paragraph',children:[{type:'text',text:row.body??`Answer ${row.id}`}]},...(row.missingAsset?[{type:'image',assetId:'image'}]:[])]}
            ]},{title:row.title??row.id,titleSource:row.titleSource??'provider',updatedAt:row.updatedAt??100});
        }
        for(const [conversationId,record]of Object.entries(records))await api.putExportRecord({accountId,conversationId},record);
    },{rows,records,accountId});
    await page.reload();await exposeUIStorage(page);await expect(page.locator('#list .item')).toHaveCount(rows.length);
}
export async function storedSettings(page:Page):Promise<GlobalSettings> {return page.evaluate(()=>Reflect.get(globalThis,'uiFixture').getSettings());}
export async function openPopup(context:BrowserContext,extensionId:string,conversationId='a') {
    const page=await context.newPage();await page.addInitScript(({accountId,conversationId})=>{
        Object.defineProperty(chrome.tabs,'query',{configurable:true,value:async()=>[{id:999,active:true,url:`https://gemini.google.com/app/${conversationId}`}]});
        Object.defineProperty(chrome.tabs,'sendMessage',{configurable:true,value:(_id:number,_msg:unknown,cb:(v:unknown)=>void)=>{
            cb({ok:true,accountContext:{accountId,providerId:'gemini'},conversationId});
        }});
    },{accountId,conversationId});await page.goto(`chrome-extension://${extensionId}/src/ui/popup/popup.html`);await exposeUIStorage(page);return page;
}
