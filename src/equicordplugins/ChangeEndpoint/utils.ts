/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { CustomServer, EndpointField, PREDEFINED_SERVERS } from "./servers";
import { settings } from "./settings";

function activeCustomServer(): CustomServer | undefined {
    return settings.store.customServers.find(s => s.id === settings.store.backend);
}

export function simplifyHost(host: string): string {
    return host
        .trim()
        .replace(/^\w+:\/\//, "")
        .replace(/\/.*$/, "");
}

// fix some bullshit where itll go https://https//*server url* lol
const HOST_ONLY_ADVANCED_FIELDS = new Set<EndpointField>(["cdnHost", "mediaProxyEndpoint"]);

function resolveEndpoint(field: EndpointField, build: (host: string) => string): string | null {
    const predefined = PREDEFINED_SERVERS.find(s => s.id === settings.store.backend);
    const custom = predefined ? undefined : activeCustomServer();
    const explicit = predefined ? predefined.endpoints : custom?.type === "advanced" ? custom : undefined;

    if (explicit) {
        let value = explicit[field]?.trim();
        if (value && HOST_ONLY_ADVANCED_FIELDS.has(field)) value = simplifyHost(value);
        return value || null;
    }

    const host = predefined?.host ?? custom?.host?.trim();
    return host ? build(simplifyHost(host)) : null;
}

export const getApiEndpoint = () =>
    resolveEndpoint("apiEndpoint", host => `//api.${host}/api`);

export const getCdnHost = () =>
    resolveEndpoint("cdnHost", host => `cdn.${host}`);

export const getGatewayEndpoint = () =>
    resolveEndpoint("gatewayEndpoint", host => `wss://gateway.${host}`);

export const getMediaProxyEndpoint = () => {
    const endpoint = resolveEndpoint("mediaProxyEndpoint", host => `cdn.${host}`) ?? getCdnHost();
    return endpoint && `//${endpoint}`;
};

export let connectedBackend: string | null = null;

export function captureConnectedBackend() {
    connectedBackend = settings.store.backend;
}
