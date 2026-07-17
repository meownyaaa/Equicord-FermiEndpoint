import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";
import { localStorage } from "@utils/localStorage";
import { Alerts, Button, Toasts } from "@webpack/common";

function clearCachedLoginData() {
    try {
        localStorage.clear();
        window.sessionStorage?.clear();

        if (window.indexedDB?.databases) {
            window.indexedDB.databases().then(dbs => {
                for (const db of dbs) {
                    if (db.name) indexedDB.deleteDatabase(db.name);
                }
            }).catch(e => console.error("[ChangeEndpoint] Failed to enumerate IndexedDB databases", e));
        }

        for (const cookie of document.cookie.split(";")) {
            const name = cookie.split("=")[0]?.trim();
            if (name) document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
        }

        Toasts.show({
            id: Toasts.genId(),
            message: "Cleared cached login data. Go back to the plugins screen, scroll up and press Restart.",
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
                        "You'll need to restart Discord via Equicord's restart button at the top of this " +
                        "plugins page. Continue?",
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
        description: "You need reading comprehension to do this. " + 
            "Only used with Custom (Simplified). Just the bare host, no scheme, no trailing slash " +
            "(e.g. \"rory.server.spacebar.chat\"). To find this: open DevTools (Ctrl+Shift+I) on the instance's " +
            "web client, go to the Network tab, log in or reload, and look for a request whose domain starts " +
            "with \"api.\" - e.g. a request to \"api.rory.server.spacebar.chat/api/v9/...\". Everything after " +
            "\"api.\" and before the next \"/\" is the host to put here. This assumes the instance follows the " +
            "standard api.<host> / cdn.<host> / gateway.<host> convention - if it doesn't, or this doesn't work, " +
            "use Custom (Advanced) instead and enter each endpoint separately.",
        default: "rory.server.spacebar.chat",
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
