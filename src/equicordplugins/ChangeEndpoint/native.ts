/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { desktopCapturer, IpcMainInvokeEvent, session } from "electron";

let handlerRegistered = false;
let pendingSourceName: string | null = null;

export function setPendingScreenShareSource(_event: IpcMainInvokeEvent, name: unknown) {
    pendingSourceName = typeof name === "string" && name.length > 0 && name.length < 256 ? name : null;
}

export function registerDisplayMediaHandler(_event: IpcMainInvokeEvent) {
    if (handlerRegistered) return;
    handlerRegistered = true;

    session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
        desktopCapturer.getSources({ types: ["window", "screen"] }).then(sources => {
            const match = pendingSourceName != null ? sources.find(s => s.name === pendingSourceName) : undefined;
            callback({ video: match ?? sources[0] });
        });
    });
}
