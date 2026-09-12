/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings, Settings } from "@api/Settings";
import { localStorage } from "@utils/localStorage";
import { Logger } from "@utils/Logger";
import { OptionType } from "@utils/types";
import { Alerts, Button, Toasts } from "@webpack/common";

const logger = new Logger("ChangeEndpoint");

export function migrateVideoPlayerSetting() {
    const s = Settings.plugins.ChangeEndpoint as { useNativeVideoPlayer?: boolean; useChromiumVideoPlayer?: boolean; };
    if (Object.hasOwn(s, "useNativeVideoPlayer") && !Object.hasOwn(s, "useChromiumVideoPlayer")) {
        s.useChromiumVideoPlayer = !s.useNativeVideoPlayer;
        delete s.useNativeVideoPlayer;
    }
}

export function migrateDefaultBackend() {
    const s = Settings.plugins.ChangeEndpoint as { backend?: string; migratedDefaultBackend?: boolean; };
    if (!s.migratedDefaultBackend) {
        if (!Object.hasOwn(s, "backend") || s.backend === "harmony") {
            s.backend = "spacebar";
        }
        s.migratedDefaultBackend = true;
    }
}

export function migrateCustomServers() {
    const s = Settings.plugins.ChangeEndpoint as {
        backend?: string;
        customBackendHost?: string;
        customApiEndpoint?: string;
        customCdnHost?: string;
        customGatewayEndpoint?: string;
        customMediaProxyEndpoint?: string;
        customServers?: import("./servers").CustomServer[];
        migratedCustomServers?: boolean;
    };
    if (s.migratedCustomServers) return;
    s.migratedCustomServers = true;

    const hadLegacyCustom = s.customBackendHost || s.customApiEndpoint || s.customCdnHost
        || s.customGatewayEndpoint || s.customMediaProxyEndpoint;
    if (!hadLegacyCustom) return;

    const wasAdvanced = s.backend === "custom-advanced";
    const id = `custom-${Date.now().toString(36)}`;
    s.customServers = [
        ...(s.customServers ?? []),
        {
            id,
            name: "Custom Server",
            type: wasAdvanced ? "advanced" : "simple",
            host: s.customBackendHost || undefined,
            apiEndpoint: s.customApiEndpoint || undefined,
            cdnHost: s.customCdnHost || undefined,
            gatewayEndpoint: s.customGatewayEndpoint || undefined,
            mediaProxyEndpoint: s.customMediaProxyEndpoint || undefined
        }
    ];

    if (s.backend === "custom-simple" || s.backend === "custom-advanced") {
        s.backend = id;
    }

    delete s.customBackendHost;
    delete s.customApiEndpoint;
    delete s.customCdnHost;
    delete s.customGatewayEndpoint;
    delete s.customMediaProxyEndpoint;
}

const isOurs = (name: string) => name.startsWith("Vencord") || name.startsWith("Equicord");

function clearCachedLoginData() {
    try {
        for (const key of Object.keys(localStorage)) {
            if (!isOurs(key)) localStorage.removeItem(key);
        }
        window.sessionStorage?.clear();

        window.indexedDB?.databases?.()
            .then(dbs => dbs.forEach(db => db.name && !isOurs(db.name) && indexedDB.deleteDatabase(db.name)))
            .catch(e => logger.error("Failed to enumerate IndexedDB databases", e));

        for (const cookie of document.cookie.split(";")) {
            const name = cookie.split("=")[0]?.trim();
            if (name) document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
        }

        Toasts.show({
            id: Toasts.genId(),
            message: "Cleared cached login data",
            type: Toasts.Type.SUCCESS
        });
    } catch (e) {
        logger.error("Failed to clear cached data", e);
        Toasts.show({
            id: Toasts.genId(),
            message: "Failed to clear cached data.",
            type: Toasts.Type.FAILURE
        });
    }
}

const ClearCacheButton = () => (
    <Button
        color={Button.Colors.RED}
        onClick={() => Alerts.show({
            title: "Clear cached login data?",
            body: "This clears Discord's localStorage, sessionStorage, and IndexedDB for this client. " +
                "Your Equicord settings and plugin data are kept. " +
                "You'll need to fully quit Discord, or back out of here afterwards and hit Restart at the " +
                "top of the plugins page.",
            confirmText: "Clear data",
            cancelText: "Cancel",
            confirmColor: Button.Colors.RED,
            onConfirm: clearCachedLoginData
        })}
    >
        Clear Cached Login Data
    </Button>
);

export const settings = definePluginSettings({
    backend: {
        type: OptionType.CUSTOM,
        description: "Backend to connect to",
        default: "spacebar"
    },
    customServers: {
        type: OptionType.CUSTOM,
        description: "User-added custom servers, each with its own id/name/type/endpoints. " +
            "backend references one of these ids when a custom server (rather than a predefined one) is active.",
        default: [] as import("./servers").CustomServer[]
    },
    accountBackends: {
        type: OptionType.CUSTOM,
        description: "Per-account backend map. Keys are Discord user IDs, values are backend ids " +
            "(a PREDEFINED_SERVERS id, or \"custom-simple\"/\"custom-advanced\"). When set, switching to " +
            "that account via Discord's own account switcher also switches the backend, followed by a reload.",
        default: {} as Record<string, string>
    },
    useChromiumVideoPlayer: {
        type: OptionType.BOOLEAN,
        description: "Use a plain HTML5 video element with the browser's default controls for attachments " +
            "instead of Discord's real video player component. Discord's player is the default since it looks " +
            "and behaves like the genuine client, but turn this on if it ever misbehaves on your instance's video URLs.",
        default: false,
        restartNeeded: true
    },
    clearCache: {
        type: OptionType.COMPONENT,
        component: ClearCacheButton
    }
});
