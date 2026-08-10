/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import ErrorBoundary from "@components/ErrorBoundary";
import { classNameFactory } from "@utils/css";
import { Logger } from "@utils/Logger";
import { parseUrl } from "@utils/misc";
import definePlugin from "@utils/types";
import { findByPropsLazy, findStoreLazy } from "@webpack";
import { ChannelStore, DraftType, FluxDispatcher, GuildStore, MessageStore, RestAPI, SelectedChannelStore, useState } from "@webpack/common";
import type { ReactNode } from "react";

import { settings } from "./settings";
import { getApiEndpoint, getCdnHost, getGatewayEndpoint, getMediaProxyEndpoint } from "./utils";

const logger = new Logger("ChangeEndpoint");
const cl = classNameFactory("vc-changeendpoint-");

// polls backend's guild_folders, applies them locally, pushes local
// reordering back. guards against writing not-yet-loaded guild IDs

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

// the server echoes these fields back in its own key order, so comparing
// JSON.stringify of what we sent against what a poll reads back never
// matches even when nothing changed - every poll looked like a remote
// change. positional arrays sidestep key order entirely.
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
    // applyGuildOrder dispatches the events this is subscribed to - without
    // this guard, pulling the server's order would immediately queue a push
    // of it right back, and createGuildFolderLocal can't carry id/color, so
    // that push would wipe both on the backend.
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

    // createGuildFolderLocal isn't idempotent: calling it again for a guild
    // set that's already exactly one existing folder doesn't just no-op, it
    // can drop a guild out of that folder - skip folders that already exist.
    const existingFolderSets = SortedGuildStore.getGuildFolders()
        .map((f: any) => new Set(f.guildIds as string[]));

    let anchor: string | null = null;

    applyingGuildOrder = true;
    try {
        for (const folder of folders) {
            const ids = folder.guild_ids.filter(Boolean);
            if (!ids.length) continue;

            if (ids.length > 1) {
                const alreadyExists = existingFolderSets.some(set => set.size === ids.length && ids.every(id => set.has(id)));
                if (!alreadyExists) GuildActionCreators.createGuildFolderLocal(ids, folder.name ?? null);
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
        const signature = folderSignature(folders);

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

// harmony/fermo only populate DM unread state once, from the initial READY
// payload - after that it depends entirely on MESSAGE_CREATE gateway events
// for private channels. if one gets dropped, poll the DM channel list every
// 90 seconds and replay anything the client hasn't seen, skipping whatever
// channel is currently focused since that one already syncs live.

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

let originalWebSocket: typeof WebSocket | null = null;

// the configured gateway host, not the literal "gateway." - a custom instance
// is free to serve its gateway from any hostname, and matching on "gateway."
// would leave this holding no socket at all on those
function isGatewayUrl(url: string) {
    const gateway = getGatewayEndpoint();
    const host = gateway && parseUrl(gateway)?.host;
    return host ? url.includes(host) : url.includes("gateway.");
}

// spacebar's ActivitySchema requires album_id/artist_ids whenever $metadata
// is present, but discord sends "metadata":{} on every custom status - that
// fails validation and the gateway closes with 4002. drop metadata unless it
// carries what the schema wants, which leaves real Spotify presence intact.
// upstream bug: spacebarchat/server src/schemas/uncategorised/ActivitySchema.ts
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

function installGatewaySendSanitiser() {
    if (originalWebSocket) return;

    const OriginalWebSocket = originalWebSocket = window.WebSocket;
    function PatchedWebSocket(this: unknown, url: string | URL, protocols?: string | string[]) {
        const ws = new OriginalWebSocket(url, protocols);
        if (isGatewayUrl(String(url))) {
            const send = ws.send.bind(ws);
            ws.send = data => send(typeof data === "string" ? sanitiseGatewayPayload(data) : data);
        }
        return ws;
    }
    PatchedWebSocket.prototype = OriginalWebSocket.prototype;
    Object.setPrototypeOf(PatchedWebSocket, OriginalWebSocket);
    window.WebSocket = PatchedWebSocket as unknown as typeof WebSocket;
}

function uninstallGatewaySendSanitiser() {
    if (!originalWebSocket) return;

    window.WebSocket = originalWebSocket;
    originalWebSocket = null;
}

// discord's cloud-upload attachment builder never renames the file for a
// spoiler, it only sets `is_spoiler:true` - a field spacebar's schema never
// added, which gets the whole message rejected with a 400. dropping the flag
// alone used to "fix" the send but silently threw the spoiler marking away,
// since spacebar (like every other spacebar client) only recognises the
// SPOILER_ filename prefix. bake that prefix in ourselves before dropping
// the flag, so the marking survives the trip through a schema that doesn't
// know about it.
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

// the video patch below replaces discord's real video component with a bare
// <video> tag (to fix its src resolution against spacebar's CDN), which
// drops that component's own spoiler handling along with everything else it
// did. this rebuilds just the blur/reveal overlay, gated the same way
// discord and every other spacebar client detect it: the SPOILER_ filename
// prefix, since spacebar's attachment schema doesn't send the flags field
// discord's own detection normally reads.
function SpoilerVideoComponent({ src, maxWidth, maxHeight }: { src: string; maxWidth: number; maxHeight: number; }) {
    const [revealed, setRevealed] = useState(false);

    return (
        <div className={cl("spoiler-wrapper")}>
            <video
                src={src}
                controls={revealed}
                preload="metadata"
                className={revealed ? undefined : cl("spoiler-video")}
                style={{ maxWidth, maxHeight, width: "100%" }}
            />
            {!revealed && (
                <div
                    role="button"
                    tabIndex={0}
                    aria-label="Spoiler"
                    className={cl("spoiler-overlay")}
                    onClick={() => setRevealed(true)}
                    onKeyDown={e => (e.key === "Enter" || e.key === " ") && setRevealed(true)}
                >
                    <span className={cl("spoiler-label")}>Spoiler</span>
                </div>
            )}
        </div>
    );
}

const SpoilerVideo = ErrorBoundary.wrap(SpoilerVideoComponent, { noop: true });

// audio and generic file attachments never receive discord's own
// getObscureReason check at all (their dispatch case doesn't pass it down),
// so patching that classifier alone leaves them fully visible. wrap them the
// same way as video: render discord's real component untouched, just cover
// it with our own reveal overlay when the filename says spoiler.
function SpoilerOverlayComponent({ children }: { children: ReactNode; }) {
    const [revealed, setRevealed] = useState(false);

    return (
        <div className={cl("spoiler-wrapper")}>
            <div className={revealed ? undefined : cl("spoiler-content")}>{children}</div>
            {!revealed && (
                <div
                    role="button"
                    tabIndex={0}
                    aria-label="Spoiler"
                    className={cl("spoiler-overlay")}
                    onClick={() => setRevealed(true)}
                    onKeyDown={e => (e.key === "Enter" || e.key === " ") && setRevealed(true)}
                >
                    <span className={cl("spoiler-label")}>Spoiler</span>
                </div>
            )}
        </div>
    );
}

const SpoilerOverlay = ErrorBoundary.wrap(SpoilerOverlayComponent, { noop: true });

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

    // the GIF picker sends `url`, which on Klipy is the HTML page for the GIF,
    // not the file itself - `gifSrc` is the real image. favourites only carry
    // a usable file in `src`, except when it's the mp4/webm search preview.
    resolveGifUrl(item: { url: string; src?: string; gifSrc?: string; }) {
        const withScheme = (url: string) => url.startsWith("//") ? `https:${url}` : url;

        if (item.gifSrc) return withScheme(item.gifSrc);
        if (item.src && !/\.(mp4|webm)(\?|$)/i.test(item.src)) return withScheme(item.src);
        return item.url;
    },

    renderSpoilerVideo(item: { originalItem?: { url?: string; filename?: string; }; downloadUrl?: string; }, maxWidth: number, maxHeight: number) {
        const src = item.originalItem?.url ?? item.downloadUrl ?? "";

        if (!item.originalItem?.filename?.startsWith("SPOILER_")) {
            return <video src={src} controls preload="metadata" style={{ maxWidth, maxHeight, width: "100%" }} />;
        }

        return <SpoilerVideo src={src} maxWidth={maxWidth} maxHeight={maxHeight} />;
    },

    wrapSpoiler(item: { originalItem?: { filename?: string; }; }, node: ReactNode) {
        if (!item.originalItem?.filename?.startsWith("SPOILER_")) return node;
        return <SpoilerOverlay>{node}</SpoilerOverlay>;
    },

    // discord's own upload pipeline is a more reliable place to fix this than
    // trying to catch the eventual network call: it runs once, synchronously,
    // on the real CloudUpload object, before the REST client builds anything.
    // baking the prefix in here and clearing .spoiler means is_spoiler never
    // gets constructed in the first place, on every send path uploadFiles()
    // covers, not just whichever one happens to call window.fetch directly.
    fixUploadSpoiler(upload: { filename: string; spoiler: boolean; }) {
        if (!upload.spoiler) return;
        if (!upload.filename.startsWith("SPOILER_")) upload.filename = "SPOILER_" + upload.filename;
        upload.spoiler = false;
    },

    // fixUploadSpoiler above only catches spoiler being set before the
    // presigned CDN url is requested, which happens almost immediately on
    // attach - toggling the native spoiler button afterward doesn't rename
    // anything, because that CDN filename is already permanent by then
    // (spacebar looks the attachment up by it later and ignores whatever
    // filename the send request claims). this reacts to the same toggle
    // Discord's own remove/re-attach buttons use (UploadManager.remove +
    // addFile, dispatching the exact actions those buttons dispatch) to
    // redo the upload under the correct name instead of trying to hold or
    // rename anything already in flight.
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
            UploadManager.addFile({ file: renamedFile, channelId, draftType });
        }
    },

    start() {
        startGuildOrderSync();
        startDMUnreadPoll();
        installFetchSanitiser();
        installGatewaySendSanitiser();

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
    },

    patches: [
        {
            find: "async uploadFiles(",
            replacement: {
                match: /async uploadFiles\((\i)\){/,
                replace: "$&$1.forEach($self.fixUploadSpoiler);"
            }
        },
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
            predicate: () => !settings.store.useNativeVideoPlayer,
            replacement: {
                match: /case"VIDEO":case"CLIP":return\(0,(?:\w+\.\w+)\)\(\w+,\{item:(\w+),[^}]*\}\)/,
                replace: (match: string, item: string) =>
                    `case"VIDEO":case"CLIP":return $self.renderSpoilerVideo(${item},_||640,D||400)`
            }
        },
        // audio, generic files, and plaintext previews never get discord's
        // getObscureReason passed to their case at all, unlike image/video -
        // wrap their (untouched) render output in our own overlay instead of
        // chasing whichever internal classifier those components use.
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
        // spacebar's attachment schema never sends the `flags` field discord's
        // spoiler detection is normally computed from. this feeds `item.spoiler`
        // (composer/download-button UI), which isn't what actually decides
        // whether a non-video attachment renders blurred - see the
        // getObscureReason patch below for that. fall back to the SPOILER_
        // filename prefix here too, same convention discord itself used to
        // rely on and every spacebar client still does.
        // the flags source here can be either the raw attachment or a
        // wrapper item that nests it under `.originalItem` depending on call
        // site - check both rather than assume one shape.
        // "IS_SPOILER)" also occurs in the getObscureReason classifier below,
        // with a different shape (no `spoiler:` prefix) - match correctly
        // skips it, noWarn quiets the resulting "had no effect" here.
        {
            find: "IS_SPOILER)",
            replacement: {
                match: /spoiler:(\(0,\i\.\i\)\((\i)\.flags\?\?0,\i\.\i\.IS_SPOILER\))/,
                replace: 'spoiler:($2.filename??$2.originalItem?.filename)?.startsWith("SPOILER_")||$1',
                noWarn: true
            }
        },
        // this is the function that gates the blur/reveal overlay for image
        // attachments (video/audio/file are handled by the patches above
        // instead, since their dispatch cases never call this at all). it
        // reads the same missing `flags` field through a separate call path
        // from the `spoiler:` property patched above, so fixing that one
        // alone left image spoilers rendering fully visible despite the
        // correct SPOILER_ filename. the destructured param is treated as the
        // raw attachment inside this function, but the caller we found live
        // passes the wrapper item instead - filename can be on either
        // depending on call site, so check both.
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
        // discord's settings-proto writer throws on an empty string in a
        // uint64 field, uncaught, which stalls that store's whole save queue
        // forever. spacebar's guild/onboarding gaps are what leave a field
        // empty instead of discord's own literal "0" default - treat "" as
        // zero, same as the existing "0" case one line above in the source.
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
