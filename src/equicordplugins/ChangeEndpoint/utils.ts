/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PREDEFINED_SERVERS } from "./servers";
import { settings } from "./settings";

const isSimple = () => settings.store.backend === "custom-simple";
const isAdvanced = () => settings.store.backend === "custom-advanced";

export function getSimpleHost(): string {
    return settings.store.customBackendHost
        .trim()
        .replace(/^\w+:\/\//, "")
        .replace(/\/.*$/, "");
}

function predefinedHost(): string | null {
    return PREDEFINED_SERVERS.find(s => s.id === settings.store.backend)?.host ?? null;
}

function resolveEndpoint(advancedValue: string, build: (host: string) => string): string | null {
    if (isAdvanced()) return advancedValue.trim() || null;
    if (isSimple()) return settings.store.customBackendHost.trim() ? build(getSimpleHost()) : null;

    const host = predefinedHost();
    return host ? build(host) : null;
}

export const getApiEndpoint = () =>
    resolveEndpoint(settings.store.customApiEndpoint, host => `//api.${host}/api`);

export const getCdnHost = () =>
    resolveEndpoint(settings.store.customCdnHost, host => `cdn.${host}`);

export const getGatewayEndpoint = () =>
    resolveEndpoint(settings.store.customGatewayEndpoint, host => `wss://gateway.${host}`);

export const getMediaProxyEndpoint = () =>
    resolveEndpoint(settings.store.customMediaProxyEndpoint, host => `//cdn.${host}`);
