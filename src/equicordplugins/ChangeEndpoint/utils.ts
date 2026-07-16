import { settings } from "./settings";

const HARMONY_API_ENDPOINT = "//api.harmony.melodychat.org/api";
const HARMONY_CDN_HOST = "cdn.harmony.melodychat.org";
const HARMONY_GATEWAY_ENDPOINT = "wss://gateway.harmony.melodychat.org";
const HARMONY_MEDIA_PROXY_ENDPOINT = "//cdn.harmony.melodychat.org";

function isSimple(): boolean {
    return settings.store.backend === "custom-simple";
}
function isAdvanced(): boolean {
    return settings.store.backend === "custom-advanced";
}

function getSimpleHost(): string {
    return settings.store.customBackendHost
        .trim()
        .replace(/^https?:\/\//, "")
        .replace(/\/+$/, "");
}

export function getApiEndpoint(): string {
    if (isAdvanced() && settings.store.customApiEndpoint) return settings.store.customApiEndpoint.trim();
    if (isSimple() && settings.store.customBackendHost) return `//api.${getSimpleHost()}/api`;
    return HARMONY_API_ENDPOINT;
}

export function getCdnHost(): string {
    if (isAdvanced() && settings.store.customCdnHost) return settings.store.customCdnHost.trim();
    if (isSimple() && settings.store.customBackendHost) return `cdn.${getSimpleHost()}`;
    return HARMONY_CDN_HOST;
}

export function getGatewayEndpoint(): string {
    if (isAdvanced() && settings.store.customGatewayEndpoint) return settings.store.customGatewayEndpoint.trim();
    if (isSimple() && settings.store.customBackendHost) return `wss://gateway.${getSimpleHost()}`;
    return HARMONY_GATEWAY_ENDPOINT;
}

export function getMediaProxyEndpoint(): string {
    if (isAdvanced() && settings.store.customMediaProxyEndpoint) return settings.store.customMediaProxyEndpoint.trim();
    if (isSimple() && settings.store.customBackendHost) return `//cdn.${getSimpleHost()}`;
    return HARMONY_MEDIA_PROXY_ENDPOINT;
}
