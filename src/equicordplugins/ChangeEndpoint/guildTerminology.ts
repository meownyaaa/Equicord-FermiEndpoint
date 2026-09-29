/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// compressed @discord/intl ast: literal text is a plain string, everything else is a [type, name, ...]
// tuple. only select/plural option bodies and tag children hold more text, the rest are names/styles/urls
const SELECT = 5;
const PLURAL = 6;
const TAG = 8;

const HAS_SERVER_WORD = /\bservers?\b/i;
const SERVER_WORD = /\bserver(s?)\b/gi;
// messages where "server" means real hosting or infrastructure rather than a guild
const NON_GUILD_SENSE = /\b(?:game|voice|rtc|hosted) servers?\b|\binternal server error\b|\bgame panel\b|\bspin up\b|\bservers are having issues\b|^server status$/i;

function toGuild(word: string, plural: string) {
    if (word === word.toUpperCase()) return plural ? "GUILDS" : "GUILD";
    return (word[0] === "S" ? "Guild" : "guild") + plural;
}

function walkText(nodes: unknown, visit: (text: string) => void) {
    if (typeof nodes === "string") return visit(nodes);
    if (!Array.isArray(nodes)) return;

    for (const node of nodes) {
        if (typeof node === "string") visit(node);
        else if (!Array.isArray(node)) continue;
        else if (node[0] === SELECT || node[0] === PLURAL) Object.values(node[2]).forEach(option => walkText(option, visit));
        else if (node[0] === TAG) walkText(node[2], visit);
    }
}

function mapText(nodes: unknown, map: (text: string) => string): unknown {
    if (typeof nodes === "string") return map(nodes);
    if (!Array.isArray(nodes)) return nodes;

    return nodes.map(node => {
        if (typeof node === "string") return map(node);
        if (!Array.isArray(node)) return node;

        const copy = [...node];
        if (node[0] === SELECT || node[0] === PLURAL)
            copy[2] = Object.fromEntries(Object.entries(node[2]).map(([key, option]) => [key, mapText(option, map)]));
        else if (node[0] === TAG)
            copy[2] = mapText(node[2], map);
        return copy;
    });
}

export function guildifyAst(ast: unknown, locale: string) {
    if (!locale.startsWith("en")) return ast;

    let text = "";
    walkText(ast, part => text += part);
    if (!HAS_SERVER_WORD.test(text) || NON_GUILD_SENSE.test(text)) return ast;

    return mapText(ast, part => part.replace(SERVER_WORD, toGuild));
}
