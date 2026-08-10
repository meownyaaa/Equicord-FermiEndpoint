/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { localStorage } from "@utils/localStorage";
import { Logger } from "@utils/Logger";
import { OptionType } from "@utils/types";
import { Alerts, Button, Toasts } from "@webpack/common";

const logger = new Logger("ChangeEndpoint");

// equicord keeps its own config in localStorage ("EquicordSettings" on web
// builds) and its DataStore in the "VencordData" IndexedDB database - a
// blanket clear() would take that with it too, including the backend
// picked below, so skip anything that belongs to the mod itself.
const isOurs = (name: string) => name.startsWith("Vencord") || name.startsWith("Equicord");

// bare localStorage/sessionStorage aren't reliably resolvable here - go
// through @utils/localStorage (= window.localStorage) and window.sessionStorage
function clearCachedLoginData() {
    try {
        for (const key of Object.keys(localStorage)) {
            if (!isOurs(key)) localStorage.removeItem(key);
        }
        window.sessionStorage?.clear();

        // IndexedDB holds Discord's cached user/token/session state (including
        // the login token), which is why switching backends without this
        // auto-logs-in with the previous instance's token and freezes at splash
        window.indexedDB?.databases?.()
            .then(dbs => dbs.forEach(db => db.name && !isOurs(db.name) && indexedDB.deleteDatabase(db.name)))
            .catch(e => logger.error("Failed to enumerate IndexedDB databases", e));

        // belt-and-suspenders: also clear any non-HttpOnly cookies on this domain
        for (const cookie of document.cookie.split(";")) {
            const name = cookie.split("=")[0]?.trim();
            if (name) document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
        }

        Toasts.show({
            id: Toasts.genId(),
            message: "Cleared cached login data. Fully quit Discord (tray icon, not just the window) and relaunch it now.",
            type: Toasts.Type.SUCCESS
        });
    } catch (e) {
        logger.error("Failed to clear cached data", e);
        Toasts.show({
            id: Toasts.genId(),
            message: "Failed to clear cached data, check the console.",
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
                "You'll need to fully quit Discord (tray icon, not just close the window) and relaunch it " +
                "afterward. Do this after switching backends if the client freezes at the Discord logo. Continue?",
            confirmText: "Clear data",
            cancelText: "Cancel",
            confirmColor: Button.Colors.RED,
            onConfirm: clearCachedLoginData
        })}
    >
        Clear Cached Login Data
    </Button>
);

const isSimple = () => settings.store.backend === "custom-simple";
const isAdvanced = () => settings.store.backend === "custom-advanced";

const required = (value: string) => value.trim() ? true : "Required. Leaving this blank makes the client keep whatever the page's own GLOBAL_ENV says for it.";

export const settings = definePluginSettings({
    backend: {
        type: OptionType.SELECT,
        description: "Backend to connect to",
        restartNeeded: true,
        options: [
            { label: "Harmony (harmony.melodychat.org)", value: "harmony", default: true },
            { label: "Custom (Simplified)", value: "custom-simple" },
            { label: "Custom (Advanced)", value: "custom-advanced" }
        ]
    },
    customBackendHost: {
        type: OptionType.STRING,
        description: "Only used with Custom (Simplified). Just the bare host, no scheme, no trailing slash " +
            "(e.g. \"rory.server.spacebar.chat\"). To find this: open DevTools (Ctrl+Shift+I) on the instance's " +
            "web client, go to the Network tab, log in or reload, and look for a request whose domain starts " +
            "with \"api.\" - e.g. a request to \"api.rory.server.spacebar.chat/api/v9/...\". Everything after " +
            "\"api.\" and before the next \"/\" is the host to put here. This assumes the instance follows the " +
            "standard api.<host> / cdn.<host> / gateway.<host> convention - if it doesn't, or this doesn't work, " +
            "use Custom (Advanced) instead and enter each endpoint separately. Spacebar instances publish their " +
            "real endpoints at https://<host>/api/policies/instance/domains, which is the authoritative answer " +
            "if the convention above doesn't hold.",
        default: "",
        restartNeeded: true,
        hidden: () => !isSimple(),
        isValid: required
    },
    customApiEndpoint: {
        type: OptionType.STRING,
        description: "Custom API endpoint - only used with Custom (Advanced). " +
            "Include the scheme if your instance needs one (e.g. \"//api.myinstance.example.com/api\" or " +
            "\"https://myinstance.example.com/api\"). This replaces window.GLOBAL_ENV.API_ENDPOINT verbatim, " +
            "so match your instance's exact format - some Spacebar instances don't use the api.<host>/api convention. " +
            "This is the \"apiEndpoint\" field of https://<host>/api/policies/instance/domains.",
        default: "",
        restartNeeded: true,
        hidden: () => !isAdvanced(),
        isValid: required
    },
    customCdnHost: {
        type: OptionType.STRING,
        description: "Custom CDN host - only used with Custom (Advanced). " +
            "Just the host, no scheme (e.g. \"cdn.myinstance.example.com\"). Replaces window.GLOBAL_ENV.CDN_HOST verbatim. " +
            "This is the \"cdn\" field of https://<host>/api/policies/instance/domains.",
        default: "",
        restartNeeded: true,
        hidden: () => !isAdvanced(),
        isValid: required
    },
    customGatewayEndpoint: {
        type: OptionType.STRING,
        description: "Custom gateway endpoint - only used with Custom (Advanced). " +
            "Include the wss:// scheme (e.g. \"wss://gateway.myinstance.example.com\"). " +
            "Replaces window.GLOBAL_ENV.GATEWAY_ENDPOINT verbatim. " +
            "This is the \"gateway\" field of https://<host>/api/policies/instance/domains.",
        default: "",
        restartNeeded: true,
        hidden: () => !isAdvanced(),
        isValid: required
    },
    customMediaProxyEndpoint: {
        type: OptionType.STRING,
        description: "Custom media proxy endpoint - only used with Custom (Advanced). " +
            "Some instances point this at the same host as the CDN (e.g. \"//cdn.myinstance.example.com\"), " +
            "others use a separate media proxy host - check your instance's own GLOBAL_ENV if unsure. " +
            "Replaces window.GLOBAL_ENV.MEDIA_PROXY_ENDPOINT verbatim.",
        default: "",
        restartNeeded: true,
        hidden: () => !isAdvanced(),
        isValid: required
    },
    useNativeVideoPlayer: {
        type: OptionType.BOOLEAN,
        description: "Use Discord's real video player for attachments instead of a plain HTML5 video element. " +
            "The plain element is the default because Discord's player has had trouble loading video from some " +
            "Spacebar CDNs, but it also drops Discord's own spoiler blur and other player chrome. Turn this on " +
            "to get those back if your instance's video URLs work fine with the real player.",
        default: false,
        restartNeeded: true
    },
    clearCache: {
        type: OptionType.COMPONENT,
        component: ClearCacheButton
    }
});
