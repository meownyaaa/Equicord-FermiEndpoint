/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { vencordRootNode } from "@api/Styles";
import definePlugin, { StartAt } from "@utils/types";

type StyleOwner = HTMLLinkElement | HTMLStyleElement;

const SIZE_MEDIA = /\b(?:min|max)-(?:width|height|aspect-ratio)|orientation/;

const movedKeyframes = new Map<StyleOwner, string[]>();
let keyframeStyle: HTMLStyleElement | undefined;
let observer: MutationObserver | undefined;

const isStyleOwner = (node: Node): node is StyleOwner =>
    node instanceof HTMLStyleElement || (node instanceof HTMLLinkElement && node.rel === "stylesheet" && node.href.startsWith(location.origin));

function syncKeyframeStyle() {
    if (keyframeStyle) keyframeStyle.textContent = [...movedKeyframes.values()].flat().join("\n");
}

function forget(owner: StyleOwner) {
    if (movedKeyframes.delete(owner)) syncKeyframeStyle();
}

function moveKeyframes(owner: StyleOwner) {
    const { sheet } = owner;
    if (!sheet || !keyframeStyle) return;

    const rules = [...sheet.cssRules];
    const keyframes = rules.filter(r => r instanceof CSSKeyframesRule);
    if (!keyframes.length || !rules.some(r => r instanceof CSSMediaRule && SIZE_MEDIA.test(r.conditionText))) return forget(owner);

    movedKeyframes.set(owner, keyframes.map(r => r.cssText));
    for (const rule of keyframes.reverse()) sheet.deleteRule(rules.indexOf(rule));
    syncKeyframeStyle();
}

function handleNode(node: Node) {
    if (!isStyleOwner(node)) return;

    if (node instanceof HTMLLinkElement && !node.sheet) node.addEventListener("load", () => moveKeyframes(node), { once: true });
    else moveKeyframes(node);
}

export default definePlugin({
    name: "SmoothResize",
    description: "Makes resizing the window smoother by stopping Discord from restyling the whole app every time it crosses a layout breakpoint.",
    authors: [],
    enabledByDefault: true,

    startAt: StartAt.DOMContentLoaded,

    start() {
        keyframeStyle = document.createElement("style");
        document.head.prepend(keyframeStyle);
        document.head.querySelectorAll("link").forEach(handleNode);
        vencordRootNode.querySelectorAll("style").forEach(handleNode);

        observer = new MutationObserver(mutations => {
            for (const { target, addedNodes, removedNodes } of mutations) {
                if (target instanceof HTMLStyleElement) moveKeyframes(target);
                addedNodes.forEach(handleNode);
                removedNodes.forEach(node => {
                    if (isStyleOwner(node)) forget(node);
                });
            }
        });
        observer.observe(document.head, { childList: true });
        observer.observe(vencordRootNode, { childList: true, subtree: true });
    },

    stop() {
        observer?.disconnect();
        observer = undefined;
        keyframeStyle?.remove();
        keyframeStyle = undefined;
        for (const [{ sheet }, rules] of movedKeyframes) {
            if (sheet) for (const rule of rules) sheet.insertRule(rule, sheet.cssRules.length);
        }
        movedKeyframes.clear();
    }
});
