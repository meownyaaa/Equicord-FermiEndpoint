import definePlugin from "@utils/types";

import { settings } from "./settings";
import { getApiEndpoint, getCdnHost, getGatewayEndpoint, getMediaProxyEndpoint } from "./utils";

export default definePlugin({
    name: "ChangeEndpoint",
    description: "Redirects Discord API/CDN/Gateway traffic to a Spacebar backend (Harmony by default, or a custom one)",
    authors: [],
    required: true,
    settings,

    patches: [
        {
            find: "window.GLOBAL_ENV.API_ENDPOINT",
            all: true,
            replacement: {
                match: /window\.GLOBAL_ENV\.API_ENDPOINT/g,
                replace: () => JSON.stringify(getApiEndpoint())
            }
        },
        {
            find: "window.GLOBAL_ENV.CDN_HOST",
            all: true,
            replacement: {
                match: /window\.GLOBAL_ENV\.CDN_HOST/g,
                replace: () => JSON.stringify(getCdnHost())
            }
        },
        {
            find: "window.GLOBAL_ENV.GATEWAY_ENDPOINT",
            all: true,
            replacement: {
                match: /window\.GLOBAL_ENV\.GATEWAY_ENDPOINT/g,
                replace: () => JSON.stringify(getGatewayEndpoint())
            }
        },
        {
            find: "window.GLOBAL_ENV.MEDIA_PROXY_ENDPOINT",
            all: true,
            replacement: {
                match: /window\.GLOBAL_ENV\.MEDIA_PROXY_ENDPOINT/g,
                replace: () => JSON.stringify(getMediaProxyEndpoint())
            }
        },
        {
            find: "isDiscordGatewayPlaintextSet(){return!1}",
            replacement: {
                match: /isDiscordGatewayPlaintextSet\(\)\{return!1\}/,
                replace: "isDiscordGatewayPlaintextSet(){return!0}"
            }
        },
        {
            find: "Error getting provider for API request:",
            replacement: {
                match: /function (\w+)\(\)\{try\{return \w+\.getConfig\(\{location:"gif_picker"\}\)\.provider\}catch\(\w+\)\{return \w+\.warn\("Error getting provider for API request:",\w+\),"tenor"\}\}/,
                replace: 'function $1(){return"klipy"}'
            }
        },
        {
            find: "}=window.GLOBAL_ENV",
            all: true,
            replacement: {
                match: /\{([\w:,]+)\}=window\.GLOBAL_ENV/g,
                replace: (fullMatch: string, pairsStr: string) => {
                    const overrides: Record<string, string> = {
                        API_ENDPOINT: getApiEndpoint(),
                        CDN_HOST: getCdnHost(),
                        GATEWAY_ENDPOINT: getGatewayEndpoint(),
                        MEDIA_PROXY_ENDPOINT: getMediaProxyEndpoint()
                    };
                    const keysPresent = pairsStr.split(",")
                        .map(pair => pair.split(":")[0])
                        .filter(key => overrides[key]);

                    if (keysPresent.length === 0) return fullMatch;

                    const overrideObjLiteral = "{" +
                        keysPresent.map(key => `${key}:${JSON.stringify(overrides[key])}`).join(",") +
                        "}";

                    return fullMatch.replace(
                        "window.GLOBAL_ENV",
                        `Object.assign({},window.GLOBAL_ENV,${overrideObjLiteral})`
                    );
                }
            }
        },
        {
            find: "avatar_description:",
            all: true,
            replacement: {
                match: /avatar:(\w+),avatar_description:\w+,avatar_id:/g,
                replace: "avatar:$1,avatar_id:"
            }
        },
        {
            find: "getPremiumTypeOverride(){return o.premiumTypeOverride}",
            replacement: {
                match: /getPremiumTypeOverride\(\)\{return o\.premiumTypeOverride\}/,
                replace: "getPremiumTypeOverride(){return 2}"
            }
        },
        {
            find: "features.has(a.GuildFeatures.ENHANCED_ROLE_COLORS)",
            all: true,
            replacement: {
                match: /\w+\.features\.has\(\w+\.GuildFeatures\.ENHANCED_ROLE_COLORS\)/g,
                replace: "true"
            }
        },
        {
            // Harmony's gateway RESUME opcode handler is a non-functional stub that
            // always replies Invalid Session, forcing a full re-Identify anyway.
            // Skip the resume attempt entirely and always Identify on reconnect,
            // saving a wasted round trip (HELLO -> RESUME -> INVALID_SESSION -> IDENTIFY).
            find: "_doResumeOrIdentify(){",
            replacement: {
                match: /_doResumeOrIdentify\(\)\{[^}]*?\?this\._doResume\(\):this\._doIdentify\(\)/,
                replace: "_doResumeOrIdentify(){this._doIdentify()"
            }
        },
        {
            // Real Discord clients send `preferred_regions` (array) alongside
            // `preferred_region` in VOICE_STATE_UPDATE when joining a voice channel.
            // Harmony's VoiceStateUpdateSchema doesn't recognise the plural field and
            // closes the gateway with a 4002 decode error the instant you try to join
            // voice, which then cascades into a reconnect. Just never attach it.
            find: "c.preferred_region=",
            replacement: {
                match: /\(c\.preferred_region=(\w+),c\.preferred_regions=\w+\)/,
                replace: "(c.preferred_region=$1)"
            }
        },
        {
            // Spacebar/Harmony don't probe uploaded attachments for width/height,
            // so image/video attachments always come back with width:null,height:null.
            // The media-sizing helpers below then do arithmetic on null, producing
            // NaN dimensions, so the embed renders at NaN x NaN (invisible).
            // Fall back to filling the available max box when width/height are missing.
            find: "maxWidth:i,maxHeight:r",
            all: true,
            replacement: {
                match: /\{width:t,height:n,maxWidth:i,maxHeight:r(?:,minWidth:a=0,minHeight:s=0)?\}=e[^;]*;/g,
                replace: (match: string) => `${match}null==t&&(t=i,n=r);`
            }
        }
    ]
});
