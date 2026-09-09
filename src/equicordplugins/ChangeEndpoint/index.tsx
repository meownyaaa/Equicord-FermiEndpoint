/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { parseUrl } from "@utils/misc";
import definePlugin from "@utils/types";
import { findByPropsLazy, findLazy, findStoreLazy } from "@webpack";
import { ChannelStore, DraftType, FluxDispatcher, GuildStore, MessageStore, RestAPI, SelectedChannelStore } from "@webpack/common";
import type { ReactNode } from "react";

import { migrateVideoPlayerSetting, settings } from "./settings";
import { DiscordSpoiler } from "./spoiler";
import { getApiEndpoint, getCdnHost, getGatewayEndpoint, getMediaProxyEndpoint } from "./utils";
import { CustomVideoPlayer } from "./videoPlayer";

const logger = new Logger("ChangeEndpoint");

const GuildActionCreators = findByPropsLazy("moveById", "createGuildFolderLocal");
const SortedGuildStore = findStoreLazy("SortedGuildStore");
const UploadManager = findByPropsLazy("clearAll", "addFile");
const UploadAttachmentStore = findByPropsLazy("getUploadCount");

interface HarmonyGuildFolder {
    id: number | null;
    name: string | null;
    guild_ids: string[];
    color: number | null;
}

