import definePlugin from "@utils/types";
import { findByPropsLazy, findStore, findStoreLazy } from "@webpack";
import { FluxDispatcher, RestAPI } from "@webpack/common";

import { settings } from "./settings";
import { getApiEndpoint, getCdnHost, getGatewayEndpoint, getMediaProxyEndpoint } from "./utils";

// ===== Guild order sync =====================================================
// Polls Harmony's stored guild_folders and applies them locally, and pushes
// local re-ordering back up. Guards against feeding not-yet-loaded guild IDs
// into SortedGuildStore, which produces state that can't be re-serialized to
// protobuf later (the uint64/WS-4002 crash loop).

const GuildActionCreators = findByPropsLazy("moveById", "createGuildFolderLocal");
const GuildStore = findByPropsLazy("getGuild", "getGuilds");

interface HarmonyGuildFolder {
    id: string | null;
    name: string | null;
    guild_ids: string[];
    color: number | null;
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let lastSignature: string | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pollingStarted = false;

const POLL_INTERVAL = 45 * 1000;

function toHarmonyFolders(): HarmonyGuildFolder[] {
    const SortedGuildStore = findStore("SortedGuildStore");
    const folders = SortedGuildStore.getGuildFolders();

    return folders.map((f: any) => ({
        id: f.folderId ?? null,
        name: f.folderName ?? null,
        guild_ids: f.guildIds,
        color: f.folderColor ?? null
    }));
}

async function pushGuildOrder() {
    try {
        const guild_folders = toHarmonyFolders();
        await RestAPI.patch({
            url: "/users/@me/settings",
            body: { guild_folders }
        });
        lastSignature = JSON.stringify(guild_folders);
    } catch (e) {
        console.error("[ChangeEndpoint] Failed to push guild order", e);
    }
}

function schedulePush() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(pushGuildOrder, 1500);
}

async function applyGuildOrder(folders: HarmonyGuildFolder[]) {
    const totalIds = folders.reduce((n, f) => n + f.guild_ids.filter(Boolean).length, 0);
    const loadedIds = folders.reduce(
        (n, f) => n + f.guild_ids.filter(id => id && GuildStore.getGuild(id)).length,
        0
    );

    // guilds are still trickling in after CONNECTION_OPEN - don't drag guilds
    // around (or feed unknown ids into SortedGuildStore) until they're actually
    // present, or we end up writing broken state that fails to serialize later
    if (loadedIds < totalIds) {
        console.log(`[ChangeEndpoint] Guilds not fully loaded yet (${loadedIds}/${totalIds}), deferring order apply`);
        return false;
    }

    let anchor: string | null = null;

    for (const folder of folders) {
        const ids = folder.guild_ids.filter(Boolean);
        if (!ids.length) continue;

        if (ids.length > 1) {
            GuildActionCreators.createGuildFolderLocal(ids, folder.name ?? null);
        } else if (anchor) {
            GuildActionCreators.moveById(ids[0], anchor, true, false);
        }
        // if anchor is null this is the first entry - it's already at the top by default

        anchor = ids[ids.length - 1];
    }

    return true;
}

async function pollSavedGuildOrder() {
    try {
        const res = await RestAPI.get({ url: "/users/@me/settings" });
        const folders: HarmonyGuildFolder[] = res?.body?.guild_folders ?? [];
        const signature = JSON.stringify(folders);

        if (folders.length && signature !== lastSignature) {
            console.log("[ChangeEndpoint] Applying updated guild order from server", folders);
            const applied = await applyGuildOrder(folders);
            if (applied) lastSignature = signature;
        }
    } catch (e) {
        console.error("[ChangeEndpoint] Failed to poll saved guild order", e);
    } finally {
        pollTimer = setTimeout(pollSavedGuildOrder, POLL_INTERVAL);
    }
}

function startGuildOrderSync() {
    if (pollingStarted) return;
    pollingStarted = true;

    pollSavedGuildOrder();

    FluxDispatcher.subscribe("GUILD_MOVE_BY_ID", schedulePush);
    FluxDispatcher.subscribe("GUILD_FOLDER_CREATE_LOCAL", schedulePush);
    FluxDispatcher.subscribe("GUILD_FOLDER_EDIT_LOCAL", schedulePush);
    FluxDispatcher.subscribe("GUILD_FOLDER_DELETE_LOCAL", schedulePush);
}

function stopGuildOrderSync() {
    pollingStarted = false;

    if (pollTimer) clearTimeout(pollTimer);

    FluxDispatcher.unsubscribe("GUILD_MOVE_BY_ID", schedulePush);
    FluxDispatcher.unsubscribe("GUILD_FOLDER_CREATE_LOCAL", schedulePush);
    FluxDispatcher.unsubscribe("GUILD_FOLDER_EDIT_LOCAL", schedulePush);
    FluxDispatcher.unsubscribe("GUILD_FOLDER_DELETE_LOCAL", schedulePush);
    if (debounceTimer) clearTimeout(debounceTimer);
}

