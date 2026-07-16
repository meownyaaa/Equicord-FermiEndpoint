import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";
import { localStorage } from "@utils/localStorage";
import { Alerts, Button, Toasts } from "@webpack/common";

function clearCachedLoginData() {
    try {
        // Bare `localStorage`/`sessionStorage` aren't reliably resolvable in this
        // execution context - go through @utils/localStorage (= window.localStorage)
        // and window.sessionStorage explicitly instead.
        localStorage.clear();
        window.sessionStorage?.clear();

        // Nuke every IndexedDB database we can see - Discord's client caches
        // user/token/session state here (including the login token itself,
        // which is why switching backends without doing this auto-logs-in
        // with the previous instance's token), and stale entries from a
        // previous backend are what cause the freeze-on-splash-logo issue.
        if (window.indexedDB?.databases) {
            window.indexedDB.databases().then(dbs => {
                for (const db of dbs) {
                    if (db.name) indexedDB.deleteDatabase(db.name);
                }
            }).catch(e => console.error("[ChangeEndpoint] Failed to enumerate IndexedDB databases", e));
        }

        // Belt-and-suspenders: also clear any non-HttpOnly cookies on this
        // domain, in case auth state is being persisted there too.
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
        console.error("[ChangeEndpoint] Failed to clear cached data", e);
        Toasts.show({
            id: Toasts.genId(),
            message: "Failed to clear cached data - check the console.",
            type: Toasts.Type.FAILURE
        });
    }
}

function ClearCacheButton() {
    return (
        <Button
            color={Button.Colors.RED}
            onClick={() => {
                Alerts.show({
                    title: "Clear cached login data?",
                    body: "This clears localStorage, sessionStorage, and IndexedDB for this client. " +
                        "You'll need to fully quit Discord (tray icon, not just close the window) and relaunch it " +
                        "afterward. Do this after switching backends if the client freezes at the Discord logo. Continue?",
                    confirmText: "Clear data",
                    cancelText: "Cancel",
                    confirmColor: Button.Colors.RED,
                    onConfirm: clearCachedLoginData
                });
            }}
        >
            Clear Cached Login Data
        </Button>
    );
}

function isSimple() {
    return settings.store.backend === "custom-simple";
}
function isAdvanced() {
    return settings.store.backend === "custom-advanced";
}

export const settings = definePluginSettings({
    backend: {
        type: OptionType.SELECT,
        description: "Backend to connect to",
        restartNeeded: true,
        options: [
            { label: "Harmony (fermi.chat)", value: "harmony", default: true },
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
            "use Custom (Advanced) instead and enter each endpoint separately.",
        default: "",
        restartNeeded: true,
        hidden: () => !isSimple()
    },
    customApiEndpoint: {
        type: OptionType.STRING,
        description: "Custom API endpoint - only used with Custom (Advanced). " +
            "Include the scheme if your instance needs one (e.g. \"//api.myinstance.example.com/api\" or " +
            "\"https://myinstance.example.com/api\"). This replaces window.GLOBAL_ENV.API_ENDPOINT verbatim, " +
            "so match your instance's exact format - some Spacebar instances don't use the api.<host>/api convention.",
        default: "",
        restartNeeded: true,
        hidden: () => !isAdvanced()
    },
    customCdnHost: {
        type: OptionType.STRING,
        description: "Custom CDN host - only used with Custom (Advanced). " +
            "Just the host, no scheme (e.g. \"cdn.myinstance.example.com\"). Replaces window.GLOBAL_ENV.CDN_HOST verbatim.",
        default: "",
        restartNeeded: true,
        hidden: () => !isAdvanced()
    },
    customGatewayEndpoint: {
        type: OptionType.STRING,
        description: "Custom gateway endpoint - only used with Custom (Advanced). " +
            "Include the wss:// scheme (e.g. \"wss://gateway.myinstance.example.com\"). " +
            "Replaces window.GLOBAL_ENV.GATEWAY_ENDPOINT verbatim.",
        default: "",
        restartNeeded: true,
        hidden: () => !isAdvanced()
    },
    customMediaProxyEndpoint: {
        type: OptionType.STRING,
        description: "Custom media proxy endpoint - only used with Custom (Advanced). " +
            "Some instances point this at the same host as the CDN (e.g. \"//cdn.myinstance.example.com\"), " +
            "others use a separate media proxy host - check your instance's own GLOBAL_ENV if unsure. " +
            "Replaces window.GLOBAL_ENV.MEDIA_PROXY_ENDPOINT verbatim.",
        default: "",
        restartNeeded: true,
        hidden: () => !isAdvanced()
    },
    clearCache: {
        type: OptionType.COMPONENT,
        component: ClearCacheButton
    }
});
