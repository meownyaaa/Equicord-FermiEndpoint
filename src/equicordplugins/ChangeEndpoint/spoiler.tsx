/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { findComponentByCodeLazy } from "@webpack";
import type { ReactNode } from "react";

interface DiscordObscuredContentProps {
    type: "attachment";
    reason: "spoiler";
    inline: boolean;
    children: (hidden: boolean) => ReactNode;
}

const DiscordObscuredContent = findComponentByCodeLazy<DiscordObscuredContentProps>("shouldAgeVerify:", "isVerifiedTeen:");

function DiscordSpoilerComponent({ children }: { children: ReactNode; }) {
    return (
        <DiscordObscuredContent type="attachment" reason="spoiler" inline={false}>
            {hidden => (
                <div style={{ overflow: "hidden", filter: hidden ? "blur(44px)" : undefined }}>
                    {children}
                </div>
            )}
        </DiscordObscuredContent>
    );
}

export const DiscordSpoiler = ErrorBoundary.wrap(DiscordSpoilerComponent, { noop: true });
