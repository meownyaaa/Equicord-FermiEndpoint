/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings, Settings } from "@api/Settings";
import { localStorage } from "@utils/localStorage";
import { Logger } from "@utils/Logger";
import { OptionType } from "@utils/types";
import { Alerts, Button, showToast } from "@webpack/common";

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

        for (const cookie of document.cookie.split(";")) {
            const name = cookie.split("=")[0]?.trim();
            if (name) document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
        }

        showToast("Cleared cached login data", "success");
    } catch (e) {
        logger.error("Failed to clear cached data", e);
        showToast("Failed to clear cached data.", "failure");
    }
}

const ClearCacheButton = () => (
    <Button
        color={Button.Colors.RED}
        onClick={() => Alerts.show({
            title: "Clear cached login data?",
            body: "This clears Discord's localStorage, sessionStorage and cookies for this client. " +
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
            "(a PREDEFINED_SERVERS id or a customServers id). When set, switching to " +
            "that account via Discord's own account switcher also switches the backend, followed by a reload.",
        default: {} as Record<string, string>
    },
    accountAvatars: {
        type: OptionType.CUSTOM,
        description: "Full avatar URL and backend id of each account, saved whenever it connects, so accounts " +
            "from other backends still show their avatar in the account switcher.",
        default: {} as Record<string, { url: string; backend: string; }>
    },
    gifProvider: {
        type: OptionType.CUSTOM,
        description: "GIF provider picked in the GIF picker for each backend that offers more than one. " +
            "Keys are backend ids, values are provider ids like klipy or giphy.",
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
    guildTerminology: {
        type: OptionType.BOOLEAN,
        description: "Call servers guilds throughout Discord's interface, the way Spacebar (and Fosscord before it) does.",
        default: true,
        restartNeeded: true
    },
    ignoreEmailVerification: {
        type: OptionType.BOOLEAN,
        description: "Treat your account as email and phone verified, so guilds that require verification let you chat and the verify email banner goes away. Useful on instances that can't send verification emails or texts.",
        default: true,
        restartNeeded: true
    },
    announceOnlineOnConnect: {
        type: OptionType.BOOLEAN,
        description: "Let friends and guild members see you come online. Spacebar only announces you when you connect as offline, so this connects as offline and the server switches you to online. Idle and Do Not Disturb show as online to others until they reload, and invisible stays invisible.",
        default: true
    },
    disrespectPermissions: {
        type: OptionType.BOOLEAN,
        description: "Ignore permissions that Spacebar servers don't enforce. For now this lets you send and forward stickers from other guilds without the Use External Stickers permission.",
        default: true,
        restartNeeded: true
    },
    boostCount: {
        type: OptionType.NUMBER,
        description: "How many boosts every guild shows. The boost level follows from it the same way it does on Discord (2, 7 and 14 boosts), and 14 or more unlocks all boost perks.",
        default: 67,
        restartNeeded: true,
        isValid: (value: number) => /^\d+$/.test(String(value)) || "Enter a whole number of 0 or more."
    },
    legacyGuildOrderSync: {
        type: OptionType.BOOLEAN,
        description: "Reposition guilds to match the order saved on the deprecated /users/@me/settings endpoint " +
            "instead of relying on Discord's native settings-proto sync. Only needed for backends that don't " +
            "keep settings-proto in sync with legacy settings, like Fermo/Fermi. This fallback path won't be " +
            "actively maintained going forward, enable at your own risk.",
        default: false,
        restartNeeded: true
    },
    clearCache: {
        type: OptionType.COMPONENT,
        component: ClearCacheButton
    }
});
