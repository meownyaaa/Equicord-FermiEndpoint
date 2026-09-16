/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { desktopCapturer, IpcMainInvokeEvent, session } from "electron";

let handlerRegistered = false;
// name of whatever discord's own native picker last had the user select - there's
// no way to hand a specific source into getDisplayMedia() otherwise, so the renderer
// tells us this right before triggering it and we match by name against electron's
// own source list. falls back to the first source if nothing was set or matches.
let pendingSourceName: string | null = null;

export function setPendingScreenShareSource(_event: IpcMainInvokeEvent, name: unknown) {
    pendingSourceName = typeof name === "string" && name.length > 0 && name.length < 256 ? name : null;
}

// the web MediaEngine's screen share goes through a real getDisplayMedia() call,
// which needs a main-process handler to resolve at all under electron - without
// this it just never produces a stream, even though discord's own native picker
// (a separate, unrelated system) still shows sources fine
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
