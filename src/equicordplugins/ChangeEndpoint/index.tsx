/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { parseUrl } from "@utils/misc";
import definePlugin from "@utils/types";
import { findByPropsLazy, findStoreLazy } from "@webpack";
import { ChannelActions, ChannelStore, FluxDispatcher, GuildStore, MessageStore, RestAPI, RTCConnectionStore, SelectedChannelStore, UserStore, VoiceStateStore } from "@webpack/common";

import { settings } from "./settings";
import { getApiEndpoint, getCdnHost, getGatewayEndpoint, getMediaProxyEndpoint } from "./utils";

const logger = new Logger("ChangeEndpoint");

// polls backend's guild_folders, applies them locally, pushes local
// reordering back. Guards against writing not-yet-loaded guild IDs

const GuildActionCreators = findByPropsLazy("moveById", "createGuildFolderLocal");
const SortedGuildStore = findStoreLazy("SortedGuildStore");

interface HarmonyGuildFolder {
    id: number | null;
    name: string | null;
    guild_ids: string[];
    color: number | null;
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let lastSignature: string | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pollingStarted = false;
let applyingGuildOrder = false;

const POLL_INTERVAL = 45 * 1000;

function toHarmonyFolders(): HarmonyGuildFolder[] {
    const folders = SortedGuildStore.getGuildFolders();

    return folders.map((f: any) => ({
        id: f.folderId ?? null,
        name: f.folderName ?? null,
        guild_ids: f.guildIds,
        color: f.folderColor ?? null
    }));
}

// discord's local proto settings cache writes folder id as a uint64 field.
// echoing an explicit `null` back through the rest round-trip breaks that
// write (seen as "string is no integer" in the console) - strip null ids
// from the outgoing payload instead of sending them as null.
function stripNullIds(folders: HarmonyGuildFolder[]) {
    return folders.map(({ id, ...rest }) => (id == null ? rest : { id, ...rest }));
}

async function pushGuildOrder() {
    try {
        const guild_folders = stripNullIds(toHarmonyFolders());
        await RestAPI.patch({
            url: "/users/@me/settings",
            body: { guild_folders }
        });
        lastSignature = JSON.stringify(guild_folders);
    } catch (e) {
        logger.error("Failed to push guild order", e);
    }
}

function schedulePush() {
    // applyGuildOrder below dispatches the very events this is subscribed to.
    // Without this guard, pulling the server's order immediately queues a push
    // of the order we just applied, and createGuildFolderLocal can't carry the
    // folder's id/color, so that push would overwrite both on the backend.
    if (applyingGuildOrder) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(pushGuildOrder, 1500);
}

function applyGuildOrder(folders: HarmonyGuildFolder[]) {
    const totalIds = folders.reduce((n, f) => n + f.guild_ids.filter(Boolean).length, 0);
    const loadedIds = folders.reduce(
        (n, f) => n + f.guild_ids.filter(id => id && GuildStore.getGuild(id)).length,
        0
    );

    // don't reorder until every guild id is actually loaded
    if (loadedIds < totalIds) {
        logger.debug(`Guilds not fully loaded yet (${loadedIds}/${totalIds}), deferring order apply`);
        return false;
    }

    let anchor: string | null = null;

    applyingGuildOrder = true;
    try {
        for (const folder of folders) {
            const ids = folder.guild_ids.filter(Boolean);
            if (!ids.length) continue;

            if (ids.length > 1) {
                GuildActionCreators.createGuildFolderLocal(ids, folder.name ?? null);
            } else if (anchor) {
                GuildActionCreators.moveById(ids[0], anchor, true, false);
            }

            anchor = ids[ids.length - 1];
        }
    } finally {
        applyingGuildOrder = false;
    }

    return true;
}

async function pollSavedGuildOrder() {
    try {
        const res = await RestAPI.get({ url: "/users/@me/settings" });
        const folders: HarmonyGuildFolder[] = res?.body?.guild_folders ?? [];
        const signature = JSON.stringify(folders);

        if (folders.length && signature !== lastSignature) {
            logger.info("Applying updated guild order from server");
            if (applyGuildOrder(folders)) lastSignature = signature;
        }
    } catch (e) {
        logger.error("Failed to poll saved guild order", e);
    } finally {
        // stop() may have run while the request was in flight - re-arming here
        // unconditionally would resurrect the poll it just cancelled
        if (pollingStarted) pollTimer = setTimeout(pollSavedGuildOrder, POLL_INTERVAL);
    }
}

const GUILD_ORDER_EVENTS = ["GUILD_MOVE_BY_ID", "GUILD_FOLDER_CREATE_LOCAL", "GUILD_FOLDER_EDIT_LOCAL", "GUILD_FOLDER_DELETE_LOCAL"];

function startGuildOrderSync() {
    if (pollingStarted) return;
    pollingStarted = true;

    pollSavedGuildOrder();
    GUILD_ORDER_EVENTS.forEach(e => FluxDispatcher.subscribe(e, schedulePush));
}

function stopGuildOrderSync() {
    pollingStarted = false;

    if (pollTimer) clearTimeout(pollTimer);
    if (debounceTimer) clearTimeout(debounceTimer);
    pollTimer = debounceTimer = null;
    GUILD_ORDER_EVENTS.forEach(e => FluxDispatcher.unsubscribe(e, schedulePush));
}

// after a forced reconnect, VoiceStateStore can still claim we're in a
// channel while RTC is actually dead. cross-check against RTCConnectionStore
// and force a real leave+rejoin when they disagree.

// excludes transient states like CONNECTING/ICE_CHECKING/AUTHENTICATING.
const DEAD_STATES = new Set(["DISCONNECTED", "RTC_DISCONNECTED", "NO_ROUTE"]);

const GRACE_MS = 5000;
const REJOIN_DELAY_MS = 1000; // selectVoiceChannel no-ops if called with the current channel

let graceTimer: ReturnType<typeof setTimeout> | null = null;
let recovering = false;

function isPhantomVoiceState(): { channelId: string; } | null {
    const me = UserStore.getCurrentUser();
    if (!me) return null;

    const myVoiceState = VoiceStateStore.getVoiceStateForUser(me.id);
    if (!myVoiceState?.channelId) return null;

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
    logger.info(
        `Voice state looks phantom (client thinks it's in ${channelId}, ` +
        `RTC state is ${RTCConnectionStore.getState()}), forcing a real rejoin`
    );

    ChannelActions.selectVoiceChannel(null);
    setTimeout(() => {
        ChannelActions.selectVoiceChannel(channelId);
        recovering = false;
    }, REJOIN_DELAY_MS);
}

function onVoicePhantomCheckTrigger() {
    if (graceTimer) clearTimeout(graceTimer);
    graceTimer = setTimeout(attemptVoiceRecovery, GRACE_MS);
}

const VOICE_PHANTOM_EVENTS = ["CONNECTION_OPEN", "VOICE_CONNECTION_STATUS"];

function startVoicePhantomFix() {
    VOICE_PHANTOM_EVENTS.forEach(e => FluxDispatcher.subscribe(e, onVoicePhantomCheckTrigger));
}

function stopVoicePhantomFix() {
    VOICE_PHANTOM_EVENTS.forEach(e => FluxDispatcher.unsubscribe(e, onVoicePhantomCheckTrigger));
    if (graceTimer) clearTimeout(graceTimer);
    recovering = false;
}

// Harmony/Fermo only populate DM unread state once, from the initial
// READY payload - after that it's 100% dependent on MESSAGE_CREATE
// gateway events arriving for private channels. If one gets dropped
// (flaky gateway dispatch for DMs), that unread/ping never appears
// until a full refresh. Poll the DM channel list over REST every 90
// seconds and replay any message the client hasn't seen through the
// normal MESSAGE_CREATE flow, so ReadState/badges/notifications get
// recomputed the same way they would from a live gateway event.
// Skips whatever channel is currently focused, since that one already
// gets its unread/notification state kept in sync live.

const DM_CHANNEL_TYPE = 1;
const GROUP_DM_CHANNEL_TYPE = 3;
const DM_POLL_INTERVAL = 90 * 1000;

let dmPollTimer: ReturnType<typeof setTimeout> | null = null;
let dmPollingStarted = false;

async function checkChannelForMissedMessage(channel: { id: string; last_message_id: string | null; type: number; }) {
    if (channel.type !== DM_CHANNEL_TYPE && channel.type !== GROUP_DM_CHANNEL_TYPE) return;
    if (!channel.last_message_id) return;

    // notifications/unreads already work fine for whatever DM is
    // currently focused (it gets marked read/ack'd live) - only
    // channels the user isn't looking at need this workaround
    if (SelectedChannelStore.getChannelId() === channel.id && document.hasFocus()) return;

    // a channel the client has never seen won't have its lastMessageId
    // advanced by the replay below, so it would re-fire the same message
    // (and its notification) on every poll
    const localChannel = ChannelStore.getChannel(channel.id);
    if (!localChannel || localChannel.lastMessageId === channel.last_message_id) return;
    if (MessageStore.getMessage(channel.id, channel.last_message_id)) return;

    try {
        const res = await RestAPI.get({
            url: `/channels/${channel.id}/messages`,
            query: { limit: 1 }
        });
        const message = res?.body?.[0];
        if (!message) return;

        logger.info(`Replaying missed message in DM ${channel.id} that the gateway never delivered`);

        FluxDispatcher.dispatch({
            type: "MESSAGE_CREATE",
            channelId: channel.id,
            message,
            optimistic: false,
            isPushNotification: false
        });
    } catch (e) {
        logger.error(`Failed to fetch latest message for channel ${channel.id}`, e);
    }
}

async function pollDMUnreads() {
    try {
        const res = await RestAPI.get({ url: "/users/@me/channels" });
        const channels: Array<{ id: string; last_message_id: string | null; type: number; }> = res?.body ?? [];
        await Promise.all(channels.map(checkChannelForMissedMessage));
    } catch (e) {
        logger.error("Failed to poll DM unreads", e);
    } finally {
        // same as the guild order poll: don't re-arm a timer stop() cleared
        if (dmPollingStarted) dmPollTimer = setTimeout(pollDMUnreads, DM_POLL_INTERVAL);
    }
}

// starting this straight from start() fires before the gateway/REST client
// is actually up (required plugins boot very early), so the first request
// can silently fail - the CONNECTION_OPEN subscription below covers that
// case, but by the time this plugin starts (WebpackReady stage) the
// gateway has usually already connected once, so that event has already
// fired and won't come again until the next reconnect. try immediately
// too so we're not just waiting on a reconnect that might not happen soon.
function onDMPollConnectionOpen() {
    if (dmPollTimer) return;
    pollDMUnreads();
}

function startDMUnreadPoll() {
    dmPollingStarted = true;
    FluxDispatcher.subscribe("CONNECTION_OPEN", onDMPollConnectionOpen);
    onDMPollConnectionOpen();
}

function stopDMUnreadPoll() {
    dmPollingStarted = false;
    FluxDispatcher.unsubscribe("CONNECTION_OPEN", onDMPollConnectionOpen);
    if (dmPollTimer) clearTimeout(dmPollTimer);
    dmPollTimer = null;
}

// forces a fresh gateway reconnect when the tab returns from being
// backgrounded long enough that a heartbeat ack was likely missed,
// instead of waiting for Harmony's own 4009 timeout.

let gatewaySocket: WebSocket | null = null;
let hiddenSince: number | null = null;
let originalWebSocket: typeof WebSocket | null = null;
const HIDDEN_RECONNECT_THRESHOLD_MS = 30_000;

// the configured gateway host, not the literal "gateway." - a custom instance
// is free to serve its gateway from any hostname, and matching on "gateway."
// left the watchdog holding no socket at all on those
function isGatewayUrl(url: string) {
    const gateway = getGatewayEndpoint();
    const host = gateway && parseUrl(gateway)?.host;
    return host ? url.includes(host) : url.includes("gateway.");
}

// Spacebar validates op 3 against ActivitySchema, whose $metadata block marks
// album_id and artist_ids as required. Discord sends "metadata":{} on every
// custom status, so the object is present but empty, validation fails, and the
// gateway closes the socket with 4002 (Decode_error) - setting a custom status
// disconnects you. Drop metadata unless it carries the fields the schema wants,
// which leaves real Spotify rich presence untouched.
// Upstream bug: src/schemas/uncategorised/ActivitySchema.ts, still present as of
// spacebarchat/server @ 3975d89.
function sanitiseGatewayPayload(data: string) {
    if (!data.includes('"op":3') || !data.includes('"metadata"')) return data;

    try {
        const payload = JSON.parse(data);
        if (payload?.op !== 3 || !Array.isArray(payload.d?.activities)) return data;

        let changed = false;
        for (const activity of payload.d.activities) {
            const meta = activity?.metadata;
            if (!meta || (meta.album_id != null && meta.artist_ids != null)) continue;
            delete activity.metadata;
            changed = true;
        }

        if (!changed) return data;

        logger.debug("Stripped incomplete activity metadata from a presence update to avoid a 4002 close");
        return JSON.stringify(payload);
    } catch {
        return data;
    }
}

function installGatewaySocketCapture() {
    if (originalWebSocket) return;

    const OriginalWebSocket = originalWebSocket = window.WebSocket;
    function PatchedWebSocket(this: unknown, url: string | URL, protocols?: string | string[]) {
        const ws = new OriginalWebSocket(url, protocols);
        if (isGatewayUrl(String(url))) {
            gatewaySocket = ws;

            const send = ws.send.bind(ws);
            ws.send = data => send(typeof data === "string" ? sanitiseGatewayPayload(data) : data);
        }
        return ws;
    }
    PatchedWebSocket.prototype = OriginalWebSocket.prototype;
    Object.setPrototypeOf(PatchedWebSocket, OriginalWebSocket);
    window.WebSocket = PatchedWebSocket as unknown as typeof WebSocket;
}

function uninstallGatewaySocketCapture() {
    if (!originalWebSocket) return;

    window.WebSocket = originalWebSocket;
    originalWebSocket = null;
    gatewaySocket = null;
}

function onVisibilityChange() {
    if (document.hidden) {
        hiddenSince = Date.now();
        return;
    }
    if (hiddenSince && Date.now() - hiddenSince > HIDDEN_RECONNECT_THRESHOLD_MS) {
        logger.info("Tab was backgrounded, forcing a reconnect ahead of a possible heartbeat timeout");
        gatewaySocket?.close(4000, "ChangeEndpoint proactive reconnect");
    }
    hiddenSince = null;
}

function startHeartbeatWatchdog() {
    installGatewaySocketCapture();
    document.addEventListener("visibilitychange", onVisibilityChange);
}

function stopHeartbeatWatchdog() {
    document.removeEventListener("visibilitychange", onVisibilityChange);
    uninstallGatewaySocketCapture();
    hiddenSince = null;
}

export default definePlugin({
    name: "ChangeEndpoint",
    description: "Redirects Discord API/CDN/Gateway traffic to a Spacebar backend (Harmony by default, or a custom one).",
    authors: [],
    required: true,
    settings,

    // The GIF picker sends `url`, which on Klipy is the HTML page for the GIF
    // rather than the file itself, so nothing embeds. `gifSrc` is the real
    // image. Favourites are keyed by that same page url and only ever carry a
    // usable file in `src`, so fall back to it, but not when it's the mp4/webm
    // preview Klipy returns for search results.
    resolveGifUrl(item: { url: string; src?: string; gifSrc?: string; }) {
        const withScheme = (url: string) => url.startsWith("//") ? `https:${url}` : url;

        if (item.gifSrc) return withScheme(item.gifSrc);
        if (item.src && !/\.(mp4|webm)(\?|$)/i.test(item.src)) return withScheme(item.src);
        return item.url;
    },

    start() {
        startGuildOrderSync();
        startVoicePhantomFix();
        startHeartbeatWatchdog();
        startDMUnreadPoll();

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
        stopHeartbeatWatchdog();
        stopDMUnreadPoll();
    },

    patches: [
        // must run before the API_ENDPOINT rewrite below, which would otherwise
        // consume the window.GLOBAL_ENV.API_ENDPOINT this match anchors on and
        // leave the patch silently doing nothing
        {
            find: "return\"https:\"+window.GLOBAL_ENV.API_ENDPOINT+(",
            replacement: {
                match: /function (\i)\(\)\{let (\i)=!\(arguments\.length>0\)\|\|void 0===arguments\[0\]\|\|arguments\[0\];return"https:"\+window\.GLOBAL_ENV\.API_ENDPOINT\+\(\2\?`\/v\$\{window\.GLOBAL_ENV\.API_VERSION\}`:""\)\}/,
                replace: 'function $1(){return"https:"+window.GLOBAL_ENV.API_ENDPOINT+`/v${window.GLOBAL_ENV.API_VERSION}`}'
            }
        },
        {
            find: "window.GLOBAL_ENV.API_ENDPOINT",
            all: true,
            predicate: () => getApiEndpoint() != null,
            replacement: {
                match: /window\.GLOBAL_ENV\.API_ENDPOINT/g,
                replace: () => JSON.stringify(getApiEndpoint())
            }
        },
        {
            find: "window.GLOBAL_ENV.CDN_HOST",
            all: true,
            predicate: () => getCdnHost() != null,
            replacement: {
                match: /window\.GLOBAL_ENV\.CDN_HOST/g,
                replace: () => JSON.stringify(getCdnHost())
            }
        },
        {
            find: "window.GLOBAL_ENV.GATEWAY_ENDPOINT",
            all: true,
            predicate: () => getGatewayEndpoint() != null,
            replacement: {
                match: /window\.GLOBAL_ENV\.GATEWAY_ENDPOINT/g,
                replace: () => JSON.stringify(getGatewayEndpoint())
            }
        },
        {
            find: "window.GLOBAL_ENV.MEDIA_PROXY_ENDPOINT",
            all: true,
            predicate: () => getMediaProxyEndpoint() != null,
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
                    const overrides: Record<string, string | null> = {
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
                match: /get platformAlwaysPermits\(\)\{return.{0,100}?\.checkPermissionsEnabled\}/,
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
            find: 'source_object:"GIF Picker"',
            replacement: {
                match: /(gif_provider:(\i)\.provider.{0,150}?source_object:"GIF Picker",gif_url:\2\.url,gif_id:\2\.id\};)(\i)\(\2\.url,/,
                replace: "$1$3($self.resolveGifUrl($2),"
            }
        },
        // Discord's local settings-proto cache (PRELOADED_USER_SETTINGS /
        // FRECENCY_AND_FAVORITES_SETTINGS) stores several fields as stringified
        // uint64/int64. Its serializer throws on an empty string, uncaught,
        // outside any try/catch, which permanently stalls that store's whole
        // save queue the moment one bad field shows up (every future dirty
        // write dies at the same line, forever, until reload). Spacebar's guild
        // feature/onboarding gaps are what actually produce those empty
        // strings - Discord's own writers always seed a literal "0" - so this
        // only bites when pointed at a Spacebar backend. Treat "" as zero, same
        // as the existing "0" case one line above it in the real source.
        {
            find: "string is no integer",
            all: true,
            replacement: {
                match: /if\(""==(\i)\)throw Error\("string is no integer"\)/g,
                replace: 'if(""==$1)return this.ZERO'
            }
        },
    ]
});