interface ColorRole {
    id: string;
    guildId: string;
    color: number;
    colorString: string | null;
    colorStrings: { primaryColor: string; secondaryColor: string | null; tertiaryColor: string | null; } | null;
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

function stripNullIds(folders: HarmonyGuildFolder[]) {
    return folders.map(({ id, ...rest }) => (id == null ? rest : { id, ...rest }));
}

function folderSignature(folders: Array<{ id?: number | null; name?: string | null; color?: number | null; guild_ids: string[]; }>) {
    return JSON.stringify(folders.map(f => [f.id ?? null, f.name ?? null, f.color ?? null, f.guild_ids]));
}

async function pushGuildOrder() {
    try {
        const guild_folders = stripNullIds(toHarmonyFolders());
        await RestAPI.patch({
            url: "/users/@me/settings",
            body: { guild_folders }
        });
        lastSignature = folderSignature(guild_folders);
    } catch (e) {
        logger.error("Failed to push guild order", e);
    }
}

function schedulePush() {
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

    if (loadedIds < totalIds) {
        logger.debug(`Guilds not fully loaded yet (${loadedIds}/${totalIds}), deferring order apply`);
        return false;
    }

    const findFolder = (ids: string[]) => (SortedGuildStore.getGuildFolders() as Array<{ folderId: number | null; guildIds: string[]; }>)
        .find(f => f.guildIds.length === ids.length && ids.every(id => f.guildIds.includes(id)));

    let anchor: string | number | null = null;

    applyingGuildOrder = true;
    try {
        for (const folder of folders) {
            const ids = folder.guild_ids.filter(Boolean);
            if (!ids.length) continue;

            if (ids.length > 1) {
                let match = findFolder(ids);
                if (!match) {
                    GuildActionCreators.createGuildFolderLocal(ids, folder.name ?? null);
                    match = findFolder(ids);
                }
                anchor = match?.folderId ?? ids[ids.length - 1];
            } else {
                if (anchor != null) GuildActionCreators.moveById(ids[0], anchor, true, false);
                anchor = ids[0];
            }
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
        const signature = folderSignature(folders);

        if (folders.length && signature !== lastSignature) {
            logger.info("Applying updated guild order from server");
            if (applyGuildOrder(folders)) lastSignature = signature;
        }
    } catch (e) {
        logger.error("Failed to poll saved guild order", e);
    } finally {
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

const DM_CHANNEL_TYPE = 1;
const GROUP_DM_CHANNEL_TYPE = 3;
const DM_POLL_INTERVAL = 90 * 1000;

let dmPollTimer: ReturnType<typeof setTimeout> | null = null;
let dmPollingStarted = false;

async function checkChannelForMissedMessage(channel: { id: string; last_message_id: string | null; type: number; }) {
    if (channel.type !== DM_CHANNEL_TYPE && channel.type !== GROUP_DM_CHANNEL_TYPE) return;
    if (!channel.last_message_id) return;

    if (SelectedChannelStore.getChannelId() === channel.id && document.hasFocus()) return;

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
        if (dmPollingStarted) dmPollTimer = setTimeout(pollDMUnreads, DM_POLL_INTERVAL);
    }
}

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

let originalSend: typeof WebSocket.prototype.send | null = null;

function isGatewayUrl(url: string) {
    const gateway = getGatewayEndpoint();
    const host = gateway && parseUrl(gateway)?.host;
    return host ? url.includes(host) : url.includes("gateway.");
}

// spacebar's CLIENT_STATE_V2 capability bit (1<<10) routes guild
// serialization through a rarely-used code path in onIdentify. clearing
// it forces the older, more-exercised path instead, as a workaround for
// the 4000 close during identify. logged loudly (info, not debug) and
// unconditionally so we can actually confirm this runs at all, rather
// than assume - a previous version of this fix looked right on paper
// but didn't resolve the issue, so don't trust it again without proof
const CLIENT_STATE_V2_BIT = 1 << 10;

function stripClientStateV2(data: string) {
    if (!data.includes('"op":2')) return data;

    let payload: any;
    try {
        payload = JSON.parse(data);
    } catch {
        logger.info("IDENTIFY-shaped frame failed to parse as JSON, leaving untouched");
        return data;
    }

    if (payload?.op !== 2) return data;

    const caps = payload.d?.capabilities;
    logger.info("intercepted outgoing IDENTIFY, capabilities =", caps, "has CLIENT_STATE_V2 =", typeof caps === "number" && !!(caps & CLIENT_STATE_V2_BIT));

    if (typeof caps !== "number" || !(caps & CLIENT_STATE_V2_BIT)) return data;

    payload.d.capabilities = caps & ~CLIENT_STATE_V2_BIT;
    logger.info("cleared CLIENT_STATE_V2, new capabilities =", payload.d.capabilities);
    return JSON.stringify(payload);
}

function sanitiseGatewayPayload(data: string) {
    data = stripClientStateV2(data);

    if (!data.includes('"op":3') || !data.includes('"metadata"')) return data;

    try {
        const payload = JSON.parse(data);
        if (payload?.op !== 3 || !Array.isArray(payload.d?.activities)) return data;

        let changed = false;
        for (const activity of payload.d.activities) {
            const meta = activity?.metadata;
            if (!meta || (meta.album_id && meta.artist_ids)) continue;
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

function installGatewaySendSanitiser() {
    if (originalSend) return;

    // patch the shared prototype method instead of window.WebSocket, since discord
    // may cache its own constructor reference and never see a swapped-out global
    originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (this: WebSocket, data: any) {
        // temporary: log every websocket send this patch even sees, gateway
        // or not, so we can tell whether the interception fires at all -
        // if the client's gateway socket lives in a worker instead of the
        // main thread, this prototype patch never touches it and every
        // theory downstream of "we can edit the outgoing frame" is moot
        if (typeof data === "string" && data.length < 300) {
            logger.info("ws send on", this.url, "gatewayMatch =", isGatewayUrl(this.url), data);
        }

        const payload = typeof data === "string" && isGatewayUrl(this.url)
            ? sanitiseGatewayPayload(data)
            : data;
        return originalSend!.call(this, payload);
    };
}

function uninstallGatewaySendSanitiser() {
    if (!originalSend) return;

    WebSocket.prototype.send = originalSend;
    originalSend = null;
}

// discord's own dave client-connect handler assumes it always gets an array;
// some server implementations (e.g. spacebar) send something else and crash
// the whole voice negotiation with "e.forEach is not a function". normalise
// the argument instead of letting it throw
const DaveHandlerModule = findLazy(m => m?.prototype?._handleClientConnect);
let originalHandleClientConnect: ((e: unknown, ...rest: unknown[]) => unknown) | null = null;

function toArray(value: unknown): unknown[] {
    if (Array.isArray(value)) return value;
    if (value == null) return [];
    if (typeof (value as any)[Symbol.iterator] === "function") return Array.from(value as Iterable<unknown>);
    return Object.values(value as object);
}

function installDaveClientConnectGuard() {
    if (originalHandleClientConnect || !DaveHandlerModule?.prototype?._handleClientConnect) return;

    originalHandleClientConnect = DaveHandlerModule.prototype._handleClientConnect;
    DaveHandlerModule.prototype._handleClientConnect = function (e: unknown, ...rest: unknown[]) {
        try {
            return originalHandleClientConnect!.call(this, toArray(e), ...rest);
        } catch (err) {
            logger.error("Swallowed error in DAVE _handleClientConnect to avoid killing voice negotiation", err);
        }
    };
}

function uninstallDaveClientConnectGuard() {
    if (!originalHandleClientConnect || !DaveHandlerModule?.prototype) return;

    DaveHandlerModule.prototype._handleClientConnect = originalHandleClientConnect;
    originalHandleClientConnect = null;
}

const MESSAGE_URL_RE = /\/channels\/\d+\/messages(\/\d+)?$/;

function stripIsSpoiler(body: string) {
    if (!body.includes('"is_spoiler"')) return body;

    try {
        const payload = JSON.parse(body);
        if (!Array.isArray(payload.attachments)) return body;

        let changed = false;
        for (const attachment of payload.attachments) {
            if (attachment && "is_spoiler" in attachment) {
                if (attachment.is_spoiler && typeof attachment.filename === "string" && !attachment.filename.startsWith("SPOILER_")) {
                    attachment.filename = "SPOILER_" + attachment.filename;
                }
                delete attachment.is_spoiler;
                changed = true;
            }
        }

        if (!changed) return body;

        logger.debug("moved is_spoiler to a SPOILER_ filename prefix, spacebar doesn't support that field");
        return JSON.stringify(payload);
    } catch {
        return body;
    }
}

let originalFetch: typeof fetch | null = null;

function installFetchSanitiser() {
    if (originalFetch) return;

    const OriginalFetch = originalFetch = window.fetch;
    window.fetch = (input, init) => {
        if (init && (init.method === "POST" || init.method === "PATCH") && typeof init.body === "string") {
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            if (MESSAGE_URL_RE.test(new URL(url, location.origin).pathname)) {
                init = { ...init, body: stripIsSpoiler(init.body) };
            }
        }
        return OriginalFetch(input, init);
    };
}

function uninstallFetchSanitiser() {
    if (!originalFetch) return;
    window.fetch = originalFetch;
    originalFetch = null;
}

export default definePlugin({
    name: "ChangeEndpoint",
    description: "Redirects Discord API/CDN/Gateway traffic to a Spacebar backend (Harmony by default, or a custom one).",
    authors: [],
    required: true,
    settings,

    resolveGifUrl(item: { url: string; src?: string; gifSrc?: string; }) {
        const withScheme = (url: string) => url.startsWith("//") ? `https:${url}` : url;

        if (item.gifSrc) return withScheme(item.gifSrc);
        if (item.src && !/\.(mp4|webm)(\?|$)/i.test(item.src)) return withScheme(item.src);
        return item.url;
    },

    renderSpoilerVideo(item: { originalItem?: { url?: string; filename?: string; size?: number; }; downloadUrl?: string; }, maxWidth: number, maxHeight: number) {
        const src = item.originalItem?.url ?? item.downloadUrl ?? "";
        const video = settings.store.useChromiumVideoPlayer
            ? <video src={src} controls preload="metadata" style={{ maxWidth, maxHeight, width: "100%" }} />
            : <CustomVideoPlayer src={src} maxWidth={maxWidth} maxHeight={maxHeight} fileName={item.originalItem?.filename} fileSizeBytes={item.originalItem?.size} />;

        return this.wrapSpoiler(item, video);
    },

    wrapSpoiler(item: { originalItem?: { filename?: string; }; }, node: ReactNode) {
        if (!item.originalItem?.filename?.startsWith("SPOILER_")) return node;
        return <DiscordSpoiler>{node}</DiscordSpoiler>;
    },

    fixUploadSpoiler(upload: { filename: string; spoiler: boolean; }) {
        if (!upload.spoiler) return;
        if (!upload.filename.startsWith("SPOILER_")) upload.filename = "SPOILER_" + upload.filename;
        upload.spoiler = false;
    },

    getEveryoneColorRole(guildRoles: Record<string, ColorRole>) {
        const everyone = Object.values(guildRoles).find(r => r.id === r.guildId);
        return everyone && everyone.color > 0 ? everyone : undefined;
    },

    flux: {
        UPLOAD_ATTACHMENT_UPDATE_FILE({ channelId, id, draftType, spoiler }: { channelId: string; id: string; draftType: number; spoiler?: boolean; }) {
            if (spoiler == null || draftType !== DraftType.ChannelMessage) return;

            const upload = UploadAttachmentStore.getUpload(channelId, id, draftType);
            if (!upload?.uploadedFilename) return;

            const hasPrefix: boolean = upload.filename.startsWith("SPOILER_");
            if (spoiler === hasPrefix) return;

            const file = upload.item?.file;
            if (!file) return;

            const newName = spoiler ? "SPOILER_" + file.name : file.name.replace(/^SPOILER_/, "");
            const renamedFile = new File([file], newName, { type: file.type });

            UploadManager.remove(channelId, id, draftType);
            UploadManager.addFile({
                file: { ...upload.item, file: renamedFile },
                channelId,
                draftType,
                allowOptimization: upload.allowOptimization
            });
        }
    },

    start() {
        migrateVideoPlayerSetting();
        startGuildOrderSync();
        startDMUnreadPoll();
        installFetchSanitiser();
        installGatewaySendSanitiser();
        installDaveClientConnectGuard();

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
        stopDMUnreadPoll();
        uninstallFetchSanitiser();
        uninstallGatewaySendSanitiser();
        uninstallDaveClientConnectGuard();
    },

    patches: [
        {
            find: "async uploadFiles(",
            replacement: {
                match: /async uploadFiles\((\i)\){/,
                replace: "$&$1.forEach($self.fixUploadSpoiler);"
            }
        },
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
            find: "colorRoleId:void 0,hoistRoleId:void 0",
            replacement: {
                match: /function \i\((\i),(\i)\)\{let (\i),(\i),(\i),(\i);if\(0===\2\.length\)return\{colorString:null,colorStrings:null,colorRoleId:void 0,hoistRoleId:void 0,iconRoleId:void 0,highestRoleId:void 0\};.{0,280}?return\{colorString:\3\?\.colorString\?\?null,colorStrings:\3\?\.colorStrings\?\?null,colorRoleId:\3\?\.id,iconRoleId:\5\?\.id,hoistRoleId:\4\?\.id,highestRoleId:\6\?\.id\}\}/,
                replace: (match: string, e: string, t: string, n: string, i: string, r: string, a: string) => match
                    .replace(
                        `if(0===${t}.length)return{colorString:null,colorStrings:null,colorRoleId:void 0,hoistRoleId:void 0,iconRoleId:void 0,highestRoleId:void 0}`,
                        `if(0===${t}.length)return(${n}=>({colorString:${n}?.colorString??null,colorStrings:${n}?.colorStrings??null,colorRoleId:${n}?.id,hoistRoleId:void 0,iconRoleId:void 0,highestRoleId:void 0}))($self.getEveryoneColorRole(${e}))`
                    )
                    .replace(
                        `return{colorString:${n}?.colorString??null,colorStrings:${n}?.colorStrings??null,colorRoleId:${n}?.id,iconRoleId:${r}?.id,hoistRoleId:${i}?.id,highestRoleId:${a}?.id}}`,
                        `return{colorString:(${n}??=$self.getEveryoneColorRole(${e}))?.colorString??null,colorStrings:${n}?.colorStrings??null,colorRoleId:${n}?.id,iconRoleId:${r}?.id,hoistRoleId:${i}?.id,highestRoleId:${a}?.id}}`
                    )
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
                match: /case"VIDEO":case"CLIP":return\(0,(?:\w+\.\w+)\)\(\w+,\{item:(\w+),[^}]*\}\)/,
                replace: (match: string, item: string) =>
                    `case"VIDEO":case"CLIP":return $self.renderSpoilerVideo(${item},_||640,D||400)`
            }
        },
        {
            find: 'case"IMAGE":return(0,',
            replacement: {
                match: /case"IMAGE":return\(0,\i\.\i\)\(\i\.\i\.Consumer,\{children:\i=>(\(0,\i\.\i\)\(\i,\{item:(\i),[^}]*\}\))\}\)/,
                replace: (match: string, call: string, item: string) =>
                    match.replace(call, `$self.wrapSpoiler(${item},${call})`)
            }
        },
        {
            find: 'case"AUDIO":return(0,',
            replacement: {
                match: /case"AUDIO":return(\(0,\i\.\i\)\(\i,\{item:(\i),[^}]*\}\))/,
                replace: (match: string, call: string, item: string) =>
                    `case"AUDIO":return $self.wrapSpoiler(${item},${call})`
            }
        },
        {
            find: 'case"PLAINTEXT_PREVIEW":return(0,',
            replacement: {
                match: /case"PLAINTEXT_PREVIEW":return(\(0,\i\.\i\)\(\i,\{item:(\i),[^}]*\}\))/,
                replace: (match: string, call: string, item: string) =>
                    `case"PLAINTEXT_PREVIEW":return $self.wrapSpoiler(${item},${call})`
            }
        },
        {
            find: 'case"OTHER":return(0,',
            replacement: {
                match: /case"OTHER":return(\(0,\i\.\i\)\(\i,\{item:(\i),[^}]*\}\))/,
                replace: (match: string, call: string, item: string) =>
                    `case"OTHER":return $self.wrapSpoiler(${item},${call})`
            }
        },
        {
            find: "IS_SPOILER)",
            replacement: {
                match: /spoiler:(\(0,\i\.\i\)\((\i)\.flags\?\?0,\i\.\i\.IS_SPOILER\))/,
                replace: 'spoiler:($2.filename??$2.originalItem?.filename)?.startsWith("SPOILER_")||$1',
                noWarn: true
            }
        },
        {
            find: "POTENTIAL_EXPLICIT_CONTENT",
            replacement: {
                match: /function \i\((\i),\i\)\{let\{flags:\i=0\}=\1,.{0,150}?(\(0,\i\.\i\)\(\i,\i\.\i\.IS_SPOILER\))\?/,
                replace: (match: string, param: string, flagCheck: string) =>
                    match.replace(flagCheck, `((${param}.filename??${param}.originalItem?.filename)?.startsWith("SPOILER_")||${flagCheck})`)
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
