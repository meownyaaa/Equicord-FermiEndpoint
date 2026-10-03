/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { vencordRootNode } from "@api/Styles";
import definePlugin, { StartAt } from "@utils/types";

type StyleOwner = HTMLLinkElement | HTMLStyleElement;

interface Split {
    removed: [index: number, rule: string][];
    keyframes: string[];
    segments: HTMLStyleElement[];
}

const SIZE_MEDIA = /\b(?:min|max)-(?:width|height|aspect-ratio)|orientation/;
const MIN_SPLIT_RULES = 300;

const splits = new Map<StyleOwner, Split>();
const segments = new WeakSet<Node>();
let keyframeStyle: HTMLStyleElement | undefined;
let observer: MutationObserver | undefined;

const isStyleOwner = (node: Node): node is StyleOwner =>
    node instanceof HTMLStyleElement || (node instanceof HTMLLinkElement && node.rel === "stylesheet" && node.href.startsWith(location.origin));

const isSizeMedia = (rule: CSSRule) => rule instanceof CSSMediaRule && SIZE_MEDIA.test(rule.conditionText);

function syncKeyframeStyle() {
    if (keyframeStyle) keyframeStyle.textContent = [...splits.values()].flatMap(s => s.keyframes).join("\n");
}

function forget(owner: StyleOwner) {
    const split = splits.get(owner);
    if (!split) return;

    splits.delete(owner);
    split.segments.forEach(s => s.remove());
    syncKeyframeStyle();
}

function splitSheet(owner: StyleOwner) {
    if (segments.has(owner) || (owner instanceof HTMLLinkElement && splits.has(owner))) return;
    forget(owner);

    const { sheet } = owner;
    if (!sheet || !keyframeStyle) return;

    const rules = [...sheet.cssRules];
    const first = rules.findIndex(isSizeMedia);
    if (first === -1) return;

    const split: Split = { removed: [], keyframes: [], segments: [] };
    const cut = owner instanceof HTMLLinkElement && rules.length >= MIN_SPLIT_RULES ? first : rules.length;
    let text: string[] = [];
    let inMedia = false;

    const flush = () => {
        if (!text.length) return;
        const style = document.createElement("style");
        style.textContent = text.join("\n");
        segments.add(style);
        split.segments.push(style);
        text = [];
    };

    rules.forEach((rule, i) => {
        if (rule instanceof CSSKeyframesRule) {
            split.keyframes.push(rule.cssText);
            split.removed.push([i, rule.cssText]);
            return;
        }
        if (i < cut) return;

        if (isSizeMedia(rule) !== inMedia) {
            flush();
            inMedia = !inMedia;
        }
        text.push(rule.cssText);
        split.removed.push([i, rule.cssText]);
    });
    flush();

    owner.after(...split.segments);
    for (const [i] of split.removed.toReversed()) sheet.deleteRule(i);
    splits.set(owner, split);
    syncKeyframeStyle();
}

function handleNode(node: Node) {
    if (!isStyleOwner(node)) return;

    if (node instanceof HTMLLinkElement && !node.sheet) node.addEventListener("load", () => splitSheet(node), { once: true });
    else splitSheet(node);
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
                if (target instanceof HTMLStyleElement) splitSheet(target);
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
        for (const [{ sheet }, { removed, segments }] of splits) {
            segments.forEach(s => s.remove());
            if (sheet) for (const [i, rule] of removed) sheet.insertRule(rule, i);
        }
        splits.clear();
    }
});
