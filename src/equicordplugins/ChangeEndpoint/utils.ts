/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { CustomServer, PREDEFINED_SERVERS } from "./servers";
import { settings } from "./settings";

function activeCustomServer(): CustomServer | undefined {
    return settings.store.customServers.find(s => s.id === settings.store.backend);
}

function predefinedHost(): string | null {
    return PREDEFINED_SERVERS.find(s => s.id === settings.store.backend)?.host ?? null;
}

export function simplifyHost(host: string): string {
    return host
        .trim()
        .replace(/^\w+:\/\//, "")
        .replace(/\/.*$/, "");
}

function resolveEndpoint(advancedField: keyof CustomServer, build: (host: string) => string): string | null {
    const predefined = predefinedHost();
    if (predefined) return build(predefined);

    const custom = activeCustomServer();
    if (!custom) return null;

    if (custom.type === "advanced") {
        const value = (custom[advancedField] as string | undefined)?.trim();
        return value || null;
    }

    return custom.host?.trim() ? build(simplifyHost(custom.host)) : null;
}

export const getApiEndpoint = () =>
    resolveEndpoint("apiEndpoint", host => `//api.${host}/api`);

export const getCdnHost = () =>
    resolveEndpoint("cdnHost", host => `cdn.${host}`);

export const getGatewayEndpoint = () =>
    resolveEndpoint("gatewayEndpoint", host => `wss://gateway.${host}`);

export const getMediaProxyEndpoint = () =>
    resolveEndpoint("mediaProxyEndpoint", host => `//cdn.${host}`);
