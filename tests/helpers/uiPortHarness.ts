import { type Page } from '@playwright/test';
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

// Only the UI is under test. Domain/Application/Runtime ports are deliberate mocks.
const mock = `
const h = globalThis.harness;
export const ScanConnectionError = h.ScanConnectionError ??= class extends Error { constructor(platform,message){super(message);this.platform=platform;} };
export const resourceDownloadOrigin = uri => {try {const u=new URL(uri);return u.origin==='https://cdn.sanity.io'&&!u.username&&!u.password?'https://cdn.sanity.io/*':undefined;}catch{return undefined;}};
export const hasResourceAccess = async () => {h.resourceAccessChecks=(h.resourceAccessChecks??0)+1;return h.resourceAccess ?? false;};
export const requestResourceAuthorization = async uri => {
 (h.resourceRequests??=[]).push([uri,navigator.userActivation.isActive]);
 if(h.resourcePermissionDenied)return false;
 h.resourceAccess=true;return true;
};
export const hasPlatformAccess = async platform => h[platform+'Access'] ?? (platform==='gemini');
export const preparePlatformTab = async () => {};
export const requestPlatformAuthorization = async platforms => {
 h.connectionRequests.push([platforms,navigator.userActivation.isActive]);
 const granted = h.holdPermission ? await new Promise(resolve=>h.finishPermission=resolve) : !h.permissionDenied;
 if(granted) for(const platform of platforms) h[platform+'Access']=true;
 return granted;
};
export const openPlatformSignIn = async (platform,active=true) => {(h.signInRequests??=[]).push({platform,active});await chrome.tabs.create({url:({gemini:'https://gemini.google.com/',chatgpt:'https://chatgpt.com/',claude:'https://claude.ai/',grok:'https://grok.com/'})[platform]});};
export const activatePlatformAccess = async platforms => {h.activatedPlatforms=platforms;return !h.activationFailure;};
export const findAuthorizedAccount = async platforms => {
 if(h.holdDiscovery) return new Promise(resolve=>h.finishDiscovery=resolve);
 for(const platform of platforms){
  if(!(h.tabs??[]).some(tab=>tab.url?.includes(platform==='gemini'?'gemini.google.com':platform==='chatgpt'?'chatgpt.com':platform==='grok'?'grok.com':'claude.ai')))continue;
  if(platform!=='gemini')h.discoveryCalls.push(platform);
  if(h.discoveryError)continue;
  const context=platform==='gemini'?h.contextReply?.accountContext:null;
  const account=platform==='gemini'?h.accounts.find(a=>a.id===context?.accountId&&context.providerId==='gemini'&&a.providerId==='gemini'&&a.providerAccountId!=='default'):h[platform+'Accounts']?.[0];
  if(account)return account.id;
 }
 return null;
};
export const observePlatformAccess = listener => {h.accessListener=listener;return ()=>{h.accessListener=null;};};
export const SOURCE_PLATFORMS = ['gemini', 'chatgpt', 'grok', 'claude'];
export const PLATFORM_HOSTS = {
 gemini:{pages:['https://gemini.google.com/*'],attachments:['https://*.googleusercontent.com/*']},
 chatgpt:{pages:['https://chatgpt.com/*','https://chat.openai.com/*'],attachments:['https://images.openai.com/*']},
 grok:{pages:['https://grok.com/*'],attachments:['https://assets.grok.com/*']},
 claude:{pages:['https://claude.ai/*'],attachments:[]}
};
export const DIRECT_WRITE_THRESHOLD = 20;
export const DISCORD_URL = 'https://discord.gg/e3FgrXUZ8f';
export const REVIEW_URL = 'https://chromewebstore.google.com/detail/gemini-exporter/ldpbiafkgjlaooeplkiooljccpalpkgf/reviews';
export const FEEDBACK_URL = 'https://tally.so/r/Y56ZBB?source=extension';
export const UNINSTALL_FEEDBACK_URL = 'https://tally.so/r/Y56ZBB?source=uninstall';
export const indexActivityTime = i => i.updatedAt === undefined ? i.activityAt : i.activityAt === undefined ? i.updatedAt : Math.max(i.updatedAt,i.activityAt);
export const compareConversationIndexes = (a,b) => (indexActivityTime(b) ?? -Infinity) - (indexActivityTime(a) ?? -Infinity);
export const resourceIssueKind = f => f.code === 'RESOURCE_SOURCE_EXPIRED' ? 'expired' : f.code === 'RESOURCE_ACCESS_RESTRICTED' ? 'restricted' : f.code === 'RESOURCE_PROCESSING_FAILED' ? 'processing' : 'download';
export const resourceFailureText = (f, locale) => locale === 'zh' ? '附件不可用' : 'Attachment unavailable';
export const getSettings = async () => ({...h.settings});
export const updateSettings = async patch => { h.patches.push(patch); if(h.holdSettingWrite)await new Promise(resolve=>h.finishSettingWrite=resolve); if(h.rejectSettingWrite)throw new Error('Settings write rejected'); Object.assign(h.settings,patch); };
export const isLiveSaveEffective = (s,d) => s.enabledDisk && s.exportDelivery==='folderWriter' && s.defaultFormat==='markdown' && d;
export const ensureV2Ready = async () => {if(h.failReady)throw new Error('Injected readiness failure');};
export const warmLocalFontCache = () => {h.events.push('fonts');return Promise.resolve();};
export const listAccounts = async () => h.accounts;
export const listIndexes = async id => {if(h.holdRefresh && h.exports.length) await new Promise(resolve=>h.finishRefresh=resolve); if(h.failRefresh && h.exports.length)throw new Error('Refresh rejected');if(h.failRead)throw new Error('Injected load failure');return h.indexes.filter(x=>x.key.accountId===id);};
export const listExportRecords = async id => h.records[id]||{};
export const getIndex = async key => h.indexes.find(x=>x.key.accountId===key.accountId&&x.key.conversationId===key.conversationId)||null;
export const getDetail = async () => ({ messages: [] });
export const getAccount = async id => h.accounts.find(a=>a.id===id)||null;
export const getOrCreateAccount = async (providerId, providerAccountId) => {
 h.events.push('create');
 const existing = h.accounts.find(a => a.providerId === providerId && a.providerAccountId === providerAccountId);
 if (existing) return existing;
 const account = { id: '11111111-1111-4111-8111-111111111111', providerId, providerAccountId };
 h.accounts.push(account);
 return account;
};
export const isAccountId = id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
export const conversationKey = (accountId, conversationId) => {
 if (!isAccountId(accountId) || !conversationId || conversationId !== conversationId.trim()) throw new TypeError('Invalid conversation key');
 return { accountId, conversationId };
};
export const runExport = async (request,options={}) => {h.exports.push(request);h.events.push('export');h.exportOptions=options;if(h.throwExport)throw new Error('Injected export failure');options.onProgress?.({current:1,total:request.keys.length,key:request.keys[0]});options.onConversationPrepared?.(request.keys[0]);
 if(h.holdExport) await new Promise(resolve=>h.finishExport=resolve);
 const aborted = !!options.signal?.aborted;
 const failed = aborted ? [] : h.failExport ? request.keys.slice(h.partial ? 1 : 0) : [];
 for(const key of failed) options.onItemUpdate?.({key,status:'failed',diagnostic:{key,stage:'export',code:'EXPORT_FAILED',severity:'error',issue:{code:'FILE_WRITE_FAILED',message:h.exportError ?? 'Injected export failure'},message:h.exportError ?? 'Injected export failure'}});
 const exported = aborted ? 0 : request.keys.length - failed.length;
 return {exported,partial:h.partial && exported > 0 ? 1 : 0,skipped:0,failed,aborted};};
export const resolveScanTarget = async () => {const failure=h.connectionFailure,source=h.source;if(h.holdConnectionCheck)await new Promise(resolve=>h.finishConnectionCheck=resolve);if(failure)throw new h.ScanConnectionError(failure, 'Open ChatGPT, log in and connect the selected account before scanning.');return source;};
export const sendTabMessage = (tabId,message,timeoutMs) => {
 h.tabRequests.push({tabId,message,timeoutMs});
 return chrome.tabs.sendMessage(tabId,message);
};
export const observeDomainChanges = listener => {h.domainListener=listener;return ()=>{h.domainListener=null;};};
export const scanAll = async (request,options) => {h.scans.push(request);if(h.failScan)throw new Error('Injected scan failure');h.scanSignal=options.signal;h.scanProgress=options.onProgress;h.scanDiagnostic=options.onDiagnostic;options.onProgress?.({pagesFetched:2,conversationsFetched:h.scanCount});if(h.holdScan)await new Promise(resolve=>h.finishScan=resolve);return h.scanResult || {status:'partial_limit',reason:'max_pages',pagesFetched:2,conversationsFetched:h.scanCount};};
export const clearLocalExportRecords = async id => {h.clears.push(['exports',id]);};
export const clearLocalScanRecords = async id => {h.clears.push(['scan',id]);h.indexes=h.indexes.filter(row=>row.key.accountId!==id);delete h.records[id];};
export const createSourceResourceContext = () => ({ retainParsed(){},retain(){},has(){return false;},release(){},releaseConversation(){},async acquire(){throw Error('No resource');} });
export const importOpenAI = async (file,id,progress,resources) => {h.imports.push(id);if(h.failImport)throw new Error('Invalid ZIP');progress?.(100);return h.openaiResult ?? {imported:2,skipped:0,missingAssets:0,status:'ok'};};
export const importTakeout = async (file,id,progress) => {h.imports.push(id);if(h.holdImport)await new Promise(resolve=>h.finishImport=resolve);if(h.failImport)throw new Error('Invalid ZIP');progress?.(100);return {imported:2,status:'partial'};};
export const getDirectoryHandle = async () => h.directory;
export const setDirectoryHandle = async handle => {h.directory=handle;};
export const clearDirectoryHandle = async () => {};
// Browser Runtime directory-capability v2 public ports, backed by the test's
// simulated permission handle; do not load the real controller in a UI test.
export const getStoredDirHandle = async () => h.directory;
export const saveStoredDirHandle = async handle => { h.directory=handle; return true; };
export const verifyDirPermission = async (handle,options={}) => {
 if(!handle) return false;
 if(options.allowRequest && globalThis.navigator?.userActivation?.isActive) return (await handle.requestPermission({mode:'readwrite'}))==='granted';
 return (await handle.queryPermission({mode:'readwrite'}))==='granted';
};
export const restoreSavedDirHandle = async () => {
 const stored=await getStoredDirHandle();
 const available=await verifyDirPermission(stored);
 h.activeDirectory=available?stored:null;
 h.pendingDirectory=available?null:stored;
 return h.activeDirectory;
};
export const getPendingPermissionHandle = () => h.pendingDirectory ?? null;
export const reauthorizeDirHandle = async () => {
 const handle=h.pendingDirectory ?? h.activeDirectory;
 if(!handle || await handle.requestPermission({mode:'readwrite'})!=='granted')return false;
 await saveStoredDirHandle(handle);h.activeDirectory=handle;h.pendingDirectory=null;return true;
};
export const requestDirHandle = async () => {
 const handle=await globalThis.showDirectoryPicker({mode:'readwrite'});
 if(await handle.queryPermission({mode:'readwrite'})!=='granted')throw Error('Directory permission not granted');
 await saveStoredDirHandle(handle);h.activeDirectory=handle;h.pendingDirectory=null;return handle;
};
export const getDirHandle = () => h.activeDirectory ?? null;
export const setDirHandle = handle => { h.activeDirectory=handle;h.pendingDirectory=null; };
export const registerCleanup = fn => {
 h.cleanups.push(fn);
 return () => { const index=h.cleanups.indexOf(fn);if(index>=0)h.cleanups.splice(index,1); };
};
export const isVersionGreater = (a,b) => {
 const one = a.replace(/^v/i,'').split('.').map(Number);
 const two = b.replace(/^v/i,'').split('.').map(Number);
 for(let i=0;i<Math.max(one.length,two.length);i++){
  if((one[i]??0)>(two[i]??0)) return true;
  if((one[i]??0)<(two[i]??0)) return false;
 }
 return false;
};
`;
export const A = '11111111-1111-4111-8111-111111111111';
export const B = '22222222-2222-4222-8222-222222222222';
export async function mount(page: Page, kind: 'options' | 'popup' | 'badge', patch: Record<string, unknown> = {}, query = '') {
    page.setDefaultTimeout(5000);
    const root = process.cwd();
    const bundle = await build({ ...(kind === 'badge' ? { stdin: { contents: `import { BadgeView } from './src/ui/badge/badgeView.ts'; globalThis.badge = BadgeView; BadgeView.ensureBadge();`, resolveDir: root } } : { stdin: { contents: `import './src/ui/${kind}/${kind}.ts'; import * as tour from './src/ui/guidance/tourGuide.ts'; import * as settings from './src/ui/shared/settings.ts'; globalThis.testUi = {tour:{...tour.TourGuide,consumeTourIntent:tour.consumeTourIntent},settings};`, resolveDir: root, loader: 'ts' } }), bundle: true, write: false, metafile: true, format: 'iife', plugins: [{ name: 'ui-port-mocks', setup(build) {
        build.onResolve({ filter: /accountContext\.js$/ }, args => ({path:args.path,namespace:'account-mock'}));
        build.onLoad({filter:/.*/,namespace:'account-mock'},()=>({contents:`export const getAccountContext=()=>({accountId:globalThis.harness.source,providerId:'gemini'});export const resolveCurrentAccount=async()=>getAccountContext();`,loader:'js'}));
        build.onResolve({ filter: /^\./ }, args => {
            const owner = path.relative(path.join(root, 'src'), path.resolve(args.resolveDir, args.path)).replace(/\\/g, '/');
            // Every non-UI source owner is external to the isolated UI unit.
            // Mock its frozen public port even when indirectly imported by UI.
            const port = /^(?:l1|l2|l3a|l3b|l4|application|migration|runtime|shared)\//.test(owner);
            if (port) return { path: args.path, namespace: 'ui-mock' };
        });
        build.onLoad({ filter: /.*/, namespace: 'ui-mock' }, () => ({ contents: mock, loader: 'js' }));
    } }] });
    const rootSource = root.replace(/\\/g, '/') + '/src/';
    for (const input of Object.keys(bundle.metafile?.inputs ?? {})) {
        const normalized = input.replace(/\\/g, '/');
        const owner = normalized.startsWith('src/') ? normalized.slice(4)
            : normalized.startsWith(rootSource) ? normalized.slice(rootSource.length) : null;
        if (owner !== null && !owner.startsWith('ui/')) {
            throw new Error(`UI mock harness bundled non-UI production owner: ${input}`);
        }
    }
    await page.route('https://ui.test/**', route => route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, `src/ui/${kind === 'badge' ? 'options' : kind}/${kind === 'badge' ? 'options' : kind}.html`), 'utf8').replace(/<script[^>]*><\/script>/g, '').replace(/<link[^>]*>/g, '') }));
    await page.addInitScript(({ A, B, patch }) => {
        const w = window as any;
        w.harness = { settings: {defaultFormat:'markdown',includeAssets:true,skipExported:true,enabledDisk:true,developerMode:false,language:'en',lastSeenFeatureVersion:'1.8.1'},
            accounts:[{id:A,providerId:'gemini',providerAccountId:'A'},{id:B,providerId:'gemini',providerAccountId:'B'}],
            indexes:[{key:{accountId:A,conversationId:'a'},title:'<img src=x onerror=alert(1)>',updatedAt:5},{key:{accountId:B,conversationId:'b'},title:'B chat',updatedAt:5}],records:{},source:A,scanCount:150,
            patches:[],events:[],messages:[],tabRequests:[],connectionRequests:[],discoveryCalls:[],cleanups:[],exports:[],scans:[],clears:[],imports:[],directory:null,...patch };
        w.harness.settings = {defaultFormat:'markdown',includeAssets:true,skipExported:true,enabledDisk:true,developerMode:false,language:'en',lastSeenFeatureVersion:'1.8.1',...(patch.settings as object ?? {})};
        // Most isolated UI cases model a new Options view, whose default is browser download.
        // Tests for existing Live Save installations explicitly request folderWriter.
        if (!Object.hasOwn(w.harness.settings, 'exportDelivery'))
            w.harness.settings.exportDelivery = 'browserDownload';
        const directory = () => ({ name: w.harness.directoryName || 'Chosen folder', queryPermission: async () => w.harness.permission || 'granted', requestPermission: async () => w.harness.permission || 'granted' });
        if (w.harness.directoryName) w.harness.directory = directory();
        w.showDirectoryPicker = async () => { w.harness.events.push('picker'); if (w.harness.cancelPicker) throw new DOMException('Picker cancelled', 'AbortError'); return directory(); };
        const listeners = new Set<(...args: unknown[]) => void>();
        const session = { openOptionsAccountId: w.harness.initialOpenOptionsAccountId ?? null };
        w.harness.fireSettingsChange = (area = 'local', key = 'gemini_exporter_v2_settings') => { for (const listener of listeners) listener({[key]:{newValue:w.harness.settings}}, area); };
        const messageListeners = new Set<(...args: unknown[]) => void>();
        w.harness.fireRuntimeMessage = (message: unknown, sender = { id: 'ui-test-extension' }) => { for (const listener of messageListeners) listener(message, sender); };
        w.chrome = { runtime:{id:'ui-test-extension',getURL:(path: string)=>'chrome-extension://ui-test-extension/'+path,onMessage:{addListener:(listener: (...args: unknown[]) => void)=>messageListeners.add(listener),removeListener:(listener: (...args: unknown[]) => void)=>messageListeners.delete(listener)},getManifest:()=>({version:w.harness.manifestVersion||'1.8.1'}),openOptionsPage:async()=>w.harness.events.push('options'),sendMessage:async(message:any)=>{w.harness.messages.push(message);if(message.action==='getLocalIndexCount'){w.harness.countRequests=(w.harness.countRequests||0)+1;if(w.harness.holdCount)return new Promise(resolve=>w.harness.finishCount=resolve);return {ok:true,count:message.accountId===A?9:0};}w.harness.events.push(message.action);return {ok:true};}},
            tabs:{query:async(options: {url?: string|string[]})=>{
                const tabs=w.harness.tabs??[{id:1,active:true,url:'https://gemini.google.com/app/a'}];
                if(!options?.url)return tabs;
                const patterns=Array.isArray(options.url)?options.url:[options.url];
                return tabs.filter((tab:{url?:string})=>!tab.url||patterns.some(pattern=>tab.url?.startsWith(pattern.replace('*',''))));
            },sendMessage:async()=>{w.harness.events.push('context');if ('contextReply' in w.harness) return w.harness.contextReply;return w.harness.noContext?{ok:false}:{ok:true,accountContext:{accountId:A,providerId:'gemini'},conversationId:'a'};},create:async(options: { url?: string })=>{w.harness.events.push('open');(w.harness.openedUrls??=[]).push(options?.url);},update:async()=>{w.harness.events.push('activate');},reload:async()=>{w.harness.events.push('reload');}},
            storage:{
                session:{
                    get:async()=>({...session}),
                    set:async(patch: {openOptionsAccountId:string|null})=>{
                        const oldValue=session.openOptionsAccountId;
                        session.openOptionsAccountId=patch.openOptionsAccountId;
                        for(const listener of listeners)listener({openOptionsAccountId:{oldValue,newValue:patch.openOptionsAccountId}},'session');
                    },
                    remove:async()=>{
                        const oldValue=session.openOptionsAccountId;
                        session.openOptionsAccountId=null;
                        for(const listener of listeners)listener({openOptionsAccountId:{oldValue,newValue:null}},'session');
                    },
                },
                onChanged:{addListener:(listener: (...args: unknown[]) => void)=>listeners.add(listener),removeListener:(listener: (...args: unknown[]) => void)=>listeners.delete(listener)}
            }};
        w.harness.openOptionsFor = (id: string | null) => w.chrome.storage.session.set({openOptionsAccountId:id});
    }, { A, B, patch });
    await page.goto('https://ui.test/' + query);
    // This isolated UI harness strips the real HTML scripts, including themeBootstrap.js.
    // Release its initial-paint guard here; the actual extension E2E exercises the bootstrap.
    await page.evaluate(() => {
        document.documentElement.removeAttribute('data-theme-unready');
        document.documentElement.removeAttribute('data-theme-bootstrap');
    });
    // Badge tests reuse Options HTML as a host fixture; Gemini's page has no theme bootstrap.
    if (kind === 'badge') await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
    await page.addStyleTag({ content: fs.readFileSync(path.join(root, 'src/ui/guidance/tourGuide.css'), 'utf8') });
    await page.addStyleTag({ content: fs.readFileSync(path.join(root, 'src/ui/shared/theme.css'), 'utf8') });
    if (kind === 'badge') {
        // Production injects this through manifest.json; the isolated UI harness must do the same.
        await page.addStyleTag({ content: fs.readFileSync(path.join(root, 'src/ui/badge/content.css'), 'utf8') });
    }
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
}
export const read = (page: Page, key: string) => page.evaluate(key => (window as any).harness[key], key);

