/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { findComponentByCodeLazy } from "@webpack";
import { Humanize } from "@webpack/common";

interface DiscordMediaPlayerProps {
    src: string;
    width: number;
    height: number;
    type: "VIDEO";
    mediaLayoutType: "MOSAIC";
    playable: boolean;
    downloadable: boolean;
    allowFullScreen: boolean;
    responsive: boolean;
    volume: number;
    autoPlay: boolean;
    autoMute: boolean;
    forceExternal: boolean;
    fileName?: string;
    fileSize?: string;
    fileSizeBytes?: number;
}

const DiscordMediaPlayer = findComponentByCodeLazy<DiscordMediaPlayerProps>("_hasStatsListener");

function CustomVideoPlayerComponent({ src, maxWidth, maxHeight, fileName, fileSizeBytes }: {
    src: string;
    maxWidth: number;
    maxHeight: number;
    fileName?: string;
    fileSizeBytes?: number;
}) {
    return (
        <DiscordMediaPlayer
            src={src}
            width={maxWidth}
            height={maxHeight}
            type="VIDEO"
            mediaLayoutType="MOSAIC"
            playable
            downloadable
            allowFullScreen
            responsive
            volume={1}
            autoPlay={false}
            autoMute={false}
            forceExternal={false}
            fileName={fileName}
            fileSize={fileSizeBytes != null ? Humanize.filesize(fileSizeBytes) : undefined}
            fileSizeBytes={fileSizeBytes}
        />
    );
}

export const CustomVideoPlayer = ErrorBoundary.wrap(CustomVideoPlayerComponent, { noop: true });
