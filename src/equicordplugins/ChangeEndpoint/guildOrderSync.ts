import { FluxDispatcher, RestAPI } from "@webpack/common";
import { findByPropsLazy, findStore } from "@webpack";

const GuildActionCreators = findByPropsLazy("moveById", "createGuildFolderLocal");
const GuildStore = findByPropsLazy("getGuild", "getGuilds");

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

let lastSignature: string | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pollingStarted = false;

const POLL_INTERVAL = 45 * 1000;

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

export function startGuildOrderSync() {
    if (pollingStarted) return;
    pollingStarted = true;

    pollSavedGuildOrder();

    FluxDispatcher.subscribe("GUILD_MOVE_BY_ID", schedulePush);
    FluxDispatcher.subscribe("GUILD_FOLDER_CREATE_LOCAL", schedulePush);
    FluxDispatcher.subscribe("GUILD_FOLDER_EDIT_LOCAL", schedulePush);
    FluxDispatcher.subscribe("GUILD_FOLDER_DELETE_LOCAL", schedulePush);
}

export function stopGuildOrderSync() {
    pollingStarted = false;

    if (pollTimer) clearTimeout(pollTimer);

    FluxDispatcher.unsubscribe("GUILD_MOVE_BY_ID", schedulePush);
    FluxDispatcher.unsubscribe("GUILD_FOLDER_CREATE_LOCAL", schedulePush);
    FluxDispatcher.unsubscribe("GUILD_FOLDER_EDIT_LOCAL", schedulePush);
    FluxDispatcher.unsubscribe("GUILD_FOLDER_DELETE_LOCAL", schedulePush);
    if (debounceTimer) clearTimeout(debounceTimer);
}
