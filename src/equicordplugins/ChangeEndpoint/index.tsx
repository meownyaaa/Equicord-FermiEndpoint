/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./components/styles.css";

import ErrorBoundary from "@components/ErrorBoundary";
import { WebsiteIcon } from "@components/Icons";
import SettingsPlugin from "@plugins/_core/settings";
import { getIntlMessage } from "@utils/discord";
import { Logger } from "@utils/Logger";
import { parseUrl, removeFromArray } from "@utils/misc";
import { openModalLazy } from "@utils/modal";
import definePlugin, { PluginNative } from "@utils/types";
import type { GuildFeatures, User } from "@vencord/discord-types";
import { extractAndLoadChunksLazy, findByCodeLazy, findByPropsLazy, findComponentByCodeLazy, findLazy, findStoreLazy } from "@webpack";
import { AuthenticationStore, Avatar, Button, ChannelStore, Constants, ContextMenuApi, DraftType, FluxDispatcher, GIFPickerViewStore, GuildStore, LocaleStore, MaskedLink, Menu, MessageStore, NavigationRouter, PresenceStore, RestAPI, SelectedChannelStore, SettingsRouter, showToast, Text, useRef, UserStore, useState } from "@webpack/common";
import type { ComponentType, ReactElement, ReactNode } from "react";

import { guildifyAst } from "./guildTerminology";
import { PREDEFINED_SERVERS } from "./servers";
import { migrateCustomServers, migrateDefaultBackend, migrateVideoPlayerSetting, settings } from "./settings";
import { DiscordSpoiler } from "./spoiler";

const AuthActions = findLazy(m => typeof m?.A?.logoutInternal === "function" && m.A.logoutInternal.name === "logoutInternal" && typeof m.A.login === "function");
const Native = VencordNative.pluginHelpers.ChangeEndpoint as PluginNative<typeof import("./native")>;

interface MultiAccountUser {
    id: string;
    username: string;
    avatar: string | null;
    discriminator: string;
    tokenStatus: number;
}

const MultiAccountStore: { getUsers(): MultiAccountUser[]; } = findStoreLazy("MultiAccountStore");
const TokenStorage: { getToken(userId: string): string | null | undefined; setToken(token: string, userId: string): void; } = findByPropsLazy("getToken", "setToken", "hideToken");
const switchToAccount: (userId: string) => Promise<unknown> = findByCodeLazy("MULTI_ACCOUNT_SWITCH_START");
const UserRecord: typeof User = findLazy(m => m?.prototype?.getAvatarURL);
const CircleCheckIcon = findComponentByCodeLazy("M12 23a11 11 0 1 0 0-22 11 11 0 0 0 0 22Zm5.7-13.3");
const CircleWarningIcon = findComponentByCodeLazy("M12 23a11 11 0 1 0 0-22 11 11 0 0 0 0 22Zm1.44-15.94");

interface GoLiveEngine {
    getDesktopSource(quality: { width: number; height: number; }, wantsAudio: boolean): Promise<string>;
    // null clears the current desktop source for that context
    setGoLiveSource(source: { desktopDescription: { id: string; }; } | null, context: "stream"): void;
}
const GoLiveMediaEngineStore = findStoreLazy("MediaEngineStore") as { getMediaEngine(): GoLiveEngine; };
import { captureConnectedBackend, connectedBackend, getApiEndpoint, getCdnHost, getGatewayEndpoint, getMediaProxyEndpoint } from "./utils";
import { CustomVideoPlayer } from "./videoPlayer";

const logger = new Logger("ChangeEndpoint");

const GuildActionCreators = findByPropsLazy("moveById", "createGuildFolderLocal");
const SortedGuildStore = findStoreLazy("SortedGuildStore");
const UploadManager = findByPropsLazy("clearAll", "addFile");
const UploadAttachmentStore = findByPropsLazy("getUploadCount");
// fieldset wrapper used by every group in channel settings > overview (name, slowmode, content visibility...)
const SettingsFieldset = findComponentByCodeLazy("tag:\"legend\"");

// discord's own avatar/icon crop modal, chunked separately from the settings page that normally opens it
const loadIconCropModalChunks = extractAndLoadChunksLazy(["GUILD_ICON", "imageUri:", "onCrop:"]);
const IconCropModal = ErrorBoundary.wrap(findComponentByCodeLazy("showUpsellHeader", "cropAspectRatio"), { noop: true });

interface IconCropResult {
    imageUri: string;
}

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
let pollRunning = false;
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
    const knownIds = new Set(GuildStore.getGuildIds());
    const uniqueIds = new Set(folders.flatMap(f => f.guild_ids.filter(Boolean)));
    const missing = [...uniqueIds].filter(id => !knownIds.has(id));

    if (missing.length > 0) {
        logger.debug(`Guilds not fully loaded yet (${uniqueIds.size - missing.length}/${uniqueIds.size}), deferring order apply`, missing);
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
    pollRunning = true;
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
        pollRunning = false;
        if (pollingStarted) pollTimer = setTimeout(pollSavedGuildOrder, POLL_INTERVAL);
    }
}

const GUILD_ORDER_EVENTS = ["GUILD_MOVE_BY_ID", "GUILD_FOLDER_CREATE_LOCAL", "GUILD_FOLDER_EDIT_LOCAL", "GUILD_FOLDER_DELETE_LOCAL"];

