/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { simplifyHost } from "./utils";

export interface Discovered {
    name?: string;
    api: string;
    cdn: string;
    gateway: string;
}

// lowercase origin (some servers say HTTPS://), no default port, no trailing slash or api version
const normalize = (url: unknown) =>
    typeof url !== "string" || !url.trim()
        ? null
        : url
            .trim()
            .replace(/^[a-z]+:\/\/[^/]+/i, origin => origin.toLowerCase().replace(/^(https|wss)(:\/\/[^/]+):443$/, "$1$2"))
            .replace(/\/+$/, "")
            .replace(/\/v\d+$/i, "");

const getJson = (url: string) =>
    fetch(url, { headers: { Accept: "application/json" } }).then(res => res.ok ? res.json() : null, () => null);

// spacebar servers publish their endpoints, but the fields differ between versions, so every api candidate gets pinged
export async function discover(address: string): Promise<Discovered> {
    const host = simplifyHost(address);
    if (!host) throw new Error("Enter a server address.");
    const secure = !/^http:\/\//i.test(address.trim());
    const http = secure ? "https" : "http";

    const client = await getJson(`${http}://${host}/.well-known/spacebar/client`);
    const known = client ? null : await getJson(`${http}://${host}/.well-known/spacebar`);
    const seeds = [normalize(client?.api?.baseUrl), normalize(known?.api), `${http}://${host}/api`, `${http}://api.${host}/api`].filter((s): s is string => !!s);
    const apiSeeds = seeds.flatMap(seed => seed.endsWith("/api") ? [seed] : [`${seed}/api`, seed]);

    let domains: Record<string, unknown> | null = null;
    for (const seed of apiSeeds) if ((domains = await getJson(`${seed}/policies/instance/domains`))) break;

    const endpoint = normalize(domains?.apiEndpoint);
    const candidates = [...new Set([normalize(domains?.api), endpoint, endpoint && `${endpoint}/api`, ...apiSeeds].filter((c): c is string => !!c))];

    for (const api of candidates) {
        const ping = await getJson(`${api}/v9/ping`);
        if (ping?.ping !== "pong!") continue;
        const name = typeof ping.instance?.name === "string" ? ping.instance.name.trim() : "";
        return {
            name: name || undefined,
            api,
            cdn: normalize(client?.cdn?.baseUrl) ?? normalize(domains?.cdn) ?? `${http}://cdn.${host}`,
            gateway: normalize(client?.gateway?.baseUrl) ?? normalize(domains?.gateway) ?? `${secure ? "wss" : "ws"}://gateway.${host}`
        };
    }
    throw new Error(`Couldn't find a Spacebar server at ${host}.`);
}
