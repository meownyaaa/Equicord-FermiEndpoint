/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./components/styles.css";

import { Settings } from "@api/Settings";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { FormSwitch } from "@components/FormSwitch";
import { WebsiteIcon } from "@components/Icons";
import { Text } from "@components/Text";
import SettingsPlugin from "@plugins/_core/settings";
import { getIntlMessage, sendMessage } from "@utils/discord";
import { Logger } from "@utils/Logger";
import { parseUrl, removeFromArray } from "@utils/misc";
import { openModalLazy } from "@utils/modal";
import { escapeRegExp } from "@utils/text";
import definePlugin, { PluginNative } from "@utils/types";
import type { Channel, ExpressionPickerStoreState, GuildFeatures, Stream, User } from "@vencord/discord-types";
import { ChannelType, CloudUploadPlatform } from "@vencord/discord-types/enums";
import { extractAndLoadChunksLazy, findByCodeLazy, findByPropsLazy, findComponentByCodeLazy, findLazy, findStoreLazy } from "@webpack";
import { Alerts, ApplicationStreamingSettingsStore, ApplicationStreamingStore, AuthenticationStore, Avatar, ChannelMemberStore, ChannelStore, CloudUploader, Constants, ContextMenuApi, DraftType, ExpressionPickerStore, FluxDispatcher, GIFPickerViewStore, GuildMemberStore, GuildStore, LocaleStore, MaskedLink, Menu, MessageActions, MessageStore, NavigationRouter, PendingReplyStore, PermissionsBits, PresenceStore, ReactDOM, RestAPI, SelectedChannelStore, SelectedGuildStore, SettingsRouter, showToast, SnowflakeUtils, useEffect, useRef, UserStore, useState, VoiceStateStore } from "@webpack/common";
import type { ComponentType, ReactElement } from "react";

import { guildifyAst } from "./guildTerminology";
import { type CustomServer, PREDEFINED_SERVERS } from "./servers";
import { migrateCustomServers, migrateDefaultBackend, migrateVideoPlayerSetting, settings } from "./settings";

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
const switchToAccount: (userId: string) => Promise<unknown> = findByCodeLazy("MULTI_ACCOUNT_SWITCH_START");
const UserRecord: typeof User = findLazy(m => m?.prototype?.getAvatarURL);
const computePermissions: (options: { user: string; context: Channel; }) => bigint = findByCodeLazy(".getCurrentUser()", ".computeLurkerPermissionsAllowList()");
const CircleCheckIcon = findComponentByCodeLazy("M12 23a11 11 0 1 0 0-22 11 11 0 0 0 0 22Zm5.7-13.3");
const CircleWarningIcon = findComponentByCodeLazy("M12 23a11 11 0 1 0 0-22 11 11 0 0 0 0 22Zm1.44-15.94");
const SelectedBackendIcon = () => <CircleCheckIcon size="sm" color="var(--brand-500)" secondaryColor="var(--white-500)" />;

interface GoLiveEngine {
    getDesktopSource(quality: { width: number; height: number; }, wantsAudio: boolean): Promise<string>;
    // null clears the current desktop source for that context
    setGoLiveSource(source: { desktopDescription: { id: string; }; } | null, context: "stream"): void;
    findConnection(context: "stream"): unknown;
    desktopInputPool: { get(id: string): unknown; release(input: unknown): void; };
}
const GoLiveMediaEngineStore = findStoreLazy("MediaEngineStore") as { getMediaEngine(): GoLiveEngine; };
import { captureConnectedBackend, connectedBackend, getApiEndpoint, getCdnHost, getGatewayEndpoint, getMediaProxyEndpoint, hasEndpoints, linkCurrentAccount, prepareTokenForBackend, TokenStorage, writeEndpointEnv } from "./utils";
import { CustomVideoPlayer, expireSeekableMedia, makeMediaSeekable, releaseSeekableMedia } from "./videoPlayer";

const logger = new Logger("ChangeEndpoint");

const GuildActionCreators = findByPropsLazy("moveById", "createGuildFolderLocal");
const SortedGuildStore = findStoreLazy("SortedGuildStore");
const GatewayConnectionStore: { getSocket(): { isSessionEstablished(): boolean; updateGuildSubscriptions(subscriptions: Record<string, { channels: Record<string, number[][]>; }>): void; resumeUrl: string | null; sessionId: string | null; }; } = findStoreLazy("GatewayConnectionStore");
const UploadManager = findByPropsLazy("clearAll", "addFile");
const UploadAttachmentStore = findByPropsLazy("getUploadCount");
const GuildActions: { requestMembersById(guildId: string, userIds: string[], presences: boolean): void; } = findByPropsLazy("requestMembersById", "banUser");
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
let renamingChannel = false;
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

interface VoiceSocket {
    video(audioSsrc: number, videoSsrc: number, rtxSsrc: number, streams: unknown): void;
}

const republishedSockets = new WeakSet<VoiceSocket>();

// module level values discord reads from GLOBAL_ENV once, recomputed when the backend changes in place
const envRefreshers: (() => void)[] = [];
let envRefreshCount = 0;

function splitDeclarators(code: string) {
    const parts: string[] = [];
    const stack: string[] = [];
    let start = 0;
    for (let i = 0; i < code.length; i++) {
        const c = code[i];
        const top = stack.at(-1);
        if (top === "`" || top === '"' || top === "'") {
            if (c === "\\") i++;
            else if (c === top) stack.pop();
            else if (top === "`" && c === "$" && code[i + 1] === "{") stack.push(code[i++]);
        } else if (c === "`" || c === '"' || c === "'" || c === "(" || c === "[" || c === "{") stack.push(c);
        else if (c === ")" || c === "]" || c === "}") stack.pop();
        else if (c === "," && !stack.length) {
            parts.push(code.slice(start, i));
            start = i + 1;
        }
    }
    return [...parts, code.slice(start)];
}

function refreshOnEnvChange(chain: string) {
    const refreshed: string[] = [];
    const statements: string[] = [];
    for (const declarator of splitDeclarators(chain)) {
        const eq = declarator.indexOf("=");
        const target = declarator.slice(0, eq);
        const init = declarator.slice(eq + 1);
        const dependsOnRefreshed = refreshed.some(name => new RegExp(`(?<![\\w$.])${escapeRegExp(name)}(?![\\w$])`).test(init));
        if (!init.includes("GLOBAL_ENV") && !dependsOnRefreshed) continue;
        refreshed.push(...(target.startsWith("{") ? [...target.matchAll(/:([\w$]+)/g)].map(m => m[1]) : [target]));
        statements.push(target.startsWith("{") ? `(${declarator})` : declarator);
    }
    return `${chain},$ceEnv${envRefreshCount++}=$self.onEnvChange(()=>{${statements.join(";")}})`;
}

const DISCORD_HOST_RE =/(^|\.)(discord\.(com|gg|media)|discordapp\.(com|net))(:\d+)?$/;
const hostOf = (endpoint: string) => new URL(/^(\w+:)?\/\//.test(endpoint) ? endpoint : `//${endpoint}`, location.origin).host;

function backendOfUrl(url: string) {
    const { host } = new URL(url, location.origin);
    if (DISCORD_HOST_RE.test(host)) return "discord";
    if (pendingLoginBackend && host === hostOf(apiBase(pendingLoginBackend))) return pendingLoginBackend;
    const hosts = [getApiEndpoint(), getGatewayEndpoint(), getCdnHost(), getMediaProxyEndpoint()].flatMap(e => e ? [hostOf(e)] : []);
    return hosts.includes(host) ? connectedBackend : null;
}

const tokenOwner = (token: string) =>
    Object.entries(settings.store.accountBackends).find(([userId]) => TokenStorage.getToken(userId) === token)?.[1];

function isTokenAllowed(token: unknown, url: string) {
    if (typeof token !== "string" || !token) return true;
    const target = backendOfUrl(url);
    const owner = target && tokenOwner(token);
    return !owner || owner === target;
}

let lastTokenRescue = 0;

function blockForeignIdentify(socket: WebSocket, data: string) {
    if (!/"op":[26][,}]/.test(data)) return false;
    const token: unknown = JSON.parse(data).d?.token;
    if (isTokenAllowed(token, socket.url)) return false;

    logger.warn("Blocked a gateway connect carrying another backend's token");
    socket.close(1000);
    if (Date.now() - lastTokenRescue > 15_000 && typeof token === "string") {
        lastTokenRescue = Date.now();
        showToast({ text: `This account is on ${backendName(tokenOwner(token) ?? "")}. Switch to or add a ${backendName(connectedBackend ?? "")} account.`, variant: "critical" });
        setTimeout(openSwitchAccountLanding);
    }
    return true;
}

function isGatewayUrl(url: string) {
    const gateway = getGatewayEndpoint();
    const host = gateway && parseUrl(gateway)?.host;
    return host ? url.includes(host) : url.includes("gateway.");
}

type PayloadShape = { [key: string]: true | PayloadShape; };

const PRESENCE_SHAPE: PayloadShape = { afk: true, status: true, since: true };
const ACTIVITY_SHAPE: PayloadShape = {
    name: true, type: true, url: true, timestamps: { start: true, end: true },
    application_id: true, parent_application_id: true, details: true, details_url: true, state: true, state_url: true,
    emoji: { name: true, id: true, animated: true },
    party: { id: true, size: true },
    assets: { large_image: true, large_text: true, small_image: true, small_text: true },
    secrets: { join: true, spectate: true, match: true },
    instance: true, flags: true, id: true, sync_id: true,
    metadata: { button_urls: true, context_uri: true, album_id: true, artist_ids: true, type: true, label: true },
    session_id: true, platform: true, supported_platforms: true, status_display_type: true, buttons: true
};

function pickKnownKeys(value: Record<string, any>, shape: PayloadShape) {
    const picked: Record<string, any> = {};
    for (const [key, rule] of Object.entries(shape)) {
        if (!(key in value)) continue;
        const v = value[key];
        picked[key] = rule === true || v == null || typeof v !== "object" ? v : pickKnownKeys(v, rule);
    }
    return picked;
}

function sanitiseGatewayPayload(data: string) {
    if (!data.includes('"op":3')) return data;

    try {
        const payload = JSON.parse(data);
        if (payload?.op !== 3 || !Array.isArray(payload.d?.activities)) return data;

        const activities = payload.d.activities.map((activity: Record<string, any>) => {
            const picked = pickKnownKeys(activity, ACTIVITY_SHAPE);
            if (typeof picked.flags === "number") picked.flags = String(picked.flags);
            return picked;
        });
        const sanitised = JSON.stringify({ ...payload, d: { ...pickKnownKeys(payload.d, PRESENCE_SHAPE), activities } });
        if (sanitised === data) return data;

        logger.debug("Sanitised a presence update to the keys Spacebar accepts to avoid a 4002 close");
        return sanitised;
    } catch {
        return data;
    }
}

