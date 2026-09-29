/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app, desktopCapturer, IpcMainInvokeEvent, session } from "electron";

// spacebar voice servers listen on udp 6000, which chromium treats as an unsafe (x11) port and
// silently refuses to send webrtc traffic to. this runs before app ready, so the switch still applies
const allowedPorts = new Set(app.commandLine.getSwitchValue("explicitly-allowed-ports").split(",").filter(Boolean));
allowedPorts.add("6000");
app.commandLine.appendSwitch("explicitly-allowed-ports", [...allowedPorts].join(","));

let handlerRegistered = false;
let pendingSourceName: string | null = null;

export function setPendingScreenShareSource(_event: IpcMainInvokeEvent, name: unknown) {
    pendingSourceName = typeof name === "string" && name.length > 0 && name.length < 256 ? name : null;
}

export function registerDisplayMediaHandler(_event: IpcMainInvokeEvent) {
    if (handlerRegistered) return;
    handlerRegistered = true;

    session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
        desktopCapturer.getSources({ types: ["window", "screen"] })
            .then(sources => {
                const video = sources.find(s => s.name === pendingSourceName) ?? sources[0];
                callback(video ? { video } : {});
            })
            .catch(() => callback({}));
    });
}

export function unregisterDisplayMediaHandler(_event: IpcMainInvokeEvent) {
    if (!handlerRegistered) return;
    handlerRegistered = false;
    session.defaultSession.setDisplayMediaRequestHandler(null);
}
