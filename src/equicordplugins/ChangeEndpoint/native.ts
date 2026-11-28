/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ResponseHeaderPatchers } from "@main/csp";
import { app, desktopCapturer, IpcMainInvokeEvent, session } from "electron";
import { AddressInfo, connect, createServer } from "net";

// spacebar voice servers listen on udp 6000, which chromium treats as an unsafe (x11) port and
// silently refuses to send webrtc traffic to. this runs before app ready, so the switch still applies
const allowedPorts = new Set(app.commandLine.getSwitchValue("explicitly-allowed-ports").split(",").filter(Boolean));
allowedPorts.add("6000");
app.commandLine.appendSwitch("explicitly-allowed-ports", [...allowedPorts].join(","));

const CLOUD_UPLOAD_RE = /^https:\/\/[^/]+\/attachments\/\d+\/CLOUD_[^/]+\/\d+\/[^/?]+$/;

ResponseHeaderPatchers.push(({ url }, headers) => {
    if (!CLOUD_UPLOAD_RE.test(url) || Object.keys(headers).some(h => h.toLowerCase() === "access-control-allow-origin")) return;
    headers["Access-Control-Allow-Origin"] = ["*"];
    headers["Access-Control-Allow-Methods"] = ["GET, PUT, POST, PATCH, DELETE, OPTIONS"];
    headers["Access-Control-Allow-Headers"] = ["*"];
});

let handlerRegistered = false;
let pendingSourceName: string | null = null;
let pendingSourceId: string | null = null;
let pendingSystemAudio = false;

export function setPendingScreenShareSource(_event: IpcMainInvokeEvent, name: unknown, id: unknown, systemAudio: unknown) {
    pendingSourceName = typeof name === "string" && name.length > 0 && name.length < 256 ? name : null;
    pendingSourceId = typeof id === "string" && /^(window|screen):\d+:\d+$/.test(id) ? id : null;
    pendingSystemAudio = systemAudio === true;
}

export function registerDisplayMediaHandler(_event: IpcMainInvokeEvent) {
    if (handlerRegistered) return;
    handlerRegistered = true;

    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
        desktopCapturer.getSources({ types: ["window", "screen"] })
            .then(sources => {
                const video = sources.find(s => s.id === pendingSourceId) ?? sources.find(s => s.name === pendingSourceName) ?? sources[0];
                if (!video) return callback({});
                callback(request.audioRequested && pendingSystemAudio ? { video, audio: "loopback" } : { video });
            })
            .catch(() => callback({}));
    });
}

export function unregisterDisplayMediaHandler(_event: IpcMainInvokeEvent) {
    if (!handlerRegistered) return;
    handlerRegistered = false;
    session.defaultSession.setDisplayMediaRequestHandler(null);
}

const PRIVATE_IPV4 = /^(10\.\d+|192\.168|172\.(1[6-9]|2\d|3[01])|127\.\d+|169\.254)\.\d+\.\d+$/;
const voiceProxies = new Map<string, Promise<number>>();

export function startVoiceProxy(_event: IpcMainInvokeEvent, host: unknown, port: unknown): Promise<number | null> {
    if (typeof host !== "string" || !PRIVATE_IPV4.test(host) || typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)
        return Promise.resolve(null);
    const key = `${host}:${port}`;
    let proxy = voiceProxies.get(key);
    if (!proxy) {
        proxy = new Promise<number>((resolve, reject) => {
            const server = createServer(client => {
                const upstream = connect(port, host);
                client.pipe(upstream).pipe(client);
                client.on("error", () => upstream.destroy());
                upstream.on("error", () => client.destroy());
            });
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
        });
        voiceProxies.set(key, proxy);
        proxy.catch(() => voiceProxies.delete(key));
    }
    return proxy.catch(() => null);
}
