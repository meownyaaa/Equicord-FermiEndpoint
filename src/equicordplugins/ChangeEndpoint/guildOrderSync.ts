import { FluxDispatcher, RestAPI } from "@webpack/common";
import { findByPropsLazy, findStore } from "@webpack";

const GuildActionCreators = findByPropsLazy("moveById", "createGuildFolderLocal");

interface HarmonyGuildFolder {
    id: string | null;
    name: string | null;
    guild_ids: string[];
    color: number | null;
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

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

async function pushLastChannel(channelId: string, guildId: string | null) {
    try {
        await RestAPI.patch({
            url: "/users/@me/settings",
            body: {
                guild_positions_last_channel: { guild_id: guildId, channel_id: channelId }
            }
        });
    } catch (e) {
        console.error("[ChangeEndpoint] Failed to push last channel", e);
    }
}

let lastSignature: string | null = null;
let lastInteraction = Date.now();
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pollingStarted = false;

const ACTIVE_INTERVAL = 30 * 1000;
const IDLE_INTERVAL = 30 * 1000;
const ACTIVE_WINDOW = 2000 * 60 * 1000;

function markInteraction() {
    lastInteraction = Date.now();
}

async function pollSavedGuildOrder() {
    try {
        const res = await RestAPI.get({ url: "/users/@me/settings" });
        const folders: HarmonyGuildFolder[] = res?.body?.guild_folders ?? [];
        const signature = JSON.stringify(folders);

        if (folders.length && signature !== lastSignature) {
            console.log("[ChangeEndpoint] Applying updated guild order from server", folders);
            await applyGuildOrder(folders);
            lastSignature = signature;
        }
    } catch (e) {
        console.error("[ChangeEndpoint] Failed to poll saved guild order", e);
    } finally {
        const interval = Date.now() - lastInteraction < ACTIVE_WINDOW ? ACTIVE_INTERVAL : IDLE_INTERVAL;
        pollTimer = setTimeout(pollSavedGuildOrder, interval);
    }
}

async function applyGuildOrder(folders: HarmonyGuildFolder[]) {
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
}

export function startGuildOrderSync() {
    if (pollingStarted) return;
    pollingStarted = true;

    window.addEventListener("mousemove", markInteraction);
    window.addEventListener("keydown", markInteraction);
    window.addEventListener("mousedown", markInteraction);

    pollSavedGuildOrder();

    FluxDispatcher.subscribe("GUILD_MOVE_BY_ID", schedulePush);
    FluxDispatcher.subscribe("GUILD_FOLDER_CREATE_LOCAL", schedulePush);
    FluxDispatcher.subscribe("GUILD_FOLDER_EDIT_LOCAL", schedulePush);
    FluxDispatcher.subscribe("GUILD_FOLDER_DELETE_LOCAL", schedulePush);
    FluxDispatcher.subscribe("CHANNEL_SELECT", (e: any) => {
        if (e.channelId) pushLastChannel(e.channelId, e.guildId ?? null);
    });
}

export function stopGuildOrderSync() {
    pollingStarted = false;

    window.removeEventListener("mousemove", markInteraction);
    window.removeEventListener("keydown", markInteraction);
    window.removeEventListener("mousedown", markInteraction);

    if (pollTimer) clearTimeout(pollTimer);

    FluxDispatcher.unsubscribe("GUILD_MOVE_BY_ID", schedulePush);
    FluxDispatcher.unsubscribe("GUILD_FOLDER_CREATE_LOCAL", schedulePush);
    FluxDispatcher.unsubscribe("GUILD_FOLDER_EDIT_LOCAL", schedulePush);
    FluxDispatcher.unsubscribe("GUILD_FOLDER_DELETE_LOCAL", schedulePush);
    if (debounceTimer) clearTimeout(debounceTimer);
}
