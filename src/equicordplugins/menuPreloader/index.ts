/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import { extractAndLoadChunksLazy } from "@webpack";
import { UserStore } from "@webpack/common";

const logger = new Logger("MenuPreloader");

const CHUNK_LOADER = String.raw`Promise\.all\(\[((?:\i\.e\([^)]*\),)*\i\.e\([^)]*\))\]\)\.then\(\i\.bind\(\i,"?([^)"]+)"?\)\)`;
const loaderMatcher = (before: string, after = "") => new RegExp(before + CHUNK_LOADER + after);

const MENUS: Array<[name: string, load: () => Promise<boolean>]> = [
    ["user settings", extractAndLoadChunksLazy(["USER_SETTINGS_MODAL_OPEN", "stackNextByDefault:!0"], loaderMatcher(String.raw`USER_SETTINGS_MODAL_OPEN.{0,300}?`))],
    ["guild context menu", extractAndLoadChunksLazy(["guildNode:", '"unavailable-guilds-button"'], loaderMatcher(String.raw`\(0,\i\.\i\)\(\i,async\(\)=>\{let\{default:\i\}=await `, String.raw`(?=;return \i=>\(0,\i\.jsx\)\(\i,\{\.\.\.\i,guild:\i\}\))`))],
    ["user context menu", extractAndLoadChunksLazy(["handleUserContextMenu(", "parsedUserId"], loaderMatcher(String.raw`handleUserContextMenu\(.{0,150}?`))],
    ["user profile", extractAndLoadChunksLazy(["USER_PROFILE_MODAL_OPEN:", "USER_PROFILE_MODAL_CLOSE:", "openModalLazy"], loaderMatcher(String.raw`openModalLazy\)\(async\(\)=>\{let \i=\(await `))],
    ["settings context menu", extractAndLoadChunksLazy(["handleOpenSettingsContextMenu"], loaderMatcher(String.raw`handleOpenSettingsContextMenu=.{0,150}?`))],
    ["guild settings", extractAndLoadChunksLazy(['"GuildSettingsActionCreators"'], loaderMatcher(String.raw`async open\([^)]{0,30}\)\{await `))],
];

let running = false;
let preloaded = false;

const whenIdle = () => new Promise(resolve => requestIdleCallback(resolve, { timeout: 10_000 }));

async function preloadMenus() {
    if (preloaded) return;
    preloaded = true;

    for (const [name, load] of MENUS) {
        await whenIdle();
        if (!running) return;

        const start = performance.now();
        const loaded = await load().catch(e => {
            logger.warn(`Couldn't preload the ${name}`, e);
            return false;
        });
        if (loaded) logger.debug(`Preloaded the ${name} in ${Math.round(performance.now() - start)}ms`);
    }
}

export default definePlugin({
    name: "MenuPreloader",
    description: "Loads the code for common menus in the background once Discord is idle, so they open straight away the first time.",
    authors: [],
    enabledByDefault: true,

    flux: {
        CONNECTION_OPEN() {
            preloadMenus();
        }
    },

    start() {
        running = true;
        if (UserStore.getCurrentUser()) preloadMenus();
    },

    stop() {
        running = false;
    }
});