function installGatewaySendSanitiser() {
    if (originalSend) return;
    originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (this: WebSocket, data: any) {
        if (typeof data === "string" && blockForeignIdentify(this, data)) return;
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

let pendingGoLiveSourceId: string | null = null;

function applyPendingGoLiveSource() {
    const engine = GoLiveMediaEngineStore.getMediaEngine();
    if (!pendingGoLiveSourceId || engine.findConnection("stream") == null) return;
    engine.setGoLiveSource({ desktopDescription: { id: pendingGoLiveSourceId } }, "stream");
    pendingGoLiveSourceId = null;
}

async function startWebEngineGoLiveSource(sourceId: string, sourceName?: string) {
    try {
        await Native.setPendingScreenShareSource(sourceName ?? null, sourceId, ApplicationStreamingSettingsStore.getState().soundshareEnabled);
        pendingGoLiveSourceId = await GoLiveMediaEngineStore.getMediaEngine().getDesktopSource({ width: 1920, height: 1080 }, true);
        applyPendingGoLiveSource();
    } catch (e) {
        logger.error("Failed to start web engine screen share source", e);
    }
}

function stopWebEngineGoLiveSource() {
    try {
        const engine = GoLiveMediaEngineStore.getMediaEngine();
        if (pendingGoLiveSourceId) engine.desktopInputPool.release(engine.desktopInputPool.get(pendingGoLiveSourceId));
        pendingGoLiveSourceId = null;
        engine.setGoLiveSource(null, "stream");
    } catch (e) {
        logger.error("Failed to stop web engine screen share source", e);
    }
}

function goLiveInterceptor(payload: { type: string; sourceId?: string; sourceName?: string; context?: string; }) {
    if (payload.type === "STREAM_START" && payload.sourceId != null) {
        startWebEngineGoLiveSource(payload.sourceId, payload.sourceName);
    } else if (payload.type === "STREAM_STOP") {
        stopWebEngineGoLiveSource();
    } else if (payload.type === "RTC_CONNECTION_STATE" && payload.context === "stream") {
        applyPendingGoLiveSource();
    }
    return false;
}

const answeredListChannels = new Map<string, string>();
let memberListResync: ReturnType<typeof setTimeout> | null = null;

function requestMemberList(guildId: string, channelId: string) {
    const socket = GatewayConnectionStore.getSocket();
    if (socket.isSessionEstablished()) socket.updateGuildSubscriptions({ [guildId]: { channels: { [channelId]: [[0, 99]] } } });
}

interface MemberListItem {
    group?: { id: string; count: number; };
    member?: { user: { id: string; }; };
}

interface MemberListUpdate {
    type: string;
    guildId?: string;
    id?: string;
    groups?: { id: string; count: number; }[];
    ops?: { op: string; range?: [number, number]; items?: MemberListItem[]; }[];
}

function hideMembersWithoutAccess(payload: MemberListUpdate, guildId: string, channelId: string) {
    const channel = ChannelStore.getChannel(channelId);
    if (!channel) return;
    const canView = (userId: string) => !GuildMemberStore.isMember(guildId, userId) || (computePermissions({ user: userId, context: channel }) & PermissionsBits.VIEW_CHANNEL) !== 0n;

    const counts = new Map<string, number>();
    for (const op of payload.ops ?? []) {
        if (op.op !== "SYNC" || !op.items || !op.range) continue;
        let groupId: string | null = null;
        const kept = op.items.filter(item => {
            if (item.group) {
                groupId = item.group.id;
                counts.set(groupId, 0);
                return true;
            }
            if (item.member && !canView(item.member.user.id)) return false;
            if (groupId) counts.set(groupId, (counts.get(groupId) ?? 0) + 1);
            return true;
        });
        op.items = kept.filter(item => !item.group || counts.get(item.group.id)).map(item => item.group ? { group: { ...item.group, count: counts.get(item.group.id) ?? 0 } } : item);
        op.range = [op.range[0], op.range[0] + Math.max(op.items.length - 1, 0)];
    }
    if (counts.size && payload.groups) payload.groups = payload.groups.filter(g => counts.get(g.id)).map(g => ({ ...g, count: counts.get(g.id) ?? 0 }));
}

function memberListInterceptor(payload: MemberListUpdate) {
    if (payload.type !== "GUILD_MEMBER_LIST_UPDATE" || !payload.guildId) return false;
    const channelId = answeredListChannels.get(payload.guildId);
    if (!channelId) return false;
    payload.id = ChannelMemberStore.getProps(payload.guildId, channelId).listId.slice(payload.guildId.length + 1);
    hideMembersWithoutAccess(payload, payload.guildId, channelId);
    return false;
}

function removeInterceptor(interceptor: unknown) {
    removeFromArray(FluxDispatcher._interceptors, i => i === interceptor);
}

let originalPermissionsQuery: Permissions["query"] | null = null;

const SNOWFLAKE_AS_NAME = /^\d{14,22}$/;

const BOOST_TIER_THRESHOLDS = [2, 7, 14];
const BOOST_FEATURES: GuildFeatures[] = [
    "ANIMATED_ICON", "ANIMATED_BANNER", "BANNER", "INVITE_SPLASH", "VANITY_URL",
    "MORE_EMOJI", "MORE_STICKERS", "MORE_SOUNDBOARD", "ROLE_ICONS", "ROLE_SUBSCRIPTIONS_ENABLED"
];

const instanceLimits = { maxEmojis: 2000, maxStickers: 500, maxAttachmentSize: 0, maxAttachments: 10, maxBio: 190, maxPronouns: 40, maxMessageLength: 1048576, maxChannelName: 32, maxTopic: 1024, maxUsername: 32 };

interface InstanceInfo {
    instanceName?: string;
    instanceDescription?: string | null;
    frontPage?: string | null;
    tosPage?: string | null;
    correspondenceEmail?: string | null;
}

let instanceInfo: InstanceInfo | null = null;

async function loadInstanceInfo() {
    const { body } = await RestAPI.get({ url: "/policies/instance" });
    instanceInfo = body ?? null;
}

const httpUrl = (url: string | null | undefined) => url && /^https?:\/\//.test(url) ? url : undefined;

const SIGNATURE_LIFETIME = 30 * 60 * 1000;
const refreshedGifUrls = new Map<string, { url: string; at: number; }>();
const queuedGifUrls = new Map<string, string>();
const gifRefreshListeners = new Set<() => void>();
let gifRefreshVersion = 0;
let gifRefreshTimer: ReturnType<typeof setTimeout> | null = null;

function unsignedAttachmentKey(src: string) {
    const cdn = getApiEndpoint() != null ? getCdnHost() : null;
    if (!cdn) return null;
    const url = parseUrl(src);
    if (!url || url.hostname !== cdn || !/^\/(ephemeral-)?attachments\//.test(url.pathname)) return null;
    for (const key of ["ex", "is", "hm"]) url.searchParams.delete(key);
    return url.toString();
}

async function flushGifRefresh() {
    gifRefreshTimer = null;
    const batch = [...queuedGifUrls];
    queuedGifUrls.clear();
    if (!batch.length) return;
    try {
        const { body } = await RestAPI.post({ url: "/attachments/refresh-urls", body: { attachment_urls: batch.map(([, src]) => src) } });
        const urls: unknown[] = body?.refreshed_urls ?? [];
        batch.forEach(([key], i) => {
            const entry = urls[i] as string | { refreshed?: string; } | undefined;
            const url = typeof entry === "string" ? entry : entry?.refreshed;
            if (url) refreshedGifUrls.set(key, { url, at: Date.now() });
        });
    } catch (e) {
        logger.warn("Couldn't refresh favorite GIF links", e);
        batch.forEach(([key, src]) => refreshedGifUrls.set(key, { url: src, at: Date.now() }));
    }
    gifRefreshVersion++;
    gifRefreshListeners.forEach(listener => listener());
}

function refreshedGifSrc(src: string) {
    const key = unsignedAttachmentKey(src);
    if (!key) return src;
    const cached = refreshedGifUrls.get(key);
    if (cached && Date.now() - cached.at < SIGNATURE_LIFETIME) return cached.url;
    if (!queuedGifUrls.has(key)) {
        queuedGifUrls.set(key, src);
        gifRefreshTimer ??= setTimeout(flushGifRefresh, 50);
    }
    return cached?.url ?? src;
}

function sendGifUpload(gif: { url: string; src: string; }, sendLink: () => void) {
    const link = [gif.url, gif.src].find(unsignedAttachmentKey);
    const pickerState = (ExpressionPickerStore.useExpressionPickerStore as { getState?(): ExpressionPickerStoreState; }).getState?.();
    const channelId = pickerState?.activeChannelId ?? SelectedChannelStore.getChannelId();
    if (!link || !channelId) return sendLink();

    const reply = PendingReplyStore.getPendingReply(channelId);
    if (reply) FluxDispatcher.dispatch({ type: "DELETE_PENDING_REPLY", channelId });

    (async () => {
        const { body } = await RestAPI.post({ url: "/attachments/refresh-urls", body: { attachment_urls: [link] } });
        const entry = body?.refreshed_urls?.[0];
        const source = parseUrl(typeof entry === "string" ? entry : entry?.refreshed ?? link);
        if (!source) throw new Error("Invalid attachment link");
        for (const key of ["format", "animated", "width", "height", "size", "quality"]) source.searchParams.delete(key);
        const res = await fetch(source);
        if (!res.ok) throw new Error(`CDN answered ${res.status}`);
        const blob = await res.blob();
        const file = new File([blob], decodeURIComponent(source.pathname.split("/").pop() || "image.gif"), { type: blob.type });
        await sendMessage(channelId, {}, true, {
            ...(reply ? MessageActions.getSendMessageOptionsForReply(reply) : {}),
            attachmentsToUpload: [new CloudUploader({ file, platform: CloudUploadPlatform.WEB }, channelId)]
        });
    })().catch(e => {
        logger.warn("Couldn't upload the favorite GIF, sending the link instead", e);
        sendLink();
    });
}

function useGifRefreshVersion() {
    const [version, setVersion] = useState(gifRefreshVersion);
    useEffect(() => {
        const listener = () => setVersion(gifRefreshVersion);
        gifRefreshListeners.add(listener);
        return () => void gifRefreshListeners.delete(listener);
    }, []);
    return version;
}

async function loadInstanceLimits() {
    const { body } = await RestAPI.get({ url: "/policies/instance/limits" });
    instanceLimits.maxEmojis = body?.guild?.maxEmojis ?? instanceLimits.maxEmojis;
    instanceLimits.maxStickers = body?.guild?.maxStickers ?? instanceLimits.maxStickers;
    instanceLimits.maxAttachmentSize = body?.message?.maxAttachmentSize ?? instanceLimits.maxAttachmentSize;
    instanceLimits.maxAttachments = body?.message?.maxAttachments ?? instanceLimits.maxAttachments;
    instanceLimits.maxBio = body?.user?.maxBio ?? instanceLimits.maxBio;
    instanceLimits.maxPronouns = body?.user?.maxPronouns ?? instanceLimits.maxPronouns;
    instanceLimits.maxMessageLength = body?.message?.maxCharacters ?? instanceLimits.maxMessageLength;
    instanceLimits.maxChannelName = body?.channel?.maxName ?? instanceLimits.maxChannelName;
    instanceLimits.maxTopic = body?.channel?.maxTopic ?? instanceLimits.maxTopic;
    instanceLimits.maxUsername = body?.user?.maxUsername ?? instanceLimits.maxUsername;
}

function boostPerks() {
    const count = settings.store.boostCount;
    const tier = BOOST_TIER_THRESHOLDS.filter(t => count >= t).length;
    return { count, tier, features: tier === BOOST_TIER_THRESHOLDS.length ? BOOST_FEATURES : [] };
}

const realGuildFeatures = new Map<string, string[]>();

function stripSpoofedFeatures(guildId: string, body: string) {
    if (settings.store.keepSpoofedGuildFeatures || !body.includes('"features"')) return body;
    try {
        const payload = JSON.parse(body);
        if (!Array.isArray(payload.features)) return body;
        const real = realGuildFeatures.get(guildId);
        if (real) {
            const spoofed = new Set<string>(boostPerks().features.filter(f => !real.includes(f)));
            payload.features = payload.features.filter((f: string) => !spoofed.has(f));
        } else {
            delete payload.features;
        }
        return JSON.stringify(payload);
    } catch {
        return body;
    }
}

function maxOutGuildPremium(guild: any) {
    if (!guild) return;
    const { count, tier, features } = boostPerks();
    const properties = guild.properties ?? guild;
    const id = guild.id ?? properties.id;
    if (id && Array.isArray(properties.features)) realGuildFeatures.set(id, [...properties.features]);
    properties.premium_tier = tier;
    properties.features = Array.from(new Set([...(properties.features ?? []), ...features]));
    guild.premium_subscription_count = count;
}

// guilds that finished loading before this interceptor was installed never
// pass through it, so they'd stay stuck at tier 0 forever. patch those directly too.
function maxOutLoadedGuilds() {
    const { count, tier, features } = boostPerks();
    for (const guild of GuildStore.getGuildsArray()) {
        guild.premiumTier = tier;
        guild.premiumSubscriberCount = count;
        for (const feature of features) guild.features.add(feature);
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

function emailVerificationInterceptor(event: any) {
    if ((event.type === "CONNECTION_OPEN" || event.type === "CURRENT_USER_UPDATE") && event.user) event.user.verified = true;
    return false;
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

// spacebar has no spoiler flag on attachments, so set discord's own one from the SPOILER_ filename
const IS_SPOILER_FLAG = 1 << 3;
const SPOILER_EVENTS = new Set([
    "MESSAGE_CREATE", "MESSAGE_UPDATE", "LOCAL_MESSAGE_CREATE", "LOCAL_MESSAGES_LOADED",
    "LOAD_MESSAGES_SUCCESS", "LOAD_MESSAGES_SUCCESS_CACHED", "LOAD_MESSAGES_AROUND_SUCCESS",
    "LOAD_PINNED_MESSAGES_SUCCESS", "LOAD_RECENT_MENTIONS_SUCCESS", "SEARCH_MESSAGES_SUCCESS",
    "LOAD_THREADS_SUCCESS", "LOAD_ARCHIVED_THREADS_SUCCESS", "THREAD_LIST_SYNC", "LOAD_FORUM_POSTS",
    "FORUM_SEARCH_SUCCESS", "MESSAGE_PREVIEWS_LOADED", "SAVED_MESSAGES_UPDATE", "SAVED_MESSAGE_CREATE"
]);

function markSpoilerAttachments(value: unknown, depth: number) {
    if (depth > 6 || value == null || typeof value !== "object") return;
    if (Array.isArray(value)) {
        for (const item of value) markSpoilerAttachments(item, depth + 1);
        return;
    }

    for (const [key, child] of Object.entries(value)) {
        if (key === "attachments" && Array.isArray(child)) {
            for (const attachment of child) {
                if (typeof attachment?.filename === "string" && attachment.filename.startsWith("SPOILER_")) attachment.flags = (attachment.flags ?? 0) | IS_SPOILER_FLAG;
            }
        } else markSpoilerAttachments(child, depth + 1);
    }
}

function spoilerInterceptor(payload: { type: string; }) {
    if (getApiEndpoint() != null && SPOILER_EVENTS.has(payload.type)) markSpoilerAttachments(payload, 0);
    return false;
}

const MESSAGE_URL_RE = /\/channels\/\d+\/messages(\/\d+)?$/;
// ^ lowkey forgot what this does, dont remove unless yk what it is

// discord sends guild profile (server tag) reads/writes to /guilds/{id}/profile,
// but spacebar never grew that route - it just uses /guilds/{id} for everything
const GUILD_PROFILE_URL_RE = /(\/guilds\/\d+)\/profile$/;
const GUILD_URL_RE = /\/guilds\/(\d+)$/;
// profile-only fields the plain guild route doesn't know about, spacebar chokes on these.
// description is NOT one of these - GuildUpdateSchema on /guilds/{id} supports it directly.
const GUILD_PROFILE_ONLY_KEYS = ["brand_color_primary", "traits", "game_application_ids", "visibility"];

function stripGuildProfileOnlyFields(body: string) {
    try {
        const payload = JSON.parse(body);
        for (const key of GUILD_PROFILE_ONLY_KEYS) delete payload[key];
        if ("custom_banner" in payload) {
            payload.discovery_splash = payload.custom_banner;
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
        if ("discovery_splash" in payload) payload.custom_banner_hash = payload.discovery_splash;
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

        const auth = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("authorization");
        if (!isTokenAllowed(auth, url)) {
            logger.warn(`Blocked a request carrying another backend's token: ${pathname}`);
            throw new DOMException("Blocked a request carrying another backend's token", "AbortError");
        }

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
            const guildId = init.method === "PATCH" && pathname.match(GUILD_URL_RE)?.[1];
            if (MESSAGE_URL_RE.test(pathname)) {
                init = { ...init, body: stripIsSpoiler(init.body) };
            } else if (guildId) {
                init = { ...init, body: stripSpoofedFeatures(guildId, init.body) };
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
let originalXHRSetHeader: typeof XMLHttpRequest.prototype.setRequestHeader | null = null;
const xhrUrls = new WeakMap<XMLHttpRequest, string>();
const blockedRequests = new WeakSet<XMLHttpRequest>();
const flaggedGuildProfileRequests = new WeakSet<XMLHttpRequest>();
const guildEditRequests = new WeakMap<XMLHttpRequest, string>();

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

        const guildId = method.toUpperCase() === "PATCH" && pathname.match(GUILD_URL_RE)?.[1];
        if (guildId) guildEditRequests.set(this, guildId);

        const gifProvider = GIF_API_RE.test(pathname) && currentGifProvider();
        if (gifProvider) {
            const withProvider = new URL(urlStr, location.origin);
            withProvider.searchParams.set("provider", gifProvider);
            url = withProvider.href;
        }

        if (pendingLoginBackend) {
            const current = apiBase();
            const route = urlStr.startsWith(current) && urlStr.slice(current.length);
            if (route && /^\/v\d+\/auth\//.test(route)) url = apiBase(pendingLoginBackend) + route;
        }

        xhrUrls.set(this, url instanceof URL ? url.href : url);
        blockedRequests.delete(this);
        return Reflect.apply(OriginalOpen, this, [method, url, ...rest]);
    };

    const OriginalSetHeader = originalXHRSetHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (name: string, value: string) {
        const url = xhrUrls.get(this);
        if (url && name.toLowerCase() === "authorization" && !isTokenAllowed(value, url)) {
            logger.warn(`Blocked a request carrying another backend's token: ${new URL(url, location.origin).pathname}`);
            blockedRequests.add(this);
            return;
        }
        return OriginalSetHeader.call(this, name, value);
    };

    const OriginalSend = originalXHRSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
        if (blockedRequests.has(this)) {
            OriginalSend.call(this);
            this.abort();
            return;
        }
        if (flaggedGuildProfileRequests.has(this)) {
            flaggedGuildProfileRequests.delete(this);
            if (typeof body === "string") body = stripGuildProfileOnlyFields(body);
        }
        const guildId = guildEditRequests.get(this);
        if (guildId) {
            guildEditRequests.delete(this);
            if (typeof body === "string") body = stripSpoofedFeatures(guildId, body);
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
    if (originalXHRSetHeader) {
        XMLHttpRequest.prototype.setRequestHeader = originalXHRSetHeader;
        originalXHRSetHeader = null;
    }
}

const ALT_INVITE_HOSTS = ["sbar.fyi", "sbar.top", "fermi.chat"];
const ALT_INVITE_PATHS = ["/invite", "/i"];

function isAltInviteHostName(host?: string | null) {
    return !!host && ALT_INVITE_HOSTS.some(alt => host === alt || host.endsWith(`.${alt}`));
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
            showToast({ text: icon ? "channel icon updated" : "channel icon cleared", variant: "success" });
        } catch (e) {
            showToast({ text: "failed to update channel icon", variant: "critical" });
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
        if (!imageUri) return showToast({ text: "couldn't read that image", variant: "critical" });

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
                            ? <img src={`${apiScheme()}//${getCdnHost()}/channel-icons/${channel.id}/${channel.icon}.png`} alt="" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
                            : <WebsiteIcon />}
                    </div>
                    <input ref={inputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={onFileChosen} />
                    <Button size="small" disabled={uploading} onClick={() => inputRef.current?.click()}>
                        Change Icon
                    </Button>
                    {channel.icon && (
                        <Button size="small" variant="dangerPrimary" disabled={uploading} onClick={() => patchIcon(null)}>
                            Remove
                        </Button>
                    )}
                </div>
                <Text size="xs" weight="normal" color="text-muted" style={{ marginTop: "8px" }}>Shown in the channel list in place of the default icon.</Text>
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

const apiScheme = () => /^http:\/\//i.test(getApiEndpoint() ?? "") ? "http:" : "https:";
const withHttps = (endpoint: string) => /^\w+:\/\//.test(endpoint) ? endpoint : apiScheme() + endpoint;

// harmony rejects identify properties its schema doesn't list, and discord keeps adding new ones
const IDENTIFY_PROPERTIES = new Set([
    "os", "browser", "device", "$os", "$browser", "$device", "os_version", "os_arch", "os_sdk_version", "app_arch",
    "browser_user_agent", "browser_version", "release_channel", "client_build_number", "native_build_number",
    "client_event_source", "client_version", "system_locale", "has_client_mods", "client_launch_id", "launch_signature",
    "client_heartbeat_session_id", "is_fast_connect", "gateway_connect_reasons",
    "referrer", "referring_domain", "referrer_current", "referring_domain_current"
]);

// backend picked in the add account modal, only login requests go there until it succeeds
let pendingLoginBackend: string | null = null;

const apiBase = (backend?: string) => withHttps(getApiEndpoint(backend) ?? window.GLOBAL_ENV.API_ENDPOINT);
const backendName = (id: string) => (PREDEFINED_SERVERS.find(s => s.id === id) ?? settings.store.customServers.find(s => s.id === id))?.name ?? id;

function reloadOnBackend(id: string) {
    if (id === connectedBackend && settings.store.backend === id) return;
    if (!hasEndpoints(id)) {
        showToast({ text: `${backendName(id)} has no API or gateway set.`, variant: "critical" });
        return;
    }
    confirmDiscordReload(id, () => {
        prepareTokenForBackend(id);
        settings.store.backend = id;
        location.reload();
    });
}

const DiscordSwitchPrompt = ErrorBoundary.wrap(function ({ onChange }: { onChange(value: boolean): void; }) {
    const [dontAsk, setDontAsk] = useState(false);
    return (
        <>
            <Text size="md" weight="normal">Discord runs without any ChangeEndpoint patches, so switching to or from it reloads the client.</Text>
            <FormSwitch title="Don't ask again" value={dontAsk} onChange={value => { setDontAsk(value); onChange(value); }} hideBorder />
        </>
    );
}, { noop: true });

function confirmDiscordReload(target: string, reload: () => void) {
    if (!settings.store.confirmDiscordSwitch || (!onDiscord && target !== "discord")) return reload();
    let dontAsk = false;
    Alerts.show({
        title: `Switch to ${backendName(target)}?`,
        body: <DiscordSwitchPrompt onChange={value => dontAsk = value} />,
        confirmText: "Switch and Reload",
        cancelText: "Cancel",
        onConfirm: () => {
            if (dontAsk) settings.store.confirmDiscordSwitch = false;
            reload();
        }
    });
}

const canSwitchInPlace = (id: string) =>
    !onDiscord && id !== "discord" && id !== connectedBackend && hasEndpoints(id) && getCdnHost(id) != null;

function applyBackendInPlace(id: string) {
    logger.info(`Switching to ${backendName(id)} without a reload`);
    settings.store.backend = id;
    captureConnectedBackend(id);
    writeEndpointEnv(window.GLOBAL_ENV);
    envRefreshers.forEach(refresh => refresh());
    const socket = GatewayConnectionStore.getSocket();
    socket.resumeUrl = socket.sessionId = null;

    const syncing = dmPollingStarted;
    stopGuildOrderSync();
    stopDMUnreadPoll();
    releaseVoiceState();
    releaseSeekableMedia();
    answeredListChannels.clear();
    realGuildFeatures.clear();
    notMembers.clear();
    queuedMembers.clear();
    if (memberListResync) clearTimeout(memberListResync);
    memberListResync = null;
    lastSignature = null;
    pendingLoginBackend = null;
    instanceInfo = null;
    gifProviders = [];
    if (!syncing) return;
    startGuildOrderSync();
    startDMUnreadPoll();
}

function switchBackendTo(id: string) {
    if (!canSwitchInPlace(id)) return reloadOnBackend(id);

    const accounts = MultiAccountStore.getUsers().filter(u => settings.store.accountBackends[u.id] === id && TokenStorage.getToken(u.id));
    if (accounts.length === 1) return void switchToAccount(accounts[0].id);

    prepareTokenForBackend(id);
    applyBackendInPlace(id);
    FluxDispatcher.dispatch({ type: "LOGOUT", isSwitchingAccount: true, userId: AuthenticationStore.getId() });
}

function openAccountOn(userId: string, token: string, backend: string) {
    settings.store.accountBackends = { ...settings.plain.accountBackends, [userId]: backend };
    if (backend === connectedBackend) return void switchToAccount(userId);
    if (canSwitchInPlace(backend)) {
        applyBackendInPlace(backend);
        return void switchToAccount(userId);
    }
    confirmDiscordReload(backend, () => {
        TokenStorage.setToken(token, userId);
        settings.store.backend = backend;
        location.reload();
    });
}

const AddAccountBackendButton = ErrorBoundary.wrap(function ({ openMenu }: { openMenu(e: React.MouseEvent, onSelect: (id: string) => void, selected: string | null): void; }) {
    const [pending, setPending] = useState(pendingLoginBackend);
    useEffect(() => () => { pendingLoginBackend = null; }, []);

    return (
        <Button
            type="button"
            size="small"
            variant="secondary"
            onClick={e => openMenu(e, id => onDiscord || id === "discord" ? reloadOnBackend(id) : setPending(pendingLoginBackend = id === connectedBackend ? null : id), pending ?? connectedBackend)}
        >
            {pending ? `Backend: ${backendName(pending)}` : "Switch Backend"}
        </Button>
    );
}, { noop: true });

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
        showToast({ text: `Couldn't load GIFs from ${gifProviderName(provider)}.`, variant: "critical" });
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
                    size="small"
                    variant={provider === current ? "primary" : "secondary"}
                    onClick={() => selectGifProvider(provider)}
                >
                    {gifProviderName(provider)}
                </Button>
            ))}
        </div>
    );
}, { noop: true });

interface ChannelPositionUpdate {
    id: string;
    position?: number;
    parent_id?: string | null;
    lock_permissions?: boolean;
}

const VOICE_CHANNEL_TYPES = new Set([ChannelType.GUILD_VOICE, ChannelType.GUILD_STAGE_VOICE]);
const THREAD_CHANNEL_TYPES = new Set([ChannelType.ANNOUNCEMENT_THREAD, ChannelType.PUBLIC_THREAD, ChannelType.PRIVATE_THREAD]);

function openSwitchAccountLanding() {
    AuthActions?.A?.logoutInternal?.({ isSwitchingAccount: true });
    NavigationRouter.transitionTo("/login");
}

const STUCK_LOADING_MS = 15_000;

const StuckLoadingNotice = ErrorBoundary.wrap(() => {
    const [open, setOpen] = useState(false);

    useEffect(() => {
        const timer = setTimeout(() => setOpen(true), STUCK_LOADING_MS);
        return () => clearTimeout(timer);
    }, []);

    if (!open) return null;

    const { backend, customServers } = settings.store;
    const predefined = PREDEFINED_SERVERS.find(s => s.id === backend);
    const name = predefined?.name ?? customServers.find(s => s.id === backend)?.name ?? "The server";

    return (
        <div className="vc-endpoint-stuck-backdrop">
            <div className="vc-endpoint-stuck-notice" role="alertdialog" aria-label="Still connecting">
                <Text size="lg" weight="semibold" color="text-strong">Still connecting?</Text>
                <Text size="md" weight="normal" color="text-default">This is taking longer than usual. If the server or your connection is just slow, you can ignore this. Otherwise, some likely reasons:</Text>
                <ul className="vc-endpoint-stuck-reasons">
                    <li><Text size="md" weight="normal" color="text-default">{name} might be down right now.</Text></li>
                    {predefined ? null : <li><Text size="md" weight="normal" color="text-default">This custom server might not be set up correctly.</Text></li>}
                    <li><Text size="md" weight="normal" color="text-default">You switched servers without switching to an account from that server.</Text></li>
                    <li><Text size="md" weight="normal" color="text-default">Your ISP might be blocking it. A VPN can help.</Text></li>
                </ul>
                <div className="vc-endpoint-stuck-actions">
                    <Button size="small" variant="secondary" onClick={() => setOpen(false)}>Close</Button>
                    <Button size="small" onClick={() => { setOpen(false); openSwitchAccountLanding(); }}>Switch Account</Button>
                </div>
            </div>
        </div>
    );
}, { noop: true });

const serverWithCodeOfConduct = () => PREDEFINED_SERVERS.find(s => s.id === settings.store.backend && s.codeOfConduct);

const TENOR_MEDIA1_URL = /https:\/\/media1\.tenor\.com\/m\/([\w-]+\/[^\s/?#]+)/g;

const GATEWAY_AUTH_FAILURE =/invalid token|user not found|user disabled|failed to decode token|unsupported token algorithm/i;

const encodeStreamKey: (stream: Stream) => string = findByCodeLazy("Unknown stream type", '.join(":")');

interface VoiceStateArgs {
    channelId?: string | null;
}

interface VoiceStateSocket {
    streamDelete(streamKey: string): void;
    voiceStateUpdate(state: VoiceStateArgs): void;
}

const notMembers = new Set<string>();
const queuedMembers = new Set<string>();
let fetchingMembers = false;

async function fetchNotFoundMembers() {
    if (fetchingMembers) return;
    fetchingMembers = true;
    for (const key of queuedMembers) {
        queuedMembers.delete(key);
        const [guildId, userId] = key.split(":");
        try {
            const { body } = await RestAPI.get({ url: Constants.Endpoints.GUILD_MEMBER(guildId, userId) });
            FluxDispatcher.dispatch({ type: "GUILD_MEMBERS_CHUNK_BATCH", chunks: [{ guildId, members: [body], notFound: [] }] });
        } catch (e) {
            if ((e as { status?: number; }).status === 404) notMembers.add(key);
        }
    }
    fetchingMembers = false;
}

let heldVoiceState: { socket: VoiceStateSocket; state: VoiceStateArgs; streamKey: string; timer: ReturnType<typeof setTimeout>; } | null = null;
let releasedVoiceState: VoiceStateArgs | null = null;

function releaseVoiceState() {
    if (!heldVoiceState) return;
    const { socket, state, timer } = heldVoiceState;
    clearTimeout(timer);
    heldVoiceState = null;
    releasedVoiceState = state;
    socket.voiceStateUpdate(state);
}

interface VoiceStateChange {
    guildId?: string | null;
    channelId?: string | null;
    oldChannelId?: string | null;
}

interface SortedVoiceStates {
    guildId: string;
    _voiceStates: { get(userId: string): unknown; };
    updateVoiceState(userId: string): boolean;
}

function setVoiceStartTime(guildId: string, id: string, voiceStartTime?: number) {
    setTimeout(() => FluxDispatcher.dispatch({ type: "VOICE_CHANNEL_START_TIME_UPDATE", guildId, id, voiceStartTime }));
}

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
                                    <Text size="sm" weight="normal">{account.username}</Text>
                                    {!user.hasUniqueUsername() && <Text size="sm" weight="normal">#{account.discriminator}</Text>}
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

function bootsOnDiscord() {
    const backend: string | undefined = Settings.plugins.ChangeEndpoint?.backend;
    const customServers: CustomServer[] = Settings.plugins.ChangeEndpoint?.customServers ?? [];
    if (backend == null || backend === "discord") return backend === "discord";
    if (PREDEFINED_SERVERS.some(s => s.id === backend)) return false;
    const custom = customServers.find(s => s.id === backend);
    return !(custom?.type === "simple" ? custom.host?.trim() : custom?.apiEndpoint?.trim() && custom.gatewayEndpoint?.trim());
}

const onDiscord = bootsOnDiscord();

const DISCORD_SAFE_PATCHES = new Set([
    "Switching accounts failed because there was no token",
    'navId:"manage-multi-account"',
    'id:"manage-accounts"',
    ".getIsValidatingUsers(),multiAccountUsers:",
    "#{intl::SWITCH_ACCOUNTS_CHOOSE_ACCOUNT_HELPER})",
    "username webauthn",
    '#{intl::BACK}),type:"button"',
    "--connecting-container-fade-duration"
]);

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

    apiScheme,

    guildifyAst,

    resolveGifUrl(item: { url: string; src?: string; gifSrc?: string; }) {
        const withScheme = (url: string) => url.startsWith("//") ? `https:${url}` : url;

        if (item.gifSrc) return withScheme(item.gifSrc);
        if (item.src && !/\.(mp4|webm)(\?|$)/i.test(item.src)) return withScheme(item.src);
        return item.url;
    },

    renderVideoAttachment({ item, className, ...size }: { item: { originalItem?: { url?: string; filename?: string; size?: number; }; downloadUrl?: string; }; maxWidth?: number; maxHeight?: number; className?: string; }) {
        const src = item.originalItem?.url ?? item.downloadUrl ?? "";
        const maxWidth = size.maxWidth || 640;
        const maxHeight = size.maxHeight || 400;
        return (
            <div className={className}>
                {settings.store.useChromiumVideoPlayer
                    ? <video src={src} controls preload="metadata" style={{ maxWidth, maxHeight, width: "100%" }} />
                    : <CustomVideoPlayer src={src} maxWidth={maxWidth} maxHeight={maxHeight} fileName={item.originalItem?.filename} fileSizeBytes={item.originalItem?.size} />}
            </div>
        );
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
                <img className={className} src={`${apiScheme()}//${getCdnHost()}/channel-icons/${key}.png`} alt="" />
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

    withEveryoneColor<T extends Pick<ColorRole, "colorString" | "colorStrings"> & { colorRoleId?: string; }>(guildRoles: Record<string, ColorRole>, result: T): T {
        const everyone = result.colorString == null ? this.getEveryoneColorRole(guildRoles) : undefined;
        return everyone ? { ...result, colorString: everyone.colorString, colorStrings: everyone.colorStrings, colorRoleId: everyone.id } : result;
    },

    // sets the active backend then reloads, since endpoints are baked into GLOBAL_ENV at boot
    // maybe i could complicate this and have it half reload? client takes a while to initially
    // start up, faster switch times would be nicer
    switchBackend(id: string) {
        switchBackendTo(id);
    },

    canSwitchInPlace(id: string) {
        return canSwitchInPlace(id);
    },

    openBackendMenu(e: React.MouseEvent, onSelect = (id: string) => this.switchBackend(id), selected = connectedBackend) {
        const custom = settings.store.customServers;
        const item = (s: { id: string; name: string; }) => {
            const usable = hasEndpoints(s.id);
            return (
                <Menu.MenuItem
                    key={s.id}
                    id={s.id}
                    label={s.name}
                    subtext={usable ? undefined : "No API or gateway set"}
                    disabled={!usable}
                    icon={s.id === selected ? SelectedBackendIcon : undefined}
                    action={() => s.id !== selected && onSelect(s.id)}
                />
            );
        };
        ContextMenuApi.openContextMenu(e, () => (
            <Menu.Menu navId="change-endpoint-switch-backend" onClose={ContextMenuApi.closeContextMenu}>
                {PREDEFINED_SERVERS.map(item)}
                {custom.length > 0 && <Menu.MenuSeparator />}
                {custom.map(item)}
                {UserStore.getCurrentUser() && (
                    <>
                        <Menu.MenuSeparator />
                        <Menu.MenuItem id="manage-backends" label="Manage Backends" action={() => SettingsRouter.openUserSettings("equicord_change_endpoint_panel")} />
                    </>
                )}
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
        const terms = httpUrl(instanceInfo?.tosPage);
        const link = terms ?? serverWithCodeOfConduct()?.codeOfConduct;
        if (!link) return null;
        return <>By creating a {settings.store.guildTerminology ? "guild" : "server"}, you agree to {backendName(connectedBackend ?? settings.store.backend)}'s <strong><MaskedLink href={link}>{terms ? "Terms" : "Code of Conduct"}</MaskedLink></strong>.</>;
    },

    instanceInfo() {
        if (settings.store.backend !== connectedBackend || !instanceInfo) return null;
        return { ...instanceInfo, frontPage: httpUrl(instanceInfo.frontPage), tosPage: httpUrl(instanceInfo.tosPage) };
    },

    reorderChannelsForSpacebar(guildId: string, updates: ChannelPositionUpdate[]) {
        const changes = new Map(updates.map(u => [u.id, u]));
        const channels = Object.values(ChannelStore.getMutableGuildChannelsForGuild(guildId))
            .filter(c => !THREAD_CHANNEL_TYPES.has(c.type))
            .map(c => {
                const change = changes.get(c.id);
                return {
                    id: c.id,
                    type: c.type,
                    position: change?.position ?? c.position,
                    parentId: change?.parent_id !== undefined ? change.parent_id : c.parent_id ?? null
                };
            });
        type Entry = typeof channels[number];

        const sorted = (list: Entry[]) => list.sort((a, b) =>
            Number(VOICE_CHANNEL_TYPES.has(a.type)) - Number(VOICE_CHANNEL_TYPES.has(b.type))
            || a.position - b.position
            || SnowflakeUtils.compare(a.id, b.id));
        const childrenOf = (parentId: string | null) => sorted(channels.filter(c => c.type !== ChannelType.GUILD_CATEGORY && c.parentId === parentId));
        const order = [
            ...childrenOf(null),
            ...sorted(channels.filter(c => c.type === ChannelType.GUILD_CATEGORY)).flatMap(category => [category, ...childrenOf(category.id)])
        ];

        return order.map((c, position) => ({ id: c.id, position }));
    },

    async moveChannelParentsForSpacebar(guildId: string, updates: ChannelPositionUpdate[]) {
        const moved = updates.filter(u => u.parent_id !== undefined && (u.lock_permissions || u.parent_id !== (ChannelStore.getChannel(u.id)?.parent_id ?? null)));
        if (!moved.length) return;

        await RestAPI.patch({
            url: Constants.Endpoints.GUILD_CHANNELS(guildId),
            body: moved.map(({ id, parent_id, lock_permissions }) => ({ id, parent_id, lock_permissions }))
        });
    },

    maxEmojis() {
        return instanceLimits.maxEmojis;
    },

    onEnvChange(refresh: () => void) {
        envRefreshers.push(refresh);
    },

    refreshedGifSrc,
    sendGifUpload,
    useGifRefreshVersion,

    maxBio() {
        return instanceLimits.maxBio;
    },

    maxPronouns() {
        return instanceLimits.maxPronouns;
    },

    maxMessageLength() {
        return instanceLimits.maxMessageLength;
    },

    maxChannelName() {
        return instanceLimits.maxChannelName;
    },

    maxTopic() {
        return instanceLimits.maxTopic;
    },

    sanitizeChannelName(name: string) {
        const guildId = SelectedGuildStore.getGuildId();
        const features: ReadonlySet<string> | undefined = guildId ? GuildStore.getGuild(guildId)?.features : undefined;
        if (renamingChannel || features?.has("ALLOW_INVALID_CHANNEL_NAMES")) return name;
        return name.replace(/[\s-]+/g, "-").replace(/^-+/, "");
    },

    renameChannel(sanitize: () => string) {
        renamingChannel = true;
        const name = sanitize();
        renamingChannel = false;
        return name;
    },

    maxUsername() {
        return instanceLimits.maxUsername;
    },

    maxStickers() {
        return instanceLimits.maxStickers;
    },

    maxAttachmentSize() {
        return instanceLimits.maxAttachmentSize;
    },

    maxTotalAttachmentSize() {
        return instanceLimits.maxAttachmentSize * instanceLimits.maxAttachments;
    },

    stickerTierSlots(tier: number, slotsPerTier: Record<number, number>) {
        if (tier !== BOOST_TIER_THRESHOLDS.length) return slotsPerTier[tier];
        return instanceLimits.maxStickers - slotsPerTier[0] - slotsPerTier[1] - slotsPerTier[2];
    },

    identifyPresence(presence: { status?: string; }) {
        if (!settings.store.announceOnlineOnConnect || presence.status === "invisible") return presence;
        return { ...presence, status: "offline" };
    },

    identifyProperties(properties: Record<string, unknown>) {
        return Object.fromEntries(Object.entries(properties).filter(([key]) => IDENTIFY_PROPERTIES.has(key)));
    },

    orderGuildSubscriptions(subscriptions: Record<string, { channels?: Record<string, unknown>; }>) {
        if (getApiEndpoint() == null) return;
        const selected = SelectedChannelStore.getChannelId();
        for (const [guildId, subscription] of Object.entries(subscriptions)) {
            const { channels } = subscription;
            if (!channels || !Object.keys(channels).length) continue;
            const answered = selected in channels ? selected : Object.keys(channels)[0];
            subscription.channels = { [answered]: channels[answered], ...channels };
            answeredListChannels.set(guildId, answered);
        }
    },

    holdVoiceState(socket: VoiceStateSocket, state: VoiceStateArgs) {
        if (state === releasedVoiceState) return false;
        if (heldVoiceState) {
            heldVoiceState.state = state;
            return true;
        }

        const userId = UserStore.getCurrentUser().id;
        const stream = ApplicationStreamingStore.getAllActiveStreams().find(s => s.ownerId === userId && s.channelId !== state.channelId);
        if (!stream) return false;

        const streamKey = encodeStreamKey(stream);
        socket.streamDelete(streamKey);
        heldVoiceState = { socket, state, streamKey, timer: setTimeout(releaseVoiceState, 3000) };
        return true;
    },

    addMissingVoiceStates(sorted: SortedVoiceStates) {
        let added = false;
        for (const userId of Object.keys(VoiceStateStore.getVoiceStates(sorted.guildId)))
            if (sorted._voiceStates.get(userId) == null && UserStore.getUser(userId)) added = sorted.updateVoiceState(userId) || added;
        return added;
    },

    withVideoMinBitrate(answer: RTCSessionDescriptionInit): RTCSessionDescriptionInit {
        const min = settings.store.videoMinBitrate;
        if (!min || !answer.sdp) return answer;
        return { type: answer.type, sdp: answer.sdp.replace(/x-google-max-bitrate=(\d+)/g, (_, max) => `x-google-max-bitrate=${Math.max(min, Number(max))};x-google-min-bitrate=${min}`) };
    },

    republishAudio(socket: VoiceSocket, args: Parameters<VoiceSocket["video"]>) {
        const [audioSsrc, videoSsrc, rtxSsrc, streams] = args;
        if (!audioSsrc || republishedSockets.has(socket)) return;
        republishedSockets.add(socket);
        setTimeout(() => {
            socket.video(0, videoSsrc, rtxSsrc, streams);
            setTimeout(() => socket.video(audioSsrc, videoSsrc, rtxSsrc, streams), 1500);
        }, 2000);
    },

    applyVideoBuffer(pc: RTCPeerConnection) {
        const target = settings.store.videoBufferMs || null;
        for (const receiver of pc.getReceivers())
            if (receiver.track.kind === "video") receiver.jitterBufferTarget = target;
    },

    isStreamDeleteHeld(streamKey: string) {
        return heldVoiceState?.streamKey === streamKey;
    },

    isStreamConnected() {
        return GoLiveMediaEngineStore.getMediaEngine().findConnection("stream") != null;
    },

    onGatewayClose(code: number, reason?: string) {
        if (code !== 4000 || !GATEWAY_AUTH_FAILURE.test(reason ?? "")) return;
        logger.warn(`Gateway rejected the token (${reason}), opening the account picker`);
        setTimeout(openSwitchAccountLanding);
    },

    renderLinkedBackend(userId: string) {
        const backend = settings.store.accountBackends[userId];
        const name = PREDEFINED_SERVERS.find(s => s.id === backend)?.name ?? settings.store.customServers.find(s => s.id === backend)?.name;
        return name ? <Text className="vc-endpoint-linked-backend" size="sm" weight="normal" color="text-muted">{name}</Text> : null;
    },

    isLinkedElsewhere(userId: string) {
        if (!connectedBackend) captureConnectedBackend(onDiscord ? "discord" : undefined);
        return (settings.store.accountBackends[userId] ?? (onDiscord ? "discord" : undefined)) !== connectedBackend;
    },

    markTokenValid(userId: string) {
        FluxDispatcher.dispatch({ type: "MULTI_ACCOUNT_VALIDATE_TOKEN_SUCCESS", userId });
    },

    switchAccountBackend(userId: string) {
        if (!connectedBackend) captureConnectedBackend(onDiscord ? "discord" : undefined);
        const token = TokenStorage.getToken(userId);
        if (!token || !connectedBackend || !this.isLinkedElsewhere(userId)) return false;

        const backend = getLinkedBackend(userId);
        if (backend && canSwitchInPlace(backend)) {
            applyBackendInPlace(backend);
            return false;
        }
        if (backend) {
            openAccountOn(userId, token, backend);
            return true;
        }

        const backends = [...PREDEFINED_SERVERS, ...settings.store.customServers].filter(s => hasEndpoints(s.id));
        Alerts.show({
            title: "Which backend is this account from?",
            body: (
                <>
                    <Text size="md" weight="normal">ChangeEndpoint doesn't know where this account was made. Its token gets sent to whichever backend you pick, so only pick the one it really belongs to.</Text>
                    <div className="vc-endpoint-backend-picker">
                        {backends.map(s => (
                            <Button key={s.id} variant={s.id === connectedBackend ? "primary" : "secondary"} onClick={() => { Alerts.close(); openAccountOn(userId, token, s.id); }}>
                                {s.name}
                            </Button>
                        ))}
                    </div>
                </>
            ),
            confirmText: "Cancel",
            confirmVariant: "secondary"
        });
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
                size="small"
                variant="secondary"
                onClick={e => this.openBackendMenu(e)}
            >
                Switch Backend
            </Button>
        );
    },

    renderAddAccountBackendButton() {
        return <AddAccountBackendButton openMenu={(e, onSelect, selected) => this.openBackendMenu(e, onSelect, selected)} />;
    },

    hasPendingLoginBackend() {
        return pendingLoginBackend != null;
    },

    async addAccountOnPendingBackend(token: string, finishSwitch: () => Promise<boolean>) {
        const backend = pendingLoginBackend;
        if (!backend) return false;

        const res = await fetch(`${apiBase(backend)}/v9/users/@me`, { headers: { authorization: token } }).catch(() => null);
        if (!res?.ok) {
            showToast({ text: `Logged in, but ${backendName(backend)} wouldn't confirm the account. Try again.`, variant: "critical" });
            return false;
        }

        const { id }: { id: string; } = await res.json();
        settings.store.accountBackends = { ...settings.plain.accountBackends, [id]: backend };
        if (canSwitchInPlace(backend)) {
            applyBackendInPlace(backend);
            return finishSwitch();
        }
        TokenStorage.setToken(token, id);
        settings.store.backend = backend;
        location.reload();
        return true;
    },

    renderLoginSwitchBackendButton() {
        return ReactDOM.createPortal(
            <div className="vc-endpoint-loading-switch-wrapper">{this.renderSwitchBackendButton()}</div>,
            document.body
        );
    },

    // actual loading screen buttons, pretty self explanatory #lol
    renderLoadingScreenButtons() {
        return (
            <>
                <StuckLoadingNotice />
                <div className="vc-endpoint-loading-switch-wrapper">
                    <Button
                        key="change-endpoint-loading-switch-backend"
                        type="button"
                        size="small"
                        variant="secondary"
                        onClick={e => this.openBackendMenu(e)}
                    >
                        Switch Backend
                    </Button>
                    <Button
                        key="change-endpoint-loading-switch-account"
                        type="button"
                        size="small"
                        variant="secondary"
                        onClick={e => this.onSwitchAccountClick(e)}
                    >
                        Switch Account
                    </Button>
                </div>
            </>
        );
    },

    onBeforeMessageSend(_, msg) {
        if (onDiscord) return;
        msg.content = msg.content.replace(TENOR_MEDIA1_URL, "https://media.tenor.com/$1");
    },

    flux: onDiscord ? {
        CONNECTION_OPEN() {
            linkCurrentAccount();
            saveAccountAvatar();
        },
        CURRENT_USER_UPDATE: saveAccountAvatar
    } : {
        CONNECTION_OPEN() {
            linkCurrentAccount();
            saveAccountAvatar();
            loadGifProviders();
            loadInstanceLimits().catch(e => logger.warn("Couldn't load instance limits, using Spacebar's defaults", e));
            loadInstanceInfo().catch(e => logger.warn("Couldn't load instance info", e));
        },
        CURRENT_USER_UPDATE: saveAccountAvatar,

        GUILD_MEMBERS_CHUNK_BATCH({ chunks }: { chunks: { guildId: string; notFound?: string[]; }[]; }) {
            if (getApiEndpoint() == null) return;
            for (const { guildId, notFound } of chunks)
                for (const userId of notFound ?? [])
                    if (!notMembers.has(`${guildId}:${userId}`)) queuedMembers.add(`${guildId}:${userId}`);
            if (queuedMembers.size) fetchNotFoundMembers();
        },

        CHANNEL_SELECT({ guildId, channelId }: { guildId?: string; channelId?: string; }) {
            expireSeekableMedia(channelId);
            if (getApiEndpoint() == null || !guildId || !channelId || answeredListChannels.get(guildId) === channelId) return;
            requestMemberList(guildId, channelId);
        },

        PRESENCE_UPDATES({ updates }: { updates: { user: { id: string; }; }[]; }) {
            if (getApiEndpoint() == null || memberListResync) return;
            const guildId = ChannelStore.getChannel(SelectedChannelStore.getChannelId())?.guild_id;
            if (!guildId || !updates.some(({ user }) => GuildMemberStore.isMember(guildId, user.id))) return;
            memberListResync = setTimeout(() => {
                memberListResync = null;
                const channel = ChannelStore.getChannel(SelectedChannelStore.getChannelId());
                if (channel?.guild_id) requestMemberList(channel.guild_id, channel.id);
            }, 3000);
        },

        STREAM_DELETE({ streamKey }: { streamKey: string; }) {
            if (heldVoiceState?.streamKey === streamKey) releaseVoiceState();
        },

        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: (VoiceStateChange & { userId: string; })[]; }) {
            const missingUsers: Record<string, string[]> = {};
            for (const { guildId, channelId, userId } of voiceStates)
                if (guildId && channelId && !UserStore.getUser(userId)) (missingUsers[guildId] ??= []).push(userId);
            for (const [guildId, userIds] of Object.entries(missingUsers)) GuildActions.requestMembersById(guildId, userIds, false);

            for (const { guildId, channelId, oldChannelId } of voiceStates) {
                if (!guildId || channelId === oldChannelId) continue;
                if (oldChannelId && !Object.keys(VoiceStateStore.getVoiceStatesForChannel(oldChannelId)).length) setVoiceStartTime(guildId, oldChannelId);
                if (channelId && Object.keys(VoiceStateStore.getVoiceStatesForChannel(channelId)).length === 1) setVoiceStartTime(guildId, channelId, Date.now() / 1000);
            }
        },

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
        captureConnectedBackend(onDiscord ? "discord" : undefined);
        if (onDiscord && settings.store.backend !== "discord") {
            logger.warn(`${backendName(settings.store.backend)} has no API or gateway set, staying on Discord`);
            showToast({ text: `${backendName(settings.store.backend)} has no API or gateway set, so ChangeEndpoint stayed on Discord.`, variant: "critical" });
        }
        linkCurrentAccount();
        saveAccountAvatar();

        SettingsPlugin.customEntries.push({
            key: "equicord_change_endpoint",
            title: "ChangeEndpoint",
            Component: require("./components/EndpointTab").default,
            Icon: WebsiteIcon
        });

        if (onDiscord) return;

        loadGifProviders();
        startGuildOrderSync();
        startDMUnreadPoll();
        installFetchSanitiser();
        installXHRSanitiser();
        installBoostPerkUnlocker();
        loadInstanceLimits().catch(e => logger.warn("Couldn't load instance limits, using Spacebar's defaults", e));
        loadInstanceInfo().catch(e => logger.warn("Couldn't load instance info", e));
        installGatewaySendSanitiser();
        installDaveClientConnectGuard();
        FluxDispatcher.addInterceptor(reactionEmojiInterceptor);
        FluxDispatcher.addInterceptor(spoilerInterceptor);
        FluxDispatcher.addInterceptor(memberListInterceptor);
        document.addEventListener("play", makeMediaSeekable, true);
        if (settings.store.ignoreEmailVerification) {
            const user = UserStore.getCurrentUser();
            if (user) user.verified = true;
            FluxDispatcher.addInterceptor(emailVerificationInterceptor);
        }
        installActivityUnfilter();

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
        removeFromArray(SettingsPlugin.customEntries, e => e.key === "equicord_change_endpoint");
        if (onDiscord) return;
        stopGuildOrderSync();
        stopDMUnreadPoll();
        uninstallFetchSanitiser();
        uninstallXHRSanitiser();
        uninstallGatewaySendSanitiser();
        uninstallDaveClientConnectGuard();
        releaseVoiceState();
        removeInterceptor(boostPerkInterceptor);
        removeInterceptor(reactionEmojiInterceptor);
        removeInterceptor(spoilerInterceptor);
        removeInterceptor(memberListInterceptor);
        document.removeEventListener("play", makeMediaSeekable, true);
        releaseSeekableMedia();
        removeInterceptor(emailVerificationInterceptor);
        removeInterceptor(goLiveInterceptor);
        uninstallActivityUnfilter();

        if (originalPermissionsQuery) {
            navigator.permissions.query = originalPermissionsQuery;
            originalPermissionsQuery = null;
            Native.unregisterDisplayMediaHandler();
        }
    },

    patches: [
        {
            find: /recipients:\i\.recipients,bitrate:\i\.bitrate\?\?\i\.bitrate\}/,
            // CHANNEL_UPDATE payloads that omit icon (e.g. a rename) get merged onto the
            // existing channel here - discord already re-adds bitrate the same way for the
            // same reason, icon just needs the same treatment
            replacement: {
                match: /\.merge\(\{\.\.\.(\i),recipients:(\i)\.recipients,bitrate:\1\.bitrate\?\?\2\.bitrate\}\)/,
                replace: ".merge({...$1,recipients:$2.recipients,bitrate:$1.bitrate??$2.bitrate,icon:$1.icon??$2.icon})"
            }
        },
        {
            find: ".iconEmoji,this.lastMessageId=",
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
            retry: true,
            replacement: {
                match: /(\i)\.native_build_number=(\i)/,
                replace: "$2"
            }
        },
        {
            find: "?{installation_id:",
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
            find: "os_sdk_version",
            replacement: {
                match: /(?<=\{os_sdk_version:)\i\.split\("\."\)\[\d\](?=\})/g,
                replace: "void 0",
                fallbacks: [{
                    match: /(\i)\.os_sdk_version=\i\?\.split\("\."\)\[\d\]/g,
                    replace: "$1.os_sdk_version=void 0"
                }]
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
            find: "getGuildHomeHeaderURL:",
            replacement: {
                match: /`https:\/\/(?=\$\{\i\})/g,
                replace: "`${$self.apiScheme()}//"
            }
        },
        {
            find: ".BADGE_ICON(",
            replacement: {
                match: /`https:\/\/(?=\$\{\i\}\/badge-icons\/)/,
                replace: "`${$self.apiScheme()}//"
            }
        },
        {
            find: "_getGatewayUrl(){",
            replacement: {
                match: /(?<=_getGatewayUrl\(\)\{return null!=this\.resumeUrl\?this\.resumeUrl:)\i(?=\})/,
                replace: "window.GLOBAL_ENV.GATEWAY_ENDPOINT"
            }
        },
        {
            find: /ASSET_ENDPOINT:\i,CDN_HOST:\i\}=window\.GLOBAL_ENV/,
            replacement: {
                match: /\{API_ENDPOINT:\i,MEDIA_PROXY_ENDPOINT:.{0,500}?"ig"\),\i=RegExp\(.{0,100}?"ig"\)/,
                replace: (chain: string) => refreshOnEnvChange(chain)
            }
        },
        {
            find: "/role-icons`",
            all: true,
            replacement: {
                match: /\i=`\$\{location\.protocol\}\/\/\$\{window\.GLOBAL_ENV\.CDN_HOST\}\/role-icons`,\i=`\$\{location\.protocol\}\$\{window\.GLOBAL_ENV\.API_ENDPOINT\}`/,
                replace: (chain: string) => refreshOnEnvChange(chain)
            }
        },
        {
            find: "/app-assets/application-directory/collection-items/",
            replacement: {
                match: /(?<=\(\d+\);let)\{API_ENDPOINT:\i,CDN_HOST:\i\}=window\.GLOBAL_ENV(?=;)/,
                replace: (chain: string) => refreshOnEnvChange(chain)
            }
        },
        {
            find: "MEDIA_PROXY_ENDPOINT?.substring(2)]",
            replacement: {
                match: /\i=\[window\.GLOBAL_ENV\.CDN_HOST,window\.GLOBAL_ENV\.MEDIA_PROXY_ENDPOINT\?\.substring\(2\)\]\.map\(\i\.\i\)\.filter\(\i=>null!=\i&&""!==\i\)/,
                replace: (chain: string) => refreshOnEnvChange(chain)
            }
        },
        {
            find: "ATTACHMENTS_REFRESH_URLS,body:{attachment_urls:",
            replacement: [
                {
                    match: /(?<=get\("ex"\)\?\?"",16\)\)\?void 0:)(\i)\*/,
                    replace: "$1>1e11?$1:$1*"
                },
                {
                    match: /\.refreshed_urls\[0\]\.refreshed/,
                    replace: ".refreshed_urls.map(u=>u?.refreshed??u)[0]"
                }
            ]
        },
        {
            find: '"order").reverse().value()',
            replacement: {
                match: /(?<=src:)(\i\?\.\(\i\.src,\i\)\?\?\i\.src)(\}\)\)\.sortBy\("order"\)\.reverse\(\)\.value\(\),\[\i,\i)\]/,
                replace: "$self.refreshedGifSrc($1)$2,$self.useGifRefreshVersion()]"
            }
        },
        {
            find: '"MaskedLinkStore"',
            replacement: {
                match: /\i=window\.GLOBAL_ENV\.MEDIA_PROXY_ENDPOINT\?\.replace\("\/\/",""\)/,
                replace: (chain: string) => refreshOnEnvChange(chain)
            }
        },
        {
            find: "toURLSafe(window.GLOBAL_ENV.API_ENDPOINT)",
            all: true,
            replacement: {
                match: /\i=\i\.\i\.toURLSafe\(window\.GLOBAL_ENV\.API_ENDPOINT\)\?\.host\?\?"localhost"/,
                replace: (chain: string) => refreshOnEnvChange(chain)
            }
        },
        {
            find: "window.GLOBAL_ENV.GUILD_TEMPLATE_HOST]);",
            replacement: {
                match: /\i=new Set\(\[window\.GLOBAL_ENV\.CDN_HOST,window\.GLOBAL_ENV\.INVITE_HOST,window\.GLOBAL_ENV\.GIFT_CODE_HOST,window\.GLOBAL_ENV\.GUILD_TEMPLATE_HOST\]\)/,
                replace: (chain: string) => refreshOnEnvChange(chain)
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
            find: ".GuildFeatures.ENHANCED_ROLE_COLORS)",
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
                    ),
                fallbacks: [{
                    match: /function (\i)\((\i),(\i)\)\{(?=.{0,40}?if\(0===\3\.length\)return\{colorString:null)/,
                    replace: "function $1($2,$3){return $self.withEveryoneColor($2,$1_vc($2,$3))}function $1_vc($2,$3){"
                }]
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
            find: /originalContentType:\i\.original_content_type,loadingState:\i\.loading_state/,
            replacement: {
                match: /(?<=proxyUrl:(\i)\.proxy_url,)height:\1\.height,width:\1\.width,/,
                replace: "height:$1.height||360,width:$1.width||640,"
            }
        },
        {
            find: /loadingState:\i\.loading_state,/,
            replacement: {
                match: /(?<=loadingState:\i\.loading_state)(?=,)/,
                replace: "??2"
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
            find: ".WEBRTC].find(",
            replacement: {
                match: /\[(\i\.\i\.NATIVE),(\i\.\i\.WEBRTC)\](?=\.find\(\i=>\i\(\i\)\.supported\(\)\))/,
                replace: "[$2,$1]"
            }
        },
        {
            find: '"Node.js"===',
            retry: true,
            replacement: {
                match: /"Chrome"===(\i)\(\)\.name\|\|"Safari"===\i\(\)\.name\|\|"Firefox"===\i\(\)\.name&&(\i)>=80\|\|"Opera"===\i\(\)\.name\|\|"Microsoft Edge"===\i\(\)\.name/,
                replace: '($&||"Electron"===$1().name&&$2>=1)'
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
            find: /startsWith\("blob:"\)\)return \i;let \i=/,
            replacement: {
                match: /(let (\i)=\i\.\i\.toURLSafe\(\i\);return null==\2\?null:\()\2\.searchParams\.set\("format","webp"\)/,
                replace: '$1/\\.(mov|mp4|webm|mkv|avi|mpg|mpeg)$/i.test($2.pathname)||$2.searchParams.set("format","webp")'
            }
        },
        {
            find: 'case"VIDEO":case"CLIP":return(0,',
            replacement: {
                match: /case"VIDEO":case"CLIP":return\(0,\i\.\i\)\(\i,(\{item:\i,[^}]{0,800}\})\)/,
                replace: 'case"VIDEO":case"CLIP":return $self.renderVideoAttachment($1)'
            }
        },
        {
            find: /hasPermissionCore\(\i,\i\)\{return this\.asyncify\(/,
            replacement: {
                match: /(hasPermissionCore\(\i,\i\)\{)return this\.asyncify\([^}]*\)\}/,
                replace: "$1return Promise.resolve(!0)}"
            }
        },
        {
            find: /requestPermissionCore\(\i,\i\)\{return this\.asyncify\(/,
            replacement: {
                match: /(requestPermissionCore\(\i,\i\)\{)return this\.asyncify\([^}]*\)\}/,
                replace: "$1return Promise.resolve(!0)}"
            }
        },
        {
            find: /didHavePermission\(\i\)\{return this\.storage\.hasPermission\(\i\)\}/,
            replacement: {
                match: /(didHavePermission\(\i\)\{)return this\.storage\.hasPermission\(\i\)\}/,
                replace: "$1return!0}"
            }
        },
        {
            find: /getCollectiblesItemAssetUrl:\i\}=\i\(/,
            replacement: {
                match: /(let\{CollectiblesItemAssetFormat:\w+,getCollectiblesItemAssetUrl:\w+\}=\w+\(\d+\),\w+=\w+\?\w+\.ANIMATED:\w+\.STATIC,\w+=\w+\(\{skuId:\w+\.skuId,assetFormat:\w+\}\);)if\(null!=\w+\)return \w+\}catch\{return null\}/,
                replace: "$1}catch{return null}"
            }
        },
        {
            find: 'source_object:"GIF Picker"',
            retry: true,
            replacement: {
                match: /(gif_provider:(\i)\.provider.{0,150}?source_object:"GIF Picker",gif_url:\2\.url,gif_id:\2\.id\};)(\i)\(\2\.url,(void 0,void 0,!0,void 0,\i)\)/,
                replace: "$1$self.sendGifUpload($2,()=>$3($self.resolveGifUrl($2),$4))"
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
                    replace: '$&if($self.isLinkedElsewhere($3))return void $2.dispatch({type:"MULTI_ACCOUNT_VALIDATE_TOKEN_SUCCESS",userId:$3});',
                    fallbacks: [{
                        match: /(?<=\{type:"MULTI_ACCOUNT_VALIDATE_TOKEN_FAILURE",userId:(\i)\}\);)/,
                        replace: "if($self.isLinkedElsewhere($1))return void $self.markTokenValid($1);"
                    }]
                }
            ]
        },
        {
            find: "#{intl::CREATE_SERVER_GUIDELINES},{guidelinesURL:",
            retry: true,
            replacement: {
                match: /\i\.intl\.format\(\i\.t#{intl::CREATE_SERVER_GUIDELINES},\{guidelinesURL:[^}]{0,40}\}\)/,
                replace: "$self.renderGuildGuidelines()"
            }
        },
        {
            find: ".terms,{guidelinesURL:",
            retry: true,
            replacement: {
                match: /\i\.intl\.format\(\i\.terms,\{guidelinesURL:[^}]{0,40}\}\)/,
                replace: "$self.renderGuildGuidelines()"
            }
        },
        {
            find: "[WS CLOSED] because of authentication failure, marking as closed.",
            replacement: {
                match: /_handleClose\((\i),(\i),(\i)\)\{/,
                replace: "$&$self.onGatewayClose($2,$3);",
                fallbacks: [{
                    match: /_handleClose\([^)]{0,30}\)\{/,
                    replace: "$&$self.onGatewayClose(arguments[1],arguments[2]);"
                }]
            }
        },
        {
            find: "[WS CLOSED] because of authentication failure, marking as closed.",
            replacement: [
                {
                    match: /voiceStateUpdate\((\i)\)\{/,
                    replace: "$&if($self.holdVoiceState(this,$1))return;"
                },
                {
                    match: /streamDelete\((\i)\)\{/,
                    replace: "$&if($self.isStreamDeleteHeld($1))return;"
                },
                {
                    match: /streamCreate\(\i,\i,\i\)\{/,
                    replace: "$&if($self.isStreamConnected())return;"
                },
                {
                    match: /updateGuildSubscriptions\((\i)\)\{/,
                    replace: "$&$self.orderGuildSubscriptions($1);"
                }
            ]
        },
        {
            find: "additionalEmojiSlots??0)",
            replacement: [
                {
                    match: /(?<=function \i\((\i),\i\)\{return )(?=null!=\i&&\i\.features\.has\(\i\.\i\.MORE_STICKERS\)&&\1===(\i\.\i\.TIER_3)\?)/,
                    replace: "$1===$2&&$self.maxStickers()?$self.maxStickers():"
                },
                {
                    match: /(?<=function \i\((\i)\)\{return )(\i)\.(\i)\[\1\](?=\}function \i\(\i,\i\)\{return \2\.\i\[\i\]\.features\.includes\()/,
                    replace: "$self.stickerTierSlots($1,$2.$3)"
                },
                {
                    match: /(?<=MORE_EMOJI\)\?)200/,
                    replace: "$self.maxEmojis()||$&"
                }
            ]
        },
        {
            find: /canUseIncreasedMessageLength\(\i\.getCurrentUser\(\)\)\?4e3:2e3/,
            replacement: {
                match: /\i\.\i\.canUseIncreasedMessageLength\(\i\.getCurrentUser\(\)\)\?4e3:2e3/,
                replace: "($&,$self.maxMessageLength())"
            }
        },
        {
            find: /THREADS\.has\(\i\)\?\(0,\i\.\i\)\(\i,!1\):\i\.\i\.LIMITED_CHANNEL_NAME\.has\(/,
            replacement: {
                match: /(?<=LIMITED_CHANNEL_NAME\.has\(\i\)\?)\(0,\i\.\i\)\((\i)\)/,
                replace: "$self.sanitizeChannelName($1)"
            }
        },
        {
            find: "onChange:this.handleNameChange,inputRef:this.setInputRef",
            replacement: {
                match: /(?<=onChange:this\.handleNameChange,inputRef:this\.setInputRef,maxLength:)100(?=,)/,
                replace: "$self.maxChannelName()"
            }
        },
        {
            find: 'name:"discriminator","aria-label"',
            replacement: {
                match: /(?<=name:"username",value:\i,maxLength:)32(?=,)/,
                replace: "$self.maxUsername()"
            }
        },
        {
            find: "onChange:this.handleChangeRichTopic",
            replacement: [
                {
                    match: /(?<=handleChangeName=\i=>\{.{0,60}?\i=)\(0,\i\.\i\)\(\i,\i\.type\)/,
                    replace: "$self.renameChannel(()=>$&)"
                },
                {
                    match: /(?<=onChange:this\.handleChangeName,onBlur:this\.handleBlurName,.{0,120}?maxLength:)100/,
                    replace: "$self.maxChannelName()"
                },
                {
                    match: /(?<=maxCharacterCount:\i\?4096:)1024(?=,onChange:this\.handleChangeRichTopic)/,
                    replace: "$self.maxTopic()"
                }
            ]
        },
        {
            find: "EMPTY_MESSAGE});let",
            replacement: {
                match: /(?<=let \i=)\i\?4e3:2e3(?=;if\(\i\.length>\i\))/,
                replace: "($&,$self.maxMessageLength())"
            }
        },
        {
            find: '"2026-08-user-bio-max-length"',
            replacement: {
                match: /\i\.(?:useConfig|getConfig)\(\{location:\i\}\)\.maxLength/g,
                replace: "($&,$self.maxBio())"
            }
        },
        {
            find: /currentPronouns:\i,disabled:\i=!1\}=\i/,
            replacement: {
                match: /(?<=currentPronouns:.{0,300}?maxLength:)40(?=,value:)/,
                replace: "$self.maxPronouns()"
            }
        },
        {
            find: "isCurrentSource(",
            replacement: {
                match: /(?<=\.some\(\i=>\i\.id===(\i)\)&&\(\i\.deviceId=)\1(?=\))/,
                replace: "{exact:$1}",
                fallbacks: [{
                    match: /(?<=\i\.some\(\i=>\i\.id===this\.sourceId\)&&\()(\i)\.deviceId=this\.sourceId(?=\))/,
                    replace: "$1.deviceId={exact:this.sourceId}"
                }]
            }
        },
        {
            find: "this.send(12,{audio_ssrc:",
            predicate: () => getCdnHost() != null,
            replacement: {
                match: /video\(\i,\i,\i,\i\)\{(?=this\.send\(12,)/,
                replace: "$&$self.republishAudio(this,arguments);"
            }
        },
        {
            find: "async setRemoteAnswer(",
            replacement: {
                match: /(async setRemoteAnswer\(\i,\i,\i,\i\)\{let (\i)=this\.pc,.{0,120}?try\{await \2\.setRemoteDescription\()(\i)\)/,
                replace: "$1$self.withVideoMinBitrate($3));$self.applyVideoBuffer($2)",
                fallbacks: [{
                    match: /(async setRemoteAnswer\([^)]{0,30}\)\{.{0,300}?await (this\.pc|\i)\.setRemoteDescription\()(\i)\)/,
                    replace: "$1$self.withVideoMinBitrate($3));$self.applyVideoBuffer(this.pc)"
                }]
            }
        },
        {
            find: '"SortedVoiceStateStore"',
            replacement: {
                match: /updateUsers\(\)\{return (null==this\._pending&&this\._voiceStates\.values\(\)\.reduce\(.{0,200}?,!1\))\}/,
                replace: "updateUsers(){return $self.addMissingVoiceStates(this)|($1)}",
                fallbacks: [{
                    match: /updateUsers\(\)\{/,
                    replace: "updateUsers(){return $self.addMissingVoiceStates(this)|this.vcUpdateUsers()}vcUpdateUsers(){"
                }]
            }
        },
        {
            find: 'location:"getUserMaxFileSize"',
            predicate: () => settings.store.serverAttachmentLimit,
            replacement: {
                match: /function\(\i\)\{(?=return null==\i\?\i\.\i:\i\.isStaff\(\))/,
                replace: "$&if($self.maxAttachmentSize())return $self.maxAttachmentSize();"
            }
        },
        {
            find: 'location:"uploadSumTooLarge"',
            predicate: () => settings.store.serverAttachmentLimit,
            replacement: {
                match: /function \i\(\i\)\{(?=let \i=\i\.default\.getCurrentUser\(\),\i=\i\.\i\.getUserMaxFileSize\(\i\))/,
                replace: "$&if($self.maxAttachmentSize())return $self.maxAttachmentSize();"
            }
        },
        {
            find: "enabled?0x40000000:524288e3",
            predicate: () => settings.store.serverAttachmentLimit,
            replacement: {
                match: /function\(\i\)\{(?=let\{location:\i\}=\i;return\(0,\i\.\i\)\(\{location:\i\}\)\.enabled\?0x40000000:524288e3)/,
                replace: "$&if($self.maxTotalAttachmentSize())return $self.maxTotalAttachmentSize();"
            }
        },
        {
            find: "USE_EXTERNAL_STICKERS,user:",
            predicate: () => settings.store.disrespectPermissions,
            replacement: {
                match: /\i\.\i\(\{permission:\i\.\i\.USE_EXTERNAL_STICKERS,user:\i,context:\i\}\)/,
                replace: "!0"
            }
        },
        {
            find: '"getDestinationIsUnavailable"',
            predicate: () => settings.store.disrespectPermissions,
            replacement: {
                match: /!\i\.\i\.can\(\i\.\i\.USE_EXTERNAL_STICKERS,\i\)/,
                replace: "!1"
            }
        },
        {
            find: "async batchChannelUpdate(",
            replacement: [
                {
                    match: /(?<=batchChannelUpdate\((\i),(\i)\)\{let \i=await \i\.\i\.patch\(\{url:\i\.\i\.GUILD_CHANNELS\(\i\),body:)\2(?=,)/,
                    replace: "$self.reorderChannelsForSpacebar($1,$2)"
                },
                {
                    match: /(?<=async batchChannelUpdate\((\i),(\i)\)\{)/,
                    replace: "await $self.moveChannelParentsForSpacebar($1,$2);"
                }
            ]
        },
        {
            find: "handleIdentify called",
            replacement: [
                {
                    match: /(?<=presence:)\i\.getInitialState\(\)/,
                    replace: "$self.identifyPresence($&)"
                },
                {
                    match: /(?<=properties:\{\.\.\.)(\i\.default\.getSuperProperties\(\)),client_app_state:\i,is_fast_connect:!1,gateway_connect_reasons:\i\.\i\(\),/,
                    replace: "$self.identifyProperties($1),",
                    fallbacks: [{
                        match: /(?<=properties:\{\.\.\.)(\i\.\i\.getSuperProperties\(\)),/,
                        replace: "$self.identifyProperties($1),"
                    }]
                }
            ]
        },
        {
            find: 'type:"GUILD_VERIFICATION_CHECK",guildId:',
            predicate: () => settings.store.ignoreEmailVerification,
            replacement: {
                match: /(?<=\i=)\i\.verificationLevel>=\i\.\i\.VERY_HIGH/,
                replace: "!1"
            }
        },
        {
            find: '"VOICE_STATE_UPDATES",voiceStates:',
            replacement: {
                match: /null!=(\i)\.member&&(?=\i\(\1\.guild_id,\1\.member\.user,\1\.member\))/g,
                replace: "null!=$1.member?.user&&"
            }
        },
        {
            find: 'navId:"manage-multi-account"',
            replacement: [
                {
                    match: /(color:"text-default",variant:"[^"]{1,20}",children:\i\}\)\]\}\),\i)\]/,
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
            find: "#{intl::SWITCH_ACCOUNTS_CHOOSE_ACCOUNT_HELPER})",
            retry: true,
            replacement: {
                match: /(children:\(0,\i\.jsx\)\(\i\.\i,\{variant:"secondary",size:"md",textVariant:"body-sm\/medium",text:\i\.intl\.string\(\i\.\i#{intl::SWITCH_ACCOUNTS_ADD_AN_ACCOUNT_BUTTON}\),onClick:\i\}\)\}\))\]\}\)\}/,
                replace: "$1,$self.renderLoginSwitchBackendButton()]})}"
            }
        },
        {
            find: "username webauthn",
            retry: true,
            replacement: {
                match: /(\i&&\i)&&\(0,(\i)\.jsx\)\("div",\{className:(\i\.\i),children:(\(0,\i\.jsx\)\(\i\.\i,\{onClick:\(\)=>\i\(!1\),variant:"secondary",text:\i\.intl\.string\(\i\.\i#{intl::AGE_GATE_GO_BACK}\),icon:\i\.\i\}\))\}\)/,
                replace: "(0,$2.jsxs)(\"div\",{className:$3,style:{display:\"flex\",alignItems:\"center\",gap:\"8px\"},children:[$1&&$4,$self.renderLoginSwitchBackendButton()]})"
            }
        },
        {
            find: '#{intl::BACK}),type:"button"',
            retry: true,
            replacement: {
                match: /(?<=leading:)\(0,(\i)\.jsx\)\(\i\.\i,\{variant:"secondary",size:"md",onClick:\i,text:\i\.intl\.string\(\i\.\i#{intl::BACK}\),type:"button"\}\)/,
                replace: '(0,$1.jsxs)("div",{style:{display:"flex",alignItems:"center",gap:"8px"},children:[$self.renderAddAccountBackendButton(),$&]})'
            }
        },
        {
            find: '"Switched accounts finished"',
            replacement: {
                match: /switchAccountToken\((\i)\)\{/,
                replace: "$&if($self.hasPendingLoginBackend())return $self.addAccountOnPendingBackend($1,()=>this.switchAccountToken($1));",
                fallbacks: [{
                    match: /switchAccountToken\((\i)[^)]{0,20}\)\{/,
                    replace: "$&if($self.hasPendingLoginBackend())return $self.addAccountOnPendingBackend($1,()=>this.switchAccountToken($1));"
                }]
            }
        },
        {
            find: "--connecting-container-fade-duration",
            replacement: {
                match: /(\(0,\i\.jsxs\)\("div",\{className:\i\(\)\(\i\.Bk,\{\[\i\.ly\]:this\.state\.problems\}\),children:\[\(0,\i\.jsx\)\("div",\{className:\i\.u1,children:\i\.intl\.string\(\i\.\i#{intl::CONNECTING_PROBLEMS_CTA}\)\}\),\(0,\i\.jsxs\)\("div",\{children:\[\(0,\i\.jsxs\)\(\i\.Anchor,\{className:\i\.AR,href:\i\.\i\.TWITTER_SUPPORT,target:"_blank",children:\[\(0,\i\.jsx\)\(\i\.\i,\{size:"xs",color:"currentColor",className:\i\.Kk\}\),\i\.intl\.string\(\i\.t\.\i\)\]\}\),\(0,\i\.jsxs\)\(\i\.Anchor,\{className:\i\.gy,href:\i\.\i\.STATUS,target:"_blank",children:\[\(0,\i\.jsx\)\(\i,\{className:\i\.Kk\}\),\i\.intl\.string\(\i\.t\.\i\)\]\}\)\]\}\)\]\}\))/,
                replace: "$1,$self.renderLoadingScreenButtons()",
                fallbacks: [{
                    match: /(?<=href:\i\.\i\.STATUS,target:"_blank",children:\[[^\]]{0,200}\]\}\)\]\}\)\]\}\))/,
                    replace: ",$self.renderLoadingScreenButtons()"
                }]
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
            find: "_ensureDaveProtocolVersionAllowed(",
            // spacebar backends never speak DAVE (voice e2ee) at all, so this always
            // sees a "downgrade" to version 0 and disconnects - refusing a downgrade
            // only makes sense against a backend that had dave to downgrade from
            replacement: {
                match: /_ensureDaveProtocolVersionAllowed\(\i,\i,\i\)\{/,
                replace: "$&return!0;",
                fallbacks: [{
                    match: /_ensureDaveProtocolVersionAllowed\([^)]{0,30}\)\{/,
                    replace: "$&return!0;"
                }]
            }
        },
        {
            find: "disconnectForInvalidDaveMessage(`op ${",
            replacement: {
                match: /(?<=\i\.dave_protocol_version)(?=\))/,
                replace: "??0",
                fallbacks: [{
                    match: /(?<=\.dave_protocol_version)(?=[,)])/,
                    replace: "??0"
                }]
            }
        },
        {
            // never load libdave or advertise dave support, so voice identifies with
            // max_dave_protocol_version 0 and connections skip the e2ee frame transforms
            find: "startDavePreload(){",
            predicate: () => getApiEndpoint() != null,
            replacement: [
                {
                    match: /fetchDave:\(0,\i\.\i\)\(\)/,
                    replace: "fetchDave:!1",
                    fallbacks: [{
                        match: /(?<=fetchAsyncResources\(\)\{let \i=\{fetchDave:)[^}]{1,40}(?=\})/,
                        replace: "!1"
                    }]
                },
                {
                    match: /startDavePreload\(\)\{/,
                    replace: "$&return;"
                },
                {
                    match: /(getSupportedSecureFramesProtocolVersion\(\)\{)return \i\.getSupportedSecureFramesProtocolVersion\(\)\}/,
                    replace: "$1return 0}",
                    fallbacks: [{
                        match: /(?<=getSupportedSecureFramesProtocolVersion\(\)\{)/,
                        replace: "return 0;"
                    }]
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
    ].filter(patch => !onDiscord || typeof patch.find === "string" && DISCORD_SAFE_PATCHES.has(patch.find))
});
