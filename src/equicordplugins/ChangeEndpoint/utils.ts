/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { settings } from "./settings";

const HARMONY_API_ENDPOINT = "//api.harmony.melodychat.org/api";
const HARMONY_CDN_HOST = "cdn.harmony.melodychat.org";
const HARMONY_GATEWAY_ENDPOINT = "wss://gateway.harmony.melodychat.org";
const HARMONY_MEDIA_PROXY_ENDPOINT = "//cdn.harmony.melodychat.org";

const isSimple = () => settings.store.backend === "custom-simple";
const isAdvanced = () => settings.store.backend === "custom-advanced";

export function getSimpleHost(): string {
    return settings.store.customBackendHost
        .trim()
        .replace(/^\w+:\/\//, "")
        .replace(/\/.*$/, "");
}

// shared shape behind all four endpoint getters below - returning null means
// "leave window.GLOBAL_ENV alone", so a custom backend never silently
// inherits harmony's cdn/gateway just because one field was left blank,
// which would otherwise talk to two different instances at once.
function resolveEndpoint(advancedValue: string, simpleValue: () => string, harmonyValue: string): string | null {
    if (isAdvanced()) return advancedValue.trim() || null;
    if (isSimple()) return settings.store.customBackendHost.trim() ? simpleValue() : null;
    return harmonyValue;
}

export const getApiEndpoint = () =>
    resolveEndpoint(settings.store.customApiEndpoint, () => `//api.${getSimpleHost()}/api`, HARMONY_API_ENDPOINT);

export const getCdnHost = () =>
    resolveEndpoint(settings.store.customCdnHost, () => `cdn.${getSimpleHost()}`, HARMONY_CDN_HOST);

export const getGatewayEndpoint = () =>
    resolveEndpoint(settings.store.customGatewayEndpoint, () => `wss://gateway.${getSimpleHost()}`, HARMONY_GATEWAY_ENDPOINT);

export const getMediaProxyEndpoint = () =>
    resolveEndpoint(settings.store.customMediaProxyEndpoint, () => `//cdn.${getSimpleHost()}`, HARMONY_MEDIA_PROXY_ENDPOINT);
