/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { type EndpointEnv, getGatewayEndpoint, writeEndpointEnv } from "@equicordplugins/ChangeEndpoint/utils";
import definePlugin, { StartAt } from "@utils/types";

interface FastConnectSocket {
    ws: WebSocket;
    state: { gateway: string; };
}

function replaceWithValue(key: string, value: unknown) {
    Object.defineProperty(window, key, { value, writable: true, configurable: true, enumerable: true });
}

export default definePlugin({
    name: "EndpointHelper",
    description: "Writes the ChangeEndpoint backend into Discord's environment before the client starts, so its early gateway connection and every endpoint lookup go to the right server.",
    authors: [],
    required: true,
    startAt: StartAt.Init,

    start() {
        const gateway = getGatewayEndpoint();
        if (!gateway) return;

        if (window.GLOBAL_ENV) {
            writeEndpointEnv(window.GLOBAL_ENV);
            return;
        }

        Object.defineProperty(window, "GLOBAL_ENV", {
            configurable: true,
            set(env: EndpointEnv) {
                writeEndpointEnv(env);
                replaceWithValue("GLOBAL_ENV", env);
            }
        });

        const NativeWebSocket = window.WebSocket;
        const FastConnectWebSocket = new Proxy(NativeWebSocket, {
            construct(target, [url, ...rest]) {
                const plainUrl = typeof url === "string" && url.startsWith(`${gateway}/?`) ? url.replace(/&compress=[^&]*/, "") : url;
                return Reflect.construct(target, [plainUrl, ...rest]);
            }
        });
        const restoreWebSocket = () => {
            if (window.WebSocket === FastConnectWebSocket) window.WebSocket = NativeWebSocket;
        };

        window.WebSocket = FastConnectWebSocket;
        document.addEventListener("DOMContentLoaded", restoreWebSocket, { once: true });

        Object.defineProperty(window, "_ws", {
            configurable: true,
            set(fast: FastConnectSocket | null) {
                restoreWebSocket();
                if (fast) fast.state.gateway = fast.ws.url;
                replaceWithValue("_ws", fast);
            }
        });
    }
});