function startGuildOrderSync() {
    GUILD_ORDER_EVENTS.forEach(e => FluxDispatcher.subscribe(e, schedulePush));
    if (!settings.store.legacyGuildOrderSync || pollingStarted) return;
    pollingStarted = true;
    if (!pollRunning) pollSavedGuildOrder();
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
let dmPollRunning = false;

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
// possibly non functional? i dont get enough dms to know
// gotta check that in the future, but its low priority

async function pollDMUnreads() {
    dmPollRunning = true;
    try {
        const res = await RestAPI.get({ url: "/users/@me/channels" });
        const channels: Array<{ id: string; last_message_id: string | null; type: number; }> = res?.body ?? [];
        await Promise.all(channels.map(checkChannelForMissedMessage));
    } catch (e) {
        logger.error("Failed to poll DM unreads", e);
    } finally {
        dmPollRunning = false;
        if (dmPollingStarted) dmPollTimer = setTimeout(pollDMUnreads, DM_POLL_INTERVAL);
    }
}

function onDMPollConnectionOpen() {
    if (dmPollTimer || dmPollRunning) return;
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

function sanitiseGatewayPayload(data: string) {
    if (!data.includes('"op":3')) return data;

    try {
        const payload = JSON.parse(data);
        if (payload?.op !== 3 || !Array.isArray(payload.d?.activities)) return data;

        let changed = false;
        for (const activity of payload.d.activities) {
            const meta = activity?.metadata;
            if (meta && !(meta.album_id && meta.artist_ids)) {
                delete activity.metadata;
                changed = true;
            }

            if (activity && typeof activity.flags === "number") {
                activity.flags = String(activity.flags);
                changed = true;
            }
        }

        if (!changed) return data;

        logger.debug("Sanitised a presence update (metadata/flags) to avoid a 4002 close");
        return JSON.stringify(payload);
    } catch {
        return data;
    }
}
// metadata stripping still not finished, still get a 4002 in some
// cases with RPC but mostly functional now

function installGatewaySendSanitiser() {
    if (originalSend) return;
    originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (this: WebSocket, data: any) {
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

const DaveHandlerModule = findLazy(m => m?.prototype?._handleClientConnect);
let originalHandleClientConnect: ((e: unknown, ...rest: unknown[]) => unknown) | null = null;

function toArray(value: unknown): unknown[] {
    if (Array.isArray(value)) return value;
    if (value == null) return [];
    // a bare user id string is iterable char-by-char, which isn't what we want here
    if (typeof value === "string") return [value];
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

let originalGetActivities: typeof PresenceStore.getActivities | null = null;

function installActivityUnfilter() {
    if (originalGetActivities) return;
    originalGetActivities = PresenceStore.getActivities;
    PresenceStore.getActivities = (userId: string, guildId?: string) => PresenceStore.getUnfilteredActivities(userId, guildId);
}

function uninstallActivityUnfilter() {
    if (!originalGetActivities) return;
    PresenceStore.getActivities = originalGetActivities;
    originalGetActivities = null;
}

async function startWebEngineGoLiveSource(sourceId: string, sourceName?: string) {
    try {
        await Native.setPendingScreenShareSource(sourceName ?? null);
        const engine = GoLiveMediaEngineStore.getMediaEngine();
        const desktopSourceId = await engine.getDesktopSource({ width: 1920, height: 1080 }, true);
        engine.setGoLiveSource({ desktopDescription: { id: desktopSourceId } }, "stream");
    } catch (e) {
        logger.error("Failed to start web engine screen share source", e);
    }
}

function stopWebEngineGoLiveSource() {
    try {
        GoLiveMediaEngineStore.getMediaEngine().setGoLiveSource(null, "stream");
    } catch (e) {
        logger.error("Failed to stop web engine screen share source", e);
    }
}

function goLiveInterceptor(payload: { type: string; sourceId?: string; sourceName?: string; }) {
    if (payload.type === "STREAM_START" && payload.sourceId != null) {
        startWebEngineGoLiveSource(payload.sourceId, payload.sourceName);
    } else if (payload.type === "STREAM_STOP") {
        stopWebEngineGoLiveSource();
    }
    return false;
}

function removeInterceptor(interceptor: unknown) {
    removeFromArray(FluxDispatcher._interceptors, i => i === interceptor);
}

let originalPermissionsQuery: Permissions["query"] | null = null;

const SNOWFLAKE_AS_NAME = /^\d{14,22}$/;

// six seveennnnnnnnn (boosts amount to unlock boost paywalled features)
const MAX_PREMIUM_TIER = 3;
const MAX_PREMIUM_SUBSCRIPTION_COUNT = 67;
const BOOST_FEATURES: GuildFeatures[] = [
    "ANIMATED_ICON", "ANIMATED_BANNER", "BANNER", "INVITE_SPLASH", "VANITY_URL",
    "MORE_EMOJI", "MORE_STICKERS", "MORE_SOUNDBOARD", "ROLE_ICONS", "ROLE_SUBSCRIPTIONS_ENABLED"
];

function maxOutGuildPremium(guild: any) {
    if (!guild) return;
    const properties = guild.properties ?? guild;
    properties.premium_tier = MAX_PREMIUM_TIER;
    properties.features = Array.from(new Set([...(properties.features ?? []), ...BOOST_FEATURES]));
    guild.premium_subscription_count = MAX_PREMIUM_SUBSCRIPTION_COUNT;
}

// guilds that finished loading before this interceptor was installed never
// pass through it, so they'd stay stuck at tier 0 forever. patch those directly too.
function maxOutLoadedGuilds() {
    for (const guild of GuildStore.getGuildsArray()) {
        guild.premiumTier = MAX_PREMIUM_TIER;
        guild.premiumSubscriberCount = MAX_PREMIUM_SUBSCRIPTION_COUNT;
        for (const feature of BOOST_FEATURES) guild.features.add(feature);
    }
    GuildStore.emitChange();
}

function boostPerkInterceptor(event: any) {
    switch (event.type) {
        case "GUILD_CREATE":
        case "GUILD_UPDATE":
            maxOutGuildPremium(event.guild);
            break;
        case "READY":
        case "CONNECTION_OPEN":
            event.guilds?.forEach(maxOutGuildPremium);
            break;
    }
    return false;
}

function installBoostPerkUnlocker() {
    maxOutLoadedGuilds();
    FluxDispatcher.addInterceptor(boostPerkInterceptor);
}

function fixReactionEmoji(emoji: any) {
    if (!emoji || emoji.id || !SNOWFLAKE_AS_NAME.test(emoji.name ?? "")) return;
    // some spacebar backends omit the emoji id on older reactions(unconfirmed) and dump the snowflake into name instead,
    // which makes the client treat it as a unicode emoji and render the raw digits
    emoji.id = emoji.name;
    emoji.animated ??= true;
}

function sanitiseReactionPayload(payload: any) {
    fixReactionEmoji(payload?.reaction?.emoji ?? payload?.emoji);

    const messages = payload?.messages ?? (payload?.message ? [payload.message] : []);
    for (const message of messages) {
        for (const reaction of message?.reactions ?? []) fixReactionEmoji(reaction?.emoji);
    }
}

function reactionEmojiInterceptor(payload: unknown) {
    if (getCdnHost() != null) sanitiseReactionPayload(payload);
    return false;
}

const MESSAGE_URL_RE = /\/channels\/\d+\/messages(\/\d+)?$/;
// ^ lowkey forgot what this does, dont remove unless yk what it is

// discord sends guild profile (server tag) reads/writes to /guilds/{id}/profile,
// but spacebar never grew that route - it just uses /guilds/{id} for everything
const GUILD_PROFILE_URL_RE = /(\/guilds\/\d+)\/profile$/;
// profile-only fields the plain guild route doesn't know about, spacebar chokes on these.
// description is NOT one of these - GuildUpdateSchema on /guilds/{id} supports it directly.
const GUILD_PROFILE_ONLY_KEYS = ["brand_color_primary", "traits", "game_application_ids", "visibility"];

function stripGuildProfileOnlyFields(body: string) {
    try {
        const payload = JSON.parse(body);
        for (const key of GUILD_PROFILE_ONLY_KEYS) delete payload[key];
        if ("custom_banner" in payload) {
            payload.banner = payload.custom_banner;
            delete payload.custom_banner;
        }
        return JSON.stringify(payload);
    } catch {
        return body;
    }
}

// the client's guild profile response parser reads icon_hash/custom_banner_hash,
// not icon/banner - the plain guild route we redirect to only has the latter,
// so without this the icon/banner show up blank until something else refetches them
function expandGuildProfileFields(payload: any) {
    if (payload && typeof payload === "object") {
        if ("icon" in payload) payload.icon_hash = payload.icon;
        if ("banner" in payload) payload.custom_banner_hash = payload.banner;
    }
    return payload;
}

function expandToProfileShape(body: string) {
    try {
        return JSON.stringify(expandGuildProfileFields(JSON.parse(body)));
    } catch {
        return body;
    }
}

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
    window.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const { pathname } = new URL(url, location.origin);

        if (GUILD_PROFILE_URL_RE.test(pathname)) {
            const newUrl = url.replace(GUILD_PROFILE_URL_RE, "$1");
            logger.debug(`redirecting ${pathname} to the plain guild route, spacebar doesn't have a /profile endpoint`);
            if (init && typeof init.body === "string") {
                init = { ...init, body: stripGuildProfileOnlyFields(init.body) };
            }
            const response = await OriginalFetch(newUrl, init);
            const text = await response.text();
            return new Response(expandToProfileShape(text), {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers
            });
        }

        if (init && (init.method === "POST" || init.method === "PATCH") && typeof init.body === "string") {
            if (MESSAGE_URL_RE.test(pathname)) {
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

let originalXHROpen: typeof XMLHttpRequest.prototype.open | null = null;
let originalXHRSend: typeof XMLHttpRequest.prototype.send | null = null;
const flaggedGuildProfileRequests = new WeakSet<XMLHttpRequest>();

function requireNativeGetter(descriptor: PropertyDescriptor | undefined): () => any {
    if (!descriptor?.get) throw new Error("expected a native accessor getter");
    return descriptor.get;
}

const xhrResponseTextGetter = requireNativeGetter(Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, "responseText"));
const xhrResponseGetter = requireNativeGetter(Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, "response"));

// mirrors expandToProfileShape for XHR - responseText/response are native getters,
// so they're overridden per-instance rather than patched at the body level like send()
function installGuildProfileResponseExpander(xhr: XMLHttpRequest) {
    Object.defineProperty(xhr, "responseText", {
        configurable: true,
        get() {
            const raw = xhrResponseTextGetter.call(this);
            return this.readyState === 4 ? expandToProfileShape(raw) : raw;
        }
    });
    Object.defineProperty(xhr, "response", {
        configurable: true,
        get() {
            const raw = xhrResponseGetter.call(this);
            if (this.readyState !== 4) return raw;
            return this.responseType === "json" ? expandGuildProfileFields(raw) : expandToProfileShape(raw);
        }
    });
}

function installXHRSanitiser() {
    if (originalXHROpen) return;

    const OriginalOpen = originalXHROpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...rest: any[]) {
        const urlStr = url instanceof URL ? url.href : url;
        const { pathname } = new URL(urlStr, location.origin);

        if (GUILD_PROFILE_URL_RE.test(pathname)) {
            url = urlStr.replace(GUILD_PROFILE_URL_RE, "$1");
            logger.debug(`redirecting ${pathname} to the plain guild route, spacebar doesn't have a /profile endpoint`);
            flaggedGuildProfileRequests.add(this);
            installGuildProfileResponseExpander(this);
        }

        const gifProvider = GIF_API_RE.test(pathname) && currentGifProvider();
        if (gifProvider) {
            const withProvider = new URL(urlStr, location.origin);
            withProvider.searchParams.set("provider", gifProvider);
            url = withProvider.href;
        }

        return Reflect.apply(OriginalOpen, this, [method, url, ...rest]);
    };

    const OriginalSend = originalXHRSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
        if (flaggedGuildProfileRequests.has(this)) {
            flaggedGuildProfileRequests.delete(this);
            if (typeof body === "string") body = stripGuildProfileOnlyFields(body);
        }
        return OriginalSend.call(this, body);
    };
}

function uninstallXHRSanitiser() {
    if (!originalXHROpen) return;
    XMLHttpRequest.prototype.open = originalXHROpen;
    originalXHROpen = null;
    if (originalXHRSend) {
        XMLHttpRequest.prototype.send = originalXHRSend;
        originalXHRSend = null;
    }
}

const ALT_INVITE_HOST = "sbar.fyi";
const ALT_INVITE_PATHS = ["/invite", "/i"];

function isAltInviteHostName(host?: string | null) {
    return host === ALT_INVITE_HOST || !!host?.endsWith(`.${ALT_INVITE_HOST}`);
}

interface ChannelWithIcon {
    id: string;
    icon?: string;
}

const channelIconComponents = new Map<string, ComponentType<{ className?: string; }>>();

const ChannelIconEditor = ErrorBoundary.wrap(function ({ channel }: { channel: ChannelWithIcon; }) {
    const inputRef = useRef<HTMLInputElement>(null);
    const [uploading, setUploading] = useState(false);

    async function patchIcon(icon: string | null) {
        setUploading(true);
        try {
            await RestAPI.patch({ url: `/channels/${channel.id}`, body: { icon } });
            showToast(icon ? "channel icon updated" : "channel icon cleared", "success");
        } catch (e) {
            showToast("failed to update channel icon", "failure");
        } finally {
            setUploading(false);
        }
    }

    async function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (!file) return;

        const reader = new FileReader();
        const imageUri = await new Promise<string | null>(resolve => {
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(file);
        });
        if (!imageUri) return showToast("couldn't read that image", "failure");

        await loadIconCropModalChunks();
        openModalLazy(async () => props => (
            <IconCropModal
                uploadType="GUILD_ICON"
                imageUri={imageUri}
                file={file}
                onCrop={(result: IconCropResult) => patchIcon(result.imageUri)}
                {...props}
            />
        ));
    }

    return (
        <SettingsFieldset label="Channel Icon">
            <div>
                <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                    <div
                        onClick={() => !uploading && inputRef.current?.click()}
                        style={{
                            width: 48, height: 48, borderRadius: "8px", overflow: "hidden",
                            cursor: uploading ? "default" : "pointer", background: "var(--background-secondary)",
                            display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0
                        }}
                    >
                        {channel.icon
                            ? <img src={`https://${getCdnHost()}/channel-icons/${channel.id}/${channel.icon}.png`} alt="" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
                            : <WebsiteIcon />}
                    </div>
                    <input ref={inputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={onFileChosen} />
                    <Button size={Button.Sizes.SMALL} disabled={uploading} onClick={() => inputRef.current?.click()}>
                        Change Icon
                    </Button>
                    {channel.icon && (
                        <Button size={Button.Sizes.SMALL} color={Button.Colors.RED} disabled={uploading} onClick={() => patchIcon(null)}>
                            Remove
                        </Button>
                    )}
                </div>
                <Text variant="text-xs/normal" color="text-muted" style={{ marginTop: "8px" }}>Shown in the channel list in place of the default icon.</Text>
            </div>
        </SettingsFieldset>
    );
}, { noop: true });

function getLinkedBackend(userId: string) {
    const backend = settings.store.accountBackends[userId];
    const exists = PREDEFINED_SERVERS.some(s => s.id === backend) || settings.store.customServers.some(s => s.id === backend);
    return exists && backend !== connectedBackend ? backend : null;
}

function accountAvatarURL(user: User) {
    const saved = settings.store.accountAvatars[user.id];
    return saved && saved.backend !== connectedBackend ? saved.url : user.getAvatarURL(undefined, 40);
}

function saveAccountAvatar() {
    const user = UserStore.getCurrentUser();
    if (!user || !connectedBackend) return;

    const url = user.getAvatarURL(undefined, 80);
    const saved = settings.store.accountAvatars[user.id];
    if (saved?.url === url && saved.backend === connectedBackend) return;

    settings.store.accountAvatars = { ...settings.plain.accountAvatars, [user.id]: { url, backend: connectedBackend } };
}

const withHttps = (endpoint: string) => /^\w+:\/\//.test(endpoint) ? endpoint : "https:" + endpoint;

const GIF_API_RE = /\/gifs\/(?:search|trending|trending-gifs|suggest|trending-search)$/;
const GIF_PROVIDER_NAMES: Record<string, string> = { klipy: "Klipy", giphy: "GIPHY", tenor: "Tenor" };
const GIF_PROVIDER_KEYS: Array<"gifProvider"> = ["gifProvider"];
let gifProviders: string[] = [];

const gifProviderName = (provider: string) => GIF_PROVIDER_NAMES[provider] ?? provider;

function currentGifProvider(): string | undefined {
    const chosen = connectedBackend ? settings.store.gifProvider[connectedBackend] : undefined;
    if (chosen && gifProviders.includes(chosen)) return chosen;
    return gifProviders.includes("klipy") ? "klipy" : gifProviders[0];
}

async function loadGifProviders() {
    const api = getApiEndpoint();
    if (!api) return;

    try {
        const res = await fetch(new URL("/_spacebar/api/v1/integrations/gif", withHttps(api)));
        if (res.ok) {
            const { providers }: { providers: Record<string, { available: boolean; }>; } = await res.json();
            gifProviders = Object.keys(providers).filter(p => providers[p].available);
            return;
        }
    } catch (e) {
        logger.debug("Instance has no Spacebar GIF integrations endpoint", e);
    }

    try {
        const { body } = await RestAPI.get({ url: "/gifs" });
        gifProviders = body.map((p: { api_name: string; }) => p.api_name);
    } catch (e) {
        logger.debug("Instance doesn't list its GIF providers", e);
    }
}

async function selectGifProvider(provider: string) {
    if (!connectedBackend || provider === currentGifProvider()) return;
    settings.store.gifProvider = { ...settings.plain.gifProvider, [connectedBackend]: provider };

    const query = GIFPickerViewStore.getQuery();
    const params = { media_format: GIFPickerViewStore.getSelectedFormat(), locale: LocaleStore.locale };
    try {
        if (query) {
            const { body } = await RestAPI.get({ url: Constants.Endpoints.GIFS_SEARCH, query: { ...params, q: query } });
            FluxDispatcher.dispatch({ type: "GIF_PICKER_QUERY_SUCCESS", items: body });
            return;
        }

        const [trending, trendingGifs] = await Promise.all([
            RestAPI.get({ url: Constants.Endpoints.GIFS_TRENDING, query: params }),
            RestAPI.get({ url: Constants.Endpoints.GIFS_TRENDING_GIFS, query: params })
        ]);
        FluxDispatcher.dispatch({ type: "GIF_PICKER_TRENDING_FETCH_SUCCESS", trendingCategories: trending.body.categories, trendingGIFPreview: trending.body.gifs[0] });
        FluxDispatcher.dispatch({ type: "GIF_PICKER_QUERY_SUCCESS", items: trendingGifs.body });
    } catch (e) {
        logger.error(`Couldn't load GIFs from ${provider}`, e);
        showToast(`Couldn't load GIFs from ${gifProviderName(provider)}.`, "failure");
    }
}

const GifProviderTabs = ErrorBoundary.wrap(function GifProviderTabs() {
    settings.use(GIF_PROVIDER_KEYS);
    if (gifProviders.length < 2) return null;

    const current = currentGifProvider();
    return (
        <div className="vc-endpoint-gif-providers">
            {gifProviders.map(provider => (
                <Button
                    key={provider}
                    size={Button.Sizes.SMALL}
                    color={provider === current ? Button.Colors.BRAND : Button.Colors.PRIMARY}
                    onClick={() => selectGifProvider(provider)}
                >
                    {gifProviderName(provider)}
                </Button>
            ))}
        </div>
    );
}, { noop: true });

function openSwitchAccountLanding() {
    AuthActions?.A?.logoutInternal?.({ isSwitchingAccount: true });
    NavigationRouter.transitionTo("/login");
}

const serverWithCodeOfConduct = () => PREDEFINED_SERVERS.find(s => s.id === settings.store.backend && s.codeOfConduct);

const GATEWAY_AUTH_FAILURE = /invalid token|user not found|user disabled|failed to decode token|unsupported token algorithm/i;

function AccountSwitcherMenu({ onClose }: { onClose(): void; }) {
    const currentId = AuthenticationStore.getId();

    return (
        <Menu.Menu navId="vc-endpoint-switch-account" onClose={onClose}>
            {MultiAccountStore.getUsers().map(account => {
                const user = new UserRecord(account);
                const invalid = account.tokenStatus === 0 && !getLinkedBackend(account.id);

                return (
                    <Menu.MenuItem
                        key={account.id}
                        id={account.id}
                        label={
                            <div className="vc-endpoint-account-row">
                                <Avatar src={accountAvatarURL(user)} size="SIZE_24" aria-label={account.username} />
                                <div className="vc-endpoint-account-name">
                                    <Text variant="text-sm/normal">{account.username}</Text>
                                    {!user.hasUniqueUsername() && <Text variant="text-sm/normal">#{account.discriminator}</Text>}
                                </div>
                                {account.id === currentId && <CircleCheckIcon size="sm" color="var(--brand-500)" secondaryColor="var(--white-500)" />}
                                {invalid && <CircleWarningIcon size="xs" color="var(--red-400)" secondaryColor="var(--white-500)" />}
                            </div>
                        }
                        action={() => {
                            if (account.id === currentId) return;
                            if (invalid) openSwitchAccountLanding();
                            else switchToAccount(account.id);
                        }}
                    />
                );
            })}
            <Menu.MenuSeparator />
            <Menu.MenuItem id="manage-accounts" label="Manage Accounts" action={openSwitchAccountLanding} />
        </Menu.Menu>
    );
}

export default definePlugin({
    name: "ChangeEndpoint",
    description: "Redirects Discord API, CDN and gateway traffic to a Spacebar backend.",
    authors: [],
    // to add author ids for both my harmony and spacebar accounts, forgot how its
    // formatted though, and im too lazy tbh
    required: true,
    // dont be a dumbass and set this to false/remove it, its basically
    // crucial to the plugin persisting and working..
    settings,

    toolboxActions: {
        "Open ChangeEndpoint": () => {
            SettingsRouter.openUserSettings("equicord_change_endpoint_panel");
        },
    },

    getAltInviteRemainingPath(url: { host?: string | null; pathname?: string | null; }) {
        if (!isAltInviteHostName(url.host)) return null;
        const prefix = ALT_INVITE_PATHS.find(p => url.pathname?.startsWith(`${p}/`));
        return prefix ? url.pathname?.slice(prefix.length) ?? null : null;
    },

    isAltInviteHost(url: { host?: string | null; }) {
        return isAltInviteHostName(url.host);
    },

    withHttps,

    guildifyAst,

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

    renderChannelIcon(channel: { id: string; icon: string; }) {
        const key = `${channel.id}/${channel.icon}`;
        let Icon = channelIconComponents.get(key);
        if (!Icon) {
            Icon = ErrorBoundary.wrap(({ className }: { className?: string; }) => (
                <img className={className} src={`https://${getCdnHost()}/channel-icons/${key}.png`} alt="" />
            ), { noop: true });
            channelIconComponents.set(key, Icon);
        }
        return Icon;
    },

    renderChannelIconEditor(channel: ChannelWithIcon) {
        return <ChannelIconEditor key="channel-icon-editor" channel={channel} />;
    },

    channelIconMemoEqual(a: any, b: any) {
        return a.channel === b.channel && a.channel.icon === b.channel.icon &&
            a.className === b.className && a.containerClassName === b.containerClassName &&
            a.locked === b.locked && a.hasActiveThreads === b.hasActiveThreads &&
            a.hasUsersInVoiceChannel === b.hasUsersInVoiceChannel;
    },

    getEveryoneColorRole(guildRoles: Record<string, ColorRole>) {
        const everyone = Object.values(guildRoles).find(r => r.id === r.guildId);
        return everyone && everyone.color > 0 ? everyone : undefined;
    },

    // sets the active backend then reloads, since endpoints are baked into GLOBAL_ENV at boot
    // maybe i could complicate this and have it half reload? client takes a while to initially
    // start up, faster switch times would be nicer
    switchBackend(id: string) {
        settings.store.backend = id;
        location.reload();
    },

    openBackendMenu(e: React.MouseEvent) {
        const custom = settings.store.customServers;
        ContextMenuApi.openContextMenu(e, () => (
            <Menu.Menu navId="change-endpoint-switch-backend" onClose={ContextMenuApi.closeContextMenu}>
                {PREDEFINED_SERVERS.map(s => (
                    <Menu.MenuItem key={s.id} id={s.id} label={s.name} action={() => this.switchBackend(s.id)} />
                ))}
                {custom.length > 0 && <Menu.MenuSeparator />}
                {custom.map(s => (
                    <Menu.MenuItem key={s.id} id={s.id} label={s.name} action={() => this.switchBackend(s.id)} />
                ))}
            </Menu.Menu>
        ));
    },

    onSwitchAccountClick(e: React.MouseEvent<HTMLButtonElement>) {
        if (e.detail > 1) {
            ContextMenuApi.closeContextMenu();
            openSwitchAccountLanding();
            return;
        }

        const { left, top } = e.currentTarget.getBoundingClientRect();
        const anchor: React.MouseEvent<HTMLButtonElement> = { ...e, pageX: left, pageY: top - 8, stopPropagation: () => e.stopPropagation(), preventDefault: () => e.preventDefault() };
        ContextMenuApi.openContextMenu(
            anchor,
            () => <AccountSwitcherMenu onClose={ContextMenuApi.closeContextMenu} />,
            { position: "top", align: "left", disableClickTrap: true }
        );
    },

    accountAvatarURL,

    gifSearchPlaceholder() {
        const provider = currentGifProvider();
        return !provider || provider === "klipy" ? getIntlMessage("SEARCH_KLIPY") : `Search ${gifProviderName(provider)}`;
    },

    renderGifProviderTabs(gifTab: ReactElement<{ isActive: boolean; }> | null) {
        return gifTab?.props.isActive ? <GifProviderTabs key="vc-endpoint-gif-providers" /> : null;
    },

    renderGuildGuidelines() {
        const server = serverWithCodeOfConduct();
        if (!server?.codeOfConduct) return null;
        return <>By creating a {settings.store.guildTerminology ? "guild" : "server"}, you agree to {server.name}'s <strong><MaskedLink href={server.codeOfConduct}>Code of Conduct</MaskedLink></strong>.</>;
    },

    onGatewayClose(code: number, reason?: string) {
        if (code !== 4000 || !GATEWAY_AUTH_FAILURE.test(reason ?? "")) return;
        logger.warn(`Gateway rejected the token (${reason}), opening the account picker`);
        setTimeout(openSwitchAccountLanding);
    },

    renderLinkedBackend(userId: string) {
        const backend = settings.store.accountBackends[userId];
        const name = PREDEFINED_SERVERS.find(s => s.id === backend)?.name ?? settings.store.customServers.find(s => s.id === backend)?.name;
        return name ? <Text className="vc-endpoint-linked-backend" variant="text-sm/normal" color="text-muted">{name}</Text> : null;
    },

    isLinkedElsewhere(userId: string) {
        return getLinkedBackend(userId) != null;
    },

    switchAccountBackend(userId: string) {
        const backend = getLinkedBackend(userId);
        const token = backend && TokenStorage.getToken(userId);
        if (!backend || !token) return false;

        TokenStorage.setToken(token, userId);
        settings.store.backend = backend;
        location.reload();
        return true;
    },

    // for the login page, gotta add it to the actual account switcher and not just
    // add account, i guess? add account page is more "stable" though, and already
    // has those style of buttons.. - gotta fix height though, once fixed ill remove this line, dash is the starting point
    renderSwitchBackendButton() {
        return (
            <Button
                key="change-endpoint-switch-backend"
                type="button"
                size={Button.Sizes.SMALL}
                look={Button.Looks.OUTLINED}
                color={Button.Colors.PRIMARY}
                onClick={e => this.openBackendMenu(e)}
            >
                Switch Backend
            </Button>
        );
    },

    // actual loading screen buttons, pretty self explanatory #lol
    renderLoadingScreenButtons() {
        return (
            <div className="vc-endpoint-loading-switch-wrapper">
                <Button
                    key="change-endpoint-loading-switch-backend"
                    type="button"
                    size={Button.Sizes.SMALL}
                    look={Button.Looks.OUTLINED}
                    color={Button.Colors.PRIMARY}
                    onClick={e => this.openBackendMenu(e)}
                >
                    Switch Backend
                </Button>
                <Button
                    key="change-endpoint-loading-switch-account"
                    type="button"
                    size={Button.Sizes.SMALL}
                    look={Button.Looks.OUTLINED}
                    color={Button.Colors.PRIMARY}
                    onClick={e => this.onSwitchAccountClick(e)}
                >
                    Switch Account
                </Button>
            </div>
        );
    },

    flux: {
        CONNECTION_OPEN() {
            saveAccountAvatar();
            loadGifProviders();
        },
        CURRENT_USER_UPDATE: saveAccountAvatar,

        UPLOAD_ATTACHMENT_UPDATE_FILE({ channelId, id, draftType, spoiler }: { channelId: string; id: string; draftType: number; spoiler?: boolean; }) {
            if (spoiler == null || draftType !== DraftType.ChannelMessage) return;
            // work of art, basically it makes spoilering on your own attachments ACTUALLY WORK!!!
            // i dont know if this is the exact section, but i dont care im proud of my baby
            // .. update i gotta fix smth related to the uploading images stuff as a whole
            // FUCK!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
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
        migrateDefaultBackend();
        migrateCustomServers();
        captureConnectedBackend();
        saveAccountAvatar();
        loadGifProviders();
        startGuildOrderSync();
        startDMUnreadPoll();
        installFetchSanitiser();
        installXHRSanitiser();
        installBoostPerkUnlocker();
        installGatewaySendSanitiser();
        installDaveClientConnectGuard();
        FluxDispatcher.addInterceptor(reactionEmojiInterceptor);
        installActivityUnfilter();

        SettingsPlugin.customEntries.push({
            key: "equicord_change_endpoint",
            title: "ChangeEndpoint",
            Component: require("./components/EndpointTab").default,
            Icon: WebsiteIcon
        });

        if (typeof DiscordNative === "undefined") return;

        Native.registerDisplayMediaHandler();
        FluxDispatcher.addInterceptor(goLiveInterceptor);

        const originalQuery = originalPermissionsQuery = navigator.permissions.query;
        navigator.permissions.query = (descriptor: PermissionDescriptor) => {
            if (descriptor.name === "camera" || descriptor.name === "microphone") {
                return Promise.resolve({
                    name: descriptor.name,
                    state: "granted",
                    onchange: null,
                    addEventListener() {},
                    removeEventListener() {},
                    dispatchEvent() { return true; }
                } satisfies PermissionStatus);
            }
            return originalQuery.call(navigator.permissions, descriptor);
        };
    },

    stop() {
        stopGuildOrderSync();
        stopDMUnreadPoll();
        uninstallFetchSanitiser();
        uninstallXHRSanitiser();
        uninstallGatewaySendSanitiser();
        uninstallDaveClientConnectGuard();
        removeInterceptor(boostPerkInterceptor);
        removeInterceptor(reactionEmojiInterceptor);
        removeInterceptor(goLiveInterceptor);
        uninstallActivityUnfilter();
        removeFromArray(SettingsPlugin.customEntries, e => e.key === "equicord_change_endpoint");

        if (originalPermissionsQuery) {
            navigator.permissions.query = originalPermissionsQuery;
            originalPermissionsQuery = null;
            Native.unregisterDisplayMediaHandler();
        }
    },

    patches: [
        {
            find: "recipients:i.recipients,bitrate:n.bitrate??i.bitrate}",
            // CHANNEL_UPDATE payloads that omit icon (e.g. a rename) get merged onto the
            // existing channel here - discord already re-adds bitrate the same way for the
            // same reason, icon just needs the same treatment
            replacement: {
                match: /\.merge\(\{\.\.\.(\i),recipients:(\i)\.recipients,bitrate:\1\.bitrate\?\?\2\.bitrate\}\)/,
                replace: ".merge({...$1,recipients:$2.recipients,bitrate:$1.bitrate??$2.bitrate,icon:$1.icon??$2.icon})"
            }
        },
        {
            find: "this.iconEmoji=e.iconEmoji,this.lastMessageId=",
            replacement: {
                match: /this\.iconEmoji=(\i)\.iconEmoji/g,
                replace: "this.icon=$1.icon,this.iconEmoji=$1.iconEmoji"
            }
        },
        {
            find: "icon_emoji),id:",
            all: true,
            replacement: {
                match: /(?<!icon:\i,)iconEmoji:(\i)\((\i)\.icon_emoji\)/g,
                replace: "icon:$2.icon,iconEmoji:$1($2.icon_emoji)"
            }
        },
        {
            find: '"ChannelItemIcon")',
            all: true,
            replacement: {
                match: /switch\((\i)\.type\)\{case (\i)\.rbe\.DM:/g,
                replace: "if($1.icon)return $self.renderChannelIcon($1);switch($1.type){case $2.rbe.DM:"
            }
        },
        {
            // the icon-selector row is wrapped in a bare React.memo (no comparator),
            // so an in-place channel.icon mutation on CHANNEL_UPDATE gets shallow-compared
            // away and the row never re-renders - give it a comparator that also checks icon
            find: '"ChannelItemIcon")',
            replacement: {
                match: /role:"img","aria-label":\i,className:\i\(\)\(\i\.\i,\i\),children:\i\}\)\}\)\}/,
                replace: "$&,$self.channelIconMemoEqual"
            }
        },
        {
            // channel settings > overview has no icon field at all for guild channels - inject
            // ours into renderChannelInfo's own field list, right after the topic field and
            // before the (forum-only, otherwise null) post-template field, so it lands between
            // "Channel Topic" and "Slowmode" instead of floating as its own top-level section
            find: "this.getChannelTopicTextAreaChannel(",
            replacement: {
                match: /\i&&\i&&!(\i)\.isGameInvitesChannel\(\)\?.{0,300}?:null(?=,\i=\i\.isForumLikeChannel\(\))/,
                replace: "[$self.renderChannelIconEditor($1),$&]"
            }
        },
        {
            find: "qos_token:",
            // this was the main cause of the Identify loop, fuck whoever added this for no reason.
            // its LITERALLY just a 'quality of service token' that tracks your client. (weirdos)
            // 'web.831e884588cb7b8b.js' was where it started :middle_finger:
            replacement: [
                {
                    match: /,client_state:\i(?=[,}])/g,
                    replace: ""
                },
                {
                    match: /,qos_token:\i(?=[,}])/g,
                    replace: ""
                }
            ]
        },
        {
            find: "native_build_number",
            replacement: {
                match: /(\i)\.native_build_number=(\i)/,
                replace: "$2"
            }
        },
        {
            find: "installation_id:n}:{}",
            replacement: {
                match: /null!=\i\?\{installation_id:\i\}:\{\}/,
                replace: "{}"
            }
        },
        {
            find: "os_arch:",
            replacement: [
                {
                    match: /,os_arch:\i(?=[,}])/g,
                    replace: ""
                },
                {
                    match: /,app_arch:\i(?=[,}])/g,
                    replace: ""
                }
            ]
        },
        {
            find: "os_sdk_version=",
            replacement: {
                match: /(\i)\.os_sdk_version=\i\?\.split\("\."\)\[\d\]/g,
                replace: "$1.os_sdk_version=void 0"
            }
        },
        // all that is to reduce any problems with Identify in the future
        // and to mainly reduce on the tracking sent over initially, which
        // isnt needed on spacebar or spacebar-adjacent servers
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
                match: /"https:"\+window\.GLOBAL_ENV\.API_ENDPOINT(?=\+\()/,
                replace: "($self.withHttps(window.GLOBAL_ENV.API_ENDPOINT))"
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
            // every intl message discord renders is built through this constructor, so rewriting
            // its ast here covers all ui text without touching user content like guild names
            find: "reserialize(){if(\"string\"==typeof this.ast)",
            predicate: () => settings.store.guildTerminology,
            replacement: {
                match: /(?<=this\.ast=)\(0,\i\.isCompressedAst\)\(\i\)\?\i:\(0,\i\.compressFormatJsToAst\)\(\i\)/,
                replace: "$self.guildifyAst($&,this.locale)"
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
            find: "#{intl::SEARCH_KLIPY}",
            replacement: {
                match: /\i\.intl\.string\(\i\.t#{intl::SEARCH_KLIPY}\)/,
                replace: "$self.gifSearchPlaceholder()"
            }
        },
        {
            find: 'analyticsSource:"expression-picker"',
            replacement: {
                match: /role:"tablist","aria-label":[^,]{0,60},children:\[(\i),/,
                replace: "$&$self.renderGifProviderTabs($1),"
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
                // pfp fix i think?
            }
        },
        {
            find: /getPremiumTypeOverride\(\)\{return \i\.premiumTypeOverride\}/,
            replacement: {
                match: /getPremiumTypeOverride\(\)\{return \i\.premiumTypeOverride\}/,
                replace: "getPremiumTypeOverride(){return 2}"
                // nitro trickery, not sure if fully functional
            }
        },
        {
            find: "features.has(a.GuildFeatures.ENHANCED_ROLE_COLORS)",
            all: true,
            replacement: {
                match: /\w+\.features\.has\(\w+\.GuildFeatures\.ENHANCED_ROLE_COLORS\)/g,
                replace: "true"
                // ig bro
            }
        },
        {
            find: "colorRoleId:void 0,hoistRoleId:void 0",
            // this is to fix role colors that are assigned to @everyone not showing
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
            find: /\.preferred_region=\i,\i\.preferred_regions=/,
            replacement: {
                match: /\((\i)\.preferred_region=(\i),\1\.preferred_regions=\i\)/,
                replace: "($1.preferred_region=$2)" // for vc connecting, crucial patch for that but client will work without it
            }
        },
        {
            find: /let\{width:\i,height:\i,maxWidth:\i,maxHeight:\i/,
            all: true,
            replacement: {
                match: /let\{width:(\i),height:(\i),maxWidth:(\i),maxHeight:(\i)(?:,minWidth:\i=0,minHeight:\i=0)?\}=\i[^;]{0,100};/g,
                replace: "$&null==$1&&($1=$3,$2=$4);"
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
            find: /let\{width:\i,height:\i\}=\i;return \i>0&&\i>0/,
            replacement: {
                match: /(let\{width:(\i),height:(\i)\}=\i;return )\2>0&&\3>0/,
                replace: "$1($2??1)>0&&($3??1)>0"
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
        /* {
            find: "get platformAlwaysPermits(){return",
            replacement: {
                match: /get platformAlwaysPermits\(\)\{return.{0,100}?\.checkPermissionsEnabled\}/,
                replace: "get platformAlwaysPermits(){return!0}"
            }
        },*/
        {
            find: /originalItem:\i,type:\(0,/,
            all: true,
            replacement: {
                match: /originalItem:(\i),type:\(0,(\i\.\i)\)\(([\w$,]+)\)/,
                replace: (_: string, item: string, fn: string, args: string) =>
                    `originalItem:${item},type:(()=>{let vcType=(0,${fn})(${args});return"OTHER"===vcType&&null!=${item}.content_type?(${item}.content_type.startsWith("video/")?"VIDEO":${item}.content_type.startsWith("image/")?"IMAGE":${item}.content_type.startsWith("audio/")?"AUDIO":vcType):vcType})()`
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
                match: /case"VIDEO":case"CLIP":return\(0,\i\.\i\)\(\i,\{item:(\i),[^}]{0,400}?maxWidth:(\i),maxHeight:(\i)[^}]{0,300}\}\)/,
                replace: 'case"VIDEO":case"CLIP":return $self.renderSpoilerVideo($1,$2||640,$3||400)'
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
                /*
                    might not be functional? i get a warning about this in logs, pretty sure the other
                    stuff is patching spoilers, not this
                */
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
                /*
                   gotta make the gif picker patches better at some point, right now theyre basic
                   and dont really fix the main problems, although they are good enough to work for
                   now, i dont feel like they will last especially when i eventually give up on this
                   plugin and send it into LTS at one point in the future
                */
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
        {
            find: "Switching accounts failed because there was no token",
            replacement: [
                {
                    match: /\i\.log\(`Switching account to \$\{(\i)\}`/,
                    replace: "if($self.switchAccountBackend($1))return Promise.resolve();$&"
                },
                {
                    match: /if\(null==(\i)\|\|""===\1\)return void (\i\.\i)\.dispatch\(\{type:"MULTI_ACCOUNT_VALIDATE_TOKEN_FAILURE",userId:(\i)\}\);/,
                    replace: '$&if($self.isLinkedElsewhere($3))return void $2.dispatch({type:"MULTI_ACCOUNT_VALIDATE_TOKEN_SUCCESS",userId:$3});'
                }
            ]
        },
        {
            find: "#{intl::CREATE_SERVER_GUIDELINES}",
            predicate: () => serverWithCodeOfConduct() != null,
            replacement: {
                match: /\i\.intl\.format\(\i\.t#{intl::CREATE_SERVER_GUIDELINES},\{guidelinesURL:[^}]{0,40}\}\)/,
                replace: "$self.renderGuildGuidelines()"
            }
        },
        {
            find: "[WS CLOSED] because of authentication failure, marking as closed.",
            replacement: {
                match: /_handleClose\((\i),(\i),(\i)\)\{/,
                replace: "$&$self.onGatewayClose($2,$3);"
            }
        },
        {
            find: 'navId:"manage-multi-account"',
            replacement: [
                {
                    match: /(color:"text-default",variant:"text-sm\/normal",children:\i\}\)\]\}\),\i)\]/,
                    replace: "$1,$self.renderLinkedBackend(arguments[0].user.id)]"
                },
                {
                    match: /src:(\i)\.getAvatarURL\(void 0,40\)/,
                    replace: "src:$self.accountAvatarURL($1)"
                }
            ]
        },
        {
            find: 'id:"manage-accounts"',
            replacement: {
                match: /src:(\i)\.getAvatarURL\(void 0,40\)(?=,size:\i\.\i\.SIZE_24,"aria-label":\i\.username)/,
                replace: "src:$self.accountAvatarURL($1)"
            }
        },
        {
            find: ".getIsValidatingUsers(),multiAccountUsers:",
            replacement: {
                match: /isLoading:\i\.\i\.getIsValidatingUsers\(\)/g,
                replace: "isLoading:!1"
            }
        },
        {
            find: "MULTI_ACCOUNT_SWITCH_LANDING",
            replacement: {
                match: /(children:\(0,\i\.jsx\)\(\i\.\i,\{variant:"secondary",size:"md",textVariant:"text-sm\/medium",text:\i\.intl\.string\(\i\.\i\["9g2mqT"\]\),onClick:\i\}\)\}\))\]\}\)\}/,
                replace: "$1,$self.renderSwitchBackendButton()]})}"
            }
        },
        {
            find: "username webauthn",
            replacement: {
                match: /(\i&&\i&&\(0,\i\.jsx\)\("div",\{className:\i\.AX,)children:(\(0,\i\.jsx\)\(\i\.\i,\{onClick:\(\)=>\i\(!1\),variant:"secondary",text:\i\.intl\.string\(\i\.t\["1MrpWO"\]\),icon:\i\.\i\}\))\}\)/,
                replace: "$1style:{display:\"flex\",alignItems:\"center\",gap:\"8px\"},children:[$2,$self.renderSwitchBackendButton()]})"
            }
        },
        {
            find: '"13/7kX"',
            replacement: {
                match: /leading:\(0,\i\.jsx\)\(\i\.\i,\{variant:"secondary",size:"md",onClick:(\i),text:(\i\.intl\.string\(\i\.\i\["13\/7kX"\]\)),type:"button"\}\)/,
                replace: 'leading:(0,r.jsxs)("div",{style:{display:"flex",alignItems:"center",gap:"8px"},children:[$self.renderSwitchBackendButton(),(0,r.jsx)(C.Q,{variant:"secondary",size:"md",onClick:$1,text:$2,type:"button"})]})'
            }
        },
        {
            find: "--connecting-container-fade-duration",
            replacement: {
                match: /(\(0,\i\.jsxs\)\("div",\{className:\i\(\)\(\i\.Bk,\{\[\i\.ly\]:this\.state\.problems\}\),children:\[\(0,\i\.jsx\)\("div",\{className:\i\.u1,children:\i\.intl\.string\(\i\.t\.AG2zPM\)\}\),\(0,\i\.jsxs\)\("div",\{children:\[\(0,\i\.jsxs\)\(\i\.Anchor,\{className:\i\.AR,href:\i\.\i\.TWITTER_SUPPORT,target:"_blank",children:\[\(0,\i\.jsx\)\(\i\.\i,\{size:"xs",color:"currentColor",className:\i\.Kk\}\),\i\.intl\.string\(\i\.t\.\i\)\]\}\),\(0,\i\.jsxs\)\(\i\.Anchor,\{className:\i\.gy,href:\i\.\i\.STATUS,target:"_blank",children:\[\(0,\i\.jsx\)\(\i,\{className:\i\.Kk\}\),\i\.intl\.string\(\i\.t\.\i\)\]\}\)\]\}\)\]\}\))/,
                replace: "$1,$self.renderLoadingScreenButtons()"
                /*
                   helper for the buttons on loading screen - i gotta make them persist for like a
                   second or two longer, sometimes backend will connect insanely fast and you get no
                   chance to click them. also, gotta fix the issue where sometimes the "logout" will
                   break the entire client; see https://softgaypaws.com/assets/etc/example-m3sD.png
                */
            }
        },
        {
            // the invite-host-remaining-path extractor (also handles the template/primary
            // hosts the same way) - inviteHostRemainingPath/templateHostRemainingPath/
            // primaryHostRemainingPath are real property keys, stable across discord's own renames
            find: "inviteHostRemainingPath:null,templateHostRemainingPath:null,primaryHostRemainingPath:null",
            replacement: {
                match: /inviteHostRemainingPath:null,templateHostRemainingPath:null,primaryHostRemainingPath:null\};let \i=\i\(\i,(\i)\)/,
                replace: "$&??$self.getAltInviteRemainingPath($1)"
            }
        },
        {
            // discord only checks its own INVITE_HOST (plus gift code/template hosts) for
            // "is this a trusted domain" - add the alt host as another early-return case
            find: "GLOBAL_ENV.GIFT_CODE_HOST:case window.GLOBAL_ENV.GUILD_TEMPLATE_HOST:case",
            replacement: {
                match: /switch\((\i)\)\{case \i\.GLOBAL_ENV\.INVITE_HOST:/,
                replace: "if($self.isAltInviteHost({host:$1}))return!0;$&"
            }
        },
        {
            find: "_maybeRefuseDaveDowngrade(",
            // spacebar backends never speak DAVE (voice e2ee) at all, so this always
            // sees a "downgrade" to version 0 and disconnects - refusing a downgrade
            // only makes sense against a backend that had dave to downgrade from
            replacement: {
                match: /_maybeRefuseDaveDowngrade\((\i),(\i),(\i)\)\{/,
                replace: "_maybeRefuseDaveDowngrade($1,$2,$3){return!1;"
            }
        },
        {
            // never load libdave or advertise dave support, so voice identifies with
            // max_dave_protocol_version 0 and connections skip the e2ee frame transforms
            find: "startDavePreload(){",
            predicate: () => getApiEndpoint() != null,
            replacement: [
                {
                    match: /fetchDave:\(0,\i\.isWeb\)\(\)/,
                    replace: "fetchDave:!1"
                },
                {
                    match: /startDavePreload\(\)\{/,
                    replace: "$&return;"
                },
                {
                    match: /(getSupportedSecureFramesProtocolVersion\(\)\{)return \i\.getSupportedSecureFramesProtocolVersion\(\)\}/,
                    replace: "$1return 0}"
                }
            ]
        },
        {
            // this nag fires whenever the engine isn't on dave v1, which is always with dave off
            find: "E2EE_UPDATE_REQUIRED]:{predicate:",
            predicate: () => getApiEndpoint() != null,
            replacement: {
                match: /E2EE_UPDATE_REQUIRED\]:\{predicate:\(\)=>\{/,
                replace: "$&return!1;"
            }
        },
    ]
});
