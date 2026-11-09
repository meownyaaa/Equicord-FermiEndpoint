/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findByPropsLazy } from "@webpack";
import { UserStore } from "@webpack/common";

import { CustomServer, EndpointField, PREDEFINED_SERVERS } from "./servers";
import { settings } from "./settings";

function customServer(backend: string): CustomServer | undefined {
    return settings.store.customServers.find(s => s.id === backend);
}

export function simplifyHost(host: string): string {
    return host
        .trim()
        .replace(/^\w+:\/\//, "")
        .replace(/\/.*$/, "");
}

// fix some bullshit where itll go https://https//*server url* lol
const HOST_ONLY_ADVANCED_FIELDS = new Set<EndpointField>(["cdnHost", "mediaProxyEndpoint"]);

function resolveEndpoint(field: EndpointField, build: (host: string, secure: boolean) => string, backend = settings.store.backend): string | null {
    const predefined = PREDEFINED_SERVERS.find(s => s.id === backend);
    const custom = predefined ? undefined : customServer(backend);
    const explicit = predefined ? predefined.endpoints : custom?.type === "advanced" ? custom : undefined;

    if (explicit) {
        let value = explicit[field]?.trim();
        if (value && HOST_ONLY_ADVANCED_FIELDS.has(field)) value = simplifyHost(value);
        return value || null;
    }

    const host = predefined?.host ?? custom?.host?.trim();
    return host ? build(simplifyHost(host), !/^http:\/\//i.test(host)) : null;
}

export const getApiEndpoint = (backend?: string) =>
    resolveEndpoint("apiEndpoint", host => `//api.${host}/api`, backend);

export const getCdnHost = (backend?: string) =>
    resolveEndpoint("cdnHost", host => `cdn.${host}`, backend);

export const getGatewayEndpoint = (backend?: string) =>
    resolveEndpoint("gatewayEndpoint", (host, secure) => `${secure ? "wss" : "ws"}://gateway.${host}`, backend);

export interface EndpointEnv {
    API_ENDPOINT?: string;
    CDN_HOST?: string;
    GATEWAY_ENDPOINT?: string;
    GATEWAY_ALT_ENDPOINT?: string;
    MEDIA_PROXY_ENDPOINT?: string;
}

export function writeEndpointEnv(env: EndpointEnv) {
    const api = getApiEndpoint();
    const gateway = getGatewayEndpoint();
    const cdn = getCdnHost();
    const media = getMediaProxyEndpoint();
    if (api) env.API_ENDPOINT = api.replace(/^\w+:(?=\/\/)/, "");
    if (gateway) env.GATEWAY_ENDPOINT = env.GATEWAY_ALT_ENDPOINT = gateway;
    if (cdn) env.CDN_HOST = cdn;
    if (media) env.MEDIA_PROXY_ENDPOINT = media;
}

export const hasEndpoints = (backend: string) =>
    backend === "discord" || (getApiEndpoint(backend) != null && getGatewayEndpoint(backend) != null);

export const getMediaProxyEndpoint = () => {
    const endpoint = resolveEndpoint("mediaProxyEndpoint", host => `cdn.${host}`) ?? getCdnHost();
    return endpoint && `//${endpoint}`;
};

export let connectedBackend: string | null = null;

export function captureConnectedBackend(backend = settings.store.backend) {
    connectedBackend = backend;
}

export const TokenStorage: { getToken(userId?: string): string | null | undefined; setToken(token: string, userId: string): void; removeToken(userId?: string): boolean; } = findByPropsLazy("getToken", "setToken", "removeToken");

export function linkCurrentAccount() {
    const user = UserStore.getCurrentUser();
    if (user && connectedBackend && settings.store.accountBackends[user.id] !== connectedBackend)
        settings.store.accountBackends = { ...settings.plain.accountBackends, [user.id]: connectedBackend };
}

export function prepareTokenForBackend(backend: string) {
    const user = UserStore.getCurrentUser();
    const linked = user && settings.store.accountBackends[user.id];
    if (!user || !linked) return;

    const token = TokenStorage.getToken(user.id);
    if (linked !== backend) TokenStorage.removeToken();
    else if (token) TokenStorage.setToken(token, user.id);
}
