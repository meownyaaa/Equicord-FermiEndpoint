/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import type { Guild } from "@vencord/discord-types";
import { findComponentByCodeLazy } from "@webpack";
import { Alerts, Constants, FluxDispatcher, PermissionsBits, PermissionStore, RestAPI, showToast, UserStore, useStateFromStores } from "@webpack/common";
import type { ComponentType } from "react";

const logger = new Logger("MassStickerUpload");

const STICKER_TYPES = /^image\/(png|apng|gif)$/;
const MAX_STICKERS_ERROR = 30039;

interface UploadAreaProps {
    className: string;
    title: string;
    description: string;
    icons: number[];
    onDrop(files: FileList): void;
}

const UploadArea = findComponentByCodeLazy<UploadAreaProps>("isAllDropFiles");

const settings = definePluginSettings({
    relatedEmoji: {
        type: OptionType.STRING,
        description: "Name of the default emoji every uploaded sticker is related to, without colons.",
        default: "sob",
        isValid: (value: string) => !!value.replaceAll(":", "").trim() || "Enter an emoji name."
    }
});

function stickerName(fileName: string) {
    return fileName.replace(/\.[^.]+$/, "").trim().slice(0, 30).padEnd(2, "_");
}

async function uploadStickers(guildId: string, files: File[]) {
    const tags = settings.store.relatedEmoji.replaceAll(":", "").trim();
    let uploaded = 0;

    for (const file of files) {
        const data = new FormData();
        data.append("name", stickerName(file.name));
        data.append("tags", tags);
        data.append("description", "");
        data.append("file", file);

        try {
            const { body } = await RestAPI.post({ url: Constants.Endpoints.GUILD_STICKER_PACKS(guildId), body: data });
            FluxDispatcher.dispatch({ type: "GUILD_STICKERS_CREATE_SUCCESS", guildId, sticker: { ...body, user: UserStore.getCurrentUser() } });
            uploaded++;
        } catch (e) {
            logger.error(`Couldn't upload ${file.name}`, e);
            if ((e as { body?: { code?: number; }; }).body?.code === MAX_STICKERS_ERROR) break;
        }
    }

    if (uploaded === files.length) showToast(`Uploaded ${uploaded} stickers.`, "success");
    else showToast(`Uploaded ${uploaded} of ${files.length} stickers. Check the console for the ones that failed.`, "failure");
}

function confirmUpload(guild: Guild, dropped: File[]) {
    const files = dropped.filter(f => STICKER_TYPES.test(f.type));
    const skipped = dropped.length - files.length;
    if (!files.length) return showToast("None of those files are PNG, APNG or GIF images.", "failure");

    Alerts.show({
        title: "Upload Stickers",
        body: `Upload ${files.length} stickers to ${guild.name}? Each one is named after its file and related to :${settings.store.relatedEmoji.replaceAll(":", "")}:.${skipped ? ` ${skipped} files aren't PNG, APNG or GIF images and will be skipped.` : ""}`,
        confirmText: "Upload",
        cancelText: "Cancel",
        onConfirm: () => uploadStickers(guild.id, files)
    });
}

interface StickerPageProps {
    Page: ComponentType<Record<string, unknown>>;
    guild: Guild;
}

const StickerDropZone = ErrorBoundary.wrap(({ guild }: { guild: Guild; }) => (
    <UploadArea
        className="vc-mass-sticker-upload-area"
        title="Upload Stickers"
        description="Drop sticker files here to upload them all at once."
        icons={[0, 0, 0]}
        onDrop={files => confirmUpload(guild, [...files])}
    />
), { noop: true });

const StickerPage = ErrorBoundary.wrap(({ Page, guild, ...props }: StickerPageProps) => {
    const canUpload = useStateFromStores([PermissionStore], () =>
        PermissionStore.can(PermissionsBits.CREATE_GUILD_EXPRESSIONS, guild) || PermissionStore.can(PermissionsBits.MANAGE_GUILD_EXPRESSIONS, guild));

    return (
        <>
            {canUpload ? <StickerDropZone guild={guild} /> : null}
            <Page {...props} />
        </>
    );
});

export default definePlugin({
    name: "MassStickerUpload",
    description: "Drop many sticker files onto a guild's Stickers settings page to upload them all at once, each named after its file.",
    authors: [],
    settings,

    patches: [
        {
            find: /CREATE_STICKER_MODAL,location:\i\}\),\(\i=>\{let\{guildId:\i\}=\i;/,
            replacement: {
                match: /(?<=return\(0,\i\.jsx\)\()(\i),\{(?=tiers:\i,renderTier:function)/,
                replace: "$self.StickerPage,{Page:$1,guild:arguments[0].guild,"
            }
        }
    ],

    StickerPage
});
