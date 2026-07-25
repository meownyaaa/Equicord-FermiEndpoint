import { settings } from "./settings";

const HARMONY_API_ENDPOINT = "//api.harmony.melodychat.org/api";
const HARMONY_CDN_HOST = "cdn.harmony.melodychat.org";
const HARMONY_GATEWAY_ENDPOINT = "wss://gateway.harmony.melodychat.org";
const HARMONY_MEDIA_PROXY_ENDPOINT = "//cdn.harmony.melodychat.org";

const isSimple = () => settings.store.backend === "custom-simple";
const isAdvanced = () => settings.store.backend === "custom-advanced";

function getSimpleHost(): string {
    return settings.store.customBackendHost
        .trim()
        .replace(/^https?:\/\//, "")
        .replace(/\/+$/, "");
}

// shared shape behind all four endpoint getters below: advanced override,
// then simple-host derivation, then the harmony default
function resolveEndpoint(advancedValue: string, simpleValue: () => string, fallback: string): string {
    if (isAdvanced() && advancedValue) return advancedValue.trim();
    if (isSimple() && settings.store.customBackendHost) return simpleValue();
    return fallback;
}

export const getApiEndpoint = () =>
    resolveEndpoint(settings.store.customApiEndpoint, () => `//api.${getSimpleHost()}/api`, HARMONY_API_ENDPOINT);

export const getCdnHost = () =>
    resolveEndpoint(settings.store.customCdnHost, () => `cdn.${getSimpleHost()}`, HARMONY_CDN_HOST);

export const getGatewayEndpoint = () =>
    resolveEndpoint(settings.store.customGatewayEndpoint, () => `wss://gateway.${getSimpleHost()}`, HARMONY_GATEWAY_ENDPOINT);

export const getMediaProxyEndpoint = () =>
    resolveEndpoint(settings.store.customMediaProxyEndpoint, () => `//cdn.${getSimpleHost()}`, HARMONY_MEDIA_PROXY_ENDPOINT);
