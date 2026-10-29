/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import ErrorBoundary from "@components/ErrorBoundary";
import { findComponentByCodeLazy } from "@webpack";
import { Humanize, useEffect, useState } from "@webpack/common";

interface DiscordMediaPlayerProps {
    src: string;
    poster?: string;
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

interface VideoMeta {
    width: number;
    height: number;
    poster: string;
}

const DiscordMediaPlayer = findComponentByCodeLazy<DiscordMediaPlayerProps>("_hasStatsListener");

const META_KEY = "ChangeEndpoint_videoMeta";
const MAX_PREVIEW_BYTES = 15 * 1024 * 1024;
const POSTER_WIDTH = 480;

let metas: Promise<Record<string, VideoMeta>> | undefined;
let queue = Promise.resolve();

function attachmentId(src: string) {
    return /\/attachments\/\d+\/(\d+)\//.exec(src)?.[1];
}

function capture(src: string) {
    return new Promise<VideoMeta | null>(resolve => {
        const video = document.createElement("video");
        const finish = (meta: VideoMeta | null) => {
            clearTimeout(timeout);
            video.onloadeddata = video.onseeked = video.onerror = null;
            video.removeAttribute("src");
            video.load();
            resolve(meta);
        };
        const timeout = setTimeout(() => finish(null), 30_000);

        video.crossOrigin = "anonymous";
        video.muted = true;
        video.preload = "auto";
        video.onloadeddata = () => video.currentTime = Math.min(0.1, video.duration / 2 || 0);
        video.onseeked = () => {
            const scale = Math.min(1, POSTER_WIDTH / video.videoWidth);
            const canvas = document.createElement("canvas");
            canvas.width = Math.round(video.videoWidth * scale);
            canvas.height = Math.round(video.videoHeight * scale);
            canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
            try {
                finish({ width: video.videoWidth, height: video.videoHeight, poster: canvas.toDataURL("image/jpeg", 0.7) });
            } catch {
                finish(null);
            }
        };
        video.onerror = () => finish(null);
        video.src = src;
    });
}

async function loadMeta(id: string, src: string) {
    metas ??= DataStore.get<Record<string, VideoMeta>>(META_KEY).then(stored => stored ?? {});
    const known = (await metas)[id];
    if (known) return known;

    const next = queue.then(() => capture(src));
    queue = next.then(() => undefined);
    const meta = await next;
    if (meta) {
        (await metas)[id] = meta;
        DataStore.update<Record<string, VideoMeta>>(META_KEY, stored => ({ ...stored, [id]: meta }));
    }
    return meta;
}

function CustomVideoPlayerComponent({ src, maxWidth, maxHeight, fileName, fileSizeBytes }: {
    src: string;
    maxWidth: number;
    maxHeight: number;
    fileName?: string;
    fileSizeBytes?: number;
}) {
    const [meta, setMeta] = useState<VideoMeta | null>(null);

    useEffect(() => {
        const id = attachmentId(src);
        if (!id || fileSizeBytes == null || fileSizeBytes > MAX_PREVIEW_BYTES) return;
        let active = true;
        loadMeta(id, src).then(found => active && setMeta(found));
        return () => { active = false; };
    }, [src, fileSizeBytes]);

    const scale = meta ? Math.min(1, maxWidth / meta.width, maxHeight / meta.height) : 1;

    return (
        <DiscordMediaPlayer
            src={src}
            poster={meta?.poster}
            width={meta ? Math.round(meta.width * scale) : maxWidth}
            height={meta ? Math.round(meta.height * scale) : maxHeight}
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
