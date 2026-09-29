/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { getGatewayEndpoint } from "@equicordplugins/ChangeEndpoint/utils";
import definePlugin, { StartAt } from "@utils/types";

interface GatewayEnv {
    GATEWAY_ENDPOINT: string;
    GATEWAY_ALT_ENDPOINT?: string;
}

interface FastConnectSocket {
    ws: WebSocket;
    state: { gateway: string; };
}

function replaceWithValue(key: string, value: unknown) {
    Object.defineProperty(window, key, { value, writable: true, configurable: true, enumerable: true });
}

export default definePlugin({
    name: "EndpointHelper",
    description: "Points Discord's early gateway connection at the ChangeEndpoint backend, so the client reuses it instead of opening one to Discord and throwing it away.",
    authors: [],
    required: true,
    startAt: StartAt.Init,

    start() {
        const gateway = getGatewayEndpoint();
        if (!gateway) return;

        const redirect = (env: GatewayEnv) => {
            env.GATEWAY_ENDPOINT = gateway;
            env.GATEWAY_ALT_ENDPOINT = gateway;
        };

        if (window.GLOBAL_ENV) {
            redirect(window.GLOBAL_ENV);
            return;
        }

        Object.defineProperty(window, "GLOBAL_ENV", {
            configurable: true,
            set(env: GatewayEnv) {
                redirect(env);
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
