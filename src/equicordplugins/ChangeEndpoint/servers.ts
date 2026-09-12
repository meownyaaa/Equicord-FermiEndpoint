/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface PredefinedServer {
    id: string;
    name: string;
    host: string;
}

export interface CustomServer {
    id: string;
    name: string;
    type: "simple" | "advanced";
    host?: string;
    apiEndpoint?: string;
    cdnHost?: string;
    gatewayEndpoint?: string;
    mediaProxyEndpoint?: string;
}

export const PREDEFINED_SERVERS: PredefinedServer[] = [
    { id: "spacebar", name: "Spacebar", host: "rory.server.spacebar.chat" },
    { id: "harmony", name: "Harmony", host: "harmony.melodychat.org" }
];