const VoiceActions = findByPropsLazy("selectVoiceChannel");
const RTCConnectionStore = findStoreLazy("RTCConnectionStore");
const VoiceStateStore = findStoreLazy("VoiceStateStore");
const UserStore = findStoreLazy("UserStore");

const DEAD_STATES = new Set(["DISCONNECTED", "RTC_DISCONNECTED", "NO_ROUTE"]);
const GRACE_MS = 5000;
const REJOIN_DELAY_MS = 1000;

let graceTimer: ReturnType<typeof setTimeout> | null = null;
let recovering = false;

function isPhantomVoiceState(): { channelId: string; } | null {
    const me = UserStore.getCurrentUser();
    if (!me) return null;

    // What the client's local voice-state cache (fed by gateway dispatches)
    // believes about us right now.
    const myVoiceState = VoiceStateStore.getVoiceStateForUser(me.id);
    if (!myVoiceState?.channelId) return null; // client doesn't think we're in a channel - nothing to do

    // What the actual underlying media/RTC connection is doing, independent
    // of the gateway-dispatched voice state above.
    const rtcState: string = RTCConnectionStore.getState();
    const rtcConnected: boolean = RTCConnectionStore.isConnected();

    if (!rtcConnected && DEAD_STATES.has(rtcState)) {
        return { channelId: myVoiceState.channelId };
    }
    return null;
}

function attemptVoiceRecovery() {
    if (recovering) return;
    const phantom = isPhantomVoiceState();
    if (!phantom) return;

    recovering = true;
    const { channelId } = phantom;
    console.log(
        `[ChangeEndpoint] Voice state looks phantom (client thinks it's in ${channelId}, ` +
        `RTC state is ${RTCConnectionStore.getState()}) - forcing a real rejoin`
    );

    // Force a real leave first (clears the client's local "I'm connected"
    // belief), then rejoin the same channel a moment later so it actually
    // goes through the connect flow instead of no-op'ing.
    VoiceActions.selectVoiceChannel(null);
    setTimeout(() => {
        VoiceActions.selectVoiceChannel(channelId);
        recovering = false;
    }, REJOIN_DELAY_MS);
}

function onVoicePhantomCheckTrigger() {
    if (graceTimer) clearTimeout(graceTimer);
    graceTimer = setTimeout(attemptVoiceRecovery, GRACE_MS);
}

function startVoicePhantomFix() {
    FluxDispatcher.subscribe("CONNECTION_OPEN", onVoicePhantomCheckTrigger);
    FluxDispatcher.subscribe("VOICE_CONNECTION_STATUS", onVoicePhantomCheckTrigger);
}

function stopVoicePhantomFix() {
    FluxDispatcher.unsubscribe("CONNECTION_OPEN", onVoicePhantomCheckTrigger);
    FluxDispatcher.unsubscribe("VOICE_CONNECTION_STATUS", onVoicePhantomCheckTrigger);
    if (graceTimer) clearTimeout(graceTimer);
    recovering = false;
}

// ===== Plugin ================================================================

