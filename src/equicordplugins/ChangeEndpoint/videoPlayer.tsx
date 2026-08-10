/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { classNameFactory } from "@utils/css";
import { LazyComponent } from "@utils/lazyReact";
import { formatDurationMs } from "@utils/text";
import { Slider, useEffect, useRef, useState } from "@webpack/common";
import type { KeyboardEvent } from "react";

const cl = classNameFactory("vc-changeendpoint-");

const SeekBar = LazyComponent(() => {
    const SliderClass = Slider.$$vencordGetWrappedComponent();

    return class SeekBar extends SliderClass {
        static getDerivedStateFromProps(props: any, state: any) {
            const newState = super.getDerivedStateFromProps!(props, state);
            if (newState) newState.value = props.initialValue;
            return newState;
        }
    };
});

function svgIcon(path: string, label: string) {
    return () => (
        <svg className={cl("player-icon")} viewBox="0 0 24 24" fill="currentColor" aria-label={label} focusable={false}>
            <path d={path} />
        </svg>
    );
}

const PlayIcon = svgIcon("M8 6.82v10.36c0 .79.87 1.27 1.54.84l8.14-5.18c.62-.39.62-1.29 0-1.69L9.54 5.98C8.87 5.55 8 6.03 8 6.82z", "Play");
const PauseIcon = svgIcon("M8 19c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2s-2 .9-2 2v10c0 1.1.9 2 2 2zm6-12v10c0 1.1.9 2 2 2s2-.9 2-2V7c0-1.1-.9-2-2-2s-2 .9-2 2z", "Pause");
const VolumeIcon = svgIcon("M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z", "Volume");
const MuteIcon = svgIcon("M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z", "Muted");
const FullscreenEnterIcon = svgIcon("M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z", "Enter fullscreen");
const FullscreenExitIcon = svgIcon("M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z", "Exit fullscreen");

function formatTime(seconds: number) {
    const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
    return formatDurationMs(safe * 1000, false, true);
}

function activation(fn: () => void) {
    return {
        onClick: fn,
        onKeyDown: (e: KeyboardEvent) => (e.key === "Enter" || e.key === " ") && fn()
    };
}

function CustomVideoPlayerComponent({ src, maxWidth, maxHeight }: { src: string; maxWidth: number; maxHeight: number; }) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const [playing, setPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [volume, setVolume] = useState(1);
    const [muted, setMuted] = useState(false);
    const [showControls, setShowControls] = useState(true);
    const [fullscreen, setFullscreen] = useState(false);

    useEffect(() => {
        const onFullscreenChange = () => setFullscreen(document.fullscreenElement === containerRef.current);
        document.addEventListener("fullscreenchange", onFullscreenChange);
        return () => {
            document.removeEventListener("fullscreenchange", onFullscreenChange);
            if (hideTimer.current) clearTimeout(hideTimer.current);
        };
    }, []);

    const scheduleHide = () => {
        if (hideTimer.current) clearTimeout(hideTimer.current);
        hideTimer.current = setTimeout(() => setShowControls(false), 2200);
    };

    const revealControls = () => {
        setShowControls(true);
        if (playing) scheduleHide();
    };

    const togglePlay = () => {
        const video = videoRef.current;
        if (!video) return;
        if (video.paused) video.play().catch(() => {});
        else video.pause();
    };

    const seek = (value: number) => {
        const video = videoRef.current;
        if (!video) return;
        video.currentTime = value;
        setCurrentTime(value);
    };

    const changeVolume = (value: number) => {
        const video = videoRef.current;
        if (!video) return;
        video.volume = value / 100;
        video.muted = value === 0;
    };

    const toggleMute = () => {
        const video = videoRef.current;
        if (!video) return;
        video.muted = !video.muted;
    };

    const toggleFullscreen = () => {
        const container = containerRef.current;
        if (!container) return;
        if (document.fullscreenElement) document.exitFullscreen();
        else container.requestFullscreen().catch(() => {});
    };

    return (
        <div
            ref={containerRef}
            className={cl("player")}
            onMouseMove={revealControls}
            onMouseLeave={() => playing && setShowControls(false)}
        >
            <video
                ref={videoRef}
                src={src}
                preload="metadata"
                playsInline
                className={cl("player-video")}
                style={{ maxWidth, maxHeight }}
                onClick={togglePlay}
                onPlay={() => { setPlaying(true); scheduleHide(); }}
                onPause={() => { setPlaying(false); setShowControls(true); }}
                onLoadedMetadata={e => setDuration(e.currentTarget.duration)}
                onTimeUpdate={e => setCurrentTime(e.currentTarget.currentTime)}
                onVolumeChange={e => { setVolume(e.currentTarget.volume); setMuted(e.currentTarget.muted); }}
            />
            {!playing && (
                <div className={cl("player-center-button")} {...activation(togglePlay)} role="button" tabIndex={0} aria-label="Play">
                    <PlayIcon />
                </div>
            )}
            <div className={cl("player-controls", { "player-controls-hidden": !showControls })}>
                <div className={cl("player-seekbar")}>
                    <SeekBar
                        initialValue={currentTime}
                        minValue={0}
                        maxValue={duration || 0}
                        onValueChange={seek}
                        asValueChanges={seek}
                        onValueRender={formatTime}
                        mini
                    />
                </div>
                <div className={cl("player-controls-row")}>
                    <div className={cl("player-controls-left")}>
                        <div className={cl("player-button")} role="button" tabIndex={0} aria-label={playing ? "Pause" : "Play"} {...activation(togglePlay)}>
                            {playing ? <PauseIcon /> : <PlayIcon />}
                        </div>
                        <div className={cl("player-button")} role="button" tabIndex={0} aria-label={muted ? "Unmute" : "Mute"} {...activation(toggleMute)}>
                            {muted || volume === 0 ? <MuteIcon /> : <VolumeIcon />}
                        </div>
                        <div className={cl("player-volume")}>
                            <Slider
                                initialValue={muted ? 0 : volume * 100}
                                minValue={0}
                                maxValue={100}
                                onValueChange={changeVolume}
                                asValueChanges={changeVolume}
                                mini
                            />
                        </div>
                        <span className={cl("player-time")}>
                            {formatTime(currentTime)} / {formatTime(duration)}
                        </span>
                    </div>
                    <div className={cl("player-controls-right")}>
                        <div className={cl("player-button")} role="button" tabIndex={0} aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"} {...activation(toggleFullscreen)}>
                            {fullscreen ? <FullscreenExitIcon /> : <FullscreenEnterIcon />}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

export const CustomVideoPlayer = ErrorBoundary.wrap(CustomVideoPlayerComponent, { noop: true });