export default definePlugin({
    name: "ChangeEndpoint",
    description: "Redirects Discord API/CDN/Gateway traffic to a Spacebar backend (Harmony by default, or a custom one)",
    authors: [],
    required: true,
    settings,

    start() {
        startGuildOrderSync();
        startVoicePhantomFix();

        if (typeof DiscordNative === "undefined") return;

        const originalQuery = navigator.permissions.query.bind(navigator.permissions);
        navigator.permissions.query = (descriptor: PermissionDescriptor) => {
            if (descriptor.name === "camera" || descriptor.name === "microphone") {
                return Promise.resolve({
                    state: "granted",
                    onchange: null,
                    addEventListener() {},
                    removeEventListener() {},
                    dispatchEvent() { return true; }
                } as unknown as PermissionStatus);
            }
            return originalQuery(descriptor);
        };
    },

    stop() {
        stopGuildOrderSync();
        stopVoicePhantomFix();
    },

    patches: [
        {
            find: "window.GLOBAL_ENV.API_ENDPOINT",
            all: true,
            replacement: {
                match: /window\.GLOBAL_ENV\.API_ENDPOINT/g,
                replace: () => JSON.stringify(getApiEndpoint())
            }
        },
        {
            find: "window.GLOBAL_ENV.CDN_HOST",
            all: true,
            replacement: {
                match: /window\.GLOBAL_ENV\.CDN_HOST/g,
                replace: () => JSON.stringify(getCdnHost())
            }
        },
        {
            find: "window.GLOBAL_ENV.GATEWAY_ENDPOINT",
            all: true,
            replacement: {
                match: /window\.GLOBAL_ENV\.GATEWAY_ENDPOINT/g,
                replace: () => JSON.stringify(getGatewayEndpoint())
            }
        },
        {
            find: "window.GLOBAL_ENV.MEDIA_PROXY_ENDPOINT",
            all: true,
            replacement: {
                match: /window\.GLOBAL_ENV\.MEDIA_PROXY_ENDPOINT/g,
                replace: () => JSON.stringify(getMediaProxyEndpoint())
            }
        },
        {
            find: "isDiscordGatewayPlaintextSet(){return!1}",
            replacement: {
                match: /isDiscordGatewayPlaintextSet\(\)\{return!1\}/,
                replace: "isDiscordGatewayPlaintextSet(){return!0}"
            }
        },
        {
            find: "Error getting provider for API request:",
            replacement: {
                match: /function (\w+)\(\)\{try\{return \w+\.getConfig\(\{location:"gif_picker"\}\)\.provider\}catch\(\w+\)\{return \w+\.warn\("Error getting provider for API request:",\w+\),"tenor"\}\}/,
                replace: 'function $1(){return"klipy"}'
            }
        },
        {
            find: "}=window.GLOBAL_ENV",
            all: true,
            replacement: {
                match: /\{([\w:,]+)\}=window\.GLOBAL_ENV/g,
                replace: (fullMatch: string, pairsStr: string) => {
                    const overrides: Record<string, string> = {
                        API_ENDPOINT: getApiEndpoint(),
                        CDN_HOST: getCdnHost(),
                        GATEWAY_ENDPOINT: getGatewayEndpoint(),
                        MEDIA_PROXY_ENDPOINT: getMediaProxyEndpoint()
                    };
                    const keysPresent = pairsStr.split(",")
                        .map(pair => pair.split(":")[0])
                        .filter(key => overrides[key]);

                    if (keysPresent.length === 0) return fullMatch;

                    const overrideObjLiteral = "{" +
                        keysPresent.map(key => `${key}:${JSON.stringify(overrides[key])}`).join(",") +
                        "}";

                    return fullMatch.replace(
                        "window.GLOBAL_ENV",
                        `Object.assign({},window.GLOBAL_ENV,${overrideObjLiteral})`
                    );
                }
            }
        },
        {
            find: "avatar_description:",
            all: true,
            replacement: {
                match: /avatar:(\w+),avatar_description:\w+,avatar_id:/g,
                replace: "avatar:$1,avatar_id:"
            }
        },
        {
            find: "getPremiumTypeOverride(){return o.premiumTypeOverride}",
            replacement: {
                match: /getPremiumTypeOverride\(\)\{return o\.premiumTypeOverride\}/,
                replace: "getPremiumTypeOverride(){return 2}"
            }
        },
        {
            find: "features.has(a.GuildFeatures.ENHANCED_ROLE_COLORS)",
            all: true,
            replacement: {
                match: /\w+\.features\.has\(\w+\.GuildFeatures\.ENHANCED_ROLE_COLORS\)/g,
                replace: "true"
            }
        },
        {
            find: "_doResumeOrIdentify(){",
            replacement: {
                match: /_doResumeOrIdentify\(\)\{[^}]*?\?this\._doResume\(\):this\._doIdentify\(\)/,
                replace: "_doResumeOrIdentify(){this._doIdentify()"
            }
        },
        {
            find: "c.preferred_region=",
            replacement: {
                match: /\(c\.preferred_region=(\w+),c\.preferred_regions=\w+\)/,
                replace: "(c.preferred_region=$1)"
            }
        },
        {
            find: "maxWidth:i,maxHeight:r",
            all: true,
            replacement: {
                match: /\{width:t,height:n,maxWidth:i,maxHeight:r(?:,minWidth:a=0,minHeight:s=0)?\}=e[^;]*;/g,
                replace: (match: string) => `${match}null==t&&(t=i,n=r);`
            }
        },
        {
            find: "originalContentType:e.original_content_type,loadingState:e.loading_state",
            replacement: {
                match: /height:e\.height,width:e\.width,/,
                replace: "height:e.height||360,width:e.width||640,"
            }
        },
        {
            find: "loadingState:e.loading_state,",
            replacement: {
                match: /loadingState:e\.loading_state,/,
                replace: "loadingState:e.loading_state??2,"
            }
        },
        {
            find: "let{width:t,height:n}=e;return t>0&&n>0",
            replacement: {
                match: /let\{width:t,height:n\}=e;return t>0&&n>0/,
                replace: "let{width:t,height:n}=e;return(t??1)>0&&(n??1)>0"
            }
        },
        {
            find: "].find(e=>E(e).supported())",
            replacement: {
                match: /\[(\w+\.\w+\.NATIVE),(\w+\.\w+\.WEBRTC)\]\.find\(e=>\w+\(e\)\.supported\(\)\)/,
                replace: (match: string, native: string, webrtc: string) =>
                    match.replace(`[${native},${webrtc}]`, `[${webrtc},${native}]`)
            }
        },
        {
            find: "\"Microsoft Edge\"===",
            replacement: {
                match: /"Chrome"===(\w+)\(\)\.name\|\|"Safari"===\w+\(\)\.name\|\|"Firefox"===\w+\(\)\.name&&(\w+)>=80\|\|"Opera"===\w+\(\)\.name\|\|"Microsoft Edge"===\w+\(\)\.name/,
                replace: (match: string, fn: string, ver: string) =>
                    `(${match}||"Electron"===${fn}().name&&${ver}>=1)`
            }
        },
        {
            find: "get platformAlwaysPermits(){return",
            replacement: {
                match: /get platformAlwaysPermits\(\)\{return.*?\.checkPermissionsEnabled\}/,
                replace: "get platformAlwaysPermits(){return!0}"
            }
        },
        {
            find: "originalItem:e,type:(0,",
            all: true,
            replacement: {
                match: /type:\(0,(\w+\.\w+)\)\(([\w,]+)\)/,
                replace: (match: string, fn: string, args: string) =>
                    `type:(()=>{let r=(0,${fn})(${args});return"OTHER"===r&&null!=e.content_type?(e.content_type.startsWith("video/")?"VIDEO":e.content_type.startsWith("image/")?"IMAGE":e.content_type.startsWith("audio/")?"AUDIO":r):r})()`
            }
        },
        {
            find: 'startsWith("blob:"))return e;let n=',
            replacement: {
                match: /(let n=\w+\.\w+\.toURLSafe\(e\);return null==n\?null:\()n\.searchParams\.set\("format","webp"\)/,
                replace: '$1/\\.(mov|mp4|webm|mkv|avi|mpg|mpeg)$/i.test(n.pathname)||n.searchParams.set("format","webp")'
            }
        },
        {
            find: 'case"VIDEO":case"CLIP":return(0,',
            replacement: {
                match: /case"VIDEO":case"CLIP":return\(0,(\w+\.\w+)\)\(\w+,\{item:(\w+),[^}]*\}\)/,
                replace: (match: string, jsxfn: string, item: string) =>
                    `case"VIDEO":case"CLIP":return(0,${jsxfn})("video",{src:${item}.originalItem?.url??${item}.downloadUrl,controls:!0,preload:"metadata",style:{maxWidth:_||640,maxHeight:D||400,width:"100%"}})`
            }
        },
        {
            find: "hasPermissionCore(e,t){return this.asyncify(",
            replacement: {
                match: /hasPermissionCore\(e,t\)\{return this\.asyncify\([^}]*\)\}/,
                replace: "hasPermissionCore(e,t){return Promise.resolve(!0)}"
            }
        },
        {
            find: "requestPermissionCore(e,t){return this.asyncify(",
            replacement: {
                match: /requestPermissionCore\(e,t\)\{return this\.asyncify\([^}]*\)\}/,
                replace: "requestPermissionCore(e,t){return Promise.resolve(!0)}"
            }
        },
        {
            find: "didHavePermission(e){return this.storage.hasPermission(e)}",
            replacement: {
                match: /didHavePermission\(e\)\{return this\.storage\.hasPermission\(e\)\}/,
                replace: "didHavePermission(e){return!0}"
            }
        },
        {
            find: "getCollectiblesItemAssetUrl:i}=n(",
            replacement: {
                match: /(let\{CollectiblesItemAssetFormat:\w+,getCollectiblesItemAssetUrl:\w+\}=\w+\(\d+\),\w+=\w+\?\w+\.ANIMATED:\w+\.STATIC,\w+=\w+\(\{skuId:\w+\.skuId,assetFormat:\w+\}\);)if\(null!=\w+\)return \w+\}catch\{return null\}/,
                replace: "$1}catch{return null}"
            }
        },
        {
            find: "gif_provider:i.provider??",
            replacement: {
                match: /\{gif_provider:(\w+)\.provider\?\?\(0,\w+\.\w+\)\(\),load_id:\w+\.\w+\.getAnalyticsID\(\),source_object:"GIF Picker",gif_url:\1\.url,gif_id:\1\.id\};(\w+)\(\1\.url,void 0,void 0,!0,void 0,\w+\)/,
                replace: "$2(($1.gifSrc?($1.gifSrc.startsWith('//')?'https:'+$1.gifSrc:$1.gifSrc):$1.url))"
            }
        }
    ]
});
